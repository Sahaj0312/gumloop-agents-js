export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const bad = (status: number, message: string): never => { throw new HttpError(status, message); };
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function only(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) bad(400, 'Unexpected request fields.'); }
export function text(value: unknown, label: string, max = 512, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) return bad(400, `Invalid ${label}.`);
  return value;
}
export function token(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }
export async function hash(value: string): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
export async function equalSecret(provided: string, expected: string): Promise<boolean> {
  // HMAC verification uses the platform's constant-time cryptographic comparison.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(provided));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(expected));
}
export async function body(request: Request, max = 65536): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return bad(415, 'Use application/json.');
  if (Number(request.headers.get('content-length')) > max) return bad(413, 'Request is too large.');
  const reader = request.body?.getReader(); if (!reader) return bad(400, 'Expected a JSON object.');
  const chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, 'Request body timed out.')), 10000); });
  try { for (;;) { const { done, value } = await Promise.race([reader.read(), deadline]); if (done) break; size += value.length; if (size > max) { await reader.cancel(); return bad(413, 'Request is too large.'); } chunks.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!object(value)) return bad(400, 'Expected a JSON object.'); return value; } catch { return bad(400, 'Expected a JSON object.'); }
}
export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const result = new Headers(headers); result.set('content-type', 'application/json; charset=utf-8'); result.set('cache-control', 'no-store'); result.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(value), { status, headers: result });
}
export function sameOrigin(request: Request) { if (request.headers.get('origin') !== new URL(request.url).origin) bad(403, 'A same-origin request is required.'); }
export function safeError(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (object(error) && error.status === 429) return { status: 429, message: 'The chat service is busy. Please try again later.' };
  if (object(error) && error.status === 409) return { status: 409, message: 'The conversation has changed. Refresh its status before continuing.' };
  return { status: 502, message: 'The service is temporarily unavailable. Please try again later.' };
}
export const callOptions = () => ({ signal: AbortSignal.timeout(25000) });

export interface WidgetConfig {
  title: string; welcome: string; accent: string; position: 'left' | 'right'; bubbleLabel: string;
  suggestions: string[]; theme: 'light' | 'dark'; borderRadius: number; width: number; avatarUrl: string;
}
export const defaults: WidgetConfig = { title: 'Ask our team', welcome: 'Hi! How can I help?', accent: '#d06a4f', position: 'right', bubbleLabel: 'Ask us', suggestions: [], theme: 'light', borderRadius: 18, width: 384, avatarUrl: '' };
export function config(value: unknown, base: WidgetConfig = defaults): WidgetConfig {
  if (!object(value)) return bad(400, 'Invalid widget appearance.');
  only(value, Object.keys(defaults));
  const result = { ...base, ...value };
  for (const [key, max] of [['title', 80], ['welcome', 500], ['bubbleLabel', 40]] as const) text(result[key], key, max, key === 'welcome');
  if (!/^#[0-9a-fA-F]{6}$/.test(text(result.accent, 'accent'))) bad(400, 'Choose a six-digit hex color.');
  if (!['left', 'right'].includes(result.position) || !['light', 'dark'].includes(result.theme)) bad(400, 'Invalid widget theme or position.');
  if (!Number.isInteger(result.width) || result.width < 320 || result.width > 480 || !Number.isInteger(result.borderRadius) || result.borderRadius < 8 || result.borderRadius > 28) bad(400, 'Invalid widget size.');
  if (!Array.isArray(result.suggestions) || result.suggestions.length > 4) bad(400, 'Use at most four suggestions.');
  result.suggestions = result.suggestions.map(item => text(item, 'suggestion', 120));
  text(result.avatarUrl, 'avatar URL', 2048, true);
  if (result.avatarUrl) { try { const url = new URL(result.avatarUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); } catch { bad(400, 'Avatar must use an HTTPS URL.'); } }
  return result;
}
export function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) return bad(400, 'Use at most 20 website origins.');
  return [...new Set(value.map(item => {
    const raw = text(item, 'website origin', 512);
    try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw || url.username || url.password) throw new Error(); return raw; }
    catch { return bad(400, 'Origins must be exact URLs such as https://example.com, without paths.'); }
  }))];
}
