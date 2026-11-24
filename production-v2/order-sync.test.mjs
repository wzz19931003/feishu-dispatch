import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { financeOnly } from './order-schema.mjs';
import { SalesOrderSync } from './order-sync.mjs';

const A = 'ou_syntheticSalesA', B = 'ou_syntheticSalesB', manager = 'ou_syntheticManager';
const owner = id => [{ id }];
const names = { 订单编号: 'view', 订单转态: 'edit', 出团日期: 'edit', 儿童数: 'edit', 线路名称: 'edit', 主要联系人: 'edit' };
const types = { 订单编号: 2, 订单转态: 3, 出团日期: 5, 儿童数: 2, 线路名称: 1, 主要联系人: 1, 成交销售: 11 };
const sourceId = 'recExisting001', newId = 'recNewSales001';
const initial = { 订单编号: 31001, 订单转态: '进行中', 出团日期: 1795737600000, 儿童数: 2, 线路名称: '验收路线', 主要联系人: '模拟客户' };

function fixture(t, { disk = false, newOrders = false, createOnly = [] } = {}) {
  const makeIds = (prefix, fields) => Object.fromEntries(fields.map((name, i) => [name, `fld${prefix}Test${i}`]));
  const target = (ownerId, suffix) => ({
    owner: ownerId, documentOwner: manager, administrators: [manager], appToken: `SyntheticSalesBase${suffix}`,
    tableId: `tblPrivateOrder${suffix}`, fieldIds: makeIds(suffix, Object.keys(names)),
  });
  const a = target(A, 'One'), b = target(B, 'Two');
  const config = {
    enabled: true, allowNewOrders: newOrders, requiredForNewOrders: ['线路名称'],
    fields: { ...names, ...Object.fromEntries(createOnly.map(name => [name, 'create'])) }, sales: [a, b],
    master: {
      appToken: 'SyntheticMasterBase', tableId: 'tblMasterOrders',
      fieldIds: makeIds('Master', [...Object.keys(names), '成交销售']),
    },
  };
  const m = config.master, data = new Map(), schema = new Map(), calls = [];
  for (const resource of [m, a, b]) {
    data.set(resource.appToken, new Map());
    schema.set(resource.appToken, Object.entries(resource.fieldIds).map(([field_name, field_id]) => ({
      field_id, field_name, type: types[field_name],
      ...(types[field_name] === 3 ? { property: { options: [{ name: '进行中' }, { name: '已确认' }] } } : {}),
      ...(types[field_name] === 11 ? { property: { multiple: false } } : {}),
    })));
  }
  for (const [i, field_name] of financeOnly.entries()) {
    schema.get(m.appToken).push({ field_name, field_id: `fldFinance${i}`, type: [2, 1, 20, 20, 2, 20, 1, 3, 17][i] });
  }
  const extras = Object.fromEntries(financeOnly.map(name => [name, 'SYNTHETIC_PRIVATE_FINANCE']));
  function rows(resource) { return data.get(resource.appToken); }
  function add(resource, id, values, createdBy = 'service') { rows(resource).set(id, { id, values: structuredClone(values), version: 1, createdBy }); }
  function change(resource, id, values) {
    const row = rows(resource).get(id);
    Object.assign(row.values, structuredClone(values));
    row.version += 1;
  }
  const hooks = {};
  function check(recordGuard, checkOwner) {
    const record = rows(recordGuard.resource).get(recordGuard.id);
    assert.equal(record?.version, recordGuard.version, 'fixture rejected stale before write');
    if (checkOwner) assert.deepEqual(record.values.成交销售, owner(recordGuard.owner), 'fixture rejected stale owner before write');
  }
  const adapter = {
    guardedWrites: true,
    async schema(resource) { return structuredClone(schema.get(resource.appToken)); },
    async targetAcl(resource) {
      return { salesId: resource.owner, documentOwner: manager, salesCanEdit: true, serviceCanManage: true, externalOff: true, linkSharingOff: true,
        managerOnlySharing: true, extraGrants: hooks.extraGrants || 0, unverifiedInheritedGrants: 0,
        salesCanManageAccess: false, salesCanManageSchema: false, salesCanRecoverRevokedRecords: false,
        onlyConfiguredTable: true, administrators: [manager], readOnlyFieldIds: [resource.fieldIds.订单编号, ...createOnly.map(name => resource.fieldIds[name])] };
    },
    async list(resource) { return [...rows(resource).keys()]; },
    async read(resource, id) { return structuredClone(rows(resource).get(id) || null); },
    async createCopy(resource, patch, { token, master }) {
      check(master, true);
      const id = `recPublished${calls.length + 1000}`;
      calls.push(['copyCreate', resource.appToken, id, structuredClone(patch), token]);
      add(resource, id, patch);
      if (hooks.loseCopyCreate) throw new Error('synthetic network result lost');
      return id;
    },
    async createMaster(resource, patch, { token, child }) {
      check(child, false);
      const id = `recNewMaster${calls.length + 1000}`;
      calls.push(['masterCreate', resource.appToken, id, structuredClone(patch), token]);
      add(resource, id, { ...patch, 订单编号: 31099 });
      if (hooks.loseMasterCreate) throw new Error('synthetic network result lost');
      return id;
    },
    async updateMaster(resource, id, patch, guard) {
      hooks.beforeUpdateMaster?.();
      check(guard.master, true);
      check(guard.child, false);
      calls.push(['masterUpdate', resource.appToken, id, structuredClone(patch)]);
      change(resource, id, patch);
    },
    async updateCopy(resource, id, patch, guard) {
      check(guard.master, true);
      check(guard.child, false);
      calls.push(['copyUpdate', resource.appToken, id, structuredClone(patch)]);
      change(resource, id, patch);
    },
    async removeCopy(resource, id, { version }) {
      assert.equal(rows(resource).get(id)?.version, version);
      if (hooks.failRemove) throw new Error('synthetic delete failure');
      calls.push(['copyRemove', resource.appToken, id]);
      rows(resource).delete(id);
    },
  };
  let db, sync;
  const temp = disk ? mkdtempSync(join(tmpdir(), 'sales-order-sync-test-')) : null;
  const start = (configuration = config) => {
    db?.close();
    db = new DatabaseSync(temp ? join(temp, 'synthetic.sqlite') : ':memory:');
    sync = new SalesOrderSync({ config: configuration, db, adapter, approveNewOrder: async () => true });
    return sync;
  };
  t.after(() => {
    db?.close();
    if (temp) {
      for (const name of readdirSync(temp)) unlinkSync(join(temp, name));
      rmdirSync(temp);
    }
  });
  start();
  return { a, b, m, adapter, calls, hooks, schema, config, start, get sync() { return sync; },
    add, change, rows, addExisting: () => add(m, sourceId, { ...initial, ...extras, 成交销售: owner(A) }) };
}

