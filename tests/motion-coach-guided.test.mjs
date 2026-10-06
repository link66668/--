import test from 'node:test';
import assert from 'node:assert/strict';
import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData, buildFullMotionAnalysis} from '../public/motion-pose-data.js';
import {mergeCoachAssessment} from '../public/motion-contract.js';
import {validateMotionCoachRequest, completeMotionCoach} from '../server/motion-coach.mjs';
import {buildGuidedMotionContext, MOTION_GUIDED_LIMITS} from '../server/motion-coach-guided.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
const provider = {name: 'Guided fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'vision', models: [{id: 'vision', vision: true}]};
const respond = output => Response.json({choices: [{message: {content: JSON.stringify(output)}, finish_reason: 'stop'}]});
function body(frameCount = 150) {
  const pipeline = toMediaPipePipeline({duration: frameCount / 15, width: 1280, height: 720, sampleFps: 15, sourceFps: 30,
    frames: Array.from({length: frameCount}, (_, index) => ({time: index / 15, personCount: 1,
      landmarks: Array.from({length: 33}, (_, joint) => ({x: .2 + joint / 100 + Math.sin(index / 11 + joint) * .03,
        y: .2 + joint / 90 + Math.cos(index / 13 + joint) * .03, visibility: .98}))}))});
  return {reviewMode: 'guided', selectedExerciseId: 'barbell-deadlift', duration: pipeline.duration,
    poseData: buildMotionPoseData(pipeline), fullAnalysis: buildFullMotionAnalysis(analyzeMotion(pipeline.frames, pipeline), pipeline),
    keyframes: [.8, .2].map(time => ({time, mimeType: 'image/png', data: png}))};
}
const finding = extra => ({title: '负重位置', status: 'good', source: 'visual', imageIndices: [0,1], evidence: '两张画面中杠铃靠近腿部。', correction: '继续保持负重贴近身体。', priority: 1, ...extra});
const output = extra => ({selectionCheck: {status: 'consistent', imageIndices: [0], evidence: '目标训练者双手持杠铃，支撑与所选硬拉相符。'},
  verdict: {status: 'standard'}, feedback: [finding()], ...extra});

test('guided requests require an exact catalog selection and preserve legacy review routes', () => {
  const source = body(20);
  assert.equal(validateMotionCoachRequest(source).selectedExerciseId, 'barbell-deadlift');
  for (const selectedExerciseId of [undefined, null, '', 'unknown', '__proto__', {}, ' barbell-deadlift']) {
    assert.throws(() => validateMotionCoachRequest({...source, selectedExerciseId}), error => error.status === 400);
  }
  for (const reviewMode of ['full', 'efficient', 'temporal', undefined]) {
    const old = {...source, reviewMode}; delete old.selectedExerciseId;
    assert.equal(validateMotionCoachRequest(old).selectedExerciseId, undefined);
    assert.throws(() => validateMotionCoachRequest({...source, reviewMode}), error => error.status === 400);
  }
});

test('guided 10s and 60s reviews use one bounded 17-point package and retain honest coverage', async () => {
  for (const count of [150,900]) {
    const input = validateMotionCoachRequest(body(count)), original = JSON.stringify(input), calls = [], progress = [];
    const coach = await completeMotionCoach({provider, input, onProgress: event => progress.push(event), fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body), context = JSON.parse(request.messages[1].content[0].text);
      calls.push({request, context});
      return respond(output({action: {exerciseId: 'curl', name: '哑铃弯举', status: 'identified', confidence: 'high'}}));
    }});
    assert.equal(calls.length, 1);
    const {context, request} = calls[0], evidence = context.evidence;
    assert.equal(context.stage, 'guided-evidence');
    assert.deepEqual(context.selectedExercise, {id: 'barbell-deadlift', name: '杠铃硬拉', family: 'hinge'});
    assert(JSON.stringify(evidence).length <= MOTION_GUIDED_LIMITS.evidenceChars);
    const textChars = request.messages[0].content.length + request.messages[1].content.filter(item => item.type === 'text').reduce((sum,item) => sum + item.text.length,0);
    assert(textChars <= MOTION_GUIDED_LIMITS.requestTextChars);
    assert(evidence.frames.every(frame => frame.landmarks.length === 17));
    assert.equal(evidence.sourceFrameIndices[0],0);
    assert.equal(evidence.sourceFrameIndices.at(-1),count-1);
    assert.equal(evidence.windows.reduce((sum,window) => sum + window.sourceFrameCount,0),count);
    assert.deepEqual(context.frames.map(frame => frame.time), [.2,.8]);
    assert.equal(request.messages[1].content.filter(item => item.type === 'image_url').length,2);
    assert.deepEqual(coach.action,{exerciseId:'barbell-deadlift',name:'杠铃硬拉',family:'hinge',status:'selected',confidence:null,source:'user',evidenceTimes:[],evidence:''});
    assert.equal(coach.mode,'guided');
    assert.equal(coach.verdict.status,'standard');
    assert.equal(coach.coverage.strategy,'guided-evidence');
    assert.equal(coach.coverage.sourceFrameCount,count);
    assert.equal(coach.coverage.frameCount,evidence.sourceFrameIndices.length);
    assert.equal(coach.coverage.reviewedFrameCount,evidence.sourceFrameIndices.length);
    assert.equal(coach.coverage.summarizedMeasurementCount,count);
    assert.equal(coach.coverage.modelCalls,1);
    assert.equal(progress.at(-1).stage,'complete');
    assert.equal(JSON.stringify(input),original);
    assert(!JSON.stringify(coach).includes('landmarks'));
    const saved = mergeCoachAssessment(input.fullAnalysis,coach);
    assert.equal(saved.coach.action.status,'selected');
    assert.equal(saved.coach.verdict.status,'standard');
  }
});

