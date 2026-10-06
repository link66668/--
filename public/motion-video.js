import { MOTION_VIDEO_LIMITS, validateVideoFile, validateVideoMetadata, prepareMotionVideo } from './motion-media.js';
import { MOTION_POSE_MODEL, getMotionPoseModel } from './motion-models.js';
export { MOTION_VIDEO_LIMITS, validateVideoFile, validateVideoMetadata } from './motion-media.js';
export const MOTION_MODEL_VERSION = MOTION_POSE_MODEL.version;

const aborted = () => new DOMException('已取消视频分析。', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };

export function sampleVideoTimes(duration, fps = MOTION_VIDEO_LIMITS.sampleFps) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('无效的视频采样参数。');
  return Array.from({ length: Math.ceil(duration * fps) }, (_, index) => index / fps);
}

export function browserSeekTime(time, duration) {
  // Chromium truncates currentTime to microseconds. Move just beyond an exact
  // frame boundary so 1/15 does not become 0.066666 and select the prior frame.
  // Result timestamps remain canonical; never seek to or past the media end.
  return Math.max(0, Math.min(time + 0.000002, duration - 0.000001));
}

export function scaledVideoSize(width, height, maxDimension = MOTION_VIDEO_LIMITS.maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function mediaEvent(video, event, signal, trigger, timeoutMs = 15000) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer); video.removeEventListener(event, success); video.removeEventListener('error', failure); signal?.removeEventListener('abort', cancel);
    };
    const finish = (callback, value) => { cleanup(); callback(value); };
    const success = () => finish(resolve);
    const failure = () => finish(reject, new Error('浏览器无法解码这个视频，请转换为 H.264 MP4 或 WebM 后重试。'));
    const cancel = () => finish(reject, aborted());
    video.addEventListener(event, success, { once: true }); video.addEventListener('error', failure, { once: true }); signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(reject, new Error('读取视频超时，请检查文件是否损坏或转换格式后重试。')), timeoutMs);
    try { trigger?.(); } catch (error) { finish(reject, error); }
  });
}

function createPoseWorker(signal) {
  const worker = new Worker(new URL('./motion-worker.js', import.meta.url));
  let sequence = 0, pending, stopped = false;
  const fail = error => { pending?.reject(error); pending = undefined; };
  const stop = () => { if (stopped) return; stopped = true; worker.terminate(); fail(aborted()); signal?.removeEventListener('abort', stop); };
  worker.onmessage = ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    if (data.type === 'frame-result') {
      try { pending.onFrame?.(data.frame); } catch (error) { fail(error); }
      return;
    }
    if (['preview-frame', 'preview-reset', 'progress'].includes(data.type)) {
      try { pending.onEvent?.(data); } catch (error) { fail(error); }
      return;
    }
    const current = pending; pending = undefined;
    if (data.error) current.reject(new Error(data.error)); else current.resolve(data);
  };
  worker.onerror = event => { event.preventDefault(); fail(new Error('后台姿态模型无法运行：' + (event.message || '请检查浏览器或本地模型文件。'))); };
  worker.onmessageerror = () => fail(new Error('后台姿态分析结果无法读取。'));
  signal?.addEventListener('abort', stop, { once: true });
  return {
    stop,
    request(data, transfer = [], timeoutMs = 30000, onFrame, onEvent) {
      checkAbort(signal);
      if (stopped) return Promise.reject(aborted());
      if (pending) return Promise.reject(new Error('上一帧尚未处理完成。'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { fail(new Error('姿态模型处理超时，请缩短视频后重试。')); }, timeoutMs);
        pending = { id, onFrame, onEvent, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        try { worker.postMessage({ ...data, id }, transfer); } catch (error) { for (const item of transfer) item.close?.(); fail(error); }
      });
    },
  };
}

