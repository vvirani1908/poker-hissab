// Poker Hissab — API core, shared by server.js (local/Render) and the Netlify function.
const crypto = require('crypto');

let db = { users: [], lobbies: [], sessions: [], tokens: {} };
let storage = null, loaded = false, dirty = false;
const setStorage = st => { storage = st; loaded = false; };
const save = () => { dirty = true; };

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

// ---------- request handling ----------
// reload=true re-reads the database on every request (needed on serverless, where instances don't share memory).
async function handle({ method, pathname, authorization, rawBody, reload }) {
  try {
    if (!loaded || reload) {
      db = (await storage.load()) || { users: [], lobbies: [], sessions: [], tokens: {} };
      db.tokens = db.tokens || {};
      loaded = true;
    }
    let body = {};
    if (rawBody) { try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Bad JSON'); } }
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      const token = (authorization || '').replace('Bearer ', '');
      let user = null;
      if (r.role) {
        user = db.users.find(u => u.id === db.tokens[token]);
        if (!user) throw new HttpError(401, 'Please log in');
      }
      const out = r.handler({ user, params, body, token });
      if (dirty) { dirty = false; await storage.save(db); }
      return { status: 200, body: out };
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    dirty = false;
    if (!(e instanceof HttpError)) console.error(e);
    if (!(e instanceof HttpError)) loaded = false; // re-read from storage after an unexpected failure
    return { status: e.status || 500, body: { error: e.status ? e.message : 'Server error' } };
  }
}

module.exports = { handle, setStorage };
