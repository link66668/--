import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {makeMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {validateMotionPoseData, validateFullMotionAnalysis} from '../public/motion-pose-data.js';
import {getMotionPoseModel} from '../public/motion-models.js';

// Only media/model operations are doubled. Objective observations and transport
// validation use the actual production modules; no model or network is started.
const mocks = {
  'motion-video.js':`export const analyzeVideo=(...args)=>globalThis.__chatMotion.analyze(...args);`,
  'motion-evidence.js':`export const buildMotionEvidence=(...args)=>globalThis.__chatMotion.evidence(...args);`,
  'motion-media.js':`export {validateVideoFile,validateVideoMetadata} from './motion-media.js?chat-motion-real'; export const releasePreparedMotionVideo=file=>globalThis.__chatMotion.released.push(file);`,
};
const hooks = registerHooks({load(url,context,next){
  const source=url.includes('/public/')&&mocks[url.slice(url.lastIndexOf('/')+1)];
  return source?{format:'module',source,shortCircuit:true}:next(url,context);
}});
const {ChatMotionVideos} = await import('../public/chat-motion.js?unit');
hooks.deregister();

const flush = () => new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<40;i++){if(predicate())return;await flush();}assert.fail('Local analysis did not settle');}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function pipeline(model='mediapipe-full'){
  const value=makeMediaPipePipeline(4);value.sampleFps=7.5;value.duration=4/7.5;
  value.frames.forEach((frame,index)=>{frame.time=index/7.5;frame.sourceTime=index/7.5+.001;});
  value.modelVersion=getMotionPoseModel(model).version;
  value.previewFrames=[{data:new Uint8Array(100)}];value.previewFps=5;
  return value;
}
const evidence = () => ({summary:{version:'motion-observations-3d-v1',duration:4/7.5},images:[{time:.001,imageTime:.001,mimeType:'image/jpeg',dataUrl:'data:image/jpeg;base64,AAAA'}]});
function setup(t){
  const h={poseCalls:[],imageCalls:[],poseQueue:[],imageQueue:[],released:[]};
  h.analyze=async(file,options)=>{h.poseCalls.push({file,options});options.onProgress({stage:'analyzing',progress:.2,message:'提取测试骨架'});const value=pipeline(options.model);
    return h.poseQueue.shift()?.promise??value;};
  h.evidence=async(file,pipeline,observations,options)=>{h.imageCalls.push({file,pipeline,observations,options});return h.imageQueue.shift()?.promise??evidence();};
  globalThis.__chatMotion=h;h.videos=new ChatMotionVideos();
  h.file=(name='clip.mp4')=>new File(['synthetic fixture'],name,{type:'video/mp4'});
  t.after(()=>{h.videos.clear();delete globalThis.__chatMotion;});
  return h;
}

