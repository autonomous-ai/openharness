# Harness Pro · Take a little company

A connected prototype of the **Field companion** selected from page 06 of the
[concept gallery](../pro-concepts/README.md): a solid purple octopus living in a
green landscape. The init collection now adds GNU, Lynx, Mutt, Yak, Gopher,
Bug, Tux, Auk and Beastie through the same character interface. The Pro uses
the shared Habitat application and cable
protocol, with a new square-screen presentation. Its live contents come from
Harness; this is no longer the swipe-only concept slideshow.

The home screen stays simple: workspace above, creature in the middle, selected
pane and activity below. A summary or carried passage makes the creature small
and gives the text a paper surface. Central tap behavior stays the same.
The workspace is subdued and the selected pane leads at 42 px, falling back to
32 px when its measured name needs more room. Idle and completed work have
short status lines. Paper remains an optional saved scene; its preview does
not change the default or the person's scene preference.

While the selected pane is working, its activity line includes a quiet elapsed
time. This is time since the device observed the current busy spell, not engine
compute time or a Goal/Loop duration. Switching panes preserves each live
observation; connection or host loss, a changed session, cancellation and a
25-second heartbeat gap end it. Questions, carried text, speech and errors keep
their status precedence. Resting the display hides the clock without pausing
work observed from the host.

Home's Updates control opens the retained answer first, then a question that
still needs a response. Reading a question does not remove that need. These
local cards leave desktop focus alone. In the output reader, Select output
fetches the current terminal selection for the pinned, currently selected pane;
it never maps old summary text to live terminal lines. If that pane is no longer
selected, use Open on desktop explicitly before selecting its output.

The Pro is now **strictly dock-only**, by the user's 2026-09-29 decision to
remove the battery. The workspace footer stays in place whether the app is
connected or offline. There is no layout switch, portable mode, battery meter
or runtime estimate. Normal operation needs no connection badge; connection
guidance appears only when the app is unavailable.

## Language

Open **Menu → Language** and choose **English** or **Tiếng Việt**. The choice
changes the built-in Pro interface immediately and the recognition language for
the next voice recording. It is saved on the device and survives restarts.
Vietnamese uses accented glyphs at every Pro font size. Agent/workspace names,
messages, results and the words in saved voice recordings keep their original
language. The picker is available offline; a failed save offers a retry.

## Trial status

Current development lives on **`dev/firmware-pro`**, separate from Diego's
production firmware and `dev/firmware-round`. The new development Pro ending
**64:67** adds **Menu → Voice**: 16 offline ElevenLabs recordings, Params notes,
Play/Stop, Previous/Next and live volume buttons starting at 80%.
See [the sample library](voice-samples/README.md) for controls, model parameters,
storage and checks. This menu does not change the desktop voice configuration.
The installation history below describes the earlier Pro ending 64:61.

Source base: `59ce00535b5fd6ecb06e3bc0b41e46c8ae0e76a3`. Work is isolated on
`prototype/pro-concepts-20260929`. A separate illustrated Tim adapter is documented in
[the round artwork prototype](../tim-illustrated/README.md).

The installed image is **`0.0.87-pro.companion.12`**, with ten swappable daemons
and four independent scenes, on identified Pro `E8:F6:0A:E7:64:61`. The app-only
installation verified the flash digest, healthy boot, unchanged saved settings
and unchanged desktop bridge. The `.11` application is backed up for rollback.
See [the collection contract](DAEMONS.md) and
[collection validation](DAEMONS-VALIDATION.json).

The desktop handshake reports `.12`; at 120 seconds the Pro was receiving live
pane data with 212 rendered frames, zero touch-read failures and no unexpected
resets. Observed maxima were 21.7 ms raster, 22.8 ms frame, 49.7 ms preparation
and 72.5 ms total render. These maxima include startup and do not establish
touch-to-screen latency; the recorded sample contained no physical touches.
The image preserves PCM speech playback and the opt-in ESP-Hosted Wi-Fi driver.
Wi-Fi starts after essential task stacks are reserved and app_main releases
its stack, including on boots with saved credentials.

