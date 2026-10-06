import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVideoFile, validateVideoMetadata, sampleVideoTimes, browserSeekTime, scaledVideoSize, analyzeVideo } from '../public/motion-video.js';
import { getMotionPoseModel } from '../public/motion-models.js';

test('video intake rejects empty, oversize, unsupported and excessive-duration files', () => {
  assert.throws(() => validateVideoFile({ name: 'clip.mp4', size: 0 }));
  assert.throws(() => validateVideoFile({ name: 'clip.mp4', size: 200 * 1024 * 1024 + 1 }), /200 MB/);
  assert.throws(() => validateVideoFile({ name: 'photo.jpg', size: 2000 }), /MP4/);
  assert.doesNotThrow(() => validateVideoFile({ name: 'clip.MOV', size: 2000, type: '' }));
  assert.throws(() => validateVideoMetadata({ duration: Infinity, width: 1920, height: 1080 }));
  assert.throws(() => validateVideoMetadata({ duration: 120.01, width: 1920, height: 1080 }), /120/);
  assert.throws(() => validateVideoMetadata({ duration: 12, width: 0, height: 1080 }));
});

for (const sampleFps of [15, 7.5]) test(`sampling at ${sampleFps} Hz covers the full clip with real timestamps`, () => {
  for (const duration of [0.02, 1, 1.037, 119.99, 120]) {
    const times = sampleVideoTimes(duration, sampleFps);
    assert.equal(times[0], 0);
    assert(times.at(-1) < duration);
    assert(duration - times.at(-1) <= 1 / sampleFps + 1e-10);
    for (let i = 1; i < times.length; i++) assert(Math.abs(times[i] - times[i - 1] - 1 / sampleFps) < 1e-10);
  }
});

test('frame resize preserves landscape and portrait proportions without enlarging', () => {
  assert.deepEqual(scaledVideoSize(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(scaledVideoSize(1080, 1920), { width: 720, height: 1280 });
  assert.deepEqual(scaledVideoSize(640, 480), { width: 640, height: 480 });
});

test('browser seek survives microsecond truncation at frame boundaries and stays inside the clip', () => {
  for (const time of [1 / 15, 4 / 15]) {
    const truncated = Math.floor(browserSeekTime(time, 1) * 1e6) / 1e6;
    assert(truncated >= Math.round(time * 1e6) / 1e6);
    assert(truncated - time < 0.000002);
  }
  assert(browserSeekTime(0, 1) >= 0);
  assert(browserSeekTime(1 - 1e-8, 1) < 1);
  assert(browserSeekTime(1, 1) < 1);
  assert.equal(browserSeekTime(0, 1e-8), 0);
  assert.deepEqual(sampleVideoTimes(0.15), [0, 1 / 15, 2 / 15]);
});

test('pre-cancelled analysis never opens browser resources', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeVideo({ name: 'clip.mp4', size: 20 }, { signal: controller.signal }), error => error.name === 'AbortError');
});

test('invalid sampling rates reject before browser resources are opened', async () => {
  for (const sampleFps of [0, -1, NaN, Infinity, 16, '7.5', null]) {
    await assert.rejects(analyzeVideo({ name: 'clip.mp4', size: 20 }, { sampleFps }), /采样率/);
  }
});

function browserHarness(t, { decoder = 'webcodecs', failGpu = false, failParser = false, failDecode = false, includeWorld = true } = {}) {
  const workers = [], requests = [], bitmaps = [], urls = new Set();
  const metadata = { duration: .2, width: 320, height: 240, sourceFps: 30 };
  const landmarks = Array.from({length:33},(_,i)=>({x:i/50,y:i/40,z:i/100,visibility:.7}));
  const worldLandmarks = landmarks.map((point,index) => point && ({x:point.x-.5,y:point.y-.5,z:index*.02-.3,visibility:point.visibility}));
  const frame = time => ({ time, landmarks, worldLandmarks:includeWorld?worldLandmarks:[], personCount: 1, multiPersonCheck: true,
    subjectTracking: { status: 'locked', confidence: .9 }, inferenceMs: 3 });
  const replace = (object, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  };
  class Video extends EventTarget {
    duration = metadata.duration; videoWidth = metadata.width; videoHeight = metadata.height; readyState = 2;
    position = 0;
    get currentTime() { return this.position; }
    set currentTime(value) { this.position = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event(decoder === 'ffmpeg-direct' ? 'error' : 'loadedmetadata'))); }
    pause() {}
    removeAttribute(key) { delete this[key]; }
  }
  class Worker {
    constructor(url) { this.url = String(url); this.stopped = false; workers.push(this); }
    terminate() { this.stopped = true; }
    postMessage(data) {
      requests.push({ worker: this, ...data });
      const emit = result => { if (!this.stopped) this.onmessage?.({ data: { id: data.id, ...result } }); };
      queueMicrotask(() => {
        if (this.stopped) return;
        switch (data.type) {
          case 'inspect': emit({ type: 'done', metadata, frames: [{ bytes: new Uint8Array([1]), time: 0 }] }); break;
          case 'init': emit(failGpu && data.delegate === 'GPU' ? { error: 'WebGPU unavailable' } : { delegate: data.delegate, modelVersion: getMotionPoseModel(data.model).version }); break;
          case 'prepare-source': emit({ metadata }); break;
          case 'prepare-mp4': this.sampleFps = data.options.sampleFps; emit(failParser ? { error: 'parser failed' } : { supported: decoder === 'webcodecs', sourceFps: 30 }); break;
          case 'decode-source': case 'decode-mp4':
            if (failDecode) { emit({ error: 'decode failed' }); break; }
            for (const time of sampleVideoTimes(metadata.duration, data.options?.sampleFps ?? this.sampleFps)) emit({ type: 'frame-result', frame: frame(time) });
            emit({ timing: { decodeMs: 2, codec: 'test' } }); break;
          case 'frame': data.bitmap.close(); emit(frame(data.timestampMs / 1000)); break;
          case 'close': emit({}); break;
          default: emit({ error: `Unexpected worker request: ${data.type}` });
        }
      });
    }
  }
  replace(globalThis, 'document', { createElement: () => new Video() });
  replace(globalThis, 'Worker', Worker);
  replace(globalThis, 'createImageBitmap', async () => { const bitmap = { closed: false, close() { this.closed = true; } }; bitmaps.push(bitmap); return bitmap; });
  replace(URL, 'createObjectURL', () => { const url = `blob:test-${urls.size}`; urls.add(url); return url; });
  replace(URL, 'revokeObjectURL', url => urls.delete(url));
  return { workers, requests, bitmaps, urls, landmarks, worldLandmarks };
}

