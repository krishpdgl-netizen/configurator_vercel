'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { admin } = require('../lib/auth');
const { q } = require('../db/pool');
const pipeline = require('../tender/pipeline');
const { exportQuotationXlsx } = require('../lib/excel');

const router = express.Router();

// DiskIntake vs BlobIntake chosen by UPLOAD_MODE env var.
// On Vercel, use blob — its 4.5 MB request body cap is infrastructure and
// real GeM tenders routinely exceed it. On Render, disk is fine.
const UPLOAD_MODE = process.env.UPLOAD_MODE || 'disk';

const diskUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB on disk mode
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.docx', '.doc'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only PDF and DOCX files are accepted'), ok);
  },
});

router.use('/api/tender', admin);

/**
 * POST /api/tender/upload
 * DiskIntake: multipart file upload.
 * BlobIntake: JSON body { url, filename }.
 */
router.post('/api/tender/upload', async (req, res, next) => {
  if (UPLOAD_MODE === 'blob') {
    return blobUpload(req, res, next);
  }
  diskUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file (field name: file)' });
    await createAndQueue(res, next, req.file.buffer, req.file.originalname);
  });
});

async function blobUpload(req, res, next) {
  try {
    const { url, filename } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Body must include: { url, filename }' });
    const buf = await fetchUrl(url);
    await createAndQueue(res, next, buf, filename || path.basename(new URL(url).pathname));
  } catch (err) { next(err); }
}

async function fetchUrl(url) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function createAndQueue(res, next, buffer, filename) {
  try {
    const ref = 'TDR-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' +
      Math.random().toString(36).slice(2, 6).toUpperCase();
    // Store the raw bytes as base64 so the pipeline can fetch them later.
    // In production, store to object storage and save the URL instead.
    const { rows } = await q.run(
      `INSERT INTO tenders (ref, filename, status, raw_text, created_at)
       VALUES (?, ?, 'queued', ?, to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
       RETURNING id`,
      [ref, filename, buffer.toString('base64')]
    );
    const id = rows[0].id;

    // Run pipeline asynchronously — don't await.
    pipeline.run(id).catch((err) => console.error('[tender async]', err));

    res.json({ ok: true, id, ref, status: 'queued' });
  } catch (err) { next(err); }
}

/** GET /api/tender/:id — poll for status */
router.get('/api/tender/:id', async (req, res, next) => {
  try {
    const row = await q.get(
      `SELECT id, ref, filename, pages, chars, status, error, meta_json, items_json, match_json, created_at
       FROM tenders WHERE id = ?`,
      [Number(req.params.id)]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    // parse JSON columns
    for (const col of ['meta_json', 'items_json', 'match_json']) {
      if (row[col]) { try { row[col] = JSON.parse(row[col]); } catch { /* leave as string */ } }
    }
    res.json(row);
  } catch (err) { next(err); }
});

/** POST /api/tender/:id/override — bid desk manually selects a part */
router.post('/api/tender/:id/override', async (req, res, next) => {
  try {
    const row = await q.get(`SELECT match_json FROM tenders WHERE id=?`, [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const data = JSON.parse(row.match_json || '{}');
    const { item_index, option_id } = req.body || {};
    if (item_index == null || !option_id) return res.status(400).json({ error: 'item_index and option_id are required' });

    const opt = await require('../db/catalog').option(option_id);
    if (!opt) return res.status(400).json({ error: `Unknown option: ${option_id}` });

    if (data.items && data.items[item_index]) {
      data.items[item_index]._override = { option_id, name: opt.name, manual: true };
    }
    await q.run(`UPDATE tenders SET match_json=? WHERE id=?`, [JSON.stringify(data), Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** GET /api/tender/:id/export.xlsx */
router.get('/api/tender/:id/export.xlsx', async (req, res, next) => {
  try {
    const row = await q.get(`SELECT * FROM tenders WHERE id=?`, [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const buf = await exportQuotationXlsx(row);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="quotation-${row.ref}.xlsx"`);
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = { router };
