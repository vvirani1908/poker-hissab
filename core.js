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
  members.forEach(m => totals[m.id] = { ...m, buyIn: 0, cashOut: 0, net: 0, games: 0, wins: 0 });
  for (const s of sessions) for (const e of s.entries) {
    const t = totals[e.userId]; if (!t) continue;
    t.buyIn += e.buyIn; t.cashOut += e.cashOut; t.net += e.cashOut - e.buyIn; t.games++; if (e.cashOut > e.buyIn) t.wins++;
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

// Lobby-wide highlights shown on the home page (no per-player buy-in detail beyond winners)
function highlights(l) {
  const sess = db.sessions.filter(s => s.lobbyId === l.id).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const nameOf = id => (db.users.find(u => u.id === id) || {}).name || 'Removed player';
  let bw = null, bl = null, pot = 0;
  const recent = [];
  for (const s of sess) {
    let sp = 0, top = null;
    for (const e of s.entries) {
      const net = e.cashOut - e.buyIn; sp += e.buyIn;
      if (!bw || net > bw.amount) bw = { name: nameOf(e.userId), amount: net, date: s.date };
      if (!bl || net < bl.amount) bl = { name: nameOf(e.userId), amount: net, date: s.date };
      if (!top || net > top.net) top = { name: nameOf(e.userId), net };
    }
    pot += sp;
    if (recent.length < 5) recent.push({ date: s.date, note: s.note, pot: sp, players: s.entries.length, winner: top && top.net > 0 ? top : null });
  }
  return { games: sess.length, pot, biggestWin: bw && bw.amount > 0 ? bw : null, biggestLoss: bl && bl.amount < 0 ? bl : null, recent };
}

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
  out.highlights = highlights(l);
  out.owe = oweView(l);
  out.events = eventsList().filter(e => e.status === 'upcoming' || e.status === 'live')
    .sort((a, b) => (a.status === 'live' ? -1 : 0) - (b.status === 'live' ? -1 : 0) || (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .map(e => evView(e, user.id));
  if (isSuper) { out.lobby.code = l.code; out.sessions = v.sessions; }
  return out;
}, 'any');

// Backup / restore (super user). The backup contains password hashes, so keep the file private.
route('GET', '/api/backup', ({ user }) => {
  needSuper(user);
  return { users: db.users, lobbies: db.lobbies, sessions: db.sessions, events: eventsList(), payments: db.payments || [] };
}, 'any');
route('POST', '/api/restore', ({ user, body }) => {
  needSuper(user);
  if (!Array.isArray(body.users) || !Array.isArray(body.lobbies) || !Array.isArray(body.sessions)
      || !body.users.some(u => u.id === user.id) || !body.lobbies.some(l => l.ownerId === user.id))
    throw new HttpError(400, 'Not a valid backup for this account');
  db = { users: body.users, lobbies: body.lobbies, sessions: body.sessions, events: Array.isArray(body.events) ? body.events : [], payments: Array.isArray(body.payments) ? body.payments : [], tokens: db.tokens };
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


// ---------- events: upcoming -> live -> finished ----------
const eventsList = () => (db.events = db.events || []);
const findEvent = id => { const e = eventsList().find(x => x.id === id); if (!e) throw new HttpError(404, 'Event not found'); return e; };
const money = n => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US');
const posNum = v => { const n = Number(v); if (!isFinite(n) || n <= 0) throw new HttpError(400, 'Enter an amount greater than 0'); return n; };
const playerTotals = p => { const rebuys = (p.rebuys || []).reduce((a, r) => a + r.amount, 0); return { rebuys, total: p.buyIn + rebuys }; };
function evView(e, userId) {
  const players = e.players.map(p => {
    const u = db.users.find(x => x.id === p.userId);
    return { userId: p.userId, name: u ? u.name : 'Removed player', buyIn: p.buyIn, ...playerTotals(p), joinedAt: p.joinedAt };
  });
  return {
    id: e.id, title: e.title, date: e.date, time: e.time, location: e.location, minBuyIn: e.minBuyIn, maxSeats: e.maxSeats,
    status: e.status, startedAt: e.startedAt, players, pot: players.reduce((a, p) => a + p.total, 0),
    seatsLeft: e.maxSeats ? Math.max(0, e.maxSeats - players.length) : null,
    joined: players.some(p => p.userId === userId),
  };
}

route('POST', '/api/events', ({ user, body }) => {
  needSuper(user);
  const title = String(body.title || '').trim().slice(0, 60);
  if (!title) throw new HttpError(400, 'Give the event a title');
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Pick a date for the event');
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10); // loose check, allows for time zones
  if (date < yesterday) throw new HttpError(400, 'The date can\'t be in the past');
  const time = String(body.time || '');
  if (!/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'Pick a start time');
  const location = String(body.location || '').trim().slice(0, 100);
  if (!location) throw new HttpError(400, 'Add a location');
  if (body.minBuyIn === undefined || body.minBuyIn === null || String(body.minBuyIn).trim() === '') throw new HttpError(400, 'Set a minimum buy-in');
  const minBuyIn = posNum(body.minBuyIn);
  const maxSeats = body.maxSeats ? Math.floor(Number(body.maxSeats)) : 0;
  if (body.maxSeats && (!isFinite(maxSeats) || maxSeats < 2)) throw new HttpError(400, 'Seats must be 2 or more');
  const e = { id: uid(), title, date, time, location, minBuyIn, maxSeats, status: 'upcoming', players: [], created: Date.now() };
  eventsList().push(e); save();
  return evView(e, user.id);
}, 'any');

route('DELETE', '/api/events/:id', ({ user, params }) => {
  needSuper(user);
  const e = findEvent(params.id);
  if (e.status === 'finished') throw new HttpError(400, 'Finished events stay in history');
  db.events = eventsList().filter(x => x.id !== e.id); save();
  return { ok: true };
}, 'any');

route('POST', '/api/events/:id/join', ({ user, params, body }) => {
  const l = theLobby();
  if (!l || !l.members.includes(user.id)) throw new HttpError(403, 'Not in the lobby');
  const e = findEvent(params.id);
  if (e.status !== 'upcoming' && e.status !== 'live') throw new HttpError(400, 'This event is closed');
  if (e.players.some(p => p.userId === user.id)) throw new HttpError(409, 'You already joined');
  const buyIn = posNum(body.buyIn);
  if (buyIn < e.minBuyIn) throw new HttpError(400, `Minimum buy-in is ${money(e.minBuyIn)}`);
  if (e.maxSeats && e.players.length >= e.maxSeats) throw new HttpError(400, 'No seats left');
  e.players.push({ userId: user.id, buyIn, rebuys: [], joinedAt: Date.now() }); save();
  return evView(e, user.id);
}, 'any');

route('DELETE', '/api/events/:id/join', ({ user, params }) => {
  const e = findEvent(params.id);
  if (e.status === 'live') throw new HttpError(400, 'The game has started. Ask the super user to remove you.');
  if (e.status !== 'upcoming') throw new HttpError(400, 'This event is closed');
  e.players = e.players.filter(p => p.userId !== user.id); save();
  return { ok: true };
}, 'any');

route('DELETE', '/api/events/:id/players/:uid', ({ user, params }) => {
  needSuper(user);
  const e = findEvent(params.id);
  if (e.status === 'finished') throw new HttpError(400, 'Event is finished');
  e.players = e.players.filter(p => p.userId !== params.uid); save();
  return { ok: true };
}, 'any');

route('POST', '/api/events/:id/start', ({ user, params }) => {
  needSuper(user);
  const e = findEvent(params.id);
  if (e.status !== 'upcoming') throw new HttpError(400, 'Event already started or closed');
  if (eventsList().some(x => x.status === 'live')) throw new HttpError(400, 'Another session is already in progress');
  if (e.players.length < 2) throw new HttpError(400, 'Need at least 2 players to start');
  e.status = 'live'; e.startedAt = Date.now(); save();
  return evView(e, user.id);
}, 'any');

route('POST', '/api/events/:id/rebuy', ({ user, params, body }) => {
  needSuper(user);
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Session is not live');
  const p = e.players.find(x => x.userId === body.userId);
  if (!p) throw new HttpError(404, 'Player not in this session');
  (p.rebuys = p.rebuys || []).push({ amount: posNum(body.amount), at: Date.now() }); save();
  return evView(e, user.id);
}, 'any');

// End the session: record cash-outs and save it as a normal game in everyone's history.
route('POST', '/api/events/:id/finish', ({ user, params, body }) => {
  const l = needSuper(user);
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Session is not live');
  const outs = body.cashOuts || {};
  const entries = e.players.map(p => ({ userId: p.userId, buyIn: playerTotals(p).total, cashOut: num(outs[p.userId] || 0) }));
  const s = { id: uid(), lobbyId: l.id, created: Date.now(), date: e.date, note: e.title, entries: cleanEntries(l, entries) };
  db.sessions.push(s);
  e.status = 'finished'; e.sessionId = s.id; e.finishedAt = Date.now(); save();
  return { ok: true, sessionId: s.id };
}, 'any');


// ---------- settle-up: who owes whom ----------
const round2 = n => Math.round(n * 100) / 100;
// balance > 0: the lobby owes this player; balance < 0: this player owes the lobby. Payments move balances toward zero.
function balancesFor(l) {
  const bal = {}; l.members.forEach(id => bal[id] = 0);
  for (const s of db.sessions) if (s.lobbyId === l.id) for (const e of s.entries) if (e.userId in bal) bal[e.userId] += e.cashOut - e.buyIn;
  for (const p of (db.payments || [])) { if (p.from in bal) bal[p.from] += p.amount; if (p.to in bal) bal[p.to] -= p.amount; }
  Object.keys(bal).forEach(k => bal[k] = round2(bal[k]));
  return bal;
}
// Fewest payments: repeatedly match the biggest debtor with the biggest creditor.
function settleUp(bal) {
  const cr = [], dr = [];
  for (const [id, v] of Object.entries(bal)) { if (v > 0.004) cr.push({ id, v }); else if (v < -0.004) dr.push({ id, v: -v }); }
  cr.sort((a, b) => b.v - a.v); dr.sort((a, b) => b.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < dr.length && j < cr.length) {
    const amt = Math.min(dr[i].v, cr[j].v);
    out.push({ from: dr[i].id, to: cr[j].id, amount: round2(amt) });
    dr[i].v -= amt; cr[j].v -= amt;
    if (dr[i].v < 0.005) i++;
    if (cr[j].v < 0.005) j++;
  }
  return out;
}
function oweView(l) {
  const name = id => (db.users.find(u => u.id === id) || {}).name || 'Removed player';
  const bal = balancesFor(l);
  const settlements = settleUp(bal).map(t => ({ ...t, fromName: name(t.from), toName: name(t.to) }));
  const payments = (db.payments || []).filter(p => p.lobbyId === l.id).sort((a, b) => b.created - a.created).slice(0, 8)
    .map(p => ({ id: p.id, from: p.from, to: p.to, amount: p.amount, date: p.date, fromName: name(p.from), toName: name(p.to) }));
  return { settlements, payments, unaccounted: round2(Object.values(bal).reduce((a, v) => a + v, 0)) };
}

route('POST', '/api/payments', ({ user, body }) => {
  const l = needSuper(user);
  if (body.from === body.to) throw new HttpError(400, 'Pick two different players');
  if (!l.members.includes(body.from) || !l.members.includes(body.to)) throw new HttpError(400, 'Both must be players in the lobby');
  const amount = posNum(body.amount);
  if (amount > 1e7) throw new HttpError(400, 'Amount too large');
  const pay = { id: uid(), lobbyId: l.id, from: body.from, to: body.to, amount: round2(amount), date: new Date().toISOString().slice(0, 10), created: Date.now() };
  (db.payments = db.payments || []).push(pay); save();
  return { ok: true, id: pay.id };
}, 'any');
route('DELETE', '/api/payments/:id', ({ user, params }) => {
  needSuper(user);
  db.payments = (db.payments || []).filter(p => p.id !== params.id); save();
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
