import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server.mjs';
import {completeMotionCoach, validateMotionCoachRequest} from '../server/motion-coach.mjs';
import {planMotionCoachBatches, decodeMotionCoachBlock} from '../server/motion-coach-batches.mjs';
import {compactMotionAnalysis} from '../public/motion-contract.js';
import {buildMotionPoseData, buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {analyzeMotion} from '../public/motion-analysis.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const provider = (vision = true) => ({id: 'full-coach', name: 'Full coach fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-private-key', model: 'full-model', models: [{id: 'full-model', vision}]});
const modelResponse = (output, finish_reason = 'stop') => Response.json({choices: [{message: {content: JSON.stringify(output)}, finish_reason}]});
const parseCall = options => {
  const body = JSON.parse(options.body);
  return {body, context: JSON.parse(body.messages[1].content[0].text), signal: options.signal};
};

function requestFixture({frameCount = 75} = {}) {
  const duration = Math.max(8, frameCount / 15);
  const pipeline = toMediaPipePipeline({duration, width: 1920, height: 1080, sampleFps: 15, sourceFps: 30, frames: Array.from({length: frameCount}, (_, frameIndex) => ({
    time: frameIndex / 15, sourceTime: frameIndex / 15, personCount: 1,
    landmarks: Array.from({length: 33}, (_, pointIndex) => ({x: 0.123456789013579 + frameIndex / (frameCount * 1.8) + pointIndex / 331, y: 0.234567891027913 + pointIndex / 167, visibility: 0.9876543210123})),
  }))});
  const fullAnalysis = buildFullMotionAnalysis(analyzeMotion(pipeline.frames, pipeline), pipeline);
  const body = {duration, poseData: buildMotionPoseData(pipeline), fullAnalysis, analysis: compactMotionAnalysis(fullAnalysis), keyframes: [{time: 0.25, mimeType: 'image/png', data: png}, {time: 0.75, mimeType: 'image/png', data: png}]};
  const input = validateMotionCoachRequest(body);
  const packets = planMotionCoachBatches(input, {compactPose: true});
  if (frameCount === 75) assert(packets.length >= 2 && packets.length <= 30, `Fixture should exercise several manageable packets, got ${packets.length}`);
  return {body, input, packets};
}

function feedback(frameIndices, visual, title = '连续动作幅度变化') {
  return {title, status: 'improve', source: visual ? 'combined' : 'pose', frameIndices, evidenceTimes: visual ? [0.25] : [], evidence: '对应骨架采样显示前后位置存在变化，需结合可靠关节观察幅度。', correction: '下一组放慢动作，并保持前后重复动作的幅度一致。', priority: 1};
}

function outputFor(call, {visual = true} = {}) {
  const context = call.context;
  const findings = context.stage === 'synthesis'
    ? context.data.reviewedParts.flatMap(part => part.report.feedback).slice(0, 8)
    : context.data.frameIndices?.length ? [feedback([...new Set([context.data.frameIndices[0], context.data.frameIndices.at(-1)])], visual && context.frames.length > 0, `动作观察 ${context.data.index + 1}`)] : [];
  return {action: {exerciseId: null, name: null, family: null, status: 'unknown', confidence: 'low', evidenceTimes: []}, verdict: {status: context.stage === 'synthesis' || context.data.total === 1 ? 'needs-improvement' : 'uncertain', summary: '前后动作幅度需要保持一致。'}, overallEvaluation: '结合已提供骨架及可用画面，优先保持前后动作的幅度一致。', feedback: findings, limitations: []};
}

function reconstruct(calls) {
  const roots = {}, seen = new Set();
  for (const call of calls.filter(call => call.context.stage === 'full-data')) for (const encoded of call.context.data.blocks) {
    const {path, value} = decodeMotionCoachBlock(encoded);
    assert(!seen.has(JSON.stringify(path)), 'Successful packets must cover original fields exactly once');
    seen.add(JSON.stringify(path));
    let container = roots;
    for (let index = 0; index < path.length - 1; index++) {
      const key = path[index];
      container[key] ??= typeof path[index + 1] === 'number' ? [] : {};
      container = container[key];
    }
    container[path.at(-1)] = value;
  }
  return roots;
}

function assertNoRawData(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!['poseData', 'fullAnalysis', 'landmarks', 'worldLandmarks', 'blocks', 'keyframes', 'coordinates', 'dataUrl'].includes(key), `Response/history leaked raw ${key}`);
    assertNoRawData(child);
  }
  assert(!JSON.stringify(value).includes(png), 'Raw picture data must remain transient');
}

