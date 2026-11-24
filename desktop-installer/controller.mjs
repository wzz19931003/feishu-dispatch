import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyRelease } from './deploy.mjs';
import { checkGitHubUpdate, downloadGitHubArchive } from './feed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanCode = value => /^[A-Z][A-Z0-9_]{2,90}$/.test(value || '') ? value : 'INSTALL_FAILED';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(String(bytes).replace(/^\uFEFF/, ''));
const versionPattern = /^2\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const windows = process.env.WINDIR || 'C:\\Windows';
const psHome = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0');
const ps = path.join(psHome, 'powershell.exe');
const runPowerShell = (script, args, root, code) => executable(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], root, code);

async function regular(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('INSTALL_FILE_UNSAFE');
  return readFile(file);
}

async function executable(binary, args, cwd, code) {
  try {
    return await run(binary, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 140_000, maxBuffer: 512_000,
      env: { ...process.env, PSModulePath: path.join(psHome, 'Modules') } });
  } catch (error) {
    try { const reply = parse(error.stdout); if (reply?.ok === false && reply.code) fail(cleanCode(reply.code)); }
    catch (report) { if (report.code) throw report; }
    fail(code);
  }
}

async function replaceConfig(filename, before, after) {
  if (digest(await regular(filename)) !== digest(before)) fail('PRIVATE_CONFIG_CHANGED');
  const temp = `${filename}.${randomUUID()}.setup-pending`;
  await writeFile(temp, after, { flag: 'wx', mode: 0o600 });
  if (digest(await regular(filename)) !== digest(before)) fail('PRIVATE_CONFIG_CHANGED');
  await rename(temp, filename);
}

