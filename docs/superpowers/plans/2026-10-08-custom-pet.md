# Custom Pets on the Dial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user picks a petdex-layout sprite sheet in the desktop app's Device settings, for all agents or per engine, and the round dial's Focus face shows it, kept in PSRAM and re-sent by the daemon on every attach.

**Architecture:** The daemon's devices subsystem (`cli/src/cable/pets/`) decodes and validates the PNG, converts it into an `HPET` pack in the firmware's own cell-sprite format, stores packs and the mapping under `~/.harness/devices/pets/`, and syncs them over the cable with JSON `pet.*` messages plus binary `CableType.Pet` slices (the firmware-update credit scheme, reused). The firmware's `pet_store` parses packs into PSRAM and builds `ht_pet_t`s that `focus.c` looks up before the built-in pets. The app adds a Pet section that talks to the local daemon with four requests.

**Tech Stack:** TypeScript (Node 22, vitest, zod), `pngjs` (new dependency), C11 (ESP-IDF 5.5.0 for the dial, host tests with cc + sanitizers), Flutter/Dart (desktop).

**Spec:** `docs/superpowers/specs/2026-10-08-custom-pet-design.md`

## Global Constraints

- Code, comments and docs in English. Match each file's comment density and naming.
- Never commit, push or stage anything unless the owner asks in that turn; each task ends with its tests green and its files listed, not committed. Never `git add -A`.
- Dial host features live in the devices subsystem (`cli/src/cable/`, `cli/src/services/devices.ts`, `cli/src/lib/harnessDevices.ts`); the core (`cli/src/core/`) changes only by adding request names to `DEVICES_REQUESTS`.
- Sheet layout: 8 columns x 9 rows of 192 x 208 cells (1536 x 1872), or half size 768 x 936 (96 x 104 cells). Rows: idle, running-right, running-left, waving, jumping, failed, waiting, running, review. A row ends at its first fully transparent cell.
- Required rows: idle, running. Substitutes: listening ← review, sending ← waving, asking ← waiting, each falling back to idle.
- Alpha >= 128 is opaque, < 128 transparent. Soft-edge warning when more than 2 % of a frame's opaque edge pixels had partial alpha.
- Palette: one per pet, <= 255 colours + index 0 transparent, RGB565 in panel order (byte-swapped, as `ht_cell_frame_t` palettes are).
- Limits: source file <= 8 MB; pack <= 1 MB (1 048 576 B); at most 4 packs mapped (all + 3 engines); default `step_ms` 120.
- Resolution order: the engine's own pet → the "all" pet → the built-in pet.
- The source PNG is read by the daemon from a local path (the app and daemon share the machine; pet requests are local-only, never relayed, never in the E2EE request lists).
- Focus rule: the face emits the same runs in the same order every frame; a custom pet uses the built-in pet's run slots.
- Firmware host tests run with `bash devices/harness-device/firmware/test/run.sh` outside the IDF environment.

## Review Focus

- A PNG that is a valid sheet but palette-heavy (a photo-like render, thousands of colours): conversion must still finish under 2 s and stay <= 255 colours — Task 2 adds `quantize: 40k-colour sheet → 255 colours in under 2 s`.
- The cable pulled in the middle of a pack: the dial must keep showing the old pet and the daemon must resend on the next attach — Task 5 adds `sync: a cut transfer is resent after reattach`, Task 6 adds `pet_store_abort_keeps_current`.
- The same PNG applied to two engines: one pack, two mapping entries, sent once — Task 3 adds `store: same source twice → one pack`.
- Changing pets while a turn is on screen: no use-after-free — Task 7 adds `focus_swap_mid_scene` under the address sanitizer.
- An older daemon or older firmware on one side: nothing breaks, the app locks the section — Task 5 (`hello without pets: no pet traffic`) and Task 8 (`locked when the dial lacks pets`).

---

### Task 1: Read and validate a sprite sheet

**Files:**
- Create: `cli/src/cable/pets/sheet.ts`
- Test: `cli/src/cable/pets/sheet.spec.ts`
- Modify: `cli/package.json` (add `"pngjs": "^7.0.0"` and `"@types/pngjs"` dev)

