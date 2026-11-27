import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEvents } from './events.mjs';
import { normalizeRecordEvent } from '../lib/feishu.mjs';
import { workflowConfig, clone } from './test-fixtures.mjs';

const EVENT = 'drive.file.bitable_record_changed_v1';
const recordId = 'recOfflineStatus123';
const actor = 'ou_offlineHumanEditor123';
function payload(config, { from = '待添加', to = '未通过', rawFrom, rawTo } = {}) {
  return { schema: '2.0', header: { event_id: 'offline-status-event', event_type: EVENT, create_time: '1795650000000' }, event: {
    file_token: config.appToken, table_id: config.tableIds.leads, revision: 42, update_time: 1795650000,
    operator_id: { open_id: actor, user_id: 'unused-user', union_id: 'unused-union' },
    action_list: [{ action: 'record_edited', record_id: recordId,
      before_value: [{ field_id: config.fields.leads.wxStatus.fieldId, field_value: rawFrom ?? JSON.stringify(from) }],
      after_value: [{ field_id: config.fields.leads.wxStatus.fieldId, field_value: rawTo ?? JSON.stringify(to) }] }],
  } };
}
async function fixture(t) {
  let config = workflowConfig(), handler, closed = 0;
  const received = [];
  class Dispatcher { register(handlers) { handler = handlers[EVENT]; return this; } }
  class WS {
    constructor(options) { this.options = options; }
    start() { this.options.onReady(); }
    close() { closed++; }
  }
  const stream = new WorkflowEvents(config, { sdkLoader: async () => ({ WSClient: WS, EventDispatcher: Dispatcher }), currentConfig: () => config });
  await stream.start(async event => received.push(clone(event)));
  t.after(() => stream.stop());
  return { get config() { return config; }, set config(value) { config = value; }, received, stream, deliver: input => handler(input), closed: () => closed };
}
const edit = (to = '未通过', from = '待添加') => ({ recordId, actor, revision: 42, editedAt: 1795650000000, from, to });

test('exact master status edits expose only the minimal proof for the three supported outcomes', async t => {
  const f = await fixture(t);
  for (const to of ['未通过', '号码错误', '主动加未添加']) {
    await f.deliver(payload(f.config, { to }));
    assert.deepEqual(f.received.at(-1).statusEdits, [edit(to)]);
    assert.deepEqual(Object.keys(f.received.at(-1).statusEdits[0]).sort(), ['recordId', 'actor', 'revision', 'editedAt', 'from', 'to'].sort());
  }
  assert.equal(f.stream.status().state, 'connected');
});

test('raw merged SDK bodies and nested event envelopes preserve identical normalized behavior', async t => {
  const f = await fixture(t), nested = payload(f.config);
  await f.deliver(nested);
  const merged = { ...nested.event, ...nested.header };
  await f.deliver(merged);
  assert.deepEqual(f.received[0].statusEdits, f.received[1].statusEdits);
  for (let index = 0; index < 2; index++) {
    const { statusEdits, ...normalized } = f.received[index];
    assert.deepEqual(normalized, normalizeRecordEvent(index ? merged : nested));
  }
  assert.equal(normalizeRecordEvent(nested).statusEdits, undefined);
});

test('serialized single text segments are supported while unknown select ID objects are ignored', async t => {
  const f = await fixture(t);
  await f.deliver(payload(f.config, { rawFrom: JSON.stringify([{ type: 'text', text: '待添加' }]), rawTo: JSON.stringify([{ type: 'text', text: '号码错误' }]) }));
  assert.deepEqual(f.received.at(-1).statusEdits, [edit('号码错误')]);
  for (const rawTo of ['未通过', '{broken', JSON.stringify({ name: '未通过' }), JSON.stringify({ id: 'optOffline123', name: '未通过' }),
    JSON.stringify(['未通过']), JSON.stringify([{ type: 'text', text: '未' }, { type: 'text', text: '通过' }]),
    JSON.stringify([{ type: 'link', text: '未通过' }]), 'null', '42', 'true']) {
    await f.deliver(payload(f.config, { rawTo }));
    assert.equal(f.received.at(-1).statusEdits, undefined);
  }
});

test('status proofs require platform editor open_id and positive safe revision and edited time', async t => {
  const f = await fixture(t);
  const changes = [
    event => { delete event.operator_id; }, event => { event.operator_id = { user_id: 'employee-number', union_id: 'union-only' }; },
    event => { event.operator_id.open_id = 'ordinary-name'; }, event => { event.operator_id.open_id = 'ou_x'; },
    ...[undefined, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1].map(value => event => { event.revision = value; }),
    ...[undefined, 0, -1, 1.5, '1795650000', Number.MAX_SAFE_INTEGER].map(value => event => { event.update_time = value; }),
  ];
  for (const change of changes) {
    const input = payload(f.config); change(input.event);
    await f.deliver(input);
    assert.equal(f.received.at(-1).statusEdits, undefined);
    assert.deepEqual(f.received.at(-1).recordIds, [recordId]);
  }
});

