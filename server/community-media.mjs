import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { HttpError } from './providers.mjs';
import { decodeCommunityWebpDimensions } from './community-webp.mjs';
import { attachmentImageIds } from './community-attachments.mjs';

const DAY = 86400000;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
const ID = /^[a-f0-9-]{36}$/;
const invalid = message => { throw new HttpError(422, message || '素材文件损坏或格式不受支持。'); };
const check = (condition, message) => { if (!condition) invalid(message); };
const dimensions = (width, height) => {
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40000000, '图片尺寸无效或超过 4000 万像素限制。');
  return { width, height };
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function png(data) {
  check(data.length >= 45 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  let offset = 8, info, ended = false, palette = false, idatEnded = false;
  const pixels = [];
  while (offset < data.length) {
    check(offset + 12 <= data.length);
    const length = data.readUInt32BE(offset), end = offset + 12 + length;
    check(end <= data.length);
    const type = data.toString('ascii', offset + 4, offset + 8), body = data.subarray(offset + 8, end - 4);
    check(/^[A-Za-z]{4}$/.test(type) && crc32(data.subarray(offset + 4, end - 4)) === data.readUInt32BE(end - 4));
    if (!info) {
      check(type === 'IHDR' && length === 13);
      const width = body.readUInt32BE(0), height = body.readUInt32BE(4), depth = body[8], color = body[9];
      dimensions(width, height);
      check(({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[color]?.includes(depth) && body[10] === 0 && body[11] === 0 && body[12] <= 1);
      info = { width, height, depth, color, interlace: body[12] };
    } else if (type === 'IHDR') invalid();
    else if (type === 'PLTE') { check(!pixels.length && length > 0 && length <= 768 && length % 3 === 0); palette = true; }
    else if (type === 'IDAT') { check(!idatEnded && length > 0); pixels.push(body); }
    else {
      if (pixels.length) idatEnded = true;
      if (type === 'IEND') { check(length === 0 && end === data.length); ended = true; break; }
      check(type[0] === type[0].toLowerCase(), 'PNG 包含不支持的关键数据块。');
    }
    offset = end;
  }
  check(ended && pixels.length > 0 && (info.color !== 3 || palette));
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[info.color], bpp = channels * info.depth;
  const passes = info.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let expected = 0;
  const rows = [];
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((info.width - x) / dx)), height = Math.max(0, Math.ceil((info.height - y) / dy));
    if (!width || !height) continue;
    const stride = Math.ceil(width * bpp / 8) + 1;
    expected += stride * height;
    rows.push([stride, height]);
  }
  let decoded;
  try { decoded = inflateSync(Buffer.concat(pixels), { maxOutputLength: expected + 1 }); } catch { invalid('PNG 图像数据损坏。'); }
  check(decoded.length === expected);
  let scan = 0;
  for (const [stride, height] of rows) for (let y = 0; y < height; y++, scan += stride) check(decoded[scan] <= 4);
  return dimensions(info.width, info.height);
}
function jpeg(data) {
  check(data.length >= 20 && data[0] === 255 && data[1] === 216);
  let offset = 2, info, quantization = false, huffman = false, scans = 0, ended = false;
  const components = new Set();
  while (offset < data.length) {
    check(data[offset++] === 255);
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 217) { check(scans > 0 && offset === data.length); ended = true; break; }
    check(marker && marker !== 216 && !(marker >= 208 && marker <= 215) && offset + 2 <= data.length);
    const length = data.readUInt16BE(offset), end = offset + length;
    check(length >= 2 && end <= data.length);
    const body = data.subarray(offset + 2, end);
    if ([192, 193, 194].includes(marker)) {
      check(!info && body.length >= 9 && body[0] === 8 && [1, 3, 4].includes(body[5]) && body.length === 6 + 3 * body[5]);
      info = dimensions(body.readUInt16BE(3), body.readUInt16BE(1));
      for (let i = 6; i < body.length; i += 3) { check(!components.has(body[i]) && (body[i + 1] >> 4) > 0 && (body[i + 1] >> 4) <= 4 && (body[i + 1] & 15) > 0 && (body[i + 1] & 15) <= 4 && body[i + 2] <= 3); components.add(body[i]); }
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) invalid('JPEG 编码不受支持，请使用常规或渐进式 JPEG。');
    else if (marker === 219) {
      let cursor = 0;
      while (cursor < body.length) { const table = body[cursor++]; check((table >> 4) <= 1 && (table & 15) <= 3); cursor += 64 * ((table >> 4) + 1); check(cursor <= body.length); }
      check(cursor > 0); quantization = true;
    } else if (marker === 196) {
      let cursor = 0;
      while (cursor < body.length) {
        const table = body[cursor++]; check((table >> 4) <= 1 && (table & 15) <= 3 && cursor + 16 <= body.length);
        let count = 0, capacity = 1;
        for (let i = 0; i < 16; i++) { const codes = body[cursor++]; capacity = capacity * 2 - codes; check(capacity >= 0); count += codes; }
        check(count > 0 && count <= 256 && cursor + count <= body.length); cursor += count;
      }
      check(cursor > 0); huffman = true;
    } else if (marker === 218) {
      check(info && quantization && huffman && body.length >= 6 && body[0] > 0 && body.length === 4 + 2 * body[0]);
      for (let i = 1; i < body.length - 3; i += 2) check(components.has(body[i]) && (body[i + 1] >> 4) <= 3 && (body[i + 1] & 15) <= 3);
      let entropy = 0; offset = end;
      while (offset < data.length) {
        if (data[offset] !== 255) { offset++; entropy++; continue; }
        let next = offset + 1;
        while (data[next] === 255) next++;
        check(next < data.length);
        if (data[next] === 0 || (data[next] >= 208 && data[next] <= 215)) { offset = next + 1; entropy++; }
        else break;
      }
      check(entropy > 0); scans++; continue;
    }
    offset = end;
  }
  check(info && ended && scans);
  return info;
}
function webp(data) {
  check(data.length >= 26 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) === data.length - 8);
  let offset = 12, info, extended;
  while (offset < data.length) {
    check(offset + 8 <= data.length);
    const type = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4), end = offset + 8 + length;
    check(end <= data.length);
    const body = data.subarray(offset + 8, end);
    if (type === 'VP8X') { check(offset === 12 && length === 10 && (body[0] & 0xc3) === 0 && body[1] === 0 && body[2] === 0 && body[3] === 0); extended = dimensions(1 + body.readUIntLE(4, 3), 1 + body.readUIntLE(7, 3)); }
    else if (type === 'VP8 ') {
      check(!info && length > 10 && !(body[0] & 1) && ((body[0] >> 1) & 7) <= 3 && (body[0] & 16) && body.subarray(3, 6).equals(Buffer.from([157, 1, 42])));
      check((body.readUIntLE(0, 3) >> 5) > 0 && (body.readUIntLE(0, 3) >> 5) < length - 3);
      info = dimensions(body.readUInt16LE(6) & 0x3fff, body.readUInt16LE(8) & 0x3fff);
    } else if (type === 'VP8L') {
      check(!info && length > 5 && body[0] === 47);
      const bits = body.readUInt32LE(1); check((bits >>> 29) === 0);
      info = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (type === 'ANIM' || type === 'ANMF') invalid('请使用静态 WebP 图片。');
    offset = end + (length & 1);
    check(offset <= data.length);
  }
  check(info && offset === data.length && (!extended || (extended.width === info.width && extended.height === info.height)));
  let decoded;
  try { decoded = decodeCommunityWebpDimensions(data); } catch { invalid('WebP 图像数据损坏。'); }
  check(decoded.width === info.width && decoded.height === info.height, 'WebP 尺寸与真实图像数据不一致。');
  return dimensions(decoded.width, decoded.height);
}

