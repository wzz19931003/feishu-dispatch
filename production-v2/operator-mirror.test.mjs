import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { OperatorMirror } from './operator-mirror.mjs';
import { OPERATOR_TARGET_NAMES, StaffAdminClient } from './staff-admin-client.mjs';

const clone = value => structuredClone(value);
const operatorA = { openId: 'ou_offline_operator_A123', displayName: '离线运营甲', enabled: true, ready: true, role: 'operator' };
const operatorB = { openId: 'ou_offline_operator_B123', displayName: '离线运营乙', enabled: true, ready: true, role: 'operator' };
const definitions = { wx: 1, needs: 1, wxStatus: 3, addMethod: 3, partySize: 1, account: 3, channel: 3, leadSource: 3, leadDate: 5, salesName: 1 };
const options = { wxStatus: ['待添加', '通过', '未通过', '号码错误', '主动加未添加'], addMethod: ['客户主动加', '销售主动加'],
  account: ['官方账号'], channel: ['自然渠道'], leadSource: ['自然流', '付费'] };
const error = code => Object.assign(new Error('private-detail-never-export'), { code });
function configuration() {
  return { appId: 'cli_operator_offline', appToken: 'OfflineSourceBase123', tableIds: { leads: 'tblSourceOffline123' },
    baseUrl: 'https://offline.feishu.cn/base/OfflineSourceBase123', staffManagement: { appToken: 'OfflineStaffBase123', operatorViews: { enabled: true } },
    enabled: true, members: [{ target: { appToken: 'OfflineSalesBase123' } }],
    fields: { leads: Object.fromEntries(Object.entries(definitions).map(([key, type]) => [key, { fieldId: `fldSource${key}123`, types: [type] }])) } };
}
function lead(number, operator = operatorA.openId) {
  return { id: `recOperatorLead${number}123`, operator, wx: `fake-wx-${number}`, needs: '合成需求', wxStatus: '待添加', addMethod: '销售主动加',
    partySize: '2', account: '官方账号', channel: '自然渠道', leadSource: '自然流', leadDate: 1_700_000_000_000, salesName: '离线销售' };
}
class OfflineAdmin {
  constructor(config) {
    this.config = config;
    this.bases = new Map();
    this.calls = [];
    this.sequence = 0;
    this.recordSequence = 0;
    this.hook = null;
  }
  async mutation(operation, beforeMutation) {
    try { await beforeMutation?.(); }
    catch (e) { e.staffMutationAttempted = false; throw e; }
    try { return await operation(); }
    catch (e) { e.staffMutationAttempted = true; throw e; }
  }
  async createBase({ name, beforeMutation }) {
    return this.mutation(async () => {
      this.calls.push({ method: 'base', name });
      const appToken = `OfflineOperatorBase${++this.sequence}123`;
      this.bases.set(appToken, { sharing: { externalAccessEntity: 'open', linkShareEntity: 'tenant_editable', manageCollaboratorEntity: 'collaborator_can_view' },
        members: [{ memberType: 'appid', openId: this.config.appId, perm: 'full_access', isApp: true }], fields: [], records: new Map() });
      await this.hook?.('base', { appToken });
      return { appToken };
    }, beforeMutation);
  }
  async setPrivateSharing(token, { beforeMutation }) {
    return this.mutation(async () => {
      this.calls.push({ method: 'sharing', token });
      this.bases.get(token).sharing = { externalAccessEntity: 'closed', linkShareEntity: 'closed', manageCollaboratorEntity: 'collaborator_full_access' };
    }, beforeMutation);
  }
  async createOperatorTable(token, { beforeMutation }) {
    return this.mutation(async () => {
      this.calls.push({ method: 'table', token });
      const fields = {};
      const schema = [];
      for (const [key, type] of Object.entries(definitions)) {
        const fieldId = `fldOperator${this.sequence}${key}123`;
        fields[key] = { fieldId, types: [type] };
        schema.push({ field_id: fieldId, field_name: OPERATOR_TARGET_NAMES[key], type,
          property: options[key] ? { options: options[key].map(name => ({ name })) } : {} });
      }
      this.bases.get(token).fields = schema;
      return { appToken: token, baseUrl: `https://offline.feishu.cn/base/${token}`, tableId: `tblOperator${this.sequence}123`, fields };
    }, beforeMutation);
  }
  async addMember(token, { openId, perm, beforeMutation }) {
    return this.mutation(async () => {
      this.calls.push({ method: 'grant', token, perm, openId });
      this.bases.get(token).members.push({ memberType: 'openid', openId, perm });
    }, beforeMutation);
  }
  async getSharing(token) { return clone(this.bases.get(token).sharing); }
  async listMembers(token) { return clone(this.bases.get(token).members); }
  async api(route, request = {}) {
    const match = /^\/open-apis\/bitable\/v1\/apps\/([^/]+)\/tables\/([^/]+)\/(fields|records)(?:\/([^/]+))?$/.exec(route);
    assert.ok(match, 'Only the exact fake operator table endpoints are supported');
    const [, token, , kind, id] = match;
    const base = this.bases.get(token);
    assert.ok(base, 'No source or employee table may be mutated');
    const method = request.method ?? 'GET';
    this.calls.push({ method, token, kind, id, fields: clone(request.body?.fields), clientToken: request.query?.client_token });
    await this.hook?.(`${method}:${kind}`, { token, id, request, base });
    if (kind === 'fields') return { items: clone(base.fields), has_more: false };
    if (method === 'GET' && id) {
      if (!base.records.has(id)) throw error('1254043');
      return { record: clone(base.records.get(id)) };
    }
    if (method === 'GET') return { items: clone([...base.records.values()]), has_more: false, total: base.records.size };
    if (method === 'POST') {
      const key = `recOperatorChild${++this.recordSequence}123`;
      const record = { record_id: key, fields: clone(request.body.fields) };
      base.records.set(key, record);
      await this.hook?.('after-create', { token, id: key, record });
      return { record: clone(record) };
    }
    if (method === 'PUT') {
      if (!base.records.has(id)) throw error('1254043');
      Object.assign(base.records.get(id).fields, clone(request.body.fields));
      return { record: clone(base.records.get(id)) };
    }
    if (method === 'DELETE') {
      if (!base.records.delete(id)) throw error('1254043');
      return {};
    }
    throw new Error('Unexpected fake operation');
  }
}
function fixture(t, extra = {}) {
  const config = configuration();
  const db = new DatabaseSync(':memory:');
  const client = new OfflineAdmin(config);
  const sources = new Map();
  const reads = [];
  let readHook = null;
  const make = () => new OperatorMirror({ config, db, client, async readSource(id) {
    reads.push(id);
    await readHook?.(id);
    return sources.has(id) ? clone(sources.get(id)) : null;
  }, resolveSource: async () => clone(config.fields.leads), ...extra });
  const mirror = make();
  const views = () => clone([...sources.values()]);
  t.after(() => db.close());
  return { config, db, client, sources, mirror, reads, make, views, setReadHook(value) { readHook = value; } };
}

