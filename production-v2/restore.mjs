import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ordinaryFile, status } from '../production/control.mjs';
import { summarize } from './backup.mjs';

export function restore({ from, root=ROOT }={}) {
  if (typeof from!=='string' || !from || status(root).processStatus!=='absent') throw new Error('RESTORE_REQUIRES_STOPPED_HOST');
  const source=path.resolve(from,'workflow.sqlite'), manifestFile=path.resolve(from,'manifest.json');
  ordinaryFile(source,Number.MAX_SAFE_INTEGER);ordinaryFile(manifestFile);
  const manifest=JSON.parse(readFileSync(manifestFile,'utf8').replace(/^\uFEFF/,'')), bytes=readFileSync(source);
  if (manifest.format!=='shiyeji-workflow-backup-v2'||manifest.database!=='workflow.sqlite'||manifest.bytes!==bytes.length
    ||manifest.sha256!==createHash('sha256').update(bytes).digest('hex')) throw new Error('RESTORE_MANIFEST_INVALID');
  if (existsSync(source+'-wal')||existsSync(source+'-shm')) throw new Error('RESTORE_SOURCE_NOT_SNAPSHOT');
  const verification=new DatabaseSync(source,{readOnly:true});
  try { const result=summarize(verification);if(JSON.stringify(result.counts)!==JSON.stringify(manifest.counts))throw new Error('RESTORE_COUNTS_INVALID'); } finally {verification.close();}
  const target=path.join(root,'data/workflow.sqlite');
  if ([target,target+'-wal',target+'-shm'].some(existsSync))throw new Error('RESTORE_TARGET_EXISTS');
  mkdirSync(path.dirname(target),{recursive:true});copyFileSync(source,target,constants.COPYFILE_EXCL);
  return {ok:true,restored:true,started:false,configIncluded:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==4||process.argv[2]!=='--from')throw new Error('ARGS_INVALID');console.log(JSON.stringify(restore({from:process.argv[3]})));}
  catch{console.error('v2恢复未完成；未覆盖已有库，未启动服务。');process.exitCode=1;}
}
