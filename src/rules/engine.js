/* eslint-disable no-var */
'use strict';
/**
 * COMPATIBILITY RULE ENGINE
 *
 * This exact file runs in three places:
 *   - the server, when validating an enquiry or a tender-matched build
 *   - the tender matcher, to prune illegal partial builds during search
 *   - the browser, served verbatim as /rules.browser.js
 *
 * There is no second copy. Do not fork it.
 *
 * Rules are DATA, not code. A rule compares a left side to a right side:
 *
 *   { name, severity: 'block'|'warn', message, enabled, sort,
 *     left_kind, left_cats, left_attr, left_scale, left_offset,
 *     op, right_kind, right_cats, right_attr, right_const, expr }
 *
 * Side kinds:
 *   sum    numeric sum of `attr` across `cats`, weighted by quantity
 *   max    largest value of `attr` across `cats`
 *   min    smallest value of `attr` across `cats`
 *   count  total quantity selected in `cats` (attr ignored)
 *   value  the set of distinct `attr` values across `cats`
 *   const  a literal from `right_const` (number, string, or comma list)
 *   expr   a small arithmetic expression, see evalExpr()
 *
 * Operators: eq neq lt lte gt gte in nin subset
 *
 * MISSING SIDES DO NOT FIRE RULES. If nothing in `cats` is selected yet, or
 * the selected part carries no such attribute, the rule is skipped — a
 * half-built configuration is incomplete, not illegal.
 */

var KINDS = ['sum', 'max', 'min', 'count', 'value', 'const', 'expr'];
var OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'subset'];

// ---------------------------------------------------------------- utilities

function splitList(s) {
  if (s == null) return [];
  if (Array.isArray(s)) return s.slice();
  return String(s)
    .split(',')
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}

