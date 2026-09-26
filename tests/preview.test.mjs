import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../studio/public/preview.js', import.meta.url), 'utf8');
const helpers = vm.runInNewContext(source, { URLSearchParams });
const plain = value => JSON.parse(JSON.stringify(value));

test('preview requires explicit token and widget binding', () => {
  assert.equal(helpers.previewIdentity('?widget=one'), null);
  assert.equal(helpers.previewIdentity('?token=token'), null);
  assert.equal(helpers.previewIdentity('?widget=one&token='), null);
  assert.deepEqual(plain(helpers.previewIdentity('?widget=one&token=a%2Bb')), { widgetId: 'one', token: 'a+b' });
});

test('preview bridge rejects foreign origins and same-origin sibling frames', () => {
  const parent = {}, origin = 'https://studio.example';
  const data = { type: 'relay:config', config: { title: 'New title' } };
  assert.equal(helpers.parentAction({ origin: 'https://evil.example', source: parent, data }, origin, parent), null);
  assert.equal(helpers.parentAction({ origin, source: {}, data }, origin, parent), null);
  assert.deepEqual(plain(helpers.parentAction({ origin, source: parent, data }, origin, parent)), { type: 'configure', config: { title: 'New title' } });
  assert.equal(helpers.parentAction({ origin, source: parent, data: { type: 'relay:config', config: [] } }, origin, parent), null);
  assert.equal(helpers.parentAction({ origin, source: parent, data: { type: 'relay:delete' } }, origin, parent), null);
});

test('preview loads the production runtime and replays only the latest queued cosmetic config', () => {
  const eventHandlers = {}, dispatched = [], replies = [];
  let script;
  const parent = { postMessage: (...args) => replies.push(args) };
  const window = { parent, addEventListener: (name, handler) => { eventHandlers[name] = handler; }, dispatchEvent: event => { dispatched.push(event); } };
  const status = {}, button = { addEventListener() {} };
  const document = {
    getElementById: id => id === 'preview-status' ? status : button,
    createElement: tag => { assert.equal(tag, 'script'); script = { dataset: {}, events: {}, addEventListener(name, handler) { this.events[name] = handler; } }; return script; },
    body: { append(node) { assert.equal(node, script); } },
  };
  vm.runInNewContext(source, {
    document, window, URLSearchParams,
    location: { origin: 'https://studio.example', search: '?widget=widget-one&token=preview-secret' },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  assert.equal(script.src, '/widget.js');
  assert.deepEqual(plain(script.dataset), { widgetId: 'widget-one', previewToken: 'preview-secret' });
  const deliver = data => eventHandlers.message({ origin: 'https://studio.example', source: parent, data });
  deliver({ type: 'relay:config', config: { title: 'First' } });
  deliver({ type: 'relay:config', config: { title: 'Latest' } });
  deliver({ type: 'relay:open' });
  assert.equal(dispatched.length, 0);
  script.events.load();
  assert.deepEqual(plain(dispatched), [
    { type: 'gumloop:configure', detail: { widgetId: 'widget-one', config: { title: 'Latest' } } },
    { type: 'gumloop:open', detail: { widgetId: 'widget-one' } },
  ]);
  assert.deepEqual(plain(replies), [[{ type: 'relay:ready', widgetId: 'widget-one' }, 'https://studio.example']]);
  deliver({ type: 'relay:config', config: { title: 'Live edit' } });
  assert.equal(dispatched.at(-1).detail.config.title, 'Live edit');
  assert.equal(dispatched.length, 3, 'configuration must not reopen or reset the chat');
});
