# Verification

The reproducible browser test is [test/studio.e2e.mjs](test/studio.e2e.mjs). It runs the real
Babylon.js starter and Vite builds in a disposable workspace. It does not substitute fake
readiness reports for browser renders.

It checks keyboard steering and jumping, pause and restart, playing through the finish,
play-again, source updates during a run, syntax errors, browser errors, recovery, selecting
older versions, a narrow viewport, expand/Escape, and a playable exported static site.
The single injected runtime error is expected; other uncaught browser errors fail the test.

The shared viewer's Node tests cover readiness gating, build/runtime recovery, retaining a
running revision beyond the ten-version history, non-overwriting exports, request and path
boundaries, and metadata updates that preserve readiness.

Installation was exercised through the CLI's real `installDsh` and `materializeWorkspace`
functions, with a separate temporary package directory and workspace. Setup and doctor passed.
Both package doctors also passed with Node absent from PATH and only Harness's recorded Node
available. The wrapper's Node publisher produced the same ten runtime files as Godogen's
upstream Babylon/Claude publisher.

## Scope

These tests exercise the local agent workspace and the live viewer. They do not run a paid
asset-generation service or assert the quality of an arbitrary model-generated game. Agent
chat and the application's terminal transport use the existing platform implementation.

The app's current `WebPanePanel` loads the supplied viewer URL directly. Remote-machine viewer
forwarding is not implemented there, so opening a remote harness's loopback URL from a different
desktop is not covered or supported by this package. That requires a shared platform transport,
not a different server bundled with every harness.
