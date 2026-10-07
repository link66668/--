// Real Edge acceptance for account avatar and password settings.
// Uses only fresh test accounts, temporary SQLite data and isolated browser contexts.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightPath = [process.env.QA_PLAYWRIGHT, join(root, '.qa/browser-tools/node_modules/playwright/index.mjs'), join(root, '.qa/community-tools/node_modules/playwright/index.mjs'), join(root, '精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean).find(path => existsSync(path));
if (!playwrightPath) throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 路径。');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'account-settings-'));
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
const base = `http://127.0.0.1:${server.address().port}`;
const email = 'isolated-account-settings@example.test', oldPassword = 'isolated-old-password-qa', newPassword = 'isolated-new-password-qa';
const contexts = [], checks = [], errors = [], geometry = [], releases = [];
let browser, page, step = 'setup';
const mark = label => { step = label; console.log(label); };
const json = (name, value) => writeFile(join(dataDir, `${name}.json`), JSON.stringify(value, null, 2));
const newContext = async () => { const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); contexts.push(context); return context; };
const request = (context, path, method = 'GET', body) => context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
const api = async (context, path, method = 'GET', body) => { const response = await request(context, path, method, body), result = await response.json(); assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`); return result; };
const responseFor = (path, method) => page.waitForResponse(response => new URL(response.url()).pathname === '/api' + path && response.request().method() === method);
const shot = name => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const accountForm = () => page.locator('#account-password-form');
const fillPassword = async (current, next, confirmation = next) => { const form = accountForm(); await form.locator('[name=currentPassword]').fill(current); await form.locator('[name=newPassword]').fill(next); await form.locator('[name=confirmPassword]').fill(confirmation); };
const submitPassword = () => accountForm().locator('[type=submit]').click();
const openAccount = async () => { if (!await accountForm().isVisible()) await page.locator('[data-cm=profile-edit]').click(); await accountForm().waitFor(); };
const closeSettings = async () => { await page.locator('.personal-settings-dialog [data-cm=aux-close]').click(); await page.locator('.personal-settings-dialog').waitFor({state:'detached'}); };
const profile = context => api(context, '/community/me/profile').then(result => result.user || result.profile || result);
const sidebarAvatar = () => page.locator('.account [data-account-avatar] img');
const imageLoaded = async locator => { await locator.waitFor(); await locator.evaluate(image => image.decode()); assert(await locator.evaluate(image => image.naturalWidth > 0)); };
const waitSidebar = async url => { await page.waitForFunction(url => document.querySelector('.account [data-account-avatar] img')?.getAttribute('src') === url, url); await imageLoaded(sidebarAvatar()); };
const chooseAvatar = async file => {
  const uploading = page.waitForResponse(response => new URL(response.url()).pathname === '/api/community/media' && response.request().method() === 'POST');
  await page.locator('#account-avatar-file').setInputFiles(file); const response = await uploading; assert(response.ok(), 'avatar upload succeeds');
  await page.waitForFunction(() => document.querySelector('#account-avatar-status')?.textContent.includes('预览已就绪'));
  await imageLoaded(page.locator('[data-account-avatar-preview] img'));
};
const saveAvatar = async () => { const saving = responseFor('/community/me/profile', 'PATCH'); await page.locator('#account-avatar-form [type=submit]').click(); assert((await saving).ok()); };
const measure = async label => {
  const result = await page.evaluate(() => {
    const form = document.querySelector('#account-password-form'), avatar = document.querySelector('#account-avatar-form');
    const rect = element => element.getBoundingClientRect().toJSON();
    return { viewport: { width: innerWidth, height: innerHeight }, width: document.documentElement.scrollWidth, forms: [form, avatar].map(element => ({ rect: rect(element), client: element.clientWidth, scroll: element.scrollWidth })), controls: [...document.querySelectorAll('#account-password-form input:not([type=hidden]),#account-password-form button,#account-avatar-form button')].map(element => ({ name: element.name || element.textContent.trim(), ...rect(element) })) };
  });
  assert(result.width <= result.viewport.width + 1, `${label}: no page horizontal overflow`);
  for (const form of result.forms) { assert(form.scroll <= form.client + 1, `${label}: no form overflow`); assert(form.rect.left >= -1 && form.rect.right <= result.viewport.width + 1, `${label}: form fits viewport`); }
  for (const control of result.controls) assert(control.left >= -1 && control.right <= result.viewport.width + 1 && control.height >= 36, `${label}: ${control.name} is usable`);
  geometry.push({ label, ...result }); await shot(label);
};

try {
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await newContext(), otherSession = await newContext();
  const { user } = await api(context, '/auth/register', 'POST', { name: '账号设置 QA', email, password: oldPassword });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 28, sex: 'male', height: 175, weight: 70, goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  await api(otherSession, '/auth/login', 'POST', { email, password: oldPassword });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.locator('.nav').waitFor();

  mark('sidebar entry and account tab');
  await page.locator('.account .avatar[data-action=account-settings]').click(); await accountForm().waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#settings?section=account');
  assert.equal(await page.locator('[data-action=settings-tab][data-tab=home]').getAttribute('aria-current'), 'page');
  assert.deepEqual(await page.locator('.settings-nav button').allTextContents(), ['我的主页', '健康档案', '成就墙', 'AI 服务']);
  assert.match(await page.locator('.personal-settings-dialog').textContent(), new RegExp(email.replaceAll('.', '\\.')));
  checks.push('个人中心保留四个栏目；侧栏头像/名字在我的主页展开账号设置，邮箱正确。');

  mark('avatar upload preview and persistence');
  const before = await profile(context); await chooseAvatar(join(root, 'tests/fixtures/community-tiny-vp8l.webp'));
  assert.equal((await profile(context)).avatarUrl, before.avatarUrl, 'preview does not change saved profile');
  await saveAvatar(); const avatar = { url: (await profile(context)).avatarUrl }; assert(avatar.url); await waitSidebar(avatar.url);
  assert.equal((await profile(context)).avatarUrl, avatar.url);
  assert.equal((await api(context, '/auth/me')).user.avatarUrl, avatar.url);
  const cachedUser = await page.evaluate(() => JSON.parse(localStorage.getItem('fitness:last-user')));
  assert.equal(cachedUser.id, user.id); assert.equal(cachedUser.avatarUrl, avatar.url);
  await page.reload(); await accountForm().waitFor(); await waitSidebar(avatar.url);
  await closeSettings(); await page.locator('[data-action=settings-tab][data-tab=home]').click(); await imageLoaded(page.locator('.cm-profile-avatar img'));
  assert.equal(await page.locator('.cm-profile-avatar img').getAttribute('src'), avatar.url);
  checks.push('头像先上传预览、保存后绑定；侧栏和个人主页同步更新，auth/me及刷新后均保留同一头像。');

  mark('community profile edit updates sidebar');
  await page.locator('[data-cm=profile-edit]').click(); await page.locator('[data-cm-form=profile]').waitFor();
  assert.equal(await page.locator('.personal-settings-dialog > header h2').textContent(), '设置');
  assert.equal(await page.locator('#cm-avatar-file').count(), 0, 'only one avatar editor');
  await chooseAvatar(join(root, 'tests/fixtures/community-tiny-vp8.webp')); await saveAvatar();
  const secondAvatar = { url: (await profile(context)).avatarUrl }; assert(secondAvatar.url); assert.notEqual(secondAvatar.url, avatar.url);
  await page.locator('[data-cm-form=profile] [name=nickname]').fill('设置资料 QA');
  const communitySave = responseFor('/community/me/profile', 'PATCH'); await page.locator('[data-cm-form=profile] [type=submit]').click(); assert((await communitySave).ok());
  await page.locator('.personal-settings-dialog').waitFor({state:'detached'});
  assert.equal((await profile(context)).avatarUrl, secondAvatar.url, 'saving profile preserves the updated avatar');
  await waitSidebar(secondAvatar.url); await openAccount(); await imageLoaded(page.locator('[data-account-avatar-preview] img'));
  assert.equal(await page.locator('[data-account-avatar-preview] img').getAttribute('src'), secondAvatar.url);
  checks.push('社区编辑资料更换头像后，侧栏和账号设置立即使用新头像。');

  mark('password confirmation mismatch');
  let passwordRequests = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/account/password' && request.method() === 'PATCH') passwordRequests++; });
  await fillPassword(oldPassword, newPassword, newPassword + '-mismatch'); await submitPassword();
  await page.waitForFunction(() => document.querySelector('#account-password-status')?.textContent.includes('一致'));
  assert.equal(passwordRequests, 0, 'mismatching confirmation never reaches server');
  checks.push('两次新密码不一致时展示错误，不发送改密请求。');

  mark('wrong current password keeps credentials unchanged');
  await fillPassword('incorrect-isolated-password', newPassword); const wrongPassword = responseFor('/account/password', 'PATCH'); await submitPassword();
  assert.equal((await wrongPassword).status(), 401); await page.waitForFunction(() => /错误|不正确/.test(document.querySelector('#account-password-status')?.textContent || ''));
  assert.equal((await api(context, '/auth/me')).user.id, user.id);
  const loginProbe = await newContext(); assert.equal((await request(loginProbe, '/auth/login', 'POST', { email, password: newPassword })).status(), 401);
  assert.equal((await api(loginProbe, '/auth/login', 'POST', { email, password: oldPassword })).user.id, user.id);
  checks.push('当前密码错误返回401，页面保留登录，原密码仍可登录，新密码未生效。');

  mark('one password write while pending and session revocation');
  let release, reached, writes = 0;
  const gate = new Promise(resolve => { release = resolve; }), committed = new Promise(resolve => { reached = resolve; }); releases.push(release);
  const holdPassword = async route => { if (route.request().method() !== 'PATCH') return route.continue(); writes++; const response = await route.fetch(); reached(response.status()); await gate; await route.fulfill({ response }); };
  await page.route('**/api/account/password', holdPassword); await fillPassword(oldPassword, newPassword); await submitPassword(); assert.equal(await committed, 200);
  assert.equal(await accountForm().locator('[type=submit]').isDisabled(), true, 'pending save disables button');
  await accountForm().evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(writes, 1, 'repeated submit events send exactly one password write');
  release(); await page.waitForFunction(() => /已修改|修改成功|已更新/.test(document.querySelector('#account-password-status')?.textContent || ''));
  await page.unroute('**/api/account/password', holdPassword);
  for (const input of await accountForm().locator('input[type=password]').all()) assert.equal(await input.inputValue(), '', 'successful password form is cleared');
  assert.equal((await api(context, '/auth/me')).user.id, user.id, 'current session retained');
  assert.equal((await request(otherSession, '/auth/me')).status(), 401, 'other pre-existing session revoked');
  assert.equal((await request(loginProbe, '/auth/me')).status(), 401, 'all other pre-existing sessions revoked');
  checks.push('请求未结束时重复提交只写一次；改密成功清空密码输入，保留当前会话并撤销其它会话。');

  mark('desktop and phone account layout');
  for (const width of [1440, 390, 360]) { await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 }); await measure(`account-${width}`); }
  checks.push('1440px桌面、390px和360px手机布局无横向溢出，头像与密码控件均可使用。');

  mark('merged health profile, review and data routes');
  await closeSettings(); await page.locator('[data-action=settings-tab][data-tab=profile]').click();
  await page.locator('#personal-review .stats').waitFor();
  assert.match(await page.locator('#settings-content').textContent(), /阶段记录/);
  assert.match(await page.locator('#personal-review').textContent(), /体重趋势/);
  assert(await page.locator('[data-action=ai-review]').isVisible());
  await shot('health-360');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.evaluate(() => { location.hash = '#settings?section=review'; });
  await page.waitForFunction(() => document.querySelector('#settings-content')?.dataset.setting === 'review');
  await page.locator('#personal-review .stats').waitFor();
  assert.equal(await page.locator('[data-tab=profile]').getAttribute('aria-current'), 'page');
  await page.evaluate(() => { location.hash = '#settings?section=data'; });
  await page.locator('#personal-data [data-action=export]').waitFor();
  assert.equal(await page.locator('[data-tab=home]').getAttribute('aria-current'), 'page');
  assert(await accountForm().isVisible());
  await closeSettings(); await page.locator('[data-tab=home]').click();
  await page.waitForFunction(() => document.querySelector('#settings-content')?.dataset.setting === 'home');
  assert.equal(await page.locator('.personal-management').count(), 0);
  assert.equal(await page.locator('[data-cm=profile-edit]').textContent(), '设置');
  await page.locator('.cm-author-heading h1').waitFor();
  await shot('home-360');
  await page.locator('[data-cm=profile-edit]').click(); await accountForm().waitFor();
  assert(await accountForm().isVisible());
  assert(await page.locator('#personal-data [data-action=export]').isVisible());
  await page.locator('#personal-data [data-action=sync]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(element => element.textContent.includes('同步完成')));
  assert(await accountForm().isVisible(), 'sync preserves the expanded management section');
  checks.push('健康档案同时显示阶段记录和复盘，旧复盘与数据入口可用；主页设置统一管理资料、账号及数据，手机布局无溢出。');

  await closeSettings();
  mark('new password browser login and old password rejection');
  assert.equal((await request(loginProbe, '/auth/login', 'POST', { email, password: oldPassword })).status(), 401, 'old password rejected after update');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('[data-action=logout]').click(); await page.locator('#auth-form').waitFor({ state: 'attached' });
  await page.evaluate(() => { location.hash = '#auth-entry'; }); await page.locator('#auth-form').waitFor();
  await page.locator('.auth-tabs [data-mode=login]').click(); await page.locator('#email').fill(email); await page.locator('#password').fill(newPassword);
  await page.locator('#auth-form [type=submit]').click(); await page.locator('.nav').waitFor(); await waitSidebar(secondAvatar.url);
  assert.equal((await api(context, '/auth/me')).user.id, user.id);
  checks.push('原密码失效；退出后通过真实登录表单使用新密码成功登录，头像仍保留。');

  assert.deepEqual(errors, [], 'No browser page errors'); await json('result', { passed: checks.length, checks, geometry, errors, dataDir }); console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (page) await shot('failure').catch(() => {}); await json('failure', { step, message: error.message, stack: error.stack, errors, geometry }); console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const release of releases) release(); for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
