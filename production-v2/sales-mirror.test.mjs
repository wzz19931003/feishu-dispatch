import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { SalesMirror, boundedSalesDetailClient } from './sales-mirror.mjs';
import { resolveFields, recordView } from './field-map.mjs';
import { WorkflowClient } from './client.mjs';

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

function fixture({ feedbackFields = ['wxStatus'], filename = ':memory:', detailColumns = false, firstWriteDetails = false, salesDetails, detailBudgetMs, now } = {}) {
  const log = [], source = new FakeClient(sourceToken, 'tblSourceFixture001', schema('Source'), log);
  const childSchema = schema('Child').filter(field => !['owner', 'operator'].includes(field.key));
  const salesA = new FakeClient('SalesAFixtureBase012345', 'tblSalesAFixture001', childSchema, log);
  const salesB = new FakeClient('SalesBFixtureBase012345', 'tblSalesBFixture001', childSchema, log);
  if (detailColumns) {
    source.schema.push({ key: 'leadDate', field_id: 'fldSourceDate000', field_name: '日期', type: 5 });
    for (const child of [salesA, salesB]) child.schema.push(
      { field_id: 'fldChildDate000', field_name: '日期', type: 5 },
      { field_id: 'fldChildOperator000', field_name: '运营名字', type: 1 },
    );
  }
  const target = client => ({ appToken: client.base, tableId: client.table, baseUrl: `https://fixture.feishu.cn/base/${client.base}`, fields: definitions(client.schema.filter(field => field.key)) });
  const config = { enabled: true, appToken: sourceToken, tableIds: { leads: source.table }, fields: { leads: definitions(source.schema) }, mirrors: { enabled: true, feedbackFields }, members: [
    { id: 'sales_a', openId: 'ou_fixture_sales_a', displayName: 'Fixture A', enabled: true, order: 1, target: target(salesA) },
    { id: 'sales_b', openId: 'ou_fixture_sales_b', displayName: 'Fixture B', enabled: true, order: 2, target: target(salesB) },
  ] };
  if (detailColumns) config.staffManagement = { enabled: true };
  if (salesDetails !== undefined) config.mirrors.salesDetails = salesDetails;
  source.records.set('recSource1', { record_id: 'recSource1', fields: { Owner: [{ id: 'ou_fixture_sales_a' }], Operator: [{ id: 'ou_fixture_operator' }], Wechat: 'fixture-wx', Needs: 'fixture-needs', 'Wechat status': '未添加', 'Add method': '客户主动加', 'Party size': 2, 'Sales name': 'Fixture A', FinanceSecret: 12345 } });
  let sourceReadCount = 0;
  const hooks = {};
  const resolveSource = () => resolveFields(source, { appToken: sourceToken, tableId: source.table, fields: config.fields.leads });
  const readSource = async id => {
    sourceReadCount++; await hooks.beforeSource?.(id, sourceReadCount);
    const record = await source.readRecord(source.table, id); return recordView(record, await resolveSource());
  };
  const db = new DatabaseSync(filename), clients = new Map([source, salesA, salesB].map(client => [client.base, client]));
  const construct = () => new SalesMirror({ config, db, sourceClient: source, clientFactory: token => { assert.ok(clients.has(token)); return clients.get(token); }, readSource, resolveSource, detailBudgetMs, now,
    assertLiveConfig: () => hooks.assertLiveConfig?.(),
    operatorNames: () => hooks.staffUnhealthy ? null : new Map([['ou_fixture_operator', '离线运营']]),
    auditDetailsTarget: async (member, stopped, signal, context) => {
      // Existing repair tests model rows created before first-write details were available.
      if (context?.phase === 'create' && !firstWriteDetails) return false;
      return hooks.auditDetailsTarget?.(member, stopped, signal, context) ?? true;
    } });
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

test('sales detail backfill keeps existing record, corrects personal edits and never writes extras back to the source', async () => {
  const f = fixture({ detailColumns: true });
  try {
    const source = f.source.records.get('recSource1');
    source.fields['日期'] = 1_760_000_000_000;
    const assignment = await f.mirror.ensure({ id: 'recSource1' });
    const { fields } = f.salesA.records.get(assignment.targetRecordId);
    assert.equal(fields['日期'], undefined);
    const first = await f.mirror.sync();
    assert.equal(first.detailWrites, 1);
    const target = f.salesA.records.get(assignment.targetRecordId);
    assert.equal(target.fields['日期'], 1_760_000_000_000);
    assert.equal(target.fields['运营名字'], '离线运营');
    assert.equal(f.salesB.records.size, 0);
    assert.equal((await f.mirror.sync()).detailWrites, 0);
    target.fields['运营名字'] = '自行编辑';
    target.fields['Wechat status'] = '未通过';
    source.fields['日期'] = null;
    const update = await f.mirror.sync();
    assert.equal(update.detailWrites, 1);
    assert.equal(update.sourceWrites, 1);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], null);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['运营名字'], '离线运营');
    assert.deepEqual(f.log.filter(entry => entry.base === sourceToken && entry.op === 'update').map(entry => entry.fields), [{ 'Wechat status': '未通过' }]);
    assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('sales details require both columns and current access before first pin, and stop if ownership or field IDs change', async () => {
  let tick = Date.now();
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    const source = f.source.records.get('recSource1');
    source.fields['日期'] = 1_760_000_000_000;
    const assignment = await f.mirror.ensure({ id: 'recSource1' });
    f.hooks.auditDetailsTarget = () => false;
    assert.equal((await f.mirror.sync()).detailWrites, 0);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], undefined);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM v2_sales_detail_pins').get().count, 0);
    f.hooks.auditDetailsTarget = () => true;
    tick += 2000;
    f.salesA.hooks.beforeRead = () => owner(f, 'ou_fixture_sales_b');
    assert.equal((await f.mirror.sync()).detailWrites, 0);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], undefined);
    delete f.salesA.hooks.beforeRead;
    owner(f, 'ou_fixture_sales_a');
    const result = await f.mirror.sync();
    assert.equal(result.detailWrites, 1);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], 1_760_000_000_000);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['运营名字'], '离线运营');
    f.salesA.schema.find(field => field.field_name === '运营名字').field_id = 'fldUnpinnedOperator000';
    source.fields['日期'] = 1_790_000_000_000;
    assert.equal((await f.mirror.sync()).detailWrites, 0);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], 1_760_000_000_000);
    assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('an incomplete opt-in, unhealthy roster or explicit opt-out leaves sales details untouched', async () => {
  for (const gate of ['missing', 'unhealthy', 'off']) {
    const f = fixture({ detailColumns: true, ...(gate === 'off' ? { salesDetails: false } : {}) });
    try {
      f.source.records.get('recSource1').fields['日期'] = 1_760_000_000_000;
      if (gate === 'missing') f.salesA.schema = f.salesA.schema.filter(field => field.field_name !== '运营名字');
      if (gate === 'unhealthy') f.hooks.staffUnhealthy = true;
      f.hooks.auditDetailsTarget = () => assert.fail('A closed gate must not make an access request');
      const assignment = await f.mirror.ensure({ id: 'recSource1' });
      await f.mirror.sync();
      assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], undefined);
    } finally { f.close(); }
  }
});

