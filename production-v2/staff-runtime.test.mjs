import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEngine } from './cli.mjs';
import { validateWorkflowConfig } from './field-map.mjs';
import { WorkflowClient } from './client.mjs';
import { SalesMirror } from './sales-mirror.mjs';
import { WorkflowEvents } from './events.mjs';

const clone = value => structuredClone(value);
const SOURCE = 'RuntimeMasterBase123456', STAFF = 'RuntimeEmployeeBase123456', SOURCE_TABLE = 'tblRuntimeMaster123', STAFF_TABLE = 'tblRuntimeStaff123';
const sourceNames = { owner: '负责人', operator: '录入运营', wx: '微信号', needs: '客户需求（天数/景点/预算等）', wxStatus: '微信状态', addMethod: '添加方式', partySize: '出游人数', actualSlot: '实际分配位', actualSort: '实际分配顺序', salesName: '实际分配销售' };
const sourceTypes = { owner: 11, operator: 11, wx: 1, needs: 1, wxStatus: 3, addMethod: 3, partySize: 1, actualSlot: 2, actualSort: 2, salesName: 1 };
const staffNames = { employee: '员工', role: '岗位', enabled: '接收新单', order: '接单顺序', notes: '备注', status: '状态', personalUrl: '个人入口', updatedAt: '更新时间', error: '错误' };
const staffTypes = { employee: 11, role: 3, enabled: 7, order: 2, notes: 1, status: 1, personalUrl: 1, updatedAt: 1, error: 1 };
const newSourceFields = { account: ['平台账号名称', 3], leadSource: ['客资来源（付费/自然流）', 3], channel: ['渠道', 3], leadDate: ['日期', 5] };
const newStaffFields = { salesWechat: ['销售对外微信号', 1], leaveStart: ['休假开始日期', 5], leaveEnd: ['休假结束日期', 5], operatorViewUrl: ['运营客资查看入口', 1] };
for (const [key, [name]] of Object.entries(newSourceFields)) sourceNames[key] = name;
for (const [key, [name]] of Object.entries(newStaffFields)) staffNames[key] = name;
const selects = { wxStatus: ['通过', '未通过', '已删除'], addMethod: ['销售主动加', '客户主动加'], role: ['销售', '运营'] };
Object.assign(selects, { account: ['离线平台'], leadSource: ['自然流'], channel: ['离线渠道'] });
const personalKeys = ['wx', 'needs', 'wxStatus', 'addMethod', 'partySize'];
const sourceDefinitions = () => Object.fromEntries(Object.entries(sourceTypes).map(([key, type]) => [key, { fieldId: `fldRuntimeSource${key}`, types: [type], ...(['owner', 'operator'].includes(key) ? { multiple: false } : {}) }]));
const seedTarget = number => ({ appToken: `RuntimeSeedSalesBase${number}123`, baseUrl: `https://runtime.feishu.cn/base/RuntimeSeedSalesBase${number}123`, tableId: `tblRuntimeSeed${number}123`,
  fields: Object.fromEntries(personalKeys.map(key => [key, { fieldId: `fldRuntimeSeed${number}${key}`, types: [sourceTypes[key]] }])) });
