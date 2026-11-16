import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {workflowConfig} from './test-fixtures.mjs';
import {captureSchema} from './capture-schema.mjs';
import {attachTarget} from './attach-target.mjs';

test('metadata capture paginates read-only, binds resource identity, and never overwrites output',async()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-schema-')),configFile=path.join(folder,'fake.json'),to=path.join(folder,'schema.json');
  writeFileSync(configFile,JSON.stringify(workflowConfig()));const calls=[];
  const client={async api(url,options){calls.push({url,options});return calls.length===1?{items:[{field_id:'fldFake1'}],has_more:true,page_token:'page2'}:{items:[{field_id:'fldFake2'}],has_more:false};}};
  const result=await captureSchema({configFile,to,client});assert.equal(result.fieldCount,2);assert.equal(calls.length,2);
  assert(calls.every(c=>!c.options.method||c.options.method==='GET'));assert.equal(calls[1].options.query.page_token,'page2');
  const saved=JSON.parse(readFileSync(to));assert.equal(saved.appToken,'OfflineSourceToken123');assert.equal(saved.tableId,'tblOfflineLeads123');
  await assert.rejects(captureSchema({configFile,to,client}));assert.equal(calls.length,2);
});
test('private personal-table binding preserves credentials without console exposure and requires exact captured Base',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-target-')),configFile=path.join(folder,'fake.local.json'),metadataFile=path.join(folder,'fields.json'),to=path.join(folder,'next.local.json');
  const config=workflowConfig({targets:false});writeFileSync(configFile,JSON.stringify(config));
  const metadata={appToken:'OfflinePersonalA123',tableId:'tblPersonalA123',items:[
    {field_id:'fldPersonalWx123',field_name:'微信号',type:1},
    {field_id:'fldPersonalNeeds123',field_name:'客户需求（天数/景点/预算等）',type:1},
    {field_id:'fldPersonalStatus123',field_name:'微信状态',type:3}]};
  writeFileSync(metadataFile,JSON.stringify(metadata));
  assert.throws(()=>attachTarget({configFile,metadataFile,memberId:'sales_A',baseUrl:'https://offline.feishu.cn/base/OtherPersonal123',to}),{code:'TARGET_METADATA_IDENTITY_MISMATCH'});assert.equal(existsSync(to),false);
  const result=attachTarget({configFile,metadataFile,memberId:'sales_A',baseUrl:'https://offline.feishu.cn/base/OfflinePersonalA123',to});
  assert.equal(result.pendingTargets,1);assert.equal(result.started,false);
  const saved=JSON.parse(readFileSync(to));assert.equal(saved.appSecret,config.appSecret);assert.equal(saved.enabled,false);assert.equal(saved.notification.enabled,false);
  assert.equal(saved.members[0].target.appToken,metadata.appToken);assert.equal(JSON.parse(readFileSync(configFile)).members[0].target,null);
  assert.throws(()=>attachTarget({configFile,metadataFile,memberId:'sales_A',baseUrl:'https://offline.feishu.cn/base/OfflinePersonalA123',to}));
});
test('target binding refuses edits to an enabled runtime configuration',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'shiyeji-v2-enabled-')),configFile=path.join(folder,'fake.local.json'),metadataFile=path.join(folder,'fields.json'),to=path.join(folder,'new.local.json');
  const config=workflowConfig({targets:false});config.enabled=true;writeFileSync(configFile,JSON.stringify(config));writeFileSync(metadataFile,'{}');
  assert.throws(()=>attachTarget({configFile,metadataFile,memberId:'sales_A',baseUrl:'https://offline.feishu.cn/base/OfflinePersonalA123',to}),{code:'TARGET_CONFIGURATION_MUST_BE_DISABLED'});
  assert.equal(existsSync(to),false);
});
