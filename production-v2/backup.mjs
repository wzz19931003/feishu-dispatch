import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ordinaryFile } from '../production/control.mjs';

export function summarize(db) {
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED');
  const counts = {};
  for (const table of ['v2_meta','v2_snapshots','v2_outbox','v2_mirrors']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('BACKUP_SCHEMA_INVALID');
    counts[table] = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  }
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'v2_staff_*' ORDER BY name").all()){
    if(!/^v2_staff_[a-z0-9_]+$/.test(name))throw new Error('BACKUP_STAFF_SCHEMA_INVALID');
    counts[name]=db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
  }
  return { integrity: 'ok', counts };
}
export async function createBackup({ root = ROOT, source = path.join(root, 'data/workflow.sqlite'), out } = {}) {
  ordinaryFile(source, Number.MAX_SAFE_INTEGER);
  const folder = out || path.join(root, 'backups', `workflow-v2-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
  if (existsSync(folder)) throw new Error('BACKUP_TARGET_EXISTS');
  mkdirSync(folder, { recursive: true });
  const destination = path.join(folder, 'workflow.sqlite'); closeSync(openSync(destination, 'wx', 0o600));
  const current = new DatabaseSync(source, { readOnly: true });
  try { await backup(current, destination); } finally { current.close(); }
  // Only this newly created backup is changed. Materialize it as a standalone
  // rollback-journal file so restoring never needs a WAL/shm sidecar.
  const verified = new DatabaseSync(destination); let summary;
  try { verified.exec('PRAGMA journal_mode=DELETE'); summary = summarize(verified); } finally { verified.close(); }
  const bytes = readFileSync(destination);
  const manifest = { format:'shiyeji-workflow-backup-v2', createdAt:new Date().toISOString(), database:'workflow.sqlite', bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'), ...summary, configIncluded:false };
  writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return { folder, ...manifest };
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if (process.argv.length!==2) { console.error('备份不接受参数。'); process.exitCode=1; }
  else createBackup().then(x=>console.log(JSON.stringify(x,null,2))).catch(()=>{console.error('v2备份失败；原库保留，未输出客户或凭据。');process.exitCode=1;});
}
