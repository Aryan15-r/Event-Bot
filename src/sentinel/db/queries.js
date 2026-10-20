// src/db/queries.js
// Parameterized SQL query operations for Cloudflare D1
import { safePruneWithBackup } from '../../transcripts.js';

/**
 * Upserts a guild record into the database.
 */
export async function upsertGuild(db, { guild_id, name, icon_hash, member_count, access_status = 'active' }) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO guilds (guild_id, name, icon_hash, member_count, last_synced_at, access_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      name = excluded.name,
      icon_hash = excluded.icon_hash,
      member_count = excluded.member_count,
      last_synced_at = excluded.last_synced_at,
      access_status = excluded.access_status,
      updated_at = excluded.updated_at
  `).bind(guild_id, name, icon_hash, member_count, now, access_status, now, now).run();
}

/**
 * Lists all known guilds with channel counts and monitoring summary.
 */
export async function listGuilds(db) {
  const query = `
    SELECT 
      g.*,
      COUNT(c.channel_id) as total_channels,
      SUM(CASE WHEN c.is_monitored = 1 THEN 1 ELSE 0 END) as monitored_channels,
      MAX(c.last_successful_poll_at) as last_channel_poll_at
    FROM guilds g
    LEFT JOIN channels c ON g.guild_id = c.guild_id
    GROUP BY g.guild_id
    ORDER BY g.name ASC
  `;
  const { results } = await db.prepare(query).all();
  return results || [];
}

/**
 * Gets a single guild by ID.
 */
export async function getGuild(db, guildId) {
  return await db.prepare('SELECT * FROM guilds WHERE guild_id = ?').bind(guildId).first();
}

/**
 * Upserts channels for a guild from Discord API discovery.
 * Preserves the existing `is_monitored` flag, cursors, and poll metrics.
 */
export async function upsertDiscoveredChannels(db, guildId, channels) {
  if (!channels || channels.length === 0) return;
  const now = new Date().toISOString();

  const statements = channels.map(ch => {
    return db.prepare(`
      INSERT INTO channels (
        channel_id, guild_id, name, channel_type, parent_id, parent_name,
        is_monitored, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        name = excluded.name,
        channel_type = excluded.channel_type,
        parent_id = excluded.parent_id,
        parent_name = excluded.parent_name,
        updated_at = excluded.updated_at
    `).bind(
      ch.id,
      guildId,
      ch.name,
      ch.type,
      ch.parent_id || null,
      ch.parent_name || null,
      now,
      now
    );
  });

  // D1 batch supports up to 128 statements per batch
  const chunkSize = 50;
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
}

/**
 * Lists channels belonging to a guild with message counts.
 */
export async function listChannelsByGuild(db, guildId) {
  const query = `
    SELECT 
      c.*,
      COUNT(m.message_id) as message_count
    FROM channels c
    LEFT JOIN messages m ON c.channel_id = m.channel_id
    WHERE c.guild_id = ?
    GROUP BY c.channel_id
    ORDER BY c.parent_name ASC NULLS LAST, c.name ASC
  `;
  const { results } = await db.prepare(query).bind(guildId).all();
  return results || [];
}

/**
 * Gets a single channel by ID.
 */
export async function getChannel(db, channelId) {
  return await db.prepare('SELECT * FROM channels WHERE channel_id = ?').bind(channelId).first();
}

/**
 * Lists all active monitored channels across all guilds.
 */
export async function listMonitoredChannels(db) {
  const query = `
    SELECT 
      c.*,
      g.name as guild_name,
      cur.last_message_id as cursor_message_id
    FROM channels c
    JOIN guilds g ON c.guild_id = g.guild_id
    LEFT JOIN channel_cursors cur ON c.channel_id = cur.channel_id
    WHERE c.is_monitored = 1
    ORDER BY c.guild_id, c.name
  `;
  const { results } = await db.prepare(query).all();
  return results || [];
}

/**
 * Updates monitoring toggle for a channel.
 */
export async function updateChannelMonitoring(db, channelId, isMonitored) {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE channels 
    SET is_monitored = ?, updated_at = ?
    WHERE channel_id = ?
  `).bind(isMonitored ? 1 : 0, now, channelId).run();

  if (isMonitored) {
    const msg = await db.prepare('SELECT message_id FROM messages WHERE channel_id = ? LIMIT 1').bind(channelId).first();
    if (!msg) {
      await db.prepare('DELETE FROM channel_cursors WHERE channel_id = ?').bind(channelId).run();
      await db.prepare('UPDATE channels SET last_message_id = NULL WHERE channel_id = ?').bind(channelId).run();
    }
  }
}

