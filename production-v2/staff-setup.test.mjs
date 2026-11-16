import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareStaffConfig } from './prepare-staff-config.mjs';
import { workflowConfig } from './test-fixtures.mjs';
import { createBackup } from './backup.mjs';
import { restore } from './restore.mjs';
import { acquireLock,writeSnapshot,status,KIND } from '../production/control.mjs';

function settings(){return{enabled:true,appToken:'OfflineStaffSource123',tableId:'tblOfflineStaff123',fields:Object.fromEntries(Object.entries({employee:11,role:3,enabled:7,order:2,status:1,personalUrl:1,updatedAt:1,error:1}).map(([key,type])=>[key,{fieldId:`fldStaff${key}123`,types:[type]}])),fixedReaders:['示例管理员甲','示例销售乙','示例销售甲','示例管理员乙'].map((displayName,i)=>({displayName,openId:`ou_offlineReader${i}`})),operatorFormUrl:'https://offline.feishu.cn/share/base/form/shrOffline123',seedRecordIds:[]};}

test('task status preserves release and employee health without exposing raw error text',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'shiyeji-staff-status-')),lease=acquireLock(root);
  try{writeSnapshot(root,{kind:KIND,...lease.lock,checkedAt:new Date().toISOString(),runnerRelease:'2.1.0',staffHealthy:false,staffErrors:['STAFF_EMPTY_ROSTER','private detail'],counts:{staff_ready:2}});
    const result=status(root);assert.equal(result.runnerRelease,'2.1.0');assert.equal(result.staffHealthy,false);assert.deepEqual(result.staffErrors,['STAFF_EMPTY_ROSTER','PRODUCTION_OPERATION_FAILED']);assert.equal(JSON.stringify(result).includes('private detail'),false);
  }finally{lease.release();}
});
test('staff one-time binding retains credentials, member IDs and targets but never enables the output',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'shiyeji-staff-bind-')),configFile=path.join(folder,'fake.local.json'),resourceFile=path.join(folder,'resource.json'),to=path.join(folder,'staff.local.json');
  const config=workflowConfig();config.enabled=true;config.notification.enabled=true;
  const resource={format:'shiyeji-staff-resource-v1',appId:config.appId,source:{appToken:config.appToken,tableId:config.tableIds.leads},staffManagement:settings()};
  writeFileSync(configFile,JSON.stringify(config));writeFileSync(resourceFile,JSON.stringify(resource));
  const result=prepareStaffConfig({configFile,resourceFile,to,allowedHost:'REAL-PRODUCTION-ONLY'});assert.equal(result.started,false);
  const saved=JSON.parse(readFileSync(to));assert.equal(saved.enabled,false);assert.equal(saved.notification.enabled,false);assert.equal(saved.allowedHost,'REAL-PRODUCTION-ONLY');assert.deepEqual(saved.members,config.members);assert.equal(saved.appSecret,config.appSecret);assert.equal(JSON.parse(readFileSync(configFile)).enabled,true);
  assert.throws(()=>prepareStaffConfig({configFile,resourceFile,to}),{code:'STAFF_OUTPUT_EXISTS_OR_INVALID'});
  assert.throws(()=>prepareStaffConfig({configFile:to,resourceFile,to:path.join(folder,'again.json')}),{code:'STAFF_ALREADY_BOUND'});
});
test('staff resource binding refuses another source application or personal Base collision',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'shiyeji-staff-deny-')),configFile=path.join(folder,'fake.local.json'),resourceFile=path.join(folder,'resource.json'),to=path.join(folder,'staff.local.json');
  const config=workflowConfig(),resource={format:'shiyeji-staff-resource-v1',appId:'cli_other_application',source:{appToken:config.appToken,tableId:config.tableIds.leads},staffManagement:settings()};writeFileSync(configFile,JSON.stringify(config));writeFileSync(resourceFile,JSON.stringify(resource));
  assert.throws(()=>prepareStaffConfig({configFile,resourceFile,to}),{code:'STAFF_RESOURCE_IDENTITY_MISMATCH'});assert.equal(existsSync(to),false);
  resource.appId=config.appId;resource.staffManagement.appToken=config.members[0].target.appToken;writeFileSync(resourceFile,JSON.stringify(resource));assert.throws(()=>prepareStaffConfig({configFile,resourceFile,to}),{code:'STAFF_TARGET_COLLISION'});
});
test('workflow backup and restore include all employee journals and reject a tampered staff count',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'shiyeji-staff-backup-'));mkdirSync(path.join(root,'data'));
  const db=new DatabaseSync(path.join(root,'data/workflow.sqlite'));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE v2_meta(id);CREATE TABLE v2_snapshots(id);CREATE TABLE v2_outbox(id);CREATE TABLE v2_mirrors(id);CREATE TABLE v2_staff_registry(id,data);CREATE TABLE v2_staff_jobs(id,data);INSERT INTO v2_staff_registry VALUES(1,\'private fake staff mapping\');INSERT INTO v2_staff_jobs VALUES(1,\'review unknown create\');');
  const backup=await createBackup({root});db.close();assert.equal(backup.counts.v2_staff_registry,1);assert.equal(backup.counts.v2_staff_jobs,1);
  const destination=mkdtempSync(path.join(tmpdir(),'shiyeji-staff-restored-'));restore({from:backup.folder,root:destination});
  const restored=new DatabaseSync(path.join(destination,'data/workflow.sqlite'),{readOnly:true});assert.equal(restored.prepare('SELECT data FROM v2_staff_jobs').get().data,'review unknown create');restored.close();
  const filename=path.join(backup.folder,'manifest.json'),manifest=JSON.parse(readFileSync(filename));manifest.counts.v2_staff_jobs=0;writeFileSync(filename,JSON.stringify(manifest));
  assert.throws(()=>restore({from:backup.folder,root:mkdtempSync(path.join(tmpdir(),'shiyeji-staff-invalid-'))}),{message:'RESTORE_COUNTS_INVALID'});
});
