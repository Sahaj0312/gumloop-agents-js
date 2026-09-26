import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryStore, createFileStore } from './store.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const states = new Set(['idle', 'processing', 'queued', 'completed', 'failed', 'approval_required']);
const terminal = state => ['idle', 'completed', 'failed', 'approval_required'].includes(state);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, public: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keysOnly(value, keys) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail(400, 'Unexpected request fields.'); }
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
function safeState(state) { return states.has(state) ? state : 'unknown'; }
function publicError(error) {
  if (error.public) return { status: error.status, message: error.message };
  if (error.status === 429) return { status: 429, message: 'The chat service is busy. Please try again later.' };
  if (error.status === 409) return { status: 409, message: 'This conversation is busy or has changed. Refresh its status before continuing.' };
  if (error.status === 400) return { status: 400, message: 'The chat service could not accept this request.' };
  return { status: 502, message: 'The chat service is temporarily unavailable. Refresh the conversation before trying again.' };
}

function questionProjection(question) {
  if (!object(question)) return {};
  const projected = {};
  for (const key of ['type', 'name', 'title', 'prompt']) if (typeof question[key] === 'string') projected[key] = question[key];
  if (typeof question.required === 'boolean') projected.required = question.required;
  if (Array.isArray(question.options)) projected.options = question.options.filter(option => object(option) && typeof option.value === 'string').map(option => ({ value: option.value, ...(typeof option.label === 'string' ? { label: option.label } : {}) }));
  if (question.custom_option) projected.custom_option = { label: typeof question.custom_option.label === 'string' ? question.custom_option.label : 'Other' };
  // Signal unsupported conditional forms without exposing the condition expression.
  if (question.condition) projected.condition = true;
  return projected;
}
export function projectSession(session, id) {
  const pending = Array.isArray(session.pending_approvals) ? session.pending_approvals : [];
  const messages = (Array.isArray(session.messages) ? session.messages : []).filter(message => ['user', 'assistant'].includes(message.role)).map(message => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : (Array.isArray(message.parts) ? message.parts : []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join(''),
  })).filter(message => message.content);
  return {
    id, state: safeState(session.state), messages,
    pending_approvals: pending.filter(ask => ask.type === 'human_input' && typeof ask.action_request_id === 'string').map(ask => ({
      action_request_id: ask.action_request_id, type: 'human_input',
      ...(typeof ask.title === 'string' ? { title: ask.title } : {}),
      ...(typeof ask.reason === 'string' ? { reason: ask.reason } : {}),
      questions: (Array.isArray(ask.questions) ? ask.questions : []).map(questionProjection),
    })),
    owner_intervention_required: pending.some(ask => ask.type !== 'human_input') || (session.state === 'approval_required' && pending.length === 0),
  };
}

async function readBody(request, { bodyBytes, bodyTimeoutMs }) {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw fail(415, 'Use application/json.');
  if (Number(request.headers['content-length']) > bodyBytes) throw fail(413, 'Request body is too large.');
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const clean = () => { clearTimeout(timer); request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAbort); };
    const stop = error => { clean(); request.resume(); reject(error); };
    const onError = () => stop(fail(400, 'Request body could not be read.'));
    const onAbort = () => stop(fail(400, 'Request was interrupted.'));
    const onData = chunk => { bytes += chunk.length; if (bytes > bodyBytes) stop(fail(413, 'Request body is too large.')); else chunks.push(chunk); };
    const onEnd = () => {
      clean();
      try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(value)) throw new Error(); resolve(value); }
      catch { reject(fail(400, 'Expected a JSON object.')); }
    };
    const timer = setTimeout(() => stop(fail(408, 'Request body timed out.')), bodyTimeoutMs);
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError); request.on('aborted', onAbort);
  });
}

