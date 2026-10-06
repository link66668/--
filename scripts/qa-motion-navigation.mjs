// Browser integration regression: preserve one local motion workspace across SPA
// navigation. Real MediaPipe Full; deterministic waits and a local mock coach, no paid AI.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {startServer} from '../server.mjs';
import {validateMotionCoachRequest} from '../server/motion-coach.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'.qa'),{recursive:true});
const dataDir=await mkdtemp(join(root,'.qa','motion-navigation-'));
const clip=join(dataDir,'navigation-one-second.mp4');
const ffmpeg=process.env.QA_FFMPEG||join(root,'.qa/motion-fixtures/qa-codecs/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',resolve(process.argv[2]||join(root,'.qa/motion-fixtures/squat.mp4')),
  '-t','1','-an','-vf','scale=480:-2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',clip],{windowsHide:true});
const sha=value=>createHash('sha256').update(value).digest('hex');
const files=['public/app.js','public/motion-view.js','public/motion-video.js','public/motion-worker.js','public/motion-mediapipe.js','server.mjs'];
const codeHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(join(root,file)))])));
const videoSource=await readFile(join(root,'public/motion-video.js'),'utf8');
const viewSource=await readFile(join(root,'public/motion-view.js'),'utf8');
assert.equal(videoSource.split('export async function analyzeVideo(').length,2);
assert.equal(viewSource.split('export function mountMotionView(').length,2);
const {chromium}=await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT||join(root,'.qa/browser-tools/node_modules/playwright/index.mjs'))).href);
let releaseCoach,notifyCoachEntered,releaseRecognition,notifyRecognitionEntered,coachAborted=false;
const coachEntered=new Promise(resolve=>{notifyCoachEntered=resolve;});
const recognitionEntered=new Promise(resolve=>{notifyRecognitionEntered=resolve;});
const recognitionGate=new Promise(resolve=>{releaseRecognition=resolve;});
const coachGate=new Promise(resolve=>{releaseCoach=resolve;}),coachCalls=[];
const server=await startServer({host:'127.0.0.1',port:0,dataDir,fetchImpl:async(url,options)=>{
  assert(new URL(url).pathname.endsWith('/chat/completions'));
  const request=JSON.parse(options.body),parts=request.messages.find(message=>message.role==='user').content;
  const context=JSON.parse(parts[0].text),images=parts.filter(part=>part.type==='image_url');
  assert(['recognize-action','guided-evidence'].includes(context.stage));
  if(context.stage==='guided-evidence')assert.equal(context.selectedExercise.id,'curl');
  else assert.equal(context.selectedExercise,undefined);
  assert.equal(context.evidence.poseSchema.landmarkIndices.length,17);
  coachCalls.push({stage:context.stage,frames:context.evidence.sourceFrameCount,imageCount:images.length,
    imageHashes:images.map(image=>sha(Buffer.from(image.image_url.url.split(',')[1],'base64')))});
  options.signal?.addEventListener('abort',()=>{coachAborted=true;},{once:true});
  if(context.stage==='recognize-action'){
    notifyRecognitionEntered();await recognitionGate;
    assert.equal(options.signal?.aborted,false,'Navigation must not abort action recognition');
    return Response.json({choices:[{message:{content:JSON.stringify({action:{exerciseId:'squat',name:'徒手深蹲',status:'identified',confidence:'high',imageIndices:[0],evidence:'QA 模拟：双脚支撑，屈髋屈膝后起身。'}})}}]});
  }
  notifyCoachEntered();
  await coachGate;
  assert.equal(options.signal?.aborted,false,'Navigation must not abort the coach request');
  const result={selectionCheck:{status:'consistent',imageIndices:[0],evidence:'QA 模拟：图片与用户确认的哑铃弯举相符。'},
    verdict:{status:'needs-improvement',summary:'导航回归 QA：本次结果尚未手动保存。'},
    feedback:[{title:'导航回归模拟建议',status:'improve',source:'visual',imageIndices:[0],
      evidence:'这是本地集成验证的固定响应，不代表动作正确性判断。',correction:'保持稳定节奏。',priority:1}],
    limitations:['本地模拟 AI 仅用于验证页面状态保留。']};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{headers:{'Content-Type':'application/json'}});
}});
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const browserContext=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000},reducedMotion:'reduce'});
await browserContext.addInitScript(()=>{
  window.__qaUrls=[];window.__qaRevoked=[];window.__qaWorkers=[];window.__qaMounts=[];window.__qaAnalysisCalls=[];
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),RealWorker=window.Worker;
  URL.createObjectURL=object=>{const url=create(object);window.__qaUrls.push({url,object});return url;};
  URL.revokeObjectURL=url=>{window.__qaRevoked.push(url);return revoke(url);};
  window.Worker=class extends RealWorker{constructor(url,options){super(url,options);window.__qaWorkers.push(String(url));}};
});
await browserContext.route(/\/motion-video\.js(?:\?.*)?$/,async route=>{
  const response=await route.fetch();assert.equal(sha(await response.text()),codeHashes['public/motion-video.js']);
  await route.fulfill({response,body:videoSource.replace('export async function analyzeVideo(','async function qaActualAnalyzeVideo(')+`
export async function analyzeVideo(file,options){
  const call={file,signal:options.signal};window.__qaAnalysisCalls.push(call);
  await new Promise(resolve=>{window.__qaReleaseAnalysis=resolve;});
  const pipeline=await qaActualAnalyzeVideo(file,options);window.__qaPipeline=pipeline;return pipeline;
}`});
});
await browserContext.route(/\/motion-view\.js(?:\?.*)?$/,async route=>{
  const response=await route.fetch();assert.equal(sha(await response.text()),codeHashes['public/motion-view.js']);
  await route.fulfill({response,body:viewSource.replace('export function mountMotionView(','function qaActualMountMotionView(')+`
export function mountMotionView(...args){
  const api=qaActualMountMotionView(...args),entry={container:args[0],api,destroyed:0,suspended:0,resumed:0};window.__qaMounts.push(entry);
  for(const [key,counter] of [['destroy','destroyed'],['suspend','suspended'],['resume','resumed']])if(typeof api[key]==='function'){
    const actual=api[key];api[key]=function(...values){entry[counter]++;return actual.apply(this,values);};
  }return api;
}`});
});
const page=await browserContext.newPage();page.setDefaultTimeout(20000);
const errors=[],externalRequests=[],motionInputs=[],checks=[],snapshots=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{
  if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==origin)externalRequests.push(request.url());
  if(request.method()==='POST'&&request.url()===origin+'/api/motion/coach')motionInputs.push(request.postDataJSON());
});
const state=async()=>{const response=await browserContext.request.get(origin+'/api/state');assert.equal(response.status(),200);return response.json();};
const records=async()=>(await state()).records.filter(record=>record.kind==='motion-assessment'&&!record.deleted);
const nav=async name=>{await page.locator(`.nav [data-page="${name}"]`).click();await page.locator(`.nav [data-page="${name}"][aria-current="page"]`).waitFor();
  if(name==='motion')await page.locator('[data-motion-file]').waitFor({state:'attached'});};
