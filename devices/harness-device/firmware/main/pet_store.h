// The custom pets the daemon sends over the cable (cli/src/cable/pets/pack.ts is the source of truth for
// the HPET pack format). Up to four packs are held in PSRAM; a mapping says which pack draws for which
// engine, and `pet_store_lookup` hands the UI an ht_pet_t built from the pack.
//
// DELIBERATELY FREE OF ESP-IDF headers except where ESP_PLATFORM is defined: pet_store.c also compiles on a
// host, which is how test/test_pet_store.c runs.
//
// Threads: the cable task calls everything except lookup and release_frame; the UI task calls those two.
// One mutex guards the table. A pack is immutable once published, so the pointer lookup returns stays valid
// without the mutex until the UI calls `pet_store_release_frame`; a pack dropped or replaced meanwhile is
// parked and freed by that call (see pet_store.c).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ui/habitat/pets.h"

#define PET_STORE_MAX_PACKS 4
#define PET_STORE_MAX_BYTES (1024u * 1024u)

// pet_store_finish results besides 0.
#define PET_ERR_CRC     1
#define PET_ERR_VERSION 2
#define PET_ERR_SHAPE   3

// Start receiving pack `id` (16 hex chars) of `size` bytes whose CRC-32 is `crc`. Replaces a partial pack
// still being received. False: not enough memory, a bad size/id, or four other packs already held (the
// caller tells the two apart with pet_store_held and answers `busy` or `memory`).
bool pet_store_offer(const char *id, uint32_t size, uint32_t crc);
// Append received bytes. False: nothing is being received or more bytes than offered; the partial pack is
// discarded.
bool pet_store_slice(const uint8_t *data, size_t len);
// Verify and parse the received pack and hold it. 0 or PET_ERR_*; on error the partial pack is discarded
// and every held pack is untouched.
int pet_store_finish(void);
// Discard only the partial pack being received (the link dropped). Held packs stay.
void pet_store_abort(void);

// Replace the mapping: `all` (NULL = none) and engines[i] -> ids[i].
void pet_store_map(const char *all, const char *const *engines, const char *const *ids, size_t n);
// Forget a held pack, or abort the partial pack still being received under that id. A held pack is is freed once the frame that may still draw it is over.
void pet_store_drop(const char *id);
// The pet for `engine`: the engine's own mapping, else "all", else NULL, from the snapshot the last
// pet_store_release_frame took: map, drop and finish only STAGE a change, so every lookup between two releases
// agrees. Valid until the next release_frame.
const ht_pet_t *pet_store_lookup(const char *engine);
// The ids of the held packs, 16 chars + NUL each; returns how many were written (<= max).
size_t pet_store_held(char ids[][17], size_t max);
// The UI is done with the pointers lookup returned this frame: apply the staged mapping and packs (the new snapshot
// for the lookups that follow) and free the packs the old snapshot held that are gone. Render task, once per take.
void pet_store_release_frame(void);
