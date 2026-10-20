// src/services/health.js
// Safe public health and operational diagnostics endpoint

import { getSecretDiagnostics, getConfig } from '../config.js';
import { getSystemMetrics, getLastPollRun } from '../db/queries.js';

/**
 * Handles GET /health requests.
 * Completely redacts any private data, message text, user IDs, or secret values.
 * @param {Request} request 
 * @param {Record<string, any>} env 
 * @returns {Promise<Response>}
 */
export async function handleHealth(request, env) {
  const config = getConfig(env);
  const secretStatus = getSecretDiagnostics(env);
  const warnings = [];

  // Check required configuration
  if (!secretStatus.discord_token_configured) {
    warnings.push('DISCORD_BOT_TOKEN secret is missing or empty.');
  }
  if (!secretStatus.dashboard_passphrase_configured) {
    warnings.push('DASHBOARD_PASSPHRASE secret is missing or empty.');
  }
  if (!secretStatus.read_key_configured) {
    warnings.push('READ_KEY secret is missing or empty.');
  }

  let dbConnected = false;
  let metrics = null;
  let lastPoll = null;

  try {
    metrics = await getSystemMetrics(env.DB);
    lastPoll = await getLastPollRun(env.DB);
    dbConnected = true;
  } catch (err) {
    warnings.push(`Database connection issue: ${err.message}`);
  }

  if (metrics && metrics.monitored_channels_count === 0) {
    warnings.push('No channels are currently enabled for monitoring.');
  }

  if (lastPoll) {
    if (lastPoll.status === 'failed') {
      warnings.push(`Last scheduled poll failed: ${lastPoll.error_summary || 'Unknown error'}`);
    } else if (lastPoll.status === 'partial_failure') {
      warnings.push(`Last scheduled poll had partial failures (${lastPoll.channels_failed} failed channels).`);
    }
  }

  // Determine overall status
  let overallStatus = 'ok';
  if (!dbConnected || !secretStatus.discord_token_configured) {
    overallStatus = 'degraded';
  } else if (warnings.length > 0) {
    overallStatus = 'warning';
  }

  const responseBody = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    timezone: config.timeZone,
    database_connected: dbConnected,
    secrets: {
      discord_bot_token: secretStatus.discord_token_configured,
      dashboard_passphrase: secretStatus.dashboard_passphrase_configured,
      read_key: secretStatus.read_key_configured,
      reply_admin_key: secretStatus.reply_admin_key_configured
    },
    replies_enabled: config.enableReplies,
    metrics: metrics ? {
      accessible_guilds: metrics.guilds_count,
      total_channels: metrics.channels_count,
      monitored_channels: metrics.monitored_channels_count,
      messages_stored: metrics.messages_count
    } : null,
    last_poll_run: lastPoll ? {
      id: lastPoll.id,
      started_at: lastPoll.started_at,
      finished_at: lastPoll.finished_at,
      status: lastPoll.status,
      channels_attempted: lastPoll.channels_attempted,
      channels_succeeded: lastPoll.channels_succeeded,
      channels_failed: lastPoll.channels_failed,
      messages_inserted: lastPoll.messages_inserted,
      messages_updated: lastPoll.messages_updated,
      error_summary: lastPoll.error_summary
    } : null,
    warnings
  };

  const statusCode = overallStatus === 'degraded' ? 503 : 200;

  return new Response(JSON.stringify(responseBody, null, 2), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}
