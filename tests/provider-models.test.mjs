import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server.mjs';
import { openStore, getProviders } from '../server/storage.mjs';
import { complete, discoverModels, validateProvider, buildMessages } from '../server/providers.mjs';
import { getProviderPreset } from '../public/provider-presets.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server?.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
}

test('模型发现仅需预设和密钥，保存多模型并按任务路由', async t => {
  const work = await mkdtemp(join(tmpdir(), 'fitness-provider-api-'));
  const requests = [];
  let upstreamStatus = 200;
  const server = createServer({ dataDir: work, fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    requests.push({ url, ...options, body });
    if (upstreamStatus !== 200) return new Response('private-api-key upstream diagnostic', { status: upstreamStatus });
    if (options.method === 'GET') return Response.json({ data: [{ id: 'chat-a' }, { id: 'org/vision-b', architecture: { input_modalities: ['text', 'image'] } }, { id: 'planner-c' }] });
    return Response.json({ choices: [{ message: { content: `reply ${body.model}`, reasoning_content: 'private-api-key reasoning' } }] });
  } });
  const base = await listen(server);
  t.after(async () => { await close(server); await rm(work, { recursive: true, force: true }); });
  let cookie = '';
  async function api(path, method = 'GET', body) {
    if (path === '/api/providers' && method === 'PUT' && body.version === undefined) body = { ...body, version: (await api('/api/providers')).body.version };
    const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  await api('/api/auth/register', 'POST', { email: 'models@example.com', name: 'Models', password: 'strong-password' });
  const key = 'private-api-key';
  await t.test('预设默认补齐地址协议，获取列表不保存密钥', async () => {
    const result = await api('/api/providers/models', 'POST', { provider: { presetId: 'openai', apiKey: key } });
    assert.equal(result.status, 200);
    assert.equal(result.body.models.length, 3);
    assert.equal(result.body.models.find(item => item.id === 'chat-a').vision, null);
    assert.equal(result.body.models.find(item => item.id === 'org/vision-b').vision, true);
    assert.equal(requests.at(-1).url, `${getProviderPreset('openai').baseUrl}/models`);
    assert.equal(requests.at(-1).headers.Authorization, `Bearer ${key}`);
    assert.deepEqual((await api('/api/providers')).body.providers, []);
    assert.ok(!JSON.stringify(result.body).includes(key));
  });
  const provider = { id: 'primary', presetId: 'openai', apiKey: key, models: [{ id: 'chat-a' }, { id: 'org/vision-b', vision: true }, { id: 'planner-c' }] };
  const tasks = { chat: 'primary', meal: 'primary', planning: 'primary' };
  const taskModels = { chat: 'chat-a', meal: 'org/vision-b', planning: 'planner-c' };
  await t.test('同一供应商三任务各自选择模型，推理上下文往返', async () => {
    const result = await api('/api/providers', 'PUT', { providers: [provider], tasks, taskModels });
    assert.equal(result.status, 200);
    assert.equal(result.body.providers[0].hasKey, true);
    assert.equal(result.body.providers[0].apiKey, undefined);
    assert.deepEqual(result.body.taskModels, taskModels);
    for (const task of Object.keys(tasks)) {
      const answer = await api('/api/ai', 'POST', { task, messages: [{ role: 'assistant', content: 'previous', reasoningContent: 'previous reasoning' }, { role: 'user', content: '继续' }] });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.model, taskModels[task]);
      assert.equal(requests.at(-1).body.model, taskModels[task]);
      assert.equal(requests.at(-1).body.messages[1].reasoning_content, 'previous reasoning');
      assert.equal(answer.body.reasoningContent, '[密钥已隐藏] reasoning');
    }
    const invalid = await api('/api/providers', 'PUT', { providers: [provider], tasks, taskModels: { ...taskModels, meal: 'not-enabled' } });
    assert.equal(invalid.status, 400);
    const invalidReasoning = await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: 'x', reasoningContent: 'untrusted' }] });
    assert.equal(invalidReasoning.status, 400);
  });
  await t.test('空密钥保留且已保存配置可发现和测试指定模型', async () => {
    assert.equal((await api('/api/providers', 'PUT', { providers: [{ id: 'primary', apiKey: '' }] })).status, 200);
    assert.equal((await api('/api/providers/models', 'POST', { id: 'primary' })).status, 200);
    assert.equal(requests.at(-1).headers.Authorization, `Bearer ${key}`);
    assert.equal((await api('/api/providers/test', 'POST', { id: 'primary', model: 'org/vision-b' })).status, 200);
    assert.equal(requests.at(-1).body.model, 'org/vision-b');
    assert.equal((await api('/api/providers/test', 'POST', { id: 'primary', model: 'not-enabled' })).status, 400);
    for (const path of ['/api/providers/models', '/api/providers/test', '/api/providers']) {
      const changed = { id: 'primary', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' };
      const result = await api(path, path === '/api/providers' ? 'PUT' : 'POST', path === '/api/providers' ? { providers: [changed] } : { provider: changed });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /重新填写/);
    }
    upstreamStatus = 401;
    const denied = await api('/api/providers/models', 'POST', { id: 'primary' });
    assert.equal(denied.status, 502);
    assert.match(denied.body.error, /认证/);
    assert.ok(!JSON.stringify(denied.body).includes(key));
    upstreamStatus = 200;
  });
  await t.test('可以仅保存密钥，空模型与空任务给出清晰错误', async () => {
    const empty = await api('/api/providers', 'PUT', { providers: [{ id: 'primary', models: [] }], tasks, taskModels: { chat: '', meal: '', planning: '' } });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.providers[0].hasKey, true);
    assert.deepEqual(empty.body.providers[0].models, []);
    assert.equal((await api('/api/providers/test', 'POST', { id: 'primary' })).status, 400);
    const result = await api('/api/ai', 'POST', { task: 'chat', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /选择模型/);
    const clear = await api('/api/providers', 'PUT', { providers: [{ id: 'primary', baseUrl: 'http://127.0.0.1:1/v1', clearKey: true }] });
    assert.equal(clear.status, 200);
    assert.equal(clear.body.providers[0].hasKey, false);
  });
});

