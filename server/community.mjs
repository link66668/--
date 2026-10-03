import { createHash, randomInt, randomUUID } from 'node:crypto';
import { HttpError } from './providers.mjs';
import { communityTransaction } from './community-storage.mjs';
import { createCommunityMessages } from './community-messages.mjs';
import { createCommunityGroups } from './community-groups.mjs';
import { COMMUNITY_REPORT_REASON_LABELS } from '../public/community-report-reasons.js';
import { attachmentImageIds } from './community-attachments.mjs';

const CATEGORIES = new Set(['training', 'diet', 'checkin', 'experience', 'question']);
const CATEGORY_ALIASES = { '训练': 'training', '饮食': 'diet', '打卡': 'checkin', '经验': 'experience', '提问': 'question' };
const REPORT_REASONS = new Set(Object.keys(COMMUNITY_REPORT_REASON_LABELS));
const SNAPSHOT_TTL = 30 * 60 * 1000;
const now = () => new Date().toISOString();
const length = value => Array.from(value).length;
const unavailable = () => new HttpError(404, '笔记已删除或不可见。');
const commentUnavailable = () => new HttpError(404, '评论已删除或不可见。');
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function text(value, maximum, label, required = false) {
  if (typeof value !== 'string' || length(value) > maximum || value.includes('\0') || (required && !value.trim())) throw new HttpError(400, `${label}${required ? '不能为空，且' : ''}最多 ${maximum} 字。`);
  return value.trim();
}
function mutationId(body, required = true) {
  const id = body.clientMutationId;
  if (!required && id === undefined) return null;
  if (typeof id !== 'string' || !/^[\w:-]{1,100}$/.test(id)) throw new HttpError(400, '请提供有效的请求唯一键 clientMutationId。');
  return id;
}
function activeValue(body) {
  if (typeof body.active !== 'boolean') throw new HttpError(400, '请明确指定 active 状态。');
  return body.active;
}
function limitValue(params) {
  const value = params.get('limit');
  const limit = value === null ? 20 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, '每页数量应为 1–50。');
  return limit;
}
function versionValue(body) {
  const value = body.version ?? body.baseVersion;
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, '请提供当前笔记版本。');
  return value;
}

