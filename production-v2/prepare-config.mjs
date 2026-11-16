import { hostname } from 'node:os';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig as validateV1 } from '../production/engine.mjs';
import { validateWorkflowConfig, WorkflowValidationError } from './field-map.mjs';

const fail = code => { throw new WorkflowValidationError(code); };
const jsonFile = filename => { try { return JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); } catch { fail('PREPARE_JSON_INVALID'); } };
const ordinary = filename => { const stat = lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('PREPARE_FILE_UNSAFE'); };
const sourceNames = { owner: '负责人', operator: '录入运营', wx: '微信号', needs: '客户需求（天数/景点/预算等）', wxStatus: '微信状态', addMethod: '添加方式', partySize: '出游人数', actualSlot: '分配位', actualSort: '分配位排序', salesName: '分配销售' };
const preferredResultNames = { actualSlot: '实际分配位', actualSort: '实际分配顺序', salesName: '实际分配销售' };
const types = { owner: [11], operator: [11], wx: [1], needs: [1], wxStatus: [3], addMethod: [3], partySize: [1, 2], actualSlot: [2], actualSort: [2], salesName: [1] };
/** Pure transformation; credentials are returned to the caller, never printed. Targets remain incomplete. */
export function prepareWorkflowConfig({ v1Config, sourceFields, allowedHost = hostname() }) {
  const old = validateV1(v1Config);
  if (sourceFields && !Array.isArray(sourceFields) && (Object.hasOwn(sourceFields, 'appToken') || Object.hasOwn(sourceFields, 'tableId')) && (sourceFields.appToken !== old.appToken || sourceFields.tableId !== old.tableIds.leads)) fail('PREPARE_SOURCE_IDENTITY_MISMATCH');
  const schema = Array.isArray(sourceFields) ? sourceFields : sourceFields?.items || sourceFields?.data?.items;
  if (!Array.isArray(schema)) fail('PREPARE_SCHEMA_INVALID');
  const fields = {};
  for (const [key, defaultName] of Object.entries(sourceNames)) {
    const preferredName = preferredResultNames[key], preferred = preferredName && schema.filter(field => field.field_name === preferredName);
    const name = old.fields.leads?.[key] || defaultName, matches = preferred?.length ? preferred : schema.filter(field => field.field_name === name);
    if (matches.length !== 1) { if (key === 'partySize') continue; fail('PREPARE_FIELD_NOT_UNIQUE'); }
    if (preferred?.length && !types[key].includes(Number(matches[0].type))) fail('PREPARE_RESULT_TYPE_INVALID');
    fields[key] = { fieldId: matches[0].field_id, types: types[key], ...(['owner', 'operator'].includes(key) ? { multiple: false } : {}) };
  }
  const members = [...(old.members || [])].sort((a, b) => a.slot - b.slot || (a.id < b.id ? -1 : 1)).map((member, index) => ({ id: member.id, openId: member.openId, displayName: member.displayName, order: index + 1, enabled: member.enabled, target: null }));
  const prepared = validateWorkflowConfig({ appId: old.appId, appSecret: old.appSecret, appToken: old.appToken, baseUrl: old.baseUrl, tableIds: { leads: old.tableIds.leads }, fields: { leads: fields }, members,
    enabled: false, notification: { enabled: false, title: old.notification.title }, requiredLeadFields: ['wx', 'needs'], mirrors: { enabled: true, feedbackFields: ['wxStatus'] }, allowedHost, pollSeconds: old.pollSeconds || 600, events: old.events !== false, dbPath: 'data/workflow.sqlite' }, { requireTargets: false });
  return prepared;
}
export function writePreparedConfig({ from, schema, to, allowedHost = hostname() }) {
  if (![from, schema, to].every(value => typeof value === 'string' && value)) fail('PREPARE_PATH_REQUIRED');
  ordinary(from); ordinary(schema);
  if (path.resolve(from) === path.resolve(to) || existsSync(to)) fail('PREPARE_TARGET_EXISTS');
  const config = prepareWorkflowConfig({ v1Config: jsonFile(from), sourceFields: jsonFile(schema), allowedHost });
  const saved = { ...config }; delete saved.pendingTargets;
  writeFileSync(to, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { prepared: true, enabled: false, notificationsEnabled: false, targetsComplete: false, pendingTargets: config.members.length, note: '仅生成关闭状态的私有v2配置。须配置独立销售Base；推荐新增实际分配位/实际分配顺序/实际分配销售三列并映射，保留原公式。旧列回退映射仍须在线类型检查，公式20不能通过；未改旧配置、未联网、未启动。' };
}
export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--from', '--fields', '--to'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('PREPARE_ARGS_INVALID'); options[args[i]] = args[i + 1]; }
  if (Object.keys(options).length !== 3) fail('PREPARE_ARGS_INVALID');
  console.log(JSON.stringify(writePreparedConfig({ from: options['--from'], schema: options['--fields'], to: options['--to'] }), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (error) { const code = /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'PREPARE_FAILED'; console.error(`配置转换未完成（${code}）；未输出密钥或成员身份。`); process.exitCode = 1; } }
