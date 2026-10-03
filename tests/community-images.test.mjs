import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createServer } from '../server.mjs';

const jpeg = await readFile(new URL('../public/assets/exercises/squat.jpg', import.meta.url));
const webp = await readFile(new URL('./fixtures/community-tiny-vp8l.webp', import.meta.url));
const video = await readFile(new URL('./fixtures/community-tiny.mp4', import.meta.url));
const password = 'isolated-community-image-password';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'community-images-'));
  const pending = new Set(); let server, base;
  async function start() {
    server = createServer({ dataDir: directory, communityModeratorIds: [], communityModeratorEmails: ['image-admin@example.test'] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  await start();
  t.after(async () => { for (const req of pending) req.destroy(); await stop(); await rm(directory, { recursive: true, force: true }); });
  const raw = (user, path, options = {}) => fetch(base + (path.startsWith('/api/') ? path : '/api/community' + path), { ...options, headers: { Cookie: user.cookie, 'X-Fitness-User': user.id, ...options.headers } });
  async function api(user, path, method = 'GET', body) {
    const response = await raw(user, path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  async function register(name, email = `image-${name}@example.test`) {
    const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name, password }) });
    const value = await response.json(); assert.equal(response.status, 201);
    return { id: value.user.id, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const users = { alice: await register('alice'), bob: await register('bob'), outsider: await register('outsider'), admin: await register('admin', 'image-admin@example.test') };
  const query = callback => { const db = new DatabaseSync(join(directory, 'fitness.sqlite')); try { return callback(db); } finally { db.close(); } };
  async function uploadResponse(user, data = jpeg, type = 'image/jpeg', purpose = 'attachment') {
    const response = await raw(user, '/media?purpose=' + purpose, { method: 'POST', headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent('隔离测试图片') }, body: data });
    return { status: response.status, body: await response.json() };
  }
  async function upload(user, data, type, purpose) { const result = await uploadResponse(user, data, type, purpose); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.media; }
  async function note(user = users.alice) { const response = await api(user, '/notes', 'POST', { title: '隔离图片讨论', body: '分享训练情况', category: 'training', topics: [], media: [], clientMutationId: randomUUID() }); assert.equal(response.status, 201); return response.body.note; }
  async function conversation(a = users.alice, b = users.bob) { const response = await api(a, '/messages/conversations', 'POST', { userId: b.id }); assert.equal(response.status, 200); return response.body.conversation; }
  async function group() { const result = await api(users.alice, '/groups', 'POST', { name: '隔离图片群', clientMutationId: randomUUID() }); assert.equal(result.status, 201); return result.body.group; }
  async function invite(g, recipient = users.bob) {
    const invited = await api(users.alice, `/groups/${g.id}/invitations`, 'POST', { userIds: [recipient.id] }); assert.equal(invited.status, 200);
    const accepted = await api(recipient, '/groups/invitations/' + invited.body.items[0].id, 'PATCH', { action: 'accept' }); assert.equal(accepted.status, 200);
  }
  const file = id => query(db => { const row = db.prepare('SELECT storage_key FROM community_media WHERE id=?').get(id); return row && join(directory, 'community-media', row.storage_key); });
  function beginJson(user, path, body) {
    const bytes = Buffer.from(JSON.stringify(body)); let ready, done, fail;
    const started = new Promise(resolve => { ready = resolve; }), result = new Promise((resolve, reject) => { done = resolve; fail = reject; });
    const observe = req => { if (req.url !== '/api/community' + path) return; server.off('request', observe); req.once('readable', ready); }; server.on('request', observe);
    const req = http.request(base + '/api/community' + path, { method: 'POST', headers: { Cookie: user.cookie, 'X-Fitness-User': user.id, 'Content-Type': 'application/json', 'Content-Length': bytes.length } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { pending.delete(req); done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }); });
    pending.add(req); req.on('error', error => { pending.delete(req); server.off('request', observe); fail(error); }); req.write(bytes.subarray(0, 1));
    return { started, finish: () => { req.end(bytes.subarray(1)); return result; } };
  }
  return { directory, users, api, raw, query, upload, uploadResponse, note, conversation, group, invite, file, beginJson, start, stop };
}

