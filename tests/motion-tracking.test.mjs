import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubjectTracker, validateTargetPoint, summarizeTargetTracking} from '../public/motion-tracking.js';
import {analyzeVideo} from '../public/motion-video.js';

function person(x=.5,y=.5,scale=1) {
  const points=Array.from({length:33},()=>({x,y:y-.25*scale,visibility:.95}));
  const set=(i,dx,dy)=>Object.assign(points[i],{x:x+dx*scale,y:y+dy*scale});
  set(11,-.065,-.1);set(12,.065,-.1);set(23,-.05,.1);set(24,.05,.1);
  set(13,-.1,.025);set(14,.1,.025);set(15,-.11,.16);set(16,.11,.16);
  set(25,-.05,.25);set(26,.05,.25);set(27,-.05,.4);set(28,.05,.4);
  for(let i=29;i<=32;i++)set(i,i%2?-.06:.06,.41);
  return points;
}
test('point validation rejects malformed coordinates before opening resources',async()=>{
  assert.equal(validateTargetPoint(null),null);
  assert.deepEqual(validateTargetPoint({x:0,y:1}),{x:0,y:1});
  for(const targetPoint of [{x:NaN,y:0},{x:.5,y:Infinity},{x:-.01,y:.5},{x:1.01,y:.5},{x:'0.5',y:.5},{}]) {
    assert.throws(()=>validateTargetPoint(targetPoint),/位置/);
    await assert.rejects(analyzeVideo({name:'clip.mp4',size:20},{targetPoint}),/位置/);
  }
});
test('initial selection uses center or explicit point, never candidate ordering',()=>{
  for(const poses of [[person(.18),person(.52)],[person(.52),person(.18)]]) {
    const selected=createSubjectTracker().update(poses,0);
    assert.equal(poses[selected.index][11].x,.52-.065);
    assert.equal(selected.subjectTracking.status,'locked');
    const clicked=createSubjectTracker({targetPoint:{x:.18,y:.4}}).update(poses,0);
    assert.equal(poses[clicked.index][11].x,.18-.065);
  }
  assert.equal(createSubjectTracker().update([person(.09)],0).subjectTracking.status,'locked');
  assert.equal(createSubjectTracker().update([person(.46),person(.54)],0).subjectTracking.status,'ambiguous');
  assert.equal(createSubjectTracker({targetPoint:{x:.95,y:.9}}).update([person(.2)],0).index,null);
});
test('locked identity moves off center while another person becomes central',()=>{
  const tracker=createSubjectTracker();
  tracker.update([person(.5),person(.1)],0);
  for(let i=1;i<=20;i++) {
    const target=person(.5+i*.014),other=person(.1+i*.012);
    const candidates=i%2?[other,target]:[target,other];
    const result=tracker.update(candidates,i/15);
    assert.equal(result.subjectTracking.status,'locked',`frame ${i}`);
    assert.equal(candidates[result.index],target);
    assert.equal(result.subjectTracking.trackId,'motion-target-1');
    assert(result.subjectTracking.confidence>=.65);
  }
});
test('manual target only ranks people whose visible box contains the point',()=>{
  const contained=person(.6,.6),nearAnchor=person(.43,.45,.3);
  const result=createSubjectTracker({targetPoint:{x:.58,y:.4}}).update([nearAnchor,contained],0);
  assert.equal(result.index,1);
  assert.equal(createSubjectTracker({targetPoint:{x:.52,y:.5}}).update([person(.5),person(.54)],0).subjectTracking.status,'ambiguous');
});
test('blank lead-in can initialize once a reliable first target appears',()=>{
  const tracker=createSubjectTracker();
  assert.equal(tracker.update([],0).index,null);
  assert.equal(tracker.update([],1).index,null);
  assert.equal(tracker.update([person(.5)],1.1).subjectTracking.status,'locked');
});
test('crossing ambiguity does not silently resume on the other person',()=>{
  const tracker=createSubjectTracker();
  tracker.update([person(.5),person(.8)],0);
  const crossing=tracker.update([person(.53),person(.57)],1/15);
  assert.equal(crossing.subjectTracking.status,'ambiguous');
  assert.equal(crossing.index,null);assert.equal(crossing.subjectTracking.bbox,undefined);
  const after=tracker.update([person(.46),person(.64)],2/15);
  assert.equal(after.subjectTracking.status,'ambiguous');assert.equal(after.index,null);
});
test('a target can return after a short miss or more than a second of occlusion',()=>{
  const short=createSubjectTracker();short.update([person(.5)],0);
  assert.equal(short.update([],1/15).subjectTracking.status,'lost');
  assert.equal(short.update([person(.51)],2/15).subjectTracking.status,'locked');
  const long=createSubjectTracker();long.update([person(.5)],0);
  assert.equal(long.update([person(.9)],.1).subjectTracking.status,'lost');
  assert.equal(long.update([],1).subjectTracking.status,'lost');
  const recovered=long.update([person(.51)],1.1);
  assert.equal(recovered.subjectTracking.status,'locked');
  assert.equal(recovered.subjectTracking.trackId,'motion-target-1');
  assert.equal(long.update([person(.52)],1.1+1/15).subjectTracking.status,'locked');
});
test('recovery keeps the selected off-center target instead of switching to the central person',()=>{
  const tracker=createSubjectTracker({targetPoint:{x:.24,y:.4}});
  tracker.update([person(.24),person(.6)],0);
  assert.equal(tracker.update([person(.58)],.2).subjectTracking.status,'lost');
  assert.equal(tracker.update([person(.54)],.9).subjectTracking.status,'lost');
  const result=tracker.update([person(.5),person(.26)],1.2);
  assert.equal(result.subjectTracking.status,'locked');
  assert.equal(result.index,1);
});
test('the original position can be recovered within two seconds of occlusion',()=>{
  const tracker=createSubjectTracker();tracker.update([person(.5)],0);
  assert.equal(tracker.update([],1).subjectTracking.status,'lost');
  const recovered=tracker.update([person(.5)],2);
  assert.equal(recovered.subjectTracking.status,'locked');
  assert.equal(recovered.subjectTracking.trackId,'motion-target-1');
});
test('a same-sized person at the original position cannot inherit the target after a long absence',()=>{
  for(const elapsed of [3.01,60]){
    const tracker=createSubjectTracker();tracker.update([person(.5)],0);
    assert.equal(tracker.update([],1).subjectTracking.status,'lost');
    const result=tracker.update([person(.5)],elapsed);
    assert.equal(result.index,null);
    assert.equal(result.subjectTracking.status,'lost');
    assert.equal(result.subjectTracking.reason,'target-lost-retry-selection');
    assert.equal(tracker.update([person(.5)],elapsed+1/15).index,null);
  }
});
test('a gap cannot justify a different body, a distant person, or an ambiguous replacement',()=>{
  const tracker=createSubjectTracker();tracker.update([person(.5)],0);
  assert.equal(tracker.update([],1).subjectTracking.status,'lost');
  assert.equal(tracker.update([person(.5,.5,.35)],1.1).index,null);
  assert.equal(tracker.update([person(.82)],1.2).index,null);
  const ambiguous=tracker.update([person(.49),person(.52)],1.3);
  assert.equal(ambiguous.subjectTracking.status,'ambiguous');
  assert.equal(ambiguous.index,null);
  assert.equal(tracker.update([person(.5)],1.4).index,null);
});
test('a fast deep squat retains the same target as its torso lowers and leans',()=>{
  const tracker=createSubjectTracker();tracker.update([person(.5)],0);
  const crouched=person(.5);
  for(const [index,x,y] of [[11,.55,.58],[12,.67,.58],[23,.45,.7],[24,.55,.7],[13,.55,.69],[14,.69,.67],[15,.48,.77],[16,.65,.77],[25,.38,.77],[26,.62,.77]])Object.assign(crouched[index],{x,y});
  const result=tracker.update([person(.15),crouched],1/15);
  assert.equal(result.subjectTracking.status,'locked');
  assert.equal(result.index,1);
  assert(result.subjectTracking.confidence>=.65);
});
test('scale discontinuity and weak partial bodies cannot take over the track',()=>{
  const tracker=createSubjectTracker();tracker.update([person(.5)],0);
  assert.equal(tracker.update([person(.5,.5,.35)],1/15).index,null);
  const hidden=person(.5);for(let i=11;i<33;i++)hidden[i].visibility=.1;
  assert.equal(tracker.update([hidden],2/15).index,null);
});
test('bbox is bounded and summary covers all input frames',()=>{
  const tracker=createSubjectTracker();const first=tracker.update([person(.08,.5)],0);
  for(const value of Object.values(first.subjectTracking.bbox))assert(value>=0&&value<=1);
  const frames=[{personCount:3,...first},{personCount:2,...tracker.update([],1/15)},{personCount:4,...tracker.update([],1)}];
  const summary=summarizeTargetTracking(frames,{targetPoint:{x:.1,y:.4}});
  assert.equal(summary.lockedFrames,1);assert.equal(summary.lostFrames,2);assert.equal(summary.coverage,1/3);assert.equal(summary.maxPeople,4);assert.equal(summary.mode,'point');
  const horizontal=person(.5);horizontal[0].x=.2;
  assert.equal(createSubjectTracker().update([horizontal],0).subjectTracking.bbox.xMin,.2,'target bounds include a horizontal body’s head');
});
test('a nearby standing background pose cannot compete with a continuous horizontal target',()=>{
  const horizontal=person(.5).map(p=>({...p,x:.5+(p.y-.5),y:.5-(p.x-.5)}));
  const tracker=createSubjectTracker();tracker.update([horizontal],0);
  const selected=tracker.update([person(.51,.44),horizontal],1/15);
  assert.equal(selected.index,1);assert.equal(selected.subjectTracking.status,'locked');
});

