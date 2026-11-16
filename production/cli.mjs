import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeishuClient } from '../lib/feishu.mjs';
import { validateConfig, inspect, ProductionDispatcher } from './engine.mjs';
import { ROOT, KIND, ordinaryFile, acquireLock, writeSnapshot, stopRequested, safeCode } from './control.mjs';

export function readConfig(filename = path.join(ROOT, 'config.production.local.json')) {
  if (!existsSync(filename)) throw Object.assign(new Error('请先填写本机正式配置'), { code: 'CONFIG_MISSING' });
  ordinaryFile(filename);
  const raw = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  const localMembers = raw.staffSource === 'config';
  const required = ['appId', 'appSecret', 'appToken', 'baseUrl', 'tableIds.leads', 'fields.leads.owner', ...(localMembers ? ['fields.leads.slot', 'assignment.mode', 'defaultDomain'] : ['tableIds.staff', 'fields.staff.member', 'fields.staff.role', 'fields.staff.domains', 'fields.staff.enabled']), ...(!raw.fields?.leads?.domain ? ['defaultDomain'] : [])];
  const missing = required.filter(key => { const value = key.split('.').reduce((current, part) => current?.[part], raw); return typeof value !== 'string' || !value.trim(); });
  if (missing.length) throw Object.assign(new Error('必需配置缺失'), { code: 'CONFIG_INCOMPLETE', issues: missing });
  const config = validateConfig(raw);
  config.dbPath = path.resolve(ROOT, config.dbPath || 'data/production.sqlite');
  if (config.dbPath !== path.join(ROOT, 'data/production.sqlite')) throw Object.assign(new Error('正式库路径必须固定'), { code: 'DATABASE_PATH_INVALID' });
  const seconds = config.pollSeconds ?? 600;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400) throw Object.assign(new Error('扫描间隔无效'), { code: 'POLL_INTERVAL_INVALID' });
  config.pollSeconds = seconds;
  return config;
}
export function parseArgs(args) {
  if (args.length !== 1 || !['--check', '--inspect', '--plan', '--initialize', '--run'].includes(args[0])) throw Object.assign(new Error('请选择单一操作'), { code: 'ARGS_INVALID' });
  return args[0];
}
function safeEngineStatus(engine) {
  const value = engine.status();
  const counts = Object.fromEntries(Object.entries(value.counts || {}).filter(([key, count]) => /^[A-Za-z0-9_-]{1,80}$/.test(key) && Number.isSafeInteger(count) && count >= 0));
  const scan = value.lastScan;
  const lastScan = scan && typeof scan.at === 'string' && !Number.isNaN(Date.parse(scan.at)) ? { at: scan.at, scanned: Number.isSafeInteger(scan.scanned) ? scan.scanned : null } : null;
  return { initialized: value.initialized === true, counts, lastScan, nextRetryAt: Number.isSafeInteger(value.nextRetryAt) ? value.nextRetryAt : null };
}
/** Pending jobs can wake earlier than the compensation interval; clamp expired jobs to one second. */
export function nextScanTime({ now = Date.now(), pollSeconds = 600, hasError = false, nextRetryAt = null } = {}) {
  const regular = now + (hasError ? Math.min(60, pollSeconds) : pollSeconds) * 1000;
  if (hasError) return regular;
  const retry = Number.isSafeInteger(nextRetryAt) && nextRetryAt > 0 ? Math.max(now + 1000, nextRetryAt) : Infinity;
  return Math.min(regular, retry);
}
export async function run(config, { root = ROOT, client = new FeishuClient(config), Dispatcher = ProductionDispatcher } = {}) {
  if (config.enabled !== true || config.notification?.enabled !== true) throw Object.assign(new Error('先显式开启正式派单及通知'), { code: 'PRODUCTION_DISABLED' });
  const lease = acquireLock(root);
  let engine, heartbeat, watcher, stop = false, active = null, phase = 'starting', lastErrorCode = '', nextScan = Date.now(), dirty = true, eventAttemptAt = 0;
  const shutdown = () => { stop = true; };
  const shouldStop = () => { if (stop) return true; try { if (stopRequested(lease)) stop = true; } catch { stop = true; } return stop; };
  const snapshot = () => writeSnapshot(root, { kind: KIND, ...lease.lock, checkedAt: new Date().toISOString(), phase, connection: client.eventStreamStatus?.() || { state: 'polling' }, enabled: true, notificationsEnabled: true, ...safeEngineStatus(engine), lastErrorCode, nextScanAt: new Date(nextScan).toISOString() });
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    engine = new Dispatcher(config, { client, dbPath: config.dbPath, ...(config.staffSource === 'config' ? { memberProvider: () => readConfig(path.join(root, 'config.production.local.json')) } : {}) });
    if (engine.status().initialized !== true) throw Object.assign(new Error('须先显式初始化历史基线'), { code: 'INITIALIZATION_REQUIRED' });
    heartbeat = setInterval(() => { try { snapshot(); } catch { stop = true; } }, 5000);
    watcher = setInterval(shouldStop, 1000);
    phase = 'polling'; snapshot();
    while (!stop) {
      if (config.events !== false && typeof client.startEventStream === 'function' && !['connected', 'connecting', 'reconnecting'].includes(client.eventStreamStatus?.().state) && Date.now() >= eventAttemptAt) {
        eventAttemptAt = Date.now() + 60000;
        try { await client.stopEventStream?.(); await client.startEventStream(() => { dirty = true; }); lastErrorCode = ''; } catch (error) { lastErrorCode = safeCode(error); }
      }
      if (stop) break;
      if (dirty || Date.now() >= nextScan) {
        dirty = false; phase = 'scanning'; snapshot();
        try { active = Promise.resolve(engine.scan({ apply: true, shouldStop })); const result = await active; lastErrorCode = result?.ok === false ? safeCode(result.errors?.[0]) : ''; nextScan = nextScanTime({ pollSeconds: config.pollSeconds, hasError: Boolean(lastErrorCode), nextRetryAt: result?.nextRetryAt ?? engine.status().nextRetryAt }); }
        catch (error) { lastErrorCode = safeCode(error); nextScan = nextScanTime({ pollSeconds: config.pollSeconds, hasError: true, nextRetryAt: engine.status().nextRetryAt }); }
        finally { active = null; phase = lastErrorCode ? 'scan_error' : 'polling'; snapshot(); }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    clearInterval(heartbeat); clearInterval(watcher); process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    try { await client.stopEventStream?.(); } finally { try { await active; if (engine) { phase = 'stopped'; snapshot(); await engine.close(); } } finally { lease.release(); } }
  }
}
export async function main(args = process.argv.slice(2)) {
  const action = parseArgs(args), config = readConfig();
  if (action === '--check') { const sdk = await import('@larksuiteoapi/node-sdk'); if (!(sdk.WSClient || sdk.default?.WSClient)) throw Object.assign(new Error('SDK无效'), { code: 'SDK_INVALID' }); console.log('正式配置与官方SDK离线检查通过；未联网、未写飞书、未启动派单。'); return; }
  const client = new FeishuClient(config);
  if (action === '--inspect') { const report = await inspect(client, config); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; return; }
  if (action === '--run') return run(config, { client });
  const lease = acquireLock();
  let engine;
  try { engine = new ProductionDispatcher(config, { client, dbPath: config.dbPath }); if (action === '--initialize') { const result = await engine.initialize(); console.log(JSON.stringify({ ok: result.ok, action: 'initialize', ...safeEngineStatus(engine), ...(result.ok ? { note: '仅建立本地历史基线，历史未分配记录留待人工核查；没有修改飞书或发送消息。' } : { inspection: result.inspection }), }, null, 2)); if (!result.ok) process.exitCode = 1; } else { const { ok, apply, scanned, counts, errors } = await engine.scan({ apply: false }); console.log(JSON.stringify({ ok, apply, scanned, counts, errors }, null, 2)); if (!ok) process.exitCode = 1; } }
  finally { try { await engine?.close(); } finally { lease.release(); } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`正式派单操作未完成（${safeCode(error)}）；请核对本机配置、应用权限及运行状态。未输出凭据。`); const issues = Array.isArray(error.issues) ? error.issues.filter(key => /^(?:appId|appSecret|appToken|baseUrl|defaultDomain|assignment\.mode|tableIds\.(?:leads|staff)|fields\.(?:leads|staff)\.[A-Za-z]+)$/.test(key)) : []; if (issues.length) console.error(`请在本机补齐：${issues.join('、')}`); process.exitCode = 1; });
