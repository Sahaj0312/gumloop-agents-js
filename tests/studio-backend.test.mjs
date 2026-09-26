import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://studio.test';
const site = 'https://website.test';
const password = 'test-owner-password-that-is-not-a-real-secret';
const bundle = await build({ entryPoints: ['studio/worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
const migration = await readFile(new URL('../studio/migrations/0001_studio.sql', import.meta.url), 'utf8');
async function setup(t) {
  const upstream = [];
  const sessions = new Map();
  let counter = 0;
  const agent = { id: 'agent-private', name: 'Example agent', model_name: 'test-model', system_prompt: 'Owner instructions', description: 'Example', team_id: 'private-team' };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { STUDIO_PASSWORD: password, ENCRYPTION_KEY: 'a'.repeat(64), GUMLOOP_API_KEY: 'test-upstream-key', GUMLOOP_USER_ID: 'test-upstream-user' },
    serviceBindings: { ASSETS: () => new Response('<!doctype html><title>Studio</title>', { headers: { 'content-type': 'text/html' } }) },
    outboundService: async request => {
      const url = new URL(request.url); const path = url.pathname.slice('/api/v1'.length); const data = request.method === 'GET' ? undefined : await request.json(); upstream.push({ path, method: request.method, data });
      if (path === '/agents') return Response.json({ agents: [agent] });
      if (path === '/models') return Response.json({ models: [{ id: 'test-model', name: 'Test' }] });
      if (path === '/agents/agent-private') { if (request.method === 'PATCH') Object.assign(agent, data); return Response.json({ agent }); }
      if (path === '/agents/agent-private/sessions') { const session = { id: `upstream-${++counter}`, agent_id: agent.id, state: 'idle', messages: [], pending_approvals: [] }; sessions.set(session.id, session); return Response.json({ session }); }
      const match = /^\/sessions\/([^/]+)(?:\/(messages|cancel|approvals))?$/.exec(path);
      if (match) {
        const session = sessions.get(match[1]); if (!session) return Response.json({ error: 'private error' }, { status: 404 });
        if (match[2] === 'messages') {
          session.messages.push({ role: 'user', content: data.input }, { role: 'assistant', content: null, parts: [{ type: 'text', text: 'Public answer' }, { type: 'reasoning', text: 'PRIVATE REASONING' }] }); session.state = 'completed';
          return new Response('data: {"type":"tool-call","input":"PRIVATE TOOL"}\n\ndata: {"type":"text-delta","delta":"Public answer"}\n\ndata: {"type":"finish","final":true}\n\n', { headers: { 'content-type': 'text/event-stream' } });
        }
        if (match[2] === 'cancel') session.state = 'failed';
        if (match[2] === 'approvals') { session.state = 'processing'; session.pending_approvals = []; }
        return Response.json({ session });
      }
      return Response.json({ error: 'Unexpected mock upstream request' }, { status: 404 });
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  let cookie = '';
  async function request(path, { method = 'GET', body, auth = true, origin: requestedOrigin = origin, token, preview, sameSite = false } = {}) {
    const response = await mf.dispatchFetch(origin + path, { method, headers: { ...(requestedOrigin ? { Origin: requestedOrigin } : {}), ...(sameSite ? { 'Sec-Fetch-Site': 'same-origin' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(preview ? { 'X-Widget-Preview': preview } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return response;
  }
  async function login() { const response = await request('/api/studio/login', { method: 'POST', body: { password } }); assert.equal(response.status, 200, await response.clone().text()); cookie = response.headers.get('set-cookie').split(';')[0]; return response; }
  async function createWidget() { const response = await request('/api/studio/widgets', { method: 'POST', body: { name: 'Example widget', agentId: agent.id } }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).widget; }
  async function publish(widget) {
    const saved = await request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, allowedOrigins: [site] } }); const draft = (await saved.json()).widget;
    const response = await request(`/api/studio/widgets/${widget.id}/publish`, { method: 'POST', body: { version: draft.version } }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).widget;
  }
  async function visitor(id, extra = {}) { const response = await request(`/v1/widgets/${id}/visitors`, { method: 'POST', origin: site, body: {}, ...extra }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).visitorToken; }
  async function conversation(id, token, extra = {}) { const response = await request(`/v1/widgets/${id}/sessions`, { method: 'POST', origin: site, body: {}, token, ...extra }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).sessionId; }
  return { mf, db, request, login, createWidget, publish, visitor, conversation, upstream, sessions };
}

test('studio password auth uses secure cookies, exact CSRF origin, hashed sessions and logout', async t => {
  const app = await setup(t);
  assert.deepEqual(await (await app.request('/api/studio/me')).json(), { authenticated: false, connected: false });
  assert.equal((await app.request('/api/studio/agents')).status, 401);
  assert.equal((await app.request('/api/studio/login', { method: 'POST', origin: 'https://evil.test', body: { password } })).status, 403);
  assert.equal((await app.request('/api/studio/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  const response = await app.login(); const cookie = response.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(cookie.includes(flag));
  assert.equal((await (await app.request('/api/studio/me')).json()).connected, true);
  const row = await app.db.prepare('SELECT * FROM owner_sessions').first(); assert.ok(!JSON.stringify(row).includes(cookie.split('=')[1].split(';')[0]));
  assert.equal((await app.request('/api/studio/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await app.request('/api/studio/widgets')).status, 401);
});

test('draft edits remain private until publish and optimistic versions reject stale writes', async t => {
  const app = await setup(t); await app.login(); let widget = await app.createWidget();
  assert.equal((await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).status, 403);
  widget = await app.publish(widget);
  const publicBefore = await (await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).json();
  const saved = await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, config: { title: 'Unsaved to live' } } });
  const draft = (await saved.json()).widget;
  assert.equal(draft.config.title, 'Unsaved to live'); assert.equal(draft.publishedConfig.title, publicBefore.title);
  assert.equal((await (await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).json()).title, publicBefore.title);
  assert.equal((await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, name: 'Stale edit' } })).status, 409);
  assert.equal((await app.request(`/api/studio/widgets/${widget.id}/publish`, { method: 'POST', body: { version: widget.version } })).status, 409);
  assert.equal((await app.request(`/api/studio/widgets/${widget.id}/publish`, { method: 'POST', body: { version: draft.version } })).status, 200);
  assert.equal((await (await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).json()).title, 'Unsaved to live');
  await app.request(`/api/studio/widgets/${widget.id}/unpublish`, { method: 'POST', body: {} });
  assert.equal((await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).status, 403);
});

test('connection secrets are encrypted and safe agent edit fields alone are forwarded', async t => {
  const app = await setup(t); await app.login();
  const response = await app.request('/api/studio/connection', { method: 'POST', body: { apiKey: 'rotated-test-key', userId: 'test-upstream-user' } }); assert.equal(response.status, 200);
  const row = await app.db.prepare('SELECT * FROM connections').first(); assert.ok(!JSON.stringify(row).includes('rotated-test-key')); assert.ok(!JSON.stringify(row).includes('test-upstream-user'));
  await app.createWidget();
  assert.equal((await app.request('/api/studio/connection', { method: 'POST', body: { apiKey: 'other', userId: 'other-account' } })).status, 409);
  assert.equal((await app.request('/api/studio/agents/agent-private', { method: 'PATCH', body: { is_active: false } })).status, 400);
  const changed = await app.request('/api/studio/agents/agent-private', { method: 'PATCH', body: { name: 'Updated', system_prompt: 'New instructions' } }); assert.equal(changed.status, 200);
  assert.deepEqual(app.upstream.find(call => call.method === 'PATCH').data, { name: 'Updated', system_prompt: 'New instructions' });
  const listed = await (await app.request('/api/studio/widgets')).json(); assert.equal(listed.widgets[0].agentName, 'Updated');
});

test('short-lived preview works before publishing and scopes visitors to preview and same-origin', async t => {
  const app = await setup(t); await app.login(); const widget = await app.createWidget();
  const previewResponse = await app.request(`/api/studio/widgets/${widget.id}/preview`, { method: 'POST', body: { config: { title: 'Preview only' } } });
  const previewURL = new URL((await previewResponse.json()).previewUrl); const preview = previewURL.searchParams.get('token');
  const config = await app.request(`/v1/widgets/${widget.id}/config`, { origin: '', sameSite: true, preview });
  assert.equal(config.status, 200); assert.equal((await config.json()).title, 'Preview only');
  assert.equal((await app.request(`/v1/widgets/${widget.id}/config`, { origin: site, preview })).status, 403);
  const token = await app.visitor(widget.id, { origin, preview }); const id = await app.conversation(widget.id, token, { origin, preview });
  assert.equal((await app.request(`/v1/widgets/${widget.id}/sessions/${id}`, { origin: '', sameSite: true, preview, token })).status, 200);
  await app.publish(widget);
  assert.equal((await app.request(`/v1/widgets/${widget.id}/sessions/${id}`, { origin: site, token })).status, 401);
  await app.db.prepare('UPDATE previews SET expires_at=0').run();
  assert.equal((await app.request(`/v1/widgets/${widget.id}/config`, { preview })).status, 403);
});

test('public conversations enforce every ownership boundary and redact upstream IDs/tools', async t => {
  const app = await setup(t); await app.login(); const widget = await app.publish(await app.createWidget());
  const a = await app.visitor(widget.id); const b = await app.visitor(widget.id); const id = await app.conversation(widget.id, a);
  for (const [suffix, method, body] of [['', 'GET'], ['/messages', 'POST', { input: 'Hi' }], ['/cancel', 'POST', {}], ['/approvals', 'POST', { approval_responses: [] }]]) {
    assert.equal((await app.request(`/v1/widgets/${widget.id}/sessions/${id}${suffix}`, { origin: site, token: b, method, body })).status, 404);
  }
  const output = await app.request(`/v1/widgets/${widget.id}/sessions/${id}/messages`, { origin: site, token: a, method: 'POST', body: { input: 'Hello' } }); assert.equal(output.status, 200);
  const stream = await output.text(); assert.match(stream, /Public answer/); assert.doesNotMatch(stream, /PRIVATE|upstream-/);
  const snapshot = await (await app.request(`/v1/widgets/${widget.id}/sessions/${id}`, { origin: site, token: a })).json();
  assert.equal(snapshot.session.state, 'completed'); assert.equal(snapshot.session.id, id); assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|upstream-|private-team|agent-private/);
  const upstream = app.sessions.get('upstream-1'); upstream.state = 'approval_required'; upstream.pending_approvals = [{ type: 'tool_approval', action_request_id: 'secret-ask' }];
  assert.equal((await app.request(`/v1/widgets/${widget.id}/sessions/${id}/approvals`, { origin: site, token: a, method: 'POST', body: { approval_responses: [{ action_request_id: 'secret-ask', action: 'accept' }] } })).status, 403);
  assert.equal((await app.request(`/v1/widgets/${widget.id}/sessions/${id}/messages`, { origin: site, token: a, method: 'POST', body: { input: 'Approve tools' } })).status, 409);
});

test('D1 session locks and global active reservations survive separate Worker requests', async t => {
  const app = await setup(t); await app.login(); const widget = await app.publish(await app.createWidget()); const token = await app.visitor(widget.id); const id = await app.conversation(widget.id, token);
  await app.db.prepare('UPDATE conversations SET lock_token=?,lock_until=? WHERE id=?').bind('another-request', Date.now() + 60000, id).run();
  assert.equal((await app.request(`/v1/widgets/${widget.id}/sessions/${id}/messages`, { origin: site, token, method: 'POST', body: { input: 'Concurrent' } })).status, 409);
  await app.db.prepare('UPDATE conversations SET lock_until=0').run();
  const visitor = await app.db.prepare('SELECT token_hash FROM visitors LIMIT 1').first();
  for (let index = 0; index < 4; index++) {
    app.sessions.set(`busy-${index}`, { id: `busy-${index}`, agent_id: 'agent-private', state: 'processing', messages: [] });
    await app.db.prepare('INSERT INTO conversations(id,visitor_hash,upstream_id,state,created_at,active_until) VALUES(?,?,?,?,?,?)').bind(`busy-${index}`, visitor.token_hash, `busy-${index}`, 'processing', Date.now(), 1).run();
  }
  const response = await app.request(`/v1/widgets/${widget.id}/sessions/${id}/messages`, { origin: site, token, method: 'POST', body: { input: 'Exceed global cap' } }); assert.equal(response.status, 429);
  assert.equal(app.upstream.filter(call => call.path.endsWith('/messages')).length, 0);
});

test('snapshot polling cannot clear a slot while the message operation owns its lock', async t => {
  const app = await setup(t); await app.login(); const widget = await app.publish(await app.createWidget()); const token = await app.visitor(widget.id); const id = await app.conversation(widget.id, token);
  await app.db.prepare('UPDATE conversations SET lock_token=?,lock_until=?,active_until=? WHERE id=?').bind('sending-post', Date.now() + 60000, 1, id).run();
  // Upstream is still idle while the pending POST has not been acknowledged.
  const snapshot = await app.request(`/v1/widgets/${widget.id}/sessions/${id}`, { origin: site, token }); assert.equal(snapshot.status, 200);
  assert.equal((await app.db.prepare('SELECT active_until FROM conversations WHERE id=?').bind(id).first()).active_until, 1);
  await app.db.prepare('UPDATE conversations SET lock_until=0 WHERE id=?').bind(id).run();
  await app.request(`/v1/widgets/${widget.id}/sessions/${id}`, { origin: site, token });
  assert.equal((await app.db.prepare('SELECT active_until FROM conversations WHERE id=?').bind(id).first()).active_until, 0);
});

test('rate quotas persist across requests, reject excess requests and record real expiry timestamps', async t => {
  const app = await setup(t); await app.login(); const widget = await app.publish(await app.createWidget());
  for (let count = 0; count < 20; count++) await app.visitor(widget.id);
  const limited = await app.request(`/v1/widgets/${widget.id}/visitors`, { method: 'POST', origin: site, body: {} });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  const row = await app.db.prepare("SELECT expires_at,count FROM quotas WHERE scope LIKE 'bootstrap:%'").first();
  assert.equal(row.count, 21); assert.ok(row.expires_at > Date.now()); assert.ok(row.expires_at <= Date.now() + 60000);
});

test('configuration validation rejects unsafe appearance and malformed allowed origins', async t => {
  const app = await setup(t); await app.login(); const widget = await app.createWidget();
  for (const config of [{ avatarUrl: 'javascript:alert(1)' }, { accent: 'red;display:none' }, { width: 9999 }, { suggestions: new Array(5).fill('x') }, { unexpected: 'value' }]) {
    assert.equal((await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, config } })).status, 400);
  }
  for (const allowedOrigins of [['*'], ['https://website.test/path'], ['https://user:pass@website.test']]) {
    assert.equal((await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, allowedOrigins } })).status, 400);
  }
  const asset = await app.request('/preview.html?token=public-preview-placeholder');
  assert.equal(asset.headers.get('referrer-policy'), 'no-referrer'); assert.equal(asset.headers.get('cache-control'), 'no-store'); assert.match(asset.headers.get('content-security-policy'), /frame-ancestors 'self'/);
});