test('publishes an existing order only to the current owner and writes back the approved changes', async t => {
  const f = fixture(t);
  f.addExisting();
  assert.equal((await f.sync.sync()).published, 1);
  assert.equal(f.rows(f.b).size, 0);
  const [id] = f.rows(f.a).keys();
  assert.deepEqual(f.rows(f.a).get(id).values, initial);
  f.change(f.a, id, { 订单编号: 99999, 订单转态: '已确认', 儿童数: 3, 成交销售: owner(B), 毛利: 99 });
  assert.equal((await f.sync.sync()).masterUpdated, 1);
  assert.deepEqual(f.calls.find(([op]) => op === 'masterUpdate')[3], { 儿童数: 3, 订单转态: '已确认' });
  assert.deepEqual(f.rows(f.m).get(sourceId).values.成交销售, owner(A));
  assert.equal(f.rows(f.m).get(sourceId).values.毛利, 'SYNTHETIC_PRIVATE_FINANCE');
  assert.equal(f.rows(f.a).get(id).values.订单编号, initial.订单编号);
  assert.equal(f.rows(f.b).size, 0);
});

test('blocks finance fields for every visibility mode and verifies the exact child schema', async t => {
  const f = fixture(t);
  for (const name of [...financeOnly, '退款', '订单利润率', '销售返佣']) {
    await assert.rejects(async () => f.start({ ...f.config, fields: { ...names, [name]: 'view' } }), { code: 'ORDER_FIELD_POLICY_VIOLATION' });
  }
  f.start();
  f.addExisting();
  f.schema.get(f.a.appToken).push({ field_id: 'fldUnapprovedField', field_name: '私密额外字段', type: 1 });
  await assert.rejects(f.sync.sync(), { code: 'ORDER_TARGET_SCHEMA_NOT_EXCLUSIVE' });
  assert.deepEqual(f.calls, []);
});

