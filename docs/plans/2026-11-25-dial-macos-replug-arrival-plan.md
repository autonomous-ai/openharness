# Dial: a replugged dial is found at once on macOS: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS the devices process hears a `/dev` node made or removed within milliseconds and the fleet scans
250 ms later (`ARRIVAL_SETTLE_MS`), not at the next 2 s tick; without the helper, the tick finds the dial as today.

**Architecture:** A new libc-only C helper, `cli/native/darwin-dev-watch.c`, blocks in `kevent()` on `/dev`
(`EVFILT_VNODE`/`NOTE_WRITE`/`EV_CLEAR`) and on stdin (`EVFILT_READ`), printing `dev\n` per wake. It ships the way
`darwin-process-images` does: the same builder writes it as a `devWatch` entry into the same artifact JSON,
`build-bundle.mjs` pins it as `__DARWIN_DEV_WATCH__`, and `prepareProcessImageHelper` (now given a folder) extracts it to
`<runtime>/dev-watch/<sha256>`. `watchDialArrivals` (`cli/src/cable/serial.ts`) gains a darwin branch that spawns it
through a `spawnDevWatch` dep and turns each `dev` line into `signal()`. `CableFleet` is unchanged.

**Tech Stack:** C11 (libc, `xcrun clang`, `lipo`, ad-hoc `codesign`), Python 3 `unittest` + `pty.openpty()`, TypeScript
(Node 24), Vitest with injected fakes, `node:test`, esbuild.

**Spec:** `docs/plans/2026-11-25-dial-macos-replug-arrival-design.md` (approved; read it with this plan). Base:
`feat/dial-macos-replug-arrival` at `891f542406`.

Paths: commands run in `cli/` unless they start with a path from the repo root.

## Decisions already made (PM, 2026-11-25): not reopened

1. Option B: kqueue on `/dev` in its own C helper `cli/native/darwin-dev-watch.c`, not a third mode of
   `darwin-process-images` (the core runs that one).
2. C on the `darwin-process-images.c` precedent (#670), not Rust; built by `cli/scripts/build-process-images.py` into
   the same artifact JSON (`devWatch` entry), defined in `cli/build-bundle.mjs` as `__DARWIN_DEV_WATCH__`, extracted by
   `prepareProcessImageHelper` with the folder name as a parameter.
3. `watchDialArrivals` gains a darwin branch with a `spawnDevWatch` dep; `CableFleet` is unchanged.
4. No real dial replug check, no e2e. The native test, bundle checks, `npm run test:core` and any heavy suite run only
   in a Mac slot the PM grants (Verification says which).
5. `prepareProcessImageHelper` in `cli/src/lib/nativeProcessImages.ts` takes the folder name as a parameter, default
   `process-images` (Task 3). That file is a core file (`cli/src/architecture.coreFiles.txt:399`): the one parameter
   changes it, its default keeps what the core does unchanged, so `npm run test:core` runs once (Verification check 8).
6. **`spawnDevWatch`'s type is `() => Promise<ChildProcess> | null`**: `null` at once when the build has no helper;
   the promise rejects when the pinned bytes cannot be written (extraction is async).
7. **A build with no helper logs nothing**: `watchDialArrivals` returns `undefined` silently. The one ended line stays for
   a helper that exits or cannot be spawned.
8. **No runtime measure** (AGENTS.md rule 8): the latency is recorded by the native test only (Task 1, check 4).

## What this plan decides from the spec's words

1. **The real dep lives in `serial.ts` as `spawnBundledDevWatch()`**: it reads the `__DARWIN_DEV_WATCH__` define
   synchronously and loads `cable/devWatch.ts` by dynamic `import()`, as the Windows branch loads `windowsSerial.ts`.
   `devWatch.ts` imports `lib/nativeProcessImages.ts`, which imports `config/env.ts`; a static import would pull the
   config into the real-PTY fixtures bundled from `serial.ts` (the comment at `serial.ts:20-21`).
2. **The `devWatch` artifact entry carries its own `sourceSha256`** (of `darwin-dev-watch.c`) besides `sha256`, `size`
   and `base64`, so a stale helper is refused exactly as a stale process helper is. The top-level `builderSha256` covers
   the builder for both.
3. **`readDevWatchBundle` is a second export of `cli/scripts/lib/processImageBundle.mjs`**; `readProcessImageBundle`
   and the `__DARWIN_PROCESS_IMAGES__` value the core reads stay byte-for-byte as today. Its output's key order is
   `schema, sha256, size, base64`, so the e2e perf report's regex (`bundledProcessImages`, which matches
   `"schema":1,"size":`) never reads the dev-watch helper's hash as the process helper's.
