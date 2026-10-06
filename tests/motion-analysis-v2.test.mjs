import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeMotion} from '../public/motion-analysis.js';

const options = {width: 1000, height: 1000};
function frame(time = 0) {
  const landmarks = Array(33).fill(null);
  for (const side of [0, 1]) {
    [[11, 0.2, 0.1], [13, 0.2, 0.3], [15, 0.4, 0.3], [23, 0.2, 0.5], [25, 0.2, 0.7], [27, 0.4, 0.7]].forEach(([index, x, y]) => {
      landmarks[index + side] = {x: x + side * 0.1, y, visibility: 0.99};
    });
  }
  // Known synthetic XYZ geometry tests target continuity, not model accuracy.
  return {time, landmarks, worldLandmarks: landmarks.map(point => point && ({x: point.x - .5, y: point.y - .5, z: 0, visibility: point.visibility}))};
}
const trackedFrame = (time, change = {}) => ({...frame(time), personCount: 2, subjectTracking: {status: 'locked', confidence: 0.9, trackId: 'selected-person', ...change}});
const allNull = row => [...Object.values(row.left), ...Object.values(row.right)].every(value => value === null);
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function fixtureFrames(name) {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/motion-${name}-real.json`, import.meta.url)));
  const frames = fixture.frames.map(([time, points]) => {
    const landmarks = Array(33).fill(null);
    fixture.landmarkIndices.forEach((index, i) => {
      const [x, y, visibility] = points[i];
      landmarks[index] = {x, y, visibility};
    });
    return {time, landmarks};
  });
  return {frames, options: fixture.options};
}

test('multiple visible people require a selected target while locked target poses remain measurable', () => {
  const unknown = analyzeMotion([{...frame(), personCount: 2}], options);
  assert.ok(allNull(unknown.measurements[0]));
  assert.ok(unknown.quality.reasons.includes('UNRESOLVED_TARGET'));
  assert.equal(unknown.quality.validFrames, 0);
  const selected = analyzeMotion([trackedFrame(0), trackedFrame(0.1)], options);
  assert.equal(selected.quality.validFrames, 2);
  assert.equal(selected.quality.targetCoverage, 1);
  close(selected.measurements[0].left.elbowAngle, 90);
});

test('lost, ambiguous, low-confidence and untracked target frames retain their place with null measurements', () => {
  const samples = [
    trackedFrame(0),
    trackedFrame(0.1, {status: 'lost'}),
    trackedFrame(0.2, {status: 'ambiguous'}),
    trackedFrame(0.3, {confidence: 0.4}),
    frame(0.4),
    trackedFrame(0.5),
  ];
  const result = analyzeMotion(samples, options);
  assert.equal(result.measurements.length, 6);
  assert.equal(result.quality.validFrames, 2);
  assert.equal(result.quality.usableRatio, 2 / 6);
  assert.equal(result.quality.targetCoverage, 2 / 6);
  assert.deepEqual(result.quality.reasons, ['TARGET_NOT_LOCKED']);
  for (const index of [1, 2, 3, 4]) assert.ok(allNull(result.measurements[index]));
  for (const index of [0, 5]) close(result.measurements[index].right.kneeAngle, 90);
});

test('target identity changes cannot combine two people into one observation sequence', () => {
  const samples = [trackedFrame(0), trackedFrame(0.1, {trackId: 'another-person'})];
  const result = analyzeMotion(samples, options);
  assert.equal(result.measurements.length, 2);
  assert.ok(result.measurements.every(allNull));
  assert.equal(result.quality.targetCoverage, 0);
  assert.ok(result.quality.reasons.includes('TARGET_ID_CHANGED'));
});

test('malformed tracking confidence or identity cannot be treated as a lock', () => {
  for (const change of [{trackId: ''}, {trackId: ' '}, {trackId: null}, {confidence: NaN}, {confidence: Infinity}, {confidence: 1.1}, {confidence: undefined}]) {
    const result = analyzeMotion([trackedFrame(0, change)], options);
    assert.ok(allNull(result.measurements[0]));
    assert.equal(result.quality.targetCoverage, 0);
    assert.equal(result.quality.validFrames, 0);
  }
});

test('an explicitly absent person prevents stale landmarks from producing measurements', () => {
  for (const sample of [{...frame(), personCount: 0}, {...trackedFrame(0), personCount: 0}]) {
    const result = analyzeMotion([sample], options);
    assert.ok(allNull(result.measurements[0]));
    assert.ok(result.quality.reasons.includes('NO_VISIBLE_PERSON'));
  }
});

test('a missing tracking frame does not discard neighboring measurements or invent interpolated angles', () => {
  const samples = [trackedFrame(0), trackedFrame(0.1, {status: 'lost'}), trackedFrame(0.2)];
  const result = analyzeMotion(samples, options);
  assert.equal(result.quality.validFrames, 2);
  assert.deepEqual(result.measurements.map(row => row.time), [0, 0.1, 0.2]);
  assert.ok(allNull(result.measurements[1]));
  close(result.measurements[0].left.hipAngle, 180);
  close(result.measurements[2].left.hipAngle, 180);
});

for (const [name, count] of [['squat', 168], ['pushup', 267]]) {
  test(`historical ${name} image-only observations preserve timing without fabricating 3D angles`, () => {
    const fixture = fixtureFrames(name);
    assert(fixture.frames.every(sample => !Object.hasOwn(sample, 'worldLandmarks')));
    const result = analyzeMotion(fixture.frames, fixture.options);
    assert.equal(result.version, 'motion-observations-3d-v1');
    assert.equal(result.coordinateSpace, 'mediapipe-world-3d');
    assert.equal(result.measurements.length, count);
    assert.equal(result.quality.validFrames, 0);
    assert(result.quality.reasons.includes('MISSING_OR_UNCERTAIN_LANDMARKS'));
    assert(result.measurements.every(allNull));
    assert.deepEqual(result.measurements.map(row => row.time), fixture.frames.map(sample => sample.time));
  });
}

test('transforming historical image positions cannot restore unobserved depth', () => {
  for (const name of ['squat', 'pushup']) {
    const fixture = fixtureFrames(name);
    const reference = analyzeMotion(fixture.frames, fixture.options);
    const mirrored = analyzeMotion(fixture.frames.map(sample => ({...sample, landmarks: sample.landmarks.map(point => point && {...point, x: 1 - point.x})})), fixture.options);
    assert.deepEqual(mirrored.quality, reference.quality);
    mirrored.measurements.forEach((row, index) => {
      for (const side of ['left', 'right']) for (const [key, value] of Object.entries(row[side])) {
        const original = reference.measurements[index][side][key];
        if (original === null) assert.equal(value, null);
        else close(value, original, 1e-8);
      }
    });
  }
});
