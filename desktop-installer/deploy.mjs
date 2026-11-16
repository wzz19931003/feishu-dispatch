import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = '.desktop-update';
const LOCK_NAME = 'deploy.lock';
const protectedNames = new Set(['data', 'node_modules', 'logs', 'backups', '.git', '.agents', '.codex', STATE_DIR]);

export class DeploymentError extends Error {
  constructor(code, details = {}) {
    super(`部署未完成（${code}）`);
    this.name = 'DeploymentError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code) { throw new DeploymentError(code); }
function errorCode(error) {
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || '') ? error.code : 'DEPLOYMENT_FAILED';
}
function statIfPresent(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function fingerprint(buffer) {
  return { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}
function matches(left, right) {
  if (!left || !right) return !left && !right;
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function checkedRelative(filename) {
  if (typeof filename !== 'string' || !filename || filename !== filename.normalize('NFC') || filename.includes('\\')) fail('UNSAFE_RELEASE_PATH');
  const components = filename.split('/');
  for (const component of components) {
    const lower = component.toLowerCase();
    if (!component || component === '.' || component === '..' || /[\u0000-\u001f<>:"|?*]/u.test(component)
      || /^\s|[.\s]$/u.test(component) || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(component)) fail('UNSAFE_RELEASE_PATH');
    if (protectedNames.has(lower) || /(?:^|\.)local\.json$|(?:^|\.)private(?:\.|$)|^\.env(?:\.|$)|\.(?:sqlite3?|db)(?:[-.].*)?$|\.(?:log|pid|wal|shm|bak)$/i.test(lower)) fail('PROTECTED_RELEASE_PATH');
  }
  return components;
}

function caseKey(filename) { return filename.toLowerCase(); }
function manifestFiles(manifest, allowlist) {
  if (!Array.isArray(manifest?.files) || !manifest.files.length || !(Array.isArray(allowlist) || allowlist instanceof Set)) fail('RELEASE_MANIFEST_INVALID');
  const allowed = new Set(), aliases = new Set();
  for (const filename of allowlist) {
    checkedRelative(filename);
    const key = caseKey(filename);
    if (aliases.has(key)) fail('RELEASE_PATH_COLLISION');
    allowed.add(filename); aliases.add(key);
  }
  const received = new Set();
  const files = manifest.files.map(file => {
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) fail('RELEASE_MANIFEST_INVALID');
    checkedRelative(file.path);
    if (!allowed.has(file.path) || received.has(file.path)) fail('RELEASE_ALLOWLIST_MISMATCH');
    received.add(file.path);
    return { path: file.path, bytes: file.bytes, sha256: file.sha256.toLowerCase() };
  });
  if (received.size !== allowed.size) fail('RELEASE_ALLOWLIST_MISMATCH');
  const directories = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const directory = parts.slice(0, i).join('/'), key = caseKey(directory);
      if (aliases.has(key) || directories.has(key) && directories.get(key) !== directory) fail('RELEASE_PATH_COLLISION');
      directories.set(key, directory);
    }
  }
  return files;
}

function assertDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) assertDirectory(parent);
  const stat = statIfPresent(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DEPLOYMENT_DIRECTORY');
}

function pathInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function checkRoots(root, stagedRoot) {
  if (typeof root !== 'string' || !root || typeof stagedRoot !== 'string' || !stagedRoot) fail('DEPLOYMENT_ROOT_REQUIRED');
  root = path.resolve(root);
  stagedRoot = path.resolve(stagedRoot);
  assertDirectory(root); assertDirectory(stagedRoot);
  const realRoot = fs.realpathSync.native(root), realStage = fs.realpathSync.native(stagedRoot);
  if (pathInside(realRoot, realStage) || pathInside(realStage, realRoot)) fail('DEPLOYMENT_ROOTS_OVERLAP');
  return { root, stagedRoot };
}

function safeFile(root, relative, { createParents = false } = {}) {
  assertDirectory(root);
  const components = checkedRelative(relative);
  let directory = root;
  for (const component of components.slice(0, -1)) {
    directory = path.join(directory, component);
    const existing = statIfPresent(directory);
    if (!existing) {
      if (!createParents) return { filename: path.join(root, ...components), stat: null };
      fs.mkdirSync(directory);
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) fail('UNSAFE_DEPLOYMENT_DIRECTORY');
  }
  const filename = path.join(root, ...components), stat = statIfPresent(filename);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) fail('UNSAFE_DEPLOYMENT_FILE');
  return { filename, stat };
}

function readFile(root, relative, expected) {
  const { filename, stat } = safeFile(root, relative);
  if (!stat) return null;
  if (expected && stat.size !== expected.bytes) fail('RELEASE_HASH_MISMATCH');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = fs.fstatSync(descriptor);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== stat.dev || current.ino !== stat.ino) fail('UNSAFE_DEPLOYMENT_FILE');
    const bytes = fs.readFileSync(descriptor);
    return { content: bytes, ...fingerprint(bytes) };
  } finally { fs.closeSync(descriptor); }
}

