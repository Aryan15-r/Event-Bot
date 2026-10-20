// src/routes/api.js
// Authenticated REST API router for Sentinel management dashboard

import { requireAuthApi, handleLogin, handleLogout, authenticateSession } from '../services/auth.js';
import { verifyCsrf } from '../utils/security.js';
import { DiscordClient } from '../discord/client.js';
import { syncGuilds, syncGuildChannels } from '../discord/discovery.js';
import { runScheduledPoll, pollChannel } from '../services/polling.js';
import {
  listGuilds,
  getGuild,
  listChannelsByGuild,
  listAllChannels,
  updateChannelMonitoring,
  listMessages,
  getSystemMetrics,
  listRecentPollRuns,
  insertAuditLog,
  getChannel,
  insertSentMessage,
  listSentMessages,
  listTrackedMembers,
  upsertTrackedMember,
  deleteTrackedMember,
  listChannelSummaries,
  pruneAndSummarizeExpiredMessages
} from '../db/queries.js';
import {
  getAlertSettings,
  updateAlertSettings,
  getAlertCountLastHour,
  listRecentAlerts,
  sendAlertEmail,
  formatAlertEmailContent
} from '../services/alerting.js';
import { formatToIST } from '../utils/time.js';
import { getConfig } from '../config.js';

/**
 * Standard JSON response helper.
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * Dispatches API requests.
 * @param {Request} request 
 * @param {Record<string, any>} env 
 * @param {ExecutionContext} [ctx] 
 * @returns {Promise<Response>}
 */
