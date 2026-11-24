import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BitableAttachmentClient } from './bitable-attachment.mjs';
import { AttachmentSyncJournal, AttachmentSyncWorker } from './attachment-sync-worker.mjs';

const source = { appToken: 'BaseSource12345', tableId: 'tblSource12345', recordId: 'recSource12345', fieldId: 'fldSource12345' };
const target = { appToken: 'BaseTarget12345', tableId: 'tblTarget12345', recordId: 'recTarget12345', fieldId: 'fldTarget12345' };
const sales = 'ou_sales_fixture';
const operator = 'ou_operator_fixture';
const manager = 'ou_manager_fixture';
const appId = 'cli_fixture12345';
const original = 'boxSourceFixture12345';
const originalTwo = 'boxSourceFixture23456';
const uploaded = 'boxTargetFixture12345';
const uploadedTwo = 'boxTargetFixture23456';
const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const salesScope = { role: 'sales', personId: sales, mirrorId: 'a'.repeat(64), source, target };
const operatorScope = { ...salesScope, role: 'operator', personId: operator, mirrorId: 'b'.repeat(64) };
const updated = { status: 'updated' };
const unchanged = { status: 'unchanged' };
function apiToken(file_token) { return Response.json({ code: 0, data: { file_token } }); }

function fixture(scope = salesScope) {
  const state = {
    ownerId: sales,
    operatorId: operator,
    active: true,
    link: 'closed',
    attachments: [{ fileToken: original, name: 'offline-image.png' }],
    targetTokens: [],
    targetType: 17,
    gets: 0,
    posts: 0,
    puts: 0,
    acls: 0,
    applyPut: true,
    afterGet: () => {},
    afterPost: () => {},
    afterPut: () => {},
    members: [
      { memberType: 'appid', openId: appId, perm: 'full_access' },
      { memberType: 'openid', openId: scope.personId, perm: scope.role === 'sales' ? 'edit' : 'view' },
      ...(scope.role === 'sales' ? [{ memberType: 'openid', openId: manager, perm: 'view' }] : []),
    ],
  };
  function worker(db, changes = {}) {
    const transport = new BitableAttachmentClient({
      tenantToken: async () => 't-synthetic-app-token',
      fetchImpl: async (url, { method, body }) => {
        if (method === 'GET') {
          assert.equal(url.origin, 'https://open.feishu.cn');
          state.gets++;
          await state.afterGet();
          return new Response(image);
        }
        assert.equal(body.get('parent_node'), target.appToken);
        state.posts++;
        await state.afterPost();
        return apiToken(state.posts === 1 ? uploaded : uploadedTwo);
      },
    });
    return new AttachmentSyncWorker({
      journal: new AttachmentSyncJournal(db),
      transport,
      policy: { source, appId, enabledRoles: ['sales', 'operator'], salesFixedReaders: [manager] },
      readBinding: async () => ({ ...scope, state: state.active ? 'active' : 'revoked' }),
      readSource: async () => ({ ...source, complete: true, fieldType: 17, ownerId: state.ownerId,
        operatorId: state.operatorId, attachments: state.attachments }),
      readTarget: async () => ({ ...target, complete: true, fieldType: state.targetType, fileTokens: state.targetTokens }),
      readAcl: async () => {
        state.acls++;
        return { complete: true, appToken: target.appToken, externalAccessEntity: 'closed', linkShareEntity: state.link,
          manageCollaboratorEntity: 'collaborator_full_access', members: state.members };
      },
      writeTarget: async (pin, tokens) => {
        assert.deepEqual(pin, target);
        assert.ok(tokens.every(token => Object.keys(token).length === 1 && Object.hasOwn(token, 'file_token')));
        state.puts++;
        if (state.applyPut) state.targetTokens = tokens.map(token => token.file_token);
        await state.afterPut();
      },
      ...changes,
    });
  }
  return { state, worker };
}

