import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SalesMirror } from './sales-mirror.mjs';
import { resolveFields, recordView } from './field-map.mjs';

const clone = value => structuredClone(value);
const sourceToken = 'SourceFixtureBase012345';
const schema = prefix => [
  ['owner', 'Owner', 11], ['operator', 'Operator', 11], ['wx', 'Wechat', 1], ['needs', 'Needs', 1], ['wxStatus', 'Wechat status', 1], ['addMethod', 'Add method', 1], ['partySize', 'Party size', 2], ['salesName', 'Sales name', 1],
].map(([key, name, type], index) => ({ key, field_id: `fld${prefix}${String(index).padStart(5, '0')}`, field_name: name, type, property: type === 11 ? { multiple: false } : {} }));
const definitions = fields => Object.fromEntries(fields.map(field => [field.key, { fieldId: field.field_id, types: [field.type], ...(field.type === 11 ? { multiple: false } : {}) }]));

class FakeClient {
  constructor(base, table, fields, log) { this.base = base; this.table = table; this.schema = clone(fields); this.records = new Map(); this.log = log; this.serial = 0; this.createUnknown = false; this.deleteFailure = false; this.hooks = {}; this.metrics = { schema: 0, list: 0, read: 0 }; }
  async api(apiPath, options = {}) {
    if (apiPath.endsWith('/fields')) { this.metrics.schema++; return { items: clone(this.schema), has_more: false }; }
    throw Object.assign(new Error('Unexpected fake endpoint'), { code: 'FAKE_ENDPOINT' });
  }
  async listRecords(table) { assert.equal(table, this.table); this.metrics.list++; await this.hooks.beforeList?.(); return { items: [...this.records.values()].map(clone), hasMore: false }; }
  async readRecord(table, id) {
    assert.equal(table, this.table); this.metrics.read++; await this.hooks.beforeRead?.(id);
    const result = this.records.get(id); if (!result) throw Object.assign(new Error('fake missing'), { code: '1254043' });
    return clone(result);
  }
  async createRecord(table, fields, { clientToken } = {}) {
    assert.equal(table, this.table); assert.match(clientToken, /^[a-f0-9-]{36}$/);
    this.log.push({ op: 'create', base: this.base, fields: clone(fields), clientToken });
    await this.hooks.beforeCreate?.();
    const id = `rec${this.base}${++this.serial}`, record = { record_id: id, fields: clone(fields) };
    this.records.set(id, record);
    if (this.createUnknown) throw Object.assign(new Error('transport unknown'), { code: 'NETWORK_OR_TIMEOUT' });
    return clone(record);
  }
  async updateRecord(table, id, fields) {
    assert.equal(table, this.table); this.log.push({ op: 'update', base: this.base, id, fields: clone(fields) });
    await this.hooks.beforeUpdate?.(id, fields);
    const record = this.records.get(id); if (!record) throw Object.assign(new Error('fake missing'), { code: '1254043' });
    record.fields = { ...record.fields, ...clone(fields) };
    await this.hooks.afterUpdate?.(id, fields);
    return clone(record);
  }
  async deleteRecord(table, id) {
    assert.equal(table, this.table); this.log.push({ op: 'delete', base: this.base, id });
    await this.hooks.beforeDelete?.(id);
    if (this.deleteFailure) throw Object.assign(new Error('fake delete failure'), { code: 'NETWORK_OR_TIMEOUT' });
    this.records.delete(id); return { record_id: id, deleted: true };
  }
}