test('protects total orders when a salesperson deletes a copy or updates a concurrently edited field', async t => {
  const f = fixture(t);
  f.addExisting();
  await f.sync.sync();
  const [id] = f.rows(f.a).keys();
  f.change(f.m, sourceId, { 线路名称: '总表同时修改' });
  f.change(f.a, id, { 线路名称: '个人表同时修改' });
  assert.equal((await f.sync.sync()).reviews, 1);
  assert.equal(f.sync.status().reviews[0].code, 'ORDER_EDIT_CONFLICT');
  assert.equal(f.calls.length, 1);
  f.rows(f.a).delete(id);
  assert.equal((await f.sync.sync()).reviews, 1);
  assert.equal(f.rows(f.m).get(sourceId).values.线路名称, '总表同时修改');
  assert.equal(f.calls.length, 1);
});

test('revokes the old copy before publishing a reassigned order, including restored stale copies', async t => {
  const f = fixture(t);
  f.addExisting();
  await f.sync.sync();
  const [oldId, old] = f.rows(f.a).entries().next().value;
  f.change(f.a, oldId, { 订单转态: '已确认' });
  f.change(f.m, sourceId, { 成交销售: owner(B) });
  f.hooks.failRemove = true;
  assert.equal((await f.sync.sync()).reviews, 1);
  assert.equal(f.rows(f.b).size, 0);
  f.hooks.failRemove = false;
  await f.sync.sync();
  assert.deepEqual(f.calls.map(([op]) => op), ['copyCreate', 'copyRemove', 'copyCreate']);
  assert.equal(f.rows(f.a).size, 0);
  assert.equal(f.rows(f.b).values().next().value.values.订单转态, '进行中');
  f.rows(f.a).set(oldId, old);
  await f.sync.sync();
  assert.equal(f.rows(f.a).size, 0);
  assert.equal(f.rows(f.b).size, 1);
});

test('does not update an order if its owner changes at the time of guarded write', async t => {
  const f = fixture(t);
  f.addExisting();
  await f.sync.sync();
  f.change(f.a, f.rows(f.a).keys().next().value, { 订单转态: '已确认' });
  f.hooks.beforeUpdateMaster = () => f.change(f.m, sourceId, { 成交销售: owner(B) });
  assert.equal((await f.sync.sync()).reviews, 1);
  assert.equal(f.rows(f.m).get(sourceId).values.订单转态, '进行中');
  assert.equal(f.calls.filter(([op]) => op === 'masterUpdate').length, 0);
});

test('a genuine new order is created once, assigns the configured owner, and copies the total statistical number back', async t => {
  const f = fixture(t, { newOrders: true });
  f.add(f.a, newId, { 线路名称: '验收预约', 儿童数: 1, 成交销售: owner(B), 毛利: 99 }, A);
  assert.equal((await f.sync.sync()).createdInMaster, 1);
  await f.sync.sync();
  await f.sync.sync();
  assert.equal(f.rows(f.m).size, 1);
  assert.equal(f.rows(f.a).size, 1);
  assert.deepEqual(f.calls.map(([op]) => op), ['masterCreate', 'copyUpdate']);
  assert.deepEqual(f.calls[0][3], { 线路名称: '验收预约', 儿童数: 1, 成交销售: owner(A) });
  assert.equal(f.rows(f.a).get(newId).values.订单编号, 31099);
});

test('creation-only fields keep an explicitly entered zero but are read-only after the order exists', async t => {
  const f = fixture(t, { newOrders: true, createOnly: ['儿童数', '线路名称'] });
  f.add(f.a, newId, { 线路名称: '模拟新单', 儿童数: 0, 订单转态: '进行中' }, A);
  assert.equal((await f.sync.sync()).createdInMaster, 1);
  const [masterId] = f.rows(f.m).keys();
  assert.deepEqual(f.calls[0][3], { 线路名称: '模拟新单', 儿童数: 0, 订单转态: '进行中', 成交销售: owner(A) });
  f.change(f.a, newId, { 儿童数: 9, 线路名称: '错误的个人编辑', 订单转态: '已确认' });
  assert.equal((await f.sync.sync()).masterUpdated, 1);
  assert.deepEqual(f.calls.find(([op]) => op === 'masterUpdate')[3], { 订单转态: '已确认' });
  assert.equal(f.rows(f.m).get(masterId).values.儿童数, 0);
  assert.equal(f.rows(f.a).get(newId).values.儿童数, 0);
  assert.equal(f.rows(f.a).get(newId).values.线路名称, '模拟新单');
});