4. **The helper is spawned with `env: {}` and stderr ignored**: it reads no environment and prints nothing on stderr.
5. **`release.yml` is unchanged**: the `process-images` job runs the same builder, which now builds, signs and
   smoke-runs both helpers into the one uploaded JSON; `publish` sets `HARNESS_REQUIRE_PROCESS_IMAGES=1`, which now
   also requires the `devWatch` entry.

## Global Constraints

- macOS only. The Linux and Windows branches of `watchDialArrivals` do not change.
- `CableFleet`, `ARRIVAL_SETTLE_MS` (250 ms) and the 2 s tick do not change. No respawn of the helper.
- Helper: `darwin-dev-watch --watch` only; prints `{"schema":1,"mode":"watch"}\n` once armed, then `dev\n` once per
  `kevent()` wake holding a `/dev` event; stdin EOF exits 0; any failure (open, kqueue, write) exits non-zero with no
  further output; wrong arguments exit 64 with no output. libc only; reads no names, ids or content.
- Build: arm64 (`-mmacosx-version-min=11.0`) and x86_64 (`10.15`), `-std=c11 -Wall -Wextra -Werror -O2`, `lipo`,
  ad-hoc `codesign` with identifier `ai.autonomous.harness.dev-watch`, `--verify --strict --all-architectures`, host
  slice smoke run — the same steps as the process helper.
- Extraction: `<ADAPTER_RUNTIME_DIR>/dev-watch/<sha256>`, through `prepareProcessImageHelper`; `process-images` stays
  the default folder and its behavior is unchanged.
- Log line, verbatim: `cable: /dev watch ended (<kind>) — a new dial is found by the next scan` (exit or spawn error,
  said once); a build with no helper logs nothing. `<kind>` is `errorKind(error)` for an error, `exit <code>` or the signal name
  for an exit.
- Bounds: one helper per devices process; the line parser keeps at most 64 bytes of a partial line (a longer line is
  dropped up to its newline).
- Hard rules for anyone running this plan's checks: never open a serial port, never flash, never touch or replug a dial,
  never restart the user's harness daemon, never `harness device notify`, never `pgrep -f` / `ps aux` / `ps -o args`.
  The native test makes devfs nodes only with `pty.openpty()` and closes them. No fixed sleeps: every wait is a
  `select()` or `wait()` with a deadline.

## Review Focus

1. **The fleet stops before the helper's start resolved** (`CableFleet.stop()` during extraction): the child that
   arrives later is killed with its stdin ended, never signals, and nothing is logged. Task 5, case f.
2. **The daemon's own kill is not a failure**: after the unsubscribe, the helper's exit logs nothing. Task 5, case e.
3. **A line split across chunks, or one longer than 64 bytes**: `de` + `v\n` is one arrival; 100 bytes with no newline
   is dropped and the next `dev` still counts; memory stays bounded. Task 5, cases a and g.
4. **stdin readable but not at EOF** (bytes written to the helper): the watch keeps running and still prints `dev`.
   Task 1, `test_bytes_on_stdin_do_not_end_the_watch`.
5. **Both helpers in one bundle**: the perf report's `bundledProcessImages` still names the process helper's hash, and
   the two helpers' folders never hand one's file out for the other. Task 2 (`processImages.spec.ts` case) and Task 3.

---

### Task 1: The helper (`cli/native/darwin-dev-watch.c`)

Effort: `high`. Depends on: none. Runs in the PM's Mac slot (clang, kqueue, ptys).

**Files:**
- Create: `cli/native/darwin-dev-watch.c`
- Create: `cli/native/test_dev_watch.py`

**Interfaces:**
- Produces: the executable protocol in Global Constraints; the source path `cli/native/darwin-dev-watch.c` (Task 2 builds
  and hashes it).

- [ ] **Step 1: Write the failing test `cli/native/test_dev_watch.py`**

