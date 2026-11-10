# Agent Browser spike 2: the stream at 1920x1080 and the macOS bridge

A second throwaway spike for the [design](2026-11-10-agent-browser-design.md), after the
[first spike](2026-11-10-agent-browser-spike.md). It feeds the redesign of the stream (Phase 3). Run 2026-11-10 on one
Mac: macOS 26.6.2, Apple M2 Max (12 cores), 32 GB, Podman 5.8.1 (Homebrew), Flutter 3.47.5. The spike code is
throwaway and is not in the repository.

## Summary

- **Google Chrome runs on arm64 under the spec's flags.** The image built from the worktree's
  `cli/assets/browser/` (Google Chrome stable `157.0.8103.50`, aarch64) starts under `--read-only`, the four sized
  tmpfs mounts with `mode=1777` on HOME, `--cap-drop ALL`, `no-new-privileges` and the limits. No Chromium fallback was
  needed. `podman stop` now ends it in 0.47 s with exit code 0: the entrypoint's SIGTERM trap works.
- **At 1920x1080 a frame cap cuts bytes far less than at 1280x720.** Scrolling, q6/c2 goes from 2.56 MB/s uncapped to
  1.44 MB/s at 10 fps and 0.86 MB/s at 5 fps. q3/c6 gives 1.04 MB/s at 10 fps, 0.62 MB/s at 5 fps and 0.27 MB/s at
  2 fps. Each capped update carries 105-173 KB, against 47 KB uncapped, because almost the whole screen changes between
  two requests.
- **Nothing at 1920x1080 fits the relay's 139,810 B/s while scrolling.** The lowest, q3/c6 at 2 fps, averages 1.9x
  the budget (p95 3.1x). Rest fits at every setting (6-16 KB/s mean).
- **Text stays sharp at every setting.** Text goes as lossless palette rects; only photos go as JPEG.
- **The macOS bridge is not the limit.** WKWebView's JavaScript channel carries base64 JSON at 35-47 MB/s from Dart
  to the page and 30-58 MB/s from the page to Dart, with 8-64 KiB chunks. At 1-8 MB/s, paced, Flutter's frames stay
  under 3 ms at p95. That is more than 10x the stream's need.
- **The real `browser_viewer.html` keeps up with a recorded 1920x1080 q6/c2 scrolling stream** at real speed
  (2.6 MB/s) and at 2x. Its canvas matches an independent decode of the same bytes, and Flutter's UI thread barely
  notices (p95 frame span 0.89 ms). From 3x (7.8 MB/s) the page's own frames start to stall. At 4x (10.4 MB/s) it
  stalls up to 861 ms.
- **An unpaced flood breaks noVNC.** At 19 MB/s noVNC throws `Receive queue buffer exceeded 41943040 bytes` 12 s in
  and disconnects. The credit window has to bound what the page holds, not only what is on the wire.
- **Codex approval: not measured.** `codex login status` says "Not logged in".

Not in scope, still open: Linux and Windows, terminal echo against credit windows, TURN.

## How to read this

- **Measured** means a command was run here and its output is quoted or tabulated.
- **Read** means taken from source code and not exercised.
- **Inferred** means reasoning from measured or read facts. Each inference is marked.

## The image and the container

All measured, on a spike machine (`podman machine init harness-spike --cpus 4 --memory 6144 --disk-size 40`, used
through `--connection harness-spike`).

