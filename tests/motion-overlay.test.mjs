import assert from 'node:assert/strict';
import test from 'node:test';
import {buildMotionOverlay,drawMotionOverlay,MOTION_FITNESS_BODY_INDICES} from '../public/motion-overlay.js';

const pose=()=>Array.from({length:33},(_,index)=>({x:.1+(index%6)*.1,y:.1+Math.floor(index/6)*.1,z:.2,visibility:.9}));

test('native MediaPipe overlay shows the same seventeen anatomical joints as AI evidence',()=>{
  const points=pose(),before=structuredClone(points),geometry=buildMotionOverlay(points,960,1280);
  assert.deepEqual(MOTION_FITNESS_BODY_INDICES,[0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]);
  assert.deepEqual(geometry.points.map(point=>point.index),[...MOTION_FITNESS_BODY_INDICES]);
  for(const point of geometry.points){assert.equal(point.x,points[point.index].x*960);assert.equal(point.y,points[point.index].y*1280);}
  for(const [a,b]of [[11,13],[13,15],[23,25],[25,27],[27,29],[29,31],[27,31],[28,30],[30,32]])assert(geometry.lines.some(line=>line.a.index===a&&line.b.index===b));
  assert(geometry.lines.every(line=>MOTION_FITNESS_BODY_INDICES.includes(line.a.index)&&MOTION_FITNESS_BODY_INDICES.includes(line.b.index)));
  assert.deepEqual(points,before);
});

test('overlay excludes invalid coordinates and visibility without filling missing observations',()=>{
  const points=pose();points[0]=null;points[11].x=NaN;points[12].y=1.01;points[13].x=-.01;points[14].visibility=0;points[15].visibility=1.1;points[16].visibility=Infinity;points[23].visibility=.001;
  const geometry=buildMotionOverlay(points,640,480);
  assert.equal(geometry.points.length,10);assert(geometry.points.some(point=>point.index===23));
  assert(geometry.lines.every(line=>line.a.index>=23&&line.b.index>=23));
  for(const invalid of [null,[],pose().slice(0,32)])assert.deepEqual(buildMotionOverlay(invalid,640,480),{points:[],lines:[]});
  assert.deepEqual(buildMotionOverlay(pose(),0,480),{points:[],lines:[]});
});

test('canvas renders seventeen points and restores rendering state',()=>{
  const arcs=[],calls=[];
  const context={save(){calls.push('save');},restore(){calls.push('restore');},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},arc(...args){arcs.push(args);}};
  drawMotionOverlay(context,pose(),640,480);
  assert.equal(arcs.length,17);assert.deepEqual(calls,['save','restore']);
});
