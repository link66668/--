// UI lifecycle tests with a minimal DOM and explicit local-analysis doubles.
// They exercise asynchronous cancellation and caching, not rendering/model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {motionExercises,getMotionExercise} from '../public/motion-catalog.js';
import {createMotionFramePlayer as createRealFramePlayer} from '../public/motion-frame-player.js?real-suspend-tests';

const mocks={
  'motion-video.js':`export const MOTION_VIDEO_LIMITS={maxDuration:120,maxBytes:104857600}; export const validateVideoFile=()=>{}; export const scaledVideoSize=(width,height)=>({width,height}); export const analyzeVideo=(...args)=>globalThis.__guidedView.analyze(...args);`,
  'motion-media.js':`export const MOTION_VIDEO_ACCEPT='video/mp4'; export const releasePreparedMotionVideo=file=>globalThis.__guidedView.released.push(file); export const validateVideoMetadata=()=>{}; export const prepareMotionVideo=(...args)=>globalThis.__guidedView.prepare(...args);`,
  'motion-evidence.js':`export const buildMotionEvidence=(...args)=>globalThis.__guidedView.evidence(...args);`,
  'motion-pose-data.js':`export const buildMotionPoseData=p=>({frameCount:p.frames.length,frames:p.frames}); export const buildFullMotionAnalysis=a=>a;`,
  'motion-frame-player.js':`export const createMotionFramePlayer=(...args)=>globalThis.__guidedView.createPlayer(...args);`,
};
const hooks=registerHooks({load(url,context,next){
  const name=url.slice(url.lastIndexOf('/')+1),source=url.includes('/public/')&&mocks[name];
  return source?{format:'module',source,shortCircuit:true}:next(url,context);
}});
const {mountMotionView}=await import('../public/motion-view.js?guided-ui-tests');
hooks.deregister();

class Element {
  constructor(selector=''){this.selector=selector;this.children=new Map();this.handlers=new Map();this.hidden=false;this.disabled=false;this.checked=true;this.value='';this.style={};this.dataset={};this.textContent='';this.innerHTML='';this.readyState=2;this.duration=2;this.videoWidth=640;this.videoHeight=480;this.currentTime=0;this.paused=true;this.seeking=false;this.classList={add(){},remove(){}};}
  querySelector(selector){if(!this.children.has(selector))this.children.set(selector,new Element(selector));return this.children.get(selector);}
  addEventListener(type,fn,options={}){const list=this.handlers.get(type)||[];list.push({fn,options});this.handlers.set(type,list);}
  fire(type,extra={}){for(const {fn,options} of this.handlers.get(type)||[])if(!options.signal?.aborted)fn({target:this,preventDefault(){},...extra});}
  setAttribute(name,value){this[name]=value;}
  removeAttribute(name){delete this[name];}
  getContext(){return null;}
  replaceChildren(){this.innerHTML='';}
  pause(){this.paused=true;}
  load(){if(this.src){this.fire('loadedmetadata');this.fire('loadeddata');}}
  focus(){}
  scrollIntoView(){this.scrollCount=(this.scrollCount||0)+1;}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<30;i++){if(predicate())return;await flush();}assert.fail('UI operation did not settle');}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function pipeline(){return {width:640,height:480,duration:2,sampleFps:7.5,sourceFps:30,frames:[0,1].map(time=>({time,personCount:1,landmarks:Array.from({length:33},(_,i)=>({x:.2+(i%5)*.1,y:.2+Math.floor(i/5)*.06,visibility:1})),subjectTracking:{status:'locked',trackId:'target',confidence:.9,bbox:{xMin:.2,yMin:.2,xMax:.7,yMax:.8}}})),targetTracking:{coverage:1}};}
