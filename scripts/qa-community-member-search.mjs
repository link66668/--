// Member-search and profile-navigation acceptance in isolated Edge accounts/SQLite.
// Existing environment files, production .data and existing accounts are unused.
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
const dataDir = await mkdtemp(join(root, '.qa', 'community-member-search-'));
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir });
const base = `http://127.0.0.1:${server.address().port}`;
const contexts = [], checks = [], errors = [], geometry = [], memberWrites = [];
let browser, currentPage, step = 'setup';
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const mark = label => { step = label; console.log(label); };
const normalize = value => value.normalize('NFKC').trim().toLowerCase();
const api = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json(); assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`); return value;
};
const community = (context, path, method = 'GET', body) => api(context, '/community' + path, method, body);
const register = async (context, slug, nickname) => {
  const { user } = await api(context, '/auth/register', 'POST', { email: `member-search-${slug}@example.test`, password: 'isolated-member-search-qa-password', name: '账户 ' + slug });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 25, height: 172, weight: 68, sex: 'male', goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  const { profile } = await community(context, '/me/profile', 'PATCH', { nickname }); return { ...user, nickname, accountNumber: profile.accountNumber };
};
const newContext = async () => { const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } }); contexts.push(context); return context; };
const newPage = async context => {
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => { const path = new URL(value.url()).pathname; if (/\/api\/community\/groups\/[^/]+\/members\/[^/]+$/.test(path) && value.method() !== 'GET') memberWrites.push({ path, method: value.method(), body: value.postDataJSON() }); });
  return page;
};
const route = (page, hash) => page.evaluate(hash => { location.hash = hash; }, hash);
const action = (page, name) => page.locator(`[data-cm="${name}"]`);
const memberRow = (page, id) => page.locator(`.cm-group-member[data-user-id="${id}"]`);
const searchInput = page => page.locator('.cm-group-member-search-input');
const rows = page => page.locator('.cm-group-member-list > .cm-group-member');
const responseFor = (page, path, method) => page.waitForResponse(value => new URL(value.url()).pathname === '/api/community' + path && value.request().method() === method);
const successful = async promise => { const response = await promise, body = await response.json(); assert(response.ok(), JSON.stringify(body)); return body; };
const shot = (page, name) => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const closeAux = async page => {
  const dialog = page.locator('.cm-aux-dialog[open]'); if (await dialog.count()) await dialog.locator('[data-cm="aux-close"]').click(); await dialog.waitFor({ state: 'hidden' });
};
const openGroup = async (page, id) => { await route(page, '#community/messages/group/' + id); await page.locator(`.cm-group-chat .cm-chat-header [data-cm="group-info"][data-id="${id}"]`).waitFor(); };
const openMembers = async (page, id) => {
  await closeAux(page); await openGroup(page, id); await page.locator('.cm-group-chat .cm-chat-header [data-cm="group-info"]').click(); await page.locator('.cm-group-info-tabs').waitFor();
  await page.locator('.cm-group-info-tabs [data-cm="group-info-tab"][data-tab="members"]').click(); await searchInput(page).waitFor();
};
const expectIds = async (page, wanted) => {
  const actual = await rows(page).evaluateAll(elements => elements.map(element => element.dataset.userId).sort()); assert.deepEqual(actual, [...wanted].sort());
};
const filter = async (page, query, ids) => { await searchInput(page).fill(query); await expectIds(page, ids); };
const memberChange = async (page, groupId, userId, kind) => {
  const previous = await page.locator('.cm-group-info-dialog[open]').elementHandle();
  const pending = responseFor(page, `/groups/${groupId}/members/${userId}`, 'PATCH'); await memberRow(page, userId).locator(`[data-cm="group-member-${kind}"]`).click();
  const result = await successful(pending); assert.equal(result.member.id, userId); await page.waitForFunction(element => !element.isConnected, previous); await searchInput(page).waitFor(); return result.member;
};
const visitMember = async (page, user, own = false) => {
  await filter(page, user.accountNumber, [user.id]); const link = memberRow(page, user.id).locator('a.cm-group-member-profile');
  assert.equal(await link.getAttribute('href'), '#community/user/' + user.id); assert.equal(await link.getAttribute('data-id'), user.id);
  assert.equal(await link.getAttribute('aria-label'), '查看' + user.nickname + '的主页');
  const box = await link.boundingBox(); assert(box.width >= 43.5 && box.height >= 43.5, 'Member avatar has a 44px hit area');
  await link.click(); await page.locator('.cm-aux-dialog[open]').waitFor({ state: 'hidden' }); await page.locator('.cm-profile-copy h1').filter({ hasText: user.nickname }).waitFor();
  const hash = await page.evaluate(() => location.hash); assert(own ? /^#settings(?:\?|$)/.test(hash) || hash === '#community/user/' + user.id : hash === '#community/user/' + user.id, 'Member avatar navigates to its correct profile');
};
const measure = async (page, label) => {
  const value = await page.evaluate(() => {
    const rect = element => element?.getBoundingClientRect().toJSON(), dialog = document.querySelector('.cm-group-info-dialog[open]'), content = dialog?.querySelector('.cm-aux-content'), input = dialog?.querySelector('.cm-group-member-search-input');
    const targets = [...(dialog?.querySelectorAll('button,a[data-cm]') || [])].filter(element => !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, dialog: rect(dialog), input: rect(input), contentWidth: content && { client: content.clientWidth, scroll: content.scrollWidth }, targets: targets.map(element => ({ ...rect(element), action: element.dataset.cm || element.textContent.trim().slice(0, 25) })) };
  });
  assert(value.documentWidth <= value.width + 1, `${label}: document fits`); assert(value.dialog && value.dialog.left >= -1 && value.dialog.right <= value.width + 1 && value.dialog.bottom <= value.height + 1, `${label}: dialog fits`);
  assert(value.contentWidth.scroll <= value.contentWidth.client + 1, `${label}: no content overflow`);
  assert(value.input.width >= 44 && value.input.height >= 43.5 && value.input.left >= value.dialog.left && value.input.right <= value.dialog.right, `${label}: search remains usable`);
  for (const target of value.targets) assert(target.width >= 43.5 && target.height >= 43.5, `${label}: ${target.action} retains 44px`);
  geometry.push({ label, ...value }); return value;
};

try {
  mark('owner-admin-member-outsider-setup');
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const ownerContext = await newContext(), adminContext = await newContext(), memberContext = await newContext(), outsiderContext = await newContext();
  const owner = await register(ownerContext, 'owner', '群主 本人 QA'), admin = await register(adminContext, 'admin', 'Coach MIX QA');
  const member = await register(memberContext, 'member', 'Runner Sample QA'), outsider = await register(outsiderContext, 'outsider', 'Outside View QA');
  const group = (await community(ownerContext, '/groups', 'POST', { name: '成员搜索验收群', clientMutationId: randomUUID() })).group;
  for (const context of [adminContext, memberContext]) { const request = (await community(context, `/groups/${group.id}/join`, 'POST', {})).request; await community(ownerContext, `/groups/${group.id}/requests/${request.id}`, 'PATCH', { action: 'approve' }); }
  await community(ownerContext, `/groups/${group.id}/members/${admin.id}`, 'PATCH', { role: 'admin' });
  await community(outsiderContext, `/users/${owner.id}/follow`, 'PUT', { active: true });
  assert.equal((await outsiderContext.request.get(base + `/api/community/groups/${group.id}/members`)).status(), 404);
  const ownerPage = await newPage(ownerContext), adminPage = await newPage(adminContext), memberPage = await newPage(memberContext), outsiderPage = await newPage(outsiderContext); currentPage = ownerPage;
  await ownerPage.goto(base + '/#community/messages/group/' + group.id); await adminPage.goto(base + '/#community/messages/group/' + group.id); await memberPage.goto(base + '/#community/messages/group/' + group.id); await outsiderPage.goto(base + '/#community/messages/groups');
  const allIds = [owner.id, admin.id, member.id];

  mark('immediate-nickname-account-clear-and-empty-filter');
  await openMembers(ownerPage, group.id); await expectIds(ownerPage, allIds);
  await searchInput(ownerPage).pressSequentially('  cOaCh mIx  '); assert.equal(await searchInput(ownerPage).inputValue(), '  cOaCh mIx  '); await expectIds(ownerPage, [admin.id]);
  assert(await searchInput(ownerPage).evaluate(element => document.activeElement === element), 'Typing retains input focus');
  await filter(ownerPage, 'Ｒｕｎｎｅｒ', [member.id]); await filter(ownerPage, '  ' + member.accountNumber + '  ', [member.id]);
  await filter(ownerPage, outsider.nickname, []); await ownerPage.locator('.cm-group-member-empty').waitFor(); await shot(ownerPage, 'no-matching-member');
  await action(ownerPage, 'group-member-search-clear').click(); assert.equal(await searchInput(ownerPage).inputValue(), ''); await expectIds(ownerPage, allIds);
  await filter(ownerPage, '   ', allIds); await filter(ownerPage, '', allIds); await measure(ownerPage, 'desktop-all-members'); await shot(ownerPage, 'desktop-all-members');
  checks.push('昵称即时筛选保留输入焦点，大小写/空格/全角字符正确归一；循序号匹配、无结果提示和清空恢复正常，群外用户不混入列表');

  mark('filtered-role-and-mute-actions-retain-correct-target-and-permissions');
  await filter(ownerPage, '  cOaCh MIX  ', [admin.id]); let changed = await memberChange(ownerPage, group.id, admin.id, 'role'); assert.equal(changed.role, 'member');
  assert.equal(normalize(await searchInput(ownerPage).inputValue()), normalize('Coach MIX')); await expectIds(ownerPage, [admin.id]);
  changed = await memberChange(ownerPage, group.id, admin.id, 'role'); assert.equal(changed.role, 'admin');
  const unchanged = (await community(ownerContext, `/groups/${group.id}/members`)).items; assert.equal(unchanged.find(row => row.id === owner.id).role, 'owner'); assert.equal(unchanged.find(row => row.id === member.id).role, 'member');
  await filter(ownerPage, member.accountNumber, [member.id]); changed = await memberChange(ownerPage, group.id, member.id, 'mute'); assert.equal(changed.muted, true); await expectIds(ownerPage, [member.id]);
  changed = await memberChange(ownerPage, group.id, member.id, 'mute'); assert.equal(changed.muted, false); await closeAux(ownerPage);
  currentPage = adminPage; await openMembers(adminPage, group.id); await filter(adminPage, member.nickname, [member.id]);
  assert.equal(await memberRow(adminPage, member.id).locator('[data-cm="group-member-role"],[data-cm="group-member-transfer"]').count(), 0);
  changed = await memberChange(adminPage, group.id, member.id, 'mute'); assert.equal(changed.muted, true); changed = await memberChange(adminPage, group.id, member.id, 'mute'); assert.equal(changed.muted, false);
  await filter(adminPage, owner.nickname, [owner.id]); assert.equal(await memberRow(adminPage, owner.id).locator('button').count(), 0, 'Admin cannot manage owner'); await closeAux(adminPage);
  currentPage = memberPage; await openMembers(memberPage, group.id); await filter(memberPage, admin.accountNumber, [admin.id]); assert.equal(await memberRow(memberPage, admin.id).locator('button').count(), 0, 'Member search exposes no management actions'); await closeAux(memberPage);
  for (const value of memberWrites) assert(value.path.endsWith('/' + admin.id) || value.path.endsWith('/' + member.id), 'Filtered management writes target actual selected row IDs');
  checks.push('筛选后群主任免管理员和禁言、管理员禁言均作用于正确成员；重载保留查询；管理员不能操作群主/任免角色，普通成员没有管理控件');

  mark('member-avatar-own-and-other-profile-navigation');
  currentPage = ownerPage; await openMembers(ownerPage, group.id); await visitMember(ownerPage, owner, true); await openMembers(ownerPage, group.id); await visitMember(ownerPage, member);
  currentPage = memberPage; await openMembers(memberPage, group.id); await visitMember(memberPage, member, true); await openMembers(memberPage, group.id); await visitMember(memberPage, admin);
  checks.push('群主和成员点击本人/他人头像均关闭管理弹窗并进入正确个人主页，头像链接44px');

  mark('desktop-phone-search-member-controls-and-avatar-layout');
  currentPage = ownerPage;
  for (const width of [1440, 390, 320]) {
    await ownerPage.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await openMembers(ownerPage, group.id); await filter(ownerPage, '', allIds); await measure(ownerPage, `members-${width}`); await shot(ownerPage, `members-${width}`);
    await filter(ownerPage, member.accountNumber, [member.id]); await measure(ownerPage, `filtered-${width}`); await shot(ownerPage, `filtered-${width}`);
    await visitMember(ownerPage, member); await openMembers(ownerPage, group.id); assert.equal(normalize(await searchInput(ownerPage).inputValue()), normalize(member.accountNumber)); await closeAux(ownerPage);
  }
  checks.push('1440/390/320成员列表、筛选输入与管理按钮无溢出，头像/清空/管理44px可点，手机头像导航和重新打开查询恢复正常');

  mark('group-fans-and-private-message-entries-remain-usable');
  await ownerPage.setViewportSize({ width: 1440, height: 1000 }); await route(ownerPage, '#community/messages'); await ownerPage.locator('.cm-groups-layout').waitFor({ state: 'hidden' }); await ownerPage.locator('.cm-message-tabs a[href="#community/messages/groups"]').waitFor();
  assert.equal(await ownerPage.locator('.cm-messages-sidebar [data-cm="group-create"],.cm-messages-sidebar [data-cm="group-join"]').count(), 0);
  await ownerPage.locator('.cm-message-tabs a[href="#community/messages/groups"]').click(); await action(ownerPage, 'group-create').waitFor(); await action(ownerPage, 'group-join').waitFor();
  await openGroup(ownerPage, group.id); await ownerPage.locator('.cm-group-chat .cm-chat-header [data-cm="group-info"]').click(); await ownerPage.locator('.cm-group-info-tabs').waitFor(); await action(ownerPage, 'group-invite').click(); await ownerPage.locator('[data-cm="group-invite-source"][data-source="fans"]').click();
  const fan = ownerPage.locator(`[data-cm="group-invite-pick"][data-id="${outsider.id}"]`); await fan.waitFor(); await fan.click(); assert.equal(await fan.getAttribute('aria-pressed'), 'true'); await closeAux(ownerPage);
  const conversation = (await community(ownerContext, '/messages/conversations', 'POST', { userId: member.id })).conversation;
  await route(ownerPage, '#community/messages/' + conversation.id); await ownerPage.locator('#cm-message-input').waitFor(); await ownerPage.locator('#cm-message-input').fill('成员搜索更新后私信正常。');
  const sending = responseFor(ownerPage, `/messages/conversations/${conversation.id}/messages`, 'POST'); await ownerPage.locator('.cm-message-send').click(); const privateMessage = (await successful(sending)).message;
  await route(memberPage, '#community/messages/' + conversation.id); await memberPage.locator(`.cm-message[data-message-id="${privateMessage.id}"]`).waitFor();
  checks.push('私信隐藏建群/加群、群页入口和真实粉丝邀请选人保持正常，私信发送与对方接收不受成员搜索影响');
  assert.deepEqual(errors, [], 'No browser errors'); await json('geometry', geometry); await json('member-writes', memberWrites); await json('result', { passed: checks.length, checks, errors, dataDir }); console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (currentPage) await shot(currentPage, 'failure').catch(() => {}); await json('geometry', geometry); await json('failure', { step, message: error.message, stack: error.stack, errors }); console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {}); await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
