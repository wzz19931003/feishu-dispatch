import { createHash } from 'node:crypto';
import { validateWorkflowConfig } from './field-map.mjs';

export class StaffRosterError extends Error {
  constructor(code) { super(`员工名单未就绪（${code}）`); this.code = code; }
}
const fail = code => { throw new StaffRosterError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone = value => structuredClone(value);
const safe = error => /^STAFF_[A-Z0-9_]{1,70}$/.test(error?.code || '') ? error.code : 'STAFF_REMOTE_FAILED';
const stop = callback => { try { return Boolean(callback?.()); } catch { return true; } };
const personId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{5,}$/.test(value);
const rowId = value => typeof value === 'string' && /^rec[A-Za-z0-9]+$/.test(value);
const text = value => value == null ? '' : typeof value === 'string' ? value.trim() : Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item?.text || '').join('').trim() : object(value) ? String(value.text ?? value.name ?? '').trim() : String(value).trim();
const TYPES = Object.freeze({ employee: 11, role: 3, enabled: 7, order: 2, notes: 1, status: 1, personalUrl: 1, updatedAt: 1, error: 1, salesWechat: 1, leaveStart: 5, leaveEnd: 5, operatorViewUrl: 1 });
const OPTIONAL_FIELDS = new Set(['salesWechat', 'leaveStart', 'leaveEnd', 'operatorViewUrl']);
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function shanghaiDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) fail('STAFF_LEAVE_RANGE_INVALID');
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function leaveDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value) return value;
    fail('STAFF_LEAVE_RANGE_INVALID');
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value)) fail('STAFF_LEAVE_RANGE_INVALID');
  return shanghaiDay(value);
}
function availability(employee, now) {
  const today = shanghaiDay(now);
  const onLeave = Boolean(employee.leaveStart && employee.leaveEnd && employee.leaveStart <= today && today <= employee.leaveEnd);
  let nextChangeAt = null;
  if (employee.enabled && !employee.leaveError && employee.leaveStart && today <= employee.leaveEnd) {
    nextChangeAt = today < employee.leaveStart ? Date.parse(`${employee.leaveStart}T00:00:00+08:00`) : Date.parse(`${employee.leaveEnd}T00:00:00+08:00`) + 86400_000;
  }
  return { onLeave, effectiveEnabled: employee.enabled && !employee.leaveError && !onLeave, nextChangeAt };
}
const missing = error => String(error?.code || '') === '1254043';
const orderValue = value => {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) fail('STAFF_ORDER_INVALID');
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value <= 0) fail('STAFF_ORDER_INVALID');
  return value;
};
const cell = (record, spec) => spec && Object.hasOwn(record.fields, spec.name) ? record.fields[spec.name] : undefined;
const endpoint = (staff, suffix) => `/open-apis/bitable/v1/apps/${encodeURIComponent(staff.appToken)}/tables/${encodeURIComponent(staff.tableId)}/${suffix}`;

async function pages(client, staff, kind) {
  const rows = [], cursors = new Set(), ids = new Set(); let cursor;
  for (let page = 0; page < 1000; page++) {
    const result = await client.api(endpoint(staff, kind), { method: 'GET', query: { page_size: 100, ...(cursor ? { page_token: cursor } : {}) } });
    const items = Array.isArray(result?.items) ? result.items : result?.total === 0 && result?.has_more === false ? [] : null;
    if (!items || typeof result.has_more !== 'boolean') fail('STAFF_PAGINATION_INVALID');
    for (const item of items) {
      const id = kind === 'records' ? item?.record_id : item?.field_id;
      if (typeof id !== 'string' || !id || ids.has(id)) fail('STAFF_PAGINATION_INVALID');
      ids.add(id); rows.push(item);
    }
    if (!result.has_more) return rows;
    if (typeof result.page_token !== 'string' || !result.page_token || cursors.has(result.page_token)) fail('STAFF_PAGINATION_INVALID');
    cursors.add(result.page_token); cursor = result.page_token;
  }
  fail('STAFF_PAGINATION_INVALID');
}

