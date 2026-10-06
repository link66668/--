const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = value => Math.max(0, Math.min(1, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = points => ({ x: points.reduce((sum,p)=>sum+p.x,0)/points.length, y: points.reduce((sum,p)=>sum+p.y,0)/points.length });
const visible = point => point && finite(point.x) && finite(point.y) && point.x>=0 && point.x<=1 && point.y>=0 && point.y<=1 && (point.visibility ?? 1) >= .45;
const limbPairs = [[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[24,26],[26,28]];
const majorJoints = [11,12,13,14,15,16,23,24,25,26,27,28];

export function validateTargetPoint(point) {
  if (point == null) return null;
  if (typeof point !== 'object' || !finite(point.x) || !finite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error('请选择视频画面内的训练者位置。');
  return { x: point.x, y: point.y };
}

function candidateFeatures(landmarks, index) {
  if (!Array.isArray(landmarks)) return null;
  const shoulders = [landmarks[11],landmarks[12]].filter(visible), hips = [landmarks[23],landmarks[24]].filter(visible);
  const body = landmarks.slice(11,33).filter(visible);
  if (!shoulders.length || !hips.length || body.length < 6) return null;
  const shoulder = mean(shoulders), hip = mean(hips), scale = distance(shoulder, hip);
  if (scale < .025) return null;
  const anchor = mean([shoulder,hip]);
  const lengths = limbPairs.map(([a,b])=>visible(landmarks[a])&&visible(landmarks[b])?distance(landmarks[a],landmarks[b])/scale:null);
  const silhouette=landmarks.filter(visible);
  const bbox = { xMin:clamp(Math.min(...silhouette.map(p=>p.x))), yMin:clamp(Math.min(...silhouette.map(p=>p.y))), xMax:clamp(Math.max(...silhouette.map(p=>p.x))), yMax:clamp(Math.max(...silhouette.map(p=>p.y))) };
  // Every tier supplies the same MediaPipe visibility values. Only observed
  // joints inside the image contribute to body completeness and prominence.
  const supportedTorso=[11,12,23,24].every(index=>visible(landmarks[index]));
  const supportedLegJoints=[25,26,27,28].filter(index=>visible(landmarks[index])).length;
  const observedBody=[0,...majorJoints].map(index=>landmarks[index]).filter(visible);
  const observedArea=observedBody.length?Math.max(.0001,(Math.max(...observedBody.map(p=>p.x))-Math.min(...observedBody.map(p=>p.x)))*(Math.max(...observedBody.map(p=>p.y))-Math.min(...observedBody.map(p=>p.y)))):.0001;
  const completeness=majorJoints.filter(index=>visible(landmarks[index])).length/majorJoints.length;
  return { index, anchor, scale, lengths, bbox, points:landmarks, supportedTorso, supportedLegJoints, observedArea, completeness, orientation:Math.atan2(shoulder.y-hip.y,shoulder.x-hip.x) };
}
const orientationDistance=(a,b)=>Math.abs(Math.atan2(Math.sin(a.orientation-b.orientation),Math.cos(a.orientation-b.orientation)));

function geometryDistance(a,b) {
  const differences = a.lengths.map((value,index)=>finite(value)&&finite(b.lengths[index])?Math.min(1,Math.abs(Math.log((value+.05)/(b.lengths[index]+.05)))):null).filter(finite);
  return differences.length ? differences.reduce((sum,value)=>sum+value,0)/differences.length : .2;
}

// Near-identical observations of one articulated body are not evidence of a
// crossing. Require near-coincidence across at least ten visible major joints;
// nearby people with different limbs or insufficient visibility stay separate.
function samePoseObservation(a,b) {
  if(Math.abs(Math.log(a.scale/b.scale))>.08||orientationDistance(a,b)>.08)return false;
  if(![11,12,23,24].every(index=>visible(a.points[index])&&visible(b.points[index])))return false;
  const deltas=majorJoints.filter(index=>visible(a.points[index])&&visible(b.points[index])).map(index=>distance(a.points[index],b.points[index])/Math.min(a.scale,b.scale));
  return deltas.length>=10&&Math.max(...deltas)<.08&&deltas.reduce((sum,value)=>sum+value,0)/deltas.length<.025;
}
const supportedLimbs=candidate=>candidate.supportedLegJoints+candidate.lengths.filter(length=>finite(length)&&length>=.12&&length<=2.5).length;
const supportedBody=candidate=>candidate.supportedTorso&&candidate.supportedLegJoints>=3;

/** A spatial continuity tracker, not biometric identification. Never reselect a
 * new central person after the original target is lost or a crossing is ambiguous. */
export function createSubjectTracker({ targetPoint=null }={}) {
  const point=validateTargetPoint(targetPoint), trackId='motion-target-1';
  let previous, previousTime, velocity={x:0,y:0}, halted;
  const missing = (status,reason) => ({index:null,subjectTracking:{status,trackId,confidence:0,reason}});
  return {
    update(poses,time) {
      if(!finite(time)||time<0)throw new Error('人物跟踪时间无效。');
      if(halted)return missing(halted.status,halted.reason);
      const candidates=[];
      for(const candidate of (Array.isArray(poses)?poses:[]).map(candidateFeatures).filter(Boolean)) {
        const duplicate=candidates.findIndex(previous=>samePoseObservation(previous,candidate));
        if(duplicate<0)candidates.push(candidate);
        else if(supportedLimbs(candidate)>supportedLimbs(candidates[duplicate]))candidates[duplicate]=candidate;
      }
      if(!previous) {
        if(!candidates.length)return missing('lost','no-visible-target');
        const target=point||{x:.5,y:.5};
        // Point selection must actually be near that person's visible body.
        const eligible=point?candidates.filter(candidate=>point.x>=candidate.bbox.xMin-.04&&point.x<=candidate.bbox.xMax+.04&&point.y>=candidate.bbox.yMin-.04&&point.y<=candidate.bbox.yMax+.04):candidates;
        if(!eligible.length)return missing('lost','selected-point-has-no-person');
        // Prefer a prominent, observed body near the center; a tiny mirror
        // image at the exact center must not beat a foreground trainee.
        // Explicit point selection retains its separate overlap safeguards.
        const maxArea=Math.max(...eligible.map(candidate=>candidate.observedArea));
        const ranked=eligible.map(candidate=>({candidate,cost:distance(candidate.anchor,target)+(point?0:.12*Math.log(maxArea/candidate.observedArea)+.1*(1-candidate.completeness))})).sort((a,b)=>a.cost-b.cost);
        if(point&&ranked.length>1)return missing('ambiguous','selected-point-overlapping-people');
        const coincident=ranked.slice(1).some(({candidate})=>Math.abs(Math.log(candidate.scale/ranked[0].candidate.scale))<.45&&distance(candidate.anchor,ranked[0].candidate.anchor)<Math.min(candidate.scale,ranked[0].candidate.scale)*.35);
        if(coincident)return missing('ambiguous','initial-target-ambiguous');
        if(ranked.length>1&&ranked[1].cost-ranked[0].cost<Math.max(.045,ranked[0].candidate.scale*.25))return missing('ambiguous','initial-target-ambiguous');
        previous=ranked[0].candidate;previousTime=time;
        return {index:previous.index,subjectTracking:{status:'locked',trackId,confidence:.9,bbox:previous.bbox}};
      }
      const elapsed=time-previousTime;
      if(elapsed<0)throw new Error('人物跟踪时间必须递增。');
      // Landmarks alone cannot identify a person returning after a long absence.
      if(elapsed>3){halted={status:'lost',reason:'target-lost-retry-selection'};return missing(halted.status,halted.reason);}
      if(!candidates.length)return missing('lost','no-visible-target');
      // A missed detection must not discard the target for the rest of the clip.
      // After a gap, require a close match to its last observed body instead of
      // extrapolating old velocity or selecting whoever is now in the center.
      const recovering=elapsed>.4;
      const predicted=recovering?previous.anchor:{x:previous.anchor.x+velocity.x*Math.min(elapsed,.2),y:previous.anchor.y+velocity.y*Math.min(elapsed,.2)};
      const ranked=candidates.map(candidate=>{
        const position=distance(candidate.anchor,predicted)/previous.scale;
        const scale=Math.abs(Math.log(candidate.scale/previous.scale));
        const geometry=geometryDistance(candidate,previous);
        const orientation=orientationDistance(candidate,previous);
        return {candidate,position,scale,geometry,orientation,cost:position+.5*scale+.3*geometry+.25*orientation};
      }).filter(match=>match.position<(recovering?.8:.95+Math.min(elapsed,.4)*1.1)&&match.scale<(recovering?.55:.75)&&match.geometry<(recovering?.55:.8)&&match.orientation<(recovering?1.1:1.4)).sort((a,b)=>a.cost-b.cost);
      if(!ranked.length)return missing('lost','target-continuity-lost');
      const best=ranked[0];
      // A close passer can occlude the legs and produce a much larger torso
      // while keeping its anchor near the original person. This is not enough
      // evidence to transfer identity. Keep the last complete observation so
      // the original target may reappear within the existing recovery window.
      if(supportedBody(previous)&&!supportedBody(best.candidate)&&best.candidate.scale/previous.scale>1.5)return missing('lost','occluded-target-size-discontinuity');
      const competitors=ranked.filter(match=>!supportedBody(best.candidate)||supportedBody(match.candidate)),rival=competitors[1];
      const closeOther=competitors.find(match=>match!==best&&match.cost-best.cost<.35&&match.orientation<.65&&match.geometry<.35&&Math.abs(Math.log(match.candidate.scale/best.candidate.scale))<.45&&distance(match.candidate.anchor,best.candidate.anchor)<Math.min(match.candidate.scale,best.candidate.scale)*.65);
      if((rival&&rival.cost-best.cost<.22)||closeOther){
        // Incomplete or occluded bodies cannot establish a second identity.
        // Skip the observation and require the original spatial/body match to
        // recover within the existing gap. Two visible bodies halt below.
        if(competitors.filter(match=>supportedBody(match.candidate)).length<2)return missing('lost','partial-detections-unresolved');
        // After an unresolved crossing these landmarks cannot prove identity.
        // Requiring a new run is safer than resuming on the other person's path.
        halted={status:'ambiguous',reason:'overlapping-targets-retry-selection'};
        return missing(halted.status,halted.reason);
      }
      const confidence=clamp(.98-best.cost*.2-(recovering?.08:0));
      if(confidence<.65)return missing('lost','target-match-uncertain');
      const dt=Math.max(.04,elapsed);
      const nextVelocity={x:(best.candidate.anchor.x-previous.anchor.x)/dt,y:(best.candidate.anchor.y-previous.anchor.y)/dt};
      velocity=recovering?{x:0,y:0}:{x:velocity.x*.5+nextVelocity.x*.5,y:velocity.y*.5+nextVelocity.y*.5};
      previous=best.candidate;previousTime=time;
      return {index:previous.index,subjectTracking:{status:'locked',trackId,confidence:Math.round(confidence*1000)/1000,bbox:previous.bbox}};
    },
  };
}

export function summarizeTargetTracking(frames,{targetPoint=null}={}) {
  const point=validateTargetPoint(targetPoint),totalFrames=frames.length;
  const lockedFrames=frames.filter(frame=>frame.subjectTracking?.status==='locked'&&frame.subjectTracking.confidence>=.65).length;
  const ambiguousFrames=frames.filter(frame=>frame.subjectTracking?.status==='ambiguous').length;
  const lostFrames=totalFrames-lockedFrames-ambiguousFrames;
  return {mode:point?'point':'auto',point,trackId:'motion-target-1',coverage:totalFrames?lockedFrames/totalFrames:0,lockedFrames,ambiguousFrames,lostFrames,totalFrames,maxPeople:frames.reduce((max,frame)=>Math.max(max,frame.personCount||0),0),
    summary:ambiguousFrames?'目标与其他人接近或重叠，身份无法持续确认；不确定帧未计分，请裁剪或重新点选训练者。':lostFrames?'部分画面未能可靠跟踪同一位训练者，丢失帧未计分。':'已连续跟踪选中的训练者；背景人物不参与评分。'};
}