test('local descriptors use stable opaque IDs, retain actual files and release explicitly',t=>{
  const h=setup(t),file=h.file(),descriptor=h.videos.add(file,{duration:1,width:100,height:80});
  assert.match(descriptor.id,/^local-video:[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.deepEqual(Object.keys(descriptor).sort(),['id','name','size','type']);
  assert.equal(h.videos.get(descriptor.id),file);
  const second=h.videos.add(h.file());assert.notEqual(second.id,descriptor.id,'Identical names do not identify the same File');
  assert.equal(h.videos.remove(descriptor.id),true);assert.equal(h.videos.get(descriptor.id),null);
  assert.equal(h.videos.remove(descriptor.id),false);
  h.videos.clear();assert.equal(h.videos.get(second.id),null);assert.equal(h.released.length,2);
});

test('two drafts holding the same File get independent handles and normalized metadata',async t=>{
  const h=setup(t),file=new File(['synthetic fixture'],'clip.mp4',{type:'application/octet-stream'});
  const first=h.videos.add(file,{name:'clip.mp4',type:'video/mp4'}),second=h.videos.add(file,{type:'video/mp4'});
  assert.notEqual(first.id,second.id);assert.equal(first.type,'video/mp4');assert.equal(second.size,file.size);
  first.name='mutated';h.videos.remove(first.id);
  assert.equal(h.videos.get(first.id),null);assert.equal(h.videos.get(second.id),file);
  assert.equal((await h.videos.prepare(second.id,'squat')).selectedExerciseId,'squat');
  assert.equal(h.poseCalls[0].file,file);
});

test('file and metadata limits match motion analysis; persisted descriptors cannot become files',t=>{
  const h=setup(t);
  assert.throws(()=>h.videos.add(new File(['x'],'photo.png',{type:'image/png'})),/视频文件/);
  assert.throws(()=>h.videos.add({name:'big.mp4',type:'video/mp4',size:200*1024*1024+1,arrayBuffer(){}}),/200 MB/);
  assert.throws(()=>h.videos.add({name:'clip.mp4',type:'video/mp4',size:20}),/重新选择本地视频/);
  assert.throws(()=>h.videos.add(h.file(),{duration:121,width:640,height:480}),/120 秒/);
  assert.throws(()=>h.videos.add(h.file(),{duration:2,width:0,height:480}),/无法读取/);
});

test('each pose model owns its cache while different exercise choices reuse that model',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file());
  const standard=await h.videos.prepare(descriptor.id,'squat',{poseModel:'mediapipe-full'});
  const accurate=await h.videos.prepare(descriptor.id,'pushup',{poseModel:'mediapipe-heavy'});
  const quick=await h.videos.prepare(descriptor.id,'squat',{poseModel:'mediapipe-lite'});
  const standardAgain=await h.videos.prepare(descriptor.id,'curl',{poseModel:'mediapipe-full'});
  assert.equal(standard.poseData.format,'mediapipe-world17-full');
  assert.equal(standard.poseData.schemaVersion,6);assert.equal(standard.fullAnalysis.coordinateSpace,'mediapipe-world-3d');
  assert.equal(standard.fullAnalysis.version,'motion-observations-3d-v1');
  assert(standard.poseData.frames.some(frame=>frame.worldLandmarks.some(point=>point&&Math.abs(point[2])>.001)));
  assert.equal(accurate.poseData.format,'mediapipe-world17-full');
  assert.equal(quick.poseData.format,'mediapipe-world17-full');
  assert.equal(quick.poseData.retainedLandmarkIndices.length,17);
  assert.equal(accurate.selectedExerciseId,'pushup');assert.equal(standardAgain.selectedExerciseId,'curl');
  assert.deepEqual(standardAgain.poseData,standard.poseData);
  assert.deepEqual(h.poseCalls.map(call=>call.options.model),['mediapipe-full','mediapipe-heavy','mediapipe-lite']);
  assert.equal(accurate.poseData.modelVersion,getMotionPoseModel('mediapipe-heavy').version);
  assert.equal(quick.poseData.modelVersion,getMotionPoseModel('mediapipe-lite').version);
  assert.equal(h.imageCalls.length,3);
  await assert.rejects(h.videos.prepare(descriptor.id,'squat',{poseModel:'unknown'}),/骨架分析模型/);
});

test('concurrent selections for different models stay isolated and queued work is cancelled on removal',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file()),pose=deferred();h.poseQueue.push(pose);
  const first=h.videos.prepare(descriptor.id,'squat',{poseModel:'mediapipe-heavy'});
  const second=h.videos.prepare(descriptor.id,'pushup',{poseModel:'mediapipe-full'});
  const rejectFirst=assert.rejects(first,{name:'AbortError'}),rejectSecond=assert.rejects(second,{name:'AbortError'});
  await until(()=>h.poseCalls.length===1);h.videos.remove(descriptor.id);
  await Promise.all([rejectFirst,rejectSecond]);pose.resolve(pipeline());await flush();
  assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,0);
});

