import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkflowConfig } from './field-map.mjs';
import { ordinaryFile,safeCode } from '../production/control.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const names={wx:'微信号',needs:'客户需求（天数/景点/预算等）',wxStatus:'微信状态',addMethod:'添加方式',partySize:'出游人数'};
const types={wx:[1],needs:[1],wxStatus:[1,3],addMethod:[1,3],partySize:[1,2]};
export function attachTarget({configFile,memberId,baseUrl,metadataFile,to}={}){
  ordinaryFile(configFile);ordinaryFile(metadataFile);
  if(typeof to!=='string'||!to||path.resolve(to)===path.resolve(configFile))fail('TARGET_OUTPUT_MUST_BE_NEW_FILE');
  const raw=JSON.parse(readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
  if(raw.enabled===true||raw.notification?.enabled===true)fail('TARGET_CONFIGURATION_MUST_BE_DISABLED');
  const config=validateWorkflowConfig(raw,{requireTargets:false});
  const member=config.members.find(m=>m.id===memberId);if(!member)fail('TARGET_MEMBER_NOT_FOUND');
  const metadata=JSON.parse(readFileSync(metadataFile,'utf8').replace(/^\uFEFF/,''));
  if(!metadata||!Array.isArray(metadata.items)||typeof metadata.appToken!=='string'||typeof metadata.tableId!=='string')fail('TARGET_METADATA_INVALID');
  let url;try{url=new URL(baseUrl);}catch{fail('TARGET_URL_INVALID');}
  if(url.search||url.hash||url.protocol!=='https:'||!url.hostname.endsWith('.feishu.cn')||url.username||url.password||url.pathname.replace(/\/$/,'')!==`/base/${metadata.appToken}`)fail('TARGET_METADATA_IDENTITY_MISMATCH');
  const fields={};
  for(const [key,name] of Object.entries(names)){
    const matches=metadata.items.filter(f=>f.field_name===name);
    if(!matches.length&&['partySize','addMethod'].includes(key)&&!config.mirrors.feedbackFields.includes(key))continue;
    if(matches.length!==1||!types[key].includes(Number(matches[0].type)))fail('TARGET_FIELD_INVALID');
    fields[key]={fieldId:matches[0].field_id,types:types[key]};
  }
  member.target={appToken:metadata.appToken,baseUrl:url.href.replace(/\/$/,''),tableId:metadata.tableId,fields};
  const verified=validateWorkflowConfig(config,{requireTargets:false});const saved={...verified};delete saved.pendingTargets;
  writeFileSync(to,JSON.stringify(saved,null,2)+'\n',{flag:'wx',mode:0o600});
  return {ok:true,pendingTargets:verified.pendingTargets.length,enabled:false,started:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!['--config','--member','--url','--fields','--to'].includes(args[i])||!args[i+1]||opts[args[i]])fail('ARGS_INVALID');opts[args[i]]=args[i+1];}
    if(Object.keys(opts).length!==5)fail('ARGS_INVALID');
    console.log(JSON.stringify(attachTarget({configFile:opts['--config'],memberId:opts['--member'],baseUrl:opts['--url'],metadataFile:opts['--fields'],to:opts['--to']})));
  }catch(e){console.error(`个人表绑定未完成（${safeCode(e)}）；未覆盖原配置、未联网、未启动。`);process.exitCode=1;}
}