test('selection mismatch and unavailable confirmation keep the entire verdict uncertain', async () => {
  const input = validateMotionCoachRequest(body(20));
  for (const selectionCheck of [
    {status:'mismatch',imageIndices:[0],evidence:'图中为固定横杆下悬垂，与所选硬拉不同。'},
    {status:'uncertain',imageIndices:[],evidence:'器械接触处看不清楚。'},
    {status:'consistent',imageIndices:[99],evidence:'没有真实图片支持此结论。'}, undefined,
  ]) {
    const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({selectionCheck,
      verdict:{status:'needs-improvement'},feedback:[finding({status:'improve',evidence:'所引图片中手部负重远离腿部。',correction:'将负重保持靠近腿部。'})]}))});
    assert.equal(coach.action.status,'selected');
    assert.equal(coach.action.exerciseId,'barbell-deadlift');
    assert.equal(coach.verdict.status,'uncertain');
    assert.equal(coach.verdict.summary,'暂时找不出问题。');
    assert.deepEqual(coach.feedback,[]);
  }
});

test('unconfirmed selections discard all technical advice including invalid model problem references', async () => {
  const input = validateMotionCoachRequest(body(20));
  for (const status of ['mismatch','uncertain']) {
    const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({
      selectionCheck:{status,imageIndices:[0],evidence:'画面中的身体支撑不能确认与所选硬拉一致。'},
      verdict:{status:'needs-improvement'},feedback:[
        finding({status:'improve',imageIndices:[99],correction:'应增加下蹲深度。'}),
        finding({status:'uncertain',correction:'下一次请增加下蹲深度。'}),
        finding({status:'good'}),
      ],
    }))});
    assert.equal(coach.selectionCheck.status,status);
    assert.equal(coach.verdict.status,'uncertain');
    assert.deepEqual(coach.feedback,[]);
    assert(!JSON.stringify(mergeCoachAssessment(input.fullAnalysis,coach)).includes('增加下蹲深度'));
  }
});

test('short videos retain every source frame and a single actual image can verify user selection', async () => {
  const source = body(12); source.keyframes = source.keyframes.slice(0,1);
  const input = validateMotionCoachRequest(source), {context} = buildGuidedMotionContext(input);
  assert.deepEqual(context.evidence.sourceFrameIndices,Array.from({length:12},(_,index)=>index));
  const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({feedback:[finding({imageIndices:[0]})]}))});
  assert.equal(coach.selectionCheck.status,'consistent');
  assert.deepEqual(coach.selectionCheck.evidenceTimes,[.8]);
  assert.equal(coach.verdict.status,'standard');
});

test('guided feedback permits only actually sent pose and measurement references', async () => {
  const input = validateMotionCoachRequest(body(900));
  const {context,allowedAnalysisPaths} = buildGuidedMotionContext(input);
  const absent = Array.from({length:900},(_,i)=>i).find(i=>!context.evidence.sourceFrameIndices.includes(i));
  for (const bad of [
    finding({status:'improve',source:'pose',frameIndices:[absent],imageIndices:[]}),
    finding({status:'improve',imageIndices:[99]}),
    finding({status:'improve',source:'combined',frameIndices:[0],imageIndices:[99]}),
    finding({status:'improve',source:'analysis',analysisPaths:[['measurements',9999,'left','kneeAngle']]}),
  ]) {
    const rejected = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({verdict:{status:'needs-improvement'},feedback:[bad]}))});
    assert.deepEqual(rejected.verdict,{status:'uncertain',summary:'暂时找不出问题。'});
    assert.deepEqual(rejected.feedback,[]);
  }
  const path = allowedAnalysisPaths.find(path=>path[3]==='kneeAngle');
  const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({feedback:[finding({source:'analysis',analysisPaths:[path],evidence:'引用时刻膝部屈伸角度存在实际测量。'})]}))});
  assert.deepEqual(coach.feedback[0].analysisPaths,[path]);
  assert.deepEqual(coach.feedback[0].evidenceTimes,[input.fullAnalysis.measurements[path[1]].time]);
});

