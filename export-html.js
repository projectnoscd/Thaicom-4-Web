import { loadEnvFile } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { mongoSettings, latestField, latestCsv, latestTleHistory, requiredFiles } from './api/mongo.js';

try { loadEnvFile(new URL('.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const settings = mongoSettings();
try {
  const collection = settings.client.db(settings.database).collection(settings.collection);
  const snapshot = {};
  for (const name of requiredFiles) {
    const value = name.endsWith('.csv')
      ? await latestCsv(collection, name) : await latestField(collection, name);
    if (value == null) continue;
    const bytes = name.endsWith('.png')
      ? (Buffer.isBuffer(value) ? value : Buffer.from(value.value(true))) : Buffer.from(value);
    snapshot['/api/files/' + name] = {
      body: bytes.toString('base64'), type: name.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8',
    };
  }
  snapshot['/api/tle-history'] = {
    body: Buffer.from(JSON.stringify(await latestTleHistory(collection))).toString('base64'),
    type: 'application/json; charset=utf-8',
  };
  let html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  html = html.replace(/<script id="embedded-data" type="application\/json">[\s\S]*?<\/script>\s*/g, '');
  html = html.replace('<script>', `<script id="embedded-data" type="application/json">${JSON.stringify(snapshot).replace(/</g, '\\u003c')}</script>\n    <script>`);
  for (const match of [...html.matchAll(/<script src="(https:\/\/[^\"]+)"><\/script>/g)]) {
    const response = await fetch(match[1], { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Unable to bundle ${match[1]}: HTTP ${response.status}`);
    const source = (await response.text()).replace(/<\/script/gi, '<\\/script');
    html = html.replace(match[0], () => `<script>${source}</script>`);
  }
  for (const name of ['logonarit.webp', 'logospoc.webp']) {
    const bytes = await readFile(new URL(name, import.meta.url));
    html = html.replaceAll(name, 'data:image/webp;base64,' + bytes.toString('base64'));
  }
  await writeFile(new URL('thaicom-with-data.html', import.meta.url), html);
  await writeFile(new URL('index.html', import.meta.url), html);
  console.log('Created thaicom-with-data.html with current MongoDB data and images.');
} finally { await settings.client.close(); }
