import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StaffProvisioner } from './staff-provisioner.mjs';
import { StaffAdminClient, STAFF_TARGET_NAMES } from './staff-admin-client.mjs';

const sourceBase = 'MasterSourceBase123456', staffBase = 'StaffManagementBase123456', newBase = 'NewEmployeeBase123456';
const options = { wxStatus: ['通过', '未通过', '已删除'], addMethod: ['销售主动加', '客户主动加'] };
const names = STAFF_TARGET_NAMES, keys = Object.keys(names);
const target = (base = newBase) => ({ appToken: base, baseUrl: `https://fixture.feishu.cn/base/${base}`, tableId: 'tblStaffPersonal123',
  fields: Object.fromEntries(keys.map((key, index) => [key, { fieldId: `fldPersonal${index}`, types: [key === 'wxStatus' || key === 'addMethod' ? 3 : 1] }])) });
const employee = (overrides = {}) => ({ recordId: 'recNewSales', openId: 'ou_new_sales_00001', displayName: '测试销售', role: 'sales', enabled: true, order: 3, version: 'version1', seeded: false, ...overrides });
const config = () => ({ appId: 'cli_fake_staff_app', appSecret: 'dummycredential-only-for-fake-tests', appToken: sourceBase,
  baseUrl: `https://fixture.feishu.cn/base/${sourceBase}`, tableIds: { leads: 'tblSourceMaster123' },
  fields: { leads: Object.fromEntries(keys.map((key, index) => [key, { fieldId: `fldSource${index}`, types: [key === 'wxStatus' || key === 'addMethod' ? 3 : 1] }])) },
  members: [], enabled: true, notification: { enabled: true }, mirrors: { feedbackFields: ['wxStatus'] },
  staffManagement: { enabled: true, appToken: staffBase, tableId: 'tblStaffManagement', fixedReaders: [1, 2, 3, 4].map(index => ({ openId: `ou_fixed_reader_${index}`, displayName: `管理${index}` })),
    operatorFormUrl: 'https://fixture.feishu.cn/share/base/form/shrOperatorForm123' } });
const error = (code, extra = {}) => Object.assign(new Error('Untrusted API detail must not reach result'), { code, ...extra });

function fixture(t, { input = employee(), hook, settings, people } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const cfg = config(), state = { current: structuredClone(input), calls: [], mutations: [], settings: settings ?? { externalAccessEntity: 'open', linkShareEntity: 'tenant_editable', manageCollaboratorEntity: 'collaborator_can_edit' },
    members: new Map(people ?? []), now: 1_000_000, readCurrentCount: 0, target: target(), schemaNames: {}, schemaOptions: structuredClone(options), hook, db };
  const schema = value => Object.fromEntries(Object.entries(value.fields).map(([key, spec]) => [key, { fieldId: spec.fieldId, name: state.schemaNames[key] ?? names[key], type: spec.types[0],
    property: options[key] ? { options: state.schemaOptions[key].map(name => ({ name })) } : {} }]));
  const mutate = async (name, payload, requestOptions, apply) => {
    await state.hook?.({ name, when: 'before_guard', state, payload });
    await requestOptions?.beforeMutation?.();
    state.mutations.push({ name, payload: structuredClone(payload) });
    const replacement = await state.hook?.({ name, when: 'after_guard', state, payload, apply });
    return replacement === undefined ? apply() : replacement;
  };
  const client = {
    async createBase(request) { state.calls.push('createBase'); return mutate('createBase', { name: request.name }, request, () => ({ appToken: newBase, url: target().baseUrl })); },
    async createBusinessTable(base, requestOptions) { assert.equal(base, newBase); state.calls.push('createBusinessTable'); return mutate('createBusinessTable', { base }, requestOptions, () => ({ ...structuredClone(state.target), expectedOptions: structuredClone(options) })); },
    async setPrivateSharing(base, requestOptions) { assert.equal(base, newBase); state.calls.push('setPrivateSharing'); return mutate('setPrivateSharing', { base }, requestOptions, () => { state.settings = { externalAccessEntity: 'closed', linkShareEntity: 'closed', manageCollaboratorEntity: 'collaborator_full_access' }; return {}; }); },
    async getSharing(base) { assert.equal(base, state.target.appToken); state.calls.push('getSharing'); await state.hook?.({ name: 'getSharing', when: 'read', state }); return structuredClone(state.settings); },
    async addMember(base, request) { assert.equal(base, newBase); state.calls.push('addMember'); return mutate('addMember', { openId: request.openId, perm: request.perm }, request, () => { state.members.set(request.openId, request.perm); return {}; }); },
    async listMembers(base) { assert.equal(base, state.target.appToken); state.calls.push('listMembers'); await state.hook?.({ name: 'listMembers', when: 'read', state }); return [{ openId: 'ou_our_bot_00001', memberType: 'openid', isApp: true, perm: 'full_access' }, ...[...state.members].map(([openId, perm]) => ({ openId, memberType: 'openid', perm }))]; },
    async getTargetSchema(value) { state.calls.push('getTargetSchema'); await state.hook?.({ name: 'getTargetSchema', when: 'read', state }); return schema(value); },
    async subscribeBase(base, requestOptions) { assert.equal(base, newBase); state.calls.push('subscribeBase'); return mutate('subscribeBase', { base }, requestOptions, () => ({})); },
    async sendOnboarding(person, request) { state.calls.push('sendOnboarding'); return mutate('sendOnboarding', { recipient: person.openId, role: person.role, url: request.url, clientToken: request.clientToken }, request, () => ({ messageId: 'om_fake_welcome' })); },
  };
  const args = { config: cfg, db, client, now: () => state.now, readCurrent: async recordId => { assert.equal(recordId, input.recordId); state.readCurrentCount++; return state.current ? structuredClone(state.current) : null; } };
  const provisioner = new StaffProvisioner(args);
  return { cfg, state, db, client, args, provisioner, input, advance() { state.now += 1_000_000; },
    prepareExisting() { state.settings = { externalAccessEntity: 'closed', linkShareEntity: 'closed', manageCollaboratorEntity: 'collaborator_full_access' };
      for (const reader of cfg.staffManagement.fixedReaders) state.members.set(reader.openId, 'view'); state.members.set(input.openId, 'edit'); } };
}

