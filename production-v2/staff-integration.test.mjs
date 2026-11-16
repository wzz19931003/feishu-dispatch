import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from './engine.mjs';
import { validateWorkflowConfig } from './field-map.mjs';
import { validateStaffManagement } from './staff-config.mjs';
import { workflowConfig,schema,clone } from './test-fixtures.mjs';

export function staffSettings(){return{enabled:true,appToken:'OfflineStaffBase123',tableId:'tblOfflineStaff123',fields:Object.fromEntries(Object.entries({employee:11,role:3,enabled:7,order:2,notes:1,status:1,personalUrl:1,updatedAt:1,error:1}).map(([key,type])=>[key,{fieldId:`fldStaff${key}123`,types:[type],...(key==='employee'?{multiple:false}:{})}])),fixedReaders:['示例管理员甲','示例销售乙','示例销售甲','示例管理员乙'].map((name,i)=>({displayName:name,openId:`ou_offlineReader${i}`})),operatorFormUrl:'https://offline.feishu.cn/share/base/form/shrOfflineForm123',seedRecordIds:['recSeedEmployee123']};}
class Source {
  constructor(config){this.config=config;this.rows=new Map();this.fields=schema(config);this.writes=[];this.messages=[];this.names=Object.fromEntries(Object.entries(config.fields.leads).map(([key,spec])=>[key,this.fields.find(f=>f.field_id===spec.fieldId).field_name]));}
  add(id,owner=''){this.rows.set(id,{record_id:id,fields:{[this.names.owner]:owner?[{id:owner}]:[],[this.names.operator]:[{id:'ou_offlineOperator123'}],[this.names.wx]:'offline-customer',[this.names.needs]:'offline-needs',[this.names.wxStatus]:'待添加',[this.names.addMethod]:'销售主动加'}});}
  async api(){return{items:clone(this.fields),has_more:false};}
  async listRecords(){return{items:clone([...this.rows.values()]),hasMore:false};}
  async readRecord(_table,id){return clone(this.rows.get(id));}
  async updateRecord(_table,id,fields){this.writes.push(clone(fields));Object.assign(this.rows.get(id).fields,clone(fields));return clone(this.rows.get(id));}
  async sendNotification(input){this.messages.push(clone(input));return{messageId:`offline_message_${this.messages.length}`};}
  owner(id){return this.rows.get(id).fields[this.names.owner][0]?.id||'';}
}
async function fixture(t,{history=false}={}){
  const config=workflowConfig();config.enabled=true;config.notification.enabled=true;config.staffManagement=staffSettings();
  const client=new Source(config);if(history)client.add('recHistory123',config.members[0].openId);
  const staff={healthy:true,refreshCalls:[],async refresh(options){this.refreshCalls.push(options.apply);return{ok:this.healthy,errors:this.healthy?[]:[{code:'STAFF_OFFLINE'}]};},async verifyCandidate(){return this.healthy;},status(){return{healthy:this.healthy,counts:{ready:2},errors:[],nextRetryAt:null};}};
  const engine=new WorkflowEngine({config,client,dbPath:':memory:',memberProvider:()=>({...config,members:config.members.map(m=>({...m,enabled:staff.healthy&&m.enabled}))})});
  engine.staff=staff;engine.mirror={async ensure(view){const member=engine.config.members.find(m=>m.openId===view.owner);return{url:`${member.target.baseUrl}?table=${member.target.tableId}&record=recOfflineMirror123`,targetRecordId:'recOfflineMirror123'};},async sync(){return{sourceWrites:0};}};
  t.after(()=>engine.close());await engine.initialize();return{engine,client,staff,config};
}
test('staff configuration remains optional and binds only a separate private source with four fixed readers',()=>{
  const old=validateWorkflowConfig(workflowConfig());assert.equal(old.staffManagement,undefined);
  const config=workflowConfig();config.staffManagement=staffSettings();assert.equal(validateWorkflowConfig(config).staffManagement.fields.employee.multiple,false);
  assert.throws(()=>validateStaffManagement({...staffSettings(),appToken:config.appToken},{sourceAppToken:config.appToken}),{code:'STAFF_RESOURCE_INVALID'});
  assert.throws(()=>validateStaffManagement({...staffSettings(),operatorFormUrl:config.baseUrl}),{code:'STAFF_FORM_URL_INVALID'});
  assert.throws(()=>validateStaffManagement({...staffSettings(),fixedReaders:staffSettings().fixedReaders.slice(1)}),{code:'STAFF_READERS_INVALID'});
  const bad=staffSettings();bad.fields.employee.types=[1];assert.throws(()=>validateStaffManagement(bad),{code:'STAFF_FIELD_INVALID'});
});
test('staff unavailability stops new automatic assignment and keeps historical manual transfer and mirrors',async t=>{
  const {engine,client,staff,config}=await fixture(t,{history:true});staff.healthy=false;
  client.add('recNew123');client.rows.get('recHistory123').fields[client.names.owner]=[{id:config.members[1].openId}];
  const result=await engine.scan({apply:true});assert.equal(result.ok,false);assert.equal(client.owner('recNew123'),'');
  assert.equal(client.owner('recHistory123'),config.members[1].openId);assert.equal(client.messages.length,1);assert.equal(client.messages[0].recipientOpenId,config.members[1].openId);assert.equal(engine.config.members.length,2);
});
test('candidate disabled during the remote check is not assigned or notified',async t=>{
  const {engine,client,staff}=await fixture(t);client.add('recNew123');staff.verifyCandidate=async()=>false;
  await engine.scan({apply:true});assert.equal(client.owner('recNew123'),'');assert.equal(client.writes.length,0);assert.equal(client.messages.length,0);assert.equal(engine.get('v2_snapshots','recNew123').phase,'awaiting_sales');
});
test('manual source owner change during remote employee validation wins the final source read',async t=>{
  const {engine,client,staff,config}=await fixture(t);client.add('recNew123');staff.verifyCandidate=async()=>{client.rows.get('recNew123').fields[client.names.owner]=[{id:config.members[1].openId}];return true;};
  let tick=1_000_000;engine.now=()=>tick;await engine.scan({apply:true});tick+=5000;await engine.scan({apply:true});assert.equal(client.owner('recNew123'),config.members[1].openId);assert.equal(client.writes.some(write=>Object.hasOwn(write,client.names.owner)),false);assert.equal(client.messages[0].recipientOpenId,config.members[1].openId);
});
test('source field rename during remote employee validation cannot write by a stale field name',async t=>{
  const {engine,client,staff}=await fixture(t);client.add('recNew123');staff.verifyCandidate=async()=>{const f=client.fields.find(f=>f.field_id===engine.config.fields.leads.owner.fieldId);f.field_name='renamed_owner';return true;};
  await engine.scan({apply:true});assert.equal(client.writes.length,0);assert.equal(client.messages.length,0);assert.equal(engine.status().reviews,1);
});
test('employee events persist separately and acknowledge only a successful refresh batch',async t=>{
  const {engine,staff,config}=await fixture(t);const event={id:'evtStaffOffline123',appToken:config.staffManagement.appToken,tableId:config.staffManagement.tableId,recordIds:['recSeedEmployee123']};
  assert.equal(engine.acceptEvent(event),true);assert.equal(engine.acceptEvent(event),false);staff.healthy=false;await engine.scan({apply:true});assert.equal(engine.status().staffEventsPending,1);
  staff.healthy=true;await engine.scan({apply:true});assert.equal(engine.status().staffEventsPending,0);assert.equal(engine.all('v2_inbox').length,0);
});
test('employee provisioning is never applied during quiet initialize or plan',async t=>{
  const {engine,staff}=await fixture(t);await engine.scan({apply:false});assert.deepEqual(staff.refreshCalls,[false,false]);
});

