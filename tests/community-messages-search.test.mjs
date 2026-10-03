import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createServer } from '../server.mjs';

const PASSWORD = 'test-community-messages-password';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fitness-community-messages-test-'));
  const pendingRequests = new Set();
  let server, base;
  async function start() {
    server = createServer({ dataDir: directory });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (!server?.listening) return;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
  await start();
  t.after(async () => {
    for (const request of pendingRequests) request.destroy();
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function api(path, method = 'GET', body, client, extraHeaders = {}) {
    const response = await fetch(`${base}${path.startsWith('/api/') ? path : `/api/community${path}`}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(client ? { Cookie: client.cookie, 'X-Fitness-User': client.id } : {}),
        ...extraHeaders
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (client && response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: value };
  }
  async function raw(path, client, options = {}) {
    return fetch(`${base}/api/community${path}`, {
      ...options,
      headers: { Cookie: client.cookie, 'X-Fitness-User': client.id, ...options.headers }
    });
  }
  async function register(name, email) {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: PASSWORD })
    });
    const value = await response.json();
    assert.equal(response.status, 201, JSON.stringify(value));
    return { id: value.user.id, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const alice = await register('Alice', 'alice-messages@example.test');
  const bob = await register('Bob', 'bob-messages@example.test');
  const charlie = await register('Charlie', 'charlie-messages@example.test');
  const database = callback => {
    const db = new DatabaseSync(join(directory, 'fitness.sqlite'));
    try { return callback(db); } finally { db.close(); }
  };
  function beginJson(path, method, body, client) {
    const route = `/api/community${path}`, bytes = Buffer.from(JSON.stringify(body));
    let startedResolve, responseResolve, responseReject;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const result = new Promise((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
    const observe = request => {
      if (request.url !== route || request.method !== method) return;
      server.off('request', observe);
      request.once('readable', startedResolve);
    };
    server.on('request', observe);
    const request = http.request(`${base}${route}`, {
      method, headers: {
        'Content-Type': 'application/json', 'Content-Length': bytes.length,
        Cookie: client.cookie, 'X-Fitness-User': client.id
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        pendingRequests.delete(request);
        responseResolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
      });
    });
    pendingRequests.add(request);
    request.on('error', error => {
      server.off('request', observe); pendingRequests.delete(request); responseReject(error);
    });
    request.write(bytes.subarray(0, 1));
    return { started, finish: () => { request.end(bytes.subarray(1)); return result; } };
  }
  async function conversation(client = alice, peer = bob) {
    const result = await api('/messages/conversations', 'POST', { userId: peer.id }, client);
    assert.ok([200, 201].includes(result.status), JSON.stringify(result));
    return result.body.conversation;
  }
  async function message(conversationId, client, body, clientMutationId = crypto.randomUUID()) {
    const result = await api(`/messages/conversations/${conversationId}/messages`, 'POST', { body, clientMutationId }, client);
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.body.message;
  }
  return { api, raw, alice, bob, charlie, register, database, beginJson, conversation, message, restart: async () => { await stop(); await start(); } };
}

function assertPublicDto(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(/email|password|provider|apiKey|fitness|weight|height|birth|health/i.test(key), false, `Private field leaked: ${key}`);
    assertPublicDto(child);
  }
}

test('account search finds first-time community users by normalized nickname and exact stable account number', async t => {
  const { api, alice, bob, charlie, database, restart } = await fixture(t);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_profiles WHERE user_id=?').get(charlie.id).count), 0);
  const firstTime = await api('/search?type=users&q=charlie', 'GET', undefined, alice);
  assert.equal(firstTime.status, 200);
  assert.deepEqual(firstTime.body.items.map(item => item.id), [charlie.id]);
  assert.match(firstTime.body.items[0].accountNumber, /^\d{10}$/);
  assertPublicDto(firstTime.body);
  const number = firstTime.body.items[0].accountNumber;
  await api('/me/profile', 'PATCH', { nickname: 'Ｓｔｒｏｎｇ', bio: '循序训练' }, alice);
  await api('/me/profile', 'PATCH', { nickname: 'Strong Runner', bio: '' }, bob);
  const normalized = await api('/search?type=users&q=%20strong%20', 'GET', undefined, charlie);
  assert.equal(normalized.status, 200);
  assert.deepEqual(normalized.body.items.map(item => item.id), [alice.id, bob.id]);
  const fullWidthQuery = await api(`/search?type=users&q=${encodeURIComponent('ＳＴＲＯＮＧ')}`, 'GET', undefined, charlie);
  assert.deepEqual(fullWidthQuery.body.items.map(item => item.id), [alice.id, bob.id]);
  const exact = await api(`/search?type=users&q=${number}`, 'GET', undefined, bob);
  assert.deepEqual(exact.body.items.map(item => item.id), [charlie.id]);
  await api('/me/profile', 'PATCH', { nickname: '新的社区昵称', bio: '昵称可以修改' }, charlie);
  await restart();
  const persisted = await api(`/search?type=users&q=${number}`, 'GET', undefined, alice);
  assert.equal(persisted.body.items[0].nickname, '新的社区昵称');
  assert.equal(persisted.body.items[0].accountNumber, number);
  const profile = (await api(`/users/${charlie.id}`, 'GET', undefined, alice)).body.profile;
  assert.equal(profile.accountNumber, number);
  const numbers = database(db => db.prepare('SELECT account_number FROM community_accounts').all().map(row => row.account_number));
  assert.equal(new Set(numbers).size, numbers.length);
  assertPublicDto(profile);
  assert.equal((await api('/search?type=users&q=alice-messages%40example.test', 'GET', undefined, bob)).body.items.length, 0);
  assert.equal((await api('/search?type=users&q=charlie')).status, 401);
});

test('user search cursors bind query, type and account and skip accounts deleted after the first page', async t => {
  const { api, alice, bob, charlie, restart } = await fixture(t);
  for (const [client, nickname] of [[alice, 'Search Runner'], [bob, 'Search Walker'], [charlie, 'Search Yogi']]) {
    await api('/me/profile', 'PATCH', { nickname, bio: '' }, client);
  }
  const first = await api('/search?type=users&q=search&limit=1', 'GET', undefined, alice);
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.hasMore, true);
  const cursor = encodeURIComponent(first.body.nextCursor);
  assert.equal((await api(`/search?type=users&q=other&cursor=${cursor}`, 'GET', undefined, alice)).status, 400);
  assert.equal((await api(`/search?type=notes&q=search&cursor=${cursor}`, 'GET', undefined, alice)).status, 400);
  assert.equal((await api(`/search?type=users&q=search&cursor=${cursor}`, 'GET', undefined, bob)).status, 400);
  const removed = first.body.items[0].id === charlie.id ? bob : charlie;
  assert.equal((await api('/api/account', 'DELETE', { password: PASSWORD }, removed)).status, 200);
  await restart();
  const seen = first.body.items.map(item => item.id);
  let next = first.body.nextCursor;
  while (next) {
    const result = await api(`/search?type=users&q=search&limit=1&cursor=${encodeURIComponent(next)}`, 'GET', undefined, alice);
    assert.equal(result.status, 200, JSON.stringify(result));
    seen.push(...result.body.items.map(item => item.id));
    next = result.body.nextCursor;
  }
  assert.equal(seen.includes(removed.id), false);
  assert.deepEqual(new Set(seen), new Set([alice, bob, charlie].filter(client => client.id !== removed.id).map(client => client.id)));
  assert.equal(new Set(seen).size, seen.length);
});

test('note search remains the default, ranks relevance and supports a bound latest sort', async t => {
  const { api, alice, bob } = await fixture(t);
  async function note(title, body) {
    const result = await api('/notes', 'POST', { title, body, category: 'training', topics: [], media: [], clientMutationId: crypto.randomUUID() }, alice);
    assert.equal(result.status, 201, JSON.stringify(result));
    return result.body.note;
  }
  const exact = await note('Strength', '精确标题');
  const prefix = await note('Strength training', '前缀标题');
  const bodyOnly = await note('力量练习', '一段包含 Strength 的正文');
  const result = await api('/search?q=strength&limit=1', 'GET', undefined, bob);
  assert.equal(result.status, 200);
  assert.equal(result.body.items[0].id, exact.id);
  assert.equal(result.body.hasMore, true);
  assert.equal((await api(`/search?q=strength&sort=latest&cursor=${encodeURIComponent(result.body.nextCursor)}`, 'GET', undefined, bob)).status, 400);
  const latest = await api('/search?type=notes&q=strength&sort=latest', 'GET', undefined, bob);
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.body.items.map(item => item.id), [bodyOnly.id, prefix.id, exact.id]);
  assert.equal((await api('/search?type=invalid&q=strength', 'GET', undefined, bob)).status, 400);
  assert.equal((await api('/search?type=notes&q=strength&sort=invalid', 'GET', undefined, bob)).status, 400);
});

test('private conversations use one canonical pair, validate targets and enforce session ownership', async t => {
  const { api, alice, bob, charlie, conversation } = await fixture(t);
  assert.equal((await api('/messages/conversations')).status, 401);
  assert.equal((await api('/messages/conversations', 'GET', undefined, alice, { 'X-Fitness-User': bob.id })).status, 409);
  assert.equal((await api('/messages/conversations', 'POST', { userId: bob.id }, alice, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await api('/messages/conversations', 'POST', { userId: alice.id }, alice)).status, 400);
  assert.equal((await api('/messages/conversations', 'POST', { userId: 'missing-user' }, alice)).status, 404);
  assert.equal((await api('/messages/conversations', 'POST', {}, alice)).status, 400);
  const first = await conversation();
  const repeated = await conversation();
  const reverse = await conversation(bob, alice);
  assert.equal(first.id, repeated.id);
  assert.equal(first.id, reverse.id);
  assert.equal(first.peer.id, bob.id);
  assert.equal(reverse.peer.id, alice.id);
  assertPublicDto(first);
  const outsiderRead = await api(`/messages/conversations/${first.id}`, 'GET', undefined, charlie);
  assert.equal(outsiderRead.status, 404);
  assert.equal((await api(`/messages/conversations/${first.id}/messages`, 'GET', undefined, charlie)).status, 404);
  assert.equal((await api(`/messages/conversations/${first.id}/messages`, 'POST', { body: '越权发言', clientMutationId: 'outsider-send' }, charlie)).status, 404);
  assert.equal((await api(`/messages/conversations/${first.id}/read`, 'PUT', { lastMessageId: 'unknown' }, charlie)).status, 404);
  assert.equal((await api('/messages/conversations', 'GET', undefined, charlie)).body.items.length, 0);
});

test('private conversation self and peer use current public community names and avatars without weakening account isolation', async t => {
  const { api, raw, alice, bob, charlie, conversation, message } = await fixture(t);
  const image = await readFile(new URL('../public/assets/exercises/squat.jpg', import.meta.url));
  const avatars = new Map();
  for (const [client, nickname] of [[alice, '我的社区昵称'], [bob, '朋友的社区昵称']]) {
    const response = await raw('/media?purpose=avatar', client, {
      method: 'POST', body: image, headers: { 'Content-Type': 'image/jpeg', 'X-Filename': 'conversation-avatar.jpg' }
    });
    const uploaded = await response.json();
    assert.equal(response.status, 201, JSON.stringify(uploaded));
    avatars.set(client.id, `/api/community/media/${uploaded.media.id}`);
    assert.equal((await api('/me/profile', 'PATCH', { nickname, avatarMediaId: uploaded.media.id }, client)).status, 200);
  }
  const first = await conversation();
  function assertParticipants(dto, self, peer, selfNickname, peerNickname) {
    assert.equal(dto.self.id, self.id);
    assert.equal(dto.self.nickname, selfNickname);
    assert.equal(dto.self.avatarUrl, avatars.get(self.id));
    assert.equal(dto.peer.id, peer.id);
    assert.equal(dto.peer.nickname, peerNickname);
    assert.equal(dto.peer.avatarUrl, avatars.get(peer.id));
    assertPublicDto(dto);
  }
  assertParticipants(first, alice, bob, '我的社区昵称', '朋友的社区昵称');
  await message(first.id, alice, '使用社区头像发送的私信');
  assert.equal((await api('/me/profile', 'PATCH', { nickname: '更新后的社区昵称' }, alice)).status, 200);
  const repeated = await conversation();
  assert.equal(repeated.id, first.id);
  assertParticipants(repeated, alice, bob, '更新后的社区昵称', '朋友的社区昵称');
  const reverse = await conversation(bob, alice);
  assertParticipants(reverse, bob, alice, '朋友的社区昵称', '更新后的社区昵称');
  const read = await api(`/messages/conversations/${first.id}`, 'GET', undefined, alice);
  assert.equal(read.status, 200);
  assertParticipants(read.body.conversation, alice, bob, '更新后的社区昵称', '朋友的社区昵称');
  const list = await api('/messages/conversations', 'GET', undefined, bob);
  assert.equal(list.status, 200);
  assertParticipants(list.body.items[0], bob, alice, '朋友的社区昵称', '更新后的社区昵称');
  assert.equal((await api(`/messages/conversations/${first.id}`)).status, 401);
  assert.equal((await api(`/messages/conversations/${first.id}`, 'GET', undefined, charlie)).status, 404);
  assert.equal((await api(`/messages/conversations/${first.id}`, 'GET', undefined, alice, { 'X-Fitness-User': bob.id })).status, 409);
});

test('private messages exchange, validate content and persist idempotent retries without forged sender identity', async t => {
  const { api, alice, bob, charlie, conversation, message, restart } = await fixture(t);
  const thread = await conversation();
  const route = `/messages/conversations/${thread.id}/messages`;
  const payload = { body: '你好，一起循序训练\n明天见！', clientMutationId: 'persistent-message' };
  assert.equal((await api(route, 'POST', payload, alice, { Origin: 'https://outside.example' })).status, 403);
  const sent = await api(route, 'POST', payload, alice);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.senderId, alice.id);
  assert.equal(sent.body.message.body, payload.body);
  const forged = await api(route, 'POST', { body: '身份由会话决定', clientMutationId: 'forged-identity', senderId: bob.id, userId: bob.id }, alice);
  assert.ok([201, 400].includes(forged.status));
  if (forged.status === 201) assert.equal(forged.body.message.senderId, alice.id);
  const reply = await message(thread.id, bob, '收到，明天见！', 'bob-reply');
  assert.equal(reply.senderId, bob.id);
  const duplicate = await api(route, 'POST', payload, alice);
  assert.equal(duplicate.body.message.id, sent.body.message.id);
  assert.equal((await api(route, 'POST', { ...payload, body: '同一个请求键的其他正文' }, alice)).status, 409);
  const other = await conversation(alice, charlie);
  assert.equal((await api(`/messages/conversations/${other.id}/messages`, 'POST', payload, alice)).status, 409);
  for (const body of ['', ' \n ', '字'.repeat(1001), '文本\0尾部']) {
    assert.equal((await api(route, 'POST', { body, clientMutationId: crypto.randomUUID() }, alice)).status, 400);
  }
  assert.equal((await api(route, 'POST', { body: '缺少请求键' }, alice)).status, 400);
  await message(thread.id, alice, '😀'.repeat(1000), 'unicode-limit');
  await restart();
  assert.equal((await api(route, 'POST', payload, alice)).body.message.id, sent.body.message.id);
  const history = await api(route, 'GET', undefined, bob);
  assert.equal(history.status, 200);
  assert.equal(history.body.items.filter(item => item.id === sent.body.message.id).length, 1);
  assert.ok(history.body.items.some(item => item.id === reply.id));
  assertPublicDto(history.body);
});

test('message reads stop at the displayed received message so concurrent arrivals remain unread', async t => {
  const { api, alice, bob, charlie, conversation, message } = await fixture(t);
  const thread = await conversation();
  const first = await message(thread.id, alice, '第一条待阅读');
  const displayed = await message(thread.id, alice, '已显示的末条');
  const list = (await api('/messages/conversations', 'GET', undefined, bob)).body;
  assert.equal(list.unreadCount, 2);
  assert.equal(list.items[0].unreadCount, 2);
  assert.equal(list.items[0].lastMessage.id, displayed.id);
  // Merely fetching history must not acknowledge messages the browser has not displayed.
  await api(`/messages/conversations/${thread.id}/messages`, 'GET', undefined, bob);
  assert.equal((await api('/messages/unread', 'GET', undefined, bob)).body.unreadCount, 2);
  const arrived = await message(thread.id, alice, '读取期间新到达');
  const read = await api(`/messages/conversations/${thread.id}/read`, 'PUT', { lastMessageId: displayed.id }, bob);
  assert.equal(read.status, 200);
  assert.equal(read.body.conversationUnreadCount, 1);
  assert.equal(read.body.unreadCount, 1);
  // Out-of-order acknowledgements cannot move the read position backwards.
  await api(`/messages/conversations/${thread.id}/read`, 'PUT', { lastMessageId: first.id }, bob);
  assert.equal((await api('/messages/unread', 'GET', undefined, bob)).body.unreadCount, 1);
  const unrelated = await conversation(alice, charlie);
  const foreignMessage = await message(unrelated.id, alice, '另一个会话');
  assert.equal((await api(`/messages/conversations/${thread.id}/read`, 'PUT', { lastMessageId: foreignMessage.id }, bob)).status, 400);
  assert.equal((await api(`/messages/conversations/${thread.id}/read`, 'PUT', { lastMessageId: 'missing' }, bob)).status, 400);
  await api(`/messages/conversations/${thread.id}/read`, 'PUT', { lastMessageId: arrived.id }, bob);
  assert.equal((await api('/messages/unread', 'GET', undefined, bob)).body.unreadCount, 0);
  assert.equal((await api('/messages/unread', 'GET', undefined, alice)).body.unreadCount, 0);
  const reply = await message(thread.id, bob, '现在轮到对方阅读');
  assert.equal((await api('/messages/unread', 'GET', undefined, alice)).body.unreadCount, 1);
  assert.equal((await api('/messages/conversations', 'GET', undefined, alice)).body.items.find(item => item.id === thread.id).lastMessage.id, reply.id);
});

test('message sequence paging survives equal timestamps and validates cursors across viewers and conversations', async t => {
  const { api, alice, bob, charlie, database, conversation, message, restart } = await fixture(t);
  const thread = await conversation();
  const sent = [];
  for (let index = 0; index < 9; index++) sent.push(await message(thread.id, index % 2 ? bob : alice, `序列 ${index}`));
  database(db => db.prepare('UPDATE community_messages SET created_at=? WHERE conversation_id=?').run('2026-10-02T12:00:00.000Z', thread.id));
  const route = `/messages/conversations/${thread.id}/messages`;
  const initial = await api(`${route}?limit=3`, 'GET', undefined, bob);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.items.map(item => item.id), sent.slice(6).map(item => item.id));
  assert.equal(initial.body.hasMore, true);
  const cursor = encodeURIComponent(initial.body.nextCursor);
  assert.equal((await api(`${route}?limit=3&before=${cursor}`, 'GET', undefined, alice)).status, 400);
  const other = await conversation(bob, charlie);
  assert.equal((await api(`/messages/conversations/${other.id}/messages?before=${cursor}`, 'GET', undefined, bob)).status, 400);
  await restart();
  const complete = initial.body.items.map(item => item.id);
  let next = initial.body.nextCursor;
  while (next) {
    const older = await api(`${route}?limit=3&before=${encodeURIComponent(next)}`, 'GET', undefined, bob);
    assert.equal(older.status, 200, JSON.stringify(older));
    complete.unshift(...older.body.items.map(item => item.id));
    next = older.body.nextCursor;
  }
  assert.deepEqual(complete, sent.map(item => item.id));
  assert.equal(new Set(complete).size, sent.length);
  const byId = await api(`${route}?before=${sent[3].id}&limit=3`, 'GET', undefined, bob);
  assert.deepEqual(byId.body.items.map(item => item.id), sent.slice(0, 3).map(item => item.id));
  const after = await api(`${route}?after=${sent[2].id}&limit=2`, 'GET', undefined, bob);
  assert.deepEqual(after.body.items.map(item => item.id), sent.slice(3, 5).map(item => item.id));
  const polled = after.body.items.map(item => item.id);
  let forward = after.body.nextCursor;
  while (forward) {
    const result = await api(`${route}?after=${encodeURIComponent(forward)}&limit=2`, 'GET', undefined, bob);
    assert.equal(result.status, 200);
    polled.push(...result.body.items.map(item => item.id));
    forward = result.body.nextCursor;
  }
  assert.deepEqual(polled, sent.slice(3).map(item => item.id));
  assert.equal((await api(`${route}?before=${sent[1].id}&after=${sent[0].id}`, 'GET', undefined, bob)).status, 400);
  assert.equal((await api(`${route}?before=invalid`, 'GET', undefined, bob)).status, 400);
  assert.equal((await api(`${route}?limit=0`, 'GET', undefined, bob)).status, 400);
  assert.equal((await api(`${route}?before=0`, 'GET', undefined, bob)).status, 400);
  const firstArrivals = await api(`${route}?after=0&limit=3`, 'GET', undefined, bob);
  assert.equal(firstArrivals.status, 200);
  assert.deepEqual(firstArrivals.body.items.map(item => item.id), sent.slice(0, 3).map(item => item.id));
  assert.equal((await api(`${route}?after=0`, 'GET', undefined, charlie)).status, 404);
  // An empty browser chat may receive a backlog while its tab is hidden. Polling
  // from zero must return the earliest arrivals, rather than silently lose >50.
  for (let index = 9; index < 60; index++) sent.push(await message(thread.id, index % 2 ? bob : alice, `隐藏标签页期间的到达 ${index}`));
  database(db => db.prepare('UPDATE community_messages SET created_at=? WHERE conversation_id=?').run('2026-10-02T12:00:00.000Z', thread.id));
  const backlog = await api(`${route}?after=0&limit=50`, 'GET', undefined, bob);
  assert.equal(backlog.status, 200);
  assert.deepEqual(backlog.body.items.map(item => item.id), sent.slice(0, 50).map(item => item.id));
  assert.equal(backlog.body.hasMore, true);
  const remaining = await api(`${route}?after=${encodeURIComponent(backlog.body.nextCursor)}&limit=50`, 'GET', undefined, bob);
  assert.equal(remaining.status, 200);
  assert.deepEqual(remaining.body.items.map(item => item.id), sent.slice(50).map(item => item.id));
  assert.equal(remaining.body.hasMore, false);
  assert.deepEqual([...backlog.body.items, ...remaining.body.items].map(item => item.sequence), Array.from({ length: 60 }, (_, index) => index + 1));
});

test('conversation lists paginate recent activity, aggregate unread and exclude unrelated private threads', async t => {
  const { api, alice, bob, charlie, conversation, message } = await fixture(t);
  const first = await conversation(alice, bob);
  const second = await conversation(alice, charlie);
  const unrelated = await conversation(bob, charlie);
  await message(first.id, alice, '第一段活动');
  const received = await message(second.id, charlie, '待读取的另一段会话');
  const latest = await message(first.id, bob, '最新活动');
  await message(unrelated.id, charlie, '其他人的会话');
  const initial = await api('/messages/conversations?limit=1', 'GET', undefined, alice);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.unreadCount, 2);
  assert.equal(initial.body.items[0].id, first.id);
  assert.equal(initial.body.items[0].lastMessage.id, latest.id);
  assert.equal(initial.body.hasMore, true);
  const cursor = encodeURIComponent(initial.body.nextCursor);
  assert.equal((await api(`/messages/conversations?cursor=${cursor}`, 'GET', undefined, bob)).status, 400);
  const page = await api(`/messages/conversations?limit=1&cursor=${cursor}`, 'GET', undefined, alice);
  assert.equal(page.status, 200);
  assert.equal(page.body.items[0].id, second.id);
  assert.equal(page.body.unreadCount, 2);
  assert.equal(page.body.hasMore, false);
  assert.equal(page.body.nextCursor, null);
  assertPublicDto(page.body);
  const acknowledged = await api(`/messages/conversations/${second.id}/read`, 'PUT', { lastMessageId: received.id }, alice);
  assert.equal(acknowledged.body.conversationUnreadCount, 0);
  assert.equal(acknowledged.body.unreadCount, 1);
  assert.equal((await api('/messages/conversations?cursor=invalid', 'GET', undefined, alice)).status, 400);
});

test('account export includes only authorized private conversations and removal revokes both participants history', async t => {
  const { api, alice, bob, charlie, database, conversation, message } = await fixture(t);
  const together = await conversation();
  const first = await message(together.id, alice, '导出自己的私信');
  const second = await message(together.id, bob, '同一会话的回复');
  const other = await conversation(bob, charlie);
  await message(other.id, charlie, '不属于导出人的秘密');
  const exported = await api('/api/export', 'GET', undefined, alice);
  assert.equal(exported.status, 200);
  const privateMessages = exported.body.community.privateMessages;
  assert.equal(privateMessages.conversations.length, 1);
  assert.equal(privateMessages.conversations[0].id, together.id);
  assert.deepEqual(privateMessages.conversations[0].messages.map(item => item.id), [first.id, second.id]);
  assert.equal(JSON.stringify(privateMessages).includes('不属于导出人的秘密'), false);
  assertPublicDto(privateMessages);
  assert.equal((await api('/api/account', 'DELETE', { password: PASSWORD }, alice)).status, 200);
  assert.equal((await api('/messages/conversations', 'GET', undefined, alice)).status, 401);
  assert.equal((await api(`/messages/conversations/${together.id}/messages`, 'GET', undefined, bob)).status, 404);
  const remaining = (await api('/messages/conversations', 'GET', undefined, bob)).body.items;
  assert.deepEqual(remaining.map(item => item.id), [other.id]);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_messages WHERE conversation_id=?').get(together.id).count), 0);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_accounts WHERE user_id=?').get(alice.id).count), 0);
  assert.deepEqual(database(db => db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('private message writes recheck a deleted recipient after an incomplete request body arrives', async t => {
  const { api, alice, bob, database, beginJson, conversation } = await fixture(t);
  const thread = await conversation();
  const pendingSend = beginJson(`/messages/conversations/${thread.id}/messages`, 'POST', { body: '收件人注销期间不能发送', clientMutationId: 'slow-message' }, alice);
  const pendingOpen = beginJson('/messages/conversations', 'POST', { userId: bob.id }, alice);
  await Promise.all([pendingSend.started, pendingOpen.started]);
  assert.equal((await api('/api/account', 'DELETE', { password: PASSWORD }, bob)).status, 200);
  assert.equal((await pendingSend.finish()).status, 404);
  assert.equal((await pendingOpen.finish()).status, 404);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_messages').get().count), 0);
  assert.equal(database(db => db.prepare('SELECT COUNT(*) AS count FROM community_conversations').get().count), 0);
  assert.deepEqual(database(db => db.prepare('PRAGMA foreign_key_check').all()), []);
});
