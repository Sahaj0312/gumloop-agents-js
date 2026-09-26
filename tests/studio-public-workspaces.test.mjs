import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const appOrigin = 'https://studio.test';
const site = 'https://customer-site.test';
const ownerPassword = 'synthetic-owner-password';
const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import worker from './studio/worker.ts';
    export default {
      ...worker,
      fetch(request, env, ctx) {
        if (request.headers.get('x-test-disconnect-race') !== '1') return worker.fetch(request, env, ctx);
        const db = {
          prepare(sql) {
            const statement = env.DB.prepare(sql);
            if (!sql.startsWith('INSERT INTO visitors') && !sql.startsWith('INSERT INTO previews')) return statement;
            return {
              bind(...args) {
                const bound = statement.bind(...args);
                return { async run() {
                  // Model a complete disconnect/reconnect immediately before
                  // bootstrap commits: enabled again, but a different generation.
                  await env.DB.prepare('UPDATE workspaces SET connection_version=connection_version+2 WHERE id IN (SELECT workspace_id FROM widgets WHERE id=?)').bind(args[1]).run();
                  return bound.run();
                } };
              }
            };
          }
        };
        return worker.fetch(request, { ...env, DB: db }, ctx);
      }
    };
  ` },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
});

async function fixture(t) {
  const calls = [], sessions = new Map();
  let sequence = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    bindings: { STUDIO_PASSWORD: ownerPassword, ENCRYPTION_KEY: 'c'.repeat(64), GUMLOOP_API_KEY: 'owner-api-key', GUMLOOP_USER_ID: 'owner-user' },
    serviceBindings: { ASSETS: () => new Response('Studio') },
    outboundService: async request => {
      const key = request.headers.get('authorization')?.replace(/^Bearer /, '');
      const userId = request.headers.get('x-auth-key');
      const path = new URL(request.url).pathname.slice('/api/v1'.length);
      const input = request.method === 'GET' ? undefined : await request.json();
      calls.push({ key, userId, path, method: request.method });
      if (!['owner-api-key', 'guest-api-key'].includes(key)) return Response.json({ error: 'bad credential' }, { status: 401 });
      if (userId !== (key === 'owner-api-key' ? 'owner-user' : 'guest-user')) return Response.json({ error: 'wrong user' }, { status: 401 });
      // Deliberately use the same agent ID in both accounts: credential selection
      // must come from the widget workspace, not from an agent ID or caller hint.
      const agent = { id: 'shared-agent-id', name: key === 'owner-api-key' ? 'Owner agent' : 'Guest agent', model_name: 'test-model' };
      if (path === '/agents') return Response.json({ agents: [agent] });
      if (path === '/agents/shared-agent-id') return Response.json({ agent });
      if (path === '/agents/shared-agent-id/sessions') {
        const session = { id: `private-session-${++sequence}`, agent_id: agent.id, state: 'idle', messages: [], pending_approvals: [] };
        sessions.set(session.id, { key, session });
        return Response.json({ session });
      }
      const match = /^\/sessions\/([^/]+)(?:\/(messages|cancel))?$/.exec(path);
      const entry = match && sessions.get(match[1]);
      if (!entry || entry.key !== key) return Response.json({ error: 'wrong account session' }, { status: 404 });
      if (match[2] === 'messages') {
        entry.session.state = 'completed';
        entry.session.messages = [{ role: 'user', content: input.input }, { role: 'assistant', content: 'Your own account replied.' }];
        return new Response('data: {"type":"text-delta","delta":"Your own account replied."}\n\ndata: {"type":"finish","final":true}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      if (match[2] === 'cancel') entry.session.state = 'failed';
      return Response.json({ session: entry.session });
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const dir = new URL('../studio/migrations/', import.meta.url);
  for (const filename of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(filename, dir), 'utf8');
    for (const sql of migration.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const request = (path, { cookie, body, method = body === undefined ? 'GET' : 'POST', origin = appOrigin, token, preview, disconnectRace = false } = {}) => mf.dispatchFetch(appOrigin + path, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(preview ? { 'X-Widget-Preview': preview } : {}), ...(disconnectRace ? { 'X-Test-Disconnect-Race': '1' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const unpack = async (response, expected = 200) => { assert.equal(response.status, expected, await response.clone().text()); return response.json(); };
  async function loginOwner() {
    const response = await request('/api/studio/login', { body: { password: ownerPassword } });
    await unpack(response); return response.headers.get('set-cookie').split(';')[0];
  }
  async function signupGuest() {
    const response = await request('/api/studio/signup', { body: { name: 'Guest workspace', apiKey: 'guest-api-key', userId: 'guest-user' } });
    const data = await unpack(response, 201); return { cookie: response.headers.get('set-cookie').split(';')[0], workspace: data.workspace };
  }
  async function publishedWidget(cookie) {
    const { widget } = await unpack(await request('/api/studio/widgets', { cookie, body: { name: 'Website assistant', agentId: 'shared-agent-id' } }), 201);
    const { widget: draft } = await unpack(await request(`/api/studio/widgets/${widget.id}`, { cookie, method: 'PATCH', body: { version: widget.version, allowedOrigins: [site] } }));
    return (await unpack(await request(`/api/studio/widgets/${widget.id}/publish`, { cookie, body: { version: draft.version } }))).widget;
  }
  async function chat(widgetId) {
    const { visitorToken } = await unpack(await request(`/v1/widgets/${widgetId}/visitors`, { origin: site, body: {} }), 201);
    const { sessionId } = await unpack(await request(`/v1/widgets/${widgetId}/sessions`, { origin: site, token: visitorToken, body: {} }), 201);
    return { token: visitorToken, id: sessionId };
  }
  return { db, calls, sessions, request, unpack, loginOwner, signupGuest, publishedWidget, chat };
}

test('public chat selects stored widget workspace credentials and rejects cross-workspace visitor/session reuse', async t => {
  const app = await fixture(t);
  const owner = await app.loginOwner();
  const guest = await app.signupGuest();
  const ownerWidget = await app.publishedWidget(owner), guestWidget = await app.publishedWidget(guest.cookie);
  const ownerChat = await app.chat(ownerWidget.id), guestChat = await app.chat(guestWidget.id);
  const creates = app.calls.filter(call => call.path.endsWith('/sessions'));
  assert.deepEqual(creates.map(call => call.key), ['owner-api-key', 'guest-api-key']);
  let before = app.calls.length;
  assert.equal((await app.request(`/v1/widgets/${ownerWidget.id}/sessions/${ownerChat.id}`, { origin: site, token: guestChat.token })).status, 401);
  assert.equal((await app.request(`/v1/widgets/${guestWidget.id}/sessions/${ownerChat.id}`, { origin: site, token: guestChat.token })).status, 404);
  assert.equal(app.calls.length, before, 'foreign ownership must fail before upstream access');
  const result = await app.request(`/v1/widgets/${guestWidget.id}/sessions/${guestChat.id}/messages`, { origin: site, cookie: owner, token: guestChat.token, body: { input: 'Hello' } });
  assert.equal(result.status, 200); assert.match(await result.text(), /Your own account replied/);
  assert.ok(app.calls.slice(before).every(call => call.key === 'guest-api-key'), 'even an owner studio cookie cannot override the widget tenant');
  assert.equal((await app.request(`/v1/widgets/${guestWidget.id}/sessions/${guestChat.id}/messages`, { origin: site, token: guestChat.token, body: { input: 'Hello', workspaceId: 'owner' } })).status, 400);
});

test('another workspace exhausted concurrency and message quota do not block or reconcile through guest credentials', async t => {
  const app = await fixture(t); const owner = await app.loginOwner(), guest = await app.signupGuest();
  const ownerWidget = await app.publishedWidget(owner), guestWidget = await app.publishedWidget(guest.cookie);
  await app.chat(ownerWidget.id); const chat = await app.chat(guestWidget.id);
  const visitor = await app.db.prepare('SELECT token_hash FROM visitors WHERE widget_id=?').bind(ownerWidget.id).first();
  for (let n = 0; n < 4; n++) {
    const id = `owner-busy-${n}`;
    app.sessions.set(id, { key: 'owner-api-key', session: { id, state: 'processing', messages: [] } });
    await app.db.prepare('INSERT INTO conversations(id,visitor_hash,upstream_id,state,created_at,active_until) VALUES(?,?,?,?,?,?)').bind(id, visitor.token_hash, id, 'processing', Date.now(), 1).run();
  }
  const bucket = Math.floor(Date.now() / 60000);
  await app.db.prepare('INSERT INTO quotas(scope,bucket,count,expires_at) VALUES(?,?,?,?)').bind('workspace:owner:message', bucket, 60, Date.now() + 60000).run();
  const before = app.calls.length;
  const response = await app.request(`/v1/widgets/${guestWidget.id}/sessions/${chat.id}/messages`, { origin: site, token: chat.token, body: { input: 'My own capacity' } });
  assert.equal(response.status, 200, await response.clone().text()); await response.text();
  assert.ok(app.calls.slice(before).every(call => call.key === 'guest-api-key'));
  assert.ok(app.calls.slice(before).every(call => !call.path.includes('owner-busy')), 'stale task reconciliation must stay inside its workspace');
  assert.equal((await app.db.prepare('SELECT count(*) AS count FROM conversations WHERE id LIKE ? AND active_until>0').bind('owner-busy-%').first()).count, 4);
  assert.equal((await app.db.prepare('SELECT count FROM quotas WHERE scope=? AND bucket=?').bind(`workspace:${guest.workspace.id}:message`, bucket).first()).count, 1);
});

test('disconnect revokes guest public and preview contexts without falling back to owner credentials', async t => {
  const app = await fixture(t); const owner = await app.loginOwner(), guest = await app.signupGuest();
  const ownerWidget = await app.publishedWidget(owner), guestWidget = await app.publishedWidget(guest.cookie);
  const chat = await app.chat(guestWidget.id);
  const { previewUrl } = await app.unpack(await app.request(`/api/studio/widgets/${guestWidget.id}/preview`, { cookie: guest.cookie, body: {} }));
  const preview = new URL(previewUrl).searchParams.get('token');
  await app.unpack(await app.request('/api/studio/disconnect', { cookie: guest.cookie, body: {} }));
  const before = app.calls.length;
  for (const path of [`/v1/widgets/${guestWidget.id}/config`, `/v1/widgets/${guestWidget.id}/sessions/${chat.id}`]) {
    assert.ok((await app.request(path, { origin: site, token: chat.token })).status >= 400);
  }
  assert.ok((await app.request(`/v1/widgets/${guestWidget.id}/config`, { preview })).status >= 400);
  assert.ok((await app.request('/api/studio/agents', { cookie: guest.cookie })).status >= 400);
  assert.equal(app.calls.length, before, 'disconnected workspace must not invoke any upstream account');
  assert.equal((await app.request(`/v1/widgets/${ownerWidget.id}/config`, { origin: site })).status, 200);
});

test('owner environment fallback rechecks a disconnect committed after its initial workspace read', async () => {
  const dataBundle = await build({ entryPoints: ['studio/backend/data.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const { credentials } = await import(`data:text/javascript;base64,${Buffer.from(dataBundle.outputFiles[0].text).toString('base64')}`);
  let disconnected = false;
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM workspaces')) return { id: 'owner', name: 'Owner', access_hash: null, account_hash: null, connection_disabled: disconnected ? 1 : 0 };
          if (sql.includes('FROM connections')) { disconnected = true; return null; }
          if (sql.startsWith('UPDATE workspaces')) return disconnected ? null : { id: 'owner' };
          throw new Error(`Unexpected test SQL: ${sql}`);
        },
        async run() { return { meta: { changes: disconnected ? 0 : 1 } }; },
      };
    },
  };
  const result = await credentials({ DB: db, GUMLOOP_API_KEY: 'owner-api-key', GUMLOOP_USER_ID: 'owner-user', ENCRYPTION_KEY: 'c'.repeat(64) }, 'owner');
  assert.equal(result, null, 'a deleted connection must not resurrect environment credentials after disconnect');
});

test('an in-flight visitor bootstrap cannot mint a token after disconnect and reconnect', async t => {
  const app = await fixture(t); const guest = await app.signupGuest();
  const widget = await app.publishedWidget(guest.cookie);
  const response = await app.request(`/v1/widgets/${widget.id}/visitors`, { origin: site, body: {}, disconnectRace: true });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await app.db.prepare('SELECT count(*) AS count FROM visitors WHERE widget_id=?').bind(widget.id).first()).count, 0);
  const fresh = await app.request(`/v1/widgets/${widget.id}/visitors`, { origin: site, body: {} });
  assert.equal(fresh.status, 201, 'a fresh request captures the new generation');
});

test('an in-flight preview cannot mint a token after disconnect and reconnect', async t => {
  const app = await fixture(t); const guest = await app.signupGuest();
  const widget = await app.publishedWidget(guest.cookie);
  const response = await app.request(`/api/studio/widgets/${widget.id}/preview`, { cookie: guest.cookie, body: {}, disconnectRace: true });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await app.db.prepare('SELECT count(*) AS count FROM previews WHERE widget_id=?').bind(widget.id).first()).count, 0);
  const fresh = await app.request(`/api/studio/widgets/${widget.id}/preview`, { cookie: guest.cookie, body: {} });
  assert.equal(fresh.status, 200, 'a fresh preview captures the new generation');
});
