// Browser regression for preset providers, model discovery and task routing.
// Uses fixture responses only; no real API key or paid model request is needed.
// Requires local Playwright. Override QA_PLAYWRIGHT / QA_BROWSER if necessary.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = join(root, '.qa');
await mkdir(qaRoot, { recursive: true });
const dataDir = await mkdtemp(join(qaRoot, 'providers-'));
const { chromium } = await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT || join(root, '精细模型与动作开发/node_modules/playwright/index.mjs'))).href);
const keys = ['qa-secret-deepseek-never-return-98671', 'qa-secret-openai-never-return-29783'];
const modelIds = ['qa-chat', 'qa-vision', 'qa-planner'];
const modelCalls = [], completionCalls = [], errors = [], unexpectedFailures = [];
let discoveryMode = 'success';
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, fetchImpl: async (url, options) => {
  const endpoint = new URL(url), headers = new Headers(options.headers);
  const authorization = headers.get('authorization');
  if (endpoint.pathname.endsWith('/models')) {
    modelCalls.push({ url: String(url), authorization });
    if (discoveryMode === 'error') return jsonResponse({ error: { message: `Fixture upstream error ${keys[0]}` } }, 401);
    if (discoveryMode === 'empty') return jsonResponse({ object: 'list', data: [] });
    return jsonResponse({ object: 'list', data: modelIds.map(id => ({ id, object: 'model', owned_by: 'qa-fixture' })) });
  }
  assert(endpoint.pathname.endsWith('/chat/completions'), `Unexpected provider request: ${endpoint.pathname}`);
  const body = JSON.parse(options.body);
  completionCalls.push({ url: String(url), authorization, model: body.model });
  return jsonResponse({ choices: [{ message: { content: `QA 模拟回复：${body.model}` } }] });
} });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 950 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.status() >= 400 && !response.url().endsWith('/api/auth/me') && !response.url().endsWith('/api/providers/models')) unexpectedFailures.push(`${response.status()} ${response.url()}`);
});
const submit = id => page.locator(`#${id} button[type="submit"],#${id} button:not([type])`).last().click();
const screenshot = name => page.screenshot({ path: join(dataDir, `${name}.png`), fullPage: true, style: '#toasts{visibility:hidden}' });
const settings = async () => {
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator('.nav [data-page="settings"]').click();
  await page.locator('[data-action="settings-tab"][data-tab="ai"]').click();
};
const config = async () => {
  const response = await context.request.get(`${base}/api/providers`);
  assert.equal(response.status(), 200);
  const text = await response.text();
  for (const key of keys) assert(!text.includes(key), 'Provider API returned a raw API key');
  return JSON.parse(text);
};
const discover = async () => {
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/providers/models') && response.request().method() === 'POST');
  await page.locator('[data-action="fetch-models"]').click();
  const response = await responsePromise;
  const text = await response.text();
  for (const key of keys) assert(!text.includes(key), 'Model discovery response returned a raw API key');
  await page.waitForFunction(() => !document.querySelector('[data-action="fetch-models"]')?.disabled);
  return { status: response.status(), body: JSON.parse(text) };
};
const addProvider = async (preset, key) => {
  await page.locator('#settings-content [data-action="provider"]').filter({ hasText: '添加' }).click();
  await page.locator('#provider-preset').selectOption(preset);
  await page.locator('#provider-key').fill(key);
  assert.equal(await page.locator('#provider-key').getAttribute('type'), 'password');
  const result = await discover();
  assert.equal(result.status, 200);
  assert.equal(await page.locator('input[name="enabled-model"]:checked').count(), 0, 'Fetched models should await user enablement');
  for (const model of modelIds) {
    const input = page.locator(`input[name="enabled-model"][value="${model}"]`);
    await input.waitFor();
    await input.check();
  }
  await page.locator('#provider-model').selectOption(modelIds[0]);
};
const editProvider = id => page.locator(`.provider-card [data-action="provider"][data-id="${id}"]`).click();
const assertSaveButtonVisible = async () => {
  const bounds = await page.locator('#provider-form button[type="submit"]').evaluate(button => {
    const rect = button.getBoundingClientRect(), dialog = button.closest('dialog').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, dialogTop: dialog.top, dialogBottom: dialog.bottom, viewport: innerHeight };
  });
  assert(bounds.top >= bounds.dialogTop && bounds.bottom <= Math.min(bounds.dialogBottom, bounds.viewport), `Provider save button is clipped: ${JSON.stringify(bounds)}`);
};
const noStoredKeys = async () => {
  const browserStorage = await page.evaluate(async () => {
    const local = Object.fromEntries(Object.entries(localStorage));
    const session = Object.fromEntries(Object.entries(sessionStorage));
    const accounts = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fitness-assistant-v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('accounts').objectStore('accounts').getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
    return JSON.stringify({ local, session, accounts });
  });
  const body = await page.locator('body').textContent();
  for (const key of keys) {
    assert(!browserStorage.includes(key), 'API key leaked into browser persistence');
    assert(!body.includes(key), 'API key leaked into visible page content');
  }
};
let step = '';
try {
  step = 'register fixture account'; console.log(step);
  const registration = await context.request.post(`${base}/api/auth/register`, { data: { name: '供应商验证', email: `qa-provider-${Date.now()}@example.test`, password: 'qa-password-123' } });
  assert.equal(registration.status(), 201);
  const { user } = await registration.json();
  const seed = await context.request.post(`${base}/api/sync`, { data: { userId: user.id, changes: [{ id: 'profile', kind: 'profile', data: { age: 28, sex: 'male', height: 175, weight: 70, goal: 'maintain', activity: 1.375 }, deleted: false, baseVersion: 0 }] } });
  assert.equal(seed.status(), 200);
  await page.goto(base); await page.locator('#chat-input').waitFor(); await settings();

  step = 'preset and API key discover three selectable models'; console.log(step);
  await addProvider('deepseek', keys[0]);
  assert.match(modelCalls.at(-1).url, /^https:\/\/api\.deepseek\.com\/(?:v1\/)?models$/);
  assert.equal(modelCalls.at(-1).authorization, `Bearer ${keys[0]}`);
  await assertSaveButtonVisible();
  await screenshot('desktop-provider-models');

  step = 'search preserves enabled selections and empty search is clear'; console.log(step);
  await page.locator('#provider-model-search').fill('vision');
  assert.equal(await page.locator('input[name="enabled-model"]:visible').count(), 1);
  assert.equal(await page.locator('input[name="enabled-model"][value="qa-vision"]').isChecked(), true);
  await page.locator('#provider-model-search').fill('qa-not-a-real-model');
  assert.equal(await page.locator('input[name="enabled-model"]:visible').count(), 0);
  assert.match(await page.locator('#provider-form').textContent(), /没有|未找到|无匹配/);
  await screenshot('desktop-provider-search-empty');
  await page.locator('#provider-model-search').fill('');
  for (const model of modelIds) assert.equal(await page.locator(`input[name="enabled-model"][value="${model}"]`).isChecked(), true);
  await submit('provider-form'); await page.locator('#provider-form').waitFor({ state: 'hidden' });
  let saved = await config();
  assert.equal(saved.providers.length, 1);
  const firstId = saved.providers[0].id;
  assert.equal(saved.providers[0].hasKey, true);
  assert.equal(saved.providers[0].model, 'qa-chat');
  assert.deepEqual(saved.providers[0].models.map(model => model.id).sort(), [...modelIds].sort());

  step = 'assign each task a different model from the same provider'; console.log(step);
  for (const [task, modelId] of Object.entries({ chat: 'qa-chat', meal: 'qa-vision', planning: 'qa-planner' })) {
    await page.locator(`#task-${task}`).selectOption(JSON.stringify({ providerId: firstId, modelId }));
  }
  const saveTasks = page.waitForResponse(response => response.url().endsWith('/api/providers') && response.request().method() === 'PUT');
  await submit('tasks-form'); assert.equal((await saveTasks).status(), 200);
  saved = await config();
  for (const [task, modelId] of Object.entries({ chat: 'qa-chat', meal: 'qa-vision', planning: 'qa-planner' })) {
    assert.equal(await page.locator(`#task-${task}`).inputValue(), JSON.stringify({ providerId: firstId, modelId }));
    assert.equal(saved.tasks[task], firstId);
    assert.equal(saved.taskModels[task], modelId);
    const response = await context.request.post(`${base}/api/ai`, { data: { task, messages: [{ role: 'user', content: 'QA 任务模型验证' }] } });
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).model, modelId);
    assert.equal(completionCalls.at(-1).model, modelId);
    assert.equal(completionCalls.at(-1).authorization, `Bearer ${keys[0]}`);
  }

  step = 'edit discovers models using saved key without re-entry'; console.log(step);
  await editProvider(firstId);
  assert.equal(await page.locator('#provider-key').inputValue(), '');
  assert.equal((await discover()).status, 200);
  assert.equal(modelCalls.at(-1).authorization, `Bearer ${keys[0]}`);
  await noStoredKeys();

  step = 'empty and rejected discovery show useful feedback without leaking credentials'; console.log(step);
  discoveryMode = 'empty';
  assert.equal((await discover()).status, 200);
  assert.match(await page.locator('#provider-form').textContent(), /没有|未返回|为空|无可用|0 个|0个/);
  discoveryMode = 'error';
  assert((await discover()).status >= 400);
  assert.match(await page.locator('#provider-feedback').textContent(), /认证|密钥|权限/);
  await noStoredKeys(); await screenshot('desktop-provider-fetch-error');
  discoveryMode = 'success'; assert.equal((await discover()).status, 200);
  await submit('provider-form'); await page.locator('#provider-form').waitFor({ state: 'hidden' });
  saved = await config();
  assert.deepEqual(saved.tasks, { chat: firstId, meal: firstId, planning: firstId });
  assert.deepEqual(saved.taskModels, { chat: 'qa-chat', meal: 'qa-vision', planning: 'qa-planner' });

  step = 'second preset makes both providers available to task model selection'; console.log(step);
  await addProvider('openai', keys[1]);
  assert.match(modelCalls.at(-1).url, /^https:\/\/api\.openai\.com\/v1\/models$/);
  assert.equal(modelCalls.at(-1).authorization, `Bearer ${keys[1]}`);
  await submit('provider-form'); await page.locator('#provider-form').waitFor({ state: 'hidden' });
  saved = await config(); assert.equal(saved.providers.length, 2);
  for (const [task, modelId] of Object.entries({ chat: 'qa-chat', meal: 'qa-vision', planning: 'qa-planner' })) {
    assert.equal(await page.locator(`#task-${task}`).inputValue(), JSON.stringify({ providerId: firstId, modelId }), 'Adding another provider must preserve each task selection');
  }
  const secondId = saved.providers.find(provider => provider.id !== firstId).id;
  for (const providerId of [firstId, secondId]) for (const modelId of modelIds) {
    assert.equal(await page.locator('#task-chat option').evaluateAll((options, value) => options.filter(option => option.value === value).length, JSON.stringify({ providerId, modelId })), 1);
  }
  await page.locator('#task-chat').selectOption(JSON.stringify({ providerId: secondId, modelId: 'qa-vision' }));
  const saveSecondTask = page.waitForResponse(response => response.url().endsWith('/api/providers') && response.request().method() === 'PUT');
  await submit('tasks-form'); assert.equal((await saveSecondTask).status(), 200);
  const secondCall = await context.request.post(`${base}/api/ai`, { data: { task: 'chat', messages: [{ role: 'user', content: 'QA 第二供应商验证' }] } });
  assert.equal(secondCall.status(), 200);
  assert.equal(completionCalls.at(-1).authorization, `Bearer ${keys[1]}`);
  assert.equal(completionCalls.at(-1).model, 'qa-vision');
  await screenshot('desktop-provider-settings');

  step = 'reload retains configuration and mobile at 390 pixels stays within viewport'; console.log(step);
  await page.reload(); await page.locator('.nav [data-page="settings"]').waitFor(); await settings();
  assert.equal(await page.locator('#task-chat').inputValue(), JSON.stringify({ providerId: secondId, modelId: 'qa-vision' }));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'AI settings overflow at 390px');
  await screenshot('mobile-provider-settings');
  await editProvider(firstId);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Provider editor overflows at 390px');
  assert.equal(await page.locator('#provider-form').evaluate(form => form.scrollWidth <= form.clientWidth), true, 'Provider form has horizontal overflow');
  await assertSaveButtonVisible();
  await screenshot('mobile-provider-models');
  await page.locator('[data-action="close-modal"]').click();
  await noStoredKeys();
  const exported = await context.request.get(`${base}/api/export`);
  assert.equal(exported.status(), 200);
  const exportedText = await exported.text();
  for (const key of keys) assert(!exportedText.includes(key), 'Personal data export contains a raw API key');
  for (const name of await readdir(dataDir)) {
    if (!/\.(?:sqlite|sqlite-wal|db|db-wal)$/.test(name)) continue;
    const bytes = await readFile(join(dataDir, name));
    for (const key of keys) assert(!bytes.includes(Buffer.from(key)), 'Raw API key is present in the database');
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedFailures, []);
  console.log(JSON.stringify({ passed: true, dataDir, modelRequests: modelCalls.length, completionRequests: completionCalls.length, checks: 'preset + key only; model search and enablement; per-task model routing; saved key reuse; empty/error discovery; credential redaction and persistence; multiple providers; reload; 390px layout' }));
} catch (error) {
  await screenshot('failure').catch(() => {});
  await writeFile(join(dataDir, 'failure.html'), await page.content());
  console.error(JSON.stringify({ step, dataDir, errors, unexpectedFailures }));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
