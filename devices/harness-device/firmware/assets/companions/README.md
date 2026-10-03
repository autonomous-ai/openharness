The ten desktop companions, packed for the normal round-dial firmware.

Regenerate with `python3 devices/harness-device/firmware/scripts/gen_companion_art.py`
from the repository root (Pillow 12.2+ and NumPy). The authored geometry lives in
`daemons/tools/illustrated/daemon_art.py`, shared with the desktop. The manifest
records its hash and the generated pack's hash.

Each independently compressed block contains panel-order RGB565 followed by
straight alpha and six material channels (shade, coat, four named markings). Cropped rear, body, front, face and mail layers share five
bounded renderer caches (835,281 bytes total), with 240 px and 108 px layouts.
Animation and touch replace layers without decompressing the unchanged body.
Growth shrinks active layers in place using premultiplied-alpha interpolation.
Baby and young stages share the adult's visible centre in both layouts, using
fixed idle anchors so animation keeps its movement. Names stay in the desktop
Zoo; the dial's lower text area stays clear for notifications and useful status.
Cache keys include stage, colour and marking, and never grow with Zoo size.

Companions are a transient account-controlled override. The saved Tim, Tux and
Focus skin IDs retain their meanings. `followCompanion` is on by default and can
be disabled per device. Turning off the desktop creature experiment, unpairing,
signing out or losing the cable session restores the saved skin. No Zoo or
account data is persisted on the dial.

`test/test_companions.py` decodes this exact pack and compares partial redraws
against complete renders for every species and mood, both sizes, touch and mail.
Set `COMPANION_CAPTURES` to a local folder to save review images.

USB extension (protocol 3, capability detected from settings):

- `hello.settings` and `settings.state.settings` add `followCompanion: boolean`
  and `companion: string | null`. Older firmware omits them; the host sends no
  companion commands to those devices.
- `companion.set { id: "gnu" }` selects an illustrated species for this cable
  session. `id: null` restores the saved skin. Unknown or malformed IDs are
  refused. Both outcomes answer with `settings.state`, including `ok` and the
  actual active companion. Selection never writes flash.
- `settings.set { followCompanion: false }` persists the per-device preference
  through Diego's existing settings path, using bit 4 of Habitat options.
  Existing skin IDs 0, 1 and 2 remain Tim, Tux and Focus.
- The host reads the existing account Zoo cache; no new polling or account API
  is added. It sends changed selections on its one-second USB tick, retries a
  missing acknowledgement at most every five seconds, and reasserts after a
  device reboot. Gallery browsing never changes the Zoo pair.

Individual sync (additive capability `companionProtocol: 2`):

- `companionDetails` reports `{id, uid, seed, name, version, colour, mark}` or null.
  Versions `0.1`, `1.0`, `2.0` select baby, young and adult. Colour is -1 for
  canonical artwork or 0–5 in roster order; mark is 0–4 in roster order. Names
  are 1–24 printable ASCII characters and uid is 1–64 letters, digits, `_` or `-`.
- `companion.set` may include `identity` with those fields. Legacy species-only
  hosts still select the approved adult artwork. New hosts fall back to the
  species command when talking to older companion firmware.
- `companion.celebrate {identity, kind: "hatch"|"grow", token}` briefly shows that
  individual for 2.4 seconds, then restores the paired companion. Its receipt
  is `companion.event {ok, token}`. It does not change `companionDetails`, pair,
  XP or saved settings. Quiet, sleeping, reading and attention states suppress
  the reaction; an urgent request arriving during one ends it immediately.
  Notification bells and retry status also take priority over its brief label.
- The CLI observes authoritative Zoo revisions. First reads and app restarts
  establish quiet baselines. Hatches must be fresh, events expire in 8 seconds,
  and reconnects do not replay them. Both ends deduplicate tokens in bounded
  memory. Offline celebrations are consumed rather than queued for later.

The native tests exercise all stages and coat families, malformed identities,
quiet/sleep suppression, serial compatibility and eight simulated hours per
species including clock wrap. Real-device soak reports live under the local
review folder; simulated time is not a claim of an overnight hardware pass.