for (const model of ['mediapipe-lite','mediapipe-full','mediapipe-heavy']) for (const options of [
  { decoder: 'webcodecs', failGpu: true },
  { decoder: 'html-video', failGpu: true },
  { decoder: 'ffmpeg-direct', failGpu: true },
  { decoder: 'webcodecs', failParser: true },
  { decoder: 'webcodecs', failDecode: true },
]) test(`${model} preserves 33 image and world points and releases resources: ${JSON.stringify(options)}`, async t => {
  const state = browserHarness(t, options);
  const result = await analyzeVideo({ name: 'clip.mp4', size: 20 }, {model});
  assert.equal(result.decoder, options.failParser || options.failDecode ? 'html-video' : options.decoder);
  assert.equal(result.modelVersion, getMotionPoseModel(model).version);
  assert.equal(result.delegate, options.failGpu ? 'CPU' : 'GPU');
  assert.deepEqual(result.frames.map(item => item.time), sampleVideoTimes(.2));
  for (const frame of result.frames) {
    assert.deepEqual(frame.landmarks, state.landmarks);
    assert.deepEqual(frame.worldLandmarks,state.worldLandmarks);
  }
  assert(state.requests.filter(request => request.type === 'init').every(request => request.model === model));
  assert.equal('actionRecognition' in result, false);
  assert(state.workers.every(worker => worker.stopped));
  assert(state.bitmaps.every(bitmap => bitmap.closed));
  assert.equal(state.urls.size, 0);
});

for (const decoder of ['webcodecs', 'html-video', 'ffmpeg-direct']) {
  test(`standard default survives CPU and decoder fallback: ${decoder}`, async t => {
    const state=browserHarness(t,{decoder,failGpu:true,includeWorld:true});
    const output=await analyzeVideo({name:'clip.mp4',size:20});
    assert.equal(output.modelVersion,getMotionPoseModel('mediapipe-full').version);
    assert.equal(output.decoder,decoder);
    assert.equal(output.delegate,'CPU');
    for (const frame of output.frames) assert.deepEqual(frame.worldLandmarks,state.worldLandmarks);
    assert(state.requests.filter(item=>item.type==='init').every(item=>item.model==='mediapipe-full'));
  });
  test(`7.5 Hz reaches the ${decoder} decoder and preserves the full timeline`, async t => {
    const state = browserHarness(t, { decoder });
    const result = await analyzeVideo({ name: 'clip.mp4', size: 20 }, { sampleFps: 7.5 });
    assert.equal(result.sampleFps, 7.5);
    assert.equal(result.sourceFps, 30);
    assert.equal(result.decoder, decoder);
    assert.deepEqual(result.frames.map(frame => frame.time), [0, 1 / 7.5]);
    const decodeRequest = state.requests.find(request => request.type === (decoder === 'ffmpeg-direct' ? 'decode-source' : 'prepare-mp4'));
    assert.equal(decodeRequest.options.sampleFps, 7.5);
    assert(state.workers.every(worker => worker.stopped));
    assert(state.bitmaps.every(bitmap => bitmap.closed));
  });

  test(`cancelling MediaPipe stops ${decoder} inference and closes browser resources`, async t => {
    const state = browserHarness(t, { decoder }), controller = new AbortController();
    await assert.rejects(analyzeVideo({ name: 'clip.mp4', size: 20 }, {
      signal: controller.signal,
      onProgress: progress => { if (progress.stage === 'analyzing') controller.abort(); },
    }), error => error.name === 'AbortError');
    assert(state.workers.every(worker => worker.stopped));
    assert(state.bitmaps.every(bitmap => bitmap.closed));
    assert.equal(state.urls.size, 0);
  });
}
