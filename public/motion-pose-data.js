/** Full, unrounded local observations for the AI request. This transport is
 * deliberately separate from the small persisted report and its UI summary. */
export const MOTION_POSE_DATA_LIMITS = Object.freeze({ maxDuration: 120, maxFrames: 1800, maxBytes: 32 * 1024 * 1024, maxAnalysisBytes: 2 * 1024 * 1024 });
export const MOTION_LANDMARK_NAMES = Object.freeze(['nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index']);
export const MOTION_POINT_FIELDS = Object.freeze(['x', 'y', 'visibility']);
export const MOTION_WORLD_POINT_FIELDS = Object.freeze(['x', 'y', 'z', 'visibility']);
export const MOTION_BODY_LANDMARK_INDICES = Object.freeze([0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]);
const MEDIAPIPE_WORLD_COORDINATES = Object.freeze({
  image: 'landmarks x/y are normalized original-image coordinates (x right, y down), used only for tracking and to locate observations in screenshots. Outside-image values are retained; these are not the metric 3D points.',
  world: 'worldLandmarks x/y/z are MediaPipe model-estimated 3D coordinates in meters, with the midpoint of the hips as origin. Signed values and values outside [0,1] are valid. These hip-relative coordinates are not a global movement trajectory, measured depth or a measured gravity reference.',
  confidence: 'visibility is the MediaPipe landmark visibility likelihood in [0,1]. Low-visibility, lost and ambiguous observations must not establish a posture conclusion.',
  tuple: 'Image landmarks are [x,y,visibility,optional missingMask]. Bit (1 << fieldIndex) marks an absent field whose tuple slot is null. Unmarked null is explicitly unknown; a null point is unavailable.',
  worldTuple: 'worldLandmarks are [x,y,z,visibility,optional missingMask]. Bit (1 << fieldIndex) marks an absent field whose tuple slot is null. Unmarked null is explicitly unknown; a null point is unavailable. The same retainedLandmarkIndices and 33-slot order apply. An empty array means no 3D observation, never a 2D fallback.',
  body: 'Only the 17 retainedLandmarkIndices contain observations in the 33-slot array. Face details and finger points are null and are never transmitted to the AI.',
  measurements: 'Joint angles are estimated 3D angles in degrees from worldLandmarks. torsoLean is the unsigned angle to the model camera Y axis (0 to 90 degrees), not to measured gravity. Perspective, occlusion and model estimation can still cause errors; 3D points do not measure spinal curvature, muscle activation or joint forces.',
  time: 'All timestamps are seconds from video start. time is the requested sample; sourceTime is the actual decoded presentation timestamp when available. These can differ.',
});
const MODEL_VERSION = /^MediaPipe Pose Landmarker (Lite|Full|Heavy) .+ \/ world3d-v1$/;
const fail = (path, reason) => { throw new Error(`完整骨架数据无效（${path}）：${reason}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function object(value, keys, path) {
  if (!record(value)) fail(path, '应为对象');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, '不支持的字段');
}
function number(value, path, min = -Infinity, max = Infinity, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(path, '数值超出范围或不是有限数字');
}
function string(value, path, max = 500) {
  if (typeof value !== 'string' || value.length > max || /data:(?:image|video|audio)\/|^blob:/i.test(value)) fail(path, '文本无效或包含原始媒体');
}
function id(value, path) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(value)) fail(path, '标识无效');
}
function boolean(value, path) { if (typeof value !== 'boolean') fail(path, '应为布尔值'); }
function optional(value, key, check, path) { if (own(value, key) && value[key] !== null) check(value[key], `${path}.${key}`); }
function bytes(value, limit, path) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(path, '无法序列化'); }
  if (new TextEncoder().encode(serialized).byteLength > limit) fail(path, `超过 ${limit / 1024 / 1024} MiB 限制，请缩短视频后重试；不会截断数据`);
}
function cloneJson(value, path = 'analysis', depth = 0) {
  if (depth > 14) fail(path, '嵌套层级过深');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { number(value, path); return value; }
  if (typeof value === 'string') { string(value, path, 16000); return value; }
  if (Array.isArray(value)) {
    if (value.length > 57600) fail(path, '数组过长');
    return Array.from(value, (item, index) => item === undefined ? null : cloneJson(item, `${path}[${index}]`, depth + 1));
  }
  if (!record(value)) fail(path, '应为 JSON 数据');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path, '非法字段');
    if (item !== undefined) result[key] = cloneJson(item, `${path}.${key}`, depth + 1);
  }
  return result;
}
function tracking(value, path) {
  object(value, ['status', 'trackId', 'confidence', 'bbox', 'reason'], path);
  if (!['locked', 'lost', 'ambiguous'].includes(value.status)) fail(`${path}.status`, '跟踪状态无效');
  id(value.trackId, `${path}.trackId`);
  number(value.confidence, `${path}.confidence`, 0, 1);
  optional(value, 'reason', id, path);
  optional(value, 'bbox', (box, boxPath) => {
    object(box, ['xMin', 'yMin', 'xMax', 'yMax'], boxPath);
    for (const key of ['xMin', 'yMin', 'xMax', 'yMax']) number(box[key], `${boxPath}.${key}`);
    if (box.xMin > box.xMax || box.yMin > box.yMax) fail(boxPath, '边框方向无效');
  }, path);
}
function targetTracking(value, path, frameCount) {
  object(value, ['mode', 'point', 'trackId', 'coverage', 'lockedFrames', 'ambiguousFrames', 'lostFrames', 'totalFrames', 'maxPeople', 'summary'], path);
  if (!['auto', 'point', 'center'].includes(value.mode)) fail(`${path}.mode`, '目标选择模式无效');
  id(value.trackId, `${path}.trackId`);
  optional(value, 'point', (point, pointPath) => {
    object(point, ['x', 'y'], pointPath);
    number(point.x, `${pointPath}.x`, 0, 1); number(point.y, `${pointPath}.y`, 0, 1);
  }, path);
  number(value.coverage, `${path}.coverage`, 0, 1);
  for (const key of ['lockedFrames', 'ambiguousFrames', 'lostFrames', 'totalFrames']) number(value[key], `${path}.${key}`, 0, MOTION_POSE_DATA_LIMITS.maxFrames, true);
  if (value.lockedFrames + value.ambiguousFrames + value.lostFrames !== value.totalFrames || (frameCount !== undefined && value.totalFrames !== frameCount)) fail(path, '跟踪帧数与完整采样不一致');
  if (Math.abs(value.coverage - (value.totalFrames ? value.lockedFrames / value.totalFrames : 0)) > 0.001) fail(path, '跟踪覆盖率与帧数不一致');
  number(value.maxPeople, `${path}.maxPeople`, 0, 64, true);
  optional(value, 'summary', string, path);
}
function points(value, path, fields = MOTION_POINT_FIELDS) {
  if (value === null) return;
  if (!Array.isArray(value) || (value.length !== 0 && value.length !== 33)) fail(path, '必须保留完整 33 点，或空数组表示未检测到姿态');
  for (let index = 0; index < value.length; index++) {
    const point = value[index], pointPath = `${path}[${index}]`;
    if (point === null) continue;
    if (!Array.isArray(point) || ![fields.length, fields.length + 1].includes(point.length)) fail(pointPath, '关键点必须使用完整字段元组');
    const missing = point.length === fields.length + 1 ? point[fields.length] : 0;
    number(missing, `${pointPath}.missingMask`, 0, (1 << fields.length) - 1, true);
    for (let field = 0; field < fields.length; field++) {
      if (missing & (1 << field)) { if (point[field] !== null) fail(pointPath, '缺失字段不能包含数值'); }
      else if (point[field] !== null) number(point[field], `${pointPath}.${fields[field]}`, fields[field] === 'visibility' ? 0 : -Infinity, fields[field] === 'visibility' ? 1 : Infinity);
    }
  }
}
function compactPoints(value, path, fields = MOTION_POINT_FIELDS) {
  if (value === null) return null;
  if (!Array.isArray(value)) fail(path, '关键点应为数组或 null');
  return Array.from(value, (point, index) => {
    if (point == null) return null;
    object(point, fields, `${path}[${index}]`);
    let missing = 0;
    const result = fields.map((key, field) => {
      if (!own(point, key) || point[key] === undefined) { missing |= 1 << field; return null; }
      return point[key];
    });
    if (missing) result.push(missing);
    return result;
  });
}

export function buildMotionPoseData(pipeline) {
  if (!record(pipeline) || !Array.isArray(pipeline.frames)) fail('pipeline', '缺少完整采样');
  const value = {
    schemaVersion: 6, format: 'mediapipe-world17-full', landmarkNames: [...MOTION_LANDMARK_NAMES],
    pointFields: [...MOTION_POINT_FIELDS], worldPointFields: [...MOTION_WORLD_POINT_FIELDS],
    coordinates: {...MEDIAPIPE_WORLD_COORDINATES}, retainedLandmarkIndices: [...MOTION_BODY_LANDMARK_INDICES],
    duration: pipeline.duration, width: pipeline.width, height: pipeline.height, sampleFps: pipeline.sampleFps,
    frameCount: pipeline.frames.length,
    frames: pipeline.frames.map((frame, index) => {
      object(frame, ['time', 'sourceTime', 'landmarks', 'worldLandmarks', 'personCount', 'multiPersonCheck', 'subjectTracking'], `frames[${index}]`);
      const result = {};
      for (const [key, item] of Object.entries(frame)) if (item !== undefined) {
        if (key === 'landmarks' || key === 'worldLandmarks') {
          const retained = Array.isArray(item) ? item.map((point, pointIndex) => MOTION_BODY_LANDMARK_INDICES.includes(pointIndex) ? point : null) : item;
          result[key] = compactPoints(retained, `frames[${index}].${key}`, key === 'worldLandmarks' ? MOTION_WORLD_POINT_FIELDS : MOTION_POINT_FIELDS);
        } else result[key] = cloneJson(item);
      }
      if (!own(result, 'worldLandmarks')) result.worldLandmarks = [];
      return result;
    }),
  };
  for (const key of ['sourceFps', 'modelVersion', 'decoder', 'delegate', 'codec', 'elapsedMs', 'timing', 'targetTracking']) if (pipeline[key] !== undefined) value[key] = cloneJson(pipeline[key]);
  return validateMotionPoseData(value, {duration: pipeline.duration});
}

/** Returns the original object, without sanitizing, rounding or truncation. */
export function validateMotionPoseData(value, {duration} = {}) {
  object(value, ['schemaVersion', 'format', 'landmarkNames', 'pointFields', 'worldPointFields', 'coordinates', 'retainedLandmarkIndices', 'duration', 'width', 'height', 'sampleFps', 'sourceFps', 'frameCount', 'frames', 'modelVersion', 'decoder', 'delegate', 'codec', 'elapsedMs', 'timing', 'targetTracking'], 'poseData');
  if (value.schemaVersion !== 6 || value.format !== 'mediapipe-world17-full') fail('poseData', '仅支持 MediaPipe 三维骨架协议');
  if (typeof value.modelVersion !== 'string' || !MODEL_VERSION.test(value.modelVersion)) fail('poseData.modelVersion', '必须声明 MediaPipe Lite、Full 或 Heavy 三维模型');
  if (JSON.stringify(value.landmarkNames) !== JSON.stringify(MOTION_LANDMARK_NAMES) || JSON.stringify(value.pointFields) !== JSON.stringify(MOTION_POINT_FIELDS) || JSON.stringify(value.coordinates) !== JSON.stringify(MEDIAPIPE_WORLD_COORDINATES)) fail('poseData', '坐标定义或关键点顺序不匹配');
  if (JSON.stringify(value.worldPointFields) !== JSON.stringify(MOTION_WORLD_POINT_FIELDS)) fail('poseData.worldPointFields', '三维字段顺序不匹配');
  if (JSON.stringify(value.retainedLandmarkIndices) !== JSON.stringify(MOTION_BODY_LANDMARK_INDICES)) fail('poseData.retainedLandmarkIndices', '必须保留统一的 17 个身体节点');
  number(value.duration, 'duration', Number.MIN_VALUE, MOTION_POSE_DATA_LIMITS.maxDuration);
  if (duration !== undefined && (!Number.isFinite(duration) || Math.abs(duration - value.duration) > 0.000001)) fail('duration', '与视频时长不一致');
  number(value.width, 'width', 1, 32768, true); number(value.height, 'height', 1, 32768, true);
  number(value.sampleFps, 'sampleFps', Number.MIN_VALUE, 15);
  optional(value, 'sourceFps', (n, path) => number(n, path, Number.MIN_VALUE, 1000), 'poseData');
  number(value.frameCount, 'frameCount', 1, MOTION_POSE_DATA_LIMITS.maxFrames, true);
  if (!Array.isArray(value.frames) || value.frames.length !== value.frameCount) fail('frames', '完整采样帧数不匹配');
  for (const key of ['modelVersion', 'decoder', 'delegate', 'codec']) optional(value, key, string, 'poseData');
  optional(value, 'elapsedMs', (n, path) => number(n, path, 0), 'poseData');
  optional(value, 'timing', (timing, path) => {
    object(timing, ['initializationMs', 'decodeMs', 'inferenceMs'], path);
    for (const [key, n] of Object.entries(timing)) number(n, `${path}.${key}`, 0);
  }, 'poseData');
  optional(value, 'targetTracking', (trackingValue, path) => targetTracking(trackingValue, path, value.frameCount), 'poseData');
  let lastTime = -1, lastSource = -1, trackId = value.targetTracking?.trackId;
  for (let index = 0; index < value.frames.length; index++) {
    const frame = value.frames[index], path = `frames[${index}]`;
    object(frame, ['time', 'sourceTime', 'landmarks', 'worldLandmarks', 'personCount', 'multiPersonCheck', 'subjectTracking'], path);
    if (!own(frame, 'landmarks')) fail(`${path}.landmarks`, '必须保留骨架观测或明确的缺失状态');
    number(frame.time, `${path}.time`, 0, value.duration);
    if (frame.time <= lastTime) fail(path, '采样时间必须严格递增');
    lastTime = frame.time;
    optional(frame, 'sourceTime', (time, p) => {
      number(time, p, 0, value.duration);
      if (time < lastSource) fail(p, '源画面时间不能倒退');
      lastSource = time;
    }, path);
    points(frame.landmarks, `${path}.landmarks`);
    if (frame.landmarks?.some((point, pointIndex) => point !== null && !MOTION_BODY_LANDMARK_INDICES.includes(pointIndex))) fail(path, '骨架只能包含指定的 17 个身体节点');
    if (!own(frame, 'worldLandmarks')) fail(`${path}.worldLandmarks`, '必须保留三维观测或明确的缺失状态');
    points(frame.worldLandmarks, `${path}.worldLandmarks`, MOTION_WORLD_POINT_FIELDS);
    if (frame.worldLandmarks?.some((point, pointIndex) => point !== null && !MOTION_BODY_LANDMARK_INDICES.includes(pointIndex))) fail(path, '三维骨架只能包含指定的 17 个身体节点');
    if (frame.worldLandmarks?.length && !frame.landmarks?.length) fail(path, '三维观测必须对应同一帧的图像骨架');
    optional(frame, 'personCount', (n, p) => number(n, p, 0, 64, true), path);
    optional(frame, 'multiPersonCheck', boolean, path);
    optional(frame, 'subjectTracking', (data, p) => {
      tracking(data, p);
      if (trackId && trackId !== data.trackId) fail(p, '目标身份在采样中发生变化');
      trackId = data.trackId;
    }, path);
  }
  bytes(value, MOTION_POSE_DATA_LIMITS.maxBytes, 'poseData');
  return value;
}

export const MOTION_MEASUREMENT_FIELDS = Object.freeze(['elbowAngle','shoulderAngle','hipAngle','kneeAngle','bodyAlignmentAngle','torsoLean']);
const QUALITY_KEYS=['totalFrames','validFrames','usableRatio','sourceFps','targetCoverage','reasons'];

/** Objective observations only. No local action verdict or scoring field is accepted. */
export function validateFullMotionAnalysis(value, {duration=MOTION_POSE_DATA_LIMITS.maxDuration}={}) {
  number(duration,'duration',Number.MIN_VALUE,MOTION_POSE_DATA_LIMITS.maxDuration);
  object(value,['version','quality','measurements','targetTracking','coordinateSpace'],'fullAnalysis');
  if(value.version!=='motion-observations-3d-v1')fail('fullAnalysis.version','仅支持三维观测协议');
  if(value.coordinateSpace!=='mediapipe-world-3d')fail('fullAnalysis.coordinateSpace','三维观测必须声明 MediaPipe 世界坐标');
  object(value.quality,QUALITY_KEYS,'fullAnalysis.quality');
  const q=value.quality;
  for(const key of QUALITY_KEYS)if(!own(q,key))fail('fullAnalysis.quality.'+key,'缺少完整观测字段');
  number(q.totalFrames,'quality.totalFrames',0,MOTION_POSE_DATA_LIMITS.maxFrames,true);
  number(q.validFrames,'quality.validFrames',0,q.totalFrames,true);
  number(q.usableRatio,'quality.usableRatio',0,1);
  if(Math.abs(q.usableRatio-(q.totalFrames?q.validFrames/q.totalFrames:0))>0.001)fail('quality.usableRatio','有效帧比例不一致');
  if(q.sourceFps!==null)number(q.sourceFps,'quality.sourceFps',Number.MIN_VALUE,1000);
  if(q.targetCoverage!==null)number(q.targetCoverage,'quality.targetCoverage',0,1);
  if(!Array.isArray(q.reasons)||q.reasons.length>64)fail('quality.reasons','缺少有效的观测说明');
  q.reasons.forEach((reason,i)=>string(reason,'quality.reasons['+i+']',100));
  if(!Array.isArray(value.measurements)||value.measurements.length!==q.totalFrames)fail('fullAnalysis.measurements','必须保留每个采样帧的完整测量');
  let lastTime=-1;
  for(const [index,row]of value.measurements.entries()){
    const path='fullAnalysis.measurements['+index+']';object(row,['frameIndex','time','left','right'],path);
    if(row.frameIndex!==index)fail(path+'.frameIndex','必须保留完整帧序号');
    number(row.time,path+'.time',0,duration);
    if(row.time<=lastTime)fail(path+'.time','采样时间必须严格递增');lastTime=row.time;
    for(const side of ['left','right']){
      object(row[side],MOTION_MEASUREMENT_FIELDS,path+'.'+side);
      for(const key of MOTION_MEASUREMENT_FIELDS){
        if(!own(row[side],key))fail(path+'.'+side+'.'+key,'缺失测量必须显式为 null');
        if(row[side][key]!==null)number(row[side][key],path+'.'+side+'.'+key,0,180);
      }
    }
  }
  optional(value,'targetTracking',(item,path)=>targetTracking(item,path,q.totalFrames),'fullAnalysis');
  bytes(value,MOTION_POSE_DATA_LIMITS.maxAnalysisBytes,'fullAnalysis');return value;
}

export function buildFullMotionAnalysis(observations,pipeline={}) {
  const value=cloneJson(observations,'fullAnalysis');
  if(pipeline.targetTracking!==undefined)value.targetTracking=cloneJson(pipeline.targetTracking);
  return validateFullMotionAnalysis(value,{duration:pipeline.duration});
}
