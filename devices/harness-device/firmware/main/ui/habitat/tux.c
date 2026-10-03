#include "tux.h"
#include <string.h>
#include "tux_moods.inc"
#include "character_fonts.inc"

static ht_character_mood_t valid_mood(ht_character_mood_t mood)
{
    return (unsigned)mood < HT_CHARACTER_MOODS ? mood : HT_CHARACTER_IDLE;
}
bool ht_tux_motion_tick(ht_character_motion_t *m, uint32_t now, ht_character_mood_t mood,
                        bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity)
{
    mood = valid_mood(mood);
    return ht_character_motion_step(m, &tux_animations[mood], now, mood,
                                    quiet, visible, down, x, level, activity, true);
}
void ht_tux_draw(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame,
                 uint16_t ink, ht_character_size_t size, int y)
{
    (void)ink;
    const ht_font_t *fonts[] = {&character_font_12, &character_font_8, &character_font_6,
                                &character_font_4, &character_font_4};
    const int offsets[] = {-12, 12, 9, 6, 6};
    if ((unsigned)size > HT_CHARACTER_QUICK) size = HT_CHARACTER_FULL;
    const ht_font_t *font = fonts[size];
    y += offsets[size];
    ht_character_mood_t mood = valid_mood(f->mood);
    unsigned index = tux_starts[mood] + frame % tux_animations[mood].frames;
    const uint8_t *landmarks = tux_landmarks[index];
    bool dim = mood == HT_CHARACTER_OFFLINE || mood == HT_CHARACTER_ASLEEP;
    bool eyes = f->pose.blink || f->pose.pressed || f->pose.look;
    bool listening = mood == HT_CHARACTER_LISTENING;
    int x = (HT_WIDTH - TUX_COLS * font->width) / 2;
    for (int row = 0; row < TUX_ROWS; row++) {
        char line[TUX_COLS + 1];
        memcpy(line, tux_rows[index][row], sizeof line);
        if (eyes) for (int eye = 0; eye < 2; eye++)
            if (row == landmarks[eye * 2 + 1]) memset(line + landmarks[eye * 2] - 1, ' ', 3);
        if (listening && row == landmarks[5]) memset(line + landmarks[4] - 3, ' ', 7);
        if (ht_ascii_text(s, x, y + row * font->height, TUX_COLS * font->width, font,
                          f->dim, s->background, line, TUX_COLS) && !dim)
            s->runs[s->count - 1].colors = tux_colors[index][row];
    }
    // Registered expression cells share the same gaze, blink and microphone state
    // as Tim. Static artwork/colour buffers remain immutable between DMA scenes.
    uint16_t fg = dim ? f->dim : TUX_FACE_INK;
    if (eyes) {
        char gaze[4] = " @ ";
        if (f->pose.blink && !f->pose.pressed) memcpy(gaze, "---", 3);
        else { memset(gaze, ' ', 3); gaze[f->pose.look < 0 ? 0 : f->pose.look > 0 ? 2 : 1] = '@'; }
        for (int eye = 0; eye < 2; eye++)
            ht_ascii_text(s, x + (landmarks[eye * 2] - 1) * font->width,
                          y + landmarks[eye * 2 + 1] * font->height, 3 * font->width,
                          font, fg, s->background, gaze, 3);
    }
    if (listening) {
        static const char mouth[5][8] = {"   .   ", "  ---  ", "  (o)  ", " ( o ) ", " ( O ) "};
        unsigned level = f->pose.level > 4 ? 4 : f->pose.level;
        ht_ascii_text(s, x + (landmarks[4] - 3) * font->width,
                      y + landmarks[5] * font->height, 7 * font->width,
                      font, fg, s->background, mouth[level], 7);
    }
    if (f->pose.mail)
        ht_character_letter(s, f, font, x + 35 * font->width,
                            y + (landmarks[5] + 3 - (f->pose.mail == 2)) * font->height);
}