test('simultaneous different-model callers infer independently and receive their chosen format',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file());
  const [accurate,standard]=await Promise.all([
    h.videos.prepare(descriptor.id,'pushup',{poseModel:'mediapipe-heavy'}),
    h.videos.prepare(descriptor.id,'squat',{poseModel:'mediapipe-full'}),
  ]);
  assert.equal(accurate.poseData.format,'mediapipe-world17-full');assert.equal(standard.poseData.format,'mediapipe-world17-full');
  assert.equal(h.poseCalls.length,2);assert.equal(h.imageCalls.length,2);
});

test('missing local files and invalid action types fail before any model starts',async t=>{
  const h=setup(t);
  await assert.rejects(h.videos.prepare('local-video:missing','squat'),error=>error.code==='CHAT_MOTION_VIDEO_MISSING'&&/重新添加视频/.test(error.message));
  const descriptor=h.videos.add(h.file());
  await assert.rejects(h.videos.prepare(descriptor.id,'unknown-exercise'),/有效的动作类型/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(h.videos.prepare(descriptor.id,'squat',{signal:abort.signal}),{name:'AbortError'});
  assert.equal(h.poseCalls.length,0);
});

test('prepare reuses real transport across actions and retries without sharing mutable request data',async t=>{
  const h=setup(t),file=h.file(),descriptor=h.videos.add(file),updates=[];
  const first=await h.videos.prepare(descriptor.id,'squat',{onProgress:value=>updates.push(value)});
  assert.equal(first.reviewMode,'guided');assert.equal(first.selectedExerciseId,'squat');
  assert.equal(first.poseData.format,'mediapipe-world17-full');assert.equal(h.poseCalls[0].options.model,'mediapipe-full');
  validateMotionPoseData(first.poseData);validateFullMotionAnalysis(first.fullAnalysis);
  assert.equal(h.poseCalls[0].options.sampleFps,7.5);assert.equal(h.poseCalls[0].file,file);
  assert(!('previewFrames' in h.imageCalls[0].pipeline));
  assert.equal(first.keyframes[0].time,.001);assert.equal(first.poseData.frames[0].sourceTime,.001);
  assert(updates.every(value=>typeof value.message==='string'));assert.equal(h.released.length,1);
  first.keyframes[0].data='modified';first.poseData.frames[0].time=100;first.fullAnalysis.quality.reasons.push('mutation');
  const second=await h.videos.prepare(descriptor.id,'pushup',{onProgress:value=>updates.push(value)});
  assert.equal(second.selectedExerciseId,'pushup');assert.equal(second.keyframes[0].data,'AAAA');assert.equal(second.poseData.frames[0].time,0);
  assert(!second.fullAnalysis.quality.reasons.includes('mutation'));
  assert.equal(updates.at(-1).cached,true);assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,1);
  assert.equal(h.videos.get(descriptor.id),file,'A successful analysis does not consume the local file');
});

test('recognition prepares pose and images before an action is selected, then confirmation reuses them',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file());
  const recognition=await h.videos.prepare(descriptor.id,null);
  assert.equal(recognition.reviewMode,'recognize');assert.equal(recognition.selectedExerciseId,undefined);
  assert.equal(recognition.poseData.format,'mediapipe-world17-full');
  assert(recognition.poseData.frames.some(frame=>frame.worldLandmarks.some(point=>point&&point[2]!==0)));
  const assessment=await h.videos.prepare(descriptor.id,'pushup');
  assert.equal(assessment.reviewMode,'guided');assert.equal(assessment.selectedExerciseId,'pushup');
  assert.deepEqual(assessment.poseData,recognition.poseData);assert.deepEqual(assessment.keyframes,recognition.keyframes);
  assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,1);
});

