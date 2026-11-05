// Poker Hissab — zero-dependency Node server. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname; // on Render: the mounted disk, e.g. /data
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

// ---------- storage ----------
// Local: data.json. Hosted: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to keep data in a free Redis.
let db = { users: [], lobbies: [], sessions: [], tokens: {} };
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = cmd => fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(cmd) }).then(r => r.json());
async function loadDb() {
  if (REDIS_URL) {
    const r = await redis(['GET', 'pokerdb']);
    if (r.error) throw new Error('Redis: ' + r.error);
    if (r.result) db = JSON.parse(r.result);
    console.log('Storage: Upstash Redis');
  } else {
    if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    console.log('Storage: data.json');
  }
}
let saving = false, dirty = false;
async function flush() {
  if (saving) { dirty = true; return; }
  saving = true;
  try { await redis(['SET', 'pokerdb', JSON.stringify(db)]); }
  catch (e) { console.error('Save failed', e.message); }
  saving = false;
  if (dirty) { dirty = false; flush(); }
}
const save = () => REDIS_URL ? void flush() : fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const uid = () => crypto.randomBytes(6).toString('hex');

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(user, pw) {
  const { hash } = hashPw(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash));
}
function addUser(username, name, password, role) {
  const u = { id: uid(), username: username.toLowerCase(), name: name || username, role, ...hashPw(password) };
  db.users.push(u);
  return u;
}
const genCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (db.lobbies.some(l => l.code === c));
  return c;
};

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const pub = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });
const num = v => { const n = Number(v); if (!isFinite(n) || n < 0) throw new HttpError(400, 'Amounts must be numbers >= 0'); return n; };

function lobbyView(l) {
  const members = l.members.map(id => db.users.find(u => u.id === id)).filter(Boolean).map(pub);
  const sessions = db.sessions.filter(s => s.lobbyId === l.id).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const totals = {};
  members.forEach(m => totals[m.id] = { ...m, buyIn: 0, cashOut: 0, net: 0, games: 0 });
  for (const s of sessions) for (const e of s.entries) {
    const t = totals[e.userId]; if (!t) continue;
    t.buyIn += e.buyIn; t.cashOut += e.cashOut; t.net += e.cashOut - e.buyIn; t.games++;
  }
  const standings = Object.values(totals).sort((a, b) => b.net - a.net);
  const sessionsOut = sessions.map(s => ({
    ...s,
    totalIn: s.entries.reduce((a, e) => a + e.buyIn, 0),
    totalOut: s.entries.reduce((a, e) => a + e.cashOut, 0),
  }));
  return {
    id: l.id, code: l.code, name: l.name, members, standings, sessions: sessionsOut,
    overall: {
      buyIn: standings.reduce((a, t) => a + t.buyIn, 0),
      cashOut: standings.reduce((a, t) => a + t.cashOut, 0),
      // house/rake or counting mismatch: money put in that was never cashed out
      discrepancy: standings.reduce((a, t) => a + t.buyIn - t.cashOut, 0),
    },
  };
}

function cleanEntries(l, entries) {
  if (!Array.isArray(entries)) throw new HttpError(400, 'entries required');
  const seen = new Set();
  return entries.map(e => {
    if (!l.members.includes(e.userId)) throw new HttpError(400, 'Entry for non-member');
    if (seen.has(e.userId)) throw new HttpError(400, 'Duplicate player in session');
    seen.add(e.userId);
    return { userId: e.userId, buyIn: num(e.buyIn), cashOut: num(e.cashOut) };
  });
}

function myHistory(l, userId) {
  const mine = db.sessions.filter(s => s.lobbyId === l.id && s.entries.some(e => e.userId === userId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);
  let cum = 0;
  return mine.map(s => {
    const e = s.entries.find(x => x.userId === userId);
    const net = e.cashOut - e.buyIn; cum += net;
    return { sessionId: s.id, date: s.date, note: s.note, buyIn: e.buyIn, cashOut: e.cashOut, net, cumulative: cum };
  });
}
const theLobby = () => db.lobbies[0] || null;

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, role) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, role });
};
const needSuper = (user) => {
  const l = theLobby();
  if (!l || l.ownerId !== user.id) throw new HttpError(403, 'Only the super user can do this');
  return l;
};
const newSession = (userId) => {
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = userId; save();
  return token;
};
const checkCreds = body => {
  const username = String(body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,20}$/.test(username)) throw new HttpError(400, 'Username: 3-20 chars, letters/numbers/_.-');
  if (String(body.password || '').length < 4) throw new HttpError(400, 'Password must be at least 4 characters');
  if (db.users.some(u => u.username === username)) throw new HttpError(409, 'Username taken');
  return username;
};

route('GET', '/api/status', () => ({ hasLobby: !!theLobby(), lobbyName: theLobby() ? theLobby().name : null }));

route('POST', '/api/login', ({ body }) => {
  const u = db.users.find(x => x.username === String(body.username || '').toLowerCase());
  if (!u || !checkPw(u, String(body.password || ''))) throw new HttpError(401, 'Wrong username or password');
  return { token: newSession(u.id), user: pub(u) };
});