async function optionalJson(file) {
  try { return parse(await regular(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readVersion(root) {
  try {
    const raw = String(await regular(path.join(root, 'production-v2', 'version.mjs')));
    const match = /^export const WORKFLOW_RELEASE = '([^']+)';\s*$/.exec(raw);
    if (!match || !versionPattern.test(match[1])) fail('WORKFLOW_RELEASE_INVALID');
    return match[1];
  } catch (error) { if (error.code === 'ENOENT') return '2.0.0'; throw error; }
}

async function prepareOnline(root, requiredVersion) {
  const channel = await optionalJson(path.join(here, 'channel.json'));
  if (!channel) fail('GITHUB_CHANNEL_NOT_CONFIGURED');
  const installedVersion = await readVersion(root);
  const offer = await checkGitHubUpdate(channel, installedVersion);
  if (!requiredVersion) return { ok: true, installedVersion, updateAvailable: Boolean(offer), version: offer?.version };
  if (!offer || offer.version !== requiredVersion) fail('UPDATE_VERSION_CHANGED_CHECK_AGAIN');
  const area = path.join(here, `github-update-${randomUUID()}`);
  await mkdir(area);
  const manifestFile = path.join(area, 'verified-manifest.json');
  const zip = path.join(area, 'verified.zip');
  const engine = path.join(area, 'engine');
  await writeFile(zip, await downloadGitHubArchive(offer), { flag: 'wx' });
  await writeFile(manifestFile, JSON.stringify(offer.manifest), { flag: 'wx' });
  await runPowerShell(path.join(here, 'unpack-release.ps1'), ['-Archive', zip, '-Destination', engine, '-Manifest', manifestFile], area, 'ZIP_CONTENT_INVALID');
  return { engine, manifest: offer.manifest };
}

async function useExistingProject(root, startup, shouldResume, online = null) {
  if (process.platform !== 'win32') fail('WINDOWS_REQUIRED');
  const configFile = path.join(root, 'config.workflow.local.json');
  const database = path.join(root, 'data', 'workflow.sqlite');
  const engine = online?.engine || path.join(here, 'engine');
  const manifest = online?.manifest || parse(await regular(path.join(engine, 'manifest.json')));
  const allowlist = parse(await regular(path.join(here, 'allowlist.json')));
  const configBefore = await regular(configFile);
  const rawConfig = parse(configBefore);
  const resource = await optionalJson(path.join(here, 'staff-binding.json'));
  if (!versionPattern.test(manifest.version) || manifest.format !== (online ? 'feishu-dispatch-update-v1' : 'shiyeji-workflow-code-v2')) fail('INSTALL_MANIFEST_INVALID');
  if (resource && resource.format !== 'shiyeji-staff-resource-v1') fail('INSTALL_BINDING_INVALID');
  if (resource && (rawConfig.appId !== resource.appId || rawConfig.appToken !== resource.source.appToken || rawConfig.tableIds?.leads !== resource.source.tableId)) fail('NOT_SHIYEJI_PRODUCTION_PROJECT');
  if (typeof rawConfig.allowedHost !== 'string' || rawConfig.allowedHost.toLowerCase() !== hostname().toLowerCase()) fail('NOT_CONFIGURED_PRODUCTION_COMPUTER');
  const installedVersion = await readVersion(root);
  const triple = value => value.split('.').map(Number);
  const old = triple(installedVersion), proposed = triple(manifest.version);
  const difference = proposed[0] - old[0] || proposed[1] - old[1] || proposed[2] - old[2];
  if (difference < 0 || online && difference <= 0) fail('WORKFLOW_DOWNGRADE_REFUSED');
  const bindStaff = Boolean(resource && rawConfig.staffManagement?.enabled !== true);
  let nextRawConfig = bindStaff ? { ...rawConfig, staffManagement: resource.staffManagement } : rawConfig;
  // Verify extracted code before importing the release's configuration validator.
  if (new Set(manifest.files.map(file => file.path)).size !== allowlist.length || allowlist.some(item => !manifest.files.some(file => file.path === item))) fail('INSTALL_RELEASE_INVENTORY_INVALID');
  for (const item of allowlist) {
    const file = manifest.files.find(entry => entry.path === item);
    const bytes = await regular(path.join(engine, item));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('INSTALL_RELEASE_HASH_MISMATCH');
  }
  if (await readVersion(engine) !== manifest.version) fail('INSTALL_RELEASE_VERSION_MISMATCH');
  const { pathToFileURL } = await import('node:url');
  const needsV22Preparation = Number(manifest.version.split('.')[1]) >= 2 && nextRawConfig.staffManagement?.enabled === true;
  if (needsV22Preparation) {
    const { prepareV22Config } = await import(pathToFileURL(path.join(engine, 'production-v2', 'prepare-v22-config.mjs')).href);
    const { WorkflowClient } = await import(pathToFileURL(path.join(engine, 'production-v2', 'client.mjs')).href);
    const prepared = await prepareV22Config(nextRawConfig, new WorkflowClient(nextRawConfig));
    if (!prepared || prepared.staffManagement?.enabled !== true || prepared.staffManagement.operatorViews?.enabled !== true) fail('V22_FEATURES_NOT_READY');
    for (const key of ['appId', 'appSecret', 'appToken', 'allowedHost', 'enabled']) {
      if (prepared[key] !== nextRawConfig[key]) fail('V22_PROTECTED_CONFIG_CHANGED');
    }
    if (JSON.stringify(prepared.notification) !== JSON.stringify(nextRawConfig.notification)
      || JSON.stringify(prepared.tableIds) !== JSON.stringify(nextRawConfig.tableIds)
      || JSON.stringify(prepared.members) !== JSON.stringify(nextRawConfig.members)) fail('V22_PROTECTED_CONFIG_CHANGED');
    nextRawConfig = prepared;
  }
  const { validateWorkflowConfig } = await import(pathToFileURL(path.join(engine, 'production-v2', 'field-map.mjs')).href);
  const candidate = validateWorkflowConfig(nextRawConfig);
  const nextConfig = Buffer.from(`${JSON.stringify(nextRawConfig, null, 2)}\n`, 'utf8');
  const configurationChanged = JSON.stringify(nextRawConfig) !== JSON.stringify(rawConfig);

  const dataDir = await lstat(path.dirname(database));
  if (!dataDir.isDirectory() || dataDir.isSymbolicLink()) fail('INSTALL_DB_DIRECTORY_UNSAFE');
  const dbStat = await lstat(database);
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink !== 1) fail('INSTALL_DB_INVALID');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const initialized = db.prepare("SELECT value FROM v2_meta WHERE key='initialized'").get();
    if (!initialized || !JSON.parse(initialized.value)) fail('EXISTING_WORKFLOW_NOT_INITIALIZED');
  } finally { db.close(); }

  const taskBridge = path.join(here, 'task-bridge.ps1');
  const callTask = async (mode, startupMode = startup) => {
    const { stdout } = await runPowerShell(taskBridge, ['-Mode', mode, '-Project', root, '-Startup', startupMode], root, 'TASK_BRIDGE_FAILED');
    const reply = parse(stdout);
    if (!reply.ok) fail(cleanCode(reply.code));
    return reply;
  };
  const initial = await callTask('inspect');
  const node = initial.nodePath;
  const runNode = (args, code) => executable(node, args, root, code);
  const cli = path.join(root, 'production-v2', 'cli.mjs');
  if (initial.listener.processStatus === 'alive' && initial.taskState !== 'Running') fail('TASK_LISTENER_NOT_OWNED');
  if (initial.listener.runnerRelease && initial.listener.runnerRelease !== installedVersion && installedVersion !== '2.0.0') fail('RUNNING_RELEASE_UNSUPPORTED');
  const shouldArm = startup === 'on' || (startup === 'preserve' && initial.taskState !== 'Disabled');
  const activeConfig = candidate.enabled && candidate.notification.enabled;
  let backupFolder, changedConfig = false, suspended = false, taskStartRequested = false;

  const suspend = async () => {
    if (!suspended) { await callTask('suspend'); suspended = true; }
  };
  try {
    const result = await applyRelease({
      root, stagedRoot: engine, manifest, allowlist, shouldResume,
      status: async () => {
        const data = (await callTask('inspect')).listener;
        return data;
      },
      preflight: async ({ phase }) => {
        if (phase === 'preflight') {
          const { stdout } = await runNode([cli, '--check'], 'EXISTING_PREFLIGHT_FAILED');
          if (!parse(stdout).allowedHostIsThisHost) fail('NOT_CONFIGURED_PRODUCTION_COMPUTER');
          await runNode(['--input-type=module', '-e', "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1); await import('@larksuiteoapi/node-sdk');"], 'EXISTING_RUNTIME_INVALID');
          if (digest(await regular(configFile)) !== digest(configBefore)) fail('PRIVATE_CONFIG_CHANGED');
          return;
        }
        await callTask('configure');
        if (configurationChanged) {
          await replaceConfig(configFile, configBefore, nextConfig);
          changedConfig = true;
        }
        try {
          const { stdout } = await runNode([cli, '--check'], 'INSTALLED_PREFLIGHT_FAILED');
          if (!parse(stdout).allowedHostIsThisHost) fail('NOT_CONFIGURED_PRODUCTION_COMPUTER');
          await runNode([cli, '--inspect'], 'FEISHU_SCHEMA_CHECK_FAILED');
        } catch (error) {
          if (changedConfig) {
            await replaceConfig(configFile, nextConfig, configBefore);
            changedConfig = false;
          }
          throw error;
        }
      },
      stop: suspend,
      backup: async () => {
        await suspend();
        if (digest(await regular(configFile)) !== digest(configBefore)) fail('PRIVATE_CONFIG_CHANGED');
        const backupRoot = path.join(root, 'backups');
        const parent = await lstat(backupRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) fail('SQLITE_BACKUP_PATH_INVALID');
        const { stdout } = await runNode([path.join(root, 'production-v2', 'backup.mjs')], 'SQLITE_BACKUP_FAILED');
        const receipt = parse(stdout);
        if (receipt.integrity !== 'ok' || !path.isAbsolute(receipt.folder || '')) fail('SQLITE_BACKUP_FAILED');
        const backupPath = path.resolve(receipt.folder);
        if (!backupPath.toLowerCase().startsWith(path.join(root, 'backups').toLowerCase() + path.sep)) fail('SQLITE_BACKUP_PATH_INVALID');
        backupFolder = backupPath;
        await writeFile(path.join(backupFolder, 'config.workflow.before-setup.private.json'), configBefore, { flag: 'wx', mode: 0o600 });
        return receipt;
      },
      start: async () => {
        taskStartRequested = true;
        await callTask('start');
        const deadline = Date.now() + 120_000;
        do {
          const state = (await callTask('inspect')).listener;
          const staffReady = !candidate.staffManagement?.enabled || state.staffHealthy === true;
          if (state.runnerRelease === manifest.version && state.running && state.statusFresh && staffReady && state.phase === 'polling' && !state.lastErrorCode) return;
          await wait(2500);
        } while (Date.now() < deadline);
        fail('INSTALLED_HEARTBEAT_UNVERIFIED');
      },
    });
    const scheduled = !result.resumed && shouldArm && activeConfig ? await callTask('arm') : await callTask('inspect');
    return { ok: true, version: manifest.version, backupFolder, recoveryDir: result.recoveryDir, staffBound: Boolean(candidate.staffManagement?.enabled),
      v22Configured: needsV22Preparation, resumed: result.resumed, healthVerified: result.resumed, loginEnabled: scheduled.loginEnabled && scheduled.taskState !== 'Disabled' };
  } catch (error) {
    if (!taskStartRequested && error.rollback === 'code_restored' && changedConfig) {
      await replaceConfig(configFile, nextConfig, configBefore);
      changedConfig = false;
    }
    if (suspended && !taskStartRequested && error.rollback === 'code_restored') {
      await callTask('configure', initial.loginEnabled ? 'on' : 'off').catch(() => {});
    }
    error.backupFolder = backupFolder;
    throw error;
  }
}

