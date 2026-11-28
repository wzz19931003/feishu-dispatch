import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from './engine.mjs';
import { SalesMirror } from './sales-mirror.mjs';
import { prepareV22Config } from './prepare-v22-config.mjs';

const clone = value => structuredClone(value);
const names = { owner: '负责人', operator: '录入运营', wx: '客户微信', needs: '客户需求', wxStatus: '微信状态', addMethod: '添加方式', actualSlot: '实际分配位', actualSort: '实际分配顺序', salesName: '实际销售' };
const types = { owner: 11, operator: 11, wx: 1, needs: 1, wxStatus: 1, addMethod: 1, actualSlot: 2, actualSort: 2, salesName: 1 };
const sourceFields = () => Object.fromEntries(Object.keys(names).map(key => [key, { fieldId: `fldSource${key}001`, types: [types[key]], ...(['owner', 'operator'].includes(key) ? { multiple: false } : {}) }]));
const target = suffix => ({ appToken: `PrivateBase${suffix}12345`, baseUrl: `https://example.feishu.cn/base/PrivateBase${suffix}12345`, tableId: `tblPrivate${suffix}123`, fields: Object.fromEntries(['wx', 'needs', 'wxStatus'].map(key => [key, { fieldId: `fldTarget${suffix}${key}001`, types: [1] }])) });
const member = (suffix, order) => ({ id: `sales_${suffix}`, openId: `ou_offlineSales${suffix}`, displayName: `模拟销售${suffix}`, order, enabled: true, target: target(suffix) });
const configuration = () => ({ appId: 'cli_workflow_offline', appSecret: 'offline-fixture-secret', appToken: 'SourceBaseToken12345', baseUrl: 'https://example.feishu.cn/base/SourceBaseToken12345', tableIds: { leads: 'tblSourceLeads123' },
  fields: { leads: sourceFields() }, members: [member('A', 10), member('B', 20)], requiredLeadFields: ['wx', 'needs'], enabled: true, notification: { enabled: true }, allowedHost: 'OFFLINE-TEST-ONLY', dbPath: 'data/workflow.sqlite', mirrors: { enabled: true }, pollSeconds: 600 });
const lead = (suffix, logical = {}) => ({ record_id: `recLead${suffix}`, fields: Object.fromEntries(Object.entries({ owner: '', operator: 'ou_offlineOperatorA', wx: `offline_customer_${suffix}`, needs: '仅离线测试需求', wxStatus: '待添加', addMethod: '销售主动加', actualSlot: null, actualSort: null, salesName: '', ...logical }).map(([key, value]) => [names[key], ['owner', 'operator'].includes(key) ? value ? [{ id: value }] : [] : value])) });
class Client {
  constructor(records = []) {
    this.records = new Map(records.map(record => [record.record_id, clone(record)])); this.schema = Object.entries(sourceFields()).map(([key, spec]) => ({ field_id: spec.fieldId, field_name: names[key], type: types[key], property: types[key] === 11 ? { multiple: false } : {} }));
    this.writes = []; this.sent = []; this.operations = []; this.writeError = null; this.sendError = null;
  }
  async api(url) { assert.equal(url.includes('/tblSourceLeads123/fields'), true); return { items: clone(this.schema), has_more: false }; }
  async listRecords(table) { assert.equal(table, 'tblSourceLeads123'); return { items: clone([...this.records.values()]), hasMore: false, pageToken: null }; }
  async readRecord(table, id) { assert.equal(table, 'tblSourceLeads123'); this.operations.push(`read:${id}`); if (!this.records.has(id)) throw Object.assign(new Error('offline missing'), { code: 'SOURCE_NOT_FOUND' }); return clone(this.records.get(id)); }
  async updateRecord(table, id, fields) { assert.equal(table, 'tblSourceLeads123'); this.operations.push(`write:${id}`); this.writes.push({ id, fields: clone(fields) }); if (this.writeError) throw this.writeError; Object.assign(this.records.get(id).fields, clone(fields)); return clone(this.records.get(id)); }
  async sendNotification(input) { this.operations.push(`send:${input.recipientOpenId}`); this.sent.push(clone(input)); const error = typeof this.sendError === 'function' ? this.sendError(input) : this.sendError; if (error) throw error; return { messageId: `offline_message_${this.sent.length}` }; }
  add(record) { this.records.set(record.record_id, clone(record)); }
  change(id, logical) { const record = this.records.get(id); for (const [key, value] of Object.entries(logical)) record.fields[names[key]] = ['owner', 'operator'].includes(key) ? value ? [{ id: value }] : [] : value; }
  rename(key, name) { const field = this.schema.find(field => field.field_id === sourceFields()[key].fieldId), before = field.field_name; field.field_name = name; for (const record of this.records.values()) { record.fields[name] = record.fields[before]; delete record.fields[before]; } }
}
class Mirror {
  constructor(engine) { this.engine = engine; this.calls = []; this.syncCalls = 0; this.error = null; this.statusReceipts = new Map(); this.statusChanges = 0; }
  statusWriteback(id) { return this.statusReceipts.get(id); }
  editSalesStatus(id, status) {
    const before = this.engine.client.records.get(id).fields;
    this.statusReceipts.set(id, { id: `fixture-status-${++this.statusChanges}`, owner: before.负责人[0]?.id, from: before.微信状态, to: status });
    this.engine.client.change(id, { wxStatus: status });
  }
  async ensure(view) {
    this.calls.push(view.id); this.engine.client.operations.push(`mirror:${view.id}`); if (this.error) throw this.error;
    const owner = this.engine.config.members.find(member => member.openId === view.owner); assert.ok(owner?.target);
    const targetRecordId = `recPrivate${view.id}${owner.id}`, url = new URL(owner.target.baseUrl); url.searchParams.set('table', owner.target.tableId); url.searchParams.set('record', targetRecordId);
    return { url: url.href, targetRecordId };
  }
  async sync({ sourceViews } = {}) { this.syncCalls++; assert.ok(Array.isArray(sourceViews)); return { synchronized: sourceViews.length }; }
}
async function fixture(t, { config = configuration(), client = new Client(), now, memberProvider, dbPath = ':memory:', initialize = {} } = {}) {
  const engine = new WorkflowEngine({ config, client, dbPath, now, memberProvider }); engine.mirror = new Mirror(engine); t.after(() => engine.close());
  assert.equal((await engine.initialize(initialize)).ok, true); return { engine, client, mirror: engine.mirror };
}
const numericRejection = () => Object.assign(new Error('offline definite rejection'), { code: '99991400' });

function targetEvent(target, id, recordId, action = 'record_edited') {
  return { id, appToken: target.appToken, tableId: target.tableId, recordIds: [recordId], actions: [{ action, recordId }] };
}

const masterEditTime = Date.UTC(2026, 10, 26, 10);
function directStatusEdit(client, id, { actor = 'ou_offlineSalesA', revision = 41, editedAt = masterEditTime + 1000, from = '待添加', to = '未通过' } = {}) {
  client.change(id, { wxStatus: to });
  const record = client.records.get(id);
  record.last_modified_by = { id: actor }; record.last_modified_time = editedAt;
  return { recordId: id, actor, revision, editedAt, from, to };
}
function masterStatusEvent(engine, id, edit) {
  return { ...targetEvent({ appToken: engine.config.appToken, tableId: engine.config.tableIds.leads }, id, edit.recordId), statusEdits: [clone(edit)] };
}
const statusTasks = engine => engine.all('v2_outbox').filter(task => task.kind === 'status');

test('a Feishu SDK status event with select IDs and a seconds timestamp generates just one reminder', async t => {
  const { EventDispatcher } = await import('@larksuiteoapi/node-sdk');
  const { WorkflowEvents } = await import('./events.mjs');
  const id = 'recLeadsdkSelect', config = configuration();
  config.fields.leads.wxStatus.types = [3];
  const client = new Client([lead('sdkSelect', { owner: 'ou_offlineSalesA' })]);
  const fieldId = config.fields.leads.wxStatus.fieldId;
  Object.assign(client.schema.find(field => field.field_id === fieldId), { type: 3, property: {
    options: [{ id: 'optOfflineBefore', name: '待添加' }, { id: 'optOfflineAfter', name: '未通过' }],
  } });
  let now = masterEditTime, dispatcher;
  const { engine } = await fixture(t, { config, client, now: () => now });
  class OfflineWS {
    constructor(options) { this.options = options; }
    start({ eventDispatcher }) { dispatcher = eventDispatcher; this.options.onReady(); }
    close() {}
  }
  const events = new WorkflowEvents(config, { sdkLoader: async () => ({ EventDispatcher, WSClient: OfflineWS }) });
  t.after(() => events.stop());
  await events.start(event => engine.acceptEvent(event));
  now += 1_504;
  directStatusEdit(client, id, { editedAt: now });
  client.records.get(id).last_modified_time = String(now);
  const type = 'drive.file.bitable_record_changed_v1';
  const input = { schema: '2.0', header: { event_type: type, event_id: 'offline-select-event' }, event: {
    file_token: config.appToken, table_id: config.tableIds.leads, revision: '42', update_time: Math.floor(now / 1000),
    operator_id: { open_id: 'ou_offlineSalesA' }, action_list: [{ action: 'record_edited', record_id: id,
      before_value: [{ field_id: fieldId, field_value: '"optOfflineBefore"' }],
      after_value: [{ field_id: fieldId, field_value: '["optOfflineAfter"]' }],
    }],
  } };
  await dispatcher.invoke(input);
  await engine.processPendingEvents();
  assert.deepEqual(engine.status().masterStatusCheckCounts, { CONFIRMED: 1 });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].recipientOpenId, 'ou_offlineOperatorA');
  assert.match(client.sent[0].text, /微信状态：未通过/);
  await dispatcher.invoke({ ...input, header: { ...input.header, event_id: 'offline-select-retry' } });
  await engine.processPendingEvents();
  assert.equal(client.sent.length, 1);
  const unknown = clone(input);
  unknown.header.event_id = 'offline-unknown-option';
  unknown.event.revision = 43;
  unknown.event.action_list[0].after_value[0].field_value = '{"id":"optOfflineMissing","name":"未通过"}';
  await dispatcher.invoke(unknown);
  await engine.processPendingEvents();
  assert.equal(engine.status().masterStatusCheckCounts.SELECT_OPTION_UNKNOWN, 1);
  assert.equal(client.sent.length, 1);
});

for (const path of ['quick', 'scan']) test(`direct master status by its current sales owner notifies exactly once through ${path}`, async t => {
  let now = masterEditTime;
  const id = `recLeaddirect${path}`, record = lead(`direct${path}`, { owner: 'ou_offlineSalesA' });
  const { engine, client } = await fixture(t, { client: new Client([record]), now: () => now });
  now += 1000;
  const edit = directStatusEdit(client, id, { editedAt: now });
  const proofReads = [], read = client.readRecord.bind(client);
  client.readRecord = async (table, recordId, options) => { proofReads.push(options); return read(table, recordId); };
  assert.equal(engine.acceptEvent(masterStatusEvent(engine, `direct-event-${path}`, edit)), true);
  if (path === 'quick') {
    client.listRecords = async () => { throw new Error('targeted direct status must not wait for a full list'); };
    await engine.processPendingEvents();
  } else await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(client.sent[0].recipientOpenId, 'ou_offlineOperatorA');
  assert.match(client.sent[0].text, /微信状态：未通过/);
  assert.equal(statusTasks(engine).length, 1); assert.equal(statusTasks(engine)[0].state, 'sent');
  assert.ok(proofReads.some(options => options?.automaticFields === true));
  assert.equal(client.writes.length, 0);
  engine.acceptEvent(masterStatusEvent(engine, `same-revision-other-id-${path}`, edit));
  await engine.processPendingEvents(); await engine.processPendingEvents();
  assert.equal(client.sent.length, 1); assert.equal(statusTasks(engine).length, 1);
});

