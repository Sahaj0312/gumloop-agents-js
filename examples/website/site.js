for (const button of document.querySelectorAll('[data-open-chat]')) {
  button.addEventListener('click', () => window.dispatchEvent(new CustomEvent('gumloop:open', { detail: { widgetId: 'demo' } })));
}