const staffRow = ({ id, openId, name, role = '销售', enabled = true, order = null }) => ({ record_id: id, fields: {
  员工: [{ id: openId, name }], 岗位: role, 接收新单: enabled, 接单顺序: order,
} });
function configuration() {
  return { appId: 'cli_runtime_fixture', appSecret: 'fake-runtime-fixture-secret', appToken: SOURCE,
    baseUrl: `https://runtime.feishu.cn/base/${SOURCE}`, tableIds: { leads: SOURCE_TABLE }, fields: { leads: sourceDefinitions() },
    members: [1, 2].map(number => ({ id: `sales_slot_${number}`, openId: `ou_seed_sales_${number}12345`, displayName: number === 1 ? '魏琳娜' : '罗子安', order: number, enabled: true, target: seedTarget(number) })),
    enabled: true, notification: { enabled: true }, allowedHost: 'OFFLINE-RUNTIME-ONLY', dbPath: 'data/workflow.sqlite',
    mirrors: { enabled: true, feedbackFields: ['wxStatus'] }, requiredLeadFields: ['wx', 'needs'], events: true, pollSeconds: 600,
    staffManagement: { enabled: true, appToken: STAFF, tableId: STAFF_TABLE,
      fields: Object.fromEntries(Object.entries(staffTypes).map(([key, type]) => [key, { fieldId: `fldRuntimeStaff${key}`, types: [type], ...(key === 'employee' ? { multiple: false } : {}) }])),
      fixedReaders: [{ openId: 'ou_runtime_manager_0001', displayName: '吴忠展' }, { openId: 'ou_seed_sales_212345', displayName: '罗子安' }, { openId: 'ou_seed_sales_112345', displayName: '魏琳娜' }, { openId: 'ou_runtime_manager_0002', displayName: '周婷' }],
      operatorFormUrl: 'https://runtime.feishu.cn/share/base/form/shrRuntimeOperator123', seedRecordIds: ['recRuntimeSeed1', 'recRuntimeSeed2', 'recRuntimeOperator'] } };
}
function schema(definitions, names) {
  return Object.entries(definitions).map(([key, spec]) => ({ field_id: spec.fieldId, field_name: names[key], type: spec.types[0],
    property: spec.types[0] === 11 ? { multiple: false } : selects[key] ? { options: selects[key].map(name => ({ name })) } : {} }));
}
class Service {
  constructor(config) {
    this.config = config; this.calls = []; this.messages = []; this.created = 0; this.recordSequence = 0; this.hook = null;
    this.bases = new Map(); this.clients = new Map();
    this.addBase(SOURCE, SOURCE_TABLE, schema(config.fields.leads, sourceNames));
    this.addBase(STAFF, STAFF_TABLE, schema(config.staffManagement.fields, staffNames));
    for (const member of config.members) {
      const base = this.addBase(member.target.appToken, member.target.tableId, schema(member.target.fields, sourceNames));
      base.private = true;
      for (const reader of config.staffManagement.fixedReaders) base.members.set(reader.openId, reader.openId === member.openId ? 'edit' : 'view');
    }
    const rows = this.table(STAFF, STAFF_TABLE).records;
    for (let number = 1; number <= 2; number++) rows.set(`recRuntimeSeed${number}`, staffRow({ id: `recRuntimeSeed${number}`, openId: config.members[number - 1].openId, name: config.members[number - 1].displayName, order: number }));
    rows.set('recRuntimeOperator', staffRow({ id: 'recRuntimeOperator', openId: 'ou_runtime_operator_0001', name: '离线录入运营', role: '运营' }));
  }
  addBase(token, table, fields) {
    const base = { private: false, members: new Map(), subscribed: false, tables: new Map([[table, { fields: clone(fields), records: new Map() }]]) };
    this.bases.set(token, base); return base;
  }
  table(base, table) { const result = this.bases.get(base)?.tables.get(table); assert.ok(result, 'Only explicitly created fake resources may be read'); return result; }
  client(token = SOURCE) {
    if (!this.clients.has(token)) this.clients.set(token, new MemoryClient({ ...this.config, appToken: token }, this));
    return this.clients.get(token);
  }
  async api(endpoint, request = {}) {
    const call = { endpoint, method: request.method ?? 'GET', body: clone(request.body), query: clone(request.query) };
    await this.hook?.(call); this.calls.push(call);
    if (endpoint === '/open-apis/bot/v3/info') return { bot: { open_id: 'ou_runtime_bot_00001' } };
    if (endpoint === '/open-apis/im/v1/messages') {
      assert.equal(call.method, 'POST'); this.messages.push(clone(call.body)); return { message_id: `om_runtime_${this.messages.length}` };
    }
    if (endpoint === '/open-apis/bitable/v1/apps') {
      assert.equal(call.method, 'POST'); const token = `RuntimeProvisionedBase${++this.created}12345`;
      this.addBase(token, `tblUnusedDefault${this.created}`, [{ field_id: `fldUnusedDefault${this.created}`, field_name: '默认空白', type: 1, property: {} }]);
      return { app: { app_token: token, url: `https://runtime.feishu.cn/base/${token}`, default_table_id: `tblUnusedDefault${this.created}` } };
    }
    const sharing = endpoint.match(/^\/open-apis\/drive\/v2\/permissions\/([^/]+)\/public$/);
    if (sharing) {
      const base = this.bases.get(sharing[1]); assert.ok(base);
      if (call.method === 'PATCH') { assert.notEqual(sharing[1], SOURCE); assert.notEqual(sharing[1], STAFF); base.private = true; }
      return { permission_public: { external_access_entity: base.private ? 'closed' : 'open', link_share_entity: base.private ? 'closed' : 'tenant_editable', manage_collaborator_entity: base.private ? 'collaborator_full_access' : 'collaborator_can_edit' } };
    }
    const members = endpoint.match(/^\/open-apis\/drive\/v1\/permissions\/([^/]+)\/members$/);
    if (members) {
      const base = this.bases.get(members[1]); assert.ok(base);
      if (call.method === 'POST') { assert.equal(call.body.member_type, 'openid'); assert.ok(['view', 'edit'].includes(call.body.perm)); base.members.set(call.body.member_id, call.body.perm); return {}; }
      return { items: [{ member_type: 'openid', member_id: 'ou_runtime_bot_00001', perm: 'full_access' }, ...[...base.members].map(([id, perm]) => ({ member_type: 'openid', member_id: id, perm }))], has_more: false };
    }
    const subscribed = endpoint.match(/^\/open-apis\/drive\/v1\/files\/([^/]+)\/subscribe$/);
    if (subscribed) { assert.equal(call.method, 'POST'); this.bases.get(subscribed[1]).subscribed = true; return {}; }
    const match = endpoint.match(/^\/open-apis\/bitable\/v1\/apps\/([^/]+)\/tables(?:\/([^/]+))?(?:\/(fields|records))?(?:\/(rec[A-Za-z0-9]+))?$/);
    assert.ok(match, 'No unexpected endpoint or real HTTP call is permitted');
    const [, baseToken, tableId, resource, recordId] = match;
    if (!tableId) {
      assert.equal(call.method, 'POST'); assert.notEqual(baseToken, SOURCE); assert.notEqual(baseToken, STAFF);
      const id = `tblCreatedBusiness${this.created}123`, headers = call.body.table.fields;
      const fields = headers.map((field, index) => ({ ...clone(field), field_id: `fldCreated${this.created}Header${index}` }));
      this.bases.get(baseToken).tables.set(id, { fields, records: new Map() }); return { table_id: id, field_id_list: fields.map(field => field.field_id) };
    }
    const table = this.table(baseToken, tableId);
    if (resource === 'fields') { assert.equal(call.method, 'GET'); return { items: clone(table.fields), has_more: false }; }
    assert.equal(resource, 'records');
    if (!recordId) {
      if (call.method === 'POST') { const id = `recRuntimeChild${++this.recordSequence}`; const row = { record_id: id, fields: clone(call.body.fields) }; table.records.set(id, row); return { record: clone(row) }; }
      return { items: [...table.records.values()].map(clone), has_more: false, total: table.records.size };
    }
    if (!table.records.has(recordId)) throw Object.assign(new Error('fake missing'), { code: '1254043' });
    if (call.method === 'PUT') Object.assign(table.records.get(recordId).fields, clone(call.body.fields));
    else if (call.method === 'DELETE') { table.records.delete(recordId); return { deleted: true }; }
    else assert.equal(call.method, 'GET');
    return { record: clone(table.records.get(recordId)) };
  }
  onboardingMutations() { return this.calls.filter(call => call.method !== 'GET' && (call.endpoint === '/open-apis/bitable/v1/apps' || /\/tables$|\/permissions\/|\/subscribe$/.test(call.endpoint) || call.endpoint === '/open-apis/im/v1/messages' && JSON.parse(call.body.content).text.includes('拾野记工作入口'))); }
}
class MemoryClient extends WorkflowClient {
  constructor(config, service) { super(config, { fetchImpl: async () => { throw new Error('REAL_NETWORK_FORBIDDEN'); } }); this.service = service; }
  async tenantToken() { return 'fake-runtime-memory-token'; }
  async api(endpoint, options) { return this.service.api(endpoint, options); }
}
async function fixture(t, config = configuration(), beforeInitialize = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'shiyeji-staff-runtime-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.match(path.basename(root), /^shiyeji-staff-runtime-/);
  const file = path.join(root, 'config.workflow.local.json');
  writeFileSync(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 }); mkdirSync(path.join(root, 'data'));
  const service = new Service(config);
  beforeInitialize(service);
  class OfflineMirror extends SalesMirror { constructor(options) { super({ ...options, clientFactory: appToken => service.client(appToken) }); } }
  const engine = await createEngine(validateWorkflowConfig(config), { root, client: service.client(), Mirror: OfflineMirror });
  t.after(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await engine.initialize()).ok, true);
  const newEmployee = { id: 'recRuntimeNewSales', openId: 'ou_runtime_new_sales_0001', name: '离线新增销售', order: 3 };
  return { root, file, config, service, engine, newEmployee,
    addNewEmployee() { service.table(STAFF, STAFF_TABLE).records.set(newEmployee.id, staffRow(newEmployee)); },
    disableSeeds() { for (let index = 1; index <= 2; index++) service.table(STAFF, STAFF_TABLE).records.get(`recRuntimeSeed${index}`).fields.接收新单 = false; },
    closeConfig(kind = 'enabled') { const latest = JSON.parse(readFileSync(file, 'utf8')); if (kind === 'enabled') latest.enabled = false; else latest.notification.enabled = false; writeFileSync(file, JSON.stringify(latest)); },
  };
}

