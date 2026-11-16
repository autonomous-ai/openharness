# Agent Browser spike: macOS report

Task 0 of the [plan](../plans/2026-11-10-agent-browser.md), for the [design](2026-11-10-agent-browser-design.md).
Run 2026-11-10 on one Mac: macOS 26.6.2, arm64, 32 GB, Podman 5.8.1 (Homebrew), Claude Code 2.1.322, Codex 0.163.0.
The spike code is throwaway and is not in the repository.

## Summary

This covers the macOS parts of Steps 1, 2 and 5, plus the Unicode keys. Steps 3 and 4 did not run, so Step 7's
bridge and echo stop conditions are still open.

What holds:

- The container runs as the spec has it, with one fix: rootless Podman, `--read-only`, the four sized tmpfs mounts,
  `--cap-drop ALL`, `no-new-privileges`, and `--memory 2g --cpus 2 --pids-limit 512 --shm-size 1g`. Every limit was
  accepted and shows up in the container's cgroup. Chromium 156 starts and stays up. CDP readiness and port 5900 pass.
- The `Xvnc` command line is accepted. `podman exec -i … socat STDIO TCP:127.0.0.1:5900` returns the 12-byte banner
  unchanged and carried 165 MB in 60 s without breaking the stream.
- The proxy secret mounts as a readable file under `--read-only` with a tmpfs on `/run`. `secret create --replace`
  from stdin works.
- `playwright-core` 1.58.2 `connectOverCDP` (27 ms), `ariaSnapshot()` and `getByRole` all work.
  `navigator.webdriver` is false. WebGL runs on SwiftShader.
- Google publishes Chrome stable for Linux arm64 (`157.0.8103.50-1`).
- "chào", "ạ" and an emoji typed as RFB key events arrive exactly. So does a 200-character ASCII run.
- Codex waits 31 minutes with `tool_timeout_sec=1900`. Its default is 300 s.
- Claude Code waits 31 minutes with a per-server `"timeout": 1900000`. `--permission-mode auto` does not prompt for
  the MCP tool.

What does not hold (each is detailed under its step, with the spec line it contradicts):

1. **The stream is far above the relay's budget.** At the spec's setting (1920x1080, Tight q6/c2), scrolling averages
   2.6 MB/s, with 1 s peaks of 6.6-7.3 MB/s. The relay's current per-stream output budget is about 140 KB/s. Even
   1280x720, q3/c6, capped at 5 frames a second averages 200 KB/s while scrolling. Rest is 1-9 KB/s at every setting.
   Text stays readable at every setting tested.
2. **The HOME tmpfs as written crashes Chromium.** `--tmpfs /home/browser:rw,size=256m` mounts a mode-0700 directory
   owned by root. Chromium dies with SIGTRAP at start. `mode=1777` fixes it.
3. **`wait -n "$CHROME" "$XVNC"` misses a browser that has already exited.** The container stayed up with no
   browser. Plain `wait -n` works.
4. **`podman stop` takes 10 s, then SIGKILLs (exit 137).** Bash as PID 1 ignores SIGTERM. The next start shows
   Chromium's "Restore pages? Chromium didn't shut down correctly" bubble.
5. **The event stream carries an `exec` and an `exec_died` for every `podman exec`.** Both carry the container's
   labels. The exit event is `died` for a self exit and for `podman stop` alike. No `stop` event was seen.
6. **A replaced secret does not reach an existing container**, even after a restart. A new container gets it.
7. **Many distinct characters outside the keymap get garbled.** A 200-character run with 29 such characters arrived
   at full length, but with 2-85 characters replaced by others from the same run, even with 200 ms between keys.
   Xvnc assigns them to spare keycodes on the fly and reuses the keycodes.
8. **Keys reach nothing until the Chromium window gets X focus.** Focusing the field through CDP is not enough. One
   RFB click is.
9. **"About 256 networks" is wrong.** 300 were created without an error. The default pools hold at least 1,792.
10. **Setup takes longer and uses more disk than "About 5 minutes, 1.5 GB".** Machine init took 165 s and downloaded
    930 MB, first start took 13 s, and the image build took 498 s for a 1.61 GB image. That is about 11 minutes and
    2.5 GB before Podman itself is installed.
