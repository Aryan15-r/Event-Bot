// src/utils/security.js
// Cryptographic security, session management, CSRF, and sanitization utilities

const textEncoder = new TextEncoder();

/**
 * Constant-time string equality check to mitigate timing attacks.
 * Hashes both strings with SHA-256 before comparing equal-length byte arrays.
 * @param {string} a 
 * @param {string} b 
 * @returns {Promise<boolean>}
 */
export async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  
  const hashA = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(a)));
  const hashB = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(b)));
  
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < hashA.length; i++) {
    mismatch |= hashA[i] ^ hashB[i];
  }
  return mismatch === 0 && a === b;
}

/**
 * Generates a cryptographically secure random session token.
 * 32 random bytes -> 64-char hexadecimal string.
 * @returns {string}
 */
export function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Computes the SHA-256 hash of a string (e.g. session token).
 * We store only session token hashes in the database.
 * @param {string} token 
 * @returns {Promise<string>}
 */
export async function hashToken(token) {
  if (!token) return '';
  const hash = await crypto.subtle.digest('SHA-256', textEncoder.encode(token));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Safely escapes HTML entities to prevent Cross-Site Scripting (XSS).
 * @param {string|null|undefined} str 
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validates that an attachment or external link uses a safe scheme (http/https).
 * Blocks javascript:, data:, and relative exploits.
 * @param {string|null|undefined} url 
 * @returns {string|null} Safe URL or null if invalid
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parses a standard Cookie header string into an object.
 * @param {string|null} cookieHeader 
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

/**
 * Builds the Set-Cookie string for an authenticated session.
 * @param {string} token 
 * @param {boolean} isSecure 
 * @param {number} maxAgeSec 
 * @returns {string}
 */
export function createSessionCookie(token, isSecure = true, maxAgeSec = 86400 * 7) {
  const parts = [
    `sentinel_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Builds the Set-Cookie string to expire a session cookie immediately.
 * @returns {string}
 */
export function createClearCookie() {
  return 'sentinel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

/**
 * Standard security headers applied to all responses.
 * @param {Record<string, string>} extraHeaders 
 * @returns {Record<string, string>}
 */
export function getSecurityHeaders(extraHeaders = {}) {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none';",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders
  };
}

/**
 * Validates request for CSRF protection on mutating methods (POST, PUT, DELETE).
 * Accepts requests with 'X-Sentinel-CSRF: 1' or valid Origin.
 * @param {Request} request 
 * @returns {boolean}
 */
export function verifyCsrf(request) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }
  
  const csrfHeader = request.headers.get('x-sentinel-csrf');
  if (csrfHeader === '1' || csrfHeader === 'true') {
    return true;
  }
  
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const reqUrl = new URL(request.url);
      return originUrl.host === reqUrl.host;
    } catch {
      return false;
    }
  }
  
  return false;
}
