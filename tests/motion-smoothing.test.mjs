import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSmoothedMotionFrames } from '../public/motion-smoothing.js';

const size = { width: 1080, height: 1920 };
function frame(time, { x = .5, y = .5, visibility = .9, status = 'locked', trackId = 'target-1' } = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({ x, y, z: .1, visibility }));
  return { time, landmarks, worldLandmarks: landmarks.map(p=>({...p,x:p.x-.5,y:p.y-.5,z:.2})),
    subjectTracking: { status, trackId, confidence: .9 }, personCount: 1 };
}
const rms = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freezeDeep); }
  return value;
}

test('display filtering reduces stationary 15 Hz landmark jitter', () => {
  const frames = Array.from({ length: 90 }, (_, index) => frame(index / 15, { x: .5 + (index % 2 ? -.003 : .003), y: .5 + Math.sin(index * 2.1) * .002 }));
  const output = buildSmoothedMotionFrames(frames, size);
  for (const axis of ['x', 'y']) {
    const raw = rms(frames.slice(10).map(item => item.landmarks[0][axis] - .5));
    const smoothed = rms(output.slice(10).map(item => item.landmarks[0][axis] - .5));
    assert.ok(smoothed < raw * .55, `${axis} jitter ${smoothed} must be less than 55% of ${raw}`);
  }
});

test('fast movement raises the cutoff and retains most displacement in its first frame', () => {
  const frames = Array.from({ length: 12 }, (_, index) => frame(index / 15, { x: index < 5 ? .2 : .4 }));
  const output = buildSmoothedMotionFrames(frames, size);
  assert.ok(output[5].landmarks[0].x > .37, 'first moving frame preserves over 85% of a fast displacement');
  assert.ok(Math.abs(output[6].landmarks[0].x - .4) < .006, 'second frame catches up without a long moving-average delay');
  assert.ok(output.every(item => item.landmarks[0].x >= .2 && item.landmarks[0].x <= .4), 'filter never overshoots');
});

test('lost and ambiguous tracking reset filters without filling absent landmarks', () => {
  for (const status of ['lost', 'ambiguous']) {
    const missing = { ...frame(2 / 15, { status }), landmarks: [], worldLandmarks: [] };
    const input = [frame(0), frame(1 / 15, { x: .51 }), missing, frame(3 / 15, { x: .8 })];
    const output = buildSmoothedMotionFrames(input, size);
    assert.deepEqual(output[2].landmarks, []);
    assert.deepEqual(output[2].landmarks, []);
    assert.equal(output[3].landmarks[0].x, .8, status);
  }
});

test('target changes, long gaps and non-increasing timestamps reset immediately', () => {
  for (const last of [frame(2 / 15, { x: .8, trackId: 'target-2' }), frame(.5, { x: .8 }), frame(1 / 15, { x: .8 }), frame(0, { x: .8 })]) {
    const output = buildSmoothedMotionFrames([frame(0), frame(1 / 15, { x: .51 }), last], size);
    assert.equal(output[2].landmarks[0].x, .8);
  }
});

test('individual invalid or missing points reset without altering confidence or valid neighbors', () => {
  for (const invalid of [null, { x: .5, y: .5, visibility: 0 }, { x: -1, y: .5, visibility: .9 }, { x: NaN, y: .5, visibility: .9 }]) {
    const frames = [frame(0), frame(1 / 15), frame(2 / 15, { x: .51 })];
    frames[1].landmarks[0] = invalid;
    const output = buildSmoothedMotionFrames(frames, size);
    assert.deepEqual(output[1].landmarks[0], invalid);
    assert.equal(output[2].landmarks[0].x, .51);
    assert.ok(output[2].landmarks[1].x < .51, 'a neighboring point retains its own continuous state');
    assert.equal(output[2].landmarks[0].visibility, .9);
  }
});

test('raw image and world AI data stay immutable while only display XY is smoothed', () => {
  const frames = [frame(0), frame(1 / 15, { x: .505 })];
  frames[1].sourceTime = 1 / 15; frames[1].rawMetadata = { detector: 'original' };
  const before = structuredClone(frames); freezeDeep(frames);
  const output = buildSmoothedMotionFrames(frames, size);
  assert.deepEqual(frames, before);
  assert.notEqual(output, frames); assert.notEqual(output[1], frames[1]);
  assert.notEqual(output[1].landmarks, frames[1].landmarks);
  assert.deepEqual(output[1].worldLandmarks, frames[1].worldLandmarks);
  assert.notEqual(output[1].landmarks[11].x, frames[1].landmarks[11].x);
  assert.equal(output[1].landmarks[11].visibility, .9);
  assert.equal(output[1].landmarks[11].z, .1);
  assert.equal(output[1].sourceTime, frames[1].sourceTime);
  assert.deepEqual(output[1].rawMetadata, frames[1].rawMetadata);
  assert.deepEqual(buildSmoothedMotionFrames(frames, size), output, 'offline results are repeatable and independent of playback seeking');
});

test('proportional video resolutions yield the same normalized display coordinates', () => {
  const frames = Array.from({ length: 40 }, (_, index) => frame(index / 15, { x: .3 + Math.sin(index / 4) * .1, y: .5 + Math.sin(index * 2) * .004 }));
  const large = buildSmoothedMotionFrames(frames, { width: 1080, height: 1920 });
  const small = buildSmoothedMotionFrames(frames, { width: 540, height: 960 });
  for (let i = 0; i < frames.length; i++) for (const axis of ['x', 'y']) assert.ok(Math.abs(large[i].landmarks[0][axis] - small[i].landmarks[0][axis]) < 1e-12);
});

test('equal pixel movements in portrait video have an equal filtering response', () => {
  const dx = 10 / size.width, dy = 10 / size.height;
  const horizontal = buildSmoothedMotionFrames([frame(0), frame(1 / 15, { x: .5 + dx })], size);
  const vertical = buildSmoothedMotionFrames([frame(0), frame(1 / 15, { y: .5 + dy })], size);
  const moveX = (horizontal[1].landmarks[0].x - .5) * size.width;
  const moveY = (vertical[1].landmarks[0].y - .5) * size.height;
  assert.ok(Math.abs(moveX - moveY) < 1e-10);
});

test('source frame timestamps govern motion velocity and invalid dimensions fail clearly', () => {
  const frames = [frame(0), frame(1 / 15, { x: .51 })];
  frames[0].sourceTime = 0; frames[1].sourceTime = .5;
  assert.equal(buildSmoothedMotionFrames(frames, size)[1].landmarks[0].x, .51, 'decoded frame gap resets');
  assert.throws(() => buildSmoothedMotionFrames(frames, { width: 0, height: 100 }), /尺寸/);
  assert.throws(() => buildSmoothedMotionFrames({}, size), /数组/);
  assert.deepEqual(buildSmoothedMotionFrames([], size), []);
});
