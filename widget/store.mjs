import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Single-process store. Persist only token hashes and upstream session mappings. */
export function createMemoryStore({ now = Date.now, initial, persist } = {}) {
  let data = initial ?? { version: 1, visitors: {}, sessions: {} };
  let pending = Promise.resolve();
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const activeVisitor = hash => data.visitors[hash]?.expiresAt > now() ? data.visitors[hash] : undefined;
  function mutate(change) {
    const result = pending.then(async () => {
      const next = structuredClone(data);
      for (const [hash, visitor] of Object.entries(next.visitors)) if (visitor.expiresAt <= now()) delete next.visitors[hash];
      for (const [id, session] of Object.entries(next.sessions)) if (!next.visitors[session.visitorHash]) delete next.sessions[id];
      change(next);
      await persist?.(next);
      data = next;
    });
    pending = result.catch(() => {});
    return result;
  }
  return {
    async getVisitor(hash) { await pending; return copy(activeVisitor(hash)); },
    async getSession(id) { await pending; const value = data.sessions[id]; return value && activeVisitor(value.visitorHash) ? copy(value) : undefined; },
    async countSessions(hash) { await pending; return Object.values(data.sessions).filter(value => value.visitorHash === hash).length; },
    async visitorCount() { await pending; return Object.keys(data.visitors).filter(activeVisitor).length; },
    async putVisitor(hash, visitor) { return mutate(next => { if (next.visitors[hash]) throw new Error('Visitor already exists'); next.visitors[hash] = copy(visitor); }); },
    async putSession(id, session) { return mutate(next => { if (next.sessions[id]) throw new Error('Session already exists'); next.sessions[id] = copy(session); }); },
  };
}

/** Atomic JSON replacement; run exactly one backend process per store file. */
export async function createFileStore(file, { now = Date.now } = {}) {
  let initial;
  try {
    initial = JSON.parse(await readFile(file, 'utf8'));
    if (initial.version !== 1 || !initial.visitors || !initial.sessions || Array.isArray(initial.visitors) || Array.isArray(initial.sessions)) throw new Error('Invalid widget store');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return createMemoryStore({ now, initial, persist: async value => {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } });
}
