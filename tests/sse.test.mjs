import test from 'node:test';
import assert from 'node:assert/strict';
import { Gumloop } from '../dist/index.js';
const encoder = new TextEncoder();
function fixture(text, { bytewise = false } = {}) {
  let cancelled = false;
  let bytes = encoder.encode(text);
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) { controller.close(); return; }
      const end = bytewise ? index + 1 : bytes.length;
      controller.enqueue(bytes.slice(index, end)); index = end;
    },
    cancel() { cancelled = true; },
  });
  const client = new Gumloop({ accessToken: 'test', fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  return { events: client.sessions.stream('test-agent', { input: 'Hi' }), isCancelled: () => cancelled };
}
async function collect(events) { const result = []; for await (const event of events) result.push(event); return result; }

test('split UTF-8, BOM and CRLF framing preserve live text-delta shape and exact cursors', async () => {
  const frames = [
    { type: 'interaction-ready', interaction_id: 'sess_test', stream_cursor: 'run:0' },
    { type: 'text-start', id: 'message-test' },
    { type: 'text-delta', id: 'message-test', delta: 'Hello 🌎', stream_cursor: 'run:2' },
    { type: 'text-end', id: 'message-test' },
    { type: 'finish', finishReason: 'stop', final: false },
    { type: 'finish', finishReason: 'stop', final: true },
  ];
  const { events } = fixture('\uFEFF' + frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''), { bytewise: true });
  const actual = await collect(events);
  assert.equal(actual.length, frames.length);
  actual.forEach((event, index) => {
    const { sse, ...payload } = event;
    assert.deepEqual(payload, frames[index]);
    assert.deepEqual(JSON.parse(sse.data), frames[index]);
  });
});

test('multiline JSON, named events, comments, unknown fields and SSE metadata survive', async () => {
  const { events } = fixture(': heartbeat\nretry: 3000\nid: cursor\nevent: future-event\nunknown: ignored\ndata: {"extra": 7,\ndata: "future":true}\n\ndata: {"type":"explicit","sse":"original"}\n\n', { bytewise: true });
  const actual = await collect(events);
  assert.equal(actual[0].type, 'future-event');
  assert.equal(actual[0].extra, 7);
  assert.equal(actual[0].future, true);
  assert.deepEqual(actual[0].sse, { event: 'future-event', id: 'cursor', retry: 3000, data: '{"extra": 7,\n"future":true}' });
  assert.equal(actual[1].type, 'explicit');
  assert.equal(actual[1].sse.event, 'message');
  assert.equal(JSON.parse(actual[1].sse.data).sse, 'original');
});

test('error frames, non-JSON text and primitive JSON are surfaced rather than dropped', async () => {
  const { events } = fixture('event: error\ndata: {"errorMessage":"upstream failed","stream_cursor":"r:3"}\n\ndata: plain text\n\ndata: [1,2]\n\ndata: null\n\n');
  const actual = await collect(events);
  assert.equal(actual[0].type, 'error');
  assert.equal(actual[0].errorMessage, 'upstream failed');
  assert.equal(actual[0].stream_cursor, 'r:3');
  assert.equal(actual[1].data, 'plain text');
  assert.deepEqual(actual[2].data, [1, 2]);
  assert.equal(actual[3].data, null);
});

test('[DONE] closes iteration, while non-final finish events do not', async () => {
  const { events } = fixture('data: {"type":"finish","final":false}\n\ndata: {"type":"finish","final":true}\n\ndata: [DONE]\n\ndata: {"type":"must-not-arrive"}\n\n');
  const actual = await collect(events);
  assert.equal(actual.length, 2);
  assert.equal(actual[1].final, true);
});

test('supports bare CR, id resets, invalid retry values and null-byte ID rejection', async () => {
  const { events } = fixture('id: one\rretry: 20\rdata: {}\r\rid: bad\0value\rretry: -1\rdata: {}\r\rid:\rdata:\r\r', { bytewise: true });
  const actual = await collect(events);
  assert.equal(actual[0].sse.id, 'one');
  assert.equal(actual[1].sse.id, 'one');
  assert.equal(actual[1].sse.retry, 20);
  assert.equal(actual[2].sse.id, '');
  assert.equal(actual[2].data, '');
});

test('unterminated EOF frame is discarded instead of inventing a completed event', async () => {
  const { events } = fixture('data: {"type":"valid"}\n\ndata: {"type":"partial"}\n');
  const actual = await collect(events);
  assert.equal(actual.length, 1);
  assert.equal(actual[0].type, 'valid');
});

test('breaking consumer iteration releases the stream without cancelling server work', async () => {
  let bodyCancelled = false;
  let calls = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('data: {"type":"text-delta","delta":"Hi"}\n\n')); },
    cancel() { bodyCancelled = true; },
  });
  const client = new Gumloop({ accessToken: 'test', fetch: async () => { calls++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); } });
  for await (const event of client.sessions.stream('a', { input: 'Hi' })) { assert.equal(event.delta, 'Hi'); break; }
  assert.equal(bodyCancelled, true);
  assert.equal(calls, 1);
});

test('midstream transport failure propagates after already-delivered events', async () => {
  let pullCount = 0;
  const body = new ReadableStream({ pull(controller) {
    if (pullCount++ === 0) controller.enqueue(encoder.encode('data: {"stream_cursor":"run:1"}\n\n'));
    else controller.error(new Error('connection dropped'));
  } });
  let calls = 0;
  const client = new Gumloop({ accessToken: 'test', fetch: async () => { calls++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); } });
  const seen = [];
  await assert.rejects(async () => { for await (const event of client.sessions.stream('a')) seen.push(event); }, /connection dropped/);
  assert.equal(seen[0].stream_cursor, 'run:1');
  assert.equal(calls, 1);
});
