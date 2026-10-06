import { browserSeekTime, scaledVideoSize, validateVideoFile, validateVideoMetadata } from './motion-video.js';
import { prepareMotionVideo } from './motion-media.js';

export const MOTION_EVIDENCE_LIMITS = Object.freeze({ maxImages: 6, maxBytes: 1900000, maxDimension: 1280 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const checkAbort = signal => { if (signal?.aborted) throw new DOMException('已取消关键帧提取。', 'AbortError'); };
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

// Keep target metadata bounded; complete pose samples travel separately.
function compact(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (finite(value)) return value;
  if (typeof value === 'string') return value.slice(0, 300);
  if (!value || typeof value !== 'object' || depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 24).map(item => compact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:.*landmarks|frames|dataurl|base64|images?|video|file)$/i.test(key)).slice(0, 24).map(([key, item]) => [key.slice(0, 64), compact(item, depth + 1)]));
}

export function summarizeMotionAnalysis(observations={},pipeline={}) {
  const quality=observations.quality||{};
  return {
    version:'motion-observations-3d-v1',
    coordinateSpace:'mediapipe-world-3d',duration:finite(pipeline.duration)?pipeline.duration:null,
    sampleFps:finite(pipeline.sampleFps)?pipeline.sampleFps:null,sourceFps:finite(pipeline.sourceFps)?pipeline.sourceFps:null,
    quality:Object.fromEntries(['totalFrames','validFrames','usableRatio','sourceFps','targetCoverage','reasons'].filter(key=>Object.hasOwn(quality,key)).map(key=>[key,key==='reasons'?(Array.isArray(quality[key])?quality[key].filter(item=>typeof item==='string').slice(0,64).map(item=>item.slice(0,100)):[]):quality[key]===null||finite(quality[key])?quality[key]:null])),
    ...(pipeline.targetTracking?{targetTracking:compact(Object.fromEntries(['mode','point','trackId','coverage','lockedFrames','ambiguousFrames','lostFrames','totalFrames','maxPeople'].filter(key=>Object.hasOwn(pipeline.targetTracking,key)).map(key=>[key,pipeline.targetTracking[key]])))}:{}),
    evidenceNote:'骨架为单目估计的运动观测；缺失或遮挡部位保持未知，不能据此断言动作质量。',
  };
}