test('single-record sync publishes promptly in a ready table without changing other mappings or full-scan status', async t => {
  const f = fixture(t);
  for (const view of [lead(1), lead(2, operatorB.openId)]) f.sources.set(view.id, view);
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  const history = clone(f.mirror.all('copies')), status = clone(f.mirror.status());
  const cursor = f.db.prepare("SELECT value FROM v2_operator_meta WHERE key='next_operator'").get().value;
  const view = lead(3); f.sources.set(view.id, view);
  f.client.calls.length = 0; f.reads.length = 0;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA, operatorB] }), { synced: true });
  assert.equal(f.client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.client.calls.some(call => ['base', 'table', 'sharing', 'grant', 'PUT', 'DELETE'].includes(call.method)), false);
  assert.ok(f.reads.length > 0); assert.ok(f.reads.every(id => id === view.id));
  const resource = f.mirror.resource(operatorA.openId);
  assert.ok(f.client.calls.every(call => call.token === resource.baseToken));
  for (const row of history) assert.deepEqual(f.mirror.all('copies').find(item => item.id === row.id), row);
  assert.deepEqual(f.mirror.status(), status);
  assert.equal(f.db.prepare("SELECT value FROM v2_operator_meta WHERE key='next_operator'").get().value, cursor);
  const row = f.mirror.liveCopies(view.id)[0];
  f.client.calls.length = 0;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), { synced: true });
  assert.equal(f.client.calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method)), false);
  view.wxStatus = '未通过';
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), { synced: true });
  assert.equal(f.mirror.liveCopies(view.id)[0].targetRecordId, row.targetRecordId);
  assert.equal(f.client.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.client.bases.get(resource.baseToken).records.get(row.targetRecordId).fields.微信状态, '未通过');
});

