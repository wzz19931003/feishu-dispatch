import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StaffRoster, resolveStaffSchema } from './staff-roster.mjs';
import { workflowConfig, clone } from './test-fixtures.mjs';
import { validateWorkflowConfig } from './field-map.mjs';

const NAMES = { employee: '员工', role: '岗位', enabled: '启用', order: '派单顺序', notes: '备注', status: '开通状态', personalUrl: '个人表链接', updatedAt: '最近处理时间', error: '问题说明', salesWechat: '销售对外微信', leaveStart: '休假开始', leaveEnd: '休假结束', operatorViewUrl: '本人客资只读入口' };
const TYPES = { employee: 11, role: 3, enabled: 7, order: 2, notes: 1, status: 1, personalUrl: 1, updatedAt: 1, error: 1 };
const EXTRA_TYPES = { salesWechat: 1, leaveStart: 5, leaveEnd: 5, operatorViewUrl: 1 };
const config = ({ enabled = true, extraFields = false, operatorViews = false } = {}) => ({ ...workflowConfig(), enabled, notification: { enabled }, staffManagement: { enabled: true, appToken: 'OfflineStaffBase12345', tableId: 'tblOfflineStaff12345',
  ...(operatorViews ? { operatorViews: { enabled: true } } : {}),
  fields: Object.fromEntries(Object.entries({ ...TYPES, ...(extraFields ? EXTRA_TYPES : {}) }).map(([key, type]) => [key, { fieldId: `fldOfflineStaff${key}`, types: [type], ...(key === 'employee' ? { multiple: false } : {}) }])),
  fixedReaders: ['示例管理员甲', '示例销售乙', '示例销售甲', '示例管理员乙'].map((name, id) => ({ openId: `ou_offlineReader${id}`, displayName: name })), operatorFormUrl: 'https://offline.feishu.cn/share/base/form/shrOfflineForm12345', seedRecordIds: ['recStaffA', 'recStaffB'] } });
const row = (id, patch = {}) => ({ record_id: `recStaff${id}`, fields: Object.fromEntries(Object.entries({ employee: [{ id: `ou_offlineSales${id}`, name: `Offline Sales ${id}` }], role: '销售', enabled: true, order: id === 'A' ? 1 : id === 'B' ? 2 : 3, notes: '', status: '', personalUrl: '', updatedAt: '', error: '', ...patch }).map(([key, value]) => [NAMES[key], value])) });
const target = id => ({ appToken: `OfflineNewTarget${id}12345`, tableId: `tblOfflineNew${id}12345`, baseUrl: `https://offline.feishu.cn/base/OfflineNewTarget${id}12345`, fields: { wx: { fieldId: 'fldOfflineTargetWx', types: [1] }, needs: { fieldId: 'fldOfflineTargetNeeds', types: [1] }, wxStatus: { fieldId: 'fldOfflineTargetStatus', types: [3] } } });

class Client {
  constructor(cfg, rows) {
    this.cfg = cfg; this.rows = new Map(rows.map(value => [value.record_id, clone(value)])); this.writes = []; this.calls = []; this.pageSize = 100;
    this.schema = Object.entries(cfg.staffManagement.fields).map(([key, value]) => ({ field_id: value.fieldId, field_name: NAMES[key], type: TYPES[key] || EXTRA_TYPES[key], ...(key === 'employee' ? { property: { multiple: false } } : {}) }));
  }
  async api(url, options = {}) {
    this.calls.push({ url, method: options.method || 'GET' });
    assert.ok(url.startsWith(`/open-apis/bitable/v1/apps/${this.cfg.staffManagement.appToken}/tables/${this.cfg.staffManagement.tableId}/`));
    if (url.endsWith('/fields')) { await this.beforeSchema?.(); return { items: clone(this.schema), has_more: false }; }
    if (url.endsWith('/records')) {
      await this.beforeList?.();
      if (this.listOverride) return this.listOverride(options);
      const offset = Number(options.query?.page_token || 0), rows = [...this.rows.values()];
      return { items: clone(rows.slice(offset, offset + this.pageSize)), total: rows.length, has_more: rows.length > offset + this.pageSize, ...(rows.length > offset + this.pageSize ? { page_token: String(offset + this.pageSize) } : {}) };
    }
    const id = url.split('/').at(-1);
    if ((options.method || 'GET') === 'GET') {
      await this.beforeRead?.(id);
      if (this.readError) throw this.readError;
      if (!this.rows.has(id)) throw Object.assign(new Error('offline missing'), { code: '1254043' });
      return { record: clone(this.rows.get(id)) };
    }
    assert.equal(options.method, 'PUT');
    this.writes.push({ id, fields: clone(options.body.fields) }); Object.assign(this.rows.get(id).fields, clone(options.body.fields));
    return { record: clone(this.rows.get(id)) };
  }
  change(id, patch) { const value = this.rows.get(`recStaff${id}`); for (const [key, cell] of Object.entries(patch)) value.fields[NAMES[key]] = clone(cell); }
  rename(key, name) { const field = this.schema.find(value => value.field_id === this.cfg.staffManagement.fields[key].fieldId), old = field.field_name; field.field_name = name; for (const record of this.rows.values()) { record.fields[name] = record.fields[old]; delete record.fields[old]; } }
}
function fixture(t, options = {}) {
  const cfg = options.config || config(), db = options.db || new DatabaseSync(':memory:'), client = options.client || new Client(cfg, options.rows || [row('A'), row('B')]);
  const provisioner = { calls: [], async ensure(employee, request) { this.calls.push(clone(employee)); assert.equal(request.apply, true); if (this.hook) return this.hook(employee); return employee.role === 'sales' ? { state: 'ready', target: employee.target || target(employee.recordId.slice(-1)) } : { state: 'ready', url: cfg.staffManagement.operatorFormUrl }; } };
  const roster = new StaffRoster({ config: cfg, db, client, provisioner, assertLiveConfig: options.assertLiveConfig, now: options.now || (() => 100000) });
  t.after(() => { roster.close(); db.close(); }); return { cfg, db, client, provisioner, roster };
}
const byId = (roster, id) => roster.configForMembers().members.find(member => member.id === id);

