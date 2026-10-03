// Account-delete isolation in real Edge sessions and a fresh HTTP/SQLite server.
// Every account, credential and IndexedDB record below is created by this script.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightPath = [process.env.QA_PLAYWRIGHT, join(root, '.qa/community-tools/node_modules/playwright/index.mjs'), join(root, '精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean).find(path => existsSync(path));
if (!playwrightPath) throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 路径。');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'account-delete-race-'));
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
const base = `http://127.0.0.1:${server.address().port}`, password = 'isolated-delete-race-qa-password';
const contexts = [], checks = [], errors = [], snapshots = [], gates = [];
let browser, currentPage, step = 'setup';
const mark = label => { step = label; console.log(label); };
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const api = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json(); assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`); return value;
};
const newContext = async () => { const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); contexts.push(context); return context; };
const register = async (context, slug) => {
  const { user } = await api(context, '/auth/register', 'POST', { name: slug, email: `delete-${slug}@example.test`, password });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 28, sex: 'male', height: 175, weight: 70, goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] }); return user;
};
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shot = (page, name) => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: false, style: '#toasts{visibility:hidden}' });
const nav = (page, name) => page.locator(`.nav [data-page="${name}"]`).click();
const snapshot = (page, userId) => page.evaluate(userId => window.qaAccountSnapshot(userId), userId);
const waitCleared = (page, userId) => page.waitForFunction(async userId => {
  const cache = await window.qaAccountSnapshot(userId); return !cache.account && cache.records.length === 0 && cache.communityDrafts.length === 0 && cache.communityKeys.length === 0;
}, userId);
const fixture = async name => {
  const context = await newContext(), otherContext = await newContext();
  const a = await register(context, name + '-A'), b = await register(otherContext, name + '-B');
  const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // Retain the read-only observer after reload to prove cached pending work survives boot.
    const read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    window.qaAccountSnapshot = async id => {
      const db = await read(indexedDB.open('fitness-assistant-v1', 2)), tx = db.transaction(['accounts', 'record-cache']);
      const [account, rows, keys] = await Promise.all([read(tx.objectStore('accounts').get(id)), read(tx.objectStore('record-cache').getAll()), read(tx.objectStore('record-cache').getAllKeys())]); db.close();
      const draftDb = await read(indexedDB.open('fitness-community-drafts-v1', 1));
      const communityDrafts = (await read(draftDb.transaction('drafts').objectStore('drafts').getAll())).filter(row => row.accountId === id); draftDb.close();
      return { userId: id, account: account || null, records: rows.filter((_, i) => keys[i][0] === id), communityDrafts, communityKeys: Object.keys(localStorage).filter(key => key.startsWith('fitness:community:' + id + ':')), activeUser: JSON.parse(localStorage.getItem('fitness:last-user') || 'null'), nav: !!document.querySelector('.nav') };
    };
  });
  await page.goto(base); await page.locator('.nav').waitFor();
  await page.evaluate(async ({ userId }) => {
    // Import the exact live module URLs so these observers cover the app's instances.
    const source = await (await fetch('/app.js')).text();
    const modulePath = name => source.match(new RegExp("from ['\"]([^'\"]*/" + name + "\\.js[^'\"]*)['\"]"))[1];
    const { RecordStore } = await import(new URL(modulePath('store'), location.href).href);
    const communityPath = new URL(modulePath('community'), location.href).href, communitySource = await (await fetch(communityPath)).text();
    const draftPath = communitySource.match(/from ['"]([^'"]*\/community-drafts\.js[^'"]*)['"]/)[1];
    const { CommunityDrafts } = await import(new URL(draftPath, communityPath).href);
    window.qaRecordStore = RecordStore; window.qaCommunityDrafts = CommunityDrafts; window.qaCleanupCalls = []; window.qaDeleteParsed = false;
    const originalFetch = window.fetch;
    window.fetch = async function (url, options) {
      const response = await originalFetch.call(this, url, options);
      if (new URL(typeof url === 'string' ? url : url.url, location.href).pathname === '/api/account' && options?.method === 'DELETE') {
        const originalJson = response.json.bind(response);
        response.json = async () => { const value = await originalJson(); window.qaDeleteParsed = true; return value; };
      }
      return response;
    };
    const originalClear = CommunityDrafts.prototype.clear;
    CommunityDrafts.prototype.clear = async function (...args) {
      const entry = { userId: this.accountId, started: true, finished: false }; window.qaCleanupCalls.push(entry);
      if (this.accountId === userId && window.qaHoldDraftClear) { window.qaHoldDraftClear = false; window.qaDraftClearStarted = true; await new Promise(resolve => { window.qaReleaseDraftClear = resolve; }); }
      try { return await originalClear.apply(this, args); } finally { entry.finished = true; }
    };
    const read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const database = (name, version) => read(indexedDB.open(name, version));
    window.qaAccountSnapshot = async id => {
      const db = await database('fitness-assistant-v1', 2), tx = db.transaction(['accounts', 'record-cache']);
      const [account, rows, keys] = await Promise.all([read(tx.objectStore('accounts').get(id)), read(tx.objectStore('record-cache').getAll()), read(tx.objectStore('record-cache').getAllKeys())]); db.close();
      const drafts = new CommunityDrafts(id), communityDrafts = await drafts.list(); drafts.close();
      return { userId: id, account: account || null, records: rows.filter((_, i) => keys[i][0] === id), communityDrafts, communityKeys: Object.keys(localStorage).filter(key => key.startsWith('fitness:community:' + id + ':')), activeUser: JSON.parse(localStorage.getItem('fitness:last-user') || 'null'), nav: !!document.querySelector('.nav') };
    };
    const drafts = new CommunityDrafts(userId); await drafts.save({ id: 'delete-qa-draft', type: 'text', title: '隔离删除草稿', body: '删除账号时应清除此草稿' }); drafts.close();
    localStorage.setItem('fitness:community:' + userId + ':qa-marker', JSON.stringify({ onlyForIsolatedQA: true }));
  }, { userId: a.id });
  assert((await snapshot(page, a.id)).account, 'A has real persisted account cache'); return { context, otherContext, page, a, b };
};
const openDelete = async (page, enteredPassword = password) => {
  await nav(page, 'settings'); await page.locator('[data-action="settings-tab"][data-tab="data"]').click(); await page.locator('[data-action="delete-account"]').click();
  await page.locator('#delete-password').fill(enteredPassword);
};
const submitDelete = page => page.locator('#delete-account-form').evaluate(form => form.requestSubmit());
const cancelAndLogout = async page => {
  if (await page.locator('#delete-account-form').count()) await page.locator('#delete-account-form [data-action="close-modal"]').click();
  await page.locator('[data-action="logout"]').click(); await page.locator('#auth-form').waitFor({ state: 'attached' });
};
const login = async (page, user) => {
  await page.evaluate(() => { location.hash = '#auth-entry'; }); await page.locator('#auth-form').waitFor();
  await page.locator('.auth-tabs [data-mode="login"]').click(); await page.locator('#email').fill(user.email); await page.locator('#password').fill(password);
  await page.locator('#auth-form').evaluate(form => form.requestSubmit()); await page.locator('.nav').waitFor();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('fitness:last-user')))).id, user.id);
};
const unsyncedWeight = async ({ context, page }, user, weight = 77) => {
  await page.route('**/api/sync', intercepted => {
    if (intercepted.request().headers()['x-fitness-user'] === user.id) return intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离QA：资料尚未同步' }) });
    return intercepted.continue();
  });
  await nav(page, 'settings'); await page.locator('[data-action="settings-tab"][data-tab="profile"]').click(); await page.locator('[data-action="profile"]').click();
  await page.locator('#profile-weight').fill(String(weight)); await page.locator('#profile-form').evaluate(form => form.requestSubmit()); await page.locator('#profile-form').waitFor({ state: 'hidden' });
  await page.waitForFunction(async ({ id, weight }) => { const cache = await window.qaAccountSnapshot(id); return cache.records.find(row => row.id === 'profile')?.data.weight === weight && cache.account?.pending.some(([recordId, change]) => recordId === 'profile' && change.data.weight === weight); }, { id: user.id, weight });
  return snapshot(page, user.id);
};
const assertBPreserved = async (f, before) => {
  await settle(f.page); const after = await snapshot(f.page, f.b.id);
  assert.equal(after.activeUser?.id, f.b.id); assert.equal(after.nav, true); assert.equal(after.records.find(row => row.id === 'profile')?.data.weight, 77);
  assert.deepEqual(after.account.pending, before.account.pending, 'B unsynced queue survives A cleanup'); assert.deepEqual(after.records, before.records, 'B cached records survive A cleanup');
  assert.equal((await api(f.context, '/auth/me')).user.id, f.b.id); assert.equal((await api(f.otherContext, '/state')).records.find(row => row.id === 'profile').data.weight, 70, 'B 77kg remains unsynced');
  await f.page.reload(); await f.page.locator('.nav').waitFor(); await nav(f.page, 'settings'); await f.page.locator('[data-action="settings-tab"][data-tab="profile"]').click();
  await f.page.waitForFunction(() => [...document.querySelectorAll('.stat strong')].some(element => element.textContent.trim() === '77kg'));
  const reloaded = await snapshot(f.page, f.b.id); assert.equal(reloaded.records.find(row => row.id === 'profile').data.weight, 77); assert.deepEqual(reloaded.account.pending, before.account.pending);
  snapshots.push({ scenario: step, before, after, reloaded }); await shot(f.page, step); return after;
};
const holdAck = async page => {
  let release, commit; const gate = new Promise(resolve => { release = resolve; }), committed = new Promise(resolve => { commit = resolve; }); gates.push(release);
  await page.route('**/api/account', async intercepted => {
    if (intercepted.request().method() !== 'DELETE') return intercepted.continue();
    const response = await intercepted.fetch(), body = await response.text(); commit({ status: response.status(), body, target: intercepted.request().headers()['x-fitness-user'] }); await gate;
    // The server's cookie response is already applied by route.fetch; hold only the JS acknowledgement.
    await intercepted.fulfill({ status: response.status(), contentType: 'application/json', body });
  });
  return { release, committed };
};

try {
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  mark('late-ack-after-login-B');
  {
    const f = await fixture('ack-after-login'), held = await holdAck(f.page); await openDelete(f.page); await submitDelete(f.page);
    const committed = await held.committed; assert.equal(committed.status, 200); assert.equal(committed.target, f.a.id);
    await cancelAndLogout(f.page); await login(f.page, f.b); const before = await unsyncedWeight(f, f.b); held.release(); await waitCleared(f.page, f.a.id); await assertBPreserved(f, before);
    checks.push('A服务端删除成功但ACK延迟，取消/退出/登录B并修改未同步77kg后，释放A回包不会登出B或清其缓存；刷新保留B离线队列');
  }

  mark('late-ack-between-logout-and-login-B');
  {
    const f = await fixture('ack-before-login'), held = await holdAck(f.page); await openDelete(f.page); await submitDelete(f.page); assert.equal((await held.committed).status, 200);
    await cancelAndLogout(f.page); held.release(); await waitCleared(f.page, f.a.id); await settle(f.page); assert.equal((await snapshot(f.page, f.a.id)).activeUser, null);
    await login(f.page, f.b); const before = await unsyncedWeight(f, f.b); await assertBPreserved(f, before);
    checks.push('A迟到ACK在退出与登录B之间到达，安全清A缓存，随后B登录及77kg未同步资料正常');
  }

  mark('switch-B-during-awaited-draft-cleanup');
  {
    const f = await fixture('cleanup-switch'); await f.page.evaluate(() => { window.qaHoldDraftClear = true; }); await openDelete(f.page); await submitDelete(f.page);
    await f.page.waitForFunction(() => window.qaDraftClearStarted === true); await cancelAndLogout(f.page); await login(f.page, f.b); const before = await unsyncedWeight(f, f.b);
    await f.page.evaluate(() => window.qaReleaseDraftClear()); await waitCleared(f.page, f.a.id); await assertBPreserved(f, before);
    checks.push('成功ACK后的CommunityDrafts.clear await期间切B，恢复A清理仍只操作A，B登录/77kg缓存/同步队列不受影响');
  }

  mark('same-account-failure-preserves-local-and-server-data');
  {
    const f = await fixture('wrong-password'), before = await unsyncedWeight(f, f.a); await openDelete(f.page, 'incorrect-isolated-password');
    const pending = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/account' && response.request().method() === 'DELETE'); await submitDelete(f.page); assert.equal((await pending).status(), 401);
    await f.page.waitForFunction(() => window.qaDeleteParsed === true); await settle(f.page); const after = await snapshot(f.page, f.a.id);
    assert.equal(after.activeUser?.id, f.a.id); assert.equal(after.nav, true); assert.deepEqual(after.account, before.account); assert.deepEqual(after.records, before.records); assert.deepEqual(after.communityDrafts, before.communityDrafts); assert.deepEqual(after.communityKeys, before.communityKeys);
    assert.equal((await api(f.context, '/auth/me')).user.id, f.a.id); assert.equal((await api(f.context, '/state')).records.find(row => row.id === 'profile').data.weight, 70); assert.equal(await f.page.locator('#delete-account-form').count(), 1);
    snapshots.push({ scenario: step, before, after }); await shot(f.page, step); checks.push('同账号错误密码删除失败不退出、不清记录/未同步77kg/社区草稿或本地键，服务端账号和70kg资料仍在');
  }

  mark('same-account-success-clears-only-deleted-owner');
  {
    const f = await fixture('normal-delete'); await unsyncedWeight(f, f.a);
    await f.page.evaluate(async b => { const store = await new window.qaRecordStore(b).open(); await store.put('profile', 'profile', { age: 28, sex: 'male', height: 175, weight: 77, goal: 'maintain', activity: 1.375 }, false, { sync: false }); await store.close(); }, f.b);
    const otherBefore = await snapshot(f.page, f.b.id); await openDelete(f.page); await submitDelete(f.page); await f.page.locator('#auth-form').waitFor({ state: 'attached' }); await waitCleared(f.page, f.a.id);
    const removed = await snapshot(f.page, f.a.id), otherAfter = await snapshot(f.page, f.b.id); assert.equal(removed.activeUser, null); assert.equal(removed.nav, false); assert.deepEqual(otherAfter.account, otherBefore.account); assert.deepEqual(otherAfter.records, otherBefore.records);
    assert.equal((await f.context.request.post(base + '/api/auth/login', { data: { email: f.a.email, password } })).status(), 401); assert.equal((await api(f.otherContext, '/auth/me')).user.id, f.b.id);
    snapshots.push({ scenario: step, removed, otherBefore, otherAfter }); await shot(f.page, step); checks.push('同账号成功删除登出并清该账号record-cache/accounts/社区草稿/localStorage；其他账号缓存和服务端账号完整保留');
  }

  assert.deepEqual(errors, [], 'No browser errors'); await json('snapshots', snapshots); await json('result', { passed: checks.length, checks, errors, dataDir }); console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (currentPage) await shot(currentPage, 'failure').catch(() => {}); await json('snapshots', snapshots); await json('failure', { step, message: error.message, stack: error.stack, errors }); console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const release of gates) release(); if (currentPage) await currentPage.evaluate(() => window.qaReleaseDraftClear?.()).catch(() => {});
  for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
