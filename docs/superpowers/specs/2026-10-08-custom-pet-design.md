# Custom pets on the dial

Status: design, approved in conversation 2026-10-08 · owner: device team

## Goal

A user can give the round dial's Focus face a pet of their own: a sprite sheet downloaded (petdex.dev or anywhere
else), chosen in the desktop app's Device settings and sent to the dial over the cable. One pet for
every agent. (The protocol and store also hold a pet per engine; the app offers one pet for all agents for now.)

Success: the user picks a PNG in Settings, sees it animate in a preview for each state, presses Apply, and within
a few seconds the dial shows that pet moving with the agent's state; it comes back by itself after the cable is
replugged or the daemon restarts.

## Decisions

| Question | Decision |
|---|---|
| How far does "custom" go | The user brings their own sprite sheet (option C); no recolouring or accessories of the built-in pets |
| Where the pet lives on the dial | PSRAM, sent again by the daemon on every attach (option A). No partition change, no USB reflash of dials in the field; a dial booting without its daemon shows the built-in pet until the daemon sends the custom one |
| Scope | The app offers one pet for all agents. Per-engine pets stay in the protocol and store for later (resolution: engine's own → all → built-in); applying a pet in the app resets any engine-specific entry so it cannot override the all pet |
| How a pet is made | Import only, with a one-line hint pointing at petdex.dev; no template. No in-app editor, no AI generation in this version |
| Where the sheet is converted | The daemon's devices subsystem (`cli/src/services/devices`), not the core, not the app, not the firmware |

Out of scope: per-engine pets in the app, Harness Pro, Wi-Fi devices, per-agent pets, an in-app editor, AI generation, pets persisted in
flash.

## Input: the sprite sheet

The petdex / Codex pet-pack layout, which the Codex pet in `assets/pets/codex` already follows: a PNG of 8 columns
x 9 rows of 192 x 208 cells (1536 x 1872), RGBA. The half size (768 x 936, cells 96 x 104) is accepted too. Rows,
top to bottom: idle, running-right, running-left, waving, jumping, failed, waiting, running, review. A row may be
shorter than 8: the first fully transparent cell ends it.

The daemon only reads PNG. What petdex.dev hands out is a package, a folder (often a .zip) with `pet.json`
(`id`, `displayName`, `spritesheetPath`) and `spritesheet.webp` of the same 1536 x 1872 layout. The desktop app
resolves it (`desktop/lib/devices/pet_source.dart`): it takes a folder, a zip, a `pet.json`, a `.webp` or a `.png`,
keeps the sheet path inside the folder, bounds a zip (64 entries, 32 MB), checks a WebP's size from its header
(1536 x 1872 or 768 x 936, at most 8 MB) before decoding it to a PNG, and sends the daemon that PNG with the pet's
`displayName` (`pet_preview` takes an optional `name`, control characters stripped, at most 40 characters).

Loose sheets: any other PNG or JPEG (<= 8 MB, <= 4096 px) is normalised in the app (`loose_sheet.dart`): a real
alpha channel is kept, otherwise a flood fill from the border clears a checkered (baked "transparent" squares) or
solid background; frames are found from the gaps between them (<= 9 rows x 8 frames) and laid onto a 1536 x 1872
sheet, loose row i on sheet row i, one scale for the whole sheet, bottom-aligned per row. The app guesses a
mapping (Rest = row 1, Working = the row that moves most, Asking = the last row) and sends it as `rows`.

The default mapping, which `pet_preview {rows: {rest, working, listening, sending, asking}}` (each a row name from
`PET_ROWS`, camelCase) overrides; the pack id hashes the mapping when it differs from the default, and `<id>.json`
keeps it for re-conversion:

| Dial state | Row | If the row is empty |
|---|---|---|
| Rest (resting face, recap, small question) | idle, a waving pass now and then | required |
| Working | running (row 8) | required |
| Listening (voice) | review | idle |
| Sending | waving | idle |
| Asking (a question waits) | waiting | idle |
| Failed turn | failed | idle |

running-left, running-right and jumping are not used.

## Conversion (daemon, devices subsystem)

1. Validate: PNG decodes, size is one of the two accepted, the rows chosen for Rest and Working are non-empty, file <= 8 MB.
2. Pixel-art factor: the largest k (dividing the cell size) for which every k x k block of every used frame is one
   colour. Cell size = k, so a 4x-upscaled 48 x 52 drawing becomes 48 x 52 cells. Otherwise k = 1.
3. Alpha: >= 128 opaque, < 128 transparent (cell sprites have no partial alpha). If more than 2 % of a frame's
   opaque-edge pixels had partial alpha, warn ("soft edges will look jagged").
4. Palette: one per pet, median cut over every used frame, <= 255 colours + transparent (index 0), RGB565 in panel
   order as `ht_cell_frame_t` expects.
5. The small resting pet: the idle frames at half size, made here so the firmware never scales.
6. Pack rows with the firmware's transparent-run encoding (`row_at`, skip/opaque pairs).
7. Pack <= 1 MB, or refuse.

Errors are returned to the app with a message it shows as is, e.g. "The sheet must be 1536 x 1872 (8 x 9 cells of
192 x 208)", "The row chosen for Working is empty", "This pet is 1.4 MB; the limit is 1 MB".

