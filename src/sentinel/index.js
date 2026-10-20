// src/index.js
// Sentinel Cloudflare Worker Entry Point — Fetch & Cron Scheduled Event Dispatcher

import { getConfig } from './config.js';
import { handleHealth } from './services/health.js';
import { handleDigest } from './services/digest.js';
import { handleReply } from './services/replies.js';
import { handleApiRoute } from './routes/api.js';
import { handleQuickSendRoute } from './routes/quick-send.js';
import { handleDashboardPage } from './ui/html.js';
import { STYLES_CSS, APP_JS, ASSETS_VERSION } from './ui/assets.js';
import { runScheduledPoll } from './services/polling.js';
import { ensureSchema } from './db/schema.js';

let schemaPromise = null;

/**
 * Ensures the D1 schema (and any pending column migrations) exists.
 * Runs at most once per isolate. Failures are logged but never propagated —
 * a transient D1 outage must not take down the dashboard or its assets.
 */
function ensureSchemaReady(env) {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(env.DB)
      .then(() => {
        console.log('[Sentinel Schema] Schema verified');
      })
      .catch((err) => {
        console.error('[Sentinel Schema] Failed to ensure schema:', err.message);
        schemaPromise = null; // allow the next request to retry
      });
  }
  return schemaPromise;
}

/**
 * Serves a frontend asset with cache-safe headers.
 * Versioned requests (?v=<ASSETS_VERSION>) are immutable and cached for a year;
 * unversioned requests are always revalidated via ETag.
 * @param {Request} request
 * @param {string} body
 * @param {string} contentType
 * @returns {Response}
 */
function serveAsset(request, body, contentType) {
  const url = new URL(request.url);
  const requestedVersion = url.searchParams.get('v');
  const isVersioned = requestedVersion === ASSETS_VERSION;
  const etag = `"${ASSETS_VERSION}"`;

  const headers = {
    'Content-Type': contentType,
    'ETag': etag,
    'Vary': 'Accept-Encoding'
  };

  if (isVersioned) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.split(',').some(t => t.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { status: 200, headers });
}

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

      // 2. Ensure D1 schema exists (incl. column migrations) before serving API traffic
      await ensureSchemaReady(env);

      // 3. Public Operational & Diagnostic Endpoints
      if (path === '/health' && method === 'GET') {
        return await handleHealth(request, env);
      }

      if (path === '/digest' && method === 'GET') {
        return await handleDigest(request, env);
      }

      // 4. Optional Discord Write Endpoint (Replies)
      if (path === '/reply' && method === 'POST') {
        return await handleReply(request, env);
      }

      // 4b. Quick-send (bearer-token auth, no session cookie)
      if (path.startsWith('/api/quick-send')) {
        return await handleQuickSendRoute(request, env, ctx);
      }

      // 5. Authenticated REST API Routes
      if (path.startsWith('/api/')) {
        return await handleApiRoute(request, env, ctx);
      }

      // 6. Static UI Assets
      // The ?v=<content hash> param makes each build a distinct URL, so a deploy
      // invalidates stale browser caches immediately. Unversioned requests stay
      // revalidated (no-cache + ETag) so they never serve a stale bundle.
      if (path === '/styles.css' && method === 'GET') {
        return serveAsset(request, STYLES_CSS, 'text/css; charset=utf-8');
      }

      if (path === '/app.js' && method === 'GET') {
        return serveAsset(request, APP_JS, 'application/javascript; charset=utf-8');
      }

      // 7. Dashboard Frontend Shell (SPA routes)
      if (['/', '/login', '/servers', '/channels', '/messages', '/messaging', '/formatter', '/settings', '/health-view'].includes(path) || !path.includes('.')) {
        return handleDashboardPage();
      }

      // 8. Unmatched resource fallback
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
        await ensureSchemaReady(env);
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
