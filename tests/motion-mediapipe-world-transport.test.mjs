import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMotionPoseData, validateMotionPoseData, validateFullMotionAnalysis, MOTION_BODY_LANDMARK_INDICES} from '../public/motion-pose-data.js';
import {validateMotionCoachRequest, completeMotionCoach} from '../server/motion-coach.mjs';
import {buildMotionTemporalEvidence} from '../server/motion-coach-temporal.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const fields = ['elbowAngle', 'shoulderAngle', 'hipAngle', 'kneeAngle', 'bodyAlignmentAngle', 'torsoLean'];
const provider = {id: 'world-fixture', name: 'World fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture', model: 'vision', models: [{id: 'vision', vision: true}]};
function pipeline(count = 3) {
  return {modelVersion: 'MediaPipe Pose Landmarker Full v1 / world3d-v1', duration: count / 15, width: 640, height: 480, sampleFps: 15,
    frames: Array.from({length: count}, (_, frameIndex) => ({time: frameIndex / 15, personCount: 1,
      landmarks: Array.from({length: 33}, (_, index) => ({x: .15 + index / 70, y: .2 + index / 90, visibility: .980123})),
      worldLandmarks: Array.from({length: 33}, (_, index) => ({x: -.7 + index / 20 + Math.sin(frameIndex / 5) / 10,
        y: -1.3 + index / 25, z: -2.2 + Math.cos(frameIndex / 6 + index) / 3, visibility: .980123})),
    }))};
}
function analysis(source) {
  return {version: 'motion-observations-3d-v1', coordinateSpace: 'mediapipe-world-3d',
    quality: {totalFrames: source.frames.length, validFrames: source.frames.length, usableRatio: 1, sourceFps: 30, targetCoverage: null, reasons: []},
    measurements: source.frames.map((frame, frameIndex) => ({frameIndex, time: frame.time,
      left: Object.fromEntries(fields.map((key, i) => [key, 60 + 25 * Math.sin(frameIndex / 6 + i)])),
      right: Object.fromEntries(fields.map((key, i) => [key, 65 + 20 * Math.cos(frameIndex / 6 + i)])),
    }))};
}
function request(source = pipeline()) {
  return {reviewMode: 'temporal', duration: source.duration, poseData: buildMotionPoseData(source), fullAnalysis: analysis(source),
    keyframes: [{time: source.duration / 2, mimeType: 'image/png', data: png}]};
}

test('MediaPipe world transport preserves signed metric coordinates and independent image locations without inventing nodes', () => {
  const source = pipeline(), before = JSON.stringify(source), data = buildMotionPoseData(source);
  assert.equal(data.schemaVersion, 6);
  assert.equal(data.format, 'mediapipe-world17-full');
  assert.deepEqual(data.worldPointFields, ['x', 'y', 'z', 'visibility']);
  assert.deepEqual(data.pointFields, ['x', 'y', 'visibility']);
  assert.match(data.coordinates.world, /meters.*midpoint of the hips/);
  assert.match(data.coordinates.world, /not a global movement trajectory/);
  for (const [frameIndex, frame] of data.frames.entries()) for (let index = 0; index < 33; index++) {
    if (MOTION_BODY_LANDMARK_INDICES.includes(index)) {
      assert.deepEqual(frame.worldLandmarks[index], ['x', 'y', 'z', 'visibility'].map(key => source.frames[frameIndex].worldLandmarks[index][key]));
      assert.deepEqual(frame.landmarks[index], ['x', 'y', 'visibility'].map(key => source.frames[frameIndex].landmarks[index][key]));
    } else assert.equal(frame.worldLandmarks[index], null);
  }
  assert.equal(data.frames[0].worldLandmarks[0][0], -.7);
  assert(data.frames[0].worldLandmarks[0][2] < -1);
  assert.strictEqual(validateMotionPoseData(data), data);
  assert.deepEqual(validateMotionPoseData(JSON.parse(JSON.stringify(data))), data);
  data.frames[0].worldLandmarks[0][2] = 99;
  assert.equal(JSON.stringify(source), before);
});