function assertNoLocalJudgments(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!['score', 'observedScore', 'scoreStatus', 'scoreCoverage', 'scoreCap', 'checks', 'rules', 'recognitionRules', 'reps', 'qualified', 'attemptCount'].includes(key), `Unexpected local judgment field: ${key}`);
    assertNoLocalJudgments(child);
  }
}

test('measurement packets retain evidence from the final frame rather than trimming to an early summary', async () => {
  const {input} = requestFixture();
  const result = await completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options), output = outputFor(call);
    if(call.context.stage==='synthesis') output.feedback = [...call.context.data.reviewedParts.flatMap(part => part.report.feedback).filter(item => item.source === 'analysis'), ...output.feedback];
    if(call.context.stage==='full-data'&&call.context.data.measurementIndices.includes(74)) {
      output.feedback.push({title:'末帧肘部控制',status:'improve',source:'analysis',analysisPaths:[['measurements',74,'left','elbowAngle']],evidence:'末帧保留了肘部投影角度，需结合完整动作观察控制。',correction:'下一组控制肘部运动，不要突然伸直。',priority:1});
    }
    return modelResponse(output);
  }});
  const finding=result.feedback.find(item=>item.source==='analysis');
  assert(finding,'A report-only data packet must not lose its measured observation');
  assert.deepEqual(finding.analysisPaths,[['measurements',74,'left','elbowAngle']]);
  assert.deepEqual(finding.evidenceTimes,[input.fullAnalysis.measurements[74].time]);
  assert.deepEqual(finding.frameIndices,[]);
  assertNoRawData(result);
});

test('full coach reviews every raw point and objective measurement without sending or returning local scores and rules', async () => {
  const {input, packets} = requestFixture(), calls = [];
  const result = await completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    return modelResponse(outputFor(call));
  }});
  assert.equal(calls.filter(call => call.context.stage === 'full-data').length, packets.length);
  assert.equal(calls[0].context.stage, 'full-data');
  assert.equal(calls.at(-1).context.stage, 'synthesis');
  assert.equal(calls.length, packets.length + 1, 'The first data call includes images; only split inputs need a final synthesis');
  assert.deepEqual(reconstruct(calls), {poseData: input.poseData, fullAnalysis: input.fullAnalysis}, 'Complete original values survive every packet without rounding or omitted tail frames');
  const rebuilt = reconstruct(calls);
  assert.deepEqual(rebuilt.poseData.frames[0].landmarks[0], input.poseData.frames[0].landmarks[0]);
  assert.deepEqual(rebuilt.poseData.frames.at(-1).worldLandmarks.at(-1), input.poseData.frames.at(-1).worldLandmarks.at(-1));
  assert.deepEqual(rebuilt.fullAnalysis.measurements[74], input.fullAnalysis.measurements[74]);
  assert.deepEqual(Object.keys(input.analysis).sort(), ['evidenceFrames', 'quality']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.reviewedFrameCount, 75);
  assert.equal(result.coverage.measurementCount, 75);
  assert.equal(result.coverage.dataBatches, packets.length);
  assert.equal(result.coverage.modelCalls, calls.length);
  assert(result.feedback.some(item => item.source === 'pose' && item.frameIndices.length && item.evidenceTimes.some(time => ![0.25, 0.75].includes(time))), 'Final pose findings retain actual non-picture timestamps');
  assert.equal(result.verdict.status, 'needs-improvement');
  for (const call of calls) {
    const dataOnly = call.context.stage === 'full-data' && call.context.data.index > 0;
    assert.equal(call.body.messages[1].content.filter(part => part.type === 'image_url').length, dataOnly ? 0 : 2);
    assert.equal(call.context.frames.length, dataOnly ? 0 : 2);
    if (dataOnly) {
      assert(!JSON.stringify(call.body).includes(png), 'Data batches must not repeatedly transmit images');
      assert(call.context.actionContext, 'Data batches retain the preceding visual action reference');
    }
    assertNoLocalJudgments(call.context);
    assert(!/"(?:checks|rules|recognitionRules|score)"/.test(call.body.messages[0].content));
  }
  assertNoLocalJudgments(result);
  assertNoRawData(result);
});

