const mediaPipeModel = (variant, tier, description) => Object.freeze({
  id: `mediapipe-${variant.toLowerCase()}`,
  tier,
  label: `MediaPipe ${variant}`,
  description,
  assetPath: `pose_landmarker_${variant.toLowerCase()}.task`,
  version: `MediaPipe Pose Landmarker ${variant} float16 v1 / tasks-vision 0.10.32 / world3d-v1`,
  loadingMessage: `正在加载${tier}骨架模型 MediaPipe ${variant}…`,
  initTimeoutMs: variant === 'Heavy' ? 300000 : 180000,
  analysisTimeoutMs: 3600000,
});

export const MOTION_POSE_MODELS = Object.freeze([
  mediaPipeModel('Lite', '快速', '适合低性能设备和快速分析'),
  mediaPipeModel('Full', '标准', '默认模型，兼顾精度与分析速度'),
  mediaPipeModel('Heavy', '高精度', '精度更高，但分析时间更长'),
]);

// UI, chat tools and every decoder share the same standard default.
export const MOTION_POSE_MODEL = MOTION_POSE_MODELS[1];

export function getMotionPoseModel(id = MOTION_POSE_MODEL.id) {
  const model = MOTION_POSE_MODELS.find(item => item.id === id);
  if (!model) throw new Error('不支持的骨架分析模型。');
  return model;
}