test('a verified direct status arriving after a snapshot-only scan still notifies once and later revisions can notify again', async t => {
  let now = masterEditTime;
  const id = 'recLeadsnapshotFirst';
  const { engine, client } = await fixture(t, { client: new Client([lead('snapshotFirst', { owner: 'ou_offlineSalesA' })]), now: () => now });
  now += 1000;
  const edit = directStatusEdit(client, id, { editedAt: now });
  await engine.scan({ apply: true });
  assert.equal(engine.get('v2_snapshots', id).view.wxStatus, '未通过');
  assert.equal(client.sent.length, 0); assert.equal(statusTasks(engine).length, 0);
  engine.acceptEvent(masterStatusEvent(engine, 'late-proof-after-snapshot', edit));
  await engine.processPendingEvents(); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(statusTasks(engine).length, 1);
  now += 1000;
  const passed = directStatusEdit(client, id, { revision: 42, editedAt: now, from: '未通过', to: '通过' });
  engine.acceptEvent(masterStatusEvent(engine, 'later-passed-proof', passed)); await engine.processPendingEvents();
  assert.equal(client.sent.length, 1);
  now += 1000;
  const later = directStatusEdit(client, id, { revision: 43, editedAt: now, from: '通过', to: '未通过' });
  engine.acceptEvent(masterStatusEvent(engine, 'later-negative-proof', later)); await engine.processPendingEvents();
  assert.equal(client.sent.length, 2); assert.equal(statusTasks(engine).length, 2);
  engine.acceptEvent(masterStatusEvent(engine, 'replayed-old-revision-after-later-change', edit)); await engine.processPendingEvents();
  assert.equal(client.sent.length, 2);
});

test('direct master status stays silent for another actor, unknown owner, stale source status or stale automatic evidence', async t => {
  for (const cause of ['other_actor', 'unknown_owner', 'source_status', 'modified_actor', 'modified_time', 'no_automatic_fields']) await t.test(cause, async t => {
    let now = masterEditTime;
    const id = `recLeadproof${cause}`;
    const { engine, client } = await fixture(t, { client: new Client([lead(`proof${cause}`, { owner: 'ou_offlineSalesA' })]), now: () => now });
    now += 1000;
    const actor = cause === 'other_actor' ? 'ou_offlineSalesB' : cause === 'unknown_owner' ? 'ou_unknownSales' : 'ou_offlineSalesA';
    if (cause === 'unknown_owner') {
      client.change(id, { owner: actor });
      const snapshot = engine.get('v2_snapshots', id); engine.put('v2_snapshots', { ...snapshot, view: { ...snapshot.view, owner: actor } });
    }
    const edit = directStatusEdit(client, id, { actor, editedAt: now });
    const raw = client.records.get(id);
    if (cause === 'source_status') client.change(id, { wxStatus: '号码错误' });
    if (cause === 'modified_actor') raw.last_modified_by = { id: 'ou_offlineSalesB' };
    if (cause === 'modified_time') raw.last_modified_time = now + 1;
    if (cause === 'no_automatic_fields') { delete raw.last_modified_by; delete raw.last_modified_time; }
    engine.acceptEvent(masterStatusEvent(engine, `untrusted-direct-${cause}`, edit));
    await engine.processPendingEvents(); await engine.scan({ apply: true });
    assert.equal(client.sent.length, 0); assert.equal(statusTasks(engine).length, 0);
  });
});

test('malformed direct status proof cannot create a status task or crash normal reconciliation', async t => {
  const variants = [
    edit => ({ ...edit, actor: '' }), edit => ({ ...edit, revision: -1 }), edit => ({ ...edit, revision: 1.5 }),
    edit => ({ ...edit, revision: '41' }), edit => ({ ...edit, editedAt: 'not-a-time' }),
    edit => ({ ...edit, from: {} }), edit => ({ ...edit, to: {} }),
    edit => ({ ...edit, recordId: 'recUnrelatedProof' }), edit => ({ ...edit, from: edit.to }),
  ];
  for (const [index, transform] of variants.entries()) await t.test(`invalid proof ${index + 1}`, async t => {
    let now = masterEditTime;
    const id = `recLeadmalformed${index}`;
    const { engine, client } = await fixture(t, { client: new Client([lead(`malformed${index}`, { owner: 'ou_offlineSalesA' })]), now: () => now });
    now += 1000;
    const edit = directStatusEdit(client, id, { editedAt: now });
    const event = masterStatusEvent(engine, `malformed-direct-${index}`, edit); event.statusEdits = [transform(edit)];
    try { engine.acceptEvent(event); } catch (error) { assert.match(error.code || '', /^[A-Z0-9_]{1,80}$/); }
    await engine.processPendingEvents(); await engine.scan({ apply: true });
    assert.equal(client.sent.length, 0); assert.equal(statusTasks(engine).length, 0);
  });
});

test('ordinary master edits without field provenance and initial negative history do not manufacture direct status notices', async t => {
  let now = masterEditTime;
  const initial = lead('initialDirectNegative', { owner: 'ou_offlineSalesA', wxStatus: '未通过' });
  initial.last_modified_by = { id: 'ou_offlineSalesA' }; initial.last_modified_time = now - 1000;
  const { engine, client } = await fixture(t, { client: new Client([initial, lead('noDirectProof', { owner: 'ou_offlineSalesA' })]), now: () => now });
  now += 1000;
  directStatusEdit(client, 'recLeadnoDirectProof', { editedAt: now });
  engine.acceptEvent(targetEvent({ appToken: engine.config.appToken, tableId: engine.config.tableIds.leads }, 'ordinary-master-edit-without-proof', 'recLeadnoDirectProof'));
  engine.acceptEvent(masterStatusEvent(engine, 'late-initial-negative-event', { recordId: initial.record_id, actor: 'ou_offlineSalesA', revision: 1, editedAt: masterEditTime - 1000, from: '待添加', to: '未通过' }));
  await engine.processPendingEvents(); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 0); assert.equal(statusTasks(engine).length, 0);
});

test('a newly received historical edit cannot use an earlier installed version’s activation date', async t => {
  let now = masterEditTime;
  const id = 'recLeadHistoricalProof';
  const { engine, client } = await fixture(t, { client: new Client([lead('HistoricalProof', { owner: 'ou_offlineSalesA' })]), now: () => now });
  engine.setMeta('master_status_edit_since', now - 60_000);
  const edit = directStatusEdit(client, id, { editedAt: now - 10_000 });
  engine.acceptEvent(masterStatusEvent(engine, 'old-proof-receipt-after-upgrade', edit));
  engine.put('v2_inbox', { id: 'old-proof-already-in-inbox', state: 'pending', recordIds: [id], statusEdits: [edit] });
  await engine.processPendingEvents();
  assert.equal(client.sent.length, 0);
  assert.equal(statusTasks(engine).length, 0);
});

for (const first of ['personal', 'master']) test(`personal writeback and direct master proof for one transition deliver once with ${first} first`, async t => {
  let now = masterEditTime;
  const id = `recLeadcrossOrigin${first}`;
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead(`crossOrigin${first}`, { owner: 'ou_offlineSalesA' })]), now: () => now });
  now += 1000;
  let edit;
  if (first === 'personal') {
    mirror.editSalesStatus(id, '未通过');
    edit = directStatusEdit(client, id, { editedAt: now });
    await engine.scan({ apply: true }); assert.equal(client.sent.length, 1);
    engine.acceptEvent(masterStatusEvent(engine, `master-echo-after-${first}`, edit)); await engine.processPendingEvents();
  } else {
    edit = directStatusEdit(client, id, { editedAt: now });
    engine.acceptEvent(masterStatusEvent(engine, `direct-before-${first}`, edit)); await engine.processPendingEvents();
    assert.equal(client.sent.length, 1);
    mirror.statusReceipts.set(id, { id: 'offline-overlapping-personal-receipt', owner: 'ou_offlineSalesA', from: '待添加', to: '未通过' });
    await engine.scan({ apply: true });
  }
  engine.acceptEvent(masterStatusEvent(engine, `new-id-same-transition-${first}`, edit));
  await engine.processPendingEvents(); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(statusTasks(engine).length, 1); assert.equal(statusTasks(engine)[0].state, 'sent');
});

test('verified master status revision remains deduplicated across SQLite restart while a new revision can notify', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-master-proof-'));
  const dbPath = path.join(directory, 'workflow.sqlite'), id = 'recLeaddurableDirect';
  let now = masterEditTime, resumed;
  const { engine, client } = await fixture(t, { dbPath, now: () => now, client: new Client([lead('durableDirect', { owner: 'ou_offlineSalesA' })]) });
  t.after(async () => {
    await resumed?.close(); await engine.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  now += 1000;
  const edit = directStatusEdit(client, id, { editedAt: now });
  engine.acceptEvent(masterStatusEvent(engine, 'first-persisted-master-proof', edit)); await engine.processPendingEvents();
  assert.equal(client.sent.length, 1);
  await engine.close();
  resumed = new WorkflowEngine({ config: configuration(), client, dbPath, now: () => now }); resumed.mirror = new Mirror(resumed);
  resumed.acceptEvent(masterStatusEvent(resumed, 'other-event-id-after-master-restart', edit));
  await resumed.processPendingEvents(); await resumed.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(statusTasks(resumed).length, 1);
  now += 1000;
  const later = directStatusEdit(client, id, { revision: 42, editedAt: now, from: '未通过', to: '号码错误' });
  resumed.acceptEvent(masterStatusEvent(resumed, 'new-revision-after-master-restart', later)); await resumed.processPendingEvents();
  assert.equal(client.sent.length, 2); assert.equal(statusTasks(resumed).length, 2);
});

test('a later genuine passed-to-failed master revision is not swallowed by an older personal failure notice', async t => {
  let now = masterEditTime;
  const id = 'recLeadnewRevisionAfterPersonal';
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('newRevisionAfterPersonal', { owner: 'ou_offlineSalesA' })]), now: () => now });
  now += 1000;
  mirror.editSalesStatus(id, '未通过'); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(engine.get('v2_snapshots', id).view.wxStatus, '未通过');
  // Both real edits occur between reads. The final view equals the old snapshot,
  // but the authenticated new field revision explicitly proves a new transition.
  now += 1000; client.change(id, { wxStatus: '通过' });
  engine.acceptEvent(targetEvent({ appToken: engine.config.appToken, tableId: engine.config.tableIds.leads }, 'passed-between-snapshots', id));
  now += 1000;
  const edit = directStatusEdit(client, id, { revision: 42, editedAt: now, from: '通过', to: '未通过' });
  engine.acceptEvent(masterStatusEvent(engine, 'real-new-failed-master-revision', edit)); await engine.processPendingEvents();
  assert.equal(client.sent.length, 2); assert.equal(statusTasks(engine).length, 2);
  engine.acceptEvent(masterStatusEvent(engine, 'duplicate-real-new-failed-master-revision', edit)); await engine.processPendingEvents();
  assert.equal(client.sent.length, 2);
});