test('a small complete clip needs only one model call containing all pose, measurements and images', async () => {
  const {input, packets} = requestFixture({frameCount: 3}), calls = [];
  assert.equal(packets.length, 1);
  const result = await completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    return modelResponse({...outputFor(call), score: 99, checks: [{code: 'OLD_LOCAL_RULE', status: 'pass'}], rules: [{threshold: 90}], reps: [{score: 99}]});
  }});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.stage, 'full-data');
  assert.equal(calls[0].context.frames.length, 2);
  assert.deepEqual(reconstruct(calls), {poseData: input.poseData, fullAnalysis: input.fullAnalysis});
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.modelCalls, 1);
  assertNoLocalJudgments(result); // Ignore legacy fields even if an upstream model supplies them.
});

test('text-only full coach is rejected before any provider call', async () => {
  const {input} = requestFixture(), calls = [];
  await assert.rejects(completeMotionCoach({provider: provider(false), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    return modelResponse(outputFor(call));
  }}), error => error.status === 400 && /视觉|图片/.test(error.message));
  assert.equal(calls.length, 0);
});

test('all six key screenshots and their timestamps reach the configured visual model intact', async () => {
  const {body} = requestFixture({frameCount: 3}), calls = [];
  body.keyframes = Array.from({length: 6}, (_, index) => ({time: index / 3, mimeType: 'image/png', data: png}));
  const input = validateMotionCoachRequest(body);
  await completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call); const output=outputFor(call);
    output.feedback.forEach(item=>{item.evidenceTimes=[input.keyframes[0].time];});
    return modelResponse(output);
  }});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context.frames, input.keyframes.map(({time, mimeType}, imageIndex) => ({imageIndex, time, mimeType})));
  assert.deepEqual(calls[0].body.messages[1].content.filter(part => part.type === 'image_url').map(part => part.image_url.url),
    input.keyframes.map(frame => `data:${frame.mimeType};base64,${frame.data}`));
  assert.deepEqual(reconstruct(calls), {poseData: input.poseData, fullAnalysis: input.fullAnalysis});
});

test('an uncertain review does not become standard merely because no concrete problem was returned', async () => {
  const {input}=requestFixture({frameCount:3});
  Object.assign(input.fullAnalysis.quality,{targetCoverage:.45,usableRatio:.45,sourceFps:4,reasons:['TARGET_NOT_LOCKED']});
  const result=await completeMotionCoach({provider:provider(),input,fetchImpl:async()=>modelResponse({
    action:{status:'unknown'},verdict:{status:'uncertain',summary:'二维骨架且目标覆盖率约45%，暂时无法判断。'},feedback:[],limitations:[],
  })});
  assert.equal(result.verdict.status,'uncertain');
  assert.doesNotMatch(result.verdict.summary,/^动作相对标准/);
  assert.deepEqual(result.feedback,[],'No positive findings or problems are fabricated');
});