11. **Claude Code cuts a silent stdio call at 30 minutes, and backgrounds it after 120 s in an interactive session.**
12. **A listed Podman machine that cannot start** (found on this Mac's `podman-machine-default`) breaks the spec's
    `stopped` state.

What remains: Linux and Windows hosts; Step 3 (the webview bridge); Step 4 (echo against credit windows); TURN; real
Gmail; Codex approval through a model turn; the stream through a real noVNC that renders, over a link with real
latency.

## How to read this

- **Measured** means a command was run here and its output is quoted.
- **Read** means taken from a CLI's help, its generated schema, or strings in its binary, and not exercised.
- **Inferred** means reasoning from measured or read facts. Each inference is marked.

## Step 1: Podman facts

### The person's existing machine cannot start

Measured. `podman-machine-default` (applehv, 12 CPUs, 8 GiB, created 2025-07-22, never started) keeps its disk image
and SSH key under another application's folder, and that folder no longer exists.

```
$ podman machine start            # fails after 31.6 s
Error: unable to connect to "gvproxy" socket at "/var/folders/…/T/podman/podman-machine-default-gvproxy.sock"
$ podman info
Error: unable to connect to Podman socket: failed to read identity "…/podman/machine/machine": open …: no such file or directory
$ podman machine list
podman-machine-default*  applehv     15 months ago  Never       12          8GiB        100GiB
```

The rest of Step 1 ran on a machine made for the spike, with the person's approval:
`podman machine init harness-spike --cpus 4 --memory 6144 --disk-size 40`, used as `podman --connection harness-spike`.
The default machine and the default connection were not changed.

### Measured

| Item | Result |
|---|---|
| Machine init | 165 s. Downloaded `…raw.zst` of 930,035,066 bytes (Fedora CoreOS, kernel 7.2.7-200.fc44.aarch64). Created a 40 GiB sparse disk. |
| First machine start | 13 s. |
| Init with an existing machine present | The new machine was not made default. The default connection stayed `podman-machine-default`. |
| Server | Podman 5.8.9 in the machine, rootless, cgroup v2 (`cpu io memory pids`), systemd cgroup manager, netavark. |
| `podman info` memory | `memTotal: 6179262464` (5.75 GiB) for `--memory 6144` (MiB). That is 93.8 % of the requested size. |
| Image build | 498 s, cold, mostly downloads. Image 1.61 GB. Base `debian:trixie` (146 MB). Chromium `156.0.8078.79` from Debian. A rebuild after changing only the entrypoint took under 1 s. |
| `--memory 2g --cpus 2 --pids-limit 512 --shm-size 1g` | All accepted, no warning. Inside: `memory.max 2147483648`, `cpu.max 200000 100000`, `pids.max 512`, `/dev/shm` 1.0G. |
| `--cap-drop ALL --security-opt no-new-privileges --read-only` | Accepted. `CapEff 0`, `CapBnd 0`, `NoNewPrivs 1`, `ReadonlyRootfs true`. No published ports. |
| tmpfs `/tmp`, `/var/tmp`, `/run` as `rw,size=…` | Mounted with the sizes, owned by container root, mode 1777 for `/tmp`. |
| tmpfs `HOME` as `/home/browser:rw,size=256m` | Mounted `drwx------ root root`. The browser user cannot write it. Chromium crashes at start: `Trace/breakpoint trap (core dumped)` after `chrome_crashpad_handler: --database is required`. With `HOME` on a writable dir it starts. With `/home/browser:rw,size=256m,mode=1777` it starts. |
| Chromium under the spec's flags | Starts and stays up, for the 40 and 20 minutes the two measuring containers ran (9 measurement runs). CDP `/json/version` and port 5900 both answer. |
| Debian's `chromium` wrapper | Adds `--show-component-extension-options --enable-gpu-rasterization --disable-pings --media-router=0 --disable-dev-shm-usage --enable-remote-extensions --load-extension=` before the spec's flags (read from `/proc/<pid>/cmdline`). |
| `Xvnc :1 -geometry 1920x1080 -depth 24 -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared` | Accepted. It offers only security type 1 (None). `-geometry 1280x720` works the same. |
| Idle container, about:blank, after one page visit | 541 MiB `memory.current` (anon 416 MiB), 124 pids. CPU 0-1 ms per second over two 30 s windows. The window right after the page visit used 0.68 core, all in the GPU process. |
| `podman exec -i <c> socat STDIO TCP:127.0.0.1:5900` | First 12 bytes `52 46 42 20 30 30 33 2e 30 30 38 0a` (`RFB 003.008\n`), unchanged. The RFB parser never lost sync over about 1 GB across all runs, so the stream is binary-clean. |
| Entrypoint `wait -n "$CHROME" "$XVNC"` | When Chromium died during the ready loop, bash printed `wait: 15: no such job` and kept waiting on Xvnc. The container stayed `Up` with no browser. Plain `wait -n`: killing Chromium (SIGTERM) ended the container with exit code 0. |
| Profile on the named volume | Survives a new container. The second container on the same volume showed "Restore pages? Chromium didn't shut down correctly" after the first was stopped by `podman stop`. |
| `--secret harness-spike-proxy,target=harness-proxy` with `--read-only` and a tmpfs on `/run` | Mounted at `/run/secrets/harness-proxy`, `-r--r--r-- root root`, readable by the non-root user, UTF-8 content intact. |
| `printf … \| podman secret create --replace <name> -` | Exit 0; `UpdatedAt` changes. Without `--replace`: `Error: harness-spike-proxy: secret name in use`. |
| Replaced secret, existing container | After `podman start` of a container created before the replace, the file still holds the old value. A new container reads the new value. |
| Bridge networks | 300 `podman network create` succeeded in 21 s with no error (subnets `10.89.1.0/24` to `10.90.44.0/24`). Removing all 300 took 1 s. The machine's commented defaults list pools `10.89.0.0/16`, `10.90.0.0/15`, `10.92.0.0/14` and more, all in /24s, which is at least 1,792 networks (that count is read, not measured). |
| `playwright-core` 1.58.2, inside the container | `connectOverCDP('http://127.0.0.1:9222')` in 27 ms. `page.locator('body').ariaSnapshot()` on Wikipedia's main page returned 35,711 characters. `getByRole('searchbox', {name: 'Search Wikipedia'})` found 1 and `fill('Hanoi')` read back `Hanoi`. `getByRole('link', {name: 'Main page'})` found 1. |
| Fingerprint seen by a page | `navigator.webdriver` false. WebGL renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 16.0.0) (0x0000C0DE)), SwiftShader driver)`. UA `Mozilla/5.0 (X11; Linux x86_64) … Chrome/156.0.0.0`; it says x86_64 on arm64, as Chrome's reduced UA does. |
| Google Chrome for Linux arm64 | Published. `dists/stable/Release` lists `Architectures: amd64 arm64`; `binary-arm64/Packages` has `google-chrome-stable 157.0.8103.50-1` (139,413,792 bytes); a HEAD on the `.deb` returns 200. Not installed or run. |

### Events

`podman events --format json --filter label=harness.daemon=spike`, one JSON object per line. The shape is the same
for every event:

```
{"ContainerExitCode":0,"ID":"5cce…","Image":"localhost/harness-spike-browser:1","Name":"harness-spike-b1",
 "Status":"died","time":1794294142,"timeNano":1794294142868485378,"Type":"container",
 "Attributes":{"harness.agent":"b1","harness.daemon":"spike","io.buildah.version":"1.43.5"}}