/** Read-only metadata helper; no database, provisioning or WS dependencies. */
export async function resolveStaffSchema(client, staffConfig) {
  if (!client?.api || !/^[A-Za-z0-9]{10,}$/.test(staffConfig?.appToken || '') || !/^tbl[A-Za-z0-9]{5,}$/.test(staffConfig?.tableId || '') || !object(staffConfig.fields)) fail('STAFF_CONFIG_INVALID');
  const fields = await pages(client, staffConfig, 'fields'), used = new Set(), result = [];
  for (const [key, type] of Object.entries(TYPES)) {
    const definition = staffConfig.fields[key];
    if (!definition && (key === 'notes' || OPTIONAL_FIELDS.has(key))) continue;
    if (!/^fld[A-Za-z0-9]{5,}$/.test(definition?.fieldId || '') || !Array.isArray(definition.types) || definition.types.length !== 1 || definition.types[0] !== type || used.has(definition.fieldId)) fail('STAFF_FIELD_CONFIG_INVALID');
    used.add(definition.fieldId);
    const matches = fields.filter(field => field.field_id === definition.fieldId);
    if (matches.length !== 1 || typeof matches[0].field_name !== 'string' || !matches[0].field_name) fail('STAFF_FIELD_ID_NOT_FOUND');
    const field = matches[0];
    if (field.type !== type || key === 'employee' && field.property?.multiple !== false) fail('STAFF_FIELD_TYPE_CHANGED');
    result.push([key, { fieldId: field.field_id, name: field.field_name, type, ...(key === 'employee' ? { multiple: false } : {}) }]);
  }
  return Object.fromEntries(result);
}

