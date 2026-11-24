import { hostname } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowClient } from './client.mjs';
import { ROOT, KIND, ordinaryFile, acquireLock, writeSnapshot, stopRequested, safeCode, status, requestStop } from '../production/control.mjs';
import { validateWorkflowConfig, resolveFields } from './field-map.mjs';
import { WorkflowEngine } from './engine.mjs';
import { SalesMirror, boundedSalesDetailClient, SALES_DETAIL_BUDGET_MS } from './sales-mirror.mjs';
import { WorkflowEvents } from './events.mjs';
import { WORKFLOW_RELEASE } from './version.mjs';
import { StaffRoster, resolveStaffSchema } from './staff-roster.mjs';
import { StaffProvisioner } from './staff-provisioner.mjs';
import { StaffAdminClient } from './staff-admin-client.mjs';
import { OperatorMirror } from './operator-mirror.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export function readConfig(root = ROOT) {
  const filename = path.join(root, 'config.workflow.local.json');
  if (!existsSync(filename)) fail('WORKFLOW_CONFIG_MISSING');
  ordinaryFile(filename);
  const config = validateWorkflowConfig(JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')));
  const database = path.resolve(root, config.dbPath || 'data/workflow.sqlite');
  if (database !== path.join(root, 'data/workflow.sqlite')) fail('WORKFLOW_DATABASE_PATH_INVALID');
  return config;
}
export function assertActivation(config, host = hostname()) {
  if (config.enabled !== true || config.notification?.enabled !== true) fail('WORKFLOW_DISABLED');
  if (typeof config.allowedHost !== 'string' || !config.allowedHost || config.allowedHost.length>255 || /[\s\0/\\]/.test(config.allowedHost)
    || config.allowedHost.toLowerCase() !== host.toLowerCase()) fail('WORKFLOW_HOST_NOT_ALLOWED');
}
export function parseArgs(args) {
  if (args.length !== 1 || !['--check','--activation-check','--inspect','--initialize','--plan','--run','--status','--stop'].includes(args[0])) fail('ARGS_INVALID');
  return args[0];
}
export function nextScanTime({now=Date.now(),pollSeconds=600,hasError=false,nextRetryAt=null}={}) {
  const regular=now+(hasError?Math.min(60,pollSeconds):pollSeconds)*1000;
  if(hasError)return regular;
  return Math.min(regular,Number.isSafeInteger(nextRetryAt)&&nextRetryAt>0?Math.max(now+1000,nextRetryAt):Infinity);
}
function safeStatus(engine) {
  const value = engine?.status?.() || {};
  const counts = Object.fromEntries(Object.entries(value.counts || {}).filter(([key, n]) => /^[A-Za-z0-9_-]{1,80}$/.test(key) && Number.isSafeInteger(n) && n >= 0));
  if (Number.isSafeInteger(value.reviews)) counts.review_open = value.reviews;
  if (Number.isSafeInteger(value.eventsPending)) counts.events_pending = value.eventsPending;
  if(Number.isSafeInteger(value.staffEventsPending))counts.staff_events_pending=value.staffEventsPending;
  for (const [key,n] of Object.entries(value.mirror || {})) if (/^[A-Za-z0-9_-]{1,60}$/.test(key) && Number.isSafeInteger(n) && n>=0) counts[`mirror_${key}`]=n;
  for(const [key,n] of Object.entries(value.staff?.counts||{}))if(/^[A-Za-z0-9_-]{1,60}$/.test(key)&&Number.isSafeInteger(n)&&n>=0)counts[`staff_${key}`]=n;
  for (const [key, n] of Object.entries(value.operatorMirror || {})) {
    if (/^[A-Za-z0-9_-]{1,60}$/.test(key) && Number.isSafeInteger(n) && n >= 0 && key !== 'nextRetryAt') counts[`operator_mirror_${key}`] = n;
  }
  return { initialized: value.initialized === true, counts,
    ...(value.staff?{staffHealthy:value.staff.healthy===true,staffErrors:(value.staff.errors||[]).map(error=>safeCode(typeof error==='string'?{code:error}:error))}:{}),
    ...(value.lastScan?.at ? { lastScan: { at: value.lastScan.at, scanned: value.lastScan.scanned ?? null } } : {}),
    nextRetryAt: Number.isSafeInteger(value.nextRetryAt) ? value.nextRetryAt : null };
}
export async function createEngine(config, { root = ROOT, client = new WorkflowClient(config), Engine = WorkflowEngine, Mirror = SalesMirror, Roster=StaffRoster, Provisioner=StaffProvisioner, Admin=StaffAdminClient, Operator=OperatorMirror } = {}) {
  const engine = new Engine({ config, client, dbPath: path.resolve(root, config.dbPath), memberProvider: () => readConfig(root) });
  let salesDetails = {};
  try {
    if(config.staffManagement?.enabled){
      const staff=new Roster({config,db:engine.db,client});
      staff.assertLiveConfig=()=>engine.refreshMembers({persist:false});
      const admin = new Admin(config, { sourceClient: client });
      staff.provisioner=new Provisioner({config,db:engine.db,client:admin,readCurrent:async id=>{
        await engine.refreshMembers({persist:false});return staff.readCurrent(id);
      }});
      engine.staff=staff;
      if (config.mirrors?.salesDetails !== false) {
        salesDetails = {
          operatorNames: () => {
            if (!staff.healthy || engine.staffFailure) return null;
            return new Map(staff.registry()
              .filter(entry => entry.role === 'operator' && entry.ready === true && entry.state !== 'review')
              .map(entry => [entry.openId, entry.displayName]));
          },
          auditDetailsTarget: async (member, budgetEnded, deadline) => {
            if (!staff.healthy || engine.staffFailure || budgetEnded()) return false;
            await engine.refreshMembers({ persist: false });
            const current = engine.config.members.find(item => item.id === member.id && item.openId === member.openId);
            if (current?.target?.appToken !== member.target.appToken || current.target.tableId !== member.target.tableId) return false;
            const registered = staff.registry().find(item => item.id === member.id && item.openId === member.openId);
            if (registered?.role !== 'sales' || registered.ready !== true || registered.retired ||
                !registered.recordId || !['ready', 'paused', 'disabled'].includes(registered.state)) return false;
            if (budgetEnded()) return false;
            const scopedAdmin = boundedSalesDetailClient(admin, deadline);
            if (!staff.provisioner.privateSharing(await scopedAdmin.getSharing(member.target.appToken))) return false;
            if (budgetEnded()) return false;
            const collaborators = await scopedAdmin.listMembers(member.target.appToken);
            staff.provisioner.members(member, collaborators, { existing: true, requireAll: true });
            return collaborators.some(entry => entry.isApp === true && entry.perm === 'full_access');
          },
        };
      }
      engine.memberProvider=()=>{
        const fresh=readConfig(root),effective=staff.configForMembers();
        return{...fresh,members:engine.staffFailure?effective.members.map(member=>({...member,enabled:false})):effective.members};
      };
      if (config.staffManagement.operatorViews?.enabled) {
        engine.operatorMirror = new Operator({ config, db: engine.db, client: admin, maxWrites: 12,
          readSource: id => engine.readSource(id), resolveSource: () => engine.resolveSource(),
          assertLiveConfig: () => engine.refreshMembers({ persist: false }),
          verifyOperator: async operator => {
            const current = await staff.readCurrent(operator.recordId);
            return Boolean(current?.effectiveEnabled && current.role === 'operator' &&
              current.openId === operator.openId && current.version === operator.version);
          },
        });
      }
    }
    const clients = new Map([[config.appToken, client]]);
    engine.mirror = new Mirror({ config: engine.config, db: engine.db, sourceClient: client, ...salesDetails,
      clientFactory: appToken => {
        if (!clients.has(appToken)) clients.set(appToken, new WorkflowClient({ ...engine.config, appToken }));
        return clients.get(appToken);
      },
      readSource: id => engine.readSource(id), resolveSource: () => engine.resolveSource() });
    return engine;
  } catch(error) { await engine.close(); throw error; }
}
export async function inspect(config, client = new WorkflowClient(config)) {
  const targets = [{ appToken: config.appToken, tableId: config.tableIds.leads, fields: config.fields.leads }, ...config.members.map(m => m.target)];
  const checked = [];
  for (const target of targets) {
    const fields = await resolveFields(client, target);
    checked.push({ fieldCount: Object.keys(fields).length });
  }
  if(config.staffManagement?.enabled){const fields=await resolveStaffSchema(client,config.staffManagement);checked.push({fieldCount:Object.keys(fields).length,resource:'staff'});}
  return { ok: true, readOnly: true, targetsChecked: checked.length, fields: checked };
}
export async function run(config, { root = ROOT, host = hostname(), client, Events = WorkflowEvents, makeEngine = createEngine } = {}) {
  // This guard must run before opening a database, connecting WS, or calling an API.
  assertActivation(config, host);
  const lease = acquireLock(root); // Reuse v1's lock: v1 and v2 cannot run together on this host.
  let engine, events, timer, watcher, stopping = false, phase = 'starting', dirty = true, nextScan = Date.now(), retryEventsAt = 0, lastErrorCode = '';
  let detailController = null, detailsAvailable = false, nextDetailsAt = 0;
  const wake = () => { dirty = true; detailController?.abort(); };
  const stop = () => { stopping = true; detailController?.abort(); };
  const shouldStop = () => { if (stopping) return true; try { if (stopRequested(lease)) stop(); } catch { stop(); } return stopping; };
  const snapshot = () => writeSnapshot(root, { kind: KIND, runnerVersion: 2, runnerRelease: WORKFLOW_RELEASE, ...lease.lock, checkedAt: new Date().toISOString(), phase,
    connection: events?.status?.() || { state: 'polling' }, ...safeStatus(engine), lastErrorCode,
    nextScanAt: new Date(nextScan).toISOString(), enabled: true, notificationsEnabled: true });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    client ||= new WorkflowClient(config);
    engine = await makeEngine(config, { root, client });
    if (!engine.status().initialized) fail('WORKFLOW_INITIALIZATION_REQUIRED');
    events = new Events(engine.config || config);
    const configStamp=()=>{const value=statSync(path.join(root,'config.workflow.local.json'));return `${value.mtimeMs}/${value.size}`;};
    let previousConfigStamp=configStamp();
    timer = setInterval(() => { try { snapshot(); } catch { stop(); } }, 5000);
    watcher = setInterval(()=>{shouldStop();try{const current=configStamp();if(current!==previousConfigStamp){previousConfigStamp=current;wake();}}catch{stop();}},1000);
    while (!shouldStop()) {
      const state = events.status().state;
      if (config.events !== false && !['connected','connecting','reconnecting'].includes(state) && Date.now() >= retryEventsAt) {
        retryEventsAt = Date.now() + 60000;
        try { await events.stop(); await events.start(async event => { await engine.acceptEvent?.(event); wake(); }); }
        catch (error) { lastErrorCode = safeCode(error); }
      }
      if (shouldStop()) break;
      if (dirty || Date.now() >= nextScan) {
        dirty = false; detailsAvailable = false; phase = 'scanning'; snapshot();
        try {
          const result = await engine.scan({ apply: true, shouldStop, deferSalesDetails: true });
          detailsAvailable = result?.ok === true && !result.stopped && typeof engine.syncDeferredSalesDetails === 'function';
          lastErrorCode = result?.ok === false ? safeCode(result.errors?.[0]) : '';
          const retry = result?.nextRetryAt ?? engine.status().nextRetryAt;
          const staffOnly=engine.status().staff?.healthy===true&&result?.errors?.length>0&&result.errors.every(error=>safeCode(error).startsWith('STAFF_'));
          nextScan = nextScanTime({pollSeconds:config.pollSeconds||600,hasError:Boolean(lastErrorCode)&&!staffOnly,nextRetryAt:retry});
        } catch (error) { lastErrorCode = safeCode(error); nextScan = Date.now() + 60000; }
        phase = lastErrorCode ? 'scan_error' : 'polling'; snapshot();
      }
      if (detailsAvailable && !dirty && !shouldStop() && Date.now() >= nextDetailsAt && nextScan - Date.now() > SALES_DETAIL_BUDGET_MS) {
        detailController = new AbortController();
        try {
          const detail = await engine.syncDeferredSalesDetails({ shouldStop, signal: detailController.signal });
          detailsAvailable = (detail?.detailPending || 0) > 0;
          nextDetailsAt = Date.now() + (detail?.detailRateLimited ? 30_000 : 2000);
        } catch {
          detailsAvailable = false;
        } finally {
          detailController = null;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    clearInterval(timer); clearInterval(watcher); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { await events?.stop(); } finally { try { if (engine) { phase = 'stopped'; snapshot(); await engine.close(); } } finally { lease.release(); } }
  }
}
export async function main(args = process.argv.slice(2)) {
  const action = parseArgs(args);
  if (action === '--status' || action === '--stop') { console.log(JSON.stringify(action === '--status' ? status() : requestStop(), null, 2)); return; }
  const config = readConfig();
  if (action === '--activation-check') { assertActivation(config); console.log('Configured production host and explicit activation confirmed; no service started.'); return; }
  if (action === '--check') {
    const sdk = await import('@larksuiteoapi/node-sdk');
    if (!(sdk.WSClient || sdk.default?.WSClient)) fail('SDK_INVALID');
    console.log(JSON.stringify({ ok: true, offline: true, schemaNotChecked: true, enabled: config.enabled, allowedHostIsThisHost: config.allowedHost.toLowerCase() === hostname().toLowerCase() })); return;
  }
  const client = new WorkflowClient(config);
  if (action === '--inspect') { console.log(JSON.stringify(await inspect(config, client))); return; }
  if (action === '--run') return run(config, { client });
  const lease = acquireLock(); let engine;
  try {
    engine = await createEngine(config, { client });
    if (action === '--initialize') {
      const imported = engine.db.prepare("SELECT value FROM v2_meta WHERE key='legacy_import'").get();
      if (!imported) fail('LEGACY_IMPORT_REQUIRED');
      const legacyRows = engine.db.prepare('SELECT data FROM v2_legacy_jobs ORDER BY id').all().map(row => JSON.parse(row.data));
      const legacyMeta = Object.fromEntries(engine.db.prepare('SELECT key,value FROM v2_legacy_meta').all().map(row=>[row.key,JSON.parse(row.value)]));
      await engine.initialize({ legacyRows, legacyMeta });
      console.log(JSON.stringify({ ok: true, action: 'initialize', ...safeStatus(engine), note: 'Only local snapshots initialized; no owner writes or messages.' }));
    } else {
      const result = await engine.scan({ apply: false });
      console.log(JSON.stringify({ ok: result.ok, readOnly: true, scanned: result.scanned, ...safeStatus(engine), ...(result.errors ? { errors: result.errors.map(e=>({code:safeCode(e)})) } : {}) }));
    }
  } finally { try { await engine?.close(); } finally { lease.release(); } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(`v2操作未完成（${safeCode(error)}）。未输出密钥或客户内容，未自动启动派单。`); process.exitCode = 1;
});
