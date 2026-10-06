import {complete, HttpError} from './providers.mjs';
import {motionCoachActionCatalog} from '../public/motion-contract.js';
import {sanitizeMotionVerdict} from '../public/motion-verdict.js';
import {MOTION_BODY_LANDMARK_INDICES} from '../public/motion-pose-data.js';
import {MOTION_COACH_BASE_PROMPT, MOTION_COACH_VISUAL_PROMPT, readMotionCoachResponse, checkMotionCoachResult} from './motion-coach-full.mjs';
import {buildMotionSequenceContext} from './motion-coach-context.mjs';

export const MOTION_TEMPORAL_LIMITS = Object.freeze({maxChars: 64000, maxFrames: 64, maxWindows: 8});
const jointIndices = MOTION_BODY_LANDMARK_INDICES;
const angleNames = ['elbowAngle', 'shoulderAngle', 'hipAngle', 'kneeAngle', 'bodyAlignmentAngle', 'torsoLean'];
const channels = ['left', 'right'].flatMap(side => angleNames.map(angle => [side, angle]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const coordinateValue = value => finite(value) ? value < 0 || value > 1 ? value : Number(value.toFixed(5)) : null;
// Metric world coordinates are signed and are never clamped to image bounds.
const worldCoordinateValue = value => finite(value) ? Number(value.toFixed(5)) : null;
// Downward precision never promotes a response below a reliability threshold.
// Values outside the declared range retain their original invalidity.
const compactResponse = value => finite(value) && value >= 0 && value <= 1 ? Math.floor(value * 1000) / 1000 : value;
const compactAngle = value => finite(value) ? Number(value.toFixed(2)) : value;
function compactTracking(value) {
  const result = {...value};
  if (finite(result.confidence)) result.confidence = compactResponse(result.confidence);
  if (result.bbox) {
    const bbox = Object.fromEntries(Object.entries(result.bbox).map(([key, coordinate]) => [key, coordinateValue(coordinate)]));
    if (bbox.xMin < bbox.xMax && bbox.yMin < bbox.yMax) result.bbox = bbox;
  }
  return result;
}

function selectFrames(input, limit, overview) {
  const count = input.poseData.frames.length;
  if (count <= limit) return Array.from({length: count}, (_, index) => index);
  const selected = new Set();
  // Reserve half the budget for uniform full-video coverage, even when the
  // largest movement occurs only at the start or in one limb.
  const uniform = Math.ceil(limit / 2);
  for (let index = 0; index < uniform; index++) selected.add(Math.round(index * (count - 1) / (uniform - 1)));
  const trajectories = [...overview.trajectories].sort((a, b) => (b.maximum.value - b.minimum.value) - (a.maximum.value - a.minimum.value));
  const extremaLimit = Math.min(limit - 8, selected.size + 24);
  for (const trajectory of trajectories) for (const key of ['minimum', 'maximum']) {
    if (selected.size < extremaLimit) selected.add(trajectory[key].frameIndex);
  }
  // Changes only select observations. They never label a movement or determine
  // good/bad form; single-frame jumps can also be tracking noise.
  const changes = [];
  const rows = input.fullAnalysis.measurements;
  for (let index = 1; index < count; index++) {
    const before = rows[index - 1], after = rows[index];
    let change = 0;
    for (const [side, angle] of channels) if (finite(before?.[side]?.[angle]) && finite(after?.[side]?.[angle])) {
      change = Math.max(change, Math.abs(after[side][angle] - before[side][angle]));
    }
    if (change > 0) changes.push({index, change});
  }
  changes.sort((a, b) => b.change - a.change || a.index - b.index);
  for (const {index} of changes) {
    if (selected.size >= limit) break;
    selected.add(index);
    if (selected.size < limit) selected.add(index - 1);
  }
  // Static clips still benefit from distributed observations over the clip.
  for (let index = 0; index < limit && selected.size < limit; index++) selected.add(Math.round(index * (count - 1) / (limit - 1)));
  return [...selected].sort((a, b) => a - b);
}

function summarizeMeasurements(input, windowCount, displayAngle = value => value) {
  const buckets = Array.from({length: windowCount}, () => []);
  const rows = input.fullAnalysis.measurements;
  rows.forEach((row, index) => buckets[Math.min(windowCount - 1, Math.floor(row.time / input.duration * windowCount))].push(index));
  const allowed = new Map(), sourceTimes = new Map();
  const record = (index, side, angle) => {
    const path = ['measurements', index, side, angle];
    allowed.set(JSON.stringify(path), path);
    sourceTimes.set(index, rows[index].time);
  };
  const windows = buckets.map((indices, windowIndex) => {
    const statistics = channels.flatMap(([side, angle]) => {
      const present = indices.filter(index => finite(rows[index]?.[side]?.[angle]));
      if (!present.length) return [];
      let minimum = present[0], maximum = present[0];
      for (const index of present) {
        if (rows[index][side][angle] < rows[minimum][side][angle]) minimum = index;
        if (rows[index][side][angle] > rows[maximum][side][angle]) maximum = index;
      }
      const references = [present[0], present.at(-1), minimum, maximum];
      for (const index of references) record(index, side, angle);
      return [{path: [side, angle], values: [present.length, ...references.flatMap(index => [index, displayAngle(rows[index][side][angle])])]}];
    });
    return {startTime: windowIndex * input.duration / windowCount, endTime: (windowIndex + 1) * input.duration / windowCount,
      sourceFrameCount: indices.length, statistics};
  });
  return {windows, allowed, sourceTimes};
}

/** One bounded evidence package: selected body observations plus statistics
 * computed over EVERY source measurement. This is explicitly not a claim that
 * a model inspected every original frame and all 33 landmark slots. Coordinates have a declared
 * precision; guided transport can explicitly round numeric displays while
 * reference selection and validation retain the original measurements. */
export function buildMotionTemporalEvidence(input, {maxChars = MOTION_TEMPORAL_LIMITS.maxChars, compactNumbers = false, minFrames = 24} = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 16000) throw new Error('时序证据预算至少为 16000 个字符。');
  if (typeof compactNumbers !== 'boolean' || !Number.isInteger(minFrames) || minFrames < 12 || minFrames > 24) throw new Error('时序证据精度或最少帧数无效。');
  const overview = buildMotionSequenceContext(input);
  const displayAngle = compactNumbers ? compactAngle : value => value;
  let frameLimit = MOTION_TEMPORAL_LIMITS.maxFrames, windowCount = Math.min(MOTION_TEMPORAL_LIMITS.maxWindows, Math.max(1, Math.ceil(input.duration / 2)));
  for (;;) {
    const sourceFrameIndices = selectFrames(input, frameLimit, overview);
    const {windows, allowed, sourceTimes} = summarizeMeasurements(input, windowCount, displayAngle);
    const frames = sourceFrameIndices.map(frameIndex => {
      const frame = input.poseData.frames[frameIndex];
      const landmarks = jointIndices.map(index => {
        const point = frame.landmarks?.[index];
        return Array.isArray(point) ? point.slice(0, 3).map((value, field) => point[3] & (1 << field) ? null : field === 2 ? compactNumbers ? compactResponse(value) : value : coordinateValue(value)) : null;
      });
      return {frameIndex, time: frame.time, ...(finite(frame.sourceTime) ? {sourceTime: frame.sourceTime} : {}),
        ...(frame.subjectTracking ? {subjectTracking: compactNumbers ? compactTracking(frame.subjectTracking) : frame.subjectTracking} : {}), landmarks,
        worldLandmarks: frame.worldLandmarks === null ? null : frame.worldLandmarks?.length ? jointIndices.map(index => {
          const point = frame.worldLandmarks[index];
          return Array.isArray(point) ? point.slice(0, 4).map((value, field) => point[4] & (1 << field) ? null : field === 3 ? compactNumbers ? compactResponse(value) : value : worldCoordinateValue(value)) : null;
        }) : []};
    });
    const measurements = sourceFrameIndices.map(index => {
      const row = input.fullAnalysis.measurements[index];
      return [index, row.time, ...channels.map(([side, angle]) => {
        const value = row[side]?.[angle];
        if (!finite(value)) return null;
        const path = ['measurements', index, side, angle];
        allowed.set(JSON.stringify(path), path);
        return displayAngle(value);
      })];
    });
    const evidence = {strategy: 'temporal-evidence', sourceFrameCount: input.poseData.frames.length,
      sourceFrameIndices, summarizedMeasurementCount: input.fullAnalysis.measurements.length,
      poseSchema: {profile: 'fitness-body17', width: input.poseData.width, height: input.poseData.height, sampleFps: input.poseData.sampleFps,
        ...(input.poseData.modelVersion ? {modelVersion: input.poseData.modelVersion} : {}),
        landmarkIndices: jointIndices, landmarkNames: jointIndices.map(index => input.poseData.landmarkNames[index]),
        pointFields: ['x', 'y', 'visibility'], coordinateDecimals: 5, outOfBoundsCoordinates: 'original', visibilityPrecision: compactNumbers ? 'floor-3-decimals-in-range' : 'original',
        sourceFormat: input.poseData.format, worldPointFields: input.poseData.worldPointFields,
        worldCoordinateSpace: 'mediapipe-world-3d', worldCoordinateUnits: 'meters', worldCoordinateOrigin: 'hip-midpoint', worldCoordinateDecimals: 5,
        worldCoordinateKind: 'model-estimated', measurementCoordinateSpace: input.fullAnalysis.coordinateSpace,
        torsoLeanReference: 'model-camera-y-axis-not-measured-gravity',
        ...(compactNumbers ? {measurementDecimals: 2, measurementPrecision: 'approximate-rounded', trackingConfidencePrecision: 'floor-3-decimals-in-range', trackingBoxDecimals: 5} : {}),
        coordinates: input.poseData.coordinates, ...(input.poseData.targetTracking ? {targetTracking: input.poseData.targetTracking} : {})},
      frames, measurementColumns: ['frameIndex', 'time', ...channels.map(path => path.join('.'))], measurements,
      windowStatisticColumns: ['sampleCount', 'firstFrameIndex', 'firstValue', 'lastFrameIndex', 'lastValue', 'minimumFrameIndex', 'minimumValue', 'maximumFrameIndex', 'maximumValue'],
      windows, statisticSourceTimes: [...sourceTimes].sort(([a], [b]) => a - b)};
    if (JSON.stringify(evidence).length <= maxChars) return {evidence, allowedAnalysisPaths: [...allowed.values()]};
    // Budget changes choose a smaller distributed sample; they never slice a
    // JSON string, lose a measurement window or misstate what was reviewed.
    if (frameLimit > 24) frameLimit -= 8;
    else if (windowCount > 1) windowCount--;
    else if (frameLimit > minFrames) frameLimit = Math.max(minFrames, frameLimit - 8);
    else throw new HttpError(413, '时序证据过大，请缩短视频后重新评估。');
  }
}

const TEMPORAL_PROMPT=`这是一次完整的时序证据评估，不是完整原始逐帧审阅。evidence.sourceFrameCount是原始骨架帧数，sourceFrameIndices是本次实际提供的全局骨架下标；evidence.frames只含主要身体点，点顺序由poseSchema.landmarkIndices定义，不含本次未列出的原始节点。统一保留鼻及16个身体关节点，不含面部细节和手指；17个槽位不代表每帧17个点都有可靠观测，null表示缺失。frameIndices引用frameIndex，绝不能引用本次数组位置。landmarks仅用于截图定位和可见性检查，为原图二维归一化坐标，0至1范围内保留5位小数；越界图像坐标不能当作可见点。poseSchema.worldCoordinateSpace为mediapipe-world-3d，worldLandmarks包含[x,y,z,visibility]，与landmarks顺序相同；以髋中点为原点、米为单位，负数和超出0至1的值正常有效，不能按图像越界过滤。三维坐标是模型估计，不是实测深度、全局位移轨迹或重力方向；缺失worldLandmarks不能用二维数据冒充。坐标和响应精度按poseSchema声明读取。未见的点和过程不能补猜。缺失值null不是0。
measurements是按measurementColumns排列的选中帧角度表，维度由poseSchema.measurementCoordinateSpace声明。windows按时间覆盖全部原始测量，每个statistics的path为[left或right,角度字段]，values按windowStatisticColumns读取；statisticSourceTimes给出统计引用的全局帧号与原始时间。统计的首尾、极小、极大均为实际观测。analysisPaths只能引用本次表格或统计实际显示的标量，如["measurements",全局帧号,"left","kneeAngle"]。没有提供完整窗口轨迹，不能由极值或均匀抽帧推断次数、连续速度、每次动作或跨缺失片段的控制情况。
窗口用于理解全片变化、寻找与图片一致的动作阶段，不能把窗口边界当动作边界，也不能把角度极值直接当技术错误。请结合全片图片、身体支撑、主关节变化区分动作；动作已识别且可评估的阶段有正向证据才给standard。mixed动作或问题只在部分时间出现时在结论和证据中说明。仅本次证据不足以判定时用uncertain，不能因没有提出缺点而自动判标准。
left/right是训练者自身左右；elbowAngle为肩-肘-腕，shoulderAngle为髋-肩-肘，hipAngle为肩-髋-膝，kneeAngle为髋-膝-踝，bodyAlignmentAngle为肩-髋-踝，measurementCoordinateSpace固定为mediapipe-world-3d，五种关节角均由世界坐标计算三维夹角，torsoLean为三维肩髋连线与模型相机Y轴的无向夹角（0至90度），不是重力垂线夹角。相机倾斜和深度估计误差会影响结果；不得由三维角度推断脊柱曲度、关节受力或伤病。`;

export async function completeTemporalMotionCoach({provider, input, signal, onProgress = () => {}, timeoutMs = 180000, ...options}) {
  if (provider.models?.find(item => item.id === provider.model)?.vision !== true) throw new HttpError(400, '动作评估需要支持图片的 AI 模型，请在 AI 服务设置中更换动作点评模型。');
  if (!input.keyframes?.length) throw new HttpError(400, '动作评估需要关键截图，请重新提取视频画面。');
  const started = performance.now(), images = [...input.keyframes].sort((a, b) => a.time - b.time);
  const {evidence, allowedAnalysisPaths} = buildMotionTemporalEvidence(input);
  const context = {stage: 'temporal-evidence', duration: input.duration, analysis: input.analysis, evidence,
    frames: images.map(({time, mimeType}, imageIndex) => ({imageIndex, time, mimeType}))};
  const system = MOTION_COACH_BASE_PROMPT + '\n' + TEMPORAL_PROMPT + '\n' + MOTION_COACH_VISUAL_PROMPT + '\n动作名称目录：' + JSON.stringify(motionCoachActionCatalog());
  const content = [{type: 'text', text: JSON.stringify(context)}];
  for (const [imageIndex, frame] of images.entries()) content.push({type: 'text', text: `图片 imageIndex=${imageIndex}，画面时间 ${frame.time} 秒`}, {type: 'image_url', image_url: {url: `data:${frame.mimeType};base64,${frame.data}`}});
  if (system.length + content.filter(part => part.type === 'text').reduce((sum, part) => sum + part.text.length, 0) > 128000) throw new HttpError(413, '时序动作评价的上下文过大，请缩短视频后重试。');
  const progress = (stage, message, completed = 0) => onProgress({stage, message, completed, total: 1, elapsedMs: Math.round(performance.now() - started)});
  await progress('processing', `AI 正在结合 ${images.length} 张截图与 ${evidence.sourceFrameIndices.length} 帧时序证据评价动作…`);
  let final, response, modelCalls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    modelCalls++;
    try {
      response = await complete({...options, provider, timeoutMs, signal, purpose: 'motion-coach', messages: [{role: 'system', content: system}, {role: 'user', content}]});
      signal?.throwIfAborted();
      final = checkMotionCoachResult(readMotionCoachResponse(response), input, images, evidence.sourceFrameIndices, allowedAnalysisPaths);
      break;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.status === 504 && attempt === 0) { await progress('retry', '动作评价响应较慢，正在重试本次时序证据。'); continue; }
      throw error;
    }
  }
  const coverage = {complete: true, strategy: 'temporal-evidence', sourceFrameCount: input.poseData.frames.length,
    frameCount: evidence.sourceFrameIndices.length, reviewedFrameCount: evidence.sourceFrameIndices.length,
    measurementCount: input.fullAnalysis.measurements.length, summarizedMeasurementCount: input.fullAnalysis.measurements.length,
    reviewedMeasurementCount: evidence.sourceFrameIndices.length, dataBatches: 1, modelCalls};
  final.feedback = [...final.feedback].sort((a, b) => Number(b.status === 'improve') - Number(a.status === 'improve') || a.priority - b.priority).slice(0, 3);
  final.verdict = sanitizeMotionVerdict(final.verdict, {feedback: final.feedback, coverage, quality: input.fullAnalysis.quality, action: final.action});
  final.overallEvaluation = final.verdict.summary;
  await progress('complete', '动作识别与纠正建议已生成。', 1);
  return {...final, model: provider.model, provider: provider.name, coverage,
    timing: {providerMs: Math.round(response.timing?.providerMs || 0), totalMs: Math.round(performance.now() - started)}};
}