test('deferred sales details attempt one row per slice and recheck the whitelist for each write', async () => {
  const f = fixture({ detailColumns: true });
  try {
    const source = f.source.records.get('recSource1');
    source.fields['日期'] = 1_760_000_000_000;
    for (const id of ['recSource1', 'recSource2', 'recSource3']) {
      f.source.records.set(id, { ...clone(source), record_id: id });
      await f.mirror.ensure({ id });
    }
    let audits = 0;
    f.hooks.auditDetailsTarget = () => ++audits === 1;
    const core = await f.mirror.sync({ deferDetails: true });
    assert.equal(core.unchanged, 3);
    assert.equal(audits, 0);
    const first = await f.mirror.syncDeferredDetails();
    assert.equal(first.detailWrites, 1);
    assert.equal(first.detailAttempts, 1);
    assert.equal(first.detailPending, 2);
    const denied = await f.mirror.syncDeferredDetails();
    assert.equal(denied.detailWrites, 0);
    assert.equal(denied.detailPending, 2);
    assert.equal(audits, 2);
    assert.equal([...f.salesA.records.values()].filter(record => record.fields['日期']).length, 1);
  } finally { f.close(); }
});

test('a single failed detail stays pending and retries without another full scan', async () => {
  let tick = 1_760_000_000_000;
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    f.source.records.get('recSource1').fields.日期 = tick;
    const target = await f.mirror.ensure({ id: 'recSource1' });
    await f.mirror.sync({ deferDetails: true });
    f.hooks.auditDetailsTarget = () => false;
    const denied = await f.mirror.syncDeferredDetails();
    assert.equal(denied.detailPending, 1); assert.equal(denied.detailWrites, 0);
    assert.equal(denied.detailLastErrorCode, 'SALES_DETAIL_ACCESS_UNVERIFIED');
    const reads = f.source.metrics.read;
    f.hooks.auditDetailsTarget = () => true;
    assert.equal((await f.mirror.syncDeferredDetails()).detailAttempts, 0);
    assert.equal(f.source.metrics.read, reads);
    tick = denied.detailNextAttemptAt;
    const retry = await f.mirror.syncDeferredDetails();
    assert.equal(retry.detailWrites, 1); assert.equal(retry.detailConfirmed, 1); assert.equal(retry.detailPending, 0);
    assert.equal(f.salesA.records.get(target.targetRecordId).fields.日期, 1_760_000_000_000);
    assert.equal(f.mirror.latest('recSource1').detailJob.pending, false);
    assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('detail retries rotate past one denied row and keep durable age across a replaced core snapshot', async () => {
  let tick = 1_760_000_000_000;
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    const first = f.source.records.get('recSource1'); first.fields.日期 = tick;
    f.source.records.set('recSource2', { ...clone(first), record_id: 'recSource2', fields: { ...clone(first.fields), Owner: [{ id: 'ou_fixture_sales_b' }] } });
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.ensure({ id: 'recSource2' });
    await f.mirror.sync({ deferDetails: true });
    f.hooks.auditDetailsTarget = member => member.id !== 'sales_a';
    const denied = await f.mirror.syncDeferredDetails(); assert.equal(denied.detailPending, 2);
    const since = denied.detailOldestPendingAt;
    const second = await f.mirror.syncDeferredDetails(); assert.equal(second.detailWrites, 1); assert.equal(second.detailPending, 1);
    await assert.rejects(f.mirror.sync({ deferDetails: true, shouldStop: () => true }), { code: 'MIRROR_STOP_REQUESTED' });
    assert.equal(f.mirror.hasPendingDetails(), true);
    tick += 1000; await f.mirror.sync({ deferDetails: true });
    assert.equal(f.mirror.detailStatus().detailOldestPendingAt, since);
    assert.equal((await f.mirror.syncDeferredDetails()).detailAttempts, 0);
    f.hooks.auditDetailsTarget = () => true; tick = f.mirror.detailStatus().detailNextAttemptAt;
    assert.equal((await f.mirror.syncDeferredDetails()).detailWrites, 1);
  } finally { f.close(); }
});

test('an unknown detail PUT is confirmed by GET without repeating the write', async () => {
  let tick = 1_760_000_000_000;
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    f.source.records.get('recSource1').fields.日期 = tick;
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync({ deferDetails: true });
    f.salesA.hooks.afterUpdate = () => { throw Object.assign(new Error('offline lost response'), { code: 'NETWORK_OR_TIMEOUT' }); };
    const unknown = await f.mirror.syncDeferredDetails();
    assert.equal(unknown.detailWriteUnconfirmed, 1); assert.equal(unknown.detailPending, 1);
    const updates = () => f.log.filter(entry => entry.op === 'update' && entry.base === f.salesA.base).length;
    assert.equal(updates(), 1);
    delete f.salesA.hooks.afterUpdate; tick = unknown.detailNextAttemptAt;
    const confirmed = await f.mirror.syncDeferredDetails();
    assert.equal(confirmed.detailWrites, 0); assert.equal(confirmed.detailConfirmed, 1); assert.equal(confirmed.detailPending, 0);
    assert.equal(updates(), 1); assert.equal(f.mirror.latest('recSource1').detailJob.writeUnconfirmed, false);
  } finally { f.close(); }
});

