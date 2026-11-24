import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowConfig, resolveFields, recordView, encodePatch, chooseMember } from './field-map.mjs';
import { workflowConfig, schema, clone } from './test-fixtures.mjs';

test('missing sales targets are explicitly incomplete and cannot validate for startup', () => {
  const c = workflowConfig({ targets: false });
  assert.throws(() => validateWorkflowConfig(c), { code: 'TARGETS_REQUIRED' });
  const prepared = validateWorkflowConfig(c, { requireTargets: false });
  assert.equal(prepared.enabled, false); assert.equal(prepared.notification.enabled, false); assert.equal(prepared.pendingTargets.length, 2);
});
test('targets cannot share a Base, reuse source, or accept owner as feedback', () => {
  let c = workflowConfig(); c.members[1].target = clone(c.members[0].target);
  assert.throws(() => validateWorkflowConfig(c), { code: 'TARGET_BASE_DUPLICATE' });
  c = workflowConfig(); c.members[0].target.appToken = c.appToken;
  assert.throws(() => validateWorkflowConfig(c), { code: 'TARGET_BASE_INVALID' });
  c = workflowConfig(); c.mirrors.feedbackFields = ['wxStatus', 'owner'];
  assert.throws(() => validateWorkflowConfig(c), { code: 'FEEDBACK_FIELDS_INVALID' });
});
test('legacy addMethod feedback is retired without changing its field bindings or wxStatus', () => {
  const raw = workflowConfig();
  raw.mirrors.feedbackFields = ['wxStatus', 'addMethod', 'wx'];
  const prepared = validateWorkflowConfig(raw);
  assert.deepEqual(prepared.mirrors.feedbackFields, ['wxStatus', 'wx']);
  assert.deepEqual(raw.mirrors.feedbackFields, ['wxStatus', 'addMethod', 'wx']);
  assert.deepEqual(prepared.fields.leads.addMethod, raw.fields.leads.addMethod);
  assert.deepEqual(prepared.members[0].target.fields.addMethod, raw.members[0].target.fields.addMethod);
  assert.deepEqual(validateWorkflowConfig(prepared).mirrors.feedbackFields, ['wxStatus', 'wx']);
});
test('stable field IDs follow renamed columns and encode current names', async () => {
  const c = workflowConfig(), fields = schema(c); fields.find(f => f.field_id === c.fields.leads.wx.fieldId).field_name = '重新命名的微信列';
  const resolved = await resolveFields({ api: async () => ({ items: fields }) }, { appToken: c.appToken, tableId: c.tableIds.leads, fields: c.fields.leads });
  const view = recordView({ record_id: 'recOffline', fields: { 重新命名的微信列: [{ text: '  offline_contact  ' }], 负责人: [{ id: 'ou_offlineSalesA' }], 分配位: 2 } }, resolved);
  assert.equal(view.wx, 'offline_contact'); assert.equal(view.owner, 'ou_offlineSalesA'); assert.equal(view.actualSlot, 2);
  assert.deepEqual(encodePatch({ wx: 'offline_new', owner: 'ou_offlineSalesB' }, resolved), { 重新命名的微信列: 'offline_new', 负责人: [{ id: 'ou_offlineSalesB' }] });
});
test('a same-name replacement ID and old formula result types fail closed', async () => {
  const c = workflowConfig(), fields = schema(c), request = { appToken: c.appToken, tableId: c.tableIds.leads, fields: c.fields.leads };
  fields[0].field_id = 'fldOfflineReplacement';
  await assert.rejects(resolveFields({ api: async () => ({ items: fields }) }, request), { code: 'FIELD_ID_NOT_FOUND' });
  const old = schema(c); old.find(f => f.field_id === c.fields.leads.actualSlot.fieldId).type = 20;
  await assert.rejects(resolveFields({ api: async () => ({ items: old }) }, request), { code: 'FIELD_TYPE_CHANGED' });
});
test('metadata pagination can span pages but rejects cursor loops', async () => {
  const c = workflowConfig(), fields = schema(c); let calls = 0;
  const resolved = await resolveFields({ api: async () => ++calls === 1 ? { items: fields.slice(0, 3), has_more: true, page_token: 'cursor1' } : { items: fields.slice(3) } }, { appToken: c.appToken, tableId: c.tableIds.leads, fields: c.fields.leads });
  assert.equal(Object.keys(resolved).length, 9);
  await assert.rejects(resolveFields({ api: async () => ({ items: [], has_more: true, page_token: 'same' }) }, { appToken: c.appToken, tableId: c.tableIds.leads, fields: c.fields.leads }), { code: 'FIELD_PAGINATION_INVALID' });
});
test('native people reject names and multiple identities; partial target views remain usable', () => {
  const resolved = { owner: { name: 'Owner', type: 11 }, wxStatus: { name: 'Status', type: 3 } };
  assert.throws(() => recordView({ record_id: 'recOffline', fields: { Owner: 'name-only' } }, resolved), { code: 'RECORD_PERSON_INVALID' });
  assert.throws(() => recordView({ record_id: 'recOffline', fields: { Owner: [{ id: 'ou_offlineOne' }, { id: 'ou_offlineTwo' }] } }, resolved), { code: 'RECORD_PERSON_INVALID' });
  assert.equal(recordView({ record_id: 'recOffline', fields: { Status: '通过' } }, { wxStatus: resolved.wxStatus }).wxStatus, '通过');
  assert.throws(() => encodePatch({ owner: ['ou_offlineOne'] }, resolved), { code: 'PATCH_PERSON_INVALID' });
});
test('round robin follows order and stable ID, preserves disabled anchor and has deterministic deletion fallback', () => {
  const pool = [{ id: 'C', order: 2, enabled: true }, { id: 'A', order: 1, enabled: false }, { id: 'B', order: 1, enabled: true }];
  assert.equal(chooseMember(pool, 'A').id, 'B'); assert.equal(chooseMember(pool, 'B').id, 'C'); assert.equal(chooseMember(pool, 'C').id, 'B');
  assert.equal(chooseMember(pool, 'deleted').id, 'B'); assert.equal(chooseMember(pool.map(m => ({ ...m, enabled: false })), 'A'), null);
});