test('concurrent same-video callers share inference but retain distinct action and cancellation',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file()),pose=deferred(),abort=new AbortController();h.poseQueue.push(pose);
  const first=h.videos.prepare(descriptor.id,'squat',{signal:abort.signal,onProgress:()=>{throw new Error('detached UI');}});
  const firstRejected=assert.rejects(first,{name:'AbortError'});
  const second=h.videos.prepare(descriptor.id,'pushup');
  await until(()=>h.poseCalls.length===1);abort.abort();await firstRejected;
  assert.equal(h.poseCalls[0].options.signal.aborted,false);
  pose.resolve(pipeline());const result=await second;
  assert.equal(result.selectedExerciseId,'pushup');assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,1);
});

test('cancelling all callers aborts the shared worker and a retry waits for late cleanup',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file()),pose=deferred(),abort=new AbortController();h.poseQueue.push(pose);
  const first=h.videos.prepare(descriptor.id,'squat',{signal:abort.signal});const rejected=assert.rejects(first,{name:'AbortError'});
  await until(()=>h.poseCalls.length===1);abort.abort();await rejected;
  assert.equal(h.poseCalls[0].options.signal.aborted,true);
  const retry=h.videos.prepare(descriptor.id,'squat');await flush();assert.equal(h.poseCalls.length,1);
  pose.resolve(pipeline());await retry;
  assert.equal(h.poseCalls.length,2);assert.equal(h.imageCalls.length,1,'Late cancelled poses never reach evidence');assert.equal(h.released.length,2);
});

test('evidence failure retains completed skeletons for a retry but no incomplete image result',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file()),images=deferred();h.imageQueue.push(images);
  const first=h.videos.prepare(descriptor.id,'squat');const rejected=assert.rejects(first,/decode failure/);
  await until(()=>h.imageCalls.length===1);images.reject(new Error('decode failure'));await rejected;
  const second=await h.videos.prepare(descriptor.id,'pushup');
  assert.equal(second.selectedExerciseId,'pushup');assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,2);assert.equal(h.released.length,2);
});

test('cancellation during evidence permits retry from completed skeletons',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file()),images=deferred(),abort=new AbortController();h.imageQueue.push(images);
  const first=h.videos.prepare(descriptor.id,'squat',{signal:abort.signal});const rejected=assert.rejects(first,{name:'AbortError'});
  await until(()=>h.imageCalls.length===1);abort.abort();await rejected;images.resolve(evidence());
  const result=await h.videos.prepare(descriptor.id,'pushup');
  assert.equal(result.selectedExerciseId,'pushup');assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,2);
});

test('removal rejects callers immediately and late success cannot resurrect a video',async t=>{
  const h=setup(t),descriptor=h.videos.add(h.file()),images=deferred();h.imageQueue.push(images);
  const first=h.videos.prepare(descriptor.id,'squat');const rejected=assert.rejects(first,{name:'AbortError'});
  await until(()=>h.imageCalls.length===1);h.videos.remove(descriptor.id);await rejected;
  assert.equal(h.imageCalls[0].options.signal.aborted,true);images.resolve(evidence());await flush();
  await assert.rejects(h.videos.prepare(descriptor.id,'squat'),{code:'CHAT_MOTION_VIDEO_MISSING'});
  assert.equal(h.videos.get(descriptor.id),null);assert.equal(h.released.length,2,'Release again after an abort-ignoring decoder finishes');
});

test('different videos serialize heavy workers and clear cancels queued work without starting it',async t=>{
  const h=setup(t),one=h.videos.add(h.file('one.mp4')),two=h.videos.add(h.file('two.mp4')),pose=deferred();h.poseQueue.push(pose);
  const first=h.videos.prepare(one.id,'squat'),second=h.videos.prepare(two.id,'pushup');
  const rejected1=assert.rejects(first,{name:'AbortError'}),rejected2=assert.rejects(second,{name:'AbortError'});
  await until(()=>h.poseCalls.length===1);await flush();assert.equal(h.poseCalls.length,1);
  h.videos.clear();await Promise.all([rejected1,rejected2]);pose.resolve(pipeline());await flush();
  assert.equal(h.poseCalls.length,1);assert.equal(h.imageCalls.length,0);
});
