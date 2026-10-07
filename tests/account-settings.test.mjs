import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.mjs';

const originalPassword = 'original-account-password';
const nextPassword = 'updated-account-password';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fitness-account-settings-'));
  const server = createServer({ dataDir: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  async function api(path, client, method = 'GET', body, headers = {}) {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(client?.cookie ? { Cookie: client.cookie } : {}),
        ...(client?.id ? { 'X-Fitness-User': client.id } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (client && response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const owner = { email: 'account-owner@example.test' };
  const registered = await api('/api/auth/register', owner, 'POST', { email: owner.email, name: '头像测试', password: originalPassword });
  assert.equal(registered.status, 201);
  owner.id = registered.body.user.id;
  async function login(password = originalPassword) {
    const client = {};
    const result = await api('/api/auth/login', client, 'POST', { email: owner.email, password });
    if (result.body.user) client.id = result.body.user.id;
    return { ...result, client };
  }
  const change = (client, currentPassword = originalPassword, newPassword = nextPassword, headers = {}) =>
    api('/api/account/password', client, 'PATCH', { currentPassword, newPassword }, headers);
  async function delayedChange(client, newPassword, currentPassword = originalPassword) {
    const payload = JSON.stringify({ currentPassword, newPassword });
    let request;
    const received = new Promise(resolve => server.once('request', resolve));
    const response = new Promise((resolve, reject) => {
      request = http.request(`${base}/api/account/password`, { method: 'PATCH', headers: {
        Cookie: client.cookie, 'X-Fitness-User': client.id, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject);
      request.write(payload.slice(0, 1));
    });
    await received;
    return { finish: () => { request.end(payload.slice(1)); return response; } };
  }
  return { owner, api, login, change, registered, delayedChange, base, directory };
}

test('changing a password preserves this session, revokes other sessions, and persists the new credentials', async t => {
  const f = await fixture(t);
  const other = await f.login();
  assert.equal(other.status, 200);
  const cookie = f.owner.cookie;
  const changed = await f.change(f.owner);
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { ok: true });
  assert.equal(f.owner.cookie, cookie);
  assert.equal((await f.api('/api/auth/me', f.owner)).status, 200);
  assert.equal((await f.api('/api/auth/me', other.client)).status, 401);
  assert.equal((await f.login(originalPassword)).status, 401);
  const updated = await f.login(nextPassword);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.user.password, undefined);
  assert.equal(updated.body.user.avatarUrl, null);
  const db = new DatabaseSync(join(f.directory, 'fitness.sqlite'));
  try {
    const stored = db.prepare('SELECT password FROM users WHERE id=?').get(f.owner.id).password;
    assert.match(stored, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.equal(stored.includes(nextPassword), false);
  } finally { db.close(); }
});

test('wrong current password, invalid lengths, missing fields and unchanged passwords do not alter credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.change(f.owner, 'wrong-current-password')).status, 401);
  for (const password of ['short', 'x'.repeat(257), 123456789, null]) {
    assert.equal((await f.change(f.owner, originalPassword, password)).status, 400);
  }
  assert.equal((await f.api('/api/account/password', f.owner, 'PATCH', { newPassword: nextPassword })).status, 401);
  assert.equal((await f.change(f.owner, originalPassword, originalPassword)).status, 400);
  assert.equal((await f.login()).status, 200);
  assert.equal((await f.login(nextPassword)).status, 401);
  // Both documented boundaries remain valid, matching registration.
  assert.equal((await f.change(f.owner, originalPassword, '8charpwd')).status, 200);
  assert.equal((await f.change(f.owner, '8charpwd', 'x'.repeat(256))).status, 200);
  assert.equal((await f.login('x'.repeat(256))).status, 200);
});

test('password changes enforce authentication, the expected account, origin and JSON requirements', async t => {
  const f = await fixture(t);
  assert.equal((await f.change(null)).status, 401);
  assert.equal((await f.change(f.owner, originalPassword, nextPassword, { 'X-Fitness-User': 'another-account' })).status, 409);
  assert.equal((await f.change(f.owner, originalPassword, nextPassword, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.change(f.owner, originalPassword, nextPassword, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.change(f.owner, originalPassword, nextPassword, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.login()).status, 200);
});

test('concurrent changes cannot overwrite the winning password', async t => {
  const f = await fixture(t);
  const passwords = ['concurrent-first-password', 'concurrent-second-password'];
  const results = await Promise.all(passwords.map(password => f.change(f.owner, originalPassword, password)));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const winner = results.findIndex(result => result.status === 200);
  assert.ok([401, 409].includes(results[1 - winner].status));
  assert.equal((await f.login(passwords[winner])).status, 200);
  assert.equal((await f.login(passwords[1 - winner])).status, 401);
});

test('a request waiting for its body cannot overwrite changed credentials or revive a revoked session', async t => {
  const f = await fixture(t);
  const pending = await f.delayedChange(f.owner, 'stale-account-password');
  assert.equal((await f.change(f.owner)).status, 200);
  assert.equal((await pending.finish()).status, 409);
  assert.equal((await f.login(nextPassword)).status, 200);

  const loggedIn = await f.login(nextPassword);
  const pendingLogout = await f.delayedChange(loggedIn.client, 'must-never-be-saved', nextPassword);
  assert.equal((await f.api('/api/auth/logout', loggedIn.client, 'POST', {})).status, 200);
  // This request captured the current hash before logout, but must not update after its session disappears.
  assert.equal((await pendingLogout.finish()).status, 401);
  assert.equal((await f.login('must-never-be-saved')).status, 401);
});

test('authentication returns the same avatar as the community profile, including removal', async t => {
  const f = await fixture(t);
  assert.equal(f.registered.body.user.avatarUrl, null);
  assert.equal((await f.api('/api/auth/me', f.owner)).body.user.avatarUrl, null);
  const image = await readFile(new URL('../public/assets/exercises/squat.jpg', import.meta.url));
  const uploaded = await fetch(`${f.base}/api/community/media?purpose=avatar`, { method: 'POST',
    headers: { Cookie: f.owner.cookie, 'X-Fitness-User': f.owner.id, 'Content-Type': 'image/jpeg' }, body: image });
  assert.equal(uploaded.status, 201);
  const media = (await uploaded.json()).media;
  const profile = await f.api('/api/community/me/profile', f.owner, 'PATCH', { avatarMediaId: media.id });
  assert.equal(profile.status, 200);
  const expected = `/api/community/media/${encodeURIComponent(media.id)}`;
  assert.equal(profile.body.profile.avatarUrl, expected);
  assert.equal((await f.api('/api/auth/me', f.owner)).body.user.avatarUrl, expected);
  assert.equal((await f.login()).body.user.avatarUrl, expected);
  assert.equal((await f.api('/api/community/me/profile', f.owner, 'PATCH', { avatarMediaId: null })).status, 200);
  assert.equal((await f.api('/api/auth/me', f.owner)).body.user.avatarUrl, null);
  assert.equal((await f.login()).body.user.avatarUrl, null);
});

test('password changes share the existing authentication attempt limit', async t => {
  const f = await fixture(t);
  // Registration consumes the first of the existing 40 attempts per IP and 15 minutes.
  for (let i = 0; i < 39; i++) assert.equal((await f.change(f.owner, originalPassword, 'short')).status, 400);
  assert.equal((await f.change(f.owner)).status, 429);
  assert.equal((await f.login()).status, 429);
  assert.equal((await f.api('/api/auth/me', f.owner)).status, 200);
});