test('metadata is read-only, follows field IDs, and rejects replacement, incompatible types and multi-person fields', async t => {
  const f = fixture(t); f.client.rename('employee', '改名的员工');
  assert.equal((await resolveStaffSchema(f.client, f.cfg.staffManagement)).employee.name, '改名的员工');
  f.client.schema.find(field => field.type === 11).property.multiple = true;
  await assert.rejects(resolveStaffSchema(f.client, f.cfg.staffManagement), { code: 'STAFF_FIELD_TYPE_CHANGED' });
  f.client.schema.find(field => field.type === 11).property.multiple = false;
  f.client.schema.find(field => field.type === 11).field_id = 'fldOfflineDifferentPerson';
  await assert.rejects(resolveStaffSchema(f.client, f.cfg.staffManagement), { code: 'STAFF_FIELD_ID_NOT_FOUND' });
  assert.ok(f.client.calls.every(call => call.method === 'GET')); assert.equal(f.client.writes.length, 0);
});
test('bootstrap stable IDs and targets survive a preview; provider makes no requests and copies target objects', async t => {
  const f = fixture(t); assert.ok(f.roster.configForMembers().members.every(member => !member.enabled));
  assert.equal((await f.roster.refresh()).ok, true); assert.equal(byId(f.roster, 'sales_A').enabled, true);
  const calls = f.client.calls.length, first = f.roster.configForMembers(); first.members[0].target.baseUrl = 'changed';
  assert.equal(f.roster.configForMembers().members[0].target.baseUrl, f.cfg.members[0].target.baseUrl); assert.equal(f.client.calls.length, calls);
  assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0);
  assert.equal(await f.roster.verifyCandidate(byId(f.roster, 'sales_A')), true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM v2_staff_registry").get().n, 2);
});
test('new members appear only after provisioner ready, and previews never make an onboarding call', async t => {
  const f = fixture(t, { rows: [row('A'), row('B'), row('C')] });
  await f.roster.refresh(); assert.equal(f.roster.configForMembers().members.length, 2); assert.equal(f.provisioner.calls.length, 0);
  await f.roster.refresh({ apply: true }); const member = byId(f.roster, 'staff_recStaffC');
  assert.equal(member.openId, 'ou_offlineSalesC'); assert.equal(member.target.appToken, target('C').appToken); assert.equal(member.enabled, true);
  assert.equal(f.provisioner.calls.filter(item => item.recordId === 'recStaffA')[0].target.appToken, f.cfg.members[0].target.appToken);
  assert.equal(f.provisioner.calls.filter(item => item.recordId === 'recStaffA')[0].seeded, true);
  assert.equal(await f.roster.verifyCandidate(member), true);
});
test('disabled runtime or disabled notifications cannot provision or update system fields', async t => {
  for (const which of ['enabled', 'notification']) {
    const cfg = config(); if (which === 'enabled') cfg.enabled = false; else cfg.notification.enabled = false;
    const f = fixture(t, { config: cfg, rows: [row('A'), row('B'), row('C')] });
    await f.roster.refresh({ apply: true }); assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0); assert.equal(f.roster.configForMembers().members.length, 2);
  }
});
test('a pending or review onboarding isolates that new employee without pinning a partial target', async t => {
  for (const state of ['pending', 'review']) {
    const f = fixture(t, { rows: [row('A'), row('B'), row('C')] });
    f.provisioner.hook = employee => employee.recordId === 'recStaffC' ? { state, errorCode: 'STAFF_PREPARING', nextRetryAt: 120000 } : { state: 'ready', target: employee.target };
    const result = await f.roster.refresh({ apply: true });
    assert.equal(result.ok, false); assert.equal(f.roster.status().healthy, true); assert.equal(byId(f.roster, 'sales_A').enabled, true); assert.equal(f.roster.configForMembers().members.length, 2); assert.equal(result.nextRetryAt, 120000);
    assert.equal(f.roster.registry().some(entry => entry.recordId === 'recStaffC'), false);
    f.provisioner.hook = null; assert.equal((await f.roster.refresh({ apply: true })).ok, true); assert.ok(byId(f.roster, 'staff_recStaffC').enabled);
  }
});
test('incomplete new drafts do not block ready staff; an enabled incomplete row fails the whole snapshot before any side effect', async t => {
  const f = fixture(t, { rows: [row('A'), row('B'), row('Draft', { enabled: false, employee: [], role: '', order: null })] });
  await f.roster.refresh(); assert.equal(f.roster.status().healthy, true); assert.equal(f.roster.status().counts.drafts, 1); assert.equal(byId(f.roster, 'sales_A').enabled, true);
  assert.equal(await f.roster.readCurrent('recStaffDraft'), null);
  f.client.change('Draft', { enabled: true }); const result = await f.roster.refresh({ apply: true });
  assert.equal(result.ok, false); assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0); assert.ok(f.roster.configForMembers().members.every(member => !member.enabled));
});
test('duplicate enabled sales order or identity rejects the complete snapshot without partial publishing', async t => {
  for (const patch of [{ order: 1 }, { employee: [{ id: 'ou_offlineSalesA', name: 'Offline A' }] }]) {
    const f = fixture(t); f.client.change('B', patch); const result = await f.roster.refresh({ apply: true });
    assert.equal(result.ok, false); assert.ok(f.roster.configForMembers().members.every(member => !member.enabled)); assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0);
  }
});
test('all disabled is healthy, while a truly empty table disables new dispatch without losing targets', async t => {
  const f = fixture(t); f.client.change('A', { enabled: false }); f.client.change('B', { enabled: false });
  assert.equal((await f.roster.refresh()).ok, true); assert.equal(f.roster.status().healthy, true); assert.equal(f.roster.status().counts.disabled, 2);
  const original = f.roster.configForMembers().members.map(member => member.target); f.client.rows.clear(); f.client.listOverride = () => ({ total: 0, has_more: false });
  assert.equal((await f.roster.refresh()).errors[0].code, 'STAFF_EMPTY_ROSTER'); assert.equal(f.roster.status().healthy, false); assert.deepEqual(f.roster.configForMembers().members.map(member => member.target), original);
});
test('partial or duplicate pagination is an error, not a smaller employee list', async t => {
  const f = fixture(t); f.client.pageSize = 1; assert.equal((await f.roster.refresh()).ok, true);
  for (const response of [{ total: 2, has_more: false }, { items: [row('A')], has_more: true, page_token: 'same' }]) {
    f.client.listOverride = () => clone(response); assert.equal((await f.roster.refresh()).ok, false); assert.ok(f.roster.configForMembers().members.every(member => !member.enabled));
    assert.equal(f.roster.configForMembers().members.length, 2);
  }
});
test('a deleted registered row retires without removing its target; original row restoration reuses the stable identity', async t => {
  const f = fixture(t); await f.roster.refresh({ apply: true }); const old = clone(byId(f.roster, 'sales_A').target), record = clone(f.client.rows.get('recStaffA'));
  f.client.rows.delete('recStaffA'); await f.roster.refresh({ apply: true });
  assert.equal(byId(f.roster, 'sales_A').enabled, false); assert.deepEqual(byId(f.roster, 'sales_A').target, old); assert.equal(f.roster.configForMembers().members.length, 2);
  assert.ok(f.client.calls.every(call => !['DELETE', 'POST'].includes(call.method)));
  f.client.rows.set('recStaffA', record); await f.roster.refresh({ apply: true }); assert.equal(byId(f.roster, 'sales_A').enabled, true);
});
test('deleted and recreated same person or an edited identity/role cannot silently rebind', async t => {
  for (const change of ['recreate', 'person', 'role']) {
    const f = fixture(t); await f.roster.refresh();
    if (change === 'recreate') { f.client.rows.delete('recStaffA'); f.client.rows.set('recStaffReplacement', { ...row('A'), record_id: 'recStaffReplacement' }); }
    if (change === 'person') f.client.change('A', { employee: [{ id: 'ou_offlineOther', name: 'Offline Other' }] });
    if (change === 'role') f.client.change('A', { role: '运营' });
    assert.equal((await f.roster.refresh({ apply: true })).ok, false); assert.equal(byId(f.roster, 'sales_A').openId, 'ou_offlineSalesA'); assert.equal(byId(f.roster, 'sales_A').enabled, false);
  }
});
test('readonly current versions ignore notes and system links, and user-entered target URLs never rebind', async t => {
  const f = fixture(t); await f.roster.refresh(); const before = await f.roster.readCurrent('recStaffA');
  f.client.change('A', { notes: 'do not execute anything', status: '可用', personalUrl: 'https://untrusted.invalid/private', error: 'fake override', updatedAt: 'future' });
  const after = await f.roster.readCurrent('recStaffA'); assert.equal(before.version, after.version);
  await f.roster.refresh(); assert.equal(byId(f.roster, 'sales_A').target.appToken, f.cfg.members[0].target.appToken);
  f.client.change('A', { order: 9 }); assert.notEqual((await f.roster.readCurrent('recStaffA')).version, before.version);
});
test('candidate verification freshly rejects disable, changed order, deletion and incompatible schema', async t => {
  for (const change of ['disabled', 'order', 'deleted', 'schema']) {
    const f = fixture(t); await f.roster.refresh(); const member = byId(f.roster, 'sales_A');
    if (change === 'disabled') f.client.change('A', { enabled: false });
    if (change === 'order') f.client.change('A', { order: 10 });
    if (change === 'deleted') f.client.rows.delete('recStaffA');
    if (change === 'schema') f.client.schema.find(field => field.type === 7).type = 1;
    if (change === 'schema') await assert.rejects(f.roster.verifyCandidate(member), { code: 'STAFF_FIELD_TYPE_CHANGED' });
    else assert.equal(await f.roster.verifyCandidate(member), false);
    assert.equal(f.client.writes.length, 0);
  }
});
test('metadata changes during the list snapshot fail before interpreting reused old names', async t => {
  const f = fixture(t); let once = false;
  f.client.beforeList = () => { if (!once) { once = true; f.client.rename('employee', '新员工名'); f.client.schema.push({ field_id: 'fldUnrelatedPerson', field_name: '员工', type: 11, property: { multiple: false } }); for (const record of f.client.rows.values()) record.fields.员工 = [{ id: 'ou_offlineOther', name: 'Wrong person' }]; } };
  assert.equal((await f.roster.refresh({ apply: true })).errors[0].code, 'STAFF_SCHEMA_CHANGED_DURING_SCAN');
  assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0); assert.equal(byId(f.roster, 'sales_A').openId, 'ou_offlineSalesA');
});
test('system writes only changed system fields, do not rewrite timestamps on quiet refreshes, and recheck the latest business version', async t => {
  const f = fixture(t); await f.roster.refresh({ apply: true }); const written = f.client.writes.length;
  assert.equal(written, 2); assert.ok(f.client.writes.every(write => Object.keys(write.fields).every(name => ['开通状态', '个人表链接', '最近处理时间', '问题说明'].includes(name))));
  await f.roster.refresh({ apply: true }); assert.equal(f.client.writes.length, written);
  f.client.change('A', { order: 8 }); f.provisioner.hook = employee => { f.client.change('A', { enabled: false }); return { state: 'ready', target: employee.target }; };
  assert.equal((await f.roster.refresh({ apply: true })).errors[0].code, 'STAFF_SNAPSHOT_CHANGED'); assert.equal(f.client.writes.length, written); assert.equal(f.roster.status().healthy, false);
});
test('a provisioner cannot replace an established target, and a new duplicate target is rejected before publishing', async t => {
  const f = fixture(t); f.provisioner.hook = () => ({ state: 'ready', target: target('Other') });
  assert.equal((await f.roster.refresh({ apply: true })).errors[0].code, 'STAFF_MEMBER_BINDING_CHANGED'); assert.equal(byId(f.roster, 'sales_A').target.appToken, f.cfg.members[0].target.appToken);
  const g = fixture(t, { rows: [row('A'), row('B'), row('C')] }); g.provisioner.hook = employee => ({ state: 'ready', target: employee.target || g.cfg.members[0].target });
  assert.equal((await g.roster.refresh({ apply: true })).errors[0].code, 'STAFF_TARGET_DUPLICATE'); assert.equal(g.roster.configForMembers().members.length, 2);
});
test('network or bad registered inactive rows disable new dispatch and never expose raw errors', async t => {
  const f = fixture(t); await f.roster.refresh(); f.client.beforeList = () => { throw new Error('offline secret and customer data must not escape'); };
  assert.equal((await f.roster.refresh()).errors[0].code, 'STAFF_REMOTE_FAILED'); assert.ok(f.roster.configForMembers().members.every(member => !member.enabled));
  assert.equal(JSON.stringify(f.roster.status()).includes('secret'), false);
  f.client.beforeList = null; f.client.change('A', { enabled: false, employee: [] });
  assert.equal((await f.roster.refresh()).errors[0].code, 'STAFF_PERSON_INVALID');
});
test('only explicit record-not-found is null; table/access failures remain errors, and close never closes the engine DB', async t => {
  const f = fixture(t); assert.equal(await f.roster.readCurrent('recStaffMissing'), null);
  f.client.readError = Object.assign(new Error('offline not a record deletion'), { code: '1254044' }); await assert.rejects(f.roster.readCurrent('recStaffA'), { code: 'STAFF_REMOTE_FAILED' });
  f.roster.close(); assert.equal(f.db.prepare('SELECT 1 n').get().n, 1);
});
test('stop prevents provisioning and system mutation; operators never enter the sales pool', async t => {
  const f = fixture(t, { rows: [row('A'), row('B'), row('Operator', { role: '运营', order: null })] });
  assert.equal((await f.roster.refresh({ apply: true, shouldStop: () => true })).errors[0].code, 'STAFF_STOP_REQUESTED'); assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0);
  await f.roster.refresh({ apply: true }); assert.equal(f.roster.configForMembers().members.length, 2); assert.equal(f.roster.registry().find(entry => entry.role === 'operator').target, null);
});
test('existing engine history tables and historical member pins are preserved and restart begins fail-closed', async t => {
  const db = new DatabaseSync(':memory:'), cfg = config(); db.exec('CREATE TABLE v2_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE v2_mirrors(data TEXT); CREATE TABLE v2_outbox(data TEXT);');
  db.prepare('INSERT INTO v2_outbox VALUES(?)').run('{"state":"sent","id":"offline-preserved"}');
  const historical = { id: 'sales_History', openId: 'ou_offlineHistorical', target: target('History') };
  db.prepare('INSERT INTO v2_meta VALUES(?,?)').run('member_pins', JSON.stringify({ [historical.id]: historical }));
  db.prepare('INSERT INTO v2_mirrors VALUES(?)').run(JSON.stringify({ memberId: historical.id, owner: historical.openId, baseValues: { salesName: 'Offline Historical Sales' } }));
  const f = fixture(t, { db, config: cfg }); await f.roster.refresh();
  assert.equal(byId(f.roster, historical.id).enabled, false); assert.equal(byId(f.roster, historical.id).displayName, 'Offline Historical Sales'); assert.equal(byId(f.roster, historical.id).target.appToken, historical.target.appToken);
  const again = new StaffRoster({ config: cfg, db, client: f.client, provisioner: f.provisioner }); assert.ok(again.configForMembers().members.every(member => !member.enabled));
  assert.equal(db.prepare('SELECT data FROM v2_outbox').get().data, '{"state":"sent","id":"offline-preserved"}');
  const different = clone(cfg); different.staffManagement.tableId = 'tblOfflineDifferent123'; assert.throws(() => new StaffRoster({ config: different, db, client: f.client }), { code: 'STAFF_DATABASE_BINDING_MISMATCH' });
  assert.equal(db.prepare('SELECT 1 n').get().n, 1);
});
test('an onboarding adapter exception holds only its employee and keeps established targets ready', async t => {
  const f = fixture(t, { rows: [row('A'), row('B'), row('C')] });
  f.provisioner.hook = employee => { if (employee.recordId === 'recStaffC') throw new Error('offline private response'); return { state: 'ready', target: employee.target }; };
  const result = await f.roster.refresh({ apply: true });
  assert.equal(result.ok, false); assert.equal(f.roster.status().healthy, true); assert.equal(f.roster.status().counts.review, 1);
  assert.equal(byId(f.roster, 'sales_A').enabled, true); assert.equal(byId(f.roster, 'sales_B').enabled, true); assert.equal(f.roster.configForMembers().members.length, 2);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('candidate validation uses a bounded record read, follows rename and never lists the full employee table', async t => {
  const f = fixture(t); await f.roster.refresh(); f.client.rename('employee', '改名员工'); const member = byId(f.roster, 'sales_A');
  const before = f.client.calls.length; assert.equal(await f.roster.verifyCandidate(member), true);
  const calls = f.client.calls.slice(before); assert.equal(calls.length, 3); assert.equal(calls.filter(call => call.url.endsWith('/records')).length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/records/recStaffA')).length, 1);
});
test('optional notes metadata can be omitted and system-only edits do not trigger another onboarding job', async t => {
  const cfg = config(); delete cfg.staffManagement.fields.notes;
  const f = fixture(t, { config: cfg }); await f.roster.refresh({ apply: true }); const calls = f.provisioner.calls.length;
  f.client.change('A', { status: 'untrusted override', notes: 'untrusted command' }); await f.roster.refresh({ apply: true });
  assert.equal(f.provisioner.calls.length, calls); assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '可用');
});
test('an employee disabled just before the final system write is not overwritten with ready status', async t => {
  const f = fixture(t); let afterEnsure = false;
  f.provisioner.hook = employee => {
    if (employee.recordId === 'recStaffA') {
      let reads = 0; afterEnsure = true;
      f.client.beforeRead = id => { if (id === 'recStaffA' && ++reads === 2) f.client.change('A', { enabled: false }); };
    }
    return { state: 'ready', target: employee.target };
  };
  assert.equal((await f.roster.refresh({ apply: true })).errors[0].code, 'STAFF_SNAPSHOT_CHANGED');
  assert.equal(afterEnsure, true); assert.equal(f.client.writes.length, 0); assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '');
  assert.ok(f.roster.configForMembers().members.every(member => !member.enabled));
});
test('an optional live configuration guard rejects changed local switches before provisioning or any request', async t => {
  let live = true, checks = 0;
  const f = fixture(t, { rows: [row('A'), row('B'), row('C')], assertLiveConfig: async () => { checks++; if (!live) throw Object.assign(new Error('offline local secret must not escape'), { code: 'LIVE_CONFIG_BINDING_CHANGED' }); } });
  await f.roster.refresh(); assert.equal(checks, 0); const calls = f.client.calls.length;
  live = false; const result = await f.roster.refresh({ apply: true });
  assert.equal(result.errors[0].code, 'STAFF_LIVE_CONFIG_CHANGED'); assert.equal(checks, 1); assert.equal(f.client.calls.length, calls);
  assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0); assert.ok(f.roster.configForMembers().members.every(member => !member.enabled));
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('live switches changed after preparation stop the imminent system PUT', async t => {
  let live = true, checks = 0;
  const f = fixture(t, { assertLiveConfig: async () => { checks++; if (!live) throw new Error('offline configuration disabled'); } });
  f.provisioner.hook = employee => { live = false; return { state: 'ready', target: employee.target }; };
  const result = await f.roster.refresh({ apply: true });
  assert.equal(result.errors[0].code, 'STAFF_LIVE_CONFIG_CHANGED'); assert.equal(checks, 2); assert.equal(f.client.writes.length, 0); assert.equal(f.roster.status().healthy, false);
});
test('a stop arriving during the last live configuration await prevents the system PUT', async t => {
  let stopping = false, checks = 0;
  const f = fixture(t, { assertLiveConfig: async () => { if (++checks === 2) stopping = true; } });
  const result = await f.roster.refresh({ apply: true, shouldStop: () => stopping });
  assert.equal(result.errors[0].code, 'STAFF_STOP_REQUESTED'); assert.equal(f.client.writes.length, 0);
});
test('decimal strings from numeric fields normalize identically in lists, current records and candidate versions', async t => {
  const operator = row('Operator', { role: '运营' }); delete operator.fields[NAMES.order];
  const f = fixture(t, { rows: [row('A', { order: '1' }), row('B', { order: '2' }), operator] });
  assert.equal((await f.roster.refresh()).ok, true);
  assert.deepEqual(f.roster.configForMembers().members.map(member => member.order), [1, 2]);
  const current = await f.roster.readCurrent('recStaffA'); assert.equal(current.order, 1); assert.equal(typeof current.order, 'number');
  assert.equal((await f.roster.readCurrent('recStaffOperator')).order, null);
  f.client.change('A', { order: 1 }); assert.equal((await f.roster.readCurrent('recStaffA')).version, current.version);
  assert.equal(await f.roster.verifyCandidate(byId(f.roster, 'sales_A')), true);
  f.client.change('A', { order: '0001' }); assert.equal((await f.roster.readCurrent('recStaffA')).version, current.version);
  assert.equal(await f.roster.verifyCandidate(byId(f.roster, 'sales_A')), true);
});
test('numeric and decimal string representations of the same enabled order collide before side effects', async t => {
  for (const order of ['1', '0001']) {
    const f = fixture(t, { rows: [row('A', { order: 1 }), row('B', { order })] });
    assert.equal((await f.roster.refresh({ apply: true })).errors[0].code, 'STAFF_ORDER_DUPLICATE');
    assert.equal(f.provisioner.calls.length, 0); assert.equal(f.client.writes.length, 0);
  }
});
test('order normalization accepts safe positive decimal integers and rejects coercion, fractions, overflow and whitespace', async t => {
  const f = fixture(t); f.client.change('A', { order: String(Number.MAX_SAFE_INTEGER) });
  assert.equal((await f.roster.readCurrent('recStaffA')).order, Number.MAX_SAFE_INTEGER);
  for (const order of ['', ' ', '\t1', '1 ', '0', 0, -1, '-1', '+1', '1.0', '1.5', 1.5, '1e2', '0x10', 'Infinity', Infinity, NaN, '9007199254740992', Number.MAX_SAFE_INTEGER + 1, true, ['1'], { value: 1 }]) {
    f.client.change('A', { order });
    await assert.rejects(f.roster.readCurrent('recStaffA'), { code: 'STAFF_ORDER_INVALID' });
  }
});

test('sales contact is read by stable field ID and remains available for paused and manually disabled sales', async t => {
  const f = fixture(t, { config: config({ extraFields: true }), rows: [row('A', { salesWechat: '  offline-public-wechat  ' }), row('B')] });
  await f.roster.refresh({ apply: true });
  const version = (await f.roster.readCurrent('recStaffA')).version;
  f.client.rename('salesWechat', '改名的对外微信');
  f.client.rows.get('recStaffA').fields.改名的对外微信 = 'offline-updated-contact';
  f.client.change('A', { enabled: false }); await f.roster.refresh({ apply: true });
  assert.equal(byId(f.roster, 'sales_A').salesWechat, 'offline-updated-contact');
  assert.equal(byId(f.roster, 'sales_A').enabled, false);
  const disabled = f.roster.registry().find(entry => entry.id === 'sales_A');
  assert.equal(disabled.ready, true); assert.equal(disabled.state, 'disabled'); assert.equal(disabled.retired, false);
  assert.deepEqual(disabled.target, f.cfg.members[0].target);
  f.client.change('A', { enabled: true });
  assert.equal((await f.roster.readCurrent('recStaffA')).version, version);
  const old = fixture(t); await old.roster.refresh(); assert.equal(byId(old.roster, 'sales_A').salesWechat, '');
});

test('Shanghai inclusive leave dates pause at local midnight and automatically resume after the final day', async t => {
  let tick = Date.parse('2026-11-18T15:59:59.999Z');
  const f = fixture(t, { config: config({ extraFields: true }), now: () => tick,
    rows: [row('A', { salesWechat: 'offline-public', leaveStart: '2026-11-19', leaveEnd: '2026-11-19' }), row('B')] });
  const originalTarget = clone(f.cfg.members[0].target);
  await f.roster.refresh({ apply: true }); const before = byId(f.roster, 'sales_A');
  assert.equal(before.enabled, true); assert.equal(f.roster.status().nextRetryAt, Date.parse('2026-11-18T16:00:00Z'));
  tick++; assert.equal(byId(f.roster, 'sales_A').enabled, false);
  assert.equal(await f.roster.verifyCandidate(before), false);
  await f.roster.refresh({ apply: true });
  assert.equal(f.roster.status().counts.paused, 1); assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '休假中');
  assert.equal(f.roster.status().nextRetryAt, Date.parse('2026-11-19T16:00:00Z'));
  assert.equal(byId(f.roster, 'sales_A').salesWechat, 'offline-public');
  tick = Date.parse('2026-11-19T15:59:59.999Z'); assert.equal(byId(f.roster, 'sales_A').enabled, false);
  tick++; assert.equal(byId(f.roster, 'sales_A').enabled, true);
  await f.roster.refresh({ apply: true });
  assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '可用');
  assert.deepEqual(byId(f.roster, 'sales_A').target, originalTarget);
});

