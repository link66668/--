// Report-form acceptance in isolated Edge accounts and a temporary SQLite store.
// Existing local Playwright / Edge can be selected with QA_PLAYWRIGHT / QA_BROWSER.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../server.mjs';

const expectedReasons = [
  ['sexual', '色情低俗'], ['political', '政治敏感'], ['fraud', '诈骗信息'],
  ['racism', '种族歧视'], ['offsite', '站外导流'], ['illegal', '违法违规'],
  ['spam', '低差广告'], ['unfriendly', '不友善、引战'], ['engagement', '诱导关注点赞'],
  ['minors', '涉未成年人'], ['cyberbullying', '网络暴力'], ['self_harm', '疑似自残自杀'],
  ['irrelevant', '笔记不相关'], ['other', '其他'],
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.QA_PLAYWRIGHT, join(root, '.qa/community-tools/node_modules/playwright/index.mjs'), join(root, '精细模型与动作开发/node_modules/playwright/index.mjs')].filter(Boolean);
const playwrightPath = candidates.find(path => existsSync(path));
if (!playwrightPath) throw new Error('请设置 QA_PLAYWRIGHT 为已有 Playwright/index.mjs 的路径。');
const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href);
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'community-report-'));
const emailAlice = 'report-qa-author@example.test', password = 'community-report-qa-password';
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, communityModeratorEmails: [emailAlice] });
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [], reports = [], payloads = [], geometry = [], errors = [], contexts = [];
let browser, currentPage, step = 'setup';
const json = (name, value) => writeFile(join(dataDir, name + '.json'), JSON.stringify(value, null, 2));
const mark = label => { step = label; console.log(label); };
const api = async (context, path, method = 'GET', body) => {
  const response = await context.request.fetch(base + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const value = await response.json();
  assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);
  return value;
};
const community = (context, path, method = 'GET', body) => api(context, '/community' + path, method, body);
const makeContext = async options => { const context = await browser.newContext({ reducedMotion: 'reduce', ...options }); contexts.push(context); return context; };
const register = async (context, email, name) => {
  const { user } = await api(context, '/auth/register', 'POST', { email, password, name });
  await api(context, '/sync', 'POST', { changes: [{ id: 'profile', kind: 'profile', data: { age: 25, height: 172, weight: 68, sex: 'male', goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] });
  return user;
};
const makePage = async context => {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/community/reports') payloads.push(request.postDataJSON()); });
  return page;
};
const screenshot = (page, name) => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const reportDialog = page => page.locator('.cm-report-dialog[open]');
const form = page => reportDialog(page).locator('[data-cm-form="report"]');
const submit = page => reportDialog(page).locator('.cm-report-footer button[type="submit"]');
const radio = (page, value) => form(page).locator(`input[type="radio"][name="reason"][value="${value}"]`);
const description = page => form(page).locator('textarea[name="description"]');
const other = page => form(page).locator('.cm-report-other');
const openReport = async (page, type, id) => {
  const trigger = type === 'note' ? page.locator('[data-cm="note-more"]') : page.locator(`[data-cm="comment-more"][data-id="${id}"]`);
  await trigger.click();
  await page.locator(`.cm-context-menu [data-cm="report-${type}"]`).click();
  await reportDialog(page).waitFor();
  assert.equal(await form(page).getAttribute('data-type'), type); assert.equal(await form(page).getAttribute('data-id'), id);
};
const assertInitial = async page => {
  const actual = await form(page).locator('.cm-report-option').evaluateAll(labels => labels.map(label => [label.querySelector('input').value, label.querySelector('span').textContent.trim()]));
  assert.deepEqual(actual, expectedReasons, 'The 14 report reasons retain their exact order and labels');
  assert.equal(await form(page).locator('input[name="reason"]:checked').count(), 0);
  assert(await submit(page).isDisabled(), 'Submission starts disabled until a reason is selected');
  assert(!(await other(page).isVisible()), 'Other description starts hidden');
  assert(await description(page).isDisabled(), 'A hidden description cannot be submitted by the form');
  assert.equal(await submit(page).getAttribute('form'), await form(page).getAttribute('id'), 'The fixed footer submits the associated report form');
};
const geometryCheck = async (page, label) => {
  const result = await reportDialog(page).evaluate(dialog => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const scroller = dialog.querySelector('.cm-aux-content'), footer = dialog.querySelector('.cm-report-footer');
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, dialog: rect(dialog), dialogWidths: { client: dialog.clientWidth, scroll: dialog.scrollWidth }, scroller: rect(scroller), scrollerWidths: { client: scroller.clientWidth, scroll: scroller.scrollWidth }, vertical: { client: scroller.clientHeight, scroll: scroller.scrollHeight, top: scroller.scrollTop }, footer: rect(footer), submit: rect(footer.querySelector('[type="submit"]')), close: rect(dialog.querySelector('[data-cm="aux-close"]')), options: [...dialog.querySelectorAll('.cm-report-option')].map(option => ({ text: option.querySelector('span').textContent, ...rect(option) })) };
  });
  assert(result.documentWidth <= result.viewport.width + 1, `${label}: no document overflow`);
  assert(result.dialog.left >= -1 && result.dialog.right <= result.viewport.width + 1 && result.dialog.top >= -1 && result.dialog.bottom <= result.viewport.height + 1, `${label}: dialog remains inside the viewport`);
  assert(result.dialogWidths.scroll <= result.dialogWidths.client + 1 && result.scrollerWidths.scroll <= result.scrollerWidths.client + 1, `${label}: no horizontal dialog overflow`);
  for (const [name, target] of [['close', result.close], ['submit', result.submit]]) {
    assert(target.width >= 43.5 && target.height >= 43.5, `${label}: ${name} keeps a 44px touch target`);
    assert(target.top >= result.dialog.top - 1 && target.bottom <= result.dialog.bottom + 1, `${label}: ${name} stays visible`);
  }
  for (const option of result.options) assert(option.width >= 43.5 && option.height >= 43.5, `${label}: ${option.text} has a clickable 44px label`);
  assert(result.vertical.scroll > result.vertical.client, `${label}: the long report list uses its internal scroll area`);
  geometry.push({ label, ...result }); return result;
};
const selectReason = async (page, value) => {
  await radio(page, value).check();
  assert.equal(await form(page).locator('input[name="reason"]:checked').count(), 1, 'Reasons are mutually exclusive');
  assert(await radio(page, value).isChecked()); assert(!(await submit(page).isDisabled()));
};
const submitReport = async (page, type, targetId, reason, expectedDescription = '') => {
  const responsePending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/community/reports');
  await submit(page).click(); const response = await responsePending, value = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(value));
  assert.equal(value.report.targetType, type); assert.equal(value.report.targetId, targetId); assert.equal(value.report.reason, reason); assert.equal(value.report.description, expectedDescription);
  const payload = response.request().postDataJSON(); assert.equal(payload.reason, reason); assert.equal(payload.description ?? '', expectedDescription);
  reports.push(value.report); await reportDialog(page).waitFor({ state: 'hidden' });
  assert(await page.locator('.cm-detail-dialog').isVisible(), 'Report completion keeps the original note detail open');
  return value.report;
};