test('single-record sync never provisions missing or incomplete resources and never guesses an operator', async t => {
  const f = fixture(t), view = lead(1); f.sources.set(view.id, view);
  const pending = { synced: false, needsReconciliation: true };
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), pending);
  for (const stage of ['base_needed', 'sharing_needed', 'table_needed', 'member_needed', 'verify', 'review']) {
    f.mirror.save('resources', { id: operatorA.openId, stage });
    assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), pending);
  }
  assert.deepEqual(await f.mirror.syncRecord({ ...view, operator: '' }, { operators: [] }), pending);
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [] }), pending);
  assert.equal(f.client.calls.length, 0); assert.equal(f.mirror.all('copies').length, 0);
  await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA, operatorA] }), { code: 'OPERATOR_ROSTER_INVALID' });
  await assert.rejects(f.mirror.syncRecord({ ...view, id: '../wrong' }, { operators: [operatorA] }), { code: 'OPERATOR_SOURCE_SNAPSHOT_INVALID' });
});

test('single-record transfer revokes only its old operator copy before creating the new one', async t => {
  const f = fixture(t), view = lead(1), other = lead(2);
  f.sources.set(view.id, view); f.sources.set(other.id, other);
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  const unchanged = clone(f.mirror.liveCopies(other.id));
  view.operator = operatorB.openId; f.client.calls.length = 0;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorB] }), { synced: true });
  assert.deepEqual(f.client.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).map(call => call.method), ['DELETE', 'POST']);
  assert.deepEqual(f.mirror.liveCopies(other.id), unchanged);
  assert.equal(f.mirror.liveCopies(view.id)[0].operatorId, operatorB.openId);
});

test('single-record clearing requests full reconciliation instead of treating other records as absent', async t => {
  const f = fixture(t), view = lead(1), other = lead(2);
  f.sources.set(view.id, view); f.sources.set(other.id, other);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  view.operator = ''; f.client.calls.length = 0;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), { synced: false, needsReconciliation: true });
  assert.equal(f.client.calls.length, 0); assert.equal(f.mirror.liveCopies(view.id).length, 1);
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.revoked, 1); assert.equal(f.mirror.liveCopies(other.id).length, 1);
});

test('single-record cleanup removes only its restored tombstone and keeps child IDs scoped to their Base', async t => {
  const f = fixture(t), view = lead(1);
  f.sources.set(view.id, view); await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  const old = clone(f.mirror.liveCopies(view.id)[0]);
  view.operator = operatorB.openId;
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  const current = f.mirror.liveCopies(view.id)[0], beforeId = current.targetRecordId;
  const oldResource = f.mirror.resource(operatorA.openId), currentResource = f.mirror.resource(operatorB.openId);
  const oldBase = f.client.bases.get(oldResource.baseToken), currentBase = f.client.bases.get(currentResource.baseToken);
  // The same textual record ID in another Base must not erase the current snapshot entry.
  f.mirror.save('copies', { ...old, state: 'revoked', targetRecordId: beforeId });
  oldBase.records.set(beforeId, clone(currentBase.records.get(beforeId)));
  f.client.calls.length = 0;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorB] }), { synced: true });
  assert.deepEqual(f.client.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).map(call => [call.method, call.token]), [['DELETE', oldResource.baseToken]]);
  assert.equal(currentBase.records.has(beforeId), true); assert.equal(oldBase.records.has(beforeId), false);
  assert.equal(f.mirror.liveCopies(view.id)[0].targetRecordId, beforeId);
});

test('single-record creation keeps unknown outcomes in review across restart without another POST', async t => {
  const f = fixture(t), view = lead(1);
  await f.mirror.sync([], { operators: [operatorA] }); f.sources.set(view.id, view);
  f.client.hook = phase => { if (phase === 'after-create') throw error('NETWORK_OR_TIMEOUT'); };
  await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA] }), { code: 'NETWORK_OR_TIMEOUT' });
  assert.equal(f.mirror.liveCopies(view.id)[0].state, 'review');
  f.client.hook = null;
  await assert.rejects(f.make().syncRecord(view, { operators: [operatorA] }), { code: 'OPERATOR_UNTRUSTED_CHILD_RECORD' });
  assert.equal(f.client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal([...f.client.bases.values()][0].records.size, 1);
});

