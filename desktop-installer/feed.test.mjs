import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { checkGitHubUpdate, downloadGitHubArchive } from './feed.mjs';

const repository = 'example-owner/feishu-dispatch';
const latestUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const assets = `https://github.com/${repository}/releases/download/v2.10.0`;
const archive = Buffer.from('mock ZIP contents');
const archiveName = 'feishu-dispatch-v2.10.0.zip';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const channel = { repository, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function manifest() {
  return {
    format: 'feishu-dispatch-update-v1', repository, version: '2.10.0',
    archive: { name: archiveName, bytes: archive.length, sha256: sha256(archive) },
    files: [{ path: 'production-v2/cli.mjs', bytes: 1, sha256: sha256('x') }]
  };
}

function fakeFeed({ latest = { tag_name: 'v2.10.0', draft: false, prerelease: false },
  value = manifest(), alter, overrides = {} } = {}) {
  const signed = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const signature = `${sign(null, signed, privateKey).toString('base64')}\n`;
  const calls = [];
  const routes = {
    [latestUrl]: () => Response.json(latest),
    [`${assets}/manifest.json`]: () => new Response(alter ? alter(signed) : signed),
    [`${assets}/manifest.sig`]: () => new Response(signature),
    [`${assets}/${archiveName}`]: () => new Response(archive),
    ...overrides
  };
  return { calls, async fetchImpl(url, options) {
    calls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, undefined);
    if (!routes[url]) throw new Error('Unexpected mocked URL');
    return routes[url]();
  } };
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

test('checks the version numerically, verifies exact signed UTF-8 bytes and downloads from a pinned tag through the GitHub CDN', async () => {
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/a?signature=synthetic';
  const fixture = fakeFeed({ overrides: { [`${assets}/${archiveName}`]: () => redirect(cdn), [cdn]: () => new Response(archive) } });
  const offer = await checkGitHubUpdate(channel, '2.9.20', fixture);
  assert.deepEqual(offer, { version: '2.10.0', manifest: manifest(), archiveUrl: `${assets}/${archiveName}` });
  assert.throws(() => { offer.manifest.archive.bytes = 1; }, TypeError);
  assert.deepEqual(await downloadGitHubArchive(offer, fixture), archive);
  assert.deepEqual(fixture.calls, [latestUrl, `${assets}/manifest.json`, `${assets}/manifest.sig`, `${assets}/${archiveName}`, cdn]);
});

test('same or older versions and a repository with no public releases produce no offer', async () => {
  for (const current of ['2.10.0', '2.10.1', '2.11.0']) {
    const fixture = fakeFeed();
    assert.equal(await checkGitHubUpdate(channel, current, fixture), null);
    assert.deepEqual(fixture.calls, [latestUrl]);
  }
  const fixture = fakeFeed({ overrides: { [latestUrl]: () => new Response(null, { status: 404 }) } });
  assert.equal(await checkGitHubUpdate(channel, '2.1.0', fixture), null);
});

test('rejects tag injection, invalid current versions, prereleases and repository path injection', async () => {
  for (const tag of ['v2.2.0-beta', 'v2.02.0', 'v3.0.0', 'v2.3.0/x', 'v2.4.0?asset=bar']) {
    const fixture = fakeFeed({ latest: { tag_name: tag } });
    await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_RELEASE_TAG_INVALID' });
    assert.deepEqual(fixture.calls, [latestUrl]);
  }
  const fixture = fakeFeed({ latest: { tag_name: 'v2.10.0', prerelease: true } });
  await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_RELEASE_INVALID' });
  await assert.rejects(checkGitHubUpdate(channel, '2.01.0', fixture), { code: 'UPDATE_CURRENT_VERSION_INVALID' });
  for (const injected of ['example-owner/..', '../repository', 'owner/repo?spoof=true', 'owner/a%2Fb']) {
    await assert.rejects(checkGitHubUpdate({ ...channel, repository: injected }, '2.1.0', fixture), { code: 'UPDATE_REPOSITORY_INVALID' });
  }
  assert.deepEqual(fixture.calls, [latestUrl]);
});

test('checks Ed25519 signature before reading the manifest and rejects modified raw bytes', async () => {
  const fixture = fakeFeed({ alter: bytes => Buffer.concat([bytes, Buffer.from(' ')]) });
  await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_SIGNATURE_INVALID' });
  const notEd25519 = generateKeyPairSync('ed448').publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(checkGitHubUpdate({ ...channel, publicKey: notEd25519 }, '2.1.0', fakeFeed()), { code: 'UPDATE_PUBLIC_KEY_INVALID' });
  const malformed = fakeFeed({ overrides: { [`${assets}/manifest.sig`]: () => new Response('=invalid=') } });
  await assert.rejects(checkGitHubUpdate(channel, '2.1.0', malformed), { code: 'UPDATE_SIGNATURE_INVALID' });
});

test('rejects validly signed manifests for another repository, tag version, format or unsafe archive and file metadata', async () => {
  for (const identity of [{ repository: 'other-owner/other-repo' }, { version: '2.11.0' }]) {
    const fixture = fakeFeed({ value: { ...manifest(), ...identity } });
    await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_RELEASE_IDENTITY_MISMATCH' });
  }
  for (const mutate of [
    value => { value.format = 'shiyeji-workflow-code-v2'; },
    value => { value.files[0].path = '../cli.mjs'; },
    value => { value.files.push({ ...value.files[0], path: value.files[0].path.toUpperCase() }); },
    value => { value.archive.name = '../payload.zip'; },
    value => { value.archive.bytes = 65 * 1024 ** 2; }
  ]) {
    const value = manifest();
    mutate(value);
    await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fakeFeed({ value })), { code: /^UPDATE_(MANIFEST|ARCHIVE_METADATA)_INVALID$/ });
  }
});

