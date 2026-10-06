import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeMotionFeedback} from '../public/motion-feedback.js';

const point = () => [0.5, 0.5, 0.95];
const pose = (count = 20) => ({duration: count / 15, frames: Array.from({length: count}, (_, index) => ({time: index / 15, landmarks: Array.from({length: 33}, point), worldLandmarks: Array.from({length: 33}, () => [-.2, .1, -.3, .95]), personCount: 1}))});
const finding = extra => ({title: '后半程动作幅度变化', status: 'improve', source: 'pose', frameIndices: [1, 10, 19], evidenceTimes: [], evidence: '后几次肩关节活动幅度逐渐缩小。', correction: '减轻重量，保持前后几次相近的活动幅度。', priority: 1, ...extra});

test('pose feedback retains real non-image timestamps and does not require a catalog check code', () => {
  const poseData = pose(), input = finding();
  const result = sanitizeMotionFeedback([input], {poseData, keyframes: [{time: 0}]});
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].frameIndices, [1, 10, 19]);
  assert.deepEqual(result[0].evidenceTimes, [1 / 15, 10 / 15, 19 / 15]);
  assert.equal(result[0].time, 1 / 15);
  assert.equal(result[0].priority, 1);
  assert.equal(result[0].code, undefined);
  assert.deepEqual(input, finding(), 'Sanitizing never changes the untrusted response');
});

test('visual and combined findings require their own real picture references without time snapping', () => {
  const options = {poseData: pose(), keyframes: [{time: 0.31}, {time: 0.91}]};
  assert.equal(sanitizeMotionFeedback([finding({source: 'visual', evidenceTimes: [0.3, 99]})], options).length, 0);
  const visual = sanitizeMotionFeedback([finding({source: 'visual', evidenceTimes: [0.31, 99, 0.31]})], options)[0];
  assert.deepEqual(visual.frameIndices, []);
  assert.deepEqual(visual.evidenceTimes, [0.31]);
  const combined = sanitizeMotionFeedback([finding({source: 'combined', frameIndices: [10], evidenceTimes: [0.91]})], options)[0];
  assert.deepEqual(combined.evidenceTimes, [10 / 15, 0.91]);
  assert.equal(sanitizeMotionFeedback([finding({source: 'combined', frameIndices: [], evidenceTimes: [0.31]})], options).length, 0);
  assert.equal(sanitizeMotionFeedback([finding({source: 'combined', evidenceTimes: [0.32]})], options).length, 0);
  assert.equal(sanitizeMotionFeedback([finding({source: 'pose', frameIndices: [], evidenceTimes: [0.31]})], options).length, 0);
});

test('picture indices resolve only actual supplied images and never inherited or invented ones', () => {
  const options = {poseData: pose(), keyframes: [{time: .123456789}, {time: .5716666666666667}]};
  const output = sanitizeMotionFeedback([finding({source: 'visual', imageIndices: [1], evidenceTimes: [.572]})], options);
  assert.deepEqual(output[0].evidenceTimes, [.5716666666666667]);
  assert.equal(output[0].imageIndices, undefined);
  for (const imageIndices of [[-1], [2], [0.2], ['0'], [NaN]]) {
    assert.equal(sanitizeMotionFeedback([finding({source: 'visual', imageIndices})], options).length, 0);
  }
  assert.equal(sanitizeMotionFeedback([finding({source: 'visual', imageIndices: [0]})], {...options, imageKeyframes: []}).length, 0,
    'A text-only synthesis cannot relabel its inherited references as newly supplied images');
  assert.equal(sanitizeMotionFeedback([finding({source: 'visual', evidenceTimes: [.123456789]})], {...options, imageKeyframes: []}).length, 1);
});

test('forged indices and indices outside the current chunk never establish evidence', () => {
  const options = {poseData: pose(), allowedFrameIndices: [1, 2, 3]};
  const result = sanitizeMotionFeedback([finding({frameIndices: [-1, 1.2, '1', 1, 1, 19, 20, 999999, NaN, Infinity]})], options);
  assert.deepEqual(result[0].frameIndices, [1]);
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [19]})], options).length, 0);
  assert.equal(sanitizeMotionFeedback([finding()], {...options, allowedFrameIndices: []}).length, 0);
  assert.deepEqual(sanitizeMotionFeedback([finding()], {...options, allowedFrameIndices: new Set([10])})[0].frameIndices, [10]);
});

