'use strict';
/**
 * The configured Express app. It deliberately does NOT call app.listen() —
 * server.js does that for Render and local, api/index.js wraps this same
 * export as a single Vercel function.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const { init } = require('./db/schema');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { admin } = require('./lib/auth');

const app = express();

// Behind Render and Vercel the real client IP is in x-forwarded-for.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// --- schema bootstrap -------------------------------------------------------
// Serverless invocations are cold and short, so the boot work is memoised on
// a promise rather than run in a start-up script.
let ready = null;
function ensureReady() {
  if (!ready) {
    ready = init().catch((err) => {
      ready = null; // let the next request retry rather than wedging forever
      throw err;
    });
  }
  return ready;
}
app.use(async (req, res, next) => {
  try { await ensureReady(); next(); } catch (e) { next(e); }
});

// --- the rule engine, served verbatim to the browser ------------------------
// Not a copy and not a build step: the exact file the server evaluates with.
const ENGINE_PATH = path.join(__dirname, 'rules', 'engine.js');
app.get('/rules.browser.js', (req, res) => {
  fs.readFile(ENGINE_PATH, 'utf8', (err, src) => {
    if (err) return res.status(500).type('text/plain').send('// rule engine unavailable');
    res.type('application/javascript');
    res.set('Cache-Control', 'no-cache');
    res.send(
      '/* Generated from src/rules/engine.js — do not edit, do not fork. */\n' +
      src.replace(/^'use strict';$/m, '') // the file is already strict-safe as a script
    );
  });
});

// --- API --------------------------------------------------------------------
app.use(publicRoutes.router);
app.use(adminRoutes.router);

app.get('/healthz', async (req, res) => {
  try {
    await require('./db/pool').q.val('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

// --- pages ------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));

app.get('/admin', admin, page('admin.html'));
app.get('/tender', admin, page('tender.html'));
app.get('/login', page('login.html'));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

// --- errors -----------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Server error' : err.message,
    detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
  });
});

module.exports = app;
module.exports.ensureReady = ensureReady;
