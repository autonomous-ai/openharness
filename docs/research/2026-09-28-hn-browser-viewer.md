# hn browser viewer handoff

`hn view` opens the focused harness's existing viewer in the user's default browser.
`hn view -t <harness>` also works from a shell without starting or attaching a terminal.
The command palette exposes `open-viewer`; tmux's keys are unchanged. The harness preview
and a focused harness's ready notification tell the user when a viewer is available.

On a local desktop, a local harness opens its managed viewer URL directly. SSH, another
linked machine, `-w`, and copying with `-c` use the browser app's authenticated destination:
`/?viewer=1&machine=<encoded-id>&agent=<encoded-id>`. The existing website root rewrite
serves this entry point. No new server route, public listener, or share is created. URLs
contain identities, never account tokens or link credentials. The browser still signs in
as the owner and establishes its own machine link.

The invoking CLI process chooses whether to launch a browser. A request forwarded to an
existing hn client only obtains the URL; the client's older SSH/display environment cannot
make the invoking shell launch a browser on the wrong host. `-p` prints only, `-c` copies
through the terminal clipboard when supported, and an unavailable/failed browser opener
falls back to printing the link. URL schemes, credentials and control characters are checked
before starting an opener, which receives a single argv value without a shell.

The browser companion reuses the existing interactive viewer. It never joins the shared
desk, restores or saves its terminal layout, or attaches a terminal stream. Its destination
survives OAuth's callback. It shows linking, offline, missing harness, waiting viewer and
retry states. Closing it only releases its viewer surface; the agent remains running.
A Chrome interaction test also exposed the viewer image's missing explicit dimensions:
the image now fills the same viewport used to normalize pointer coordinates, including
while decoding and when the remote renderer caps its resolution.

## Boundaries

The existing remote interactive-viewer transport renders on the harness machine using
Chrome or Chromium and relays encrypted images and input. This change reuses that transport;
it does not introduce browser-side WebGL rendering or install a renderer. Local direct
viewers use the user's browser without that additional renderer. Existing browser viewer
limitations, including server-side rendering requirements, remain.

Release the browser app before native hn so new links are understood before hn emits them.
This work does not publish a release, reinstall the user's hn, change the production daemon,
or change creature behavior.

## Validation

All hn tests use a disposable HOME, a frozen binary, an explicit socket prefix, matching
`PORT`/`--port`, unset tmux/socket variables, and guarded test ports. Test processes,
harnesses and named tmux servers are cleaned up after success or failure.

- 124 Rust release unit tests and the existing terminal end-to-end suite pass.
- `tui/tests/viewer.py` exercises standalone, IPC and real TUI command-prompt paths: local
  opening, every SSH environment variable, peers, print/copy, exact opener arguments,
  missing/failed/hung openers, ambiguous names, waiting/error/unsafe viewers and damaged IPC
  replies. Linux also checks a headless shell and Wayland. Both Linux CI architecture jobs
  run this suite.
- 157 Flutter regressions cover routing, OAuth, QR sign-in integration, account transitions,
  machine linking, desk isolation and existing workspace behavior. Another 23 headless Chrome
  checks exercise browser routing and input.
- `tui/tests/viewer-live.mjs` passes on a physical Apple Silicon Mac with the actual hn,
  daemon, backend, MongoDB replica set, Redis, Blender DSH package, model viewer and Chrome.
  It renders a glTF fixture, completes browser OAuth and encrypted password linking, sends
  mouse/Unicode/special-key input, checks pointer mapping above the renderer resolution cap,
  reloads, stops and restarts the backend, and checks malformed UTF-8 links.
  Closing the browser leaves the harnesses running. No browser input reaches their terminals,
  and the browser never reads or overwrites the shared desk.
- The live test substitutes only the OAuth provider and model CLI with deterministic local
  fixtures. This is a real local stack test, not a production-account or two-computer test.
  Its browser blocks HTTP requests outside loopback. The installed hn and production daemons
  are never used.

Coverage is **100% of executable lines** in the three new modules: `tui/src/viewer.rs`
(120/120 production lines, excluding its unit tests), `viewer_location.dart` (29/29) and
`viewer_page.dart` (76/76). Rust coverage combines unit tests with instrumented public CLI
and TUI runs; Flutter coverage comes from routing and page tests. The existing renderer
and input transport also reach 195/195 lines in their 34 tests, with 95.37% branch coverage.
These figures do not claim repository-wide coverage or prove every possible edge case is
covered. Coverage artifacts and screenshots stay outside the repository.

### Failures caught before merge

- Invalid UTF-8 in viewer queries threw before validation. The route now recognizes its flag
  without decoding broken values and shows an error without restoring the workspace.
- A configured browser base with a non-root path produced a link the app could not route.
  hn now rejects it with a useful error.
- RPC failures hid renderer guidance behind a generic disconnect message. The browser now
  displays the daemon's error detail, including renderer and viewer-limit guidance.
- On this Mac, the private Chrome renderer's first navigation timed out even on a plain local
  page. The same process with `--use-mock-keychain` navigated in 23–93 ms and rendered the
  Blender model. Its temporary, credential-free profile now bypasses OS credential stores
  (`--use-mock-keychain`, `--password-store=basic`), avoiding an invisible unlock prompt.
  The user's regular browser profile is untouched. See
  [Chromium's Mac instructions](https://github.com/chromium/chromium/blob/main/docs/mac_build_instructions.md).

### Reproduce the physical-machine check

Install repository CLI/backend dependencies and `store/viewers/model-viewer` dependencies,
then build hn. The opt-in runner requires Chrome/Chromium, tmux, MongoDB and Redis executables,
plus a separate test-tools directory containing `playwright@1.63.0`,
`mongodb-memory-server@11.2.0` and `redis-memory-server@0.17.1`. It installs nothing and
changes no real Harness installation. Its fixed ports are 19680–19686.

Build the browser entrypoint from `desktop/`:

```sh
flutter build web --release --no-pub --no-wasm-dry-run --no-web-resources-cdn \
  --dart-define=HARNESS_TEST=true --dart-define=HARNESS_API_URL=http://127.0.0.1:19680 \
  --output=/tmp/hn-viewer-web
```

Then run from the repository root, substituting paths to your test dependencies:

```sh
HN_VIEWER_LIVE_TEST=1 \
HN_VIEWER_SERVICES_DIR=/path/to/test-tools \
HN_VIEWER_TOOLS_DIR=/path/to/test-tools \
HN_VIEWER_WEB_DIR=/tmp/hn-viewer-web \
HN_VIEWER_BINARY="$PWD/tui/target/release/harness-tui" \
HN_VIEWER_MONGOD=/path/to/mongod \
HN_VIEWER_REDIS=/path/to/redis-server \
node tui/tests/viewer-live.mjs
```

Set `HN_VIEWER_CHROME` and `HN_VIEWER_TMUX` if executables are elsewhere. The runner prints
its private temporary directory containing results, screenshots and logs. It has only been
run on macOS; Linux native behavior is covered separately by CI.
