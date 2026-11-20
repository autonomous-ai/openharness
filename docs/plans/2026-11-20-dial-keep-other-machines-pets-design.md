# A dial keeps the pets another computer put on it

Status: approved by the PM 2026-11-20 (option 1, CLI only) · branch `fix/dial-keep-other-machines-pets`

## The bug

Reported by Ken's side on 2026-11-20 while preparing a Windows desk test with a real dial.

`planPetSync` (`cli/src/cable/pets/sync.ts`) returns `drop` = every pack the dial holds (its hello's `petIds`) that this
computer's `pets.json` does not map, and `runPetSync` (`cli/src/cable/cableSession.ts`) runs it on every dial hello and
whenever the mapping changes. Plug a dial into a second computer, or into a fresh install (empty mapping), and it sends
`pet.drop` for every pack the first computer put there. The first computer re-sends them on its next attach (it keeps
the `.hpet`), so they are lost for good only when that computer is gone; until then each move costs a re-transfer of up
to 1 MB a pack.

What the dial holds (`devices/harness-device/firmware/main/pet_store.c`): at most 4 packs (`PET_STORE_MAX_PACKS`), each
at most 1 MB, in PSRAM only. The dial runs on its battery, so moving the cable keeps them; a dial reboot loses them all.
It does not know which computer sent a pack.

## What stays as it is

Pets belong to the computer that chose them (the 2026-10-08 custom-pet design: the dial is a cache the daemon fills on
every attach). `pet.map` still replaces the dial's whole mapping, so on computer B the dial draws B's pets, or the
built-in one when B maps none. This fix does not make A's pets show on B. No firmware or protocol change.

## The rule

**Own and spare.** On each link the session knows a set of **own** packs: every pack it sent on this link (the dial
answered `pet.done`, or a hello listed the pack in flight, which ends that transfer as stored), and every held pack its
mapping named at any sync on this link. Every other pack the dial holds that the mapping does not name is **spare**.
The set lives in memory and is cleared with the rest of the per-link pet state when the link closes.

A computer removes from the dial only:

1. **Own stale packs**: an own pack its mapping no longer names. Dropped at once, as today, so changing the pet while
   the dial is attached still frees the old one, also when the dial already held it at the hello.
2. **A spare pack, only for room, only when it is needed**: just before a `pet.offer`, when the dial already holds
   `MAX_PACKS` (4) packs, drop the first spare pack in the order the dial listed them, then offer. Never ahead of
   time: a mapped pack that is never offered (refused for crc, version or shape, unreadable, or newer than the dial
   reads) costs another computer nothing.
3. **On a refusal for memory or busy** while a spare pack is held: in the `pet.error` handler, when the refused pack
   has not been retried on this link yet, drop the first spare pack (which sets `petDropSent`) before the existing
   once-per-pack-and-link retry is scheduled (`PET_RETRY_MS`). The drop is part of that once: a keepalive hello that
   forgives the refusal and offers again drops nothing more. A pack whose latest offer on this link came right after a
   rule-2 drop gets no second drop, only the retry: that drop's memory is still settling. The 4 slots fit 4 packs of the
   1 MB limit in the dial's PSRAM, so this is the safety net for a dial whose memory is tighter than its slot count;
   the slot is freed at once, the memory at the dial's next frame, which is why the retry waits.

A pack this computer replaced while the dial was elsewhere is spare on the next attach (it is never shown: the mapping
does not name it) and goes when its slot is needed. No state file: the store deletes a replaced pet's files
(`PetStore.sweep`), so disk cannot say which packs were once ours, and a record of sent ids was option 2, which the PM
did not take.

The half-sent pack the stall timer drops (`armPetStall`) is unchanged: it is this computer's own transfer.

## Where

- `cli/src/cable/pets/sync.ts`: `planPetSync(mapping, held, own)` returns `map`, `send`, `drop` (rule 1) and `spare`
  (spare packs in the dial's order). Pure.
- `cli/src/cable/cableSession.ts`: keeps the per-link own set, drops a spare pack before an offer into a full dial
  (rule 2) and in the `pet.error` path (rule 3). Devices process only; nothing in the daemon core (`src/core/`), no new
  file the core loads.
- `pets.json` and the packs stay where `harnessHome.ts` puts them (`HARNESS_DEVICES_DIR/pets`); nothing new is stored.

## Logs and measures

Existing lines only, ids, counts and error kinds (#4458/#4488). A kept spare pack is not logged per hello (a
keepalive hello would repeat it); a spare pack dropped for room logs `cable: pet <id> dropped for room` once.

## Tests (red first)

Red today:
- `sync.spec.ts`: an empty mapping and a dial holding another computer's packs → `drop` empty, `spare` = those packs
  in the dial's order; a held pack that is not own and not mapped is spare, not dropped.
- `cableSession.spec.ts`:
  - two computers: computer A's session stores its packs; a second session with an empty mapping greets the same dial
    (`petIds` = A's packs) → `pet.map` with the empty mapping and no `pet.drop`;
  - a dial holding 4 foreign packs and one mapped pack missing → exactly one `pet.drop` (the first listed), sent just
    before the `pet.offer`; a mapped pack refused for crc drops nothing more;
  - a dial holding 1 foreign pack with free slots, a `memory` refusal → that pack is dropped (none at the hello), the
    refused one is offered once more after 1.5 s, and a keepalive hello with a second refusal drops nothing more
    (replaces the spec at `cableSession.spec.ts:3560`).

Guards (pass today, must keep passing): a pack the dial held at the hello and the mapping named, then unmapped by
`petsChanged` → `pet.drop` at once; a pack sent on this link, then unmapped → `pet.drop` at once. The existing specs
that expect a foreign pack dropped at the hello change to the new rule.

## Verification

None beyond the unit specs: there is no cable pet end-to-end suite, and the session specs drive the real
`CableSession` against a fake dial (`LoopbackPort`). Real dials are not touched and nothing is flashed.

## Platforms

macOS, Linux and Windows alike: the change is platform-free TypeScript in the devices process.
