'use strict';
/**
 * PRICING IS ARITHMETIC. No model output reaches this file.
 *
 * `options.price` is the LANDED COST. The sell price is
 *   cost / (1 - margin/100)          -- margin on selling price
 * using the category margin, falling back to `default_margin_pct`.
 *
 * The NULL-margin trap: a category margin of NULL means "unspecified, use
 * the default". A stored 0 means "sell at cost" and would quietly show a
 * customer the landed cost. resolveMargin() treats NULL, '', and undefined
 * as unspecified — but an explicit 0 is honoured, because someone may
 * genuinely want a zero-margin line. The admin API refuses to write 0 by
 * accident (see routes/admin.js).
 */

const settings = require('../db/settings');

function resolveMargin(categoryMargin, defaultMargin) {
  if (categoryMargin === null || categoryMargin === undefined || categoryMargin === '') {
    return defaultMargin;
  }
  const n = Number(categoryMargin);
  return Number.isFinite(n) ? n : defaultMargin;
}

function sellPrice(cost, marginPct) {
  const c = Number(cost) || 0;
  const m = Number(marginPct) || 0;
  if (m <= 0) return round2(c);
  if (m >= 95) return round2(c / 0.05); // refuse to divide by ~zero
  return round2(c / (1 - m / 100));
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Price a build.
 * @param {Array} lines  [{ option, qty, category }]
 * @param {Object} opts  { units }
 * @returns customer-safe quotation (no cost, no margin anywhere in the output)
 */
async function priceBuild(lines, opts = {}) {
  const s = await settings.all();
  const defaultMargin = Number(s.default_margin_pct ?? 0) || 0;
  const taxRate = Number(s.tax_rate ?? 0) || 0;
  const units = Math.max(1, Number(opts.units) || 1);

  const items = lines.map((line) => {
    const qty = Math.max(1, Number(line.qty) || 1);
    const margin = resolveMargin(line.category ? line.category.margin_pct : null, defaultMargin);
    const unit = sellPrice(line.option.price, margin);
    return {
      option_id: line.option.id,
      category_id: line.option.category_id,
      name: line.option.name,
      specs: line.option.specs || '',
      qty,
      unit_price: unit,
      line_total: round2(unit * qty),
      stock_qty: line.option.stock_qty,
      lead_days: line.option.lead_days,
    };
  });

  const perUnit = round2(items.reduce((a, i) => a + i.line_total, 0));
  const subtotal = round2(perUnit * units);
  const tax = round2((subtotal * taxRate) / 100);

  return {
    currency: s.currency || 'INR',
    currency_symbol: s.currency_symbol || '₹',
    locale: s.locale || 'en-IN',
    tax_label: s.tax_label || 'Tax',
    tax_rate: taxRate,
    units,
    items,
    per_unit_total: perUnit,
    subtotal,
    tax,
    total: round2(subtotal + tax),
    lead_days: items.reduce((a, i) => Math.max(a, Number(i.lead_days) || 0), 0),
  };
}

/** Strip everything a customer must never see from an options row. */
function publicOption(row, category, defaultMargin) {
  const margin = resolveMargin(category ? category.margin_pct : null, defaultMargin);
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    specs: row.specs,
    price: sellPrice(row.price, margin), // SELL price, not landed cost
    in_stock: Number(row.stock_qty) > 0,
    stock_qty: Number(row.stock_qty) > 0 ? Number(row.stock_qty) : 0,
    lead_days: Number(row.lead_days) || 0,
    attrs: row.attrs,
  };
}

module.exports = { resolveMargin, sellPrice, priceBuild, publicOption, round2 };