export class StaffRoster {
  constructor({ config, db, client, provisioner, assertLiveConfig = async () => {}, now = Date.now } = {}) {
    if (!config?.staffManagement?.enabled || !db?.prepare || !client?.api || typeof assertLiveConfig !== 'function') fail('STAFF_ARGUMENTS_INVALID');
    this.config = config; this.staff = config.staffManagement; this.db = db; this.client = client; this.provisioner = provisioner; this.now = now;
    this.assertLiveConfig = assertLiveConfig;
    this.healthy = false; this.errors = []; this.counts = {}; this.retryAt = null; this.busy = false;
    db.exec('CREATE TABLE IF NOT EXISTS v2_staff_roster_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS v2_staff_registry(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
    const coreFields = Object.fromEntries(Object.entries(this.staff.fields).filter(([key]) => !OPTIONAL_FIELDS.has(key)));
    const binding = hash([config.appId, config.appToken, config.tableIds.leads, this.staff.appToken, this.staff.tableId, coreFields]);
    if (this.meta('binding') && this.meta('binding') !== binding) fail('STAFF_DATABASE_BINDING_MISMATCH');
    this.setMeta('binding', binding);
    const optionalBindings = this.meta('optional_field_bindings') || {};
    for (const key of OPTIONAL_FIELDS) {
      const field = this.staff.fields[key];
      if (optionalBindings[key] && (!field || hash(optionalBindings[key]) !== hash(field))) fail('STAFF_OPTIONAL_FIELD_BINDING_CHANGED');
      if (field) optionalBindings[key] = clone(field);
    }
    this.setMeta('optional_field_bindings', optionalBindings);
    this.bootstrap();
  }
  stamp() { return new Date(this.now()).toISOString(); }
  meta(key) { const row = this.db.prepare('SELECT value FROM v2_staff_roster_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO v2_staff_roster_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  registry() { return this.db.prepare('SELECT data FROM v2_staff_registry ORDER BY id').all().map(row => JSON.parse(row.data)); }
  put(entry) { this.db.prepare('INSERT INTO v2_staff_registry(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(entry.id, JSON.stringify(entry)); }
  hasTable(table) { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
  historicalName(id, openId) {
    if (this.hasTable('v2_mirrors')) for (const row of this.db.prepare('SELECT data FROM v2_mirrors').all()) {
      const value = JSON.parse(row.data); if ((value.memberId === id || value.owner === openId) && text(value.baseValues?.salesName)) return text(value.baseValues.salesName);
    }
    if (this.hasTable('v2_snapshots')) for (const row of this.db.prepare('SELECT data FROM v2_snapshots').all()) {
      const value = JSON.parse(row.data); if (value.view?.owner === openId && text(value.view.salesName)) return text(value.view.salesName);
    }
    return '历史销售（待核姓名）';
  }
  validateTarget(member) {
    try {
      const normalized = validateWorkflowConfig({ ...this.config, members: [member] }).members[0].target;
      if (!normalized || normalized.appToken === this.staff.appToken) fail('STAFF_TARGET_INVALID');
      return normalized;
    } catch { fail('STAFF_TARGET_INVALID'); }
  }
  bootstrap() {
    let pins = {};
    if (this.hasTable('v2_meta')) {
      const raw = this.db.prepare("SELECT value FROM v2_meta WHERE key='member_pins'").get(); if (raw) pins = JSON.parse(raw.value);
    }
    const seeds = new Map((this.config.members || []).map(member => [member.id, member]));
    for (const pin of Object.values(pins)) {
      const seed = seeds.get(pin.id);
      if (seed && (seed.openId !== pin.openId || hash(seed.target) !== hash(pin.target))) fail('STAFF_MEMBER_BINDING_CHANGED');
      if (!seed) seeds.set(pin.id, { ...pin, displayName: this.historicalName(pin.id, pin.openId), order: Number.MAX_SAFE_INTEGER, enabled: false });
    }
    for (const member of seeds.values()) {
      const target = this.validateTarget(member), previous = this.registry().find(entry => entry.id === member.id || entry.openId === member.openId);
      if (previous) {
        if (previous.id !== member.id || previous.openId !== member.openId || previous.role !== 'sales' || hash(previous.target) !== hash(target)) fail('STAFF_MEMBER_BINDING_CHANGED');
        continue;
      }
      if (this.registry().some(entry => entry.target?.appToken === target.appToken)) fail('STAFF_TARGET_DUPLICATE');
      this.put({ id: member.id, recordId: null, openId: member.openId, displayName: member.displayName, role: 'sales', enabled: false, order: member.order, target, seeded: true, ready: true, state: 'awaiting_roster', inputVersion: null, checkedVersion: null, retired: false });
    }
  }
  normalize(record, resolved) {
    if (!rowId(record?.record_id) || !object(record.fields)) fail('STAFF_RECORD_INVALID');
    const known = this.registry().find(entry => entry.recordId === record.record_id);
    const rawEnabled = cell(record, resolved.enabled);
    if (rawEnabled != null && typeof rawEnabled !== 'boolean') fail('STAFF_ENABLED_INVALID');
    const enabled = rawEnabled === true;
    try {
      const rawPerson = cell(record, resolved.employee), people = rawPerson == null ? [] : rawPerson;
      if (!Array.isArray(people) || people.length !== 1 || !personId(people[0]?.id ?? people[0]?.open_id)) fail('STAFF_PERSON_INVALID');
      const openId = people[0].id ?? people[0].open_id, byPerson = this.registry().find(entry => entry.openId === openId);
      const displayName = text(people[0].name) || known?.displayName || byPerson?.displayName;
      if (!displayName || displayName.length > 200) fail('STAFF_NAME_REQUIRED');
      const roleValue = text(cell(record, resolved.role)), role = roleValue === '销售' ? 'sales' : roleValue === '运营' ? 'operator' : null;
      if (!role) fail('STAFF_ROLE_INVALID');
      const order = orderValue(cell(record, resolved.order));
      if (enabled && role === 'sales' && order === null) fail('STAFF_ORDER_INVALID');
      if (known && (known.openId !== openId || known.role !== role)) fail('STAFF_MEMBER_BINDING_CHANGED');
      const version = hash([record.record_id, openId, role, enabled, order]);
      let salesWechat = text(cell(record, resolved.salesWechat)), salesWechatError = '';
      if (role === 'sales' && (salesWechat.length > 80 || /[\u0000-\u001f\u007f]/.test(salesWechat))) {
        salesWechat = ''; salesWechatError = 'STAFF_SALES_WECHAT_INVALID';
      }
      let leaveStart = '', leaveEnd = '', leaveError = '';
      try {
        leaveStart = leaveDate(cell(record, resolved.leaveStart));
        leaveEnd = leaveDate(cell(record, resolved.leaveEnd));
        if (Boolean(leaveStart) !== Boolean(leaveEnd) || leaveStart > leaveEnd) fail('STAFF_LEAVE_RANGE_INVALID');
      } catch (error) { leaveError = safe(error); }
      const profileVersion = hash([salesWechat, salesWechatError, leaveStart, leaveEnd, leaveError]);
      const employee = { recordId: record.record_id, openId, displayName, role, enabled, order, version, salesWechat, salesWechatError, leaveStart, leaveEnd, leaveError, profileVersion,
        seeded: (this.staff.seedRecordIds || []).includes(record.record_id) || Boolean(known?.seeded || byPerson?.seeded) };
      return { ...employee, ...availability(employee, this.now()) };
    } catch (error) {
      if (!known && !enabled) return null;
      throw error;
    }
  }
  async readDetailed(recordId) {
    if (!rowId(recordId)) fail('STAFF_RECORD_ID_INVALID');
    const before = await resolveStaffSchema(this.client, this.staff); let result;
    try { result = await this.client.api(endpoint(this.staff, `records/${encodeURIComponent(recordId)}`), { method: 'GET' }); }
    catch (error) { if (missing(error)) return null; throw new StaffRosterError(safe(error)); }
    const record = result?.record ?? result;
    if (record?.record_id !== recordId) fail('STAFF_RECORD_INVALID');
    const after = await resolveStaffSchema(this.client, this.staff);
    if (hash(before) !== hash(after)) fail('STAFF_SCHEMA_CHANGED_DURING_READ');
    return { employee: this.normalize(record, after), record, resolved: after };
  }
  async readCurrent(recordId) { return (await this.readDetailed(recordId))?.employee || null; }
  configForMembers() {
    const members = this.registry().filter(entry => entry.role === 'sales').map(entry => ({ id: entry.id, openId: entry.openId, displayName: entry.displayName, order: entry.order,
      enabled: this.healthy && entry.ready && !entry.retired && availability(entry, this.now()).effectiveEnabled, salesWechat: entry.salesWechat || '', target: clone(entry.target) }));
    return { ...this.config, members };
  }
  operatorCandidates() {
    if (!this.healthy || !this.staff.operatorViews?.enabled || !this.staff.fields.operatorViewUrl) return [];
    return this.registry().filter(entry => entry.role === 'operator' && entry.ready && !entry.retired && availability(entry, this.now()).effectiveEnabled)
      .map(entry => ({ recordId: entry.recordId, openId: entry.openId, displayName: entry.displayName, version: entry.inputVersion, seeded: entry.seeded, enabled: true }));
  }
  async recordOperatorViewUrls(readyUrls, { shouldStop = () => false } = {}) {
    const result = { updated: 0, skipped: 0, errors: [] };
    if (!Array.isArray(readyUrls)) fail('STAFF_OPERATOR_URLS_INVALID');
    if (!this.config.enabled || !this.config.notification?.enabled || !this.staff.operatorViews?.enabled || !this.staff.fields.operatorViewUrl) return result;
    for (const item of readyUrls) {
      if (stop(shouldStop)) break;
      try {
        let url;
        try { url = new URL(item?.url); } catch { fail('STAFF_OPERATOR_URL_INVALID'); }
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn') || url.username || url.password || url.hash || !/^\/base\/[A-Za-z0-9]{10,}\/?$/.test(url.pathname)) fail('STAFF_OPERATOR_URL_INVALID');
        const candidate = this.operatorCandidates().find(employee => employee.recordId === item.recordId && employee.openId === item.openId);
        if (!candidate) { result.skipped++; continue; }
        const current = await this.readCurrent(candidate.recordId);
        if (!current || current.openId !== candidate.openId || current.role !== 'operator' || !current.effectiveEnabled || current.version !== candidate.version) { result.skipped++; continue; }
        const changed = await this.writeSystem(current, { operatorViewUrl: url.href }, shouldStop);
        if (changed) result.updated++; else result.skipped++;
      } catch (error) { result.errors.push({ code: safe(error) }); }
    }
    return result;
  }
  async verifyCandidate(member) {
    if (!this.healthy || !member?.enabled) return false;
    const registered = this.registry().find(entry => entry.id === member.id);
    if (!registered?.recordId || !registered.ready || !registered.enabled || registered.retired || registered.openId !== member.openId || hash(registered.target) !== hash(member.target)) return false;
    const current = await this.readCurrent(registered.recordId);
    return Boolean(current?.effectiveEnabled && current.role === 'sales' && current.openId === registered.openId && current.version === registered.inputVersion);
  }
  status() { return { healthy: this.healthy, counts: { ...this.counts }, errors: [...this.errors], nextRetryAt: this.retryAt }; }
  close() {}
  async checkLiveConfig() { try { await this.assertLiveConfig(); } catch { fail('STAFF_LIVE_CONFIG_CHANGED'); } }
  async writeSystem(employee, desired, shouldStop) {
    if (stop(shouldStop)) fail('STAFF_STOP_REQUESTED');
    const latest = await this.readDetailed(employee.recordId);
    if (!latest?.employee || latest.employee.version !== employee.version || latest.employee.openId !== employee.openId || latest.employee.enabled !== employee.enabled
      || latest.employee.profileVersion !== employee.profileVersion || latest.employee.effectiveEnabled !== employee.effectiveEnabled) fail('STAFF_SNAPSHOT_CHANGED');
    const patch = [];
    for (const [key, value] of Object.entries(desired)) if (text(cell(latest.record, latest.resolved[key])) !== value) patch.push([latest.resolved[key].name, value]);
    if (!patch.length) return false;
    patch.push([latest.resolved.updatedAt.name, this.stamp()]);
    if (stop(shouldStop)) fail('STAFF_STOP_REQUESTED');
    await this.checkLiveConfig();
    if (stop(shouldStop)) fail('STAFF_STOP_REQUESTED');
    await this.client.api(endpoint(this.staff, `records/${encodeURIComponent(employee.recordId)}`), { method: 'PUT', body: { fields: Object.fromEntries(patch) } });
    return true;
  }
  async refresh({ apply = false, shouldStop = () => false } = {}) {
    this.healthy = false; this.errors = []; this.retryAt = null;
    if (this.busy) { this.errors = ['STAFF_REFRESH_BUSY']; return { ok: false, errors: this.errors.map(code => ({ code })) }; }
    this.busy = true;
    try {
      if (apply === true) await this.checkLiveConfig();
      if (stop(shouldStop)) fail('STAFF_STOP_REQUESTED');
      const before = await resolveStaffSchema(this.client, this.staff), records = await pages(this.client, this.staff, 'records');
      if (hash(before) !== hash(await resolveStaffSchema(this.client, this.staff))) fail('STAFF_SCHEMA_CHANGED_DURING_SCAN');
      if (!records.length) fail('STAFF_EMPTY_ROSTER');
      const snapshot = [], identities = new Set(), orders = new Set(); let drafts = 0;
      for (const record of records) {
        const employee = this.normalize(record, before), knownRow = this.registry().find(entry => entry.recordId === record.record_id);
        if (!employee || !employee.enabled && !knownRow && !this.registry().some(entry => entry.recordId === null && entry.openId === employee.openId)) { drafts++; continue; }
        if (identities.has(employee.openId)) fail('STAFF_IDENTITY_DUPLICATE'); identities.add(employee.openId);
        const knownPerson = this.registry().find(entry => entry.openId === employee.openId);
        if (knownPerson && knownPerson.recordId !== null && knownPerson.recordId !== employee.recordId) fail('STAFF_IDENTITY_RECREATED');
        if (knownPerson && knownPerson.role !== employee.role) fail('STAFF_MEMBER_BINDING_CHANGED');
        if (employee.enabled && employee.role === 'sales') { if (orders.has(employee.order)) fail('STAFF_ORDER_DUPLICATE'); orders.add(employee.order); }
        snapshot.push(employee);
      }
      const active = new Set(snapshot.map(employee => employee.recordId));
      for (const entry of this.registry()) if (!active.has(entry.recordId)) this.put({ ...entry, enabled: false, retired: true, state: 'retired' });
      const canWrite = apply === true && this.config.enabled === true && this.config.notification?.enabled === true;
      const counts = { rows: records.length, drafts, ready: 0, pending: 0, review: 0, disabled: 0, paused: 0, retired: this.registry().filter(entry => entry.retired).length };
      for (const employee of snapshot) {
        if (stop(shouldStop)) fail('STAFF_STOP_REQUESTED');
        let entry = this.registry().find(item => item.openId === employee.openId), result, verified = false;
        const profile = { salesWechat: employee.salesWechat, salesWechatError: employee.salesWechatError, leaveStart: employee.leaveStart, leaveEnd: employee.leaveEnd, leaveError: employee.leaveError, profileVersion: employee.profileVersion };
        if (entry) entry = { ...entry, ...profile, recordId: employee.recordId, displayName: employee.displayName, enabled: employee.enabled, order: employee.order ?? entry.order, inputVersion: employee.version, retired: false };
        if (employee.salesWechatError) this.errors.push(employee.salesWechatError);
        if (Number.isSafeInteger(employee.nextChangeAt) && employee.nextChangeAt > this.now()) this.retryAt = this.retryAt === null ? employee.nextChangeAt : Math.min(this.retryAt, employee.nextChangeAt);
        if (employee.leaveError) {
          if (entry) this.put({ ...entry, state: 'review' });
          counts.review++; this.errors.push(employee.leaveError);
          if (canWrite) await this.writeSystem(employee, { status: '需核查', error: employee.leaveError }, shouldStop);
          continue;
        }
        if (!employee.enabled) {
          if (entry) { entry.state = 'disabled'; this.put(entry); } counts.disabled++;
          if (employee.salesWechatError) counts.review++;
          if (canWrite) await this.writeSystem(employee, { status: '已停新单', error: employee.salesWechatError }, shouldStop);
          continue;
        }
        if (employee.onLeave) {
          if (entry) this.put({ ...entry, state: 'paused' });
          counts.paused++;
          if (employee.salesWechatError) counts.review++;
          if (canWrite) await this.writeSystem(employee, { status: '休假中', error: employee.salesWechatError }, shouldStop);
          continue;
        }
        if (canWrite && (!entry?.ready || entry.checkedVersion !== employee.version)) {
          if (!this.provisioner?.ensure) fail('STAFF_PROVISIONER_REQUIRED');
          try { result = await this.provisioner.ensure({ ...employee, ...(entry?.target ? { target: clone(entry.target) } : {}) }, { apply: true, shouldStop }); }
          catch (error) { if (stop(shouldStop)) fail('STAFF_STOP_REQUESTED'); result = { state: 'review', errorCode: safe(error) }; }
          const current = await this.readCurrent(employee.recordId);
          if (!current || current.version !== employee.version || current.profileVersion !== employee.profileVersion || !current.effectiveEnabled) fail('STAFF_SNAPSHOT_CHANGED');
          if (!['ready', 'pending', 'review'].includes(result?.state)) fail('STAFF_PROVISION_RESULT_INVALID');
          verified = result.state === 'ready';
          if (Number.isSafeInteger(result.nextRetryAt) && result.nextRetryAt > 0) this.retryAt = this.retryAt === null ? result.nextRetryAt : Math.min(this.retryAt, result.nextRetryAt);
        } else result = { state: entry?.ready ? 'ready' : 'pending', ...(entry?.target ? { target: entry.target } : {}) };
        let code = result.errorCode ? safe({ code: result.errorCode }) : employee.salesWechatError;
        if (result.state === 'ready') {
          const id = entry?.id || `staff_${employee.recordId}`;
          const target = employee.role === 'sales' ? this.validateTarget({ id, openId: employee.openId, displayName: employee.displayName, order: employee.order, enabled: true, target: result.target }) : null;
          if (entry?.target && hash(entry.target) !== hash(target)) fail('STAFF_MEMBER_BINDING_CHANGED');
          if (target && this.registry().some(other => other.id !== id && other.target?.appToken === target.appToken)) fail('STAFF_TARGET_DUPLICATE');
          entry = { ...(entry || {}), ...profile, id, recordId: employee.recordId, openId: employee.openId, displayName: employee.displayName, role: employee.role, enabled: true, order: employee.order ?? 1, target, inputVersion: employee.version, checkedVersion: verified ? employee.version : entry?.checkedVersion ?? null, seeded: employee.seeded, ready: true, state: 'ready', retired: false };
          this.put(entry); counts.ready++;
          if (employee.salesWechatError) counts.review++;
        } else {
          counts[result.state]++; if (code) this.errors.push(code);
          if (entry) this.put({ ...entry, enabled: false, state: result.state });
        }
        if (canWrite) await this.writeSystem(employee, { status: result.state === 'ready' ? employee.salesWechatError ? '需核查' : '可用' : result.state === 'review' ? '需核查' : '准备中', error: code, ...(result.state === 'ready' ? { personalUrl: employee.role === 'sales' ? entry.target.baseUrl : this.staff.operatorFormUrl } : {}) }, shouldStop);
      }
      counts.retired = this.registry().filter(entry => entry.retired).length;
      this.counts = counts; this.healthy = true; this.errors = [...new Set(this.errors)];
      this.setMeta('last_refresh', { at: this.stamp(), counts, healthy: true });
      return { ok: this.errors.length === 0, errors: this.errors.map(code => ({ code })), ...(this.retryAt !== null ? { nextRetryAt: this.retryAt } : {}) };
    } catch (error) {
      const code = safe(error); this.healthy = false; this.errors = [code]; this.retryAt = this.now() + 60_000;
      this.counts = { ...this.counts, registered: this.registry().length };
      return { ok: false, errors: [{ code }], nextRetryAt: this.retryAt };
    } finally { this.busy = false; }
  }
}