function writeExclusive(filename, data) {
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); }
  catch (error) {
    fs.closeSync(descriptor);
    removeOwnFile(filename);
    throw error;
  }
  fs.closeSync(descriptor);
}
function mkdirVerified(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertDirectory(directory);
}
function removeOwnFile(filename) {
  if (statIfPresent(filename)) fs.unlinkSync(filename);
}

function checkStage(stagedRoot, files) {
  for (const file of files) {
    const read = readFile(stagedRoot, file.path, file);
    if (!read || !matches(read, file)) fail('RELEASE_HASH_MISMATCH');
  }
}
function verifyExistingPaths(root, files) {
  for (const file of files) safeFile(root, file.path);
}

function prepareEvidence(root) {
  const stateDir = path.join(root, STATE_DIR);
  mkdirVerified(stateDir);
  const id = randomUUID(), directory = path.join(stateDir, id), lock = path.join(stateDir, LOCK_NAME);
  try { writeExclusive(lock, `${JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() })}\n`); }
  catch (error) { if (error.code === 'EEXIST') fail('DEPLOYMENT_LOCKED'); throw error; }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    const before = path.join(directory, 'before'); fs.mkdirSync(before, { mode: 0o700 });
    const journal = path.join(directory, 'journal.jsonl');
    writeExclusive(journal, '');
    writeExclusive(path.join(directory, 'RECOVERY.txt'), `Keep this directory and the deployment lock while checking a failed update.\nCheck journal.jsonl before making changes. If start_requested exists, verify the service state before any recovery. The new code and database may already be in use.\nIf start_requested is absent and automatic rollback did not finish, verify the process is absent. Restore only code paths recorded under replace_intent whose current hashes match the incoming release. Verify backups in before using originals_captured. An original of null means that file can be removed only if its current hash matches the release. Leave unknown hashes and recorded temporary files for manual review.\nPreserve the current database, private configuration and backup. Remove the lock only after verifying code and process state.\n`);
    return { id, directory, before, journal, lock };
  } catch (error) { removeOwnFile(lock); throw error; }
}
function appendEvidence(evidence, phase, details = {}) {
  const descriptor = fs.openSync(evidence.journal, 'a');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ at: new Date().toISOString(), phase, ...details })}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function captureOriginals(root, before, files) {
  return files.map(file => {
    const existing = readFile(root, file.path);
    if (!existing) return { path: file.path, original: null };
    const { filename } = safeFile(before, file.path, { createParents: true });
    writeExclusive(filename, existing.content);
    return { path: file.path, original: { bytes: existing.bytes, sha256: existing.sha256 } };
  });
}

