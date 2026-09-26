import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const publicDir = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/events.js', ['events.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Use application/json.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw fail(413, 'Request exceeds 64 KB.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw fail(400, 'Expected a JSON object.'); }
}
function required(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, `Invalid ${name}.`);
  return value;
}

/** Injectable client keeps server security and routing testable without real credentials. */
export function createDemoServer({ client, configured = Boolean(client) } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      // Restrict Host as well as Origin: DNS rebinding must not turn a public website
      // into a client for this credential-bearing local server.
      const expectedHost = `127.0.0.1:${req.socket.localPort}`;
      const localhostHost = `localhost:${req.socket.localPort}`;
      if (req.headers.host !== expectedHost && req.headers.host !== localhostHost) throw fail(403, 'Unrecognized local host.');
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw fail(403, 'Cross-origin requests are not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': type });
        res.end(content);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { configured });
      if (!client) throw fail(503, 'Configure GUMLOOP_API_KEY and GUMLOOP_USER_ID on the server, then restart.');
      if (req.method === 'GET' && url.pathname === '/api/agents') return json(res, 200, await client.agents.list());
      if (req.method === 'GET' && url.pathname === '/api/session') {
        return json(res, 200, await client.sessions.retrieve(required(url.searchParams.get('id'), 'session ID')));
      }
      if (req.method !== 'POST') throw fail(404, 'Route not found.');
      // Browser writes must carry Origin; a same-origin JSON fetch does so.
      if (req.headers.origin !== origin) throw fail(403, 'A same-origin Origin header is required.');
      const input = await body(req);
      if (url.pathname === '/api/sessions') {
        // Create an idle session first. The browser knows its ID before starting a
        // billable task, so a disconnect never requires resubmitting that task.
        return json(res, 201, await client.sessions.create(required(input.agentId, 'agent ID'), {}));
      }
      const sessionId = required(input.sessionId, 'session ID');
      if (url.pathname === '/api/cancel') return json(res, 200, await client.sessions.cancel(sessionId));
      if (url.pathname === '/api/approvals') {
        if (!Array.isArray(input.approval_responses) || input.approval_responses.length < 1 || input.approval_responses.length > 20) throw fail(400, 'Provide 1–20 approval responses.');
        return json(res, 200, await client.sessions.resolveApprovals(sessionId, { approval_responses: input.approval_responses }));
      }
      if (url.pathname !== '/api/stream') throw fail(404, 'Route not found.');
      if (!['message', 'resume'].includes(input.operation)) throw fail(400, 'Unknown stream operation.');
      const controller = new AbortController();
      const iterator = input.operation === 'resume'
        ? client.sessions.resumeStream(sessionId, required(input.cursor, 'stream cursor', 4096), { signal: controller.signal })
        : client.sessions.streamMessage(sessionId, { input: required(input.input, 'message', 32000) }, { signal: controller.signal });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const emit = (type, data) => !res.destroyed && res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const onClose = () => controller.abort();
      res.on('close', onClose);
      const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
      try {
        for await (const event of iterator) {
          emit('stream', event);
        }
        emit('transport-end', { message: 'Stream ended. Fetch the session to verify its current state.' });
      } catch (error) {
        if (!controller.signal.aborted) emit('transport-error', { message: error.message || 'Stream failed.', status: error.status });
      } finally {
        clearInterval(keepAlive);
        res.off('close', onClose);
        if (!res.destroyed) res.end();
      }
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      if (!res.headersSent) json(res, status, { error: error.message || 'Request failed.' });
      else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Only load this repository's .env, never parent files implicitly.
  try { process.loadEnvFile(path.resolve(publicDir, '../../.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const configured = Boolean(process.env.GUMLOOP_API_KEY || process.env.GUMLOOP_ACCESS_TOKEN);
  let client;
  if (configured) {
    const { Gumloop } = await import('../../dist/index.js');
    client = new Gumloop({ apiKey: process.env.GUMLOOP_API_KEY, accessToken: process.env.GUMLOOP_ACCESS_TOKEN, userId: process.env.GUMLOOP_USER_ID, teamId: process.env.GUMLOOP_TEAM_ID });
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  createDemoServer({ client, configured }).listen(port, '127.0.0.1', () => {
    console.log(`Gumloop Agents demo: http://127.0.0.1:${port}${configured ? '' : ' (credentials not configured)'}`);
  });
}
