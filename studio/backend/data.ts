import { Gumloop } from '../../src/client.js';
import { bad, hash, token, type WidgetConfig } from './common.js';
export interface WidgetRow { id: string; name: string; agent_id: string; agent_name: string; config: string; allowed_origins: string; published_config: string | null; published_origins: string; version: number; published_at: number | null; updated_at: number }
export function widgetJSON(row: WidgetRow) { return { id: row.id, name: row.name, agentId: row.agent_id, agentName: row.agent_name, config: JSON.parse(row.config) as WidgetConfig, publishedConfig: row.published_config ? JSON.parse(row.published_config) as WidgetConfig : null, allowedOrigins: JSON.parse(row.allowed_origins), publishedOrigins: JSON.parse(row.published_origins), status: row.published_config ? 'published' : 'draft', version: row.version, publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null, updatedAt: new Date(row.updated_at).toISOString() }; }
export async function widget(env: Env, id: string): Promise<WidgetRow> { const value = await env.DB.prepare('SELECT * FROM widgets WHERE id=?').bind(id).first<WidgetRow>(); return value ?? bad(404, 'Widget not found.'); }
export async function quota(env: Env, scope: string, limit: number, seconds = 60): Promise<void> {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const result = await env.DB.prepare('INSERT INTO quotas(scope,bucket,count,expires_at) VALUES(?,?,1,?) ON CONFLICT(scope,bucket) DO UPDATE SET count=count+1 RETURNING count').bind(scope, bucket, (bucket + 1) * seconds * 1000).first<{ count: number }>();
  if (!result || result.count > limit) bad(429, 'Too many requests. Please wait before trying again.');
}
export async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM owner_sessions WHERE expires_at<?').bind(now),
    env.DB.prepare('DELETE FROM conversations WHERE visitor_hash IN (SELECT token_hash FROM visitors WHERE expires_at<?)').bind(now),
    env.DB.prepare('DELETE FROM visitors WHERE expires_at<?').bind(now),
    env.DB.prepare('DELETE FROM previews WHERE expires_at<?').bind(now),
    env.DB.prepare('DELETE FROM quotas WHERE expires_at<?').bind(now),
  ]);
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error('ENCRYPTION_KEY must contain 64 hexadecimal characters');
  const bytes = Uint8Array.from(secret.match(/../g)!, hex => parseInt(hex, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('relay:connection:v1') }, await encryptionKey(secret), new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
}
export async function decrypt(value: string, secret: string): Promise<{ apiKey: string; userId: string }> {
  const parsed = JSON.parse(value) as { iv: number[]; cipher: number[] };
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(parsed.iv), additionalData: new TextEncoder().encode('relay:connection:v1') }, await encryptionKey(secret), new Uint8Array(parsed.cipher));
  return JSON.parse(new TextDecoder().decode(plain)) as { apiKey: string; userId: string };
}
export async function credentials(env: Env): Promise<{ apiKey: string; userId: string } | null> {
  const row = await env.DB.prepare('SELECT ciphertext FROM connections WHERE id=1').first<{ ciphertext: string }>();
  if (row) return decrypt(row.ciphertext, env.ENCRYPTION_KEY);
  if (env.GUMLOOP_API_KEY && env.GUMLOOP_USER_ID) return { apiKey: env.GUMLOOP_API_KEY, userId: env.GUMLOOP_USER_ID };
  return null;
}
export async function client(env: Env): Promise<Gumloop> { const creds = await credentials(env); if (!creds) return bad(503, 'Connect your Gumloop account first.'); return new Gumloop(creds); }
export async function owner(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('relay_owner='))?.slice(12);
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie) || !env.STUDIO_PASSWORD) return false;
  const row = await env.DB.prepare('SELECT password_hash FROM owner_sessions WHERE token_hash=? AND expires_at>?').bind(await hash(cookie), Date.now()).first<{ password_hash: string }>();
  return row?.password_hash === await hash(env.STUDIO_PASSWORD);
}
export function cookie(request: Request, value: string, maxAge = 43200): string { return `relay_owner=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
export async function createOwnerSession(env: Env): Promise<string> { const value = token(); await env.DB.prepare('INSERT INTO owner_sessions(token_hash,password_hash,expires_at) VALUES(?,?,?)').bind(await hash(value), await hash(env.STUDIO_PASSWORD), Date.now() + 43200000).run(); return value; }