**Interfaces:**
- Produces:
  - `type PetRow = 'idle' | 'runningRight' | 'runningLeft' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review'`
  - `interface RgbaFrame { width: number; height: number; data: Uint8Array /* RGBA */ }`
  - `interface PetSheet { cellW: number; cellH: number; rows: Record<PetRow, RgbaFrame[]> }`
  - `class PetSheetError extends Error { code: 'NOT_PNG' | 'BAD_SIZE' | 'NO_IDLE' | 'NO_RUNNING' | 'TOO_BIG' }`
  - `readPetSheet(path: string): Promise<PetSheet>` (throws `PetSheetError`)
  - `parsePetSheet(png: Buffer): PetSheet`

- [ ] **Step 1: Write the failing tests** — build sheets in memory with `PNG` from pngjs:
  - `accepts 1536x1872 and 768x936` → `cellW/cellH` 192/208 and 96/104.
  - `rejects 1000x1000` → `code === 'BAD_SIZE'`, message `The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)`.
  - `row ends at the first transparent cell` → idle with 3 drawn cells gives `rows.idle.length === 3`.
  - `empty running row` → `code === 'NO_RUNNING'`, message `The running row is empty`.
  - `file over 8 MB` → `code === 'TOO_BIG'` (stat before reading).
  - `not a PNG` → `code === 'NOT_PNG'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/pets/sheet.spec.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement `sheet.ts`** with `PNG.sync.read`; row order from Global Constraints.
- [ ] **Step 4: Run the same command** — Expected: PASS.

### Task 2: Convert frames — pixel-art factor, alpha, palette, small pet

**Files:**
- Create: `cli/src/cable/pets/convert.ts`
- Test: `cli/src/cable/pets/convert.spec.ts`

**Interfaces:**
- Consumes: `PetSheet`, `RgbaFrame` (Task 1).
- Produces:
  - `interface IndexedFrame { cols: number; rows: number; cell: number; cells: Uint8Array /* cols*rows, 0 = transparent */ }`
  - `interface PetScene { frames: number[] /* indices into ConvertedPet.frames */; stepMs: number; dx: number; dy: number }`
  - `interface ConvertedPet { palette: number[] /* RGB565 panel order, palette[0] unused */; frames: IndexedFrame[]; small: { w: number; h: number; loops: Record<'idle' | 'done' | 'asking', number[]> }; working: PetScene; listening: PetScene; sending: PetScene; failed: PetScene; warnings: string[] }`
  - `pixelArtFactor(frames: RgbaFrame[]): number` — the largest k dividing the cell size with every k x k block uniform in every frame; 1 otherwise.
  - `convertPet(sheet: PetSheet): ConvertedPet`

The small pet (`small`) replaces the spec's separate `rest` / `rest_small` scenes: its frames are the idle and waiting rows scaled so the 2x art fits 150 x 112 (aspect kept; nearest-neighbour when the pixel-art factor is even, box filter otherwise, then mapped onto the same palette), and `small.w/h` is half that 2x size — what `ht_pet_t.cells` expects. Loops: idle → idle frames with one waving pass every fourth cycle, done → idle, asking → waiting (idle if empty). `failed` is packed but the dial has no failed state yet; it is not drawn in this version.

- [ ] **Step 1: Write the failing tests:**
  - `pixelArtFactor: 4x-upscaled art → 4`, `photo-like → 1`, `factor 3 is refused when the cell is not divisible`.
  - `alpha 127 is transparent, 128 opaque`.
  - `palette has <= 256 entries and index 0 is unused`.
  - `quantize: 40k-colour sheet → 255 colours in under 2 s` (generate a gradient sheet; `performance.now()`).
  - `soft-edge warning above 2 %` → `warnings` contains `Soft edges will look jagged on the dial`.
  - `review row empty → listening uses idle's frame indices` (same numbers, no new frames).
  - `small pet 2x art fits 150 x 112`.
  - `RGB565 panel order`: pure red `#ff0000` → `0x00f8` (byte-swapped 0xf800).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/pets/convert.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `convert.ts`.** Palette by median cut over all opaque pixels of every used frame (all rows' frames at their cell resolution after dividing by the factor), then nearest-colour mapping. Frames are de-duplicated by content so substituted scenes share indices.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 3: The HPET pack and the pet store

**Files:**
- Create: `cli/src/cable/pets/pack.ts`, `cli/src/cable/pets/store.ts`
- Create: `devices/harness-device/firmware/test/vectors/pet_min.hpet` (written by the test below with `UPDATE_VECTORS=1`, checked otherwise)
- Test: `cli/src/cable/pets/pack.spec.ts`, `cli/src/cable/pets/store.spec.ts`

**Interfaces:**
- Consumes: `ConvertedPet` (Task 2), `readPetSheet` (Task 1).
- Produces:
  - `PACK_VERSION = 1`, `PACK_MAX_BYTES = 1_048_576`
  - `encodePack(pet: ConvertedPet, id: Uint8Array /* 8 bytes */): Buffer` (throws `PetSheetError('TOO_BIG')` with message `This pet is {x.x} MB; the limit is 1 MB`)
  - `decodePack(buf: Buffer): ConvertedPet & { id: string /* hex */ }` (throws on bad magic, version, length or CRC)
  - `type PetTarget = 'all' | string /* engine name */`
  - `interface PetMapping { all: string | null; engines: Record<string, string> }`
  - `class PetStore { constructor(dir: string); prepare(sourcePath: string): Promise<{ id: string; pet: ConvertedPet; bytes: number }>; apply(target: PetTarget, id: string): Promise<PetMapping>; reset(target: PetTarget): Promise<PetMapping>; mapping(): PetMapping; pack(id: string): Promise<Buffer>; mappedIds(): string[] }`

Layout (little-endian), exactly:

```
"HPET" · version u8 · flags u8 · id u8[8] (sha256(source)[0..8]) · length u32 (whole pack) · crc32 u32 (of every byte after this field)
palette: count u8 (entries incl. index 0) · count × u16
small:   w u16 · h u16 · loops idle/done/asking: each n u8 · n × u16 frame index
scenes:  working, listening, sending, failed: each n u8 · step_ms u16 · dx i16 · dy i16 · n × u16 frame index
frames:  count u16 · per frame: cols u8 · rows u8 · cell u8 · row_at u16[rows] · packed rows
```

Packed rows use the firmware's encoding (`terminal.h` `ht_cell_frame_t`): per row, pairs of (transparent cells to skip u8, opaque cells u8) each followed by those cells' indices, until `cols` are covered; `row_at[r]` is the byte offset of row r from the frame's first row byte.

`PetStore` keeps `<dir>/<id>.hpet`, `<dir>/<id>.png` (the source, for re-conversion when `PACK_VERSION` changes) and `<dir>/pets.json` (`PetMapping`). `apply` refuses with `PetSheetError('TOO_BIG', 'Up to 4 pets at once: reset one first')` when the mapping would reference a fifth distinct pack. Unreferenced packs are deleted on `apply`/`reset`.

- [ ] **Step 1: Write the failing tests:**
  - `round-trip: decodePack(encodePack(p)) deep-equals p`.
  - `bad CRC / bad magic / version 2 → throws`.
  - `over 1 MB → TOO_BIG with the MB message`.
  - `vector: encodePack(fixture) equals test/vectors/pet_min.hpet` (fixture = a 2-frame 8x8 pet built in code; `UPDATE_VECTORS=1` rewrites the file).
  - `store: same source twice → one pack` (apply to claude and codex, `mappedIds()` has one id, one `.hpet` on disk).
  - `store: fifth distinct pack is refused`.
  - `store: reset removes the mapping and deletes the unreferenced pack`.
  - `store: mapping survives a new PetStore on the same dir`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/pets/pack.spec.ts src/cable/pets/store.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement `pack.ts` and `store.ts`.** CRC-32 is IEEE (`zlib.crc32` in Node 22).
- [ ] **Step 4: Run** with `UPDATE_VECTORS=1` once, then without — Expected: PASS both times.

### Task 4: Requests the app calls

**Files:**
- Modify: `cli/src/lib/harnessDevices.ts` (add pet requests), `cli/src/services/devices.ts:315-325` (answer them), `cli/src/core/api.ts:833` (`DEVICES_REQUESTS` gains the four names)
- Test: `cli/src/lib/harnessDevices.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `PetStore` (Task 3).
- Produces (request → reply):
  - `pet_preview {path}` → `{ ok: true, id, bytes, colours, warnings, frames: { small: string[], working: string[], listening: string[], sending: string[] } /* PNG data URLs rendered from the decoded pack */ }` or `{ error: code, message }`
  - `pet_apply {target, id}` → `{ ok: true, mapping }` or `{ error, message }`
  - `pet_reset {target}` → `{ ok: true, mapping }`
  - `pet_status {}` → `{ mapping, dial: { supported: boolean, held: string[], sending: { id: string, percent: number } | null } }`
  - `HarnessDevicesService` gains `pets(): PetStore` and `petDial(): { supported: boolean; held: string[]; sending: { id: string; percent: number } | null }` and `petsChanged(): void` (Task 5 implements the last two).
- These four are answered for the owner on a local connection only: `asker.owner` as today, and they are NOT added to `cli/src/lib/e2ee/core.ts`'s lists.

- [ ] **Step 1: Write the failing tests:** `pet_preview on a valid sheet returns frames per scene as data URLs`; `pet_preview on a bad sheet returns the sheet error's code and message`; `pet_apply with an unknown id → { error: 'UNKNOWN_PET' }`; `pet_apply calls petsChanged`; `non-owner → OWNER_REQUIRED`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/harnessDevices.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Preview frames are rendered from `decodePack(encodePack(...))` so the preview is exactly what the dial gets; the store lives at `join(harnessHome, 'devices', 'pets')` created by `services/devices.ts`.
- [ ] **Step 4: Run** — Expected: PASS. Also `cd cli && npx vitest run src/services/devices.spec.ts` stays green.

### Task 5: Cable sync

**Files:**
- Modify: `cli/src/cable/cableFrame.ts` (`CableType.Pet = 0x05`), `cli/src/cable/cableSession.ts` (hello fields, `pet.*` handling, sync), `cli/src/cable/cableHost.ts` / `cableFleet.ts` (fan `petsChanged` out to sessions; expose `petDial()`)
- Create: `cli/src/cable/pets/sync.ts`
- Test: `cli/src/cable/pets/sync.spec.ts`, additions in `cli/src/cable/cableSession.spec.ts`
- Modify: `devices/harness-device/firmware/scripts/gen_cable_vectors.py` and `test/vectors/` only if the vectors enumerate frame types

**Interfaces:**
- Consumes: `PetStore` (Task 3), `FirmwareTransfer` (existing, `cableSession.ts`; constructed with the pack bytes, a label, a slice writer that sends `encodeCableFrame(CableType.Pet, slice)`, and the log).
- Produces:
  - `planPetSync(mapping: PetMapping, held: string[]): { map: PetMapping; send: string[]; drop: string[] }` — send = mapped ids not held, drop = held ids not mapped.
  - Messages daemon → dial: `pet.map {all, engines}`, `pet.offer {id, size, crc}`, `pet.drop {id}`. Dial → daemon: `pet.accept {id}`, `pet.progress {id, written}`, `pet.done {id}`, `pet.error {id, reason: 'memory' | 'crc' | 'version' | 'busy'}`.
  - `hello` from the dial: `pets: 1` and `petIds: string[]`.

Sequencing: after `hello` with `pets: 1`, the session runs `planPetSync(store.mapping(), petIds)`: `pet.map` first, then each `pet.drop`, then one transfer at a time (`pet.offer` → `pet.accept` → slices on credit from `pet.progress` → `pet.done`). Never interleave a pet transfer with a firmware transfer: pets wait while `this.transfer` (firmware) exists. The store is read by the devices process itself, so a daemon restart cannot lose the mapping (the app_swarms start-up race of 2026-10-08 does not apply).

- [ ] **Step 1: Write the failing tests:**
  - `planPetSync: held nothing → send all mapped, map first`.
  - `planPetSync: held stale → drop it`.
  - `session: hello without pets: no pet traffic`.
  - `session: hello with pets:1 and petIds [] → pet.map then pet.offer for each mapped pack`.
  - `session: a cut transfer is resent after reattach` (close the fake link mid-slices; new hello with `petIds: []` → offered again).
  - `session: pet.error memory → reported in petDial and not retried this session`.
  - `session: firmware offer pending → pet transfer waits`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/pets/sync.spec.ts src/cable/cableSession.spec.ts` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `cd cli && npx vitest run src/cable` — Expected: PASS.

### Task 6: Firmware pet store

**Files:**
- Create: `devices/harness-device/firmware/main/pet_store.c`, `main/pet_store.h`
- Modify: `main/cable_frame.h` (`CABLE_TYPE_PET 0x05`), `main/cable_client.c` (hello `pets`/`petIds`; `pet.map`, `pet.offer`, `pet.drop` handlers; `CABLE_TYPE_PET` slices in `on_frame`), `main/CMakeLists.txt` (add `pet_store.c`)
- Test: `devices/harness-device/firmware/test/test_pet_store.c`, wired into `test/run.sh`

**Interfaces:**
- Consumes: `test/vectors/pet_min.hpet` (Task 3), `ht_pet_t` / `ht_cell_frame_t` (`pets.h`, `terminal.h`).
- Produces:
  - `bool pet_store_offer(const char *id, uint32_t size, uint32_t crc)` — allocates `size` bytes (PSRAM on the device via `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)`, `malloc` on the host); false → caller sends `pet.error memory`.
  - `bool pet_store_slice(const uint8_t *data, size_t len)`; `int pet_store_finish(void)` → 0 ok, else `PET_ERR_CRC` / `PET_ERR_VERSION` / `PET_ERR_SHAPE`.
  - `void pet_store_abort(void)` — discards a partial pack (called when the link drops).
  - `void pet_store_map(const char *all, const char *const *engines, const char *const *ids, size_t n)`; `void pet_store_drop(const char *id)`.
  - `const ht_pet_t *pet_store_lookup(const char *engine)` — engine's → all → NULL.
  - `size_t pet_store_held(char ids[][17], size_t max)` — for `petIds` in hello.
  - `void pet_store_release_frame(void)` — called by the UI after each frame; a dropped pack is freed only after the frame that last referenced it.
- At most 4 packs held; a fifth `offer` while 4 are held answers `busy`.

The `ht_pet_t` built per pack: `engine` = NULL (not used for lookup), `w/h` = `small.w/h`, `cells` = the small frames, `loops[HT_PET_IDLE|HT_PET_DONE|HT_PET_ASKING]` from the pack, `loops[HT_PET_WORKING]` = idle (unused while the working scene plays), `working_scene`/`listening_scene`/`sending_scene` from the scenes, `alert_scene` = NULL, `steps` = the longest loop (<= `HT_PET_STEPS`, longer loops are cut).

- [ ] **Step 1: Write the failing tests** in `test_pet_store.c`: `parse_vector` (offer+slices+finish of `pet_min.hpet` → 0, lookup("claude") after mapping all → non-NULL with the vector's w/h and frame cells); `reject_bad_crc`; `reject_version_2`; `pet_store_abort_keeps_current` (map A, start B, abort → lookup still A); `engine_before_all`; `fifth_offer_busy`; `drop_frees_after_release` (drop while referenced, run `pet_store_release_frame`, then ASan sees no leak/use-after-free).
- [ ] **Step 2: Run** `bash devices/harness-device/firmware/test/run.sh` — Expected: FAIL at `test_pet_store` (missing source).
- [ ] **Step 3: Implement `pet_store.c` and the `cable_client.c` handlers.** `on_frame` routes `CABLE_TYPE_PET` like `CABLE_TYPE_FW` (straight to `pet_store_slice`, then `pet.progress` credit as `fw` does). On link loss call `pet_store_abort()`.
- [ ] **Step 4: Run** `run.sh` — Expected: all PASS. Then `source ~/esp/esp-idf/export.sh && idf.py build` in `devices/harness-device/firmware` — Expected: builds.

### Task 7: Focus draws the custom pet

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/focus.c:166-173` (`pet_for`), the working-alert drawing (the count bubble), and the frame end (`pet_store_release_frame`)
- Test: `devices/harness-device/firmware/test/test_character.c` (add cases; add `pet_store.c` to its `cc` line in `run.sh`)