test('single-record no-write rejection keeps the planned idempotency token for a later safe attempt', async t => {
  let allowed = true;
  const f = fixture(t, { verifyOperator: async () => allowed }), view = lead(1);
  await f.mirror.sync([], { operators: [operatorA] }); f.sources.set(view.id, view);
  let reads = 0;
  f.setReadHook(() => { if (++reads === 3) allowed = false; });
  await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA] }), { code: 'OPERATOR_NOT_READY' });
  const planned = f.mirror.liveCopies(view.id)[0];
  assert.equal(planned.state, 'planned'); assert.equal(f.client.recordSequence, 0);
  f.setReadHook(null); allowed = true;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), { synced: true });
  assert.equal(f.client.recordSequence, 1);
  assert.equal(f.mirror.liveCopies(view.id)[0].token, planned.token);
  assert.equal(f.client.calls.find(call => call.method === 'POST').clientToken, planned.token);
});

test('single-record writes retain immediate ACL, employee, schema and local-switch guards', async t => {
  for (const change of ['acl', 'employee', 'schema', 'local']) {
    let allowed = true, live = true;
    const f = fixture(t, { verifyOperator: async () => allowed, assertLiveConfig: async () => { if (!live) throw error('OPERATOR_LOCAL_CHANGED'); } });
    await f.mirror.sync([], { operators: [operatorA] });
    const view = lead(1); f.sources.set(view.id, view);
    const resource = f.mirror.resource(operatorA.openId);
    let changed = false;
    f.client.hook = (phase, { base }) => {
      if (phase !== 'GET:records' || changed) return; changed = true;
      if (change === 'acl') base.members.push({ memberType: 'openid', openId: operatorB.openId, perm: 'view' });
      if (change === 'employee') allowed = false;
      if (change === 'local') live = false;
      if (change === 'schema') {
        base.fields.find(field => field.field_name === '微信号').field_name = '改名微信号';
        base.fields.push({ field_id: 'fldUnrelatedWechat123', field_name: '微信号', type: 1 });
      }
    };
    const code = { acl: 'OPERATOR_UNKNOWN_COLLABORATOR', employee: 'OPERATOR_NOT_READY', schema: 'OPERATOR_SCHEMA_CHANGED_DURING_READ', local: 'OPERATOR_LOCAL_CHANGED' }[change];
    await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA] }), { code });
    assert.equal(f.client.bases.get(resource.baseToken).records.size, 0);
    assert.equal(f.client.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).length, 0);
  }
});

test('single-record changed source attribution or deletion is held without writing the stale target', async t => {
  for (const change of ['operator', 'deleted']) {
    const f = fixture(t); await f.mirror.sync([], { operators: [operatorA] });
    const view = lead(1); f.sources.set(view.id, view);
    f.setReadHook(() => { if (change === 'operator') view.operator = operatorB.openId; else f.sources.delete(view.id); });
    assert.deepEqual(await f.mirror.syncRecord(clone(view), { operators: [operatorA] }), { synced: false, needsReconciliation: true });
    assert.equal(f.client.calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method)), false);
  }
});

test('single-record transfer debits deletion from the write quota before allowing new exposure', async t => {
  const f = fixture(t, { maxWrites: 1 }), view = lead(1);
  f.sources.set(view.id, view); await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  view.operator = operatorB.openId; f.client.calls.length = 0;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorB] }), { synced: false, needsReconciliation: true });
  assert.deepEqual(f.client.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).map(call => call.method), ['DELETE']);
  assert.equal((await f.mirror.sync(f.views(), { operators: [operatorB] })).created, 1);
});

test('single-record target loss or unknown child rows cannot establish a replacement mapping', async t => {
  for (const change of ['missing', 'unknown']) {
    const f = fixture(t), view = lead(1); f.sources.set(view.id, view);
    await f.mirror.sync(f.views(), { operators: [operatorA] });
    const resource = f.mirror.resource(operatorA.openId), base = f.client.bases.get(resource.baseToken);
    if (change === 'missing') base.records.clear();
    else base.records.set('recUntrustedOperator123', { record_id: 'recUntrustedOperator123', fields: {} });
    f.client.calls.length = 0;
    await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA] }), { code: change === 'missing' ? 'OPERATOR_CHILD_MISSING' : 'OPERATOR_UNTRUSTED_CHILD_RECORD' });
    assert.equal(f.client.calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method)), false);
  }
});

test('single-record success requires actual matching child fields rather than just an accepted create ID', async t => {
  const f = fixture(t), view = lead(1);
  await f.mirror.sync([], { operators: [operatorA] }); f.sources.set(view.id, view);
  f.client.hook = (phase, { record }) => { if (phase === 'after-create') delete record.fields.微信号; };
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), { synced: false, needsReconciliation: true });
  assert.equal(f.mirror.liveCopies(view.id)[0].state, 'active');
  f.client.hook = null;
  assert.deepEqual(await f.mirror.syncRecord(view, { operators: [operatorA] }), { synced: true });
  assert.equal(f.client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.client.calls.filter(call => call.method === 'PUT').length, 1);
});

