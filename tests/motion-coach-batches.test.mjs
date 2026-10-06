import test from 'node:test';
import assert from 'node:assert/strict';
import { planMotionCoachBatches, decodeMotionCoachBlock, MOTION_COACH_POSE_ENCODING } from '../server/motion-coach-batches.mjs';

function restore(packets) {
  const result = {};
  for (const { blocks } of packets) for (const { path, value } of blocks) {
    let container = result;
    for (let index = 0; index < path.length - 1; index++) {
      const key = path[index];
      if (!Object.hasOwn(container, key)) container[key] = typeof path[index + 1] === 'number' ? [] : {};
      container = container[key];
    }
    assert.equal(Object.hasOwn(container, path.at(-1)), false, `Duplicate data path: ${JSON.stringify(path)}`);
    container[path.at(-1)] = value;
  }
  return result;
}

function frame(index) {
  return { time: index / 15, worldLandmarks: Array.from({ length: 33 }, (_, joint) => [joint / 33, index / 1800, -joint / 100, 0.98765432123456]), landmarks: [], target: { status: index % 19 ? 'locked' : 'lost', confidence: index % 19 ? 0.9 : 0 } };
}

test('all 1800 observations and measurements reach bounded packets without sampling or rounding', () => {
  const input = {
    poseData: { version: 'full-test', sampleFps: 15, duration: 120, worldPointFields: ['x', 'y', 'z', 'visibility'], frames: Array.from({ length: 1800 }, (_, index) => frame(index)) },
    fullAnalysis: { quality: { reasons: ['MISSING_OR_UNCERTAIN_LANDMARKS'], usableRatio: 0.812345678901234 }, measurements: Array.from({ length: 1800 }, (_, frameIndex) => ({frameIndex, time: frameIndex / 15, left: {elbowAngle: 72.9876543212345 + frameIndex / 111, kneeAngle: null}, right: {elbowAngle: frameIndex / 31}})) },
    analysis: { measurements: [{ index: 'intentionally-small-summary' }] }, keyframes: [{ data: 'not-part-of-packets' }],
  };
  const before = JSON.stringify(input);
  const packets = planMotionCoachBatches(input);
  assert(packets.length > 1);
  assert.deepEqual(restore(packets), { poseData: input.poseData, fullAnalysis: input.fullAnalysis });
  assert.equal(JSON.stringify(input), before, 'Planning never changes local observations');
  assert.deepEqual(packets.flatMap(packet => packet.frameIndices), Array.from({ length: 1800 }, (_, index) => index));
  assert.deepEqual(packets.flatMap(packet => packet.measurementIndices), Array.from({ length: 1800 }, (_, index) => index));
  assert(packets.every((packet, index) => packet.index === index && packet.total === packets.length && JSON.stringify(packet).length <= 64000));
  assert.equal(packets.flatMap(packet => packet.blocks).find(block => block.path.join('.') === 'poseData.frames.1799').value.time, 1799 / 15);
  assert(!JSON.stringify(packets).includes('intentionally-small-summary'));
  assert(!JSON.stringify(packets).includes('not-part-of-packets'));
});

test('oversized single frames, measurements and nested global arrays are recursively split and reconstructed exactly', () => {
  const input = { poseData: { frames: [frame(0), frame(1)] }, fullAnalysis: { measurements: [{ index: 1, metrics: { nested: Array.from({ length: 100 }, (_, index) => ({ index, samples: Array.from({ length: 20 }, (_, sample) => index + sample / 29) })) } }], global: { rows: Array.from({ length: 100 }, (_, index) => ({ index, details: '完整保留'.repeat(50) })) } } };
  const packets = planMotionCoachBatches(input, { maxChars: 1024 });
  assert(packets.length > 10);
  assert(packets.every(packet => JSON.stringify(packet).length <= 1024));
  assert.deepEqual(restore(packets), input);
  assert(packets.flatMap(packet => packet.blocks).some(block => block.path.length > 4));
  assert(packets.filter(packet => packet.frameIndices.includes(0)).length > 1);
});

