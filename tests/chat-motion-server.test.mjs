import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.mjs';
import {readSse,streamChat} from '../server/chat-stream.mjs';
import {chatMotionTools} from '../server/chat-motion.mjs';
import {MOTION_POSE_MODEL} from '../public/motion-models.js';
import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData,buildFullMotionAnalysis} from '../public/motion-pose-data.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const localVideo=()=>({id:'local-video:'+randomUUID(),name:'训练.mp4',type:'video/mp4',size:1024});
function input() {
  const pipeline=toMediaPipePipeline({duration:1,width:640,height:480,sampleFps:15,sourceFps:30,frames:Array.from({length:8},(_,i)=>({time:i/15,personCount:1,landmarks:Array.from({length:33},(_,j)=>({x:.2+j/100,y:.2+j/90,visibility:.98}))}))});
  pipeline.modelVersion=MOTION_POSE_MODEL.version;
  for(const frame of pipeline.frames)frame.worldLandmarks.forEach((point,index)=>{if(point)point.z=Math.sin(index)*.12;});
  return {reviewMode:'guided',actionConfirmed:true,selectedExerciseId:'squat',duration:1,keyframes:[{time:.2,mimeType:'image/png',data:png}],poseData:buildMotionPoseData(pipeline),fullAnalysis:buildFullMotionAnalysis(analyzeMotion(pipeline.frames,pipeline),pipeline)};
}
const guidedReply=()=>({selectionCheck:{status:'consistent',imageIndices:[0],evidence:'目标训练者徒手屈髋屈膝。'},verdict:{status:'standard'},feedback:[{title:'足部支撑',status:'good',source:'visual',imageIndices:[0],evidence:'可见双脚接地支撑。',correction:'继续保持全脚掌支撑。'}]});
const toolCall=(videoId,exerciseId='squat')=>Response.json({choices:[{message:{content:'',tool_calls:[{id:'motion-call',type:'function',function:{name:'assess_motion_video',arguments:JSON.stringify({videoId,exerciseId})}}]},finish_reason:'tool_calls'}]});
const textReply=()=>Response.json({choices:[{message:{content:'评价已完成，可查看报告。'},finish_reason:'stop'}]});
async function fixture(t,{summaryFailure=false,...options}={}) {
  const dir=await mkdtemp(join(tmpdir(),'chat-motion-http-')),video=localVideo();let motionCalls=0,chatCalls=0,failedSummary=false;
  const requests=[];
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,...options,fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body);requests.push(body);
    if(body.model==='motion-model'){motionCalls++;return Response.json({choices:[{message:{content:JSON.stringify(guidedReply())},finish_reason:'stop'}]});}
    chatCalls++;
    if(body.messages.some(message=>message.role==='tool')) {
      if(summaryFailure&&!failedSummary){failedSummary=true;return Response.json({error:'summary failed'},{status:500});}
      return textReply();
    }
    if(body.messages[0].content.includes('当前请求已经完成的真实操作回执')){
      assert(!body.tools.some(tool=>tool.function.name==='assess_motion_video'));
      return textReply();
    }
    return body.tools?.some(tool=>tool.function.name==='assess_motion_video')?toolCall(video.id):textReply();
  }});
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(path,{body,cookie,method,headers={}}={})=>{
    const response=await fetch(base+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const register=name=>api('/api/auth/register',{body:{name,email:`${name}@example.test`,password:'fixture-password'}});
  const alice=await register('alice'),bob=await register('bob');
  const configured=await api('/api/providers',{cookie:alice.cookie,method:'PUT',body:{providers:[{id:'fixture',name:'Fixture',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',model:'chat-model',models:[{id:'chat-model',vision:false},{id:'motion-model',vision:true}]}],tasks:{chat:'fixture',motion:'fixture'},taskModels:{chat:'chat-model',motion:'motion-model'}}});
  assert.equal(configured.status,200);
  const body={task:'chat',stream:true,requestId:randomUUID(),messages:[{role:'user',content:'这段徒手深蹲标准吗？',motionVideos:[video]}]};
  const run=async(onEvent=()=>{},sent=body,signal)=>{
    const response=await fetch(base+'/api/ai',{method:'POST',headers:{'Content-Type':'application/json',cookie:alice.cookie},body:JSON.stringify(sent),signal});
    const events=[];
    for await(const event of readSse(response.body,signal)){const value={name:event.event,data:JSON.parse(event.data)};events.push(value);await onEvent(value);}
    return events;
  };
  return {api,run,body,video,alice,bob,requests,get motionCalls(){return motionCalls;},get chatCalls(){return chatCalls;}};
}

test('HTTP chat motion uses metadata-only tools, isolated ACK, one AI call and a synced persisted report',async t=>{
  const f=await fixture(t);let jobId;
  const events=await f.run(async event=>{
    if(event.name!=='motion_request')return;jobId=event.data.jobId;assert.equal(event.data.poseModel,'mediapipe-full');
    assert.equal(f.motionCalls,0);
    assert.equal((await f.api('/api/chat/motion/'+jobId,{cookie:f.bob.cookie,body:{input:input()}})).status,404);
    assert.equal((await f.api('/api/chat/motion/'+jobId,{cookie:f.alice.cookie,headers:{'X-Fitness-User':f.bob.body.user.id},body:{input:input()}})).status,409);
    assert.equal((await f.api('/api/chat/motion/'+jobId,{cookie:f.alice.cookie,body:{input:{...input(),actionConfirmed:false}}})).status,400);
    const ack=await f.api('/api/chat/motion/'+jobId,{cookie:f.alice.cookie,body:{input:input()}});
    assert.equal(ack.status,202);assert.deepEqual(Object.keys(ack.body).sort(),['accepted','jobId','ok']);
  });
  assert.equal(f.motionCalls,1);assert(events.some(e=>e.name==='motion_progress'));
  const tool=events.find(e=>e.name==='tool_result'&&e.data.name==='assess_motion_video').data;
  assert.equal(tool.ok,true);assert.match(tool.reportId,/^motion:/);assert.equal(tool.record.id,tool.reportId);assert.equal(tool.record.kind,'motion-assessment');
  assert.equal(tool.verdict.status,'standard');assert.equal(tool.verdict.summary,'暂时找不出问题。');assert.deepEqual(tool.feedback,[]);assert.equal(events.at(-1).name,'done');
  assert.equal(tool.record.data.analysis.coordinateSpace,'mediapipe-world-3d');
  const motionRequest=f.requests.find(request=>request.model==='motion-model');
  const motionContext=JSON.parse(motionRequest.messages.find(message=>message.role==='user').content[0].text);
  assert.equal(motionContext.evidence.poseSchema.measurementCoordinateSpace,'mediapipe-world-3d');
  assert.deepEqual(motionContext.evidence.poseSchema.worldPointFields,['x','y','z','visibility']);
  assert(motionContext.evidence.frames.some(frame=>frame.worldLandmarks.some(point=>point&&Math.abs(point[2])>.001)));
  const exported=(await f.api('/api/export',{cookie:f.alice.cookie})).body;
  assert.equal(exported.records.filter(r=>r.kind==='motion-assessment').length,1);assert.deepEqual(exported.attachments,[]);
  assert(!JSON.stringify(exported.records).includes(png));assert(!JSON.stringify(exported.records).includes('landmarks'));
  assert.match(f.requests[0].messages[0].content,/messageIndex|userText|杠铃硬拉/);
  assert(!JSON.stringify(f.requests[0]).includes(png));
  assert.equal((await f.api('/api/chat/motion/'+jobId,{cookie:f.alice.cookie,body:{input:input()}})).status,404);
  const replay=await f.run(()=>assert.equal(f.motionCalls,1));
  assert.equal(replay.filter(e=>e.name==='motion_request').length,0);
  assert.equal(replay.find(e=>e.name==='tool_result'&&e.data.name==='assess_motion_video').data.reportId,tool.reportId);
});

test('a failed chat summary preserves the completed assessment receipt and regeneration never pays again',async t=>{
  const f=await fixture(t,{summaryFailure:true});
  const events=await f.run(async event=>{if(event.name==='motion_request')await f.api('/api/chat/motion/'+event.data.jobId,{cookie:f.alice.cookie,body:{input:input()}});});
  const result=events.find(event=>event.name==='tool_result'&&event.data.ok).data;
  assert(events.some(event=>event.name==='error'));assert.equal(f.motionCalls,1);
  const retried=await f.run();assert.equal(f.motionCalls,1);assert.equal(retried.at(-1).name,'done');
  assert.equal(retried.find(event=>event.name==='tool_result').data.reportId,result.reportId);
  assert.equal((await f.api('/api/export',{cookie:f.alice.cookie})).body.records.filter(r=>r.kind==='motion-assessment').length,1);
});

test('invalid message lists return 400, and chats without local videos never expose the assessment tool',async t=>{
  const f=await fixture(t);
  for(const messages of [null,{}]) assert.equal((await f.api('/api/ai',{cookie:f.alice.cookie,body:{...f.body,messages}})).status,400);
  const events=await f.run(()=>{}, {...f.body,messages:[{role:'user',content:'你好'}]});
  assert.equal(events.at(-1).name,'done');assert.equal(f.motionCalls,0);
  assert(!f.requests.at(-1).tools.some(tool=>tool.function.name==='assess_motion_video'));
});

test('chat tool timeout cancels local waiting instead of leaving an orphan job',async t=>{
  const f=await fixture(t,{chatMotionTimeoutMs:75});let jobId;
  const events=await f.run(event=>{if(event.name==='motion_request')jobId=event.data.jobId;});
  assert(jobId);assert(events.some(event=>event.name==='error'));assert.equal(f.motionCalls,0);
  assert.equal((await f.api('/api/chat/motion/'+jobId,{cookie:f.alice.cookie,body:{input:input()}})).status,404);
});

test('native motion tool continuation supports all chat protocols and passes the bounded abort signal',async()=>{
  const video=localVideo(),record={id:'motion:fixture',kind:'motion-assessment',data:{coach:{verdict:{status:'uncertain'},limitations:['internal-motion-report-only']}},version:1};
  for(const protocol of ['openai','anthropic','gemini']) {
    let calls=0,executions=0;const events=[];
    const result=await streamChat({provider:{protocol,baseUrl:'http://127.0.0.1:9/v1',model:'fixture'},messages:[{role:'system',content:'fixture'},{role:'user',content:'评估徒手深蹲'}],tools:chatMotionTools([video]),onEvent:(name,data)=>events.push({name,data}),
      executeTool:async(name,args,{signal})=>{assert.equal(name,'assess_motion_video');assert(signal instanceof AbortSignal);assert.equal(args.exerciseId,'squat');executions++;return {ok:true,readOnly:true,reportId:record.id,record,records:[record],verdict:{status:'uncertain',summary:'暂时找不出问题。'},feedback:[],message:'报告已保存'};},
      fetchImpl:async(_url,options)=>{
        const body=JSON.parse(options.body);
        if(++calls===1){
          if(protocol==='anthropic')return Response.json({content:[{type:'tool_use',id:'call',name:'assess_motion_video',input:{videoId:video.id,exerciseId:'squat'}}],stop_reason:'tool_use'});
          if(protocol==='gemini')return Response.json({candidates:[{content:{parts:[{functionCall:{name:'assess_motion_video',args:{videoId:video.id,exerciseId:'squat'}}}]},finishReason:'STOP'}]});
          return toolCall(video.id);
        }
        assert.match(JSON.stringify(body),/motion:fixture/);
        assert.match(JSON.stringify(body),/暂时找不出问题/);assert.doesNotMatch(JSON.stringify(body),/internal-motion-report-only/);
        const receipt=protocol==='anthropic'?JSON.parse(body.messages.at(-1).content[0].content):protocol==='gemini'?body.contents.at(-1).parts[0].functionResponse.response:JSON.parse(body.messages.at(-1).content);
        assert.equal('record' in receipt,false);assert.equal('records' in receipt,false);
        if(protocol==='anthropic')return Response.json({content:[{type:'text',text:'已完成'}],stop_reason:'end_turn'});
        if(protocol==='gemini')return Response.json({candidates:[{content:{parts:[{text:'已完成'}]},finishReason:'STOP'}]});
        return textReply();
      }});
    assert.equal(executions,1);assert.deepEqual(result.toolResults[0].record,record);assert.deepEqual(result.toolResults[0].records,[record]);assert(events.some(e=>e.name==='tool_start'));
    const emitted=events.find(e=>e.name==='tool_result').data;assert.deepEqual(emitted.record,record);assert.deepEqual(emitted.records,[record]);
  }
});

test('unsupported tools explicitly report that the video was not assessed and receive no invented frame context',async()=>{
  let calls=0;const events=[];
  await streamChat({provider:{baseUrl:'http://127.0.0.1:9/v1',model:'fixture'},messages:[{role:'system',content:'fixture'},{role:'user',content:'评估徒手深蹲'}],tools:chatMotionTools([localVideo()]),onEvent:(name,data)=>events.push({name,data}),fetchImpl:async(_url,options)=>{
    if(++calls===1)return Response.json({error:'tools unsupported'},{status:400});
    assert.match(JSON.parse(options.body).messages[0].content,/本轮未完成视频动作评估/);return textReply();
  }});
  assert.match(events.find(e=>e.name==='tool_result').data.message,/视频动作评估也未完成/);
});


test('replayed motion receipts omit stored reports only from model context across all protocols',async()=>{
  const record={id:'motion:replay',kind:'motion-assessment',data:{coach:{limitations:['internal-motion-report-only']}}};
  const motion={name:'assess_motion_video',ok:true,readOnly:true,reportId:record.id,record,records:[record],verdict:{status:'uncertain',summary:'暂时找不出问题。'},feedback:[]};
  const other={name:'get_training_plan',ok:true,record:{id:'other-record-kept',data:{note:'other-receipt-details'}}};
  for(const protocol of ['openai','anthropic','gemini'])for(const receipt of [motion,[motion,other]]){
    const events=[];let requests=0;
    const result=await streamChat({provider:{protocol,baseUrl:'http://127.0.0.1:9/v1',model:'fixture'},messages:[{role:'system',content:'fixture'},{role:'user',content:'继续上次评价'}],tools:chatMotionTools([localVideo()]),receipt,onEvent:(name,data)=>events.push({name,data}),executeTool:async()=>assert.fail('A replay must not repeat the assessment'),fetchImpl:async(_url,options)=>{
      requests++;const body=JSON.parse(options.body),context=JSON.stringify(body);
      assert.match(context,/motion:replay/);assert.match(context,/暂时找不出问题/);assert.doesNotMatch(context,/internal-motion-report-only/);
      if(Array.isArray(receipt))assert.match(context,/other-receipt-details/);
      if(protocol==='anthropic')return Response.json({content:[{type:'text',text:'暂时找不出问题。'}],stop_reason:'end_turn'});
      if(protocol==='gemini')return Response.json({candidates:[{content:{parts:[{text:'暂时找不出问题。'}]},finishReason:'STOP'}]});
      return textReply();
    }});
    assert.equal(requests,1);assert.deepEqual(result.toolResults[0].record,record);assert.deepEqual(result.toolResults[0].records,[record]);
    const visible=events.find(event=>event.name==='tool_result').data;assert.deepEqual(visible.record,record);assert.deepEqual(visible.records,[record]);
  }
});
