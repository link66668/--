// Message avatar/navigation acceptance in Edge with temporary accounts and SQLite.
// Production .data, environment files and existing account/session data are unused.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const dataDir = await mkdtemp(join(root, '.qa', 'community-message-avatars-'));
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
const base = `http://127.0.0.1:${server.address().port}`;
const contexts = [], checks = [], errors = [], geometry = [], viewers = new Map();
let browser, currentPage, step = 'setup';
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const mark = label => { step = label; console.log(label); };
const api = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json(); assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`); return value;
};
const community = (context, path, method = 'GET', body) => api(context, '/community' + path, method, body);
const register = async (context, slug, nickname) => {
  const { user } = await api(context, '/auth/register', 'POST', { email: `message-avatars-${slug}@example.test`, password: 'isolated-message-avatars-qa-password', name: '账户 ' + slug });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 25, height: 172, weight: 68, sex: 'male', goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  await community(context, '/me/profile', 'PATCH', { nickname }); return { ...user, nickname };
};
const pageFor = async (context, user) => { const page = await context.newPage(); viewers.set(page, user.id); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); return page; };
const route = (page, hash) => page.evaluate(hash => { location.hash = hash; }, hash);
const shot = (page, name) => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const dmRow = (page, id) => page.locator(`.cm-message[data-message-id="${id}"]`);
const groupRow = (page, id) => page.locator(`.cm-group-message[data-group-message-id="${id}"]`);
const responseFor = (page, path, method) => page.waitForResponse(response => new URL(response.url()).pathname === '/api/community' + path && response.request().method() === method);
const successful = async promise => { const response = await promise, body = await response.json(); assert(response.ok(), JSON.stringify(body)); return body; };
const closeAux = async page => { const button = page.locator('.cm-aux-dialog[open] [data-cm="aux-close"]'); if (await button.count()) await button.click(); };
const openDm = async (page, id, messageId) => { await route(page, '#community/messages/' + id); await page.locator('#cm-message-input').waitFor(); if (messageId) await dmRow(page, messageId).waitFor(); };
const openGroup = async (page, id, messageId) => { await route(page, '#community/messages/group/' + id); await page.locator('#cm-group-message-input').waitFor(); if (messageId) await groupRow(page, messageId).waitFor(); };
const publicLink = async (row, user, label) => {
  const link = row.locator('a.cm-message-avatar'); assert.equal(await link.count(), 1, `${label}: exactly one message avatar`);
  assert.equal(await link.getAttribute('href'), '#community/user/' + user.id);
  assert.equal(await link.getAttribute('aria-label'), `查看${user.nickname}的主页`);
  if (user.image) assert.equal(await link.locator('img.cm-avatar').count(), 1, `${label}: current community picture is displayed`);
  else assert.equal(await link.locator('.cm-avatar-letter').count(), 1, `${label}: letter avatar is displayed`);
  const rect = await link.boundingBox(); assert(rect.width >= 43.5 && rect.height >= 43.5, `${label}: 44px avatar hit area`);
  return link;
};
const visitAvatar = async (page, row, user, label) => {
  const link = await publicLink(row, user, label); await link.scrollIntoViewIfNeeded(); await link.click();
  await page.locator('.cm-profile-copy h1').filter({ hasText: user.nickname }).waitFor();
  const hash = await page.evaluate(() => location.hash);
  assert(hash === '#community/user/' + user.id || (viewers.get(page) === user.id && /^#settings(?:\?|$)/.test(hash)), `${label}: correct profile route ${hash}`);
  if (user.image) await page.locator('.cm-profile-avatar img').waitFor();
};
const chatHeader = async page => {
  assert.equal(await page.locator('.cm-messages-pane .cm-chat-header a[href="#community"]').count(), 0, 'Chat header has no duplicate return-home link');
  assert.equal(await page.locator('.cm-messages-heading a[href="#community"]').count(), 1, 'List header retains its return-home link');
  if (await page.locator('#cm-message-input').count()) assert.equal(await page.locator('.cm-messages-sidebar [data-cm="group-create"],.cm-messages-sidebar [data-cm="group-join"]').count(), 0, 'Active private chat hides group actions');
};
const listEntrances = async (page, kind) => {
  await route(page, kind === 'group' ? '#community/messages/groups' : '#community/messages');
  await page.locator('#cm-message-input,#cm-group-message-input').waitFor({ state: 'hidden' });
  await page.locator('.cm-messages-heading a[href="#community"]').waitFor();
  const tabs = page.locator('.cm-message-tabs'); await tabs.waitFor();
  await tabs.locator('a[href="#community/messages"]').waitFor(); await tabs.locator('a[href="#community/messages/groups"]').waitFor();
  const create = page.locator('.cm-messages-sidebar [data-cm="group-create"]').filter({ hasText: '创建群' });
  const join = page.locator('.cm-messages-sidebar [data-cm="group-join"]').filter({ hasText: '加入群' });
  if (kind === 'group') { await create.waitFor(); await join.waitFor(); }
  else { assert.equal(await create.count(), 0, 'Private list hides create-group control'); assert.equal(await join.count(), 0, 'Private list hides join-group control'); }
  const home = page.locator('.cm-messages-heading a[href="#community"]'); assert(await home.isVisible());
  return { create, join };
};
const measure = async (page, label) => {
  const result = await page.evaluate(() => {
    const rect = element => element?.getBoundingClientRect().toJSON();
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const layout = document.querySelector('.cm-messages-layout'), list = document.querySelector('.cm-messages-pane .cm-message-list'), input = document.querySelector('#cm-message-input,#cm-group-message-input'), send = document.querySelector('.cm-message-send,.cm-group-send');
    const avatars = [...document.querySelectorAll('.cm-message-avatar')].filter(visible);
    const buttons = [...document.querySelectorAll('.cm-messages-layout button,.cm-messages-layout .cm-message-tabs a,.cm-messages-heading .cm-return-home')].filter(element => visible(element) && !element.disabled);
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, layout: rect(layout), layoutWidth: layout && { client: layout.clientWidth, scroll: layout.scrollWidth }, listWidth: list && { client: list.clientWidth, scroll: list.scrollWidth }, input: rect(input), send: rect(send), avatars: avatars.map(element => ({ ...rect(element), href: element.getAttribute('href') })), buttons: buttons.map(element => ({ ...rect(element), name: element.dataset.cm || element.textContent.trim() })) };
  });
  assert(result.documentWidth <= result.viewport.width + 1, `${label}: document does not overflow`);
  if (result.layoutWidth) assert(result.layoutWidth.scroll <= result.layoutWidth.client + 1, `${label}: message layout does not overflow`);
  if (result.listWidth) assert(result.listWidth.scroll <= result.listWidth.client + 1, `${label}: long messages stay inside the scroll pane`);
  for (const box of [...result.avatars, ...result.buttons]) assert(box.width >= 43.5 && box.height >= 43.5, `${label}: every avatar/control is 44px (${box.name || box.href}: ${box.width}x${box.height})`);
  if (result.send) assert(result.send.bottom <= result.viewport.height + 1 && result.send.left >= 0 && result.send.right <= result.viewport.width + 1, `${label}: send stays in view`);
  geometry.push({ label, ...result }); return result;
};
const sendUi = async (page, path, body, group = false) => {
  await page.locator(group ? '#cm-group-message-input' : '#cm-message-input').fill(body);
  const pending = responseFor(page, path, 'POST'); await page.locator(group ? '.cm-group-send' : '.cm-message-send').click(); return (await successful(pending)).message;
};
const failAndRetry = async (page, context, path, group, user) => {
  let failedPayload;
  const failure = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); failedPayload = intercepted.request().postDataJSON(); await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA 暂时发送失败' }) }); };
  await page.route('**/api/community' + path, failure);
  await page.locator(group ? '#cm-group-message-input' : '#cm-message-input').fill(group ? '群消息失败后重试' : '私信失败后重试');
  await page.locator(group ? '.cm-group-send' : '.cm-message-send').click();
  const failed = page.locator(group ? '.cm-group-message[data-group-mutation]' : '.cm-message[data-mutation-id]');
  await failed.locator(`[data-cm="${group ? 'group-message-retry' : 'message-retry'}"]`).waitFor();
  await publicLink(failed, user, group ? 'failed group avatar' : 'failed DM avatar');
  await measure(page, group ? 'group-failed-row' : 'dm-failed-row'); await shot(page, group ? 'group-failed-row' : 'dm-failed-row');
  const retry = failed.locator(`[data-cm="${group ? 'group-message-retry' : 'message-retry'}"]`);
  const retryGeometry = await retry.evaluate(button => {
    const box = button.getBoundingClientRect(), pane = button.closest('.cm-message-list').getBoundingClientRect();
    return { button: box.toJSON(), pane: pane.toJSON(), hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button };
  });
  geometry.push({ label: group ? 'group-retry-visibility' : 'dm-retry-visibility', ...retryGeometry });
  assert(retryGeometry.hit, 'Failed-message retry is clickable before automatic scrolling');
  assert(retryGeometry.button.top >= retryGeometry.pane.top - 1 && retryGeometry.button.bottom <= retryGeometry.pane.bottom + 1, 'The full retry target is visible above the composer');
  await page.unroute('**/api/community' + path, failure);
  const retrying = responseFor(page, path, 'POST'); await failed.locator(`[data-cm="${group ? 'group-message-retry' : 'message-retry'}"]`).click();
  const message = (await successful(retrying)).message; assert.equal(message.clientMutationId, failedPayload.clientMutationId);
  const rows = (await community(context, path)).items; assert.equal(rows.filter(row => row.clientMutationId === failedPayload.clientMutationId).length, 1);
  const savedRow = group ? groupRow(page, message.id) : dmRow(page, message.id); await savedRow.waitFor();
  await publicLink(savedRow, user, 'retry acknowledgement avatar');
};

try {
  mark('isolated-accounts-and-avatar-types');
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const aliceContext = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } }), bobContext = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } }); contexts.push(aliceContext, bobContext);
  const alice = await register(aliceContext, 'alice', '图片头像 QA'), bob = await register(bobContext, 'bob', '字母头像 QA');
  const imageResponse = await aliceContext.request.post(base + '/api/community/media?purpose=avatar', { headers: { 'Content-Type': 'image/webp', 'X-Filename': 'avatar.webp' }, data: await readFile(join(root, 'tests/fixtures/community-tiny-vp8l.webp')) });
  assert(imageResponse.ok()); const avatarMedia = (await imageResponse.json()).media;
  await community(aliceContext, '/me/profile', 'PATCH', { avatarMediaId: avatarMedia.id }); alice.image = true;
  const conversation = (await community(aliceContext, '/messages/conversations', 'POST', { userId: bob.id })).conversation;
  const dmPath = `/messages/conversations/${conversation.id}/messages`;
  const dmAlice = (await community(aliceContext, dmPath, 'POST', { body: '来自图片头像一方的私信', clientMutationId: randomUUID() })).message;
  const dmBob = (await community(bobContext, dmPath, 'POST', { body: '来自字母头像一方的私信', clientMutationId: randomUUID() })).message;
  await community(aliceContext, dmPath, 'POST', { body: '私信长消息：' + '训练计划和恢复都很重要。'.repeat(25), clientMutationId: randomUUID() });
  await community(bobContext, dmPath, 'POST', { body: 'LongUnbrokenMessage'.repeat(24), clientMutationId: randomUUID() });
  const alicePage = await pageFor(aliceContext, alice), bobPage = await pageFor(bobContext, bob); currentPage = alicePage;
  await alicePage.goto(base + '/#community/messages'); await bobPage.goto(base + '/#community/messages');

  mark('private-message-entries-and-both-avatar-links');
  await listEntrances(alicePage, 'dm'); await measure(alicePage, 'desktop-private-list'); await shot(alicePage, 'desktop-private-list');
  await openDm(alicePage, conversation.id, dmAlice.id); await chatHeader(alicePage); await publicLink(dmRow(alicePage, dmBob.id), bob, 'peer DM');
  await visitAvatar(alicePage, dmRow(alicePage, dmAlice.id), alice, 'own DM image'); await openDm(alicePage, conversation.id, dmBob.id);
  await visitAvatar(alicePage, dmRow(alicePage, dmBob.id), bob, 'peer DM letter'); await openDm(alicePage, conversation.id, dmBob.id);
  await openDm(bobPage, conversation.id, dmAlice.id);
  await visitAvatar(bobPage, dmRow(bobPage, dmAlice.id), alice, 'reverse DM peer image'); await openDm(bobPage, conversation.id, dmBob.id);
  await visitAvatar(bobPage, dmRow(bobPage, dmBob.id), bob, 'reverse DM own letter'); await openDm(bobPage, conversation.id, dmBob.id);
  await measure(alicePage, 'desktop-private-chat'); await shot(alicePage, 'desktop-private-chat');
  checks.push('私信列表和会话均隐藏创建/加入群入口，保留私信/群聊切换；双方图片/字母头像均有44px个人主页链接，本人和对方导航正确');

  mark('create-group-from-group-list-and-group-avatar-links');
  const { create } = await listEntrances(alicePage, 'group'); await create.click();
  const createForm = alicePage.locator('[data-cm-form="group-create"]'); await createForm.locator('[name="name"]').fill('消息头像验收群');
  const creating = responseFor(alicePage, '/groups', 'POST'); await createForm.locator('[type="submit"]').click(); const group = (await successful(creating)).group; await closeAux(alicePage);
  const request = (await community(bobContext, `/groups/${group.id}/join`, 'POST', {})).request;
  await community(aliceContext, `/groups/${group.id}/requests/${request.id}`, 'PATCH', { action: 'approve' });
  const groupPath = `/groups/${group.id}/messages`;
  const groupAlice = (await community(aliceContext, groupPath, 'POST', { body: '来自群主图片头像的群消息', clientMutationId: randomUUID() })).message;
  const groupBob = (await community(bobContext, groupPath, 'POST', { body: '来自成员字母头像的群消息', clientMutationId: randomUUID() })).message;
  await community(aliceContext, groupPath, 'POST', { body: '群聊长消息：' + '训练后补水并安排恢复。'.repeat(28), clientMutationId: randomUUID() });
  await community(bobContext, groupPath, 'POST', { body: 'LongUnbrokenGroupMessage'.repeat(22), clientMutationId: randomUUID() });
  await openGroup(alicePage, group.id, groupAlice.id); await chatHeader(alicePage);
  await visitAvatar(alicePage, groupRow(alicePage, groupAlice.id), alice, 'own group image'); await openGroup(alicePage, group.id, groupBob.id);
  await visitAvatar(alicePage, groupRow(alicePage, groupBob.id), bob, 'peer group letter'); await openGroup(alicePage, group.id, groupBob.id);
  await openGroup(bobPage, group.id, groupAlice.id); await visitAvatar(bobPage, groupRow(bobPage, groupAlice.id), alice, 'reverse group peer'); await openGroup(bobPage, group.id, groupBob.id);
  await visitAvatar(bobPage, groupRow(bobPage, groupBob.id), bob, 'reverse group own'); await openGroup(bobPage, group.id, groupBob.id);
  await measure(alicePage, 'desktop-group-chat'); await shot(alicePage, 'desktop-group-chat');
  checks.push('可从群聊列表实际建群，私信隐藏创建和加入群按钮；群内双方图片/字母头像进入本人/他人主页；群聊和私信会话头均移除右侧返回首页，列表入口保留');

  mark('desktop-and-phone-message-layout');
  for (const width of [390, 320]) {
    await alicePage.setViewportSize({ width, height: 844 });
    await listEntrances(alicePage, 'dm'); await measure(alicePage, `mobile-${width}-private-list`); await shot(alicePage, `mobile-${width}-private-list`);
    await openDm(alicePage, conversation.id, dmBob.id); await chatHeader(alicePage); await measure(alicePage, `mobile-${width}-private-chat`); await shot(alicePage, `mobile-${width}-private-chat`);
    await visitAvatar(alicePage, dmRow(alicePage, dmBob.id), bob, `mobile ${width} private avatar`); await openDm(alicePage, conversation.id, dmBob.id);
    const phoneDm = await sendUi(alicePage, dmPath, `手机私信发送 ${width}`); await dmRow(alicePage, phoneDm.id).waitFor(); await publicLink(dmRow(alicePage, phoneDm.id), alice, 'phone DM sent avatar');
    await listEntrances(alicePage, 'group'); await measure(alicePage, `mobile-${width}-group-list`); await shot(alicePage, `mobile-${width}-group-list`);
    await openGroup(alicePage, group.id, groupBob.id); await chatHeader(alicePage); await measure(alicePage, `mobile-${width}-group-chat`); await shot(alicePage, `mobile-${width}-group-chat`);
    await visitAvatar(alicePage, groupRow(alicePage, groupBob.id), bob, `mobile ${width} group avatar`); await openGroup(alicePage, group.id, groupBob.id);
    const phoneGroup = await sendUi(alicePage, groupPath, `手机群消息发送 ${width}`, true); await groupRow(alicePage, phoneGroup.id).waitFor(); await publicLink(groupRow(alicePage, phoneGroup.id), alice, 'phone group sent avatar');
  }
  checks.push('1440桌面及390/320手机私信/群聊、列表入口、长中文与无空格消息无横向溢出；头像和按钮44px，发送控件可见并能实际发送');

  mark('failed-message-avatars-and-retry');
  await openDm(alicePage, conversation.id, dmAlice.id); await failAndRetry(alicePage, aliceContext, dmPath, false, alice);
  await openGroup(alicePage, group.id, groupAlice.id); await failAndRetry(alicePage, aliceContext, groupPath, true, alice);
  checks.push('私信与群聊失败消息仍显示本人可点击头像，重试按钮可用，沿用唯一键且仅保存一次');
  assert.deepEqual(errors, [], 'No browser page errors'); await json('geometry', geometry);
  await json('result', { passed: checks.length, checks, errors, dataDir }); console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (currentPage) await shot(currentPage, 'failure').catch(() => {});
  await json('geometry', geometry); await json('failure', { step, message: error.message, stack: error.stack, errors }); console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