test('proofs are absent for sales child, employee table and a different master table', async t => {
  const f = await fixture(t);
  f.config.staffManagement = { enabled: true, appToken: 'OfflineStaffToken123', tableId: 'tblOfflineStaff123' };
  for (const target of [f.config.members[0].target, { appToken: f.config.staffManagement.appToken, tableId: f.config.staffManagement.tableId }]) {
    const input = payload(f.config); input.event.file_token = target.appToken; input.event.table_id = target.tableId;
    await f.deliver(input);
    assert.equal(f.received.at(-1).statusEdits, undefined);
    assert.equal(f.received.at(-1).appToken, target.appToken);
  }
  const count = f.received.length, input = payload(f.config); input.event.table_id = 'tblUnapprovedMaster123';
  await f.deliver(input); assert.equal(f.received.length, count);
});

test('an owner or intake-operator field in either side rejects the entire status proof for that record', async t => {
  const f = await fixture(t);
  for (const key of ['owner', 'operator']) for (const side of ['before_value', 'after_value']) {
    const input = payload(f.config);
    input.event.action_list[0][side].push({ field_id: f.config.fields.leads[key].fieldId, field_value: '[]' });
    await f.deliver(input);
    assert.equal(f.received.at(-1).statusEdits, undefined);
    assert.deepEqual(f.received.at(-1).actions, [{ action: 'record_edited', recordId }]);
  }
});

test('proofs follow configured field IDs and fail closed without all distinct identity field bindings', async t => {
  const f = await fixture(t), old = payload(f.config);
  f.config = clone(f.config); f.config.fields.leads.wxStatus.fieldId = 'fldOfflineReplacementStatus123';
  await f.deliver(old); assert.equal(f.received.at(-1).statusEdits, undefined);
  await f.deliver(payload(f.config)); assert.deepEqual(f.received.at(-1).statusEdits, [edit()]);
  for (const key of ['owner', 'operator']) {
    const previous = clone(f.config); delete f.config.fields.leads[key];
    await f.deliver(payload(f.config)); assert.equal(f.received.at(-1).statusEdits, undefined); f.config = previous;
  }
  f.config.fields.leads.owner.fieldId = f.config.fields.leads.wxStatus.fieldId;
  await f.deliver(payload(f.config)); assert.equal(f.received.at(-1).statusEdits, undefined);
});

test('adds, deletes, duplicate actions and incomplete or duplicate field diffs cannot become edit proofs', async t => {
  const f = await fixture(t);
  const changes = [
    action => { action.action = 'record_added'; }, action => { action.action = 'record_deleted'; },
    action => { delete action.before_value; }, action => { delete action.after_value; },
    action => { action.before_value = []; }, action => { action.after_value = []; },
    action => { action.before_value.push(clone(action.before_value[0])); }, action => { action.after_value.push(clone(action.after_value[0])); },
    action => { action.before_value.push(null); }, action => { action.record_id = 'invalid-record'; },
  ];
  for (const change of changes) {
    const input = payload(f.config); change(input.event.action_list[0]); await f.deliver(input);
    assert.equal(f.received.at(-1).statusEdits, undefined);
  }
  const input = payload(f.config); input.event.action_list.push(clone(input.event.action_list[0]));
  await f.deliver(input); assert.equal(f.received.at(-1).statusEdits, undefined);
});

test('unchanged states, passed states and unrelated fields do not alert, while unrelated records remain independent', async t => {
  const f = await fixture(t);
  for (const [from, to] of [['未通过', '未通过'], ['待添加', '通过'], ['通过', '待添加'], ['号码错误', '']]) {
    await f.deliver(payload(f.config, { from, to })); assert.equal(f.received.at(-1).statusEdits, undefined);
  }
  const input = payload(f.config), second = clone(input.event.action_list[0]);
  second.record_id = 'recOfflineSecond123';
  second.after_value.push({ field_id: f.config.fields.leads.owner.fieldId, field_value: '[]' });
  input.event.action_list.push(second);
  input.event.action_list[0].after_value.push({ field_id: f.config.fields.leads.wx.fieldId, field_value: JSON.stringify('PRIVATE CUSTOMER MUST NOT APPEAR') });
  await f.deliver(input);
  assert.deepEqual(f.received.at(-1).statusEdits, [edit()]);
  assert.equal(JSON.stringify(f.received.at(-1)).includes('PRIVATE CUSTOMER'), false);
  assert.equal(JSON.stringify(f.received.at(-1)).includes('unused-user'), false);
  assert.equal(JSON.stringify(f.received.at(-1)).includes('unused-union'), false);
});

test('stopping the stream drains accepted proof callbacks and admits no later events', async t => {
  const f = await fixture(t); await f.deliver(payload(f.config));
  await f.stream.stop(); await f.deliver(payload(f.config));
  assert.equal(f.received.length, 1); assert.equal(f.closed(), 1); assert.equal(f.stream.status().state, 'stopped');
});
