// src/services/alerting.js
// Sentinel Automated Alert Engine: Rules Evaluation, Resend Dispatch, Deduplication & Rate Limiting

import { formatToIST } from '../utils/time.js';

export const DEFAULT_ALERT_SETTINGS = {
  alerts_enabled: true,
  email_to: '7d8agt@mail.instinct.com',
  user_ids: ['1561313029998518373'],
  keywords: ['help', 'urgent', 'emergency', 'need staff'],
  staff_roles: ['staff', 'admin', 'mod', 'moderator', 'lead', 'owner'],
  check_staff_roles: true,
  max_per_hour: 10
};

/**
 * Escapes special characters for RegExp.
 * @param {string} str 
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Retrieves the current alert settings from D1 with safe defaults.
 * @param {D1Database} db 
 * @returns {Promise<typeof DEFAULT_ALERT_SETTINGS & { updated_at: string }>}
 */
export async function getAlertSettings(db) {
  let row = await db.prepare('SELECT * FROM alert_settings WHERE id = ?').bind('default').first();
  if (!row) {
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT OR IGNORE INTO alert_settings (
        id, alerts_enabled, email_to, user_ids_json, keywords_json,
        staff_roles_json, check_staff_roles, max_per_hour, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      'default',
      DEFAULT_ALERT_SETTINGS.alerts_enabled ? 1 : 0,
      DEFAULT_ALERT_SETTINGS.email_to,
      JSON.stringify(DEFAULT_ALERT_SETTINGS.user_ids),
      JSON.stringify(DEFAULT_ALERT_SETTINGS.keywords),
      JSON.stringify(DEFAULT_ALERT_SETTINGS.staff_roles),
      DEFAULT_ALERT_SETTINGS.check_staff_roles ? 1 : 0,
      DEFAULT_ALERT_SETTINGS.max_per_hour,
      now,
      now
    ).run();

    row = await db.prepare('SELECT * FROM alert_settings WHERE id = ?').bind('default').first();
  }

  if (!row) {
    return { ...DEFAULT_ALERT_SETTINGS, updated_at: new Date().toISOString() };
  }

  let userIds = DEFAULT_ALERT_SETTINGS.user_ids;
  let keywords = DEFAULT_ALERT_SETTINGS.keywords;
  let staffRoles = DEFAULT_ALERT_SETTINGS.staff_roles;

  try {
    if (row.user_ids_json) userIds = JSON.parse(row.user_ids_json);
    if (row.keywords_json) keywords = JSON.parse(row.keywords_json);
    if (row.staff_roles_json) staffRoles = JSON.parse(row.staff_roles_json);
  } catch {
    // fallback to defaults on corrupt JSON
  }

  return {
    alerts_enabled: Boolean(row.alerts_enabled),
    email_to: row.email_to || DEFAULT_ALERT_SETTINGS.email_to,
    user_ids: Array.isArray(userIds) ? userIds : DEFAULT_ALERT_SETTINGS.user_ids,
    keywords: Array.isArray(keywords) ? keywords : DEFAULT_ALERT_SETTINGS.keywords,
    staff_roles: Array.isArray(staffRoles) ? staffRoles : DEFAULT_ALERT_SETTINGS.staff_roles,
    check_staff_roles: Boolean(row.check_staff_roles),
    max_per_hour: Number(row.max_per_hour) || 10,
    updated_at: row.updated_at || new Date().toISOString()
  };
}

/**
 * Updates the alert settings in D1.
 * @param {D1Database} db 
 * @param {Partial<typeof DEFAULT_ALERT_SETTINGS>} updates 
 */
