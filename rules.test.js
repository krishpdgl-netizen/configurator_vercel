'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/rules/engine');
const STARTER = require('../src/rules/starter-pack');

const opt = (id, cat, attrs, name) => ({ id, category_id: cat, name: name || id, attrs });
const build = (...items) => ({ items: items.map((i) => (i.option ? i : { option: i, qty: 1 })) });

const CPU = opt('cpu-4210', 'cpu', { socket: 'LGA3647', tdp: 85, cores: 10 });
const CPU_AM4 = opt('cpu-am4', 'cpu', { socket: 'AM4', tdp: 65 });
const MB = opt('mb-c621', 'mb', {
  socket: 'lga 3647', mem_type: 'DDR4', dimm_slots: 8, m2_slots: 2,
  pcie_slots: 4, max_mem_gb: 512, form: 'ATX',
});
const RAM = opt('ram-32', 'ram', { mem_type: 'DDR4', size_gb: 32 });
const RAM5 = opt('ram-ddr5', 'ram', { mem_type: 'DDR5', size_gb: 32 });
const GPU = opt('gpu-a2', 'gpu', { slots: 1, tdp: 60 });
const PSU550 = opt('psu-550', 'psu', { watts: 550 });
const PSU300 = opt('psu-300', 'psu', { watts: 300 });
const CHASSIS = opt('ch-2u', 'chassis', { bay: ['2.5"', '3.5"'], form_factor: ['ATX', 'EATX'] });

// ------------------------------------------------------------------ operators

test('eq compares spec strings insensitive to case and spacing', () => {
  const rule = STARTER.find((r) => r.name === 'cpu_socket_matches_board');
  const ok = E.evaluateRule(rule, build(CPU, MB));
  assert.equal(ok.applied, true);
  assert.equal(ok.passed, true, 'LGA3647 should equal "lga 3647"');

  const bad = E.evaluateRule(rule, build(CPU_AM4, MB));
  assert.equal(bad.passed, false);
});

test('neq holds only when the left value differs from every right value', () => {
  const rule = { name: 'x', op: 'neq', left_kind: 'value', left_cats: 'cpu', left_attr: 'socket', right_kind: 'const', right_const: 'AM4', severity: 'block', message: 'm' };
  assert.equal(E.evaluateRule(rule, build(CPU)).passed, true);
  assert.equal(E.evaluateRule(rule, build(CPU_AM4)).passed, false);
});

test('lt / lte / gt / gte compare numerically', () => {
  const mk = (op, konst) => ({ name: op, op, severity: 'block', message: 'm', left_kind: 'max', left_cats: 'psu', left_attr: 'watts', right_kind: 'const', right_const: String(konst) });
  assert.equal(E.evaluateRule(mk('lt', 600), build(PSU550)).passed, true);
  assert.equal(E.evaluateRule(mk('lt', 550), build(PSU550)).passed, false);
  assert.equal(E.evaluateRule(mk('lte', 550), build(PSU550)).passed, true);
  assert.equal(E.evaluateRule(mk('gt', 500), build(PSU550)).passed, true);
  assert.equal(E.evaluateRule(mk('gte', 550), build(PSU550)).passed, true);
  assert.equal(E.evaluateRule(mk('gte', 551), build(PSU550)).passed, false);
});

test('ordering operators never pass on non-numeric values', () => {
  const rule = { name: 'x', op: 'lt', severity: 'block', message: 'm', left_kind: 'value', left_cats: 'cpu', left_attr: 'socket', right_kind: 'const', right_const: 'zebra' };
  assert.equal(E.evaluateRule(rule, build(CPU)).passed, false);
});

test('in / subset require every left value to appear on the right', () => {
  const rule = STARTER.find((r) => r.name === 'drive_form_matches_chassis_bay');
  const ssd25 = opt('ssd-1', 'ssd', { form: '2.5"' });
  const ssd35 = opt('hdd-1', 'hdd', { form: '5.25"' });
  assert.equal(E.evaluateRule(rule, build(ssd25, CHASSIS)).passed, true);
  assert.equal(E.evaluateRule(rule, build(ssd25, ssd35, CHASSIS)).passed, false);

  const subset = { ...rule, op: 'subset' };
  assert.equal(E.evaluateRule(subset, build(ssd25, CHASSIS)).passed, true);
});

test('nin passes only when no left value appears on the right', () => {
  const rule = { name: 'x', op: 'nin', severity: 'block', message: 'm', left_kind: 'value', left_cats: 'cpu', left_attr: 'socket', right_kind: 'const', right_const: 'AM4,AM5,LGA1700' };
  assert.equal(E.evaluateRule(rule, build(CPU)).passed, true);
  assert.equal(E.evaluateRule(rule, build(CPU_AM4)).passed, false);
});

// ---------------------------------------------------------------- side kinds

test('count is quantity-weighted, not a row count', () => {
  const b = { items: [{ option: RAM, qty: 4 }, { option: MB, qty: 1 }] };
  const rule = STARTER.find((r) => r.name === 'dimm_slots_not_exceeded');
  assert.equal(E.evaluateRule(rule, b).passed, true, '4 modules ≤ 8 slots');

  const over = { items: [{ option: RAM, qty: 12 }, { option: MB, qty: 1 }] };
  assert.equal(E.evaluateRule(rule, over).passed, false, '12 modules > 8 slots');
});

test('sum multiplies attribute by quantity', () => {
  const side = E.resolveSide('sum', ['ram'], 'size_gb', null, null,
    E.normaliseItems({ items: [{ option: RAM, qty: 4 }] }));
  assert.equal(side.num, 128);
});