function recognition(id='squat'){return {mode:'recognize',action:{status:id?'identified':'unknown',exerciseId:id,name:getMotionExercise(id)?.name||'',confidence:id?.9:null,evidenceTimes:[0]}};}
function coach(id){const exercise=getMotionExercise(id);return {mode:'guided',action:{exerciseId:id,name:exercise.name,family:exercise.family,status:'selected',confidence:null,source:'user'},selectionCheck:{status:'consistent',evidenceTimes:[0],evidence:'画面中的动作与用户所选动作一致。'},coverage:{complete:true,strategy:'guided-evidence'},verdict:{status:'needs-improvement',summary:'请控制动作。'},feedback:[{status:'improve',source:'combined',title:'动作节奏',evidence:'画面及骨架中可见动作节奏不稳定。',correction:'减慢动作并保持可控。',evidenceTimes:[0]}]};}
function setup(t,{realPlayer=false,config={configured:true,vision:true,provider:'mock',model:'mock'}}={}){
  const previous={window:globalThis.window,cancelAnimationFrame:globalThis.cancelAnimationFrame,requestAnimationFrame:globalThis.requestAnimationFrame,createImageBitmap:globalThis.createImageBitmap};
  const h={analysisCalls:[],evidenceCalls:[],reviewCalls:[],saved:[],analysisQueue:[],evidenceQueue:[],reviewQueue:[],messages:[],historyValues:[],historyQueue:[],historyCalls:0,prepareCalls:[],prepareQueue:[],released:[],config,raf:new Map(),nextRaf:0};
  globalThis.window=new Element();globalThis.cancelAnimationFrame=id=>h.raf.delete(id);globalThis.requestAnimationFrame=fn=>{const id=++h.nextRaf;h.raf.set(id,fn);return id;};
  h.prepare=async(file,options)=>{h.prepareCalls.push({file,options});return h.prepareQueue.shift()?.promise??{mode:'native',file};};
  h.analyze=async(file,options)=>{h.analysisCalls.push({file,options});return h.analysisQueue.shift()?.promise??pipeline();};
  h.evidence=async(file,p,base,options)=>{h.evidenceCalls.push({file,pipeline:p,options});return h.evidenceQueue.shift()?.promise??{summary:{quality:base.quality},images:[{time:0,imageTime:0,mimeType:'image/jpeg',dataUrl:'data:image/jpeg;base64,AAAA'}]};};
  h.createPlayer=options=>{
    if(realPlayer){options.canvas.getContext=()=>({drawImage(){},clearRect(){}});return h.player=createRealFramePlayer(options);}
    return h.player={ready:false,seeking:false,currentTime:0,pauseCalls:0,clearCalls:0,destroyed:false,pause(){this.pauseCalls++;},clear(){this.clearCalls++;},destroy(){this.destroyed=true;},setDisabled(value){if(value)this.pause();},setSource:async()=>true,setFrames:async()=>{}};
  };
  globalThis.__guidedView=h;
  const container=new Element(),root=container.querySelector('.motion-page');
  const view=mountMotionView(container,{getCoachConfiguration:()=>h.config,reviewAssessment:async(body,options)=>{h.reviewCalls.push({body,options});return h.reviewQueue.shift()?.promise??(body.reviewMode==='recognize'?recognition():coach(body.selectedExerciseId));},saveAssessment:async report=>{h.saved.push(report);},listAssessments:async()=>{h.historyCalls++;return h.historyQueue.shift()?.promise??h.historyValues;},notify:message=>h.messages.push(message)});
  h.root=root;h.container=container;h.view=view;h.find=selector=>root.querySelector(selector);
  h.select=id=>{const input=h.find('[data-motion-exercise]');input.value=id;input.fire('change');};
  h.click=action=>{const button=h.find(`[data-motion-action="${action}"]`);button.dataset.motionAction=action;button.closest=()=>button;root.fire('click',{target:button});};
  h.file=async(name='clip.mp4')=>{const input=h.find('[data-motion-file]');input.files=[new File(['fixture'],name,{type:'video/mp4'})];input.fire('change');await flush();};
  h.confirming=()=>!h.find('[data-motion-confirmation]').hidden&&!h.find('[data-motion-action="confirm-exercise"]').disabled;
  h.assess=async()=>{h.click('analyze');await until(h.confirming);h.click('confirm-exercise');await until(h.finished);};
  h.finished=()=>!h.find('[data-motion-results]').hidden && h.find('[data-motion-results]').innerHTML.includes('motion-coach-evaluation');
  t.after(()=>{view.destroy();delete globalThis.__guidedView;Object.assign(globalThis,previous);});
  return h;
}