test('near-identical 33-point observations retain a moving target regardless of candidate order',()=>{
  for(const reverse of [false,true]){
    const tracker=createSubjectTracker();
    for(let index=0;index<5;index++){
      const target=person(.5+index*.005),duplicate=target.map((point,joint)=>({...point,x:point.x+(joint%2?.001:-.001)}));
      const candidates=[target,duplicate,person(.9)];
      if(reverse)candidates.reverse();
      const result=tracker.update(candidates,index/15);
      assert.equal(result.subjectTracking.status,'locked',`frame ${index}, reversed ${reverse}`);
      assert(candidates[result.index][11].x<.7,'the distant background candidate cannot inherit the target');
    }
  }
});

test('duplicate skeletons can initialize a selected target while distinct nearby people remain ambiguous',()=>{
  const first=person(.5),duplicate=first.map((point,index)=>({...point,x:point.x+(index%2?.001:-.001)}));
  const selected=createSubjectTracker({targetPoint:{x:.5,y:.4}}).update([first,duplicate],0);
  assert.equal(selected.subjectTracking.status,'locked');
  assert.equal(selected.index,0);
  assert.equal(createSubjectTracker().update([person(.495),person(.505)],0).subjectTracking.status,'ambiguous','a close anchor alone cannot deduplicate people');
  const differentArms=person(.5);differentArms[13].x-=.06;differentArms[14].x+=.06;
  const tracker=createSubjectTracker();tracker.update([first],0);
  assert.equal(tracker.update([first,differentArms],1/15).subjectTracking.status,'ambiguous','different articulated limbs must preserve crossing ambiguity');
});