`unittest`, `@unittest.skipUnless(sys.platform == 'darwin', ...)`, class `DevWatchTest`. `setUpClass` builds
`cli/native/darwin-dev-watch.c` for the host with `/usr/bin/xcrun clang -std=c11 -Wall -Wextra -Werror -O2` into a
`tempfile.TemporaryDirectory`. A `start()` helper `Popen`s it with `--watch`, `stdin=PIPE, stdout=PIPE, stderr=PIPE,
bufsize=0`, registers cleanup (kill, wait, close streams, close every pty fd the test opened), and reads the first line
with `select` (5 s deadline) and `os.read` on the stdout fd. Cases:

```python
def test_header_once_armed(self):          # first line == b'{"schema":1,"mode":"watch"}\n'
def test_a_node_made_in_dev_is_a_dev_line(self):
    # open 60 ptys with pty.openpty() and keep them; within 1 s at least one line;
    # every line read is exactly b'dev\n' (nothing else, no names); close all 60
def test_node_to_line_latency_under_5_ms(self):
    # 20 rounds: drain pending lines (select timeout 0), t0 = perf_counter(), pty.openpty(),
    # select up to 1 s; a b'dev\n' line counts as heard with ms = (now - t0) * 1000.
    # print min/median/max (the median is the measure the PR records); assert heard >= 1 and min(heard) < 5:
    # a bound on the median can fail under load (2.8 ms just after a build, 0.3 ms idle); the fastest round holds
def test_stdin_eof_exits_0(self):          # stdin.close(); wait(timeout=1) == 0
def test_bytes_on_stdin_do_not_end_the_watch(self):
    # write b'x\n' to stdin; poll() is None; open 60 ptys -> a b'dev\n' line within 1 s
def test_bad_arguments_exit_64_with_no_output(self):
    # for argv in [[], ['--paths'], ['--watch', 'x'], ['--Watch'], ['watch']]:
    #   run with timeout 5 -> returncode == 64, stdout == b''
```

- [ ] **Step 2: Run it, expect FAIL**

