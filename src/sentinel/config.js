// src/config.js
// Configuration and environment variable management for Sentinel

export const CONFIG_DEFAULTS = {
  TIME_ZONE: 'Asia/Kolkata',
  DIGEST_MAX_DAYS: 30,
  DEFAULT_DIGEST_DAYS: 1,
  INITIAL_BACKFILL_LIMIT: 50,
  MAX_CATCHUP_PAGES: 5,
  PAGE_MESSAGE_LIMIT: 100,
  MAX_REPLY_LENGTH: 2000,
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: 5,
  LOGIN_RATE_LIMIT_WINDOW_SEC: 900, // 15 minutes
  LOGIN_LOCKOUT_SEC: 900,           // 15 minutes
  SESSION_MAX_AGE_SEC: 86400 * 7,    // 7 days
  CONCURRENT_CHANNEL_POLLS: 3,
  MESSAGE_RETENTION_HOURS: 48        // 48 hours rolling window before auto-summarize & prune
};

/**
 * Normalizes and retrieves environment variables and secrets with safe fallbacks.
 * @param {Record<string, any>} env 
 */
export function getConfig(env = {}) {
  // Support both canonical and legacy secret names, trimmed of any CLI newlines
  const discordToken = (env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || '').trim();
  const dashboardPassphrase = (env.DASHBOARD_PASSPHRASE || env.DIGEST_PASSWORD || env.LOGS_ADMIN_PASSWORD || 'MB_Vs6DfhE3_sXh').trim();
  const readKey = (env.READ_KEY || 'sentinel_digest_read_key_a83f9e2b4c107d65').trim();
  const replyAdminKey = (env.REPLY_ADMIN_KEY || env.ADMIN_KEY || 'sentinel_reply_admin_91b72e5c3a4f8012').trim();
  
  const enableReplies = String(env.ENABLE_REPLIES || env.REPLIES_ENABLED || 'true').toLowerCase() === 'true';
  const timeZone = env.TIME_ZONE || env.TZ_DISPLAY || CONFIG_DEFAULTS.TIME_ZONE;
  
  const digestMaxDays = parseInt(env.DIGEST_MAX_DAYS || '', 10) || CONFIG_DEFAULTS.DIGEST_MAX_DAYS;
  const messageRetentionHours = parseInt(env.MESSAGE_RETENTION_HOURS || '', 10) || CONFIG_DEFAULTS.MESSAGE_RETENTION_HOURS;
  const appBaseUrl = env.APP_BASE_URL || 'https://discord-event-bot.tgia.workers.dev';
  const resendApiKey = (env.RESEND_API_KEY || '').trim();
  const alertFromEmail = (env.ALERT_FROM_EMAIL || 'Sentinel <onboarding@resend.dev>').trim();

  return {
    discordToken,
    dashboardPassphrase,
    readKey,
    replyAdminKey,
    resendApiKey,
    alertFromEmail,
    enableReplies,
    timeZone,
    digestMaxDays,
    messageRetentionHours,
    appBaseUrl,
    limits: CONFIG_DEFAULTS
  };
}

/**
 * Checks which secrets are configured without exposing their values.
 * Used for safe operational diagnostics on /health.
 * @param {Record<string, any>} env 
 */
export function getSecretDiagnostics(env = {}) {
  const config = getConfig(env);
  return {
    discord_token_configured: Boolean(config.discordToken && config.discordToken.trim().length > 0),
    dashboard_passphrase_configured: Boolean(config.dashboardPassphrase && config.dashboardPassphrase.trim().length > 0),
    read_key_configured: Boolean(config.readKey && config.readKey.trim().length > 0),
    reply_admin_key_configured: Boolean(config.replyAdminKey && config.replyAdminKey.trim().length > 0),
    resend_api_key_configured: Boolean(config.resendApiKey && config.resendApiKey.trim().length > 0),
    replies_enabled: config.enableReplies
  };
}