The companion leaves GPIO1's battery supply latch low from startup. It does
not allocate the battery ADC, poll the charger, or accept the former USB
battery diagnostic. The side button retains tap-to-back/stop and a 0.8-second
hold to toggle the screen. Holding longer never parks the button task or
powers off the docked device. Its debounce and noise quarantine remain.
The legacy battery driver is retained only for other Pro firmware builds.

Earlier battery trials on `.9` and `.10` failed to keep the screen running
when undocked. That investigation is closed by the dock-only product decision;
its historical measurements are retained in `VALIDATION.json`. Physical
battery removal is a hardware change, not something this firmware verifies.

Initial voice trials were too quiet and the first voice was rejected as boring.
The selected voice is now **Octo - Spark**, with expressive delivery and louder
host PCM. The amplifier readback confirmed PA enabled and DAC powered/unmuted.
The requested replay through the production speech controller sent all 225,280
bytes (7.04 seconds) through I2S at **volume 90** with error zero. New replies
also default to 90. Speaker readiness and per-chunk receipts protect the audio
transfer; a raw serial test without those acknowledgments dropped packets.
Counters establish transfer, not acoustic quality; the listener still judges
the new voice's clarity, loudness and character.

Native interaction, compositor and layout checks passed. Physical ergonomics,
microphone quality and the complete user voice interaction still need the
person holding this Pro to review them. A clean boot and incoming desktop data
do not establish those qualities.

## Use it

| Where | Gesture or action | Result |
| --- | --- | --- |
| Home | Tap the creature or central summary area | Start voice for the selected pane |
| Home | Swipe left or right with one finger across the center | Change the selected open agent pane |
| Home | Swipe horizontally with two fingers together, then release | Change to the adjacent workspace; no wrap at either end |
| Home | Drag up or down across the center | Scroll the selected desktop terminal; release can continue with inertia |
| Home, while scrolling coasts | Tap | Stop that scroll; a subsequent deliberate tap starts voice |
| Home | Hold the creature, or tap Menu | Open Menu |
| Menu | Instruct | Choose Task, Goal or Loop for the selected pane, then Speak |
| Menu | Today, on compatible hosts | Read this computer's local daily usage estimate; Refresh requests a new reading |
| Home | Tap the workspace name | Open Tabs |
| Home | Tap the bottom pane/activity area | Open Panes |
| Panes | Map / List | Switch between the host's pane geometry and a readable list, without moving desktop focus |
| Panes map | Tap a named, large enough pane | Focus that exact pane; small or unresolved rectangles stay inert |
| Side button | Tap / hold at least 0.8 seconds | Back or stop / toggle the screen |
| Listening | Tap the creature | Finish capture and send through the existing voice route |
| Listening | Hold and release, or tap Review first | Read the transcript before sending, when the host supports drafts |
| Goal or Loop listening | Finish capture | Review the transcript, then explicitly Send |
| Listening or processing | Discard / Stop sending | Cancel the pending voice operation; cancellation is not an undo for a message already delivered |
| Speaking | Touch the screen | Stop speech immediately; a deliberate central tap starts voice again |
| Home with a result | Tap Read | Read more of that result on the Pro |
| Home with a question | Tap Answer | Read the question, choose or speak an answer, review, then explicitly send |
| Menu | Panes / Tabs / Updates / Read / Daemon / Scene / Machines / Controls | Open the named sheet |
| Daemon or Scene | Swipe horizontally, or tap Previous / Next | Preview locally; desktop focus and saved preferences stay unchanged |
| Daemon or Scene | Use / Back | Save the chosen appearance / cancel the preview |
| Tabs | Swipe the workspace card, then tap the chosen card | Browse first; the tap switches and returns to that workspace's companion |
| Updates | Swipe | Browse updates without moving desktop focus |
| Updates with a question | Answer | Read and answer that question locally; the home recipient and desktop focus stay in place |
| Updates with an unconfirmed answer | Review answer | Reopen the retained answer and delivery state, even if its original alert has disappeared |
| Unconfirmed answer | Swipe / Close | Read the retained answers; Close removes only the local copy and unblocks other questions, without resending or acknowledging the host |
| Updates or Read | Open on desktop | Open that exact pane; compatible hosts preserve the previous reading place for Return |
| Home after a supported visit | Return | Ask the app to restore its saved pane and reading position |
| Reading, question or draft sheets | Drag vertically | Read the local text or advance its choices/parts, rather than scrolling the desktop |
| A list or form | Drag vertically, then tap a choice | Browse and activate the chosen item |

