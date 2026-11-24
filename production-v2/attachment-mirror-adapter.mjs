import { createHash } from 'node:crypto';
import { WorkflowClient } from './client.mjs';
import { StaffAdminClient } from './staff-admin-client.mjs';
import { boundedSalesDetailClient } from './sales-mirror.mjs';
import { BitableAttachmentClient } from './bitable-attachment.mjs';
import { AttachmentSyncJournal, AttachmentSyncWorker } from './attachment-sync-worker.mjs';

const ATTACHMENT_NAME = '运营跟客户沟通截图';
const BASE = /^[A-Za-z0-9]{10,128}$/;
const TABLE = /^tbl[A-Za-z0-9]{5,100}$/;
const RECORD = /^rec[A-Za-z0-9]{5,100}$/;
const FIELD = /^fld[A-Za-z0-9]{5,100}$/;
const PERSON = /^ou_[A-Za-z0-9_-]{5,100}$/;
const APP_ID = /^cli_[A-Za-z0-9]{5,100}$/;
const MIRROR_ID = /^[a-f0-9]{64}$/;
const fits = (value, pattern) => typeof value === 'string' && pattern.test(value);
const supportedRole = role => role === 'sales' || role === 'operator';
const deny = code => { throw Object.assign(new Error(code), { code }); };
const need = (yes, code) => { if (!yes) deny(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourcePath = target => `/open-apis/bitable/v1/apps/${target.appToken}/tables/${target.tableId}`;
const recordPath = target => `${sourcePath(target)}/records/${target.recordId}`;
const tablePin = input => Object.freeze({ appToken: input.appToken, tableId: input.tableId, fieldId: input.fieldId });
const recordGone = error => ['1254043', 'RECORD_NOT_FOUND'].includes(String(error?.code));

function validateTable(input) {
  need(fits(input?.appToken, BASE) && fits(input.tableId, TABLE) && fits(input.fieldId, FIELD), 'ATTACHMENT_TABLE_PIN_INVALID');
  return tablePin(input);
}

function parsed(row) {
  if (!row) return null;
  let value;
  try { value = JSON.parse(row.data); }
  catch { deny('ATTACHMENT_SQLITE_PAYLOAD_INVALID'); }
  need(value && value.id === row.id, 'ATTACHMENT_SQLITE_PAYLOAD_INVALID');
  return value;
}

function singlePerson(values) {
  if (!Array.isArray(values) || values.length !== 1) return '';
  const { id, open_id: openId } = values[0] ?? {};
  return fits(id ?? openId, PERSON) && !(id && openId && id !== openId) ? id ?? openId : '';
}
const knownPerson = values => values == null || Array.isArray(values) && (values.length === 0 || Boolean(singlePerson(values)));

function files(values) {
  if (values == null) return [];
  need(Array.isArray(values) && values.every(item => fits(item?.file_token, BASE)), 'ATTACHMENT_RECORD_VALUE_INVALID');
  return values.map(item => ({ fileToken: item.file_token, name: typeof item.name === 'string' ? item.name : '' }));
}

function fixedReaders(values) {
  need(Array.isArray(values) && values.every(item => fits(item?.openId, PERSON)), 'ATTACHMENT_FIXED_READERS_INVALID');
  const identities = values.map(item => item.openId).sort();
  need(new Set(identities).size === identities.length, 'ATTACHMENT_FIXED_READERS_INVALID');
  return Object.freeze(identities);
}

/** Builds a limited processor for explicit target-field pins. The existing runner must own its scheduling. */
export class AttachmentMirrorAdapter {
  #targets;
  #query;
  #worker;
  #work = null;

  constructor({ db, client, admin, mediaFetch = fetch, source, targetPins, enabledRoles, verifyLiveConfig, readCurrentStaff, verifyEffectiveAcl } = {}) {
    const config = client?.config;
    need(db?.prepare && client instanceof WorkflowClient && admin instanceof StaffAdminClient &&
      admin.sourceClient === client && client.retryMutations === false && config?.enabled === true &&
      config.notification?.enabled === true && config.staffManagement?.enabled === true && fits(config.appId, APP_ID) &&
      Array.isArray(enabledRoles) && enabledRoles.length > 0 && enabledRoles.every(supportedRole) &&
      typeof verifyLiveConfig === 'function' && typeof readCurrentStaff === 'function' &&
      typeof verifyEffectiveAcl === 'function' && typeof mediaFetch === 'function',
    'ATTACHMENT_ADAPTER_CONFIGURATION_INVALID');
    this.source = validateTable(source);
    need(this.source.appToken === config.appToken && this.source.tableId === config.tableIds?.leads &&
      Array.isArray(targetPins) && targetPins.length > 0, 'ATTACHMENT_ADAPTER_CONFIGURATION_INVALID');
    const ownerField = config.fields?.leads?.owner?.fieldId;
    const operatorField = config.fields?.leads?.operator?.fieldId;
    need(fits(ownerField, FIELD) && fits(operatorField, FIELD) &&
      new Set([ownerField, operatorField, this.source.fieldId]).size === 3, 'ATTACHMENT_ADAPTER_CONFIGURATION_INVALID');
    this.actorFields = Object.freeze({ ownerField, operatorField });
    this.appId = config.appId;
    this.rosterBase = config.staffManagement.appToken;
    this.fixedReaders = fixedReaders(config.staffManagement.fixedReaders ?? []);
    this.roles = Object.freeze([...enabledRoles]);
    this.client = client;
    this.admin = admin;
    this.verifyLiveConfig = verifyLiveConfig;
    this.verifyEffectiveAcl = verifyEffectiveAcl;
    this.readCurrentStaff = readCurrentStaff;
    this.#targets = new Map();
    for (const raw of targetPins) {
      const pin = validateTable(raw);
      need(this.roles.includes(raw.role) && fits(raw.personId, PERSON) && !this.#targets.has(pin.appToken) &&
        ![this.source.appToken, config.staffManagement.appToken].includes(pin.appToken),
      'ATTACHMENT_TARGET_PIN_INVALID');
      this.#targets.set(pin.appToken, Object.freeze({ ...pin, role: raw.role, personId: raw.personId }));
    }
    this.#query = {
      sales: db.prepare('SELECT id,source_id,version,data FROM v2_mirrors WHERE id=? AND state=?'),
      salesSource: db.prepare('SELECT id FROM v2_mirrors WHERE source_id=? AND state=\'active\''),
      salesTarget: db.prepare(`SELECT id FROM v2_mirrors WHERE state='active' AND json_extract(data,'$.target.appToken')=?
        AND json_extract(data,'$.target.tableId')=? AND json_extract(data,'$.targetRecordId')=?`),
      ...(this.roles.includes('operator') ? { operator: db.prepare(`SELECT id,data FROM v2_operator_copies WHERE id=? AND json_extract(data, '$.state')=?`),
      operatorSource: db.prepare(`SELECT id FROM v2_operator_copies WHERE json_extract(data,'$.state')='active' AND json_extract(data,'$.sourceId')=?`),
      operatorTarget: db.prepare(`SELECT id FROM v2_operator_copies WHERE json_extract(data,'$.state')='active' AND json_extract(data,'$.targetRecordId')=?`),
      operatorResource: db.prepare('SELECT id,data FROM v2_operator_resources WHERE id=?'),
      operatorMeta: db.prepare("SELECT value FROM v2_operator_meta WHERE key='binding'") } : {}),
      staff: db.prepare("SELECT id,data FROM v2_staff_registry WHERE json_extract(data, '$.openId')=?"),
    };
    this.#worker = new AttachmentSyncWorker({
      transport: new BitableAttachmentClient({
        tenantToken: () => this.#requestClient().tenantToken(),
        fetchImpl: (url, options) => {
          const signal = this.#work?.signal;
          signal?.throwIfAborted();
          return mediaFetch(url, { ...options, signal: signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal });
        },
      }),
      journal: new AttachmentSyncJournal(db),
      policy: { appId: config.appId, source: this.source, enabledRoles, salesFixedReaders: this.fixedReaders },
      readBinding: scope => this.#freshBinding(scope),
      readSource: pin => this.#readSource(pin),
      readTarget: pin => this.#readTarget(pin),
      readRetiredBinding: scope => this.#freshRetiredBinding(scope),
      readRetiredTarget: pin => this.#readRetiredTarget(pin),
      readAcl: pin => this.#readAcl(pin),
      writeTarget: (pin, tokens) => this.#writeTarget(pin, tokens),
    });
  }

  #requestClient() {
    return this.#work?.client ?? this.client;
  }

  #resolve(role, mirrorId, state = 'active') {
    need(this.roles.includes(role) && fits(mirrorId, MIRROR_ID), 'ATTACHMENT_MIRROR_REQUEST_INVALID');
    const stored = this.#query[role].get(mirrorId, state);
    const mirror = parsed(stored);
    if (!mirror) return null;
    need(mirror.state === state && fits(mirror.sourceId, RECORD) && fits(mirror.targetRecordId, RECORD) &&
      Number.isSafeInteger(mirror.version) && mirror.version > 0, 'ATTACHMENT_MIRROR_STATE_INVALID');
    let target, personId, duplicateRows;
    if (role === 'sales') {
      need(stored.source_id === mirror.sourceId && stored.version === mirror.version &&
        mirror.sourceAppToken === this.source.appToken && mirror.sourceTableId === this.source.tableId, 'ATTACHMENT_MIRROR_SOURCE_INVALID');
      personId = mirror.owner;
      target = mirror.target;
      duplicateRows = this.#query.salesTarget.all(target?.appToken ?? '', target?.tableId ?? '', mirror.targetRecordId);
    } else {
      const root = this.#query.operatorMeta.get()?.value;
      need(root === digest([this.appId, this.source.appToken, this.source.tableId]), 'ATTACHMENT_MIRROR_SOURCE_INVALID');
      personId = mirror.operatorId;
      const resource = parsed(this.#query.operatorResource.get(personId ?? ''));
      need(resource?.stage === 'ready' && resource.baseToken === resource.target?.appToken, 'ATTACHMENT_OPERATOR_RESOURCE_INVALID');
      target = resource.target;
      duplicateRows = this.#query.operatorTarget.all(mirror.targetRecordId);
    }
    const sourceRows = this.#query[`${role}Source`].all(mirror.sourceId);
    const approved = this.#targets.get(target?.appToken);
    const recordsMatch = state === 'active'
      ? sourceRows.length === 1 && sourceRows[0].id === mirrorId && duplicateRows.length === 1 && duplicateRows[0].id === mirrorId
      : duplicateRows.length === 0;
    need(fits(personId, PERSON) && recordsMatch && approved?.role === role &&
      approved.personId === personId && approved.tableId === target.tableId, 'ATTACHMENT_SCOPE_PIN_MISMATCH');
    const scope = { role, personId, mirrorId, source: { ...this.source, recordId: mirror.sourceId },
      target: { ...tablePin(approved), recordId: mirror.targetRecordId } };
    if (state === 'revoked') return { scope };
    const staffRows = this.#query.staff.all(personId);
    const staff = staffRows.length === 1 ? parsed(staffRows[0]) : null;
    need(staff?.role === role && staff.state === 'ready' && staff.enabled === true && staff.ready === true && staff.retired !== true &&
      fits(staff.recordId, RECORD) && fits(staff.inputVersion, MIRROR_ID) &&
      (role === 'operator' || staff.id === mirror.memberId && staff.target?.appToken === target.appToken &&
        staff.target.tableId === target.tableId), 'ATTACHMENT_MIRROR_STAFF_INVALID');
    return { scope, staff: { recordId: staff.recordId, inputVersion: staff.inputVersion } };
  }

  async #checkConfig() {
    need(await this.verifyLiveConfig() === true, 'ATTACHMENT_MIRROR_CONFIG_CHANGED');
    const config = this.client.config;
    need(config.appId === this.appId && this.client.retryMutations === false && config.enabled === true &&
      config.notification?.enabled === true && config.staffManagement?.enabled === true &&
      config.appToken === this.source.appToken && config.tableIds?.leads === this.source.tableId &&
      config.staffManagement.appToken === this.rosterBase &&
      same(this.fixedReaders, fixedReaders(config.staffManagement.fixedReaders ?? [])) &&
      config.fields?.leads?.owner?.fieldId === this.actorFields.ownerField &&
      config.fields?.leads?.operator?.fieldId === this.actorFields.operatorField, 'ATTACHMENT_MIRROR_CONFIG_CHANGED');
  }

  async #freshBinding(scope) {
    const found = this.#resolve(scope.role, scope.mirrorId);
    need(found && same(found.scope, scope), 'ATTACHMENT_MIRROR_BINDING_CHANGED');
    await this.#checkConfig();
    const staff = await this.readCurrentStaff(found.staff.recordId, { client: this.#requestClient(), signal: this.#work?.signal });
    need(staff?.recordId === found.staff.recordId && staff.role === scope.role && staff.openId === scope.personId &&
      staff.version === found.staff.inputVersion && staff.effectiveEnabled === true &&
      same(found, this.#resolve(scope.role, scope.mirrorId)), 'ATTACHMENT_MIRROR_STAFF_CHANGED');
    return { ...found.scope, state: 'active' };
  }

  async #freshRetiredBinding(scope) {
    const found = this.#resolve(scope.role, scope.mirrorId, 'revoked');
    need(found && same(found.scope, scope), 'ATTACHMENT_RETIREMENT_UNCONFIRMED');
    await this.#checkConfig();
    let current;
    try { current = await this.#readSource(scope.source); }
    catch (error) { if (!recordGone(error)) throw error; }
    if (current) {
      const known = scope.role === 'sales' ? current.ownerKnown : current.operatorKnown;
      const person = scope.role === 'sales' ? current.ownerId : current.operatorId;
      need(known && person !== scope.personId, 'ATTACHMENT_RETIREMENT_UNCONFIRMED');
    }
    need(same(found, this.#resolve(scope.role, scope.mirrorId, 'revoked')), 'ATTACHMENT_RETIREMENT_UNCONFIRMED');
    return { ...found.scope, state: 'revoked' };
  }

  #validateTarget(pin) {
    const approved = this.#targets.get(pin?.appToken);
    need(fits(pin?.recordId, RECORD) && approved && same(tablePin(approved), tablePin(pin)), 'ATTACHMENT_TARGET_PIN_INVALID');
    return approved;
  }

  async #schema(pins) {
    const result = await this.#requestClient().api(`${sourcePath(pins)}/fields`, { method: 'GET', query: { page_size: 100 } });
    need(result?.has_more === false && Array.isArray(result.items), 'ATTACHMENT_REMOTE_SCHEMA_INCOMPLETE');
    const match = (id, type, name) => {
      const matches = result.items.filter(field => field.field_id === id);
      const field = matches[0];
      need(matches.length === 1 && field.type === type && typeof field.field_name === 'string' &&
        field.field_name.trim() && (!name || name === field.field_name) &&
        result.items.filter(item => item.field_name === field.field_name).length === 1, 'ATTACHMENT_REMOTE_SCHEMA_CHANGED');
      return field.field_name;
    };
    return { match };
  }

  async #record(pin, checks) {
    const schema = await this.#schema(pin);
    const names = Object.fromEntries(checks.map(([key, id, type, name]) => [key, schema.match(id, type, name)]));
    const result = await this.#requestClient().api(recordPath(pin), { method: 'GET', query: { user_id_type: 'open_id' } });
    const record = result?.record;
    need(record?.record_id === pin.recordId && record.fields && !Array.isArray(record.fields) &&
      typeof record.fields === 'object', 'ATTACHMENT_REMOTE_RECORD_CHANGED');
    const verified = await this.#schema(pin);
    for (const [key, id, type] of checks) verified.match(id, type, names[key]);
    return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, record.fields[name]]));
  }

  async #readSource(pin) {
    need(fits(pin?.recordId, RECORD) && same(tablePin(pin), this.source), 'ATTACHMENT_SOURCE_PIN_INVALID');
    const { owner, operator, attachment } = await this.#record(pin, [
      ['owner', this.actorFields.ownerField, 11], ['operator', this.actorFields.operatorField, 11],
      ['attachment', pin.fieldId, 17, ATTACHMENT_NAME],
    ]);
    return { ...pin, complete: true, fieldType: 17, ownerId: singlePerson(owner), operatorId: singlePerson(operator),
      ownerKnown: knownPerson(owner), operatorKnown: knownPerson(operator),
      attachments: files(attachment) };
  }

  async #readTarget(pin) {
    this.#validateTarget(pin);
    const { attachment } = await this.#record(pin, [['attachment', pin.fieldId, 17, ATTACHMENT_NAME]]);
    return { ...pin, complete: true, fieldType: 17, fileTokens: files(attachment).map(item => item.fileToken) };
  }

  async #readRetiredTarget(pin) {
    try { return await this.#readTarget(pin); }
    catch (error) {
      if (!recordGone(error)) throw error;
      return { ...pin, complete: true, missing: true, fileTokens: [] };
    }
  }

  async #readAcl(pin) {
    this.#validateTarget(pin);
    const admin = this.#work?.admin ?? this.admin;
    const sharing = Object.freeze({ ...await admin.getSharing(pin.appToken) });
    const members = Object.freeze((await admin.listMembers(pin.appToken)).map(member => Object.freeze({ ...member })));
    need(await this.verifyEffectiveAcl(pin, sharing, members, { signal: this.#work?.signal }) === true, 'ATTACHMENT_EFFECTIVE_ACL_UNVERIFIED');
    const verifiedApp = members.filter(member => member.isApp === true && member.memberType === 'openid');
    need(verifiedApp.length <= 1, 'ATTACHMENT_APP_ID_UNVERIFIED');
    const normalized = members.map(member => member.isApp === true
      ? { ...member, memberType: 'appid', openId: this.appId }
      : member);
    return { ...sharing, complete: true, appToken: pin.appToken, members: normalized };
  }

  async #writeTarget(pin, attachments) {
    this.#validateTarget(pin);
    need(this.client.retryMutations === false &&
      Array.isArray(attachments) && attachments.every(item => Object.keys(item).length === 1 && fits(item.file_token, BASE)),
    'ATTACHMENT_RECORD_WRITE_INVALID');
    const schema = await this.#schema(pin);
    const name = schema.match(pin.fieldId, 17, ATTACHMENT_NAME);
    await this.#requestClient().api(recordPath(pin), { method: 'PUT', body: { fields: { [name]: attachments.length ? attachments : null } } });
  }

  async #workOn(signal, operation) {
    if (this.#work) return { status: 'pending', code: 'ATTACHMENT_ADAPTER_BUSY' };
    if (signal?.aborted) return { status: 'pending', code: 'ATTACHMENT_STOP_REQUESTED' };
    this.#work = {
      signal,
      client: signal ? boundedSalesDetailClient(this.client, signal) : this.client,
      admin: signal ? boundedSalesDetailClient(this.admin, signal) : this.admin,
    };
    try { return await operation(); }
    finally { this.#work = null; }
  }

  async run(role, mirrorId, options) {
    const found = this.#resolve(role, mirrorId);
    if (!found) return { status: 'skipped', code: 'ATTACHMENT_MIRROR_NOT_ACTIVE' };
    return this.#workOn(options?.signal, () => this.#worker.run(found.scope, options));
  }

  async retire(role, mirrorId, options) {
    const found = this.#resolve(role, mirrorId, 'revoked');
    if (!found) return { status: 'skipped', code: 'ATTACHMENT_MIRROR_NOT_REVOKED' };
    return this.#workOn(options?.signal, () => this.#worker.retire(found.scope, options));
  }
}
