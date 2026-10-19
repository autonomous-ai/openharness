# Hackathon samples for the Fo team

October 16, 2026. Design approved in conversation with the owner. For a one-day hackathon on October 17: the Fo
team has round Harness devices and needs to learn the repo and build on it.

## What ships

One folder, `samples/hackathon-fo/`, in US English (code, identifiers and code comments also in English):

```
samples/hackathon-fo/
  README.md               the guide: install, sign in, harnesses, Fo, the device
  01-fo-glance/           sample 1: a firmware screen for the round device, driven by Fo
  02-desk-assistant/      sample 2: new email → Fo → the device
```

No "ideas for later" section. No change to the product: the firmware solution ships as a patch in the sample,
not merged into the firmware.

## The guide (README.md)

Step by step, each step with what you should see and what to do when it does not happen:

1. Install Harness Desktop for macOS (https://harness.autonomous.ai/desktop; Linux AppImage noted; no Windows),
   sign in (Google, Apple or email), and the CLI (`curl -fsSL https://harness.autonomous.ai/install.sh | bash`,
   `harness login`, `harness start`).
2. A harness: **New Harness** (⌘N), machine, folder, engine. Claude Code and Codex must be installed and signed in
   (`claude`, `codex`) first.
3. Fo: Settings ▸ Connectors ▸ **Add custom**, Remote MCP server URL `https://mcp.api.wajo.ai/fo`, sign in to Wajo
   in the browser. Then **New Harness** ▸ Agent **Fo** (runs in Fo's cloud, opens a chat pane) and give it an errand.
4. The round device: USB-C data cable to a Mac running Harness; Devices ("Plug in. Make it yours."), name it. On the
   device: tap a tile to choose an agent, hold the face ~0.65 s to talk and release to send, the recap after a turn,
   the bell for Notices. Gestures as the firmware implements them (touch), not "turn".
5. Common problems: charge-only cable, daemon not running (`harness start`), engine not signed in, Fo not connected
   (`NOT_CONNECTED`).
6. A map of the repo for the samples: where the firmware, the daemon (`cli/`), the Desktop and the docs live.

## Sample 1 — Fo glance face (`01-fo-glance/`)

A firmware UI change on the round device, so the team builds, previews and flashes firmware.

- **Warm-up: a theme.** A build flag `DEVICE_HABITAT_FO` on the pattern of `DEVICE_HABITAT_ORANGE` (`theme.h`,
  `main/CMakeLists.txt`): Fo colours for the canvas, accent, working and voice.
- **Main exercise: the glance screen.** When an agent's recap is a glance line, the device draws a glance screen
  instead of the recap card:
  - Line format (case-sensitive, one line, the whole recap or its first line):
    `GLANCE applied=5 replies=2 interviews=1 goal=10` — up to 4 `key=value` pairs, keys `[a-z]{1,12}`,
    values unsigned integers ≤ 9999; unknown keys shown as-is; `goal` is not shown as a number but drives the ring.
  - The screen: the agent title arc as today, three numbers big with their labels, and a ring around the edge
    (`ht_ring_arc`) filled `applied / goal`. Malformed lines fall back to the ordinary recap card.
  - Data reaches the firmware the way recaps already do (the daemon's `summary` frame); no daemon change.
- **Tooling:** `preview.sh` renders the Working, Recap and glance screens to PNG with the host renderer
  (`test/test_touch_ui.py`, `HABITAT_PREVIEW_DIR`), no device needed. A host test for the glance parser.
- **Build and flash:** ESP-IDF install note (start early), `idf.py -DPROJECT_VER=0.0.99 -DDEVICE_HABITAT_FO=1 build`
  (0.0.99 so the daemon's OTA never overwrites it), the safe sequence (quit the app, `harness stop`, flash with
  `idf.py -p <port> flash`, `harness start`), and back to the release with `harness flash`.
- **Folder:** `README.md` (the exercise with pointers to the exact files and functions), `preview.sh`,
  `solution.patch` (theme + glance, applies cleanly to main with `git apply`), and `fo-prompt.md` (what to tell Fo
  so its replies end in a glance line).

## Sample 2 — desk assistant (`02-desk-assistant/`)

- `mail_to_fo.py`, Python 3 standard library only: IMAP over TLS (Gmail with an app password), polls every 30 s,
  takes new unseen messages from one folder, and hands each to one long-lived Fo harness named "Fo inbox"
  (created on the first email, written to afterwards). The text sent: sender, subject, a plain-text body cut to
  2,000 characters, and the instruction to summarise it in one sentence and say what to do; job-search mail also
  updates the glance line of sample 1.
- Fo's reply ends its turn, so the device beeps and files a notice with the recap; a Fo question appears on the
  device's question screen.
- Config in `.env` (`IMAP_HOST`, `IMAP_USER`, `IMAP_APP_PASSWORD`, `IMAP_FOLDER`, `POLL_SECONDS`). It stores no
  mail on disk, only the UIDs it handled (`state.json`). It does not mark mail read unless `--mark-read`.
- `--engine claude` sends the same text to a local Claude Code harness instead, for when Fo is unavailable.
- How it reaches Fo: verified against the running daemon during implementation — `harness new fo -- <text>` /
  the local WebSocket requests `agent_create {engine:'fo', prompt}` and `cloud_send` — and the README documents the
  one that works. Unit tests for the mail-to-text step (HTML stripped, length cut, headers decoded).

## Verification

- Sample 1: `solution.patch` applies to main; the host tests pass; `preview.sh` renders the three screens; an
  `idf.py` build with the flags succeeds. Flashing to a device is documented; it is done only if a round device
  is connected.
- Sample 2: the unit tests pass; a run against a real mailbox sends a test email into Fo and its reply shows on the
  device (or, without a device, in the Fo pane).
