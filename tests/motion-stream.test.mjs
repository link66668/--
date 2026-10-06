import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server.mjs';
import {compactMotionAnalysis} from '../public/motion-contract.js';
import {buildMotionPoseData, buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {analyzeMotion} from '../public/motion-analysis.js';
import {consumeChatEvents} from '../public/chat-stream.js';
import {setApiUser, streamMotionCoach} from '../public/store.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function requestBody(frameCount = 12) {
  const pipeline = toMediaPipePipeline({duration: Math.max(1.2, frameCount / 15), width: 1280, height: 720, sampleFps: 15, frames: Array.from({length: frameCount}, (_, index) => ({
    time: index / 15, sourceTime: index / 15, personCount: 1,
    landmarks: Array.from({length: 33}, (_, point) => ({x: Math.fround(0.2 + point / 100), y: Math.fround(0.3 + index / 1000), visibility: Math.fround(0.99)})),
  }))});
  const fullAnalysis = buildFullMotionAnalysis(analyzeMotion(pipeline.frames, pipeline), pipeline);
  return {duration: pipeline.duration, poseData: buildMotionPoseData(pipeline), fullAnalysis, analysis: compactMotionAnalysis(fullAnalysis),
    keyframes: [{time: 0.2, mimeType: 'image/png', data: png}, {time: 0.6, mimeType: 'image/png', data: png}], stream: true};
}

function modelResponse(call) {
  const context = call.context;
  const feedback = context.stage === 'synthesis' ? context.data.reviewedParts.flatMap(part => part.report.feedback)
    : context.stage === 'full-data' && context.data.frameIndices.length ? [{title: '保持动作控制', status: 'improve', source: 'pose', frameIndices: [context.data.frameIndices[0]], evidenceTimes: [],
      evidence: '骨架采样显示身体位置发生变化，需稳定控制动作。', correction: '下一组放慢动作，保持身体稳定。', priority: 1}] : [];
  return Response.json({choices: [{message: {content: JSON.stringify({action: {exerciseId: null, name: null, family: null, status: 'unknown', confidence: 'low', evidenceTimes: []},
    verdict: {status: context.stage === 'synthesis' ? 'needs-improvement' : 'uncertain', summary: '动作需要调整。'}, feedback, limitations: []})}, finish_reason: 'stop'}]});
}

async function fixture(t, handler, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'motion-stream-')), calls = [];
  const server = await startServer({host: '127.0.0.1', port: 0, dataDir, ...options, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body), call = {body, context: JSON.parse(body.messages[1].content[0].text), signal: request.signal};
    calls.push(call); return handler ? handler(call) : modelResponse(call);
  }});
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const register = async name => {
    const response = await fetch(base + '/api/auth/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, email: `${name}@example.test`, password: 'stream-test-password'})});
    assert.equal(response.status, 201);
    return {id: (await response.json()).user.id, cookie: response.headers.get('set-cookie').split(';')[0]};
  };
  const alice = await register('motion-stream-alice'), bob = await register('motion-stream-bob');
  const provider = {id: 'stream-coach', name: 'Stream fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key-only', model: 'vision-fixture', models: [{id: 'vision-fixture', vision: true}]};
  const configured = await fetch(base + '/api/providers', {method: 'PUT', headers: {'Content-Type': 'application/json', Cookie: alice.cookie}, body: JSON.stringify({providers: [provider], tasks: {motion: provider.id}, taskModels: {motion: provider.model}})});
  assert.equal(configured.status, 200); await configured.arrayBuffer();
  const request = ({account = alice, userId = account?.id, body = requestBody(), signal} = {}) => fetch(base + '/api/motion/coach', {
    method: 'POST', signal, headers: {'Content-Type': 'application/json', Accept: 'text/event-stream', ...(account ? {Cookie: account.cookie} : {}), ...(userId ? {'X-Fitness-User': userId} : {})}, body: JSON.stringify(body),
  });
  return {calls, alice, bob, request};
}

test('motion HTTP stream delivers progress while AI is pending and publishes the complete result after all stages', {timeout: 5000}, async t => {
  const started = deferred(), release = deferred(), progressSeen = deferred();
  let upstreamPending = true;
  const f = await fixture(t, async call => {
    if (call.context.stage === 'full-data' && call.context.data.index === 0) { started.resolve(); await release.promise; upstreamPending = false; }
    return modelResponse(call);
  });
  const pending = f.request({body: requestBody(180)});
  await started.promise;
  const response = await pending;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [], resultPending = consumeChatEvents(response.body, (type, data) => {
    events.push({type, data}); if (type === 'progress') progressSeen.resolve();
  });
  await progressSeen.promise;
  assert.equal(upstreamPending, true, 'Headers and progress must reach the browser before model completion');
  assert(!events.some(item => item.type === 'done'));
  release.resolve();
  const result = await resultPending;
  assert(f.calls.filter(call => call.context.stage === 'full-data').length > 1);
  assert.equal(f.calls.at(-1).context.stage, 'synthesis');
  assert(!f.calls.some(call => call.context.stage === 'context'));
  assert.deepEqual([...new Set(events.filter(item => item.type === 'progress').map(item => item.data.stage))], ['preparing', 'processing', 'synthesis']);
  assert.equal(events.filter(item => item.type === 'done').length, 1);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.reviewedFrameCount, 180);
  assert.equal(result.coverage.measurementCount, 180);
  assert.equal(result.verdict.status, 'needs-improvement');
  assert(result.feedback[0].correction);
  assert(!JSON.stringify(result).includes(png));
});