Run (repo root): `python3 cli/native/test_dev_watch.py`
Expected: errors in `setUpClass`: clang cannot find `darwin-dev-watch.c`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/native/test_dev_watch.py
git commit -m "Dial: a /dev watch helper for macOS arrivals (red test)"
```

- [ ] **Step 4: Write `cli/native/darwin-dev-watch.c`**

`int main(int argc, char **argv)`: exactly `argc == 2 && !strcmp(argv[1], "--watch")`, else return 64 before any
output. `open("/dev", O_RDONLY | O_EVTONLY)`, `kqueue()`, one `kevent()` changelist call adding `EVFILT_VNODE`
(`EV_ADD | EV_CLEAR`, `NOTE_WRITE`) on the `/dev` fd and `EVFILT_READ` (`EV_ADD`) on fd 0; then `write(1, header)`.
Loop: `kevent()` for up to 2 events (retry on `EINTR`). A stdin event with `EV_EOF`, or a `read(0)` returning 0, exits
0 (EOF wins over a `/dev` event in the same wake); `read(0)` bytes are discarded; a `read` or `kevent` error exits 1.
A `/dev` event in the wake writes `dev\n` once; a short or failed `write` exits 1. A comment at the top says why the
helper exists (Node's `fs.watch('/dev')` hears nothing on macOS: FSEvents, measured in the spec) and why it is not a
mode of `darwin-process-images` (the core runs that one).

- [ ] **Step 5: Run it, expect PASS**

Run: `python3 cli/native/test_dev_watch.py -v`
Expected: 6 tests OK; the latency line printed (expected well under 5 ms median). Record the printed numbers for the PR.

- [ ] **Step 6: Commit**

```bash
git add cli/native/darwin-dev-watch.c
git commit -m "Dial: a /dev watch helper for macOS arrivals"
```

---

### Task 2: Build, pin and read the helper (`build-process-images.py`, `processImageBundle.mjs`)

Effort: `high`. Depends on: Task 1 (the source it builds and hashes). Steps 2 and 6's Python runs need the PM's Mac slot;
the `node --test` and the single vitest file do not.

**Files:**
- Modify: `cli/scripts/build-process-images.py`
- Modify: `cli/scripts/lib/processImageBundle.mjs`
- Test: `cli/scripts/test-process-image-bundle.mjs`
- Test: `cli/native/test_process_images.py`
- Test: `cli/src/testing/processImages.spec.ts`

**Interfaces:**
- Consumes: `cli/native/darwin-dev-watch.c` (Task 1).
- Produces:
  - artifact JSON: today's fields unchanged, plus
    `devWatch: { sourceSha256: string, sha256: string, size: number, base64: string }`.
  - `export function readDevWatchBundle({ path, required = false, cliRoot = root } = {}): string | undefined` in
    `cli/scripts/lib/processImageBundle.mjs`: `undefined` with no path (throws `Release requires
    HARNESS_PROCESS_IMAGES_ARTIFACT` when `required`); otherwise the JSON string
    `{"schema":1,"sha256":…,"size":…,"base64":…}` in that key order. Throws `Native /dev watch build inputs do not
    match` when the top-level `schema`/`platform`/`architectures`/`builderSha256` checks (shared with
    `readProcessImageBundle`) fail, the entry is missing, its `sourceSha256` differs from `darwin-dev-watch.c`, or its
    size is outside 32 B..2 MiB; `Native /dev watch artifact checksum mismatch` on bytes that do not match.

- [ ] **Step 1: Write the failing tests**

`cli/scripts/test-process-image-bundle.mjs`: the fixture root also gets `native/darwin-dev-watch.c` (`'watch source'`);
the made-up `artifact` gains `devWatch` for `Buffer.alloc(64, 9)`. A `readWatch(value, required = true)` twin of
`read`. New tests:

```js
test('source-only builds omit the /dev watch helper; a release must supply it', () => {
  assert.equal(readDevWatchBundle(), undefined)
  assert.throws(() => readDevWatchBundle({ required: true }), /Release requires/)
})
test('embeds only the /dev watch helper\'s exact bytes and identity, in its own key order', () => {
  const text = readWatch(artifact)
  assert.ok(text.startsWith('{"schema":1,"sha256":'))
  assert.deepEqual(JSON.parse(text), { schema: 1, sha256: artifact.devWatch.sha256, size: 64, base64: artifact.devWatch.base64 })
})
test('rejects a missing, stale or corrupted /dev watch helper', () => {
  // each throws: { devWatch: undefined }, devWatch.sourceSha256 = hash('old'), builderSha256 = hash('old'),
  // devWatch.size = 63, devWatch.sha256 = hash('bad'), devWatch.base64 + '\n', devWatch.size = 3 MiB
})
```

The existing `readProcessImageBundle` tests stay as they are and still pass with the `devWatch` entry present.

`cli/src/testing/processImages.spec.ts`, in `describe('the helper a bundle carries')`:

```ts
it('is the process helper, not the /dev watch helper beside it', () => {
  // write an artifact() with a devWatch entry (sourceSha256 of native/darwin-dev-watch.c, bytes Buffer.alloc(64, 9))
  // to a temp file; watch = readDevWatchBundle({ path })
  // code = transformSync('export const watch = __DARWIN_DEV_WATCH__; export const images = __DARWIN_PROCESS_IMAGES__',
  //   { define: { __DARWIN_DEV_WATCH__: JSON.stringify(watch), __DARWIN_PROCESS_IMAGES__: JSON.stringify(embedded) }, format: 'esm', minify: true }).code
  expect(bundledProcessImages(code)).toBe(sha256(HELPER))
})
```

`cli/native/test_process_images.py`: a new case
`test_dev_watch_artifact_is_universal_signed_and_pinned_to_its_source`: decode `artifact['devWatch']['base64']`,
check its sha256 and size, `devWatch.sourceSha256 == sha256(native/darwin-dev-watch.c)`, `lipo -archs` gives
`arm64 x86_64`, `codesign --verify --strict --all-architectures` passes.

- [ ] **Step 2: Run them, expect FAIL**

Run: `node --test scripts/test-process-image-bundle.mjs` — Expected: the three new tests fail (`readDevWatchBundle` is not
exported).
Run: `npx vitest run src/testing/processImages.spec.ts` — Expected: the new case fails (`readDevWatchBundle is not a
function`).
Run (repo root, slot): `python3 cli/native/test_process_images.py -k dev_watch` — Expected: `KeyError: 'devWatch'`.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/scripts/test-process-image-bundle.mjs cli/src/testing/processImages.spec.ts cli/native/test_process_images.py
git commit -m "Dial: the /dev watch helper is built and pinned with the process helper (red tests)"
```

- [ ] **Step 4: Build both helpers in `build-process-images.py`**

