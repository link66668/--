import test from 'node:test';
import assert from 'node:assert/strict';
import analyzeMotion, {analyzeMotion as namedAnalyzeMotion, MOTION_OBSERVATION_VERSION} from '../public/motion-analysis.js';

const angleNames = ['elbowAngle', 'shoulderAngle', 'hipAngle', 'kneeAngle', 'bodyAlignmentAngle', 'torsoLean'];
const joints = [[200, 100], [200, 250], [350, 250], [200, 400], [200, 600], [400, 600]];
const indices = [11, 13, 15, 23, 25, 27];
function pose({width = 1000, height = 1000, scale = 1, mirror = false} = {}) {
  const landmarks = Array(33).fill(null);
  for (const side of [0, 1]) {
    joints.forEach(([px, py], n) => {
      const x = (px + side * 250) * scale + 25, y = py * scale + 25;
      landmarks[indices[n] + side] = {x: (mirror ? width - x : x) / width, y: y / height, visibility: 0.99};
    });
  }
  return {time: 0, landmarks, worldLandmarks: landmarks.map(point => point && ({x: point.x * width / 1000, y: point.y * height / 1000, z: 0, visibility: point.visibility}))};
}
const options = {width: 1000, height: 1000};
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const values = row => [...Object.values(row.left), ...Object.values(row.right)];
function assertOnlyObservations(report) {
  assert.deepEqual(Object.keys(report).sort(), ['coordinateSpace', 'measurements', 'quality', 'version']);
  assert.deepEqual(Object.keys(report.quality).sort(), ['reasons', 'sourceFps', 'targetCoverage', 'totalFrames', 'usableRatio', 'validFrames']);
  for (const row of report.measurements) {
    assert.deepEqual(Object.keys(row).sort(), ['frameIndex', 'left', 'right', 'time']);
    assert.deepEqual(Object.keys(row.left), angleNames);
    assert.deepEqual(Object.keys(row.right), angleNames);
  }
}

test('the analysis contract contains measurements and data quality without local exercise or form judgments', () => {
  assert.equal(analyzeMotion, namedAnalyzeMotion);
  const report = analyzeMotion([pose()], options);
  assert.equal(report.version, MOTION_OBSERVATION_VERSION);
  assert.equal(report.version, 'motion-observations-3d-v1');
  assertOnlyObservations(report);
  assert.equal(report.quality.totalFrames, 1);
  assert.equal(report.quality.validFrames, 1);
  assert.equal(report.quality.usableRatio, 1);
  assert.equal(report.quality.targetCoverage, null);
  assert.deepEqual(report.quality.reasons, []);
});

test('joint definitions give known angles in degrees for both independently measured sides', () => {
  const row = analyzeMotion([pose()], options).measurements[0];
  for (const side of [row.left, row.right]) {
    close(side.elbowAngle, 90);
    close(side.shoulderAngle, 0);
    close(side.hipAngle, 180);
    close(side.kneeAngle, 90);
    close(side.bodyAlignmentAngle, 135);
    close(side.torsoLean, 0);
  }
});

test('mirror, uniform scale and portrait or landscape dimensions preserve physical geometry', () => {
  const reference = analyzeMotion([pose()], options).measurements[0];
  for (const transform of [
    {width: 1600, height: 900, scale: 1},
    {width: 900, height: 1600, scale: 1},
    {width: 1000, height: 1000, scale: 0.35, mirror: true},
    {width: 1600, height: 900, scale: 0.75, mirror: true},
  ]) {
    const actual = analyzeMotion([pose(transform)], transform).measurements[0];
    values(actual).forEach((value, index) => close(value, values(reference)[index]));
  }
});

test('torso lean is an unsigned 3D angle to model Y and does not assert spinal posture', () => {
  for (const [shoulder, hip, expected] of [
    [[200, 100], [200, 400], 0],
    [[200, 200], [400, 400], 45],
    [[400, 200], [200, 400], 45],
    [[200, 400], [400, 400], 90],
    [[200, 400], [200, 100], 0],
  ]) {
    const frame = pose();
    [shoulder, hip].forEach(([x, y], index) => {frame.landmarks[index ? 23 : 11] = {x: x / 1000, y: y / 1000, visibility: 1}; frame.worldLandmarks[index ? 23 : 11] = {x: x / 1000, y: y / 1000, z: 0, visibility: 1};});
    close(analyzeMotion([frame], options).measurements[0].left.torsoLean, expected);
  }
});

test('occluded joints null only the measurements that require them and retain the other side', () => {
  const frame = pose();
  frame.landmarks[15].visibility = 0.2;
  const result = analyzeMotion([frame], options);
  assert.equal(result.measurements[0].left.elbowAngle, null);
  close(result.measurements[0].left.kneeAngle, 90);
  close(result.measurements[0].right.elbowAngle, 90);
  assert.equal(result.quality.validFrames, 1);
  assert.deepEqual(result.quality.reasons, ['MISSING_OR_UNCERTAIN_LANDMARKS']);
  frame.landmarks[23] = null;
  const cropped = analyzeMotion([frame], options).measurements[0];
  for (const name of ['shoulderAngle', 'hipAngle', 'kneeAngle', 'bodyAlignmentAngle', 'torsoLean']) assert.equal(cropped.left[name], null);
  close(cropped.right.hipAngle, 180);
});