export function selectMotionEvidenceFrames(frames, assessment = {}, { maxImages = 6 } = {}) {
  const limit = Math.min(6, Math.max(1, Math.floor(maxImages) || 6));
  const input = Array.isArray(frames) ? frames : [];
  const tracking = input.some(frame => frame?.subjectTracking);
  if (!tracking && input.some(frame => frame?.personCount > 1)) throw new Error('旧分析包含多个人，无法保证 AI 点评同一位训练者，请重新分析。');
  const eligible = input.filter(frame => frame && finite(frame.time) && frame.time >= 0 && (!tracking || (frame.subjectTracking?.status === 'locked' && frame.subjectTracking.confidence >= 0.65 && typeof frame.subjectTracking.trackId === 'string' && frame.subjectTracking.trackId.length > 0 && validBox(frame.subjectTracking.bbox))));
  if (tracking && new Set(eligible.map(frame => frame.subjectTracking.trackId)).size > 1) throw new Error('分析中目标身份发生变化，无法生成同一人的关键帧。');
  const ordered = [...new Map(eligible.map(frame => [frame.time, frame])).values()].sort((a, b) => a.time - b.time);
  if (!ordered.length) throw new Error('没有可供提取证据的分析帧。');
  // Binary lookup avoids rescanning up to 1,800 frames for every joint sample.
  const nearest = time => {
    let low = 0, high = ordered.length - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (ordered[mid].time < time) low = mid + 1; else high = mid; }
    return low > 0 && time - ordered[low - 1].time <= ordered[low].time - time ? ordered[low - 1] : ordered[low];
  };
  const selected = new Map();
  const add = (time, reason, maxDistance = Infinity, separation = 0) => {
    if (!finite(time)) return;
    const frame = nearest(time), existing = selected.get(frame.time);
    if (Math.abs(frame.time - time) > maxDistance) return;
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
    if ([...selected.keys()].some(chosen => Math.abs(chosen - frame.time) < separation)) return;
    if (selected.size >= limit) return;
    selected.set(frame.time, { time: frame.time, requestedTime: time, poseTime: frame.time, sourceTime: finite(frame.sourceTime) ? frame.sourceTime : null, reasons: [reason], ...(tracking ? { subjectTracking: compact(frame.subjectTracking) } : {}) });
  };
  const start=ordered[0].time,end=ordered.at(-1).time;
  add(start,'视频起始');add(end,'视频结束');add((start+end)/2,'视频中部');
  // Use observed extrema to capture changing postures without classifying an
  // exercise or labelling any position as correct/incorrect.
  const measurements=Array.isArray(assessment.measurements)?assessment.measurements:[];
  const features=new Map();
  for(const side of ['left','right'])for(const field of ['elbowAngle','shoulderAngle','hipAngle','kneeAngle','bodyAlignmentAngle','torsoLean']){
    const values=measurements.filter(row=>finite(row?.time)&&finite(row?.[side]?.[field])&&Math.abs(nearest(row.time).time-row.time)<=0.035).sort((a,b)=>a.time-b.time);
    if(!values.length)continue;
    // An isolated pose spike should not consume a scarce evidence image. Only
    // use contiguous neighbours; never smooth across missing/occluded periods.
    const ranked=values.map((row,index)=>{
      const neighbours=values.slice(Math.max(0,index-1),index+2).filter(other=>Math.abs(other.time-row.time)<=0.15).map(other=>other[side][field]).sort((a,b)=>a-b);
      const value=values.length>=5&&neighbours.length===3?neighbours[1]:row[side][field];
      return {row,value,error:Math.abs(row[side][field]-value)};
    });
    for(const {row,value} of ranked){
      const time=nearest(row.time).time;
      if(!features.has(time))features.set(time,{});
      features.get(time)[side+'.'+field]=value/180;
    }
  }
  // Cover distinct postures, not multiple extrema of nearly the same upright
  // pose. A small time term also covers different portions of repeated motion.
  const distance=(a,b)=>{
    const left=features.get(a)||{},right=features.get(b)||{};
    const keys=Object.keys(left).filter(key=>finite(right[key]));
    const pose=keys.length?keys.reduce((sum,key)=>sum+(left[key]-right[key])**2,0)/keys.length:0;
    return pose+0.06*((a-b)/Math.max(end-start,0.001))**2;
  };
  while(selected.size<limit&&features.size){
    let best=null,bestDistance=-1;
    for(const [time] of features){
      if(selected.has(time)||[...selected.keys()].some(chosen=>Math.abs(chosen-time)<Math.min(0.25,(end-start)/20)))continue;
      const closest=Math.min(...[...selected.keys()].map(chosen=>distance(time,chosen)));
      if(closest>bestDistance){best=time;bestDistance=closest;}
    }
    if(best===null)break;
    add(best,'姿态与时序覆盖');
  }
  for(const fraction of [0.25,0.75,0.125,0.875])add(start+(end-start)*fraction,'视频过程');
  return [...selected.values()].sort((a, b) => a.time - b.time);
}

function validBox(box) {
  return box && ['xMin', 'yMin', 'xMax', 'yMax'].every(key => finite(box[key])) && box.xMin >= 0 && box.yMin >= 0 && box.xMax <= 1 && box.yMax <= 1 && box.xMax > box.xMin && box.yMax > box.yMin;
}