test('AI output errors and rejected problem references cannot masquerade as no problems found', async () => {
  const {input}=requestFixture({frameCount:3});
  const invalidOutputs=[
    {feedback:[]},
    {verdict:{status:'needs-improvement'},feedback:[]},
    {verdict:{status:'standard'},feedback:[{...feedback([999],false),evidence:'髋部出现明确偏移。'}]},
    {verdict:{status:'needs-improvement'},feedback:[{...feedback([0],false),correction:''}]},
  ];
  for(const output of invalidOutputs)await assert.rejects(completeMotionCoach({provider:provider(),input,fetchImpl:async()=>modelResponse(output)}),error=>error.status===502);
});

test('an intermediate problem claim without details fails before it can be summarized as standard',async()=>{
  const {input}=requestFixture(),calls=[];
  await assert.rejects(completeMotionCoach({provider:provider(),input,fetchImpl:async(_url,options)=>{
    const call=parseCall(options);calls.push(call);
    return modelResponse(call.context.stage==='full-data'
      ?{verdict:{status:'needs-improvement'},feedback:[]}
      :{verdict:{status:'standard'},feedback:[]});
  }}),error=>error.status===502&&/具体问题/.test(error.message));
  assert.equal(calls.length,1);assert.equal(calls[0].context.stage,'full-data');
});

test('final synthesis can inspect its images but cannot invent uncited pose, measurement or absent image evidence', async () => {
  const {input} = requestFixture();
  let forgedIndex;
  const result = await completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options), output = outputFor(call);
    if (call.context.stage === 'synthesis') {
      const cited = new Set(output.feedback.flatMap(item => item.frameIndices));
      forgedIndex = input.poseData.frames.findIndex((_frame, index) => !cited.has(index));
      assert(forgedIndex >= 0);
      output.feedback.push(feedback([forgedIndex], false, '未经分段引用的新骨架观察'));
      output.feedback.push({...feedback([], true, '本次提供图片的可见问题'), source: 'visual', evidenceTimes: [0.75]});
      output.feedback.push({...feedback([[...cited][0]], true, '已引用骨架结合本次图片'), evidenceTimes: [0.75]});
      output.feedback.push({...feedback([], true, '不存在的图片时间'), source: 'visual', evidenceTimes: [99]});
      output.feedback.push({...feedback([], false, '未经分段引用的测量'), source: 'analysis', analysisPaths: [['measurements', 0, 'left', 'elbowAngle']]});
      output.feedback.push({...feedback([], false, '不存在的旧规则路径'), source: 'analysis', analysisPaths: [['reps', 0, 'metrics', 'duration']]});
    }
    return modelResponse(output);
  }});
  assert(result.feedback.length > 0);
  assert(!result.feedback.some(item => item.frameIndices.includes(forgedIndex)));
  assert(result.feedback.some(item => item.source === 'visual' && item.title === '本次提供图片的可见问题' && item.evidenceTimes.includes(0.75)));
  assert(result.feedback.some(item => item.source === 'combined' && item.title === '已引用骨架结合本次图片'));
  assert(!result.feedback.some(item => /未经|不存在/.test(item.title)));
});

