import test from 'node:test';
import assert from 'node:assert/strict';
import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData, buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {compactMotionAnalysis, mergeCoachAssessment} from '../public/motion-contract.js';
import {validateMotionCoachRequest, completeMotionCoach} from '../server/motion-coach.mjs';
import {buildMotionTemporalEvidence} from '../server/motion-coach-temporal.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const provider = {id: 'temporal-fixture', name: 'Temporal fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only', model: 'visual-model', models: [{id: 'visual-model', vision: true}]};
const response = output => Response.json({choices: [{message: {content: JSON.stringify(output)}, finish_reason: 'stop'}]});
function fixture(frameCount = 150) {
  const duration = frameCount / 15;
  const pipeline = toMediaPipePipeline({duration, width: 1920, height: 1080, sampleFps: 15, sourceFps: 30,
    frames: Array.from({length: frameCount}, (_, frameIndex) => ({time: frameIndex / 15, personCount: 1,
      landmarks: Array.from({length: 33}, (_, pointIndex) => ({
        x: Math.fround(.25 + pointIndex / 130 + Math.sin(frameIndex / 8 + pointIndex) * .05),
        y: Math.fround(.2 + pointIndex / 70 + Math.cos(frameIndex / 13 + pointIndex) * .05), visibility: Math.fround(.98),
      })),
    }))});
  const poseData = buildMotionPoseData(pipeline), fullAnalysis = buildFullMotionAnalysis(analyzeMotion(pipeline.frames, pipeline), pipeline);
  return validateMotionCoachRequest({reviewMode: 'temporal', duration, poseData, fullAnalysis, analysis: compactMotionAnalysis(fullAnalysis),
    keyframes: [duration * .8, duration * .2].map(time => ({time, mimeType: 'image/png', data: png}))});
}
const finding = (indices, title = '髋膝运动控制') => ({title, status: 'improve', source: 'pose', frameIndices: indices,
  evidence: '所引时刻的髋膝位置变化显示起身时需要同步控制。', correction: '起身时保持肩髋同步，避免突然抬高髋部。', priority: 1});

test('ten- and sixty-second videos use one bounded package with honest selected-frame coverage', async () => {
  for (const frameCount of [150, 900]) {
    const input = fixture(frameCount), calls = [], progress = [];
    const original = JSON.stringify(input);
    const coach = await completeMotionCoach({provider, input, onProgress: event => progress.push(event), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body), context = JSON.parse(body.messages[1].content[0].text);
      calls.push({body, context});
      return response({action: {status: 'unknown'}, verdict: {status: 'needs-improvement'}, feedback: [finding(context.evidence.sourceFrameIndices.slice(0, 2))]});
    }});
    assert.equal(calls.length, 1);
    const {evidence} = calls[0].context;
    assert.equal(calls[0].context.stage, 'temporal-evidence');
    assert(JSON.stringify(evidence).length <= 64000);
    assert(evidence.sourceFrameIndices.length <= 64 && evidence.sourceFrameIndices.length >= 24);
    assert.equal(evidence.sourceFrameIndices[0], 0);
    assert.equal(evidence.sourceFrameIndices.at(-1), frameCount - 1);
    assert.deepEqual(evidence.frames.map(frame => frame.frameIndex), evidence.sourceFrameIndices);
    assert(evidence.frames.every(frame => frame.landmarks.length === 17));
    assert.equal(evidence.windows.reduce((count, window) => count + window.sourceFrameCount, 0), frameCount);
    assert.equal(coach.coverage.strategy, 'temporal-evidence');
    assert.equal(coach.coverage.sourceFrameCount, frameCount);
    assert.equal(coach.coverage.frameCount, evidence.sourceFrameIndices.length);
    assert.equal(coach.coverage.reviewedFrameCount, evidence.sourceFrameIndices.length);
    assert.equal(coach.coverage.summarizedMeasurementCount, frameCount);
    assert.equal(coach.coverage.dataBatches, 1);
    assert.equal(coach.verdict.status, 'needs-improvement');
    assert.equal(progress.at(-1).completed, 1);
    assert.deepEqual(calls[0].context.frames.map(frame => frame.time), input.keyframes.map(frame => frame.time).sort((a, b) => a - b));
    assert(!JSON.stringify(coach).includes('landmarks'));
    assert(!JSON.stringify(coach).includes(png));
    assert.equal(JSON.stringify(input), original, 'Evidence extraction leaves complete observations unchanged');
    const saved = mergeCoachAssessment(input.analysis, coach);
    assert.equal(saved.coach.coverage.sourceFrameCount, frameCount);
    assert.equal(saved.coach.coverage.strategy, 'temporal-evidence');
  }
});

