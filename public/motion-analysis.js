/**
 * Objective measurements of the selected person's pose. MediaPipe world data
 * supplies estimated 3D angles for all model tiers; image data only gates visibility.
 * These observations do not determine exercise technique or clinical anatomy.
 */
export const MOTION_OBSERVATION_VERSION = 'motion-observations-3d-v1';

const SIDES = [[11, 13, 15, 23, 25, 27], [12, 14, 16, 24, 26, 28]];
const MEASUREMENTS = ['elbowAngle', 'shoulderAngle', 'hipAngle', 'kneeAngle', 'bodyAlignmentAngle', 'torsoLean'];
const emptyMeasurements = () => Object.fromEntries(MEASUREMENTS.map(name => [name, null]));
const validTime = value => Number.isFinite(value) && value >= 0;
const lockedTarget = tracking => tracking?.status === 'locked'
  && Number.isFinite(tracking.confidence) && tracking.confidence >= 0.65 && tracking.confidence <= 1
  && typeof tracking.trackId === 'string' && tracking.trackId.trim().length > 0;

function imagePoint(value, width, height) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
    || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1
    || !Number.isFinite(value.visibility) || value.visibility < 0.55 || value.visibility > 1) return null;
  return {x: value.x * width, y: value.y * height};
}

function worldPoint(value, imageValue, width, height) {
  // Model-estimated hidden joints must not bypass the existing visible-image
  // evidence gate. Missing/uncertain depth stays missing, without a 2D fallback.
  if (!imagePoint(imageValue, width, height) || !value
    || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)
    || !Number.isFinite(value.visibility) || value.visibility < 0.55 || value.visibility > 1) return null;
  return {x: value.x, y: value.y, z: value.z};
}

function angleAt3D(a, b, c) {
  if (!a || !b || !c) return null;
  const ax = a.x - b.x, ay = a.y - b.y, az = a.z - b.z;
  const cx = c.x - b.x, cy = c.y - b.y, cz = c.z - b.z;
  const firstLength = Math.hypot(ax, ay, az), secondLength = Math.hypot(cx, cy, cz);
  if (!(firstLength > 0) || !(secondLength > 0) || !Number.isFinite(firstLength) || !Number.isFinite(secondLength)) return null;
  const cosine = (ax / firstLength) * (cx / secondLength) + (ay / firstLength) * (cy / secondLength) + (az / firstLength) * (cz / secondLength);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

function measureSide(frame, side, width, height) {
  const [shoulder, elbow, wrist, hip, knee, ankle] = SIDES[side].map(index => worldPoint(frame?.worldLandmarks?.[index], frame?.landmarks?.[index], width, height));
  const angle = angleAt3D;
  const lateral = shoulder && hip ? Math.hypot(shoulder.x - hip.x, shoulder.z - hip.z) : 0;
  const vertical = shoulder && hip ? Math.abs(shoulder.y - hip.y) : 0;
  const torsoLength = Math.hypot(lateral, vertical);
  return {
    elbowAngle: angle(shoulder, elbow, wrist),
    shoulderAngle: angle(hip, shoulder, elbow),
    hipAngle: angle(shoulder, hip, knee),
    kneeAngle: angle(hip, knee, ankle),
    bodyAlignmentAngle: angle(shoulder, hip, ankle),
    // Unsigned angle to estimated world Y, 0–90.
    // MediaPipe's world Y is not a calibrated gravity axis.
    torsoLean: torsoLength > 0 && Number.isFinite(torsoLength)
      ? Math.atan2(lateral, vertical) * 180 / Math.PI : null,
  };
}

/**
 * Retains one measurement row per input frame, including missing poses.
 * frameIndex refers to the original array index; timestamps are never sorted,
 * deduplicated or used to cut away a preparation, pause or incomplete movement.
 * A valid frame has at least one measurable angle, not necessarily every joint.
 * Visibility and target-confidence gates only decide whether data can be used.
 *
 * @param {Array<{time:number,landmarks:Array,worldLandmarks?:Array,subjectTracking?:object,personCount?:number}>} frames
 * @param {{width:number,height:number,duration?:number,sourceFps?:number|null,modelVersion?:string}} options Original display dimensions after rotation.
 */
export function analyzeMotion(frames, {width, height, sourceFps} = {}) {
  const samples = Array.isArray(frames) ? frames : [];
  const reasons = new Set();
  const dimensionsValid = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const hasTracking = samples.some(frame => frame?.subjectTracking != null);
  const trackIds = new Set(samples.filter(frame => lockedTarget(frame?.subjectTracking)).map(frame => frame.subjectTracking.trackId));
  const targetChanged = trackIds.size > 1;
  if (!samples.length) reasons.add('NO_FRAMES');
  if (!dimensionsValid) reasons.add('INVALID_DIMENSIONS');
  if (targetChanged) reasons.add('TARGET_ID_CHANGED');

  let validFrames = 0, targetFrames = 0, previousTime = null;
  const measurements = Array.from(samples, (frame, frameIndex) => {
    const time = validTime(frame?.time) ? frame.time : null;
    if (time === null) reasons.add('INVALID_FRAME_TIME');
    if (time !== null && previousTime !== null && time <= previousTime) reasons.add('NON_MONOTONIC_FRAME_TIMES');

    if (time !== null) previousTime = time;
    let targetUsable = !targetChanged;
    if (hasTracking && !lockedTarget(frame?.subjectTracking)) {
      targetUsable = false;
      reasons.add('TARGET_NOT_LOCKED');
    } else if (!hasTracking && Number.isFinite(frame?.personCount) && frame.personCount > 1) {
      targetUsable = false;
      reasons.add('UNRESOLVED_TARGET');
    }
    if (frame?.personCount === 0) {
      targetUsable = false;
      reasons.add('NO_VISIBLE_PERSON');
    }
    if (hasTracking && targetUsable) targetFrames++;

    const canMeasure = dimensionsValid && time !== null && targetUsable;
    const left = canMeasure ? measureSide(frame, 0, width, height) : emptyMeasurements();
    const right = canMeasure ? measureSide(frame, 1, width, height) : emptyMeasurements();
    const values = [...Object.values(left), ...Object.values(right)];
    if (values.some(Number.isFinite)) validFrames++;
    if (canMeasure && values.some(value => value === null)) reasons.add('MISSING_OR_UNCERTAIN_LANDMARKS');
    return {frameIndex, time, left, right};
  });

  return {
    version: MOTION_OBSERVATION_VERSION,
    coordinateSpace: 'mediapipe-world-3d',
    quality: {
      totalFrames: samples.length,
      validFrames,
      usableRatio: samples.length ? validFrames / samples.length : 0,
      sourceFps: Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : null,
      targetCoverage: hasTracking ? (samples.length ? targetFrames / samples.length : 0) : null,
      reasons: [...reasons],
    },
    measurements,
  };
}

export default analyzeMotion;