test('a detail PUT response with no confirmed values is held for a later read', async () => {
  let tick = 1_760_000_000_000;
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    f.source.records.get('recSource1').fields.日期 = tick;
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync({ deferDetails: true });
    const update = f.salesA.updateRecord;
    f.salesA.updateRecord = async function (...args) { const response = await update.apply(this, args); return { record_id: response.record_id, fields: {} }; };
    const first = await f.mirror.syncDeferredDetails();
    assert.equal(first.detailPending, 1); assert.equal(first.detailWriteUnconfirmed, 1); assert.equal(first.detailConfirmed, 0);
    tick = first.detailNextAttemptAt;
    assert.equal((await f.mirror.syncDeferredDetails()).detailConfirmed, 1);
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === f.salesA.base).length, 1);
  } finally { f.close(); }
});

test('a detail owner change during ACL checking prevents the target PUT', async () => {
  const f = fixture({ detailColumns: true });
  try {
    f.source.records.get('recSource1').fields.日期 = 1_760_000_000_000;
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync({ deferDetails: true });
    f.log.length = 0;
    f.hooks.auditDetailsTarget = () => { owner(f, 'ou_fixture_sales_b'); return true; };
    const result = await f.mirror.syncDeferredDetails();
    assert.equal(result.detailWrites, 0); assert.equal(result.detailPending, 0);
    assert.equal(result.detailLastErrorCode, 'SALES_DETAIL_OWNER_CHANGED');
    assert.equal(f.log.some(entry => entry.op === 'update'), false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM v2_sales_detail_pins').get().n, 0);
  } finally { f.close(); }
});

test('a local activation change after final source reads prevents the scalar PUT and first pin', async () => {
  const f = fixture({ detailColumns: true });
  try {
    f.source.records.get('recSource1').fields.日期 = 1_760_000_000_000;
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync({ deferDetails: true });
    f.hooks.assertLiveConfig = () => { throw Object.assign(new Error('offline switch changed'), { code: 'LIVE_CONFIG_BINDING_CHANGED' }); };
    f.log.length = 0;
    const result = await f.mirror.syncDeferredDetails();
    assert.equal(result.detailWrites, 0); assert.equal(result.detailPending, 1);
    assert.equal(result.detailLastErrorCode, 'LIVE_CONFIG_BINDING_CHANGED');
    assert.equal(f.log.some(entry => entry.op === 'update'), false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM v2_sales_detail_pins').get().n, 0);
  } finally { f.close(); }
});

test('a final source rename with old-name reuse holds the retry until a fresh complete schema', async () => {
  let tick = 1_760_000_000_000, reads = 0;
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    f.source.records.get('recSource1').fields.日期 = tick;
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync({ deferDetails: true });
    f.source.hooks.beforeRead = () => {
      if (++reads !== 2) return;
      f.source.schema.find(field => field.key === 'leadDate').field_name = '新日期';
      f.source.schema.push({ field_id: 'fldUnrelatedDate000', field_name: '日期', type: 5 });
      const fields = f.source.records.get('recSource1').fields;
      fields.新日期 = fields.日期; fields.日期 = 1_790_000_000_000;
    };
    const held = await f.mirror.syncDeferredDetails();
    assert.equal(held.detailWrites, 0); assert.equal(held.detailPending, 1);
    assert.equal(held.detailLastErrorCode, 'SALES_DETAIL_SOURCE_SCHEMA_CHANGED');
    delete f.source.hooks.beforeRead;
    tick = held.detailNextAttemptAt; await f.mirror.sync({ deferDetails: true });
    assert.equal((await f.mirror.syncDeferredDetails()).detailWrites, 1);
    assert.equal([...f.salesA.records.values()][0].fields.日期, 1_760_000_000_000);
    assert.equal(f.source.records.get('recSource1').fields.日期, 1_790_000_000_000);
  } finally { f.close(); }
});

test('scalar rate limits survive new core stages and a reconstructed mirror without a tight retry loop', async () => {
  let tick = 1_760_000_000_000;
  const f = fixture({ detailColumns: true, now: () => tick });
  try {
    f.source.records.get('recSource1').fields.日期 = tick;
    await f.mirror.ensure({ id: 'recSource1' }); await f.mirror.sync({ deferDetails: true });
    let audits = 0;
    f.hooks.auditDetailsTarget = () => { audits++; throw Object.assign(new Error('offline limit'), { code: 'SALES_DETAILS_RATE_LIMIT' }); };
    const limited = await f.mirror.syncDeferredDetails();
    assert.equal(limited.detailRateLimited, 1); assert.equal(limited.detailPending, 1);
    assert(limited.detailNextAttemptAt >= tick + 30_000);
    const rebuilt = f.construct(); tick += 1000; await rebuilt.sync({ deferDetails: true });
    assert.equal((await rebuilt.syncDeferredDetails()).detailAttempts, 0); assert.equal(audits, 1);
    f.hooks.auditDetailsTarget = () => true; tick = limited.detailNextAttemptAt;
    assert.equal((await rebuilt.syncDeferredDetails()).detailWrites, 1);
  } finally { f.close(); }
});

test('a comparatively slow source record finishes in the deferred slice after ordinary work returns', async () => {
  const f = fixture({ detailColumns: true, detailBudgetMs: 750 });
  try {
    const source = f.source.records.get('recSource1');
    source.fields['日期'] = 1_760_000_000_000;
    const assignment = await f.mirror.ensure({ id: source.record_id });
    let entered = false;
    f.source.hooks.beforeRead = async () => { entered = true; await delay(65); };
    f.salesA.hooks.beforeRead = async () => { await delay(20); };
    f.hooks.auditDetailsTarget = async () => { await delay(15); return true; };
    const core = await f.mirror.sync({ deferDetails: true });
    assert.equal(core.unchanged, 1);
    assert.equal(entered, false);
    const result = await f.mirror.syncDeferredDetails();
    assert.equal(entered, true);
    assert.equal(result.detailTimeouts, 0);
    assert.equal(result.detailWrites, 1);
    assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], source.fields['日期']);
  } finally { f.close(); }
});

