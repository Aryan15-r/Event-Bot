// src/services/replies.js
// Optional, strictly disabled-by-default Discord reply endpoint

import { timingSafeEqual } from '../utils/security.js';
import { DiscordClient } from '../discord/client.js';
import { getChannel, insertAuditLog } from '../db/queries.js';
import { getConfig } from '../config.js';

/**
 * Handles POST /reply requests.
 * Stays completely disabled unless explicitly turned on.
 * @param {Request} request 
 * @param {Record<string, any>} env 
 * @returns {Promise<Response>}
 */
export async function handleReply(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const config = getConfig(env);

  // 1. Check if replies feature is explicitly enabled
  if (!config.enableReplies) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Discord write operations (replies) are disabled on this Sentinel instance.'
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. Validate REPLY_ADMIN_KEY configuration
  if (!config.replyAdminKey) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Replies are enabled but REPLY_ADMIN_KEY is not configured.'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. Authenticate Authorization: Bearer <key>
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedKey = match ? match[1].trim() : '';

  const isKeyValid = await timingSafeEqual(providedKey, config.replyAdminKey);
  if (!isKeyValid) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Unauthorized: Invalid reply admin key'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 4. Validate payload
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const channelId = typeof body.channel_id === 'string' ? body.channel_id.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';

  if (!channelId) {
    return new Response(JSON.stringify({ ok: false, error: 'channel_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!content || content.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: 'Message content cannot be empty' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (content.length > config.limits.MAX_REPLY_LENGTH) {
    return new Response(JSON.stringify({
      ok: false,
      error: `Message content exceeds maximum allowed length (${config.limits.MAX_REPLY_LENGTH} characters)`
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 5. Verify that channel is an enabled monitored channel
  const channel = await getChannel(env.DB, channelId);
  if (!channel) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Target channel does not exist in Sentinel database'
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!channel.is_monitored) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Replies can only be sent to actively monitored channels'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 6. Post to Discord
  const client = new DiscordClient(config.discordToken);
  try {
    const sent = await client.sendMessage(channelId, content);

    // Audit log
    await insertAuditLog(env.DB, 'discord_reply_sent', {
      channel_id: channelId,
      guild_id: channel.guild_id,
      content_length: content.length,
      discord_message_id: sent ? sent.id : null
    });

    return new Response(JSON.stringify({
      ok: true,
      message_id: sent ? sent.id : null,
      channel_id: channelId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    await insertAuditLog(env.DB, 'discord_reply_failed', {
      channel_id: channelId,
      error: err.message
    });

    return new Response(JSON.stringify({
      ok: false,
      error: `Discord send error: ${err.message}`
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
