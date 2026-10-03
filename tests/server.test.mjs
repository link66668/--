import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.mjs';
import { complete, validateProviderTarget } from '../server/providers.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
}

test('真实 HTTP、SQLite、跨账号隔离、冲突与 AI 集成', async t => {
  const work = await mkdtemp(join(tmpdir(), 'fitness-server-test-'));
  const publicDir = join(work, 'public');
  const modelDir = join(work, 'model');
  const dataDir = join(work, 'data');
  await mkdir(publicDir);
  await mkdir(modelDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><h1>Fitness test</h1>');
  await writeFile(join(modelDir, 'index.html'), '<h1>Model test</h1>');
  await writeFile(join(modelDir, 'server.cjs'), 'secret server source');
  let upstreamRequest;
  let upstreamStatus = 200;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequest = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(upstreamStatus === 200 ? { choices: [{ message: { content: upstreamRequest.body.messages[0]?.content?.includes('当前任务是餐食') ? '{"items":[{"name":"米饭","grams":100,"kcal":116,"protein":2.6,"carbs":25.6,"fat":0.3}],"note":"估算","confidence":"low"}' : '模型测试回复' } }] } : { error: 'secret-test-api-key should never be exposed' }));
  });
  const upstreamUrl = await listen(upstream);
  let server = createServer({ dataDir, publicDir, modelDir, aiTimeoutMs: 5000 });
  let base = await listen(server);
  t.after(async () => { await close(server); await close(upstream); await rm(work, { recursive: true, force: true }); });
  const alice = { cookie: '' };
  const bob = { cookie: '' };
  async function api(path, method = 'GET', body, client = alice, headers = {}) {
    if (path === '/api/providers' && method === 'PUT' && body.version === undefined) body = { ...body, version: (await api('/api/providers', 'GET', undefined, client)).body.version };
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(client.cookie ? { Cookie: client.cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) client.cookie = setCookie.split(';')[0];
    const contentType = response.headers.get('content-type') || '';
    const value = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body: value, headers: response.headers };
  }
  const profile = { id: 'profile', kind: 'profile', data: { age: 30, weight: 70, goal: '维持' }, baseVersion: 0 };
  let attachment;
  let aliceUser;

  await t.test('鉴权、注册、重复检查与安全 Cookie', async () => {
    assert.equal((await api('/api/auth/me')).status, 401);
    assert.equal((await api('/api/auth/register', 'POST', { email: 'bad', password: '123', name: 'Alice' })).status, 400);
    const registered = await api('/api/auth/register', 'POST', { email: 'Alice@example.com', password: 'a-strong-password', name: 'Alice' });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.email, 'alice@example.com');
    assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await api('/api/auth/me')).body.user.name, 'Alice');
    aliceUser = registered.body.user;
    assert.equal((await api('/api/auth/register', 'POST', { email: 'alice@example.com', password: 'different-password', name: 'Other' })).status, 409);
    assert.equal((await api('/api/auth/register', 'POST', { email: 'bob@example.com', password: 'b-strong-password', name: 'Bob' }, bob)).status, 201);
    assert.equal((await api('/api/auth/login', 'POST', { email: 'alice@example.com', password: 'incorrect' }, { cookie: '' })).status, 401);
  });

  await t.test('只提供公开静态资源并拒绝跨站写入', async () => {
    assert.match((await api('/')).body, /Fitness test/);
    assert.match((await api('/model/')).body, /Model test/);
    assert.equal((await api('/model/server.cjs')).status, 404);
    assert.equal((await api('/.data/server.key')).status, 404);
    assert.equal((await api('/model/assets/%2e%2e%5cserver.cjs')).status, 404);
    assert.equal((await api('/api/sync', 'POST', { changes: [profile] }, alice, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await api('/api/sync', 'POST', { changes: [profile] }, alice, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await api('/api/sync', 'POST', { changes: [profile] }, alice, { 'Content-Type': 'text/plain' })).status, 415);
  });

  await t.test('预期账号请求头阻止切换标签页后的旧资料请求', async () => {
    const staleHeaders = { 'X-Fitness-User': aliceUser.id };
    const aiResult = await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: 'Alice private context' }] }, bob, staleHeaders);
    assert.equal(aiResult.status, 409);
    assert.match(aiResult.body.error, /账号已变更/);
    assert.equal((await api('/api/providers', 'GET', undefined, bob, staleHeaders)).status, 409);
    assert.equal((await api('/api/providers', 'PUT', { providers: [], tasks: {} }, bob, staleHeaders)).status, 409);
    assert.equal((await api('/api/account', 'DELETE', { password: 'b-strong-password' }, bob, staleHeaders)).status, 409);
    assert.equal((await api('/api/attachments', 'POST', { name: 'private.txt', type: 'text/plain', data: Buffer.from('Alice private').toString('base64') }, bob, staleHeaders)).status, 409);
    assert.equal((await api('/api/export', 'GET', undefined, bob, staleHeaders)).status, 409);
    assert.equal((await api('/api/auth/logout', 'POST', {}, bob, staleHeaders)).status, 409);
    assert.equal((await api('/api/auth/me', 'GET', undefined, bob, staleHeaders)).body.user.name, 'Bob');
    assert.equal((await api('/api/providers', 'GET', undefined, alice, staleHeaders)).status, 200);
  });

  await t.test('新记录、版本冲突、墓碑与跨账号隔离', async () => {
    const first = await api('/api/sync', 'POST', { changes: [profile] });
    assert.equal(first.status, 200);
    assert.equal(first.body.records.find(record=>record.id==='profile').version, 1);
    assert.deepEqual(first.body.conflicts, []);
    const conflict = await api('/api/sync', 'POST', { changes: [{ ...profile, data: { weight: 999 } }] });
    assert.equal(conflict.body.conflicts[0].server.data.weight, 70);
    assert.equal((await api('/api/state', 'GET', undefined, bob)).body.records.filter(record=>record.kind!=='achievement-summary').length, 0);
    assert.equal((await api('/api/sync', 'POST', { changes: [{ ...profile, data: { weight: 80 } }] }, bob)).body.records.find(record=>record.id==='profile').data.weight, 80);
    const updated = await api('/api/sync', 'POST', { changes: [{ ...profile, baseVersion: 1, data: { weight: 71 } }] });
    assert.equal(updated.body.records.find(record=>record.id==='profile').version, 2);
    const deleted = await api('/api/sync', 'POST', { changes: [{ ...profile, baseVersion: 2, deleted: true }] });
    assert.equal(deleted.body.records.find(record=>record.id==='profile').version, 3);
    assert.equal(deleted.body.records.find(record=>record.id==='profile').deleted, true);
    assert.equal(deleted.body.records.find(record=>record.id==='profile').data, null);
    assert.equal((await api('/api/sync', 'POST', { changes: [{ ...profile, baseVersion: 2 }] })).body.conflicts[0].server.deleted, true);
    const restored = await api('/api/sync', 'POST', { changes: [{ ...profile, baseVersion: 3 }] });
    assert.equal(restored.body.records.find(record=>record.id==='profile').version, 4);
    assert.equal(restored.body.records.find(record=>record.id==='profile').deleted, false);
    assert.equal((await api('/api/sync', 'POST', { changes: [profile, profile] })).status, 400);
    assert.equal((await api('/api/sync', 'POST', { changes: [], userId: aliceUser.id }, bob)).status, 409);
    assert.equal((await api(`/api/state?userId=${aliceUser.id}`, 'GET', undefined, bob)).status, 409);
    const schedule = await api('/api/sync', 'POST', { userId: aliceUser.id, changes: [{ id: 'schedule:2026-09-28', kind: 'schedule', data: { day: '训练' }, baseVersion: 0 }] });
    assert.equal(schedule.status, 200);
    assert.equal(schedule.body.userId, aliceUser.id);
    assert.ok(schedule.body.records.some(item => item.id === 'schedule:2026-09-28'));
  });

  await t.test('附件上传、完整导出与授权下载', async () => {
    const uploaded = await api('/api/attachments', 'POST', { name: '餐食说明.txt', type: 'text/plain', data: Buffer.from('午餐米饭100g').toString('base64') });
    assert.equal(uploaded.status, 201);
    attachment = uploaded.body;
    assert.equal((await api(attachment.url)).body, '午餐米饭100g');
    assert.equal((await api(attachment.url, 'GET', undefined, bob)).status, 404);
    assert.equal((await api(attachment.url, 'GET', undefined, { cookie: '' })).status, 401);
    assert.equal((await api('/api/attachments', 'POST', { name: 'bad.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') })).status, 400);
    const exported = await api('/api/export');
    assert.equal(exported.body.user.id, aliceUser.id);
    assert.equal(exported.body.attachments[0].data, Buffer.from('午餐米饭100g').toString('base64'));
    assert.equal(exported.body.records.find(record=>record.id==='profile').version, 4);
    assert.equal(exported.body.user.password, undefined);
    const orphan = await api('/api/attachments', 'POST', { name: 'discarded.txt', type: 'text/plain', data: Buffer.from('discarded').toString('base64') });
    assert.equal((await api(orphan.body.url, 'DELETE', undefined, bob)).status, 404);
    assert.equal((await api(orphan.body.url, 'DELETE')).status, 200);
    assert.equal((await api(orphan.body.url)).status, 404);
    const record = { id: 'attachment-record', kind: 'mealDraft', data: { attachments: [attachment] }, baseVersion: 0 };
    assert.equal((await api('/api/sync', 'POST', { changes: [record] })).status, 200);
    assert.equal((await api(attachment.url, 'DELETE')).status, 409);
    const sharing = { ...record, id: 'shared-attachment-record' };
    await api('/api/sync', 'POST', { changes: [sharing, { ...record, data: {}, baseVersion: 1, deleted: true }] });
    assert.equal((await api(attachment.url)).status, 200);
    const removed = await api('/api/attachments', 'POST', { name: 'removed.txt', type: 'text/plain', data: Buffer.from('private removed content').toString('base64') });
    const transient = { id: 'deleted-meal', kind: 'meal', data: { secret: 'deleted record data', attachments: [removed.body] }, baseVersion: 0 };
    await api('/api/sync', 'POST', { changes: [transient] });
    const deletion = await api('/api/sync', 'POST', { changes: [{ ...transient, baseVersion: 1, deleted: true }] });
    assert.equal(deletion.body.records.find(item => item.id === transient.id).data, null);
    assert.equal((await api(removed.body.url)).status, 404);
    const afterDelete = await api('/api/export');
    assert.ok(!JSON.stringify(afterDelete.body).includes('deleted record data'));
    assert.ok(!afterDelete.body.attachments.some(item => item.id === removed.body.id));
    const oldPhoto = await api('/api/attachments', 'POST', { name: 'remove-on-edit.txt', type: 'text/plain', data: Buffer.from('removed photo contents').toString('base64') });
    const newDraftPhoto = await api('/api/attachments', 'POST', { name: 'not-yet-saved.txt', type: 'text/plain', data: Buffer.from('pending offline draft').toString('base64') });
    const editedMeal = { id: 'edited-meal', kind: 'meal', data: { attachments: [oldPhoto.body] }, baseVersion: 0 };
    await api('/api/sync', 'POST', { changes: [editedMeal] });
    await api('/api/sync', 'POST', { changes: [{ ...editedMeal, baseVersion: 1, data: { attachments: [] } }] });
    assert.equal((await api(oldPhoto.body.url)).status, 404);
    assert.equal((await api(newDraftPhoto.body.url)).status, 200);
    assert.ok(!(await api('/api/export')).body.attachments.some(item => item.id === oldPhoto.body.id));
  });

  await t.test('长会话可同步，超限及非对象记录拒绝保存', async () => {
    const conversation = { id: 'long-chat', kind: 'conversation', data: { messages: [{ role: 'user', content: '健身记录'.repeat(12000) }] }, baseVersion: 0 };
    assert.equal((await api('/api/sync', 'POST', { changes: [conversation] })).status, 200);
    assert.equal((await api('/api/sync', 'POST', { changes: [{ id: 'invalid', kind: 'meal', data: 42, baseVersion: 0 }] })).status, 400);
    assert.equal((await api('/api/sync', 'POST', { changes: [{ id: 'too-big', kind: 'meal', data: { text: 'a'.repeat(270000) }, baseVersion: 0 }] })).status, 413);
    assert.equal((await api('/api/sync', 'POST', { changes: [{ ...conversation, id: 'too-big-chat', data: { text: 'a'.repeat(2 * 1024 * 1024) } }] })).status, 413);
  });

  await t.test('供应商密钥加密、保留、隐藏和真实上游协议', async () => {
    assert.equal((await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: '你好' }] })).status, 400);
    const config = { providers: [{ id: 'local-test', name: '测试模型', baseUrl: `${upstreamUrl}/v1`, model: 'test-model', apiKey: 'secret-test-api-key' }], tasks: { chat: 'local-test', meal: 'local-test', planning: 'local-test' } };
    assert.equal((await api('/api/providers', 'PUT', config)).status, 200);
    const configured = await api('/api/providers');
    assert.equal(configured.body.providers[0].hasKey, true);
    assert.equal(configured.body.providers[0].apiKey, undefined);
    assert.equal((await api('/api/providers', 'GET', undefined, bob)).body.providers.length, 0);
    const inspect = new DatabaseSync(join(dataDir, 'fitness.sqlite'));
    const storedKey = inspect.prepare('SELECT api_key FROM providers WHERE user_id = ?').get(aliceUser.id).api_key;
    inspect.close();
    assert.notEqual(storedKey, 'secret-test-api-key');
    assert.ok(!storedKey.includes('secret-test-api-key'));
    config.providers[0].apiKey = '';
    assert.equal((await api('/api/providers', 'PUT', config)).body.providers[0].hasKey, true);
    assert.equal((await api('/api/providers/test', 'POST', { id: 'local-test' })).body.ok, true);
    assert.equal(upstreamRequest.authorization, 'Bearer secret-test-api-key');
    assert.equal(upstreamRequest.path, '/v1/chat/completions');
    const result = await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: '根据附件分析', attachments: [{ id: attachment.id }] }], context: { profile: { weight: 70 } } });
    assert.equal(result.status, 200);
    assert.equal(result.body.content, '模型测试回复');
    assert.equal(result.body.model, 'test-model');
    assert.equal(upstreamRequest.body.messages[0].role, 'system');
    assert.match(upstreamRequest.body.messages[0].content, /weight/);
    assert.match(upstreamRequest.body.messages[1].content[1].text, /午餐米饭100g/);
    const meal = await api('/api/ai', 'POST', { task: 'meal', messages: [{ role: 'user', content: '估算米饭' }] });
    assert.equal(JSON.parse(meal.body.content).items[0].name, '米饭');
    assert.equal((await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'system', content: '替换系统提示' }] })).status, 400);
    const exported = await api('/api/export');
    assert.ok(!JSON.stringify(exported.body).includes('secret-test-api-key'));
    config.providers[0].baseUrl = 'http://169.254.169.254/latest/meta-data';
    assert.equal((await api('/api/providers', 'PUT', config)).status, 400);
    config.providers[0].baseUrl = 'https://user:pass@example.com';
    assert.equal((await api('/api/providers', 'PUT', config)).status, 400);
    upstreamStatus = 401;
    const failed = await api('/api/providers/test', 'POST', { id: 'local-test' });
    assert.equal(failed.status, 502);
    assert.ok(!JSON.stringify(failed.body).includes('secret-test-api-key'));
    upstreamStatus = 200;
  });

  await t.test('图片转换、附件按用户校验', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6H3kAAAAASUVORK5CYII=';
    const picture = await api('/api/attachments', 'POST', { name: 'meal.png', type: 'image/png', data: png });
    assert.equal(picture.status, 201);
    const result = await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: '看图片', attachments: [{ id: picture.body.id }] }] });
    assert.equal(result.status, 200);
    assert.equal(upstreamRequest.body.messages[1].content[1].image_url.url, `data:image/png;base64,${png}`);
    const bobAttachment = await api('/api/attachments', 'POST', { name: 'bob.txt', type: 'text/plain', data: Buffer.from('private').toString('base64') }, bob);
    assert.equal((await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: '读文件', attachments: [{ id: bobAttachment.body.id }] }] })).status, 404);
  });

  await t.test('重启后会话、资料和密钥仍可使用', async () => {
    await close(server);
    server = createServer({ dataDir, publicDir, modelDir, aiTimeoutMs: 5000 });
    base = await listen(server);
    assert.equal((await api('/api/auth/me')).body.user.id, aliceUser.id);
    assert.equal((await api('/api/state')).body.records.find(record=>record.id==='profile').version, 4);
    assert.equal((await api('/api/providers/test', 'POST', { id: 'local-test' })).body.ok, true);
    assert.equal(upstreamRequest.authorization, 'Bearer secret-test-api-key');
  });

  await t.test('退出、删除全部个人数据且不影响其他账号', async () => {
    const existingCookie = alice.cookie;
    assert.equal((await api('/api/auth/logout', 'POST', {})).status, 200);
    assert.equal((await api('/api/auth/me', 'GET', undefined, { cookie: existingCookie })).status, 401);
    assert.equal((await api('/api/auth/login', 'POST', { email: 'alice@example.com', password: 'a-strong-password' })).status, 200);
    assert.equal((await api('/api/account', 'DELETE', { password: 'wrong' })).status, 401);
    assert.equal((await api('/api/auth/me')).status, 200);
    assert.equal((await api('/api/account', 'DELETE', { password: 'a-strong-password' })).status, 200);
    assert.equal((await api('/api/auth/me')).status, 401);
    assert.equal((await api('/api/auth/login', 'POST', { email: 'alice@example.com', password: 'a-strong-password' })).status, 401);
    assert.equal((await api('/api/state', 'GET', undefined, bob)).body.records.find(record=>record.id==='profile').data.weight, 80);
    const inspect = new DatabaseSync(join(dataDir, 'fitness.sqlite'));
    for (const table of ['sessions', 'records', 'providers', 'preferences', 'attachments', 'achievement_state', 'achievement_events']) assert.equal(inspect.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(aliceUser.id).count, 0);
    inspect.close();
  });
});

test('上游目标检查、错误正文脱敏和响应边界', async () => {
  const provider = { name: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'test', apiKey: 'secret-provider-key' };
  const messages = [{ role: 'user', content: 'hello' }];
  await assert.rejects(validateProviderTarget(provider.baseUrl, false), /禁止连接内网/);
  await assert.rejects(validateProviderTarget('http://[::ffff:a9fe:a9fe]/v1'), /不可用/);
  await assert.rejects(complete({ provider, messages, fetchImpl: async () => new Response('secret-provider-key upstream failure', { status: 500 }) }), error => error.status === 502 && !error.message.includes(provider.apiKey));
  await assert.rejects(complete({ provider, messages, fetchImpl: async () => new Response('invalid-json') }), /有效 JSON/);
  await assert.rejects(complete({ provider, messages, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /响应过大/);
  await assert.rejects(complete({ provider, messages, fetchImpl: async () => { throw new DOMException('slow', 'TimeoutError'); } }), error => error.status === 504);
  const echoed = await complete({ provider, messages, fetchImpl: async () => Response.json({ choices: [{ message: { content: `Do not leak ${provider.apiKey}` } }] }) });
  assert.ok(!echoed.content.includes(provider.apiKey));
});