function boxes(data, start = 0, end = data.length) {
  const result = [];
  let offset = start;
  while (offset < end) {
    check(offset + 8 <= end);
    let size = data.readUInt32BE(offset), header = 8;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (size === 1) { check(offset + 16 <= end); const large = data.readBigUInt64BE(offset + 8); check(large <= BigInt(Number.MAX_SAFE_INTEGER)); size = Number(large); header = 16; }
    if (size === 0) size = end - offset;
    check(size >= header && offset + size <= end && result.length < 200000);
    result.push({ type, start: offset, data: offset + header, end: offset + size });
    offset += size;
  }
  check(offset === end);
  return result;
}
const child = (data, parent, type) => { const found = boxes(data, parent.data, parent.end).filter(box => box.type === type); check(found.length === 1); return found[0]; };
function duration(data, box) {
  const version = data[box.data]; check(version <= 1 && box.end - box.data >= (version ? 32 : 20));
  const scale = data.readUInt32BE(box.data + (version ? 20 : 12));
  const value = version ? Number(data.readBigUInt64BE(box.data + 24)) : data.readUInt32BE(box.data + 16);
  check(scale > 0 && Number.isSafeInteger(value) && value > 0);
  return value / scale;
}
function bitReader(data) {
  let offset = 0;
  const read = count => { check(Number.isInteger(count) && count >= 0 && count <= 32 && offset + count <= data.length * 8); let value = 0; for (let i = 0; i < count; i++, offset++) value = value * 2 + ((data[offset >> 3] >> (7 - (offset & 7))) & 1); return value; };
  const ue = () => { let zeros = 0; while (read(1) === 0) { zeros++; check(zeros <= 30); } return 2 ** zeros - 1 + read(zeros); };
  const se = () => { const value = ue(); return value & 1 ? (value + 1) / 2 : -value / 2; };
  return { read, ue, se };
}
function spsDimensions(nal) {
  check(nal.length > 4 && (nal[0] & 31) === 7 && !(nal[0] & 128));
  const rbsp = [];
  for (let i = 1; i < nal.length; i++) { if (i > 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; rbsp.push(nal[i]); }
  const { read, ue, se } = bitReader(Buffer.from(rbsp));
  const profile = read(8); read(8); read(8); ue();
  let chroma = 1, separate = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue(); check(chroma === 1, '视频需使用浏览器可播放的 H.264 4:2:0 色彩格式。');
    check(ue() === 0 && ue() === 0, '视频需使用浏览器可播放的 8 位 H.264 编码。'); read(1);
    if (read(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (read(1)) {
      let last = 8, next = 8;
      for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
    }
  }
  check(ue() <= 12);
  const order = ue(); check(order <= 2);
  if (order === 0) check(ue() <= 12);
  if (order === 1) { read(1); se(); se(); const count = ue(); check(count <= 255); for (let i = 0; i < count; i++) se(); }
  ue(); read(1);
  const width = (ue() + 1) * 16, rows = ue() + 1, frame = read(1);
  if (!frame) read(1); read(1);
  let left = 0, right = 0, top = 0, bottom = 0;
  if (read(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
  const format = separate ? 0 : chroma, unitX = format === 1 || format === 2 ? 2 : 1, unitY = (format === 1 ? 2 : 1) * (2 - frame);
  return dimensions(width - (left + right) * unitX, rows * 16 * (2 - frame) - (top + bottom) * unitY);
}
function avcConfig(data, config, width, height) {
  const body = data.subarray(config.data, config.end);
  check(body.length > 7 && body[0] === 1 && [66, 77, 100].includes(body[1]) && body[3] > 0 && body[3] <= 62 && (body[4] & 252) === 252 && (body[5] & 224) === 224, '视频需为 MP4 H.264（Baseline、Main 或 High）编码。');
  const lengthSize = (body[4] & 3) + 1; check(lengthSize !== 3);
  const count = body[5] & 31; check(count > 0);
  let offset = 6;
  for (let i = 0; i < count; i++) {
    check(offset + 2 <= body.length); const length = body.readUInt16BE(offset); offset += 2;
    check(length > 4 && offset + length <= body.length);
    check(body[offset + 1] === body[1] && body[offset + 2] === body[2] && body[offset + 3] === body[3], 'H.264 配置与真实编码数据不一致。');
    const parsed = spsDimensions(body.subarray(offset, offset + length)); check(parsed.width === width && parsed.height === height, '视频尺寸与 H.264 图像数据不一致。'); offset += length;
  }
  check(offset < body.length);
  const pps = body[offset++]; check(pps > 0);
  for (let i = 0; i < pps; i++) { check(offset + 2 <= body.length); const length = body.readUInt16BE(offset); offset += 2; check(length >= 2 && offset + length <= body.length && (body[offset] & 31) === 8 && !(body[offset] & 128)); offset += length; }
  return lengthSize;
}
function audioConfig(data, config) {
  check(config.end - config.data >= 8);
  const descriptors = (start, end) => {
    const list = [];
    while (start < end) {
      const tag = data[start++]; let size = 0, octets = 0, value;
      do { check(start < end && octets++ < 4); value = data[start++]; size = size * 128 + (value & 127); } while (value & 128);
      check(start + size <= end); list.push({ tag, start, end: start + size }); start += size;
    }
    return list;
  };
  const es = descriptors(config.data + 4, config.end).find(item => item.tag === 3); check(es && es.end - es.start >= 3);
  let cursor = es.start + 3; const flags = data[es.start + 2];
  if (flags & 128) cursor += 2;
  if (flags & 64) { check(cursor < es.end); cursor += 1 + data[cursor]; }
  if (flags & 32) cursor += 2;
  check(cursor <= es.end);
  const decoder = descriptors(cursor, es.end).find(item => item.tag === 4);
  check(decoder && decoder.end - decoder.start >= 13 && data[decoder.start] === 64 && ((data[decoder.start + 1] >> 2) & 63) === 5, '视频音频需为 AAC-LC 编码。');
  const asc = descriptors(decoder.start + 13, decoder.end).find(item => item.tag === 5); check(asc && asc.end - asc.start >= 2);
  const { read } = bitReader(data.subarray(asc.start, asc.end));
  check(read(5) === 2, '视频音频需为 AAC-LC 编码。');
  const frequency = read(4); check(frequency <= 12 || frequency === 15);
  if (frequency === 15) check(read(24) >= 8000);
  const channels = read(4); check(channels > 0 && channels <= 7);
}
function mp4(data) {
  const root = boxes(data), ftyp = root.find(box => box.type === 'ftyp'), moov = root.find(box => box.type === 'moov'), mdats = root.filter(box => box.type === 'mdat');
  check(ftyp && ftyp === root[0] && moov && mdats.length > 0 && !root.some(box => ['moof', 'mfra'].includes(box.type)), '请使用完整的非分片 MP4 文件。');
  check(ftyp.end - ftyp.data >= 8 && (ftyp.end - ftyp.data) % 4 === 0);
  const brands = [data.toString('ascii', ftyp.data, ftyp.data + 4)];
  for (let offset = ftyp.data + 8; offset < ftyp.end; offset += 4) brands.push(data.toString('ascii', offset, offset + 4));
  check(brands.some(brand => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)));
  const movieDuration = duration(data, child(data, moov, 'mvhd'));
  check(movieDuration <= 60, '视频最长 60 秒。');
  let video, audio = 0, keyframe = false;
  const tracks = boxes(data, moov.data, moov.end).filter(box => box.type === 'trak'); check(tracks.length > 0 && tracks.length <= 2);
  for (const track of tracks) {
    const mdia = child(data, track, 'mdia'), hdlr = child(data, mdia, 'hdlr'); check(hdlr.end - hdlr.data >= 12);
    const kind = data.toString('ascii', hdlr.data + 8, hdlr.data + 12); check(['vide', 'soun'].includes(kind), 'MP4 只能包含一个 H.264 视频轨和可选 AAC 音频轨。');
    const mdhd = child(data, mdia, 'mdhd'), trackDuration = duration(data, mdhd), timescale = data.readUInt32BE(mdhd.data + (data[mdhd.data] ? 20 : 12)); check(trackDuration <= 60, '视频最长 60 秒。');
    const stbl = child(data, child(data, mdia, 'minf'), 'stbl'), stsd = child(data, stbl, 'stsd');
    check(stsd.end - stsd.data > 8 && data.readUInt32BE(stsd.data + 4) === 1);
    const entries = boxes(data, stsd.data + 8, stsd.end); check(entries.length === 1);
    const entry = entries[0]; let nalSize = 0;
    if (kind === 'vide') {
      check(!video && entry.type === 'avc1' && entry.end - entry.data >= 78, '视频需为 H.264 avc1 编码，暂不支持 HEVC 或 AV1。');
      const width = data.readUInt16BE(entry.data + 24), height = data.readUInt16BE(entry.data + 26);
      dimensions(width, height);
      const config = boxes(data, entry.data + 78, entry.end).find(box => box.type === 'avcC'); check(config);
      nalSize = avcConfig(data, config, width, height);
      video = { width, height, duration: Math.max(trackDuration, movieDuration) };
    } else {
      check(++audio <= 1 && entry.type === 'mp4a' && entry.end - entry.data >= 28 && data.readUInt16BE(entry.data + 8) === 0, '视频音频需为 AAC-LC 编码。');
      const config = boxes(data, entry.data + 28, entry.end).find(box => box.type === 'esds'); check(config); audioConfig(data, config);
    }
    const stsz = child(data, stbl, 'stsz'); check(stsz.end - stsz.data >= 12);
    const fixedSize = data.readUInt32BE(stsz.data + 4), count = data.readUInt32BE(stsz.data + 8); check(count > 0 && count <= 20000 && stsz.end - stsz.data === 12 + (fixedSize ? 0 : count * 4));
    const sizes = Array.from({ length: count }, (_, i) => fixedSize || data.readUInt32BE(stsz.data + 12 + i * 4)); check(sizes.every(size => size > 0));
    const stts = child(data, stbl, 'stts'); check(stts.end - stts.data >= 8);
    const timingCount = data.readUInt32BE(stts.data + 4); check(timingCount > 0 && stts.end - stts.data === 8 + timingCount * 8);
    let timedSamples = 0, timedTicks = 0;
    for (let i = 0; i < timingCount; i++) { const samples = data.readUInt32BE(stts.data + 8 + i * 8), delta = data.readUInt32BE(stts.data + 12 + i * 8); check(samples > 0 && delta > 0); timedSamples += samples; timedTicks += samples * delta; }
    check(timedSamples === count && Number.isSafeInteger(timedTicks));
    const actualDuration = timedTicks / timescale;
    check(actualDuration <= 60, '视频最长 60 秒。');
    check(Math.abs(actualDuration - trackDuration) <= 1 / timescale, 'MP4 声明时长与媒体样本时长不一致。');
    const stsc = child(data, stbl, 'stsc'); check(stsc.end - stsc.data >= 8);
    const mapCount = data.readUInt32BE(stsc.data + 4); check(mapCount > 0 && stsc.end - stsc.data === 8 + mapCount * 12);
    const maps = Array.from({ length: mapCount }, (_, i) => ({ first: data.readUInt32BE(stsc.data + 8 + i * 12), count: data.readUInt32BE(stsc.data + 12 + i * 12), description: data.readUInt32BE(stsc.data + 16 + i * 12) }));
    check(maps[0].first === 1 && maps.every((map, i) => map.count > 0 && map.description === 1 && (!i || map.first > maps[i - 1].first)));
    const chunkBoxes = boxes(data, stbl.data, stbl.end).filter(box => ['stco', 'co64'].includes(box.type)); check(chunkBoxes.length === 1);
    const chunks = chunkBoxes[0], step = chunks.type === 'stco' ? 4 : 8; check(chunks.end - chunks.data >= 8);
    const chunkCount = data.readUInt32BE(chunks.data + 4); check(chunkCount > 0 && chunks.end - chunks.data === 8 + chunkCount * step && maps.at(-1).first <= chunkCount);
    let sample = 0, mapIndex = 0;
    for (let i = 0; i < chunkCount; i++) {
      if (mapIndex + 1 < maps.length && maps[mapIndex + 1].first === i + 1) mapIndex++;
      let offset = step === 4 ? data.readUInt32BE(chunks.data + 8 + i * step) : Number(data.readBigUInt64BE(chunks.data + 8 + i * step)); check(Number.isSafeInteger(offset));
      for (let j = 0; j < maps[mapIndex].count; j++) {
        check(sample < sizes.length); const end = offset + sizes[sample++];
        check(mdats.some(box => offset >= box.data && end <= box.end), 'MP4 媒体数据缺失或索引无效。');
        if (kind === 'vide') {
          let cursor = offset, vcl = false;
          while (cursor < end) {
            check(cursor + nalSize < end); const length = data.readUIntBE(cursor, nalSize); cursor += nalSize;
            check(length > 0 && cursor + length <= end && !(data[cursor] & 128));
            const type = data[cursor] & 31; check(type > 0 && type <= 23);
            if (type === 1 || type === 5) { check(length >= 2); vcl = true; if (type === 5) keyframe = true; }
            cursor += length;
          }
          check(cursor === end && vcl);
        }
        offset = end;
      }
    }
    check(sample === count);
  }
  check(video && keyframe, 'MP4 缺少可播放的视频关键帧。');
  return video;
}

/** Parse the original container and encoded dimensions; caller MIME is verified. */
export function validateCommunityMedia(data, type) {
  check(Buffer.isBuffer(data) && data.length > 0);
  if (!TYPES.has(type)) throw new HttpError(415, '仅支持 JPEG、PNG、WebP 图片和 H.264/AAC MP4 视频。');
  try {
    const parsed = type === 'image/png' ? png(data) : type === 'image/jpeg' ? jpeg(data) : type === 'image/webp' ? webp(data) : mp4(data);
    return { type, ...parsed, duration: parsed.duration ?? null };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid('素材文件损坏，无法读取真实尺寸或编码。');
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); res.end(body);
}
export function createCommunityMedia({ db, dataDir, now = () => Date.now(), quotaBytes = 250 * 1024 * 1024, uploadsPerMinute = 12 }) {
  const directory = resolve(dataDir, 'community-media');
  db.exec(`CREATE TABLE IF NOT EXISTS community_media (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('note','avatar','attachment')), type TEXT NOT NULL,
    size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, duration REAL NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL, expires_at TEXT);
    CREATE INDEX IF NOT EXISTS community_media_user ON community_media(user_id);
    CREATE INDEX IF NOT EXISTS community_media_expiry ON community_media(expires_at);`);
  const pending = new Map(), rates = new Map();
  const row = id => db.prepare('SELECT * FROM community_media WHERE id=?').get(id);
  const noteRef = id => db.prepare('SELECT n.id,n.user_id,n.status FROM community_note_media m JOIN community_notes n ON n.id=m.note_id WHERE m.media_id=?').get(id);
  const avatarRef = id => db.prepare('SELECT user_id FROM community_profiles WHERE avatar_media_id=?').get(id);
  const attachmentRef = id => db.prepare('SELECT * FROM community_attachment_media WHERE media_id=?').get(id);
  const moderator = userId => Boolean(db.prepare('SELECT 1 FROM community_roles WHERE user_id=?').get(userId));
  const expired = item => item.expires_at && Date.parse(item.expires_at) <= now();
  const filePath = item => {
    if (!/^[a-f0-9-]{36}\.bin$/.test(item.storage_key)) throw new Error('Invalid community media storage key');
    const path = resolve(directory, item.storage_key), local = relative(directory, path);
    if (local.startsWith('..') || isAbsolute(local)) throw new Error('Invalid community media storage path');
    return path;
  };
  const getMediaDto = (id, { management = 'normal' } = {}) => {
    const item = typeof id === 'object' ? id : row(id);
    if (!item) return null;
    const prefix = management === 'mine' ? '/me/media/' : management === 'moderation' ? '/moderation/media/' : '/media/';
    return { id: item.id, purpose: item.purpose, type: item.type, size: item.size, width: item.width, height: item.height, duration: item.type === 'video/mp4' ? item.duration : null, status: item.status, createdAt: item.created_at, expiresAt: item.expires_at, url: `/api/community${prefix}${item.id}` };
  };
  const verify = (userId, id, purpose, noteId) => {
    const item = typeof id === 'string' ? row(id) : null;
    if (!item || item.user_id !== userId || item.purpose !== purpose || item.status !== 'ready') throw new HttpError(422, '素材不属于当前账号、用途不符或尚未完成验证。');
    const attached = noteRef(id);
    if (attached && (attached.id !== noteId || attached.status === 'deleted')) throw new HttpError(422, '每个素材只能用于一篇笔记，请重新上传。');
    if (!attached && !avatarRef(id) && !attachmentRef(id) && expired(item)) throw new HttpError(410, '草稿素材已过期，请重新上传。');
    return item;
  };
  function verifyForNote(userId, mediaItems, noteId) {
    if (!Array.isArray(mediaItems) || mediaItems.length > 10) throw new HttpError(422, '笔记素材数量无效。');
    const seen = new Set();
    return mediaItems.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || seen.has(entry.id)) throw new HttpError(422, '笔记素材不能重复。');
      seen.add(entry.id);
      const item = verify(userId, entry.id, 'note', noteId), role = entry.role || 'image';
      if (!['image', 'video', 'video-cover'].includes(role) || (role === 'video') !== (item.type === 'video/mp4')) throw new HttpError(422, '素材格式与用途不匹配。');
      return { ...getMediaDto(item), role, isCover: Boolean(entry.isCover), position: index };
    });
  }
  const verifyAvatar = (userId, mediaId) => {
    if (!mediaId) return null;
    const item = verify(userId, mediaId, 'avatar');
    if (item.type === 'video/mp4') throw new HttpError(422, '头像必须为图片。');
    return getMediaDto(item);
  };
  function verifyForAttachment(userId, ids) {
    return attachmentImageIds(ids).map(id => {
      const item = verify(userId, id, 'attachment');
      if (!item.type.startsWith('image/') || attachmentRef(id)) throw new HttpError(422, '图片已被其他内容引用，请重新上传。');
      return getMediaDto(item);
    });
  }
  function bindAttachment(targetType, targetId, images) {
    const insert = db.prepare('INSERT INTO community_attachment_media(media_id,target_type,target_id,position) VALUES(?,?,?,?)');
    for (const [position, image] of images.entries()) {
      insert.run(image.id, targetType, targetId, position);
      db.prepare('UPDATE community_media SET expires_at=NULL WHERE id=?').run(image.id);
    }
  }
  const attachedImageIds = (targetType, targetId) => db.prepare('SELECT media_id FROM community_attachment_media WHERE target_type=? AND target_id=? ORDER BY position').all(targetType, targetId).map(item => item.media_id);
  const attachmentImages = (targetType, targetId, options) => attachedImageIds(targetType, targetId).map(id => row(id)).filter(item => item?.status === 'ready').map(item => getMediaDto(item, options));
  function bindNote(noteId, mediaItems) {
    const expiresAt = new Date(now() + 7 * DAY).toISOString();
    db.prepare('UPDATE community_media SET expires_at=? WHERE id IN (SELECT media_id FROM community_note_media WHERE note_id=?)').run(expiresAt, noteId);
    db.prepare('DELETE FROM community_note_media WHERE note_id=?').run(noteId);
    const insert = db.prepare('INSERT INTO community_note_media(note_id,media_id,position,role,is_cover) VALUES(?,?,?,?,?)');
    mediaItems.forEach((item, index) => { insert.run(noteId, item.id, index, item.role || 'image', Number(Boolean(item.isCover))); db.prepare('UPDATE community_media SET expires_at=NULL WHERE id=?').run(item.id); });
  }
  function bindAvatar(userId, mediaId) {
    verifyAvatar(userId, mediaId);
    const old = db.prepare('SELECT avatar_media_id FROM community_profiles WHERE user_id=?').get(userId)?.avatar_media_id;
    db.prepare('UPDATE community_profiles SET avatar_media_id=? WHERE user_id=?').run(mediaId || null, userId);
    if (old && old !== mediaId) db.prepare('UPDATE community_media SET expires_at=? WHERE id=?').run(new Date(now() + 7 * DAY).toISOString(), old);
    if (mediaId) db.prepare('UPDATE community_media SET expires_at=NULL WHERE id=?').run(mediaId);
  }
  async function removeFile(item) { await unlink(filePath(item)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async function cleanupExpired() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const items = db.prepare('SELECT * FROM community_media WHERE expires_at IS NOT NULL AND expires_at<=?').all(new Date(now()).toISOString());
    let removed = 0;
    for (const item of items) {
      // Mark synchronously so a concurrent publication cannot bind a file whose
      // deletion has started. Existing references always take priority over TTL.
      if (noteRef(item.id) || avatarRef(item.id) || attachmentRef(item.id)) { db.prepare('UPDATE community_media SET expires_at=NULL WHERE id=?').run(item.id); continue; }
      db.prepare("UPDATE community_media SET status='expired' WHERE id=?").run(item.id);
      try { await removeFile(item); db.prepare('DELETE FROM community_media WHERE id=?').run(item.id); removed++; }
      catch (error) { db.prepare("UPDATE community_media SET status='ready' WHERE id=?").run(item.id); throw error; }
    }
    // Interrupted uploads and expired-file tombstones never become readable assets.
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.(?:upload|expired|bin)$/.test(name)) continue;
      const target = join(directory, name), info = await stat(target).catch(() => null);
      if (!info || info.mtimeMs >= now() - DAY) continue;
      // A day of grace protects the rename-before-insert upload window. It also
      // retries failed account-deletion cleanup after the row was cascaded away.
      if (name.endsWith('.bin') && db.prepare('SELECT 1 FROM community_media WHERE storage_key=?').get(name)) continue;
      await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return removed;
  }
  function prepareUserCleanup(userId) {
    const files = db.prepare(`SELECT * FROM community_media WHERE user_id=? OR id IN (
      SELECT a.media_id FROM community_attachment_media a JOIN community_messages m ON a.target_type='message' AND a.target_id=m.id
        JOIN community_conversations c ON c.id=m.conversation_id WHERE c.user_a=? OR c.user_b=?
      UNION SELECT a.media_id FROM community_attachment_media a JOIN community_comments c ON a.target_type='comment' AND a.target_id=c.id
        JOIN community_notes n ON n.id=c.note_id WHERE n.user_id=?
      UNION SELECT a.media_id FROM community_attachment_media a JOIN community_group_messages m ON a.target_type='group-message' AND a.target_id=m.id
        JOIN community_groups g ON g.id=m.group_id WHERE g.owner_id=? AND NOT EXISTS(SELECT 1 FROM community_group_members p WHERE p.group_id=g.id AND p.user_id<>?))`).all(userId, userId, userId, userId, userId, userId);
    return async () => { for (const item of files) await removeFile(item); return files.length; };
  }
  const cleanupUser = userId => prepareUserCleanup(userId)();
  async function deleteNoteMedia(noteId) {
    const files = db.prepare('SELECT m.* FROM community_media m JOIN community_note_media n ON n.media_id=m.id WHERE n.note_id=?').all(noteId);
    for (const item of files) { await removeFile(item); db.prepare("UPDATE community_media SET status='deleted' WHERE id=?").run(item.id); }
    return files.length;
  }
  const exportUser = userId => db.prepare('SELECT * FROM community_media WHERE user_id=? ORDER BY created_at,id').all(userId).map(item => ({ ...getMediaDto(item), originalName: item.original_name }));
  async function upload(req, res, user, url) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), purpose = url.searchParams.get('purpose') || 'note';
    if (!TYPES.has(type) || !['note', 'avatar', 'attachment'].includes(purpose) || (purpose !== 'note' && type === 'video/mp4')) { req.resume(); throw new HttpError(415, '仅支持 JPEG、PNG、WebP 图片和 H.264/AAC MP4 视频；头像及互动附件必须为图片。'); }
    const limit = type === 'video/mp4' ? VIDEO_LIMIT : IMAGE_LIMIT, length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > limit) { req.resume(); throw new HttpError(413, type === 'video/mp4' ? '视频最大 50MB。' : '图片最大 10MB。'); }
    const recent = (rates.get(user.id) || []).filter(time => now() - time < 60000);
    if (recent.length >= uploadsPerMinute) { req.resume(); res.setHeader('Retry-After', Math.max(1, Math.ceil((recent[0] + 60000 - now()) / 1000))); throw new HttpError(429, '上传过于频繁，请稍后重试。'); }
    recent.push(now()); rates.set(user.id, recent);
    await cleanupExpired();
    const used = db.prepare("SELECT COALESCE(SUM(size),0) AS size FROM community_media WHERE user_id=? AND status<>'deleted'").get(user.id).size;
    const reservation = Number.isFinite(length) && length >= 0 ? length : limit;
    if (used + (pending.get(user.id) || 0) + reservation > quotaBytes) { req.resume(); res.setHeader('Retry-After', '60'); throw new HttpError(429, '社区素材总容量已达上限，请先删除未使用素材或笔记。'); }
    pending.set(user.id, (pending.get(user.id) || 0) + reservation);
    const id = randomUUID(), temporary = join(directory, `${id}.upload`), final = `${id}.bin`;
    let file, stored = false;
    try {
      file = await open(temporary, 'wx', 0o600);
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > limit || bytes > reservation) { req.resume(); throw new HttpError(413, '素材超过大小或容量限制。'); }
        let written = 0;
        while (written < chunk.length) { const result = await file.write(chunk, written, chunk.length - written); if (!result.bytesWritten) throw new Error('Unable to write community media'); written += result.bytesWritten; }
      }
      await file.close(); file = null;
      const parsed = validateCommunityMedia(await readFile(temporary), type);
      let name = '';
      try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { name = ''; }
      name = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
      const createdAt = new Date(now()).toISOString(), expiresAt = new Date(now() + 7 * DAY).toISOString();
      await rename(temporary, join(directory, final));
      // The upload may finish after another tab deletes the account.
      if (!db.prepare('SELECT id FROM users WHERE id=?').get(user.id)) throw new HttpError(401, '账号已失效，请重新登录。');
      db.prepare('INSERT INTO community_media(id,user_id,purpose,type,size,width,height,duration,storage_key,original_name,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,\'ready\',?,?)').run(id, user.id, purpose, type, bytes, parsed.width, parsed.height, parsed.duration ?? 0, final, name, createdAt, expiresAt);
      stored = true; send(res, 201, { media: getMediaDto(id) });
    } finally {
      if (file) await file.close();
      pending.set(user.id, Math.max(0, (pending.get(user.id) || 0) - reservation));
      if (!pending.get(user.id)) pending.delete(user.id);
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!stored) await unlink(join(directory, final)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const authorize = (item, userId, mode) => {
    const attached = noteRef(item.id), avatar = avatarRef(item.id), attachment = attachmentRef(item.id);
    if (item.status !== 'ready' || attached?.status === 'deleted') return false;
    // All URL aliases use the same private audience. Owning the upload or being
    // a moderator never bypasses membership or the new-join history boundary.
    if (attachment?.target_type === 'message') return Boolean(db.prepare(`SELECT 1 FROM community_messages m JOIN community_conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND (c.user_a=? OR c.user_b=?)`).get(attachment.target_id, userId, userId));
    if (attachment?.target_type === 'group-message') return Boolean(db.prepare(`SELECT 1 FROM community_group_messages m JOIN community_groups g ON g.id=m.group_id AND g.status='active'
      JOIN community_group_members p ON p.group_id=g.id AND p.user_id=? WHERE m.id=? AND m.seq>p.joined_seq`).get(userId, attachment.target_id));
    if (attachment?.target_type === 'comment') {
      const comment = db.prepare('SELECT c.status,n.status AS note_status,n.user_id AS note_owner FROM community_comments c JOIN community_notes n ON n.id=c.note_id WHERE c.id=?').get(attachment.target_id);
      if (!comment || comment.status === 'deleted' || comment.note_status === 'deleted') return false;
      if (mode === 'moderation') return moderator(userId);
      if (mode === 'mine') return item.user_id === userId && (comment.note_status === 'published' || comment.note_owner === userId);
      return comment.status === 'published' && comment.note_status === 'published';
    }
    if (item.purpose === 'attachment') return mode !== 'moderation' && item.user_id === userId && !expired(item);
    if (mode === 'moderation') return moderator(userId) && Boolean(attached);
    if (mode === 'mine') return item.user_id === userId && (!expired(item) || attached || avatar);
    if (avatar) return true;
    if (attached) return attached.status === 'published';
    return item.user_id === userId && !expired(item);
  };
  async function serve(req, res, item, userId, mode) {
    const info = await stat(filePath(item)).catch(() => null);
    if (!info?.isFile() || info.size !== item.size) throw new HttpError(404, '素材已删除或不可见。');
    // Filesystem I/O yields to concurrent moderation and account changes.
    const current = row(item.id);
    if (!current || !db.prepare('SELECT id FROM users WHERE id=?').get(userId) || !authorize(current, userId, mode)) throw new HttpError(404, '素材已删除或不可见。');
    let start = 0, end = info.size - 1, status = 200;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let valid = Boolean(match && (match[1] || match[2]));
      if (valid && !match[1]) { const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0; start = Math.max(0, info.size - suffix); }
      else if (valid) { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < info.size; end = Math.min(end, info.size - 1); }
      if (!valid) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' }); res.end(); return; }
      status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    res.writeHead(status, { 'Content-Type': item.type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filePath(item), { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  async function handle(req, res, user, pathname) {
    const url = new URL(req.url, 'http://localhost'), path = pathname || url.pathname;
    if (path === '/api/community/media' && req.method === 'POST') { await upload(req, res, user, url); return true; }
    const match = /^\/api\/community\/(media|me\/media|moderation\/media)\/([^/]+)(\/metadata)?$/.exec(path);
    if (!match) return false;
    const [, route, id, metadata] = match;
    if (!ID.test(id)) throw new HttpError(404, '素材已删除或不可见。');
    const item = row(id); if (!item) throw new HttpError(404, '素材已删除或不可见。');
    if (metadata && route === 'media' && req.method === 'GET') {
      if (item.user_id !== user.id || item.status !== 'ready' || noteRef(id)?.status === 'deleted' || attachmentRef(id) && !authorize(item, user.id, 'mine')) throw new HttpError(404, '素材已删除或不可见。');
      if (expired(item) && !noteRef(id) && !avatarRef(id) && !attachmentRef(id)) throw new HttpError(410, '草稿素材已过期，请重新上传。');
      send(res, 200, { media: getMediaDto(item) }); return true;
    }
    if (route === 'media' && !metadata && req.method === 'DELETE') {
      if (item.user_id !== user.id) throw new HttpError(404, '素材已删除或不可见。');
      if (noteRef(id) || avatarRef(id) || attachmentRef(id)) throw new HttpError(409, '素材已被内容或头像引用，不能单独删除。');
      // Reserving deletion before awaiting file I/O makes publishing reject it.
      db.prepare("UPDATE community_media SET status='deleting' WHERE id=?").run(id);
      try { await removeFile(item); db.prepare('DELETE FROM community_media WHERE id=?').run(id); }
      catch (error) { db.prepare("UPDATE community_media SET status='ready' WHERE id=?").run(id); throw error; }
      send(res, 200, { deleted: true }); return true;
    }
    if (!metadata && ['GET', 'HEAD'].includes(req.method)) {
      const mode = route === 'me/media' ? 'mine' : route === 'moderation/media' ? 'moderation' : 'normal';
      if (!authorize(item, user.id, mode)) throw new HttpError(404, '素材已删除或不可见。');
      await serve(req, res, item, user.id, mode); return true;
    }
    throw new HttpError(405, '此媒体接口不支持该操作。');
  }
  return { handle, verifyForNote, verifyAvatar, bindNote, bindAvatar, verifyForAttachment, bindAttachment, attachedImageIds, attachmentImages, getMediaDto, cleanupExpired, prepareUserCleanup, cleanupUser, deleteNoteMedia, exportUser, directory };
}
