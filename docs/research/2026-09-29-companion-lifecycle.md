# Illustrated companion lifecycle

The desktop's experimental companions now carry the same individual identity to
the round USB dial: species, uid, name, growth stage, coat colour and markings.
The title-bar icon, Zoo portrait, collection thumbnail and card use the same
materials. The existing experiment gate and per-device Follow companion setting
still control availability. Account progress and pairing remain authoritative.

The ten species share authored material masks and a personality table. Idle,
boop and completion animations have distinct timing and movement. Work motion
on desktop still follows real agent events. Quiet mode, reduced motion,
background windows, sleep and urgent requests suppress decorative reactions.
Fresh hatches and growth changes produce short celebrations; initial reads,
app restarts and reconnects establish quiet baselines rather than replaying them.

On the dial, baby and young stages now share the adult's visible centre in both
home and reading layouts. The permanent companion name was removed from the
footer, which belongs to notifications and useful status. Even a temporary
milestone label yields to the notification bell or retry status. Names remain
available in the desktop Zoo and the USB identity payload.

The additive USB capability is `companionProtocol: 2`; old hosts and firmware
retain species-only behavior. Five fixed renderer caches hold active art layers.
No Zoo data is persisted on the dial. Rolled accessories and individual
proportions remain metadata; growth, coat and markings are illustrated.

## Validation

- 427 CLI tests and TypeScript checks passed, including identity changes,
  legacy compatibility, reconnect baselines, quiet behavior and real serial I/O.
- 221 desktop tests passed, including experiment gates, lifecycle events,
  bounded image loading, bundled palettes and matching portrait/tile styles.
- 4,096 native title-bar checks passed. The universal macOS release built,
  received a local ad-hoc signature, and launched after an app restart. Visual
  review confirmed coral Tim in the title bar, portrait and collection tile.
- All 5,848 PNG files passed manifest hash verification. The device artwork
  pack is 4,615,346 bytes and has five caches totaling 835,281 bytes.
- The firmware ASan/UBSan suite passed. Final targeted renderer and touch tests
  also passed after the centering/footer changes: all ten species, three ages,
  two layouts, eight moods, coat/mark changes, 1,462 exact incremental redraws,
  and eight simulated hours per species with clock wrap.
- Normal firmware `0.0.87-companions.4` was installed on the connected round dial.
  Flash readback matched the built image. Bootloader, partitions, saved settings
  and the 40% brightness setting were preserved; both previous firmware images
  remain available locally for rollback.
- The live dial acknowledged 30 species/stage switches. Three reconnects through
  Harness's production serial implementation each returned a pong in roughly
  140 ms, acknowledged identity and preserved settings. The earlier PySerial
  reopen probe triggered a USB reset and exceeded its two-second timeout; it is
  not counted as a passed reconnect test. Harness restored the actual paired
  baby Tim after every test session.

An eight-hour read-only hardware monitor is running from the local review
folder, `.scratch/companion-life/`. Its `overnight-soak.json` records real elapsed
time, health samples, memory/stack minima, sleep/wake observations and resets.
The overnight result is pending, and simulated clock coverage is not a hardware
soak result. The monitor reports an incomplete run if the Mac sleeps too long,
the dial disconnects, the firmware changes or health coverage is insufficient.
Physical sleep/wake coverage remains pending until observed by that monitor.

The final local review app is `.scratch/companion-life/final/Harness.app`.
Installation evidence and rollback images are under
`.scratch/companion-life/centered-install/`; the earlier stable rollback remains
in `.scratch/companion-life/previous-application.bin`. The CLI is
`0.3.25-dev.companion-life.1`. This validation does not publish a release or
replace the app under `/Applications`.