## The pet pack (little-endian)

```
header  "HPET" · version u8 (1 or 2) · flags u8 · id u8[8] (first 8 bytes of sha256 of the source PNG) · length u32 · crc32 u32
palette count u8 (entries incl. index 0) · count x u16 RGB565 panel order
small   w u16 · h u16 · loops idle/done/asking: each n u8 · n x u16 frame index
scenes  working, listening, sending, failed (, relaxing in version 2): each n u8 · step_ms u16 · dx i16 · dy i16 · n x u16 frame index
frames  count u16 · per frame: cols u8 · rows u8 · cell u8 · row_at u16[rows] · packed rows
```

The small pet (rest, recap, small question) is one frame pool with per-state loops, which is what `ht_pet_t.cells`
and `loops` already are; it replaces separate rest and rest_small scenes. Frames are de-duplicated, so a substituted
scene points at idle's frames. `step_ms` defaults to 120. `dx`, `dy` place the scene from Focus's home position
(0, 0 = centred as the built-in pets are). `failed` is packed but not drawn in version 1: the dial has no failed
state yet.

Version 2 (2026-10-09, the relaxing face: `mockup/relaxing.html`) appends one scene, `relaxing`, after `failed`, same
encoding, built at full size like `working` from the row the person picks for Relaxing (default: the Rest row). A pack
whose relaxing frames would push it over 1 MB is sent with an empty relaxing scene (n = 0), which the dial treats as
none. A dial says which versions it reads in `hello` (`pets: 1` or `pets: 2`); the daemon sends min(dial, 2) and
rebuilds a version-1 pack for an older dial from the kept PNG. The pack id is the same for both versions: it names the
pet and its mapping, and `relaxing` joins the id's hash only when it is not the Rest row, so every older pack keeps its
id. On the dial, a pet with a relaxing scene shows the relaxing resting face (name on the upper arc, the scene in the
middle, one short grey line on the lower arc) when idle or done with no recap; a version-1 pack keeps the old resting
face.

The app hands the daemon the PNG's local path, not its bytes: pet requests are local-only, and the 8 MB source would
not fit the local socket's message limit.

## Storage and mapping (daemon)

- Packs: `~/.harness/devices/pets/<id>.pack`, plus the source PNG beside it for re-conversion when the format version
  changes.
- `~/.harness/devices/pets/pets.json`: `{ "all": "<id>" | null, "engines": { "claude": "<id>", ... } }`.
- At most 4 packs referenced at once (all + 3 engines) so the dial holds <= 4 MB of pets in its ~5 MB free PSRAM.
  An apply that would exceed it is refused with a message naming the limit.

## Protocol (cable)

- `hello` from a supporting dial carries `pets: 1` (or `pets: 2`, see version 2 above) and `petIds: [...]`, the packs it holds (empty after a reboot).
- `pet.map {all, engines}`: which pack stands for what. Sent after attach and on every change.
- `pet.begin {id, length, crc}` → dial allocates in PSRAM or answers `pet.error {id, reason: "memory"}`.
- `pet.chunk {id, offset, data}` → ack per chunk. Reuse fwPush's chunking if it fits; otherwise ~4 KB chunks.
- `pet.end {id}` → dial checks length and CRC, parses, answers `pet.ok {id}` or `pet.error {id, reason}`.
- `pet.drop {id}` → dial frees a pack no longer mapped.
- The daemon sends only packs the dial lacks. A transfer cut halfway is discarded by the dial; the daemon sends it
  again on the next attach.
