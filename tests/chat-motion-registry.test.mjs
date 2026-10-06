import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {getMotionPoseModel} from '../public/motion-models.js';
import {chatMotionVideos,chatMotionTools,chatMotionNotice,createChatMotionRegistry} from '../server/chat-motion.mjs';
import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData,buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {sanitizeMotionCoachResponse} from '../public/motion-contract.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const video=()=>({id:'local-video:'+randomUUID(),name:'squat.mp4',type:'video/mp4',size:1024});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function motionInput(poseModel='mediapipe-full',exerciseId='squat') {
  const pipeline=toMediaPipePipeline({duration:1,width:640,height:480,sampleFps:15,sourceFps:30,frames:Array.from({length:8},(_,i)=>({time:i/15,personCount:1,landmarks:Array.from({length:33},(_,j)=>({x:.2+j/100,y:.2+j/90,visibility:.98}))}))});
  pipeline.modelVersion=getMotionPoseModel(poseModel).version;
  return {reviewMode:'guided',actionConfirmed:true,selectedExerciseId:exerciseId,duration:1,keyframes:[{time:.2,mimeType:'image/png',data:png},{time:.4,mimeType:'image/png',data:png}],
    poseData:buildMotionPoseData(pipeline),fullAnalysis:buildFullMotionAnalysis(analyzeMotion(pipeline.frames,pipeline),pipeline)};
}
function coach(input) {
  return {...sanitizeMotionCoachResponse({selectionCheck:{status:'consistent',imageIndices:[0],evidence:'测试训练者动作。'}},{mode:'guided',selectedExerciseId:input.selectedExerciseId,keyframes:input.keyframes}),
    feedback:[{title:'足部支撑',status:'good',source:'visual',evidenceTimes:[.2,.4],evidence:'可见双脚保持接地支撑。',correction:'保持全脚掌支撑。'}],verdict:{status:'standard'},
    coverage:{complete:true,strategy:'guided-evidence',sourceFrameCount:8,frameCount:8,reviewedFrameCount:8,imageCount:2,reviewedImageCount:2}};
}
function fixture(t,options={}) {
  const db=new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'),('bob'); CREATE TABLE records(user_id TEXT,id TEXT,kind TEXT,data TEXT,version INTEGER,deleted INTEGER,updated_at TEXT,PRIMARY KEY(user_id,id));");
  const registry=createChatMotionRegistry({db,...options}),videos=[video()],controller=new AbortController();
  t.after(()=>{registry.close();db.close();});
  const base={userId:'alice',requestId:randomUUID(),videos,args:{videoId:videos[0].id,exerciseId:'squat'},signal:controller.signal,assess:async input=>coach(input)};
  return {db,registry,base,controller};
}

test('local video directories include upload context and bound recent history without rejecting it',()=>{
  const videos=Array.from({length:25},video),messages=videos.map((value,index)=>({role:'user',content:`这是第${index}段动作`,motionVideos:[value]}));
  const actual=chatMotionVideos(messages);
  assert.equal(actual.length,20);assert.equal(actual[0].messageIndex,5);assert.equal(actual.at(-1).userText,'这是第24段动作');
  assert.match(chatMotionNotice(actual),/最近20个/);assert.match(chatMotionNotice(actual),/用户会在界面中确认或修改/);
  assert.equal(chatMotionTools(actual)[0].function.name,'assess_motion_video');assert.deepEqual(chatMotionTools([]),[]);
  assert.equal(chatMotionVideos(messages.slice(0,7)).length,7);
  for(const message of [
    {role:'assistant',motionVideos:[videos[0]]},
    {role:'user',motionVideos:[{...videos[0],data:'raw bytes'}]},
    {role:'user',motionVideos:[{...videos[0],id:'attachment-id'}]},
    {role:'user',motionVideos:[{...videos[0],size:201*1024*1024}]},
    {role:'user',attachments:Array(6).fill({id:'image'}),motionVideos:[videos[0]]},
  ]) assert.throws(()=>chatMotionVideos([message]),error=>error.status===400);
  assert.throws(()=>chatMotionVideos([{role:'user',motionVideos:[videos[0],{...videos[0],size:2}]}]),/不一致/);
});