// First account ever = super user (creates the one lobby). Everyone else needs the lobby code.
route('POST', '/api/register', ({ body }) => {
  const l = theLobby();
  const username = checkCreds(body);
  const display = String(body.name || '').trim() || username;
  if (!l) {
    const u = addUser(username, display, body.password, 'super');
    db.lobbies.push({ id: uid(), name: String(body.lobbyName || '').trim() || 'Poker Night', code: genCode(), ownerId: u.id, members: [u.id] });
    save();
    return { token: newSession(u.id), user: pub(u) };
  }
  if (String(body.code || '').trim().toUpperCase() !== l.code) throw new HttpError(400, 'Invalid lobby code');
  const u = addUser(username, display, body.password, 'player');
  l.members.push(u.id);
  save();
  return { token: newSession(u.id), user: pub(u) };
});

route('POST', '/api/logout', ({ token }) => { delete db.tokens[token]; save(); return { ok: true }; }, 'any');
route('GET', '/api/me', ({ user }) => ({ user: pub(user) }), 'any');

// Everything the dashboard needs in one call
route('GET', '/api/home', ({ user }) => {
  const l = theLobby();
  if (!l || !l.members.includes(user.id)) throw new HttpError(404, 'Not in the lobby');
  const v = lobbyView(l);
  const isSuper = l.ownerId === user.id;
  const history = myHistory(l, user.id);
  const nets = history.map(h => h.net);
  const me = {
    games: history.length,
    buyIn: history.reduce((a, h) => a + h.buyIn, 0),
    cashOut: history.reduce((a, h) => a + h.cashOut, 0),
    net: history.reduce((a, h) => a + h.net, 0),
    best: nets.length ? Math.max(...nets) : 0,
    worst: nets.length ? Math.min(...nets) : 0,
    wins: nets.filter(n => n > 0).length,
    history,
  };
  const out = { user: pub(user), isSuper, lobby: { id: l.id, name: l.name, hostId: l.ownerId }, members: v.members, standings: v.standings, overall: v.overall, me };
  if (isSuper) { out.lobby.code = l.code; out.sessions = v.sessions; }
  return out;
}, 'any');

// Backup / restore (super user). The backup contains password hashes, so keep the file private.
route('GET', '/api/backup', ({ user }) => {
  needSuper(user);
  return { users: db.users, lobbies: db.lobbies, sessions: db.sessions };
}, 'any');
route('POST', '/api/restore', ({ user, body }) => {
  needSuper(user);
  if (!Array.isArray(body.users) || !Array.isArray(body.lobbies) || !Array.isArray(body.sessions)
      || !body.users.some(u => u.id === user.id) || !body.lobbies.some(l => l.ownerId === user.id))
    throw new HttpError(400, 'Not a valid backup for this account');
  db = { users: body.users, lobbies: body.lobbies, sessions: body.sessions, tokens: db.tokens };
  save();
  return { ok: true };
}, 'any');

route('DELETE', '/api/members/:uid', ({ user, params }) => {
  const l = needSuper(user);
  if (params.uid === l.ownerId) throw new HttpError(400, 'Super user cannot be removed');
  l.members = l.members.filter(m => m !== params.uid); save();
  return { ok: true };
}, 'any');

route('POST', '/api/sessions', ({ user, body }) => {
  const l = needSuper(user);
  const s = {
    id: uid(), lobbyId: l.id, created: Date.now(),
    date: String(body.date || new Date().toISOString().slice(0, 10)),
    note: String(body.note || '').slice(0, 200),
    entries: cleanEntries(l, body.entries),
  };
  db.sessions.push(s); save(); return s;
}, 'any');
route('PUT', '/api/sessions/:id', ({ user, params, body }) => {
  const l = needSuper(user);
  const s = db.sessions.find(x => x.id === params.id);
  if (!s) throw new HttpError(404, 'Game not found');
  s.date = String(body.date || s.date);
  s.note = String(body.note || '').slice(0, 200);
  s.entries = cleanEntries(l, body.entries);
  save(); return s;
}, 'any');
route('DELETE', '/api/sessions/:id', ({ user, params }) => {
  needSuper(user);
  db.sessions = db.sessions.filter(x => x.id !== params.id); save();
  return { ok: true };
}, 'any');

// ---------- server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (!url.pathname.startsWith('/api/')) {
    let f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    return fs.createReadStream(f).pipe(res);
  }

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Bad JSON'); } }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        let user = null;
        if (r.role) {
          user = db.users.find(u => u.id === db.tokens[token]);
          if (!user) throw new HttpError(401, 'Please log in');
        }
        return send(200, r.handler({ user, params, body, token }));
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(e.status || 500, { error: e.status ? e.message : 'Server error' });
    }
  });
});
loadDb().then(() => server.listen(PORT, () => console.log(`Poker Hissab running on http://localhost:${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