export async function updateAlertSettings(db, updates = {}) {
  const current = await getAlertSettings(db);
  const now = new Date().toISOString();

  const alertsEnabled = updates.alerts_enabled !== undefined ? (updates.alerts_enabled ? 1 : 0) : (current.alerts_enabled ? 1 : 0);
  const emailTo = typeof updates.email_to === 'string' && updates.email_to.trim().length > 0 ? updates.email_to.trim() : current.email_to;
  
  let userIds = current.user_ids;
  if (Array.isArray(updates.user_ids)) {
    userIds = updates.user_ids.map(id => String(id).trim()).filter(id => id.length > 0);
  }

  let keywords = current.keywords;
  if (Array.isArray(updates.keywords)) {
    keywords = updates.keywords.map(kw => String(kw).trim()).filter(kw => kw.length > 0);
  }

  let staffRoles = current.staff_roles;
  if (Array.isArray(updates.staff_roles)) {
    staffRoles = updates.staff_roles.map(r => String(r).trim()).filter(r => r.length > 0);
  }

  const checkStaffRoles = updates.check_staff_roles !== undefined ? (updates.check_staff_roles ? 1 : 0) : (current.check_staff_roles ? 1 : 0);
  const maxPerHour = typeof updates.max_per_hour === 'number' && updates.max_per_hour > 0 ? Math.min(100, Math.floor(updates.max_per_hour)) : current.max_per_hour;

  await db.prepare(`
    INSERT INTO alert_settings (
      id, alerts_enabled, email_to, user_ids_json, keywords_json,
      staff_roles_json, check_staff_roles, max_per_hour, created_at, updated_at
    ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      alerts_enabled = excluded.alerts_enabled,
      email_to = excluded.email_to,
      user_ids_json = excluded.user_ids_json,
      keywords_json = excluded.keywords_json,
      staff_roles_json = excluded.staff_roles_json,
      check_staff_roles = excluded.check_staff_roles,
      max_per_hour = excluded.max_per_hour,
      updated_at = excluded.updated_at
  `).bind(
    alertsEnabled,
    emailTo,
    JSON.stringify(userIds),
    JSON.stringify(keywords),
    JSON.stringify(staffRoles),
    checkStaffRoles,
    maxPerHour,
    now,
    now
  ).run();

  return await getAlertSettings(db);
}

/**
 * Checks if a message has already been alerted (deduplication).
 * @param {D1Database} db 
 * @param {string} messageId 
 * @returns {Promise<boolean>}
 */
export async function isMessageAlerted(db, messageId) {
  if (!messageId) return false;
  const row = await db.prepare('SELECT 1 FROM sent_alerts WHERE message_id = ?').bind(messageId).first();
  return Boolean(row);
}

/**
 * Returns number of alerts dispatched or simulated in the past 1 hour.
 * @param {D1Database} db 
 * @returns {Promise<number>}
 */
export async function getAlertCountLastHour(db) {
  const row = await db.prepare(`
    SELECT COUNT(*) as count 
    FROM sent_alerts 
    WHERE (status = 'sent' OR status = 'simulated')
      AND sent_at >= datetime('now', '-1 hour')
  `).first();
  return (row && row.count) || 0;
}

/**
 * Evaluates a single message against the three alert rules.
 * Rule 1: Mention of the user's Discord ID.
 * Rule 2: The words "help", "urgent", "emergency", "need staff" (or configured keywords).
 * Rule 3: Any message from members with a staff role.
 * 
 * @param {any} message 
 * @param {typeof DEFAULT_ALERT_SETTINGS} settings 
 * @param {{ trackedStaffIds?: Set<string>, staffRoleNamesOrIds?: Set<string> }} [staffContext] 
 * @returns {{ matched: boolean, reason: string | null }}
 */
