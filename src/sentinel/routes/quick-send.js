// src/sentinel/routes/quick-send.js
// Quick-send endpoint: post to Discord from a script without the dashboard UI.
// Bearer-token auth via the QUICK_SEND_TOKEN secret. Reuses the exact same
// send logic as /api/messaging/send (DiscordClient.sendMessage +
// insertSentMessage + audit log). Free tier only — no new paid services.

import { DiscordClient } from '../discord/client.js';
import { getConfig } from '../config.js';
import {
  getChannel,
  insertSentMessage,
  insertAuditLog,
  listMessages
} from '../db/queries.js';
import { checkDurableRateLimit } from '../../transcripts.js';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

/**
 * Constant-time string comparison to mitigate timing attacks.
 * Always compares full byte length; returns false when lengths differ.
 */
function constantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }
  return diff === 0;
}

function isNumericString(v) {
  return typeof v === 'string' && v.length > 0 && /^\d+$/.test(v);
}

export async function handleQuickSendRoute(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  /* ================== AUTH ==================
   * Bearer token only — no session cookie, no CSRF.
   * Compare in constant time. Reject 401 on any mismatch.
   */
  const expected = (env.QUICK_SEND_TOKEN || '').trim();
  const authHeader = request.headers.get('Authorization') || '';
  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (!expected || !constantTimeEqual(provided, expected)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  /* ================== RATE LIMIT ==================
   * 10 sends per minute per token, 60s lockout.
   * Reuses existing rate_limits D1 table via checkDurableRateLimit.
   */
  const rateKey = `quick-send:${provided}`;
  const rateCheck = await checkDurableRateLimit(env.DB, rateKey, 10, 60, 60);
  if (!rateCheck.allowed) {
    return json(
      { ok: false, error: 'Rate limit exceeded. Try again later.' },
      429,
      { 'Retry-After': String(rateCheck.retryAfterSec || 60) }
    );
  }

  /* ================== POST /api/quick-send ================== */
  if (path === '/api/quick-send' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON request body' }, 400);
    }

    const guildId = typeof body.guild_id === 'string' ? body.guild_id.trim() : '';
    const channelId = typeof body.channel_id === 'string' ? body.channel_id.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const replyToMessageId = body.reply_to_message_id
      ? String(body.reply_to_message_id).trim()
      : null;
    const mentionAuthor = Boolean(body.mention_author);

    // Validate
    if (!guildId || !isNumericString(guildId)) {
      return json({ ok: false, error: 'guild_id must be a numeric string' }, 400);
    }
    if (!channelId || !isNumericString(channelId)) {
      return json({ ok: false, error: 'channel_id must be a numeric string' }, 400);
    }
    if (!content) {
      return json({ ok: false, error: 'content is required' }, 400);
    }
    if (content.length > 2000) {
      return json({ ok: false, error: 'content exceeds 2,000 characters' }, 400);
    }
    if (replyToMessageId !== null && !isNumericString(replyToMessageId)) {
      return json({
        ok: false,
        error: 'reply_to_message_id must be a numeric string'
      }, 400);
    }

    const config = getConfig(env);
    if (!config.discordToken) {
      return json({
        ok: false,
        error: 'Discord bot token is not configured on this server'
      }, 503);
    }

    // Same channel lookup as /api/messaging/send to resolve guild/destination
    const channel = await getChannel(env.DB, channelId);
    const destinationName = channel ? `#${channel.name}` : `Channel ${channelId}`;
    const resolvedGuildId = channel ? channel.guild_id : guildId;

    const client = new DiscordClient(config.discordToken);
    try {
      // Exact same send call as /api/messaging/send
      const sent = await client.sendMessage(channelId, content, {
        replyToMessageId,
        mentionAuthor,
        embeds: undefined
      });

      const discordMessageId = sent ? sent.id : null;

      // Same messaging-history logging as /api/messaging/send
      await insertSentMessage(env.DB, {
        sendType: 'bot',
        guildId: resolvedGuildId,
        channelId,
        destinationName,
        discordMessageId,
        content,
        replyToMessageId,
        status: 'sent'
      });

      await insertAuditLog(env.DB, 'quick_send', {
        channel_id: channelId,
        guild_id: resolvedGuildId,
        discord_message_id: discordMessageId,
        reply_to: replyToMessageId
      });

      return json({
        ok: true,
        discordMessageId,
        channelId,
        guildId: resolvedGuildId
      });
    } catch (err) {
      await insertSentMessage(env.DB, {
        sendType: 'bot',
        guildId: resolvedGuildId,
        channelId,
        destinationName,
        content,
        replyToMessageId,
        status: 'failed',
        errorMessage: err.message
      });

      return json(
        { ok: false, error: `Failed to send via bot: ${err.message}` },
        502
      );
    }
  }

  /* ================== GET /api/quick-send/resolve ==================
   * Helper to find recent message IDs in a channel by name/text,
   * so callers can discover snowflakes to pass as reply_to_message_id.
   */
  if (path === '/api/quick-send/resolve' && method === 'GET') {
    const channel = url.searchParams.get('channel') || '';
    const query = url.searchParams.get('query') || '';

    if (!channel || !isNumericString(channel)) {
      return json({ ok: false, error: 'channel must be a numeric string' }, 400);
    }

    const result = await listMessages(env.DB, {
      channelId: channel,
      query: query || undefined,
      limit: 25,
      offset: 0
    });

    return json({
      ok: true,
      channel,
      messages: (result.messages || []).map(m => ({
        message_id: m.message_id,
        author_id: m.author_id,
        author_username: m.author_username,
        author_display_name: m.author_display_name,
        content: m.content,
        created_at: m.created_at
      }))
    });
  }

  return json({ ok: false, error: 'Endpoint Not Found' }, 404);
}