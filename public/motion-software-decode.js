// A single worker owns this decoder and the pose model. The raw output device
// supplies one complete frame at a time, so inference provides backpressure.
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_DURATION = 120;
const SAMPLE_FPS = 15;
// Preview frames are a subset of the analyzed pictures: 5 Hz at the compatible
// 15 Hz rate, 2.5 Hz at 7.5 Hz. Their timestamps always follow the selected rate.
const PREVIEW_STEP = 3;
const PREVIEW_BUDGET = 64 * 1024 * 1024;
const MAX_SOURCE_PTS = 120000;
// Only these codecs have passed exact RGBA/JPEG comparisons across CFR, VFR,
// nonzero starts, MOV edits, transport streams and HDR in the pinned core.
const INPUT_SEEK_CODECS = new Set(['h264', 'hevc']);
let corePromise;

export async function loadMotionDecoder() {
  if (!corePromise) corePromise = (async () => {
    const coreURL = new URL('./vendor/ffmpeg/ffmpeg-core.js', import.meta.url).href;
    const wasmURL = new URL('./vendor/ffmpeg/ffmpeg-core.wasm', import.meta.url).href;
    importScripts(coreURL);
    return self.createFFmpegCore({ mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}` });
  })();
  return corePromise;
}

function probe(core, options = ['-show_streams', '-show_format']) {
  core.setTimeout(30000);
  const nativeProbe = core._ffprobe;
  let nativeCode, wrapperCode;
  core._ffprobe = (...args) => { nativeCode = nativeProbe(...args); return nativeCode; };
  try { wrapperCode = core.ffprobe('-v', 'error', ...options, '-of', 'json', '/input/source', '-o', '/probe.json'); }
  finally { core._ffprobe = nativeProbe; core.reset(); }
  const code = wrapperCode === -1 && Number.isInteger(nativeCode) ? nativeCode : wrapperCode;
  if (code !== 0) throw new Error('无法读取视频，请检查文件是否完整或更换视频。');
  const result = JSON.parse(core.FS.readFile('/probe.json', { encoding: 'utf8' }));
  core.FS.unlink('/probe.json');
  return result;
}

const ratio = value => {
  const [a, b = 1] = String(value || '').split(/[/:]/).map(Number);
  return a > 0 && b > 0 ? a / b : 0;
};

function timelineDuration(core, metadata, stream, estimated) {
  if (!/^(mpeg|mpegts)$/.test(metadata.format?.format_name || '')) return estimated;
  const data = probe(core, ['-select_streams', String(stream.index), '-show_packets', '-show_entries', 'packet=pts_time,dts_time,duration_time,flags']);
  const frameDuration = 1 / (ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate) || 25);
  const bounds = { pts_time: { first: Infinity, last: -Infinity }, dts_time: { first: Infinity, last: -Infinity } };
  for (const packet of data.packets || []) {
    if (String(packet.flags || '').includes('D')) continue;
    const length = Number(packet.duration_time);
    for (const key of Object.keys(bounds)) {
      const time = Number(packet[key]);
      if (!Number.isFinite(time)) continue;
      bounds[key].first = Math.min(bounds[key].first, time);
      bounds[key].last = Math.max(bounds[key].last, time + (length > 0 ? length : frameDuration));
    }
  }
  // MPEG-1 frequently records PTS only on selected packets but DTS on every
  // packet. Measure each timeline separately; mixing PTS/DTS adds decode delay.
  const spans = Object.values(bounds).map(({ first, last }) => last - first).filter(value => Number.isFinite(value) && value > 0);
  return spans.length ? Math.round(Math.max(...spans) * 1e6) / 1e6 : estimated;
}

export async function prepareMotionSource(file, { onProgress = () => {} } = {}) {
  if (!file || !(file.size > 0) || file.size > MAX_BYTES) throw new Error('请选择 200 MB 以内的视频。');
  onProgress({ progress: 0, message: '正在加载本地视频解码组件…' });
  const core = await loadMotionDecoder();
  onProgress({ progress: 0.01, message: '正在读取原视频信息…' });
  const logs = [];
  core.setLogger(({ message }) => { logs.push(message); if (logs.length > 16) logs.shift(); });
  try { core.FS.mkdir('/input'); } catch {}
  core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name: 'source', data: file }] }, '/input');
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { core.FS.unmount('/input'); } catch {} };
  try {
    const info = probe(core);
    const stream = info.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic);
    if (!stream || !(stream.width > 0 && stream.height > 0)) throw new Error('这个文件中没有可分析的视频画面。');
    const estimate = [stream.duration, info.format?.duration].map(Number).find(value => Number.isFinite(value) && value > 0);
    const duration = timelineDuration(core, info, stream, estimate);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定视频的完整时长，请换一个视频文件。');
    if (duration > MAX_DURATION) throw new Error('请将视频裁剪到 120 秒以内再分析。');
    const sar = ratio(stream.sample_aspect_ratio) || 1;
    let width = Math.round(stream.width * sar), height = stream.height;
    const rotation = Number(stream.side_data_list?.find(item => Number.isFinite(Number(item.rotation)))?.rotation ?? stream.tags?.rotate ?? 0);
    if (Math.abs(Math.round(rotation / 90)) % 2 === 1) [width, height] = [height, width];
    if (!(width > 0 && height > 0) || Math.max(width, height) > 65536) throw new Error('这个视频的画面尺寸无法读取。');
    const metadata = { width, height, duration, sourceFps: ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate) || null };
    onProgress({ progress: 0.02, message: '正在读取原视频画面…' });
    return { core, stream, metadata, logs, close, formatStart: Number(info.format?.start_time) || 0 };
  } catch (error) { close(); throw error; }
}

export function motionFrameSize(metadata, maxDimension) {
  if (!Number.isFinite(maxDimension) || maxDimension < 2 || maxDimension > 1280) throw new Error('无效的视频抽帧尺寸。');
  const scale = Math.min(1, maxDimension / Math.max(metadata.width, metadata.height));
  return { width: Math.max(2, Math.round(metadata.width * scale / 2) * 2), height: Math.max(2, Math.round(metadata.height * scale / 2) * 2) };
}

function validateSampleFps(sampleFps) {
  if (!Number.isFinite(sampleFps) || sampleFps <= 0 || sampleFps > SAMPLE_FPS) throw new Error('视频采样率必须大于 0 且不超过 15。');
}

function filters(source, size, { sample = true, sampleFps = SAMPLE_FPS, selectIndices, frameRange, validateTimeline = false, originPts, capturePts = false } = {}) {
  // Normalize the first presented frame to zero for MOV edit lists and TS PTS.
  // Pad just the final source frame through the last valid sample position.
  // trim limits the output to the real video duration; no sample is omitted.
  const chain = originPts === undefined ? ['setpts=PTS-STARTPTS'] : [`setpts=PTS-${originPts}`];
  if (capturePts) chain.unshift('showinfo@motion_origin=checksum=0');
  if (validateTimeline) chain.push('showinfo=checksum=0');
  // Trim by integer sample count: duration is rounded to the sample timebase by
  // FFmpeg and would drop a valid fractional tail (or round a short clip to 0).
  if (sample) chain.push(`tpad=stop_mode=clone:stop_duration=${Math.max(0.1, 1 / sampleFps)}`, `fps=fps=${sampleFps}:start_time=0:round=up`, `trim=end_frame=${Math.ceil(source.metadata.duration * sampleFps)}`);
  else chain.push('trim=end_frame=1');
  // Keep the original PTS/fps grid, then discard earlier batches before costly
  // resizing or HDR conversion. These filters do not depend on prior frames.
  if (frameRange) chain.push(`trim=start_frame=${frameRange.start}:end_frame=${frameRange.end}`);
  if (selectIndices) chain.push(`select='${selectIndices.map(index => `eq(n,${index})`).join('+')}'`);
  chain.push(`scale=${size.width}:${size.height}`, 'setsar=1');
  if (['smpte2084', 'arib-std-b67'].includes(source.stream.color_transfer)) {
    chain.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=limited');
    chain.push('format=yuv420p');
  }
  return chain;
}

let nextDevice = 200;
function outputDevice(core, name, write) {
  const id = core.FS.makedev(nextDevice++, 0), path = `/dev/${name}`;
  core.FS.registerDevice(id, {
    open: stream => { stream.seekable = false; },
    write: (_stream, bytes, offset, length) => { write(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length)); return length; },
  });
  core.FS.mkdev(path, id);
  return { path, close: () => { try { core.FS.unlink(path); } catch {} delete core.FS.devices[id]; } };
}

// JPEG's escaped entropy bytes cannot contain an unescaped EOI marker. Keep
// only the current image, with an explicit cap even for malformed output.
export function createJpegReceiver(onImage, maxBytes = 4 * 1024 * 1024) {
  let buffer = new Uint8Array(65536), size = 0, previous = -1;
  return {
    write(chunk) {
      for (const byte of chunk) {
        if (size === 0 && byte !== 0xff) continue;
        if (size >= maxBytes) throw new Error('视频单帧图像过大，请降低视频分辨率。');
        if (size === buffer.length) { const expanded = new Uint8Array(Math.min(maxBytes, buffer.length * 2)); expanded.set(buffer); buffer = expanded; }
        buffer[size++] = byte;
        if (previous === 0xff && byte === 0xd9) { onImage(buffer.slice(0, size)); size = 0; previous = -1; }
        else previous = byte;
      }
    },
    finish() { if (size !== 0) throw new Error('视频关键画面解码不完整。'); },
  };
}

function timeBase(value) {
  const match = String(value || '').match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]), denominator = Number(match[2]);
  return Number.isSafeInteger(numerator) && numerator > 0 && Number.isSafeInteger(denominator) && denominator > 0
    ? { numerator, denominator, seconds: numerator / denominator } : null;
}

function sameTimeBase(left, right) {
  return left && right && BigInt(left.numerator) * BigInt(right.denominator) === BigInt(right.numerator) * BigInt(left.denominator);
}

// showinfo reports the filter input timebase, which may differ from ffprobe's
// stream timebase after demuxing. Only matching, bounded decoded PTS can support
// an input seek. Invalid metadata disables this optimization, never validation.
function sourceTimeline(stream) {
  const expected = timeBase(stream.time_base);
  const result = { pts: [], timeBase: null, invalid: expected ? null : 'missing-stream-time-base' };
  return {
    result,
    accept(message) {
      if (!/showinfo@motion_origin/.test(message)) return;
      const config = message.match(/config in time_base:\s*(\d+\/\d+)/);
      if (config) {
        const actual = timeBase(config[1]);
        if (!sameTimeBase(expected, actual) || (result.timeBase && !sameTimeBase(result.timeBase, actual))) result.invalid ||= 'time-base-mismatch';
        result.timeBase = actual;
      }
      const raw = message.match(/\bpts:\s*(\S+)/);
      if (!raw || result.invalid) return;
      const pts = Number(raw[1]);
      if (!Number.isSafeInteger(pts) || (result.pts.length && pts <= result.pts.at(-1))) result.invalid = 'invalid-source-pts';
      else if (result.pts.length >= MAX_SOURCE_PTS) result.invalid = 'source-pts-limit';
      else result.pts.push(pts);
      if (result.invalid) result.pts.length = 0;
    },
    finish() {
      if (!result.timeBase || !result.pts.length) result.invalid ||= 'missing-source-timeline';
      return result;
    },
  };
}

function execute(source, args, onProgress = () => {}, validateTimeline = false, { inputSeek = 0, copyTs = false, capturePts = false } = {}) {
  const { core, metadata, logs } = source;
  let lastSourceTime = -Infinity;
  let seekDecodeWarning = false;
  const timeline = capturePts ? sourceTimeline(source.stream) : null;
  core.setLogger(({ message }) => {
    logs.push(message); if (logs.length > 16) logs.shift();
    timeline?.accept(message);
    if (inputSeek > 0 && /missing reference|reference (?:picture|frame).*missing|could not find ref|corrupt(?:ed)? (?:decoded )?(?:frame|packet|input)|error while decoding|decode_slice_header error|concealing \d+|mmco: unref short failure/i.test(message)) seekDecodeWarning = true;
    if (validateTimeline && /Parsed_showinfo_/.test(message)) {
      const match = message.match(/\bpts_time:([\d.eE+-]+)/);
      if (match && Number.isFinite(Number(match[1]))) lastSourceTime = Math.max(lastSourceTime, Number(match[1]));
    }
  });
  let last = -1;
  core.setProgress(({ time }) => {
    const progress = Math.min(1, Math.max(0, Number(time) / (metadata.duration * 1e6)));
    if (progress - last >= 0.01) { last = progress; onProgress({ progress, message: '正在直接解码本地视频…' }); }
  });
  core.setTimeout(9 * 60 * 1000);
  let code;
  try { code = core.exec('-hide_banner', '-loglevel', validateTimeline || capturePts ? 'info' : 'error', '-xerror', ...(copyTs ? ['-copyts'] : []), ...(inputSeek > 0 ? ['-ss', String(inputSeek)] : []), '-i', '/input/source', '-an', '-sn', '-dn', ...args); }
  finally { core.reset(); }
  if (code !== 0) {
    if (logs.some(line => /out of memory|memory access|Cannot enlarge memory|allocation failed/i.test(line))) throw new Error('这个视频需要更多内存，请使用较短或较低分辨率的视频。');
    throw new Error('视频解码未完成，请检查文件是否完整或更换视频。');
  }
  // Do not accept a complete-looking prefix when a container understated its
  // duration. The input is decoded to EOF even after trim stops producing frames.
  if (validateTimeline && (!Number.isFinite(lastSourceTime) || lastSourceTime > metadata.duration + 0.001)) throw new Error('视频实际时长与文件信息不一致，无法保证完整分析，请更换视频。');
  if (seekDecodeWarning) throw new Error('seek-decode-warning');
  return timeline?.finish();
}

export function readPreparedMotionFrames(source, times, { maxDimension = 1280, sampleFps = SAMPLE_FPS, onProgress = () => {}, poster = false } = {}) {
  validateSampleFps(sampleFps);
  if (!Array.isArray(times) || times.length < 1 || times.length > 6 || times.some(time => !Number.isFinite(time) || time < 0 || time >= source.metadata.duration)) throw new Error('无效的视频关键帧时间。');
  const lastIndex = Math.ceil(source.metadata.duration * sampleFps) - 1;
  const requested = times.map((time, position) => ({ time, position, index: Math.min(lastIndex, Math.round(time * sampleFps)) })).sort((a, b) => a.index - b.index);
  const indices = [...new Set(requested.map(item => item.index))], size = motionFrameSize(source.metadata, maxDimension), images = [];
  const receiver = createJpegReceiver(bytes => images.push(bytes));
  const device = outputDevice(source.core, 'motion-stills', chunk => receiver.write(chunk));
  try {
    const chain = filters(source, size, { sample: !poster, sampleFps, selectIndices: poster ? null : indices });
    chain.push('format=yuvj420p');
    // The pinned core's optimal Huffman pass is extremely slow on textured
    // phone frames. Standard tables keep JPEG encoding predictable and fast.
    execute(source, ['-map', `0:${source.stream.index}`, '-vf', chain.join(','), '-vsync', '0', '-frames:v', String(indices.length), '-c:v', 'mjpeg', '-huffman', 'default', '-q:v', '3', '-threads', '1', '-f', 'image2pipe', device.path], onProgress);
    receiver.finish();
    if (images.length !== indices.length) throw new Error('无法提取完整的视频关键画面，请重新分析。');
    return requested.map(item => ({ time: item.time, bytes: images[indices.indexOf(item.index)], ...size, position: item.position })).sort((a, b) => a.position - b.position).map(({ position, ...frame }) => frame);
  } finally { device.close(); }
}

export function decodePreparedMotion(source, onFrame, options = {}) {
  if (options.asyncInference) return decodePreparedMotionAsync(source, onFrame, options);
  const { maxDimension = 1280, sampleFps = SAMPLE_FPS, onPreview = () => {}, onPreviewReset = () => {}, onProgress = () => {} } = options;
  validateSampleFps(sampleFps);
  const size = motionFrameSize(source.metadata, maxDimension), previewSize = motionFrameSize(source.metadata, 640);
  const bytes = new Uint8ClampedArray(size.width * size.height * 4);
  const image = new ImageData(bytes, size.width, size.height), canvas = new OffscreenCanvas(size.width, size.height), context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法建立视频分析画布。');
  const totalFrames = Math.ceil(source.metadata.duration * sampleFps);
  let offset = 0, frameIndex = 0, inferenceMs = 0, previewIndex = 0, previewStride = 1, retainedBytes = 0;
  const retained = new Map();
  const raw = outputDevice(source.core, 'motion-rgba', chunk => {
    let from = 0;
    while (from < chunk.length) {
      const count = Math.min(bytes.length - offset, chunk.length - from);
      bytes.set(chunk.subarray(from, from + count), offset); offset += count; from += count;
      if (offset === bytes.length) {
        if (frameIndex >= totalFrames) throw new Error('视频采样超出完整时长。');
        context.putImageData(image, 0, 0);
        const start = performance.now();
        const result = onFrame(canvas, { time: frameIndex / sampleFps });
        if (result && typeof result.then === 'function') {
          // FS device writes run inside synchronous WASM and cannot await.
          result.catch(() => {});
          throw new Error('异步视频推理需要启用 asyncInference。');
        }
        inferenceMs += performance.now() - start;
        frameIndex++; offset = 0;
      }
    }
  });
  const jpeg = createJpegReceiver(data => {
    const index = previewIndex++;
    if (index % previewStride !== 0) return;
    retained.set(index, data.byteLength); retainedBytes += data.byteLength;
    while (retainedBytes > PREVIEW_BUDGET) {
      previewStride *= 2;
      for (const [oldIndex, length] of retained) if (oldIndex % previewStride !== 0) { retained.delete(oldIndex); retainedBytes -= length; }
      onPreviewReset(previewStride);
    }
    if (index % previewStride === 0) onPreview({ index, time: index * PREVIEW_STEP / sampleFps, bytes: data, ...previewSize, stride: previewStride });
  });
  const preview = outputDevice(source.core, 'motion-preview', chunk => jpeg.write(chunk));
  const started = performance.now();
  try {
    const chain = filters(source, size, { sampleFps, validateTimeline: true });
    // Selecting each third analyzed frame preserves its original PTS. A second
    // fps filter could choose a neighbouring picture for the same preview time.
    const graph = `[0:${source.stream.index}]${chain.join(',')},split[pose][preview];[pose]format=rgba[rgba];[preview]select='not(mod(n,${PREVIEW_STEP}))',scale=${previewSize.width}:${previewSize.height},format=yuvj420p[jpeg]`;
    execute(source, ['-filter_complex', graph, '-map', '[rgba]', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-vsync', '0', '-threads', '1', '-f', 'rawvideo', raw.path,
      '-map', '[jpeg]', '-c:v', 'mjpeg', '-huffman', 'default', '-q:v', '7', '-vsync', '0', '-threads', '1', '-f', 'image2pipe', preview.path], onProgress, true);
    jpeg.finish();
    if (offset !== 0 || frameIndex !== totalFrames) throw new Error(`视频没有完整解码（${frameIndex}/${totalFrames} 帧），请更换视频或重新分析。`);
    return { decodeMs: Math.max(0, performance.now() - started - inferenceMs), codec: source.stream.codec_name, frames: frameIndex, previewFrames: previewIndex, previewFps: sampleFps / PREVIEW_STEP };
  } finally { raw.close(); preview.close(); canvas.width = canvas.height = 1; }
}

// Set trimBeforeScale:false only to compare the original prefix algorithm.
// Diagnostic timing fields are for engineering measurements, not user claims.
// The pinned FFmpeg core has no Asyncify support, so a device write cannot
// suspend for a pose inference Promise. Decode a bounded batch, then await its
// consumers in order. Replaying the original PTS/fps filters preserves VFR and
// edit-list sampling exactly. This costs repeated source decoding on formats
// which need the software fallback, but never buffers a whole raw video.
async function decodePreparedMotionAsync(source, onFrame, { maxDimension = 1280, sampleFps = SAMPLE_FPS, trimBeforeScale = true, onPreview = () => {}, onPreviewReset = () => {}, onProgress = () => {} } = {}) {
  validateSampleFps(sampleFps);
  const size = motionFrameSize(source.metadata, maxDimension), previewSize = motionFrameSize(source.metadata, 640);
  // Seek state is local to this invocation. A prepared source can subsequently
  // serve stills or another analysis without inheriting an input offset.
  let seekEnabled = trimBeforeScale && INPUT_SEEK_CODECS.has(source.stream.codec_name), originalTimeline;
  const inputSeeks = [], seekFallbacks = [];
  const prefixEarlyTrim = trimBeforeScale && !seekEnabled;
  if (prefixEarlyTrim) seekFallbacks.push({ first: 0, reason: 'codec-not-validated-for-input-seek' });
  const frameBytes = size.width * size.height * 4;
  const batchSize = Math.max(1, Math.min(16, Math.floor(32 * 1024 * 1024 / frameBytes)));
  const bytes = new Uint8ClampedArray(frameBytes);
  const canvas = new OffscreenCanvas(size.width, size.height), context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法建立视频分析画布。');
  const totalFrames = Math.ceil(source.metadata.duration * sampleFps);
  let inferenceMs = 0, completed = 0, previewIndex = 0, previewStride = 1, retainedBytes = 0;
  const retained = new Map();
  const jpeg = createJpegReceiver(data => {
    const index = previewIndex++;
    if (index % previewStride !== 0) return;
    retained.set(index, data.byteLength); retainedBytes += data.byteLength;
    while (retainedBytes > PREVIEW_BUDGET) {
      previewStride *= 2;
      for (const [oldIndex, length] of retained) if (oldIndex % previewStride !== 0) { retained.delete(oldIndex); retainedBytes -= length; }
      onPreviewReset(previewStride);
    }
    if (index % previewStride === 0) onPreview({ index, time: index * PREVIEW_STEP / sampleFps, bytes: data, ...previewSize, stride: previewStride });
  });
  const started = performance.now();
  try {
    for (let first = 0; first < totalFrames; first += batchSize) {
      const count = Math.min(batchSize, totalFrames - first), batch = [];
      let offset = 0;
      const raw = outputDevice(source.core, 'motion-rgba-async', chunk => {
        let from = 0;
        while (from < chunk.length) {
          const length = Math.min(bytes.length - offset, chunk.length - from);
          bytes.set(chunk.subarray(from, from + length), offset); offset += length; from += length;
          if (offset === bytes.length) {
            if (batch.length >= count) throw new Error('视频采样超出当前批次。');
            batch.push(bytes.slice()); offset = 0;
          }
        }
      });
      let preview;
      try {
        const trim = `trim=start_frame=${first}:end_frame=${first + count}`;
        if (first === 0) {
          const chain = filters(source, size, { sampleFps, validateTimeline: true, capturePts: seekEnabled });
          preview = outputDevice(source.core, 'motion-preview-async', chunk => jpeg.write(chunk));
          // The preview branch covers the entire clip once, so this pass also
          // verifies the source timeline through EOF before trusting any batch.
          const graph = `[0:${source.stream.index}]${chain.join(',')},split[pose][preview];[pose]${trim},format=rgba[rgba];[preview]select='not(mod(n,${PREVIEW_STEP}))',scale=${previewSize.width}:${previewSize.height},format=yuvj420p[jpeg]`;
          const args = ['-filter_complex', graph, '-map', '[rgba]', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-vsync', '0', '-threads', '1', '-f', 'rawvideo', raw.path,
            '-map', '[jpeg]', '-c:v', 'mjpeg', '-huffman', 'default', '-q:v', '7', '-vsync', '0', '-threads', '1', '-f', 'image2pipe', preview.path];
          originalTimeline = execute(source, args, event => onProgress({ ...event, progress: event.progress * count / totalFrames }), true, { copyTs: seekEnabled, capturePts: seekEnabled });
          jpeg.finish();
          if (seekEnabled && originalTimeline.invalid) {
            seekEnabled = false;
            seekFallbacks.push({ first, reason: originalTimeline.invalid });
          }
        } else {
          // Stop after the batch instead of decoding the remaining suffix. The
          // first pass already validated that suffix and supplied all previews.
          const runBatch = (seek) => {
            const earlyTrim = !!seek || prefixEarlyTrim;
            const chain = filters(source, size, { sampleFps,
              ...(earlyTrim ? { frameRange: { start: first, end: first + count } } : {}),
              ...(seek ? { originPts: originalTimeline.pts[0], capturePts: true } : {}),
            });
            const args = ['-map', `0:${source.stream.index}`, '-vf', [...chain, ...(earlyTrim ? [] : [trim]), 'format=rgba'].join(','), '-frames:v', String(count), '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-vsync', '0', '-threads', '1', '-f', 'rawvideo', raw.path];
            const decoded = execute(source, args, event => onProgress({ ...event, progress: (first + event.progress * count) / totalFrames }), false,
              seek ? { inputSeek: seek.time, copyTs: true, capturePts: true } : {});
            if (offset !== 0 || batch.length !== count) throw new Error('incomplete-seek-batch');
            if (seek) {
              if (decoded.invalid || !sameTimeBase(decoded.timeBase, originalTimeline.timeBase)) throw new Error(decoded.invalid || 'time-base-mismatch');
              const startIndex = originalTimeline.pts.indexOf(decoded.pts[0]);
              const lastNeeded = originalTimeline.pts.findLastIndex(pts => (pts - originalTimeline.pts[0]) * originalTimeline.timeBase.seconds <= (first + count - 1) / sampleFps + 1e-9);
              // Include the source picture after the final sample to rule out
              // premature EOF padding. Ignore decoder drain after this range:
              // -frames:v can stop requesting intermediate unused pictures.
              const through = Math.min(originalTimeline.pts.length - 1, lastNeeded + 1);
              if (startIndex < 0 || decoded.pts[0] > seek.preceding || decoded.pts.length <= through - startIndex
                || originalTimeline.pts.slice(startIndex, through + 1).some((pts, index) => decoded.pts[index] !== pts)) throw new Error('seek-source-timeline-mismatch');
            }
          };
          let usedSeek = false;
          if (seekEnabled) {
            try {
              const seconds = originalTimeline.timeBase.seconds, origin = originalTimeline.pts[0];
              const preceding = originalTimeline.pts.findLast(pts => (pts - origin) * seconds <= first / sampleFps + 1e-9);
              if (!Number.isSafeInteger(preceding) || !Number.isFinite(source.formatStart)) throw new Error('missing-preceding-source-frame');
              const time = Math.max(0, preceding * seconds - source.formatStart - 1);
              if (!Number.isFinite(time)) throw new Error('invalid-input-seek');
              if (time > 0) {
                inputSeeks.push(time);
                runBatch({ time, preceding });
                usedSeek = true;
              } else {
                // No useful offset yet; retain early trimming, but validate it
                // as a seek path so it can still fall back before any consumer.
                runBatch({ time: 0, preceding });
                usedSeek = true;
              }
            } catch (error) {
              seekEnabled = false;
              seekFallbacks.push({ first, reason: error.message });
              batch.length = 0; offset = 0;
            }
          }
          // Discard all failed output before retrying the original prefix.
          // Once disabled, later batches do not attempt another input seek.
          if (!usedSeek) runBatch(null);
        }
        if (offset !== 0 || batch.length !== count) throw new Error(`视频没有完整解码（${completed + batch.length}/${totalFrames} 帧），请更换视频或重新分析。`);
        for (let index = 0; index < batch.length; index++) {
          context.putImageData(new ImageData(batch[index], size.width, size.height), 0, 0);
          batch[index] = null;
          const start = performance.now();
          await onFrame(canvas, { time: (first + index) / sampleFps });
          inferenceMs += performance.now() - start;
          completed++;
        }
      } finally { raw.close(); preview?.close(); batch.length = 0; }
    }
    return { decodeMs: Math.max(0, performance.now() - started - inferenceMs), codec: source.stream.codec_name, frames: completed, previewFrames: previewIndex, previewFps: sampleFps / PREVIEW_STEP, diagnostics: { inputSeeks, sourceOriginPts: originalTimeline?.pts[0], seekFallbacks, sourcePtsCount: originalTimeline?.pts.length, sourceTimeBase: originalTimeline?.timeBase } };
  } finally { canvas.width = canvas.height = 1; }
}