test('an incoming event preempts deferred sales work, while a hard deadline reports its own cause', async () => {
  for (const behavior of ['wake', 'timeout']) {
    const f = fixture({ detailColumns: true, detailBudgetMs: behavior === 'timeout' ? 65 : 1000 });
    try {
      const source = f.source.records.get('recSource1');
      source.fields['日期'] = 1_760_000_000_000;
      const assignment = await f.mirror.ensure({ id: source.record_id });
      await f.mirror.sync({ deferDetails: true });
      const controller = new AbortController();
      f.hooks.auditDetailsTarget = async (_member, _stop, signal) => {
        if (behavior === 'wake') controller.abort();
        await delay(2000, null, { signal });
        assert.fail('Deferred audit should have been interrupted');
      };
      const result = await f.mirror.syncDeferredDetails({ signal: controller.signal });
      assert.equal(result.detailAttempts, 1);
      assert.equal(result.detailPreempted, Number(behavior === 'wake'));
      assert.equal(result.detailTimeouts, Number(behavior === 'timeout'));
      assert.equal(result.detailWrites, 0);
      assert.equal(f.salesA.records.get(assignment.targetRecordId).fields['日期'], undefined);
    } finally { f.close(); }
  }
});

test('optional sales transport aborts the in-flight request on its deadline', async () => {
  let requestSignal;
  const client = new WorkflowClient({}, { fetchImpl: async (_url, { signal }) => {
    requestSignal = signal;
    await delay(2000, null, { signal });
    assert.fail('The request should be cancelled before its ordinary timeout');
  } });
  client.cachedToken = { value: 'fake-scalar-token', expiresAt: Date.now() + 60000 };
  const deadline = AbortSignal.timeout(30);
  const scoped = boundedSalesDetailClient(client, deadline);
  await assert.rejects(scoped.api('/open-apis/bitable/v1/mock'), { code: 'NETWORK_OR_TIMEOUT' });
  assert.equal(deadline.aborted, true);
  assert.equal(requestSignal.aborted, true);
});

