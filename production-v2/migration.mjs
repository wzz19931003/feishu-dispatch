import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig as validateV1 } from '../production/engine.mjs';
import { validateWorkflowConfig, WorkflowValidationError } from './field-map.mjs';

const fail = code => { throw new WorkflowValidationError(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonFile = filename => { try { return JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); } catch { fail('MIGRATION_JSON_INVALID'); } };
function ordinary(filename) { const stat = lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('MIGRATION_FILE_UNSAFE'); return stat; }
function integrity(db) { const rows = db.prepare('PRAGMA integrity_check').all(); if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail('MIGRATION_INTEGRITY_FAILED'); }
export function v1Binding(raw) {
  const c = validateV1(raw);
  return hash(JSON.stringify(canonical([c.appId, c.appToken, c.baseUrl, c.tableIds, c.fields, c.staffSource, c.assignment, c.defaultDomain || ''])));
}
/** Offline only: verify a consistent backup and copy raw legacy jobs into a new v2 database. */
export function migrateV1Backup({ backupDir, v1Config, workflowConfig, target, now = () => new Date().toISOString() }) {
  const v1 = validateV1(v1Config), config = validateWorkflowConfig(workflowConfig, { requireTargets: false });
  if (v1.appId !== config.appId || v1.appToken !== config.appToken || v1.tableIds.leads !== config.tableIds.leads || v1.baseUrl !== config.baseUrl) fail('MIGRATION_SOURCE_IDENTITY_MISMATCH');
  if (typeof backupDir !== 'string' || typeof target !== 'string' || !backupDir || !target) fail('MIGRATION_PATH_REQUIRED');
  const folder = path.resolve(backupDir), source = path.join(folder, 'production.sqlite'), destination = path.resolve(target), manifestPath = path.join(folder, 'manifest.json');
  ordinary(manifestPath); ordinary(source);
  const manifest = jsonFile(manifestPath);
  if (manifest.format !== 'shiyeji-production-backup-v1' || manifest.database !== 'production.sqlite' || manifest.integrity !== 'ok' || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) fail('MIGRATION_MANIFEST_INVALID');
  if (existsSync(`${source}-wal`) && lstatSync(`${source}-wal`).size > 0) fail('MIGRATION_BACKUP_HAS_WAL');
  const bytes = readFileSync(source), sourceHash = hash(bytes);
  if (bytes.length !== manifest.bytes || sourceHash !== manifest.sha256) fail('MIGRATION_HASH_MISMATCH');
  if ([destination, `${destination}-wal`, `${destination}-shm`].some(existsSync)) fail('MIGRATION_TARGET_EXISTS');
  let legacyRows, legacyMeta;
  const checked = new DatabaseSync(source, { readOnly: true });
  try {
    integrity(checked);
    legacyRows = checked.prepare('SELECT id,data FROM production_rows ORDER BY id').all();
    legacyMeta = checked.prepare('SELECT key,value FROM production_meta ORDER BY key').all();
    if (legacyRows.length !== manifest.rows || legacyMeta.length !== manifest.metadata) fail('MIGRATION_COUNTS_MISMATCH');
    const stored = legacyMeta.find(row => row.key === 'binding');
    if (!stored || JSON.parse(stored.value) !== v1Binding(v1)) fail('MIGRATION_V1_BINDING_MISMATCH');
    for (const row of legacyRows) { const value = JSON.parse(row.data); if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== row.id) fail('MIGRATION_LEGACY_ROW_INVALID'); }
    for (const row of legacyMeta) JSON.parse(row.value);
  } catch (error) { if (error instanceof WorkflowValidationError) throw error; fail('MIGRATION_BACKUP_SCHEMA_INVALID'); }
  finally { checked.close(); }
  if (hash(readFileSync(source)) !== sourceHash) fail('MIGRATION_BACKUP_CHANGED');
  const parent = path.dirname(destination); mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink()) fail('MIGRATION_TARGET_UNSAFE');
  closeSync(openSync(destination, 'wx', 0o600));
  let db;
  try {
    db = new DatabaseSync(destination);
    db.exec('CREATE TABLE v2_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE v2_legacy_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE v2_legacy_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); BEGIN IMMEDIATE;');
    const insertJob = db.prepare('INSERT INTO v2_legacy_jobs(id,data) VALUES(?,?)'), insertMeta = db.prepare('INSERT INTO v2_legacy_meta(key,value) VALUES(?,?)');
    for (const row of legacyRows) insertJob.run(row.id, row.data);
    for (const row of legacyMeta) insertMeta.run(row.key, row.value);
    const audit = { importedAt: now(), sourceHash, rows: legacyRows.length, metadata: legacyMeta.length, appId: config.appId, appToken: config.appToken, tableId: config.tableIds.leads, initialized: false };
    db.prepare('INSERT INTO v2_meta(key,value) VALUES(?,?)').run('legacy_import', JSON.stringify(audit));
    db.exec('COMMIT'); integrity(db); db.close(); db = null;
    return { migrated: true, rows: legacyRows.length, metadata: legacyMeta.length, sourceHash, initialized: false, note: '仅导入旧库快照；尚未初始化、联网、派单或发送通知。' };
  } catch (error) {
    try { db?.close(); } catch {}
    // These paths were exclusively created by this invocation; never remove a prior database.
    for (const filename of [`${destination}-wal`, `${destination}-shm`, destination]) { try { if (existsSync(filename)) unlinkSync(filename); } catch {} }
    if (error instanceof WorkflowValidationError) throw error;
    fail('MIGRATION_WRITE_FAILED');
  }
}
export const importV1Backup = migrateV1Backup;
export function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--from', '--v1-config', '--config', '--to'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('MIGRATION_ARGS_INVALID'); options[args[i]] = args[i + 1]; }
  if (Object.keys(options).length !== 4) fail('MIGRATION_ARGS_INVALID');
  ordinary(options['--v1-config']); ordinary(options['--config']);
  const result = migrateV1Backup({ backupDir: options['--from'], v1Config: jsonFile(options['--v1-config']), workflowConfig: jsonFile(options['--config']), target: options['--to'] });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(); } catch (error) { const code = /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'MIGRATION_FAILED'; console.error(`离线迁移未完成（${code}）；未输出凭据或业务内容。`); process.exitCode = 1; } }