test('real createEngine + staff modules prepare a new target and assign a new lead without editing config.members', async t => {
  const f = await fixture(t); const originalMembers = clone(f.config.members);
  const seeded = await f.engine.scan({ apply: true }); assert.equal(seeded.ok, true);
  assert.equal(f.service.onboardingMutations().length, 0); assert.equal(f.service.messages.length, 0);
  f.disableSeeds(); f.addNewEmployee();
  f.service.table(SOURCE, SOURCE_TABLE).records.set('recRuntimeNewLead', { record_id: 'recRuntimeNewLead', fields: {
    负责人: [], 录入运营: [{ id: 'ou_runtime_operator_0001' }], 微信号: 'offline_customer_only', '客户需求（天数/景点/预算等）': 'offline requirement', 微信状态: '通过', 添加方式: '销售主动加', 出游人数: '2',
  } });
  const result = await f.engine.scan({ apply: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const member = f.engine.config.members.find(item => item.openId === f.newEmployee.openId);
  assert.ok(member?.enabled); assert.equal(member.id, `staff_${f.newEmployee.id}`); assert.ok(member.target.appToken.startsWith('RuntimeProvisionedBase'));
  assert.equal(f.service.created, 1); assert.equal(f.service.bases.get(member.target.appToken).subscribed, true);
  assert.equal(f.service.table(SOURCE, SOURCE_TABLE).records.get('recRuntimeNewLead').fields.负责人[0].id, f.newEmployee.openId);
  assert.equal(f.service.table(member.target.appToken, member.target.tableId).records.size, 1);
  assert.equal(f.service.messages.length, 2);
  const text = f.service.messages.map(message => JSON.parse(message.content).text);
  assert.equal(text.filter(value => value.includes('拾野记工作入口')).length, 1);
  assert.ok(text.every(value => !value.includes(`/base/${SOURCE}`)));
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).members, originalMembers);
  const createdBefore = f.service.created, messagesBefore = f.service.messages.length;
  await f.engine.scan({ apply: true }); assert.equal(f.service.created, createdBefore); assert.equal(f.service.messages.length, messagesBefore);
});

