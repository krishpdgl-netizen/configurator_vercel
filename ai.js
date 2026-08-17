'use strict';
/**
 * Thin AI wrapper. The model's only job is reading tender prose into
 * structured JSON — it never sees a cost, a margin, or a part id.
 *
 * Two providers: Gemini (primary) and Anthropic (fallback).
 * Provider is chosen by AI_PROVIDER env; model name is stored in the
 * settings table so it can change without a deploy.
 */

const https = require('https');
const settings = require('../db/settings');

async function complete({ systemPrompt, userPrompt, json = true, retryOnBadJson = true }) {
  const provider = process.env.AI_PROVIDER || 'gemini';
  const model = await settings.get('gemini_model', 'gemini-3.1-flash-lite');
  let text;
  try {
    text = provider === 'anthropic'
      ? await anthropic(systemPrompt, userPrompt)
      : await gemini(model, systemPrompt, userPrompt, json);
  } catch (err) {
    if (provider !== 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      console.warn('[ai] Gemini failed, falling back to Anthropic:', err.message);
      text = await anthropic(systemPrompt, userPrompt);
    } else throw err;
  }

  if (!json) return { text };

  let parsed = tryParseJson(text);
  if (!parsed && retryOnBadJson) {
    const retry = provider === 'anthropic'
      ? await anthropic(systemPrompt, userPrompt + '\n\nReturn JSON only. No markdown, no explanation.')
      : await gemini(model, systemPrompt, userPrompt + '\n\nReturn JSON only. No markdown fences.', true);
    parsed = tryParseJson(retry);
    if (!parsed) throw new Error('Model returned non-JSON even after retry:\n' + retry.slice(0, 400));
  } else if (!parsed) {
    throw new Error('Model returned non-JSON:\n' + text.slice(0, 400));
  }
  return { text, parsed };
}

function tryParseJson(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // Strip optional ```json ... ``` fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { return null; }
}

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
        resolve(raw);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function gemini(model, system, user, json) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const path = `/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: `${system}\n\n---\n\n${user}` }] }],
    generationConfig: {
      temperature: 0.1,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const raw = await post('generativelanguage.googleapis.com', path, {}, body);
  const resp = JSON.parse(raw);
  if (resp.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini hit MAX_TOKENS — the context is too large or the response too long. Reduce input or split into smaller calls.');
  }
  return resp.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function anthropic(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, system, messages: [{ role: 'user', content: user }] };
  const raw = await post('api.anthropic.com', '/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body);
  return JSON.parse(raw).content?.[0]?.text || '';
}

module.exports = { complete };
