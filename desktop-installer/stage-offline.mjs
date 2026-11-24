import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, packageFiles, ROOT } from '../production-v2/package.mjs';
import { checkRelease } from '../production-v2/check-release.mjs';
import { WORKFLOW_RELEASE } from '../production-v2/version.mjs';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--out', '--version', '--channel'].includes(key) || !value || options.has(key)) throw new Error('Expected --out <new-directory> --version <2.x.y> [--channel <public-json>]');
  options.set(key, value);
}
const expected = options.get('--version');
const output = options.get('--out') && path.resolve(options.get('--out'));
if (!output || !/^2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(expected || '') || expected !== WORKFLOW_RELEASE) throw new Error('STAGE_VERSION_MISMATCH');
if (existsSync(output)) throw new Error('STAGE_OUTPUT_EXISTS');
if (!ALLOWLIST.includes('production-v2/operator-mirror.mjs') || !ALLOWLIST.includes('production-v2/prepare-v22-config.mjs')) throw new Error('STAGE_V22_FILES_MISSING');

const codePackage = checkRelease();
execFileSync(process.execPath, ['--test',
  'desktop-installer/deploy.test.mjs', 'desktop-installer/controller.test.mjs', 'desktop-installer/feed.test.mjs',
], { cwd: ROOT, windowsHide: true, stdio: 'inherit' });
mkdirSync(output, { recursive: true });
const builder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build.mjs');
const argumentsForBuild = [builder, '--out', path.join(output, '安装包')];
if (options.has('--channel')) argumentsForBuild.push('--channel', path.resolve(options.get('--channel')));
const build = JSON.parse(execFileSync(process.execPath, argumentsForBuild, {
  cwd: ROOT, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
const codeManifest = JSON.parse(readFileSync(path.join(codePackage.folder, 'manifest.json')));
const embedded = JSON.parse(readFileSync(path.join(build.buildRoot, 'payload', 'engine', 'manifest.json')));
if (embedded.version !== expected || JSON.stringify(embedded.files) !== JSON.stringify(codeManifest.files)
  || JSON.stringify(packageFiles(ROOT)) !== JSON.stringify(embedded.files)) throw new Error('STAGE_SOURCE_CHANGED_DURING_QA');
const archiveName = 'feishu-dispatch-offline-code-' + expected + '.zip';
copyFileSync(codePackage.zip, path.join(output, archiveName));
const report = {
  version: expected, preparedAt: new Date().toISOString(), productionTestsPassed: true,
  deploymentFixturePassed: true, controllerFixturePassed: true, feedFixturePassed: true,
  codeArchive: archiveName, codeSha256: codePackage.sha256, installer: path.join('安装包', build.installer),
  installerSha256: build.sha256, signedInstaller: build.signedInstaller, sourceFileCount: embedded.files.length,
  organizationBindingIncluded: build.organizationBindingIncluded, updateRepository: build.updateRepository,
  installedHere: false, published: false, customerDataIncluded: false, secretsIncluded: false,
};
writeFileSync(path.join(output, '构建验收.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...report, output }, null, 2));
