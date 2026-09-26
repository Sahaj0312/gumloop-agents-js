/** Wire shapes observed against the public streaming API, 2026-09-25. */
export function messageText(message) {
  if (typeof message.content === 'string' && message.content) return message.content;
  return (message.parts || []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}
export function interpretEvent(event) {
  if (event.type === 'text-delta' && typeof event.delta === 'string') return { kind: 'text', id: event.id || 'response', text: event.delta };
  if (event.type === 'interaction-ready' && typeof event.interaction_id === 'string') return { kind: 'session', id: event.interaction_id };
  if (event.type === 'error' || event.error || event.errorMessage) return { kind: 'error', message: event.errorMessage || event.error || 'The agent reported an error. Inspect the event for details.' };
  if (event.type === 'finish' && event.final === true) return { kind: 'finish' };
  return { kind: 'other' };
}

/** Parse our local SSE relay, including fragmented Unicode, CRLF, and comments. */
export async function* relayEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const packet = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let type = 'message';
        const data = [];
        for (const line of packet.split(/\r?\n/)) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { type, data: JSON.parse(data.join('\n')) };
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
}