function fixture({ feedbackFields = ['wxStatus'], filename = ':memory:' } = {}) {
  const log = [], source = new FakeClient(sourceToken, 'tblSourceFixture001', schema('Source'), log);
  const childSchema = schema('Child').filter(field => !['owner', 'operator'].includes(field.key));
  const salesA = new FakeClient('SalesAFixtureBase012345', 'tblSalesAFixture001', childSchema, log);
  const salesB = new FakeClient('SalesBFixtureBase012345', 'tblSalesBFixture001', childSchema, log);
  const target = client => ({ appToken: client.base, tableId: client.table, baseUrl: `https://fixture.feishu.cn/base/${client.base}`, fields: definitions(client.schema) });
  const config = { enabled: true, appToken: sourceToken, tableIds: { leads: source.table }, fields: { leads: definitions(source.schema) }, mirrors: { enabled: true, feedbackFields }, members: [
    { id: 'sales_a', openId: 'ou_fixture_sales_a', displayName: 'Fixture A', enabled: true, order: 1, target: target(salesA) },
    { id: 'sales_b', openId: 'ou_fixture_sales_b', displayName: 'Fixture B', enabled: true, order: 2, target: target(salesB) },
  ] };
  source.records.set('recSource1', { record_id: 'recSource1', fields: { Owner: [{ id: 'ou_fixture_sales_a' }], Operator: [{ id: 'ou_fixture_operator' }], Wechat: 'fixture-wx', Needs: 'fixture-needs', 'Wechat status': '未添加', 'Add method': '客户主动加', 'Party size': 2, 'Sales name': 'Fixture A', FinanceSecret: 12345 } });
  let sourceReadCount = 0;
  const hooks = {};
  const resolveSource = () => resolveFields(source, { appToken: sourceToken, tableId: source.table, fields: config.fields.leads });
  const readSource = async id => {
    sourceReadCount++; await hooks.beforeSource?.(id, sourceReadCount);
    const record = await source.readRecord(source.table, id); return recordView(record, await resolveSource());
  };
  const db = new DatabaseSync(filename), clients = new Map([source, salesA, salesB].map(client => [client.base, client]));
  const construct = () => new SalesMirror({ config, db, sourceClient: source, clientFactory: token => { assert.ok(clients.has(token)); return clients.get(token); }, readSource, resolveSource });
  const mirror = construct();
  return { db, mirror, construct, config, source, salesA, salesB, log, hooks, readSource, resolveSource, close() { db.close(); } };
}
const owner = (f, value) => { f.source.records.get('recSource1').fields.Owner = value ? [{ id: value }] : []; };
const createCount = f => f.log.filter(entry => entry.op === 'create').length;

test('ensure re-reads source ownership, copies minimum fields and returns only the sales Base URL', async () => {
  const f = fixture();
  try {
    const result = await f.mirror.ensure({ id: 'recSource1', owner: 'ou_fixture_sales_b' });
    assert.ok(result.url.includes(f.salesA.base)); assert.ok(!result.url.includes(sourceToken));
    const record = f.salesA.records.get(result.targetRecordId);
    assert.equal(record.fields.Wechat, 'fixture-wx'); assert.equal(record.fields['Sales name'], 'Fixture A');
    assert.equal(record.fields.Owner, undefined); assert.equal(record.fields.Operator, undefined); assert.equal(record.fields.FinanceSecret, undefined);
    assert.equal(f.salesB.records.size, 0);
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync(); assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('trusted mapping survives SQLite restart and never trusts editable child source IDs', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'mirror-test-')), filename = path.join(folder, 'mirror.sqlite');
  const f = fixture({ filename }); let reopened, sourceClosed = false;
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    f.salesA.records.get(targetRecordId).fields.SourceRecordId = 'recOtherCustomer';
    f.close(); sourceClosed = true; reopened = new DatabaseSync(filename);
    const clients = new Map([f.source, f.salesA, f.salesB].map(client => [client.base, client]));
    const again = new SalesMirror({ config: f.config, db: reopened, sourceClient: f.source, clientFactory: token => clients.get(token), readSource: f.readSource, resolveSource: f.resolveSource });
    await again.ensure({ id: 'recSource1' }); assert.equal(createCount(f), 1);
    f.salesA.records.set('recUnknownChild', { record_id: 'recUnknownChild', fields: { SourceRecordId: 'recOtherCustomer', Wechat: 'injected' } });
    const result = await again.sync(); assert.equal(result.unknownChildRecords, 1);
    assert.equal(f.log.filter(entry => entry.base === sourceToken && entry.op === 'create').length, 0);
    assert.equal(f.source.records.size, 1);
  } finally { if (!sourceClosed) f.close(); reopened?.close(); assert.ok(path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(folder, { recursive: true, force: true }); }
});

