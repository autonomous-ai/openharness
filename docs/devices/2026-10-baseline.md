# Device baseline, October 2026 (round dial and Harness Pro)

Status: **first pass, from logs only.** Every number below comes from the cable logs the daemon already
writes on Diego's Mac (`~/.harness/logs/usb-<MAC>/dial-*.log`, 2026-09-22 to 2026-10-29) or from
sampling the running daemon. No device was flashed, opened or touched. The live tests that need a
person at the desk are listed in [Still to measure](#still-to-measure) and fill the empty cells.

Measure only: nothing here is fixed. The first fix groups are proposed at the end.

## Devices seen on this Mac

| Device | MAC | Hardware | Firmware seen | Last seen |
|---|---|---|---|---|
| Round dial (Diego's) | 28:84:85:90:63:E8 | cst9217 + axp2101 | 0.0.92 to 0.0.99 | 10-29 11:02 UTC |
| Round dial | 28:84:85:55:1F:E4 | cst9217 + axp2101 | 0.0.91 to 0.0.99 | plugged in now |
| Round dial (older board) | 68:EE:8F:52:B0:2C | cst816s | 0.0.94 | 10-29 10:58 |
| Harness Pro | E8:F6:0A:E7:64:61 | harness-pro | 0.0.87 to 0.1.13-swarmcard3 | 10-23 |
| Harness Pro | E8:F6:0A:E7:63:7D | harness-pro | 0.0.86 to 0.1.9 | 10-16 |
| Harness Pro | E8:F6:0A:E7:64:86 | harness-pro | 0.0.99-pod to 0.1.13 | 10-22 |

Older round boards (90:70:69:…, 80:45:6B:…) appear for a few minutes each in September and early
October and are left out. Dev builds (`-pod`, `-swarmcard…`) are included where they are the newest
Pro firmware that ran; numbers for them say so.

## Measured table

"Round" is fw 0.0.99 on 90:63:E8 and 55:1F:E4. "Pro" is the newest 0.1.x builds on the three Pros.

| Metric | Target | Round | Pro | How it was measured |
|---|---|---|---|---|
| Press to response | < 200 ms | pending | pending | Not in today's logs (neither firmware logs a touch-to-draw time). Needs the slow-motion video test. |
| Voice to chat | < 2 s | pending | pending | The daemon logs when a clip reaches it ("→ stt"), not when the text is posted. Needs the live voice test. |
| Slowest frame since boot | ≤ 33 ms (30 fps) | 27 to 32 ms: meets | 20 to 24 ms on 0.1.10 to 0.1.13-supertab; **45 ms on 0.1.13-swarmcard3: misses** | `frame_max_us` in the device's `alive` line. This is the single slowest frame since boot, not a sustained rate while scrolling. The sustained rate needs the scroll test. |
| Plug-in to ready (power on) | < 5 s | 2.5 to 4.5 s on 90:63:E8; **8.7 to 11.8 s on 55:1F:E4** (3 boots) | 2.0 to 3.8 s on 18 of 24 boots (0.1.x); 6 slower: 6.0 to 14.2 s, and one 106 s | Device uptime at "session up" after a power-on reset. |
| Ready after a USB reset | < 5 s | 6.2 to 7.1 s (90:63:E8). The 10.5 and 13.8 s resets of 55:1F:E4 on 10-29 were flashes, not plug-ins | 4.7 to 9.4 s (0.1.x) | Same, after a reset over USB (flasher or serial-line toggle). |
| Reconnect, port back to ready | < 2 s | 30 ms median, 941 ms worst | 40 ms median, 1.6 s at p90, 8.9 s worst (all firmware) | Daemon "open on" to the device's "session up". The live unplug test will time the full replug. |
| Reconnect after a daemon restart | < 2 s | about 2 s to first fresh data; 10 restarts on 10-29 on Diego's dial | (no Pro plugged in on 10-29) | Daemon reopened the port with no unplug; first frame after it. |
| Longest run without a crash | 24 h | 13.7 h (55:1F:E4), 7.6 h (90:63:E8), both ended by a replug | 8.9 h (64:61) | Longest uptime in `alive` lines. The live 24 h run has not started: 55:1F:E4 was reflashed at 12:13 UTC on 10-29. |
| Memory creep | none | none: internal heap flat (129,299 B over 13.7 h); PSRAM down 11 KB over 7.6 h on 90:63:E8 | none: heap flat over 8.9 h | Free heap and PSRAM in `alive` lines across the longest run. |
| Crashes | 0 | 0 panics, 0 watchdog resets in 6 weeks | **8 watchdog resets on 0.1.7 to 0.1.13 (10-15 to 10-23, all 3 units)**; 64 panics and 20 watchdog resets on the 0.0.86, 0.0.98 and 0.0.99-pod dev builds (10-09 to 10-19) | Reset reason at boot. |
| OTA time | (none set) | 13 to 15 s (3 updates) | 6 to 11 s (10 updates) | Daemon "offering firmware" to the device's "written and verified". |
| OTA failure and rollback | rolls back | no failures seen | 24 failed updates on 10-11 (19 stalled, 3 flash write, 2 wrong product), all left the old image running; 3 bad images refused on magic byte | Device `fw:` and `esp_ota_ops` lines. A live failed-update test waits on Diego's yes. |
| Daemon CPU, device plugged in | (none set) | pending | pending | The first 10-minute sample was void: the daemon was stopped during it so the dial could be flashed. To be redone. |

## Ranked bug list

Ranked by how much a buyer would notice it, then by how often it happens on current firmware.

### 1. Pro resets itself by watchdog every few hours (current firmware)

- **Seen:** 8 resets on 0.1.7, 0.1.9, 0.1.13-supertab and 0.1.13-swarmcard3, on all three Pros,
  10-15 to 10-23. On 10-23 the Pro at 64:61 reset after 2 h 24 min, then again 6 s after it came back.
- **User impact:** the screen goes black and the Pro reboots (about 3 s), losing whatever was on screen.
- **Root cause:** not found. The reason is a plain `WATCHDOG` (`ESP_RST_WDT`), not the task or interrupt
  watchdog. Those two are set to panic with a backtrace (`sdkconfig.defaults`), and there is no
  backtrace. The boot crumbs show the cable and render tasks both last alive at the same millisecond,
  so the whole chip stopped, not one task. In the 10-23 case the last words end with a 10 s voice
  recording, an I2S "already enabled" error, then nothing for 50 s.
- **Repro:** none on demand yet. The 24 h Pro run with voice use is the test.

### 2. One round dial takes 9 to 14 s from power on to ready

- **Seen:** 55:1F:E4 after a power-on: 8.7, 10.6 and 11.8 s (fw 0.0.91, 0.0.93, 0.0.94); once 2.5 s.
  Diego's dial: 2.5 to 4.5 s.
- **User impact:** after plugging in, the dial shows its boot screen for 10 s or more. Target is < 5 s.
- **Root cause:** not found. The dial is sending from about 0.5 s after boot (the daemon finds that
  boot text waiting in the port buffer), but the daemon only opens the port about 10 s later. Two Harness
  daemons run on this Mac (one per macOS user, `duynguyen` and `harnessteam`), and both watch USB
  ports, so the other one may hold the port first. Its logs are not readable from this account. A
  flasher holding the port gives the same picture. The two USB resets of 10-29 (11:49 and 11:55 UTC,
  10.5 and 13.8 s) were dev flashes from a session outside the Swarm, which is why they are left out.
  Whether the three power-on cases were flashes too is not known.
- **Repro:** power-cycle 55:1F:E4 and read the device uptime at "session up" in its log.

### 3. Pro firmware update can stall over and over, and two daemons can fight over a device

- **Seen:** 10-11 on the Pro at 63:7D: 19 "firmware transfer stalled", 3 "flash write failed",
  2 "image is for another product", then 275 "has taken 3 firmware writes this hour, holding off". The same day
  the daemon released that port 3 times as "not a Harness dial".
- **User impact:** an update that never finishes. The hourly cap held, and the old image kept running.
- **Root cause:** partly known. The pattern matches the case `mayOffer` in `cli/src/cable/cableSession.ts`
  describes: two daemons that disagree about who owns the device take turns writing it. That day was a
  dev-flashing day, so it may not be a buyer's case. The live OTA test will tell.
- **Repro:** pending (needs a device on firmware older than the published one).

### 4. Swarm data dropped when it does not fit one cable frame (Pro)

- **Seen:** 191 times on the Pros (10-11 to 10-23): 128 "member names dropped", 63 "tiles dropped,
  selected tab only".
- **User impact:** the Pro shows fewer Swarm tabs or tiles than the desktop does.
- **Root cause:** known. `swarmsMessage` in `cli/src/cable/cableSession.ts` trims to fit the cable payload cap
  and the firmware's 480-token JSON guard. With 6 or more Swarms it falls back to the selected tab only.
- **Repro:** an account with 6 or more Swarms with several members each, Pro on the Swarm card.

### 5. Audio driver enable/disable errors on every recording (both devices)

- **Seen:** `i2s_channel_disable: the channel has not been enabled yet` and
  `i2s_channel_enable: the channel has already enabled` around recordings, on Pros and on Diego's
  dial as late as 10-29.
- **User impact:** none seen directly. The audio is still delivered in full (produced = delivered,
  0 overruns). Worth checking alongside bug 1, whose last words end in this error.
- **Root cause:** the record path disables a channel it never enabled, and enables one already on.
- **Repro:** any voice recording; read the device log.

### 6. Crash logs repeat old crashes inside new ones (both devices)

- **Seen:** every boot replays the previous boot's last words inside its own, up to 5 levels deep
  (`boot: last: W boot: last: W …`): 6,291 replayed lines in these logs, almost all from the Pros.
- **User impact:** none for the buyer. For us: the second watchdog of 10-23 cannot be told apart from
  the first, and crash reports carry stale crashes.
- **Root cause:** found. `last_words_report` replays the old lines with `ESP_LOGW`, and that log goes back
  into the fresh ring (`last_words_add`). When the next abnormal reset comes within the ring's 4 KB, the
  replay is replayed again. Same code in both firmwares (`main/sys/last_words.c` on the Pro,
  `main/last_words.c` on the round).
- **Repro:** reboot any device twice and read the log.

### 7. Machine rows dropped (Pro, round)

- **Seen:** 240 "machine row dropped" lines on the Pro at 63:7D, a few on the others.
- **User impact:** a computer may be missing from the device's machine list.
- **Root cause:** not checked yet.

### Known, fix already in review

These come from Diego's reports on 10-29 and already have PRs: #2179 (a swipe on a one-project Swarm
picks the same project again), #2189 (after a reconnect the dial falls to TABS and stays there),
#2204 (the dial stays on the Swarm face when the desktop goes to another tab), #1774 (device voice into
the Swarm chat). Open issue #1129 asks the device to show readable latest content instead of raw CLI
output. There are no other open device issues on GitHub.