test('video recognition preselects a catalog exercise but never evaluates or saves until confirmation',async t=>{
  const h=setup(t);
  for(const exercise of motionExercises)assert(h.container.innerHTML.includes(`<option value="${exercise.id}">${exercise.name}</option>`),exercise.id);
  await h.file();assert.equal(h.find('[data-motion-action="analyze"]').disabled,false);
  h.click('analyze');await until(h.confirming);
  assert.equal(h.reviewCalls.length,1);assert.equal(h.reviewCalls[0].body.reviewMode,'recognize');assert.equal('selectedExerciseId' in h.reviewCalls[0].body,false);
  assert.equal(h.find('[data-motion-exercise]').value,'squat');assert.match(h.find('[data-motion-recognition]').textContent,/AI 识别为：徒手深蹲/);
  assert.equal(h.finished(),false);h.click('save');await flush();assert.equal(h.saved.length,0);
  h.select('pushup');h.click('confirm-exercise');await until(h.finished);
  assert.equal(h.reviewCalls[1].body.reviewMode,'guided');assert.equal(h.reviewCalls[1].body.selectedExerciseId,'pushup');
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1);
  h.click('save');await until(()=>h.saved.length===1);assert.equal(h.saved[0].coach.action.exerciseId,'pushup');
});

test('changing an evaluated exercise requires confirmation and reuses local pose and pictures',async t=>{
  const h=setup(t);await h.file();await h.assess();
  h.click('coach');await until(h.confirming);h.select('pushup');
  assert.equal(h.finished(),false);assert.equal(h.reviewCalls.length,2);h.click('save');await flush();assert.equal(h.saved.length,0);
  h.click('confirm-exercise');await until(h.finished);
  assert.equal(h.reviewCalls.length,3);assert.equal(h.reviewCalls[2].body.selectedExerciseId,'pushup');
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1);
});

test('unknown recognition enables manual selection and requires a valid choice',async t=>{
  const h=setup(t),unknown=deferred();h.reviewQueue.push(unknown);await h.file();h.click('analyze');await until(()=>h.reviewCalls.length===1);
  unknown.resolve(recognition(null));await until(()=>!h.find('[data-motion-confirmation]').hidden);
  assert.equal(h.find('[data-motion-action="confirm-exercise"]').disabled,true);assert.equal(h.find('[data-motion-exercise]').value,'');
  h.select('not-a-catalog-id');h.click('confirm-exercise');await flush();assert.equal(h.reviewCalls.length,1);
  h.select('pushup');h.click('confirm-exercise');await until(h.finished);assert.equal(h.reviewCalls[1].body.selectedExerciseId,'pushup');
});

test('recognition failure allows retry or manual confirmation with the prepared data',async t=>{
  const h=setup(t),failure=deferred();h.reviewQueue.push(failure);await h.file();h.click('analyze');await until(()=>h.reviewCalls.length===1);
  failure.reject(new Error('offline'));await until(()=>!h.find('[data-motion-confirmation]').hidden);
  assert.equal(h.find('[data-motion-coach-retry]').hidden,false);assert.equal(h.finished(),false);
  h.select('squat');h.click('confirm-exercise');await until(h.finished);
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1);
});

test('changing the selected action aborts an evaluation and ignores a late response',async t=>{
  const h=setup(t);await h.file();h.click('analyze');await until(h.confirming);
  const old=deferred();h.reviewQueue.push(old);h.click('confirm-exercise');await until(()=>h.reviewCalls.length===2);
  h.select('pushup');assert.equal(h.reviewCalls[1].options.signal.aborted,true);assert.equal(h.finished(),false);
  h.click('confirm-exercise');await until(h.finished);old.resolve(coach('squat'));await flush();
  assert.match(h.find('[data-motion-results]').innerHTML,/你选择的动作：俯卧撑/);assert.equal(h.analysisCalls.length,1);
});

