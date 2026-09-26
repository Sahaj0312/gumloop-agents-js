import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { Gumloop } from '../dist/index.js';
import { createDemoServer } from '../examples/chat/server.mjs';
import { relayEvents } from '../examples/chat/events.js';

test('browser disconnect closes upstream SSE; explicit recovery uses GET without resending or cancelling', { timeout: 10000 }, async t => {
  const requests = [];
  let streamClosed;
  const closed = new Promise(resolve => { streamClosed = resolve; });
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.method === 'POST') {
      res.on('close', streamClosed);
      res.write('data: {"type":"text-delta","id":"m1","delta":"Hello 🌎","stream_cursor":"cursor-1"}\n\n');
      // Leave the response open to model a running remote task.
    } else {
      res.end('data: {"type":"finish","final":true,"finishReason":"not_resumable"}\n\n');
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/api/v1`;
  const client = new Gumloop({ accessToken: 'synthetic-test-token', baseUrl, streamBaseUrl: baseUrl });
  const relay = createDemoServer({ client });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const origin = `http://127.0.0.1:${relay.address().port}`;
  const post = (body, signal) => fetch(`${origin}/api/stream`, {
    method: 'POST', signal, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const controller = new AbortController();
  const response = await post({ operation: 'message', sessionId: 's1', input: 'Hello' }, controller.signal);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /Hello 🌎/);
  controller.abort();
  try { await reader.cancel(); } catch { /* Aborted fetch bodies can reject cancellation. */ }
  reader.releaseLock();
  await closed;
  assert.equal(requests.length, 1, 'disconnect must not trigger another request');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), { input: 'Hello', stream: true });

  const resumed = await post({ operation: 'resume', sessionId: 's1', cursor: 'cursor-1' });
  const events = [];
  for await (const event of relayEvents(resumed.body)) events.push(event);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, 'GET');
  const resumedUrl = new URL(requests[1].url, baseUrl);
  assert.equal(resumedUrl.pathname, '/api/v1/sessions/s1');
  assert.equal(resumedUrl.searchParams.get('last_cursor'), 'cursor-1');
  assert.equal(resumedUrl.searchParams.get('stream'), 'true');
  assert.equal(requests[1].body, '');
  assert.equal(events[0].data.finishReason, 'not_resumable');
  assert.equal(events.at(-1).type, 'transport-end');
  assert.ok(requests.every(request => !request.url.includes('/cancel')));
});
