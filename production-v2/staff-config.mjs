const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const types={employee:11,role:3,enabled:7,order:2,notes:1,status:1,personalUrl:1,updatedAt:1,error:1};
export function validateStaffManagement(raw,{sourceAppToken}={}){
  if(raw===undefined||raw===null)return undefined;
  if(!object(raw)||typeof raw.enabled!=='boolean')fail('STAFF_CONFIG_INVALID');
  if(raw.enabled!==true)return undefined;
  if(!/^[A-Za-z0-9]{10,}$/.test(raw.appToken||'')||raw.appToken===sourceAppToken||!/^tbl[A-Za-z0-9]{5,}$/.test(raw.tableId||''))fail('STAFF_RESOURCE_INVALID');
  if(!object(raw.fields))fail('STAFF_FIELDS_REQUIRED');
  const fields={},seen=new Set();
  for(const [key,type] of Object.entries(types)){
    const spec=raw.fields[key];
    if(!spec&&key==='notes')continue;
    if(!object(spec)||!/^fld[A-Za-z0-9]{5,}$/.test(spec.fieldId||'')||!Array.isArray(spec.types)||spec.types.length!==1||spec.types[0]!==type||seen.has(spec.fieldId))fail('STAFF_FIELD_INVALID');
    if(key==='employee'&&spec.multiple!==undefined&&spec.multiple!==false)fail('STAFF_PERSON_SINGLE_REQUIRED');
    seen.add(spec.fieldId);fields[key]={fieldId:spec.fieldId,types:[type],...(key==='employee'?{multiple:false}:{})};
  }
  if(!Array.isArray(raw.fixedReaders)||raw.fixedReaders.length!==4)fail('STAFF_READERS_INVALID');
  const ids=new Set();
  const fixedReaders=raw.fixedReaders.map(person=>{
    if(!object(person)||!/^ou_[A-Za-z0-9_-]{5,}$/.test(person.openId||'')||typeof person.displayName!=='string'||!person.displayName.trim()||person.displayName.trim().length>200||ids.has(person.openId))fail('STAFF_READERS_INVALID');
    ids.add(person.openId);return{openId:person.openId,displayName:person.displayName.trim()};
  });
  let form;
  try{form=new URL(raw.operatorFormUrl);}catch{fail('STAFF_FORM_URL_INVALID');}
  if(form.protocol!=='https:'||!form.hostname.endsWith('.feishu.cn')||form.username||form.password||form.hash||!/\/share\/(?:base\/)?form\//.test(form.pathname))fail('STAFF_FORM_URL_INVALID');
  const seedRecordIds=raw.seedRecordIds??[];
  if(!Array.isArray(seedRecordIds)||seedRecordIds.some(id=>typeof id!=='string'||!/^rec[A-Za-z0-9]{5,}$/.test(id))||new Set(seedRecordIds).size!==seedRecordIds.length)fail('STAFF_SEEDS_INVALID');
  return{enabled:true,appToken:raw.appToken,tableId:raw.tableId,fields,fixedReaders,operatorFormUrl:form.href,seedRecordIds:[...seedRecordIds]};
}
