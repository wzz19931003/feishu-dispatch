import { normalizeRecordEvent } from '../lib/feishu.mjs';

const EVENT = 'drive.file.bitable_record_changed_v1';
const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {} };
const failure = code => Object.assign(new Error(code), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const statusTargets = new Set(['未通过', '号码错误', '主动加未添加']);

function statusValue(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  // Event field_value is serialized JSON, rather than an editable display-name claim.
  if (Array.isArray(value) && value.length === 1 && object(value[0]) && value[0].type === 'text') value = value[0].text;
  return typeof value === 'string' && value.length <= 200 && !/[\r\n\0]/.test(value) ? value.trim() : null;
}

function masterStatusEdits(input, normalized, config) {
  if (normalized.appToken !== config.appToken || normalized.tableId !== config.tableIds?.leads) return [];
  const event = input?.event ?? input;
  if (!object(event) || !Array.isArray(event.action_list) || event.action_list.length > 1000) return [];
  const fields = config.fields?.leads;
  const fieldIds = ['wxStatus', 'owner', 'operator'].map(key => fields?.[key]?.fieldId);
  if (fieldIds.some(id => typeof id !== 'string' || !/^fld[A-Za-z0-9]{5,}$/.test(id)) || new Set(fieldIds).size !== 3) return [];
  const [statusId, ownerId, operatorId] = fieldIds;
  const actor = event.operator_id?.open_id, revision = event.revision;
  if (typeof actor !== 'string' || !/^ou_[A-Za-z0-9_-]{5,100}$/.test(actor) || !Number.isSafeInteger(revision) || revision <= 0
    || !Number.isSafeInteger(event.update_time) || event.update_time <= 0) return [];
  const editedAt = event.update_time * 1000;
  if (!Number.isSafeInteger(editedAt)) return [];
  const counts = new Map();
  for (const action of event.action_list) if (typeof action?.record_id === 'string') counts.set(action.record_id, (counts.get(action.record_id) || 0) + 1);
  const edits = [];
  for (const action of event.action_list) {
    const id = action?.record_id, before = action?.before_value, after = action?.after_value;
    if (action?.action !== 'record_edited' || typeof id !== 'string' || !/^rec[A-Za-z0-9]{5,100}$/.test(id) || counts.get(id) !== 1
      || !Array.isArray(before) || !Array.isArray(after) || before.length > 1000 || after.length > 1000
      || !before.every(object) || !after.every(object)) continue;
    if ([...before, ...after].some(field => field.field_id === ownerId || field.field_id === operatorId)) continue;
    const oldFields = before.filter(field => field.field_id === statusId), newFields = after.filter(field => field.field_id === statusId);
    if (oldFields.length !== 1 || newFields.length !== 1) continue;
    const from = statusValue(oldFields[0].field_value), to = statusValue(newFields[0].field_value);
    if (from === null || to === null || from === to || !statusTargets.has(to)) continue;
    edits.push({ recordId: id, actor, revision, editedAt, from, to });
  }
  return edits;
}

/** Exactly one connection receives only the explicitly configured master/child tables. */
export class WorkflowEvents {
  constructor(config, { sdkLoader = () => import('@larksuiteoapi/node-sdk'), timeoutMs = 30000, currentConfig = () => config } = {}) {
    this.config = config; this.sdkLoader = sdkLoader; this.timeoutMs = timeoutMs;
    this.currentConfig = currentConfig;
    this.session = null; this.stopping = null; this.last = 'idle';
  }
  allows(event) {
    const config = this.currentConfig();
    const matches = (appToken, tableId) => event.appToken === appToken && event.tableId === tableId;
    const staff = config.staffManagement;
    return matches(config.appToken, config.tableIds.leads) ||
      config.members.some(member => member.target && matches(member.target.appToken, member.target.tableId)) ||
      Boolean(staff?.enabled && matches(staff.appToken, staff.tableId));
  }
  status() { return { state: this.session?.state || this.last }; }
  async start(onEvent) {
    if (this.session || this.stopping || typeof onEvent !== 'function') throw failure('EVENT_SESSION_INVALID');
    const session = { active: true, state: 'connecting', pending: new Set(), client: null, finish: null };
    this.session = session;
    try {
      const imported = await this.sdkLoader(), sdk = imported.WSClient ? imported : imported.default;
      if (!session.active) throw failure('EVENT_STREAM_STOPPED');
      if (!sdk?.WSClient || !sdk.EventDispatcher) throw failure('SDK_INVALID');
      if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw failure('EVENT_TIMEOUT_INVALID');
      let resolveReady, rejectReady, settled = false;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      ready.catch(() => {});
      const timer = setTimeout(() => session.finish(failure('EVENT_READY_TIMEOUT')), this.timeoutMs);
      session.finish = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        session.state = error ? 'failed' : 'connected';
        if (error) rejectReady(error); else resolveReady();
      };
      const dispatcher = new sdk.EventDispatcher({ logger: quiet }).register({ [EVENT]: async data => {
        if (!session.active) return;
        const event = normalizeRecordEvent(data);
        if (!this.allows(event)) return;
        const statusEdits = masterStatusEdits(data, event, this.currentConfig());
        if (statusEdits.length) event.statusEdits = statusEdits;
        const pending = Promise.resolve().then(() => onEvent(event));
        session.pending.add(pending);
        try { await pending; } catch { session.state = 'handler_error'; throw failure('EVENT_HANDLER_FAILED'); } finally { session.pending.delete(pending); }
      } });
      session.client = new sdk.WSClient({ appId: this.config.appId, appSecret: this.config.appSecret, logger: quiet,
        handshakeTimeoutMs: Math.min(10000, this.timeoutMs),
        onReady: () => { if (session.active) session.finish(); },
        onError: () => { if (session.active) { session.state = 'failed'; session.finish(failure('EVENT_CONNECTION_FAILED')); } },
        onReconnecting: () => { if (session.active) session.state = 'reconnecting'; },
        onReconnected: () => { if (session.active) session.state = 'connected'; },
      });
      if (typeof session.client.close !== 'function') throw failure('SDK_CLOSE_UNAVAILABLE');
      try { Promise.resolve(session.client.start({ eventDispatcher: dispatcher })).catch(() => session.finish(failure('EVENT_START_FAILED'))); }
      catch { session.finish(failure('EVENT_START_FAILED')); }
      await ready;
      if (!session.active) throw failure('EVENT_STREAM_STOPPED');
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    const session = this.session;
    if (!session) { this.last = 'stopped'; return; }
    session.active = false; session.finish?.(failure('EVENT_STREAM_STOPPED'));
    this.stopping = (async () => {
      try { try { await session.client?.close({ force: true }); } finally { await Promise.allSettled([...session.pending]); } }
      finally { this.session = null; this.last = 'stopped'; this.stopping = null; }
    })();
    return this.stopping;
  }
}
