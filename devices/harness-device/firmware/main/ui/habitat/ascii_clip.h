#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Immutable, generated text artwork. Frames refer to shared rows; each row is
// nibble RLE: high nibble = repeat count minus one, low nibble = alphabet slot.
// At most 16 printable ASCII symbols and 65535 encoded bytes per clip. Each
// creature owns its palette/frames; the renderer and decoder remain shared.
// Arrays are generated with these exact lengths, not loaded from the wire.
typedef struct {
    uint8_t cols, rows, symbols;
    uint16_t frames, unique_rows, data_bytes;
    const char *alphabet;              // symbols bytes
    const uint16_t *frame_rows;        // frames * rows entries
    const uint16_t *row_offsets;       // unique_rows + 1 entries
    const uint8_t *data;               // data_bytes bytes
} ht_ascii_clip_t;

// Decodes only the requested row into caller storage, including a terminator.
// Rejects invalid indices, row lengths and symbols. No heap or mutable cache.
bool ht_ascii_clip_row(const ht_ascii_clip_t *clip, unsigned frame, unsigned row,
                       char *out, size_t capacity);
#ifdef DEVICE_LAYOUT_BENCH
void ht_ascii_clip_short_runs(bool enabled);
#endif
