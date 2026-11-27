import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startViewer } from './viewer.js';
import { buildViewerHtml } from './build.mjs';

// noVNC's logging reads window.console when it loads.
globalThis.window = globalThis;
const { default: Websock } = await import('./node_modules/@novnc/novnc/core/websock.js');
const { default: Display } = await import('./node_modules/@novnc/novnc/core/display.js');

// Enough canvas for noVNC's real Display: it sizes and scales, nothing is drawn.
function canvas() {
  const context = { drawImage() {}, getImageData() { return {}; }, putImageData() {} };
  return { width: 0, height: 0, style: {}, getContext: () => context };
}
globalThis.document = { createElement: canvas };

// The Device setting's screen, which Xvnc sends at the handshake.
const SCREEN = { width: 1920, height: 1080 };

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
// channel through noVNC's own Websock and draws with noVNC's own Display.
function page({ mac, size = { width: 1200, height: 800 } }) {
  const win = new EventTarget();
  const doc = new EventTarget();
  const touches = [];
  // The page's size; a test resizes the page by changing it.
  const pageSize = { ...size };
  const screen = recorded({ getBoundingClientRect: () => ({ ...pageSize }) }, touches);
  doc.getElementById = (id) => (id === 'screen' ? screen : null);
  win.document = recorded(doc, touches);
  const posted = [];
  // Frames run when the test says, so it can tell what the page reports per frame.
  const frames = [];
  win.requestAnimationFrame = (callback) => frames.push(callback);
  const frame = () => frames.splice(0).forEach((callback) => callback());
  win.HarnessBrowser = { postMessage: (message) => posted.push(JSON.parse(message)) };
  const rfbs = [];
  class FakeRFB extends EventTarget {
    constructor(target, channel) {
      super();
      this.target = target;
      this.channel = channel;
      this.log = [];
      this._sock = new Websock();
      this._sock.attach(channel);
      this._sock.on('close', () => this.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: true } })));
      this._display = new Display(canvas());
      this.dragViewport = false;
      this._clipViewport = false;
      this._scaleViewport = false;
      rfbs.push(this);
    }
    // noVNC 1.7.0's clip and scale paths (core/rfb.js), on its own copy of the
    // page's size: noVNC measures the div it puts inside the target.
    get clipViewport() { return this._clipViewport; }
    set clipViewport(clip) {
      this._clipViewport = clip;
      this._updateClip();
    }
    get scaleViewport() { return this._scaleViewport; }
    set scaleViewport(scale) {
      this._scaleViewport = scale;
      if (scale && this._clipViewport) this._updateClip();
      this._updateScale();
      if (!scale && this._clipViewport) this._updateClip();
    }
    _updateClip() {
      const clip = this._clipViewport && !this._scaleViewport;
      if (this._display.clipViewport !== clip) this._display.clipViewport = clip;
      if (clip) this._display.viewportChangeSize(pageSize.width, pageSize.height);
    }
    _updateScale() {
      if (!this._scaleViewport) this._display.scale = 1.0;
      else this._display.autoscale(pageSize.width, pageSize.height);
    }
    // The handshake's screen size (RFB._resize).
    serverInit() {
      this._display.resize(SCREEN.width, SCREEN.height);
      this._updateClip();
      this._updateScale();
    }
    // What noVNC runs when the page resizes (RFB._handleResize).
    relayout() {
      this._updateClip();
      this._updateScale();
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
  rfb.serverInit();
  rfb.dispatchEvent(new Event('connect'));
  return { win, doc, posted, rfb, rfbs, send, touches, frame, pageSize };
}

// What the page shows of the screen: the rectangle at the top left and its scale.
function shown(rfb) {
  const display = rfb._display;
  return {
    clip: rfb.clipViewport,
    scaleViewport: rfb.scaleViewport,
    drag: rfb.dragViewport,
    x: display.absX(0),
    y: display.absY(0),
    width: display._viewportLoc.w,
    height: display._viewportLoc.h,
    scale: display.scale,
  };
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
  assert.deepEqual([...rfb._sock.rQshiftBytes(4)], [0, 1, 254, 255]);
  const big = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
  rfb._sock.sQpushBytes(big);
  rfb._sock.flush();
  const sent = Buffer.concat(posted.filter((m) => m.t === 'data').map((m) => Buffer.from(m.b64, 'base64')));
  assert.deepEqual(new Uint8Array(sent), big);
});

