import { createHash } from 'node:crypto';
import { AttachmentMirrorAdapter } from './attachment-mirror-adapter.mjs';

const LABEL = '运营跟客户沟通截图';
const ROLES = ['sales', 'operator'];
const ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9]{10,128}$/;
const RECORD = /^rec[A-Za-z0-9]{5,100}$/;
const TABLE = /^tbl[A-Za-z0-9]{5,100}$/;
const FIELD = /^fld[A-Za-z0-9]{5,100}$/;
const PERSON = /^ou_[A-Za-z0-9_-]{5,100}$/;
const PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const ATTACHMENT_TICK_BUDGET_MS = 120_000;
const is = (value, pattern) => typeof value === 'string' && pattern.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policies = { pending: 60_000, review: 30 * 60_000, settled: 6 * 60 * 60_000 };
const operatorCode = value => is(value, /^ATTACHMENT_[A-Z0-9_]{1,80}$/) ? value : 'ATTACHMENT_SCHEDULE_REVIEW';
const completeScan = args => args?.apply === true && args.healthy === true && args.complete === true && Array.isArray(args.records);
const keyFor = task => `${task.job}/${task.role}/${task.id}`;
const no = code => { throw Object.assign(new Error(code), { code }); };
const stopped = callback => { try { return Boolean(callback()); } catch { return true; } };

export function attachmentAclFingerprint(target, sharing, members) {
  const entries = Array.isArray(members) ? members.map(member => JSON.stringify([
    member?.memberType, member?.openId, member?.perm, member?.isApp === true, member?.isOwner === true,
  ])).sort() : null;
  return hash([target?.appToken, target?.tableId, target?.fieldId,
    sharing?.externalAccessEntity, sharing?.linkShareEntity, sharing?.manageCollaboratorEntity, entries]);
}

export function validateAttachmentSyncConfig(raw, workflow) {
  if (raw === undefined) return undefined;
  if (raw?.enabled === false) return { enabled: false };
  if (raw?.enabled !== true || workflow?.staffManagement?.enabled !== true ||
      !Array.isArray(raw.targetPins) || !raw.targetPins.length ||
      !is(raw.source?.appToken, TOKEN) || raw.source.appToken !== workflow.appToken ||
      !is(raw.source?.tableId, TABLE) || raw.source.tableId !== workflow.tableIds?.leads ||
      !is(raw.source?.fieldId, FIELD)) no('ATTACHMENT_BINDING_NOT_READY');
  const binding = value => ({ appToken: value.appToken, tableId: value.tableId, fieldId: value.fieldId });
  const seen = new Set([workflow.appToken, workflow.staffManagement.appToken]);
  const targetPins = raw.targetPins.map(pin => {
    const proof = pin?.proof;
    if (!ROLES.includes(pin?.role) || !is(pin.personId, PERSON) || !is(pin.appToken, TOKEN) ||
        seen.has(pin.appToken) || !is(pin.tableId, TABLE) || !is(pin.fieldId, FIELD) ||
        pin.role === 'operator' && workflow.staffManagement.operatorViews?.enabled !== true ||
        proof?.ordinaryAccountVerified !== true || proof?.standaloneAccessVerified !== true ||
        !is(proof.aclFingerprint, ID) || !Number.isSafeInteger(proof.verifiedAt) ||
        !Number.isSafeInteger(proof.expiresAt) || proof.verifiedAt < 0 ||
        proof.expiresAt <= proof.verifiedAt || proof.expiresAt - proof.verifiedAt > PROOF_MAX_AGE_MS) {
      no('ATTACHMENT_ACCESS_PROOF_REQUIRED');
    }
    seen.add(pin.appToken);
    return { ...binding(pin), role: pin.role, personId: pin.personId,
      proof: { ordinaryAccountVerified: true, standaloneAccessVerified: true, aclFingerprint: proof.aclFingerprint,
        verifiedAt: proof.verifiedAt, expiresAt: proof.expiresAt } };
  });
  return { enabled: true, source: binding(raw.source), targetPins };
}