test('hierarchical synthesis preserves verified visual evidence without allowing new image or pose-time claims', async () => {
  const {input} = requestFixture({frameCount: 400}), calls = [];
  const retainedTitles = ['首包骨架与画面问题', '首包可见姿态问题', '首包另一处联合证据'];
  const result = await completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options), {context} = call;
    calls.push(call);
    const output = outputFor(call);
    if (context.stage === 'full-data' && context.data.frameIndices.length) {
      output.feedback = Array.from({length: 3}, (_, index) => ({
        ...feedback([context.data.frameIndices[0]], context.data.index === 0, context.data.index === 0 ? retainedTitles[index] : `后续骨架观察 ${context.data.index}-${index}`),
        // Long but accepted model answers exercise the real 64K reduction path.
        evidence: '已提供的骨架和画面显示身体位置变化，需要稳定控制动作。'.repeat(40),
        correction: '下一组放慢运动过程，保持身体稳定并控制动作幅度。'.repeat(40),
        ...(context.data.index === 0 && index === 1 ? {source: 'visual', frameIndices: [], evidenceTimes: [0.25]} : {}),
      }));
    } else if (context.stage === 'synthesis') {
      output.feedback = context.data.reviewedParts.flatMap(part => part.report.feedback).slice(0, 3);
      if (!context.frames.length) {
        // 0.75 is an original input image but no earlier finding cited it.
        output.feedback.push({...feedback([], true, '未引用的原始图片'), source: 'visual', evidenceTimes: [0.75]});
        // The combined finding contains pose time 0 as well as image time 0.25.
        // That pose timestamp must never turn into an inherited image reference.
        output.feedback.push({...feedback([], true, '骨架时间伪装图片'), source: 'visual', evidenceTimes: [0]});
      }
    }
    return modelResponse(output);
  }});
  const intermediate = calls.filter(call => call.context.stage === 'synthesis' && !call.context.frames.length);
  assert(intermediate.length >= 2, 'Fixture must require an actual intermediate reduction without images');
  assert(intermediate.some(call => call.context.data.reviewedParts.some(part => part.report.feedback.some(item => item.source === 'combined'))));
  const finalCall = calls.at(-1);
  assert.equal(finalCall.context.stage, 'synthesis');
  assert.equal(finalCall.context.frames.length, 2);
  const finalInputFindings = finalCall.context.data.reviewedParts.flatMap(part => part.report.feedback);
  for (const title of retainedTitles) {
    assert(finalInputFindings.some(item => item.title === title), `Intermediate reduction lost ${title}`);
    assert(result.feedback.some(item => item.title === title), `Final report lost ${title}`);
  }
  assert(result.feedback.some(item => item.source === 'combined' && item.frameIndices.includes(0) && item.evidenceTimes.includes(0.25)));
  assert(result.feedback.some(item => item.source === 'visual' && item.evidenceTimes.includes(0.25)));
  assert(!finalInputFindings.some(item => /未引用的原始图片|骨架时间伪装图片/.test(item.title)));
  assert(!result.feedback.some(item => /未引用的原始图片|骨架时间伪装图片/.test(item.title)));
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.reviewedFrameCount, 400);
  assertNoLocalJudgments(result);
});

test('upstream context overflow is explicit and never falls back to summary or partial output', async () => {
  const {input} = requestFixture(), calls = [];
  await assert.rejects(completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    calls.push(parseCall(options));
    return Response.json({error: {message: 'Maximum context length exceeded: too many input tokens.', code: 'context_length_exceeded'}}, {status: 400});
  }}), error => error.status === 502 && /完整骨架数据/.test(error.message) && /未改用摘要/.test(error.message));
  assert.equal(calls.length, 1, 'A failed first data request stops before later work');
  assert.equal(calls[0].context.stage, 'full-data');
});

for (const stage of ['full-data', 'synthesis']) test(`truncated ${stage} output cannot publish a successful partial report`, async () => {
  const {input, packets} = requestFixture(), calls = [];
  await assert.rejects(completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    return modelResponse(outputFor(call), call.context.stage === stage ? 'length' : 'stop');
  }}), error => error.status === 502 && /截断/.test(error.message));
  if (stage === 'full-data') assert(calls.every(call => call.context.stage === 'full-data'));
  else assert.equal(calls.filter(call => call.context.stage === 'full-data').length, packets.length);
});

test('a model response missing the full feedback schema cannot silently publish a legacy report', async () => {
  const {input} = requestFixture(), calls = [];
  await assert.rejects(completeMotionCoach({provider: provider(), input, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    const output = outputFor(call); delete output.feedback;
    return modelResponse(output);
  }}), error => error.status === 502 && /完整骨架评价/.test(error.message));
  assert.deepEqual(calls.map(call => call.context.stage), ['full-data']);
});