test('MediaPipe image visibility must be present and reliable to produce angles', () => {
  close(analyzeMotion([pose()], options).measurements[0].left.elbowAngle, 90);
  for (const invalid of [{visibility: undefined}, {visibility: NaN}, {visibility: 0.4}, {visibility: 1.2}]) {
    const frame = pose();
    frame.landmarks.forEach(point => {if (point) Object.assign(point, invalid);});
    const report = analyzeMotion([frame], options);
    assert.ok(values(report.measurements[0]).every(value => value === null));
    assert.equal(report.quality.validFrames, 0);
  }
});

test('out-of-frame or invalid coordinates and degenerate segments stay null rather than becoming fabricated angles', () => {
  for (const coordinates of [{x: -0.1}, {x: 1.1}, {y: NaN}, {x: Infinity}]) {
    const frame = pose();
    Object.assign(frame.landmarks[13], coordinates);
    assert.equal(analyzeMotion([frame], options).measurements[0].left.elbowAngle, null);
  }
  const frame = pose();
  frame.landmarks[13] = {...frame.landmarks[11]};
  frame.landmarks[23] = {...frame.landmarks[11]};
  frame.worldLandmarks[13] = {...frame.worldLandmarks[11]};
  frame.worldLandmarks[23] = {...frame.worldLandmarks[11]};
  const row = analyzeMotion([frame], options).measurements[0];
  assert.equal(row.left.elbowAngle, null);
  assert.equal(row.left.shoulderAngle, null);
  assert.equal(row.left.torsoLean, null);
  assert.ok(values(row).every(value => value === null || Number.isFinite(value)));
});

test('missing lower body does not erase visible elbow angles or invent leg measurements', () => {
  const frame = pose();
  for (const index of [23, 24, 25, 26, 27, 28]) frame.landmarks[index] = null;
  const report = analyzeMotion([frame], options);
  for (const side of ['left', 'right']) {
    close(report.measurements[0][side].elbowAngle, 90);
    for (const name of angleNames.filter(name => name !== 'elbowAngle')) assert.equal(report.measurements[0][side][name], null);
  }
  assert.equal(report.quality.validFrames, 1);
});

test('every sampled frame remains aligned through pauses, missing poses and sequences beyond the former analysis caps', () => {
  const frame = pose();
  const frames = Array.from({length: 2005}, (_, index) => ({...frame, time: index / 15, landmarks: index % 5 === 0 ? [] : frame.landmarks}));
  const report = analyzeMotion(frames, {...options, duration: 2005 / 15});
  assert.equal(report.measurements.length, frames.length);
  assert.equal(report.quality.totalFrames, frames.length);
  assert.equal(report.quality.validFrames, 1604);
  assert.equal(report.quality.usableRatio, 1604 / 2005);
  report.measurements.forEach((row, index) => {
    assert.equal(row.frameIndex, index);
    assert.equal(row.time, frames[index].time);
    if (index % 5 === 0) assert.ok(values(row).every(value => value === null));
    else close(row.left.elbowAngle, 90);
  });
});

test('invalid or duplicate timestamps are reported without dropping, sorting or merging original frame indices', () => {
  const frames = [2, 2, 1, NaN, -1, 3].map(time => ({...pose(), time}));
  const report = analyzeMotion(frames, options);
  assert.deepEqual(report.measurements.map(row => row.frameIndex), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(report.measurements.map(row => row.time), [2, 2, 1, null, null, 3]);
  assert.ok(report.quality.reasons.includes('NON_MONOTONIC_FRAME_TIMES'));
  assert.ok(report.quality.reasons.includes('INVALID_FRAME_TIME'));
  for (const index of [3, 4]) assert.ok(values(report.measurements[index]).every(value => value === null));
});

test('invalid dimensions and absent input return stable empty or null-valued observations', () => {
  assertOnlyObservations(analyzeMotion(null, options));
  assert.equal(analyzeMotion(undefined, options).measurements.length, 0);
  assert.deepEqual(analyzeMotion([], options).quality.reasons, ['NO_FRAMES']);
  for (const dimensions of [{width: NaN, height: 1000}, {width: 0, height: 1000}, {width: 1000, height: -1}, {}]) {
    const report = analyzeMotion([pose()], dimensions);
    assert.equal(report.measurements.length, 1);
    assert.ok(report.quality.reasons.includes('INVALID_DIMENSIONS'));
    assert.ok(values(report.measurements[0]).every(value => value === null));
  }
});

test('source frame rate remains factual metadata and exercise hints cannot change the observation builder', () => {
  const frame = pose();
  const reference = analyzeMotion([frame], options);
  assert.deepEqual(analyzeMotion([frame], {...options, exerciseHint: 'squat'}), reference);
  assert.deepEqual(analyzeMotion([frame], {...options, exerciseHint: {exerciseId: 'pushup', family: 'row'}}), reference);
  for (const sourceFps of [3, 15, 29.97]) {
    const result = analyzeMotion([frame], {...options, sourceFps});
    assert.equal(result.quality.sourceFps, sourceFps);
    assert.deepEqual(result.measurements, reference.measurements);
  }
  for (const sourceFps of [0, -1, NaN, Infinity, undefined, null]) assert.equal(analyzeMotion([frame], {...options, sourceFps}).quality.sourceFps, null);
});

test('normalized image depth cannot override 2D measurements and input poses remain unmodified', () => {
  const frame = pose();
  const original = analyzeMotion([frame], options);
  frame.landmarks.forEach(point => {if (point) {point.z = -999; Object.freeze(point);}});
  Object.freeze(frame.landmarks);
  Object.freeze(frame);
  assert.deepEqual(analyzeMotion(Object.freeze([frame]), options), original);
});