test('sales feedback is durable, deduplicated, and notifies only after a verified current negative writeback', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'workflow-child-feedback-'));
  const dbPath = path.join(folder, 'workflow.sqlite');
  const client = new Client([lead('fastFeedback', { owner: 'ou_offlineSalesA' }), lead('negativeHistory', { owner: 'ou_offlineSalesA', wxStatus: '号码错误' })]);
  const { engine } = await fixture(t, { dbPath, client });
  let resumed;
  t.after(async () => { await resumed?.close(); await engine.close(); rmSync(folder, { recursive: true, force: true }); });
  const target = engine.config.members[0].target;
  const childId = 'recPrivateFeedback';
  const edited = targetEvent(target, 'offline-sales-edit', childId);
  const wrongTarget = targetEvent({ ...target, tableId: 'tblWrongTarget' }, 'offline-wrong-table', childId);
  engine.mirror.feedbackForRecord = async () => { throw new Error('worker must wait until after restart'); };
  assert.equal(engine.acceptEvent(wrongTarget), false);
  assert.equal(engine.acceptEvent(targetEvent(target, 'offline-created-child', childId, 'record_added')), false);
  assert.equal(engine.acceptEvent(edited), true);
  assert.equal(engine.acceptEvent(edited), false);
  assert.equal(engine.status().eventsPending, 1);
  assert.equal(engine.all('v2_inbox').length, 0);
  assert.equal(engine.all('v2_sales_inbox').length, 1);
  await engine.close();

  resumed = new WorkflowEngine({ config: configuration(), client, dbPath });
  assert.equal(resumed.status().eventsPending, 1);
  assert.equal(resumed.all('v2_inbox').length, 0);
  const mirror = resumed.mirror = new Mirror(resumed);
  let edit = '未通过', calls = 0;
  mirror.feedbackForRecord = async ({ appToken, tableId, targetRecordId }) => {
    calls++;
    assert.deepEqual([appToken, tableId, targetRecordId], [target.appToken, target.tableId, childId]);
    if (edit === 'current-unchanged') return { statusSources: [] };
    if (edit === 'stale-without-receipt') return { statusSources: [await resumed.readSource('recLeadnegativeHistory')] };
    if (edit === 'deleted') return { statusSources: [], needsReconciliation: true };
    mirror.editSalesStatus('recLeadfastFeedback', edit);
    return { statusSources: [await resumed.readSource('recLeadfastFeedback')] };
  };
  const master = { appToken: resumed.config.appToken, tableId: resumed.config.tableIds.leads };
  assert.equal(resumed.acceptEvent(targetEvent(master, 'offline-quiescent-master-event', 'recLeadnegativeHistory')), true);
  assert.equal(resumed.status().eventsPending, 2);
  const list = client.listRecords.bind(client);
  client.listRecords = async () => { throw new Error('fast feedback must precede full scans'); };
  assert.equal(resumed.acceptEvent(edited), false);
  assert.equal((await resumed.processPendingEvents()).processed, 2);
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].recipientOpenId, 'ou_offlineOperatorA');
  assert.match(client.sent[0].text, /未通过/);
  assert.equal(resumed.status().eventsPending, 0);

  for (const status of ['通过', 'current-unchanged', 'stale-without-receipt']) {
    edit = status;
    assert.equal(resumed.acceptEvent(targetEvent(target, `event-${status}`, childId)), true);
    assert.equal((await resumed.processPendingEvents()).processed, 1);
    assert.equal(client.sent.length, 1);
  }
  assert.equal(calls, 4);
  assert.equal(client.records.get('recLeadfastFeedback').fields.微信状态, '通过');

  edit = 'deleted';
  assert.equal(resumed.acceptEvent(targetEvent(target, 'offline-child-deleted', childId, 'record_deleted')), true);
  await resumed.processPendingEvents();
  assert.equal(resumed.status().eventsPending, 1);
  client.listRecords = list;
  mirror.sync = async () => ({ reviews: 1 });
  await resumed.scan({ apply: true });
  assert.equal(resumed.status().eventsPending, 1);
  mirror.sync = async () => ({ reviews: 0 });
  await resumed.scan({ apply: true });
  assert.equal(resumed.status().eventsPending, 0);
  assert.equal(client.sent.length, 1);
});

test('master event starts the operator copy without waiting for the sales copy, with contact delivered first', async t => {
  const { engine, client, mirror } = await fixture(t);
  const record = lead('parallelIntake', { addMethod: '客户主动加' });
  client.add(record);
  const gate = Promise.withResolvers();
  const operator = { openId: 'ou_offlineOperatorA' };
  engine.staff = { async refresh() { return { ok: true }; }, async verifyCandidate() { return true; }, operatorCandidates: () => [operator] };
  engine.operatorMirror = {
    async syncRecord(view, { operators }) {
      assert.deepEqual(operators, [operator]);
      assert.equal(view.id, record.record_id);
      assert.equal(view.owner, 'ou_offlineSalesA');
      client.operations.push('operator-copy-started');
      await gate.promise;
      return { synced: true };
    },
  };
  const ensure = mirror.ensure.bind(mirror);
  mirror.ensure = async view => {
    assert.ok(client.operations.includes('operator-copy-started'));
    assert.equal(client.sent[0]?.recipientOpenId, operator.openId);
    return ensure(view);
  };
  const send = client.sendNotification.bind(client);
  client.sendNotification = async input => {
    const result = await send(input);
    if (input.recipientOpenId === 'ou_offlineSalesA') gate.resolve();
    return result;
  };
  const master = { appToken: engine.config.appToken, tableId: engine.config.tableIds.leads };
  assert.equal(engine.acceptEvent(targetEvent(master, 'offline-main-intake', record.record_id, 'record_added')), true);
  const processing = engine.processPendingEvents();
  let timer;
  try {
    const result = await Promise.race([processing, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('single-record operator and sales lanes must not wait for each other')), 1000);
    })]);
    assert.equal(result.processed, 1);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(client.sent.map(item => item.recipientOpenId), [operator.openId, 'ou_offlineSalesA']);
  } finally { clearTimeout(timer); gate.resolve(); await processing; }
});

test('seven master-event records notify before any full-table or mirror scan and retain restart deduplication', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'workflow-event-notices-'));
  const dbPath = path.join(folder, 'workflow.sqlite');
  const { engine, client, mirror } = await fixture(t, { dbPath });
  let resumed;
  t.after(async () => { await resumed?.close(); await engine.close(); rmSync(folder, { recursive: true, force: true }); });
  const ids = [];
  for (let index = 0; index < 7; index++) { const record = lead(`event${index}`); ids.push(record.record_id); client.add(record); }
  const list = client.listRecords.bind(client), sync = mirror.sync.bind(mirror);
  client.listRecords = async () => { throw new Error('targeted notices must precede full-table reads'); };
  mirror.sync = async () => { throw new Error('targeted notices must precede full mirror reconciliation'); };
  const event = { id: 'event-seven-new-records', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: ids };
  assert.equal(engine.acceptEvent(event), true);
  assert.equal((await engine.processPendingEvents()).processed, 7);
  assert.equal(client.sent.length, 7);
  assert.equal(engine.get('v2_inbox', event.id).requiresReconciliation, true);
  assert.equal(engine.get('v2_inbox', event.id).state, 'pending');
  assert.equal(engine.acceptEvent(event), false);
  await engine.processPendingEvents(); assert.equal(client.sent.length, 7);
  client.listRecords = list; mirror.sync = sync;
  await engine.scan({ apply: true });
  assert.equal(engine.get('v2_inbox', event.id).state, 'done');
  await engine.close();
  resumed = new WorkflowEngine({ config: configuration(), client, dbPath }); resumed.mirror = new Mirror(resumed);
  assert.equal(resumed.acceptEvent(event), false);
  await resumed.processPendingEvents(); await resumed.scan({ apply: true });
  assert.equal(client.sent.length, 7);
});

test('one slow operator copy cannot hold the next sales notification', { timeout: 3000 }, async t => {
  let now = masterEditTime;
  const { engine, client, mirror } = await fixture(t, { now: () => now });
  const records = [lead('slowOperator'), lead('nextSale')];
  for (const record of records) client.add(record);
  const gate = Promise.withResolvers();
  const operator = { openId: 'ou_offlineOperatorA' }, copied = [];
  engine.staff = { async refresh() { return { ok: true }; }, async verifyCandidate() { return true; }, operatorCandidates: () => [operator] };
  engine.operatorMirror = {
    async syncRecord(view) {
      copied.push(view.id);
      if (copied.length === 1) await gate.promise;
      return { synced: true };
    },
  };
  const ensure = mirror.ensure.bind(mirror);
  mirror.ensure = async view => { now += 200; return ensure(view); };
  const notified = Promise.withResolvers(), send = client.sendNotification.bind(client);
  client.sendNotification = async draft => {
    const result = await send(draft);
    if (client.sent.length === 2) notified.resolve();
    return result;
  };
  engine.acceptEvent({ id: 'two-sales-one-slow-operator', appToken: engine.config.appToken,
    tableId: engine.config.tableIds.leads, recordIds: records.map(record => record.record_id) });
  const processing = engine.processPendingEvents();
  let timer;
  try {
    await Promise.race([notified.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the first operator copy blocked the next sales notification')), 1000);
    })]);
    assert.deepEqual(copied, [records[0].record_id]);
    for (const task of engine.all('v2_outbox')) {
      assert.equal(task.state, 'sent');
      assert.equal(task.mirrorConfirmedAt - task.validationStartedAt, 200);
      assert.equal(task.firstAttemptAt, task.mirrorConfirmedAt);
    }
  } finally { clearTimeout(timer); gate.resolve(); await processing; }
  assert.equal((await processing).processed, 2);
  assert.deepEqual(copied, records.map(record => record.record_id));
  await engine.processPendingEvents();
  assert.equal(client.sent.length, 2);
});

test('targeted event batches stop after ten records and continue durable progress', async t => {
  const { engine, client } = await fixture(t);
  const ids = [];
  for (let index = 0; index < 12; index++) { const record = lead(`batch${index}`); ids.push(record.record_id); client.add(record); }
  engine.acceptEvent({ id: 'event-twelve-records', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: ids });
  assert.equal((await engine.processPendingEvents()).processed, 10);
  assert.equal(client.sent.length, 10);
  assert.equal(engine.get('v2_inbox', 'event-twelve-records').processedRecordIds.length, 10);
  assert.equal((await engine.processPendingEvents()).processed, 2);
  assert.equal(client.sent.length, 12);
});

test('ten failed event records back off so a newer event can notify', async t => {
  const { engine, client } = await fixture(t);
  const blocked = [];
  for (let index = 0; index < 10; index++) { const record = lead(`blocked${index}`); client.add(record); blocked.push(record.record_id); }
  const newer = lead('afterBlocked'); client.add(newer);
  engine.acceptEvent({ id: 'event-blocked', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: blocked });
  engine.acceptEvent({ id: 'event-newer', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: [newer.record_id] });
  const read = client.readRecord.bind(client); let failures = 0;
  client.readRecord = async (table, id) => {
    if (blocked.includes(id)) { failures++; throw Object.assign(new Error('offline record timeout'), { code: 'NETWORK_OR_TIMEOUT' }); }
    return read(table, id);
  };
  assert.equal((await engine.processPendingEvents()).errors.length, 10);
  assert.equal((await engine.processPendingEvents()).processed, 1);
  assert.equal(failures, 10); assert.equal(client.sent.length, 1);
  const queued = engine.get('v2_inbox', 'event-blocked');
  assert.equal(queued.state, 'pending');
  assert(Object.values(queued.retryAtByRecord).every(at => at > Date.now()));
});

test('a fast unknown send outcome stays in review through reconciliation without replay', async t => {
  const { engine, client } = await fixture(t); const record = lead('unknownFastSend'); client.add(record);
  client.sendError = Object.assign(new Error('offline response lost'), { code: 'NETWORK_OR_TIMEOUT' });
  engine.acceptEvent({ id: 'event-unknown-send', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: [record.record_id] });
  await engine.processPendingEvents(); client.sendError = null;
  await engine.processPendingEvents(); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1);
  assert.equal(engine.all('v2_outbox').find(task => task.recordId === record.record_id).state, 'review');
});

test('confirmed mirror recovery releases only unsent first attempts before their thirty-second wait', async t => {
  let time = 1_760_000_000_000;
  const { engine, client, mirror } = await fixture(t, { now: () => time });
  const record = lead('mirrorRecovery'); client.add(record);
  mirror.error = Object.assign(new Error('offline temporary mirror error'), { code: 'MIRROR_FIXTURE_TEMPORARY' });
  engine.acceptEvent({ id: 'event-mirror-recovery', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: [record.record_id] });
  await engine.processPendingEvents();
  const held = engine.all('v2_outbox').find(task => task.kind === 'owner');
  assert.equal(held.state, 'waiting_mirror'); assert.equal(held.attempts, 0); assert.equal(held.nextAttemptAt, time + 30_000);
  const currentOwner = engine.get('v2_snapshots', record.record_id).view.owner;
  const member = engine.config.members.find(member => member.openId === currentOwner);
  mirror.latest = () => ({ state: 'active', owner: currentOwner, memberId: member.id, target: member.target, targetRecordId: 'recOfflineConfirmedMirror' });
  const sync = mirror.sync.bind(mirror);
  mirror.sync = async options => { mirror.error = null; return sync(options); };
  time += 1000;
  await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].idempotencyKey, held.id);
  assert.equal(engine.get('v2_outbox', held.id).state, 'sent');
  assert.equal(engine.get('v2_outbox', held.id).firstAttemptAt, time);
  engine.put('v2_outbox', { ...held, state: 'waiting_mirror', attempts: 1, delivery: clone(client.sent[0]) });
  await engine.releaseMirroredNotices(() => false);
  assert.equal(client.sent.length, 1);
  assert.equal(engine.get('v2_outbox', held.id).state, 'waiting_mirror');
});

