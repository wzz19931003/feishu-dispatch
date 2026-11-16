import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, ROOT, packageFiles } from '../production-v2/package.mjs';
import { validateStaffManagement } from '../production-v2/staff-config.mjs';
import { WORKFLOW_RELEASE } from '../production-v2/version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i], value = process.argv[i + 1];
  if (!['--out', '--binding', '--channel'].includes(option) || flags.has(option) || !value) throw new Error('Expected --out <directory> [--binding <file>] [--channel <file>]');
  flags.set(option, path.resolve(value));
}
const out = flags.get('--out');
if (!out) throw new Error('Missing --out directory');
const work = path.join(ROOT, 'releases', `desktop-build-${randomUUID()}`);
const payload = path.join(work, 'payload');
const engine = path.join(payload, 'engine');
const exe = path.join(out, `FeishuDispatch-Setup-${WORKFLOW_RELEASE}-x64.exe`);
const shaFile = path.join(out, '安装包校验.json');
const archive = path.join(work, 'payload.zip');
const windows = process.env.WINDIR || 'C:\\Windows';
const psHome = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0');
const ps = path.join(psHome, 'powershell.exe');
const psOptions = { windowsHide: true, stdio: 'pipe', env: { ...process.env, PSModulePath: path.join(psHome, 'Modules') } };
const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const hash = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');

if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Windows x64 and Node 24 or later required');
if (existsSync(exe) || existsSync(shaFile)) throw new Error('Delivery file already exists');

const trustCommand = `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'); $sig=Get-AuthenticodeSignature -LiteralPath ${psQuote(process.execPath)}; if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation') { exit 1 }`;
execFileSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', trustCommand], psOptions);

const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
let binding;
if (flags.has('--binding')) {
  const staff = readJson(flags.get('--binding'));
  if (staff.format !== 'shiyeji-staff-resource-v1' || !/^cli_[a-z0-9]+$/i.test(staff.appId || '') || !staff.source?.tableId || !staff.source?.appToken) throw new Error('Invalid organization binding');
  binding = {
    format: staff.format,
    appId: staff.appId,
    source: { appToken: staff.source.appToken, tableId: staff.source.tableId },
    staffManagement: validateStaffManagement(staff.staffManagement, { sourceAppToken: staff.source.appToken }),
  };
  if (!binding.staffManagement?.enabled || /appSecret|access_token|workflow\.sqlite/i.test(JSON.stringify(binding))) throw new Error('Unsafe organization binding');
}
let channel;
if (flags.has('--channel')) {
  const raw = readJson(flags.get('--channel'));
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(raw.repository) || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(raw.publicKey)) throw new Error('Invalid GitHub update channel');
  channel = { repository: raw.repository, publicKey: raw.publicKey };
}

mkdirSync(engine, { recursive: true });
mkdirSync(path.join(payload, 'runtime'));
mkdirSync(out, { recursive: true });
const files = packageFiles(ROOT);
for (const entry of files) {
  const destination = path.join(engine, entry.path);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(ROOT, entry.path), destination);
  if (hash(destination) !== entry.sha256) throw new Error('Release file hash mismatch');
}
for (const filename of ['controller.mjs', 'deploy.mjs', 'feed.mjs', 'task-bridge.ps1', 'unpack-release.ps1']) copyFileSync(path.join(here, filename), path.join(payload, filename));
copyFileSync(process.execPath, path.join(payload, 'runtime', 'node.exe'));
writeFileSync(path.join(payload, 'allowlist.json'), JSON.stringify(ALLOWLIST), { flag: 'wx' });
if (binding) writeFileSync(path.join(payload, 'staff-binding.json'), JSON.stringify(binding, null, 2), { flag: 'wx' });
if (channel) writeFileSync(path.join(payload, 'channel.json'), JSON.stringify(channel, null, 2), { flag: 'wx' });
writeFileSync(path.join(engine, 'manifest.json'), JSON.stringify({ format: 'shiyeji-workflow-code-v2', version: WORKFLOW_RELEASE, files }, null, 2), { flag: 'wx' });

const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(payload)},${psQuote(archive)},[IO.Compression.CompressionLevel]::Optimal,$false)`;
execFileSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], psOptions);
const built = path.join(work, 'Setup.exe');
execFileSync(compiler, ['/nologo', '/target:winexe', '/langversion:5', '/codepage:65001', '/platform:x64',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.IO.Compression.dll', '/r:System.Web.Extensions.dll',
  `/resource:${archive},ShiYeJiPayload`, `/out:${built}`, path.join(here, 'Setup.cs')], { cwd: here, windowsHide: true, stdio: 'pipe' });
copyFileSync(built, exe);
const result = { version: WORKFLOW_RELEASE, installer: path.basename(exe), sha256: hash(exe), signedInstaller: false,
  bundledNodeVersion: process.versions.node, bundledNodeSignatureVerified: true, codeFiles: files.length, existingWindowsV2ProjectRequired: true,
  organizationBindingIncluded: Boolean(binding), updateRepository: channel?.repository || null, secretsIncluded: false, customerDataIncluded: false, installedHere: false };
writeFileSync(shaFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...result, output: out, buildRoot: work }, null, 2));
