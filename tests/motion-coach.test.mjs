import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData,buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {compactMotionAnalysis} from '../public/motion-contract.js';
import {validateMotionCoachRequest} from '../server/motion-coach.mjs';
import {reconcileTasks} from '../public/provider-ui.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const images=[{time:0.2,mimeType:'image/png',data:png},{time:0.8,mimeType:'image/png',data:png}];
const source=JSON.parse(await readFile(new URL('./fixtures/motion-squat-real.json',import.meta.url),'utf8'));
function request(){
 const frames=source.frames.slice(0,3).map(([time,points])=>{const landmarks=Array(33).fill(null);source.landmarkIndices.forEach((index,i)=>{const[x,y,visibility]=points[i];landmarks[index]={x,y,visibility};});return{time,landmarks,personCount:1};});
 const pipeline=toMediaPipePipeline({...source.options,duration:1.5,sourceFps:30,sampleFps:15,frames});
 const fullAnalysis=buildFullMotionAnalysis(analyzeMotion(pipeline.frames,pipeline),pipeline);
 return{duration:1.5,analysis:compactMotionAnalysis(fullAnalysis),fullAnalysis,poseData:buildMotionPoseData(pipeline),keyframes:images};
}
function output(){return {action:{exerciseId:'squat',name:'徒手深蹲',family:'squat',status:'identified',confidence:'high',evidenceTimes:[0.2,0.8],evidence:'训练者站立后屈髋屈膝下蹲，身体随后起身。'},verdict:{status:'needs-improvement',summary:'起身时请保持肩髋同步。'},feedback:[{title:'肩髋同步',status:'improve',source:'visual',evidenceTimes:[0.8],frameIndices:[],evidence:'起身时肩部与髋部移动不同步。',correction:'减轻负重，让肩部与髋部一起起身。'}],score:99,checks:[{status:'pass'}]};}
async function fixture(t,handler){
 const dir=await mkdtemp(join(tmpdir(),'motion-coach-')),calls=[];
 const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,fetchImpl:async(url,options)=>{const call={url,body:JSON.parse(options.body),signal:options.signal};calls.push(call);return handler?handler(call):Response.json({choices:[{message:{content:JSON.stringify(output())}}]});}});
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const api=async(path,{body,cookie,method,headers={},signal}={})=>{const response=await fetch(base+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),signal});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const register=name=>api('/api/auth/register',{body:{name,email:`${name}@example.test`,password:'motion-coach-password'}});
 const alice=await register('alice'),bob=await register('bob');
 const configure=(vision=true)=>api('/api/providers',{cookie:alice.cookie,method:'PUT',body:{providers:[{id:'coach',name:'Coach test',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',apiKey:'private-test-key',models:[{id:'review-model',vision}],model:'review-model'}],tasks:{motion:'coach'},taskModels:{motion:'review-model'}}});
 return{api,calls,alice,bob,configure};
}

test('motion HTTP route evaluates complete observations with account-scoped model and no score/rule response',async t=>{
 const f=await fixture(t);await f.configure();
 const result=await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:request()});
 assert.equal(result.status,200);assert.equal(result.body.model,'review-model');assert.equal(result.body.mode,'visual');
 assert.equal(result.body.action.name,'徒手深蹲');assert.equal(result.body.verdict.status,'needs-improvement');assert(result.body.feedback[0].correction);
 for(const key of ['score','checks','assessment','reps','qualified'])assert.equal(Object.hasOwn(result.body,key),false);
 assert.equal(f.calls.length,1,'A small full-data request finishes in one model call');
 const sent=f.calls[0].body;assert.equal(sent.messages[1].content.filter(item=>item.type==='image_url').length,2);
 assert(!/"(?:score|checks|qualified|reps)"\s*:/.test(JSON.stringify(sent)));assert(!JSON.stringify(result).includes('private-test-key'));
 const exported=await f.api('/api/export',{cookie:f.alice.cookie});assert.deepEqual(exported.body.attachments,[]);assert(!exported.body.records.some(r=>r.kind==='motion-assessment'));
 assert.equal((await f.api('/api/motion/coach',{cookie:f.bob.cookie,body:request()})).status,400);
 assert.equal((await f.api('/api/motion/coach',{cookie:f.alice.cookie,headers:{'X-Fitness-User':f.bob.body.user.id},body:request()})).status,409);
 assert.equal(f.calls.length,1);
});

test('text-only models are rejected before any skeleton or screenshot reaches the provider',async t=>{
 const f=await fixture(t);await f.configure(false);const result=await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:request()});
 assert.equal(result.status,400);assert.match(result.body.error,/视觉|图片/);
 assert.equal(f.calls.length,0);
});

