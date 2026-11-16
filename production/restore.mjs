import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ordinaryFile } from './control.mjs';
import { databaseSummary } from './backup.mjs';

export async function restoreBackup(folder, target = path.join(ROOT, 'data/production.sqlite')) {
  ordinaryFile(path.join(folder, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.format !== 'shiyeji-production-backup-v1' || manifest.database !== 'production.sqlite' || manifest.integrity !== 'ok') throw new Error('BACKUP_MANIFEST_INVALID');
  const source = path.join(folder, 'production.sqlite'); ordinaryFile(source, Number.MAX_SAFE_INTEGER);
  const bytes = readFileSync(source);
  if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('BACKUP_HASH_MISMATCH');
  if ([target, `${target}-wal`, `${target}-shm`].some(existsSync)) throw new Error('RESTORE_TARGET_EXISTS');
  const checked = new DatabaseSync(source, { readOnly: true });
  try { const summary = databaseSummary(checked); if (summary.rows !== manifest.rows || summary.metadata !== manifest.metadata) throw new Error('BACKUP_COUNTS_INVALID'); } finally { checked.close(); }
  mkdirSync(path.dirname(target), { recursive: true }); closeSync(openSync(target, 'wx', 0o600));
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try { await backup(sourceDb, target); } finally { sourceDb.close(); }
  const restored = new DatabaseSync(target, { readOnly: true });
  try { const summary = databaseSummary(restored); if (summary.rows !== manifest.rows || summary.metadata !== manifest.metadata) throw new Error('RESTORE_COUNTS_INVALID'); } finally { restored.close(); }
  return { restored: true, target, note: '仅恢复数据库，尚未启动派单。请核对旧机停用、正式配置和初始化状态后再显式启动。' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--from') { console.error('用法：node production/restore.mjs --from "备份目录"'); process.exitCode = 1; }
  else restoreBackup(path.resolve(process.argv[3])).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('正式数据库恢复未完成；不覆盖现有数据库，请核对备份完整性和目标路径。'); process.exitCode = 1; });
}