```

| Case | Event `Status` sequence (with `ContainerExitCode`) |
|---|---|
| `podman run -d` | `create`, `init`, `start` |
| every `podman exec` (the readiness check, the tool relay, each VNC stream) | `exec`, then `exec_died` (exit code of the exec'd command) |
| self exit (Chromium got SIGTERM) | `died` (0), `cleanup` |
| `podman stop` | `sync`, `died` (137) 10 s later, `cleanup`. No `stop` event. |
| `podman rm` | `remove` (137, the last exit code) |

The labels the spec puts on the container are in `Attributes`, so the agent id comes with the event.

### What the spec should change

1. **"The container", Hardening: "tmpfs mounts, each with a size, … the user's `HOME` 256 MB".** As written, HOME is
   not writable and Chromium crashes at start. The spec should say `--tmpfs <HOME>:rw,size=256m,mode=1777` (measured
   to work). An owner option would also do, but it was not tested.
2. **Entrypoint: "The entrypoint ends with `wait -n` on the browser and Xvnc."** Passing PIDs misses a child that
   exited during the ready loop. The spec should say plain `wait -n` (measured). The ready loop should also stop and
   exit when the browser PID is gone, so a browser that dies at start never sits as "Starting" for 60 s (inferred).
3. **Entrypoint, a new line.** PID 1 must trap SIGTERM, pass it to the browser and Xvnc, and wait for them. Without
   that, `podman stop` waits its 10 s and SIGKILLs. Chromium then marks the profile as crashed and shows "Restore
   pages?" on the next start, which the person sees in the panel. The 10 s and 137 are measured; that a trap removes
   the bubble is inferred.
4. **Lifecycle, Health: "filtered by `label=harness.daemon=<id>` and the container-exit event".** The spec should name
   the event: `--filter event=died`. Without it every `podman exec` (each tool call and each viewer) adds two events.
   A requested stop also produces `died` (137), so the service must recognise its own stops by its own record, as the
   spec already says. The filter flag itself was not run.
5. **Proxy: "A changed password replaces the secret (`podman secret create --replace`)."** The spec should add that the
   container is then created again, as a settings change already is. A restarted container keeps the old secret
   (measured).
6. **"The container", Network: "Podman's default pool holds about 256 networks, and stopped browsers must not use them
   up."** 300 were created without error. The sentence should say the default pools hold well over 256 (at least
   1,792 by the listed defaults). Creating the network only while the browser runs is still right, for tidiness rather
   than for a limit.
7. **"The container", Browser: "On arm64, Google Chrome if a Linux arm64 build exists … otherwise Debian's
   `chromium`."** A build exists. If Chromium stays for any reason, the entrypoint should run `/usr/lib/chromium/chromium`
   directly: Debian's wrapper adds `--disable-dev-shm-usage` (and `--enable-remote-extensions --load-extension=`). That
   moves shared memory to `/tmp` (256 MB) instead of the 1 GB `/dev/shm`. This risk is inferred; the extra flags are
   measured.
8. **Podman: "Memory: read from `podman info` on every OS. Less than 3 GB gives the state `podman_memory`."**
   `podman info` reports 93.8 % of the machine's configured memory. A 4 GiB machine passes; Podman's default 2048 MiB
   reports about 1.9 GB and fails (inferred from the ratio). With the machine stopped, `podman info` fails and the
   configured memory is only in `podman machine inspect` (`Resources.Memory`, MiB).
9. **Podman: availability reply `{state: 'stopped'}`: "Podman is installed and its machine is stopped. The form treats
   it as ready."** A machine can be listed as stopped and never start (measured above). The spec should give that case
   its own failure, telling the person to fix or remove the machine in Podman, the way `podman_memory` does. Today it
   ends as `podman_down` ("Podman is not running") with a Retry that fails the same way each time.
10. **Setup dialog: "About 5 minutes, 1.5 GB." and the pill line "Needs setup · about 5 min".** Measured here: 165 s
    init, 13 s first start, 498 s image build, 930 MB download plus a 1.61 GB image. Without the Podman installer that
    is about 11 minutes and 2.5 GB. The copy should say about 15 minutes and 3 GB, or the build should start the
    moment setup starts (inferred).

## Step 2: The stream

### Client and negotiation

The client is a minimal RFB 3.8 client written for the spike in Node, connected over
`podman --connection harness-spike exec -i <c> socat STDIO TCP:127.0.0.1:5900`. It does exactly what noVNC 1.5.0 does
on the wire:

- the same pixel format (32 bpp, depth 24, little endian, true colour, shifts 0/8/16);
- the same SetEncodings list in noVNC's order: CopyRect, Tight, TightPNG, ZRLE, JPEG, Hextile, RRE, Raw, quality
  `-32+q`, compression `-256+c`, DesktopSize, LastRect, QEMUExtendedKeyEvent, QEMULedEvent, ExtendedDesktopSize, Xvp,
  Fence, ContinuousUpdates, DesktopName, ExtendedClipboard, VMwareCursor, Cursor;
- it answers fences the way noVNC does (flags masked to BlockBefore and BlockAfter);
- it turns continuous updates on when TigerVNC sends EndOfContinuousUpdates, as noVNC does.

The constants and the key mapping come from noVNC's own `lib/encodings.js` and `lib/input/keysymdef.js`. It parses
every message so it knows where each update ends, and counts the server-to-client bytes per second. TigerVNC chose
Tight for every pixel rect (fill, palette and JPEG; no gradient), CopyRect never, and VMware cursor for the pointer.

In the frame-capped rows the client does not turn continuous updates on. It sends each incremental
FramebufferUpdateRequest no sooner than 100 ms (10 fps) or 200 ms (5 fps) after the previous one.

Bias, inferred: this client never draws, and it answers fences at once over loopback. TigerVNC's congestion control
therefore never holds it back. A real noVNC drawing in a webview, over a link with real latency, gets the same or
fewer bytes. These numbers are an upper bound for one viewer.

### The page and the motion

The page is
[List of national parks of the United States](https://en.wikipedia.org/wiki/List_of_national_parks_of_the_United_States):
201 images, 41,000 px tall at 1920x1080. It stands in for Gmail because the spike was not allowed to log in. Real
Gmail remains to be measured.

- Rest: the page sits loaded, with the pointer still, for 60 s.
- Scrolling: Playwright inside the container sends `mouse.wheel(0, 100)` every 100 ms for 60 s (about 1,000 px/s,
  51,000 px in all), jumping back to the top at the bottom.
- Typing: RFB key events at 6 characters a second into a focused textarea on a plain page, for 60 s.
- Bytes per second are counted in 1 s bins. Mean is total bytes over the phase. p95 and peak are over the 1 s bins.

### Measured, the spec's setting (1920x1080, Tight q6, c2)

| Run | Rest mean / p95 / peak (B/s) | Scroll mean / p95 / peak (B/s) | Scroll updates/s |
|---|---|---|---|
| 1 | 7,109 / 19,239 / 19,432 | 2,731,435 / 5,824,204 / 6,681,388 | 57.7 |
| 2 | 7,260 / 20,036 / 20,175 | 2,560,374 / 4,500,468 / 7,331,614 | 53.9 |
| 3 | 7,187 / 19,851 / 20,025 | 2,685,031 / 5,480,699 / 6,620,928 | 58.2 |

| Other measure (run 2) | Value |
|---|---|
| Typing, 6 chars/s, plain textarea page | mean 2,151, p95 4,208, peak 4,547 B/s; 359 of 359 characters arrived |
| Rest on the textarea page after typing | mean 104 B/s |
| Rest on the Wikipedia page | a repeating 3 s pattern of 0, about 2.4 KB and about 19 KB; something on the page redraws |
| Opening the viewer | first full frame in 142-174 ms; 1.40-1.44 MB before the stream settles |
| Client to server | about 430 B/s at rest (fence answers), about 1.1 KB/s while scrolling |

Typing run 1 is discarded: its keys reached no window (see Unicode keys). Its scroll and rest numbers are kept as
run 1 above, because they do not depend on focus.

### Measured, other settings (same page, same motion)

| Setting | Rest mean / p95 / peak (B/s) | Scroll mean / p95 / peak (B/s) | Scroll updates/s | Text readable |
|---|---|---|---|---|
| 1920x1080, q6 c2 (run 3 above) | 7,187 / 19,851 / 20,025 | 2,685,031 / 5,480,699 / 6,620,928 | 58.2 | yes |
| 1920x1080, q3 c6 | 6,498 / 18,033 / 18,274 | 2,132,135 / 3,761,707 / 4,650,966 | 53.5 | yes; photos show JPEG blocking |
| 1280x720, q6 c2 | 8,650 / 22,907 / 23,238 | 1,145,097 / 1,385,087 / 4,432,442 | 40.2 | yes |
| 1280x720, q3 c6 | 8,226 / 15,076 / 15,365 | 985,251 / 1,295,195 / 3,861,591 | 39.1 | yes; photos blocky |
| 1280x720, q3 c6, at most 10 fps | 1,032 / 2,513 / 2,809 | 347,617 / 426,620 / 784,461 | 9.9 | yes; faint smudges in blank areas mid-scroll |
| 1280x720, q3 c6, at most 5 fps | 6,417 / 24,834 / 176,340 | 200,165 / 241,261 / 328,896 | 5.0 | yes; same smudges |

- 1280x720 means `SCREEN=1280x720`: Xvnc `-geometry 1280x720` and `--window-size=1280,720`.
- A first 1280x720 q6/c2 run is discarded. Wikipedia's stylesheet did not load (the page was 19,620 px of unstyled
  links). It gave 0 B/s at rest and 4.4 MB/s scrolling. The row above is its repeat, with the page styled.
- Rest varies with what the page redraws. The 5 fps rest peak of 176 KB is one burst.
- Scrolling bytes per update: about 46 KB at 1920x1080 q6, 40 KB at q3, 28 KB at 1280x720 q6, 25 KB at q3, 35 KB at
  10 fps, and 40 KB at 5 fps (more of the screen changes between two requests).

**How readability was judged.** The client decoded the stream into a framebuffer, exactly as received: Tight fill,
palette and basic rects through noVNC's own `lib/inflator.js`, JPEG rects through `jpeg-js`, and CopyRect and Raw. For
each setting it wrote three PNGs, all at 100 % scale:

- a fresh viewer's frame on a still page with a table of text and photos;
- the same 6 s later;
- one mid-scroll.

Each was compared with a CDP screenshot. In every setting TigerVNC sent text areas as palette rects, which are
lossless. Body text, links, numbers and superscripts were sharp in all three frames. Only photos went as JPEG: at q3
they show visible blocking, and at q6 they look clean. At 5 and 10 fps, the mid-scroll frame had faint marks in blank
table cells, but the text stayed sharp. 1280x720 shows fewer lines (the page is at 100 % zoom), not smaller text.

### Against the relay

The relay's current output budget is 8 MiB per busy stream per minute (`backend/src/lib/terminalRelay.ts:63-68`),
which is 139,810 B/s.

- Every rest row fits under it.
- No scrolling row does. The lowest, 1280x720 q3/c6 at 5 fps, averages 200,165 B/s, 1.43 times the budget.
- 10 fps is 2.5 times the budget, uncapped 1280x720 q3/c6 is 7 times, and the spec's setting is 19 times.
- One viewer scrolling for a minute costs about 12 MB at the 5 fps setting and about 160 MB at the spec's setting. At
  rest it costs 0.06-0.5 MB per minute.

The relay budget, the pacing rate, the credit window and the bridge chunk size (Step 6) are not chosen here. They
need Step 3 and Step 4.

### What the spec should change

1. **"How a person sees it", the stream: "The page asks for Tight encoding at quality 6 and compression 2."** At
   1920x1080 that is 2.6 MB/s scrolling. The spec should not fix q6/c2 at full size for the relay route.
   - Reading the table *(inferred)*: a frame cap is the lever that matters. Resolution and quality move bytes per
     frame by about 2x; the cap moves the frame rate by 5-12x. Text stays lossless at every setting, so legibility
     does not limit any of these choices.
   - A route-aware setting is consistent with these numbers: uncapped on a direct link, and on the relay and TURN a
     cap with a lower quality.
   - Even 5 fps at 1280x720 needs a relay budget of about 250 KB/s (the p95) per scrolling viewer, not 140 KB/s. That
     budget is a product call, because it sets the relay's cost per viewer.
2. **The spike section: "How many bytes per second noVNC needs at Tight, quality 6, while Gmail scrolls at
   1920x1080."** Answered for a long public page, not Gmail.

## Unicode keys

Keys were sent as noVNC sends a typed character: `keysymdef.lookup(codepoint)` from noVNC 1.5.0, as a plain
KeyEvent, down then up. "à" is `0xe0`, "ạ" is `0x1001ea1` and "😀" is `0x101f600`. The textarea was focused through
CDP and read back through CDP.

| Sent | Arrived |
|---|---|
| "chào" | "chào", exact |
| "ạ" | "ạ", exact |
| "😀" | "😀", exact |
| 200 ASCII characters, 0, 5, 20 and 50 ms between keys | exact each time |
| 200 characters with 29 distinct characters outside the US keymap (Vietnamese, CJK, Hangul, emoji with a skin-tone modifier), 0 / 5 / 20 / 50 ms between keys | 200 characters each time, but 85 / 14 / 31 / 7 positions wrong |
| 200 characters cycling 2, 4, 8, 16 or 29 such characters, 50 ms between keys | 0, 0, 1, 0 and 2 positions wrong |
| the 29-character run with 200 ms between keys | 4 positions wrong |

- The wrong characters are other characters from the same run, such as "Tiếng" arriving as "TiẺng".
- Xvnc's log has 660 lines like `Input: Added keysym XK_uhorn (0x10001b0) to keycode 248`, each character again and
  again on different keycodes. Xvnc maps a keysym its keymap lacks to a spare keycode and reuses those keycodes.
  Chromium sometimes reads a keycode after it has been reassigned *(the mechanism is inferred; the log lines and the
  errors are measured)*.
- **Focus.** In the first run every key reached no window: the textarea had DOM focus through CDP, but the Chromium
  window did not have X keyboard focus. After one RFB pointer click in the page, keys arrived.

### What the spec should change

1. **Spike section: "`Xvnc` types characters its keyboard map lacks into Chrome."** True for single characters and
   short runs. False for a long run with many distinct such characters: about 1-40 % of them come out as other
   characters, at any speed tested, even 200 ms apart.
   - Vietnamese typed by a person uses that many. So the spec should say: text with characters outside the keymap is
     sent through the clipboard (the existing Paste path: UTF-8 extended clipboard, then Ctrl+V), not as key events.
   - The agent's `browser_type` goes through Playwright and CDP, not VNC, so it is not affected (inferred).
   - Whether the extended clipboard carries such text correctly was not measured.
2. **A new line under the entrypoint or the page.** The browser window must hold X keyboard focus before the first key.
   One click gives it; a viewer's keys before any click go nowhere. Making openbox focus the window when it maps, or
   activating it once when ready, is the obvious fix (not tested).

## Step 5: The engines

A stdio MCP server with one tool, `wait {seconds}`, replies after N seconds and sends no progress notifications. It
declares no tool annotations. It was given to each engine as a server named `browser`, from scratch files only.

### Claude Code 2.1.322

| Question | Result | Kind |
|---|---|---|
| Prompt in `--permission-mode auto`, print mode | No prompt. `permission_denials: []`, the 5 s call returned `done after 5 seconds`. | Measured |
| Prompt in `--permission-mode auto`, interactive session | No prompt. The call started 7 s after launch. | Measured |
| Prompt in the default permission mode, print mode | Denied: "Claude requested permissions to use mcp__browser__wait, but you haven't granted it yet". | Measured |
| Hard limit on one tool call | `MCP_TOOL_TIMEOUT` (ms), or per-server `"timeout"` (ms). Default 100,000,000 ms (about 27.8 h). | Read (binary) |
| Idle limit on one stdio tool call | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms, `0` disables). Default 1,800,000 ms for stdio and 300,000 ms for remote servers, checked every 30 s. A progress notification resets it. The limit used is the larger of this and the per-server `"timeout"`, capped by the hard limit. | Read (binary); the 1800 s default is confirmed by the run below |
| 1860 s call, print mode, default settings | **Aborted at 1800 s.** Called 06:32:44Z, run ended 07:02:51Z. The tool result was the idle-timeout text quoted below. The server got no cancel and replied into a closed pipe. | Measured |
| 1860 s call, print mode, per-server `"timeout": 1900000` | **Waited.** The server replied at 1860 s (07:03:43Z) and the agent reported `done after 1860 seconds`; 31 min 10 s in all. | Measured |
| 240 s call, interactive session, default settings | Moved to the background at 120 s. The turn ended, with "1 MCP task still running". At 240 s the server replied, the session printed "MCP task … (browser/wait) completed", and the agent took a new turn and reported `done after 240 seconds`. | Measured |
| 200 s call, interactive session, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` | Stayed in the foreground for 200 s and returned in the same turn. | Measured |
| Auto-background in print mode | Off unless `CLAUDE_AUTO_BACKGROUND_TASKS` is set. When on, the default delay is 120,000 ms, behind a feature flag that defaults on. | Read (binary); consistent with the print-mode runs |