test('single-record calls are exclusive with full scans and stop before cloud mutation', { timeout: 5000 }, async t => {
  const f = fixture(t), view = lead(1); await f.mirror.sync([], { operators: [operatorA] }); f.sources.set(view.id, view);
  await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA], shouldStop: () => true }), { code: 'OPERATOR_STOP_REQUESTED' });
  let release, entered, blocked = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.client.hook = async phase => { if (phase === 'GET:records' && !blocked) { blocked = true; entered(); await new Promise(resolve => { release = resolve; }); } };
  const running = f.mirror.syncRecord(view, { operators: [operatorA] }); await waiting;
  await assert.rejects(f.mirror.syncRecord(view, { operators: [operatorA] }), { code: 'OPERATOR_MIRROR_BUSY' });
  await assert.rejects(f.mirror.sync(f.views(), { operators: [operatorA] }), { code: 'OPERATOR_MIRROR_BUSY' });
  release(); assert.deepEqual(await running, { synced: true }); assert.equal(f.mirror.status().busy, false);
});

test('silently backfills historical intake only into the correct independent read-only operator Base', async t => {
  const f = fixture(t);
  f.sources.set('recOperatorLead1123', lead(1));
  f.sources.set('recOperatorLead2123', lead(2, operatorB.openId));
  const result = await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  assert.equal(result.created, 2);
  assert.equal(result.readyUrls.length, 2);
  assert.ok(result.readyUrls.every(row => /\?table=tblOperator\d+123$/.test(row.url)));
  for (const resource of f.mirror.all('resources')) {
    const base = f.client.bases.get(resource.baseToken);
    assert.deepEqual(base.members.filter(row => !row.isApp), [{ memberType: 'openid', openId: resource.id, perm: 'view' }]);
    assert.equal(base.records.size, 1);
    assert.equal([...base.records.values()][0].fields.微信号, resource.id === operatorA.openId ? 'fake-wx-1' : 'fake-wx-2');
  }
  assert.equal(f.client.calls.some(call => ['subscribe', 'message', 'transfer_owner'].includes(call.method)), false);
  const writes = f.client.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).length;
  const quiet = await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  assert.equal(quiet.unchanged, 2);
  assert.equal(f.client.calls.filter(call => ['POST', 'PUT', 'DELETE'].includes(call.method)).length, writes);
});

test('old operator copy is removed before a reassigned lead is copied to the new operator', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  f.client.calls.length = 0;
  source.operator = operatorB.openId;
  const result = await f.mirror.sync(f.views(), { operators: [operatorB] });
  assert.equal(result.revoked, 1);
  assert.equal(result.created, 1);
  const changes = f.client.calls.filter(call => ['POST', 'DELETE'].includes(call.method));
  assert.deepEqual(changes.map(call => call.method), ['DELETE', 'POST']);
  assert.equal(f.mirror.all('copies').filter(row => row.state === 'active')[0].operatorId, operatorB.openId);
});

test('stopping new operator access preserves their existing intake and clearing the source operator revokes its copy', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  const stopped = await f.mirror.sync(f.views(), { operators: [] });
  assert.equal(stopped.revoked, 0);
  assert.equal(f.mirror.all('copies')[0].state, 'active');
  source.operator = '';
  const cleared = await f.mirror.sync(f.views(), { operators: [] });
  assert.equal(cleared.revoked, 1);
  assert.equal(f.mirror.all('copies')[0].state, 'revoked');
});

test('a deleted source is confirmed by the authoritative reader before revocation', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  f.sources.clear();
  const result = await f.mirror.sync([], { operators: [] });
  assert.equal(result.revoked, 1);
  assert.ok(f.reads.includes(source.id));
});

test('unknown create outcomes persist review and cannot create duplicates after restart', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  f.client.hook = async phase => { if (phase === 'after-create') throw error('NETWORK_OR_TIMEOUT'); };
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(f.mirror.all('copies')[0].state, 'review');
  f.client.hook = null;
  await f.make().sync(f.views(), { operators: [operatorA] });
  assert.equal(f.client.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal([...f.client.bases.values()][0].records.size, 1);
  source.operator = operatorB.openId;
  const reassigned = await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  assert.ok(reassigned.reviews > 0);
  assert.equal(f.client.calls.filter(call => call.method === 'POST').length, 1);
});

