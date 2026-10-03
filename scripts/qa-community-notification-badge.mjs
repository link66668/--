// Notification-number acceptance using isolated Edge accounts and a fresh SQLite directory.
// Even the 99+ case uses real API-created notifications; production .data is never opened.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.QA_PLAYWRIGHT, join(root, '.qa/community-tools/node_modules/playwright/index.mjs'), join(root, '精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean);
const playwrightPath = candidates.find(path => existsSync(path));
if (!playwrightPath) throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 的路径。');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'community-notification-badge-'));
const moderatorEmail = 'notification-badge-owner@example.test';
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, communityModeratorEmails: [moderatorEmail] });
const base = `http://127.0.0.1:${server.address().port}`;
const contexts = [], checks = [], errors = [], geometry = [], reads = [];
let browser, page, step = 'setup';
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const mark = label => { step = label; console.log(label); };
const api = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json(); assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`); return value;
};
const community = (context, path, method = 'GET', body) => api(context, '/community' + path, method, body);
const register = async (context, slug, nickname) => {
  const { user } = await api(context, '/auth/register', 'POST', { email: `notification-badge-${slug}@example.test`, password: 'isolated-notification-badge-qa-password', name: nickname });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 25, height: 172, weight: 68, sex: 'male', goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  await community(context, '/me/profile', 'PATCH', { nickname }); return user;
};
const newContext = async () => { const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } }); contexts.push(context); return context; };
const route = hash => page.evaluate(hash => { location.hash = hash; }, hash);
const shot = name => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const waitBadge = count => page.waitForFunction(count => {
  const badge = document.querySelector('.cm-notifications-link .cm-unread-dot');
  return badge && badge.hidden === (count === 0) && badge.textContent === (count ? count > 99 ? '99+' : String(count) : '') && badge.parentElement.getAttribute('aria-label') === '互动通知' + (count ? '，' + count + '条未读' : '');
}, count);
const reloadFeed = async count => { await page.goto(base + '/#community'); await page.reload(); await waitBadge(count); await page.locator('.cm-moderation-link').waitFor(); };
const readResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/community/notifications/read' && response.request().method() === 'PUT');
const openNotifications = async () => { await route('#community/notifications?type=all'); await page.locator('.cm-notification').first().waitFor(); };
const markAll = async count => {
  const pending = readResponse(); await page.locator('[data-cm="notifications-read"]').click(); const response = await pending, value = await response.json();
  assert(response.ok(), JSON.stringify(value)); assert.equal(value.unreadCount, count); await waitBadge(count); return value;
};
const measure = async (label, expected, messageCount) => {
  const value = await page.evaluate(() => {
    const rect = element => element?.getBoundingClientRect().toJSON(), badge = document.querySelector('.cm-notifications-link .cm-unread-dot'), toolbar = document.querySelector('.cm-toolbar');
    const style = getComputedStyle(badge), links = [...toolbar.querySelectorAll('.cm-messages-link,.cm-notifications-link,.cm-moderation-link')];
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, toolbar: rect(toolbar), toolbarScroll: toolbar.scrollWidth, toolbarClient: toolbar.clientWidth, badge: { ...rect(badge), text: badge.textContent, scroll: badge.scrollWidth, client: badge.clientWidth, color: style.color, background: style.backgroundColor, overflow: style.overflow, textOverflow: style.textOverflow }, links: links.map(element => ({ ...rect(element), className: element.className, label: element.getAttribute('aria-label'), hit: (() => { const bounds = element.getBoundingClientRect(), target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); return !!target && element.contains(target); })() })), message: { text: document.querySelector('.cm-message-unread')?.textContent, hidden: document.querySelector('.cm-message-unread')?.hidden } };
  });
  assert(value.documentWidth <= value.width + 1, `${label}: document fits`); assert(value.toolbarScroll <= value.toolbarClient + 1, `${label}: toolbar fits`);
  assert.equal(value.badge.text, expected > 99 ? '99+' : String(expected)); assert(value.badge.left >= -1 && value.badge.right <= value.width + 1 && value.badge.top >= -1, `${label}: full badge stays in viewport`);
  assert(value.badge.client >= value.badge.scroll, `${label}: badge text is not clipped`); assert.equal(value.badge.color, 'rgb(255, 255, 255)'); assert.notEqual(value.badge.background, 'rgba(0, 0, 0, 0)');
  for (const link of value.links) assert(link.width >= 43.5 && link.height >= 43.5 && link.left >= -1 && link.right <= value.width + 1 && link.hit, `${label}: ${link.className} is available with 44px`);
  for (let i = 0; i < value.links.length; i++) for (let j = i + 1; j < value.links.length; j++) { const a = value.links[i], b = value.links[j]; assert(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, `${label}: message, notification and moderator links do not overlap`); }
  if (messageCount) { assert.equal(value.message.text, String(messageCount)); assert.equal(value.message.hidden, false); }
  geometry.push({ label, expected, ...value });
};
const screenshotWidths = async (count, prefix, messageCount = 0) => {
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await waitBadge(count); await measure(prefix + '-' + width, count, messageCount); await shot(prefix + '-' + width); }
};

try {
  mark('isolated-owner-and-two-actors-no-unread');
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const ownerContext = await newContext(), bobContext = await newContext(), carolContext = await newContext();
  const owner = await register(ownerContext, 'owner', '通知数字验收'), bob = await register(bobContext, 'bob', '真实关注与评论者'), carol = await register(carolContext, 'carol', '第二位评论者');
  const note = (await community(ownerContext, '/notes', 'POST', { clientMutationId: randomUUID(), type: 'text', title: '未读数字验收笔记', body: '仅存在于隔离测试目录，用真实互动生成通知。', category: 'training', topics: [], media: [] })).note;
  page = await ownerContext.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/community/notifications/read') reads.push(request.postDataJSON()); });
  await page.goto(base + '/#community'); await waitBadge(0); assert.equal((await community(ownerContext, '/notifications')).unreadCount, 0); await shot('no-unread');
  checks.push('真实新账号无未读时隐藏铃铛计数，aria不带未读数量');

  mark('real-follow-single-and-real-comments-multiple-digits');
  await community(bobContext, `/users/${owner.id}/follow`, 'PUT', { active: true }); await reloadFeed(1); await screenshotWidths(1, 'single-unread');
  for (const [context, name, count] of [[bobContext, 'Bob', 5], [carolContext, 'Carol', 6]]) for (let i = 0; i < count; i++) await community(context, `/notes/${note.id}/comments`, 'POST', { body: `${name} 初始评论 ${i}`, clientMutationId: randomUUID() });
  assert.equal((await community(ownerContext, '/notifications')).unreadCount, 12); await reloadFeed(12); await screenshotWidths(12, 'multiple-unread');
  checks.push('真实关注产生1，真实评论累计12；1440/390/320显示完整数字，消息和管理员入口44px且互不挤压');

  mark('read-one-notification-decrements-live-count');
  await route('#community/notifications?type=follow'); const follow = page.locator('.cm-notification.unread').first(); await follow.waitFor(); const pending = readResponse(); await follow.click();
  const singleReadResponse = await pending, singleRead = await singleReadResponse.json(); assert(singleReadResponse.ok()); assert.equal(singleRead.unreadCount, 11); await waitBadge(11);
  assert.equal((await community(ownerContext, '/notifications')).unreadCount, 11); await page.locator('.cm-profile-copy h1').filter({ hasText: '真实关注与评论者' }).waitFor(); await shot('after-partial-read');
  checks.push('页面打开一条关注通知后数字12减为11，API与aria一致');

  mark('failed-mark-all-retains-count-and-retry-hides');
  await openNotifications(); let failRead = true;
  await page.route('**/api/community/notifications/read', async intercepted => { if (failRead && intercepted.request().method() === 'PUT') { failRead = false; await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离QA：已读暂不可用' }) }); } else await intercepted.continue(); });
  const failing = readResponse(); await page.locator('[data-cm="notifications-read"]').click(); assert.equal((await failing).status(), 503); await waitBadge(11);
  assert.equal((await community(ownerContext, '/notifications')).unreadCount, 11); assert(await page.locator('.cm-notification.unread').count() > 0); await shot('read-failed');
  await markAll(0); assert.equal((await community(ownerContext, '/notifications')).unreadCount, 0); await route('#community'); await waitBadge(0); await shot('after-all-read'); await page.unroute('**/api/community/notifications/read');
  checks.push('已读503失败保留11与未读行，重试真实all:true清空数字并隐藏');

  mark('real-over-99-notifications-and-message-unread-layout');
  // Each actor stays within the existing 60 comments / 10 minutes limit (59 and 60 total).
  for (const [context, name] of [[bobContext, 'Bob'], [carolContext, 'Carol']]) for (let i = 0; i < 54; i++) await community(context, `/notes/${note.id}/comments`, 'POST', { body: `${name} 大数量评论 ${i}`, clientMutationId: randomUUID() });
  assert.equal((await community(ownerContext, '/notifications')).unreadCount, 108);
  const conversation = (await community(bobContext, '/messages/conversations', 'POST', { userId: owner.id })).conversation;
  for (let i = 0; i < 12; i++) await community(bobContext, `/messages/conversations/${conversation.id}/messages`, 'POST', { body: '独立私信未读 ' + i, clientMutationId: randomUUID() });
  await reloadFeed(108); await page.waitForFunction(() => document.querySelector('.cm-message-unread')?.textContent === '12'); await screenshotWidths(108, 'over-99-unread', 12);
  checks.push('108条真实API通知显示99+，aria完整108；与12条真实私信和管理员入口同时存在，三种宽度数字均不截断、不溢出');

  mark('real-api-subset-read-returns-to-99-and-final-clear');
  const last = await community(ownerContext, '/notifications?limit=20'); const subset = last.items.filter(item => !item.read).slice(0, 9).map(item => item.id); assert.equal(subset.length, 9);
  assert.equal((await community(ownerContext, '/notifications/read', 'PUT', { ids: subset })).unreadCount, 99); await reloadFeed(99); await screenshotWidths(99, 'exact-99-unread', 12);
  await openNotifications(); await markAll(0); assert.equal((await community(ownerContext, '/notifications')).unreadCount, 0); await route('#community'); await waitBadge(0);
  assert.equal(await page.locator('.cm-message-unread').textContent(), '12'); await shot('final-zero-notifications-private-unread-retained');
  checks.push('真实API部分已读108减到99显示99；页面全部已读覆盖多页后隐藏通知数字，独立私信12未读保持');
  assert.deepEqual(errors, [], 'No browser errors'); await json('geometry', geometry); await json('read-requests', reads); await json('result', { passed: checks.length, checks, errors, dataDir, notificationSeed: { method: 'real HTTP API', single: 1, multiple: 12, maximum: 108, noDirectSQLiteWrites: true } }); console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (page) await shot('failure').catch(() => {}); await json('geometry', geometry); await json('failure', { step, message: error.message, stack: error.stack, errors }); console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