try {
  browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const aliceContext = await makeContext({ viewport: { width: 1440, height: 1000 } }), bobContext = await makeContext({ viewport: { width: 1440, height: 1000 } }), carolContext = await makeContext({});
  const alice = await register(aliceContext, emailAlice, '举报验收笔记作者'), bob = await register(bobContext, 'report-qa-reader@example.test', '举报验收社区用户');
  await register(carolContext, 'report-qa-reply@example.test', '举报验收回复作者');
  const upload = await aliceContext.request.post(base + '/api/community/media?purpose=note', { headers: { 'Content-Type': 'image/jpeg' }, data: await readFile(join(root, 'public/assets/exercises/squat.jpg')) });
  assert(upload.ok()); const media = (await upload.json()).media;
  const note = (await community(aliceContext, '/notes', 'POST', { clientMutationId: randomUUID(), type: 'image', title: '举报表单验收：记录一次完整训练', body: '这份笔记只在临时数据库中使用，用于检查笔记、评论和子回复共享的举报表单。', category: 'training', topics: ['训练记录'], media: [{ id: media.id, role: 'image', isCover: true }] })).note;
  const comment = async (context, body, parentId) => (await community(context, `/notes/${note.id}/comments`, 'POST', { clientMutationId: randomUUID(), body, ...(parentId ? { parentId, replyToCommentId: parentId } : {}) })).comment;
  const main = await comment(aliceContext, '顶层评论：供十四项举报原因的共享表单验收。'), reply = await comment(carolContext, '子回复：可通过相同表单选择原因与说明。', main.id);
  await json('seed', { noteId: note.id, mainCommentId: main.id, replyId: reply.id, authorId: alice.id, reporterId: bob.id });
  const page = currentPage = await makePage(bobContext); await page.goto(base + '/#community/note/' + note.id);
  await page.locator('.cm-detail-copy h1').waitFor(); await page.locator(`[data-cm="comment-more"][data-id="${reply.id}"]`).waitFor();

  mark('14 ordered reasons, exclusive selection, conditional description and draft retention');
  await openReport(page, 'note', note.id); await assertInitial(page); await geometryCheck(page, 'desktop-initial'); await screenshot(page, 'desktop-initial');
  await reportDialog(page).screenshot({ path: join(dataDir, 'report-dialog-first.png') });
  for (const [value] of expectedReasons) await selectReason(page, value);
  assert(await other(page).isVisible()); assert(!(await description(page).isDisabled()));
  const draft = '选择其他时填写的本机说明草稿：切换原因后再返回应保留。'; await description(page).fill(draft);
  await selectReason(page, 'sexual'); assert(!(await other(page).isVisible())); assert(await description(page).isDisabled());
  await selectReason(page, 'other'); assert.equal(await description(page).inputValue(), draft); assert(await other(page).isVisible());
  await description(page).scrollIntoViewIfNeeded(); await geometryCheck(page, 'desktop-other'); await screenshot(page, 'report-preview');
  await reportDialog(page).screenshot({ path: join(dataDir, 'report-dialog-other.png') });
  checks.push('Exactly 14 ordered Chinese labels; one checked radio; initially disabled submit; Other toggles description visibility/disabled state and preserves its local draft');

  mark('failed submission preserves selection and retries the real new reason without hidden description');
  await selectReason(page, 'sexual'); const beforeFailure = payloads.length;
  const failOnce = async route => { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离验收：模拟提交失败，请重试。' }) }); };
  await page.route('**/api/community/reports', failOnce, { times: 1 });
  const failurePending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/community/reports');
  await submit(page).click(); const failure = await failurePending; assert.equal(failure.status(), 503);
  await page.waitForFunction(() => !document.querySelector('.cm-report-dialog .cm-report-submit')?.disabled);
  assert(await reportDialog(page).isVisible()); assert(await radio(page, 'sexual').isChecked()); assert(await description(page).isDisabled());
  await screenshot(page, 'desktop-failure-retry');
  const noteReport = await submitReport(page, 'note', note.id, 'sexual');
  assert.equal(payloads.length, beforeFailure + 2); assert.equal(payloads[beforeFailure].description ?? '', ''); assert.deepEqual(payloads[beforeFailure], payloads[beforeFailure + 1], 'A retry reuses its exact request and mutation id');
  checks.push('A simulated 503 retains selection, allows retry with the same request id, submits the new reason sexual and sends an empty hidden description');

  mark('main-comment and child-reply share the same form and persist the correct target');
  await openReport(page, 'comment', main.id); await assertInitial(page); await selectReason(page, 'fraud'); const mainReport = await submitReport(page, 'comment', main.id, 'fraud');
  await openReport(page, 'comment', reply.id); await assertInitial(page); await selectReason(page, 'other');
  const otherText = '子回复举报的其他说明：这是隔离的真实 API 验收。'; await description(page).fill(otherText); const replyReport = await submitReport(page, 'comment', reply.id, 'other', otherText);
  checks.push('Note, top-level comment and child reply open the same fourteen-option form and save the correct target; Other sends its actual description');

  mark('SQLite persistence and moderator-readable Chinese reason labels');
  const db = new DatabaseSync(join(dataDir, 'fitness.sqlite'));
  try { for (const report of reports) { const stored = db.prepare('SELECT user_id,target_type,target_id,reason,description FROM community_reports WHERE id=?').get(report.id); assert(stored); assert.equal(stored.user_id, bob.id); assert.equal(stored.target_type, report.targetType); assert.equal(stored.target_id, report.targetId); assert.equal(stored.reason, report.reason); assert.equal(stored.description, report.description); } } finally { db.close(); }
  const moderationPage = currentPage = await makePage(aliceContext); await moderationPage.goto(base + '/#community/moderation'); await moderationPage.locator('.cm-report-row').first().waitFor();
  for (const [report, label] of [[noteReport, '色情低俗'], [mainReport, '诈骗信息'], [replyReport, '其他']]) {
    const row = moderationPage.locator('.cm-report-row').filter({ has: moderationPage.locator(`[data-cm="report-review"][data-id="${report.id}"]`) });
    await row.waitFor(); assert((await row.locator('p').first().innerText()).includes(label));
    if (report.reason === 'other') assert((await row.innerText()).includes(otherText));
  }
  await screenshot(moderationPage, 'moderation-reason-labels'); checks.push('SQLite retains all three exact reports and moderation shows Chinese labels for new reasons and the Other description');

  for (const width of [1440, 390, 320]) {
    mark(`responsive ${width}: internal scrolling, final option, fixed controls and touch targets`);
    const target = width === 1440 ? page : await makePage(await makeContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, storageState: await bobContext.storageState() })); currentPage = target;
    if (target !== page) { await target.goto(base + '/#community/note/' + note.id); await target.locator('.cm-detail-copy h1').waitFor(); }
    if (width === 320) await screenshot(target, 'mobile-320-detail');
    await openReport(target, 'note', note.id); await assertInitial(target); await geometryCheck(target, `${width}-initial`); await screenshot(target, `${width}-initial`);
    await radio(target, 'irrelevant').locator('..').scrollIntoViewIfNeeded(); await selectReason(target, 'irrelevant');
    const lastMain = await radio(target, 'irrelevant').locator('..').boundingBox(), closeBefore = await reportDialog(target).locator('[data-cm="aux-close"]').boundingBox(), submitBefore = await submit(target).boundingBox(), footerBefore = await reportDialog(target).locator('.cm-report-footer').boundingBox();
    assert(lastMain && closeBefore && submitBefore && footerBefore && lastMain.y >= closeBefore.y && lastMain.y + lastMain.height <= footerBefore.y + 1, 'The final non-Other reason can scroll above the footer');
    await selectReason(target, 'other'); await description(target).fill(`其他说明：${width}px 对话框内部滚动检查。`); await description(target).scrollIntoViewIfNeeded();
    await geometryCheck(target, `${width}-other-bottom`); await screenshot(target, `${width}-other-bottom`);
    const inputBox = await description(target).boundingBox(), footerAfter = await reportDialog(target).locator('.cm-report-footer').boundingBox();
    assert(inputBox && footerAfter && inputBox.y + inputBox.height <= footerAfter.y + 1, 'The Other description scrolls fully above the footer');
    const closeAfter = await reportDialog(target).locator('[data-cm="aux-close"]').boundingBox(), submitAfter = await submit(target).boundingBox();
    assert(Math.abs(closeAfter.y - closeBefore.y) <= 1 && Math.abs(submitAfter.y - submitBefore.y) <= 1, 'Scrolling the form keeps close and submit in fixed header/footer positions');
    await reportDialog(target).locator('[data-cm="aux-close"]').click(); await reportDialog(target).waitFor({ state: 'hidden' }); assert(await target.locator('.cm-detail-dialog').isVisible());
    checks.push(`${width}px: final reason and Other are reachable through internal scrolling; fixed submit/close remain visible; labels and controls preserve touch targets without horizontal overflow`);
  }
  assert.deepEqual(errors, [], 'No browser script errors'); await json('geometry', geometry); await json('payloads', payloads);
  const result = { passed: true, dataDir, preview: join(dataDir, 'report-preview.png'), checks, reports, errors }; await json('result', result); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (currentPage) await screenshot(currentPage, 'failure').catch(() => {});
  await json('geometry', geometry); await json('payloads', payloads); await json('failure', { step, message: error.message, stack: error.stack, errors });
  console.error('FAILED STEP:', step, 'Artifacts:', dataDir); throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