export function evidenceCropRegion(box) {
  if (!validBox(box)) return { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const marginX = Math.max(0.06, (box.xMax - box.xMin) * 0.2), marginY = Math.max(0.04, (box.yMax - box.yMin) * 0.12);
  // A landmark box can begin at the ears/shoulders rather than the head outline.
  // Keep extra room above it for visible head/neck assessment and the label.
  const headroom = Math.max(0.08, (box.yMax - box.yMin) * 0.25);
  return { xMin: Math.max(0, box.xMin - marginX), yMin: Math.max(0, box.yMin - headroom), xMax: Math.min(1, box.xMax + marginX), yMax: Math.min(1, box.yMax + marginY) };
}

export function evidenceSequenceCrop(frames) {
  const boxes=frames.map(frame=>frame?.subjectTracking?.bbox).filter(validBox);
  if(!boxes.length)return evidenceCropRegion(null);
  return evidenceCropRegion({xMin:Math.min(...boxes.map(box=>box.xMin)),yMin:Math.min(...boxes.map(box=>box.yMin)),xMax:Math.max(...boxes.map(box=>box.xMax)),yMax:Math.max(...boxes.map(box=>box.yMax))});
}

function waitForMedia(video, event, signal, trigger) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', failed); signal?.removeEventListener('abort', cancelled); };
    const finish = (handler, value) => { cleanup(); handler(value); };
    const done = () => finish(resolve);
    const failed = () => finish(reject, new Error('无法读取视频关键帧，请重新选择视频。'));
    const cancelled = () => finish(reject, new DOMException('已取消关键帧提取。', 'AbortError'));
    video.addEventListener(event, done, { once: true }); video.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(failed, 15000);
    try { trigger?.(); } catch (error) { finish(reject, error); }
  });
}

function observePresentedFrame(video, signal) {
  let callback, timer, finish;
  const promise = new Promise(resolve => {
    finish = value => { clearTimeout(timer); if (callback !== undefined) video.cancelVideoFrameCallback?.(callback); signal?.removeEventListener('abort', cancel); resolve(value); };
    const cancel = () => finish(null);
    if (!video.requestVideoFrameCallback) { resolve(null); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    callback = video.requestVideoFrameCallback((_now, metadata) => finish(finite(metadata.mediaTime) ? metadata.mediaTime : null));
    timer = setTimeout(cancel, 200);
  });
  return { promise, cancel: () => finish?.(null) };
}

async function jpegDataUrl(canvas, budget, signal) {
  let quality = 0.76;
  for (let attempt = 0; attempt < 7; attempt++) {
    checkAbort(signal);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('浏览器无法生成 JPEG 关键帧。');
    checkAbort(signal);
    if (Math.ceil(blob.size / 3) * 4 + 32 <= budget) {
      const bytes = new Uint8Array(await blob.arrayBuffer()); checkAbort(signal);
      let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return 'data:image/jpeg;base64,' + btoa(binary);
    }
    if (quality > 0.4) quality -= 0.18;
    else {
      const copy = document.createElement('canvas'); copy.width = Math.max(1, Math.round(canvas.width * 0.75)); copy.height = Math.max(1, Math.round(canvas.height * 0.75));
      copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height);
      canvas.width = copy.width; canvas.height = copy.height; canvas.getContext('2d').drawImage(copy, 0, 0); copy.width = copy.height = 0;
    }
  }
  throw new Error('关键帧无法压缩到请求大小限制内。');
}

