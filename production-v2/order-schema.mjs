const policy = {
  订单编号: { type: 2, writable: false },
  订单转态: { type: 3, writable: true },
  发单时间: { type: 5, writable: true },
  出团日期: { type: 5, writable: true },
  行程天数: { type: 1, writable: true },
  订单类型: { type: 3, writable: true },
  总人数: { type: 2, writable: true },
  成人数: { type: 2, writable: true },
  儿童数: { type: 2, writable: true },
  线路名称: { type: 1, writable: true },
  主要联系人: { type: 1, writable: true },
  联系电话: { type: 2, writable: true },
  卖价: { type: 2, writable: false },
  已支付订金: { type: 2, writable: false },
  引流运营: { type: 3, writable: false },
};

export const financeOnly = Object.freeze([
  '地接成本', '成本明细', '毛利', '人均毛利', '实返佣金额', '预计返佣日', '实际返佣日', '返款状态', '返款凭证',
]);

export class OrderSyncError extends Error {
  constructor(code) {
    super(`订单同步未完成（${code}）`);
    this.name = 'OrderSyncError';
    this.code = code;
  }
}

export function fail(code) { throw new OrderSyncError(code); }

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const personId = value => typeof value === 'string' && /^ou_[\w-]{6,}$/.test(value);
export const recordId = value => typeof value === 'string' && /^rec[A-Za-z0-9]{5,}$/.test(value);
const fieldId = value => typeof value === 'string' && /^fld[A-Za-z0-9]{5,}$/.test(value);

function base(resource) {
  if (!object(resource) || !/^[A-Za-z0-9]{10,}$/.test(resource.appToken ?? '') ||
      !/^tbl[A-Za-z0-9]{5,}$/.test(resource.tableId ?? '')) fail('ORDER_RESOURCE_INVALID');
  return { appToken: resource.appToken, tableId: resource.tableId };
}

function bindings(input, names) {
  if (!object(input) || Object.keys(input).length !== names.length ||
      names.some(name => !Object.hasOwn(input, name) || !fieldId(input[name])) ||
      new Set(Object.values(input)).size !== names.length) fail('ORDER_FIELD_BINDINGS_INVALID');
  return Object.fromEntries(names.map(name => [name, input[name]]));
}

export function normalizeConfig(input, { allowNoSales = false } = {}) {
  if (!object(input) || !object(input.master) || !object(input.fields) ||
      !Array.isArray(input.sales) || !allowNoSales && !input.sales.length) fail('ORDER_CONFIG_INVALID');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('ORDER_CONFIG_INVALID');
  if (input.allowNewOrders !== undefined && typeof input.allowNewOrders !== 'boolean') fail('ORDER_CONFIG_INVALID');
  const names = Object.keys(input.fields).sort();
  if (!names.includes('订单编号') || !names.includes('儿童数') || input.fields.订单转态 !== 'edit') fail('ORDER_FIELDS_REQUIRED');
  const fields = Object.fromEntries(names.map(name => {
    const mode = input.fields[name];
    const spec = Object.hasOwn(policy, name) ? policy[name] : null;
    if (!spec || !['view', 'create', 'edit'].includes(mode) || (mode !== 'view' && !spec.writable)) fail('ORDER_FIELD_POLICY_VIOLATION');
    return [name, { type: spec.type, writable: mode === 'edit', ...(mode === 'create' ? { createOnly: true } : {}) }];
  }));
  const master = { ...base(input.master), fieldIds: bindings(input.master.fieldIds, [...names, '成交销售']) };
  const owners = new Set(), tokens = new Set([master.appToken]);
  const sales = input.sales.map(target => {
    const resource = base(target);
    if (!personId(target.owner) || owners.has(target.owner) || tokens.has(resource.appToken)) fail('ORDER_SALES_RESOURCE_COLLISION');
    if (!personId(target.documentOwner) || !Array.isArray(target.administrators) || target.administrators.some(id => !personId(id) || id === target.owner) ||
        !target.administrators.includes(target.documentOwner) ||
        new Set(target.administrators).size !== target.administrators.length) fail('ORDER_ADMIN_ALLOWLIST_INVALID');
    const fieldIds = bindings(target.fieldIds, names);
    if (target.emptyPrimary !== undefined && (!fieldId(target.emptyPrimary) || Object.values(fieldIds).includes(target.emptyPrimary))) {
      fail('ORDER_PRIMARY_FIELD_INVALID');
    }
    owners.add(target.owner);
    tokens.add(resource.appToken);
    return { ...resource, owner: target.owner, documentOwner: target.documentOwner, fieldIds,
      emptyPrimary: target.emptyPrimary ?? null, administrators: [...target.administrators].sort() };
  });
  const required = input.requiredForNewOrders ?? [];
  if (!Array.isArray(required) || new Set(required).size !== required.length || required.some(name => !creationField(fields[name])) ||
      (input.allowNewOrders === true && !required.length)) fail('ORDER_REQUIRED_FIELDS_INVALID');
  return { enabled: input.enabled === true, allowNewOrders: input.allowNewOrders === true, master, fields, sales, required: [...required] };
}

