import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { createDemoServer } from '../examples/chat/server.mjs';
import { interpretEvent, messageText, relayEvents } from '../examples/chat/events.js';

async function fixture(t, overrides = {}) {
  const calls = [];
  const client = {
    agents: { list: async () => ({ agents: [{ id: 'a1', name: 'Demo agent' }] }) },
    sessions: {
      create: async (...args) => { calls.push(['create', ...args]); return { session: { id: 's1', state: 'idle' } }; },
      retrieve: async id => ({ session: { id, state: 'completed', messages: [] } }),
      streamMessage: async function* (...args) { calls.push(['message', ...args]); yield { type: 'text-delta', id: 'm1', delta: 'Hi', stream_cursor: 'c1' }; yield { type: 'finish', final: true }; },
      resumeStream: async function* (...args) { calls.push(['resume', ...args]); yield { type: 'finish', finishReason: 'not_resumable' }; },
      cancel: async (...args) => { calls.push(['cancel', ...args]); return { session: { id: 's1', state: 'failed' } }; },
      resolveApprovals: async (...args) => { calls.push(['approvals', ...args]); return { session: { id: 's1', state: 'processing' }, results: [{ outcome: 'accepted' }] }; },
      ...overrides,
    },
  };
  const server = createDemoServer({ client });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, origin, request: (route, data, headers = {}) => fetch(origin + route, data === undefined ? { headers } : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }) };
}

test('demo serves static page and agents without disclosing configuration secrets', async t => {
  const { request } = await fixture(t);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Your agents, in your app/);
  assert.deepEqual(await (await request('/api/config')).json(), { configured: true });
  assert.equal((await (await request('/api/agents')).json()).agents[0].id, 'a1');
});

test('demo denies cross-origin writes and DNS rebinding hosts before calling SDK', async t => {
  const { request, calls, origin } = await fixture(t);
  assert.equal((await request('/api/sessions', { agentId: 'a1' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/sessions', { agentId: 'a1' }, { Origin: '' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => { const req = http.get(origin + '/api/agents', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(reboundStatus, 403);
  assert.equal((await request('/api/agents', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(calls.length, 0);
});

test('creating a session is idle; reconnect and Stop use distinct SDK operations', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('/api/sessions', { agentId: 'a1' })).status, 201);
  assert.deepEqual(calls[0], ['create', 'a1', {}]);
  const response = await request('/api/stream', { operation: 'resume', sessionId: 's1', cursor: 'last-cursor' });
  const events = [];
  for await (const event of relayEvents(response.body)) events.push(event);
  assert.equal(calls[1][0], 'resume');
  assert.equal(calls[1][2], 'last-cursor');
  assert.equal(events[0].data.finishReason, 'not_resumable');
  assert.equal(events.at(-1).type, 'transport-end');
  const cancelled = await (await request('/api/cancel', { sessionId: 's1' })).json();
  assert.equal(cancelled.session.state, 'failed');
  assert.equal(calls.at(-1)[0], 'cancel');
  assert.ok(!calls.some(call => call[0] === 'message'));
});

test('demo relays incremental data and does not invent a completed state at EOF', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/stream', { operation: 'message', sessionId: 's1', input: 'Hello' });
  const events = [];
  for await (const event of relayEvents(response.body)) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['stream', 'stream', 'transport-end']);
  assert.equal(events[0].data.delta, 'Hi');
  assert.equal(events[0].data.stream_cursor, 'c1');
  assert.equal(events.at(-1).data.state, undefined);
});

test('demo relays stream errors without replaying the message', async t => {
  let attempts = 0;
  const { request } = await fixture(t, { streamMessage: async function* () { attempts++; yield { type: 'text-delta', delta: 'Partial' }; throw new Error('Network went away'); } });
  const response = await request('/api/stream', { operation: 'message', sessionId: 's1', input: 'Hello' });
  const events = [];
  for await (const event of relayEvents(response.body)) events.push(event);
  assert.equal(events.at(-1).type, 'transport-error');
  assert.equal(events.at(-1).data.message, 'Network went away');
  assert.equal(attempts, 1);
});

test('approval responses preserve human input values', async t => {
  const { request, calls } = await fixture(t);
  const approval_responses = [{ action_request_id: 'ask1', action: 'accept', response: { values: { name: 'Sahaj' } } }];
  assert.equal((await request('/api/approvals', { sessionId: 's1', approval_responses })).status, 200);
  assert.deepEqual(calls[0], ['approvals', 's1', { approval_responses }]);
});

test('invalid messages and oversized requests never reach the SDK', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await request('/api/stream', { operation: 'message', sessionId: 's1', input: '' })).status, 400);
  assert.equal((await request('/api/sessions', { agentId: 'a'.repeat(70000) })).status, 413);
  assert.equal(calls.length, 0);
});

test('event interpretation preserves approval ambiguity and renders parts-based messages', () => {
  assert.equal(interpretEvent({ type: 'finish', final: false }).kind, 'other');
  assert.deepEqual(interpretEvent({ type: 'finish', final: true, finishReason: 'stop' }), { kind: 'finish' });
  assert.equal(messageText({ content: null, parts: [{ type: 'text', text: 'Hello' }, { type: 'tool-call', text: 'ignore' }, { type: 'text', text: ' world' }] }), 'Hello world');
  assert.equal(interpretEvent({ type: 'unknown', data: { delta: 'not text' } }).kind, 'other');
});

test('local relay reader handles fragmented UTF-8, comments and CRLF packets', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: stream\r\ndata: {"delta":"Hello 🌎"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1)); controller.close(); } });
  const events = [];
  for await (const event of relayEvents(stream)) events.push(event);
  assert.deepEqual(events, [{ type: 'stream', data: { delta: 'Hello 🌎' } }]);
});
