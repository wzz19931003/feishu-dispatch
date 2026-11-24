import { createHash } from 'node:crypto';
import { fail, normalizeConfig, object, OrderSyncError, ownerOf, personId, project, recordId, resolveSchema } from './order-schema.mjs';

const pathFor = ({ appToken, tableId }) => `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
const stringify = JSON.stringify;
const sameIds = (actual, expected) => Array.isArray(actual) && stringify([...actual].sort()) === stringify([...expected].sort());
const reason = error => error instanceof OrderSyncError && /^ORDER_[A-Z0-9_]{1,80}$/.test(error.code)
  ? error.code : 'ORDER_AUDIT_REMOTE_FAILED';

function numericCell(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (value.length > 64) fail('ORDER_FIELD_VALUE_INVALID');
  const decimal = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)(?:[eE][+-]?\d+)?$/.exec(value);
  if (decimal?.[0] !== value) fail('ORDER_FIELD_VALUE_INVALID');
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER ||
      (number === 0 && /[1-9]/.test(decimal[1]))) fail('ORDER_FIELD_VALUE_INVALID');
  return number;
}

// This client can audit projected order data and direct/effective permissions.
// Feishu's update endpoint has no revision precondition, so it exposes no mutations.
export class FeishuOrderAudit {
  constructor({ config, client, admin, verifyEffectiveTarget, pageSize = 100, pageLimit = 128 } = {}) {
    const normalized = normalizeConfig(config, { allowNoSales: true });
    if (normalized.fields.儿童数?.type !== 2 || normalized.fields.订单转态?.writable !== true) fail('ORDER_REQUIRED_COLUMNS_MISSING');
    if (typeof client?.api !== 'function' || client.retryMutations !== false || (normalized.sales.length > 0 &&
      (typeof admin?.getSharing !== 'function' || typeof admin?.listMembers !== 'function'))) {
      fail('ORDER_READ_CLIENT_REQUIRED');
    }
    if (verifyEffectiveTarget !== undefined && typeof verifyEffectiveTarget !== 'function') fail('ORDER_EFFECTIVE_VERIFIER_INVALID');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 128) fail('ORDER_AUDIT_LIMIT_INVALID');
    this.config = normalized;
    this.client = client;
    this.admin = admin;
    this.verifyEffectiveTarget = verifyEffectiveTarget;
    this.pageSize = pageSize;
    this.pageLimit = pageLimit;
  }

  async #pages(path, { method = 'GET', body, query = {} } = {}) {
    const result = [], cursors = new Set();
    let cursor;
    for (let i = 0; i < this.pageLimit; i++) {
      if (method === 'POST' && this.client.retryMutations !== false) fail('ORDER_READ_CLIENT_REQUIRED');
      const reply = await this.client.api(path, {
        method, ...(body ? { body } : {}), query: { page_size: this.pageSize, ...query, page_token: cursor },
      });
      if (!object(reply) || typeof reply.has_more !== 'boolean' || (!Array.isArray(reply.items) &&
        !(reply.items == null && reply.has_more === false && reply.total === 0))) fail('ORDER_AUDIT_PAGE_INVALID');
      if ((reply.items?.length ?? 0) > this.pageSize) fail('ORDER_AUDIT_PAGE_INVALID');
      result.push(...(reply.items ?? []));
      if (!reply.has_more) return result;
      cursor = reply.page_token;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) fail('ORDER_AUDIT_CURSOR_INVALID');
      cursors.add(cursor);
    }
    fail('ORDER_AUDIT_PAGE_LIMIT');
  }

  async #schema(resource, master) {
    const fields = await this.#pages(`${pathFor(resource)}/fields`);
    const auditFields = master ? fields.map(field => {
      const options = field?.property?.options;
      if (field?.field_id !== resource.fieldIds.订单转态 || !Array.isArray(options) ||
          options.filter(option => option?.name === '').length !== 1) return field;
      // The master audit treats its single empty placeholder as an unset value.
      return { ...field, property: { ...field.property, options: options.filter(option => option?.name !== '') } };
    }) : fields;
    return resolveSchema(resource, this.config.fields, auditFields, { master });
  }

  async #verifyTarget(target) {
    if (!this.verifyEffectiveTarget) fail('ORDER_EFFECTIVE_ACCESS_UNPROVEN');
    const { appToken, tableId, owner, documentOwner, administrators, fieldIds } = target;
    const [sharing, members, tables] = await Promise.all([
      this.admin.getSharing(appToken), this.admin.listMembers(appToken),
      this.#pages(`/open-apis/bitable/v1/apps/${appToken}/tables`),
    ]);
    const people = [owner, ...administrators];
    if (sharing?.externalAccessEntity !== 'closed' || sharing.linkShareEntity !== 'closed' ||
        sharing.manageCollaboratorEntity !== 'collaborator_full_access' ||
        tables.length !== 1 || tables[0]?.table_id !== tableId || !Array.isArray(members) ||
        members.some(member => !object(member)) || members.filter(member => member.isApp === true).length !== 1 ||
        members.find(member => member.isApp === true).perm !== 'full_access' ||
        !sameIds(members.filter(member => !member.isApp).map(member => member.openId), people) ||
        !members.some(member => !member.isApp && member.memberType === 'openid' && member.openId === owner && ['view', 'edit'].includes(member.perm)) ||
        members.some(member => !member.isApp && member.memberType !== 'openid')) fail('ORDER_TARGET_DIRECT_ACCESS_UNSAFE');
    const readOnlyFieldIds = Object.entries(this.config.fields).filter(([, field]) => !field.writable).map(([name]) => fieldIds[name]);
    const proof = await this.verifyEffectiveTarget(structuredClone(target));
    if (proof?.appToken !== appToken || proof.tableId !== tableId || proof.salesId !== owner || proof.documentOwner !== documentOwner ||
        proof.unverifiedInheritedGrants !== 0 || proof.unexpectedRoleMembers !== 0 || proof.salesCanEditStatus !== true ||
        proof.salesCanManageAccess !== false || proof.salesCanManageSchema !== false || proof.salesCanRecoverRevokedRecords !== false ||
        !sameIds(proof.readOnlyFieldIds, readOnlyFieldIds)) fail('ORDER_EFFECTIVE_ACCESS_UNPROVEN');
  }

  async #snapshot(resource, { master = false, masterSchema } = {}) {
    const schema = await this.#schema(resource, master);
    const names = Object.keys(this.config.fields);
    const numericNames = names.filter(name => schema[name].type === 2);
    if (masterSchema && names.some(name => !sameIds(schema[name].options, masterSchema[name].options))) {
      fail('ORDER_TARGET_OPTIONS_DRIFT');
    }
    const allowed = new Set(Object.keys(resource.fieldIds));
    const records = await this.#pages(`${pathFor(resource)}/records/search`, {
      method: 'POST', body: { field_names: [...allowed], automatic_fields: true }, query: { user_id_type: 'open_id' },
    });
    const seen = new Set();
    const rows = records.map(row => {
      if (!recordId(row?.record_id) || !object(row.fields) || seen.has(row.record_id) ||
        !Number.isSafeInteger(row.last_modified_time) || row.last_modified_time <= 0 ||
        Object.keys(row.fields).some(name => !allowed.has(name))) fail('ORDER_PROJECTED_RECORD_UNVERIFIED');
      seen.add(row.record_id);
      const cells = { ...row.fields };
      for (const name of numericNames) {
        if (Object.hasOwn(cells, name)) cells[name] = numericCell(cells[name]);
      }
      const values = project({ id: row.record_id, values: cells }, schema, names);
      if (master) {
        const owner = ownerOf({ id: row.record_id, values: row.fields });
        values.成交销售 = owner ? [{ id: owner }] : [];
      }
      const createdBy = personId(row.created_by?.id) ? row.created_by.id : null;
      const version = createHash('sha256').update(stringify([row.last_modified_time, values, createdBy])).digest('hex');
      return { id: row.record_id, version, values, createdBy };
    });
    return { schema, rows };
  }

  async masterSnapshot() {
    const { rows } = await this.#snapshot(this.config.master, { master: true });
    return rows;
  }

  async salesSnapshot(owner) {
    const target = this.config.sales.find(person => person.owner === owner);
    if (!target) fail('ORDER_TARGET_UNREGISTERED');
    await this.#verifyTarget(target);
    const { rows } = await this.#snapshot(target);
    return rows;
  }

  async readiness(targetLimit) {
    if (this.config.sales.length > targetLimit) fail('ORDER_AUDIT_TARGET_LIMIT');
    const { schema: masterSchema, rows: master } = await this.#snapshot(this.config.master, { master: true });
    const sourceByOwner = new Map();
    let assigned = 0, unassigned = 0, childrenRecorded = 0;
    for (const row of master) {
      const owner = ownerOf(row);
      if (owner) {
        assigned++;
        sourceByOwner.set(owner, (sourceByOwner.get(owner) ?? 0) + 1);
      } else unassigned++;
      if (row.values.儿童数 !== null) childrenRecorded++;
    }
    const targetIssues = {}, targets = { configured: this.config.sales.length, verified: 0, blocked: 0, rows: 0 };
    let assignedWithBoundTarget = 0, eligibleForReviewedTarget = 0;
    for (const target of this.config.sales) {
      const rowsAssigned = sourceByOwner.get(target.owner) ?? 0;
      assignedWithBoundTarget += rowsAssigned;
      try {
        await this.#verifyTarget(target);
        const { rows } = await this.#snapshot(target, { masterSchema });
        eligibleForReviewedTarget += rowsAssigned;
        targets.rows += rows.length;
        targets.verified++;
      } catch (error) {
        const code = reason(error);
        targetIssues[code] = (targetIssues[code] ?? 0) + 1;
        targets.blocked++;
      }
    }
    return { ok: targets.blocked === 0, mode: 'read-only',
      source: { rows: master.length, assigned, unassigned, childrenRecorded,
        assignedWithoutBoundTarget: assigned - assignedWithBoundTarget, eligibleForReviewedTarget },
      targets, targetIssues };
  }
}

/** Aggregate, bounded read-only check. It neither creates tables nor returns customer/order identifiers. */
export async function orderReadinessReport({ pageLimit = 8, targetLimit = 8, ...options } = {}) {
  try {
    if (!Number.isSafeInteger(targetLimit) || targetLimit < 0 || targetLimit > 128) fail('ORDER_AUDIT_LIMIT_INVALID');
    return await new FeishuOrderAudit({ ...options, pageLimit }).readiness(targetLimit);
  } catch (error) {
    return { ok: false, mode: 'read-only', code: reason(error) };
  }
}