test('never follows redirects off the exact entry and release CDN allowlist', async () => {
  for (const location of [
    'http://release-assets.githubusercontent.com/a',
    'https://release-assets.githubusercontent.com.evil.invalid/a',
    'https://release-assets.githubusercontent.com:8042/a',
    'https://user@release-assets.githubusercontent.com/a',
    'https://@release-assets.githubusercontent.com/a',
    'https:////@release-assets.githubusercontent.com/a',
    'https://raw.githubusercontent.com/a',
    'https://github.com/other/repo/releases/download/v2.10.0/manifest.json',
    `https://github.com/${repository}/releases/download/v2.11.0/manifest.json`
  ]) {
    const fixture = fakeFeed({ overrides: { [`${assets}/manifest.json`]: () => redirect(location) } });
    await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_REDIRECT_UNTRUSTED' });
    assert.equal(fixture.calls.includes(location), false);
  }
  const apiRedirect = fakeFeed({ overrides: { [latestUrl]: () => redirect('https://api.github.com/repositories/123/releases/latest') } });
  await assert.rejects(checkGitHubUpdate(channel, '2.1.0', apiRedirect), { code: 'UPDATE_REDIRECT_UNTRUSTED' });
});

test('caps actual streamed API and manifest bytes even without Content-Length and rejects a huge declared body', async () => {
  const oversized = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  }));
  for (const url of [latestUrl, `${assets}/manifest.json`]) {
    const fixture = fakeFeed({ overrides: { [url]: oversized } });
    await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_BODY_LIMIT' });
  }
  const fixture = fakeFeed({ overrides: { [latestUrl]: () => new Response('{}', { headers: { 'Content-Length': '99999999' } }) } });
  await assert.rejects(checkGitHubUpdate(channel, '2.1.0', fixture), { code: 'UPDATE_BODY_LIMIT' });
});

test('refuses fabricated offers even with a correctly shaped archive and rejects short, excessive and wrong-hash content', async () => {
  const original = await checkGitHubUpdate(channel, '2.0.0', fakeFeed());
  const unverified = fakeFeed();
  await assert.rejects(downloadGitHubArchive({ ...original }, unverified), { code: 'UPDATE_OFFER_UNVERIFIED' });
  assert.deepEqual(unverified.calls, []);
  for (const [value, code] of [
    [archive.subarray(1), 'UPDATE_ARCHIVE_LENGTH_MISMATCH'],
    [Buffer.concat([archive, Buffer.from('x')]), 'UPDATE_BODY_LIMIT'],
    [Buffer.alloc(archive.length, 1), 'UPDATE_ARCHIVE_HASH_MISMATCH']
  ]) {
    const fixture = fakeFeed({ overrides: { [`${assets}/${archiveName}`]: () => new Response(value) } });
    await assert.rejects(downloadGitHubArchive(original, fixture), { code });
  }
});
