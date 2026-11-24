import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowClient } from './client.mjs';
import { StaffAdminClient } from './staff-admin-client.mjs';
import { AttachmentMirrorAdapter } from './attachment-mirror-adapter.mjs';
import { createAttachmentRuntime } from './attachment-runtime.mjs';

const label = '运营跟客户沟通截图';
const source = { appToken: 'OfflineSourceBase111', tableId: 'tblOfflineSource111',
  fieldId: 'fldOfflineSourceFile111', recordId: 'recOfflineLead111' };
const salesTarget = { appToken: 'OfflineSalesBase111', tableId: 'tblOfflineSales111',
  fieldId: 'fldOfflineSalesFile111', recordId: 'recOfflineSalesMirror111' };
const operatorTarget = { appToken: 'OfflineOperatorBase111', tableId: 'tblOfflineOperator111',
  fieldId: 'fldOfflineOperatorFile111', recordId: 'recOfflineOperatorMirror111' };
const ownerField = 'fldOfflineOwner111';
const operatorField = 'fldOfflineOperator111';
const sales = 'ou_offline_sales111';
const operator = 'ou_offline_operator111';
const viewer = 'ou_offline_admin111';
const bot = 'ou_offline_service111';
const foreign = 'ou_offline_foreign111';
const appId = 'cli_offlineattachment111';
const staffBase = 'OfflineStaffBase111';
const salesId = 'a'.repeat(64);
const operatorId = 'b'.repeat(64);
const staffRevision = 'c'.repeat(64);
const photo = 'boxOfflineSourcePhoto111';
const copiedSales = 'boxOfflineSalesCopy111';
const copiedOperator = 'boxOfflineOperatorCopy111';
const token = 't-synthetic-adapter-token';
const fakeImage = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const success = data => Response.json({ code: 0, data });

