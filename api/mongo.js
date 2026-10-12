import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';

export function mongoSettings() {
  const password = process.env.MONGODB_PASSWORD;
  const uri = process.env.MONGODB_URI || (password && `mongodb+srv://projectnoscd_db_user:${encodeURIComponent(password)}@cluster0.chopred.mongodb.net/?appName=Cluster0`);
  if (!uri || uri.includes('<db_password>')) throw new Error('Set MONGODB_PASSWORD or MONGODB_URI in .env');
  return {
    client: new MongoClient(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 15000 }),
    database: process.env.MONGODB_DATABASE || 'NOSCD',
    collection: process.env.MONGODB_COLLECTION || 'page_data',
  };
}


export const requiredFiles = ['Date.txt', 'headerSidereal.txt', 'headerTracking.txt',
  'Satellite_Tracking.png', 'Sidereal_Tracking.png', 'TLE_Update.txt', 'TLE.txt', 'TLEPNG.txt',
  'TLE Graph - Inclination (deg).csv', 'TLE Graph - RAAN (deg).csv',
  'TLE Graph - Eccentricity.csv', 'TLE Graph - Argument of Perigee (deg).csv',
  'TLE Graph - Mean Anomaly (deg).csv', 'TLE Graph - Mean Motion (rev_day).csv'];
const dataFiles = new Set(requiredFiles);

export function createLiveUpdates(collection) {
  const clients = new Set();
  let stream, retry, closed = false, resumeToken;
  const notify = id => {
    const message = `data: ${JSON.stringify({ snapshot: String(id) })}\n\n`;
    for (const res of clients) {
      if (res.destroyed) clients.delete(res);
      else if (!res.write(message)) res.end();
    }
  };
  const restart = (resetToken = false) => {
    if (closed || retry) return;
    resumeToken = resetToken ? undefined : stream?.resumeToken || resumeToken;
    void stream?.close().catch(() => {});
    // Reconnecting browsers re-read the latest ID to catch up on missed inserts.
    for (const res of clients) res.end();
    console.error('MongoDB live updates disconnected; reconnecting.');
    retry = setTimeout(() => { retry = undefined; start(); }, 3000);
    retry.unref();
  };
  const start = () => {
    if (closed) return;
    try {
      stream = collection.watch([
        { $match: { operationType: 'insert' } },
        { $project: { _id: 1, documentKey: 1, operationType: 1 } },
      ], resumeToken ? { resumeAfter: resumeToken } : {});
      stream.on('change', change => notify(change.documentKey._id));
      stream.on('error', error => {
        // An expired resume token requires a fresh stream; browser reconnect catches up.
        restart([260, 280, 286].includes(error.code));
      });
    } catch { restart(); }
  };
  start();
  return {
    async subscribe(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      clients.add(res);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 25000);
      heartbeat.unref();
      res.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
      try {
        const latest = await collection.findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } });
        if (latest && !res.destroyed) res.write(`data: ${JSON.stringify({ snapshot: String(latest._id) })}\n\n`);
      } catch { res.end(); }
    },
    async close() {
      closed = true;
      clearTimeout(retry);
      for (const res of clients) res.end();
      clients.clear();
      await stream?.close();
    },
  };
}




// Literal field access is required because filenames contain dots.
export function fieldHistory(collection, name) {
  return collection.aggregate([
    { $sort: { _id: -1 } },
    { $project: { _id: 1, value: { $getField: { field: { $literal: name }, input: '$$ROOT' } } } },
    { $match: { value: { $ne: null, $exists: true } } },
  ]);
}

const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
export function csvDay(raw) {
  const value = raw.trim();
  let year, month, day;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(value);
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(value);
    if (!match) throw new Error('CSV date must be YYYY-MM-DD or D Month YYYY');
    day = Number(match[1]); month = months.indexOf(match[2].toLowerCase()) + 1; year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Invalid CSV date');
  return date.toISOString().slice(0, 10);
}

export async function latestField(collection, name) {
  const cursor = fieldHistory(collection, name);
  try {
    for await (const document of cursor) {
      const value = document.value;
      if (name.endsWith('.png')) {
        if (Buffer.isBuffer(value) ? value.length : value?._bsontype === 'Binary' && value.value(true).length) return value;
      } else if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
  } finally { await cursor.close(); }
}

export async function latestCsv(collection, name) {
  const days = new Map();
  const cursor = fieldHistory(collection, name);
  try {
    for await (const document of cursor) {
      if (typeof document.value !== 'string' || !document.value.trim()) continue;
      const lines = document.value.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      // Within one import the last row for a day wins; newer imports win over older ones.
      const current = new Map();
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cells = line.split(',').map(cell => cell.trim().replace(/^"(.*)"$/, '$1'));
        if (cells.length !== 2 || !cells[1] || !Number.isFinite(Number(cells[1]))) throw new Error('Invalid CSV value');
        current.set(csvDay(cells[0]), cells[1]);
      }
      for (const [day, value] of current) if (!days.has(day)) days.set(day, value);
    }
  } finally { await cursor.close(); }
  const rows = [...days].sort(([a], [b]) => a.localeCompare(b)).slice(-10);
  return rows.length ? 'DATE,value\n' + rows.map(row => row.join(',')).join('\n') + '\n' : null;
}