test('first attempts get reserved delivery capacity while old due retries still progress', async t => {
  const { engine } = await fixture(t); const delivered = [];
  for (let index = 0; index < 50; index++) engine.put('v2_outbox', { id: `old-${index}`, state: 'waiting_mirror', attempts: 1, createdAt: '2020-01-01', nextAttemptAt: 0 });
  engine.put('v2_outbox', { id: 'new-notice', state: 'pending', attempts: 0, createdAt: '2030-01-01', nextAttemptAt: 0 });
  engine.deliver = async id => { delivered.push(id); };
  await engine.drain(() => false);
  assert.equal(delivered.length, 50); assert.equal(delivered[0], 'new-notice');
  assert.equal(delivered.filter(id => id.startsWith('old-')).length, 49);
});

test('event-linked records notify before unrelated records and an interrupted scan keeps its completed timestamp', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('older', { owner: 'ou_offlineSalesA' })]) });
  await engine.scan({ apply: true }); const prior = clone(engine.meta('last_scan'));
  const record = lead('urgent'); client.add(record);
  engine.acceptEvent({ id: 'event-urgent', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: [record.record_id] });
  const process = engine.processRecord.bind(engine); const order = [];
  engine.processRecord = async (...args) => { order.push(args[0]); if (args[0] === 'recLeadolder') assert.equal(client.sent.length, 1); return process(...args); };
  let yielded = false;
  mirror.sync = async () => { yielded = true; return { stopped: true }; };
  const result = await engine.scan({ apply: true, shouldStop: () => yielded });
  assert.equal(order[0], record.record_id); assert.equal(result.stopped, true);
  assert.deepEqual(engine.meta('last_scan'), prior);
  assert.equal(engine.get('v2_inbox', 'event-urgent').state, 'pending');
});

for (const change of ['cleared', 'deleted', 'unknown']) test(`a fast ${change} owner retains its normal reconciliation requirement`, async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('revoke', { owner: 'ou_offlineSalesA' })]) });
  if (change === 'deleted') client.records.delete('recLeadrevoke');
  else client.change('recLeadrevoke', { owner: change === 'cleared' ? '' : 'ou_offlineUnknownOwner' });
  engine.acceptEvent({ id: `event-${change}`, appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: ['recLeadrevoke'] });
  await engine.processPendingEvents();
  const receipt = engine.get('v2_inbox', `event-${change}`);
  assert.equal(receipt.state, 'pending'); assert.equal(receipt.requiresReconciliation, true);
  assert.equal(mirror.syncCalls, 0); assert(engine.nextRetryAt() <= Date.now() + 1100);
  await engine.scan({ apply: true });
  assert.equal(mirror.syncCalls, 1); assert.equal(engine.get('v2_inbox', `event-${change}`).state, 'done');
});

test('a failed mirror cleanup keeps durable event intent and retries before ordinary polling', async t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'workflow-event-reconcile-'));
  const dbPath = path.join(folder, 'workflow.sqlite');
  const { engine, client, mirror } = await fixture(t, { dbPath, client: new Client([lead('revoke', { owner: 'ou_offlineSalesA' })]) });
  let resumed;
  t.after(async () => { await resumed?.close(); await engine.close(); rmSync(folder, { recursive: true, force: true }); });
  client.change('recLeadrevoke', { owner: '' });
  engine.acceptEvent({ id: 'event-persistent-revoke', appToken: engine.config.appToken, tableId: engine.config.tableIds.leads, recordIds: ['recLeadrevoke'] });
  await engine.processPendingEvents();
  mirror.sync = async () => ({ reviews: 1 });
  await engine.scan({ apply: true });
  assert.equal(engine.get('v2_inbox', 'event-persistent-revoke').state, 'pending');
  assert(engine.nextRetryAt() <= Date.now() + 30_100);
  await engine.close();
  resumed = new WorkflowEngine({ config: configuration(), client, dbPath }); resumed.mirror = new Mirror(resumed);
  assert.equal(resumed.get('v2_inbox', 'event-persistent-revoke').requiresReconciliation, true);
  await resumed.scan({ apply: true });
  assert.equal(resumed.get('v2_inbox', 'event-persistent-revoke').state, 'done');
  assert.equal(client.sent.length, 0);
});

test('a valid sales-details snapshot survives an unrelated operator-link failure', async t => {
  const { engine, mirror } = await fixture(t, { client: new Client([lead('existing', { owner: 'ou_offlineSalesA' })]) });
  engine.staff = {
    async refresh() { return { ok: true }; }, status() { return { healthy: true }; },
    operatorCandidates() { return []; },
  };
  mirror.detailEnabled = true;
  let attempts = 0;
  mirror.syncDeferredDetails = async () => { attempts++; return { detailWrites: 1, detailPending: 0 }; };
  engine.operatorMirror = { async sync() { throw Object.assign(new Error('offline operator link'), { code: 'OPERATOR_LINK_FAILURE' }); } };
  const result = await engine.scan({ apply: true, deferSalesDetails: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'OPERATOR_LINK_FAILURE' }]);
  assert.equal(result.salesDetailsReady, true);
  assert.equal((await engine.syncDeferredSalesDetails()).detailWrites, 1);
  assert.equal(attempts, 1);
  assert.equal(engine.salesDetailsReady, false);
});

test('validated pending details and their diagnostics survive an interrupted full scan', async t => {
  const { engine, mirror } = await fixture(t);
  let healthy = true, attempts = 0;
  engine.staff = { async refresh() { return { ok: healthy }; }, status() { return { healthy }; } };
  mirror.detailEnabled = true;
  mirror.hasPendingDetails = () => true;
  mirror.detailStatus = () => ({ detailPending: 1, detailOldestPendingAt: 1_760_000_000_000, detailNextAttemptAt: 1_760_000_002_000 });
  mirror.syncDeferredDetails = async () => {
    attempts++;
    return { ...mirror.detailStatus(), detailAttempts: 1, detailReviews: 1, detailLastAttemptAt: 1_760_000_000_000,
      detailLastErrorCode: 'SALES_DETAIL_TIMEOUT', detailTimeouts: 1 };
  };
  assert.equal((await engine.scan({ apply: true, deferSalesDetails: true })).salesDetailsReady, true);
  await engine.syncDeferredSalesDetails();
  const saved = clone(engine.status().salesDetails);
  assert.equal(saved.detailAttemptsTotal, 1); assert.equal(saved.detailLastErrorCode, 'SALES_DETAIL_TIMEOUT');
  const interrupted = await engine.scan({ apply: true, deferSalesDetails: true, shouldStop: () => true });
  assert.equal(interrupted.stopped, true); assert.equal(interrupted.salesDetailsReady, true);
  assert.deepEqual(engine.status().salesDetails, saved);
  await engine.scan({ apply: true, deferSalesDetails: true });
  assert.equal(engine.status().mirror.detailAttemptsTotal, 1);
  assert.equal(engine.status().mirror.detailLastErrorCode, 'SALES_DETAIL_TIMEOUT');
  healthy = false;
  await engine.scan({ apply: true, deferSalesDetails: true });
  assert.equal(engine.status().salesDetailsReady, false);
  assert.deepEqual(await engine.syncDeferredSalesDetails(), {}); assert.equal(attempts, 1);
});

test('real engine and sales mirror fill three historical private tables including a disabled salesperson', async t => {
  const config = upgradedFixtureConfig();
  delete config.fields.leads.account;
  config.fields.leads.leadDate = { fieldId: 'fldOfflineDetailDate', types: [5] };
  config.members.push(member('C', 30)); config.members[2].enabled = false;
  const records = config.members.map((person, index) => {
    const record = lead(`details${index}`, { owner: person.openId });
    record.fields.日期 = 1_760_000_000_000 + index * 86_400_000;
    return record;
  });
  const source = new Client(records);
  source.schema.push({ field_id: 'fldOfflineDetailDate', field_name: '日期', type: 5, property: {} });
  class Child {
    constructor(person) { this.person = person; this.records = new Map(); this.metrics = { writes: 0 }; }
    async api() {
      return { items: [
        ...Object.entries(this.person.target.fields).map(([key, spec]) => ({ field_id: spec.fieldId, field_name: names[key], type: spec.types[0] })),
        { field_id: `fldDetailDate${this.person.id.replaceAll('_', '')}`, field_name: '日期', type: 5 },
        { field_id: `fldDetailOperator${this.person.id.replaceAll('_', '')}`, field_name: '运营名字', type: 1 },
      ], has_more: false };
    }
    async listRecords() { return { items: clone([...this.records.values()]), hasMore: false }; }
    async readRecord(table, id) {
      assert.equal(table, this.person.target.tableId);
      return clone(this.records.get(id));
    }
    async createRecord(table, fields) {
      assert.equal(table, this.person.target.tableId);
      const record = { record_id: `recDetails${this.person.id}`, fields: clone(fields) };
      this.records.set(record.record_id, record); return clone(record);
    }
    async updateRecord(table, id, fields) {
      assert.equal(table, this.person.target.tableId);
      assert.deepEqual(Object.keys(fields).sort(), ['日期', '运营名字'].sort());
      Object.assign(this.records.get(id).fields, clone(fields)); this.metrics.writes++;
      return clone(this.records.get(id));
    }
  }
  const children = new Map(config.members.map(person => [person.target.appToken, new Child(person)]));
  const engine = new WorkflowEngine({ config, client: source, dbPath: ':memory:' });
  t.after(() => engine.close());
  engine.mirror = new SalesMirror({ config: engine.config, db: engine.db, sourceClient: source,
    clientFactory: token => children.get(token), readSource: id => engine.readSource(id), resolveSource: () => engine.resolveSource(),
    operatorNames: () => new Map([['ou_offlineOperatorA', 'Offline operator']]),
    auditDetailsTarget: async (_member, _stopped, _deadline, { phase } = {}) => phase !== 'create' });
  await engine.initialize();
  engine.staff = { async refresh() { return { ok: true }; }, status() { return { healthy: true }; }, operatorCandidates() { return []; } };
  engine.operatorMirror = { async sync() { throw Object.assign(new Error('offline unrelated link failure'), { code: 'OPERATOR_LINK_FAILURE' }); } };
  await engine.scan({ apply: true, deferSalesDetails: true }); // Establish the quiet historical mirrors first.
  const result = await engine.scan({ apply: true, deferSalesDetails: true });
  assert.equal(result.ok, false); assert.equal(result.salesDetailsReady, true);
  for (let index = 0; index < 3; index++) {
    const detail = await engine.syncDeferredSalesDetails();
    assert.equal(detail.detailWrites, 1, JSON.stringify({ index, detail }));
  }
  for (const [index, person] of config.members.entries()) {
    const child = children.get(person.target.appToken), record = [...child.records.values()][0];
    assert.equal(child.metrics.writes, 1);
    assert.equal(record.fields.日期, records[index].fields.日期);
    assert.equal(record.fields.运营名字, 'Offline operator');
    assert.equal(source.records.get(records[index].record_id).fields.负责人[0].id, person.openId);
  }
  assert.equal(source.writes.length, 0); assert.equal(source.sent.length, 0);
});

