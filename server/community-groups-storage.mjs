/** Group membership epochs keep history and cursors separate across re-joins. */
export function createCommunityGroupsStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_groups (
      id TEXT PRIMARY KEY, group_number TEXT NOT NULL UNIQUE,
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', announcement TEXT NOT NULL DEFAULT '',
      mute_all INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dissolved')),
      last_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS community_group_members (
      id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')), muted INTEGER NOT NULL DEFAULT 0,
      joined_seq INTEGER NOT NULL DEFAULT 0, last_read_seq INTEGER NOT NULL DEFAULT 0,
      delivered_seq INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL, PRIMARY KEY(group_id,user_id));
    CREATE UNIQUE INDEX IF NOT EXISTS community_group_one_owner ON community_group_members(group_id) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS community_group_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, membership_id TEXT NOT NULL,
      body TEXT NOT NULL, client_mutation_id TEXT NOT NULL,
      mention_user_ids TEXT NOT NULL DEFAULT '[]', mention_all INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      UNIQUE(sender_id,client_mutation_id));
    CREATE TABLE IF NOT EXISTS community_group_requests (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
      membership_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS community_group_pending_request ON community_group_requests(group_id,user_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS community_group_invitations (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      inviter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked')),
      membership_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS community_group_pending_invitation ON community_group_invitations(group_id,user_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS community_group_mutations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, mutation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY(user_id,mutation_id));
    CREATE TABLE IF NOT EXISTS community_group_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS community_group_members_user ON community_group_members(user_id,group_id);
    CREATE INDEX IF NOT EXISTS community_group_messages_seq ON community_group_messages(group_id,seq);
    CREATE INDEX IF NOT EXISTS community_group_requests_group ON community_group_requests(group_id,status,created_at,id);
    CREATE INDEX IF NOT EXISTS community_group_invitations_user ON community_group_invitations(user_id,status,created_at,id);
  `);
  return {db};
}