// Field positions follow https://celestrak.org/NORAD/documentation/tle-fmt.php
export function parseDailyTle(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trimEnd());
  const first = lines.filter(line => line.startsWith('1 '));
  const second = lines.filter(line => line.startsWith('2 '));
  if (first.length !== 1 || second.length !== 1) throw new Error('Expected one TLE pair');
  const [line1] = first, [line2] = second;
  if (line1.length < 32 || line2.length < 63 || line1.slice(2,7) !== line2.slice(2,7)) throw new Error('Invalid TLE pair');
  const epoch = line1.slice(18,32);
  if (!/^\d{5}\.\d{8}$/.test(epoch)) throw new Error('Invalid TLE epoch');
  const yy = Number(epoch.slice(0,2));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const day = Number(epoch.slice(2));
  const yearStart = Date.UTC(year,0,1), nextYear = Date.UTC(year+1,0,1);
  if (day < 1 || day >= (nextYear-yearStart)/86400000 + 1) throw new Error('Invalid TLE epoch day');
  const instant = new Date(yearStart + (day-1)*86400000);
  const number = (start,end) => {
    const raw = line2.slice(start,end).trim();
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('Invalid TLE orbital value');
    return Number(raw);
  };
  const eccentricity = line2.slice(26,33);
  if (!/^\d{7}$/.test(eccentricity)) throw new Error('Invalid TLE eccentricity');
  const values = [number(8,16), number(17,25), Number('0.'+eccentricity), number(34,42), number(43,51), number(52,63)];
  if (values[0] > 180 || values[1] >= 360 || values[3] >= 360 || values[4] >= 360 || values[5] <= 0) throw new Error('TLE values out of range');
  return { date: instant.toISOString().slice(0,10), epoch: instant.toISOString(), values };
}

export async function latestTleHistory(collection) {
  const days = new Map(); let skipped = 0;
  const cursor = fieldHistory(collection, 'TLE.txt');
  try {
    for await (const document of cursor) {
      if (typeof document.value !== 'string' || !document.value.trim()) continue;
      let row;
      try { row = parseDailyTle(document.value); } catch { skipped++; continue; }
      // Newest import wins for an epoch date; missing dates remain missing.
      if (!days.has(row.date)) days.set(row.date, row);
    }
  } finally { await cursor.close(); }
  return { source: 'TLE.txt', skipped, rows: [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-10) };
}

export function createHandler(collection, liveUpdates) {
  return async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8', headers = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    const origin = req.headers?.origin;
    const origins = (process.env.CORS_ORIGINS || '*').split(',').map(value => value.trim()).filter(Boolean);
    if (origin && !origins.includes('*') && !origins.includes(origin)) return send(403, 'Origin not allowed');
    res.setHeader('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin || origins[0] || '');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' });
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return send(400, 'Invalid URL'); }
    if (pathname === '/healthz') return send(200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
    if (pathname === '/api/events') {
      if (req.method === 'HEAD') return send(405, 'Use GET for live updates');
      if (!liveUpdates) return send(503, 'Live updates unavailable');
      return liveUpdates.subscribe(req, res);
    }
    if (pathname === '/api/tle-history') {
      try { return send(200, JSON.stringify(await latestTleHistory(collection)), 'application/json; charset=utf-8'); }
      catch { return send(503, 'MongoDB TLE history is unavailable.'); }
    }
    if (pathname.startsWith('/api/files/')) {
      const name = pathname.slice('/api/files/'.length);
      if (!dataFiles.has(name)) return send(404, 'Unknown data field');
      try {
        const value = name.endsWith('.csv')
          ? await latestCsv(collection, name) : await latestField(collection, name);
        if (value == null) return send(404, 'MongoDB data field is missing');
        let body;
        if (name.endsWith('.png')) {
          if (Buffer.isBuffer(value)) body = value;
          else if (value?._bsontype === 'Binary') body = Buffer.from(value.value(true));
          else return send(502, 'Invalid MongoDB image data');
        } else {
          if (typeof value !== 'string') return send(502, 'Invalid MongoDB text data');
          body = Buffer.from(value);
        }
        const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
        return send(200, body, name.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8', { ETag: etag });
      } catch {
        return send(503, 'MongoDB is unavailable. Check server connection settings.');
      }
    }
    return send(404, 'Not found');
  };
}

