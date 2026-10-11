# Harness Pro notifications: plan

Owner decisions (2026-10-11):
- Banner A1 and bell B1 from `devices/harness-pro/mockup/pro-notify.html`.
- The bell opens a simple Inbox list.
- The Sound setting is the app's existing per-device toggle (`muted`).
- Beep only when a new notification arrives.
- Keep it small and simple.

Risk: normal.

## Protocol

The daemon already sends all of these. The Pro handles them as the round dial does (`devices/harness-device/firmware/main/cable_client.c`).

- **`summary {agentId, recap, text, quiet?, silent?, restore?, full?}`**
  - A summary that is not `silent`, `quiet` or `restore` creates a notification: banner, unread entry and beep.
  - `quiet` (the app already shows the agent) and `restore` create nothing new.
  - `silent` (a sub-agent) is ignored here.
- **`notif.replace {items:[…]}`** is the whole unread list, sent on greeting.
- **`notif.seen {agentId, readToken?}`** means it was read elsewhere, so the entry is removed.
- **`notif.read {agentId, readToken?}`** goes from device to host when an entry is read on the Pro, either by tapping the banner or an Inbox row, or by opening that agent.
- **Settings.**
  - `hello` carries `settings`. The app parses it only when every field is present: brightness, character, face, voiceLang, muted, quiet, straightTitle, focusFace, scrollReversed and round.
  - The device handles `settings.set` and answers with `settings.state {ok, settings, error?}`.
  - The Pro keeps `muted`, `brightness` and `voiceLang`.
  - It reports fixed values for the round-only fields and refuses changes to them (`ok: false`, an error message, the values read back).

## Tasks

1. **Speaker beep.**
   - Files: `main/audio/*`, plus `app_main.c` if needed.
   - Port the round's ES8311 output and beep task: 3 tones of 80 ms at about 2 kHz, with 60 ms gaps.
   - API: `void audio_beep(void)`. It never blocks the caller and is skipped while a recording is open.
   - Check: build clean, and one beep on the device at boot behind a temporary flag, removed afterwards (the lead verifies by ear).
2. **Settings.**
   - Files: `main/sys/config_store.*`, `main/cable/pro_cable.c`, `main/app/pro_app.c` (applying brightness), `test/test_pro_cable.c`, `test/test_pro_hello.py`.
   - `muted` and `voiceLang` go in NVS next to brightness.
   - Hello carries the full settings object; `settings.set` and `settings.state` work as above.
   - Tests:
     - the hello settings parse with the app's rule (all keys, the right types);
     - a set of `muted` round-trips;
     - a set of a round-only field is refused, with the values read back.
3. **Notifications and UI.**
   - Files: `main/pod/pod_model.*` (unread list, at most 16, by agent), `main/cable/pro_cable.c` (summary flags, `notif.*`), `main/app/pro_app*.c` and `pod_glue.*`, `main/pod/pod_nav.*` (a new `POD_V_INBOX`), `pod_chrome.c` (the bell pill in the status bar), a new `pod_view_inbox.c`, and the banner in the glue overlay.
   - Banner:
     - 6 s, one at a time, a newer one replaces it;
     - a tap opens the agent's Recap and marks it read;
     - a swipe up dismisses it;
     - never while Talk is open (the entry still lands in the Inbox).
   - Bell: shown when unread > 0, on every screen with a status bar. A tap opens the Inbox.
   - Inbox: the Tab list's rows (chip, name, the recap's first line, age), newest first.
   - Beep on a new entry when not muted.
   - Tests: model, nav and views. The golden screens stay as they are while unread is 0; add new screens for the banner, the bell and the Inbox.
4. **App card.**
   - Check what `desktop/lib/settings/sections/cabled_device_card.dart` and `devices/device_settings.dart` show for a `board: "pro"` device.
   - Hide the round-only rows (Faces, character, Still companion, straight title, focus face) for the Pro.
   - The desktop tests for that card must pass.

Each task ends with:
- `test/run.sh` passing with both fonts;
- `golden.sh --check` matching, or new screens with a reviewed reason;
- a clean build.

Then an Opus review, then flash, then the owner's acceptance. No commit or push.