test('an uncertain update with a trusted row ID can still be revoked before reassignment', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  source.wxStatus = '未通过';
  f.client.hook = async phase => { if (phase === 'PUT:records') throw error('NETWORK_OR_TIMEOUT'); };
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  assert.equal(f.mirror.all('copies')[0].state, 'review');
  f.client.hook = null;
  f.client.calls.length = 0;
  source.operator = operatorB.openId;
  const result = await f.make().sync(f.views(), { operators: [operatorB] });
  assert.equal(result.revoked, 1);
  assert.equal(result.created, 1);
  assert.deepEqual(f.client.calls.filter(call => ['POST', 'DELETE'].includes(call.method)).map(call => call.method), ['DELETE', 'POST']);
});

test('unknown Base creation outcomes are not replayed and never receive customer records', async t => {
  const f = fixture(t);
  f.sources.set('recOperatorLead1123', lead(1));
  f.client.hook = async phase => { if (phase === 'base') throw error('NETWORK_OR_TIMEOUT'); };
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  f.client.hook = null;
  await f.make().sync(f.views(), { operators: [operatorA] });
  assert.equal(f.client.sequence, 1);
  assert.equal(f.client.recordSequence, 0);
});

test('extra collaborators or wrong read permission block all outbound customer writes', async t => {
  const f = fixture(t);
  await f.mirror.sync([], { operators: [operatorA] });
  const resource = f.mirror.all('resources')[0];
  f.client.bases.get(resource.baseToken).members.push({ memberType: 'openid', openId: operatorB.openId, perm: 'view' });
  f.sources.set('recOperatorLead1123', lead(1));
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.created, 0);
  assert.equal(result.readyUrls.length, 0);
  assert.equal(f.client.recordSequence, 0);
});

test('a collaborator added after the scan is caught by the complete immediate pre-write audit', async t => {
  const f = fixture(t);
  await f.mirror.sync([], { operators: [operatorA] });
  f.sources.set('recOperatorLead1123', lead(1));
  f.client.hook = async (phase, { base }) => {
    if (phase === 'GET:records') base.members.push({ memberType: 'openid', openId: operatorB.openId, perm: 'view' });
  };
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.created, 0);
  assert.equal(f.client.recordSequence, 0);
  assert.ok(result.reviews > 0);
});

test('empty single-select values use the API null representation', async t => {
  const f = fixture(t);
  const source = { ...lead(1), wxStatus: '', channel: '', account: '', leadSource: '', addMethod: '' };
  f.sources.set(source.id, source);
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.created, 1);
  const fields = f.client.calls.find(call => call.method === 'POST').fields;
  for (const key of ['wxStatus', 'channel', 'account', 'leadSource', 'addMethod']) assert.equal(fields[OPERATOR_TARGET_NAMES[key]], null);
  const again = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(again.unchanged, 1);
});

test('metadata renames follow stable IDs while deleted or incompatible fields hold writes', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  const resource = f.mirror.all('resources')[0];
  const base = f.client.bases.get(resource.baseToken);
  base.fields.find(field => field.field_name === '微信状态').field_name = '当前微信状态';
  const record = [...base.records.values()][0];
  record.fields.当前微信状态 = record.fields.微信状态;
  delete record.fields.微信状态;
  source.wxStatus = '未通过';
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(record.fields.当前微信状态, '未通过');
  base.fields.find(field => field.field_name === '当前微信状态').type = 1;
  source.wxStatus = '通过';
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.updated, 0);
  assert.equal(record.fields.当前微信状态, '未通过');
});

test('read-only child edits are overwritten outbound and never modify the source', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  const resource = f.mirror.all('resources')[0];
  const record = [...f.client.bases.get(resource.baseToken).records.values()][0];
  record.fields.微信状态 = '号码错误';
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.updated, 1);
  assert.equal(record.fields.微信状态, '待添加');
  assert.equal(source.wxStatus, '待添加');
});

test('last-moment source or employee changes prevent sending stale customer fields', async t => {
  let enabled = true;
  const f = fixture(t, { verifyOperator: async () => enabled });
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync([], { operators: [operatorA] });
  f.setReadHook(() => { enabled = false; });
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(result.created, 0);
  assert.equal(f.client.recordSequence, 0);
});

test('a planned create with no attempted POST resumes with its original intention instead of duplicating', async t => {
  let enabled = true;
  const f = fixture(t, { verifyOperator: async () => enabled });
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync([], { operators: [operatorA] });
  let reads = 0;
  f.setReadHook(() => { if (++reads === 2) enabled = false; });
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(f.mirror.all('copies')[0].state, 'planned');
  enabled = true;
  f.setReadHook(null);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(f.client.recordSequence, 1);
  assert.equal(f.mirror.all('copies')[0].state, 'active');
});