test('missing poses, ambiguous targets and low tracking confidence cannot support a finding', () => {
  for (const change of [
    frame => { frame.landmarks = []; },
    frame => { frame.landmarks.pop(); },
    frame => { frame.personCount = 2; },
    frame => { frame.personCount = 0; },
    frame => { frame.time = NaN; },
    frame => { frame.time = -1; },
    frame => { frame.time = 99; },
    frame => { frame.subjectTracking = {status: 'lost', confidence: 1, trackId: 'one'}; },
    frame => { frame.subjectTracking = {status: 'ambiguous', confidence: 1, trackId: 'one'}; },
    frame => { frame.subjectTracking = {status: 'locked', confidence: 0.64, trackId: 'one'}; },
    frame => { frame.subjectTracking = {status: 'locked', confidence: 1, trackId: ''}; },
  ]) {
    const poseData = pose(); change(poseData.frames[1]);
    assert.deepEqual(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}), []);
  }
  const poseData = pose();
  for (const frame of poseData.frames) { frame.personCount = 2; frame.subjectTracking = {status: 'locked', confidence: 0.65, trackId: 'one'}; }
  assert.equal(sanitizeMotionFeedback([finding()], {poseData}).length, 1);
  delete poseData.frames[1].subjectTracking;
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 0);
  poseData.frames[10].subjectTracking.trackId = 'another';
  assert.equal(sanitizeMotionFeedback([finding()], {poseData}).length, 0);
});

test('low-confidence and explicitly unknown points cannot establish reliable pose evidence', () => {
  for (const bad of [
    null, [0.5, 0.5, 0.54], [0.5, 0.5, null], [0.5, 0.5, null, 4],
    [null, 0.5, 0.9, 1], [2, 0.5, 0.9], [0.5, 0.5, 2],
    [0.5, 0.5, 0.9, 8], [0.5, 0.5, 0, 0.95, 0.9],
  ]) {
    const poseData = pose(); poseData.frames[1].landmarks = Array.from({length: 33}, () => structuredClone(bad));
    assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 0);
  }
  const poseData = pose();
  poseData.frames[1].landmarks = Array.from({length: 33}, () => null);
  for (const index of [0, 1, 2, 3, 4, 5, 6]) poseData.frames[1].landmarks[index] = point();
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 0, 'Only face points are insufficient');
  for (const index of [11, 13, 15]) poseData.frames[1].landmarks[index] = [0.5, 0.5, 0.9, 0];
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 1, 'Explicit zero missingMask retains observed image joints');
  for (const index of [11, 13, 15]) poseData.frames[1].landmarks[index] = [0.5, 0.5, 0.9];
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 1, 'Unmasked MediaPipe tuples use their observed confidence directly');
});

test('original object landmarks are supported without treating unknown visibility as confidence', () => {
  const poseData = pose();
  poseData.frames[1].landmarks = Array.from({length: 33}, () => ({x: 0.5, y: 0.5, visibility: 0.9}));
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 1);
  poseData.frames[1].landmarks.forEach(point => { delete point.visibility; });
  assert.equal(sanitizeMotionFeedback([finding({frameIndices: [1]})], {poseData}).length, 0);
});

test('pose-only equipment and spinal-neutrality claims are excluded', () => {
  for (const evidence of ['骨架证明腰椎中立，腰椎曲线完全正常。', '识别为使用杠铃，器械类型已经确认。']) {
    assert.deepEqual(sanitizeMotionFeedback([finding({evidence})], {poseData: pose()}), []);
    assert.equal(sanitizeMotionFeedback([finding({evidence, source: 'visual', evidenceTimes: [0.2]})], {keyframes: [{time: 0.2}]}).length, 1);
  }
});

