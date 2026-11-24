import { createHash } from 'node:crypto';
import { BitableAttachmentClient } from './bitable-attachment.mjs';

const ID = /^[A-Za-z0-9]{10,128}$/;
const TABLE = /^tbl[A-Za-z0-9]{5,100}$/;
const RECORD = /^rec[A-Za-z0-9]{5,100}$/;
const FIELD = /^fld[A-Za-z0-9]{5,100}$/;
const PERSON = /^ou_[A-Za-z0-9_-]{5,100}$/;
const APP = /^cli_[A-Za-z0-9]{5,100}$/;
const MIRROR = /^[a-f0-9]{64}$/;
const FIELD_TYPE_ATTACHMENT = 17;
const ROLES = ['sales', 'operator'];
const SALES_READ = ['view', 'edit', 'full_access', 'owner'];
const SALES_EDIT = ['edit', 'full_access', 'owner'];
const APPLICATION_MANAGE = ['full_access', 'owner'];
const RETRYABLE_TRANSPORT_ERRORS = new Set(['ATTACHMENT_OWNERSHIP_UNCONFIRMED', 'ATTACHMENT_AUTH_UNAVAILABLE',
  'ATTACHMENT_DOWNLOAD_REJECTED', 'ATTACHMENT_DOWNLOAD_FAILED', 'ATTACHMENT_UPLOAD_REJECTED', 'ATTACHMENT_COPY_BUSY']);
const UNUSABLE_ATTACHMENT_ERRORS = new Set(['ATTACHMENT_NOT_IMAGE', 'ATTACHMENT_SIZE_LIMIT']);
const safe = (value, pattern) => typeof value === 'string' && pattern.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const problem = code => Object.assign(new Error(code), { code });
const require = (condition, code) => { if (!condition) throw problem(code); };

async function readFresh(reader, value, code) {
  try { return await reader(value); }
  catch { throw problem(code); }
}

function pin(raw, includeRecord = true) {
  require(safe(raw?.appToken, ID) && safe(raw.tableId, TABLE) && safe(raw.fieldId, FIELD) &&
    (!includeRecord || safe(raw.recordId, RECORD)), 'ATTACHMENT_PIN_INVALID');
  return Object.freeze({ appToken: raw.appToken, tableId: raw.tableId, fieldId: raw.fieldId,
    ...(includeRecord ? { recordId: raw.recordId } : {}) });
}

function candidate(raw) {
  require(ROLES.includes(raw?.role) && safe(raw.personId, PERSON) && safe(raw.mirrorId, MIRROR), 'ATTACHMENT_BINDING_INVALID');
  return Object.freeze({ role: raw.role, personId: raw.personId, mirrorId: raw.mirrorId, source: pin(raw.source), target: pin(raw.target) });
}

function attachmentList(values) {
  require(Array.isArray(values) && values.every(item => safe(item?.fileToken, ID)), 'ATTACHMENT_SOURCE_SCHEMA_INVALID');
  const names = values.map(item => Object.freeze({ fileToken: item.fileToken, name: typeof item.name === 'string' ? item.name : '' }));
  require(new Set(names.map(item => item.fileToken)).size === names.length, 'ATTACHMENT_SOURCE_SCHEMA_INVALID');
  return names;
}

function readTokens(values) {
  require(Array.isArray(values) && values.every(value => safe(value, ID)) && new Set(values).size === values.length, 'ATTACHMENT_TARGET_SCHEMA_INVALID');
  return [...values];
}

/** Durable per-destination state. Construct only with the existing caller-owned SQLite connection. */
export class AttachmentSyncJournal {
  constructor(db) {
    require(db?.prepare && db?.exec, 'ATTACHMENT_JOURNAL_INVALID');
    db.exec('CREATE TABLE IF NOT EXISTS v2_attachment_sync (destination TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)');
    this.read = db.prepare('SELECT data, revision FROM v2_attachment_sync WHERE destination=?');
    this.create = db.prepare('INSERT OR IGNORE INTO v2_attachment_sync (destination,revision,data) VALUES (?,0,?)');
    this.commit = db.prepare('UPDATE v2_attachment_sync SET data=?,revision=revision+1 WHERE destination=? AND revision=?');
  }

  load(destination, binding, scope) {
    const initial = { binding, scope, step: 'idle', uploads: [], expected: [] };
    this.create.run(destination, JSON.stringify(initial));
    return this.find(destination, binding, scope);
  }

