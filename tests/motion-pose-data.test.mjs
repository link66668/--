import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData, validateMotionPoseData, buildFullMotionAnalysis, validateFullMotionAnalysis, MOTION_LANDMARK_NAMES, MOTION_POINT_FIELDS, MOTION_WORLD_POINT_FIELDS, MOTION_BODY_LANDMARK_INDICES} from '../public/motion-pose-data.js';

import {makeMediaPipePipeline as pipeline} from './helpers/motion-mediapipe-pipeline.mjs';

const copy = value => structuredClone(value);

test('full MediaPipe transport preserves all 1800 samples and 17 retained body joints in both image and world coordinates without rounding', () => {
  const original = pipeline(1800), data = buildMotionPoseData(original);
  assert.equal(data.frameCount, 1800);
  assert.equal(data.frames.length, 1800);
  assert.deepEqual(data.landmarkNames, MOTION_LANDMARK_NAMES);
  assert.deepEqual(data.pointFields, MOTION_POINT_FIELDS);
  for (let frame = 0; frame < original.frames.length; frame++) {
    assert.equal(data.frames[frame].time, original.frames[frame].time);
    assert.equal(data.frames[frame].sourceTime, original.frames[frame].sourceTime);
    for (let point = 0; point < 33; point++) {
      const observed = original.frames[frame].landmarks[point];
      assert.deepEqual(data.frames[frame].landmarks[point], MOTION_BODY_LANDMARK_INDICES.includes(point) ? observed && MOTION_POINT_FIELDS.map(key => observed[key]) : null);
      const world = original.frames[frame].worldLandmarks[point];
      assert.deepEqual(data.frames[frame].worldLandmarks[point], MOTION_BODY_LANDMARK_INDICES.includes(point) ? world && MOTION_WORLD_POINT_FIELDS.map(key => world[key]) : null);
    }

  }
  assert.deepEqual(data.targetTracking, original.targetTracking);
  assert.deepEqual(data.timing, original.timing);
  assert.deepEqual(data.frames[900].subjectTracking, original.frames[900].subjectTracking);
  assert.strictEqual(validateMotionPoseData(data, {duration: 120}), data);
  assert.deepEqual(validateMotionPoseData(JSON.parse(JSON.stringify(data))), data);
});