export function evaluateMessageAlert(message, settings, staffContext = {}) {
  if (!message) return { matched: false, reason: null };

  const content = message.content || '';
  const author = message.author || {};
  const authorId = String(author.id || message.author_id || '');
  const authorRoles = Array.isArray(author.role_ids)
    ? author.role_ids.map(String)
    : (typeof message.author_role_ids === 'string'
      ? (() => { try { return JSON.parse(message.author_role_ids); } catch { return []; } })()
      : []);

  // Collect text across content and embeds
  const textParts = [content];
  const embeds = Array.isArray(message.embeds)
    ? message.embeds
    : (typeof message.embeds_json === 'string'
      ? (() => { try { return JSON.parse(message.embeds_json); } catch { return []; } })()
      : []);

  for (const emb of embeds) {
    if (emb.title) textParts.push(emb.title);
    if (emb.description) textParts.push(emb.description);
    if (Array.isArray(emb.fields)) {
      for (const f of emb.fields) {
        if (f.name) textParts.push(f.name);
        if (f.value) textParts.push(f.value);
      }
    }
    if (emb.footer && emb.footer.text) textParts.push(emb.footer.text);
  }

  const fullText = textParts.join(' ');
  const lowerFullText = fullText.toLowerCase();

  // RULE 1: Mention of the user's Discord ID
  const userIds = settings.user_ids || DEFAULT_ALERT_SETTINGS.user_ids;
  for (const uid of userIds) {
    if (!uid) continue;
    // Check Discord mention tags <@ID>, <@!ID>, or raw ID string
    const mentionPattern = new RegExp(`(<@!?${escapeRegex(uid)}>|\\b${escapeRegex(uid)}\\b)`, 'i');
    if (mentionPattern.test(fullText)) {
      return {
        matched: true,
        reason: `Mention of Discord ID (${uid})`
      };
    }
  }

  // RULE 2: Specific words ("help", "urgent", "emergency", "need staff" or custom keywords)
  const keywords = settings.keywords || DEFAULT_ALERT_SETTINGS.keywords;
  for (const rawKw of keywords) {
    const kw = rawKw.trim();
    if (!kw) continue;

    if (kw.includes(' ')) {
      // Phrase matching (e.g. "need staff")
      if (lowerFullText.includes(kw.toLowerCase())) {
        return {
          matched: true,
          reason: `Contains keyword "${kw}"`
        };
      }
    } else {
      // Single word matching with word boundaries to avoid false positives (e.g. "help" matches "help!", but not "unhelpful")
      const wordRegex = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
      if (wordRegex.test(fullText)) {
        return {
          matched: true,
          reason: `Contains keyword "${kw}"`
        };
      }
    }
  }

  // RULE 3: Message from members with a staff role
  if (settings.check_staff_roles) {
    const configuredStaffRoles = (settings.staff_roles || DEFAULT_ALERT_SETTINGS.staff_roles).map(r => r.toLowerCase().trim());
    const staffRoleSet = staffContext.staffRoleNamesOrIds || new Set(configuredStaffRoles);
    const trackedStaffIds = staffContext.trackedStaffIds || new Set();

    // 3a. Check member role IDs
    for (const rId of authorRoles) {
      if (staffRoleSet.has(String(rId).toLowerCase())) {
        return {
          matched: true,
          reason: `Author has staff role (Role ID: ${rId})`
        };
      }
    }

    // 3b. Check if author is flagged in tracked_members as staff/admin/mod
    if (authorId && trackedStaffIds.has(authorId)) {
      return {
        matched: true,
        reason: `Author is a designated staff member (ID: ${authorId})`
      };
    }

    // 3c. Check if author username/display name contains staff tags like [Staff], [Admin], [Mod], etc.
    const authorName = (author.display_name || author.username || message.author_display_name || message.author_username || '').toLowerCase();
    for (const roleKeyword of configuredStaffRoles) {
      if (roleKeyword && (authorName.includes(`[${roleKeyword}]`) || authorName.includes(`(${roleKeyword})`) || authorName.startsWith(`${roleKeyword} `))) {
        return {
          matched: true,
          reason: `Author name indicates staff designation (${authorName})`
        };
      }
    }
  }

  return { matched: false, reason: null };
}

/**
 * Sends an email using the Resend REST API or Cloudflare Email service.
 * @param {Record<string, any>} env 
 * @param {{ to: string, subject: string, html: string, text: string }} payload 
 * @returns {Promise<{ success: boolean, status: string, id?: string, error?: string }>}
 */
