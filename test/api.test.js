'use strict';
/**
 * Integration tests. These need a real Postgres — set DATABASE_URL first:
 *   DATABASE_URL=postgres://postgres:pgpass@localhost/configurator \
 *   ADMIN_TOKEN=test-token node --test test/api.test.js
 *
 * They create and drop their own tables, so point them at a scratch database.
 */

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-token';
process.env.SETTINGS_TTL_MS = '0';

const { q } = require('../src/db/pool');
const app = require('../src/app');
const auth = require('../src/lib/auth');

const TOKEN = process.env.ADMIN_TOKEN;
let base;
let server;

test.before(async () => {
  await q.run(`DROP TABLE IF EXISTS leads, tenders, rules, options, categories, extraction_fields, settings CASCADE`);
  await app.ensureReady();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await q.close();
});

const api = (path, opts = {}) => fetch(base + path, {
  ...opts,
  headers: {
    'content-type': 'application/json',
    ...(opts.admin === false ? {} : { 'x-admin-token': TOKEN }),
    ...(opts.headers || {}),
  },
});
const json = async (res) => [res.status, await res.json()];

// --------------------------------------------------------------- schema/seed

test('schema is created and seeded with settings and extraction fields only', async () => {
  const fields = await q.val(`SELECT COUNT(*)::int FROM extraction_fields`);
  assert.ok(fields >= 22, `expected ~22 extraction fields, got ${fields}`);

  const groups = await q.all(`SELECT DISTINCT group_name FROM extraction_fields`);
  assert.ok(groups.length >= 6);

  assert.equal(await q.val(`SELECT COUNT(*)::int FROM options`), 0, 'ships with no demo parts');
  assert.equal(await q.val(`SELECT COUNT(*)::int FROM categories`), 0);
  assert.equal(await q.val(`SELECT value FROM settings WHERE key='gemini_model'`), 'gemini-3.1-flash-lite');
});

test('init is idempotent and never overwrites edited settings', async () => {
  await q.run(`UPDATE settings SET value='24' WHERE key='default_margin_pct'`);
  await require('../src/db/schema').init();
  assert.equal(await q.val(`SELECT value FROM settings WHERE key='default_margin_pct'`), '24');
  await q.run(`UPDATE settings SET value='18' WHERE key='default_margin_pct'`);
});

// ---------------------------------------------------------------------- auth

test('admin endpoints reject a missing token', async () => {
  const [status] = await json(await api('/api/admin/catalog', { admin: false }));
  assert.equal(status, 401);
});

test('failed attempts lock an IP out with a 429 and a Retry-After', async () => {
  auth._reset();
  let last;
  for (let i = 0; i < auth.MAX_ATTEMPTS + 1; i++) {
    last = await api('/api/admin/catalog', { headers: { 'x-admin-token': 'wrong' } });
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'), 'Retry-After header set');
  auth._reset();
});

test('a correct token still works after the lockout is cleared', async () => {
  const [status] = await json(await api('/api/admin/catalog'));
  assert.equal(status, 200);
});

test('token comparison is length-safe and value-safe', () => {
  assert.equal(auth.safeEqual('abc', 'abc'), true);
  assert.equal(auth.safeEqual('abc', 'abcd'), false);
  assert.equal(auth.safeEqual('', 'abc'), false);
});

// ------------------------------------------------------------- catalog CRUD

test('categories and options round-trip through the admin API', async () => {
  let [status, cat] = await json(await api('/api/admin/categories', {
    method: 'POST',
    body: JSON.stringify({ id: 'cpu', label: 'Processor', sort: 10, required: 1, max_qty: 2 }),
  }));
  assert.equal(status, 200);
  assert.equal(cat.id, 'cpu');
  assert.equal(cat.margin_pct, null, 'an omitted margin stays NULL, not 0');

  await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ id: 'mb', label: 'Motherboard', sort: 20, required: 1 }) });
  await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ id: 'ram', label: 'Memory', sort: 30, required: 1, multi: 1, max_qty: 8 }) });

  [status] = await json(await api('/api/admin/options', {
    method: 'POST',
    body: JSON.stringify({
      id: 'cpu-4210', category_id: 'cpu', name: 'Xeon Silver 4210',
      price: 40000, stock_qty: 6, lead_days: 14,
      attrs: JSON.stringify({ socket: 'LGA3647', tdp: 85 }),
    }),
  }));
  assert.equal(status, 200);

  const [, opt] = await json(await api('/api/admin/options', {
    method: 'POST',
    body: JSON.stringify({ id: 'mb-c621', category_id: 'mb', name: 'C621 board', price: 25000, stock_qty: 3, attrs: '{"socket":"lga 3647","mem_type":"DDR4","dimm_slots":8}' }),
  }));
  assert.equal(opt.category_id, 'mb');
});