test('attachment upload accepts real JPEG and static WebP, rejects video, corrupt images and oversize payloads, and keeps previews private', async t => {
  const { users, upload, uploadResponse, raw, query } = await fixture(t);
  for (const [data, type] of [[jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const image = await upload(users.alice, data, type); assert.equal(image.purpose, 'attachment'); assert(image.width > 0 && image.height > 0);
    const own = await raw(users.alice, image.url); assert.equal(own.status, 200); assert.deepEqual(Buffer.from(await own.arrayBuffer()), data);
    assert.equal((await raw(users.bob, image.url)).status, 404); assert.equal((await raw(users.admin, '/moderation/media/' + image.id)).status, 404);
  }
  assert.equal((await uploadResponse(users.alice, video, 'video/mp4')).status, 415);
  assert.equal((await uploadResponse(users.alice, jpeg.subarray(0, 150))).status, 422);
  assert.equal((await uploadResponse(users.alice, Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  assert.equal(query(db => db.prepare('SELECT COUNT(*) AS n FROM community_media').get().n), 2);
});

test('private images-only messages bind at most nine owned images atomically, preserve order and retry identity, and never become public through URL aliases', async t => {
  const f = await fixture(t), { users, api, raw } = f, c = await f.conversation(), path = `/messages/conversations/${c.id}/messages`;
  const images = []; for (let i = 0; i < 9; i++) images.push(await f.upload(users.alice));
  const ids = images.map(row => row.id), foreign = await f.upload(users.bob), wrongPurpose = await f.upload(users.alice, jpeg, 'image/jpeg', 'note');
  for (const imageIds of [[...ids, foreign.id], [ids[0], ids[0]], null]) assert.equal((await api(users.alice, path, 'POST', { body: '', imageIds, clientMutationId: randomUUID() })).status, 400);
  assert.equal((await api(users.alice, path, 'POST', { body: '', clientMutationId: randomUUID() })).status, 400);
  for (const id of [foreign.id, wrongPurpose.id]) assert.equal((await api(users.alice, path, 'POST', { imageIds: [id], clientMutationId: randomUUID() })).status, 422);
  const payload = { imageIds: ids, clientMutationId: 'private-images-retry' }, sent = await api(users.alice, path, 'POST', payload);
  assert.equal(sent.status, 201); assert.equal(sent.body.message.body, ''); assert.deepEqual(sent.body.message.images.map(row => row.id), ids);
  const retry = await api(users.alice, path, 'POST', { ...payload, body: '' }); assert.equal(retry.status, 201); assert.equal(retry.body.message.id, sent.body.message.id);
  assert.equal((await api(users.alice, path, 'POST', { ...payload, imageIds: [...ids].reverse() })).status, 409);
  assert.equal((await api(users.alice, path, 'POST', { ...payload, body: '改动' })).status, 409);
  assert.equal((await api(users.alice, path, 'POST', { ...payload, clientMutationId: randomUUID() })).status, 422);
  assert.deepEqual((await api(users.bob, path)).body.items[0].images.map(row => row.id), ids);
  assert.equal((await raw(users.bob, images[0].url)).status, 200);
  for (const who of [users.outsider, users.admin]) for (const prefix of ['/media/', '/me/media/', '/moderation/media/']) assert.equal((await raw(who, prefix + ids[0])).status, 404);
  assert.equal((await raw(users.alice, '/media/' + ids[0], { method: 'DELETE' })).status, 409);
  const n = await f.note(); assert.equal((await api(users.alice, `/notes/${n.id}/comments`, 'POST', { body: '不能转成公开评论', imageIds: [ids[0]], clientMutationId: randomUUID() })).status, 422);
  const exported = (await api(users.bob, '/api/export')).body.community.privateMessages.conversations[0].messages[0];
  assert.deepEqual(exported.images.map(row => row.id), ids);
});

test('simultaneous attempts to bind one upload commit one message without leaving partial rows or duplicate image bindings', async t => {
  const f = await fixture(t), c = await f.conversation(), image = await f.upload(f.users.alice), path = `/messages/conversations/${c.id}/messages`;
  const responses = await Promise.all([0, 1].map(() => f.api(f.users.alice, path, 'POST', { body: '', imageIds: [image.id], clientMutationId: randomUUID() })));
  assert.deepEqual(responses.map(row => row.status).sort(), [201, 422]);
  assert.equal((await f.api(f.users.bob, path)).body.items.length, 1);
  assert.equal(f.query(db => db.prepare('SELECT COUNT(*) AS n FROM community_attachment_media').get().n), 1);
});

test('comment and reply images share normal visibility, moderation previews, independent deletion, and idempotent images-only publishing', async t => {
  const f = await fixture(t), { users, api, raw } = f, n = await f.note(), first = await f.upload(users.bob), second = await f.upload(users.alice);
  const payload = { imageIds: [first.id], clientMutationId: 'comment-image-retry' };
  const created = await api(users.bob, `/notes/${n.id}/comments`, 'POST', payload); assert.equal(created.status, 201);
  const comment = created.body.comment; assert.equal(comment.body, ''); assert.deepEqual(comment.images.map(row => row.id), [first.id]);
  assert.equal((await api(users.bob, `/notes/${n.id}/comments`, 'POST', { ...payload, body: '' })).body.comment.id, comment.id);
  assert.equal((await api(users.bob, `/notes/${n.id}/comments`, 'POST', { ...payload, imageIds: [second.id] })).status, 409);
  const reply = (await api(users.alice, `/notes/${n.id}/comments`, 'POST', { body: '图片回复', imageIds: [second.id], parentId: comment.id, clientMutationId: randomUUID() })).body.comment;
  assert.equal(reply.parentId, comment.id); assert.deepEqual(reply.images.map(row => row.id), [second.id]);
  assert.equal((await raw(users.outsider, first.url)).status, 200);
  const report = (await api(users.alice, '/reports', 'POST', { targetType: 'comment', targetId: comment.id, reason: 'other', clientMutationId: randomUUID() })).body.report;
  assert.equal((await api(users.admin, `/moderation/reports/${report.id}`, 'PATCH', { action: 'hide', reason: '隔离审核', clientMutationId: randomUUID() })).status, 200);
  assert.equal((await raw(users.outsider, first.url)).status, 404); assert.equal((await raw(users.bob, first.url)).status, 404);
  assert.equal((await raw(users.admin, '/moderation/media/' + first.id)).status, 200);
  const reports = (await api(users.admin, '/moderation/reports?status=all')).body.items;
  assert.deepEqual(reports.find(row => row.id === report.id).target.comment.images.map(row => row.id), [first.id]);
  const exportedComment = (await api(users.bob, '/api/export')).body.community.comments.find(row => row.id === comment.id);
  assert.deepEqual(exportedComment.images.map(row => row.id), [first.id]);
  assert.equal((await raw(users.outsider, second.url)).status, 200);
  const hiddenRoot = (await api(users.alice, `/notes/${n.id}/comments`)).body.items.find(row => row.id === comment.id); assert.deepEqual(hiddenRoot.images, []);
  await api(users.admin, `/moderation/reports/${report.id}`, 'PATCH', { action: 'restore', reason: '恢复', clientMutationId: randomUUID() });
  const parentFile = f.file(first.id), replyFile = f.file(second.id);
  assert.equal((await api(users.alice, '/comments/' + comment.id, 'DELETE', {})).status, 200);
  assert.equal((await raw(users.bob, first.url)).status, 404); await assert.rejects(stat(parentFile), { code: 'ENOENT' });
  assert.equal((await raw(users.outsider, second.url)).status, 200);
  assert.equal((await api(users.alice, `/notes/${n.id}`, 'DELETE', { version: n.version })).status, 200);
  assert.equal((await raw(users.alice, '/me/media/' + second.id)).status, 404); await assert.rejects(stat(replyFile), { code: 'ENOENT' });
});

test('group image access and mentions follow current membership and joined-history boundaries, including sender removal, rejoin and dissolution', async t => {
  const f = await fixture(t), { users, api, raw } = f, g = await f.group(); await f.invite(g);
  const image = await f.upload(users.bob), payload = { imageIds: [image.id], mentionUserIds: [users.alice.id], clientMutationId: 'group-image-retry' };
  const sent = await api(users.bob, `/groups/${g.id}/messages`, 'POST', payload); assert.equal(sent.status, 201); assert.equal(sent.body.message.body, ''); assert.deepEqual(sent.body.message.images.map(row => row.id), [image.id]);
  assert.equal((await api(users.bob, `/groups/${g.id}/messages`, 'POST', payload)).body.message.id, sent.body.message.id);
  assert.equal((await api(users.bob, `/groups/${g.id}/messages`, 'POST', { ...payload, imageIds: [] })).status, 400);
  const received = (await api(users.alice, `/groups/${g.id}/messages`)).body.items[0]; assert.equal(received.mentionedMe, true); assert.deepEqual(received.images.map(row => row.id), [image.id]);
  assert.equal((await raw(users.alice, image.url)).status, 200);
  for (const prefix of ['/media/', '/me/media/', '/moderation/media/']) assert.equal((await raw(users.admin, prefix + image.id)).status, 404);
  await api(users.alice, `/groups/${g.id}/members/${users.bob.id}`, 'DELETE', {});
  for (const prefix of ['/media/', '/me/media/', '/moderation/media/']) assert.equal((await raw(users.bob, prefix + image.id)).status, 404);
  await f.invite(g);
  assert.equal((await raw(users.bob, image.url)).status, 404); assert.equal((await api(users.bob, `/groups/${g.id}/messages`)).body.items.length, 0);
  assert.equal((await api(users.bob, `/groups/${g.id}/messages`, 'POST', payload)).status, 409);
  assert.equal((await raw(users.alice, image.url)).status, 200);
  const storedFile = f.file(image.id);
  await api(users.alice, `/groups/${g.id}`, 'DELETE', {});
  assert.equal((await raw(users.alice, image.url)).status, 404); await assert.rejects(stat(storedFile), { code: 'ENOENT' });
});

test('slow image sends recheck removed group membership and hidden comment targets before binding uploads', async t => {
  const f = await fixture(t), { users, api, raw } = f, g = await f.group(); await f.invite(g);
  const groupImage = await f.upload(users.bob), pending = f.beginJson(users.bob, `/groups/${g.id}/messages`, { imageIds: [groupImage.id], clientMutationId: randomUUID() });
  await pending.started; await api(users.alice, `/groups/${g.id}/members/${users.bob.id}`, 'DELETE', {});
  assert.equal((await pending.finish()).status, 404);
  assert.equal((await raw(users.bob, groupImage.url)).status, 200);
  assert.equal(f.query(db => db.prepare('SELECT COUNT(*) AS n FROM community_attachment_media').get().n), 0);
  const n = await f.note(), image = await f.upload(users.bob), comment = f.beginJson(users.bob, `/notes/${n.id}/comments`, { imageIds: [image.id], clientMutationId: randomUUID() });
  await comment.started;
  const report = (await api(users.alice, '/reports', 'POST', { targetType: 'note', targetId: n.id, reason: 'other', clientMutationId: randomUUID() })).body.report;
  await api(users.admin, `/moderation/reports/${report.id}`, 'PATCH', { action: 'hide', reason: '先下架', clientMutationId: randomUUID() });
  assert.equal((await comment.finish()).status, 404); assert.equal((await raw(users.bob, image.url)).status, 200);
  assert.equal(f.query(db => db.prepare('SELECT COUNT(*) AS n FROM community_attachment_media').get().n), 0);
});

test('account deletion revokes and removes both participants private files while preserving other group senders files and exported image metadata', async t => {
  const f = await fixture(t), { users, api, raw } = f, c = await f.conversation(), g = await f.group(); await f.invite(g);
  const aliceImage = await f.upload(users.alice), bobImage = await f.upload(users.bob), keptGroupImage = await f.upload(users.bob);
  await api(users.alice, `/messages/conversations/${c.id}/messages`, 'POST', { imageIds: [aliceImage.id], clientMutationId: randomUUID() });
  await api(users.bob, `/messages/conversations/${c.id}/messages`, 'POST', { imageIds: [bobImage.id], clientMutationId: randomUUID() });
  await api(users.bob, `/groups/${g.id}/messages`, 'POST', { imageIds: [keptGroupImage.id], clientMutationId: randomUUID() });
  const exported = (await api(users.bob, '/api/export')).body.community;
  assert(exported.media.some(row => row.id === bobImage.id)); assert(exported.groups.messages[0].images.some(row => row.id === keptGroupImage.id));
  const removedFiles = [f.file(aliceImage.id), f.file(bobImage.id)], keptFile = f.file(keptGroupImage.id);
  assert.equal((await api(users.alice, '/api/account', 'DELETE', { password })).status, 200);
  assert.equal((await raw(users.bob, aliceImage.url)).status, 404); assert.equal((await raw(users.bob, bobImage.url)).status, 404);
  for (const path of removedFiles) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal((await raw(users.bob, keptGroupImage.url)).status, 200); assert((await stat(keptFile)).isFile());
  assert.equal((await api(users.bob, `/groups/${g.id}`)).body.group.role, 'owner');
});

test('legacy media purpose-check migration preserves note/avatar foreign keys, files and text messages, and remains stable after another restart', async t => {
  const f = await fixture(t), { users, api, raw } = f, n = await f.note(), c = await f.conversation();
  const noteImage = await f.upload(users.alice, jpeg, 'image/jpeg', 'note'), avatar = await f.upload(users.bob, webp, 'image/webp', 'avatar');
  await api(users.alice, `/notes/${n.id}`, 'PATCH', { version: n.version, title: n.title, body: n.body, category: n.category, topics: [], media: [{ id: noteImage.id, role: 'image', isCover: true }] });
  await api(users.bob, '/me/profile', 'PATCH', { avatarMediaId: avatar.id });
  const text = (await api(users.alice, `/messages/conversations/${c.id}/messages`, 'POST', { body: '旧版本纯文字', clientMutationId: 'legacy-text-message' })).body.message;
  await f.stop();
  f.query(db => {
    db.exec('PRAGMA foreign_keys=OFF');
    for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%attachments%'").all()) db.exec(`DROP TRIGGER "${trigger.name}"`);
    db.exec('DROP TABLE community_attachment_media');
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='community_media' AND type='table'").get().sql;
    db.exec(sql.replace('community_media', 'legacy_media_upgrade').replace(",'attachment'", ''));
    db.exec('INSERT INTO legacy_media_upgrade SELECT * FROM community_media; DROP TABLE community_media; ALTER TABLE legacy_media_upgrade RENAME TO community_media;');
  });
  await f.start();
  assert.equal((await raw(users.bob, noteImage.url)).status, 200); assert.equal((await raw(users.alice, avatar.url)).status, 200);
  assert.equal((await api(users.alice, `/notes/${n.id}`)).body.note.media[0].id, noteImage.id);
  const history = (await api(users.bob, `/messages/conversations/${c.id}/messages`)).body.items; assert.equal(history[0].id, text.id); assert.equal(history[0].body, text.body); assert.deepEqual(history[0].images, []);
  assert.deepEqual(f.query(db => db.prepare('PRAGMA foreign_key_check').all()), []);
  const image = await f.upload(users.alice); const newMessage = await api(users.alice, `/messages/conversations/${c.id}/messages`, 'POST', { imageIds: [image.id], clientMutationId: randomUUID() }); assert.equal(newMessage.status, 201);
  await f.stop(); await f.start();
  assert.equal((await raw(users.bob, image.url)).status, 200); assert.equal((await api(users.bob, `/messages/conversations/${c.id}/messages`)).body.items.at(-1).images[0].id, image.id);
  assert.deepEqual(f.query(db => db.prepare('PRAGMA foreign_key_check').all()), []);
});
