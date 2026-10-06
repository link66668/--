import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../server.mjs';
import {longMotionReport} from './helpers/motion-long-report.mjs';
import {validateMotionAssessmentSize,MAX_MOTION_ASSESSMENT_BYTES} from '../public/motion-view.js';

test('pose resources use executable MIME and constrained worker/WASM policy; reports stay account-scoped',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'fitness-motion-'));
 const server=await startServer({host:'127.0.0.1',port:0,dataDir});
 t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(dataDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const [path,type]of [...['lite','full','heavy'].map(tier=>[`/vendor/mediapipe/pose_landmarker_${tier}.task`,'application/octet-stream']),['/motion-models.js','text/javascript; charset=utf-8'],['/vendor/mediapipe/wasm/vision_wasm_internal.wasm','application/wasm'],['/motion-mediapipe.js','text/javascript; charset=utf-8'],['/motion-worker.js','text/javascript; charset=utf-8'],['/motion-decode.js','text/javascript; charset=utf-8'],['/vendor/mp4box/mp4box.all.mjs','text/javascript; charset=utf-8'],['/motion-media.js','text/javascript; charset=utf-8'],['/motion-source.js','text/javascript; charset=utf-8'],['/motion-source-worker.js','text/javascript; charset=utf-8'],['/motion-software-decode.js','text/javascript; charset=utf-8'],['/motion-frame-player.js','text/javascript; charset=utf-8'],['/vendor/ffmpeg/ffmpeg-core.js','text/javascript; charset=utf-8'],['/vendor/ffmpeg/ffmpeg-core.wasm','application/wasm']]){
  const response=await fetch(base+path,{method:'HEAD'});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),type);
  const policy=response.headers.get('content-security-policy');assert(policy.includes("'wasm-unsafe-eval'"));assert(!policy.includes("'unsafe-eval'"));assert(policy.includes("worker-src 'self'"));assert(policy.includes("media-src 'self' blob:"));
 }
 const api=async(path,data,cookie)=>{const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const alice=await api('/api/auth/register',{name:'Alice',email:'motion-alice@example.test',password:'motion-test-password'});
 const bob=await api('/api/auth/register',{name:'Bob',email:'motion-bob@example.test',password:'motion-test-password'});
 const report={version:'motion-rules-1.0.0',createdAt:new Date().toISOString(),exerciseId:'squat',status:'complete',score:78,reps:[{index:1,start:0,bottom:1,end:2,score:78}],summary:'本机姿态规则评估'};
 const change={id:'motion:sample',kind:'motion-assessment',baseVersion:0,data:report};
 const saved=await api('/api/sync',{userId:alice.body.user.id,changes:[change]},alice.cookie);assert.equal(saved.status,200);assert.deepEqual(saved.body.records.find(r=>r.id===change.id).data,report);
 const other=await api('/api/state',null,bob.cookie);assert(!other.body.records.some(r=>r.kind==='motion-assessment'));
 assert(!saved.body.records.some(r=>['calendar-task','schedule'].includes(r.kind)),'Saving an assessment cannot complete a training');
 const deleted=await api('/api/sync',{userId:alice.body.user.id,changes:[{...change,baseVersion:1,deleted:true,data:null}]},alice.cookie);assert.equal(deleted.status,200);assert.equal(deleted.body.records.find(r=>r.id===change.id).data,null);
});


test('AI-only reports save concise conclusions without local measurements or legacy rule results',async t=>{
 const {analysis,report}=longMotionReport();
 assert(analysis.measurements.length>1000);
 for(const key of ['score','checks','reps','qualified','measurements','poseData'])assert.equal(Object.hasOwn(report,key),false);
 assert(report.coach.verdict);assert(report.coach.feedback.length>0);
 assert.ok(Buffer.byteLength(JSON.stringify(report))<32*1024);
 assert.doesNotThrow(()=>validateMotionAssessmentSize(report));
 const dataDir=await mkdtemp(join(tmpdir(),'fitness-motion-long-')),server=await startServer({host:'127.0.0.1',port:0,dataDir});
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(dataDir,{recursive:true,force:true});});
 const root=`http://127.0.0.1:${server.address().port}`;
 const registration=await fetch(root+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Long motion',email:'long-motion@example.test',password:'motion-long-password'})});
 const cookie=registration.headers.get('set-cookie').split(';')[0],user=(await registration.json()).user;
 const sync=async(kind,id,data)=>{const response=await fetch(root+'/api/sync',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({userId:user.id,changes:[{id,kind,baseVersion:0,data}]})});return {status:response.status,body:await response.json()};};
 const saved=await sync('motion-assessment','motion:long-report',report);assert.equal(saved.status,200);assert.deepEqual(saved.body.records.find(record=>record.id==='motion:long-report').data,report);
 const response=await fetch(root+'/api/state',{headers:{cookie}}),state=await response.json();assert.deepEqual(state.records.find(record=>record.id==='motion:long-report').data,report);
 const tooLarge={...report,extra:'a'.repeat(MAX_MOTION_ASSESSMENT_BYTES)};assert.throws(()=>validateMotionAssessmentSize(tooLarge),/1 MB/);
 const rejected=await sync('motion-assessment','motion:too-big',tooLarge);assert.equal(rejected.status,413);assert.match(rejected.body.error,/1 MB/);
 assert.equal((await sync('note','ordinary-too-big',{text:'a'.repeat(270000)})).status,413,'Ordinary records retain the 256 KiB limit');
 assert.equal((await sync('conversation','conversation-larger',{text:'a'.repeat(300000)})).status,200,'Conversation records retain their larger allowance');
 assert.equal((await sync('conversation','conversation-too-big',{text:'a'.repeat(2*1024*1024)})).status,413);
 const latest=await(await fetch(root+'/api/state',{headers:{cookie}})).json();assert.ok(!latest.records.some(record=>record.id==='motion:too-big'));assert.deepEqual(latest.records.find(record=>record.id==='motion:long-report').data,report);
});