export function createAttachmentAclVerifier(targetPins, now = Date.now) {
  const approved = new Map(targetPins.map(target => [target.appToken, target]));
  return (target, sharing, members) => {
    const expected = approved.get(target?.appToken), at = now();
    if (!expected || expected.tableId !== target.tableId || expected.fieldId !== target.fieldId ||
        expected.proof?.ordinaryAccountVerified !== true || expected.proof.standaloneAccessVerified !== true ||
        at < expected.proof.verifiedAt || at >= expected.proof.expiresAt || !Array.isArray(members)) return false;
    return expected.proof.aclFingerprint === attachmentAclFingerprint(target, sharing, members);
  };
}

function hints(records) {
  const result = new Map();
  for (const record of records) {
    const id = record?.record_id;
    if (!is(id, RECORD) || !record.fields || Array.isArray(record.fields) || typeof record.fields !== 'object' || result.has(id))
      no('ATTACHMENT_SOURCE_HINTS_INCOMPLETE');
    const raw = record.fields[LABEL];
    if (raw != null && (!Array.isArray(raw) || raw.some(file => !is(file?.file_token, TOKEN)))) {
      result.set(id, { digest: 'unknown', hasFiles: false, touched: 0 });
      continue;
    }
    result.set(id, {
      digest: hash((raw ?? []).map(file => file.file_token)),
      hasFiles: Array.isArray(raw) && raw.length > 0,
      touched: Number.isSafeInteger(record.last_modified_time) ? record.last_modified_time : 0,
    });
  }
  return result;
}

/** Executes a single approved attachment operation after the main scan and uses no dispatcher timer. */
export class AttachmentAfterCore {
  #busy = false;
  #observed = null;
  #routePins;
  #query;