Commands:

```
# print mode
claude -p '<call mcp__browser__wait with seconds=N>' --mcp-config mcp.json --strict-mcp-config \
  --permission-mode auto --output-format json --model haiku < /dev/null

# mcp.json, with the per-server limit
{"mcpServers":{"browser":{"command":"node","args":["wait-mcp.mjs"],"timeout":1900000}}}

# interactive, in a detached tmux session (no window)
tmux new-session -d "claude '<prompt>' --mcp-config mcp.json --strict-mcp-config --permission-mode auto --model haiku"
```

The idle abort, as the 1860 s run returned it:

```
MCP server "browser" tool "wait" sent no response or progress for 1800s; aborting. If this server is configured in
your MCP settings, set a per-server "timeout" (ms) to allow longer silent runs for just this server; otherwise set
CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables).
```

### Codex 0.163.0

Codex is not logged in on this Mac (`codex login status`: "Not logged in"), and the spike was not allowed to log in.
`codex exec` started the MCP server and then failed every model request with 401. So nothing that needs a model turn
was measured.

The tool timeout was measured without a model: `codex app-server` over stdio, with `CODEX_HOME` in the scratch
directory, then `initialize`, `thread/start`, and `mcpServer/tool/call {threadId, server: "browser", tool: "wait",
arguments: {seconds: N}}`.