/** Single-process server. CORS restricts browsers; rate limits bound anonymous use. */
export function createWidgetServer({ client, widgets = {}, store = createMemoryStore(), limits: overrides = {}, allowedHosts = [], now = Date.now } = {}) {
  const limits = {
    bodyBytes: 16384, bodyTimeoutMs: 10000, requestTimeoutMs: 30000, streamTimeoutMs: 180000,
    inputCharacters: 8000, visitorTtlMs: 7 * 86400000, maxVisitors: 10000, maxSessionsPerVisitor: 20,
    bootstrapPerIp: 20, sessionsPerVisitor: 10, messagesPerVisitor: 15, requestsPerVisitor: 240,
    globalRequests: 1200, globalMessages: 60, maxConcurrentRuns: 4, windowMs: 60000,
    ...overrides,
  };
  const configs = new Map();
  for (const [id, config] of Object.entries(widgets)) {
    if (!/^[\w-]{1,80}$/.test(id) || !config.agentId || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length) throw new Error('Widgets require an ID, agentId, and explicit allowedOrigins');
    for (const origin of config.allowedOrigins) if (!['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new Error('Allowed origins must be exact HTTP(S) origins');
    configs.set(id, { ...config, origins: new Set(config.allowedOrigins) });
  }
  const counters = new Map();
  const locks = new Set();
  const cancelling = new Set();
  const activeRuns = new Map();
  const controllers = new Set();
  const mutateLocks = new Set();
  let pendingVisitors = 0;
  function rate(key, cap) {
    const time = now();
    if (counters.size > 10000) for (const [name, entry] of counters) if (entry.until <= time) counters.delete(name);
    let entry = counters.get(key);
    if (!entry || entry.until <= time) {
      if (counters.size > 20000 && !entry) throw fail(429, 'Chat is busy. Please try again later.');
      entry = { count: 0, until: time + limits.windowMs }; counters.set(key, entry);
    }
    if (++entry.count > cap) throw fail(429, 'Too many requests. Please wait before trying again.');
  }
  async function upstream(callback) { return callback({ signal: AbortSignal.timeout(limits.requestTimeoutMs) }); }
  function observe(id, upstreamId, session) {
    if (terminal(session.state)) activeRuns.delete(id);
    else if (['processing', 'queued'].includes(session.state)) activeRuns.set(id, upstreamId);
  }
  async function snapshot(record, id) {
    const { session } = await upstream(options => client.sessions.retrieve(record.upstreamId, options));
    observe(id, record.upstreamId, session);
    return session;
  }
  function publicConfig(config) {
    return { title: config.title ?? 'Ask our team', welcome: config.welcome ?? 'How can I help?', accent: /^#[0-9a-fA-F]{6}$/.test(config.accent ?? '') ? config.accent : '#7455e8', position: config.position === 'left' ? 'left' : 'right' };
  }
  let sweeping = false;
  const sweeper = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const [id, upstreamId] of activeRuns) {
        if (locks.has(id)) continue;
        try { const { session } = await upstream(options => client.sessions.retrieve(upstreamId, options)); observe(id, upstreamId, session); } catch { /* Retain the slot until state is known. */ }
      }
    } finally { sweeping = false; }
  }, 5000);
  sweeper.unref();

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = request.headers.host;
      const localHosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
      if (!localHosts.includes(host) && !allowedHosts.includes(host)) throw fail(403, 'Unrecognized server host.');
      const url = new URL(request.url, 'http://widget.invalid');
      // Classic cross-origin script tags commonly omit Origin. Assets contain no credentials.
      if (request.method === 'GET' && ['/widget.js', '/widget.css'].includes(url.pathname)) {
        const name = url.pathname.slice(1);
        let asset;
        try { asset = await readFile(path.join(directory, 'public', name)); } catch { throw fail(404, 'Asset not found.'); }
        response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cross-Origin-Resource-Policy': 'cross-origin' });
        return response.end(asset);
      }
      const match = /^\/v1\/widgets\/([\w-]{1,80})\/(config|visitors|sessions)(?:\/([\w-]{1,100})(?:\/(messages|cancel|approvals))?)?$/.exec(url.pathname);
      if (!match || url.search) throw fail(404, 'Route not found.');
      const [, widgetId, resource, sessionId, action] = match;
      const config = configs.get(widgetId);
      if (!config) throw fail(404, 'Widget not found.');
      const origin = request.headers.origin;
      if (!origin || !config.origins.has(origin)) throw fail(403, 'This website is not allowed to use this widget.');
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
      if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
      rate('global', limits.globalRequests);
      if (resource === 'config' && !sessionId && request.method === 'GET') return json(response, 200, publicConfig(config));
      if (!client) throw fail(503, 'This chat is not configured yet.');
      if (resource === 'visitors' && !sessionId && request.method === 'POST') {
        rate(`bootstrap:${request.socket.remoteAddress}`, limits.bootstrapPerIp);
        keysOnly(await readBody(request, limits), []);
        pendingVisitors++;
        try {
          if ((await store.visitorCount()) + pendingVisitors > limits.maxVisitors) throw fail(429, 'Chat is busy. Please try again later.');
          const visitorToken = randomBytes(32).toString('hex');
          await store.putVisitor(hashToken(visitorToken), { widgetId, origin, createdAt: now(), expiresAt: now() + limits.visitorTtlMs });
          return json(response, 201, { visitorToken });
        } finally { pendingVisitors--; }
      }
      if (resource !== 'sessions') throw fail(404, 'Route not found.');
      const tokenMatch = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '');
      if (!tokenMatch) throw fail(401, 'Start a new chat to reconnect.');
      const visitorHash = hashToken(tokenMatch[1]);
      const visitor = await store.getVisitor(visitorHash);
      if (!visitor || visitor.widgetId !== widgetId || visitor.origin !== origin) throw fail(401, 'Start a new chat to reconnect.');
      rate(`visitor:${visitorHash}`, limits.requestsPerVisitor);
      if (!sessionId && request.method === 'POST') {
        rate(`create:${visitorHash}`, limits.sessionsPerVisitor);
        keysOnly(await readBody(request, limits), []);
        if (mutateLocks.has(visitorHash)) throw fail(409, 'A conversation is already being created.');
        mutateLocks.add(visitorHash);
        try {
          if (await store.countSessions(visitorHash) >= limits.maxSessionsPerVisitor) throw fail(429, 'Conversation limit reached. Please contact the website owner.');
          const { session } = await upstream(options => client.sessions.create(config.agentId, {}, options));
          const id = `chat_${randomBytes(24).toString('hex')}`;
          await store.putSession(id, { widgetId, origin, visitorHash, upstreamId: session.id, createdAt: now() });
          return json(response, 201, { sessionId: id });
        } finally { mutateLocks.delete(visitorHash); }
      }
      if (!sessionId) throw fail(404, 'Route not found.');
      const record = await store.getSession(sessionId);
      if (!record || record.visitorHash !== visitorHash || record.widgetId !== widgetId || record.origin !== origin) throw fail(404, 'Conversation not found.');
      if (!action && request.method === 'GET') return json(response, 200, { session: projectSession(await snapshot(record, sessionId), sessionId) });
      if (request.method !== 'POST' || !action) throw fail(404, 'Route not found.');
      const body = await readBody(request, limits);
      if (action === 'cancel') {
        keysOnly(body, []);
        if (cancelling.has(sessionId)) throw fail(409, 'A stop request is already in progress.');
        cancelling.add(sessionId);
        try {
          await upstream(options => client.sessions.cancel(record.upstreamId, options));
          return json(response, 200, { session: projectSession(await snapshot(record, sessionId), sessionId) });
        } finally { cancelling.delete(sessionId); }
      }
      if (locks.has(sessionId) || cancelling.has(sessionId)) throw fail(409, 'This conversation is already processing a request.');
      locks.add(sessionId);
      try {
        if (action === 'messages') {
          keysOnly(body, ['input']);
          if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > limits.inputCharacters) throw fail(400, 'Enter a message within the size limit.');
        } else if (action === 'approvals') keysOnly(body, ['approval_responses']);
        const current = await snapshot(record, sessionId);
        if (action === 'messages' && (!['idle', 'completed', 'failed'].includes(current.state) || current.pending_approvals?.length)) throw fail(409, 'Finish the current request before sending another message.');
        let decisions;
        if (action === 'approvals') decisions = validateDecisions(body, current);
        rate(`message:${visitorHash}`, limits.messagesPerVisitor);
        rate('global-message', limits.globalMessages);
        if (activeRuns.size >= limits.maxConcurrentRuns) throw fail(429, 'Chat is busy. Please try again later.');
        activeRuns.set(sessionId, record.upstreamId);
        if (action === 'approvals') {
          try {
            await upstream(options => client.sessions.resolveApprovals(record.upstreamId, { approval_responses: decisions }, options));
            return json(response, 200, { session: projectSession(await snapshot(record, sessionId), sessionId) });
          } catch (error) { try { await snapshot(record, sessionId); } catch {} throw error; }
        }
        const controller = new AbortController();
        controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), limits.streamTimeoutMs);
        const onClose = () => controller.abort();
        response.on('close', onClose);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        response.flushHeaders();
        const emit = (type, data) => { if (!response.destroyed) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
        const keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 15000);
        emit('state', { state: 'processing' });
        try {
          for await (const event of client.sessions.streamMessage(record.upstreamId, { input: body.input }, { signal: controller.signal })) {
            // Child tool/agent text and raw errors can contain private context.
            if (event.type === 'text-delta' && typeof event.delta === 'string' && !event.parentToolCallId) emit('text', { delta: event.delta });
            if (event.type === 'error' || event.error || event.errorMessage) emit('error', { message: 'The agent could not finish this response. Refresh the conversation status.' });
          }
        } catch { if (!response.destroyed) emit('error', { message: 'The connection was interrupted. Refresh the conversation to see its current status.' }); }
        finally {
          clearTimeout(timeout); clearInterval(keepalive); controllers.delete(controller); response.off('close', onClose);
          try { emit('state', { state: safeState((await snapshot(record, sessionId)).state) }); }
          catch { emit('error', { message: 'Could not confirm the conversation status. Please refresh it.' }); }
          if (!response.destroyed) response.end();
        }
      } finally { locks.delete(sessionId); }
    } catch (error) {
      const visible = publicError(error);
      if (visible.status === 429) response.setHeader('Retry-After', String(Math.ceil(limits.windowMs / 1000)));
      if (!response.headersSent) json(response, visible.status, { error: visible.message });
      else if (!response.destroyed) response.end();
    }
  });
  server.requestTimeout = limits.bodyTimeoutMs + 1000;
  server.headersTimeout = Math.min(10000, server.requestTimeout);
  server.on('close', () => { clearInterval(sweeper); for (const controller of controllers) controller.abort(); });
  return server;
}

