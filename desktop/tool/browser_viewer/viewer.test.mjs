import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startViewer } from './viewer.js';
import { buildViewerHtml } from './build.mjs';

// noVNC's logging reads window.console when it loads.
globalThis.window = globalThis;
const { default: Websock } = await import('./node_modules/@novnc/novnc/core/websock.js');

const XK_Control_L = 0xffe3;

// Records what the page touches, so a test can prove it drew nothing.
function recorded(target, touches) {
  return new Proxy(target, {
    get(object, key) {
      touches.push(key);
      const value = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    },
    set(object, key, value) {
      touches.push(key);
      return Reflect.set(object, key, value);
    },
  });
}

// A page with a fake host and a fake RFB that, like the real one, reads the
// channel through noVNC's own Websock.
function page({ mac }) {
  const win = new EventTarget();
  const doc = new EventTarget();
  const touches = [];
  const screen = recorded({}, touches);
  doc.getElementById = (id) => (id === 'screen' ? screen : null);
  win.document = recorded(doc, touches);
  const posted = [];
  win.HarnessBrowser = { postMessage: (message) => posted.push(JSON.parse(message)) };
  const rfbs = [];
  class FakeRFB extends EventTarget {
    constructor(target, channel) {
      super();
      this.target = target;
      this.channel = channel;
      this.log = [];
      this.sock = new Websock();
      this.sock.attach(channel);
      this.sock.on('close', () => this.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: true } })));
      rfbs.push(this);
    }
    sendKey(keysym, code, down) { this.log.push(['key', keysym, code, down]); }
    clipboardPasteFrom(text) { this.log.push(['paste', text]); }
    focus() {}
  }
  startViewer(FakeRFB, win);
  touches.length = 0;
  const send = (message) => win.harnessBrowserReceive(message);
  send({ t: 'config', mac });
  send({ t: 'open' });
  const rfb = rfbs[0];
  rfb.dispatchEvent(new Event('connect'));
  return { win, doc, posted, rfb, send, touches };
}

function key(type, props) {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, repeat: false, stopped: false,
  }, props);
  event.stopImmediatePropagation = () => { event.stopped = true; };
  return event;
}

const ctrlV = [
  ['key', XK_Control_L, 'ControlLeft', true],
  ['key', 0x76, 'KeyV', true],
  ['key', 0x76, 'KeyV', false],
  ['key', XK_Control_L, 'ControlLeft', false],
];

test("the channel has every property noVNC's Websock checks, including protocol", () => {
  const source = readFileSync(new URL('./node_modules/@novnc/novnc/core/websock.js', import.meta.url), 'utf8');
  const checked = [.../const rawChannelProps = \[([^\]]*)\]/.exec(source)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(checked.includes('protocol'));
  const { rfb, posted } = page({ mac: false });
  for (const prop of [...checked, 'onclose']) assert.ok(prop in rfb.channel, prop);
  assert.equal(rfb.channel.readyState, 'open');
  assert.deepEqual(posted, [{ t: 'ready' }, { t: 'state', connected: true }]);
});

test('bytes pass both ways', () => {
  const { rfb, posted, send } = page({ mac: false });
  send({ t: 'data', b64: Buffer.from([0, 1, 254, 255]).toString('base64') });
  assert.deepEqual([...rfb.sock.rQshiftBytes(4)], [0, 1, 254, 255]);
  const big = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
  rfb.sock.sQpushBytes(big);
  rfb.sock.flush();
  const sent = Buffer.concat(posted.filter((m) => m.t === 'data').map((m) => Buffer.from(m.b64, 'base64')));
  assert.deepEqual(new Uint8Array(sent), big);
});

test('cmd+letter is sent as ctrl+letter on mac, and cmd never reaches the remote', () => {
  const { win, rfb } = page({ mac: true });
  const events = [
    key('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true }),
    key('keydown', { key: 'c', code: 'KeyC', metaKey: true }),
    key('keyup', { key: 'c', code: 'KeyC', metaKey: true }),
    key('keyup', { key: 'Meta', code: 'MetaLeft' }),
  ];
  for (const event of events) win.dispatchEvent(event);
  assert.deepEqual(events.map((e) => e.stopped), [true, true, true, true]);
  assert.equal(events[1].defaultPrevented, true);
  assert.deepEqual(rfb.log, [
    ['key', XK_Control_L, 'ControlLeft', true],
    ['key', 0x63, 'KeyC', true],
    ['key', 0x63, 'KeyC', false],
    ['key', XK_Control_L, 'ControlLeft', false],
  ]);
});

test('ctrl+v on windows and linux becomes a paste', () => {
  const { win, doc, rfb } = page({ mac: false });
  const down = key('keydown', { key: 'v', code: 'KeyV', ctrlKey: true });
  const up = key('keyup', { key: 'v', code: 'KeyV', ctrlKey: true });
  win.dispatchEvent(down);
  // Not prevented: the webview turns it into the paste event below.
  assert.equal(down.stopped, true);
  assert.equal(down.defaultPrevented, false);
  const paste = Object.assign(new Event('paste', { cancelable: true }), {
    clipboardData: { getData: (type) => (type === 'text/plain' ? 'héllo' : '') },
  });
  doc.dispatchEvent(paste);
  win.dispatchEvent(up);
  assert.equal(up.stopped, true);
  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(rfb.log, [['paste', 'héllo'], ...ctrlV]);

  // On a Mac, Ctrl+V stays the remote's own key.
  const mac = page({ mac: true });
  const macDown = key('keydown', { key: 'v', code: 'KeyV', ctrlKey: true });
  mac.win.dispatchEvent(macDown);
  assert.equal(macDown.stopped, false);
});

test('paste sets the clipboard, then sends Ctrl+V', () => {
  const { rfb, send } = page({ mac: true });
  send({ t: 'paste', text: 'Xin chào 👋' });
  assert.deepEqual(rfb.log, [['paste', 'Xin chào 👋'], ...ctrlV]);
});

test("copy from the remote posts {t:'copy'}", () => {
  const { rfb, posted } = page({ mac: false });
  rfb.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'Xin chào 👋' } }));
  assert.deepEqual(posted.at(-1), { t: 'copy', text: 'Xin chào 👋' });
});

test('closed posts state and draws nothing of its own', () => {
  const { rfb, posted, send, touches } = page({ mac: false });
  send({ t: 'closed', reason: 'rate' });
  assert.equal(rfb.channel.readyState, 'closed');
  assert.deepEqual(posted.at(-1), { t: 'state', connected: false });
  assert.deepEqual(touches, []);
});

test('a close from noVNC reaches the host as a state', async () => {
  const { rfb, posted } = page({ mac: false });
  rfb.sock.close();
  await Promise.resolve();
  assert.equal(rfb.channel.readyState, 'closed');
  assert.deepEqual(posted.at(-1), { t: 'state', connected: false });
});

test('the committed html equals a fresh build', async () => {
  const committed = readFileSync(new URL('../../assets/browser/browser_viewer.html', import.meta.url), 'utf8');
  assert.equal(committed, await buildViewerHtml());
});