/**
 * Updates channel poll attempt, status, and error.
 */
export async function updateChannelPollStatus(db, channelId, { status, error = null, lastMessageId = null, isSuccess = false }) {
  const now = new Date().toISOString();
  let sql = `
    UPDATE channels 
    SET 
      last_poll_attempt_at = ?,
      last_poll_status = ?,
      last_poll_error = ?,
      updated_at = ?
  `;
  const binds = [now, status, error, now];

  if (isSuccess) {
    sql += `, last_successful_poll_at = ?`;
    binds.push(now);
  }
  if (lastMessageId) {
    sql += `, last_message_id = ?`;
    binds.push(lastMessageId);
  }

  sql += ` WHERE channel_id = ?`;
  binds.push(channelId);

  await db.prepare(sql).bind(...binds).run();
}

/**
 * Updates or sets the channel cursor.
 */
export async function updateChannelCursor(db, channelId, lastMessageId) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO channel_cursors (channel_id, last_message_id, last_successful_poll_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      last_message_id = excluded.last_message_id,
      last_successful_poll_at = excluded.last_successful_poll_at,
      updated_at = excluded.updated_at
  `).bind(channelId, lastMessageId, now, now).run();
}

/**
 * Batch upserts messages idempotently into D1.
 * Returns { inserted, updated }.
 */
export async function upsertMessages(db, messages) {
  if (!messages || messages.length === 0) return { inserted: 0, updated: 0 };
  const now = new Date().toISOString();

  let inserted = 0;
  let updated = 0;

  const statements = messages.map(msg => {
    const replyJson = msg.reply_to ? JSON.stringify(msg.reply_to) : (msg.reply_to_json || null);
    return db.prepare(`
      INSERT INTO messages (
        message_id, guild_id, channel_id, author_id, author_username,
        author_display_name, author_role_ids, content, attachments_json,
        embeds_json, message_type, reply_to_json, created_at, edited_at, first_seen_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        content = excluded.content,
        edited_at = excluded.edited_at,
        attachments_json = excluded.attachments_json,
        embeds_json = excluded.embeds_json,
        author_display_name = excluded.author_display_name,
        author_role_ids = excluded.author_role_ids,
        reply_to_json = coalesce(excluded.reply_to_json, messages.reply_to_json),
        last_seen_at = excluded.last_seen_at
    `).bind(
      msg.id || msg.message_id,
      msg.guild_id,
      msg.channel_id,
      msg.author?.id || msg.author_id,
      msg.author?.username || msg.author_username || '',
      msg.author?.display_name || msg.author?.global_name || msg.author?.username || msg.author_display_name || '',
      JSON.stringify(msg.author?.role_ids || (typeof msg.author_role_ids === 'string' ? JSON.parse(msg.author_role_ids || '[]') : msg.author_role_ids) || []),
      msg.content || '',
      JSON.stringify(msg.attachments || (typeof msg.attachments_json === 'string' ? JSON.parse(msg.attachments_json || '[]') : msg.attachments_json) || []),
      JSON.stringify(msg.embeds || (typeof msg.embeds_json === 'string' ? JSON.parse(msg.embeds_json || '[]') : msg.embeds_json) || []),
      msg.type || msg.message_type || 0,
      replyJson,
      msg.timestamp || msg.created_at || now,
      msg.edited_timestamp || msg.edited_at || null,
      now,
      now
    );
  });

  const chunkSize = 50;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    const res = await db.batch(chunk);
    for (const r of res) {
      if (r.meta && r.meta.changes > 0) {
        inserted++;
      } else {
        updated++;
      }
    }
  }

  return { inserted, updated };
}

/**
 * Searches and paginates messages with flexible filtering.
 */
export async function listMessages(db, {
  guildId,
  channelId,
  authorId,
  query,
  startDate,
  endDate,
  trackedOnly = false,
  limit = 50,
  offset = 0
}) {
  const conditions = [];
  const binds = [];

  if (guildId) {
    conditions.push('m.guild_id = ?');
    binds.push(guildId);
  }
  if (channelId) {
    conditions.push('m.channel_id = ?');
    binds.push(channelId);
  }
  if (authorId) {
    conditions.push('m.author_id = ?');
    binds.push(authorId);
  }
  if (startDate) {
    conditions.push('m.created_at >= ?');
    binds.push(startDate);
  }
  if (endDate) {
    conditions.push('m.created_at <= ?');
    binds.push(endDate);
  }
  if (query && query.trim()) {
    conditions.push('(m.content LIKE ? OR m.author_display_name LIKE ? OR m.author_username LIKE ? OR m.embeds_json LIKE ?)');
    const term = `%${query.trim()}%`;
    binds.push(term, term, term, term);
  }
  if (trackedOnly) {
    conditions.push(`(
      m.author_id IN (SELECT member_id FROM tracked_members WHERE notify_on_messages = 1)
      OR EXISTS (
        SELECT 1 FROM tracked_members tm 
        WHERE tm.notify_on_pings = 1 AND (
          m.content LIKE ('%<@' || tm.member_id || '>%')
          OR m.content LIKE ('%<@!' || tm.member_id || '>%')
          OR m.embeds_json LIKE ('%<@' || tm.member_id || '>%')
          OR m.embeds_json LIKE ('%<@!' || tm.member_id || '>%')
        )
      )
    )`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  
  // Total count query
  const countSql = `SELECT COUNT(*) as total FROM messages m ${whereClause}`;
  const countRow = await db.prepare(countSql).bind(...binds).first();
  const total = countRow ? countRow.total : 0;

  // Data query with joins to get channel and guild names
  const dataSql = `
    SELECT 
      m.*,
      c.name as channel_name,
      g.name as guild_name
    FROM messages m
    JOIN channels c ON m.channel_id = c.channel_id
    JOIN guilds g ON m.guild_id = g.guild_id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const { results } = await db.prepare(dataSql).bind(...binds, limit, offset).all();

  return {
    messages: results || [],
    total,
    limit,
    offset
  };
}

/**
 * Gets messages for the plain text digest within UTC cutoff.
 */
export async function getMessagesForDigest(db, cutoffIso) {
  const query = `
    SELECT 
      m.*,
      c.name as channel_name,
      g.name as guild_name
    FROM messages m
    JOIN channels c ON m.channel_id = c.channel_id
    JOIN guilds g ON m.guild_id = g.guild_id
    WHERE c.is_monitored = 1
      AND m.created_at >= ?
    ORDER BY m.created_at ASC
  `;
  const { results } = await db.prepare(query).bind(cutoffIso).all();
  return results || [];
}

/**
 * Creates a poll run record.
 */
export async function createPollRun(db, id, startedAt = new Date().toISOString()) {
  await db.prepare(`
    INSERT INTO poll_runs (id, started_at, status, channels_attempted, channels_succeeded, channels_failed, messages_inserted, messages_updated)
    VALUES (?, ?, 'running', 0, 0, 0, 0, 0)
  `).bind(id, startedAt).run();
}

/**
 * Updates a poll run record on completion.
 */
export async function completePollRun(db, id, {
  status,
  channels_attempted = 0,
  channels_succeeded = 0,
  channels_failed = 0,
  messages_inserted = 0,
  messages_updated = 0,
  error_summary = null
}) {
  const finishedAt = new Date().toISOString();
  await db.prepare(`
    UPDATE poll_runs
    SET 
      finished_at = ?,
      status = ?,
      channels_attempted = ?,
      channels_succeeded = ?,
      channels_failed = ?,
      messages_inserted = ?,
      messages_updated = ?,
      error_summary = ?
    WHERE id = ?
  `).bind(
    finishedAt,
    status,
    channels_attempted,
    channels_succeeded,
    channels_failed,
    messages_inserted,
    messages_updated,
    error_summary,
    id
  ).run();
}

/**
 * Retrieves the most recent completed or running poll run.
 */
export async function getLastPollRun(db) {
  return await db.prepare(`
    SELECT * FROM poll_runs ORDER BY started_at DESC LIMIT 1
  `).first();
}

/**
 * Retrieves recent poll runs for dashboard health view.
 */
export async function listRecentPollRuns(db, limit = 10) {
  const { results } = await db.prepare(`
    SELECT * FROM poll_runs ORDER BY started_at DESC LIMIT ?
  `).bind(limit).all();
  return results || [];
}

/**
 * Session management queries.
 */
export async function createSession(db, sessionHash, expiresAtIso) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO sessions (session_id_hash, created_at, expires_at, last_activity_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionHash, now, expiresAtIso, now).run();
}