function fixture(t, overrides = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE v2_mirrors(id TEXT PRIMARY KEY,source_id TEXT NOT NULL, version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE v2_operator_copies(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE v2_operator_resources(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE v2_operator_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE v2_staff_registry(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  const mirror = { id: salesId, sourceId: source.recordId, sourceAppToken: source.appToken, sourceTableId: source.tableId,
    targetRecordId: salesTarget.recordId, target: salesTarget, memberId: 'sales_slot_1', owner: sales, state: 'active', version: 1 };
  const operatorMirror = { id: operatorId, sourceId: source.recordId, targetRecordId: operatorTarget.recordId,
    operatorId: operator, version: 1, state: 'active' };
  const resource = { id: operator, baseToken: operatorTarget.appToken, target: operatorTarget, stage: 'ready' };
  const staffEntries = [
    { id: mirror.memberId, openId: sales, role: 'sales', target: salesTarget, recordId: 'recOfflineStaffSales111' },
    { id: 'staff_operator_1', openId: operator, role: 'operator', target: null, recordId: 'recOfflineStaffOperator111' },
  ].map(value => ({ ...value, inputVersion: staffRevision, ready: true, enabled: true, state: 'ready', retired: false }));
  const insertSales = row => db.prepare('INSERT OR REPLACE INTO v2_mirrors VALUES(?,?,?,?,?)')
    .run(row.id, row.sourceId, row.version, row.state, JSON.stringify(row));
  const insertOperator = row => db.prepare('INSERT OR REPLACE INTO v2_operator_copies VALUES(?,?)').run(row.id, JSON.stringify(row));
  const insertResource = row => db.prepare('INSERT OR REPLACE INTO v2_operator_resources VALUES(?,?)').run(row.id, JSON.stringify(row));
  insertSales(mirror);
  insertOperator(operatorMirror);
  insertResource(resource);
  db.prepare('INSERT INTO v2_operator_meta VALUES(?,?)').run('binding',
    createHash('sha256').update(JSON.stringify([appId, source.appToken, source.tableId])).digest('hex'));
  for (const entry of staffEntries) db.prepare('INSERT INTO v2_staff_registry VALUES(?,?)').run(entry.id, JSON.stringify(entry));
  const config = {
    appId, appSecret: 'synthetic-nonproduction-secret', enabled: true, notification: { enabled: true },
    appToken: source.appToken, tableIds: { leads: source.tableId },
    fields: { leads: { owner: { fieldId: ownerField }, operator: { fieldId: operatorField } } },
    staffManagement: { enabled: true, appToken: staffBase, fixedReaders: [{ openId: viewer }] },
  };
  const state = { effectiveAcl: true, enabledStaff: true, owner: sales, operator, sourceFiles: [photo],
    calls: [], delay: async () => {}, writeStatus: 200, targetFields: new Map(), unknownMember: false, hasMore: false,
    malformedPeople: false, targetSchemaName: label, missing: new Set() };
  const side = new Map([[source.appToken, source], [salesTarget.appToken, salesTarget], [operatorTarget.appToken, operatorTarget]]);
  const client = new WorkflowClient(config, { fetchImpl: async (url, request) => {
    if (url.origin === 'https://accounts.feishu.cn') return Response.json({ code: 0, access_token: token, expires_in: 3600 });
    assert.equal(url.origin, 'https://open.feishu.cn');
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    const path = url.pathname;
    state.calls.push([request.method, path, request.body ? JSON.parse(request.body) : null]);
    if (path === '/open-apis/bot/v3/info') return success({ bot: { open_id: bot } });
    const sharing = /^\/open-apis\/drive\/v2\/permissions\/([A-Za-z0-9]+)\/public$/.exec(path);
    if (sharing) return success({ permission_public: { external_access_entity: 'closed', link_share_entity: 'closed',
      manage_collaborator_entity: 'collaborator_full_access' } });
    const membership = /^\/open-apis\/drive\/v1\/permissions\/([A-Za-z0-9]+)\/members$/.exec(path);
    if (membership) {
      const isSales = membership[1] === salesTarget.appToken;
      return success({ items: [
        { member_type: 'openid', member_id: bot, perm: 'full_access' },
        { member_type: 'openid', member_id: isSales ? sales : operator, perm: isSales ? 'edit' : 'view' },
        ...(isSales ? [{ member_type: 'openid', member_id: viewer, perm: 'view' }] : []),
        ...(state.unknownMember ? [{ member_type: 'chatid', member_id: 'oc_offline_extra', perm: 'view' }] : []),
      ], has_more: false });
    }
    const match = /^\/open-apis\/bitable\/v1\/apps\/([A-Za-z0-9]+)\/tables\/([A-Za-z0-9]+)\/(fields|records)(?:\/([A-Za-z0-9]+))?$/.exec(path);
    assert.ok(match, path);
    const [, base, table, kind, recordId] = match;
    const pin = side.get(base);
    assert.equal(table, pin.tableId);
    if (kind === 'fields') return success({ has_more: state.hasMore, items: [
      { field_id: pin.fieldId, type: 17, field_name: base === source.appToken ? label : state.targetSchemaName },
      ...(base === source.appToken ? [
        { field_id: ownerField, type: 11, field_name: '负责人' },
        { field_id: operatorField, type: 11, field_name: '录入运营' },
      ] : []),
    ] });
    assert.equal(recordId, pin.recordId);
    if (state.missing.has(base)) return Response.json({ code: 1254043 }, { status: 404 });
    if (request.method === 'PUT') {
      const fields = JSON.parse(request.body).fields;
      assert.notEqual(base, source.appToken);
      assert.deepEqual(Object.keys(fields), [label]);
      if (state.writeStatus !== 200) return Response.json({ code: 99991400 }, { status: state.writeStatus });
      state.targetFields.set(base, fields[label]);
      return success({ record: { record_id: recordId } });
    }
    assert.equal(url.searchParams.get('user_id_type'), 'open_id');
    const fields = base === source.appToken
      ? { [label]: state.sourceFiles.map(file_token => ({ file_token, name: 'synthetic.png' })),
        负责人: state.malformedPeople ? [{ id: sales }, { id: foreign }] : [{ id: state.owner }],
        录入运营: [{ open_id: state.operator }] }
      : { [label]: state.targetFields.get(base) ?? [] };
    return success({ record: { record_id: recordId, fields } });
  } });
  const admin = new StaffAdminClient(config, { sourceClient: client });
  const options = {
    db, client, admin, source, enabledRoles: ['sales', 'operator'],
    targetPins: [{ ...salesTarget, role: 'sales', personId: sales }, { ...operatorTarget, role: 'operator', personId: operator }],
    verifyLiveConfig: async () => true,
    readCurrentStaff: async recordId => {
      const entry = staffEntries.find(item => item.recordId === recordId);
      return { ...entry, version: entry.inputVersion, effectiveEnabled: state.enabledStaff };
    },
    verifyEffectiveAcl: async () => state.effectiveAcl,
    mediaFetch: async (url, request) => {
      assert.equal(request.headers.Authorization, `Bearer ${token}`);
      state.calls.push([request.method, url.pathname, null]);
      if (request.method === 'GET') {
        await state.delay(request.signal);
        return new Response(fakeImage);
      }
      const copy = request.body.get('parent_node') === salesTarget.appToken ? copiedSales : copiedOperator;
      return success({ file_token: copy });
    },
    ...overrides,
  };
  const adapter = new AttachmentMirrorAdapter(options);
  const recordings = () => state.calls.filter(([method, path]) => method === 'PUT' || method === 'POST' || path.startsWith('/open-apis/drive/v1/medias/'));
  return { adapter, options, state, config, db, mirror, operatorMirror, resource, insertSales, insertOperator, insertResource, recordings };
}

test('uses active sales and operator SQLite mappings and writes exactly the pinned column', async t => {
  const { adapter, state, recordings } = fixture(t);
  assert.deepEqual(await adapter.run('sales', salesId), { status: 'updated' });
  assert.deepEqual(await adapter.run('operator', operatorId), { status: 'updated' });
  assert.deepEqual(state.targetFields.get(salesTarget.appToken), [{ file_token: copiedSales }]);
  assert.deepEqual(state.targetFields.get(operatorTarget.appToken), [{ file_token: copiedOperator }]);
  assert.deepEqual(recordings().map(([method]) => method), ['GET', 'POST', 'PUT', 'GET', 'POST', 'PUT']);
  state.sourceFiles = [];
  assert.deepEqual(await adapter.run('operator', operatorId), { status: 'updated' });
  assert.deepEqual(recordings().at(-1)[2], { fields: { [label]: null } });
  assert.equal(state.targetFields.get(operatorTarget.appToken), null);
});

test('rejects bad mirror pins, ambiguous mirrors and stale resources before cloud work', async t => {
  const { adapter, mirror, resource, insertSales, insertResource, recordings, state } = fixture(t);
  insertSales({ ...mirror, target: { ...salesTarget, appToken: 'OfflineOtherBase111' } });
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_SCOPE_PIN_MISMATCH' });
  insertSales(mirror);
  insertSales({ ...mirror, id: 'd'.repeat(64), version: 2 });
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_SCOPE_PIN_MISMATCH' });
  insertResource({ ...resource, stage: 'review' });
  await assert.rejects(adapter.run('operator', operatorId), { code: 'ATTACHMENT_OPERATOR_RESOURCE_INVALID' });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(recordings(), []);
});

test('stops if effective ACL, group sharing, live staff or exact schemas cannot be proved', async t => {
  const { adapter, state, recordings } = fixture(t);
  state.effectiveAcl = false;
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_ACL_UNCONFIRMED' });
  state.effectiveAcl = true;
  state.unknownMember = true;
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_ACL_UNCONFIRMED' });
  state.unknownMember = false;
  state.enabledStaff = false;
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_BINDING_UNCONFIRMED' });
  state.enabledStaff = true;
  state.targetSchemaName = '非批准字段名称';
  await assert.rejects(adapter.run('operator', operatorId), { code: 'ATTACHMENT_TARGET_UNCONFIRMED' });
  assert.deepEqual(recordings(), []);
});

test('checks source owner again after bytes are read and refuses any destination upload when it changed', async t => {
  const { adapter, state, recordings } = fixture(t);
  state.malformedPeople = true;
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_SOURCE_CHANGED' });
  state.malformedPeople = false;
  state.delay = async () => { state.owner = foreign; };
  assert.deepEqual(await adapter.run('sales', salesId), { status: 'pending', code: 'ATTACHMENT_OWNERSHIP_UNCONFIRMED' });
  assert.deepEqual(recordings().map(([method]) => method), ['GET']);
});

test('keeps one remote PUT when rate-limited and reopens only after exact readback', async t => {
  const { adapter, state, recordings } = fixture(t);
  state.writeStatus = 429;
  const review = { status: 'review', code: 'ATTACHMENT_PATCH_OUTCOME_UNKNOWN' };
  assert.deepEqual(await adapter.run('sales', salesId), review);
  assert.deepEqual(await adapter.run('sales', salesId), review);
  state.targetFields.set(salesTarget.appToken, [{ file_token: copiedSales }]);
  assert.deepEqual(await adapter.run('sales', salesId), { status: 'unchanged' });
  assert.deepEqual(recordings().map(([method]) => method), ['GET', 'POST', 'PUT']);
});

test('keeps a revoked mapping and disabled local workbench idle', async t => {
  const { adapter, config, state, operatorMirror, insertOperator, recordings } = fixture(t);
  insertOperator({ ...operatorMirror, state: 'revoked' });
  assert.deepEqual(await adapter.run('operator', operatorId), { status: 'skipped', code: 'ATTACHMENT_MIRROR_NOT_ACTIVE' });
  config.staffManagement.fixedReaders = [];
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_BINDING_UNCONFIRMED' });
  config.staffManagement.fixedReaders = [{ openId: viewer }];
  config.enabled = false;
  await assert.rejects(adapter.run('sales', salesId), { code: 'ATTACHMENT_BINDING_UNCONFIRMED' });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(recordings(), []);
});

test('checks unchanged ownership forms and clears only managed attachments on a confirmed sales reassignment', async t => {
  const { adapter, state, mirror, insertSales, recordings } = fixture(t);
  assert.deepEqual(await adapter.run('sales', salesId), { status: 'updated' });
  insertSales({ ...mirror, state: 'revoked' });
  await assert.rejects(adapter.retire('sales', salesId), { code: 'ATTACHMENT_RETIREMENT_UNCONFIRMED' });
  state.owner = foreign;
  state.targetFields.set(salesTarget.appToken, [{ file_token: 'boxUnmanagedOffline111' }]);
  await assert.rejects(adapter.retire('sales', salesId), { code: 'ATTACHMENT_TARGET_HAS_UNMANAGED_FILES' });
  state.targetFields.set(salesTarget.appToken, [{ file_token: copiedSales }]);
  assert.deepEqual(await adapter.retire('sales', salesId), { status: 'retired' });
  assert.deepEqual(recordings().at(-1)[2], { fields: { [label]: null } });
  assert.deepEqual(recordings().map(([method]) => method), ['GET', 'POST', 'PUT', 'PUT']);
  assert.deepEqual(await adapter.retire('sales', salesId), { status: 'skipped', code: 'ATTACHMENT_NOT_MANAGED' });
});

test('recognizes core removal of the old operator row without another write', async t => {
  const { adapter, state, operatorMirror, insertOperator, recordings } = fixture(t);
  assert.deepEqual(await adapter.run('operator', operatorId), { status: 'updated' });
  insertOperator({ ...operatorMirror, state: 'revoked' });
  state.operator = foreign;
  state.missing.add(operatorTarget.appToken);
  assert.deepEqual(await adapter.retire('operator', operatorId), { status: 'retired' });
  assert.deepEqual(recordings().map(([method]) => method), ['GET', 'POST', 'PUT']);
});

test('does not replay an uncertain retirement and refuses an active reused target', async t => {
  const { adapter, state, mirror, insertSales, recordings } = fixture(t);
  assert.deepEqual(await adapter.run('sales', salesId), { status: 'updated' });
  insertSales({ ...mirror, state: 'revoked' });
  insertSales({ ...mirror, id: 'e'.repeat(64), state: 'active', version: 2, sourceId: 'recOfflineOther111' });
  state.owner = foreign;
  await assert.rejects(adapter.retire('sales', salesId), { code: 'ATTACHMENT_SCOPE_PIN_MISMATCH' });
  insertSales({ ...mirror, id: 'e'.repeat(64), state: 'revoked', version: 2, sourceId: 'recOfflineOther111' });
  state.writeStatus = 429;
  const review = { status: 'review', code: 'ATTACHMENT_RETIREMENT_OUTCOME_UNKNOWN' };
  assert.deepEqual(await adapter.retire('sales', salesId), review);
  assert.deepEqual(await adapter.retire('sales', salesId), review);
  state.targetFields.set(salesTarget.appToken, null);
  assert.deepEqual(await adapter.retire('sales', salesId), { status: 'retired' });
  assert.deepEqual(recordings().map(([method]) => method), ['GET', 'POST', 'PUT', 'PUT']);
});

test('wires the post-core hook to the real candidate adapter and leaves a core preview idle', async t => {
  const { options, state, recordings } = fixture(t);
  let now = 10_000;
  const runtime = createAttachmentRuntime({ ...options, now: () => now });
  const core = { apply: true, healthy: true, complete: true,
    records: [{ record_id: source.recordId, fields: { [label]: [{ file_token: photo }] } }] };
  assert.deepEqual(await runtime.afterCore({ ...core, apply: false }), { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' });
  assert.deepEqual(await runtime.afterCore(core), { status: 'updated' });
  now += 60_000;
  assert.deepEqual(await runtime.afterCore(core), { status: 'updated' });
  assert.deepEqual(state.targetFields.get(salesTarget.appToken), [{ file_token: copiedSales }]);
  assert.deepEqual(state.targetFields.get(operatorTarget.appToken), [{ file_token: copiedOperator }]);
  assert.deepEqual(recordings().map(([method]) => method), ['GET', 'POST', 'PUT', 'GET', 'POST', 'PUT']);
  assert.deepEqual(runtime.status(), { nextDueAt: now + 60_000, staged: true, counts: { updated: 2 } });
});

test('a foreground event aborts an in-flight download before any upload or target update', async t => {
  const { options, state, recordings } = fixture(t);
  const runtime = createAttachmentRuntime(options), controller = new AbortController();
  const core = { apply: true, healthy: true, complete: true,
    records: [{ record_id: source.recordId, fields: { [label]: [{ file_token: photo }] } }] };
  let readSignal;
  state.delay = async signal => {
    readSignal = signal;
    controller.abort();
    await delay(2000, null, { signal });
    assert.fail('The media request should be cancelled');
  };
  assert.equal(runtime.stageCore(core), true);
  const result = await runtime.runDeferred({ signal: controller.signal });
  assert.equal(result.status, 'pending');
  assert.equal(readSignal.aborted, true);
  assert.deepEqual(recordings().map(([method]) => method), ['GET']);
});