| Question | Result | Kind |
|---|---|---|
| Default tool timeout | 300 s. A 600 s call failed at 300.0 s: `tool call failed for \`browser/wait\`: timed out awaiting tools/call after 300s`. | Measured (direct call) |
| 1860 s call with `-c mcp_servers.browser.tool_timeout_sec=1900` | **Waited.** Returned `done after 1860 seconds` after 1860.1 s. | Measured (direct call) |
| The timeout key | `mcp_servers.<name>.tool_timeout_sec`; `codex mcp get browser` echoes `tool_timeout_sec: 1900`. | Measured |
| The per-server approval key | `mcp_servers.<name>.default_tools_approval_mode`, one of `auto`, `prompt`, `writes`, `approve`. `codex mcp get` echoes it, and an unknown value is refused with that list. What each value does was not exercised. | Measured that it parses; meaning not measured |
| Prompt for an MCP tool with `--approve-for-me` | Not measured: needs a model turn. | |
| Prompt for an MCP tool in `codex exec`'s default mode | Not measured: needs a model turn. The binary holds the text "MCP tool call requires approval, but approval policy is never", so a refusal without a prompt is possible. | Read (binary) |

Both the direct call and a model turn go through the same MCP client (`codex-mcp-client` in the server's log both
times), so the timeout is taken to apply to a model turn too. That is inferred, not measured.