test('optional analysis paths reference real objective angles, never quality or legacy scores', () => {
  const fullAnalysis={measurements:[{frameIndex:0,time:0,left:{elbowAngle:90},right:{elbowAngle:null}}],quality:{targetCoverage:1}};
  const options={poseData:pose(),fullAnalysis};
  assert.equal(sanitizeMotionFeedback([finding({analysisPaths:[['measurements',0,'left','elbowAngle']]})],options).length,1);
  for(const path of [['quality','targetCoverage'],['measurements',0,'right','elbowAngle'],['measurements',1,'left','elbowAngle'],['constructor','name'],['__proto__'],['reps',0,'score']])assert.equal(sanitizeMotionFeedback([finding({analysisPaths:[path]})],options).length,0);
});

test('feedback removes rating claims and formatting but preserves quantitative motion measurements', () => {
  const result = sanitizeMotionFeedback([finding({title: '<b>幅度</b> **变化**', evidence: '动作得分 99分。下降用时 2 分钟。角度约 90°，比前一次缩小 20%。模型准确率为 98%。', correction: '[减轻重量](https://example.test)，保持幅度。评分 9/100。\u0000', priority: 99})], {poseData: pose()});
  assert.equal(result[0].title, '幅度 变化');
  assert.equal(result[0].evidence, '下降用时 2 分钟。角度约 90°，比前一次缩小 20%。');
  assert.equal(result[0].correction, '减轻重量，保持幅度。');
  assert.equal(result[0].priority, 2);
  assert.deepEqual(sanitizeMotionFeedback([finding({evidence: '动作100分。'})], {poseData: pose()}), []);
});

test('feedback is bounded and deduplicated while full temporal references remain intact', () => {
  const poseData = pose(1800), frameIndices = Array.from({length: 1800}, (_, index) => index);
  const inputs = Array.from({length: 30}, (_, index) => finding({title: `动作观察 ${index}`, evidence: '证据'.repeat(900), correction: '建议'.repeat(900), frameIndices}));
  const result = sanitizeMotionFeedback([inputs[0], inputs[0], ...inputs.slice(1)], {poseData});
  assert.equal(result.length, 12);
  assert.equal(result[0].frameIndices.length, 1800);
  assert.equal(result[0].evidenceTimes.length, 1800);
  assert.equal(result[0].evidenceTimes.at(-1), 1799 / 15);
  assert.equal(result[0].evidence.length, 1200);
  assert.equal(result[0].correction.length, 1200);
});

test('invalid structures, sources and statuses never become inferred findings', () => {
  for (const value of [null, {}, 'text']) assert.deepEqual(sanitizeMotionFeedback(value), []);
  assert.deepEqual(sanitizeMotionFeedback([null, [], {}, finding({source: 'guessed'}), finding({status: 'pass'}), finding({title: ''})], {poseData: pose()}), []);
});

function completeMeasurements(){return {measurements:Array.from({length:1800},(_,index)=>({frameIndex:index,time:index/15,left:{elbowAngle:90+index/100,kneeAngle:120},right:{elbowAngle:null}}))};}
const measuredFinding=extra=>finding({source:'analysis',frameIndices:[],analysisPaths:[['measurements',1799,'left','elbowAngle']],evidenceTimes:[999],...extra});

test('analysis feedback retains final sampled angle with its actual timestamp and no invented time',()=>{
 const fullAnalysis=completeMeasurements(),result=sanitizeMotionFeedback([measuredFinding()],{fullAnalysis,poseData:{duration:120}});
 assert.equal(result.length,1);assert.deepEqual(result[0].analysisPaths,[['measurements',1799,'left','elbowAngle']]);
 assert.deepEqual(result[0].evidenceTimes,[1799/15]);assert.deepEqual(result[0].frameIndices,[]);
});