for (const gate of ['unhealthy', 'incomplete_source', 'mirror_failed', 'details_disabled', 'mirror_stopped']) {
  test(`sales-details staging rejects ${gate} and invalidates an older staged snapshot`, async t => {
    const { engine, client, mirror } = await fixture(t, { client: new Client([lead('existing', { owner: 'ou_offlineSalesA' })]) });
    engine.staff = {
      async refresh() { return { ok: gate !== 'unhealthy' }; },
      status() { return { healthy: gate !== 'unhealthy' }; },
    };
    mirror.detailEnabled = gate !== 'details_disabled';
    const sync = mirror.sync.bind(mirror);
    mirror.sync = async options => {
      if (gate === 'mirror_failed') throw Object.assign(new Error('offline mirror failure'), { code: 'MIRROR_FIXTURE_FAILURE' });
      return { ...await sync(options), stopped: gate === 'mirror_stopped' };
    };
    let attempts = 0;
    mirror.syncDeferredDetails = async () => { attempts++; return { detailPending: 0 }; };
    engine.salesDetailsReady = true;
    if (gate === 'incomplete_source') client.records.get('recLeadexisting').fields.负责人 = [{ id: 'invalid' }];
    const result = await engine.scan({ apply: true, deferSalesDetails: true });
    assert.equal(result.salesDetailsReady, false);
    assert.deepEqual(await engine.syncDeferredSalesDetails(), {});
    assert.equal(attempts, 0);
  });
}

test('attachments stage only after a complete applied scan with a healthy roster', async t => {
  const { engine, client } = await fixture(t);
  let healthy = true;
  engine.staff = { async refresh() { return { ok: healthy }; }, status() { return { healthy }; } };
  const staged = [];
  let ticks = 0;
  engine.attachments = {
    stageCore(input) { staged.push(input); return true; },
    status() { return { nextDueAt: 0, counts: {} }; },
    async runDeferred() { ticks++; return { status: 'updated' }; },
  };
  client.add(lead('attachment'));
  await engine.scan();
  assert.equal(engine.attachmentDueAt(), null);
  assert.equal(staged.length, 0);
  await engine.scan({ apply: true });
  assert.equal(engine.attachmentDueAt(), 0);
  assert.equal(staged[0].records[0].record_id, 'recLeadattachment');
  assert.equal(ticks, 0);
  assert.equal((await engine.syncDeferredAttachments()).status, 'updated');
  engine.mirror.sync = async () => { throw Object.assign(new Error('fixture mirror failure'), { code: 'MIRROR_FIXTURE_FAILURE' }); };
  const unrelatedFailure = await engine.scan({ apply: true });
  assert.equal(unrelatedFailure.ok, false);
  assert.equal(unrelatedFailure.errors.some(error => error.code === 'MIRROR_FIXTURE_FAILURE'), true);
  assert.equal(engine.attachmentDueAt(), 0);
  assert.equal((await engine.syncDeferredAttachments()).status, 'updated');
  healthy = false;
  await engine.scan({ apply: true });
  assert.equal(staged.length, 2);
  assert.equal((await engine.syncDeferredAttachments()).status, 'skipped');
  healthy = true;
  client.records.get('recLeadattachment').fields.负责人 = [{ id: 'invalid' }];
  await engine.scan({ apply: true });
  assert.equal(staged.length, 2);
  assert.equal((await engine.syncDeferredAttachments()).status, 'skipped');
  assert.equal(ticks, 2);
});