test('optional sales transport returns upon a Feishu rate limit without a retry or core behavior change', async () => {
  let requests = 0, sleeps = 0;
  const client = new WorkflowClient({}, { fetchImpl: async () => {
    requests++;
    return Response.json({ code: 99991400 }, { status: 429, headers: { 'retry-after': '5' } });
  }, sleepImpl: async () => { sleeps++; } });
  client.cachedToken = { value: 'fake-scalar-token', expiresAt: Date.now() + 60000 };
  const scoped = boundedSalesDetailClient(client, new AbortController().signal);
  await assert.rejects(scoped.api('/open-apis/bitable/v1/mock'), { code: 'SALES_DETAILS_RATE_LIMIT' });
  assert.deepEqual([requests, sleeps], [1, 0]);
  await assert.rejects(client.api('/open-apis/bitable/v1/mock'), { code: '99991400' });
  assert.deepEqual([requests, sleeps], [5, 3]);
});

test('a rate-limited scalar attempt leaves both sales targets quiet for the rest of the scan', async () => {
  const f = fixture({ detailColumns: true });
  try {
    const first = f.source.records.get('recSource1');
    first.fields['日期'] = 1_760_000_000_000;
    const second = { ...clone(first), record_id: 'recSource2' };
    second.fields.Owner = [{ id: f.config.members[1].openId }];
    f.source.records.set(second.record_id, second);
    await f.mirror.ensure({ id: first.record_id });
    await f.mirror.ensure({ id: second.record_id });
    let audits = 0;
    f.hooks.auditDetailsTarget = () => { audits++; throw Object.assign(new Error('offline rate limit'), { code: 'SALES_DETAILS_RATE_LIMIT' }); };
    const result = await f.mirror.sync();
    assert.equal(result.unchanged, 2);
    assert.equal(audits, 1);
    assert.equal(result.detailWrites, 0);
  } finally { f.close(); }
});

test('approved optional feedback and wxStatus write back while addMethod stays source-authoritative', async () => {
  const f = fixture({ feedbackFields: ['wxStatus', 'wx', 'needs', 'partySize'] });
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    const child = f.salesA.records.get(targetRecordId);
    Object.assign(child.fields, { Wechat: 'corrected-fixture', Needs: 'updated-needs', 'Add method': '销售主动加', 'Wechat status': '未通过', 'Party size': 3 });
    await f.mirror.sync();
    const patch = f.log.find(entry => entry.base === sourceToken && entry.op === 'update').fields;
    assert.deepEqual(patch, { Wechat: 'corrected-fixture', Needs: 'updated-needs', 'Wechat status': '未通过', 'Party size': 3 });
    assert.equal(f.source.records.get('recSource1').fields['Add method'], '客户主动加');
    assert.equal(child.fields['Add method'], '客户主动加');
    f.config.mirrors.feedbackFields = ['wxStatus', 'addMethod'];
    assert.throws(f.construct, { code: 'MIRROR_FEEDBACK_INVALID' });
  } finally { f.close(); }
});

