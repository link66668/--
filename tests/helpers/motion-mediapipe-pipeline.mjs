// Synthetic MediaPipe-shaped contract fixtures. These are not predictions,
// measured depths or independently labelled evidence of model accuracy.
export function makeMediaPipePipeline(count = 45, tier = 'Full') {
  const frames = Array.from({length: count}, (_, index) => {
    const offset = Math.sin(index / 17) * .02;
    const landmarks = Array.from({length: 33}, (_, joint) => ({x: .2 + joint / 80 + offset + .000123456789,
      y: .2 + joint / 80 - offset + .000987654321, visibility: .987654321}));
    const worldLandmarks = landmarks.map((point, joint) => ({x: point.x - .5, y: point.y - .5, z: Math.sin(joint / 5 + index / 17) * .1, visibility: point.visibility}));
    return {time: index / 15, sourceTime: index / 15, landmarks, worldLandmarks,
      personCount: 2, multiPersonCheck: true,
      subjectTracking: {status: 'locked', trackId: 'motion-target-1', confidence: .99, bbox: {xMin: 0, yMin: .1, xMax: 1, yMax: .9}}};
  });
  return {width: 1920, height: 1080, duration: count / 15, sampleFps: 15, sourceFps: 30,
    modelVersion: `MediaPipe Pose Landmarker ${tier} synthetic / world3d-v1`, delegate: 'CPU', decoder: 'webcodecs', codec: 'avc1.640028', elapsedMs: 12.345,
    timing: {initializationMs: 1.1, decodeMs: 2.2, inferenceMs: 3.3},
    targetTracking: {mode: 'center', point: null, trackId: 'motion-target-1', coverage: 1, lockedFrames: count, ambiguousFrames: 0, lostFrames: 0, totalFrames: count, maxPeople: 2, summary: '完整跟踪'}, frames};
}

// Deterministic planar XYZ geometry for transport/evidence tests only. This
// helper is never used by runtime, never estimates missing production depth.
export function toMediaPipePipeline(pipeline, tier = 'Full') {
  return {...pipeline, modelVersion: `MediaPipe Pose Landmarker ${tier} synthetic / world3d-v1`, frames: pipeline.frames.map(frame => {
    const landmarks = frame.landmarks;
    const worldLandmarks = frame.worldLandmarks ?? (Array.isArray(landmarks) ? landmarks.map(point => point && ({x: (point.x - .5) * (pipeline.width || 1) / (pipeline.height || 1), y: point.y - .5, z: 0, visibility: point.visibility})) : []);
    return {...frame, landmarks, worldLandmarks};
  })};
}
