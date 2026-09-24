// What the page's wake bar shows for a snapshot: the asleep view's "Wake now", held while the daemon
// starts the grid, and the sentence it ended with (viewer.mjs publishes it as `snapshot.wake`).
//
// A file of its own, loaded before app.js, so a test can run exactly this code without a browser
// (test/wake.test.mjs) — the same arrangement as stream.js.
(root => {
  'use strict';
  const RESTING = 'Resting to save resources. It starts by itself when you send a message.';
  function wakeView(snapshot) {
    const asleep = snapshot?.status === 'asleep', wake = snapshot?.wake || null;
    if (wake?.state === 'waking') return { hidden: false, message: wake.message, button: true, disabled: true };
    // Started: the engines on the map are the answer. Until the read that draws them lands, say so.
    if (wake?.state === 'awake') return asleep ? { hidden: false, message: wake.message, button: false, disabled: true } : { hidden: true };
    // Any other ending stands where it happened; a grid still asleep can be asked again.
    if (wake) return { hidden: false, message: wake.message, button: asleep, disabled: false };
    return asleep ? { hidden: false, message: RESTING, button: true, disabled: false } : { hidden: true };
  }
  root.harnessViewerWake = { RESTING, wakeView };
})(globalThis);
