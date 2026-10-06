import { analyzeVideo } from './motion-video.js';
import { getMotionPoseModel } from './motion-models.js';
import { analyzeMotion } from './motion-analysis.js';
import { buildMotionEvidence } from './motion-evidence.js';
import { buildMotionPoseData, buildFullMotionAnalysis } from './motion-pose-data.js';
import { getMotionExercise } from './motion-catalog.js';
import { validateVideoFile, validateVideoMetadata, releasePreparedMotionVideo } from './motion-media.js';

const aborted = () => new DOMException('已取消本地视频分析。', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };
function missingVideo() {
  const error = new Error('本地视频已失效，请重新添加视频后再分析。');
  error.code = 'CHAT_MOTION_VIDEO_MISSING';
  return error;
}
function videoId() {
  if (globalThis.crypto?.randomUUID) return `local-video:${crypto.randomUUID()}`;
  // randomUUID needs a secure context; getRandomValues also works on local HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `local-video:${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function progress(callback, value) {
  // A detached UI subscriber must not interrupt another chat's analysis.
  try { callback?.(value); } catch { /* Consumer owns its rendering errors. */ }
}

/** In-memory local files and reusable observations. No original video upload,
 * persistent file storage or AI result cache. Keep one instance per account. */
export class ChatMotionVideos {
  #entries = new Map();
  #tail = Promise.resolve();

  add(file, metadata = {}) {
    validateVideoFile(file);
    if (typeof file.arrayBuffer !== 'function') throw new Error('请重新选择本地视频文件，文件路径不能直接分析。');
    if (['duration','width','height'].some(key => metadata?.[key] !== undefined)) validateVideoMetadata(metadata);
    const name = String(metadata?.name || file.name || '本地视频.mp4').replace(/^.*[\\/]/, '').trim();
    const type = String(metadata?.type || file.type || '');
    if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name) || type.length > 100) throw new Error('视频文件名应为 1–200 个字符，不能包含控制字符。');
    const descriptor = {id:videoId(), name, type, size:file.size};
    validateVideoFile(descriptor);
    // AttachmentManager owns per-draft deduplication. Two drafts can hold the
    // very same File object and must still be removable independently.
    this.#entries.set(descriptor.id, {descriptor, file, models:new Map()});
    return {...descriptor};
  }

  get(id) { return this.#entries.get(id)?.file || null; }

  remove(id) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    for (const cache of entry.models.values()) {
      cache.job?.controller.abort();
      for (const waiter of [...(cache.job?.waiters || [])]) waiter.cancel();
      cache.local = cache.payload = null;
    }
    entry.models.clear();
    releasePreparedMotionVideo(entry.file);
    return true;
  }

  clear() { for (const id of this.#entries.keys()) this.remove(id); }

  async prepare(id, exerciseId, {signal, onProgress, poseModel} = {}) {
    checkAbort(signal);
    const entry = this.#entries.get(id);
    if (!entry) throw missingVideo();
    if (exerciseId != null && !getMotionExercise(exerciseId)) throw new Error('请选择有效的动作类型后再评价。');
    const phase = exerciseId == null ? {reviewMode:'recognize'} : {reviewMode:'guided',selectedExerciseId:exerciseId};
    const model = getMotionPoseModel(poseModel);
    let cache = entry.models.get(model.id);
    if (!cache) { cache={local:null,payload:null,job:null}; entry.models.set(model.id,cache); }
    if (cache.payload) {
      progress(onProgress, {stage:'ready', progress:1, cached:true, message:'已复用这段视频的骨架与关键画面。'});
      checkAbort(signal);
      if (this.#entries.get(id) !== entry) throw missingVideo();
      return {...structuredClone(cache.payload), ...phase};
    }
    let job = cache.job;
    if (!job || job.controller.signal.aborted) {
      job = {controller:new AbortController(), waiters:new Set(), settled:false, lastProgress:null};
      cache.job = job;
      const publish = value => {
        job.lastProgress = {...value, message:value?.message || '正在准备本地动作数据…'};
        for (const waiter of job.waiters) progress(waiter.onProgress, {...job.lastProgress});
      };
      // Serialize different videos. A retry also waits for its cancelled worker
      // to release resources before preparing the same File again.
      job.promise = this.#tail.then(async () => {
        const current = () => { checkAbort(job.controller.signal); if (this.#entries.get(id) !== entry) throw missingVideo(); };
        try {
          current();
          return await this.#build(entry, cache, model, job.controller.signal, publish, current);
        } finally {
          releasePreparedMotionVideo(entry.file);
          job.settled = true;
          if (cache.job === job) cache.job = null;
        }
      });
      // The queue must not retain the last payload after remove()/clear().
      this.#tail = job.promise.then(() => {}, () => {});
    }
    return new Promise((resolve, reject) => {
      let active = true;
      const cleanup = () => { active = false; job.waiters.delete(waiter); signal?.removeEventListener('abort', waiter.cancel); };
      const waiter = {onProgress, cancel:() => {
        if (!active) return;
        cleanup(); reject(aborted());
        if (!job.waiters.size && !job.settled) job.controller.abort();
      }};
      job.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.cancel, {once:true});
      if (signal?.aborted) waiter.cancel();
      else if (job.lastProgress) progress(onProgress, {...job.lastProgress});
      else progress(onProgress, {stage:'queued', progress:0, message:'正在准备本地视频分析…'});
      job.promise.then(value => {
        if (!active) return;
        cleanup();
        try {
          checkAbort(signal); checkAbort(job.controller.signal);
          if (this.#entries.get(id) !== entry) throw missingVideo();
          resolve({...structuredClone(value), ...phase});
        }
        catch (error) { reject(error); }
      }, error => { if (active) { cleanup(); reject(error); } });
    });
  }

  async #build(entry, cache, model, signal, publish, current) {
    if (!cache.local) {
      publish({stage:'loading', progress:0, message:`正在使用${model.tier}（${model.label}）提取骨架…`});
      const output = await analyzeVideo(entry.file, {signal, sampleFps:7.5, model:model.id, onProgress:publish});
      current();
      // Chat needs no playback buffers or raw face/finger points. All original
      // body coordinates, target tracking and source timestamps stay intact.
      const {previewFrames, previewFps, ...pipeline} = output;
      pipeline.frames = output.frames;
      const observations = analyzeMotion(pipeline.frames, pipeline);
      const poseData = buildMotionPoseData(pipeline);
      const fullAnalysis = buildFullMotionAnalysis(observations, pipeline);
      current();
      cache.local = {pipeline, observations, poseData, fullAnalysis};
    } else publish({stage:'evidence', cached:true, message:'已复用骨架，正在准备关键画面…'});
    const {pipeline, observations, poseData, fullAnalysis} = cache.local;
    const evidence = await buildMotionEvidence(entry.file, pipeline, observations, {signal, onProgress:publish});
    current();
    if (!evidence.images.length) throw new Error('未能提取训练者的关键画面，请在动作评估页点选训练者后重新评估，或重新添加清晰视频。');
    const keyframes = evidence.images.map(({time, mimeType, dataUrl, imageTime}) => ({time, mimeType, data:dataUrl.slice(dataUrl.indexOf(',')+1), imageTime}));
    cache.payload = {duration:pipeline.duration, analysis:evidence.summary, keyframes, poseData, fullAnalysis, reviewMode:'guided'};
    cache.local = null;
    publish({stage:'ready', progress:1, message:'骨架与关键画面已准备好，原视频保留在本机。'});
    current();
    return cache.payload;
  }
}