test('short clips retain every source frame and missing points remain unknown', () => {
  const input = fixture(20);
  input.poseData.frames[2].landmarks[11] = [null, .2, .9, 1];
  input.poseData.frames[3].landmarks[11] = null;
  const {evidence} = buildMotionTemporalEvidence(input);
  assert.deepEqual(evidence.sourceFrameIndices, Array.from({length: 20}, (_, index) => index));
  const shoulder = evidence.poseSchema.landmarkIndices.indexOf(11);
  assert.equal(evidence.frames[2].landmarks[shoulder][0], null);
  assert.equal(evidence.frames[3].landmarks[shoulder], null);
});

test('numeric compaction cannot turn out-of-image or low-response landmarks into reliable points', () => {
  const input = fixture(12);
  input.poseData.frames[0].landmarks[11] = [-.000001, 1.000001, .5496];
  input.poseData.frames[1].landmarks[11] = [.123456789, .987654321, .55000000001];
  const {evidence} = buildMotionTemporalEvidence(input);
  const shoulder = evidence.poseSchema.landmarkIndices.indexOf(11);
  assert.deepEqual(evidence.frames[0].landmarks[shoulder], [-.000001, 1.000001, .5496]);
  assert.deepEqual(evidence.frames[1].landmarks[shoulder], [.12346, .98765, .55000000001]);
  assert.equal(evidence.poseSchema.visibilityPrecision, 'original');
  assert.equal(evidence.poseSchema.outOfBoundsCoordinates, 'original');
});

test('window statistics preserve late motion, exact values and valid global source references', () => {
  const input = fixture(900);
  input.fullAnalysis.measurements.forEach(row => {row.left.elbowAngle = 95;});
  input.fullAnalysis.measurements[897].left.elbowAngle = 11.123456789123;
  input.fullAnalysis.measurements[898].left.elbowAngle = 169.987654321;
  const {evidence, allowedAnalysisPaths} = buildMotionTemporalEvidence(input);
  const stats = evidence.windows.at(-1).statistics.find(item => item.path.join('.') === 'left.elbowAngle');
  assert.deepEqual(stats.values.slice(5), [897, 11.123456789123, 898, 169.987654321]);
  assert(evidence.sourceFrameIndices.includes(897));
  assert(evidence.sourceFrameIndices.includes(898));
  for (const path of allowedAnalysisPaths) {
    assert.equal(path[0], 'measurements');
    assert(Number.isFinite(input.fullAnalysis.measurements[path[1]][path[2]][path[3]]));
  }
  assert(allowedAnalysisPaths.some(path => path.join('.') === 'measurements.897.left.elbowAngle'));
  assert(evidence.statisticSourceTimes.some(([index, time]) => index === 897 && time === input.poseData.frames[897].time));
});

test('compact guided numbers declare approximation without promoting missing or unreliable observations', () => {
  const input = fixture(12);
  input.poseData.frames[0].landmarks[11] = [-.000001,1.000001,.5499999];
  input.poseData.frames[1].landmarks[11] = [.123456789,.987654321,.55000001];
  input.poseData.frames[2].landmarks[11] = [null,.2,.9,1];
  input.poseData.frames[3].landmarks[11] = [.1,.2,1.0000001];
  input.poseData.frames[0].subjectTracking = {status:'locked',trackId:'fixture',confidence:.6499999};
  input.fullAnalysis.measurements[0].left.kneeAngle = 11.123456789;
  const original = JSON.stringify(input);
  const {evidence,allowedAnalysisPaths} = buildMotionTemporalEvidence(input,{maxChars:24000,compactNumbers:true,minFrames:12});
  const shoulder = evidence.poseSchema.landmarkIndices.indexOf(11);
  assert.deepEqual(evidence.frames[0].landmarks[shoulder],[-.000001,1.000001,.549]);
  assert.deepEqual(evidence.frames[1].landmarks[shoulder],[.12346,.98765,.55]);
  assert.equal(evidence.frames[2].landmarks[shoulder][0],null);
  assert.equal(evidence.frames[3].landmarks[shoulder][2],1.0000001);
  assert.equal(evidence.frames[0].subjectTracking.confidence,.649);
  assert.equal(evidence.poseSchema.measurementDecimals,2);
  assert.equal(evidence.poseSchema.measurementPrecision,'approximate-rounded');
  assert.equal(evidence.poseSchema.visibilityPrecision,'floor-3-decimals-in-range');
  assert.equal(evidence.measurements[0][evidence.measurementColumns.indexOf('left.kneeAngle')],11.12);
  const statistic = evidence.windows[0].statistics.find(item=>item.path.join('.')==='left.kneeAngle');
  assert.equal(statistic.values[2],11.12);
  assert(allowedAnalysisPaths.some(path=>path.join('.')==='measurements.0.left.kneeAngle'));
  assert.equal(JSON.stringify(input),original);
});

