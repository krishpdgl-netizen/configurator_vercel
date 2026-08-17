'use strict';

const express = require('express');
const multer = require('multer');
const catalog = require('../db/catalog');
const settings = require('../db/settings');
const excel = require('../lib/excel');
const engine = require('../rules/engine');
const starterPack = require('../rules/starter-pack');
const { admin } = require('../lib/auth');
const { q } = require('../db/pool');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.use('/api/admin', admin);

router.get('/api/admin/whoami', (req, res) => res.json({ ok: true }));

// ------------------------------------------------------------------ catalog

router.get('/api/admin/catalog', async (req, res, next) => {
  try {
    const [categories, options, rules, fields, s] = await Promise.all([
      catalog.categories(),
      catalog.options(),
      catalog.rules({ enabledOnly: false }),
      q.all(`SELECT * FROM extraction_fields ORDER BY sort, id`),
      settings.all(),
    ]);
    res.json({ categories, options, rules, extraction_fields: fields, settings: s });
  } catch (e) { next(e); }
});

router.post('/api/admin/categories', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!String(body.id || '').trim()) return res.status(400).json({ error: 'id is required' });

    // The margin trap, guarded at the API layer as well as in pricing:
    // an omitted margin must persist as NULL, not 0. A margin of exactly 0
    // has to be sent deliberately.
    if (body.margin_pct === '' || body.margin_pct === null || body.margin_pct === undefined) {
      body.margin_pct = null;
    } else if (Number(body.margin_pct) === 0 && body.allow_zero_margin !== true) {
      return res.status(400).json({
        error: 'A margin of 0 sells this category at landed cost. Send allow_zero_margin:true if that is intended, or leave the field empty to use the default margin.',
      });
    }
    res.json(await catalog.upsertCategory(body));
  } catch (e) { next(e); }
});

router.post('/api/admin/options', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!String(body.id || '').trim()) return res.status(400).json({ error: 'id is required' });
    if (!(await catalog.category(String(body.category_id || '').trim()))) {
      return res.status(400).json({ error: `Unknown category "${body.category_id}"` });
    }
    if (body.attrs && typeof body.attrs === 'string') {
      try { JSON.parse(body.attrs); }
      catch (e) { return res.status(400).json({ error: 'attrs is not valid JSON' }); }
    }
    res.json(await catalog.upsertOption(body));
  } catch (e) { next(e); }
});

router.delete('/api/admin/options/:id', async (req, res, next) => {
  try {
    await catalog.deleteOption(req.params.id);
    res.json({ ok: true, retired: req.params.id });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------- rules

router.post('/api/admin/rules', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!String(body.name || '').trim()) return res.status(400).json({ error: 'name is required' });
    if (!String(body.message || '').trim()) {
      return res.status(400).json({ error: 'message is required — it is what the customer reads when the rule blocks a part' });
    }
    if (engine.OPS.indexOf(body.op) === -1) {
      return res.status(400).json({ error: `op must be one of: ${engine.OPS.join(', ')}` });
    }
    for (const side of ['left_kind', 'right_kind']) {
      if (engine.KINDS.indexOf(body[side]) === -1) {
        return res.status(400).json({ error: `${side} must be one of: ${engine.KINDS.join(', ')}` });
      }
    }
    res.json(await catalog.upsertRule(body));
  } catch (e) { next(e); }
});

router.delete('/api/admin/rules/:id', async (req, res, next) => {
  try {
    await catalog.deleteRule(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Rule tester: post a build, see every rule and why it fired or was skipped. */
router.post('/api/admin/rules/test', async (req, res, next) => {
  try {
    const ids = (req.body?.selection || []).map((r) => String(r.option_id || r.id));
    const opts = await catalog.optionsByIds([...new Set(ids.filter(Boolean))]);
    const byId = new Map(opts.map((o) => [o.id, o]));
    const items = (req.body?.selection || [])
      .map((r) => ({ option: byId.get(String(r.option_id || r.id)), qty: Number(r.qty) || 1 }))
      .filter((i) => i.option);
    const rules = await catalog.rules({ enabledOnly: false });
    const out = engine.evaluate(rules, { items });
    res.json({
      ok: out.ok,
      results: out.results.map((r) => ({
        name: r.name, severity: r.severity, applied: r.applied, passed: r.passed,
        left: r.left, right: r.right, detail: r.detail,
        skipped_reason: r.skipped_reason, message: r.message,
      })),
    });
  } catch (e) { next(e); }
});

/** Opt-in starter rules. Not seeded — see src/rules/starter-pack.js. */
router.post('/api/admin/rules/starter-pack', async (req, res, next) => {
  try {
    const existing = await catalog.rules({ enabledOnly: false });
    const have = new Set(existing.map((r) => r.name));
    let added = 0;
    await q.tx(async (t) => {
      for (const r of starterPack) {
        if (have.has(r.name)) continue;
        await catalog.upsertRule(r, t);
        added += 1;
      }
    });
    res.json({ ok: true, added, skipped: starterPack.length - added });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------- settings

router.post('/api/admin/settings', async (req, res, next) => {
  try {
    const body = req.body || {};
    delete body.token;
    await settings.setMany(body);
    res.json(await settings.all());
  } catch (e) { next(e); }
});

// ------------------------------------------------------- Excel round-trip

router.get('/api/admin/export.xlsx', async (req, res, next) => {
  try {
    const buf = await excel.exportWorkbook();
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="catalog-${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

router.post('/api/admin/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
    const out = await excel.importWorkbook(req.file.buffer);
    if (out.errors.length) {
      return res.status(400).json({ error: 'Import rejected — nothing was changed.', details: out.errors });
    }
    res.json({ ok: true, applied: out.applied });
  } catch (e) { next(e); }
});

// -------------------------------------------------------- leads and tenders

router.get('/api/admin/leads', async (req, res, next) => {
  try {
    res.json(await q.all(`SELECT * FROM leads ORDER BY id DESC LIMIT 500`));
  } catch (e) { next(e); }
});

router.get('/api/admin/tenders', async (req, res, next) => {
  try {
    res.json(await q.all(
      `SELECT id, ref, filename, file_url, pages, chars, status, error, created_at
       FROM tenders ORDER BY id DESC LIMIT 200`
    ));
  } catch (e) { next(e); }
});

module.exports = { router };
