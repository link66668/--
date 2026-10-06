import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { MOTION_POSE_MODELS } from '../public/motion-models.js';

const verifyOnly = process.argv.includes('--verify');
const digest = (buffer, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(buffer).digest(encoding);
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
// Read only named regular files from the pinned npm tarball; never extract paths.
function packageFiles(tgz) {
  const tar = gunzipSync(tgz), files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid npm package archive');
    if (header[156] === 48 || header[156] === 0) files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
for (const directory of ['mp4box', 'mediapipe']) {
 const root = new URL(`../public/vendor/${directory}/`, import.meta.url);
 const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
 if (directory === 'mediapipe') {
  const tasks = manifest.files.filter(item => item.path.endsWith('.task'));
  if (tasks.length !== MOTION_POSE_MODELS.length || MOTION_POSE_MODELS.some(model => !tasks.some(item => item.path === model.assetPath))) {
    throw new Error('MediaPipe model catalog and pinned asset manifest must contain the same three task bundles');
  }
 }
 let packageContent;
 for (const item of manifest.files) {
  const target = new URL(item.path, root);
  const current = await readFile(target).catch(() => undefined);
  if (current && digest(current) === item.sha256) { console.log(`Verified ${item.path}`); continue; }
  if (verifyOnly) throw new Error(`Missing or incorrect asset: ${item.path}`);
  let bytes;
  if (item.url) bytes = await download(item.url);
  else {
    if (!packageContent) {
      const archive = await download(manifest.tarball);
      if (`sha512-${digest(archive, 'sha512', 'base64')}` !== manifest.integrity) throw new Error('npm package integrity mismatch');
      packageContent = packageFiles(archive);
    }
    bytes = packageContent.get(`package/${item.packagePath || item.path}`);
  }
  if (!bytes || digest(bytes) !== item.sha256) throw new Error(`Upstream checksum mismatch: ${item.path}`);
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, bytes);
  console.log(`Restored ${item.path}`);
 }
}
