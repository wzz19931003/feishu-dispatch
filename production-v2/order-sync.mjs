import { createHash, randomUUID } from 'node:crypto';
import { creationField, fail, normalizeConfig, object, OrderSyncError, ownerOf, project, recordId, resolveSchema } from './order-schema.mjs';

const json = JSON.stringify;
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const operations = ['schema', 'targetAcl', 'list', 'read', 'createCopy', 'createMaster', 'updateCopy', 'updateMaster', 'removeCopy'];
const validRevision = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value);

export class SalesOrderSync {
  constructor({ config, db, adapter, approveNewOrder } = {}) {
    if (!db?.exec || !db?.prepare || operations.some(key => typeof adapter?.[key] !== 'function')) fail('ORDER_ADAPTER_REQUIRED');
    this.config = normalizeConfig(config);
    if (this.config.allowNewOrders && typeof approveNewOrder !== 'function') fail('ORDER_NEW_ORDER_POLICY_REQUIRED');
    this.db = db;
    this.adapter = adapter;
    this.approveNewOrder = approveNewOrder;
    this.names = Object.keys(this.config.fields);
    this.sales = new Map(this.config.sales.map(target => [target.owner, target]));
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_sync_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS order_sync_locks (key TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS order_sync_pairs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, master_id TEXT, child_id TEXT, direction TEXT NOT NULL,
        create_token TEXT NOT NULL, state TEXT NOT NULL, baseline TEXT NOT NULL,
        CHECK (direction IN ('inbound','outbound')), CHECK (state IN ('intent','active','revoked')),
        CHECK (master_id IS NOT NULL OR child_id IS NOT NULL),
        CHECK (state != 'active' OR (master_id IS NOT NULL AND child_id IS NOT NULL)),
        UNIQUE(owner, child_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS order_sync_current_pair
        ON order_sync_pairs(master_id) WHERE state != 'revoked' AND master_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS order_sync_reviews (
        id TEXT PRIMARY KEY, phase TEXT NOT NULL, code TEXT NOT NULL, master_id TEXT, child_id TEXT, updated_at TEXT NOT NULL
      );
    `);
  }

  bind(key, value) {
    const encoded = json(value);
    this.db.prepare('INSERT INTO order_sync_metadata VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, encoded);
    if (this.db.prepare('SELECT value FROM order_sync_metadata WHERE key = ?').get(key)?.value !== encoded) fail('ORDER_DATABASE_BINDING_CHANGED');
  }

  async verifyTarget(target) {
    const acl = await this.adapter.targetAcl(target);
    const readOnly = this.names.filter(name => !this.config.fields[name].writable).map(name => target.fieldIds[name]).sort();
    if (acl?.salesId !== target.owner || acl.documentOwner !== target.documentOwner || acl.salesCanEdit !== true || acl.serviceCanManage !== true ||
        acl.externalOff !== true || acl.linkSharingOff !== true || acl.managerOnlySharing !== true ||
        acl.salesCanManageAccess !== false || acl.salesCanManageSchema !== false || acl.salesCanRecoverRevokedRecords !== false ||
        acl.extraGrants !== 0 || acl.unverifiedInheritedGrants !== 0 || acl.onlyConfiguredTable !== true ||
        !Array.isArray(acl.readOnlyFieldIds) || json([...acl.readOnlyFieldIds].sort()) !== json(readOnly) ||
        !Array.isArray(acl.administrators) || json([...acl.administrators].sort()) !== json(target.administrators)) fail('ORDER_TARGET_ACCESS_UNVERIFIED');
  }

  async preflight() {
    const { master, fields } = this.config;
    const masterSchema = resolveSchema(master, fields, await this.adapter.schema(master), { master: true });
    const salesSchemas = new Map();
    for (const target of this.sales.values()) {
      await this.verifyTarget(target);
      const schema = resolveSchema(target, fields, await this.adapter.schema(target));
      if (this.names.some(name => json(schema[name].options) !== json(masterSchema[name].options))) fail('ORDER_TARGET_OPTIONS_DRIFT');
      salesSchemas.set(target.owner, schema);
    }
    return { masterSchema, salesSchemas };
  }

  bindResources() {
    this.bind('master', { ...this.config.master, fields: this.config.fields });
    for (const target of this.sales.values()) {
      const { owner, administrators, documentOwner, ...identity } = target;
      this.bind(`owner:${owner}`, identity);
      this.bind(`app:${target.appToken}`, owner);
    }
    for (const row of this.db.prepare('SELECT DISTINCT owner FROM order_sync_pairs').all()) {
      if (!this.sales.has(row.owner)) fail('ORDER_PREVIOUS_TARGET_UNREGISTERED');
    }
  }

  review(phase, error, { masterId = null, childId = null } = {}) {
    const code = error instanceof OrderSyncError ? error.code : 'ORDER_REMOTE_REVIEW';
    this.db.prepare(`INSERT INTO order_sync_reviews VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(digest([phase, code, masterId, childId]), phase, code, masterId, childId, new Date().toISOString());
  }

  status() {
    return {
      pairs: this.db.prepare('SELECT state, count(*) AS count FROM order_sync_pairs GROUP BY state').all(),
      reviews: this.db.prepare('SELECT phase, code, count(*) AS count FROM order_sync_reviews GROUP BY phase, code').all(),
      lockedSince: this.db.prepare("SELECT acquired_at FROM order_sync_locks WHERE key = 'runner'").get()?.acquired_at ?? null,
    };
  }

  startIntent({ owner, masterId = null, childId = null, direction, baseline }) {
    const id = randomUUID();
    const token = randomUUID();
    this.db.prepare("INSERT INTO order_sync_pairs VALUES (?, ?, ?, ?, ?, ?, 'intent', ?)")
      .run(id, owner, masterId, childId, direction, token, json(baseline));
    return { id, token };
  }

  activate(intent, { masterId, childId }) {
    if (!recordId(masterId) || !recordId(childId)) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    if (this.db.prepare("UPDATE order_sync_pairs SET master_id = ?, child_id = ?, state = 'active' WHERE id = ? AND state = 'intent'")
      .run(masterId, childId, intent.id).changes !== 1) fail('ORDER_PAIR_ACTIVATION_FAILED');
  }

  async read(resource, id) {
    const record = await this.adapter.read(resource, id);
    if (record === null) return null;
    if (!object(record) || record.id !== id || !object(record.values) || !validRevision(record.version)) fail('ORDER_RECORD_RESPONSE_INVALID');
    return record;
  }

  async list(resource) {
    const records = await this.adapter.list(resource);
    if (!Array.isArray(records) || records.some(id => !recordId(id)) || new Set(records).size !== records.length) fail('ORDER_LIST_RESPONSE_INVALID');
    return records;
  }

  masterGuard(record, owner) {
    return { resource: this.config.master, id: record.id, version: record.version, owner };
  }

  requireRunning() {
    if (this.shouldStop?.()) fail('ORDER_STOP_REQUESTED');
  }

  async revoke(pair, stats, { compensate = false } = {}) {
    if (!pair.child_id) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    const target = this.sales.get(pair.owner);
    const existing = await this.read(target, pair.child_id);
    if (existing) {
      await this.verifyTarget(target);
      if (!compensate) this.requireRunning();
      try {
        await this.adapter.removeCopy(target, pair.child_id, { version: existing.version });
      } catch {
        if (await this.read(target, pair.child_id)) fail('ORDER_OLD_COPY_NOT_REVOKED');
      }
      if (await this.read(target, pair.child_id)) fail('ORDER_OLD_COPY_NOT_REVOKED');
      stats.revoked++;
    }
    this.db.prepare("UPDATE order_sync_pairs SET state = 'revoked' WHERE id = ?").run(pair.id);
  }

  async projectMaster(source, owner, target, schemas, stats) {
    const values = project(source, schemas.masterSchema, this.names);
    await this.verifyTarget(target);
    this.requireRunning();
    const intent = this.startIntent({ owner, masterId: source.id, direction: 'outbound', baseline: values });
    // An interrupted or rejected POST remains parked in the journal for reconciliation.
    const childId = await this.adapter.createCopy(target, values, { token: intent.token, master: this.masterGuard(source, owner) });
    if (!recordId(childId)) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    this.db.prepare("UPDATE order_sync_pairs SET child_id = ? WHERE id = ? AND state = 'intent'").run(childId, intent.id);
    const child = await this.read(target, childId);
    if (!child) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    const current = await this.read(this.config.master, source.id);
    if (!current || ownerOf(current) !== owner) {
      await this.revoke({ id: intent.id, owner, child_id: childId }, stats, { compensate: true });
      fail('ORDER_OWNERSHIP_CHANGED');
    }
    if (json(values) !== json(project(child, schemas.salesSchemas.get(owner), this.names))) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    this.activate(intent, { masterId: source.id, childId });
    stats.published++;
  }

  async reconcile(pair, source, target, schemas, stats) {
    const child = await this.read(target, pair.child_id);
    if (!child) fail('ORDER_PERSONAL_RECORD_MISSING');
    const masterSchema = schemas.masterSchema;
    const targetSchema = schemas.salesSchemas.get(target.owner);
    const baseline = JSON.parse(pair.baseline);
    const masterValues = project(source, masterSchema, this.names);
    const childValues = project(child, targetSchema, this.names);
    const inbound = {}, outbound = {};
    for (const name of this.names) {
      const old = baseline[name], masterNow = masterValues[name], childNow = childValues[name];
      if (masterNow === childNow) continue;
      if (this.config.fields[name].writable && childNow !== old) {
        if (masterNow !== old) fail('ORDER_EDIT_CONFLICT');
        inbound[name] = childNow;
      } else {
        outbound[name] = masterNow;
      }
    }
    let current = source;
    if (Object.keys(inbound).length) {
      await this.verifyTarget(target);
      this.requireRunning();
      await this.adapter.updateMaster(this.config.master, source.id, inbound, {
        master: this.masterGuard(source, pair.owner), child: { resource: target, id: child.id, version: child.version },
      });
      current = await this.read(this.config.master, source.id);
      if (!current || ownerOf(current) !== pair.owner) fail('ORDER_OWNERSHIP_CHANGED');
      const observed = project(current, masterSchema, this.names);
      if (Object.entries(inbound).some(([name, value]) => observed[name] !== value)) fail('ORDER_MASTER_UPDATE_UNCONFIRMED');
      stats.masterUpdated++;
    }
    if (Object.keys(outbound).length) {
      const observed = project(current, masterSchema, this.names);
      if (Object.entries(outbound).some(([name, value]) => observed[name] !== value)) fail('ORDER_EDIT_CONFLICT');
      await this.verifyTarget(target);
      this.requireRunning();
      await this.adapter.updateCopy(target, child.id, outbound, {
        master: this.masterGuard(current, pair.owner), child: { resource: target, id: child.id, version: child.version },
      });
      stats.personalUpdated++;
    }
    const finalChild = await this.read(target, child.id);
    const finalMaster = await this.read(this.config.master, source.id);
    if (!finalMaster || ownerOf(finalMaster) !== pair.owner) fail('ORDER_OWNERSHIP_CHANGED');
    if (!finalChild) fail('ORDER_PERSONAL_RECORD_MISSING');
    const finalValues = project(finalMaster, masterSchema, this.names);
    if (json(finalValues) !== json(project(finalChild, targetSchema, this.names))) fail('ORDER_UPDATE_UNCONFIRMED');
    this.db.prepare('UPDATE order_sync_pairs SET baseline = ? WHERE id = ?').run(json(finalValues), pair.id);
  }

  async handleMaster(id, schemas, stats) {
    const source = await this.read(this.config.master, id);
    const owner = source && ownerOf(source);
    const pairs = this.db.prepare('SELECT * FROM order_sync_pairs WHERE master_id = ?').all(id);
    const current = pairs.find(pair => pair.state !== 'revoked');
    for (const prior of pairs.filter(pair => pair.state === 'revoked')) {
      // A deleted row restored from the recycle bin can disclose the previous owner's copy.
      await this.revoke(prior, stats);
    }
    if (current?.state === 'intent' && current.owner === owner) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    if (current && current.owner !== owner) await this.revoke(current, stats);
    const target = this.sales.get(owner);
    if (!target) return;
    if (current?.owner === owner) return this.reconcile(current, source, target, schemas, stats);
    if (this.db.prepare("SELECT 1 FROM order_sync_pairs WHERE owner = ? AND direction = 'inbound' AND state = 'intent'").get(owner)) {
      fail('ORDER_OWNER_INBOUND_CREATE_UNCONFIRMED');
    }
    return this.projectMaster(source, owner, target, schemas, stats);
  }

  async handleNewOrder(id, target, schemas, stats) {
    const pair = this.db.prepare('SELECT state FROM order_sync_pairs WHERE owner = ? AND child_id = ?').get(target.owner, id);
    if (pair?.state === 'intent') fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    if (pair) return;
    if (this.db.prepare("SELECT 1 FROM order_sync_pairs WHERE owner = ? AND direction = 'outbound' AND state = 'intent'").get(target.owner)) {
      fail('ORDER_OWNER_OUTBOUND_CREATE_UNCONFIRMED');
    }
    const child = await this.read(target, id);
    if (!child) return;
    if (child.createdBy !== target.owner) fail('ORDER_NEW_RECORD_CREATOR_UNVERIFIED');
    const values = project(child, schemas.salesSchemas.get(target.owner), this.names);
    if (values.订单编号 !== null) fail('ORDER_STAT_NUMBER_ON_NEW_ROW');
    if (!this.config.allowNewOrders) fail('ORDER_NEW_RECORD_REVIEW_REQUIRED');
    if (this.config.required.some(name => values[name] === null || typeof values[name] === 'string' && !values[name].trim())) fail('ORDER_NEW_RECORD_INCOMPLETE');
    const fields = Object.fromEntries(Object.entries(values).filter(([name, value]) => creationField(this.config.fields[name]) && value !== null));
    if (await this.approveNewOrder({ values: structuredClone(fields), owner: target.owner }) !== true) fail('ORDER_NEW_RECORD_POLICY_BLOCKED');
    await this.verifyTarget(target);
    this.requireRunning();
    const linked = this.startIntent({ owner: target.owner, childId: id, direction: 'inbound', baseline: values });
    const masterId = await this.adapter.createMaster(this.config.master, { ...fields, 成交销售: [{ id: target.owner }] }, {
      token: linked.token, child: { resource: target, id, version: child.version },
    });
    if (!recordId(masterId)) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    this.db.prepare("UPDATE order_sync_pairs SET master_id = ? WHERE id = ? AND state = 'intent'").run(masterId, linked.id);
    const master = await this.read(this.config.master, masterId);
    if (!master || ownerOf(master) !== target.owner) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    const masterValues = project(master, schemas.masterSchema, this.names);
    if (Object.entries(fields).some(([name, value]) => masterValues[name] !== value)) fail('ORDER_CREATE_OUTCOME_UNCONFIRMED');
    this.activate(linked, { masterId, childId: id });
    stats.createdInMaster++;
  }

  async sync({ shouldStop = () => false } = {}) {
    if (!this.config.enabled) fail('ORDER_SYNC_DISABLED');
    if (this.adapter.guardedWrites !== true) fail('ORDER_GUARDED_ADAPTER_REQUIRED');
    const holder = randomUUID();
    if (this.db.prepare("INSERT INTO order_sync_locks VALUES ('runner', ?, ?) ON CONFLICT(key) DO NOTHING")
      .run(holder, new Date().toISOString()).changes !== 1) fail('ORDER_SYNC_LOCKED');
    this.shouldStop = shouldStop;
    const stats = { published: 0, revoked: 0, masterUpdated: 0, personalUpdated: 0, createdInMaster: 0, reviews: 0 };
    try {
      this.requireRunning();
      this.bindResources();
      const schemas = await this.preflight();
      this.requireRunning();
      const masterIds = new Set(await this.list(this.config.master));
      for (const pair of this.db.prepare('SELECT DISTINCT master_id FROM order_sync_pairs WHERE master_id IS NOT NULL').all()) masterIds.add(pair.master_id);
      for (const masterId of masterIds) {
        this.requireRunning();
        try { await this.handleMaster(masterId, schemas, stats); }
        catch (error) {
          if (error?.code === 'ORDER_STOP_REQUESTED') throw error;
          this.review('master', error, { masterId });
          stats.reviews++;
        }
      }
      for (const target of this.sales.values()) {
        this.requireRunning();
        for (const childId of await this.list(target)) {
          this.requireRunning();
          try { await this.handleNewOrder(childId, target, schemas, stats); }
          catch (error) {
            if (error?.code === 'ORDER_STOP_REQUESTED') throw error;
            this.review('personal', error, { childId });
            stats.reviews++;
          }
        }
      }
      return stats;
    } catch (error) {
      if (error?.code === 'ORDER_STOP_REQUESTED') return { ...stats, stopped: true };
      throw error;
    } finally {
      this.shouldStop = null;
      this.db.prepare("DELETE FROM order_sync_locks WHERE key = 'runner' AND holder = ?").run(holder);
    }
  }
}
