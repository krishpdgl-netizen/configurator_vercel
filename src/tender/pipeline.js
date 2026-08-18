'use strict';
/**
 * TENDER PIPELINE
 *
 * The AI reads. Deterministic code prices.
 *
 * 1. Extract text with page markers (PDF / DOCX)
 * 2. Score pages by keyword density → select pages for each call
 * 3. Two separate AI calls: commercial key points, then technical line items
 * 4. Constrained catalog search per line item, pruned by the rule engine
 * 5. Stock & lead-time assessment
 * 6. Budgetary quotation (arithmetic, not AI)
 *
 * The model never sees a cost, a margin, or a part id. It only produces
 * structured requirements from tender prose. Every extracted value carries
 * { value, page, evidence, low_confidence }.
 */

const { q } = require('../db/pool');
const catalog = require('../db/catalog');
const settings = require('../db/settings');
const pricing = require('../lib/pricing');
const engine = require('../rules/engine');
const ai = require('../lib/ai');

// ----------------------------------------------------------- text extraction

async function extractText(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (ext === 'docx' || ext === 'doc') return extractDocx(buffer);
  return extractPdf(buffer); // default: treat as PDF
}

async function extractPdf(buffer) {
  const pdfParse = require('pdf-parse');
  // pdf-parse v2 exports a PDFParse class; v1 exports a callable function.
  // Support both.
  let pages = [];
  let totalText = '';
  try {
    if (typeof pdfParse === 'function') {
      // v1 API
      const result = await pdfParse(buffer);
      totalText = result.text;
      pages = [{ page: 1, text: totalText }];
    } else if (pdfParse.PDFParse) {
      // v2 API
      const parser = new pdfParse.PDFParse();
      const result = await parser.parseBuffer(buffer, {
        pagerender: (pageData) => {
          return pageData.getTextContent().then((tc) => {
            const text = tc.items.map((i) => i.str).join(' ');
            pages.push({ page: pages.length + 1, text });
            return text;
          });
        },
      });
      totalText = pages.map((p) => `[PAGE ${p.page}]\n${p.text}`).join('\n\n');
    }
  } catch (err) {
    throw new Error(`PDF extraction failed: ${err.message}`);
  }

  if (!pages.length) pages = [{ page: 1, text: totalText }];
  return { pages, totalText, pageCount: pages.length };
}

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;
  // DOCX has no page boundaries — treat as one page
  return { pages: [{ page: 1, text }], totalText: text, pageCount: 1 };
}

// -------------------------------------------------------- scanned detection

function isScanned(pages) {
  const avg = pages.reduce((s, p) => s + p.text.length, 0) / Math.max(1, pages.length);
  return avg < 80; // fewer than 80 chars per page → almost certainly a scanned image
}

// ----------------------------------------------------------- page selection

const COMMERCIAL_KEYWORDS = ['emd', 'earnest', 'tender value', 'payment', 'pbg', 'guarantee', 'penalty', 'ld', 'liquidated', 'bid', 'deadline', 'submission', 'opening', 'pre-bid', 'validity', 'msme', 'exemption', 'make in india', 'gem', 'warranty', 'sla', 'uptime'];
const TECHNICAL_KEYWORDS = ['specification', 'technical', 'requirement', 'processor', 'memory', 'storage', 'server', 'cpu', 'ram', 'hdd', 'ssd', 'unit', 'quantity', 'nos', 'workstation', 'desktop', 'laptop', 'rack', 'switch', 'router', 'firewall', 'ups', 'motherboard', 'gpu', 'gpu', 'nic', 'psu', 'power supply', 'chassis', 'oem', 'brand'];

