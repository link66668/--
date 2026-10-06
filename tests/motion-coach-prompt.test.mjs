import {toMediaPipePipeline} from './helpers/motion-mediapipe-pipeline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {completeMotionCoach} from '../server/motion-coach.mjs';
import {analyzeMotion} from '../public/motion-analysis.js';
import {buildMotionPoseData,buildFullMotionAnalysis} from '../public/motion-pose-data.js';

async function sent(vision,calls=[]){
 const pipeline=toMediaPipePipeline({width:640,height:480,duration:1,sourceFps:30,sampleFps:15,frames:Array.from({length:3},(_,i)=>({time:i/15,personCount:1,landmarks:Array.from({length:33},(_,j)=>({x:0.1+j/100,y:0.2+j/100,visibility:1}))}))});
 const input={duration:1,analysis:{quality:analyzeMotion(pipeline.frames,pipeline).quality,evidenceFrames:[{time:0.2,framing:'equipment-context'}]},poseData:buildMotionPoseData(pipeline),fullAnalysis:buildFullMotionAnalysis(analyzeMotion(pipeline.frames,pipeline),pipeline),keyframes:[{time:0.2,mimeType:'image/jpeg',data:'fixture'},{time:0.5,mimeType:'image/jpeg',data:'fixture'}]};
 await completeMotionCoach({provider:{name:'fixture',model:'model',protocol:'openai',baseUrl:'http://127.0.0.1:9/v1',apiKey:'test',models:[{id:'model',vision}]},input,fetchImpl:async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({choices:[{message:{content:JSON.stringify({action:{status:'unknown'},verdict:{status:'uncertain',summary:'画面不足以判断。'},feedback:[]})}}]});}});
 assert.equal(calls.length,1);
 return calls[0].messages;
}

test('direct AI evaluation receives pictures, complete observations and a concise rubric-free task',async()=>{
 const [system,user]=await sent(true),data=JSON.parse(user.content[0].text);
 assert.equal(data.stage,'full-data');assert.equal(data.data.total,1);
 assert.equal(user.content.filter(part=>part.type==='image_url').length,2);
 assert.match(system.content,/客观/);assert.match(system.content,/直接给出最终动作结论/);
 assert.match(system.content,/mediapipe-tables-f32-v1/);assert.doesNotMatch(system.content,/pose-tables-f32-v1|ST-GCN/);
 assert.match(system.content,/目录外/);assert.match(system.content,/旁人和镜像/);
 assert.match(system.content,/至少一项good反馈有证据/);assert.match(system.content,/暂时找不出问题/);
 assert.match(system.content,/找不出错误不等于已有标准证据/);
 assert.match(system.content,/至少两个有效时刻/);assert.match(system.content,/全片含动作切换/);
 assert.match(system.content,/深蹲看/);assert.match(system.content,/引体向上先确认/);
 assert.match(system.content,/卧推先确认/);assert.match(system.content,/硬拉看/);assert.match(system.content,/坐姿划船看/);
 assert.match(system.content,/不能硬分入这五类/);
 assert.doesNotMatch(system.content,/按每秒15帧采样/);
 assert.match(system.content,/覆盖率偏低本身都不是动作错误/);
 assert.match(system.content,/feedback允许为空/);
 assert.doesNotMatch(system.content,/recognitionRules|SQUAT_DEPTH|pass\/fail|scoreCap|qualifiedRepCount/);
 assert(system.content.length<10000,'No large per-action rules catalogue is repeated');
 assert(!/"(?:score|checks|reps|qualified|threshold)"\s*:/.test(user.content[0].text));
});

test('text model request fails before sending pose data or pictures',async()=>{
 const calls=[];
 await assert.rejects(sent(false,calls),error=>error.status===400 && /视觉|图片/.test(error.message));
 assert.equal(calls.length,0);
});