test('analysis evidence obeys packet and synthesis path restrictions',()=>{
 const fullAnalysis=completeMeasurements(),item=measuredFinding();
 for(const allowedAnalysisPaths of [[['fullAnalysis','measurements',1799]],[['measurements',1799,'left']],[['fullAnalysis']]])assert.equal(sanitizeMotionFeedback([item],{fullAnalysis,allowedAnalysisPaths}).length,1);
 for(const allowedAnalysisPaths of [[],[['measurements',0]],[['poseData']]])assert.equal(sanitizeMotionFeedback([item],{fullAnalysis,allowedAnalysisPaths}).length,0);
 const allowedAnalysisPaths=[['measurements',1799,'left','elbowAngle']];
 assert.equal(sanitizeMotionFeedback([measuredFinding({analysisPaths:[['measurements',1799,'left','kneeAngle']]})],{fullAnalysis,allowedAnalysisPaths}).length,0);
});

test('single flat analysis paths normalize without broadening the evidence allowlist', () => {
  const fullAnalysis = completeMeasurements(), allowedAnalysisPaths = [['measurements', 1799, 'left', 'elbowAngle']];
  const result = sanitizeMotionFeedback([measuredFinding({analysisPaths: ['measurements', 1799, 'left', 'elbowAngle']})], {fullAnalysis, allowedAnalysisPaths});
  assert.deepEqual(result[0].analysisPaths, allowedAnalysisPaths);
  assert.deepEqual(result[0].evidenceTimes, [1799 / 15]);
  for (const path of [['measurements', 1798, 'left', 'elbowAngle'], ['measurements', 1799, 'right', 'elbowAngle'], ['__proto__', 'x']]) {
    assert.equal(sanitizeMotionFeedback([measuredFinding({analysisPaths: path})], {fullAnalysis, allowedAnalysisPaths}).length, 0);
  }
});

test('analysis feedback rejects missing/invalid angles, times, identity, invented and legacy measurement paths',()=>{
 const fullAnalysis=completeMeasurements();
 for(const path of [['measurements',1800,'left','elbowAngle'],['measurements',1799,'right','elbowAngle'],['measurements',1799,'time'],['measurements',1799,'score'],['reps',0,'metrics','duration']])assert.equal(sanitizeMotionFeedback([measuredFinding({analysisPaths:[path]})],{fullAnalysis}).length,0);
 for(const value of [null,'90',Infinity,NaN,-1,181]){const copy=structuredClone(fullAnalysis);copy.measurements[1799].left.elbowAngle=value;assert.equal(sanitizeMotionFeedback([measuredFinding()],{fullAnalysis:copy}).length,0);}
 for(const mutate of [row=>row.time=-1,row=>row.time=121,row=>row.frameIndex=1]){const copy=structuredClone(fullAnalysis);mutate(copy.measurements[1799]);assert.equal(sanitizeMotionFeedback([measuredFinding()],{fullAnalysis:copy}).length,0);}
 assert.equal(sanitizeMotionFeedback([measuredFinding()],{fullAnalysis,poseData:{duration:30}}).length,0);
});

test('measured angles do not establish equipment or spinal neutrality, and improvement requires a correction',()=>{
 const fullAnalysis=completeMeasurements();
 assert.equal(sanitizeMotionFeedback([measuredFinding({evidence:'器械类型为杠铃，腰椎中立已经确认。'})],{fullAnalysis}).length,0);
 assert.equal(sanitizeMotionFeedback([measuredFinding({correction:''})],{fullAnalysis}).length,0);
});

// A visible 2D skeleton never substitutes for absent or unreliable depth.
test('pose evidence requires reliable XYZ observations and accepts signed metric coordinates', () => {
  for (const change of [frame => {delete frame.worldLandmarks;}, frame => {frame.worldLandmarks=[];},
    frame => {frame.worldLandmarks=Array(33).fill([0,0,null,.9]);},
    frame => {frame.worldLandmarks=Array(33).fill([0,0,1,.54]);},
    frame => {frame.worldLandmarks=Array(33).fill([0,0,null,.9,4]);}]) {
    const poseData=pose(); change(poseData.frames[1]);
    assert.deepEqual(sanitizeMotionFeedback([finding({frameIndices:[1]})],{poseData}),[]);
  }
  const poseData=pose(); poseData.frames[1].worldLandmarks=Array(33).fill([-1.2,2.3,-3.4,.95]);
  assert.equal(sanitizeMotionFeedback([finding({frameIndices:[1]})],{poseData}).length,1);
});
