import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { migrateV1Backup, v1Binding } from './migration.mjs';
import { writePreparedConfig, prepareWorkflowConfig } from './prepare-config.mjs';
import { workflowConfig, v1Config, schema } from './test-fixtures.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-migration-'));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(directory, { recursive: true, force: true }); });
  const folder = path.join(directory, 'backup'); mkdirSync(folder);
  const old = v1Config(), raw = '{ "id": "recOffline", "state": "notification_sending", "notificationKey": "offline-stable-key", "opaqueLegacy": {"preserve": true} }';
  const source = path.join(folder, 'production.sqlite'), db = new DatabaseSync(source);
  db.exec('CREATE TABLE production_rows(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE production_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  db.prepare('INSERT INTO production_rows VALUES(?,?)').run('recOffline', raw);
  db.prepare('INSERT INTO production_meta VALUES(?,?)').run('binding', JSON.stringify(v1Binding(old)));
  db.prepare('INSERT INTO production_meta VALUES(?,?)').run('initialized', JSON.stringify({ baselineCount: 1, at: '2026-11-01T00:00:00Z' })); db.close();
  const bytes = readFileSync(source), manifest = { format: 'shiyeji-production-backup-v1', database: 'production.sqlite', integrity: 'ok', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), rows: 1, metadata: 2 };
  writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  return { directory, folder, source, old, raw, manifest, target: path.join(directory, 'workflow.sqlite') };
}
test('verified v1 migration preserves exact raw jobs and metadata without initializing v2', t => {
  const f = fixture(t), result = migrateV1Backup({ backupDir: f.folder, v1Config: f.old, workflowConfig: workflowConfig({ targets: false }), target: f.target });
  assert.equal(result.migrated, true); assert.equal(result.initialized, false);
  const db = new DatabaseSync(f.target, { readOnly: true });
  try { assert.equal(db.prepare('SELECT data FROM v2_legacy_jobs').get().data, f.raw); assert.equal(db.prepare('SELECT COUNT(*) n FROM v2_legacy_meta').get().n, 2); assert.equal(JSON.parse(db.prepare("SELECT value FROM v2_meta WHERE key='legacy_import'").get().value).rows, 1); assert.equal(db.prepare("SELECT value FROM v2_meta WHERE key='initialized'").get(), undefined); }
  finally { db.close(); }
  assert.throws(() => migrateV1Backup({ backupDir: f.folder, v1Config: f.old, workflowConfig: workflowConfig(), target: f.target }), { code: 'MIGRATION_TARGET_EXISTS' });
});
test('tampered backup and wrong v1 binding are rejected before creating a target', t => {
  const f = fixture(t); writeFileSync(path.join(f.folder, 'manifest.json'), JSON.stringify({ ...f.manifest, sha256: '0'.repeat(64) }));
  assert.throws(() => migrateV1Backup({ backupDir: f.folder, v1Config: f.old, workflowConfig: workflowConfig(), target: f.target }), { code: 'MIGRATION_HASH_MISMATCH' }); assert.equal(existsSync(f.target), false);
  writeFileSync(path.join(f.folder, 'manifest.json'), JSON.stringify(f.manifest)); const wrong = v1Config(); wrong.fields.leads.wx = 'Renamed Without Matching Old Configuration';
  assert.throws(() => migrateV1Backup({ backupDir: f.folder, v1Config: wrong, workflowConfig: workflowConfig(), target: f.target }), { code: 'MIGRATION_V1_BINDING_MISMATCH' }); assert.equal(existsSync(f.target), false);
});
test('app/Base mismatch and corrupt SQLite with a valid manifest hash fail closed', t => {
  const f = fixture(t), other = workflowConfig(); other.appId = 'cli_otherapplication';
  assert.throws(() => migrateV1Backup({ backupDir: f.folder, v1Config: f.old, workflowConfig: other, target: f.target }), { code: 'MIGRATION_SOURCE_IDENTITY_MISMATCH' });
  const corrupt = Buffer.from('not a sqlite database'); writeFileSync(f.source, corrupt); writeFileSync(path.join(f.folder, 'manifest.json'), JSON.stringify({ ...f.manifest, bytes: corrupt.length, sha256: createHash('sha256').update(corrupt).digest('hex') }));
  assert.throws(() => migrateV1Backup({ backupDir: f.folder, v1Config: f.old, workflowConfig: workflowConfig(), target: f.target }), { code: 'MIGRATION_BACKUP_SCHEMA_INVALID' }); assert.equal(existsSync(f.target), false);
});
test('private config preparation disables switches, requires targets, and refuses overwrite', t => {
  const f = fixture(t), source = path.join(f.directory, 'v1.private.json'), fields = path.join(f.directory, 'fields.json'), output = path.join(f.directory, 'v2.private.json');
  writeFileSync(source, JSON.stringify(f.old)); writeFileSync(fields, JSON.stringify(schema()));
  const result = writePreparedConfig({ from: source, schema: fields, to: output, allowedHost: 'OFFLINE-HOST' });
  const c = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(c.appSecret, f.old.appSecret); assert.equal(c.enabled, false); assert.equal(c.notification.enabled, false); assert.equal(c.allowedHost, 'OFFLINE-HOST'); assert.equal(c.members.every(m => m.target === null), true);
  assert.equal(c.fields.leads.actualSlot.types[0], 2); assert.equal(JSON.stringify(result).includes(f.old.appSecret), false); assert.equal(JSON.stringify(result).includes(f.old.members[0].openId), false);
  assert.throws(() => writePreparedConfig({ from: source, schema: fields, to: output }), { code: 'PREPARE_TARGET_EXISTS' }); assert.equal(JSON.parse(readFileSync(source, 'utf8')).appSecret, f.old.appSecret);
});
test('config preparation preserves stable IDs but does not bless old formula output types', () => {
  const oldSchema = schema(); for (const field of oldSchema) if (['分配位', '分配位排序', '分配销售'].includes(field.field_name)) field.type = 20;
  const c = prepareWorkflowConfig({ v1Config: v1Config(), sourceFields: oldSchema, allowedHost: 'OFFLINE-HOST' });
  assert.deepEqual(c.fields.leads.actualSlot.types, [2]); assert.deepEqual(c.fields.leads.salesName.types, [1]); assert.equal(c.enabled, false);
});
test('new actual-result columns take priority over original formulas and wrong new types never fall back', () => {
  const oldSchema = schema(); for (const field of oldSchema) if (['分配位', '分配位排序', '分配销售'].includes(field.field_name)) field.type = 20;
  const extra = [{ field_id: 'fldNewActualSlot', field_name: '实际分配位', type: 2 }, { field_id: 'fldNewActualSort', field_name: '实际分配顺序', type: 2 }, { field_id: 'fldNewActualName', field_name: '实际分配销售', type: 1 }];
  const c = prepareWorkflowConfig({ v1Config: v1Config(), sourceFields: [...oldSchema, ...extra], allowedHost: 'OFFLINE-HOST' });
  assert.equal(c.fields.leads.actualSlot.fieldId, 'fldNewActualSlot'); assert.equal(c.fields.leads.actualSort.fieldId, 'fldNewActualSort'); assert.equal(c.fields.leads.salesName.fieldId, 'fldNewActualName');
  extra[0].type = 20;
  assert.throws(() => prepareWorkflowConfig({ v1Config: v1Config(), sourceFields: [...oldSchema, ...extra], allowedHost: 'OFFLINE-HOST' }), { code: 'PREPARE_RESULT_TYPE_INVALID' });
});
test('captured metadata wrapper is bound to the original source Base and table', () => {
  const old = v1Config(), captured = { appToken: old.appToken, tableId: old.tableIds.leads, items: schema() };
  assert.equal(prepareWorkflowConfig({ v1Config: old, sourceFields: captured, allowedHost: 'OFFLINE-HOST' }).appToken, old.appToken);
  assert.throws(() => prepareWorkflowConfig({ v1Config: old, sourceFields: { ...captured, appToken: 'OtherSourceToken123' }, allowedHost: 'OFFLINE-HOST' }), { code: 'PREPARE_SOURCE_IDENTITY_MISMATCH' });
  assert.throws(() => prepareWorkflowConfig({ v1Config: old, sourceFields: { ...captured, tableId: 'tblAnotherSource123' }, allowedHost: 'OFFLINE-HOST' }), { code: 'PREPARE_SOURCE_IDENTITY_MISMATCH' });
});
