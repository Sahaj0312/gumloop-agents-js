import { Gumloop } from '../../src/client.js';
import type { Agent } from '../../src/types.js';
import { bad, body, callOptions, config, defaults, equalSecret, hash, json, only, origins, sameOrigin, text, token } from './common.js';
import { authenticate, client, cookie, createSession, credentials, encrypt, quota, sessionCookie, workspace, widget, widgetJSON, type WidgetRow, type WorkspaceIdentity } from './data.js';

function agentJSON(agent: Agent) { return { id: agent.id, name: agent.name, description: agent.description ?? '', model_name: agent.model_name ?? '', system_prompt: agent.system_prompt ?? '', team_id: agent.team_id ?? null, ...(agent.creator ? { creator: agent.creator } : {}) }; }
async function upstreamJSON(env: Env, workspaceId: string, path: string): Promise<Record<string, unknown>> {
  const creds = await credentials(env, workspaceId); if (!creds) return bad(503, 'Connect your Gumloop account first.');
  const response = await fetch(`https://api.gumloop.com/api/v1/${path}`, { headers: { Authorization: `Bearer ${creds.apiKey}`, 'x-auth-key': creds.userId }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  if (!response.ok) return bad(502, 'Gumloop could not complete this request.');
  return response.json<Record<string, unknown>>();
}
export async function handleStudio(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.slice('/api/studio'.length);
  const method = request.method;
  if (!['GET', 'POST', 'PATCH'].includes(method)) return bad(405, 'Method not allowed.');
  if (method !== 'GET') sameOrigin(request);
  if (path === '/signup' && method === 'POST') {
    if (await authenticate(request, env)) return bad(409, 'Sign out before creating a separate workspace.');
    await quota(env, `signup:${await hash(request.headers.get('cf-connecting-ip') ?? 'local')}`, 5, 3600);
    await quota(env, 'signup-global', 50, 3600);
    const input = await body(request, 8192);
    only(input, ['name', 'apiKey', 'userId']);
    const name = text(input.name, 'workspace name', 80);
    const apiKey = text(input.apiKey, 'API key', 4096);
    const userId = text(input.userId, 'user ID', 512);
    try { await new Gumloop({ apiKey, userId }).agents.list({}, callOptions()); }
    catch { return bad(400, 'Gumloop did not accept that API key and user ID.'); }
    const id = `ws_${crypto.randomUUID().replaceAll('-', '')}`;
    const accessCode = `relay_${token()}`;
    const accessHash = await hash(accessCode);
    const sessionToken = token();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO workspaces(id,name,access_hash,account_hash,created_at) VALUES(?,?,?,?,?)')
        .bind(id, name, accessHash, await hash(userId), now),
      env.DB.prepare('INSERT INTO connections(workspace_id,ciphertext,encryption_version,updated_at) VALUES(?,?,2,?)')
        .bind(id, await encrypt({ apiKey, userId }, env.ENCRYPTION_KEY, id), now),
      env.DB.prepare('INSERT INTO owner_sessions(token_hash,password_hash,expires_at,workspace_id) VALUES(?,?,?,?)')
        .bind(await hash(sessionToken), accessHash, now + 43200000, id),
    ]);
    return json({ accessCode, workspace: { id, name } }, 201, { 'set-cookie': cookie(request, sessionToken) });
  }
  if (path === '/login' && method === 'POST') {
    await quota(env, `login:${await hash(request.headers.get('cf-connecting-ip') ?? 'local')}`, 10, 900);
    await quota(env, 'login-global', 100, 900);
    const input = await body(request, 4096); only(input, ['password']);
    const password = text(input.password, 'access code', 1024);
    let current: WorkspaceIdentity | null = null;
    if (env.STUDIO_PASSWORD && await equalSecret(password, env.STUDIO_PASSWORD)) {
      current = await workspace(env, 'owner');
    } else {
      current = await env.DB.prepare('SELECT id,name FROM workspaces WHERE access_hash=? AND id<>\'owner\'')
        .bind(await hash(password)).first<WorkspaceIdentity>();
    }
    if (!current) return bad(401, 'Incorrect access code or owner password.');
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, await createSession(env, current)) });
  }
  const authenticated = await authenticate(request, env);
  if (path === '/me' && method === 'GET') {
    const creds = authenticated ? await credentials(env, authenticated.id) : null;
    return json({ authenticated: Boolean(authenticated), connected: Boolean(creds),
      ...(authenticated ? { workspace: authenticated } : {}),
      ...(creds ? { account: { label: 'Connected Gumloop account', userId: creds.userId } } : {}),
    });
  }
  if (!authenticated) return bad(401, 'Sign in to your workspace.');
  const workspaceId = authenticated.id;
  await quota(env, `workspace:${workspaceId}:owner-requests`, 300);
  if (path === '/logout' && method === 'POST') {
    const input = await body(request); only(input, []);
    const value = sessionCookie(request);
    if (value) await env.DB.prepare('DELETE FROM owner_sessions WHERE token_hash=? AND workspace_id=?')
      .bind(await hash(value), workspaceId).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
  }
  if (path === '/disconnect' && method === 'POST') {
    const input = await body(request); only(input, []);
    // Resolve owner env credentials once so its account binding survives explicit disconnection.
    await credentials(env, workspaceId);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM conversations WHERE visitor_hash IN (SELECT v.token_hash FROM visitors v JOIN widgets w ON w.id=v.widget_id WHERE w.workspace_id=?)').bind(workspaceId),
      env.DB.prepare('DELETE FROM visitors WHERE widget_id IN (SELECT id FROM widgets WHERE workspace_id=?)').bind(workspaceId),
      env.DB.prepare('DELETE FROM previews WHERE widget_id IN (SELECT id FROM widgets WHERE workspace_id=?)').bind(workspaceId),
      env.DB.prepare('DELETE FROM connections WHERE workspace_id=?').bind(workspaceId),
      env.DB.prepare('UPDATE workspaces SET connection_disabled=1,connection_version=connection_version+1,connection_nonce=NULL WHERE id=?').bind(workspaceId),
      env.DB.prepare('UPDATE widgets SET published_config=NULL,published_origins=\'[]\',published_at=NULL,version=version+1,updated_at=? WHERE workspace_id=?').bind(Date.now(), workspaceId),
    ]);
    return json({ ok: true });
  }
  if (path === '/connection' && method === 'POST') {
    const input = await body(request, 8192); only(input, ['apiKey', 'userId']);
    const apiKey = text(input.apiKey, 'API key', 4096);
    const userId = text(input.userId, 'user ID', 512);
    await credentials(env, workspaceId);
    const current = await workspace(env, workspaceId);
    const accountHash = await hash(userId);
    if (current.account_hash && current.account_hash !== accountHash) {
      return bad(409, 'This workspace is linked to another Gumloop account. Create a new workspace for a different account.');
    }
    try { await new Gumloop({ apiKey, userId }).agents.list({}, callOptions()); }
    catch { return bad(400, 'Gumloop did not accept that API key and user ID.'); }
    const nonce = token();
    const result = await env.DB.batch([
      env.DB.prepare('UPDATE workspaces SET account_hash=?,connection_disabled=0,connection_version=connection_version+1,connection_nonce=? WHERE id=? AND connection_version=? AND (account_hash IS NULL OR account_hash=?)')
        .bind(accountHash, nonce, workspaceId, current.connection_version, accountHash),
      env.DB.prepare('INSERT INTO connections(workspace_id,ciphertext,encryption_version,updated_at) SELECT ?,?,2,? FROM workspaces WHERE id=? AND account_hash=? AND connection_disabled=0 AND connection_nonce=? ON CONFLICT(workspace_id) DO UPDATE SET ciphertext=excluded.ciphertext,encryption_version=2,updated_at=excluded.updated_at')
        .bind(workspaceId, await encrypt({ apiKey, userId }, env.ENCRYPTION_KEY, workspaceId), Date.now(), workspaceId, accountHash, nonce),
    ]);
    if (!result[0]?.meta.changes) return bad(409, 'The connection changed while saving. Refresh before trying again.');
    return json({ ok: true });
  }
  if (path === '/agents' && method === 'GET') {
    const search = url.searchParams.get('search') ?? undefined; const teamId = url.searchParams.get('teamId') ?? undefined;
    const response = await (await client(env, workspaceId)).agents.list({ search, teamId }, callOptions());
    const agents = [...response.agents]; let next = response.next_cursor; const cursors = new Set<string>();
    while (next && agents.length < 500 && !cursors.has(next)) {
      cursors.add(next); const params = new URLSearchParams({ cursor: next }); if (search) params.set('search', search); if (teamId) params.set('team_id', teamId);
      const page = await upstreamJSON(env, workspaceId, `agents?${params}`);
      if (!Array.isArray(page.agents)) break;
      agents.push(...page.agents as Agent[]); next = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
    }
    return json({ agents: agents.slice(0, 500).map(agentJSON), next_cursor: next ?? null, truncated: agents.length > 500 || Boolean(next) });
  }
  const agentMatch = /^\/agents\/([^/]+)$/.exec(path);
  if (agentMatch && (method === 'GET' || method === 'PATCH')) {
    const agentId = decodeURIComponent(agentMatch[1]!); const gumloop = await client(env, workspaceId);
    if (method === 'GET') return json({ agent: agentJSON((await gumloop.agents.retrieve(agentId, callOptions())).agent) });
    const input = await body(request); only(input, ['name', 'description', 'system_prompt', 'model_name']);
    if (!Object.keys(input).length) return bad(400, 'Choose a field to update.');
    const update: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) update[key] = text(value, key, key === 'system_prompt' ? 50000 : key === 'description' ? 2000 : 256, ['description', 'system_prompt'].includes(key));
    const updated = (await gumloop.agents.update(agentId, update, callOptions())).agent;
    if (update.name !== undefined) await env.DB.prepare('UPDATE widgets SET agent_name=? WHERE agent_id=? AND workspace_id=?').bind(updated.name, agentId, workspaceId).run();
    return json({ agent: agentJSON(updated) });
  }
  if (path === '/models' && method === 'GET') {
    const response = await upstreamJSON(env, workspaceId, 'models'); return json({ models: Array.isArray(response.models) ? response.models : [] });
  }
  if (path === '/widgets' && method === 'GET') return json({ widgets: (await env.DB.prepare('SELECT * FROM widgets WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 200').bind(workspaceId).all<WidgetRow>()).results.map(widgetJSON) });
  if (path === '/widgets' && method === 'POST') {
    const input = await body(request); only(input, ['name', 'agentId']);
    const name = text(input.name, 'widget name', 80); const agentId = text(input.agentId, 'agent ID', 512);
    const connection = await workspace(env, workspaceId);
    const agent = (await (await client(env, workspaceId)).agents.retrieve(agentId, callOptions())).agent;
    const id = `w_${crypto.randomUUID().replaceAll('-', '')}`;
    const result = await env.DB.prepare('INSERT INTO widgets(id,name,agent_id,agent_name,config,updated_at,workspace_id) SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM widgets WHERE workspace_id=?)<200 AND EXISTS(SELECT 1 FROM workspaces WHERE id=? AND connection_disabled=0 AND connection_version=?)').bind(id, name, agentId, agent.name, JSON.stringify(defaults), Date.now(), workspaceId, workspaceId, workspaceId, connection.connection_version).run();
    if (!result.meta.changes) return bad(409, 'The workspace connection changed or its 200-widget limit was reached.');
    return json({ widget: widgetJSON(await widget(env, id, workspaceId)) }, 201);
  }
  const match = /^\/widgets\/([\w-]+)(?:\/(publish|unpublish|preview))?$/.exec(path);
  if (!match) return bad(404, 'Route not found.');
  const id = match[1]!; const action = match[2]; const current = await widget(env, id, workspaceId);
  if (method === 'GET' && !action) return json({ widget: widgetJSON(current) });
  const input = await body(request);
  if (method === 'PATCH' && !action) {
    only(input, ['name', 'config', 'allowedOrigins', 'version']);
    if (!Number.isInteger(input.version) || input.version !== current.version) return bad(409, 'This widget changed in another tab. Reload it before saving.');
    const name = input.name === undefined ? current.name : text(input.name, 'widget name', 80);
    const appearance = input.config === undefined ? JSON.parse(current.config) : config(input.config, JSON.parse(current.config));
    const sites = input.allowedOrigins === undefined ? JSON.parse(current.allowed_origins) : origins(input.allowedOrigins);
    const result = await env.DB.prepare('UPDATE widgets SET name=?,config=?,allowed_origins=?,version=version+1,updated_at=? WHERE id=? AND version=? AND workspace_id=?').bind(name, JSON.stringify(appearance), JSON.stringify(sites), Date.now(), id, input.version, workspaceId).run();
    if (!result.meta.changes) return bad(409, 'This widget changed in another tab. Reload it before saving.');
    return json({ widget: widgetJSON(await widget(env, id, workspaceId)) });
  }
  if (method === 'POST' && action === 'publish') {
    await client(env, workspaceId);
    only(input, ['version']); if (!Number.isInteger(input.version) || input.version !== current.version) return bad(409, 'Save or reload the draft before publishing.');
    if (!origins(JSON.parse(current.allowed_origins)).length) return bad(400, 'Add at least one allowed website origin before publishing.');
    const result = await env.DB.prepare('UPDATE widgets SET published_config=config,published_origins=allowed_origins,published_at=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND workspace_id=?').bind(Date.now(), Date.now(), id, input.version, workspaceId).run();
    if (!result.meta.changes) return bad(409, 'The draft changed. Reload it before publishing.');
    return json({ widget: widgetJSON(await widget(env, id, workspaceId)), embedCode: `<script src="${url.origin}/widget.js" data-widget-id="${id}" defer></script>` });
  }
  if (method === 'POST' && action === 'unpublish') {
    only(input, []); await env.DB.prepare('UPDATE widgets SET published_config=NULL,published_origins=\'[]\',published_at=NULL,updated_at=?,version=version+1 WHERE id=? AND workspace_id=?').bind(Date.now(), id, workspaceId).run();
    return json({ widget: widgetJSON(await widget(env, id, workspaceId)) });
  }
  if (method === 'POST' && action === 'preview') {
    const connection = await workspace(env, workspaceId);
    await client(env, workspaceId);
    only(input, ['config']); await quota(env, `workspace:${workspaceId}:owner-previews`, 60);
    const appearance = input.config === undefined ? JSON.parse(current.config) : config(input.config, JSON.parse(current.config));
    const value = token();
    const created = await env.DB.prepare('INSERT INTO previews(token_hash,widget_id,origin,config,expires_at) SELECT ?,?,?,?,? FROM workspaces WHERE id=? AND connection_disabled=0 AND connection_version=?')
      .bind(await hash(value), id, url.origin, JSON.stringify(appearance), Date.now() + 1800000, workspaceId, connection.connection_version).run();
    if (!created.meta.changes) return bad(409, 'The connection changed. Refresh before opening a preview.');
    return json({ previewUrl: `${url.origin}/preview.html?widget=${encodeURIComponent(id)}&token=${value}` });
  }
  return bad(405, 'Method not allowed.');
}
