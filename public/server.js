// SecretChat sandbox server: the verified vanish relay + serves the web client from the same origin.
// Friends open https://<your-host>/ , pick an ID, and message. The relay only ever sees sealed ciphertext.
const fs = require('fs'), http = require('http'), https = require('https'), crypto = require('crypto'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080, PERSIST = process.env.PERSIST_FILE, MAX_HELD = 1000;

const APP = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));       // the chat app
const LANDING = fs.readFileSync(path.join(__dirname, 'public', 'landing.html'));  // the marketing page
const ADMIN = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'));      // admin-only dashboard

// Privacy-preserving analytics: COUNTS and timings only. Never message content, never who messaged whom, never ID names.
const stats = { startedAt: Date.now(), totalConnections: 0, messagesRelayed: 0, reads: 0, peakOnline: 0 };
const minuteBuf = []; // [{ t: minuteEpoch, msgs, reads }] for the last hour
const hourBuf = [];  // [{ t: hourEpoch, msgs, reads }] for the last ~2 days
function bump(kind) {
  const now = Date.now();
  const m = Math.floor(now / 60000);
  let b = minuteBuf[minuteBuf.length - 1];
  if (!b || b.t !== m) { b = { t: m, msgs: 0, reads: 0 }; minuteBuf.push(b); if (minuteBuf.length > 60) minuteBuf.shift(); }
  b[kind]++;
  const h = Math.floor(now / 3600000);
  let hb = hourBuf[hourBuf.length - 1];
  if (!hb || hb.t !== h) { hb = { t: h, msgs: 0, reads: 0 }; hourBuf.push(hb); if (hourBuf.length > 48) hourBuf.shift(); }
  hb[kind]++;
}
function onlineCount() { let n = 0; for (const u of users.values()) if (u.ws && u.ws.readyState === 1) n++; return n; }
function heldCount() { let n = 0; for (const q of held.values()) n += q.length; return n; }

// Anonymous feedback: rating 1-5 + optional comment. Never linked to a user ID.
const feedback = [];
const fbAgg = { count: 0, sum: 0, hist: [0, 0, 0, 0, 0] };
const page = (res, html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
// Static assets for home-screen install (manifest + icons), loaded once at startup.
const asset = (f, type) => ({ body: fs.readFileSync(path.join(__dirname, 'public', f)), type });
const STATIC = {
  '/manifest.webmanifest': asset('manifest.webmanifest', 'application/manifest+json'),
  '/icon-512.png': asset('icon-512.png', 'image/png'),
  '/icon-192.png': asset('icon-192.png', 'image/png'),
  '/icon-180.png': asset('icon-180.png', 'image/png'),
};
const handler = (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/admin') return page(res, ADMIN);
  if (url === '/admin/stats') {
    if (!process.env.ADMIN_KEY) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'admin not configured' })); }
    if ((req.headers['x-admin-key'] || '') !== process.env.ADMIN_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })); }
    const body = { onlineNow: onlineCount(), claimedIds: users.size, held: heldCount(),
      messagesRelayed: stats.messagesRelayed, reads: stats.reads, totalConnections: stats.totalConnections,
      peakOnline: stats.peakOnline, uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000), series: minuteBuf.slice(-30), seriesHour: hourBuf.slice(-24),
      feedback: { count: fbAgg.count, average: fbAgg.count ? +(fbAgg.sum / fbAgg.count).toFixed(2) : 0, hist: fbAgg.hist,
        recent: feedback.slice(-8).reverse().map(f => ({ rating: f.rating, comment: f.comment, t: f.t })) } };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(body));
  }
  const a = STATIC[url];
  if (a) { res.writeHead(200, { 'content-type': a.type, 'cache-control': 'public, max-age=86400' }); return res.end(a.body); }
  if (url === '/app' || url.startsWith('/app/')) return page(res, APP); // the chat app
  return page(res, LANDING); // landing page at / and everywhere else
};
const srv = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);
const wss = new WebSocketServer({ server: srv, maxPayload: 64 * 1024 });

const users = new Map();    // id -> { ws, pub, th }
const boxes = new Map();    // one-time reply mailbox -> ws
const held = new Map();     // recipient id -> [frame], kept until the recipient sends 'read'
const watchers = new Map(); // id -> Set(ws); a watcher only learns HOW MANY messages wait