- Older firmware ignores `pet.*`; the app reads the absent capability and locks the Pet section.
- Sequencing: the pet map and packs are sent from the devices' own state after `hello`, never only from a window's
  frame, so a daemon restart cannot lose them (see the app_swarms start-up race found 2026-10-08).

## Firmware (round dial)

- `pet_store.c`: receives packs into PSRAM, validates CRC and version, builds an `ht_pet_t` per pack whose scenes
  point at `ht_cell_frame_t` frames in PSRAM.
- Lookup in `focus.c`: engine's custom pet → "all" pet → built-in pet by engine name.
- Drawing reuses the cell-sprite path. The Focus rule holds: the same runs in the same order every frame; a custom
  pet occupies the built-in pet's run slots.
- The working alert: a custom pet has no drawn alert scene, so the count bubble (blue `0x006fff`, the count in
  `ht_lv_inter_med_26`) is drawn in code at the pet's top-right.
- Swapping a pet: the new one takes effect on the next frame from step 0; the old pack is freed only once no frame
  references it.
- Capability `pets: 2` in `hello` (relaxing scene; `pets: 1` before 2026-10-09).

## Desktop app

A "Pet" section in Device settings (`desktop/lib/devices/device_settings.dart`):

- One row, "All agents": the pet's thumbnail and name ("Default" when none), "Choose file…" (png, jpeg, webp, zip
  or pet.json), "Choose folder…", "Reset to default"; a file, folder or zip can be dropped on the row too.
- A row picker for every source: the sheet's non-empty rows (the daemon's `sheetRows` strips, labelled by petdex
  name, or "Row N" for a loose sheet) and five pickers, Rest · Working · Listening · Sending · Asking. A change
  re-requests `pet_preview` with `rows` (debounced, stale replies ignored); Apply uses the latest preview's id.
- Apply sets the pet for 'all' and then resets every engine entry in the mapping, so a pet left from earlier
  testing no longer overrides it. Reset clears 'all' and every engine entry.
- After choosing: the daemon's preview (the converted frames, exactly what the dial will draw) with tabs Rest /
  Working / Listening / Asking, the pack's size and colour count, warnings. Apply / Cancel.
- Apply shows "Sending to dial… n %" then "On dial ✓". No dial attached: saved and sent on the next attach.
- Under the row, a muted hint: "Find pets on petdex.dev, or use any PNG, JPEG or WebP sprite sheet."
- The row itself: the pet's 44 px thumbnail, its name and its status (On dial ✓, Sending…, Waiting…), with
  Choose folder… · Choose file… · Reset as same-size pills on the right.
- Dial firmware without `pets: 1`: the section is locked with "Update the dial's firmware to use custom pets".

Requests to the daemon (local WS, devices): `pet_preview`, `pet_apply`, `pet_reset`, `pet_status`.

## Errors

| Case | Behaviour |
|---|---|
| Conversion fails | The app shows the message in the row; nothing saved |
| Transfer cut (cable pulled, timeout) | The dial discards the partial pack, keeps the current pet; resent on next attach |
| Dial out of PSRAM | `pet.error memory`; the app says "The dial is out of memory for pets"; the dial keeps its current pet |
| Pack corrupt / unknown version | The dial drops it and reports; the daemon re-converts from the kept PNG if the version is old |
| Daemon restart | `pets.json` is on disk; the dial is re-synced on attach |

## Testing

- Daemon unit tests: pixel-art factor detection, palette <= 255, alpha threshold, row substitution, size limits and
  messages, pack round-trip (written then parsed equals the frames), cable sync against a fake dial (only missing
  packs sent, resend after a cut, map change, drop).
- Firmware host tests (`test/run.sh`): parse a real daemon-made pack, reject corrupt / bad CRC / bad version,
  lookup order, raster of a custom pet (constant run count, ink inside r 230), the code-drawn bell bubble, a swap
  mid-frame without use-after-free.
- App widget tests: the Pet section in both modes, preview, error display, locked state.
- On device: a petdex pet and a loose JPEG sheet; transfer time, `raster_max_us`; replug and daemon restart bring
  the pet back.