test('compact 120-second evidence remains bounded with full source windows and distributed frame coverage', () => {
  const input = fixture(1800);
  const {evidence} = buildMotionTemporalEvidence(input,{maxChars:24000,compactNumbers:true,minFrames:12});
  assert(JSON.stringify(evidence).length<=24000);
  assert(evidence.sourceFrameIndices.length>=12&&evidence.sourceFrameIndices.length<=64);
  assert.equal(evidence.sourceFrameIndices[0],0);
  assert.equal(evidence.sourceFrameIndices.at(-1),1799);
  assert.equal(evidence.windows.reduce((sum,window)=>sum+window.sourceFrameCount,0),1800);
  assert.equal(evidence.summarizedMeasurementCount,1800);
});

test('compact evidence can reduce below the legacy 24-frame floor without dropping source coverage', () => {
  const input = fixture(900);
  for (const frame of input.poseData.frames) frame.subjectTracking = {status:'locked',trackId:'x'.repeat(80),confidence:.9,bbox:{xMin:.1,yMin:.1,xMax:.9,yMax:.9}};
  assert.throws(() => buildMotionTemporalEvidence(input,{maxChars:16000,compactNumbers:true,minFrames:12}), error => error.status === 413);
  const {evidence} = buildMotionTemporalEvidence(input,{maxChars:24000,compactNumbers:true,minFrames:12});
  assert(JSON.stringify(evidence).length<=24000);
  assert(evidence.frames.length>=12&&evidence.frames.length<24);
  assert.equal(evidence.sourceFrameIndices[0],0);
  assert.equal(evidence.sourceFrameIndices.at(-1),899);
  assert.equal(evidence.windows.reduce((sum,window)=>sum+window.sourceFrameCount,0),900);
});

test('a smaller budget remains bounded while summarizing every source measurement', () => {
  const input = fixture(1800);
  assert.throws(() => buildMotionTemporalEvidence(input, {maxChars: 20000}), error => error.status === 413);
  const {evidence} = buildMotionTemporalEvidence(input, {maxChars: 48000});
  assert(JSON.stringify(evidence).length <= 48000);
  assert.equal(evidence.sourceFrameIndices[0], 0);
  assert.equal(evidence.sourceFrameIndices.at(-1), 1799);
  assert.equal(evidence.windows.reduce((sum, window) => sum + window.sourceFrameCount, 0), 1800);
  assert.equal(evidence.summarizedMeasurementCount, 1800);
});

test('model references may cite only the actual selected poses or supplied measurement scalars', async () => {
  const input = fixture(900), {evidence, allowedAnalysisPaths} = buildMotionTemporalEvidence(input);
  const missingFrame = input.poseData.frames.findIndex((_frame, index) => !evidence.sourceFrameIndices.includes(index));
  const allowed = new Set(allowedAnalysisPaths.map(path => JSON.stringify(path)));
  const missingPath = input.fullAnalysis.measurements.flatMap((row, index) => Number.isFinite(row.left.elbowAngle) ? [['measurements', index, 'left', 'elbowAngle']] : []).find(path => !allowed.has(JSON.stringify(path)));
  assert(missingFrame >= 0 && missingPath);
  const outputs = [
    {verdict: {status: 'needs-improvement'}, feedback: [finding([missingFrame])]},
    {verdict: {status: 'needs-improvement'}, feedback: [{...finding([]), source: 'analysis', analysisPaths: [missingPath]}]},
  ];
  for (const output of outputs) await assert.rejects(completeMotionCoach({provider, input, fetchImpl: async () => response(output)}), error => error.status === 502);
  const sourcePath = allowedAnalysisPaths.at(-1);
  const coach = await completeMotionCoach({provider, input, fetchImpl: async () => response({verdict: {status: 'needs-improvement'},
    feedback: [{...finding([]), source: 'analysis', analysisPaths: [sourcePath]}]})});
  assert.deepEqual(coach.feedback[0].analysisPaths, [sourcePath]);
  assert.deepEqual(coach.feedback[0].evidenceTimes, [input.fullAnalysis.measurements[sourcePath[1]].time]);
});