test('feedback is restricted to configured whitelist and readonly copied values return to source truth', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    Object.assign(f.salesA.records.get(targetRecordId).fields, { 'Wechat status': '未通过', Wechat: 'tampered-wx', Owner: [{ id: 'ou_fixture_sales_b' }], FinanceSecret: 9 });
    const result = await f.mirror.sync(); assert.equal(result.sourceWrites, 1);
    const writes = f.log.filter(entry => entry.base === sourceToken && entry.op === 'update');
    assert.deepEqual(writes.map(entry => entry.fields), [{ 'Wechat status': '未通过' }]);
    assert.equal(f.source.records.get('recSource1').fields.Wechat, 'fixture-wx');
    assert.equal(f.salesA.records.get(targetRecordId).fields.Wechat, 'fixture-wx');
    assert.equal(f.source.records.get('recSource1').fields.FinanceSecret, 12345);
  } finally { f.close(); }
});

test('optional wx, needs, addMethod and partySize feedback needs explicit whitelist', async () => {
  const f = fixture({ feedbackFields: ['wxStatus', 'wx', 'needs', 'addMethod', 'partySize'] });
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    Object.assign(f.salesA.records.get(targetRecordId).fields, { Wechat: 'corrected-fixture', Needs: 'updated-needs', 'Add method': '销售主动加', 'Party size': 3 });
    await f.mirror.sync();
    const patch = f.log.find(entry => entry.base === sourceToken && entry.op === 'update').fields;
    assert.deepEqual(patch, { Wechat: 'corrected-fixture', Needs: 'updated-needs', 'Add method': '销售主动加', 'Party size': 3 });
  } finally { f.close(); }
});

test('conflicting source and child edits are held rather than silently overwriting either side', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    f.source.records.get('recSource1').fields['Wechat status'] = '通过';
    f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
    const result = await f.mirror.sync(); assert.ok(result.reviewsOpen > 0);
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '通过');
    assert.equal(f.salesA.records.get(targetRecordId).fields['Wechat status'], '未通过');
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === sourceToken).length, 0);
  } finally { f.close(); }
});

test('transfer revokes old copy before creating new copy and never writes late old feedback', async () => {
  const f = fixture();
  try {
    const old = await f.mirror.ensure({ id: 'recSource1' }), oldCopy = clone(f.salesA.records.get(old.targetRecordId));
    f.salesA.records.get(old.targetRecordId).fields['Wechat status'] = 'late-old-feedback';
    owner(f, 'ou_fixture_sales_b');
    const current = await f.mirror.ensure({ id: 'recSource1' });
    assert.ok(current.url.includes(f.salesB.base)); assert.equal(f.salesA.records.size, 0);
    const deleteIndex = f.log.findIndex(entry => entry.op === 'delete' && entry.base === f.salesA.base);
    const createIndex = f.log.findIndex(entry => entry.op === 'create' && entry.base === f.salesB.base); assert.ok(deleteIndex >= 0 && createIndex > deleteIndex);
    // Restoring an old row never restores its backend authority.
    oldCopy.fields['Wechat status'] = 'restored-old-feedback'; f.salesA.records.set(old.targetRecordId, oldCopy);
    await f.mirror.sync(); assert.equal(f.salesA.records.has(old.targetRecordId), false);
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '未添加');
  } finally { f.close(); }
});

test('owner changed during feedback preparation blocks the stale source write', async () => {
  const f = fixture();
  try {
    const old = await f.mirror.ensure({ id: 'recSource1' }); f.salesA.records.get(old.targetRecordId).fields['Wechat status'] = 'stale-feedback';
    let reads = 0;
    f.hooks.beforeSource = () => { if (++reads === 3) owner(f, 'ou_fixture_sales_b'); };
    const current = await f.mirror.ensure({ id: 'recSource1' });
    assert.ok(current.url.includes(f.salesB.base)); assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '未添加');
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === sourceToken).length, 0);
  } finally { f.close(); }
});

test('unconfirmed old-copy deletion blocks a new target until revocation can be verified', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); owner(f, 'ou_fixture_sales_b'); f.salesA.deleteFailure = true;
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' })); assert.equal(f.salesB.records.size, 0);
    f.salesA.deleteFailure = false; await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(f.salesA.records.size, 0); assert.equal(f.salesB.records.size, 1);
  } finally { f.close(); }
});