async function analyzeSoftwareVideo(file, metadata, { signal, onProgress, targetPoint, sampleFps, poseModel }) {
  const started = performance.now(), frames = [], previews = new Map();
  const totalFrames = sampleVideoTimes(metadata.duration, sampleFps).length;
  const timing = { initializationMs: 0, decodeMs: 0, inferenceMs: 0 };
  let engine, delegate = 'GPU', previewStride = 1, previewBytes = 0;
  const maxPreviewBytes = 64 * 1024 * 1024;
  const trimPreviews = stride => {
    previewStride = Math.max(previewStride, stride);
    for (const [index, frame] of previews) if (index % previewStride) { previewBytes -= frame.blob.size; previews.delete(index); }
  };
  const event = data => {
    checkAbort(signal);
    if (data.type === 'progress') { onProgress({ stage: 'decoding', ...data.progress }); return; }
    if (data.type === 'preview-reset') { trimPreviews(data.stride); return; }
    const frame = data.frame, index = frame.index ?? Math.round(frame.time * 5);
    if (frame.stride) trimPreviews(frame.stride);
    if (index % previewStride) return;
    const blob = new Blob([frame.bytes], { type: 'image/jpeg' });
    previewBytes += blob.size - (previews.get(index)?.blob.size || 0);
    previews.set(index, { time: frame.time, blob, width: frame.width, height: frame.height });
    while (previewBytes > maxPreviewBytes && previews.size > 1) trimPreviews(previewStride * 2);
  };
  try {
    onProgress({ stage: 'loading', progress: 0, totalFrames, processedFrames: 0, message: poseModel.loadingMessage, delegate });
    engine = createPoseWorker(signal);
    try { await engine.request({ type: 'init', delegate, targetPoint, model: poseModel.id }, [], poseModel.initTimeoutMs); }
    catch (error) {
      checkAbort(signal); engine.stop(); delegate = 'CPU';
      onProgress({ stage: 'loading', progress: 0, totalFrames, processedFrames: 0, message: '正在切换到 CPU 后台分析…', delegate });
      engine = createPoseWorker(signal);
      await engine.request({ type: 'init', delegate, targetPoint, model: poseModel.id }, [], poseModel.initTimeoutMs);
    }
    const prepared = await engine.request({ type: 'prepare-source', file }, [], 120000, undefined, event);
    const source = prepared.metadata;
    validateVideoMetadata(source);
    if (source.width !== metadata.width || source.height !== metadata.height || Math.abs(source.duration - metadata.duration) > 0.1) throw new Error('视频画面与读取的信息不一致，请重新选择视频。');
    timing.initializationMs = performance.now() - started;
    const decoded = await engine.request({ type: 'decode-source', options: { sampleFps, maxDimension: MOTION_VIDEO_LIMITS.maxDimension } }, [], poseModel.analysisTimeoutMs, frame => {
      checkAbort(signal);
      const expectedTime = frames.length / sampleFps;
      if (Math.abs(frame.time - expectedTime) > 0.00001 || frames.length >= totalFrames) throw new Error('视频解码采样时间不连续，请重新分析。');
      timing.inferenceMs += frame.inferenceMs || 0;
      const { inferenceMs, ...points } = frame;
      frames.push(points);
      onProgress({ stage: 'analyzing', progress: frames.length / totalFrames, processedFrames: frames.length, totalFrames, time: frame.time, delegate, message: '正在直接读取画面并分析动作…' });
    }, event);
    checkAbort(signal);
    if (frames.length !== totalFrames) throw new Error('视频未完整解码，请重新分析或选择其他视频。');
    timing.decodeMs = decoded.timing?.decodeMs ?? Math.max(0, performance.now() - started - timing.initializationMs - timing.inferenceMs);
    await engine.request({ type: 'close' });
    return { frames, ...metadata, elapsedMs: performance.now() - started, modelVersion: poseModel.version, sampleFps, sourceFps: source.sourceFps ?? null, delegate, timing, decoder: 'ffmpeg-direct', targetTracking: summarizeTargetTracking(frames, { targetPoint }), previewFps: decoded.timing?.previewFps, previewFrames: [...previews.values()].sort((a, b) => a.time - b.time) };
  } finally { engine?.stop(); }
}

/** Analyze each configured sample position across the entire local video.
 * Pixels stay on this device. Decoder queues are bounded; software video
 * decoding holds at most 16 scaled frames / 32 MiB, HTMLVideo two bitmaps.
 * Cancellation terminates the worker immediately, including native inference.
 */
