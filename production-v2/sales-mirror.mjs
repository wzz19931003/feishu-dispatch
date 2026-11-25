import { createHash, randomUUID } from 'node:crypto';
import { resolveFields, listFieldMetadata, recordView, encodePatch, SALES_DETAIL_COLUMNS } from './field-map.mjs';

export class SalesMirrorError extends Error {
  constructor(code) { super(`销售镜像处理未完成（${code}）`); this.name = 'SalesMirrorError'; this.code = code; }
}
const fail = code => { throw new SalesMirrorError(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'MIRROR_REMOTE_ERROR';
const absent = error => ['1254043', 'RECORD_NOT_FOUND', 'SOURCE_RECORD_NOT_FOUND', 'SOURCE_NOT_FOUND'].includes(String(error?.code || ''));
const COPY_FIELDS = Object.freeze(['wx', 'needs', 'wxStatus', 'addMethod', 'partySize', 'salesName']);
const FEEDBACK_FIELDS = new Set(['wxStatus', 'wx', 'needs', 'partySize']);
const STATUS_WRITEBACK_UNCONFIRMED = 'MIRROR_STATUS_WRITEBACK_OUTCOME_UNKNOWN';
export const SALES_DETAIL_BUDGET_MS = 12_000;
const SALES_DETAIL_LIMIT_CODES = new Set(['99991400', 'HTTP_429', 'RATE_LIMIT', 'SALES_DETAILS_RATE_LIMIT']);
const equal = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
const targetIdentity = target => JSON.stringify([target.appToken, target.tableId]);
const stopped = shouldStop => { try { return Boolean(shouldStop?.()); } catch { return true; } };
const iso = () => new Date().toISOString();

export function boundedSalesDetailClient(client, signal) {
  const scoped = Object.create(client);
  if (typeof client.fetch === 'function') {
    scoped.fetch = (url, options) => {
      signal.throwIfAborted();
      return client.fetch(url, { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
    };
    scoped.sleep = async () => fail('SALES_DETAILS_RATE_LIMIT');
  }
  for (const key of ['cachedToken', 'tokenPromise', 'appOpenId']) {
    if (Object.hasOwn(client, key)) {
      Object.defineProperty(scoped, key, { get: () => client[key], set: value => { client[key] = value; } });
    }
  }
  if (client.sourceClient) scoped.sourceClient = boundedSalesDetailClient(client.sourceClient, signal);
  return scoped;
}

async function detailReads(tasks, abortOnLimit) {
  const results = await Promise.allSettled(tasks.map(task => task.catch(error => {
    if (SALES_DETAIL_LIMIT_CODES.has(safeCode(error))) abortOnLimit();
    throw error;
  })));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

async function records(client, target) {
  const result = [], cursors = new Set(), ids = new Set(); let cursor;
  do {
    const page = typeof client.listRecords === 'function'
      ? await client.listRecords(target.tableId, { pageSize: 100, ...(cursor ? { pageToken: cursor } : {}) })
      : await client.api(`/open-apis/bitable/v1/apps/${encodeURIComponent(target.appToken)}/tables/${encodeURIComponent(target.tableId)}/records`, { method: 'GET', query: { page_size: 100, ...(cursor ? { page_token: cursor } : {}) } });
    if (!Array.isArray(page?.items)) fail('MIRROR_RECORDS_INVALID');
    for (const item of page.items) {
      const id = item?.record_id || item?.recordId || item?.id;
      if (typeof id !== 'string' || !id || ids.has(id)) fail('MIRROR_RECORD_ID_INVALID');
      ids.add(id); result.push(item);
    }
    if (!(page.hasMore ?? page.has_more)) break;
    const next = page.pageToken ?? page.page_token;
    if (typeof next !== 'string' || !next || cursors.has(next) || cursors.size > 1000) fail('MIRROR_PAGINATION_INVALID');
    cursors.add(next); cursor = next;
  } while (true);
  return result;
}

/** Uses only its own tables in the caller-owned SQLite connection. */
export class SalesMirror {
  constructor({ config, db, sourceClient, clientFactory, readSource, resolveSource, operatorNames, auditDetailsTarget,
    assertLiveConfig = async () => {}, detailBudgetMs = SALES_DETAIL_BUDGET_MS, now = Date.now } = {}) {
    if (!config || !db?.prepare || !sourceClient || typeof clientFactory !== 'function' || typeof readSource !== 'function' || typeof resolveSource !== 'function') fail('MIRROR_ARGUMENTS_REQUIRED');
    this.config = config; this.db = db; this.sourceClient = sourceClient; this.clientFactory = clientFactory; this.readSource = readSource; this.resolveSource = resolveSource; this.busy = false;
    this.now = now; this.sourceMutationCount = 0;
    this.operatorNames = operatorNames;
    this.auditDetailsTarget = auditDetailsTarget;
    this.assertLiveConfig = assertLiveConfig;
    this.detailEnabled = config.staffManagement?.enabled === true && config.mirrors?.salesDetails !== false
      && Boolean(config.fields?.leads?.leadDate);
    this.detailBudgetMs = detailBudgetMs;
    this.detailCursor = '';
    this.detailCooldownUntil = 0;
    this.deferredDetails = null;
    const feedback = config.mirrors?.feedbackFields || ['wxStatus'];
    if (!Array.isArray(feedback) || !feedback.includes('wxStatus') || feedback.some(key => !FEEDBACK_FIELDS.has(key)) || new Set(feedback).size !== feedback.length) fail('MIRROR_FEEDBACK_INVALID');
    this.feedback = [...feedback];
    db.exec('CREATE TABLE IF NOT EXISTS v2_mirrors (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS v2_mirrors_source ON v2_mirrors(source_id,version); CREATE TABLE IF NOT EXISTS v2_mirror_reviews (id TEXT PRIMARY KEY,data TEXT NOT NULL);');
    if (this.detailEnabled) db.exec('CREATE TABLE IF NOT EXISTS v2_sales_detail_pins (target TEXT PRIMARY KEY, date_id TEXT NOT NULL, operator_name_id TEXT NOT NULL);');
    for (const row of this.rows()) if (row.sourceAppToken !== config.appToken || row.sourceTableId !== config.tableIds.leads) fail('MIRROR_DATABASE_BINDING_MISMATCH');
    for (const row of this.rows()) if (SALES_DETAIL_LIMIT_CODES.has(row.detailJob?.lastErrorCode) && Number.isSafeInteger(row.detailJob?.nextAttemptAt)) this.detailCooldownUntil = Math.max(this.detailCooldownUntil, row.detailJob.nextAttemptAt);
    // An interrupted create can already have succeeded remotely. Do not POST again.
    for (const row of this.rows()) if (row.state === 'creating') {
      this.put({ ...row, state: 'create_review', errorCode: 'MIRROR_CREATE_OUTCOME_UNKNOWN' });
      this.review('MIRROR_CREATE_OUTCOME_UNKNOWN', row.sourceId, row.id);
    }
  }
  rows() { return this.db.prepare('SELECT data FROM v2_mirrors ORDER BY source_id,version').all().map(row => JSON.parse(row.data)); }
  put(row) {
    const value = { ...row, updatedAt: iso() };
    this.db.prepare('INSERT INTO v2_mirrors(id,source_id,version,state,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,version=excluded.version,state=excluded.state,data=excluded.data').run(value.id, value.sourceId, value.version, value.state, JSON.stringify(value));
    return value;
  }
  latest(sourceId) { return this.rows().filter(row => row.sourceId === sourceId && row.state !== 'revoked').at(-1) || null; }
  statusWriteback(sourceId) {
    const row = this.db.prepare("SELECT json_extract(data,'$.statusWriteback') AS receipt FROM v2_mirrors WHERE source_id=? AND state='active' ORDER BY version DESC LIMIT 1").get(sourceId);
    return row?.receipt ? JSON.parse(row.receipt) : null;
  }
  review(code, sourceId = '', mirrorId = '', detail = {}) {
    const id = fingerprint([code, sourceId, mirrorId, detail.targetRecordId || '', detail.targetAppToken || '']);
    this.db.prepare('INSERT INTO v2_mirror_reviews(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify({ id, code, sourceId, mirrorId, ...detail, state: 'open', at: iso() }));
  }
  closeReviews(mirrorId) {
    for (const record of this.db.prepare('SELECT id,data FROM v2_mirror_reviews').all()) {
      const value = JSON.parse(record.data);
      if (value.mirrorId === mirrorId && value.state === 'open' && value.code !== STATUS_WRITEBACK_UNCONFIRMED) this.db.prepare('UPDATE v2_mirror_reviews SET data=? WHERE id=?').run(JSON.stringify({ ...value, state: 'closed', closedAt: iso() }), record.id);
    }
  }
  status() {
    const counts = {};
    for (const row of this.rows()) counts[row.state] = (counts[row.state] || 0) + 1;
    const reviews = this.db.prepare('SELECT data FROM v2_mirror_reviews').all().map(row => JSON.parse(row.data));
    const retryTimes = this.rows().filter(row => row.state === 'active' && row.pendingFeedback && !row.feedbackBlocked && Number.isSafeInteger(row.feedbackNextAttemptAt) && row.feedbackNextAttemptAt > 0).map(row => row.feedbackNextAttemptAt);
    return { counts, reviewsOpen: reviews.filter(row => row.state === 'open').length, nextRetryAt: retryTimes.length ? Math.min(...retryTimes) : null, busy: this.busy };
  }
  async exclusive(callback) { if (this.busy) fail('MIRROR_BUSY'); this.busy = true; try { return await callback(); } finally { this.busy = false; } }
  checkWrite(shouldStop) { if (this.config.enabled !== true || this.config.mirrors?.enabled !== true) fail('MIRROR_WRITES_DISABLED'); if (stopped(shouldStop)) fail('MIRROR_STOP_REQUESTED'); }
  async source(id) {
    const schemaBefore = await this.resolveSource();
    let view;
    try { view = await this.readSource(id); } catch (error) { if (absent(error)) return null; throw error; }
    if (view == null) return null;
    if (fingerprint(schemaBefore) !== fingerprint(await this.resolveSource())) fail('MIRROR_SOURCE_SCHEMA_CHANGED_DURING_READ');
    if (view.id !== id || typeof view.owner !== 'string') fail('MIRROR_SOURCE_INVALID');
    return view;
  }
  member(owner) {
    const matches = (this.config.members || []).filter(member => member.openId === owner);
    if (matches.length !== 1 || !matches[0].target) fail('MIRROR_TARGET_REQUIRED');
    const member = matches[0];
    if (member.target.appToken === this.config.appToken) fail('MIRROR_TARGET_IS_SOURCE');
    return member;
  }
  values(view, resolved, member) {
    const result = {};
    for (const key of COPY_FIELDS) if (resolved[key] && (key === 'salesName' || this.config.fields?.leads?.[key])) result[key] = key === 'salesName' ? member.displayName : view[key] ?? (resolved[key].type === 2 ? null : '');
    return result;
  }
  saveDetailJob(id, changes) {
    const stored = this.db.prepare('SELECT data FROM v2_mirrors WHERE id=?').get(id);
    if (!stored) return null;
    const current = JSON.parse(stored.data);
    return this.put({ ...current, detailJob: { ...current.detailJob, ...changes } });
  }
  detailStatus() {
    const jobs = this.rows().filter(row => row.state === 'active' && row.detailJob?.pending).map(row => row.detailJob);
    return { detailPending: jobs.length,
      detailOldestPendingAt: jobs.length ? Math.min(...jobs.map(job => job.pendingSince)) : 0,
      detailNextAttemptAt: jobs.length ? Math.max(this.detailCooldownUntil, Math.min(...jobs.map(job => job.nextAttemptAt || this.now()))) : 0 };
  }
  hasPendingDetails() { return Boolean(this.deferredDetails?.work?.candidates.length); }
  stageDetails(work) {
    if (!(work.names instanceof Map)) return;
    const candidates = new Map(work.candidates.map(candidate => [candidate.row.id, candidate]));
    for (const candidate of this.deferredDetails?.work?.candidates || []) {
      const current = this.latest(candidate.row.sourceId);
      if (current?.state === 'active' && current.id === candidate.row.id && current.detailJob?.pending && !candidates.has(current.id)) {
        candidates.set(current.id, { ...candidate, row: current });
      }
    }
    work.candidates = [...candidates.values()];
    this.deferredDetails = work.candidates.length ? { work } : null;
  }
  detailFields(member, schema) {
    const { target } = member;
    const requiredIds = new Set(Object.values(target.fields).map(spec => spec.fieldId));
    const result = {};
    for (const [logical, { name, type }] of Object.entries(SALES_DETAIL_COLUMNS)) {
      const matches = schema.filter(field => field.field_name === name);
      if (matches.length !== 1) return null;
      const field = matches[0];
      if (Number(field.type) !== type || !/^fld[A-Za-z0-9]{5,}$/.test(field.field_id) || requiredIds.has(field.field_id)) return null;
      requiredIds.add(field.field_id);
      result[logical] = { fieldId: field.field_id, name, type };
    }
    const previous = this.db.prepare('SELECT date_id,operator_name_id FROM v2_sales_detail_pins WHERE target=?').get(targetIdentity(target));
    if (previous && (previous.date_id !== result.leadDate.fieldId || previous.operator_name_id !== result.operatorName.fieldId)) return null;
    return result;
  }
  detailValues(view, fields, names) {
    const values = {};
    if (fields.leadDate && Object.hasOwn(view, 'leadDate')) values.leadDate = view.leadDate;
    if (fields.operatorName) {
      const name = view.operator ? names.get(view.operator) : '';
      if (typeof name === 'string' && name.length <= 200) values.operatorName = name;
    }
    return values;
  }
  prepareDetails(views, childSnapshots, sourceResolved, shouldStop) {
    const work = { sourceResolved, names: null, candidates: [], reviews: 0 };
    if (typeof this.operatorNames !== 'function' || typeof this.auditDetailsTarget !== 'function') return { ...work, reviews: 1 };
    const names = this.operatorNames();
    if (!(names instanceof Map)) return work;
    work.names = names;
    const fieldsByTarget = new Map();
    const members = new Map(this.config.members.filter(member => member.target).map(member => [member.openId, member]));
    for (const member of members.values()) {
      if (stopped(shouldStop)) return work;
      const key = targetIdentity(member.target), schema = childSnapshots.get(key)?.schema;
      if (!schema) continue;
      const fields = this.detailFields(member, schema);
      if (fields) fieldsByTarget.set(key, fields);
    }
    const candidates = [];
    const mappings = new Map(this.rows().filter(row => row.state !== 'revoked').map(row => [row.sourceId, row]));
    for (const view of views) {
      const member = members.get(view.owner), row = mappings.get(view.id);
      if (!member || row?.state !== 'active' || !row.targetRecordId || row.owner !== view.owner || row.memberId !== member.id) continue;
      const key = targetIdentity(member.target);
      if (targetIdentity(row.target) !== key) continue;
      const fields = fieldsByTarget.get(key), record = childSnapshots.get(key)?.records.get(row.targetRecordId);
      if (!fields || !record) continue;
      try {
        const targetView = recordView(record, fields);
        const values = this.detailValues(view, fields, names);
        if (row.detailJob?.pending || Object.entries(values).some(([logical, value]) => !equal(targetView[logical], value))) {
          const queued = row.detailJob?.pending ? row : this.saveDetailJob(row.id, {
            pending: true, pendingSince: this.now(), nextAttemptAt: 0, attempts: 0, lastErrorCode: '', writeUnconfirmed: false,
          });
          candidates.push({ row: queued, member, fields });
        }
      } catch { work.reviews++; }
    }
    candidates.sort((a, b) => a.row.sourceId < b.row.sourceId ? -1 : a.row.sourceId > b.row.sourceId ? 1 : 0);
    const next = candidates.findIndex(({ row }) => row.sourceId > this.detailCursor);
    const start = Math.max(0, next);
    work.candidates = [...candidates.slice(start), ...candidates.slice(0, start)];
    return work;
  }
  async attemptDetails(work, { shouldStop, signal } = {}) {
    const counts = { detailWrites: 0, detailReviews: work.reviews, detailFieldsReady: 0, detailAttempts: 0, detailConfirmed: 0,
      detailPending: work.candidates.length, detailTimeouts: 0, detailPreempted: 0, detailRateLimited: 0,
      detailWriteUnconfirmed: 0 };
    work.reviews = 0;
    if (!work.candidates.length || stopped(shouldStop) || signal?.aborted) return counts;
    const due = work.candidates.findIndex(candidate => Math.max(candidate.row.detailJob?.nextAttemptAt || 0, this.detailCooldownUntil) <= this.now());
    if (due < 0) return { ...counts, ...this.detailStatus() };
    const timer = AbortSignal.timeout(this.detailBudgetMs);
    const limited = new AbortController();
    const deadline = AbortSignal.any([timer, limited.signal, ...(signal ? [signal] : [])]);
    const budgetEnded = () => stopped(shouldStop) || deadline.aborted;
    const abortOnLimit = () => { counts.detailRateLimited = 1; limited.abort(); };
    const candidate = work.candidates.splice(due, 1)[0];
    const { row, fields } = candidate;
    const { sourceResolved } = work;
    counts.detailAttempts = 1;
    counts.detailLastAttemptAt = this.now();
    const key = targetIdentity(candidate.member.target);
    const boundedSource = boundedSalesDetailClient(this.sourceClient, deadline);
    const targetClient = boundedSalesDetailClient(this.clientFactory(candidate.member.target.appToken), deadline);
    const sourceTarget = { appToken: this.config.appToken, tableId: this.config.tableIds.leads, fields: this.config.fields.leads };
    let writeIssued = false, confirmed = false, cancelled = false, errorCode = '';
    try {
      this.detailCursor = row.sourceId;
      const active = this.latest(row.sourceId);
      if (active?.state !== 'active' || active.id !== row.id || active.targetRecordId !== row.targetRecordId) {
        cancelled = true; errorCode = 'SALES_DETAIL_MAPPING_CHANGED'; return counts;
      }
      const member = this.member(row.owner), names = this.operatorNames?.();
      if (!(names instanceof Map)) fail('SALES_DETAIL_ROSTER_NOT_READY');
      if (targetIdentity(member.target) !== key) { cancelled = true; errorCode = 'SALES_DETAIL_MAPPING_CHANGED'; return counts; }
      const [record, current] = await detailReads([
        this.targetRecord(row, targetClient),
        boundedSource.readRecord(this.config.tableIds.leads, row.sourceId),
      ], abortOnLimit);
      if (budgetEnded()) return counts;
      if (!record) { cancelled = true; errorCode = 'SALES_DETAIL_TARGET_MISSING'; return counts; }
      const fresh = recordView(current, sourceResolved);
      const [verifiedSource, schema, access] = await detailReads([
        resolveFields(boundedSource, sourceTarget),
        listFieldMetadata(targetClient, member.target),
        this.auditDetailsTarget(member, budgetEnded, deadline),
      ], abortOnLimit);
      if (budgetEnded()) return counts;
      if (access !== true) fail('SALES_DETAIL_ACCESS_UNVERIFIED');
      if (fingerprint(sourceResolved) !== fingerprint(verifiedSource)) fail('SALES_DETAIL_SOURCE_SCHEMA_CHANGED');
      if (fresh.id !== row.sourceId || fresh.owner !== row.owner) { cancelled = true; errorCode = 'SALES_DETAIL_OWNER_CHANGED'; return counts; }
      counts.detailFieldsReady = 2;
      const atWrite = this.detailFields(member, schema);
      if (fingerprint(atWrite) !== fingerprint(fields)) fail('SALES_DETAIL_TARGET_SCHEMA_CHANGED');
      const targetView = recordView(record, atWrite);
      let values = this.detailValues(fresh, atWrite, names);
      let patch = Object.fromEntries(Object.entries(values).filter(([logical, value]) => !equal(targetView[logical], value)));
      if (budgetEnded()) return counts;
      if (!Object.keys(patch).length) { confirmed = true; counts.detailConfirmed = 1; return counts; }
      const finalRecord = await boundedSource.readRecord(this.config.tableIds.leads, row.sourceId);
      const [finalSourceFields, finalTargetSchema] = await detailReads([
        resolveFields(boundedSource, sourceTarget), listFieldMetadata(targetClient, member.target),
      ], abortOnLimit);
      if (budgetEnded()) return counts;
      if (fingerprint(finalSourceFields) !== fingerprint(sourceResolved)) fail('SALES_DETAIL_SOURCE_SCHEMA_CHANGED');
      if (fingerprint(this.detailFields(member, finalTargetSchema)) !== fingerprint(atWrite)) fail('SALES_DETAIL_TARGET_SCHEMA_CHANGED');
      const final = recordView(finalRecord, finalSourceFields);
      if (final.id !== row.sourceId || final.owner !== row.owner) { cancelled = true; errorCode = 'SALES_DETAIL_OWNER_CHANGED'; return counts; }
      values = this.detailValues(final, atWrite, names);
      patch = Object.fromEntries(Object.entries(values).filter(([logical, value]) => !equal(targetView[logical], value)));
      if (!Object.keys(patch).length) { confirmed = true; counts.detailConfirmed = 1; return counts; }
      const pinned = this.latest(row.sourceId);
      if (pinned?.state !== 'active' || pinned.id !== row.id || pinned.targetRecordId !== row.targetRecordId) {
        cancelled = true; errorCode = 'SALES_DETAIL_MAPPING_CHANGED'; return counts;
      }
      await this.assertLiveConfig();
      if (budgetEnded()) return counts;
      this.checkWrite(shouldStop);
      const encoded = encodePatch(patch, atWrite);
      this.db.prepare('INSERT OR IGNORE INTO v2_sales_detail_pins(target,date_id,operator_name_id) VALUES(?,?,?)')
        .run(key, atWrite.leadDate.fieldId, atWrite.operatorName.fieldId);
      writeIssued = true;
      const response = await targetClient.updateRecord(row.target.tableId, row.targetRecordId, encoded);
      counts.detailWrites = 1;
      const returned = recordView(response, atWrite);
      if (returned.id !== row.targetRecordId || Object.entries(values).some(([logical, value]) => !equal(returned[logical], value))) fail('SALES_DETAIL_UPDATE_UNCONFIRMED');
      confirmed = true; counts.detailConfirmed = 1;
    } catch (error) {
      errorCode = safeCode(error);
      if (absent(error)) cancelled = true;
      if (SALES_DETAIL_LIMIT_CODES.has(safeCode(error))) counts.detailRateLimited = 1;
      if (writeIssued) counts.detailWriteUnconfirmed = 1;
      if (!timer.aborted && !signal?.aborted) counts.detailReviews++;
    } finally {
      if (timer.aborted) counts.detailTimeouts = 1;
      if (signal?.aborted) counts.detailPreempted = 1;
      if (!confirmed && !cancelled) {
        errorCode ||= timer.aborted ? 'SALES_DETAIL_TIMEOUT' : signal?.aborted ? 'SALES_DETAIL_PREEMPTED' : 'SALES_DETAIL_RETRY_REQUIRED';
        const attempts = (row.detailJob?.attempts || 0) + 1;
        const delay = Math.max(counts.detailRateLimited ? 30_000 : 2000, Math.min(300_000, 2000 * 2 ** Math.min(attempts - 1, 8)));
        if (counts.detailRateLimited) this.detailCooldownUntil = Math.max(this.detailCooldownUntil, this.now() + delay);
        candidate.row = this.saveDetailJob(row.id, { pending: true, attempts, nextAttemptAt: this.now() + delay,
          lastAttemptAt: counts.detailLastAttemptAt, lastErrorCode: errorCode, writeUnconfirmed: writeIssued || row.detailJob?.writeUnconfirmed === true });
        if (candidate.row) work.candidates.push(candidate);
      } else {
        this.saveDetailJob(row.id, { pending: false, nextAttemptAt: 0, lastAttemptAt: counts.detailLastAttemptAt,
          lastErrorCode: errorCode, writeUnconfirmed: false, ...(confirmed ? { lastSuccessAt: this.now() } : {}) });
      }
      if (confirmed) counts.detailLastSuccessAt = this.now();
      counts.detailLastErrorCode = errorCode;
      Object.assign(counts, this.detailStatus());
    }
    return counts;
  }
  syncDeferredDetails({ shouldStop = () => false, signal } = {}) {
    return this.exclusive(async () => {
      const deferred = this.deferredDetails;
      if (!deferred) return {};
      const result = await this.attemptDetails(deferred.work, { shouldStop, signal });
      if (!result.detailPending) this.deferredDetails = null;
      return result;
    });
  }
  url(row) { const url = new URL(row.target.baseUrl); url.searchParams.set('table', row.target.tableId); url.searchParams.set('record', row.targetRecordId); return url.href; }
  async targetRecord(row, client = this.clientFactory(row.target.appToken)) {
    try { const record = await client.readRecord(row.target.tableId, row.targetRecordId); if ((record?.record_id || record?.recordId || record?.id) !== row.targetRecordId) fail('MIRROR_TARGET_RESPONSE_MISMATCH'); return record; }
    catch (error) { if (absent(error)) return null; throw error; }
  }
  async revoke(row, { shouldStop = () => false, tombstone = false, replacedTarget = false } = {}) {
    if (!row.targetRecordId) {
      this.review('MIRROR_REVOKE_CREATE_UNKNOWN', row.sourceId, row.id);
      fail('MIRROR_REVOKE_REVIEW_REQUIRED');
    }
    const fresh = await this.source(row.sourceId);
    // Ownership can return to the old salesperson before deletion starts.
    if (!tombstone && !replacedTarget && fresh?.owner === row.owner) { if (row.state !== 'active') this.put({ ...row, state: 'active', errorCode: '' }); return false; }
    const client = this.clientFactory(row.target.appToken);
    const existing = await this.targetRecord(row);
    if (!existing) { if (row.state === 'revoked') return false; this.put({ ...row, state: 'revoked', revokedAt: iso(), errorCode: '' }); this.closeReviews(row.id); return true; }
    this.put({ ...row, state: 'revoke_pending', errorCode: '' });
    const finalSource = await this.source(row.sourceId);
    if (!tombstone && !replacedTarget && finalSource?.owner === row.owner) { this.put({ ...row, state: 'active', errorCode: '' }); return false; }
    this.checkWrite(shouldStop);
    try {
      if (typeof client.deleteRecord === 'function') await client.deleteRecord(row.target.tableId, row.targetRecordId);
      else await client.api(`/open-apis/bitable/v1/apps/${encodeURIComponent(row.target.appToken)}/tables/${encodeURIComponent(row.target.tableId)}/records/${encodeURIComponent(row.targetRecordId)}`, { method: 'DELETE' });
    } catch (error) { if (!absent(error)) { const after = await this.targetRecord(row); if (after) { this.review('MIRROR_REVOKE_UNCONFIRMED', row.sourceId, row.id); throw error; } } }
    if (await this.targetRecord(row)) { this.review('MIRROR_REVOKE_UNCONFIRMED', row.sourceId, row.id); fail('MIRROR_REVOKE_UNCONFIRMED'); }
    this.put({ ...row, state: 'revoked', revokedAt: iso(), errorCode: '' }); this.closeReviews(row.id); return true;
  }
  async create(source, member, shouldStop) {
    const target = member.target, client = this.clientFactory(target.appToken);
    const resolved = await resolveFields(client, target);
    for (const key of ['wx', 'needs', ...this.feedback]) if (!resolved[key]) fail('MIRROR_TARGET_FIELDS_INCOMPLETE');
    const latest = await this.source(source.id);
    if (!latest || latest.owner !== member.openId) fail('MIRROR_OWNERSHIP_CHANGED');
    const previousVersions = this.rows().filter(row => row.sourceId === source.id).map(row => row.version);
    const version = previousVersions.length ? Math.max(...previousVersions) + 1 : 1;
    const atCreate = await resolveFields(client, target);
    if (fingerprint(atCreate) !== fingerprint(resolved)) fail('MIRROR_TARGET_SCHEMA_CHANGED_BEFORE_WRITE');
    const values = this.values(latest, atCreate, member), fields = encodePatch(values, atCreate);
    let row = { id: fingerprint([this.config.appToken, this.config.tableIds.leads, source.id, version]), sourceAppToken: this.config.appToken, sourceTableId: this.config.tableIds.leads, sourceId: source.id, version, owner: member.openId, memberId: member.id,
      target: structuredClone(target), targetRecordId: null, state: 'creating', clientToken: randomUUID(), baseValues: values, createdAt: iso(), errorCode: '' };
    this.checkWrite(shouldStop);
    this.put(row);
    let record;
    try {
      if (typeof client.createRecord !== 'function') fail('MIRROR_CREATE_ADAPTER_REQUIRED');
      record = await client.createRecord(target.tableId, fields, { clientToken: row.clientToken });
      const id = record?.record_id || record?.recordId || record?.id;
      if (typeof id !== 'string' || !id) fail('MIRROR_CREATE_RESULT_UNKNOWN');
      if (this.rows().some(existing => existing.id !== row.id && targetIdentity(existing.target) === targetIdentity(target) && existing.targetRecordId === id)) fail('MIRROR_TARGET_ID_ALREADY_BOUND');
      row = this.put({ ...row, targetRecordId: id, state: 'active' });
    } catch (error) {
      this.put({ ...row, state: 'create_review', errorCode: 'MIRROR_CREATE_OUTCOME_UNKNOWN' });
      this.review('MIRROR_CREATE_OUTCOME_UNKNOWN', row.sourceId, row.id);
      fail('MIRROR_CREATE_REVIEW_REQUIRED');
    }
    const after = await this.source(row.sourceId);
    if (!after || after.owner !== row.owner) { await this.revoke(row, { shouldStop }); fail('MIRROR_OWNERSHIP_CHANGED'); }
    const confirmed = await this.targetRecord(row);
    if (!confirmed) { this.put({ ...row, state: 'target_missing_review', errorCode: 'MIRROR_CREATE_UNCONFIRMED' }); this.review('MIRROR_CREATE_UNCONFIRMED', row.sourceId, row.id); fail('MIRROR_TARGET_MISSING_REVIEW_REQUIRED'); }
    const targetView = recordView(confirmed, resolved);
    if (Object.entries(values).some(([key, value]) => !equal(targetView[key], value))) { this.review('MIRROR_CREATE_CONTENT_UNCONFIRMED', row.sourceId, row.id); fail('MIRROR_CREATE_CONTENT_UNCONFIRMED'); }
    return row;
  }
  async reconcile(row, member, shouldStop, statusSources) {
    const client = this.clientFactory(row.target.appToken), resolved = await resolveFields(client, member.target);
    for (const key of ['wx', 'needs', ...this.feedback]) if (!resolved[key]) fail('MIRROR_TARGET_FIELDS_INCOMPLETE');
    const sourceResolved = await this.resolveSource();
    const record = await this.targetRecord(row);
    if (!record) { this.put({ ...row, state: 'target_missing_review', errorCode: 'MIRROR_TARGET_RECORD_MISSING' }); this.review('MIRROR_TARGET_RECORD_MISSING', row.sourceId, row.id); fail('MIRROR_TARGET_MISSING_REVIEW_REQUIRED'); }
    const targetView = recordView(record, resolved);
    let fresh = await this.source(row.sourceId), statusWritebackIntent = null;
    if (!fresh || fresh.owner !== row.owner) fail('MIRROR_OWNERSHIP_CHANGED');
    if (row.statusWritebackIntent && fresh.wxStatus !== row.statusWritebackIntent.from) {
      // A lost acknowledgement does not prove the personal table authored the current source value.
      this.review(STATUS_WRITEBACK_UNCONFIRMED, row.sourceId, row.id);
      row = this.put({ ...row, statusWritebackIntent: null });
    }
    const sourceValues = this.values(fresh, resolved, member), inbound = {};
    for (const key of this.feedback) {
      if (!Object.hasOwn(row.baseValues, key) || !resolved[key] || !sourceResolved[key]) fail('MIRROR_FEEDBACK_BASELINE_MISSING');
      if (equal(targetView[key], row.baseValues[key]) || equal(targetView[key], sourceValues[key])) continue;
      if (!equal(sourceValues[key], row.baseValues[key])) {
        this.review('MIRROR_FEEDBACK_CONFLICT', row.sourceId, row.id);
        fail('MIRROR_FEEDBACK_CONFLICT');
      }
      inbound[key] = targetView[key];
    }
    if (Object.keys(inbound).length) {
      if (row.feedbackBlocked) fail('MIRROR_FEEDBACK_REVIEW_REQUIRED');
      if ((row.feedbackNextAttemptAt || 0) > this.now()) fail('MIRROR_FEEDBACK_RETRY_LATER');
      // The source update uses only immutable backend mapping, never a child source-ID column.
      const final = await this.source(row.sourceId);
      if (!final || final.owner !== row.owner) fail('MIRROR_OWNERSHIP_CHANGED');
      for (const key of Object.keys(inbound)) if (!equal(final[key], fresh[key])) { this.review('MIRROR_FEEDBACK_CONFLICT', row.sourceId, row.id); fail('MIRROR_FEEDBACK_CONFLICT'); }
      const atSourceWrite = await this.resolveSource();
      if (fingerprint(atSourceWrite) !== fingerprint(sourceResolved)) fail('MIRROR_SOURCE_SCHEMA_CHANGED_BEFORE_WRITE');
      const patch = encodePatch(inbound, atSourceWrite);
      this.checkWrite(shouldStop);
      const attempts = (row.feedbackAttempts || 0) + 1;
      statusWritebackIntent = Object.hasOwn(inbound, 'wxStatus') ? { id: randomUUID(), owner: row.owner, from: final.wxStatus, to: inbound.wxStatus } : null;
      row = this.put({ ...row, pendingFeedback: inbound, statusWritebackIntent, feedbackAttempts: attempts, feedbackNextAttemptAt: this.now() + Math.min(300_000, 2000 * 2 ** Math.min(attempts, 8)) });
      this.sourceMutationCount++;
      try { await this.sourceClient.updateRecord(this.config.tableIds.leads, row.sourceId, patch); }
      catch (error) { this.put({ ...row, feedbackBlocked: attempts >= 8, errorCode: safeCode(error) }); this.review(attempts >= 8 ? 'MIRROR_FEEDBACK_REVIEW_REQUIRED' : 'MIRROR_FEEDBACK_UPDATE_FAILED', row.sourceId, row.id); throw error; }
      if (statusWritebackIntent) row = this.put({ ...row, statusWritebackIntent: null, statusWriteback: statusWritebackIntent });
      fresh = await this.source(row.sourceId);
      if (!fresh || fresh.owner !== row.owner) fail('MIRROR_OWNERSHIP_CHANGED');
      if (Object.entries(inbound).some(([key, value]) => !equal(fresh[key], value))) { this.review('MIRROR_FEEDBACK_UNCONFIRMED', row.sourceId, row.id); fail('MIRROR_FEEDBACK_UNCONFIRMED'); }
    }
    // Read ownership once more immediately before any write to the sales table.
    fresh = await this.source(row.sourceId);
    if (!fresh || fresh.owner !== row.owner) fail('MIRROR_OWNERSHIP_CHANGED');
    const canonical = this.values(fresh, resolved, member), outbound = {};
    for (const [key, value] of Object.entries(canonical)) if (!equal(targetView[key], value)) outbound[key] = value;
    if (Object.keys(outbound).length) {
      const atTargetWrite = await resolveFields(client, member.target);
      if (fingerprint(atTargetWrite) !== fingerprint(resolved)) fail('MIRROR_TARGET_SCHEMA_CHANGED_BEFORE_WRITE');
      const patch = encodePatch(outbound, atTargetWrite);
      this.checkWrite(shouldStop);
      await client.updateRecord(row.target.tableId, row.targetRecordId, patch);
    }
    const after = await this.source(row.sourceId);
    if (!after || after.owner !== row.owner) fail('MIRROR_OWNERSHIP_CHANGED');
    if (statusWritebackIntent && after.wxStatus === statusWritebackIntent.to) statusSources?.push(after);
    this.put({ ...row, state: 'active', baseValues: canonical, pendingFeedback: null, statusWritebackIntent: null, feedbackAttempts: 0, feedbackNextAttemptAt: 0, feedbackBlocked: false, errorCode: '' });
    this.closeReviews(row.id);
    return true;
  }
  async ensureInternal(view, { shouldStop = () => false, statusSources } = {}) {
    if (typeof view?.id !== 'string' || !view.id) fail('MIRROR_SOURCE_ID_REQUIRED');
    this.checkWrite(shouldStop);
    for (let attempt = 0; attempt < 4; attempt++) {
      const fresh = await this.source(view.id), current = this.latest(view.id);
      if (!fresh?.owner) {
        if (current) await this.revoke(current, { shouldStop });
        fail(fresh ? 'MIRROR_SOURCE_UNASSIGNED' : 'MIRROR_SOURCE_DELETED');
      }
      let member;
      try { member = this.member(fresh.owner); }
      catch (error) { if (current) await this.revoke(current, { shouldStop, replacedTarget: current.owner === fresh.owner }); this.review('MIRROR_TARGET_REQUIRED', view.id, current?.id || ''); throw error; }
      if (current?.state === 'create_review' || current?.state === 'creating') fail('MIRROR_CREATE_REVIEW_REQUIRED');
      const same = current && current.owner === fresh.owner && current.memberId === member.id && targetIdentity(current.target) === targetIdentity(member.target);
      if (current && !same) { const revoked = await this.revoke(current, { shouldStop, replacedTarget: current.owner === fresh.owner }); if (!revoked) continue; }
      else if (same) {
        if (current.state === 'revoke_pending') { this.put({ ...current, state: 'active', errorCode: '' }); }
        try { if (await this.reconcile(current, member, shouldStop, statusSources)) return { url: this.url(current), targetRecordId: current.targetRecordId }; }
        catch (error) { if (safeCode(error) === 'MIRROR_OWNERSHIP_CHANGED') continue; throw error; }
        continue;
      }
      // A manually restored revoked record must not become a second active mirror.
      for (const old of this.rows().filter(row => row.sourceId === view.id && row.state === 'revoked' && row.targetRecordId)) {
        if (await this.targetRecord(old)) await this.revoke(old, { shouldStop, tombstone: true });
      }
      try { const row = await this.create(fresh, member, shouldStop); return { url: this.url(row), targetRecordId: row.targetRecordId }; }
      catch (error) { if (safeCode(error) === 'MIRROR_OWNERSHIP_CHANGED') continue; throw error; }
    }
    fail('MIRROR_OWNERSHIP_UNSTABLE');
  }
  ensure(view, options = {}) { return this.exclusive(() => this.ensureInternal(view, options)); }
  sync({ shouldStop = () => false, sourceViews, deferDetails = false, allowDetailsStaging = true } = {}) {
    return this.exclusive(async () => {
      const mutationsBefore = this.sourceMutationCount;
      const statusSources = [];
      const counts = { sourceRecords: 0, unchanged: 0, ensured: 0, revoked: 0, reviews: 0, unknownChildRecords: 0, sourceWrites: 0, stopped: false };
      this.checkWrite(shouldStop);
      const sourceResolved = await this.resolveSource();
      const sourceRecords = sourceViews === undefined ? await records(this.sourceClient, { appToken: this.config.appToken, tableId: this.config.tableIds.leads }) : null;
      if (sourceViews !== undefined && !Array.isArray(sourceViews)) fail('MIRROR_SOURCE_SNAPSHOT_INVALID');
      if (sourceViews === undefined && fingerprint(sourceResolved) !== fingerprint(await this.resolveSource())) fail('MIRROR_SOURCE_SCHEMA_CHANGED_DURING_SCAN');
      // One metadata read and one paginated snapshot per child Base, regardless
      // of lead count. The snapshot is a change detector, never write authority.
      const childSnapshots = new Map();
      for (const member of this.config.members || []) {
        if (stopped(shouldStop)) return { ...counts, stopped: true, ...this.status(), busy: false };
        if (!member.target) continue;
        const client = this.clientFactory(member.target.appToken);
        const resolved = await resolveFields(client, member.target);
        for (const key of ['wx', 'needs', ...this.feedback]) if (!resolved[key]) fail('MIRROR_TARGET_FIELDS_INCOMPLETE');
        const childRecords = await records(client, member.target);
        let schema;
        const verified = await resolveFields(client, member.target,
          this.detailEnabled ? { observeSchema: fields => { schema = fields; } } : undefined);
        if (fingerprint(resolved) !== fingerprint(verified)) fail('MIRROR_TARGET_SCHEMA_CHANGED_DURING_SCAN');
        childSnapshots.set(targetIdentity(member.target), { resolved, schema, records: new Map(childRecords.map(record => [record.record_id || record.recordId || record.id, record])) });
      }
      const present = new Set();
      const views = sourceViews || sourceRecords.map(record => {
        const id = record.record_id || record.recordId || record.id;
        try { return recordView(record, sourceResolved); } catch (error) { return { id, snapshotError: safeCode(error) }; }
      });
      for (const view of views) {
        if (stopped(shouldStop)) { counts.stopped = true; break; }
        const id = view?.id;
        if (typeof id !== 'string' || !id || present.has(id)) fail('MIRROR_SOURCE_SNAPSHOT_INVALID');
        present.add(id); counts.sourceRecords++;
        try {
          if (view.snapshotError) fail(view.snapshotError);
          const current = this.latest(id);
          if (view.owner) {
            // A failed member lookup only disables the no-change optimization.
            // ensureInternal must still revoke the old owner's trusted copy.
            let member;
            try { member = this.member(view.owner); } catch { member = null; }
            const snapshot = member ? childSnapshots.get(targetIdentity(member.target)) : null;
            const childRecord = current?.targetRecordId && snapshot?.records.get(current.targetRecordId);
            if (member && current?.state === 'active' && current.owner === view.owner && current.memberId === member.id && targetIdentity(current.target) === targetIdentity(member.target) && childRecord && !current.pendingFeedback) {
              const sourceValues = this.values(view, snapshot.resolved, member), child = recordView(childRecord, snapshot.resolved);
              if (Object.entries(sourceValues).every(([key, value]) => equal(value, current.baseValues[key]) && equal(child[key], current.baseValues[key]))) { counts.unchanged++; continue; }
            }
            await this.ensureInternal(view, { shouldStop, statusSources }); counts.ensured++;
          } else if (current && await this.revoke(current, { shouldStop })) counts.revoked++;
        } catch (error) { if (safeCode(error) === 'MIRROR_STOP_REQUESTED') { counts.stopped = true; break; } this.review(safeCode(error), id, this.latest(id)?.id || ''); counts.reviews++; }
      }
      if (!counts.stopped) for (const row of this.rows()) {
        if (stopped(shouldStop)) { counts.stopped = true; break; }
        if (present.has(row.sourceId) && row.state !== 'revoked') continue;
        const snapshot = childSnapshots.get(targetIdentity(row.target));
        if (row.state === 'revoked' && snapshot && !snapshot.records.has(row.targetRecordId)) continue;
        try {
          const source = await this.source(row.sourceId);
          if (!source?.owner || source.owner !== row.owner || row.state === 'revoked') {
            if (await this.revoke(row, { shouldStop, tombstone: row.state === 'revoked' })) counts.revoked++;
          }
        } catch (error) { if (safeCode(error) === 'MIRROR_STOP_REQUESTED') { counts.stopped = true; break; } this.review(safeCode(error), row.sourceId, row.id); counts.reviews++; }
      }
      // Unknown child rows are only reported. They never establish source mappings.
      if (!counts.stopped) for (const member of this.config.members || []) {
        if (stopped(shouldStop)) { counts.stopped = true; break; }
        if (!member.target) continue;
        try {
          const childRecords = [...(childSnapshots.get(targetIdentity(member.target))?.records.values() || [])];
          const known = new Set(this.rows().filter(row => targetIdentity(row.target) === targetIdentity(member.target) && row.targetRecordId).map(row => row.targetRecordId));
          for (const record of childRecords) { const id = record.record_id || record.recordId || record.id; if (!known.has(id)) { counts.unknownChildRecords++; this.review('MIRROR_UNTRUSTED_CHILD_RECORD', '', '', { targetAppToken: member.target.appToken, targetRecordId: id }); } }
        } catch (error) { this.review(safeCode(error)); counts.reviews++; }
      }
      let detailCounts = {};
      if (!counts.stopped && this.detailEnabled && allowDetailsStaging) {
        try {
          this.stageDetails(this.prepareDetails(views, childSnapshots, sourceResolved, shouldStop));
          detailCounts = { detailWrites: 0, detailReviews: 0, detailFieldsReady: 0, ...this.detailStatus() };
          if (!deferDetails && this.deferredDetails) detailCounts = await this.attemptDetails(this.deferredDetails.work, { shouldStop });
        }
        catch { detailCounts = { detailReviews: 1 }; }
      }
      return { ...counts, ...detailCounts, sourceWrites: this.sourceMutationCount - mutationsBefore, statusSources, ...this.status(), busy: false };
    });
  }
}
