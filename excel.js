'use strict';
/**
 * Excel round-trip: download the current catalog, edit in Excel, upload.
 *
 * Rules of the round-trip, and they matter:
 *   - Rows are matched on `id`. A new id creates a row; a known id updates it.
 *   - NOTHING is ever deleted by an import. Retire a part with active = 0.
 *   - The whole import runs in ONE transaction. A half-applied price list is
 *     worse than a rejected one.
 *   - An empty margin_pct cell means "use the default margin". It is stored
 *     as NULL, never as 0.
 */

const XLSX = require('xlsx');
const { q } = require('../db/pool');
const catalog = require('../db/catalog');

const SHEETS = {
  categories: 'Categories',
  options: 'Options',
  rules: 'Rules',
  fields: 'ExtractionFields',
  settings: 'Settings',
};

const OPTION_COLUMNS = [
  'id', 'category_id', 'name', 'specs', 'price', 'stock_qty', 'lead_days', 'active', 'attrs',
];
const CATEGORY_COLUMNS = [
  'id', 'label', 'note', 'sort', 'required', 'max_qty', 'multi', 'margin_pct', 'active',
];
const RULE_COLUMNS = [
  'id', 'name', 'severity', 'message', 'enabled', 'sort', 'left_kind', 'left_cats', 'left_attr',
  'left_scale', 'left_offset', 'op', 'right_kind', 'right_cats', 'right_attr', 'right_const', 'expr',
];
const FIELD_COLUMNS = ['id', 'key', 'label', 'hint', 'type', 'group_name', 'sort', 'active'];

function sheetFrom(rows, columns) {
  const shaped = rows.map((r) => {
    const o = {};
    for (const c of columns) o[c] = r[c] === null || r[c] === undefined ? '' : r[c];
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(shaped, { header: columns });
  ws['!cols'] = columns.map((c) => ({ wch: c === 'attrs' || c === 'message' ? 44 : Math.max(10, c.length + 4) }));
  return ws;
}

async function exportWorkbook() {
  const [cats, opts, rls, fields, sett] = await Promise.all([
    q.all(`SELECT * FROM categories ORDER BY sort, id`),
    q.all(`SELECT * FROM options ORDER BY category_id, name`),
    q.all(`SELECT * FROM rules ORDER BY sort, id`),
    q.all(`SELECT * FROM extraction_fields ORDER BY sort, id`),
    q.all(`SELECT key, value FROM settings ORDER BY key`),
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(cats, CATEGORY_COLUMNS), SHEETS.categories);
  XLSX.utils.book_append_sheet(wb, sheetFrom(opts, OPTION_COLUMNS), SHEETS.options);
  XLSX.utils.book_append_sheet(wb, sheetFrom(rls, RULE_COLUMNS), SHEETS.rules);
  XLSX.utils.book_append_sheet(wb, sheetFrom(fields, FIELD_COLUMNS), SHEETS.fields);
  XLSX.utils.book_append_sheet(wb, sheetFrom(sett, ['key', 'value']), SHEETS.settings);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function readSheet(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
}

function validateAttrs(raw, rowRef, errors) {
  const s = String(raw || '').trim();
  if (!s) return '{}';
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${rowRef}: attrs must be a JSON object`);
      return null;
    }
    return JSON.stringify(parsed);
  } catch (e) {
    errors.push(`${rowRef}: attrs is not valid JSON (${e.message})`);
    return null;
  }
}

/**
 * Import a workbook buffer. Validates everything first; if any row is bad the
 * whole import is rejected and the database is untouched.
 * Returns { applied: {...counts}, errors: [] }.
 */
async function importWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const errors = [];

  const cats = readSheet(wb, SHEETS.categories) || [];
  const opts = readSheet(wb, SHEETS.options) || [];
  const rls = readSheet(wb, SHEETS.rules) || [];
  const fields = readSheet(wb, SHEETS.fields) || [];
  const sett = readSheet(wb, SHEETS.settings) || [];

  if (!wb.SheetNames.some((n) => Object.values(SHEETS).includes(n))) {
    return { applied: null, errors: ['No recognised sheets. Expected: ' + Object.values(SHEETS).join(', ')] };
  }

  const knownCatIds = new Set(cats.map((c) => String(c.id || '').trim()).filter(Boolean));
  const existingCats = new Set((await catalog.categories()).map((c) => c.id));

  cats.forEach((c, i) => {
    if (!String(c.id || '').trim()) errors.push(`${SHEETS.categories} row ${i + 2}: id is required`);
  });

  const preparedOptions = [];
  opts.forEach((o, i) => {
    const ref = `${SHEETS.options} row ${i + 2}`;
    const id = String(o.id || '').trim();
    const cat = String(o.category_id || '').trim();
    if (!id) { errors.push(`${ref}: id is required`); return; }
    if (!cat) { errors.push(`${ref}: category_id is required`); return; }
    if (!knownCatIds.has(cat) && !existingCats.has(cat)) {
      errors.push(`${ref}: category_id "${cat}" does not exist`);
      return;
    }
    const price = Number(String(o.price).replace(/[, ₹]/g, ''));
    if (o.price !== '' && !Number.isFinite(price)) errors.push(`${ref}: price "${o.price}" is not a number`);
    const attrs = validateAttrs(o.attrs, ref, errors);
    preparedOptions.push({ ...o, id, category_id: cat, price: Number.isFinite(price) ? price : 0, attrs });
  });

  if (errors.length) return { applied: null, errors };

  const applied = { categories: 0, options: 0, rules: 0, extraction_fields: 0, settings: 0 };

  await q.tx(async (t) => {
    for (const c of cats) {
      await catalog.upsertCategory(c, t);
      applied.categories += 1;
    }
    for (const o of preparedOptions) {
      await catalog.upsertOption(o, t);
      applied.options += 1;
    }
    for (const r of rls) {
      if (!String(r.name || '').trim()) continue;
      await catalog.upsertRule({ ...r, id: r.id ? Number(r.id) : null }, t);
      applied.rules += 1;
    }
    for (const f of fields) {
      const key = String(f.key || '').trim();
      if (!key) continue;
      await t.run(
        `INSERT INTO extraction_fields (key, label, hint, type, group_name, sort, active)
         VALUES (@key, @label, @hint, @type, @group_name, @sort, @active)
         ON CONFLICT (key) DO UPDATE SET
           label = EXCLUDED.label, hint = EXCLUDED.hint, type = EXCLUDED.type,
           group_name = EXCLUDED.group_name, sort = EXCLUDED.sort, active = EXCLUDED.active`,
        {
          key,
          label: f.label || key,
          hint: f.hint || null,
          type: f.type || 'text',
          group_name: f.group_name || 'General',
          sort: catalog.int(f.sort, 0),
          active: f.active === '' ? 1 : catalog.bool(f.active),
        }
      );
      applied.extraction_fields += 1;
    }
    for (const s of sett) {
      const key = String(s.key || '').trim();
      if (!key) continue;
      await t.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, s.value === '' ? null : String(s.value)]
      );
      applied.settings += 1;
    }
  });

  require('../db/settings').clear();
  return { applied, errors: [] };
}

module.exports = { exportWorkbook, importWorkbook, SHEETS, OPTION_COLUMNS, CATEGORY_COLUMNS };