function validateDecisions(body, session) {
  const responses = body.approval_responses;
  if (session.state !== 'approval_required' || !Array.isArray(responses) || responses.length < 1 || responses.length > 20) throw fail(400, 'No valid questions were answered.');
  const asks = new Map((session.pending_approvals ?? []).map(ask => [ask.action_request_id, ask]));
  const seen = new Set();
  return responses.map(response => {
    keysOnly(response, ['action_request_id', 'action', 'response']);
    const ask = asks.get(response.action_request_id);
    if (!ask || ask.type !== 'human_input' || seen.has(response.action_request_id)) throw fail(403, 'This question cannot be answered through the website.');
    seen.add(response.action_request_id);
    if (!['accept', 'reject'].includes(response.action)) throw fail(400, 'Invalid answer action.');
    if (response.action === 'reject') return { action_request_id: response.action_request_id, action: 'reject' };
    keysOnly(response.response, ['values']);
    if (!object(response.response.values)) throw fail(400, 'Question answers are required.');
    const questions = ask.questions ?? [];
    const values = response.response.values;
    if (!questions.length || questions.some(question => question.type !== 'toggle_group' || question.condition || !Array.isArray(question.options))) throw fail(409, 'This form needs help from the website owner.');
    const names = new Set(questions.map(question => question.name));
    if (Object.keys(values).some(name => !names.has(name))) throw fail(400, 'Unknown question answer.');
    for (const question of questions) {
      const value = values[question.name];
      if (value === undefined && question.required !== true) continue;
      if (typeof value !== 'string' || !question.options.some(option => option.value === value)) throw fail(400, 'Choose one of the listed answers.');
    }
    return { action_request_id: response.action_request_id, action: 'accept', response: { values } };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.loadEnvFile(path.resolve(directory, '../.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { Gumloop } = await import('../dist/index.js');
  const port = Number(process.env.WIDGET_PORT || process.env.GUMLOOP_WIDGET_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GUMLOOP_WIDGET_PORT');
  const agentId = process.env.GUMLOOP_WIDGET_AGENT_ID;
  if (!agentId) throw new Error('Set GUMLOOP_WIDGET_AGENT_ID to an agent intended for public website visitors.');
  const publicUrl = process.env.GUMLOOP_WIDGET_PUBLIC_URL ? new URL(process.env.GUMLOOP_WIDGET_PUBLIC_URL) : null;
  const origins = (process.env.GUMLOOP_WIDGET_ALLOWED_ORIGINS || 'http://127.0.0.1:3100,http://localhost:3100').split(',').map(value => value.trim()).filter(Boolean);
  const client = new Gumloop();
  const store = await createFileStore(path.resolve(directory, '../.local/widget-store.json'));
  createWidgetServer({ client, store, allowedHosts: publicUrl ? [publicUrl.host] : [], widgets: { demo: { agentId, allowedOrigins: origins, title: process.env.GUMLOOP_WIDGET_TITLE, welcome: process.env.GUMLOOP_WIDGET_WELCOME, accent: process.env.GUMLOOP_WIDGET_ACCENT } } }).listen(port, process.env.GUMLOOP_WIDGET_HOST || '127.0.0.1', () => {
    console.log(`Gumloop website widget listening on port ${port}`);
  });
}