test('empty containers, null values, Unicode and absent optional collections are preserved', () => {
  for (const input of [
    { poseData: {}, fullAnalysis: {} },
    { poseData: { frames: [], landmarkNames: [] }, fullAnalysis: { measurements: [], summary: '动作评价 🏋️', optional: null, nested: { rows: [], metrics: {} } } },
  ]) assert.deepEqual(restore(planMotionCoachBatches(input)), input);
  assert.deepEqual(restore(planMotionCoachBatches({ analysis: { measurements: [{ index: 1 }] } })), { poseData: {}, fullAnalysis: { measurements: [{ index: 1 }] } });
});

test('invalid budgets, lossy JSON values and unrepresentable scalars fail explicitly', () => {
  for (const maxChars of [0, 1023, -1, 1.5, Infinity, NaN]) assert.throws(() => planMotionCoachBatches({}, { maxChars }), /至少/);
  for (const value of [Infinity, NaN, undefined, new Date(), 2n]) assert.throws(() => planMotionCoachBatches({ fullAnalysis: { value } }), /JSON/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => planMotionCoachBatches({ fullAnalysis: cyclic }), /循环/);
  assert.throws(() => planMotionCoachBatches({ poseData: { frames: {} } }), /数组/);
  assert.throws(() => planMotionCoachBatches({ fullAnalysis: { measurements: {} } }), /数组/);
  assert.throws(() => planMotionCoachBatches({ fullAnalysis: { message: 'x'.repeat(2000) } }, { maxChars: 1024 }), /不会截断/);
});

test('pathological packet counts fail instead of silently discarding the tail', () => {
  const input = { poseData: { frames: Array.from({ length: 4097 }, () => ({ marker: 'x'.repeat(850) })) } };
  assert.throws(() => planMotionCoachBatches(input, { maxChars: 1024 }), /4096/);
});

function observedFrame(index) {
  const landmarks = Array.from({length: 33}, (_, joint) => [
    Math.fround((joint + index + 0.123456789) / 37),
    Math.fround((joint * 17 + index + 0.987654321) / 571),
    Math.fround((joint + 67) / 100),
  ]);
  const worldLandmarks = Array.from({length: 33}, (_, joint) => [
    Math.fround((joint + index + 0.123456789) / 137),
    Math.fround((joint * 17 + index + 0.987654321) / 1571),
    Math.fround(-2 + (joint + index) / 399),
    .98,
  ]);
  return {time: index / 15, sourceTime: index / 25, landmarks, worldLandmarks, subjectTracking: {status: 'locked', trackId: 'subject-1', confidence: 0.9876543212345}};
}

const decodePackets = packets => JSON.parse(JSON.stringify(packets)).map(packet => ({...packet, blocks: packet.blocks.map(decodeMotionCoachBlock)}));

test('readable pose tables preserve every original double after JSON transport while reducing packets', () => {
  const input = {poseData: {frames: Array.from({length: 168}, (_, index) => observedFrame(index))}, fullAnalysis: {measurements: [{index: 1, metrics: {duration: 1.234567891234567, arbitrary: [null, false, 0]}}]}};
  const original = JSON.stringify(input), raw = planMotionCoachBatches(input);
  const packed = planMotionCoachBatches(input, {compactPose: true});
  assert.deepEqual(restore(decodePackets(packed)), input);
  assert.equal(JSON.stringify(input), original, 'Encoding must never change local numeric values');
  assert(packed.length < raw.length);
  assert(JSON.stringify(packed).length < JSON.stringify(raw).length * 0.65, 'Realistic float32 coordinate tables should avoid repeated decimal expansion and confidence data');
  assert(packed.every(packet => JSON.stringify(packet).length <= 64000));
  assert.deepEqual(packed.flatMap(packet => packet.frameIndices), Array.from({length: 168}, (_, index) => index));
  const first = packed.flatMap(packet => packet.blocks).find(block => block.encoding);
  assert.equal(first.encoding, MOTION_COACH_POSE_ENCODING);
  assert(first.value.worldLandmarks.columns.includes('z'));
  assert.equal(first.value.worldLandmarks.tupleLength, 4);
  assert.equal(first.value.worldLandmarks.rows.length, 33);
  assert(first.value.landmarks.float32.includes('x'));
  assert.notEqual(first.value.landmarks.rows[0][0], input.poseData.frames[0].landmarks[0][0]);
  assert.equal(Math.fround(first.value.landmarks.rows[0][0]), input.poseData.frames[0].landmarks[0][0]);
  for (const packet of packed) {
    // Decoding an arbitrary packet does not require any earlier packet.
    for (const block of decodePackets([packet])[0].blocks) {
      if (block.path[0] === 'poseData' && block.path[1] === 'frames') assert.deepEqual(block.value, input.poseData.frames[block.path[2]]);
    }
  }
});