test('parks a create that timed out after the service committed, including after a fresh process', async t => {
  const f = fixture(t, { disk: true, newOrders: true });
  f.add(f.a, newId, { 线路名称: '验收超时' }, A);
  f.hooks.loseMasterCreate = true;
  assert.equal((await f.sync.sync()).reviews, 1);
  f.hooks.loseMasterCreate = false;
  f.start();
  assert.equal((await f.sync.sync()).reviews, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows(f.a).size, 1);
  assert.equal(f.rows(f.m).size, 1);
  assert.equal(f.sync.status().pairs[0].state, 'intent');
});

test('a committed but unacknowledged copy is not copied again or interpreted as a new order', async t => {
  const f = fixture(t, { disk: true, newOrders: true });
  f.addExisting();
  f.hooks.loseCopyCreate = true;
  assert.equal((await f.sync.sync()).reviews, 2);
  f.hooks.loseCopyCreate = false;
  f.start();
  assert.equal((await f.sync.sync()).reviews, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows(f.a).size, 1);
  assert.equal(f.rows(f.m).size, 1);
});

test('requires approved actors, exact permissions, explicit enablement and guarded writes', async t => {
  const f = fixture(t, { newOrders: true });
  f.start({ ...f.config, enabled: false });
  await assert.rejects(f.sync.sync(), { code: 'ORDER_SYNC_DISABLED' });
  f.start();
  f.adapter.guardedWrites = false;
  await assert.rejects(f.sync.sync(), { code: 'ORDER_GUARDED_ADAPTER_REQUIRED' });
  f.adapter.guardedWrites = true;
  f.hooks.extraGrants = 1;
  await assert.rejects(f.sync.sync(), { code: 'ORDER_TARGET_ACCESS_UNVERIFIED' });
  f.hooks.extraGrants = 0;
  f.add(f.a, newId, { 线路名称: '伪造录入人' }, B);
  assert.equal((await f.sync.sync()).reviews, 1);
  assert.equal(f.sync.status().reviews[0].code, 'ORDER_NEW_RECORD_CREATOR_UNVERIFIED');
  assert.equal(f.calls.length, 0);
});

test('with new-order imports off, refuses to turn an unmapped personal record into a master order', async t => {
  const f = fixture(t);
  f.add(f.a, newId, { 线路名称: '原手工数据' }, A);
  assert.equal((await f.sync.sync()).reviews, 1);
  assert.equal(f.sync.status().reviews[0].code, 'ORDER_NEW_RECORD_REVIEW_REQUIRED');
  assert.equal(f.rows(f.m).size, 0);
});

test('stops between records without duplicates and links identical display numbers by source record ID', async t => {
  const f = fixture(t, { disk: true });
  f.addExisting();
  const anotherId = 'recExisting002';
  f.add(f.m, anotherId, { ...initial, 儿童数: 0, 成交销售: owner(A) });
  const originalCreate = f.adapter.createCopy;
  let stop = false;
  f.adapter.createCopy = async (...args) => {
    const id = await originalCreate(...args);
    stop = true;
    return id;
  };
  const first = await f.sync.sync({ shouldStop: () => stop });
  assert.deepEqual([first.published, first.reviews, first.stopped], [1, 0, true]);
  assert.equal(f.rows(f.a).size, 1);
  const second = await f.start().sync();
  assert.deepEqual([second.published, second.reviews], [1, 0]);
  assert.equal(f.calls.filter(([op]) => op === 'copyCreate').length, 2);
  const childId = [...f.rows(f.a)].find(([, row]) => row.values.儿童数 === 0)[0];
  f.change(f.a, childId, { 订单转态: '已确认' });
  assert.equal((await f.sync.sync()).masterUpdated, 1);
  assert.equal(f.rows(f.m).get(anotherId).values.订单转态, '已确认');
  assert.equal(f.rows(f.m).get(sourceId).values.订单转态, initial.订单转态);
});

test('a second scan cannot mutate against an active journal run', async t => {
  const f = fixture(t);
  f.addExisting();
  const first = f.sync.sync();
  await assert.rejects(f.sync.sync(), { code: 'ORDER_SYNC_LOCKED' });
  assert.equal((await first).published, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sync.status().lockedSince, null);
});
