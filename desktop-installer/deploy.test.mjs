import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync, backup } from 'node:sqlite';
import { applyRelease } from './deploy.mjs';

function write(root, relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value);
}
function fingerprint(relative, content) {
  const bytes = Buffer.from(content);
  return { path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function journal(directory) {
  return fs.readFileSync(path.join(directory, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function fixture(t, { active = true } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'shiyeji-deploy-test-'));
  const root = path.join(parent, 'workspace'), stagedRoot = path.join(parent, 'stage');
  fs.mkdirSync(root); fs.mkdirSync(stagedRoot);
  t.after(() => { assert.equal(path.dirname(parent), path.resolve(os.tmpdir())); fs.rmSync(parent, { recursive: true, force: true }); });
  const protectedContents = { 'data/workflow.sqlite': 'state-old', 'config.workflow.local.json': 'private-old', 'node_modules/package/index.mjs': 'dependency-old', 'logs/state.log': 'log-old', 'backups/old.sqlite': 'backup-old' };
  const old = { 'production-v2/cli.mjs': 'old-cli-code' }, next = { 'production-v2/cli.mjs': 'new-cli-code', 'production-v2/new.mjs': 'new-code-only-file' };
  for (const [relative, content] of Object.entries({ ...old, ...protectedContents })) write(root, relative, content);
  for (const [relative, content] of Object.entries(next)) write(stagedRoot, relative, content);
  const manifest = { files: Object.entries(next).map(([relative, content]) => fingerprint(relative, content)) };
  const calls = [], states = { active, startCalls: 0, stopCalls: 0 };
  const input = { root, stagedRoot, manifest, allowlist: Object.keys(next),
    async status(context) { calls.push(`status:${context.phase}`); return { processStatus: states.active ? 'alive' : 'absent' }; },
    async preflight({ phase }) { calls.push(phase); assert.equal(states.active, phase === 'preflight' && active); },
    async backup() { calls.push('backup'); assert.equal(states.active, false); return { integrity: 'ok' }; },
    async stop() { calls.push('stop'); states.stopCalls++; states.active = false; },
    async start() { calls.push('start'); states.startCalls++; states.active = true; } };
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const lock = () => fs.existsSync(path.join(root, '.desktop-update', 'deploy.lock'));
  const checkProtected = () => { for (const [relative, content] of Object.entries(protectedContents)) assert.equal(read(relative), content); };
  return { input, root, stagedRoot, manifest, calls, states, read, lock, checkProtected, parent, old, next };
}

test('verifies live state, preflights while running, stops, backs up, swaps code and starts once', async t => {
  const f = fixture(t);
  f.input.backup = async () => {
    assert.equal(f.states.active, false); assert.equal(f.read('production-v2/cli.mjs'), 'old-cli-code');
    f.calls.push('backup'); return { integrity: 'ok', folder: path.join(f.root, 'backups', 'fresh') };
  };
  f.input.start = async () => {
    assert.equal(f.read('production-v2/cli.mjs'), 'new-cli-code'); assert.equal(f.states.active, false);
    f.calls.push('start'); f.states.startCalls++; f.states.active = true;
  };
  const result = await applyRelease(f.input);
  assert.deepEqual([result.ok, result.resumed, result.wasRunning], [true, true, true]);
  assert.deepEqual(f.calls.filter(value => !value.startsWith('status:')), ['preflight', 'stop', 'backup', 'postflight', 'start']);
  assert.equal(f.calls[0], 'status:initial'); assert.equal(f.states.startCalls, 1); assert.equal(f.states.stopCalls, 1);
  assert.equal(f.read('production-v2/new.mjs'), 'new-code-only-file'); assert.equal(f.lock(), false); f.checkProtected();
  const evidence = journal(result.recoveryDir);
  assert.ok(evidence.some(entry => entry.phase === 'originals_captured' && entry.originals[1].original === null));
  assert.equal(evidence.at(-1).phase, 'complete');
});

test('a stopped host stays stopped, and a running host need not resume', async t => {
  for (const active of [false, true]) {
    const f = fixture(t, { active });
    const result = await applyRelease({ ...f.input, shouldResume: !active });
    assert.equal(result.wasRunning, active); assert.equal(result.resumed, false);
    assert.equal(f.states.stopCalls, Number(active)); assert.equal(f.states.startCalls, 0); assert.equal(f.states.active, false); f.checkProtected();
  }
});

test('an invalid exact manifest, protected paths or bad staged content cannot stop the host', async t => {
  for (const branch of ['omit', 'extra', 'duplicate', 'parent', 'private', 'wrong-hash', 'windows-device', 'reserved-dir']) {
    const f = fixture(t);
    if (branch === 'omit') f.manifest.files.pop();
    if (branch === 'extra') f.manifest.files.push(fingerprint('surprise.mjs', 'unexpected'));
    if (branch === 'duplicate') f.manifest.files.push(f.manifest.files[0]);
    if (branch === 'parent') f.input.allowlist[0] = '../outside.mjs';
    if (branch === 'private') f.input.allowlist[0] = 'config.workflow.local.json';
    if (branch === 'wrong-hash') write(f.stagedRoot, 'production-v2/cli.mjs', 'nope-cli-code');
    if (branch === 'windows-device') f.input.allowlist[0] = 'production-v2/AUX.txt';
    if (branch === 'reserved-dir') f.input.allowlist[0] = 'node_modules/unused';
    await assert.rejects(applyRelease(f.input));
    assert.deepEqual(f.calls, []); assert.equal(f.states.active, true); assert.equal(f.lock(), false); f.checkProtected();
  }
});

test('rejects staging hard links and installed parent links before invoking any hooks', async t => {
  const stagedLink = fixture(t), stagedFile = path.join(stagedLink.stagedRoot, 'production-v2', 'cli.mjs');
  fs.linkSync(stagedFile, path.join(stagedLink.parent, 'spare'));
  await assert.rejects(applyRelease(stagedLink.input), { code: 'UNSAFE_DEPLOYMENT_FILE' });
  assert.deepEqual(stagedLink.calls, []);

  const parentLink = fixture(t), original = path.join(parentLink.root, 'production-v2'), moved = path.join(parentLink.parent, 'real-code');
  fs.renameSync(original, moved); fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyRelease(parentLink.input), { code: 'UNSAFE_DEPLOYMENT_DIRECTORY' });
  assert.deepEqual(parentLink.calls, []); assert.equal(parentLink.states.active, true);
});

test('preflight rejection never stops service and unconfirmed stop never backs up or writes', async t => {
  const initial = fixture(t); initial.input.preflight = async () => ({ ok: false });
  await assert.rejects(applyRelease(initial.input), { code: 'DEPLOYMENT_PREFLIGHT_FAILED' });
  assert.equal(initial.states.stopCalls, 0); assert.equal(initial.states.active, true);
  const notStopped = fixture(t); notStopped.input.stop = async () => { notStopped.states.stopCalls++; };
  await assert.rejects(applyRelease(notStopped.input), { code: 'DEPLOYMENT_SERVICE_STILL_ACTIVE' });
  assert.equal(notStopped.states.stopCalls, 1); assert.ok(!notStopped.calls.includes('backup'));
  assert.equal(notStopped.read('production-v2/cli.mjs'), 'old-cli-code'); notStopped.checkProtected();
});

test('unknown process state and a service started by someone else never authorize a stop or mutation', async t => {
  const unknown = fixture(t); unknown.input.status = async () => ({ processStatus: 'unknown' });
  await assert.rejects(applyRelease(unknown.input), { code: 'DEPLOYMENT_PROCESS_UNKNOWN' });
  assert.deepEqual(unknown.calls, []); assert.equal(unknown.states.active, true);

  const newProcess = fixture(t, { active: false });
  newProcess.input.preflight = async () => { newProcess.states.active = true; };
  await assert.rejects(applyRelease(newProcess.input), { code: 'DEPLOYMENT_SERVICE_STARTED_ELSEWHERE' });
  assert.equal(newProcess.states.stopCalls, 0); assert.equal(newProcess.read('production-v2/cli.mjs'), 'old-cli-code');
  newProcess.checkProtected();
});

test('an integrity failure in backup leaves all code and state intact', async t => {
  const f = fixture(t); f.input.backup = async () => ({ integrity: 'bad' });
  await assert.rejects(applyRelease(f.input), { code: 'DEPLOYMENT_BACKUP_FAILED', rollback: 'not_needed' });
  assert.equal(f.states.stopCalls, 1); assert.equal(f.states.startCalls, 0);
  assert.equal(f.read('production-v2/cli.mjs'), 'old-cli-code'); assert.equal(f.lock(), false); f.checkProtected();
});

test('staging changed after a valid backup is rejected before replacements', async t => {
  const f = fixture(t); f.input.backup = async () => { write(f.stagedRoot, 'production-v2/new.mjs', 'altered'); };
  await assert.rejects(applyRelease(f.input), { code: 'RELEASE_HASH_MISMATCH', rollback: 'not_needed' });
  assert.equal(f.read('production-v2/cli.mjs'), 'old-cli-code'); assert.equal(f.states.startCalls, 0); f.checkProtected();
});

test('a file replacement collision restores prior code without touching the unknown file or state', async t => {
  const f = fixture(t), status = f.input.status;
  f.input.status = async context => {
    if (context.phase === 'beforeReplace') write(f.root, 'production-v2/new.mjs', 'another-admin-created-this');
    return status(context);
  };
  let error;
  try { await applyRelease(f.input); assert.fail('update unexpectedly succeeded'); } catch (failure) { error = failure; }
  assert.equal(error.code, 'DEPLOYMENT_FILE_CHANGED');
  assert.equal(error.lockRetained, true);
  assert.equal(f.read('production-v2/cli.mjs'), 'old-cli-code');
  assert.equal(f.read('production-v2/new.mjs'), 'another-admin-created-this');
  assert.equal(f.states.startCalls, 0); f.checkProtected();
});

test('postflight failure restores overwritten code and removes only newly installed code', async t => {
  const f = fixture(t), preflight = f.input.preflight;
  f.input.preflight = async context => { await preflight(context); if (context.phase === 'postflight') { assert.equal(f.read('production-v2/new.mjs'), 'new-code-only-file'); return false; } };
  let evidence;
  await assert.rejects(applyRelease(f.input), error => { evidence = error.recoveryDir; return error.code === 'DEPLOYMENT_POSTFLIGHT_FAILED' && error.rollback === 'code_restored' && !error.startRequested; });
  assert.equal(f.read('production-v2/cli.mjs'), 'old-cli-code'); assert.ok(!fs.existsSync(path.join(f.root, 'production-v2/new.mjs')));
  assert.equal(f.states.startCalls, 0); assert.equal(f.lock(), false); f.checkProtected();
  assert.equal(journal(evidence).at(-1).rollback, 'code_restored');
});

test('a start failure can follow real effects and therefore keeps new code, state and evidence', async t => {
  const f = fixture(t);
  f.input.start = async () => { f.states.startCalls++; f.states.active = true; write(f.root, 'data/workflow.sqlite', 'v2-new-state'); throw new Error('fake adapter details omitted'); };
  let evidence;
  await assert.rejects(applyRelease(f.input), error => { evidence = error.recoveryDir; return error.startRequested && error.lockRetained && error.rollback === 'not_attempted_after_start'; });
  assert.equal(f.read('production-v2/cli.mjs'), 'new-cli-code'); assert.equal(f.read('data/workflow.sqlite'), 'v2-new-state'); assert.equal(f.states.startCalls, 1);
  assert.equal(f.lock(), true); assert.ok(journal(evidence).some(entry => entry.phase === 'start_requested'));
  assert.ok(!fs.readFileSync(path.join(evidence, 'journal.jsonl'), 'utf8').includes('fake adapter details'));
  await assert.rejects(applyRelease(f.input), { code: 'DEPLOYMENT_LOCKED' });
});

test('a successful start callback without an observed live process retains the update for review', async t => {
  const f = fixture(t);
  f.input.start = async () => { f.states.startCalls++; return { ok: true }; };
  await assert.rejects(applyRelease(f.input), { code: 'DEPLOYMENT_START_UNCONFIRMED', startRequested: true, lockRetained: true });
  assert.equal(f.states.startCalls, 1); assert.equal(f.read('production-v2/cli.mjs'), 'new-cli-code'); f.checkProtected();
});

test('a second installer cannot run hooks while the first holds the project lock', async t => {
  const f = fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const first = applyRelease({ ...f.input, async preflight(context) { if (context.phase === 'preflight') { enter(); await gate; } } });
  try {
    await entered;
    await assert.rejects(applyRelease(f.input), { code: 'DEPLOYMENT_LOCKED' });
    assert.deepEqual(f.calls, ['status:initial']);
  } finally { release(); }
  assert.equal((await first).ok, true);
});

test('an in-place upgrade preserves real SQLite WAL, outbox receipts, mirror mappings and private settings', async t => {
  const f = fixture(t);
  const filename = path.join(f.root, 'data', 'workflow.sqlite');
  fs.unlinkSync(filename);
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE v2_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE v2_outbox(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE v2_mirrors(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE v2_staff_registry(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    db.prepare('INSERT INTO v2_meta VALUES(?,?)').run('initialized', 'true');
    const sent = JSON.stringify({ recordId: 'recFixture', state: 'sent', messageId: 'om_fixture', sentAt: '2026-11-19T00:00:00.000Z' });
    const mirror = JSON.stringify({ sourceId: 'recFixture', targetRecordId: 'recFixtureChild', state: 'active' });
    db.prepare('INSERT INTO v2_outbox VALUES(?,?)').run('sent-once', sent);
    db.prepare('INSERT INTO v2_outbox VALUES(?,?)').run('awaiting-review', JSON.stringify({ state: 'review', errorCode: 'SEND_OUTCOME_UNKNOWN' }));
    db.prepare('INSERT INTO v2_mirrors VALUES(?,?)').run('trusted-source-child', mirror);
    db.prepare('INSERT INTO v2_staff_registry VALUES(?,?)').run('staff-fixture', JSON.stringify({ ready: true }));
    const before = new Map([filename, `${filename}-wal`].map(file => [file, fs.readFileSync(file)]));
    const backupFolder = path.join(f.root, 'backups', 'fresh-consistent');
    fs.mkdirSync(backupFolder);
    f.input.backup = async () => {
      assert.equal(f.states.active, false);
      await backup(db, path.join(backupFolder, 'workflow.sqlite'));
      return { integrity: 'ok', folder: backupFolder };
    };
    const result = await applyRelease(f.input);
    assert.equal(result.ok, true);
    assert.equal(f.states.startCalls, 1);
    assert.equal(f.read('config.workflow.local.json'), 'private-old');
    assert.equal(f.read('backups/old.sqlite'), 'backup-old');
    assert.equal(f.read('node_modules/package/index.mjs'), 'dependency-old');
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.ok(fs.existsSync(`${filename}-shm`));
    const saved = new DatabaseSync(path.join(backupFolder, 'workflow.sqlite'), { readOnly: true });
    try {
      assert.equal(saved.prepare("SELECT value FROM v2_meta WHERE key='initialized'").get().value, 'true');
      assert.equal(saved.prepare("SELECT data FROM v2_outbox WHERE id='sent-once'").get().data, sent);
      assert.equal(saved.prepare("SELECT data FROM v2_outbox WHERE id='awaiting-review'").get().data, JSON.stringify({ state: 'review', errorCode: 'SEND_OUTCOME_UNKNOWN' }));
      assert.equal(saved.prepare("SELECT data FROM v2_mirrors WHERE id='trusted-source-child'").get().data, mirror);
      assert.equal(saved.prepare('SELECT COUNT(*) AS count FROM v2_staff_registry').get().count, 1);
    } finally { saved.close(); }
  } finally { db.close(); }
});
