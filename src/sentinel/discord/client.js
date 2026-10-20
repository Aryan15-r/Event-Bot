// src/discord/client.js
// Discord REST API v10 Client with rate-limit handling, retries, and error mapping

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (SentinelMonitoring, 1.0.0)';

export class DiscordApiError extends Error {
  /**
   * @param {string} message 
   * @param {number} status 
   * @param {any} [data] 
   * @param {number} [retryAfter] 
   */
  constructor(message, status, data = null, retryAfter = 0) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
    this.isRateLimit = status === 429;
    this.isUnauthorized = status === 401;
    this.isForbidden = status === 403;
    this.isNotFound = status === 404;
  }
}

export class DiscordClient {
  /**
   * @param {string} botToken 
   */
  constructor(botToken) {
    if (!botToken || typeof botToken !== 'string') {
      throw new Error('Discord bot token is required');
    }
    this.token = botToken.trim();
    this.roleCache = new Map(); // guildId -> roles array
  }

  /**
   * Performs an authenticated request to the Discord REST API with 429 handling.
   * @private
   */
  async request(endpoint, options = {}, retries = 2) {
    const url = endpoint.startsWith('http') ? endpoint : `${DISCORD_API_BASE}${endpoint}`;
    const headers = {
      'Authorization': `Bot ${this.token}`,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      ...options.headers
    };

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (response.status === 429) {
      const retryHeader = response.headers.get('retry-after');
      let retryAfterMs = retryHeader ? parseFloat(retryHeader) * 1000 : 1000;
      
      let errorData = null;
      try {
        errorData = await response.json();
        if (errorData.retry_after) {
          retryAfterMs = errorData.retry_after * 1000;
        }
      } catch {}

      if (retries > 0 && retryAfterMs <= 5000) {
        await new Promise(r => setTimeout(r, retryAfterMs));
        return this.request(endpoint, options, retries - 1);
      }

      throw new DiscordApiError(`Discord API rate limit hit. Retry after ${Math.ceil(retryAfterMs / 1000)}s`, 429, errorData, retryAfterMs / 1000);
    }

    if (!response.ok) {
      let errorData = null;
      try {
        errorData = await response.json();
      } catch {
        errorData = await response.text();
      }

      const msg = (errorData && errorData.message) || response.statusText || 'Discord API Request Failed';
      throw new DiscordApiError(`Discord API error (${response.status}): ${msg}`, response.status, errorData);
    }

    if (response.status === 204) {
      return null;
    }

    return await response.json();
  }

  /**
   * Retrieves the current bot user profile.
   */
  async getCurrentUser() {
    return await this.request('/users/@me');
  }

  /**
   * Retrieves guilds the bot is a member of.
   * Handles pagination if bot is in more than 100 guilds.
   */
  async getBotGuilds() {
    const guilds = [];
    let after = undefined;
    
    while (true) {
      const query = new URLSearchParams({ limit: '100' });
      if (after) query.set('after', after);
      
      const page = await this.request(`/users/@me/guilds?${query.toString()}`);
      if (!Array.isArray(page) || page.length === 0) break;
      
      guilds.push(...page);
      if (page.length < 100) break;
      after = page[page.length - 1].id;
    }

    return guilds;
  }

  /**
   * Retrieves detailed guild info with member counts.
   * @param {string} guildId 
   */
  async getGuild(guildId) {
    return await this.request(`/guilds/${guildId}?with_counts=true`);
  }

  /**
   * Retrieves all channels in a guild.
   * @param {string} guildId 
   */
  async getGuildChannels(guildId) {
    return await this.request(`/guilds/${guildId}/channels`);
  }

  /**
   * Retrieves all roles in a guild.
   * @param {string} guildId 
   */
  async getGuildRoles(guildId) {
    if (this.roleCache.has(guildId)) {
      return this.roleCache.get(guildId);
    }
    const roles = await this.request(`/guilds/${guildId}/roles`);
    this.roleCache.set(guildId, roles);
    return roles;
  }

  /**
   * Fetches messages from a channel.
   * Supports `limit`, `after`, and `before` options.
   * @param {string} channelId 
   * @param {{ limit?: number, after?: string, before?: string }} [options] 
   */
  async getChannelMessages(channelId, options = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(Math.min(100, options.limit)));
    if (options.after) params.set('after', options.after);
    if (options.before) params.set('before', options.before);

    const queryStr = params.toString();
    const endpoint = `/channels/${channelId}/messages${queryStr ? `?${queryStr}` : ''}`;
    return await this.request(endpoint);
  }

  /**
   * Sends a message to a channel, optionally referencing another message (reply) or embedding.
   * @param {string} channelId 
   * @param {string} content 
   * @param {{ replyToMessageId?: string, mentionAuthor?: boolean, embeds?: any[] }} [options]
   */
  async sendMessage(channelId, content, options = {}) {
    const body = {};
    if (content != null && content !== '') {
      body.content = content;
    }
    if (Array.isArray(options.embeds) && options.embeds.length > 0) {
      body.embeds = options.embeds;
    }
    if (options.replyToMessageId) {
      body.message_reference = {
        message_id: String(options.replyToMessageId).trim()
      };
      if (typeof options.mentionAuthor === 'boolean') {
        body.allowed_mentions = {
          replied_user: options.mentionAuthor
        };
      }
    }
    return await this.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      body
    });
  }

  /**
   * Sends a message via a Discord Webhook URL.
   * @param {string} webhookUrl 
   * @param {{ content: string, username?: string, avatar_url?: string, embeds?: any[] }} payload 
   */
  static async sendWebhook(webhookUrl, payload) {
    if (!webhookUrl || typeof webhookUrl !== 'string') {
      throw new Error('Webhook URL is required');
    }

    const trimmedUrl = webhookUrl.trim();
    // Validate that webhook URL belongs to discord domain
    try {
      const parsed = new URL(trimmedUrl);
      const validHosts = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'];
      if (!validHosts.includes(parsed.hostname.toLowerCase())) {
        throw new Error('Invalid webhook host. Must be a discord.com webhook URL');
      }
      if (!parsed.pathname.startsWith('/api/webhooks/')) {
        throw new Error('Invalid webhook URL format. Expected /api/webhooks/{id}/{token}');
      }
    } catch (e) {
      throw new Error(`Invalid webhook URL: ${e.message}`);
    }

    // Append ?wait=true so Discord returns message JSON
    const urlObj = new URL(trimmedUrl);
    urlObj.searchParams.set('wait', 'true');

    const bodyObj = {
      content: payload.content
    };
    if (payload.username && payload.username.trim()) {
      bodyObj.username = payload.username.trim();
    }
    if (payload.avatar_url && payload.avatar_url.trim()) {
      bodyObj.avatar_url = payload.avatar_url.trim();
    }
    if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
      bodyObj.embeds = payload.embeds;
    }

    const res = await fetch(urlObj.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify(bodyObj)
    });

    if (!res.ok) {
      let errBody;
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text();
      }
      const msg = (errBody && errBody.message) || res.statusText || 'Webhook request failed';
      throw new DiscordApiError(`Discord Webhook error (${res.status}): ${msg}`, res.status, errBody);
    }

    return await res.json().catch(() => null);
  }
}
