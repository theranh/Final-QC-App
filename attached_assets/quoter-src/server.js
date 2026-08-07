// PAINT & BODY QUOTER — static server + AI classify endpoint
// Serves index.html, /assets/*, manifest.json, and POST /api/classify
// (proxies damage-photo classification to Anthropic via Replit AI Integrations).

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;
if (pool) pool.on('error', (e) => console.error('pg pool error:', e.message));

const PORT = process.env.PORT || 5000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

// Allow the Claude Design mirror preview to read the live API cross-origin.
// Writes are still token-gated here and blocked client-side in the mirror.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-shop-token',
  'Access-Control-Max-Age': '86400',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers || {}, CORS));
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (process.env.NODE_ENV !== 'production') {
      // Never cache in development so edits show up immediately on refresh.
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    } else if (ext === '.html' || ext === '.json' || ext === '.webmanifest') {
      // Always revalidate the app shell/manifest so new releases show up on refresh.
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else {
      // Static assets (fonts, scripts, images) can be cached for a day.
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const INDEX = path.join(ROOT, 'index.html');
const ASSETS = path.join(ROOT, 'assets');

const JSON_HDR = { 'Content-Type': 'application/json' };
const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5'];
const MAX_BODY = 12 * 1024 * 1024;

// Simple per-IP rate limit: 30 classify calls per minute.
const rlBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; rlBuckets.set(ip, b); }
  if (rlBuckets.size > 1000) {
    for (const [k, v] of rlBuckets) { if (now - v.start > 60000) rlBuckets.delete(k); }
  }
  b.count++;
  return b.count > 30;
}

function handleClassify(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) return send(res, 429, JSON.stringify({ error: 'Too many requests — slow down' }), JSON_HDR);
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    if (tooBig) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      tooBig = true;
      chunks.length = 0;
      send(res, 413, JSON.stringify({ error: 'Photo too large' }), { ...JSON_HDR, Connection: 'close' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {});
  req.on('end', async () => {
    if (tooBig) return;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: 'Invalid JSON body' }), JSON_HDR);
    }
    const { image, system, prompt, model, max_tokens } = parsed;
    if (!image || typeof image !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(image.slice(0, 100))) {
      return send(res, 400, JSON.stringify({ error: 'Missing or invalid image' }), JSON_HDR);
    }
    try {
      const anthropic = new Anthropic({
        apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
      });
      const msg = await anthropic.messages.create({
        model: ALLOWED_MODELS.includes(model) ? model : 'claude-haiku-4-5',
        max_tokens: Math.min(Number(max_tokens) || 2048, 8192),
        system: String(system || '').slice(0, 8000),
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: String(prompt || 'Classify the damage in this photo. JSON only.').slice(0, 2000) },
        ] }],
      });
      const text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      send(res, 200, JSON.stringify({ text }), JSON_HDR);
    } catch (e) {
      console.error('classify error:', e && e.message ? e.message : e);
      const status = e && e.status === 429 ? 429 : 502;
      send(res, status, JSON.stringify({ error: 'AI request failed' }), JSON_HDR);
    }
  });
}

// ---------- shared database API ----------
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('too_big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad_json')); }
    });
  });
}

