import { interpretEvent, messageText, relayEvents } from './events.js';

const $ = id => document.getElementById(id);
const storeKey = 'gumloop-agents-demo-session';
const ui = Object.fromEntries(['agent', 'new', 'refresh', 'reconnect', 'state', 'state-dot', 'session-id', 'notice', 'messages', 'approvals', 'input', 'send', 'stop', 'transport', 'events', 'event-count', 'title', 'composer'].map(id => [id, $(id)]));
let sessionId = null, cursor = null, state = 'idle', busy = false, streaming = false, controller = null;
let eventCount = 0, rawEvents = [], liveMessages = new Map(), seenEvents = new Set(), activeRequest = 0;
let statusTimer, stopping = false;
const runnable = new Set(['idle', 'completed', 'failed']);
function notice(message) { ui.notice.textContent = message || ''; ui.notice.hidden = !message; }
function persist() { try { localStorage.setItem(storeKey, JSON.stringify({ sessionId, cursor, agentId: ui.agent.value })); } catch {} }
function controls() {
  ui.agent.disabled = busy || streaming || Boolean(sessionId);
  ui.new.disabled = busy || streaming;
  ui.input.disabled = busy || streaming || !ui.agent.value || (sessionId && !runnable.has(state));
  ui.send.disabled = ui.input.disabled;
  ui.refresh.disabled = !sessionId || busy;
  ui.reconnect.disabled = !sessionId || !cursor || streaming || busy;
  ui.stop.hidden = !sessionId || (!streaming && !['processing', 'queued', 'approval_required'].includes(state));
  ui['session-id'].textContent = sessionId || 'No session yet';
  ui.state.textContent = stopping ? 'Stopping…' : state.replaceAll('_', ' ');
  ui['state-dot'].className = ['processing', 'queued'].includes(state) ? 'active' : state === 'completed' ? 'success' : '';
}
async function api(route, data, signal) {
  const response = await fetch(route, data === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function addMessage(role, text) {
  ui.messages.querySelector('.welcome')?.remove();
  const block = document.createElement('article');
  block.className = `message ${['user', 'assistant', 'system'].includes(role) ? role : 'system'}`;
  const label = document.createElement('span'); label.className = 'role'; label.textContent = role || 'Message';
  const content = document.createElement('div'); content.textContent = text;
  block.append(label, content); ui.messages.append(block); ui.messages.scrollTop = ui.messages.scrollHeight;
  return content;
}
function renderSession(session, replaceMessages = true) {
  if (!session || session.id !== sessionId) return;
  state = session.state || 'unknown';
  if (replaceMessages && Array.isArray(session.messages)) {
    ui.messages.replaceChildren(); liveMessages.clear();
    for (const message of session.messages) {
      const text = messageText(message);
      if (text) addMessage(message.role, text);
    }
  }
  renderApprovals(session.pending_approvals || []);
  controls();
  clearTimeout(statusTimer);
  if (!streaming && ['processing', 'queued'].includes(state)) statusTimer = setTimeout(() => refresh().catch(error => notice(error.message)), 3000);
}
async function refresh(replaceMessages = true, duringStream = false) {
  if (!sessionId) return;
  const id = sessionId;
  const response = await api(`/api/session?id=${encodeURIComponent(id)}`);
  if (sessionId === id) renderSession(response.session, replaceMessages && (!streaming || duringStream));
}
function renderApprovals(approvals) {
  ui.approvals.replaceChildren(); ui.approvals.hidden = approvals.length === 0;
  for (const approval of approvals) {
    const card = document.createElement('div'); card.className = 'approval';
    const title = document.createElement('h3'); title.textContent = approval.title || approval.tool_name || 'Your approval is needed'; card.append(title);
    if (approval.reason) { const reason = document.createElement('p'); reason.textContent = approval.reason; card.append(reason); }
    if (approval.display_fields?.length) { const fields = document.createElement('pre'); fields.textContent = approval.display_fields.map(pair => pair.join(': ')).join('\n'); card.append(fields); }
    let getAnswers;
    if (approval.type === 'human_input') {
      const questions = approval.questions || [];
      const known = questions.length > 0 && questions.every(q => q.type === 'toggle_group' && q.name && Array.isArray(q.options) && q.options.length);
      if (known) {
        const inputs = questions.map(question => {
          const label = document.createElement('label'); label.className = 'question';
          const prompt = document.createElement('span'); prompt.textContent = question.prompt || question.title || question.name; label.append(prompt);
          const select = document.createElement('select'); select.required = question.required === true;
          const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose an answer…'; select.append(placeholder);
          for (const option of question.options) {
            const entry = document.createElement('option'); entry.value = option.value; entry.textContent = option.label || option.value; select.append(entry);
          }
          label.append(select); card.append(label);
          if (question.custom_option) {
            const help = document.createElement('p'); help.className = 'hint'; help.textContent = 'Custom answers are not yet supported in this demo. Choose one of the provided options or answer in Gumloop.'; card.append(help);
          }
          return { question, select };
        });
        getAnswers = () => {
          const values = {};
          for (const { question, select } of inputs) {
            if (question.required && !select.value) throw new Error(`Choose an answer for “${question.prompt || question.name}”.`);
            if (select.value) values[question.name] = select.value;
          }
          return values;
        };
      } else {
        const help = document.createElement('p'); help.textContent = 'This request uses a form this demo does not yet render. Answer it in Gumloop, or use the advanced JSON editor.'; card.append(help);
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Advanced answer editor'; details.append(summary);
        const schema = document.createElement('pre'); schema.textContent = JSON.stringify(questions, null, 2); details.append(schema);
        const answers = document.createElement('textarea'); answers.value = '{}'; answers.setAttribute('aria-label', 'Answers as JSON keyed by question name'); details.append(answers); card.append(details);
        getAnswers = () => {
          const values = JSON.parse(answers.value);
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Answers must be a JSON object.');
          return values;
        };
      }
    }
    for (const [action, label] of [['accept', 'Approve'], ['reject', 'Reject']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = action; button.textContent = label; button.disabled = !approval.action_request_id;
      button.addEventListener('click', async () => {
        const id = sessionId;
        try {
          const resolution = { action_request_id: approval.action_request_id, action };
          if (action === 'accept' && getAnswers) resolution.response = { values: getAnswers() };
          for (const b of card.querySelectorAll('button')) b.disabled = true;
          const response = await api('/api/approvals', { sessionId: id, approval_responses: [resolution] });
          if (id !== sessionId) return;
          if (response.stream_cursor) cursor = response.stream_cursor;
          persist(); renderSession(response.session, false);
          const outcomes = response.results?.map(result => result.outcome).join(', ');
          notice(outcomes ? `Approval result: ${outcomes}` : 'Approval response received.');
          await refresh();
          if (!streaming && cursor && ['processing', 'queued'].includes(state)) await connect('resume');
        } catch (error) {
          notice(error.message);
          for (const b of card.querySelectorAll('button')) b.disabled = false;
        }
      });
      card.append(button);
    }
    ui.approvals.append(card);
  }
}
function eventReceived(event, renderDeltas = true) {
  if (typeof event.stream_cursor === 'string') { cursor = event.stream_cursor; persist(); }
  const fingerprint = event.stream_cursor ? `${event.stream_cursor}:${JSON.stringify(event)}` : null;
  if (fingerprint && seenEvents.has(fingerprint)) return;
  if (fingerprint) { seenEvents.add(fingerprint); if (seenEvents.size > 10000) seenEvents.delete(seenEvents.values().next().value); }
  eventCount++;
  const { sse, ...payload } = event;
  rawEvents.push(payload); rawEvents = rawEvents.slice(-60);
  ui['event-count'].textContent = `${eventCount} events`;
  ui.events.textContent = rawEvents.map(item => JSON.stringify(item, null, 2)).join('\n\n');
  const interpreted = interpretEvent(event);
  if (interpreted.kind === 'text' && renderDeltas) {
    let node = liveMessages.get(interpreted.id);
    if (!node) { node = addMessage('assistant', ''); liveMessages.set(interpreted.id, node); }
    node.textContent += interpreted.text;
    ui.messages.scrollTop = ui.messages.scrollHeight;
  } else if (interpreted.kind === 'error') notice(String(interpreted.message));
  else if (interpreted.kind === 'finish') ui.transport.textContent = 'Final event received · verifying state…';
}
async function connect(operation, input) {
  const currentRequest = ++activeRequest;
  controller = new AbortController(); streaming = true; busy = false;
  clearTimeout(statusTimer);
  ui.transport.textContent = operation === 'resume' ? 'Reconnecting to existing run…' : 'Connecting…';
  controls();
  // A retrieved snapshot has no cursor offset. Replaying deltas into it could
  // duplicate text, so reconnect refreshes authoritative snapshots instead.
  const recoveryTimer = operation === 'resume' ? setInterval(() => refresh(true, true).catch(error => notice(error.message)), 2000) : null;
  try {
    const response = await fetch('/api/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, sessionId, cursor, input }), signal: controller.signal });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Could not open stream.'); }
    if (!response.body) throw new Error('Browser streaming is unavailable.');
    ui.transport.textContent = 'Connected · receiving events';
    for await (const event of relayEvents(response.body)) {
      if (currentRequest !== activeRequest) break;
      if (event.type === 'stream') eventReceived(event.data, operation !== 'resume');
      if (event.type === 'transport-error') throw new Error(event.data.message);
    }
    ui.transport.textContent = 'Stream ended · checking session';
  } catch (error) {
    if (error.name !== 'AbortError') notice(`${error.message} The message was not retried. Refresh status or reconnect to the existing run.`);
    ui.transport.textContent = 'Stream disconnected';
  } finally {
    clearInterval(recoveryTimer);
    if (currentRequest === activeRequest) {
      streaming = false; controller = null;
      try { await refresh(); ui.transport.textContent = `Session: ${state.replaceAll('_', ' ')}`; }
      catch (error) { notice(`Could not verify session state: ${error.message}`); }
      controls();
    }
  }
}
ui.composer.addEventListener('submit', async event => {
  event.preventDefault();
  const input = ui.input.value.trim();
  if (!input || busy || streaming) return;
  busy = true; controls(); notice('');
  try {
    if (!sessionId) {
      const response = await api('/api/sessions', { agentId: ui.agent.value });
      sessionId = response.session.id; state = response.session.state || 'idle'; persist();
    }
    ui.input.value = ''; addMessage('user', input); liveMessages.clear();
    // Mark uncertain until the backend confirms a state. Never infer completion
    // from HTTP success, an intermediate finish event, or stream EOF.
    state = 'processing';
    await connect('message', input);
  } catch (error) { notice(error.message); }
  finally { busy = false; controls(); }
});
ui.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); ui.composer.requestSubmit(); } });
ui.stop.addEventListener('click', async () => {
  const stoppedId = sessionId;
  const stoppedController = controller;
  busy = true; stopping = true; ui.stop.disabled = true; controls();
  try {
    await api('/api/cancel', { sessionId: stoppedId });
    if (sessionId !== stoppedId) return;
    stoppedController?.abort();
    notice('Stop request acknowledged by Gumloop. Waiting for the stored state to settle.');
    // The cancel response can precede the persisted cancellation state.
    await new Promise(resolve => setTimeout(resolve, 500));
    if (sessionId !== stoppedId) return;
    await refresh();
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (sessionId !== stoppedId) return;
    await refresh();
    notice(`Stop request acknowledged. Current session state: ${state.replaceAll('_', ' ')}.`);
  } catch (error) { notice(`Stop failed: ${error.message}`); }
  finally { busy = false; stopping = false; ui.stop.disabled = false; controls(); }
});
ui.refresh.addEventListener('click', () => refresh().catch(error => notice(error.message)));
ui.reconnect.addEventListener('click', () => connect('resume'));
ui.new.addEventListener('click', () => {
  clearTimeout(statusTimer); sessionId = null; cursor = null; state = 'idle'; liveMessages.clear(); seenEvents.clear(); rawEvents = []; eventCount = 0;
  try { localStorage.removeItem(storeKey); } catch {}
  ui.messages.replaceChildren(); ui.approvals.replaceChildren(); ui.approvals.hidden = true; ui.events.textContent = 'Waiting for events…'; ui['event-count'].textContent = '0 events'; ui.transport.textContent = 'Ready for a new conversation'; notice(''); controls(); ui.input.focus();
});
ui.agent.addEventListener('change', () => { ui.title.textContent = ui.agent.selectedOptions[0]?.textContent || 'Your agents, in your app.'; controls(); });

try {
  const config = await api('/api/config');
  if (!config.configured) throw new Error('Add your Gumloop credentials to the server environment and restart the demo. See the README for setup.');
  const result = await api('/api/agents');
  ui.agent.replaceChildren();
  for (const agent of result.agents || []) { const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name || agent.id; ui.agent.append(option); }
  if (!ui.agent.options.length) throw new Error('No accessible agents found. Create an agent in Gumloop or check GUMLOOP_TEAM_ID.');
  ui.agent.disabled = false; ui.transport.textContent = 'Ready';
  let saved; try { saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch {}
  if (saved?.sessionId && [...ui.agent.options].some(option => option.value === saved.agentId)) {
    ui.agent.value = saved.agentId; sessionId = saved.sessionId; cursor = saved.cursor; state = 'unknown';
    await refresh(); notice('Previous session restored. Reconnect to listen for events without sending another message.');
  }
  ui.title.textContent = ui.agent.selectedOptions[0].textContent;
  controls();
} catch (error) { notice(error.message); ui.transport.textContent = 'Setup required'; }
