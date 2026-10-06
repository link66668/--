// Keep image coordinates for tracking/overlays, separate from the model's
// estimated world coordinates (metres, hip-centred) used for 3D measurements.
export function mediaPipeLandmarks(result) {
  return (result.landmarks || []).map(points => points.map(({ x, y, visibility }) => ({ x, y, visibility })));
}

export function mediaPipeWorldLandmarks(result) {
  return (result.worldLandmarks || []).map(points => points.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })));
}

export async function createMediaPipe({ model, delegate = 'GPU' } = {}) {
  const poseModel = getMotionPoseModel(model);
  const { FilesetResolver, PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
  const root = new URL('./vendor/mediapipe/', import.meta.url);
  const vision = await FilesetResolver.forVisionTasks(new URL('wasm', root).href);
  const pose = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: new URL(poseModel.assetPath, root).href, delegate },
    runningMode: 'VIDEO',
    numPoses: 4,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  return {
    delegate,
    detect(image, timestampMs) {
      const result = pose.detectForVideo(image, timestampMs);
      return { landmarks: mediaPipeLandmarks(result), worldLandmarks: mediaPipeWorldLandmarks(result) };
    },
    close() { pose.close(); },
  };
}
import { getMotionPoseModel } from './motion-models.js';