export async function getSession(db, sessionHash) {
  return await db.prepare(`
    SELECT * FROM sessions WHERE session_id_hash = ?
  `).bind(sessionHash).first();
}

export async function touchSession(db, sessionHash, newExpiresAtIso) {
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE sessions 
    SET last_activity_at = ?, expires_at = ?
    WHERE session_id_hash = ?
  `).bind(now, newExpiresAtIso, sessionHash).run();
}

export async function deleteSession(db, sessionHash) {
  await db.prepare('DELETE FROM sessions WHERE session_id_hash = ?').bind(sessionHash).run();
}

export async function cleanExpiredSessions(db) {
  const now = new Date().toISOString();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
}

/**
 * Durable Rate Limiting queries.
 */
export async function getRateLimit(db, key) {
  return await db.prepare('SELECT * FROM rate_limits WHERE key = ?').bind(key).first();
}

export async function incrementRateLimit(db, key, nowSec) {
  await db.prepare(`
    INSERT INTO rate_limits (key, attempts, first_attempt_at)
    VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = attempts + 1
  `).bind(key, nowSec).run();
}

export async function lockRateLimit(db, key, lockedUntilSec) {
  await db.prepare(`
    UPDATE rate_limits SET locked_until = ? WHERE key = ?
  `).bind(lockedUntilSec, key).run();
}

export async function resetRateLimit(db, key) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

/**
 * Audit log recording.
 */
export async function insertAuditLog(db, action, details = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO audit_logs (id, action, details_json, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(id, action, JSON.stringify(details), now).run();
}

/**
 * Aggregates overall system metrics for dashboard overview.
 */
export async function getSystemMetrics(db) {
  const guildsCountRow = await db.prepare('SELECT COUNT(*) as c FROM guilds').first();
  const channelsCountRow = await db.prepare('SELECT COUNT(*) as c FROM channels').first();
  const monitoredCountRow = await db.prepare('SELECT COUNT(*) as c FROM channels WHERE is_monitored = 1').first();
  const messagesCountRow = await db.prepare('SELECT COUNT(*) as c FROM messages').first();
  const summariesCountRow = await db.prepare('SELECT COUNT(*) as c FROM channel_summaries').first().catch(() => ({ c: 0 }));
  const lastPoll = await getLastPollRun(db);

  return {
    guilds_count: guildsCountRow ? guildsCountRow.c : 0,
    channels_count: channelsCountRow ? channelsCountRow.c : 0,
    monitored_channels_count: monitoredCountRow ? monitoredCountRow.c : 0,
    messages_count: messagesCountRow ? messagesCountRow.c : 0,
    summaries_count: summariesCountRow ? summariesCountRow.c : 0,
    last_poll: lastPoll || null
  };
}

/**
 * Records a message sent via Bot or Webhook.
 */
export async function insertSentMessage(db, {
  id = crypto.randomUUID(),
  sendType,
  guildId = null,
  channelId = null,
  destinationName = null,
  discordMessageId = null,
  content,
  replyToMessageId = null,
  status = 'sent',
  errorMessage = null,
  createdAt = new Date().toISOString()
}) {
  await db.prepare(`
    INSERT INTO sent_messages (
      id, send_type, guild_id, channel_id, destination_name,
      discord_message_id, content, reply_to_message_id,
      status, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    sendType,
    guildId,
    channelId,
    destinationName,
    discordMessageId,
    content,
    replyToMessageId,
    status,
    errorMessage,
    createdAt
  ).run();

  return id;
}