test('bounded historical backfill eventually completes without replaying existing copies', async t => {
  const f = fixture(t, { maxWrites: 2 });
  for (let index = 1; index <= 5; index++) { const view = lead(index); f.sources.set(view.id, view); }
  const one = await f.mirror.sync(f.views(), { operators: [operatorA] });
  const two = await f.mirror.sync(f.views(), { operators: [operatorA] });
  const three = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(one.created, 2);
  assert.equal(two.created, 2);
  assert.equal(three.created, 1);
  assert.equal(f.client.recordSequence, 5);
});

test('the next operator gets a write after restart despite continuous intake for the first operator', async t => {
  const f = fixture(t, { maxWrites: 2 });
  for (const view of [lead(1), lead(2), lead(3, operatorB.openId)]) f.sources.set(view.id, view);
  const staff = [operatorA, operatorB];
  const first = await f.mirror.sync(f.views(), { operators: staff });
  assert.equal(first.created, 2);
  assert.equal(first.pending, 1);
  assert.equal(f.db.prepare("SELECT value FROM v2_operator_meta WHERE key='next_operator'").get().value, operatorB.openId);
  for (const view of [lead(4), lead(5)]) f.sources.set(view.id, view);
  const restarted = f.make();
  const next = await restarted.sync(f.views(), { operators: staff });
  assert.equal(next.created, 2);
  assert.equal(next.pending, 1);
  assert.equal(restarted.all('copies').filter(row => row.operatorId === operatorB.openId && row.state === 'active').length, 1);
  assert.equal(f.client.recordSequence, 4);
});

test('a scan without record writes preserves the next operator cursor', async t => {
  const f = fixture(t, { maxWrites: 1 });
  const view = lead(1);
  f.sources.set(view.id, view);
  const staff = [operatorA, operatorB];
  const cursor = () => f.db.prepare("SELECT value FROM v2_operator_meta WHERE key='next_operator'").get()?.value;
  assert.equal(cursor(), undefined);
  const first = await f.mirror.sync(f.views(), { operators: staff });
  assert.equal(first.created, 1);
  assert.equal(cursor(), operatorB.openId);
  const rest = await f.mirror.sync(f.views(), { operators: staff });
  assert.equal(rest.created, 0);
  assert.equal(rest.unchanged, 1);
  assert.equal(cursor(), operatorB.openId);
  assert.equal(f.client.recordSequence, 1);
});

test('exact unchanged copies after the write cap are not pending', async t => {
  const f = fixture(t, { maxWrites: 2 });
  const history = [1, 2, 3, 4].map(index => lead(index));
  for (const view of history) f.sources.set(view.id, view);
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  await f.mirror.sync(f.views(), { operators: [operatorA] });
  const additions = [lead(5), lead(6)];
  for (const view of additions) f.sources.set(view.id, view);
  const scan = await f.mirror.sync([...additions, ...history], { operators: [operatorA] });
  assert.equal(scan.created, 2);
  assert.equal(scan.unchanged, 4);
  assert.equal(scan.pending, 0);
  assert.equal(scan.revocationBacklog, 0);
  assert.equal(scan.nextRetryAt, null);
  assert.equal(f.client.recordSequence, 6);
});

test('a revoke-only scan at its limit remains pending until every stale copy is removed', async t => {
  const f = fixture(t, { maxWrites: 1 });
  for (let index = 1; index <= 3; index++) { const view = lead(index); f.sources.set(view.id, view); }
  for (let index = 1; index <= 3; index++) await f.mirror.sync(f.views(), { operators: [operatorA] });
  for (const view of f.sources.values()) view.operator = '';
  const one = await f.mirror.sync(f.views(), { operators: [] });
  assert.equal(one.revoked, 1);
  assert.equal(one.pending, 0);
  assert.equal(one.revocationBacklog, 1);
  assert.ok(one.nextRetryAt);
  await f.mirror.sync(f.views(), { operators: [] });
  const three = await f.mirror.sync(f.views(), { operators: [] });
  assert.equal(three.revoked, 1);
  assert.equal(three.revocationBacklog, 0);
  assert.equal(f.mirror.all('copies').filter(row => row.state !== 'revoked').length, 0);
});