function parseAttrs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    var o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    var t = v.trim();
    if (t === '') return null;
    var n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function norm(v) {
  // Case- and space-insensitive comparison for spec strings: "LGA 3647"
  // and "lga3647" are the same socket, and a price list will contain both.
  return String(v).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Normalise whatever the caller passes into { option, qty } rows. */
function normaliseItems(build) {
  var raw = (build && (build.items || build.selections)) || [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var row = raw[i];
    var opt = row.option || row;
    if (!opt || !opt.category_id) continue;
    var qty = Number(row.qty != null ? row.qty : opt.qty);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    out.push({
      option: {
        id: opt.id,
        category_id: opt.category_id,
        name: opt.name,
        attrs: parseAttrs(opt.attrs),
      },
      qty: qty,
    });
  }
  return out;
}

function itemsIn(items, cats) {
  if (!cats.length) return items;
  return items.filter(function (it) { return cats.indexOf(it.option.category_id) !== -1; });
}

// -------------------------------------------------------------- side values
// A resolved side is one of:
//   { missing: true, why: '...' }
//   { num: <number> }
//   { set: [values], numeric: bool }

function missing(why) { return { missing: true, why: why }; }

function resolveSide(kind, cats, attr, constant, expr, items) {
  var scoped = itemsIn(items, cats);

  switch (kind) {
    case 'count': {
      var n = 0;
      for (var i = 0; i < scoped.length; i++) n += scoped[i].qty;
      return { num: n };
    }

    case 'sum': {
      var total = 0;
      var seen = false;
      for (var j = 0; j < scoped.length; j++) {
        var v = asNumber(scoped[j].option.attrs[attr]);
        if (v == null) continue;
        seen = true;
        total += v * scoped[j].qty;
      }
      // No parts selected at all → 0 is a truthful sum (a build with no GPUs
      // draws no GPU watts). Parts selected but none carry the attribute →
      // we genuinely do not know, so skip rather than assert zero.
      if (scoped.length && !seen) return missing('no "' + attr + '" recorded on the selected part(s)');
      return { num: total };
    }

    case 'max':
    case 'min': {
      var best = null;
      for (var k = 0; k < scoped.length; k++) {
        var val = asNumber(scoped[k].option.attrs[attr]);
        if (val == null) continue;
        if (best == null) best = val;
        else if (kind === 'max') best = Math.max(best, val);
        else best = Math.min(best, val);
      }
      if (best == null) return missing('nothing selected with a "' + attr + '" value');
      return { num: best };
    }

    case 'value': {
      var vals = [];
      var numeric = true;
      for (var m = 0; m < scoped.length; m++) {
        var raw = scoped[m].option.attrs[attr];
        if (raw == null || raw === '') continue;
        var list = Array.isArray(raw) ? raw : [raw];
        for (var n2 = 0; n2 < list.length; n2++) {
          if (asNumber(list[n2]) == null) numeric = false;
          if (vals.indexOf(list[n2]) === -1) vals.push(list[n2]);
        }
      }
      if (!vals.length) return missing('nothing selected with a "' + attr + '" value');
      return { set: vals, numeric: numeric };
    }

    case 'const': {
      if (constant == null || constant === '') return missing('rule has no constant');
      var parts = splitList(constant);
      if (parts.length > 1) {
        return { set: parts, numeric: parts.every(function (p) { return asNumber(p) != null; }) };
      }
      var single = asNumber(constant);
      if (single != null) return { num: single };
      return { set: [String(constant).trim()], numeric: false };
    }

    case 'expr':
      return evalExpr(expr, items);

    default:
      return missing('unknown side kind "' + kind + '"');
  }
}

/**
 * Small arithmetic expression evaluator.
 *
 * Allowed: numbers, + - * / ( ), and the aggregate calls
 *   sum(cat[,cat].attr)   max(cat.attr)   min(cat.attr)   count(cat[,cat])
 *
 * Aggregates are substituted with their numeric values, then the remaining
 * string is checked to contain nothing but digits, operators and brackets
 * before evaluation. Anything else is refused rather than executed.
 */
function evalExpr(expr, items) {
  if (!expr || !String(expr).trim()) return missing('rule has no expression');
  var src = String(expr);
  var failed = null;

  var substituted = src.replace(
    /\b(sum|max|min|count)\(\s*([A-Za-z0-9_,\s]+?)\s*(?:\.\s*([A-Za-z0-9_]+)\s*)?\)/g,
    function (whole, fn, catsRaw, attr) {
      var side = resolveSide(fn, splitList(catsRaw), attr, null, null, items);
      if (side.missing) { failed = side.why; return '0'; }
      if (side.num == null) { failed = 'expression term "' + whole + '" is not numeric'; return '0'; }
      return '(' + side.num + ')';
    }
  );

  if (failed) return missing(failed);
  if (!/^[0-9+\-*/().\s]+$/.test(substituted)) {
    return missing('expression contains unsupported syntax');
  }
  try {
    // eslint-disable-next-line no-new-func
    var out = Function('"use strict";return (' + substituted + ');')();
    if (!Number.isFinite(out)) return missing('expression did not produce a finite number');
    return { num: out };
  } catch (e) {
    return missing('expression could not be evaluated');
  }
}

// --------------------------------------------------------------- comparison

function toSet(side) {
  if (side.set) return side.set;
  return [side.num];
}

function compare(op, left, right) {
  // Set membership operators first — these are about the whole set.
  if (op === 'in' || op === 'subset') {
    var rs = toSet(right).map(norm);
    return toSet(left).every(function (v) { return rs.indexOf(norm(v)) !== -1; });
  }
  if (op === 'nin') {
    var rs2 = toSet(right).map(norm);
    return toSet(left).every(function (v) { return rs2.indexOf(norm(v)) === -1; });
  }

  // Everything else is universally quantified over the LEFT side: every
  // selected memory module must match the board's memory type, not just one.
  //
  // On the right side, `eq` is satisfied by ANY value (a board may list
  // several supported memory types); `neq` and the ordering operators must
  // hold against EVERY value.
  var rightVals = toSet(right);
  var anyRight = op === 'eq';
  return toSet(left).every(function (lv) {
    return anyRight
      ? rightVals.some(function (rv) { return compareScalar(op, lv, rv); })
      : rightVals.every(function (rv) { return compareScalar(op, lv, rv); });
  });
}

function compareScalar(op, a, b) {
  var na = asNumber(a);
  var nb = asNumber(b);
  var numeric = na != null && nb != null;

  switch (op) {
    case 'eq': return numeric ? na === nb : norm(a) === norm(b);
    case 'neq': return numeric ? na !== nb : norm(a) !== norm(b);
    case 'lt': return numeric ? na < nb : false;
    case 'lte': return numeric ? na <= nb : false;
    case 'gt': return numeric ? na > nb : false;
    case 'gte': return numeric ? na >= nb : false;
    default: return false;
  }
}

function describeSide(side) {
  if (side.missing) return '—';
  if (side.set) return side.set.join(', ');
  return String(Math.round(side.num * 1000) / 1000);
}

// ------------------------------------------------------------------ engine

/** Evaluate one rule against a build. Never throws. */
function evaluateRule(rule, build) {
  var items = normaliseItems(build);
  var result = {
    id: rule.id,
    name: rule.name,
    severity: rule.severity === 'warn' ? 'warn' : 'block',
    message: rule.message,
    applied: false,
    passed: true,
    skipped_reason: null,
    left: null,
    right: null,
    detail: null,
  };

  if (Number(rule.enabled) === 0) {
    result.skipped_reason = 'rule disabled';
    return result;
  }
  if (OPS.indexOf(rule.op) === -1) {
    result.skipped_reason = 'unknown operator "' + rule.op + '"';
    return result;
  }
  if (KINDS.indexOf(rule.left_kind) === -1 || KINDS.indexOf(rule.right_kind) === -1) {
    result.skipped_reason = 'unknown side kind';
    return result;
  }

  var left = resolveSide(rule.left_kind, splitList(rule.left_cats), rule.left_attr, null, rule.expr, items);
  var right = resolveSide(rule.right_kind, splitList(rule.right_cats), rule.right_attr, rule.right_const, rule.expr, items);

  if (left.missing || right.missing) {
    result.skipped_reason = (left.missing ? left.why : right.why);
    return result;
  }

  // Headroom maths: left × scale + offset. Only meaningful on a number.
  if (left.num != null) {
    var scale = rule.left_scale == null ? 1 : Number(rule.left_scale);
    var offset = rule.left_offset == null ? 0 : Number(rule.left_offset);
    if (Number.isFinite(scale)) left = { num: left.num * scale };
    if (Number.isFinite(offset)) left = { num: left.num + offset };
  }

  result.applied = true;
  result.left = describeSide(left);
  result.right = describeSide(right);
  result.passed = compare(rule.op, left, right);
  result.detail = result.left + ' ' + rule.op + ' ' + result.right;
  return result;
}

/**
 * Evaluate every rule. Returns:
 *   { ok, blocks: [...], warns: [...], results: [...all, for the rule tester] }
 * `ok` is false only when a BLOCKING rule failed.
 */
function evaluate(rules, build) {
  var results = [];
  var blocks = [];
  var warns = [];
  var sorted = (rules || []).slice().sort(function (a, b) {
    return (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name));
  });

  for (var i = 0; i < sorted.length; i++) {
    var r = evaluateRule(sorted[i], build);
    results.push(r);
    if (r.applied && !r.passed) {
      (r.severity === 'block' ? blocks : warns).push(r);
    }
  }
  return { ok: blocks.length === 0, blocks: blocks, warns: warns, results: results };
}