/** Local-only extraction. The caller decides whether and when to upload the result. */
export async function buildMotionEvidence(file, pipeline, assessment, { signal, onProgress = () => {}, maxImages = 6, maxBytes = 1900000 } = {}) {
  checkAbort(signal); validateVideoFile(file);
  const selected = selectMotionEvidenceFrames(pipeline?.frames, assessment, { maxImages });
  const sequenceCrop = evidenceSequenceCrop(selected);
  if(!selected.length)throw new Error('未找到可用的训练者画面，请调整拍摄或点选训练者后重新评估。');
  const summary = summarizeMotionAnalysis(assessment, pipeline);
  const budget = Math.min(MOTION_EVIDENCE_LIMITS.maxBytes, finite(maxBytes) ? Math.floor(maxBytes) : MOTION_EVIDENCE_LIMITS.maxBytes);
  if (budget < 50000) throw new Error('关键帧请求大小限制过小。');
  const video = document.createElement('video'), canvas = document.createElement('canvas');
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  const prepared = await prepareMotionVideo(file, { signal, onProgress });
  const software = prepared.mode === 'software';
  const url = software ? null : URL.createObjectURL(prepared.file);
  let observation, sourceBitmap, lastImageTime = null;
  const sourceImages = [];
  try {
    if (!software) await waitForMedia(video, 'loadedmetadata', signal, () => { video.src = url; video.load(); });
    const { duration, width, height } = software ? prepared.metadata : { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    validateVideoMetadata({ duration, width, height });
    if (Math.abs(duration - pipeline.duration) > Math.max(0.1, duration * 0.001) || width !== pipeline.width || height !== pipeline.height) throw new Error('视频与分析结果不一致，请重新分析当前视频。');
    if (!software && video.readyState < 2) await waitForMedia(video, 'loadeddata', signal);
    let decodedImages;
    if (software) {
      const { readMotionSourceFrames } = await import('./motion-source.js');
      decodedImages = await readMotionSourceFrames(file, selected.map(item => item.sourceTime ?? item.poseTime), { signal, sampleFps: pipeline.sampleFps, maxDimension: 1280, onProgress: value => onProgress({ ...value, stage: 'evidence' }) });
      if (decodedImages.length !== selected.length) throw new Error('关键图片未完整提取，请重试。');
    }
    const result = { version: 'motion-evidence-v2', video: { width, height, duration, sampleFps: summary.sampleFps, sourceFps: summary.sourceFps }, summary, images: [], byteLength: 0 };
    const perImageBudget = Math.floor((budget - jsonBytes(result) - 20000) / selected.length);
    for (const [index, item] of selected.entries()) {
      checkAbort(signal);
      let imageTime, sourceBytes;
      if (software) {
        const decoded = decodedImages[index];
        if (Math.abs(decoded.time - (item.sourceTime ?? item.poseTime)) > 0.00001) throw new Error('关键图片时间与分析结果不一致，请重新分析。');
        imageTime = finite(decoded.sourceTime) ? decoded.sourceTime : null;
        // FFmpeg's fps filter can repeat one source image without reporting its
        // original PTS. Compare before target boxes/crops so repeated source
        // pixels cannot masquerade as independent motion evidence.
        sourceBytes = new Uint8Array(await decoded.blob.arrayBuffer());
      } else {
        observation = observePresentedFrame(video, signal);
        // Prefer the pose's actual source PTS, when available; seek-time epsilon
        // compensates Chromium microsecond truncation without changing poseTime.
        const seek = browserSeekTime(item.sourceTime ?? item.poseTime, duration);
        const didSeek = Math.abs(video.currentTime - seek) > 0.000001;
        if (didSeek) await waitForMedia(video, 'seeked', signal, () => { video.currentTime = seek; });
        const presentedTime = await observation.promise; observation = undefined; checkAbort(signal);
        imageTime = presentedTime ?? (didSeek ? null : lastImageTime); lastImageTime = imageTime;
      }
      // A decoded source PTS is still known when HTML video cannot report a
      // presentation callback. Repeated samples of that frame are one image,
      // not independent visual observations at different requested times.
      const time = imageTime ?? item.sourceTime ?? item.poseTime;
      const mapping = { requestedTime: item.requestedTime, poseTime: item.poseTime, sourceTime: item.sourceTime };
      const duplicate = (sourceBytes && sourceImages.find(entry=>entry.bytes.length===sourceBytes.length&&entry.bytes.every((byte,index)=>byte===sourceBytes[index]))?.image) || result.images.find(image => Math.round(image.time * 1e6) === Math.round(time * 1e6));
      if (duplicate) {
        duplicate.reasons = [...new Set([...duplicate.reasons, ...item.reasons])];
        duplicate.frameMappings.push(mapping);
        onProgress({ stage: 'evidence', processedFrames: index + 1, totalFrames: selected.length, progress: (index + 1) / selected.length });
        continue;
      }
      // Two distant views retain benches, bar ends, rails and cable origins.
      // The remaining target crops preserve detail for posture checks.
      const framing = index === 0 || index === selected.length - 1 ? 'equipment-context' : 'target-detail';
      // The same crop throughout the detail sequence preserves screen-space
      // motion. Per-frame recentering/zooming can look like body sway to a VLM.
      const box = item.subjectTracking?.bbox, crop = framing === 'equipment-context' ? evidenceCropRegion(null) : sequenceCrop;
      if (software) { sourceBitmap = await createImageBitmap(decodedImages[index].blob); checkAbort(signal); }
      const source = sourceBitmap || video, sourceWidth = software ? sourceBitmap.width : width, sourceHeight = software ? sourceBitmap.height : height;
      const cropWidth = (crop.xMax - crop.xMin) * sourceWidth, cropHeight = (crop.yMax - crop.yMin) * sourceHeight;
      const size = scaledVideoSize(cropWidth, cropHeight, framing === 'equipment-context' ? MOTION_EVIDENCE_LIMITS.maxDimension : 960);
      canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法读取视频画面。');
      context.drawImage(source, crop.xMin * sourceWidth, crop.yMin * sourceHeight, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
      sourceBitmap?.close(); sourceBitmap = undefined;
      if (box) {
        // Joint bounds can cut through the back/head silhouette. Place the
        // target marker outside those bounds, leaving the contour readable.
        const marker=evidenceCropRegion(box);
        const x = Math.max(2,(marker.xMin - crop.xMin) / (crop.xMax - crop.xMin) * canvas.width), y = Math.max(2,(marker.yMin - crop.yMin) / (crop.yMax - crop.yMin) * canvas.height);
        const right=Math.min(canvas.width-2,(marker.xMax-crop.xMin)/(crop.xMax-crop.xMin)*canvas.width),bottom=Math.min(canvas.height-2,(marker.yMax-crop.yMin)/(crop.yMax-crop.yMin)*canvas.height);
        context.strokeStyle = '#ffdf00'; context.lineWidth = 2; context.strokeRect(x, y, right-x, bottom-y);
        // Put the label in the crop margin, not over the target's head/neck.
        context.fillStyle = '#ffdf00'; context.fillRect(4, 4, 70, 22);
        context.fillStyle = '#111'; context.font = 'bold 14px sans-serif'; context.fillText('TARGET', 9, 20);
      }
      const dataUrl = await jpegDataUrl(canvas, perImageBudget, signal);
      result.images.push({ ...item, time, imageTime, timePrecision: imageTime !== null ? 'source-pts' : item.sourceTime !== null ? 'pose-source-pts' : 'seek-target', frameMappings: [mapping], framing, crop, width: canvas.width, height: canvas.height, mimeType: 'image/jpeg', dataUrl });
      if(sourceBytes)sourceImages.push({bytes:sourceBytes,image:result.images.at(-1)});
      onProgress({ stage: 'evidence', processedFrames: index + 1, totalFrames: selected.length, progress: (index + 1) / selected.length });
    }
    summary.evidenceFrames = result.images.map(({ dataUrl, ...metadata }) => metadata);
    result.byteLength = jsonBytes(result); result.byteLength = jsonBytes(result);
    if (result.byteLength >= budget) throw new Error('关键帧请求超过大小限制。');
    checkAbort(signal); return result;
  } finally {
    sourceBitmap?.close(); observation?.cancel(); video.pause(); video.removeAttribute('src'); video.load(); if (url) URL.revokeObjectURL(url); canvas.width = canvas.height = 0;
  }
}
