# Film Studio checks

Run setup for both packages first. The renderer needs its headless Chrome download even when
the viewer is tested in WebKit.

```sh
bash store/agents/openmontage/toolchain/setup.sh
bash store/viewers/film-viewer/setup.sh
cd store/agents/openmontage
npm ci
npm run test:browser
npx playwright install webkit
FILM_BROWSER=webkit npm run test:browser
```

The test uses installed Chrome on macOS; otherwise install Chromium with
`npx playwright install chromium`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a browser.
`FILM_VIEWER_DIR` can point to a separate Film Viewer checkout. Screenshots and logs are written
to ignored `test-results/`, or `FILM_TEST_ARTIFACTS` when supplied.

Each run creates a disposable workspace and loopback server, and exercises seven groups:

1. Real 18-second playback, pause, scene jumps, seeking, mute, and expansion where supported.
2. Script updates from the filesystem and recovery from a partially written artifact.
3. Timed notes, reload persistence, exact-version recall, and byte-identical export/download.
4. Stale revision rejection, local origin/host checks, symlink containment, and exclusion of
   incomplete or invalid movies.
5. An actual compiler failure that reports failure and keeps the previous playable cut.
6. A successful upstream Remotion render after fixing the source, refreshed storyboard stills,
   uninterrupted old-cut playback, explicit version switching, and note recall.
7. Interrupted-render detection, separate productions, a 430-pixel layout, and browser errors.

These are real local renders through OpenMontage's `VideoCompose`, not mocked movie responses.
The render wrapper runs upstream quality review, ffprobe, and a complete FFmpeg decode before
publishing a cut. No paid provider calls are made by this suite.

## Verification record — September 17, 2026

- macOS Apple Silicon; Node 22.23.1; managed Python 3.12.9.
- Chromium and WebKit browser suites passed. Simultaneous suites use the same installed composer
  and separate workspaces with the same project slug, exercising render staging isolation.
- The original starter rendered at 1280 × 720, 24 fps, with four scenes and audio. Full decode
  passed. The 18-second timeline has approximately 48 ms of AAC container padding.
- Film Viewer setup passed with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, downloading its own FFmpeg
  7.1.1. No Homebrew or system Python was needed.
- Actual CLI `installDsh`, workspace materialization and repeat materialization, shared viewer
  resolution, viewer process startup/shutdown, and verdict parsing passed in an isolated index.
- Store, materialization, catalog, and viewer lifecycle suites: **197 tests passed**.

To repeat the repository checks from `cli/`:

```sh
npm exec -- vitest run src/dsh/store.spec.ts src/dsh/materialize.spec.ts \
  src/dsh/viewer.spec.ts src/dsh/catalog.spec.ts
```

The tests need loopback networking and process execution. A restricted sandbox that refuses
`listen(127.0.0.1)` cannot run the viewer lifecycle checks.

This record does not establish paid generation-provider availability, Linux/Windows support,
remote viewer forwarding, or native desktop end-to-end behavior. Browser playback and the real
CLI viewer lifecycle were verified separately; a live Claude/Codex conversation was not scripted.
