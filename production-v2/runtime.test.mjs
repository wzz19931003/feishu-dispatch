import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertActivation, run, parseArgs, nextScanTime, createEngine, inspect } from './cli.mjs';
import { workflowConfig } from './test-fixtures.mjs';
import { WorkflowEvents } from './events.mjs';
import { createBackup } from './backup.mjs';
import { restore } from './restore.mjs';
import { requestStop } from '../production/control.mjs';

test('v2 rejects disabled or wrong-host activation before engine, network, or lock', async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-guard-'));let calls=0;
  const options={root,host:'PRODUCTION-PC',makeEngine(){calls++;throw new Error('unexpected');}};
  await assert.rejects(run({enabled:false,notification:{enabled:true},allowedHost:'PRODUCTION-PC'},options),{code:'WORKFLOW_DISABLED'});
  await assert.rejects(run({enabled:true,notification:{enabled:true},allowedHost:'DEVELOPER-PC'},options),{code:'WORKFLOW_HOST_NOT_ALLOWED'});
  assert.equal(calls,0);assert.equal(existsSync(path.join(root,'data')),false);
  assert.doesNotThrow(()=>assertActivation({enabled:true,notification:{enabled:true},allowedHost:'production-pc'},'PRODUCTION-PC'));
  assert.doesNotThrow(()=>assertActivation({enabled:true,notification:{enabled:true},allowedHost:'飞书派单生产电脑'},'飞书派单生产电脑'));
  assert.throws(()=>assertActivation({enabled:true,notification:{enabled:true},allowedHost:'飞书派单生产电脑'},'开发电脑'),{code:'WORKFLOW_HOST_NOT_ALLOWED'});
});
test('only explicit single actions are accepted',()=>{
  assert.equal(parseArgs(['--status']),'--status');assert.equal(parseArgs(['--activation-check']),'--activation-check');
  assert.throws(()=>parseArgs([]),{code:'ARGS_INVALID'});assert.throws(()=>parseArgs(['--check','--run']),{code:'ARGS_INVALID'});
});
test('a mirror setup error closes an already-created engine',async()=>{
  let closed=0;
  class FakeEngine{constructor({config}){this.config=config;this.db={};}async close(){closed++;}}
  class BrokenMirror{constructor(){throw Object.assign(new Error('setup failed'),{code:'MIRROR_TEST_FAILURE'});}}
  await assert.rejects(createEngine({dbPath:'data/workflow.sqlite'},{root:tmpdir(),client:{},Engine:FakeEngine,Mirror:BrokenMirror}),{code:'MIRROR_TEST_FAILURE'});
  assert.equal(closed,1);
});
test('personal clients and tenant-token cache are reused instead of reauthenticating per customer',async()=>{
  const config=workflowConfig();
  class FakeEngine{constructor({config}){this.config=config;this.db={};}async close(){}}
  class CapturingMirror{constructor(options){this.clientFactory=options.clientFactory;}}
  const sourceClient={},engine=await createEngine(config,{root:tmpdir(),client:sourceClient,Engine:FakeEngine,Mirror:CapturingMirror});
  const factory=engine.mirror.clientFactory,first=factory(config.members[0].target.appToken);let authentications=0;
  first.fetch=async()=>{authentications++;return new Response(JSON.stringify({access_token:'fake-offline-token',expires_in:7200}),{status:200,headers:{'content-type':'application/json'}});};
  await first.tenantToken();await factory(config.members[0].target.appToken).tenantToken();
  assert.equal(authentications,1);assert.equal(factory(config.appToken),sourceClient);
  assert.equal(factory(config.members[0].target.appToken),first);assert.notEqual(factory(config.members[1].target.appToken),first);
});
test('online schema inspection also checks disabled members that can be manually assigned',async()=>{
  const config=workflowConfig();config.members[1].enabled=false;const seen=[];
  const targets=[{appToken:config.appToken,fields:config.fields.leads},...config.members.map(m=>m.target)];
  const client={async api(url){const target=targets.find(t=>url.includes('/'+t.appToken+'/'));assert(target);seen.push(target.appToken);return{items:Object.entries(target.fields).map(([key,spec])=>({field_id:spec.fieldId,field_name:key,type:spec.types[0],property:{multiple:false}})),has_more:false};}};
  const result=await inspect(config,client);assert.equal(result.targetsChecked,3);assert(seen.includes(config.members[1].target.appToken));
});
test('feedback and pending events wake before the ten-minute compensation scan',()=>{
  assert.equal(nextScanTime({now:1000,pollSeconds:600,nextRetryAt:2000}),2000);
  assert.equal(nextScanTime({now:1000,pollSeconds:600,nextRetryAt:500}),2000);
  assert.equal(nextScanTime({now:1000,pollSeconds:600}),601000);
  assert.equal(nextScanTime({now:1000,pollSeconds:600,hasError:true,nextRetryAt:2000}),61000);
});
test('the runner preempts only deferred work when a core event arrives', { timeout: 5000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'shiyeji-v2-idle-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'config.workflow.local.json'), '{}');
  let eventHandler, scans = 0;
  const calls = [];
  class FakeEvents {
    status() { return { state: eventHandler ? 'connected' : 'idle' }; }
    async start(handler) { eventHandler = handler; }
    async stop() {}
  }
  const engine = {
    status: () => ({ initialized: true }),
    async scan(options) {
      assert.equal(options.deferSalesDetails, true);
      calls.push('core scan');
      if (++scans === 2) requestStop(root);
      return { ok: true };
    },
    async acceptEvent() { calls.push('core event'); },
    async syncDeferredSalesDetails({ signal }) {
      calls.push('idle slice');
      await eventHandler({ id: 'fixture-event' });
      assert.equal(signal.aborted, true);
      calls.push('idle cancelled');
      return { detailPreempted: 1, detailPending: 2 };
    },
    async close() { calls.push('closed'); },
  };
  await run({ enabled: true, notification: { enabled: true }, allowedHost: 'OFFLINE-FIXTURE', pollSeconds: 600 },
    { root, host: 'OFFLINE-FIXTURE', client: {}, Events: FakeEvents, makeEngine: async () => engine });
  assert.deepEqual(calls, ['core scan', 'idle slice', 'core event', 'idle cancelled', 'core scan', 'closed']);
});
function fakeSdk(){
  const captured={closes:0,handlers:{}};
  return {captured,sdk:{EventDispatcher:class{register(handlers){captured.handlers=handlers;return this;}},WSClient:class{
    constructor(options){this.options=options;}
    start(){this.options.onReady();}
    async close(){captured.closes++;}
  }}};
}
test('one event stream accepts only exact configured master and personal table identities',async()=>{
  const {captured,sdk}=fakeSdk(),received=[];
  const config={appId:'fake-app',appSecret:'fake-secret',appToken:'MASTER',tableIds:{leads:'LEADS'},members:[{target:{appToken:'CHILD',tableId:'PERSONAL'}}]};
  const events=new WorkflowEvents(config,{sdkLoader:async()=>sdk,timeoutMs:500});
  await events.start(e=>received.push(`${e.appToken}/${e.tableId}`));
  const deliver=async(base,table)=>captured.handlers['drive.file.bitable_record_changed_v1']({header:{event_id:'test'},event:{file_token:base,table_id:table,action_list:[{record_id:'rec_test',action:'record_edited'}]}});
  await deliver('MASTER','LEADS');await deliver('CHILD','PERSONAL');await deliver('CHILD','OTHER');await deliver('FOREIGN','LEADS');
  assert.deepEqual(received,['MASTER/LEADS','CHILD/PERSONAL']);
  config.members.push({target:{appToken:'NEWCHILD',tableId:'NEWPERSONAL'}});
  await deliver('NEWCHILD','NEWPERSONAL');assert.equal(received.length,3);
  config.members.splice(0,1);await deliver('CHILD','PERSONAL');assert.equal(received.length,3);
  const oldHandler=captured.handlers['drive.file.bitable_record_changed_v1'];await events.stop();
  await oldHandler({event:{file_token:'MASTER',table_id:'LEADS'}});
  assert.equal(received.length,3);assert.equal(captured.closes,1);assert.equal(events.status().state,'stopped');
});
test('event shutdown drains an accepted callback before finishing',async()=>{
  const {captured,sdk}=fakeSdk();let release,done=false;
  const blocked=new Promise(resolve=>{release=resolve;});
  const events=new WorkflowEvents({appToken:'MASTER',tableIds:{leads:'LEADS'},members:[]},{sdkLoader:async()=>sdk,timeoutMs:500});
  await events.start(async()=>{await blocked;done=true;});
  const processing=captured.handlers['drive.file.bitable_record_changed_v1']({event:{file_token:'MASTER',table_id:'LEADS'}});
  await Promise.resolve();const stopping=events.stop();await Promise.resolve();assert.equal(done,false);
  release();await Promise.all([processing,stopping]);assert.equal(done,true);
});
test('durable inbox failure rejects the event instead of acknowledging loss',async()=>{
  const {captured,sdk}=fakeSdk();
  const events=new WorkflowEvents({appToken:'MASTER',tableIds:{leads:'LEADS'},members:[]},{sdkLoader:async()=>sdk,timeoutMs:500});
  await events.start(async()=>{throw new Error('private database detail must not escape');});
  await assert.rejects(captured.handlers['drive.file.bitable_record_changed_v1']({event:{file_token:'MASTER',table_id:'LEADS'}}),{code:'EVENT_HANDLER_FAILED'});
  assert.equal(events.status().state,'handler_error');await events.stop();
});
test('SDK close failure still drains callbacks before the database may close',async()=>{
  const {captured,sdk}=fakeSdk();sdk.WSClient.prototype.close=async()=>{throw new Error('close failed');};
  let release,finished=false;const blocked=new Promise(resolve=>{release=resolve;});
  const events=new WorkflowEvents({appToken:'MASTER',tableIds:{leads:'LEADS'},members:[]},{sdkLoader:async()=>sdk,timeoutMs:500});
  await events.start(async()=>{await blocked;finished=true;});
  const processing=captured.handlers['drive.file.bitable_record_changed_v1']({event:{file_token:'MASTER',table_id:'LEADS'}});
  await Promise.resolve();const stopping=events.stop();stopping.catch(()=>{});await Promise.resolve();assert.equal(finished,false);
  release();await processing;await assert.rejects(stopping);assert.equal(finished,true);assert.equal(events.status().state,'stopped');
});
test('consistent v2 backup contains committed WAL and restore refuses overwrite and tampering',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-backup-'));mkdirSync(path.join(root,'data'));
  const source=path.join(root,'data/workflow.sqlite'),db=new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL;CREATE TABLE v2_meta(id);CREATE TABLE v2_snapshots(id);CREATE TABLE v2_outbox(id);CREATE TABLE v2_mirrors(id);INSERT INTO v2_snapshots VALUES(1);');
  const backup=await createBackup({root});assert.equal(backup.counts.v2_snapshots,1);assert.equal(backup.integrity,'ok');db.close();
  const destination=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-restored-'));
  assert.equal(restore({from:backup.folder,root:destination}).restored,true);
  assert.throws(()=>restore({from:backup.folder,root:destination}));
  const manifestFile=path.join(backup.folder,'manifest.json'),manifest=JSON.parse(readFileSync(manifestFile));
  manifest.sha256='0'.repeat(64);writeFileSync(manifestFile,JSON.stringify(manifest));
  const rejected=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-rejected-'));
  assert.throws(()=>restore({from:backup.folder,root:rejected}));assert.equal(existsSync(path.join(rejected,'data/workflow.sqlite')),false);
});
