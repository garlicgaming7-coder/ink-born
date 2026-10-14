// Inkborn Arena server: serves the game and runs the online arena.
// No dependencies. Needs Node.js 18 or newer. Start it with:  node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'arena.json');
const PAGE = path.join(__dirname, 'public', 'index.html');
const MAX_BODY = 300 * 1024;
const MAX_RESULTS = 3000;

/* ---------- storage: one JSON file, written atomically ---------- */
let db = { players: {}, fighters: {}, results: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); console.log(`Loaded ${Object.keys(db.fighters).length} fighters from ${DATA_FILE}`); }
catch (e) { if (e.code !== 'ENOENT') console.error('Could not read data file, starting empty:', e.message); }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('Could not save data:', e.message); }
  }, 400);
}

/* ---------- live updates (Server-Sent Events) ---------- */
let version = 0, stateCache = null;
const listeners = new Set();
function changed() {
  version++; stateCache = null; persist();
  for (const res of listeners) res.write(`data: ${version}\n\n`);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000);

/* ---------- battle math (keep in sync with the game page) ---------- */
const INKS = ['ink', 'ember', 'tide', 'moss', 'spark', 'hex'];
const STATS = ['hp', 'atk', 'def', 'spd', 'luk'];
const BEATS = { ember: 'moss', moss: 'tide', tide: 'ember' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const power = s => s.hp / 5 + s.atk + s.def + s.spd + s.luk * 0.8;
function fighter(src) { const s = src.stats; return { el: src.el, max: s.hp, hp: s.hp, atk: s.atk, def: s.def, spd: s.spd, luk: s.luk, burn: 0, burnDmg: 0, g: 0 }; }
const hitChance = (a, d) => clamp(0.88 + (a.spd - d.spd) * 0.008 - d.luk * 0.01 - (d.el === 'hex' ? 0.08 : 0), 0.45, 0.97);
const critChance = a => clamp(0.04 + a.luk * 0.012, 0, 0.5);
const elMult = (a, d) => (BEATS[a.el] === d.el ? 1.25 : BEATS[d.el] === a.el ? 0.8 : 1) * (a.el === 'ink' ? 1.1 : 1);
const baseDmg = (a, d) => a.atk * (40 / (40 + d.def * 2.2)) * elMult(a, d);
function simulate(A, B, rnd) {
  const f = [fighter(A), fighter(B)]; f[0].g = rnd() * 30; f[1].g = rnd() * 30;
  const ev = []; let turns = 0;
  const push = e => { e.hp = [Math.max(0, f[0].hp), Math.max(0, f[1].hp)]; ev.push(e); };
  while (f[0].hp > 0 && f[1].hp > 0 && turns < 90) {
    let i = -1;
    while (i < 0) { for (const x of f) x.g += x.spd * (0.9 + rnd() * 0.2) + 3; if (f[0].g >= 100 || f[1].g >= 100) i = f[0].g >= f[1].g ? 0 : 1; }
    const a = f[i], d = f[1 - i]; a.g -= 100; turns++;
    if (a.burn > 0) { a.burn--; a.hp -= a.burnDmg; push({ t: 'burn', who: i, dmg: a.burnDmg }); if (a.hp <= 0) break; }
    if (a.el === 'moss' && a.hp < a.max) { const amt = Math.min(a.max - a.hp, Math.max(1, Math.round(a.max * 0.03))); a.hp += amt; push({ t: 'heal', who: i, amt, kind: 'moss' }); }
    if (a.el === 'tide' && a.hp < a.max && rnd() < 0.15) { const amt = Math.min(a.max - a.hp, Math.round(a.max * 0.12)); a.hp += amt; push({ t: 'heal', who: i, amt, kind: 'tide' }); }
    const strikes = (a.el === 'spark' && rnd() < 0.15) ? 2 : 1;
    for (let k = 0; k < strikes && d.hp > 0; k++) {
      if (k === 1) push({ t: 'double', who: i });
      if (rnd() >= hitChance(a, d)) { push({ t: 'miss', who: i }); continue; }
      const crit = rnd() < critChance(a);
      const dmg = Math.max(1, Math.round(baseDmg(a, d) * (0.85 + rnd() * 0.3) * (crit ? 1.7 : 1)));
      d.hp -= dmg; let burned = false;
      if (a.el === 'ember' && d.hp > 0 && rnd() < 0.2) { d.burn = 3; d.burnDmg = Math.max(1, Math.round(a.atk * 0.25)); burned = true; }
      push({ t: 'hit', who: i, dmg, crit, burned });
    }
  }
  const timeout = f[0].hp > 0 && f[1].hp > 0;
  const winner = f[0].hp <= 0 ? 1 : f[1].hp <= 0 ? 0 : (f[0].hp / f[0].max >= f[1].hp / f[1].max ? 0 : 1);
  ev.push({ t: 'end', winner, timeout, hp: [Math.max(0, f[0].hp), Math.max(0, f[1].hp)] });
  return { winner, ev };
}
const rand = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

/* ---------- validation ---------- */
const cleanText = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
function cleanFighter(f) {
  if (!f || typeof f !== 'object' || !Array.isArray(f.strokes)) return null;
  let points = 0;
  const strokes = f.strokes.slice(0, 400).map(s => {
    const p = (s && Array.isArray(s.p) ? s.p : []).slice(0, 2000).filter(Array.isArray)
      .map(q => [Math.round(clamp(Number(q[0]) || 0, 0, 320)), Math.round(clamp(Number(q[1]) || 0, 0, 320))]);
    points += p.length;
    return { c: INKS.includes(s && s.c) ? s.c : 'ink', w: Math.round(clamp(Number(s && s.w) || 4, 1, 30)), p };
  }).filter(s => s.p.length);
  if (!strokes.length || points > 30000) return null;
  const stats = {};
  for (const k of STATS) { const v = Math.round(Number(f.stats && f.stats[k])); if (!Number.isFinite(v) || v < 1 || v > 9999) return null; stats[k] = v; }
  return {
    name: cleanText(f.name, 16) || 'Unnamed', strokes, stats,
    el: INKS.includes(f.el) ? f.el : 'ink',
    grade: ['C', 'B', 'A', 'S'].includes(f.grade) ? f.grade : '?',
    born: Math.floor(Number(f.born)) || 0,
  };
}

/* ---------- auth: each player gets an id and a secret kept in their browser ---------- */
const hash = s => crypto.createHash('sha256').update(String(s)).digest();
function auth(body) {
  const p = body && typeof body.id === 'string' && db.players[body.id];
  if (!p || typeof body.secret !== 'string') return null;
  const a = hash(body.secret), b = Buffer.from(p.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? p : null;
}
const regLog = new Map(); // ip -> timestamps, limits sign-ups per hour
function allowRegister(ip) {
  const now = Date.now(), list = (regLog.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= 20) return false;
  list.push(now); regLog.set(ip, list); return true;
}

/* ---------- http ---------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
const fail = (res, code, err, msg) => send(res, code, { code: err, error: msg });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too_big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function publicState() {
  if (!stateCache) {
    stateCache = JSON.stringify({
      version,
      fighters: Object.entries(db.fighters).map(([id, f]) => ({ id, name: f.name, trainer: f.trainer, strokes: f.strokes, stats: f.stats, el: f.el, grade: f.grade, born: f.born, at: f.at })),
      results: db.results.slice(-1500),
    });
  }
  return stateCache;
}

async function handleApi(req, res, route) {
  const m = req.method;
  if (m === 'GET' && route === 'hello') return send(res, 200, { game: 'inkborn', version: 1 });
  if (m === 'GET' && route === 'state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(publicState());
  }
  if (m === 'GET' && route === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`data: ${version}\n\n`);
    listeners.add(res); req.on('close', () => listeners.delete(res));
    return;
  }

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, 'bad_request', e.message === 'too_big' ? 'That drawing is too large to upload.' : 'The request could not be read.'); }
  const now = Date.now();

  if (m === 'POST' && route === 'register') {
    const ip = req.socket.remoteAddress || '?';
    if (!allowRegister(ip)) return fail(res, 429, 'slow', 'Too many new players from this network. Try again later.');
    const id = 'p_' + crypto.randomBytes(9).toString('base64url');
    const secret = crypto.randomBytes(24).toString('base64url');
    db.players[id] = { hash: hash(secret).toString('hex'), created: now, peak: null, lastFight: 0 };
    persist();
    return send(res, 200, { id, secret });
  }

  const player = auth(body);
  if (!player) return fail(res, 401, 'auth', 'The server did not recognise you. Enter your fighter again.');
  const id = body.id;

  if (m === 'PUT' && route === 'fighter') {
    const f = cleanFighter(body.fighter);
    if (!f) return fail(res, 400, 'bad_fighter', 'That fighter could not be read.');
    const pw = power(f.stats), peak = player.peak;
    // Stats still come from the player's browser, so limit how fast they may grow.
    if (peak && peak.born === f.born) {
      const hours = (now - peak.at) / 3600e3;
      if (pw > peak.power + 20 + hours * 40) return fail(res, 422, 'stats', 'Your fighter grew faster than the server allows. Try again later.');
    } else if (pw > 400) return fail(res, 422, 'stats', 'Those stats are too high for a new fighter.');
    if (!peak || peak.born !== f.born || pw > peak.power) player.peak = { born: f.born, power: pw, at: now };
    db.fighters[id] = { ...f, trainer: cleanText(body.trainer, 24), at: now };
    changed();
    return send(res, 200, { ok: true });
  }

  if (m === 'DELETE' && route === 'fighter') {
    if (db.fighters[id]) { delete db.fighters[id]; changed(); }
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && route === 'fight') {
    const a = db.fighters[id];
    if (!a) return fail(res, 400, 'not_listed', 'Enter your fighter in the online arena first.');
    const defId = typeof body.defender === 'string' ? body.defender : '';
    const d = db.fighters[defId];
    if (!d || defId === id) return fail(res, 404, 'no_rival', 'That rival is not in the arena any more.');
    if (now - (player.lastFight || 0) < 2500) return fail(res, 429, 'slow', 'Slow down a little between fights.');
    player.lastFight = now;
    const result = simulate(a, d, rand);
    db.results.push({ a: id, ab: a.born, d: defId, db: d.born, w: result.winner === 0 ? 1 : 0, at: now, an: a.name, dn: d.name });
    if (db.results.length > MAX_RESULTS) db.results.splice(0, db.results.length - MAX_RESULTS);
    changed();
    return send(res, 200, result);
  }

  return fail(res, 404, 'not_found', 'Unknown request.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, p.slice(5));
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return fs.readFile(PAGE, (err, html) => {
        if (err) { res.writeHead(500); return res.end('public/index.html is missing.'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end(html);
      });
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'server', 'Something went wrong on the server.');
  }
});
server.listen(PORT, () => console.log(`Inkborn Arena is running at http://localhost:${PORT}`));

function shutdown() { clearTimeout(saveTimer); try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
