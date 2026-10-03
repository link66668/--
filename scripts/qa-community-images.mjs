// Real HTTP and Edge acceptance for private/group/comment/reply image attachments.
// Only temporary accounts and a freshly created .qa SQLite directory are used.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightPath = [process.env.QA_PLAYWRIGHT, join(root, '.qa/community-tools/node_modules/playwright/index.mjs'), join(root, '精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean).find(existsSync);
if (!playwrightPath) throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 的路径。');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'community-images-'));
const password = 'isolated-community-images-password';
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, communityModeratorEmails: ['community-images-alice@example.test'] });
const base = `http://127.0.0.1:${server.address().port}`;
const contexts = [], checks = [], errors = [], geometry = [], held = [];
const jpegPath = join(root, 'public/assets/exercises/squat.jpg');
const secondPath = join(root, 'public/assets/exercises/bench.jpg');
const jpeg = await readFile(jpegPath);
let browser, currentPage, step = 'setup';
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const mark = label => { step = label; console.log(label); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const api = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json(); assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`); return value;
};
const community = (context, path, method = 'GET', body) => api(context, '/community' + path, method, body);
const reject = async (context, path, method = 'GET', body, statuses = [400, 403, 404, 409, 422]) => {
  const response = await context.request.fetch(base + '/api/community' + path, { method, ...(body === undefined ? {} : { data: body }) });
  assert(statuses.includes(response.status()), `${method} ${path}: expected ${statuses}, received ${response.status()} ${await response.text()}`); return response.status();
};
const upload = async (context, data = jpeg, name = 'qa-image.jpg', type = 'image/jpeg', purpose = 'attachment') => {
  const response = await context.request.post(base + '/api/community/media?purpose=' + purpose, { headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name) }, data });
  const value = await response.json(); assert(response.ok(), `upload ${response.status()}: ${JSON.stringify(value)}`); assert.equal(value.media.purpose, purpose); return value.media;
};
const imageAccess = async (context, media, allowed, label, prefix = '/media/') => {
  const response = await context.request.get(base + '/api/community' + prefix + media.id);
  if (allowed) { assert(response.ok(), `${label}: ${response.status()}`); assert.match(response.headers()['content-type'], /^image\//); assert((await response.body()).length > 0); }
  else assert([403, 404].includes(response.status()), `${label}: private media returned ${response.status()}`);
};
const makeUser = async (slug, nickname) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } }); contexts.push(context);
  const { user } = await api(context, '/auth/register', 'POST', { email: `community-images-${slug}@example.test`, password, name: nickname });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 25, height: 172, weight: 68, sex: 'male', goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  await community(context, '/me/profile', 'PATCH', { nickname });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  return { context, page, ...user, nickname, email: `community-images-${slug}@example.test` };
};
const route = (page, hash) => page.evaluate(hash => { location.hash = hash; }, hash);
const shot = (page, name) => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const responseFor = (page, path, method = 'POST') => page.waitForResponse(response => new URL(response.url()).pathname === '/api/community' + path && response.request().method() === method);
const successful = async promise => { const response = await promise, value = await response.json(); assert(response.ok(), `${response.status()} ${JSON.stringify(value)}`); return value; };
const formFor = (page, kind) => page.locator(`[data-cm-form="${kind === 'dm' ? 'message' : kind === 'group' ? 'group-message' : 'comment'}"]`);
const rowFor = (page, kind, id) => page.locator(kind === 'dm' ? `.cm-message[data-message-id="${id}"]` : kind === 'group' ? `.cm-group-message[data-group-message-id="${id}"]` : `[data-comment="${id}"]`);
const openDm = async (page, id) => { await route(page, '#community/messages/' + id); await page.locator('#cm-message-input').waitFor(); };
const openGroup = async (page, id) => { await route(page, '#community/messages/group/' + id); await page.locator('#cm-group-message-input').waitFor(); };
const openNote = async (page, id) => { await route(page, '#community/note/' + id); await page.locator('.cm-detail-dialog .cm-detail-copy h1').waitFor(); await formFor(page, 'comment').locator('.cm-image-composer').waitFor(); };
const previews = (page, kind) => formFor(page, kind).locator('.cm-image-draft');
const choose = async (page, kind, paths = [jpegPath], total = paths.length) => {
  const form = formFor(page, kind); await form.locator('.cm-image-composer input[type="file"]').setInputFiles(paths);
  await page.waitForFunction(({ kind, total }) => {
    const name = kind === 'dm' ? 'message' : kind === 'group' ? 'group-message' : 'comment';
    const form = document.querySelector(`[data-cm-form="${name}"]`), rows = form?.querySelectorAll('.cm-image-draft');
    return rows?.length === total && [...rows].every(row => row.querySelector('.cm-image-upload-status')?.textContent === '已上传');
  }, { kind, total });
  return form;
};
const send = async (page, kind, path, body = '') => {
  const form = formFor(page, kind); await form.locator('textarea[name="body"]').fill(body);
  const pending = responseFor(page, path); await form.locator('[type="submit"]').click();
  const value = await successful(pending), item = value.message || value.comment;
  assert(item); await rowFor(page, kind, item.id).waitFor(); return item;
};
const loadedImages = async (row, count) => {
  await row.waitFor(); await row.locator('.cm-inline-images img').first().waitFor();
  assert.equal(await row.locator('.cm-inline-images img').count(), count);
  await row.locator('.cm-inline-images img').first().scrollIntoViewIfNeeded();
  await row.page().waitForFunction(({ selector, count }) => {
    const rows = [...document.querySelectorAll(selector + ' .cm-inline-images img')]; return rows.length === count && rows.every(image => image.complete && image.naturalWidth > 0);
  }, { selector: await row.evaluate(element => element.hasAttribute('data-message-id') ? `[data-message-id="${element.dataset.messageId}"]` : element.hasAttribute('data-group-message-id') ? `[data-group-message-id="${element.dataset.groupMessageId}"]` : `[data-comment="${element.dataset.comment}"]`), count });
};
const viewImages = async (page, row, count, label) => {
  await loadedImages(row, count); const first = row.locator('[data-cm="images-view"]').first(); await first.click();
  const viewer = page.locator('dialog.cm-image-viewer[open]'); await viewer.waitFor();
  await page.waitForFunction(() => { const image = document.querySelector('.cm-image-viewer img'); return image?.complete && image.naturalWidth > 0; });
  assert.equal(await viewer.locator('header > span').textContent(), `1 / ${count}`);
  if (count > 1) { await viewer.locator('[data-image-action="next"]').click(); assert.equal(await viewer.locator('header > span').textContent(), `2 / ${count}`); await viewer.press('ArrowLeft'); assert.equal(await viewer.locator('header > span').textContent(), `1 / ${count}`); }
  await measure(page, label + '-viewer'); await shot(page, label + '-viewer');
  await viewer.locator('[data-image-action="close"]').click(); await viewer.waitFor({ state: 'detached' }); assert(await row.isVisible());
};
const measure = async (page, label) => {
  const value = await page.evaluate(() => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const box = element => element.getBoundingClientRect().toJSON();
    const activeDialog = document.querySelector('dialog.cm-image-viewer[open]') || document.querySelector('.cm-detail-dialog[open]');
    const scope = activeDialog || document.querySelector('.cm-messages-layout') || document.body;
    const targets = [...scope.querySelectorAll('.cm-image-pick,[data-image-compose-action],.cm-message-send,.cm-group-send,.cm-comment-send,[data-image-action]')].filter(visible);
    const commentInput = scope.querySelector('#cm-comment-input');
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, dialog: activeDialog ? box(activeDialog) : null, commentInput: commentInput ? box(commentInput) : null, commentHasImages: !!scope.querySelector('[data-cm-form="comment"] .cm-image-tray:not([hidden])'), containers: [...scope.querySelectorAll('.cm-inline-images,.cm-image-tray,.cm-message-list,.cm-detail-layout,.cm-comment-compose,.cm-comment-image-composer')].map(element => ({ box: box(element), client: element.clientWidth, scroll: element.scrollWidth, tray: element.classList.contains('cm-image-tray'), parentClient: element.closest('form')?.clientWidth || element.parentElement.clientWidth })), targets: targets.map(element => ({ label: element.getAttribute('aria-label') || element.textContent.trim(), ...box(element) })) };
  });
  geometry.push({ label, ...value });
  assert(value.documentWidth <= value.viewport.width + 1, `${label}: horizontal page overflow`);
  if (value.dialog) assert(value.dialog.left >= -1 && value.dialog.right <= value.viewport.width + 1, `${label}: dialog fits viewport`);
  if (value.commentInput) assert(value.commentInput.width >= (value.commentHasImages ? 100 : 43.5), `${label}: comment input remains usable beside image/send controls`);
  for (const container of value.containers) {
    if (container.tray) assert(container.client <= container.parentClient + 1, `${label}: scrolling tray fits its composer`);
    else assert(container.scroll <= container.client + 1, `${label}: image/chat container overflow`);
  }
  for (const target of value.targets) assert(target.width >= 43.5 && target.height >= 43.5, `${label}: ${target.label} hit target ${target.width}x${target.height}`);
  return value;
};
const failedSend = async (user, kind, path, body) => {
  const page = user.page; await choose(page, kind); const form = formFor(page, kind); await form.locator('textarea[name="body"]').fill(body);
  let payload; const handler = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); payload = intercepted.request().postDataJSON(); await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA 临时发送失败' }) }); };
  await page.route('**/api/community' + path, handler); await form.locator('[type="submit"]').click();
  if (kind === 'comment') {
    await page.waitForFunction(() => !document.querySelector('[data-cm-form="comment"] [type=submit]')?.disabled);
    assert.equal(await form.locator('textarea[name="body"]').inputValue(), body); assert.equal(await previews(page, kind).count(), 1);
  } else {
    await page.locator(`[data-cm="${kind === 'dm' ? 'message-retry' : 'group-message-retry'}"]`).waitFor();
    const failedRow = page.locator(kind === 'dm' ? '.cm-message[data-mutation-id]' : '.cm-group-message[data-group-mutation]'); assert.equal(await failedRow.locator('.cm-inline-images img').count(), 1);
  }
  assert.equal(payload.imageIds.length, 1); await shot(page, kind + '-send-failed'); await page.unroute('**/api/community' + path, handler);
  const pending = responseFor(page, path), retryRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/community' + path && request.method() === 'POST');
  if (kind === 'comment') await form.locator('[type="submit"]').click(); else await page.locator(`[data-cm="${kind === 'dm' ? 'message-retry' : 'group-message-retry'}"]`).click();
  const value = await successful(pending), item = value.message || value.comment;
  const retriedPayload = (await retryRequest).postDataJSON();
  assert.equal(retriedPayload.clientMutationId, payload.clientMutationId, `${kind}: failed send reuses mutation`); assert.deepEqual(retriedPayload.imageIds, payload.imageIds); assert.equal(item.images[0].id, payload.imageIds[0]); await loadedImages(rowFor(page, kind, item.id), 1);
  const saved = (await community(user.context, path)).items; assert.equal(saved.filter(row => row.id === item.id).length, 1);
  const replay = await community(user.context, path, 'POST', retriedPayload); assert.equal((replay.message || replay.comment).id, item.id); return item;
};

try {
  mark('isolated accounts and targets');
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const alice = await makeUser('alice', '图片 QA Alice'), bob = await makeUser('bob', '图片 QA Bob'), carol = await makeUser('carol', '图片 QA Carol'), outsider = await makeUser('outsider', '图片 QA Outsider');
  currentPage = alice.page;
  const conversation = (await community(alice.context, '/messages/conversations', 'POST', { userId: bob.id })).conversation;
  const anotherConversation = (await community(alice.context, '/messages/conversations', 'POST', { userId: carol.id })).conversation;
  const dmPath = `/messages/conversations/${conversation.id}/messages`, otherDmPath = `/messages/conversations/${anotherConversation.id}/messages`;
  const group = (await community(alice.context, '/groups', 'POST', { name: '图片验收群', description: '隔离真实图片测试', clientMutationId: randomUUID() })).group;
  for (const member of [bob, carol]) { const request = (await community(member.context, `/groups/${group.id}/join`, 'POST', {})).request; await community(alice.context, `/groups/${group.id}/requests/${request.id}`, 'PATCH', { action: 'approve' }); }
  const groupPath = `/groups/${group.id}/messages`;
  const note = (await community(alice.context, '/notes', 'POST', { type: 'text', title: '图片评论与回复验收', body: '只使用隔离测试账号和图片。', category: 'training', topics: [], media: [], clientMutationId: randomUUID() })).note;
  const commentPath = `/notes/${note.id}/comments`;
  await json('seed', { dataDir, conversationId: conversation.id, anotherConversationId: anotherConversation.id, groupId: group.id, noteId: note.id, accountIds: { alice: alice.id, bob: bob.id, carol: carol.id, outsider: outsider.id } });

  mark('HTTP image-only/mixed messages and visibility');
  const dmImage = await upload(alice.context), groupImage = await upload(alice.context), commentImage = await upload(bob.context), replyImage = await upload(carol.context);
  await imageAccess(alice.context, dmImage, true, 'owner draft preview'); await imageAccess(bob.context, dmImage, false, 'unbound image is private');
  const dm = (await community(alice.context, dmPath, 'POST', { body: '', imageIds: [dmImage.id], clientMutationId: randomUUID() })).message;
  const groupMessage = (await community(alice.context, groupPath, 'POST', { body: '群聊文字和图片', imageIds: [groupImage.id], clientMutationId: randomUUID() })).message;
  const comment = (await community(bob.context, commentPath, 'POST', { body: '', imageIds: [commentImage.id], clientMutationId: randomUUID() })).comment;
  const reply = (await community(carol.context, commentPath, 'POST', { body: '带图片的子回复', parentId: comment.id, replyToCommentId: comment.id, imageIds: [replyImage.id], clientMutationId: randomUUID() })).comment;
  for (const item of [dm, groupMessage, comment, reply]) { assert.equal(item.images.length, 1); assert.equal(item.images[0].type, 'image/jpeg'); }
  await imageAccess(bob.context, dmImage, true, 'DM recipient can view'); await imageAccess(carol.context, dmImage, false, 'another conversation peer cannot view'); await imageAccess(outsider.context, dmImage, false, 'outsider cannot view DM image');
  await imageAccess(outsider.context, dmImage, false, 'managed alias cannot bypass private DM', '/me/media/');
  await imageAccess(bob.context, groupImage, true, 'current group member can view'); await imageAccess(outsider.context, groupImage, false, 'outsider cannot view group image');
  await imageAccess(outsider.context, commentImage, true, 'visible public comment image'); await imageAccess(outsider.context, replyImage, true, 'visible public reply image');
  await reject(bob.context, dmPath, 'POST', { body: '盗用他人图片', imageIds: [groupImage.id], clientMutationId: randomUUID() });
  await reject(alice.context, commentPath, 'POST', { imageIds: [dmImage.id], clientMutationId: randomUUID() });
  await reject(alice.context, dmPath, 'POST', { body: '', imageIds: [], clientMutationId: randomUUID() });
  await reject(alice.context, dmPath, 'POST', { imageIds: [dmImage.id, dmImage.id], clientMutationId: randomUUID() });
  await reject(alice.context, dmPath, 'POST', { imageIds: Array.from({ length: 10 }, () => randomUUID()), clientMutationId: randomUUID() });
  const replay = (await community(alice.context, dmPath, 'POST', { body: '', imageIds: [dmImage.id], clientMutationId: dm.clientMutationId })).message; assert.equal(replay.id, dm.id);
  await reject(alice.context, dmPath, 'POST', { body: '改变内容', imageIds: [dmImage.id], clientMutationId: dm.clientMutationId }, [409]);
  checks.push('HTTP 私信/群聊/评论/子回复纯图与混合图片成功；草稿及聊天图片私密权限、绑定唯一性、重复/超限、幂等重试通过');

  mark('real image previews, removal, private/group delivery and viewer');
  await alice.page.goto(base + '/#community/messages/' + conversation.id); await bob.page.goto(base + '/#community/messages/' + conversation.id);
  await formFor(alice.page, 'dm').locator('.cm-image-composer').waitFor();
  await choose(alice.page, 'dm', [jpegPath, secondPath], 2); await previews(alice.page, 'dm').first().locator('[data-image-compose-action="remove"]').click(); assert.equal(await previews(alice.page, 'dm').count(), 1);
  const sentDm = await send(alice.page, 'dm', dmPath, '预览移除后发送一张图片'); assert.equal(sentDm.images.length, 1); assert.equal(await previews(alice.page, 'dm').count(), 0);
  await rowFor(bob.page, 'dm', sentDm.id).waitFor(); await viewImages(bob.page, rowFor(bob.page, 'dm', sentDm.id), 1, 'private-image');
  await choose(alice.page, 'dm'); const pureDm = await send(alice.page, 'dm', dmPath); assert.equal(pureDm.body, ''); await loadedImages(rowFor(alice.page, 'dm', pureDm.id), 1);
  await openGroup(alice.page, group.id); await choose(alice.page, 'group'); const sentGroup = await send(alice.page, 'group', groupPath); assert.equal(sentGroup.body, '');
  await openGroup(bob.page, group.id); await rowFor(bob.page, 'group', sentGroup.id).waitFor(); await viewImages(bob.page, rowFor(bob.page, 'group', sentGroup.id), 1, 'group-image');
  const dmList = (await community(alice.context, '/messages/conversations')).items.find(item => item.id === conversation.id); assert(dmList.lastMessage); assert.match(JSON.stringify(dmList.lastMessage), /图片|image|images/);
  await route(alice.page, '#community/messages'); await alice.page.locator(`.cm-conversation-row[data-conversation-id="${conversation.id}"]`).waitFor();
  const summary = await alice.page.locator(`.cm-conversation-row`).filter({ hasText: bob.nickname }).textContent(); assert.match(summary, /图片/);
  checks.push('真实文件选择预览、移除、纯图/混合发送、收件方展示与大图关闭、私信列表图片摘要通过');

  mark('comment and nested reply image composers');
  await openNote(bob.page, note.id); await choose(bob.page, 'comment'); const uiComment = await send(bob.page, 'comment', commentPath); assert.equal(uiComment.body, '');
  await viewImages(bob.page, rowFor(bob.page, 'comment', uiComment.id), 1, 'comment-image');
  await rowFor(bob.page, 'comment', uiComment.id).locator('[data-cm="reply"]').first().click();
  await choose(bob.page, 'comment'); const uiReply = await send(bob.page, 'comment', commentPath); assert.equal(uiReply.parentId, uiComment.id); assert.equal(uiReply.body, '');
  await viewImages(bob.page, rowFor(bob.page, 'comment', uiReply.id), 1, 'reply-image'); assert(await bob.page.locator('.cm-detail-dialog').isVisible());
  checks.push('评论及子回复共用图片表单，纯图评论和带文字回复真实保存，大图关闭后原详情与回复仍可见');

  mark('nine-image limit and gallery navigation');
  const nine = [];
  for (let index = 0; index < 9; index++) nine.push(await upload(carol.context, jpeg, `gallery-${index}.jpg`));
  const gallery = (await community(carol.context, otherDmPath, 'POST', { body: '最多九张图片', imageIds: nine.map(media => media.id), clientMutationId: randomUUID() })).message;
  assert.equal(gallery.images.length, 9); await openDm(alice.page, anotherConversation.id); await rowFor(alice.page, 'dm', gallery.id).waitFor(); await viewImages(alice.page, rowFor(alice.page, 'dm', gallery.id), 9, 'nine-images');
  checks.push('9张附件真实上传和保存，九宫格、下一张及键盘上一张放大导航通过');

  mark('upload and send failures preserve images for retry');
  await openDm(bob.page, conversation.id); let failedUpload = false;
  const uploadFailure = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); failedUpload = true; await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA 上传暂时失败' }) }); };
  await bob.page.route('**/api/community/media?purpose=attachment', uploadFailure); await formFor(bob.page, 'dm').locator('input[type=file]').setInputFiles(jpegPath);
  await previews(bob.page, 'dm').locator('[data-image-compose-action="retry"]').waitFor(); assert(failedUpload); assert.equal(await previews(bob.page, 'dm').count(), 1);
  await bob.page.unroute('**/api/community/media?purpose=attachment', uploadFailure); await previews(bob.page, 'dm').locator('[data-image-compose-action="retry"]').click();
  await bob.page.waitForFunction(() => document.querySelector('[data-cm-form="message"] .cm-image-upload-status')?.textContent === '已上传');
  const retriedUpload = await send(bob.page, 'dm', dmPath, '失败上传重试仍使用所选图片'); await loadedImages(rowFor(bob.page, 'dm', retriedUpload.id), 1);
  await openDm(alice.page, conversation.id); await failedSend(alice, 'dm', dmPath, '私信图片失败后重试');
  await openGroup(alice.page, group.id); await failedSend(alice, 'group', groupPath, '群图片失败后重试');
  await openNote(bob.page, note.id); await failedSend(bob, 'comment', commentPath, '评论图片失败保留草稿');
  checks.push('上传失败保留本地缩略图并可重试；私信/群聊失败图片仍在待发项，评论失败保留图文草稿，重试沿用唯一键且仅保存一次');

  mark('conversation image drafts and delayed send acknowledgement');
  await openDm(alice.page, conversation.id); await choose(alice.page, 'dm'); await formFor(alice.page, 'dm').locator('textarea').fill('此图片只属于 Bob 会话');
  await openDm(alice.page, anotherConversation.id); assert.equal(await previews(alice.page, 'dm').count(), 0); assert.equal(await formFor(alice.page, 'dm').locator('textarea').inputValue(), '');
  await openDm(alice.page, conversation.id); assert.equal(await previews(alice.page, 'dm').count(), 1); assert.equal(await formFor(alice.page, 'dm').locator('textarea').inputValue(), '此图片只属于 Bob 会话');
  const ack = deferred(), reached = deferred(); held.push(ack);
  const holdSend = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); const response = await intercepted.fetch(); reached.resolve(); await ack.promise; await intercepted.fulfill({ response }); };
  await alice.page.route('**/api/community' + dmPath, holdSend); await formFor(alice.page, 'dm').locator('[type=submit]').click(); await reached.promise;
  await formFor(alice.page, 'dm').locator('textarea').fill('ACK期间新文字'); await choose(alice.page, 'dm', [secondPath], 2); ack.resolve();
  await alice.page.waitForFunction(() => document.querySelector('#cm-message-input')?.value === 'ACK期间新文字' && document.querySelectorAll('[data-cm-form="message"] .cm-image-draft').length === 1);
  await alice.page.unroute('**/api/community' + dmPath, holdSend); await previews(alice.page, 'dm').locator('[data-image-compose-action=remove]').click(); await formFor(alice.page, 'dm').locator('textarea').fill('');
  await openGroup(alice.page, group.id); await choose(alice.page, 'group'); await formFor(alice.page, 'group').locator('textarea').fill('群聊草稿图片');
  await openDm(alice.page, anotherConversation.id); assert.equal(await previews(alice.page, 'dm').count(), 0); await openGroup(alice.page, group.id); assert.equal(await previews(alice.page, 'group').count(), 1);
  checks.push('私信与群聊图片草稿按会话保存，切换不串图；发送ACK期间新增文字和图片均保留');

  mark('desktop and narrow-phone attachment layout');
  for (const width of [1440, 390, 320]) {
    await alice.page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await openGroup(alice.page, group.id); await loadedImages(rowFor(alice.page, 'group', sentGroup.id), 1); await measure(alice.page, `group-${width}`); await shot(alice.page, `group-${width}`);
    await openDm(alice.page, anotherConversation.id); await rowFor(alice.page, 'dm', gallery.id).waitFor(); await measure(alice.page, `private-${width}`); await shot(alice.page, `private-${width}`);
    await openNote(bob.page, note.id); await bob.page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await choose(bob.page, 'comment'); await measure(bob.page, `comment-${width}`); await shot(bob.page, `comment-${width}`); await previews(bob.page, 'comment').locator('[data-image-compose-action=remove]').click();
  }
  checks.push('1440/390/320私信九图、群聊图片草稿及评论图片预览无横向溢出，添加/移除/发送/大图操作至少44px');

  mark('nine pending comment images keep narrow-phone input usable');
  const previewUser = await makeUser('preview', '九图预览 QA'); currentPage = previewUser.page;
  await previewUser.page.goto(base + '/#community/note/' + note.id); await formFor(previewUser.page, 'comment').locator('.cm-image-composer').waitFor();
  const previewFiles = [...Array(7).fill(jpegPath), join(root, 'tests/fixtures/community-tiny-vp8.webp'), join(root, 'tests/fixtures/community-tiny-vp8l.webp')];
  await choose(previewUser.page, 'comment', previewFiles, 9);
  assert(await formFor(previewUser.page, 'comment').locator('input[type=file]').isDisabled(), 'Picker prevents a tenth image');
  for (const width of [1440, 390, 320]) { await previewUser.page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await measure(previewUser.page, `comment-nine-${width}`); await shot(previewUser.page, `comment-nine-${width}`); }
  const tray = formFor(previewUser.page, 'comment').locator('.cm-image-tray'); await tray.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const lastRemove = previews(previewUser.page, 'comment').last().locator('[data-image-compose-action=remove]');
  const ninthTarget = await lastRemove.evaluate(button => { const box = button.getBoundingClientRect(), tray = button.closest('.cm-image-tray').getBoundingClientRect(); return { box: box.toJSON(), tray: tray.toJSON(), hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button }; });
  assert(ninthTarget.hit && ninthTarget.box.width >= 43.5 && ninthTarget.box.height >= 43.5, 'The ninth thumbnail has a reachable 44px removal target');
  geometry.push({ label: 'comment-nine-last-remove-320', ...ninthTarget }); await lastRemove.click(); assert.equal(await previews(previewUser.page, 'comment').count(), 8);
  assert(await formFor(previewUser.page, 'comment').locator('input[type=file]').isEnabled()); await choose(previewUser.page, 'comment', [join(root, 'tests/fixtures/community-tiny-vp8l.webp')], 9);
  const nineComment = await send(previewUser.page, 'comment', commentPath, 'JPEG 与有损/无损 WebP 九张附件'); assert.equal(nineComment.images.length, 9); await loadedImages(rowFor(previewUser.page, 'comment', nineComment.id), 9);
  await measure(previewUser.page, 'comment-nine-sent-320'); await shot(previewUser.page, 'comment-nine-sent-320');
  checks.push('9张评论预览保留可用输入与发送区，320/390/1440无溢出；JPEG和有损/无损静态WebP均真实发送'); currentPage = alice.page;

  mark('mute, membership epochs, and deleted/hidden comment media');
  const forbiddenDraft = await upload(bob.context);
  await community(alice.context, `/groups/${group.id}/members/${bob.id}`, 'PATCH', { muted: true });
  await reject(bob.context, groupPath, 'POST', { imageIds: [forbiddenDraft.id], clientMutationId: randomUUID() }, [403]); await imageAccess(outsider.context, forbiddenDraft, false, 'muted send never publishes its draft');
  await community(alice.context, `/groups/${group.id}/members/${bob.id}`, 'PATCH', { muted: false }); await community(alice.context, `/groups/${group.id}`, 'PATCH', { muteAll: true });
  await reject(bob.context, groupPath, 'POST', { imageIds: [forbiddenDraft.id], clientMutationId: randomUUID() }, [403]); await openGroup(bob.page, group.id); await bob.page.waitForFunction(() => document.querySelector('#cm-group-message-input')?.disabled); assert(await formFor(bob.page, 'group').locator('input[type=file]').isDisabled());
  await community(alice.context, `/groups/${group.id}`, 'PATCH', { muteAll: false });
  await community(alice.context, `/groups/${group.id}/members/${bob.id}`, 'DELETE', {}); await imageAccess(bob.context, groupImage, false, 'removed member loses old group photo');
  const rejoin = (await community(bob.context, `/groups/${group.id}/join`, 'POST', {})).request; await community(alice.context, `/groups/${group.id}/requests/${rejoin.id}`, 'PATCH', { action: 'approve' });
  await imageAccess(bob.context, groupImage, false, 'new membership cannot view previous epoch photo');
  const report = (await community(outsider.context, '/reports', 'POST', { targetType: 'comment', targetId: comment.id, reason: 'other', description: '隔离测试隐藏图片评论', clientMutationId: randomUUID() })).report;
  await community(alice.context, `/moderation/reports/${report.id}`, 'PATCH', { action: 'hide', reason: '隔离图片权限验收' }); await imageAccess(outsider.context, commentImage, false, 'hidden comment image inaccessible'); await imageAccess(alice.context, commentImage, true, 'moderator can review hidden comment photo', '/moderation/media/');
  await community(alice.context, `/moderation/reports/${report.id}`, 'PATCH', { action: 'restore', reason: '隔离恢复' }); await community(bob.context, `/comments/${comment.id}`, 'DELETE', {}); await imageAccess(outsider.context, commentImage, false, 'deleted comment attachment inaccessible');
  checks.push('单人/全员禁言拒绝图片发送且预览保持私密；移除和重入撤销旧群图片；隐藏及删除评论图片不可公开读取，管理员审核权限正常');

  mark('private ACK does not erase edited-back text or a newer reopened draft');
  currentPage = outsider.page;
  const raceConversation = (await community(outsider.context, '/messages/conversations', 'POST', { userId: carol.id })).conversation;
  const raceOther = (await community(outsider.context, '/messages/conversations', 'POST', { userId: bob.id })).conversation;
  const racePath = `/messages/conversations/${raceConversation.id}/messages`;
  await outsider.page.goto(base + '/#community/messages/' + raceConversation.id); await formFor(outsider.page, 'dm').locator('.cm-image-composer').waitFor();
  const holdMessage = async () => {
    const gate = deferred(), reached = deferred(); held.push(gate); let payload;
    const handler = async intercepted => { if (intercepted.request().method() !== 'POST') return intercepted.continue(); payload = intercepted.request().postDataJSON(); const response = await intercepted.fetch(); reached.resolve(); await gate.promise; await intercepted.fulfill({ response }); };
    await outsider.page.route('**/api/community' + racePath, handler);
    const pending = responseFor(outsider.page, racePath); await formFor(outsider.page, 'dm').locator('[type=submit]').click(); await reached.promise;
    return { gate, payload, pending, handler };
  };
  await choose(outsider.page, 'dm'); await formFor(outsider.page, 'dm').locator('textarea').fill('修改后改回原文');
  const editBack = await holdMessage(); await formFor(outsider.page, 'dm').locator('textarea').fill('曾经改动的文字'); await formFor(outsider.page, 'dm').locator('textarea').fill('修改后改回原文'); await choose(outsider.page, 'dm', [secondPath], 2);
  editBack.gate.resolve(); const editBackMessage = (await successful(editBack.pending)).message; await rowFor(outsider.page, 'dm', editBackMessage.id).waitFor();
  await outsider.page.waitForFunction(() => document.querySelectorAll('[data-cm-form="message"] .cm-image-draft').length === 1);
  assert.equal(await formFor(outsider.page, 'dm').locator('textarea').inputValue(), '修改后改回原文');
  await outsider.page.unroute('**/api/community' + racePath, editBack.handler);
  await formFor(outsider.page, 'dm').locator('textarea').fill('重开前的旧发送'); const reopen = await holdMessage();
  await openDm(outsider.page, raceOther.id); await openDm(outsider.page, raceConversation.id); await formFor(outsider.page, 'dm').locator('textarea').fill('重开后保留的新草稿');
  if (await previews(outsider.page, 'dm').count()) await previews(outsider.page, 'dm').locator('[data-image-compose-action=remove]').click();
  await choose(outsider.page, 'dm'); await openDm(outsider.page, raceOther.id);
  const cacheKey = `fitness:community:${outsider.id}:message:${raceConversation.id}`;
  const beforeAck = await outsider.page.evaluate(key => JSON.parse(localStorage.getItem(key)), cacheKey); assert.equal(beforeAck.body, '重开后保留的新草稿'); assert.equal(beforeAck.images.length, 1);
  reopen.gate.resolve(); const reopenedMessage = (await successful(reopen.pending)).message; await outsider.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await outsider.page.unroute('**/api/community' + racePath, reopen.handler);
  const afterAck = await outsider.page.evaluate(key => JSON.parse(localStorage.getItem(key)), cacheKey); assert.equal(afterAck.body, beforeAck.body); assert.deepEqual(afterAck.images.map(image => image.id), beforeAck.images.map(image => image.id));
  await openDm(outsider.page, raceConversation.id); assert.equal(await formFor(outsider.page, 'dm').locator('textarea').inputValue(), beforeAck.body); assert.equal(await previews(outsider.page, 'dm').count(), 1);
  await outsider.page.reload(); await formFor(outsider.page, 'dm').locator('.cm-image-composer').waitFor(); assert.equal(await formFor(outsider.page, 'dm').locator('textarea').inputValue(), beforeAck.body); assert.equal(await previews(outsider.page, 'dm').count(), 1);
  await imageAccess(outsider.context, editBackMessage.images[0], true, 'previous ACK image remains accessible after reopening'); await imageAccess(carol.context, editBackMessage.images[0], true, 'recipient can view previous ACK image');
  await loadedImages(rowFor(outsider.page, 'dm', editBackMessage.id), 1); await loadedImages(rowFor(outsider.page, 'dm', reopenedMessage.id), 1); await shot(outsider.page, 'private-newer-draft-after-late-ack');
  checks.push('私信ACK保留改动后改回的原文和新图；旧发送→离开重开写新草稿→切另一会话后迟到ACK不覆盖原会话图文，刷新仍保留');

  mark('late upload after logout cannot attach to the next account');
  currentPage = bob.page; await bob.page.setViewportSize({ width: 1440, height: 1000 });
  await openDm(bob.page, conversation.id); const uploadGate = deferred(), uploaded = deferred(); held.push(uploadGate); let staleMedia, staleUploadError;
  const holdUpload = async intercepted => {
    // Chromium omits the File/Blob XHR body from the intercepted CDP request.
    // Forward the exact local fixture selected below when it is unavailable.
    const bytes = intercepted.request().postDataBuffer() || jpeg;
    const response = await intercepted.fetch({ postData: bytes }), value = await response.json();
    if (!response.ok()) staleUploadError = `held upload ${response.status()}: ${JSON.stringify(value)}`;
    staleMedia = value.media; uploaded.resolve(); await uploadGate.promise;
    // Logout disposes the uploader and aborts its XHR; Playwright may then mark
    // the intercepted route handled before its delayed server ACK is released.
    try { await intercepted.fulfill({ response }); } catch (error) { if (!/Route is already handled|Target page.*closed/.test(error.message)) throw error; }
  };
  await bob.page.route('**/api/community/media?purpose=attachment', holdUpload); await formFor(bob.page, 'dm').locator('input[type=file]').setInputFiles(jpegPath); await uploaded.promise;
  assert(!staleUploadError, staleUploadError); assert(staleMedia);
  await route(bob.page, '#settings'); await bob.page.locator('[data-action=logout]').click(); await bob.page.locator('#auth-form').waitFor({ state: 'attached' });
  await route(bob.page, '#auth-entry'); await bob.page.locator('#auth-form').waitFor();
  await bob.page.locator('[data-action="auth-mode"][data-mode="login"]').click();
  await bob.page.locator('#auth-form [name=email]').fill(outsider.email); await bob.page.locator('#auth-form [name=password]').fill(password); await bob.page.locator('#auth-form [type=submit]').click();
  await bob.page.locator('[data-action=logout]').waitFor({ state: 'attached' });
  uploadGate.resolve(); await bob.page.unroute('**/api/community/media?purpose=attachment', holdUpload);
  const outsiderConversation = (await community(outsider.context, '/messages/conversations', 'POST', { userId: bob.id })).conversation;
  await openDm(bob.page, outsiderConversation.id); assert.equal(await previews(bob.page, 'dm').count(), 0); assert.equal(await formFor(bob.page, 'dm').locator('textarea').inputValue(), '');
  await imageAccess(outsider.context, staleMedia, false, 'new account cannot access late previous-account upload');
  checks.push('退出并登录其他账号后，旧账号迟到上传不进入新账号会话或草稿，原图权限仍按原账号隔离');
  assert.deepEqual(errors, [], 'No browser page errors'); await json('geometry', geometry); await json('result', { passed: checks.length, checks, errors, dataDir }); console.log(JSON.stringify({ passed: checks.length, dataDir }, null, 2));
} catch (error) {
  if (currentPage) await shot(currentPage, 'failure').catch(() => {});
  await json('geometry', geometry); await json('failure', { step, message: error.message, stack: error.stack, errors }); console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const gate of held) gate.resolve();
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close(); await new Promise(done => { server.close(done); server.closeAllConnections(); });
}
