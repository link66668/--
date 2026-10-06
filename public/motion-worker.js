// Pose inference and video decoding run in this background worker.
let pose, tracker;
let busy = false;
let sequential;
let sourceDecoder, source;
let previousDecodedInference;

async function analyzeFrame(image, timestampMs, sourceTime) {
  const started = performance.now();
  // WebCodecs can map several sample positions to one actual decoded
  // frame (low/VFR source FPS). It passes that same canvas and source timestamp
  // for each position. Reuse only this proven identical image; a reused canvas
  // with a new timestamp or an unrelated image must always be inferred again.
  const repeated = Number.isFinite(sourceTime) && previousDecodedInference?.image === image
    && previousDecodedInference.sourceTime === sourceTime;
  const result = repeated ? previousDecodedInference.result : await pose.detect(image, timestampMs);
  previousDecodedInference = Number.isFinite(sourceTime) ? { image, sourceTime, result } : undefined;
  const selected = tracker.update(result.landmarks, timestampMs / 1000);
  const index = selected.index;
  return {
    personCount: result.landmarks.length, multiPersonCheck: true, subjectTracking: selected.subjectTracking,
    landmarks: index === null ? [] : result.landmarks[index],
    worldLandmarks: index === null ? [] : result.worldLandmarks?.[index] ?? [],
    inferenceMs: performance.now() - started,
  };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (busy) {
    data.bitmap?.close();
    self.postMessage({ id, error: '姿态分析任务仍在运行。' });
    return;
  }
  busy = true;
  try {
    if (type === 'init') {
      if (typeof OffscreenCanvas === 'undefined') throw new Error('浏览器不支持后台画布，请使用新版 Chrome 或 Edge。');
      const { getMotionPoseModel } = await import('./motion-models.js');
      const model = getMotionPoseModel(data.model);
      const { validateTargetPoint, createSubjectTracker } = await import('./motion-tracking.js');
      tracker = createSubjectTracker({ targetPoint: validateTargetPoint(data.targetPoint) });
      const { createMediaPipe } = await import('./motion-mediapipe.js');
      pose = await createMediaPipe({ model: model.id, delegate: data.delegate });
      previousDecodedInference = undefined;
      self.postMessage({ id, delegate: pose.delegate, modelVersion: model.version });
    } else if (type === 'prepare-source') {
      source?.close(); source = undefined;
      sourceDecoder = await import('./motion-software-decode.js');
      source = await sourceDecoder.prepareMotionSource(data.file);
      self.postMessage({ id, metadata: source.metadata });
    } else if (type === 'decode-source') {
      if (!pose || !source) throw new Error('原视频解码尚未初始化。');
      try {
        const timing = await sourceDecoder.decodePreparedMotion(source, async (canvas, target) => {
          const result = await analyzeFrame(canvas, target.time * 1000);
          self.postMessage({ id, type: 'frame-result', frame: { time: target.time, ...result } });
        }, {
          asyncInference: true,
          sampleFps: data.options?.sampleFps,
          maxDimension: data.options?.maxDimension || 1280,
          onPreview: frame => self.postMessage({ id, type: 'preview-frame', frame }, [frame.bytes.buffer]),
          onPreviewReset: stride => self.postMessage({ id, type: 'preview-reset', stride }),
        });
        self.postMessage({ id, timing });
      } finally { source.close(); source = undefined; }
    } else if (type === 'prepare-mp4') {
      previousDecodedInference = undefined;
      const { prepareMp4 } = await import('./motion-decode.js');
      const prepared = await prepareMp4(data.file, data.options);
      sequential = prepared?.run ? prepared : undefined;
      self.postMessage({ id, supported: !!sequential, sourceFps: prepared?.sourceFps ?? null });
    } else if (type === 'decode-mp4') {
      if (!pose || !sequential) throw new Error('顺序解码尚未初始化。');
      const timing = await sequential.run(async (canvas, target) => {
        const result = await analyzeFrame(canvas, target.time * 1000, target.sourceTime);
        self.postMessage({ id, type: 'frame-result', frame: { time: target.time, sourceTime: target.sourceTime, ...result } });
      });
      sequential = undefined;
      previousDecodedInference = undefined;
      self.postMessage({ id, timing });
    } else if (type === 'frame') {
      if (!pose) throw new Error('姿态模型尚未加载完成。');
      try {
        self.postMessage({ id, ...await analyzeFrame(data.bitmap, data.timestampMs) });
      } finally { data.bitmap.close(); }
    } else if (type === 'close') {
      source?.close(); source = undefined;
      await pose?.close();
      pose = tracker = undefined;
      previousDecodedInference = undefined;
      self.postMessage({ id });
    } else throw new Error('未知的姿态分析请求。');
  } catch (error) {
    // Also cover rejected frames sent before initialization (close is idempotent).
    data.bitmap?.close();
    self.postMessage({ id, error: error?.message || '姿态分析失败。' });
  } finally { busy = false; }
};
