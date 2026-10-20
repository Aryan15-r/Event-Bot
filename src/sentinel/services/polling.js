// src/services/polling.js
// Scheduled Discord Message Polling Engine with Snowflake progression and idempotent storage

import { DiscordClient, DiscordApiError } from '../discord/client.js';
import { compareSnowflakes, snowflakeToIso } from '../utils/time.js';
import {
  listMonitoredChannels,
  updateChannelPollStatus,
  updateChannelCursor,
  upsertMessages,
  createPollRun,
  completePollRun,
  pruneAndSummarizeExpiredMessages
} from '../db/queries.js';
import { CONFIG_DEFAULTS } from '../config.js';
import { checkAndDispatchAlerts } from './alerting.js';

/**
 * Normalizes raw Discord API message object for D1 storage.
 * @param {any} raw 
 * @param {string} guildId 
 * @param {string} channelId 
 */
export function normalizeMessage(raw, guildId, channelId) {
  const author = raw.author || {};
  const member = raw.member || {};
  
  // Resolve roles safely
  let roleIds = [];
  if (Array.isArray(member.roles)) {
    roleIds = member.roles.map(String);
  }

  // Resolve author display name
  const displayName = member.nick || author.global_name || author.username || 'Unknown User';

  // Format attachments
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map(att => ({
        id: String(att.id),
        filename: String(att.filename || 'attachment'),
        url: String(att.url || ''),
        size: Number(att.size || 0),
        content_type: att.content_type || 'application/octet-stream'
      }))
    : [];

  // Format embeds
  const embeds = Array.isArray(raw.embeds)
    ? raw.embeds.map(emb => {
        let hexColor = null;
        if (typeof emb.color === 'number') {
          hexColor = '#' + emb.color.toString(16).padStart(6, '0');
        } else if (typeof emb.color === 'string') {
          hexColor = emb.color;
        }

        return {
          title: emb.title ? String(emb.title) : null,
          description: emb.description ? String(emb.description) : null,
          url: emb.url ? String(emb.url) : null,
          color: hexColor,
          author: emb.author ? {
            name: emb.author.name ? String(emb.author.name) : '',
            url: emb.author.url ? String(emb.author.url) : null,
            icon_url: emb.author.icon_url ? String(emb.author.icon_url) : null
          } : null,
          fields: Array.isArray(emb.fields)
            ? emb.fields.map(f => ({
                name: String(f.name || ''),
                value: String(f.value || ''),
                inline: Boolean(f.inline)
              }))
            : [],
          footer: emb.footer ? {
            text: emb.footer.text ? String(emb.footer.text) : '',
            icon_url: emb.footer.icon_url ? String(emb.footer.icon_url) : null
          } : null,
          image: emb.image && emb.image.url ? { url: String(emb.image.url) } : null,
          thumbnail: emb.thumbnail && emb.thumbnail.url ? { url: String(emb.thumbnail.url) } : null,
          timestamp: emb.timestamp || null
        };
      })
    : [];

  const timestampIso = raw.timestamp ? new Date(raw.timestamp).toISOString() : snowflakeToIso(raw.id);
  const editedTimestampIso = raw.edited_timestamp ? new Date(raw.edited_timestamp).toISOString() : null;

  // Extract reply / thread reference if present
  let replyTo = null;
  if (raw.referenced_message) {
    const refAuthor = raw.referenced_message.author || {};
    let refAvatar = '';
    if (refAuthor.avatar) {
      refAvatar = `https://cdn.discordapp.com/avatars/${refAuthor.id}/${refAuthor.avatar}.png?size=128`;
    } else {
      const defIdx = refAuthor.discriminator && refAuthor.discriminator !== '0'
        ? Number(refAuthor.discriminator) % 5
        : (/^\d+$/.test(refAuthor.id || '') ? Number((BigInt(refAuthor.id) >> 22n) % 6n) : 0);
      refAvatar = `https://cdn.discordapp.com/embed/avatars/${defIdx}.png`;
    }
    replyTo = {
      message_id: String(raw.referenced_message.id),
      author_id: String(refAuthor.id || ''),
      author_username: String(refAuthor.username || ''),
      author_name: String(refAuthor.global_name || refAuthor.username || 'User'),
      author_avatar: refAvatar,
      content: typeof raw.referenced_message.content === 'string' ? raw.referenced_message.content : '',
      created_at: raw.referenced_message.timestamp ? new Date(raw.referenced_message.timestamp).toISOString() : null
    };
  } else if (raw.message_reference && raw.message_reference.message_id) {
    replyTo = {
      message_id: String(raw.message_reference.message_id),
      channel_id: String(raw.message_reference.channel_id || channelId),
      guild_id: String(raw.message_reference.guild_id || guildId)
    };
  }

  return {
    id: String(raw.id),
    guild_id: String(guildId),
    channel_id: String(channelId),
    author: {
      id: String(author.id || 'unknown'),
      username: String(author.username || 'unknown'),
      display_name: displayName,
      role_ids: roleIds
    },
    content: typeof raw.content === 'string' ? raw.content : '',
    attachments,
    embeds,
    type: typeof raw.type === 'number' ? raw.type : 0,
    reply_to: replyTo,
    timestamp: timestampIso,
    edited_timestamp: editedTimestampIso
  };
}