test('world transport keeps zero depth, absent fields, explicit unknowns and unavailable observations distinct', () => {
  const source = pipeline();
  source.frames[0].worldLandmarks[11] = {x: 0, y: null, z: 0, visibility: 0};
  source.frames[0].worldLandmarks[12] = {x: -.2, z: -.8};
  source.frames[0].worldLandmarks[13] = null;
  source.frames[1].worldLandmarks = [];
  delete source.frames[2].worldLandmarks;
  const data = buildMotionPoseData(source);
  assert.deepEqual(data.frames[0].worldLandmarks[11], [0, null, 0, 0]);
  assert.deepEqual(data.frames[0].worldLandmarks[12], [-.2, null, -.8, null, 10]);
  assert.equal(data.frames[0].worldLandmarks[13], null);
  assert.deepEqual(data.frames[1].worldLandmarks, []);
  assert.deepEqual(data.frames[2].worldLandmarks, []);
  assert.equal(data.schemaVersion, 6);
});

test('all three tiers require the same world schema and cannot silently downgrade', () => {
  for (const tier of ['Lite', 'Full', 'Heavy']) {
    const source = pipeline(); source.modelVersion = source.modelVersion.replace('Full', tier);
    const data = buildMotionPoseData(source);
    assert.equal(data.schemaVersion, 6);
    assert.equal(data.format, 'mediapipe-world17-full');
    assert.equal(data.retainedLandmarkIndices.length, 17);
    assert.strictEqual(validateMotionPoseData(data), data);
    const input = validateMotionCoachRequest(request(source));
    const {evidence} = buildMotionTemporalEvidence(input);
    assert.equal(evidence.poseSchema.measurementCoordinateSpace, 'mediapipe-world-3d');
    assert(evidence.frames.every(frame => frame.worldLandmarks.length === 17));
    assert.deepEqual(evidence.poseSchema.landmarkIndices, MOTION_BODY_LANDMARK_INDICES);
    source.frames.forEach(frame => delete frame.worldLandmarks);
    const missing = buildMotionPoseData(source);
    assert(missing.frames.every(frame => frame.worldLandmarks.length === 0));
    source.modelVersion = source.modelVersion.replace(' / world3d-v1', '');
    assert.throws(() => buildMotionPoseData(source), /三维模型/);
    for (const version of [2, 3, 4, 5]) {
      const obsolete = structuredClone(data); obsolete.schemaVersion = version;
      assert.throws(() => validateMotionPoseData(obsolete), /三维骨架协议/);
    }
  }
});

test('world schema rejects invalid confidence, malformed tuples, hidden fields and mismatched point definitions', () => {
  const data = buildMotionPoseData(pipeline());
  for (const mutate of [
    d => d.frames[0].worldLandmarks[11].splice(2, 1),
    d => { d.frames[0].worldLandmarks[11][2] = Infinity; },
    d => { d.frames[0].worldLandmarks[11][3] = 1.01; },
    d => { d.frames[0].worldLandmarks[11] = [1, 2, 3, .8, 4]; },
    d => { d.frames[0].worldLandmarks[1] = [1, 2, 3, .8]; },
    d => { delete d.frames[0].worldLandmarks; },
    d => { d.frames[0].landmarks = []; },
    d => { d.worldPointFields = ['x', 'y', 'visibility', 'z']; },
  ]) { const invalid = structuredClone(data); mutate(invalid); assert.throws(() => validateMotionPoseData(invalid)); }
  const wrongModel = pipeline(); wrongModel.modelVersion = 'unsupported skeleton fixture';
  assert.throws(() => buildMotionPoseData(wrongModel), /三维模型/);
});