The two-finger gesture reads all five GT911 contacts and tracks their IDs. Both
fingers must travel at least 96 pixels horizontally together, with bounded
vertical movement. A second finger cancels the pending one-finger action;
extra fingers, invalid samples, sleep and context changes consume the remaining
contact. It is disabled in sheets, recording and composition. The pinned
Espressif GT911 1.2.1 driver exposes these contacts, but this gesture has only
native replay and target-compile validation until it is tried on the physical
Pro. The driver reports invalid controller counts above five as an empty sample;
the public API cannot distinguish those malformed reports from release.

Map rectangles come from the selected workspace's normalized host layout.
Missing, stale or overlapping geometry uses the list. Tiny panes remain an
overview; crowded layouts default to the list, which always retains the full
current roster. No synthetic geometry or enlarged overlapping hit targets are
used.

Rapid repeated taps are guarded across voice transitions. A swipe cannot turn
into a send or approval when the finger lifts. Every reading sheet has a title
and Back; it is visually distinct from home.

The creature holds a letter while updates remain unread. Fresh updates get a
brief delivery reaction; restoring notification history does not replay that
reaction. Updates become read only after their content reaches the display.
Reading is separate from **Open on desktop**, and reading a question never
answers it.

Question choices and speech stay pinned to the reviewed question's identity and
token. A disconnect or missing receipt leaves the answer visibly unconfirmed;
the device does not resend it. Updates retains a local Review answer entry even
after an empty notification replacement. The read-only view lets you scroll through
the retained answers, check them in Harness, or explicitly Close the local copy to
unblock other questions. Close never removes or acknowledges the host's alert, and
cannot apply to a replacement question. Pending answers without uncertainty remain
protected. A matching receipt, close event or replacement question keeps its existing
authoritative behavior. A freshly read, already-submitted question may have no saved
answer text on the device; the recovery view says so.
Opening in the app is a separate, deliberate action. Older hosts use a plain
open without a Return promise. A closed pane, pruned reading position or timed-out
visit reports the host's limitation instead of claiming exact restoration.
These paths have native handler and renderer replay coverage; live app bookmark
restoration and physical voice use remain device-trial checks.

## Connected features

The Pro shares the dial's recipient selection, pane/tab synchronization,
continuous terminal scrolling, USB audio capture, voice routing and failure
handling. It retains the host's feature negotiation and the existing revision
and receipt checks.

Controls provides machine selection, model/effort selection from the host's
catalog, explicit confirmation before stopping a turn, brightness, notification
sound and companion preferences. Compatible hosts also expose:

- **Find Harness** and **New Harness**, controlling the desktop's actual semantic
  picker/form. Voice filters names; a separate action confirms the choice.
- **Select text** and spoken **Find in output**, with line/range selection.
- **Carry text** requires a draft-capable host and always reviews speech before
  Send. The recipient, source and passage preview stay pinned through edits.
  **Passage preview** opens a temporary reading sheet; the host owns the complete
  selected passage (up to 4096 bytes / 16 lines), while this device shows its
  shortened excerpt. The five-minute expiry applies only to an unused tray;
  an attached reviewed message retains its snapshot until Send or Discard.
  Rejections keep the draft. A lost connection or an unknown delivery receipt
  retains the visible part and local preview with Send disabled; this is not
  persistent storage or recovery of the host's full multipart draft.
- **Latest output** and **Return**, preserving the prior reading place.
- Voice drafts with re-speaking a part, append, undo, discard and explicit Send.
- **Instruct** keeps one-shot Task speech available for every engine. With a
  draft-capable host and an exactly identified local pane, Claude exposes Goal
  and Loop; Codex exposes Goal. Unknown or remote machine identities leave Task
  available. Unknown engines expose Task only. A Loop's task and interval are spoken together.
  Goal and Loop always open transcript review, preserving their mode while
  re-speaking or appending. The pane is pinned when Instruct opens and checked
  again before recording and Send; stale touches cannot change its recipient.
  These use the existing host commands, not an on-device scheduler. Home speech
  remains a quick Task with optional review.
- Questions with single or multiple choices, spoken answers where supported,
  answer review and delivery receipts.

