// Poker Hissab — API core, shared by server.js (local/Render) and the Netlify function.
const crypto = require('crypto');

let db = { users: [], lobbies: [], sessions: [], tokens: {} };
let storage = null, loaded = false, dirty = false, version = null;
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
const pub = u => ({ id: u.id, name: u.name, role: u.role });
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

// ---------- email identity: one real inbox = one account ----------
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'emailondeck.com', 'moakt.com', 'tmpmail.org', 'mohmal.com', 'tempail.com', 'burnermail.io', 'spamgourmet.com']);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const normEmail = e => String(e || '').trim().toLowerCase();
const checkEmail = e => {
  if (!EMAIL_RE.test(e) || e.length > 120) throw new HttpError(400, 'Enter a valid email address');
  if (DISPOSABLE.has(e.split('@')[1])) throw new HttpError(400, 'Please use a real email address, not a temporary one');
};
const DEV_OTP = () => process.env.DEV_SHOW_OTP === '1';           // local testing only: returns the code in the response
const brevoReady = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
const smtpReady = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);   // e.g. a Gmail address + a Gmail "app password"
const mailReady = () => brevoReady() || smtpReady();
let mailer = null;                       // the nodemailer module, handed in by server.js / the Netlify function (so it gets bundled)
const setMailer = m => { mailer = m; };
const MAIL_PER_EMAIL_HOUR = 5, MAIL_PER_DAY = Number(process.env.MAIL_DAILY_CAP || 150);

const hashOtp = (code, salt) => crypto.createHash('sha256').update(salt + code).digest('hex');
function newOtp() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
  return { code, rec: { salt, h: hashOtp(code, salt), exp: Date.now() + 10 * 60 * 1000, tries: 0, sentAt: Date.now() } };
}
// Returns null when the code is right, or an error marker (the failed try is saved, so guessing can't be reset).
function checkOtp(rec, code) {
  if (!rec || Date.now() > rec.exp) return failSaved(400, 'That code has expired. Request a new one.');
  if (rec.tries >= 5) return failSaved(429, 'Too many wrong tries. Request a new code.');
  rec.tries++; save();
  const a = Buffer.from(hashOtp(String(code || '').trim(), rec.salt)), b = Buffer.from(rec.h);
  return crypto.timingSafeEqual(a, b) ? null : failSaved(400, 'That code is wrong');
}
const failSaved = (status, msg) => ({ __err: true, status, msg });

// Send limits: per email per hour, and a daily cap so the free mail plan can't be drained.
function mailAllowed(email) {
  const now = Date.now(); db.mailLog = (db.mailLog || []).filter(m => now - m.at < 24 * 3600 * 1000);
  if (db.mailLog.length >= MAIL_PER_DAY) throw new HttpError(429, 'Too many sign-ups today. Please try again tomorrow.');
  if (db.mailLog.filter(m => m.email === email && now - m.at < 3600 * 1000).length >= MAIL_PER_EMAIL_HOUR) throw new HttpError(429, 'Too many codes sent to this email. Try again in an hour.');
  db.mailLog.push({ email, at: now });
}
async function sendMail(to, subject, text) {
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#1d2a22">${text.split('\n').map(l => `<p style="margin:0 0 10px">${l.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`).join('')}<p style="color:#6b786f;font-size:13px">♠ Poker Hissab</p></div>`;
  const fromName = process.env.MAIL_FROM_NAME || 'Poker Hissab';
  if (smtpReady()) {
    if (!mailer) throw new HttpError(503, 'Email is misconfigured on this server.');
    const port = Number(process.env.SMTP_PORT || 465);
    const tx = mailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : port === 465,
      auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    try { await tx.sendMail({ from: `"${fromName}" <${process.env.MAIL_FROM || process.env.SMTP_USER}>`, to, subject, text, html }); }
    catch (e) { console.error('smtp failed', e.code || '', String(e.message).slice(0, 200)); throw new HttpError(502, "We couldn't send the email. Try again in a minute."); }
    return;
  }
  const r = await fetch(process.env.BREVO_URL || 'https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: process.env.MAIL_FROM, name: fromName }, to: [{ email: to }], subject, textContent: text, htmlContent: html }) });
  if (!r.ok) { console.error('mail failed', r.status, (await r.text()).slice(0, 200)); throw new HttpError(502, "We couldn't send the email. Try again in a minute."); }
}
const otpMail = (email, code, why) => async () => {
  if (DEV_OTP() && !mailReady()) { console.log(`[dev] code for ${email}: ${code}`); return; }
  await sendMail(email, `Your Poker Hissab code: ${code}`, `Your code is ${code}.\nUse it ${why}. It expires in 10 minutes.\nIf you didn't ask for this, you can ignore this email.`);
};
const needMailSetup = () => { if (!mailReady() && !DEV_OTP()) throw new HttpError(503, "Email sign-up isn't set up on this server yet. Ask your host."); };
const cleanPending = () => { const now = Date.now(); db.pending = (db.pending || []).filter(p => now - p.created < 3600 * 1000); return db.pending; };
const handleFor = email => { const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20)) || 'player'; let h = base, i = 2; while (db.users.some(u => u.username === h)) h = base + i++; return h; };
const findByLogin = id => { const x = String(id || '').trim().toLowerCase(); return db.users.find(u => u.email === x || u.username === x); };

