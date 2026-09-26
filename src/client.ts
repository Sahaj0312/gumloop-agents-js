import { GumloopError } from './errors.js';
import { parseSSE } from './sse.js';
import type {
  AgentCreateRequest, AgentUpdateRequest, AgentListRequest, AgentListResponse, AgentResponse,
  GumloopOptions, RequestOptions, SessionCreateRequest, SessionListRequest,
  SessionListResponse, SessionMessageRequest, SessionResponse,
  ResolveApprovalsRequest, ResolveApprovalsResponse, StreamEvent,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.gumloop.com/api/v1';
type Params = Record<string, string | number | boolean | undefined>;

function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value === '.' || value === '..') {
    throw new TypeError('A nonempty resource ID is required');
  }
  return encodeURIComponent(value);
}

function normalizeBase(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('API base URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function errorDetails(body: unknown): { message?: string; code?: string } {
  if (!body || typeof body !== 'object') return {};
  const object = body as Record<string, unknown>;
  const nested = object.error && typeof object.error === 'object' ? object.error as Record<string, unknown> : {};
  const code = [nested.code, object.code, typeof object.error === 'string' ? object.error : undefined].find(value => typeof value === 'string');
  const message = [nested.message, object.message, object.error_description, code].find(value => typeof value === 'string');
  return { ...(typeof code === 'string' ? { code } : {}), ...(typeof message === 'string' ? { message } : {}) };
}

class Transport {
  readonly teamId?: string;
  private readonly baseUrl: string;
  private readonly streamBaseUrl: string;
  private readonly token: string;
  private readonly userId?: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: GumloopOptions) {
    if (options.apiKey && options.accessToken) throw new TypeError('Provide apiKey or accessToken, not both');
    const env = typeof process === 'undefined' ? {} : process.env;
    const apiKey = options.apiKey ?? (!options.accessToken ? env.GUMLOOP_API_KEY : undefined);
    this.token = options.accessToken ?? apiKey ?? env.GUMLOOP_ACCESS_TOKEN ?? '';
    this.userId = options.userId ?? env.GUMLOOP_USER_ID;
    if (!this.token) throw new TypeError('A Gumloop API key or access token is required');
    if (apiKey && !this.userId) throw new TypeError('Personal API keys require userId (the x-auth-key header)');
    this.teamId = options.teamId ?? env.GUMLOOP_TEAM_ID;
    this.baseUrl = normalizeBase(options.baseUrl ?? DEFAULT_BASE_URL);
    const streamURL = new URL(this.baseUrl);
    if (streamURL.hostname === 'api.gumloop.com') streamURL.hostname = 'ws.gumloop.com';
    this.streamBaseUrl = normalizeBase(options.streamBaseUrl ?? streamURL.href);
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async response(method: string, path: string, body: unknown, params: Params, options: RequestOptions, stream: boolean): Promise<Response> {
    const url = new URL(`${stream ? this.streamBaseUrl : this.baseUrl}/${path}`);
    const scoped: Params = { ...(this.teamId ? { team_id: this.teamId } : {}), ...params };
    for (const [key, value] of Object.entries(scoped)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = new Headers({ Authorization: `Bearer ${this.token}`, Accept: stream ? 'text/event-stream' : 'application/json' });
    if (this.userId) headers.set('x-auth-key', this.userId);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    // No automatic retries: repeating a POST can start another agent turn.
    // Redirects are rejected so x-auth-key cannot leak to another host.
    const response = await this.fetcher(url, {
      method, headers, redirect: 'error', signal: options.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const raw = await response.text();
      let parsed: unknown = raw;
      try { parsed = JSON.parse(raw); } catch { /* Preserve non-JSON responses. */ }
      const details = errorDetails(parsed);
      throw new GumloopError(details.message ?? `Gumloop API request failed (${response.status})`, {
        status: response.status, code: details.code, body: parsed,
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }
    return response;
  }

  async json<T>(method: string, path: string, body?: unknown, params: Params = {}, options: RequestOptions = {}): Promise<T> {
    const response = await this.response(method, path, body, params, options, false);
    const raw = await response.text();
    try { return JSON.parse(raw) as T; }
    catch (cause) { throw new GumloopError('Gumloop returned an invalid JSON response', { status: response.status, cause }); }
  }

  async *stream(method: string, path: string, body?: unknown, params: Params = {}, options: RequestOptions = {}): AsyncGenerator<StreamEvent> {
    const response = await this.response(method, path, body, params, options, true);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'text/event-stream' || !response.body) {
      await response.body?.cancel();
      throw new GumloopError('Expected a text/event-stream response from Gumloop', { status: response.status });
    }
    yield* parseSSE(response.body);
  }
}

export class Agents {
  constructor(private readonly transport: Transport) {}
  list(request: AgentListRequest = {}, options?: RequestOptions): Promise<AgentListResponse> {
    const params: Params = {};
    if (request.search !== undefined) params.search = request.search;
    if (request.teamId !== undefined) params.team_id = request.teamId;
    return this.transport.json('GET', 'agents', undefined, params, options);
  }
  retrieve(id: string, options?: RequestOptions): Promise<AgentResponse> {
    return this.transport.json('GET', `agents/${identifier(id)}`, undefined, {}, options);
  }
  create(request: AgentCreateRequest, options?: RequestOptions): Promise<AgentResponse> {
    const body = { ...(this.transport.teamId ? { team_id: this.transport.teamId } : {}), ...request };
    return this.transport.json('POST', 'agents', body, {}, options);
  }
  update(id: string, request: AgentUpdateRequest, options?: RequestOptions): Promise<AgentResponse> {
    return this.transport.json('PATCH', `agents/${identifier(id)}`, request, {}, options);
  }
}

export class Sessions {
  constructor(private readonly transport: Transport) {}
  list(agentId: string, request: SessionListRequest = {}, options?: RequestOptions): Promise<SessionListResponse> {
    return this.transport.json('GET', `agents/${identifier(agentId)}/sessions`, undefined, { ...request }, options);
  }
  create(agentId: string, request: SessionCreateRequest = {}, options?: RequestOptions): Promise<SessionResponse> {
    return this.transport.json('POST', `agents/${identifier(agentId)}/sessions`, { ...request, stream: false }, {}, options);
  }
  retrieve(sessionId: string, options?: RequestOptions): Promise<SessionResponse> {
    return this.transport.json('GET', `sessions/${identifier(sessionId)}`, undefined, {}, options);
  }
  send(sessionId: string, request: SessionMessageRequest, options?: RequestOptions): Promise<SessionResponse> {
    requireInput(request);
    return this.transport.json('POST', `sessions/${identifier(sessionId)}/messages`, { ...request, stream: false }, {}, options);
  }
  stream(agentId: string, request: SessionCreateRequest = {}, options?: RequestOptions): AsyncIterable<StreamEvent> {
    return this.transport.stream('POST', `agents/${identifier(agentId)}/sessions`, { ...request, stream: true }, {}, options);
  }
  streamMessage(sessionId: string, request: SessionMessageRequest, options?: RequestOptions): AsyncIterable<StreamEvent> {
    requireInput(request);
    return this.transport.stream('POST', `sessions/${identifier(sessionId)}/messages`, { ...request, stream: true }, {}, options);
  }
  /** Explicit GET replay from a server-provided cursor; never resends the message. */
  resumeStream(sessionId: string, lastCursor: string, options?: RequestOptions): AsyncIterable<StreamEvent> {
    if (typeof lastCursor !== 'string') throw new TypeError('lastCursor must be a string');
    return this.transport.stream('GET', `sessions/${identifier(sessionId)}`, undefined, { stream: true, last_cursor: lastCursor }, options);
  }
  /** Cancel server work. Aborting a stream only closes its HTTP connection. */
  cancel(sessionId: string, options?: RequestOptions): Promise<SessionResponse> {
    return this.transport.json('POST', `sessions/${identifier(sessionId)}/cancel`, {}, {}, options);
  }
  update(sessionId: string, request: { name: string }, options?: RequestOptions): Promise<SessionResponse> {
    return this.transport.json('PATCH', `sessions/${identifier(sessionId)}`, request, {}, options);
  }
  resolveApprovals(sessionId: string, request: ResolveApprovalsRequest, options?: RequestOptions): Promise<ResolveApprovalsResponse> {
    const responses = request.approval_responses;
    if (!Array.isArray(responses) || responses.length < 1 || responses.length > 20) throw new TypeError('Provide between 1 and 20 approval responses');
    const ids = new Set<string>();
    for (const response of responses) {
      if (!response.action_request_id || ids.has(response.action_request_id)) throw new TypeError('Approval response IDs must be nonempty and unique');
      if (response.action !== 'accept' && response.action !== 'reject') throw new TypeError('Approval action must be accept or reject');
      if (response.reason !== undefined && response.reason.length > 1000) throw new TypeError('Approval reason must not exceed 1000 characters');
      ids.add(response.action_request_id);
    }
    return this.transport.json('POST', `sessions/${identifier(sessionId)}/approvals`, request, {}, options);
  }
}

function requireInput(request: SessionMessageRequest): void {
  if (!request || typeof request.input !== 'string') throw new TypeError('input must be a string');
}

/** Server-side client. Never embed personal API keys in browser bundles. */
export class Gumloop {
  readonly agents: Agents;
  readonly sessions: Sessions;
  constructor(options: GumloopOptions = {}) {
    const transport = new Transport(options);
    this.agents = new Agents(transport);
    this.sessions = new Sessions(transport);
  }
}