test('bytes are reported consumed only once noVNC has read them, at most once a frame', () => {
  const { rfb, posted, send, frame } = page({ mac: false });
  const consumed = () => posted.filter((m) => m.t === 'consumed').map((m) => m.bytes);
  send({ t: 'data', b64: Buffer.alloc(10).toString('base64') });
  send({ t: 'data', b64: Buffer.alloc(6).toString('base64') });
  frame();
  // Nothing read yet: noVNC still holds all 16 bytes, as it does while it draws.
  assert.deepEqual(consumed(), []);
  rfb._sock.rQshiftBytes(12);
  frame();
  assert.deepEqual(consumed(), [12]);
  rfb._sock.rQshiftBytes(4);
  frame();
  assert.deepEqual(consumed(), [12, 4]);
  // All read: no frame is asked for until more bytes come.
  frame();
  assert.deepEqual(consumed(), [12, 4]);
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
  rfb._sock.close();
  await Promise.resolve();
  assert.equal(rfb.channel.readyState, 'closed');
  assert.deepEqual(posted.at(-1), { t: 'state', connected: false });
});

test('before any window message the screen is scaled to fit, as before', () => {
  const { rfb } = page({ mac: false });
  assert.deepEqual(shown(rfb), {
    clip: false, scaleViewport: true, drag: false, x: 0, y: 0, width: 1920, height: 1080, scale: 1200 / 1920,
  });
});

test('a window the size of the page is clipped to that rectangle at 0,0 at 1:1', () => {
  const { rfb, send } = page({ mac: false });
  send({ t: 'window', width: 1200, height: 800 });
  assert.deepEqual(shown(rfb), {
    clip: true, scaleViewport: false, drag: false, x: 0, y: 0, width: 1200, height: 800, scale: 1,
  });
  // A click lands where it is on Chrome's window.
  assert.equal(rfb._display.absX(700), 700);
  assert.equal(rfb._display.absY(500), 500);
});

test('a window within a pixel of a fractional page is still 1:1', () => {
  const { rfb, send } = page({ mac: false, size: { width: 1137.5, height: 843.25 } });
  send({ t: 'window', width: 1137, height: 843 });
  assert.equal(shown(rfb).width, 1137);
  assert.equal(shown(rfb).height, 843);
  assert.equal(shown(rfb).scale, 1);
});

test('a window larger or smaller than the page is that rectangle scaled to fit', () => {
  const small = page({ mac: false, size: { width: 800, height: 600 } });
  small.send({ t: 'window', width: 1024, height: 640 });
  assert.deepEqual(shown(small.rfb), {
    clip: true, scaleViewport: false, drag: false, x: 0, y: 0, width: 1024, height: 640, scale: 800 / 1024,
  });
  // A click maps back through the scale onto Chrome's window.
  assert.equal(small.rfb._display.absX(400), 512);

  const large = page({ mac: false, size: { width: 2400, height: 1500 } });
  large.send({ t: 'window', width: 1920, height: 1080 });
  assert.deepEqual(shown(large.rfb), {
    clip: true, scaleViewport: false, drag: false, x: 0, y: 0, width: 1920, height: 1080, scale: 2400 / 1920,
  });
});

test('the page resizing scales again without another message', () => {
  const { rfb, send, pageSize } = page({ mac: false });
  send({ t: 'window', width: 1200, height: 800 });
  pageSize.width = 1000;
  pageSize.height = 700;
  rfb.relayout();
  assert.deepEqual(shown(rfb), {
    clip: true, scaleViewport: false, drag: false, x: 0, y: 0, width: 1200, height: 800, scale: 1000 / 1200,
  });
  pageSize.width = 1200;
  pageSize.height = 800;
  rfb.relayout();
  assert.equal(shown(rfb).scale, 1);
});

test('a new connection keeps the last window', () => {
  const { rfbs, send } = page({ mac: false });
  send({ t: 'window', width: 1100, height: 700 });
  send({ t: 'window', width: 1200, height: 800 });
  send({ t: 'closed', reason: 'gone' });
  send({ t: 'open' });
  const next = rfbs[1];
  next.serverInit();
  assert.deepEqual(shown(next), {
    clip: true, scaleViewport: false, drag: false, x: 0, y: 0, width: 1200, height: 800, scale: 1,
  });
});

test('the committed html equals a fresh build', async () => {
  const committed = readFileSync(new URL('../../assets/browser/browser_viewer.html', import.meta.url), 'utf8');
  assert.equal(committed, await buildViewerHtml());
});
