'use strict';
/**
 * Single shared ADMIN_TOKEN guarding the admin and tender surfaces.
 * Swapping in per-user logins later means changing verify() and nothing else.
 */

const crypto = require('crypto');

const MAX_ATTEMPTS = Number(process.env.AUTH_MAX_ATTEMPTS || 8);
const LOCKOUT_MS = Number(process.env.AUTH_LOCKOUT_MS || 15 * 60 * 1000);

const attempts = new Map(); // ip -> { count, until }

function clientIp(req) {
  // app.set('trust proxy', 1) makes req.ip read x-forwarded-for correctly.
  // NOTE: proxy headers are NOT used to infer internal vs external. Every
  // request behind Render or Vercel carries them; such a check locks out
  // every user including the office.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual throws on length mismatch, which itself leaks length —
  // hash both to a fixed width first.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ba.length === bb.length;
}

function presentedToken(req) {
  return (
    req.get('x-admin-token') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    req.query?.token ||
    req.cookies?.admin_token ||
    ''
  );
}

function lockState(ip) {
  const rec = attempts.get(ip);
  if (!rec) return null;
  if (rec.until && rec.until > Date.now()) return rec;
  if (rec.until && rec.until <= Date.now()) attempts.delete(ip);
  return null;
}

function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.until = Date.now() + LOCKOUT_MS;
  attempts.set(ip, rec);
  return rec;
}

function verify(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return { ok: false, status: 500, message: 'ADMIN_TOKEN is not configured on the server.' };

  const ip = clientIp(req);
  const locked = lockState(ip);
  if (locked) {
    const secs = Math.ceil((locked.until - Date.now()) / 1000);
    return { ok: false, status: 429, message: `Too many failed attempts. Try again in ${secs}s.`, retry_after: secs };
  }

  if (safeEqual(presentedToken(req), expected)) {
    attempts.delete(ip);
    return { ok: true };
  }

  const rec = recordFailure(ip);
  const left = Math.max(0, MAX_ATTEMPTS - rec.count);
  return {
    ok: false,
    status: rec.until ? 429 : 401,
    message: rec.until
      ? `Too many failed attempts. Locked for ${Math.ceil(LOCKOUT_MS / 60000)} minutes.`
      : `Invalid token. ${left} attempt${left === 1 ? '' : 's'} remaining.`,
  };
}

/** Express middleware. */
function admin(req, res, next) {
  const r = verify(req);
  if (r.ok) return next();
  if (r.retry_after) res.set('Retry-After', String(r.retry_after));
  // A browser navigation gets the login page; anything else (fetch, curl,
  // an API client with no Accept header) gets JSON it can actually parse.
  const wantsHtml = req.method === 'GET' && /text\/html/.test(req.get('accept') || '');
  if (wantsHtml) {
    return res.status(r.status).sendFile(require('path').join(__dirname, '..', '..', 'public', 'login.html'));
  }
  return res.status(r.status).json({ error: r.message });
}

function _reset() { attempts.clear(); }

module.exports = { admin, verify, safeEqual, clientIp, _reset, MAX_ATTEMPTS, LOCKOUT_MS };
