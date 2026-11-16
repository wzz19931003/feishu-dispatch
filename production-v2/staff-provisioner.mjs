import { randomUUID } from 'node:crypto';
import { STAFF_TARGET_NAMES } from './staff-admin-client.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const personId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{5,}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safe = error => /^[A-Z0-9_]{1,100}$/.test(String(error?.code ?? '')) ? `STAFF_${String(error.code).replace(/^STAFF_/, '')}` : 'STAFF_OPERATION_FAILED';
const pauseCode = code => ['STAFF_STOPPED', 'STAFF_INPUT_CHANGED', 'STAFF_EMPLOYEE_DISABLED', 'STAFF_EMPLOYEE_REMOVED'].includes(code);
const pending = (errorCode, nextRetryAt) => ({ state: 'pending', errorCode, ...(nextRetryAt ? { nextRetryAt } : {}) });
const reviewed = errorCode => ({ state: 'review', errorCode });
const copy = value => JSON.parse(JSON.stringify(value));
const fieldTypes = { wx: [1], needs: [1], wxStatus: [1, 3], addMethod: [1, 3], partySize: [1, 2], salesName: [1] };
const stopped = callback => { try { return Boolean(callback()); } catch { return true; } };

/** A durable preparation queue; the caller owns db and must enforce a single active host. */
export class StaffProvisioner {
  constructor({ config, db, client, readCurrent, now = Date.now } = {}) {
    if (!config || !db?.prepare || !client || typeof now !== 'function') fail('STAFF_PROVISIONER_ARGUMENTS_INVALID');
    this.config = config; this.db = db; this.client = client; this.readCurrent = readCurrent; this.now = now; this.busy = false;
    const readers = config.staffManagement?.fixedReaders;
    if (!Array.isArray(readers) || readers.length !== 4 || readers.some(reader => !personId(reader?.openId))
      || new Set(readers.map(reader => reader.openId)).size !== 4) fail('STAFF_FIXED_READERS_INVALID');
    this.fixedReaders = new Set(readers.map(reader => reader.openId));
    db.exec(`CREATE TABLE IF NOT EXISTS v2_staff_provision_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_staff_provision_jobs (
        record_id TEXT PRIMARY KEY,open_id TEXT NOT NULL UNIQUE,role TEXT NOT NULL,input_version TEXT NOT NULL,
        stage TEXT NOT NULL,base_name TEXT NOT NULL DEFAULT '',base_token TEXT,base_url TEXT,target_json TEXT,expected_json TEXT,grants_json TEXT NOT NULL DEFAULT '[]',
        welcome_uuid TEXT NOT NULL,welcome_url TEXT,message_id TEXT,error_code TEXT,attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS v2_staff_provision_base_pin ON v2_staff_provision_jobs(base_token) WHERE base_token IS NOT NULL;`);
    const binding = JSON.stringify({ appId: config.appId, source: config.appToken, sourceTable: config.tableIds?.leads,
      staff: config.staffManagement?.appToken, staffTable: config.staffManagement?.tableId, fixedReaders: [...this.fixedReaders].sort() });
    const previous = db.prepare("SELECT value FROM v2_staff_provision_meta WHERE key='binding'").get();
    if (previous && previous.value !== binding) fail('STAFF_PROVISION_BINDING_MISMATCH');
    if (!previous) db.prepare("INSERT INTO v2_staff_provision_meta(key,value) VALUES('binding',?)").run(binding);
  }
  job(recordId) { return this.db.prepare('SELECT * FROM v2_staff_provision_jobs WHERE record_id=?').get(recordId) ?? null; }
  save(job, patch) {
    Object.assign(job, patch, { updated_at: this.now() });
    this.db.prepare(`UPDATE v2_staff_provision_jobs SET stage=?,base_token=?,base_url=?,target_json=?,expected_json=?,grants_json=?,
      welcome_url=?,message_id=?,error_code=?,attempts=?,next_retry_at=?,updated_at=? WHERE record_id=?`).run(
      job.stage, job.base_token ?? null, job.base_url ?? null, job.target_json ?? null, job.expected_json ?? null, job.grants_json ?? '[]',
      job.welcome_url ?? null, job.message_id ?? null, job.error_code ?? null, job.attempts ?? 0, job.next_retry_at ?? null, job.updated_at, job.record_id);
  }
  review(job, code) { if (job) this.save(job, { stage: 'review', error_code: code, next_retry_at: null }); return reviewed(code); }
  wait(job, code, { count = true } = {}) {
    if (pauseCode(code)) { if (job) this.save(job, { error_code: code, next_retry_at: null }); return pending(code); }
    const attempts = count ? (job?.attempts ?? 0) + 1 : job?.attempts ?? 0;
    if (attempts >= 8) return this.review(job, 'STAFF_RETRY_LIMIT_REVIEW');
    const nextRetryAt = this.now() + Math.min(600_000, 1000 * 5 ** Math.min(attempts, 4));
    if (job) this.save(job, { attempts, error_code: code, next_retry_at: nextRetryAt });
    return pending(code, nextRetryAt);
  }
  async guard(employee, shouldStop) {
    if (stopped(shouldStop)) fail('STAFF_STOPPED');
    if (typeof this.readCurrent !== 'function') fail('STAFF_READ_CURRENT_REQUIRED');
    const current = await this.readCurrent(employee.recordId);
    if (stopped(shouldStop)) fail('STAFF_STOPPED');
    if (!current) fail('STAFF_EMPLOYEE_REMOVED');
    if (!current.enabled) fail('STAFF_EMPLOYEE_DISABLED');
    if (current.recordId !== employee.recordId || current.openId !== employee.openId || current.role !== employee.role || current.version !== employee.version) fail('STAFF_INPUT_CHANGED');
  }
  formUrl() {
    const value = this.config.staffManagement.operatorFormUrl;
    let url; try { url = new URL(value); } catch { fail('STAFF_OPERATOR_FORM_INVALID'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn') || url.username || url.password || url.hash
      || !/^\/share\/(?:base\/)?form\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) fail('STAFF_OPERATOR_FORM_INVALID');
    return url.href;
  }
  target(raw) {
    if (!object(raw) || !/^[A-Za-z0-9]{10,100}$/.test(raw.appToken ?? '') || raw.appToken === this.config.appToken
      || raw.appToken === this.config.staffManagement.appToken || !/^tbl[A-Za-z0-9]{5,}$/.test(raw.tableId ?? '') || !object(raw.fields)) fail('STAFF_TARGET_INVALID');
    let url; try { url = new URL(raw.baseUrl); } catch { fail('STAFF_TARGET_INVALID'); }
    if (url.protocol !== 'https:' || url.origin !== new URL(this.config.baseUrl).origin || url.username || url.password || url.search || url.hash
      || url.pathname.replace(/\/$/, '') !== `/base/${raw.appToken}`) fail('STAFF_TARGET_INVALID');
    const ids = new Set(), fields = {};
    for (const [key, spec] of Object.entries(raw.fields)) {
      if (!fieldTypes[key] || !/^fld[A-Za-z0-9]{5,}$/.test(spec?.fieldId ?? '') || !Array.isArray(spec.types) || !spec.types.length
        || spec.types.some(type => !fieldTypes[key].includes(type)) || ids.has(spec.fieldId)) fail('STAFF_TARGET_FIELDS_INVALID');
      ids.add(spec.fieldId); fields[key] = { fieldId: spec.fieldId, types: [...spec.types] };
    }
    if (['wx', 'needs', 'wxStatus', ...(this.config.mirrors?.feedbackFields ?? ['wxStatus'])].some(key => !fields[key])) fail('STAFF_TARGET_FIELDS_INVALID');
    return { appToken: raw.appToken, baseUrl: url.href.replace(/\/$/, ''), tableId: raw.tableId, fields };
  }
  privateSharing(settings) {
    return (settings?.externalAccessEntity ?? settings?.external_access_entity) === 'closed'
      && (settings?.linkShareEntity ?? settings?.link_share_entity) === 'closed'
      && (settings?.manageCollaboratorEntity ?? settings?.manage_collaborator_entity) === 'collaborator_full_access';
  }
  members(employee, members, { existing = false, requireAll = false } = {}) {
    if (!Array.isArray(members)) fail('STAFF_MEMBERS_INVALID');
    const desired = new Map([...this.fixedReaders].map(id => [id, 'view'])); desired.set(employee.openId, 'edit');
    const actual = new Map();
    for (const member of members) {
      if (member?.isApp === true) {
        if (!['full_access', 'owner'].includes(member.perm)) fail('STAFF_APP_MANAGE_REQUIRED');
        continue;
      }
      const id = member?.openId ?? member?.member_id;
      const kind = member?.memberType ?? member?.member_type ?? 'openid';
      if (kind !== 'openid' || !personId(id) || !desired.has(id) || actual.has(id)) fail('STAFF_UNKNOWN_COLLABORATOR_REVIEW');
      const allowed = existing ? id === employee.openId ? ['edit', 'full_access', 'owner'] : ['view', 'edit', 'full_access', 'owner'] : [desired.get(id)];
      if (!allowed.includes(member.perm)) fail('STAFF_COLLABORATOR_PERMISSION_REVIEW');
      actual.set(id, member.perm);
    }
    const missing = [...desired].filter(([id]) => !actual.has(id));
    if (requireAll && missing.length) fail('STAFF_REQUIRED_COLLABORATOR_MISSING');
    return missing.map(([openId, perm]) => ({ openId, perm }));
  }
  schema(target, input, { fresh = false, expected = {} } = {}) {
    const items = Array.isArray(input) ? input : input?.items;
    for (const [key, spec] of Object.entries(target.fields)) {
      const field = items ? items.find(item => item.field_id === spec.fieldId) : input?.[key];
      const id = field?.fieldId ?? field?.field_id, name = field?.name ?? field?.field_name;
      if (id !== spec.fieldId || !spec.types.includes(Number(field?.type)) || typeof name !== 'string' || !name.trim()) fail('STAFF_TARGET_SCHEMA_REVIEW');
      if (fresh && STAFF_TARGET_NAMES[key] && name !== STAFF_TARGET_NAMES[key]) fail('STAFF_TARGET_SCHEMA_REVIEW');
      if (fresh && expected[key]) {
        const options = field.property?.options;
        if (!Array.isArray(options) || JSON.stringify(options.map(option => option.name).sort()) !== JSON.stringify([...expected[key]].sort())) fail('STAFF_TARGET_OPTIONS_REVIEW');
      }
    }
  }
  async auditTarget(employee, target, { fresh = false, expected = {}, shouldStop } = {}) {
    await this.guard(employee, shouldStop);
    if (!this.privateSharing(await this.client.getSharing(target.appToken))) fail('STAFF_PRIVATE_SHARING_REVIEW');
    this.members(employee, await this.client.listMembers(target.appToken), { existing: !fresh, requireAll: true });
    this.schema(target, await this.client.getTargetSchema(target), { fresh, expected });
    await this.guard(employee, shouldStop);
  }
  async step(job, employee, shouldStop, operation, resumeStage, invoke, success) {
    await this.guard(employee, shouldStop);
    this.save(job, { stage: `${operation}_inflight`, error_code: null, next_retry_at: null });
    try {
      const result = await invoke(() => this.guard(employee, shouldStop));
      success(result);
      this.save(job, { attempts: 0, error_code: null, next_retry_at: null });
      return null;
    } catch (error) {
      const code = safe(error);
      if (error?.staffMutationAttempted === false || error?.staffDefinitelyRejected === true || pauseCode(code)) {
        this.save(job, { stage: resumeStage }); return this.wait(job, code);
      }
      return this.review(job, `STAFF_${operation.toUpperCase()}_OUTCOME_UNKNOWN_REVIEW`);
    }
  }
  async ensure(employee, { apply = false, shouldStop = () => false } = {}) {
    if (!apply) return pending('STAFF_APPLY_REQUIRED');
    if (this.config.enabled !== true || this.config.notification?.enabled !== true || this.config.staffManagement?.enabled !== true) return pending('STAFF_AUTOMATION_DISABLED');
    if (this.busy) return pending('STAFF_PROVISIONER_BUSY', this.now() + 1000);
    if (!object(employee) || !/^rec[A-Za-z0-9]+$/.test(employee.recordId ?? '') || !personId(employee.openId)
      || !['sales', 'operator'].includes(employee.role) || !employee.enabled || typeof employee.version !== 'string' || !employee.version
      || typeof employee.displayName !== 'string' || !employee.displayName.trim()) return reviewed('STAFF_EMPLOYEE_INVALID');
    this.busy = true; let job = this.job(employee.recordId);
    try {
      await this.guard(employee, shouldStop);
      if (employee.role === 'operator' && employee.target) return reviewed('STAFF_OPERATOR_TARGET_INVALID');
      if (job && (job.open_id !== employee.openId || job.role !== employee.role)) return reviewed('STAFF_PINNED_IDENTITY_CHANGED_REVIEW');
      if (job?.stage === 'review') return reviewed(job.error_code ?? 'STAFF_MANUAL_REVIEW_REQUIRED');
      if (job?.stage.endsWith('_inflight')) return this.review(job, 'STAFF_INTERRUPTED_MUTATION_REVIEW');
      if (job && job.stage !== 'ready' && job.input_version !== employee.version) return this.review(job, 'STAFF_INPUT_VERSION_CHANGED_REVIEW');
      if (job?.next_retry_at > this.now()) return pending(job.error_code, job.next_retry_at);
      const existing = employee.target || (job?.stage === 'ready' && job.target_json ? JSON.parse(job.target_json) : null);
      if (existing) {
        const target = this.target(existing);
        if ((this.config.members ?? []).some(member => member.openId !== employee.openId && member.target?.appToken === target.appToken)) return reviewed('STAFF_TARGET_OTHER_EMPLOYEE_REVIEW');
        if (job?.target_json && JSON.stringify(this.target(JSON.parse(job.target_json))) !== JSON.stringify(target)) return this.review(job, 'STAFF_PINNED_TARGET_CHANGED_REVIEW');
        await this.auditTarget(employee, target, { shouldStop }); return { state: 'ready', target };
      }
      if (employee.seeded) {
        if (employee.role === 'sales') return reviewed('STAFF_SEED_TARGET_REQUIRED');
        return { state: 'ready', url: this.formUrl() };
      }
      if (!job) {
        const conflict = this.db.prepare('SELECT record_id FROM v2_staff_provision_jobs WHERE open_id=?').get(employee.openId);
        if (conflict) return reviewed('STAFF_DUPLICATE_EMPLOYEE_IDENTITY_REVIEW');
        this.db.prepare(`INSERT INTO v2_staff_provision_jobs(record_id,open_id,role,input_version,stage,base_name,welcome_uuid,updated_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(employee.recordId, employee.openId, employee.role, employee.version,
          employee.role === 'sales' ? 'base_needed' : 'welcome_needed', `销售客资—${employee.displayName.trim()}`.slice(0, 255), randomUUID(), this.now());
        job = this.job(employee.recordId);
      }
      for (let count = 0; count < 30; count++) {
        await this.guard(employee, shouldStop);
        let result;
        if (job.stage === 'base_needed') {
          result = await this.step(job, employee, shouldStop, 'base_create', 'base_needed', beforeMutation => this.client.createBase({ name: job.base_name, beforeMutation }), base => {
            if (!/^[A-Za-z0-9]{10,100}$/.test(base?.appToken ?? '') || base.appToken === this.config.appToken || base.appToken === this.config.staffManagement.appToken
              || (this.config.members ?? []).some(member => member.target?.appToken === base.appToken)) fail('STAFF_CREATED_BASE_INVALID');
            if (this.db.prepare('SELECT record_id FROM v2_staff_provision_jobs WHERE base_token=? AND record_id<>?').get(base.appToken, job.record_id)) fail('STAFF_CREATED_BASE_ALREADY_BOUND_REVIEW');
            const url = `${new URL(this.config.baseUrl).origin}/base/${base.appToken}`;
            if (base.url && base.url.replace(/\/$/, '') !== url) fail('STAFF_CREATED_BASE_INVALID');
            Object.assign(job, { stage: 'table_needed', base_token: base.appToken, base_url: url });
          });
        } else if (job.stage === 'table_needed') {
          result = await this.step(job, employee, shouldStop, 'table_create', 'table_needed', beforeMutation => this.client.createBusinessTable(job.base_token, { beforeMutation }), raw => {
            const target = this.target(raw);
            if (target.appToken !== job.base_token || target.baseUrl !== job.base_url || Object.keys(STAFF_TARGET_NAMES).some(key => !target.fields[key])) fail('STAFF_CREATED_TABLE_INVALID');
            Object.assign(job, { stage: 'schema_confirm', target_json: JSON.stringify(target), expected_json: JSON.stringify(raw.expectedOptions ?? {}) });
          });
        } else if (job.stage === 'schema_confirm') {
          this.schema(JSON.parse(job.target_json), await this.client.getTargetSchema(JSON.parse(job.target_json)), { fresh: true, expected: JSON.parse(job.expected_json ?? '{}') });
          this.save(job, { stage: 'private_needed', attempts: 0 });
        } else if (job.stage === 'private_needed') {
          if (this.privateSharing(await this.client.getSharing(job.base_token))) { this.save(job, { stage: 'members_needed', attempts: 0 }); continue; }
          result = await this.step(job, employee, shouldStop, 'sharing_set', 'private_needed', beforeMutation => this.client.setPrivateSharing(job.base_token, { beforeMutation }), () => { job.stage = 'private_confirm'; });
        } else if (job.stage === 'private_confirm') {
          if (!this.privateSharing(await this.client.getSharing(job.base_token))) return this.wait(job, 'STAFF_PRIVATE_SHARING_UNCONFIRMED');
          this.save(job, { stage: 'members_needed', attempts: 0 });
        } else if (job.stage === 'members_needed') {
          const missing = this.members(employee, await this.client.listMembers(job.base_token));
          if (!missing.length) { this.save(job, { stage: 'subscribe_needed', attempts: 0 }); continue; }
          const grant = missing[0], sent = JSON.parse(job.grants_json);
          if (sent.includes(grant.openId)) return this.wait(job, 'STAFF_MEMBER_GRANT_UNCONFIRMED');
          result = await this.step(job, employee, shouldStop, 'member_add', 'members_needed', beforeMutation => this.client.addMember(job.base_token, { ...grant, beforeMutation }), () => {
            job.stage = 'members_needed'; job.grants_json = JSON.stringify([...sent, grant.openId]);
          });
        } else if (job.stage === 'subscribe_needed') {
          await this.auditTarget(employee, JSON.parse(job.target_json), { fresh: true, expected: JSON.parse(job.expected_json ?? '{}'), shouldStop });
          result = await this.step(job, employee, shouldStop, 'base_subscribe', 'subscribe_needed', beforeMutation => this.client.subscribeBase(job.base_token, { beforeMutation }), () => { job.stage = 'welcome_needed'; });
        } else if (job.stage === 'welcome_needed') {
          const url = employee.role === 'sales' ? JSON.parse(job.target_json).baseUrl : this.formUrl();
          if (employee.role === 'sales') await this.auditTarget(employee, JSON.parse(job.target_json), { fresh: true, expected: JSON.parse(job.expected_json ?? '{}'), shouldStop });
          if (job.welcome_url && job.welcome_url !== url) return this.review(job, 'STAFF_WELCOME_URL_CHANGED_REVIEW');
          this.save(job, { welcome_url: url });
          result = await this.step(job, employee, shouldStop, 'welcome_send', 'welcome_needed', beforeMutation => this.client.sendOnboarding(employee, { url: job.welcome_url, clientToken: job.welcome_uuid, beforeMutation }), response => {
            if (typeof response?.messageId !== 'string' || !response.messageId) fail('STAFF_MESSAGE_RESPONSE_INVALID');
            job.stage = 'ready_confirm'; job.message_id = response.messageId;
          });
        } else if (job.stage === 'ready_confirm' || job.stage === 'ready') {
          const target = job.target_json ? JSON.parse(job.target_json) : null;
          if (target) await this.auditTarget(employee, target, { fresh: job.stage !== 'ready', expected: JSON.parse(job.expected_json ?? '{}'), shouldStop });
          await this.guard(employee, shouldStop);
          this.save(job, { stage: 'ready', attempts: 0, next_retry_at: null, error_code: null });
          return target ? { state: 'ready', target } : { state: 'ready', url: job.welcome_url };
        } else return this.review(job, 'STAFF_TASK_STATE_INVALID_REVIEW');
        if (result) return result;
      }
      return this.wait(job, 'STAFF_STEP_LIMIT');
    } catch (error) {
      const code = safe(error);
      if (code.endsWith('_REVIEW')) return this.review(job, code);
      return this.wait(job, code);
    } finally { this.busy = false; }
  }
  status() {
    const counts = {};
    for (const row of this.db.prepare('SELECT stage,COUNT(*) AS count FROM v2_staff_provision_jobs GROUP BY stage').all()) counts[row.stage] = Number(row.count);
    const retry = this.db.prepare("SELECT MIN(next_retry_at) AS nextRetryAt FROM v2_staff_provision_jobs WHERE stage NOT IN ('ready','review')").get();
    return { busy: this.busy, counts, nextRetryAt: retry?.nextRetryAt ?? null };
  }
}