test('changing a video discards stale recognition and cached evidence',async t=>{
  const h=setup(t),old=deferred();h.reviewQueue.push(old);await h.file('first.mp4');h.click('analyze');await until(()=>h.reviewCalls.length===1);
  await h.file('second.mp4');assert.equal(h.reviewCalls[0].options.signal.aborted,true);
  old.resolve(recognition('pushup'));await flush();assert.equal(h.find('[data-motion-confirmation]').hidden,true);
  h.click('analyze');await until(h.confirming);assert.equal(h.find('[data-motion-exercise]').value,'squat');
  assert.equal(h.analysisCalls.length,2);assert.equal(h.evidenceCalls.length,2);assert.equal(h.evidenceCalls[1].file.name,'second.mp4');
});

test('recognition cancellation remains retryable without repeating pose or images',async t=>{
  const h=setup(t),old=deferred();h.reviewQueue.push(old);await h.file();h.click('analyze');await until(()=>h.reviewCalls.length===1);
  h.click('cancel-coach');assert.equal(h.reviewCalls[0].options.signal.aborted,true);h.click('retry-coach');await until(h.confirming);
  old.resolve(recognition('pushup'));await flush();assert.equal(h.find('[data-motion-exercise]').value,'squat');
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1);assert.equal(h.finished(),false);
});

test('a response for a different confirmed exercise is rejected and stays unsaved',async t=>{
  const h=setup(t);await h.file();h.click('analyze');await until(h.confirming);
  const wrong=deferred();h.reviewQueue.push(wrong);h.click('confirm-exercise');await until(()=>h.reviewCalls.length===2);
  wrong.resolve(coach('pushup'));await until(()=>h.find('[data-motion-coach-error]').textContent.includes('与所选动作不一致'));
  assert.equal(h.finished(),false);h.click('save');await flush();assert.equal(h.saved.length,0);assert.equal(h.confirming(),true);
});

test('pose-model and target changes discard recognition and require new extraction',async t=>{
  const h=setup(t);await h.file();h.click('analyze');await until(h.confirming);
  const input=h.find('[data-motion-pose-model]');input.value='mediapipe-heavy';input.fire('change');
  assert.equal(h.find('[data-motion-confirmation]').hidden,true);assert.equal(h.find('[data-motion-exercise]').value,'');
  h.click('analyze');await until(h.confirming);assert.equal(h.analysisCalls.length,2);assert.equal(h.analysisCalls[1].options.model,'mediapipe-heavy');
  h.click('reset-target');assert.equal(h.find('[data-motion-confirmation]').hidden,true);
  h.click('analyze');await until(h.confirming);assert.equal(h.analysisCalls.length,3);
});

function savedReport(id,exerciseId='squat'){
  return {id,data:{exerciseId,recognitionSource:'user',createdAt:'2026-01-01T00:00:00Z',video:{duration:2},coach:coach(exerciseId)}};
}

test('openReport refreshes records, opens the exact saved ID and scrolls to it',async t=>{
  const h=setup(t);await flush();
  h.historyValues=[savedReport('other'),savedReport('requested','pushup')];
  assert.equal(await h.view.openReport('requested'),true);
  assert.equal(h.historyCalls,2,'Mount and open each read current history');
  assert.match(h.find('[data-motion-results]').innerHTML,/你选择的动作：俯卧撑/);
  assert.equal(h.find('[data-motion-results]').hidden,false);
  assert.equal(h.find('[data-motion-results]').scrollCount,1);
});

test('openReport never substitutes another saved report when its ID was deleted',async t=>{
  const h=setup(t);h.historyValues=[savedReport('old','pushup')];
  assert.equal(await h.view.openReport('old'),true);
  h.historyValues=[savedReport('different')];
  assert.equal(await h.view.openReport('old'),false);
  assert.equal(h.find('[data-motion-results]').hidden,true);assert.equal(h.find('[data-motion-results]').innerHTML,'');
  assert.match(h.messages.at(-1),/报告已删除或不存在/);
});