export async function sendAlertEmail(env, { to, subject, html, text }) {
  const apiKey = (env.RESEND_API_KEY || '').trim();

  // If no Resend API key is configured in Worker secrets, record simulated alert
  if (!apiKey) {
    return {
      success: false,
      status: 'no_api_key',
      error: 'RESEND_API_KEY secret is not configured in Worker environment'
    };
  }

  const fromEmail = (env.ALERT_FROM_EMAIL || 'Sentinel <onboarding@resend.dev>').trim();

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: subject || 'Sentinel alert',
        html,
        text
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        status: 'failed',
        error: `Resend HTTP ${response.status}: ${errText}`
      };
    }

    const data = await response.json();
    return {
      success: true,
      status: 'sent',
      id: data && data.id ? data.id : 'resend_ok'
    };
  } catch (err) {
    return {
      success: false,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Formats email body HTML and text for a Sentinel alert.
 */
export function formatAlertEmailContent({ serverName, channelName, authorName, authorUsername, authorId, timeIst, messageText, matchReason }) {
  const subject = 'Sentinel alert';

  const plainText = [
    '========================================',
    '          SENTINEL SECURITY ALERT        ',
    '========================================',
    `Trigger Reason : ${matchReason}`,
    `Server         : ${serverName}`,
    `Channel        : #${channelName}`,
    `Author         : ${authorName} (@${authorUsername}) [ID: ${authorId}]`,
    `Time (IST)     : ${timeIst}`,
    '----------------------------------------',
    'Message Text:',
    messageText || '(Empty content or embed only)',
    '----------------------------------------',
    'Sentinel Read-Only Discord Monitor • Automated Alert Engine',
    'Deduplicated & Capped at 10 alerts/hour'
  ].join('\n');

  const safeServer = escapeHtml(serverName);
  const safeChannel = escapeHtml(channelName);
  const safeAuthor = escapeHtml(`${authorName} (@${authorUsername})`);
  const safeAuthorId = escapeHtml(authorId);
  const safeTime = escapeHtml(timeIst);
  const safeReason = escapeHtml(matchReason);
  const safeMessage = escapeHtml(messageText || '(No text content — embed/attachment)');

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0e14; color: #e1e7ec; margin: 0; padding: 24px; }
    .card { max-width: 600px; margin: 0 auto; background-color: #121824; border: 1px solid #1f293d; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .header { background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); padding: 20px 24px; color: #ffffff; }
    .badge { display: inline-block; background-color: rgba(255,255,255,0.2); padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
    .body { padding: 24px; }
    .grid { display: grid; grid-template-columns: 110px 1fr; gap: 10px 16px; margin-bottom: 20px; font-size: 14px; }
    .label { color: #8899a6; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; padding-top: 2px; }
    .value { color: #f1f5f9; font-weight: 500; }
    .message-box { background-color: #0d121c; border-left: 4px solid #ef4444; border-radius: 0 8px 8px 0; padding: 16px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 13px; line-height: 1.5; color: #f8fafc; white-space: pre-wrap; word-break: break-word; }
    .footer { padding: 16px 24px; background-color: #0d121c; border-top: 1px solid #1f293d; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="badge">Sentinel Security Alert</div>
      <h1 class="title">Match: ${safeReason}</h1>
    </div>
    <div class="body">
      <div class="grid">
        <div class="label">Server</div>
        <div class="value"><strong>${safeServer}</strong></div>

        <div class="label">Channel</div>
        <div class="value">#${safeChannel}</div>

        <div class="label">Author</div>
        <div class="value">${safeAuthor} <span style="color:#64748b; font-size:12px;">(ID: ${safeAuthorId})</span></div>

        <div class="label">Time (IST)</div>
        <div class="value"><strong>${safeTime}</strong></div>
      </div>

      <div style="margin-top: 20px; margin-bottom: 8px;" class="label">Message Content</div>
      <div class="message-box">${safeMessage}</div>
    </div>
    <div class="footer">
      Sentinel Discord Monitor • Automated Notification Engine • Capped at 10 alerts/hr
    </div>
  </div>
</body>
</html>
  `;

  return { subject, plainText, html };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Scans newly stored messages after a 5-minute poll against alert rules.
 * Deduplicates per message, enforces the 10 alerts/hour cap, and sends alerts.
 * 
 * @param {D1Database} db 
 * @param {Record<string, any>} env 
 * @param {any[]} newMessages 
 * @returns {Promise<{ scanned: number, matchedCount: number, sentCount: number, rateLimitedCount: number }>}
 */
export async function checkAndDispatchAlerts(db, env = {}, newMessages = []) {
  if (!db || !Array.isArray(newMessages) || newMessages.length === 0) {
    return { scanned: 0, matchedCount: 0, sentCount: 0, rateLimitedCount: 0 };
  }

  const settings = await getAlertSettings(db);
  if (!settings.alerts_enabled) {
    return { scanned: newMessages.length, matchedCount: 0, sentCount: 0, rateLimitedCount: 0, disabled: true };
  }

  // Load staff context (tracked members with staff labels)
  const trackedRows = await db.prepare('SELECT member_id, label FROM tracked_members').all().catch(() => ({ results: [] }));
  const trackedStaffIds = new Set();
  const staffRegex = /staff|admin|mod|moderator|owner|lead/i;
  for (const row of (trackedRows.results || [])) {
    if (row.label && staffRegex.test(row.label)) {
      trackedStaffIds.add(String(row.member_id));
    }
  }

  const staffRoleNamesOrIds = new Set(
    (settings.staff_roles || []).map(r => String(r).toLowerCase().trim())
  );

  const staffContext = { trackedStaffIds, staffRoleNamesOrIds };

  // Guild and channel cache to avoid redundant queries
  const guildNameCache = new Map();
  const channelNameCache = new Map();

  let matchedCount = 0;
  let sentCount = 0;
  let rateLimitedCount = 0;

  for (const msg of newMessages) {
    const messageId = String(msg.id || msg.message_id || '');
    if (!messageId) continue;

    // 1. Deduplication check
    const alreadyAlerted = await isMessageAlerted(db, messageId);
    if (alreadyAlerted) {
      continue;
    }

    // 2. Evaluate rules
    const evaluation = evaluateMessageAlert(msg, settings, staffContext);
    if (!evaluation.matched) {
      continue;
    }

    matchedCount++;

    // Resolve channel and guild names
    const channelId = String(msg.channel_id || '');
    const guildId = String(msg.guild_id || '');

    let channelName = channelNameCache.get(channelId);
    let guildName = guildNameCache.get(guildId);

    if (!channelName || !guildName) {
      const chRow = await db.prepare(`
        SELECT c.name as channel_name, g.name as guild_name 
        FROM channels c 
        LEFT JOIN guilds g ON c.guild_id = g.guild_id 
        WHERE c.channel_id = ?
      `).bind(channelId).first().catch(() => null);

      channelName = (chRow && chRow.channel_name) || 'unknown-channel';
      guildName = (chRow && chRow.guild_name) || 'Discord Server';
      channelNameCache.set(channelId, channelName);
      guildNameCache.set(guildId, guildName);
    }

    const author = msg.author || {};
    const authorName = author.display_name || author.username || msg.author_display_name || msg.author_username || 'Unknown Author';
    const authorUsername = author.username || msg.author_username || 'unknown';
    const authorId = String(author.id || msg.author_id || '0');

    // Extract message preview text (including embeds)
    let messageText = msg.content || '';
    const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
    if (embeds.length > 0) {
      const embedDescs = embeds.map(e => [e.title, e.description].filter(Boolean).join(' - ')).filter(Boolean);
      if (embedDescs.length > 0) {
        messageText = messageText ? `${messageText}\n[Embed: ${embedDescs.join(' | ')}]` : `[Embed: ${embedDescs.join(' | ')}]`;
      }
    }

    const timeIso = msg.timestamp || msg.created_at || new Date().toISOString();
    const timeIst = formatToIST(timeIso);

    // 3. Hourly Rate Limit Check (cap at 10 alerts/hour or settings.max_per_hour)
    const currentHourCount = await getAlertCountLastHour(db);
    const alertId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    if (currentHourCount >= settings.max_per_hour) {
      rateLimitedCount++;
      await db.prepare(`
        INSERT INTO sent_alerts (
          id, message_id, guild_id, guild_name, channel_id, channel_name,
          author_id, author_name, content_preview, match_reason, recipient,
          status, sent_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        alertId,
        messageId,
        guildId,
        guildName,
        channelId,
        channelName,
        authorId,
        authorName,
        messageText.slice(0, 500),
        evaluation.reason,
        settings.email_to,
        'rate_limited',
        nowIso,
        `Hourly rate limit reached (${currentHourCount}/${settings.max_per_hour})`
      ).run();
      continue;
    }

    // 4. Format and Send Email
    const { subject, plainText, html } = formatAlertEmailContent({
      serverName: guildName,
      channelName,
      authorName,
      authorUsername,
      authorId,
      timeIst,
      messageText,
      matchReason: evaluation.reason
    });

    const emailResult = await sendAlertEmail(env, {
      to: settings.email_to,
      subject,
      html,
      text: plainText
    });

    const status = emailResult.status; // 'sent' | 'no_api_key' | 'failed'
    const errorMsg = emailResult.error || null;

    if (emailResult.success || status === 'no_api_key') {
      sentCount++;
    }

    // 5. Store sent_alert record (with message_id UNIQUE constraint)
    await db.prepare(`
      INSERT INTO sent_alerts (
        id, message_id, guild_id, guild_name, channel_id, channel_name,
        author_id, author_name, content_preview, match_reason, recipient,
        status, sent_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).bind(
      alertId,
      messageId,
      guildId,
      guildName,
      channelId,
      channelName,
      authorId,
      authorName,
      messageText.slice(0, 500),
      evaluation.reason,
      settings.email_to,
      status === 'no_api_key' ? 'simulated' : status,
      nowIso,
      errorMsg
    ).run();
  }

  return {
    scanned: newMessages.length,
    matchedCount,
    sentCount,
    rateLimitedCount
  };
}

/**
 * Lists recent sent alerts for dashboard viewing.
 * @param {D1Database} db 
 * @param {number} limit 
 * @returns {Promise<any[]>}
 */
export async function listRecentAlerts(db, limit = 50) {
  const { results } = await db.prepare(`
    SELECT * FROM sent_alerts
    ORDER BY sent_at DESC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}