/**
 * Lists recently sent messages for UI display.
 */
export async function listSentMessages(db, limit = 20) {
  const { results } = await db.prepare(`
    SELECT * FROM sent_messages
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all();

  return results || [];
}

/**
 * Lists all tracked/priority members.
 */
export async function listTrackedMembers(db) {
  const { results } = await db.prepare(`
    SELECT * FROM tracked_members
    ORDER BY created_at DESC
  `).all();
  return results || [];
}

/**
 * Gets a tracked member by member_id.
 */
export async function getTrackedMember(db, memberId) {
  return await db.prepare(`
    SELECT * FROM tracked_members WHERE member_id = ?
  `).bind(memberId).first();
}

/**
 * Upserts a tracked/priority member.
 */
export async function upsertTrackedMember(db, {
  member_id,
  label = null,
  notify_on_messages = 1,
  notify_on_pings = 1
}) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO tracked_members (member_id, label, notify_on_messages, notify_on_pings, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(member_id) DO UPDATE SET
      label = excluded.label,
      notify_on_messages = excluded.notify_on_messages,
      notify_on_pings = excluded.notify_on_pings,
      updated_at = excluded.updated_at
  `).bind(
    String(member_id).trim(),
    label ? String(label).trim() : null,
    notify_on_messages ? 1 : 0,
    notify_on_pings ? 1 : 0,
    now,
    now
  ).run();

  return await getTrackedMember(db, String(member_id).trim());
}