function tempFile(relative, id, purpose) {
  const components = relative.split('/');
  const basename = components.pop();
  return [...components, `.${basename}.${id}.${purpose}.tmp`].join('/');
}
function replaceFile(root, relative, next, expected, temporary) {
  const { filename } = safeFile(root, relative, { createParents: true });
  if (!matches(readFile(root, relative), expected)) fail('DEPLOYMENT_FILE_CHANGED');
  const temp = safeFile(root, temporary).filename;
  let written = false;
  try {
    const descriptor = fs.openSync(temp, 'wx', 0o600);
    written = true;
    try { fs.writeFileSync(descriptor, next); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    if (!matches(readFile(root, relative), expected)) fail('DEPLOYMENT_FILE_CHANGED');
    fs.renameSync(temp, filename);
    written = false;
  } finally { if (written) removeOwnFile(temp); }
}

function rollbackCode(root, evidence, touched) {
  let firstError = null;
  for (const item of [...touched].reverse()) {
    const { file, original } = item;
    try {
      const installed = readFile(root, file.path);
      if (matches(installed, original)) continue;
      if (!matches(installed, file)) fail('ROLLBACK_FILE_CHANGED');
      const temporary = tempFile(file.path, evidence.id, 'rollback');
      appendEvidence(evidence, 'rollback_intent', { path: file.path, temporary });
      if (original) {
        const saved = readFile(evidence.before, file.path, original);
        if (!matches(saved, original)) fail('ROLLBACK_BACKUP_CHANGED');
        replaceFile(root, file.path, saved.content, file, temporary);
      } else fs.unlinkSync(safeFile(root, file.path).filename);
      if (!matches(readFile(root, file.path), original)) fail('ROLLBACK_VERIFICATION_FAILED');
      appendEvidence(evidence, 'rollback_file_done', { path: file.path });
    } catch (error) {
      firstError ??= error;
      try { appendEvidence(evidence, 'rollback_file_failed', { path: file.path, code: errorCode(error) }); } catch {}
    }
  }
  if (firstError) throw firstError;
}

function hookSucceeded(result, code) { if (result === false || result?.ok === false) fail(code); }
async function processState(status, context) {
  const state = (await status(context))?.processStatus;
  if (state !== 'alive' && state !== 'absent') fail('DEPLOYMENT_PROCESS_UNKNOWN');
  return state;
}

/** Deploy only a vetted release's code. The caller owns task management and DB backups. */
export async function applyRelease({ root, stagedRoot, manifest, allowlist, preflight, backup, stop, start, status, shouldResume = true } = {}) {
  if ([preflight, backup, stop, start, status].some(hook => typeof hook !== 'function') || typeof shouldResume !== 'boolean') fail('DEPLOYMENT_HOOKS_REQUIRED');
  const files = manifestFiles(manifest, allowlist);
  ({ root, stagedRoot } = checkRoots(root, stagedRoot));
  checkStage(stagedRoot, files); verifyExistingPaths(root, files);
  const evidence = prepareEvidence(root), touched = [];
  let startRequested = false, wasRunning = false, resumed = false, keepLock = false, stage = 'initial_status';
  const context = phase => ({ root, stagedRoot, manifest, phase, wasRunning });
  const requireAbsent = async phase => { if (await processState(status, context(phase)) !== 'absent') fail('DEPLOYMENT_SERVICE_STILL_ACTIVE'); };
  try {
    appendEvidence(evidence, 'begin', { files });
    wasRunning = await processState(status, context('initial')) === 'alive';
    appendEvidence(evidence, 'initial_status', { wasRunning });
    stage = 'preflight';
    hookSucceeded(await preflight(context('preflight')), 'DEPLOYMENT_PREFLIGHT_FAILED');
    appendEvidence(evidence, 'preflight_done');

    stage = 'stop';
    const active = await processState(status, context('beforeStop'));
    if (active === 'alive') {
      if (!wasRunning) fail('DEPLOYMENT_SERVICE_STARTED_ELSEWHERE');
      appendEvidence(evidence, 'stop_requested');
      hookSucceeded(await stop(context('stop')), 'DEPLOYMENT_STOP_FAILED');
    }
    await requireAbsent('beforeBackup');
    appendEvidence(evidence, 'stopped_confirmed');

    stage = 'backup';
    appendEvidence(evidence, 'backup_requested');
    const backedUp = await backup(context('backup'));
    hookSucceeded(backedUp, 'DEPLOYMENT_BACKUP_FAILED');
    if (backedUp?.integrity && backedUp.integrity !== 'ok') fail('DEPLOYMENT_BACKUP_FAILED');
    appendEvidence(evidence, 'backup_done', { ...(typeof backedUp?.folder === 'string' ? { folder: backedUp.folder } : {}), ...(typeof backedUp?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(backedUp.sha256) ? { sha256: backedUp.sha256 } : {}) });

    stage = 'capture_code';
    await requireAbsent('beforeCapture');
    checkStage(stagedRoot, files);
    const originals = captureOriginals(root, evidence.before, files);
    appendEvidence(evidence, 'originals_captured', { originals });
    await requireAbsent('beforeReplace');
    stage = 'replace_code';
    for (const [i, file] of files.entries()) {
      const next = readFile(stagedRoot, file.path, file), { original } = originals[i];
      if (!matches(next, file)) fail('RELEASE_HASH_MISMATCH');
      if (matches(original, file)) continue;
      const temporary = tempFile(file.path, evidence.id, 'replace');
      appendEvidence(evidence, 'replace_intent', { path: file.path, temporary });
      touched.push({ file, original });
      replaceFile(root, file.path, next.content, original, temporary);
      if (!matches(readFile(root, file.path), file)) fail('DEPLOYMENT_CODE_VERIFICATION_FAILED');
      appendEvidence(evidence, 'replace_file_done', { path: file.path });
    }

    stage = 'postflight';
    await requireAbsent('beforePostflight');
    checkStage(root, files);
    hookSucceeded(await preflight(context('postflight')), 'DEPLOYMENT_POSTFLIGHT_FAILED');
    checkStage(root, files);
    await requireAbsent('afterPostflight');
    appendEvidence(evidence, 'postflight_done');

    if (shouldResume && wasRunning) {
      stage = 'start';
      await requireAbsent('beforeStart');
      appendEvidence(evidence, 'start_requested');
      startRequested = true;
      hookSucceeded(await start(context('start')), 'DEPLOYMENT_START_UNCONFIRMED');
      if (await processState(status, context('afterStart')) !== 'alive') fail('DEPLOYMENT_START_UNCONFIRMED');
      resumed = true;
      appendEvidence(evidence, 'start_confirmed');
    }
    appendEvidence(evidence, 'complete', { wasRunning, resumed });
    return { ok: true, wasRunning, resumed, recoveryDir: evidence.directory };
  } catch (error) {
    const code = errorCode(error);
    let rollback = 'not_needed';
    if (startRequested) { rollback = 'not_attempted_after_start'; keepLock = true; }
    else if (touched.length) {
      try {
        await requireAbsent('beforeRollback');
        rollbackCode(root, evidence, touched);
        rollback = 'code_restored';
      } catch (rollbackError) {
        rollback = 'manual_recovery_required'; keepLock = true;
        try { appendEvidence(evidence, 'rollback_failed', { code: errorCode(rollbackError) }); } catch {}
      }
    }
    try { appendEvidence(evidence, 'failed', { stage, code, rollback, startRequested, wasRunning }); } catch { keepLock = true; }
    throw new DeploymentError(code, { stage, rollback, startRequested, recoveryDir: evidence.directory, lockRetained: keepLock });
  } finally { if (!keepLock) removeOwnFile(evidence.lock); }
}
