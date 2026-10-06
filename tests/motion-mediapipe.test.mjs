import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createMediaPipe,mediaPipeLandmarks,mediaPipeWorldLandmarks} from '../public/motion-mediapipe.js';
import {getMotionPoseModel,MOTION_POSE_MODELS} from '../public/motion-models.js';
import {buildMotionPoseData,validateMotionPoseData,MOTION_BODY_LANDMARK_INDICES} from '../public/motion-pose-data.js';
import {buildMotionOverlay} from '../public/motion-overlay.js';
import {analyzeVideo} from '../public/motion-video.js';

test('all three tiers share 17 world3D body points while image observations remain available for overlays',()=>{
  const input=Array.from({length:33},(_,i)=>({x:.2+i*.01,y:.3+i*.01,z:.2,visibility:.9,presence:.99}));
  const [landmarks]=mediaPipeLandmarks({landmarks:[input]});
  assert.deepEqual(landmarks[0],{x:.2,y:.3,visibility:.9});
  assert.equal(buildMotionOverlay(landmarks,640,480).points.length,17);
  assert.deepEqual(mediaPipeLandmarks({landmarks:[]}),[]);
  const [worldLandmarks]=mediaPipeWorldLandmarks({worldLandmarks:[input.map((point,index)=>({...point,x:point.x-.5,y:point.y-.5,z:index*.01-.2}))]});
  for (const model of MOTION_POSE_MODELS) {
  const pipeline={modelVersion:model.version,duration:1,width:640,height:480,sampleFps:2,frames:[{time:0,landmarks,worldLandmarks},{time:.5,landmarks:[],worldLandmarks:[]}]};
  const body=buildMotionPoseData(pipeline);
  assert.equal(body.format,'mediapipe-world17-full');
  assert.equal(body.schemaVersion,6);
  assert.match(body.coordinates.confidence,/MediaPipe/);
  for(let index=0;index<33;index++) {
    assert.deepEqual(body.frames[0].landmarks[index],MOTION_BODY_LANDMARK_INDICES.includes(index)?[landmarks[index].x,landmarks[index].y,.9]:null);
    assert.deepEqual(body.frames[0].worldLandmarks[index],MOTION_BODY_LANDMARK_INDICES.includes(index)?[worldLandmarks[index].x,worldLandmarks[index].y,worldLandmarks[index].z,.9]:null);
  }
  assert.deepEqual(body.frames[1].landmarks,[]);
  assert.deepEqual(body.frames[1].worldLandmarks,[]);
  assert.deepEqual(buildMotionPoseData(pipeline),body);
  const invalid=structuredClone(body);invalid.frames[0].landmarks[1]=[.2,.3,.9];
  assert.throws(()=>validateMotionPoseData(invalid),/17 个身体节点/);
  }
  assert.equal(input[0].z,.2);
});

test('model tiers use distinct pinned task assets and version labels with Full as default',()=>{
  assert.deepEqual(MOTION_POSE_MODELS.map(model=>[model.id,model.tier]),[
    ['mediapipe-lite','快速'],['mediapipe-full','标准'],['mediapipe-heavy','高精度'],
  ]);
  assert.equal(new Set(MOTION_POSE_MODELS.map(model=>model.assetPath)).size,3);
  assert.equal(new Set(MOTION_POSE_MODELS.map(model=>model.version)).size,3);
  assert.equal(getMotionPoseModel().id,'mediapipe-full');
  assert.equal(getMotionPoseModel('mediapipe-heavy').description,'精度更高，但分析时间更长');
});

test('MediaPipe factory loads the selected task and keeps identical detector options for GPU and CPU',async()=>{
  const source=await readFile(new URL('../public/motion-mediapipe.js',import.meta.url),'utf8');
  const calls=[];
  const landmarks=[[{x:.1,y:.2,z:0,visibility:.8}]],worldLandmarks=[[{x:-.3,y:.2,z:-.6,visibility:.8}]];
  const module={FilesetResolver:{async forVisionTasks(url){return {url};}},PoseLandmarker:{async createFromOptions(vision,options){
    calls.push({vision,options});return {detectForVideo(){return {landmarks,worldLandmarks};},close(){}};
  }}};
  const context=vm.createContext({URL,getMotionPoseModel,runtime:{async importModule(){return module;}}});
  vm.runInContext(source.replace(/^import .*;\s*/m,'').replaceAll('export ','').replaceAll('import(', 'runtime.importModule(').replaceAll('import.meta.url',"'https://app.test/motion-mediapipe.js'"),context);
  const create=vm.runInContext('createMediaPipe',context);
  for(const model of MOTION_POSE_MODELS) for(const delegate of ['GPU','CPU']) {
    const pose=await create({model:model.id,delegate}),call=calls.at(-1);
    assert.equal(call.options.baseOptions.modelAssetPath,`https://app.test/vendor/mediapipe/${model.assetPath}`);
    assert.equal(call.options.baseOptions.delegate,delegate);
    assert.equal(call.vision.url,'https://app.test/vendor/mediapipe/wasm');
    assert.equal(call.options.runningMode,'VIDEO');
    assert.equal(call.options.numPoses,4);
    assert.deepEqual(JSON.parse(JSON.stringify(pose.detect({},0))),{landmarks:[[{x:.1,y:.2,visibility:.8}]],worldLandmarks:[[{x:-.3,y:.2,z:-.6,visibility:.8}]]});
    pose.close();
  }
});

test('MediaPipe keeps real world xyz separately without inventing missing depth or mixing people',()=>{
  const worldLandmarks=Array.from({length:2},(_,person)=>Array.from({length:33},(_,index)=>({x:-.2+person,y:.3,z:-.1-index*.01,visibility:.9,presence:.99})));
  const result=mediaPipeWorldLandmarks({worldLandmarks});
  assert.deepEqual(result[0][0],{x:-.2,y:.3,z:-.1,visibility:.9});
  assert.deepEqual(result[1][32],{x:.8,y:.3,z:worldLandmarks[1][32].z,visibility:.9});
  assert.equal(result[0].length,33);
  assert.notEqual(result[0][0],worldLandmarks[0][0]);
  assert.deepEqual(mediaPipeWorldLandmarks({landmarks:[[{x:.2,y:.3,z:.4,visibility:1}]]}),[]);
  assert.deepEqual(mediaPipeWorldLandmarks({worldLandmarks:[]}),[]);
  assert.match(getMotionPoseModel('mediapipe-full').version,/\/ world3d-v1$/);
});

test('unknown model is rejected before opening browser resources',async()=>{
  assert.equal(getMotionPoseModel().id,'mediapipe-full');
  await assert.rejects(createMediaPipe({model:'unsupported-model'}),/骨架分析模型/);
  await assert.rejects(analyzeVideo({name:'clip.mp4',size:20},{model:'full'}),/骨架分析模型/);
});