test('an option in an unknown category is refused', async () => {
  const [status, body] = await json(await api('/api/admin/options', {
    method: 'POST',
    body: JSON.stringify({ id: 'x', category_id: 'nope', name: 'x', price: 1 }),
  }));
  assert.equal(status, 400);
  assert.match(body.error, /Unknown category/);
});

test('invalid attrs JSON is refused before it reaches the rule engine', async () => {
  const [status] = await json(await api('/api/admin/options', {
    method: 'POST',
    body: JSON.stringify({ id: 'y', category_id: 'cpu', name: 'y', price: 1, attrs: '{oops' }),
  }));
  assert.equal(status, 400);
});

test('a zero margin has to be sent deliberately', async () => {
  const [status, body] = await json(await api('/api/admin/categories', {
    method: 'POST',
    body: JSON.stringify({ id: 'cpu', label: 'Processor', margin_pct: 0 }),
  }));
  assert.equal(status, 400);
  assert.match(body.error, /landed cost/);

  const [ok] = await json(await api('/api/admin/categories', {
    method: 'POST',
    body: JSON.stringify({ id: 'cpu', label: 'Processor', required: 1, sort: 10, max_qty: 2, margin_pct: 0, allow_zero_margin: true }),
  }));
  assert.equal(ok, 200);

  // put it back to "unspecified"
  await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ id: 'cpu', label: 'Processor', required: 1, sort: 10, max_qty: 2, margin_pct: '' }) });
  const row = await q.get(`SELECT margin_pct FROM categories WHERE id='cpu'`);
  assert.equal(row.margin_pct, null);
});

test('retiring a part sets active = 0 rather than deleting it', async () => {
  await api('/api/admin/options', { method: 'POST', body: JSON.stringify({ id: 'old-cpu', category_id: 'cpu', name: 'Old CPU', price: 100 }) });
  await api('/api/admin/options/old-cpu', { method: 'DELETE' });
  const row = await q.get(`SELECT active FROM options WHERE id='old-cpu'`);
  assert.equal(Number(row.active), 0);
});

// ------------------------------------------------------------ customer view

test('the public catalog exposes sell prices and never costs or margins', async () => {
  const [status, cat] = await json(await api('/api/catalog', { admin: false }));
  assert.equal(status, 200);

  const cpu = cat.options.find((o) => o.id === 'cpu-4210');
  // 40 000 landed, 18% default margin on selling price → 48 780.49
  assert.equal(cpu.price, 48780.49);

  const serialised = JSON.stringify(cat);
  assert.equal(serialised.includes('margin_pct'), false, 'no margin anywhere in the payload');
  assert.equal(cat.categories.every((c) => c.margin_pct === undefined), true);
  assert.equal(cat.options.every((o) => o.cost === undefined), true);
  assert.equal(cat.options.some((o) => o.id === 'old-cpu'), false, 'retired parts are not offered');
});

test('a category margin overrides the default', async () => {
  await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ id: 'mb', label: 'Motherboard', sort: 20, required: 1, margin_pct: 30 }) });
  const [, cat] = await json(await api('/api/catalog', { admin: false }));
  const mb = cat.options.find((o) => o.id === 'mb-c621');
  assert.equal(mb.price, 35714.29); // 25 000 / 0.70
});

// ------------------------------------------------------------------- rules

test('the starter pack loads on demand and is not double-loaded', async () => {
  const [, first] = await json(await api('/api/admin/rules/starter-pack', { method: 'POST' }));
  assert.ok(first.added > 5);
  const [, second] = await json(await api('/api/admin/rules/starter-pack', { method: 'POST' }));
  assert.equal(second.added, 0);
});

test('a rule without a customer-facing message is refused', async () => {
  const [status] = await json(await api('/api/admin/rules', {
    method: 'POST',
    body: JSON.stringify({ name: 'x', op: 'eq', left_kind: 'value', right_kind: 'const' }),
  }));
  assert.equal(status, 400);
});