Factor today's compile/`lipo`/`codesign`/arch check into one function taking (source, binary name, codesign identifier)
and call it for both helpers; keep today's process-helper smoke run and add one for the dev-watch helper: `Popen`
`--watch` with stdin and stdout pipes, the first line (5 s `select` deadline) must be `{"schema":1,"mode":"watch"}`,
then close stdin and `wait(timeout=5) == 0`, else `RuntimeError('The built /dev watch helper failed its
host-architecture smoke check')`. Write the `devWatch` entry beside today's fields. The docstring names both helpers.

- [ ] **Step 5: Add `readDevWatchBundle` to `processImageBundle.mjs`**

Share the top-level checks with `readProcessImageBundle` through one internal function (no second copy); its behavior
and output are unchanged.

- [ ] **Step 6: Run them, expect PASS**

Run: `node --test scripts/test-process-image-bundle.mjs` and `npx vitest run src/testing/processImages.spec.ts` — PASS.
Run (repo root, slot): `python3 cli/native/test_process_images.py -v` — all PASS (the builder now smoke-runs both).

- [ ] **Step 7: Commit**

```bash
git add cli/scripts/build-process-images.py cli/scripts/lib/processImageBundle.mjs
git commit -m "Dial: the /dev watch helper is built and pinned with the process helper"
```

---

### Task 3: Extraction into a named folder (`cli/src/lib/nativeProcessImages.ts`)

Effort: `high` (a core file, `architecture.coreFiles.txt:399`; Decision 5: `npm run test:core` runs once on the final
head, Verification check 8). Depends on: none.

**Files:**
- Modify: `cli/src/lib/nativeProcessImages.ts:89-98`
- Test: `cli/src/lib/nativeProcessImages.spec.ts`

**Interfaces:**
- Produces: `prepareProcessImageHelper(artifact: ProcessImageArtifact, runtimeDirectory: string, folder:
  'process-images' | 'dev-watch' = 'process-images'): Promise<string | null>`. Nothing else in the file changes;
  `bundledProcessImageHelper` keeps calling it with two arguments.

- [ ] **Step 1: Write the failing test** in `describe('bundled native helper preparation')`

