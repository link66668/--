import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createCommunityMedia, validateCommunityMedia } from '../server/community-media.mjs';
import { createCommunityStore } from '../server/community-storage.mjs';

const DAY = 86400000;
const tinyVideo = await readFile(new URL('./fixtures/community-tiny.mp4', import.meta.url));
const tinyAudioVideo = await readFile(new URL('./fixtures/community-tiny-aac.mp4', import.meta.url));
const realJpeg = await readFile(new URL('../public/assets/exercises/squat.jpg', import.meta.url));
const realWebp = await readFile(new URL('../public/assets/landing-sanctuary.webp', import.meta.url));
const lossyWebp = await readFile(new URL('./fixtures/community-tiny-vp8.webp', import.meta.url));
const losslessWebp = await readFile(new URL('./fixtures/community-tiny-vp8l.webp', import.meta.url));
// A complete RIFF/VP8L container and valid 100x100 header, with no decodable
// image payload. Header-only validation previously accepted and published it.
const headerOnlyWebp = Buffer.from('5249464612000000574542505650384c060000002f63c0180000', 'hex');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
  const content = Buffer.concat([Buffer.from(type), body]), result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length); content.copy(result, 4); result.writeUInt32BE(crc32(content), result.length - 4); return result;
}
function tinyPng(width = 2, height = 3) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raster = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raster[(width * 4 + 1) * y + 1 + x * 4 + 3] = 255;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raster)), pngChunk('IEND', Buffer.alloc(0))]);
}
const image = tinyPng();

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'community-media-test-'));
  const db = new DatabaseSync(join(directory, 'community.sqlite')); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY);');
  createCommunityStore(db);
  for (const id of ['alice', 'bob', 'admin']) {
    db.prepare('INSERT INTO users(id) VALUES(?)').run(id);
    db.prepare('INSERT INTO community_profiles(user_id,nickname,bio,updated_at) VALUES(?,?,?,?)').run(id, id, '', new Date().toISOString());
  }
  db.prepare('INSERT INTO community_roles(user_id,role,created_at) VALUES(?,?,?)').run('admin', 'moderator', new Date().toISOString());
  let clock = Date.parse('2026-10-02T00:00:00Z');
  const media = createCommunityMedia({ db, dataDir: directory, now: () => clock, ...options });
  const server = http.createServer(async (req, res) => {
    try {
      const id = req.headers['x-test-user'] || 'alice';
      if (!db.prepare('SELECT id FROM users WHERE id=?').get(id)) { res.writeHead(401); res.end(); return; }
      if (!await media.handle(req, res, { id })) { res.writeHead(404); res.end(); }
    } catch (error) {
      if (res.headersSent) { res.destroy(error); return; }
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/community`;
  const request = (path, init = {}, user = 'alice') => fetch(base + path, { ...init, headers: { 'X-Test-User': user, ...init.headers } });
  const upload = async (data = image, type = 'image/png', purpose = 'note', user = 'alice') => {
    const response = await request(`/media?purpose=${purpose}`, { method: 'POST', headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent('测试原图.png') }, body: data }, user);
    const value = await response.json(); return { response, value, item: value.media };
  };
  const createNote = (id, user = 'alice', status = 'published') => db.prepare('INSERT INTO community_notes(id,user_id,type,title,body,category,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, user, 'image', '测试笔记', '测试正文', 'training', status, new Date(clock).toISOString(), new Date(clock).toISOString());
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, directory, media, request, upload, createNote, base, advance: time => { clock += time; } };
}

test('解析真实 PNG、JPEG、WebP、无音频 H.264 和 H.264/AAC MP4', () => {
  assert.deepEqual(validateCommunityMedia(image, 'image/png'), { type: 'image/png', width: 2, height: 3, duration: null });
  assert.deepEqual(validateCommunityMedia(realJpeg, 'image/jpeg'), { type: 'image/jpeg', width: 850, height: 567, duration: null });
  assert.deepEqual(validateCommunityMedia(realWebp, 'image/webp'), { type: 'image/webp', width: 1536, height: 1024, duration: null });
  for (const video of [tinyVideo, tinyAudioVideo]) assert.deepEqual(validateCommunityMedia(video, 'video/mp4'), { type: 'video/mp4', width: 160, height: 120, duration: 1 });
});

test('拒绝伪格式、错误 CRC/尺寸、截断图像和不兼容/超时长 MP4', () => {
  assert.throws(() => validateCommunityMedia(image, 'image/jpeg'), error => error.status === 422);
  assert.throws(() => validateCommunityMedia(realJpeg.subarray(0, 150), 'image/jpeg'), error => error.status === 422);
  const damaged = Buffer.from(image); damaged[45] ^= 1;
  assert.throws(() => validateCommunityMedia(damaged, 'image/png'), error => error.status === 422);
  assert.throws(() => validateCommunityMedia(tinyPng(0, 3), 'image/png'), error => error.status === 422);
  assert.throws(() => validateCommunityMedia(realWebp.subarray(0, 40), 'image/webp'), error => error.status === 422);
  assert.throws(() => validateCommunityMedia(Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), 'video/mp4'), error => error.status === 422);
  const longVideo = Buffer.from(tinyVideo), mvhd = longVideo.indexOf(Buffer.from('mvhd'));
  longVideo.writeUInt32BE(longVideo.readUInt32BE(mvhd + 16) * 61, mvhd + 20);
  assert.throws(() => validateCommunityMedia(longVideo, 'video/mp4'), error => error.status === 422 && /60/.test(error.message));
  const incompatible = Buffer.from(tinyVideo), avc1 = incompatible.indexOf(Buffer.from('avc1'), incompatible.indexOf(Buffer.from('moov')));
  incompatible.write('hvc1', avc1, 'ascii');
  assert.throws(() => validateCommunityMedia(incompatible, 'video/mp4'), error => error.status === 422 && /H.264/.test(error.message));
  const badOffset = Buffer.from(tinyVideo), stco = badOffset.indexOf(Buffer.from('stco')); badOffset.writeUInt32BE(badOffset.length + 10, stco + 12);
  assert.throws(() => validateCommunityMedia(badOffset, 'video/mp4'), error => error.status === 422);
  const misleadingTiming = Buffer.from(tinyVideo), stts = misleadingTiming.indexOf(Buffer.from('stts')); misleadingTiming.writeUInt32BE(100000000, stts + 16);
  assert.throws(() => validateCommunityMedia(misleadingTiming, 'video/mp4'), error => error.status === 422 && /60/.test(error.message));
});

test('WebP 解码校验支持有透明通道的 VP8/VP8L，拒绝完整容器中的损坏压缩内容', () => {
  for (const data of [lossyWebp, losslessWebp]) {
    assert.deepEqual(validateCommunityMedia(data, 'image/webp'), { type: 'image/webp', width: 4, height: 3, duration: null });
  }
  const damagedLossy = Buffer.from(lossyWebp), damagedLossless = Buffer.from(losslessWebp);
  // Keep RIFF sizes, codec headers, dimensions, and the VP8 partition size
  // intact; only the compressed data changes. These are not length checks.
  damagedLossy.fill(255, damagedLossy.indexOf(Buffer.from('VP8 ')) + 8 + 10);
  damagedLossless.fill(0, damagedLossless.indexOf(Buffer.from('VP8L')) + 8 + 5);
  for (let repeat = 0; repeat < 4; repeat++) {
    for (const data of [headerOnlyWebp, damagedLossy, damagedLossless]) {
      assert.throws(() => validateCommunityMedia(data, 'image/webp'), error => error.status === 422 && /WebP/.test(error.message));
    }
    // A failed native decode must not poison subsequent validation.
    assert.equal(validateCommunityMedia(lossyWebp, 'image/webp').width, 4);
    assert.equal(validateCommunityMedia(losslessWebp, 'image/webp').height, 3);
  }
  const oversized = Buffer.from(losslessWebp);
  oversized.writeUInt32LE((9999 | (9999 << 14) | (1 << 28)) >>> 0, oversized.indexOf(Buffer.from('VP8L')) + 9);
  assert.throws(() => validateCommunityMedia(oversized, 'image/webp'), error => error.status === 422 && /4000 万像素/.test(error.message));
});

test('损坏 WebP 上传返回 422 且不留下文件或 ready 素材，正常 VP8/VP8L 仍可上传和绑定', async t => {
  const f = await fixture(t);
  const damagedLossy = Buffer.from(lossyWebp);
  damagedLossy.fill(255, damagedLossy.indexOf(Buffer.from('VP8 ')) + 18);
  for (const data of [headerOnlyWebp, damagedLossy]) {
    const result = await f.upload(data, 'image/webp');
    assert.equal(result.response.status, 422); assert.match(result.value.error, /WebP/);
    assert.deepEqual(await readdir(f.media.directory), []);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM community_media').get().count, 0);
  }
  for (const [index, data] of [lossyWebp, losslessWebp].entries()) {
    const { response, item } = await f.upload(data, 'image/webp');
    assert.equal(response.status, 201); assert.equal(item.status, 'ready');
    assert.equal(item.width, 4); assert.equal(item.height, 3);
    const noteId = `valid-webp-${index}`;
    f.createNote(noteId);
    f.media.bindNote(noteId, f.media.verifyForNote('alice', [{ id: item.id, role: 'image', isCover: true }]));
    const downloaded = await f.request(`/media/${item.id}`, {}, 'bob');
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), data);
  }
});

test('独立二进制流上传原图及视频、草稿授权与 owner 元信息复验', async t => {
  const f = await fixture(t);
  const { response, item } = await f.upload();
  assert.equal(response.status, 201); assert.equal(item.width, 2); assert.equal(item.height, 3); assert.equal(item.size, image.length);
  assert.equal(item.status, 'ready'); assert.equal(Date.parse(item.expiresAt) - Date.parse(item.createdAt), 7 * DAY);
  const own = await f.request(`/media/${item.id}`); assert.equal(own.status, 200); assert.deepEqual(Buffer.from(await own.arrayBuffer()), image);
  assert.equal((await f.request(`/media/${item.id}`, {}, 'bob')).status, 404);
  assert.equal((await f.request(`/media/${item.id}/metadata`, {}, 'bob')).status, 404);
  assert.equal((await f.request(`/media/${item.id}/metadata`)).status, 200);
  const stored = f.db.prepare('SELECT * FROM community_media WHERE id=?').get(item.id);
  assert.equal(stored.original_name, '测试原图.png'); assert.ok(f.media.directory.startsWith(f.directory));
  assert.deepEqual(await readFile(join(f.media.directory, stored.storage_key)), image);
  const video = await f.upload(tinyAudioVideo, 'video/mp4'); assert.equal(video.response.status, 201); assert.equal(video.item.duration, 1);
  const bad = await f.upload(Buffer.from('hello'), 'image/png'); assert.equal(bad.response.status, 422);
  const unsupported = await f.upload(image, 'image/gif'); assert.equal(unsupported.response.status, 415);
  const wrongAvatar = await f.upload(tinyVideo, 'video/mp4', 'avatar'); assert.equal(wrongAvatar.response.status, 415);
  assert.equal((await readdir(f.media.directory)).some(name => /\.upload$/.test(name)), false);
});

test('笔记素材独占、头像按有效引用公开，下架专用授权和删除全面失效', async t => {
  const f = await fixture(t), photo = (await f.upload()).item;
  f.createNote('first');
  const valid = f.media.verifyForNote('alice', [{ id: photo.id, role: 'image', isCover: true }]); f.media.bindNote('first', valid);
  assert.equal((await f.request(`/media/${photo.id}`, {}, 'bob')).status, 200);
  assert.equal((await f.request(`/media/${photo.id}/metadata`)).status, 200);
  assert.equal(f.media.getMediaDto(photo.id).expiresAt, null);
  assert.throws(() => f.media.verifyForNote('bob', [{ id: photo.id, role: 'image' }]), error => error.status === 422);
  assert.throws(() => f.media.verifyForNote('alice', [{ id: photo.id, role: 'image' }], 'other'), error => error.status === 422);
  assert.equal(f.media.verifyForNote('alice', [{ id: photo.id, role: 'image' }], 'first').length, 1);
  assert.equal((await f.request(`/media/${photo.id}`, { method: 'DELETE' })).status, 409);
  f.db.prepare("UPDATE community_notes SET status='hidden' WHERE id='first'").run();
  assert.equal((await f.request(`/media/${photo.id}`)).status, 404);
  assert.equal((await f.request(`/me/media/${photo.id}`)).status, 200);
  assert.equal((await f.request(`/me/media/${photo.id}`, {}, 'bob')).status, 404);
  assert.equal((await f.request(`/moderation/media/${photo.id}`, {}, 'bob')).status, 404);
  assert.equal((await f.request(`/moderation/media/${photo.id}`, {}, 'admin')).status, 200);
  f.db.prepare("UPDATE community_notes SET status='deleted' WHERE id='first'").run();
  for (const [route, user] of [['media', 'alice'], ['me/media', 'alice'], ['moderation/media', 'admin']]) assert.equal((await f.request(`/${route}/${photo.id}`, {}, user)).status, 404);
  assert.equal((await f.request(`/media/${photo.id}/metadata`)).status, 404);
  await f.media.deleteNoteMedia('first');
  assert.equal(await stat(join(f.media.directory, f.db.prepare('SELECT storage_key FROM community_media WHERE id=?').get(photo.id).storage_key)).catch(() => null), null);
  const avatar = (await f.upload(image, 'image/png', 'avatar')).item;
  assert.equal((await f.request(`/media/${avatar.id}`, {}, 'bob')).status, 404);
  assert.throws(() => f.media.verifyForNote('alice', [{ id: avatar.id, role: 'image' }]), error => error.status === 422);
  f.media.bindAvatar('alice', avatar.id);
  assert.equal((await f.request(`/media/${avatar.id}`, {}, 'bob')).status, 200);
  f.media.bindAvatar('alice', null);
  assert.equal((await f.request(`/media/${avatar.id}`, {}, 'bob')).status, 404);
});

test('GET/HEAD Range 206、后缀/开放区间、416 和安全内容响应', async t => {
  const f = await fixture(t), item = (await f.upload(tinyVideo, 'video/mp4')).item;
  const head = await f.request(`/media/${item.id}`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(tinyVideo.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [['bytes=0-9', 0, 9], ['bytes=10-', 10, tinyVideo.length - 1], ['bytes=-10', tinyVideo.length - 10, tinyVideo.length - 1], ['bytes=0-999999', 0, tinyVideo.length - 1]]) {
    const result = await f.request(`/media/${item.id}`, { headers: { Range: range } }); assert.equal(result.status, 206);
    assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${tinyVideo.length}`); assert.equal(result.headers.get('content-type'), 'video/mp4'); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), tinyVideo.subarray(start, end + 1));
  }
  const rangedHead = await f.request(`/media/${item.id}`, { method: 'HEAD', headers: { Range: 'bytes=0-9' } }); assert.equal(rangedHead.status, 206); assert.equal(rangedHead.headers.get('content-length'), '10');
  for (const range of ['bytes=999999-', 'bytes=10-3', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-5', 'bytes=9007199254740992-']) {
    const result = await f.request(`/media/${item.id}`, { headers: { Range: range } }); assert.equal(result.status, 416); assert.equal(result.headers.get('content-range'), `bytes */${tinyVideo.length}`);
  }
});