test('partial body observations cannot justify deduplicating two candidates',()=>{
  const first=person(.5),partial=person(.5);
  for(const index of [25,27,28])partial[index].visibility=.1;
  assert.equal(createSubjectTracker().update([first,partial],0).subjectTracking.status,'ambiguous');
});

test('coincident upper bodies with different legs cannot establish duplicate identity',()=>{
  const target=person(.5),partial=person(.5);
  for(const [knee,ankle,hip]of [[25,27,23],[26,28,24]]){
    partial[knee]={...partial[hip]};partial[ankle]={...partial[hip]};
  }
  for(const candidates of [[target,partial],[partial,target]]){
    const result=createSubjectTracker().update(candidates,0);
    assert.equal(result.subjectTracking.status,'ambiguous');
    assert.equal(result.index,null);
  }
});

test('crossings of two visible bodies halt and cannot resume on the other person',()=>{
  const tracker=createSubjectTracker();
  tracker.update([person(.5),person(.8)],0);
  const crossing=tracker.update([person(.53),person(.57)],1/15);
  assert.equal(crossing.subjectTracking.status,'ambiguous');
  assert.equal(crossing.subjectTracking.reason,'overlapping-targets-retry-selection');
  assert.equal(tracker.update([person(.46),person(.64)],2/15).index,null);
});