| Item | Result |
|---|---|
| Machine init, first start | 252 s (930 MB image download), then 12.5 s |
| Build context | A copy of `cli/assets/browser/` (Containerfile, entrypoint.sh, policy.json, browser-tools*.mjs/json, socks5*), built with `podman build -t harness-spike-browser:1 .` from the copy |
| Build | 429 s, cold. Image 1.67 GB. Base `debian:trixie@sha256:9c6e3814…` |
| Browser | `Google Chrome 157.0.8103.50`, `uname -m` `aarch64`. Runs as `browser` |
| Run flags | `--read-only --tmpfs /tmp:rw,size=256m --tmpfs /home/browser:rw,size=256m,mode=1777 --tmpfs /var/tmp:rw,size=16m --tmpfs /run:rw,size=16m --cap-drop ALL --security-opt no-new-privileges --memory 2g --cpus 2 --pids-limit 512 --shm-size 1g`, labels, its own bridge network, a named volume at `/var/lib/harness-browser-profile` |
| Inside | `memory.max 2147483648`, `cpu.max 200000 100000`, `pids.max 512`, `CapEff 0`, `NoNewPrivs 1`, `ReadonlyRootfs true`, `/home/browser` is `drwxrwxrwt`, `/dev/shm` 1 GB |
| Ready marker | Present by the first check, about 1 s after `podman run -d` |
| Processes | Xvnc with the spec's arguments, openbox, pulseaudio, Chrome (GPU, network, storage and renderer processes) |
| Page view | `connectOverCDP` 29 ms; `navigator.webdriver` false; WebGL `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) …))`; UA `… (X11; Linux x86_64) … Chrome/157.0.0.0` |
| `podman stop` | 0.47 s, exit code 0. The first spike's entrypoint took 10 s and exited 137 |

Chrome's log has only D-Bus connection errors (`Failed to connect to the bus`). They do not stop it.

## Step 1: the stream at 1920x1080

### Method

This step used the first spike's Node RFB client, unchanged except for an option that records the bytes it receives.

- It negotiates exactly what noVNC 1.5.0 does: the same pixel format, the same encodings in the same order, and fences
  and continuous updates answered the same way.
- **Frame cap:** continuous updates stay off, and each incremental FramebufferUpdateRequest goes out no sooner than
  1000/fps ms after the previous one. So at most one update arrives per interval.
- It runs over `podman exec -i harness-spike-b1 socat STDIO TCP:127.0.0.1:5900`.
- It counts server-to-client bytes in 1 s bins. Mean is total bytes over the phase; p95 and peak are taken over the
  1 s bins.
