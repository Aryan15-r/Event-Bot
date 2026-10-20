// src/discord/discovery.js
// Guild and Channel discovery service with category resolution and access status tracking

import { DiscordClient, DiscordApiError } from './client.js';
import { upsertGuild, upsertDiscoveredChannels } from '../db/queries.js';

// Supported text-based channel types in Discord v10
export const SUPPORTED_CHANNEL_TYPES = new Set([
  0,  // GUILD_TEXT
  5,  // GUILD_ANNOUNCEMENT (news)
  15  // GUILD_FORUM
]);

/**
 * Discovers and syncs all guilds the bot belongs to into D1.
 * @param {D1Database} db 
 * @param {DiscordClient} client 
 * @returns {Promise<{ synced: number, errors: string[] }>}
 */
export async function syncGuilds(db, client) {
  const errors = [];
  let synced = 0;

  try {
    const rawGuilds = await client.getBotGuilds();
    for (const raw of rawGuilds) {
      try {
        // Fetch detailed counts if accessible
        let memberCount = null;
        try {
          const detail = await client.getGuild(raw.id);
          if (detail && typeof detail.approximate_member_count === 'number') {
            memberCount = detail.approximate_member_count;
          }
        } catch {
          // If counts fail, memberCount remains null (displays as 'Unavailable')
        }

        await upsertGuild(db, {
          guild_id: raw.id,
          name: raw.name,
          icon_hash: raw.icon,
          member_count: memberCount,
          access_status: 'active'
        });
        synced++;
      } catch (err) {
        errors.push(`Guild ${raw.id} sync failed: ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`Bot guilds discovery failed: ${err.message}`);
  }

  return { synced, errors };
}

/**
 * Discovers and syncs channels for a specific guild into D1.
 * Resolves category names for parent channels and preserves monitored flags.
 * @param {D1Database} db 
 * @param {DiscordClient} client 
 * @param {string} guildId 
 * @returns {Promise<{ total: number, supported: number, error: string | null }>}
 */
export async function syncGuildChannels(db, client, guildId) {
  try {
    const rawChannels = await client.getGuildChannels(guildId);
    if (!Array.isArray(rawChannels)) {
      return { total: 0, supported: 0, error: 'Invalid channel list returned by Discord' };
    }

    // Build category map: categoryId -> categoryName
    const categoryMap = new Map();
    for (const ch of rawChannels) {
      if (ch.type === 4) { // GUILD_CATEGORY
        categoryMap.set(ch.id, ch.name);
      }
    }

    // Filter to supported text channels
    const supportedChannels = [];
    for (const ch of rawChannels) {
      if (SUPPORTED_CHANNEL_TYPES.has(ch.type)) {
        supportedChannels.push({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parent_id: ch.parent_id || null,
          parent_name: ch.parent_id ? (categoryMap.get(ch.parent_id) || null) : null
        });
      }
    }

    await upsertDiscoveredChannels(db, guildId, supportedChannels);

    return {
      total: rawChannels.length,
      supported: supportedChannels.length,
      error: null
    };
  } catch (err) {
    let accessStatus = 'error';
    if (err instanceof DiscordApiError && (err.status === 403 || err.status === 404)) {
      accessStatus = 'unauthorized';
    }
    
    // Update access status on the guild so it displays accurately in the dashboard
    try {
      await upsertGuild(db, {
        guild_id: guildId,
        name: 'Unknown Guild',
        icon_hash: null,
        member_count: null,
        access_status: accessStatus
      });
    } catch {}

    return { total: 0, supported: 0, error: err.message };
  }
}
