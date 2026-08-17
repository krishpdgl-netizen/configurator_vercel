'use strict';

const { q } = require('./pool');

const now = () => `to_char(now(),'YYYY-MM-DD HH24:MI:SS')`;

async function categories({ activeOnly = false } = {}) {
  return q.all(
    `SELECT * FROM categories ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, label`
  );
}

async function category(id) {
  return q.get(`SELECT * FROM categories WHERE id = ?`, [id]);
}

async function options({ activeOnly = false, categoryId = null } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('active = 1');
  if (categoryId) { where.push('category_id = ?'); params.push(categoryId); }
  return q.all(
    `SELECT * FROM options ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY category_id, name`,
    params.length ? params : null
  );
}

async function option(id) {
  return q.get(`SELECT * FROM options WHERE id = ?`, [id]);
}

async function optionsByIds(ids) {
  if (!ids.length) return [];
  const holes = ids.map(() => '?').join(',');
  return q.all(`SELECT * FROM options WHERE id IN (${holes})`, ids);
}

async function rules({ enabledOnly = true } = {}) {
  return q.all(
    `SELECT * FROM rules ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY sort, id`
  );
}

async function upsertCategory(c, t = q) {
  await t.run(
    `INSERT INTO categories (id, label, note, sort, required, max_qty, multi, margin_pct, active)
     VALUES (@id, @label, @note, @sort, @required, @max_qty, @multi, @margin_pct, @active)
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label, note = EXCLUDED.note, sort = EXCLUDED.sort,
       required = EXCLUDED.required, max_qty = EXCLUDED.max_qty, multi = EXCLUDED.multi,
       margin_pct = EXCLUDED.margin_pct, active = EXCLUDED.active`,
    {
      id: String(c.id).trim(),
      label: c.label || c.id,
      note: c.note || null,
      sort: int(c.sort, 0),
      required: bool(c.required),
      max_qty: int(c.max_qty, 1),
      multi: bool(c.multi),
      margin_pct: nullableNum(c.margin_pct),
      active: c.active === undefined ? 1 : bool(c.active),
    }
  );
  return category(String(c.id).trim());
}

async function upsertOption(o, t = q) {
  const attrs = typeof o.attrs === 'string' ? o.attrs : JSON.stringify(o.attrs || {});
  await t.run(
    `INSERT INTO options (id, category_id, name, specs, price, stock_qty, lead_days, active, attrs, updated_at)
     VALUES (@id, @category_id, @name, @specs, @price, @stock_qty, @lead_days, @active, @attrs, ${now()})
     ON CONFLICT (id) DO UPDATE SET
       category_id = EXCLUDED.category_id, name = EXCLUDED.name, specs = EXCLUDED.specs,
       price = EXCLUDED.price, stock_qty = EXCLUDED.stock_qty, lead_days = EXCLUDED.lead_days,
       active = EXCLUDED.active, attrs = EXCLUDED.attrs, updated_at = EXCLUDED.updated_at`,
    {
      id: String(o.id).trim(),
      category_id: String(o.category_id).trim(),
      name: o.name || o.id,
      specs: o.specs || null,
      price: num(o.price, 0),
      stock_qty: int(o.stock_qty, 0),
      lead_days: int(o.lead_days, 0),
      active: o.active === undefined ? 1 : bool(o.active),
      attrs,
    }
  );
  return option(String(o.id).trim());
}

async function deleteOption(id) {
  // Parts are retired, not deleted — quotations reference them.
  await q.run(`UPDATE options SET active = 0, updated_at = ${now()} WHERE id = ?`, [id]);
}

async function upsertRule(r, t = q) {
  if (r.id) {
    await t.run(
      `UPDATE rules SET name=@name, severity=@severity, message=@message, enabled=@enabled, sort=@sort,
        left_kind=@left_kind, left_cats=@left_cats, left_attr=@left_attr,
        left_scale=@left_scale, left_offset=@left_offset, op=@op,
        right_kind=@right_kind, right_cats=@right_cats, right_attr=@right_attr,
        right_const=@right_const, expr=@expr
       WHERE id=@id`,
      ruleParams(r)
    );
    return q.get(`SELECT * FROM rules WHERE id = ?`, [r.id]);
  }
  const row = await t.run(
    `INSERT INTO rules (name, severity, message, enabled, sort, left_kind, left_cats, left_attr,
       left_scale, left_offset, op, right_kind, right_cats, right_attr, right_const, expr)
     VALUES (@name, @severity, @message, @enabled, @sort, @left_kind, @left_cats, @left_attr,
       @left_scale, @left_offset, @op, @right_kind, @right_cats, @right_attr, @right_const, @expr)
     RETURNING id`,
    ruleParams(r)
  );
  return q.get(`SELECT * FROM rules WHERE id = ?`, [row.rows[0].id]);
}

function ruleParams(r) {
  return {
    id: r.id ?? null,
    name: r.name,
    severity: r.severity === 'warn' ? 'warn' : 'block',
    message: r.message,
    enabled: r.enabled === undefined ? 1 : bool(r.enabled),
    sort: int(r.sort, 0),
    left_kind: r.left_kind || null,
    left_cats: r.left_cats || null,
    left_attr: r.left_attr || null,
    left_scale: nullableNum(r.left_scale),
    left_offset: nullableNum(r.left_offset),
    op: r.op || null,
    right_kind: r.right_kind || null,
    right_cats: r.right_cats || null,
    right_attr: r.right_attr || null,
    right_const: r.right_const == null ? null : String(r.right_const),
    expr: r.expr || null,
  };
}

async function deleteRule(id) {
  await q.run(`DELETE FROM rules WHERE id = ?`, [id]);
}

// --------------------------------------------------------------- coercion

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function bool(v) {
  if (v === true || v === 1 || v === '1') return 1;
  if (typeof v === 'string' && /^(yes|y|true|t)$/i.test(v.trim())) return 1;
  return 0;
}
/** Empty string / null / undefined stay NULL — see the margin trap in pricing.js. */
function nullableNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  categories, category, options, option, optionsByIds, rules,
  upsertCategory, upsertOption, deleteOption, upsertRule, deleteRule,
  int, num, bool, nullableNum,
};
