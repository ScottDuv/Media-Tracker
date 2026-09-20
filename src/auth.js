'use strict';

const crypto = require('crypto');

/**
 * Minimal stateless auth for the studio side. A correct password mints an
 * HMAC-signed token (value + expiry) that is stored in an httpOnly cookie.
 * No sessions to persist, and tampering is rejected by the signature check.
 *
 * Configure via env:
 *   STUDIO_PASSWORD  the studio login password (required in production)
 *   MT_SECRET        HMAC signing secret (auto-generated if unset)
 */

const PASSWORD = process.env.STUDIO_PASSWORD || 'changeme';
const SECRET = process.env.MT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const COOKIE = 'mt_studio';

if (!process.env.STUDIO_PASSWORD) {
  console.warn(
    '[auth] STUDIO_PASSWORD is not set — using the default "changeme". ' +
      'Set STUDIO_PASSWORD before exposing the studio side publicly.'
  );
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function checkPassword(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function mintToken() {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = `studio.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [scope, expires, mac] = parts;
  const payload = `${scope}.${expires}`;
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  if (Number(expires) < Date.now()) return false;
  return true;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function cookieHeader(token) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  // SameSite=None + Secure lets the studio work inside an iframe if ever needed;
  // fall back to Lax in non-production so localhost testing works over http.
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=${sameSite};${secure}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax;`;
}

module.exports = {
  COOKIE,
  checkPassword,
  mintToken,
  isAuthed,
  cookieHeader,
  clearCookieHeader,
};