export async function handleApiRoute(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const config = getConfig(env);

  // 1. Public Auth Endpoints
  if (path === '/api/auth/login' && method === 'POST') {
    return await handleLogin(request, env);
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    return await handleLogout(request, env);
  }

  if (path === '/api/auth/session' && method === 'GET') {
    const session = await authenticateSession(request, env);
    return json({
      authenticated: Boolean(session),
      expiresAt: session ? session.expires_at : null,
      enableReplies: config.enableReplies
    });
  }

  // 2. Protect all remaining API routes with session authentication
  const authError = await requireAuthApi(request, env);
  if (authError) return authError;

  // 3. CSRF protection on mutating requests
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    if (!verifyCsrf(request)) {
      return json({ ok: false, error: 'CSRF verification failed' }, 403);
    }
  }

  // 4. Server routes
  // GET /api/servers - List all discovered servers in D1
  if (path === '/api/servers' && method === 'GET') {
    const guilds = await listGuilds(env.DB);
    return json({ ok: true, servers: guilds });
  }

  // POST /api/servers/sync - Discover/refresh servers from Discord API
  if (path === '/api/servers/sync' && method === 'POST') {
    if (!config.discordToken) {
      return json({ ok: false, error: 'DISCORD_BOT_TOKEN is not configured' }, 503);
    }
    const client = new DiscordClient(config.discordToken);
    const result = await syncGuilds(env.DB, client);
    await insertAuditLog(env.DB, 'sync_guilds', result);
    return json({ ok: true, result });
  }

  // GET /api/channels - List all channels across all servers (with message counts and monitoring status)
  if (path === '/api/channels' && method === 'GET') {
    const guildId = url.searchParams.get('guild_id') || undefined;
    const monitoredOnly = url.searchParams.get('monitored_only') === '1' || url.searchParams.get('monitored_only') === 'true';
    const channels = await listAllChannels(env.DB, guildId, monitoredOnly);
    return json({ ok: true, channels });
  }

  // Channel discovery & list: /api/servers/:guildId/channels
  const channelsMatch = path.match(/^\/api\/servers\/([^/]+)\/channels$/);
  if (channelsMatch) {
    const guildId = channelsMatch[1];

    if (method === 'GET') {
      const guild = await getGuild(env.DB, guildId);
      if (!guild) {
        return json({ ok: false, error: 'Server not found' }, 404);
      }
      const channels = await listChannelsByGuild(env.DB, guildId);
      return json({ ok: true, guild, channels });
    }

    // PUT /api/servers/:guildId/channels - Save channel monitoring changes
    if (method === 'PUT') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON body' }, 400);
      }

      const updates = Array.isArray(body.channels) ? body.channels : [];
      let updatedCount = 0;

      for (const item of updates) {
        if (item.channel_id && typeof item.is_monitored === 'boolean') {
          await updateChannelMonitoring(env.DB, item.channel_id, item.is_monitored);
          updatedCount++;
        }
      }

      await insertAuditLog(env.DB, 'channels_monitoring_updated', {
        guildId,
        updatedCount
      });

      return json({ ok: true, updated: updatedCount });
    }
  }

  // POST /api/servers/:guildId/sync - Refresh channels for specific server from Discord
  const syncChannelsMatch = path.match(/^\/api\/servers\/([^/]+)\/sync$/);
  if (syncChannelsMatch && method === 'POST') {
    const guildId = syncChannelsMatch[1];
    if (!config.discordToken) {
      return json({ ok: false, error: 'DISCORD_BOT_TOKEN is not configured' }, 503);
    }
    const client = new DiscordClient(config.discordToken);
    const result = await syncGuildChannels(env.DB, client, guildId);
    return json({ ok: true, result });
  }

  // 5. Messages routes
  // GET /api/messages - Search and filter messages
  if (path === '/api/messages' && method === 'GET') {
    const guildId = url.searchParams.get('guild_id') || undefined;
    const channelId = url.searchParams.get('channel_id') || undefined;
    const authorId = url.searchParams.get('author_id') || undefined;
    const query = url.searchParams.get('query') || undefined;
    const startDate = url.searchParams.get('start_date') || undefined;
    const endDate = url.searchParams.get('end_date') || undefined;
    const trackedOnly = url.searchParams.get('tracked_only') === '1' || url.searchParams.get('tracked_only') === 'true';

    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

    const result = await listMessages(env.DB, {
      guildId,
      channelId,
      authorId,
      query,
      startDate,
      endDate,
      trackedOnly,
      limit,
      offset
    });

    return json({ ok: true, ...result });
  }

  // GET /api/summaries - List aggregated channel summaries (past 48+ days archive)
  if (path === '/api/summaries' && method === 'GET') {
    const guildId = url.searchParams.get('guild_id') || undefined;
    const channelId = url.searchParams.get('channel_id') || undefined;
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

    const result = await listChannelSummaries(env.DB, { guildId, channelId, limit, offset });
    return json({ ok: true, ...result });
  }

  // 6. Tracked Members routes
  // GET /api/tracked-members - List all tracked members
  if (path === '/api/tracked-members' && method === 'GET') {
    const members = await listTrackedMembers(env.DB);
    return json({ ok: true, members, tracked_members: members });
  }

  // POST /api/tracked-members - Add or update a tracked member
  if (path === '/api/tracked-members' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON request body' }, 400);
    }

    const memberId = typeof body.member_id === 'string' ? body.member_id.trim() : '';
    if (!memberId) {
      return json({ ok: false, error: 'Member ID is required' }, 400);
    }

    const label = body.label ? String(body.label).trim() : null;
    const notifyOnMessages = body.notify_on_messages !== undefined ? (body.notify_on_messages ? 1 : 0) : 1;
    const notifyOnPings = body.notify_on_pings !== undefined ? (body.notify_on_pings ? 1 : 0) : 1;

    const member = await upsertTrackedMember(env.DB, {
      member_id: memberId,
      label,
      notify_on_messages: notifyOnMessages,
      notify_on_pings: notifyOnPings
    });

    await insertAuditLog(env.DB, 'tracked_member_upserted', { member_id: memberId, label });

    return json({ ok: true, member, tracked_member: member });
  }

  // DELETE /api/tracked-members/:id - Delete a tracked member
  const deleteTrackedMatch = path.match(/^\/api\/tracked-members\/([^/]+)$/);
  if (deleteTrackedMatch && method === 'DELETE') {
    const memberId = decodeURIComponent(deleteTrackedMatch[1]);
    const deleted = await deleteTrackedMember(env.DB, memberId);
    await insertAuditLog(env.DB, 'tracked_member_deleted', { member_id: memberId });
    return json({ ok: true, deleted });
  }

  // 7. Monitoring & Health routes
  // GET /api/monitoring/status
  if (path === '/api/monitoring/status' && method === 'GET') {
    const metrics = await getSystemMetrics(env.DB);
    return json({
      ok: true,
      metrics: {
        ...metrics,
        retention_hours: config.messageRetentionHours || 48
      }
    });
  }

  // GET /api/monitoring/poll-runs
  if (path === '/api/monitoring/poll-runs' && method === 'GET') {
    const runs = await listRecentPollRuns(env.DB, 20);
    return json({ ok: true, runs });
  }

  // POST /api/monitoring/poll-now - Manual trigger of scheduled poll
  if (path === '/api/monitoring/poll-now' && method === 'POST') {
    if (!config.discordToken) {
      return json({ ok: false, error: 'DISCORD_BOT_TOKEN is missing' }, 503);
    }
    let body = {};
    try { body = await request.json(); } catch {}
    if (body.channel_id) {
      const client = new DiscordClient(config.discordToken);
      let channel = await getChannel(env.DB, body.channel_id);
      if (!channel) {
        channel = { channel_id: body.channel_id, guild_id: '' };
      }
      const result = await pollChannel(env.DB, client, channel);
      return json({ ok: true, result });
    }
    const result = await runScheduledPoll(env.DB, config.discordToken, config.messageRetentionHours || 48, env);
    return json({ ok: true, result });
  }

  // POST /api/monitoring/prune-messages - Manual retention prune & daily summarization
  if (path === '/api/monitoring/prune-messages' && method === 'POST') {
    const retentionHours = config.messageRetentionHours || 48;
    const result = await pruneAndSummarizeExpiredMessages(env.DB, retentionHours);
    await insertAuditLog(env.DB, 'messages_pruned_and_summarized', result);
    return json({ ok: true, result });
  }

  // 7. Messaging routes
  // POST /api/messaging/send - Send a message via Discord Bot or Webhook
  if (path === '/api/messaging/send' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON request body' }, 400);
    }

    const sendType = body.type === 'webhook' ? 'webhook' : 'bot';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const embeds = Array.isArray(body.embeds) && body.embeds.length > 0 ? body.embeds : undefined;

    if (!content && !embeds) {
      return json({ ok: false, error: 'Message content or an embed is required' }, 400);
    }

    if (content.length > 2000) {
      return json({ ok: false, error: 'Message content exceeds Discord 2,000 character limit' }, 400);
    }

    if (sendType === 'bot') {
      const channelId = typeof body.channel_id === 'string' ? body.channel_id.trim() : '';
      if (!channelId) {
        return json({ ok: false, error: 'Channel is required for Bot messaging' }, 400);
      }

      if (!config.discordToken) {
        return json({ ok: false, error: 'Discord bot token is not configured on this server' }, 503);
      }

      const channel = await getChannel(env.DB, channelId);
      const destinationName = channel ? `#${channel.name}` : `Channel ${channelId}`;
      const guildId = channel ? channel.guild_id : (body.guild_id || null);

      const replyToMessageId = body.reply_to_message_id ? String(body.reply_to_message_id).trim() : null;
      const mentionAuthor = Boolean(body.mention_author);

      const client = new DiscordClient(config.discordToken);
      try {
        const sent = await client.sendMessage(channelId, content, {
          replyToMessageId,
          mentionAuthor,
          embeds
        });

        const discordMessageId = sent ? sent.id : null;
        await insertSentMessage(env.DB, {
          sendType: 'bot',
          guildId,
          channelId,
          destinationName,
          discordMessageId,
          content,
          replyToMessageId,
          status: 'sent'
        });

        await insertAuditLog(env.DB, 'messaging_bot_sent', {
          channel_id: channelId,
          guild_id: guildId,
          discord_message_id: discordMessageId,
          reply_to: replyToMessageId
        });

        return json({
          ok: true,
          result: {
            sendType: 'bot',
            discordMessageId,
            destination: destinationName,
            channelId,
            guildId
          }
        });
      } catch (err) {
        await insertSentMessage(env.DB, {
          sendType: 'bot',
          guildId,
          channelId,
          destinationName,
          content,
          replyToMessageId,
          status: 'failed',
          errorMessage: err.message
        });

        return json({ ok: false, error: `Failed to send via bot: ${err.message}` }, 502);
      }
    } else {
      // sendType === 'webhook'
      const webhookUrl = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : '';
      if (!webhookUrl) {
        return json({ ok: false, error: 'Webhook URL is required' }, 400);
      }

      const username = body.username ? String(body.username).trim() : undefined;
      const avatarUrl = body.avatar_url ? String(body.avatar_url).trim() : undefined;

      try {
        const sent = await DiscordClient.sendWebhook(webhookUrl, {
          content,
          username,
          avatar_url: avatarUrl,
          embeds
        });

        const discordMessageId = sent ? sent.id : null;
        const channelId = sent ? sent.channel_id : null;
        const guildId = sent ? sent.guild_id : null;

        await insertSentMessage(env.DB, {
          sendType: 'webhook',
          guildId,
          channelId,
          destinationName: username || 'Webhook',
          discordMessageId,
          content,
          status: 'sent'
        });

        await insertAuditLog(env.DB, 'messaging_webhook_sent', {
          discord_message_id: discordMessageId,
          username
        });

        return json({
          ok: true,
          result: {
            sendType: 'webhook',
            discordMessageId,
            destination: username || 'Webhook'
          }
        });
      } catch (err) {
        await insertSentMessage(env.DB, {
          sendType: 'webhook',
          destinationName: username || 'Webhook',
          content,
          status: 'failed',
          errorMessage: err.message
        });

        return json({ ok: false, error: `Webhook error: ${err.message}` }, 502);
      }
    }
  }

  // GET /api/messaging/history - Get recent sent messages log
  if (path === '/api/messaging/history' && method === 'GET') {
    const history = await listSentMessages(env.DB, 25);
    return json({ ok: true, history });
  }

  // 8. Alerts & Settings Routes
  // GET /api/settings/alerts
  if (path === '/api/settings/alerts' && method === 'GET') {
    const settings = await getAlertSettings(env.DB);
    const hourlyCount = await getAlertCountLastHour(env.DB);
    return json({
      ok: true,
      settings,
      stats: {
        sent_last_hour: hourlyCount,
        max_per_hour: settings.max_per_hour
      },
      diagnostics: {
        resend_configured: Boolean(config.resendApiKey && config.resendApiKey.length > 0)
      }
    });
  }

  // PUT /api/settings/alerts
  if (path === '/api/settings/alerts' && method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON request body' }, 400);
    }

    const updated = await updateAlertSettings(env.DB, body);
    await insertAuditLog(env.DB, 'alert_settings_updated', updated);
    return json({ ok: true, settings: updated });
  }

  // POST /api/settings/alerts/test
  if (path === '/api/settings/alerts/test' && method === 'POST') {
    const settings = await getAlertSettings(env.DB);
    const testRecipient = settings.email_to || '7d8agt@mail.instinct.com';
    const timeIst = formatToIST(new Date().toISOString());

    const { subject, plainText, html } = formatAlertEmailContent({
      serverName: 'Sentinel Test Environment',
      channelName: 'system-alerts',
      authorName: 'Sentinel Security Bot',
      authorUsername: 'sentinel',
      authorId: '000000000000000000',
      timeIst,
      messageText: 'This is a test notification from the Sentinel Automated Alert Engine.\nIf you received this email, your notification pipeline is properly configured and operational.',
      matchReason: 'Manual Test Alert'
    });

    const sendRes = await sendAlertEmail(env, {
      to: testRecipient,
      subject,
      html,
      text: plainText
    });

    const alertId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO sent_alerts (
        id, message_id, guild_id, guild_name, channel_id, channel_name,
        author_id, author_name, content_preview, match_reason, recipient,
        status, sent_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      alertId,
      `test_${Date.now()}`,
      'test_guild',
      'Sentinel Test Environment',
      'test_channel',
      'system-alerts',
      '000000000000000000',
      'Sentinel Bot',
      'Manual Test Alert Triggered from Settings Page',
      'Manual Test Trigger',
      testRecipient,
      sendRes.status === 'no_api_key' ? 'simulated' : sendRes.status,
      new Date().toISOString(),
      sendRes.error || null
    ).run();

    return json({
      ok: true,
      result: {
        recipient: testRecipient,
        status: sendRes.status,
        success: sendRes.success,
        error: sendRes.error || null
      }
    });
  }

  // GET /api/alerts/history
  if (path === '/api/alerts/history' && method === 'GET') {
    const history = await listRecentAlerts(env.DB, 50);
    return json({ ok: true, history });
  }

  return json({ ok: false, error: 'Endpoint Not Found' }, 404);
}