test('a healthy roster with one pending onboarding task keeps established sales eligible and acknowledges staff events',async t=>{
  const {engine,staff,client,config}=await fixture(t);
  staff.refresh=async()=>({ok:false,errors:[{code:'STAFF_RESOURCE_PENDING'}],nextRetryAt:5000});
  engine.acceptEvent({id:'evtPendingStaff123',appToken:config.staffManagement.appToken,tableId:config.staffManagement.tableId,recordIds:['recNewStaff123']});
  client.add('recPendingNewLead123');const result=await engine.scan({apply:true});
  assert.equal(result.ok,false);assert.equal(engine.staffFailure,false);assert.equal(client.owner('recPendingNewLead123'),config.members[0].openId);assert.equal(engine.status().staffEventsPending,0);
});

test('live local configuration changes reject before any staff apply call',async t=>{
  for(const key of ['enabled','notification']){
    const {engine,staff,config}=await fixture(t);let calls=0;staff.refresh=async()=>{calls++;return{ok:true};};
    engine.memberProvider=()=>({...config,...(key==='enabled'?{enabled:false}:{notification:{enabled:false}})});
    await assert.rejects(engine.scan({apply:true}),{code:'LIVE_CONFIG_BINDING_CHANGED'});assert.equal(calls,0);
  }
});