test('registry verifies ownership and selection, ACKs once, persists only report and replays without another model call',async t=>{
  const f=fixture(t),announced=deferred(),finish=deferred();let calls=0;
  const promise=f.registry.execute({...f.base,onEvent:(name,data)=>{if(name==='motion_request')announced.resolve(data);},assess:async(input,{onProgress})=>{calls++;await onProgress({stage:'processing',message:'正在评价'});await finish.promise;return coach(input);}});
  const job=await announced.promise;
  assert.equal(calls,0);assert.equal(f.registry.size,1);
  assert.throws(()=>f.registry.submit({userId:'bob',jobId:job.jobId,body:{input:motionInput()}}),error=>error.status===404);
  assert.throws(()=>f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:{...motionInput(),actionConfirmed:false}}}),error=>error.status===400);
  const ack=f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:motionInput()}});
  assert.equal(ack.accepted,true);
  assert.throws(()=>f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:motionInput()}}),error=>error.status===409);
  const concurrent=await f.registry.execute({...f.base,onEvent:()=>assert.fail('must not create duplicate job')});
  assert.equal(concurrent.code,'MOTION_ALREADY_STARTED');
  finish.resolve();const result=await promise;
  assert.equal(calls,1);assert.equal(result.ok,true);assert.match(result.reportId,/^motion:/);assert.equal(result.record.kind,'motion-assessment');
  const stored=JSON.stringify(f.db.prepare('SELECT * FROM records').all());
  assert(!stored.includes(png));assert(!stored.includes('landmarks'));assert.equal(f.registry.size,0);
  const replay=await f.registry.execute({...f.base,onEvent:()=>assert.fail('no new request'),assess:()=>assert.fail('no new model')});
  assert.equal(replay.replayed,true);assert.equal(replay.reportId,result.reportId);
  assert.equal(f.registry.receipts({userId:'bob',requestId:f.base.requestId,videos:f.base.videos}).length,0);
  const restarted=createChatMotionRegistry({db:f.db});
  assert.equal(restarted.receipts({userId:'alice',requestId:f.base.requestId,videos:f.base.videos})[0].reportId,result.reportId);restarted.close();
  f.db.prepare('UPDATE records SET deleted=1 WHERE id=?').run(result.reportId);
  assert.equal((await f.registry.execute({...f.base})).code,'MOTION_REPORT_UNAVAILABLE');
});

test('local failure, timeout and cancellation clean up and allow the same request to retry before AI starts',async t=>{
  for(const mode of ['client','timeout','cancel']) {
    const f=fixture(t,{waitMs:20}),seen=deferred();
    const pending=f.registry.execute({...f.base,onEvent:(name,data)=>{if(name==='motion_request')seen.resolve(data);},assess:()=>assert.fail('no AI before valid input')});
    const job=await seen.promise;
    if(mode==='client')f.registry.submit({userId:'alice',jobId:job.jobId,body:{error:'视频解码失败'}});
    if(mode==='cancel')f.controller.abort(new DOMException('cancelled','AbortError'));
    if(mode==='timeout')await new Promise(resolve=>setTimeout(resolve,35));
    if(mode==='cancel')await assert.rejects(pending,{name:'AbortError'});else assert.equal((await pending).ok,false);
    assert.equal(f.registry.size,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_chat_motion_operations').get().n,0);
    assert.throws(()=>f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:motionInput()}}),error=>error.status===404);
    const retry=await f.registry.execute({...f.base,signal:new AbortController().signal,onEvent:(name,data)=>{if(name==='motion_request')f.registry.submit({userId:'alice',jobId:data.jobId,body:{input:motionInput()}});}});
    assert.equal(retry.ok,true);
  }
});