test('mixed float64 columns, null observations, distinct confidence values and missing masks stay exact', () => {
  const first = observedFrame(0);
  first.landmarks[0][0] = 0.12345678901234567; // Not representable in binary32.
  first.landmarks[4][2] = null;
  first.landmarks[7] = null;
  first.worldLandmarks[8][2] = 0.12345678901234567; // World depth has independent precision.
  for (const point of first.landmarks) if (point) point.push(point[2] === null ? 4 : 0);
  const frames = [first, {time: 1, landmarks: null, worldLandmarks: []}, {time: 2, landmarks: []}, observedFrame(3)];
  // Different tuple lengths cannot be mistaken for missingMask = 0.
  frames[3].landmarks[2].push(0);
  const input = {poseData: {frames}, fullAnalysis: {measurements: [], unknown: null}};
  const packets = planMotionCoachBatches(input, {compactPose: true});
  assert.deepEqual(restore(decodePackets(packets)), input);
  const block = packets.flatMap(packet => packet.blocks).find(block => block.path[2] === 0);
  assert(!block.value.landmarks.float32.includes('x'), 'A float64 value cannot be rounded to binary32');
  assert(!block.value.worldLandmarks.float32?.includes('z'));
  assert.equal(block.value.landmarks.rows[7], null);
  assert.equal(block.value.landmarks.tupleLength, 4);
  assert.deepEqual(decodeMotionCoachBlock({path: ['other'], value: [1, null]}), {path: ['other'], value: [1, null]});
  assert.throws(() => decodeMotionCoachBlock({encoding: 'unknown'}), /不支持/);
});

test('typed coordinate transport retains binary32 extremes and signed zeros', () => {
  const frame = observedFrame(0), smallest = Math.fround(2 ** -149), largest = Math.fround(3.4028234663852886e38);
  frame.landmarks[0][0] = smallest;
  frame.landmarks[1][0] = largest;
  frame.landmarks[2][0] = -smallest;
  frame.landmarks[3][0] = -0;
  for (const point of frame.worldLandmarks) point[2] = -0;
  const input = {poseData: {frames: [frame]}, fullAnalysis: {}};
  assert.deepEqual(restore(decodePackets(planMotionCoachBatches(input, {compactPose: true}))), input);
});

test('small budgets split original fields without leaving table metadata in another packet', () => {
  const input = {poseData: {frames: [observedFrame(0)]}, fullAnalysis: {measurements: []}};
  const packets = planMotionCoachBatches(input, {maxChars: 1024, compactPose: true});
  assert(packets.length > 1);
  assert(packets.every(packet => JSON.stringify(packet).length <= 1024));
  assert.deepEqual(restore(decodePackets(packets)), input);
  assert(packets.flatMap(packet => packet.blocks).every(block => !block.encoding));
});

test('matching poses and measured angles stay in the same bounded packet', () => {
  const input = {poseData: {frames: Array.from({length: 100}, (_, index) => observedFrame(index))},
    fullAnalysis: {measurements: Array.from({length: 100}, (_, index) => ({frameIndex: index, time: index / 15, left: {elbowAngle: index + .125}}))}};
  const packets = planMotionCoachBatches(input, {compactPose: true});
  assert(packets.length > 1);
  for (const packet of packets) {
    assert.deepEqual(packet.frameIndices, packet.measurementIndices);
    assert(JSON.stringify(packet).length <= 64000);
    for (const index of packet.frameIndices) {
      const posePosition = packet.blocks.findIndex(block => block.path[0] === 'poseData' && block.path[2] === index);
      assert.deepEqual(packet.blocks[posePosition + 1].path, ['fullAnalysis', 'measurements', index]);
    }
  }
  assert.deepEqual(restore(decodePackets(packets)), input);
});
