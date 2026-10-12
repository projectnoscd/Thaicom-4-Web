import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { mongoSettings, createHandler as createMongoHandler, createLiveUpdates, requiredFiles } from './api/mongo.js';

try {
  loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

let backend;
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/thaicom_4_satellite_tracking_page.html': ['index.html', 'text/html; charset=utf-8'],
  '/logonarit.webp': ['logonarit.webp', 'image/webp'],
  '/logospoc.webp': ['logospoc.webp', 'image/webp'],
};
function getBackend() {
  if (!backend) {
    const settings = mongoSettings();
    const collection = settings.client.db(settings.database).collection(settings.collection);
    const liveUpdates = createLiveUpdates(collection);
    backend = {
      handler: createMongoHandler(collection, liveUpdates),
      async close() {
        await liveUpdates.close();
        await settings.client.close();
      },
    };
  }
  return backend;
}

export function createHandler(resolveBackend = getBackend) {
  return async (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); return res.end('Invalid URL'); }
    const asset = assets[pathname];
    if (asset) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end('Method not allowed');
      }
      try {
        const body = await readFile(new URL(asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      } catch { res.writeHead(500); return res.end('Unable to load asset'); }
    }
    if (pathname === '/healthz') return createMongoHandler(undefined)(req, res);
    const knownPath = pathname === '/api/events' || pathname === '/api/tle-history'
      || (pathname.startsWith('/api/files/') && requiredFiles.includes(pathname.slice('/api/files/'.length)));
    if (!knownPath) { res.writeHead(404); return res.end('Not found'); }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
      return res.end('Method not allowed');
    }
    try { await resolveBackend().handler(req, res); }
    catch {
      if (res.headersSent) return res.end();
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'MongoDB is unavailable. Check server connection settings.' }));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3002);
  const displayHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host;
  const server = http.createServer(createHandler());
  server.listen(port, host, () => console.log(`Open http://${displayHost}:${port}`));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void backend?.close().catch(() => { process.exitCode = 1; });
  });
}
