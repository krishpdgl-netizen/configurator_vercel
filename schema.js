'use strict';
/**
 * Schema is created idempotently on boot and seeded only when empty.
 * Nothing here ever overwrites existing rows.
 *
 * Statements are executed ONE AT A TIME — some poolers (Neon's included)
 * reject multi-statement queries.
 */

const { q } = require('./pool');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS categories (
     id         TEXT PRIMARY KEY,
     label      TEXT NOT NULL,
     note       TEXT,
     sort       INTEGER NOT NULL DEFAULT 0,
     required   INTEGER NOT NULL DEFAULT 0,
     max_qty    INTEGER NOT NULL DEFAULT 1,
     multi      INTEGER NOT NULL DEFAULT 0,
     margin_pct DOUBLE PRECISION,            -- NULL = use default_margin_pct
     active     INTEGER NOT NULL DEFAULT 1
   )`,

  `CREATE TABLE IF NOT EXISTS options (
     id          TEXT PRIMARY KEY,
     category_id TEXT NOT NULL REFERENCES categories(id) ON UPDATE CASCADE,
     name        TEXT NOT NULL,
     specs       TEXT,
     price       DOUBLE PRECISION NOT NULL DEFAULT 0,  -- LANDED COST. Never sent to customers.
     stock_qty   INTEGER NOT NULL DEFAULT 0,
     lead_days   INTEGER NOT NULL DEFAULT 0,           -- 0 = no lead time on record
     active      INTEGER NOT NULL DEFAULT 1,
     attrs       TEXT NOT NULL DEFAULT '{}',
     updated_at  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_options_cat ON options(category_id)`,

  `CREATE TABLE IF NOT EXISTS rules (
     id          SERIAL PRIMARY KEY,
     name        TEXT NOT NULL,
     severity    TEXT NOT NULL DEFAULT 'block',
     message     TEXT NOT NULL,
     enabled     INTEGER NOT NULL DEFAULT 1,
     sort        INTEGER NOT NULL DEFAULT 0,
     left_kind   TEXT,
     left_cats   TEXT,
     left_attr   TEXT,
     left_scale  DOUBLE PRECISION,
     left_offset DOUBLE PRECISION,
     op          TEXT,
     right_kind  TEXT,
     right_cats  TEXT,
     right_attr  TEXT,
     right_const TEXT,
     expr        TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS extraction_fields (
     id         SERIAL PRIMARY KEY,
     key        TEXT NOT NULL UNIQUE,
     label      TEXT NOT NULL,
     hint       TEXT,
     type       TEXT NOT NULL DEFAULT 'text',
     group_name TEXT NOT NULL DEFAULT 'General',
     sort       INTEGER NOT NULL DEFAULT 0,
     active     INTEGER NOT NULL DEFAULT 1
   )`,

  `CREATE TABLE IF NOT EXISTS leads (
     id          SERIAL PRIMARY KEY,
     ref         TEXT NOT NULL UNIQUE,
     name        TEXT,
     company     TEXT,
     mobile      TEXT,
     email       TEXT,
     city        TEXT,
     units       INTEGER NOT NULL DEFAULT 1,
     notes       TEXT,
     config_json TEXT,
     subtotal    DOUBLE PRECISION,
     tax         DOUBLE PRECISION,
     total       DOUBLE PRECISION,
     source      TEXT,
     created_at  TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS tenders (
     id         SERIAL PRIMARY KEY,
     ref        TEXT NOT NULL UNIQUE,
     filename   TEXT,
     file_url   TEXT,                 -- original document kept, not just its text
     pages      INTEGER,
     chars      INTEGER,
     status     TEXT NOT NULL DEFAULT 'queued',
     error      TEXT,
     raw_text   TEXT,
     meta_json  TEXT,
     items_json TEXT,
     match_json TEXT,
     created_at TEXT
   )`,
];

const SEED_SETTINGS = {
  company: 'Panache DigiLife',
  currency: 'INR',
  currency_symbol: '₹',
  locale: 'en-IN',
  tax_label: 'GST 18%',
  tax_rate: '18',
  default_margin_pct: '18',
  gemini_model: 'gemini-3.1-flash-lite',
};

// ~22 fields across seven groups.
const SEED_FIELDS = [
  ['tender_number', 'Tender / Bid number', 'GeM bid number or tender reference ID', 'text', 'Identification'],
  ['issuing_authority', 'Issuing authority', 'Buyer organisation, department, ministry', 'text', 'Identification'],
  ['tender_title', 'Tender title', 'Short description of what is being procured', 'text', 'Identification'],
  ['bid_deadline', 'Bid submission deadline', 'Last date and time for bid submission', 'date', 'Dates'],
  ['prebid_date', 'Pre-bid meeting date', 'Date of the pre-bid / clarification meeting, if any', 'date', 'Dates'],
  ['opening_date', 'Bid opening date', 'Technical bid opening date', 'date', 'Dates'],
  ['delivery_period', 'Delivery period', 'Days or weeks allowed for delivery from PO date', 'text', 'Dates'],
  ['tender_value', 'Estimated tender value', 'Estimated contract value if stated', 'money', 'Commercial'],
  ['emd_amount', 'EMD amount', 'Earnest money deposit payable', 'money', 'Commercial'],
  ['emd_exemption', 'EMD exemption', 'Exemptions allowed, e.g. MSME / startup / NSIC', 'text', 'Commercial'],
  ['pbg_pct', 'Performance guarantee %', 'PBG as a percentage of contract value', 'number', 'Commercial'],
  ['payment_terms', 'Payment terms', 'Milestones, credit period, retention', 'text', 'Commercial'],
  ['ld_penalty', 'LD / penalty clause', 'Liquidated damages rate and cap for late delivery', 'text', 'Commercial'],
  ['warranty_years', 'Warranty period', 'Warranty in years, and whether onsite', 'number', 'Technical'],
  ['sla', 'SLA / uptime', 'Response time, resolution time, uptime commitment', 'text', 'Technical'],
  ['oem_criteria', 'OEM eligibility criteria', 'Turnover, years in business, OEM authorisation', 'text', 'Eligibility'],
  ['certifications', 'Required certifications', 'BIS, ISO, STQC, ROHS, Energy Star, etc.', 'list', 'Eligibility'],
  ['make_in_india', 'Make in India clause', 'Local content percentage and Class I/II supplier status', 'text', 'Eligibility'],
  ['consignee_locations', 'Consignee locations', 'Delivery sites with quantities per site', 'list', 'Logistics'],
  ['installation_scope', 'Installation scope', 'Who installs and commissions, and what is included', 'text', 'Logistics'],
  ['training_scope', 'Training scope', 'Training days, headcount, location', 'text', 'Logistics'],
  ['evaluation_method', 'Evaluation method', 'L1 / QCBS / lowest per item, and how ties break', 'text', 'Risk'],
  ['risk_flags', 'Risk flags', 'Unusual, one-sided or onerous clauses worth escalating', 'list', 'Risk'],
];

async function migrate() {
  for (const sql of STATEMENTS) {
    await q.run(sql); // individually — poolers may reject multi-statement
  }
  // Additive columns for databases created by an earlier build.
  await q.run(`ALTER TABLE tenders ADD COLUMN IF NOT EXISTS file_url TEXT`);
}

async function seedIfEmpty() {
  for (const [key, value] of Object.entries(SEED_SETTINGS)) {
    await q.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  const fieldCount = await q.val(`SELECT COUNT(*)::int FROM extraction_fields`);
  if (fieldCount === 0) {
    let sort = 0;
    for (const [key, label, hint, type, group] of SEED_FIELDS) {
      sort += 10;
      await q.run(
        `INSERT INTO extraction_fields (key, label, hint, type, group_name, sort, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (key) DO NOTHING`,
        [key, label, hint, type, group, sort]
      );
    }
  }
  // No demo catalog. An empty catalog is more useful than fictional parts.
}

async function init() {
  await migrate();
  await seedIfEmpty();
}

module.exports = { init, migrate, seedIfEmpty, SEED_SETTINGS };
