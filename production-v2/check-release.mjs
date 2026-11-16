import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage,ROOT } from './package.mjs';

export function checkRelease(){
  const tests=readdirSync(path.join(ROOT,'production-v2')).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>path.join('production-v2',f));
  if(!tests.length)throw new Error('TESTS_MISSING');
  execFileSync(process.execPath,['--test',...tests],{cwd:ROOT,windowsHide:true,stdio:'inherit'});
  const psExe=path.join(process.env.WINDIR||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const q=v=>"'"+v.replace(/'/g,"''")+"'";
  const files=['Task.ps1','Host.ps1'].map(f=>q(path.join(ROOT,'production-v2',f))).join(',');
  const syntax=`$v2Failures=@();foreach($v2Script in @(${files})){$v2Tokens=$null;$v2Errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($v2Script,[ref]$v2Tokens,[ref]$v2Errors)|Out-Null;if($v2Errors){$v2Failures+=$v2Errors}};if($v2Failures.Count){throw 'V2 PowerShell syntax failed'};Write-Output 'V2 PowerShell syntax passed'`;
  const syntaxResult=execFileSync(psExe,['-NoLogo','-NoProfile','-NonInteractive','-Command',syntax],{cwd:ROOT,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  console.log(syntaxResult);
  const result=buildPackage();console.log(JSON.stringify({checksPassed:true,testFiles:tests.length,powerShellSyntaxPassed:true,...result},null,2));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==2)throw new Error('ARGS_INVALID');checkRelease();}
  catch{console.error('v2发布检查未通过，未生成可交付新包。');process.exitCode=1;}
}