test('each guided problem needs valid visual corroboration even alongside another valid problem', async () => {
  const input = validateMotionCoachRequest(body(20));
  const path = buildGuidedMotionContext(input).allowedAnalysisPaths.find(path=>path[3]==='kneeAngle');
  const valid = finding({status:'improve',evidence:'下放阶段手部负重明显远离腿部。',correction:'将负重保持靠近腿部。'});
  for (const invalid of [
    {...valid,source:'pose',frameIndices:[0,1],evidence:'肩髋位置在下放阶段明显发生变化。'},
    {...valid,source:'analysis',analysisPaths:[path],evidence:'屈膝角度显示下放幅度不够。'},
    {...valid,imageIndices:[]},
    {...valid,imageIndices:[99]},
    {...valid,source:'combined',frameIndices:[0,1],imageIndices:[99]},
    {...valid,source:'combined',frameIndices:[999]},
  ]) {
    const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({
      verdict:{status:'needs-improvement'},feedback:[valid,{...invalid,title:'另一条问题'}],
    }))});
    assert.equal(coach.verdict.status,'needs-improvement');
    assert.equal(coach.feedback.length,1);
    assert.equal(coach.feedback[0].title,valid.title);
  }
  for (const supported of [valid,{...valid,source:'combined',frameIndices:[0,1]}]) {
    const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({
      verdict:{status:'needs-improvement'},feedback:[supported],
    }))});
    assert.equal(coach.verdict.status,'needs-improvement');
    assert.equal(coach.feedback.length,1);
    assert.equal(coach.feedback[0].source,supported.source);
  }
});

test('guided pose and analysis can still supply supported positive or uncertain observations', async () => {
  const input = validateMotionCoachRequest(body(20));
  const path = buildGuidedMotionContext(input).allowedAnalysisPaths.find(path=>path[3]==='kneeAngle');
  for (const status of ['good','uncertain']) {
    const feedback = [finding({title:'肩髋位置',status,source:'pose',frameIndices:[0,1],evidence:'引用时刻可见肩髋相对位置。',correction:''}),
      finding({title:'屈膝变化',status,source:'analysis',analysisPaths:[path],evidence:'引用时刻存在可用的屈膝角度测量。',correction:''})];
    const coach = await completeMotionCoach({provider,input,fetchImpl:async()=>respond(output({
      verdict:{status:status==='good'?'standard':'uncertain'},feedback,
    }))});
    assert.equal(coach.feedback.length,2);
    assert.equal(coach.verdict.status,status==='good'?'standard':'uncertain');
    assert.equal(coach.verdict.summary,'暂时找不出问题。');
  }
});

test('selection changes evaluation focus while leaving observed evidence untouched', () => {
  const input = validateMotionCoachRequest(body(20));
  const deadlift = buildGuidedMotionContext(input).context;
  const curl = buildGuidedMotionContext({...input,selectedExerciseId:'curl'}).context;
  assert.match(deadlift.evaluationFocus,/髋/);
  assert.match(curl.evaluationFocus,/肘/);
  assert.deepEqual(deadlift.evidence,curl.evidence);
});

test('new exercise variants use their actual support and movement instead of floor or row cues', () => {
  const input = validateMotionCoachRequest(body(20));
  const focus = id => buildGuidedMotionContext({...input,selectedExerciseId:id}).context.evaluationFocus;
  for (const id of ['hanging-knee-raise','hanging-leg-raise']) {
    assert.match(focus(id),/手部悬垂支撑/);
    assert.doesNotMatch(focus(id),/肩部离开支撑面/);
  }
  assert.match(focus('face-pull'),/面部回拉/);
  assert.match(focus('leg-press'),/踏板/);
  assert.match(focus('dip'),/平行支撑/);
  assert.match(focus('dumbbell-side-bend'),/侧屈本身是目标动作/);
});

test('cancellation before the provider call does not consume a model call', async () => {
  const input = validateMotionCoachRequest(body(20)), controller = new AbortController();
  let calls = 0;
  await assert.rejects(completeMotionCoach({provider,input,signal:controller.signal,
    onProgress:()=>controller.abort(new Error('cancelled before request')),fetchImpl:async()=>{calls++;return respond(output());}}),/cancelled before request/);
  assert.equal(calls,0);
});
