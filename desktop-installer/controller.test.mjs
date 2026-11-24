import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowsOnly = process.platform !== 'win32';
const fingerprint = value => createHash('sha256').update(value).digest('hex');

function write(root, filename, content) {
  const full = path.join(root, filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function fixture(t, { staff = true, rejectPreparation = false, changeActivation = false, rejectInspect = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-controller-fixture-'));
  const payload = path.join(folder, 'payload'), project = path.join(folder, '项目 & production');
  fs.mkdirSync(payload); fs.mkdirSync(project);
  t.after(() => {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  for (const filename of ['controller.mjs', 'deploy.mjs', 'feed.mjs']) fs.copyFileSync(path.join(here, filename), path.join(payload, filename));
  const config = {
    appId: 'cli_fixture', appSecret: 'fixture-only-credential', appToken: 'fixtureSource',
    tableIds: { leads: 'tblFixtureSource' }, fields: { leads: {} }, members: [],
    allowedHost: os.hostname(), enabled: true, notification: { enabled: true, title: 'fixture' },
    fixtureTrace: path.join(project, 'trace.txt'), rejectPreparation, changeActivation, rejectInspect,
    ...(staff ? { staffManagement: { enabled: true, appToken: 'fixtureStaff' } } : {}),
  };
  const beforeConfig = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  write(project, 'config.workflow.local.json', beforeConfig);
  write(project, '.fixture-task.json', JSON.stringify({ active: true, disabled: false, loginEnabled: true }));
  write(project, 'production-v2/version.mjs', "export const WORKFLOW_RELEASE = '2.1.0';\n");
  const database = path.join(project, 'data', 'workflow.sqlite');
  fs.mkdirSync(path.dirname(database));
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE v2_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO v2_meta VALUES('initialized','true'); CREATE TABLE v2_outbox(id TEXT PRIMARY KEY,data TEXT); INSERT INTO v2_outbox VALUES('fixture-once','sent');");
  db.close();
  const beforeDatabase = fs.readFileSync(database);
  write(project, 'node_modules/@larksuiteoapi/node-sdk/package.json', '{"name":"@larksuiteoapi/node-sdk","main":"index.js"}');
  write(project, 'node_modules/@larksuiteoapi/node-sdk/index.js', 'module.exports = {};\n');
  write(project, 'production-v2/cli.mjs', `
import fs from 'node:fs';
const raw=JSON.parse(fs.readFileSync('config.workflow.local.json'));
fs.appendFileSync(raw.fixtureTrace,process.argv[2]+'\\n');
if(process.argv[2]==='--inspect'&&raw.rejectInspect){console.log(JSON.stringify({ok:false,code:'FIXTURE_INSPECT_REJECTED'}));process.exitCode=1;}
else console.log(JSON.stringify({ok:true,allowedHostIsThisHost:true}));
`);
  write(project, 'production-v2/backup.mjs', `
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync,backup} from 'node:sqlite';
const raw=JSON.parse(fs.readFileSync('config.workflow.local.json'));
fs.appendFileSync(raw.fixtureTrace,'backup\\n');
if(raw.staffManagement?.operatorViews?.enabled)throw Error('Configuration changed before backup');
const folder=path.resolve('backups','fixture-consistent');fs.mkdirSync(folder,{recursive:true});
const db=new DatabaseSync('data/workflow.sqlite',{readOnly:true});
try{await backup(db,path.join(folder,'workflow.sqlite'));}finally{db.close();}
console.log(JSON.stringify({integrity:'ok',folder}));
`);
  write(project, 'fake-task.mjs', `
import fs from 'node:fs';import path from 'node:path';
const [mode,root,startup]=process.argv.slice(2),filename=path.join(root,'.fixture-task.json');
const state=JSON.parse(fs.readFileSync(filename));fs.appendFileSync(path.join(root,'trace.txt'),mode+'\\n');
if(mode==='suspend'){state.active=false;state.disabled=true;}
if(mode==='configure'&&startup!=='preserve')state.loginEnabled=startup==='on';
if(mode==='start'){state.active=true;state.disabled=false;}
if(mode==='arm')state.disabled=false;
fs.writeFileSync(filename,JSON.stringify(state));
const version=/WORKFLOW_RELEASE = '([^']+)'/.exec(fs.readFileSync(path.join(root,'production-v2','version.mjs'),'utf8'))[1];
console.log(JSON.stringify({ok:true,nodePath:process.execPath,loginEnabled:state.loginEnabled,taskState:state.active?'Running':state.disabled?'Disabled':'Ready',
listener:{processStatus:state.active?'alive':'absent',runnerRelease:version,running:state.active,statusFresh:true,staffHealthy:true,phase:'polling',lastErrorCode:''}}));
`);
  const nodeQuoted = process.execPath.replaceAll("'", "''");
  write(payload, 'task-bridge.ps1', `param([string]$Mode,[string]$Project,[string]$Startup)\n& '${nodeQuoted}' (Join-Path $Project 'fake-task.mjs') $Mode $Project $Startup\nexit $LASTEXITCODE\n`);
  const engineFiles = {
    'production-v2/version.mjs': "export const WORKFLOW_RELEASE = '2.2.0';\n",
    'production-v2/field-map.mjs': 'export const validateWorkflowConfig = raw => raw;\n',
    'production-v2/client.mjs': 'export class WorkflowClient { constructor(config) { this.config = config; } }\n',
    'production-v2/prepare-v22-config.mjs': `
import fs from 'node:fs';
export async function prepareV22Config(raw,client){
if(client.config!==raw)throw Error('client configuration mismatch');
fs.appendFileSync(raw.fixtureTrace,'prepare\\n');
if(raw.rejectPreparation)throw Object.assign(Error(),{code:'V22_FIXTURE_FIELDS_MISSING'});
return {...raw,...(raw.changeActivation?{enabled:false}:{}),fields:{...raw.fields,leads:{...raw.fields.leads,account:{fieldId:'fldFixtureAccount',types:[1]}}},
staffManagement:{...raw.staffManagement,operatorViews:{enabled:true},fields:{fixture:{fieldId:'fldFixtureStaff',types:[1]}}}};
}
`,
    'production-v2/operator-mirror.mjs': '// fixture-only new module\n',
  };
  const files = Object.entries(engineFiles).map(([filename, content]) => {
    write(path.join(payload, 'engine'), filename, content);
    return { path: filename, bytes: Buffer.byteLength(content), sha256: fingerprint(content) };
  });
  write(payload, 'allowlist.json', JSON.stringify(files.map(file => file.path)));
  write(payload, 'engine/manifest.json', JSON.stringify({ format: 'shiyeji-workflow-code-v2', version: '2.2.0', files }));
  const run = ({ startup = 'preserve', resume = true } = {}) => {
    let output;
    try {
      output = execFileSync(process.execPath, [path.join(payload, 'controller.mjs'), 'install', '--root', project, '--startup', startup, '--resume', String(resume)], {
        cwd: project, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      });
    } catch (error) { output = error.stdout; }
    return JSON.parse(String(output).trim());
  };
  const read = name => fs.readFileSync(path.join(project, name), 'utf8');
  return { project, config, beforeConfig, beforeDatabase, database, run, read, trace: () => read('trace.txt').trim().split('\n') };
}

test('v2.2 staff configuration is prepared before any stop and saved only after a real database backup', { skip: windowsOnly }, t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.ok, true); assert.equal(result.v22Configured, true); assert.equal(result.resumed, true);
  const steps = f.trace();
  assert.equal(steps[0], 'prepare');
  assert.ok(steps.indexOf('prepare') < steps.indexOf('suspend'));
  assert.ok(steps.indexOf('backup') > steps.indexOf('suspend'));
  assert.equal(steps.filter(step => step === 'start').length, 1);
  assert.equal(JSON.parse(f.read('config.workflow.local.json')).staffManagement.operatorViews.enabled, true);
  assert.deepEqual(fs.readFileSync(path.join(result.backupFolder, 'config.workflow.before-setup.private.json')), f.beforeConfig);
  assert.deepEqual(fs.readFileSync(f.database), f.beforeDatabase);
  const snapshot = new DatabaseSync(path.join(result.backupFolder, 'workflow.sqlite'), { readOnly: true });
  try { assert.equal(snapshot.prepare("SELECT data FROM v2_outbox WHERE id='fixture-once'").get().data, 'sent'); }
  finally { snapshot.close(); }
});

test('missing v2.2 fields and activation changes fail before any task or original project mutation', { skip: windowsOnly }, t => {
  for (const settings of [{ rejectPreparation: true }, { changeActivation: true }]) {
    const f = fixture(t, settings), result = f.run();
    assert.equal(result.ok, false);
    assert.equal(result.code, settings.rejectPreparation ? 'V22_FIXTURE_FIELDS_MISSING' : 'V22_PROTECTED_CONFIG_CHANGED');
    assert.deepEqual(f.trace(), ['prepare']);
    assert.deepEqual(fs.readFileSync(path.join(f.project, 'config.workflow.local.json')), f.beforeConfig);
    assert.deepEqual(fs.readFileSync(f.database), f.beforeDatabase);
    assert.match(f.read('production-v2/version.mjs'), /2\.1\.0/);
  }
});

test('postflight rejection restores original configuration and code before any new task start', { skip: windowsOnly }, t => {
  const f = fixture(t, { rejectInspect: true }), result = f.run();
  assert.equal(result.ok, false); assert.equal(result.rollback, 'code_restored'); assert.equal(result.startRequested, false);
  assert.ok(!f.trace().includes('start'));
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'config.workflow.local.json')), f.beforeConfig);
  assert.deepEqual(fs.readFileSync(f.database), f.beforeDatabase);
  assert.match(f.read('production-v2/version.mjs'), /2\.1\.0/);
});

test('legacy projects keep original configuration and the explicit no-resume choice', { skip: windowsOnly }, t => {
  const f = fixture(t, { staff: false }), result = f.run({ startup: 'off', resume: false });
  assert.equal(result.ok, true); assert.equal(result.v22Configured, false);
  assert.equal(result.resumed, false); assert.equal(result.loginEnabled, false);
  assert.ok(!f.trace().includes('prepare')); assert.ok(!f.trace().includes('start'));
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'config.workflow.local.json')), f.beforeConfig);
  assert.deepEqual(fs.readFileSync(f.database), f.beforeDatabase);
});
