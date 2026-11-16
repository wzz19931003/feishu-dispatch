import { normalizeRecordEvent } from '../lib/feishu.mjs';

const EVENT = 'drive.file.bitable_record_changed_v1';
const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {} };
const failure = code => Object.assign(new Error(code), { code });

/** Exactly one connection receives only the explicitly configured master/child tables. */
export class WorkflowEvents {
  constructor(config, { sdkLoader = () => import('@larksuiteoapi/node-sdk'), timeoutMs = 30000 } = {}) {
    this.config = config; this.sdkLoader = sdkLoader; this.timeoutMs = timeoutMs;
    this.session = null; this.stopping = null; this.last = 'idle';
  }
  allows(event) {
    const allowed = new Set([`${this.config.appToken}/${this.config.tableIds.leads}`,
      ...this.config.members.filter(m => m.target).map(m => `${m.target.appToken}/${m.target.tableId}`),
      ...(this.config.staffManagement?.enabled?[`${this.config.staffManagement.appToken}/${this.config.staffManagement.tableId}`]:[])]);
    return allowed.has(`${event.appToken}/${event.tableId}`);
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
