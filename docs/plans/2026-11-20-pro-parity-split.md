# Harness Pro supports every app the round dial supports: audit and split (2026-11-20)

Status: audit and split approved by the PM (2026-11-20). Read-only lead work; nothing coded. Base: `main` a59ba98a15.

Diego (2026-11-20): the Pro supports only the Harness app today; it should support the other apps the round dial does,
following his mockup (main checkout, gitignored, read-only): `devices/harness-pro/mockup/pro-ui-2026-11.html`
(2026-11-18). Diego lifted the "never edit `devices/harness-pro`" rule for this work.

## The finding in one paragraph

Every app the round dial reaches (Claude Code CLI and app, the ChatGPT app's Codex threads, VS Code and Cursor terminals
and panels, Orca, herdr, tmux, Ghostty, iTerm2, Terminal, cmux, opencode, Warp, WezTerm, kitty, Zellij) is a host in the
devices process (`cli/src/cable/hosts/*`, `cli/src/services/devices.ts`), shared by every device on the cable. The
daemon turns the app view on for a device whose hello says `appFilter: "v1"` (`cableSession.ts:1444`). The Pro does not
say it, and its Home draws cards only from `swarms` (the Harness desktop's tabs, `pro_cable.c:495-531`), so it sees only
Harness; with no Harness window its Home is the wordmark. **The gap is mostly Pro firmware**, plus a small daemon change.

## 1. Gap audit

Host path: the Pro talks to the daemon over the **USB cable only** (USB-Serial/JTAG, VID/PID 303a:1001 like the round
dial; no Wi-Fi, the module's ESP32-C5 is held in reset). The same `cableSession.ts` serves both devices; they differ only
by their hello.

| Capability | Round dial | Pro today | Gap owner |
|---|---|---|---|
| Agents of every app (hosts above) | yes, host side | gets the machine ring with no window, draws none of it | **Pro firmware** |
| `apps` frame, `app.pick`, welcome `apps.switch` (#4441) | yes (`cable_client.c:823`, `:306`) | not parsed, not sent | **firmware** (daemon has it) |
| TABS \| APPS pill, APPS screen | yes (`ui_habitat.c:1350`, `:1701`) | no | **firmware** |
| "N working" on an app card | not shown (count, waiting only) | no | **daemon**: `apps` rows carry no working count |
| App icon and colour | none (engine icons only) | 14 engine logos, no app icons | **firmware assets** |
| `host`, `caps` on `agent`; `view`, `tab` on `agents.end` | read | not read (`pro_cable.c:396-427`) | **firmware** |
| Resting rows (Claude app session / ChatGPT thread with no process, #4485, #4494) | caps `sf`, no wire field | no | **firmware**: read caps |
| Ended rows (observed, not live) | caps `s` | no | **firmware** |
| "See it in ChatGPT" on a tap of an agent without `v` | firmware, from `host` (`ui_habitat.c:3133`, `:541`) | no; the Pro has a 3 s notice line with no caps rule (`pod_glue.c:44-55`) | **firmware** |
| `question.tier` (`tier: "list"` = silent row) | yes | reads `summary.tier` only | **firmware** |
| Notices and inbox | yes | yes (`notif.replace`, `notif.seen`, `summary.tier`) | none |
| Voice up to 10 min, segment transcription (#4495, #4506) | yes | 600 s cap (`pro_voice.c:28`); segments are daemon side (`voiceSegments.ts`, made on every `voice.begin`), so the Pro already gets them | none |
| Scroll into herdr / VS Code terminals | yes | the Pro already sends `scroll`; the daemon routes by agent | none expected; item A's tests confirm |
| Custom pets (#4511) | `pets`, `petIds`, `pet.*` | compiled-in pets only | **out of scope** (PM, 2026-11-20) |

Wire fields the Pro ignores today: `view`, `tab`, `total` (on `agents.end`), `host`, `caps`, `model`, `effort` (on
`agent`), `apps`. Messages it never sends: `app.pick`, `swarm.select`, `turn.send`, `answer`, `question.read`.

### Hello and welcome today

- Round hello: `fw, product, proto, appFilter:"v1", questionTier:"v1", hw, mac, settings, pets:2, petIds`.
- Pro hello: `fw, product, proto, hw, board:"pro", swarms:"members-v1", recap:"long-v1", activity:"steps-v1",
  stats:"turn-v1", player:"library-v1", ota:"v1", mac, settings`.
- Welcome to a Pro: `voice.draft, agents.refresh, player.library, resync, [form, selection, visit, question.review],
  settings`. The Pro reads only `player.library` and `resync` (`cable_features.c`). The round reads `apps.switch` and
  `question.tier` too. With `appFilter` and `questionTier` the Pro's list is at most 11 entries, under the firmware's 16.

### What changes when the Pro says `appFilter` (checked in code)

- **(a) One filter per host.** `AppFilter` is shared by every dial on the cable host (`cableHost.ts:686`): a pick on the
  Pro turns the round dial too. Kept: both follow the app in front on the Mac.
- **(b) Tabs vanish on an app's ring.** `windowOf()` is `null` while the view is `apps` (`cableHost.ts:634`), so
  `listSwarms` returns `[]` and the Pro's Tabs cards would empty. Item A keeps sending the window's `swarms` to a device
  that says `swarms: "members-v1"` while the view is `apps`. A tap on a tab card sends `agent.open` of a Harness agent,
  which already runs `pickApp('harness', 'notice')` and brings the Desktop (`cableSession.ts:1685-1705`).
- **(c) `questionTier` on a Pro.** A question told again is refiled as `tier: "list"` and skips the `!held` guard written
  for the Pro's mute by hash (`cableSession.ts:3062`). The Pro says `questionTier` only together with reading `tier` on
  `question` (item B).
- **(d) Swipes and taps follow caps.** On an app's ring `capsOf` answers: a swipe to an agent without `f` only marks it
  seen (`cableSession.ts:1653`); a notice tap on an `appFilter` dial turns the ring before `agent.open`
  (`cableSession.ts:1691`). Both are the round dial's behaviour, wanted on the Pro.
- **(e) `seq`.** Every frame to a Pro carries `seq`, `apps` included; `resync` already forces `syncAgents(true)`, which
  resends `apps` (`cableSession.ts:3089-3097`).

## 2. Decisions (PM, 2026-11-20)

1. App icons are **built into the firmware**, generated like the engine logos (`scripts/pod_gen_logos.py`). An app with
   no icon shows its name only.
2. A new hello capability **`appCards: "v1"`** adds `working` to each `apps` row. A device that does not say it gets the
   same `apps` frame as today, byte for byte, with the same push cadence (the key counts `working` only for it).
3. **No Harness window: Home goes straight to the app cards**, with no pill (as the round dial's machine view opens
   APPS). With a window, the Tabs | Apps pill sits under Home's cards, shown only while another app has agents.
4. **Custom pets are out of this work.**
5. Split: A (daemon), B (Pro firmware cable and model), C (Apps screen; the room changes too; after B), E (app icons).
   The gestures and voice item (D) is folded into C: voice is already at parity, scroll and swipe go through the daemon.

## 3. Interfaces fixed now, so A, B, C and E do not wait on each other

- **Wire `apps`** (daemon to device): `{t:"apps", shown, apps:[{id, name, count, waiting, working?}]}`. At most 16 rows
  (`APP_LIMIT`, `hosts/select.ts:10`); `working` (integer, `0 <= working <= count`) only when the hello says
  `appCards: "v1"`. `waiting` is the Pro's "asking".
- **Wire `app.pick`** (device to daemon): `{t:"app.pick", app}`, as the round dial sends it (`cable_client.c:306-314`).
- **Pro hello** adds `appFilter: "v1"`, `questionTier: "v1"`, `appCards: "v1"`.
- **`pod_model.h`** (item B owns it):
  - `pod_app_t { char id[16]; char name[24]; uint8_t count, waiting, working; }`, at most `POD_APPS_MAX 16`;
  - the model holds `apps[]`, `app_count`, `app_shown[16]`, `apps_switch` (the welcome listed `apps.switch`), and
    `machine_view` (the last `agents.end` said `view: "machine"`) plus `has_window`: the last `agents.end` had a
    non-empty `tab`, OR the last `swarms` frame still holds a tab. While a window is open and the view is an app's
    ring, `agents.end` says `tab: ""` and `view: "machine"`, but item A keeps sending the window's `swarms` to a
    device that says `swarms: "members-v1"` (PM, 2026-11-20);
  - `pod_agent_t` gains `char host[16]` and `uint8_t caps` (bits `POD_CAP_S`, `POD_CAP_V`, `POD_CAP_F`, `POD_CAP_A`;
    `caps` absent means all four, as `caps_of` on the round, `cable_client.c:957`);
  - `const char *pod_host_name(const char *host)`: the display name ("ChatGPT" for `codex`), the table of
    `ui_habitat.c:533-547`;
  - `bool pro_cable_send_app_pick(const char *app)`.
- **`app_icons.h`** (item E owns it):
  `typedef struct { const uint16_t *rgb565; const uint8_t *alpha; uint16_t size; } pod_app_icon_t;`
  `typedef struct { const pod_app_icon_t *icon72, *icon44; uint16_t card_top, card_bottom; } pod_app_style_t;`
  `const pod_app_style_t *pod_app_style(const char *app_id);` returns `NULL` for an id with no icon; the caller then
  draws the name only, on the Pro's own dark card. `card_top` and `card_bottom` are RGB565, the gradient's two ends.

## 4. Work items

| Item | Size | Starts | Owns (no other item edits these) |
|---|---|---|---|
| A. Daemon serves the Pro the app data | full, M | now | `cli/src/cable/cableSession.ts`, `cableHost.ts`, `hosts/select.ts`, their specs, `cli/e2e/dialAppFilter*.e2e.ts`, `devices/harness-pro/docs/cable.md` |
| B. Pro firmware: cable, model, caps | full, M | now | `firmware/main/cable/*`, `main/pod/pod_model.*`, `main/pod/pod_types.h`, `main/app/pro_app.*`, `test/test_pro_cable.c`, `test_pod_model.c`, `test_pro_hello.py`, `test_pro_app.py`, `devices/harness-pro/README.md` (daemon contract list) |
| C. Pro firmware: Tabs \| Apps pill, Apps screen, rooms | full, L | spec now; code once B's `pod_model.h` lands on `main` | `main/pod/home/*`, `pod_nav.*`, `pod_view.*`, `main/app/pod_glue.*`, `test/test_ph_*.c`, `test_pod_nav.c`, `pod_render.*`, `golden*.txt`, `ph_perf_baseline.txt`, `golden.sh` |
| E. App icons and card colours | full, S | now | `firmware/scripts/gen_app_icons.py`, `.github/assets/apps/`, `main/pod/app_icons.{c,h}` (generated), `test/test_app_icons.py`, `main/CMakeLists.txt` (one source line) |

C and B both reach `test_pro_app.py`: B adds wire-driven cases, C adds click-through cases; C rebases on B, so
there is no overlap at the same time. Only C touches the golden hashes.

## 5. Hardware safety (every item)

- **Never flash, never run flash.sh/esptool.** No `idf.py flash`, no `idf.py monitor`, no serial port opened to any
  board, no touching Diego's devices. The Pro has a power latch: an image for the wrong board revision bricks it.
- ESP-IDF 5.5.4 at `~/esp/esp-idf-5.5.4` is used only to compile (`idf.py -B build -DPROJECT_VER=0.0.99-pod build`)
  and for the host tests. PR CI runs the real ESP-IDF build and fails when `harness_pro.bin` outgrows `ota_0`.
- No release: OTA key `harness-pro` (`make upload-pro`) only when the PM asks Diego, after the merges.

## 6. Platforms (Ken, 2026-11-20)

New code in devices, the cable or device-app has its win32 and linux branches, or names the gap where Ken's work
(dial-windows #4513, device-app on Windows and Linux, dial-app-sessions) plugs in. Once those merge, every task supports
macOS, Linux and Windows; macOS is the UX reference, and a difference due to the OS is written down with its reason.

- Firmware (B, C, E) runs on the Pro; its host tests run on macOS and Linux (CI).
- Daemon (A): the app list, counts and filter run on all three. Bringing an app forward is `open -b` on macOS
  (`hosts/open.ts:98`) and the raise on Linux (`hosts/linuxRaise.ts`); **Windows has none yet**, which is Ken's #4513.
  The Pro's cable on Windows goes through `harness-serial.exe` (`cable/windowsSerial.ts`) and is not yet checked with a
  Pro: item A states it in its PR.

## 7. Briefs

Each brief below is a whole child prompt. The PM prepends nothing; they already start with `/devcrew`.

### Brief A

```
/devcrew Harness Pro, item A: the daemon serves the Pro the same multi-app data as the round dial. Orchestrator: harness root. Size: full.

Context: docs/plans/2026-11-20-pro-parity-split.md (read it first; sections 1-3 and 5-6 apply). The Pro (devices/harness-pro, ESP32-P4, USB cable only) will say appFilter:"v1", questionTier:"v1" and a new appCards:"v1" in its hello (item B, in parallel). Every app host already exists in the devices process; this item makes the daemon's answer right for a Pro.

Goal:
1. Parse a new hello capability appCards:"v1" in cli/src/cable/cableSession.ts (beside appFilter, reset on a new port and on close, logged in the capability line at :790). For a session that says it, each `apps` row carries `working`: how many of that app's agents are mid-turn now (0 <= working <= count), counted where count and waiting are counted (cli/src/cable/hosts/select.ts rings / cableHost.ts appList and tabApps). The apps key counts `working` only for such a session. A session without appCards gets byte-identical `apps` frames and the same push cadence as today (test it).
2. A device that says swarms:"members-v1" keeps getting the window's `swarms` while the host's view is `apps` (today windowOf() is null there, cableHost.ts:634, so listSwarms returns [] and the Pro's Tabs cards would vanish). Only `swarms` changes; the ring, focus and the round dial's frames stay as they are (test both).
3. Specs that a hello with board:"pro" + appFilter:"v1" + questionTier:"v1" + appCards:"v1" + swarms:"members-v1" gets: welcome features apps.switch and question.tier and resync (11 entries at most, firmware cap 16); `apps` frames with `seq`; `apps` resent by `resync`; app.pick turning the ring and bringing the app; a tap (agent.open) on a Harness agent from an app's ring returning the view to tabs; a scroll on a herdr/VS Code agent routed as for the round dial.
4. Update devices/harness-pro/docs/cable.md: the three new hello keys, `apps`/`app.pick` in the messages the Pro uses, `working`, and the swarms rule.
Decided by the PM (do not reopen): the app filter stays one per host, shared by every dial; appCards:"v1" gates `working`; nothing changes for the round dial.

Files you own: cli/src/cable/cableSession.ts, cli/src/cable/cableHost.ts, cli/src/cable/hosts/select.ts (and appFilter.ts only if counting needs it), their .spec.ts files, cli/e2e/dialAppFilter.e2e.ts (or a new dialProApps.e2e.ts), devices/harness-pro/docs/cable.md. Nothing in cli/src/core/ (cli/AGENTS.md rule 7). Do not touch devices/harness-pro/firmware (items B, C, E own it).

Dependencies: none; start now. The wire shapes are fixed in the split doc section 3.

Tests (no hardware): vitest red then green (cableSession.spec.ts, cableHost.spec.ts, hosts/*.spec.ts); npm run typecheck; npm run test:core if you touch src/services/; CLI end to end with an isolated daemon, a fake `open` and a fake dial that sends the Pro's hello (cli/e2e, never the real ~/.claude, ~/.codex, port 18473 or tmux server). The GitHub "CLI end to end" workflow is heavy: ask the orchestrator for the turn first.
Hardware: never flash, never run flash.sh/esptool, never open a serial port to a real device, never touch Diego's devices.
Platforms: the app list, counts and swarms rule run on macOS, Linux and Windows. Bringing an app forward is open -b on macOS and the raise on Linux; Windows has none yet: write that gap in the PR for Ken's dial-windows #4513, do not build it. State in the PR that the Pro's cable on Windows (harness-serial.exe) is not yet checked with a Pro.
Rules: logs use errorKind and fixed words (#4458, #4488), no content or identifiers; never read another process's environment; no screenshots of Diego's screen; English in docs, code and GitHub, Vietnamese with the orchestrator.
```

### Brief B

```
/devcrew Harness Pro, item B: the Pro firmware's cable and model take every app's agents, the app list and caps. Orchestrator: harness root. Size: full.

Context: docs/plans/2026-11-20-pro-parity-split.md (read it first; sections 1, 3, 5, 6). Diego (2026-11-20) wants the Pro to support every app the round dial supports and lifted the rule against editing devices/harness-pro for this work. The round dial's firmware is the reference: devices/harness-device/firmware/main/cable_client.c (handle_apps :822, handle_agent :971, handle_agents_end, caps_of :957, app.pick :306, handle_question tier) and cable_features.c. Read devices/harness-pro/README.md and docs/cable.md.

Goal (devices/harness-pro/firmware):
1. Hello (main/cable/pro_cable.c send_hello :217) adds appFilter:"v1", questionTier:"v1", appCards:"v1".
2. cable_features.c/h read apps.switch and question.tier (keep the 16-entry rule).
3. Parse `apps` {shown, apps:[{id,name,count,waiting,working?}]}: at most 16 rows, ids < 16 B, no duplicates, names cut between UTF-8 letters, counts bounded; hand them to the model whole (pro_app_apps()).
4. `agent` reads `host` (< 16 B) and `caps` (letters s v f a; absent = all four); `agents.end` reads `view` ("machine") and `tab` (non-empty = a window is open).
5. Send `app.pick` {app} (pro_cable_send_app_pick).
6. `question` with tier:"list" files a silent row (no beep, no wake, no toast) only when the welcome listed question.tier; any other value or none is an alert, as today.
7. Voice and taps follow caps: an agent without `v` never opens the microphone; pro_app_voice_block_reason (main/app/pro_app.c :605) returns "See it in <App>" (pod_host_name: "ChatGPT" for codex, "Claude" for claude, the table of ui_habitat.c:533-547), shown by the existing notice line for 2 s as on the round dial.
8. The model (main/pod/pod_model.h/.c) holds exactly the interface fixed in the split doc section 3 (pod_app_t, POD_APPS_MAX 16, app_shown, apps_switch, machine_view, has_window, pod_agent_t host + caps, pod_host_name). Land this header early in your plan (its own first task): item C codes against it.
9. Update the README's daemon contract list (hello keys, features read).
No UI drawing in this item: item C draws the pill, the Apps screen and the rooms.

Files you own: firmware/main/cable/*, main/pod/pod_model.*, main/pod/pod_types.h, main/app/pro_app.*, test/test_pro_cable.c, test/test_pod_model.c, test/test_pro_hello.py, test/test_pro_app.py (wire-driven cases), devices/harness-pro/README.md. Do not touch main/pod/home/*, pod_nav, pod_view, pod_glue, golden files (item C) or app icons (item E), and nothing under cli/ (item A).

Dependencies: none; start now. Wire shapes are fixed in the split doc; item A builds the daemon side in parallel.

Tests (no hardware): bash devices/harness-pro/firmware/test/run.sh (test_pro_cable.c feeds raw JSON frames to pro_cable_on_frame and records the pro_app_* calls; add `apps`, `agent` with host/caps, `agents.end` with view/tab, question tier, malformed and over-cap cases), python3 test/test_tree_isolation.py, test/test_fonts.py, test_pro_hello.py, test_pro_app.py; golden.sh --check must still match (no drawing change). Compile only, with ESP-IDF 5.5.4: `. ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99-pod build`; PR CI runs the real build and the ota_0 size check.
Hardware: never flash, never run flash.sh/esptool, no idf.py flash or monitor, never open a serial port to a board, never touch Diego's devices. The Pro has a power latch: a wrong-revision image bricks it. No release (OTA key harness-pro) unless the PM asks Diego.
Platforms: firmware only; host tests on macOS and Linux (CI). Nothing OS-specific to add.
Rules: logs use fixed words and counts, no names or ids of agents; English in docs, code and GitHub, Vietnamese with the orchestrator; never read another process's environment; no screenshots of Diego's screen.
```

### Brief C

```
/devcrew Harness Pro, item C: the Tabs | Apps pill, the Apps screen and the rooms of other apps' agents. Orchestrator: harness root. Size: full.

Context: docs/plans/2026-11-20-pro-parity-split.md (read it first; sections 1-6). Diego's mockup, reviewed 2026-11-18, read only: /Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness/devices/harness-pro/mockup/pro-ui-2026-11.html (main checkout, gitignored; never copy it into the repo). Keep the Pro's current UI; add the app-choosing flow. The round dial's design for the same flow: docs/plans/2026-11-18-dial-tabs-apps-switch-design.md.

Goal (devices/harness-pro/firmware):
1. With a Harness window open and another app holding agents (model: has_window, app_count > 0, apps_switch): a two-cell Tabs | Apps pill under Home's cards, in Home's own tokens (Inter SemiBold 22, the cards' 46 px chip height); the cell on screen is filled. One tap flips the list; nothing is sent until a pick. No other app with agents: no pill, Home exactly as today.
2. No Harness window (machine_view): Home goes straight to the app cards, no pill (PM decision 3), after the Notices and Working cards as today.
3. The Apps screen reuses the tab card: one card per app, paged like the tabs: the app's icon (item E, pod_app_style; NULL = name only), its name, the agent count, "N working", "N asking", its agents' marks; the card background is the app's colour (card_top to card_bottom gradient, contrast already checked by item E).
4. Tap a card: send app.pick (pro_cable_send_app_pick, item B) and open its first agent's room; a swipe steps through that app's ring; up from the bottom edge goes Home, on that app's card with Apps selected; Tabs returns to Harness's tabs.
5. Rooms of agents without `v` (ChatGPT/Claude app threads, resting and ended rows): no "tap to talk" hint; a tap shows "See it in <App>" (item B's voice gate already returns it). Copy short; the empty list shows nothing.
6. Every new hit target and draw run inside the frame budgets (192 runs, 32 hits).
Decided by the PM (do not reopen): icons built into the firmware; no pill without a window; custom pets out.

Files you own: firmware/main/pod/home/* (ph_overview.c, a new ph_apps.c if cleaner, ph_agent.c, ph_chrome.c), main/pod/pod_nav.*, main/pod/pod_view.*, main/app/pod_glue.*, test/test_ph_views.c, test/test_ph_glue.c, test/test_pod_nav.c, test/pod_render.c/.py, test/golden.sh, test/golden.txt, test/golden-liberation.txt, test/ph_perf_baseline.txt, and click-through cases in test/test_pro_app.py (B adds wire cases there first; rebase on B). Do not touch main/cable/*, pod_model.* (item B), app_icons.* or the icon generator (item E), or cli/ (item A).

Dependencies: start the brainstorm and spec now. Code against the interfaces fixed in the split doc section 3; start code once item B's pod_model.h lands on main (until then a test-only stub of that header). Item E's app_icons.h can be stubbed the same way if E has not landed.

Tests (no hardware): bash test/run.sh; a click-through test as a person does it (test_pro_app.py + test_ph_glue.c): Home with a window → the pill (Tabs filled) → tap Apps → swipe the cards → tap a card → exactly one app.pick of that app and its first agent's room → swipe through the ring → up from the bottom edge → Home on that card → tap Tabs → the tabs; no window → app cards with no pill; no other app → no pill and no pill hits; a no-`v` room → tap shows "See it in ChatGPT", no voice.begin. pod_render PNGs (720x720) of each new screen as the PR's screenshots; golden.sh --check after recording the new baseline (only for the intended change); PH_PERF=1 test/test_ph_perf.sh within budget. Compile only with ESP-IDF 5.5.4 (`idf.py -B build -DPROJECT_VER=0.0.99-pod build`); PR CI runs the real build and the ota_0 size check.
Hardware: never flash, never run flash.sh/esptool, no idf.py flash or monitor, never open a serial port to a board, never touch Diego's devices. The Pro has a power latch: a wrong-revision image bricks it. No release unless the PM asks Diego.
Platforms: firmware only; host tests on macOS and Linux (CI). The Mac-side behaviour of a pick (bringing the app) is item A's, with its Windows gap.
Rules: English in docs, code and GitHub, Vietnamese with the orchestrator; no screenshots of Diego's screen (pod_render output only); never read another process's environment.
```

### Brief E

```
/devcrew Harness Pro, item E: app icons and card colours built into the Pro firmware. Orchestrator: harness root. Size: full.

Context: docs/plans/2026-11-20-pro-parity-split.md (read it first; sections 2, 3, 5). The Pro's Apps screen (item C) shows each app's real icon and a card in the app's own colour. PM decision: the icons are built into the firmware, generated as the engine logos are (devices/harness-pro/firmware/scripts/pod_gen_logos.py from .github/assets/engines/<engine>.png, 512x512 RGBA, cropped to alpha, LANCZOS, RGB565 + alpha8, no runtime scaling).

Goal:
1. Source art: .github/assets/apps/<id>.png, 512x512 RGBA, one per app id of cli/src/cable/hosts/hostDetect.ts NAMES (orca, herdr, rex, zellij, tmux, kitty, wezterm, iterm, terminal-app, ghostty, cmux, vscode, cursor, warp, claude, codex = ChatGPT, opencode). Skip harness (the Tabs side) and terminal ("Other"). An app with no official icon you can get is left out; it then shows its name only. Record where each icon came from in .github/assets/apps/README.md.
2. A generator firmware/scripts/gen_app_icons.py (Pillow) writes main/pod/app_icons.{c,h}: 72 px and 44 px RGB565 + alpha8 per app, and the card colours, with exactly the API fixed in the split doc section 3 (pod_app_icon_t, pod_app_style_t, pod_app_style(id) returning NULL for an unknown id). Generated files follow the repo's rule for generated sources (check how engine_logos.c is handled: committed generated output, or generated at build like pro_fonts.c, and do the same).
3. Card colour, from the mockup's rule: the icon's largest saturated colour, else its dark mark; darkened only as far as white ink needs 4.5:1 contrast; a black icon lifted to a charcoal; card_bottom is card_top at half its brightness. The mockup's measured values to match: Orca #000000 (lifted to charcoal), VS Code #1F9CF0, ChatGPT #262834, Claude #D97757, herdr #303438.
4. Add the source to main/CMakeLists.txt (one line).

Files you own: firmware/scripts/gen_app_icons.py, .github/assets/apps/*, firmware/main/pod/app_icons.c/.h, firmware/test/test_app_icons.py, one line of firmware/main/CMakeLists.txt; add the new test to test/run.sh. Do not touch main/cable/*, pod_model.* (item B), home/* or golden files (item C), or cli/ (item A).

Dependencies: none; start now. Item C draws with your API (it stubs it until you land).

Tests (no hardware): test/test_app_icons.py red then green: every listed app has both sizes, alpha is non-empty, white text on card_top and on card_bottom is >= 4.5:1 for every app, the mockup's five colours match, the total size stays in a budget (record it; the 44 px engine logos hold 100 KB, test_logos.py:25), pod_app_style of an unknown id is NULL; bash test/run.sh; test_tree_isolation.py. Compile only with ESP-IDF 5.5.4 (`. ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99-pod build`) and record the image size against devices/harness-pro/docs/size-baseline.txt (about 3.98 MB of the 8.26 MB ota_0 today); PR CI runs the real build and the size check.
Hardware: never flash, never run flash.sh/esptool, no idf.py flash or monitor, never open a serial port to a board, never touch Diego's devices. No release unless the PM asks Diego.
Platforms: build-time only; the generator runs with Python and Pillow on macOS and Linux (CI uses Liberation fonts elsewhere; no font needed here).
Rules: no personal content in the assets or logs; English in docs, code and GitHub, Vietnamese with the orchestrator; no screenshots of Diego's screen.
```
