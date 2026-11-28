import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIND = 'shiyeji-production-dispatch';
export const filesFor = (root = ROOT) => ({ data: path.join(root, 'data'), lock: path.join(root, 'data/production.lock.json'), status: path.join(root, 'data/production.status.json'), stop: path.join(root, 'data/production.stop.json') });
export function safeCode(error) { return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'PRODUCTION_OPERATION_FAILED'; }
export function safeDetailStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ['detailPending', 'detailOldestPendingAt', 'detailNextAttemptAt', 'detailLastAttemptAt', 'detailLastSuccessAt',
    'detailAttempts', 'detailWrites', 'detailConfirmed', 'detailReviews', 'detailTimeouts', 'detailPreempted', 'detailRateLimited', 'detailWriteUnconfirmed',
    'detailAttemptsTotal', 'detailWritesTotal', 'detailConfirmedTotal', 'detailReviewsTotal', 'detailTimeoutsTotal', 'detailPreemptedTotal', 'detailRateLimitedTotal', 'detailWriteUnconfirmedTotal']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (typeof value.detailLastErrorCode === 'string' && (value.detailLastErrorCode === '' || /^[A-Z0-9_]{1,80}$/.test(value.detailLastErrorCode))) result.detailLastErrorCode = value.detailLastErrorCode;
  return Object.keys(result).length ? result : undefined;
}
export function safeAttachmentStatus(value) {
  if (!['not_configured', 'disabled', 'blocked', 'enabled'].includes(value?.state)) return undefined;
  const result = { state: value.state };
  if (value.state === 'enabled') result.ready = value.ready === true;
  if (typeof value.errorCode === 'string' && /^ATTACHMENT_[A-Z0-9_]{1,69}$/.test(value.errorCode)) result.errorCode = value.errorCode;
  return result;
}
export function ordinaryFile(filename, max = 1024 * 1024) {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw Object.assign(new Error('文件状态异常'), { code: 'UNSAFE_FILE' });
  return stat;
}
export function readObject(filename) { if (!existsSync(filename)) return null; ordinaryFile(filename); const value = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('无效状态'), { code: 'INVALID_STATE' }); return value; }
export function processState(pid) { if (!Number.isInteger(pid) || pid < 1) return 'unknown'; try { process.kill(pid, 0); return 'alive'; } catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; } }
function checkedData(root) { const files = filesFor(root); mkdirSync(files.data, { recursive: true }); const stat = lstatSync(files.data); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('数据目录异常'), { code: 'UNSAFE_DIRECTORY' }); return files; }
export function validLock(lock) { return lock?.kind === KIND && Number.isInteger(lock.pid) && lock.pid > 0 && typeof lock.token === 'string' && /^[a-f0-9-]{36}$/i.test(lock.token); }
export function acquireLock(root = ROOT, { alive = processState } = {}) {
  const files = checkedData(root);
  if (existsSync(files.lock)) {
    ordinaryFile(files.lock);
    const beforeText = readFileSync(files.lock, 'utf8');
    const lock = readObject(files.lock);
    if (!validLock(lock) || alive(lock.pid) !== 'absent' || alive(lock.pid) !== 'absent') throw Object.assign(new Error('已有实例或进程状态不明'), { code: 'INSTANCE_EXISTS_OR_UNKNOWN' });
    ordinaryFile(files.lock);
    if (readFileSync(files.lock, 'utf8') !== beforeText) throw Object.assign(new Error('运行锁变化'), { code: 'LOCK_CHANGED' });
    const archive = path.join(files.data, `production.lock.stale-${Date.now()}-${randomUUID()}.json`);
    renameSync(files.lock, archive);
  }
  const lock = { kind: KIND, pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
  const fd = openSync(files.lock, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(lock)); } finally { closeSync(fd); }
  return { lock, files, release() { try { if (readObject(files.lock)?.token === lock.token) unlinkSync(files.lock); } catch {} try { if (readObject(files.stop)?.token === lock.token) unlinkSync(files.stop); } catch {} } };
}
export function writeSnapshot(root, value) {
  const files = checkedData(root);
  if (existsSync(files.status)) ordinaryFile(files.status);
  const temp = path.join(files.data, `.production-status-${randomUUID()}.pending`);
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, files.status); } finally { try { if (existsSync(temp)) unlinkSync(temp); } catch {} }
}
export function status(root = ROOT, { now = Date.now, alive = processState } = {}) {
  const files = filesFor(root), lock = readObject(files.lock), snapshot = readObject(files.status);
  if (lock && !validLock(lock)) throw Object.assign(new Error('运行锁无效'), { code: 'INVALID_LOCK' });
  const matching = Boolean(lock && snapshot?.kind === KIND && snapshot.pid === lock.pid && snapshot.token === lock.token);
  const age = matching ? now() - Date.parse(snapshot.checkedAt) : NaN;
  const processStatus = lock ? alive(lock.pid) : 'absent';
  const fresh = matching && Number.isFinite(age) && age >= -2000 && age < 20000;
  const staffStatus=matching&&typeof snapshot.staffHealthy==='boolean'?{staffHealthy:snapshot.staffHealthy,staffErrors:Array.isArray(snapshot.staffErrors)?snapshot.staffErrors.map(code=>safeCode({code})):[]}:{};
  const release=matching&&/^2\.\d+\.\d+$/.test(snapshot.runnerRelease||'')?{runnerRelease:snapshot.runnerRelease}:{};
  const detailStatus = matching ? safeDetailStatus(snapshot.salesDetails) : undefined;
  const attachmentStatus = matching ? safeAttachmentStatus(snapshot.attachmentSync) : undefined;
  return { kind: KIND, processStatus, running: processStatus === 'alive' && fresh, statusFresh: fresh, heartbeatAgeSeconds: Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : null, pid: lock?.pid || null,
    ...staffStatus,...release,...(detailStatus ? { salesDetails: detailStatus } : {}), ...(attachmentStatus ? { attachmentSync: attachmentStatus } : {}),
    ...(matching ? { phase: snapshot.phase, connection: snapshot.connection, initialized: snapshot.initialized, counts: snapshot.counts, lastScan: snapshot.lastScan, lastErrorCode: snapshot.lastErrorCode, nextScanAt: snapshot.nextScanAt, enabled: snapshot.enabled, notificationsEnabled: snapshot.notificationsEnabled } : { phase: lock ? 'unknown' : 'stopped' }) };
}
export function requestStop(root = ROOT) {
  const files = filesFor(root), lock = readObject(files.lock);
  if (!lock) return { requested: false, reason: 'not_running' };
  if (!validLock(lock) || processState(lock.pid) !== 'alive') throw Object.assign(new Error('无法核验运行进程'), { code: 'INSTANCE_UNKNOWN' });
  if (existsSync(files.stop)) ordinaryFile(files.stop);
  writeFileSync(files.stop, JSON.stringify({ kind: KIND, pid: lock.pid, token: lock.token, requestedAt: new Date().toISOString() }), { mode: 0o600 });
  return { requested: true, pid: lock.pid, note: '等待在途派单完成后有序退出；没有强杀进程' };
}
export function stopRequested(lease) { const stop = readObject(lease.files.stop); return stop?.kind === KIND && stop.pid === lease.lock.pid && stop.token === lease.lock.token; }
export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['status', 'stop'].includes(args[0])) throw Object.assign(new Error('只支持status或stop'), { code: 'ARGS_INVALID' });
  console.log(JSON.stringify(args[0] === 'status' ? status() : requestStop(), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (error) { console.error(`操作未完成（${safeCode(error)}）；未输出配置或客户数据。`); process.exitCode = 1; } }