test('real v2.2 engine, roster and operator mirror keep operator views private while using the new notices', async t => {
  const config = configuration();
  for (const [key, [, type]] of Object.entries(newSourceFields)) config.fields.leads[key] = { fieldId: `fldV22Source${key}`, types: [type] };
  for (const [key, [, type]] of Object.entries(newStaffFields)) config.staffManagement.fields[key] = { fieldId: `fldV22Staff${key}`, types: [type] };
  config.staffManagement.operatorViews = { enabled: true };
  const actorA = 'ou_runtime_operator_0001', actorB = 'ou_runtime_operator_0002';
  const lead = (id, operator, owner = '') => ({ record_id: id, fields: {
    负责人: owner ? [{ id: owner }] : [], 录入运营: [{ id: operator }], 微信号: 'offline_customer',
    '客户需求（天数/景点/预算等）': 'offline requirement', 微信状态: '通过', 添加方式: '销售主动加', 出游人数: '2',
    平台账号名称: '离线平台', 渠道: '离线渠道', '客资来源（付费/自然流）': '自然流', 日期: 1795032000000,
  } });
  const f = await fixture(t, config, service => {
    const source = service.table(SOURCE, SOURCE_TABLE).records;
    source.set('recRuntimeQuiet', lead('recRuntimeQuiet', actorA, config.members[0].openId));
    source.set('recRuntimeOther', lead('recRuntimeOther', actorB, config.members[0].openId));
    service.table(STAFF, STAFF_TABLE).records.get('recRuntimeSeed1').fields.销售对外微信号 = 'offline_sales_public';
  });
  const first = await f.engine.scan({ apply: true });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(f.engine.status().operatorMirror.ready, 1);
  assert.equal(f.service.messages.length, 0);
  const staffRowA = f.service.table(STAFF, STAFF_TABLE).records.get('recRuntimeOperator');
  const entry = new URL(staffRowA.fields.运营客资查看入口);
  const operatorToken = entry.pathname.split('/').at(-1), operatorTable = entry.searchParams.get('table');
  const personal = f.service.table(operatorToken, operatorTable);
  assert.deepEqual([...f.service.bases.get(operatorToken).members], [[actorA, 'view']]);
  assert.equal(f.service.bases.get(operatorToken).private, true);
  assert.equal(f.service.bases.get(operatorToken).subscribed, false);
  assert.equal(personal.records.size, 1);
  assert.equal([...personal.records.values()][0].fields['客资来源（付费/自然流）'], '自然流');

  f.service.table(SOURCE, SOURCE_TABLE).records.set('recRuntimeNewV22', lead('recRuntimeNewV22', actorA));
  await f.engine.scan({ apply: true });
  assert.equal(personal.records.size, 2);
  const seller = f.service.messages.find(message => message.receive_id === config.members[0].openId);
  const operator = f.service.messages.find(message => message.receive_id === actorA);
  const sellerText = JSON.parse(seller.content).text;
  assert.match(sellerText, /所属账号：离线平台/);
  assert.doesNotMatch(sellerText, /https?:\/\/|自然流/);
  assert.equal(operator, undefined);
  assert.equal(f.service.messages.length, 1);
  f.service.table(SOURCE, SOURCE_TABLE).records.get('recRuntimeNewV22').fields.添加方式 = '客户主动加';
  await f.engine.scan({ apply: true });
  const activeAddNotice = f.service.messages.find(message => message.receive_id === actorA);
  assert.match(JSON.parse(activeAddNotice.content).text, /offline_sales_public/);
  assert.equal(f.service.messages.length, 2);
  await f.engine.scan({ apply: true });
  assert.equal(f.service.messages.length, 2);
});
test('staff-enabled runner auto-enables scalar sync per exact private sales schema, without changing private config', async t => {
  const config = configuration();
  config.fields.leads.leadDate = { fieldId: 'fldRuntimeSourceDate', types: [5] };
  const [first, second] = config.members;
  const date = 1_760_000_000_000;
  const f = await fixture(t, config, service => {
    for (const member of [first, second]) {
      const { appToken, tableId } = member.target;
      service.table(appToken, tableId).fields.push({ field_id: 'fldRuntimeDetailDate', field_name: '日期', type: 5 });
    }
    service.table(first.target.appToken, first.target.tableId).fields
      .push({ field_id: 'fldRuntimeDetailOperator', field_name: '运营名字', type: 1 });
    const source = service.table(SOURCE, SOURCE_TABLE).records;
    for (const member of [first, second]) {
      const id = member === first ? 'recRuntimeDetailsFirst' : 'recRuntimeDetailsSecond';
      source.set(id, { record_id: id, fields: { 负责人: [{ id: member.openId }], 录入运营: [{ id: 'ou_runtime_operator_0001' }],
        微信号: 'fixture-customer', '客户需求（天数/景点/预算等）': 'fixture-needs', 微信状态: '通过', 添加方式: '销售主动加', 日期: date } });
    }
  });
  await f.engine.scan({ apply: true });
  await f.engine.scan({ apply: true });
  const records = member => f.service.table(member.target.appToken, member.target.tableId).records;
  assert.equal([...records(first).values()][0].fields.日期, date);
  assert.equal([...records(first).values()][0].fields.运营名字, '离线录入运营');
  assert.equal([...records(second).values()][0].fields.日期, undefined);
  f.service.bases.get(first.target.appToken).members.set('ou_unapproved_reader_0001', 'view');
  f.service.table(SOURCE, SOURCE_TABLE).records.get('recRuntimeDetailsFirst').fields.日期 = date + 86400000;
  await f.engine.scan({ apply: true });
  assert.equal([...records(first).values()][0].fields.日期, date);
  assert.equal(f.engine.status().mirror.detailWrites, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).mirrors, config.mirrors);
  assert.equal(f.service.messages.length, 0);
});

