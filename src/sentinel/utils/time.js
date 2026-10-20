// src/utils/time.js
// Discord Snowflake operations and IST / UTC timezone utilities

export const DISCORD_EPOCH = 1420070400000n;
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Converts a Discord snowflake string into a millisecond timestamp (number).
 * @param {string} snowflake 
 * @returns {number}
 */
export function snowflakeToTimestamp(snowflake) {
  if (!snowflake) return 0;
  try {
    const ms = (BigInt(snowflake) >> 22n) + DISCORD_EPOCH;
    return Number(ms);
  } catch {
    return 0;
  }
}

/**
 * Converts a Discord snowflake string into an ISO UTC string.
 * @param {string} snowflake 
 * @returns {string}
 */
export function snowflakeToIso(snowflake) {
  const ts = snowflakeToTimestamp(snowflake);
  if (!ts) return new Date().toISOString();
  return new Date(ts).toISOString();
}

/**
 * Correctly compares two Discord snowflake string identifiers.
 * Prevents JavaScript 64-bit float precision loss.
 * @param {string} a 
 * @param {string} b 
 * @returns {-1 | 0 | 1}
 */
export function compareSnowflakes(a, b) {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  try {
    const bigA = BigInt(a);
    const bigB = BigInt(b);
    if (bigA < bigB) return -1;
    if (bigA > bigB) return 1;
    return 0;
  } catch {
    // String fallback if either is somehow not a valid integer string
    return a.localeCompare(b);
  }
}

/**
 * Formats a Date or UTC ISO string into a human-readable string in Asia/Kolkata (IST).
 * @param {Date|string|number} date 
 * @param {string} [timeZone] 
 * @returns {string} e.g. "18 Oct 2026, 3:45 PM IST"
 */
export function formatToIST(date, timeZone = DEFAULT_TIMEZONE) {
  if (!date) return 'N/A';
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date : String(date));
  if (isNaN(d.getTime())) return 'Invalid Date';
  
  try {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    return `${formatter.format(d)} IST`;
  } catch {
    return d.toLocaleString() + ' UTC';
  }
}

/**
 * Formats date into a day heading for grouping (e.g. "Sunday, 18 October 2026").
 * @param {Date|string|number} date 
 * @param {string} [timeZone] 
 * @returns {string}
 */
export function formatDateHeadingIST(date, timeZone = DEFAULT_TIMEZONE) {
  if (!date) return 'Unknown Date';
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date : String(date));
  if (isNaN(d.getTime())) return 'Unknown Date';

  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

/**
 * Formats the time only in IST (e.g. "03:45 PM IST").
 * @param {Date|string|number} date 
 * @param {string} [timeZone] 
 * @returns {string}
 */
export function formatTimeIST(date, timeZone = DEFAULT_TIMEZONE) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date : String(date));
  if (isNaN(d.getTime())) return '';

  try {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    return `${formatter.format(d)} IST`;
  } catch {
    return d.toLocaleTimeString();
  }
}

/**
 * Returns a UTC ISO date string representing the cutoff point for 'days' days ago.
 * @param {number} days 
 * @returns {string}
 */
export function getUtcCutoffIso(days = 1) {
  const ms = Math.max(1, days) * 86400 * 1000;
  return new Date(Date.now() - ms).toISOString();
}
