import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateStaffManagement } from './staff-config.mjs';

test('public staff settings accept any four distinct identities and familiar display names', () => {
  const raw = JSON.parse(readFileSync(new URL('../config.staff-resource.example.json', import.meta.url))).staffManagement;
  Object.assign(raw, { enabled: true, appToken: 'OfflineStaffBase123', tableId: 'tblOfflineStaff123', operatorFormUrl: 'https://offline.feishu.cn/share/base/form/shrOfflineForm123' });
  for (const [key, spec] of Object.entries(raw.fields)) spec.fieldId = 'fldOffline' + key;
  raw.fixedReaders = Array.from({ length: 4 }, (_, i) => ({ openId: 'ou_offlinePublicReader' + i, displayName: '  Example Reader  ' }));
  const validated = validateStaffManagement(raw);
  assert.equal(validated.fixedReaders.length, 4);
  assert.equal(validated.fixedReaders[0].displayName, 'Example Reader');
  assert.throws(() => validateStaffManagement({ ...raw, fixedReaders: raw.fixedReaders.slice(1) }), { code: 'STAFF_READERS_INVALID' });
  raw.fixedReaders[1].openId = raw.fixedReaders[0].openId;
  assert.throws(() => validateStaffManagement(raw), { code: 'STAFF_READERS_INVALID' });
});
