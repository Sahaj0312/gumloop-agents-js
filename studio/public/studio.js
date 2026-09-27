const $ = id => document.getElementById(id);
const state = { agents: [], widgets: [], widget: null, agent: null, view: 'widgets', tab: 'appearance', csrf: null, dirty: false, agentDirty: false, saving: false, previewUrl: null, previewGeneration: 0, previewTimer: null, noticeTimer: null, workspace: null, account: null, connected: false, onboardingCode: null, workspaceGeneration: 0 };
const configFields = ['title', 'welcome', 'accent', 'position', 'bubbleLabel', 'bubbleStyle', 'bubbleIcon', 'theme', 'borderRadius', 'width', 'avatarUrl'];
const controls = Object.fromEntries(configFields.map(key => [key, document.querySelector(`[data-config="${key}"]`)]));
const clone = value => JSON.parse(JSON.stringify(value));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notice(message, error = false) {
  clearTimeout(state.noticeTimer);
  $('global-notice').textContent = message || '';
  $('global-notice').hidden = !message;
  $('global-notice').classList.toggle('error', error);
  if (message && !error) state.noticeTimer = setTimeout(() => { $('global-notice').hidden = true; }, 6500);
}
function formError(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  let response;
  try { response = await fetch(`/api/studio${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Couldn’t connect to your studio. Check your connection and try again.'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('The studio returned an unexpected response. Please try again.'); }
  if (!response.ok) {
    if (response.status === 401 && !['/login', '/signup'].includes(path)) showAuth('login');
    const error = new Error(result.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}
function setFormBusy(form, busy) {
  for (const button of form.querySelectorAll('button[type=submit]')) button.disabled = busy;
}
function showAuth(mode = 'signup') {
  $('auth-view').hidden = false; $('studio').hidden = true;
  for (const name of ['signup', 'login', 'connect']) $(`${name}-form`).hidden = mode !== name;
  $('access-code-panel').hidden = mode !== 'code';
  $('auth-tabs').hidden = !['signup', 'login'].includes(mode);
  for (const button of document.querySelectorAll('[data-auth]')) button.setAttribute('aria-selected', String(button.dataset.auth === mode));
  const copy = {
    signup: ['Widget studio for Gumloop', 'Create a workspace', 'Connect your Gumloop account to build and manage website chat widgets.'],
    login: ['Widget studio for Gumloop', 'Sign in to your workspace', 'Enter the access code you saved when you created your workspace.'],
    connect: ['Gumloop connection', 'Connect your account', 'Enter your Gumloop credentials to use your agents in Relay.'],
    code: ['Workspace created', 'Save your access code', 'You’ll need this code to sign in again. It is only shown once.'],
  }[mode];
  $('auth-eyebrow').textContent = copy[0]; $('auth-title').textContent = copy[1]; $('auth-copy').textContent = copy[2];
  formError('auth-error', '');
}
for (const button of document.querySelectorAll('[data-auth]')) button.addEventListener('click', () => showAuth(button.dataset.auth));
function updateWorkspaceIdentity(me) {
  if (state.workspace?.id !== me.workspace?.id) state.workspaceGeneration++;
  state.workspace = me.workspace || { name: 'Your workspace' };
  state.account = me.account || null; state.connected = me.connected === true;
  const name = state.workspace.name || 'Your workspace';
  $('workspace-label').textContent = name;
  $('settings-workspace-name').textContent = name;
  $('settings-access-copy').textContent = state.workspace.isOwner ? 'Use your original studio password in the Existing workspace tab to sign in again. Keep it in your password manager.' : 'Keep your workspace access code in your password manager. Use it in the Existing workspace tab to sign in again.';
  const initials = name.trim().slice(0, 1).toUpperCase() || 'W';
  document.querySelector('.workspace-avatar').textContent = initials; document.querySelector('.owner-avatar').textContent = initials;
  $('workspace-connection-label').textContent = state.connected ? 'Connected to Gumloop' : 'Gumloop disconnected';
  $('rail-connection-status').textContent = state.connected ? 'Gumloop connected' : 'Gumloop disconnected';
  document.querySelector('.workspace-switch').classList.toggle('disconnected', !state.connected);
  document.querySelector('.connection-status').classList.toggle('disconnected', !state.connected);
  $('connected-user-id').value = state.account?.userId || '';
  $('connected-user-id').readOnly = state.connected && Boolean(state.account?.userId);
  $('connected-user-id').required = true;
  $('user-id-hint').textContent = state.connected ? 'This workspace stays linked to this Gumloop account.' : 'Enter the same Gumloop user ID previously connected to this workspace.';
  $('settings-connected-badge').textContent = state.connected ? 'Connected' : 'Disconnected';
  $('settings-connected-badge').className = state.connected ? 'badge live' : 'badge';
  $('settings-connection-copy').textContent = state.connected ? 'Your agents run through this account.' : 'Reconnect to use your agents and publish your widgets again.';
  $('rotation-key-label').textContent = state.connected ? 'New API key' : 'Gumloop API key';
  $('rotate-key-button').textContent = state.connected ? 'Update API key' : 'Reconnect Gumloop';
  $('disconnect-account').disabled = !state.connected;
  $('create-widget').disabled = !state.connected; $('create-first').disabled = !state.connected;
}
async function bootstrap() {
  if (state.onboardingCode) return;
  const me = await api('/me');
  state.csrf = me.csrfToken || null;
  if (!me.authenticated) { showAuth('signup'); return; }
  updateWorkspaceIdentity(me);
  $('auth-view').hidden = true; $('studio').hidden = false;
  await loadWorkspace();
  if (!state.connected) showView('settings');
}
$('signup-form').addEventListener('submit', async event => {
  event.preventDefault(); setFormBusy(event.currentTarget, true); formError('auth-error', '');
  try {
    const result = await api('/signup', { method: 'POST', body: { name: $('workspace-name').value.trim(), apiKey: $('signup-api-key').value.trim(), userId: $('signup-user-id').value.trim() } });
    $('signup-api-key').value = ''; $('signup-user-id').value = ''; $('workspace-name').value = '';
    if (typeof result.accessCode !== 'string' || !result.accessCode) throw new Error('Your workspace was created, but its access code was not returned. Keep this page open and contact the studio administrator.');
    state.workspaceGeneration++; state.workspace = result.workspace; state.onboardingCode = result.accessCode;
    $('access-code').textContent = result.accessCode; $('access-code-saved').checked = false; $('finish-onboarding').disabled = true;
    $('access-code-status').textContent = 'Shown only on this page. Save it in your password manager or download it before continuing.';
    showAuth('code');
  } catch (error) { formError('auth-error', error.message); }
  finally { setFormBusy($('signup-form'), false); }
});
$('copy-access-code').addEventListener('click', async () => {
  if (!state.onboardingCode) return;
  try { await navigator.clipboard.writeText(state.onboardingCode); $('access-code-status').textContent = 'Copied. Save this code somewhere safe before continuing.'; }
  catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents($('access-code')); selection.removeAllRanges(); selection.addRange(range); $('access-code-status').textContent = 'Copy the highlighted code and save it somewhere safe.'; }
});
$('download-access-code').addEventListener('click', () => {
  if (!state.onboardingCode) return;
  const content = `Relay workspace access\n\nWorkspace: ${state.workspace?.name || 'Your workspace'}\nStudio: ${location.origin}\nAccess code: ${state.onboardingCode}\n\nUse the Existing workspace tab to sign in with this code.\nKeep it private. It grants access to this workspace and is not your Gumloop API key.\n`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'relay-workspace-access.txt'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('access-code-status').textContent = 'Download started. Keep the access file somewhere private.';
});
$('access-code-saved').addEventListener('change', () => { $('finish-onboarding').disabled = !$('access-code-saved').checked; });
$('finish-onboarding').addEventListener('click', async () => {
  if (!$('access-code-saved').checked || !state.onboardingCode) return;
  state.onboardingCode = null; $('access-code').textContent = ''; $('access-code-saved').checked = false; $('finish-onboarding').disabled = true;
  window.getSelection()?.removeAllRanges(); showAuth('login');
  try { await bootstrap(); } catch (error) { formError('auth-error', error.message); }
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); setFormBusy(event.currentTarget, true); formError('auth-error', '');
  try { await api('/login', { method: 'POST', body: { password: $('password').value } }); $('password').value = ''; await bootstrap(); }
  catch (error) { formError('auth-error', error.message); }
  finally { setFormBusy($('login-form'), false); }
});
$('connect-form').addEventListener('submit', async event => {
  event.preventDefault(); setFormBusy(event.currentTarget, true); formError('auth-error', '');
  try { await api('/connection', { method: 'POST', body: { apiKey: $('api-key').value.trim(), userId: $('user-id').value.trim() } }); $('api-key').value = ''; $('user-id').value = ''; await bootstrap(); }
  catch (error) { formError('auth-error', error.message); }
  finally { setFormBusy($('connect-form'), false); }
});
async function logout() {
  if (!confirmLeave()) return;
  try {
    await api('/logout', { method: 'POST', body: {} });
    clearTimeout(state.previewTimer); clearTimeout(state.noticeTimer); state.previewGeneration++; state.workspaceGeneration++;
    state.csrf = null; state.widget = null; state.agent = null; state.agents = []; state.widgets = []; state.workspace = null; state.account = null; state.connected = false; state.dirty = false; state.agentDirty = false; state.previewUrl = null;
    $('preview-frame').src = 'about:blank';
    for (const id of ['rotation-api-key', 'connected-user-id', 'signup-api-key', 'signup-user-id', 'api-key', 'user-id', 'password']) $(id).value = '';
    state.onboardingCode = null; $('access-code').textContent = ''; $('access-code-saved').checked = false;
    for (const input of document.querySelectorAll('#agent-tab input, #agent-tab textarea')) input.value = '';
    $('widget-grid').replaceChildren(); $('agent-grid').replaceChildren(); notice(''); showAuth('login');
  } catch (error) { notice(error.message, true); }
}
$('logout').addEventListener('click', logout);
$('switch-workspace').addEventListener('click', logout);
$('rotate-key-form').addEventListener('submit', async event => {
  event.preventDefault(); setFormBusy(event.currentTarget, true); $('rotation-status').textContent = '';
  const wasConnected = state.connected;
  try {
    await api('/connection', { method: 'POST', body: { apiKey: $('rotation-api-key').value.trim(), userId: $('connected-user-id').value.trim() } });
    $('rotation-api-key').value = '';
    const me = await api('/me'); updateWorkspaceIdentity(me);
    await loadWorkspace(); showView('settings');
    $('rotation-status').textContent = wasConnected ? 'API key updated. Your existing widgets remain linked.' : 'Gumloop reconnected. Publish your widgets again when you’re ready.';
    notice(wasConnected ? 'Gumloop API key updated.' : 'Gumloop reconnected.');
  } catch (error) { $('rotation-status').textContent = error.message; notice(error.message, true); }
  finally { setFormBusy($('rotate-key-form'), false); }
});
$('disconnect-account').addEventListener('click', async () => {
  if (!window.confirm('Disconnect Gumloop? Your public widgets will stop working and will be unpublished. Your widgets and drafts stay in this workspace. You can reconnect to the same account and publish them again later.')) return;
  $('disconnect-account').disabled = true;
  try {
    await api('/disconnect', { method: 'POST', body: {} });
    $('rotation-api-key').value = ''; $('rotation-status').textContent = '';
    const me = await api('/me'); updateWorkspaceIdentity(me);
    await loadWorkspace(); showView('settings');
    notice('Gumloop disconnected. Public widgets are stopped; your drafts are retained.');
  } catch (error) { notice(error.message, true); $('disconnect-account').disabled = !state.connected; }
});

async function loadWorkspace() {
  const generation = state.workspaceGeneration;
  const results = await Promise.allSettled([api('/widgets'), state.connected ? api('/agents') : Promise.resolve({ agents: [] })]);
  if (generation !== state.workspaceGeneration) return;
  if (results[0].status === 'fulfilled') state.widgets = results[0].value.widgets || [];
  else { state.widgets = []; notice(results[0].reason.message, true); }
  if (results[1].status === 'fulfilled') state.agents = results[1].value.agents || [];
  else { state.agents = []; notice(results[1].reason.message, true); }
  renderDashboard(); renderAgents();
  showView('widgets');
}
function confirmLeave() {
  return (!state.dirty && !state.agentDirty) || window.confirm('You have unsaved changes. Leave without saving?');
}
function showView(view) {
  state.view = view;
  $('dashboard').hidden = view !== 'widgets'; $('agents-page').hidden = view !== 'agents'; $('editor').hidden = view !== 'editor'; $('settings-page').hidden = view !== 'settings';
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === (view === 'editor' ? 'widgets' : view)));
  $('breadcrumb').replaceChildren(document.createTextNode(`${state.workspace?.name || 'Workspace'} `), element('span', '', '/'), document.createTextNode(view === 'agents' ? ' Agents' : view === 'editor' ? ' Widget editor' : view === 'settings' ? ' Settings' : ' Widgets'));
}
for (const button of document.querySelectorAll('.nav-item')) button.addEventListener('click', () => {
  if (state.view === 'editor' && !confirmLeave()) return;
  state.dirty = false; state.agentDirty = false; showView(button.dataset.view);
});
$('back').addEventListener('click', () => { if (confirmLeave()) { state.dirty = false; state.agentDirty = false; showView('widgets'); renderDashboard(); } });
$('refresh-dashboard').addEventListener('click', async () => {
  $('refresh-dashboard').disabled = true;
  try { await loadWorkspace(); notice('Workspace refreshed.'); }
  catch (error) { notice(error.message, true); }
  finally { $('refresh-dashboard').disabled = false; }
});

function dateLabel(date) {
  if (!date || Number.isNaN(new Date(date).getTime())) return 'Draft';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(date));
}
function renderDashboard() {
  $('total-widgets').textContent = state.widgets.length;
  $('published-widgets').textContent = state.widgets.filter(widget => widget.status === 'published').length;
  $('available-agents').textContent = state.agents.length;
  $('widget-count').textContent = state.widgets.length; $('widget-nav-count').textContent = state.widgets.length; $('agent-nav-count').textContent = state.agents.length;
  $('widget-grid').replaceChildren(); $('widgets-empty').hidden = state.widgets.length > 0;
  for (const widget of state.widgets) {
    const card = element('button', 'widget-card'); card.type = 'button'; card.setAttribute('aria-label', `Edit ${widget.name}`);
    const body = element('div', 'card-body'); const row = element('div', 'card-title-row'); row.append(element('h3', '', widget.name), element('span', widget.status === 'published' ? 'badge live' : 'badge', widget.status === 'published' ? 'Published' : 'Draft'));
    const agent = state.agents.find(item => item.id === widget.agentId); const meta = element('div', 'card-meta'); meta.append(element('span', '', `Updated ${dateLabel(widget.updatedAt)}`), element('span', '', 'Edit widget'));
    body.append(row, element('p', 'card-agent', widget.agentName || agent?.name || 'Connected agent'), meta); card.append(body); card.addEventListener('click', () => openEditor(widget.id)); $('widget-grid').append(card);
  }
}
function renderAgents() {
  const query = $('agent-search').value.trim().toLowerCase();
  const agents = state.agents.filter(agent => `${agent.name || ''} ${agent.description || ''}`.toLowerCase().includes(query));
  $('agent-grid').replaceChildren(); $('agents-empty').hidden = agents.length > 0;
  $('agents-empty').textContent = !state.connected ? 'Reconnect Gumloop in Settings to load your agents.' : state.agents.length ? 'No agents match your search.' : 'No agents found. Create an agent in Gumloop, then refresh this page.';
  for (const agent of agents) {
    const card = element('article', 'agent-card'); const button = element('button', 'button secondary', 'Create widget'); button.addEventListener('click', () => openCreate(agent.id));
    card.append(element('h3', '', agent.name || 'Unnamed agent'), element('p', '', agent.description || 'Ready to connect to a website widget.'), element('span', 'model-label', agent.model_name || 'Model configured in Gumloop'), button); $('agent-grid').append(card);
  }
}
$('agent-search').addEventListener('input', renderAgents);
function openCreate(agentId) {
  if (!state.connected) { showView('settings'); notice('Connect Gumloop before creating a widget.'); return; }
  formError('create-error', ''); $('new-agent').replaceChildren();
  for (const agent of state.agents) { const option = element('option', '', agent.name || 'Unnamed agent'); option.value = agent.id; $('new-agent').append(option); }
  if (agentId) $('new-agent').value = agentId;
  $('new-widget-name').value = '';
  const selected = state.agents.find(agent => agent.id === $('new-agent').value);
  $('selected-agent-description').textContent = selected?.description || (selected ? 'Your widget will use this agent’s existing instructions and tools.' : 'No agents available. Create an agent in Gumloop first.');
  $('create-form').querySelector('button[type=submit]').disabled = !selected;
  $('create-dialog').showModal(); $('new-widget-name').focus();
}
$('new-agent').addEventListener('change', () => { $('selected-agent-description').textContent = state.agents.find(agent => agent.id === $('new-agent').value)?.description || 'Your widget will use this agent’s existing instructions and tools.'; });
$('create-widget').addEventListener('click', () => openCreate()); $('create-first').addEventListener('click', () => openCreate()); $('close-create').addEventListener('click', () => $('create-dialog').close());
$('create-dialog').addEventListener('click', event => { if (event.target === $('create-dialog')) { const box = $('create-dialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('create-dialog').close(); } });
$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); setFormBusy(event.currentTarget, true); formError('create-error', '');
  try {
    const result = await api('/widgets', { method: 'POST', body: { name: $('new-widget-name').value.trim(), agentId: $('new-agent').value } });
    state.widgets.unshift(result.widget); $('create-dialog').close(); renderDashboard(); await openEditor(result.widget.id); notice('Widget created.');
  } catch (error) { formError('create-error', error.message); }
  finally { setFormBusy($('create-form'), false); }
});

async function openEditor(id) {
  const generation = state.workspaceGeneration;
  if (state.view === 'editor' && !confirmLeave()) return;
  try {
    const result = await api(`/widgets/${encodeURIComponent(id)}`);
    if (generation !== state.workspaceGeneration) return;
    state.widget = result.widget; state.agent = null; state.dirty = false; state.agentDirty = false;
    fillWidget(); showView('editor'); selectTab('appearance'); notice('');
    if (state.connected) await Promise.allSettled([loadAgent(result.widget.agentId), createPreview()]);
    else { $('save-agent').disabled = true; $('agent-save-status').textContent = 'Reconnect Gumloop in Settings to edit this agent.'; $('preview-frame').src = 'about:blank'; $('preview-loading').hidden = false; $('preview-loading').querySelector('p').textContent = 'Reconnect Gumloop in Settings to preview this widget.'; $('retry-preview').hidden = true; }
  } catch (error) { notice(error.message, true); }
}
function updateLauncherFields() {
  const style = controls.bubbleStyle.value;
  $('bubble-icon-field').hidden = style === 'text';
  $('bubble-label-field').hidden = style === 'icon';
}
function fillWidget() {
  const widget = state.widget;
  $('widget-name').value = widget.name;
  for (const key of configFields) controls[key].value = widget.config[key] ?? '';
  updateLauncherFields();
  $('suggestions').value = (widget.config.suggestions || []).join('\n');
  $('allowed-origins').value = (widget.allowedOrigins || []).join('\n');
  $('accent-color').value = /^#[\da-f]{6}$/i.test(widget.config.accent) ? widget.config.accent : '#d06a4f';
  $('radius-value').textContent = `${widget.config.borderRadius} px`; $('width-value').textContent = `${widget.config.width} px`;
  $('editor-title').textContent = widget.name; $('linked-agent-name').textContent = widget.agentName || 'Loading agent…';
  updateEditorState();
}
function readDraft() {
  const config = {};
  for (const key of configFields) config[key] = ['width', 'borderRadius'].includes(key) ? Number(controls[key].value) : controls[key].value;
  config.suggestions = $('suggestions').value.split('\n').map(value => value.trim()).filter(Boolean);
  return { name: $('widget-name').value.trim(), config, allowedOrigins: [...new Set($('allowed-origins').value.split('\n').map(value => value.trim()).filter(Boolean))] };
}
function validateDraft(draft, publishing = false) {
  if (!draft.name) throw new Error('Give your widget a name.');
  if (draft.name.length > 80) throw new Error('Keep your widget name under 80 characters.');
  if (!draft.config.title.trim()) throw new Error('Add a chat title.');
  if (!/^#[a-f\d]{6}$/i.test(draft.config.accent)) throw new Error('Use a six-digit hex color, such as #d06a4f.');
  if (draft.config.suggestions.length > 4) throw new Error('Use up to four conversation starters.');
  if (draft.config.suggestions.some(value => value.length > 120)) throw new Error('Keep each conversation starter under 120 characters.');
  if (draft.allowedOrigins.length > 20) throw new Error('Use up to 20 website origins.');
  if (draft.config.avatarUrl) {
    try { const url = new URL(draft.config.avatarUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { throw new Error('Use an HTTPS URL for your avatar, or leave it blank.'); }
  }
  if (publishing && !draft.allowedOrigins.length) throw new Error('Add at least one website in the Install tab before publishing.');
  for (const origin of draft.allowedOrigins) {
    try { const parsed = new URL(origin); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || origin.includes('*')) throw new Error(); }
    catch { throw new Error(`Use an exact website origin without a path: ${origin}`); }
  }
}
function updateEditorState() {
  const widget = state.widget;
  if (!widget) return;
  $('editor-status').textContent = widget.status === 'published' ? 'Published' : 'Draft'; $('editor-status').className = widget.status === 'published' ? 'badge live' : 'badge';
  $('save-status').textContent = state.saving ? 'Saving…' : state.dirty ? 'Unsaved changes' : 'All changes saved';
  $('save-draft').disabled = state.saving || !state.dirty;
  $('publish').disabled = state.saving || !state.connected;
  for (const input of document.querySelectorAll('#appearance-tab input, #appearance-tab textarea, #appearance-tab select, #allowed-origins')) input.disabled = state.saving;
  $('publish').textContent = widget.status === 'published' ? 'Publish changes' : 'Publish widget';
  $('unpublish').hidden = widget.status !== 'published';
  $('embed-status').textContent = widget.status === 'published' ? 'Ready to embed' : 'Publish first'; $('embed-status').className = widget.status === 'published' ? 'badge live' : 'badge';
  $('copy-embed').disabled = widget.status !== 'published';
  $('embed-code').textContent = widget.status === 'published' ? embedCode(widget) : 'Publish your widget to get the embed code.';
  $('live-draft-note').hidden = widget.status !== 'published';
}
function embedCode(widget) {
  return `<script src="${location.origin}/widget.js" data-widget-id="${widget.id}" defer></script>`;
}
function onAppearanceChange() {
  if (!state.widget) return;
  const draft = readDraft();
  state.dirty = draft.name !== state.widget.name || configFields.some(key => draft.config[key] !== state.widget.config[key]) || JSON.stringify(draft.config.suggestions) !== JSON.stringify(state.widget.config.suggestions || []) || JSON.stringify(draft.allowedOrigins) !== JSON.stringify(state.widget.allowedOrigins || []);
  $('editor-title').textContent = draft.name || 'Untitled widget';
  if (/^#[\da-f]{6}$/i.test(draft.config.accent)) $('accent-color').value = draft.config.accent;
  $('radius-value').textContent = `${draft.config.borderRadius} px`; $('width-value').textContent = `${draft.config.width} px`;
  updateLauncherFields(); updateEditorState(); postPreviewConfig();
}
for (const input of document.querySelectorAll('#appearance-tab input, #appearance-tab textarea, #appearance-tab select, #allowed-origins')) input.addEventListener('input', onAppearanceChange);
$('accent-color').addEventListener('input', () => { $('accent').value = $('accent-color').value; onAppearanceChange(); });
for (const button of document.querySelectorAll('[data-color]')) button.addEventListener('click', () => { $('accent').value = button.dataset.color; onAppearanceChange(); });
function selectTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const name of ['appearance', 'agent', 'install']) $(`${name}-tab`).hidden = name !== tab;
}
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => selectTab(button.dataset.tab));
function replaceWidget(widget) {
  state.widget = widget;
  const index = state.widgets.findIndex(item => item.id === widget.id);
  if (index >= 0) state.widgets[index] = widget; else state.widgets.unshift(widget);
}
async function saveDraft() {
  const draft = readDraft(); validateDraft(draft);
  const result = await api(`/widgets/${encodeURIComponent(state.widget.id)}`, { method: 'PATCH', body: { ...draft, version: state.widget.version } });
  replaceWidget(result.widget); state.dirty = false; updateEditorState(); renderDashboard();
}
$('save-draft').addEventListener('click', async () => {
  if (state.saving) return;
  state.saving = true; updateEditorState();
  try { await saveDraft(); notice('Draft saved. Your published widget stays as it is until you publish.'); }
  catch (error) { notice(error.status === 409 ? 'This widget changed in another tab. Reload it before saving again; your edits are still here.' : error.message, true); }
  finally { state.saving = false; updateEditorState(); }
});
$('publish').addEventListener('click', async () => {
  if (state.saving) return;
  try { validateDraft(readDraft(), true); }
  catch (error) { if (!readDraft().allowedOrigins.length) selectTab('install'); notice(error.message, true); return; }
  state.saving = true; updateEditorState();
  try {
    if (state.dirty) await saveDraft();
    const result = await api(`/widgets/${encodeURIComponent(state.widget.id)}/publish`, { method: 'POST', body: { version: state.widget.version } });
    replaceWidget(result.widget); state.dirty = false; renderDashboard(); selectTab('install'); notice('Your widget is published. Copy the embed code and add it to your website.');
  } catch (error) { notice(error.status === 409 ? 'This widget changed in another tab. Reload it before publishing.' : error.message, true); }
  finally { state.saving = false; updateEditorState(); }
});
$('unpublish').addEventListener('click', async () => {
  if (!window.confirm('Unpublish this widget? Visitors will no longer be able to start or continue chats.')) return;
  $('unpublish').disabled = true;
  try { const result = await api(`/widgets/${encodeURIComponent(state.widget.id)}/unpublish`, { method: 'POST', body: {} }); replaceWidget(result.widget); updateEditorState(); renderDashboard(); notice('Widget unpublished. Your draft is still here.'); }
  catch (error) { notice(error.message, true); }
  finally { $('unpublish').disabled = false; }
});
$('copy-embed').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(embedCode(state.widget)); notice('Embed code copied.'); }
  catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents($('embed-code')); selection.removeAllRanges(); selection.addRange(range); notice('Select and copy the highlighted embed code.'); }
});

for (const input of document.querySelectorAll('#agent-tab input, #agent-tab textarea')) input.addEventListener('input', () => {
  if (!state.agent) return;
  state.agentDirty = $('agent-name').value.trim() !== (state.agent.name || '') || $('agent-description').value !== (state.agent.description || '') || $('agent-model').value.trim() !== (state.agent.model_name || '') || $('agent-instructions').value !== (state.agent.system_prompt || '');
  $('agent-save-status').textContent = state.agentDirty ? 'Unsaved agent changes. Use Save agent changes to update Gumloop.' : 'Agent changes are never saved automatically.';
});
async function loadAgent(id) {
  const generation = state.workspaceGeneration;
  $('save-agent').disabled = true; $('agent-save-status').textContent = 'Loading agent from Gumloop…';
  for (const input of document.querySelectorAll('#agent-tab input, #agent-tab textarea')) input.disabled = true;
  try {
    const result = await api(`/agents/${encodeURIComponent(id)}`);
    if (generation !== state.workspaceGeneration || state.widget?.agentId !== id) return;
    state.agent = result.agent; state.agentDirty = false;
    $('linked-agent-name').textContent = result.agent.name || 'Unnamed agent';
    $('agent-name').value = result.agent.name || ''; $('agent-description').value = result.agent.description || ''; $('agent-model').value = result.agent.model_name || ''; $('agent-instructions').value = result.agent.system_prompt || '';
    for (const input of document.querySelectorAll('#agent-tab input, #agent-tab textarea')) input.disabled = false;
    $('save-agent').disabled = false; $('agent-save-status').textContent = 'Agent changes are never saved automatically.';
    api('/models').then(result => {
      $('model-list').replaceChildren();
      for (const model of result.models || []) {
        const id = typeof model === 'string' ? model : model.id || model.name || model.model_name;
        if (typeof id !== 'string') continue;
        const option = document.createElement('option'); option.value = id; if (model.display_name) option.label = model.display_name; $('model-list').append(option);
      }
    }).catch(() => {});
  } catch (error) { $('agent-save-status').textContent = `Couldn’t load this agent: ${error.message}`; }
}
$('save-agent').addEventListener('click', async () => {
  if (!state.agent || $('save-agent').disabled) return;
  const agentId = state.agent.id || state.widget.agentId;
  const candidate = { name: $('agent-name').value.trim(), description: $('agent-description').value, model_name: $('agent-model').value.trim(), system_prompt: $('agent-instructions').value };
  const body = Object.fromEntries(Object.entries(candidate).filter(([key, value]) => value !== (state.agent[key] || '')));
  if (!Object.keys(body).length) { $('agent-save-status').textContent = 'No agent changes to save.'; return; }
  $('save-agent').disabled = true; $('agent-save-status').textContent = 'Saving your agent in Gumloop…';
  for (const input of document.querySelectorAll('#agent-tab input, #agent-tab textarea')) input.disabled = true;
  try {
    const result = await api(`/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body });
    state.agent = result.agent; state.agentDirty = false; $('linked-agent-name').textContent = result.agent.name;
    const index = state.agents.findIndex(agent => agent.id === agentId); if (index >= 0) state.agents[index] = result.agent;
    $('agent-save-status').textContent = 'Saved to Gumloop. The next conversation will use these settings.'; notice('Agent updated in Gumloop.'); renderAgents();
  } catch (error) { $('agent-save-status').textContent = error.message; notice(error.message, true); }
  finally { $('save-agent').disabled = false; for (const input of document.querySelectorAll('#agent-tab input, #agent-tab textarea')) input.disabled = false; }
});

