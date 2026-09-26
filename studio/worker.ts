import { HttpError, json, safeError } from './backend/common.js';
import { cleanup } from './backend/data.js';
import { handleStudio } from './backend/studio.js';
import { handlePublic, publicPreflight } from './backend/public.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/studio/')) return await handleStudio(request, env);
      if (url.pathname.startsWith('/v1/widgets/')) return request.method === 'OPTIONS' ? await publicPreflight(request, env) : await handlePublic(request, env, ctx);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) throw new HttpError(404, 'Route not found.');
      const result = await env.ASSETS.fetch(request);
      const headers = new Headers(result.headers);
      headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Content-Type-Options', 'nosniff');
      // Shadow DOM inserts its style element at runtime; scripts remain same-origin only.
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
      if (url.pathname.includes('preview') || url.pathname === '/' || url.pathname.endsWith('.html')) headers.set('Cache-Control', 'no-store');
      if (url.pathname === '/widget.js') headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(result.body, { status: result.status, headers });
    } catch (error) {
      const visible = safeError(error);
      // Do not log URL queries, request bodies, credentials, or upstream error payloads.
      if (!(error instanceof HttpError)) console.error(JSON.stringify({ event: 'request_failed', status: visible.status }));
      return json({ error: visible.message }, visible.status, visible.status === 429 ? { 'Retry-After': '60' } : {});
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(cleanup(env)); },
} satisfies ExportedHandler<Env>;