test('cancellation during the model attempt propagates and a retry cannot repeat the paid stage',async t=>{
  const f=fixture(t),started=deferred();let calls=0;
  const pending=f.registry.execute({...f.base,onEvent:(name,data)=>{if(name==='motion_request')f.registry.submit({userId:'alice',jobId:data.jobId,body:{input:motionInput()}});},assess:async(_input,{signal})=>{
    calls++;started.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  await started.promise;f.controller.abort(new DOMException('cancelled','AbortError'));await assert.rejects(pending,{name:'AbortError'});
  const retry=await f.registry.execute({...f.base,signal:new AbortController().signal,onEvent:()=>assert.fail('must replay'),assess:()=>assert.fail('must not pay again')});
  assert.equal(retry.code,'MOTION_CANCELLED');assert.equal(retry.replayed,true);assert.equal(calls,1);assert.equal(f.registry.size,0);
});

test('registry concurrency limits and server instances cannot consume each other jobs',async t=>{
  const a=fixture(t,{maxUserJobs:1}),b=fixture(t),seen=deferred();
  const pending=a.registry.execute({...a.base,onEvent:(name,data)=>{if(name==='motion_request')seen.resolve(data);}}),job=await seen.promise;
  const crowded=await a.registry.execute({...a.base,requestId:randomUUID(),onEvent:()=>assert.fail('over limit')});
  assert.equal(crowded.code,'MOTION_BUSY');
  assert.throws(()=>b.registry.submit({userId:'alice',jobId:job.jobId,body:{input:motionInput()}}),error=>error.status===404);
  a.registry.submit({userId:'alice',jobId:job.jobId,body:{error:'取消本地分析'}});await pending;
});

test('tool exposes action and pose model choices and rejects unsupported models before dispatch',async t=>{
  const f=fixture(t),schema=chatMotionTools(f.base.videos)[0].function.parameters;
  assert(schema.required.includes('poseModel'));assert(!schema.required.includes('exerciseId'));
  assert.deepEqual(schema.properties.poseModel.enum,['mediapipe-lite','mediapipe-full','mediapipe-heavy']);
  for(const id of ['squat','pushup','curl'])assert(schema.properties.exerciseId.enum.includes(id));
  assert.match(chatMotionNotice(f.base.videos),/标准\/MediaPipe Full=mediapipe-full/);
  assert.match(chatMotionNotice(f.base.videos),/高精度\/MediaPipe Heavy=mediapipe-heavy/);
  for(const poseModel of ['full',null,42]){
    const result=await f.registry.execute({...f.base,args:{...f.base.args,poseModel},onEvent:()=>assert.fail('invalid selection must not start a job')});
    assert.equal(result.code,'INVALID_ARGUMENTS');
  }
});

test('automatic recognition jobs require a confirmed catalog action and accept the user correction',async t=>{
  const f=fixture(t),seen=deferred();let calls=0;
  const args={videoId:f.base.videos[0].id,poseModel:'mediapipe-full'};
  const pending=f.registry.execute({...f.base,args,onEvent:(name,data)=>{if(name==='motion_request')seen.resolve(data);},assess:async input=>{
    calls++;assert.equal(input.selectedExerciseId,'pushup');return coach(input);
  }});
  const job=await seen.promise;
  assert.equal(calls,0);
  const input=motionInput('mediapipe-full','pushup');
  assert.throws(()=>f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:{...input,actionConfirmed:undefined}}}),/尚未确认/);
  assert.equal(calls,0);
  assert.throws(()=>f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:{...input,actionConfirmed:true,selectedExerciseId:'not-in-catalog'}}}),/有效的动作类型/);
  f.registry.submit({userId:'alice',jobId:job.jobId,body:{input:{...input,actionConfirmed:true}}});
  const result=await pending;
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.record.data.exerciseId,'pushup');
  assert.equal(result.verdict.summary,'暂时找不出问题。');assert.deepEqual(result.feedback,[]);assert.equal(result.selectionCheck,undefined);
  const replay=await f.registry.execute({...f.base,args,onEvent:()=>assert.fail('no repeat confirmation'),assess:()=>assert.fail('no repeat model')});
  assert.equal(replay.reportId,result.reportId);
  const changedHint=await f.registry.execute({...f.base,args:{...args,exerciseId:'squat'},onEvent:()=>assert.fail('changed model hint cannot repeat confirmation'),assess:()=>assert.fail('changed hint cannot repeat model')});
  assert.equal(changedHint.reportId,result.reportId);assert.equal(calls,1);
});

