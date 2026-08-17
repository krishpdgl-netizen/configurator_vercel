'use strict';
/**
 * Customer-facing API.
 *
 * Nothing here may leak a landed cost, a margin, or a stock figure beyond
 * what the configurator needs. The customer-safe shaping happens in
 * pricing.publicOption() — at the API layer, not in a template, so a future
 * template mistake cannot expose costs.
 */

const express = require('express');
const catalog = require('../db/catalog');
const settings = require('../db/settings');
const pricing = require('../lib/pricing');
const engine = require('../rules/engine');
const { q } = require('../db/pool');

const router = express.Router();

async function loadPublicCatalog() {
  const [cats, opts, rules, s] = await Promise.all([
    catalog.categories({ activeOnly: true }),
    catalog.options({ activeOnly: true }),
    catalog.rules({ enabledOnly: true }),
    settings.all(),
  ]);
  const defaultMargin = Number(s.default_margin_pct ?? 0) || 0;
  const byId = new Map(cats.map((c) => [c.id, c]));
  return {
    settings: {
      company: s.company, currency: s.currency, currency_symbol: s.currency_symbol,
      locale: s.locale, tax_label: s.tax_label, tax_rate: Number(s.tax_rate || 0),
    },
    categories: cats.map((c) => ({
      id: c.id, label: c.label, note: c.note, sort: c.sort,
      required: Number(c.required), max_qty: Number(c.max_qty), multi: Number(c.multi),
      // margin_pct deliberately absent
    })),
    options: opts
      .filter((o) => byId.has(o.category_id))
      .map((o) => pricing.publicOption(o, byId.get(o.category_id), defaultMargin)),
    // Rules carry no commercial information — the browser needs them to
    // validate instantly with the same code the server trusts.
    rules,
  };
}

/** Turn a posted selection into DB-backed lines. Ignores anything not in the catalog. */
async function resolveSelection(selection) {
  const rows = Array.isArray(selection) ? selection : [];
  const ids = rows.map((r) => String(r.option_id || r.id || '')).filter(Boolean);
  const found = await catalog.optionsByIds([...new Set(ids)]);
  const optById = new Map(found.map((o) => [o.id, o]));
  const cats = await catalog.categories();
  const catById = new Map(cats.map((c) => [c.id, c]));

  const lines = [];
  const unknown = [];
  for (const r of rows) {
    const id = String(r.option_id || r.id || '');
    const o = optById.get(id);
    if (!o || Number(o.active) === 0) { unknown.push(id); continue; }
    lines.push({ option: o, qty: Math.max(1, Number(r.qty) || 1), category: catById.get(o.category_id) });
  }
  return { lines, unknown, categories: cats };
}

router.get('/api/catalog', async (req, res, next) => {
  try {
    res.json(await loadPublicCatalog());
  } catch (e) { next(e); }
});

router.post('/api/validate', async (req, res, next) => {
  try {
    const { lines, unknown, categories } = await resolveSelection(req.body?.selection);
    const rules = await catalog.rules({ enabledOnly: true });
    const result = engine.evaluate(rules, { items: lines.map((l) => ({ option: l.option, qty: l.qty })) });
    const missing = categories
      .filter((c) => Number(c.required) === 1 && Number(c.active) === 1)
      .filter((c) => !lines.some((l) => l.option.category_id === c.id))
      .map((c) => ({ id: c.id, label: c.label }));
    res.json({
      ok: result.ok && missing.length === 0,
      blocks: result.blocks.map(publicFinding),
      warns: result.warns.map(publicFinding),
      missing_required: missing,
      unknown_options: unknown,
    });
  } catch (e) { next(e); }
});

function publicFinding(f) {
  return { name: f.name, message: f.message, severity: f.severity, detail: f.detail };
}

router.post('/api/price', async (req, res, next) => {
  try {
    const { lines } = await resolveSelection(req.body?.selection);
    const quote = await pricing.priceBuild(lines, { units: req.body?.units });
    res.json(quote);
  } catch (e) { next(e); }
});

router.post('/api/enquiry', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!String(body.name || '').trim() || !String(body.mobile || body.email || '').trim()) {
      return res.status(400).json({ error: 'Name and either a mobile number or an email are required.' });
    }

    const { lines, categories } = await resolveSelection(body.selection);
    if (!lines.length) return res.status(400).json({ error: 'The configuration is empty.' });

    // A blocked build is rejected server-side, whatever the browser allowed.
    const rules = await catalog.rules({ enabledOnly: true });
    const check = engine.evaluate(rules, { items: lines.map((l) => ({ option: l.option, qty: l.qty })) });
    if (!check.ok) {
      return res.status(422).json({
        error: 'This configuration is not buildable.',
        blocks: check.blocks.map(publicFinding),
      });
    }
    const missing = categories
      .filter((c) => Number(c.required) === 1 && Number(c.active) === 1)
      .filter((c) => !lines.some((l) => l.option.category_id === c.id));
    if (missing.length) {
      return res.status(422).json({
        error: 'Some required categories have not been chosen.',
        missing_required: missing.map((c) => ({ id: c.id, label: c.label })),
      });
    }

    const quote = await pricing.priceBuild(lines, { units: body.units });
    const ref = 'ENQ-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' +
      Math.random().toString(36).slice(2, 6).toUpperCase();

    await q.run(
      `INSERT INTO leads (ref, name, company, mobile, email, city, units, notes, config_json,
         subtotal, tax, total, source, created_at)
       VALUES (@ref, @name, @company, @mobile, @email, @city, @units, @notes, @config_json,
         @subtotal, @tax, @total, @source, to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
      {
        ref,
        name: body.name, company: body.company || null, mobile: body.mobile || null,
        email: body.email || null, city: body.city || null,
        units: Math.max(1, Number(body.units) || 1), notes: body.notes || null,
        config_json: JSON.stringify(quote.items),
        subtotal: quote.subtotal, tax: quote.tax, total: quote.total,
        source: body.source || 'configurator',
      }
    );

    res.json({ ok: true, ref, quote });
  } catch (e) { next(e); }
});

module.exports = { router, loadPublicCatalog, resolveSelection };
