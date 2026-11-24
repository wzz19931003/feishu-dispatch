import { hostname } from 'node:os';
import { validateStaffManagement } from './staff-config.mjs';

export class WorkflowValidationError extends Error {
  constructor(code) { super(`工作流检查未通过（${code}）`); this.name = 'WorkflowValidationError'; this.code = code; }
}
const fail = code => { throw new WorkflowValidationError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const textValue = value => value == null ? '' : Array.isArray(value) ? value.map(textValue).join('') : object(value) ? String(value.text ?? value.name ?? '') : String(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const personId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{5,}$/.test(value);
export const EXTRA_SOURCE_FIELDS = { account: [1, 3], channel: [1, 3], leadSource: [1, 3], leadDate: [5] };
const FIELD_TYPES = { owner: [11], operator: [11], wx: [1], needs: [1], wxStatus: [1, 3], addMethod: [1, 3], partySize: [1, 2], actualSlot: [2], actualSort: [2], salesName: [1], ...EXTRA_SOURCE_FIELDS };
const REQUIRED_SOURCE = ['owner', 'operator', 'wx', 'needs', 'wxStatus', 'addMethod', 'actualSlot', 'actualSort', 'salesName'];
const FEEDBACK = ['wxStatus', 'wx', 'needs', 'addMethod', 'partySize'];

function fieldDefinitions(raw) {
  if (!object(raw) || !Object.keys(raw).length) fail('FIELDS_REQUIRED');
  const result = {}, ids = new Set();
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(FIELD_TYPES, key) || !object(value) || !/^fld[A-Za-z0-9]{5,}$/.test(value.fieldId || '')) fail('FIELD_DEFINITION_INVALID');
    if (!Array.isArray(value.types) || !value.types.length || new Set(value.types).size !== value.types.length || value.types.some(type => !FIELD_TYPES[key].includes(type))) fail('FIELD_TYPES_INVALID');
    if (ids.has(value.fieldId)) fail('FIELD_ID_DUPLICATE');
    ids.add(value.fieldId);
    if (['owner', 'operator'].includes(key) && value.multiple !== undefined && value.multiple !== false) fail('SINGLE_PERSON_REQUIRED');
    result[key] = { fieldId: value.fieldId, types: [...value.types], ...(['owner', 'operator'].includes(key) ? { multiple: false } : {}) };
  }
  return result;
}
function resourceUrl(appToken, baseUrl) {
  if (!/^[A-Za-z0-9]{10,}$/.test(appToken || '')) fail('BASE_INVALID');
  let url; try { url = new URL(baseUrl); } catch { fail('BASE_URL_INVALID'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.feishu.cn') || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== `/base/${appToken}`) fail('BASE_URL_INVALID');
  return url.href.replace(/\/$/, '');
}
export function validateWorkflowConfig(raw, { requireTargets = true } = {}) {
  if (!object(raw)) fail('CONFIG_INVALID');
  if (!/^cli_[A-Za-z0-9_-]{5,}$/.test(raw.appId || '') || !nonempty(raw.appSecret) || raw.appSecret.trim().length < 10) fail('CREDENTIALS_REQUIRED');
  const baseUrl = resourceUrl(raw.appToken, raw.baseUrl);
  if (!object(raw.tableIds) || !/^tbl[A-Za-z0-9]{5,}$/.test(raw.tableIds.leads || '')) fail('SOURCE_TABLE_INVALID');
  const fields = fieldDefinitions(raw.fields?.leads);
  if (REQUIRED_SOURCE.some(key => !fields[key])) fail('SOURCE_FIELDS_INCOMPLETE');
  const required = raw.requiredLeadFields ?? ['wx', 'needs'];
  if (!Array.isArray(required) || required.length !== 2 || new Set(required).size !== 2 || !required.includes('wx') || !required.includes('needs')) fail('REQUIRED_LEAD_FIELDS_INVALID');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail('ENABLED_INVALID');
  if (raw.notification !== undefined && !object(raw.notification)) fail('NOTIFICATION_INVALID');
  if (raw.notification?.enabled !== undefined && typeof raw.notification.enabled !== 'boolean') fail('NOTIFICATION_INVALID');
  if (raw.notification?.title !== undefined && (!nonempty(raw.notification.title) || raw.notification.title.length > 300)) fail('NOTIFICATION_INVALID');
  if (!nonempty(raw.allowedHost) || /[\s\0/\\]/.test(raw.allowedHost) || raw.allowedHost.length > 255) fail('ALLOWED_HOST_REQUIRED');
  if (raw.dbPath !== undefined && (typeof raw.dbPath !== 'string' || raw.dbPath.replaceAll('\\', '/') !== 'data/workflow.sqlite')) fail('DATABASE_PATH_INVALID');
  const pollSeconds = raw.pollSeconds ?? 600;
  if (!Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 86400) fail('POLL_INTERVAL_INVALID');
  if (raw.events !== undefined && typeof raw.events !== 'boolean') fail('EVENTS_INVALID');
  if (raw.mirrors !== undefined && !object(raw.mirrors)) fail('MIRRORS_INVALID');
  if (raw.mirrors?.enabled !== undefined && typeof raw.mirrors.enabled !== 'boolean') fail('MIRRORS_INVALID');
  if (raw.mirrors?.enabled === false) fail('MIRRORS_REQUIRED');
  const feedbackFields = raw.mirrors?.feedbackFields ?? ['wxStatus'];
  if (!Array.isArray(feedbackFields) || !feedbackFields.includes('wxStatus') || new Set(feedbackFields).size !== feedbackFields.length || feedbackFields.some(key => !FEEDBACK.includes(key) || !fields[key])) fail('FEEDBACK_FIELDS_INVALID');
  if (!Array.isArray(raw.members) || !raw.members.length) fail('MEMBERS_REQUIRED');
  const ids = new Set(), identities = new Set(), targets = new Set(), pendingTargets = [];
  const members = raw.members.map(member => {
    if (!object(member) || !/^[A-Za-z0-9_-]{1,80}$/.test(member.id || '') || !personId(member.openId) || !nonempty(member.displayName) || member.displayName.length > 200 || !Number.isSafeInteger(member.order) || member.order < 0 || typeof member.enabled !== 'boolean') fail('MEMBER_INVALID');
    if (ids.has(member.id) || identities.has(member.openId)) fail('MEMBER_DUPLICATE');
    ids.add(member.id); identities.add(member.openId);
    let target = null;
    if (member.target != null) {
      if (!object(member.target) || member.target.appToken === raw.appToken) fail('TARGET_BASE_INVALID');
      const targetUrl = resourceUrl(member.target.appToken, member.target.baseUrl);
      if (!/^tbl[A-Za-z0-9]{5,}$/.test(member.target.tableId || '')) fail('TARGET_TABLE_INVALID');
      if (targets.has(member.target.appToken)) fail('TARGET_BASE_DUPLICATE');
      targets.add(member.target.appToken);
      const targetFields = fieldDefinitions(member.target.fields);
      if (['wx', 'needs', 'wxStatus', ...feedbackFields].some(key => !targetFields[key])) fail('TARGET_FIELDS_INCOMPLETE');
      target = { appToken: member.target.appToken, baseUrl: targetUrl, tableId: member.target.tableId, fields: targetFields };
    } else pendingTargets.push(member.id);
    const salesWechat = member.salesWechat ?? '';
    if (typeof salesWechat !== 'string' || salesWechat.length > 80 || /[\u0000-\u001f\u007f]/.test(salesWechat)) fail('MEMBER_WECHAT_INVALID');
    return { id: member.id, openId: member.openId, displayName: member.displayName.trim(), order: member.order, enabled: member.enabled, target,
      ...(salesWechat.trim() ? { salesWechat: salesWechat.trim() } : {}) };
  });
  if (requireTargets && pendingTargets.length) fail('TARGETS_REQUIRED');
  const staffManagement=validateStaffManagement(raw.staffManagement,{sourceAppToken:raw.appToken});
  if(staffManagement&&members.some(member=>member.target?.appToken===staffManagement.appToken))fail('STAFF_TARGET_COLLISION');
  return { appId: raw.appId, appSecret: raw.appSecret.trim(), appToken: raw.appToken, baseUrl, tableIds: { leads: raw.tableIds.leads }, fields: { leads: fields }, members,
    enabled: raw.enabled === true, notification: { enabled: raw.notification?.enabled === true, title: raw.notification?.title || '新客资待跟进' }, requiredLeadFields: ['wx', 'needs'],
    allowedHost: raw.allowedHost.trim(), pollSeconds, dbPath: 'data/workflow.sqlite', events: raw.events !== false, mirrors: { enabled: true, feedbackFields: [...feedbackFields] }, pendingTargets, ...(staffManagement?{staffManagement}:{}) };
}

export async function resolveFields(client, { appToken, tableId, fields }) {
  const definitions = fieldDefinitions(fields);
  if (!/^[A-Za-z0-9]{10,}$/.test(appToken || '') || !/^tbl[A-Za-z0-9]{5,}$/.test(tableId || '')) fail('RESOURCE_INVALID');
  const schema = [], seen = new Set(); let token;
  do {
    const page = await client.api(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, { method: 'GET', query: { page_size: 100, ...(token ? { page_token: token } : {}) } });
    if (!Array.isArray(page?.items)) fail('FIELD_METADATA_INVALID');
    schema.push(...page.items);
    if (!page.has_more) break;
    if (!nonempty(page.page_token) || seen.has(page.page_token) || seen.size >= 1000) fail('FIELD_PAGINATION_INVALID');
    token = page.page_token; seen.add(token);
  } while (true);
  const result = {};
  for (const [key, spec] of Object.entries(definitions)) {
    const matches = schema.filter(field => field.field_id === spec.fieldId);
    if (matches.length !== 1 || !nonempty(matches[0].field_name)) fail('FIELD_ID_NOT_FOUND');
    const field = matches[0], type = Number(field.type);
    if (!spec.types.includes(type)) fail('FIELD_TYPE_CHANGED');
    if (spec.multiple === false && field.property?.multiple !== false) fail('SINGLE_PERSON_REQUIRED');
    result[key] = { fieldId: spec.fieldId, name: field.field_name, type, property: structuredClone(field.property || {}) };
  }
  return result;
}
function person(value) {
  if (value == null || value === '' || Array.isArray(value) && !value.length) return '';
  if (!Array.isArray(value) || value.length !== 1 || !object(value[0]) || !personId(value[0].id || value[0].open_id)) fail('RECORD_PERSON_INVALID');
  return value[0].id || value[0].open_id;
}
export function recordView(record, resolved) {
  const id = record?.record_id || record?.recordId || record?.id;
  if (!nonempty(id) || !object(record.fields) || !object(resolved)) fail('RECORD_INVALID');
  const view = { id, owner: '', operator: '', wx: '', needs: '', wxStatus: '', addMethod: '', partySize: '', actualSlot: null, actualSort: null, salesName: '' };
  for (const [key, spec] of Object.entries(resolved)) {
    const value = Object.hasOwn(record.fields, spec.name) ? record.fields[spec.name] : undefined;
    if (['owner', 'operator'].includes(key)) view[key] = person(value);
    else if (spec.type === 2) { const normalized = textValue(value).trim(); if (!normalized) view[key] = null; else { const number = Number(normalized); if (!Number.isFinite(number)) fail('RECORD_NUMBER_INVALID'); view[key] = number; } }
    else if (spec.type === 5) {
      const date = value === undefined || value === null || value === '' ? null : Number(value);
      if (date !== null && (!Number.isSafeInteger(date) || !Number.isFinite(new Date(date).getTime()))) fail('RECORD_DATE_INVALID');
      view[key] = date;
    } else view[key] = textValue(value).trim();
  }
  return view;
}
export function encodePatch(logical, resolved) {
  if (!object(logical) || !object(resolved)) fail('PATCH_INVALID');
  const patches = [];
  for (const [key, value] of Object.entries(logical)) {
    const spec = resolved[key]; if (!spec) fail('PATCH_FIELD_UNMAPPED');
    if (spec.type === 11) { if (value !== '' && value != null && !personId(value)) fail('PATCH_PERSON_INVALID'); patches.push([spec.name, value ? [{ id: value }] : []]); }
    else if (spec.type === 2) { if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) fail('PATCH_NUMBER_INVALID'); patches.push([spec.name, value]); }
    else if (spec.type === 1 || spec.type === 3) {
      if (value != null && typeof value !== 'string') fail('PATCH_TEXT_INVALID');
      const text = value?.trim() || '';
      if (spec.type === 3 && text && Array.isArray(spec.property?.options) && !spec.property.options.some(option => option.name === text)) fail('PATCH_OPTION_INVALID');
      patches.push([spec.name, spec.type === 3 && !text ? null : text]);
    } else fail('PATCH_TYPE_UNSUPPORTED');
  }
  return Object.fromEntries(patches);
}
export function chooseMember(members, lastId) {
  if (!Array.isArray(members) || members.some(m => !object(m) || !nonempty(m.id) || !Number.isSafeInteger(m.order) || typeof m.enabled !== 'boolean') || new Set(members.map(m => m.id)).size !== members.length) fail('MEMBERS_INVALID');
  const sorted = [...members].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!sorted.some(member => member.enabled)) return null;
  const index = sorted.findIndex(member => member.id === lastId);
  for (let step = 1; step <= sorted.length; step++) { const candidate = sorted[(index + step) % sorted.length]; if (candidate.enabled) return candidate; }
  return null;
}
export const currentHostname = () => hostname();
