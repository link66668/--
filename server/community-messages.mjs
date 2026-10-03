import { randomUUID } from 'node:crypto';
import { HttpError } from './providers.mjs';
import { attachmentImageIds } from './community-attachments.mjs';

const now = () => new Date().toISOString();
const missing = () => new HttpError(404, '私信会话不存在或无权访问。');
const invalidCursor = () => new HttpError(400, '私信分页游标无效或与当前账号、会话不匹配。');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw invalidCursor(); }
}
function limitValue(params, fallback) {
  const value = params.get('limit');
  const limit = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, '每页数量应为 1–50。');
  return limit;
}

/** Private conversations never use the note feed snapshots or the AI chat records. */
export function createCommunityMessages({ db, author, transactionFor, throttle, readBody, send, media, additionalUnreadCount = () => 0 }) {
  function conversationRow(id, userId) {
    const row = db.prepare(`SELECT c.* FROM community_conversations c
      JOIN users a ON a.id=c.user_a JOIN users b ON b.id=c.user_b
      WHERE c.id=? AND (c.user_a=? OR c.user_b=?)`).get(id, userId, userId);
    if (!row) throw missing();
    return row;
  }
  function messageDto(row) {
    return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id,
      body: row.body, images: media?.attachmentImages('message', row.id) || [], createdAt: row.created_at, clientMutationId: row.client_mutation_id, sequence: row.position };
  }
  function unreadCount(userId, conversationId = null) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM community_messages m
      JOIN community_conversations c ON c.id=m.conversation_id
      LEFT JOIN community_message_reads r ON r.conversation_id=c.id AND r.user_id=?
      WHERE (c.user_a=? OR c.user_b=?) AND m.sender_id<>? AND m.seq>COALESCE(r.last_read_seq,0)
      ${conversationId ? 'AND c.id=?' : ''}`).get(userId, userId, userId, userId, ...(conversationId ? [conversationId] : [])).count;
    return count + (conversationId ? 0 : additionalUnreadCount(userId));
  }
  function conversationDto(row, userId) {
    const peerId = row.user_a === userId ? row.user_b : row.user_a;
    const last = row.last_message_seq ? db.prepare('SELECT * FROM community_messages WHERE conversation_id=? AND seq=?').get(row.id, row.last_message_seq) : null;
    return { id: row.id, self: author(userId, userId), peer: author(peerId, userId), lastMessage: last ? messageDto(last) : null,
      unreadCount: unreadCount(userId, row.id), updatedAt: row.updated_at };
  }
  function messageCursor(value, conversationId, userId, forward = false) {
    // An empty thread still needs an explicit beginning for its first live poll.
    if (forward && value === '0') return 0;
    // A message ID is convenient for polling; opaque cursors also bind viewer and conversation.
    const message = db.prepare('SELECT seq FROM community_messages WHERE id=? AND conversation_id=?').get(value, conversationId);
    if (message) return message.seq;
    const cursor = decode(value);
    if (cursor?.kind !== 'messages' || cursor.userId !== userId || cursor.conversationId !== conversationId ||
      !Number.isSafeInteger(cursor.seq) || cursor.seq < 1 ||
      !db.prepare('SELECT 1 FROM community_messages WHERE conversation_id=? AND seq=?').get(conversationId, cursor.seq)) throw invalidCursor();
    return cursor.seq;
  }
  function cursorFor(row, conversationId, userId) {
    return encode({ kind: 'messages', userId, conversationId, seq: row.seq });
  }
  async function handle(req, res, user, path, params) {
    if (!path.startsWith('/messages')) return false;
    const reply = (status, body) => { send(res, status, body); return true; };
    if (path === '/messages/unread' && req.method === 'GET') return reply(200, { unreadCount: unreadCount(user.id) });
    if (path === '/messages/conversations' && req.method === 'GET') {
      const limit = limitValue(params, 20);
      let cursor;
      if (params.has('cursor')) {
        cursor = decode(params.get('cursor'));
        if (cursor?.kind !== 'conversations' || cursor.userId !== user.id || typeof cursor.id !== 'string' ||
          !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) throw invalidCursor();
        conversationRow(cursor.id, user.id);
      }
      const rows = db.prepare(`SELECT * FROM community_conversations WHERE (user_a=? OR user_b=?)
        ${cursor ? 'AND (last_message_seq<? OR (last_message_seq=? AND id<?))' : ''}
        ORDER BY last_message_seq DESC,id DESC LIMIT ?`).all(user.id, user.id,
          ...(cursor ? [cursor.seq, cursor.seq, cursor.id] : []), limit + 1);
      const hasMore = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
      return reply(200, { items: selected.map(row => conversationDto(row, user.id)), hasMore,
        nextCursor: hasMore ? encode({ kind: 'conversations', userId: user.id, seq: last.last_message_seq, id: last.id }) : null,
        unreadCount: unreadCount(user.id) });
    }
    if (path === '/messages/conversations' && req.method === 'POST') {
      const body = await readBody(req, 2000);
      if (typeof body.userId !== 'string' || !body.userId || body.userId.length > 100) throw new HttpError(400, '请选择私信对象。');
      if (body.userId === user.id) throw new HttpError(400, '不能给自己发送私信。');
      const result = transactionFor(user, () => {
        if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(body.userId)) throw new HttpError(404, '社区用户不存在。');
        const [a, b] = [user.id, body.userId].sort();
        let row = db.prepare('SELECT * FROM community_conversations WHERE user_a=? AND user_b=?').get(a, b);
        if (!row) {
          throttle(user.id, 'message-conversation', 60, 60 * 1000);
          const time = now(), id = randomUUID();
          db.prepare('INSERT INTO community_conversations(id,user_a,user_b,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, a, b, time, time);
          db.prepare('INSERT INTO community_message_reads(conversation_id,user_id) VALUES(?,?),(?,?)').run(id, a, id, b);
          row = conversationRow(id, user.id);
        }
        return { conversation: conversationDto(row, user.id) };
      });
      return reply(200, result);
    }
    const match = path.match(/^\/messages\/conversations\/([^/]+)(?:\/(messages|read))?$/);
    if (!match) throw new HttpError(404, '私信接口不存在。');
    const id = match[1], action = match[2];
    const row = conversationRow(id, user.id);
    if (!action && req.method === 'GET') return reply(200, { conversation: conversationDto(row, user.id) });
    if (action === 'messages' && req.method === 'GET') {
      if (params.has('before') && params.has('after')) throw new HttpError(400, '不能同时指定 before 和 after。');
      const limit = limitValue(params, 30), forward = params.has('after');
      const value = params.get(forward ? 'after' : 'before');
      const cursor = value === null ? null : messageCursor(value, id, user.id, forward);
      const rows = db.prepare(`SELECT * FROM community_messages WHERE conversation_id=?
        ${cursor === null ? '' : `AND seq${forward ? '>' : '<'}?`}
        ORDER BY seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`).all(id, ...(cursor === null ? [] : [cursor]), limit + 1);
      const hasMore = rows.length > limit, selected = rows.slice(0, limit);
      const boundary = selected.at(-1);
      return reply(200, { items: (forward ? selected : selected.reverse()).map(messageDto), hasMore,
        nextCursor: hasMore ? cursorFor(boundary, id, user.id) : null });
    }
    if (action === 'messages' && req.method === 'POST') {
      const body = await readBody(req, 16000);
      const imageIds = attachmentImageIds(body.imageIds), raw = body.body === undefined ? '' : body.body;
      if (typeof raw !== 'string' || raw.includes('\0') || Array.from(raw).length > 1000 || !raw.trim() && !imageIds.length) throw new HttpError(400, '私信最多 1000 字，文字和图片不能同时为空。');
      if (typeof body.clientMutationId !== 'string' || !/^[\w:-]{1,100}$/.test(body.clientMutationId)) throw new HttpError(400, '请提供有效的请求唯一键 clientMutationId。');
      const content = raw.trim();
      const result = transactionFor(user, () => {
        // Recheck participants after reading a slow request body or an account deletion.
        conversationRow(id, user.id);
        const existing = db.prepare('SELECT * FROM community_messages WHERE sender_id=? AND client_mutation_id=?').get(user.id, body.clientMutationId);
        if (existing) {
          if (existing.conversation_id !== id || existing.body !== content || JSON.stringify(media?.attachedImageIds('message', existing.id) || []) !== JSON.stringify(imageIds)) throw new HttpError(409, '此请求唯一键已用于其他私信，请保留原请求重试。');
          return { message: messageDto(existing) };
        }
        throttle(user.id, 'message-send-minute', 60, 60 * 1000);
        throttle(user.id, 'message-send-hour', 1000, 60 * 60 * 1000);
        if (imageIds.length && !media) throw new HttpError(422, '图片附件暂不可用。');
        const images = media?.verifyForAttachment(user.id, imageIds) || [];
        const messageId = randomUUID(), time = now();
        const position = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS value FROM community_messages WHERE conversation_id=?').get(id).value;
        const inserted = db.prepare('INSERT INTO community_messages(id,conversation_id,sender_id,body,client_mutation_id,created_at,position) VALUES(?,?,?,?,?,?,?)').run(messageId, id, user.id, content, body.clientMutationId, time, position);
        media?.bindAttachment('message', messageId, images);
        db.prepare('UPDATE community_conversations SET last_message_seq=?,updated_at=? WHERE id=?').run(Number(inserted.lastInsertRowid), time, id);
        return { message: messageDto(db.prepare('SELECT * FROM community_messages WHERE id=?').get(messageId)) };
      });
      return reply(201, result);
    }
    if (action === 'read' && req.method === 'PUT') {
      const body = await readBody(req, 2000);
      if (typeof body.lastMessageId !== 'string' || !body.lastMessageId) throw new HttpError(400, '请指定已显示的最后一条收到的私信。');
      const result = transactionFor(user, () => {
        conversationRow(id, user.id);
        const last = db.prepare('SELECT seq,sender_id FROM community_messages WHERE id=? AND conversation_id=?').get(body.lastMessageId, id);
        if (!last) throw invalidCursor();
        if (last.sender_id === user.id) throw new HttpError(400, '只能标记收到的私信为已读。');
        db.prepare(`INSERT INTO community_message_reads(conversation_id,user_id,last_read_seq) VALUES(?,?,?)
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_seq=MAX(last_read_seq,excluded.last_read_seq)`).run(id, user.id, last.seq);
        return { unreadCount: unreadCount(user.id), conversationUnreadCount: unreadCount(user.id, id) };
      });
      return reply(200, result);
    }
    throw new HttpError(404, '私信接口不存在。');
  }
  function exportUser(userId) {
    return { conversations: db.prepare('SELECT * FROM community_conversations WHERE user_a=? OR user_b=? ORDER BY created_at,id').all(userId, userId).map(row => ({
      ...conversationDto(row, userId), messages: db.prepare('SELECT * FROM community_messages WHERE conversation_id=? ORDER BY seq').all(row.id).map(messageDto)
    })) };
  }
  function deleteUserData(userId) {
    // A deleted participant removes the private thread and its content for both participants.
    db.prepare('DELETE FROM community_conversations WHERE user_a=? OR user_b=?').run(userId, userId);
  }
  return { handle, exportUser, deleteUserData };
}