test('a later packet failure aborts its in-flight peer and prevents synthesis', {timeout: 5000}, async () => {
  const {input} = requestFixture(), calls = [];
  let peerAborted = false;
  await assert.rejects(completeMotionCoach({provider: provider(), input, timeoutMs: 2000, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    if (call.context.data.index === 0) return modelResponse(outputFor(call));
    if (call.context.data.index === 1) return new Promise((_resolve, reject) => {
      const abort = () => { peerAborted = true; reject(options.signal.reason); };
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
    });
    return Response.json({error: {message: 'Later batch failed'}}, {status: 503});
  }}), error => error.status === 502 && /503/.test(error.message));
  assert.equal(peerAborted, true);
  assert(calls.some(call => call.context.data.index >= 2));
  assert(calls.every(call => call.context.stage === 'full-data'));
});

test('cancelling after a later packet starts aborts all in-flight work and publishes no report', {timeout: 5000}, async () => {
  const {input} = requestFixture(), controller = new AbortController(), calls = [];
  let signalStarted;
  const laterStarted = new Promise(resolve => { signalStarted = resolve; });
  const aborted = [];
  const pending = completeMotionCoach({provider: provider(), input, signal: controller.signal, timeoutMs: 2000, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    if (call.context.data.index === 0) return modelResponse(outputFor(call));
    return new Promise((_resolve, reject) => {
      const abort = () => { aborted.push(call.context.data.index); reject(options.signal.reason); };
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
      if (call.context.data.index >= 2) signalStarted();
    });
  }});
  const rejection = assert.rejects(pending, error => error.name === 'AbortError' && /cancelled by user/.test(error.message));
  await laterStarted;
  controller.abort(new DOMException('cancelled by user', 'AbortError'));
  await rejection;
  assert.deepEqual(aborted.sort(), [1, 2]);
  assert(calls.every(call => call.context.stage === 'full-data'));
});

test('a packet that times out is retried once while completed packets and progress are retained', {timeout: 5000}, async () => {
  const {input, packets} = requestFixture(), calls = [], progress = [], attempts = new Map();
  const result = await completeMotionCoach({provider: provider(), input, timeoutMs: 30, onProgress: async event => {
    await Promise.resolve(); progress.push(event);
  }, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    if (call.context.stage === 'full-data') {
      const index = call.context.data.index, count = (attempts.get(index) || 0) + 1;
      attempts.set(index, count);
      if (index === 1 && count === 1) return new Promise((_resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
      });
    }
    return modelResponse(outputFor(call));
  }});
  assert.equal(attempts.get(1), 2);
  for (const [index, count] of attempts) if (index !== 1) assert.equal(count, 1, 'Finished data cannot be replayed on a different packet timeout');
  assert.equal(attempts.size, packets.length);
  assert.equal(calls.length, packets.length + 2);
  assert.equal(progress.filter(event => event.stage === 'retry').length, 1);
  assert(progress.find(event => event.stage === 'retry').completed > 0, 'Retry progress preserves completed work');
  assert.deepEqual(progress.filter(event => event.stage === 'processing').map(event => event.completed), Array.from({length: packets.length + 1}, (_, index) => index));
  assert.equal(progress.at(-1).stage, 'synthesis');
  assert.equal(progress.at(-1).completed, packets.length);
  const successful = calls.filter(call => call.context.stage !== 'full-data' || call.context.data.index !== 1 || call === calls.findLast(item => item.context.stage === 'full-data' && item.context.data.index === 1));
  assert.deepEqual(reconstruct(successful), {poseData: input.poseData, fullAnalysis: input.fullAnalysis});
  assert.deepEqual(calls.filter(call => call.context.stage === 'full-data' && call.context.data.index === 1).map(call => call.context.data), [packets[1], packets[1]], 'The retried request contains the same complete packet');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.modelCalls, calls.length);
  assertNoRawData(result);
});