test('manual disable takes precedence after leave ends and a new employee on leave is not provisioned', async t => {
  let tick = Date.parse('2026-11-19T04:00:00Z');
  const f = fixture(t, { config: config({ extraFields: true }), now: () => tick,
    rows: [row('A', { enabled: false, leaveStart: '2026-11-19', leaveEnd: '2026-11-19' }), row('B'), row('C', { leaveStart: '2026-11-19', leaveEnd: '2026-11-19' })] });
  await f.roster.refresh({ apply: true });
  assert.equal(byId(f.roster, 'sales_A').enabled, false); assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '已停新单');
  assert.equal(f.provisioner.calls.some(employee => employee.recordId === 'recStaffC'), false);
  assert.equal(byId(f.roster, 'staff_recStaffC'), undefined);
  tick = Date.parse('2026-11-19T16:00:00Z'); await f.roster.refresh({ apply: true });
  assert.equal(byId(f.roster, 'sales_A').enabled, false); assert.equal(byId(f.roster, 'staff_recStaffC').enabled, true);
  assert.equal(f.provisioner.calls.filter(employee => employee.recordId === 'recStaffC').length, 1);
});

test('date-typed millisecond values and decimal strings normalize to Shanghai calendar days without rebinding onboarding versions', async t => {
  const f = fixture(t, { config: config({ extraFields: true }) });
  const original = await f.roster.readCurrent('recStaffA');
  const start = Date.parse('2026-11-18T16:00:00Z'), end = Date.parse('2026-11-19T16:00:00Z');
  f.client.change('A', { leaveStart: start, leaveEnd: String(end), salesWechat: 'offline-updated' });
  const updated = await f.roster.readCurrent('recStaffA');
  assert.equal(updated.leaveStart, '2026-11-19'); assert.equal(updated.leaveEnd, '2026-11-20');
  assert.equal(updated.version, original.version); assert.notEqual(updated.profileVersion, original.profileVersion);
  f.client.change('A', { leaveStart: '2026-11-19', leaveEnd: '2026-11-20' });
  assert.equal((await f.roster.readCurrent('recStaffA')).profileVersion, updated.profileVersion);
});

