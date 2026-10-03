import { createCommunityGroupsStore } from './community-groups-storage.mjs';
import { upgradeCommunityAttachmentPurpose, createCommunityAttachmentStore } from './community-attachments.mjs';

/** Community data is deliberately separate from private fitness records. */
export function createCommunityStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_media (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('note','avatar','attachment')), type TEXT NOT NULL, size INTEGER NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, duration REAL,
      storage_key TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL, expires_at TEXT);
    CREATE TABLE IF NOT EXISTS community_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT NOT NULL, avatar_media_id TEXT REFERENCES community_media(id) ON DELETE SET NULL,
      bio TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
      collections_visibility TEXT NOT NULL DEFAULT 'private' CHECK(collections_visibility IN ('private','public')));
    CREATE TABLE IF NOT EXISTS community_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      account_number TEXT NOT NULL UNIQUE CHECK(length(account_number)=10 AND account_number NOT GLOB '*[^0-9]*'));
    CREATE TABLE IF NOT EXISTS community_conversations (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_message_seq INTEGER NOT NULL DEFAULT 0,
      CHECK(user_a < user_b), UNIQUE(user_a,user_b));
    CREATE TABLE IF NOT EXISTS community_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES community_conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL, client_mutation_id TEXT NOT NULL, created_at TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(sender_id,client_mutation_id));
    CREATE TABLE IF NOT EXISTS community_message_reads (
      conversation_id TEXT NOT NULL REFERENCES community_conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(conversation_id,user_id));
    CREATE TABLE IF NOT EXISTS community_notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('text','image','video')), title TEXT NOT NULL, body TEXT NOT NULL,
      category TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'members' CHECK(visibility='members'),
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden','deleted')),
      moderation_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS community_note_media (
      note_id TEXT NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL UNIQUE REFERENCES community_media(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('image','video','video-cover')),
      is_cover INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(note_id,media_id));
    CREATE TABLE IF NOT EXISTS community_topics (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS community_note_topics (
      note_id TEXT NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES community_topics(id) ON DELETE CASCADE, position INTEGER NOT NULL,
      PRIMARY KEY(note_id,topic_id));
    CREATE TABLE IF NOT EXISTS community_comments (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      parent_id TEXT REFERENCES community_comments(id) ON DELETE CASCADE,
      reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','hidden','deleted')),
      moderation_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS community_note_likes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,note_id));
    CREATE TABLE IF NOT EXISTS community_collections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES community_notes(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,note_id));
    CREATE TABLE IF NOT EXISTS community_comment_likes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      comment_id TEXT NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,comment_id));
    CREATE TABLE IF NOT EXISTS community_follows (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      CHECK(user_id != target_user_id), PRIMARY KEY(user_id,target_user_id));
    CREATE TABLE IF NOT EXISTS community_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id TEXT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
      note_id TEXT REFERENCES community_notes(id) ON DELETE CASCADE,
      top_level_comment_id TEXT REFERENCES community_comments(id) ON DELETE CASCADE,
      target_comment_id TEXT REFERENCES community_comments(id) ON DELETE CASCADE,
      dedup_key TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,dedup_key));
    CREATE TABLE IF NOT EXISTS community_reports (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('note','comment')), target_id TEXT NOT NULL,
      reason TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
      result TEXT NOT NULL DEFAULT '', moderation_reason TEXT NOT NULL DEFAULT '',
      moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS community_moderation_actions (
      id TEXT PRIMARY KEY, report_id TEXT REFERENCES community_reports(id) ON DELETE CASCADE,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS community_roles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role='moderator'),
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS community_mutations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation TEXT NOT NULL,
      mutation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, status INTEGER NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(user_id,operation,mutation_id));
    CREATE TABLE IF NOT EXISTS community_snapshots (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL, ids TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS community_rate_limits (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation TEXT NOT NULL,
      count INTEGER NOT NULL, reset_at INTEGER NOT NULL, PRIMARY KEY(user_id,operation));
    CREATE INDEX IF NOT EXISTS community_notes_feed ON community_notes(status,category,created_at,id);
    CREATE INDEX IF NOT EXISTS community_notes_author ON community_notes(user_id,status,created_at,id);
    CREATE INDEX IF NOT EXISTS community_comments_note ON community_comments(note_id,parent_id,status,created_at,id);
    CREATE INDEX IF NOT EXISTS community_comments_user ON community_comments(user_id);
    CREATE INDEX IF NOT EXISTS community_notifications_user ON community_notifications(user_id,updated_at,id);
    CREATE INDEX IF NOT EXISTS community_reports_status ON community_reports(status,created_at,id);
    CREATE INDEX IF NOT EXISTS community_snapshots_expiry ON community_snapshots(expires_at);
    CREATE INDEX IF NOT EXISTS community_messages_conversation_seq ON community_messages(conversation_id,seq);
    CREATE INDEX IF NOT EXISTS community_conversations_user_a ON community_conversations(user_a,last_message_seq,id);
    CREATE INDEX IF NOT EXISTS community_conversations_user_b ON community_conversations(user_b,last_message_seq,id);
  `);
  // Existing accounts retain private collections until their owner opts in.
  if (!db.prepare('PRAGMA table_info(community_profiles)').all().some(column => column.name === 'collections_visibility')) {
    db.exec("ALTER TABLE community_profiles ADD COLUMN collections_visibility TEXT NOT NULL DEFAULT 'private' CHECK(collections_visibility IN ('private','public'))");
  }
  // Also upgrade a database that already received early versions of private messages.
  if (!db.prepare('PRAGMA table_info(community_messages)').all().some(column => column.name === 'position')) {
    db.exec('ALTER TABLE community_messages ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`UPDATE community_messages SET position=(SELECT COUNT(*) FROM community_messages previous WHERE previous.conversation_id=community_messages.conversation_id AND previous.seq<=community_messages.seq) WHERE position=0;
    CREATE UNIQUE INDEX IF NOT EXISTS community_messages_conversation_position ON community_messages(conversation_id,position);`);
  createCommunityGroupsStore(db);
  upgradeCommunityAttachmentPurpose(db);
  createCommunityAttachmentStore(db);
  return { db, transaction: operation => communityTransaction(db, operation) };
}

/** Synchronous operations keep relationship, counters, and notifications atomic. */
export function communityTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
