// Group-chat acceptance in isolated Edge accounts and a fresh SQLite data dir.
// No production account, environment file, session file or .data is accessed.
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
const dataDir = await mkdtemp(join(root, '.qa', 'community-groups-'));
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
const base = `http://127.0.0.1:${server.address().port}`;
const password = 'community-groups-isolated-qa-password';
const checks = [], errors = [], contexts = [], geometry = [], writes = [], groups = [];
let browser, currentPage, step = 'setup';
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const mark = label => { step = label; console.log(label); };
const raw = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json(); return { response, status: response.status(), body: value };
};
const api = async (context, path, method = 'GET', body) => {
  const result = await raw(context, path, method, body);
  assert(result.response.ok(), `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
};
const community = (context, path, method = 'GET', body) => api(context, '/community' + path, method, body);
const denied = async (context, path, method = 'GET', body, statuses = [403, 404]) => {
  const result = await raw(context, '/community' + path, method, body);
  assert(statuses.includes(result.status), `${method} ${path} must reject access: ${result.status} ${JSON.stringify(result.body)}`);
  return result;
};
const makeContext = async options => { const context = await browser.newContext({ reducedMotion: 'reduce', ...options }); contexts.push(context); return context; };
const makePage = async context => {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/community\/groups(?:\/|$)/.test(new URL(request.url()).pathname)) writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null }); });
  return page;
};
const register = async (context, slug, name) => {
  const { user } = await api(context, '/auth/register', 'POST', { email: `groups-qa-${slug}@example.test`, password, name });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 25, height: 172, weight: 68, sex: 'male', goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  const { profile } = await community(context, '/me/profile');
  return { ...user, accountNumber: profile.accountNumber };
};
const screenshot = (page, name) => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const route = (page, hash) => page.evaluate(hash => { location.hash = hash; }, hash);
const form = (page, kind) => page.locator(`[data-cm-form="${kind}"]`);
const action = (page, name) => page.locator(`[data-cm="${name}"]`);
const closeAux = async page => { const close = page.locator('.cm-aux-dialog[open] [data-cm="aux-close"]'); if (await close.count()) { await close.click(); await page.locator('.cm-aux-dialog[open]').waitFor({ state: 'hidden' }); } };
const responseFor = (page, path, method) => page.waitForResponse(response => new URL(response.url()).pathname === '/api/community' + path && response.request().method() === method);
const successfulResponse = async pending => { const response = await pending, body = await response.json(); assert(response.ok(), `${response.status()} ${JSON.stringify(body)}`); return body; };
const confirmAction = async page => {
  const confirmation = form(page, 'group-confirm'); await confirmation.waitFor();
  await confirmation.locator('[type="submit"]').click();
};
const managedDialog = async (page, oldDialog) => {
  await page.waitForFunction(element => !element.isConnected, oldDialog);
  await page.locator('.cm-group-info-dialog[open] .cm-group-info-tabs').waitFor();
};
const openGroup = async (page, id) => {
  await route(page, '#community/messages/group/' + id);
  await page.locator('#cm-group-message-input').waitFor();
  await page.locator(`.cm-group-chat .cm-chat-header [data-cm="group-info"][data-id="${id}"]`).waitFor();
  await page.waitForFunction(id => location.hash.endsWith('/group/' + id), id);
};
const openList = async page => {
  await route(page, '#community/messages/groups');
  await page.locator('#cm-group-message-input').waitFor({ state: 'hidden' });
  await action(page, 'group-join').waitFor();
};
const openInfo = async (page, tab = 'about') => {
  await page.locator('.cm-group-chat .cm-chat-header [data-cm="group-info"]').click(); await page.locator('.cm-group-info-dialog[open]').waitFor();
  await page.locator('.cm-group-info-dialog[open] .cm-group-info-tabs').waitFor();
  if (tab !== 'about') await page.locator(`.cm-group-info-tabs [data-cm="group-info-tab"][data-tab="${tab}"]`).click();
};
const memberRow = (page, id) => page.locator(`.cm-group-member[data-user-id="${id}"]`);
const members = async (context, id) => (await community(context, `/groups/${id}/members`)).items;
const groupInfo = async (context, id) => (await community(context, `/groups/${id}`)).group;
const sentMessage = value => value.message;
const checkGeometry = async (page, label) => {
  const result = await page.evaluate(() => {
    const rect = element => element?.getBoundingClientRect().toJSON();
    const layout = document.querySelector('.cm-groups-layout'), input = document.querySelector('#cm-group-message-input'), send = document.querySelector('.cm-group-send'), dialog = document.querySelector('.cm-aux-dialog[open]'), content = dialog?.querySelector('.cm-aux-content');
    const visible = [...document.querySelectorAll('.cm-groups-layout button,.cm-groups-layout a[data-cm],.cm-aux-dialog[open] button,.cm-aux-dialog[open] a[data-cm]')].filter(element => !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, layout: rect(layout), layoutWidth: layout && { client: layout.clientWidth, scroll: layout.scrollWidth }, dialog: rect(dialog), contentWidth: content && { client: content.clientWidth, scroll: content.scrollWidth }, input: rect(input), inputFontSize: input && parseFloat(getComputedStyle(input).fontSize), send: rect(send), targets: visible.map(element => ({ action: element.dataset.cm || element.textContent.trim().slice(0, 20), ...rect(element) })) };
  });
  assert(result.documentWidth <= result.viewport.width + 1, `${label}: no document overflow ${JSON.stringify(result)}`);
  if (result.layoutWidth) assert(result.layoutWidth.scroll <= result.layoutWidth.client + 1, `${label}: no group layout overflow`);
  if (result.dialog) assert(result.dialog.left >= -1 && result.dialog.right <= result.viewport.width + 1, `${label}: dialog fits the viewport`);
  if (result.contentWidth) assert(result.contentWidth.scroll <= result.contentWidth.client + 1, `${label}: dialog content has no horizontal overflow`);
  for (const target of result.targets) assert(target.width >= 43.5 && target.height >= 43.5, `${label}: ${target.action} retains a 44px hit area (${target.width}x${target.height})`);
  if (result.input) assert(result.input.left >= -1 && result.input.right <= result.viewport.width + 1 && result.input.bottom <= result.viewport.height + 1, `${label}: composer stays visible inside the viewport`);
  if (result.input && result.viewport.width <= 700) assert(result.inputFontSize >= 16, `${label}: phone input avoids focus zoom`);
  geometry.push({ label, ...result }); return result;
};
const lookupAndApply = async (page, group) => {
  await action(page, 'group-join').click(); await form(page, 'group-join').waitFor();
  await form(page, 'group-join').locator('[name="groupNumber"]').fill(group.groupNumber);
  await form(page, 'group-join').locator('[type="submit"]').click();
  const apply = page.locator(`[data-cm="group-apply"][data-id="${group.id}"]`); await apply.waitFor();
  const pending = responseFor(page, `/groups/${group.id}/join`, 'POST'); await apply.click();
  const result = await successfulResponse(pending); assert.equal(result.status, 'pending'); await closeAux(page); return result.request;
};
const reviewRequest = async (page, groupId, requestId, verdict) => {
  await openInfo(page, 'requests');
  const oldDialog = await page.locator('.cm-group-info-dialog[open]').elementHandle();
  const pending = responseFor(page, `/groups/${groupId}/requests/${requestId}`, 'PATCH');
  await page.locator(`[data-cm="group-request-${verdict}"][data-id="${requestId}"]`).click();
  await successfulResponse(pending); await managedDialog(page, oldDialog); await closeAux(page);
};
const groupMessage = async (page, groupId, body, { enter = false } = {}) => {
  await page.locator('#cm-group-message-input').fill(body);
  const pending = responseFor(page, `/groups/${groupId}/messages`, 'POST');
  if (enter) await page.locator('#cm-group-message-input').press('Enter'); else await page.locator('.cm-group-send').click();
  return sentMessage(await successfulResponse(pending));
};
const seeMessage = (page, id) => page.locator(`.cm-group-message-list [data-group-message-id="${id}"]`).waitFor();
const memberChange = async (page, groupId, userId, kind) => {
  await openInfo(page, 'members');
  const oldDialog = await page.locator('.cm-group-info-dialog[open]').elementHandle();
  const pending = responseFor(page, `/groups/${groupId}/members/${userId}`, kind === 'remove' ? 'DELETE' : 'PATCH');
  await memberRow(page, userId).locator(`[data-cm="group-member-${kind}"]`).click();
  let refreshSource = oldDialog;
  if (await form(page, 'group-confirm').count()) { refreshSource = await page.locator('.cm-aux-dialog[open]').elementHandle(); await confirmAction(page); }
  const result = await successfulResponse(pending); await managedDialog(page, refreshSource); await closeAux(page); return result;
};
const profileChange = async (page, groupId, values) => {
  await openInfo(page);
  const profile = form(page, 'group-profile');
  const oldDialog = await page.locator('.cm-group-info-dialog[open]').elementHandle();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'boolean') await profile.locator(`[name="${name}"]`).setChecked(value);
    else await profile.locator(`[name="${name}"]`).fill(value);
  }
  const pending = responseFor(page, `/groups/${groupId}`, 'PATCH'); await profile.locator('[type="submit"]').click();
  const result = await successfulResponse(pending); await managedDialog(page, oldDialog); await closeAux(page); return result.group;
};
const waitCanSend = (page, wanted) => page.waitForFunction(wanted => document.querySelector('#cm-group-message-input')?.disabled === !wanted, wanted);
const newMessageBody = body => ({ body, clientMutationId: randomUUID() });

try {
  mark('four-isolated-accounts');
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const ownerContext = await makeContext({ viewport: { width: 1440, height: 1000 } });
  const adminContext = await makeContext({ viewport: { width: 1440, height: 1000 } });
  const memberContext = await makeContext({ viewport: { width: 1440, height: 1000 } });
  const outsiderContext = await makeContext({ viewport: { width: 1440, height: 1000 } });
  const owner = await register(ownerContext, 'owner', '群主 QA'), admin = await register(adminContext, 'admin', '管理员 QA');
  const member = await register(memberContext, 'member', '普通成员 QA'), outsider = await register(outsiderContext, 'outsider', '群外用户 QA');
  const ownerPage = await makePage(ownerContext), adminPage = await makePage(adminContext), memberPage = await makePage(memberContext), outsiderPage = await makePage(outsiderContext);
  for (const page of [ownerPage, adminPage, memberPage, outsiderPage]) { await page.goto(base + '/#community/messages/groups'); await action(page, 'group-create').waitFor(); }
  currentPage = ownerPage;

  mark('create-and-application-review');
  await action(ownerPage, 'group-create').click();
  await form(ownerPage, 'group-create').locator('[name="name"]').fill('循序群聊验收');
  await form(ownerPage, 'group-create').locator('[name="description"]').fill('四个隔离测试账号的训练交流群');
  await form(ownerPage, 'group-create').locator('[name="announcement"]').fill('欢迎交流训练计划，文明发言。');
  const creating = responseFor(ownerPage, '/groups', 'POST'); await form(ownerPage, 'group-create').locator('[type="submit"]').click();
  const group = (await successfulResponse(creating)).group; groups.push(group); assert.match(group.groupNumber, /^[1-9]\d{7}$/); assert.equal(group.role, 'owner');
  await closeAux(ownerPage); await openGroup(ownerPage, group.id);
  const memberRequest = await lookupAndApply(memberPage, group);
  await reviewRequest(ownerPage, group.id, memberRequest.id, 'approve');
  assert.equal((await groupInfo(memberContext, group.id)).role, 'member');
  const outsiderRequest = await lookupAndApply(outsiderPage, group);
  await reviewRequest(ownerPage, group.id, outsiderRequest.id, 'reject');
  assert.equal((await community(ownerContext, `/groups/${group.id}/requests?status=rejected`)).items[0].user.id, outsider.id);
  await denied(outsiderContext, `/groups/${group.id}`); await denied(outsiderContext, `/groups/${group.id}/messages`);
  await denied(outsiderContext, `/groups/${group.id}/members`); await denied(outsiderContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('群外不能发送'));
  checks.push('建群产生八位群号；按号查询、申请、批准和拒绝；群外账号无法读取成员、会话或发言');

  mark('invitations-and-admin-appointment');
  await openInfo(ownerPage); await action(ownerPage, 'group-invite').click();
  await form(ownerPage, 'group-invite-search').locator('[name="q"]').fill(admin.accountNumber);
  await form(ownerPage, 'group-invite-search').locator('[type="submit"]').click();
  await ownerPage.locator(`[data-cm="group-invite-pick"][data-id="${admin.id}"]`).click();
  const inviting = responseFor(ownerPage, `/groups/${group.id}/invitations`, 'POST'); await action(ownerPage, 'group-invite-send').click();
  const adminInvitation = (await successfulResponse(inviting)).items[0]; await closeAux(ownerPage);
  await action(adminPage, 'group-invitations').click();
  const accepting = responseFor(adminPage, `/groups/invitations/${adminInvitation.id}`, 'PATCH');
  await adminPage.locator(`[data-cm="group-invitation-accept"][data-id="${adminInvitation.id}"]`).click(); await successfulResponse(accepting); await adminPage.locator('.cm-aux-dialog[open]').waitFor({ state: 'hidden' });
  const outsiderInvitation = (await community(memberContext, `/groups/${group.id}/invitations`, 'POST', { userIds: [outsider.id] })).items[0];
  await denied(ownerContext, `/groups/invitations/${outsiderInvitation.id}`, 'PATCH', { action: 'accept' });
  await action(outsiderPage, 'group-invitations').click();
  const declining = responseFor(outsiderPage, `/groups/invitations/${outsiderInvitation.id}`, 'PATCH');
  await outsiderPage.locator(`[data-cm="group-invitation-decline"][data-id="${outsiderInvitation.id}"]`).click(); await successfulResponse(declining); await closeAux(outsiderPage);
  await memberChange(ownerPage, group.id, admin.id, 'role');
  assert.equal((await members(ownerContext, group.id)).find(row => row.id === admin.id).role, 'admin');
  await openGroup(adminPage, group.id); await openGroup(memberPage, group.id);
  await denied(memberContext, `/groups/${group.id}`, 'PATCH', { announcement: '普通成员不能管理' });
  await denied(adminContext, `/groups/${group.id}/members/${owner.id}`, 'PATCH', { muted: true });
  await denied(adminContext, `/groups/${group.id}/members/${owner.id}`, 'DELETE', {});
  await denied(adminContext, `/groups/${group.id}/members/${member.id}`, 'PATCH', { role: 'admin' });
  await denied(adminContext, `/groups/${group.id}/transfer`, 'POST', { userId: member.id });
  await denied(adminContext, `/groups/${group.id}`, 'DELETE', {});
  await denied(ownerContext, `/groups/${group.id}/leave`, 'POST', {}, [409]);
  const updated = await profileChange(adminPage, group.id, { name: '循序训练交流群', description: '管理员维护后的群简介', announcement: '本周一起完成三次训练。' });
  assert.equal(updated.announcement, '本周一起完成三次训练。'); assert.equal((await groupInfo(memberContext, group.id)).name, updated.name);
  checks.push('成员邀请、本人接受/拒绝、群主任命管理员；管理员可维护资料公告且无法任免管理员、修改群主、转让或解散');

  mark('bidirectional-poll-and-mentions');
  const fromMember = await groupMessage(memberPage, group.id, '大家好，我加入训练群了。', { enter: true });
  await seeMessage(ownerPage, fromMember.id); await seeMessage(adminPage, fromMember.id);
  const fromAdmin = await groupMessage(adminPage, group.id, '欢迎，今天按计划开始。'); await seeMessage(memberPage, fromAdmin.id);
  await action(memberPage, 'group-mentions').click();
  await memberPage.locator(`[data-cm="group-mention-pick"][data-id="${admin.id}"]`).waitFor();
  assert.equal(await action(memberPage, 'group-mention-all').count(), 0, 'Member cannot choose @all');
  await memberPage.locator(`[data-cm="group-mention-pick"][data-id="${admin.id}"]`).click(); await closeAux(memberPage);
  const selectedMember = await groupMessage(memberPage, group.id, '@管理员 请帮我确认训练计划');
  assert.deepEqual(selectedMember.mentionUserIds, [admin.id]); assert.equal(selectedMember.mentionAll, false);
  await seeMessage(adminPage, selectedMember.id);
  await denied(memberContext, `/groups/${group.id}/messages`, 'POST', { ...newMessageBody('禁止普通成员提醒全体'), mentionAll: true });
  await openList(memberPage);
  await action(adminPage, 'group-mentions').click(); await action(adminPage, 'group-mention-all').click(); await closeAux(adminPage);
  const allMention = await groupMessage(adminPage, group.id, '@全体成员 明天晚上训练。'); assert.equal(allMention.mentionAll, true);
  const unread = await community(memberContext, '/groups/unread'); assert(unread.unreadCount > 0 && unread.mentionUnreadCount > 0, 'Unread mention counts survive while away from chat');
  await memberPage.locator(`.cm-group-row[data-group-id="${group.id}"]`).waitFor();
  assert.match(await memberPage.locator(`.cm-group-row[data-group-id="${group.id}"]`).innerText(), /@|提醒/);
  await openGroup(memberPage, group.id); await seeMessage(memberPage, allMention.id);
  await memberPage.waitForFunction(async base => { const result = await fetch(base + '/api/community/groups/unread').then(response => response.json()); return result.unreadCount === 0 && result.mentionUnreadCount === 0; }, base);
  assert.equal((await community(memberContext, `/groups/${group.id}/messages`)).items.find(row => row.id === allMention.id).mentionedMe, true);
  await openList(memberPage);
  await community(adminContext, `/groups/${group.id}/messages`, 'POST', { ...newMessageBody('需要读到的上一条@成员消息'), mentionUserIds: [member.id] });
  await community(memberContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('这条本人消息位于未读消息之后'));
  assert((await community(memberContext, '/groups/unread')).mentionUnreadCount > 0);
  await openGroup(memberPage, group.id);
  await memberPage.waitForFunction(async base => { const result = await fetch(base + '/api/community/groups/unread').then(response => response.json()); return result.unreadCount === 0 && result.mentionUnreadCount === 0; }, base);
  await screenshot(ownerPage, 'desktop-chat'); await screenshot(memberPage, 'member-mention');
  checks.push('双向群聊可轮询接收；普通成员可@成员但服务端拒绝@全体；管理员@全体产生提醒和未读，实际进入会话后清零');

  mark('draft-keyboard-send-race-and-retry');
  currentPage = memberPage;
  const input = memberPage.locator('#cm-group-message-input');
  await input.fill('输入法组词期间不发送');
  const countBeforeIme = writes.length;
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
  assert.equal(await input.inputValue(), '输入法组词期间不发送'); assert.equal(writes.length, countBeforeIme);
  await input.press('Shift+Enter'); assert((await input.inputValue()).includes('\n'));
  let releaseSend, capturedSend;
  const held = new Promise(resolve => { capturedSend = resolve; });
  const gate = new Promise(resolve => { releaseSend = resolve; });
  const holdSend = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); capturedSend(intercepted.request().postDataJSON()); await gate; await intercepted.continue(); };
  await memberPage.route(`**/api/community/groups/${group.id}/messages`, holdSend);
  await input.fill('正在发送的第一条消息'); const sending = responseFor(memberPage, `/groups/${group.id}/messages`, 'POST'); await memberPage.locator('.cm-group-send').click();
  const heldBody = await held; await input.fill('发送期间新输入的草稿'); releaseSend(); await successfulResponse(sending);
  await memberPage.waitForFunction(() => !document.querySelector('.cm-group-send')?.disabled);
  assert.equal(await input.inputValue(), '发送期间新输入的草稿'); await memberPage.unroute(`**/api/community/groups/${group.id}/messages`, holdSend);
  assert.equal((await community(memberContext, `/groups/${group.id}/messages`)).items.filter(row => row.clientMutationId === heldBody.clientMutationId).length, 1);
  await openList(memberPage); await openGroup(memberPage, group.id); assert.equal(await input.inputValue(), '发送期间新输入的草稿');
  await memberPage.reload(); await input.waitFor(); assert.equal(await input.inputValue(), '发送期间新输入的草稿');
  assert.notEqual(await adminPage.locator('#cm-group-message-input').inputValue(), '发送期间新输入的草稿', 'Draft is scoped to account');
  let failedPayload;
  const failOnce = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); failedPayload = intercepted.request().postDataJSON(); await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA 临时发送失败' }) }); };
  await memberPage.route(`**/api/community/groups/${group.id}/messages`, failOnce);
  await input.fill('失败后重试只保存一次'); await memberPage.locator('.cm-group-send').click();
  await memberPage.locator('[data-cm="group-message-retry"]').waitFor();
  await memberPage.unroute(`**/api/community/groups/${group.id}/messages`, failOnce);
  const retrying = responseFor(memberPage, `/groups/${group.id}/messages`, 'POST'); await action(memberPage, 'group-message-retry').click();
  const retried = (await successfulResponse(retrying)).message; assert.equal(retried.clientMutationId, failedPayload.clientMutationId);
  assert.equal((await community(memberContext, `/groups/${group.id}/messages`)).items.filter(row => row.clientMutationId === failedPayload.clientMutationId).length, 1);
  checks.push('Enter发送、Shift+Enter换行、输入法组合不发送；发送完成保留新输入；草稿跨导航/刷新且账号隔离；失败重试沿用唯一键且仅保存一次');

  mark('single-mute-all-mute-and-role-revocation');
  currentPage = adminPage;
  await memberChange(adminPage, group.id, member.id, 'mute'); await waitCanSend(memberPage, false);
  await denied(memberContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('个人禁言不能发送'));
  await screenshot(memberPage, 'member-muted');
  await memberChange(adminPage, group.id, member.id, 'mute'); await waitCanSend(memberPage, true);
  await profileChange(adminPage, group.id, { muteAll: true }); await waitCanSend(memberPage, false);
  await denied(memberContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('全员禁言不能发送'));
  const adminDuringMute = await groupMessage(adminPage, group.id, '全员禁言时管理员仍可发布公告消息。'); await seeMessage(ownerPage, adminDuringMute.id);
  await memberChange(ownerPage, group.id, admin.id, 'mute'); await waitCanSend(adminPage, false);
  await denied(adminContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('管理员个人禁言也不能发送'));
  await memberChange(ownerPage, group.id, admin.id, 'mute'); await waitCanSend(adminPage, true);
  await profileChange(ownerPage, group.id, { muteAll: false }); await waitCanSend(memberPage, true);
  await memberChange(ownerPage, group.id, admin.id, 'role');
  assert.equal((await groupInfo(adminContext, group.id)).role, 'member');
  await denied(adminContext, `/groups/${group.id}`, 'PATCH', { muteAll: true });
  await denied(adminContext, `/groups/${group.id}/members/${member.id}`, 'PATCH', { muted: true });
  await denied(adminContext, `/groups/${group.id}/messages`, 'POST', { ...newMessageBody('撤职即不可@全体'), mentionAll: true });
  await memberChange(ownerPage, group.id, admin.id, 'role');
  checks.push('管理员个人禁言/解除、全员禁言/解除；成员服务端拒发且UI禁用；管理员免全员禁言但个人禁言优先；撤职即时撤销管理与@全体权限');

  mark('desktop-and-mobile-geometry');
  currentPage = ownerPage; await checkGeometry(ownerPage, 'desktop-1440');
  await openInfo(ownerPage, 'members'); await checkGeometry(ownerPage, 'desktop-1440-member-management'); await screenshot(ownerPage, 'desktop-members'); await closeAux(ownerPage);
  const longMessage = await community(adminContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('手机端长消息换行验收：' + '训练计划和恢复同样重要。'.repeat(24)));
  await seeMessage(ownerPage, longMessage.message.id);
  for (const width of [390, 320]) {
    await ownerPage.setViewportSize({ width, height: 844 }); await checkGeometry(ownerPage, `mobile-${width}`); await screenshot(ownerPage, `mobile-${width}-chat`);
    await openList(ownerPage); await checkGeometry(ownerPage, `mobile-${width}-list`); await screenshot(ownerPage, `mobile-${width}-list`); await openGroup(ownerPage, group.id);
    await openInfo(ownerPage, 'members'); await checkGeometry(ownerPage, `mobile-${width}-members`); await screenshot(ownerPage, `mobile-${width}-members`); await closeAux(ownerPage);
    await action(ownerPage, 'group-mentions').click(); await action(ownerPage, 'group-mention-all').waitFor(); await checkGeometry(ownerPage, `mobile-${width}-mentions`); await screenshot(ownerPage, `mobile-${width}-mentions`); await closeAux(ownerPage);
    await ownerPage.setViewportSize({ width, height: 420 }); await ownerPage.locator('#cm-group-message-input').fill(`手机键盘 ${width}`); await ownerPage.locator('#cm-group-message-input').focus();
    await checkGeometry(ownerPage, `mobile-${width}-keyboard`);
    assert(await ownerPage.locator('.cm-group-send').evaluate(button => { const box = button.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.cm-group-send') === button; }), 'Phone send control is not obscured');
    await groupMessage(ownerPage, group.id, `手机端正常发送 ${width}`); await ownerPage.setViewportSize({ width, height: 844 });
  }
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });
  checks.push('1440桌面及390/320手机群聊、成员资料、提醒选择器无横向溢出；可点击操作44px；缩小键盘视口仍能输入和发送');

  mark('private-message-route-remains-usable');
  const conversation = (await community(ownerContext, '/messages/conversations', 'POST', { userId: member.id })).conversation;
  await route(ownerPage, '#community/messages/' + conversation.id); await ownerPage.locator('#cm-message-input').waitFor();
  await ownerPage.locator('#cm-message-input').fill('群聊上线后私信仍正常。');
  const privateSending = responseFor(ownerPage, `/messages/conversations/${conversation.id}/messages`, 'POST'); await ownerPage.locator('.cm-message-send').click();
  const privateMessage = (await successfulResponse(privateSending)).message;
  await route(memberPage, '#community/messages/' + conversation.id); await memberPage.locator(`.cm-message-list [data-message-id="${privateMessage.id}"]`).waitFor();
  await openGroup(ownerPage, group.id); await openGroup(memberPage, group.id);
  checks.push('原有私信路由、发送及对方接收正常，可往返群聊');

  mark('remove-rejoin-new-membership-epoch');
  currentPage = memberPage;
  const oldPage = await community(memberContext, `/groups/${group.id}/messages?limit=1`); assert(oldPage.hasMore && oldPage.nextCursor);
  const oldIds = (await community(memberContext, `/groups/${group.id}/messages`)).items.map(row => row.id);
  await memberChange(adminPage, group.id, member.id, 'remove');
  await denied(memberContext, `/groups/${group.id}`); await denied(memberContext, `/groups/${group.id}/messages`);
  await denied(memberContext, `/groups/${group.id}/messages`, 'POST', newMessageBody('踢出即撤权'));
  const unchangedHash = await memberPage.evaluate(() => location.hash);
  await waitCanSend(memberPage, false);
  const rejoin = await lookupAndApply(memberPage, group); await reviewRequest(ownerPage, group.id, rejoin.id, 'approve');
  assert.equal((await community(memberContext, `/groups/${group.id}/messages`)).items.length, 0, 'Rejoin cannot read old epoch history');
  await denied(memberContext, `/groups/${group.id}/messages?before=${encodeURIComponent(oldPage.nextCursor)}`, 'GET', undefined, [400]);
  await denied(memberContext, `/groups/${group.id}/messages?after=${oldIds.at(-1)}`, 'GET', undefined, [400]);
  const welcomeAgain = await groupMessage(ownerPage, group.id, '欢迎重新入群，只能看到本次入群后的消息。');
  await waitCanSend(memberPage, true); await seeMessage(memberPage, welcomeAgain.id);
  assert.equal(await memberPage.evaluate(() => location.hash), unchangedHash, 'An approved request recovers the current chat without navigation');
  for (const id of oldIds) assert.equal(await memberPage.locator(`.cm-group-message-list [data-group-message-id="${id}"]`).count(), 0, 'Browser discards old membership history');
  await screenshot(memberPage, 'member-recovered-request');
  await memberChange(adminPage, group.id, member.id, 'remove'); await waitCanSend(memberPage, false);
  const sameGroupInvite = (await community(ownerContext, `/groups/${group.id}/invitations`, 'POST', { userIds: [member.id] })).items[0];
  await action(memberPage, 'group-invitations').click();
  const reaccepting = responseFor(memberPage, `/groups/invitations/${sameGroupInvite.id}`, 'PATCH');
  await memberPage.locator(`[data-cm="group-invitation-accept"][data-id="${sameGroupInvite.id}"]`).click(); await successfulResponse(reaccepting); await closeAux(memberPage);
  const welcomeInvited = await groupMessage(ownerPage, group.id, '接受同群邀请后，当前页面自动恢复新入群会话。');
  await waitCanSend(memberPage, true); await seeMessage(memberPage, welcomeInvited.id);
  assert.equal(await memberPage.evaluate(() => location.hash), unchangedHash, 'Accepting the same group invite recovers the current hash');
  for (const id of [...oldIds, welcomeAgain.id]) assert.equal(await memberPage.locator(`.cm-group-message-list [data-group-message-id="${id}"]`).count(), 0, 'Accepting the same group invite discards previous membership messages');
  await screenshot(memberPage, 'member-recovered-invite');
  checks.push('管理员移除成员即时撤权；停留原聊天页再次申请获批或接受同群邀请均自动恢复新消息；旧分页游标和消息锚点无效，旧会话不回显');

  mark('transfer-leave-and-dissolve');
  currentPage = ownerPage; await openInfo(ownerPage, 'members');
  const transferring = responseFor(ownerPage, `/groups/${group.id}/transfer`, 'POST');
  await memberRow(ownerPage, admin.id).locator('[data-cm="group-member-transfer"]').click();
  const transferDialog = await ownerPage.locator('.cm-aux-dialog[open]').elementHandle();
  await confirmAction(ownerPage); await successfulResponse(transferring); await managedDialog(ownerPage, transferDialog); await closeAux(ownerPage);
  assert.equal((await groupInfo(ownerContext, group.id)).role, 'member'); assert.equal((await groupInfo(adminContext, group.id)).role, 'owner');
  await denied(ownerContext, `/groups/${group.id}`, 'DELETE', {});
  await openInfo(ownerPage); const leavingOwner = responseFor(ownerPage, `/groups/${group.id}/leave`, 'POST'); await action(ownerPage, 'group-leave').click(); await confirmAction(ownerPage); await successfulResponse(leavingOwner); await closeAux(ownerPage);
  await denied(ownerContext, `/groups/${group.id}/messages`);
  await openInfo(memberPage); const leavingMember = responseFor(memberPage, `/groups/${group.id}/leave`, 'POST'); await action(memberPage, 'group-leave').click(); await confirmAction(memberPage); await successfulResponse(leavingMember); await closeAux(memberPage);
  await denied(memberContext, `/groups/${group.id}/messages`);
  currentPage = adminPage; await openInfo(adminPage); const dissolving = responseFor(adminPage, `/groups/${group.id}`, 'DELETE'); await action(adminPage, 'group-delete').click(); await confirmAction(adminPage); await successfulResponse(dissolving); await closeAux(adminPage);
  await denied(adminContext, `/groups/${group.id}`);
  assert.equal((await community(outsiderContext, `/groups/search?q=${group.groupNumber}`)).items.length, 0); assert.equal((await community(adminContext, '/groups')).items.length, 0);
  checks.push('转让群主使原群主降为成员并可退出；普通成员可退出；新群主解散后所有会话访问及群号搜索撤销');
  assert.deepEqual(errors, [], 'No browser errors');
  await json('geometry', geometry); await json('writes', writes); await json('result', { passed: checks.length, checks, groups, errors, dataDir });
  console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (currentPage) await screenshot(currentPage, 'failure').catch(() => {});
  await json('geometry', geometry); await json('writes', writes); await json('failure', { step, message: error.message, stack: error.stack, errors });
  console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
