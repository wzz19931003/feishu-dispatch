import assert from 'node:assert/strict';
import test from 'node:test';
import { financeOnly, normalizeConfig, project, resolveSchema } from './order-schema.mjs';
import { FeishuOrderAudit, orderReadinessReport } from './order-feishu-audit.mjs';

const seller = 'ou_exampleSeller', manager = 'ou_exampleManager';
const fields = { 订单编号: 'view', 订单转态: 'edit', 儿童数: 'create' };
const types = { 订单编号: 2, 订单转态: 3, 儿童数: 2, 成交销售: 11 };
const orderValues = { 订单编号: 1, 订单转态: '待支付', 儿童数: 0 };
const currentTime = 1_795_485_600_000;

function fixture() {
  const makeBase = (name, logical) => ({ appToken: `SyntheticBase${name}`, tableId: `tblSynthetic${name}`,
    fieldIds: Object.fromEntries(logical.map((field, index) => [field, `fld${name}${index}`])) });
  const master = makeBase('Master', [...Object.keys(fields), '成交销售']);
  const target = { ...makeBase('Personal', Object.keys(fields)), owner: seller, documentOwner: manager, administrators: [manager] };
  const config = { fields, master, sales: [target] };
  const hooks = {}, calls = [];
  const client = { retryMutations: false, api: async (route, options) => {
    calls.push([route, structuredClone(options)]);
    assert.equal(options.method, route.endsWith('/records/search') ? 'POST' : 'GET');
    const resource = route.includes(master.appToken) ? master : target;
    assert.ok(route.includes(resource.appToken));
    const page = items => ({ items, has_more: false });
    if (route.endsWith('/tables')) return page([{ table_id: target.tableId }, ...(hooks.extraTable ? [{ table_id: 'tblKeepPrivate' }] : [])]);
    if (route.endsWith('/fields')) {
      const schema = Object.entries(resource.fieldIds).map(([name, id]) => ({ field_name: name, field_id: id, type: types[name],
        ...(name === '成交销售' ? { property: { multiple: false } } : {}),
        ...(name === '订单转态' ? { property: { options: [
          { name: '待支付' }, ...(resource === target && hooks.optionDrift ? [{ name: '额外状态' }] : []),
          ...(resource === master ? hooks.masterStatusOptions ?? [] : hooks.targetStatusOptions ?? []),
        ] } } : {}) }));
      return page([...schema, ...(resource === master || hooks.financeTarget ? financeOnly.map((name, index) => ({
        field_name: name, field_id: `fldFinanceData${index}`, type: 1,
      })) : [])]);
    }
    assert.ok(route.endsWith('/records/search'));
    const requested = options.body.field_names;
    assert.deepEqual(new Set(requested), new Set(Object.keys(resource.fieldIds)));
    assert.deepEqual(Object.keys(options.body).sort(), ['automatic_fields', 'field_names']);
    assert.equal(options.body.automatic_fields, true);
    assert.equal(options.query.user_id_type, 'open_id');
    assert.ok(!Object.hasOwn(options.query, 'field_names'));
    const row = (id, childCount) => ({ record_id: id, last_modified_time: hooks.timeMissing ? null : currentTime,
      created_by: { id: seller, email: 'synthetic-private-metadata@example.invalid' },
      fields: { ...orderValues, 儿童数: childCount, ...(resource === master ? { 成交销售: [{ id: seller, name: '模拟销售' }],
        ...(hooks.emptyMasterStatus ? { 订单转态: '' } : {}) } : {}),
        ...(hooks.numericText ? { 订单编号: '123.5', 儿童数: String(childCount) } : {}),
        ...(hooks.invalidNumericText ? { 儿童数: hooks.invalidNumericText } : {}),
        ...(hooks.badProjection ? { 毛利: 'SYNTHETIC_FINANCE_NOT_IN_SCOPE' } : {}) } });
    if (hooks.repeatPage) return { has_more: true, page_token: 'repeated', items: [row('recSynthetic1001', 0)] };
    if (resource === master && !options.query.page_token) return { has_more: true, page_token: 'opaque', items: [row('recSynthetic1001', 0)] };
    return page([row(options.query.page_token ? 'recSynthetic1002' : 'recSynthetic1003', resource === master ? 2 : 0)]);
  } };
  const admin = {
    async getSharing(id) { assert.equal(id, target.appToken); return { externalAccessEntity: 'closed',
      linkShareEntity: hooks.publicSharing ? 'tenant_readable' : 'closed', manageCollaboratorEntity: 'collaborator_full_access' }; },
    async listMembers(id) { assert.equal(id, target.appToken); return [
      { openId: 'cli_syntheticApp', perm: 'full_access', memberType: 'appid', isApp: true },
      { openId: seller, perm: hooks.sellerFullAccess ? 'full_access' : 'edit', memberType: 'openid', isApp: false },
      { openId: manager, perm: 'full_access', memberType: 'openid', isApp: false },
    ]; },
  };
  const verifyEffectiveTarget = async value => ({ appToken: value.appToken, tableId: value.tableId, salesId: seller, documentOwner: manager,
    unverifiedInheritedGrants: hooks.inherited ? 1 : 0, unexpectedRoleMembers: 0, salesCanEditStatus: true,
    salesCanManageAccess: false, salesCanManageSchema: false, salesCanRecoverRevokedRecords: false,
    readOnlyFieldIds: [target.fieldIds.订单编号, target.fieldIds.儿童数] });
  const input = { config, client, admin, verifyEffectiveTarget };
  return { input, master, target, hooks, calls, audit: new FeishuOrderAudit(input) };
}

