'use strict';
/**
 * Thin data layer over `pg`. Plain SQL, no ORM.
 *
 * Placeholder styles supported (mutually exclusive per statement):
 *   positional : SELECT * FROM options WHERE category_id = ? AND active = ?
 *                q.all(sql, ['cpu', 1])
 *   named      : SELECT * FROM options WHERE category_id = @cat
 *                q.all(sql, { cat: 'cpu' })
 *
 * Both are rewritten to $1..$n before hitting the driver.
 */

const { Pool } = require('pg');

let pool = null;

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

function getPool() {
  if (pool) return pool;
  const url = connectionString();
  // Neon's pooled endpoint terminates TLS with a cert the default Node CA
  // bundle does not chain to, hence rejectUnauthorized:false for hosted URLs.
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 8),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return pool;
}

/** Rewrite ? / @named placeholders to $1..$n. Returns { text, values }. */
function compile(sql, params) {
  if (params == null) return { text: sql, values: [] };

  const named = !Array.isArray(params);
  const values = [];

  if (named) {
    // @name — but not an email inside a string literal, so require a word
    // boundary before the @ and a letter/underscore right after it.
    const seen = new Map();
    const text = sql.replace(/(^|[\s(,=<>!+\-*/[])@([A-Za-z_][A-Za-z0-9_]*)/g, (m, pre, key) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new Error(`Missing named parameter @${key}`);
      }
      if (!seen.has(key)) {
        values.push(params[key]);
        seen.set(key, values.length);
      }
      return `${pre}$${seen.get(key)}`;
    });
    return { text, values };
  }

  let i = 0;
  const text = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('Not enough positional parameters');
    values.push(params[i]);
    i += 1;
    return `$${i}`;
  });
  if (i !== params.length) {
    throw new Error(`Parameter count mismatch: ${params.length} supplied, ${i} placeholders`);
  }
  return { text, values };
}

async function exec(client, sql, params) {
  const { text, values } = compile(sql, params);
  try {
    return await (client || getPool()).query(text, values);
  } catch (err) {
    err.message = `${err.message}\n  SQL: ${text.trim().slice(0, 300)}`;
    throw err;
  }
}

function bind(client) {
  return {
    /** First row, or undefined. */
    async get(sql, params) {
      const r = await exec(client, sql, params);
      return r.rows[0];
    },
    /** All rows. */
    async all(sql, params) {
      const r = await exec(client, sql, params);
      return r.rows;
    },
    /** Write. Returns { rowCount, rows } — use RETURNING id for new ids. */
    async run(sql, params) {
      const r = await exec(client, sql, params);
      return { rowCount: r.rowCount, rows: r.rows };
    },
    /** Single scalar from the first row/first column. */
    async val(sql, params) {
      const r = await exec(client, sql, params);
      if (!r.rows.length) return undefined;
      return Object.values(r.rows[0])[0];
    },
  };
}

const q = bind(null);

/**
 * Run fn inside a transaction. fn receives a bound helper on a dedicated
 * client — use it, not the module-level `q`, or the statements escape the
 * transaction and a failed Excel import leaves a half-applied price list.
 */
q.tx = async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(bind(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

q.close = async function close() {
  if (pool) { await pool.end(); pool = null; }
};

q._compile = compile; // exported for tests

module.exports = { q, getPool };
