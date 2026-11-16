import { WorkflowClient } from './client.mjs';
import { resolveFields } from './field-map.mjs';

export const STAFF_TARGET_NAMES = Object.freeze({ wx: '微信号', needs: '客户需求（天数/景点/预算等）', wxStatus: '微信状态', addMethod: '添加方式', partySize: '出游人数' });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const baseId = value => typeof value === 'string' && /^[A-Za-z0-9]{10,100}$/.test(value);
const personId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{5,}$/.test(value);
const definiteRejection = error => /^(99991400|99991403|999916[0-9]{2}|106300[1-4]|125400[0-9]|125401[0-5]|125430[1246]|230013)$/.test(String(error?.code));
function beforeRequest(error) { if (error && typeof error === 'object') error.staffMutationAttempted = false; return error; }

/** Narrow employee-resource API adapter. Never starts an SDK or grants a space/department. */
export class StaffAdminClient extends WorkflowClient {
  constructor(config = {}, { sourceClient, ...options } = {}) {
    super(config, options);
    this.sourceClient = sourceClient?.retryMutations === false ? sourceClient : null;
    if (this.sourceClient?.config?.appId && this.sourceClient.config.appId !== config.appId) fail('STAFF_SHARED_APP_MISMATCH');
    this.appOpenId = null;
  }
  async api(endpoint, options = {}) {
    if (this.sourceClient) {
      if (this.sourceClient.retryMutations !== false) fail('STAFF_SHARED_TRANSPORT_CHANGED');
      return this.sourceClient.api(endpoint, options);
    }
    return super.api(endpoint, options);
  }
  employeeBase(appToken) {
    if (!baseId(appToken) || appToken === this.config.appToken || appToken === this.config.staffManagement?.appToken
      || (this.config.members ?? []).some(member => member.target?.appToken === appToken)) fail('STAFF_PROTECTED_BASE');
  }
  baseUrl(appToken, supplied) {
    let origin; try { origin = new URL(this.config.baseUrl).origin; } catch { fail('STAFF_BASE_URL_INVALID'); }
    const expected = `${origin}/base/${appToken}`;
    if (supplied) {
      let actual; try { actual = new URL(supplied); } catch { fail('STAFF_BASE_URL_INVALID'); }
      if (actual.href.replace(/\/$/, '') !== expected) fail('STAFF_BASE_URL_INVALID');
    }
    return expected;
  }
  async mutation(operation, beforeMutation) {
    try {
      if (this.sourceClient && this.sourceClient.retryMutations !== false) fail('STAFF_SHARED_TRANSPORT_CHANGED');
      const tokenClient = this.sourceClient ?? this;
      if (typeof tokenClient.tenantToken === 'function') await tokenClient.tenantToken();
      if (beforeMutation) await beforeMutation();
    } catch (error) { throw beforeRequest(error); }
    try { return await operation(); }
    catch (error) {
      if (error && typeof error === 'object') { error.staffMutationAttempted = true; error.staffDefinitelyRejected = definiteRejection(error); }
      throw error;
    }
  }
  async createBase({ name, beforeMutation } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255) fail('STAFF_BASE_NAME_INVALID');
    return this.mutation(async () => {
      const result = await this.api('/open-apis/bitable/v1/apps', { method: 'POST', body: { name, time_zone: 'Asia/Shanghai' } });
      const app = result.app ?? result;
      this.employeeBase(app.app_token);
      return { appToken: app.app_token, defaultTableId: app.default_table_id ?? null, url: this.baseUrl(app.app_token, app.url) };
    }, beforeMutation);
  }
  async businessHeaders() {
    const keys = ['wx', 'needs', 'wxStatus', 'addMethod', ...(this.config.fields?.leads?.partySize ? ['partySize'] : [])];
    const definitions = Object.fromEntries(keys.map(key => [key, this.config.fields?.leads?.[key]]));
    const source = await resolveFields(this, { appToken: this.config.appToken, tableId: this.config.tableIds?.leads, fields: definitions });
    if (source.wx.type !== 1 || source.needs.type !== 1 || source.wxStatus.type !== 3 || source.addMethod.type !== 3
      || source.partySize && ![1, 2].includes(source.partySize.type)) fail('STAFF_SOURCE_FIELD_TYPE_INVALID');
    return Object.entries(STAFF_TARGET_NAMES).map(([key, field_name]) => {
      const field = { field_name, type: source[key]?.type ?? 1 };
      if (field.type === 3) {
        const options = source[key].property?.options;
        if (!Array.isArray(options) || !options.length || options.some(option => typeof option?.name !== 'string' || !option.name.trim())
          || new Set(options.map(option => option.name)).size !== options.length) fail('STAFF_SOURCE_OPTIONS_INVALID');
        field.property = { options: options.map(option => ({ name: option.name, ...(Number.isInteger(option.color) ? { color: option.color } : {}) })) };
      }
      return field;
    });
  }
  async createBusinessTable(appToken, { beforeMutation } = {}) {
    this.employeeBase(appToken);
    let headers;
    try { headers = await this.businessHeaders(); }
    catch (error) { throw beforeRequest(error); }
    return this.mutation(async () => {
      const result = await this.api(`/open-apis/bitable/v1/apps/${appToken}/tables`, { method: 'POST',
        body: { table: { name: '销售客资', default_view_name: '我的客资', fields: headers } } });
      const ids = result.field_id_list;
      if (!/^tbl[A-Za-z0-9]{5,}$/.test(result.table_id ?? '') || !Array.isArray(ids) || ids.length !== headers.length
        || new Set(ids).size !== ids.length || ids.some(id => !/^fld[A-Za-z0-9]{5,}$/.test(id))) fail('STAFF_TABLE_RESPONSE_INVALID');
      return { appToken, baseUrl: this.baseUrl(appToken), tableId: result.table_id,
        expectedOptions: Object.fromEntries(headers.filter(field => field.type === 3).map(field => [Object.keys(STAFF_TARGET_NAMES).find(key => STAFF_TARGET_NAMES[key] === field.field_name), field.property.options.map(option => option.name)])),
        fields: Object.fromEntries(Object.keys(STAFF_TARGET_NAMES).map((key, index) => [key, { fieldId: ids[index], types: [headers[index].type] }])) };
    }, beforeMutation);
  }
  async setPrivateSharing(appToken, { beforeMutation } = {}) {
    this.employeeBase(appToken);
    return this.mutation(() => this.api(`/open-apis/drive/v2/permissions/${appToken}/public`, { method: 'PATCH', query: { type: 'bitable' },
      body: { external_access_entity: 'closed', link_share_entity: 'closed', share_entity: 'same_tenant', manage_collaborator_entity: 'collaborator_full_access' } }), beforeMutation);
  }
  async getSharing(appToken) {
    if (!baseId(appToken)) fail('STAFF_BASE_INVALID');
    const result = await this.api(`/open-apis/drive/v2/permissions/${appToken}/public`, { query: { type: 'bitable' } });
    const settings = result.permission_public ?? result;
    return { externalAccessEntity: settings.external_access_entity, linkShareEntity: settings.link_share_entity,
      manageCollaboratorEntity: settings.manage_collaborator_entity };
  }
  async addMember(appToken, { openId, perm, beforeMutation } = {}) {
    this.employeeBase(appToken);
    if (!personId(openId) || !['edit', 'view'].includes(perm)) fail('STAFF_MEMBER_GRANT_INVALID');
    return this.mutation(() => this.api(`/open-apis/drive/v1/permissions/${appToken}/members`, { method: 'POST', query: { type: 'bitable' },
      body: { member_type: 'openid', member_id: openId, perm, type: 'user' } }), beforeMutation);
  }
  async ownOpenId() {
    if (!this.appOpenId) {
      const result = await this.api('/open-apis/bot/v3/info');
      const id = result.bot?.open_id;
      if (!personId(id)) fail('STAFF_APP_IDENTITY_UNKNOWN');
      this.appOpenId = id;
    }
    return this.appOpenId;
  }
  async listMembers(appToken) {
    if (!baseId(appToken)) fail('STAFF_BASE_INVALID');
    const ownId = await this.ownOpenId(), result = [], seen = new Set(); let token;
    for (let page = 0; page < 100; page++) {
      const data = await this.api(`/open-apis/drive/v1/permissions/${appToken}/members`, { query: { type: 'bitable', ...(token ? { page_token: token } : {}) } });
      const items = data.items ?? data.members;
      if (!Array.isArray(items)) fail('STAFF_MEMBERS_RESPONSE_INVALID');
      for (const member of items) {
        const memberType = member.member_type, id = member.member_id;
        if (typeof id !== 'string' || !id || typeof memberType !== 'string' || typeof member.perm !== 'string') fail('STAFF_MEMBERS_RESPONSE_INVALID');
        result.push({ openId: id, memberType, perm: member.perm === 'owner' ? 'full_access' : member.perm,
          isOwner: member.is_owner === true || member.perm === 'owner',
          isApp: memberType === 'appid' && id === this.config.appId || memberType === 'openid' && id === ownId });
      }
      if (data.has_more !== undefined && typeof data.has_more !== 'boolean') fail('STAFF_MEMBERS_RESPONSE_INVALID');
      if (data.has_more !== true) return result;
      if (typeof data.page_token !== 'string' || !data.page_token || seen.has(data.page_token)) fail('STAFF_MEMBERS_PAGINATION_INVALID');
      token = data.page_token; seen.add(token);
    }
    fail('STAFF_MEMBERS_PAGINATION_INVALID');
  }
  async subscribeBase(appToken, { beforeMutation } = {}) {
    this.employeeBase(appToken);
    return this.mutation(() => this.api(`/open-apis/drive/v1/files/${appToken}/subscribe`, { method: 'POST', query: { file_type: 'bitable' } }), beforeMutation);
  }
  async getTargetSchema(target) { return resolveFields(this, target); }
  async sendOnboarding(employee, { url, clientToken, beforeMutation } = {}) {
    let parsed; try { parsed = new URL(url); } catch { fail('STAFF_ENTRY_URL_INVALID'); }
    if (!personId(employee?.openId) || !['sales', 'operator'].includes(employee.role) || parsed.protocol !== 'https:'
      || !parsed.hostname.endsWith('.feishu.cn') || parsed.username || parsed.password || parsed.hash
      || employee.role === 'sales' && (parsed.search || !/^\/base\/[A-Za-z0-9]{10,100}\/?$/.test(parsed.pathname) || parsed.pathname.includes(this.config.appToken))
      || employee.role === 'operator' && !/^\/share\/(?:base\/)?form\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientToken ?? '')) fail('STAFF_ENTRY_URL_INVALID');
    const notification = { recipientOpenId: employee.openId, title: '飞书派单工作入口',
      text: employee.role === 'sales' ? '请通过以下个人表查看和更新分配给你的客资。' : '请通过以下表单录入客资。', url, idempotencyKey: clientToken };
    return this.mutation(() => this.sourceClient ? this.sourceClient.sendNotification(notification) : super.sendNotification(notification), beforeMutation);
  }
}
