import { GumloopError } from './errors.js';
import type { StreamEvent } from './types.js';

/** Incremental SSE decoder. A final unterminated frame is deliberately discarded. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let skipLF = false;
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  let retry: number | undefined;
  let frameSize = 0;
  let done = false;
  const maxFrameCharacters = 8 * 1024 * 1024;

  function processLine(): StreamEvent | undefined {
    const current = line;
    line = '';
    if (current === '') {
      frameSize = 0;
      const name = event || 'message';
      event = '';
      if (!data.length) return;
      const raw = data.join('\n');
      data = [];
      if (raw === '[DONE]') { done = true; return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      const payload: Record<string, unknown> = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...parsed as Record<string, unknown> } : { data: parsed };
      if (!('type' in payload) && name !== 'message') payload.type = name;
      return { ...payload, sse: { event: name, ...(id !== undefined ? { id } : {}), ...(retry !== undefined ? { retry } : {}), data: raw } };
    }
    if (current.startsWith(':')) return;
    const colon = current.indexOf(':');
    const field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? '' : current.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) retry = Number(value);
    return;
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (const char of text) {
        if (skipLF) { skipLF = false; if (char === '\n') continue; }
        if (++frameSize > maxFrameCharacters) throw new GumloopError('SSE frame exceeds the 8 MiB character limit');
        if (char === '\r' || char === '\n') {
          if (char === '\r') skipLF = true;
          const parsed = processLine();
          if (parsed) yield parsed;
          if (done) return;
        } else line += char;
      }
      if (chunk.done) return;
    }
  } finally {
    // Breaking iteration or encountering [DONE] releases the HTTP body too.
    try { await reader.cancel(); } catch { /* Preserve the original stream error. */ }
    reader.releaseLock();
  }
}
