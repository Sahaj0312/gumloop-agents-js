import { Gumloop } from '../../src/client.js';
import { bad, hash, token, type WidgetConfig } from './common.js';

export interface WorkspaceRow {
  id: string;
  name: string;
  access_hash: string | null;
  account_hash: string | null;
  connection_disabled: number;
  connection_version: number;
  connection_nonce: string | null;
}
export interface WorkspaceIdentity { id: string; name: string }
export interface WidgetRow {
  id: string; workspace_id: string; name: string; agent_id: string; agent_name: string;
  config: string; allowed_origins: string; published_config: string | null;
  published_origins: string; version: number; published_at: number | null; updated_at: number;
}
export function widgetJSON(row: WidgetRow) {
  return {
    id: row.id, name: row.name, agentId: row.agent_id, agentName: row.agent_name,
    config: JSON.parse(row.config) as WidgetConfig,
    publishedConfig: row.published_config ? JSON.parse(row.published_config) as WidgetConfig : null,
    allowedOrigins: JSON.parse(row.allowed_origins), publishedOrigins: JSON.parse(row.published_origins),
    status: row.published_config ? 'published' : 'draft', version: row.version,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
export async function workspace(env: Env, id: string): Promise<WorkspaceRow> {
  return await env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(id).first<WorkspaceRow>()
    ?? bad(404, 'Workspace not found.');
}
/** Admin callers pass their authenticated workspace; public callers resolve only enabled workspaces. */
export async function widget(env: Env, id: string, workspaceId?: string): Promise<WidgetRow> {
  const statement = workspaceId
    ? env.DB.prepare('SELECT * FROM widgets WHERE id=? AND workspace_id=?').bind(id, workspaceId)
    : env.DB.prepare('SELECT widgets.* FROM widgets JOIN workspaces ON workspaces.id=widgets.workspace_id WHERE widgets.id=? AND workspaces.connection_disabled=0').bind(id);
  return await statement.first<WidgetRow>() ?? bad(404, 'Widget not found.');
}
export async function quota(env: Env, scope: string, limit: number, seconds = 60): Promise<void> {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const result = await env.DB.prepare('INSERT INTO quotas(scope,bucket,count,expires_at) VALUES(?,?,1,?) ON CONFLICT(scope,bucket) DO UPDATE SET count=count+1 RETURNING count')
    .bind(scope, bucket, (bucket + 1) * seconds * 1000).first<{ count: number }>();
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
function aad(workspaceId: string, legacy = false) {
  return new TextEncoder().encode(legacy ? 'relay:connection:v1' : `relay:connection:v2:${workspaceId}`);
}
export async function encrypt(value: unknown, secret: string, workspaceId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(workspaceId) },
    await encryptionKey(secret), new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
}
export async function decrypt(value: string, secret: string, workspaceId: string, legacy = false): Promise<{ apiKey: string; userId: string }> {
  if (legacy && workspaceId !== 'owner') throw new Error('Legacy credentials are restricted to the original workspace');
  const parsed = JSON.parse(value) as { iv: number[]; cipher: number[] };
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(parsed.iv), additionalData: aad(workspaceId, legacy) },
    await encryptionKey(secret), new Uint8Array(parsed.cipher),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as { apiKey: string; userId: string };
}
/** Environment credentials belong exclusively to the original owner, never guest workspaces. */
export async function credentials(env: Env, workspaceId: string): Promise<{ apiKey: string; userId: string } | null> {
  const current = await workspace(env, workspaceId);
  if (current.connection_disabled) return null;
  const row = await env.DB.prepare('SELECT c.ciphertext,c.encryption_version FROM connections c JOIN workspaces w ON w.id=c.workspace_id WHERE c.workspace_id=? AND w.connection_disabled=0')
    .bind(workspaceId).first<{ ciphertext: string; encryption_version: number }>();
  if (row) {
    const value = await decrypt(row.ciphertext, env.ENCRYPTION_KEY, workspaceId, row.encryption_version === 1);
    if (row.encryption_version === 1) {
      // Existing owner ciphertext is re-encrypted with its workspace binding on first use.
      await env.DB.prepare('UPDATE connections SET ciphertext=?,encryption_version=2 WHERE workspace_id=? AND ciphertext=?')
        .bind(await encrypt(value, env.ENCRYPTION_KEY, workspaceId), workspaceId, row.ciphertext).run();
    }
    return value;
  }
  if (workspaceId === 'owner' && env.GUMLOOP_API_KEY && env.GUMLOOP_USER_ID) {
    const accountHash = await hash(env.GUMLOOP_USER_ID);
    const enabled = await env.DB.prepare('UPDATE workspaces SET account_hash=COALESCE(account_hash,?) WHERE id=\'owner\' AND connection_disabled=0 AND (account_hash IS NULL OR account_hash=?) RETURNING id')
      .bind(accountHash, accountHash).first<{ id: string }>();
    return enabled ? { apiKey: env.GUMLOOP_API_KEY, userId: env.GUMLOOP_USER_ID } : null;
  }
  return null;
}
export async function client(env: Env, workspaceId: string): Promise<Gumloop> {
  const creds = await credentials(env, workspaceId);
  if (!creds) return bad(503, 'Connect your Gumloop account first.');
  return new Gumloop(creds);
}
export function sessionCookie(request: Request): string | undefined {
  return request.headers.get('cookie')?.split(';').map(value => value.trim())
    .find(value => value.startsWith('relay_owner='))?.slice(12);
}
export async function authenticate(request: Request, env: Env): Promise<WorkspaceIdentity | null> {
  const value = sessionCookie(request);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const row = await env.DB.prepare('SELECT owner_sessions.password_hash,workspaces.id,workspaces.name,workspaces.access_hash FROM owner_sessions JOIN workspaces ON workspaces.id=owner_sessions.workspace_id WHERE owner_sessions.token_hash=? AND owner_sessions.expires_at>?')
    .bind(await hash(value), Date.now()).first<{ password_hash: string; id: string; name: string; access_hash: string | null }>();
  if (!row) return null;
  const expected = row.id === 'owner' ? (env.STUDIO_PASSWORD ? await hash(env.STUDIO_PASSWORD) : null) : row.access_hash;
  return expected && row.password_hash === expected ? { id: row.id, name: row.name } : null;
}
export async function owner(request: Request, env: Env): Promise<boolean> {
  return (await authenticate(request, env))?.id === 'owner';
}
export function cookie(request: Request, value: string, maxAge = 43200): string {
  return `relay_owner=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function createSession(env: Env, current: WorkspaceIdentity): Promise<string> {
  const value = token();
  const authHash = current.id === 'owner' ? await hash(env.STUDIO_PASSWORD) : (await workspace(env, current.id)).access_hash;
  if (!authHash) throw new Error('Workspace has no access credential');
  await env.DB.prepare('INSERT INTO owner_sessions(token_hash,password_hash,expires_at,workspace_id) VALUES(?,?,?,?)')
    .bind(await hash(value), authHash, Date.now() + 43200000, current.id).run();
  return value;
}
export async function createOwnerSession(env: Env): Promise<string> {
  return createSession(env, await workspace(env, 'owner'));
}