```
CODEX_HOME=<scratch> codex app-server \
  -c 'mcp_servers.browser.command="node"' -c 'mcp_servers.browser.args=["wait-mcp.mjs"]' \
  -c 'mcp_servers.browser.tool_timeout_sec=1900'
# then, as JSON lines on stdin: initialize, initialized, thread/start, mcpServer/tool/call
```

### What the spec and plan should change

1. **Spec, "How the agent drives it", "Tool timeouts": "the launch sets what each needs, as an argument or as an
   environment variable." Plan, Task 9: "`env` carries any variable Task 0 found an engine needs to wait 30 minutes;
   it is empty …".** It is not empty for Claude Code.
   - The `browser` entry in `--mcp-config` needs `"timeout": 1900000`. Without it a silent stdio call is cut at
     exactly 30 minutes, inside the plan's 31-minute ask (measured).
   - The 120 s auto-background needs a decision. Either the launch sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, which
     applies to every MCP server of that agent and not only `browser`, or the design accepts that the agent's turn
     ends two minutes into an ask and a new turn starts when the person is done. The second changes what "the agent
     is waiting" looks like (an idle agent with a running MCP task), so it is a product call.
   - *(Inferred, not measured:)* the relay could send MCP progress notifications during an ask. That would reset the
     idle limit without the `"timeout"` key. It would not stop the auto-background.
