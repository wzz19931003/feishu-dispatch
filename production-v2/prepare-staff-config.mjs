import { hostname } from 'node:os';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkflowConfig } from './field-map.mjs';
import { ordinaryFile,safeCode } from '../production/control.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const read=filename=>JSON.parse(readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
export function prepareStaffConfig({configFile,resourceFile,to,allowedHost=hostname()}={}){
  ordinaryFile(configFile);ordinaryFile(resourceFile);
  if(typeof to!=='string'||!to||existsSync(to)||path.resolve(to)===path.resolve(configFile))fail('STAFF_OUTPUT_EXISTS_OR_INVALID');
  const raw=read(configFile),config=validateWorkflowConfig(raw),resource=read(resourceFile);
  if(config.staffManagement?.enabled)fail('STAFF_ALREADY_BOUND');
  if(resource.format!=='shiyeji-staff-resource-v1'||resource.appId!==config.appId||resource.source?.appToken!==config.appToken||resource.source?.tableId!==config.tableIds.leads)fail('STAFF_RESOURCE_IDENTITY_MISMATCH');
  const prepared=validateWorkflowConfig({...config,enabled:false,notification:{...config.notification,enabled:false},allowedHost,staffManagement:resource.staffManagement});
  if(!prepared.staffManagement?.enabled)fail('STAFF_RESOURCE_INVALID');
  delete prepared.pendingTargets;
  writeFileSync(to,JSON.stringify(prepared,null,2)+'\n',{flag:'wx',mode:0o600});
  return{ok:true,staffTableBound:true,memberBootstrapCount:prepared.members.length,enabled:false,notificationsEnabled:false,started:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),opts={};
    for(let i=0;i<args.length;i+=2){if(!['--config','--resource','--to'].includes(args[i])||!args[i+1]||opts[args[i]])fail('ARGS_INVALID');opts[args[i]]=args[i+1];}
    if(Object.keys(opts).length!==3)fail('ARGS_INVALID');
    console.log(JSON.stringify(prepareStaffConfig({configFile:opts['--config'],resourceFile:opts['--resource'],to:opts['--to']})));
  }catch(error){console.error(`员工表配置绑定未完成（${safeCode(error)}）；未覆盖原配置、未联网、未启动。`);process.exitCode=1;}
}
