import { HttpError } from './providers.mjs';

export function attachmentImageIds(value = []) {
  if (!Array.isArray(value) || value.length > 9 || value.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(value).size !== value.length) throw new HttpError(400, '每条内容最多发送 9 张图片，图片不能重复。');
  return value;
}

/** Preserve the existing media rows and all incoming foreign keys on upgrade. */
export function upgradeCommunityAttachmentPurpose(db) {
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='community_media'").get()?.sql;
  if (!definition || definition.includes("'attachment'")) return;
  const expanded = definition.replace(/CHECK\s*\(\s*purpose\s+IN\s*\(\s*'note'\s*,\s*'avatar'\s*\)\s*\)/i, "CHECK(purpose IN ('note','avatar','attachment'))");
  if (expanded === definition) throw new Error('Unsupported community media purpose schema');
  const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='community_media' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  const columns = db.prepare('PRAGMA table_info(community_media)').all().map(column => `"${column.name.replaceAll('"', '""')}"`).join(',');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    const replacement = expanded.replace(/^(CREATE TABLE(?: IF NOT EXISTS)?\s+)(?:"community_media"|community_media)(?=\s*\()/i, '$1community_media_attachment_upgrade');
    if (replacement === expanded) throw new Error('Unsupported community media table definition');
    db.exec(replacement);
    db.exec(`INSERT INTO community_media_attachment_upgrade(${columns}) SELECT ${columns} FROM community_media;
      DROP TABLE community_media; ALTER TABLE community_media_attachment_upgrade RENAME TO community_media;`);
    for (const object of objects) db.exec(object.sql);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); }
}

export function createCommunityAttachmentStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS community_attachment_media (
    media_id TEXT PRIMARY KEY REFERENCES community_media(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('comment','message','group-message')),
    target_id TEXT NOT NULL, position INTEGER NOT NULL,
    UNIQUE(target_type,target_id,position));
    CREATE INDEX IF NOT EXISTS community_attachment_target ON community_attachment_media(target_type,target_id);`);
  // Revocation is synchronous with deleting the target. The existing expiry
  // sweeper removes the files, including those owned by other participants.
  for (const [table, type] of [['community_comments', 'comment'], ['community_messages', 'message'], ['community_group_messages', 'group-message']]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_attachments_delete AFTER DELETE ON ${table} BEGIN
      UPDATE community_media SET status='deleted',expires_at='1970-01-01T00:00:00.000Z'
        WHERE id IN (SELECT media_id FROM community_attachment_media WHERE target_type='${type}' AND target_id=old.id);
      DELETE FROM community_attachment_media WHERE target_type='${type}' AND target_id=old.id;
    END;`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS community_comments_attachments_deleted AFTER UPDATE OF status ON community_comments WHEN new.status='deleted' BEGIN
      UPDATE community_media SET status='deleted',expires_at='1970-01-01T00:00:00.000Z'
        WHERE id IN (SELECT media_id FROM community_attachment_media WHERE target_type='comment' AND target_id=new.id);
      DELETE FROM community_attachment_media WHERE target_type='comment' AND target_id=new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS community_notes_comment_attachments_deleted AFTER UPDATE OF status ON community_notes WHEN new.status='deleted' BEGIN
      UPDATE community_media SET status='deleted',expires_at='1970-01-01T00:00:00.000Z'
        WHERE id IN (SELECT a.media_id FROM community_attachment_media a JOIN community_comments c ON c.id=a.target_id WHERE a.target_type='comment' AND c.note_id=new.id);
      DELETE FROM community_attachment_media WHERE target_type='comment' AND target_id IN (SELECT id FROM community_comments WHERE note_id=new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS community_groups_attachments_dissolved AFTER UPDATE OF status ON community_groups WHEN new.status='dissolved' BEGIN
      UPDATE community_media SET status='deleted',expires_at='1970-01-01T00:00:00.000Z'
        WHERE id IN (SELECT a.media_id FROM community_attachment_media a JOIN community_group_messages m ON m.id=a.target_id WHERE a.target_type='group-message' AND m.group_id=new.id);
      DELETE FROM community_attachment_media WHERE target_type='group-message' AND target_id IN (SELECT id FROM community_group_messages WHERE group_id=new.id);
    END;`);
}
