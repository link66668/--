import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.mjs';
import { createCommunityStore } from '../server/community-storage.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fitness-community-profile-'));
  const options = { dataDir: directory, communityModeratorEmails: ['profile-moderator@example.test'] };
  let server, base;
  async function start() {
    server = createServer(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function register(name, email) {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'profile-test-password' })
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return { id: body.user.id, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  async function api(path, client, method = 'GET', payload) {
    const response = await fetch(`${base}${path.startsWith('/api/') ? path : `/api/community${path}`}`, {
      method, headers: { ...(client ? { Cookie: client.cookie, 'X-Fitness-User': client.id } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    const body = await response.json();
    if (client && response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body };
  }
  async function publish(client, title) {
    const result = await api('/notes', client, 'POST', {
      clientMutationId: crypto.randomUUID(), type: 'text', title,
      body: '记录训练后的感受。', category: 'training', topics: [], media: []
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.note;
  }
  const owner = await register('Profile owner', 'profile-owner@example.test');
  const collector = await register('Profile collector', 'profile-collector@example.test');
  const moderator = await register('Profile moderator', 'profile-moderator@example.test');
  async function stats(expected) {
    for (const [path, viewer, self] of [['/me/profile', owner, true], [`/users/${owner.id}`, collector, false]]) {
      const result = await api(path, viewer);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const profile = result.body.profile;
      assert.equal(profile.isSelf, self);
      assert.deepEqual({ notes: profile.noteCount, likes: profile.receivedLikeCount,
        collections: profile.receivedCollectionCount, engagement: profile.receivedEngagementCount }, expected);
      assert.equal(profile.receivedEngagementCount, profile.receivedLikeCount + profile.receivedCollectionCount);
      assert.equal(typeof profile.followingCount, 'number');
      assert.equal(typeof profile.followerCount, 'number');
      const encoded = JSON.stringify(profile);
      assert.equal(encoded.includes('@example.test'), false);
      assert.equal(encoded.includes(collector.id), false);
      for (const field of ['email', 'records', 'healthProfile', 'collections', 'collectorIds']) assert.equal(field in profile, false);
    }
  }
  return { api, publish, stats, owner, collector, moderator, restart: async () => { await stop(); await start(); } };
}

test('community profiles count current likes and collections across public notes without exposing private collections', async t => {
  const { api, publish, stats, owner, collector } = await fixture(t);
  await stats({ notes: 0, likes: 0, collections: 0, engagement: 0 });
  const first = await publish(owner, '第一篇训练笔记');
  const second = await publish(owner, '第二篇训练笔记');
  for (const note of [first, second]) {
    assert.equal((await api(`/notes/${note.id}/like`, collector, 'PUT', { active: true })).status, 200);
    assert.equal((await api(`/notes/${note.id}/collection`, collector, 'PUT', { active: true })).status, 200);
  }
  await stats({ notes: 2, likes: 2, collections: 2, engagement: 4 });
  // Repeated desired-state writes must not inflate the profile counters.
  await api(`/notes/${first.id}/like`, collector, 'PUT', { active: true });
  await api(`/notes/${first.id}/collection`, collector, 'PUT', { active: true });
  await stats({ notes: 2, likes: 2, collections: 2, engagement: 4 });
  await api(`/notes/${first.id}/like`, collector, 'PUT', { active: false });
  await api(`/notes/${second.id}/collection`, collector, 'PUT', { active: false });
  await stats({ notes: 2, likes: 1, collections: 1, engagement: 2 });
  // A collection count is public; the collector's saved-note list remains private.
  assert.equal((await api(`/users/${collector.id}/collections`, owner)).status, 403);
  const ownCollections = await api('/me/collections', collector);
  assert.equal(ownCollections.status, 200);
  assert.deepEqual(ownCollections.body.items.map(note => note.id), [first.id]);
  const ownerCollections = await api('/me/collections', owner);
  assert.deepEqual(ownerCollections.body.items, []);
  assert.equal((await api(`/notes/${first.id}`, owner, 'DELETE', { version: first.version })).status, 200);
  await stats({ notes: 1, likes: 1, collections: 0, engagement: 1 });
});

test('community profile engagement excludes hidden notes and restores their current interactions on visibility restoration', async t => {
  const { api, publish, stats, owner, collector, moderator } = await fixture(t);
  const note = await publish(owner, '可见状态统计');
  await api(`/notes/${note.id}/like`, collector, 'PUT', { active: true });
  await api(`/notes/${note.id}/collection`, collector, 'PUT', { active: true });
  await stats({ notes: 1, likes: 1, collections: 1, engagement: 2 });
  const reported = await api('/reports', collector, 'POST', {
    clientMutationId: crypto.randomUUID(), targetType: 'note', targetId: note.id, reason: 'other', description: '测试可见状态'
  });
  assert.equal(reported.status, 201);
  const reportId = reported.body.report.id;
  const hidden = await api(`/moderation/reports/${reportId}`, moderator, 'PATCH', {
    clientMutationId: crypto.randomUUID(), version: 1, action: 'hide', reason: '测试下架'
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  await stats({ notes: 0, likes: 0, collections: 0, engagement: 0 });
  assert.equal((await api(`/notes/${note.id}/collection`, collector, 'PUT', { active: true })).status, 404);
  const restored = await api(`/moderation/reports/${reportId}`, moderator, 'PATCH', {
    clientMutationId: crypto.randomUUID(), version: 2, action: 'restore', reason: '测试恢复'
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await stats({ notes: 1, likes: 1, collections: 1, engagement: 2 });
});

test('existing community profiles migrate to private collections and keep owner visibility settings across schema initialization', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE community_profiles(user_id TEXT PRIMARY KEY,nickname TEXT NOT NULL,avatar_media_id TEXT,bio TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
      INSERT INTO users(id) VALUES('legacy-owner');
      INSERT INTO community_profiles(user_id,nickname,updated_at) VALUES('legacy-owner','旧账号','2026-10-02');`);
    createCommunityStore(db);
    assert.equal(db.prepare('SELECT collections_visibility FROM community_profiles WHERE user_id=?').get('legacy-owner').collections_visibility, 'private');
    db.prepare("UPDATE community_profiles SET collections_visibility='public' WHERE user_id=?").run('legacy-owner');
    createCommunityStore(db);
    assert.equal(db.prepare('SELECT collections_visibility FROM community_profiles WHERE user_id=?').get('legacy-owner').collections_visibility, 'public');
    assert.throws(() => db.prepare('UPDATE community_profiles SET collections_visibility=? WHERE user_id=?').run('unknown', 'legacy-owner'), /CHECK/);
  } finally { db.close(); }
});

test('collection visibility is owner configurable, persisted, and rechecked before stale public pagination', async t => {
  const { api, publish, owner, collector, moderator, restart } = await fixture(t);
  const first = await publish(collector, '公开收藏笔记一');
  const second = await publish(collector, '公开收藏笔记二');
  for (const note of [first, second]) assert.equal((await api(`/notes/${note.id}/collection`, owner, 'PUT', { active: true })).status, 200);
  assert.equal((await api('/me/profile', owner)).body.profile.collectionsVisibility, 'private');
  assert.equal((await api(`/users/${owner.id}`, collector)).body.profile.collectionsVisibility, 'private');
  assert.equal((await api(`/users/${owner.id}/collections`)).status, 401);
  const denied = await api(`/users/${owner.id}/collections`, collector);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'collections_private');
  assert.equal('items' in denied.body, false);
  assert.equal((await api(`/users/${owner.id}/collections`, owner)).body.items.length, 2);
  const visible = await api('/me/profile', owner, 'PATCH', { collectionsVisibility: 'public' });
  assert.equal(visible.status, 200);
  assert.equal(visible.body.profile.collectionsVisibility, 'public');
  assert.equal((await api('/me/profile', owner, 'PATCH', { nickname: '新的社区昵称' })).body.profile.collectionsVisibility, 'public');
  const exported = await api('/api/export', owner);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.community.profile.collectionsVisibility, 'public');
  assert.deepEqual(new Set(exported.body.community.collections.map(item => item.noteId)), new Set([first.id, second.id]));
  await restart();
  assert.equal((await api(`/users/${owner.id}`, collector)).body.profile.collectionsVisibility, 'public');
  const publicPage = await api(`/users/${owner.id}/collections?limit=1`, collector);
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.body.items.length, 1);
  assert.equal(publicPage.body.hasMore, true);
  assert.ok(publicPage.body.nextCursor);
  const publicNext = `/users/${owner.id}/collections?limit=1&cursor=${encodeURIComponent(publicPage.body.nextCursor)}`;
  const nextPage = await api(publicNext, collector);
  assert.equal(nextPage.status, 200);
  assert.equal(new Set([...publicPage.body.items, ...nextPage.body.items].map(note => note.id)).size, 2);
  for (const note of [...publicPage.body.items, ...nextPage.body.items]) {
    for (const field of ['collectorIds', 'collectedBy', 'collectionOwner', 'healthProfile', 'records']) assert.equal(field in note, false);
    assert.equal(JSON.stringify(note).includes('@example.test'), false);
  }
  // The owner can continue reading their own list independently of public access.
  const ownerPage = await api(`/users/${owner.id}/collections?limit=1`, owner);
  const ownerNext = `/users/${owner.id}/collections?limit=1&cursor=${encodeURIComponent(ownerPage.body.nextCursor)}`;
  for (const value of ['PUBLIC', '', null, true, 1, ['public']]) {
    assert.equal((await api('/me/profile', owner, 'PATCH', { collectionsVisibility: value })).status, 400);
    assert.equal((await api('/me/profile', owner)).body.profile.collectionsVisibility, 'public');
  }
  assert.equal((await api(`/users/${owner.id}`, collector, 'PATCH', { collectionsVisibility: 'private' })).status, 404);
  // Forged target IDs on the self-only endpoint cannot change a different owner.
  assert.equal((await api('/me/profile', collector, 'PATCH', { userId: owner.id, collectionsVisibility: 'private' })).status, 200);
  assert.equal((await api('/me/profile', owner)).body.profile.collectionsVisibility, 'public');
  assert.equal((await api('/me/profile', owner, 'PATCH', { collectionsVisibility: 'private' })).status, 200);
  assert.equal((await api(publicNext, collector)).status, 403);
  assert.equal((await api(`${publicNext}&ignored=1`, moderator)).status, 403);
  assert.equal((await api(ownerNext, owner)).status, 200);
  await restart();
  assert.equal((await api('/me/profile', owner)).body.profile.collectionsVisibility, 'private');
  assert.equal((await api(publicNext, collector)).status, 403);
  assert.equal((await api('/me/profile', owner, 'PATCH', { collectionsVisibility: 'public' })).status, 200);
  // Switching back to public starts a new list; the revoked snapshot stays revoked.
  assert.equal((await api(publicNext, collector)).status, 400);
  assert.equal((await api(`/users/${owner.id}/collections`, collector)).status, 200);
});

test('public collections never expose deleted or hidden saved notes and recheck snapshot note visibility', async t => {
  const { api, publish, owner, collector, moderator } = await fixture(t);
  const notes = [];
  for (let index = 0; index < 4; index++) {
    const note = await publish(collector, `收藏状态 ${index}`);
    notes.push(note);
    await api(`/notes/${note.id}/collection`, owner, 'PUT', { active: true });
  }
  await api('/me/profile', owner, 'PATCH', { collectionsVisibility: 'public' });
  const page = await api(`/users/${owner.id}/collections?limit=1`, collector);
  assert.equal(page.status, 200);
  const remaining = notes.filter(note => note.id !== page.body.items[0].id);
  const reported = await api('/reports', owner, 'POST', {
    clientMutationId: crypto.randomUUID(), targetType: 'note', targetId: remaining[0].id, reason: 'other'
  });
  assert.equal(reported.status, 201);
  assert.equal((await api(`/moderation/reports/${reported.body.report.id}`, moderator, 'PATCH', {
    clientMutationId: crypto.randomUUID(), action: 'hide', reason: '测试收藏可见状态'
  })).status, 200);
  assert.equal((await api(`/notes/${remaining[1].id}`, collector, 'DELETE', { version: remaining[1].version })).status, 200);
  assert.equal((await api(`/notes/${remaining[2].id}/collection`, owner, 'PUT', { active: false })).status, 200);
  const continued = await api(`/users/${owner.id}/collections?cursor=${encodeURIComponent(page.body.nextCursor)}`, collector);
  assert.equal(continued.status, 200);
  assert.deepEqual(continued.body.items, []);
  assert.equal(continued.body.hasMore, false);
  assert.deepEqual((await api(`/users/${owner.id}/collections`, collector)).body.items.map(note => note.id), [page.body.items[0].id]);
  assert.deepEqual((await api('/me/collections', owner)).body.items.map(note => note.id), [page.body.items[0].id]);
});
