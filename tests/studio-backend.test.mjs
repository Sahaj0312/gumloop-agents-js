import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://studio.test';
const site = 'https://website.test';
const password = 'test-owner-password-that-is-not-a-real-secret';
const bundle = await build({ entryPoints: ['studio/worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
const migrations = await Promise.all(['0001_studio.sql', '0002_workspaces.sql'].map(name => readFile(new URL(`../studio/migrations/${name}`, import.meta.url), 'utf8')));
async function setup(t, { beforeWorkspaceMigration, beforeUpstream } = {}) {
  const upstream = [];
  const sessions = new Map();
  let counter = 0;
  const agent = { id: 'agent-private', name: 'Example agent', model_name: 'test-model', system_prompt: 'Owner instructions', description: 'Example', team_id: 'private-team' };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { STUDIO_PASSWORD: password, ENCRYPTION_KEY: 'a'.repeat(64), GUMLOOP_API_KEY: 'test-upstream-key', GUMLOOP_USER_ID: 'test-upstream-user' },
    serviceBindings: { ASSETS: () => new Response('<!doctype html><title>Studio</title>', { headers: { 'content-type': 'text/html' } }) },
    outboundService: async request => {
      await beforeUpstream?.(request);
      const url = new URL(request.url); const path = url.pathname.slice('/api/v1'.length); const data = request.method === 'GET' ? undefined : await request.json(); upstream.push({ path, method: request.method, data, credential: request.headers.get('authorization'), userId: request.headers.get('x-auth-key') });
      if (request.headers.get('authorization') === 'Bearer invalid-test-key') return Response.json({ error: 'Invalid key' }, { status: 401 });
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
  for (let index = 0; index < migrations.length; index++) {
    if (index === 1) await beforeWorkspaceMigration?.(db);
    for (const statement of migrations[index].split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  let cookie = '';
  async function request(path, { method = 'GET', body, auth = true, origin: requestedOrigin = origin, token, preview, sameSite = false, cookieOverride } = {}) {
    const response = await mf.dispatchFetch(origin + path, { method, headers: { ...(requestedOrigin ? { Origin: requestedOrigin } : {}), ...(sameSite ? { 'Sec-Fetch-Site': 'same-origin' } : {}), ...(auth && (cookieOverride ?? cookie) ? { Cookie: cookieOverride ?? cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(preview ? { 'X-Widget-Preview': preview } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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
  const row = await app.db.prepare("SELECT expires_at,count FROM quotas WHERE scope LIKE '%:bootstrap:%'").first();
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

async function signup(app, name = 'Workspace A', userId = 'user-a', apiKey = 'key-a') {
  const response = await app.request('/api/studio/signup', { method: 'POST', auth: false, body: { name, userId, apiKey } });
  assert.equal(response.status, 201, await response.clone().text());
  return { ...(await response.json()), cookie: response.headers.get('set-cookie').split(';')[0] };
}

test('signup validates Gumloop first, stores only code hashes and supports returning access-code login', async t => {
  const app = await setup(t);
  const invalid = await app.request('/api/studio/signup', { method: 'POST', auth: false, body: { name: 'Invalid', userId: 'user-invalid', apiKey: 'invalid-test-key' } });
  assert.equal(invalid.status, 400);
  assert.equal((await app.db.prepare('SELECT count(*) AS count FROM workspaces').first()).count, 1);
  const created = await signup(app);
  assert.match(created.accessCode, /^relay_[a-f0-9]{64}$/);
  const row = await app.db.prepare('SELECT * FROM workspaces WHERE id=?').bind(created.workspace.id).first();
  assert.equal(row.name, 'Workspace A'); assert.notEqual(row.access_hash, created.accessCode); assert.equal(row.access_hash.length, 64);
  const me = await (await app.request('/api/studio/me', { cookieOverride: created.cookie })).json();
  assert.equal(me.workspace.id, created.workspace.id); assert.equal(me.account.userId, 'user-a'); assert.equal(me.connected, true);
  assert.ok(!JSON.stringify(me).includes(created.accessCode)); assert.ok(!JSON.stringify(me).includes('key-a'));
  assert.equal((await app.request('/api/studio/signup', { method: 'POST', cookieOverride: created.cookie, body: { name: 'Another', apiKey: 'key-b', userId: 'user-b' } })).status, 409);
  const login = await app.request('/api/studio/login', { method: 'POST', auth: false, body: { password: created.accessCode } });
  assert.equal(login.status, 200); const returningCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await app.request('/api/studio/me', { cookieOverride: returningCookie })).json()).workspace.id, created.workspace.id);
});

test('tenant admin routes cannot read, update, publish or preview another workspace widget', async t => {
  const app = await setup(t); const a = await signup(app); const b = await signup(app, 'Workspace B', 'user-b', 'key-b');
  const create = await app.request('/api/studio/widgets', { method: 'POST', cookieOverride: a.cookie, body: { name: 'A private widget', agentId: 'agent-private' } });
  assert.equal(create.status, 201); const widget = (await create.json()).widget;
  assert.equal(app.upstream.at(-1).credential, 'Bearer key-a');
  const listing = await (await app.request('/api/studio/widgets', { cookieOverride: b.cookie })).json(); assert.deepEqual(listing.widgets, []);
  for (const [suffix, method, body] of [['', 'GET'], ['', 'PATCH', { version: widget.version, name: 'Hijacked' }], ['/publish', 'POST', { version: widget.version }], ['/unpublish', 'POST', {}], ['/preview', 'POST', {}]]) {
    assert.equal((await app.request(`/api/studio/widgets/${widget.id}${suffix}`, { method, body, cookieOverride: b.cookie })).status, 404);
  }
  await app.request('/api/studio/agents', { cookieOverride: b.cookie }); assert.equal(app.upstream.at(-1).credential, 'Bearer key-b');
  await app.request('/api/studio/models', { cookieOverride: b.cookie }); assert.equal(app.upstream.at(-1).credential, 'Bearer key-b');
  await app.login();
  assert.equal((await (await app.request('/api/studio/me')).json()).workspace.id, 'owner');
  assert.equal((await app.request(`/api/studio/widgets/${widget.id}`)).status, 404);
});

test('disconnect removes tenant credentials and contexts, preserves drafts/binding, and never falls back to owner', async t => {
  const app = await setup(t); const a = await signup(app); const options = { cookieOverride: a.cookie };
  let response = await app.request('/api/studio/widgets', { ...options, method: 'POST', body: { name: 'Widget A', agentId: 'agent-private' } }); let widget = (await response.json()).widget;
  response = await app.request(`/api/studio/widgets/${widget.id}`, { ...options, method: 'PATCH', body: { version: widget.version, allowedOrigins: [site] } }); widget = (await response.json()).widget;
  response = await app.request(`/api/studio/widgets/${widget.id}/publish`, { ...options, method: 'POST', body: { version: widget.version } }); widget = (await response.json()).widget;
  const visitor = await app.visitor(widget.id); await app.conversation(widget.id, visitor);
  await app.request(`/api/studio/widgets/${widget.id}/preview`, { ...options, method: 'POST', body: {} });
  const disconnected = await app.request('/api/studio/disconnect', { ...options, method: 'POST', body: {} }); assert.equal(disconnected.status, 200);
  const me = await (await app.request('/api/studio/me', options)).json(); assert.equal(me.connected, false); assert.equal(me.authenticated, true); assert.equal(me.workspace.id, a.workspace.id);
  assert.equal(await app.db.prepare('SELECT * FROM connections WHERE workspace_id=?').bind(a.workspace.id).first(), null);
  assert.equal((await app.db.prepare('SELECT count(*) AS count FROM visitors WHERE widget_id=?').bind(widget.id).first()).count, 0);
  assert.equal((await app.db.prepare('SELECT count(*) AS count FROM previews WHERE widget_id=?').bind(widget.id).first()).count, 0);
  const calls = app.upstream.length;
  assert.equal((await app.request('/api/studio/agents', options)).status, 503); assert.equal(app.upstream.length, calls);
  assert.equal((await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).status, 404);
  const retained = (await (await app.request(`/api/studio/widgets/${widget.id}`, options)).json()).widget;
  assert.equal(retained.name, 'Widget A'); assert.equal(retained.status, 'draft');
  assert.equal((await app.request('/api/studio/connection', { ...options, method: 'POST', body: { apiKey: 'key-b', userId: 'user-b' } })).status, 409);
  assert.equal((await app.request('/api/studio/connection', { ...options, method: 'POST', body: { apiKey: 'key-a-rotated', userId: 'user-a' } })).status, 200);
  await app.request('/api/studio/agents', options); assert.equal(app.upstream.at(-1).credential, 'Bearer key-a-rotated');
});

test('workspace-bound encryption rejects copied ciphertext and guest legacy downgrade', async t => {
  const app = await setup(t); const a = await signup(app); const b = await signup(app, 'B', 'user-b', 'key-b');
  const aRow = await app.db.prepare('SELECT ciphertext FROM connections WHERE workspace_id=?').bind(a.workspace.id).first();
  await app.db.prepare('UPDATE connections SET ciphertext=? WHERE workspace_id=?').bind(aRow.ciphertext, b.workspace.id).run();
  const count = app.upstream.length;
  assert.equal((await app.request('/api/studio/agents', { cookieOverride: b.cookie })).status, 502); assert.equal(app.upstream.length, count);
  await app.db.prepare('UPDATE connections SET encryption_version=1 WHERE workspace_id=?').bind(b.workspace.id).run();
  assert.equal((await app.request('/api/studio/agents', { cookieOverride: b.cookie })).status, 502); assert.equal(app.upstream.length, count);
  assert.equal((await app.request('/api/studio/agents', { cookieOverride: a.cookie })).status, 200);
});

test('legacy migration preserves owner widgets and upgrades only owner ciphertext to bound encryption', async t => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xaa), 'AES-GCM', false, ['encrypt']);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('relay:connection:v1') }, key, new TextEncoder().encode(JSON.stringify({ apiKey: 'legacy-owner-key', userId: 'legacy-owner-user' })));
  const ciphertext = JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
  const app = await setup(t, { beforeWorkspaceMigration: async db => {
    await db.prepare('INSERT INTO connections(id,ciphertext,account_hash,updated_at) VALUES(1,?,?,?)').bind(ciphertext, 'legacy-account-hash', Date.now()).run();
    await db.prepare('INSERT INTO widgets(id,name,agent_id,agent_name,config,updated_at) VALUES(?,?,?,?,?,?)').bind('legacy-widget', 'Legacy widget', 'agent-private', 'Original agent', '{}', Date.now()).run();
  } });
  await app.login();
  const me = await (await app.request('/api/studio/me')).json(); assert.equal(me.account.userId, 'legacy-owner-user');
  const list = await (await app.request('/api/studio/widgets')).json(); assert.equal(list.widgets[0].id, 'legacy-widget');
  const stored = await app.db.prepare('SELECT * FROM connections WHERE workspace_id=\'owner\'').first(); assert.equal(stored.encryption_version, 2); assert.notEqual(stored.ciphertext, ciphertext);
  await app.request('/api/studio/agents'); assert.equal(app.upstream.at(-1).credential, 'Bearer legacy-owner-key');
});

test('a key rotation validated before disconnect cannot reconnect the workspace after disconnect', async t => {
  let validationStarted;
  const started = new Promise(resolve => { validationStarted = resolve; });
  let finishValidation;
  const release = new Promise(resolve => { finishValidation = resolve; });
  const app = await setup(t, { beforeUpstream: async request => {
    if (request.headers.get('authorization') === 'Bearer delayed-rotation-key') {
      validationStarted(); await release;
    }
  } });
  const a = await signup(app);
  const rotation = app.request('/api/studio/connection', { method: 'POST', cookieOverride: a.cookie, body: { apiKey: 'delayed-rotation-key', userId: 'user-a' } });
  await started;
  try {
    const disconnect = await app.request('/api/studio/disconnect', { method: 'POST', cookieOverride: a.cookie, body: {} });
    assert.equal(disconnect.status, 200);
  } finally { finishValidation(); }
  assert.equal((await rotation).status, 409);
  assert.equal(await app.db.prepare('SELECT * FROM connections WHERE workspace_id=?').bind(a.workspace.id).first(), null);
  assert.equal((await app.db.prepare('SELECT connection_disabled FROM workspaces WHERE id=?').bind(a.workspace.id).first()).connection_disabled, 1);
  assert.equal((await (await app.request('/api/studio/me', { cookieOverride: a.cookie })).json()).connected, false);
});

test('account binding cannot change even before the workspace has widgets', async t => {
  const app = await setup(t); const a = await signup(app);
  const response = await app.request('/api/studio/connection', { method: 'POST', cookieOverride: a.cookie, body: { apiKey: 'key-b', userId: 'user-b' } });
  assert.equal(response.status, 409);
  await app.request('/api/studio/agents', { cookieOverride: a.cookie });
  assert.equal(app.upstream.at(-1).credential, 'Bearer key-a');
});

test('launcher modes validate labels/icons and round-trip through drafts, publication and previews', async t => {
  const app = await setup(t); await app.login(); let widget = await app.createWidget();
  assert.equal(widget.config.bubbleStyle, 'icon-text'); assert.equal(widget.config.bubbleIcon, '');
  for (const config of [
    { bubbleStyle: 'unsupported' }, { bubbleIcon: '🙂'.repeat(17) }, { bubbleIcon: null },
    { bubbleLabel: null }, { bubbleLabel: 'x'.repeat(41) },
  ]) {
    const invalid = await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, config } });
    assert.equal(invalid.status, 400);
  }
  const family = '👨‍👩‍👧‍👦';
  const saved = await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, config: { bubbleStyle: 'icon', bubbleLabel: '', bubbleIcon: ` ${family} ` } } });
  assert.equal(saved.status, 200); widget = (await saved.json()).widget;
  assert.equal(widget.config.bubbleIcon, family); assert.equal(widget.config.bubbleLabel, '');
  widget = await app.publish(widget);
  const published = await (await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).json();
  assert.equal(published.bubbleStyle, 'icon'); assert.equal(published.bubbleIcon, family); assert.equal(published.bubbleLabel, '');
  for (const bubbleStyle of ['text', 'icon-text', 'icon']) {
    const response = await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, config: { bubbleStyle, bubbleLabel: '', bubbleIcon: '' } } });
    assert.equal(response.status, 200); widget = (await response.json()).widget;
    widget = await app.publish(widget);
    const emptyConfig = await (await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).json();
    assert.equal(emptyConfig.bubbleLabel, ''); assert.equal(emptyConfig.bubbleIcon, '');
    assert.equal(emptyConfig.bubbleStyle, bubbleStyle);
  }
  const previewResponse = await app.request(`/api/studio/widgets/${widget.id}/preview`, { method: 'POST', body: { config: { bubbleStyle: 'text', bubbleLabel: 'Ask us', bubbleIcon: 'x'.repeat(32) } } });
  assert.equal(previewResponse.status, 200);
  const preview = new URL((await previewResponse.json()).previewUrl).searchParams.get('token');
  const previewConfig = await (await app.request(`/v1/widgets/${widget.id}/config`, { preview })).json();
  assert.equal(previewConfig.bubbleStyle, 'text'); assert.equal(previewConfig.bubbleIcon.length, 32);
});

