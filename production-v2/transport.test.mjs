import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FeishuClient } from '../lib/feishu.mjs';
import { WorkflowClient } from './client.mjs';
import { WorkflowEngine } from './engine.mjs';
import { createEngine } from './cli.mjs';
import { captureSchema } from './capture-schema.mjs';
import { workflowConfig } from './test-fixtures.mjs';

const endpoint = 'https://open.feishu.cn/open-apis/bitable/v1/apps/OfflineSourceToken123/tables/tblOfflineLeads123/records/recOffline';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after': '1' } });

test('v2 PUT rate limit returns after one write with no sleep or stale ownership/schema replay', async () => {
  let writes = 0, sleeps = 0, unrelatedOverwritten = false, owner = 'owner-a', originalNameIsOwner = true;
  const client = new WorkflowClient({}, { retryMutations: true, sleepImpl: async () => { sleeps++; }, fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'PUT'); writes++;
    const body = JSON.parse(options.body);
    if (writes === 1) {
      // Another user transfers ownership and reuses the old column name while
      // the first attempt is rate limited. Retrying this frozen body is unsafe.
      owner = 'owner-b'; originalNameIsOwner = false;
      return response({ code: 99991400, msg: 'PRIVATE_UPSTREAM_FIXTURE' }, 429);
    }
    if (!originalNameIsOwner && body.fields.Owner) unrelatedOverwritten = true;
    owner = body.fields.Owner;
    return response({ code: 0 });
  } });
  await assert.rejects(client.request(endpoint, { method: 'PUT', body: { fields: { Owner: 'owner-a' } } }), error => error.code === '99991400' && error.retryable === true && !error.message.includes('PRIVATE_UPSTREAM_FIXTURE'));
  assert.equal(client.retryMutations, false); assert.equal(writes, 1); assert.equal(sleeps, 0);
  assert.equal(owner, 'owner-b'); assert.equal(unrelatedOverwritten, false);
});

test('v2 POST and DELETE rate limits are never replayed inside transport', async () => {
  for (const method of ['POST', 'DELETE', 'PATCH', 'post', 'delete']) {
    let attempts = 0, sleeps = 0;
    const client = new WorkflowClient({}, { sleepImpl: async () => { sleeps++; }, fetchImpl: async () => { attempts++; return response({ code: 99991400 }, 429); } });
    await assert.rejects(client.request(endpoint, { method, body: { fields: { fixture: 'only' } } }), { code: '99991400' });
    assert.equal(attempts, 1, method); assert.equal(sleeps, 0, method);
  }
});

test('v2 createRecord and sendNotification propagate one rate-limited mutation to the durable caller', async () => {
  for (const action of ['create', 'message']) {
    const requests = []; let sleeps = 0;
    const client = new WorkflowClient(workflowConfig(), { sleepImpl: async () => { sleeps++; }, fetchImpl: async (url, options) => {
      if (String(url).includes('/oauth/v3/token')) return response({ access_token: 'offline-token', expires_in: 3600 });
      requests.push({ method: options.method, path: new URL(url).pathname, body: JSON.parse(options.body) });
      return response({ code: 99991400 }, 429);
    } });
    const operation = action === 'create'
      ? client.createRecord('tblOfflineLeads123', { Fixture: 'only' }, { clientToken: '12345678-1234-4234-8234-123456789abc' })
      : client.sendNotification({ recipientOpenId: 'ou_offlineSalesA', title: 'Offline fixture', text: 'No network', idempotencyKey: 'offline-key' });
    await assert.rejects(operation, { code: '99991400' });
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST'); assert.equal(sleeps, 0);
  }
});

test('v2 JSON-code rate limiting cannot replay a mutation even when HTTP status is 200', async () => {
  let attempts = 0, sleeps = 0;
  const client = new WorkflowClient({}, { sleepImpl: async () => { sleeps++; }, fetchImpl: async () => { attempts++; return response({ code: 99991400 }); } });
  await assert.rejects(client.request(endpoint, { method: 'PUT', body: {} }), { code: '99991400' });
  assert.equal(attempts, 1); assert.equal(sleeps, 0);
});

