// Isolated chat-to-motion integration. Real selected pose model and decoder; both chat
// tool selection and motion coaching use an in-process fixture, never paid AI.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {startServer} from '../server.mjs';
import {validateMotionCoachRequest} from '../server/motion-coach.mjs';
import {getMotionExercise} from '../public/motion-catalog.js';
import {getMotionPoseModel} from '../public/motion-models.js';
const poseModel=getMotionPoseModel(process.env.QA_POSE_MODEL);
const exercise=getMotionExercise(process.env.QA_MOTION_EXERCISE||'curl');
assert(exercise);

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'.qa'),{recursive:true});
const dataDir=await mkdtemp(join(root,'.qa','chat-motion-'));
const clip=join(dataDir,'chat-squat-one-second.mp4');
const ffmpeg=process.env.QA_FFMPEG||join(root,'.qa/motion-fixtures/qa-codecs/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',resolve(process.argv[2]||join(root,'.qa/motion-fixtures/squat.mp4')),
  '-t','1','-an','-vf','scale=480:-2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',clip],{windowsHide:true});
const sha=value=>createHash('sha256').update(value).digest('hex');
const codeFiles=['public/app.js','public/chat-attachments.js','public/chat-motion.js','public/chat-motion-confirm.js','public/chat-motion-result.js','public/chat-stream.js','public/motion-view.js',
  'public/motion-video.js','public/motion-worker.js','public/motion-mediapipe.js','public/motion-models.js',
  'public/motion-analysis.js','public/motion-pose-data.js','public/motion-tracking.js','public/motion-smoothing.js','public/motion-report.js',
  'server/motion-coach-guided.mjs','server/motion-coach-temporal.mjs','server/chat-motion.mjs','server.mjs'];