```ts
it('extracts each helper into its own folder, and never hands one folder\'s file out for the other', async () => {
  const images = await prepareProcessImageHelper(artifact, root)
  const watch = await prepareProcessImageHelper(artifact, root, 'dev-watch')
  expect(images).toBe(join(root, 'process-images', artifact.sha256))
  expect(watch).toBe(join(root, 'dev-watch', artifact.sha256))
  expect((await lstat(join(root, 'dev-watch'))).mode & 0o777).toBe(0o700)
  expect(await readFile(watch!)).toEqual(bytes)
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/nativeProcessImages.spec.ts` — Expected: the new case fails (`watch` is the
`process-images` path).

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/lib/nativeProcessImages.spec.ts
git commit -m "Dial: a pinned helper can be extracted into a folder of its own (red test)"
```

- [ ] **Step 4: Add the `folder` parameter**; `join(runtimeDirectory, folder)` replaces the literal.

- [ ] **Step 5: Run, expect PASS**

Run: `npx vitest run src/lib/nativeProcessImages.spec.ts && npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/nativeProcessImages.ts
git commit -m "Dial: a pinned helper can be extracted into a folder of its own"
```

---

### Task 4: Starting the helper (`cli/src/cable/devWatch.ts`)

Effort: `high`. Depends on: Task 3 (the `folder` parameter).

**Files:**
- Create: `cli/src/cable/devWatch.ts`
- Create: `cli/src/cable/devWatch.spec.ts`

**Interfaces:**
- Consumes: `prepareProcessImageHelper(artifact, runtimeDirectory, 'dev-watch')` (Task 3); `env.ADAPTER_RUNTIME_DIR`.
- Produces: `export function startDevWatch(source: string): Promise<ChildProcess>` — parses `source` (the define's JSON),
  extracts, then `spawn(path, ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'], env: {} })` and resolves that child
  (spawn failures arrive as the child's `'error'` event). Rejects with an `Error` whose `code` is `'HELPER_UNAVAILABLE'`
  when `source` is not JSON or extraction returns `null`.

- [ ] **Step 1: Write the failing test `devWatch.spec.ts`**

`vi.mock('../lib/nativeProcessImages.js', () => ({ prepareProcessImageHelper: prepare }))`,
`vi.mock('node:child_process', () => ({ spawn }))`; set `env.ADAPTER_RUNTIME_DIR` to a fixed string.

```ts
it('starts the helper the build pins, watching, with no environment and no stderr', async () => {
  prepare.mockResolvedValue('/runtime/dev-watch/abc')
  const child = {}; spawn.mockReturnValue(child)
  await expect(startDevWatch(JSON.stringify(artifact))).resolves.toBe(child)
  expect(prepare).toHaveBeenCalledWith(artifact, env.ADAPTER_RUNTIME_DIR, 'dev-watch')
  expect(spawn).toHaveBeenCalledWith('/runtime/dev-watch/abc', ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'], env: {} })
})
it.each([['bytes it cannot write', 'valid', null], ['a define that is not JSON', 'not json', '/x']])(
  'says HELPER_UNAVAILABLE for %s, and starts nothing', async (_, kind, path) => {
    // source = kind === 'valid' ? JSON.stringify(artifact) : 'not json'; prepare resolves path
    await expect(startDevWatch(source)).rejects.toMatchObject({ code: 'HELPER_UNAVAILABLE' })
    expect(spawn).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run src/cable/devWatch.spec.ts`: cannot resolve `./devWatch.js`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/cable/devWatch.spec.ts
git commit -m "Dial: the devices process starts the pinned /dev watch helper (red test)"
```

- [ ] **Step 4: Write `devWatch.ts`** with `startDevWatch` as in Interfaces; a header comment says it is loaded only by
  `serial.ts`'s dynamic import, and why ("What this plan decides", 1).

- [ ] **Step 5: Run, expect PASS** — `npx vitest run src/cable/devWatch.spec.ts && npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/cable/devWatch.ts
git commit -m "Dial: the devices process starts the pinned /dev watch helper"
```

---

### Task 5: Arrivals on macOS (`watchDialArrivals`), the bundle define and the bundled check

Effort: `xhigh` (a child's lifecycle racing the unsubscribe; the release bundle's defines). Depends on: Task 2
(`readDevWatchBundle`), Task 4 (`startDevWatch`). Step 7 needs the PM's Mac slot.

**Files:**
- Modify: `cli/src/cable/serial.ts:99-134` (and its imports)
- Test: `cli/src/cable/serial.spec.ts:310-351`
- Modify: `cli/build-bundle.mjs:20,47-50,96`
- Modify: `cli/scripts/test-process-images-bundled.mjs`

**Interfaces:**
- Consumes: `startDevWatch(source)` (Task 4) by `import('./devWatch.js')`; `readDevWatchBundle` (Task 2).
- Produces, in `serial.ts`:
  - `declare const __DARWIN_DEV_WATCH__: string | undefined`
  - `export type SpawnDevWatch = () => Promise<ChildProcess> | null`
  - `export function spawnBundledDevWatch(): Promise<ChildProcess> | null` — `null` when the define is not a string, else
    `import('./devWatch.js').then(m => m.startDevWatch(source))`.
  - `watchDialArrivals(signal, log, deps: { platform: NodeJS.Platform; watch: WatchDir; spawnDevWatch: SpawnDevWatch } =
    { platform: process.platform, watch, spawnDevWatch: spawnBundledDevWatch })`.

- [ ] **Step 1: Write the failing tests** in `describe('a device arriving, as the OS says it')`

The four existing calls pass `spawnDevWatch: vi.fn()` beside `watch`. The case "on macOS is not watched: the scan timer
finds a new dial" is replaced. A fake: `helper()` returns
`Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }), stdin:
Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() })`, cast to `ChildProcess`. `const NEXT = ' — a new
dial is found by the next scan'`. Cases (await `tick()` after resolving):