test('projects the live API request shape for orders, strips people metadata and preserves zero children', async () => {
  const { audit, calls } = fixture();
  const source = await audit.masterSnapshot();
  const target = await audit.salesSnapshot(seller);
  assert.deepEqual(source.map(row => row.values.儿童数), [0, 2]);
  assert.deepEqual(source[0].values.成交销售, [{ id: seller }]);
  assert.equal(target[0].createdBy, seller);
  assert.equal(source[0].version, (await audit.masterSnapshot())[0].version);
  assert.deepEqual(target[0].values, orderValues);
  assert.ok(calls.every(([route, { method }]) => method === (route.endsWith('/records/search') ? 'POST' : 'GET')));
  assert.doesNotMatch(JSON.stringify([...source, ...target]), /模拟销售|private-metadata|毛利/);
});

test('supports verifying the master projection before any seller Base is bound', async () => {
  const { input, calls } = fixture();
  const audit = new FeishuOrderAudit({ config: { ...input.config, sales: [] }, client: input.client });
  assert.equal((await audit.masterSnapshot()).length, 2);
  await assert.rejects(audit.salesSnapshot(seller), { code: 'ORDER_TARGET_UNREGISTERED' });
  assert.equal(calls.every(([route]) => route.includes(input.config.master.appToken)), true);
});

test('normalizes approved numeric text only for the read-only audit and retains zero children', async () => {
  const { audit, input, hooks, calls } = fixture();
  hooks.numericText = true;
  assert.deepEqual((await audit.masterSnapshot()).map(row => row.values.儿童数), [0, 2]);
  assert.deepEqual((await audit.salesSnapshot(seller)).map(row => row.values.订单编号), [123.5]);
  const summary = await orderReadinessReport(input);
  assert.equal(summary.source.childrenRecorded, 2);
  assert.doesNotMatch(JSON.stringify(summary), /123\.5|recSynthetic|ou_example|synthetic-private/);
  assert.throws(() => project({ id: 'recSynthetic1001', values: { 儿童数: '0' } },
    { 儿童数: { type: 2 } }, ['儿童数']), { code: 'ORDER_FIELD_VALUE_INVALID' });
  assert.ok(calls.every(([route, { method }]) => method === (route.endsWith('/records/search') ? 'POST' : 'GET')));
});

test('rejects malformed numeric text, nonfinite values and overflow without echoing the value', async () => {
  const { input, hooks } = fixture();
  for (const value of ['0x10', ' 0', '0\n', '1.', '01', 'NaN', 'Infinity', '1e309', '9007199254740992', '1e-900',
    'SYNTHETIC_PRIVATE_DATA']) {
    hooks.invalidNumericText = value;
    assert.deepEqual(await orderReadinessReport(input), { ok: false, mode: 'read-only', code: 'ORDER_FIELD_VALUE_INVALID' });
  }
});

test('requires actual tables and role proof before reading from a personal order Base', async () => {
  const { audit, input, hooks, calls } = fixture();
  await assert.rejects(audit.salesSnapshot('ou_otherAccount'), { code: 'ORDER_TARGET_UNREGISTERED' });
  const noProof = new FeishuOrderAudit({ ...input, verifyEffectiveTarget: undefined });
  await assert.rejects(noProof.salesSnapshot(seller), { code: 'ORDER_EFFECTIVE_ACCESS_UNPROVEN' });
  for (const hook of ['publicSharing', 'sellerFullAccess', 'extraTable']) {
    hooks[hook] = true;
    await assert.rejects(audit.salesSnapshot(seller), { code: 'ORDER_TARGET_DIRECT_ACCESS_UNSAFE' });
    hooks[hook] = false;
  }
  hooks.inherited = true;
  await assert.rejects(audit.salesSnapshot(seller), { code: 'ORDER_EFFECTIVE_ACCESS_UNPROVEN' });
  assert.equal(calls.some(([route]) => route.endsWith('/records/search')), false);
});

test('fails closed on finance in the child schema or a server response outside the projection', async () => {
  const { audit, hooks } = fixture();
  hooks.financeTarget = true;
  await assert.rejects(audit.salesSnapshot(seller), { code: 'ORDER_TARGET_SCHEMA_NOT_EXCLUSIVE' });
  hooks.financeTarget = false;
  hooks.badProjection = true;
  await assert.rejects(audit.masterSnapshot(), error => error.code === 'ORDER_PROJECTED_RECORD_UNVERIFIED' && !error.message.includes('SYNTHETIC_FINANCE'));
});