const codeHashes=Object.fromEntries(await Promise.all(codeFiles.map(async file=>[file,sha(await readFile(join(root,file)))])));
const {chromium}=await import(pathToFileURL(resolve(process.env.QA_PLAYWRIGHT||join(root,'.qa/browser-tools/node_modules/playwright/index.mjs'))).href);
const videoSource=await readFile(join(root,'public/motion-video.js'),'utf8');
const chatStreamSource=await readFile(join(root,'public/chat-stream.js'),'utf8');
assert.equal(videoSource.split('export async function analyzeVideo(').length,2);
assert.equal(chatStreamSource.split('export async function consumeChatEvents(').length,2);
let toolSequence=0,firstVideoId=null,summaryFailures=0;
const upstream=[],coachCalls=[],recognitionCalls=[],toolCalls=[],toolReceipts=[];
let releaseRecognition,notifyRecognitionEntered;
const recognitionGate=new Promise(resolve=>{releaseRecognition=resolve;}),recognitionEntered=new Promise(resolve=>{notifyRecognitionEntered=resolve;});
const streamed=chunks=>new Response(new ReadableStream({start(controller){const encoder=new TextEncoder();
  for(const chunk of chunks)controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
const answer=text=>streamed([{choices:[{index:0,delta:{content:text}}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}]);
const tool=(name,args)=>streamed([{choices:[{index:0,delta:{tool_calls:[{index:0,id:`qa-motion-${++toolSequence}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]},
  {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}]);
const server=await startServer({host:'127.0.0.1',port:0,dataDir,fetchImpl:async(url,options)=>{
  assert(new URL(url).pathname.endsWith('/chat/completions'));
  const request=JSON.parse(options.body),firstUser=request.messages.find(message=>message.role==='user');
  const parts=firstUser?.content;
  let motionContext;try{motionContext=JSON.parse(typeof parts==='string'?parts:parts?.[0]?.text);}catch{}
  if(motionContext?.stage==='recognize-action'){
    assert(motionContext.evidence.frames.length>0);assert.equal(motionContext.selectedExercise,undefined);
    recognitionCalls.push({stage:motionContext.stage,frames:motionContext.evidence.frames.length,images:parts.filter(part=>part.type==='image_url').length});
    if(recognitionCalls.length===1){notifyRecognitionEntered();await recognitionGate;}
    const result={action:{exerciseId:'squat',name:'徒手深蹲',status:'identified',confidence:'high',imageIndices:[0],evidence:'QA 模拟：目标训练者双脚支撑，屈髋屈膝后起身。'}};
    return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  }
  if(motionContext?.stage==='guided-evidence'){
    const images=parts.filter(part=>part.type==='image_url');
    assert.equal(motionContext.selectedExercise.id,exercise.id);assert(images.length>0&&images.length<=6);
    assert(motionContext.evidence.frames.length>0);assert.equal(motionContext.evidence.poseSchema.landmarkIndices.length,17);
    {
      assert.deepEqual(motionContext.evidence.poseSchema.worldPointFields,['x','y','z','visibility']);
      const world=motionContext.evidence.frames.flatMap(frame=>frame.worldLandmarks||[]).filter(Boolean);
      assert(world.length>0);assert(world.every(point=>point.length===4));assert(world.some(point=>Math.abs(point[2])>.001));
    }
    coachCalls.push({model:request.model,sourceFrames:motionContext.evidence.sourceFrameCount,sentFrames:motionContext.evidence.frames.length,
      worldPointFields:motionContext.evidence.poseSchema.worldPointFields,worldFrames:motionContext.evidence.frames.filter(frame=>frame.worldLandmarks?.some(Boolean)).length,
      images:images.map(image=>({sha256:sha(Buffer.from(image.image_url.url.split(',')[1],'base64')),bytes:Buffer.from(image.image_url.url.split(',')[1],'base64').length})),stage:motionContext.stage});
    const result={selectionCheck:{status:'consistent',imageIndices:[0],evidence:`QA 模拟：图片与所选${exercise.name}相符。`},
      verdict:{status:'needs-improvement',summary:'QA 模拟：建议调整，动作报告已保存。'},
      feedback:[{title:'躯干控制（QA模拟）',status:'improve',source:'visual',imageIndices:[0],
        evidence:'这是本地集成测试的固定响应，不代表动作正确性判断。',correction:'下一组降低负重，保持肩髋同步。',priority:1}],
      limitations:['本地模拟 AI 仅用于集成验证。']};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{headers:{'Content-Type':'application/json'}});
  }
  upstream.push({model:request.model,messages:request.messages,toolNames:(request.tools||[]).map(value=>value.function.name)});
  if(request.messages.some(message=>message.role==='system'&&message.content.includes('当前请求已经完成的真实操作回执')&&message.content.includes('assess_motion_video'))){
    assert(!request.tools?.some(item=>item.function.name==='assess_motion_video'),'A replayed receipt must disable another assessment');
    return answer('已完成本地视频评估，可通过卡片查看详细结果。');
  }
  const last=request.messages.at(-1);
  if(last.role==='tool'){
    const receipt=JSON.parse(last.content);toolReceipts.push(receipt);
    if(receipt.ok&&summaryFailures++===0)return new Response(JSON.stringify({error:{message:'QA: one final-summary failure after the saved report'}}),{status:500,headers:{'Content-Type':'application/json'}});
    return answer(receipt.ok?'已完成本地视频评估，可通过卡片查看详细结果。':receipt.message?.includes('取消')?'已取消动作确认。':'本地视频已不可用，请重新选择视频后重试。');
  }
  const allText=JSON.stringify(request.messages),ids=[...new Set(allText.match(/local-video:[0-9a-f-]{36}/g)||[])];
  assert.equal(ids.length,1,'The existing local video must be available as metadata in both turns');
  firstVideoId??=ids[0];assert.equal(ids[0],firstVideoId);
  assert(request.tools?.some(item=>item.function.name==='assess_motion_video'),'The native motion tool must be declared');
  const schema=request.tools.find(item=>item.function.name==='assess_motion_video').function.parameters;assert.deepEqual(schema.properties.poseModel.enum,['mediapipe-lite','mediapipe-full','mediapipe-heavy']);assert(schema.required.includes('poseModel'));
  assert(!schema.required.includes('exerciseId'),'The AI must be able to initiate recognition before an exercise is known');
  const args={videoId:firstVideoId,poseModel:poseModel.id};toolCalls.push(args);
  return tool('assess_motion_video',args);
}});
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const page=await context.newPage();page.setDefaultTimeout(20000);
const errors=[],externalRequests=[],attachmentUploads=[],motionInputs=[],chatBodies=[],sseEvents=[],responseReads=[],servedCodeHashes={};
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{
  const url=request.url();if(/^https?:/.test(url)&&new URL(url).origin!==origin)externalRequests.push(url);
  if(request.method()!=='POST')return;
  if(url===origin+'/api/attachments')attachmentUploads.push(url);
  if(url===origin+'/api/ai')chatBodies.push(request.postDataJSON());
  if(url.startsWith(origin+'/api/chat/motion/'))motionInputs.push(request.postDataJSON());
});
page.on('response',response=>{
  const pathname=new URL(response.url()).pathname;
  if(['app.js','chat-attachments.js','chat-motion.js','chat-motion-result.js','motion-view.js'].some(file=>pathname==='/'+file))
    responseReads.push(response.text().then(text=>servedCodeHashes['public'+pathname]=sha(text)).catch(()=>{}));
});
await context.route(/\/motion-video\.js(?:\?.*)?$/,async route=>{const response=await route.fetch();await route.fulfill({response,
  body:videoSource.replace('export async function analyzeVideo(','async function qaActualAnalyzeVideo(')+'\nexport async function analyzeVideo(...args){window.__qaPoseExtractions=(window.__qaPoseExtractions||0)+1;const result=await qaActualAnalyzeVideo(...args);window.__qaChatMotionPipeline=result;return result;}'});});
await context.route(/\/chat-stream\.js(?:\?.*)?$/,async route=>{const response=await route.fetch();await route.fulfill({response,
  body:chatStreamSource.replace('export async function consumeChatEvents(','async function qaActualConsumeChatEvents(')+
    '\nexport async function consumeChatEvents(body,onEvent,signal){return qaActualConsumeChatEvents(body,(type,data)=>{(window.__qaChatEvents??=[]).push({type,jobId:data.jobId,videoId:data.videoId,exerciseId:data.exerciseId,poseModel:data.poseModel});return onEvent?.(type,data);},signal);}'});});
const state=async()=>{const response=await context.request.get(origin+'/api/state');assert.equal(response.status(),200);return response.json();};
const records=async kind=>(await state()).records.filter(record=>record.kind===kind&&!record.deleted);
const idle=()=>page.waitForFunction(()=>!document.querySelector('[data-action="stop-chat"]')&&!document.querySelector('#chat-input')?.disabled,undefined,{timeout:300000});
const nav=async name=>{if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();await page.locator(`.nav [data-page="${name}"]`).click();};
const send=async text=>{await page.locator('#chat-input').fill(text);await page.locator('#chat-form').evaluate(form=>form.requestSubmit());};
const screenshot=name=>page.screenshot({path:join(dataDir,name+'.png'),fullPage:true,style:'#toasts{visibility:hidden}'});
let step='temporary account';
try{
  const register=await context.request.post(origin+'/api/auth/register',{data:{name:'聊天视频集成验证',email:`chat-motion-${Date.now()}@example.test`,password:'qa-motion-password-123'}});
  assert.equal(register.status(),201);const {user}=await register.json();
  assert.equal((await context.request.post(origin+'/api/sync',{data:{userId:user.id,changes:[{id:'profile',kind:'profile',baseVersion:0,data:{age:28,sex:'male',height:175,weight:70,goal:'maintain',activity:1.375}}]}})).status(),200);
  const current=await context.request.get(origin+'/api/providers'),{version}=await current.json();
  const provider={id:'chat-motion-qa',presetId:'openai',apiKey:'QA-placeholder-no-external-network',models:[{id:'qa-vision',vision:true}]};
  const config=await context.request.put(origin+'/api/providers',{data:{version,providers:[provider],tasks:{chat:provider.id,motion:provider.id},taskModels:{chat:'qa-vision',motion:'qa-vision'}}});
  assert.equal(config.status(),200,await config.text());
  await page.goto(origin);await page.locator('#chat-input').waitFor();

  step='attach locally and let AI recognize before user confirmation';console.log(step);
  const choosing=page.waitForEvent('filechooser');await page.locator('[data-action="attach"]').click();const chooser=await choosing;
  assert.match(await chooser.element().getAttribute('accept'),/video\/mp4/);await chooser.setFiles(clip);
  await page.locator('#chat-files [data-status="ready"]').waitFor();assert.equal(await page.locator('#chat-files .chat-file-thumb').count(),0);
  await send('QA开始评估：请帮我评价这段视频。');
  await recognitionEntered;
  await nav('nutrition');
  const doneBefore=await page.evaluate(()=>(window.__qaChatEvents||[]).filter(event=>event.type==='done').length);
  releaseRecognition();
  await page.waitForFunction(count=>(window.__qaChatEvents||[]).filter(event=>event.type==='done').length>count,doneBefore);
  assert.equal(await page.locator('[data-chat-motion-confirm]').count(),0,'A background chat must not open its confirmation on another page');
  assert.equal(coachCalls.length,0);assert.equal((await records('motion-assessment')).length,0);
  await nav('chat');
  await page.locator('[data-chat-motion-confirm]').waitFor({timeout:300000});
  assert.equal(await page.locator('#chat-motion-exercise').inputValue(),'squat');
  assert.equal(recognitionCalls.length,1);assert.equal(coachCalls.length,0);assert.equal(toolCalls.length,1);assert.equal(attachmentUploads.length,0);
  assert.equal((await records('motion-assessment')).length,0,'Recognition must not save an assessment before the user confirms');
  assert.equal(motionInputs.filter(body=>body.input).length,0);
  await screenshot('desktop-confirm-action');
  assert.equal(chatBodies[0].messages.at(-1).attachments?.length||0,0);
  assert.equal(chatBodies[0].messages.at(-1).motionVideos.length,1);

  step='correct the AI action and assess using the same extracted skeleton';console.log(step);
  await page.locator('#chat-motion-exercise').selectOption(exercise.id);
  assert.equal(coachCalls.length,0);
  await page.locator('[data-chat-motion-confirm]').click();
  await page.locator('.chat-motion-result [data-action="chat-motion-detail"]').waitFor({timeout:300000});await idle();
  assert.equal(toolCalls.length,1);assert.equal(coachCalls.length,1);assert.equal(attachmentUploads.length,0);
  assert.equal(await page.evaluate(()=>window.__qaPoseExtractions),1,'Confirmation and changing exercise must reuse the real skeleton extraction');
  const originalRequestId=chatBodies.at(-1).requestId;
  await page.locator('.message.assistant').last().locator('[data-action="retry-chat"]').click();
  await page.getByText('已完成本地视频评估，可通过卡片查看详细结果。',{exact:true}).waitFor({timeout:300000});await idle();
  assert.equal(chatBodies.at(-1).requestId,originalRequestId,'Retry must retain the original request ID');
  assert.equal(toolCalls.length,1);assert.equal(coachCalls.length,1,'A failed final summary must not run motion coaching twice');
  assert.equal(motionInputs.filter(body=>body.input).length,1,'Retry must reuse the saved tool result without extracting again');
  assert.equal(await page.locator('.chat-motion-result [data-action="chat-motion-detail"]').count(),1,'A replayed receipt must not duplicate the report card');
  const submission=motionInputs.find(body=>body.input);assert(submission,'Client must submit the real extracted motion input');
  assert.equal(submission.input.actionConfirmed,true,'The submission must carry the real confirmation flag');
  const input=validateMotionCoachRequest(submission.input);assert.equal(input.reviewMode,'guided');assert.equal(input.selectedExerciseId,exercise.id);
  assert.equal(input.poseData.schemaVersion,6);assert.equal(input.poseData.retainedLandmarkIndices.length,17);assert(input.poseData.frameCount>=7);
  assert.equal(input.fullAnalysis.measurements.length,input.poseData.frameCount);
  {
    assert.equal(input.poseData.format,'mediapipe-world17-full');assert.equal(input.fullAnalysis.version,'motion-observations-3d-v1');
    assert.equal(input.fullAnalysis.coordinateSpace,'mediapipe-world-3d');
    assert(input.poseData.frames.some(frame=>frame.worldLandmarks?.some(point=>point&&Math.abs(point[2])>.001)));
  }
  const pipeline=await page.evaluate(()=>({frames:window.__qaChatMotionPipeline.frames.length,sampleFps:window.__qaChatMotionPipeline.sampleFps,delegate:window.__qaChatMotionPipeline.delegate,
    decoder:window.__qaChatMotionPipeline.decoder,modelVersion:window.__qaChatMotionPipeline.modelVersion,timing:window.__qaChatMotionPipeline.timing}));
  assert.equal(pipeline.modelVersion,poseModel.version);assert.equal(pipeline.frames,input.poseData.frameCount);assert.equal(pipeline.sampleFps,7.5);
  const assessments=await records('motion-assessment');assert.equal(assessments.length,1);const assessment=assessments[0];
  const button=page.locator('.chat-motion-result [data-action="chat-motion-detail"]').first();assert.equal(await button.getAttribute('data-report-id'),assessment.id);
  const savedCoach=assessment.data.coach||assessment.data.report?.coach;assert.equal(savedCoach.mode,'guided');assert.equal(savedCoach.action.exerciseId,exercise.id);
  {
    assert.equal(assessment.data.analysis.coordinateSpace,'mediapipe-world-3d');
  }
  const conversations=await records('conversation'),conversation=conversations.find(record=>record.data.messages.some(message=>message.motionVideos?.length));assert(conversation);
  const receipt=conversation.data.messages.flatMap(message=>message.toolResults||[]).find(result=>result.name==='assess_motion_video');assert.equal(receipt.reportId,assessment.id);assert.equal(receipt.poseModel,poseModel.id);assert.equal(assessment.data.analysis.modelVersion,poseModel.version);assert.match(await page.locator('.chat-motion-model').textContent(),new RegExp(poseModel.label));assert.equal(receipt.record,undefined);
  assert.equal(conversation.data.messages.flatMap(message=>message.motionVideos||[])[0].id,firstVideoId);
  sseEvents.push(...await page.evaluate(()=>window.__qaChatEvents||[]));
  await screenshot('desktop-chat-result');await button.click();await page.locator('.motion-coach-evaluation').waitFor();
  assert.match(await page.locator('[data-motion-results]').textContent(),/QA 模拟：建议调整/);await screenshot('desktop-motion-report');

  step='cancel a second confirmation without another extraction or assessment';console.log(step);
  await nav('chat');await send('QA取消确认：请再次评价刚才的视频。');
  await page.locator('[data-chat-motion-confirm]').waitFor({timeout:300000});
  assert.equal(recognitionCalls.length,2);assert.equal(coachCalls.length,1);
  assert.equal(await page.evaluate(()=>window.__qaPoseExtractions),1,'The same local video cache must serve another confirmation');
  await page.locator('[data-chat-motion-cancel]').click();await idle();
  assert.equal(await page.locator('.chat-motion-confirm').count(),0);assert.equal(coachCalls.length,1);assert.equal((await records('motion-assessment')).length,1);
  assert.equal(toolReceipts.at(-1).ok,false);assert.match(toolReceipts.at(-1).message,/取消/);

  step='reload and open the persisted report without the original local file';console.log(step);
  await page.reload();await page.locator('.nav [data-page="chat"]').waitFor();await nav('chat');
  await page.locator(`#history-list [data-action="open-chat"][data-id="${conversation.id}"]`).click();
  const restored=page.locator(`.chat-motion-result [data-report-id="${assessment.id}"]`);await restored.waitFor();await restored.click();
  await page.locator('.motion-coach-evaluation').waitFor();assert.match(await page.locator('[data-motion-results]').textContent(),/QA 模拟：建议调整/);
  assert.equal(coachCalls.length,1);await screenshot('desktop-restored-report');

  step='missing local media returns a recoverable failure without another AI evaluation';console.log(step);
  await nav('chat');await page.locator(`#history-list [data-action="open-chat"][data-id="${conversation.id}"]`).click();
  await send('QA重新评估：请再评估一次刚才的徒手深蹲。');await idle();
  await page.getByText('本地视频已不可用，请重新选择视频后重试。',{exact:true}).waitFor();
  assert.equal(toolCalls.length,3);assert.equal(coachCalls.length,1);assert.equal((await records('motion-assessment')).length,1);
  assert.equal(toolReceipts.at(-1).ok,false);assert.equal(attachmentUploads.length,0);
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await screenshot('mobile-chat-result');
  sseEvents.push(...await page.evaluate(()=>window.__qaChatEvents||[]));
  await Promise.all(responseReads);assert(sseEvents.some(event=>event.type==='motion_request'&&event.poseModel===poseModel.id&&!event.exerciseId));assert(sseEvents.some(event=>event.type==='motion_progress'));
  assert.deepEqual(externalRequests,[]);assert.deepEqual(errors,[]);
  for(const [file,hash]of Object.entries(servedCodeHashes))assert.equal(hash,codeHashes[file],`Production ${file} changed during the frozen QA run`);
  const result={passed:true,scope:'Real selected pose model and UI integration with local mock chat/tool/coach AI; no form-accuracy or paid-model claim.',poseModel:poseModel.id,exerciseId:exercise.id,dataDir,codeHashes,servedCodeHashes,
    sourceVideoSha256:sha(await readFile(clip)),pipeline,videoId:firstVideoId,reportId:assessment.id,chatRequests:chatBodies.length,nativeToolCalls:toolCalls.length,
    mockCoachCalls:coachCalls.length,mockRecognitionCalls:recognitionCalls.length,poseExtractions:1,simulatedFinalSummaryFailures:1,retryKeptRequestId:true,originalVideoUploads:attachmentUploads.length,sseEvents,
    instrumentation:'Read-only wrappers capture the real analyzeVideo return and real consumeChatEvents callback; original algorithms and callbacks are invoked unchanged.',motionInput:{frames:input.poseData.frameCount,sampleFps:input.poseData.sampleFps,images:input.keyframes.length,
      schemaVersion:input.poseData.schemaVersion,coordinateSpace:input.fullAnalysis.coordinateSpace,measurements:input.fullAnalysis.measurements.length},checks:['Video upload retained as local metadata; no image preview or attachment POST',
      'AI suggested squat before assessment; user corrected to the selected exercise and confirmed','No guided AI call or saved report before confirmation; same skeleton extracted once','Native tool emitted SSE motion_request and motion_progress','Real selected pose model and confirmed exercise sent to existing guided coach',
      'Background recognition waits until the originating chat is visible before showing confirmation','Cancelling another confirmation removes the dialog and saves no additional report',
      'Report stored once; compact chat receipt opens matching motion detail','Final-summary 500 then retry reuses the saved result without extra extraction/coaching',
      'Reload retains report while local video is absent','Missing local video gives actionable failure without extra model coaching','390px layout and no external browser requests'],errors};
  await writeFile(join(dataDir,'results.json'),JSON.stringify(result,null,2));await writeFile(join(dataDir,'mock-provider-trace.json'),JSON.stringify({chat:upstream,recognition:recognitionCalls,coaching:coachCalls,toolCalls,toolReceipts},null,2));
  console.log(JSON.stringify(result));
}catch(error){await screenshot('failure').catch(()=>{});await writeFile(join(dataDir,'failure.json'),JSON.stringify({step,error:error.stack,codeHashes,servedCodeHashes,errors,chatBodies,motionInputs:motionInputs.map(body=>({error:body.error,hasInput:Boolean(body.input)})),toolCalls,toolReceipts},null,2));console.error('FAILED STEP:',step,'artifacts:',dataDir);throw error;}
finally{await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
