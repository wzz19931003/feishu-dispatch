import { createHash, randomUUID } from 'node:crypto';
import { OPERATOR_TARGET_NAMES } from './staff-admin-client.mjs';

const copy = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const personId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{5,}$/.test(value);
const rowId = value => typeof value === 'string' && /^rec[A-Za-z0-9]{5,}$/.test(value);
const safe = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code ?? '')) ? String(error.code) : 'OPERATOR_REMOTE_FAILED';
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const missing = error => ['1254043', 'RECORD_NOT_FOUND', 'SOURCE_RECORD_NOT_FOUND', 'SOURCE_NOT_FOUND'].includes(String(error?.code));
const stop = callback => { try { return Boolean(callback()); } catch { return true; } };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const privateSharing = value => value?.externalAccessEntity === 'closed' && value?.linkShareEntity === 'closed' &&
  value?.manageCollaboratorEntity === 'collaborator_full_access';
const fieldTypes = { wx: [1], needs: [1], wxStatus: [3], addMethod: [1, 3], partySize: [1, 2],
  account: [1, 3], channel: [1, 3], leadSource: [1, 3], leadDate: [5], salesName: [1] };
const text = value => value == null ? '' : Array.isArray(value) ? value.map(text).join('') : object(value)
  ? String(value.text ?? value.name ?? '') : String(value);