test('rejects a repeated cursor and missing platform revision input', async () => {
  const { audit, hooks } = fixture();
  hooks.repeatPage = true;
  await assert.rejects(audit.masterSnapshot(), { code: 'ORDER_AUDIT_CURSOR_INVALID' });
  hooks.repeatPage = false;
  hooks.timeMissing = true;
  await assert.rejects(audit.masterSnapshot(), { code: 'ORDER_PROJECTED_RECORD_UNVERIFIED' });
});

test('returns bounded aggregate counts without disclosing row or account identifiers', async () => {
  const { input, calls } = fixture();
  const result = await orderReadinessReport(input);
  assert.deepEqual(result, { ok: true, mode: 'read-only',
    source: { rows: 2, assigned: 2, unassigned: 0, childrenRecorded: 2, assignedWithoutBoundTarget: 0,
      eligibleForReviewedTarget: 2 },
    targets: { configured: 1, verified: 1, blocked: 0, rows: 1 }, targetIssues: {} });
  assert.doesNotMatch(JSON.stringify(result), /recSynthetic|SyntheticBase|ou_example|待支付/);
  assert.ok(calls.every(([route, { method }]) => method === (route.endsWith('/records/search') ? 'POST' : 'GET')));
});

test('rejects a transport that can replay POST and avoids fallback to an unprojected records read', async () => {
  const { input, calls } = fixture();
  assert.deepEqual(await orderReadinessReport({ ...input, client: { ...input.client, retryMutations: true } }),
    { ok: false, mode: 'read-only', code: 'ORDER_READ_CLIENT_REQUIRED' });
  assert.equal(calls.length, 0);
  const failed = await orderReadinessReport({ ...input, client: { ...input.client, api: async (path, request) => {
    if (path.endsWith('/records/search')) throw new Error('simulated remote error with private context');
    return input.client.api(path, request);
  } } });
  assert.deepEqual(failed, { ok: false, mode: 'read-only', code: 'ORDER_AUDIT_REMOTE_FAILED' });
  assert.ok(calls.every(([route]) => route.endsWith('/fields')));
});

test('treats one explicit master status placeholder as unset only during the read-only audit', async () => {
  const { audit, hooks, input } = fixture();
  hooks.masterStatusOptions = [{ name: '', id: 'optPlaceholder' }];
  hooks.emptyMasterStatus = true;
  assert.deepEqual((await audit.masterSnapshot()).map(row => row.values.订单转态), [null, null]);
  assert.equal((await orderReadinessReport(input)).ok, true);
  const config = normalizeConfig(input.config);
  const fields = await input.client.api(`/open-apis/bitable/v1/apps/${config.master.appToken}/tables/${config.master.tableId}/fields`,
    { method: 'GET' });
  assert.throws(() => resolveSchema(config.master, config.fields, fields.items, { master: true }), { code: 'ORDER_OPTIONS_INVALID' });

  for (const options of [[{ name: '' }, { name: '' }], [{ name: '' }, {}], [{ name: null }], [{ name: 0 }],
    [{ name: '待支付' }]]) {
    hooks.masterStatusOptions = options;
    await assert.rejects(audit.masterSnapshot(), { code: 'ORDER_OPTIONS_INVALID' });
  }
  hooks.masterStatusOptions = [{ name: '' }];
  hooks.targetStatusOptions = [{ name: '' }];
  const blockedTarget = await orderReadinessReport(input);
  assert.deepEqual(blockedTarget.targetIssues, { ORDER_OPTIONS_INVALID: 1 });
});

test('does not fetch personal rows without effective permissions and rejects incomplete scans', async () => {
  const { input, calls, target, hooks } = fixture();
  const blocked = await orderReadinessReport({ ...input, verifyEffectiveTarget: undefined });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.source.eligibleForReviewedTarget, 0);
  assert.deepEqual(blocked.targetIssues, { ORDER_EFFECTIVE_ACCESS_UNPROVEN: 1 });
  assert.equal(calls.some(([route]) => route.includes(target.appToken) && route.endsWith('/records/search')), false);

  hooks.optionDrift = true;
  const drift = await orderReadinessReport(input);
  assert.deepEqual(drift.targetIssues, { ORDER_TARGET_OPTIONS_DRIFT: 1 });
  assert.equal(calls.some(([route]) => route.includes(target.appToken) && route.endsWith('/records/search')), false);

  const limited = await orderReadinessReport({ ...input, pageLimit: 1 });
  assert.deepEqual(limited, { ok: false, mode: 'read-only', code: 'ORDER_AUDIT_PAGE_LIMIT' });

  const before = calls.length;
  assert.deepEqual(await orderReadinessReport({ ...input, targetLimit: 0 }),
    { ok: false, mode: 'read-only', code: 'ORDER_AUDIT_TARGET_LIMIT' });
  assert.equal(calls.length, before);
});
