// Replay saved pose outputs without rerunning the GPU or redistributing videos.
// Usage: node scripts/qa-motion-benchmark.mjs [.qa/motion-fixtures]
// This checks objective measurements and data coverage, not AI coaching accuracy.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {analyzeMotion} from '../public/motion-analysis.js';

const folder=resolve(process.argv[2]||'.qa/motion-fixtures');
const source=await readFile(join(folder,'mendeley-sources.json'),'utf8').catch(()=>readFile(new URL('../tests/fixtures/motion-video-sources.json',import.meta.url),'utf8')).then(JSON.parse);
const additional=JSON.parse(await readFile(new URL('./motion-sample-sources.json',import.meta.url),'utf8'));
const rows=[];
for(const filename of (await readdir(folder)).filter(name=>/\.mp4(?:\.(?:webcodecs|html-video)(?:\.baseline)?)?\.frames\.json$/.test(name)).sort()){
 const clip=JSON.parse(await readFile(join(folder,filename),'utf8'));
 if(!Array.isArray(clip.frames))throw new Error(`Invalid frames: ${filename}`);
 const media=filename.replace(/(?:\.(?:webcodecs|html-video)(?:\.baseline)?)?\.frames\.json$/,'');
 const baseline=source.samples.find(item=>item.localPlayableCopy===media);
 const metadata=baseline||additional.samples.find(item=>item.playable===media);
 const report=analyzeMotion(clip.frames,clip);
 assert.equal(report.measurements.length,clip.frames.length,`${filename}: measurement rows must retain every sampled frame`);
 assert.deepEqual(Object.keys(report).sort(),['measurements','quality','version']);
 assert.deepEqual(Object.keys(report.quality).sort(),['reasons','sourceFps','targetCoverage','totalFrames','usableRatio','validFrames']);
 for(const [frameIndex,row] of report.measurements.entries()){
  assert.deepEqual(Object.keys(row).sort(),['frameIndex','left','right','time']);
  assert.equal(row.frameIndex,frameIndex,`${filename}: measurement index mismatch`);
  assert.equal(row.time,clip.frames[frameIndex].time,`${filename}: measurement timestamp mismatch`);
  for(const side of [row.left,row.right]){
   assert.deepEqual(Object.keys(side).sort(),['bodyAlignmentAngle','elbowAngle','hipAngle','kneeAngle','shoulderAngle','torsoLean']);
   for(const [key,value] of Object.entries(side))assert(value===null||(Number.isFinite(value)&&value>=0&&value<=(key==='torsoLean'?90:180)),`${filename}: invalid measurement value`);
  }
 }
 const elapsedMs=Number.isFinite(clip.elapsedMs)?clip.elapsedMs:null;
 rows.push({file:media,frameFile:filename,source:metadata?.sourcePage||null,subject:metadata?.label.subject||null,
  duration:clip.duration,elapsedMs,speedRatio:elapsedMs===null?null:elapsedMs/(clip.duration*1000),
  delegate:clip.delegate,decoder:clip.decoder||'video-seek',frames:clip.frames.length,timing:clip.timing,
  observationVersion:report.version,quality:report.quality,measurements:report.measurements});
}
const output={generatedAt:new Date().toISOString(),
 caveat:'Replay of saved pose data checks frame coverage and objective three-dimensional measurements only. It does not call an AI provider or test action recognition, movement quality, or correction accuracy. Missing or uncertain landmarks remain null.',rows};
await writeFile(join(folder,'benchmark-results.json'),JSON.stringify(output,null,2));
console.table(rows.map(({file,frames,elapsedMs,quality})=>({file,frames,measuredFrames:quality.validFrames,usableRatio:quality.usableRatio,seconds:elapsedMs===null?null:Math.round(elapsedMs/100)/10,reasons:quality.reasons.join(',')})));
console.log(`Saved ${join(folder,'benchmark-results.json')}`);