  find(destination, binding, scope) {
    const row = this.read.get(destination);
    if (!row) return null;
    const data = JSON.parse(row.data);
    require(data.binding === binding && same(data.scope, scope) &&
      ['idle', 'uploading', 'patching', 'retiring', 'retired'].includes(data.step) &&
      Array.isArray(data.uploads) && data.uploads.every(item => Array.isArray(item) && item.length === 2 &&
        item[0] !== item[1] && item.every(value => safe(value, ID))) &&
      new Set(data.uploads.map(([original]) => original)).size === data.uploads.length &&
      new Set(data.uploads.map(([, copy]) => copy)).size === data.uploads.length &&
      Array.isArray(data.expected) && data.expected.every(value => safe(value, ID)), 'ATTACHMENT_JOURNAL_BINDING_INVALID');
    return { ...data, revision: row.revision };
  }

  write(destination, current, changes) {
    const { revision, ...value } = { ...current, ...changes };
    require(this.commit.run(JSON.stringify(value), destination, revision).changes === 1, 'ATTACHMENT_JOURNAL_CONFLICT');
    return { ...value, revision: revision + 1 };
  }
}

/** One candidate at a time. Readers return fresh, complete snapshots without fetching media bytes. */
export class AttachmentSyncWorker {
  constructor({ transport, journal, policy, readBinding, readSource, readTarget, readAcl, writeTarget,
    readRetiredBinding, readRetiredTarget } = {}) {
    require(transport instanceof BitableAttachmentClient && journal instanceof AttachmentSyncJournal &&
      [readBinding, readSource, readTarget, readAcl, writeTarget].every(fn => typeof fn === 'function') &&
      safe(policy?.appId, APP) && (!policy.appOpenId || safe(policy.appOpenId, PERSON)) &&
      Array.isArray(policy.enabledRoles) && policy.enabledRoles.length > 0 && policy.enabledRoles.every(role => ROLES.includes(role)) &&
      Array.isArray(policy.salesFixedReaders) && policy.salesFixedReaders.every(id => safe(id, PERSON)) &&
      (readRetiredBinding === undefined && readRetiredTarget === undefined ||
        typeof readRetiredBinding === 'function' && typeof readRetiredTarget === 'function'),
    'ATTACHMENT_WORKER_ARGUMENTS_INVALID');
    this.transport = transport;
    this.journal = journal;
    this.policy = Object.freeze({ source: pin(policy.source, false), appId: policy.appId,
      appOpenId: policy.appOpenId || '', enabledRoles: Object.freeze([...policy.enabledRoles]),
      salesFixedReaders: Object.freeze([...policy.salesFixedReaders]) });
    this.readBinding = readBinding;
    this.readSource = readSource;
    this.readTarget = readTarget;
    this.readAcl = readAcl;
    this.writeTarget = writeTarget;
    this.readRetiredBinding = readRetiredBinding;
    this.readRetiredTarget = readRetiredTarget;
  }