  constructor({ db, adapter, source, targetPins, enabledRoles, verifyLiveConfig, now = Date.now,
    minIntervalMs = 60_000, maxTickMs = ATTACHMENT_TICK_BUDGET_MS } = {}) {
    if (!db?.prepare || typeof adapter?.run !== 'function' || typeof adapter?.retire !== 'function' ||
      typeof verifyLiveConfig !== 'function' || typeof now !== 'function' || !Array.isArray(enabledRoles) ||
      enabledRoles.length < 1 || enabledRoles.some(role => !ROLES.includes(role)) || !Array.isArray(targetPins) ||
      !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 1000 ||
      !Number.isSafeInteger(maxTickMs) || maxTickMs < 1000) no('ATTACHMENT_SCHEDULE_CONFIGURATION_INVALID');
    this.now = now;
    this.interval = minIntervalMs;
    this.maxTickMs = maxTickMs;
    this.adapter = adapter;
    this.verifyLiveConfig = verifyLiveConfig;
    this.roles = Object.freeze(ROLES.filter(role => enabledRoles.includes(role)));
    this.#routePins = new Set(targetPins.map(pin => [pin.role, pin.appToken, pin.tableId, pin.personId].join('/')));
    db.exec(`CREATE TABLE IF NOT EXISTS v2_attachment_schedule_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_attachment_schedule_history (
      key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ready_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
      outcome TEXT NOT NULL, issue TEXT NOT NULL)`);
    const binding = hash([source?.appToken, source?.tableId, source?.fieldId]);
    db.prepare(`INSERT OR IGNORE INTO v2_attachment_schedule_state VALUES('source_binding',?)`).run(binding);
    if (db.prepare(`SELECT value FROM v2_attachment_schedule_state WHERE key='source_binding'`).get()?.value !== binding)
      no('ATTACHMENT_SCHEDULE_BINDING_MISMATCH');
    db.exec(`INSERT OR IGNORE INTO v2_attachment_schedule_state VALUES('next_slot','0'),('last_role','operator')`);
    this.#query = {
      nextSlot: db.prepare("SELECT CAST(value AS INTEGER) AS value FROM v2_attachment_schedule_state WHERE key='next_slot'"),
      reserve: db.prepare("UPDATE v2_attachment_schedule_state SET value=? WHERE key='next_slot' AND CAST(value AS INTEGER)<=?"),
      lastRole: db.prepare("SELECT value FROM v2_attachment_schedule_state WHERE key='last_role'"),
      rememberRole: db.prepare("UPDATE v2_attachment_schedule_state SET value=? WHERE key='last_role'"),
      history: db.prepare('SELECT * FROM v2_attachment_schedule_history'),
      counts: db.prepare('SELECT outcome,COUNT(*) AS count FROM v2_attachment_schedule_history GROUP BY outcome'),
      last: db.prepare('SELECT issue FROM v2_attachment_schedule_history ORDER BY checked_at DESC, key LIMIT 1'),
      save: db.prepare(`INSERT INTO v2_attachment_schedule_history VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
        fingerprint=excluded.fingerprint, ready_at=excluded.ready_at, checked_at=excluded.checked_at,
        outcome=excluded.outcome, issue=excluded.issue`),
      sales: db.prepare(`SELECT id, source_id AS sourceId, json_extract(data,'$.target.appToken') AS appToken,
        json_extract(data,'$.target.tableId') AS tableId, json_extract(data,'$.owner') AS personId
        FROM v2_mirrors WHERE state='active' ORDER BY id`),
      ...(this.roles.includes('operator') ? { operator: db.prepare(`SELECT copies.id, json_extract(copies.data,'$.sourceId') AS sourceId,
        json_extract(resources.data,'$.target.appToken') AS appToken, json_extract(resources.data,'$.target.tableId') AS tableId,
        resources.id AS personId FROM v2_operator_copies copies JOIN v2_operator_resources resources
        ON resources.id=json_extract(copies.data,'$.operatorId')
        WHERE json_extract(copies.data,'$.state')='active' AND json_extract(resources.data,'$.stage')='ready' ORDER BY copies.id`),
      operatorRevoked: db.prepare("SELECT id FROM v2_operator_copies WHERE id=? AND json_extract(data,'$.state')='revoked'") } : {}),
      journal: db.prepare(`SELECT json_extract(data,'$.scope.role') AS role, json_extract(data,'$.scope.mirrorId') AS id,
        json_extract(data,'$.scope.personId') AS personId, json_extract(data,'$.scope.target.appToken') AS appToken,
        json_extract(data,'$.scope.target.tableId') AS tableId, json_extract(data,'$.step') AS step
        FROM v2_attachment_sync WHERE json_extract(data,'$.step')!='retired'`),
      salesRevoked: db.prepare("SELECT id FROM v2_mirrors WHERE id=? AND state='revoked'"),
    };
  }

  #permitted(task) {
    return is(task.id, ID) && this.roles.includes(task.role) &&
      this.#routePins.has([task.role, task.appToken, task.tableId, task.personId].join('/'));
  }

  #choose(observed, now) {
    const history = new Map(this.#query.history.all().map(row => [row.key, row]));
    const journal = this.#query.journal.all().filter(row => this.#permitted(row));
    for (const previous of journal) {
      const task = { ...previous, job: 'retire', digest: 'revoked' };
      if ((history.get(keyFor(task))?.ready_at ?? 0) <= now && this.#query[`${task.role}Revoked`].get(task.id)) return task;
    }
    const managed = new Set(journal.map(row => `${row.role}/${row.id}`));
    const last = this.#query.lastRole.get()?.value;
    const orderedRoles = this.roles.length > 1 && last === this.roles[0] ? [...this.roles].reverse() : this.roles;
    for (const role of orderedRoles) {
      const eligible = [];
      for (const row of this.#query[role].all()) {
        const hint = observed.get(row.sourceId);
        if (!hint || (!hint.hasFiles && !managed.has(`${role}/${row.id}`))) continue;
        const task = { ...row, role, job: 'sync', digest: hint.digest, touched: hint.touched };
        if (!this.#permitted(task)) continue;
        const previous = history.get(keyFor(task));
        const changed = previous && previous.fingerprint !== task.digest;
        if (!previous || previous.ready_at <= now || changed && ['updated', 'unchanged'].includes(previous.outcome)) {
          eligible.push({ ...task, priority: changed ? 0 : previous ? 2 : 1, checkedAt: previous?.checked_at ?? 0 });
        }
      }
      const winner = eligible.sort((a, b) => a.priority - b.priority || a.checkedAt - b.checkedAt || b.touched - a.touched)[0];
      if (winner) return winner;
    }
    return null;
  }

  stageCore(input) {
    this.#observed = null;
    if (!completeScan(input)) return false;
    this.#observed = hints(input.records);
    return true;
  }

  async afterCore(input) {
    if (!this.stageCore(input)) return { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' };
    return this.runDeferred(input);
  }

  async runDeferred(input = {}) {
    const observed = this.#observed;
    const shouldStop = input?.shouldStop ?? (() => false);
    if (!observed || typeof shouldStop !== 'function' || stopped(shouldStop) || input.signal?.aborted)
      return { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' };
    if (this.#busy) return { status: 'deferred', code: 'ATTACHMENT_TICK_BUSY' };
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) no('ATTACHMENT_CLOCK_INVALID');
    if (now < this.#query.nextSlot.get().value) return { status: 'deferred', code: 'ATTACHMENT_TICK_NOT_DUE' };
    const timer = AbortSignal.timeout(this.maxTickMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timer]) : timer;
    const stopForTick = () => stopped(shouldStop) || signal.aborted || this.now() >= now + this.maxTickMs;
    this.#busy = true;
    try {
      if (await this.verifyLiveConfig() !== true || stopForTick())
        return { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' };
      const task = this.#choose(observed, now);
      if (this.#query.reserve.run(String(now + this.interval), now).changes !== 1)
        return { status: 'deferred', code: 'ATTACHMENT_TICK_NOT_DUE' };
      if (!task) return { status: 'idle' };
      if (task.job === 'sync') this.#query.rememberRole.run(task.role);
      let outcome;
      try {
        outcome = task.job === 'retire'
          ? await this.adapter.retire(task.role, task.id, { shouldStop: stopForTick, signal })
          : await this.adapter.run(task.role, task.id, { shouldStop: stopForTick, signal, maxUploads: 1 });
      } catch (error) { outcome = { status: error?.code === 'ATTACHMENT_STOP_REQUESTED' ? 'pending' : 'review', code: operatorCode(error?.code) }; }
      const status = ['updated', 'unchanged', 'retired', 'pending', 'review', 'skipped'].includes(outcome?.status) ? outcome.status : 'review';
      const code = outcome?.code ? operatorCode(outcome.code) : status === 'review' ? 'ATTACHMENT_SCHEDULE_REVIEW' : '';
      const wait = ['updated', 'unchanged', 'retired'].includes(status) ? policies.settled : policies[status] ?? policies.review;
      this.#query.save.run(keyFor(task), task.digest, now + wait, now, status, code);
      return { status, ...(code ? { code } : {}) };
    } finally { this.#busy = false; }
  }

  status() {
    const issue = this.#query.last.get()?.issue;
    return { nextDueAt: this.#query.nextSlot.get().value, staged: this.#observed !== null,
      counts: Object.fromEntries(this.#query.counts.all().map(row => [row.outcome, row.count])),
      ...(issue ? { lastIssue: operatorCode(issue) } : {}) };
  }
}

export function createAttachmentRuntime(options) {
  const adapter = new AttachmentMirrorAdapter(options);
  return new AttachmentAfterCore({ ...options, adapter });
}
