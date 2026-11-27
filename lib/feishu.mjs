import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const OPEN_API = 'https://open.feishu.cn';
const TOKEN_V3 = 'https://accounts.feishu.cn/oauth/v3/token';
const TOKEN_TENANT_LEGACY = `${OPEN_API}/open-apis/auth/v3/tenant_access_token/internal`;
const TOKEN_USER_LEGACY = `${OPEN_API}/open-apis/authen/v2/oauth/token`;
const RECORD_EVENT = 'drive.file.bitable_record_changed_v1';

export class FeishuError extends Error {
  constructor(code, status = 502, retryable = false) {
    const safeCode = String(code ?? 'UNKNOWN').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 80) || 'UNKNOWN';
    super(`飞书接口调用失败（${safeCode}）`);
    this.name = 'FeishuError';
    this.code = safeCode;
    this.status = status;
    this.retryable = retryable;
  }
}

function required(value, key) {
  if (typeof value !== 'string' || !value.trim()) throw new FeishuError(`CONFIG_${key}_REQUIRED`, 503);
  return value.trim();
}

function segment(value, key) {
  const text = required(value, key);
  if (text.length > 300) throw new FeishuError(`INVALID_${key}`, 400);
  return encodeURIComponent(text);
}

function callbackUrl(redirectUri) {
  let callback;
  try { callback = new URL(redirectUri); } catch { throw new FeishuError('INVALID_REDIRECT_URI', 400); }
  if (callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(callback.hostname))) {
    throw new FeishuError('INVALID_REDIRECT_URI', 400);
  }
  if (callback.username || callback.password || callback.hash) throw new FeishuError('INVALID_REDIRECT_URI', 400);
  return callback.href;
}

// EventDispatcher SDK versions may pass an event body or a body merged with headers.
// Keep only identifiers; the worker retrieves authoritative record fields separately.
export function normalizeRecordEvent(input) {
  const event = input?.event ?? input ?? {};
  const header = input?.header ?? {};
  const actions = (Array.isArray(event.action_list) ? event.action_list : []).map(action => ({
    action: String(action.action ?? ''),
    recordId: String(action.record_id ?? action.recordId ?? ''),
  })).filter(action => action.recordId);
  const ids = [...new Set(actions.map(action => action.recordId))];
  const fallbackId = createHash('sha256').update(JSON.stringify({
    file: event.file_token ?? event.app_token,
    table: event.table_id,
    actions: event.action_list,
    at: header.create_time ?? event.create_time,
  })).digest('hex');
  return {
    id: String(header.event_id ?? input?.event_id ?? event.event_id ?? fallbackId),
    type: String(header.event_type ?? input?.event_type ?? RECORD_EVENT),
    appToken: String(event.file_token ?? event.app_token ?? ''),
    tableId: String(event.table_id ?? ''),
    recordIds: ids,
    actions,
    occurredAt: String(header.create_time ?? event.create_time ?? ''),
  };
}