- The page is the same as the first spike's, Wikipedia's
  [List of national parks of the United States](https://en.wikipedia.org/wiki/List_of_national_parks_of_the_United_States):
  41,064 px tall and 201 images.
- Rest: 60 s still. Scroll: Playwright `mouse.wheel(0, 100)` every 100 ms for 60 s (51,100 px).
- Screen: the default, `1920x1080`.

```
node measure2.mjs harness-spike-b1 "$URL" <quality> <compression> <fps|0> <tag> <outdir>
node record.mjs   harness-spike-b1 "$URL" 6 2 0 q6c2-uncapped-scroll.rec
```

### Measured

| Setting (1920x1080) | Rest mean / p95 / peak (B/s) | Scroll mean / p95 / peak (B/s) | Updates/s | Bytes per update, scrolling | Text readable |
|---|---|---|---|---|---|
| q6 c2, uncapped | 6,211 / 17,017 / 17,293 | 2,563,214 / 4,364,355 / 4,741,651 | 54.5 | 47 KB | yes |
| q6 c2, 10 fps | 10,172 / 3,734 / 292,560 | 1,444,064 / 2,550,782 / 3,624,175 | 9.9 | 146 KB | yes; faint smudges in blank cells mid-scroll |
| q6 c2, 5 fps | 14,173 / 131,285 / 169,860 | 860,917 / 1,792,100 / 1,930,068 | 5.0 | 173 KB | yes; same smudges |
| q3 c6, 10 fps | 9,259 / 37,294 / 245,152 | 1,039,669 / 1,770,977 / 2,325,668 | 9.9 | 105 KB | yes; photos show JPEG blocking; same smudges |
| q3 c6, 5 fps | 14,507 / 138,375 / 202,936 | 617,413 / 1,062,079 / 1,248,094 | 5.0 | 124 KB | yes; same |
| q3 c6, 2 fps | 16,331 / 101,251 / 135,584 | 271,714 / 439,666 / 483,959 | 2.0 | 134 KB | yes; same |

Other measured points:

- **The recording run** (q6/c2 uncapped, the stream Step 2 replays) averaged 2,722,514 B/s while scrolling. That is
  166.55 MB in 7,787 reads from the exec's stdout (median 17,872 B, at most 65,536 B), over 63.7 s, including the
  1.4 MB first frame and 3 s of rest.
- **Against the first spike** (Chromium 156, same page and client): q6/c2 uncapped there averaged 2.56-2.73 MB/s.
  Chrome 157 gives the same.
- **Rest under a cap** is higher than uncapped (10-16 KB/s against 6 KB/s), with 1 s bursts up to 293 KB. The page
  redraws something every few seconds (the first spike saw a 3 s pattern). Under a cap each request collects
  everything changed since the last one, so the bursts come in bigger lumps. All rest rows stay far under the relay
  budget on average.
- **Rect mix.** Every run used Tight fill, palette and JPEG rects and the VMware cursor. No gradient, no CopyRect.

**How legibility was judged** (as in the first spike):

- For each setting, a fresh decoding connection wrote three PNGs at 100 % scale: a still page with a table of text
  and photos, the same 6 s later, and one mid-scroll.
- Tight fill and palette rects were decoded through noVNC's own `inflator.js`, and JPEG through `jpeg-js`.
- Crops were compared by eye with a CDP screenshot. Body text, links, numbers and superscripts were sharp in every
  setting, mid-scroll included.
- In the capped settings, blank table cells mid-scroll show faint dotted marks, while the text beside them stays sharp.
- Photos are clean at q6 and visibly blocky at q3.

### Against the relay

The relay's per-stream budget is 8 MiB a minute (139,810 B/s), as in the first spike.

| Setting (1920x1080), scrolling | Mean / budget | p95 / budget | MB per scrolling minute |
|---|---|---|---|
| q6 c2, uncapped | 18.3x | 31x | 154 |
| q6 c2, 10 fps | 10.3x | 18x | 87 |
| q6 c2, 5 fps | 6.2x | 12.8x | 52 |
| q3 c6, 10 fps | 7.4x | 12.7x | 62 |
| q3 c6, 5 fps | 4.4x | 7.6x | 37 |
| q3 c6, 2 fps | 1.9x | 3.1x | 16 |

*(Inferred)*

- At 1920x1080, capped, one scrolling update costs about 105-175 KB. So a stream paced to the current budget would
  show about one update a second at q3/c6 while scrolling.
- The first spike's 1280x720 q3/c6 at 5 fps (200 KB/s mean, 241 KB/s p95) is the lowest scrolling row measured on
  either run.
- Resolution matters more under a cap than the first spike's 1280x720 rows suggested. At 5 fps q3/c6, 1920x1080
  costs 3.1x what 1280x720 does, for 2.25x the pixels.

## Step 2: the webview bridge on macOS

### The throwaway app

- **App:** a Flutter macOS app, `flutter create --platforms=macos`, built with `flutter build macos --profile`.
  - Its webview packages match `desktop/pubspec.lock`: `webview_flutter 4.14.1`, `webview_flutter_wkwebview 3.26.1`
    and `webview_flutter_platform_interface 2.15.1`.
  - The controller is built as `store_demo_dialog.dart` builds it, through `WebKitWebViewControllerCreationParams`.
  - The page loads with `loadHtmlString`.
  - The App Sandbox entitlement is off, so the app could read the recording and write results.
- **Bytes:**
  - Page to Dart goes through `addJavaScriptChannel` / `postMessage(JSON.stringify({t:'data', b64}))`. Dart runs
    `jsonDecode` and `base64Decode` on each message.
  - Dart to page goes through `runJavaScript('harnessBrowserReceive({"t":"data","b64":"…"})')`. Dart runs
    `base64Encode` and `jsonEncode` on each chunk, and the page runs `atob` into a `Uint8Array`. This is what
    `viewer.js` does.
- **The UI thread's cost** was measured three ways:
  - `SchedulerBinding.addTimingsCallback`: build, raster, vsync overhead and total span per frame, with a spinner
    keeping frames coming;
  - an 8 ms Dart timer's lateness, for event-loop lag;
  - the CPU time of the app and its WebKit processes, sampled by `ps` once a second.
  - The page also measured its own `requestAnimationFrame` intervals and an 8 ms timer's lateness.
- **Display.** The display ran at 60 Hz, except in the real-speed replay, where the app's window drew at 120 Hz. Frame
  rates are therefore not compared across runs; frame times are.
- **The figures used** come from the quiet 15 s run, with nothing else on the machine. Two earlier runs, during the
  machine download and the image build, gave the same throughputs within 20 %.

### Synthetic chunks, both ways (measured)

| Direction, chunk | Flow control | Raw bytes/s | Flutter frame span p50 / p95 / max (ms) | Frames > 16.7 ms | Dart loop lag p95 / max (ms) | CPU, app / WebContent (% of a core) |
|---|---|---|---|---|---|---|
| idle (spinner only) | - | - | 0.82 / 2.27 / 20.0 | 1 | 1.2 / 13.8 | 19 / 5 |
| page → Dart, 8 KiB | credit window 512 KiB, Dart acks each half | 29,565,777 | 4.62 / 18.97 / 52.1 | 71 of 800 | 8.6 / 28.2 | 104 / 59 |
| page → Dart, 32 KiB | 512 KiB | 54,519,577 | 0.80 / 2.54 / 13.2 | 0 | 3.0 / 13.8 | 96 / 91 |
| page → Dart, 64 KiB | 512 KiB | 58,341,748 | 0.95 / 3.29 / 6.5 | 0 | 1.9 / 17.1 | 88 / 99 |
| Dart → page, 8 KiB | 4 `runJavaScript` in flight | 35,222,572 | 0.95 / 1.25 / 10.9 | 0 | 1.2 / 12.3 | 115 / 30 |
| Dart → page, 32 KiB | 4 in flight | 40,085,481 | 1.30 / 2.44 / 13.5 | 0 | 3.0 / 11.0 | 92 / 19 |
| Dart → page, 64 KiB | 4 in flight | 46,678,200 | 2.91 / 4.71 / 25.6 | 3 | 2.3 / 20.3 | 99 / 19 |
| Dart → page, 64 KiB, paced 1 MB/s | none needed | 987,099 | 0.89 / 1.79 / 11.9 | 0 | 1.7 / 8.8 | 22 / 5 |
| Dart → page, 64 KiB, paced 3 MB/s | none | 2,953,063 | 0.92 / 2.96 / 6.5 | 0 | 1.6 / 10.4 | 25 / 6 |
| Dart → page, 64 KiB, paced 8 MB/s | none | 7,998,241 | 0.85 / 2.27 / 18.4 | 1 | 1.1 / 8.6 | 36 / 8 |

- **Latency:** one `runJavaScript` call took 0.74 ms (p50) / 1.23 ms (p95) at 8 KiB, 2.4 / 5.5 ms at 32 KiB, and
  4.5 / 6.2 ms at 64 KiB, measured from the call to its future completing.
- **The page's frames** held 60 fps in every row. Its worst rAF gap was 48 ms, in page → Dart at 8 KiB, and its timer
  was at most 25 ms late.
- **Saturated rows** take about one core in the app process. That is the Dart side's base64 and JSON work plus the
  channel. *(Inferred.)*
- **Small chunks from the page hurt Flutter's frames.** At 8 KiB page → Dart, 71 frames went over 16.7 ms and vsync
  overhead reached 18 ms at p95. Each message is a separate main-thread delivery, so the queue of deliveries delays
  frames. *(Inferred.)*
- Page → Dart carries only keys and pointer events in the real stream, about 1 KB/s (first spike), so this row is
  headroom, not a need.

### The recorded stream into the real `browser_viewer.html` (measured)

- **The feed:** the Step 1 recording (q6/c2 uncapped, 1920x1080, scrolling), split to at most 64 KiB. It goes in
  through `harnessBrowserReceive({t:'data', b64})` with up to 8 calls in flight.
- **The page:** the committed `desktop/assets/browser/browser_viewer.html` (noVNC 1.7.0), loaded as is with
  `loadHtmlString`.
- **The protocol, as `viewer.js` defines it:**
  - the page posts `{t:'ready'}`;
  - the host sends `{t:'config', mac:true}`, then `{t:'open'}`, then the server bytes as `{t:'data'}`;
  - noVNC's replies come back as `{t:'data'}` and are counted;
  - `{t:'state', connected}` is recorded.
  - Replaying fixed server bytes works because the client's replies never change what Xvnc already sent.
- **Probes** were injected after `ready`: rAF and timer probes, a canvas hash, and the canvas as PNG.
- **Correctness:** at the end, the canvas was compared with the spike client's own decode of the same recording.
- **Drain** is how long the canvas took to stop changing after the last byte went in.

| Pace | Bytes/s in | Delivery lag p50 / p95 / max (ms) | Drain | noVNC | Page rAF fps, worst gap, gaps > 50 ms | Flutter frame span p95 / max (ms) | Dart loop lag max | CPU app / WebContent / WebKit GPU (% core) |
|---|---|---|---|---|---|---|---|---|
| idle, page loaded | - | - | - | - | - | - | - | 12 / 3 / 0 |
| real (1x) | 2,612,605 | 5.4 / 12.9 / 35.7 | 490 ms | connected, no error | 59.6, 75 ms, 1 | 0.89 / 41.4 | 15 ms | 20 / 28 / 14 |
| 2x | 5,224,642 | 9.2 / 161 / 396 | 490 ms | connected, no error | 57.9, 93 ms, 11 | 5.51 / 86.6 | 46 ms | 38 / 49 / 27 |
| 3x | 7,835,922 | 8.2 / 101 / 183 | 578 ms | connected, no error | 51.5, 271 ms, 29 | 3.64 / 20.5 | 16 ms | 41 / 71 / 38 |
| 4x | 10,444,240 | 11.7 / 331 / 475 | 1,288 ms | connected, no error | 35.2, 861 ms, 44 | 5.09 / 17.7 | 12 ms | 52 / 90 / 51 |
| as fast as possible | 19,289,578 | - | - | **1,614 errors, then disconnected** | - | 6.53 / 34.8 | 18 ms | 72 / 105 / 55 |

- **The final canvas matches** in every run that stayed connected. Only 0.069 % of pixels differ by more than 16 on
  any channel (at most 51), which is the gap between WebKit's JPEG decoder and `jpeg-js`. So the page decoded every
  byte.
- **The error, as fast as possible.** 12.4 s after the page loaded, every `harnessBrowserReceive` started to throw
  `Error: Receive queue buffer exceeded 41943040 bytes, and the new message could not fit`, and the page then
  reported `connected: false`.
- **Why** *(read, `@novnc/novnc` 1.7.0)*:
  - `core/websock.js:20` sets `MAX_RQ_GROW_SIZE = 40 MiB`.
  - `core/rfb.js:2625-2633` stops reading while the display still has drawing queued. JPEG rects decode
    asynchronously.
  - So bytes that arrive faster than the page draws pile up in noVNC's receive queue until it throws.
- **Without the error handler.** The first try had no try/catch around the call. The failing `runJavaScript` calls
  then raised `PlatformException(FWFEvaluateJavaScriptError, Failed evaluating JavaScript.)` in Dart, and the replay
  hung.
- **Where the page limits** *(inferred)*: noVNC draws this 1080p stream on this Mac at somewhere between 10 MB/s,
  where it kept up with stalls, and 19 MB/s, where it fell behind. Its own frames degrade from about 7.8 MB/s. The
  real stream's p95 is 4.4 MB/s and its 1 s peaks are 4.7-7.3 MB/s (both spikes), so this Mac has about 1.5-2x
  headroom at the peaks. A slower Mac has less. That was not measured.

## Step 3: Codex approval

Not measured. `codex login status` printed `Not logged in` (it does not prompt), and the spike may not log in.

## Remaining

| What | Why not here |
|---|---|
| Linux (WebKitGTK through `webview_all_linux`) and Windows (WebView2 through `webview_win_floating`) bridges and hosts | This is a Mac. |
| Terminal echo against credit windows, direct, TURN and relay | Not in this run's scope. |
| TURN cost per open minute | Not in this run's scope. |
| The stream over a link with real latency, with a client that draws while paced | The Step 1 client never draws and runs over loopback, so its byte counts are an upper bound for one viewer. The replay draws, but its bytes were recorded with a client that does not. |
| A frame cap inside the real viewer | Read: `viewer.js` uses noVNC's default flow, which turns continuous updates on. Nothing in it caps frames. Every capped row here came from the spike client. |
| A slower Mac's drawing headroom | Only an M2 Max was used. |
| Codex approval | Not logged in. |
| Real Gmail | Needs a logged-in account. |

## Cleanup

- **Podman:** removed the container `harness-spike-b1`, the volume `harness-spike-profile`, the network
  `harness-spike-net`, the image `harness-spike-browser:1` and the `debian:trixie` base it pulled. All listings were
  empty afterwards.
- **The machine:** `harness-spike` was stopped and removed with `podman machine rm -f`. It left eight files, each
  deleted by name:
  - `~/.local/share/containers/podman/machine/{machine, machine.pub, port-alloc.dat, port-alloc.lck}`;
  - `applehv/harness-spike-ignition.sock` and `applehv/efi-bl-harness-spike`;
  - the 930 MB `applehv/cache/c78f6d3b….raw.zst`;
  - `~/.config/containers/podman/machine/applehv/harness-spike.lock`.
- **Afterwards:** a listing of the Podman folders and `~/.ssh` is identical to the one taken before init.
  `podman-connections.json` and `known_hosts` are unchanged. `podman machine list` shows only `podman-machine-default`
  (never started, as before), and it is still the default connection.
- **The throwaway app** was closed, and the WebKit data and cache folders it created were deleted:
  `~/Library/WebKit/spike.harness.bridgeBench` and `~/Library/Caches/spike.harness.bridgeBench`.
- **A stray file.** A file listing was written by mistake to the main checkout's root as `after2.txt`. It was moved
  out to the scratch directory at once. No other repository file was touched.

## What this means for the stream design

All settings are at 1920x1080, scrolling (the worst case); rest is 6-16 KB/s at every setting.

- **Direct link (peer to peer).** The numbers support **q6/c2 uncapped**: 2.56-2.72 MB/s mean, 4.4 MB/s p95, 4.7-7.3
  MB/s 1 s peaks.
  - The macOS bridge carries 35-47 MB/s and the real page draws it with 1.5-2x headroom on this Mac.
  - What is not known is the link's own bandwidth and the echo cost (Step 4).
  - The credit window must keep bytes queued in the page well under noVNC's 40 MiB. Acknowledging bytes only after
    noVNC has consumed them, not when `runJavaScript` returns, is what bounds it *(inferred)*.
  - If headroom on slower machines matters more than motion, q6/c2 at 10 fps (1.44 MB/s, p95 2.55 MB/s) is the next
    step down.
- **TURN.** Not measured. Technically it carries what the direct link does.
  - The spec paces and counts it like the relay because it is billed per GB. The highest setting is a budget call.
  - q6/c2 at 5 fps (861 KB/s mean, 1.79 MB/s p95, 52 MB per scrolling minute) keeps photos clean.
  - q3/c6 at 5 fps (617 KB/s, p95 1.06 MB/s, 37 MB per minute) keeps text equally sharp at 70 % of the bytes.
- **Relay.** At the current 139,810 B/s per stream, **no 1920x1080 setting fits while scrolling**.
  - The lowest, q3/c6 at 2 fps, is 272 KB/s mean and 440 KB/s p95. Supporting it needs a budget of about 450 KB/s
    per scrolling viewer (16 MB per scrolling minute).
  - Under today's budget, a stream paced by credit would show about one update a second at q3/c6 *(inferred: about
    134 KB per update)*.
  - A smaller remote screen on the relay route is the other lever: 1280x720 q3/c6 at 5 fps was 200 KB/s mean and
    241 KB/s p95 in the first spike.