test('七天清理仅删除未引用草稿，编辑移除素材重新到期，账号删除捕获文件', async t => {
  const f = await fixture(t), draft = (await f.upload()).item, published = (await f.upload()).item, avatar = (await f.upload(image, 'image/png', 'avatar')).item;
  f.createNote('published'); f.media.bindNote('published', f.media.verifyForNote('alice', [{ id: published.id, role: 'image' }])); f.media.bindAvatar('alice', avatar.id);
  // Deliberately stale expiry must not remove assets currently in use.
  f.db.prepare('UPDATE community_media SET expires_at=? WHERE id IN (?,?)').run(draft.expiresAt, published.id, avatar.id);
  f.advance(8 * DAY);
  assert.equal((await f.request(`/media/${draft.id}/metadata`)).status, 410);
  assert.throws(() => f.media.verifyForNote('alice', [{ id: draft.id, role: 'image' }]), error => error.status === 410);
  assert.equal(await f.media.cleanupExpired(), 1); assert.equal(f.media.getMediaDto(draft.id), null);
  assert.equal((await f.request(`/media/${published.id}`, {}, 'bob')).status, 200); assert.equal((await f.request(`/media/${avatar.id}`, {}, 'bob')).status, 200);
  f.media.bindNote('published', []); assert.ok(f.media.getMediaDto(published.id).expiresAt);
  f.advance(8 * DAY); assert.equal(await f.media.cleanupExpired(), 1);
  const cleanup = f.media.prepareUserCleanup('alice'); assert.equal(typeof cleanup, 'function');
  f.db.prepare('DELETE FROM users WHERE id=?').run('alice');
  assert.equal((await f.request(`/media/${avatar.id}`, {}, 'bob')).status, 404);
  assert.equal(await cleanup(), 1); assert.deepEqual(await readdir(f.media.directory), []);
});

