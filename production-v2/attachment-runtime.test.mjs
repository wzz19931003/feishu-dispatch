import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AttachmentAfterCore, attachmentAclFingerprint, createAttachmentAclVerifier, validateAttachmentSyncConfig } from './attachment-runtime.mjs';

const photo = 'boxOfflinePhoto111';
const photoTwo = 'boxOfflinePhoto222';
const name = '运营跟客户沟通截图';
const source = { appToken: 'OfflineMaster111', tableId: 'tblOfflineMaster111', fieldId: 'fldOfflinePhoto111' };
const salesRoute = { role: 'sales', personId: 'ou_sales111', appToken: 'OfflineSales111', tableId: 'tblOfflineSales111' };
const operatorRoute = { role: 'operator', personId: 'ou_operator111', appToken: 'OfflineOperator111', tableId: 'tblOfflineOperator111' };
const sales = { id: 'a'.repeat(64), sourceId: 'recOfflineOne111', owner: salesRoute.personId, target: salesRoute, state: 'active' };
const salesTwo = { ...sales, id: 'b'.repeat(64), sourceId: 'recOfflineTwo111' };
const operator = { id: 'c'.repeat(64), sourceId: sales.sourceId, operatorId: operatorRoute.personId, state: 'active' };
const hint = (lead, fileToken, modified = 0) => ({
  record_id: lead.sourceId, last_modified_time: modified, fields: { [name]: fileToken ? [{ file_token: fileToken }] : [] },
});
const scanned = records => ({ apply: true, healthy: true, complete: true, records });

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE v2_mirrors(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE v2_operator_copies(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE v2_operator_resources(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE v2_attachment_sync(destination TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)`);
  const addSales = mirror => db.prepare('INSERT OR REPLACE INTO v2_mirrors VALUES(?,?,?,?,?)').run(mirror.id, mirror.sourceId, 1,
    mirror.state, JSON.stringify(mirror));
  addSales(sales);
  addSales(salesTwo);
  db.prepare('INSERT INTO v2_operator_copies VALUES(?,?)').run(operator.id, JSON.stringify(operator));
  db.prepare('INSERT INTO v2_operator_resources VALUES(?,?)').run(operatorRoute.personId, JSON.stringify({ id: operatorRoute.personId,
    stage: 'ready', target: operatorRoute }));
  const managed = (route, mirror, step = 'idle') => db.prepare('INSERT OR REPLACE INTO v2_attachment_sync VALUES(?,0,?)')
    .run(mirror.id, JSON.stringify({ step, scope: { role: route.role, personId: route.personId, mirrorId: mirror.id, target: route } }));
  const state = { time: 1000, calls: [], apply: true, result: { status: 'updated' }, afterRun: () => {} };
  const adapter = {
    async run(role, id, options) {
      assert.equal(options.maxUploads, 1);
      assert.equal(options.shouldStop(), false);
      state.calls.push(['sync', role, id]);
      state.afterRun(options);
      return state.result;
    },
    async retire(role, id, options) {
      assert.equal(options.shouldStop(), false);
      state.calls.push(['retire', role, id]);
      managed(role === 'sales' ? salesRoute : operatorRoute, { id }, 'retired');
      return { status: 'retired' };
    },
  };
  const make = overrides => new AttachmentAfterCore({ db, adapter, source, targetPins: [salesRoute, operatorRoute],
    enabledRoles: ['sales', 'operator'], verifyLiveConfig: async () => state.apply, now: () => state.time, ...overrides });
  return { state, make, addSales, managed, next: () => { state.time += 60_000; } };
}

test('sends one operation per durable slot and alternates sales and operator work', async t => {
  const { state, make, next } = fixture(t);
  const one = make(), two = make();
  const snapshot = scanned([hint(sales, photo, 1), hint(salesTwo, photo, 2)]);
  assert.deepEqual(await one.afterCore(snapshot), { status: 'updated' });
  assert.deepEqual(await two.afterCore(snapshot), { status: 'deferred', code: 'ATTACHMENT_TICK_NOT_DUE' });
  next();
  assert.deepEqual(await two.afterCore(snapshot), { status: 'updated' });
  next();
  assert.deepEqual(await one.afterCore(snapshot), { status: 'updated' });
  next();
  assert.deepEqual(await one.afterCore(snapshot), { status: 'idle' });
  assert.deepEqual(state.calls, [['sync', 'sales', salesTwo.id], ['sync', 'operator', operator.id], ['sync', 'sales', sales.id]]);
});

test('runs a changed or cleared source again and leaves completely empty new records idle', async t => {
  const { state, make, next, managed } = fixture(t);
  const plan = make();
  assert.deepEqual(await plan.afterCore(scanned([hint(sales, null), hint(salesTwo, null)])), { status: 'idle' });
  next();
  assert.deepEqual(await plan.afterCore(scanned([hint(salesTwo, photo)])), { status: 'updated' });
  managed(salesRoute, salesTwo);
  next();
  assert.deepEqual(await plan.afterCore(scanned([hint(salesTwo, photoTwo)])), { status: 'updated' });
  next();
  assert.deepEqual(await plan.afterCore(scanned([hint(salesTwo, null)])), { status: 'updated' });
  assert.deepEqual(state.calls, Array(3).fill(['sync', 'sales', salesTwo.id]));
});

test('prioritizes confirmed core revocations without scheduling another upload for the historical owner', async t => {
  const { state, make, addSales, managed, next } = fixture(t);
  const plan = make();
  managed(salesRoute, sales);
  addSales({ ...sales, state: 'revoked' });
  const snapshot = scanned([hint(sales, photo)]);
  assert.deepEqual(await plan.afterCore(snapshot), { status: 'retired' });
  next();
  assert.deepEqual(await plan.afterCore(snapshot), { status: 'updated' });
  assert.deepEqual(state.calls, [['retire', 'sales', sales.id], ['sync', 'operator', operator.id]]);
});

test('holds work on incomplete core and uses safe persistent backoff for reviews', async t => {
  const { state, make, next } = fixture(t);
  const plan = make();
  const snapshot = scanned([hint(salesTwo, photo)]);
  for (const flags of [{ complete: false }, { apply: false }, { healthy: false }, { shouldStop: () => true }]) {
    assert.deepEqual(await plan.afterCore({ ...snapshot, ...flags }), { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' });
  }
  state.apply = false;
  assert.deepEqual(await plan.afterCore(snapshot), { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' });
  assert.deepEqual(state.calls, []);
  state.apply = true;
  state.result = { status: 'review', code: 'contains sensitive source' };
  assert.deepEqual(await plan.afterCore(snapshot), { status: 'review', code: 'ATTACHMENT_SCHEDULE_REVIEW' });
  next();
  assert.deepEqual(await make().afterCore(snapshot), { status: 'idle' });
  assert.deepEqual(state.calls, [['sync', 'sales', salesTwo.id]]);
});

test('shortens attachment work cooperatively when the budget expires', async t => {
  const { state, make } = fixture(t);
  const plan = make({ maxTickMs: 30_000 });
  state.afterRun = ({ shouldStop }) => {
    state.time += 31_000;
    assert.equal(shouldStop(), true);
    throw Object.assign(new Error('synthetic operation budget'), { code: 'ATTACHMENT_STOP_REQUESTED' });
  };
  assert.deepEqual(await plan.afterCore(scanned([hint(salesTwo, photo)])), { status: 'pending', code: 'ATTACHMENT_STOP_REQUESTED' });
  assert.deepEqual(plan.status(), { nextDueAt: 61_000, staged: true, counts: { pending: 1 } });
});

test('staging keeps only the scan-time attachment hints and supports a preempting core event', async t => {
  const { state, make } = fixture(t);
  const plan = make(), records = [hint(salesTwo, photo)];
  assert.equal(plan.stageCore(scanned(records)), true);
  records[0].fields[name] = [];
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await plan.runDeferred({ signal: controller.signal }), { status: 'skipped', code: 'ATTACHMENT_CORE_NOT_READY' });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(await plan.runDeferred(), { status: 'updated' });
  assert.deepEqual(state.calls, [['sync', 'sales', salesTwo.id]]);
  assert.equal(plan.stageCore({ ...scanned(records), complete: false }), false);
  assert.equal(plan.status().staged, false);
});

test('private opt-in requires exact target proof and rejects ACL drift and stale attestation', () => {
  const target = { ...salesRoute, fieldId: 'fldOfflineTarget111' };
  const sharing = { externalAccessEntity: 'closed', linkShareEntity: 'closed', manageCollaboratorEntity: 'collaborator_full_access' };
  const members = [{ memberType: 'openid', openId: salesRoute.personId, perm: 'edit' },
    { memberType: 'appid', openId: 'cli_fixture_app', perm: 'full_access', isApp: true }];
  const workflow = { appToken: source.appToken, tableIds: { leads: source.tableId }, staffManagement: { enabled: true, appToken: 'OfflineStaff111' } };
  const config = { enabled: true, source, targetPins: [{ ...target, proof: { ordinaryAccountVerified: true,
    standaloneAccessVerified: true, aclFingerprint: attachmentAclFingerprint(target, sharing, members), verifiedAt: 100, expiresAt: 300 } }] };
  assert.equal(validateAttachmentSyncConfig(undefined, workflow), undefined);
  assert.deepEqual(validateAttachmentSyncConfig({ enabled: false }, workflow), { enabled: false });
  assert.throws(() => validateAttachmentSyncConfig({ ...config, source: { ...source, appToken: target.appToken } }, workflow),
    { code: 'ATTACHMENT_BINDING_NOT_READY' });
  assert.throws(() => validateAttachmentSyncConfig({ ...config, targetPins: [target] }, workflow), { code: 'ATTACHMENT_ACCESS_PROOF_REQUIRED' });
  let now = 200;
  const approved = createAttachmentAclVerifier(validateAttachmentSyncConfig(config, workflow).targetPins, () => now);
  assert.equal(approved(target, sharing, [...members].reverse()), true);
  assert.equal(approved(target, { ...sharing, linkShareEntity: 'open' }, members), false);
  assert.equal(approved(target, sharing, [...members, { memberType: 'openid', openId: 'ou_unapproved', perm: 'view' }]), false);
  assert.equal(approved({ ...target, fieldId: 'fldWrongAttachment' }, sharing, members), false);
  now = 300;
  assert.equal(approved(target, sharing, members), false);
});