test('malformed or incomplete leave dates hold only that employee and preserve other eligible sales', async t => {
  const f = fixture(t, { config: config({ extraFields: true }), now: () => Date.parse('2026-11-19T04:00:00Z') });
  await f.roster.refresh({ apply: true }); const targetBefore = clone(byId(f.roster, 'sales_A').target);
  const cases = [
    { leaveStart: '2026-11-19', leaveEnd: '' }, { leaveStart: '', leaveEnd: '2026-11-19' },
    { leaveStart: '2026-11-20', leaveEnd: '2026-11-19' }, { leaveStart: '2026-02-30', leaveEnd: '2026-11-19' },
    { leaveStart: 'private-invalid-value', leaveEnd: '2026-11-19' }, { leaveStart: true, leaveEnd: '2026-11-19' },
    { leaveStart: {}, leaveEnd: '2026-11-19' }, { leaveStart: Infinity, leaveEnd: '2026-11-19' },
  ];
  for (const patch of cases) {
    f.client.change('A', patch); const result = await f.roster.refresh({ apply: true });
    assert.equal(result.ok, false); assert.equal(f.roster.status().healthy, true);
    assert.equal(f.roster.status().counts.review, 1); assert.equal(byId(f.roster, 'sales_A').enabled, false);
    assert.equal(byId(f.roster, 'sales_B').enabled, true); assert.deepEqual(byId(f.roster, 'sales_A').target, targetBefore);
    assert.equal(f.client.rows.get('recStaffA').fields.问题说明, 'STAFF_LEAVE_RANGE_INVALID');
    assert.equal(JSON.stringify(result).includes('private-invalid-value'), false);
  }
  f.client.change('A', { leaveStart: '', leaveEnd: '' }); assert.equal((await f.roster.refresh({ apply: true })).ok, true);
  assert.equal(byId(f.roster, 'sales_A').enabled, true);
});