test('a persisted legacy addMethod retry is cleared without updating the master value', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    const child = f.salesA.records.get(targetRecordId);
    f.mirror.put({ ...f.mirror.latest('recSource1'), pendingFeedback: { addMethod: '销售主动加' },
      feedbackAttempts: 8, feedbackBlocked: true, feedbackNextAttemptAt: Date.now() + 60_000 });
    child.fields['Add method'] = '销售主动加';
    await f.construct().sync();
    assert.ok(!f.log.some(entry => entry.base === sourceToken && entry.op === 'update'));
    assert.equal(child.fields['Add method'], '客户主动加');
    assert.equal(f.mirror.latest('recSource1').pendingFeedback, null);
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

const exactFeedback = (f, targetRecordId, extra = {}) => f.mirror.feedbackForRecord({
  appToken: f.salesA.base, tableId: f.salesA.table, targetRecordId, ...extra,
});

test('first sales POST includes verified date and registered operator with one create and no later scalar PUT', async () => {
  const f = fixture({ detailColumns: true, firstWriteDetails: true });
  try {
    f.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000;
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    const created = f.log.find(entry => entry.op === 'create');
    assert.equal(created.fields['日期'], 1_800_000_000_000); assert.equal(created.fields['运营名字'], '离线运营');
    assert.equal(f.salesA.records.get(targetRecordId).fields['日期'], 1_800_000_000_000);
    const row = f.mirror.latest('recSource1'); assert.equal(row.detailJob.pending, false);
    assert.equal(Object.hasOwn(row.baseValues, 'leadDate'), false); assert.equal(Object.hasOwn(row.baseValues, 'operatorName'), false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM v2_sales_detail_pins').get().n, 1);
    await f.mirror.sync({ deferDetails: true }); await f.mirror.syncDeferredDetails();
    assert.equal(createCount(f), 1); assert.equal(f.log.filter(entry => entry.op === 'update').length, 0);
  } finally { f.close(); }
});

test('optional create ACL is parallel, deadline bounded and never promotes a late response', async () => {
  const f = fixture({ detailColumns: true, firstWriteDetails: true, detailBudgetMs: 20 });
  try {
    f.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000;
    let started = false, ended = false;
    f.hooks.auditDetailsTarget = async (_member, _stop, signal, { phase }) => {
      assert.equal(phase, 'create'); started = true;
      await delay(65); ended = true; assert.equal(signal.aborted, true); return true;
    };
    const original = f.salesA.api.bind(f.salesA);
    f.salesA.api = async (...args) => { await delay(0); assert.equal(started, true); return original(...args); };
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(ended, false); assert.equal(f.salesA.records.get(targetRecordId).fields['日期'], undefined);
    assert.equal(f.mirror.latest('recSource1').detailJob.pending, true);
    await delay(75); assert.equal(createCount(f), 1); assert.equal(f.salesA.records.get(targetRecordId).fields['日期'], undefined);
  } finally { f.close(); }
});

test('owner and target schema are re-read after the optional create audit finishes', async () => {
  const f = fixture({ detailColumns: true, firstWriteDetails: true });
  try {
    f.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000;
    f.hooks.auditDetailsTarget = async member => {
      if (member.id === 'sales_a') owner(f, 'ou_fixture_sales_b'); return true;
    };
    const result = await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(f.salesA.records.size, 0); assert.equal(createCount(f), 1);
    assert.ok(result.url.includes(f.salesB.base));
    assert.equal(f.salesB.records.get(result.targetRecordId).fields['运营名字'], '离线运营');
  } finally { f.close(); }
});

test('unavailable, replaced or untrusted optional columns fall back to one minimum sales create', async () => {
  for (const cause of ['denied', 'throws', 'column', 'pin', 'operator']) {
    const f = fixture({ detailColumns: true, firstWriteDetails: true });
    try {
      f.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000;
      if (cause === 'denied') f.hooks.auditDetailsTarget = async () => false;
      if (cause === 'throws') f.hooks.auditDetailsTarget = async () => { throw new Error('fake ACL outage'); };
      if (cause === 'column') f.salesA.schema.find(field => field.field_name === '日期').type = 1;
      if (cause === 'pin') f.db.prepare('INSERT INTO v2_sales_detail_pins VALUES(?,?,?)').run(JSON.stringify([f.salesA.base, f.salesA.table]), 'fldPreviousDate000', 'fldPreviousOperator000');
      if (cause === 'operator') f.source.records.get('recSource1').fields.Operator = [{ id: 'ou_unknown_operator' }];
      const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
      const row = f.salesA.records.get(targetRecordId); assert.equal(row.fields.Wechat, 'fixture-wx', cause);
      assert.equal(row.fields['日期'], undefined, cause); assert.equal(row.fields['运营名字'], undefined, cause); assert.equal(createCount(f), 1, cause);
    } finally { f.close(); }
  }
});

test('initial detail schema change during ACL falls back safely and source activation change still prevents any POST', async () => {
  const f = fixture({ detailColumns: true, firstWriteDetails: true });
  try {
    f.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000;
    f.hooks.auditDetailsTarget = async () => {
      await delay(1);
      f.salesA.schema.find(field => field.field_name === '日期').field_id = 'fldReplacementDate999';
      return true;
    };
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    assert.equal(f.salesA.records.get(targetRecordId).fields['日期'], undefined);
    assert.equal(createCount(f), 1);
  } finally { f.close(); }
  const disabled = fixture({ detailColumns: true, firstWriteDetails: true });
  try {
    disabled.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000;
    disabled.hooks.assertLiveConfig = () => { disabled.config.enabled = false; };
    await assert.rejects(disabled.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_WRITES_DISABLED' });
    assert.equal(createCount(disabled), 0); assert.equal(disabled.db.prepare('SELECT COUNT(*) AS n FROM v2_sales_detail_pins').get().n, 0);
  } finally { disabled.close(); }
});

test('a detail-inclusive unknown create is held for review without a second base-only POST', async () => {
  const f = fixture({ detailColumns: true, firstWriteDetails: true });
  try {
    f.source.records.get('recSource1').fields['日期'] = 1_800_000_000_000; f.salesA.createUnknown = true;
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' });
    await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' });
    assert.equal(createCount(f), 1); assert.equal(f.mirror.latest('recSource1').state, 'create_review');
    assert.equal([...f.salesA.records.values()][0].fields['运营名字'], '离线运营');
  } finally { f.close(); }
});

test('a positively echoed create can retain a rapid real status edit and reconcile it once by exact record', async () => {
  const f = fixture();
  try {
    f.salesA.hooks.beforeRead = id => { f.salesA.records.get(id).fields['Wechat status'] = '未通过'; };
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); delete f.salesA.hooks.beforeRead;
    assert.equal(f.mirror.latest('recSource1').state, 'active'); assert.equal(f.mirror.latest('recSource1').baseValues.wxStatus, '未添加');
    const result = await exactFeedback(f, targetRecordId);
    assert.equal(result.statusSources.length, 1); assert.equal(result.statusSources[0].wxStatus, '未通过');
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '未通过');
    assert.equal((await exactFeedback(f, targetRecordId)).statusSources.length, 0); assert.equal(createCount(f), 1);
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === sourceToken).length, 1);
    assert.equal(f.source.metrics.list + f.salesA.metrics.list + f.salesB.metrics.list, 0);
  } finally { f.close(); }
});

