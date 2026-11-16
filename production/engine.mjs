import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { FeishuClient } from '../lib/feishu.mjs';

export class ProductionError extends Error {
  constructor(code) { super(`正式派单检查未通过（${code}）`); this.code = code; }
}
const fail = code => { throw new ProductionError(code); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = () => new Date().toISOString();
const text = value => value == null ? '' : Array.isArray(value) ? value.map(text).join('') : typeof value === 'object' ? String(value.text ?? value.name ?? '') : String(value);
const entries = value => Array.isArray(value) ? value.flatMap(entries) : value == null || value === '' ? [] : [text(value).trim()].filter(Boolean);
const people = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(v => typeof v === 'object' && v ? v.id || v.open_id || '' : '');
const openId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{5,}$/.test(value);
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'REMOTE_ERROR';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const runtimeBinding = config => { const { members, ...rest } = config; return hash(canonical(rest)); };
function slotValue(value) {
  const raw = text(value).trim();
  if (!/^-?\d+$/.test(raw)) fail('SLOT_INVALID');
  const slot = Number(raw);
  if (!Number.isSafeInteger(slot)) fail('SLOT_INVALID');
  return slot;
}
function localStaff(config) {
  return { members: config.members.map(member => ({ recordId: member.id, openId: member.openId, enabled: member.enabled, sales: true, domains: [domain(config, config.defaultDomain)], rank: member.slot, slot: member.slot })), errors: [] };
}

/** Pure validation. The caller controls where the credential file is stored. */
export function validateConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('CONFIG_INVALID');
  if (!/^cli_[A-Za-z0-9_-]{5,}$/.test(raw.appId || '') || !nonempty(raw.appSecret) || raw.appSecret.trim().length < 10) fail('CREDENTIALS_REQUIRED');
  if (!/^[A-Za-z0-9]{10,}$/.test(raw.appToken || '')) fail('BASE_INVALID');
  let base;
  try { base = new URL(raw.baseUrl); } catch { fail('BASE_URL_INVALID'); }
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.feishu.cn') || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, '') !== `/base/${raw.appToken}`) fail('BASE_URL_INVALID');
  const staffSource = raw.staffSource || 'table', assignment = { ...raw.assignment, mode: raw.assignment?.mode || 'round_robin' };
  if (!['table', 'config'].includes(staffSource) || !['round_robin', 'slot'].includes(assignment.mode)) fail('ASSIGNMENT_MODE_INVALID');
  if (staffSource === 'config' && (raw.assignment?.mode !== 'slot' || !nonempty(raw.defaultDomain))) fail('LOCAL_STAFF_MODE_INVALID');
  const resources = staffSource === 'config' ? ['leads'] : ['leads', 'staff'];
  if (!raw.tableIds || !resources.every(key => /^tbl[A-Za-z0-9]{5,}$/.test(raw.tableIds[key] || '')) || (staffSource === 'table' && raw.tableIds.leads === raw.tableIds.staff)) fail('TABLES_INVALID');
  const fields = structuredClone(raw.fields || {});
  const requiredFields = { leads: ['owner', ...(assignment.mode === 'slot' ? ['slot'] : [])], ...(staffSource === 'table' ? { staff: ['member', 'role', 'domains', 'enabled', ...(assignment.mode === 'slot' ? ['slot'] : [])] } : {}) };
  if (!nonempty(fields.leads?.domain) && !nonempty(raw.defaultDomain)) fail('DEFAULT_DOMAIN_REQUIRED');
  for (const [resource, keys] of Object.entries(requiredFields)) {
    if (!fields[resource] || !keys.every(key => nonempty(fields[resource][key]))) fail('FIELDS_REQUIRED');
    const values = Object.values(fields[resource]).filter(Boolean);
    if (values.some(value => !nonempty(value)) || new Set(values).size !== values.length) fail('FIELDS_INVALID');
  }
  const requiredLeadFields = raw.requiredLeadFields === undefined ? [] : raw.requiredLeadFields;
  if (!Array.isArray(requiredLeadFields) || new Set(requiredLeadFields).size !== requiredLeadFields.length || requiredLeadFields.some(key => !['wx', 'needs'].includes(key) || !nonempty(fields.leads[key]))) fail('REQUIRED_LEAD_FIELDS_INVALID');
  let members;
  if (staffSource === 'config') {
    if (!Array.isArray(raw.members) || !raw.members.length) fail('MEMBERS_REQUIRED');
    const ids = new Set(), identities = new Set(), slots = new Set();
    members = raw.members.map(member => {
      if (!member || typeof member !== 'object' || !/^[A-Za-z0-9_-]{1,80}$/.test(member.id || '') || !nonempty(member.displayName) || !openId(member.openId) || typeof member.enabled !== 'boolean' || !Number.isSafeInteger(member.slot)) fail('MEMBER_INVALID');
      if (ids.has(member.id) || identities.has(member.openId)) fail('MEMBER_DUPLICATE');
      if (member.enabled && slots.has(member.slot)) fail('MEMBER_SLOT_AMBIGUOUS');
      ids.add(member.id); identities.add(member.openId); if (member.enabled) slots.add(member.slot);
      return { id: member.id, displayName: member.displayName, openId: member.openId, enabled: member.enabled, slot: member.slot };
    });
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail('ENABLED_INVALID');
  if (raw.notification?.enabled !== undefined && typeof raw.notification.enabled !== 'boolean') fail('NOTIFICATION_INVALID');
  if (raw.salesRole !== undefined && !nonempty(raw.salesRole)) fail('SALES_ROLE_INVALID');
  if (raw.dispatchAssignedValue !== undefined && !nonempty(raw.dispatchAssignedValue)) fail('ASSIGNED_VALUE_INVALID');
  if (raw.notification?.title !== undefined && (!nonempty(raw.notification.title) || raw.notification.title.length > 300)) fail('NOTIFICATION_TITLE_INVALID');
  const domainAliases = raw.domainAliases || {};
  if (!domainAliases || typeof domainAliases !== 'object' || Array.isArray(domainAliases) || Object.entries(domainAliases).some(([a, b]) => !nonempty(a) || !nonempty(b))) fail('DOMAINS_INVALID');
  return { ...raw, enabled: raw.enabled === true, appSecret: raw.appSecret.trim(), baseUrl: base.href.replace(/\/$/, ''), tableIds: Object.fromEntries(resources.map(key => [key, raw.tableIds[key]])), fields, staffSource, assignment, requiredLeadFields: [...requiredLeadFields], ...(raw.defaultDomain ? { defaultDomain: raw.defaultDomain.trim() } : {}), ...(members ? { members } : {}),
    salesRole: raw.salesRole || '销售', dispatchAssignedValue: raw.dispatchAssignedValue || '已分配', domainAliases: { ...domainAliases },
    notification: { ...raw.notification, enabled: raw.notification?.enabled === true, title: raw.notification?.title || '新客资待跟进' } };
}

async function readPages(client, apiPath) {
  const items = [], seen = new Set(); let cursor;
  do {
    const page = await client.api(apiPath, { method: 'GET', query: { page_size: 100, ...(cursor ? { page_token: cursor } : {}) } });
    if (!Array.isArray(page.items)) fail('METADATA_INVALID');
    items.push(...page.items);
    if (!page.has_more) break;
    if (!nonempty(page.page_token) || seen.has(page.page_token) || seen.size > 1000) fail('PAGINATION_INVALID');
    cursor = page.page_token; seen.add(cursor);
  } while (true);
  return items;
}
async function readRecords(client, tableId) {
  const items = [], seen = new Set(), ids = new Set(); let cursor;
  do {
    const page = await client.listRecords(tableId, { pageSize: 100, ...(cursor ? { pageToken: cursor } : {}) });
    if (!Array.isArray(page.items)) fail('RECORDS_INVALID');
    for (const record of page.items) {
      const id = record.record_id || record.recordId;
      if (!nonempty(id) || ids.has(id)) fail('RECORD_ID_INVALID');
      ids.add(id); items.push({ ...record, record_id: id });
    }
    if (!page.hasMore) break;
    if (!nonempty(page.pageToken) || seen.has(page.pageToken) || seen.size > 1000) fail('PAGINATION_INVALID');
    cursor = page.pageToken; seen.add(cursor);
  } while (true);
  return items;
}
const domain = (config, value) => { const source = text(value).trim(); return Object.hasOwn(config.domainAliases, source) ? config.domainAliases[source] : source; };
function staffSnapshot(config, records) {
  const map = config.fields.staff, members = [], errors = [], seen = new Set();
  for (const record of records) {
    const fields = record.fields || {}, ids = people(fields[map.member]);
    const roles = entries(fields[map.role]), enabled = fields[map.enabled] === true;
    if (ids.length !== 1 || !openId(ids[0])) { errors.push({ code: 'STAFF_IDENTITY_INVALID' }); continue; }
    if (seen.has(ids[0])) { errors.push({ code: 'STAFF_IDENTITY_DUPLICATE' }); continue; }
    seen.add(ids[0]);
    const domains = [...new Set(entries(fields[map.domains]).map(value => domain(config, value)).filter(Boolean))];
    const rank = map.rank && fields[map.rank] != null && fields[map.rank] !== '' ? Number(fields[map.rank]) : 0;
    if (!Number.isFinite(rank) || rank < 0 || (enabled && roles.includes(config.salesRole) && !domains.length)) { errors.push({ code: 'STAFF_CONFIGURATION_INVALID' }); continue; }
    let slot = null;
    try { if (config.assignment.mode === 'slot') slot = slotValue(fields[map.slot]); } catch { errors.push({ code: 'STAFF_SLOT_INVALID' }); continue; }
    members.push({ recordId: record.record_id, openId: ids[0], enabled, sales: roles.includes(config.salesRole), domains, rank, slot });
  }
  return { members, errors };
}

/** Reads schemas and personnel only. Never returns member IDs, names or secrets. */
export async function inspect(client, raw, { staff: providedStaff } = {}) {
  const config = validateConfig(raw), report = { ok: false, readOnly: true, errors: [], tables: {}, staff: { total: 0, activeSales: 0 } };
  const root = `/open-apis/bitable/v1/apps/${encodeURIComponent(config.appToken)}/tables`;
  try {
    const tables = await readPages(client, root);
    for (const resource of config.staffSource === 'config' ? ['leads'] : ['leads', 'staff']) {
      if (!tables.some(t => t.table_id === config.tableIds[resource])) { report.errors.push({ code: 'TABLE_NOT_FOUND', resource }); continue; }
      const schema = await readPages(client, `${root}/${encodeURIComponent(config.tableIds[resource])}/fields`);
      report.tables[resource] = { fieldCount: schema.length };
      for (const [key, name] of Object.entries(config.fields[resource])) {
        if (!name) continue;
        const matches = schema.filter(f => f.field_name === name);
        if (matches.length !== 1) { report.errors.push({ code: 'FIELD_NOT_UNIQUE', resource, key }); continue; }
        const field = matches[0], type = Number(field.type);
        if ((resource === 'leads' && ['owner', 'designated'].includes(key)) || (resource === 'staff' && key === 'member')) {
          if (type !== 11 || field.property?.multiple !== false) report.errors.push({ code: 'SINGLE_PERSON_REQUIRED', resource, key });
        } else if (resource === 'staff' && key === 'enabled' && type !== 7) report.errors.push({ code: 'CHECKBOX_REQUIRED', resource, key });
        else if (resource === 'staff' && key === 'rank' && type !== 2) report.errors.push({ code: 'NUMBER_REQUIRED', resource, key });
        else if (key === 'slot' && ![1, 2, 3, 20].includes(type)) report.errors.push({ code: 'SLOT_FIELD_INVALID', resource, key });
        else if (resource === 'leads' && config.requiredLeadFields.includes(key) && type !== 1) report.errors.push({ code: 'TEXT_FIELD_REQUIRED', resource, key });
        else if (['domain', 'domains', 'role'].includes(key) && ![1, 3, 4].includes(type)) report.errors.push({ code: 'SCALAR_REQUIRED', resource, key });
        else if (resource === 'leads' && key === 'dispatch') {
          if (![1, 3].includes(type)) report.errors.push({ code: 'WRITABLE_STATUS_REQUIRED', resource, key });
          if (type === 3 && !field.property?.options?.some(option => option.name === config.dispatchAssignedValue)) report.errors.push({ code: 'ASSIGNED_OPTION_REQUIRED', resource, key });
        }
      }
    }
    const staff = providedStaff || (config.staffSource === 'config' ? localStaff(config) : staffSnapshot(config, await readRecords(client, config.tableIds.staff)));
    report.staff = { source: config.staffSource, total: staff.members.length, activeSales: staff.members.filter(m => m.enabled && m.sales).length };
    report.errors.push(...staff.errors);
    if (!report.staff.activeSales) report.errors.push({ code: 'NO_ACTIVE_SALES' });
  } catch (error) { report.errors.push({ code: safeCode(error) }); }
  report.ok = report.errors.length === 0;
  return report;
}

/** Single-host durable dispatcher. No remote writes happen without scan({apply:true}). */
export class ProductionDispatcher {
  constructor(raw, { client, dbPath, now = Date.now, memberProvider } = {}) {
    this.config = validateConfig(raw); this.client = client || new FeishuClient(this.config); this.now = now; this.memberProvider = memberProvider;
    this.runtimeBinding = runtimeBinding(this.config);
    const filename = dbPath || raw.dbPath || 'data/production.sqlite';
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename); this.closed = false; this.inFlight = null;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS production_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS production_rows (id TEXT PRIMARY KEY,data TEXT NOT NULL);');
    const binding = hash(canonical([this.config.appId, this.config.appToken, this.config.baseUrl, this.config.tableIds, this.config.fields, this.config.staffSource, this.config.assignment, this.config.defaultDomain || '']));
    if (this.meta('binding') && this.meta('binding') !== binding) { this.db.close(); fail('DATABASE_BINDING_MISMATCH'); }
    this.setMeta('binding', binding);
    // An interrupted send may already have reached Feishu. Never resend it blindly.
    for (const item of this.rows()) if (item.state === 'notification_sending') this.put({ ...item, state: 'notification_review', errorCode: 'SEND_OUTCOME_UNKNOWN' });
  }
  meta(key) { const row = this.db.prepare('SELECT value FROM production_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO production_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  rows() { return this.db.prepare('SELECT data FROM production_rows ORDER BY id').all().map(r => JSON.parse(r.data)); }
  get(id) { const row = this.db.prepare('SELECT data FROM production_rows WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  put(row) { this.db.prepare('INSERT INTO production_rows(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id, JSON.stringify({ ...row, updatedAt: iso() })); }
  transaction(callback) { this.db.exec('BEGIN IMMEDIATE'); try { const result = callback(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  async readStaff() {
    if (this.config.staffSource !== 'config') return staffSnapshot(this.config, await readRecords(this.client, this.config.tableIds.staff));
    let config = this.config;
    if (this.memberProvider) {
      try { config = validateConfig(await this.memberProvider()); } catch { fail('MEMBERS_REFRESH_FAILED'); }
      if (runtimeBinding(config) !== this.runtimeBinding) fail('LIVE_CONFIG_BINDING_CHANGED');
    }
    return localStaff(config);
  }
  async initialize() {
    if (this.closed) fail('DISPATCHER_CLOSED');
    if (this.inFlight) fail('DISPATCHER_BUSY');
    if (this.meta('initialized')) return { ok: true, alreadyInitialized: true, ...this.status() };
    const checked = await inspect(this.client, this.config);
    if (!checked.ok) return { ok: false, inspection: checked };
    const records = await readRecords(this.client, this.config.tableIds.leads), f = this.config.fields.leads;
    this.transaction(() => {
      for (const record of records) {
        const ids = people(record.fields?.[f.owner]);
        const validOwner = ids.length === 1 && openId(ids[0]);
        this.put({ id: record.record_id, state: validOwner ? 'baseline_assigned' : ids.length ? 'review' : 'historical_review', errorCode: ids.length && !validOwner ? 'OWNER_INVALID' : '', baselineAt: iso() });
      }
      this.setMeta('initialized', { at: iso(), baselineCount: records.length });
    });
    return { ok: true, ...this.status() };
  }
  scan(options = {}) {
    if (this.closed) return Promise.reject(new ProductionError('DISPATCHER_CLOSED'));
    if (this.inFlight) return Promise.reject(new ProductionError('DISPATCHER_BUSY'));
    this.inFlight = this.runScan(options).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async runScan({ apply = false, shouldStop = () => false } = {}) {
    if (!this.meta('initialized')) fail('INITIALIZATION_REQUIRED');
    if (apply && !this.config.enabled) fail('PRODUCTION_DISABLED');
    if (typeof shouldStop !== 'function') fail('STOP_CALLBACK_INVALID');
    const stopped = () => { try { return Boolean(shouldStop()); } catch { return true; } };
    const staff = await this.readStaff();
    const inspection = await inspect(this.client, this.config, { staff });
    const schemaErrors = inspection.errors.filter(error => error.code !== 'NO_ACTIVE_SALES');
    if (schemaErrors.length) return { ok: false, apply, errors: schemaErrors, counts: {}, plans: [] };
    const records = await readRecords(this.client, this.config.tableIds.leads);
    if (staff.errors.length) return { ok: false, apply, errors: staff.errors, counts: {}, plans: [] };
    const plans = [], cursors = new Map();
    for (const record of records) {
      if (stopped()) break;
      let plan;
      try { plan = this.plan(record, staff.members, cursors); }
      catch (error) { plan = { recordId: record.record_id, action: 'review', reason: safeCode(error) }; }
      plans.push(plan);
      if (!apply) continue;
      try { await this.applyRecord(record, staff.members, plan, { shouldStop: stopped }); }
      catch (error) {
        const existing = this.get(record.record_id);
        if (existing && ['notification_review', 'review', 'failed'].includes(existing.state)) continue;
        const attempts = (existing?.attempts || 0) + 1;
        this.put({ ...(existing || { id: record.record_id }), state: existing?.state || 'review', attempts, nextAttemptAt: this.now() + Math.min(300_000, 2000 * 2 ** Math.min(attempts, 8)), errorCode: safeCode(error) });
      }
    }
    if (apply && !stopped()) {
      const present = new Set(records.map(record => record.record_id));
      for (const row of this.rows()) if (!present.has(row.id) && ['awaiting_details', 'awaiting_sales', 'dispatch_pending', 'owner_written', 'notification_pending'].includes(row.state)) this.put({ ...row, state: 'review', errorCode: 'SOURCE_RECORD_NOT_FOUND' });
    }
    const counts = {};
    for (const plan of plans) counts[plan.action] = (counts[plan.action] || 0) + 1;
    const result = { ok: true, apply, scanned: records.length, counts, plans, stopped: stopped(), nextRetryAt: this.nextRetryAt() };
    if (apply) this.setMeta('lastScan', { at: iso(), scanned: records.length, counts });
    return result;
  }
  leadValues(record) {
    const f = this.config.fields.leads, fields = record.fields || {}, owner = this.ownerValue(record);
    const domains = f.domain ? entries(fields[f.domain]) : [this.config.defaultDomain];
    if (domains.length !== 1) fail('LEAD_DOMAIN_INVALID');
    const designated = f.designated ? people(fields[f.designated]) : [];
    if (designated.length > 1 || designated.some(id => !openId(id))) fail('DESIGNATED_INVALID');
    return { owner, domain: domain(this.config, domains[0]), designated: designated[0] || '', slot: this.config.assignment.mode === 'slot' ? slotValue(fields[f.slot]) : null };
  }
  ownerValue(record) {
    const owners = people(record.fields?.[this.config.fields.leads.owner]);
    if (owners.length > 1 || owners.some(id => !openId(id))) fail('OWNER_INVALID');
    return owners[0] || '';
  }
  missingDetails(record) { return this.config.requiredLeadFields.filter(key => !text(record.fields?.[this.config.fields.leads[key]]).trim()); }
  deferMissingDetails(row, record) {
    if (!this.missingDetails(record).length) return false;
    this.put({ ...row, state: this.ownerValue(record) ? 'review' : 'awaiting_details', errorCode: 'REQUIRED_DETAILS_MISSING' });
    return true;
  }
  choose(values, members, cursors = new Map()) {
    if (this.config.assignment.mode === 'slot') {
      const mapped = members.filter(m => m.sales && m.domains.includes(values.domain) && m.slot === values.slot);
      if (!mapped.length) fail('SLOT_NOT_MAPPED');
      const active = mapped.filter(m => m.enabled);
      if (active.length > 1) fail('SLOT_AMBIGUOUS');
      if (!active.length) return null;
      if (values.designated && values.designated !== active[0].openId) fail('DESIGNATED_SLOT_MISMATCH');
      return { selected: active[0], mode: 'slot' };
    }
    const pool = members.filter(m => m.enabled && m.sales && m.domains.includes(values.domain)).sort((a, b) => a.rank - b.rank || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
    if (values.designated) {
      const selected = pool.find(m => m.openId === values.designated);
      if (!selected) fail('DESIGNATED_NOT_ELIGIBLE');
      return { selected, mode: 'designated' };
    }
    if (!pool.length) return null;
    const previous = cursors.get(values.domain) ?? this.meta(`cursor:${values.domain}`);
    const selected = pool[(pool.findIndex(m => m.recordId === previous) + 1) % pool.length];
    cursors.set(values.domain, selected.recordId);
    return { selected, mode: 'round_robin' };
  }
  plan(record, members, cursors) {
    const row = this.get(record.record_id), owner = this.ownerValue(record);
    if (row?.state === 'historical_review' && owner) return { recordId: record.record_id, action: 'baseline_assigned' };
    if (row && ['historical_review', 'review', 'notification_review', 'failed'].includes(row.state)) return { recordId: record.record_id, action: row.state, reason: row.errorCode || '' };
    if (row && ['done', 'baseline_assigned'].includes(row.state)) {
      if (!owner || (row.intendedOwner && owner !== row.intendedOwner)) return { recordId: record.record_id, action: 'review', reason: 'OWNER_CHANGED' };
      return { recordId: record.record_id, action: row.state };
    }
    if (!row?.intendedOwner && owner) return { recordId: record.record_id, action: 'baseline_assigned' };
    if (row?.intendedOwner && owner && owner !== row.intendedOwner) return { recordId: record.record_id, action: 'review', reason: 'OWNER_CHANGED' };
    if (this.missingDetails(record).length) return { recordId: record.record_id, action: owner ? 'review' : 'awaiting_details', reason: 'REQUIRED_DETAILS_MISSING' };
    const values = this.leadValues(record);
    if (row?.intendedOwner) {
      if (values.owner && values.owner !== row.intendedOwner) return { recordId: record.record_id, action: 'review', reason: 'OWNER_CHANGED' };
      return { recordId: record.record_id, action: row.state === 'awaiting_details' ? 'dispatch_pending' : row.state };
    }
    if (values.owner) return { recordId: record.record_id, action: 'baseline_assigned' };
    const selection = this.choose(values, members, cursors);
    return { recordId: record.record_id, action: selection ? 'assign' : 'awaiting_sales', ...(selection ? { mode: selection.mode } : { reason: 'NO_ELIGIBLE_SALES' }) };
  }
  async applyRecord(record, members, plan, { shouldStop = () => false } = {}) {
    if (shouldStop()) return;
    let row = this.get(record.record_id);
    if (plan.action === 'awaiting_details') { this.put({ ...(row || { id: record.record_id }), state: 'awaiting_details', errorCode: 'REQUIRED_DETAILS_MISSING' }); return; }
    if (['historical_review', 'review', 'notification_review', 'failed', 'done', 'baseline_assigned'].includes(plan.action)) {
      if (!row || row.state !== plan.action || plan.action === 'review') this.put({ ...(row || { id: record.record_id }), state: plan.action, errorCode: plan.reason || '' });
      return;
    }
    if (row?.state === 'awaiting_details' && plan.action === 'dispatch_pending') { row = { ...row, state: 'dispatch_pending' }; this.put(row); }
    if (row?.nextAttemptAt > this.now()) return;
    if (!row?.intendedOwner) {
      const values = this.leadValues(record), selection = this.choose(values, members);
      if (!selection) { this.put({ id: record.record_id, state: 'awaiting_sales', errorCode: 'NO_ELIGIBLE_SALES' }); return; }
      this.transaction(() => {
        row = { id: record.record_id, state: 'dispatch_pending', intendedOwner: selection.selected.openId, staffRecordId: selection.selected.recordId, domain: values.domain, designatedOwner: values.designated, slot: values.slot, mode: selection.mode, notificationKey: randomUUID(), attempts: 0, nextAttemptAt: 0, createdAt: iso() };
        this.put(row);
        if (selection.mode === 'round_robin') this.setMeta(`cursor:${values.domain}`, selection.selected.recordId);
      });
    }
    if (shouldStop()) return; // Keep a persisted intent pending when stopping before any remote write.
    const fresh = await this.client.readRecord(this.config.tableIds.leads, row.id);
    if (shouldStop()) return;
    if (this.deferMissingDetails(row, fresh)) return;
    const actual = this.leadValues({ ...fresh, record_id: row.id });
    if (actual.domain !== row.domain || actual.slot !== (row.slot ?? null) || (actual.owner && actual.owner !== row.intendedOwner)) { this.put({ ...row, state: 'review', errorCode: 'OWNER_OR_DOMAIN_CHANGED' }); return; }
    if (!actual.owner && actual.designated !== (row.designatedOwner || '')) { this.put({ ...row, state: 'review', errorCode: 'DESIGNATED_CHANGED_DURING_DISPATCH' }); return; }
    const eligible = member => member.openId === row.intendedOwner && member.enabled && member.sales && member.domains.includes(row.domain) && (row.mode !== 'slot' || member.slot === row.slot);
    const selected = members.find(eligible);
    if (!selected) { this.put({ ...row, state: row.mode === 'slot' && !actual.owner ? 'awaiting_sales' : 'review', errorCode: 'ASSIGNEE_DISABLED' }); return; }
    // Re-read the selected staff row immediately before committing the owner.
    const confirmedStaff = this.config.staffSource === 'config' ? await this.readStaff() : staffSnapshot(this.config, [{ ...(await this.client.readRecord(this.config.tableIds.staff, selected.recordId)), record_id: selected.recordId }]);
    if (shouldStop()) return;
    const valid = confirmedStaff.members.find(eligible);
    if (confirmedStaff.errors.length || !valid) { this.put({ ...row, state: row.mode === 'slot' && !actual.owner ? 'awaiting_sales' : 'review', errorCode: 'ASSIGNEE_DISABLED' }); return; }
    const beforeWrite = await this.client.readRecord(this.config.tableIds.leads, row.id);
    if (shouldStop()) return;
    if (this.deferMissingDetails(row, beforeWrite)) return;
    const current = this.leadValues(beforeWrite);
    if (current.domain !== row.domain || current.slot !== (row.slot ?? null) || current.designated !== (row.designatedOwner || '') || (current.owner && current.owner !== row.intendedOwner)) { this.put({ ...row, state: 'review', errorCode: 'DISPATCH_INPUTS_CHANGED' }); return; }
    // Local membership can change during the preceding network read. Refresh it
    // again next to the write, so a disable cannot be hidden by that await.
    if (this.config.staffSource === 'config') {
      const finalStaff = await this.readStaff();
      if (finalStaff.errors.length || !finalStaff.members.some(eligible)) { this.put({ ...row, state: row.mode === 'slot' && !current.owner ? 'awaiting_sales' : 'review', errorCode: 'ASSIGNEE_DISABLED' }); return; }
    }
    if (shouldStop()) return;
    const f = this.config.fields.leads;
    let remoteWriteStarted = false;
    const patch = { ...(!current.owner ? { [f.owner]: [{ id: row.intendedOwner }] } : {}), ...(f.dispatch && text(beforeWrite.fields?.[f.dispatch]) !== this.config.dispatchAssignedValue ? { [f.dispatch]: this.config.dispatchAssignedValue } : {}) };
    if (Object.keys(patch).length) {
      remoteWriteStarted = true;
      await this.client.updateRecord(this.config.tableIds.leads, row.id, patch);
    }
    const confirmed = await this.client.readRecord(this.config.tableIds.leads, row.id);
    if (this.deferMissingDetails(row, confirmed)) return;
    const confirmedValues = this.leadValues(confirmed);
    if (confirmedValues.owner !== row.intendedOwner || confirmedValues.domain !== row.domain || confirmedValues.slot !== (row.slot ?? null) || confirmedValues.designated !== (row.designatedOwner || '') || (f.dispatch && text(confirmed.fields?.[f.dispatch]) !== this.config.dispatchAssignedValue)) { this.put({ ...row, state: 'review', errorCode: 'OWNER_WRITE_UNCONFIRMED' }); return; }
    row = { ...row, state: 'owner_written', attempts: 0, nextAttemptAt: 0, errorCode: '' };
    this.put(row);
    if (!this.config.notification.enabled) { this.put({ ...row, state: 'done', notification: 'disabled' }); return; }
    if (!remoteWriteStarted && shouldStop()) return;
    const target = new URL(this.config.baseUrl); target.searchParams.set('table', this.config.tableIds.leads); target.searchParams.set('record', row.id);
    const details = [];
    if (f.wx && text(confirmed.fields?.[f.wx])) details.push(`微信号：${text(confirmed.fields[f.wx])}`);
    if (f.needs && text(confirmed.fields?.[f.needs])) details.push(`客户需求：${text(confirmed.fields[f.needs])}`);
    row = { ...row, state: 'notification_sending', notificationAttempts: (row.notificationAttempts || 0) + 1, firstAttemptAt: row.firstAttemptAt || this.now(), notificationTitle: row.notificationTitle || this.config.notification.title, notificationText: row.notificationText || ['您有一条新客资，请及时查看并跟进。', ...details].join('\n'), notificationUrl: row.notificationUrl || target.href };
    if (this.now() - row.firstAttemptAt >= 55 * 60_000) { this.put({ ...row, state: 'notification_review', errorCode: 'MESSAGE_RETRY_WINDOW_EXCEEDED' }); return; }
    this.put(row);
    try {
      const result = await this.client.sendNotification({ recipientOpenId: row.intendedOwner, title: row.notificationTitle, text: row.notificationText, url: row.notificationUrl, idempotencyKey: row.notificationKey });
      if (!result?.messageId) fail('MESSAGE_RESULT_UNKNOWN');
      this.put({ ...row, state: 'done', notification: 'sent', messageId: result.messageId, sentAt: iso(), errorCode: '' });
    } catch (error) {
      // Numeric API rejections are definite responses; a transport failure is ambiguous.
      const definite = /^\d+$/.test(String(error?.code || ''));
      const retry = definite && row.notificationAttempts < 8;
      this.put({ ...row, state: definite ? retry ? 'notification_pending' : 'failed' : 'notification_review', errorCode: definite ? 'MESSAGE_REJECTED' : 'SEND_OUTCOME_UNKNOWN', nextAttemptAt: this.now() + Math.min(300_000, 2000 * 2 ** row.notificationAttempts) });
    }
  }
  nextRetryAt() {
    let earliest = null;
    for (const row of this.rows()) if (['dispatch_pending', 'owner_written', 'notification_pending'].includes(row.state)) {
      const due = Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt > 0 ? row.nextAttemptAt : this.now();
      earliest = earliest === null ? due : Math.min(earliest, due);
    }
    return earliest;
  }
  status() {
    const counts = {};
    for (const row of this.rows()) counts[row.state] = (counts[row.state] || 0) + 1;
    return { initialized: Boolean(this.meta('initialized')), initializedAt: this.meta('initialized')?.at || null, baselineCount: this.meta('initialized')?.baselineCount || 0, counts, lastScan: this.meta('lastScan'), nextRetryAt: this.nextRetryAt(), busy: Boolean(this.inFlight) };
  }
  async close() { if (this.closed) return; try { if (this.inFlight) await this.inFlight; } finally { this.closed = true; this.db.close(); } }
}