/**
 * Would adding `option` to `build` break something?
 *
 * Returns { allowed, reason, warnings } — `reason` is the plain-English rule
 * message shown next to the disabled option. Problems the build already has
 * are not attributed to the new part.
 */
function checkAddition(rules, build, option, category) {
  var current = normaliseItems(build);
  var multi = category && (Number(category.multi) === 1);
  var kept = multi
    ? current
    : current.filter(function (it) { return it.option.category_id !== option.category_id; });

  var before = evaluate(rules, { items: current });
  var after = evaluate(rules, { items: kept.concat([{ option: option, qty: 1 }]) });

  var preexisting = {};
  for (var i = 0; i < before.blocks.length; i++) preexisting[before.blocks[i].name] = true;

  var newBlocks = after.blocks.filter(function (b) { return !preexisting[b.name]; });
  var preexistingWarn = {};
  for (var j = 0; j < before.warns.length; j++) preexistingWarn[before.warns[j].name] = true;
  var newWarns = after.warns.filter(function (w) { return !preexistingWarn[w.name]; });

  return {
    allowed: newBlocks.length === 0,
    reason: newBlocks.length ? newBlocks[0].message : null,
    reasons: newBlocks.map(function (b) { return b.message; }),
    warnings: newWarns.map(function (w) { return w.message; }),
  };
}

var RuleEngine = {
  evaluate: evaluate,
  evaluateRule: evaluateRule,
  checkAddition: checkAddition,
  resolveSide: resolveSide,
  evalExpr: evalExpr,
  normaliseItems: normaliseItems,
  parseAttrs: parseAttrs,
  KINDS: KINDS,
  OPS: OPS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = RuleEngine;
if (typeof window !== 'undefined') window.RuleEngine = RuleEngine;
