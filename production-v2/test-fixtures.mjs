export const clone = value => structuredClone(value);
export const definition = (key, type, extra = {}) => ({ fieldId: `fldOffline${key}`, types: [type], ...extra });
export function workflowConfig({ targets = true } = {}) {
  const fields = { owner: definition('Owner', 11, { multiple: false }), operator: definition('Operator', 11, { multiple: false }), wx: definition('Wx', 1), needs: definition('Needs', 1), wxStatus: definition('Status', 3), addMethod: definition('Method', 3), actualSlot: definition('Slot', 2), actualSort: definition('Sort', 2), salesName: definition('Name', 1) };
  return { appId: 'cli_offlineapplication', appSecret: 'offline-secret-not-real', appToken: 'OfflineSourceToken123', baseUrl: 'https://offline.feishu.cn/base/OfflineSourceToken123', tableIds: { leads: 'tblOfflineLeads123' }, fields: { leads: fields },
    members: ['A', 'B'].map((id, index) => ({ id: `sales_${id}`, openId: `ou_offlineSales${id}`, displayName: `Offline Sales ${id}`, order: index + 1, enabled: true, target: targets ? { appToken: `OfflineTargetToken${id}123`, baseUrl: `https://offline.feishu.cn/base/OfflineTargetToken${id}123`, tableId: `tblOfflineTarget${id}123`, fields: { wx: definition('TargetWx', 1), needs: definition('TargetNeeds', 1), wxStatus: definition('TargetStatus', 3) } } : null })),
    enabled: false, notification: { enabled: false }, allowedHost: 'OFFLINE-HOST', dbPath: 'data/workflow.sqlite', requiredLeadFields: ['wx', 'needs'], mirrors: { enabled: true, feedbackFields: ['wxStatus'] } };
}
export function schema(config = workflowConfig()) {
  const names = { owner: '负责人', operator: '录入运营', wx: '微信号', needs: '客户需求（天数/景点/预算等）', wxStatus: '微信状态', addMethod: '添加方式', actualSlot: '分配位', actualSort: '分配位排序', salesName: '分配销售' };
  return Object.entries(config.fields.leads).map(([key, spec]) => ({ field_id: spec.fieldId, field_name: names[key], type: spec.types[0], property: spec.types[0] === 11 ? { multiple: false } : spec.types[0] === 3 ? { options: [{ name: '待添加' }, { name: '通过' }, { name: '未通过' }, { name: '客户主动加' }] } : {} }));
}
export function v1Config() {
  const c = workflowConfig();
  return { appId: c.appId, appSecret: c.appSecret, appToken: c.appToken, baseUrl: c.baseUrl, tableIds: c.tableIds, fields: { leads: { owner: '负责人', slot: '分配位', wx: '微信号', needs: '客户需求（天数/景点/预算等）' } }, staffSource: 'config', assignment: { mode: 'slot' }, defaultDomain: 'offline', enabled: false, notification: { enabled: false }, requiredLeadFields: ['wx', 'needs'],
    members: c.members.map((m, i) => ({ id: m.id, openId: m.openId, displayName: m.displayName, enabled: m.enabled, slot: i + 1 })) };
}