2. **Spec, same place: "Codex gets `-c mcp_servers.browser.tool_timeout_sec=1900`; its default is far shorter."** The
   setting stays. The sentence should give the number: 300 s.
3. **Spec, "Approval": "If a mode would prompt, the launch adds an allow rule … Claude `--allowedTools=mcp__browser`
   as one token."** In `auto` mode Claude Code did not prompt for the test tool. That is weaker than it looks: `auto`
   judges each call, and a tool that only waits is the most harmless call there is. A `browser_type` into a sign-in
   form may be judged differently. Adding `--allowedTools=mcp__browser` regardless removes the doubt. Whether it is
   needed for real browser tools is still to be measured. *(The no-prompt result is measured; the doubt is
   inferred.)*
4. **Plan, Task 0 Step 5: "Codex `--approve-for-me`".** Not answered. It needs a Mac where Codex is logged in.

## Remaining

| What | Why not here |
|---|---|
| Step 1 and Step 2 on Linux (amd64, rootless) and Windows (rootful machine on WSL 2) | This is a Mac. |
| `podman machine init` flags on WSL | This is a Mac. On macOS, `--cpus`, `--memory` and `--disk-size` took effect (`podman info` reports 4 CPUs and 5.75 GiB). |
| Google Chrome arm64 under the spec's flags | The package was found, not installed. The spike used Debian's Chromium. |
| Step 3, the Desktop webview JavaScript-channel bridge, on all three OSes | Not in this run's scope. |
| Step 4, terminal echo against credit windows, direct, TURN and relay | Not in this run's scope. |
| TURN cost per open minute | Not in this run's scope. |
| The stream through a real noVNC that draws, over a link with latency | This client never draws and runs over loopback, so its numbers are an upper bound. |
| Real Gmail scrolling | Needs a logged-in account; not allowed in the spike. |
| Paste of Vietnamese and emoji over the extended clipboard | Not measured; the key path's limit makes it the path that matters. |
| `podman events --filter event=died` | The filter was not run; the event name was. |
| Codex approval (`--approve-for-me`, `default_tools_approval_mode`) and a 30-minute wait through a model turn | Codex is not logged in on this Mac. |
| Claude Code approval for real browser tools in `auto` | Needs the tool server. |
| Step 6's four numbers and Step 7's decision | Depend on Steps 3 and 4. |

## Cleanup

- Every container, volume, network, secret and image the spike made was removed: `harness-spike-b1`, `-b2`, `-b3`,
  `-sec`; `harness-spike-profile`; `harness-spike-net` and `harness-spike-net-1` to `-300`; `harness-spike-proxy`;
  `harness-spike-browser:1` and `:2`, and the `debian:trixie` base they pulled. Listings were empty afterwards.
- The machine `harness-spike` was stopped and removed with `podman machine rm -f`. That left its EFI store, ignition
  socket and lock, the 930 MB image download, and the SSH key pair and port-allocation files that init created
  (birth time 13:47, the init). All of these were deleted by name.
- `podman machine list` shows only `podman-machine-default`, stopped, 12 CPUs, 8 GiB, never started, as before. The
  default connection is still `podman-machine-default`.
- The engine runs used scratch config only: `--mcp-config` files, `-c` overrides and a scratch `CODEX_HOME`. No global
  config file was edited. The Claude Code runs left session transcripts in the person's Claude data folder, as any run
  does. The detached tmux server (`tmux -L harness-spike`) was killed.
