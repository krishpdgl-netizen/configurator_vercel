'use strict';
/**
 * A starter set of server/workstation compatibility rules.
 *
 * This is NOT seeded on boot — the app ships with no catalog, and rules that
 * reference categories you have not created would only produce noise. Load it
 * deliberately from Admin → Rules → "Load starter pack" once your category
 * ids exist, then edit the rows. They are ordinary data from that point on.
 *
 * Category ids assumed: cpu, mb, ram, ssd, hdd, gpu, nic, psu, chassis.
 * Attribute keys assumed: socket, mem_type, dimm_slots, m2_slots, pcie_slots,
 * slots, tdp, watts, max_mem_gb, size_gb, form, bay, redundant, form_factor.
 */

module.exports = [
  {
    name: 'cpu_socket_matches_board',
    severity: 'block',
    message: 'This CPU does not fit the selected motherboard socket.',
    sort: 10,
    left_kind: 'value', left_cats: 'cpu', left_attr: 'socket',
    op: 'eq',
    right_kind: 'value', right_cats: 'mb', right_attr: 'socket',
  },
  {
    name: 'memory_type_matches_board',
    severity: 'block',
    message: 'This memory type is not supported by the selected motherboard.',
    sort: 20,
    left_kind: 'value', left_cats: 'ram', left_attr: 'mem_type',
    op: 'eq',
    right_kind: 'value', right_cats: 'mb', right_attr: 'mem_type',
  },
  {
    name: 'dimm_slots_not_exceeded',
    severity: 'block',
    message: 'More memory modules than the motherboard has DIMM slots.',
    sort: 30,
    left_kind: 'count', left_cats: 'ram',
    op: 'lte',
    right_kind: 'max', right_cats: 'mb', right_attr: 'dimm_slots',
  },
  {
    name: 'm2_slots_not_exceeded',
    severity: 'block',
    message: 'More M.2 drives than the motherboard has M.2 slots.',
    sort: 40,
    left_kind: 'count', left_cats: 'ssd_m2',
    op: 'lte',
    right_kind: 'max', right_cats: 'mb', right_attr: 'm2_slots',
  },
  {
    name: 'pcie_slots_not_exceeded',
    severity: 'block',
    message: 'The selected cards need more PCIe slots than the motherboard has.',
    sort: 50,
    left_kind: 'sum', left_cats: 'gpu,nic', left_attr: 'slots',
    op: 'lte',
    right_kind: 'max', right_cats: 'mb', right_attr: 'pcie_slots',
  },
  {
    name: 'psu_headroom',
    severity: 'block',
    message: 'The power supply is undersized for this configuration (needs 25% headroom plus 110 W).',
    sort: 60,
    // (total draw × 1.25) + 110 ≤ PSU watts, expressed as PSU-side ≥ demand.
    left_kind: 'sum', left_cats: 'cpu,gpu,nic,ssd,ssd_m2,hdd', left_attr: 'tdp',
    left_scale: 1.25, left_offset: 110,
    op: 'lte',
    right_kind: 'max', right_cats: 'psu', right_attr: 'watts',
  },
  {
    name: 'drive_form_matches_chassis_bay',
    severity: 'block',
    message: 'This drive form factor does not fit the selected chassis bays.',
    sort: 70,
    left_kind: 'value', left_cats: 'hdd,ssd', left_attr: 'form',
    op: 'in',
    right_kind: 'value', right_cats: 'chassis', right_attr: 'bay',
  },
  {
    name: 'rack_single_psu',
    severity: 'warn',
    message: 'Rack chassis with a single, non-redundant power supply — most sites expect redundant PSUs.',
    sort: 80,
    left_kind: 'count', left_cats: 'psu',
    op: 'gte',
    right_kind: 'const', right_const: '2',
  },
  {
    name: 'memory_exceeds_board_maximum',
    severity: 'warn',
    message: 'Total memory exceeds the motherboard maximum — check the board datasheet before quoting.',
    sort: 90,
    left_kind: 'sum', left_cats: 'ram', left_attr: 'size_gb',
    op: 'lte',
    right_kind: 'max', right_cats: 'mb', right_attr: 'max_mem_gb',
  },
  {
    name: 'board_fits_chassis',
    severity: 'block',
    message: 'This motherboard form factor does not fit the selected chassis.',
    sort: 100,
    left_kind: 'value', left_cats: 'mb', left_attr: 'form',
    op: 'in',
    right_kind: 'value', right_cats: 'chassis', right_attr: 'form_factor',
  },
];