**Interfaces:**
- Consumes: `pet_store_lookup`, `pet_store_release_frame` (Task 6).
- Produces: `pet_for(f)` returns `pet_store_lookup(f->engine)` when non-NULL, else the built-in lookup as today.

The working alert for a pet without `alert_scene`: a blue `0x006fff` rounded bubble 68 x 44 (the built-in `ALERT_W, ALERT_H`) whose centre is the working scene's top-right corner inset 8 px, the count in `ht_lv_inter_med_26` (`9+` in `ht_lv_inter_20`), occupying the same run slots (n == 1 bubble, n == 2 count) the built-in alert uses, so the run count is unchanged.

- [ ] **Step 1: Write the failing tests:** `focus_custom_pet_resting` (map the vector as "all"; resting face draws a cell sprite from the custom frames; run count equals the built-in pet's); `focus_custom_pet_working_alert` (bubble fill `0x006fff` at the top-right, count drawn); `focus_custom_ink_inside_r230`; `focus_swap_mid_scene` (draw, drop the pack, draw again, release; ASan clean); `focus_builtin_unchanged` (no custom mapping → existing golden rasters equal).
- [ ] **Step 2: Run** `bash devices/harness-device/firmware/test/run.sh` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS, existing tests unchanged.

### Task 8: The Pet section in the app

**Files:**
- Create: `desktop/lib/devices/pet_settings.dart`
- Modify: `desktop/lib/devices/device_settings.dart` (insert the section after "Faces"), `desktop/lib/devices/devices_controller.dart` (pet calls and state), `desktop/lib/state/app_state.dart` (requests, local connection only, next to `setHostDeviceSettings`)
- Test: `desktop/test/pet_settings_test.dart`

**Interfaces:**
- Consumes: the four requests (Task 4).
- Produces:
  - `AppState`: `Future<Map<String, dynamic>> petRequest(String machineId, String type, Map<String, Object?> payload)` (6 s timeout; 30 s for `pet_preview`).
  - `DevicesController`: `Future<PetPreview?> previewPet(String key, String path)`, `Future<String?> applyPet(String key, String target, String id)` (null = ok, else the message), `Future<void> resetPet(String key, String target)`, `PetStatus? petStatus(String key)`, refreshed every 1 s while `sending` is non-null.
  - `PetSettingsSection({required HarnessDevice device, required DevicesController controller})`.

Copy (exact): section title `Pet`; toggle `Apply to all` / `Per engine`; row value `Default`; buttons `Choose file…`, `Reset to default`, `Apply`, `Cancel`; progress `Sending to dial… {n} %`, done `On dial ✓`; links `Download template`, `Browse pets on petdex.dev` (`https://petdex.dev`); locked `Update the dial’s firmware to use custom pets`. Per-engine rows list the engines of the user's agents (from the agents the app already knows), Claude, Codex, Muse first. The preview shows tabs `Rest`, `Working`, `Listening`, `Asking` cycling the data-URL frames at the pack's `step_ms`, plus `{bytes} · {colours} colours` and each warning. "Choose file…" uses the app's existing file picker; dropping a `.png` on the row does the same.

- [ ] **Step 1: Write the failing widget tests:** `locked when the dial lacks pets`; `all mode shows one row, per-engine one per engine`; `choosing a file shows the preview tabs and size`; `a sheet error is shown in the row`; `apply shows progress then On dial ✓`; `reset returns the row to Default`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/pet_settings_test.dart` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, then `cd desktop && flutter analyze lib/devices` — Expected: PASS, no issues.

### Task 9: The template

**Files:**
- Create: `devices/harness-device/firmware/scripts/gen_pet_template.py` (writes `desktop/assets/pets/pet-template.zip` containing `pet-blank.png`, `pet-guide.png`, `README.md`; `--check` mode compares)
- Modify: `desktop/pubspec.yaml` (asset), `test/run.sh` (`gen_pet_template.py --check` beside the other generators), `desktop/lib/devices/pet_settings.dart` (`Download template` saves the asset via the save dialog)

`pet-blank.png`: 1536 x 1872, fully transparent. `pet-guide.png`: same size, 1 px grid at every cell edge, each row's name at its left cell's top-left in 14 px text, rows idle and running marked `required`. `README.md`: the row table and fallbacks from Global Constraints, the alpha and palette limits, the 1 MB limit, a link to petdex.dev.

- [ ] **Step 1:** Run `python3 devices/harness-device/firmware/scripts/gen_pet_template.py --check` — Expected: FAIL (script missing).
- [ ] **Step 2: Implement** with `/usr/local/bin/python3` + PIL; deterministic output (fixed zip timestamps).
- [ ] **Step 3:** Run it without `--check`, then with `--check` — Expected: PASS. Feed `pet-guide.png` with the grid removed into `pet_preview` via the Task 4 test helper — Expected: `BAD_SIZE` never; `NO_IDLE` (blank sheet) as the documented error.

### Task 10: On the device

**Files:** none new; this is the acceptance run.

- [ ] **Step 1:** Flash the dial following the owner's procedure (quit Harness, set the flasher flag, `harness stop`, verify the MAC with `esptool read_mac`, `idf.py -p /dev/cu.usbmodem21301 flash`, remove the flag, `harness start`, `open -a Harness`).
- [ ] **Step 2:** Run the dev daemon and app from this branch; apply a petdex sheet to all and a template-drawn sheet to Claude. Expected: both appear within 3 s; dial log shows `pet.done`; `raster_max_us` in the `habitat: alive` line stays within 10 % of the built-in pet's.
- [ ] **Step 3:** Unplug and replug, then `harness stop && harness start`. Expected: the pets come back by themselves; daemon log shows `pet.offer` only for packs the dial lacked.
- [ ] **Step 4:** Report times, sizes and `raster_max_us` to the owner.
