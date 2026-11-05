// Poker Hissab — zero-dependency Node server. Run: node server.js
// Storage: data.json in DATA_DIR (default: this folder), or Upstash Redis if UPSTASH_REDIS_REST_URL/TOKEN are set.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle, setStorage } = require('./core');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname; // on Render: the mounted disk, e.g. /data
const PUBLIC = path.join(__dirname, 'public');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (REDIS_URL) {
  const redis = cmd => fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(cmd) }).then(r => r.json());
  setStorage({
    async load() { const r = await redis(['GET', 'pokerdb']); if (r.error) throw new Error('Redis: ' + r.error); return { db: r.result ? JSON.parse(r.result) : null, version: null }; },
    async save(db) { const r = await redis(['SET', 'pokerdb', JSON.stringify(db)]); if (r.error) throw new Error('Redis: ' + r.error); return true; },
  });
  console.log('Storage: Upstash Redis');
} else {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'data.json');
  setStorage({
    async load() { return { db: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null, version: null }; },
    async save(db) { fs.writeFileSync(file, JSON.stringify(db, null, 2)); return true; },
  });
  console.log('Storage:', file);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    let f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(f).pipe(res);
  }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    const r = await handle({ method: req.method, pathname: url.pathname, authorization: req.headers.authorization, rawBody: raw });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
}).listen(PORT, () => console.log(`Poker Hissab running on http://localhost:${PORT}`));