/**
 * Polls an individual channel.
 * Handles first-run backfill (50 messages) and subsequent incremental catch-up with `after`.
 * @param {D1Database} db 
 * @param {DiscordClient} client 
 * @param {any} channel 
 * @returns {Promise<{ success: boolean, inserted: number, updated: number, error: string | null, emptyInitial: boolean }>}
 */
export async function pollChannel(db, client, channel) {
  const channelId = channel.channel_id;
  const guildId = channel.guild_id;

  // Determine if this channel has any existing messages stored in D1
  const existingMsg = await db.prepare(
    'SELECT message_id FROM messages WHERE channel_id = ? LIMIT 1'
  ).bind(channelId).first();

  // If there are NO messages stored locally for this channel, force initial backfill
  // (cursor = null) so we fetch the latest batch of existing messages from Discord.
  const cursor = existingMsg ? (channel.cursor_message_id || channel.last_message_id) : null;

  let totalInserted = 0;
  let totalUpdated = 0;
  let newestMessageId = cursor;
  let emptyInitial = false;
  const newMessages = [];

  try {
    if (!cursor) {
      // First-run initialization: Fetch up to 50 latest messages
      const rawMessages = await client.getChannelMessages(channelId, {
        limit: channel.poll_limit || CONFIG_DEFAULTS.INITIAL_BACKFILL_LIMIT
      });

      if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
        emptyInitial = true;
        await updateChannelPollStatus(db, channelId, {
          status: 'success_empty',
          error: null,
          isSuccess: true
        });
        return { success: true, inserted: 0, updated: 0, error: null, emptyInitial, newMessages: [] };
      }

      // Sort chronological (oldest to newest)
      const sorted = [...rawMessages].sort((a, b) => compareSnowflakes(a.id, b.id));
      const normalized = sorted.map(m => normalizeMessage(m, guildId, channelId));

      const { inserted, updated } = await upsertMessages(db, normalized);
      totalInserted += inserted;
      totalUpdated += updated;
      newMessages.push(...normalized);

      newestMessageId = sorted[sorted.length - 1].id;
      
      // Update cursor and channel status
      await updateChannelCursor(db, channelId, newestMessageId);
      await updateChannelPollStatus(db, channelId, {
        status: 'success',
        error: null,
        lastMessageId: newestMessageId,
        isSuccess: true
      });
    } else {
      // Subsequent polling: Fetch messages newer than cursor using `after`
      let currentAfter = cursor;
      let pageCount = 0;

      while (pageCount < CONFIG_DEFAULTS.MAX_CATCHUP_PAGES) {
        pageCount++;
        const rawMessages = await client.getChannelMessages(channelId, {
          after: currentAfter,
          limit: channel.poll_limit || 100
        });

        if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
          break; // Caught up with the newest message
        }

        // Discord `after` query returns messages in ascending or descending order depending on endpoint.
        // Sort explicitly by snowflake to guarantee strict chronological order:
        const sorted = [...rawMessages].sort((a, b) => compareSnowflakes(a.id, b.id));
        const normalized = sorted.map(m => normalizeMessage(m, guildId, channelId));

        const { inserted, updated } = await upsertMessages(db, normalized);
        totalInserted += inserted;
        totalUpdated += updated;
        newMessages.push(...normalized);

        const pageMaxId = sorted[sorted.length - 1].id;
        if (compareSnowflakes(pageMaxId, newestMessageId) > 0) {
          newestMessageId = pageMaxId;
        }

        currentAfter = pageMaxId;

        if (rawMessages.length < 100) {
          break; // Reached current end of stream
        }
      }

      if (newestMessageId && compareSnowflakes(newestMessageId, cursor) > 0) {
        await updateChannelCursor(db, channelId, newestMessageId);
      }

      await updateChannelPollStatus(db, channelId, {
        status: 'success',
        error: null,
        lastMessageId: newestMessageId,
        isSuccess: true
      });
    }

    return {
      success: true,
      inserted: totalInserted,
      updated: totalUpdated,
      error: null,
      emptyInitial,
      newMessages
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateChannelPollStatus(db, channelId, {
      status: 'error',
      error: errorMsg,
      isSuccess: false
    });

    return {
      success: false,
      inserted: totalInserted,
      updated: totalUpdated,
      error: errorMsg,
      emptyInitial,
      newMessages: []
    };
  }
}

