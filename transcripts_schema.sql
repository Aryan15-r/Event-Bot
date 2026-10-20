-- Schema for Discord Transcripts & Monitoring in discord-event-bot
-- Can be executed on existing D1 DB or on a dedicated TRANSCRIPTS_DB

-- Monitored Channels Table (for scheduled cron polling)
CREATE TABLE IF NOT EXISTS monitored_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_monitored INTEGER NOT NULL DEFAULT 1,
  last_message_id TEXT,
  last_poll_at TEXT,
  last_poll_status TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monitored_channels_active ON monitored_channels(is_monitored);

-- Messages Table (stores full Discord message records with metadata, attachments, and embeds)
CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_username TEXT,
  author_display_name TEXT,
  author_avatar TEXT,
  author_role_ids TEXT,
  content TEXT,
  attachments_json TEXT,
  embeds_json TEXT,
  message_type INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_messages_guild_channel ON messages(guild_id, channel_id);

-- Transcripts Snapshot Table (indexes on-demand or event-generated transcripts)
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  guild_id TEXT NOT NULL,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  start_message_id TEXT,
  end_message_id TEXT,
  generated_by_id TEXT,
  generated_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transcripts_created_at ON transcripts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcripts_channel ON transcripts(channel_id);

-- Rate Limiting Table (Durable cross-worker sliding window & lockouts)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_attempt_at INTEGER NOT NULL,
  locked_until INTEGER
);
