import {reconcileAchievements} from './server/achievements.mjs';
import {beijingDate,validTrainingCompletion} from './public/achievements.js';
import {createHolidayService} from './server/holidays.mjs';
import http from 'node:http';
import { loadEnvFile } from 'node:process';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, dirname, join, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {createGzip} from 'node:zlib';
import { openStore, getRecords, getRecordChanges, recordFromRow, getProviders, providerFromRow } from './server/storage.mjs';
import { HttpError, validateProvider, selectProviderModel, discoverModels, buildMessages, complete } from './server/providers.mjs';
import { streamChat } from './server/chat-stream.mjs';
import { assistantTools, executeAssistantTool, getAssistantToolReceipts } from './server/assistant-tools.mjs';
import { resolveLocalToday, resolveLocalTime } from './server/calendar-data.mjs';
import { completeNutritionAdvice } from './server/nutrition-advice.mjs';
import { contextSections, readChatContext } from './server/chat-context.mjs';
import { addDays } from './public/schedule.js';
import {prepareChatHistory,historyTools} from './server/chat-history.mjs';
import { createCommunity } from './server/community.mjs';
import { communityTransaction } from './server/community-storage.mjs';
import { createCommunityMedia } from './server/community-media.mjs';
import {completeMotionCoach, validateMotionCoachRequest, MOTION_COACH_REQUEST_BYTES} from './server/motion-coach.mjs';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const MAX_FILE = 8 * 1024 * 1024;
const ID = /^[\w:-]{1,100}$/;
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };
const MODEL_FILES = new Set(['index.html', 'style.css', 'demo.bundle.js', 'demo.offline.js', 'atlas.worker.js', 'assets/anatomy-data.bin', 'model-loader.js', 'embed-bootstrap.js', 'atlas-model.js', 'atlas-rig.js', 'src.js', 'embed-interface.js', 'muscle-data.js', 'exercise-catalog.js', 'static-poses.js', 'THIRD_PARTY_LICENSES.txt', 'assets/anatomy-atlas.json', 'assets/anatomy-manifest.json', 'assets/anatomy-regions.json', 'assets/ANATOMY-SOURCE.md', 'assets/CC-BY-SA-4.0.txt', 'assets/Z-ANATOMY-LICENSE.txt']);

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, hash] = stored.split(':');
  const candidate = await scrypt(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === candidate.length && timingSafeEqual(candidate, known);
}

function publicUser(user) { return { id: user.id, email: user.email, name: user.name }; }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function currentTime() { return new Date().toISOString(); }
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请求内容必须使用 application/json。');
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new HttpError(413, '提交的内容超过大小限制。'); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, '提交的内容超过大小限制。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求 JSON 格式不正确。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求内容必须为 JSON 对象。');
  return body;
}

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不接受跨站请求。');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, '请求来源无效。'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new HttpError(403, '不接受跨站请求。');
  }
}