test('initial source history is quiet, including non-passed statuses and customer-active-add', async t => {
  const { engine, client } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA', wxStatus: '未通过', addMethod: '客户主动加' })]) });
  await engine.scan({ apply: true }); assert.equal(client.writes.length, 0); assert.equal(client.sent.length, 0); assert.equal(engine.all('v2_outbox').length, 0);
});
test('new assignments use dynamic order and send only after private mirror confirmation', async t => {
  const { engine, client } = await fixture(t); client.add(lead('one')); client.add(lead('two'));
  await engine.scan({ apply: true });
  assert.deepEqual(client.sent.map(item => item.recipientOpenId).sort(), ['ou_offlineSalesA', 'ou_offlineSalesB']);
  assert.equal(client.records.get('recLeadone').fields.实际分配位, 1); assert.equal(client.records.get('recLeadtwo').fields.实际分配顺序, 20);
  assert.equal(client.writes.every(write => Object.keys(write.fields).every(key => ['负责人', '实际分配位', '实际分配顺序', '实际销售'].includes(key))), true);
  assert.equal(client.operations.indexOf('mirror:recLeadone') < client.operations.indexOf('send:ou_offlineSalesA'), true);
  assert.equal(client.sent.every(item => item.url === '' && item.text.includes('添加方式')), true);
});
test('empty details do not consume a rotation position and become assignable when complete', async t => {
  const { engine, client } = await fixture(t); client.add(lead('blank', { wx: '', needs: '' })); client.add(lead('ready'));
  await engine.scan({ apply: true }); assert.equal(engine.get('v2_snapshots', 'recLeadblank').intent, undefined); assert.equal(client.sent[0].recipientOpenId, 'ou_offlineSalesA');
  client.change('recLeadblank', { wx: 'offline_finished', needs: 'complete' }); await engine.scan({ apply: true });
  assert.equal(client.records.get('recLeadblank').fields.负责人[0].id, 'ou_offlineSalesB');
});
test('a new third salesperson participates without changing existing owners; disabled cursor anchors remain deterministic', async t => {
  let current = configuration(); const { engine, client } = await fixture(t, { config: current, memberProvider: () => clone(current) });
  client.add(lead('one')); client.add(lead('two')); await engine.scan({ apply: true });
  current.members.push(member('C', 30)); client.add(lead('three')); await engine.scan({ apply: true }); assert.equal(client.records.get('recLeadthree').fields.负责人[0].id, 'ou_offlineSalesC');
  current.members[2].enabled = false; client.add(lead('four')); await engine.scan({ apply: true });
  assert.equal(client.records.get('recLeadfour').fields.负责人[0].id, 'ou_offlineSalesA'); assert.equal(client.records.get('recLeadthree').fields.负责人[0].id, 'ou_offlineSalesC');
});
test('manual A-to-B-to-A changes notify each effective owner without writing the owner field', async t => {
  const { engine, client } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.change('recLeadold', { owner: 'ou_offlineSalesB' }); await engine.scan({ apply: true });
  client.change('recLeadold', { owner: 'ou_offlineSalesA' }); await engine.scan({ apply: true }); await engine.scan({ apply: true });
  assert.deepEqual(client.sent.map(item => item.recipientOpenId), ['ou_offlineSalesB', 'ou_offlineSalesA']);
  assert.equal(client.writes.every(write => !Object.hasOwn(write.fields, '负责人')), true); assert.equal(engine.get('v2_snapshots', 'recLeadold').ownerVersion, 3);
});
test('manual results use the last read and never rewrite the owner', async t => {
  const { engine, client } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.change('recLeadold', { owner: 'ou_offlineSalesB', actualSlot: 2, actualSort: 20, salesName: '模拟销售B' });
  const read = client.readRecord.bind(client);
  let reads = 0;
  client.readRecord = async (table, id) => {
    if (++reads === 2) client.change(id, { actualSlot: null, actualSort: null, salesName: '' });
    return read(table, id);
  };
  assert.equal((await engine.scan({ apply: true })).ok, true);
  assert.deepEqual(client.writes, [{ id: 'recLeadold', fields: { 实际分配位: 2, 实际分配顺序: 20, 实际销售: '模拟销售B' } }]);
  assert.equal(engine.get('v2_snapshots', 'recLeadold').displayPending, false);
  assert.equal(client.sent.length, 1);
});
test('an unconfirmed manual result is retried without rewriting the owner or duplicating the message', async t => {
  let time = Date.UTC(2026, 10, 24);
  const { engine, client } = await fixture(t, { now: () => time, client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.change('recLeadold', { owner: 'ou_offlineSalesB' });
  const update = client.updateRecord.bind(client);
  let attempts = 0;
  client.updateRecord = async (table, id, fields) => {
    if (++attempts === 1) return clone(client.records.get(id));
    return update(table, id, fields);
  };
  assert.deepEqual((await engine.scan({ apply: true })).errors, [{ code: 'ASSIGNMENT_DISPLAY_UNCONFIRMED' }]);
  assert.equal(engine.get('v2_snapshots', 'recLeadold').displayNextAttemptAt, time + 60_000);
  assert.equal(engine.all('v2_outbox')[0].nextAttemptAt, time + 60_000);
  assert.equal(client.sent.length, 0);
  await engine.scan({ apply: true });
  assert.equal(attempts, 1);
  time += 60_000;
  await engine.scan({ apply: true });
  await engine.scan({ apply: true });
  assert.equal(attempts, 2);
  assert.equal(client.sent.length, 1);
  assert.equal(client.records.get('recLeadold').fields.负责人[0].id, 'ou_offlineSalesB');
  assert.equal(engine.get('v2_snapshots', 'recLeadold').displayNextAttemptAt, undefined);
});
test('a retained pending owner task is released immediately when its manual results are already confirmed after restart', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-v2-pending-display-'));
  const dbPath = path.join(directory, 'workflow.sqlite'), client = new Client(), now = () => Date.UTC(2026, 10, 24);
  const config = configuration();
  let engine = new WorkflowEngine({ config, client, dbPath, now });
  t.after(async () => {
    await engine.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmdirSync(directory);
  });
  engine.mirror = new Mirror(engine);
  await engine.initialize();
  client.add(lead('manual', { owner: 'ou_offlineSalesB' }));
  const update = client.updateRecord.bind(client);
  client.updateRecord = async (...args) => {
    await update(...args);
    throw Object.assign(new Error('response lost after server write'), { code: 'NETWORK_OR_TIMEOUT' });
  };
  await engine.scan({ apply: true });
  const task = engine.all('v2_outbox')[0];
  assert.equal(task.errorCode, 'OWNER_RESULTS_PENDING');
  assert.equal(task.attempts, 0);
  // 2.2.2 persisted the pending marker without any per-record display retry time.
  const stored = engine.get('v2_snapshots', 'recLeadmanual');
  delete stored.displayNextAttemptAt;
  engine.put('v2_snapshots', stored);
  await engine.close();
  engine = new WorkflowEngine({ config, client, dbPath, now });
  engine.mirror = new Mirror(engine);
  await engine.scan({ apply: true });
  await engine.scan({ apply: true });
  assert.equal(client.writes.length, 1);
  assert.equal(client.sent.length, 1);
  assert.equal(engine.all('v2_outbox').length, 1);
  assert.equal(engine.get('v2_outbox', task.id).state, 'sent');
});
test('an explicitly assigned disabled member with a valid target can still receive the manual transfer', async t => {
  const config = configuration(); config.members[1].enabled = false;
  const { engine, client } = await fixture(t, { config, client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.change('recLeadold', { owner: 'ou_offlineSalesB' }); await engine.scan({ apply: true });
  assert.equal(client.sent[0].recipientOpenId, 'ou_offlineSalesB'); assert.equal(client.records.get('recLeadold').fields.负责人[0].id, 'ou_offlineSalesB');
});
test('unknown manual owners are held until a verified member and target are configured', async t => {
  let current = configuration(); const { engine, client } = await fixture(t, { config: current, memberProvider: () => clone(current), client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.change('recLeadold', { owner: 'ou_offlineSalesC' }); await engine.scan({ apply: true }); assert.equal(client.sent.length, 0);
  current.members.push(member('C', 30)); await engine.scan({ apply: true });
  assert.equal(client.sent[0].recipientOpenId, 'ou_offlineSalesC'); assert.equal(client.writes.every(write => !Object.hasOwn(write.fields, '负责人')), true);
});
test('clearing a current owner cancels an old undelivered notice and does not automatically refill it', async t => {
  const { engine, client, mirror } = await fixture(t); mirror.error = Object.assign(new Error('offline mirror read'), { code: 'MIRROR_TEMPORARY' });
  client.add(lead('one')); await engine.scan({ apply: true }); assert.equal(client.sent.length, 0);
  client.change('recLeadone', { owner: '' }); mirror.error = null; await engine.scan({ apply: true });
  assert.equal(client.records.get('recLeadone').fields.负责人.length, 0); assert.equal(client.writes.length, 1); assert.equal(client.sent.length, 0);
  assert.equal(engine.status().notifications.cancelled, 1);
});
test('source deletion cancels pending notices and removes the source from mirror snapshots', async t => {
  const { engine, client, mirror } = await fixture(t); mirror.error = Object.assign(new Error('offline mirror read'), { code: 'MIRROR_TEMPORARY' });
  client.add(lead('one')); await engine.scan({ apply: true }); client.records.delete('recLeadone'); mirror.error = null; await engine.scan({ apply: true });
  assert.equal(client.sent.length, 0); assert.equal(engine.get('v2_snapshots', 'recLeadone').deleted, true); assert.equal(engine.status().notifications.cancelled, 1);
});
test('status failures notify the current registered operator even without customer WeChat', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.change('recLeadold', { wx: '' }); mirror.editSalesStatus('recLeadold', '未通过'); await engine.scan({ apply: true }); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(client.sent[0].recipientOpenId, 'ou_offlineOperatorA'); assert.ok(client.sent[0].text.includes('未填写')); assert.equal(client.sent[0].url, '');
});
test('a status written back during sales synchronization notifies the operator in the same scan', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  engine.staff = { async refresh() { return { ok: true }; }, status() { return { healthy: true }; }, operatorCandidates() { return []; }, async recordOperatorViewUrls() { return {}; } };
  engine.operatorMirror = { async sync(views) {
    assert.equal(views.find(view => view.id === 'recLeadold').wxStatus, '未通过');
    assert.equal(client.sent.length, 1);
    return { updated: 1 };
  } };
  mirror.sync = async () => {
    mirror.sync = Mirror.prototype.sync.bind(mirror);
    mirror.editSalesStatus('recLeadold', '未通过');
    return { sourceWrites: 1, statusSources: [await engine.readSource('recLeadold')] };
  };

  await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].recipientOpenId, 'ou_offlineOperatorA');
  assert.equal(client.sent[0].text.split('\n').at(-1), '微信状态：未通过');
  assert.equal(engine.status().operatorMirror.updated, 1);
  await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1);
});
test('a superseded or unacknowledged writeback does not send a status reminder', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('one', { owner: 'ou_offlineSalesA' }), lead('two', { owner: 'ou_offlineSalesA' })]) });
  mirror.sync = async () => {
    mirror.editSalesStatus('recLeadone', '未通过');
    client.change('recLeadone', { wxStatus: '通过' });
    client.change('recLeadtwo', { wxStatus: '号码错误' });
    return { sourceWrites: 2, statusSources: await Promise.all(['recLeadone', 'recLeadtwo'].map(id => engine.readSource(id))) };
  };
  assert.equal((await engine.scan({ apply: true })).ok, true);
  assert.equal(client.sent.length, 0);
});
test('passed status suppresses a notification and cancels obsolete failure reminders', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.sendError = numericRejection(); mirror.editSalesStatus('recLeadold', '未通过'); await engine.scan({ apply: true });
  client.change('recLeadold', { wxStatus: '通过' }); client.sendError = null; await engine.scan({ apply: true }); assert.equal(client.sent.length, 1);
  mirror.editSalesStatus('recLeadold', '未通过'); await engine.scan({ apply: true }); assert.equal(client.sent.length, 2); assert.notEqual(client.sent[0].idempotencyKey, client.sent[1].idempotencyKey);
});
test('status reminders are limited to the three configured operator follow-up statuses', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('existing', { owner: 'ou_offlineSalesA' })]) });
  for (const wxStatus of ['未通过', '通过', '号码错误', '广告/无效', '待添加', '主动加未添加', '']) {
    mirror.editSalesStatus('recLeadexisting', wxStatus);
    await engine.scan({ apply: true });
    await engine.scan({ apply: true });
  }
  assert.deepEqual(client.sent.map(item => item.text.split('\n').at(-1)), ['微信状态：未通过', '微信状态：号码错误', '微信状态：主动加未添加']);
  assert.equal(client.sent.every(item => item.recipientOpenId === 'ou_offlineOperatorA'), true);
});
test('customer-active-add before assignment emits the final sales name and customer WeChat once', async t => {
  const { engine, client } = await fixture(t); client.add(lead('one', { addMethod: '客户主动加' })); await engine.scan({ apply: true }); await engine.scan({ apply: true });
  const notices = client.sent.filter(item => item.title === '客户主动添加销售'); assert.equal(notices.length, 1); assert.equal(notices[0].recipientOpenId, 'ou_offlineOperatorA');
  assert.ok(notices[0].text.includes('模拟销售A')); assert.ok(notices[0].text.includes('offline_customer_one')); assert.equal(notices[0].url, '');
});
test('assignment then active-add, followed by transfer, uses the final owner and cancels older contact tasks', async t => {
  const { engine, client } = await fixture(t); client.add(lead('one')); await engine.scan({ apply: true });
  client.change('recLeadone', { addMethod: '客户主动加' }); await engine.scan({ apply: true });
  client.change('recLeadone', { owner: 'ou_offlineSalesB' }); await engine.scan({ apply: true });
  const notices = client.sent.filter(item => item.title === '客户主动添加销售'); assert.equal(notices.length, 2); assert.ok(notices[1].text.includes('模拟销售B'));
  assert.equal(client.sent.filter(item => item.recipientOpenId === 'ou_offlineSalesB').length, 1);
});
test('turning active-add off cancels its pending contact notice; turning it on again creates a new event', async t => {
  const { engine, client } = await fixture(t); client.sendError = input => input.title === '客户主动添加销售' ? numericRejection() : null;
  client.add(lead('one', { addMethod: '客户主动加' })); await engine.scan({ apply: true });
  client.change('recLeadone', { addMethod: '销售主动加' }); client.sendError = null; await engine.scan({ apply: true });
  client.change('recLeadone', { addMethod: '客户主动加' }); await engine.scan({ apply: true });
  const notices = client.sent.filter(item => item.title === '客户主动添加销售'); assert.equal(notices.length, 2); assert.notEqual(notices[0].idempotencyKey, notices[1].idempotencyKey);
});
test('operator changes reroute a still-current pending status event without sending to the former operator again', async t => {
  const { engine, client, mirror } = await fixture(t, { client: new Client([lead('old', { owner: 'ou_offlineSalesA' })]) });
  client.sendError = numericRejection(); mirror.editSalesStatus('recLeadold', '未通过'); await engine.scan({ apply: true });
  client.sendError = null; client.change('recLeadold', { operator: 'ou_offlineOperatorB' }); await engine.scan({ apply: true });
  client.change('recLeadold', { operator: 'ou_offlineOperatorC' }); await engine.scan({ apply: true });
  assert.deepEqual(client.sent.map(item => item.recipientOpenId), ['ou_offlineOperatorA', 'ou_offlineOperatorB']);
});
test('independent operator notices are not blocked by a pending sales mirror', async t => {
  const { engine, client, mirror } = await fixture(t); mirror.error = Object.assign(new Error('offline mirror'), { code: 'MIRROR_TEMPORARY' });
  client.add(lead('one')); await engine.scan({ apply: true }); mirror.editSalesStatus('recLeadone', '未通过'); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(client.sent[0].recipientOpenId, 'ou_offlineOperatorA');
});
test('event IDs are persisted and deduplicated; non-source events do not enter the workflow', async t => {
  const { engine } = await fixture(t), event = { id: 'offline_event_1', appToken: 'SourceBaseToken12345', tableId: 'tblSourceLeads123', recordIds: ['recLeadevent'] };
  assert.equal(engine.acceptEvent(event), true); assert.equal(engine.acceptEvent(event), false); assert.equal(engine.acceptEvent({ ...event, id: 'other', tableId: 'tblFinance12345' }), false);
  assert.equal(engine.status().eventsPending, 1); await engine.scan({ apply: true }); assert.equal(engine.status().eventsPending, 0);
});
test('read-only preview neither writes remote data nor creates semantic events or mirror tasks', async t => {
  const { engine, client, mirror } = await fixture(t); client.add(lead('one', { addMethod: '客户主动加' }));
  const before = JSON.stringify(engine.all('v2_snapshots')); const result = await engine.scan();
  assert.equal(result.counts.assign, 1); assert.equal(JSON.stringify(engine.all('v2_snapshots')), before); assert.equal(engine.all('v2_outbox').length, 0);
  assert.equal(client.writes.length, 0); assert.equal(client.sent.length, 0); assert.equal(mirror.syncCalls, 0);
});
test('field renames follow IDs, while deleted/replaced IDs or incompatible result formulas block writes', async t => {
  const { engine, client } = await fixture(t); client.rename('owner', '改名后的负责人'); client.add(lead('one')); // Add uses the old field name but its owner is blank.
  await engine.scan({ apply: true }); assert.equal(client.records.get('recLeadone').fields.改名后的负责人[0].id, 'ou_offlineSalesA');
  const writes = client.writes.length; client.schema.find(field => field.field_id === sourceFields().actualSlot.fieldId).type = 20; client.add(lead('two'));
  await assert.rejects(engine.scan({ apply: true }), { code: 'FIELD_TYPE_CHANGED' }); assert.equal(client.writes.length, writes);
  client.schema.find(field => field.field_id === sourceFields().actualSlot.fieldId).type = 2; client.schema.find(field => field.field_id === sourceFields().owner.fieldId).field_id = 'fldDifferentOwner001';
  await assert.rejects(engine.scan({ apply: true }), { code: 'FIELD_ID_NOT_FOUND' }); assert.equal(client.writes.length, writes);
});
test('initialization rejects a mid-read rename and reused old name before creating a quiet baseline', async t => {
  const client = new Client([lead('history', { owner: 'ou_offlineSalesA' })]);
  const engine = new WorkflowEngine({ config: configuration(), client, dbPath: ':memory:' }); engine.mirror = new Mirror(engine); t.after(() => engine.close());
  const list = client.listRecords.bind(client); let renamed = false;
  client.listRecords = async (...args) => {
    if (!renamed) {
      renamed = true; client.rename('owner', '改名后的负责人');
      client.schema.push({ field_id: 'fldUnrelatedOwner001', field_name: names.owner, type: 11, property: { multiple: false } });
      client.records.get('recLeadhistory').fields[names.owner] = [{ id: 'ou_offlineSalesB' }];
    }
    return list(...args);
  };
  const legacy = { legacyRows: [{ id: 'recLeadhistory', state: 'baseline_assigned' }] };
  await assert.rejects(engine.initialize(legacy), { code: 'SOURCE_SCHEMA_CHANGED_DURING_INITIALIZE' });
  assert.equal(engine.status().initialized, false); assert.equal(engine.all('v2_snapshots').length, 0); assert.equal(engine.all('v2_outbox').length, 0); assert.equal(engine.all('v2_reviews').length, 0);
  assert.equal(client.writes.length, 0); assert.equal(client.sent.length, 0);
  await engine.initialize(legacy); await engine.scan({ apply: true });
  assert.equal(engine.get('v2_snapshots', 'recLeadhistory').view.owner, 'ou_offlineSalesA');
  assert.equal(client.writes.length, 0); assert.equal(client.sent.length, 0);
});
for (const state of ['review', 'notification_sending']) test(`legacy ${state} stays quiet but later manual transfers notify the new owner and clearing never auto-refills`, async t => {
  const legacy = { id: 'recLeaduncertain', state, intendedOwner: 'ou_offlineSalesA', notificationKey: 'offline_legacy_unknown' };
  const { engine, client } = await fixture(t, { client: new Client([lead('uncertain', { owner: 'ou_offlineSalesA', wxStatus: '未通过' })]), initialize: { legacyRows: [legacy] } });
  await engine.scan({ apply: true });
  assert.equal(client.writes.length, 0); assert.equal(client.sent.length, 0); assert.equal(engine.all('v2_outbox').length, 0);
  const historical = engine.all('v2_reviews').find(review => review.code === 'LEGACY_UNRESOLVED'); assert.equal(historical.state, 'open');
  client.change('recLeaduncertain', { owner: 'ou_offlineSalesB' }); await engine.scan({ apply: true }); await engine.scan({ apply: true });
  assert.deepEqual(client.sent.map(item => item.recipientOpenId), ['ou_offlineSalesB']);
  let snapshot = engine.get('v2_snapshots', 'recLeaduncertain');
  assert.equal(snapshot.ownerVersion, 2); assert.equal(snapshot.displayPending, false); assert.equal(snapshot.blocked, true);
  assert.equal(client.records.get('recLeaduncertain').fields[names.salesName], '模拟销售B');
  assert.equal(client.writes.every(write => !Object.hasOwn(write.fields, names.owner)), true);
  assert.equal(engine.get('v2_reviews', historical.id).state, 'open');
  client.change('recLeaduncertain', { owner: '' }); const writesBeforeClear = client.writes.length;
  await engine.scan({ apply: true }); await engine.scan({ apply: true });
  snapshot = engine.get('v2_snapshots', 'recLeaduncertain');
  assert.equal(snapshot.view.owner, ''); assert.equal(snapshot.autoEligible, false); assert.equal(snapshot.intent, null);
  assert.equal(client.records.get('recLeaduncertain').fields[names.owner].length, 0); assert.equal(client.writes.length, writesBeforeClear); assert.equal(client.sent.length, 1);
  client.change('recLeaduncertain', { owner: 'ou_offlineSalesA' }); await engine.scan({ apply: true }); await engine.scan({ apply: true });
  assert.deepEqual(client.sent.map(item => item.recipientOpenId), ['ou_offlineSalesB', 'ou_offlineSalesA']);
  assert.equal(engine.get('v2_snapshots', 'recLeaduncertain').ownerVersion, 4);
  assert.equal(engine.get('v2_reviews', historical.id).state, 'open');
  assert.equal(engine.all('v2_outbox').every(task => task.kind === 'owner' && task.state === 'sent' && task.id !== legacy.notificationKey), true);
});
test('latest legacy history is quiet but records not in that backup remain new; old cursor is retained', async t => {
  const { engine, client } = await fixture(t, { client: new Client([lead('history', { owner: 'ou_offlineSalesA', wxStatus: '未通过', addMethod: '客户主动加' }), lead('new')]),
    initialize: { legacyRows: [{ id: 'recLeadhistory', state: 'baseline_assigned' }], legacyMeta: { initialized: { at: 'offline' }, lastScan: { scanned: 1 }, 'cursor:飞书派单': 'sales_B' } } });
  assert.equal(engine.get('v2_snapshots', 'recLeadnew'), null); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(client.sent[0].recipientOpenId, 'ou_offlineSalesA'); assert.deepEqual(engine.meta('legacy_metadata').lastScan, { scanned: 1 });
});
test('legacy waiting details resume, while an old unresolved send is kept in review without replay', async t => {
  const { engine, client } = await fixture(t, { client: new Client([lead('waiting', { wx: '', needs: '' }), lead('uncertain', { owner: 'ou_offlineSalesA' })]),
    initialize: { legacyRows: [{ id: 'recLeadwaiting', state: 'awaiting_details' }, { id: 'recLeaduncertain', state: 'notification_sending', intendedOwner: 'ou_offlineSalesA' }] } });
  client.change('recLeadwaiting', { wx: 'offline_ready', needs: 'ready' }); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(engine.status().reviews >= 1, true);
});
test('known numeric rejections retry with a stable UUID and frozen message inside the window', async t => {
  let clock = 100000; const { engine, client } = await fixture(t, { now: () => clock }); client.add(lead('one')); client.sendError = numericRejection();
  await engine.scan({ apply: true }); const first = clone(client.sent[0]); assert.equal(engine.status().notifications.pending, 1);
  clock = 104000; client.sendError = null; await engine.scan({ apply: true }); assert.deepEqual(client.sent[1], first);
});
test('unknown send or mirror-create outcomes enter review and are not blindly repeated', async t => {
  const { engine, client } = await fixture(t); client.add(lead('one')); client.sendError = Object.assign(new Error('private-network-detail'), { code: 'NETWORK_OR_TIMEOUT' });
  await engine.scan({ apply: true }); client.sendError = null; await engine.scan({ apply: true }); assert.equal(client.sent.length, 1); assert.equal(engine.status().notifications.review, 1);
  client.add(lead('two')); engine.mirror.error = Object.assign(new Error('offline mirror create'), { code: 'MIRROR_CREATE_REVIEW_REQUIRED' }); await engine.scan({ apply: true }); await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1); assert.equal(engine.status().notifications.review, 2); assert.equal(JSON.stringify(engine.status()).includes('private-network-detail'), false);
});
test('restarts preserve sent messages, process offline new rows, and quarantine interrupted sending markers', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-v2-engine-')), dbPath = path.join(directory, 'workflow.sqlite'), client = new Client(); let engine;
  try {
    engine = new WorkflowEngine({ config: configuration(), client, dbPath }); engine.mirror = new Mirror(engine); await engine.initialize(); client.add(lead('one')); await engine.scan({ apply: true });
    const sent = engine.all('v2_outbox')[0]; engine.put('v2_outbox', { ...sent, state: 'sending' }); await engine.close();
    client.add(lead('offline')); engine = new WorkflowEngine({ config: configuration(), client, dbPath }); engine.mirror = new Mirror(engine); await engine.scan({ apply: true });
    assert.equal(client.sent.length, 2); assert.equal(engine.status().notifications.review, 1); assert.equal(engine.get('v2_snapshots', 'recLeadoffline').view.owner, 'ou_offlineSalesB');
  } finally { await engine?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('stop before another record preserves the current confirmed owner and pending notice for resume', async t => {
  const { engine, client } = await fixture(t); client.add(lead('one')); client.add(lead('two')); let stop = false;
  const update = client.updateRecord.bind(client); client.updateRecord = async (...args) => { const result = await update(...args); stop = true; return result; };
  await engine.scan({ apply: true, shouldStop: () => stop }); assert.equal(client.writes.length, 1); assert.equal(client.sent.length, 0); assert.equal(engine.get('v2_snapshots', 'recLeadtwo'), null);
  client.updateRecord = update; stop = false; await engine.scan({ apply: true }); assert.equal(client.sent.length, 2);
});
test('real engine and real SalesMirror integrate quiet legacy copy, child feedback, ordered transfer and restart deduplication', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-v2-integration-')), dbPath = path.join(directory, 'workflow.sqlite'), config = configuration();
  const source = new Client([lead('history', { owner: 'ou_offlineSalesA' })]), operations = [];
  class ChildClient {
    constructor(member) { this.member = member; this.records = new Map(); this.created = 0; }
    async api(url) { assert.ok(url.includes(`/apps/${this.member.target.appToken}/tables/${this.member.target.tableId}/fields`)); return { items: Object.entries(this.member.target.fields).map(([key, spec]) => ({ field_id: spec.fieldId, field_name: names[key], type: spec.types[0], property: {} })), has_more: false }; }
    async listRecords(table) { assert.equal(table, this.member.target.tableId); return { items: clone([...this.records.values()]), hasMore: false }; }
    async readRecord(table, id) { assert.equal(table, this.member.target.tableId); if (!this.records.has(id)) throw Object.assign(new Error('offline child absent'), { code: '1254043' }); return clone(this.records.get(id)); }
    async createRecord(table, fields) { assert.equal(table, this.member.target.tableId); const id = `recChild${this.member.id}${++this.created}`; const record = { record_id: id, fields: clone(fields) }; this.records.set(id, record); operations.push(`create:${this.member.id}:${id}`); return clone(record); }
    async updateRecord(table, id, fields) { assert.equal(table, this.member.target.tableId); Object.assign(this.records.get(id).fields, clone(fields)); operations.push(`update:${this.member.id}:${id}`); return clone(this.records.get(id)); }
    async deleteRecord(table, id) { assert.equal(table, this.member.target.tableId); this.records.delete(id); operations.push(`delete:${this.member.id}:${id}`); }
  }
  const children = new Map(config.members.map(member => [member.target.appToken, new ChildClient(member)]));
  const attach = engine => { engine.mirror = new SalesMirror({ config: engine.config, db: engine.db, sourceClient: source, clientFactory: token => children.get(token), readSource: id => engine.readSourceView(id), resolveSource: () => engine.resolveSource() }); return engine; };
  let engine;
  try {
    engine = attach(new WorkflowEngine({ config, client: source, dbPath }));
    await engine.initialize({ legacyRows: [{ id: 'recLeadhistory', state: 'baseline_assigned' }], legacyMeta: { initialized: { at: 'offline' }, 'cursor:飞书派单': 'sales_B' } });
    await engine.scan({ apply: true }); await engine.scan({ apply: true });
    assert.equal(source.sent.length, 0); assert.equal(children.get(config.members[0].target.appToken).records.size, 1);
    source.add(lead('new')); await engine.scan({ apply: true });
    assert.equal(source.sent.length, 1); assert.equal(source.sent[0].recipientOpenId, 'ou_offlineSalesA'); assert.equal(source.sent[0].url, '');
    const beforeTransfer = engine.mirror.rows().find(row => row.sourceId === 'recLeadnew' && row.state === 'active');
    const oldChild = children.get(config.members[0].target.appToken); oldChild.records.get(beforeTransfer.targetRecordId).fields.微信状态 = '未通过';
    const event = targetEvent(config.members[0].target, 'offline-real-child-edited', beforeTransfer.targetRecordId);
    assert.equal(engine.acceptEvent(event), true);
    const feedback = await engine.processPendingEvents();
    assert.equal(feedback.processed, 1); assert.deepEqual(feedback.errors, []);
    assert.equal(source.records.get('recLeadnew').fields.微信状态, '未通过');
    assert.equal(engine.meta('mirror_rescan_needed'), true); assert.ok(engine.nextRetryAt() <= Date.now() + 1100);
    assert.equal(source.sent.length, 2); // Confirmed feedback delivers before the fallback scan starts.
    assert.equal(source.sent[1].recipientOpenId, 'ou_offlineOperatorA');
    await engine.close(); engine = attach(new WorkflowEngine({ config, client: source, dbPath }));
    assert.equal(engine.meta('mirror_rescan_needed'), true); // The fallback scan remains scheduled across restarts.
    assert.equal(engine.acceptEvent(event), false);
    await engine.scan({ apply: true }); assert.equal(source.sent.length, 2); assert.equal(source.sent[1].recipientOpenId, 'ou_offlineOperatorA'); assert.ok(source.sent[1].text.includes('未通过'));
    for (const wxStatus of ['号码错误', '待添加', '未通过']) {
      source.change('recLeadnew', { wxStatus });
      await engine.scan({ apply: true });
    }
    assert.equal(source.sent.length, 2); // Direct total-table edits, including reuse of a previous receipt, stay quiet.
    oldChild.records.get(beforeTransfer.targetRecordId).fields.微信状态 = '号码错误';
    const update = source.updateRecord.bind(source);
    source.updateRecord = async (...args) => {
      await update(...args);
      throw Object.assign(new Error('offline acknowledgement lost'), { code: 'NETWORK_OR_TIMEOUT' });
    };
    await engine.scan({ apply: true });
    assert.equal(source.records.get('recLeadnew').fields.微信状态, '号码错误');
    source.updateRecord = update;
    await engine.close(); engine = attach(new WorkflowEngine({ config, client: source, dbPath }));
    await engine.scan({ apply: true });
    assert.equal(source.sent.length, 2);
    assert.equal(engine.mirror.status().reviewsOpen, 1);
    source.change('recLeadnew', { owner: 'ou_offlineSalesB' }); await engine.scan({ apply: true });
    const afterTransfer = engine.mirror.rows().find(row => row.sourceId === 'recLeadnew' && row.state === 'active');
    assert.equal(oldChild.records.has(beforeTransfer.targetRecordId), false); assert.equal(afterTransfer.owner, 'ou_offlineSalesB');
    const removedAt = operations.indexOf(`delete:sales_A:${beforeTransfer.targetRecordId}`), createdAt = operations.indexOf(`create:sales_B:${afterTransfer.targetRecordId}`);
    assert.ok(removedAt >= 0 && createdAt > removedAt); assert.equal(source.sent.length, 3); assert.equal(source.sent[2].recipientOpenId, 'ou_offlineSalesB'); assert.equal(source.sent[2].url, '');
    const createdCounts = [...children.values()].map(client => client.created); await engine.close();
    engine = attach(new WorkflowEngine({ config, client: source, dbPath })); await engine.scan({ apply: true });
    assert.equal(source.sent.length, 3); assert.deepEqual([...children.values()].map(client => client.created), createdCounts);
  } finally { await engine?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('events received during mirror synchronization stay pending for the next scan', async t => {
  const { engine, mirror } = await fixture(t), sync = mirror.sync.bind(mirror);
  mirror.sync = async options => { engine.acceptEvent({ id: 'late_during_sync', appToken: 'SourceBaseToken12345', tableId: 'tblSourceLeads123', recordIds: ['recLeadlate'] }); return sync(options); };
  const result = await engine.scan({ apply: true }); assert.equal(engine.status().eventsPending, 1); assert.ok(result.nextRetryAt <= Date.now() + 1100);
  mirror.sync = sync; await engine.scan({ apply: true }); assert.equal(engine.status().eventsPending, 0);
});

function upgradedFixtureConfig(old = configuration()) {
  const fieldTypes = { employee: 11, role: 3, enabled: 7, order: 2, status: 1, personalUrl: 1, updatedAt: 1, error: 1,
    salesWechat: 1, leaveStart: 5, leaveEnd: 5, operatorViewUrl: 1 };
  return { ...clone(old),
    fields: { leads: { ...old.fields.leads, account: { fieldId: 'fldFixtureAccount', types: [3] } } },
    staffManagement: { enabled: true, appToken: 'FixtureEmployeeBase123', tableId: 'tblFixtureEmployee',
      fields: Object.fromEntries(Object.entries(fieldTypes).map(([key, type]) => [key, { fieldId: `fldFixture${key}`, types: [type] }])),
      operatorViews: { enabled: true },
      operatorFormUrl: 'https://example.feishu.cn/share/base/form/shrFixtureOnly',
      fixedReaders: ['示例管理员甲', '示例销售乙', '示例销售甲', '示例管理员乙'].map((displayName, i) => ({ displayName, openId: `ou_fixtureReader${i}` })),
    },
  };
}

test('upgrading the same database keeps prior binding, receipt, cursor and quiet history', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-v22-state-'));
  const dbPath = path.join(directory, 'workflow.sqlite');
  const previous = configuration();
  const client = new Client([lead('quiet', { owner: 'ou_offlineSalesA' })]);
  let engine;
  try {
    engine = new WorkflowEngine({ config: previous, client, dbPath });
    engine.mirror = new Mirror(engine);
    await engine.initialize();
    client.add(lead('alreadySent', { addMethod: '客户主动加' }));
    await engine.scan({ apply: true });
    const oldOutbox = engine.all('v2_outbox');
    assert.equal(oldOutbox.length, 2);
    assert.ok(oldOutbox.every(row => row.state === 'sent' && row.messageId));
    const oldCursor = engine.meta('last_member_id'), oldBinding = engine.meta('binding');
    await engine.close();

    const upgraded = upgradedFixtureConfig(previous);
    upgraded.members[1].salesWechat = 'fixture_sales_public';
    client.schema.push({ field_id: 'fldFixtureAccount', field_name: '平台账号名称', type: 3, property: {} });
    engine = new WorkflowEngine({ config: upgraded, client, dbPath });
    engine.mirror = new Mirror(engine);
    await engine.scan({ apply: true });
    assert.equal(engine.meta('binding'), oldBinding);
    assert.equal(engine.meta('last_member_id'), oldCursor);
    assert.deepEqual(engine.all('v2_outbox'), oldOutbox);
    assert.equal(client.sent.length, 2);

    const assigned = lead('afterUpgrade');
    assigned.fields.平台账号名称 = '测试平台账号';
    client.add(assigned);
    await engine.scan({ apply: true });
    const owner = client.sent.find((item, index) => index >= 2 && item.recipientOpenId === 'ou_offlineSalesB');
    assert.equal(owner.url, '');
    assert.match(owner.text, /添加方式：销售主动加/);
    assert.match(owner.text, /所属账号：测试平台账号/);
    assert.equal(client.sent.length, 3);

    client.change('recLeadafterUpgrade', { wx: 'offline_corrected', addMethod: '客户主动加' });
    await engine.scan({ apply: true });
    const contact = client.sent.find((item, index) => index >= 2 && item.recipientOpenId === 'ou_offlineOperatorA');
    assert.equal(contact.url, '');
    assert.match(contact.text, /fixture_sales_public/);
    assert.doesNotMatch(contact.text, /offline_customer_/);
    client.change('recLeadafterUpgrade', { wx: 'offline_corrected_again' });
    await engine.scan({ apply: true });
    assert.equal(client.sent.length, 4);
    client.change('recLeadquiet', { operator: 'ou_offlineOperatorB' });
    client.change('recLeadafterUpgrade', { operator: 'ou_offlineOperatorB' });
    await engine.scan({ apply: true });
    assert.equal(client.sent.length, 4);
  } finally { await engine?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing sales contact information holds a notice and resuming sends it once', async t => {
  let config = upgradedFixtureConfig();
  const client = new Client();
  client.schema.push({ field_id: 'fldFixtureAccount', field_name: '平台账号名称', type: 3, property: {} });
  const { engine } = await fixture(t, { config, client, memberProvider: () => clone(config) });
  client.add(lead('contactWait', { addMethod: '客户主动加' }));
  await engine.scan({ apply: true });
  assert.equal(client.sent.length, 1);
  const held = engine.all('v2_outbox').find(row => row.kind === 'contact');
  assert.equal(held.errorCode, 'SALES_WECHAT_REQUIRED');
  config.members[0].salesWechat = 'fixture_contact_filled';
  await engine.scan({ apply: true });
  await engine.scan({ apply: true });
  assert.equal(client.sent.length, 2);
  assert.equal(engine.get('v2_outbox', held.id).state, 'sent');
  assert.match(client.sent[1].text, /fixture_contact_filled/);
});

test('ineligible old pending reminders and unverified status origins stay silent while an eligible contact notice still delivers', async t => {
  const config = upgradedFixtureConfig();
  config.members[0].salesWechat = 'fixture_sales_public';
  const operator = 'ou_offlineOperatorA', owner = 'ou_offlineSalesA';
  const client = new Client([
    lead('ineligibleNotice', { owner, operator, wxStatus: '待添加', addMethod: '销售主动加' }),
    lead('eligibleNotice', { owner, operator, wxStatus: '未通过', addMethod: '客户主动加' }),
  ]);
  client.schema.push({ field_id: 'fldFixtureAccount', field_name: '平台账号名称', type: 3, property: {} });
  const { engine } = await fixture(t, { config, client });
  const ineligible = { ...engine.get('v2_snapshots', 'recLeadineligibleNotice'), contactSignature: 'previous-rule-contact-signature' };
  engine.put('v2_snapshots', ineligible);
  for (const record of [ineligible, engine.get('v2_snapshots', 'recLeadeligibleNotice')]) {
    engine.queue('status', record);
    engine.queue('contact', record);
  }

  await engine.scan({ apply: true });
  await engine.scan({ apply: true });
  assert.deepEqual(client.sent.map(item => item.title), ['客资已分配']);
  assert.equal(engine.status().notifications.sent, 1);
  assert.equal(engine.status().notifications.cancelled, 3);
});

test('v2.2 preparation is read-only, retains original activation and refuses an incomplete staff schema', async () => {
  const raw = upgradedFixtureConfig();
  for (const k of ['salesWechat', 'leaveStart', 'leaveEnd', 'operatorViewUrl']) delete raw.staffManagement.fields[k];
  delete raw.staffManagement.operatorViews;
  delete raw.fields.leads.account;
  const original = clone(raw);
  const source = [['平台账号名称', 3], ['渠道', 3], ['客资来源（付费/自然流）', 3], ['日期', 5]];
  const staff = [['销售对外微信号', 1], ['休假开始日期', 5], ['休假结束日期', 5], ['运营客资查看入口', 1]];
  let complete = true;
  const client = { async api(route, { method }) {
    assert.equal(method, 'GET');
    const rows = route.includes(raw.staffManagement.appToken) ? staff.slice(0, complete ? 4 : 3) : source;
    return { items: rows.map(([field_name, type], i) => ({ field_name, type, field_id: `fldSetup${rows === source ? 'Source' : 'Staff'}${i}` })) };
  }};
  const prepared = await prepareV22Config(raw, client);
  assert.deepEqual(raw, original);
  assert.deepEqual(prepared.members, original.members);
  assert.deepEqual(prepared.notification, original.notification);
  assert.equal(prepared.enabled, original.enabled);
  assert.equal(prepared.staffManagement.operatorViews.enabled, true);
  assert.deepEqual(prepared.fields.leads.leadDate.types, [5]);
  complete = false;
  await assert.rejects(prepareV22Config(raw, client), { code: 'V22_STAFF_OPERATOR_VIEW_URL_NOT_READY' });
});

test('the operator integration mirrors a complete live snapshot and publishes only registered, verified links', async t => {
  const config = upgradedFixtureConfig();
  const client = new Client([lead('staffMirror', { owner: 'ou_offlineSalesA' })]);
  client.schema.push({ field_id: 'fldFixtureAccount', field_name: '平台账号名称', type: 3, property: {} });
  const { engine } = await fixture(t, { config, client });
  const registered = { recordId: 'recFixtureOperator', openId: 'ou_offlineOperatorA' };
  const entry = 'https://example.feishu.cn/base/FixtureOperatorPrivate?table=tblFixtureOperator';
  const updates = [];
  engine.staff = {
    status: () => ({ healthy: true }),
    refresh: async () => ({ ok: true }),
    operatorCandidates: () => [registered],
    recordOperatorViewUrls: async urls => { updates.push(...urls); return { updated: urls.length }; },
  };
  engine.operatorMirror = { async sync(views, { operators }) {
    assert.deepEqual(views.map(view => [view.id, view.operator]), [['recLeadstaffMirror', registered.openId]]);
    assert.deepEqual(operators, [registered]);
    return { ready: 1, created: 1, readyUrls: [{ openId: registered.openId, url: entry }, { openId: 'ou_fixtureUnknown', url: entry }] };
  } };
  await engine.scan({ apply: false });
  assert.deepEqual(updates, []);
  await engine.scan({ apply: true });
  assert.deepEqual(updates, [{ ...registered, url: entry }]);
  assert.deepEqual(engine.status().operatorMirror, { ready: 1, created: 1 });
  assert.equal(client.sent.length, 0);
});
test('a field-not-found or a non-record HTTP 404 is not treated as deletion', async t => {
  for (const error of [Object.assign(new Error('field absent'), { code: '1254044', status: 404 }), Object.assign(new Error('table or access unknown'), { status: 404, code: 'TABLE_OR_ACCESS_UNKNOWN' })]) {
    const { engine, client, mirror } = await fixture(t, { client: new Client([lead('existing', { owner: 'ou_offlineSalesA' })]) });
    mirror.editSalesStatus('recLeadexisting', '未通过');
    client.readRecord = async () => { throw error; };
    await engine.scan({ apply: true });
    assert.equal(engine.get('v2_snapshots', 'recLeadexisting').deleted, false);
    assert.equal(engine.all('v2_outbox').some(task => task.state === 'cancelled' && task.errorCode === 'SOURCE_MISSING'), false);
    assert.equal(client.sent.length, 0);
  }
});
