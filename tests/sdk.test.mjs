import test from 'node:test';
import assert from 'node:assert/strict';
import { Gumloop, GumloopError } from '../dist/index.js';

const session = { id: 'sess_test', agent_id: 'agent_test', state: 'idle', messages: [] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (value = 'data: [DONE]\n\n') => new Response(value, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
function fixture(responder = () => json({ session })) {
  const calls = [];
  const client = new Gumloop({ apiKey: 'test-key', userId: 'test-user', teamId: 'team-default', fetch: async (url, init) => {
    calls.push({ url: new URL(url), ...init });
    return responder(calls.at(-1));
  } });
  return { client, calls };
}
async function collect(iterable) { const events = []; for await (const event of iterable) events.push(event); return events; }

test('personal auth, team defaults, query encoding, and per-list override', async () => {
  const { client, calls } = fixture(() => json({ agents: [], next_cursor: 'next' }));
  const response = await client.agents.list({ search: 'hello & goodbye' });
  await client.agents.list({ teamId: 'team-override' });
  assert.equal(response.next_cursor, 'next');
  assert.equal(calls[0].url.origin, 'https://api.gumloop.com');
  assert.equal(calls[0].url.searchParams.get('search'), 'hello & goodbye');
  assert.equal(calls[0].url.searchParams.get('team_id'), 'team-default');
  assert.equal(calls[1].url.searchParams.get('team_id'), 'team-override');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer test-key');
  assert.equal(calls[0].headers.get('x-auth-key'), 'test-user');
  assert.equal(calls[0].redirect, 'error');
});

test('OAuth access token can be used without a personal user ID', async () => {
  const calls = [];
  const client = new Gumloop({ accessToken: 'oauth-token', userId: '', fetch: async (_, init) => { calls.push(init); return json({ agents: [] }); } });
  await client.agents.list();
  assert.equal(calls[0].headers.get('authorization'), 'Bearer oauth-token');
  assert.equal(calls[0].headers.get('x-auth-key'), null);
  assert.throws(() => new Gumloop({ apiKey: 'x', accessToken: 'y' }), /not both/);
  assert.throws(() => new Gumloop({ apiKey: 'x', userId: '' }), /userId/);
});

test('creates/updates an agent and includes the configured workspace in creation body', async () => {
  const { client, calls } = fixture(() => json({ agent: { id: 'a', name: 'New' } }));
  await client.agents.create({ name: 'New', model_name: 'test-model', tools: [], system_prompt: 'Reply briefly.' });
  await client.agents.update('a/b', { is_active: false });
  assert.deepEqual(JSON.parse(calls[0].body), { team_id: 'team-default', name: 'New', model_name: 'test-model', tools: [], system_prompt: 'Reply briefly.' });
  assert.equal(calls[1].url.pathname, '/api/v1/agents/a%2Fb');
  assert.equal(calls[1].method, 'PATCH');
  assert.throws(() => client.agents.retrieve('..'), /resource ID/);
});

test('create, retrieve, follow-up, rename and list sessions match the public routes', async () => {
  const { client, calls } = fixture();
  const request = { input: 'Hello', session_id: 'sess_test', metadata: { example: true } };
  await client.sessions.create('agent_test', request);
  await client.sessions.retrieve('sess_test');
  await client.sessions.send('sess_test', { input: 'Again' });
  await client.sessions.update('sess_test', { name: 'Example' });
  await client.sessions.list('agent_test', { cursor: 'cursor + space', page_size: 10, state: 'completed' });
  assert.deepEqual(JSON.parse(calls[0].body), { ...request, stream: false });
  assert.equal(calls[1].url.pathname, '/api/v1/sessions/sess_test');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[2].url.pathname, '/api/v1/sessions/sess_test/messages');
  assert.deepEqual(JSON.parse(calls[2].body), { input: 'Again', stream: false });
  assert.equal(calls[3].method, 'PATCH');
  assert.equal(calls[4].url.searchParams.get('cursor'), 'cursor + space');
  assert.equal(calls[4].url.searchParams.get('page_size'), '10');
  assert.throws(() => client.sessions.send('sess_test', {}), /input/);
});

test('stream routes to ws host and preserves team/auth/signal for create and follow-up', async () => {
  const { client, calls } = fixture(() => sse());
  const controller = new AbortController();
  await collect(client.sessions.stream('agent_test', { input: 'Hello', session_id: 'chosen' }, { signal: controller.signal }));
  await collect(client.sessions.streamMessage('chosen', { input: 'Again' }));
  assert.equal(calls[0].url.origin, 'https://ws.gumloop.com');
  assert.equal(calls[0].url.searchParams.get('team_id'), 'team-default');
  assert.equal(calls[0].headers.get('x-auth-key'), 'test-user');
  assert.equal(calls[0].headers.get('accept'), 'text/event-stream');
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].body), { input: 'Hello', session_id: 'chosen', stream: true });
  assert.equal(calls[1].url.pathname, '/api/v1/sessions/chosen/messages');
});

