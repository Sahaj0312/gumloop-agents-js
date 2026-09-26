import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Gumloop } from '../dist/index.js';
import { createWidgetServer } from '../widget/server.mjs';

test('real SDK and public widget isolate visitors and strip privileged data end to end', async t => {
  const upstreamCalls = [];
  const sessions = new Map();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    upstreamCalls.push({ method: req.method, path: req.url, body });
    assert.equal(req.headers.authorization, 'Bearer internal-test-secret');
    let result;
    if (req.url === '/agents/website-agent/sessions' && req.method === 'POST') {
      assert.equal(body.input, undefined);
      const id = `upstream-${sessions.size + 1}`;
      const session = { id, agent_id: 'website-agent', state: 'idle', messages: [], pending_approvals: [] };
      sessions.set(id, session); result = { session };
    } else {
      const match = /^\/sessions\/([^/]+)(?:\/(messages|cancel|approvals))?$/.exec(req.url);
      const session = match && sessions.get(match[1]);
      if (!session) { res.writeHead(404); res.end('{}'); return; }
      if (match[2] === 'messages') {
        session.state = 'completed';
        session.messages = [{ role: 'system', content: 'PRIVATE_INSTRUCTIONS' }, { role: 'user', content: body.input }, { role: 'assistant', parts: [{ type: 'text', text: 'Welcome!' }, { type: 'tool_invocation', args: 'PRIVATE_TOOL_DATA' }] }];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: text-delta\ndata: {"type":"text-delta","delta":"Welcome!","stream_cursor":"private-cursor"}\n\nevent: tool-result\ndata: {"type":"tool-result","output":"PRIVATE_TOOL_DATA"}\n\nevent: finish\ndata: {"type":"finish","final":true}\n\n');
        return;
      }
      if (match[2] === 'cancel') session.state = 'failed';
      result = { session };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const client = new Gumloop({ apiKey: 'internal-test-secret', userId: 'internal-user', baseUrl: `http://127.0.0.1:${upstream.address().port}`, streamBaseUrl: `http://127.0.0.1:${upstream.address().port}` });
  const widget = createWidgetServer({ client, widgets: {
    demo: { agentId: 'website-agent', allowedOrigins: ['https://site.example', 'https://second.example'] },
    another: { agentId: 'website-agent', allowedOrigins: ['https://site.example'] },
  } });
  widget.listen(0, '127.0.0.1'); await once(widget, 'listening');
  t.after(() => { widget.closeAllConnections(); widget.close(); });
  const base = `http://127.0.0.1:${widget.address().port}`;
  async function call(path, { method = 'GET', token, body, origin = 'https://site.example' } = {}) {
    return fetch(`${base}/v1/widgets/${path}`, { method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const a = (await (await call('demo/visitors', { method: 'POST', body: {} })).json()).visitorToken;
  const b = (await (await call('demo/visitors', { method: 'POST', body: {} })).json()).visitorToken;
  assert.notEqual(a, b);
  const created = await call('demo/sessions', { method: 'POST', token: a, body: {} });
  const { sessionId } = await created.json();
  assert.equal(created.status, 201);
  assert.notEqual(sessionId, 'upstream-1');
  const before = upstreamCalls.length;
  for (const action of ['', '/messages', '/cancel', '/approvals']) {
    const result = await call(`demo/sessions/${sessionId}${action}`, { method: action ? 'POST' : 'GET', token: b, ...(action ? { body: action === '/messages' ? { input: 'stolen' } : {} } : {}) });
    assert.equal(result.status, 404);
  }
  assert.equal(upstreamCalls.length, before, 'cross-visitor attempts must not reach Gumloop');
  assert.equal((await call(`demo/sessions/${sessionId}`, { token: a, origin: 'https://second.example' })).status, 401);
  assert.equal((await call('another/sessions', { method: 'POST', token: a, body: {} })).status, 401);
  assert.equal((await call('demo/sessions/upstream-1', { token: a })).status, 404);
  assert.equal((await call('demo/sessions', { method: 'POST', token: a, body: { agentId: 'private-agent' } })).status, 400);

  const streamed = await call(`demo/sessions/${sessionId}/messages`, { method: 'POST', token: a, body: { input: 'Hello' } });
  const streamText = await streamed.text();
  assert.match(streamText, /Welcome!/);
  for (const secret of ['PRIVATE_TOOL_DATA', 'private-cursor', 'internal-test-secret']) assert.ok(!streamText.includes(secret));
  const retrieved = await (await call(`demo/sessions/${sessionId}`, { token: a })).json();
  assert.deepEqual(retrieved.session.messages, [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Welcome!' }]);
  assert.equal(retrieved.session.id, sessionId);
  assert.ok(!JSON.stringify(retrieved).includes('website-agent'));

  const own = sessions.get('upstream-1');
  own.state = 'approval_required';
  own.pending_approvals = [{ action_request_id: 'private-approval', type: 'tool_approval', title: 'PRIVATE_ACTION_TITLE', recipient_user_id: 'internal-user' }];
  const gated = await (await call(`demo/sessions/${sessionId}`, { token: a })).json();
  assert.equal(gated.session.owner_intervention_required, true);
  assert.deepEqual(gated.session.pending_approvals, []);
  assert.ok(!JSON.stringify(gated).includes('PRIVATE_ACTION_TITLE'));
  const callsBeforeApproval = upstreamCalls.length;
  const forbidden = await call(`demo/sessions/${sessionId}/approvals`, { method: 'POST', token: a, body: { approval_responses: [{ action_request_id: 'private-approval', action: 'accept' }] } });
  assert.equal(forbidden.status, 403);
  assert.ok(upstreamCalls.slice(callsBeforeApproval).every(c => c.method === 'GET'), 'no privileged approval mutation');
  const bypass = await call(`demo/sessions/${sessionId}/messages`, { method: 'POST', token: a, body: { input: 'just do it' } });
  assert.equal(bypass.status, 409);
});
