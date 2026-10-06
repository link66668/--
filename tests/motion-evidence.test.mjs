import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMotionEvidenceFrames, summarizeMotionAnalysis, buildMotionEvidence, evidenceCropRegion, evidenceSequenceCrop } from '../public/motion-evidence.js';

const frames = Array.from({ length: 151 }, (_, index) => ({ time: index / 15, sourceTime: index / 15, landmarks: [] }));

test('evidence covers video time and observed angle extrema without judging posture',()=>{
 const observations={measurements:[{time:1,left:{elbowAngle:60}},{time:2.023,left:{elbowAngle:10}},{time:8,left:{elbowAngle:170}}]};
 const chosen=selectMotionEvidenceFrames(frames,observations);
 assert.equal(chosen.length,6);assert.equal(chosen[0].time,0);assert.equal(chosen.at(-1).time,10);assert(chosen.some(item=>item.time===5));
 const low=chosen.find(item=>item.time===2),high=chosen.find(item=>item.time===8);
 assert.equal(low.poseTime,2);assert.equal(low.sourceTime,2);
 assert(low.reasons.includes('姿态与时序覆盖'));assert(high.reasons.includes('姿态与时序覆盖'));
});

test('evidence normalizes unsorted duplicate timestamps and bounds image count', () => {
  const chosen = selectMotionEvidenceFrames([frames[80], frames[0], frames[80], frames[150]], {}, { maxImages: 100 });
  assert.equal(chosen.length, 3);
  assert.deepEqual(chosen.map(frame => frame.time), [0, 80 / 15, 10]);
  assert.equal(selectMotionEvidenceFrames(frames, {}, { maxImages: 2 }).length, 2);
  assert.throws(() => selectMotionEvidenceFrames([]), /分析帧/);
});

test('a single-frame pose glitch does not displace a sustained movement extreme', () => {
  const measurements=frames.map((frame,index)=>({time:frame.time,left:{kneeAngle:index===30?0:index>=90&&index<=100?65:165}}));
  const chosen=selectMotionEvidenceFrames(frames,{measurements});
  assert(chosen.some(item=>item.time>=6&&item.time<=100/15),'retains the real bent-knee phase');
  assert(!chosen.some(item=>item.time===2),'rejects the isolated erroneous angle as an extreme');
  assert(chosen.some(item=>item.time===0)&&chosen.some(item=>item.time===10),'keeps temporal scene coverage');
});

test('old scores and rule failures cannot bias picture selection',()=>{
 const baseline=selectMotionEvidenceFrames(frames,{});
 const polluted=selectMotionEvidenceFrames(frames,{score:1,reps:[{start:2,end:4,bottom:3,score:0}],checks:[{status:'fail',critical:true,evidenceTimes:[2]}],issues:[{time:7,code:'OLD_RULE',severity:'severe'}],visualReviewRequests:[{evidenceTimes:[8]}]});
 assert.deepEqual(polluted,baseline);
});

test('tracked evidence excludes lost people, keeps one identity and refuses legacy multiple people', () => {
  const tracking = { status: 'locked', trackId: 'motion-target-1', confidence: 0.9, bbox: { xMin: 0.2, yMin: 0.1, xMax: 0.5, yMax: 0.9 } };
  const tracked = frames.map(frame => ({ ...frame, personCount: 2, subjectTracking: { ...tracking, status: frame.time > 3 && frame.time < 7 ? 'lost' : 'locked' } }));
  const chosen = selectMotionEvidenceFrames(tracked, { checks: [{ code: 'NECK', status: 'fail', evidenceTimes: [5] }] });
  assert(chosen.every(item => item.poseTime <= 3 || item.poseTime >= 7));
  assert(chosen.every(item => item.subjectTracking.trackId === 'motion-target-1'));
  assert(!chosen.some(item => item.reasons.includes('问题：NECK')));
  assert.throws(() => selectMotionEvidenceFrames([{ time: 0, personCount: 2 }]), /多个人/);
  assert.throws(() => selectMotionEvidenceFrames([{ time: 0, subjectTracking: tracking }, { time: 1, subjectTracking: { ...tracking, trackId: 'someone-else' } }]), /身份发生变化/);
});