```ts
// a
it('on macOS, each line from the /dev watch helper is an arrival', async () => {
  // spawnDevWatch resolves the fake; stdout emits '{"schema":1,"mode":"watch"}\n', 'dev\n', 'de', 'v\ndev\n', 'devx\n'
  expect(signal).toHaveBeenCalledTimes(3); expect(log).not.toHaveBeenCalled(); expect(dev.watch).not.toHaveBeenCalled()
})
// b
it('on macOS, a build with no /dev watch helper watches nothing and says nothing', () => {
  const spawnDevWatch = vi.fn(() => null)
  expect(watchDialArrivals(signal, log, { platform: 'darwin', watch: dev.watch, spawnDevWatch })).toBeUndefined()
  expect(spawnDevWatch).toHaveBeenCalledOnce(); expect(dev.watch).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
})
// c
it('on macOS, a helper that exits is said once, and nothing more signals', async () => {
  // child.emit('exit', 1, null); then stdout 'dev\n'; then child.emit('error', ENOENT error)
  expect(log).toHaveBeenCalledExactlyOnceWith('cable: /dev watch ended (exit 1)' + NEXT); expect(signal).not.toHaveBeenCalled()
})
// d
it.each([['its pinned bytes cannot be written', 'reject HELPER_UNAVAILABLE', '(HELPER_UNAVAILABLE)'],
         ['it cannot be spawned', "child 'error' ENOENT", '(ENOENT)']])('on macOS, a helper that cannot start because %s is said once', …)
// e
it('on macOS, the unsubscribe ends the helper\'s stdin and kills it, and its exit says nothing', async () => {
  // off(); child.stdin.end and child.kill called once each; child.emit('exit', null, 'SIGTERM'); stdout 'dev\n'
  expect(log).not.toHaveBeenCalled(); expect(signal).not.toHaveBeenCalled()
})
// f
it('on macOS, an unsubscribe before the helper started kills it when it comes, and nothing signals', async () => {
  // spawnDevWatch returns a deferred promise; off(); resolve(child); await tick()
  // child.stdin.end and child.kill called once; stdout 'dev\n' -> no signal; log not called
})
// g
it('on macOS, a line longer than 64 bytes is dropped and the next one still counts', async () => {
  // stdout 'x'.repeat(100), then 'dev\ndev\n'  (the first 'dev' ends the long line, so it is dropped)
  expect(signal).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run them, expect FAIL** — `npx vitest run src/cable/serial.spec.ts`: a, c-g fail (darwin returns
  `undefined`, nothing spawned); b fails (`spawnDevWatch` is never called).

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/cable/serial.spec.ts
git commit -m "Dial: a replugged dial is heard at once on macOS (red tests)"
```

- [ ] **Step 4: Write the darwin branch in `watchDialArrivals`**

`spawnDevWatch()` returns `null`: return `undefined`, logging nothing. Else keep `child`, `stopped` and `ended`
flags; on resolve: if `stopped`, end stdin and kill, return; else `stdout.setEncoding('utf8')`, parse lines (a `partial`
string; over 64 bytes it is cleared and the rest up to the next newline dropped; a complete line equal to `dev` calls
`signal()` unless `ended` or `stopped`), `stdin.on('error', () => {})`, `'error'` → `end(errorKind(error))`, `'exit'` →
`end(code !== null ? \`exit ${code}\` : String(killedBy))` (the exit's second argument is named `killedBy`: `signal` is
already the callback). On reject: `end(errorKind(error))`. `end(kind)` does nothing
once `ended` or `stopped`, else sets `ended` and logs the ended line. The unsubscribe sets `stopped`, ends stdin and
kills the child when there is one. The macOS comment at `serial.ts:131-132` is replaced by one saying why a helper
(`fs.watch` hears nothing on devfs) and that the fingerprint, not the helper, decides whether `ioreg` runs.

- [ ] **Step 5: Define `__DARWIN_DEV_WATCH__` in `build-bundle.mjs`**

`const devWatch = readDevWatchBundle({ path: process.env.HARNESS_PROCESS_IMAGES_ARTIFACT, required:
process.env.HARNESS_REQUIRE_PROCESS_IMAGES === '1' })` beside `processImages`; `__DARWIN_DEV_WATCH__: devWatch ?
JSON.stringify(devWatch) : 'undefined'` beside `__DARWIN_PROCESS_IMAGES__`; the file's header line says both helpers are
embedded.

- [ ] **Step 6: Extend `test-process-images-bundled.mjs`**

Its esbuild `define` gains `__DARWIN_DEV_WATCH__: JSON.stringify(readDevWatchBundle({ path:
process.env.HARNESS_PROCESS_IMAGES_ARTIFACT, required: true }))`. The entry imports `spawnBundledDevWatch` from
`src/cable/serial.ts`, awaits it, asserts `child.spawnfile === join(process.argv[2], 'dev-watch', <sha256 from the
define>)`, reads the first stdout line (3 s deadline) as `{"schema":1,"mode":"watch"}`, ends stdin and asserts exit
code 0 (3 s deadline, killed in `finally` if still running). The closing line names the /dev watch helper too.