test('legacy widget records gain launcher defaults on admin, public and preview reads', async t => {
  const app = await setup(t); await app.login(); let widget = await app.publish(await app.createWidget());
  const legacy = { ...widget.config }; delete legacy.bubbleStyle; delete legacy.bubbleIcon;
  await app.db.prepare('UPDATE widgets SET config=?,published_config=? WHERE id=?').bind(JSON.stringify(legacy), JSON.stringify(legacy), widget.id).run();
  const admin = (await (await app.request(`/api/studio/widgets/${widget.id}`)).json()).widget;
  assert.equal(admin.config.bubbleStyle, 'icon-text'); assert.equal(admin.config.bubbleIcon, '');
  assert.equal(admin.publishedConfig.bubbleStyle, 'icon-text');
  const published = await (await app.request(`/v1/widgets/${widget.id}/config`, { origin: site })).json();
  assert.equal(published.bubbleStyle, 'icon-text'); assert.equal(published.bubbleIcon, '');
  const previewURL = new URL((await (await app.request(`/api/studio/widgets/${widget.id}/preview`, { method: 'POST', body: {} })).json()).previewUrl);
  const previewConfig = await (await app.request(`/v1/widgets/${widget.id}/config`, { preview: previewURL.searchParams.get('token') })).json();
  assert.equal(previewConfig.bubbleStyle, 'icon-text'); assert.equal(previewConfig.bubbleIcon, '');
  const saved = await app.request(`/api/studio/widgets/${widget.id}`, { method: 'PATCH', body: { version: widget.version, config: { title: 'Updated legacy title' } } });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).widget.config.bubbleStyle, 'icon-text');
});