Goal/Loop availability checks the complete cable-host and pane machine IDs,
the known engine IDs and `voice.draft` feature. The sheet pins its original
host/link generation; capture and reviewed Send recheck the original recipient
and host. Missing or oversized identities never match a shortened prefix.
These checks reject known mismatches, but do not prove strict host intent
support. The protocol has no per-pane command capability, engine
generation precondition on Send, or goal/loop lifecycle and schedule receipt.
The device cannot prove a loop was scheduled or show its next run. Atomic host
validation is still needed to reject an engine change after the device's final
check; older host fallback must not be presented as successful scheduling.

### Local daily estimate

Hosts advertising `metrics.read.v1` add **Today** to the Menu header. This
temporary sheet shows the cable host's name and local day, a USD estimate,
coverage, the three supported local transcript sources and scan age. A missing
amount says Unavailable; a supplied zero says `$0.00`. A positive amount below
one cent says `<$0.01`. Partial readings remain labeled. All enabled sources
being priced means complete coverage of those opted-in sources, not an account
bill or fleet total. Focusing a remote machine does not change this scope.

Open or Refresh sends one bounded `metrics.get`; the device neither enables
sources nor polls in the background. Replies require schema 1, the exact pending
request ID and the full `welcome.machine.id`. A 20-second timeout, disconnect,
source/capability change or leaving the sheet clears the pending reading.
Reopening creates a new random request ID. Invalid data and host errors never
produce a zero estimate or display raw diagnostic text.

The host validates its projection against its clock. The Pro has no trusted
wall clock, so scan age advances with monotonic time plus a conservative
20-second projection allowance. At the supplied local-day boundary the amount
is hidden until Refresh succeeds. This feature does not report elapsed work,
goal progress or loop schedules. Production-renderer previews use illustrative
amounts; physical USB/app integration still needs a matching host trial.

Unavailable host features stay out of Controls. The larger screen does not
invent arbitrary desktop commands: sharing, branch/PR management, window
layout editing and other desktop-only commands retain their desktop UI.

## Creature and screen

The registry contains exactly the ten `init` daemons from `daemons/roster.json`.
Every one implements the common **idle, working, attention, done, offline,
asleep, booped and listening** states. Body, rear/front limbs and face are
separate code-authored layers, baked into cropped antialiased RGB565/alpha
bitmaps. Eight interpolated limb poses per choreography combine with a shared
24-step clock, blinks, touch gaze, five listening levels, and eight speaking
emotions. Completion and boop are finite; ordinary motion pauses while hidden.
There are two fixed portrait sizes: **350 px** without text and **160 px** with
text. No vector renderer or image decompressor runs while the UI lock is held.

Choose **Daemon** or **Scene** directly in Menu. Each picker owns a separate
preview character and applies changes only on **Use**. Daemon ID and scene are
saved in one NVS `u16`; the round dial preference remains separate. **Match
daemon** is the default, choosing Meadow, Shore, Dusk or Paper from the registry.
A manual scene choice survives daemon changes and reboot. Quiet motion and a
fifteen-minute rest remain in Companion controls.

The ten-daemon pack is 5,696,650 bytes. Its renderer reserves six fixed active
layer caches totaling 1,634,004 bytes, independent of collection size. Identical
layers reuse their decoded pixels. Decode/preparation and full render times
are reported separately in the hardware heartbeat; host timing is not a device
latency claim.

The background and letters use cached RGB565 images with alpha masks; the
compositor redraws damaged regions. Secondary sheets use a warm paper canvas,
dark green text and a restrained purple action color. Text uses proportional,
antialiased 24/32/42/56 px atlases. Main reading text is 32 px; titles are larger.
Questions and drafts reserve six reading rows, while the result reader has nine.
Longer text scrolls; the existing bounded host/firmware text capacities remain.

Brightness changes the physical PWM backlight, keeping foreground contrast
intact. Controls cycles 25/50/75/100 percent and saves the selection. When no
brightness has been saved, this Pro face starts at 220/255, approximately 86
percent; an existing preference wins. These are commands, not measured luminance.
No undocumented panel gamma or voltage registers are changed.

## Review on the device