test('openReport reports a history read failure without presenting stale data',async t=>{
  const h=setup(t);await flush();const read=deferred();h.historyQueue.push(read);
  const opened=h.view.openReport('old');read.reject(new Error('offline'));
  assert.equal(await opened,false);assert.match(h.messages.at(-1),/读取动作评估报告失败/);
  assert.equal(h.find('[data-motion-results]').hidden,true);
});

test('only the latest requested report can publish after competing history reads',async t=>{
  const h=setup(t);await flush();const first=deferred(),second=deferred();h.historyQueue.push(first,second);
  const old=h.view.openReport('first'),latest=h.view.openReport('second');
  second.resolve([savedReport('second','pushup')]);assert.equal(await latest,true);
  first.resolve([savedReport('first')]);assert.equal(await old,false);
  assert.match(h.find('[data-motion-results]').innerHTML,/你选择的动作：俯卧撑/);assert.equal(h.messages.length,0);
  assert.equal(h.find('[data-motion-results]').scrollCount,1);
});

test('a background history refresh cannot cancel or misdirect the latest report jump',async t=>{
  const h=setup(t);await flush();const first=deferred(),sync=deferred();h.historyQueue.push(first,sync);
  const opened=h.view.openReport('requested'),refreshed=h.view.refreshHistory();
  first.resolve([savedReport('old')]);await flush();assert.equal(h.messages.length,0);
  sync.resolve([savedReport('other'),savedReport('requested','pushup')]);await refreshed;
  assert.equal(await opened,true);assert.match(h.find('[data-motion-results]').innerHTML,/你选择的动作：俯卧撑/);
  assert.equal(h.messages.length,0);
});

test('choosing another video or destroying the view invalidates a pending report jump',async t=>{
  const h=setup(t);await flush();const first=deferred();h.historyQueue.push(first);
  const opened=h.view.openReport('first');await h.file();first.resolve([savedReport('first')]);
  assert.equal(await opened,false);assert.equal(h.find('[data-motion-results]').hidden,true);
  const second=deferred();h.historyQueue.push(second);const destroyed=h.view.openReport('second');h.view.destroy();second.resolve([savedReport('second')]);
  assert.equal(await destroyed,false);assert.equal(await h.view.openReport('second'),false);
});

test('suspend keeps pending video preparation and resume preserves the selected local file',async t=>{
  const h=setup(t),prepared=deferred();h.prepareQueue.push(prepared);h.select('squat');
  assert.equal(h.view.hasUnsavedWork(),false);await h.file('kept.mp4');
  const {file,options}=h.prepareCalls[0],releases=h.released.length;
  h.view.suspend();h.view.suspend();assert.equal(options.signal.aborted,false);
  assert.equal(h.view.hasUnsavedWork(),true);assert.equal(h.released.length,releases);
  prepared.resolve({mode:'native',file});await until(()=>h.find('[data-motion-progress]').hidden);
  h.view.resume();
  assert.match(h.find('[data-motion-metadata]').innerHTML,/kept.mp4/);
  assert.equal(h.find('[data-motion-exercise]').value,'');assert.equal(h.find('[data-motion-action="analyze"]').disabled,false);
  assert.equal(h.prepareCalls.length,1);assert.equal(h.analysisCalls.length,0);assert.equal(h.reviewCalls.length,0);
});

test('suspend and resume do not cancel a software first-frame bitmap being prepared',async t=>{
  const h=setup(t,{realPlayer:true}),prepared=deferred(),bitmap=deferred();let closes=0;
  globalThis.createImageBitmap=()=>bitmap.promise;h.prepareQueue.push(prepared);h.select('squat');await h.file('phone.mov');
  prepared.resolve({mode:'software',poster:new Blob(['poster']),metadata:{duration:2,width:640,height:480}});
  await until(()=>h.player.seeking);h.view.suspend();h.view.resume();
  bitmap.resolve({width:640,height:480,close(){closes++;}});
  await until(()=>h.player.ready&&!h.find('[data-motion-action="analyze"]').disabled);
  assert.match(h.find('[data-motion-metadata]').innerHTML,/phone.mov/);assert.equal(closes,1);
  assert.equal(h.prepareCalls[0].options.signal.aborted,false);assert.equal(h.find('[data-motion-frame-controls]').hidden,false);
});