  #checkAcl(scope, acl) {
    require(acl?.complete === true && acl.appToken === scope.target.appToken &&
      acl.externalAccessEntity === 'closed' && acl.linkShareEntity === 'closed' &&
      acl.manageCollaboratorEntity === 'collaborator_full_access' && Array.isArray(acl.members),
    'ATTACHMENT_ACL_UNCONFIRMED');
    let app = 0, person = 0;
    const seen = new Set();
    for (const member of acl.members) {
      const { memberType, openId, perm } = member ?? {};
      require(!seen.has(openId), 'ATTACHMENT_ACL_UNCONFIRMED');
      seen.add(openId);
      if ((memberType === 'appid' && openId === this.policy.appId) ||
        (memberType === 'openid' && this.policy.appOpenId && openId === this.policy.appOpenId)) {
        require(APPLICATION_MANAGE.includes(perm), 'ATTACHMENT_ACL_UNCONFIRMED');
        app++;
      } else if (memberType === 'openid' && openId === scope.personId) {
        require(scope.role === 'operator' ? perm === 'view' : SALES_EDIT.includes(perm), 'ATTACHMENT_ACL_UNCONFIRMED');
        person++;
      } else {
        require(scope.role === 'sales' && memberType === 'openid' && this.policy.salesFixedReaders.includes(openId) &&
          SALES_READ.includes(perm), 'ATTACHMENT_ACL_UNCONFIRMED');
      }
    }
    require(app === 1 && person === 1, 'ATTACHMENT_ACL_UNCONFIRMED');
  }

  async #checkBinding(scope) {
    const active = await readFresh(this.readBinding, scope, 'ATTACHMENT_BINDING_UNCONFIRMED');
    require(active?.state === 'active' && same(candidate(active), scope), 'ATTACHMENT_BINDING_CHANGED');
  }

  async #audit(scope, shouldStop) {
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    await this.#checkBinding(scope);
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    this.#checkAcl(scope, await readFresh(this.readAcl, scope.target, 'ATTACHMENT_ACL_UNCONFIRMED'));
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    const target = await readFresh(this.readTarget, scope.target, 'ATTACHMENT_TARGET_UNCONFIRMED');
    require(target?.complete === true && same(pin(target), scope.target) &&
      target.fieldType === FIELD_TYPE_ATTACHMENT, 'ATTACHMENT_TARGET_SCHEMA_INVALID');
    const targetTokens = readTokens(target.fileTokens);
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    const source = await readFresh(this.readSource, scope.source, 'ATTACHMENT_SOURCE_UNCONFIRMED');
    const actualOwner = scope.role === 'sales' ? source?.ownerId : source?.operatorId;
    require(source?.complete === true && same(pin(source), scope.source) && source.fieldType === FIELD_TYPE_ATTACHMENT &&
      actualOwner === scope.personId, 'ATTACHMENT_SOURCE_CHANGED');
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    await this.#checkBinding(scope);
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    const attachments = attachmentList(source.attachments);
    return { attachments, sourceTokens: attachments.map(item => item.fileToken), targetTokens };
  }

  #requireManaged(entry, targetTokens) {
    const managed = new Set(entry.uploads.map(([, targetFile]) => targetFile));
    require(targetTokens.every(value => managed.has(value)), 'ATTACHMENT_TARGET_HAS_UNMANAGED_FILES');
  }

  #pinnedScope(input) {
    const scope = candidate(input);
    require(this.policy.enabledRoles.includes(scope.role) && same(pin(scope.source, false), this.policy.source) &&
      scope.source.appToken !== scope.target.appToken, 'ATTACHMENT_WORKER_REQUEST_INVALID');
    return { scope, destination: hash(scope.target), binding: hash([scope, this.policy.appId]) };
  }

  async #auditRetired(scope, shouldStop) {
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    const verify = async () => {
      const old = await readFresh(this.readRetiredBinding, scope, 'ATTACHMENT_RETIREMENT_UNCONFIRMED');
      require(old?.state === 'revoked' && same(candidate(old), scope), 'ATTACHMENT_RETIREMENT_UNCONFIRMED');
    };
    await verify();
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    this.#checkAcl(scope, await readFresh(this.readAcl, scope.target, 'ATTACHMENT_ACL_UNCONFIRMED'));
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    const target = await readFresh(this.readRetiredTarget, scope.target, 'ATTACHMENT_TARGET_UNCONFIRMED');
    require(target?.complete === true && same(pin(target), scope.target) &&
      (target.missing === true || target.fieldType === FIELD_TYPE_ATTACHMENT), 'ATTACHMENT_TARGET_SCHEMA_INVALID');
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    await verify();
    require(!shouldStop(), 'ATTACHMENT_STOP_REQUESTED');
    return target.missing === true ? { missing: true, tokens: [] } : { missing: false, tokens: readTokens(target.fileTokens) };
  }

  async retire(input, { shouldStop = () => false } = {}) {
    const { scope, destination, binding } = this.#pinnedScope(input);
    require(typeof shouldStop === 'function' && typeof this.readRetiredBinding === 'function', 'ATTACHMENT_RETIREMENT_UNAVAILABLE');
    let entry = this.journal.find(destination, binding, scope);
    if (!entry || entry.step === 'retired') return { status: 'skipped', code: 'ATTACHMENT_NOT_MANAGED' };
    let old = await this.#auditRetired(scope, shouldStop);
    if (!old.missing && entry.step === 'patching' && !same(old.tokens, entry.expected)) {
      return { status: 'review', code: 'ATTACHMENT_PATCH_OUTCOME_UNKNOWN' };
    }
    this.#requireManaged(entry, old.tokens);
    if (!old.tokens.length) {
      this.journal.write(destination, entry, { step: 'retired', expected: [] });
      return { status: 'retired' };
    }
    if (entry.step === 'retiring') return { status: 'review', code: 'ATTACHMENT_RETIREMENT_OUTCOME_UNKNOWN' };
    entry = this.journal.write(destination, entry, { step: 'retiring', expected: [] });
    try {
      await this.writeTarget(scope.target, []);
      old = await this.#auditRetired(scope, shouldStop);
    } catch { return { status: 'review', code: 'ATTACHMENT_RETIREMENT_OUTCOME_UNKNOWN' }; }
    if (old.tokens.length) return { status: 'review', code: 'ATTACHMENT_RETIREMENT_OUTCOME_UNKNOWN' };
    this.journal.write(destination, entry, { step: 'retired', expected: [] });
    return { status: 'retired' };
  }

  async #copyOne({ scope, destination, initial, file, options }) {
    let claimed;
    let response;
    try {
      response = await this.transport.copy({
        source: { ...scope.source, ...file },
        target: scope.target,
        assertOwnership: async (pins, phase) => {
          require(['download', 'upload'].includes(phase) && same(pin(pins.source), scope.source) &&
            pins.source.fileToken === file.fileToken && pins.target.appToken === scope.target.appToken &&
            pins.target.tableId === scope.target.tableId && pins.target.recordId === scope.target.recordId,
          'ATTACHMENT_TRANSPORT_PIN_MISMATCH');
          const fresh = await this.#audit(scope, options.shouldStop);
          require(same(fresh.sourceTokens, options.sourceTokens), 'ATTACHMENT_SOURCE_CHANGED');
          this.#requireManaged(initial, fresh.targetTokens);
          if (phase === 'upload') claimed = this.journal.write(destination, initial, { step: 'uploading', sourceToken: file.fileToken });
          return true;
        },
      });
    } catch (error) {
      if (claimed && error?.code === 'ATTACHMENT_UPLOAD_REJECTED') {
        this.journal.write(destination, claimed, { step: 'idle', sourceToken: '' });
        return { status: 'pending', code: 'ATTACHMENT_UPLOAD_REJECTED' };
      }
      if (claimed) return { status: 'review', code: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN' };
      if (RETRYABLE_TRANSPORT_ERRORS.has(error?.code)) return { status: 'pending', code: error.code };
      return { status: 'review', code: UNUSABLE_ATTACHMENT_ERRORS.has(error?.code) ? error.code : 'ATTACHMENT_COPY_UNCONFIRMED' };
    }
    const targetToken = response?.file_token;
    if (!claimed || !safe(targetToken, ID) || options.sourceTokens.includes(targetToken) ||
      claimed.uploads.some(([, value]) => value === targetToken)) return { status: 'review', code: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN' };
    return { entry: this.journal.write(destination, claimed, { step: 'idle', sourceToken: '',
      uploads: [...claimed.uploads, [file.fileToken, targetToken]] }) };
  }

  async run(input, { shouldStop = () => false, maxUploads = 1 } = {}) {
    const { scope, destination, binding } = this.#pinnedScope(input);
    require(typeof shouldStop === 'function' && Number.isSafeInteger(maxUploads) && maxUploads >= 0, 'ATTACHMENT_WORKER_REQUEST_INVALID');
    let fresh = await this.#audit(scope, shouldStop);
    let entry = this.journal.load(destination, binding, scope);
    if (['retired', 'retiring'].includes(entry.step)) return { status: 'review', code: 'ATTACHMENT_MIRROR_WAS_RETIRED' };
    if (entry.step === 'uploading') return { status: 'review', code: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN' };
    if (entry.step === 'patching') {
      if (!same(fresh.targetTokens, entry.expected)) return { status: 'review', code: 'ATTACHMENT_PATCH_OUTCOME_UNKNOWN' };
      entry = this.journal.write(destination, entry, { step: 'idle', expected: [] });
    }
    this.#requireManaged(entry, fresh.targetTokens);
    const initialSource = [...fresh.sourceTokens];
    const cached = new Map(entry.uploads);
    let uploaded = 0;
    for (const file of fresh.attachments) {
      if (cached.has(file.fileToken)) continue;
      if (uploaded >= maxUploads) return { status: 'pending', code: 'ATTACHMENT_UPLOAD_BUDGET_REACHED' };
      const copied = await this.#copyOne({ scope, destination, initial: entry, file, options: { sourceTokens: initialSource, shouldStop } });
      if (!copied.entry) return copied;
      entry = copied.entry;
      cached.set(file.fileToken, entry.uploads.at(-1)[1]);
      uploaded++;
    }
    const desired = initialSource.map(value => cached.get(value));
    if (same(fresh.targetTokens, desired)) return { status: 'unchanged' };
    fresh = await this.#audit(scope, shouldStop);
    require(same(fresh.sourceTokens, initialSource), 'ATTACHMENT_SOURCE_CHANGED');
    this.#requireManaged(entry, fresh.targetTokens);
    if (same(fresh.targetTokens, desired)) return { status: 'unchanged' };
    entry = this.journal.write(destination, entry, { step: 'patching', expected: desired });
    try {
      // The adapter writes only this attachment field, with remote retries disabled.
      await this.writeTarget(scope.target, desired.map(file_token => ({ file_token })));
      fresh = await this.#audit(scope, shouldStop);
    } catch { return { status: 'review', code: 'ATTACHMENT_PATCH_OUTCOME_UNKNOWN' }; }
    if (!same(fresh.targetTokens, desired)) return { status: 'review', code: 'ATTACHMENT_PATCH_OUTCOME_UNKNOWN' };
    this.journal.write(destination, entry, { step: 'idle', expected: [] });
    return { status: 'updated' };
  }
}