test('a second timeout on the same packet stops without synthesis or a partial result', {timeout: 5000}, async () => {
  const {input} = requestFixture(), calls = [], progress = [];
  await assert.rejects(completeMotionCoach({provider: provider(), input, timeoutMs: 20, onProgress: event => progress.push(event), fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call);
    if (call.context.stage === 'full-data' && call.context.data.index === 1) return new Promise((_resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
    });
    return modelResponse(outputFor(call));
  }}), error => error.status === 504 && /超时/.test(error.message));
  assert.equal(calls.filter(call => call.context.stage === 'full-data' && call.context.data.index === 1).length, 2);
  assert.equal(progress.filter(event => event.stage === 'retry').length, 1);
  assert(!calls.some(call => call.context.stage === 'synthesis'));
});

test('incomplete full-data requests fail validation instead of silently becoming legacy requests', () => {
  const {body} = requestFixture();
  for (const mutate of [
    value => { delete value.poseData; },
    value => { delete value.fullAnalysis; },
    value => { value.poseData = null; },
    value => { value.fullAnalysis = null; },
    value => { value.poseData.frames.at(-1).landmarks.pop(); },
    value => { value.fullAnalysis.measurements.pop(); },
    value => { value.fullAnalysis.measurements.at(-1).time -= 0.001; },
    value => { value.fullAnalysis.score = 100; },
  ]) {
    const invalid = structuredClone(body); mutate(invalid);
    assert.throws(() => validateMotionCoachRequest(invalid), error => error.status === 400);
  }
});

test('real HTTP complete-data route keeps raw data transient and saved reports contain only evaluated output', async t => {
  const {body} = requestFixture(), calls = [], dataDir = await mkdtemp(join(tmpdir(), 'motion-full-http-'));
  const server = await startServer({host: '127.0.0.1', port: 0, dataDir, fetchImpl: async (_url, options) => {
    const call = parseCall(options); calls.push(call); return modelResponse(outputFor(call));
  }});
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const api = async (path, payload, method) => {
    const response = await fetch(base + path, {method: method || (payload ? 'POST' : 'GET'), headers: {'Content-Type': 'application/json', ...(cookie ? {cookie} : {})}, ...(payload ? {body: JSON.stringify(payload)} : {})});
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return {status: response.status, body: await response.json()};
  };
  const account = await api('/api/auth/register', {name: 'Full motion', email: 'full-motion@example.test', password: 'full-motion-test-password'});
  assert.equal(account.status, 201);
  const configured = await api('/api/providers', {providers: [provider()], tasks: {motion: 'full-coach'}, taskModels: {motion: 'full-model'}}, 'PUT');
  assert.equal(configured.status, 200);
  const invalid = {...body}; delete invalid.fullAnalysis;
  assert.equal((await api('/api/motion/coach', invalid)).status, 400);
  assert.equal(calls.length, 0, 'Invalid complete-data payload never reaches an upstream model');
  const completed = await api('/api/motion/coach', body);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.coverage.complete, true);
  assert.equal(completed.body.coverage.measurementCount, 75);
  assertNoRawData(completed.body);
  assertNoLocalJudgments(completed.body);
  const beforeSave = await api('/api/export');
  assert.deepEqual(beforeSave.body.attachments, []);
  assert(!beforeSave.body.records.some(record => record.kind === 'motion-assessment'));
  const report = {version: 'motion-report-v1', quality: body.fullAnalysis.quality, coach: completed.body, createdAt: new Date().toISOString()};
  const saved = await api('/api/sync', {userId: account.body.user.id, changes: [{id: 'motion:complete-sequence', kind: 'motion-assessment', baseVersion: 0, data: report}]});
  assert.equal(saved.status, 200);
  const exported = await api('/api/export');
  assert.deepEqual(exported.body.attachments, []);
  const stored = exported.body.records.find(record => record.id === 'motion:complete-sequence');
  assert.deepEqual(stored.data, report);
  assertNoRawData(stored.data);
  assert(!JSON.stringify(exported.body).includes(png));
});