Start with two open agent panes in Harness. Swipe between them and watch the
desktop focus change. Add a second workspace and swipe with two fingers together
on Home; release before trying another gesture. Check a late second finger,
three fingers, a lift-and-hold, sleep during contact and a roster refresh: none
should begin voice or activate a pane. Compare Map and List, including a dense
layout, and confirm the selected workspace matches the desktop. Drag vertically to check scroll tracking, then tap to
brake. Compare a voice tap on the full creature with a tap over a summary; both
must begin the same listening flow. Use Review first for a message you want to
inspect before sending.

Next read an update, return home, visit Menu and browse Tabs, Daemon, Scene and Controls.
Check the question/review flow only when a real pending question is available.
Compare the saved brightness presets in your normal lighting and try Quiet
motion. Disconnect the desktop app while leaving USB power connected: the
same layout should show connection guidance, with local controls available. Reconnect
the app to resume pane swipes, desktop scroll and voice. These are review steps
for the person, not claims of already completed physical tests.

Generated, local review artifacts:

- [Actual firmware screens](generated/preview/index.html) and
  [screen contact sheet](generated/preview/contact-sheet.png).
- [Tim moods](generated/daemons/tim-moods.png), [Tux moods](generated/daemons/tux-moods.png),
  and corresponding mood plates for each daemon in `generated/daemons/`.
- [Idle animation](generated/preview/idle.gif),
  [listening animation](generated/preview/listening.gif), and
  [completion animation](generated/preview/done.gif).
- [Product and protocol review](../pro-concepts/PRODUCT-REVIEW.md) and
  [interaction review](../pro-concepts/INTERACTION-REVIEW.md).

Previews use the actual firmware renderer with illustrative app state. They do
not reproduce the LCD's optical black level or prove microphone behavior.
`generated/` is ignored; the commands below regenerate these artifacts.

## Hardware and limits