test('uncertain failed POST attempts consume the bounded write budget', async t => {
  const f = fixture(t, { maxWrites: 2 });
  for (let index = 1; index <= 5; index++) { const view = lead(index); f.sources.set(view.id, view); }
  f.client.hook = async phase => { if (phase === 'after-create') throw error('NETWORK_OR_TIMEOUT'); };
  const result = await f.mirror.sync(f.views(), { operators: [operatorA] });
  assert.equal(f.client.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(result.created, 0);
  assert.ok(result.pending > 0);
  assert.ok(result.reviews > 0);
});

test('restored trusted revoked copies are deleted before new exposure', async t => {
  const f = fixture(t);
  const source = lead(1);
  f.sources.set(source.id, source);
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  const old = f.mirror.all('copies')[0];
  const resource = f.mirror.resource(operatorA.openId);
  const saved = clone(f.client.bases.get(resource.baseToken).records.get(old.targetRecordId));
  source.operator = operatorB.openId;
  await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  f.client.bases.get(resource.baseToken).records.set(old.targetRecordId, saved);
  const result = await f.mirror.sync(f.views(), { operators: [operatorA, operatorB] });
  assert.equal(result.revoked, 1);
  assert.equal(f.client.bases.get(resource.baseToken).records.size, 0);
});

test('in-flight local configuration changes reject all cloud mutations and status reveals no customer values', async t => {
  let enabled = false;
  const f = fixture(t, { assertLiveConfig: async () => { if (!enabled) throw error('LOCAL_CONFIG_CHANGED'); } });
  f.sources.set('recOperatorLead1123', lead(1));
  await assert.rejects(f.mirror.sync(f.views(), { operators: [operatorA] }), { code: 'LOCAL_CONFIG_CHANGED' });
  assert.equal(f.client.calls.length, 0);
  assert.equal(JSON.stringify(f.mirror.status()).includes('fake-wx'), false);
});

test('rejects duplicate staff and source snapshots before creating cloud resources', async t => {
  const f = fixture(t);
  const source = lead(1);
  await assert.rejects(f.mirror.sync([source, source], { operators: [operatorA] }), { code: 'OPERATOR_SOURCE_SNAPSHOT_INVALID' });
  await assert.rejects(f.mirror.sync([source], { operators: [operatorA, operatorA] }), { code: 'OPERATOR_ROSTER_INVALID' });
  assert.equal(f.client.calls.length, 0);
});

function adapter() {
  const config = configuration();
  const sourceFields = Object.entries(definitions).map(([key, type]) => ({ field_id: config.fields.leads[key].fieldId,
    field_name: `源${key}`, type, property: options[key] ? { options: options[key].map((name, color) => ({ id: `opt${color}`, name, color })) } : {} }));
  const calls = [];
  const shared = { config, retryMutations: false, async tenantToken() {}, async api(route, request = {}) {
    calls.push({ route, request: clone(request) });
    if (request.method === 'GET') return { items: clone(sourceFields), has_more: false };
    assert.equal(route, '/open-apis/bitable/v1/apps/OfflineNewOperatorBase123/tables');
    assert.equal(request.method, 'POST');
    return { table_id: 'tblCreatedOperator123', field_id_list: request.body.table.fields.map((_, index) => `fldNewOperator${index}123`) };
  } };
  return { client: new StaffAdminClient(config, { sourceClient: shared }), calls, sourceFields };
}

test('the strict API adapter creates only the allowlisted operator columns with exact source choices', async () => {
  const f = adapter();
  const target = await f.client.createOperatorTable('OfflineNewOperatorBase123');
  const table = f.calls.find(call => call.request.method === 'POST').request.body.table;
  assert.equal(table.name, '运营客资');
  assert.deepEqual(table.fields.map(field => field.field_name), Object.values(OPERATOR_TARGET_NAMES));
  assert.deepEqual(table.fields.find(field => field.field_name === '微信状态').property.options.map(value => value.name), options.wxStatus);
  assert.equal(table.fields.find(field => field.field_name === '日期').type, 5);
  assert.deepEqual(Object.keys(target.fields), Object.keys(OPERATOR_TARGET_NAMES));
  assert.equal(f.client.retryMutations, false);
});

test('invalid source choices are a definite no-write preflight failure rather than an uncertain create', async () => {
  const f = adapter();
  f.sourceFields.find(field => field.type === 3).property.options = [];
  await assert.rejects(f.client.createOperatorTable('OfflineNewOperatorBase123'), { code: 'OPERATOR_SOURCE_OPTIONS_INVALID', staffMutationAttempted: false });
  assert.equal(f.calls.filter(call => call.request.method === 'POST').length, 0);
});
