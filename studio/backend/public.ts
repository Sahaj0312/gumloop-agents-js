import type { PendingApproval, Session } from '../../src/types.js';
import { bad, body, callOptions, hash, json, object, only, safeError, text, token, type WidgetConfig } from './common.js';
import { client, quota, widget } from './data.js';

interface Visitor { token_hash: string; widget_id: string; origin: string; preview_hash: string; expires_at: number }
interface Conversation { id: string; visitor_hash: string; upstream_id: string; state: string; lock_token: string | null; lock_until: number; active_until: number }
const knownStates = new Set(['idle', 'processing', 'queued', 'completed', 'failed', 'approval_required']);
const state = (value: unknown) => typeof value === 'string' && knownStates.has(value) ? value : 'unknown';
function question(value: unknown): Record<string, unknown> {
  if (!object(value)) return {};
  const result: Record<string, unknown> = {};
  for (const name of ['type', 'name', 'title', 'prompt']) if (typeof value[name] === 'string') result[name] = value[name];
  if (typeof value.required === 'boolean') result.required = value.required;
  if (Array.isArray(value.options)) result.options = value.options.filter(option => object(option) && typeof option.value === 'string').map(option => ({ value: option.value, ...(typeof option.label === 'string' ? { label: option.label } : {}) }));
  if (object(value.custom_option)) result.custom_option = { label: typeof value.custom_option.label === 'string' ? value.custom_option.label : 'Other' };
  if (value.condition) result.condition = true;
  return result;
}
export function project(session: Session, id: string) {
  const asks = session.pending_approvals ?? [];
  return { id, state: state(session.state), messages: (session.messages ?? []).filter(message => ['user', 'assistant'].includes(message.role ?? '')).map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : (message.parts ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') })).filter(message => message.content),
    pending_approvals: asks.filter(ask => ask.type === 'human_input' && typeof ask.action_request_id === 'string').map(ask => ({ action_request_id: ask.action_request_id, type: 'human_input', ...(typeof ask.title === 'string' ? { title: ask.title } : {}), ...(typeof ask.reason === 'string' ? { reason: ask.reason } : {}), questions: (ask.questions ?? []).map(question) })),
    owner_intervention_required: asks.some(ask => ask.type !== 'human_input') || (session.state === 'approval_required' && !asks.length),
  };
}
function decisions(input: Record<string, unknown>, session: Session) {
  only(input, ['approval_responses']);
  if (session.state !== 'approval_required' || !Array.isArray(input.approval_responses) || !input.approval_responses.length || input.approval_responses.length > 20) return bad(400, 'No valid questions were answered.');
  const pending = new Map((session.pending_approvals ?? []).map(ask => [ask.action_request_id, ask])); const seen = new Set<string>();
  return input.approval_responses.map(value => {
    if (!object(value)) return bad(400, 'Invalid question answer.'); only(value, ['action_request_id', 'action', 'response']);
    const id = text(value.action_request_id, 'question ID'); const ask: PendingApproval | undefined = pending.get(id);
    if (!ask || ask.type !== 'human_input' || seen.has(id)) return bad(403, 'This question cannot be answered through the website.'); seen.add(id);
    if (value.action === 'reject') return { action_request_id: id, action: 'reject' as const };
    if (value.action !== 'accept' || !object(value.response) || !object(value.response.values)) return bad(400, 'Question answers are required.');
    only(value.response, ['values']); const values = value.response.values;
    const questions = ask.questions ?? [];
    if (!questions.length || questions.some(item => item.type !== 'toggle_group' || item.condition || !Array.isArray(item.options))) return bad(409, 'This form needs help from the website owner.');
    const names = new Set(questions.map(item => item.name));
    if (Object.keys(values).some(name => !names.has(name))) return bad(400, 'Unknown question answer.');
    for (const item of questions) { const answer = typeof item.name === 'string' ? values[item.name] : undefined; if (answer === undefined && item.required !== true) continue; if (typeof answer !== 'string' || !(item.options as unknown[]).some(option => object(option) && option.value === answer)) return bad(400, 'Choose one of the listed answers.'); }
    return { action_request_id: id, action: 'accept' as const, response: { values } };
  });
}
async function updateState(env: Env, id: string, session: Session, operationFinished = false) {
  const activeUntil = ['processing', 'queued'].includes(session.state ?? '') ? Date.now() + 180000 : knownStates.has(session.state ?? '') ? 0 : Date.now() + 180000;
  await env.DB.prepare('UPDATE conversations SET state=?,active_until=CASE WHEN ?=0 AND ?=0 AND lock_until>? AND lock_token IS NOT NULL THEN active_until ELSE ? END WHERE id=?').bind(state(session.state), activeUntil, operationFinished ? 1 : 0, Date.now(), activeUntil, id).run();
}
export async function handlePublic(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url); const match = /^\/v1\/widgets\/([\w-]+)\/(config|visitors|sessions)(?:\/([\w-]+)(?:\/(messages|cancel|approvals))?)?$/.exec(url.pathname);
  if (!match || url.search) return bad(404, 'Route not found.');
  const [, widgetId, resource, id, action] = match;
  const row = await widget(env, widgetId!);
  const origin = request.headers.get('origin') ?? (request.headers.get('sec-fetch-site') === 'same-origin' ? url.origin : null);
  let previewHash = ''; let appearance: WidgetConfig; let expires = Date.now() + 7 * 86400000;
  const previewToken = request.headers.get('x-widget-preview');
  if (previewToken) {
    if (!/^[a-f0-9]{64}$/.test(previewToken)) return bad(403, 'This preview has expired. Open a new preview in the studio.');
    previewHash = await hash(previewToken);
    const preview = await env.DB.prepare('SELECT config,origin,expires_at FROM previews WHERE token_hash=? AND widget_id=? AND expires_at>?').bind(previewHash, widgetId, Date.now()).first<{ config: string; origin: string; expires_at: number }>();
    if (!preview || origin !== preview.origin || origin !== url.origin) return bad(403, 'This preview has expired. Open a new preview in the studio.');
    appearance = JSON.parse(preview.config); expires = Math.min(expires, preview.expires_at);
  } else {
    if (!row.published_config || !origin || !(JSON.parse(row.published_origins) as string[]).includes(origin)) return bad(403, 'This website is not allowed to use this widget.');
    appearance = JSON.parse(row.published_config);
  }
  const headers = new Headers({ 'Access-Control-Allow-Origin': origin!, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Widget-Preview', 'Access-Control-Expose-Headers': 'Retry-After', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  // Preflight cannot carry the preview secret. See special handler below.
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    await quota(env, 'public-global', 1200);
    if (resource === 'config' && !id && request.method === 'GET') return json(appearance, 200, headers);
    if (resource === 'visitors' && !id && request.method === 'POST') {
      const input = await body(request, 16384); only(input, []);
      await quota(env, `bootstrap:${await hash(request.headers.get('cf-connecting-ip') ?? 'local')}`, 20);
      await quota(env, 'bootstrap-global', 200);
      const value = token();
      await env.DB.prepare('INSERT INTO visitors(token_hash,widget_id,origin,preview_hash,expires_at) VALUES(?,?,?,?,?)').bind(await hash(value), widgetId, origin, previewHash, expires).run();
      return json({ visitorToken: value }, 201, headers);
    }
    if (resource !== 'sessions') return bad(404, 'Route not found.');
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
    if (!bearer) return bad(401, 'Start a new chat to reconnect.');
    const visitorHash = await hash(bearer[1]!);
    const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE token_hash=? AND expires_at>?').bind(visitorHash, Date.now()).first<Visitor>();
    if (!visitor || visitor.widget_id !== widgetId || visitor.origin !== origin || visitor.preview_hash !== previewHash) return bad(401, 'Start a new chat to reconnect.');
    await quota(env, `visitor-requests:${visitorHash}`, 240);
    const gumloop = await client(env);
    if (!id && request.method === 'POST') {
      const input = await body(request, 16384); only(input, []);
      await quota(env, `session-create:${visitorHash}`, 10); await quota(env, 'session-create-global', 60);
      const localId = `chat_${crypto.randomUUID().replaceAll('-', '')}`;
      // Reserve a durable conversation row first so concurrent creates respect the cap.
      const reserve = await env.DB.prepare('INSERT INTO conversations(id,visitor_hash,upstream_id,state,created_at) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM conversations WHERE visitor_hash=?)<20').bind(localId, visitorHash, '', 'creating', Date.now(), visitorHash).run();
      if (!reserve.meta.changes) return bad(429, 'Conversation limit reached. Please contact the website owner.');
      try {
        const { session } = await gumloop.sessions.create(row.agent_id, {}, callOptions());
        await env.DB.prepare('UPDATE conversations SET upstream_id=?,state=? WHERE id=?').bind(session.id, state(session.state), localId).run();
        return json({ sessionId: localId }, 201, headers);
      } catch (error) { await env.DB.prepare('DELETE FROM conversations WHERE id=?').bind(localId).run(); throw error; }
    }
    if (!id) return bad(404, 'Route not found.');
    const conversation = await env.DB.prepare('SELECT * FROM conversations WHERE id=? AND visitor_hash=?').bind(id, visitorHash).first<Conversation>();
    if (!conversation || !conversation.upstream_id) return bad(404, 'Conversation not found.');
    const snapshot = async (operationFinished = false) => { const { session } = await gumloop.sessions.retrieve(conversation.upstream_id, callOptions()); await updateState(env, id, session, operationFinished); return session; };
    if (!action && request.method === 'GET') return json({ session: project(await snapshot(), id) }, 200, headers);
    if (!action || request.method !== 'POST') return bad(404, 'Route not found.');
    const input = await body(request, 16384);
    if (action === 'cancel') {
      only(input, []); const now = Date.now();
      const claim = await env.DB.prepare('UPDATE conversations SET cancel_until=? WHERE id=? AND cancel_until<?').bind(now + 30000, id, now).run();
      if (!claim.meta.changes) return bad(409, 'A stop request is already in progress.');
      try { await gumloop.sessions.cancel(conversation.upstream_id, callOptions()); return json({ session: project(await snapshot(), id) }, 200, headers); }
      finally { await env.DB.prepare('UPDATE conversations SET cancel_until=0 WHERE id=?').bind(id).run(); }
    }
    const lock = token(); const now = Date.now();
    const claim = await env.DB.prepare('UPDATE conversations SET lock_token=?,lock_until=? WHERE id=? AND lock_until<? AND cancel_until<?').bind(lock, now + 210000, id, now, now).run();
    if (!claim.meta.changes) return bad(409, 'This conversation is already processing a request.');
    const release = async () => { await env.DB.prepare('UPDATE conversations SET lock_token=NULL,lock_until=0 WHERE id=? AND lock_token=?').bind(id, lock).run(); };
    let handedToStream = false;
    try {
      if (action === 'messages') { only(input, ['input']); text(input.input, 'message', 8000); }
      const current = await snapshot();
      if (action === 'messages' && (!['idle', 'completed', 'failed'].includes(current.state ?? '') || current.pending_approvals?.length)) return bad(409, 'Finish the current request before sending another message.');
      const answers = action === 'approvals' ? decisions(input, current) : undefined;
      await quota(env, `message:${visitorHash}`, 15); await quota(env, 'message-global', 60); await quota(env, 'message-daily', 2000, 86400);
      // Reconcile bounded stale slots before enforcing the account-wide concurrency cap.
      const active = await env.DB.prepare('SELECT id,upstream_id FROM conversations WHERE active_until>0 AND lock_until<? AND id<>? LIMIT 4').bind(Date.now(), id).all<{ id: string; upstream_id: string }>();
      for (const other of active.results) { try { const { session } = await gumloop.sessions.retrieve(other.upstream_id, callOptions()); await updateState(env, other.id, session); } catch { /* Keep unknown tasks reserved. */ } }
      const reserve = await env.DB.prepare('UPDATE conversations SET active_until=?,state=\'processing\' WHERE id=? AND (SELECT count(*) FROM conversations WHERE active_until>0 AND id<>?)<4').bind(Date.now() + 210000, id, id).run();
      if (!reserve.meta.changes) return bad(429, 'Chat is busy. Please try again later.');
      if (answers) {
        try { await gumloop.sessions.resolveApprovals(conversation.upstream_id, { approval_responses: answers }, callOptions()); return json({ session: project(await snapshot(true), id) }, 200, headers); }
        catch (error) { try { await snapshot(); } catch {} throw error; }
      }
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(); const writer = writable.getWriter();
      const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); ctx.waitUntil(writer.abort('Stream timed out').catch(() => {})); }, 180000);
      const encode = new TextEncoder();
      const emit = (type: string, value: unknown) => writer.write(encode.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`));
      ctx.waitUntil(writer.closed.catch(() => { controller.abort(); }));
      const run = async () => {
        try {
          await emit('state', { state: 'processing' });
          for await (const event of gumloop.sessions.streamMessage(conversation.upstream_id, { input: input.input as string }, { signal: controller.signal })) {
            if (event.type === 'text-delta' && typeof event.delta === 'string' && !event.parentToolCallId) await emit('text', { delta: event.delta });
            if (event.type === 'error' || event.error || event.errorMessage) await emit('error', { message: 'The agent could not finish this response. Refresh its status.' });
          }
        } catch { try { await emit('error', { message: 'The connection was interrupted. Refresh the conversation status before trying again.' }); } catch {} }
        finally {
          controller.abort();
          try { await emit('state', { state: state((await snapshot(true)).state) }); } catch { /* Do not invent completion on an interrupted stream. */ }
          try { await release(); } finally { try { await writer.close(); } catch {} clearTimeout(timer); }
        }
      };
      ctx.waitUntil(run()); handedToStream = true;
      headers.set('Content-Type', 'text/event-stream; charset=utf-8'); headers.set('X-Accel-Buffering', 'no');
      return new Response(readable, { headers });
    } finally { if (!handedToStream) await release(); }
  } catch (error) { const visible = safeError(error); if (visible.status === 429) headers.set('Retry-After', '60'); return json({ error: visible.message }, visible.status, headers); }
}

/** A preflight only checks the site's admissibility; actual requests still validate tokens. */
export async function publicPreflight(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const id = /^\/v1\/widgets\/([\w-]+)\//.exec(url.pathname)?.[1];
  if (!id) return bad(404, 'Route not found.');
  const origin = request.headers.get('origin'); const row = await widget(env, id);
  const requested = (request.headers.get('access-control-request-headers') ?? '').toLowerCase();
  const previewPossible = origin === url.origin && requested.split(',').map(part => part.trim()).includes('x-widget-preview');
  if (!origin || (!previewPossible && (!row.published_config || !(JSON.parse(row.published_origins) as string[]).includes(origin)))) return bad(403, 'Website not allowed.');
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Widget-Preview', 'Cache-Control': 'no-store' } });
}