test('motion-specific timeout retries once then emits an SSE error after headers, without a done report', {timeout: 5000}, async t => {
  const f = await fixture(t, call => new Promise((_resolve, reject) => {
    const abort = () => reject(call.signal.reason);
    if (call.signal.aborted) abort(); else call.signal.addEventListener('abort', abort, {once: true});
  }), {aiTimeoutMs: 60000, motionAiTimeoutMs: 15});
  const response = await f.request(), source = await response.text();
  assert.equal(response.status, 200, 'Once progress starts, the error must use the SSE channel');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(call => call.signal.aborted));
  assert.match(source, /"stage":"retry"/);
  assert.match(source, /event: error\ndata: .*超时/);
  assert(!source.includes('event: done'));
});

test('disconnecting the motion stream cancels the pending upstream request', {timeout: 5000}, async t => {
  const started = deferred(), aborted = deferred();
  const f = await fixture(t, call => new Promise((_resolve, reject) => {
    started.resolve();
    const abort = () => { aborted.resolve(); reject(call.signal.reason); };
    if (call.signal.aborted) abort(); else call.signal.addEventListener('abort', abort, {once: true});
  }));
  const controller = new AbortController(), response = await f.request({signal: controller.signal});
  await started.promise;
  const read = assert.rejects(response.text(), {name: 'AbortError'});
  controller.abort();
  await read; await aborted.promise;
  assert.equal(f.calls.length, 1, 'A cancelled request must not retry or advance to the data stage');
  assert.equal(f.calls[0].signal.aborted, true);
});

test('motion stream rejects stale accounts, missing authentication and invalid full data before opening SSE', async t => {
  const f = await fixture(t);
  for (const [request, status] of [[{userId: f.bob.id}, 409], [{account: null}, 401], [{account: f.bob}, 400], [{body: {...requestBody(), fullAnalysis: null}}, 400]]) {
    const response = await f.request(request);
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert((await response.json()).error);
  }
  assert.equal(f.calls.length, 0, 'Rejected streams must not use another account’s model or call an upstream provider');
});

test('motion client binds its captured account, forwards progress and rejects incomplete streams and HTTP errors', async () => {
  const previous = globalThis.fetch, progress = [], body = requestBody(), controller = new AbortController();
  const reply = text => new Response(text, {headers: {'Content-Type': 'text/event-stream; charset=utf-8'}});
  try {
    setApiUser('new-account');
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/motion/coach');
      assert.equal(options.headers['X-Fitness-User'], 'captured-account');
      assert.equal(options.headers.Accept, 'text/event-stream');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.signal, controller.signal);
      assert.deepEqual(JSON.parse(options.body), {...body, stream: true});
      return reply(event('progress', {stage: 'processing', completed: 1, total: 2}) + event('progress', {stage: 'synthesis', completed: 2, total: 2}) + event('done', {verdict: {status: 'needs-improvement', summary: '保持动作稳定。'}}));
    };
    const result = await streamMotionCoach(body, {userId: 'captured-account', signal: controller.signal, onProgress: value => progress.push(value)});
    assert.equal(result.verdict.status, 'needs-improvement');
    assert.deepEqual(progress.map(item => item.stage), ['processing', 'synthesis']);
    globalThis.fetch = async () => reply(event('progress', {stage: 'processing', completed: 1, total: 2}));
    await assert.rejects(streamMotionCoach(body), /连接中断/);
    globalThis.fetch = async () => reply(event('error', {error: 'AI 响应超时，请重试。'}));
    await assert.rejects(streamMotionCoach(body), /超时/);
    globalThis.fetch = async () => Response.json({error: '登录账号已切换'}, {status: 409});
    await assert.rejects(streamMotionCoach(body), error => error.status === 409 && error.message === '登录账号已切换');
    globalThis.fetch = async () => Response.json({verdict: {status: 'standard'}});
    await assert.rejects(streamMotionCoach(body), /需要更新/);
  } finally {globalThis.fetch = previous; setApiUser(null);}
});
