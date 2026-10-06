import test from 'node:test';
import assert from 'node:assert/strict';
import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData, buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {mergeCoachAssessment} from '../public/motion-contract.js';
import {validateMotionCoachRequest, completeMotionCoach} from '../server/motion-coach.mjs';
import {buildMotionVisualContext, buildMotionVisualFollowup, completeVisualMotionCoach} from '../server/motion-coach-visual.mjs';
import {readMotionCoachResponse} from '../server/motion-coach-full.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const provider = {name: 'Mock visual coach', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'vision', models: [{id: 'vision', vision: true}]};
const crop = {xMin: 0, yMin: 0, xMax: 1, yMax: 1};
function fixture(count = 150) {
  const pipeline = toMediaPipePipeline({duration: count / 15, width: 1280, height: 720, sampleFps: 15, sourceFps: 30,
    frames: Array.from({length: count}, (_, index) => ({time: index / 15, personCount: 1,
      landmarks: Array.from({length: 33}, (_, joint) => ({x: .2 + joint / 100 + index / (count * 10), y: .2 + joint / 100, visibility: .97}))}))});
  return validateMotionCoachRequest({reviewMode: 'efficient', duration: pipeline.duration, poseData: buildMotionPoseData(pipeline),
    fullAnalysis: buildFullMotionAnalysis(analyzeMotion(pipeline.frames, pipeline), pipeline),
    analysis: {evidenceFrames: [.2, .8].map(time => ({time, crop, subjectTracking: {status: 'locked', trackId: 'one', confidence: .99, bbox: {xMin: .2, yMin: .1, xMax: .8, yMax: .9}}}))},
    keyframes: [.8, .2].map(time => ({time, mimeType: 'image/png', data: png}))});
}
const good = {title: '可见动作支撑', status: 'good', source: 'visual', imageIndices: [0, 1], evidence: '两张图片中手部固定支撑横杆，身体向上移动。', correction: '继续保持可控的动作幅度。', priority: 1};
const output = extra => ({action: {name: '引体向上', status: 'identified', confidence: 'high', imageIndices: [0, 1], evidence: '同一训练者在横杆下悬垂并拉起身体。'},
  verdict: {status: 'standard'}, feedback: [good], ...extra});
const respond = value => Response.json({choices: [{message: {content: JSON.stringify(value)}, finish_reason: 'stop'}]});

test('efficient defaults to one small visual request without numeric motion observations', async () => {
  const input = fixture(900), calls = [];
  const result = await completeMotionCoach({provider, input, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), context = JSON.parse(body.messages[1].content[0].text);
    calls.push({body, context}); return respond(output());
  }});
  assert.equal(calls.length, 1);
  const {context, body} = calls[0];
  assert.equal(context.stage, 'visual-keyframes');
  assert(JSON.stringify(context).length < 4000);
  assert(!/measurements|elbowAngle|landmarks|wholebody|statistics/.test(JSON.stringify(context)));
  assert.equal(body.messages[1].content.filter(item => item.type === 'image_url').length, 2);
  assert.deepEqual(context.frames.map(frame => frame.imageIndex), [0, 1]);
  assert.deepEqual(context.frames.map(frame => frame.time), [.2, .8]);
  assert.deepEqual(context.frames[0].targetBox, input.analysis.evidenceFrames[0].subjectTracking.bbox);
  assert.equal(result.action.exerciseId, 'bodyweight-pullup');
  assert.equal(result.verdict.status, 'standard');
  assert(!result.verdict.summary.includes('骨架'));
  assert.equal(result.coverage.strategy, 'visual-keyframes');
  assert.equal(result.coverage.sourceFrameCount, 900);
  assert.equal(result.coverage.reviewedFrameCount, 0);
  assert.equal(result.coverage.reviewedImageCount, 2);
  assert.equal(result.coverage.summarizedMeasurementCount, 0);
  const saved = mergeCoachAssessment(input.analysis, result);
  assert.equal(saved.coach.coverage.strategy, 'visual-keyframes');
  assert.equal(saved.coach.coverage.reviewedImageCount, 2);
  assert.equal(saved.coach.verdict.status, 'standard');
});

test('visual identity follows the exact name and ignores a conflicting model ID or family', async () => {
  const input = fixture(20), source = output();
  source.action.exerciseId = 'pullup'; source.action.family = 'squat';
  const result = await completeMotionCoach({provider, input, fetchImpl: async () => respond(source)});
  assert.equal(result.action.exerciseId, 'bodyweight-pullup');
  assert.equal(result.action.family, 'vertical-pull');
  assert.equal(result.action.status, 'identified');
});