test('resume is only GET with the exact cursor; cancellation is a separate POST', async () => {
  const { client, calls } = fixture(call => call.method === 'GET' ? sse() : json({ session: { ...session, state: 'failed' } }));
  await collect(client.sessions.resumeStream('sess_test', 'run-id:12+/='));
  await client.sessions.cancel('sess_test');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].url.searchParams.get('last_cursor'), 'run-id:12+/=');
  assert.equal(calls[0].url.searchParams.get('stream'), 'true');
  assert.equal(calls[0].url.searchParams.get('team_id'), 'team-default');
  assert.equal(calls[1].url.pathname, '/api/v1/sessions/sess_test/cancel');
  assert.equal(calls[1].url.origin, 'https://api.gumloop.com');
  assert.equal(calls[1].method, 'POST');
});

test('approval decisions and human input values round-trip without interpretation', async () => {
  const response = { session: { ...session, state: 'processing' }, results: [{ action_request_id: 'ask1', action: 'accept', outcome: 'accepted' }], stream_cursor: 'run:4' };
  const { client, calls } = fixture(() => json(response));
  const request = { approval_responses: [{ action_request_id: 'ask1', action: 'accept', response: { values: { destination: 'Example' } } }] };
  assert.deepEqual(await client.sessions.resolveApprovals('sess_test', request), response);
  assert.equal(calls[0].url.pathname, '/api/v1/sessions/sess_test/approvals');
  assert.deepEqual(JSON.parse(calls[0].body), request);
  assert.throws(() => client.sessions.resolveApprovals('sess_test', { approval_responses: [] }), /between 1 and 20/);
  assert.throws(() => client.sessions.resolveApprovals('sess_test', { approval_responses: [...request.approval_responses, ...request.approval_responses] }), /unique/);
  assert.throws(() => client.sessions.resolveApprovals('sess_test', { approval_responses: [{ action_request_id: 'a', action: 'maybe' }] }), /accept or reject/);
  assert.equal(calls.length, 1);
});

test('HTTP errors preserve status, structured body and request ID without retrying POST', async () => {
  const { client, calls } = fixture(() => new Response('{"error":"interaction_not_in_terminal_state"}', { status: 409, headers: { 'x-request-id': 'request-test' } }));
  await assert.rejects(client.sessions.send('sess_test', { input: 'Hello' }), error => {
    assert.ok(error instanceof GumloopError);
    assert.equal(error.status, 409);
    assert.equal(error.body.error, 'interaction_not_in_terminal_state');
    assert.equal(error.requestId, 'request-test');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('network failures and stream HTTP errors are not retried', async () => {
  let count = 0;
  const client = new Gumloop({ accessToken: 'fake', fetch: async () => { count++; throw new TypeError('network failed'); } });
  await assert.rejects(collect(client.sessions.stream('a', { input: 'Hello' })), /network failed/);
  assert.equal(count, 1);
  const { client: bad, calls } = fixture(() => new Response('upstream unavailable', { status: 503 }));
  await assert.rejects(collect(bad.sessions.stream('a')), error => error.status === 503 && error.body === 'upstream unavailable');
  assert.equal(calls.length, 1);
});

test('malformed HTTP payloads and wrong stream content types fail explicitly', async () => {
  const { client } = fixture(() => new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(client.sessions.retrieve('s'), /invalid JSON/);
  await assert.rejects(collect(client.sessions.stream('a')), /text\/event-stream/);
});

test('custom API and streaming bases are honored without injecting a production host', async () => {
  const urls = [];
  const client = new Gumloop({ accessToken: 'test', baseUrl: 'http://127.0.0.1:7777/api/v1/', streamBaseUrl: 'http://127.0.0.1:8888/stream/', fetch: async url => { urls.push(new URL(url)); return urls.length === 1 ? json({ agents: [] }) : sse(); } });
  await client.agents.list();
  await collect(client.sessions.resumeStream('s', ''));
  assert.equal(urls[0].href, 'http://127.0.0.1:7777/api/v1/agents');
  assert.equal(urls[1].pathname, '/stream/sessions/s');
  assert.equal(urls[1].searchParams.get('last_cursor'), '');
  assert.throws(() => new Gumloop({ accessToken: 'x', baseUrl: 'https://user:password@example.com' }), /without credentials/);
});

test('native fetch AbortSignal detaches a live stream without sending server cancellation', async () => {
  const { createServer } = await import('node:http');
  const requests = [];
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"text-delta","delta":"Hello","stream_cursor":"run:1"}\n\n');
    response.on('close', disconnected);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const client = new Gumloop({ accessToken: 'test-token', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1` });
    const iterator = client.sessions.stream('agent_test', { input: 'Hello' }, { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.stream_cursor, 'run:1');
    controller.abort();
    await assert.rejects(iterator.next(), error => error.name === 'AbortError');
    await closed;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].path, '/api/v1/agents/agent_test/sessions');
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('nested API errors and OAuth descriptions are readable without stringifying arbitrary bodies', async () => {
  const failures = [
    { payload: { error: { code: 'invalid_input', message: 'Question answer is required' } }, code: 'invalid_input', message: 'Question answer is required' },
    { payload: { error: 'invalid_token', error_description: 'Access token has expired' }, code: 'invalid_token', message: 'Access token has expired' },
    { payload: { message: 'Please wait for the current run', code: 'busy' }, code: 'busy', message: 'Please wait for the current run' },
  ];
  for (const { payload, code, message } of failures) {
    const { client } = fixture(() => json(payload, 400));
    await assert.rejects(client.sessions.retrieve('s'), error => error.code === code && error.message === message);
  }
});
