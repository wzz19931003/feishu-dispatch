import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowClient } from './client.mjs';
import { ordinaryFile, safeCode } from '../production/control.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function captureSchema({configFile,to,appToken,tableId,client}={}) {
  ordinaryFile(configFile);
  const config=JSON.parse(readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
  appToken ||= config.appToken; tableId ||= config.tableIds?.leads;
  if(!/^[A-Za-z0-9]{10,}$/.test(appToken||'')||!/^tbl[A-Za-z0-9]{5,}$/.test(tableId||''))fail('SCHEMA_RESOURCE_INVALID');
  if(typeof to!=='string'||!to||existsSync(to))fail('SCHEMA_OUTPUT_EXISTS_OR_INVALID');
  client ||= new WorkflowClient(config);
  const items=[],seen=new Set();let cursor;
  do {
    const page=await client.api(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,{query:{page_size:100,...(cursor?{page_token:cursor}:{})}});
    if(!Array.isArray(page.items))fail('SCHEMA_RESPONSE_INVALID');items.push(...page.items);
    if(!page.has_more)break;
    if(typeof page.page_token!=='string'||!page.page_token||seen.has(page.page_token)||seen.size>1000)fail('SCHEMA_PAGINATION_INVALID');
    cursor=page.page_token;seen.add(cursor);
  }while(true);
  writeFileSync(to,JSON.stringify({appToken,tableId,items},null,2)+'\n',{flag:'wx',mode:0o600});
  return {ok:true,readOnly:true,fieldCount:items.length,started:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const opts={};let valid=true;const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){if(!['--config','--to','--base','--table'].includes(args[i])||!args[i+1]||opts[args[i]]){valid=false;break;}opts[args[i]]=args[i+1];}
  if(!valid||!opts['--config']||!opts['--to']||Boolean(opts['--base'])!==Boolean(opts['--table'])){console.error('请指定--config、--to；指定其他Base时同时给--base和--table。');process.exitCode=1;}
  else captureSchema({configFile:opts['--config'],to:opts['--to'],appToken:opts['--base'],tableId:opts['--table']}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(`只读字段导出失败（${safeCode(e)}）；未输出密钥，未启动派单。`);process.exitCode=1;});
}