test('app/table/field errors and generic HTTP 404 never mean the source record was deleted', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); owner(f, 'ou_fixture_sales_b'); f.log.length = 0;
    for (const detail of [{ code: '1254040' }, { code: '1254041' }, { code: '1254042' }, { code: '1254044' }, { status: 404 }, { status: 403 }]) {
      f.hooks.beforeSource = () => { throw Object.assign(new Error('fake inaccessible resource'), detail); };
      await assert.rejects(f.mirror.ensure({ id: 'recSource1' }));
      assert.equal(f.salesA.records.size, 1); assert.equal(f.salesB.records.size, 0); assert.equal(f.log.length, 0);
      assert.equal(f.mirror.rows()[0].state, 'active');
    }
  } finally { f.close(); }
});

test('app/table/field errors and generic HTTP 404 cannot confirm old-copy revocation', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); owner(f, 'ou_fixture_sales_b'); f.log.length = 0;
    for (const detail of [{ code: '1254040' }, { code: '1254041' }, { code: '1254042' }, { code: '1254044' }, { status: 404 }, { status: 403 }]) {
      f.salesA.hooks.beforeRead = () => { throw Object.assign(new Error('fake inaccessible old-copy resource'), detail); };
      await assert.rejects(f.mirror.ensure({ id: 'recSource1' }));
      assert.equal(f.salesA.records.size, 1); assert.equal(f.salesB.records.size, 0); assert.equal(f.log.length, 0);
      assert.equal(f.mirror.rows()[0].state, 'active');
    }
  } finally { f.close(); }
});

test('unknown create outcome is persisted for review and never blindly creates another copy', async () => {
  const f = fixture();
  try {
    f.salesA.createUnknown = true;
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' });
    assert.equal(f.salesA.records.size, 1); assert.equal(createCount(f), 1);
    await assert.rejects(f.construct().ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' });
    owner(f, 'ou_fixture_sales_b'); await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' });
    assert.equal(f.salesB.records.size, 0); assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('an interrupted creating marker is recovered as review without any network write', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' });
    const row = f.mirror.rows()[0]; f.mirror.put({ ...row, state: 'creating', targetRecordId: null });
    const restarted = f.construct(); assert.equal(restarted.status().counts.create_review, 1);
    await assert.rejects(restarted.ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' }); assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('a returned create ID with temporarily invisible GET is held without a replacement POST', async () => {
  const f = fixture();
  try {
    f.salesA.hooks.beforeRead = () => { throw Object.assign(new Error('not yet visible'), { code: '1254043' }); };
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_TARGET_MISSING_REVIEW_REQUIRED' });
    assert.equal(createCount(f), 1); assert.equal(f.salesA.records.size, 1);
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_TARGET_MISSING_REVIEW_REQUIRED' }); assert.equal(createCount(f), 1);
    delete f.salesA.hooks.beforeRead;
    const confirmed = await f.mirror.ensure({ id: 'recSource1' }); assert.ok(confirmed.targetRecordId); assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('a trusted mirror database cannot be silently reused for another source Base', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); f.log.length = 0;
    f.config.appToken = 'DifferentSourceFixture012345';
    assert.throws(() => f.construct(), { code: 'MIRROR_DATABASE_BINDING_MISMATCH' });
    assert.equal(f.log.length, 0);
  } finally { f.close(); }
});

test('source deletion revokes known child copy and unknown child rows never create source records', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); f.source.records.delete('recSource1');
    f.salesB.records.set('recUntrusted', { record_id: 'recUntrusted', fields: { SourceRecordId: 'recSource1', Wechat: 'not-source' } });
    const result = await f.mirror.sync(); assert.equal(f.salesA.records.size, 0); assert.equal(result.unknownChildRecords, 1); assert.equal(f.source.records.size, 0);
    assert.equal(f.log.filter(entry => entry.op === 'create' && entry.base === sourceToken).length, 0);
  } finally { f.close(); }
});

test('field-ID resolution follows rename and blocks replacement by same-named different ID', async () => {
  const f = fixture();
  try {
    const field = f.salesA.schema.find(field => field.key === 'wx'); field.field_name = 'Renamed Wechat';
    const first = await f.mirror.ensure({ id: 'recSource1' }); assert.equal(f.salesA.records.get(first.targetRecordId).fields['Renamed Wechat'], 'fixture-wx');
    field.field_id = 'fldReplacement99999';
    const before = f.log.length; await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'FIELD_ID_NOT_FOUND' });
    assert.equal(f.log.length, before);
  } finally { f.close(); }
});