function memory(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

test('writes only new destination tokens, audits each phase and reuses completed uploads', async t => {
  const db = memory(t);
  const { state, worker } = fixture();
  assert.deepEqual(await worker(db).run(salesScope), updated);
  assert.equal(state.acls, 5);
  assert.deepEqual(state.targetTokens, [uploaded]);
  assert.deepEqual(await worker(db).run(salesScope), unchanged);
  state.attachments = [];
  assert.deepEqual(await worker(db).run(salesScope), updated);
  state.attachments = [{ fileToken: original, name: 'offline-image.png' }];
  assert.deepEqual(await worker(db).run(salesScope), updated);
  assert.deepEqual([state.gets, state.posts, state.puts], [1, 1, 3]);
});

test('serializes bounded progress across runs and preserves source attachment order', async t => {
  const db = memory(t);
  const { state, worker } = fixture();
  state.attachments.push({ fileToken: originalTwo, name: 'offline-second.png' });
  assert.deepEqual(await worker(db).run(salesScope), { status: 'pending', code: 'ATTACHMENT_UPLOAD_BUDGET_REACHED' });
  assert.equal(state.puts, 0);
  assert.deepEqual(await worker(db).run(salesScope), updated);
  assert.deepEqual(state.targetTokens, [uploaded, uploadedTwo]);
  assert.deepEqual([state.gets, state.posts, state.puts], [2, 2, 1]);
});

test('operator sees only their own rows and any broadened document ACL blocks bytes', async t => {
  const db = memory(t);
  const { state, worker } = fixture(operatorScope);
  state.members.push({ memberType: 'openid', openId: manager, perm: 'view' });
  await assert.rejects(worker(db).run(operatorScope), { code: 'ATTACHMENT_ACL_UNCONFIRMED' });
  state.members.pop();
  state.operatorId = 'ou_operator_changed';
  await assert.rejects(worker(db).run(operatorScope), { code: 'ATTACHMENT_SOURCE_CHANGED' });
  state.operatorId = operator;
  state.targetType = 1;
  await assert.rejects(worker(db).run(operatorScope), { code: 'ATTACHMENT_TARGET_SCHEMA_INVALID' });
  assert.deepEqual([state.gets, state.posts, state.puts], [0, 0, 0]);
  state.targetType = 17;
  assert.deepEqual(await worker(db).run(operatorScope), updated);
});

test('blocks stale owners, stale grants, and unmanaged target files before their next side effect', async t => {
  const db = memory(t);
  const { state, worker } = fixture();
  state.targetTokens = ['boxUnmanagedFixture12345'];
  await assert.rejects(worker(db).run(salesScope), { code: 'ATTACHMENT_TARGET_HAS_UNMANAGED_FILES' });
  state.targetTokens = [];
  state.afterGet = () => { state.ownerId = 'ou_new_sales'; };
  assert.deepEqual(await worker(db).run(salesScope), { status: 'pending', code: 'ATTACHMENT_OWNERSHIP_UNCONFIRMED' });
  assert.deepEqual([state.gets, state.posts, state.puts], [1, 0, 0]);
  state.ownerId = sales;
  state.afterGet = () => {};
  state.afterPost = () => { state.link = 'tenant_readable'; };
  await assert.rejects(worker(db).run(salesScope), { code: 'ATTACHMENT_ACL_UNCONFIRMED' });
  assert.deepEqual([state.gets, state.posts, state.puts], [2, 1, 0]);
  state.link = 'closed';
  assert.deepEqual(await worker(db).run(salesScope), updated);
  assert.deepEqual([state.gets, state.posts, state.puts], [2, 1, 1]);
});

test('unknown upload stays in review after closing and reopening the SQLite file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attachment-worker-'));
  const file = join(dir, 'offline.sqlite');
  const { state, worker } = fixture();
  state.afterPost = () => { throw new Error('synthetic network uncertainty'); };
  const unknown = { status: 'review', code: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN' };
  try {
    const first = new DatabaseSync(file);
    try { assert.deepEqual(await worker(first).run(salesScope), unknown); }
    finally { first.close(); }
    const reopened = new DatabaseSync(file);
    try { assert.deepEqual(await worker(reopened).run(salesScope), unknown); }
    finally { reopened.close(); }
    assert.deepEqual([state.gets, state.posts, state.puts], [1, 1, 0]);
  } finally {
    rmSync(file, { force: true });
    rmdirSync(dir);
  }
});

test('uncertain patch recovers by exact readback alone and does not reissue a write', async t => {
  const db = memory(t);
  const { state, worker } = fixture();
  const unknown = { status: 'review', code: 'ATTACHMENT_PATCH_OUTCOME_UNKNOWN' };
  state.applyPut = false;
  state.afterPut = () => { throw new Error('synthetic response lost'); };
  assert.deepEqual(await worker(db).run(salesScope), unknown);
  assert.deepEqual(await worker(db).run(salesScope), unknown);
  state.targetTokens = [uploaded];
  assert.deepEqual(await worker(db).run(salesScope), unchanged);
  assert.deepEqual([state.gets, state.posts, state.puts], [1, 1, 1]);
});

test('two workers cannot both upload the same pending screenshot', async t => {
  const db = memory(t);
  const { state, worker } = fixture();
  let markPending, release;
  const pending = new Promise(resolve => { markPending = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  state.afterPost = async () => { markPending(); await wait; };
  const first = worker(db).run(salesScope);
  try {
    await pending;
    assert.deepEqual(await worker(db).run(salesScope), { status: 'review', code: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN' });
  } finally { release(); }
  assert.deepEqual(await first, updated);
  assert.deepEqual([state.gets, state.posts, state.puts], [1, 1, 1]);
});

test('refuses new work when stopped, disabled for a role, or pointed at another source', async t => {
  const db = memory(t);
  const { state, worker } = fixture();
  await assert.rejects(worker(db).run(salesScope, { shouldStop: () => true }), { code: 'ATTACHMENT_STOP_REQUESTED' });
  await assert.rejects(worker(db).run({ ...salesScope, source: { ...source, fieldId: 'fldOtherField12345' } }), { code: 'ATTACHMENT_WORKER_REQUEST_INVALID' });
  await assert.rejects(worker(db, { policy: { source, appId, enabledRoles: ['operator'], salesFixedReaders: [manager] } }).run(salesScope),
    { code: 'ATTACHMENT_WORKER_REQUEST_INVALID' });
  await assert.rejects(worker(db, { readAcl: async () => { throw Error('private response detail'); } }).run(salesScope),
    { code: 'ATTACHMENT_ACL_UNCONFIRMED', message: 'ATTACHMENT_ACL_UNCONFIRMED' });
  state.active = false;
  await assert.rejects(worker(db).run(salesScope), { code: 'ATTACHMENT_BINDING_CHANGED' });
  assert.deepEqual([state.gets, state.posts, state.puts], [0, 0, 0]);
});