test('create confirmation still requires optional feedback values and explicit status evidence rather than missing cells', async () => {
  for (const cause of ['wx', 'needs', 'partySize', 'missing-status', 'no-echo']) {
    const f = fixture({ feedbackFields: ['wxStatus', 'wx', 'needs', 'partySize'] });
    try {
      f.salesA.hooks.beforeRead = id => {
        const fields = f.salesA.records.get(id).fields;
        if (cause === 'wx') fields.Wechat = 'different-fixture-wx';
        if (cause === 'needs') fields.Needs = 'different-fixture-needs';
        if (cause === 'partySize') fields['Party size'] = 9;
        if (cause === 'missing-status') delete fields['Wechat status'];
        if (cause === 'no-echo') fields['Wechat status'] = '未通过';
      };
      if (cause === 'no-echo') { const create = f.salesA.createRecord.bind(f.salesA); f.salesA.createRecord = async (...args) => { const result = await create(...args); delete result.fields['Wechat status']; return result; }; }
      await assert.rejects(f.mirror.ensure({ id: 'recSource1' }), { code: 'MIRROR_CREATE_CONTENT_UNCONFIRMED' });
      assert.equal(createCount(f), 1, cause); assert.equal(f.mirror.latest('recSource1').state, 'active', cause);
    } finally { f.close(); }
  }
});