test('a stop immediately before create or revoke prevents further remote writes', async () => {
  const f = fixture();
  try {
    let calls = 0;
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }, { shouldStop: () => ++calls >= 2 }), { code: 'MIRROR_STOP_REQUESTED' }); assert.equal(createCount(f), 0);
    await f.mirror.ensure({ id: 'recSource1' }); owner(f, 'ou_fixture_sales_b'); calls = 0;
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }, { shouldStop: () => ++calls >= 2 }), { code: 'MIRROR_STOP_REQUESTED' });
    assert.equal(f.salesA.records.size, 1); assert.equal(f.salesB.records.size, 0);
  } finally { f.close(); }
});

test('manual ownership of a disabled configured member is respected; unknown identity is held', async () => {
  const f = fixture();
  try {
    f.config.members[0].enabled = false; const result = await f.mirror.ensure({ id: 'recSource1' }); assert.ok(result.url.includes(f.salesA.base));
    owner(f, 'ou_unknown_fixture'); await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_TARGET_REQUIRED' });
    assert.equal(f.salesA.records.size, 0); assert.equal(f.salesB.records.size, 0);
  } finally { f.close(); }
});

test('batch sync revokes an old copy when the master is reassigned to an unknown identity', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); owner(f, 'ou_unknown_fixture'); f.log.length = 0;
    const result = await f.mirror.sync();
    assert.equal(f.salesA.records.size, 0); assert.equal(f.salesB.records.size, 0); assert.ok(result.reviewsOpen > 0);
    assert.equal(f.log.filter(entry => entry.op === 'create').length, 0);
    assert.equal(f.mirror.rows()[0].state, 'revoked');
    assert.equal(f.source.records.get('recSource1').fields.Owner[0].id, 'ou_unknown_fixture');
  } finally { f.close(); }
});

test('removing the currently assigned member revokes that member copy rather than skipping cleanup', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' }); f.config.members = f.config.members.filter(member => member.id !== 'sales_a'); f.log.length = 0;
    const result = await f.mirror.sync();
    assert.equal(f.salesA.records.size, 0); assert.equal(f.salesB.records.size, 0); assert.ok(result.reviewsOpen > 0);
    assert.equal(f.log.filter(entry => entry.op === 'create').length, 0);
    assert.equal(f.mirror.rows()[0].state, 'revoked');
  } finally { f.close(); }
});

test('107 unchanged mirrors use batched snapshots with zero per-lead GETs or remote writes', async () => {
  const f = fixture();
  try {
    const seed = clone(f.source.records.get('recSource1'));
    for (let i = 2; i <= 107; i++) {
      const id = `recSource${i}`, record = clone(seed); record.record_id = id; record.fields.Wechat = `fixture-wx-${i}`;
      record.fields.Owner = [{ id: i % 2 ? 'ou_fixture_sales_a' : 'ou_fixture_sales_b' }]; f.source.records.set(id, record);
    }
    await f.mirror.sync(); assert.equal(createCount(f), 107);
    f.log.length = 0;
    for (const client of [f.source, f.salesA, f.salesB]) client.metrics = { schema: 0, list: 0, read: 0 };
    const result = await f.mirror.sync();
    assert.equal(result.unchanged, 107); assert.equal(result.ensured, 0); assert.equal(f.log.length, 0);
    for (const client of [f.source, f.salesA, f.salesB]) { assert.equal(client.metrics.read, 0); assert.equal(client.metrics.list, 1); assert.equal(client.metrics.schema, 2); }
  } finally { f.close(); }
});

test('schema changed during batch snapshots stops the entire mirror pass before writes', async () => {
  const f = fixture();
  try {
    await f.mirror.ensure({ id: 'recSource1' });
    f.source.records.get('recSource1').fields.Wechat = 'changed-source'; f.log.length = 0;
    f.salesB.hooks.beforeList = () => { f.salesB.schema.find(field => field.key === 'wx').field_name = 'Renamed while snapshotting'; };
    await assert.rejects(f.mirror.sync(), { code: 'MIRROR_TARGET_SCHEMA_CHANGED_DURING_SCAN' });
    assert.equal(f.log.length, 0);
  } finally { f.close(); }
});