test('上传大小上限、频率与容量限制均拒绝且不遗留文件', async t => {
  const f = await fixture(t, { quotaBytes: image.length * 2, uploadsPerMinute: 10 });
  assert.equal((await f.upload()).response.status, 201); assert.equal((await f.upload()).response.status, 201);
  const quota = await f.upload(); assert.equal(quota.response.status, 429); assert.ok(quota.response.headers.get('retry-after'));
  assert.equal((await readdir(f.media.directory)).length, 2);
  const imageTooBig = await f.upload(Buffer.alloc(10 * 1024 * 1024 + 1)); assert.equal(imageTooBig.response.status, 413);
  const videoTooBig = await f.upload(Buffer.alloc(50 * 1024 * 1024 + 1), 'video/mp4'); assert.equal(videoTooBig.response.status, 413);
  const limited = await fixture(t, { uploadsPerMinute: 1 });
  assert.equal((await limited.upload()).response.status, 201); const rate = await limited.upload(); assert.equal(rate.response.status, 429); assert.equal(rate.response.headers.get('retry-after'), '60');
  limited.advance(60001); assert.equal((await limited.upload()).response.status, 201);
});

test('删除笔记释放文件容量、孤儿文件清理留出一天的上传宽限', async t => {
  const f = await fixture(t, { quotaBytes: image.length }), photo = (await f.upload()).item;
  f.createNote('quota-note'); f.media.bindNote('quota-note', f.media.verifyForNote('alice', [{ id: photo.id, role: 'image' }]));
  assert.equal((await f.upload()).response.status, 429);
  f.db.prepare("UPDATE community_notes SET status='deleted' WHERE id='quota-note'").run(); await f.media.deleteNoteMedia('quota-note');
  assert.equal((await f.request(`/media/${photo.id}/metadata`)).status, 404);
  assert.equal((await f.upload()).response.status, 201);
  const old = join(f.media.directory, `${randomUUID()}.bin`), recent = join(f.media.directory, `${randomUUID()}.bin`), unrelated = join(f.directory, 'outside.txt');
  await writeFile(old, 'abandoned'); await writeFile(recent, 'finishing upload'); await writeFile(unrelated, 'untouched');
  const clock = Date.parse('2026-10-02T00:00:00Z');
  await utimes(old, new Date(clock - 2 * DAY), new Date(clock - 2 * DAY)); await utimes(recent, new Date(clock), new Date(clock));
  await f.media.cleanupExpired();
  assert.equal(await stat(old).catch(() => null), null); assert.ok(await stat(recent)); assert.equal(await readFile(unrelated, 'utf8'), 'untouched');
});

test('无 Content-Length 的流式超限请求返回 413 并移除部分文件', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`${f.base}/media`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' } }, res => {
      const body = []; res.on('data', chunk => body.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(body).toString() }));
    });
    req.on('error', reject);
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 11; i++) req.write(block);
    req.end();
  });
  assert.equal(result.status, 413); assert.match(result.body, /超过/); assert.deepEqual(await readdir(f.media.directory), []);
});
