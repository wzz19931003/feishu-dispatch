import { createHash, createPublicKey, verify } from 'node:crypto';

const format = 'feishu-dispatch-update-v1';
const jsonLimit = 256 * 1024;
const signatureLimit = 256;
const archiveLimit = 64 * 1024 * 1024;
const installedFilesLimit = 256 * 1024 * 1024;
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const redirects = new Set([301, 302, 303, 307, 308]);
const verifiedOffers = new WeakSet();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(code) {
  throw Object.assign(new Error(`更新检查未完成（${code}）`), { code });
}

function exactKeys(value, ...keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function repositoryName(repository) {
  if (typeof repository !== 'string' || !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}\/[a-z\d_.-]{1,100}$/i.test(repository)) fail('UPDATE_REPOSITORY_INVALID');
  const name = repository.split('/')[1];
  if (name === '.' || name === '..') fail('UPDATE_REPOSITORY_INVALID');
  return repository;
}

function versionParts(version, code) {
  if (typeof version !== 'string' || !/^2\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version)) fail(code);
  return version.split('.').map(Number);
}

function publicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 1024 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z\d+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(pem)) {
    fail('UPDATE_PUBLIC_KEY_INVALID');
  }
  let key;
  try { key = createPublicKey(pem); } catch { fail('UPDATE_PUBLIC_KEY_INVALID'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('UPDATE_PUBLIC_KEY_INVALID');
  return key;
}

function utf8Text(bytes, code) {
  try { return utf8.decode(bytes); } catch { fail(code); }
}

function parseJson(bytes, code) {
  try { return JSON.parse(utf8Text(bytes, code)); } catch { fail(code); }
}

function signature(bytes) {
  const encoded = utf8Text(bytes, 'UPDATE_SIGNATURE_INVALID').replace(/[\r\n]+$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) fail('UPDATE_SIGNATURE_INVALID');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== encoded) fail('UPDATE_SIGNATURE_INVALID');
  return decoded;
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);
}

