// SecretChat sandbox server: the verified vanish relay + serves the web client from the same origin.
// Friends open https://<your-host>/ , pick an ID, and message. The relay only ever sees sealed ciphertext.
const fs = require('fs'), http = require('http'), https = require('https'), crypto = require('crypto'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080, PERSIST = process.env.PERSIST_FILE, MAX_HELD = 1000;

const CLIENT = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const handler = (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(CLIENT); // every path serves the single-page client
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
      const u = users.get(m.to);
      if (u && u.ws && u.ws.readyState === 1) send(u.ws, frame);
      notify(m.to);
    } else if (m.t === 'sub') {
      boxes.set(String(m.box), ws);
    } else if (m.t === 'read') {
      const q = (held.get(me) || []).filter(f => f.msgId !== m.msgId);
      q.length ? held.set(me, q) : held.delete(me); save();
      notify(me);
      if (m.box) { send(boxes.get(String(m.box)), { t: 'read', msgId: m.msgId }); boxes.delete(String(m.box)); }
    }
  });
  ws.on('close', () => {
    clearInterval(rl);
    if (watching) { const set = watchers.get(watching); set?.delete(ws); if (set && !set.size) watchers.delete(watching); }
    if (me && users.get(me)?.ws === ws) users.get(me).ws = null;
  });
});
srv.listen(PORT, () => console.log(`SecretChat sandbox on ${process.env.TLS_CERT ? 'https' : 'http'}://0.0.0.0:${PORT}`));