function scorePages(pages, keywords) {
  return pages.map((p) => {
    const lower = p.text.toLowerCase();
    const score = keywords.reduce((s, kw) => {
      const count = (lower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      return s + count;
    }, 0);
    return { ...p, score };
  }).sort((a, b) => b.score - a.score);
}

function buildContext(pages, charBudget) {
  // Sort back to page order after scoring; include pages until budget is reached
  const scored = pages.slice().sort((a, b) => b.score - a.score);
  const chosen = new Set();
  let used = 0;
  for (const p of scored) {
    if (used + p.text.length > charBudget) continue;
    chosen.add(p.page);
    used += p.text.length;
  }
  // Reassemble in page order with markers
  return pages
    .filter((p) => chosen.has(p.page))
    .sort((a, b) => a.page - b.page)
    .map((p) => `[PAGE ${p.page}]\n${p.text}`)
    .join('\n\n');
}

// ------------------------------------------------------------ AI extraction

const COMMERCIAL_FIELDS_DOC = `
Return a JSON object with these keys (any absent from the document must still appear with value:null,page:null,evidence:null,low_confidence:false):
tender_number, issuing_authority, tender_title, bid_deadline, prebid_date, opening_date,
delivery_period, tender_value, emd_amount, emd_exemption, pbg_pct, payment_terms,
ld_penalty, warranty_years, sla, oem_criteria, certifications, make_in_india,
consignee_locations, installation_scope, training_scope, evaluation_method, risk_flags.

Each value is: { "value": <the extracted value as a string>, "page": <page number int or null>, "evidence": <short verbatim fragment from the document, max 120 chars>, "low_confidence": <true if uncertain> }.
For list fields (certifications, consignee_locations, risk_flags), value is an array of strings.`;

const TECHNICAL_ITEMS_DOC = `
Return a JSON object: { "items": [ ... ] }
Each item has:
  { "description": "what the line item is (plain English)",
    "quantity": <number>,
    "unit": "nos | set | lot | ...",
    "requirements": { "attr_name": "required_value", ... },
    "page": <page number>,
    "evidence": <short verbatim fragment, max 120 chars>,
    "low_confidence": <bool> }
requirements keys should match hardware specs: socket, cores, threads, ram_gb, storage_tb, form_factor, gpu, etc.
Only extract items that appear to be hardware line items. Do not invent items.`;

async function extractCommercial(textContext, fields) {
  const fieldHints = fields.map((f) => `${f.key} (${f.label}): ${f.hint || ''}`).join('\n');
  const { parsed } = await ai.complete({
    systemPrompt: 'You are a procurement analyst extracting structured data from an Indian government tender document. Be precise and cite page numbers.',
    userPrompt: `${COMMERCIAL_FIELDS_DOC}\n\nActive extraction fields and hints:\n${fieldHints}\n\n--- DOCUMENT ---\n${textContext}`,
    json: true,
  });
  return parsed;
}

async function extractTechnical(textContext) {
  const { parsed } = await ai.complete({
    systemPrompt: 'You are a hardware procurement analyst. Extract line items and their technical specifications from this Indian government tender.',
    userPrompt: `${TECHNICAL_ITEMS_DOC}\n\n--- DOCUMENT ---\n${textContext}`,
    json: true,
  });
  return parsed?.items || [];
}

// ------------------------------------------------------------ catalog match

/**
 * For one tender line item, find the cheapest legal build from the catalog.
 *
 * Critical behaviour:
 * - If the item matches at least one category, back-fill required categories
 *   with the cheapest valid part.
 * - If it matches NOTHING, return { matched: false } — do not phantom-build.
 * - If no legal combination exists, report the conflict rather than silence it.
 */
async function matchItem(item, cats, opts, rules, deliveryDays) {
  // Step 1: find categories genuinely matching this item's requirements or description.
  //
  // CRITICAL: an option must ACTUALLY satisfy a requirement attribute or match
  // the item description — not just 'have no conflicting attrs'. Without this
  // check, items with no requirements (Printer, UPS) match every category because
  // every option trivially passes an empty requirement set, triggering back-fill
  // of every required category and producing phantom server builds.
  const reqKeys = Object.keys(item.requirements || {});
  const descWords = (item.description || '').toLowerCase().split(/W+/).filter(w => w.length > 3);

  const candidatesByCategory = new Map();
  const genuineMatchCats = new Set();

  for (const cat of cats.filter((c) => Number(c.active) === 1)) {
    const catOpts = opts.filter((o) => o.category_id === cat.id && Number(o.active) === 1);
    const matching = catOpts.filter((o) => {
      const attrs = typeof o.attrs === 'string' ? JSON.parse(o.attrs || '{}') : (o.attrs || {});
      let attrMatchCount = 0;
      let attrFailCount = 0;
      for (const key of reqKeys) {
        if (attrs[key] === undefined) continue;
        const need = String(item.requirements[key]).toLowerCase().replace(/s/g, '');
        const have = String(attrs[key]).toLowerCase().replace(/s/g, '');
        if (have.includes(need) || need.includes(have)) attrMatchCount++;
        else attrFailCount++;
      }
      if (attrFailCount > 0) return false;
      if (attrMatchCount > 0) { genuineMatchCats.add(cat.id); return true; }
      // No requirement attrs on this option — fall back to description keyword match.
      const combined = ((o.name || '') + ' ' + (cat.label || '')).toLowerCase();
      if (descWords.some(w => combined.includes(w))) { genuineMatchCats.add(cat.id); return true; }
      return false;
    });
    if (matching.length) candidatesByCategory.set(cat.id, matching);
  }

  // If nothing genuinely matched, this item is not in the catalog. Do not back-fill.
  if (!genuineMatchCats.size) return { matched: false, description: item.description };

  // Step 2: back-fill required categories not already covered
  const requiredCats = cats.filter((c) => Number(c.required) === 1 && Number(c.active) === 1);
  for (const cat of requiredCats) {
    if (!candidatesByCategory.has(cat.id)) {
      const cheapest = opts
        .filter((o) => o.category_id === cat.id && Number(o.active) === 1)
        .sort((a, b) => a.price - b.price);
      if (cheapest.length) candidatesByCategory.set(cat.id, cheapest.slice(0, 3));
    }
  }

  // Step 3: depth-first search over required categories only, cheapest-first
  const searchCats = [...candidatesByCategory.keys()].filter((id) => requiredCats.some((c) => c.id === id));
  const optionalCats = [...candidatesByCategory.keys()].filter((id) => !searchCats.includes(id));

  let best = null;

  function dfs(catIdx, currentBuild) {
    if (catIdx === searchCats.length) {
      const check = engine.evaluate(rules, { items: currentBuild.map((o) => ({ option: o, qty: 1 })) });
      if (check.ok) {
        const cost = currentBuild.reduce((s, o) => s + o.price, 0);
        if (!best || cost < best.cost) best = { cost, build: currentBuild.slice(), check };
      }
      return;
    }
    const catId = searchCats[catIdx];
    const candidates = (candidatesByCategory.get(catId) || []).sort((a, b) => a.price - b.price);
    for (const opt of candidates.slice(0, 5)) { // limit branching
      const next = [...currentBuild, opt];
      const partial = engine.evaluate(rules, { items: next.map((o) => ({ option: o, qty: 1 })) });
      if (partial.blocks.length > 0) continue; // prune
      dfs(catIdx + 1, next);
    }
  }

  dfs(0, []);

  const s = await settings.all();
  const defaultMargin = Number(s.default_margin_pct || 0);
  const catById = new Map(cats.map((c) => [c.id, c]));

  if (!best) {
    // No legal combination — show the cheapest per category, flag the conflict
    const cheapestPerCat = {};
    for (const [catId, catCandidates] of candidatesByCategory) {
      cheapestPerCat[catId] = catCandidates.sort((a, b) => a.price - b.price)[0];
    }
    return {
      matched: true,
      conflict: true,
      description: item.description,
      quantity: item.quantity || 1,
      unit: item.unit || 'nos',
      cheapestPerCategory: cheapestPerCat,
      note: 'No legal combination found for this set of requirements — the conflict is worth raising at the pre-bid meeting.',
    };
  }

  // Identify which parts were added by us (not touched by the item's requirements)
  const requiredByItem = new Set(
    [...candidatesByCategory.keys()].filter((id) => {
      const catOpts = opts.filter((o) => o.category_id === id);
      return catOpts.some((o) => {
        const attrs = typeof o.attrs === 'string' ? JSON.parse(o.attrs || '{}') : (o.attrs || {});
        return reqKeys.some((k) => attrs[k] !== undefined);
      });
    })
  );

  const buildLines = best.build.map((o) => {
    const cat = catById.get(o.category_id);
    const margin = pricing.resolveMargin(cat?.margin_pct, defaultMargin);
    return {
      option_id: o.id,
      category_id: o.category_id,
      category_label: cat?.label || o.category_id,
      name: o.name,
      specs: o.specs,
      qty: 1,
      unit_price: pricing.sellPrice(o.price, margin),
      line_total: pricing.sellPrice(o.price, margin),
      stock_qty: o.stock_qty,
      lead_days: o.lead_days,
      added_by_us: !requiredByItem.has(o.category_id),
    };
  });

  const qty = Number(item.quantity) || 1;
  const perUnit = pricing.round2(buildLines.reduce((s, l) => s + l.unit_price, 0));
  const subtotal = pricing.round2(perUnit * qty);

  // Stock and lead-time assessment
  const stockIssues = buildLines
    .filter((l) => l.stock_qty < qty)
    .map((l) => `${l.name}: ${l.stock_qty} in stock, ${qty} needed`);

  const maxLead = buildLines.reduce((m, l) => Math.max(m, Number(l.lead_days) || 0), 0);
  const leadOk = deliveryDays == null || maxLead === 0 ? null : maxLead <= deliveryDays;

  return {
    matched: true,
    conflict: false,
    description: item.description,
    quantity: qty,
    unit: item.unit || 'nos',
    page: item.page,
    evidence: item.evidence,
    low_confidence: item.low_confidence,
    requirements: item.requirements,
    build: buildLines,
    per_unit_total: perUnit,
    subtotal,
    stock_issues: stockIssues,
    lead_days: maxLead === 0 ? null : maxLead,
    lead_days_note: maxLead === 0 ? 'No lead time on record for one or more parts' : null,
    lead_ok: leadOk,
  };
}

// --------------------------------------------------------------- quotation

async function buildQuotation(matchedItems, meta) {
  const s = await settings.all();
  const taxRate = Number(s.tax_rate || 0);

  const priced = matchedItems.filter((m) => m.matched && !m.conflict);
  const conflicted = matchedItems.filter((m) => m.matched && m.conflict);
  const unmatched = matchedItems.filter((m) => !m.matched);

  const subtotal = pricing.round2(priced.reduce((s, m) => s + m.subtotal, 0));
  const tax = pricing.round2((subtotal * taxRate) / 100);

  return {
    currency: s.currency || 'INR',
    currency_symbol: s.currency_symbol || '₹',
    tax_label: s.tax_label || 'GST',
    tax_rate: taxRate,
    priced_items: priced.length,
    total_items: matchedItems.length,
    unmatched_items: unmatched.map((m) => m.description),
    conflicted_items: conflicted.map((m) => m.description),
    subtotal,
    tax,
    total: pricing.round2(subtotal + tax),
    note: unmatched.length
      ? `${unmatched.length} item(s) not in catalog and excluded from total: ${unmatched.map((m) => m.description).join('; ')}`
      : null,
    meta,
  };
}

// ---------------------------------------------------------------- main entry

async function run(tenderId) {
  const row = await q.get(`SELECT * FROM tenders WHERE id = ?`, [tenderId]);
  if (!row) throw new Error(`Tender ${tenderId} not found`);

  await q.run(`UPDATE tenders SET status='processing', error=NULL WHERE id = ?`, [tenderId]);

  try {
    // -- phase 1: text
    const { pages, totalText, pageCount } = await extractText(
      Buffer.from(row.raw_text || '', 'base64'),
      row.filename
    );

    await q.run(`UPDATE tenders SET pages=?, chars=? WHERE id=?`, [pageCount, totalText.length, tenderId]);

    if (isScanned(pages)) {
      await q.run(`UPDATE tenders SET status='error', error=? WHERE id=?`,
        ['This document appears to be a scanned image. Text could not be extracted. Please provide a text-based PDF or DOCX.', tenderId]);
      return;
    }

    // -- phase 2: two AI calls
    const commercialCtx = buildContext(scorePages(pages, COMMERCIAL_KEYWORDS), 500_000);
    const technicalCtx = buildContext(scorePages(pages, TECHNICAL_KEYWORDS), 600_000);

    const fields = await q.all(`SELECT * FROM extraction_fields WHERE active=1 ORDER BY sort`);
    const meta = await extractCommercial(commercialCtx, fields);
    const rawItems = await extractTechnical(technicalCtx);

    await q.run(`UPDATE tenders SET meta_json=?, items_json=? WHERE id=?`,
      [JSON.stringify(meta), JSON.stringify(rawItems), tenderId]);

    // -- phase 3: matching
    const [cats, opts, rules] = await Promise.all([
      catalog.categories({ activeOnly: true }),
      catalog.options({ activeOnly: true }),
      catalog.rules({ enabledOnly: true }),
    ]);

    // Parse delivery period for stock/lead-time assessment
    const deliveryRaw = meta.delivery_period?.value || '';
    const daysMatch = deliveryRaw.match(/(\d+)\s*(day|week|month)/i);
    let deliveryDays = null;
    if (daysMatch) {
      const n = Number(daysMatch[1]);
      if (/week/i.test(daysMatch[2])) deliveryDays = n * 7;
      else if (/month/i.test(daysMatch[2])) deliveryDays = n * 30;
      else deliveryDays = n;
    }

    const matched = await Promise.all(rawItems.map((item) => matchItem(item, cats, opts, rules, deliveryDays)));
    const quotation = await buildQuotation(matched, meta);

    await q.run(`UPDATE tenders SET match_json=?, status='done' WHERE id=?`,
      [JSON.stringify({ items: matched, quotation }), tenderId]);

  } catch (err) {
    console.error('[tender]', err);
    await q.run(`UPDATE tenders SET status='error', error=? WHERE id=?`, [err.message, tenderId]);
  }
}

module.exports = { run, extractText, extractCommercial, extractTechnical, matchItem, buildQuotation };