test('native and software playback pause without resetting position or restarting animation',async t=>{
  const h=setup(t);h.select('squat');await h.file();
  const video=h.find('[data-motion-video]'),url=video.src;video.currentTime=1.25;video.paused=false;video.fire('play');
  h.player.currentTime=1.1;const clears=h.player.clearCalls;assert.equal(h.raf.size,1);
  h.view.suspend();assert.equal(video.paused,true);assert.equal(h.raf.size,0);
  h.view.resume();h.view.resume();
  assert.equal(video.currentTime,1.25);assert.equal(video.src,url);assert.equal(video.paused,true);
  assert.equal(h.player.currentTime,1.1);assert.equal(h.player.clearCalls,clears);assert.equal(h.raf.size,0);
  assert.equal(h.analysisCalls.length,0);
});

test('analysis completes while suspended without clearing data or notifying another page',async t=>{
  const h=setup(t),pose=deferred();h.analysisQueue.push(pose);h.select('squat');await h.file();h.click('analyze');
  await until(()=>h.analysisCalls.length===1);h.view.suspend();assert.equal(h.analysisCalls[0].options.signal.aborted,false);
  pose.resolve(pipeline());await until(h.confirming);assert.equal(h.finished(),false);h.click('confirm-exercise');await until(h.finished);
  assert.equal(h.messages.length,0);assert.equal(h.view.hasUnsavedWork(),true);h.view.resume();
  assert.match(h.find('[data-motion-results]').innerHTML,/你选择的动作：徒手深蹲/);
  assert.equal(h.analysisCalls.length,1);assert.equal(h.reviewCalls.length,2);
  h.click('coach');h.select('pushup');h.click('confirm-exercise');await until(()=>h.reviewCalls.length===3&&h.finished());
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1,'Screenshots also survive detachment');
  h.click('save');await until(()=>h.saved.length===1);assert.equal(h.view.hasUnsavedWork(),false);
});

test('AI and evidence requests continue through suspend; resume never repeats them',async t=>{
  const h=setup(t),images=deferred(),review=deferred();h.evidenceQueue.push(images);h.reviewQueue.push(review);
  h.select('squat');await h.file();h.click('analyze');await until(()=>h.evidenceCalls.length===1);
  h.view.suspend();assert.equal(h.evidenceCalls[0].options.signal.aborted,false);
  images.resolve({summary:{},images:[{time:0,mimeType:'image/jpeg',dataUrl:'data:image/jpeg;base64,AAAA'}]});
  await until(()=>h.reviewCalls.length===1);h.view.resume();h.view.suspend();
  assert.equal(h.reviewCalls[0].options.signal.aborted,false);review.resolve(recognition());await until(h.confirming);assert.equal(h.finished(),false);
  assert.equal(h.messages.length,0);h.view.resume();
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1);assert.equal(h.reviewCalls.length,1);
});

test('returning from settings reads current model configuration without automatically evaluating',async t=>{
  const h=setup(t,{config:{configured:false,vision:false}});h.select('squat');await h.file();
  assert.equal(h.find('[data-motion-action="analyze"]').disabled,true);h.view.suspend();
  h.config={configured:true,vision:true,provider:'Updated provider',model:'new model'};h.view.resume();
  assert.match(h.find('[data-motion-coach-description]').textContent,/Updated provider · new model/);
  assert.equal(h.find('[data-motion-action="analyze"]').disabled,false);assert.equal(h.analysisCalls.length,0);assert.equal(h.reviewCalls.length,0);
  await h.assess();h.view.suspend();h.config={configured:true,vision:false};h.view.resume();
  assert.equal(h.find('[data-motion-action="analyze"]').disabled,true);assert.match(h.find('[data-motion-coach-description]').textContent,/不支持图片/);
  assert.equal(h.finished(),true);assert.equal(h.reviewCalls.length,2);
  h.config={configured:true,vision:true,provider:'Another',model:'model'};h.view.refreshConfiguration();
  await h.assess();assert.equal(h.reviewCalls.length,3);
  assert.equal(h.analysisCalls.length,1);assert.equal(h.evidenceCalls.length,1);
});

