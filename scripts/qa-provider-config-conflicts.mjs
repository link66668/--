// Two independent Edge sessions exercise settings conflicts against an isolated
// HTTP server and SQLite database. All accounts and credentials are synthetic.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'provider-conflicts-'));
const candidates = [process.env.QA_PLAYWRIGHT, join(root, '.qa/community-tools/node_modules/playwright/index.mjs'), join(root, '精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean);
const playwrightPath = candidates.find(path => existsSync(path));
if (!playwrightPath) throw new Error('请设置 QA_PLAYWRIGHT 为本机 Playwright 模块路径。');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
const checks = [], pageErrors = [], writeRequests = [];
let browser, pageA, pageB, step = 'setup', upstreamCalls = 0;
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, communityModeratorIds: [], communityModeratorEmails: [], fetchImpl: async () => { upstreamCalls++; throw new Error('Configuration conflict QA must not invoke an AI upstream'); } });
const base = `http://127.0.0.1:${server.address().port}`;
const fixtureProvider = (id, name = id) => ({ id, name, presetId: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: `synthetic-${id}-key-only`, model: 'model-a', models: [{ id: 'model-a' }, { id: 'model-b' }] });
const password = 'isolated-provider-conflicts-password';
const draftKey = 'synthetic-unsaved-provider-secret';
async function api(context, path, method = 'GET', body) {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json();
  assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);
  return value;
}
const configuration = context => api(context, '/providers');
async function register(context, email) {
  const { user } = await api(context, '/auth/register', 'POST', { email, password, name: '配置冲突验收' });
  await api(context, '/sync', 'POST', { userId: user.id, changes: [{ id: 'profile', kind: 'profile', baseVersion: 0, data: { age: 28, sex: 'male', height: 175, weight: 70, goal: 'maintain', activity: 1.375 } }] });
  return user;
}
async function settings(page) {
  await page.goto(base);
  await page.locator('#chat-input').waitFor();
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator('.nav [data-page="settings"]').click();
  await page.locator('[data-action="settings-tab"][data-tab="ai"]').click();
  await page.locator('#tasks-form').waitFor();
}
const editProvider = (page, id) => page.locator(`.provider-card [data-action="provider"][data-id="${id}"]`).click();
const shot = (page, name) => page.screenshot({ path: join(dataDir, `${name}.png`), fullPage: true, style: '#toasts{visibility:hidden}' });
async function save(page, button, status) {
  const waiting = page.waitForResponse(response => response.url() === base + '/api/providers' && response.request().method() === 'PUT');
  await button.click();
  const response = await waiting;
  assert.equal(response.status(), status);
  const body = response.request().postDataJSON();
  writeRequests.push({ status, version: body.version });
  return response;
}
const saveEditor = (page, status) => save(page, page.locator('#provider-form button[type="submit"]'), status);
const saveTasks = (page, status) => save(page, page.locator('#tasks-form button').last(), status);
async function noOverflow(page, scope) {
  const geometry = await page.evaluate(selector => {
    const element = document.querySelector(selector), rect = element.getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, scopeWidth: element.clientWidth, scopeScrollWidth: element.scrollWidth, left: rect.left, right: rect.right };
  }, scope);
  assert(geometry.documentWidth <= geometry.viewport + 1, `Page overflow: ${JSON.stringify(geometry)}`);
  assert(geometry.scopeScrollWidth <= geometry.scopeWidth + 1, `Conflict content overflow: ${JSON.stringify(geometry)}`);
  const button = page.locator(`${scope} [data-action="reload-providers"]`).first();
  await button.scrollIntoViewIfNeeded();
  const bounds = await button.boundingBox();
  assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= geometry.viewport + 1, 'Reload action extends beyond mobile viewport');
  assert(await button.isVisible());
  return geometry;
}
async function addCustomProvider(page, name) {
  await page.locator('#settings-content [data-action="provider"]').filter({ hasText: '添加' }).click();
  await page.locator('#provider-preset').selectOption('custom');
  await page.locator('#provider-name').fill(name);
  await page.locator('#provider-url').fill('http://127.0.0.1:9999/v1');
  await page.locator('#provider-key').fill('synthetic-first-ui-key-only');
  await page.locator('details.manual-model summary').click();
  await page.locator('#provider-manual-model').fill('model-a');
  await page.locator('[data-action="manual-model"]').click();
  await saveEditor(page, 200);
  await page.locator('#provider-form').waitFor({ state: 'hidden' });
}