let saveTimer = null;
const save = () => {
  if (!PERSIST || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const claims = [...users].map(([id, u]) => [id, { pub: u.pub, th: u.th }]);
    const tmp = PERSIST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, held: [...held], users: claims }), { mode: 0o600 });
    fs.renameSync(tmp, PERSIST);
  }, 500);
};
if (PERSIST && fs.existsSync(PERSIST)) {
  const d = JSON.parse(fs.readFileSync(PERSIST));
  for (const [k, v] of (d.held || [])) held.set(k, v);
  for (const [id, u] of (d.users || [])) users.set(id, { ws: null, pub: u.pub, th: u.th });
}

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const notify = id => { const n = (held.get(id) || []).length; for (const w of watchers.get(id) || []) send(w, { t: 'count', n }); };

wss.on('connection', ws => {
  stats.totalConnections++;
  let me = null, watching = null, hits = 0;
  const rl = setInterval(() => (hits = 0), 10000);
  ws.on('message', raw => {
    if (++hits > 30) return send(ws, { t: 'err', reason: 'rate limited' });
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (watching) return;
    if (m.t === 'hello' && m.watch) {
      const id = String(m.id || '').slice(0, 32), u = users.get(id);
      if (!u || u.th !== sha(m.token || '')) { send(ws, { t: 'err', reason: 'watch refused' }); return ws.close(); }
      watching = id;
      if (!watchers.has(id)) watchers.set(id, new Set());
      watchers.get(id).add(ws);
      return send(ws, { t: 'count', n: (held.get(id) || []).length });
    } else if (m.t === 'hello') {
      const id = String(m.id || '').slice(0, 32), tok = String(m.token || '');
      if (!id || tok.length < 12) { send(ws, { t: 'err', reason: 'ID and a token of 12+ chars required' }); return ws.close(); }
      const u = users.get(id);
      if (u && u.th !== sha(tok)) { send(ws, { t: 'err', reason: 'ID already claimed with a different token' }); return ws.close(); }
      me = id;
      const changed = !u || u.pub !== m.pub;
      users.set(id, { ws, pub: m.pub, th: sha(tok) });
      if (changed) save();
      for (const f of held.get(id) || []) send(ws, f);
      { const o = onlineCount(); if (o > stats.peakOnline) stats.peakOnline = o; }
    } else if (!me) {
      return send(ws, { t: 'err', reason: 'not authenticated' });
    } else if (m.t === 'getpub') {
      const u = users.get(m.id);
      send(ws, { t: 'pub', id: m.id, pub: u ? u.pub : null });
    } else if (m.t === 'send') {
      const q = held.get(m.to) || [];
      if (q.length >= MAX_HELD) return send(ws, { t: 'err', reason: 'recipient mailbox full' });
      const frame = { t: 'msg', msgId: m.msgId, eph: m.eph, ct: m.ct }; // sealed sender: no 'from'
      q.push(frame); held.set(m.to, q); save();
      stats.messagesRelayed++; bump('msgs');
      const u = users.get(m.to);
      if (u && u.ws && u.ws.readyState === 1) send(u.ws, frame);
      notify(m.to);
    } else if (m.t === 'sub') {
      boxes.set(String(m.box), ws);
    } else if (m.t === 'read') {
      const q = (held.get(me) || []).filter(f => f.msgId !== m.msgId);
      q.length ? held.set(me, q) : held.delete(me); save();
      stats.reads++; bump('reads');
      notify(me);
      if (m.box) { send(boxes.get(String(m.box)), { t: 'read', msgId: m.msgId }); boxes.delete(String(m.box)); }
    } else if (m.t === 'feedback') {
      const r = Math.round(Number(m.rating));
      if (!(r >= 1 && r <= 5)) return;
      const comment = String(m.comment || '').slice(0, 500);
      feedback.push({ rating: r, comment, t: Date.now() }); // no ID stored
      if (feedback.length > 500) feedback.shift();
      fbAgg.count++; fbAgg.sum += r; fbAgg.hist[r - 1]++;
      send(ws, { t: 'feedback_ok' });
    }
  });
  ws.on('close', () => {
    clearInterval(rl);
    if (watching) { const set = watchers.get(watching); set?.delete(ws); if (set && !set.size) watchers.delete(watching); }
    if (me && users.get(me)?.ws === ws) users.get(me).ws = null;
  });
});
srv.listen(PORT, () => console.log(`SecretChat sandbox on ${process.env.TLS_CERT ? 'https' : 'http'}://0.0.0.0:${PORT}`));
