import { Gumloop } from '../../src/client.js';
import type { Agent } from '../../src/types.js';
import { bad, body, callOptions, config, defaults, equalSecret, hash, json, only, origins, sameOrigin, text, token } from './common.js';
import { client, cookie, createOwnerSession, credentials, encrypt, owner, quota, widget, widgetJSON, type WidgetRow } from './data.js';

function agentJSON(agent: Agent) { return { id: agent.id, name: agent.name, description: agent.description ?? '', model_name: agent.model_name ?? '', system_prompt: agent.system_prompt ?? '', team_id: agent.team_id ?? null, ...(agent.creator ? { creator: agent.creator } : {}) }; }
async function upstreamJSON(env: Env, path: string): Promise<Record<string, unknown>> {
  const creds = await credentials(env); if (!creds) return bad(503, 'Connect your Gumloop account first.');
  const response = await fetch(`https://api.gumloop.com/api/v1/${path}`, { headers: { Authorization: `Bearer ${creds.apiKey}`, 'x-auth-key': creds.userId }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  if (!response.ok) return bad(502, 'Gumloop could not complete this request.');
  return response.json<Record<string, unknown>>();
}
export async function handleStudio(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.slice('/api/studio'.length);
  const method = request.method;
  if (!['GET', 'POST', 'PATCH'].includes(method)) return bad(405, 'Method not allowed.');
  if (method !== 'GET') sameOrigin(request);
  if (path === '/login' && method === 'POST') {
    await quota(env, `login:${await hash(request.headers.get('cf-connecting-ip') ?? 'local')}`, 10, 900);
    await quota(env, 'login-global', 100, 900);
    const input = await body(request, 4096); only(input, ['password']);
    const password = text(input.password, 'password', 1024);
    if (!env.STUDIO_PASSWORD || !(await equalSecret(password, env.STUDIO_PASSWORD))) return bad(401, 'Incorrect password.');
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, await createOwnerSession(env)) });
  }
  const authenticated = await owner(request, env);
  if (path === '/me' && method === 'GET') {
    const connected = authenticated && Boolean(await credentials(env));
    return json({ authenticated, connected, ...(connected ? { account: { label: 'Connected Gumloop account' } } : {}) });
  }
  if (!authenticated) return bad(401, 'Sign in to your workspace.');
  await quota(env, 'owner-requests', 300);
  if (path === '/logout' && method === 'POST') {
    const input = await body(request); only(input, []);
    const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('relay_owner='))?.slice(12);
    if (value) await env.DB.prepare('DELETE FROM owner_sessions WHERE token_hash=?').bind(await hash(value)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
  }
  if (path === '/connection' && method === 'POST') {
    const input = await body(request, 8192); only(input, ['apiKey', 'userId']);
    const apiKey = text(input.apiKey, 'API key', 4096); const userId = text(input.userId, 'user ID', 512);
    const previous = await credentials(env);
    const count = await env.DB.prepare('SELECT count(*) AS count FROM widgets').first<{ count: number }>();
    if (count?.count && previous && previous.userId !== userId) return bad(409, 'This workspace already has widgets. Rotate a key for the same Gumloop account.');
    try { await new Gumloop({ apiKey, userId }).agents.list({}, callOptions()); } catch { return bad(400, 'Gumloop did not accept that API key and user ID.'); }
    await env.DB.prepare('INSERT INTO connections(id,ciphertext,account_hash,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,account_hash=excluded.account_hash,updated_at=excluded.updated_at').bind(await encrypt({ apiKey, userId }, env.ENCRYPTION_KEY), await hash(userId), Date.now()).run();
    return json({ ok: true });
  }
  if (path === '/agents' && method === 'GET') {
    const search = url.searchParams.get('search') ?? undefined; const teamId = url.searchParams.get('teamId') ?? undefined;
    const response = await (await client(env)).agents.list({ search, teamId }, callOptions());
    const agents = [...response.agents]; let next = response.next_cursor; const cursors = new Set<string>();
    while (next && agents.length < 500 && !cursors.has(next)) {
      cursors.add(next); const params = new URLSearchParams({ cursor: next }); if (search) params.set('search', search); if (teamId) params.set('team_id', teamId);
      const page = await upstreamJSON(env, `agents?${params}`);
      if (!Array.isArray(page.agents)) break;
      agents.push(...page.agents as Agent[]); next = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
    }
    return json({ agents: agents.slice(0, 500).map(agentJSON), next_cursor: next ?? null, truncated: agents.length > 500 || Boolean(next) });
  }
  const agentMatch = /^\/agents\/([^/]+)$/.exec(path);
  if (agentMatch && (method === 'GET' || method === 'PATCH')) {
    const agentId = decodeURIComponent(agentMatch[1]!); const gumloop = await client(env);
    if (method === 'GET') return json({ agent: agentJSON((await gumloop.agents.retrieve(agentId, callOptions())).agent) });
    const input = await body(request); only(input, ['name', 'description', 'system_prompt', 'model_name']);
    if (!Object.keys(input).length) return bad(400, 'Choose a field to update.');
    const update: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) update[key] = text(value, key, key === 'system_prompt' ? 50000 : key === 'description' ? 2000 : 256, ['description', 'system_prompt'].includes(key));
    const updated = (await gumloop.agents.update(agentId, update, callOptions())).agent;
    if (update.name !== undefined) await env.DB.prepare('UPDATE widgets SET agent_name=? WHERE agent_id=?').bind(updated.name, agentId).run();
    return json({ agent: agentJSON(updated) });
  }
  if (path === '/models' && method === 'GET') {
    const response = await upstreamJSON(env, 'models'); return json({ models: Array.isArray(response.models) ? response.models : [] });
  }
  if (path === '/widgets' && method === 'GET') return json({ widgets: (await env.DB.prepare('SELECT * FROM widgets ORDER BY updated_at DESC LIMIT 200').all<WidgetRow>()).results.map(widgetJSON) });
  if (path === '/widgets' && method === 'POST') {
    const input = await body(request); only(input, ['name', 'agentId']);
    const name = text(input.name, 'widget name', 80); const agentId = text(input.agentId, 'agent ID', 512);
    const agent = (await (await client(env)).agents.retrieve(agentId, callOptions())).agent;
    const id = `w_${crypto.randomUUID().replaceAll('-', '')}`;
    const result = await env.DB.prepare('INSERT INTO widgets(id,name,agent_id,agent_name,config,updated_at) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM widgets)<200').bind(id, name, agentId, agent.name, JSON.stringify(defaults), Date.now()).run();
    if (!result.meta.changes) return bad(409, 'This workspace has reached its 200-widget limit.');
    return json({ widget: widgetJSON(await widget(env, id)) }, 201);
  }
  const match = /^\/widgets\/([\w-]+)(?:\/(publish|unpublish|preview))?$/.exec(path);
  if (!match) return bad(404, 'Route not found.');
  const id = match[1]!; const action = match[2]; const current = await widget(env, id);
  if (method === 'GET' && !action) return json({ widget: widgetJSON(current) });
  const input = await body(request);
  if (method === 'PATCH' && !action) {
    only(input, ['name', 'config', 'allowedOrigins', 'version']);
    if (!Number.isInteger(input.version) || input.version !== current.version) return bad(409, 'This widget changed in another tab. Reload it before saving.');
    const name = input.name === undefined ? current.name : text(input.name, 'widget name', 80);
    const appearance = input.config === undefined ? JSON.parse(current.config) : config(input.config, JSON.parse(current.config));
    const sites = input.allowedOrigins === undefined ? JSON.parse(current.allowed_origins) : origins(input.allowedOrigins);
    const result = await env.DB.prepare('UPDATE widgets SET name=?,config=?,allowed_origins=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(name, JSON.stringify(appearance), JSON.stringify(sites), Date.now(), id, input.version).run();
    if (!result.meta.changes) return bad(409, 'This widget changed in another tab. Reload it before saving.');
    return json({ widget: widgetJSON(await widget(env, id)) });
  }
  if (method === 'POST' && action === 'publish') {
    only(input, ['version']); if (!Number.isInteger(input.version) || input.version !== current.version) return bad(409, 'Save or reload the draft before publishing.');
    if (!origins(JSON.parse(current.allowed_origins)).length) return bad(400, 'Add at least one allowed website origin before publishing.');
    const result = await env.DB.prepare('UPDATE widgets SET published_config=config,published_origins=allowed_origins,published_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?').bind(Date.now(), Date.now(), id, input.version).run();
    if (!result.meta.changes) return bad(409, 'The draft changed. Reload it before publishing.');
    return json({ widget: widgetJSON(await widget(env, id)), embedCode: `<script src="${url.origin}/widget.js" data-widget-id="${id}" defer></script>` });
  }
  if (method === 'POST' && action === 'unpublish') {
    only(input, []); await env.DB.prepare('UPDATE widgets SET published_config=NULL,published_origins=\'[]\',published_at=NULL,updated_at=?,version=version+1 WHERE id=?').bind(Date.now(), id).run();
    return json({ widget: widgetJSON(await widget(env, id)) });
  }
  if (method === 'POST' && action === 'preview') {
    only(input, ['config']); await quota(env, 'owner-previews', 60);
    const appearance = input.config === undefined ? JSON.parse(current.config) : config(input.config, JSON.parse(current.config));
    const value = token(); await env.DB.prepare('INSERT INTO previews(token_hash,widget_id,origin,config,expires_at) VALUES(?,?,?,?,?)').bind(await hash(value), id, url.origin, JSON.stringify(appearance), Date.now() + 1800000).run();
    return json({ previewUrl: `${url.origin}/preview.html?widget=${encodeURIComponent(id)}&token=${value}` });
  }
  return bad(405, 'Method not allowed.');
}