test('三个协议的真实 HTTP 鉴权、分页及多模态请求转换', async t => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { url: new URL(req.url, 'http://localhost'), headers: req.headers, method: req.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined };
    requests.push(request);
    let payload;
    if (req.method === 'GET' && req.url.startsWith('/anthropic/')) payload = request.url.searchParams.has('after_id') ? { data: [{ id: 'claude-b', display_name: 'Claude B', capabilities: { image_input: { supported: true } } }], has_more: false } : { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' };
    else if (req.method === 'GET' && req.url.startsWith('/gemini/')) payload = request.url.searchParams.has('pageToken') ? { models: [{ name: 'models/gemini-b', displayName: 'Gemini B', supportedGenerationMethods: ['generateContent'] }] } : { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next+/=' };
    else if (req.method === 'GET') payload = { data: [{ id: 'org/chat' }] };
    else if (req.url.endsWith('/messages')) payload = { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'anthropic reply' }] };
    else if (req.url.includes(':generateContent')) payload = { candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'gemini reply' }] } }] };
    else payload = { choices: [{ message: { content: 'openai reply' } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const base = await listen(upstream);
  t.after(() => close(upstream));
  const messages = [{ role: 'system', content: 'system text' }, { role: 'assistant', content: 'previous' }, { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }, { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,cGRm' } }] }];
  for (const protocol of ['openai', 'anthropic', 'gemini']) {
    await t.test(protocol, async () => {
      const provider = { id: protocol, name: protocol, protocol, baseUrl: `${base}/${protocol}/v1`, model: protocol === 'openai' ? 'org/chat' : `${protocol}-a`, apiKey: 'protocol-secret' };
      const result = await discoverModels({ provider });
      assert.equal(result.truncated, false);
      assert.equal(result.models.length, protocol === 'openai' ? 1 : 2);
      const listRequests = requests.filter(request => request.method === 'GET' && request.url.pathname.includes(protocol));
      assert.equal(listRequests.length, protocol === 'openai' ? 1 : 2);
      for (const request of listRequests) {
        assert.ok(!request.url.href.includes(provider.apiKey));
        if (protocol === 'openai') assert.equal(request.headers.authorization, 'Bearer protocol-secret');
        if (protocol === 'anthropic') { assert.equal(request.headers['x-api-key'], provider.apiKey); assert.equal(request.headers['anthropic-version'], '2023-06-01'); }
        if (protocol === 'gemini') assert.equal(request.headers['x-goog-api-key'], provider.apiKey);
      }
      if (protocol === 'anthropic') { assert.equal(listRequests[1].url.searchParams.get('after_id'), 'claude-a'); assert.equal(result.models[1].vision, true); }
      if (protocol === 'gemini') { assert.equal(listRequests[1].url.searchParams.get('pageToken'), 'next+/='); assert.equal(result.models[0].id, 'gemini-a'); assert.equal(result.models[0].vision, null); }
      const answer = await complete({ provider, messages });
      assert.equal(answer.content, `${protocol} reply`);
      const sent = requests.at(-1);
      if (protocol === 'openai') { assert.equal(sent.body.model, 'org/chat'); assert.deepEqual(sent.body.messages, messages); }
      if (protocol === 'anthropic') {
        assert.equal(sent.url.pathname, '/anthropic/v1/messages');
        assert.equal(sent.body.system, 'system text');
        assert.equal(sent.body.messages[1].content[1].source.media_type, 'image/png');
        assert.equal(sent.body.messages[1].content[2].type, 'document');
        assert.equal(sent.body.max_tokens, 4096);
      }
      if (protocol === 'gemini') {
        assert.equal(sent.url.pathname, '/gemini/v1/models/gemini-a:generateContent');
        assert.equal(sent.body.systemInstruction.parts[0].text, 'system text');
        assert.equal(sent.body.contents[0].role, 'model');
        assert.equal(sent.body.contents[1].parts[1].inlineData.mimeType, 'image/png');
        assert.equal(sent.body.contents[1].parts[2].inlineData.mimeType, 'application/pdf');
      }
    });
  }
});

test('模型发现限制、空列表、安全错误及已知能力字段', async () => {
  const provider = { id: 'test', name: 'test', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'secret', protocol: 'anthropic' };
  let pages = 0;
  const capped = await discoverModels({ provider, fetchImpl: async () => Response.json({ data: [{ id: `page-${++pages}` }], has_more: true, last_id: String(pages) }) });
  assert.equal(pages, 10);
  assert.equal(capped.truncated, true);
  const empty = await discoverModels({ provider, fetchImpl: async () => Response.json({ data: [] }) });
  assert.deepEqual(empty, { models: [], truncated: false });
  const abilities = await discoverModels({ provider: { ...provider, protocol: 'openai' }, fetchImpl: async () => Response.json({ data: [{ id: 'unknown' }, { id: 'vision', capabilities: { vision: true, completion_chat: true } }, { id: 'kimi', supports_image_in: false }, { id: 'embedding', capabilities: { completion_chat: false } }] }) });
  assert.equal(abilities.models.length, 3);
  assert.equal(abilities.models.find(item => item.id === 'vision').vision, true);
  assert.equal(abilities.models.find(item => item.id === 'kimi').vision, false);
  assert.equal(abilities.models.find(item => item.id === 'unknown').vision, null);
  await assert.rejects(discoverModels({ provider, allowPrivateProviders: false, fetchImpl: async () => assert.fail('private host must not be called') }), /禁止连接内网/);
  await assert.rejects(discoverModels({ provider, fetchImpl: async () => new Response('secret', { status: 401 }) }), error => error.status === 502 && !error.message.includes('secret'));
  await assert.rejects(discoverModels({ provider, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /响应过大/);
  await assert.rejects(discoverModels({ provider, fetchImpl: async () => { throw new DOMException('secret', 'TimeoutError'); } }), error => error.status === 504 && !error.message.includes('secret'));
  const sanitized = await discoverModels({ provider, fetchImpl: async () => Response.json({ data: [{ id: 'secret', display_name: 'secret' }] }) });
  assert.ok(!JSON.stringify(sanitized).includes('secret'));
  assert.throws(() => validateProvider({ id: 'custom', baseUrl: 'https://example.com', models: [{ id: 'bad\nmodel' }] }), /模型 ID/);
  assert.throws(() => buildMessages({}, 'user', { task: 'chat', messages: [{ role: 'assistant', content: 'x', reasoningContent: 'x'.repeat(64001) }] }), /推理上下文/);
  for (const protocol of ['openai', 'anthropic', 'gemini']) {
    const payload = protocol === 'openai' ? { choices: [{ message: { content: [{ type: 'text', text: null }] } }] } : protocol === 'anthropic' ? { content: {} } : { candidates: [{ content: { parts: {} } }] };
    await assert.rejects(complete({ provider: { ...provider, protocol, model: 'test' }, messages: [{ role: 'user', content: 'test' }], fetchImpl: async () => Response.json(payload) }), error => error.status === 502 && /未返回可显示/.test(error.message));
  }
});

test('预设专用模型接口、百炼分页及能力归一化', async () => {
  const urls = [];
  for (const id of ['siliconflow', 'xai', 'dashscope-intl']) {
    const preset = getProviderPreset(id);
    assert.ok(preset?.modelsUrl, `${id} has a documented models URL`);
    const provider = validateProvider({ id, presetId: id, apiKey: 'preset-key' });
    const result = await discoverModels({ provider, fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      urls.push(endpoint);
      assert.equal(options.headers.Authorization, 'Bearer preset-key');
      if (id === 'siliconflow') return Response.json({ data: [{ id: 'org/model' }] });
      if (id === 'xai') return Response.json({ models: [{ id: 'grok-model', input_modalities: ['text', 'image'] }] });
      return Response.json({ output: { total: 101, models: [{ model: endpoint.searchParams.get('page_no') === '1' ? 'qwen-text' : 'qwen-vision', name: 'Qwen', inference_metadata: { request_modality: ['Text', 'Image'], response_modality: ['Text'] } }] } });
    } });
    assert.equal(result.truncated, false);
    if (id === 'siliconflow') assert.equal(urls.at(-1).searchParams.get('sub_type'), 'chat');
    if (id === 'xai') { assert.equal(urls.at(-1).pathname, '/v1/language-models'); assert.equal(result.models[0].vision, true); }
    if (id === 'dashscope-intl') { assert.equal(urls.at(-1).searchParams.get('page_no'), '2'); assert.equal(result.models.length, 2); assert.equal(result.models[1].vision, true); }
  }
});

test('旧数据库升级保留密钥、单模型和三任务绑定', async t => {
  const work = await mkdtemp(join(tmpdir(), 'fitness-provider-migration-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update('old-private-key'), cipher.final()]);
  const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  await writeFile(join(work, 'server.key'), key);
  const legacy = new DatabaseSync(join(work, 'fitness.sqlite'));
  legacy.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE providers (user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id,id)); CREATE TABLE preferences (user_id TEXT PRIMARY KEY REFERENCES users(id), tasks TEXT NOT NULL);");
  legacy.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('legacy-user', 'old@example.com', 'Old', 'password', 'now');
  legacy.prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)').run('legacy-user', 'old-ai', 'Old AI', 'https://example.com/v1', 'old/model', ciphertext);
  legacy.prepare('INSERT INTO preferences VALUES(?,?)').run('legacy-user', JSON.stringify({ chat: 'old-ai', meal: 'old-ai', planning: 'old-ai' }));
  legacy.close();
  const store = openStore(work);
  const settings = getProviders(store.db, 'legacy-user');
  assert.equal(settings.version, 1);
  assert.deepEqual(settings.providers[0].models, [{ id: 'old/model', name: 'old/model', vision: null }]);
  assert.equal(settings.providers[0].presetId, 'custom');
  assert.equal(settings.providers[0].protocol, 'openai');
  assert.deepEqual(settings.taskModels, { chat: 'old/model', meal: 'old/model', planning: 'old/model' });
  assert.equal(store.decrypt(store.db.prepare('SELECT api_key FROM providers').get().api_key), 'old-private-key');
  store.db.close();
  const reopened = openStore(work);
  assert.deepEqual(getProviders(reopened.db, 'legacy-user'), settings);
  reopened.db.close();
});
