/** Validate evidence references for model-written motion feedback.
 * A valid reference establishes that an observation was available to the model;
 * it does not prove that the model interpreted it correctly. Coaching quality still needs validation against independently labelled videos.
 */
import {resolveMotionImageEvidenceTimes} from './motion-contract.js';
export const MOTION_FEEDBACK_LIMITS = Object.freeze({maxFindings: 12, maxFrames: 1800, maxAnalysisPaths: 12, maxTitle: 80, maxText: 1200});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const statuses = new Set(['good', 'improve', 'uncertain']);
const sources = new Set(['pose', 'visual', 'combined', 'analysis']);
const bodyJoints = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const timeIsValid = value => finite(value) && value >= 0 && value <= 120;

function plainText(value, limit) {
  if (typeof value !== 'string') return '';
  const clean = value.slice(0, 10000)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/<[^>]*>/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#~]/g, '').replace(/\r\n?/g, '\n').trim();
  // Remove invented ratings, while retaining measurements such as 90°, 2 分钟
  // or a 20% reduction in range. Percentages alone are not rating claims.
  const rating = /(?:\d+(?:\.\d+)?\s*分(?!钟)|\d+(?:\.\d+)?\s*\/\s*100\b|满分|(?:评分|得分|分数|标准率|标准度|准确率|准确度|合格率|置信度|\b(?:score|rating|accuracy|confidence)\b)[^。！？\n]{0,40}\d|\d+(?:\.\d+)?\s*[%％]\s*(?:准确|合格|标准|accurate|accuracy))/i;
  return clean.split(/(?<=[。！？；;\n])|(?<=[.!?])\s+/).filter(sentence => !rating.test(sentence)).join('').trim().slice(0, limit);
}

function reliablePoint(point) {
  if (!point || typeof point !== 'object') return false;
  const tuple = Array.isArray(point), missing = tuple && point.length === 4 ? point[3] : 0;
  if (tuple && (![3, 4].includes(point.length) || !Number.isInteger(missing) || missing < 0 || missing > 7)) return false;
  const x = tuple ? point[0] : point.x, y = tuple ? point[1] : point.y;
  const visibility = tuple ? point[2] : point.visibility;
  // Image visibility is only a gate; motion evidence also requires world XYZ.
  return !(missing & 7) && finite(x) && finite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 && finite(visibility) && visibility >= 0.55 && visibility <= 1;
}

function reliableWorldPoint(point) {
  if (!point || typeof point !== 'object') return false;
  const tuple = Array.isArray(point), missing = tuple && point.length === 5 ? point[4] : 0;
  if (tuple && (![4, 5].includes(point.length) || !Number.isInteger(missing) || missing < 0 || missing > 15)) return false;
  const x = tuple ? point[0] : point.x, y = tuple ? point[1] : point.y, z = tuple ? point[2] : point.z;
  const visibility = tuple ? point[3] : point.visibility;
  return !(missing & 15) && [x, y, z].every(finite) && finite(visibility) && visibility >= .55 && visibility <= 1;
}

function eligibleFrame(frame, {hasTracking, trackId, duration}) {
  if (!frame || !timeIsValid(frame.time) || finite(duration) && frame.time > duration || !Array.isArray(frame.landmarks) || frame.landmarks.length !== 33 || !Array.isArray(frame.worldLandmarks) || frame.worldLandmarks.length !== 33) return false;
  const tracking = frame.subjectTracking;
  if (tracking || hasTracking) {
    if (tracking?.status !== 'locked' || !finite(tracking.confidence) || tracking.confidence < 0.65 || tracking.confidence > 1 || typeof tracking.trackId !== 'string' || !tracking.trackId || tracking.trackId !== trackId) return false;
  } else if (frame.personCount !== undefined && frame.personCount !== 1) return false;
  // Face/finger visibility alone cannot support an exercise observation. This
  // is only a minimum data gate; the prompt must use the relevant visible joints.
  return bodyJoints.filter(index => reliablePoint(frame.landmarks[index]) && reliableWorldPoint(frame.worldLandmarks[index])).length >= 3;
}