test('max and min pick across categories', () => {
  const items = E.normaliseItems(build(PSU300, PSU550));
  assert.equal(E.resolveSide('max', ['psu'], 'watts', null, null, items).num, 550);
  assert.equal(E.resolveSide('min', ['psu'], 'watts', null, null, items).num, 300);
});

test('value collects distinct values and flattens array attributes', () => {
  const items = E.normaliseItems(build(CHASSIS));
  const side = E.resolveSide('value', ['chassis'], 'bay', null, null, items);
  assert.deepEqual(side.set, ['2.5"', '3.5"']);
});

test('const parses a comma list into a set and a lone number into a number', () => {
  const list = E.resolveSide('const', [], null, 'a, b ,c', null, []);
  assert.deepEqual(list.set, ['a', 'b', 'c']);
  assert.equal(E.resolveSide('const', [], null, '42', null, []).num, 42);
});

// ------------------------------------------------------------------- scaling

test('left_scale and left_offset implement PSU headroom', () => {
  const rule = STARTER.find((r) => r.name === 'psu_headroom');
  // 85 + 60 = 145 W draw → 145 × 1.25 + 110 = 291.25 W required
  assert.equal(E.evaluateRule(rule, build(CPU, GPU, PSU550)).passed, true);
  assert.equal(E.evaluateRule(rule, build(CPU, GPU, PSU300)).passed, true);

  const hungry = opt('gpu-big', 'gpu', { slots: 2, tdp: 350 });
  const r = E.evaluateRule(rule, build(CPU, hungry, PSU300));
  assert.equal(r.passed, false, '(85+350)×1.25+110 = 653.75 W > 300 W');
  assert.equal(r.left, '653.75');
});

// ------------------------------------------------------------------ skipping

test('a rule with a missing side is skipped, not failed', () => {
  const rule = STARTER.find((r) => r.name === 'cpu_socket_matches_board');
  const r = E.evaluateRule(rule, build(CPU)); // no motherboard yet
  assert.equal(r.applied, false);
  assert.equal(r.passed, true);
  assert.match(r.skipped_reason, /socket/);
});

test('a disabled rule never applies', () => {
  const rule = { ...STARTER[0], enabled: 0 };
  assert.equal(E.evaluateRule(rule, build(CPU_AM4, MB)).applied, false);
});

test('an unknown operator is reported, not thrown', () => {
  const r = E.evaluateRule({ ...STARTER[0], op: 'approximately' }, build(CPU, MB));
  assert.equal(r.applied, false);
  assert.match(r.skipped_reason, /unknown operator/);
});

// ---------------------------------------------------------------- expressions

test('expr evaluates aggregate calls and arithmetic', () => {
  const items = E.normaliseItems(build(CPU, GPU));
  assert.equal(E.evalExpr('sum(cpu,gpu.tdp) * 1.25 + 110', items).num, 291.25);
  assert.equal(E.evalExpr('count(cpu) + count(gpu)', items).num, 2);
});

test('expr refuses anything that is not arithmetic', () => {
  const items = E.normaliseItems(build(CPU));
  const r = E.evalExpr('process.exit(1)', items);
  assert.equal(r.missing, true);
  assert.match(r.why, /unsupported syntax/);
});

test('expr reports a missing term instead of silently using zero', () => {
  const r = E.evalExpr('max(mb.pcie_slots) - 1', E.normaliseItems(build(CPU)));
  assert.equal(r.missing, true);
});

// -------------------------------------------------------------- whole builds

test('evaluate separates blocks from warns and stays ok on warns alone', () => {
  const out = E.evaluate(STARTER, { items: [{ option: CPU, qty: 1 }, { option: MB, qty: 1 }, { option: RAM, qty: 2 }, { option: PSU550, qty: 1 }] });
  assert.equal(out.ok, true, 'single PSU is a warning, not a block');
  assert.ok(out.warns.some((w) => w.name === 'rack_single_psu'));
});

test('evaluate blocks a mismatched build', () => {
  const out = E.evaluate(STARTER, build(CPU, MB, RAM5));
  assert.equal(out.ok, false);
  assert.ok(out.blocks.some((b) => b.name === 'memory_type_matches_board'));
});

// ------------------------------------------------------------ checkAddition

test('checkAddition explains why an option is unavailable', () => {
  const r = E.checkAddition(STARTER, build(MB), CPU_AM4, { multi: 0 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /socket/i);
});

test('checkAddition allows a compatible part', () => {
  const r = E.checkAddition(STARTER, build(MB), CPU, { multi: 0 });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

test('checkAddition does not blame a new part for a pre-existing block', () => {
  // Build already violates the memory rule; adding a valid PSU must stay allowed.
  const broken = build(CPU, MB, RAM5);
  const r = E.checkAddition(STARTER, broken, PSU550, { multi: 0 });
  assert.equal(r.allowed, true);
});

test('checkAddition replaces the current pick in single-select categories', () => {
  const r = E.checkAddition(STARTER, build(CPU_AM4, MB), CPU, { multi: 0 });
  assert.equal(r.allowed, true, 'the incompatible CPU is swapped out, not kept');
});

test('malformed attrs JSON degrades to an empty attribute bag', () => {
  const junk = { id: 'x', category_id: 'cpu', name: 'x', attrs: '{not json' };
  const r = E.evaluateRule(STARTER[0], build(junk, MB));
  assert.equal(r.applied, false);
});