/** REST and optional official SDK adapter. Construction never sends a request. */
export class FeishuClient {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? sleep;
    // v1 keeps its historical rate-limit retry behavior. Workflow v2 disables
    // transport-level mutation retries so durable jobs can re-check ownership
    // and field IDs before the next explicit write attempt.
    this.retryMutations = options.retryMutations !== false;
    this.now = options.now ?? Date.now;
    this.sdkLoader = options.sdkLoader ?? (() => import('@larksuiteoapi/node-sdk'));
    this.eventReadyTimeoutMs = options.eventReadyTimeoutMs ?? config.eventReadyTimeoutMs ?? 30_000;
    this.cachedToken = null;
    this.tokenPromise = null;
    this.wsClient = null;
    this.eventCallback = null;
    this.eventSession = null;
    this.eventStopPromise = null;
  }

  credentials() {
    return {
      appId: required(this.config.appId, 'APP_ID'),
      appSecret: required(this.config.appSecret, 'APP_SECRET'),
    };
  }

  authorizationUrl(state, redirectUri) {
    const appId = required(this.config.appId, 'APP_ID');
    if (typeof state !== 'string' || state.length < 16 || state.length > 512) throw new FeishuError('INVALID_OAUTH_STATE', 400);
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', callbackUrl(redirectUri));
    url.searchParams.set('state', state);
    // Identity login needs no user-side document or offline grant. Explicit identity
    // scopes, when required by the app's current tenant setup, are configuration only.
    if (this.config.identityScope) url.searchParams.set('scope', String(this.config.identityScope));
    return url.href;
  }

  async request(url, { method = 'GET', body, headers = {} } = {}) {
    // Every endpoint is fixed by this module. Never accept a caller-provided origin.
    const target = new URL(url);
    if (![OPEN_API, 'https://accounts.feishu.cn'].includes(target.origin)) {
      throw new FeishuError('INVALID_API_ORIGIN', 400);
    }
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response;
      try {
        response = await this.fetch(target, {
          method,
          body: encoded,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
      } catch {
        // Do not expose upstream exceptions, URLs, request bodies or tokens.
        throw new FeishuError('NETWORK_OR_TIMEOUT', 502, true);
      }
      let json;
      try {
        json = await response.json();
      } catch {
        throw new FeishuError('INVALID_JSON_RESPONSE', 502, response.status >= 500);
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new FeishuError('INVALID_JSON_RESPONSE', 502, false);
      }
      const limited = response.status === 429 || json?.code === 99991400;
      const canRetry = this.retryMutations !== false || ['GET', 'HEAD'].includes(String(method).toUpperCase());
      if (limited && attempt < 3 && canRetry) {
        const retryHeader = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryHeader) && retryHeader > 0
          ? Math.min(retryHeader * 1000, 5000)
          : 250 * 2 ** attempt;
        await this.sleep(delay);
        continue;
      }
      if (!response.ok || (json?.code !== undefined && json.code !== 0) || json?.error) {
        throw new FeishuError(json?.code ?? json?.error ?? `HTTP_${response.status}`, response.status === 429 ? 429 : 502, limited || response.status >= 500);
      }
      return json;
    }
    throw new FeishuError('RATE_LIMIT', 429, true);
  }

  async tenantToken() {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) return this.cachedToken.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const { appId, appSecret } = this.credentials();
      const legacy = this.config.oauthVersion === 'legacy';
      const result = await this.request(legacy ? TOKEN_TENANT_LEGACY : TOKEN_V3, {
        method: 'POST',
        body: legacy
          ? { app_id: appId, app_secret: appSecret }
          : { grant_type: 'client_credentials', client_id: appId, client_secret: appSecret },
      });
      const value = result.access_token ?? result.tenant_access_token;
      const ttl = Number(result.expires_in ?? result.expire);
      if (typeof value !== 'string' || !value || !Number.isFinite(ttl) || ttl <= 0) {
        throw new FeishuError('INVALID_TOKEN_RESPONSE');
      }
      this.cachedToken = { value, expiresAt: this.now() + Math.max(1, ttl - 60) * 1000 };
      return value;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  async api(path, { method = 'GET', body, query } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/open-apis/') || path.includes('://') || path.startsWith('//')) {
      throw new FeishuError('INVALID_API_PATH', 400);
    }
    const url = new URL(path, OPEN_API);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const token = await this.tenantToken();
    const result = await this.request(url.href, { method, body, headers: { Authorization: `Bearer ${token}` } });
    return result.data ?? result;
  }

  async sendNotification({ recipientOpenId, title, text, url, idempotencyKey }) {
    const receiveId = required(recipientOpenId, 'RECIPIENT_OPEN_ID');
    const key = required(idempotencyKey, 'IDEMPOTENCY_KEY');
    const messageLines = [String(title ?? '').slice(0, 300), String(text ?? '').slice(0, 12_000)];
    if (url) {
      let link;
      try { link = new URL(url); } catch { throw new FeishuError('INVALID_MESSAGE_URL', 400); }
      if (link.protocol !== 'https:' && !(link.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(link.hostname))) {
        throw new FeishuError('INVALID_MESSAGE_URL', 400);
      }
      messageLines.push(link.href);
    }
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    const result = await this.api('/open-apis/im/v1/messages', {
      method: 'POST', query: { receive_id_type: 'open_id' },
      body: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: messageLines.filter(Boolean).join('\n') }), uuid },
    });
    const messageId = result.message_id;
    if (typeof messageId !== 'string' || !messageId) throw new FeishuError('INVALID_MESSAGE_RESPONSE');
    return { messageId };
  }

  tablePath(tableId) {
    return `/open-apis/bitable/v1/apps/${segment(this.config.appToken, 'APP_TOKEN')}/tables/${segment(tableId, 'TABLE_ID')}/records`;
  }

  async readRecord(tableId, recordId, { automaticFields = false } = {}) {
    const result = await this.api(`${this.tablePath(tableId)}/${segment(recordId, 'RECORD_ID')}`,
      automaticFields ? { query: { automatic_fields: true, user_id_type: 'open_id' } } : undefined);
    return result.record ?? result;
  }

  async listRecords(tableId, { pageToken, pageSize = 100 } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new FeishuError('INVALID_PAGE_SIZE', 400);
    const result = await this.api(this.tablePath(tableId), { query: { page_size: pageSize, page_token: pageToken } });
    return { items: result.items ?? [], hasMore: Boolean(result.has_more), pageToken: result.page_token ?? null };
  }

  async createRecord(tableId, fields, { clientToken } = {}) {
    // The outbox persists a randomUUID once and reuses it with frozen fields.
    // Never generate a fresh token here: an uncertain response may already have created a record.
    if (typeof clientToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientToken)) {
      throw new FeishuError('INVALID_CLIENT_TOKEN', 400);
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new FeishuError('INVALID_FIELDS', 400);
    const result = await this.api(this.tablePath(tableId), {
      method: 'POST', query: { client_token: clientToken }, body: { fields },
    });
    return result.record ?? result;
  }

  async searchRecords(tableId, { fieldName, value, pageToken, pageSize = 100 } = {}) {
    if (typeof fieldName !== 'string' || !fieldName.trim()) throw new FeishuError('INVALID_SEARCH_FIELD', 400);
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new FeishuError('INVALID_SEARCH_VALUE', 400);
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new FeishuError('INVALID_PAGE_SIZE', 400);
    const result = await this.api(`${this.tablePath(tableId)}/search`, {
      method: 'POST', query: { page_size: pageSize, page_token: pageToken },
      body: { filter: { conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [String(value)] }] } },
    });
    return { items: result.items ?? [], hasMore: Boolean(result.has_more), pageToken: result.page_token ?? null };
  }

  async updateRecord(tableId, recordId, fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new FeishuError('INVALID_FIELDS', 400);
    const result = await this.api(`${this.tablePath(tableId)}/${segment(recordId, 'RECORD_ID')}`, { method: 'PUT', body: { fields } });
    return result.record ?? result;
  }

  async exchangeCode(code, redirectUri) {
    const { appId, appSecret } = this.credentials();
    required(code, 'AUTHORIZATION_CODE');
    const callback = callbackUrl(redirectUri);
    const token = await this.request(this.config.oauthVersion === 'legacy' ? TOKEN_USER_LEGACY : TOKEN_V3, {
      method: 'POST',
      body: { grant_type: 'authorization_code', client_id: appId, client_secret: appSecret, code, redirect_uri: callback },
    });
    const userToken = token.access_token ?? token.data?.access_token;
    if (typeof userToken !== 'string' || !userToken) throw new FeishuError('INVALID_USER_TOKEN_RESPONSE');
    const user = await this.request(`${OPEN_API}/open-apis/authen/v1/user_info`, { headers: { Authorization: `Bearer ${userToken}` } });
    const data = user.data ?? user;
    if (typeof data.open_id !== 'string' || !data.open_id) throw new FeishuError('INVALID_USER_IDENTITY');
    // Only return identity. The caller maps openId to an enabled, allowlisted local user.
    return { openId: data.open_id, name: String(data.name ?? ''), tenantKey: data.tenant_key ? String(data.tenant_key) : undefined };
  }

  async startEventStream(onEvent) {
    if (this.eventSession || this.eventStopPromise) throw new FeishuError('EVENT_STREAM_ALREADY_STARTED', 409);
    if (typeof onEvent !== 'function') throw new FeishuError('EVENT_HANDLER_REQUIRED', 400);
    const { appId, appSecret } = this.credentials();
    const session = { active: true, pending: new Set(), client: null, connectionState: 'connecting', finishReady: null };
    this.eventSession = session;
    try {
      let imported;
      try { imported = await this.sdkLoader(); } catch { throw new FeishuError('OFFICIAL_SDK_NOT_INSTALLED', 503); }
      if (!session.active) throw new FeishuError('EVENT_STREAM_STOPPED', 503);
      const sdk = imported.WSClient ? imported : imported.default;
      if (!sdk?.WSClient || !sdk?.EventDispatcher) throw new FeishuError('OFFICIAL_SDK_INVALID', 503);
      const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, log() {} };
      const dispatcher = new sdk.EventDispatcher({ logger: quietLogger }).register({
        [RECORD_EVENT]: async data => {
          // A discarded dispatcher must stay inactive even after a new stream starts.
          if (!session.active) return;
          const event = normalizeRecordEvent(data);
          // Ignore other documents even if the app has accidentally been granted more.
          if (event.appToken !== this.config.appToken) return;
          const allowedTables = Object.values(this.config.tableIds ?? {}).filter(Boolean);
          if (!allowedTables.includes(event.tableId)) return;
          // Track accepted handlers so shutdown can drain before the database closes.
          const pending = Promise.resolve().then(() => onEvent(event));
          session.pending.add(pending);
          try { await pending; } finally { session.pending.delete(pending); }
        },
      });
      const readyTimeout = this.eventReadyTimeoutMs;
      if (!Number.isFinite(readyTimeout) || readyTimeout < 1 || readyTimeout > 120_000) throw new FeishuError('INVALID_EVENT_READY_TIMEOUT', 400);
      let settleReady, settled = false;
      const ready = new Promise((resolve, reject) => { settleReady = error => error ? reject(error) : resolve(); });
      // A constructor may synchronously call onError; attach a handler before it runs.
      ready.catch(() => {});
      const readyTimer = setTimeout(() => session.finishReady(new FeishuError('EVENT_STREAM_READY_TIMEOUT', 503, true)), readyTimeout);
      session.finishReady = error => {
        if (settled) return;
        settled = true; clearTimeout(readyTimer);
        session.connectionState = error ? 'failed' : 'connected';
        settleReady(error);
      };
      const client = new sdk.WSClient({ appId, appSecret, logger: quietLogger,
        handshakeTimeoutMs: Math.min(10_000, readyTimeout),
        onReady: () => { if (session.active) session.finishReady(); },
        onError: () => { if (session.active) { session.connectionState = 'failed'; session.finishReady(new FeishuError('EVENT_STREAM_CONNECTION_FAILED', 503, true)); } },
        onReconnecting: () => { if (session.active) session.connectionState = 'reconnecting'; },
        onReconnected: () => { if (session.active) session.connectionState = 'connected'; },
      });
      if (typeof client.close !== 'function') throw new FeishuError('OFFICIAL_SDK_CLOSE_UNAVAILABLE', 503);
      session.client = client;
      this.eventCallback = onEvent;
      this.wsClient = client;
      // Official WSClient.start() only schedules reConnect(); its resolved promise
      // does not prove a handshake succeeded. Only onReady fulfills this wait.
      try {
        Promise.resolve(client.start({ eventDispatcher: dispatcher })).catch(() => session.finishReady(new FeishuError('EVENT_STREAM_START_FAILED', 503, true)));
      } catch { session.finishReady(new FeishuError('EVENT_STREAM_START_FAILED', 503, true)); }
      await ready;
      if (!session.active) throw new FeishuError('EVENT_STREAM_STOPPED', 503);
      return client;
    } catch (error) {
      if (this.eventSession === session) await this.stopEventStream();
      if (error instanceof FeishuError) throw error;
      throw new FeishuError('EVENT_STREAM_START_FAILED', 503, true);
    }
  }

  async stopEventStream() {
    if (this.eventStopPromise) return this.eventStopPromise;
    const session = this.eventSession;
    if (!session) return;
    // Reject late SDK delivery synchronously, before any await or network close.
    session.active = false;
    session.finishReady?.(new FeishuError('EVENT_STREAM_STOPPED', 503));
    this.eventSession = null;
    this.wsClient = null;
    this.eventCallback = null;
    const stopping = (async () => {
      let closeFailed = false;
      try { await session.client?.close({ force: true }); } catch { closeFailed = true; }
      await Promise.allSettled([...session.pending]);
      if (closeFailed) throw new FeishuError('EVENT_STREAM_STOP_FAILED', 503);
    })();
    this.eventStopPromise = stopping;
    try { await stopping; } finally {
      if (this.eventStopPromise === stopping) this.eventStopPromise = null;
    }
  }

  eventStreamStatus() {
    const session = this.eventSession;
    if (!session?.active) return { state: 'idle' };
    try {
      const state = session.client?.getConnectionStatus?.()?.state;
      if (['idle', 'connecting', 'connected', 'reconnecting', 'failed'].includes(state)) return { state };
    } catch { /* A status snapshot must never expose SDK exceptions or credentials. */ }
    return { state: session.connectionState };
  }
}
