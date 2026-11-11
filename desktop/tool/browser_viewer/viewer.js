// The page half of the Browser panel. noVNC draws the agent's browser; the host
// (Dart, through the webview's HarnessBrowser channel) carries its bytes over
// the terminal's encrypted stream and draws every state. The page draws no copy.
//
// Host to page: harnessBrowserReceive({t:'config', mac} | {t:'open'} |
// {t:'data', b64} | {t:'closed', reason} | {t:'paste', text} |
// {t:'window', width, height}).
// Page to host: {t:'ready'} | {t:'data', b64} | {t:'consumed', bytes} |
// {t:'copy', text} | {t:'state', connected}.

const XK_Control_L = 0xffe3;
const XK_v = 0x76;

function toBase64(bytes) {
  let binary = '';
  // In slices: fromCharCode.apply overflows the stack on a large frame.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function startViewer(RFB, win) {
  const post = (message) => win.HarnessBrowser.postMessage(JSON.stringify(message));
  const screen = win.document.getElementById('screen');
  let mac = false;
  let rfb = null;
  let channel = null;
  let connected = false;
  // Chrome's window on the screen, at 0,0, in screen pixels. Until the host
  // sends one, the page scales the whole screen.
  let chromeWindow = null;

  // Bytes noVNC has read out of its receive queue, which the host acks. Fed
  // faster than it draws, noVNC holds the rest and disconnects at 40 MiB, so
  // the credit window has to bound what is not drawn yet, not only what is on
  // the wire. Read once a frame at most, and only while bytes wait.
  let received = 0;
  let reported = 0;
  let scheduled = false;
  function report() {
    scheduled = false;
    if (!rfb) return;
    // noVNC 1.7.0's own Websock: build.mjs pins the version.
    const consumed = received - rfb._sock.rQlen();
    if (consumed > reported) {
      post({ t: 'consumed', bytes: consumed - reported });
      reported = consumed;
    }
    if (consumed < received) schedule();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(report);
  }

  // Shaped like an open WebSocket, so noVNC's Websock attaches it as one.
  function openChannel() {
    const ch = {
      readyState: 'open',
      binaryType: 'arraybuffer',
      protocol: '',
      send(bytes) {
        if (ch.readyState === 'open') post({ t: 'data', b64: toBase64(bytes) });
      },
      close() {
        if (ch.readyState === 'closed') return;
        ch.readyState = 'closed';
        // A WebSocket reports its close later, never inside noVNC's own close().
        queueMicrotask(() => ch.onclose({ code: 1000, reason: '', wasClean: true }));
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    return ch;
  }

  // noVNC 1.7.0 clips or scales, never both, and sets its Display back to
  // its own clip and scale after every resize of the page or of the screen,
  // each ending in _updateScale. After it, the page clips the Display to the
  // window and scales that rectangle to fit, unless it already fits at 1:1.
  // build.mjs pins the version.
  function fitWindow(current) {
    if (!chromeWindow) return;
    const display = current._display;
    display.viewportChangeSize(chromeWindow.width, chromeWindow.height);
    const page = screen.getBoundingClientRect();
    if (Math.abs(page.width - chromeWindow.width) < 1 && Math.abs(page.height - chromeWindow.height) < 1) {
      display.scale = 1;
    } else {
      display.autoscale(page.width, page.height);
    }
  }

  function showWindow(current) {
    current.dragViewport = false;
    current.clipViewport = true;
    current.scaleViewport = false;
    fitWindow(current);
  }

  function open() {
    received = 0;
    reported = 0;
    channel = openChannel();
    const current = new RFB(screen, channel);
    const updateScale = current._updateScale.bind(current);
    current._updateScale = () => {
      updateScale();
      fitWindow(current);
    };
    current.scaleViewport = true;
    if (chromeWindow) showWindow(current);
    current.qualityLevel = 6;
    current.compressionLevel = 2;
    current.addEventListener('connect', () => {
      connected = true;
      post({ t: 'state', connected: true });
      current.focus();
    });
    current.addEventListener('disconnect', () => {
      connected = false;
      if (rfb === current) rfb = null;
      post({ t: 'state', connected: false });
    });
    current.addEventListener('clipboard', (e) => {
      // An empty selection would wipe the person's own clipboard.
      if (e.detail.text) post({ t: 'copy', text: e.detail.text });
    });
    rfb = current;
  }

  function ctrlCombo(keysym, code) {
    rfb.sendKey(XK_Control_L, 'ControlLeft', true);
    rfb.sendKey(keysym, code, true);
    rfb.sendKey(keysym, code, false);
    rfb.sendKey(XK_Control_L, 'ControlLeft', false);
  }

  // clipboardPasteFrom uses the UTF-8 extended clipboard when the server has it.
  function paste(text) {
    if (!connected || !text) return;
    rfb.clipboardPasteFrom(text);
    ctrlCombo(XK_v, 'KeyV');
    rfb.focus();
  }

  win.harnessBrowserReceive = (message) => {
    switch (message.t) {
      case 'config':
        mac = message.mac;
        break;
      case 'open':
        open();
        break;
      case 'data':
        if (channel && channel.readyState === 'open') {
          const data = fromBase64(message.b64);
          received += data.byteLength;
          channel.onmessage({ data });
          schedule();
        }
        break;
      case 'closed':
        if (channel && channel.readyState === 'open') {
          channel.readyState = 'closed';
          channel.onclose({ code: 1000, reason: message.reason, wasClean: true });
        }
        break;
      case 'paste':
        paste(message.text);
        break;
      case 'window':
        chromeWindow = { width: message.width, height: message.height };
        if (rfb) showWindow(rfb);
        break;
    }
  };

  // Capture phase on the window runs before noVNC's listeners on its canvas.
  // A Mac sends no keyup for a letter while Cmd is held, so each combo is sent
  // whole and the later keyups are swallowed too (noVNC never saw their keydown).
  const swallowedUps = new Set();
  const isMeta = (e) => e.key === 'Meta' || e.code === 'MetaLeft' || e.code === 'MetaRight';
  win.addEventListener('keydown', (e) => {
    if (isMeta(e)) {
      e.stopImmediatePropagation();
      return;
    }
    // Ctrl+V on Windows and Linux: noVNC would send the key and the remote would
    // paste its own clipboard. Left unprevented, the webview fires the paste
    // event below. On a Mac, Ctrl+V fires no paste and stays the remote's key.
    if (!mac && e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyV') {
      e.stopImmediatePropagation();
      swallowedUps.add(e.code);
      return;
    }
    // Shift, Ctrl and Alt still go through noVNC: Cmd+Shift+Z becomes Ctrl+Shift+Z.
    if (!mac || !e.metaKey || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') return;
    e.stopImmediatePropagation();
    swallowedUps.add(e.code);
    // Cmd+V: unprevented, so the webview fires the paste event below.
    if (e.code === 'KeyV') return;
    e.preventDefault();
    const letter = /^Key([A-Z])$/.exec(e.code);
    if (letter && !e.repeat && rfb) ctrlCombo(letter[1].toLowerCase().charCodeAt(0), e.code);
  }, true);
  win.addEventListener('keyup', (e) => {
    if (isMeta(e) || swallowedUps.has(e.code)) {
      swallowedUps.delete(e.code);
      e.stopImmediatePropagation();
    }
  }, true);
  win.addEventListener('blur', () => swallowedUps.clear());

  win.document.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;
    e.preventDefault();
    paste(text);
  });

  post({ t: 'ready' });
}
