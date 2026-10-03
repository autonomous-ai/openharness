# Harness Desktop and Web

Harness Desktop is the native Flutter client for browsing Harness machines and
interacting with their terminal-backed agents. **macOS is the primary supported and tested
experience.** Linux builds exist, with feature parity still in progress; Windows support is
planned and its runner is unexercised. Native embedded harness viewers require macOS;
the browser renders managed viewers on their connected machine.

`hn view` can open a viewer companion at `/?viewer=1&machine=<id>&agent=<id>`.
This owner-only destination uses normal sign-in and machine linking. It does not restore or
save the workspace, join the shared desk, or attach a terminal. OAuth returns to the same
viewer after sign-in. The existing website root rewrite serves it without a new route.
Publish the browser build before the corresponding native hn release so the entry point
recognizes the viewer destination.

The browser target uses this same Flutter package: swarms, pickers, settings, state and
the patched xterm renderer are shared. `lib/main.dart` picks the browser's workspace at
compile time (a conditional import of `lib/web/web_entry.dart`), composed for a mouse:
every action desktop keeps in its native menus is clickable (keys still work, they are
just not the way in). Browser-only UI lives in `lib/web/`, and desktop never imports it.
Browser support is available as a public preview at
[harness.autonomous.ai](https://harness.autonomous.ai).

## Web development

Use Flutter ≥ 3.47 / Dart ≥ 3.13. From `desktop/`:

```bash
flutter pub get
flutter run -d chrome --web-port=3000
flutter build web --release --no-wasm-dry-run --no-web-resources-cdn
python3 scripts/serve-web.py --port 3000  # optional local release preview
flutter test --platform=chrome --dart-define=HARNESS_TEST=true \
  test/web test/browser_login_test.dart test/observer_codec_test.dart \
  test/wire_counter_test.dart test/password_stretch_test.dart \
  test/terminal_binary_test.dart test/e2ee/strict_down_test.dart
```

Deploy `build/web/` at the root of a dedicated HTTPS origin. The host must serve
`index.html` for `/auth/callback`; `_redirects` and `_headers` cover hosts that
support those files. For other hosts, configure the equivalent SPA fallback and
revalidation of unversioned app files. Do not cache OAuth callbacks. The app uses
JavaScript/CanvasKit; WebAssembly app compilation is not validated yet.

The entry page inlines Flutter's generated bootstrap to start the app without
an extra loader request. Keep entry pages and release metadata `no-store`.
The production host serves JavaScript, CanvasKit and assets from a directory
containing the release version and archive checksum, with immutable caching.
Each fresh entry points to that release's assets. This matters because the CDN
can extend cache lifetimes even when the origin requests revalidation. Local
previews using stable filenames should use ETags and `max-age=0, must-revalidate`.

The existing backend handles browser OAuth. Local previews on `127.0.0.1`,
`localhost`, or `[::1]` use its existing loopback authorization endpoint, returning
to the registered `/callback` path on the preview's own port without a server
configuration change.
For a hosted web app, add the exact origin to the backend's `WEB_URL` or
comma-separated `WEB_ORIGINS`, and register that origin's `/auth/callback` with SSO.
Any `SSO_REDIRECT_URI` override must point to that same hosted callback. Tests use a
synthetic authorization service. An alternate backend can be selected with
`--dart-define=HARNESS_API_URL=https://your-backend.example` on run/build.

### Production release

The Flutter source remains in this package. The website that serves it lives in
[`../website`](../website) and serves its compiled files under `/harness-web/`,
with `/`, `/s/:id` and `/auth/callback` opening the Flutter app. It also serves the desktop
downloads and installer redirects.

From the repo root, on a tested commit already on `main`, run `make release-web`
(`ARGS="--dry-run"` to preview). [`scripts/release-web.sh`](scripts/release-web.sh)
tags the commit `vX.Y.Z_web`, which runs **Release web**. That one job builds the
bundle with Flutter 3.47.2, bakes it into the website image
(`gcr.io/autonomous-ecm/autonomous-code-website:<tag>` and `:latest`; ArgoCD deploys
it), and publishes the archive, SHA-256 and `harness-web-release.json` as a GitHub
Release. The script waits for the run. After a failure, fix forward and cut the next
version rather than moving the tag.

The host configures Flutter's entrypoint, asset and CanvasKit URLs under
`/harness-web/releases/<version>-<archive-checksum-prefix>/` and does not start
the deprecated generated service worker. Public routes and the base href stay
stable; legacy asset paths remain available for tabs opened before deployment.
For a local production build, run `bash scripts/build-web-release.sh X.Y.Z`.
`FLUTTER_BIN` can select an SDK installed outside `PATH`. Output is under
`build/web-release/` and `build/web-dist/`; the ordinary local preview is separate.

### Browser behavior

- Authenticated access to existing machines uses the shared viewer services and
  encrypted relay. Link a machine from the browser before controlling it.
- **Share** on a harness creates one browser link. Private links require sign-in
  with an invited email; public links open without an account. Viewers receive
  only that harness's read-only output through the encrypted observer relay, with
  the owner's identity pinned in the link. Sign-in returns to the same link.
  Comments travel through that channel and persist on the owner's machine;
  posting requires sign-in. Authors can remove their comments and owners can
  moderate the thread. **Stop sharing** removes link and invitation access.
  The owner's machine must be online; published snapshots are not included.
- Login, linked machines, preferences, and cached workspace metadata persist in
  this origin's local storage across tabs and browser restarts. Only the pending
  OAuth transaction is tab-local. Browser locks serialize token refresh and
  machine-key writes; signing out or changing accounts reloads other open tabs.
  **Sign out** clears authentication while keeping this browser's machine links.
  Clearing site data removes both; private browsing retains them only for that
  private session. Existing tab credentials migrate on the next reload.
- **Download app** sits at the top right of sign-in and workspace screens, opening
  the existing macOS/Linux download page in a separate tab. Browser sign-in uses
  a full-page fleet diagram and prominent CTA, sharing the native login actions
  and their waiting, cancellation, and recovery states.
- Workspace shortcuts use **Option/Alt** in the browser: Alt-P finds harnesses,
  Alt-N starts a harness, Alt-M opens machines, and Alt-T opens a swarm.
  Alt-Shift-A opens the companion conversation without taking New Tab's key.
  Machine connection commands and link requests use that same `@` picker,
  with connection and setup forms inside its preview pane.
  Text editing and terminal
  Control keys keep their usual behavior. The shared shortcut sheet and welcome
  hints show the active bindings.
- Agent processes and files stay on their host machines. Local provisioning,
  desktop updates, hardware firmware, local usage ledgers, keyboard config files,
  system notifications, and native image clipboard remain desktop capabilities. Closing the browser
  does not stop a running agent.
- **Work from your phone** on the welcome page shows the same QR setup as
  desktop. In a browser it pairs the phone with the selected linked computer,
  over an encrypted owner connection. The computer name stays visible and fixed
  while the QR is open. A browser without a linked computer offers the machine
  picker first.
- API connections, model controls and orchestrator projects run on a linked
  computer. Editors keep their destination while open; reopening model controls
  selects the current computer. API keys are saved on that computer, not in
  browser preferences. The command bar uses the same daemon decision service
  and requires the same provider configuration; local navigation still works
  without it. Sending a task remains a separate confirmed action.
- Managed viewer panes accept mouse, keyboard and text input through an
  encrypted owner connection. Their isolated Chromium renderer runs on the
  agent machine and must be installed there. Shared-link viewers remain read
  only. Streams are bounded to four interactive surfaces per connection/eight
  per daemon, with an idle timeout; native dialogs, browser downloads, audio and
  OS clipboard bridging are not provided by this stream. These capabilities
  require an updated daemon; older hosts receive update guidance.

The disposable full-stack fixture also accepts
`HARNESS_WORKSPACE_BROWSER_CHECK=$PWD/desktop/scripts/check-workspace.cjs` and
`HARNESS_SHARE_BROWSER_CHECK=$PWD/desktop/scripts/check-sharing.cjs` when running
`npm run test:sharing-e2e` from `cli/` (set the paths from the repository root).
It launches fixture accounts and daemons, signs into the browser through an SSO
stand-in, then uses real password linking, encrypted RPCs, terminal/viewer input,
API storage and shared links. No real user home or credentials are used. See
[the readiness record](../docs/plans/2026-09-27-008-web-release-readiness.md)
for the build origin, service prerequisites and current verification evidence.

Keep product changes in the existing shared screens and state. Add platform
adapters only for browser/native capabilities, following the conditional stores,
login adapter, and runtime capability checks already in `lib/`.

## Development

For workspace dialog work, follow the
[terminal dialog design system](design/terminal-dialogs.md): fixed cells, plain
text, and one-line selection, using Cmd-N and Cmd-O as references.

Install a compatible Flutter SDK, then run the project from this directory
(`desktop/` in the monorepo):

```bash
cd desktop
flutter pub get
flutter test
flutter run -d macos   # or: flutter run -d linux
```

Useful validation commands:

```bash
dart analyze
bash scripts/build-macos-debug.sh
flutter build macos --release
flutter build linux --release   # must run on an Ubuntu host — no cross-compiling
```

The macOS debug script uses the same renderer as the host's release build: Skia on
Intel, Impeller on Apple Silicon. It also pins that choice for opening `Harness.app`
directly. On Intel, add `--no-enable-impeller` to `flutter run` and native integration
test commands; the default renderer can make bitmap artwork disappear.

The terminal core is vendored at `third_party/xterm`. Do not replace it with an
upstream package upgrade without preserving the local rendering and IME fixes.

## Harness manager

On macOS, the Harness portrait symbol follows the system menu bar's appearance and
carries a small circular unread badge at its bottom-right corner,
only when notifications are unread (`99+` above 99; the tooltip keeps the exact count). Open it for
one Notifications section, with questions first and the newest results below.
Each row pairs the harness name with its question or completion recap, the
shared tab/pane status mark, and arrival time. Tab and machine details remain
in tooltips. The first five appear here; View all opens the full inbox. Read sessions
disappear, and an empty inbox says “No unread notifications.” Working starts
expanded, showing active sessions with elapsed time when the app observed their start;
idle sessions and sessions already listed above do not fill this section.
Working never contributes to the unread badge. New Harness and Open Harness
use the normal creation and existing-session pickers. Show Harness brings the
window forward; Quit exits the app. Selecting a conversation reuses its existing
pane before revealing the window. The close icon beside Notifications marks
all read, acknowledging the opening
snapshot without answering pending questions or clearing newer arrivals.
Linux and the browser keep the in-window notification bell. GitHub merge
notifications are not part of this menu yet.

The search icon to the left of Harness Store opens a compact list across your
machines. Each harness shows its agent and name, followed by its machine, project,
branch, and last activity (`5m`, `1h`, `2d`). Search matches names, machines,
projects, branches, and pending questions. Filter All, Needs input, Running, or
Paused; sort by recently active, name, machine, or project.

The Needs input filter remains available independently of read notifications. An amber help action
opens the waiting harness; its question appears on a third line in the Needs input
view. The same view opens with **⌘⇧I**. Questions update live and stale actions
cannot redirect you after a question is answered or replaced elsewhere.

Select a row to reveal its existing pane or resume and open saved work. The
separate play button resumes in the background. Pause/play remains at the right;
normal states need no redundant labels.

Pause uses the CLI's existing stop operation, keeping the saved conversation and
project on its machine. Pause/resume controls are enabled for saved Claude and
Codex conversations; other engines remain openable with a tooltip explaining
that exact resume is unavailable. The CLI confirms termination of the exact process
and pane before publishing the paused state, preserving other panes in the same
tmux session. A failed inventory refresh keeps confirmed paused work visible,
and pending operations survive closing the manager.

Closing a pane only hides its view: a curved Genie animation draws it into
Harnesses while the process continues. A bounded GPU snapshot animates while the
live terminal stays mounted at its original size. macOS Reduce Motion skips it.
Offline and shared harnesses expose their state without offering process controls.
Errors remain beside the affected row, and an uncertain resume checks its original
receipt rather than starting the process twice.

## Open media from agent output

Hold **⌘ and click** on macOS, or **Ctrl and click** on Linux, to open an
image/video path in the OS default app. HTTP(S) links open in the default browser.
Hover over a recognized path to see the shortcut and full target. Normal clicks,
text selection, copy/paste and terminal mouse input keep their existing behavior.

Local previews support absolute paths, `~/...` and `file://...` URLs, including
spaces, Unicode, visible Markdown links and terminal soft wraps. The file must
already exist. Relative paths need a full path because CLI agent frames do not
currently include the working directory.

For a remote agent, the same shortcut downloads the file over the existing E2EE
connection and opens the completed local copy in the OS viewer. The remote
machine must run a CLI advertising `mediaPreview`; older CLIs show update guidance.
Remote relative paths resolve inside that agent's working folder; absolute paths,
`~/...`, and `file://...` resolve on the remote machine, including artifacts in `/tmp`.
The pane shows download progress and Cancel. Closing/changing panes cancels the
download. An interrupted transfer or a file changed during transfer is never opened.

Previews are limited to 512 MiB per file and downloaded in bounded chunks. Copies
live in `~/.harness/desktop-app/media-previews`; before each download, inactive
copies older than 24 hours or over the 1 GiB cache budget are pruned. Cache names
are unique, so matching paths on different machines cannot overwrite one another.
This reads visible terminal text, not hidden OSC 8 hyperlink targets.

The optional A/B smoke test uses isolated identities, two loopback WebSockets,
the CLI's real E2EE handshake/media reader and ffmpeg-generated PNG/MP4 fixtures:

```bash
REMOTE_MEDIA_CLI_ROOT=../openharness/cli flutter test test/remote_media_smoke_test.dart
```

Install the companion CLI's npm dependencies first; ffmpeg must be on PATH.
The smoke test does not use a real account or remote machine. It verifies the OS
launch URI; playback in the native viewer is a separate manual check.

## Viewers on linked machines

Open a harness on a linked machine and its viewer appears beside the terminal. The local CLI
forwards it through the existing encrypted machine connection, including interactive controls,
streaming updates and WebSockets. Both computers need a forwarding-capable Harness CLI. An older
remote CLI shows update guidance in the viewer pane; reconnect after updating it.

The local viewer endpoint is private to the machine connection and closes on disconnect or
revocation. This feature uses your existing machine access; it does not create a public share link.
Embedded viewers remain macOS-only. See the
[remote viewer plan](../docs/plans/2026-09-17-004-remote-viewers.md) for compatibility and tests.

## Local Codex profiles

New Harness → Codex discovers local profiles when the Harness CLI advertises
`supportsCodexHome`. The picker appears only when there are at least two distinct
profile folders; **Default** does not count as another profile. A single profile
is selected automatically, while no profiles keeps the normal launch. Linking
and refreshing remain available in both cases.

Discovery combines `CODEX_HOME` from the app environment, homes
observed on this computer's Codex agents, Codex-named folders in home/XDG config
with an existing `auth.json` or `config.toml` (including `.codex2` and
`.codex_work`), and directories explicitly linked before. An empty default
directory does not create a second profile.
It also reads literal `CODEX_HOME` declarations in bash/zsh/fish startup files,
aliases, functions, sourced files, and executable shell wrappers in local bin/PATH
directories. Shortcut names do not have to contain "codex". `$HOME`, `${HOME}`,
tilde and simple directory variables are supported; symlinks are deduplicated.

Discovery never executes shell configuration or shortcuts and never reads Codex
credentials. Shell scanning stops after 3 seconds, 256 small scripts, or four
levels of script references. Computed paths, unsupported shell syntax and profiles outside
these sources can be added with **Link a profile folder…**. Choose the actual
`CODEX_HOME` directory, not the shortcut executable or a named configuration
preset. Only linked paths are saved. **Refresh profiles** rescans without changing
the current choice; new local agent homes also update an open picker.

The selected directory supplies that agent’s Codex login, configuration, hooks,
history and model cache, and stays attached across restarts. The terminal header
shows its folder name and exposes the full path in a tooltip. **Default** keeps
the machine’s normal launch behavior. This picker applies to local agents using
Codex’s own account; remote machines use their existing flow.
The rail’s Codex usage panel still reports the default `~/.codex` profile.

This requires the companion CLI support for `agent_create.codexHome`. Older CLIs
show update guidance and keep default launches available; Desktop refuses an
explicit profile when support is missing rather than silently using another login.

## Local and production terminal E2E

The terminal E2E scripts exercise this desktop client together with source
checkouts of the Harness backend and CLI. The CLI is this repo's own `cli/`;
the backend is a sibling `autonomous-code` checkout. Their default layout is:

```text
.../autonomous-ai/
  autonomous-code/
  openharness/
    cli/
    backend/
    desktop/        <- this app
```

Set `AUTONOMOUS_CODE_ROOT` when the backend checkout is elsewhere and
`HARNESS_REPO_ROOT` when the Harness CLI checkout is elsewhere (it defaults to
this repo's root, i.e. `desktop/..`).

```bash
bash scripts/start-terminal-local-manual.sh
bash scripts/test-terminal-local-e2e.sh
PROD_TERMINAL_E2E=1 ... bash scripts/test-terminal-prod-e2e.sh
```

The production script deliberately requires release, deployment, machine, and
commit evidence before it sends terminal traffic to production.

## Autonomous device pairing

Settings → Devices discovers Autonomous devices on the same network using the
CLI's `_autonomous._tcp` discovery, reusing the device's existing advertisement. Start pairing on the Autonomous
device to generate its code, select that device in Desktop, and enter the code.
The Mac connects directly to the selected device without backend routing or a
manually entered IP address. The device needs no backend credentials; Harness’s
existing Mac login/start requirements remain unchanged.

The pairing form is one shared settings row: device picker with an adjacent refresh
icon, code field and Pair button. The form aligns with the title at the top; a
visible note explains that closing Desktop leaves the connection running.

Desktop uses `harness autonomous-device discover --json` to populate the picker.
The CLI resolves the selected discovery ID to its host and port. Pairing runs
`harness autonomous-device pair --code-stdin --device <discoveryId> --json` through
`HarnessCliRunner`; the code travels through stdin only, never argv or logs.
Code normalization matches the original Harness pairing implementation, including
Crockford aliases and separators. The original PAKE handshake authenticates the
connection. Changing or losing the selected discovery identity clears entered
code, and a code mismatch remains visible through background refreshes. A mismatch
consumes the device pairing window: generate a new code before retrying. Rate
limits require waiting five minutes before another attempt. Desktop allows the
pair command fifty seconds to finish, beyond the CLI’s bounded handshake deadline.

`status` and `list` report direct connections and saved device identities.
Revocation requires confirmation and targets the complete saved fingerprint.
Closing Desktop leaves the CLI daemon running. Discovery and status refresh every sixty seconds, including when no device is
paired. Use Refresh to discover a newly started device immediately. Pasted codes
may include separators, for example `ABC-123`. Older CLIs show `harness update`
guidance. Widget tests inject a fake CLI, and the `kUnderTest` gate prevents real
processes and background polling.

## Releases

The application self-updates from the Harness desktop metadata manifest in the
public GCS release bucket. Release commands stay in this repository:

```bash
make upload-desktop           # macOS
make upload-desktop-linux     # Linux (ARM64 or x64) — must run on the matching Ubuntu build host
make upload-desktop-linux ARCH=arm64
make upload-desktop-linux ARCH=amd64  # amd64 is the x64 artifact
make upload-node-runtime ARGS="22.23.2"
```

See [RELEASE.md](RELEASE.md) for signing, notarization, versioning, managed
Node runtime publishing, safe test releases, and rollback behavior.

Pairing failures use the original Harness manager's validation and attempt limits.
If the device code expires, start pairing again on the Autonomous device.

## App focus and device voice routing

The selected terminal pane is the source of agent focus for the CLI's paired-device
voice mode and the OS Monitor Pairing page. Desktop announces `app_focus` with its
`agentId` through the existing local CLI WebSocket, and reasserts the selected pane
after reconnect. Opening an unrelated terminal or changing which macOS/Linux
window is frontmost does not select another voice agent. Closing the selected pane
announces the replacement pane; closing the last pane or selecting a machine-only
pane sends `app_focus` with `agentId: null`. Switching machines clears the previous
connection's focus before announcing the new target. This requires the CLI version
that publishes app focus to paired devices; there is no separate voice-agent picker
in Desktop.

### Đồng bộ agent đang focus và giọng nói từ device

Pane terminal đang được chọn là nguồn focus cho voice mode của device đã pair và
trang Monitor Pairing của OS. Desktop gửi `app_focus` kèm `agentId` qua WebSocket
local CLI hiện có, và gửi lại pane đang chọn sau khi kết nối lại. Mở terminal khác
ở nền hoặc đổi cửa sổ macOS/Linux ở phía trước không chọn lại voice agent. Đóng
pane đang chọn sẽ thông báo pane thay thế; đóng pane cuối hoặc chọn pane chỉ có
machine sẽ gửi `app_focus` với `agentId: null`. Khi đổi machine, Desktop xóa focus
trên kết nối trước rồi thông báo target mới. Cần phiên bản CLI có hỗ trợ chia sẻ
app focus cho device đã pair; Desktop không có bộ chọn voice agent riêng.
