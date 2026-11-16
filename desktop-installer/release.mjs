import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import path from 'node:path';
import { ROOT, packageFiles } from '../production-v2/package.mjs';
import { WORKFLOW_RELEASE } from '../production-v2/version.mjs';

const ASSET_NAME = 'feishu-dispatch-update.zip';
const SHA = input => createHash('sha256').update(input).digest('hex');
const repositoryPattern = /^[a-z0-9-]+\/[a-z0-9_.-]+$/i;
const versionPattern = /^2\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const argumentsByName = new Map();
const action = process.argv[2];
for (let i = 3; i < process.argv.length; i += 2) {
  const option = process.argv[i], value = process.argv[i + 1];
  if (!['--repository', '--out', '--key'].includes(option) || argumentsByName.has(option) || !value) throw new Error('Invalid release arguments');
  argumentsByName.set(option, value);
}
const repository = argumentsByName.get('--repository');
const outArg = argumentsByName.get('--out');
if (!repositoryPattern.test(repository || '') || !outArg) throw new Error('Required: --repository <owner/name> --out <directory>');
const out = path.resolve(outArg);
const keyFile = argumentsByName.has('--key') ? path.resolve(argumentsByName.get('--key')) : null;

function restrictPublisherFolder(folder) {
  if (process.platform !== 'win32') return;
  const system = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
  const identity = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /S-1-5-\d+(?:-\d+)*/.exec(identity)?.[0];
  if (!sid) throw new Error('Could not identify the Windows publisher account');
  execFileSync(path.join(system, 'icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], {
    stdio: 'pipe', windowsHide: true,
  });
}

if (action === 'key') {
  if (keyFile || existsSync(out)) throw new Error('Choose a new private directory outside the repository');
  const relative = path.relative(ROOT, out);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Private key directory must be outside the repository');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  restrictPublisherFolder(out);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(path.join(out, 'publisher.private.pem'), privateKey, { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(out, 'channel.json'), JSON.stringify({ repository, publicKey }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, repository, channel: path.join(out, 'channel.json') }));
} else if (action === 'build') {
  if (process.platform !== 'win32' || !keyFile || !versionPattern.test(WORKFLOW_RELEASE) || existsSync(out)) throw new Error('Expected Windows, valid release version, private key and new output directory');
  const privateKey = createPrivateKey(readFileSync(keyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Publisher key must use Ed25519');
  const files = packageFiles(ROOT);
  const stage = path.join(out, 'code');
  mkdirSync(stage, { recursive: true });
  for (const entry of files) {
    const destination = path.join(stage, entry.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(ROOT, entry.path), destination, constants.COPYFILE_EXCL);
    if (SHA(readFileSync(destination)) !== entry.sha256) throw new Error('Source changed during packaging');
  }
  const zip = path.join(out, ASSET_NAME);
  const windows = process.env.WINDIR || 'C:\\Windows';
  const psHome = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(stage)},${psQuote(zip)},[IO.Compression.CompressionLevel]::Optimal,$false)`;
  execFileSync(path.join(psHome, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: 'pipe', env: { ...process.env, PSModulePath: path.join(psHome, 'Modules') },
  });
  const archive = readFileSync(zip);
  const manifest = Buffer.from(JSON.stringify({ format: 'feishu-dispatch-update-v1', repository, version: WORKFLOW_RELEASE,
    archive: { name: ASSET_NAME, bytes: archive.length, sha256: SHA(archive) }, files }, null, 2) + '\n');
  const signature = sign(null, manifest, privateKey);
  if (!verify(null, manifest, createPublicKey(privateKey), signature)) throw new Error('Signature verification failed');
  writeFileSync(path.join(out, 'manifest.json'), manifest, { flag: 'wx' });
  writeFileSync(path.join(out, 'manifest.sig'), signature.toString('base64') + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, repository, version: WORKFLOW_RELEASE, tag: `v${WORKFLOW_RELEASE}`, fileCount: files.length,
    assets: ['manifest.json', 'manifest.sig', ASSET_NAME].map(name => path.join(out, name)) }, null, 2));
} else throw new Error('Action must be key or build');
