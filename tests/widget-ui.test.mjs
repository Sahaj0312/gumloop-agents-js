import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../widget/public/widget.js', import.meta.url), 'utf8');
const helpers = vm.runInNewContext(source, { TextDecoder, Set, URL });
const plain = value => JSON.parse(JSON.stringify(value));

test('widget keeps public transcript text and human questions only', () => {
  const result = helpers.snapshotView({ state: 'approval_required', messages: [
    { role: 'system', content: 'private instructions' },
    { role: 'user', content: '<img src=x onerror=alert(1)>' },
    { role: 'assistant', content: 'A reply', account_id: 'private' },
    { role: 'tool', content: 'raw connector output' },
  ], pending_approvals: [{ type: 'tool_approval', title: 'Send email' }, { type: 'human_input', action_request_id: 'ask1' }], owner_intervention_required: true });
  assert.deepEqual(plain(result.messages), [{ role: 'user', content: '<img src=x onerror=alert(1)>' }, { role: 'assistant', content: 'A reply' }]);
  assert.equal(result.state, 'approval_required');
  assert.equal(result.ownerRequired, true);
  assert.equal(result.approvals.length, 1);
});

test('widget never treats absent or unfamiliar snapshot state as completed', () => {
  assert.equal(helpers.snapshotView({}).state, 'unknown');
  assert.equal(helpers.snapshotView({ state: 'processing' }).state, 'processing');
  assert.equal(helpers.snapshotView({ state: 'approval_required' }).state, 'approval_required');
  assert.equal(helpers.snapshotView({ state: 'some_future_state' }).state, 'some_future_state');
});

test('widget accepts only supported choice questions and does not guess conditional forms', () => {
  const question = { name: 'color', type: 'toggle_group', required: true, options: [{ value: 'blue', label: 'Blue' }] };
  assert.equal(helpers.supportedQuestions([question]), true);
  assert.equal(helpers.supportedQuestions([{ ...question, condition: { field: 'other' } }]), false);
  assert.equal(helpers.supportedQuestions([{ ...question, type: 'some_future_type' }]), false);
  assert.equal(helpers.supportedQuestions([{ ...question, options: [{ value: null }] }]), false);
  assert.equal(helpers.supportedQuestions([]), false);
});

test('widget rejects CSS-valued accent injection and keeps configuration text literal', () => {
  const configured = helpers.cleanConfig({ title: '<script>alert(1)</script>', welcome: '<b>Hello</b>', accent: '#bc6547', position: 'left' });
  assert.equal(configured.title, '<script>alert(1)</script>');
  assert.equal(configured.welcome, '<b>Hello</b>');
  assert.equal(configured.accent, '#bc6547');
  assert.equal(configured.position, 'left');
  assert.equal(helpers.cleanConfig({ accent: 'red;background:url(https://evil.example)' }).accent, '#7455e8');
});

test('widget ignores corrupt stored records and preserves a known session for read-only recovery', () => {
  assert.equal(helpers.restoreRecord('not json'), null);
  assert.equal(helpers.restoreRecord('{"visitorToken":null}'), null);
  assert.equal(helpers.restoreRecord(JSON.stringify({ visitorToken: 'x'.repeat(1000) })), null);
  assert.deepEqual(plain(helpers.restoreRecord(JSON.stringify({ visitorToken: 'opaque-token', sessionId: 'local-id', arbitrary: 'ignored' }))), { visitorToken: 'opaque-token', sessionId: 'local-id' });
});

test('widget reads fragmented UTF-8 SSE and leaves termination separate from backend state', async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\nevent: text\r\ndata: {"delta":"Hello 🌎"}\r\n\r\nevent: state\r\ndata: {"state":"approval_required"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const result = [];
  for await (const event of helpers.readEvents(stream)) result.push(event);
  assert.deepEqual(plain(result), [{ type: 'text', data: { delta: 'Hello 🌎' } }, { type: 'state', data: { state: 'approval_required' } }]);
});

test('widget preserves explicit stream errors after partial text', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: text\ndata: {"delta":"Partial"}\n\nevent: error\ndata: {"message":"Please try again later."}\n\n')); controller.close(); } });
  const result = [];
  for await (const event of helpers.readEvents(stream)) result.push(event);
  assert.equal(result[0].type, 'text');
  assert.equal(result[1].type, 'error');
  assert.equal(result[1].data.message, 'Please try again later.');
});

test('widget cosmetics clamp numeric values and permit only anonymous HTTPS avatars', () => {
  const config = helpers.cleanConfig({ width: 900, borderRadius: -2, avatarUrl: 'https://images.example/avatar.png', theme: 'dark', bubbleLabel: 'Ask the team' });
  assert.equal(config.width, 480);
  assert.equal(config.borderRadius, 8);
  assert.equal(config.theme, 'dark');
  assert.equal(config.bubbleLabel, 'Ask the team');
  assert.equal(config.avatarUrl, 'https://images.example/avatar.png');
  for (const avatarUrl of ['javascript:alert(1)', 'data:image/svg+xml,hi', 'http://example.com/image', 'https://user:password@example.com/image', '//example.com/image']) {
    assert.equal(helpers.cleanConfig({ avatarUrl }).avatarUrl, '');
  }
  assert.equal(helpers.cleanConfig({ width: '500px', borderRadius: Infinity }).width, 384);
  assert.equal(helpers.cleanConfig({ width: '500px', borderRadius: Infinity }).borderRadius, 18);
  assert.equal(helpers.cleanConfig(null).title, 'Ask our team');
});

test('widget suggestions stay bounded literal text and ignore unrelated configuration', () => {
  const config = helpers.cleanConfig({ suggestions: ['<script>hi</script>', '', null, 'x'.repeat(800), ...Array(20).fill('Hello')], agentId: 'attacker-agent', apiBase: 'https://evil.example' });
  assert.equal(config.suggestions.length, 6);
  assert.equal(config.suggestions[0], '<script>hi</script>');
  assert.equal(config.suggestions[1].length, 200);
  assert.equal(config.agentId, undefined);
  assert.equal(config.apiBase, undefined);
});

test('preview binding accompanies every request, including public bootstrap and streaming', () => {
  assert.deepEqual(plain(helpers.requestHeaders('visitor', 'preview-token', false, true)), { 'X-Widget-Preview': 'preview-token' });
  assert.deepEqual(plain(helpers.requestHeaders('visitor', 'preview-token', true, false)), {
    Authorization: 'Bearer visitor', 'X-Widget-Preview': 'preview-token', 'Content-Type': 'application/json',
  });
  assert.deepEqual(plain(helpers.requestHeaders('visitor', '', false, false)), { Authorization: 'Bearer visitor' });
});