test('efficient responses do not upgrade uncertain findings or silently retry malformed JSON', async () => {
  const input = fixture();
  const coach = await completeMotionCoach({provider, input, fetchImpl: async () => response({action: {status: 'unknown'}, verdict: {status: 'uncertain', summary: '关键动作阶段看不清。'}, feedback: []})});
  assert.equal(coach.verdict.status, 'uncertain');
  let calls = 0;
  await assert.rejects(completeMotionCoach({provider, input, fetchImpl: async () => {
    calls++;
    return Response.json({choices: [{message: {content: 'invalid JSON'}, finish_reason: 'stop'}]});
  }}), error => error.status === 502);
  assert.equal(calls, 1);
  assert.throws(() => validateMotionCoachRequest({...input, reviewMode: 'unknown'}), /模式无效/);
});

test('a named movement with explicit positive evidence can receive a standard verdict', async () => {
  const input = fixture(20);
  const coach = await completeMotionCoach({provider, input, fetchImpl: async () => response({
    action: {exerciseId: 'squat', name: '徒手深蹲', family: 'squat', status: 'identified', confidence: 'high',
      evidenceTimes: input.keyframes.map(frame => frame.time), evidence: '两帧显示站立屈髋屈膝下蹲，与深蹲的身体支撑一致。'},
    verdict: {status: 'standard'},
    feedback: [{title: '支撑稳定', status: 'good', source: 'visual', evidenceTimes: input.keyframes.map(frame => frame.time),
      evidence: '所示两个时刻双脚保持接地，身体支撑位置稳定。', correction: '', priority: 2}],
  })});
  assert.equal(coach.action.exerciseId, 'squat');
  assert.equal(coach.verdict.status, 'standard');
});

test('stable picture indices map actions and feedback to exact sent timestamps and survive saving', async () => {
  const input = fixture(20);
  input.keyframes[0].time = .5716666666666667;
  input.keyframes[1].time = .1234567890123456;
  const coach = await completeMotionCoach({provider, input, fetchImpl: async (_url, options) => {
    const context = JSON.parse(JSON.parse(options.body).messages[1].content[0].text);
    assert.deepEqual(context.frames.map(frame => frame.imageIndex), [0, 1]);
    assert.equal(context.frames[0].time, .1234567890123456);
    return response({action: {exerciseId: 'squat', status: 'identified', confidence: 'high', imageIndices: [0, 1],
      evidence: '两张图片可见同一训练者屈髋屈膝并起身。'}, verdict: {status: 'standard'},
      feedback: [{...finding([]), title: '支撑稳定', status: 'good', source: 'visual', imageIndices: [0, 1], evidenceTimes: [.123, .572],
        evidence: '两张实际截图中双脚与地面接触，支撑位置保持稳定。'}]});
  }});
  assert.equal(coach.action.status, 'identified');
  assert.deepEqual(coach.action.evidenceTimes, [.1234567890123456, .5716666666666667]);
  assert.deepEqual(coach.feedback[0].evidenceTimes, [.1234567890123456, .5716666666666667]);
  assert.equal(coach.verdict.status, 'standard');
  const saved = mergeCoachAssessment(input.analysis, coach);
  assert.deepEqual(saved.coach.action.evidenceTimes, coach.action.evidenceTimes);
  assert(!JSON.stringify(saved).includes('imageIndices'), 'Stored references are original times, independent of a transient image array');
});

test('efficient review preserves cancellation and rejects text-only providers before a call', async () => {
  const input = fixture(20), controller = new AbortController();
  let calls = 0;
  await assert.rejects(completeMotionCoach({provider: {...provider, models: [{id: provider.model, vision: false}]}, input,
    fetchImpl: async () => {calls++; return response({});}}), error => error.status === 400);
  assert.equal(calls, 0);
  controller.abort(new DOMException('user cancelled', 'AbortError'));
  await assert.rejects(completeMotionCoach({provider, input, signal: controller.signal,
    fetchImpl: async () => {calls++; return response({});}}), error => error.name === 'AbortError');
  assert.equal(calls, 0);
});
