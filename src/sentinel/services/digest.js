// src/services/digest.js
// Plain-text daily/interval digest feed with IST presentation and attention heuristics

import { timingSafeEqual } from '../utils/security.js';
import { getUtcCutoffIso, formatToIST, formatDateHeadingIST, formatTimeIST } from '../utils/time.js';
import { getMessagesForDigest, listTrackedMembers } from '../db/queries.js';
import { getConfig } from '../config.js';

// Keywords that indicate questions, blockers, or requests for help
const HELP_KEYWORDS = [
  'help', 'urgent', 'issue', 'error', 'bug', 'broken', 'problem',
  'assist', 'stuck', 'can someone', 'please check', 'failed', 'cannot', 'how to'
];

// Keywords indicating elevated authority in role names
const HIGH_ROLE_KEYWORDS = [
  'admin', 'owner', 'mod', 'moderator', 'lead', 'staff', 'founder', 'director'
];

/**
 * Checks if content indicates a question or help request.
 * @param {string} content 
 * @returns {boolean}
 */
export function isHelpOrQuestion(content) {
  if (!content) return false;
  if (content.includes('?')) return true;
  const lower = content.toLowerCase();
  return HELP_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Formats structured plain text digest feed.
 * @param {Request} request 
 * @param {Record<string, any>} env 
 * @returns {Promise<Response>}
 */
export async function handleDigest(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const config = getConfig(env);
  if (!config.readKey) {
    return new Response('Digest feed is unconfigured on this server (missing READ_KEY)', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  const url = new URL(request.url);
  const providedKey = url.searchParams.get('key') || '';

  // Constant-time key comparison
  const isKeyValid = await timingSafeEqual(providedKey, config.readKey);
  if (!isKeyValid) {
    return new Response('Unauthorized: Invalid or missing digest key', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // Parse days parameter
  const rawDays = url.searchParams.get('days');
  let days = config.limits.DEFAULT_DIGEST_DAYS;
  if (rawDays) {
    const parsed = parseInt(rawDays, 10);
    if (!isNaN(parsed) && parsed > 0) {
      days = Math.min(parsed, config.digestMaxDays);
    }
  }

  const cutoffIso = getUtcCutoffIso(days);
  const messages = await getMessagesForDigest(env.DB, cutoffIso);

  // Load tracked members for priority highlighting
  const trackedMembers = await listTrackedMembers(env.DB).catch(() => []);
  const trackedMap = new Map();
  for (const tm of trackedMembers) {
    trackedMap.set(String(tm.member_id), tm);
  }

  // Identify priority events for Instinct (from tracked VIP authors or direct pings)
  const priorityEvents = [];
  for (const msg of messages) {
    const authorTracked = trackedMap.get(String(msg.author_id));
    if (authorTracked && authorTracked.notify_on_messages !== 0) {
      priorityEvents.push({
        type: 'AUTHOR',
        label: authorTracked.label || authorTracked.member_id,
        memberId: authorTracked.member_id,
        msg
      });
    }

    // Parse embeds if any
    let msgEmbeds = [];
    try {
      msgEmbeds = JSON.parse(msg.embeds_json || '[]');
    } catch {}

    const embedText = msgEmbeds.map(e => `${e.title || ''} ${e.description || ''} ${(e.fields || []).map(f => `${f.name} ${f.value}`).join(' ')}`).join(' ');
    const combinedText = `${msg.content || ''} ${embedText}`;

    // Check if content or embed pings any tracked member (<@ID> or <@!ID>)
    for (const tm of trackedMembers) {
      if (tm.notify_on_pings !== 0) {
        const pingRegex = new RegExp(`<@!?${tm.member_id}>`, 'g');
        if (combinedText && pingRegex.test(combinedText)) {
          priorityEvents.push({
            type: 'PING',
            label: tm.label || tm.member_id,
            memberId: tm.member_id,
            msg
          });
        }
      }
    }
  }

  const now = new Date();
  const generationTimeIst = formatToIST(now, config.timeZone);

  const lines = [];
  lines.push('================================================================');
  lines.push('                       SENTINEL MONITORING DIGEST');
  lines.push('================================================================');
  lines.push(`Generated: ${generationTimeIst}`);
  lines.push(`Timeframe: Past ${days} day(s) (Since ${formatToIST(cutoffIso, config.timeZone)})`);
  lines.push(`Total Messages Captured: ${messages.length}`);
  if (trackedMembers.length > 0) {
    lines.push(`Tracked Priority Members: ${trackedMembers.length} configured`);
  }
  lines.push('Time Zone: ' + config.timeZone + ' (IST)');
  lines.push('================================================================\n');

  // Prominent Priority Alerts Section for Instinct Agent
  if (priorityEvents.length > 0) {
    lines.push('================================================================');
    lines.push(`⭐ PRIORITY ALERTS (FOR INSTINCT AGENT) — ${priorityEvents.length} CRITICAL ITEM(S)`);
    lines.push('================================================================');
    lines.push('⚠️ ATTENTION INSTINCT: Tracked VIP activity or direct pings detected!');
    lines.push('Please prioritize notifying the user immediately regarding:\n');

    for (const event of priorityEvents) {
      const timeStr = formatTimeIST(event.msg.created_at, config.timeZone);
      const server = event.msg.guild_name || 'Server ' + event.msg.guild_id;
      const channel = event.msg.channel_name ? `#${event.msg.channel_name}` : 'channel-' + event.msg.channel_id;
      const author = event.msg.author_display_name || event.msg.author_username || 'Unknown';
      const eventTag = event.type === 'AUTHOR' ? `[⭐ VIP MESSAGE: ${event.label}]` : `[🔔 VIP PINGED: ${event.label}]`;

      lines.push(`  • ${eventTag} [${timeStr}] in ${channel} (${server}) by ${author}:`);
      const snippetLines = (event.msg.content || '').split('\n');
      for (const sline of snippetLines) {
        lines.push(`      ${sline}`);
      }
    }
    lines.push('\n================================================================\n');
  }

  if (messages.length === 0) {
    lines.push('No new messages found across monitored channels for this period.');
    return new Response(lines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }

  // Group by Date Heading -> Server Name -> Channel Name
  const grouped = new Map();

  for (const msg of messages) {
    const dayHeading = formatDateHeadingIST(msg.created_at, config.timeZone);
    const serverName = msg.guild_name || 'Server ' + msg.guild_id;
    const channelName = msg.channel_name || 'channel-' + msg.channel_id;

    if (!grouped.has(dayHeading)) grouped.set(dayHeading, new Map());
    const serverMap = grouped.get(dayHeading);

    if (!serverMap.has(serverName)) serverMap.set(serverName, new Map());
    const channelMap = serverMap.get(serverName);

    if (!channelMap.has(channelName)) channelMap.set(channelName, []);
    channelMap.get(channelName).push(msg);
  }

  for (const [day, serverMap] of grouped.entries()) {
    lines.push(`\n📅 === ${day.toUpperCase()} ===\n`);

    for (const [server, channelMap] of serverMap.entries()) {
      lines.push(`🏛️  SERVER: ${server}`);
      lines.push('----------------------------------------------------------------');

      for (const [channel, channelMsgs] of channelMap.entries()) {
        lines.push(`\n  💬 #${channel} (${channelMsgs.length} messages)`);

        for (const msg of channelMsgs) {
          const timeStr = formatTimeIST(msg.created_at, config.timeZone);
          const author = msg.author_display_name || msg.author_username || 'Unknown';
          const username = msg.author_username ? `@${msg.author_username}` : '';
          
          let roleIds = [];
          try {
            roleIds = JSON.parse(msg.author_role_ids || '[]');
          } catch {}

          // Heuristic labels & tracked member tags
          const tags = [];

          const authorTracked = trackedMap.get(String(msg.author_id));
          if (authorTracked && authorTracked.notify_on_messages !== 0) {
            tags.push(`[⭐ VIP: ${authorTracked.label || authorTracked.member_id}]`);
          }

          for (const tm of trackedMembers) {
            if (tm.notify_on_pings !== 0) {
              const pingRegex = new RegExp(`<@!?${tm.member_id}>`, 'g');
              if (msg.content && pingRegex.test(msg.content)) {
                tags.push(`[🔔 PING: ${tm.label || tm.member_id}]`);
              }
            }
          }

          if (isHelpOrQuestion(msg.content)) {
            tags.push('[ATTENTION: HELP/QUESTION]');
          }
          if (msg.content && msg.content.includes('?')) {
            tags.push('[NEEDS RESPONSE]');
          }

          const tagPrefix = tags.length > 0 ? `${tags.join(' ')} ` : '';
          const authorLabel = username && username !== `@${author}` ? `${author} (${username})` : author;

          lines.push(`    • [${timeStr}] ${tagPrefix}${authorLabel}:`);

          // Message content with indented line breaks
          const contentLines = (msg.content || '').split('\n').filter(l => l.trim().length > 0);
          for (const line of contentLines) {
            lines.push(`        ${line}`);
          }

          // Render embeds if present
          let msgEmbeds = [];
          try {
            msgEmbeds = JSON.parse(msg.embeds_json || '[]');
          } catch {}

          if (msgEmbeds.length > 0) {
            for (const emb of msgEmbeds) {
              if (emb.title) lines.push(`        📋 [Embed: ${emb.title}]`);
              if (emb.description) {
                for (const dline of emb.description.split('\n')) {
                  lines.push(`            ${dline}`);
                }
              }
              if (Array.isArray(emb.fields) && emb.fields.length > 0) {
                for (const f of emb.fields) {
                  lines.push(`            • ${f.name}: ${f.value}`);
                }
              }
              if (emb.footer && emb.footer.text) {
                lines.push(`            -${emb.footer.text}`);
              }
            }
          }

          // Attachments
          let attachments = [];
          try {
            attachments = JSON.parse(msg.attachments_json || '[]');
          } catch {}

          if (attachments.length > 0) {
            for (const att of attachments) {
              lines.push(`        📎 Attachment: ${att.filename} (${att.url})`);
            }
          }

          if (contentLines.length === 0 && msgEmbeds.length === 0 && attachments.length === 0) {
            lines.push(`        (Empty message)`);
          }
        }
      }
      lines.push('');
    }
  }

  lines.push('\n================================================================');
  lines.push('                       END OF SENTINEL DIGEST');
  lines.push('================================================================');

  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