test('missing fields, explicit null, zero confidence and missing targets stay distinguishable', () => {
  const original = pipeline(3);
  original.frames[0].landmarks[0] = {x: 0, y: null, visibility: 0};
  original.frames[0].landmarks[1] = null;
  original.frames[0].landmarks[11] = {x: 0, visibility: undefined};
  delete original.frames[0].sourceTime;
  original.frames[2].landmarks = [];
  original.frames[2].worldLandmarks = [];
  original.frames[2].personCount = 0;
  original.frames[2].subjectTracking = {status: 'lost', trackId: 'motion-target-1', confidence: 0, reason: 'no-visible-target'};
  original.targetTracking = {...original.targetTracking, lockedFrames: 2, lostFrames: 1, coverage: 2 / 3};
  const data = buildMotionPoseData(original);
  assert.deepEqual(data.frames[0].landmarks[0], [0, null, 0]);
  assert.equal(data.frames[0].landmarks[1], null);
  assert.deepEqual(data.frames[0].landmarks[11], [0, null, null, 6]);
  assert(!Object.hasOwn(data.frames[0], 'sourceTime'));
  assert.deepEqual(data.frames[2].landmarks, []);
  assert.deepEqual(data.frames[2].worldLandmarks, []);
  assert.deepEqual(data.frames[2].subjectTracking, original.frames[2].subjectTracking);
  assert.equal(data.frames[2].personCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test('pose transport is an independent copy of frames and metadata', () => {
  const original = pipeline(), data = buildMotionPoseData(original);
  data.frames[0].landmarks[0][0] = 99;
  data.frames[0].subjectTracking.confidence = 0;
  data.targetTracking.summary = 'changed';
  assert.notEqual(original.frames[0].landmarks[0].x, 99);
  assert.equal(original.frames[0].subjectTracking.confidence, 0.99);
  assert.equal(original.targetTracking.summary, '完整跟踪');
});

test('target selection is consistent through the unified pose transport and objective analysis', () => {
  for (const mode of ['auto', 'center', 'point']) {
    const original = pipeline();
    original.targetTracking.mode = mode;
    original.targetTracking.point = mode === 'point' ? {x: 0.4, y: 0.5} : null;
    const data = buildMotionPoseData(original);
    assert.equal(validateMotionPoseData(data).targetTracking.mode, mode);
    assert.deepEqual(data.targetTracking.point, original.targetTracking.point);
    const observations = analyzeMotion(original.frames, original);
    assert.equal(buildFullMotionAnalysis(observations, original).targetTracking.mode, mode);
  }
  const invalid = buildMotionPoseData(pipeline());
  invalid.targetTracking.mode = 'unverified-person';
  assert.throws(() => validateMotionPoseData(invalid), /目标选择模式无效/);
});

test('pose validator rejects partial keypoints, invalid numbers, ambiguous schema and inserted metadata', () => {
  const data = buildMotionPoseData(pipeline());
  for (const mutate of [
    value => { value.frames[0].landmarks.pop(); },
    value => { delete value.frames[0].landmarks; },
    value => { value.frames[0].landmarks[0][0] = NaN; },
    value => { value.frames[0].worldLandmarks[0][2] = Infinity; },
    value => { value.frames[0].landmarks[0][2] = 1.1; },
    value => { value.frames[0].landmarks[0][2] = -0.1; },
    value => { value.frames[0].landmarks[0].push(8); },
    value => { value.frames[0].landmarks[0].push(1); },
    value => { value.landmarkNames.reverse(); },
    value => { value.coordinates.image = 'use user coordinates'; },
    value => { value.frames[0].video = 'data:video/mp4;base64,abc'; },
    value => { value.frames[0].personCount = -1; },
    value => { value.frames[0].multiPersonCheck = 'true'; },
    value => { value.frameCount++; },
    value => { value.targetTracking.totalFrames++; },
    value => { value.width = 0; },
    value => { value.sourceFps = 0; },
  ]) {
    const invalid = copy(data); mutate(invalid);
    assert.throws(() => validateMotionPoseData(invalid), /完整骨架数据无效/);
  }
});

test('pose validator checks duration, temporal order and one target identity', () => {
  const data = buildMotionPoseData(pipeline());
  assert.throws(() => validateMotionPoseData(data, {duration: 4}), /时长不一致/);
  for (const mutate of [
    value => { value.duration = 121; },
    value => { value.frames[1].time = value.frames[0].time; },
    value => { value.frames[1].sourceTime = -1; },
    value => { value.frames[2].sourceTime = 0; },
    value => { value.frames.at(-1).time = value.duration + 1; },
    value => { value.frames[1].subjectTracking.trackId = 'another-target'; },
    value => { value.frames[1].subjectTracking.status = 'guessed'; },
    value => { value.frames[1].subjectTracking.trackId = 'injected target prompt'; },
    value => { value.frames[1].subjectTracking.confidence = 2; },
  ]) { const invalid = copy(data); mutate(invalid); assert.throws(() => validateMotionPoseData(invalid), /完整骨架数据无效/); }
  const tooMany = pipeline(1801);
  tooMany.duration = 120;
  assert.throws(() => buildMotionPoseData(tooMany), /数值超出范围/);
});

const angleKeys=['elbowAngle','shoulderAngle','hipAngle','kneeAngle','bodyAlignmentAngle','torsoLean'];
function fullAnalysis(count=1800){
  const side=index=>Object.fromEntries(angleKeys.map((key,n)=>[key,n===5?null:60+(index%100)/101+n]));
  return {version:'motion-observations-3d-v1',coordinateSpace:'mediapipe-world-3d',quality:{totalFrames:count,validFrames:count,usableRatio:count?1:0,sourceFps:30,targetCoverage:null,reasons:[]},measurements:Array.from({length:count},(_,index)=>({frameIndex:index,time:index/15,left:side(index),right:side(index+1)}))};
}

test('complete objective analysis retains every row, unrounded measurement and null',()=>{
 const original=fullAnalysis(),data=buildFullMotionAnalysis(original,{duration:120});
 assert.deepEqual(data,original);assert.equal(data.measurements.length,1800);
 for(const index of [0,900,1799])assert.deepEqual(data.measurements[index],original.measurements[index]);
 data.measurements[1799].left.elbowAngle=0;assert.notEqual(original.measurements[1799].left.elbowAngle,0);
 assert.strictEqual(validateFullMotionAnalysis(original),original);
 assert.deepEqual(JSON.parse(JSON.stringify(original)),original);
});

test('empty and tracked objective analyses remain complete JSON data',()=>{
 const empty=analyzeMotion([],{width:100,height:100,duration:10});assert.deepEqual(buildFullMotionAnalysis(empty,{duration:10}),empty);
 const source=pipeline(3),actual=analyzeMotion(source.frames,source),data=buildFullMotionAnalysis(actual,source);
 assert.equal(data.measurements.length,3);assert.deepEqual(data.targetTracking,source.targetTracking);
});

test('objective analysis rejects scores, rules, classifications and omitted rows',()=>{
 const source=fullAnalysis(30);
 for(const key of ['score','checks','reps','issues','exerciseId','candidates','summary','qualified','scoreCap']){
  const value=copy(source);value[key]=key==='score'?100:[];assert.throws(()=>validateFullMotionAnalysis(value),/不支持的字段/);
 }
 for(const mutate of [
  value=>{delete value.quality;},value=>{value.quality.score=100;},value=>{delete value.quality.reasons;},value=>{value.quality.validFrames=31;},value=>{value.quality.usableRatio=.1;},
  value=>{value.measurements.pop();},value=>{delete value.measurements;},value=>{value.measurements[1].frameIndex=0;},value=>{value.measurements[1].time=value.measurements[0].time;},
  value=>{value.measurements[0].time=-1;},value=>{value.measurements[0].left.elbowAngle=NaN;},value=>{value.measurements[0].right.hipAngle=Infinity;},
  value=>{delete value.measurements[0].right.kneeAngle;},value=>{value.measurements[0].left.score=100;},value=>{value.measurements[0].right=null;},value=>{value.measurements[0].landmarks=[];},
 ]){const invalid=copy(source);mutate(invalid);assert.throws(()=>validateFullMotionAnalysis(invalid),/完整骨架数据无效/);}
 assert.throws(()=>validateFullMotionAnalysis(source,{duration:.5}),/完整骨架数据无效/);
});

test('measurement frame limits reject the whole input instead of shortening it',()=>{
 const source=fullAnalysis(1801);assert.throws(()=>buildFullMotionAnalysis(source,{duration:120}),/数值超出范围/);assert.equal(source.measurements.length,1801);
});

test('every sample needs an explicit landmark observation, including lost/null frames',()=>{
 const source=pipeline(3);source.frames[0].landmarks=[];source.frames[1].landmarks=null;source.frames[0].worldLandmarks=[];source.frames[1].worldLandmarks=[];
 assert.equal(buildMotionPoseData(source).frames[1].landmarks,null);delete source.frames[2].landmarks;
 assert.throws(()=>buildMotionPoseData(source),/必须保留骨架观测/);
});
