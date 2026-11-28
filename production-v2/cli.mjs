import { hostname } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowClient } from './client.mjs';
import { ROOT, KIND, ordinaryFile, acquireLock, writeSnapshot, stopRequested, safeCode, safeDetailStatus, safeAttachmentStatus, status, requestStop } from '../production/control.mjs';
import { validateWorkflowConfig, resolveFields } from './field-map.mjs';
import { WorkflowEngine } from './engine.mjs';
import { SalesMirror, boundedSalesDetailClient, SALES_DETAIL_BUDGET_MS } from './sales-mirror.mjs';
import { WorkflowEvents } from './events.mjs';
import { WORKFLOW_RELEASE } from './version.mjs';
import { StaffRoster, resolveStaffSchema } from './staff-roster.mjs';
import { StaffProvisioner } from './staff-provisioner.mjs';
import { StaffAdminClient } from './staff-admin-client.mjs';
import { OperatorMirror } from './operator-mirror.mjs';
import { createAttachmentAclVerifier, createAttachmentRuntime, validateAttachmentSyncConfig } from './attachment-runtime.mjs';
import { orderReadinessReport } from './order-feishu-audit.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const MAX_SALES_DETAIL_DEFERRAL_MS = 30_000;
const EVENT_FALLBACK_POLL_SECONDS = 30;
const MAX_FULL_SCAN_PREEMPTIONS = 3;
const MAX_FULL_SCAN_DEFERRAL_MS = 60_000;
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
  if (args.length !== 1 || !['--check','--activation-check','--inspect','--audit-orders','--initialize','--plan','--run','--status','--stop'].includes(args[0])) fail('ARGS_INVALID');
  return args[0];
}
export function nextScanTime({now=Date.now(),pollSeconds=600,hasError=false,nextRetryAt=null}={}) {
  const regular=now+(hasError?Math.min(60,pollSeconds):pollSeconds)*1000;
  if(hasError)return regular;
  return Math.min(regular,Number.isSafeInteger(nextRetryAt)&&nextRetryAt>0?Math.max(now+1000,nextRetryAt):Infinity);
}
function safeStatus(engine) {
  const value = engine?.status?.() || {};
  const salesDetails = safeDetailStatus(value.salesDetails);
  const attachmentSync = safeAttachmentStatus({ state: engine?.attachmentSetupState, ready: engine?.attachmentsReady,
    errorCode: value.attachmentError || value.attachments?.lastIssue });
  const counts = Object.fromEntries(Object.entries(value.counts || {}).filter(([key, n]) => /^[A-Za-z0-9_-]{1,80}$/.test(key) && Number.isSafeInteger(n) && n >= 0));
  if (Number.isSafeInteger(value.reviews)) counts.review_open = value.reviews;
  if (Number.isSafeInteger(value.eventsPending)) counts.events_pending = value.eventsPending;
  if(Number.isSafeInteger(value.staffEventsPending))counts.staff_events_pending=value.staffEventsPending;
  for (const [key,n] of Object.entries(value.mirror || {})) if (/^[A-Za-z0-9_-]{1,60}$/.test(key) && Number.isSafeInteger(n) && n>=0) counts[`mirror_${key}`]=n;
  for(const [key,n] of Object.entries(value.staff?.counts||{}))if(/^[A-Za-z0-9_-]{1,60}$/.test(key)&&Number.isSafeInteger(n)&&n>=0)counts[`staff_${key}`]=n;
  for (const [key, n] of Object.entries(value.operatorMirror || {})) {
    if (/^[A-Za-z0-9_-]{1,60}$/.test(key) && Number.isSafeInteger(n) && n >= 0 && key !== 'nextRetryAt') counts[`operator_mirror_${key}`] = n;
  }
  for (const [key, n] of Object.entries(value.attachments?.counts || {})) {
    if (/^[a-z_]{1,40}$/.test(key) && Number.isSafeInteger(n) && n >= 0) counts[`attachments_${key}`] = n;
  }
  for (const [key, n] of Object.entries(value.masterStatusCheckCounts || {})) {
    if (/^[A-Z_]{1,40}$/.test(key) && Number.isSafeInteger(n) && n >= 0) counts[`master_status_${key}`] = n;
  }
  return { initialized: value.initialized === true, counts, ...(salesDetails ? { salesDetails } : {}),
    ...(value.staff?{staffHealthy:value.staff.healthy===true,staffErrors:(value.staff.errors||[]).map(error=>safeCode(typeof error==='string'?{code:error}:error))}:{}),
    ...(value.lastScan?.at ? { lastScan: { at: value.lastScan.at, scanned: value.lastScan.scanned ?? null } } : {}),
    ...(attachmentSync ? { attachmentSync } : {}),
    ...(value.attachmentError ? { attachmentErrorCode: safeCode({ code: value.attachmentError }) } : {}),
    nextRetryAt: Number.isSafeInteger(value.nextRetryAt) ? value.nextRetryAt : null };
}
function readFeatureConfig(root, name) {
  const file = path.join(root, name);
  if (!existsSync(file)) return undefined;
  ordinaryFile(file);
  if (statSync(file).size > 128 * 1024) fail('FEATURE_CONFIGURATION_TOO_LARGE');
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
const readAttachmentConfig = (root, workflow) => validateAttachmentSyncConfig(readFeatureConfig(root, 'config.attachments.local.json'), workflow);
export async function createEngine(config, { root = ROOT, client = new WorkflowClient(config), Engine = WorkflowEngine, Mirror = SalesMirror, Roster=StaffRoster, Provisioner=StaffProvisioner, Admin=StaffAdminClient, Operator=OperatorMirror, enableAttachmentRuntime = false } = {}) {
  const engine = new Engine({ config, client, dbPath: path.resolve(root, config.dbPath), memberProvider: () => readConfig(root) });
  let salesDetails = {}, staffAdmin;
  try {
    if(config.staffManagement?.enabled){
      const staff=new Roster({config,db:engine.db,client});
      staff.assertLiveConfig=()=>engine.refreshMembers({persist:false});
      const admin = new Admin(config, { sourceClient: client });
      staffAdmin = admin;
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
      assertLiveConfig: () => engine.refreshMembers({ persist: false }),
      clientFactory: appToken => {
        if (!clients.has(appToken)) clients.set(appToken, new WorkflowClient({ ...engine.config, appToken }));
        return clients.get(appToken);
      },
      readSource: id => engine.readSource(id), resolveSource: () => engine.resolveSource() });
    if (enableAttachmentRuntime) {
      try {
        const bindings = readAttachmentConfig(root, config);
        engine.attachmentSetupState = bindings ? 'disabled' : 'not_configured';
        if (bindings?.enabled) {
          const verifyLiveConfig = async () => {
            if (!engine.staff?.healthy || engine.staffFailure ||
              JSON.stringify(readAttachmentConfig(root, config)) !== JSON.stringify(bindings)) return false;
            await engine.refreshMembers({ persist: false });
            return engine.config.enabled && engine.config.notification.enabled;
          };
          engine.attachments = createAttachmentRuntime({
            db: engine.db, client, admin: staffAdmin, source: bindings.source, targetPins: bindings.targetPins,
            enabledRoles: [...new Set(bindings.targetPins.map(pin => pin.role))], verifyLiveConfig,
            verifyEffectiveAcl: createAttachmentAclVerifier(bindings.targetPins),
            readCurrentStaff: (id, { client: scopedClient }) => {
              const staff = Object.create(engine.staff);
              staff.client = scopedClient;
              return staff.readCurrent(id);
            },
          });
          engine.attachmentSetupState = 'enabled';
        }
      } catch (error) {
        engine.attachmentSetupState = 'blocked';
        const code = safeCode(error);
        engine.attachmentError = code.startsWith('ATTACHMENT_') ? code : 'ATTACHMENT_CONFIG_INVALID';
      }
    }
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
  let engine, events, timer, watcher, eventStart, stopping = false, phase = 'starting', dirty = true, nextScan = Date.now(), retryEventsAt = 0, lastErrorCode = '', eventErrorCode = '', masterEventGeneration = 0, priorityEventGeneration = 0;
  let detailController = null, detailsAvailable = false, detailsPendingSince = null, nextDetailsAt = 0, lastIdleTask = 'attachments';
  let fullScanPreemptions = 0, lastFullScanAt = Date.now();
  const wake = () => { dirty = true; detailController?.abort(); };
  const stop = () => { stopping = true; detailController?.abort(); };
  const shouldStop = () => { if (stopping) return true; try { if (stopRequested(lease)) stop(); } catch { stop(); } return stopping; };
  const snapshot = () => writeSnapshot(root, { kind: KIND, runnerVersion: 2, runnerRelease: WORKFLOW_RELEASE, ...lease.lock, checkedAt: new Date().toISOString(), phase,
    connection: { ...(events?.status?.() || { state: 'polling' }), ...(eventErrorCode ? { lastErrorCode: eventErrorCode } : {}) }, ...safeStatus(engine), lastErrorCode,
    nextScanAt: new Date(nextScan).toISOString(), enabled: true, notificationsEnabled: true });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    client ||= new WorkflowClient(config);
    engine = await makeEngine(config, { root, client, enableAttachmentRuntime: true });
    if (!engine.status().initialized) fail('WORKFLOW_INITIALIZATION_REQUIRED');
    events = new Events(engine.config || config, { currentConfig: () => engine.config || config });
    const configStamp=()=>{const value=statSync(path.join(root,'config.workflow.local.json'));return `${value.mtimeMs}/${value.size}`;};
    let previousConfigStamp=configStamp();
    timer = setInterval(() => { try { snapshot(); } catch { stop(); } }, 5000);
    watcher = setInterval(()=>{
      shouldStop();
      if (config.events !== false && events.status().state !== 'connected') {
        nextScan = Math.min(nextScan, Date.now() + EVENT_FALLBACK_POLL_SECONDS * 1000);
        detailController?.abort();
      }
      try{const current=configStamp();if(current!==previousConfigStamp){previousConfigStamp=current;wake();}}catch{stop();}
    },1000);
    while (!shouldStop()) {
      const state = events.status().state;
      if (config.events !== false && !eventStart && !['connected','connecting','reconnecting'].includes(state) && Date.now() >= retryEventsAt) {
        retryEventsAt = Date.now() + 60000;
        eventStart = (async () => {
          await events.stop();
          if (shouldStop()) return;
          await events.start(async event => {
            const accepted = await engine.acceptEvent?.(event);
            if (!accepted) return;
            const source = engine.config || config;
            const master = event.appToken === source.appToken && event.tableId === source.tableIds?.leads;
            if (master) masterEventGeneration++;
            if (master || engine.isSalesEvent?.(event)) priorityEventGeneration++;
            wake();
          });
          eventErrorCode = '';
        })().catch(error => { eventErrorCode = safeCode(error); }).finally(() => { eventStart = null; });
      }
      if (shouldStop()) break;
      if (dirty || Date.now() >= nextScan) {
        dirty = false; phase = 'scanning'; snapshot();
        try {
          const beforeQuick = priorityEventGeneration, masterBeforeQuick = masterEventGeneration;
          await engine.processPendingEvents?.({ shouldStop, shouldDeferSales: () => masterEventGeneration !== masterBeforeQuick });
          if (shouldStop()) break;
          const fullRequired = fullScanPreemptions >= MAX_FULL_SCAN_PREEMPTIONS || Date.now() - lastFullScanAt >= MAX_FULL_SCAN_DEFERRAL_MS;
          if (priorityEventGeneration !== beforeQuick && !fullRequired && !shouldStop()) { fullScanPreemptions++; continue; }
          dirty = false;
          const scanGeneration = priorityEventGeneration;
          const result = await engine.scan({ apply: true,
            shouldStop: () => shouldStop() || !fullRequired && priorityEventGeneration !== scanGeneration, deferSalesDetails: true });
          if (result?.stopped && !shouldStop()) fullScanPreemptions++;
          else if (result?.ok === true && !result.stopped) { fullScanPreemptions = 0; lastFullScanAt = Date.now(); }
          const detailState = engine.status();
          detailsAvailable = (detailState.salesDetailsReady ?? result?.salesDetailsReady) === true && typeof engine.syncDeferredSalesDetails === 'function';
          if (detailsAvailable) detailsPendingSince ??= Date.now();
          if (detailState.salesDetails?.detailOldestPendingAt > 0) detailsPendingSince = detailState.salesDetails.detailOldestPendingAt;
          if (detailState.salesDetails?.detailPending === 0) detailsPendingSince = null;
          if (detailState.salesDetails?.detailNextAttemptAt > 0) nextDetailsAt = Math.min(nextDetailsAt, detailState.salesDetails.detailNextAttemptAt);
          lastErrorCode = result?.ok === false ? safeCode(result.errors?.[0]) : '';
          const retry = result?.nextRetryAt ?? engine.status().nextRetryAt;
          const staffOnly=engine.status().staff?.healthy===true&&result?.errors?.length>0&&result.errors.every(error=>safeCode(error).startsWith('STAFF_'));
          const pollSeconds = config.events !== false && events.status().state !== 'connected'
            ? Math.min(config.pollSeconds || 600, EVENT_FALLBACK_POLL_SECONDS) : config.pollSeconds || 600;
          nextScan = nextScanTime({pollSeconds,hasError:Boolean(lastErrorCode)&&!staffOnly,nextRetryAt:retry});
        } catch (error) {
          lastErrorCode = safeCode(error);
          detailsAvailable = engine.status().salesDetailsReady === true;
          const disconnected = config.events !== false && events.status().state !== 'connected';
          nextScan = Date.now() + (disconnected ? EVENT_FALLBACK_POLL_SECONDS * 1000 : 60000);
        }
        phase = lastErrorCode ? 'scan_error' : 'polling'; snapshot();
      }
      const now = Date.now();
      const attachmentDue = engine.attachmentDueAt?.();
      // Repeated compensation retries must eventually yield one bounded slice.
      // Incoming events still abort that slice through wake().
      const detailsOverdue = detailsPendingSince !== null && now - detailsPendingSince >= MAX_SALES_DETAIL_DEFERRAL_MS;
      const canRunDetails = detailsAvailable && now >= nextDetailsAt && (nextScan - now > SALES_DETAIL_BUDGET_MS || detailsOverdue);
      const canRunAttachments = (config.events === false || events.status().state === 'connected')
        && Number.isSafeInteger(attachmentDue) && attachmentDue <= now && nextScan - now >= 20_000;
      if (!dirty && !shouldStop() && canRunAttachments && (!canRunDetails || lastIdleTask === 'details')) {
        detailController = new AbortController();
        lastIdleTask = 'attachments';
        try {
          const signal = AbortSignal.any([detailController.signal, AbortSignal.timeout(nextScan - now)]);
          await engine.syncDeferredAttachments({ shouldStop, signal });
        } finally {
          detailController = null;
        }
      } else if (canRunDetails && !dirty && !shouldStop()) {
        detailController = new AbortController();
        lastIdleTask = 'details';
        try {
          const detail = await engine.syncDeferredSalesDetails({ shouldStop, signal: detailController.signal });
          detailsAvailable = (detail?.detailPending || 0) > 0;
          if (detail?.detailOldestPendingAt > 0) detailsPendingSince = detail.detailOldestPendingAt;
          else if (!detailsAvailable) detailsPendingSince = null;
          nextDetailsAt = detail?.detailNextAttemptAt > Date.now() ? detail.detailNextAttemptAt : Date.now() + (detail?.detailRateLimited ? 30_000 : 2000);
        } catch {
          detailsAvailable = engine.status().salesDetailsReady === true;
          nextDetailsAt = Date.now() + 30_000;
        } finally {
          detailController = null;
        }
      }
      if (!dirty && !shouldStop()) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    clearInterval(timer); clearInterval(watcher); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { try { await events?.stop(); } finally { await eventStart; } } finally { try { if (engine) { phase = 'stopped'; snapshot(); await engine.close(); } } finally { lease.release(); } }
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
  if (action === '--audit-orders') {
    const orders = readFeatureConfig(ROOT, 'config.orders.local.json');
    if (!orders) fail('ORDER_AUDIT_CONFIG_MISSING');
    const result = await orderReadinessReport({ config: orders, client, admin: new StaffAdminClient(config, { sourceClient: client }) });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
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
