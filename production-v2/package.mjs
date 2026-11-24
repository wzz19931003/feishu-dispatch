import { createHash,randomUUID } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_RELEASE } from './version.mjs';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const ALLOWLIST=Object.freeze([
  'package.json','package-lock.json','config.workflow.example.json','lib/feishu.mjs','production/engine.mjs','production/control.mjs',
  'production-v2/engine.mjs','production-v2/field-map.mjs','production-v2/sales-mirror.mjs','production-v2/operator-mirror.mjs','production-v2/cli.mjs','production-v2/events.mjs','production-v2/client.mjs','production-v2/version.mjs',
  'production-v2/migration.mjs','production-v2/prepare-config.mjs','production-v2/prepare-v22-config.mjs','production-v2/capture-schema.mjs','production-v2/attach-target.mjs',
  'production-v2/staff-config.mjs','production-v2/staff-roster.mjs','production-v2/staff-provisioner.mjs','production-v2/staff-admin-client.mjs','production-v2/prepare-staff-config.mjs',
  'production-v2/backup.mjs','production-v2/restore.mjs','production-v2/Task.ps1','production-v2/Host.ps1','production-v2/README.md',
  'production-v2/SALES-MIRROR.md','production-v2/STAFF-MANAGEMENT.md','production-v2/templates/销售个人客资表.csv',
]);
const forbidden=/(?:^|[\\/])(?:data|logs|backups|node_modules|outputs|test)(?:[\\/]|$)|\.local\.json$|\.private\.|\.env|\.(?:sqlite|log|pid|test\.mjs)$/i;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const psQuote=value=>"'"+value.replace(/'/g,"''")+"'";
export function packageFiles(root=ROOT){
  return ALLOWLIST.map(relative=>{
    if(forbidden.test(relative)||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw new Error('PACKAGE_PATH_DENIED');
    const file=path.resolve(root,relative),stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('PACKAGE_FILE_UNSAFE');
    const bytes=readFileSync(file);return{path:relative,bytes:bytes.length,sha256:hash(bytes)};
  });
}
export function buildPackage({root=ROOT,outputRoot=path.join(root,'releases'),archive=true}={}){
  const template=JSON.parse(readFileSync(path.join(root,'config.workflow.example.json'),'utf8').replace(/^\uFEFF/,''));
  if(template.enabled!==false||template.notification?.enabled!==false||template.appId||template.appSecret||template.allowedHost
    ||template.members?.some(m=>m.openId||m.target)||/ou_[A-Za-z0-9_-]{10,}/.test(JSON.stringify(template)))throw new Error('PACKAGE_TEMPLATE_UNSAFE');
  const manifest={format:'shiyeji-workflow-code-v2',version:WORKFLOW_RELEASE,createdAt:new Date().toISOString(),notActivated:true,requiresOnlineConfiguration:true,
    secretsIncluded:false,customerDataIncluded:false,files:packageFiles(root)};
  mkdirSync(outputRoot,{recursive:true});
  const folder=path.join(outputRoot,`shiyeji-workflow-v2-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);mkdirSync(folder);
  for(const item of manifest.files){const target=path.join(folder,item.path);mkdirSync(path.dirname(target),{recursive:true});copyFileSync(path.join(root,item.path),target);}
  writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  if(!archive)return{folder,manifest};
  const zip=folder+'.zip';if(existsSync(zip))throw new Error('PACKAGE_TARGET_EXISTS');
  const psExe=path.join(process.env.WINDIR||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(psExe,['-NoLogo','-NoProfile','-NonInteractive','-Command',`Compress-Archive -LiteralPath ${psQuote(folder)} -DestinationPath ${psQuote(zip)} -CompressionLevel Optimal -ErrorAction Stop`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const check=`[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);Add-Type -AssemblyName System.IO.Compression.FileSystem;$v2Zip=[IO.Compression.ZipFile]::OpenRead(${psQuote(zip)});try{$v2Items=@();foreach($v2Entry in $v2Zip.Entries){if($v2Entry.FullName.EndsWith('/')){continue};$v2Stream=$v2Entry.Open();$v2Hash=[Security.Cryptography.SHA256]::Create();try{$v2Items+=[pscustomobject]@{path=$v2Entry.FullName;sha256=[BitConverter]::ToString($v2Hash.ComputeHash($v2Stream)).Replace('-','').ToLowerInvariant()}}finally{$v2Stream.Dispose();$v2Hash.Dispose()}};ConvertTo-Json -InputObject @($v2Items) -Compress}finally{$v2Zip.Dispose()}`;
  const entries=JSON.parse(execFileSync(psExe,['-NoLogo','-NoProfile','-NonInteractive','-Command',check],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const expected=new Map([...manifest.files.map(x=>[x.path,x.sha256]),['manifest.json',hash(readFileSync(path.join(folder,'manifest.json')))]]),prefix=path.basename(folder)+'/';
  if(!Array.isArray(entries)||entries.length!==expected.size)throw new Error('PACKAGE_ZIP_FILES_INVALID');
  for(const entry of entries){const name=entry.path.replace(/\\/g,'/');if(!name.startsWith(prefix)||expected.get(name.slice(prefix.length))!==entry.sha256)throw new Error('PACKAGE_ZIP_HASH_INVALID');expected.delete(name.slice(prefix.length));}
  if(expected.size)throw new Error('PACKAGE_ZIP_FILES_MISSING');
  return{folder,zip,sha256:hash(readFileSync(zip)),fileCount:manifest.files.length,notActivated:true,requiresOnlineConfiguration:true,secretsIncluded:false,customerDataIncluded:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==2)throw new Error('ARGS_INVALID');console.log(JSON.stringify(buildPackage(),null,2));}
  catch{console.error('v2代码打包未完成；未包含私有配置和客户数据。');process.exitCode=1;}
}