- [ ] **Step 7: Run, expect PASS**

Run: `npx vitest run src/cable/serial.spec.ts src/architecture.failureLogs.spec.ts && npm run typecheck` — PASS.
Run (slot): build an artifact once, then the bundled check:
`python3 scripts/build-process-images.py --output "$TMPDIR/harness-dev-watch-artifact.json"` (a fresh path) and
`HARNESS_PROCESS_IMAGES_ARTIFACT="$TMPDIR/harness-dev-watch-artifact.json" node scripts/test-process-images-bundled.mjs`
— prints `Bundled native query, discovery, control and cache recovery passed on <arch>` and the /dev watch line. Remove
the artifact file after.

- [ ] **Step 8: Commit**

```bash
git add cli/src/cable/serial.ts cli/build-bundle.mjs cli/scripts/test-process-images-bundled.mjs
git commit -m "Dial: a replugged dial is heard at once on macOS"
```

---

## Verification

No end-to-end check: the e2e suite gives the fleet its own pseudo-terminal discovery, which arms no OS watch by design,
and the real dial replug was dropped by the PM (2026-11-25). The fleet's path from signal to scan is covered by #4588's
`cableFleet.spec.ts` cases. Nothing below opens a serial port, touches a dial, restarts the user's daemon or lists other
processes; the only devices made are pseudo-terminals the tests close. No test account, backend, port or state
directory is involved: every check writes only to its own temporary folder (the bundled check sets `ADAPTER_HOME`,
`ADAPTER_CONFIG_DIR`, `ADAPTER_DATA_DIR` and the runtime dir under it, as it does today).

**Any machine, any time (light, Linux or macOS):**
1. `cd cli && npx vitest run src/cable/serial.spec.ts src/cable/devWatch.spec.ts src/lib/nativeProcessImages.spec.ts
   src/testing/processImages.spec.ts src/architecture.failureLogs.spec.ts` — all pass.
2. `cd cli && node --test scripts/test-process-image-bundle.mjs` — all pass.
3. `cd cli && npm run typecheck` — clean.

**Only in a Mac slot the PM grants (this Mac, macOS 26 / Darwin 25.6; ask the PM first, never during a dial eval):**
4. `python3 cli/native/test_dev_watch.py -v` — 6 OK; the PR records the printed latency min/median/max (done-when:
   median under 5 ms).
5. `python3 cli/native/test_process_images.py -v` — all OK (the builder builds, signs and smoke-runs both helpers;
   about a minute).
6. The bundled check, Task 5 Step 7 — prints both lines; the extracted helper is at `<tmp>/runtime/dev-watch/<sha256>`.
7. `cd cli && npx vitest run src/cable src/architecture.spec.ts src/leanEntry.spec.ts` on macOS — the CLI serial specs
   on macOS (docs/validation-and-release.md, "What PR CI does not run"), the core's file list (it gains no line), and
   the lean build with the new define (`leanEntry.spec.ts` runs `build-bundle.mjs`).
8. `cd cli && npm run test:core` on the final head — passes (the local core gate PR CI does not run, for the one
   parameter Task 3 adds to the core file `lib/nativeProcessImages.ts`). Once, not per task; record it in the PR.

**On GitHub:** PR CI runs checks 1-3 on Linux. No workflow runs checks 4-6 on pull requests; the CLI release's
`process-images` job runs the builder (and so both smoke runs) on `macos-15` at each release, unchanged.
Proposal (not in this branch): a by-hand macOS workflow, or a PR CI job for changes under `cli/native/`,
`cli/scripts/build-process-images.py` and `cli/scripts/lib/processImageBundle.mjs`, running checks 4-6 on `macos-15`
and `macos-15-intel` (`scripts/record-ci-validation.py` still names a `process-images-native` job no workflow defines).

**Needs the user:** none.

## What the pull request says

Platforms: macOS (Linux and Windows unchanged). Evidence: the red-then-green commits of each task; check 4's latency
numbers; checks 4-8 run in the PM's slot, with the head SHA (check 8 is `npm run test:core`); no runtime measure
(Decision 8); no real dial replug (dropped by the PM).

## Open questions

None.