/**
 * Deletes a tracked member by member_id.
 */
export async function deleteTrackedMember(db, memberId) {
  const info = await db.prepare(`
    DELETE FROM tracked_members WHERE member_id = ?
  `).bind(memberId).run();
  return (info && info.meta && info.meta.changes > 0) || false;
}

/**
 * Automatically summarizes and prunes raw messages older than retention window (default 48 hours).
 * Aggregates daily summaries per channel to prevent database growth while keeping historical records.
 * @param {D1Database} db 
 * @param {number} retentionHours 
 * @returns {Promise<{ summariesCreated: number, messagesPruned: number, cutoffIso: string }>}
 */
export async function pruneAndSummarizeExpiredMessages(db, retentionHours = 48, env = {}) {
  // Delegate to safePruneWithBackup to guarantee full transcript backup and SHA-256 verification before deletion
  return await safePruneWithBackup(db, retentionHours, env);
}

/**
 * Lists daily channel summaries with pagination and filtering.
 */
export async function listChannelSummaries(db, { guildId, channelId, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const binds = [];

  if (guildId) {
    conditions.push('guild_id = ?');
    binds.push(guildId);
  }
  if (channelId) {
    conditions.push('channel_id = ?');
    binds.push(channelId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = await db.prepare(`SELECT COUNT(*) as total FROM channel_summaries ${whereClause}`).bind(...binds).first();
  const total = countRow ? countRow.total : 0;

  const { results } = await db.prepare(`
    SELECT * FROM channel_summaries
    ${whereClause}
    ORDER BY summary_date DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  return { summaries: results || [], total, limit, offset };
}

/**
 * Lists all known channels across all guilds with message counts, monitoring status, and latest message time.
 */
export async function listAllChannels(db, guildId = null, monitoredOnly = false) {
  let query = `
    SELECT 
      c.*,
      g.name as guild_name,
      COUNT(m.message_id) as message_count,
      MAX(m.created_at) as latest_message_at
    FROM channels c
    LEFT JOIN guilds g ON c.guild_id = g.guild_id
    LEFT JOIN messages m ON c.channel_id = m.channel_id
  `;
  const conditions = [];
  const binds = [];
  if (guildId) {
    conditions.push('c.guild_id = ?');
    binds.push(guildId);
  }
  if (monitoredOnly) {
    conditions.push('c.is_monitored = 1');
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += `
    GROUP BY c.channel_id
    ORDER BY c.guild_id, c.parent_name ASC NULLS LAST, c.name ASC
  `;
  const { results } = await db.prepare(query).bind(...binds).all();
  return results || [];
}