export const creationField = field => field?.writable === true || field?.createOnly === true;

export function resolveSchema(resource, fields, schema, { master = false } = {}) {
  if (!Array.isArray(schema) || schema.some(field => !object(field) || !fieldId(field.field_id) || typeof field.field_name !== 'string') ||
      new Set(schema.map(field => field.field_id)).size !== schema.length || new Set(schema.map(field => field.field_name)).size !== schema.length) {
    fail('ORDER_SCHEMA_INVALID');
  }
  const byId = new Map(schema.map(field => [field.field_id, field]));
  if (!master) {
    const allowed = new Set([...Object.values(resource.fieldIds), ...(resource.emptyPrimary ? [resource.emptyPrimary] : [])]);
    if (schema.some(field => !allowed.has(field.field_id) || financeOnly.includes(field.field_name.trim()))) fail('ORDER_TARGET_SCHEMA_NOT_EXCLUSIVE');
    if (resource.emptyPrimary) {
      const primary = byId.get(resource.emptyPrimary);
      if (primary?.type !== 1 || primary.is_primary !== true || primary.field_name !== '文本') fail('ORDER_PRIMARY_FIELD_INVALID');
    }
  }
  return Object.fromEntries(Object.entries(resource.fieldIds).map(([name, id]) => {
    const field = byId.get(id);
    const expectedType = name === '成交销售' ? 11 : fields[name]?.type;
    if (!field || field.field_name !== name || field.type !== expectedType) fail('ORDER_FIELD_DRIFT');
    if (expectedType === 11 && field.property?.multiple !== false) fail('ORDER_OWNER_FIELD_NOT_SINGLE');
    let options = [];
    if (expectedType === 3) {
      if (!Array.isArray(field.property?.options) || field.property.options.some(item => !item?.name || typeof item.name !== 'string')) fail('ORDER_OPTIONS_INVALID');
      options = field.property.options.map(item => item.name).sort();
      if (new Set(options).size !== options.length) fail('ORDER_OPTIONS_INVALID');
    }
    return [name, { type: expectedType, options }];
  }));
}

function text(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(segment => segment?.type !== 'text' || typeof segment.text !== 'string')) fail('ORDER_TEXT_INVALID');
  return value.map(segment => segment.text).join('');
}

export function project(record, schema, names) {
  if (!recordId(record?.id) || !object(record.values)) fail('ORDER_RECORD_INVALID');
  return Object.fromEntries(names.map(name => {
    const value = Object.hasOwn(record.values, name) ? record.values[name] : null;
    if (value === undefined || value === null || value === '') return [name, null];
    const { type, options } = schema[name];
    if (type === 1) return [name, text(value) || null];
    if (type === 2 && Number.isFinite(value)) return [name, value];
    if (type === 3 && typeof value === 'string' && options.includes(value)) return [name, value];
    if (type === 5 && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) return [name, value];
    fail('ORDER_FIELD_VALUE_INVALID');
  }));
}

export function ownerOf(record) {
  if (!recordId(record?.id) || !object(record.values)) fail('ORDER_MASTER_RECORD_INVALID');
  const owner = record.values.成交销售;
  if (owner == null || Array.isArray(owner) && owner.length === 0) return null;
  if (!Array.isArray(owner) || owner.length !== 1 || !personId(owner[0]?.id)) fail('ORDER_MASTER_OWNER_INVALID');
  return owner[0].id;
}