export async function analyzeVideo(file, { signal: externalSignal, onProgress = () => {}, targetPoint=null, sampleFps=MOTION_VIDEO_LIMITS.sampleFps, model=MOTION_POSE_MODEL.id } = {}) {
  validateVideoFile(file); checkAbort(externalSignal);
  const poseModel = getMotionPoseModel(model);
  if (!Number.isFinite(sampleFps) || sampleFps <= 0 || sampleFps > MOTION_VIDEO_LIMITS.sampleFps) throw new Error('视频采样率必须大于 0 且不超过 15。');
  targetPoint = validateTargetPoint(targetPoint);
  if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') throw new Error('此浏览器不支持后台视频分析，请使用新版 Chrome 或 Edge。');
  const prepared = await prepareMotionVideo(file, { signal: externalSignal, onProgress });
  checkAbort(externalSignal);
  if (prepared.mode === 'software') return analyzeSoftwareVideo(file, prepared.metadata, { signal: externalSignal, onProgress, targetPoint, sampleFps, poseModel });
  file = prepared.file;
  const lifecycle = new AbortController(), signal = lifecycle.signal;
  const cancel = () => lifecycle.abort();
  externalSignal?.addEventListener('abort', cancel, { once: true });
  const started = performance.now();
  const video = document.createElement('video');
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  const objectUrl = URL.createObjectURL(file);
  let engine, bitmap, nextFramePromise;
  let delegate = 'GPU', sourceFps = null;
  try {
    onProgress({ stage: 'decoding', progress: 0, message: '正在读取本地视频…' });
    await mediaEvent(video, 'loadedmetadata', signal, () => { video.src = objectUrl; video.load(); });
    const duration = video.duration, width = video.videoWidth, height = video.videoHeight;
    validateVideoMetadata({ duration, width, height });
    if (video.readyState < 2) await mediaEvent(video, 'loadeddata', signal);
    const size = scaledVideoSize(width, height), times = sampleVideoTimes(duration, sampleFps), frames = [];
    const timing = { initializationMs: 0, decodeMs: 0, inferenceMs: 0 };
    const decodeFrame = async time => {
      checkAbort(signal);
      const decodeStarted = performance.now();
      let ownedBitmap;
      try {
        if (Math.abs(video.currentTime - time) > 0.0001) await mediaEvent(video, 'seeked', signal, () => { video.currentTime = browserSeekTime(time, duration); });
        checkAbort(signal);
        ownedBitmap = await createImageBitmap(video, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' });
        checkAbort(signal);
        timing.decodeMs += performance.now() - decodeStarted;
        return ownedBitmap;
      } catch (error) { ownedBitmap?.close(); throw error; }
    };
    const initializationStarted = performance.now();
    onProgress({ stage: 'loading', progress: 0, totalFrames: times.length, processedFrames: 0, message: poseModel.loadingMessage, delegate });
    checkAbort(signal);
    engine = createPoseWorker(signal);
    try { await engine.request({ type: 'init', delegate, targetPoint, model: poseModel.id }, [], poseModel.initTimeoutMs); }
    catch (error) {
      checkAbort(signal); engine.stop();
      delegate = 'CPU';
      onProgress({ stage: 'loading', progress: 0, totalFrames: times.length, processedFrames: 0, message: '正在切换到 CPU 后台分析…', delegate });
      checkAbort(signal);
      engine = createPoseWorker(signal);
      try { await engine.request({ type: 'init', delegate, targetPoint, model: poseModel.id }, [], poseModel.initTimeoutMs); }
      catch (cpuError) { checkAbort(signal); throw new Error(`${poseModel.label}姿态模型加载失败，请使用新版 Chrome 或 Edge，并确认模型资源完整。（${cpuError.message}）`); }
    }
    timing.initializationMs = performance.now() - initializationStarted;
    if (/\.(mp4|m4v|mov)$/i.test(file.name)) {
      let supported = false;
      try {
        ({ supported, sourceFps } = await engine.request({ type: 'prepare-mp4', file, options: { width, height, duration, sampleFps, maxDimension: MOTION_VIDEO_LIMITS.maxDimension } }));
      } catch (error) {
        checkAbort(signal); console.warn('MP4 sequential decoder is unavailable:', error.message);
        // A timed-out parser may still occupy its worker. Recreate it before
        // entering the browser fallback, just as for a mid-stream decode error.
        engine.stop(); engine = createPoseWorker(signal);
        await engine.request({ type: 'init', delegate, targetPoint, model: poseModel.id }, [], poseModel.initTimeoutMs);
      }
      if (supported) {
        let decoded;
        try {
          const result = await engine.request({ type: 'decode-mp4' }, [], poseModel.analysisTimeoutMs, frame => {
            timing.inferenceMs += frame.inferenceMs;
            const { inferenceMs, ...points } = frame;
            frames.push(points);
            onProgress({ stage: 'analyzing', progress: frames.length / times.length, processedFrames: frames.length, totalFrames: times.length, time: frame.time, delegate, message: '正在逐帧分析动作…' });
          });
          timing.decodeMs = result.timing.decodeMs;
          decoded = result;
        } catch (error) {
          checkAbort(signal);
          console.warn('Sequential video decoding fell back to HTMLVideo:', error.message);
          // Retry from the beginning with the browser decoder; no partial result
          // can be mistaken for coverage of the whole uploaded clip.
          engine.stop(); frames.length = 0; timing.inferenceMs = 0;
          onProgress({ stage: 'decoding', progress: 0, message: '正在使用兼容解码方式重新分析…' });
          engine = createPoseWorker(signal);
          await engine.request({ type: 'init', delegate, targetPoint, model: poseModel.id }, [], poseModel.initTimeoutMs);
        }
        if (decoded) {
          await engine.request({ type: 'close' });
          return { frames, width, height, duration, elapsedMs: performance.now() - started, modelVersion: poseModel.version, sampleFps, sourceFps, delegate, timing, decoder: 'webcodecs', codec: decoded.timing.codec, targetTracking: summarizeTargetTracking(frames,{targetPoint}) };
        }
      }
    }
    bitmap = await decodeFrame(times[0]);
    for (let index = 0; index < times.length; index++) {
      checkAbort(signal);
      const time = times[index];
      const request = engine.request({ type: 'frame', timestampMs: time * 1000, bitmap }, [bitmap], 120000);
      // Ownership was transferred to the worker, whose finally block closes it.
      bitmap = undefined;
      // Decoding next position overlaps inference; no playback or dropped frames.
      nextFramePromise = index + 1 < times.length ? decodeFrame(times[index + 1]) : Promise.resolve(undefined);
      const [result, nextBitmap] = await Promise.all([request, nextFramePromise]);
      bitmap = nextBitmap; nextFramePromise = undefined;
      const { landmarks, worldLandmarks, personCount, multiPersonCheck, subjectTracking, inferenceMs } = result;
      timing.inferenceMs += inferenceMs;
      frames.push({ time, landmarks, worldLandmarks: Array.isArray(worldLandmarks) ? worldLandmarks : [], personCount, multiPersonCheck, subjectTracking });
      onProgress({ stage: 'analyzing', progress: (index + 1) / times.length, processedFrames: index + 1, totalFrames: times.length, time, delegate, message: '正在逐帧分析动作…' });
    }
    await engine.request({ type: 'close' });
    return { frames, width, height, duration, elapsedMs: performance.now() - started, modelVersion: poseModel.version, sampleFps, sourceFps, delegate, timing, decoder: 'html-video', targetTracking: summarizeTargetTracking(frames,{targetPoint}) };
  } finally {
    lifecycle.abort(); externalSignal?.removeEventListener('abort', cancel);
    bitmap?.close(); engine?.stop();
    // createImageBitmap cannot be cancelled; close its eventual result as well.
    await nextFramePromise?.then(value => value?.close(), () => {});
    video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(objectUrl);
  }
}
import { validateTargetPoint, summarizeTargetTracking } from './motion-tracking.js';
