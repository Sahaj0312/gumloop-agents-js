import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWidgetServer } from '../widget/server.mjs';
import { createMemoryStore, createFileStore } from '../widget/store.mjs';

const origin = 'http://127.0.0.1:3100';
const otherOrigin = 'http://localhost:3100';
const widget = { agentId: 'private-agent-id', allowedOrigins: [origin, otherOrigin], title: 'Help', welcome: 'Hello', accent: '#112233' };
function mockClient() {
  const sessions = new Map();
  const calls = [];
  let serial = 0;
  return { sessions, calls, client: { sessions: {
    async create(agentId, body) { calls.push(['create', agentId, body]); const session = { id: `private-session-${++serial}`, agent_id: agentId, state: 'idle', messages: [], pending_approvals: [] }; sessions.set(session.id, session); return { session: structuredClone(session) }; },
    async retrieve(id) { calls.push(['retrieve', id]); return { session: structuredClone(sessions.get(id)) }; },
    async *streamMessage(id, body, { signal }) { calls.push(['stream', id, body]); const session = sessions.get(id); session.state = 'processing'; session.messages.push({ role: 'user', content: body.input }); yield { type: 'tool-call', input: 'private tool data' }; yield { type: 'text-delta', delta: 'nested secret', parentToolCallId: 'private-tool' }; yield { type: 'text-delta', delta: 'Hello visitor' }; if (signal.aborted) throw new Error('abort'); session.state = 'completed'; session.messages.push({ role: 'assistant', parts: [{ type: 'text', text: 'Hello visitor' }] }); yield { type: 'finish', final: true }; },
    async cancel(id) { calls.push(['cancel', id]); sessions.get(id).state = 'failed'; return { session: { id, state: 'failed' } }; },
    async resolveApprovals(id, request) { calls.push(['approve', id, request]); const session = sessions.get(id); session.pending_approvals = []; session.state = 'processing'; return { session }; },
  } } };
}
async function setup(t, options = {}) {
  const mock = mockClient();
  const server = createWidgetServer({ client: mock.client, widgets: { demo: widget, second: widget }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', token, body, origin: requestOrigin = origin, headers = {} } = {}) {
    return fetch(`${base}${route}`, { method, headers: { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  async function visitor(widgetId = 'demo', requestOrigin = origin) { const response = await request(`/v1/widgets/${widgetId}/visitors`, { method: 'POST', body: {}, origin: requestOrigin }); assert.equal(response.status, 201); return (await response.json()).visitorToken; }
  async function conversation(token) { const response = await request('/v1/widgets/demo/sessions', { method: 'POST', body: {}, token }); assert.equal(response.status, 201); return (await response.json()).sessionId; }
  return { ...mock, server, base, request, visitor, conversation };
}

test('config CORS is exact, rejects missing/null/foreign origins, and hides agent identifiers', async t => {
  const { request, base } = await setup(t);
  const response = await request('/v1/widgets/demo/config');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await response.json(), { title: 'Help', welcome: 'Hello', accent: '#112233', position: 'right' });
  for (const value of [undefined, 'null', 'https://evil.example', origin + '.evil.example']) {
    const bad = await request('/v1/widgets/demo/config', { origin: value ?? '' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  }
  const options = await request('/v1/widgets/demo/sessions', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers'), /Authorization/);
  const { get } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    get(`${base}/v1/widgets/demo/config`, { headers: { Host: 'evil.example', Origin: origin } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('visitor token is random and hashed; client cannot select upstream agent or session', async t => {
  const store = createMemoryStore();
  const { visitor, conversation, request, calls } = await setup(t, { store });
  const token = await visitor();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(await store.getVisitor(token), undefined);
  const saved = await store.getVisitor(createHash('sha256').update(token).digest('hex'));
  assert.equal(saved.widgetId, 'demo'); assert.equal(saved.origin, origin);
  const sessionId = await conversation(token);
  assert.match(sessionId, /^chat_[a-f0-9]{48}$/);
  assert.notEqual(sessionId, calls[0]?.[1]);
  const attempts = [{ agentId: 'private' }, { session_id: 'victim' }, { input: 'Spend credits' }];
  for (const body of attempts) assert.equal((await request('/v1/widgets/demo/sessions', { method: 'POST', token, body })).status, 400);
  assert.deepEqual(calls.filter(call => call[0] === 'create'), [['create', 'private-agent-id', {}]]);
});

test('every conversation action denies another visitor before any upstream call', async t => {
  const { visitor, conversation, request, calls } = await setup(t);
  const owner = await visitor(); const attacker = await visitor();
  const id = await conversation(owner);
  const count = calls.length;
  for (const [suffix, method, body] of [['', 'GET'], ['/messages', 'POST', { input: 'Hi' }], ['/cancel', 'POST', {}], ['/approvals', 'POST', { approval_responses: [] }]]) {
    assert.equal((await request(`/v1/widgets/demo/sessions/${id}${suffix}`, { method, body, token: attacker })).status, 404);
  }
  assert.equal(calls.length, count);
  assert.equal((await request(`/v1/widgets/second/sessions/${id}`, { token: owner })).status, 401);
  assert.equal((await request(`/v1/widgets/demo/sessions/${id}`, { token: owner, origin: otherOrigin })).status, 401);
  assert.equal((await request('/v1/widgets/demo/sessions/private-session-1', { token: owner })).status, 404);
});

test('snapshot exposes only visitor transcript and human questions', async t => {
  const { visitor, conversation, request, sessions } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  Object.assign(sessions.get('private-session-1'), {
    state: 'approval_required', creator: { email: 'private@example.test' }, usage: { tokens: 9 },
    messages: [{ role: 'system', content: 'SYSTEM SECRET' }, { role: 'tool', content: 'TOOL SECRET' }, { role: 'developer', content: 'DEVELOPER SECRET' }, { role: 'user', content: 'Question' }, { role: 'assistant', content: null, parts: [{ type: 'reasoning', text: 'REASONING SECRET' }, { type: 'tool_invocation', result: 'INVOCATION SECRET' }, { type: 'text', text: 'Answer' }] }],
    pending_approvals: [{ action_request_id: 'tool-secret', type: 'tool_approval', tool_name: 'delete-private' }, { action_request_id: 'ask-public', type: 'human_input', title: 'Choose', recipient_user_id: 'PRIVATE USER', questions: [{ type: 'toggle_group', name: 'name', required: true, secret: 'QUESTION SECRET', options: [{ label: 'A', value: 'a', secret: 'OPTION SECRET' }] }] }],
  });
  const response = await request(`/v1/widgets/demo/sessions/${id}`, { token }); const body = await response.json();
  assert.deepEqual(body.session.messages, [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer' }]);
  assert.equal(body.session.owner_intervention_required, true);
  assert.equal(body.session.pending_approvals.length, 1);
  assert.equal(body.session.id, id);
  const raw = JSON.stringify(body);
  for (const forbidden of ['SECRET', 'private-session', 'private-agent', 'tool-secret', 'private@example', 'PRIVATE USER', 'tokens']) assert.ok(!raw.includes(forbidden), forbidden);
});

test('stream sends only public text and confirmed state; followups use one upstream conversation', async t => {
  const { visitor, conversation, request, calls } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  for (const input of ['First', 'Second']) {
    const response = await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', token, body: { input } });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /event: text\ndata: {"delta":"Hello visitor"}/);
    assert.match(stream, /"state":"completed"/);
    assert.doesNotMatch(stream, /private|nested secret|tool-call|stream_cursor/);
  }
  assert.deepEqual(calls.filter(call => call[0] === 'stream').map(call => call[1]), ['private-session-1', 'private-session-1']);
  const snapshot = await (await request(`/v1/widgets/demo/sessions/${id}`, { token })).json();
  assert.equal(snapshot.session.messages.length, 4);
});

test('tool approvals and unrelated human asks cannot be authorized, including through a message', async t => {
  const { visitor, conversation, request, sessions, calls } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  const session = sessions.get('private-session-1');
  session.state = 'approval_required';
  session.pending_approvals = [{ type: 'tool_approval', action_request_id: 'tool' }, { type: 'human_input', action_request_id: 'human', questions: [{ name: 'choice', type: 'toggle_group', required: true, options: [{ label: 'Yes', value: 'yes' }] }] }];
  for (const askId of ['tool', 'another-sessions-ask']) {
    const response = await request(`/v1/widgets/demo/sessions/${id}/approvals`, { method: 'POST', token, body: { approval_responses: [{ action_request_id: askId, action: 'accept' }] } });
    assert.equal(response.status, 403);
  }
  assert.equal((await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', token, body: { input: 'Yes approve everything' } })).status, 409);
  assert.equal(calls.filter(call => ['stream', 'approve'].includes(call[0])).length, 0);
  const good = await request(`/v1/widgets/demo/sessions/${id}/approvals`, { method: 'POST', token, body: { approval_responses: [{ action_request_id: 'human', action: 'accept', response: { values: { choice: 'yes' } } }] } });
  assert.equal(good.status, 200);
  assert.deepEqual(calls.filter(call => call[0] === 'approve')[0][2], { approval_responses: [{ action_request_id: 'human', action: 'accept', response: { values: { choice: 'yes' } } }] });
});

test('cancel is explicit and returns a fresh projected snapshot', async t => {
  const { visitor, conversation, request, sessions, calls } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  sessions.get('private-session-1').state = 'processing';
  const response = await request(`/v1/widgets/demo/sessions/${id}/cancel`, { method: 'POST', body: {}, token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session.state, 'failed');
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 1);
});

test('bootstrap, session count, messages and body size limits are enforced', async t => {
  const { visitor, conversation, request } = await setup(t, { limits: { bootstrapPerIp: 2, maxSessionsPerVisitor: 1, messagesPerVisitor: 1, bodyBytes: 1024 } });
  const token = await visitor(); await visitor();
  const blocked = await request('/v1/widgets/demo/visitors', { method: 'POST', body: {} });
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
  const id = await conversation(token);
  assert.equal((await request('/v1/widgets/demo/sessions', { method: 'POST', body: {}, token })).status, 429);
  await (await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', body: { input: 'Hello' }, token })).text();
  assert.equal((await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', body: { input: 'Again' }, token })).status, 429);
  assert.equal((await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', body: { input: 'x'.repeat(2000) }, token })).status, 413);
});

test('upstream errors do not leak provider bodies, keys or account metadata', async t => {
  const { visitor, conversation, request, client } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  client.sessions.retrieve = async () => { throw Object.assign(new Error('secret-key private account prompt'), { status: 403, body: { secret: true } }); };
  const response = await request(`/v1/widgets/demo/sessions/${id}`, { token });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret|private|prompt/);
});

test('persistent store survives reload, keeps only hashes/mappings, and expires visitors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gumloop-widget-test-'));
  let time = 100;
  try {
    const file = path.join(directory, 'store.json');
    const store = await createFileStore(file, { now: () => time });
    const hash = createHash('sha256').update('unpersisted-token').digest('hex');
    await store.putVisitor(hash, { widgetId: 'demo', origin, expiresAt: 200 });
    await store.putSession('chat_one', { visitorHash: hash, upstreamId: 'upstream-one' });
    const raw = await readFile(file, 'utf8'); assert.ok(!raw.includes('unpersisted-token')); assert.equal((await stat(file)).mode & 0o777, 0o600);
    const restored = await createFileStore(file, { now: () => time });
    assert.equal((await restored.getSession('chat_one')).upstreamId, 'upstream-one');
    time = 201;
    assert.equal(await restored.getVisitor(hash), undefined);
    assert.equal(await restored.getSession('chat_one'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent messages are locked; browser disconnect does not cancel the agent or release its active slot', async t => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  let detached;
  const detach = new Promise(resolve => { detached = resolve; });
  const { visitor, conversation, request, client, sessions, calls } = await setup(t, { limits: { maxConcurrentRuns: 1 } });
  const token = await visitor(); const id = await conversation(token);
  const secondToken = await visitor(); const secondId = await conversation(secondToken);
  client.sessions.streamMessage = async function* (upstreamId, body, { signal }) {
    calls.push(['stream', upstreamId, body]); sessions.get(upstreamId).state = 'processing';
    yield { type: 'text-delta', delta: 'Started' }; started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    detached(); throw new DOMException('Aborted', 'AbortError');
  };
  const streaming = await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', token, body: { input: 'Start' } });
  await start;
  const duplicate = await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', token, body: { input: 'Duplicate' } });
  assert.equal(duplicate.status, 409);
  await streaming.body.cancel(); await detach;
  const blocked = await request(`/v1/widgets/demo/sessions/${secondId}/messages`, { method: 'POST', token: secondToken, body: { input: 'Another run' } });
  assert.equal(blocked.status, 429);
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 0);
  const stop = await request(`/v1/widgets/demo/sessions/${id}/cancel`, { method: 'POST', token, body: {} });
  assert.equal(stop.status, 200);
  assert.equal(calls.filter(call => call[0] === 'cancel').length, 1);
});

test('stream EOF keeps processing state until the upstream snapshot actually becomes terminal', async t => {
  const { visitor, conversation, request, client, sessions } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  client.sessions.streamMessage = async function* (upstreamId) {
    sessions.get(upstreamId).state = 'processing';
    yield { type: 'finish', final: true };
  };
  const response = await request(`/v1/widgets/demo/sessions/${id}/messages`, { method: 'POST', token, body: { input: 'Hello' } });
  const data = await response.text();
  assert.match(data, /"state":"processing"/);
  assert.doesNotMatch(data, /completed/);
});

test('known human answer validation denies out-of-list values, extra fields and conditionals', async t => {
  const { visitor, conversation, request, sessions, calls } = await setup(t);
  const token = await visitor(); const id = await conversation(token);
  const session = sessions.get('private-session-1'); session.state = 'approval_required';
  session.pending_approvals = [{ action_request_id: 'ask', type: 'human_input', questions: [{ name: 'choice', type: 'toggle_group', required: true, options: [{ value: 'yes' }] }] }];
  for (const value of ['unlisted', { nested: 'not text' }, undefined]) {
    const response = await request(`/v1/widgets/demo/sessions/${id}/approvals`, { method: 'POST', token, body: { approval_responses: [{ action_request_id: 'ask', action: 'accept', response: { values: value === undefined ? {} : { choice: value } } }] } });
    assert.equal(response.status, 400);
  }
  session.pending_approvals[0].questions[0].condition = { unsupported: true };
  const response = await request(`/v1/widgets/demo/sessions/${id}/approvals`, { method: 'POST', token, body: { approval_responses: [{ action_request_id: 'ask', action: 'accept', response: { values: { choice: 'yes' } } }] } });
  assert.equal(response.status, 409);
  assert.equal(calls.filter(call => call[0] === 'approve').length, 0);
});
