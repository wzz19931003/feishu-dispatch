import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { WorkflowClient } from './client.mjs';
import { EXTRA_SOURCE_FIELDS, validateWorkflowConfig, resolveFields, recordView, encodePatch, chooseMember } from './field-map.mjs';

export class WorkflowError extends Error {
  constructor(code) { super(`工作流操作未完成（${code}）`); this.code = code; }
}
const fail = code => { throw new WorkflowError(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'REMOTE_FAILURE';
const stopped = callback => { try { return Boolean(callback?.()); } catch { return true; } };
const pending = item => ['pending', 'waiting_details', 'waiting_member', 'waiting_operator', 'waiting_mirror'].includes(item.state);
// Only an explicit missing record proves deletion. Missing fields/tables/access do not.
const missingSource = error => ['SOURCE_NOT_FOUND', 'RECORD_NOT_FOUND', 'SOURCE_RECORD_NOT_FOUND', '1254043'].includes(String(error?.code || ''));
const activeContact = view => view.addMethod === '客户主动加';
const operatorNoticeStatuses = new Set(['未通过', '号码错误', '主动加未添加']);
const ready = view => Boolean(view.wx?.trim() && view.needs?.trim());
const enabledPool = config => [...config.members].filter(member => member.enabled).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const stableConfig = config => { const { members, pendingTargets, ...rest } = config; return digest(rest); };
const memberPin = member => ({ id: member.id, openId: member.openId, target: member.target });
const MIRROR_MANUAL = new Set(['MIRROR_CREATE_REVIEW_REQUIRED', 'MIRROR_REVOKE_REVIEW_REQUIRED']);

async function listAll(client, tableId) {
  const rows = [], ids = new Set(), tokens = new Set(); let token;
  do {
    const page = await client.listRecords(tableId, { pageSize: 100, ...(token ? { pageToken: token } : {}) });
    if (!Array.isArray(page?.items)) fail('SOURCE_RESPONSE_INVALID');
    for (const record of page.items) {
      const id = record.record_id || record.recordId;
      if (typeof id !== 'string' || !id || ids.has(id)) fail('SOURCE_RECORD_ID_INVALID');
      ids.add(id); rows.push({ ...record, record_id: id });
    }
    if (!page.hasMore) break;
    if (typeof page.pageToken !== 'string' || !page.pageToken || tokens.has(page.pageToken) || tokens.size >= 1000) fail('SOURCE_PAGINATION_INVALID');
    token = page.pageToken; tokens.add(token);
  } while (true);
  return rows;
}

/** v2 core has no listener, timer, host startup or cloud-side installation effects. */
export class WorkflowEngine {
  constructor({ config, client, dbPath, memberProvider, mirror, now = Date.now } = {}) {
    this.config = validateWorkflowConfig(config); this.client = client || new WorkflowClient(this.config);
    this.memberProvider = memberProvider; this.mirror = mirror || null; this.now = now; this.inFlight = null; this.closed = false;
    this.configSignature = stableConfig(this.config);
    const filename = dbPath || this.config.dbPath;
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS v2_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_snapshots(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_outbox(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_reviews(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_inbox(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    if(this.config.staffManagement?.enabled)this.db.exec('CREATE TABLE IF NOT EXISTS v2_staff_runtime_events(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    try { this.bindSource(); } catch (error) { this.db.close(); throw error; }
    for (const task of this.all('v2_outbox').filter(task => task.state === 'sending')) {
      this.put('v2_outbox', { ...task, state: 'review', errorCode: 'SEND_OUTCOME_UNKNOWN' });
      this.review(task.recordId, 'SEND_OUTCOME_UNKNOWN', task.id);
    }
  }
  bindSource() {
    const fields = this.config.fields.leads;
    const core = Object.fromEntries(Object.entries(fields).filter(([key]) => !Object.hasOwn(EXTRA_SOURCE_FIELDS, key)));
    const binding = digest([this.config.appId, this.config.appToken, this.config.tableIds.leads, core]);
    const pins = this.meta('source_extension_pins') || {};
    const additions = Object.fromEntries(Object.entries(fields)
      .filter(([key]) => Object.hasOwn(EXTRA_SOURCE_FIELDS, key)).map(([key, value]) => [key, digest(value)]));
    if ((this.meta('binding') && this.meta('binding') !== binding) ||
      Object.entries(additions).some(([key, value]) => pins[key] && pins[key] !== value)) fail('DATABASE_BINDING_MISMATCH');
    this.transaction(() => {
      this.setMeta('binding', binding);
      if (Object.keys(additions).length) this.setMeta('source_extension_pins', { ...pins, ...additions });
    });
  }
  hasSalesWechat() { return Boolean(this.config.staffManagement?.fields?.salesWechat); }
  stamp() { return new Date(this.now()).toISOString(); }
  meta(key) { const row = this.db.prepare('SELECT value FROM v2_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO v2_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  table(table) { if (!['v2_snapshots', 'v2_outbox', 'v2_reviews', 'v2_inbox'].includes(table)) fail('INTERNAL_TABLE_INVALID'); return table; }
  all(table) { return this.db.prepare(`SELECT data FROM ${this.table(table)} ORDER BY id`).all().map(row => JSON.parse(row.data)); }
  get(table, id) { const row = this.db.prepare(`SELECT data FROM ${this.table(table)} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : null; }
  put(table, value) { this.db.prepare(`INSERT INTO ${this.table(table)}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, JSON.stringify({ ...value, updatedAt: this.stamp() })); }
  transaction(callback) {
    if (this.transactionDepth) return callback();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth = true;
    try { const result = callback(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this.transactionDepth = false; }
  }
  review(recordId, code, eventId = '') { const id = digest([recordId, code, eventId]); this.put('v2_reviews', { id, recordId, code, eventId, state: 'open', createdAt: this.stamp() }); }
  resolveReview(recordId, code) { for (const item of this.all('v2_reviews')) if (item.recordId === recordId && item.code === code && item.state === 'open') this.put('v2_reviews', { ...item, state: 'resolved' }); }
  async refreshMembers({ persist = true } = {}) {
    let fresh = this.config;
    if (this.memberProvider) {
      try { fresh = validateWorkflowConfig(await this.memberProvider()); } catch { fail('MEMBER_REFRESH_FAILED'); }
      if (stableConfig(fresh) !== this.configSignature) fail('LIVE_CONFIG_BINDING_CHANGED');
    }
    const pins = this.meta('member_pins') || {};
    for (const member of fresh.members) {
      const byId = pins[member.id], byPerson = Object.values(pins).find(pin => pin.openId === member.openId);
      if (byId && digest(byId) !== digest(memberPin(member)) || byPerson && byPerson.id !== member.id) fail('MEMBER_BINDING_CHANGED');
    }
    const changed = digest(this.config.members) !== digest(fresh.members);
    this.config.members = fresh.members;
    if (persist) {
      this.setMeta('member_pins', { ...pins, ...Object.fromEntries(fresh.members.map(member => [member.id, memberPin(member)])) });
      if (changed) for (const task of this.all('v2_outbox').filter(task => task.state === 'waiting_member')) this.put('v2_outbox', { ...task, state: 'pending', nextAttemptAt: 0 });
    }
    return fresh.members;
  }
  async resolveSource() { return resolveFields(this.client, { appToken: this.config.appToken, tableId: this.config.tableIds.leads, fields: this.config.fields.leads }); }
  async readSource(id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = await this.resolveSource(), record = await this.client.readRecord(this.config.tableIds.leads, id);
      if (digest(resolved) === digest(await this.resolveSource())) return recordView(record, resolved);
    }
    fail('SOURCE_SCHEMA_CHANGED_DURING_READ');
  }
  async readSourceView(id) { return this.readSource(id); }
  acceptEvent(event) {
    if (this.closed) fail('ENGINE_CLOSED');
    const staff=this.config.staffManagement;
    if(staff?.enabled&&event?.appToken===staff.appToken&&event?.tableId===staff.tableId){
      if(typeof event.id!=='string'||!event.id||event.id.length>300||!Array.isArray(event.recordIds)||event.recordIds.some(id=>typeof id!=='string'||!id||id.length>300))return false;
      if(this.db.prepare('SELECT 1 FROM v2_staff_runtime_events WHERE id=?').get(event.id))return false;
      this.db.prepare('INSERT INTO v2_staff_runtime_events(id,data) VALUES(?,?)').run(event.id,JSON.stringify({id:event.id,state:'pending',recordIds:[...new Set(event.recordIds)],receivedAt:this.stamp()}));
      return true;
    }
    if (!event || event.appToken !== this.config.appToken || event.tableId !== this.config.tableIds.leads || typeof event.id !== 'string' || !event.id || event.id.length > 300 || !Array.isArray(event.recordIds) || event.recordIds.some(id => typeof id !== 'string' || !id || id.length > 300)) return false;
    if (this.get('v2_inbox', event.id)) return false;
    this.put('v2_inbox', { id: event.id, recordIds: [...new Set(event.recordIds)], state: 'pending', receivedAt: this.stamp() });
    return true;
  }
  staffEvents(){return this.config.staffManagement?.enabled?this.db.prepare('SELECT id,data FROM v2_staff_runtime_events').all().map(row=>JSON.parse(row.data)):[];}
  async refreshStaff({apply=false,shouldStop=()=>false}={}){
    if(!this.staff)return{ok:true,errors:[]};
    // Local activation/binding changes must reject before any onboarding side effect.
    if(apply)await this.refreshMembers({persist:false});
    try{
      const result=await this.staff.refresh({apply,shouldStop});
      const healthy=this.staff.status?.().healthy??(result?.ok!==false);this.staffFailure=!healthy;
      return{...result,healthy,errors:(result?.errors||[]).map(error=>({code:safeCode(typeof error==='string'?{code:error}:error)}))};
    }catch(error){this.staffFailure=true;return{ok:false,healthy:false,errors:[{code:safeCode(error)}]};}
  }
  legacyRows(input) {
    let rows = input;
    if (rows === undefined && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v2_legacy_jobs'").get()) rows = this.db.prepare('SELECT id,data FROM v2_legacy_jobs ORDER BY id').all();
    if (rows === undefined) return [];
    if (!Array.isArray(rows)) fail('LEGACY_ROWS_INVALID');
    return rows.map(row => { const value = row?.data !== undefined ? typeof row.data === 'string' ? JSON.parse(row.data) : row.data : row; if (!value || typeof value.id !== 'string' || !value.id) fail('LEGACY_ROW_INVALID'); return value; });
  }
  async initialize(options = {}) {
    if (this.closed) fail('ENGINE_CLOSED');
    if (this.inFlight) fail('ENGINE_BUSY');
    if (this.meta('initialized')) return { ok: true, alreadyInitialized: true, ...this.status() };
    if(this.staff){const staff=await this.refreshStaff({apply:false});if(staff.healthy===false)fail(staff.errors?.[0]?.code||'STAFF_NOT_READY');}
    await this.refreshMembers();
    const resolved = await this.resolveSource(), records = await listAll(this.client, this.config.tableIds.leads);
    // A baseline must use the same field identities and names as its full record snapshot.
    if (digest(resolved) !== digest(await this.resolveSource())) fail('SOURCE_SCHEMA_CHANGED_DURING_INITIALIZE');
    const legacy = this.legacyRows(options.legacyRows), hasLegacy = Object.hasOwn(options, 'legacyRows') || Boolean(this.meta('legacy_import')) || legacy.length > 0;
    const legacyById = new Map(legacy.map(row => [row.id, row]));
    const legacyMeta = options.legacyMeta || {};
    this.transaction(() => {
      this.setMeta('legacy_metadata', legacyMeta);
      this.setMeta('legacy_known_ids', [...legacyById.keys()]);
      let imported = 0, deferred = 0;
      for (const record of records) {
        if (hasLegacy && !legacyById.has(record.record_id)) { deferred++; continue; }
        try {
          const view = recordView(record, resolved), old = legacyById.get(view.id);
          const waiting = old && ['awaiting_details', 'awaiting_sales'].includes(old.state) && !view.owner;
          const snapshot = this.observe(view, { baseline: true, phase: waiting ? ready(view) ? 'awaiting_sales' : 'awaiting_details' : view.owner ? 'assigned' : 'history_review' });
          if (old && !['done', 'baseline_assigned', 'awaiting_details', 'awaiting_sales'].includes(old.state)) {
            snapshot.blocked = true; this.put('v2_snapshots', snapshot); this.review(view.id, 'LEGACY_UNRESOLVED');
          }
          if (waiting) { snapshot.autoEligible = true; this.put('v2_snapshots', snapshot); }
          imported++;
        } catch (error) { this.review(record.record_id, safeCode(error), 'baseline'); }
      }
      const candidates = Object.entries(legacyMeta).filter(([key, value]) => /cursor|last-assignee/i.test(key) && typeof value === 'string' && this.config.members.some(member => member.id === value));
      const latest = [...legacy].filter(row => row.state === 'done' && row.intendedOwner).sort((a, b) => String(b.sentAt || b.updatedAt || b.createdAt || '').localeCompare(String(a.sentAt || a.updatedAt || a.createdAt || '')))[0];
      const lastId = candidates[0]?.[1] || this.config.members.find(member => member.openId === latest?.intendedOwner)?.id;
      if (lastId) this.setMeta('last_member_id', lastId);
      this.setMeta('initialized', { at: this.stamp(), imported, deferred, legacy: hasLegacy });
    });
    return { ok: true, ...this.status() };
  }
  queue(kind, snapshot, extra = {}) {
    const version = kind === 'owner' ? snapshot.ownerVersion : kind === 'status' ? snapshot.statusVersion : snapshot.contactSignature;
    const id = digest([snapshot.id, kind, version, kind === 'status' ? snapshot.operatorVersion : '']);
    if (!this.get('v2_outbox', id)) this.put('v2_outbox', { id, recordId: snapshot.id, kind, state: 'pending', owner: snapshot.view.owner, ownerVersion: snapshot.ownerVersion, statusVersion: snapshot.statusVersion,
      contactSignature: snapshot.contactSignature, attempts: 0, nextAttemptAt: 0, createdAt: this.stamp(), ...extra });
  }
  cancel(recordId, predicate, reason) {
    for (const task of this.all('v2_outbox').filter(task => task.recordId === recordId && predicate(task))) {
      if (task.state === 'sending') { this.put('v2_outbox', { ...task, state: 'review', errorCode: 'SEND_OUTCOME_UNKNOWN' }); this.review(recordId, 'SEND_OUTCOME_UNKNOWN', task.id); }
      else if (pending(task)) this.put('v2_outbox', { ...task, state: 'cancelled', errorCode: reason });
    }
  }
  unseenStatusWriteback(view, previous) {
    const receipt = this.mirror?.statusWriteback?.(view.id);
    return receipt?.id && receipt.id !== previous?.statusWritebackId ? receipt : null;
  }
  observe(view, { baseline = false, phase } = {}) {
    return this.transaction(() => {
      const old = this.get('v2_snapshots', view.id), first = !old;
      const ownerChanged = !first && old.view.owner !== view.owner;
      const statusChanged = !first && old.view.wxStatus !== view.wxStatus;
      const addChanged = !first && old.view.addMethod !== view.addMethod;
      const operatorChanged = !first && old.view.operator !== view.operator;
      const notifyStatus = operatorNoticeStatuses.has(view.wxStatus);
      const receipt = baseline ? null : this.unseenStatusWriteback(view, old);
      const pendingStatus = notifyStatus && operatorChanged && !statusChanged && this.all('v2_outbox')
        .find(task => task.recordId === view.id && task.kind === 'status' && task.statusVersion === old.statusVersion && task.statusWritebackId && pending(task));
      const confirmedStatus = notifyStatus && statusChanged && receipt && receipt.owner === view.owner && old.view.owner === view.owner &&
        receipt.from === old.view.wxStatus && receipt.to === view.wxStatus;
      const contactOnAssignment = this.hasSalesWechat();
      const contactAwaitingOperator = contactOnAssignment && activeContact(view) && operatorChanged && !ownerChanged && this.all('v2_outbox')
        .some(task => task.recordId === view.id && task.kind === 'contact' && task.ownerVersion === old.ownerVersion && pending(task) && !task.delivery);
      const wxChanged = !first && old.view.wx !== view.wx;
      const detailsChanged = !first && (wxChanged || old.view.needs !== view.needs);
      const snapshot = { ...(old || {}), id: view.id, view, ownerVersion: (old?.ownerVersion || 0) + (ownerChanged || first && view.owner ? 1 : 0),
        statusVersion: (old?.statusVersion || 0) + (statusChanged ? 1 : 0), addVersion: (old?.addVersion || 0) + (addChanged ? 1 : 0),
        operatorVersion: (old?.operatorVersion || 0) + (operatorChanged ? 1 : 0), wxVersion: (old?.wxVersion || 0) + (wxChanged ? 1 : 0),
        autoEligible: old?.autoEligible ?? !baseline, phase: phase || (view.owner ? 'assigned' : ready(view) ? 'awaiting_sales' : 'awaiting_details'), deleted: false };
      if (receipt) snapshot.statusWritebackId = receipt.id;
      if (ownerChanged) {
        this.cancel(view.id, task => ['owner', 'contact'].includes(task.kind), 'OWNER_CHANGED');
        delete snapshot.displayNextAttemptAt;
        if (!view.owner) { snapshot.autoEligible = false; snapshot.intent = null; snapshot.phase = 'owner_cleared'; this.review(view.id, 'OWNER_CLEARED'); }
        else { snapshot.displayPending = true; if (snapshot.intent && snapshot.intent.owner !== view.owner) snapshot.intent = null; }
      }
      if (first && view.owner && !baseline) snapshot.displayPending = true;
      if (statusChanged) this.cancel(view.id, task => task.kind === 'status', 'STATUS_CHANGED');
      if (operatorChanged) this.cancel(view.id, task => ['status', 'contact'].includes(task.kind), 'OPERATOR_CHANGED');
      const carryContact = contactOnAssignment && !ownerChanged && !operatorChanged && !addChanged && old?.contactSignature;
      snapshot.contactSignature = view.owner && activeContact(view) && (contactOnAssignment || ready(view))
        ? carryContact || digest([snapshot.ownerVersion, snapshot.addVersion, snapshot.wxVersion, snapshot.operatorVersion]) : '';
      if (old?.contactSignature && old.contactSignature !== snapshot.contactSignature) this.cancel(view.id, task => task.kind === 'contact', 'CONTACT_CHANGED');
      if (old?.blocked && !view.owner) snapshot.phase = 'legacy_review';
      this.put('v2_snapshots', snapshot);
      if (!baseline) {
        if ((first && view.owner) || ownerChanged && view.owner) this.queue('owner', snapshot);
        if (confirmedStatus || pendingStatus) this.queue('status', snapshot, { statusWritebackId: confirmedStatus ? receipt.id : pendingStatus.statusWritebackId });
        if (snapshot.contactSignature && (contactOnAssignment ? first || ownerChanged || addChanged || contactAwaitingOperator : first || old.contactSignature !== snapshot.contactSignature)) this.queue('contact', snapshot);
        if (detailsChanged || operatorChanged) for (const task of this.all('v2_outbox').filter(task => task.recordId === view.id && ['waiting_details', 'waiting_operator'].includes(task.state))) this.put('v2_outbox', { ...task, state: 'pending', nextAttemptAt: 0 });
      }
      return snapshot;
    });
  }
  markMissing(id) {
    const snapshot = this.get('v2_snapshots', id); if (!snapshot || snapshot.deleted) return;
    this.transaction(() => { this.cancel(id, () => true, 'SOURCE_MISSING'); this.put('v2_snapshots', { ...snapshot, deleted: true, phase: 'deleted', intent: null, autoEligible: false }); });
  }
  scan(options = {}) {
    if (this.closed) return Promise.reject(new WorkflowError('ENGINE_CLOSED'));
    if (this.inFlight) return Promise.reject(new WorkflowError('ENGINE_BUSY'));
    this.inFlight = this.runScan(options).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  syncDeferredSalesDetails(options = {}) {
    if (this.closed) return Promise.reject(new WorkflowError('ENGINE_CLOSED'));
    if (this.inFlight) return Promise.reject(new WorkflowError('ENGINE_BUSY'));
    if (!this.config.enabled || !this.mirror?.syncDeferredDetails || options.shouldStop?.() || options.signal?.aborted) return Promise.resolve({});
    this.inFlight = (async () => {
      const result = await this.mirror.syncDeferredDetails(options);
      const detail = Object.fromEntries(Object.entries(result || {}).filter(([key, value]) =>
        key.startsWith('detail') && Number.isSafeInteger(value) && value >= 0));
      if (Object.keys(detail).length) this.setMeta('mirror_status', { ...this.meta('mirror_status'), ...detail });
      return detail;
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  preview(view) {
    const old = this.get('v2_snapshots', view.id), actions = [];
    if (old?.view.owner && !view.owner) actions.push('owner_cleared');
    else if (view.owner && (!old || old.view.owner !== view.owner)) actions.push('owner_changed');
    else if (!view.owner && (old?.autoEligible ?? !(this.meta('legacy_known_ids') || []).includes(view.id))) actions.push(ready(view) ? enabledPool(this.config).length ? 'assign' : 'awaiting_sales' : 'awaiting_details');
    const receipt = old && this.unseenStatusWriteback(view, old);
    if (receipt && receipt.owner === view.owner && old.view.owner === view.owner && receipt.from === old.view.wxStatus &&
      receipt.to === view.wxStatus && old.view.wxStatus !== view.wxStatus && operatorNoticeStatuses.has(view.wxStatus)) actions.push('status_notification');
    if (view.owner && activeContact(view) && (this.hasSalesWechat()
      ? !old || old.view.owner !== view.owner || old.view.addMethod !== view.addMethod
      : ready(view) && (!old || old.view.owner !== view.owner || old.view.addMethod !== view.addMethod || old.view.wx !== view.wx || old.view.operator !== view.operator))) actions.push('contact_notification');
    return { recordId: view.id, actions };
  }
  async runScan({ apply = false, shouldStop = () => false, deferSalesDetails = false } = {}) {
    if (!this.meta('initialized')) fail('INITIALIZATION_REQUIRED');
    if (typeof shouldStop !== 'function') fail('STOP_CALLBACK_INVALID');
    if (apply && !this.config.enabled) fail('WORKFLOW_DISABLED');
    const acknowledgedEvents = apply ? this.all('v2_inbox').filter(event => event.state === 'pending').map(event => event.id) : [];
    const acknowledgedStaffEvents=apply?this.staffEvents().filter(event=>event.state==='pending').map(event=>event.id):[];
    const staffResult=await this.refreshStaff({apply,shouldStop});
    await this.refreshMembers({ persist: apply });
    const resolved = await this.resolveSource(), records = await listAll(this.client, this.config.tableIds.leads);
    // A rename during pagination must not turn an existing owner into an apparent blank.
    if (digest(resolved) !== digest(await this.resolveSource())) fail('SOURCE_SCHEMA_CHANGED_DURING_SCAN');
    const plans = [], sourceViews = [], errors = [...(staffResult.errors||[])], present = new Set(records.map(record => record.record_id));
    const knownLegacy = new Set(this.meta('legacy_known_ids') || []);
    for (const record of records) {
      if (stopped(shouldStop)) break;
      try {
        const view = recordView(record, resolved); sourceViews.push(view); plans.push(this.preview(view));
        if (!apply) continue;
        const old = this.get('v2_snapshots', view.id);
        this.observe(view, { baseline: !old && knownLegacy.has(view.id) });
        await this.processRecord(view.id, shouldStop);
      } catch (error) {
        errors.push({ code: safeCode(error) });
        if (apply) this.review(record.record_id, safeCode(error));
      }
    }
    if (apply && !stopped(shouldStop)) {
      for (const snapshot of this.all('v2_snapshots')) if (!present.has(snapshot.id)) this.markMissing(snapshot.id);
      this.setMeta('mirror_rescan_needed', false);
      await this.drain(shouldStop);
      if (this.mirror && !stopped(shouldStop)) {
        try {
          const result = await this.mirror.sync({ shouldStop, deferDetails: deferSalesDetails, sourceViews: this.all('v2_snapshots').filter(snapshot => !snapshot.deleted).map(snapshot => snapshot.view) });
          this.setMeta('mirror_status', Object.fromEntries(Object.entries(result || {}).filter(([, value]) => Number.isSafeInteger(value) && value >= 0)));
          if (result?.sourceWrites > 0 || result?.ensured > 0) this.setMeta('mirror_rescan_needed', true);
          if (result?.statusSources?.length && !stopped(shouldStop)) await this.notifyConfirmedMirrorStatuses(result.statusSources, shouldStop);
        } catch (error) { if (safeCode(error) !== 'MIRROR_STOP_REQUESTED') { this.review('', safeCode(error), 'mirror_sync'); errors.push({ code: safeCode(error) }); } }
      }
      if (this.operatorMirror && staffResult.healthy === true && sourceViews.length === records.length && !stopped(shouldStop)) {
        try {
          const operators = this.staff.operatorCandidates();
          const latestViews = new Map(this.all('v2_snapshots').filter(snapshot => !snapshot.deleted).map(snapshot => [snapshot.id, snapshot.view]));
          const result = await this.operatorMirror.sync(sourceViews.map(view => latestViews.get(view.id) ?? view), { operators, shouldStop });
          const byPerson = new Map(operators.map(operator => [operator.openId, operator]));
          const urls = (result.readyUrls || []).flatMap(({ openId, url }) => byPerson.has(openId)
            ? [{ ...byPerson.get(openId), url }] : []);
          const links = await this.staff.recordOperatorViewUrls(urls, { shouldStop });
          errors.push(...(links.errors || []).map(error => ({ code: safeCode(error) })));
          this.setMeta('operator_mirror_status', Object.fromEntries(Object.entries(result).filter(([, value]) => Number.isSafeInteger(value) && value >= 0)));
        } catch (error) {
          if (!stopped(shouldStop)) {
            this.review('', safeCode(error), 'operator_mirror_sync');
            errors.push({ code: safeCode(error) });
          }
        }
      }
      for (const id of acknowledgedEvents) { const event = this.get('v2_inbox', id); if (event?.state === 'pending') this.put('v2_inbox', { ...event, state: 'done', processedAt: this.stamp() }); }
      if(staffResult.healthy!==false)for(const id of acknowledgedStaffEvents){const row=this.db.prepare('SELECT data FROM v2_staff_runtime_events WHERE id=?').get(id);if(row){const event=JSON.parse(row.data);if(event.state==='pending')this.db.prepare('UPDATE v2_staff_runtime_events SET data=? WHERE id=?').run(JSON.stringify({...event,state:'done',processedAt:this.stamp()}),id);}}
    }
    const counts = {};
    for (const plan of plans) for (const action of plan.actions) counts[action] = (counts[action] || 0) + 1;
    const result = { ok: errors.length === 0, apply, scanned: records.length, counts, errors, plans, stopped: stopped(shouldStop), needsRescan: Boolean(this.meta('mirror_rescan_needed')), nextRetryAt: this.nextRetryAt() };
    if (apply) this.setMeta('last_scan', { at: this.stamp(), scanned: records.length, counts, errors: errors.map(error => error.code) });
    return result;
  }
  assignmentDisplay(member, intent = null) {
    const index = enabledPool(this.config).findIndex(candidate => candidate.id === member.id);
    return { actualSlot: intent ? intent.slot : index >= 0 ? index + 1 : null, actualSort: intent ? intent.order : member.order, salesName: intent ? intent.name : member.displayName };
  }
  waitForSales(snapshot, intent, errorCode = '') {
    const canPickAgain = Boolean(this.config.staffManagement?.fields?.leaveStart) &&
      !snapshot.view.owner && intent.writeStarted === false;
    const waiting = { ...snapshot, phase: 'awaiting_sales', ...(errorCode ? { errorCode } : {}) };
    this.put('v2_snapshots', canPickAgain ? { ...waiting, intent: null } : waiting);
  }
  async processRecord(id, shouldStop) {
    let snapshot = this.get('v2_snapshots', id);
    if (!snapshot || snapshot.deleted || stopped(shouldStop)) return;
    if (!snapshot.view.owner && !snapshot.intent && snapshot.autoEligible && !snapshot.blocked) {
      if (!ready(snapshot.view)) { this.put('v2_snapshots', { ...snapshot, phase: 'awaiting_details' }); return; }
      const member = chooseMember(this.config.members, this.meta('last_member_id'));
      if (!member) { this.put('v2_snapshots', { ...snapshot, phase: 'awaiting_sales' }); return; }
      this.transaction(() => {
        snapshot = { ...snapshot, phase: 'assigning', intent: { owner: member.openId, memberId: member.id, slot: enabledPool(this.config).findIndex(item => item.id === member.id) + 1, order: member.order, name: member.displayName, createdAt: this.stamp(), attempts: 0, nextAttemptAt: 0, writeStarted: false } };
        this.put('v2_snapshots', snapshot); this.setMeta('last_member_id', member.id);
      });
    }
    if (snapshot.intent && (!snapshot.intent.nextAttemptAt || snapshot.intent.nextAttemptAt <= this.now())) await this.commitAssignment(id, shouldStop);
    else if (!snapshot.intent && snapshot.view.owner && snapshot.displayPending && (!snapshot.displayNextAttemptAt || snapshot.displayNextAttemptAt <= this.now())) {
      try {
        await this.commitDisplay(id, shouldStop);
      } catch (error) {
        if (missingSource(error)) { this.markMissing(id); return; }
        const pendingDisplay = this.get('v2_snapshots', id);
        if (pendingDisplay?.displayPending && pendingDisplay.view.owner === snapshot.view.owner && pendingDisplay.ownerVersion === snapshot.ownerVersion) {
          this.put('v2_snapshots', { ...pendingDisplay, displayNextAttemptAt: this.now() + 60_000 });
        }
        throw error;
      }
    }
  }
  async commitAssignment(id, shouldStop) {
    let snapshot = this.get('v2_snapshots', id), intent = snapshot?.intent;
    if (!intent || stopped(shouldStop)) return;
    try {
      const view = await this.readSource(id); snapshot = this.observe(view);
      if (stopped(shouldStop)) return;
      if (view.owner && view.owner !== intent.owner) return; // observe() preserves the manual choice.
      if (!ready(view)) { this.put('v2_snapshots', { ...snapshot, phase: 'awaiting_details' }); return; }
      await this.refreshMembers();
      let member = this.config.members.find(member => member.id === intent.memberId && member.openId === intent.owner);
      if (!member || !member.enabled && !view.owner) { this.waitForSales(snapshot, intent); return; }
      const resolved = await this.resolveSource(), raw = await this.client.readRecord(this.config.tableIds.leads, id); let current = recordView(raw, resolved);
      snapshot = this.observe(current);
      if (stopped(shouldStop)) return;
      if (current.owner && current.owner !== intent.owner) return;
      if (!ready(current)) { this.put('v2_snapshots', { ...snapshot, phase: 'awaiting_details' }); return; }
      await this.refreshMembers();
      member = this.config.members.find(member => member.id === intent.memberId && member.openId === intent.owner);
      if (!member || !member.enabled && !current.owner) { this.waitForSales(snapshot, intent); return; }
      const latestFields = await this.resolveSource();
      if (digest(latestFields) !== digest(resolved)) fail('SOURCE_SCHEMA_CHANGED_BEFORE_WRITE');
      // An employee-table request may await the network. It must precede the
      // final source read, so an intervening manual owner change still wins.
      if(!current.owner&&this.staff){
        let permitted=false;
        try{permitted=!this.staffFailure&&await this.staff.verifyCandidate(member);}catch(error){this.review(id,safeCode(error),'staff_candidate');}
        if(!permitted){this.waitForSales(snapshot, intent, 'STAFF_CANDIDATE_NOT_READY');return;}
        if(digest(await this.resolveSource())!==digest(latestFields))fail('SOURCE_SCHEMA_CHANGED_DURING_STAFF_CHECK');
      }
      current = recordView(await this.client.readRecord(this.config.tableIds.leads, id), latestFields); snapshot = this.observe(current);
      if (current.owner && current.owner !== intent.owner) return;
      if (!ready(current)) { this.put('v2_snapshots', { ...snapshot, phase: 'awaiting_details' }); return; }
      await this.refreshMembers();
      member = this.config.members.find(member => member.id === intent.memberId && member.openId === intent.owner);
      if (!member || !member.enabled && !current.owner) { this.waitForSales(snapshot, intent); return; }
      if (stopped(shouldStop)) return;
      const display = this.assignmentDisplay(member, intent);
      const logical = { ...(!current.owner ? { owner: intent.owner } : {}), ...Object.fromEntries(Object.entries(display).filter(([key, value]) => current[key] !== value)) };
      if (Object.keys(logical).length) {
        this.put('v2_snapshots', { ...snapshot, intent: { ...intent, writeStarted: true } });
        await this.client.updateRecord(this.config.tableIds.leads, id, encodePatch(logical, resolved));
      }
      const confirmed = await this.readSource(id); snapshot = this.observe(confirmed);
      if (confirmed.owner !== intent.owner) return;
      if (Object.entries(display).some(([key, value]) => confirmed[key] !== value)) fail('ASSIGNMENT_DISPLAY_UNCONFIRMED');
      this.put('v2_snapshots', { ...snapshot, intent: null, displayPending: false, phase: 'assigned' });
    } catch (error) {
      if (missingSource(error)) { this.markMissing(id); return; }
      snapshot = this.get('v2_snapshots', id);
      if (snapshot?.intent) {
        const attempts = (snapshot.intent.attempts || 0) + 1;
        this.put('v2_snapshots', { ...snapshot, phase: snapshot.phase === 'awaiting_details' ? snapshot.phase : 'assigning', intent: { ...snapshot.intent, attempts, nextAttemptAt: this.now() + Math.min(300_000, 2000 * 2 ** Math.min(attempts, 8)) }, errorCode: safeCode(error) });
      }
      this.review(id, safeCode(error), 'assignment');
    }
  }
  async commitDisplay(id, shouldStop) {
    let snapshot = this.get('v2_snapshots', id);
    const member = this.config.members.find(member => member.openId === snapshot?.view.owner);
    if (!member) { this.review(id, 'OWNER_NOT_CONFIGURED', String(snapshot?.ownerVersion)); return; }
    if (stopped(shouldStop)) return;
    const resolved = await this.resolveSource(), current = recordView(await this.client.readRecord(this.config.tableIds.leads, id), resolved);
    snapshot = this.observe(current);
    if (current.owner !== member.openId || stopped(shouldStop)) return;
    await this.refreshMembers();
    const latestFields = await this.resolveSource();
    if (digest(latestFields) !== digest(resolved)) fail('SOURCE_SCHEMA_CHANGED_BEFORE_WRITE');
    await this.refreshMembers();
    const final = recordView(await this.client.readRecord(this.config.tableIds.leads, id), latestFields);
    snapshot = this.observe(final);
    if (final.owner !== current.owner) return;
    const latestMember = this.config.members.find(item => item.openId === final.owner);
    if (!latestMember) { this.review(id, 'OWNER_NOT_CONFIGURED', String(snapshot.ownerVersion)); return; }
    if (stopped(shouldStop)) return;
    const desired = this.assignmentDisplay(latestMember), patch = Object.fromEntries(Object.entries(desired).filter(([key, value]) => final[key] !== value));
    if (Object.keys(patch).length) {
      await this.client.updateRecord(this.config.tableIds.leads, id, encodePatch(patch, latestFields));
      const confirmed = await this.readSource(id);
      snapshot = this.observe(confirmed);
      if (confirmed.owner !== final.owner) return;
      if (Object.entries(desired).some(([key, value]) => confirmed[key] !== value)) fail('ASSIGNMENT_DISPLAY_UNCONFIRMED');
    }
    delete snapshot.displayNextAttemptAt;
    this.transaction(() => {
      this.put('v2_snapshots', { ...snapshot, displayPending: false });
      this.resolveReview(id, 'ASSIGNMENT_DISPLAY_UNCONFIRMED');
      for (const task of this.all('v2_outbox')) {
        if (task.recordId === id && task.kind === 'owner' && task.state === 'pending' && task.attempts === 0 &&
          task.errorCode === 'OWNER_RESULTS_PENDING' && this.taskCurrent(task, snapshot)) {
          this.put('v2_outbox', { ...task, nextAttemptAt: 0 });
        }
      }
    });
  }
  async notifyConfirmedMirrorStatuses(statusSources, shouldStop) {
    const confirmed = new Set();
    for (const view of statusSources) {
      if (stopped(shouldStop)) break;
      const prior = this.get('v2_snapshots', view.id);
      if (!prior || prior.deleted) continue;
      const receipt = this.unseenStatusWriteback(view, prior);
      if (!receipt || prior.view.owner !== receipt.owner || prior.view.wxStatus !== receipt.from ||
        view.owner !== receipt.owner || view.wxStatus !== receipt.to) continue;
      this.observe(view);
      confirmed.add(view.id);
    }
    if (confirmed.size) await this.drain(shouldStop, task => task.kind === 'status' && confirmed.has(task.recordId));
  }
  async drain(shouldStop, select = () => true) {
    if (!this.config.notification.enabled) return;
    const tasks = this.all('v2_outbox').filter(task => pending(task) && (!task.nextAttemptAt || task.nextAttemptAt <= this.now()) && select(task)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id)).slice(0, 50);
    for (const task of tasks) { if (stopped(shouldStop)) break; await this.deliver(task.id, shouldStop); }
  }
  wait(task, state, code, retryMilliseconds = this.config.pollSeconds * 1000) {
    this.put('v2_outbox', { ...task, state, errorCode: code, nextAttemptAt: this.now() + retryMilliseconds });
  }
  taskCurrent(task, snapshot) {
    if (!snapshot || snapshot.deleted) return false;
    if (task.kind === 'owner') return Boolean(snapshot.view.owner && snapshot.view.owner === task.owner && snapshot.ownerVersion === task.ownerVersion);
    if (task.kind === 'status') return Boolean(task.statusWritebackId && snapshot.statusVersion === task.statusVersion && operatorNoticeStatuses.has(snapshot.view.wxStatus));
    return Boolean(activeContact(snapshot.view) && snapshot.contactSignature && snapshot.contactSignature === task.contactSignature && snapshot.view.owner === task.owner);
  }
  validMirrorURL(result, member) {
    if (!result?.url || !result.targetRecordId || !member?.target) return false;
    try {
      const target = new URL(member.target.baseUrl), url = new URL(result.url);
      return url.origin === target.origin && url.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') && !url.username && !url.password && url.searchParams.get('table') === member.target.tableId && url.searchParams.get('record') === result.targetRecordId;
    } catch { return false; }
  }
  async deliver(id, shouldStop) {
    let task = this.get('v2_outbox', id);
    if (!task || !pending(task) || stopped(shouldStop)) return;
    let snapshot, view, member;
    try {
      view = await this.readSource(task.recordId); snapshot = this.observe(view); task = this.get('v2_outbox', id);
      if (!task || !pending(task)) return;
      if (!this.taskCurrent(task, snapshot)) {
        const reason = task.kind === 'status' && !task.statusWritebackId ? 'STATUS_ORIGIN_UNVERIFIED' : 'EVENT_SUPERSEDED';
        this.put('v2_outbox', { ...task, state: 'cancelled', errorCode: reason });
        return;
      }
      await this.refreshMembers();
      if (task.kind === 'owner' || task.kind === 'contact') {
        if (!ready(view)) { this.wait(task, 'waiting_details', 'DETAILS_REQUIRED'); return; }
        member = this.config.members.find(member => member.openId === view.owner);
        if (!member || !member.target) { this.wait(task, 'waiting_member', 'OWNER_NOT_CONFIGURED'); this.review(view.id, 'OWNER_NOT_CONFIGURED', String(snapshot.ownerVersion)); return; }
        this.resolveReview(view.id, 'OWNER_NOT_CONFIGURED');
        if (snapshot.intent || task.kind === 'owner' && snapshot.displayPending) {
          const resultsRetryAt = snapshot.intent?.nextAttemptAt || snapshot.displayNextAttemptAt || 0;
          this.wait(task, 'pending', 'OWNER_RESULTS_PENDING', Math.max(4000, resultsRetryAt - this.now()));
          return;
        }
      }
      if (task.kind === 'owner') {
        if (!this.mirror) { this.wait(task, 'waiting_mirror', 'MIRROR_NOT_CONFIGURED'); return; }
        if (stopped(shouldStop)) return;
        const target = await this.mirror.ensure(view, { shouldStop });
        if (!this.validMirrorURL(target, member)) fail('MIRROR_URL_INVALID');
        view = await this.readSource(task.recordId); snapshot = this.observe(view); task = this.get('v2_outbox', id);
        if (!task || !pending(task) || !this.taskCurrent(task, snapshot) || !ready(view)) return;
        await this.refreshMembers();
        member = this.config.members.find(member => member.openId === view.owner);
        if (!member?.target || !this.validMirrorURL(target, member)) fail('MEMBER_BINDING_CHANGED');
      }
      const recipient = task.kind === 'owner' ? view.owner : view.operator;
      if (!recipient) { this.wait(task, 'waiting_operator', 'OPERATOR_REQUIRED'); return; }
      if (stopped(shouldStop)) return;
      if (task.kind === 'contact' && this.hasSalesWechat() && !task.delivery && !member.salesWechat) {
        this.wait(task, 'waiting_member', 'SALES_WECHAT_REQUIRED'); return;
      }
      const draft = task.kind === 'owner' ? { recipientOpenId: recipient, title: this.config.notification.title, text: `您有一条${task.ownerVersion > 1 ? '转派' : '新'}客资，请及时跟进。\n客户微信号：${view.wx}\n客户需求：${view.needs}\n添加方式：${view.addMethod || '未填写'}\n所属账号：${view.account || '未填写'}`, url: '' }
        : task.kind === 'status' ? { recipientOpenId: recipient, title: '客资微信状态有变化', text: `客户微信号：${view.wx || '未填写'}\n微信状态：${view.wxStatus}`, url: '' }
        : this.hasSalesWechat() ? { recipientOpenId: recipient, title: '客资已分配', text: `客资已分配给销售【${member.displayName}】\n请复制他的微信号，发给客户：【${member.salesWechat || ''}】`, url: '' }
        : { recipientOpenId: recipient, title: '客户主动添加销售', text: `实际销售：${member.displayName}\n客户微信号：${view.wx}`, url: '' };
      if (task.delivery && task.delivery.recipientOpenId !== draft.recipientOpenId) { this.put('v2_outbox', { ...task, state: 'cancelled', errorCode: 'RECIPIENT_CHANGED' }); return; }
      const firstAttemptAt = task.firstAttemptAt || this.now();
      if (this.now() - firstAttemptAt >= 55 * 60_000) { this.put('v2_outbox', { ...task, state: 'review', errorCode: 'MESSAGE_RETRY_WINDOW_EXCEEDED' }); this.review(task.recordId, 'MESSAGE_RETRY_WINDOW_EXCEEDED', task.id); return; }
      task = { ...task, state: 'sending', attempts: task.attempts + 1, firstAttemptAt, delivery: task.delivery || draft };
      this.put('v2_outbox', task);
      try {
        const sent = await this.client.sendNotification({ ...task.delivery, idempotencyKey: task.id });
        if (!sent?.messageId) fail('MESSAGE_RESULT_UNKNOWN');
        this.put('v2_outbox', { ...task, state: 'sent', sentAt: this.stamp(), messageId: sent.messageId, errorCode: '' });
      } catch (error) {
        const definite = /^\d+$/.test(String(error?.code || ''));
        const retry = definite && task.attempts < 8;
        this.put('v2_outbox', { ...task, state: retry ? 'pending' : 'review', errorCode: definite ? 'MESSAGE_REJECTED' : 'SEND_OUTCOME_UNKNOWN', nextAttemptAt: this.now() + Math.min(300_000, 2000 * 2 ** task.attempts) });
        if (!retry) this.review(task.recordId, definite ? 'MESSAGE_REJECTED' : 'SEND_OUTCOME_UNKNOWN', task.id);
      }
    } catch (error) {
      if (missingSource(error)) { this.markMissing(task.recordId); return; }
      if (safeCode(error) === 'MIRROR_STOP_REQUESTED') return;
      task = this.get('v2_outbox', id) || task;
      if (!pending(task)) return;
      if (MIRROR_MANUAL.has(safeCode(error)) || safeCode(error) === 'MIRROR_URL_INVALID') { this.put('v2_outbox', { ...task, state: 'review', errorCode: safeCode(error) }); this.review(task.recordId, safeCode(error), task.id); }
      else this.wait(task, 'waiting_mirror', safeCode(error), 30_000);
    }
  }
  nextRetryAt() {
    const due = [];
    if (this.meta('mirror_rescan_needed') || this.all('v2_inbox').some(event => event.state === 'pending')) due.push(this.now() + 1000);
    const mirrorRetry = this.mirror?.status?.()?.nextRetryAt ?? this.meta('mirror_status')?.nextRetryAt;
    if (Number.isSafeInteger(mirrorRetry) && mirrorRetry > 0) due.push(mirrorRetry);
    const staffRetry=this.staff?.status?.()?.nextRetryAt;
    if(Number.isSafeInteger(staffRetry)&&staffRetry>0)due.push(staffRetry);
    const operatorRetry = this.meta('operator_mirror_status')?.nextRetryAt;
    if (Number.isSafeInteger(operatorRetry) && operatorRetry > 0) due.push(operatorRetry);
    for (const snapshot of this.all('v2_snapshots')) {
      if (snapshot.deleted) continue;
      if (snapshot.intent && !snapshot.blocked && ready(snapshot.view) && ['assigning', 'assigned'].includes(snapshot.phase)) due.push(snapshot.intent.nextAttemptAt || this.now());
      if (!snapshot.intent && snapshot.displayPending && snapshot.displayNextAttemptAt > 0 && this.config.members.some(member => member.openId === snapshot.view.owner)) due.push(snapshot.displayNextAttemptAt);
    }
    for (const task of this.all('v2_outbox')) if (pending(task)) due.push(task.nextAttemptAt || this.now());
    return due.length ? Math.min(...due) : null;
  }
  status() {
    const records = {}, notifications = {};
    for (const snapshot of this.all('v2_snapshots')) records[snapshot.phase] = (records[snapshot.phase] || 0) + 1;
    for (const task of this.all('v2_outbox')) notifications[task.state] = (notifications[task.state] || 0) + 1;
    return { initialized: Boolean(this.meta('initialized')), busy: Boolean(this.inFlight), records, notifications, counts: { ...Object.fromEntries(Object.entries(records).map(([key, value]) => [`records_${key}`, value])), ...Object.fromEntries(Object.entries(notifications).map(([key, value]) => [`notifications_${key}`, value])) },
      reviews: this.all('v2_reviews').filter(review => review.state === 'open').length, eventsPending: this.all('v2_inbox').filter(event => event.state === 'pending').length,
      staffEventsPending:this.staffEvents().filter(event=>event.state==='pending').length,
      nextRetryAt: this.nextRetryAt(), lastScan: this.meta('last_scan'), mirror: this.meta('mirror_status') || {},
      operatorMirror: this.meta('operator_mirror_status') || {}, ...(this.staff?{staff:this.staff.status()}:{} ) };
  }
  async close() { if (this.closed) return; try { if (this.inFlight) await this.inFlight; } finally { this.closed = true;try{await this.staff?.close?.();}finally{this.db.close();} } }
}