let DEVICE_TOKEN = null;
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS corrections (id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, diffs JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, slot TEXT, mime TEXT NOT NULL, data BYTEA NOT NULL, ts BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS photos_quote_idx ON photos (quote_id);
    CREATE TABLE IF NOT EXISTS intakes (
      id           TEXT PRIMARY KEY,
      vin          TEXT NOT NULL,
      stock        TEXT NOT NULL DEFAULT '',
      vehicle      TEXT NOT NULL DEFAULT '',
      miles        TEXT NOT NULL DEFAULT '',
      estimator    TEXT NOT NULL DEFAULT '',
      quote_id     TEXT,
      data         JSONB NOT NULL,
      completed_at TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS intakes_vin_idx ON intakes (vin);
  `);
  // Persistent random secret -> stable device token that survives restarts.
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', ['_secret']);
  let secret = r.rows.length ? r.rows[0].value : null;
  if (!secret || typeof secret !== 'string') {
    secret = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      ['_secret', JSON.stringify(secret)]
    );
  }
  DEVICE_TOKEN = crypto.createHmac('sha256', secret).update('pdq-device-v1').digest('hex');
  await importBundledData();
}

// One-time data import: if import-data.json.gz sits next to server.js, insert
// any quotes/photos the database doesn't already have (never overwrites).
async function importBundledData() {
  const file = path.join(ROOT, 'import-data.json.gz');
  if (!fs.existsSync(file)) return;
  try {
    const done = await pool.query('SELECT 1 FROM settings WHERE key = $1', ['_import_v1']);
    if (done.rows.length) return;
    const zlib = require('zlib');
    const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    let nq = 0, np = 0;
    for (const q of bundle.quotes || []) {
      if (!q || !q.id || !q.data) continue;
      const r = await pool.query(
        'INSERT INTO quotes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [String(q.id), JSON.stringify(q.data)]
      );
      nq += r.rowCount;
    }
    for (const p of bundle.photos || []) {
      if (!p || !p.id || !p.quoteId || !p.b64) continue;
      const r = await pool.query(
        'INSERT INTO photos (id, quote_id, slot, mime, data, ts) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
        [String(p.id), String(p.quoteId), String(p.slot || ''), String(p.mime || 'image/jpeg'), Buffer.from(p.b64, 'base64'), Number(p.ts) || Date.now()]
      );
      np += r.rowCount;
    }
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      ['_import_v1', JSON.stringify({ ts: Date.now(), quotes: nq, photos: np })]
    );
    console.log('bundled import: added', nq, 'quotes,', np, 'photos');
  } catch (e) {
    console.error('bundled import failed:', e.message);
  }
}
const schemaReady = pool ? ensureSchema().catch((e) => console.error('schema error:', e.message)) : Promise.resolve();

function tokenOk(req) {
  // <img> tags can't send headers, so /api/photo (only) also accepts ?t=<token>.
  let t = String(req.headers['x-shop-token'] || '');
  if (!t && String(req.url || '').split('?')[0] === '/api/photo') {
    try { t = String(new URL(req.url, 'http://x').searchParams.get('t') || ''); } catch (e) {}
  }
  if (!DEVICE_TOKEN || t.length !== DEVICE_TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(DEVICE_TOKEN)); } catch (e) { return false; }
}

// Stricter limiter for PIN attempts: 10 per minute per IP.
const authBuckets = new Map();
function authLimited(ip) {
  const now = Date.now();
  let b = authBuckets.get(ip);
  if (!b || now - b.start > 60000) { b = { start: now, count: 0 }; authBuckets.set(ip, b); }
  if (authBuckets.size > 1000) {
    for (const [k, v] of authBuckets) { if (now - v.start > 60000) authBuckets.delete(k); }
  }
  b.count++;
  return b.count > 10;
}

// Estimator list is stored as [{ name, pin }] (pin: 4-digit string or null).
// Older deployments stored plain name strings — normalize on read.
function normalizeEstNames(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const e of value) {
    const name = String((e && typeof e === 'object' ? e.name : e) || '').trim().slice(0, 40);
    if (!name || out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const pin = e && typeof e === 'object' && /^\d{4}$/.test(String(e.pin || '')) ? String(e.pin) : null;
    out.push({ name, pin });
    if (out.length >= 30) break;
  }
  return out;
}

async function handleDb(req, res, route) {
  if (!pool) return send(res, 503, JSON.stringify({ error: 'No database configured' }), JSON_HDR);
  await schemaReady;
  const m = req.method;
  try {
    if (m === 'POST' && route === '/api/auth') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (authLimited(ip)) return send(res, 429, JSON.stringify({ error: 'Too many attempts — wait a minute' }), JSON_HDR);
      const body = await readBody(req, 4 * 1024);
      const r = await pool.query('SELECT value FROM settings WHERE key = $1', ['pin']);
      const want = String(r.rows.length ? r.rows[0].value : '5701');
      const got = String(body.pin || '');
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
        return send(res, 401, JSON.stringify({ error: 'Wrong PIN' }), JSON_HDR);
      }
      return send(res, 200, JSON.stringify({ token: DEVICE_TOKEN }), JSON_HDR);
    }
    if (!tokenOk(req)) return send(res, 401, JSON.stringify({ error: 'Not authorized' }), JSON_HDR);
    if (m === 'GET' && route === '/api/sync') {
      const [st, qs, cs] = await Promise.all([
        pool.query('SELECT key, value FROM settings'),
        pool.query('SELECT data FROM quotes ORDER BY updated_at DESC LIMIT 300'),
        pool.query('SELECT ts, diffs FROM corrections ORDER BY id DESC LIMIT 200'),
      ]);
      const settings = {};
      for (const r of st.rows) settings[r.key] = r.value;
      return send(res, 200, JSON.stringify({
        rates: settings.rates || null,
        estNames: settings.estNames ? normalizeEstNames(settings.estNames).map((e) => ({ name: e.name, hasPin: !!e.pin })) : null,
        quotes: qs.rows.map((r) => r.data),
        corrections: cs.rows,
      }), { ...JSON_HDR, 'Cache-Control': 'no-store' });
    }
    if (m === 'PUT' && (route === '/api/rates' || route === '/api/pin')) {
      const body = await readBody(req, 256 * 1024);
      const key = route === '/api/rates' ? 'rates' : 'pin';
      const value = body[key];
      if (value == null) return send(res, 400, JSON.stringify({ error: 'Missing ' + key }), JSON_HDR);
      if (key === 'pin' && !/^\d{4,8}$/.test(String(value))) return send(res, 400, JSON.stringify({ error: 'PIN must be 4-8 digits' }), JSON_HDR);
      await pool.query(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
        [key, JSON.stringify(value)]
      );
      return send(res, 200, JSON.stringify({ ok: true }), JSON_HDR);
    }
    if (m === 'PUT' && route === '/api/estnames') {
      const body = await readBody(req, 16 * 1024);
      if (!Array.isArray(body.estNames)) return send(res, 400, JSON.stringify({ error: 'Missing estNames' }), JSON_HDR);
      const r = await pool.query('SELECT value FROM settings WHERE key = $1', ['estNames']);
      const existing = normalizeEstNames(r.rows.length ? r.rows[0].value : []);
      const names = [];
      for (const e of body.estNames) {
        const name = String((e && typeof e === 'object' ? e.name : e) || '').trim().slice(0, 40);
        if (!name || names.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
        const sent = e && typeof e === 'object' ? e.pin : undefined;
        let pin;
        if (sent === undefined) {
          // No pin field sent — keep whatever the server already has for this name.
          const old = existing.find((x) => x.name.toLowerCase() === name.toLowerCase());
          pin = old ? old.pin : null;
        } else {
          if (sent !== null && !/^\d{4}$/.test(String(sent))) return send(res, 400, JSON.stringify({ error: 'PIN must be 4 digits' }), JSON_HDR);
          pin = sent === null ? null : String(sent);
        }
        names.push({ name, pin });
        if (names.length >= 30) break;
      }
      await pool.query(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
        ['estNames', JSON.stringify(names)]
      );
      return send(res, 200, JSON.stringify({ ok: true, estNames: names.map((e) => ({ name: e.name, hasPin: !!e.pin })) }), JSON_HDR);
    }
    if (m === 'POST' && route === '/api/estauth') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (authLimited(ip)) return send(res, 429, JSON.stringify({ error: 'Too many attempts — wait a minute' }), JSON_HDR);
      const body = await readBody(req, 4 * 1024);
      const name = String(body.name || '').trim();
      const got = String(body.pin || '');
      const r = await pool.query('SELECT value FROM settings WHERE key = $1', ['estNames']);
      const list = normalizeEstNames(r.rows.length ? r.rows[0].value : []);
      const rec = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!rec) return send(res, 404, JSON.stringify({ error: 'Unknown estimator' }), JSON_HDR);
      if (!rec.pin) return send(res, 409, JSON.stringify({ error: 'No PIN set for this estimator' }), JSON_HDR);
      if (got.length !== rec.pin.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(rec.pin))) {
        return send(res, 401, JSON.stringify({ error: 'Wrong PIN' }), JSON_HDR);
      }
      return send(res, 200, JSON.stringify({ ok: true, name: rec.name }), JSON_HDR);
    }
    if (route === '/api/photos') {
      if (m === 'POST') {
        // Walk-around photo upload: { id, quoteId, slot, dataUrl }.
        const body = await readBody(req, 6 * 1024 * 1024);
        const id = String(body.id || '').slice(0, 60);
        const quoteId = String(body.quoteId || '').slice(0, 60);
        const slot = String(body.slot || '').slice(0, 40);
        const mDU = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
        if (!id || !quoteId || !mDU) return send(res, 400, JSON.stringify({ error: 'Missing id, quoteId, or image' }), JSON_HDR);
        const buf = Buffer.from(mDU[2], 'base64');
        if (!buf.length || buf.length > 4 * 1024 * 1024) return send(res, 413, JSON.stringify({ error: 'Photo too large' }), JSON_HDR);
        const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM photos WHERE quote_id = $1 AND id <> $2', [quoteId, id]);
        if (cnt.rows[0].n >= 80) return send(res, 409, JSON.stringify({ error: 'Photo limit reached for this truck' }), JSON_HDR);
        await pool.query(
          'INSERT INTO photos (id, quote_id, slot, mime, data, ts) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO UPDATE SET slot = $3, mime = $4, data = $5, ts = $6',
          [id, quoteId, slot, mDU[1], buf, Date.now()]
        );
        return send(res, 200, JSON.stringify({ ok: true, id }), JSON_HDR);
      }
      if (m === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const quoteId = String(q.get('quote') || '');
        if (!quoteId) return send(res, 400, JSON.stringify({ error: 'Missing quote' }), JSON_HDR);
        const r = await pool.query('SELECT id, slot, ts, LENGTH(data) AS bytes FROM photos WHERE quote_id = $1 ORDER BY ts', [quoteId]);
        return send(res, 200, JSON.stringify({ photos: r.rows }), { ...JSON_HDR, 'Cache-Control': 'no-store' });
      }
      if (m === 'DELETE') {
        const body = await readBody(req, 4 * 1024);
        if (body.id) { await pool.query('DELETE FROM photos WHERE id = $1', [String(body.id)]); return send(res, 200, JSON.stringify({ ok: true }), JSON_HDR); }
        if (body.quoteId) { await pool.query('DELETE FROM photos WHERE quote_id = $1', [String(body.quoteId)]); return send(res, 200, JSON.stringify({ ok: true }), JSON_HDR); }
        return send(res, 400, JSON.stringify({ error: 'Missing id or quoteId' }), JSON_HDR);
      }
    }
    if (m === 'GET' && route === '/api/photo') {
      const q = new URL(req.url, 'http://x').searchParams;
      const id = String(q.get('id') || '');
      if (!id) return send(res, 400, JSON.stringify({ error: 'Missing id' }), JSON_HDR);
      const r = await pool.query('SELECT mime, data FROM photos WHERE id = $1', [id]);
      if (!r.rows.length) return send(res, 404, JSON.stringify({ error: 'Not found' }), JSON_HDR);
      return send(res, 200, r.rows[0].data, { 'Content-Type': r.rows[0].mime, 'Cache-Control': 'private, max-age=86400' });
    }
    if (route === '/api/intakes') {
      if (m === 'PUT') {
        const body = await readBody(req, 64 * 1024);
        const id = String(body.id || '').slice(0, 60);
        const vin = String(body.vin || '').trim().toUpperCase().slice(0, 20);
        if (!id || vin.length < 6) return send(res, 400, JSON.stringify({ error: 'Missing id or vin' }), JSON_HDR);
        const data = sanitizeIntakeData(body.data);
        const complete = data.roReady.length === 9 && data.roReady.every(Boolean);
        // Client edit timestamp (ms). Stale offline-queue writes from another
        // phone must never clobber newer work already on the server.
        const ts = Math.min(Date.now() + 60000, Math.max(0, Number(body.ts) || Date.now()));
        await pool.query(
          `INSERT INTO intakes (id, vin, stock, vehicle, miles, estimator, quote_id, data, completed_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN NOW() ELSE NULL END, to_timestamp($10 / 1000.0))
           ON CONFLICT (id) DO UPDATE SET
             vin = $2, stock = $3, vehicle = $4, miles = $5, estimator = $6, quote_id = $7, data = $8,
             completed_at = CASE WHEN $9 THEN COALESCE(intakes.completed_at, NOW()) ELSE NULL END,
             updated_at = to_timestamp($10 / 1000.0)
           WHERE intakes.updated_at <= to_timestamp($10 / 1000.0)`,
          [id, vin, String(body.stock || '').slice(0, 40), String(body.vehicle || '').slice(0, 120),
           String(body.miles || '').slice(0, 20), String(body.estimator || '').slice(0, 40),
           body.quoteId ? String(body.quoteId).slice(0, 60) : null, JSON.stringify(data), complete, ts]
        );
        return send(res, 200, JSON.stringify({ ok: true, id }), JSON_HDR);
      }
      if (m === 'GET') {
        const vin = String(new URL(req.url, 'http://x').searchParams.get('vin') || '').trim().toUpperCase();
        if (vin.length < 6) return send(res, 400, JSON.stringify({ error: 'Missing or short vin' }), JSON_HDR);
        const r = await pool.query(
          'SELECT id, vin, stock, vehicle, miles, estimator, quote_id, data, EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_ms FROM intakes WHERE vin = $1 ORDER BY updated_at DESC LIMIT 1',
          [vin]
        );
        if (!r.rows.length) return send(res, 200, JSON.stringify({ found: false, vin }), { ...JSON_HDR, 'Cache-Control': 'no-store' });
        const row = r.rows[0];
        return send(res, 200, JSON.stringify({
          found: true, id: row.id, vin: row.vin, stock: row.stock, vehicle: row.vehicle, miles: row.miles,
          estimator: row.estimator, quoteId: row.quote_id || null, data: row.data,
          completedAt: row.completed_ms ? Math.round(Number(row.completed_ms)) : null,
          updatedAt: row.updated_ms ? Math.round(Number(row.updated_ms)) : 0,
        }), { ...JSON_HDR, 'Cache-Control': 'no-store' });
      }
    }
    if (m === 'PUT' && route === '/api/quotes') {
      const body = await readBody(req, 4 * 1024 * 1024);
      const id = String(body.id || '');
      if (!id || !body.data || typeof body.data !== 'object') return send(res, 400, JSON.stringify({ error: 'Missing id or data' }), JSON_HDR);
      await pool.query(
        'INSERT INTO quotes (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()',
        [id, JSON.stringify(body.data)]
      );
      return send(res, 200, JSON.stringify({ ok: true }), JSON_HDR);
    }
    if (m === 'DELETE' && route === '/api/quotes') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const id = q.get('id');
      if (!id) return send(res, 400, JSON.stringify({ error: 'Missing id' }), JSON_HDR);
      await pool.query('DELETE FROM quotes WHERE id = $1', [id]);
      await pool.query('DELETE FROM photos WHERE quote_id = $1', [id]);
      return send(res, 200, JSON.stringify({ ok: true }), JSON_HDR);
    }
    if (m === 'POST' && route === '/api/corrections') {
      const body = await readBody(req, 64 * 1024);
      const diffs = Array.isArray(body.diffs) ? body.diffs.map((d) => String(d).slice(0, 200)).slice(0, 10) : [];
      if (!diffs.length) return send(res, 400, JSON.stringify({ error: 'Missing diffs' }), JSON_HDR);
      const ts = Number(body.ts) || Date.now();
      await pool.query('INSERT INTO corrections (ts, diffs) VALUES ($1, $2)', [ts, JSON.stringify(diffs)]);
      await pool.query('DELETE FROM corrections WHERE id NOT IN (SELECT id FROM corrections ORDER BY id DESC LIMIT 500)');
      return send(res, 200, JSON.stringify({ ok: true }), JSON_HDR);
    }
    if (m === 'POST' && route === '/api/migrate') {
      const body = await readBody(req, MAX_BODY);
      const quotes = Array.isArray(body.quotes) ? body.quotes.slice(0, 300) : [];
      const corrections = Array.isArray(body.corrections) ? body.corrections.slice(0, 200) : [];
      let added = 0;
      for (const q of quotes) {
        if (!q || typeof q !== 'object' || !q.id) continue;
        const r = await pool.query(
          'INSERT INTO quotes (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [String(q.id), JSON.stringify(q)]
        );
        added += r.rowCount;
      }
      for (const c of corrections) {
        const diffs = c && Array.isArray(c.diffs) ? c.diffs.map((d) => String(d).slice(0, 200)).slice(0, 10) : [];
        if (!diffs.length) continue;
        await pool.query('INSERT INTO corrections (ts, diffs) VALUES ($1, $2)', [Number(c.ts) || Date.now(), JSON.stringify(diffs)]);
      }
      return send(res, 200, JSON.stringify({ ok: true, quotesAdded: added }), JSON_HDR);
    }
    return send(res, 404, JSON.stringify({ error: 'Not found' }), JSON_HDR);
  } catch (e) {
    if (e.message === 'bad_json') return send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), JSON_HDR);
    if (e.message === 'too_big') return send(res, 413, JSON.stringify({ error: 'Body too large' }), JSON_HDR);
    console.error('db api error:', e.message);
    return send(res, 500, JSON.stringify({ error: 'Database error' }), JSON_HDR);
  }
}

let APP_VERSION = '0';
try { APP_VERSION = String(Math.floor(fs.statSync(INDEX).mtimeMs)); } catch (e) {}

// TR-INTAKE-V2 payload: 4 steps (3/6/6/5 sub-steps), 9 RO-Ready items.
const INTAKE_STEP_SIZES = { 1: 3, 2: 6, 3: 6, 4: 5 };
function sanitizeIntakeData(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const steps = {};
  for (const k of ['1', '2', '3', '4']) {
    const arr = d.steps && Array.isArray(d.steps[k]) ? d.steps[k] : [];
    steps[k] = Array.from({ length: INTAKE_STEP_SIZES[k] }, (_, i) => !!arr[i]);
  }
  const ro = Array.isArray(d.roReady) ? d.roReady : [];
  return {
    steps,
    roReady: Array.from({ length: 9 }, (_, i) => !!ro[i]),
    photoCount: Math.max(0, Math.min(999, Number(d.photoCount) || 0)),
    notes: String(d.notes || '').slice(0, 2000),
  };
}

// Shared FLEET_KEY gate for the read-only fleet endpoints.
function fleetKeyOk(req, res) {
  const key = String(process.env.FLEET_KEY || '');
  if (!key) { send(res, 503, JSON.stringify({ error: 'FLEET_KEY not configured' }), JSON_HDR); return false; }
  const given = String(req.headers['x-fleet-key'] || '');
  if (given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized' }), JSON_HDR);
    return false;
  }
  return true;
}

// ---------- fleet: read-only intake checklist lookup by VIN ----------
async function handleFleetIntake(req, res) {
  if (!fleetKeyOk(req, res)) return;
  if (!pool) return send(res, 503, JSON.stringify({ error: 'No database configured' }), JSON_HDR);
  await schemaReady;
  const vin = String(new URL(req.url, 'http://x').searchParams.get('vin') || '').trim().toUpperCase();
  if (vin.length < 6) return send(res, 400, JSON.stringify({ error: 'Missing or short vin' }), JSON_HDR);
  try {
    const r = await pool.query(
      'SELECT vin, stock, vehicle, miles, estimator, quote_id, data, EXTRACT(EPOCH FROM completed_at) * 1000 AS completed_ms FROM intakes WHERE vin = $1 ORDER BY updated_at DESC LIMIT 1',
      [vin]
    );
    if (!r.rows.length) return send(res, 200, JSON.stringify({ found: false, vin }), JSON_HDR);
    const row = r.rows[0];
    const data = sanitizeIntakeData(row.data);
    let quote = null;
    if (row.quote_id) {
      const q = await pool.query('SELECT data FROM quotes WHERE id = $1', [row.quote_id]);
      if (q.rows.length) {
        const qd = q.rows[0].data || {};
        const lines = (qd.lines || []).filter((l) => l && l.cls);
        quote = {
          id: qd.id || row.quote_id,
          hrs: (qd.totals && qd.totals.hrs) || 0,
          usd: (qd.totals && qd.totals.usd) || 0,
          lineCount: lines.length,
        };
      }
    }
    return send(res, 200, JSON.stringify({
      found: true,
      vin: row.vin, stock: row.stock, vehicle: row.vehicle, miles: row.miles, estimator: row.estimator,
      completedAt: row.completed_ms ? Math.round(Number(row.completed_ms)) : null,
      roReadyCount: data.roReady.filter(Boolean).length,
      roReady: data.roReady,
      steps: data.steps,
      photoCount: data.photoCount,
      quote,
    }), JSON_HDR);
  } catch (e) {
    console.error('fleet intake lookup failed:', e.message);
    return send(res, 500, JSON.stringify({ error: 'Lookup failed' }), JSON_HDR);
  }
}

// ---------- fleet: list of RO-ready (completed) intakes ----------
async function handleFleetIntakesCompleted(req, res) {
  if (!fleetKeyOk(req, res)) return;
  if (!pool) return send(res, 503, JSON.stringify({ error: 'No database configured' }), JSON_HDR);
  await schemaReady;
  const q = new URL(req.url, 'http://x').searchParams;
  const sinceRaw = String(q.get('since') || '');
  let since = null;
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (isNaN(d.getTime())) return send(res, 400, JSON.stringify({ error: 'Invalid since (use ISO date/time)' }), JSON_HDR);
    since = d.toISOString();
  }
  const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 200));
  try {
    const r = await pool.query(
      `SELECT i.vin, i.stock, i.vehicle, i.estimator, i.data, EXTRACT(EPOCH FROM i.completed_at) * 1000 AS completed_ms, q.data AS quote_data
       FROM intakes i LEFT JOIN quotes q ON q.id = i.quote_id
       WHERE i.completed_at IS NOT NULL AND ($1::timestamptz IS NULL OR i.completed_at >= $1::timestamptz)
       ORDER BY i.completed_at DESC LIMIT $2`,
      [since, limit]
    );
    const intakes = r.rows.map((row) => {
      const data = sanitizeIntakeData(row.data);
      const qt = (row.quote_data && row.quote_data.totals) || {};
      return {
        vin: row.vin, stock: row.stock, vehicle: row.vehicle, estimator: row.estimator,
        completedAt: Math.round(Number(row.completed_ms)),
        photoCount: data.photoCount,
        quoteUsd: Number(qt.usd) || 0,
        quoteHrs: Number(qt.hrs) || 0,
      };
    });
    return send(res, 200, JSON.stringify({ intakes }), JSON_HDR);
  } catch (e) {
    console.error('fleet completed intakes failed:', e.message);
    return send(res, 500, JSON.stringify({ error: 'Lookup failed' }), JSON_HDR);
  }
}

// ---------- fleet: daily intake counts ----------
async function handleFleetIntakeStats(req, res) {
  if (!fleetKeyOk(req, res)) return;
  if (!pool) return send(res, 503, JSON.stringify({ error: 'No database configured' }), JSON_HDR);
  await schemaReady;
  const q = new URL(req.url, 'http://x').searchParams;
  const from = String(q.get('from') || '').slice(0, 10);
  const to = String(q.get('to') || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return send(res, 400, JSON.stringify({ error: 'Missing or invalid from/to (YYYY-MM-DD)' }), JSON_HDR);
  }
  try {
    const [byDay, open] = await Promise.all([
      pool.query(
        `SELECT d.day::date AS day, COUNT(i.id)::int AS intakes
         FROM generate_series($1::date, $2::date, '1 day') AS d(day)
         LEFT JOIN intakes i ON i.completed_at::date = d.day::date
         GROUP BY d.day ORDER BY d.day`,
        [from, to]
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM intakes WHERE completed_at IS NULL'),
    ]);
    const days = byDay.rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), intakes: r.intakes }));
    return send(res, 200, JSON.stringify({
      days,
      total: days.reduce((a, d) => a + d.intakes, 0),
      openIntakes: open.rows[0].n,
    }), JSON_HDR);
  } catch (e) {
    console.error('fleet intake stats failed:', e.message);
    return send(res, 500, JSON.stringify({ error: 'Lookup failed' }), JSON_HDR);
  }
}

// ---------- fleet: read-only intake quote lookup by VIN ----------
// Consumed server-to-server by the Final QC app so an inspector can see what
// damage was written up at intake. Gated by the FLEET_KEY secret, never a
// session; GET only; no photos, notes or PII in the payload.
async function handleFleetQuote(req, res) {
  const key = String(process.env.FLEET_KEY || '');
  if (!key) return send(res, 503, JSON.stringify({ error: 'FLEET_KEY not configured' }), JSON_HDR);
  const given = String(req.headers['x-fleet-key'] || '');
  if (given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), JSON_HDR);
  }
  if (!pool) return send(res, 503, JSON.stringify({ error: 'No database configured' }), JSON_HDR);
  await schemaReady;
  const vin = String(new URL(req.url, 'http://x').searchParams.get('vin') || '').trim().toUpperCase();
  if (vin.length < 6) return send(res, 400, JSON.stringify({ error: 'Missing or short vin' }), JSON_HDR);
  try {
    const r = await pool.query(
      "SELECT data FROM quotes WHERE UPPER(data->>'vin') = $1 ORDER BY (data->>'ts')::bigint DESC LIMIT 1",
      [vin]
    );
    if (!r.rows.length) return send(res, 200, JSON.stringify({ found: false, vin }), JSON_HDR);
    const q = r.rows[0].data || {};
    const veh = q.veh || {};
    const lines = (q.lines || [])
      .filter((l) => l && l.cls)
      .map((l) => ({
        panel: l.cls.panel || '',
        damage: String(l.cls.damage_type || '').replace(/_/g, ' '),
        severity: l.cls.severity || '',
        paint: !!l.cls.paint_damaged,
        parts: l.cls.ri_parts_needed || [],
        needsReview: !!l.review,
        setByEstimator: !!l.manual,
      }));
    return send(res, 200, JSON.stringify({
      found: true,
      id: q.id || '',
      vin: q.vin || vin,
      stock: q.stock || '',
      miles: q.miles || '',
      vehicle: [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(' '),
      estimator: q.estimator || '',
      quotedAt: q.ts || 0,
      totals: q.totals || { hrs: 0, usd: 0 },
      lineCount: lines.length,
      lines,
    }), JSON_HDR);
  } catch (e) {
    console.error('fleet quote lookup failed:', e.message);
    return send(res, 500, JSON.stringify({ error: 'Lookup failed' }), JSON_HDR);
  }
}

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (route === '/api/quote-by-vin') {
    if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'GET only' }), JSON_HDR);
    return handleFleetQuote(req, res);
  }
  if (route === '/api/intake-by-vin') {
    if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'GET only' }), JSON_HDR);
    return handleFleetIntake(req, res);
  }
  if (route === '/api/intakes-completed') {
    if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'GET only' }), JSON_HDR);
    return handleFleetIntakesCompleted(req, res);
  }
  if (route === '/api/intake-stats') {
    if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'GET only' }), JSON_HDR);
    return handleFleetIntakeStats(req, res);
  }
  if (req.method === 'GET' && route === '/api/version') {
    return send(res, 200, JSON.stringify({ v: APP_VERSION }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  }
  if (req.method === 'POST' && route === '/api/classify') return handleClassify(req, res);
  if (route === '/api/auth' || route === '/api/sync' || route === '/api/rates' || route === '/api/pin' || route === '/api/estnames' || route === '/api/estauth' || route === '/api/photos' || route === '/api/photo' || route === '/api/quotes' || route === '/api/corrections' || route === '/api/migrate' || route === '/api/intakes') {
    return handleDb(req, res, route);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  // Strip query string and decode; reject malformed percent-encoding.
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    return send(res, 400, 'Bad request');
  }

  if (urlPath === '/' || urlPath === '/index.html') return serveFile(res, INDEX);
  if (urlPath === '/manifest.json') return serveFile(res, path.join(ROOT, 'manifest.json'));

  // Only files under /assets/* are otherwise servable.
  if (urlPath.startsWith('/assets/')) {
    const filePath = path.normalize(path.join(ROOT, urlPath));
    const rel = path.relative(ASSETS, filePath);
    // Reject anything that escapes the assets directory (path traversal).
    if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 403, 'Forbidden');
    return fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found');
      serveFile(res, filePath);
    });
  }

  // Unknown routes fall back to the app shell (state-based navigation).
  serveFile(res, INDEX);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('PAINT & BODY QUOTER running on port ' + PORT);
});
