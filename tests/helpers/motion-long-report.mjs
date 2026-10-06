import {toMediaPipePipeline} from './motion-mediapipe-pipeline.mjs';
import {readFileSync} from 'node:fs';
import {analyzeMotion} from '../../public/motion-analysis.js';
import {mergeCoachAssessment} from '../../public/motion-contract.js';
import {buildMotionAssessmentReport} from '../../public/motion-view.js';

// A storage regression with repeated timing and synthetic MediaPipe observations.
// This is not labelled model output or evidence of recognition accuracy.
export function longMotionReport() {
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/motion-pushup-real.json',import.meta.url)));
  const source=fixture.frames.map(([time,points])=>{
    const landmarks=Array(33).fill(null);
    fixture.landmarkIndices.forEach((index,i)=>{const [x,y,visibility]=points[i];landmarks[index]={x,y,visibility};});
    return {time,landmarks};
  });
  const frames=[],duration=119;
  for(let cycle=0;cycle<8;cycle++)for(const frame of source){const time=frame.time+cycle*(source.at(-1).time+1/15);if(time<=duration)frames.push({...frame,time});}
  const pipeline=toMediaPipePipeline({...fixture.options,duration,frames,sourceFps:30,sampleFps:15,decoder:'test-synthetic-mediapipe',elapsedMs:1});
  const base=analyzeMotion(pipeline.frames,pipeline);
  const times=[frames[0].time,frames[Math.floor(frames.length/2)].time,frames.at(-1).time];
  const coach={version:'motion-coach-v4',mode:'visual',action:{exerciseId:'pushup',name:'俯卧撑',family:'pushup',status:'identified',confidence:'high',evidenceTimes:times,evidence:'报告保存测试中的模拟识别。'},verdict:{status:'uncertain',summary:'模拟评价用于验证保存，不能据此判断动作质量。'},feedback:times.map((time,index)=>({title:'模拟动作建议 '+(index+1),status:'uncertain',source:'visual',frameIndices:[],evidenceTimes:[time],evidence:'这是一条报告保存测试中的模拟观察。',correction:'请根据清楚的真实视频重新评价。',priority:index+1})),coverage:{complete:true,frameCount:frames.length,reviewedFrameCount:frames.length,measurementCount:base.measurements.length,dataBatches:4,modelCalls:5}};
  const analysis={...base,...mergeCoachAssessment(base,coach)};
  const report=buildMotionAssessmentReport(analysis,{file:{name:'long-report-regression.mp4',size:123456},pipeline,createdAt:'2026-10-03T00:00:00.000Z'});
  return {analysis,report};
}
