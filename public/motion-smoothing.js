// One Euro filtering changes only the display coordinates. At 15 Hz the low
// resting cutoff reduces small jitter; velocity raises it for fast movements.
// Express beta at a 1000 px long edge so proportional resolutions agree.
export const MOTION_SMOOTHING_CONFIG = Object.freeze({
  minCutoff: 1.1,
  derivativeCutoff: 1,
  beta: .03,
  referenceLongEdge: 1000,
  maxGapSeconds: .3,
});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validPoint = point => point && [point.x, point.y, point.visibility].every(finite)
  && point.visibility > 0 && point.visibility <= 1 && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
const mix = (previous, value, weight) => previous + weight * (value - previous);
const clonePoints = points => Array.isArray(points) ? points.map(point => point ? { ...point } : point) : points;

function filterPoint(point, previous, dt, width, height, beta) {
  const x = point.x * width, y = point.y * height;
  if (!previous) return { rawX: x, rawY: y, x, y, dx: 0, dy: 0 };
  const derivativeWeight = alpha(MOTION_SMOOTHING_CONFIG.derivativeCutoff, dt);
  const dx = mix(previous.dx, (x - previous.rawX) / dt, derivativeWeight);
  const dy = mix(previous.dy, (y - previous.rawY) / dt, derivativeWeight);
  // A shared cutoff for x/y uses physical image distance, avoiding a different
  // response to horizontal and vertical movement in portrait video.
  const weight = alpha(MOTION_SMOOTHING_CONFIG.minCutoff + beta * Math.hypot(dx, dy), dt);
  return { rawX: x, rawY: y, x: mix(previous.x, x, weight), y: mix(previous.y, y, weight), dx, dy };
}

/** Build once after inference, then seek/play these frames in any order.
 * Never pass this display-only result to angle measurement or AI evidence.
 * Missing observations remain missing; no interpolation or extrapolation is
 * used, and each target/visibility discontinuity starts a fresh filter.
 */
export function buildSmoothedMotionFrames(frames, { width, height } = {}) {
  if (!Array.isArray(frames)) throw new TypeError('骨架显示帧必须为数组。');
  if (![width, height].every(value => finite(value) && value > 0)) throw new TypeError('骨架显示尺寸无效。');
  const beta = MOTION_SMOOTHING_CONFIG.beta * MOTION_SMOOTHING_CONFIG.referenceLongEdge / Math.max(width, height);
  let previousPoints = [], previousTime, previousTrackId;
  return frames.map(frame => {
    const output = { ...frame, landmarks: clonePoints(frame.landmarks), worldLandmarks: clonePoints(frame.worldLandmarks) };
    const time = finite(frame.sourceTime) ? frame.sourceTime : frame.time;
    const trackId = frame.subjectTracking?.trackId;
    const tracked = frame.subjectTracking?.status === 'locked';
    if (!tracked || !finite(time) || !Array.isArray(frame.landmarks) || frame.landmarks.length !== 33) {
      previousPoints = []; previousTime = undefined; previousTrackId = undefined;
      return output;
    }
    const dt = time - previousTime;
    if (!finite(dt) || dt <= 0 || dt > MOTION_SMOOTHING_CONFIG.maxGapSeconds || trackId !== previousTrackId) previousPoints = [];
    const nextPoints = [];
    output.landmarks = frame.landmarks.map((point, index) => {
      if (!validPoint(point)) return point ? { ...point } : point;
      const filtered = filterPoint(point, previousPoints[index], dt, width, height, beta);
      nextPoints[index] = filtered;
      return { ...point, x: filtered.x / width, y: filtered.y / height };
    });
    previousPoints = nextPoints; previousTime = time; previousTrackId = trackId;
    return output;
  });
}