/**
 * Executes a full scheduled poll run across all active monitored channels.
 * Runs with bounded concurrency to respect CPU and memory limits.
 * @param {D1Database} db 
 * @param {string} discordToken 
 * @param {number} [retentionHours=48]
 * @param {Record<string, any>} [env={}]
 * @returns {Promise<{ runId: string, status: string, summary: any }>}
 */
export async function runScheduledPoll(db, discordToken, retentionHours = 48, env = {}) {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await createPollRun(db, runId, startedAt);

  if (!discordToken) {
    const summary = 'Missing Discord bot token secret (DISCORD_BOT_TOKEN)';
    await completePollRun(db, runId, {
      status: 'failed',
      error_summary: summary
    });
    return { runId, status: 'failed', summary: { error: summary } };
  }

  const client = new DiscordClient(discordToken);
  const monitoredChannels = await listMonitoredChannels(db);

  if (monitoredChannels.length === 0) {
    await completePollRun(db, runId, {
      status: 'success',
      channels_attempted: 0,
      channels_succeeded: 0,
      channels_failed: 0,
      error_summary: 'No channels configured for monitoring'
    });
    return {
      runId,
      status: 'success',
      summary: { message: 'No monitored channels configured' }
    };
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  const errors = [];
  const allNewMessages = [];

  // Concurrency worker pool
  const concurrency = CONFIG_DEFAULTS.CONCURRENT_CHANNEL_POLLS;
  const queue = [...monitoredChannels];

  async function worker() {
    while (queue.length > 0) {
      const channel = queue.shift();
      if (!channel) break;

      attempted++;
      const result = await pollChannel(db, client, channel);
      if (result.success) {
        succeeded++;
        totalInserted += result.inserted;
        totalUpdated += result.updated;
        if (Array.isArray(result.newMessages) && result.newMessages.length > 0) {
          allNewMessages.push(...result.newMessages);
        }
      } else {
        failed++;
        errors.push(`[${channel.guild_name} / #${channel.name}]: ${result.error}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  // Automated 48-hour rolling retention: summarize & prune old transcripts
  const retention = await pruneAndSummarizeExpiredMessages(db, retentionHours).catch(() => ({ summariesCreated: 0, messagesPruned: 0 }));

  // Automated Alert Evaluation on newly stored messages
  const alerts = await checkAndDispatchAlerts(db, env, allNewMessages).catch(err => {
    console.error('[Sentinel Polling Alert Error]', err);
    return { scanned: allNewMessages.length, matchedCount: 0, sentCount: 0, rateLimitedCount: 0, error: err.message };
  });

  const status = failed === 0 ? 'success' : (succeeded > 0 ? 'partial_failure' : 'failed');
  const errorSummary = errors.length > 0 ? errors.slice(0, 5).join('; ') : null;

  await completePollRun(db, runId, {
    status,
    channels_attempted: attempted,
    channels_succeeded: succeeded,
    channels_failed: failed,
    messages_inserted: totalInserted,
    messages_updated: totalUpdated,
    error_summary: errorSummary
  });

  return {
    runId,
    status,
    summary: {
      attempted,
      succeeded,
      failed,
      messagesInserted: totalInserted,
      messagesUpdated: totalUpdated,
      messagesPruned: retention.messagesPruned,
      summariesCreated: retention.summariesCreated,
      alerts,
      errors
    }
  };
}
