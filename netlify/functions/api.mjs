// Netlify Function: serves /api/* using the shared core, storing data in Netlify Blobs.
// Saves are conditional on the version (ETag) that was read, so simultaneous requests can't overwrite each other.
import { createRequire } from 'node:module';
import { getStore } from '@netlify/blobs';
const require = createRequire(import.meta.url);
const { handle, setStorage } = require('../../core.js');

const store = () => getStore({ name: 'poker', consistency: 'strong' });
setStorage({
  async load() {
    const r = await store().getWithMetadata('db', { type: 'json' });
    return r ? { db: r.data, version: r.etag } : { db: null, version: null };
  },
  async save(db, version) {
    const r = await store().setJSON('db', db, version ? { onlyIfMatch: version } : { onlyIfNew: true });
    return r.modified;
  },
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
