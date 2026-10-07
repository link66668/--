// Isolated Edge regression: streamed Markdown, composer, and real plan tool writes.
// Uses a local fixture provider and temporary SQLite. No real model or user data.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, '.qa'), { recursive: true });
const dataDir = await mkdtemp(join(root, '.qa', 'chat-'));
const { chromium } = await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT || join(root, '精细模型与动作开发/node_modules/playwright/index.mjs'))).href);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let releaseStream, appendStream, upstreamAborts = 0, requestCount = 0, failedAttempts = 0;
const markdown = '# 流式训练建议\n\n**先热身**，再开始训练。\n\n- 深蹲\n- 俯卧撑\n\n> 每组保持动作稳定。\n\n| 动作 | 组数 |\n| --- | --- |\n| 深蹲 | 3 |\n\n```js\nconst sets = 3;\n```\n\n[训练动作](/model/?exercise=squat)\n\n<script>window.qaInjected = true</script>\n<img src=x onerror="window.qaInjected=true">\n[危险链接](javascript:alert(1))\n\n![远程图片](https://tracking.invalid/pixel.png)\n';
const samplePlan = name => ({ name, days: [{ id: 'day-1', name: '全身训练', rest: false, exercises: [{ exerciseId: 'squat', sets: 3, reps: '8–12', restSeconds: 90 }] }, { id: 'day-2', name: '恢复日', rest: true, exercises: [] }], notes: ['按身体感受调整。'] });
function streamed(chunks, signal, hold = false) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      const abort = () => { cancelled = true; upstreamAborts++; try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        for (const payload of chunks) {
          if (cancelled) return;
          const wire = `data: ${JSON.stringify(payload)}\r\n\r\n`;
          const bytes = encoder.encode(wire);
          // Split frames and multibyte Chinese characters across transport reads.
          for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11));
          await sleep(35);
        }
        if (hold && !cancelled) await new Promise(resolve => {
          releaseStream = resolve;
          appendStream = text => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta(text))}\n\n`)); };
          signal?.addEventListener('abort', resolve, { once: true });
        });
        if (!cancelled) {
          if (!chunks.at(-1)?.choices?.[0]?.finish_reason) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      } catch (error) { if (!cancelled) controller.error(error); }
      finally { signal?.removeEventListener('abort', abort); }
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
const delta = text => ({ choices: [{ index: 0, delta: { content: text } }] });
const toolResponse = (name, args, signal) => streamed([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${++requestCount}`, type: 'function', function: { name, arguments: '' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
], signal);
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body);
  const lastUser = body.messages.findLast(m => m.role === 'user');
  const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
  const last = body.messages.at(-1);
  if (last.role !== 'tool') assert.doesNotMatch(body.messages[0].content, /支持的动作：|知识大全的计算公式：|常见食物份量：|"weight":70/);
  if (text?.includes('QA按需资料')) {
    if (last.role !== 'tool') return toolResponse('read_chat_context', { sections: ['profile', 'nutrition'] }, options.signal);
    const result = JSON.parse(last.content);
    assert.equal(result.data.profile.profile.weight, 70);
    assert.ok(result.data.nutrition.target.kcal > 0);
    assert.deepEqual(Object.keys(result.data).sort(), ['nutrition', 'profile']);
    return streamed([delta('已结合当前档案和营养目标给出建议。')], options.signal);
  }
  if (/QA计划(创建|修改|删除)/.test(text)) {
    if (last.role !== 'tool') return toolResponse('get_training_plan', {}, options.signal);
    const result = JSON.parse(last.content);
    if(result.name==='get_training_plan')return toolResponse('read_calendar',{},options.signal);
    if(result.name==='read_calendar'&&text.includes('创建'))return toolResponse('create_training_plan',{plan:{name:'QA 缺少模板日'}},options.signal);
    if (result.name==='read_calendar'||result.code==='INVALID_ARGUMENTS') {
      const planResult=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).find(m=>m.name==='get_training_plan');
      const expectedVersion = planResult.currentVersion;
      if (text.includes('创建')) return toolResponse('create_training_plan', { plan: samplePlan('QA 对话新建计划') }, options.signal);
      if (text.includes('修改')) return toolResponse('update_training_plan', { expectedVersion, plan: samplePlan('QA 对话修改计划') }, options.signal);
      return toolResponse('delete_training_plan', { expectedVersion }, options.signal);
    }
    return streamed([delta(result.ok ? '**操作已完成**。训练计划已经更新。' : `操作失败：${result.message}`)], options.signal);
  }
  if (text?.includes('QA中途错误')) return ++failedAttempts === 1 ? new Response('fixture authentication failure', { status: 401 }) : streamed([delta('重试成功，沿用同一请求编号。')], options.signal);
  if (text?.includes('QA停止')) return streamed([delta('这是一段可以停止的回复。')], options.signal, true);
  if (text?.includes('QA渲染')) return streamed([delta(markdown.slice(0, 25)), delta(markdown.slice(25))], options.signal, true);
  return streamed([delta('已收到。')], options.signal);
} });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 950 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], remoteRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base)) remoteRequests.push(request.url()); });
const serverState = async () => (await context.request.get(base + '/api/state')).json();
const activePlan = async () => (await serverState()).records.find(r => r.id === 'active-plan');
const nav = async name => {
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator(`.nav [data-page="${name}"]`).click();
};
const send = async text => {
  const request = page.waitForRequest(request => request.url() === base + '/api/ai' && request.method() === 'POST');
  await page.locator('#chat-input').fill(text); await page.locator('#chat-form').evaluate(form => form.requestSubmit());
  await request;
};
const idle = () => page.waitForFunction(() => !document.querySelector('[data-action="stop-chat"]') && !document.querySelector('#chat-input')?.disabled);
const shot = name => page.screenshot({ path: join(dataDir, name + '.png'), fullPage: true, style: '#toasts{visibility:hidden}' });
let step = '';
try {
  step = 'register temporary account and configure fixture'; console.log(step);
  const registration = await context.request.post(base + '/api/auth/register', { data: { name: '对话验证', email: `qa-chat-${Date.now()}@example.test`, password: 'qa-password-123' } });
  assert.equal(registration.status(), 201);
  const { user } = await registration.json();
  await context.request.post(base + '/api/sync', { data: { userId: user.id, changes: [{ id: 'profile', kind: 'profile', data: { age: 28, sex: 'male', height: 175, weight: 70, goal: 'maintain', activity: 1.375 }, baseVersion: 0 }] } });
  await context.request.put(base + '/api/providers', { data: { providers: [{ id: 'qa', name: '本地测试模型', baseUrl: 'http://127.0.0.1:9987/v1', model: 'qa-model' }], tasks: { chat: 'qa', meal: 'qa', planning: 'qa' } } });
  await page.goto(base); await page.locator('#chat-input').waitFor();

  step = 'on-demand context, minimal request, read status and compact conversation history'; console.log(step);
  const contextRequest = page.waitForRequest(request => request.url() === base + '/api/ai');
  await send('QA按需资料：按我的档案分析营养目标'); await idle();
  assert.deepEqual(Object.keys((await contextRequest).postDataJSON().context).sort(), ['date', 'localToday', 'timezoneOffset']);
  await page.getByText('已结合当前档案和营养目标给出建议。', { exact: true }).waitFor();
  assert.equal(await page.locator('.message.assistant').last().locator('.tool-results').textContent(), '');
  const followup = page.waitForRequest(request => request.url() === base + '/api/ai');
  await send('谢谢'); await idle();
  const followupBody = (await followup).postDataJSON();
  assert.doesNotMatch(JSON.stringify(followupBody), /"weight":70|已读取所需资料|"foodPortions":/);
  const conversations = (await serverState()).records.filter(r => r.kind === 'conversation');
  const contextResults = conversations.flatMap(r => r.data.messages || []).flatMap(m => m.toolResults || []).filter(r => r.name === 'read_chat_context');
  assert(contextResults.length > 0);
  assert(contextResults.every(r => r.readOnly && !r.data));

  step = 'incremental Markdown, XSS containment, stable editable composer'; console.log(step);
  await send('QA渲染：请提供训练建议');
  await page.locator('.message.assistant h1').filter({ hasText: '流式训练建议' }).waitFor();
  for (let i = 0; !releaseStream && i < 30; i++) await sleep(20);
  assert(releaseStream, 'Expected upstream to remain open while the response is visible');
  assert.equal(await page.locator('.message.assistant table').count(), 1);
  assert.equal((await page.locator('.message.assistant pre code').textContent()).trimEnd(), 'const sets = 3;');
  assert.equal(await page.evaluate(() => Boolean(window.qaInjected)), false);
  assert.equal(await page.locator('.message.assistant a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator('.message.assistant .message-text img').count(), 0);
  assert.equal(await page.locator('.message.assistant a[data-action]').count(), 0);
  assert.equal(await page.locator('.message.assistant a[href="/model/?exercise=squat"]').count(), 1);
  assert.equal(remoteRequests.length, 0);
  const inputStyle = await page.locator('#chat-input').evaluate(el => ({ font: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight, height: el.getBoundingClientRect().height }));
  assert(Number.parseFloat(inputStyle.line) <= 28 && Number.parseFloat(inputStyle.line) >= 18, JSON.stringify(inputStyle));
  await page.locator('#chat-input').fill('下一条草稿');
  await page.locator('#chat-input').evaluate(el => { window.qaComposer = el; el.setSelectionRange(2, 2); });
  await page.locator('.chat-body').evaluate(el => { el.scrollTop = 0; });
  appendStream('\n\n' + '继续保持稳定的训练节奏。\n\n'.repeat(20) + '最后一段逐步显示。');
  await page.getByText('最后一段逐步显示。', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('.chat-body').evaluate(el => el.scrollTop), 0, 'Incoming content pulled the reader away from earlier messages');
  await shot('desktop-stream-markdown');
  releaseStream(); await idle();
  assert(await page.locator('#chat-input').evaluate(el => el === window.qaComposer), 'Completion replaced the input element');
  assert.equal(await page.locator('#chat-input').inputValue(), '下一条草稿');
  assert.equal(await page.locator('#chat-input').evaluate(el => el.selectionStart), 2);
  await nav('settings'); await nav('chat');
  assert.equal(await page.locator('#chat-input').inputValue(), '下一条草稿');
  assert.equal(await page.locator('#chat-input').evaluate(el => el.selectionStart), 2);

  step = 'stop preserves partial response and aborts upstream'; console.log(step);
  await send('QA停止：请慢慢回答');
  await page.getByText('这是一段可以停止的回复。', { exact: true }).waitFor();
  await page.locator('[data-action="stop-chat"]').click(); await idle();
  await page.waitForTimeout(150);
  assert(upstreamAborts > 0, 'Stop did not cancel upstream generation');
  assert((await page.locator('.message.assistant').last().textContent()).includes('这是一段可以停止的回复。'));

  step = 'failed answer retries with the same request ID'; console.log(step);
  const firstRequest = page.waitForRequest(request => request.url() === base + '/api/ai');
  await send('QA中途错误：请重新回答'); await idle();
  const firstRequestId = (await firstRequest).postDataJSON().requestId;
  const retryRequest = page.waitForRequest(request => request.url() === base + '/api/ai');
  await page.locator('.message.assistant').last().locator('[data-action="retry-chat"]').click();
  assert.equal((await retryRequest).postDataJSON().requestId, firstRequestId);
  await idle(); await page.getByText('重试成功，沿用同一请求编号。', { exact: true }).waitFor();

  step = 'chat creates and updates actual plan'; console.log(step);
  await send('QA计划创建：请创建训练计划'); await idle();
  assert.equal(await page.locator('.message.assistant').last().locator('.tool-result.failed').count(),0);
  assert.doesNotMatch(await page.locator('.message.assistant').last().textContent(),/操作未完成|计划必须包含|已读取/);
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent.includes('操作已完成'));
  let saved = await activePlan(); assert.equal(saved?.data?.name, 'QA 对话新建计划');
  const firstVersion = saved.version;
  const historical = { date: '2026-09-20', dayId: 'day-1', completed: true, rest: false, planVersion: saved.data.planVersion, daySnapshot: structuredClone(saved.data.days[0]), actual: [{ exerciseId: 'squat', sets: 3, reps: '10', weight: 25 }], notes: '历史训练保持不变' };
  await context.request.post(base + '/api/sync', { data: { userId: user.id, changes: [{ id: 'schedule:2026-09-20', kind: 'schedule', data: historical, baseVersion: 0 }] } });
  await send('QA计划修改：请把计划名称改为对话修改计划'); await idle();
  saved = await activePlan(); assert.equal(saved?.data?.name, 'QA 对话修改计划'); assert.equal(saved.version, firstVersion + 1);
  await nav('training'); await page.locator('.calendar-task').filter({ hasText: '全身训练' }).first().waitFor(); await shot('desktop-chat-plan-updated');
  await nav('chat'); await send('QA计划删除：请删除当前训练计划'); await idle();
  saved = await activePlan(); assert.equal(saved.deleted, true);
  assert.deepEqual((await serverState()).records.find(r => r.id === 'schedule:2026-09-20').data, historical);
  await nav('training'); await page.locator('.calendar-date-picker summary').click(); await page.locator('#training-date').fill('2026-09-20'); await page.locator('#training-date').dispatchEvent('change');
  assert.equal(await page.locator('.timetable-cell').count(), 7);
  assert.equal(await page.locator('[data-period]').count(), 0);
  await page.locator('.calendar-task[data-task-id="schedule:2026-09-20"] [data-action="calendar-detail"]').first().click();
  await page.locator('[data-action="log-training"]').click(); await page.locator('#training-log').waitFor();
  assert.equal(await page.locator('[name="weight-0"]').inputValue(), '25');
  await page.locator('[data-action="close-modal"]').click();

  step = 'mobile composer, Chinese IME and offline reconnection'; console.log(step);
  await nav('chat'); await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#chat-input').fill('中文输入第一行\n第二行');
  await page.locator('#chat-input').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  assert.equal(await page.locator('#chat-input').inputValue(), '中文输入第一行\n第二行');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile horizontal overflow');
  await shot('mobile-chat-composer');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.locator('#sync-status').click(); await page.waitForFunction(() => document.querySelector('#sync-status')?.textContent === '已同步');
  await context.setOffline(true); await page.reload();
  // Calculations now require the application server. Offline boot preserves
  // local records and shows the existing reconnect screen, not the chat shell.
  await page.getByRole('heading',{name:'等待计算服务器'}).waitFor();
  await context.setOffline(false);await page.reload();await page.locator('#chat-input').waitFor();
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator('#history-list [data-action="open-chat"]').first().click();
  await page.locator('.message.assistant table').waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { passed: true, dataDir, upstreamAborts, checks: 'on-demand context, compact history, incremental Markdown, XSS, cancellation, create/update/delete persisted, historical workout survives deletion, IME, 390px layout, offline reconnect preserves chat', errors };
  await writeFile(join(dataDir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  console.error('FAILED STEP:', step);
  await shot('failure').catch(() => {});
  throw error;
} finally {
  releaseStream?.();
  await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