This build targets the **720×720 Harness Pro**, using the ESP32-P4, ST7703I
two-lane MIPI display path and GT911 touch driver. The trial unit is P4 silicon
**revision 3.2**, with 16 MB flash and PSRAM. Use **ESP-IDF 5.5.3 or later with
revision 3.x selected**; the older dial SDK and ESP32-S3 images are incompatible.
See [Espressif's revision guide](https://documentation.espressif.com/esp32-p4-chip-revision-v3.x_user_guide_en.pdf).
The prototype overlay selects the revision-3 400 MHz CPU setting and a larger
main stack; the renderer also reserves its own larger task stack.

The LCD has a backlight, so it cannot produce the round AMOLED's unlit black.
The light surfaces, strong text contrast and real backlight control fit that
hardware. The supplied panel datasheet describes four lanes; the carrier routes
two, and the existing working board driver is reused. Its reset, timings, power
latch, backlight polarity and touch-address strap sequence remain board-owned.

USB/dock power is required throughout use. App disconnection changes
availability and connection guidance; it does not select another layout. No battery operation or
wireless app transport is part of this product direction.

Current limits:

- App connectivity is **USB**. No C5 Wi-Fi/Bluetooth app link or offline voice
  recording is implemented.
- One-finger input retains voice, pane navigation and vertical scroll. A guarded
  two-finger horizontal gesture changes workspaces on Home; physical validation
  remains outstanding. Pinch, pressure, hover and orientation gestures are not
  implemented.
- Pane switching covers controllable **agent panes**. Shell/viewer seats are
  not independently focusable through this protocol.
- Stored lock patterns use a centered square-screen unlock layout. Update
  presentation is adapted to the Pro as well. Pattern editing is not part of
  this prototype; existing configuration and lock checks are preserved.
- The microphone/audio path is wired to the shared app protocol; physical
  acoustic quality and end-to-end spoken interaction need the user trial.
  Haptic and LED effects are not added by this design.

## Spoken replies

The Pro speech build uses the original **Octo - Spark** voice through
Eleven v4 Turbo. A fresh reply to a device voice message can play through the
ES8311 speaker while showing the same words on a readable caption card. The
mouth follows the playback level; the previous summary returns when it ends.
Touch interrupts, and starting capture preempts playback. Old notification
history and ordinary desktop turns remain silent.

Replies are curious and playful, delighted for good news, and gentle when a
problem occurs; the legacy neutral option no longer produces neutral delivery.
Conversation volume is 90 percent, with host soft gain, independently of
notification mute. The host waits for speaker readiness and each audio chunk
receipt, preventing burst transfers from losing a chunk. Audio streams as mono
16-bit, 16 kHz PCM through a preallocated buffer;
the Pro does not run speech synthesis or an audio decompressor. The API key
stays in the computer's Keychain. See [voice design and protocol](VOICE.md) for
emotion rules, local configuration, limits and measured provider trials.

## Reproduce

Run the following from the repository root with Python 3, Pillow, NumPy and a
native C compiler available. Font generation currently requires the macOS
system Avenir Next collection at `/System/Library/Fonts/Avenir Next.ttc`.
The scripts rasterize local outlines into four-bit alpha atlases; they do not
copy the source font file. Artwork is code-authored geometry derived from the
approved Field companion, not an external image-generation service.

```sh
python3 devices/harness-device/prototype/pro-companion/tools/generate_fonts.py
python3 devices/harness-device/prototype/pro-companion/tools/generate_daemons.py
python3 devices/harness-device/prototype/pro-companion/tools/preview.py --animate
```

The art generator verifies every exported compressed block and its exact
decoded byte count. Production preview compiles the real layout/compositor/art
code under address, undefined-behavior and bounds sanitizers. Its manifest
records the source hashes behind the images.

Run the focused checks and the shared regression gates:

```sh
python3 devices/harness-device/firmware/test/test_pro_power.py
python3 devices/harness-device/firmware/test/test_pro_canvas.py
python3 devices/harness-device/firmware/test/test_pro_language.py
python3 devices/harness-device/firmware/test/test_pro_metrics.py
bash devices/harness-device/firmware/test/run-pro.sh
python3 devices/harness-device/firmware/test/test_pro_touch_driver.py
python3 devices/harness-device/firmware/test/test_pro_voice_samples.py
python3 devices/harness-device/firmware/test/test_voice_ui.py --pro
python3 devices/harness-device/firmware/test/test_draft_ui.py --pro
python3 devices/harness-device/firmware/test/test_audio_speech.py
python3 devices/harness-device/firmware/test/test_cable_speech.py
python3 devices/harness-device/firmware/test/test_pro_visual.py
python3 devices/harness-device/firmware/test/test_pro_daemon_registry.py
python3 devices/harness-device/firmware/test/test_pro_appearance_preferences.py
bash devices/harness-device/firmware/test/run.sh
```

`test_pro_controls.py` accepts `HABITAT_PRO_PREVIEW_DIR` to export pixel-exact
PPMs for the application sheets. Those checks cover long text, text overlap,
screen bounds, hit areas, read receipts and guarded actions. Pro touch replay
uses production hit geometry and gesture dispatch. The shared suite also
checks the round Tim/Tux paths; optional SDK-dependent gates use `IDF_PATH`.

Activate ESP-IDF v5.5.3, then build the actual shared firmware with the same
feature flags as the reviewed `.12` image:

```sh
. "$IDF_PATH/export.sh"
cd devices/harness-device/firmware
idf.py -G 'Unix Makefiles' -B build.pro-companion \
  -DIDF_TARGET=esp32p4 \
  -DSDKCONFIG=build.pro-companion/sdkconfig \
  -DSDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.defaults.esp32p4;../prototype/pro-companion/sdkconfig.defaults;../prototype/pro-companion/sdkconfig.wifi.defaults' \
  -DDEVICE_HABITAT=1 -DDEVICE_PRO_COMPANION=1 -DDEVICE_PRO_WIFI=1 \
  -DDEVICE_DEFAULT_CHARACTER=tim \
  -DPROJECT_VER=0.0.87-pro.companion.12 \
  -DCCACHE_ENABLE=0 build
```

`DEVICE_PRO_COMPANION=1` always selects the dock-only experience. There is no
portable build flag or runtime layout preference.

Use a fresh target-specific build directory when changing silicon-revision
defaults; an existing generated `sdkconfig` can override defaults. Verify the
linked image's target/revision, version, hash and fit in the existing app slot
before installation. The physical trial backs up the selected application and
writes only the verified Pro application partition, preserving NVS, the
partition table, OTA selection and the installed bootloader. USB path alone is
not a device identity; identify the exact hardware before writing.

The implementation lives in
[pro_home.inc](../../firmware/main/ui/habitat/pro_home.inc),
[pro_controls.inc](../../firmware/main/ui/habitat/pro_controls.inc),
[pro_canvas.c](../../firmware/main/ui/habitat/pro_canvas.c), and
[pro_visual.c](../../firmware/main/ui/habitat/pro_visual.c), compiled only when
`DEVICE_PRO_COMPANION=1`. Shared application state and command dispatch stay in
[ui_habitat.c](../../firmware/main/ui/habitat/ui_habitat.c).

## Wi-Fi provisioning trial

Build with `DEVICE_PRO_WIFI=1` and `sdkconfig.wifi.defaults` in addition to the
normal Pro companion defaults. This selects the WT01P4C5-S1 SDIO wiring from
the supplied module datasheet: P4 GPIO14–19 for data/clock/command, GPIO13 reset,
four-bit SDIO at 20 MHz. ESP-Hosted 2.12.13 and esp_wifi_remote 1.3.2 are resolved
by the component manager; the C5 coprocessor firmware was not reflashed.

Credentials arrive only through an existing physical USB session and are kept
in device NVS. They are not compiled into the image or printed in logs. A
dedicated task handles connection and retry without blocking touch or render.
The C5 responded and accepted automatic 2.4/5 GHz operation. The first filtered
scan found no match for the lowercase network name. After correcting the SSID
capitalization over USB, the Pro joined the intended network and received an
IP address in 17.63 seconds. The corrected credentials remain saved in NVS;
no firmware rebuild or reflash was needed.

This is network provisioning, not a wireless Harness application transport.
App control and voice still require the USB bridge.

The final `.9` image also passed its live USB trial: 120 seconds uptime, 586
frames, live pane data, zero resets and zero touch-read failures while the radio
continued retrying the unavailable network. The earlier startup-order failure
was corrected before this final installation.


### Reviewed message recovery

Task, Goal, Loop and Carry reviews become permanently read-only when the link
ends or the host reports that a reviewed message is unavailable. The current
part stays in RAM. **Recover message** requests the original draft from the exact
original cable host; it never changes recipient, restores Send/edit/undo, or
infers delivery from a reconnect. Recovered parts can be read in either direction.
A historical submission receipt leaves the words visible until explicit Close.
Carry's frozen preview remains available only while that RAM state survives;
recovery never claims to show the full host-owned source passage.

The dock-only device can lose power when USB is unplugged. A single checked,
256-byte NVS bookmark stores only the original draft/host/recipient identities,
intent, recipient label and revision. It does not store any words, part, carried
source name or passage. It is saved once for the first accepted draft UUID;
edits, part movement and touches do not cause more writes. After a successful
save, boot restores a read-only **Recover message** entry with **No local words
saved**. Failed storage is shown as unavailable after power loss. Close erases
the bookmark before dismissing the entry; a failed erase stays visible for retry.
The queued writer invalidates stale save/clear actions and never restores send
authority. Physical free NVS capacity and abrupt-power endurance require a board
trial; no partition size or battery assumptions changed.

Full recovery requires a matching host that still retains its bounded archive.
The matching host implementation keeps this data across cable removal/path changes
for a fixed 30-minute lifetime. A daemon restart, expiration, missing owner or old
host can make the full message unavailable. The device then keeps only the part
still in RAM, or only its identity bookmark after reboot. No archive discovery,
automatic retrieval, retry of delivery, remote retargeting or complete-source
quote reconstruction is added. The existing glyph send gate is unchanged; new
recovery interface copy is English.

The SDK-independent NVS fault replay is included in `firmware/test/run.sh`.
The actual native callback/command/boot/render replay additionally uses the
pinned ESP-IDF cJSON and generated Pro fonts:

```sh
IDF_PATH=/path/to/esp-idf-v5.5.3 python3 devices/harness-device/firmware/test/test_pro_draft_recovery.py
```

`HABITAT_RECOVERY_TRANSCRIPT` can supply exact CableSession frames for the same
replay, and `HABITAT_PRO_PREVIEW_DIR` records native 720 px PPMs. These checks cover
identity/revision guards, offline/unknown states, metadata storage failures,
stale workers, local Close and read-only multi-part navigation. They do not
establish physical unplug recovery, touch comfort, flash wear or terminal delivery.
