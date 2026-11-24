import { validateWorkflowConfig } from './field-map.mjs';

const staffColumns = {
  salesWechat: ['销售对外微信号', 1],
  leaveStart: ['休假开始日期', 5],
  leaveEnd: ['休假结束日期', 5],
  operatorViewUrl: ['运营客资查看入口', 1],
};
const sourceColumns = {
  account: ['平台账号名称', 3],
  channel: ['渠道', 3],
  leadSource: ['客资来源（付费/自然流）', 3],
  leadDate: ['日期', 5],
};

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

async function readSchema(client, appToken, tableId) {
  const route = `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
  const fields = [], pages = new Set();
  let pageToken;
  do {
    const page = await client.api(route, {
      method: 'GET',
      query: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (!Array.isArray(page?.items)) fail('V22_FIELD_RESPONSE_INVALID');
    fields.push(...page.items);
    if (!page.has_more) return fields;
    pageToken = page.page_token;
    if (typeof pageToken !== 'string' || !pageToken || pages.has(pageToken) || pages.size >= 20) {
      fail('V22_FIELD_PAGINATION_INVALID');
    }
    pages.add(pageToken);
  } while (true);
}

function bindColumns(columns, schema, original, group) {
  const result = { ...original };
  for (const [key, [name, type]] of Object.entries(columns)) {
    const pinned = original[key]?.fieldId;
    const matches = schema.filter(field => pinned ? field.field_id === pinned : field.field_name === name);
    const field = matches[0];
    if (matches.length !== 1 || Number(field.type) !== type || !/^fld[A-Za-z0-9]{5,}$/.test(field.field_id)) {
      fail(`V22_${group}_${key.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase()}_NOT_READY`);
    }
    result[key] = { fieldId: field.field_id, types: [type] };
  }
  return result;
}

/** Read both existing schemas to stage an additive upgrade without editing either Base. */
export async function prepareV22Config(raw, client) {
  const original = validateWorkflowConfig(raw);
  const staff = original.staffManagement;
  if (!staff?.enabled) fail('V22_EMPLOYEE_TABLE_NOT_CONFIGURED');
  const [staffSchema, sourceSchema] = await Promise.all([
    readSchema(client, staff.appToken, staff.tableId),
    readSchema(client, original.appToken, original.tableIds.leads),
  ]);
  const next = {
    ...raw,
    fields: { ...raw.fields, leads: bindColumns(sourceColumns, sourceSchema, raw.fields.leads, 'SOURCE') },
    staffManagement: {
      ...raw.staffManagement,
      fields: bindColumns(staffColumns, staffSchema, raw.staffManagement.fields, 'STAFF'),
      operatorViews: { enabled: true },
    },
  };
  validateWorkflowConfig(next);
  return next;
}