function sessionCookie(req, value, maxAge, secureCookie) {
  const secure = secureCookie || Boolean(req.socket.encrypted);
  return `fitness_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function sessionToken(req) {
  const token = (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith('fitness_session='))?.slice(16);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function serveStatic(req, res, pathname, publicDir, modelDir) {
  const model = pathname === '/model' || pathname.startsWith('/model/');
  let fileName = model ? pathname.replace(/^\/model\/?/, '') || 'index.html' : pathname.slice(1) || 'index.html';
  if (fileName.includes('\\') || fileName.includes('\0') || fileName.split('/').some(part => part === '..' || part.startsWith('.'))) throw new HttpError(404, '文件不存在。');
  if (model && !MODEL_FILES.has(fileName)) throw new HttpError(404, '文件不存在。');
  if (!model && !CONTENT_TYPES[extname(fileName)]) throw new HttpError(404, '文件不存在。');
  const base = await realpath(model ? modelDir : publicDir).catch(() => null);
  if (!base) throw new HttpError(404, '页面不存在。');
  const target = await realpath(join(base, fileName)).catch(() => null);
  const pathRelative = target && relative(base, target);
  if (!target || pathRelative.startsWith('..') || isAbsolute(pathRelative)) throw new HttpError(404, '文件不存在。');
  const info = await stat(target);
  if (!info.isFile()) throw new HttpError(404, '文件不存在。');
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', CONTENT_TYPES[extname(target)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  res.setHeader('Vary','Accept-Encoding');
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  const gzip=info.size>1024&&/\.(js|css|html|json|svg)$/.test(target)&&String(req.headers['accept-encoding']||'').split(',').some(value=>/^\s*gzip\s*(?:;|$)/i.test(value)&&!/(?:;\s*q=0(?:\.0*)?\s*$)/i.test(value));
  if(gzip)res.setHeader('Content-Encoding','gzip');else res.setHeader('Content-Length', info.size);
  res.writeHead(200);
  if (req.method === 'HEAD') res.end();
  else {const input=createReadStream(target).on('error',()=>res.destroy());if(gzip)input.pipe(createGzip({level:1})).on('error',()=>res.destroy()).pipe(res);else input.pipe(res);}
}

/** Create an isolated application server. The caller owns listen()/close(). */
export function createServer(options = {}) {
  const {
    dataDir = process.env.DATA_DIR || join(root, '.data'),
    publicDir = join(root, 'public'),
    modelDir = join(root, '精细模型与动作开发'),
    fetchImpl,
    aiTimeoutMs = 60000,
    allowPrivateProviders = process.env.ALLOW_PRIVATE_AI !== 'false',
    secureCookie = process.env.COOKIE_SECURE === 'true',
  } = options;
  const store = openStore(resolve(dataDir));
  const { db } = store;
  const communityMedia = createCommunityMedia({ db, dataDir: resolve(dataDir) });
  const community = createCommunity({ db, media: communityMedia, readBody, send,
    moderatorIds: options.communityModeratorIds ?? (process.env.COMMUNITY_MODERATOR_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    moderatorEmails: options.communityModeratorEmails ?? (process.env.COMMUNITY_MODERATOR_EMAILS ?? '').split(',').map(value => value.trim()).filter(Boolean) });
  const cleanupCommunityMedia = () => communityMedia.cleanupExpired().catch(error => console.error('[community] Media cleanup failed:', error.code ?? error.name));
  const communityCleanupTimer = setInterval(cleanupCommunityMedia, 60 * 60 * 1000);
  communityCleanupTimer.unref();
  void cleanupCommunityMedia();
  const loadHolidayYear=createHolidayService(resolve(dataDir),{fetcher:options.holidayFetchImpl});
  const attempts = new Map();
  const activeAi = new Map();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

  function rateLimit(req) {
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (attempts.size > 10000) for (const [address, entry] of attempts) if (entry.reset < now) attempts.delete(address);
    let entry = attempts.get(key);
    if (!entry || entry.reset < now) entry = { count: 0, reset: now + 15 * 60000 };
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > 40) throw new HttpError(429, '登录或注册尝试过于频繁，请 15 分钟后再试。');
  }
  function requireUser(req) {
    const token = sessionToken(req);
    const user = token && db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?').get(tokenHash(token), Date.now());
    if (!user) throw new HttpError(401, '请先登录。');
    return user;
  }
  function checkExpectedUser(req, user) {
    const expectedUser = req.headers['x-fitness-user'];
    if (expectedUser !== undefined && expectedUser !== user.id) throw new HttpError(409, '当前登录账号已变更，请重新登录后继续。');
  }
  function createSession(req, res, user) {
    const token = randomBytes(32).toString('hex');
    const previous = sessionToken(req);
    if (previous) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(previous));
    db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), user.id, Date.now() + 30 * DAY);
    res.setHeader('Set-Cookie', sessionCookie(req, token, 30 * 86400, secureCookie));
  }
  function providerWithKey(userId, id) {
    const row = db.prepare('SELECT * FROM providers WHERE user_id = ? AND id = ?').get(userId, id);
    if (!row) throw new HttpError(400, '未配置此 AI 供应商，请先在个人设置中添加。');
    return { ...providerFromRow(row), apiKey: store.decrypt(row.api_key) };
  }
  function resolveProvider(userId, value) {
    const row = typeof value?.id === 'string' ? db.prepare('SELECT * FROM providers WHERE user_id = ? AND id = ?').get(userId, value.id) : null;
    const old = row ? providerFromRow(row) : {};
    const provider = validateProvider(value, { existing: old });
    if (value.clearKey !== undefined && typeof value.clearKey !== 'boolean') throw new HttpError(400, '清除密钥设置无效。');
    const sameTarget = !row || (old.presetId === provider.presetId && old.protocol === provider.protocol && old.baseUrl === provider.baseUrl);
    if (!sameTarget && row.api_key && !provider.apiKey && !value.clearKey) throw new HttpError(400, '供应商或接口地址已更改，请重新填写 API Key，或明确清除原密钥。');
    const encryptedKey = provider.apiKey ? store.encrypt(provider.apiKey) : value.clearKey ? '' : row?.api_key ?? '';
    return { ...provider, encryptedKey, apiKey: provider.apiKey || (encryptedKey ? store.decrypt(encryptedKey) : '') };
  }
  async function withAiLimit(userId, operation) {
    const count = activeAi.get(userId) ?? 0;
    if (count >= 3) throw new HttpError(429, '同时进行的 AI 请求过多，请等待当前回复。');
    activeAi.set(userId, count + 1);
    try { return await operation(); }
    finally { const left = (activeAi.get(userId) ?? 1) - 1; if (left) activeAi.set(userId, left); else activeAi.delete(userId); }
  }
  async function callAi(userId, provider, messages, purpose, mealTiming) {
    return withAiLimit(userId, () => {
      const options = { provider, messages, purpose, fetchImpl, timeoutMs: aiTimeoutMs, allowPrivateProviders };
      return purpose === 'nutrition-advice' ? completeNutritionAdvice({ ...options, mealTiming }) : complete(options);
    });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    try {
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { throw new HttpError(400, '请求路径无效。'); }
      const method = req.method;
      if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(method)) checkOrigin(req);
      if (pathname === '/api/health' && method === 'GET') { send(res, 200, { ok: true }); return; }

      if (pathname === '/api/auth/register' && method === 'POST') {
        rateLimit(req);
        const body = await readBody(req, 10000);
        if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw new HttpError(400, '请填写有效邮箱。');
        if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new HttpError(400, '密码长度应为 8–256 个字符。');
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, '请填写昵称（最多 80 字）。');
        const email = body.email.trim().toLowerCase();
        if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new HttpError(409, '此邮箱已注册。');
        const user = { id: randomUUID(), email, name: body.name.trim() };
        const hash = await passwordHash(body.password);
        // Re-check after password hashing yields; concurrent registrations cannot bypass uniqueness.
        if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new HttpError(409, '此邮箱已注册。');
        db.prepare('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)').run(user.id, user.email, user.name, hash, currentTime());
        createSession(req, res, user);
        send(res, 201, { user }); return;
      }
      if (pathname === '/api/auth/login' && method === 'POST') {
        rateLimit(req);
        const body = await readBody(req, 10000);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        // Run scrypt even for unknown accounts to reduce account-enumeration timing differences.
        const valid = await verifyPassword(body.password, user?.password ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`);
        if (!user || !valid) throw new HttpError(401, '邮箱或密码不正确。');
        createSession(req, res, user);
        send(res, 200, { user: publicUser(user) }); return;
      }
      if (pathname === '/api/auth/logout' && method === 'POST') {
        if (req.headers['x-fitness-user'] !== undefined) checkExpectedUser(req, requireUser(req));
        const token = sessionToken(req);
        if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0, secureCookie));
        send(res, 200, { ok: true }); return;
      }
      if (pathname.startsWith('/api/')) {
        const user = requireUser(req);
        if (pathname === '/api/auth/me' && method === 'GET') { send(res, 200, { user: publicUser(user) }); return; }
        checkExpectedUser(req, user);
        if (await community.handle(req, res, user, pathname)) return;
        if (pathname === '/api/holidays' && method === 'GET') { const year=Number(new URL(req.url,'http://localhost').searchParams.get('year')); if(!Number.isInteger(year)||year<1900||year>2199)throw new HttpError(400,'节假日年份无效。');send(res,200,await loadHolidayYear(year));return; }
        if (pathname === '/api/state' && method === 'GET') {
          const expectedUser = new URL(req.url, 'http://localhost').searchParams.get('userId');
          if (expectedUser && expectedUser !== user.id) throw new HttpError(409, '当前登录账号已变更，请重新登录后同步。');
          reconcileAchievements(db,user.id,currentTime());
          send(res, 200, { userId: user.id, records: getRecords(db, user.id) }); return;
        }
        if (pathname === '/api/sync' && method === 'POST') {
          const { changes, userId, cursor } = await readBody(req, 8 * 1024 * 1024);
          if (userId !== undefined && userId !== user.id) throw new HttpError(409, '当前登录账号已变更，请重新登录后同步。');
          if (!Array.isArray(changes) || changes.length > 500) throw new HttpError(400, '每次最多同步 500 条记录。');
          const seen = new Set();
          for (const change of changes) {
            if (!change || typeof change.id !== 'string' || !ID.test(change.id) || typeof change.kind !== 'string' || !/^[\w-]{1,40}$/.test(change.kind) || !Number.isSafeInteger(change.baseVersion) || change.baseVersion < 0 || (change.deleted !== undefined && typeof change.deleted !== 'boolean') || change.data === undefined || (!change.deleted && (!change.data || typeof change.data !== 'object' || Array.isArray(change.data))) || seen.has(change.id)) throw new HttpError(400, '同步记录格式无效或重复。');
            if (Buffer.byteLength(JSON.stringify(change.data)) > (change.kind === 'conversation' ? 2 * 1024 * 1024 : change.kind === 'motion-assessment' ? 1024 * 1024 : 256 * 1024)) throw new HttpError(413, change.kind === 'conversation' ? '单个会话已超过 2 MB，请新建会话后继续。' : change.kind === 'motion-assessment' ? '单份动作评估报告已超过 1 MB，无法同步。' : '单条记录已超过 256 KB，请缩短内容。');
            if(['achievement','achievement-summary'].includes(change.kind)||change.id.startsWith('achievement:')||change.id==='achievement-summary')throw new HttpError(400,'成就由系统根据训练记录核算，不能直接修改。');
            if(!change.deleted&&validTrainingCompletion(change)&&change.data.date>beijingDate(currentTime()))throw new HttpError(400,'未来日期的训练不能提前完成。');
            seen.add(change.id);
          }
          const conflicts = [];
          const removedAttachments = new Set();
          db.exec('BEGIN IMMEDIATE');
          try {
            reconcileAchievements(db,user.id,currentTime());
            for (const change of changes) {
              const existing = db.prepare('SELECT * FROM records WHERE user_id = ? AND id = ?').get(user.id, change.id);
              if ((existing?.version ?? 0) !== change.baseVersion || existing && existing.kind !== change.kind) { conflicts.push({ id: change.id, server: recordFromRow(existing) ?? null }); continue; }
              if (existing && !existing.deleted) {
                for (const item of db.prepare('SELECT id FROM attachments WHERE user_id = ? AND instr(?, id) > 0').all(user.id, existing.data)) removedAttachments.add(item.id);
              }
              db.prepare(`INSERT INTO records(user_id,id,kind,data,version,deleted,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data,version=excluded.version,deleted=excluded.deleted,updated_at=excluded.updated_at`).run(user.id, change.id, change.kind, JSON.stringify(change.deleted ? null : change.data), (existing?.version ?? 0) + 1, change.deleted ? 1 : 0, currentTime());
            }
            // Reclaim only attachments formerly referenced by changed records that no
            // longer have any active reference after the entire transaction is applied.
            // Newly uploaded files and references in other records survive.
            for (const id of removedAttachments) {
              if (!db.prepare('SELECT 1 FROM records WHERE user_id = ? AND deleted = 0 AND instr(data, ?) > 0 LIMIT 1').get(user.id, id)) db.prepare('DELETE FROM attachments WHERE id = ? AND user_id = ?').run(id, user.id);
            }
            reconcileAchievements(db,user.id,currentTime());
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          send(res, 200, { userId: user.id, ...getRecordChanges(db,user.id,cursor), conflicts }); return;
        }
        if (pathname === '/api/providers' && method === 'GET') { send(res, 200, getProviders(db, user.id)); return; }
        if (pathname === '/api/providers' && method === 'PUT') {
          const body = await readBody(req);
          if (!Array.isArray(body.providers) || body.providers.length > 20 || (body.tasks !== undefined && (!body.tasks || typeof body.tasks !== 'object' || Array.isArray(body.tasks))) || (body.taskModels !== undefined && (!body.taskModels || typeof body.taskModels !== 'object' || Array.isArray(body.taskModels)))) throw new HttpError(400, '请提供供应商列表和有效的任务模型设置。');
          if (body.version !== undefined && (!Number.isSafeInteger(body.version) || body.version < 0)) throw new HttpError(400, 'AI 服务配置版本无效，请重新加载配置。');
          let settings;
          db.exec('BEGIN IMMEDIATE');
          try {
            const previous = getProviders(db, user.id);
            const alreadyConfigured = db.prepare('SELECT 1 FROM preferences WHERE user_id = ?').get(user.id) || previous.providers.length;
            if (body.version === undefined ? alreadyConfigured : body.version !== previous.version) throw new HttpError(409, 'AI 服务配置已更新，请重新加载配置后再保存。');
            const providers = body.providers.map(value => resolveProvider(user.id, value));
            if (new Set(providers.map(item => item.id)).size !== providers.length) throw new HttpError(400, '供应商 ID 不能重复。');
            const tasks = {}, taskModels = {};
            for (const task of ['chat', 'meal', 'planning', ...(Object.hasOwn(body.tasks || {}, 'motion') || Object.hasOwn(body.taskModels || {}, 'motion') || Object.hasOwn(previous.tasks, 'motion') ? ['motion'] : [])]) {
              const id = body.tasks?.[task] ?? (providers.some(item => item.id === previous.tasks[task]) ? previous.tasks[task] : '');
              if (typeof id !== 'string' || id && !providers.some(item => item.id === id)) throw new HttpError(400, '任务选择了不存在的供应商。');
              tasks[task] = id;
              const provider = providers.find(item => item.id === id);
              const oldModel = previous.tasks[task] === id ? previous.taskModels[task] : '';
              const legacyUpdate = body.taskModels === undefined && body.providers.some(item => item.id === id && item.model !== undefined && item.models === undefined);
              const model = body.taskModels?.[task] ?? (legacyUpdate ? provider?.model ?? '' : provider?.models.some(item => item.id === oldModel) ? oldModel : provider?.model ?? '');
              if (typeof model !== 'string' || model && !provider?.models.some(item => item.id === model)) throw new HttpError(400, '任务模型必须属于所选供应商已启用的模型。');
              taskModels[task] = id ? model : '';
            }
            db.prepare('DELETE FROM providers WHERE user_id = ?').run(user.id);
            for (const provider of providers) db.prepare('INSERT INTO providers(user_id,id,name,base_url,model,api_key,preset_id,protocol,models) VALUES(?,?,?,?,?,?,?,?,?)').run(user.id, provider.id, provider.name, provider.baseUrl, provider.model, provider.encryptedKey, provider.presetId, provider.protocol, JSON.stringify(provider.models));
            db.prepare('INSERT INTO preferences(user_id,tasks,task_models,version) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET tasks=excluded.tasks,task_models=excluded.task_models,version=excluded.version').run(user.id, JSON.stringify(tasks), JSON.stringify(taskModels), previous.version + 1);
            settings = getProviders(db, user.id);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          send(res, 200, settings); return;
        }
        if (['/api/providers/test', '/api/providers/models'].includes(pathname) && method === 'POST') {
          const body = await readBody(req);
          let provider;
          if (body.provider) {
            const value = { ...body.provider, id: body.provider.id ?? body.provider.presetId ?? 'preview' };
            provider = resolveProvider(user.id, value);
          } else if (typeof body.id === 'string') provider = providerWithKey(user.id, body.id);
          else throw new HttpError(400, '请选择供应商。');
          if (pathname === '/api/providers/models') {
            send(res, 200, await withAiLimit(user.id, () => discoverModels({ provider, fetchImpl, timeoutMs: aiTimeoutMs, allowPrivateProviders }))); return;
          }
          provider = selectProviderModel(provider, body.model);
          await callAi(user.id, provider, [{ role: 'user', content: 'Reply briefly with OK.' }]);
          send(res, 200, { ok: true, message: '连接成功，模型已返回有效回复。' }); return;
        }
        if (pathname === '/api/motion/coach' && method === 'POST') {
          const body = validateMotionCoachRequest(await readBody(req, MOTION_COACH_REQUEST_BYTES));
          const settings = getProviders(db, user.id);
          const id = settings.tasks.motion, model = settings.taskModels.motion;
          if (!id || !model) throw new HttpError(400, '尚未配置动作评估模型，请在 AI 服务设置中选择动作评估任务模型。');
          const provider = selectProviderModel(providerWithKey(user.id, id), model);
          const controller = new AbortController();
          const disconnect = () => { if (!res.writableEnded) controller.abort(new DOMException('已取消 AI 动作评估。', 'AbortError')); };
          res.once('close', disconnect);
          try {
            if (req.aborted || res.destroyed) return;
            const result = await withAiLimit(user.id, () => completeMotionCoach({provider, input: body, fetchImpl, timeoutMs: aiTimeoutMs, allowPrivateProviders, signal: controller.signal}));
            if (!controller.signal.aborted && !res.destroyed) send(res, 200, result);
          } catch (error) { if (!controller.signal.aborted && !res.destroyed) throw error; }
          finally { res.off('close', disconnect); }
          return;
        }
        if (pathname === '/api/ai' && method === 'POST') {
          const body = await readBody(req);
          if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError(400, '流式输出设置无效。');
          if (body.stream && body.task !== 'chat') throw new HttpError(400, '当前仅 AI 对话支持流式输出。');
          if (body.stream && (typeof body.requestId !== 'string' || !/^[\w-]{16,100}$/.test(body.requestId))) throw new HttpError(400, '请提供有效的对话请求 ID。');
          let localToday, localTime;
          if (body.stream) {
            try { localToday = resolveLocalToday(body.context?.localToday); localTime = resolveLocalTime(localToday, body.context?.timezoneOffset); }
            catch (error) { throw new HttpError(400, error.message); }
            body.context = { ...body.context, localToday };
          }
          const chatHistory=body.stream?prepareChatHistory({db,userId:user.id,body}):null;
          const messages = buildMessages(db, user.id, chatHistory?.body||body);
          if(chatHistory)messages[0].content+='\n'+chatHistory.notice;
          const settings = getProviders(db, user.id);
          const id = settings.tasks[body.task];
          if (!id) throw new HttpError(400, '尚未为此任务配置 AI 模型，请前往个人设置添加供应商并选择任务模型。');
          if (!settings.taskModels[body.task]) throw new HttpError(400, '尚未为此任务选择模型，请在 AI 服务设置中选择任务模型。');
          const provider = selectProviderModel(providerWithKey(user.id, id), settings.taskModels[body.task]);
          if (!body.stream) { send(res, 200, await callAi(user.id, provider, messages, body.task === 'planning' ? body.context?.purpose : undefined, body.context?.mealTiming)); return; }
          const controller = new AbortController();
          const disconnect = () => { if (!res.writableEnded) controller.abort(new DOMException('客户端已停止接收回复。', 'AbortError')); };
          res.once('close', disconnect);
          const event = async (name, data) => {
            if (controller.signal.aborted || res.destroyed) return;
            if (!res.headersSent) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
              res.flushHeaders();
            }
            if (!res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)) await new Promise(resolve => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
              res.once('drain', done); res.once('close', done);
            });
          };
          try {
            const result = await withAiLimit(user.id, () => streamChat({ provider, messages, tools: [...assistantTools,...historyTools],
              executeTool: async (name, args) => { const planStart=args?.schedule?.startDate||localToday,planDays=args?.schedule?.days??84;let planEnd;try{if(['create_training_plan','update_training_plan'].includes(name)&&Number.isInteger(planDays)&&planDays>=1&&planDays<=366)planEnd=addDays(planStart,planDays-1);}catch{}const years=new Set([localToday,args?.startDate,args?.endDate,args?.date,args?.task?.date,args?.schedule?.startDate,planEnd].filter(date=>typeof date==='string'&&/^\d{4}-/.test(date)).map(date=>Number(date.slice(0,4))));await Promise.all([...years].filter(year=>year>=1900&&year<=2199).map(loadHolidayYear));return executeAssistantTool({ db, userId: user.id, name, args, requestId: body.requestId, localToday, localTime }); },
              receipt: getAssistantToolReceipts({ db, userId: user.id, requestId: body.requestId }),
              executeHistoryTool:chatHistory.execute,
              fallbackMessages:()=>buildMessages(db,user.id,body).slice(1),
              fallbackContext: () => ({
                ...readChatContext({ db, userId: user.id, localToday, args: { sections: contextSections } }).data,
                plan: executeAssistantTool({ db, userId: user.id, name: 'get_training_plan', localToday }),
                calendar: executeAssistantTool({ db, userId: user.id, name: 'read_calendar', args: { startDate: localToday, endDate: addDays(localToday, 28) }, localToday }),
              }),
              fetchImpl, timeoutMs: aiTimeoutMs, allowPrivateProviders, signal: controller.signal, onEvent: event }));
            if (!controller.signal.aborted) await event('done', result);
          } catch (error) {
            if (!controller.signal.aborted) {
              const message = error instanceof HttpError ? error.message : ['AbortError', 'TimeoutError'].includes(error.name) ? 'AI 响应超时，请重试或切换模型。' : 'AI 流式响应失败，请重试。';
              if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 502, { error: message });
              else await event('error', { error: message });
            }
          } finally {
            res.off('close', disconnect);
            if (!res.destroyed && !res.writableEnded) res.end();
          }
          return;
        }
        if (pathname === '/api/attachments' && method === 'POST') {
          const body = await readBody(req, 12 * 1024 * 1024);
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 || /[\r\n\0]/.test(body.name) || !FILE_TYPES.has(body.type) || typeof body.data !== 'string' || body.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new HttpError(400, '附件格式无效。支持 JPEG、PNG、WebP、GIF、PDF 及 TXT/Markdown/CSV/JSON 文本。');
          const data = Buffer.from(body.data, 'base64');
          if (!data.length || data.length > MAX_FILE) throw new HttpError(413, '单个附件应大于 0 且不超过 8 MB。');
          if (data.toString('base64') !== body.data) throw new HttpError(400, '附件 Base64 编码无效。');
          const used = db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM attachments WHERE user_id = ?').get(user.id).total;
          if (used + data.length > 250 * 1024 * 1024) throw new HttpError(413, '个人附件已达到 250 MB 容量上限。');
          const item = { id: randomUUID(), name: body.name.trim(), type: body.type, size: data.length };
          db.prepare('INSERT INTO attachments(id,user_id,name,type,data,size,created_at) VALUES(?,?,?,?,?,?,?)').run(item.id, user.id, item.name, item.type, data, item.size, currentTime());
          send(res, 201, { ...item, url: `/api/attachments/${item.id}` }); return;
        }
        if (pathname.startsWith('/api/attachments/') && ['GET', 'HEAD'].includes(method)) {
          const id = pathname.slice('/api/attachments/'.length);
          const item = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(id, user.id);
          if (!item) throw new HttpError(404, '附件不存在。');
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          res.writeHead(200, { 'Content-Type': item.type, 'Content-Length': item.size, 'Cache-Control': 'private, no-store', 'Content-Disposition': `${item.type.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}` });
          res.end(method === 'HEAD' ? undefined : Buffer.from(item.data)); return;
        }
        if (pathname.startsWith('/api/attachments/') && method === 'DELETE') {
          const id = pathname.slice('/api/attachments/'.length);
          const item = db.prepare('SELECT id FROM attachments WHERE id = ? AND user_id = ?').get(id, user.id);
          if (!item) throw new HttpError(404, '附件不存在。');
          if (db.prepare('SELECT 1 FROM records WHERE user_id = ? AND deleted = 0 AND instr(data, ?) > 0 LIMIT 1').get(user.id, id)) throw new HttpError(409, '此附件仍被会话或记录引用，请先移除引用并同步。');
          db.prepare('DELETE FROM attachments WHERE id = ? AND user_id = ?').run(id, user.id);
          send(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/export' && method === 'GET') {
          reconcileAchievements(db,user.id,currentTime());
          const attachments = db.prepare('SELECT * FROM attachments WHERE user_id = ? ORDER BY created_at').all(user.id).map(item => ({ id: item.id, name: item.name, type: item.type, size: item.size, createdAt: item.created_at, data: Buffer.from(item.data).toString('base64') }));
          res.setHeader('Content-Disposition', 'attachment; filename="fitness-data.json"');
          send(res, 200, { schemaVersion: 2, exportedAt: currentTime(), user: publicUser(user), records: getRecords(db, user.id), ...getProviders(db, user.id), attachments, community: community.exportUser(user.id) }); return;
        }
        if (pathname === '/api/account' && method === 'DELETE') {
          rateLimit(req);
          const body = await readBody(req, 10000);
          if (!await verifyPassword(body.password, user.password)) throw new HttpError(401, '密码不正确，未删除账号。');
          const cleanupCommunityFiles = communityMedia.prepareUserCleanup(user.id);
          communityTransaction(db, () => {
            community.deleteUserData(user.id);
            db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
          });
          await cleanupCommunityFiles();
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          res.setHeader('Set-Cookie', sessionCookie(req, '', 0, secureCookie));
          send(res, 200, { ok: true }); return;
        }
        throw new HttpError(404, '接口不存在。');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, '不支持此请求方法。');
      await serveStatic(req, res, pathname, publicDir, modelDir);
    } catch (error) {
      if (!res.headersSent && error instanceof HttpError && error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '服务器处理失败，请稍后重试。' });
      else res.destroy();
      if (!(error instanceof HttpError)) console.error('[server] Request failed:', error.code ?? error.name);
    }
  });
  server.requestTimeout = 90000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.once('close', () => { clearInterval(communityCleanupTimer); db.close(); });
  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  const port = options.port ?? Number(process.env.PORT || 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, host, resolvePromise); });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { loadEnvFile(join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = await startServer();
  console.log(`AI 健身助手已启动：http://localhost:${server.address().port}`);
  const shutdown = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