test('targeted feedback accepts only a unique active backend mapping and does not repair global ownership', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    const before = clone(f.salesA.metrics);
    assert.deepEqual(await exactFeedback(f, targetRecordId, { tableId: f.salesB.table }), { statusSources: [], needsReconciliation: true });
    assert.deepEqual(await exactFeedback(f, targetRecordId, { appToken: f.salesB.base }), { statusSources: [], needsReconciliation: true });
    assert.deepEqual(await exactFeedback(f, 'recUnknownChild'), { statusSources: [], needsReconciliation: true });
    assert.deepEqual(f.salesA.metrics, before);
    owner(f, 'ou_fixture_sales_b'); f.log.length = 0;
    assert.deepEqual(await exactFeedback(f, targetRecordId), { statusSources: [], needsReconciliation: true });
    assert.equal(f.log.length, 0); assert.equal(f.salesA.records.size, 1); assert.equal(f.salesB.records.size, 0);
    const row = f.mirror.latest('recSource1'); f.mirror.put({ ...row, state: 'revoked' });
    assert.deepEqual(await exactFeedback(f, targetRecordId), { statusSources: [], needsReconciliation: true });
  } finally { f.close(); }
});

test('targeted feedback rechecks the child after awaited validation and ignores a rapid B to A reversal', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' });
    f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
    let checks = 0;
    f.hooks.assertLiveConfig = () => { if (++checks === 2) f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未添加'; };
    f.log.length = 0;
    const result = await exactFeedback(f, targetRecordId);
    assert.deepEqual(result, { statusSources: [], needsReconciliation: true });
    assert.equal(f.source.records.get('recSource1').fields['Wechat status'], '未添加');
    assert.equal(f.mirror.statusWriteback('recSource1'), null); assert.equal(f.log.length, 0);
    delete f.hooks.assertLiveConfig;
    assert.deepEqual(await exactFeedback(f, targetRecordId), { statusSources: [] }); assert.equal(f.log.length, 0);
  } finally { f.close(); }
});

test('targeted feedback checks final owner, ACL and stop before any source update', async () => {
  for (const cause of ['owner', 'acl', 'stop']) {
    const f = fixture();
    try {
      const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
      let checks = 0, stop = false;
      if (cause === 'owner') f.hooks.assertLiveConfig = () => { if (++checks === 2) owner(f, 'ou_fixture_sales_b'); };
      if (cause === 'acl') f.hooks.auditDetailsTarget = async () => false;
      if (cause === 'stop') f.hooks.assertLiveConfig = () => { if (++checks === 2) stop = true; };
      f.log.length = 0;
      if (cause === 'owner') assert.equal((await exactFeedback(f, targetRecordId)).needsReconciliation, true);
      else await assert.rejects(exactFeedback(f, targetRecordId, { shouldStop: () => stop }), { code: cause === 'acl' ? 'MIRROR_TARGET_ACCESS_UNVERIFIED' : 'MIRROR_STOP_REQUESTED' });
      assert.equal(f.log.length, 0, cause); assert.equal(f.mirror.statusWriteback('recSource1'), null, cause);
    } finally { f.close(); }
  }
});

test('targeted feedback never replaces a missing child or replays an unknown source update receipt', async () => {
  const f = fixture();
  try {
    const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
    f.source.hooks.afterUpdate = () => { throw Object.assign(new Error('fake lost acknowledgement'), { code: 'NETWORK_OR_TIMEOUT' }); };
    await assert.rejects(exactFeedback(f, targetRecordId), { code: 'NETWORK_OR_TIMEOUT' });
    delete f.source.hooks.afterUpdate;
    assert.deepEqual(await exactFeedback(f, targetRecordId), { statusSources: [] });
    assert.equal(f.mirror.statusWriteback('recSource1'), null);
    assert.equal(f.log.filter(entry => entry.op === 'update' && entry.base === sourceToken).length, 1);
    f.salesA.records.delete(targetRecordId);
    assert.equal((await exactFeedback(f, targetRecordId)).needsReconciliation, true); assert.equal(createCount(f), 1);
  } finally { f.close(); }
});

test('targeted feedback source and child rename races stop before writing a reused field name', async () => {
  for (const side of ['source', 'child']) {
    const f = fixture();
    try {
      const { targetRecordId } = await f.mirror.ensure({ id: 'recSource1' }); f.salesA.records.get(targetRecordId).fields['Wechat status'] = '未通过';
      let reads = 0;
      f.salesA.hooks.beforeRead = () => { if (++reads === 2) renameAndReuse(side === 'source' ? f.source : f.salesA, 'wxStatus', 'Renamed Targeted Status'); };
      f.log.length = 0;
      await assert.rejects(exactFeedback(f, targetRecordId), { code: 'MIRROR_FEEDBACK_SCHEMA_CHANGED' });
      assert.equal(f.log.length, 0); assert.equal(f.mirror.statusWriteback('recSource1'), null);
    } finally { f.close(); }
  }
});
