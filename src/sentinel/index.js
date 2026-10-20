// src/index.js
// Sentinel Cloudflare Worker Entry Point — Fetch & Cron Scheduled Event Dispatcher

import { getConfig } from './config.js';
import { handleHealth } from './services/health.js';
import { handleDigest } from './services/digest.js';
import { handleReply } from './services/replies.js';
import { handleApiRoute } from './routes/api.js';
import { handleDashboardPage } from './ui/html.js';
import { STYLES_CSS, APP_JS } from './ui/assets.js';
import { runScheduledPoll } from './services/polling.js';

export default {
  /**
   * HTTP Request Handler
   * @param {Request} request 
   * @param {Record<string, any>} env 
   * @param {ExecutionContext} ctx 
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      // 1. CORS Preflight
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sentinel-CSRF',
            'Access-Control-Max-Age': '86400'
          }
        });
      }

      // 2. Public Operational & Diagnostic Endpoints
      if (path === '/health' && method === 'GET') {
        return await handleHealth(request, env);
      }

      if (path === '/digest' && method === 'GET') {
        return await handleDigest(request, env);
      }

      // 3. Optional Discord Write Endpoint (Replies)
      if (path === '/reply' && method === 'POST') {
        return await handleReply(request, env);
      }

      // 4. Authenticated REST API Routes
      if (path.startsWith('/api/')) {
        return await handleApiRoute(request, env, ctx);
      }

      // 5. Static UI Assets
      if (path === '/styles.css' && method === 'GET') {
        return new Response(STYLES_CSS, {
          status: 200,
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }

      if (path === '/app.js' && method === 'GET') {
        return new Response(APP_JS, {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }

      // 6. Dashboard Frontend Shell (SPA routes)
      if (['/', '/login', '/servers', '/channels', '/messages', '/messaging', '/formatter', '/settings', '/health-view'].includes(path) || !path.includes('.')) {
        return handleDashboardPage();
      }

      // 7. Unmatched resource fallback
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      // Safe error response — Never expose message text or stack trace to client
      console.error('[Sentinel Error]', err.name, err.message);
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'An internal server error occurred.' }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store'
        }
      });
    }
  },

  /**
   * Cloudflare Workers Scheduled Cron Handler
   * Triggers every 5 minutes ("* / 5 * * * *")
   * @param {ScheduledEvent} event 
   * @param {Record<string, any>} env 
   * @param {ExecutionContext} ctx 
   */
  async scheduled(event, env, ctx) {
    console.log(`[Sentinel Cron] Started scheduled poll execution at ${new Date().toISOString()}`);
    const config = getConfig(env);

    const executionPromise = (async () => {
      try {
        const result = await runScheduledPoll(env.DB, config.discordToken, config.messageRetentionHours || 48, env);
        console.log(`[Sentinel Cron] Finished poll execution [Run ID: ${result.runId}] status: ${result.status}`, JSON.stringify(result.summary));
      } catch (err) {
        console.error('[Sentinel Cron] Unexpected failure during poll execution:', err.message);
      }
    })();

    // Ensure the runtime waits for asynchronous collection to finish
    ctx.waitUntil(executionPromise);
  }
};
