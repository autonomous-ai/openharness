# Harness Player 1

The `dev/firmware-pro` interface for the docked 720 × 720 Pro square unit.
This replaces the Living/character interface. Older images remain separate
rollback versions; there is no on-device interface selector.

## Screens

The library shows the same known-session inventory as the desktop's New Tab
list, across every machine. Completed, idle, paused and terminal sessions stay
visible. Six generous rows fit at once; vertical dragging pages through the full
inventory, with no 16- or 24-session cutoff. Each row has the engine logo, a 42 px
session name, a status mark and a 32 px relative time. The header reads
“Library” and “30 sessions across 4 machines.” Counts are live, not defaults.

Time follows the New Tab list's last-use timestamp (the later of actual activity
and a recorded open/focus), never registry polling. It reads `now`, `2m`, `1h`,
or `3d`; missing time reads `-`. Status uses cyan working braille (10 frames,
100 ms), yellow `?`, green `✓`, red `✗`, pause bars, an idle dot, and an offline
dash. Only visible working rows animate; quiet mode and sleep stop animation.

The detail shows:

- Back at top left; provider icon and reported remaining allowance at top right.
- A 56 px session title, with machine / repository and branch at 32 px below it.
- The latest assistant-authored progress paragraph at 42 px. A pending question
  takes priority; after completion, the latest result takes its place.
- A separate 32 px working/finished/waiting footer and observed elapsed time.

A milestone such as “CI passed for the integrated head too” can be displayed
while the footer still says Working. Tool commands do not replace that update.
Text wraps within measured bounds, including long titles and branch names.

## Gestures

| Surface | Action | Result |
| --- | --- | --- |
| Library | Tap a row | Select its session |
| Library | Drag vertically | Browse sessions |
| Detail | Tap the body | Start voice; tap again to stop |
| Detail | Swipe horizontally | Switch desktop panes |
| Detail | Drag vertically | Scroll desktop pane content |
| Library or detail | Hold | Open the tab switcher |
| Detail | Tap back | Return to library |
| Tab switcher | Tap a tab | Switch desktop tabs |
| Tab switcher | Settings | Open operational controls |
| Pending question | Review | Open the existing explicit answer flow |

Reading a question is not approval. Navigation targets retain their own actions;
the session body owns voice. Existing source checks on review, selection, draft,
and question submission are preserved.

## Data contract

The matching development desktop and CLI supply optional additive cable data;
this firmware work does not install either shared application.

- The development desktop exports `overview.sessions` and context for its entire
  known inventory in `app_swarms`, including closed panes. It uses the existing
  New Tab ordering, lifecycle, question and machine state. Changes are coalesced
  within one event-loop turn and skipped when the inventory is unchanged. Account/window disconnect clears the export through the existing
  socket lifecycle.
- A square advertises `hello.player: "library-v1"`; the matching bridge advertises
  `player.library` in `welcome.features`. Round devices keep their tab roster.
- `player.library.get {offset, request}` requests six lightweight rows. The reply
  is `player.library {request, offset, total, machines, rows}`. Each row contains
  `id`, `machineId`, `name`, `engine`, `status`, and `ageSeconds` (`-1` if unknown).
  Offsets clamp at the last full six-row page. Empty inventory has zero rows.
  Each frame is bounded below 8192 bytes, with UTF-8 byte limits matching the MCU.
  Metadata changes push immediately on the next bridge tick, otherwise at 10 s.
- The device holds only six lightweight rows; the existing 16 conversation slots
  and history restore path are unchanged. Old page responses are rejected by
  request ID; a tap pins the page revision, session and machine. Refreshes do not
  replace a stationary finger's target. A missing response retries after 3 s.
  Off-tab picks use the existing identity-checked visit/open flow before voice
  can target the new session. Reading a row does not approve a question.
- `player.overview` retains counts and its 60 s validity. `player.context` sends
  context only for active panes/focus, selected from the complete host inventory;
  the device's 24-entry LRU clears on disconnect.