test('the rule tester reports fired and skipped rules with their arithmetic', async () => {
  const [status, out] = await json(await api('/api/admin/rules/test', {
    method: 'POST',
    body: JSON.stringify({ selection: [{ option_id: 'cpu-4210' }, { option_id: 'mb-c621' }] }),
  }));
  assert.equal(status, 200);
  const socket = out.results.find((r) => r.name === 'cpu_socket_matches_board');
  assert.equal(socket.applied, true);
  assert.equal(socket.passed, true);
  const psu = out.results.find((r) => r.name === 'psu_headroom');
  assert.equal(psu.applied, false, 'no PSU selected yet, so the rule is skipped');
});

test('validate blocks an incompatible build and names the missing categories', async () => {
  await api('/api/admin/options', {
    method: 'POST',
    body: JSON.stringify({ id: 'ram-ddr5', category_id: 'ram', name: 'DDR5 32GB', price: 9000, stock_qty: 40, attrs: '{"mem_type":"DDR5","size_gb":32}' }),
  });
  const [, out] = await json(await api('/api/validate', {
    admin: false,
    method: 'POST',
    body: JSON.stringify({ selection: [{ option_id: 'cpu-4210' }, { option_id: 'mb-c621' }, { option_id: 'ram-ddr5', qty: 2 }] }),
  }));
  assert.equal(out.ok, false);
  assert.ok(out.blocks.some((b) => /memory type/i.test(b.message)));
  assert.equal(out.blocks[0].detail !== undefined, true);
});

// ----------------------------------------------------------------- enquiry

test('a blocked configuration cannot be submitted as an enquiry', async () => {
  const [status, body] = await json(await api('/api/enquiry', {
    admin: false,
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Buyer', mobile: '9999999999',
      selection: [{ option_id: 'cpu-4210' }, { option_id: 'mb-c621' }, { option_id: 'ram-ddr5' }],
    }),
  }));
  assert.equal(status, 422);
  assert.ok(body.blocks.length);
});

test('a valid enquiry is stored with its priced snapshot', async () => {
  await api('/api/admin/options', {
    method: 'POST',
    body: JSON.stringify({ id: 'ram-ddr4', category_id: 'ram', name: 'DDR4 32GB', price: 8000, stock_qty: 40, attrs: '{"mem_type":"DDR4","size_gb":32}' }),
  });
  const [status, body] = await json(await api('/api/enquiry', {
    admin: false,
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Buyer', mobile: '9999999999', units: 3,
      selection: [{ option_id: 'cpu-4210' }, { option_id: 'mb-c621' }, { option_id: 'ram-ddr4', qty: 2 }],
    }),
  }));
  assert.equal(status, 200);
  assert.match(body.ref, /^ENQ-/);
  assert.equal(body.quote.units, 3);
  assert.equal(body.quote.total, Math.round((body.quote.subtotal * 1.18 + Number.EPSILON) * 100) / 100);

  const row = await q.get(`SELECT * FROM leads WHERE ref = ?`, [body.ref]);
  assert.equal(Number(row.units), 3);
  assert.ok(JSON.parse(row.config_json).length === 3);
});

test('an enquiry missing a required category is refused', async () => {
  const [status, body] = await json(await api('/api/enquiry', {
    admin: false,
    method: 'POST',
    body: JSON.stringify({ name: 'Test', mobile: '9', selection: [{ option_id: 'cpu-4210' }] }),
  }));
  assert.equal(status, 422);
  assert.ok(body.missing_required.length);
});

// ------------------------------------------------------------ Excel round-trip

test('export produces every sheet with the current catalog', async () => {
  const res = await api('/api/admin/export.xlsx');
  assert.equal(res.status, 200);
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Categories', 'Options', 'Rules', 'ExtractionFields', 'Settings']);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Options);
  assert.ok(rows.some((r) => r.id === 'cpu-4210'));
});

function workbookFrom(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function upload(buf) {
  const form = new FormData();
  form.append('file', new Blob([buf]), 'catalog.xlsx');
  const res = await fetch(base + '/api/admin/import', {
    method: 'POST', headers: { 'x-admin-token': TOKEN }, body: form,
  });
  return [res.status, await res.json()];
}

test('import updates matched rows and adds new ones', async () => {
  const buf = workbookFrom({
    Options: [
      { id: 'cpu-4210', category_id: 'cpu', name: 'Xeon Silver 4210', specs: '10C/20T', price: 41500, stock_qty: 4, lead_days: 21, active: 1, attrs: '{"socket":"LGA3647","tdp":85}' },
      { id: 'psu-550', category_id: 'psu', name: 'PSU 550W', specs: '', price: 6000, stock_qty: 12, lead_days: 7, active: 1, attrs: '{"watts":550}' },
    ],
    Categories: [{ id: 'psu', label: 'Power supply', sort: 60, required: 1, max_qty: 2, multi: 1, margin_pct: '', active: 1 }],
  });
  const [status, body] = await upload(buf);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.applied.options, 2);

  const cpu = await q.get(`SELECT * FROM options WHERE id='cpu-4210'`);
  assert.equal(cpu.price, 41500);
  assert.equal(cpu.stock_qty, 4);
  const psuCat = await q.get(`SELECT * FROM categories WHERE id='psu'`);
  assert.equal(psuCat.margin_pct, null, 'an empty margin cell means "use the default"');
});