function validFilePath(value) {
  if (typeof value !== 'string' || value.length > 260 || value !== value.normalize('NFC') || /[\\\u0000-\u001f\u007f<>:"|?*]/u.test(value)) return false;
  return value.split('/').every(part => part && part !== '.' && part !== '..' && !/^\s|[.\s]$/u.test(part));
}

function validateManifest(value, repository, version) {
  if (!exactKeys(value, 'format', 'repository', 'version', 'archive', 'files') || value.format !== format) fail('UPDATE_MANIFEST_INVALID');
  if (value.repository !== repository || value.version !== version) fail('UPDATE_RELEASE_IDENTITY_MISMATCH');
  const { archive, files } = value;
  if (!exactKeys(archive, 'name', 'bytes', 'sha256') || typeof archive.name !== 'string' ||
    !/^[a-z\d][a-z\d._-]{0,123}\.zip$/i.test(archive.name) || !Number.isSafeInteger(archive.bytes) ||
    archive.bytes <= 0 || archive.bytes > archiveLimit || !validHash(archive.sha256)) fail('UPDATE_ARCHIVE_METADATA_INVALID');
  if (!Array.isArray(files) || !files.length || files.length > 512) fail('UPDATE_MANIFEST_INVALID');
  const paths = new Set();
  let expandedBytes = 0;
  for (const item of files) {
    if (!exactKeys(item, 'path', 'bytes', 'sha256') || !validFilePath(item.path) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !validHash(item.sha256)) fail('UPDATE_MANIFEST_INVALID');
    const key = item.path.toLowerCase();
    if (paths.has(key)) fail('UPDATE_MANIFEST_INVALID');
    paths.add(key);
    expandedBytes += item.bytes;
    if (expandedBytes > installedFilesLimit) fail('UPDATE_MANIFEST_INVALID');
    Object.freeze(item);
  }
  Object.freeze(files);
  Object.freeze(archive);
  return Object.freeze(value);
}

function releaseAsset(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${tag}/${name}`;
}

function cancel(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* A closed body needs no cleanup. */ }
}

function cdnRedirect(location, current) {
  if (typeof location !== 'string' || location.length > 8192 || !/^https:\/\/[a-z\d.-]+(?::443)?\//i.test(location) || /[\\\u0000-\u0020\u007f]/u.test(location)) {
    fail('UPDATE_REDIRECT_UNTRUSTED');
  }
  let url;
  try { url = new URL(location, current); } catch { fail('UPDATE_REDIRECT_UNTRUSTED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !cdnHosts.has(url.hostname)) fail('UPDATE_REDIRECT_UNTRUSTED');
  return url.href;
}

async function request(fetchImpl, entry, { asset = false, timeout, allowNotFound = false } = {}) {
  const signal = AbortSignal.timeout(timeout);
  const seen = new Set([entry]);
  let current = entry;
  for (let hop = 0; hop <= 3; hop++) {
    let response;
    try {
      response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal, headers: {
        Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'feishu-dispatch-desktop-update',
        ...(!asset ? { 'X-GitHub-Api-Version': '2022-11-28' } : {})
      } });
    } catch { fail('UPDATE_NETWORK_FAILED'); }
    if (response.redirected || (response.url && response.url !== current)) {
      cancel(response.body);
      fail('UPDATE_REDIRECT_UNTRUSTED');
    }
    if (redirects.has(response.status)) {
      cancel(response.body);
      if (!asset || hop === 3) fail('UPDATE_REDIRECT_UNTRUSTED');
      current = cdnRedirect(response.headers.get('location'), current);
      if (seen.has(current)) fail('UPDATE_REDIRECT_UNTRUSTED');
      seen.add(current);
      continue;
    }
    if (response.status === 200) return response;
    cancel(response.body);
    if (allowNotFound && response.status === 404) return null;
    fail('UPDATE_HTTP_FAILED');
  }
  fail('UPDATE_REDIRECT_UNTRUSTED');
}

async function readBounded(response, limit, expectedLength) {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > limit)) {
    cancel(response.body);
    fail('UPDATE_BODY_LIMIT');
  }
  if (expectedLength !== undefined && size !== null && Number(size) !== expectedLength) {
    cancel(response.body);
    fail('UPDATE_ARCHIVE_LENGTH_MISMATCH');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('UPDATE_BODY_UNAVAILABLE');
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(limit);
  let length = 0;
  try {
    while (true) {
      let chunk;
      try { chunk = await reader.read(); } catch { fail('UPDATE_NETWORK_FAILED'); }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail('UPDATE_BODY_UNAVAILABLE');
      const nextLength = length + chunk.value.byteLength;
      if (nextLength > limit) fail('UPDATE_BODY_LIMIT');
      bytes.set(chunk.value, length);
      length = nextLength;
    }
  } catch (error) {
    cancel(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (expectedLength !== undefined && length !== expectedLength) fail('UPDATE_ARCHIVE_LENGTH_MISMATCH');
  return bytes.subarray(0, length);
}

export async function checkGitHubUpdate(channel, currentVersion, { fetchImpl = globalThis.fetch } = {}) {
  const repository = repositoryName(channel?.repository);
  const key = publicKey(channel?.publicKey);
  const [, currentMinor, currentPatch] = versionParts(currentVersion, 'UPDATE_CURRENT_VERSION_INVALID');
  const latestUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  const latestResponse = await request(fetchImpl, latestUrl, { timeout: 20_000, allowNotFound: true });
  if (!latestResponse) return null;
  const latest = parseJson(await readBounded(latestResponse, jsonLimit), 'UPDATE_RELEASE_INVALID');
  if (typeof latest?.tag_name !== 'string' || !latest.tag_name.startsWith('v') ||
    latest.draft !== undefined && latest.draft !== false || latest.prerelease !== undefined && latest.prerelease !== false) fail('UPDATE_RELEASE_INVALID');
  const tag = latest.tag_name;
  const version = tag.slice(1);
  const [, minor, patch] = versionParts(version, 'UPDATE_RELEASE_TAG_INVALID');
  if (minor < currentMinor || minor === currentMinor && patch <= currentPatch) return null;

  const readAsset = async (name, limit) => readBounded(await request(fetchImpl, releaseAsset(repository, tag, name), { asset: true, timeout: 20_000 }), limit);
  const [manifestBytes, signatureBytes] = await Promise.all([readAsset('manifest.json', jsonLimit), readAsset('manifest.sig', signatureLimit)]);
  if (!verify(null, manifestBytes, key, signature(signatureBytes))) fail('UPDATE_SIGNATURE_INVALID');
  const manifest = validateManifest(parseJson(manifestBytes, 'UPDATE_MANIFEST_INVALID'), repository, version);
  const offer = Object.freeze({ version, manifest, archiveUrl: releaseAsset(repository, tag, manifest.archive.name) });
  verifiedOffers.add(offer);
  return offer;
}

export async function downloadGitHubArchive(offer, { fetchImpl = globalThis.fetch } = {}) {
  if (!verifiedOffers.has(offer)) fail('UPDATE_OFFER_UNVERIFIED');
  const { bytes, sha256 } = offer.manifest.archive;
  const response = await request(fetchImpl, offer.archiveUrl, { asset: true, timeout: 120_000 });
  const archive = await readBounded(response, bytes, bytes);
  if (createHash('sha256').update(archive).digest('hex') !== sha256.toLowerCase()) fail('UPDATE_ARCHIVE_HASH_MISMATCH');
  return archive;
}
