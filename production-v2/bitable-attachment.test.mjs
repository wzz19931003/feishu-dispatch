import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { BitableAttachmentClient, BitableAttachmentError } from './bitable-attachment.mjs';

const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const credential = 't-synthetic-credential';
const newToken = 'boxOfflineTargetFixture12345';
const source = { appToken: 'OfflineSourceBase1234', tableId: 'tblSourceOffline1234',
  fieldId: 'fldSourceOffline1234', recordId: 'recSourceOffline1234', fileToken: 'boxOfflineSource1234', name: '沟通截图\r\n.png' };
const target = { appToken: 'OfflineTargetBase1234', tableId: 'tblTargetOffline1234', recordId: 'recTargetOffline1234' };
const approved = async () => true;
const canCopy = { source, target, assertOwnership: approved };
const code = expected => error => error instanceof BitableAttachmentError && error.code === expected && error.message === expected && !error.cause;
const returnedToken = value => Response.json({ code: 0, data: { file_token: value } });
function harness(fetchImpl, options = {}) {
  return new BitableAttachmentClient({ tenantToken: async () => credential, fetchImpl, ...options });
}

test('pins the exact source record and destination Base before serial download and upload', async () => {
  const sequence = [];
  const suppliedSource = { ...source };
  const suppliedTarget = { ...target };
  const client = harness(async (url, options) => {
    sequence.push(options.method);
    assert.equal(url.origin, 'https://open.feishu.cn');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${credential}`);
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === 'GET') {
      assert.equal(url.pathname, `/open-apis/drive/v1/medias/${source.fileToken}/download`);
      assert.deepEqual(JSON.parse(url.searchParams.get('extra')), { bitablePerm: { tableId: source.tableId,
        attachments: { [source.fieldId]: { [source.recordId]: [source.fileToken] } } } });
      suppliedTarget.appToken = 'UnapprovedTargetBase234';
      suppliedSource.fileToken = 'OtherFileTokenABC234';
      return new Response(image, { headers: { 'content-type': 'application/octet-stream' } });
    }
    assert.equal(url.pathname, '/open-apis/drive/v1/medias/upload_all');
    assert.equal(url.search, '');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('parent_type'), 'bitable_file');
    assert.equal(options.body.get('parent_node'), target.appToken);
    assert.deepEqual(JSON.parse(options.body.get('extra')), { drive_route_token: target.appToken });
    assert.equal(options.body.get('size'), String(image.length));
    assert.equal(options.body.get('file_name'), '沟通截图__.png');
    assert.equal(options.body.get('file').type, 'image/png');
    assert.deepEqual(new Uint8Array(await options.body.get('file').arrayBuffer()), image);
    return returnedToken(newToken);
  });
  const copied = await client.copy({ source: suppliedSource, target: suppliedTarget, assertOwnership: async (pins, phase) => {
    sequence.push(phase);
    assert.deepEqual(pins, { source, target });
    assert.ok(Object.isFrozen(pins));
    assert.ok(Object.isFrozen(pins.source));
    assert.ok(Object.isFrozen(pins.target));
    return true;
  } });
  assert.deepEqual(copied, { file_token: newToken });
  assert.deepEqual(sequence, ['download', 'GET', 'upload', 'POST']);
});

test('requires both valid pins and an explicit ownership result before requesting content', async () => {
  let requests = 0;
  let auth = 0;
  const client = harness(async () => { requests++; }, { tenantToken: async () => { auth++; return credential; } });
  await assert.rejects(client.copy({ source, target }), code('ATTACHMENT_OWNERSHIP_REQUIRED'));
  await assert.rejects(client.copy({ ...canCopy, target: { ...target, appToken: source.appToken } }), code('ATTACHMENT_TRANSFER_INVALID'));
  await assert.rejects(client.copy({ ...canCopy, source: { ...source, fileToken: 'https://other.example/' } }), code('ATTACHMENT_TRANSFER_INVALID'));
  assert.equal(auth, 0);
  await assert.rejects(client.copy({ ...canCopy, assertOwnership: async () => undefined }), code('ATTACHMENT_OWNERSHIP_UNCONFIRMED'));
  assert.equal(requests, 0);
});

test('accepts a long dotted bearer and rejects any line-break characters', async () => {
  const dotted = `t-${'a'.repeat(40)}.${'b'.repeat(1300)}.${'c'.repeat(67)}`;
  let sent = 0;
  const fetchImpl = async (_, options) => {
    sent++;
    assert.equal(options.headers.Authorization, `Bearer ${dotted}`);
    return options.method === 'GET' ? new Response(image) : returnedToken(newToken);
  };
  assert.deepEqual(await harness(fetchImpl, { tenantToken: async () => dotted }).copy(canCopy), { file_token: newToken });
  for (const suffix of ['\r\nX-Test: other', '\n', '\u2028', ' ']) {
    const client = harness(fetchImpl, { tenantToken: async () => dotted + suffix });
    await assert.rejects(client.copy(canCopy), code('ATTACHMENT_AUTH_UNAVAILABLE'));
  }
  assert.equal(sent, 2);
});

test('refuses upload when ownership changed during download and suppresses private error text', async () => {
  const calls = [];
  const client = harness(async (_, request) => { calls.push(request.method); return new Response(image); });
  await assert.rejects(client.copy({ ...canCopy, assertOwnership: async (_, phase) => {
    if (phase === 'upload') throw new Error('private customer text');
    return true;
  } }), code('ATTACHMENT_OWNERSHIP_UNCONFIRMED'));
  assert.deepEqual(calls, ['GET']);
});

test('refuses non-images, oversized streams, and denied or redirected downloads before upload', async () => {
  const cases = [
    { outcome: 'ATTACHMENT_NOT_IMAGE', respond: () => Response.json({ code: 0, msg: 'not an image' }) },
    { outcome: 'ATTACHMENT_SIZE_LIMIT', respond: () => new Response(image, { headers: { 'content-length': '2048' } }) },
    { outcome: 'ATTACHMENT_SIZE_LIMIT', maxBytes: 8, respond: () => new Response(image) },
    { outcome: 'ATTACHMENT_DOWNLOAD_REJECTED', respond: () => Response.redirect('https://elsewhere.example/') },
    { outcome: 'ATTACHMENT_DOWNLOAD_REJECTED', respond: () => new Response(image, { status: 206 }) },
    { outcome: 'ATTACHMENT_DOWNLOAD_REJECTED', respond: () => new Response('Access denied', { status: 403 }) }
  ];
  for (const sample of cases) {
    const calls = [];
    const client = harness(async (_, request) => { calls.push(request.method); return sample.respond(); }, { maxBytes: sample.maxBytes ?? 128 });
    await assert.rejects(client.copy(canCopy), code(sample.outcome));
    assert.deepEqual(calls, ['GET']);
  }
});

test('classifies uncertain POST outcomes without replaying the upload', async () => {
  const cases = [
    { outcome: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', respond: () => { throw new Error('secret from transport'); } },
    { outcome: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', respond: () => new Response('Error', { status: 502 }) },
    { outcome: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', respond: () => new Response('Not JSON') },
    { outcome: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', respond: () => Response.json({ code: 0, data: { file_token: newToken } }, { status: 202 }) },
    { outcome: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', respond: () => Response.json({ code: 1061006 }) },
    { outcome: 'ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN', respond: () => returnedToken(source.fileToken) },
    { outcome: 'ATTACHMENT_UPLOAD_REJECTED', respond: () => Response.json({ code: 1061004 }) }
  ];
  for (const sample of cases) {
    const calls = [];
    const client = harness(async (_, request) => {
      calls.push(request.method);
      return request.method === 'GET' ? new Response(image) : sample.respond();
    });
    await assert.rejects(client.copy(canCopy), code(sample.outcome));
    assert.deepEqual(calls, ['GET', 'POST']);
  }
});

test('uses an abortable deadline for an upload and keeps concurrent transfers serialized', async () => {
  const calls = [];
  let uploadStarted;
  const started = new Promise(resolve => { uploadStarted = resolve; });
  const client = harness(async (_, request) => {
    calls.push(request.method);
    if (request.method === 'GET') return new Response(image);
    uploadStarted();
    await wait(1000, undefined, { signal: request.signal });
    return returnedToken(newToken);
  }, { timeoutMs: 25 });
  const first = client.copy(canCopy);
  await started;
  await assert.rejects(client.copy(canCopy), code('ATTACHMENT_COPY_BUSY'));
  await assert.rejects(first, code('ATTACHMENT_UPLOAD_OUTCOME_UNKNOWN'));
  assert.deepEqual(calls, ['GET', 'POST']);
});
