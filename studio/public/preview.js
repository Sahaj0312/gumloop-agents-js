(function () {
  'use strict';

  function previewIdentity(search) {
    const params = new URLSearchParams(search);
    const widgetId = params.get('widget');
    const token = params.get('token');
    if (!widgetId || widgetId.length > 256 || !token || token.length > 4096) return null;
    return { widgetId, token };
  }
  function parentAction(event, origin, parentWindow) {
    if (event.origin !== origin || event.source !== parentWindow || !event.data || typeof event.data !== 'object') return null;
    if (event.data.type === 'relay:open') return { type: 'open' };
    if (event.data.type === 'relay:config' && event.data.config && typeof event.data.config === 'object' && !Array.isArray(event.data.config)) {
      return { type: 'configure', config: event.data.config };
    }
    return null;
  }
  if (typeof document === 'undefined') return { previewIdentity, parentAction };

  const identity = previewIdentity(location.search);
  const status = document.getElementById('preview-status');
  if (!identity) {
    status.textContent = 'This preview link is incomplete. Open a fresh preview from your widget studio.';
    status.hidden = false;
    return;
  }
  let loaded = false;
  let latestConfig = null;
  let pendingOpen = false;
  function emit(action) {
    if (action.type === 'configure') {
      latestConfig = action.config;
      if (loaded) window.dispatchEvent(new CustomEvent('gumloop:configure', { detail: { widgetId: identity.widgetId, config: latestConfig } }));
    } else {
      pendingOpen = true;
      if (loaded) window.dispatchEvent(new CustomEvent('gumloop:open', { detail: { widgetId: identity.widgetId } }));
    }
  }
  window.addEventListener('message', event => {
    const action = parentAction(event, location.origin, window.parent);
    if (action) emit(action);
  });
  document.getElementById('try-chat').addEventListener('click', () => emit({ type: 'open' }));
  const script = document.createElement('script');
  script.src = '/widget.js';
  script.dataset.widgetId = identity.widgetId;
  script.dataset.previewToken = identity.token;
  script.addEventListener('load', () => {
    loaded = true;
    if (latestConfig) emit({ type: 'configure', config: latestConfig });
    if (pendingOpen) emit({ type: 'open' });
    if (window.parent !== window) window.parent.postMessage({ type: 'relay:ready', widgetId: identity.widgetId }, location.origin);
  });
  script.addEventListener('error', () => {
    status.textContent = 'The chat preview could not load. Please refresh or open a new preview.';
    status.hidden = false;
  });
  document.body.append(script);
})();