test('clear positive visual evidence is independent of unusable local pose measurements', async () => {
  const input = fixture(20);
  Object.assign(input.fullAnalysis.quality, {validFrames: 0, usableRatio: 0, targetCoverage: 0, reasons: ['NO_POSE']});
  const result = await completeMotionCoach({provider, input, fetchImpl: async () => respond(output())});
  assert.equal(result.verdict.status, 'standard');
  assert.equal(mergeCoachAssessment({quality: input.fullAnalysis.quality}, result).coach.verdict.status, 'standard');
});

test('visual-only review rejects nonexistent picture indices and invented pose-only problems', async () => {
  const input = fixture(20);
  for (const bad of [{...good, status: 'improve', imageIndices: [99]}, {...good, status: 'improve', source: 'pose', frameIndices: [0]}]) {
    await assert.rejects(completeMotionCoach({provider, input, fetchImpl: async () => respond(output({verdict: {status: 'needs-improvement'}, feedback: [bad]}))}), error => error.status === 502);
  }
});

test('only a missing final limitations array delimiter is repaired without changing assessment text', () => {
  const original = output({limitations: ['静态截图中的文字含括号 } 和转义引号 "，不影响结构判断。']});
  const complete = JSON.stringify(original), malformed = complete.slice(0, -2) + '}';
  assert.deepEqual(readMotionCoachResponse({content: malformed, finishReason: 'stop'}), original);
  for (const content of [malformed.slice(0, -4), complete.slice(0, -1), '{"verdict":{"status":"standard"},"feedback":[}',
    '{"verdict":{"status":"standard"},"feedback":[],"limitations":["unfinished}', complete.replace('"standard"', 'standard')]) {
    assert.throws(() => readMotionCoachResponse({content, finishReason: 'stop'}), error => error.status === 502);
  }
  assert.throws(() => readMotionCoachResponse({content: malformed, finishReason: 'length'}), error => error.status === 502 && /截断/.test(error.message));
});

test('dynamic checks are opt-in, bounded and keep crop changes or unavailable points out', async () => {
  const input = fixture(), context = buildMotionVisualContext(input);
  const request = {question: '肩髋是否保持相同方向运动', imageIndices: [0, 1], landmarkNames: ['left_shoulder', 'left_hip'], cameraStable: true};
  const checked = buildMotionVisualFollowup(input, context, request);
  assert(checked && checked.frames.length <= 12);
  assert(checked.frames.every(frame => frame.landmarks.length === 2 && frame.time >= .2 && frame.time <= .8));
  for (const change of [value => value.cameraStable = false, value => value.imageIndices = [0, 99], value => value.landmarkNames = ['face_1', 'left_hip']]) {
    const invalid = structuredClone(request); change(invalid); assert.equal(buildMotionVisualFollowup(input, context, invalid), null);
  }
  const cropped = structuredClone(context); cropped.frames[1].crop.xMin = .1;
  assert.equal(buildMotionVisualFollowup(input, cropped, request), null);
  const missing = structuredClone(input); missing.poseData.frames.forEach(frame => {frame.landmarks[11] = [-.001, .3, .99];});
  assert.equal(buildMotionVisualFollowup(missing, context, request), null);
  const initial = output({verdict: {status: 'uncertain'}, feedback: [{...good, status: 'uncertain'}], temporalCheck: request});
  let calls = 0;
  const result = await completeMotionCoach({provider, input, fetchImpl: async () => {calls++; return respond(initial);}});
  assert.equal(calls, 1); assert.equal(result.verdict.status, 'uncertain');
  assert.equal(result.coverage.temporalChecks, 0);
});

test('explicit dynamic verification has at most one follow-up and only supplied global pose references', async () => {
  const input = fixture(), calls = [];
  const result = await completeVisualMotionCoach({provider, input, allowTemporalCheck: true, fetchImpl: async (_url, options) => {
    const context = JSON.parse(JSON.parse(options.body).messages[1].content[0].text); calls.push(context);
    if (calls.length === 1) return respond(output({verdict: {status: 'uncertain'}, feedback: [{...good, status: 'uncertain'}],
      temporalCheck: {question: '肩髋是否保持相同方向运动', imageIndices: [0, 1], landmarkNames: ['left_shoulder', 'left_hip'], cameraStable: true}}));
    assert.equal(context.stage, 'visual-motion-check');
    return respond(output({feedback: [{...good, source: 'combined', frameIndices: context.motionEvidence.sourceFrameIndices.slice(0, 2)}],
      temporalCheck: {question: '不得再次请求复核', imageIndices: [0, 1]}}));
  }});
  assert.equal(calls.length, 2);
  assert.equal(result.coverage.temporalChecks, 1);
  assert.equal(result.coverage.reviewedFrameCount, calls[1].motionEvidence.frames.length);
  assert.equal(result.coverage.reviewedMeasurementCount, 0);
  assert.equal(result.verdict.status, 'standard');
});
