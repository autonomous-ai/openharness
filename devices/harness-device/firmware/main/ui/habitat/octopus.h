#pragma once
#include "tim.h"
#include "character_layout.h"

enum { HT_OCTOPUS_FRAMES = 63, HT_OCTOPUS_COLS = 54, HT_OCTOPUS_ROWS = 27,
       HT_OCTOPUS_DURATION = 5210 };
// Shared by the reading compositor and its touch regions. The text ends above
// the bottom arc; moving it must never make its target cover the portrait.
#if HT_FACE_PX >= 720
// The Pro, 720 square. Derived in devices/harness-pro/mockup/ui-octopus.html and measured here:
//   reading  a font_8 portrait is 27*8 = 216 tall, so 126 -> 342, and the recap starts at 366.
//            Six rows of mono_28 is 228 px, ending at 594 — just clear of the status band at 600.
//   brief    a font_10 portrait is 270 tall, 126 -> 396, and three rows from 420 end at 534.
// Nothing tapers: there is no chord to taper to, which is most of what the square buys the recap.
enum { HT_OCTOPUS_BRIEF_Y = 126, HT_OCTOPUS_READING_Y = 126,
       HT_OCTOPUS_BRIEF_TEXT_Y = 420, HT_OCTOPUS_READING_TEXT_Y = 366 };
#else
enum { HT_OCTOPUS_BRIEF_Y = 96, HT_OCTOPUS_READING_Y = 92,
       HT_OCTOPUS_BRIEF_TEXT_Y = 284, HT_OCTOPUS_READING_TEXT_Y = 224 };
#endif
extern const ht_font_t ht_octopus_font_2, ht_octopus_font_4, ht_octopus_font_6, ht_octopus_font_8, ht_octopus_font_10, ht_octopus_font_12;
#if HT_FACE_PX >= 720
// The Pro's two rungs. 27*16 = 432 px of companion on a 720 face, and 27*14 = 378 for the state that
// has to share the page with a detail line. See the ladder note in scripts/gen_octopus.py.
extern const ht_font_t ht_octopus_font_14, ht_octopus_font_16;
#endif
#ifdef DEVICE_LAYOUT_BENCH
void ht_octopus_fast_scene(bool enabled);
#endif
typedef ht_character_motion_t ht_octopus_motion_t;

// Wall-clock poses, no frame backlog. Pause the large body during touch and
// microphone capture; only the small face reacts while recording.
bool ht_octopus_motion_tick(ht_octopus_motion_t *m, uint32_t now, ht_tim_mood_t mood,
                            bool quiet, bool visible, bool down, int x,
                            unsigned level, uint32_t activity);
// The straight comparison title stays above either size of companion.
static inline int ht_octopus_title_y(bool result, bool compact)
{
    (void)result; (void)compact;
#if HT_FACE_PX >= 720
    // Under the tab row at y=40, which is chrome about which book you are in; the name is the content.
    return 80;
#else
    return 41;
#endif
}
// A completed result gets tapered rows and a 108 px portrait (162 px for brief
// results). Roomy reading uses six rows; the default preserves benchmark geometry. NULL keeps
// the large working/listening face. The recap dismisses locally; the portrait
// remains the voice surface.
void ht_octopus_face(ht_scene_t *scene, const ht_tim_face_t *face, uint8_t frame, uint16_t ink,
                     const char *recap);
// Portrait only for a local gesture preview; same immutable ASCII frames.
void ht_octopus_portrait(ht_scene_t *scene, const ht_tim_face_t *face, uint8_t frame, uint16_t ink,
                         const ht_font_t *font, int y);
// Three centered text rows, word-boundary
// clipping, and one spaced desktop arrow on every nonempty summary.
void ht_recap_lines(ht_scene_t *scene, int y, uint16_t ink, const char *recap);
// Short answers borrow spare reading space for a larger, still-secondary companion.
bool ht_octopus_short_recap(const char *recap);

void ht_octopus_draw(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                     ht_character_size_t size, int y);
