// Real MediaPipe Lite/Full/Heavy 3D pixels and the shared decoder paths; local mock visual AI.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startServer} from '../server.mjs';
import {validateMotionCoachRequest} from '../server/motion-coach.mjs';
const root=resolve(import.meta.dirname,'..');
await mkdir(join(root,'.qa'),{recursive:true});
const dataDir=await mkdtemp(join(root,'.qa/motion-mediapipe-'));
const clip=join(dataDir,'squat.mp4');
await promisify(execFile)(process.env.QA_FFMPEG||join(root,'.qa/motion-fixtures/qa-codecs/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe'),['-hide_banner','-loglevel','error','-nostdin','-i',join(root,'.qa/motion-fixtures/squat.mp4'),'-t','1','-an','-vf','scale=480:-2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',clip],{windowsHide:true});
const {chromium}=await import(pathToFileURL(process.env.QA_PLAYWRIGHT||join(root,'.qa/browser-tools/node_modules/playwright/index.mjs')));
const calls=[];
const confirmationOnly=process.env.QA_CONFIRMATION_ONLY==='1';
const tiers=['mediapipe-lite','mediapipe-full','mediapipe-heavy'];
const tierCases=tiers.map(model=>({scenario:model,model,decoder:'webcodecs',ui:model==='mediapipe-full'}));
const cases=confirmationOnly?[tierCases[1]]:process.env.QA_TIERS_ONLY==='1'?tierCases:[...tierCases,{scenario:'full-html-video',model:'mediapipe-full',decoder:'html-video'},{scenario:'full-ffmpeg-direct',model:'mediapipe-full',decoder:'ffmpeg-direct'},{scenario:'full-webcodecs-auto',model:'mediapipe-full',decoder:'webcodecs',automatic:true}];
let recognitionCount=0;
const worldFields=['x','y','z','visibility'];
function assertWorldContext(input){
 assert.deepEqual(input.evidence.poseSchema.worldPointFields,worldFields);
 const points=input.evidence.frames.flatMap(frame=>frame.worldLandmarks||[]).filter(Boolean);
 assert(points.length>0);assert(points.every(point=>point.length===4));assert(points.some(point=>Math.abs(point[2])>.001));
 return {worldPointFields:input.evidence.poseSchema.worldPointFields,measurementCoordinateSpace:input.evidence.poseSchema.measurementCoordinateSpace,
  worldPointCount:points.length,firstWorldTuple:points[0],zRange:[Math.min(...points.map(point=>point[2])),Math.max(...points.map(point=>point[2]))]};
}
function assertWorldAngle(body){
 for(const row of body.fullAnalysis.measurements){
  for(const [side,indices] of [['left',[23,25,27]],['right',[24,26,28]]]){
   if(!Number.isFinite(row[side].kneeAngle))continue;
   const [a,b,c]=indices.map(index=>body.poseData.frames[row.frameIndex].worldLandmarks[index]);
   assert(a&&b&&c);const ab=a.slice(0,3).map((value,index)=>value-b[index]),cb=c.slice(0,3).map((value,index)=>value-b[index]);
   const angle=Math.acos(Math.max(-1,Math.min(1,ab.reduce((sum,value,index)=>sum+value*cb[index],0)/(Math.hypot(...ab)*Math.hypot(...cb)))))*180/Math.PI;
   assert(Math.abs(row[side].kneeAngle-angle)<1e-8,'Measured knee angle must use all three world-coordinate dimensions');
   return {frameIndex:row.frameIndex,side,measured:row[side].kneeAngle,recomputed:angle,error:Math.abs(row[side].kneeAngle-angle)};
  }
 }
 assert.fail('Real clip must yield at least one usable three-dimensional knee measurement');
}
const server=await startServer({host:'127.0.0.1',port:0,dataDir,fetchImpl:async(url,options)=>{
 const request=JSON.parse(options.body),content=request.messages.find(item=>item.role==='user').content;
 const input=JSON.parse(content[0].text);calls.push({stage:input.stage,...assertWorldContext(input)});
 const unknown=input.stage==='recognize-action'&&++recognitionCount>1;
 const output=input.stage==='recognize-action'?{action:unknown?{exerciseId:null,name:'',status:'unknown',confidence:'low',imageIndices:[],evidence:''}:{exerciseId:'squat',name:'徒手深蹲',status:'identified',confidence:'high',imageIndices:[0],evidence:'QA 模拟：目标训练者双脚支撑，屈髋屈膝后起身。'}}:
 input.selectedExercise.id==='curl'?{selectionCheck:{status:'uncertain',imageIndices:[],evidence:'QA 模拟：器械被遮挡，无法识别。'},verdict:{status:'uncertain',summary:'无法评估动作，请重新拍摄。'},feedback:[],limitations:['无法确认动作是否标准。']}:
 {selectionCheck:{status:'consistent',imageIndices:[0],evidence:'QA 模拟：图片与选择一致。'},verdict:{status:'needs-improvement',summary:'QA 模拟动作评价'},feedback:[{title:'控制动作',status:'improve',source:'visual',imageIndices:[0],evidenceTimes:[input.frames[0].time],evidence:'QA 模拟画面观察。',correction:'QA 模拟建议。'}],limitations:['仅测试流程，不评价真实动作。']};
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}),{headers:{'Content-Type':'application/json'}});
}});
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const results=[];
try{
 for(const {scenario,model,decoder,ui=false,automatic=false} of cases){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:1000}});
  const requests=[],errors=[];context.on('request',r=>requests.push(r.url()));
  // Force CPU fallback, retaining real MediaPipe inference. Force only the
  // decoder boundary so the same source pixels exercise each production path.
  await context.route('**/motion-worker.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+`\nconst actual=self.onmessage;self.onmessage=event=>{if(${!automatic}&&event.data.type==='init'&&event.data.delegate==='GPU'||${JSON.stringify(decoder)}==='html-video'&&event.data.type==='prepare-mp4')self.postMessage({id:event.data.id,error:'QA forced fallback'});else actual(event);};`});});
  if(decoder==='ffmpeg-direct')await context.route('**/motion-media.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('metadata = await readPlayableMetadata(file, signal);','throw Object.assign(new Error("QA software codec"),{code:"MOTION_VIDEO_DECODE"});')});});
  await context.route('**/motion-video.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('export async function analyzeVideo(','async function qaActualAnalyzeVideo(')+'\nexport async function analyzeVideo(...args){window.qaPoseExtractions=(window.qaPoseExtractions||0)+1;const result=await qaActualAnalyzeVideo(...args);window.qaPipeline=result;return result;}'});});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const registration=await context.request.post(origin+'/api/auth/register',{data:{name:'模型测试',email:`${scenario}@example.test`,password:'mediapipe-qa-password'}});assert.equal(registration.status(),201);
  const current=await (await context.request.get(origin+'/api/providers')).json();
  assert.equal((await context.request.put(origin+'/api/providers',{data:{version:current.version,providers:[{id:'qa',presetId:'openai',apiKey:'local-mock',models:[{id:'qa-vision',vision:true}]}],tasks:{motion:'qa'},taskModels:{motion:'qa-vision'}}})).status(),200);
  await page.route(origin+'/qa-motion',async route=>{const response=await context.request.get(origin);await route.fulfill({response,body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/motion.css"></head><body><input id="fixture" type="file" hidden><div id="motion"></div></body></html>'});});
  await page.goto(origin+'/qa-motion');
  await page.locator('#fixture').setInputFiles(clip);
  let output=confirmationOnly?null:await page.evaluate(async model=>{
   const {analyzeVideo}=await import('/motion-video.js');
   const {analyzeMotion}=await import('/motion-analysis.js');
   const {buildMotionPoseData,buildFullMotionAnalysis}=await import('/motion-pose-data.js');
   const {buildMotionEvidence}=await import('/motion-evidence.js');
   const file=document.querySelector('#fixture').files[0];
   const pipeline=await analyzeVideo(file,{model,sampleFps:7.5});
   const observations=analyzeMotion(pipeline.frames,pipeline),evidence=await buildMotionEvidence(file,pipeline,observations);
   const body={duration:pipeline.duration,selectedExerciseId:'squat',reviewMode:'guided',analysis:evidence.summary,poseData:buildMotionPoseData(pipeline),fullAnalysis:buildFullMotionAnalysis(observations,pipeline),keyframes:evidence.images.map(({time,mimeType,dataUrl,imageTime})=>({time,mimeType,data:dataUrl.split(',')[1],imageTime}))};
   const response=await fetch('/api/motion/coach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!response.ok)throw Error(await response.text());
   return {modelVersion:pipeline.modelVersion,decoder:pipeline.decoder,delegate:pipeline.delegate,frames:pipeline.frames.length,observed:pipeline.frames.filter(frame=>frame.landmarks.length===33).length,body,coach:await response.json()};
  },model);
  if(output){assert.equal(output.decoder,decoder);if(!automatic)assert.equal(output.delegate,'CPU');assert.equal(output.frames,8);assert(output.observed>0);
  assert.equal(output.body.poseData.format,'mediapipe-world17-full');assert.equal(output.body.poseData.schemaVersion,6);
  assert.equal(output.body.fullAnalysis.version,'motion-observations-3d-v1');assert.equal(output.body.fullAnalysis.coordinateSpace,'mediapipe-world-3d');
  assert(output.body.poseData.frames.some(frame=>frame.worldLandmarks.some(point=>point&&Math.abs(point[2])>.001)));
  assertWorldAngle(output.body);validateMotionCoachRequest(output.body);assert.equal(output.coach.mode,'guided');}
  if(ui){
   await page.evaluate(async()=>{
    const {mountMotionView}=await import('/motion-view.js');
    window.qaReviews=[];window.qaSaved=[];
    mountMotionView(document.querySelector('#motion'),{getCoachConfiguration:()=>({configured:true,vision:true}),listAssessments:async()=>[],saveAssessment:async report=>{window.qaSaved.push(report);return report;},reviewAssessment:async body=>{window.qaReviews.push(body);const response=await fetch('/api/motion/coach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error(await response.text());return response.json();}});
   });
   assert.equal(await page.locator('[data-motion-pose-model]').inputValue(),'mediapipe-full');
   await page.locator('[data-motion-file]').setInputFiles(clip);
   await page.waitForFunction(()=>!document.querySelector('[data-motion-action="analyze"]').disabled);
   await page.locator('[data-motion-action="analyze"]').click();await page.locator('[data-motion-confirmation]').waitFor({timeout:120000});
   assert.equal(await page.locator('[data-motion-exercise]').inputValue(),'squat');
   assert.equal(await page.evaluate(()=>window.qaReviews.length),1);assert.equal(await page.evaluate(()=>window.qaReviews[0].reviewMode),'recognize');
   assert.equal(await page.evaluate(()=>window.qaSaved.length),0);assert.equal(await page.locator('.motion-coach-evaluation').count(),0);
   await page.screenshot({path:join(dataDir,'confirm-action.png'),fullPage:true});
   const extractionCount=await page.evaluate(()=>window.qaPoseExtractions);
   await page.locator('[data-motion-exercise]').selectOption('curl');assert.equal(await page.evaluate(()=>window.qaReviews.length),1);
   await page.locator('[data-motion-action="confirm-exercise"]').click();await page.locator('.motion-coach-evaluation').waitFor({timeout:120000});
   assert.equal(await page.evaluate(()=>window.qaPoseExtractions),extractionCount);
   const requestsForConfirmation=await page.evaluate(()=>window.qaReviews);
   assert.equal(requestsForConfirmation[1].selectedExerciseId,'curl');assert.deepEqual(requestsForConfirmation[0].poseData,requestsForConfirmation[1].poseData);
   assert.deepEqual(requestsForConfirmation[0].keyframes,requestsForConfirmation[1].keyframes);
   assert.match(await page.locator('[data-motion-results]').textContent(),/暂时找不出问题/);assert.doesNotMatch(await page.locator('[data-motion-results]').textContent(),/无法评估|无法确认|重新拍摄/);
   assert.equal(await page.evaluate(()=>window.qaReviews[0].poseData.format),'mediapipe-world17-full');
   await page.locator('[data-motion-action="save"]').click();await page.waitForFunction(()=>window.qaSaved.length===1);
   assert.match(await page.evaluate(()=>window.qaSaved[0].analysis.modelVersion),/MediaPipe/);
   assert.equal(await page.evaluate(()=>window.qaSaved[0].analysis.coordinateSpace),'mediapipe-world-3d');
   await page.addStyleTag({url:origin+'/motion.css'});await page.screenshot({path:join(dataDir,'standard-desktop.png'),fullPage:true});
   await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(dataDir,'standard-mobile.png'),fullPage:true});
   await page.setViewportSize({width:1280,height:1000});
   await page.locator('[data-motion-file]').setInputFiles(clip);await page.waitForFunction(()=>!document.querySelector('[data-motion-action="analyze"]').disabled);
   await page.locator('[data-motion-action="analyze"]').click();await page.locator('[data-motion-confirmation]').waitFor({timeout:120000});
   assert.equal(await page.locator('[data-motion-exercise]').inputValue(),'');assert(await page.locator('[data-motion-action="confirm-exercise"]').isDisabled());
   assert.equal(await page.evaluate(()=>window.qaReviews.length),3);assert.equal(await page.evaluate(()=>window.qaSaved.length),1);
   await page.screenshot({path:join(dataDir,'unknown-action-confirmation.png'),fullPage:true});
   await page.locator('[data-motion-exercise]').selectOption('squat');await page.locator('[data-motion-action="confirm-exercise"]').click();await page.locator('.motion-coach-evaluation').waitFor({timeout:120000});
   assert.match(await page.locator('[data-motion-results]').textContent(),/QA 模拟动作评价|QA 模拟建议/);
   await page.locator('[data-motion-action="save"]').click();await page.waitForFunction(()=>window.qaSaved.length===2);
   await page.screenshot({path:join(dataDir,'actionable-correction.png'),fullPage:true});
   if(confirmationOnly)output=await page.evaluate(()=>({decoder:window.qaPipeline.decoder,delegate:window.qaPipeline.delegate,frames:window.qaPipeline.frames.length,observed:window.qaPipeline.frames.filter(frame=>frame.landmarks.length===33).length,body:window.qaReviews[3],coach:window.qaSaved[1].coach,confirmation:{reviews:window.qaReviews.map(body=>({mode:body.reviewMode,selectedExerciseId:body.selectedExerciseId})),poseExtractions:window.qaPoseExtractions,saved:window.qaSaved.length,noFindingStatus:window.qaSaved[0].coach.verdict.status}}));
   await page.locator('[data-motion-pose-model]').selectOption('mediapipe-heavy');assert.match(await page.locator('#motion').textContent(),/精度更高，但分析时间更长/);assert(await page.locator('[data-motion-results]').isHidden());assert.equal(await page.locator('[data-motion-action="analyze"]').textContent(),'分析视频并识别动作');
   if(!confirmationOnly){
   const callCount=calls.length;
   const cancellation=await page.evaluate(async()=>{
    const {analyzeVideo}=await import('/motion-video.js'),NativeWorker=window.Worker,active=new Set();
    let processed=0,terminated=0;
    window.Worker=class extends NativeWorker{
     constructor(url,options){super(url,options);if(String(url).endsWith('/motion-worker.js'))active.add(this);}
     terminate(){if(active.delete(this))terminated++;return super.terminate();}
    };
    const abort=new AbortController();
    try{
     await analyzeVideo(document.querySelector('#fixture').files[0],{model:'mediapipe-full',sampleFps:3,signal:abort.signal,
      onProgress:progress=>{if(progress.stage==='analyzing'){processed++;abort.abort();}}});
     throw Error('Cancelled inference unexpectedly completed');
    }catch(error){return {name:error.name,processed,terminated,activeWorkers:active.size};}
    finally{window.Worker=NativeWorker;}
   });
   assert.equal(cancellation.name,'AbortError');assert.equal(cancellation.processed,1);
   assert(cancellation.terminated>=1);assert.equal(cancellation.activeWorkers,0);assert.equal(calls.length,callCount);
   output.cancellation=cancellation;
   }
  }
  assert(!requests.some(url=>/\.onnx(?:\?|$)/.test(url)));assert(requests.some(url=>url.endsWith('/pose_landmarker_'+model.replace('mediapipe-','')+'.task')));assert.deepEqual([...new Set(requests.filter(url=>/\.task(?:\?|$)/.test(url)).map(url=>new URL(url).pathname))],['/vendor/mediapipe/pose_landmarker_'+model.replace('mediapipe-','')+'.task']);assert(requests.every(url=>new URL(url).origin===origin));
  const kneeAngle=assertWorldAngle(output.body);validateMotionCoachRequest(output.body);
  assert.deepEqual(errors,[]);
  results.push({scenario,model,decoder,delegate:output.delegate,frames:output.frames,observed:output.observed,format:output.body.poseData.format,
   coordinateSpace:output.body.fullAnalysis.coordinateSpace,worldObserved:output.body.poseData.frames.filter(frame=>frame.worldLandmarks.some(Boolean)).length,kneeAngle,confirmation:output.confirmation,cancellation:output.cancellation});console.log(results.at(-1));
  await context.close();
 }
 await writeFile(join(dataDir,'results.json'),JSON.stringify({passed:true,scope:confirmationOnly?'Real MediaPipe Full extraction; recognition then correction and explicit confirmation; same skeleton and images reused; unknown recognition manual confirmation; no-finding and concrete-issue displays; desktop/mobile and save. Local mock AI.':'Real MediaPipe Lite/Full/Heavy world coordinates, 3D knee measurements, shared decoders, AI context, UI confirmation/save/switch and cancellation. AI is a local fixture; this does not assess model accuracy.',results,calls:calls.length,coachEvidence:calls},null,2));console.log(dataDir);
}finally{await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