function renameAndReuse(client, logicalKey, newName) {
  const field = client.schema.find(field => field.key === logicalKey), oldName = field.field_name;
  field.field_name = newName;
  client.schema.push({ key: 'unrelated', field_id: 'fldUnrelatedReplacement999', field_name: oldName, type: 1, property: {} });
  for (const record of client.records.values()) { record.fields[newName] = record.fields[oldName]; record.fields[oldName] = 'unrelated-column-sentinel'; }
  return oldName;
}

test('source rename with old-name reuse between feedback reads never overwrites the unrelated column', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过'; f.log.length = 0;
    let renamed = false;
    f.salesA.hooks.beforeRead = () => { if (!renamed) { renamed = true; renameAndReuse(f.source, 'wxStatus', 'Renamed Source Status'); } };
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_SOURCE_SCHEMA_CHANGED_BEFORE_WRITE' });
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === sourceToken).length, 0);
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], 'unrelated-column-sentinel');
    delete f.salesA.hooks.beforeRead;
    await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(f.source.records.get('recSource1').fields['Renamed Source Status'], '未通过');
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], 'unrelated-column-sentinel');
  } finally { f.close(); }
});

test('target rename and old-name reuse during final source GET prevent a stale child PUT', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); f.source.records.get('recSource1').fields.Wechat = 'fresh-fixture-wx'; f.log.length = 0;
    let reads = 0;
    f.hooks.beforeSource = () => { if (++reads === 3) renameAndReuse(f.salesA, 'wx', 'Renamed Sales Wechat'); };
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_TARGET_SCHEMA_CHANGED_BEFORE_WRITE' });
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === f.salesA.base).length, 0);
    assert.equal(f.salesA.records.get(targetRecordId).fields.Wechat, 'unrelated-column-sentinel');
    delete f.hooks.beforeSource;
    await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(f.salesA.records.get(targetRecordId).fields['Renamed Sales Wechat'], 'fresh-fixture-wx');
    assert.equal(f.salesA.records.get(targetRecordId).fields.Wechat, 'unrelated-column-sentinel');
  } finally { f.close(); }
});

test('target rename during create ownership check blocks POST before any creating marker is stored', async () => {
  const f = fixture();
  try {
    let reads = 0;
    f.hooks.beforeSource = () => { if (++reads === 2) renameAndReuse(f.salesA, 'wx', 'Renamed Before Create'); };
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_TARGET_SCHEMA_CHANGED_BEFORE_WRITE' });
    assert.equal(createCount(f), 0); assert.equal(f.mirror.rows().length, 0);
    delete f.hooks.beforeSource;
    const created = await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(f.salesA.records.get(created.targetRecordId).fields['Renamed Before Create'], 'fixture-wx');
    assert.equal(f.salesA.records.get(created.targetRecordId).fields.Wechat, undefined);
  } finally { f.close(); }
});

test('feedback failures request one source rescan but persist retry backoff rather than writing every second', async () => {
  const f = fixture(); let now = Date.now();
  try {
    f.mirror.now = () => now;
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
    f.source.hooks.beforeUpdate = () => { throw Object.assign(new Error('definite rejection'), { code: '99991672' }); };
    const first = await f.mirror.sync(); assert.equal(first.sourceWrites, 1); assert.ok(first.nextRetryAt > now);
    const early = await f.mirror.sync(); assert.equal(early.sourceWrites, 0);
    for (let attempt = 2; attempt <= 8; attempt++) { now = f.mirror.status().nextRetryAt + 1; const retried = await f.mirror.sync(); assert.equal(retried.sourceWrites, 1); }
    assert.equal(f.mirror.status().nextRetryAt, null);
    now += 60_000; assert.equal((await f.mirror.sync()).sourceWrites, 0);
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '未添加');
  } finally { f.close(); }
});

test('an unknown feedback update outcome is counted and confirmed by read without another source write', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
    f.source.hooks.afterUpdate = () => { throw Object.assign(new Error('response lost after commit'), { code: 'NETWORK_OR_TIMEOUT' }); };
    const first = await f.mirror.sync(); assert.equal(first.sourceWrites, 1); assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '未通过');
    delete f.source.hooks.afterUpdate;
    const confirmed = await f.mirror.sync(); assert.equal(confirmed.sourceWrites, 0); assert.equal(confirmed.nextRetryAt, null);
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === sourceToken).length, 1);
  } finally { f.close(); }
});
