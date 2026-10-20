// src/db/schema.js
// SQL Schema definition and table initializer for Cloudflare D1

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_hash TEXT,
  member_count INTEGER,
  last_synced_at TEXT,
  access_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_type INTEGER NOT NULL,
  parent_id TEXT,
  parent_name TEXT,
  is_monitored INTEGER NOT NULL DEFAULT 0,
  poll_limit INTEGER NOT NULL DEFAULT 50,
  last_poll_attempt_at TEXT,
  last_successful_poll_at TEXT,
  last_poll_status TEXT,
  last_poll_error TEXT,
  last_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channels_guild_id ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_channels_is_monitored ON channels(is_monitored);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_username TEXT,
  author_display_name TEXT,
  author_role_ids TEXT,
  content TEXT,
  attachments_json TEXT,
  embeds_json TEXT,
  message_type INTEGER DEFAULT 0,
  reply_to_json TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_guild_channel ON messages(guild_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages(author_id);

CREATE TABLE IF NOT EXISTS poll_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  channels_attempted INTEGER NOT NULL DEFAULT 0,
  channels_succeeded INTEGER NOT NULL DEFAULT 0,
  channels_failed INTEGER NOT NULL DEFAULT 0,
  messages_inserted INTEGER NOT NULL DEFAULT 0,
  messages_updated INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_poll_runs_started_at ON poll_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS channel_cursors (
  channel_id TEXT PRIMARY KEY,
  last_message_id TEXT,
  last_successful_poll_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_attempt_at INTEGER NOT NULL,
  locked_until INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS sent_messages (
  id TEXT PRIMARY KEY,
  send_type TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT,
  destination_name TEXT,
  discord_message_id TEXT,
  content TEXT NOT NULL,
  reply_to_message_id TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sent_messages_created_at ON sent_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS tracked_members (
  member_id TEXT PRIMARY KEY,
  label TEXT,
  notify_on_messages INTEGER NOT NULL DEFAULT 1,
  notify_on_pings INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_members_created ON tracked_members(created_at DESC);

CREATE TABLE IF NOT EXISTS channel_summaries (
  id TEXT PRIMARY KEY,
  summary_date TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  guild_name TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  unique_authors_count INTEGER NOT NULL DEFAULT 0,
  top_authors_json TEXT,
  key_topics TEXT,
  summary_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_summaries_date ON channel_summaries(summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_channel_summaries_channel ON channel_summaries(channel_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_channel_summaries_guild ON channel_summaries(guild_id, summary_date DESC);

CREATE TABLE IF NOT EXISTS alert_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  alerts_enabled INTEGER NOT NULL DEFAULT 1,
  email_to TEXT NOT NULL DEFAULT '7d8agt@mail.instinct.com',
  user_ids_json TEXT NOT NULL DEFAULT '["1561313029998518373"]',
  keywords_json TEXT NOT NULL DEFAULT '["help","urgent","emergency","need staff"]',
  staff_roles_json TEXT NOT NULL DEFAULT '["staff","admin","mod","moderator","lead","owner"]',
  check_staff_roles INTEGER NOT NULL DEFAULT 1,
  max_per_hour INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_alerts (
  id TEXT PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  guild_id TEXT,
  guild_name TEXT,
  channel_id TEXT,
  channel_name TEXT,
  author_id TEXT,
  author_name TEXT,
  content_preview TEXT,
  match_reason TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_sent_alerts_message_id ON sent_alerts(message_id);
CREATE INDEX IF NOT EXISTS idx_sent_alerts_sent_at ON sent_alerts(sent_at DESC);
`;

/**
 * Ensures that all database tables and indexes exist.
 * Safe to run multiple times (idempotent).
 * @param {D1Database} db
 */
export async function ensureSchema(db) {
  if (!db) throw new Error('Database binding DB is missing');

  // Fast path: one READ confirms the schema is already current.
  // Running the DDL below on every cold start cost ~32 D1 write queries per
  // isolate and was a major contributor to the rows-written quota.
  const probe = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM pragma_table_info('channels') WHERE name = 'poll_limit') AS has_poll_limit,
      (SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'reply_to_json') AS has_reply_to,
      (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'transcripts') AS has_transcripts
  `).first().catch(() => null);

  if (probe && probe.has_poll_limit && probe.has_reply_to && probe.has_transcripts) {
    return;
  }

  // Column migrations run FIRST: existing databases were created before these
  // columns existed, and CREATE TABLE IF NOT EXISTS will never add them.
  const migrations = [
    'ALTER TABLE messages ADD COLUMN reply_to_json TEXT',
    'ALTER TABLE channels ADD COLUMN poll_limit INTEGER NOT NULL DEFAULT 50'
  ];
  for (const sql of migrations) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      // "duplicate column" = already migrated, "no such table" = fresh DB
      // created by the batch below. Anything else is a real failure.
      if (!/duplicate column|no such table/i.test(err.message || '')) {
        console.error('[Sentinel Schema] Migration failed:', sql, '-', err.message);
      }
    }
  }

  // Base schema — idempotent no-ops on databases that already exist.
  const statements = INITIAL_SCHEMA_SQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  try {
    await db.batch(statements.map(sql => db.prepare(sql)));
  } catch (err) {
    console.error('[Sentinel Schema] Base schema batch failed:', err.message);
  }
}