test('target crop includes context and maps normalized original-image coordinates', () => {
  const box = { xMin: 0.3, yMin: 0.1, xMax: 0.6, yMax: 0.9 }, crop = evidenceCropRegion(box);
  assert(crop.xMin < box.xMin && crop.xMax > box.xMax);
  assert(crop.yMin < box.yMin && crop.yMax > box.yMax);
  assert(crop.xMin >= 0 && crop.yMin >= 0 && crop.xMax <= 1 && crop.yMax <= 1);
  assert.deepEqual(evidenceCropRegion(null), { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
});

test('a sequence crop retains both movement extremes in one fixed camera region', () => {
 const boxes=[{xMin:.2,yMin:.2,xMax:.5,yMax:.8},{xMin:.4,yMin:.4,xMax:.7,yMax:.95}];
 const crop=evidenceSequenceCrop(boxes.map(bbox=>({subjectTracking:{bbox}})));
 assert(crop.xMin<.2&&crop.xMax>.7&&crop.yMin<.2&&crop.yMax>=.95);
 assert.deepEqual(evidenceSequenceCrop([]),evidenceCropRegion(null));
});

test('extracted evidence retains two complete scenes for equipment and keeps the tracked target', async () => {
  const previousDocument = globalThis.document, draws = [];
  class Video extends EventTarget {
    duration = 10; videoWidth = 1000; videoHeight = 1000; readyState = 4; time = 0;
    get currentTime() { return this.time; }
    set currentTime(value) { this.time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
    pause() {}
    removeAttribute() { this.src = ''; }
  }
  const box = { xMin: .45, yMin: .32, xMax: .65, yMax: .7 };
  const tracked = frames.map(frame => ({ ...frame, subjectTracking: { status: 'locked', trackId: 'target', confidence: .95, bbox: box } }));
  globalThis.document = { createElement(tag) {
    if (tag === 'video') return new Video();
    const context = { drawImage(...args) { draws.push(args.slice(1, 5)); }, strokeRect() {}, fillRect() {}, fillText() {} };
    return { width: 0, height: 0, getContext: () => context, toBlob: callback => callback(new Blob(['image'], { type: 'image/jpeg' })) };
  } };
  try {
    const result = await buildMotionEvidence(new File(['video'], 'row.mp4', { type: 'video/mp4' }), { duration: 10, width: 1000, height: 1000, frames: tracked }, {});
    const scenes = result.images.filter(image => image.crop.xMin === 0 && image.crop.yMin === 0 && image.crop.xMax === 1 && image.crop.yMax === 1);
    assert.equal(scenes.length, 2, 'two different instants must retain apparatus outside the body box');
    assert(scenes[0].time < scenes[1].time);
    assert(result.images.length <= 6);
    assert(result.images.every(image => image.subjectTracking.trackId === 'target'));
    assert(result.images.some(image => image.crop.xMin > 0), 'other frames retain detail crops');
    const details=result.images.filter(image=>image.framing==='target-detail');
    assert(details.every(image=>JSON.stringify(image.crop)===JSON.stringify(details[0].crop)), 'fixed detail crop does not invent body translation');
    assert(scenes.every(image=>image.width===1000), 'full scene preserves available subject detail instead of shrinking to 640');
    assert.equal(draws.filter(([x, y, width, height]) => x === 0 && y === 0 && width === 1000 && height === 1000).length, 2);
    assert.equal(result.summary.evidenceFrames.filter(frame => frame.framing === 'equipment-context').length, 2);
  } finally { globalThis.document = previousDocument; }
});

test('summary contains only observation metadata without duplicated measurements or old judgements',()=>{
 const report={version:'motion-observations-3d-v1',coordinateSpace:'mediapipe-world-3d',quality:{totalFrames:150,validFrames:100,usableRatio:2/3,sourceFps:null,targetCoverage:null,reasons:[],frames:[1,2],score:100},measurements:Array.from({length:150},(_,frameIndex)=>({frameIndex,time:frameIndex/15})),score:100,reps:[{score:99}],checks:[{status:'fail'}],issues:[{message:'old rule'}],exerciseId:'squat',file:'private-name',dataUrl:'data:image/jpeg;base64,ignored'};
 const result=summarizeMotionAnalysis(report,{duration:10,sampleFps:15,sourceFps:null});
 assert.equal(result.version,'motion-observations-3d-v1');assert.equal(result.coordinateSpace,'mediapipe-world-3d');
 assert.equal(result.quality.validFrames,100);assert.equal(result.sourceFps,null);
 assert.deepEqual(Object.keys(result.quality).sort(),['reasons','sourceFps','targetCoverage','totalFrames','usableRatio','validFrames'].sort());
 for(const key of ['score','reps','checks','issues','exerciseId','measurements'])assert.equal(result[key],undefined,key);
 assert(!/landmarks|private-name|data:image|old rule/.test(JSON.stringify(result)));
});

test('repeated source frames cannot become multiple visual evidence times when presentation callbacks are unavailable',async()=>{
 const previous=globalThis.document;
 class Video extends EventTarget{
  duration=.5;videoWidth=200;videoHeight=200;readyState=4;time=0;
  get currentTime(){return this.time;}
  set currentTime(value){this.time=value;queueMicrotask(()=>this.dispatchEvent(new Event('seeked')));}
  load(){if(this.src)queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}
  pause(){} removeAttribute(){this.src='';}
 }
 globalThis.document={createElement(tag){
  if(tag==='video')return new Video();
  return{width:0,height:0,getContext:()=>({drawImage(){}}),toBlob:callback=>callback(new Blob(['image'],{type:'image/jpeg'}))};
 }};
 try{
  const pipeline={duration:.5,width:200,height:200,sampleFps:7.5,frames:[0,1/7.5,2/7.5,3/7.5].map(time=>({time,sourceTime:0,landmarks:[]}))};
  const result=await buildMotionEvidence(new File(['video'],'low-fps.mp4',{type:'video/mp4'}),pipeline,{});
  assert.equal(result.images.length,1);
  assert.equal(result.images[0].time,0);
  assert.equal(result.images[0].imageTime,null,'do not invent a presentation callback result');
  assert.equal(result.images[0].timePrecision,'pose-source-pts');
  assert.equal(result.images[0].frameMappings.length,4);
 }finally{globalThis.document=previous;}
});

test('pre-aborted evidence extraction never accesses video resources', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buildMotionEvidence(null, null, null, { signal: controller.signal }), error => error.name === 'AbortError');
});
