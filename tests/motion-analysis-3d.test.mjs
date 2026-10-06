import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMotion} from '../public/motion-analysis.js';
import {getMotionPoseModel} from '../public/motion-models.js';

const modelVersion = getMotionPoseModel('mediapipe-full').version;
const options = {width:1000,height:1000,modelVersion};
const close = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const allNull = row => [...Object.values(row.left),...Object.values(row.right)].every(value=>value===null);
function frame(time=0) {
  const landmarks=Array(33).fill(null),worldLandmarks=Array(33).fill(null);
  for(const side of [0,1]) for(const [index,x,y] of [[11,.2,.1],[13,.2,.3],[15,.4,.3],[23,.2,.5],[25,.2,.7],[27,.4,.7]]) {
    landmarks[index+side]={x:x+side*.1,y,visibility:.99};
    worldLandmarks[index+side]={x:x+side*.1-.5,y:y-.5,z:0,visibility:.99};
  }
  return {time,landmarks,worldLandmarks};
}

for(const [name,indices] of Object.entries({elbowAngle:[11,13,15],shoulderAngle:[23,11,13],hipAngle:[11,23,25],kneeAngle:[23,25,27],bodyAlignmentAngle:[11,23,27]})) {
  test(`MediaPipe ${name} uses true XYZ geometry rather than image or normalized depth`,()=>{
    const sample=frame();
    const image=[[.7,.5],[.5,.5],[.5,.7]],world=[[1,0,1],[0,0,0],[0,1,1]];
    indices.forEach((index,n)=>{
      const [x,y]=image[n];sample.landmarks[index]={x,y,z:-999,visibility:1};
      const [wx,wy,z]=world[n];sample.worldLandmarks[index]={x:wx,y:wy,z,visibility:1};
    });
    const report=analyzeMotion([sample],options);
    assert.equal(report.version,'motion-observations-3d-v1');
    assert.equal(report.coordinateSpace,'mediapipe-world-3d');
    close(report.measurements[0].left[name],60);
    const {worldLandmarks,...planar}=sample;
    const old=analyzeMotion([planar],{width:1000,height:1000});
    assert.equal(old.measurements[0].left[name],null);
    assert.equal(old.version,'motion-observations-3d-v1');
    assert.equal(old.coordinateSpace,'mediapipe-world-3d');
  });
}

test('3D torso lean measures unsigned deviation from estimated world Y including depth',()=>{
  for(const [shoulder,expected] of [[[0,-.3,.3],45],[[0,.3,-.3],45],[[0,0,.3],90],[[0,-.3,0],0]]) {
    const sample=frame(),[x,y,z]=shoulder;
    sample.worldLandmarks[11]={x,y,z,visibility:1};
    sample.worldLandmarks[23]={x:0,y:0,z:0,visibility:1};
    close(analyzeMotion([sample],options).measurements[0].left.torsoLean,expected);
  }
  const sample=frame();
  sample.worldLandmarks[11]={...sample.worldLandmarks[23]};
  assert.equal(analyzeMotion([sample],options).measurements[0].left.torsoLean,null);
});

test('missing, nonfinite or hidden world points never fall back to 2D angles',()=>{
  for(const change of [null,{z:undefined},{z:NaN},{z:Infinity},{visibility:.54},{visibility:1.1},{visibility:undefined}]) {
    const sample=frame();
    sample.worldLandmarks[13]=change===null?null:{...sample.worldLandmarks[13],...change};
    const report=analyzeMotion([sample],options);
    assert.equal(report.measurements[0].left.elbowAngle,null);
    assert.equal(report.measurements[0].left.shoulderAngle,null);
    close(report.measurements[0].right.elbowAngle,90);
    assert(report.quality.reasons.includes('MISSING_OR_UNCERTAIN_LANDMARKS'));
  }
  for(const imageChange of [{x:-.1},{y:1.1},{visibility:.4}]) {
    const sample=frame();Object.assign(sample.landmarks[13],imageChange);
    assert.equal(analyzeMotion([sample],options).measurements[0].left.elbowAngle,null);
  }
});

test('3D model metadata and any retained world frame prevent silent mixed-space fallbacks',()=>{
  const sample=frame();
  delete sample.worldLandmarks;
  for(const missing of [sample,{...sample,worldLandmarks:[]}]) {
    const report=analyzeMotion([missing],options);
    assert.equal(report.version,'motion-observations-3d-v1');
    assert.equal(report.quality.validFrames,0);
    assert(allNull(report.measurements[0]));
  }
  const mixed=analyzeMotion([frame(),{...sample,time:.1}],{width:1000,height:1000});
  assert.equal(mixed.version,'motion-observations-3d-v1');
  assert.equal(mixed.quality.validFrames,1);
  assert(allNull(mixed.measurements[1]));
  assert.equal(analyzeMotion([],options).coordinateSpace,'mediapipe-world-3d');
});

test('world angles remain independent of video aspect ratio and preserve immutable inputs',()=>{
  const sample=frame();sample.worldLandmarks[11].z=.2;
  for(const point of [...sample.landmarks,...sample.worldLandmarks]) if(point) Object.freeze(point);
  Object.freeze(sample.landmarks);Object.freeze(sample.worldLandmarks);Object.freeze(sample);
  const frames=Object.freeze([sample]);
  assert.deepEqual(analyzeMotion(frames,{...options,width:1920,height:1080}),analyzeMotion(frames,{...options,width:1080,height:1920}));
});

test('lost target and identity changes suppress 3D observations without image-only fallbacks',()=>{
  for(const tracking of [{status:'lost',confidence:0,trackId:'person'},{status:'locked',confidence:.4,trackId:'person'}]) {
    assert(allNull(analyzeMotion([{...frame(),subjectTracking:tracking}],options).measurements[0]));
  }
  const samples=['first','second'].map((trackId,index)=>({...frame(index*.1),subjectTracking:{status:'locked',confidence:.9,trackId}}));
  const report=analyzeMotion(samples,options);
  assert(report.measurements.every(allNull));
  assert(report.quality.reasons.includes('TARGET_ID_CHANGED'));
});