function validAnalysisPath(path, analysis) {
  if (!Array.isArray(path) || !path.length || path.length > 12) return false;
  let value = analysis;
  for (const part of path) {
    if (typeof part === 'number' ? !Number.isInteger(part) || part < 0 || !Array.isArray(value) : typeof part !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part)) return false;
    if (!own(value, part)) return false;
    value = value[part];
  }
  return finite(value) || typeof value === 'boolean' || typeof value === 'string' && value.trim().length > 0;
}

function normalizeAnalysisPath(path, {allowRoot = false} = {}) {
  if (!Array.isArray(path)) return null;
  const normalized = path[0] === 'fullAnalysis' ? path.slice(1) : [...path];
  if ((!allowRoot && !normalized.length) || normalized.length > 12 || normalized.some(part => typeof part === 'number' ? !Number.isInteger(part) || part < 0 : typeof part !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) return null;
  return normalized;
}

const angleMeasurements = new Set(['elbowAngle','shoulderAngle','hipAngle','kneeAngle','bodyAlignmentAngle','torsoLean']);
function measurementTime(path, fullAnalysis, duration) {
  if(path.length!==4||path[0]!=='measurements'||!Number.isInteger(path[1])||!['left','right'].includes(path[2])||!angleMeasurements.has(path[3]))return null;
  const row=fullAnalysis?.measurements?.[path[1]],value=row?.[path[2]]?.[path[3]];
  if(!finite(value)||value<0||value>180||row.frameIndex!==path[1]||!timeIsValid(row.time)||finite(duration)&&row.time>duration)return null;
  return row.time;
}

const poseCannotEstablish = text => /(?:脊柱中立|腰椎中立|腰椎曲线|胸腰椎曲线|neutral spine|spinal neutrality|lumbar curvature|器械(?:型号|种类|类型))|(?:确认|识别|可见|使用|手持|握住|器械[是为]).{0,12}(?:杠铃|哑铃|史密斯|绳索|胸托|barbell|dumbbell|smith)/i.test(text);

/** Frame indices are zero-based indices in the complete poseData.frames array.
 * evidenceTimes in model input reference actual supplied pictures; pose times
 * are derived from validated frame indices, never guessed or snapped to images.
 * analysisPaths are normalized paths into fullAnalysis (without its root name).
 * source:'analysis' references observed per-frame angles; timestamps come from
 * those same measured frames. Optional allowedAnalysisPaths
 * restrict references to packet block prefixes or previously cited scalars.
 */
export function sanitizeMotionFeedback(value, {poseData, keyframes = [], imageKeyframes = keyframes, allowedFrameIndices, fullAnalysis, allowedAnalysisPaths} = {}) {
  if (!Array.isArray(value)) return [];
  const frames = Array.isArray(poseData?.frames) ? poseData.frames : [];
  const hasTracking = frames.some(frame => frame?.subjectTracking);
  const identities = new Set(frames.filter(frame => frame?.subjectTracking?.status === 'locked').map(frame => frame.subjectTracking.trackId).filter(id => typeof id === 'string' && id.length));
  const trackId = poseData?.targetTracking?.trackId || (identities.size === 1 ? [...identities][0] : null);
  const allowed = allowedFrameIndices === undefined ? null : new Set(allowedFrameIndices instanceof Set || Array.isArray(allowedFrameIndices) ? allowedFrameIndices : []);
  const validIndices = new Set();
  for (let index = 0; index < Math.min(frames.length, MOTION_FEEDBACK_LIMITS.maxFrames); index++) {
    if ((!allowed || allowed.has(index)) && eligibleFrame(frames[index], {hasTracking, trackId, duration: poseData?.duration})) validIndices.add(index);
  }
  const pictureTimes = new Set((Array.isArray(keyframes) ? keyframes : []).map(frame => frame?.time).filter(timeIsValid));
  const allowedPaths = allowedAnalysisPaths === undefined ? null : [...(allowedAnalysisPaths instanceof Set || Array.isArray(allowedAnalysisPaths) ? allowedAnalysisPaths : [])].map(path => normalizeAnalysisPath(path, {allowRoot: true})).filter(Boolean);
  const result = [], seen = new Set();
  for (const item of value.slice(0, 96)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !statuses.has(item.status) || !sources.has(item.source)) continue;
    const title = plainText(item.title, MOTION_FEEDBACK_LIMITS.maxTitle), evidence = plainText(item.evidence, MOTION_FEEDBACK_LIMITS.maxText), correction = plainText(item.correction, MOTION_FEEDBACK_LIMITS.maxText);
    if (!title || evidence.replace(/\s/g, '').length < 4 || item.status==='improve'&&!correction) continue;
    if (['pose', 'analysis'].includes(item.source) && poseCannotEstablish(`${title} ${evidence}`)) continue;
    let analysisPaths = [];
    if (item.analysisPaths !== undefined) {
      // Some models emit one valid path without the outer array. This changes
      // only its container shape, never the path, value or evidence allowlist.
      const suppliedPaths = Array.isArray(item.analysisPaths) && typeof item.analysisPaths[0] === 'string' ? [item.analysisPaths] : item.analysisPaths;
      if (!Array.isArray(suppliedPaths) || !suppliedPaths.length || suppliedPaths.length > MOTION_FEEDBACK_LIMITS.maxAnalysisPaths) continue;
      analysisPaths = suppliedPaths.map(path => normalizeAnalysisPath(path));
      if (!analysisPaths.every(path => path && validAnalysisPath(path, fullAnalysis) && finite(measurementTime(path,fullAnalysis,poseData?.duration)) && (!allowedPaths || allowedPaths.some(prefix => prefix.length <= path.length && prefix.every((part, index) => path[index] === part))))) continue;
      analysisPaths = [...new Map(analysisPaths.map(path => [JSON.stringify(path), path])).values()];
    }
    const indices = [...new Set((Array.isArray(item.frameIndices) ? item.frameIndices : []).filter(index => Number.isInteger(index) && validIndices.has(index)))].sort((a, b) => a - b);
    const images = [...new Set([...(Array.isArray(item.evidenceTimes) ? item.evidenceTimes : []).filter(time => timeIsValid(time) && pictureTimes.has(time)),
      ...resolveMotionImageEvidenceTimes({imageIndices: item.imageIndices}, imageKeyframes).filter(time => pictureTimes.has(time))])];
    const analysisTimes = item.source === 'analysis' ? analysisPaths.map(path => measurementTime(path, fullAnalysis, poseData?.duration)) : [];
    if (item.source === 'analysis' ? !analysisTimes.length || !analysisTimes.every(finite) : item.source !== 'visual' && !indices.length || item.source !== 'pose' && !images.length) continue;
    const frameIndices = ['visual', 'analysis'].includes(item.source) ? [] : indices;
    const evidenceTimes = [...new Set(item.source === 'analysis' ? analysisTimes : [...frameIndices.map(index => frames[index].time), ...(item.source === 'pose' ? [] : images)])].sort((a, b) => a - b);
    const signature = JSON.stringify([title, item.source, frameIndices, evidenceTimes, analysisPaths]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({title, status: item.status, source: item.source, frameIndices, ...(analysisPaths.length ? {analysisPaths} : {}), evidenceTimes, time: evidenceTimes[0], evidence, correction, priority: Number.isInteger(item.priority) && item.priority >= 1 && item.priority <= 3 ? item.priority : 2});
    if (result.length === MOTION_FEEDBACK_LIMITS.maxFindings) break;
  }
  return result;
}