/** Outbound-only operator copies. Full sync requires a complete snapshot; syncRecord never infers absence. */
export class OperatorMirror {
  constructor({ config, db, client, readSource, resolveSource, assertLiveConfig = async () => {},
    verifyOperator = async () => true, now = Date.now, maxWrites = 40 } = {}) {
    if (!config || !db?.prepare || !client?.api || typeof readSource !== 'function' || typeof resolveSource !== 'function' ||
      typeof assertLiveConfig !== 'function' || typeof verifyOperator !== 'function' || !Number.isSafeInteger(maxWrites) || maxWrites < 1 || maxWrites > 100) {
      fail('OPERATOR_ARGUMENTS_INVALID');
    }
    this.config = config;
    this.db = db;
    this.client = client;
    this.readSource = readSource;
    this.resolveSource = resolveSource;
    this.assertLiveConfig = assertLiveConfig;
    this.verifyOperator = verifyOperator;
    this.now = now;
    this.maxWrites = maxWrites;
    this.busy = false;
    this.active = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS v2_operator_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_operator_resources(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_operator_copies(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_operator_reviews(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    const binding = hash([config.appId, config.appToken, config.tableIds?.leads]);
    const previous = db.prepare("SELECT value FROM v2_operator_meta WHERE key='binding'").get();
    if (previous && previous.value !== binding) fail('OPERATOR_DATABASE_BINDING_MISMATCH');
    if (!previous) db.prepare("INSERT INTO v2_operator_meta(key,value) VALUES('binding',?)").run(binding);
    for (const resource of this.all('resources')) if (resource.stage.endsWith('_inflight')) {
      this.save('resources', { ...resource, stage: 'review', errorCode: 'OPERATOR_RESOURCE_OUTCOME_UNKNOWN' });
      this.review('OPERATOR_RESOURCE_OUTCOME_UNKNOWN', '', resource.id);
    }
    for (const row of this.all('copies')) if (['creating', 'updating', 'revoking'].includes(row.state)) {
      this.save('copies', { ...row, state: 'review', errorCode: 'OPERATOR_COPY_OUTCOME_UNKNOWN' });
      this.review('OPERATOR_COPY_OUTCOME_UNKNOWN', row.sourceId, row.id);
    }
  }

  table(kind) {
    if (!['resources', 'copies', 'reviews'].includes(kind)) fail('OPERATOR_INTERNAL_TABLE_INVALID');
    return `v2_operator_${kind}`;
  }
  all(kind) { return this.db.prepare(`SELECT data FROM ${this.table(kind)} ORDER BY id`).all().map(row => JSON.parse(row.data)); }
  save(kind, value) {
    const result = { ...value, updatedAt: this.now() };
    this.db.prepare(`INSERT INTO ${this.table(kind)}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(result.id, JSON.stringify(result));
    return result;
  }
  review(code, sourceId = '', context = '') {
    const id = hash([code, sourceId, context]);
    this.save('reviews', { id, code, sourceId, context, state: 'open' });
  }
  resolve(context) {
    for (const review of this.all('reviews')) if (review.context === context && review.state === 'open') this.save('reviews', { ...review, state: 'closed' });
  }
  resource(id) { return this.all('resources').find(row => row.id === id); }
  liveCopies(sourceId) { return this.all('copies').filter(row => row.sourceId === sourceId && row.state !== 'revoked'); }
  path(target, suffix) { return `/open-apis/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/${suffix}`; }
  writeRecord(target, suffix, request) {
    // Count attempted remote writes, including uncertain failures. Compensating deletion may exceed the
    // normal batch by one so a source reassignment detected just after creation is removed immediately.
    this.writes++;
    return this.client.api(this.path(target, suffix), request);
  }
  featureEnabled() {
    if (this.config.enabled !== true || this.config.staffManagement?.operatorViews?.enabled !== true) fail('OPERATOR_MIRROR_DISABLED');
  }
  async guard(operator, shouldStop) {
    if (stop(shouldStop)) fail('OPERATOR_STOP_REQUESTED');
    await this.assertLiveConfig();
    this.featureEnabled();
    if (operator && (!this.active.has(operator.openId) || !await this.verifyOperator(copy(operator)))) fail('OPERATOR_NOT_READY');
    if (stop(shouldStop)) fail('OPERATOR_STOP_REQUESTED');
  }
  validateOperators(operators) {
    if (!Array.isArray(operators) || operators.length > 1000) fail('OPERATOR_ROSTER_INVALID');
    const result = new Map();
    for (const operator of operators) {
      if (!object(operator) || !personId(operator.openId) || typeof operator.displayName !== 'string' || !operator.displayName.trim() ||
        operator.displayName.length > 200 || operator.enabled === false || operator.ready === false ||
        operator.role && operator.role !== 'operator' || result.has(operator.openId)) fail('OPERATOR_ROSTER_INVALID');
      result.set(operator.openId, copy(operator));
    }
    return result;
  }
  target(resource) {
    const target = resource.target;
    if (!target || target.appToken !== resource.baseToken || !/^tbl[A-Za-z0-9]{5,}$/.test(target.tableId ?? '') || !object(target.fields)) fail('OPERATOR_TARGET_INVALID');
    if (target.appToken === this.config.appToken || target.appToken === this.config.staffManagement?.appToken ||
      this.config.members?.some(member => member.target?.appToken === target.appToken)) fail('OPERATOR_TARGET_PROTECTED');
    const expected = `${new URL(this.config.baseUrl).origin}/base/${target.appToken}`;
    if (!/^[A-Za-z0-9]{10,}$/.test(target.appToken) || target.baseUrl !== expected) fail('OPERATOR_TARGET_INVALID');
    const ids = new Set();
    for (const [key, spec] of Object.entries(target.fields)) {
      if (!fieldTypes[key] || !/^fld[A-Za-z0-9]{5,}$/.test(spec?.fieldId ?? '') || !Array.isArray(spec.types) || spec.types.length !== 1 ||
        !fieldTypes[key].includes(spec.types[0]) || ids.has(spec.fieldId)) fail('OPERATOR_TARGET_FIELD_INVALID');
      ids.add(spec.fieldId);
    }
    if (['wx', 'needs', 'wxStatus', 'addMethod'].some(key => !target.fields[key])) fail('OPERATOR_TARGET_FIELDS_REQUIRED');
    return target;
  }
  async schema(target) {
    const data = await this.client.api(this.path(target, 'fields'), { method: 'GET', query: { page_size: 100 } });
    if (!Array.isArray(data.items) || data.has_more === true) fail('OPERATOR_SCHEMA_INCOMPLETE');
    const fields = {};
    for (const [key, spec] of Object.entries(target.fields)) {
      const found = data.items.filter(field => field.field_id === spec.fieldId);
      if (found.length !== 1 || !spec.types.includes(found[0].type) || typeof found[0].field_name !== 'string' || !found[0].field_name.trim()) fail('OPERATOR_SCHEMA_CHANGED');
      fields[key] = { fieldId: spec.fieldId, name: found[0].field_name, type: found[0].type, property: found[0].property ?? {} };
    }
    return fields;
  }
  async auditResource(resource) {
    const target = this.target(resource);
    if (!privateSharing(await this.client.getSharing(target.appToken))) fail('OPERATOR_SHARING_NOT_PRIVATE');
    const members = await this.client.listMembers(target.appToken);
    if (!Array.isArray(members)) fail('OPERATOR_COLLABORATORS_INVALID');
    let person = 0, application = 0;
    for (const member of members) {
      if (member.isApp === true && ['owner', 'full_access'].includes(member.perm)) { application++; continue; }
      if (member.memberType === 'openid' && member.openId === resource.id && member.perm === 'view') { person++; continue; }
      fail('OPERATOR_UNKNOWN_COLLABORATOR');
    }
    if (person !== 1 || application !== 1) fail('OPERATOR_COLLABORATORS_UNCONFIRMED');
    return this.schema(target);
  }
  async provisioningStep(resource, operator, operation, next, shouldStop, invoke, accept) {
    await this.guard(operator, shouldStop);
    const stage = resource.stage;
    resource = this.save('resources', { ...resource, stage: `${operation}_inflight` });
    try {
      const result = await invoke(() => this.guard(operator, shouldStop));
      return this.save('resources', { ...resource, ...accept(result), stage: next, errorCode: null });
    } catch (error) {
      const beforeRequest = error?.staffMutationAttempted === false || error?.staffDefinitelyRejected === true;
      const code = beforeRequest ? safe(error) : 'OPERATOR_RESOURCE_OUTCOME_UNKNOWN';
      this.save('resources', { ...resource, stage: beforeRequest ? stage : 'review', errorCode: code });
      this.review(code, '', resource.id);
      throw Object.assign(new Error(code), { code });
    }
  }
  async prepare(operator, shouldStop) {
    let resource = this.resource(operator.openId);
    if (!resource) resource = this.save('resources', { id: operator.openId, displayName: operator.displayName, stage: 'base_needed' });
    if (resource.stage === 'review') fail(resource.errorCode || 'OPERATOR_RESOURCE_REVIEW_REQUIRED');
    for (let step = 0; step < 12; step++) {
      await this.guard(operator, shouldStop);
      if (resource.stage === 'base_needed') {
        resource = await this.provisioningStep(resource, operator, 'base', 'sharing_needed', shouldStop,
          beforeMutation => this.client.createBase({ name: `运营客资—${operator.displayName.trim()}`.slice(0, 255), beforeMutation }), result => {
            if (!/^[A-Za-z0-9]{10,}$/.test(result?.appToken ?? '') || result.appToken === this.config.appToken ||
              result.appToken === this.config.staffManagement?.appToken || this.config.members?.some(member => member.target?.appToken === result.appToken) ||
              this.all('resources').some(other => other.id !== resource.id && other.baseToken === result.appToken)) fail('OPERATOR_CREATED_BASE_INVALID');
            return { baseToken: result.appToken };
          });
      } else if (resource.stage === 'sharing_needed') {
        resource = await this.provisioningStep(resource, operator, 'sharing', 'table_needed', shouldStop,
          beforeMutation => this.client.setPrivateSharing(resource.baseToken, { beforeMutation }), () => ({}));
      } else if (resource.stage === 'table_needed') {
        resource = await this.provisioningStep(resource, operator, 'table', 'member_needed', shouldStop,
          beforeMutation => this.client.createOperatorTable(resource.baseToken, { beforeMutation }), result => {
            this.target({ ...resource, target: result });
            return { target: copy(result) };
          });
      } else if (resource.stage === 'member_needed') {
        resource = await this.provisioningStep(resource, operator, 'member', 'verify', shouldStop,
          beforeMutation => this.client.addMember(resource.baseToken, { openId: operator.openId, perm: 'view', beforeMutation }), () => ({}));
      } else if (resource.stage === 'verify' || resource.stage === 'ready') {
        await this.auditResource(resource);
        await this.guard(operator, shouldStop);
        this.resolve(resource.id);
        return this.save('resources', { ...resource, stage: 'ready', errorCode: null });
      } else fail('OPERATOR_RESOURCE_STAGE_INVALID');
    }
    fail('OPERATOR_RESOURCE_STEP_LIMIT');
  }

  async source(id) {
    try {
      const result = await this.readSource(id);
      if (result === null) return null;
      if (!result || result.id !== id) fail('OPERATOR_SOURCE_RESPONSE_INVALID');
      return result;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  values(view, fields) {
    const result = {};
    for (const [key, spec] of Object.entries(fields)) {
      if (!Object.hasOwn(OPERATOR_TARGET_NAMES, key)) fail('OPERATOR_COPY_FIELD_DENIED');
      const value = view[key];
      if (spec.type === 2 || spec.type === 5) {
        const normalized = text(value).trim();
        result[key] = normalized === '' ? null : Number(normalized);
        if (result[key] !== null && (!Number.isFinite(result[key]) || spec.type === 5 && !Number.isSafeInteger(result[key]))) fail('OPERATOR_VALUE_INVALID');
      } else {
        result[key] = text(value).trim();
        if (spec.type === 3 && result[key] && !spec.property?.options?.some(option => option.name === result[key])) fail('OPERATOR_SELECT_OPTION_MISSING');
      }
    }
    return result;
  }
  childValues(record, fields) {
    const view = Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, record.fields?.[spec.name]]));
    return this.values(view, fields);
  }
  encoded(values, fields) { return Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [fields[key].name, fields[key].type === 3 && value === '' ? null : value])); }
  async child(resource, id) {
    const target = this.target(resource);
    try {
      const data = await this.client.api(this.path(target, `records/${id}`), { method: 'GET' });
      const record = data.record ?? data;
      if (record.record_id !== id || !object(record.fields)) fail('OPERATOR_CHILD_RESPONSE_INVALID');
      return record;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async snapshot(resource) {
    const target = this.target(resource);
    const result = new Map(), cursors = new Set();
    let cursor;
    for (let page = 0; page < 1000; page++) {
      const data = await this.client.api(this.path(target, 'records'), { method: 'GET', query: { page_size: 100, page_token: cursor } });
      if (!Array.isArray(data.items) && !(data.total === 0 && data.has_more === false)) fail('OPERATOR_CHILD_SCAN_INVALID');
      for (const record of data.items ?? []) {
        if (!rowId(record.record_id) || !object(record.fields) || result.has(record.record_id)) fail('OPERATOR_CHILD_SCAN_INVALID');
        result.set(record.record_id, record);
      }
      if (data.has_more !== true) return result;
      if (typeof data.page_token !== 'string' || !data.page_token || cursors.has(data.page_token)) fail('OPERATOR_CHILD_SCAN_INVALID');
      cursor = data.page_token;
      cursors.add(cursor);
    }
    fail('OPERATOR_CHILD_PAGE_LIMIT');
  }
  async authorizeCopy(resource, operator, id, fields, values, shouldStop) {
    await this.guard(operator, shouldStop);
    if (hash(await this.auditResource(resource)) !== hash(fields)) fail('OPERATOR_SCHEMA_CHANGED_BEFORE_WRITE');
    const sourceSchema = await this.resolveSource();
    const current = await this.source(id);
    if (!current || current.operator !== resource.id || hash(this.values(current, fields)) !== hash(values)) fail('OPERATOR_SOURCE_CHANGED');
    if (hash(await this.resolveSource()) !== hash(sourceSchema)) fail('OPERATOR_SOURCE_SCHEMA_CHANGED');
    await this.guard(operator, shouldStop);
  }
  async mutateCopy(row, state, operation, resumeState) {
    row = this.save('copies', { ...row, state });
    try { return await operation(row); }
    catch (error) {
      const beforeRequest = error?.staffMutationAttempted === false || error?.staffDefinitelyRejected === true;
      this.save('copies', { ...row, state: beforeRequest ? resumeState : 'review', errorCode: beforeRequest ? safe(error) : 'OPERATOR_COPY_OUTCOME_UNKNOWN' });
      this.review(beforeRequest ? safe(error) : 'OPERATOR_COPY_OUTCOME_UNKNOWN', row.sourceId, row.id);
      throw error;
    }
  }
  async revoke(row, shouldStop) {
    const resource = this.resource(row.operatorId);
    if (!resource) fail('OPERATOR_RESOURCE_MISSING');
    const current = await this.source(row.sourceId);
    if (current?.operator === row.operatorId && row.state !== 'revoked') return false;
    if (row.state === 'planned' && row.targetRecordId === null) {
      this.save('copies', { ...row, state: 'revoked', errorCode: null });
      this.resolve(row.id);
      return true;
    }
    if (!rowId(row.targetRecordId)) fail('OPERATOR_COPY_REVIEW_REQUIRED');
    const record = await this.child(resource, row.targetRecordId);
    if (record) {
      const target = this.target(resource);
      await this.mutateCopy(row, 'revoking', async () => {
        try {
          await this.client.mutation(() => this.writeRecord(target, `records/${row.targetRecordId}`, { method: 'DELETE' }), async () => {
            await this.guard(null, shouldStop);
            if ((await this.source(row.sourceId))?.operator === row.operatorId && row.state !== 'revoked') fail('OPERATOR_SOURCE_CHANGED');
          });
        } catch (error) {
          if (!missing(error) && error?.staffMutationAttempted === false) throw error;
          if (await this.child(resource, row.targetRecordId)) throw error;
        }
        if (await this.child(resource, row.targetRecordId)) fail('OPERATOR_REVOKE_UNCONFIRMED');
      }, row.state);
    }
    this.save('copies', { ...row, state: 'revoked', errorCode: null });
    this.resolve(row.id);
    return true;
  }
  unchanged(copies, resource, fields, records, desired) {
    if (copies.length !== 1) return false;
    const [row] = copies;
    const record = records.get(row.targetRecordId);
    return row.state === 'active' && row.operatorId === resource.id && Boolean(record) &&
      hash(row.values) === hash(desired) && hash(this.childValues(record, fields)) === hash(desired);
  }
  async ensure(view, resource, operator, fields, records, shouldStop) {
    const active = this.liveCopies(view.id);
    for (const row of active) if (row.operatorId !== view.operator) {
      if (this.writes >= this.maxWrites) { this.scan.revocationBacklog = 1; return; }
      if (!await this.revoke(row, shouldStop)) fail('OPERATOR_SOURCE_CHANGED');
      this.scan.revoked++;
    }
    const copies = this.liveCopies(view.id);
    if (copies.some(row => row.state === 'review')) fail('OPERATOR_COPY_REVIEW_REQUIRED');
    let desired = this.values(view, fields);
    if (this.unchanged(copies, resource, fields, records, desired)) {
      this.scan.unchanged++;
      return;
    }
    if (this.writes >= this.maxWrites) { this.scan.pending++; return; }
    let row = copies.find(item => item.operatorId === resource.id);
    const record = row?.targetRecordId ? records.get(row.targetRecordId) : null;
    const fresh = await this.source(view.id);
    if (!fresh || fresh.operator !== resource.id) fail('OPERATOR_SOURCE_CHANGED');
    desired = this.values(fresh, fields);
    const target = this.target(resource);
    if (row && !record && row.state !== 'planned') {
      this.save('copies', { ...row, state: 'review', errorCode: 'OPERATOR_CHILD_MISSING' });
      fail('OPERATOR_CHILD_MISSING');
    }
    if (!row || row.state === 'planned') {
      if (!row) {
        const version = this.all('copies').filter(item => item.sourceId === view.id).length + 1;
        row = this.save('copies', { id: hash([view.id, version]), sourceId: view.id, operatorId: resource.id, version,
          state: 'planned', targetRecordId: null, token: randomUUID(), values: desired });
      }
      const newRecord = await this.mutateCopy(row, 'creating', () => this.client.mutation(
        () => this.writeRecord(target, 'records', { method: 'POST', query: { client_token: row.token }, body: { fields: this.encoded(desired, fields) } }),
        () => this.authorizeCopy(resource, operator, view.id, fields, desired, shouldStop)), 'planned');
      const id = (newRecord.record ?? newRecord)?.record_id;
      if (!rowId(id) || this.all('copies').some(item => item.id !== row.id && item.targetRecordId === id && item.operatorId === resource.id)) {
        this.save('copies', { ...row, state: 'review', errorCode: 'OPERATOR_CREATE_RESPONSE_INVALID' });
        fail('OPERATOR_CREATE_RESPONSE_INVALID');
      }
      row = this.save('copies', { ...row, state: 'active', targetRecordId: id, values: desired });
      this.scan.created++;
    } else {
      await this.mutateCopy(row, 'updating', () => this.client.mutation(
        () => this.writeRecord(target, `records/${row.targetRecordId}`, { method: 'PUT', body: { fields: this.encoded(desired, fields) } }),
        () => this.authorizeCopy(resource, operator, view.id, fields, desired, shouldStop)), 'active');
      row = this.save('copies', { ...row, state: 'active', values: desired });
      this.scan.updated++;
    }
    this.resolve(row.id);
    const latest = await this.source(view.id);
    if (!latest || latest.operator !== resource.id) {
      if (await this.revoke(row, shouldStop)) this.scan.revoked++;
    }
  }
  async syncRecord(view, { operators, shouldStop = () => false } = {}) {
    if (this.busy) fail('OPERATOR_MIRROR_BUSY');
    if (!object(view) || !rowId(view.id) || view.operator && !personId(view.operator) || typeof shouldStop !== 'function') fail('OPERATOR_SOURCE_SNAPSHOT_INVALID');
    this.featureEnabled();
    const active = this.validateOperators(operators);
    const operator = active.get(view.operator), resource = operator && this.resource(operator.openId);
    // Provisioning and whole-table cleanup belong to the authoritative full scan.
    if (!operator || resource?.stage !== 'ready') return { synced: false, needsReconciliation: true };
    const previous = { active: this.active, scan: this.scan, writes: this.writes };
    this.active = active;
    this.scan = { sourceRecords: 1, created: 0, updated: 0, revoked: 0, unchanged: 0, pending: 0, revocationBacklog: 0, reviews: 0 };
    this.writes = 0;
    this.busy = true;
    try {
      await this.guard(operator, shouldStop);
      const fields = await this.auditResource(resource);
      const records = await this.snapshot(resource);
      if (hash(await this.schema(this.target(resource))) !== hash(fields)) fail('OPERATOR_SCHEMA_CHANGED_DURING_READ');
      const trusted = new Set(this.all('copies').filter(row => row.operatorId === resource.id).map(row => row.targetRecordId));
      for (const id of records.keys()) if (!trusted.has(id)) fail('OPERATOR_UNTRUSTED_CHILD_RECORD');
      const fresh = await this.source(view.id);
      if (!fresh || fresh.operator !== operator.openId) return { synced: false, needsReconciliation: true };
      // Only this source's tombstones may be touched. Omitted sources are never deletions.
      for (const row of this.all('copies').filter(row => row.sourceId === view.id && row.state === 'revoked' && row.targetRecordId)) {
        if (this.writes >= this.maxWrites) return { synced: false, needsReconciliation: true };
        if (await this.revoke(row, shouldStop)) {
          this.scan.revoked++;
          if (row.operatorId === resource.id) records.delete(row.targetRecordId);
        }
      }
      await this.ensure(fresh, resource, operator, fields, records, shouldStop);
      if (this.scan.pending || this.scan.revocationBacklog || stop(shouldStop)) return { synced: false, needsReconciliation: true };
      const copies = this.liveCopies(view.id), row = copies.length === 1 ? copies[0] : null;
      if (row?.state !== 'active' || row.operatorId !== resource.id || !rowId(row.targetRecordId)) return { synced: false, needsReconciliation: true };
      const record = await this.child(resource, row.targetRecordId);
      if (hash(await this.schema(this.target(resource))) !== hash(fields)) fail('OPERATOR_SCHEMA_CHANGED_DURING_READ');
      const current = await this.source(view.id);
      await this.guard(operator, shouldStop);
      if (!record || !current || current.operator !== resource.id || hash(this.childValues(record, fields)) !== hash(this.values(current, fields))) return { synced: false, needsReconciliation: true };
      return { synced: true };
    } catch (error) {
      const code = safe(error);
      this.review(code, view.id, this.liveCopies(view.id)[0]?.id ?? resource.id);
      throw Object.assign(new Error(code), { code });
    } finally {
      this.active = previous.active;
      this.scan = previous.scan;
      this.writes = previous.writes;
      this.busy = false;
    }
  }
  async sync(views, { operators, shouldStop = () => false } = {}) {
    if (this.busy) fail('OPERATOR_MIRROR_BUSY');
    if (!Array.isArray(views) || views.length > 100_000 || new Set(views.map(view => view?.id)).size !== views.length ||
      views.some(view => !rowId(view?.id) || view.operator && !personId(view.operator))) fail('OPERATOR_SOURCE_SNAPSHOT_INVALID');
    this.featureEnabled();
    this.active = this.validateOperators(operators);
    // pending counts deferred copy processing. revocationBacklog is an indicator because
    // cleanup can stop at the first stale row after using the entire quota.
    this.scan = { sourceRecords: views.length, created: 0, updated: 0, revoked: 0, unchanged: 0, pending: 0, revocationBacklog: 0, reviews: 0 };
    this.writes = 0;
    this.busy = true;
    const readyUrls = [];
    try {
      await this.guard(null, shouldStop);
      const byId = new Map(views.map(view => [view.id, view]));
      for (const row of this.all('copies')) {
        const view = byId.get(row.sourceId);
        if (row.state === 'revoked' || view?.operator === row.operatorId) continue;
        if (stop(shouldStop)) break;
        if (this.writes >= this.maxWrites) { this.scan.revocationBacklog = 1; break; }
        try { if (await this.revoke(row, shouldStop)) this.scan.revoked++; }
        catch (error) { this.review(safe(error), row.sourceId, row.id); this.scan.reviews++; }
      }
      const staff = [...this.active.values()];
      const next = this.db.prepare("SELECT value FROM v2_operator_meta WHERE key='next_operator'").get()?.value;
      const start = staff.findIndex(operator => operator.openId === next);
      const ordered = start > 0 ? [...staff.slice(start), ...staff.slice(0, start)] : staff;
      let lastWriter, copiesAtLimit;
      for (const operator of ordered) {
        if (stop(shouldStop)) break;
        const beforeWrites = this.writes;
        try {
          const resource = await this.prepare(operator, shouldStop);
          const fields = await this.auditResource(resource);
          const records = await this.snapshot(resource);
          const trusted = new Set(this.all('copies').filter(row => row.operatorId === resource.id).map(row => row.targetRecordId));
          for (const id of records.keys()) if (!trusted.has(id)) fail('OPERATOR_UNTRUSTED_CHILD_RECORD');
          for (const row of this.all('copies').filter(row => row.operatorId === resource.id && row.state === 'revoked' && records.has(row.targetRecordId))) {
            if (this.writes >= this.maxWrites) { this.scan.revocationBacklog = 1; break; }
            if (await this.revoke(row, shouldStop)) { this.scan.revoked++; records.delete(row.targetRecordId); }
          }
          readyUrls.push({ openId: operator.openId, url: `${resource.target.baseUrl}?table=${resource.target.tableId}` });
          for (const view of views.filter(view => view.operator === operator.openId)) {
            if (stop(shouldStop)) break;
            try {
              if (this.writes < this.maxWrites) {
                await this.ensure(view, resource, operator, fields, records, shouldStop);
                continue;
              }
              // All subsequent record mutations are deferred. Group the settled local state once
              // rather than re-reading the whole SQLite copy table for each untouched source.
              copiesAtLimit ??= Map.groupBy(this.all('copies').filter(row => row.state !== 'revoked'), row => row.sourceId);
              const copies = copiesAtLimit.get(view.id) ?? [];
              if (copies.some(row => row.operatorId !== operator.openId)) this.scan.revocationBacklog = 1;
              else if (copies.some(row => row.state === 'review')) this.scan.reviews++;
              else if (this.unchanged(copies, resource, fields, records, this.values(view, fields))) this.scan.unchanged++;
              else this.scan.pending++;
            } catch (error) { this.review(safe(error), view.id, this.liveCopies(view.id)[0]?.id ?? ''); this.scan.reviews++; }
          }
        } catch (error) { this.review(safe(error), '', operator.openId); this.scan.reviews++; }
        finally { if (this.writes > beforeWrites) lastWriter = operator; }
      }
      if (lastWriter) {
        const following = staff[(staff.indexOf(lastWriter) + 1) % staff.length].openId;
        this.db.prepare(`INSERT INTO v2_operator_meta(key,value) VALUES('next_operator',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(following);
      }
      const nextRetryAt = this.scan.pending || this.scan.revocationBacklog || this.scan.reviews ? this.now() + 60_000 : null;
      this.lastStatus = { ...this.scan, ready: readyUrls.length, stopped: stop(shouldStop), nextRetryAt };
      return { ...this.lastStatus, readyUrls };
    } finally { this.busy = false; }
  }
  status() {
    return { ...(this.lastStatus ?? {}), reviewsOpen: this.all('reviews').filter(review => review.state === 'open').length, busy: this.busy };
  }
  close() {}
}