test('new optional bindings append without changing the legacy binding or any existing target and history', async t => {
  const f = fixture(t); await f.roster.refresh(); const original = f.roster.meta('binding');
  f.db.exec('CREATE TABLE offline_history(value TEXT); INSERT INTO offline_history VALUES(\'keep-existing-delivery\');');
  const upgraded = config({ extraFields: true }), client = new Client(upgraded, [row('A'), row('B')]);
  const roster = new StaffRoster({ config: upgraded, db: f.db, client });
  assert.equal(roster.meta('binding'), original); await roster.refresh();
  assert.deepEqual(byId(roster, 'sales_A').target, f.cfg.members[0].target);
  assert.equal(f.db.prepare('SELECT value FROM offline_history').get().value, 'keep-existing-delivery');
  const changed = clone(upgraded); changed.staffManagement.fields.salesWechat.fieldId = 'fldOfflineReboundContact';
  assert.throws(() => new StaffRoster({ config: changed, db: f.db, client }), { code: 'STAFF_OPTIONAL_FIELD_BINDING_CHANGED' });
  const removed = clone(upgraded); delete removed.staffManagement.fields.leaveStart;
  assert.throws(() => new StaffRoster({ config: removed, db: f.db, client }), { code: 'STAFF_OPTIONAL_FIELD_BINDING_CHANGED' });
});

