#include "octopus.h"
#include <string.h>
#include "ascii_clip.h"

#include "octopus_art.inc"
_Static_assert(sizeof octopus_frame_rows / sizeof octopus_frame_rows[0] == HT_OCTOPUS_FRAMES * HT_OCTOPUS_ROWS, "octopus poses");
#ifdef DEVICE_LAYOUT_BENCH
static bool fast_scene = true;
void ht_octopus_fast_scene(bool enabled) { fast_scene = enabled; }
#endif

bool ht_octopus_motion_tick(ht_octopus_motion_t *m, uint32_t now, ht_tim_mood_t mood,
                            bool quiet, bool visible, bool down, int x,
                            unsigned level, uint32_t activity)
{
    static const ht_character_animation_t animation = {HT_OCTOPUS_FRAMES, HT_OCTOPUS_DURATION, octopus_ends};
    return ht_character_motion_step(m, &animation, now, mood, quiet, visible, down, x, level, activity, true);
}

static void expression(char row[55], int y, int eye, const ht_tim_face_t *f)
{
    if (y == eye) {
        const char *eyes = NULL;
        char gaze[4] = " @ ";
        if (f->pose.pressed || f->pose.look) {
            memset(gaze, ' ', 3);
            gaze[f->pose.look < 0 ? 0 : f->pose.look > 0 ? 2 : 1] = '@';
            eyes = gaze;
        } else if (f->pose.blink || f->mood == HT_TIM_ASLEEP) eyes = "---";
        else if (f->mood == HT_TIM_ATTENTION) eyes = " O ";
        else if (f->mood == HT_TIM_DONE || f->mood == HT_TIM_BOOPED) eyes = " ^ ";
        else if (f->mood == HT_TIM_OFFLINE) eyes = " - ";
        if (eyes) { memcpy(row + 19, eyes, 3); memcpy(row + 30, eyes, 3); }
    }
    if (f->unread) {
        // The right tentacle stays raised while unread messages remain. It is
        // part of the same ASCII portrait, registered to the bobbing head;
        // no badge, extra run, independent timer or animated asset.
        static const struct { uint8_t x; const char *ink; } arm[] = {
            {46, ",;oo,"}, {45, ":#..#;"}, {45, ";# .:;"},
            {45, ";#;"}, {45, ";#;"}, {44, " ;#;"},
            {43, " ;##"}, {42, " .##;"}, {41, " .##;"},
            {39, " .x##;"}, {36, "  .x##%;."}, {33, "  .x####xo."}
        };
        int pose_row = y - eye + 5 + (f->pose.mail == 2);
        if (pose_row >= 0 && pose_row < 12) {
            memset(row + 42, ' ', 12);
            memcpy(row + arm[pose_row].x, arm[pose_row].ink, strlen(arm[pose_row].ink));
        }
    }
    if (f->mood == HT_TIM_LISTENING && (y == eye + 2 || y == eye + 3)) {
        static const char *mouth[5][2] = {
            {"###.###", "#######"}, {"##---##", "#######"}, {"##(o)##", "#######"},
            {"#( o )#", "##(_)##"}, {"#( O )#", "#(___)#"}
        };
        unsigned level = f->pose.level > 4 ? 4 : f->pose.level;
        memcpy(row + 23, mouth[level][y - eye - 2], 7);
    }
}

void ht_octopus_portrait(ht_scene_t *s, const ht_tim_face_t *f, uint8_t frame, uint16_t ink,
                         const ht_font_t *font, int y)
{
    if (frame >= HT_OCTOPUS_FRAMES) frame = 0;
    int x = (HT_WIDTH - HT_OCTOPUS_COLS * font->width) / 2;
    if (f->mood == HT_TIM_OFFLINE || f->mood == HT_TIM_ASLEEP) ink = f->dim;
    for (int i = 0; i < HT_OCTOPUS_ROWS; i++) {
        char row[HT_OCTOPUS_COLS + 1];
        if (!ht_ascii_clip_row(&octopus_clip, frame, i, row, sizeof row)) {
            memset(row, ' ', HT_OCTOPUS_COLS); row[HT_OCTOPUS_COLS] = 0;
        }
        expression(row, i, octopus_eyes[frame], f);
#ifdef DEVICE_LAYOUT_BENCH
        if (!fast_scene)
            ht_text(s, x, y + i * font->height, HT_OCTOPUS_COLS * font->width, font, ink, s->background, row);
        else
#endif
            ht_ascii_text(s, x, y + i * font->height, HT_OCTOPUS_COLS * font->width,
                          font, ink, s->background, row, HT_OCTOPUS_COLS);
    }
    if (f->pose.mail) {
        int top = octopus_eyes[frame] - 7 - (f->pose.mail == 2);
        if (top < 0) top = 0;
        ht_character_letter(s, f, font, x + 43 * font->width, y + top * font->height);
    }
}

void ht_octopus_draw(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                     ht_character_size_t size, int y)
{
    const ht_font_t *fonts[] = {&ht_octopus_font_10, &ht_octopus_font_8, &ht_octopus_font_6,
                                &ht_octopus_font_4, &ht_octopus_font_4};
    if ((unsigned)size > HT_CHARACTER_QUICK) size = HT_CHARACTER_FULL;
    ht_octopus_portrait(s, f, frame, ink, fonts[size], y);
}
bool ht_octopus_short_recap(const char *recap)
{
    return recap && *recap && ht_text_rows(recap, &ht_mono_20, 324) <= 3;
}
void ht_octopus_face(ht_scene_t *s, const ht_tim_face_t *f, uint8_t frame, uint16_t ink, const char *recap)
{
    ht_character_layout(s, f, frame, ink, recap, ht_octopus_draw);
}