## Still to measure

These need Diego (asked through the Lead on 10-29):

1. Plug a Pro in and leave it and the round dial in for 24 h: Pro 24 h run, Pro daemon CPU, two
   devices at once.
2. Unplug and replug each device 3 times: full plug-in-to-ready and reconnect.
3. Swipe and scroll on each: sustained frame rate.
4. Speak to a Lead card 3 times: voice to chat.
5. Slow-motion video of 10 taps: press to response.
6. Mac sleep and wake; Wi-Fi off and on: sleep/wake and network loss.
7. Move the round dial to another Mac and back: switching computers.
8. OTA and rollback on failure: waits on Diego's yes. This means flashing his dial back to the
   previous published round build by the repo procedure, letting it update, and unplugging once
   mid-update.

## Proposed first fix groups

1. **Pro watchdog reset** (bug 1, with bug 5 as a lead). Get a backtrace first: make the hang panic
   with a core dump instead of a silent reset. Then fix. Owns `devices/harness-pro/firmware`.
2. **One daemon per device on a shared Mac** (bugs 2 and 3). Confirm the second daemon holds the port.
   Then make the daemon that does not own a device let it go at once. Owns `cli/src/cable`.
3. **Swarm frame fits** (bug 4): send Swarms in pages, not one frame. Owns `cli/src/cable` and the
   Pro's cable reader.
4. **Clean crash logs** (bug 6): small, firmware only, on both devices. Do it before the 24 h runs
   so their crashes read cleanly.

## Design

N/A because this is a measurement report. It stores, syncs and exposes no data.