test('request validation rejects scored legacy input, missing observations, malformed images and frame mismatches',async t=>{
 const f=await fixture(t);await f.configure();const base=request();
 const bad=[{duration:121},{poseData:null},{fullAnalysis:null},{fullAnalysis:{...base.fullAnalysis,score:100}},{keyframes:[]},{keyframes:null},{keyframes:Array(7).fill(images[0])},{keyframes:[{...images[0],time:4}]},{keyframes:[images[0],images[0]]},{keyframes:[{...images[0],mimeType:'image/svg+xml'}]},{keyframes:[{...images[0],data:'%%%'}]},{keyframes:[{...images[0],data:Buffer.from('not png').toString('base64')}]}];
 for(const patch of bad)assert.equal((await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:{...base,...patch}})).status,400);
 const shifted=structuredClone(base);shifted.fullAnalysis.measurements[1].time+=0.001;assert.throws(()=>validateMotionCoachRequest(shifted),/时间不一致/);
 assert.equal((await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:{duration:3,analysis:{score:100,checks:[]},keyframes:images}})).status,400);
 assert.equal((await f.api('/api/motion/coach',{body:base})).status,401);assert.equal(f.calls.length,0);
 const oversized=Buffer.alloc(420*1024);Buffer.from(png,'base64').copy(oversized);
 assert.equal((await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:{...base,keyframes:Array.from({length:5},(_,i)=>({time:i/4,mimeType:'image/png',data:oversized.toString('base64')}))}})).status,413);
});

test('bad model JSON becomes a bounded error and cancellation aborts the provider',async t=>{
 await t.test('bad JSON',async t=>{const f=await fixture(t,()=>Response.json({choices:[{message:{content:'not JSON'}}]}));await f.configure();const result=await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:request()});assert.equal(result.status,502);assert.match(result.body.error,/有效/);});
 await t.test('cancel',async t=>{
  let start,finish;const started=new Promise(r=>start=r),aborted=new Promise(r=>finish=r);
  const f=await fixture(t,call=>new Promise((_,reject)=>{start();call.signal.addEventListener('abort',()=>{finish();reject(call.signal.reason);},{once:true});}));await f.configure();
  const controller=new AbortController(),pending=f.api('/api/motion/coach',{cookie:f.alice.cookie,body:request(),signal:controller.signal});
  await started;controller.abort();await assert.rejects(pending,{name:'AbortError'});await aborted;assert.equal(f.calls.length,1);
 });
});

test('saving an existing provider assigns an unconfigured motion task to a visual model',async t=>{
  const f=await fixture(t);
  const provider={id:'existing',name:'Existing AI',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',models:[{id:'text-default',vision:false},{id:'vision-alternative',vision:true},{id:'next-default',vision:false}],model:'vision-alternative'};
  const tasks={chat:'existing',meal:'existing',planning:'existing'},taskModels={chat:'text-default',meal:'vision-alternative',planning:'text-default'};
  const initial=await f.api('/api/providers',{cookie:f.alice.cookie,method:'PUT',body:{providers:[provider],tasks,taskModels}});
  assert.equal(initial.status,200);
  let settings=(await f.api('/api/providers',{cookie:f.alice.cookie})).body;
  assert.equal(Object.hasOwn(settings.tasks,'motion'),false,'Reading old settings does not assign the new task');
  assert.equal(Object.hasOwn(settings.taskModels,'motion'),false);
  const editedProvider={...settings.providers[0],model:'text-default'};
  const selection=reconcileTasks([editedProvider],settings.tasks,settings.taskModels,editedProvider.id,{defaultTasks:['motion']});
  const saved=await f.api('/api/providers',{cookie:f.alice.cookie,method:'PUT',body:{version:settings.version,providers:[editedProvider],...selection}});
  assert.equal(saved.status,200);
  settings=(await f.api('/api/providers',{cookie:f.alice.cookie})).body;
  assert.equal(settings.tasks.motion,'existing');
  assert.equal(settings.taskModels.motion,'vision-alternative','A text default yields to an enabled visual model for motion');
  for(const task of Object.keys(tasks)) {
    assert.equal(settings.tasks[task],tasks[task]);assert.equal(settings.taskModels[task],taskModels[task]);
  }
  const result=await f.api('/api/motion/coach',{cookie:f.alice.cookie,body:request()});
  assert.equal(result.status,200);assert.equal(result.body.mode,'visual');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.model,'vision-alternative');
  assert.equal(f.calls[0].body.messages[1].content.filter(part=>part.type==='image_url').length,images.length);

  const explicit=await f.api('/api/providers',{cookie:f.alice.cookie,method:'PUT',body:{version:settings.version,providers:settings.providers,tasks:settings.tasks,taskModels:{...settings.taskModels,motion:'vision-alternative'}}});
  assert.equal(explicit.status,200);settings=explicit.body;
  const changedProvider={...settings.providers[0],model:'next-default'};
  const preserved=reconcileTasks([changedProvider],settings.tasks,settings.taskModels,changedProvider.id,{defaultTasks:['motion']});
  const changed=await f.api('/api/providers',{cookie:f.alice.cookie,method:'PUT',body:{version:settings.version,providers:[changedProvider],...preserved}});
  assert.equal(changed.status,200);assert.equal(changed.body.providers[0].model,'next-default');assert.equal(changed.body.taskModels.motion,'vision-alternative');
});