test('v2 GET and HEAD retain bounded rate-limit retries', async () => {
  for (const method of ['GET', 'HEAD', 'get', 'head']) {
    let attempts = 0; const delays = [];
    const client = new WorkflowClient({}, { sleepImpl: async ms => { delays.push(ms); }, fetchImpl: async () => {
      attempts++; return attempts === 1 ? response({ code: 99991400 }, 429) : response({ code: 0, data: { safe: true } });
    } });
    assert.deepEqual(await client.request(endpoint, { method }), { code: 0, data: { safe: true } });
    assert.equal(attempts, 2); assert.deepEqual(delays, [1000]);
  }
  let attempts = 0; const delays = [];
  const limited = new WorkflowClient({}, { sleepImpl: async ms => delays.push(ms), fetchImpl: async () => { attempts++; return response({ code: 99991400 }, 429); } });
  await assert.rejects(limited.request(endpoint), { code: '99991400' }); assert.equal(attempts, 4); assert.equal(delays.length, 3);
});

test('v1 default mutation retry remains compatible while explicit opt-out is honored', async () => {
  for (const retryMutations of [undefined, true, false]) {
    let attempts = 0; const delays = [];
    const client = new FeishuClient({}, { ...(retryMutations === undefined ? {} : { retryMutations }), sleepImpl: async ms => delays.push(ms), fetchImpl: async () => {
      attempts++; return attempts === 1 ? response({ code: 99991400 }, 429) : response({ code: 0 });
    } });
    if (retryMutations === false) { await assert.rejects(client.request(endpoint, { method: 'PUT', body: {} }), { code: '99991400' }); assert.equal(attempts, 1); assert.equal(delays.length, 0); }
    else { assert.deepEqual(await client.request(endpoint, { method: 'PUT', body: {} }), { code: 0 }); assert.equal(attempts, 2); assert.equal(delays.length, 1); }
  }
});

test('v2 engine default and CLI source/child factories use mutation-strict WorkflowClient without network', async () => {
  const engine = new WorkflowEngine({ config: workflowConfig(), dbPath: ':memory:' });
  try { assert.ok(engine.client instanceof WorkflowClient); assert.equal(engine.client.retryMutations, false); } finally { await engine.close(); }
  let mirrorOptions, engineOptions;
  class FakeEngine { constructor(options) { engineOptions = options; this.config = options.config; this.db = {}; } async close() {} }
  class FakeMirror { constructor(options) { mirrorOptions = options; } }
  const created = await createEngine(workflowConfig(), { root: tmpdir(), Engine: FakeEngine, Mirror: FakeMirror });
  try {
    assert.ok(engineOptions.client instanceof WorkflowClient); assert.equal(engineOptions.client.retryMutations, false);
    const child = mirrorOptions.clientFactory(workflowConfig().members[0].target.appToken);
    assert.ok(child instanceof WorkflowClient); assert.equal(child.retryMutations, false);
  } finally { await created.close(); }
});

test('schema-capture default client uses strict POST auth and performs no hidden retry or output on limit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-transport-')), configFile = path.join(root, 'fixture.json'), to = path.join(root, 'schema.json');
  const previousFetch = globalThis.fetch; let attempts = 0;
  try {
    writeFileSync(configFile, JSON.stringify(workflowConfig()));
    globalThis.fetch = async (_url, options) => { attempts++; assert.equal(options.method, 'POST'); return response({ code: 99991400 }, 429); };
    await assert.rejects(captureSchema({ configFile, to }), { code: '99991400' });
    assert.equal(attempts, 1); assert.equal(existsSync(to), false);
  } finally {
    globalThis.fetch = previousFetch;
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(root, { recursive: true, force: true });
  }
});