try {
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  pageA = await contextA.newPage(); pageB = await contextB.newPage();
  for (const page of [pageA, pageB]) { page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message)); }
  const email = 'isolated-provider-conflicts@example.test';
  const user = await register(contextA, email);
  const secondLogin = await api(contextB, '/auth/login', 'POST', { email, password });
  assert.equal(secondLogin.user.id, user.id);
  const initial = await api(contextA, '/providers', 'PUT', { version: 0, providers: [fixtureProvider('supplier-a', '供应商 A'), fixtureProvider('supplier-b', '供应商 B')], tasks: { chat: 'supplier-a', meal: 'supplier-a', planning: 'supplier-b' }, taskModels: { chat: 'model-a', meal: 'model-a', planning: 'model-b' } });
  assert.equal(initial.version, 1);
  await Promise.all([settings(pageA), settings(pageB)]);

  step = 'provider conflict preserves modal, input and secret; retries retain stale revision'; console.log(step);
  await Promise.all([editProvider(pageA, 'supplier-a'), editProvider(pageB, 'supplier-b')]);
  await pageA.locator('#provider-name').fill('供应商 A · 已在 A 保存');
  await pageB.locator('#provider-name').fill('供应商 B · 未保存草稿');
  await pageB.locator('#provider-key').fill(draftKey);
  await saveEditor(pageA, 200); await pageA.locator('#provider-form').waitFor({ state: 'hidden' });
  await saveEditor(pageB, 409);
  await pageB.locator('#provider-feedback [data-action="reload-providers"]').waitFor();
  assert(await pageB.locator('#modal').evaluate(dialog => dialog.open));
  assert.equal(await pageB.locator('#provider-name').inputValue(), '供应商 B · 未保存草稿');
  assert.equal(await pageB.locator('#provider-key').inputValue(), draftKey);
  let saved = await configuration(contextA);
  assert.equal(saved.providers.find(row => row.id === 'supplier-a').name, '供应商 A · 已在 A 保存');
  assert.equal(saved.providers.find(row => row.id === 'supplier-b').name, '供应商 B');
  assert.equal(saved.version, 2);
  await saveEditor(pageB, 409);
  assert.equal(writeRequests.at(-1).version, initial.version);
  assert.equal(await pageB.locator('#provider-key').inputValue(), draftKey);
  assert.deepEqual(await configuration(contextA), saved);
  await shot(pageB, 'desktop-provider-conflict');
  await pageB.setViewportSize({ width: 390, height: 844 });
  const editorGeometry = await noOverflow(pageB, '#provider-feedback');
  assert.equal(await pageB.locator('#provider-key').inputValue(), draftKey);
  await shot(pageB, 'mobile-provider-conflict');
  await pageB.setViewportSize({ width: 1440, height: 1000 });
  checks.push({ check: 'Provider stale save and repeated save return 409 while keeping the modal, name and secret draft; accepted change is preserved.', mobileGeometry: editorGeometry });

  step = 'explicit reload then a deliberate fresh edit saves both devices changes'; console.log(step);
  await pageB.locator('#provider-feedback [data-action="reload-providers"]').click();
  await pageB.locator('#provider-form').waitFor({ state: 'hidden' });
  assert.equal(Number(await pageB.locator('#tasks-form').getAttribute('data-version')), 2);
  await editProvider(pageB, 'supplier-b');
  assert.equal(await pageB.locator('#provider-key').inputValue(), '');
  await pageB.locator('#provider-name').fill('供应商 B · 加载最新后保存');
  await saveEditor(pageB, 200); await pageB.locator('#provider-form').waitFor({ state: 'hidden' });
  saved = await configuration(contextA);
  assert.equal(saved.version, 3); assert.equal(saved.providers.find(row => row.id === 'supplier-a').name, '供应商 A · 已在 A 保存');
  assert.equal(saved.providers.find(row => row.id === 'supplier-b').name, '供应商 B · 加载最新后保存');
  checks.push('Explicit reload discards the acknowledged unsaved draft; a fresh edit succeeds and keeps the other device change.');

  step = 'stale task selections remain selected after rejection and mobile conflict actions fit'; console.log(step);
  await Promise.all([settings(pageA), settings(pageB)]);
  const requestedMeal = JSON.stringify({ providerId: 'supplier-b', modelId: 'model-b' });
  await pageB.locator('#task-meal').selectOption(requestedMeal);
  await editProvider(pageA, 'supplier-a'); await pageA.locator('#provider-name').fill('供应商 A · 第二次保存');
  await saveEditor(pageA, 200); await pageA.locator('#provider-form').waitFor({ state: 'hidden' });
  await pageB.setViewportSize({ width: 390, height: 844 });
  await saveTasks(pageB, 409);
  await pageB.locator('#provider-settings-feedback [data-action="reload-providers"]').waitFor();
  assert.equal(await pageB.locator('#task-meal').inputValue(), requestedMeal);
  assert.equal(Number(await pageB.locator('#tasks-form').getAttribute('data-version')), 3);
  saved = await configuration(contextA); assert.equal(saved.version, 4); assert.equal(saved.tasks.meal, 'supplier-a'); assert.equal(saved.taskModels.meal, 'model-a');
  const taskGeometry = await noOverflow(pageB, '#provider-settings-feedback');
  await shot(pageB, 'mobile-task-conflict');
  await pageB.locator('#provider-settings-feedback [data-action="reload-providers"]').click();
  await pageB.waitForFunction(() => document.querySelector('#tasks-form')?.dataset.version === '4');
  await pageB.locator('#task-meal').selectOption(requestedMeal); await saveTasks(pageB, 200);
  saved = await configuration(contextA); assert.equal(saved.version, 5); assert.equal(saved.tasks.meal, 'supplier-b'); assert.equal(saved.providers.find(row => row.id === 'supplier-a').name, '供应商 A · 第二次保存');
  checks.push({ check: 'Task-form conflict preserves the unsaved selection and form revision; explicit reload permits a fresh save.', mobileGeometry: taskGeometry });

  step = 'stale delete cannot remove a provider added elsewhere and offers an explicit reload'; console.log(step);
  await pageB.setViewportSize({ width: 1440, height: 1000 });
  await settings(pageB);
  await pageB.locator('[data-action="delete-provider"][data-id="supplier-a"]').click();
  const added = await configuration(contextA); added.providers.push(fixtureProvider('supplier-c', '另一设备新增供应商 C'));
  saved = await api(contextA, '/providers', 'PUT', added); assert.equal(saved.version, 6);
  await save(pageB, pageB.locator('#modal [data-action="confirm-delete-provider"]'), 409);
  const reloadInDelete = pageB.locator('#modal [data-provider-conflict] [data-action="reload-providers"]');
  await reloadInDelete.waitFor();
  assert(await pageB.locator('#modal').evaluate(dialog => dialog.open));
  assert.deepEqual(await configuration(contextA), saved);
  await shot(pageB, 'desktop-delete-conflict');
  await pageB.setViewportSize({ width: 390, height: 844 });
  const deleteGeometry = await noOverflow(pageB, '#modal [data-provider-conflict]');
  await shot(pageB, 'mobile-delete-conflict');
  await save(pageB, pageB.locator('#modal [data-action="confirm-delete-provider"]'), 409);
  assert.equal(writeRequests.at(-1).version, 5); assert.deepEqual(await configuration(contextA), saved);
  await reloadInDelete.click(); await pageB.locator('#modal').waitFor({ state: 'hidden' });
  await pageB.waitForFunction(() => document.querySelector('#tasks-form')?.dataset.version === '6');
  await pageB.locator('[data-action="delete-provider"][data-id="supplier-a"]').click();
  await save(pageB, pageB.locator('#modal [data-action="confirm-delete-provider"]'), 200);
  await pageB.locator('#modal').waitFor({ state: 'hidden' });
  saved = await configuration(contextA); assert.equal(saved.version, 7); assert(!saved.providers.some(row => row.id === 'supplier-a')); assert(saved.providers.some(row => row.id === 'supplier-c'));
  checks.push({ check: 'Delete conflicts keep the confirmation open, reject repeated stale attempts, and retain the newly added provider after reload and a fresh deletion.', mobileGeometry: deleteGeometry });

  step = 'first UI configuration starts from an empty version-zero account'; console.log(step);
  const freshContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await register(freshContext, 'isolated-first-provider-ui@example.test');
  const freshPage = await freshContext.newPage(); freshPage.setDefaultTimeout(15000); freshPage.on('pageerror', error => pageErrors.push(error.message));
  await settings(freshPage);
  assert.equal(Number(await freshPage.locator('#tasks-form').getAttribute('data-version')), 0);
  await addCustomProvider(freshPage, '首次界面配置');
  const freshConfig = await configuration(freshContext); assert.equal(freshConfig.version, 1); assert.equal(freshConfig.providers.length, 1); assert.equal(freshConfig.providers[0].name, '首次界面配置');
  await shot(freshPage, 'mobile-first-provider-saved');
  checks.push('An empty version-zero account can create and save its first provider entirely through the UI without model discovery.');
  assert.deepEqual(pageErrors, []); assert.equal(upstreamCalls, 0);
  const result = { passed: true, dataDir, checks, writeRequests, upstreamCalls, pageErrors, syntheticAccountOnly: true, sameAccountSessionsVerified: user.id !== '' };
  await writeFile(join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  for (const [name, page] of [['failure-device-a', pageA], ['failure-device-b', pageB]]) if (page) await shot(page, name).catch(() => {});
  await writeFile(join(dataDir, 'result.json'), JSON.stringify({ passed: false, step, error: error.message, dataDir, checks, writeRequests, upstreamCalls, pageErrors }, null, 2));
  console.error(JSON.stringify({ passed: false, step, dataDir, error: error.message }));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
