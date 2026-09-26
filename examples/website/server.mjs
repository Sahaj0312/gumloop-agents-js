import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const widgetOrigin = new URL(process.env.WIDGET_ORIGIN || 'http://127.0.0.1:3001').origin;
const port = Number(process.env.WEBSITE_PORT || 3100);
if (!/^https?:/.test(widgetOrigin)) throw new Error('WIDGET_ORIGIN must use HTTP or HTTPS');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WEBSITE_PORT');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/site.css', ['site.css', 'text/css; charset=utf-8']],
  ['/site.js', ['site.js', 'text/javascript; charset=utf-8']],
]);
http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  const asset = assets.get(route);
  if (req.method !== 'GET' || !asset) { res.writeHead(404); res.end('Not found'); return; }
  try {
    let body = await readFile(path.join(directory, asset[0]), 'utf8');
    if (route === '/') body = body.replaceAll('__WIDGET_ORIGIN__', widgetOrigin);
    res.writeHead(200, { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch { res.writeHead(500); res.end('Could not load example website'); }
}).listen(port, '127.0.0.1', () => console.log(`Example website: http://127.0.0.1:${port}`));