test('one fake WS routes only exact employee Base/table and recognizes newly ready child target dynamically', async t => {
  const f = await fixture(t); await f.engine.scan({ apply: true }); f.addNewEmployee(); await f.engine.scan({ apply: true });
  let constructed = 0, closed = 0, handler;
  class Dispatcher { register(handlers) { handler = handlers['drive.file.bitable_record_changed_v1']; return this; } }
  class WS { constructor(options) { constructed++; this.options = options; } start() { this.options.onReady(); } async close() { closed++; } }
  const events = new WorkflowEvents(f.engine.config, { sdkLoader: async () => ({ WSClient: WS, EventDispatcher: Dispatcher }), timeoutMs: 100 });
  await events.start(event => f.engine.acceptEvent(event)); t.after(() => events.stop());
  const event = (id, token, table) => ({ header: { event_id: id, event_type: 'drive.file.bitable_record_changed_v1' }, event: { file_token: token, table_id: table, action_list: [{ action: 'record_edited', record_id: 'recRuntimeNewSales' }] } });
  await handler(event('runtime-staff-1', STAFF, STAFF_TABLE));
  await handler(event('runtime-foreign-1', STAFF, 'tblRuntimeOther123'));
  await handler(event('runtime-foreign-2', 'DifferentBase123456', STAFF_TABLE));
  assert.equal(constructed, 1); assert.equal(f.engine.status().staffEventsPending, 1); assert.equal(f.engine.status().eventsPending, 0);
  const member = f.engine.config.members.find(item => item.openId === f.newEmployee.openId);
  assert.equal(events.allows({ appToken: member.target.appToken, tableId: member.target.tableId }), true);
  assert.equal(events.allows({ appToken: member.target.appToken, tableId: 'tblWrongChild123' }), false);
  await events.stop(); assert.equal(closed, 1);
});
for (const switchName of ['enabled', 'notification']) {
  test(`local ${switchName} switch closed before scan prevents all new onboarding effects`, async t => {
    const f = await fixture(t); await f.engine.scan({ apply: true }); f.addNewEmployee(); f.closeConfig(switchName);
    const before = f.service.onboardingMutations().length;
    await assert.rejects(f.engine.scan({ apply: true }), { code: 'LIVE_CONFIG_BINDING_CHANGED' });
    assert.equal(f.service.created, 0); assert.equal(f.service.onboardingMutations().length, before);
  });
}
test('live config closed during new-table source-schema read prevents every later mutation', async t => {
  const f = await fixture(t); await f.engine.scan({ apply: true }); f.addNewEmployee();
  let closedAt = null;
  f.service.hook = async call => {
    if (closedAt === null && f.service.created === 1 && call.endpoint === `/open-apis/bitable/v1/apps/${SOURCE}/tables/${SOURCE_TABLE}/fields`) {
      f.closeConfig(); closedAt = f.service.calls.length;
    }
  };
  await assert.rejects(f.engine.scan({ apply: true }), { code: 'LIVE_CONFIG_BINDING_CHANGED' });
  assert.notEqual(closedAt, null); assert.equal(f.service.created, 1);
  assert.equal(f.service.calls.slice(closedAt).filter(call => call.method !== 'GET').length, 0);
  assert.equal(f.service.messages.length, 0);
});
