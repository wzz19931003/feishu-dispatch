import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ordinaryFile } from './control.mjs';

export function databaseSummary(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED');
  return { integrity: 'ok', rows: db.prepare('SELECT COUNT(*) AS n FROM production_rows').get().n, metadata: db.prepare('SELECT COUNT(*) AS n FROM production_meta').get().n };
}
export async function createBackup({ source = path.join(ROOT, 'data/production.sqlite'), out } = {}) {
  ordinaryFile(source, Number.MAX_SAFE_INTEGER);
  const folder = out || path.join(ROOT, 'backups', `production-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  if (existsSync(folder)) throw new Error('BACKUP_TARGET_EXISTS');
  mkdirSync(folder, { recursive: true });
  const target = path.join(folder, 'production.sqlite'); closeSync(openSync(target, 'wx', 0o600));
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try { await backup(sourceDb, target, { rate: 1000 }); } finally { sourceDb.close(); }
  const verified = new DatabaseSync(target, { readOnly: true });
  let summary; try { summary = databaseSummary(verified); } finally { verified.close(); }
  const bytes = readFileSync(target);
  const manifest = { format: 'shiyeji-production-backup-v1', createdAt: new Date().toISOString(), database: 'production.sqlite', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...summary, configIncluded: false };
  writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { folder, ...manifest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('正式备份命令不接受参数。'); process.exitCode = 1; }
  else createBackup().then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('正式数据库备份未完成；请保留原库，未输出客户内容或密钥。'); process.exitCode = 1; });
}