async function createPreview() {
  if (!state.widget || !state.connected) return;
  const generation = ++state.previewGeneration;
  clearTimeout(state.previewTimer);
  state.previewUrl = null; $('preview-loading').hidden = false; $('preview-loading').querySelector('p').textContent = 'Preparing your preview…'; $('retry-preview').hidden = true; $('preview-open').disabled = true; $('open-chat').disabled = true;
  try {
    const result = await api(`/widgets/${encodeURIComponent(state.widget.id)}/preview`, { method: 'POST', body: { config: readDraft().config } });
    if (generation !== state.previewGeneration) return;
    const url = new URL(result.previewUrl, location.origin);
    if (url.origin !== location.origin) throw new Error('The preview URL must belong to this studio.');
    state.previewUrl = url.href; $('preview-frame').src = url.href;
    state.previewTimer = setTimeout(() => {
      if (generation !== state.previewGeneration) return;
      $('preview-loading').querySelector('p').textContent = 'The preview is taking longer than expected.'; $('retry-preview').hidden = false;
    }, 15000);
  } catch (error) { $('preview-loading').querySelector('p').textContent = error.message; $('retry-preview').hidden = false; }
}
function postPreviewConfig() {
  if (!state.widget || !state.previewUrl) return;
  $('preview-frame').contentWindow?.postMessage({ type: 'relay:config', config: readDraft().config }, location.origin);
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('preview-frame').contentWindow || event.data?.type !== 'relay:ready') return;
  if (event.data.widgetId && event.data.widgetId !== state.widget?.id) return;
  clearTimeout(state.previewTimer); $('preview-loading').hidden = true; $('preview-open').disabled = false; $('open-chat').disabled = false;
  postPreviewConfig(); $('preview-frame').contentWindow.postMessage({ type: 'relay:open' }, location.origin);
});
$('retry-preview').addEventListener('click', createPreview);
$('preview-refresh').addEventListener('click', createPreview);
$('preview-desktop').addEventListener('click', () => { $('preview-frame-wrap').classList.remove('mobile'); $('preview-desktop').classList.add('active'); $('preview-mobile').classList.remove('active'); });
$('preview-mobile').addEventListener('click', () => { $('preview-frame-wrap').classList.add('mobile'); $('preview-mobile').classList.add('active'); $('preview-desktop').classList.remove('active'); });
$('preview-open').addEventListener('click', async () => {
  if (!state.widget || !state.previewUrl) return;
  // Create a fresh preview with the current cosmetic draft; the existing iframe
  // keeps its conversation and is not reset by opening a larger preview.
  const tab = window.open('about:blank', '_blank');
  if (!tab) { notice('Allow pop-ups for this site to open a larger preview.', true); return; }
  tab.opener = null;
  try {
    const result = await api(`/widgets/${encodeURIComponent(state.widget.id)}/preview`, { method: 'POST', body: { config: readDraft().config } });
    const url = new URL(result.previewUrl, location.origin);
    if (url.origin !== location.origin) throw new Error('The preview URL must belong to this studio.');
    tab.location.replace(url.href);
  } catch (error) { tab.close(); notice(error.message, true); }
});
$('open-chat').addEventListener('click', () => $('preview-frame').contentWindow?.postMessage({ type: 'relay:open' }, location.origin));
window.addEventListener('beforeunload', event => { if (state.dirty || state.agentDirty || state.onboardingCode) { event.preventDefault(); event.returnValue = ''; } });
bootstrap().catch(error => { formError('auth-error', error.message); });