test('operator candidates use validated local registry and URL results write only the dedicated output field', async t => {
  const f = fixture(t, { config: config({ extraFields: true, operatorViews: true }),
    rows: [row('A'), row('B'), row('Operator', { role: '运营', order: null })] });
  await f.roster.refresh({ apply: true }); const reads = f.client.calls.length;
  const operators = f.roster.operatorCandidates(); assert.equal(operators.length, 1); assert.equal(f.client.calls.length, reads);
  const operator = operators[0], previousForm = f.client.rows.get(operator.recordId).fields.个人表链接;
  f.client.writes.length = 0;
  const url = 'https://offline.feishu.cn/base/OfflineOperatorView12345?table=tblOfflineOperator123';
  assert.deepEqual(await f.roster.recordOperatorViewUrls([{ ...operator, url }]), { updated: 1, skipped: 0, errors: [] });
  assert.equal(f.client.rows.get(operator.recordId).fields.本人客资只读入口, url);
  assert.equal(f.client.rows.get(operator.recordId).fields.个人表链接, previousForm);
  assert.deepEqual(Object.keys(f.client.writes[0].fields).sort(), ['最近处理时间', '本人客资只读入口'].sort());
  assert.equal((await f.roster.recordOperatorViewUrls([{ ...operator, url }])).updated, 0);
  f.client.change('Operator', { enabled: false });
  assert.equal((await f.roster.recordOperatorViewUrls([{ ...operator, url: `${url}Changed` }])).updated, 0);
  assert.equal((await f.roster.recordOperatorViewUrls([{ ...operator, url: 'https://outside.invalid/base/OfflineOperatorView12345' }])).errors[0].code, 'STAFF_OPERATOR_URL_INVALID');
});

