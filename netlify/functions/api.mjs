// Netlify Function: serves /api/* using the shared core, storing data in Netlify Blobs.
import { createRequire } from 'node:module';
import { getStore } from '@netlify/blobs';
const require = createRequire(import.meta.url);
const { handle, setStorage } = require('../../core.js');

setStorage({
  async load() { return getStore({ name: 'poker', consistency: 'strong' }).get('db', { type: 'json' }); },
  async save(db) { await getStore({ name: 'poker', consistency: 'strong' }).setJSON('db', db); },
});

export default async (req) => {
  const r = await handle({
    method: req.method,
    pathname: new URL(req.url).pathname,
    authorization: req.headers.get('authorization'),
    rawBody: req.method === 'GET' ? '' : await req.text(),
    reload: true, // serverless instances don't share memory: always read the latest data
  });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/*' };