test('preview, disabled switches and stop never create a task or remote mutation', async t => {
  const f = fixture(t);
  assert.equal((await f.provisioner.ensure(f.input)).state, 'pending');
  f.cfg.notification.enabled = false;
  assert.equal((await f.provisioner.ensure(f.input, { apply: true })).errorCode, 'STAFF_AUTOMATION_DISABLED');
  f.cfg.notification.enabled = true;
  assert.equal((await f.provisioner.ensure(f.input, { apply: true, shouldStop: () => true })).errorCode, 'STAFF_STOPPED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM v2_staff_provision_jobs').get().n, 0);
  assert.deepEqual(f.state.calls, []);
});
test('new sale is ready only after private sharing, exact grants, schema, subscription and one own-entry welcome', async t => {
  const f = fixture(t);
  f.state.hook = ({ when, state }) => { if (when === 'after_guard') assert.match(f.provisioner.job(f.input.recordId).stage, /_inflight$/); };
  const result = await f.provisioner.ensure(f.input, { apply: true });
  assert.equal(result.state, 'ready'); assert.deepEqual(result.target, target());
  assert.deepEqual(f.state.mutations.map(call => call.name), ['createBase', 'createBusinessTable', 'setPrivateSharing', ...Array(5).fill('addMember'), 'subscribeBase', 'sendOnboarding']);
  const welcome = f.state.mutations.at(-1).payload;
  assert.equal(welcome.recipient, f.input.openId); assert.equal(welcome.url, target().baseUrl); assert.ok(!welcome.url.includes(sourceBase));
  assert.match(welcome.clientToken, /^[0-9a-f-]{36}$/i); assert.equal(f.provisioner.job(f.input.recordId).stage, 'ready');
  assert.deepEqual(f.provisioner.status().counts, { ready: 1 });
  assert.ok(f.state.readCurrentCount > f.state.mutations.length);
});
test('person among fixed four is granted edit exactly once, other exceptions view', async t => {
  const f = fixture(t, { input: employee({ openId: 'ou_fixed_reader_2' }) });
  assert.equal((await f.provisioner.ensure(f.input, { apply: true })).state, 'ready');
  const grants = f.state.mutations.filter(call => call.name === 'addMember').map(call => call.payload);
  assert.equal(grants.length, 4); assert.deepEqual(grants.find(grant => grant.openId === f.input.openId), { openId: f.input.openId, perm: 'edit' });
  assert.ok(grants.filter(grant => grant.openId !== f.input.openId).every(grant => grant.perm === 'view'));
});
for (const action of ['createBase', 'createBusinessTable', 'setPrivateSharing', 'addMember', 'subscribeBase', 'sendOnboarding']) {
  test(`disable immediately before ${action} prevents that actual mutation and preserves prior resources`, async t => {
    const f = fixture(t, { hook({ name, when, state }) { if (name === action && when === 'before_guard') state.current.enabled = false; } });
    const result = await f.provisioner.ensure(f.input, { apply: true });
    assert.equal(result.state, 'pending'); assert.equal(result.errorCode, 'STAFF_EMPLOYEE_DISABLED');
    assert.equal(f.state.mutations.filter(call => call.name === action).length, 0);
    assert.ok(!f.state.mutations.some(call => /delete|remove/i.test(call.name)));
  });
}
test('role/version change during table preparation pauses before table POST and does not rebind old task', async t => {
  const f = fixture(t, { hook({ name, when, state }) { if (name === 'createBusinessTable' && when === 'before_guard') state.current = { ...state.current, role: 'operator', version: 'different' }; } });
  assert.equal((await f.provisioner.ensure(f.input, { apply: true })).errorCode, 'STAFF_INPUT_CHANGED');
  assert.equal(f.state.mutations.filter(call => call.name === 'createBase').length, 1);
  assert.equal(f.state.mutations.filter(call => call.name === 'createBusinessTable').length, 0);
  const changed = { ...f.input, role: 'operator', version: 'different' };
  assert.equal((await f.provisioner.ensure(changed, { apply: true })).state, 'review');
  assert.equal(f.state.mutations.length, 1);
});
for (const action of ['createBase', 'createBusinessTable', 'addMember', 'subscribeBase', 'sendOnboarding']) {
  test(`unknown ${action} outcome remains review through reconstruction and never replays POST`, async t => {
    const f = fixture(t, { hook({ name, when, apply }) { if (name === action && when === 'after_guard') { apply(); throw error('NETWORK_OR_TIMEOUT'); } } });
    const first = await f.provisioner.ensure(f.input, { apply: true }); assert.equal(first.state, 'review');
    const before = f.state.mutations.length;
    const restarted = new StaffProvisioner(f.args); f.state.hook = null; f.advance();
    assert.equal((await restarted.ensure(f.input, { apply: true })).state, 'review');
    assert.equal(f.state.mutations.length, before); assert.equal(f.state.mutations.filter(call => call.name === action).length, 1);
  });
}
test('a persisted in-flight marker on restart becomes review without executing a request', async t => {
  const f = fixture(t, { hook({ name, when }) { if (name === 'createBase' && when === 'after_guard') throw error('99991400', { staffDefinitelyRejected: true }); } });
  assert.equal((await f.provisioner.ensure(f.input, { apply: true })).state, 'pending');
  f.db.prepare("UPDATE v2_staff_provision_jobs SET stage='base_create_inflight' WHERE record_id=?").run(f.input.recordId);
  f.state.hook = null; const before = f.state.mutations.length;
  assert.equal((await new StaffProvisioner(f.args).ensure(f.input, { apply: true })).errorCode, 'STAFF_INTERRUPTED_MUTATION_REVIEW');
  assert.equal(f.state.mutations.length, before);
});
test('definite welcome rejection retries only when due with same frozen recipient, URL and UUID', async t => {
  let rejected = false;
  const f = fixture(t, { hook({ name, when }) { if (name === 'sendOnboarding' && when === 'after_guard' && !rejected) { rejected = true; throw error('230013', { staffDefinitelyRejected: true }); } } });
  const first = await f.provisioner.ensure(f.input, { apply: true }); assert.equal(first.state, 'pending'); assert.ok(first.nextRetryAt > f.state.now);
  const before = f.state.mutations.length;
  assert.equal((await f.provisioner.ensure(f.input, { apply: true })).state, 'pending'); assert.equal(f.state.mutations.length, before);
  f.advance(); assert.equal((await f.provisioner.ensure(f.input, { apply: true })).state, 'ready');
  const messages = f.state.mutations.filter(call => call.name === 'sendOnboarding'); assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].payload, messages[1].payload); assert.equal(f.state.mutations.filter(call => call.name === 'createBase').length, 1);
});
test('grant successful but not yet readable waits without adding the same collaborator twice', async t => {
  const f = fixture(t, { hook({ name, when }) { if (name === 'addMember' && when === 'after_guard') return {}; } });
  const first = await f.provisioner.ensure(f.input, { apply: true });
  assert.equal(first.errorCode, 'STAFF_MEMBER_GRANT_UNCONFIRMED'); assert.equal(f.state.mutations.filter(call => call.name === 'addMember').length, 1);
  f.advance(); await f.provisioner.ensure(f.input, { apply: true });
  assert.equal(f.state.mutations.filter(call => call.name === 'addMember').length, 1);
});
test('unknown collaborator prevents readiness and no owner flag bypass is used for users', async t => {
  const f = fixture(t, { people: [['ou_unapproved_person', 'view']] });
  const result = await f.provisioner.ensure(f.input, { apply: true });
  assert.equal(result.state, 'review'); assert.equal(result.errorCode, 'STAFF_UNKNOWN_COLLABORATOR_REVIEW');
  assert.equal(f.state.mutations.filter(call => call.name === 'addMember' || call.name === 'sendOnboarding' || call.name === 'subscribeBase').length, 0);
});
test('schema drift and inaccurate select options fail closed before sharing/grants/welcome', async t => {
  for (const kind of ['name', 'options']) {
    const f = fixture(t);
    if (kind === 'name') f.state.schemaNames.wx = '同名被改'; else f.state.schemaOptions.wxStatus = ['不同选项'];
    const result = await f.provisioner.ensure(f.input, { apply: true }); assert.equal(result.state, 'review');
    assert.equal(f.state.mutations.length, 2);
  }
});
test('seeded trusted sales target is audited read-only, permits fixed owner, never reconfigures or welcomes', async t => {
  const f = fixture(t, { input: employee({ seeded: true }) }); f.prepareExisting();
  f.state.members.set(f.cfg.staffManagement.fixedReaders[0].openId, 'full_access');
  const result = await f.provisioner.ensure({ ...f.input, target: target() }, { apply: true });
  assert.equal(result.state, 'ready'); assert.deepEqual(f.state.mutations, []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM v2_staff_provision_jobs').get().n, 0);
  f.state.settings.linkShareEntity = 'tenant_readable';
  assert.equal((await f.provisioner.ensure({ ...f.input, target: target() }, { apply: true })).state, 'review');
  assert.deepEqual(f.state.mutations, []);
});
test('completed target follows field rename/order changes with no new resources or duplicate welcome', async t => {
  const f = fixture(t); const ready = await f.provisioner.ensure(f.input, { apply: true }); assert.equal(ready.state, 'ready');
  const before = f.state.mutations.length;
  f.state.current = { ...f.state.current, order: 6, version: 'new-order-version' }; f.state.schemaNames.wx = '微信改名后';
  const changed = { ...f.state.current, target: ready.target };
  assert.equal((await f.provisioner.ensure(changed, { apply: true })).state, 'ready');
  assert.equal(f.state.mutations.length, before); assert.equal(f.state.mutations.filter(call => call.name === 'sendOnboarding').length, 1);
});
test('new operator receives only form entry, seed operator is silent; neither creates Base', async t => {
  const f = fixture(t, { input: employee({ role: 'operator', order: null }) });
  const result = await f.provisioner.ensure(f.input, { apply: true }); assert.equal(result.state, 'ready'); assert.equal(result.url, f.cfg.staffManagement.operatorFormUrl);
  assert.deepEqual(f.state.mutations.map(call => call.name), ['sendOnboarding']);
  assert.equal(f.state.mutations[0].payload.url, f.cfg.staffManagement.operatorFormUrl);
  const seed = fixture(t, { input: employee({ role: 'operator', order: null, seeded: true }) });
  assert.equal((await seed.provisioner.ensure(seed.input, { apply: true })).state, 'ready'); assert.deepEqual(seed.state.calls, []);
});
test('same person re-created under a different row cannot create a second Base; db caller retains ownership', async t => {
  const f = fixture(t); assert.equal((await f.provisioner.ensure(f.input, { apply: true })).state, 'ready');
  const next = { ...f.input, recordId: 'recReplacement' }; f.state.current = next;
  f.provisioner.readCurrent = async () => structuredClone(next);
  const before = f.state.mutations.length;
  assert.equal((await f.provisioner.ensure(next, { apply: true })).errorCode, 'STAFF_DUPLICATE_EMPLOYEE_IDENTITY_REVIEW');
  assert.equal(f.state.mutations.length, before); assert.equal(f.db.prepare('SELECT 1 AS ok').get().ok, 1);
});
test('a created Base token cannot be attached to a second employee job', async t => {
  const f = fixture(t); assert.equal((await f.provisioner.ensure(f.input, { apply: true })).state, 'ready');
  const next = employee({ recordId: 'recOtherPerson', openId: 'ou_other_sale_0001', version: 'other-version' });
  f.state.current = next; f.provisioner.readCurrent = async () => structuredClone(next);
  const result = await f.provisioner.ensure(next, { apply: true });
  assert.equal(result.state, 'review');
  assert.equal(f.provisioner.job(f.input.recordId).base_token, newBase);
  assert.equal(f.provisioner.job(next.recordId).base_token, null);
  assert.equal(f.state.mutations.filter(call => call.name === 'createBusinessTable').length, 1);
});

function adapterFixture({ beforeTablePost } = {}) {
  const cfg = config(), calls = [], sourceFields = keys.map((key, index) => ({ field_id: `fldSource${index}`, field_name: names[key], type: options[key] ? 3 : 1,
    property: options[key] ? { options: options[key].map((name, index) => ({ name, id: `optSource${index}`, color: index })) } : {} }));
  const shared = { retryMutations: false, config: cfg, async api(endpoint, request = {}) {
    calls.push({ endpoint, ...structuredClone(request) });
    if (endpoint.endsWith('/fields')) { await beforeTablePost?.(); return { items: sourceFields, has_more: false }; }
    if (endpoint === '/open-apis/bot/v3/info') return { bot: { open_id: 'ou_our_app_bot_0001' } };
    if (endpoint.endsWith('/members') && !request.method) return { items: [{ member_type: 'openid', member_id: 'ou_our_app_bot_0001', perm: 'full_access' }, { member_type: 'openid', member_id: 'ou_other_owner_0001', perm: 'owner', is_owner: true }] };
    if (endpoint.endsWith('/tables')) return { table_id: 'tblNewBusiness123', field_id_list: request.body.table.fields.map((_, index) => `fldNewBusiness${index}`) };
    if (endpoint === '/open-apis/bitable/v1/apps') return { app: { app_token: newBase, url: target().baseUrl, default_table_id: 'tblUnusedDefault123' } };
    return {};
  }, async sendNotification(payload) { calls.push({ notification: payload }); return { messageId: 'om_adapter_welcome' }; } };
  return { cfg, calls, shared, sourceFields, client: new StaffAdminClient(cfg, { sourceClient: shared }) };
}
test('admin adapter strict mutation transport, source-ID enums, one table POST and no whole-space/delete APIs', async () => {
  const f = adapterFixture(); assert.equal(f.client.retryMutations, false);
  const result = await f.client.createBusinessTable(newBase, { beforeMutation: async () => {} });
  assert.equal(result.appToken, newBase); assert.equal(result.tableId, 'tblNewBusiness123');
  const posts = f.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  assert.equal(posts[0].body.table.fields.length, 5);
  assert.deepEqual(posts[0].body.table.fields[2].property.options.map(option => option.name), options.wxStatus);
  assert.ok(posts[0].body.table.fields[2].property.options.every(option => !Object.hasOwn(option, 'id')));
  assert.ok(!f.calls.some(call => /space|visibility|delete/i.test(call.endpoint ?? '')));
});
test('new sales tables add the optional date and operator text while leaving core field pins unchanged', async () => {
  const f = adapterFixture();
  f.cfg.mirrors.salesDetails = true;
  f.cfg.fields.leads.leadDate = { fieldId: 'fldSourceDate000', types: [5] };
  f.sourceFields.push({ field_id: 'fldSourceDate000', field_name: '日期', type: 5, property: { date_formatter: 'yyyy/MM/dd' } });
  const result = await f.client.createBusinessTable(newBase);
  const columns = f.calls.find(call => call.method === 'POST').body.table.fields;
  assert.deepEqual(columns.slice(5), [
    { field_name: '日期', type: 5, property: { date_formatter: 'yyyy/MM/dd' } },
    { field_name: '运营名字', type: 1 },
  ]);
  assert.deepEqual(Object.keys(result.fields), keys);
});
test('adapter performs employee guard after internal source schema GET, before real table mutation', async () => {
  let changed = false; const f = adapterFixture({ beforeTablePost: async () => { changed = true; } });
  await assert.rejects(f.client.createBusinessTable(newBase, { beforeMutation: async () => { if (changed) throw error('STAFF_INPUT_CHANGED'); } }), { code: 'STAFF_INPUT_CHANGED', staffMutationAttempted: false });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});
test('source field replaced with same name/different ID or incompatible type prevents create POST', async () => {
  for (const kind of ['id', 'type']) {
    const f = adapterFixture(); if (kind === 'id') f.sourceFields[2].field_id = 'fldUnrelatedReplacement'; else f.sourceFields[2].type = 1;
    await assert.rejects(f.client.createBusinessTable(newBase)); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  }
});
test('adapter application proof uses bot identity, never accepts arbitrary is_owner as this app', async () => {
  const f = adapterFixture(), members = await f.client.listMembers(newBase);
  assert.equal(members[0].isApp, true); assert.equal(members[1].isApp, false); assert.equal(members[1].isOwner, true);
  await f.client.listMembers(newBase); assert.equal(f.calls.filter(call => call.endpoint === '/open-apis/bot/v3/info').length, 1);
});
test('adapter rejects source/management/old targets for mutation and does not delegate unsafe source transport', async () => {
  const f = adapterFixture();
  for (const base of [sourceBase, staffBase]) {
    await assert.rejects(f.client.setPrivateSharing(base), { code: 'STAFF_PROTECTED_BASE' });
    await assert.rejects(f.client.addMember(base, { openId: 'ou_new_person_0001', perm: 'edit' }), { code: 'STAFF_PROTECTED_BASE' });
  }
  const unsafe = new StaffAdminClient(f.cfg, { sourceClient: { retryMutations: true, api() { throw new Error('must not delegate'); } } });
  assert.equal(unsafe.sourceClient, null); assert.equal(unsafe.retryMutations, false);
  f.shared.retryMutations = true;
  await assert.rejects(f.client.subscribeBase(newBase), { code: 'STAFF_SHARED_TRANSPORT_CHANGED', staffMutationAttempted: false });
});
test('adapter permits only individual edit/view and only approved personal/form welcome URLs', async () => {
  const f = adapterFixture();
  await assert.rejects(f.client.addMember(newBase, { openId: 'ou_person_0001', perm: 'full_access' }), { code: 'STAFF_MEMBER_GRANT_INVALID' });
  await f.client.setPrivateSharing(newBase);
  const patch = f.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { external_access_entity: 'closed', link_share_entity: 'closed', share_entity: 'same_tenant', manage_collaborator_entity: 'collaborator_full_access' });
  const token = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(f.client.sendOnboarding(employee(), { url: f.cfg.baseUrl, clientToken: token }), { code: 'STAFF_ENTRY_URL_INVALID' });
  await f.client.sendOnboarding(employee(), { url: target().baseUrl, clientToken: token });
  await f.client.sendOnboarding(employee({ role: 'operator' }), { url: f.cfg.staffManagement.operatorFormUrl, clientToken: token });
  const messages = f.calls.filter(call => call.notification).map(call => call.notification);
  assert.equal(messages.length, 2); assert.equal(messages[0].url, target().baseUrl); assert.equal(messages[1].url, f.cfg.staffManagement.operatorFormUrl);
  assert.ok(messages.every(message => message.recipientOpenId === employee().openId && !JSON.stringify(message).includes(f.cfg.baseUrl)));
});
test('real StaffAdminClient transport never sleeps or replays a rate-limited subscription POST', async () => {
  let requests = 0, sleeps = 0;
  const client = new StaffAdminClient(config(), { retryMutations: true, fetchImpl: async () => { requests++; return new Response(JSON.stringify({ code: 99991400, msg: 'rate limited' }), { status: 429, headers: { 'Content-Type': 'application/json' } }); }, sleepImpl: async () => { sleeps++; } });
  client.cachedToken = { value: 'fake-cached-token', expiresAt: Date.now() + 60000 };
  await assert.rejects(client.subscribeBase(newBase), { code: '99991400', staffMutationAttempted: true, staffDefinitelyRejected: true });
  assert.equal(client.retryMutations, false); assert.equal(requests, 1); assert.equal(sleeps, 0);
});
