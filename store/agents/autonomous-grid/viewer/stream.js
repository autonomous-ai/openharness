// The page's one event stream, open only while the page can be seen.
//
// The viewer books its next read only while a client is listening (viewer.mjs), so a stream left open
// by a pane nobody is looking at — a background tab, a hidden desktop pane — kept it reading every few
// seconds for no one. Closed on hide, the last listener is gone and the reads stop; reopened on show,
// the server answers with its snapshot at once and reads again if that one has gone stale.
//
// A file of its own, loaded before app.js, so a test can run exactly this code against a stand-in
// document without a browser (test/nowake.test.mjs).
(root => {
  'use strict';
  function liveStream({ doc, open, onSnapshot, onError }) {
    let source = null;
    const connect = () => {
      if (source || doc.hidden) return;
      source = open('events');
      source.addEventListener('snapshot', onSnapshot);
      source.onerror = onError;
    };
    // `close()` fires no error event, so a deliberate close never reads as a lost connection.
    const disconnect = () => { if (!source) return; source.close(); source = null; };
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) disconnect(); else connect(); });
    connect();
    return { connected: () => source !== null, close: disconnect };
  }
  root.harnessViewerStream = { liveStream };
})(globalThis);