test('request validation rejects mixing 2D observations with 3D coordinates in either direction', () => {
  const body = request();
  assert.equal(validateMotionCoachRequest(body).fullAnalysis.coordinateSpace, 'mediapipe-world-3d');
  const planarAnalysis = structuredClone(body);
  planarAnalysis.fullAnalysis.version = 'motion-observations-v1';
  delete planarAnalysis.fullAnalysis.coordinateSpace;
  assert.throws(() => validateMotionCoachRequest(planarAnalysis), /仅支持三维观测协议/);
  const invalidPose = structuredClone(body.poseData); invalidPose.schemaVersion = 4;
  assert.throws(() => validateMotionCoachRequest({...body, poseData: invalidPose}), /三维骨架协议/);
  const invalid = structuredClone(body.fullAnalysis); invalid.coordinateSpace = 'image-2d';
  assert.throws(() => validateFullMotionAnalysis(invalid), /三维观测必须声明/);
});

test('AI evidence sends actual 3D tuples with metric semantics and conservative confidence precision', () => {
  const source = pipeline();
  source.frames[0].worldLandmarks[11] = {x: -1.234567, y: 1.456789, z: -.9876543, visibility: .5499999};
  source.frames[1].worldLandmarks[11] = {x: -.2, y: .8, visibility: .9};
  source.frames[2].worldLandmarks = [];
  const input = validateMotionCoachRequest(request(source)), before = JSON.stringify(input);
  const {evidence} = buildMotionTemporalEvidence(input, {maxChars: 24000, compactNumbers: true, minFrames: 12});
  const slot = evidence.poseSchema.landmarkIndices.indexOf(11);
  assert.deepEqual(evidence.frames[0].worldLandmarks[slot], [-1.23457, 1.45679, -.98765, .549]);
  assert.equal(evidence.frames[1].worldLandmarks[slot][2], null);
  assert.deepEqual(evidence.frames[2].worldLandmarks, []);
  assert.deepEqual(evidence.poseSchema.worldPointFields, ['x', 'y', 'z', 'visibility']);
  assert.equal(evidence.poseSchema.worldCoordinateUnits, 'meters');
  assert.equal(evidence.poseSchema.worldCoordinateOrigin, 'hip-midpoint');
  assert.equal(evidence.poseSchema.measurementCoordinateSpace, 'mediapipe-world-3d');
  assert.equal(evidence.poseSchema.torsoLeanReference, 'model-camera-y-axis-not-measured-gravity');
  assert.equal(JSON.stringify(input), before);
});

test('long and short 3D clips fit the guided evidence budget while retaining full timeline coverage', () => {
  for (const count of [29, 1800]) {
    const input = validateMotionCoachRequest(request(pipeline(count)));
    const {evidence} = buildMotionTemporalEvidence(input, {maxChars: 24000, compactNumbers: true, minFrames: 12});
    assert(JSON.stringify(evidence).length <= 24000);
    assert(evidence.frames.length >= 12 && evidence.frames.length <= 64);
    assert.equal(evidence.sourceFrameIndices[0], 0);
    assert.equal(evidence.sourceFrameIndices.at(-1), count - 1);
    assert.equal(evidence.windows.reduce((sum, window) => sum + window.sourceFrameCount, 0), count);
    assert(evidence.frames.every(frame => frame.worldLandmarks.length === 17));
  }
});

test('temporal provider request includes 3D data and dimension-aware instructions', async () => {
  const input = validateMotionCoachRequest(request());
  let captured;
  await completeMotionCoach({provider, input, fetchImpl: async (_url, options) => {
    captured = JSON.parse(options.body);
    return Response.json({choices: [{message: {content: JSON.stringify({action: {status: 'unknown'}, verdict: {status: 'uncertain'}, feedback: []})}, finish_reason: 'stop'}]});
  }});
  const evidence = JSON.parse(captured.messages[1].content[0].text).evidence;
  assert(evidence.frames[0].worldLandmarks.some(point => point?.[2] < 0));
  assert.match(captured.messages[0].content, /世界坐标计算三维夹角/);
  assert.match(captured.messages[0].content, /不是重力垂线夹角/);
});