test('user confirmation can correct a chat-supplied action before assessment',async t=>{
  const f=fixture(t);
  const result=await f.registry.execute({...f.base,assess:async input=>{assert.equal(input.selectedExerciseId,'pushup');return coach(input);},
    onEvent:(name,data)=>{if(name==='motion_request')f.registry.submit({userId:'alice',jobId:data.jobId,body:{input:{...motionInput('mediapipe-full','pushup'),actionConfirmed:true}}});}});
  assert.equal(result.ok,true);assert.equal(result.record.data.coach.action.exerciseId,'pushup');
});

test('pose model selections reach the client, reject mismatched evidence, and own distinct retry receipts',async t=>{
  const f=fixture(t),reports=[];let calls=0;
  for(const [poseModel,exerciseId] of [['mediapipe-heavy','squat'],['mediapipe-full','squat'],['mediapipe-lite','squat']]){
    const args={...f.base.args,poseModel,exerciseId};
    const result=await f.registry.execute({...f.base,args,assess:async input=>{calls++;assert.equal(input.selectedExerciseId,exerciseId);assert.equal(input.poseData.modelVersion,getMotionPoseModel(poseModel).version);return coach(input);},onEvent:(name,data)=>{
      if(name!=='motion_request')return;
      assert.equal(data.poseModel,poseModel);assert.equal(data.exerciseId,exerciseId);
      const submit=input=>f.registry.submit({userId:'alice',jobId:data.jobId,body:{input}});
      for(const otherModel of ['mediapipe-lite','mediapipe-full','mediapipe-heavy'].filter(id=>id!==poseModel))
        assert.throws(()=>submit(motionInput(otherModel,exerciseId)),/骨架模型不一致/);
      assert.throws(()=>submit({...motionInput(poseModel,exerciseId),actionConfirmed:false}),/尚未确认/);
      submit(motionInput(poseModel,exerciseId));
    }});
    assert.equal(result.ok,true);assert.equal(result.poseModel,poseModel);
    assert.equal(result.record.data.analysis.modelVersion,getMotionPoseModel(poseModel).version);
    if(poseModel==='mediapipe-full'){
      assert.equal(result.record.data.analysis.coordinateSpace,'mediapipe-world-3d');
    }
    assert.equal(result.record.data.coach.action.exerciseId,exerciseId);reports.push(result.reportId);
    const replay=await f.registry.execute({...f.base,args,onEvent:()=>assert.fail('replay must not re-analyze')});
    assert.equal(replay.reportId,result.reportId);assert.equal(replay.poseModel,poseModel);
  }
  assert.equal(calls,3);assert.equal(new Set(reports).size,3);
  assert.equal(f.registry.receipts({userId:'alice',requestId:f.base.requestId,videos:f.base.videos}).length,3);
});

test('unsupported model IDs do not start work or get remapped to a new tier',async t=>{
  const f=fixture(t);
  for(const poseModel of ['rtmw','yolo26','unknown']){
    const result=await f.registry.execute({...f.base,args:{...f.base.args,poseModel},onEvent:()=>assert.fail('unsupported model must not start work')});
    assert.equal(result.code,'INVALID_ARGUMENTS');
  }
  assert.equal(f.registry.size,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_chat_motion_operations').get().n,0);
});