test('an operator disabled during the final URL recheck cannot receive a stale entry result', async t => {
  const f = fixture(t, { config: config({ extraFields: true, operatorViews: true }), rows: [row('A'), row('B'), row('Operator', { role: '运营' })] });
  await f.roster.refresh({ apply: true }); const operator = f.roster.operatorCandidates()[0]; f.client.writes.length = 0;
  let reads = 0;
  f.client.beforeRead = id => { if (id === operator.recordId && ++reads === 2) f.client.change('Operator', { enabled: false }); };
  const result = await f.roster.recordOperatorViewUrls([{ ...operator, url: 'https://offline.feishu.cn/base/OfflineOperatorView12345' }]);
  assert.equal(result.errors[0].code, 'STAFF_SNAPSHOT_CHANGED'); assert.equal(f.client.writes.length, 0);
});

test('invalid external sales contact holds only its notice profile while every otherwise eligible sale remains dispatchable', async t => {
  const f = fixture(t, { config: config({ extraFields: true }), rows: [row('A', { salesWechat: 'valid_public_contact' }), row('B')] });
  await f.roster.refresh({ apply: true });
  for (const salesWechat of ['x'.repeat(81), 'invalid\ncontact', 'invalid\u0000contact']) {
    f.client.change('A', { salesWechat }); const result = await f.roster.refresh({ apply: true });
    assert.equal(result.ok, false); assert.equal(f.roster.status().healthy, true);
    assert.equal(result.errors[0].code, 'STAFF_SALES_WECHAT_INVALID');
    assert.equal(byId(f.roster, 'sales_A').salesWechat, '');
    assert.equal(byId(f.roster, 'sales_A').enabled, true); assert.equal(byId(f.roster, 'sales_B').enabled, true);
    assert.equal(await f.roster.verifyCandidate(byId(f.roster, 'sales_A')), true);
    assert.doesNotThrow(() => validateWorkflowConfig(f.roster.configForMembers()));
    assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '需核查');
    assert.equal(f.client.rows.get('recStaffA').fields.问题说明, 'STAFF_SALES_WECHAT_INVALID');
  }
  f.client.change('A', { salesWechat: 'corrected_public_contact' });
  assert.equal((await f.roster.refresh({ apply: true })).ok, true);
  assert.equal(byId(f.roster, 'sales_A').salesWechat, 'corrected_public_contact');
  assert.equal(f.client.rows.get('recStaffA').fields.开通状态, '可用');
});
