(function () {
  'use strict';

  const ACTIVE = new Set(['processing', 'queued']);
  const READY = new Set(['idle', 'completed', 'failed']);
  function avatarUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function cleanConfig(value = {}) {
    value = value && typeof value === 'object' ? value : {};
    return {
      title: typeof value.title === 'string' && value.title.trim() ? value.title.slice(0, 100) : 'Ask our team',
      welcome: typeof value.welcome === 'string' ? value.welcome.slice(0, 2000) : 'Hi! How can I help?',
      accent: /^#[\da-f]{6}$/i.test(value.accent || '') ? value.accent : '#7455e8',
      position: value.position === 'left' ? 'left' : 'right',
      bubbleLabel: typeof value.bubbleLabel === 'string' && value.bubbleLabel.trim() ? value.bubbleLabel.slice(0, 60) : 'Ask us',
      bubbleStyle: ['icon-text', 'icon', 'text'].includes(value.bubbleStyle) ? value.bubbleStyle : 'icon-text',
      bubbleIcon: typeof value.bubbleIcon === 'string' && value.bubbleIcon.length <= 32 ? value.bubbleIcon.trim() : '',
      suggestions: Array.isArray(value.suggestions) ? value.suggestions.filter(item => typeof item === 'string' && item.trim()).slice(0, 6).map(item => item.slice(0, 200)) : [],
      theme: value.theme === 'dark' ? 'dark' : 'light',
      borderRadius: Number.isFinite(value.borderRadius) ? Math.min(28, Math.max(8, value.borderRadius)) : 18,
      width: Number.isFinite(value.width) ? Math.min(480, Math.max(320, value.width)) : 384,
      avatarUrl: avatarUrl(value.avatarUrl),
    };
  }
  function requestHeaders(visitorToken, previewToken, hasBody, publicRequest) {
    const headers = {};
    if (visitorToken && !publicRequest) headers.Authorization = `Bearer ${visitorToken}`;
    if (previewToken) headers['X-Widget-Preview'] = previewToken;
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }
  function restoreRecord(raw) {
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value.visitorToken !== 'string' || !value.visitorToken || value.visitorToken.length > 512) return null;
      return { visitorToken: value.visitorToken, sessionId: typeof value.sessionId === 'string' && value.sessionId.length < 512 ? value.sessionId : null };
    } catch { return null; }
  }
  function snapshotView(session) {
    return {
      state: typeof session.state === 'string' ? session.state : 'unknown',
      messages: (Array.isArray(session.messages) ? session.messages : [])
        .filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content)
        .map(message => ({ role: message.role, content: message.content })),
      approvals: Array.isArray(session.pending_approvals) ? session.pending_approvals.filter(ask => ask.type === 'human_input') : [],
      ownerRequired: session.owner_intervention_required === true,
    };
  }
  function supportedQuestions(questions) {
    return Array.isArray(questions) && questions.length > 0 && questions.every(question =>
      question && typeof question.name === 'string' && question.name && question.type === 'toggle_group'
      && !question.condition && Array.isArray(question.options) && question.options.length > 0
      && question.options.every(option => typeof option.value === 'string' && option.value));
  }
  async function* readEvents(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const packet = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          let type = 'message';
          const data = [];
          for (const line of packet.split(/\r?\n/)) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (data.length) yield { type, data: JSON.parse(data.join('\n')) };
        }
        if (result.done) break;
      }
    } finally { reader.releaseLock(); }
  }

  // The returned helpers make protocol fixtures testable in Node without adding
  // any globals or changing the browser's single-script installation.
  if (typeof document === 'undefined') return { cleanConfig, requestHeaders, restoreRecord, snapshotView, supportedQuestions, readEvents };

  const script = document.currentScript;
  if (!script?.src) return;
  const widgetId = script.dataset.widgetId || 'demo';
  const previewToken = script.dataset.previewToken || '';
  let previewOverrides = {};
  const backend = new URL(script.src, document.baseURI).origin;
  const apiBase = `${backend}/v1/widgets/${encodeURIComponent(widgetId)}`;
  const storageKey = `gumloop-widget:${backend}:${widgetId}${previewToken ? ":preview" : ""}`;
  let hash = 0;
  for (const char of storageKey) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hostId = `gumloop-chat-${Math.abs(hash)}`;
  if (document.getElementById(hostId)) return;

  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{all:initial;--gl-accent:#7455e8;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#29282e;color-scheme:light;line-height:1.5;font-size:14px;position:relative;z-index:2147483000}*,*::before,*::after{box-sizing:border-box}button,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}button:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--gl-accent);outline-offset:3px}button{border:0}svg{display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.bubble{position:fixed;bottom:24px;right:24px;display:flex;align-items:center;justify-content:center;gap:9px;border-radius:30px;background:var(--gl-accent);color:#fff;height:58px;padding:0 21px;box-shadow:0 6px 24px #1c162329;transition:transform .18s,box-shadow .18s;font-size:14px;font-weight:600}.bubble:hover{transform:translateY(-2px);box-shadow:0 8px 28px #1c162337}.bubble svg{width:23px;height:23px}.panel{position:fixed;bottom:96px;right:24px;width:384px;height:min(620px,calc(100dvh - 120px));max-height:calc(100dvh - 120px);background:#fff;border:1px solid #e9e5e6;box-shadow:0 18px 70px #29202b29,0 3px 12px #29202b0c;border-radius:19px;overflow:hidden;display:flex;flex-direction:column;animation:appear .18s ease-out}.panel[hidden],.bubble[hidden],[hidden]{display:none!important}:host([data-position=left]) .panel,:host([data-position=left]) .bubble{right:auto;left:24px}.header{display:flex;align-items:center;gap:11px;padding:19px 18px;border-bottom:1px solid #eee9e8;background:#fffcfa;flex-shrink:0}.avatar{width:38px;height:38px;display:grid;place-items:center;flex-shrink:0;border-radius:12px;color:var(--gl-accent);background:#f2eeeb}.avatar svg{width:22px;height:22px}.heading{flex:1;min-width:0}.title{font-size:15px;line-height:1.4;font-weight:650;margin:0;color:#302d32;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.subtitle{display:flex;align-items:center;gap:6px;font-size:11px;color:#8c8388;margin-top:3px}.dot{width:5px;height:5px;background:#71a189;border-radius:50%}.icon-button{width:29px;height:29px;padding:5px;border-radius:7px;color:#898087;background:transparent;display:grid;place-items:center}.icon-button:hover{background:#eee7e4;color:#4b4249}.icon-button svg{width:17px;height:17px}.scroll{overflow:auto;flex:1;min-height:70px;padding:20px 17px;overscroll-behavior:contain;scroll-behavior:smooth}.message{max-width:91%;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-size:13px;padding:11px 13px;margin:0 0 12px;border-radius:13px}.assistant{background:#f5f3f1;color:#454048;border-bottom-left-radius:4px}.user{background:var(--gl-accent);color:#fff;margin-left:auto;border-bottom-right-radius:4px}.timestamp{font-size:9px;color:#aca3a6;text-align:center;letter-spacing:.9px;text-transform:uppercase;margin:1px 0 20px}.typing{display:flex;align-items:center;gap:4px;width:49px;padding:13px;border-radius:12px;background:#f5f3f1;margin-top:4px}.typing i{width:4px;height:4px;background:#ac9fa3;border-radius:50%;animation:pulse 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}.notice{font-size:11px;line-height:1.55;padding:10px 12px;border-radius:9px;background:#fff6e9;border:1px solid #f1e2c9;color:#846748;margin:0 14px 10px;flex-shrink:0}.notice button{background:none;text-decoration:underline;font-size:inherit;color:inherit;padding:0;margin-left:6px}.approval{background:#fffcf5;border:1px solid #eadfc8;border-radius:12px;padding:13px;margin-bottom:12px;font-size:12px}.approval h3{font-size:13px;line-height:1.5;margin:0 0 8px;font-weight:600}.approval p{color:#8a7764;font-size:11px;line-height:1.6;margin:7px 0}.question{display:block;margin:10px 0}.question span{display:block;margin-bottom:6px;line-height:1.5}.question select{width:100%;border:1px solid #dfd5c7;border-radius:7px;padding:8px;background:#fff;color:#4c4342;font-size:12px}.approval-actions{display:flex;gap:7px;margin-top:12px}.approval-actions button{border-radius:7px;padding:8px 12px;background:var(--gl-accent);color:#fff;font-size:11px;font-weight:600}.approval-actions .decline{background:white;border:1px solid #e5d9c8;color:#867464}.composer{border-top:1px solid #efeae7;padding:11px 14px 10px;flex-shrink:0}.input-wrap{border:1px solid #e3dcda;border-radius:11px;background:#fff;display:flex;align-items:flex-end;padding:8px 9px;gap:7px}.input-wrap:focus-within{border-color:var(--gl-accent)}textarea{display:block;width:100%;resize:none;border:0;background:transparent;outline:none!important;color:#403940;font-size:13px;line-height:1.5;min-height:36px;max-height:100px;padding:7px 2px}textarea::placeholder{color:#aaa0a5}.send{width:31px;height:31px;flex-shrink:0;border-radius:8px;background:var(--gl-accent);color:white;padding:7px;margin-bottom:2px}.send svg{width:17px;height:17px}.under-input{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 1px 0;min-height:20px}.status{font-size:10px;color:#a3989f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stop{border:1px solid #e9d9d7;border-radius:6px;background:#fff5f4;color:#a46d64;font-size:10px;line-height:1.5;padding:3px 7px;white-space:nowrap}.credit{font-size:9px;letter-spacing:.15px;color:#b0a7ac;text-align:center;padding:0 10px 10px;flex-shrink:0}.credit a{color:inherit;text-decoration:none}.credit a:hover{text-decoration:underline}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@keyframes pulse{0%,80%,100%{opacity:.4}40%{opacity:1}}@keyframes appear{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}@media(max-width:480px){.panel{right:12px;bottom:87px;width:calc(100vw - 24px);height:min(600px,calc(100dvh - 107px));max-height:calc(100dvh - 107px);border-radius:16px}.bubble{right:16px;bottom:18px;height:53px;padding:0 18px}:host([data-position=left]) .panel{left:12px}:host([data-position=left]) .bubble{left:16px}.header{padding:15px}.scroll{padding:17px 14px}}
      :host{--gl-width:384px;--gl-radius:18px}.panel{width:min(var(--gl-width),calc(100vw - 32px));border-radius:var(--gl-radius)}.avatar{overflow:hidden}.avatar img{width:100%;height:100%;object-fit:cover}.suggestions{display:flex;gap:7px;flex-wrap:wrap;margin:4px 0 12px}.suggestions button{background:transparent;border:1px solid #ded5d1;border-radius:18px;padding:7px 11px;color:#645650;font-size:11px;line-height:1.45;text-align:left}.suggestions button:hover{border-color:var(--gl-accent);color:var(--gl-accent)}:host([data-theme=dark]){color-scheme:dark;color:#eee9e6}:host([data-theme=dark]) .panel{background:#211f24;border-color:#454049}:host([data-theme=dark]) .header{background:#28252c;border-color:#454049}:host([data-theme=dark]) .title{color:#f5efec}:host([data-theme=dark]) .subtitle,:host([data-theme=dark]) .status{color:#bbb0b9}:host([data-theme=dark]) .avatar{background:#38323c}:host([data-theme=dark]) .assistant,:host([data-theme=dark]) .typing{background:#342f38;color:#ece4e9}:host([data-theme=dark]) .composer{border-color:#454049}:host([data-theme=dark]) .input-wrap{background:#28252c;border-color:#514650}:host([data-theme=dark]) textarea{color:#f4edf2}:host([data-theme=dark]) .suggestions button{color:#d6c7ce;border-color:#63505e}:host([data-theme=dark]) .icon-button:hover{background:#3e3641;color:#fff}:host([data-theme=dark]) .notice,:host([data-theme=dark]) .approval{background:#362e27;border-color:#64513d;color:#f0d3ae}:host([data-theme=dark]) .approval p{color:#d6bca0}:host([data-theme=dark]) .question select{background:#29242a;border-color:#64513d;color:#f3e4d6}:host([data-theme=dark]) .stop{background:#352b2c;border-color:#654645;color:#e4b3aa}@media(max-width:480px){.panel{width:min(var(--gl-width),calc(100vw - 24px));border-radius:var(--gl-radius)}}
      .bubble{max-width:calc(100vw - 48px)}.bubble-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bubble svg{flex-shrink:0}.bubble-emoji{font-size:24px;line-height:1;flex-shrink:0;max-width:32px;overflow:hidden}.bubble[data-style="icon"]{width:58px;padding:0;border-radius:50%}@media(max-width:480px){.bubble[data-style="icon"]{width:53px}}
    </style>
    <button class="bubble" type="button" aria-expanded="false" aria-controls="chat-panel" aria-label="Open chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.3 8.3 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.3 8.3 0 0 1-3.8-.9L3 21l1.9-5.7a8.3 8.3 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.3 8.3 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></svg><span class="bubble-emoji" aria-hidden="true" hidden></span><span class="bubble-label">Ask us</span></button>
    <section class="panel" id="chat-panel" role="dialog" aria-label="Chat with our assistant" hidden>
      <header class="header"><div class="avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></svg></div><div class="heading"><h2 class="title">Ask our team</h2><div class="subtitle"><i class="dot"></i>AI assistant</div></div><button class="icon-button new" type="button" aria-label="Start a new chat" title="Start a new chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><button class="icon-button close" type="button" aria-label="Close chat" title="Close chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <div class="scroll"><div class="transcript" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text"></div><div class="suggestions" aria-label="Suggested questions"></div><div class="approvals"></div><div class="typing" aria-label="Assistant is replying" hidden><i></i><i></i><i></i></div></div>
      <div class="notice" role="status" hidden></div>
      <form class="composer"><div class="input-wrap"><label class="sr-only" for="chat-input">Your message</label><textarea id="chat-input" rows="1" maxlength="4000" placeholder="Write a message…" disabled></textarea><button class="send" type="submit" aria-label="Send message" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></div><div class="under-input"><span class="status" role="status">Connecting…</span><button class="stop" type="button" hidden>■ Stop response</button></div></form>
      <div class="credit">Powered by <a href="https://www.gumloop.com" target="_blank" rel="noopener noreferrer">Gumloop</a></div>
    </section>`;
  (document.body || document.documentElement).append(host);
  const $ = selector => shadow.querySelector(selector);
  const ui = Object.fromEntries(['bubble', 'panel', 'title', 'new', 'close', 'scroll', 'transcript', 'suggestions', 'approvals', 'typing', 'notice', 'composer', 'send', 'status', 'stop'].map(name => [name, $(`.${name}`)]));
  ui.input = $('textarea');
  ui.bubbleLabel = $('.bubble-label');
  ui.bubbleIcon = ui.bubble.querySelector('svg');
  ui.bubbleEmoji = $('.bubble-emoji');
  ui.avatar = $('.avatar');
  const avatarFallback = ui.avatar.querySelector('svg');
  const avatarImage = document.createElement('img');
  avatarImage.alt = ''; avatarImage.referrerPolicy = 'no-referrer'; avatarImage.hidden = true;
  avatarImage.addEventListener('error', () => { avatarImage.hidden = true; avatarFallback.removeAttribute('hidden'); });
  ui.avatar.append(avatarImage);
  let config = cleanConfig({}), open = false, initialized = false, initPromise = null, authExpired = false;
  let visitorToken = null, sessionId = null, state = 'idle', messages = [], approvals = [], ownerRequired = false;
  let phase = 'booting', streaming = false, busy = false, stopping = false, optimistic = null, liveText = '';
  let streamController = null, pollTimer = null, pollFailures = 0, approvalSignature = '', restoreFocus = null;
  let refreshPromise = null;
  try { const saved = previewToken ? null : restoreRecord(localStorage.getItem(storageKey)); if (saved) ({ visitorToken, sessionId } = saved); } catch {}

  function persist() {
    if (previewToken) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ visitorToken, sessionId })); } catch {}
  }
  function notice(text) { ui.notice.textContent = text || ''; ui.notice.hidden = !text; }
  function setConfig(value) {
    config = cleanConfig({ ...value, ...previewOverrides });
    host.style.setProperty('--gl-accent', config.accent);
    host.dataset.position = config.position;
    host.dataset.theme = config.theme;
    host.style.setProperty('--gl-width', `${config.width}px`);
    host.style.setProperty('--gl-radius', `${config.borderRadius}px`);
    ui.bubbleLabel.textContent = config.bubbleLabel;
    ui.bubble.dataset.style = config.bubbleStyle;
    ui.bubbleLabel.hidden = config.bubbleStyle === 'icon';
    ui.bubbleEmoji.textContent = config.bubbleIcon;
    ui.bubbleEmoji.hidden = config.bubbleStyle === 'text' || !config.bubbleIcon;
    ui.bubbleIcon.toggleAttribute('hidden', config.bubbleStyle === 'text' || Boolean(config.bubbleIcon));
    if (config.avatarUrl) {
      if (avatarImage.getAttribute('src') !== config.avatarUrl) avatarImage.src = config.avatarUrl;
      avatarImage.hidden = false; avatarFallback.setAttribute('hidden', '');
    } else {
      avatarImage.removeAttribute('src'); avatarImage.hidden = true; avatarFallback.removeAttribute('hidden');
    }
    ui.title.textContent = config.title;
    ui.panel.setAttribute('aria-label', config.title);
    ui.bubble.setAttribute('aria-label', `Open ${config.bubbleStyle === 'icon' ? config.title : config.bubbleLabel}`);
  }
  function controls() {
    const canSend = initialized && !busy && !streaming && !stopping && !authExpired && !ownerRequired && (sessionId ? READY.has(state) : true);
    ui.input.disabled = !canSend;
    for (const button of ui.suggestions.querySelectorAll('button')) button.disabled = !canSend;
    ui.send.disabled = !canSend || !ui.input.value.trim();
    ui.new.disabled = busy || streaming || stopping || ACTIVE.has(state);
    ui.stop.hidden = !sessionId || (!streaming && !ACTIVE.has(state) && !stopping);
    ui.stop.disabled = stopping;
    for (const button of ui.approvals.querySelectorAll('button')) button.disabled = busy || streaming || stopping || button.closest('.approval').dataset.resolvable !== 'true';
    ui.typing.hidden = !streaming && !ACTIVE.has(state);
    const status = stopping ? 'Stopping response…' : phase === 'booting' ? 'Connecting…' : phase === 'sending' ? 'Sending…' : streaming ? 'Replying…' : phase === 'offline' ? 'Connection interrupted' : phase === 'recovering' ? 'Checking your conversation…' : authExpired ? 'Start a new chat to continue' : ownerRequired ? 'Our team needs to take a look' : state === 'approval_required' ? 'Waiting for your answer' : ACTIVE.has(state) ? 'Working on your reply…' : state === 'failed' ? 'Ready for your next message' : 'Typically replies in moments';
    ui.status.textContent = status;
  }
  function addMessage(role, content) {
    const node = document.createElement('div');
    node.className = `message ${role}`;
    node.setAttribute('aria-label', role === 'user' ? 'You' : 'Assistant');
    node.textContent = content;
    ui.transcript.append(node);
    return node;
  }
  function renderMessages() {
    const nearBottom = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 100;
    ui.transcript.replaceChildren();
    if (!messages.length && !optimistic) {
      const label = document.createElement('div'); label.className = 'timestamp'; label.textContent = 'A little help, right here'; ui.transcript.append(label);
      if (config.welcome) addMessage('assistant', config.welcome);
    }
    for (const message of messages) addMessage(message.role, message.content);
    if (optimistic) addMessage('user', optimistic);
    if (liveText) addMessage('assistant', liveText);
    ui.suggestions.replaceChildren();
    if (!messages.length && !optimistic && !liveText) {
      for (const suggestion of config.suggestions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = suggestion;
        button.disabled = ui.input.disabled;
        button.addEventListener('click', () => { if (!ui.input.disabled) { ui.input.value = suggestion; send(); } });
        ui.suggestions.append(button);
      }
    }
    if (nearBottom || optimistic) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }
  function isActive() { return ACTIVE.has(state); }
  function schedulePoll(delay = 1800) {
    clearTimeout(pollTimer);
    if (open && sessionId && !streaming && !authExpired && (isActive() || phase === 'offline' || phase === 'recovering')) {
      pollTimer = setTimeout(() => refresh().catch(() => {}), delay);
    }
  }
  function applySnapshot(session) {
    const snapshot = snapshotView(session);
    ({ state, messages, ownerRequired } = snapshot); approvals = snapshot.approvals;
    optimistic = null; liveText = ''; phase = 'ready'; pollFailures = 0;
    renderMessages(); renderApprovals(); controls(); schedulePoll();
  }
  async function request(path, body, options = {}) {
    const headers = requestHeaders(visitorToken, previewToken, body !== undefined, options.public);
    let response;
    try { response = await fetch(apiBase + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), mode: 'cors', credentials: 'omit', signal: options.signal }); }
    catch (cause) { if (cause.name === 'AbortError') throw cause; throw Object.assign(new Error('We couldn’t connect. Please check your connection.'), { offline: true }); }
    if (!response.ok) {
      let result; try { result = await response.json(); } catch {}
      const message = response.status === 429 ? 'You’re sending messages a little quickly. Please wait a moment and try again.' : typeof result?.error === 'string' ? result.error : 'Something went wrong. Please try again.';
      if (response.status === 401 && !options.public) { authExpired = true; controls(); }
      throw Object.assign(new Error(message), { status: response.status });
    }
    return options.stream ? response : response.json();
  }
  async function refresh() {
    if (!sessionId || streaming) return;
    if (refreshPromise) return refreshPromise;
    const current = sessionId;
    refreshPromise = (async () => {
      try {
        const result = await request(`/sessions/${encodeURIComponent(current)}`);
        if (sessionId === current) applySnapshot(result.session);
      } catch (error) {
        if (sessionId !== current) return;
        if (error.status === 404 || error.status === 401) {
          authExpired = true; state = 'unknown';
          notice('This chat is no longer available. Start a new chat using the + button above.');
        } else {
          phase = 'offline'; pollFailures++; notice(error.message);
          schedulePoll(Math.min(20000, 2000 * (2 ** Math.min(pollFailures, 4))));
        }
        controls();
        throw error;
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function init() {
    if (initialized && !authExpired) return;
    if (initPromise) return initPromise;
    phase = 'booting'; controls();
    initPromise = (async () => {
      setConfig(await request('/config', undefined, { public: true }));
      if (!visitorToken) {
        const result = await request('/visitors', {}, { public: true });
        visitorToken = result.visitorToken; persist();
      }
      initialized = true; phase = 'ready'; renderMessages();
      if (sessionId) await refresh();
      controls();
    })().catch(error => { phase = error.offline ? 'offline' : 'ready'; notice(error.message); controls(); throw error; }).finally(() => { initPromise = null; });
    return initPromise;
  }
  function renderApprovals() {
    const signature = JSON.stringify({ approvals, ownerRequired });
    if (signature === approvalSignature) return;
    approvalSignature = signature; ui.approvals.replaceChildren();
    if (ownerRequired) {
      const card = document.createElement('div'); card.className = 'approval';
      const text = document.createElement('p'); text.textContent = 'Our team needs to review this request before the assistant can continue. Please contact us directly if you need help now.'; card.append(text); ui.approvals.append(card);
    }
    for (const ask of approvals) {
      const card = document.createElement('form'); card.className = 'approval'; card.dataset.resolvable = String(Boolean(ask.action_request_id));
      const title = document.createElement('h3'); title.textContent = ask.title || 'A quick question'; card.append(title);
      const supported = supportedQuestions(ask.questions);
      if (!supported) {
        const text = document.createElement('p'); text.textContent = 'This question needs help from our team. Please contact us directly to continue.'; card.append(text); ui.approvals.append(card); continue;
      }
      const fields = ask.questions.map(question => {
        const label = document.createElement('label'); label.className = 'question';
        const text = document.createElement('span'); text.textContent = question.prompt || question.title || question.name; label.append(text);
        const select = document.createElement('select'); select.required = question.required === true;
        const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose an answer…'; select.append(empty);
        for (const option of question.options) {
          const item = document.createElement('option'); item.value = option.value; item.textContent = option.label || option.value; select.append(item);
        }
        label.append(select); card.append(label);
        return { question, select };
      });
      const actions = document.createElement('div'); actions.className = 'approval-actions';
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Continue';
      const decline = document.createElement('button'); decline.type = 'button'; decline.className = 'decline'; decline.textContent = 'Skip';
      actions.append(submit, decline); card.append(actions); ui.approvals.append(card);
      const resolve = async action => {
        const current = sessionId;
        try {
          const answer = { action_request_id: ask.action_request_id, action };
          if (action === 'accept') {
            const values = {};
            for (const { question, select } of fields) {
              if (question.required && !select.value) { select.reportValidity(); return; }
              if (select.value) values[question.name] = select.value;
            }
            answer.response = { values };
          }
          submit.disabled = decline.disabled = true; busy = true; controls(); notice('');
          const result = await request(`/sessions/${encodeURIComponent(current)}/approvals`, { approval_responses: [answer] });
          if (current !== sessionId) return;
          applySnapshot(result.session);
          if (!isActive() && state !== 'approval_required') await refresh();
        } catch (error) { notice(error.message); submit.disabled = decline.disabled = false; }
        finally { busy = false; controls(); }
      };
      card.addEventListener('submit', event => { event.preventDefault(); resolve('accept'); });
      decline.addEventListener('click', () => resolve('reject'));
    }
  }

  async function send() {
    const input = ui.input.value.trim();
    if (!input || ui.input.disabled || streaming || busy) return;
    busy = true; phase = 'sending'; notice(''); controls(); clearTimeout(pollTimer);
    try {
      if (!sessionId) {
        const result = await request('/sessions', {});
        sessionId = result.sessionId; state = 'idle'; persist();
      }
      const current = sessionId;
      optimistic = input; liveText = ''; ui.input.value = ''; ui.input.style.height = ''; renderMessages();
      streamController = new AbortController(); streaming = true; busy = false; controls();
      const response = await request(`/sessions/${encodeURIComponent(current)}/messages`, { input }, { stream: true, signal: streamController.signal });
      if (!response.body) throw new Error('This browser could not receive the reply. We’ll check your conversation.');
      phase = 'ready'; controls();
      for await (const event of readEvents(response.body)) {
        if (sessionId !== current) break;
        if (event.type === 'text' && typeof event.data.delta === 'string') { liveText += event.data.delta; renderMessages(); }
        else if (event.type === 'state' && typeof event.data.state === 'string') { state = event.data.state; controls(); }
        else if (event.type === 'error') notice(event.data.message || 'The assistant couldn’t finish this reply.');
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        notice(error.offline ? 'Connection interrupted. Your message hasn’t been resent. We’ll check for your reply when you reconnect.' : error.message);
        if (error.status === 429 && optimistic) ui.input.value = input;
      }
    } finally {
      streaming = false; streamController = null; busy = false;
      // A closed connection is never proof that the task finished. Retrieve the
      // stored conversation, and poll while it is processing, without POST replay.
      if (sessionId && !authExpired) {
        phase = 'recovering'; controls();
        try { await refresh(); } catch {}
      } else { phase = 'ready'; }
      controls();
    }
  }
  async function stop() {
    if (!sessionId || stopping) return;
    const current = sessionId;
    const controller = streamController;
    stopping = true; busy = true; controls();
    try {
      await request(`/sessions/${encodeURIComponent(current)}/cancel`, {});
      if (sessionId !== current) return;
      controller?.abort();
      // Cancellation can reach the remote worker before its final state is saved.
      await new Promise(resolve => setTimeout(resolve, 500));
      await refresh();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await refresh();
      notice('Stop requested. You can send another message when the response has stopped.');
    } catch (error) { notice(error.message); }
    finally { stopping = false; busy = false; controls(); }
  }
  async function show() {
    if (open) { if (!ui.input.disabled) ui.input.focus(); return; }
    restoreFocus = document.activeElement;
    open = true; ui.panel.hidden = false; ui.bubble.setAttribute('aria-expanded', 'true');
    try { await init(); if (sessionId && !streaming) await refresh(); } catch {}
    if (open) { if (!ui.input.disabled) ui.input.focus(); else ui.close.focus(); }
  }
  function hide() {
    open = false; ui.panel.hidden = true; ui.bubble.setAttribute('aria-expanded', 'false'); clearTimeout(pollTimer);
    if (restoreFocus?.isConnected && typeof restoreFocus.focus === 'function') restoreFocus.focus(); else ui.bubble.focus();
  }
  ui.bubble.addEventListener('click', () => open ? hide() : show());
  ui.close.addEventListener('click', hide);
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape' && open) { event.preventDefault(); hide(); } });
  ui.composer.addEventListener('submit', event => { event.preventDefault(); send(); });
  ui.input.addEventListener('input', () => { ui.input.style.height = ''; ui.input.style.height = `${Math.min(100, ui.input.scrollHeight)}px`; controls(); });
  ui.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
  ui.stop.addEventListener('click', stop);
  ui.new.addEventListener('click', async () => {
    if (ui.new.disabled) return;
    clearTimeout(pollTimer);
    if (authExpired) { visitorToken = null; initialized = false; authExpired = false; }
    sessionId = null; state = 'idle'; messages = []; approvals = []; ownerRequired = false; optimistic = null; liveText = ''; phase = 'ready'; persist();
    notice(''); renderMessages(); renderApprovals(); controls();
    try { await init(); } catch {}
    if (!ui.input.disabled) ui.input.focus();
  });
  window.addEventListener('online', () => { if (open && sessionId && !streaming) refresh().catch(() => {}); else if (open && !initialized) init().catch(() => {}); });
  window.addEventListener('gumloop:open', event => { if (!event.detail?.widgetId || event.detail.widgetId === widgetId) show(); });
  window.addEventListener('gumloop:configure', event => {
    if (!previewToken || event.detail?.widgetId !== widgetId || !event.detail.config || typeof event.detail.config !== 'object') return;
    // Cosmetic preview overrides never alter the visitor token, agent, or API URL.
    previewOverrides = cleanConfig({ ...config, ...event.detail.config });
    setConfig(config); renderMessages(); controls();
  });
  // Public configuration is safe to load before the visitor opens the panel.
  request('/config', undefined, { public: true }).then(value => { setConfig(value); if (!open) renderMessages(); }).catch(() => {});
})();
