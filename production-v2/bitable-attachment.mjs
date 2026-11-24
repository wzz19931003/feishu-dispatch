const FEISHU = 'https://open.feishu.cn';
const MEDIA = '/open-apis/drive/v1/medias';
const UPLOAD_LIMIT = 20 * 1024 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9]{10,128}$/;
const TABLE_ID = /^tbl[A-Za-z0-9]{5,100}$/;
const RECORD_ID = /^rec[A-Za-z0-9]{5,100}$/;
const FIELD_ID = /^fld[A-Za-z0-9]{5,100}$/;
const REJECTED_HTTP = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);
const REJECTED_API = new Set([1061002, 1061003, 1061004, 1061005, 1061007, 1061008,
  1061021, 1061041, 1061042, 1061043, 1061044, 1061101, 1061109, 1061113]);

export class BitableAttachmentError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BitableAttachmentError';
    this.code = code;
  }
}

const fail = code => { throw new BitableAttachmentError(code); };
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

function pinTransfer(source, target) {
  if (!matches(source?.appToken, SAFE_ID) || !matches(target?.appToken, SAFE_ID) ||
    source.appToken === target.appToken || !matches(source.tableId, TABLE_ID) ||
    !matches(target.tableId, TABLE_ID) || !matches(source.recordId, RECORD_ID) ||
    !matches(target.recordId, RECORD_ID) || !matches(source.fieldId, FIELD_ID) ||
    !matches(source.fileToken, SAFE_ID)) fail('ATTACHMENT_TRANSFER_INVALID');
  return Object.freeze({
    source: Object.freeze({ appToken: source.appToken, tableId: source.tableId, recordId: source.recordId,
      fieldId: source.fieldId, fileToken: source.fileToken, name: typeof source.name === 'string' ? source.name : '' }),
    target: Object.freeze({ appToken: target.appToken, tableId: target.tableId, recordId: target.recordId })
  });
}

async function readBounded(response, limit, code) {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    fail(code);
  }
  const reader = response.body?.getReader();
  if (!reader) fail(code);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        fail(code);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['png', 'image/png'];
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['jpg', 'image/jpeg'];
  const start = bytes.toString('ascii', 0, 6);
  if (start === 'GIF87a' || start === 'GIF89a') return ['gif', 'image/gif'];
  if (start.startsWith('RIFF') && bytes.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  if (bytes.length >= 14 && start.startsWith('BM')) return ['bmp', 'image/bmp'];
  fail('ATTACHMENT_NOT_IMAGE');
}

function fileName(name, extension) {
  const nameOnly = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').trim();
  const stem = nameOnly.replace(/\.[^.]*$/, '').slice(0, 100).trim();
  return `${stem || '沟通截图'}.${extension}`;
}

async function requireOwnership(assertOwnership, pins, phase) {
  let approved;
  try { approved = await assertOwnership(pins, phase); }
  catch { fail('ATTACHMENT_OWNERSHIP_UNCONFIRMED'); }
  if (approved !== true) fail('ATTACHMENT_OWNERSHIP_UNCONFIRMED');
}

/** Copies one image into the destination Base. The caller owns the transfer journal and must recheck ownership before writing the target cell. */
export class BitableAttachmentClient {
  #busy = false;

  constructor({ tenantToken, fetchImpl = fetch, timeoutMs = 15_000, maxBytes = UPLOAD_LIMIT } = {}) {
    if (typeof tenantToken !== 'function' || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > UPLOAD_LIMIT) fail('ATTACHMENT_TRANSPORT_INVALID');
    this.tenantToken = tenantToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  async copy({ source, target, assertOwnership } = {}) {
    if (typeof assertOwnership !== 'function') fail('ATTACHMENT_OWNERSHIP_REQUIRED');
    const pins = pinTransfer(source, target);
    if (this.#busy) fail('ATTACHMENT_COPY_BUSY');
    this.#busy = true;
    try {
      let token;
      try { token = await this.tenantToken(); }
      catch { fail('ATTACHMENT_AUTH_UNAVAILABLE'); }
      if (typeof token !== 'string' || token.length < 10 || token.length > 2048 || /[^A-Za-z0-9._-]/.test(token))
        fail('ATTACHMENT_AUTH_UNAVAILABLE');
      const headers = { Authorization: `Bearer ${token}` };
      await requireOwnership(assertOwnership, pins, 'download');
      const bytes = await this.#download(pins.source, headers);
      const [extension, type] = imageFormat(bytes);
      const name = fileName(pins.source.name, extension);
      const form = new FormData();
      form.set('file_name', name);
      form.set('parent_type', 'bitable_file');
      form.set('parent_node', pins.target.appToken);
      form.set('extra', JSON.stringify({ drive_route_token: pins.target.appToken }));
      form.set('size', String(bytes.length));
      form.set('file', new Blob([bytes], { type }), name);
      await requireOwnership(assertOwnership, pins, 'upload');
      return await this.#upload(form, headers, pins.source.fileToken);
    } finally {
      this.#busy = false;
    }
  }

  async #download(source, headers) {
    const url = new URL(`${MEDIA}/${source.fileToken}/download`, FEISHU);
    url.searchParams.set('extra', JSON.stringify({ bitablePerm: { tableId: source.tableId,
      attachments: { [source.fieldId]: { [source.recordId]: [source.fileToken] } } } }));
    try {
      const response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        fail('ATTACHMENT_DOWNLOAD_REJECTED');
      }
      return await readBounded(response, this.maxBytes, 'ATTACHMENT_SIZE_LIMIT');
    } catch (error) {
      if (error instanceof BitableAttachmentError) throw error;
      fail('ATTACHMENT_DOWNLOAD_FAILED');
    }
  }

  async #upload(body, headers, originalFileToken) {
    try {
      const response = await this.fetchImpl(new URL(`${MEDIA}/upload_all`, FEISHU), {
        method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.redirected || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        fail(!response.redirected && REJECTED_HTTP.has(response.status) ? 'ATTACHMENT_UPLOAD_REJECTED' : 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN');
      }
      const bytes = await readBounded(response, RESPONSE_LIMIT, 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN');
      const payload = JSON.parse(bytes.toString('utf8'));
      if (REJECTED_API.has(payload?.code)) fail('ATTACHMENT_UPLOAD_REJECTED');
      const fileToken = payload?.data?.file_token;
      if (payload?.code !== 0 || typeof fileToken !== 'string' || !SAFE_ID.test(fileToken) || fileToken === originalFileToken)
        fail('ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN');
      return { file_token: fileToken };
    } catch (error) {
      if (error instanceof BitableAttachmentError) throw error;
      fail('ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN');
    }
  }
}