const screenshot=name=>page.screenshot({path:join(dataDir,name+'.png'),fullPage:true,style:'#toasts{visibility:hidden}'});
const snapshot=async label=>{
  const value=await page.evaluate(()=>{
    const video=document.querySelector('[data-motion-video]'),url=video?.getAttribute('src'),entry=window.__qaUrls.find(entry=>entry.url===url);
    return {selected:document.querySelector('[data-motion-exercise]')?.value,url,file:entry?.object instanceof File?{name:entry.object.name,type:entry.object.type,size:entry.object.size,lastModified:entry.object.lastModified}:null,
      metadata:document.querySelector('[data-motion-metadata]')?.textContent,mounts:window.__qaMounts.length,workers:window.__qaWorkers.filter(url=>url.includes('/motion-worker.js')).length,
      analysisCalls:window.__qaAnalysisCalls.length,analysisAborted:window.__qaAnalysisCalls.some(call=>call.signal.aborted),destroyed:window.__qaMounts.map(entry=>entry.destroyed),
      sameNode:!window.__qaOriginalMotionNode||document.querySelector('.motion-page')===window.__qaOriginalMotionNode,
      sourceRevoked:window.__qaRevoked.includes(url),sameFile:!window.__qaAnalysisCalls.length||window.__qaAnalysisCalls[0].file===window.__qaOriginalFile};
  });snapshots.push({label,...value});return value;
};
let original,expectedSelection='',step='create isolated accounts';
const assertRetained=async label=>{const current=await snapshot(label);assert.equal(current.selected,expectedSelection);assert.equal(current.url,original.url);assert.deepEqual(current.file,original.file);
  assert.equal(current.metadata,original.metadata);assert.equal(current.mounts,1);assert.equal(current.sameNode,true);assert.equal(current.sameFile,true);assert.equal(current.sourceRevoked,false);
  assert.equal(current.analysisAborted,false);assert.deepEqual(current.destroyed,[0]);return current;};