function args(values) {
  const action = values[0];
  if (!['install', 'check', 'update'].includes(action) || values.length !== { install: 7, check: 3, update: 9 }[action]) fail('INSTALL_ARGS_INVALID');
  const flags = new Map();
  for (let i = 1; i < values.length; i += 2) {
    if (flags.has(values[i])) fail('INSTALL_ARGS_INVALID');
    flags.set(values[i], values[i + 1]);
  }
  const root = flags.get('--root'), startup = flags.get('--startup'), resume = flags.get('--resume');
  const version = flags.get('--version');
  if (!root || !path.isAbsolute(root) || action !== 'check' && (!['preserve', 'on', 'off'].includes(startup) || !['true', 'false'].includes(resume)) || action === 'update' && !versionPattern.test(version || '')) fail('INSTALL_ARGS_INVALID');
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root) fail('INSTALL_PROJECT_INVALID');
  return { action, root: normalized, startup, resume: resume === 'true', version };
}

try {
  const { action, root, startup, resume, version } = args(process.argv.slice(2));
  if (action === 'check') console.log(JSON.stringify(await prepareOnline(root)));
  else console.log(JSON.stringify(await useExistingProject(root, startup, resume, action === 'update' ? await prepareOnline(root, version) : null)));
}
catch (error) {
  console.log(JSON.stringify({ ok: false, code: cleanCode(error.code || error.message), stage: error.stage, rollback: error.rollback, backupFolder: error.backupFolder, recoveryDir: error.recoveryDir, startRequested: error.startRequested }));
  process.exitCode = 1;
}
