import {initializeAchievements} from './achievements.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createCommunityStore } from './community-storage.mjs';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyFile = join(dataDir, 'server.key');
  try { writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error('服务器加密密钥文件不完整。');
  const db = new DatabaseSync(join(dataDir, 'fitness.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, id));
    CREATE TABLE IF NOT EXISTS providers (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id, id));
    CREATE TABLE IF NOT EXISTS preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, tasks TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS attachment_user ON attachments(user_id);`);
  // A per-record latest revision captures every write, including AI tools.
  // AUTOINCREMENT avoids timestamp ties and retains deletion tombstones.
  db.exec(`CREATE TABLE IF NOT EXISTS record_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL, UNIQUE(user_id,record_id));
    INSERT OR IGNORE INTO record_changes(user_id,record_id) SELECT r.user_id,r.id FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_changes c WHERE c.user_id=r.user_id AND c.record_id=r.id);
    CREATE INDEX IF NOT EXISTS record_changes_user_seq ON record_changes(user_id,seq);
    CREATE TRIGGER IF NOT EXISTS records_sync_insert AFTER INSERT ON records BEGIN
      INSERT INTO record_changes(user_id,record_id) VALUES(new.user_id,new.id)
      ON CONFLICT(user_id,record_id) DO UPDATE SET seq=excluded.seq;
    END;
    CREATE TRIGGER IF NOT EXISTS records_sync_update AFTER UPDATE ON records BEGIN
      INSERT INTO record_changes(user_id,record_id) VALUES(new.user_id,new.id)
      ON CONFLICT(user_id,record_id) DO UPDATE SET seq=excluded.seq;
    END;`);
  initializeAchievements(db);
  // Keep existing encrypted keys and task assignments when upgrading older databases.
  const providerColumns = new Set(db.prepare('PRAGMA table_info(providers)').all().map(column => column.name));
  for (const [name, definition] of Object.entries({ preset_id: "TEXT NOT NULL DEFAULT 'custom'", protocol: "TEXT NOT NULL DEFAULT 'openai'", models: "TEXT NOT NULL DEFAULT '[]'" })) {
    if (!providerColumns.has(name)) db.exec(`ALTER TABLE providers ADD COLUMN ${name} ${definition}`);
  }
  if (!providerColumns.has('models')) {
    const updateModels = db.prepare('UPDATE providers SET models = ? WHERE user_id = ? AND id = ?');
    for (const row of db.prepare('SELECT user_id,id,model FROM providers').all()) updateModels.run(JSON.stringify(row.model ? [{ id: row.model, name: row.model, vision: null }] : []), row.user_id, row.id);
  }
  const preferenceColumns = new Set(db.prepare('PRAGMA table_info(preferences)').all().map(column => column.name));
  if (!preferenceColumns.has('task_models')) db.exec("ALTER TABLE preferences ADD COLUMN task_models TEXT NOT NULL DEFAULT '{}'");
  // Existing settings start at version one; new accounts remain at zero until
  // their first save. Keep the revision after clearing all providers as well.
  if (!preferenceColumns.has('version')) db.exec('ALTER TABLE preferences ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  db.exec(`INSERT INTO preferences(user_id,tasks,task_models,version)
    SELECT DISTINCT user_id,'{"chat":"","meal":"","planning":""}','{}',1 FROM providers
    WHERE user_id NOT IN (SELECT user_id FROM preferences)`);
  createCommunityStore(db);
  return {
    db,
    encrypt(value) {
      if (!value) return '';
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decrypt(value) {
      if (!value) return '';
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

export function recordFromRow(row) {
  return row && { id: row.id, kind: row.kind, data: JSON.parse(row.data), version: row.version, deleted: Boolean(row.deleted), updatedAt: row.updated_at };
}

export function getRecords(db, userId) {
  return db.prepare('SELECT * FROM records WHERE user_id = ? ORDER BY updated_at, id').all(userId).map(recordFromRow);
}

export function getRecordChanges(db,userId,cursor) {
  const current=db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM record_changes WHERE user_id = ?').get(userId).value;
  const incremental=Number.isSafeInteger(cursor)&&cursor>=0&&cursor<=current;
  const records=incremental?db.prepare(`SELECT r.* FROM records r JOIN record_changes c ON c.user_id=r.user_id AND c.record_id=r.id WHERE r.user_id=? AND c.seq>? ORDER BY c.seq`).all(userId,cursor).map(recordFromRow):getRecords(db,userId);
  return {records,cursor:current};
}

export function getProviders(db, userId) {
  const providers = db.prepare('SELECT * FROM providers WHERE user_id = ? ORDER BY rowid').all(userId).map(providerFromRow);
  const row = db.prepare('SELECT tasks,task_models,version FROM preferences WHERE user_id = ?').get(userId);
  const tasks = row ? JSON.parse(row.tasks) : { chat: '', meal: '', planning: '' };
  const storedModels = row ? JSON.parse(row.task_models) : {};
  const taskNames = ['chat', 'meal', 'planning', ...(Object.hasOwn(tasks, 'motion') || Object.hasOwn(storedModels, 'motion') ? ['motion'] : [])];
  const taskModels = Object.fromEntries(taskNames.map(task => [task, storedModels[task] ?? providers.find(provider => provider.id === tasks[task])?.model ?? '']));
  return { providers, tasks, taskModels, version: row?.version ?? 0 };
}

export function providerFromRow(row) {
  return row && { id: row.id, name: row.name, presetId: row.preset_id, protocol: row.protocol, baseUrl: row.base_url, model: row.model, models: JSON.parse(row.models), hasKey: Boolean(row.api_key) };
}