/** Auth and Origin validation are performed by the existing server before dispatch. */
export function createCommunity({ db, media, readBody, send, moderatorIds = [], moderatorEmails = [] }) {
  const configuredIds = new Set(moderatorIds);
  const configuredEmails = new Set(moderatorEmails.map(value => value.trim().toLowerCase()));
  // Configuration is authoritative; roles cannot survive a revoked server grant.
  db.prepare('DELETE FROM community_roles').run();
  const transaction = operation => communityTransaction(db, operation);
  const transactionFor = (user, operation) => transaction(() => {
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(user.id)) throw new HttpError(401, '请先登录。');
    return operation();
  });
  function isModerator(user) {
    const allowed = configuredIds.has(user.id) || configuredEmails.has(user.email);
    if (allowed) db.prepare("INSERT OR IGNORE INTO community_roles(user_id,role,created_at) VALUES(?,'moderator',?)").run(user.id, now());
    return allowed;
  }
  function requireModerator(user) { if (!isModerator(user)) throw new HttpError(403, '仅社区管理员可以处理举报。'); }
  function ensureProfile(userId) {
    const user = db.prepare('SELECT id,name FROM users WHERE id=?').get(userId);
    if (!user) return null;
    db.prepare('INSERT OR IGNORE INTO community_profiles(user_id,nickname,bio,updated_at) VALUES(?,?,?,?)').run(userId, Array.from(user.name).slice(0, 20).join(''), '', now());
    if (!db.prepare('SELECT 1 FROM community_accounts WHERE user_id=?').get(userId)) {
      // Random public numbers locate accounts without exposing login emails or UUIDs.
      for (;;) {
        const number = String(randomInt(1_000_000_000, 10_000_000_000));
        const inserted = db.prepare('INSERT OR IGNORE INTO community_accounts(user_id,account_number) VALUES(?,?)').run(userId, number);
        if (inserted.changes || db.prepare('SELECT 1 FROM community_accounts WHERE user_id=?').get(userId)) break;
      }
    }
    return db.prepare('SELECT * FROM community_profiles WHERE user_id=?').get(userId);
  }
  function author(userId, viewerId) {
    const row = userId && ensureProfile(userId);
    if (!row) return { id: null, nickname: '已注销用户', accountNumber: null, avatarUrl: null, bio: '', followed: false };
    return { id: row.user_id, nickname: row.nickname, accountNumber: db.prepare('SELECT account_number FROM community_accounts WHERE user_id=?').get(userId).account_number,
      avatarUrl: row.avatar_media_id ? `/api/community/media/${encodeURIComponent(row.avatar_media_id)}` : null, bio: row.bio,
      followed: Boolean(db.prepare('SELECT 1 FROM community_follows WHERE user_id=? AND target_user_id=?').get(viewerId, userId)) };
  }
  function profile(userId, viewer) {
    const row = ensureProfile(userId);
    if (!row) throw new HttpError(404, '社区用户不存在。');
    const count = (sql, ...args) => db.prepare(sql).get(...args).count;
    const receivedLikeCount = count("SELECT COUNT(*) AS count FROM community_note_likes l JOIN community_notes n ON n.id=l.note_id WHERE n.user_id=? AND n.status='published'", userId);
    const receivedCollectionCount = count("SELECT COUNT(*) AS count FROM community_collections c JOIN community_notes n ON n.id=c.note_id WHERE n.user_id=? AND n.status='published'", userId);
    return { ...author(userId, viewer.id), isSelf: userId === viewer.id, isModerator: userId === viewer.id && isModerator(viewer),
      collectionsVisibility: row.collections_visibility,
      followerCount: count('SELECT COUNT(*) AS count FROM community_follows WHERE target_user_id=?', userId),
      followingCount: count('SELECT COUNT(*) AS count FROM community_follows WHERE user_id=?', userId),
      noteCount: count("SELECT COUNT(*) AS count FROM community_notes WHERE user_id=? AND status='published'", userId),
      receivedLikeCount, receivedCollectionCount, receivedEngagementCount: receivedLikeCount + receivedCollectionCount };
  }
  function noteRow(id, user, management = false) {
    const row = db.prepare('SELECT * FROM community_notes WHERE id=?').get(id);
    if (!row || row.status === 'deleted' || (row.status !== 'published' && !(management && (row.user_id === user.id || isModerator(user))))) throw unavailable();
    return row;
  }
  function noteCounts(id, userId) {
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM community_note_likes WHERE note_id=?) AS likeCount,
      (SELECT COUNT(*) FROM community_collections WHERE note_id=?) AS collectionCount,
      (SELECT COUNT(*) FROM community_comments WHERE note_id=? AND status='published') AS commentCount,
      EXISTS(SELECT 1 FROM community_note_likes WHERE note_id=? AND user_id=?) AS liked,
      EXISTS(SELECT 1 FROM community_collections WHERE note_id=? AND user_id=?) AS collected`).get(id, id, id, id, userId, id, userId);
  }
  function noteDto(row, user, management = false) {
    const managementKind = management ? row.user_id === user.id ? 'mine' : 'moderation' : 'normal';
    const items = db.prepare('SELECT * FROM community_note_media WHERE note_id=? ORDER BY position,media_id').all(row.id).map(item => ({
      ...media.getMediaDto(item.media_id, { management: managementKind }), role: item.role, isCover: Boolean(item.is_cover)
    }));
    const counts = noteCounts(row.id, user.id);
    return { id: row.id, type: row.type, title: row.title, body: row.body, category: row.category, visibility: row.visibility,
      topics: db.prepare('SELECT t.name FROM community_topics t JOIN community_note_topics nt ON nt.topic_id=t.id WHERE nt.note_id=? ORDER BY nt.position').all(row.id).map(item => item.name),
      media: items, cover: items.find(item => item.isCover) ?? items.find(item => item.role !== 'video') ?? null,
      author: author(row.user_id, user.id), ...counts, liked: Boolean(counts.liked), collected: Boolean(counts.collected),
      createdAt: row.created_at, updatedAt: row.updated_at, version: row.version, status: row.status,
      ...(management ? { moderationReason: row.moderation_reason } : {}) };
  }
  function commentRow(id, user, management = false) {
    const row = db.prepare('SELECT * FROM community_comments WHERE id=?').get(id);
    if (!row || row.status !== 'published' && !(management && row.status === 'hidden')) throw commentUnavailable();
    noteRow(row.note_id, user, management);
    return row;
  }
  function commentDto(row, user, { previews = false, management = false } = {}) {
    const visible = row.status === 'published' || management && row.status === 'hidden';
    const likeCount = visible ? db.prepare('SELECT COUNT(*) AS count FROM community_comment_likes WHERE comment_id=?').get(row.id).count : 0;
    const replyRows = row.parent_id ? [] : db.prepare("SELECT * FROM community_comments WHERE parent_id=? AND status='published' ORDER BY created_at,id").all(row.id);
    const owner = db.prepare('SELECT user_id FROM community_notes WHERE id=?').get(row.note_id)?.user_id;
    const replyTo = row.reply_to_user_id ? author(row.reply_to_user_id, user.id) : null;
    return { id: row.id, noteId: row.note_id, author: author(row.user_id, user.id), body: visible ? row.body : '',
      images: visible ? media.attachmentImages('comment', row.id, { management: management ? isModerator(user) ? 'moderation' : 'mine' : 'normal' }) : [],
      createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, deleted: !visible,
      parentId: row.parent_id, topLevelCommentId: row.parent_id ?? row.id,
      replyToUser: replyTo ? { id: replyTo.id, nickname: replyTo.nickname } : null,
      likeCount, liked: visible && Boolean(db.prepare('SELECT 1 FROM community_comment_likes WHERE user_id=? AND comment_id=?').get(user.id, row.id)),
      canDelete: row.status !== 'deleted' && (row.user_id === user.id || owner === user.id), replyCount: replyRows.length,
      replies: previews ? replyRows.slice(0, 2).map(item => commentDto(item, user)) : [],
      ...(management ? { moderationReason: row.moderation_reason } : {}) };
  }
  function throttle(userId, operation, maximum, windowMs) {
    const time = Date.now();
    let row = db.prepare('SELECT * FROM community_rate_limits WHERE user_id=? AND operation=?').get(userId, operation);
    if (!row || row.reset_at <= time) row = { count: 0, reset_at: time + windowMs };
    if (row.count >= maximum) {
      const seconds = Math.max(1, Math.ceil((row.reset_at - time) / 1000));
      const error = new HttpError(429, `操作过于频繁，请 ${seconds} 秒后重试。`); error.retryAfter = seconds; throw error;
    }
    db.prepare('INSERT INTO community_rate_limits(user_id,operation,count,reset_at) VALUES(?,?,?,?) ON CONFLICT(user_id,operation) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at').run(userId, operation, row.count + 1, row.reset_at);
  }
  const groups = createCommunityGroups({ db, author, transactionFor, throttle, readBody, send, media });
  const messages = createCommunityMessages({ db, author, transactionFor, throttle, readBody, send, media,
    additionalUnreadCount: userId => groups.unreadCount(userId) });
  function mutate(user, operation, body, status, callback, required = true) {
    const id = mutationId(body, required);
    const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
    return transactionFor(user, () => {
      if (id) {
        const existing = db.prepare('SELECT * FROM community_mutations WHERE user_id=? AND operation=? AND mutation_id=?').get(user.id, operation, id);
        if (existing) {
          if (existing.request_hash !== requestHash) throw new HttpError(409, '此请求唯一键已用于其他内容，请保留原请求重试。');
          const result = JSON.parse(existing.result);
          // Receipts confirm a write; they never revive removed content or media.
          if (result.note) result.note = noteDto(noteRow(result.note.id, user, true), user, true);
          if (result.comment) {
            const comment = commentRow(result.comment.id, user);
            result.comment = commentDto(comment, user);
            result.commentCount = noteCounts(comment.note_id, user.id).commentCount;
          }
          if (result.report && operation.startsWith('moderate:')) {
            const report = db.prepare('SELECT * FROM community_reports WHERE id=?').get(result.report.id);
            if (!report) throw new HttpError(404, '举报内容已删除或不可见。');
            result.report = reportDto(report, user, true);
            if (!result.report.target) throw new HttpError(404, '举报内容已删除或不可见。');
          }
          return { status: existing.status, body: result };
        }
      }
      const result = callback();
      if (id) db.prepare('INSERT INTO community_mutations(user_id,operation,mutation_id,request_hash,result,status,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id, operation, id, requestHash, JSON.stringify(result), status, now());
      return { status, body: result };
    });
  }
  function notify({ recipient, actorId, type, noteId = null, rootId = null, targetId = null, key, reason = '' }) {
    if (!recipient || recipient === actorId) return;
    const time = now();
    db.prepare(`INSERT INTO community_notifications(id,user_id,actor_id,type,note_id,top_level_comment_id,target_comment_id,dedup_key,reason,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,dedup_key) DO UPDATE SET updated_at=excluded.updated_at,reason=excluded.reason`).run(randomUUID(), recipient, actorId, type, noteId, rootId, targetId, key, reason, time, time);
  }
  function paginate(user, params, scope, loadIds, readItem) {
    const limit = limitValue(params);
    const cursor = params.get('cursor');
    let snapshot, offset = 0;
    if (cursor) {
      let parsed;
      try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new HttpError(400, '分页游标无效。'); }
      if (typeof parsed?.id !== 'string' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new HttpError(400, '分页游标无效。');
      snapshot = db.prepare('SELECT * FROM community_snapshots WHERE id=? AND user_id=? AND scope=?').get(parsed.id, user.id, scope);
      if (!snapshot) throw new HttpError(400, '分页游标与当前账号或筛选条件不匹配。');
      if (snapshot.expires_at <= Date.now()) throw new HttpError(409, '本轮列表已过期，请刷新后继续浏览。');
      offset = parsed.offset;
    } else {
      db.prepare('DELETE FROM community_snapshots WHERE expires_at<=?').run(Date.now());
      snapshot = { id: randomUUID(), ids: JSON.stringify(loadIds()), expires_at: Date.now() + SNAPSHOT_TTL };
      db.prepare('INSERT INTO community_snapshots(id,user_id,scope,ids,expires_at) VALUES(?,?,?,?,?)').run(snapshot.id, user.id, scope, snapshot.ids, snapshot.expires_at);
    }
    const ids = JSON.parse(snapshot.ids);
    if (offset > ids.length) throw new HttpError(400, '分页游标超出列表范围。');
    const items = [];
    while (offset < ids.length && items.length < limit) {
      const item = readItem(ids[offset++]);
      if (item !== null) items.push(item);
    }
    const hasMore = ids.slice(offset).some(id => readItem(id) !== null);
    return { items, nextCursor: hasMore ? Buffer.from(JSON.stringify({ id: snapshot.id, offset })).toString('base64url') : null, hasMore };
  }
  function noteList(user, params, scope, sql, args = [], management = false, recommended = false) {
    let eligible;
    return paginate(user, params, scope, () => {
      let rows = db.prepare(sql).all(...args);
      if (recommended) {
        const newest = [...rows];
        const scores = new Map(rows.map(row => {
          const counts = noteCounts(row.id, user.id);
          return [row.id, (counts.likeCount * 2 + counts.collectionCount * 3 + counts.commentCount * 4 + 1) / Math.sqrt(Math.max(0, (Date.now() - Date.parse(row.created_at)) / 3600000) + 8)];
        }));
        const ranked = [...rows].sort((a, b) => scores.get(b.id) - scores.get(a.id) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        const seen = new Set(); rows = [];
        while (ranked.length || newest.length) {
          for (const source of [ranked, ranked, newest]) {
            while (source.length && seen.has(source[0].id)) source.shift();
            const row = source.shift();
            if (row) { seen.add(row.id); rows.push(row); }
          }
        }
        // Interleave categories while retaining the ranked candidates.
        for (let index = 2; index < rows.length; index++) if (rows[index].category === rows[index - 1].category && rows[index].category === rows[index - 2].category) {
          const alternate = rows.findIndex((row, candidate) => candidate > index && row.category !== rows[index].category);
          if (alternate !== -1) rows.splice(index, 0, rows.splice(alternate, 1)[0]);
        }
      }
      return rows.map(row => row.id);
    }, id => {
      // A snapshot freezes order, never continuing visibility or relationships.
      eligible ??= new Set(db.prepare(sql).all(...args).map(row => row.id));
      if (!eligible.has(id)) return null;
      const row = db.prepare('SELECT * FROM community_notes WHERE id=?').get(id);
      if (!row || row.status === 'deleted' || row.status !== 'published' && !(management && row.user_id === user.id)) return null;
      return noteDto(row, user, management);
    });
  }
  const normalizeSearch = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  function searchUsers(user, params, query) {
    const rank = row => {
      const nickname = normalizeSearch(row.nickname);
      if (row.account_number === query) return 1000;
      if (nickname === query) return 500;
      if (nickname.startsWith(query)) return 300;
      return nickname.includes(query) ? 100 : 0;
    };
    return paginate(user, params, JSON.stringify(['search', 'users', query]), () => {
      // A registered account is searchable even before its first community visit.
      for (const row of db.prepare('SELECT id FROM users').all()) ensureProfile(row.id);
      const rows = db.prepare(`SELECT p.user_id,p.nickname,a.account_number,u.created_at
        FROM community_profiles p JOIN users u ON u.id=p.user_id JOIN community_accounts a ON a.user_id=p.user_id`).all();
      return rows.map(row => ({ ...row, rank: rank(row) })).filter(row => row.rank)
        .sort((a, b) => b.rank - a.rank || b.created_at.localeCompare(a.created_at) || a.user_id.localeCompare(b.user_id)).map(row => row.user_id);
    }, id => {
      const row = db.prepare('SELECT p.*,a.account_number FROM community_profiles p JOIN community_accounts a ON a.user_id=p.user_id JOIN users u ON u.id=p.user_id WHERE p.user_id=?').get(id);
      return row && rank(row) ? profile(id, user) : null;
    });
  }
  function searchNotes(user, params, query, category, sort) {
    const tokens = query.split(' ').filter(Boolean);
    const topics = id => db.prepare('SELECT t.name FROM community_topics t JOIN community_note_topics nt ON nt.topic_id=t.id WHERE nt.note_id=? ORDER BY nt.position').all(id).map(row => normalizeSearch(row.name));
    const rank = row => {
      const title = normalizeSearch(row.title), body = normalizeSearch(row.body), names = topics(row.id);
      const all = [title, body, ...names].join(' ');
      if (!tokens.every(token => all.includes(token))) return 0;
      let score = title === query ? 1000 : title.startsWith(query) ? 500 : title.includes(query) ? 300 : 0;
      score += names.some(name => name === query) ? 350 : names.some(name => name.includes(query)) ? 200 : 0;
      if (body.includes(query)) score += 80;
      for (const token of tokens) score += (title.includes(token) ? 20 : 0) + (names.some(name => name.includes(token)) ? 15 : 0) + (body.includes(token) ? 3 : 0);
      return score || 1;
    };
    return paginate(user, params, JSON.stringify(['search', 'notes', query, category ?? 'all', sort]), () => {
      const rows = db.prepare(`SELECT * FROM community_notes WHERE status='published' ${category && category !== 'all' ? 'AND category=?' : ''}`).all(...(category && category !== 'all' ? [category] : []));
      return rows.map(row => ({ ...row, rank: rank(row) })).filter(row => row.rank)
        .sort((a, b) => (sort === 'relevance' ? b.rank - a.rank : 0) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map(row => row.id);
    }, id => {
      const row = db.prepare("SELECT * FROM community_notes WHERE id=? AND status='published'").get(id);
      if (!row || category && category !== 'all' && row.category !== category || !rank(row)) return null;
      return noteDto(row, user);
    });
  }
  function validateNote(body, user, existing) {
    const title = text(body.title, 40, '标题', true);
    const content = text(body.body ?? '', 2000, '正文');
    const category = CATEGORY_ALIASES[body.category] ?? body.category;
    if (!CATEGORIES.has(category)) throw new HttpError(400, '请选择训练、饮食、打卡、经验或提问分类。');
    if (body.visibility !== undefined && body.visibility !== 'members') throw new HttpError(400, '社区笔记仅向所有已登录社区用户展示。');
    if (!Array.isArray(body.topics ?? []) || (body.topics ?? []).length > 5) throw new HttpError(400, '每篇笔记最多选择 5 个话题。');
    const topics = [...new Set((body.topics ?? []).map(value => text(value, 20, '话题', true).replace(/^#/, '').normalize('NFKC').toLowerCase()))];
    if (topics.some(value => !value || length(value) > 20)) throw new HttpError(400, '话题不能为空且最多 20 字。');
    if (!Array.isArray(body.media ?? []) || (body.media ?? []).length > 10) throw new HttpError(400, '媒体素材列表无效。');
    const mediaItems = (body.media ?? []).map(item => {
      if (!item || typeof item.id !== 'string') throw new HttpError(400, '媒体素材 ID 无效。');
      return { id: item.id, role: item.role ?? (body.type === 'video' ? item.type?.startsWith('video/') ? 'video' : 'video-cover' : 'image'), isCover: body.coverMediaId !== undefined ? item.id === body.coverMediaId : Boolean(item.isCover) };
    });
    if (body.coverMediaId && !mediaItems.some(item => item.id === body.coverMediaId)) throw new HttpError(400, '封面必须属于本篇笔记。');
    if (mediaItems.length && !mediaItems.some(item => item.isCover)) {
      const cover = mediaItems.find(item => item.role === 'video-cover') ?? mediaItems.find(item => item.role === 'image');
      if (cover) cover.isCover = true;
    }
    if (mediaItems.filter(item => item.isCover).length > 1) throw new HttpError(400, '只能指定一张封面。');
    if (mediaItems.some(item => item.isCover && item.role === 'video')) throw new HttpError(400, '视频封面必须使用独立的图片素材。');
    const videos = mediaItems.filter(item => item.role === 'video').length;
    const images = mediaItems.filter(item => item.role === 'image').length;
    const videoCovers = mediaItems.filter(item => item.role === 'video-cover').length;
    const type = videos ? 'video' : images ? 'image' : 'text';
    if (videos && (videos !== 1 || videoCovers !== 1 || images)) throw new HttpError(400, '短视频需要 1 个视频和 1 张独立封面，不可混用图文素材。');
    if (!videos && (images > 9 || videoCovers)) throw new HttpError(400, '图文笔记最多 9 张图片。');
    if (!mediaItems.length && !content) throw new HttpError(400, '纯文字笔记必须填写正文。');
    if (body.type !== undefined && !['text', 'image', 'video'].includes(body.type)) throw new HttpError(400, '笔记类型无效。');
    if (body.type === 'video' && !videos || body.type === 'text' && mediaItems.length) throw new HttpError(400, '笔记类型和素材不匹配。');
    media.verifyForNote(user.id, mediaItems, existing?.id);
    return { title, content, category, topics, mediaItems, type };
  }
  function bindTopics(noteId, topics) {
    db.prepare('DELETE FROM community_note_topics WHERE note_id=?').run(noteId);
    topics.forEach((name, position) => {
      db.prepare('INSERT OR IGNORE INTO community_topics(id,name) VALUES(?,?)').run(randomUUID(), name);
      const topic = db.prepare('SELECT id FROM community_topics WHERE name=?').get(name);
      db.prepare('INSERT INTO community_note_topics(note_id,topic_id,position) VALUES(?,?,?)').run(noteId, topic.id, position);
    });
  }
  function notificationDto(row, user) {
    const note = row.note_id ? db.prepare('SELECT * FROM community_notes WHERE id=? AND status=\'published\'').get(row.note_id) : null;
    const target = row.target_comment_id ? db.prepare("SELECT * FROM community_comments WHERE id=? AND status='published'").get(row.target_comment_id) : null;
    const available = row.type === 'follow' ? Boolean(row.actor_id && ensureProfile(row.actor_id)) : Boolean(note && (!row.target_comment_id || target));
    const coverRow = available && note ? db.prepare("SELECT m.* FROM community_media m JOIN community_note_media nm ON nm.media_id=m.id WHERE nm.note_id=? AND nm.role!='video' AND m.status='ready' ORDER BY nm.is_cover DESC,nm.position LIMIT 1").get(note.id) : null;
    return { id: row.id, type: row.type, actor: row.actor_id ? author(row.actor_id, user.id) : null, noteId: row.note_id,
      topLevelCommentId: row.top_level_comment_id, targetCommentId: row.target_comment_id,
      preview: available && note ? { title: note.title, body: target?.body ?? '', cover: coverRow ? media.getMediaDto(coverRow) : null } : null,
      available, unavailableReason: available ? null : '相关内容已不可见', read: Boolean(row.read), createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.reason ? { reason: row.reason } : {}) };
  }
  function unreadCount(userId) { return db.prepare('SELECT COUNT(*) AS count FROM community_notifications WHERE user_id=? AND read=0').get(userId).count; }
  function reportDto(row, user, includeTarget = false) {
    let target = null;
    if (includeTarget) {
      const note = row.target_type === 'note' ? db.prepare("SELECT * FROM community_notes WHERE id=? AND status!='deleted'").get(row.target_id) : null;
      const comment = row.target_type === 'comment' ? db.prepare("SELECT * FROM community_comments WHERE id=? AND status!='deleted'").get(row.target_id) : null;
      if (note) target = { note: noteDto(note, user, true) };
      if (comment) {
        const parentNote = db.prepare("SELECT * FROM community_notes WHERE id=? AND status!='deleted'").get(comment.note_id);
        if (parentNote) target = { comment: commentDto(comment, user, { management: true }), note: noteDto(parentNote, user, true) };
      }
    }
    return { id: row.id, targetType: row.target_type, targetId: row.target_id, reason: row.reason, description: row.description,
      status: row.status, result: row.result, moderationReason: row.moderation_reason, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
      ...(includeTarget ? { reporter: author(row.user_id, user.id), target } : {}) };
  }

  async function handle(req, res, user, pathname) {
    if (!pathname.startsWith('/api/community/')) return false;
    isModerator(user);
    if (await media.handle(req, res, user, pathname)) return true;
    const method = req.method;
    const path = pathname.slice('/api/community'.length);
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (await groups.handle(req, res, user, path, params)) return true;
    if (await messages.handle(req, res, user, path, params)) return true;
    const reply = (status, body) => { send(res, status, body); return true; };
    const writeResult = result => reply(result.status, result.body);
    let match;

    if (path === '/feed' && method === 'GET') {
      const channel = params.get('channel') ?? 'recommended';
      if (!['recommended', 'recommend', 'following'].includes(channel)) throw new HttpError(400, '信息流频道无效。');
      const category = CATEGORY_ALIASES[params.get('category')] ?? params.get('category');
      if (category && category !== 'all' && !CATEGORIES.has(category)) throw new HttpError(400, '分类无效。');
      let sql = "SELECT n.* FROM community_notes n WHERE n.status='published'"; const args = [];
      if (channel === 'following') { sql += ' AND EXISTS(SELECT 1 FROM community_follows f WHERE f.user_id=? AND f.target_user_id=n.user_id)'; args.push(user.id); }
      if (category && category !== 'all') { sql += ' AND n.category=?'; args.push(category); }
      sql += ' ORDER BY n.created_at DESC,n.id DESC';
      return reply(200, noteList(user, params, JSON.stringify(['feed', channel, category ?? 'all']), sql, args, false, channel !== 'following'));
    }
    if (path === '/search' && method === 'GET') {
      const query = normalizeSearch(text(params.get('q') ?? '', 100, '搜索词', true));
      const type = params.get('type') ?? 'notes', sort = params.get('sort') ?? 'relevance';
      if (!['notes', 'users'].includes(type)) throw new HttpError(400, '搜索类型应为 notes 或 users。');
      if (!['relevance', 'latest'].includes(sort)) throw new HttpError(400, '搜索排序应为 relevance 或 latest。');
      if (type === 'users') return reply(200, searchUsers(user, params, query));
      const category = CATEGORY_ALIASES[params.get('category')] ?? params.get('category');
      if (category && category !== 'all' && !CATEGORIES.has(category)) throw new HttpError(400, '分类无效。');
      return reply(200, searchNotes(user, params, query, category, sort));
    }
    if (path === '/topics' && method === 'GET') {
      const query = text(params.get('q') ?? '', 20, '话题搜索词').normalize('NFKC').toLowerCase();
      const items = db.prepare(`SELECT t.id,t.name FROM community_topics t WHERE instr(t.name,?)>0 AND EXISTS(SELECT 1 FROM community_note_topics nt JOIN community_notes n ON n.id=nt.note_id WHERE nt.topic_id=t.id AND n.status='published') ORDER BY t.name LIMIT 20`).all(query);
      return reply(200, { items });
    }
    if (path === '/notes' && method === 'POST') {
      const body = await readBody(req, 64000);
      return writeResult(mutate(user, 'create-note', body, 201, () => {
        throttle(user.id, 'publish', 20, 60 * 60 * 1000);
        const values = validateNote(body, user);
        const id = randomUUID(), time = now();
        db.prepare('INSERT INTO community_notes(id,user_id,type,title,body,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, user.id, values.type, values.title, values.content, values.category, time, time);
        media.bindNote(id, values.mediaItems); bindTopics(id, values.topics);
        return { note: noteDto(noteRow(id, user), user, true) };
      }));
    }
    if ((match = path.match(/^\/notes\/([^/]+)$/))) {
      const id = match[1];
      if (method === 'GET') return reply(200, { note: noteDto(noteRow(id, user), user) });
      if (method === 'PATCH' || method === 'DELETE') {
        const body = await readBody(req, 64000);
        const result = mutate(user, `${method.toLowerCase()}-note:${id}`, body, 200, () => {
          const row = noteRow(id, user, true);
          if (row.user_id !== user.id) throw new HttpError(403, '只能管理自己的笔记。');
          if (versionValue(body) !== row.version) throw new HttpError(409, '笔记版本已更新，请重新读取并保留本地修改。');
          if (method === 'DELETE') {
            db.prepare("UPDATE community_notes SET status='deleted',body='',title='',updated_at=?,version=version+1 WHERE id=?").run(now(), id);
            return { ok: true };
          }
          const values = validateNote(body, user, row);
          db.prepare('UPDATE community_notes SET type=?,title=?,body=?,category=?,updated_at=?,version=version+1 WHERE id=?').run(values.type, values.title, values.content, values.category, now(), id);
          media.bindNote(id, values.mediaItems); bindTopics(id, values.topics);
          return { note: noteDto(noteRow(id, user, true), user, true) };
        }, false);
        if (method === 'DELETE') { await media.deleteNoteMedia(id); await media.cleanupExpired(); }
        return writeResult(result);
      }
    }
    if ((match = path.match(/^\/notes\/([^/]+)\/(like|collection)$/)) && method === 'PUT') {
      const body = await readBody(req, 2000); const active = activeValue(body);
      return reply(200, transactionFor(user, () => {
        const note = noteRow(match[1], user);
        const table = match[2] === 'like' ? 'community_note_likes' : 'community_collections';
        if (active) {
          const created = db.prepare(`INSERT OR IGNORE INTO ${table}(user_id,note_id,created_at) VALUES(?,?,?)`).run(user.id, note.id, now()).changes;
          if (created) notify({ recipient: note.user_id, actorId: user.id, type: match[2], noteId: note.id, key: `${match[2]}:${user.id}:${note.id}` });
        } else db.prepare(`DELETE FROM ${table} WHERE user_id=? AND note_id=?`).run(user.id, note.id);
        const counts = noteCounts(note.id, user.id);
        return { active, ...counts, liked: Boolean(counts.liked), collected: Boolean(counts.collected) };
      }));
    }
    if ((match = path.match(/^\/notes\/([^/]+)\/comments$/))) {
      const note = noteRow(match[1], user);
      if (method === 'GET') {
        const requestedSort = params.get('sort') ?? 'latest';
        const sort = requestedSort === 'popular' ? 'hot' : requestedSort;
        if (!['latest', 'hot'].includes(sort)) throw new HttpError(400, '评论排序无效。');
        const result = paginate(user, params, JSON.stringify(['comments', note.id, sort]), () => db.prepare(`SELECT c.id FROM community_comments c WHERE c.note_id=? AND c.parent_id IS NULL AND (c.status='published' OR EXISTS(SELECT 1 FROM community_comments r WHERE r.parent_id=c.id AND r.status='published')) ORDER BY ${sort === 'hot' ? '(SELECT COUNT(*) FROM community_comment_likes l WHERE l.comment_id=c.id) DESC,' : ''} c.created_at DESC,c.id DESC`).all(note.id).map(row => row.id), id => {
          const row = db.prepare('SELECT * FROM community_comments WHERE id=?').get(id);
          if (!row || row.status !== 'published' && !db.prepare("SELECT 1 FROM community_comments WHERE parent_id=? AND status='published'").get(id)) return null;
          return commentDto(row, user, { previews: true });
        });
        return reply(200, { ...result, commentCount: noteCounts(note.id, user.id).commentCount });
      }
      if (method === 'POST') {
        const body = await readBody(req, 10000);
        body.body = body.body === undefined ? '' : body.body;
        const imageIds = attachmentImageIds(body.imageIds);
        if (!imageIds.length) delete body.imageIds;
        return writeResult(mutate(user, `comment:${note.id}`, body, 201, () => {
          // Reading a streaming request can outlive a deletion or moderation.
          // Recheck inside the same transaction that creates the comment.
          noteRow(note.id, user);
          throttle(user.id, 'comment', 60, 10 * 60 * 1000);
          const content = text(body.body, 500, '评论');
          if (!content && !imageIds.length) throw new HttpError(400, '文字和图片不能同时为空。');
          const images = media.verifyForAttachment(user.id, imageIds);
          const targetId = body.replyToCommentId ?? body.parentId;
          let root = null, target = null;
          if (targetId) {
            if (typeof targetId !== 'string') throw new HttpError(400, '回复目标无效。');
            target = commentRow(targetId, user);
            if (target.note_id !== note.id) throw new HttpError(400, '回复目标不属于此笔记。');
            root = target.parent_id ?? target.id;
            if (body.parentId && body.parentId !== root && body.parentId !== target.id) throw new HttpError(400, '顶层评论与回复目标不匹配。');
          }
          const id = randomUUID(), time = now();
          db.prepare('INSERT INTO community_comments(id,note_id,user_id,parent_id,reply_to_user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, note.id, user.id, root, target?.user_id ?? null, content, time, time);
          media.bindAttachment('comment', id, images);
          if (target) notify({ recipient: target.user_id, actorId: user.id, type: 'reply', noteId: note.id, rootId: root, targetId: id, key: `reply:${id}` });
          if (note.user_id !== target?.user_id) notify({ recipient: note.user_id, actorId: user.id, type: root ? 'reply' : 'comment', noteId: note.id, rootId: root ?? id, targetId: id, key: `comment:${id}` });
          return { comment: commentDto(db.prepare('SELECT * FROM community_comments WHERE id=?').get(id), user), commentCount: noteCounts(note.id, user.id).commentCount };
        }));
      }
    }
    if ((match = path.match(/^\/comments\/([^/]+)\/(replies|context|like)$/))) {
      const id = match[1], action = match[2];
      if (action === 'replies' && method === 'GET') {
        const root = db.prepare('SELECT * FROM community_comments WHERE id=? AND parent_id IS NULL').get(id);
        if (!root) throw commentUnavailable(); noteRow(root.note_id, user);
        return reply(200, paginate(user, params, JSON.stringify(['replies', id]), () => db.prepare("SELECT id FROM community_comments WHERE parent_id=? AND status='published' ORDER BY created_at,id").all(id).map(row => row.id), replyId => {
          const row = db.prepare("SELECT * FROM community_comments WHERE id=? AND status='published'").get(replyId);
          return row ? commentDto(row, user) : null;
        }));
      }
      if (action === 'context' && method === 'GET') {
        const target = commentRow(id, user);
        const root = target.parent_id ? db.prepare('SELECT * FROM community_comments WHERE id=?').get(target.parent_id) : target;
        const replies = db.prepare("SELECT * FROM community_comments WHERE parent_id=? AND status='published' ORDER BY created_at,id").all(root.id);
        const index = replies.findIndex(row => row.id === target.id);
        const start = Math.max(0, index - 10), selected = replies.slice(start, start + 20);
        return reply(200, { noteId: target.note_id, topLevelComment: commentDto(root, user), targetComment: commentDto(target, user), replies: selected.map(row => commentDto(row, user)), hasEarlierReplies: start > 0, hasLaterReplies: start + 20 < replies.length });
      }
      if (action === 'like' && method === 'PUT') {
        const active = activeValue(await readBody(req, 2000));
        return reply(200, transactionFor(user, () => {
          const comment = commentRow(id, user);
          if (active) {
            const created = db.prepare('INSERT OR IGNORE INTO community_comment_likes(user_id,comment_id,created_at) VALUES(?,?,?)').run(user.id, id, now()).changes;
            if (created) notify({ recipient: comment.user_id, actorId: user.id, type: 'like', noteId: comment.note_id,
              rootId: comment.parent_id ?? comment.id, targetId: comment.id, key: `comment-like:${user.id}:${id}` });
          }
          else db.prepare('DELETE FROM community_comment_likes WHERE user_id=? AND comment_id=?').run(user.id, id);
          const value = commentDto(comment, user); return { active, liked: value.liked, likeCount: value.likeCount };
        }));
      }
    }
    if ((match = path.match(/^\/comments\/([^/]+)$/)) && method === 'DELETE') {
      const body = await readBody(req, 2000);
      const result = mutate(user, `delete-comment:${match[1]}`, body, 200, () => {
        const row = db.prepare('SELECT * FROM community_comments WHERE id=?').get(match[1]);
        if (!row) throw commentUnavailable(); const note = noteRow(row.note_id, user);
        if (row.user_id !== user.id && note.user_id !== user.id) throw new HttpError(403, '无权删除此评论。');
        db.prepare("UPDATE community_comments SET status='deleted',body='',updated_at=? WHERE id=?").run(now(), row.id);
        db.prepare('DELETE FROM community_comment_likes WHERE comment_id=?').run(row.id);
        return { ok: true, commentCount: noteCounts(note.id, user.id).commentCount };
      }, false);
      await media.cleanupExpired();
      return writeResult(result);
    }
    if ((match = path.match(/^\/users\/([^/]+)(?:\/(notes|follow|collections))?$/))) {
      const id = match[1];
      const userProfile = ensureProfile(id);
      if (!userProfile) throw new HttpError(404, '社区用户不存在。');
      if (!match[2] && method === 'GET') return reply(200, { profile: profile(id, user) });
      if (match[2] === 'notes' && method === 'GET') return reply(200, noteList(user, params, JSON.stringify(['author', id]), "SELECT * FROM community_notes WHERE user_id=? AND status='published' ORDER BY created_at DESC,id DESC", [id]));
      if (match[2] === 'collections' && method === 'GET') {
        // Check current ownership/visibility before consuming any saved cursor.
        if (id !== user.id && userProfile.collections_visibility !== 'public') return reply(403, { error: '该用户的收藏仅自己可见。', code: 'collections_private' });
        return reply(200, noteList(user, params, JSON.stringify(['user-collections', id]), "SELECT n.* FROM community_notes n JOIN community_collections c ON c.note_id=n.id WHERE c.user_id=? AND n.status='published' ORDER BY c.created_at DESC,n.id DESC", [id]));
      }
      if (match[2] === 'follow' && method === 'PUT') {
        const active = activeValue(await readBody(req, 2000));
        if (id === user.id) throw new HttpError(400, '不能关注自己。');
        return reply(200, transactionFor(user, () => {
          if (!ensureProfile(id)) throw new HttpError(404, '社区用户不存在。');
          const exists = db.prepare('SELECT 1 FROM community_follows WHERE user_id=? AND target_user_id=?').get(user.id, id);
          if (Boolean(exists) !== active) {
            throttle(user.id, 'follow', 100, 60 * 60 * 1000);
            if (active) {
              db.prepare('INSERT INTO community_follows(user_id,target_user_id,created_at) VALUES(?,?,?)').run(user.id, id, now());
              notify({ recipient: id, actorId: user.id, type: 'follow', key: `follow:${user.id}:${id}` });
            } else db.prepare('DELETE FROM community_follows WHERE user_id=? AND target_user_id=?').run(user.id, id);
          }
          const result = profile(id, user); return { active, followed: active, followerCount: result.followerCount, followingCount: result.followingCount };
        }));
      }
    }
    if (path === '/me/followers' && method === 'GET') {
      return reply(200, paginate(user, params, JSON.stringify(['my-followers', user.id]),
        () => db.prepare('SELECT user_id FROM community_follows WHERE target_user_id=? ORDER BY created_at DESC,user_id DESC').all(user.id).map(row => row.user_id),
        id => db.prepare('SELECT 1 FROM community_follows f JOIN users u ON u.id=f.user_id WHERE f.user_id=? AND f.target_user_id=?').get(id, user.id) ? author(id, user.id) : null));
    }
    if (path === '/me/profile') {
      if (method === 'GET') return reply(200, { profile: profile(user.id, user) });
      if (method === 'PATCH') {
        const body = await readBody(req, 10000);
        return reply(200, transactionFor(user, () => {
          const old = ensureProfile(user.id);
          const nickname = body.nickname === undefined ? old.nickname : text(body.nickname, 20, '社区昵称', true);
          const bio = body.bio === undefined ? old.bio : text(body.bio, 120, '简介');
          const collectionsVisibility = body.collectionsVisibility === undefined ? old.collections_visibility : body.collectionsVisibility;
          if (!['private', 'public'].includes(collectionsVisibility)) throw new HttpError(400, '收藏可见范围应为 private 或 public。');
          if (body.avatarMediaId !== undefined && body.avatarMediaId !== null && typeof body.avatarMediaId !== 'string') throw new HttpError(400, '头像媒体 ID 无效。');
          if (body.avatarMediaId) media.verifyAvatar(user.id, body.avatarMediaId);
          db.prepare('UPDATE community_profiles SET nickname=?,bio=?,collections_visibility=?,updated_at=? WHERE user_id=?').run(nickname, bio, collectionsVisibility, now(), user.id);
          if (collectionsVisibility === 'private' && old.collections_visibility !== 'private') {
            db.prepare('DELETE FROM community_snapshots WHERE scope=? AND user_id!=?').run(JSON.stringify(['user-collections', user.id]), user.id);
          }
          if (body.avatarMediaId !== undefined) media.bindAvatar(user.id, body.avatarMediaId);
          return { profile: profile(user.id, user) };
        }));
      }
    }
    if (path === '/me/notes' && method === 'GET') return reply(200, noteList(user, params, 'mine', "SELECT * FROM community_notes WHERE user_id=? AND status!='deleted' ORDER BY created_at DESC,id DESC", [user.id], true));
    if ((match = path.match(/^\/me\/notes\/([^/]+)$/)) && method === 'GET') {
      const row = noteRow(match[1], user, true);
      if (row.user_id !== user.id) throw unavailable(); return reply(200, { note: noteDto(row, user, true) });
    }
    if (path === '/me/collections' && method === 'GET') return reply(200, noteList(user, params, 'collections', "SELECT n.* FROM community_notes n JOIN community_collections c ON c.note_id=n.id WHERE c.user_id=? AND n.status='published' ORDER BY c.created_at DESC,n.id DESC", [user.id]));
    if (path === '/notifications' && method === 'GET') {
      const type = params.get('type') ?? 'all';
      const types = type === 'comments' ? ['comment', 'reply'] : type === 'engagement' ? ['like', 'collection'] : ['like', 'collection', 'comment', 'reply', 'follow', 'moderation'].includes(type) ? [type] : null;
      if (type !== 'all' && !types) throw new HttpError(400, '通知类型无效。');
      const filter = types ? `AND type IN (${types.map(() => '?').join(',')})` : '';
      const result = paginate(user, params, JSON.stringify(['notifications', type]), () => db.prepare(`SELECT id FROM community_notifications WHERE user_id=? ${filter} ORDER BY updated_at DESC,id DESC`).all(user.id, ...(types ?? [])).map(row => row.id), id => {
        const row = db.prepare('SELECT * FROM community_notifications WHERE id=? AND user_id=?').get(id, user.id);
        return row ? notificationDto(row, user) : null;
      }); return reply(200, { ...result, unreadCount: unreadCount(user.id) });
    }
    if (path === '/notifications/read' && method === 'PUT') {
      const body = await readBody(req, 16000);
      if (body.all !== true && (!Array.isArray(body.ids) || body.ids.length > 200 || body.ids.some(id => typeof id !== 'string'))) throw new HttpError(400, '请指定要标记的通知或 all:true。');
      return reply(200, transactionFor(user, () => {
        if (body.all === true) db.prepare('UPDATE community_notifications SET read=1 WHERE user_id=?').run(user.id);
        else for (const id of new Set(body.ids)) db.prepare('UPDATE community_notifications SET read=1 WHERE id=? AND user_id=?').run(id, user.id);
        return { ok: true, unreadCount: unreadCount(user.id) };
      }));
    }
    if (path === '/reports' && method === 'POST') {
      const body = await readBody(req, 10000);
      return writeResult(mutate(user, 'report', body, 201, () => {
        throttle(user.id, 'report', 20, 60 * 60 * 1000);
        if (!['note', 'comment'].includes(body.targetType) || typeof body.targetId !== 'string' || !REPORT_REASONS.has(body.reason)) throw new HttpError(400, '举报目标或原因无效。');
        if (body.targetType === 'note') noteRow(body.targetId, user); else commentRow(body.targetId, user);
        const description = text(body.description ?? '', 500, '举报说明'); const id = randomUUID(), time = now();
        db.prepare('INSERT INTO community_reports(id,user_id,target_type,target_id,reason,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, user.id, body.targetType, body.targetId, body.reason, description, time, time);
        return { report: reportDto(db.prepare('SELECT * FROM community_reports WHERE id=?').get(id), user) };
      }));
    }
    if (path === '/moderation/reports' && method === 'GET') {
      requireModerator(user); const status = params.get('status') ?? 'open';
      if (!['open', 'resolved', 'all'].includes(status)) throw new HttpError(400, '处理状态无效。');
      return reply(200, paginate(user, params, JSON.stringify(['reports', status]), () => db.prepare(`SELECT id FROM community_reports ${status === 'all' ? '' : 'WHERE status=?'} ORDER BY created_at DESC,id DESC`).all(...(status === 'all' ? [] : [status])).map(row => row.id), id => {
        const row = db.prepare('SELECT * FROM community_reports WHERE id=?').get(id); return row && (status === 'all' || row.status === status) ? reportDto(row, user, true) : null;
      }));
    }
    if ((match = path.match(/^\/moderation\/reports\/([^/]+)$/)) && method === 'PATCH') {
      requireModerator(user); const body = await readBody(req, 10000);
      return writeResult(mutate(user, `moderate:${match[1]}`, body, 200, () => {
        const report = db.prepare('SELECT * FROM community_reports WHERE id=?').get(match[1]);
        if (!report) throw new HttpError(404, '举报记录不存在。');
        if (body.version !== undefined && body.version !== report.version) throw new HttpError(409, '举报处理状态已更新，请重新读取。');
        if (!['keep', 'hide', 'restore'].includes(body.action)) throw new HttpError(400, '处理操作无效。');
        const reason = text(body.reason, 500, '处理原因', true);
        const table = report.target_type === 'note' ? 'community_notes' : 'community_comments';
        const target = db.prepare(`SELECT * FROM ${table} WHERE id=? AND status!='deleted'`).get(report.target_id);
        if (!target) throw new HttpError(404, '举报内容已删除或不可见。');
        if (report.target_type === 'comment') {
          const note = db.prepare("SELECT id FROM community_notes WHERE id=? AND status!='deleted'").get(target.note_id);
          if (!note) throw unavailable();
        }
        const status = body.action === 'hide' ? 'hidden' : body.action === 'restore' ? 'published' : target.status;
        db.prepare(`UPDATE ${table} SET status=?,moderation_reason=?,updated_at=?${report.target_type === 'note' ? ',version=version+1' : ''} WHERE id=?`).run(status, body.action === 'keep' ? target.moderation_reason : reason, now(), target.id);
        db.prepare("UPDATE community_reports SET status='resolved',result=?,moderation_reason=?,moderator_id=?,updated_at=?,version=version+1 WHERE id=?").run(body.action, reason, user.id, now(), report.id);
        const actionId = randomUUID();
        db.prepare('INSERT INTO community_moderation_actions(id,report_id,actor_id,target_type,target_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(actionId, report.id, user.id, report.target_type, report.target_id, body.action, reason, now());
        notify({ recipient: target.user_id, actorId: user.id, type: 'moderation', noteId: report.target_type === 'note' ? target.id : target.note_id,
          rootId: report.target_type === 'comment' ? target.parent_id ?? target.id : null, targetId: report.target_type === 'comment' ? target.id : null,
          key: `moderation:${actionId}`, reason });
        return { report: reportDto(db.prepare('SELECT * FROM community_reports WHERE id=?').get(report.id), user, true) };
      }, false));
    }
    throw new HttpError(404, '社区接口不存在。');
  }

  function exportUser(userId) {
    const viewer = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    return { profile: profile(userId, viewer),
      notes: db.prepare("SELECT * FROM community_notes WHERE user_id=? AND status!='deleted' ORDER BY created_at,id").all(userId).map(row => noteDto(row, viewer, true)),
      comments: db.prepare('SELECT * FROM community_comments WHERE user_id=? ORDER BY created_at,id').all(userId).map(row => ({ id: row.id, noteId: row.note_id, parentId: row.parent_id, body: row.body, images: media.attachmentImages('comment', row.id, { management: 'mine' }), status: row.status, createdAt: row.created_at })),
      likes: db.prepare('SELECT note_id AS noteId,created_at AS createdAt FROM community_note_likes WHERE user_id=?').all(userId),
      commentLikes: db.prepare('SELECT comment_id AS commentId,created_at AS createdAt FROM community_comment_likes WHERE user_id=?').all(userId),
      collections: db.prepare('SELECT note_id AS noteId,created_at AS createdAt FROM community_collections WHERE user_id=?').all(userId),
      follows: db.prepare('SELECT target_user_id AS userId,created_at AS createdAt FROM community_follows WHERE user_id=?').all(userId),
      notifications: db.prepare('SELECT * FROM community_notifications WHERE user_id=? ORDER BY created_at,id').all(userId).map(row => notificationDto(row, viewer)),
      reports: db.prepare('SELECT * FROM community_reports WHERE user_id=? ORDER BY created_at,id').all(userId).map(row => reportDto(row, viewer)),
      media: media.exportUser(userId), privateMessages: messages.exportUser(userId), groups: groups.exportUser(userId) };
  }
  /** Caller runs this together with deleting users in one transaction. */
  function deleteUserData(userId) {
    groups.deleteUserData(userId);
    messages.deleteUserData(userId);
    // Preserve other people's replies as a deleted-parent placeholder.
    db.prepare("UPDATE community_comments SET status='deleted',body='',moderation_reason='',updated_at=? WHERE user_id=?").run(now(), userId);
    db.prepare('DELETE FROM community_comment_likes WHERE comment_id IN (SELECT id FROM community_comments WHERE user_id=?)').run(userId);
    db.prepare("DELETE FROM community_reports WHERE (target_type='note' AND target_id IN (SELECT id FROM community_notes WHERE user_id=?)) OR (target_type='comment' AND target_id IN (SELECT id FROM community_comments WHERE user_id=? OR note_id IN (SELECT id FROM community_notes WHERE user_id=?)))").run(userId, userId, userId);
    db.prepare("DELETE FROM community_mutations WHERE json_extract(result,'$.report.target.note.author.id')=? OR json_extract(result,'$.report.target.comment.author.id')=?").run(userId, userId);
    db.prepare('DELETE FROM community_mutations WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM community_notes WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM community_topics WHERE NOT EXISTS(SELECT 1 FROM community_note_topics nt WHERE nt.topic_id=community_topics.id)').run();
  }
  return { handle, exportUser, deleteUserData, isModerator };
}
