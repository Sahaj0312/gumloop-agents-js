// Opt-in integration test. Starts real tasks and consumes Gumloop credits.
// Use a dedicated agent with no connected apps, never a production agent.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Gumloop } from '../dist/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const agentId = process.env.GUMLOOP_TEST_AGENT_ID;
if (!agentId) throw new Error('Set GUMLOOP_TEST_AGENT_ID to a dedicated test agent. This test consumes credits.');
const client = new Gumloop();
const report = { checkedAt: new Date().toISOString(), checks: [] };
const active = new Set();
const options = () => ({ signal: AbortSignal.timeout(90000) });
const id = () => `sess_sdk_${randomUUID()}`;
const textOf = (session) => (session.messages ?? []).filter(m => m.role === 'assistant')
  .map(m => m.content ?? (m.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('')).join('\n');
function pass(name, detail = {}) {
  const check = { name, passed: true, ...detail };
  report.checks.push(check);
  console.log(JSON.stringify(check));
}
async function settled(sessionId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { session } = await client.sessions.retrieve(sessionId, options());
    if (!['processing', 'queued'].includes(session.state)) return session;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('Timed out waiting for a terminal session state');
}

try {
  const { agent } = await client.agents.retrieve(agentId, options());
  assert.equal(agent.id, agentId);
  pass('retrieve dedicated test agent');

  const conversation = id();
  active.add(conversation);
  let deltaCount = 0;
  for await (const event of client.sessions.stream(agentId, {
    session_id: conversation, input: 'Remember the codeword ORBIT. Reply with exactly ORBIT.',
  }, options())) if (event.type === 'text-delta') deltaCount++;
  let session = await settled(conversation);
  assert.equal(session.state, 'completed');
  assert.ok(deltaCount > 0);
  assert.match(textOf(session), /ORBIT/);
  pass('stream new session', { state: session.state, receivedTextDeltas: deltaCount });

  for await (const event of client.sessions.streamMessage(conversation, {
    input: 'What codeword did I just give you? Reply with only that word.',
  }, options())) { /* Drain the stream, then inspect durable state. */ }
  session = await settled(conversation);
  assert.equal(session.state, 'completed');
  assert.equal(session.messages.filter(m => m.role === 'user').length, 2);
  assert.match(textOf(session).split('\n').at(-1), /ORBIT/);
  active.delete(conversation);
  pass('follow-up in same conversation', { userMessages: 2 });

  // Disconnect early, reconnect using only GET, then explicitly stop the task.
  const interrupted = id();
  active.add(interrupted);
  let cursor;
  for await (const event of client.sessions.stream(agentId, {
    session_id: interrupted,
    input: 'Write the integers 1 through 1000, one per line, with each followed by its English name. Start immediately and do not summarize or use tools.',
  }, options())) {
    if (typeof event.stream_cursor === 'string') cursor = event.stream_cursor;
    if (event.type === 'text-delta') break;
  }
  assert.ok(cursor);
  const beforeResume = await client.sessions.retrieve(interrupted, options());
  let resumedText = false;
  let notResumable = false;
  for await (const event of client.sessions.resumeStream(interrupted, cursor, options())) {
    if (event.type === 'text-delta') { resumedText = true; break; }
    if (event.finishReason === 'not_resumable') { notResumable = true; break; }
    if (event.type === 'finish' && event.final === true) break;
  }
  pass('explicit reconnect uses existing session', {
    stateBeforeReconnect: beforeResume.session.state, receivedResumedText: resumedText, notResumable,
  });
  const cancelled = await client.sessions.cancel(interrupted, options());
  // Live cancellation snapshots can briefly report completed before failed.
  await new Promise(resolve => setTimeout(resolve, 1500));
  session = await settled(interrupted);
  assert.ok(['failed', 'completed'].includes(cancelled.session.state));
  assert.ok(['failed', 'completed'].includes(session.state));
  assert.equal(session.messages.filter(m => m.role === 'user').length, 1);
  active.delete(interrupted);
  pass('explicit server cancellation', { state: session.state, duplicateUserMessages: false });

  // Resolve an optional previously-created synthetic human-input test session.
  const approvalSession = process.env.GUMLOOP_TEST_APPROVAL_SESSION_ID;
  if (approvalSession) {
    active.add(approvalSession);
    const { session: pending } = await client.sessions.retrieve(approvalSession, options());
    assert.equal(pending.agent_id, agentId, 'Approval must belong to the dedicated test agent');
    assert.equal(pending.state, 'approval_required');
    const approval = pending.pending_approvals?.find(a => a.type === 'human_input');
    assert.ok(approval?.action_request_id);
    const question = approval.questions?.[0];
    assert.ok(question?.name);
    const selectedOption = question.options?.[0]?.value;
    assert.ok(typeof selectedOption === 'string', 'Test approval must offer a known selectable option');
    const resolution = await client.sessions.resolveApprovals(approvalSession, {
      approval_responses: [{ action_request_id: approval.action_request_id, action: 'accept',
        response: { values: { [question.name]: selectedOption } } }],
    }, options());
    session = await settled(approvalSession);
    assert.equal(session.state, 'completed');
    assert.ok(textOf(session).length > 0);
    active.delete(approvalSession);
    pass('human-input approval and continuation', { state: session.state, outcomes: resolution.results.map(r => r.outcome) });
  }
} finally {
  // Stop only tasks this script started or explicitly designated for testing.
  for (const sessionId of active) {
    try { await client.sessions.cancel(sessionId, { signal: AbortSignal.timeout(10000) }); }
    catch { /* Do not print raw errors that might contain request details. */ }
  }
  mkdirSync('.local', { recursive: true });
  writeFileSync('.local/live-results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
}
