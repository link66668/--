// Isolated Edge regression for clipboard/drop attachments and streamed chat interaction.
// Synthetic clipboard events and page-local clipboard stubs never access the OS clipboard.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'composer-'));
const { chromium } = await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT || join(root, '精细模型与动作开发/node_modules/playwright/index.mjs'))).href);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQYQAAAAASUVORK5CYII=';
const wideCode = 'const workout = ' + JSON.stringify('深蹲动作与训练安排 '.repeat(40)) + ';';
const longAnswer = '# 训练建议\n\n```js\n' + wideCode + '\n```\n\n' + '每一组先保持动作稳定，再逐步增加训练量。\n\n'.repeat(36);
const streams = [], modelRequests = [], uploads = [], failedRequests = [];
const uploadGates = new Map();
let failedUploadOnce = false;
function streamReply(text, signal, hold = false) {
  const encoder = new TextEncoder();
  const pending = deferred();
  let closed = false;
  const frame = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
  const body = new ReadableStream({
    async start(controller) {
      const cancel = () => { closed = true; pending.resolve(); try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        controller.enqueue(encoder.encode(frame(text)));
        if (hold) {
          streams.push({ append: value => { if (!closed) controller.enqueue(encoder.encode(frame(value))); }, finish: pending.resolve });
          await pending.promise;
        }
        if (!closed) {
          controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        }
      } finally { signal.removeEventListener('abort', cancel); }
    },
    cancel() { closed = true; pending.resolve(); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body);
  modelRequests.push(body);
  const last = body.messages.findLast(message => message.role === 'user');
  const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  return streamReply(text.includes('QA STREAM') ? longAnswer : text.includes('QA HISTORY') ? longAnswer : '**已收到附件和消息**。', options.signal, text.includes('QA STREAM'));
} });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 950 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
await context.addInitScript(() => {
  window.qaClipboard = { texts: [], images: [] };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => { window.qaClipboard.texts.push(text); },
    write: async items => {
      for (const item of items) {
        if (item.types.includes('image/png')) {
          const blob = await item.getType('image/png');
          window.qaClipboard.images.push({ types: item.types, size: blob.size });
        }
        if (item.types.includes('text/plain')) window.qaClipboard.texts.push(await (await item.getType('text/plain')).text());
      }
    },
  } });
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], consoleErrors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('requestfailed', request => failedRequests.push({ url: request.url(), name: request.url().endsWith('/api/attachments') ? request.postDataJSON()?.name : undefined, error: request.failure()?.errorText }));
await page.route('**/api/attachments', async route => {
  if (route.request().method() !== 'POST') return route.continue();
  const body = route.request().postDataJSON();
  uploads.push(body.name);
  const gate = uploadGates.get(body.name);
  if (gate) await gate.promise;
  if (body.name === 'retry.txt' && !failedUploadOnce) {
    failedUploadOnce = true;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'QA 临时上传失败，请重试' }) });
  }
  await route.continue().catch(() => {});
});
const shot = name => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
const cards = () => page.locator('#chat-files .chat-file-card');
const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="stop-chat"]'));
const ready = count => page.waitForFunction(count => document.querySelectorAll('#chat-files .chat-file-card[data-status="ready"]').length === count, count);
const removeAll = async () => { while (await cards().count()) await cards().last().locator('[data-action="remove-file"]').click(); };
const send = async text => {
  const request = page.waitForRequest(request => request.url() === base + '/api/ai' && request.method() === 'POST');
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-form').evaluate(form => form.requestSubmit());
  return request;
};
async function transfer({ kind = 'paste', text = '', files = [], start, end } = {}) {
  return page.evaluate(({ kind, text, files, start, end, png }) => {
    const input = document.querySelector('#chat-input');
    if (start !== undefined) { input.focus(); input.setSelectionRange(start, end ?? start); }
    const transfer = new DataTransfer();
    if (text) transfer.setData('text/plain', text);
    for (const file of files) {
      const bytes = file.type?.startsWith('image/') ? Uint8Array.from(atob(png), c => c.charCodeAt(0)) : file.content || '训练记录';
      transfer.items.add(new File([bytes], file.name, { type: file.type || 'text/plain', lastModified: 1700000000000 }));
    }
    const target = kind === 'paste' ? input : document.querySelector('.chat-main');
    let dragHighlighted = false;
    if (kind === 'drop') {
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      dragHighlighted = target.classList.contains('is-dragging');
    }
    const event = kind === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, value: input.value, start: input.selectionStart, end: input.selectionEnd, dragHighlighted, dragCleared: !target.classList.contains('is-dragging') };
  }, { kind, text, files, start, end, png });
}
let step = '';
try {
  step = 'temporary account and local model'; console.log(step);
  const email = `composer-${Date.now()}@example.test`, password = 'qa-password-123';
  const registration = await context.request.post(base + '/api/auth/register', { data: { name: '交互验证', email, password } });
  assert.equal(registration.status(), 201);
  const { user } = await registration.json();
  await context.request.post(base + '/api/sync', { data: { userId: user.id, changes: [{ id: 'profile', kind: 'profile', data: { age: 28, sex: 'male', height: 175, weight: 70, goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] } });
  await context.request.put(base + '/api/providers', { data: { providers: [{ id: 'qa', name: '本地交互测试', baseUrl: 'http://127.0.0.1:9987/v1', model: 'qa-model' }], tasks: { chat: 'qa' } } });
  await page.goto(base); await page.locator('#chat-input').waitFor();
  await send('QA HISTORY 历史回复'); await idle();

  step = 'native plain text paste and mixed text/image paste'; console.log(step);
  await page.locator('#chat-input').fill('前段选中后段');
  const plain = await transfer({ text: '普通文本\n第二行', start: 2, end: 4 });
  assert.equal(plain.prevented, false, 'Plain text paste should retain the browser native editing behavior');
  assert.deepEqual([plain.value, plain.start, plain.end], ['前段选中后段', 2, 4]);
  // Synthetic paste has no browser default insertion; emulate that default without touching the OS clipboard.
  await page.keyboard.insertText('普通文本\n第二行');
  assert.equal(await page.locator('#chat-input').inputValue(), '前段普通文本\n第二行后段');
  await page.locator('#chat-input').fill('前段选中后段');
  const firstGate = deferred(); uploadGates.set('pasted.png', firstGate);
  const beforeUpload = uploads.length;
  const mixed = await transfer({ text: '图片说明', start: 2, end: 4, files: [{ name: 'pasted.png', type: 'image/png' }] });
  assert.equal(mixed.prevented, true);
  assert.equal(mixed.value, '前段图片说明后段'); assert.equal(mixed.start, 6); assert.equal(mixed.end, 6);
  await page.locator('.chat-file-card[data-status="uploading"]').waitFor();
  assert.equal(await cards().count(), 1, 'DataTransfer.files and items must not upload one image twice');
  const beforeAI = modelRequests.length;
  await page.locator('#chat-form').evaluate(form => form.requestSubmit()); await sleep(180);
  assert.equal(modelRequests.length, beforeAI, 'Sending was allowed before upload completed');
  assert.equal(await page.locator('#chat-input').inputValue(), '前段图片说明后段');
  firstGate.resolve(); await ready(1); assert.equal(uploads.length - beforeUpload, 1);
  await cards().first().locator('[data-action="preview-image"]').click();
  await page.locator('#modal[open] img').waitFor();
  await page.waitForFunction(() => document.querySelector('#modal[open] img')?.naturalWidth > 0);
  await page.locator('[data-action="close-modal"]').click();
  await cards().first().locator('[data-action="copy-image"]').click();
  await page.waitForFunction(() => window.qaClipboard.images.length === 1);
  await removeAll();

  step = 'drop files, deduplication, attachments-only send and retry'; console.log(step);
  const dropped = await transfer({ kind: 'drop', files: [{ name: 'workout.txt' }, { name: 'workout.txt' }, { name: 'meal.pdf', type: 'application/pdf', content: '%PDF-1.4\nfixture' }] });
  assert.equal(dropped.prevented, true); assert.equal(dropped.dragHighlighted, true); assert.equal(dropped.dragCleared, true);
  await ready(2); assert.equal(await cards().count(), 2);
  const attachmentRequest = await send(''); await idle();
  assert.equal(attachmentRequest.postDataJSON().messages.at(-1).attachments.length, 2);
  assert.equal(await cards().count(), 0);
  assert.equal(await page.locator('.message.user').last().locator('.message-attachments > *').count(), 2);
  await transfer({ files: [{ name: 'retry.txt' }] });
  await page.locator('.chat-file-card[data-status="error"]').waitFor();
  await page.locator('[data-action="retry-upload"]').click(); await ready(1);
  assert.equal(uploads.filter(name => name === 'retry.txt').length, 2);
  await removeAll();

  step = 'slow upload stays with its original conversation'; console.log(step);
  const oldConversation = await page.locator('#chat-input').getAttribute('data-conversation');
  const navGate = deferred(); uploadGates.set('navigation.png', navGate);
  await transfer({ files: [{ name: 'navigation.png', type: 'image/png' }] });
  await page.locator('.chat-file-card[data-status="uploading"]').waitFor();
  await page.locator('[data-action="new-chat"]').first().click();
  assert.equal(await cards().count(), 0);
  navGate.resolve(); await sleep(250);
  assert.equal(await cards().count(), 0, 'Late upload appeared in a different conversation');
  await page.locator(`#history-list [data-action="open-chat"][data-id="${oldConversation}"]`).click();
  await ready(1); await shot('desktop-attachment-draft');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile attachment card causes horizontal overflow');
  await shot('mobile-attachment-draft');
  await page.setViewportSize({ width: 1366, height: 950 }); await removeAll();

  step = 'incremental stream, stable historical DOM, selection and scroll'; console.log(step);
  await page.evaluate(() => { window.qaBeforeSend = document.querySelector('.message.assistant'); });
  await send('QA STREAM 请慢慢回答');
  await page.locator('.message.assistant').last().locator('h1').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.message.assistant') === window.qaBeforeSend), true, 'Starting a new answer replaced historical message DOM');
  assert(await page.locator('[data-action="stop-chat"]').isVisible(), 'First streamed content was not visible before completion');
  const live = streams.at(-1); assert(live);
  const saved = await page.evaluate(() => {
    const historical = document.querySelector('.message.assistant');
    const code = document.querySelectorAll('.message.assistant pre')[1];
    window.qaHistoricalMessage = historical;
    window.qaHistoricalText = historical.querySelector('.message-text');
    window.qaLiveCode = code;
    code.scrollLeft = 150;
    const text = code.querySelector('code').firstChild;
    const range = new Range(); range.setStart(text, 0); range.setEnd(text, 13);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const body = document.querySelector('.chat-body'); body.scrollTop = 0; body.dispatchEvent(new Event('scroll'));
    return { selected: selection.toString(), codeScroll: code.scrollLeft };
  });
  live.append('\n\n流式追加内容可见，阅读历史消息的位置保持不变。');
  await page.getByText('流式追加内容可见，阅读历史消息的位置保持不变。', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('.chat-body').evaluate(el => el.scrollTop), 0);
  assert.equal(await page.evaluate(() => document.querySelector('.message.assistant') === window.qaHistoricalMessage), true);
  assert.equal(await page.evaluate(() => document.querySelector('.message.assistant .message-text') === window.qaHistoricalText), true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.message.assistant pre')[1] === window.qaLiveCode), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), saved.selected);
  assert.equal(await page.evaluate(() => window.qaLiveCode.scrollLeft), saved.codeScroll);
  await page.locator('[data-action="chat-latest"]').click();
  await page.waitForFunction(() => { const body = document.querySelector('.chat-body'); return body.scrollHeight - body.clientHeight - body.scrollTop < 10; });
  await page.locator('#chat-input').fill('下一条草稿保持光标');
  await page.locator('#chat-input').evaluate(input => { window.qaInput = input; input.setSelectionRange(3, 3); });
  live.append('\n\n第二次流式追加。');
  await page.getByText('第二次流式追加。', { exact: true }).waitFor({ state: 'attached' });
  await shot('desktop-stream-follow');
  live.finish(); await idle();
  assert.equal(await page.locator('#chat-input').evaluate(input => input === window.qaInput), true);
  assert.equal(await page.locator('#chat-input').inputValue(), '下一条草稿保持光标');
  assert.equal(await page.locator('#chat-input').evaluate(input => input.selectionStart), 3);
  const lastMessage = page.locator('.message.assistant').last();
  await lastMessage.locator('[data-action="copy-message"]').click();
  await page.waitForFunction(() => window.qaClipboard.texts.length > 0);
  assert((await page.evaluate(() => window.qaClipboard.texts.at(-1))).startsWith('# 训练建议'));
  const lastId = await lastMessage.getAttribute('data-message-id');
  const count = await page.locator('.message').count();
  const retryRequest = page.waitForRequest(request => request.url() === base + '/api/ai');
  await lastMessage.locator('[data-action="retry-chat"]').click(); await retryRequest;
  await page.locator('.message.assistant').last().locator('h1').waitFor();
  assert.equal(await page.locator('.message').count(), count, 'Regenerate duplicated the user message');
  assert.equal(await page.locator('.message.assistant').last().getAttribute('data-message-id'), lastId);
  await page.locator('[data-action="stop-chat"]').click(); await idle();

  step = 'logout cancels pending uploads and clears account-scoped drafts'; console.log(step);
  const logoutGate = deferred(); uploadGates.set('logout.txt', logoutGate);
  const logoutUploadStarted = page.waitForRequest(request => request.url() === base + '/api/attachments' && request.postDataJSON()?.name === 'logout.txt');
  await transfer({ files: [{ name: 'logout.txt' }] });
  await logoutUploadStarted;
  await page.locator('.chat-file-card[data-status="uploading"]').waitFor();
  await page.locator('[data-action="logout"]').click();
  await page.locator('[data-action="auth-jump"][data-mode="login"]').click();
  await page.locator('#auth-form').waitFor();
  logoutGate.resolve(); await sleep(200);
  assert(failedRequests.some(request => request.name === 'logout.txt' && request.error?.includes('ABORTED')), 'Logout did not abort the pending upload request');
  await context.request.post(base + '/api/auth/login', { data: { email, password } });
  await page.reload(); await page.locator('#chat-input').waitFor();
  assert.equal(await cards().count(), 0);
  assert.equal(await page.locator('#chat-input').inputValue(), '');
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { passed: true, dataDir, modelRequests: modelRequests.length, uploadRequests: uploads.length, checks: 'plain/mixed paste, image preview/copy/remove, file drop/dedup, attachments-only send, pending blocks send, upload retry, conversation isolation, stream first chunk, stable historical/live DOM, selection/scroll, jump latest, raw Markdown copy, regeneration, logout clears drafts, 390px layout', errors };
  await writeFile(join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('FAILED STEP:', step);
  console.error(JSON.stringify({ consoleErrors, errors, toasts: await page.locator('#toasts').textContent().catch(() => '') }));
  await shot('failure').catch(() => {});
  throw error;
} finally {
  for (const stream of streams) stream.finish();
  for (const gate of uploadGates.values()) gate.resolve();
  await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