test('hidden report reads never scroll or notify, and deleted reports preserve the unsaved live result',async t=>{
  const h=setup(t);h.select('squat');await h.file();await h.assess();
  const notices=h.messages.length;h.view.suspend();h.historyValues=[savedReport('saved','pushup')];
  assert.equal(await h.view.openReport('saved'),true);assert.equal(h.find('[data-motion-results]').scrollCount,undefined);
  h.historyValues=[];assert.equal(await h.view.openReport('deleted'),false);
  assert.equal(h.messages.length,notices);assert.match(h.find('[data-motion-results]').innerHTML,/你选择的动作：徒手深蹲/);
  assert.equal(h.view.hasUnsavedWork(),true);h.view.resume();
  assert.equal(h.find('[data-motion-results]').hidden,false);assert.match(h.find('[data-motion-error]').textContent,/报告已删除/);
});

for(const stage of ['prepare','analysis','review'])test(`destroy still aborts ${stage} after suspension and ignores a late result`,async t=>{
  const h=setup(t),pending=deferred();
  h[stage==='prepare'?'prepareQueue':stage==='analysis'?'analysisQueue':'reviewQueue'].push(pending);
  h.select('squat');await h.file();if(stage!=='prepare')h.click('analyze');
  const calls=h[stage==='prepare'?'prepareCalls':stage==='analysis'?'analysisCalls':'reviewCalls'];
  await until(()=>calls.length===1);h.view.suspend();assert.equal(calls[0].options.signal.aborted,false);
  h.view.destroy();assert.equal(calls[0].options.signal.aborted,true);assert.equal(h.view.hasUnsavedWork(),false);
  pending.resolve(stage==='prepare'?{mode:'native',file:calls[0].file}:stage==='analysis'?pipeline():coach('squat'));await flush();
  h.view.resume();assert.equal(h.messages.length,0);assert.equal(h.player.destroyed,true);assert.equal(h.finished(),false);
});

test('awaiting confirmation survives navigation without another recognition or premature evaluation',async t=>{
  const h=setup(t);await h.file();h.click('analyze');await until(h.confirming);h.select('pushup');
  h.view.suspend();h.view.resume();assert.equal(h.confirming(),true);assert.equal(h.find('[data-motion-exercise]').value,'pushup');
  assert.equal(h.reviewCalls.length,1);assert.equal(h.finished(),false);h.click('confirm-exercise');await until(h.finished);
  assert.equal(h.reviewCalls[1].body.selectedExerciseId,'pushup');assert.equal(h.analysisCalls.length,1);
});

test('no-finding reports hide uncertain copy, limitations and praise',async t=>{
  const h=setup(t);await h.file();h.click('analyze');await until(h.confirming);
  const reviewed=deferred();h.reviewQueue.push(reviewed);h.click('confirm-exercise');await until(()=>h.reviewCalls.length===2);
  reviewed.resolve({...coach('squat'),selectionCheck:{status:'uncertain',evidence:'无法确认所选动作',evidenceTimes:[0]},verdict:{status:'uncertain',summary:'无法评估动作'},feedback:[{status:'uncertain',title:'脚部遮挡',evidence:'无法判断',correction:'补拍',evidenceTimes:[0]}],limitations:['无法评估动作，请补拍']});
  await until(h.finished);const html=h.find('[data-motion-results]').innerHTML;
  assert.match(html,/暂时找不出问题/);assert.doesNotMatch(html,/无法评估|无法判断|补拍|脚部遮挡|无法确认/);
});