- Remaining allowance uses the existing machine/provider-specific subscription
  reading and expiry. Unknown or expired readings show `-`, with `<1%` preserved.
- `turn.activity.action` now carries a literal assistant-authored paragraph;
  tools remain separate from this text. Local reads use the transcript mirror;
  remote progress rides an additive `update` on existing processing heartbeats
  from a matching CLI. Completed results use the existing summary path.
  `elapsedSeconds` is still read from the native terminal footer and expires
  after 25 s without a fresh observation. An unreported remote timer is omitted.
- Full inventory and context require this branch's desktop and CLI as well as the
  firmware. Older hosts retain their existing tab-only roster; they cannot supply
  fields they do not know. This change does not install the shared desktop/CLI.

## Build and verify

Follow [the development boundary](../../development/README.md). Use ESP-IDF
v5.5.3, `esp32p4`, a dedicated build directory, and the existing Pro dock-only
profile. The guard labels firmware `0.0.0-dev.<commit>` (`-dirty` before commit).
Keep `Harness-Player-1` in artifact filenames to distinguish this design.

Generate proportional fonts with `tools/generate_fonts.py` and icons with
`tools/generate_player_icons.py`. The latter reuses the desktop Codex asset,
Claude mark geometry, pinned Lucide back icon, and desktop braille frame order.
See [Lucide's license](PLAYER-ICONS-LICENSE.txt).

Run native production-handler replays:

```sh
python3 devices/harness-device/firmware/test/test_pro_touch_ui.py
python3 devices/harness-device/firmware/test/test_pro_controls.py
# With IDF_PATH set to the pinned SDK (real cJSON decoder):
python3 devices/harness-device/firmware/test/test_pro_player_library.py
```

Set `HARNESS_PLAYER_PREVIEW` to an existing output directory to export real
720 × 720 raster fixtures, including all ten working frames. Fixture values
(such as 37 / 7 / 6 and 23%) are illustrative, never device defaults.

A build is not a hardware installation or microphone validation. Before any
flash, run the development target check, identify the exact MAC and chip, and
retain the verified earlier app image. Record source commit, binary SHA-256,
MAC and boot result for each installation. Preserve NVS and partition settings.
Never publish this image through the production updater.

The earlier companion implementation and installation notes are archived in
[LIVING-HISTORY.md](LIVING-HISTORY.md).

## Pod build

Pod replaces Player 1 on the Pro (design: `docs/superpowers/specs/2026-10-10-pro-pod-design.md`). It is the same
firmware with two more cmake options: `-DDEVICE_POD=1`, and `-DPOD_PANEL_TURN=180` for the unit whose panel is
mounted upside down (it turns the picture and the touch together; leave it off otherwise). Pod needs the generated
fonts but not the Living or Daemon art, so `pro_art.pack` and `pro_living.pack` are neither required nor linked.
Use ESP-IDF v5.5.4 (the version that boots the P4 rev v3.2 here) and a dedicated build directory:

```sh
. ~/esp/esp-idf-5.5.4/export.sh
cd devices/harness-device/firmware
idf.py -G 'Unix Makefiles' -B build-pod \
  -DIDF_TARGET=esp32p4 \
  -DSDKCONFIG=build-pod/sdkconfig \
  -DSDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.defaults.esp32p4;../prototype/pro-companion/sdkconfig.defaults;../prototype/pro-companion/sdkconfig.wifi.defaults' \
  -DDEVICE_HABITAT=1 -DDEVICE_PRO_COMPANION=1 -DDEVICE_PRO_WIFI=1 -DDEVICE_POD=1 -DPOD_PANEL_TURN=180 \
  -DDEVICE_DEFAULT_CHARACTER=tim \
  -DPROJECT_VER=0.0.99-pod \
  -DCCACHE_ENABLE=0 build
idf.py -B build-pod size        # the app must fit the 0x7E0000 slot
```

Host tests: `bash devices/harness-device/firmware/test/run-pod.sh` and
`python3 devices/harness-device/firmware/test/test_pod_touch_ui.py`.
