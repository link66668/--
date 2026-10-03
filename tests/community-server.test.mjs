import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createServer } from '../server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fitness-community-test-'));
  let server, base;
  const pendingRequests = new Set();
  const options = { dataDir: directory, communityModeratorEmails: ['moderator@example.test'] };
  async function start() {
    server = createServer(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (!server?.listening) return;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
  await start();
  t.after(async () => { for (const request of pendingRequests) request.destroy(); await stop(); await rm(directory, { recursive: true, force: true }); });
  async function api(path, method = 'GET', body, client, extraHeaders = {}) {
    const response = await fetch(`${base}${path.startsWith('/api/') ? path : `/api/community${path}`}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(client ? { Cookie: client.cookie, 'X-Fitness-User': client.id } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (client && response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: value, headers: response.headers };
  }
  async function register(name, email) {
    const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'test-community-password' }) });
    const value = await response.json(); assert.equal(response.status, 201, JSON.stringify(value));
    return { id: value.user.id, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const alice = await register('Alice', 'alice@example.test');
  const bob = await register('Bob', 'bob@example.test');
  const moderator = await register('Moderator', 'moderator@example.test');
  async function publish(client, title = '训练记录', extra = {}) {
    const result = await api('/notes', 'POST', { clientMutationId: crypto.randomUUID(), type: 'text', title, body: '这是测试中的真实提交内容。', category: 'training', topics: ['基础力量'], media: [], ...extra }, client);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.note;
  }
  const database = callback => {
    const db = new DatabaseSync(join(directory, 'fitness.sqlite'));
    try { return callback(db); } finally { db.close(); }
  };
  const raw = (path, client, options = {}) => fetch(`${base}/api/community${path}`, { ...options,
    headers: { Cookie: client.cookie, 'X-Fitness-User': client.id, ...options.headers } });
  function beginJson(path, method, body, client) {
    const route = `/api/community${path}`, bytes = Buffer.from(JSON.stringify(body));
    let startedResolve, responseResolve, responseReject;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const result = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
    const observe = request => {
      if (request.url !== route || request.method !== method) return;
      server.off('request', observe);
      // Observe arrival without entering flowing mode or consuming the first byte.
      request.once('readable', startedResolve);
    };
    server.on('request', observe);
    const request = http.request(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
      Cookie: client.cookie, 'X-Fitness-User': client.id } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { pendingRequests.delete(request); responseResolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
    });
    pendingRequests.add(request);
    request.on('error', error => { server.off('request', observe); pendingRequests.delete(request); responseReject(error); });
    request.write(bytes.subarray(0, 1));
    return { started, finish: () => { request.end(bytes.subarray(1)); return result; } };
  }
  return { api, raw, beginJson, publish, alice, bob, moderator, database, directory, restart: async () => { await stop(); await start(); } };
}

test('community login boundary, public DTO, note versions and publication retry persistence', async t => {
  const { api, publish, alice, bob, restart } = await fixture(t);
  assert.equal((await api('/feed')).status, 401);
  assert.equal((await api('/feed', 'GET', undefined, bob, { 'X-Fitness-User': alice.id })).status, 409);
  const body = { clientMutationId: 'publication-retry', title: '第一次完整训练', body: '保留换行\n继续训练', category: 'training', topics: ['#基础力量', '基础力量'], media: [] };
  assert.equal((await api('/notes', 'POST', body, alice, { Origin: 'https://outside.example' })).status, 403);
  const created = await api('/notes', 'POST', body, alice);
  assert.equal(created.status, 201);
  const id = created.body.note.id;
  assert.equal(created.body.note.version, 1);
  assert.equal(created.body.note.type, 'text');
  assert.deepEqual(created.body.note.topics, ['基础力量']);
  assert.equal(created.body.note.likeCount, 0);
  assert.equal((await api('/notes', 'POST', body, alice)).body.note.id, id);
  assert.equal((await api('/notes', 'POST', { ...body, title: '重复键的其他内容' }, alice)).status, 409);
  assert.equal((await api('/notes', 'POST', { ...body, clientMutationId: 'invalid-long-title', title: '长'.repeat(41) }, alice)).status, 400);
  const publicNote = (await api(`/notes/${id}`, 'GET', undefined, bob)).body.note;
  assert.equal(publicNote.body, body.body);
  assert.equal(publicNote.author.id, alice.id);
  assert.equal(JSON.stringify(publicNote).includes('alice@example.test'), false);
  assert.equal('email' in publicNote.author, false);
  assert.equal((await api(`/me/notes/${id}`, 'GET', undefined, bob)).status, 404);
  const edit = { ...body, clientMutationId: 'edit-first', version: 1, title: '修改后的完整训练' };
  assert.equal((await api(`/notes/${id}`, 'PATCH', edit, bob)).status, 403);
  const saved = await api(`/notes/${id}`, 'PATCH', edit, alice);
  assert.equal(saved.status, 200); assert.equal(saved.body.note.version, 2);
  assert.equal(saved.body.note.createdAt, created.body.note.createdAt);
  assert.equal((await api(`/notes/${id}`, 'PATCH', { ...edit, clientMutationId: 'stale-edit' }, alice)).status, 409);
  assert.equal((await api(`/notes/${id}`, 'PATCH', edit, alice)).body.note.version, 2);
  await restart();
  assert.equal((await api(`/notes/${id}`, 'GET', undefined, bob)).body.note.title, edit.title);
  assert.equal((await api('/notes', 'POST', body, alice)).body.note.id, id);
  const { body: { profile } } = await api(`/users/${alice.id}`, 'GET', undefined, bob);
  assert.equal(profile.noteCount, 1); assert.equal('email' in profile, false);
  assert.equal((await api('/me/profile', 'PATCH', { nickname: '社区称呼', bio: '循序渐进', role: 'moderator' }, alice)).body.profile.isModerator, false);
  assert.equal((await api('/moderation/reports', 'GET', undefined, alice)).status, 403);
  const empty = await api('/notes', 'POST', { ...body, clientMutationId: 'empty-body', body: '' }, alice);
  assert.equal(empty.status, 400);
  const second = await publish(bob);
  assert.equal((await api(`/notes/${second.id}`, 'DELETE', { version: 1 }, alice)).status, 403);
});

test('community snapshots freeze ranking, bind account and filter, and recheck current visibility', async t => {
  const { api, publish, alice, bob, database, restart } = await fixture(t);
  const notes = [];
  for (let index = 0; index < 6; index++) notes.push(await publish(alice, `训练搜索词 ${index}`, { category: index % 2 ? 'diet' : 'training' }));
  const first = await api('/feed?limit=2', 'GET', undefined, bob);
  assert.equal(first.body.items.length, 2); assert.equal(first.body.hasMore, true);
  const snapshot = JSON.parse(Buffer.from(first.body.nextCursor, 'base64url').toString());
  const frozenIds = database(db => JSON.parse(db.prepare('SELECT ids FROM community_snapshots WHERE id=?').get(snapshot.id).ids));
  const newNote = await publish(alice, '后加入的训练搜索词');
  await api(`/notes/${frozenIds.at(-1)}/like`, 'PUT', { active: true }, bob);
  assert.equal((await api(`/feed?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, 'GET', undefined, alice)).status, 400);
  assert.equal((await api(`/feed?category=diet&cursor=${encodeURIComponent(first.body.nextCursor)}`, 'GET', undefined, bob)).status, 400);
  await restart();
  const loaded = first.body.items.map(note => note.id); let cursor = first.body.nextCursor;
  while (cursor) {
    const result = await api(`/feed?limit=2&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, bob);
    assert.equal(result.status, 200); loaded.push(...result.body.items.map(note => note.id)); cursor = result.body.nextCursor;
  }
  assert.deepEqual(loaded, frozenIds); assert.equal(loaded.includes(newNote.id), false);
  assert.equal(new Set(loaded).size, notes.length);
  const search = await api('/search?q=训练搜索词&limit=2', 'GET', undefined, bob);
  const searchSnapshot = JSON.parse(Buffer.from(search.body.nextCursor, 'base64url').toString());
  const searchIds = database(db => JSON.parse(db.prepare('SELECT ids FROM community_snapshots WHERE id=?').get(searchSnapshot.id).ids));
  const doomed = searchIds[2];
  const doomedNote = (await api(`/notes/${doomed}`, 'GET', undefined, alice)).body.note;
  assert.equal((await api(`/notes/${doomed}`, 'DELETE', { version: doomedNote.version, clientMutationId: 'delete-note' }, alice)).status, 200);
  const page = await api(`/search?q=训练搜索词&limit=2&cursor=${encodeURIComponent(search.body.nextCursor)}`, 'GET', undefined, bob);
  assert.equal(page.status, 200); assert.equal(page.body.items.some(note => note.id === doomed), false);
  assert.equal((await api(`/notes/${doomed}`, 'GET', undefined, alice)).status, 404);
  assert.equal((await api(`/notes/${doomed}/like`, 'PUT', { active: true }, bob)).status, 404);
  database(db => db.prepare('UPDATE community_snapshots SET expires_at=0 WHERE id=?').run(searchSnapshot.id));
  assert.equal((await api(`/search?q=训练搜索词&cursor=${encodeURIComponent(search.body.nextCursor)}`, 'GET', undefined, bob)).status, 409);
});

test('community relationships and notifications are idempotent and private, including reread and refollow', async t => {
  const { api, publish, alice, bob } = await fixture(t);
  const note = await publish(alice);
  for (let index = 0; index < 3; index++) {
    const liked = await api(`/notes/${note.id}/like`, 'PUT', { active: true }, bob);
    assert.equal(liked.body.likeCount, 1); assert.equal(liked.body.liked, true);
  }
  await api(`/notes/${note.id}/collection`, 'PUT', { active: true }, bob);
  await api(`/notes/${note.id}/collection`, 'PUT', { active: true }, bob);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: true }, bob);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: true }, bob);
  assert.equal((await api(`/users/${alice.id}/follow`, 'PUT', { active: true }, alice)).status, 400);
  assert.equal((await api(`/notes/${note.id}/like`, 'PUT', { active: 1 }, bob)).status, 400);
  const notifications = await api('/notifications', 'GET', undefined, alice);
  assert.equal(notifications.body.items.length, 3); assert.equal(notifications.body.unreadCount, 3);
  const bobNotifications = await api('/notifications', 'GET', undefined, bob);
  assert.equal(bobNotifications.body.items.length, 0);
  await api('/notifications/read', 'PUT', { ids: notifications.body.items.map(item => item.id) }, bob);
  assert.equal((await api('/notifications', 'GET', undefined, alice)).body.unreadCount, 3);
  await api('/notifications/read', 'PUT', { all: true }, alice);
  await api(`/notes/${note.id}/like`, 'PUT', { active: false }, bob);
  await api(`/notes/${note.id}/like`, 'PUT', { active: true }, bob);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: false }, bob);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: true }, bob);
  const repeated = await api('/notifications', 'GET', undefined, alice);
  assert.equal(repeated.body.items.length, 3); assert.equal(repeated.body.unreadCount, 0);
  assert.equal((await api('/me/collections', 'GET', undefined, bob)).body.items.length, 1);
  assert.equal((await api('/me/collections', 'GET', undefined, alice)).body.items.length, 0);
  const following = await api('/feed?channel=following&limit=1', 'GET', undefined, bob);
  assert.equal(following.body.items.length, 1);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: false }, bob);
  assert.equal((await api('/feed?channel=following', 'GET', undefined, bob)).body.items.length, 0);
  const stats = (await api(`/users/${alice.id}`, 'GET', undefined, bob)).body.profile;
  assert.equal(stats.followerCount, 0); assert.equal(stats.receivedLikeCount, 1);
  await api(`/notes/${note.id}/like`, 'PUT', { active: true }, alice);
  assert.equal((await api('/notifications', 'GET', undefined, alice)).body.items.length, 3);
});

test('community notification groups paginate complete type sets and revoke cover previews with content visibility', async t => {
  const { api, raw, publish, alice, bob, moderator } = await fixture(t);
  const image = await readFile(new URL('../public/assets/exercises/squat.jpg', import.meta.url));
  const upload = await raw('/media?purpose=note', alice, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Filename': 'squat.jpg' }, body: image });
  assert.equal(upload.status, 201);
  const { media } = await upload.json();
  const note = await publish(alice, '通知中的真实封面', { type: 'image', media: [{ id: media.id, role: 'image', isCover: true }] });
  await api(`/notes/${note.id}/like`, 'PUT', { active: true }, bob);
  await api(`/notes/${note.id}/collection`, 'PUT', { active: true }, bob);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: true }, bob);
  let likedCommentId;
  for (let index = 0; index < 12; index++) {
    const root = await api(`/notes/${note.id}/comments`, 'POST', { clientMutationId: `group-root-${index}`, body: `评论 ${index}` }, bob);
    const answer = await api(`/notes/${note.id}/comments`, 'POST', { clientMutationId: `group-answer-${index}`, body: `作者回复 ${index}`, parentId: root.body.comment.id }, alice);
    const reply = await api(`/notes/${note.id}/comments`, 'POST', { clientMutationId: `group-reply-${index}`, body: `继续回复 ${index}`, parentId: root.body.comment.id, replyToCommentId: answer.body.comment.id }, bob);
    assert.equal(root.status, 201); assert.equal(answer.status, 201); assert.equal(reply.status, 201);
    if (!index) {
      likedCommentId = answer.body.comment.id;
      await api(`/comments/${likedCommentId}/like`, 'PUT', { active: true }, bob);
    }
  }
  const first = await api('/notifications?type=comments&limit=7', 'GET', undefined, alice);
  assert.equal(first.status, 200); assert.equal(first.body.items.length, 7); assert.equal(first.body.hasMore, true);
  assert.equal((await api('/notifications?type=constructor', 'GET', undefined, alice)).status, 400);
  assert.equal((await api('/notifications?type=__proto__', 'GET', undefined, alice)).status, 400);
  assert.equal((await api(`/notifications?type=engagement&cursor=${encodeURIComponent(first.body.nextCursor)}`, 'GET', undefined, alice)).status, 400);
  assert.equal((await api(`/notifications?type=comments&cursor=${encodeURIComponent(first.body.nextCursor)}`, 'GET', undefined, bob)).status, 400);
  const combined = [...first.body.items];
  let cursor = first.body.nextCursor;
  while (cursor) {
    const page = await api(`/notifications?type=comments&limit=7&cursor=${encodeURIComponent(cursor)}`, 'GET', undefined, alice);
    assert.equal(page.status, 200);
    combined.push(...page.body.items); cursor = page.body.nextCursor;
  }
  assert.equal(combined.length, 24); assert.equal(new Set(combined.map(item => item.id)).size, 24);
  assert.equal(combined.filter(item => item.type === 'comment').length, 12);
  assert.equal(combined.filter(item => item.type === 'reply').length, 12);
  assert(combined.every(item => item.available && item.preview.cover.id === media.id && item.preview.cover.url === media.url));
  assert.equal((await api('/notifications?type=comment&limit=50', 'GET', undefined, alice)).body.items.length, 12);
  assert.equal((await api('/notifications?type=reply&limit=50', 'GET', undefined, alice)).body.items.length, 12);
  const engagement = (await api('/notifications?type=engagement', 'GET', undefined, alice)).body;
  assert.equal(engagement.items.length, 3); assert.deepEqual(new Set(engagement.items.map(item => item.type)), new Set(['like', 'collection']));
  const commentLike = engagement.items.find(item => item.targetCommentId === likedCommentId);
  assert.equal(commentLike.preview.body, '作者回复 0'); assert.equal(commentLike.preview.cover.id, media.id);
  assert.equal((await api('/notifications?limit=20', 'GET', undefined, alice)).body.items.some(item => ['like', 'collection'].includes(item.type)), false);
  assert.equal((await api('/notifications?type=follow', 'GET', undefined, alice)).body.items[0].preview, null);
  assert.equal((await api('/notifications?type=comments', 'GET', undefined, alice)).body.unreadCount, 28);
  await api('/notifications/read', 'PUT', { ids: [commentLike.id] }, alice);
  assert.equal((await api('/notifications?type=engagement', 'GET', undefined, alice)).body.items.find(item => item.id === commentLike.id).read, true);
  assert.equal((await api('/notifications?type=comments', 'GET', undefined, alice)).body.unreadCount, 27);
  const report = await api('/reports', 'POST', { clientMutationId: 'notification-cover-report', targetType: 'note', targetId: note.id, reason: 'other' }, bob);
  assert.equal((await api(`/moderation/reports/${report.body.report.id}`, 'PATCH', { action: 'hide', reason: '通知预览权限验证' }, moderator)).status, 200);
  for (const type of ['comments', 'engagement']) {
    const hidden = await api(`/notifications?type=${type}&limit=50`, 'GET', undefined, alice);
    assert(hidden.body.items.every(item => !item.available && item.preview === null));
  }
  assert.equal((await raw(`/media/${media.id}`, bob, { method: 'HEAD' })).status, 404);
  assert.equal((await raw(`/media/${media.id}`, alice, { method: 'HEAD' })).status, 404);
  assert.equal((await raw(`/me/media/${media.id}`, alice, { method: 'HEAD' })).status, 200);
  const processing = (await api('/notifications?type=moderation', 'GET', undefined, alice)).body.items[0];
  assert.equal(processing.reason, '通知预览权限验证'); assert.equal(processing.preview, null);
  assert.equal((await api(`/moderation/reports/${report.body.report.id}`, 'PATCH', { action: 'restore', reason: '恢复预览' }, moderator)).status, 200);
  assert.equal((await api('/notifications?type=engagement', 'GET', undefined, alice)).body.items.find(item => item.id === commentLike.id).preview.cover.id, media.id);
  assert.equal((await api(`/comments/${likedCommentId}`, 'DELETE', {}, alice)).status, 200);
  const deletedComment = (await api('/notifications?type=engagement', 'GET', undefined, alice)).body.items.find(item => item.id === commentLike.id);
  assert.equal(deletedComment.available, false); assert.equal(deletedComment.preview, null);
});

test('community comments keep one reply level, preserve deleted parents, and locate notification targets', async t => {
  const { api, publish, alice, bob, moderator } = await fixture(t);
  const note = await publish(alice);
  const create = (body, client = bob) => api(`/notes/${note.id}/comments`, 'POST', body, client);
  const body = { clientMutationId: 'root-comment', body: '训练完成' };
  const root = await create(body);
  assert.equal(root.status, 201); assert.equal(root.body.commentCount, 1);
  assert.equal((await create(body)).body.comment.id, root.body.comment.id);
  assert.equal((await create({ ...body, body: '重用键修改' })).status, 409);
  assert.equal((await create({ clientMutationId: 'long-comment', body: '字'.repeat(501) })).status, 400);
  const rootId = root.body.comment.id;
  const firstReply = await create({ clientMutationId: 'reply-first', body: '一起进步', parentId: rootId }, alice);
  assert.equal(firstReply.status, 201); assert.equal(firstReply.body.comment.parentId, rootId);
  const replyToReply = await create({ clientMutationId: 'reply-second', body: '谢谢回复', parentId: rootId, replyToCommentId: firstReply.body.comment.id }, bob);
  assert.equal(replyToReply.body.comment.parentId, rootId);
  assert.equal(replyToReply.body.comment.replyToUser.id, alice.id);
  const rootPage = await api(`/notes/${note.id}/comments`, 'GET', undefined, alice);
  assert.equal(rootPage.body.commentCount, 3); assert.equal(rootPage.body.items[0].replies.length, 2);
  for (let index = 0; index < 23; index++) await create({ clientMutationId: `later-${index}`, body: `之后的顶层评论 ${index}` }, moderator);
  const newest = await api(`/notes/${note.id}/comments`, 'GET', undefined, bob);
  assert.equal(newest.body.items.some(item => item.id === rootId), false);
  const context = await api(`/comments/${replyToReply.body.comment.id}/context`, 'GET', undefined, alice);
  assert.equal(context.body.topLevelComment.id, rootId); assert.equal(context.body.targetComment.id, replyToReply.body.comment.id);
  const notification = (await api('/notifications?type=reply', 'GET', undefined, alice)).body.items.find(item => item.targetCommentId === replyToReply.body.comment.id);
  assert.equal(notification.topLevelCommentId, rootId); assert.equal(notification.available, true);
  assert.equal((await api(`/comments/${rootId}`, 'DELETE', {}, moderator)).status, 403);
  await api(`/comments/${rootId}/like`, 'PUT', { active: true }, alice);
  assert.equal((await api(`/comments/${rootId}/like`, 'PUT', { active: true }, alice)).body.likeCount, 1);
  assert.equal((await api(`/comments/${rootId}`, 'DELETE', {}, bob)).status, 200);
  const remaining = await api(`/notes/${note.id}/comments?limit=50`, 'GET', undefined, alice);
  const placeholder = remaining.body.items.find(item => item.id === rootId);
  assert.equal(placeholder.deleted, true); assert.equal(placeholder.body, ''); assert.equal(placeholder.replyCount, 2);
  assert.equal(remaining.body.commentCount, 25);
  assert.equal((await api(`/comments/${rootId}/like`, 'PUT', { active: true }, alice)).status, 404);
  assert.equal((await api(`/comments/${replyToReply.body.comment.id}/context`, 'GET', undefined, alice)).status, 200);
  assert.equal((await api(`/comments/${firstReply.body.comment.id}`, 'DELETE', {}, alice)).status, 200);
});

for (const targetKind of ['note', 'comment', 'reply']) {
  test(`community report reasons persist for ${targetKind} with optional descriptions and legacy compatibility`, async t => {
    const { api, publish, alice, bob, moderator, restart } = await fixture(t);
    const note = await publish(alice);
    let targetId = note.id;
    if (targetKind !== 'note') {
      const root = await api(`/notes/${note.id}/comments`, 'POST', { clientMutationId: 'report-root', body: '举报理由验收主评论' }, alice);
      assert.equal(root.status, 201);
      targetId = root.body.comment.id;
      if (targetKind === 'reply') {
        const reply = await api(`/notes/${note.id}/comments`, 'POST', { clientMutationId: 'report-reply', body: '举报理由验收子回复', parentId: targetId, replyToCommentId: targetId }, alice);
        assert.equal(reply.status, 201);
        targetId = reply.body.comment.id;
      }
    }
    const targetType = targetKind === 'note' ? 'note' : 'comment';
    const reasons = ['sexual', 'political', 'fraud', 'racism', 'offsite', 'illegal', 'spam', 'unfriendly', 'engagement', 'minors', 'cyberbullying', 'self_harm', 'irrelevant', 'other', 'copyright'];
    const submitted = [];
    for (const reason of reasons) {
      const description = reason === 'fraud' || reason === 'other' ? '可选的举报补充说明' : undefined;
      const result = await api('/reports', 'POST', { clientMutationId: `report-${targetKind}-${reason}`, targetType, targetId, reason, ...(description === undefined ? {} : { description }) }, bob);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.report.reason, reason);
      assert.equal(result.body.report.targetType, targetType);
      assert.equal(result.body.report.targetId, targetId);
      assert.equal(result.body.report.description, description ?? '');
      submitted.push(result.body.report.id);
    }
    for (const reason of ['unknown_reason', '色情低俗', '', null]) {
      const result = await api('/reports', 'POST', { clientMutationId: crypto.randomUUID(), targetType, targetId, reason }, bob);
      assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    await restart();
    const stored = (await api('/api/export', 'GET', undefined, bob)).body.community.reports;
    assert.equal(stored.length, reasons.length, 'Invalid reasons must not create reports');
    assert.deepEqual(stored.map(report => report.reason).sort(), [...reasons].sort());
    assert(submitted.every(id => stored.some(report => report.id === id && report.targetType === targetType && report.targetId === targetId)), 'Every submitted target persists across a server restart');
    const moderation = await api('/moderation/reports?limit=50', 'GET', undefined, moderator);
    assert.equal(moderation.status, 200);
    assert.equal(moderation.body.items.length, reasons.length);
    assert(moderation.body.items.every(report => report.target?.note?.id === note.id));
    if (targetKind !== 'note') assert(moderation.body.items.every(report => report.target.comment.id === targetId));
  });
}

test('community report moderation removes all ordinary previews and editing cannot bypass hidden state', async t => {
  const { api, publish, alice, bob, moderator } = await fixture(t);
  const note = await publish(alice, '需处理的训练笔记');
  await api(`/notes/${note.id}/collection`, 'PUT', { active: true }, bob);
  await api(`/notes/${note.id}/like`, 'PUT', { active: true }, bob);
  const reportBody = { clientMutationId: 'report-first', targetType: 'note', targetId: note.id, reason: 'spam', description: '提交给管理员检查' };
  const report = await api('/reports', 'POST', reportBody, bob);
  assert.equal(report.status, 201);
  assert.equal((await api('/reports', 'POST', reportBody, bob)).body.report.id, report.body.report.id);
  assert.equal((await api('/moderation/reports', 'GET', undefined, bob)).status, 403);
  const reportId = report.body.report.id;
  assert.equal((await api(`/moderation/reports/${reportId}`, 'PATCH', { action: 'hide', reason: '广告内容' }, bob)).status, 403);
  const hidden = await api(`/moderation/reports/${reportId}`, 'PATCH', { action: 'hide', reason: '广告内容', version: 1, clientMutationId: 'hide-first' }, moderator);
  assert.equal(hidden.status, 200); assert.equal(hidden.body.report.target.note.status, 'hidden');
  for (const client of [alice, bob, moderator]) assert.equal((await api(`/notes/${note.id}`, 'GET', undefined, client)).status, 404);
  assert.equal((await api('/feed', 'GET', undefined, bob)).body.items.length, 0);
  assert.equal((await api('/search?q=需处理', 'GET', undefined, bob)).body.items.length, 0);
  assert.equal((await api('/me/collections', 'GET', undefined, bob)).body.items.length, 0);
  const management = (await api(`/me/notes/${note.id}`, 'GET', undefined, alice)).body.note;
  assert.equal(management.status, 'hidden'); assert.equal(management.moderationReason, '广告内容');
  const edit = await api(`/notes/${note.id}`, 'PATCH', { clientMutationId: 'edit-hidden', version: management.version, title: '已修改训练笔记', body: '现在是训练内容', category: 'training', topics: [], media: [] }, alice);
  assert.equal(edit.body.note.status, 'hidden');
  const ownerNotifications = (await api('/notifications', 'GET', undefined, alice)).body.items;
  assert.equal(ownerNotifications.every(item => item.preview === null && item.available === false), true);
  assert.equal(ownerNotifications.find(item => item.type === 'moderation').reason, '广告内容');
  const restored = await api(`/moderation/reports/${reportId}`, 'PATCH', { action: 'restore', reason: '已完成修改', version: 2 }, moderator);
  assert.equal(restored.status, 200);
  assert.equal((await api(`/notes/${note.id}`, 'GET', undefined, bob)).body.note.title, '已修改训练笔记');
  assert.equal((await api('/me/collections', 'GET', undefined, bob)).body.items.length, 1);
  const restoredNote = (await api(`/me/notes/${note.id}`, 'GET', undefined, alice)).body.note;
  await api(`/notes/${note.id}`, 'DELETE', { version: restoredNote.version }, alice);
  const replay = await api(`/moderation/reports/${reportId}`, 'PATCH', { action: 'hide', reason: '广告内容', version: 1, clientMutationId: 'hide-first' }, moderator);
  assert.equal(replay.status, 404); assert.equal('report' in replay.body, false);
});

test('community export and account removal clear associations while retaining other users reply context', async t => {
  const { api, publish, alice, bob, database } = await fixture(t);
  const aliceNote = await publish(alice);
  const bobNote = await publish(bob);
  await api(`/notes/${aliceNote.id}/like`, 'PUT', { active: true }, bob);
  await api(`/notes/${bobNote.id}/collection`, 'PUT', { active: true }, alice);
  await api(`/users/${alice.id}/follow`, 'PUT', { active: true }, bob);
  const root = (await api(`/notes/${bobNote.id}/comments`, 'POST', { body: '账号删除后撤下这条评论', clientMutationId: 'account-comment' }, alice)).body.comment;
  const reply = (await api(`/notes/${bobNote.id}/comments`, 'POST', { body: '其他作者的回复仍保留', parentId: root.id, clientMutationId: 'account-reply' }, bob)).body.comment;
  const exported = await api('/api/export', 'GET', undefined, alice);
  assert.equal(exported.status, 200); assert.equal(exported.body.schemaVersion, 2);
  assert.equal(exported.body.community.notes.length, 1);
  assert.equal(exported.body.community.collections[0].noteId, bobNote.id);
  assert.equal(exported.body.community.comments[0].body, root.body);
  assert.equal((await api('/api/account', 'DELETE', { password: 'wrong-password' }, alice)).status, 401);
  assert.equal((await api('/api/account', 'DELETE', { password: 'test-community-password' }, alice)).status, 200);
  assert.equal((await api('/feed', 'GET', undefined, alice)).status, 401);
  assert.equal((await api(`/notes/${aliceNote.id}`, 'GET', undefined, bob)).status, 404);
  assert.equal((await api(`/users/${alice.id}`, 'GET', undefined, bob)).status, 404);
  const comments = await api(`/notes/${bobNote.id}/comments`, 'GET', undefined, bob);
  assert.equal(comments.body.commentCount, 1);
  assert.equal(comments.body.items[0].body, ''); assert.equal(comments.body.items[0].deleted, true);
  assert.equal(comments.body.items[0].author.nickname, '已注销用户');
  assert.equal(comments.body.items[0].replies[0].id, reply.id);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_follows').get().count), 0);
  assert.deepEqual(database(db => db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('community publication enforces real media ownership, exclusive binding and all hidden read paths', async t => {
  const { api, raw, publish, alice, bob, moderator, database, directory } = await fixture(t);
  const image = await readFile(new URL('../public/assets/exercises/squat.jpg', import.meta.url));
  const video = await readFile(new URL('./fixtures/community-tiny-aac.mp4', import.meta.url));
  async function upload(data = image, type = 'image/jpeg', purpose = 'note') {
    const response = await raw(`/media?purpose=${purpose}`, alice, { method: 'POST', body: data, headers: { 'Content-Type': type, 'X-Filename': 'test-fixture' } });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body.media;
  }
  const photo = await upload();
  assert.equal((await raw(`/media/${photo.id}`, bob)).status, 404);
  const wrongOwner = await api('/notes', 'POST', { title: '其他人的素材', body: '测试', category: 'training', topics: [], media: [{ id: photo.id, role: 'image', isCover: true }], clientMutationId: 'foreign-media' }, bob);
  assert.equal(wrongOwner.status, 422);
  assert.equal((await api('/me/notes', 'GET', undefined, bob)).body.items.length, 0);
  const note = await publish(alice, '带原图的训练', { type: 'image', media: [{ id: photo.id, role: 'image', isCover: true }] });
  assert.equal(note.cover.id, photo.id);
  const publicNote = (await api(`/notes/${note.id}`, 'GET', undefined, bob)).body.note;
  assert.equal((await raw(`/media/${photo.id}`, bob)).status, 200);
  assert.equal(publicNote.cover.url, `/api/community/media/${photo.id}`);
  const reused = await api('/notes', 'POST', { title: '重复引用', body: '测试', category: 'training', media: [{ id: photo.id, role: 'image' }], clientMutationId: 'media-reused' }, alice);
  assert.equal(reused.status, 422);
  assert.equal((await api('/me/profile', 'PATCH', { avatarMediaId: photo.id }, alice)).status, 422);
  const avatar = await upload(image, 'image/jpeg', 'avatar');
  const profile = await api('/me/profile', 'PATCH', { nickname: '循序记录', avatarMediaId: avatar.id }, alice);
  assert.equal(profile.status, 200); assert.equal((await raw(`/media/${avatar.id}`, bob)).status, 200);
  const film = await upload(video, 'video/mp4'), cover = await upload();
  const filmNote = await publish(alice, '短视频训练', { type: 'video', media: [{ id: film.id, role: 'video', isCover: false }, { id: cover.id, role: 'video-cover', isCover: true }] });
  assert.equal(filmNote.type, 'video'); assert.equal(filmNote.cover.id, cover.id);
  const ranged = await raw(`/media/${film.id}`, bob, { headers: { Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  const reported = await api('/reports', 'POST', { targetType: 'note', targetId: note.id, reason: 'other', clientMutationId: 'media-report' }, bob);
  const hiddenBody = { action: 'hide', reason: '测试下架后的授权', clientMutationId: 'hide-media' };
  const hidden = await api(`/moderation/reports/${reported.body.report.id}`, 'PATCH', hiddenBody, moderator);
  assert.equal(hidden.status, 200);
  for (const client of [alice, bob, moderator]) assert.equal((await raw(`/media/${photo.id}`, client)).status, 404);
  assert.equal((await raw(`/me/media/${photo.id}`, alice)).status, 200);
  assert.equal((await raw(`/me/media/${photo.id}`, bob)).status, 404);
  assert.equal((await raw(`/moderation/media/${photo.id}`, moderator)).status, 200);
  assert.equal((await raw(`/moderation/media/${photo.id}`, bob)).status, 404);
  assert.equal((await api('/api/account', 'DELETE', { password: 'test-community-password' }, alice)).status, 200);
  assert.equal((await api(`/moderation/reports/${reported.body.report.id}`, 'PATCH', hiddenBody, moderator)).status, 404);
  for (const item of [photo, film, cover, avatar]) assert.equal((await raw(`/media/${item.id}`, bob)).status, 404);
  assert.deepEqual(await readdir(join(directory, 'community-media')), []);
  assert.deepEqual(database(db => db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('community rate limits expose retry time and transaction failures roll back relationships', async t => {
  const { api, publish, alice, bob, database } = await fixture(t);
  const note = await publish(alice, '事务测试');
  database(db => db.exec("CREATE TRIGGER notification_failure BEFORE INSERT ON community_notifications BEGIN SELECT RAISE(ABORT,'notification-test-failure'); END;"));
  const failed = await api(`/notes/${note.id}/like`, 'PUT', { active: true }, bob);
  assert.equal(failed.status, 500);
  const unchanged = (await api(`/notes/${note.id}`, 'GET', undefined, bob)).body.note;
  assert.equal(unchanged.likeCount, 0); assert.equal(unchanged.liked, false);
  database(db => db.exec('DROP TRIGGER notification_failure'));
  assert.equal((await api(`/notes/${note.id}/like`, 'PUT', { active: true }, bob)).body.likeCount, 1);
  const initial = { title: '限流前的请求', body: '可重复查询确认', category: 'training', media: [], clientMutationId: 'before-rate-limit' };
  const stored = await api('/notes', 'POST', initial, alice); assert.equal(stored.status, 201);
  for (let index = 0; index < 18; index++) await publish(alice, `频率检查 ${index}`);
  const limited = await api('/notes', 'POST', { ...initial, clientMutationId: 'limited-request' }, alice);
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await api('/notes', 'POST', initial, alice)).body.note.id, stored.body.note.id);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_notes WHERE user_id=?').get(alice.id).count), 20);
});

test('community streaming writes recheck deleted and hidden targets inside their transaction', async t => {
  const { api, beginJson, publish, alice, bob, moderator, database } = await fixture(t);
  const deleted = await publish(alice, '请求体期间删除的笔记');
  const comment = beginJson(`/notes/${deleted.id}/comments`, 'POST', { body: '不能写入已删除内容', clientMutationId: 'slow-deleted-comment' }, bob);
  const like = beginJson(`/notes/${deleted.id}/like`, 'PUT', { active: true }, bob);
  const collection = beginJson(`/notes/${deleted.id}/collection`, 'PUT', { active: true }, bob);
  await Promise.all([comment.started, like.started, collection.started]);
  assert.equal((await api(`/notes/${deleted.id}`, 'DELETE', { version: 1 }, alice)).status, 200);
  for (const pending of [comment, like, collection]) assert.equal((await pending.finish()).status, 404);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_comments WHERE note_id=?').get(deleted.id).count), 0);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_note_likes WHERE note_id=?').get(deleted.id).count), 0);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_collections WHERE note_id=?').get(deleted.id).count), 0);
  const hidden = await publish(alice, '请求体期间下架的笔记');
  const reported = await api('/reports', 'POST', { targetType: 'note', targetId: hidden.id, reason: 'other', clientMutationId: 'slow-hide-report' }, bob);
  const hiddenComment = beginJson(`/notes/${hidden.id}/comments`, 'POST', { body: '不能写入刚下架内容', clientMutationId: 'slow-hidden-comment' }, bob);
  await hiddenComment.started;
  assert.equal((await api(`/moderation/reports/${reported.body.report.id}`, 'PATCH', { action: 'hide', reason: '测试下架竞态' }, moderator)).status, 200);
  assert.equal((await hiddenComment.finish()).status, 404);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_comments WHERE note_id=?').get(hidden.id).count), 0);
  const follow = beginJson(`/users/${alice.id}/follow`, 'PUT', { active: true }, bob);
  await follow.started;
  assert.equal((await api('/api/account', 'DELETE', { password: 'test-community-password' }, alice)).status, 200);
  assert.equal((await follow.finish()).status, 404);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_follows').get().count), 0);
  assert.equal(database(db => db.prepare("SELECT COUNT(*) AS count FROM community_mutations WHERE mutation_id IN ('slow-deleted-comment','slow-hidden-comment')").get().count), 0);
});