test('import deletes nothing', async () => {
  const before = await q.val(`SELECT COUNT(*)::int FROM options`);
  await upload(workbookFrom({ Options: [{ id: 'cpu-4210', category_id: 'cpu', name: 'Xeon Silver 4210', price: 41500, stock_qty: 4, lead_days: 21, active: 1, attrs: '{}' }] }));
  assert.equal(await q.val(`SELECT COUNT(*)::int FROM options`), before);
});

test('a bad row rejects the whole import and changes nothing', async () => {
  const before = await q.get(`SELECT price FROM options WHERE id='cpu-4210'`);
  const [status, body] = await upload(workbookFrom({
    Options: [
      { id: 'cpu-4210', category_id: 'cpu', name: 'Xeon Silver 4210', price: 99999, stock_qty: 4, lead_days: 21, active: 1, attrs: '{}' },
      { id: 'broken', category_id: 'cpu', name: 'Broken', price: 100, stock_qty: 1, lead_days: 1, active: 1, attrs: '{not json}' },
    ],
  }));
  assert.equal(status, 400);
  assert.ok(body.details.some((d) => /not valid JSON/.test(d)));
  const after = await q.get(`SELECT price FROM options WHERE id='cpu-4210'`);
  assert.equal(after.price, before.price, 'the good row in the same file was not applied either');
});

test('an option referencing a missing category is rejected by name', async () => {
  const [status, body] = await upload(workbookFrom({
    Options: [{ id: 'z', category_id: 'ghost', name: 'Z', price: 1, stock_qty: 0, lead_days: 0, active: 1, attrs: '{}' }],
  }));
  assert.equal(status, 400);
  assert.match(body.details[0], /ghost/);
});

test('an unrecognised workbook is refused with a list of expected sheets', async () => {
  const [status, body] = await upload(workbookFrom({ Sheet1: [{ a: 1 }] }));
  assert.equal(status, 400);
  assert.match(body.details[0], /Categories/);
});

// -------------------------------------------------------------- browser build

test('the browser build is the same file the server evaluates with', async () => {
  const res = await fetch(base + '/rules.browser.js');
  assert.equal(res.status, 200);
  const src = await res.text();
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.ok(src.includes('window.RuleEngine = RuleEngine'));
  const fileSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'rules', 'engine.js'), 'utf8');
  assert.ok(src.includes(fileSrc.split('\n').slice(40, 60).join('\n')), 'served verbatim from the engine source');
});

// ------------------------------------------------------------------- health

test('healthz reports the database connection', async () => {
  const [status, body] = await json(await api('/healthz', { admin: false }));
  assert.equal(status, 200);
  assert.equal(body.db, 'up');
});

// ------------------------------------------------------- data layer details

test('placeholder rewriting handles ? and @named forms', () => {
  const c1 = q._compile('SELECT * FROM t WHERE a = ? AND b = ?', [1, 2]);
  assert.equal(c1.text, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  const c2 = q._compile('SELECT * FROM t WHERE a = @x AND b = @y AND c = @x', { x: 1, y: 2 });
  assert.equal(c2.text, 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $1');
  assert.deepEqual(c2.values, [1, 2]);
  assert.throws(() => q._compile('SELECT ?', [1, 2]), /mismatch/);
  assert.throws(() => q._compile('SELECT @a', {}), /Missing named parameter/);
});

test('a failed transaction rolls back completely', async () => {
  const before = await q.val(`SELECT COUNT(*)::int FROM categories`);
  await assert.rejects(q.tx(async (t) => {
    await t.run(`INSERT INTO categories (id, label) VALUES ('tx-test', 'TX')`);
    throw new Error('boom');
  }));
  assert.equal(await q.val(`SELECT COUNT(*)::int FROM categories`), before);
});
