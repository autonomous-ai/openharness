#include "ascii_clip.h"
#include <string.h>

#ifdef DEVICE_LAYOUT_BENCH
static bool short_runs = true;
void ht_ascii_clip_short_runs(bool enabled) { short_runs = enabled; }
#endif

bool ht_ascii_clip_row(const ht_ascii_clip_t *clip, unsigned frame, unsigned row,
                       char *out, size_t capacity)
{
    if (!out || !capacity) return false;
    out[0] = 0;
    if (!clip || !clip->cols || capacity <= clip->cols || !clip->symbols ||
        clip->symbols > 16 || frame >= clip->frames || row >= clip->rows ||
        !clip->alphabet || !clip->frame_rows || !clip->row_offsets || !clip->data)
        return false;
    unsigned key = clip->frame_rows[frame * clip->rows + row];
    if (key >= clip->unique_rows) return false;
    unsigned begin = clip->row_offsets[key], end = clip->row_offsets[key + 1];
    if (begin > end || end > clip->data_bytes) return false;
    unsigned used = 0;
    for (unsigned i = begin; i < end; i++) {
        unsigned code = clip->data[i] & 15, count = (clip->data[i] >> 4) + 1;
        if (code >= clip->symbols || count > clip->cols - used) goto invalid;
        unsigned char ink = clip->alphabet[code];
        if (ink < 32 || ink > 126) goto invalid;
        // Most authored strokes are one cell. Avoid a variable-length library
        // fill for those without retaining a decoded frame or adding RAM.
#ifdef DEVICE_LAYOUT_BENCH
        if (short_runs && count == 1)
#else
        if (count == 1)
#endif
            out[used] = (char)ink;
        else
            memset(out + used, ink, count);
        used += count;
    }
    if (used != clip->cols) goto invalid;
    out[used] = 0;
    return true;
invalid:
    out[0] = 0;
    return false;
}
