# Harness Player 1

The `dev/firmware-pro` interface for the docked 720 × 720 Pro square unit.
This replaces the Living/character interface. Older images remain separate
rollback versions; there is no on-device interface selector.

## Screens

The library has one header: harnesses, machines, models. Six session rows fit
below it; drag to browse the rest. Status uses the desktop/TUI vocabulary:
cyan braille spinner (10 frames, 100 ms), yellow `?`, green `✓`, red `✗`.
Only visible working sessions animate. Quiet mode and a sleeping display stop
animation.

The detail shows:

- Back chevron at top left; selected provider icon and remaining allowance at top right.
- Session title, then machine, project and branch from the desktop's actual metadata.
- One most recent native action.
- Native working status and observed elapsed time along the bottom.

No voice button, hint, duplicate provider label, turn number, synthetic progress,
explanation, or activity history screen.

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

- `player.overview`: counts, refreshed at most every 30 seconds, valid for 60 seconds.
  Harnesses use the desktop's known-session inventory; machines use its machine
  roster; models count distinct model identities actually reported by those sessions.
- `player.context`: one bounded frame per active-tab session, up to 24. Contains
  session ID, machine, project, branch, engine and remaining allowance with expiry.
  No credentials or account identifiers cross the cable. A bounded LRU keeps
  context while switching tabs and clears on disconnect.
- Remaining allowance uses the existing desktop subscription reading for that
  session's machine/provider and the limiting usage window. It is a percentage
  of provider allowance, not a raw token count. Expired, unknown, or local-model
  readings show `-`; a positive fraction below one percent shows `<1%`.
- `turn.activity`: native status with optional `action` and `elapsedSeconds`.
  Action comes from the latest native tool name/argument; elapsed time comes
  from the actual terminal footer. No generated summaries or invented runtime.
  The elapsed value stops displaying after 25 seconds without a fresh read.
  Remote sessions without this metadata simply omit it.
- An older desktop/CLI still supplies session names, machine and basic status.
  Unavailable fields remain absent. No provider allowance is borrowed from a
  different machine.

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