route('GET', '/api/status', () => ({ hasLobby: !!theLobby(), lobbyName: theLobby() ? theLobby().name : null, emailReady: mailReady() || DEV_OTP() }));

route('POST', '/api/login', ({ body }) => {
  const u = findByLogin(body.username || body.email);
  if (!u || !checkPw(u, String(body.password || ''))) throw new HttpError(401, 'Wrong email or password');
  return { token: newSession(u.id), user: pub(u) };
});

// Step 1: validate and email a 6-digit code. Nothing is created until the code is entered.
route('POST', '/api/register/start', ({ body, after }) => {
  needMailSetup();
  const l = theLobby(), email = normEmail(body.email); checkEmail(email);
  const name = String(body.name || '').trim().slice(0, 40); if (!name) throw new HttpError(400, 'Enter your name');
  checkNewPassword(body.password);
  if (db.users.some(u => u.email === email)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
  if (l && String(body.code || '').trim().toUpperCase() !== l.code) throw new HttpError(400, 'Invalid lobby code');
  mailAllowed(email);
  const list = cleanPending(); db.pending = list.filter(p => !(p.kind === 'register' && p.email === email));
  const { code, rec } = newOtp();
  const p = { id: uid(), kind: 'register', email, name, ...hashPw(String(body.password)), isFirst: !l, lobbyName: String(body.lobbyName || '').trim().slice(0, 60) || 'Poker Night', otp: rec, created: Date.now() };
  db.pending.push(p); save(); after(otpMail(email, code, 'to finish creating your account'));
  return { pendingId: p.id, email, ...(DEV_OTP() ? { devCode: code } : {}) };
});

// Step 2: the code is right -> create the account. Everyone except the very first person then waits for host approval.
route('POST', '/api/register/verify', ({ body }) => {
  const p = cleanPending().find(x => x.id === body.pendingId && x.kind === 'register');
  if (!p) throw new HttpError(400, 'That sign-up expired. Please start again.');
  const bad = checkOtp(p.otp, body.otp); if (bad) return bad;
  if (db.users.some(u => u.email === p.email)) throw new HttpError(409, 'That email already has an account. Sign in instead.');
  const l = theLobby();
  if (p.isFirst && l) { db.pending = db.pending.filter(x => x !== p); save(); return failSaved(409, 'Someone else just set up the lobby. Ask them for the lobby code.'); }
  const u = { id: uid(), username: handleFor(p.email), email: p.email, emailVerified: true, name: p.name, role: p.isFirst ? 'super' : 'player', salt: p.salt, hash: p.hash, created: Date.now() };
  db.users.push(u);
  if (p.isFirst) db.lobbies.push({ id: uid(), name: p.lobbyName, code: genCode(), ownerId: u.id, members: [u.id], pending: [] });
  else (l.pending = l.pending || []).push(u.id);
  db.pending = db.pending.filter(x => x !== p);
  return { token: newSession(u.id), user: pub(u), waiting: !p.isFirst };
});

route('POST', '/api/otp/resend', ({ body, after }) => {
  const p = cleanPending().find(x => x.id === body.pendingId);
  if (!p) throw new HttpError(400, 'That request expired. Please start again.');
  if (Date.now() - p.otp.sentAt < 30 * 1000) throw new HttpError(429, 'Please wait a few seconds before asking for another code.');
  mailAllowed(p.email);
  const { code, rec } = newOtp(); p.otp = rec; save();
  after(otpMail(p.email, code, p.kind === 'reset' ? 'to reset your password' : p.kind === 'email' ? 'to confirm your email' : 'to finish creating your account'));
  return { ok: true, ...(DEV_OTP() ? { devCode: code } : {}) };
});

// ---------- host approval for new members ----------
route('POST', '/api/members/:id/approve', ({ user, params }) => {
  const l = needSuper(user);
  if (!(l.pending || []).includes(params.id)) throw new HttpError(404, 'No such request');
  l.pending = l.pending.filter(x => x !== params.id); if (!l.members.includes(params.id)) l.members.push(params.id); save();
  return { ok: true };
}, 'any');
route('POST', '/api/members/:id/decline', ({ user, params }) => {
  const l = needSuper(user);
  if (!(l.pending || []).includes(params.id)) throw new HttpError(404, 'No such request');
  l.pending = l.pending.filter(x => x !== params.id); db.users = db.users.filter(u => u.id !== params.id); db.payments = (db.payments || []).filter(p => p.from !== params.id && p.to !== params.id); revokeTokens(params.id, null); save();
  return { ok: true };
}, 'any');

// ---------- add / confirm an email on an older (username-only) account ----------
route('POST', '/api/me/email/start', ({ user, body, after }) => {
  needMailSetup();
  const email = normEmail(body.email); checkEmail(email);
  if (db.users.some(u => u.email === email && u.id !== user.id)) throw new HttpError(409, 'That email is already used by another account');
  mailAllowed(email); cleanPending(); db.pending = db.pending.filter(p => !(p.kind === 'email' && p.userId === user.id));
  const { code, rec } = newOtp(); const p = { id: uid(), kind: 'email', userId: user.id, email, otp: rec, created: Date.now() };
  db.pending.push(p); save(); after(otpMail(email, code, 'to confirm your email'));
  return { pendingId: p.id, email, ...(DEV_OTP() ? { devCode: code } : {}) };
}, 'any');
route('POST', '/api/me/email/verify', ({ user, body }) => {
  const p = cleanPending().find(x => x.id === body.pendingId && x.kind === 'email' && x.userId === user.id);
  if (!p) throw new HttpError(400, 'That request expired. Please start again.');
  const bad = checkOtp(p.otp, body.otp); if (bad) return bad;
  if (db.users.some(u => u.email === p.email && u.id !== user.id)) throw new HttpError(409, 'That email is already used by another account');
  user.email = p.email; user.emailVerified = true; db.pending = db.pending.filter(x => x !== p); save();
  return { ok: true };
}, 'any');

// ---------- forgot password by emailed code ----------
route('POST', '/api/password/forgot', ({ body, after }) => {
  needMailSetup();
  const email = normEmail(body.email); checkEmail(email);
  const u = db.users.find(x => x.email === email);
  const fake = uid(); // same answer whether or not the email exists
  if (!u) return { pendingId: fake, email };
  mailAllowed(email); cleanPending(); db.pending = db.pending.filter(p => !(p.kind === 'reset' && p.userId === u.id));
  const { code, rec } = newOtp(); const p = { id: uid(), kind: 'reset', userId: u.id, email, otp: rec, created: Date.now() };
  db.pending.push(p); save(); after(otpMail(email, code, 'to reset your password'));
  return { pendingId: p.id, email, ...(DEV_OTP() ? { devCode: code } : {}) };
});
route('POST', '/api/password/reset', ({ body }) => {
  const p = cleanPending().find(x => x.id === body.pendingId && x.kind === 'reset');
  if (!p) throw new HttpError(400, 'That code is wrong or expired. Request a new one.');
  const bad = checkOtp(p.otp, body.otp); if (bad) return bad;
  const u = db.users.find(x => x.id === p.userId); if (!u) throw new HttpError(400, 'Account not found');
  Object.assign(u, hashPw(checkNewPassword(body.password)));
  revokeTokens(u.id, null); db.pending = db.pending.filter(x => x !== p); save();
  return { ok: true };
});

route('POST', '/api/logout', ({ token }) => { delete db.tokens[token]; save(); return { ok: true }; }, 'any');
route('GET', '/api/me', ({ user }) => { const l = theLobby(); return { user: pub(user), pending: !!(l && (l.pending || []).includes(user.id)) }; }, 'any');

// Everything the dashboard needs in one call
route('GET', '/api/home', ({ user }) => {
  const l = theLobby();
  if (l && (l.pending || []).includes(user.id)) throw new HttpError(403, 'PENDING');
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
  const out = { user: { ...pub(user), hasEmail: !!user.email }, emailReady: mailReady() || DEV_OTP(), isSuper, lobby: { id: l.id, name: l.name, hostId: l.ownerId }, members: v.members, standings: v.standings, overall: v.overall, me };
  out.lobby.notes = l.notes || '';
  out.nights = db.sessions.filter(x => x.lobbyId === l.id).sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created).map(x => ({
    id: x.id, date: x.date, note: x.note, pot: x.entries.reduce((a, e) => a + e.buyIn, 0),
    entries: x.entries.map(e => ({ userId: e.userId, name: (db.users.find(u => u.id === e.userId) || {}).name || 'Removed player', buyIn: e.buyIn, cashOut: e.cashOut, net: round2(e.cashOut - e.buyIn) })),
  }));
  out.highlights = highlights(l);
  out.owe = oweView(l);
  out.events = eventsList().filter(e => e.status === 'upcoming' || e.status === 'live')
    .sort((a, b) => (a.status === 'live' ? -1 : 0) - (b.status === 'live' ? -1 : 0) || (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .map(e => evView(e, user.id));
  if (isSuper) {
    out.lobby.code = l.code; out.sessions = v.sessions;
    out.contacts = Object.fromEntries(v.members.map(m => [m.id, (db.users.find(u => u.id === m.id) || {}).email || (db.users.find(u => u.id === m.id) || {}).username || '']));
    out.pending = (l.pending || []).map(id => db.users.find(u => u.id === id)).filter(Boolean).map(u => ({ id: u.id, name: u.name, email: u.email || '', since: u.created || 0 }));
  }
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
  l.members = l.members.filter(m => m !== params.uid);
  db.payments = (db.payments || []).filter(p => p.from !== params.uid && p.to !== params.uid); save();
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
const addLog = (e, type, userId, by, amount) => { (e.log = e.log || []).push({ at: Date.now(), type, userId, by, amount }); };
const playerTotals = p => { const rebuys = (p.rebuys || []).reduce((a, r) => a + r.amount, 0); return { rebuys, total: p.buyIn + rebuys }; };
function evView(e, userId) {
  const players = e.players.map(p => {
    const u = db.users.find(x => x.id === p.userId);
    const rb = p.rebuys || [];
    return { userId: p.userId, name: u ? u.name : 'Removed player', buyIn: p.buyIn, ...playerTotals(p), joinedAt: p.joinedAt, lastRebuy: rb.length ? rb[rb.length - 1].amount : 0, cashOut: p.cashOut === undefined ? null : p.cashOut };
  });
  const nm = id => (db.users.find(x => x.id === id) || {}).name || 'Removed player';
  const log = (e.log || []).slice(-15).reverse().map(l => ({ at: l.at, type: l.type, amount: l.amount, who: nm(l.userId), by: l.by && l.by !== l.userId ? nm(l.by) : null }));
  return {
    id: e.id, title: e.title, date: e.date, time: e.time, location: e.location, minBuyIn: e.minBuyIn, maxSeats: e.maxSeats,
    status: e.status, startedAt: e.startedAt, players, pot: players.reduce((a, p) => a + p.total, 0), onTable: players.reduce((a, p) => a + p.total, 0) - players.reduce((a, p) => a + (p.cashOut || 0), 0),
    seatsLeft: e.maxSeats ? Math.max(0, e.maxSeats - players.length) : null,
    joined: players.some(p => p.userId === userId), log,
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
  e.players.push({ userId: user.id, buyIn, rebuys: [], joinedAt: Date.now() }); addLog(e, 'join', user.id, user.id, buyIn); save();
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

// A player can manage their own entry; the super user can manage anyone's. Everything is written to the activity log.
const entryTarget = (user, e, body) => {
  const uidTarget = body && body.userId ? body.userId : user.id;
  const isSuperUser = needSuperSoft(user);
  if (uidTarget !== user.id && !isSuperUser) throw new HttpError(403, 'You can only change your own entry');
  const p = e.players.find(x => x.userId === uidTarget);
  if (!p) throw new HttpError(404, uidTarget === user.id ? "You haven't joined this session" : 'Player not in this session');
  return p;
};
const needSuperSoft = user => { const l = theLobby(); return !!l && l.ownerId === user.id; };

route('POST', '/api/events/:id/rebuy', ({ user, params, body }) => {
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Rebuys open once the session is live');
  const p = entryTarget(user, e, body);
  if (p.cashOut !== undefined && p.cashOut !== null) throw new HttpError(400, 'Undo the cash-out first');
  const amount = posNum(body.amount);
  (p.rebuys = p.rebuys || []).push({ amount, at: Date.now() }); addLog(e, 'rebuy', p.userId, user.id, amount); save();
  return evView(e, user.id);
}, 'any');

route('DELETE', '/api/events/:id/rebuy/last', ({ user, params, body }) => {
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Session is not live');
  const p = entryTarget(user, e, body);
  if (p.cashOut !== undefined && p.cashOut !== null) throw new HttpError(400, 'Undo the cash-out first');
  if (!(p.rebuys || []).length) throw new HttpError(400, 'No rebuy to undo');
  const last = p.rebuys.pop(); addLog(e, 'undo', p.userId, user.id, last.amount); save();
  return evView(e, user.id);
}, 'any');

route('PUT', '/api/events/:id/entry', ({ user, params, body }) => {
  const e = findEvent(params.id);
  if (e.status !== 'upcoming' && e.status !== 'live') throw new HttpError(400, 'This event is closed');
  const p = entryTarget(user, e, body);
  if (p.cashOut !== undefined && p.cashOut !== null) throw new HttpError(400, 'Undo the cash-out first');
  const buyIn = posNum(body.buyIn);
  if (buyIn < e.minBuyIn) throw new HttpError(400, `Minimum buy-in is ${money(e.minBuyIn)}`);
  const old = p.buyIn; p.buyIn = buyIn; addLog(e, 'edit', p.userId, user.id, buyIn); save();
  return evView(e, user.id);
}, 'any');

// End the session: record cash-outs and save it as a normal game in everyone's history.
route('POST', '/api/events/:id/finish', ({ user, params, body }) => {
  const l = needSuper(user);
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Session is not live');
  const outs = body.cashOuts || {};
  const entries = e.players.map(p => { const given = outs[p.userId]; const v = (given !== undefined && given !== '' && given !== null) ? given : (p.cashOut || 0); return { userId: p.userId, buyIn: playerTotals(p).total, cashOut: num(v) }; });
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
  // A payment only counts while both people are in the lobby. Otherwise one side would be applied alone and the totals would skew.
  for (const p of (db.payments || [])) { if (p.from in bal && p.to in bal) { bal[p.from] += p.amount; bal[p.to] -= p.amount; } }
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
  const payments = (db.payments || []).filter(p => p.lobbyId === l.id && l.members.includes(p.from) && l.members.includes(p.to)).sort((a, b) => b.created - a.created).slice(0, 8)
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


// ---------- passwords: change, super-user reset, recovery code ----------
const revokeTokens = (userId, keep) => { for (const t of Object.keys(db.tokens)) if (db.tokens[t] === userId && t !== keep) delete db.tokens[t]; };
const checkNewPassword = pw => { if (String(pw || '').length < 4) throw new HttpError(400, 'Password must be at least 4 characters'); return String(pw); };

route('POST', '/api/me/password', ({ user, token, body }) => {
  if (!checkPw(user, String(body.current || ''))) throw new HttpError(400, 'Your current password is wrong');
  Object.assign(user, hashPw(checkNewPassword(body.password)));
  revokeTokens(user.id, token); save();
  return { ok: true };
}, 'any');

route('POST', '/api/users/:id/password', ({ user, params, body }) => {
  const l = needSuper(user);
  if (!l.members.includes(params.id)) throw new HttpError(404, 'Player not found');
  const target = db.users.find(u => u.id === params.id);
  if (!target) throw new HttpError(404, 'Player not found');
  Object.assign(target, hashPw(checkNewPassword(body.password)));
  revokeTokens(target.id, null); save();
  return { ok: true };
}, 'any');

// Emergency way back in (also for the super user): works only if RECOVERY_CODE is set on the server.
const recoverFails = []; // timestamps of recent failures on this server instance
route('POST', '/api/recover', async ({ body }) => {
  const code = process.env.RECOVERY_CODE;
  if (!code) throw new HttpError(403, 'Recovery is not set up on this server. Ask your host to reset your password.');
  const now = Date.now();
  while (recoverFails.length && now - recoverFails[0] > 10 * 60 * 1000) recoverFails.shift();
  if (recoverFails.length >= 5) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const a = Buffer.from(String(body.code || '')), b = Buffer.from(code);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  const target = findByLogin(body.username);
  if (!ok || !target) { recoverFails.push(now); await new Promise(r => setTimeout(r, 500)); throw new HttpError(400, 'Wrong username or recovery code'); }
  Object.assign(target, hashPw(checkNewPassword(body.password)));
  revokeTokens(target.id, null); save();
  return { ok: true };
});

// ---------- house rules / notes ----------
route('PUT', '/api/lobby/notes', ({ user, body }) => {
  const l = needSuper(user);
  l.notes = String(body.notes || '').slice(0, 2000); save();
  return { ok: true };
}, 'any');

// ---------- live cash-out (leave the table early) ----------
route('POST', '/api/events/:id/cashout', ({ user, params, body }) => {
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Cash-outs happen during a live session');
  const p = entryTarget(user, e, body);
  const amount = num(body.amount);
  const pot = e.players.reduce((a, x) => a + playerTotals(x).total, 0);
  const others = e.players.filter(x => x !== p).reduce((a, x) => a + (x.cashOut || 0), 0);
  if (amount > pot - others + 0.001) throw new HttpError(400, `There's only ${money(Math.max(0, pot - others))} left on the table`);
  p.cashOut = round2(amount); addLog(e, 'cashout', p.userId, user.id, p.cashOut); save();
  return evView(e, user.id);
}, 'any');
route('DELETE', '/api/events/:id/cashout', ({ user, params, body }) => {
  const e = findEvent(params.id);
  if (e.status !== 'live') throw new HttpError(400, 'Session is not live');
  const p = entryTarget(user, e, body);
  if (p.cashOut === undefined || p.cashOut === null) throw new HttpError(400, 'No cash-out to undo');
  const was = p.cashOut; p.cashOut = null; addLog(e, 'uncash', p.userId, user.id, was); save();
  return evView(e, user.id);
}, 'any');

// ---------- lightweight change counter so pages can refresh only when something changed ----------
route('GET', '/api/pulse', () => ({ rev: db.rev || 0, live: eventsList().some(e => e.status === 'live') }));

// ---------- request handling ----------
// reload=true re-reads the database on every request (needed on serverless, where instances don't share memory).
async function handle({ method, pathname, authorization, rawBody, reload }) {
  // On shared storage another instance may save first. Saves are conditional on the version we read,
  // so a clash is detected, we re-read the latest data, re-run the request, and try again.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, Math.random() * 25 * attempt)); // random backoff so racing requests spread out
    try {
      if (!loaded || reload || attempt > 0) {
        const r = await storage.load();
        db = r.db || { users: [], lobbies: [], sessions: [], tokens: {} };
        db.tokens = db.tokens || {}; version = r.version; loaded = true;
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
        const afters = [], after = fn => afters.push(fn);
        const out = await r.handler({ user, params, body, token, after });
        if (dirty) {
          dirty = false; db.rev = (db.rev || 0) + 1;
          if (!(await storage.save(db, version))) { loaded = false; throw new Conflict(); }
        }
        for (const fn of afters) await fn();               // e.g. send the email, only once the data is safely saved
        if (out && out.__err) return { status: out.status, body: { error: out.msg } };
        return { status: 200, body: out };
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      dirty = false;
      if (e instanceof Conflict) continue;
      if (!(e instanceof HttpError)) { console.error(e); loaded = false; }
      return { status: e.status || 500, body: { error: e.status ? e.message : 'Server error' } };
    }
  }
  return { status: 503, body: { error: 'Busy right now, please try again' } };
}
class Conflict extends Error {}

module.exports = { handle, setStorage, setMailer };