test('an incomplete candidate cannot attract the selected complete body or extend the recovery window',()=>{
  const tracker=createSubjectTracker();tracker.update([person(.5)],0);
  const partial=person(.5),target=person(.51);
  for(const index of [25,26,27,28])partial[index].visibility=.1;
  const selected=tracker.update([partial,target],1/15);
  assert.equal(selected.index,null,'closer but incomplete candidates must not silently choose an identity');
  assert.equal(selected.subjectTracking.status,'lost');
  const recovered=tracker.update([target],2/15);
  assert.equal(recovered.subjectTracking.status,'locked');
  assert.equal(recovered.index,0);
  const absent=createSubjectTracker();absent.update([person(.5)],0);
  const alternatives=[person(.5),person(.51)];
  for(const candidate of alternatives)for(const index of [25,26,27,28])candidate[index].visibility=.1;
  assert.equal(absent.update(alternatives,1).index,null);
  assert.equal(absent.update([person(.5)],3.01).subjectTracking.reason,'target-lost-retry-selection');
});

test('default prominence does not override explicit selection of a smaller person',()=>{
  const front=person(.65,.65,.7),background=person(.5,.4,.2);
  for(const poses of [[front,background],[background,front]]){
    const automatic=createSubjectTracker().update(poses,0);
    assert.strictEqual(poses[automatic.index],front);
    const manual=createSubjectTracker({targetPoint:{x:.5,y:.38}}).update(poses,0);
    assert.strictEqual(poses[manual.index],background);
  }
  assert.equal(summarizeTargetTracking([]).mode,'auto');
});

test('a suddenly larger torso with obscured legs cannot inherit an observed full-body target',()=>{
  const tracker=createSubjectTracker(),target=person(.5,.45),passer=person(.5,.45,2);
  tracker.update([target],0);
  for(const time of [.133,.266,1]){
    const result=tracker.update([passer],time);
    assert.equal(result.index,null);
    assert.equal(result.subjectTracking.status,'lost');
  }
  const recovered=tracker.update([person(.51,.45)],1.2);
  assert.equal(recovered.subjectTracking.status,'locked');
  assert.equal(recovered.index,0);
  const zoom=createSubjectTracker();zoom.update([person(.5,.45,.6)],0);
  assert.equal(zoom.update([person(.5,.45,1.2)],.133).subjectTracking.status,'locked','observed whole-body scale changes retain the existing continuity bounds');
});

test('MediaPipe visibility is required for both torso and leg support during recovery',()=>{
  const target=person(.5,.45),passer=person(.5,.45,1.7);
  for(const index of [11,27,28])passer[index].visibility=.1;
  const tracker=createSubjectTracker();
  assert.equal(tracker.update([target],0).subjectTracking.status,'locked');
  const occluded=tracker.update([passer],.133);
  assert.equal(occluded.index,null);
  assert.equal(occluded.subjectTracking.reason,'occluded-target-size-discontinuity');
  const returned=person(.51,.45),background=person(.8,.45,.5);
  const recovered=tracker.update([background,returned],.4);
  assert.equal(recovered.subjectTracking.status,'locked');
  assert.equal(recovered.index,1);
});
