'use strict';
/**
 * Settings are read by the rule engine and pricing on nearly every request,
 * and the database is a network hop away — so cache them briefly.
 */

const { q } = require('./pool');

const TTL_MS = Number(process.env.SETTINGS_TTL_MS || 5000);
let cache = null;
let cachedAt = 0;

async function all() {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  const rows = await q.all(`SELECT key, value FROM settings`);
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cachedAt = now;
  return cache;
}

async function get(key, fallback = null) {
  const s = await all();
  return s[key] === undefined || s[key] === null ? fallback : s[key];
}

async function num(key, fallback = 0) {
  const v = await get(key, null);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function set(key, value) {
  await q.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value == null ? null : String(value)]
  );
  clear();
}

async function setMany(obj) {
  await q.tx(async (t) => {
    for (const [key, value] of Object.entries(obj)) {
      await t.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value == null ? null : String(value)]
      );
    }
  });
  clear();
}

function clear() {
  cache = null;
  cachedAt = 0;
}

module.exports = { all, get, num, set, setMany, clear };