try{
  const register=await browserContext.request.post(origin+'/api/auth/register',{data:{name:'导航回归甲',email:`navigation-a-${Date.now()}@example.test`,password:'qa-navigation-password'}});
  assert.equal(register.status(),201);const {user}=await register.json();
  const profile={age:28,sex:'male',height:175,weight:70,goal:'maintain',activity:1.375};
  assert.equal((await browserContext.request.post(origin+'/api/sync',{data:{userId:user.id,changes:[{id:'profile',kind:'profile',baseVersion:0,data:profile}]}})).status(),200);
  const {version}=await (await browserContext.request.get(origin+'/api/providers')).json();
  const provider={id:'motion-navigation-qa',presetId:'openai',apiKey:'QA-placeholder-no-network',models:[{id:'qa-vision',vision:true}]};
  const configure=await browserContext.request.put(origin+'/api/providers',{data:{version,providers:[provider],tasks:{chat:provider.id,motion:''},taskModels:{chat:'qa-vision',motion:''}}});
  assert.equal(configure.status(),200,await configure.text());
  const secondContext=await browser.newContext();const secondEmail=`navigation-b-${Date.now()}@example.test`;
  const secondRegister=await secondContext.request.post(origin+'/api/auth/register',{data:{name:'导航回归乙',email:secondEmail,password:'qa-navigation-password'}});
  assert.equal(secondRegister.status(),201);const secondUser=(await secondRegister.json()).user;
  assert.equal((await secondContext.request.post(origin+'/api/sync',{data:{userId:secondUser.id,changes:[{id:'profile',kind:'profile',baseVersion:0,data:profile}]}})).status(),200);await secondContext.close();
  await page.goto(origin+'/#motion');await page.locator('[data-motion-pose-model]').selectOption('mediapipe-full');
  assert(await page.locator('[data-motion-confirmation]').isHidden());
  await page.locator('[data-motion-file]').setInputFiles(clip);
  await page.waitForFunction(()=>document.querySelector('[data-motion-video]')?.readyState>=2&&!document.querySelector('[data-motion-player]')?.hidden);
  await page.evaluate(()=>{window.__qaOriginalMotionNode=document.querySelector('.motion-page');const url=document.querySelector('[data-motion-video]').getAttribute('src');window.__qaOriginalFile=window.__qaUrls.find(entry=>entry.url===url).object;});
  original=await snapshot('initial-selection-without-motion-model');assert(original.url.startsWith('blob:'));assert(original.file);assert.equal(original.mounts,1);
  assert(await page.locator('[data-motion-action="analyze"]').isDisabled());

  step='retain selection before analysis across chat, training, settings and sync';console.log(step,dataDir);
  for(const destination of ['chat','training','settings']){await nav(destination);await nav('motion');await assertRetained('unanalysed-roundtrip-'+destination);}
  await page.locator('#sync-status').click();await page.getByText('同步完成',{exact:true}).waitFor();await assertRetained('sync-renderPage');
  checks.push('Full SPA render across chat/training/settings and in-place sync renderPage retain identical DOM, File, blob URL and selected action');

  step='configure the motion model in settings and resume the same video';console.log(step);
  await page.locator('[data-motion-action="coach-settings"]').click();await page.locator('#task-motion').waitFor();
  await page.locator('#task-motion').selectOption(JSON.stringify({providerId:provider.id,modelId:'qa-vision'}));
  await page.locator('#tasks-form').evaluate(form=>form.requestSubmit());await page.getByText('任务模型已保存',{exact:true}).waitFor();
  await nav('motion');await assertRetained('configuration-refresh');assert(await page.locator('[data-motion-action="analyze"]').isEnabled());
  checks.push('Missing motion configuration can be supplied through the real settings UI without discarding the local video');
  await screenshot('selected-video-after-navigation');

  step='navigation while the existing local analysis is pending';console.log(step);
  await page.locator('[data-motion-action="analyze"]').click();await page.waitForFunction(()=>window.__qaAnalysisCalls.length===1);
  await nav('chat');assert.equal(await page.evaluate(()=>window.__qaAnalysisCalls[0].signal.aborted),false);
  await nav('motion');let pending=await assertRetained('local-analysis-pending');assert.equal(pending.analysisCalls,1);assert.equal(pending.workers,0);
  assert(await page.locator('[data-motion-progress]').isVisible());await screenshot('local-analysis-return');
  await page.evaluate(()=>window.__qaReleaseAnalysis());
  await page.waitForFunction(()=>window.__qaPipeline?.frames?.length>=7,undefined,{timeout:300000});
  await page.waitForFunction(()=>!document.querySelector('[data-motion-action="cancel-coach"]')?.hidden,undefined,{timeout:60000});
  await Promise.race([recognitionEntered,new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Mock recognition was not entered within 30 seconds')),30000);timeout.unref();recognitionEntered.then(()=>clearTimeout(timeout));})]);
  assert.equal(coachCalls.length,1);assert.equal(motionInputs.length,1);
  const input=validateMotionCoachRequest(motionInputs[0]);assert.equal(input.reviewMode,'recognize');assert.equal(input.selectedExerciseId,undefined);
  assert.equal(input.poseData.schemaVersion,6);assert.equal(input.poseData.retainedLandmarkIndices.length,17);assert.equal(input.poseData.sampleFps,7.5);
  assert.equal(input.keyframes.length,6);assert.equal(input.fullAnalysis.measurements.length,input.poseData.frameCount);
  const pipeline=await page.evaluate(()=>({frames:window.__qaPipeline.frames.length,sampleFps:window.__qaPipeline.sampleFps,delegate:window.__qaPipeline.delegate,decoder:window.__qaPipeline.decoder,modelVersion:window.__qaPipeline.modelVersion,timing:window.__qaPipeline.timing}));
  assert.match(pipeline.modelVersion,/MediaPipe Pose Landmarker Full/);assert.equal(pipeline.frames,input.poseData.frameCount);
  pending=await assertRetained('real-pose-completed-ai-pending');assert.equal(pending.workers,1);assert.equal(pending.analysisCalls,1);
  checks.push('Analysis pending navigation preserves its AbortSignal and starts exactly one actual MediaPipe worker after releasing the deterministic gate');

  step='recognition pending navigation keeps one live request';console.log(step);
  await nav('training');await nav('settings');await nav('motion');await assertRetained('ai-request-pending-return');
  assert(await page.locator('[data-motion-action="cancel-coach"]').isVisible());assert.equal(coachAborted,false);assert.equal(coachCalls.length,1);assert.equal(motionInputs.length,1);
  await screenshot('recognition-pending-return');releaseRecognition();
  await page.locator('[data-motion-confirmation]').waitFor();expectedSelection='squat';await assertRetained('recognized-action-awaiting-confirmation');
  assert(await page.locator('[data-motion-action="confirm-exercise"]').isEnabled());
  assert.equal(await page.locator('[data-motion-action="save"]').count(),0);assert.equal(coachCalls.length,1);assert.equal((await records()).length,0);
  checks.push('Recognition stays active across navigation and preselects the suggested action without evaluating or saving');

  step='edited action persists through navigation before explicit confirmation';console.log(step);
  await page.locator('[data-motion-exercise]').selectOption('curl');expectedSelection='curl';
  await nav('chat');await nav('motion');await assertRetained('edited-action-awaiting-confirmation');
  assert.equal(coachCalls.length,1);assert.equal(motionInputs.length,1);await screenshot('edited-action-before-confirmation');
  await page.locator('[data-motion-action="confirm-exercise"]').click();
  await Promise.race([coachEntered,new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Mock coach was not entered within 30 seconds')),30000);timeout.unref();coachEntered.then(()=>clearTimeout(timeout));})]);
  assert.equal(coachCalls.length,2);assert.equal(motionInputs.length,2);
  const guided=validateMotionCoachRequest(motionInputs[1]);assert.equal(guided.reviewMode,'guided');assert.equal(guided.selectedExerciseId,'curl');
  assert.deepEqual(guided.poseData,input.poseData);assert.deepEqual(guided.fullAnalysis,input.fullAnalysis);assert.deepEqual(guided.keyframes,input.keyframes);
  assert.equal(await page.evaluate(()=>window.__qaAnalysisCalls.length),1,'Confirmation must reuse the extracted skeleton');
  await nav('training');await nav('settings');await nav('motion');await assertRetained('guided-request-pending-return');
  assert(await page.locator('[data-motion-action="cancel-coach"]').isVisible());assert.equal(coachAborted,false);assert.equal(coachCalls.length,2);assert.equal(motionInputs.length,2);
  await screenshot('ai-pending-return');releaseCoach();
  await page.locator('.motion-coach-evaluation').waitFor({timeout:60000});assert.match(await page.locator('[data-motion-results]').textContent(),/导航回归 QA/);
  assert.equal((await records()).length,0,'Motion-page results must not be auto-saved');
  checks.push('An edited action survives navigation, starts one guided request only after confirmation and reuses exactly the same skeleton/screenshots');
  checks.push('Guided AI request remains active across navigation and completes once, without cancellation or an automatic retry');

  step='unsaved result persists, then manual save survives reload';console.log(step);
  for(const destination of ['chat','training']){await nav(destination);await nav('motion');await assertRetained('unsaved-result-'+destination);assert.match(await page.locator('[data-motion-results]').textContent(),/导航回归 QA/);}
  assert(await page.locator('[data-motion-action="save"]').isEnabled());assert.equal((await records()).length,0);await screenshot('unsaved-result-after-navigation');
  const beforeReload=await snapshot('before-save-and-reload');
  await page.locator('[data-motion-action="save"]').click();await page.waitForFunction(()=>document.querySelector('[data-motion-action="save"]')?.textContent==='已保存报告');
  await page.locator('#sync-status').click();await page.getByText('同步完成',{exact:true}).waitFor();
  const saved=await records();assert.equal(saved.length,1);const reportId=saved[0].id;
  await page.reload();await page.locator('[data-motion-action="history"]').waitFor();
  assert.equal(await page.locator('[data-motion-exercise]').inputValue(),'');assert.equal(await page.locator('[data-motion-video]').getAttribute('src'),null);
  await page.locator('[data-motion-action="history"]').click();await page.locator('.motion-coach-evaluation').waitFor();
  assert.match(await page.locator('[data-motion-results]').textContent(),/导航回归 QA/);assert.equal((await records())[0].id,reportId);await screenshot('saved-report-after-reload');
  checks.push('Unsaved results survive SPA navigation; manual save persists the report after F5 while transient video selection correctly clears');

  step='logout destroys local media and the next account gets no prior state';console.log(step);
  await page.locator('[data-motion-file]').setInputFiles(clip);
  await page.waitForFunction(()=>document.querySelector('[data-motion-video]')?.readyState>=2&&document.querySelector('[data-motion-video]')?.getAttribute('src')?.startsWith('blob:'));
  const logoutUrl=await page.locator('[data-motion-video]').getAttribute('src');
  await page.locator('[data-action="logout"]').click();await page.locator('#auth-form').waitFor({state:'attached'});
  assert(await page.evaluate(url=>window.__qaRevoked.includes(url),logoutUrl));assert.deepEqual(await page.evaluate(()=>window.__qaMounts.map(entry=>entry.destroyed)),[1]);
  if(!await page.locator('#auth-form').isVisible())await page.locator('[data-action="auth-jump"][data-mode="login"]').first().click();
  await page.locator('#auth-form').waitFor();
  await page.locator('#email').fill(secondEmail);await page.locator('#password').fill('qa-navigation-password');await page.locator('#auth-form').evaluate(form=>form.requestSubmit());
  await page.locator('.nav [data-page="motion"]').waitFor();await nav('motion');
  assert.equal(await page.locator('[data-motion-exercise]').inputValue(),'');assert.equal(await page.locator('[data-motion-video]').getAttribute('src'),null);
  assert.equal(await page.locator('[data-motion-metadata]').isVisible(),false);assert.equal(await page.locator('[data-motion-results]').isVisible(),false);
  assert.equal((await records()).length,0);assert.equal(await page.locator('[data-motion-action="history"]').count(),0);await screenshot('second-account-empty-workspace');
  checks.push('Explicit logout revokes the blob and destroys the cached workspace; a different account sees no video, selection, result or report');
  assert.equal(coachCalls.length,2);assert.equal(motionInputs.length,2);assert.equal(coachAborted,false);assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  for(const [file,hash]of Object.entries(codeHashes))assert.equal(sha(await readFile(join(root,file))),hash,`${file} changed during QA`);
  const result={passed:true,scope:'Real MediaPipe Full and browser navigation integration with a local mock coach; not an AI quality evaluation.',dataDir,codeHashes,sourceVideoSha256:sha(await readFile(clip)),
    pipeline,reportId,mockCoachCalls:coachCalls.length,motionRequests:motionInputs.length,coachAborted,beforeReload,snapshots,checks,
    instrumentation:'analyzeVideo waits on a QA gate before calling the unmodified function once; mount lifecycle, Worker creation and object URLs are observed without changing their behavior. The mock provider waits on a server gate.',errors};
  await writeFile(join(dataDir,'results.json'),JSON.stringify(result,null,2));await writeFile(join(dataDir,'mock-provider-trace.json'),JSON.stringify(coachCalls,null,2));console.log(JSON.stringify(result));
}catch(error){await screenshot('failure').catch(()=>{});await writeFile(join(dataDir,'failure.json'),JSON.stringify({step,error:error.stack,codeHashes,snapshots,checks,coachCalls,coachAborted,errors},null,2));console.error('FAILED STEP:',step,'artifacts:',dataDir);throw error;}
finally{releaseRecognition();releaseCoach();await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
