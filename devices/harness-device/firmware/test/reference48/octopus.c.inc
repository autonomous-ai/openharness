#include "octopus.h"
#include <string.h>
#include "perf_bench.h"

#include "octopus_art.inc"
_Static_assert(sizeof octopus_frames / sizeof octopus_frames[0] == HT_OCTOPUS_FRAMES, "octopus poses");

bool ht_octopus_motion_tick(ht_octopus_motion_t *m, uint32_t now, ht_tim_mood_t mood,
                            bool quiet, bool visible, bool down, int x,
                            unsigned level, uint32_t activity)
{
    bool changed = ht_tim_motion_tick(&m->reaction, now, mood, quiet, visible, down, x, level, activity);
    bool running = visible && !quiet && !down && mood != HT_TIM_LISTENING &&
        mood != HT_TIM_ASLEEP && mood != HT_TIM_OFFLINE;
#ifdef DEVICE_OCTOPUS_BENCH
    // Freeze only the body; preserve identical gaze, blink, mic and touch code for the A/B.
    running = running && octopus_perf_animate();
#endif
    // The exact gallery cadence when working; a gentler half-speed idle swim.
    uint8_t rate = mood == HT_TIM_CONTENT ? 2 : 1;
    uint8_t old_frame = m->frame;
    if (m->initialized && m->running && running) {
        uint32_t elapsed = now - m->last_ms;
        // Reduce before multiplying/adding, including across the millisecond wrap.
        uint32_t scaled = elapsed % (HT_OCTOPUS_DURATION * m->rate) + m->remainder;
        m->phase = (m->phase + scaled / m->rate) % HT_OCTOPUS_DURATION;
        m->remainder = scaled % m->rate;
    } else m->remainder = 0;
    if (m->rate != rate) m->remainder = 0;
    m->initialized = true; m->running = running; m->rate = rate; m->last_ms = now;
    m->frame = 0;
    while (m->frame + 1 < HT_OCTOPUS_FRAMES && m->phase >= octopus_ends[m->frame]) m->frame++;
    m->next_ms = m->reaction.next_ms;
    if (running) {
        uint32_t next = (octopus_ends[m->frame] - m->phase) * rate - m->remainder;
        if (next < m->next_ms) m->next_ms = next ? next : 1;
    }
    return changed || m->frame != old_frame;
}

static void lines(ht_scene_t *s, int y, int width, int count, const ht_font_t *font,
                  uint16_t ink, const char *text, bool mark, const int *widths)
{
    if (!text) text = "";
    int start = s->count;
    const char *rest = text;
    for (int row = 0; row < count; row++) {
        int w = widths ? widths[row] : width;
        const char *begin = rest, *end = ht_take_line(&rest, w / font->width);
        char line[HT_TEXT_BYTES];
        size_t n = (size_t)(end - begin);
        if (n >= sizeof line) n = sizeof line - 1;
        memcpy(line, begin, n); line[n] = 0;
        ht_text(s, (HT_WIDTH - w) / 2, y + row * font->height, w, font, ink, s->background, line);
    }
    if (mark && *rest && s->count > start) {
        char *line = s->runs[s->count - 1].text, *p = line, *space = NULL;
        int keep = (widths ? widths[count - 1] : width) / font->width - 2;
        for (int i = 0; *p && i < keep; i++) {
            if (*p == ' ') space = p;
            const char *next = p; ht_utf8_next(&next); p = (char *)next;
        }
        if (*p && *p != ' ' && space) p = space;
        while (p > line && p[-1] == ' ') p--;
        strcpy(p, " +");
    }
    for (int i = start; i < s->count; i++) {
        ht_run_t *r = &s->runs[i]; const char *p = r->text; int n = 0;
        while (*p) { ht_utf8_next(&p); n++; }
        r->w = n * font->width; r->x = (HT_WIDTH - r->w) / 2;
    }
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
        int pose_row = y - eye + 5;
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

static void recap_lines(ht_scene_t *s, int y, int width, int rows, bool centered, const int *widths,
                        uint16_t ink, const char *recap)
{
    // Every nonempty recap ends in the desktop arrow, including complete
    // sentences. Reserve its cell before wrapping; cached host markers dedupe.
    // Seven visible rows use a bounded UTF-8 prefix. Bound the prefix
    // even when the source is longer than the device's stored recap buffer.
    char marked[7 * HT_TEXT_BYTES + 3];
    size_t used = 0;
    const char *p = recap ? recap : "";
    while (*p) {
        const char *start = p;
        ht_utf8_next(&p);
        size_t bytes = (size_t)(p - start);
        if (used + bytes + 3 > sizeof marked) break;
        memcpy(marked + used, start, bytes);
        used += bytes;
    }
    while (used && marked[used - 1] == ' ') used--;
    marked[used] = 0;
    if (used && !(used >= 2 && !strcmp(marked + used - 2, " +")))
        strcpy(marked + used, " +");
    int start = s->count;
    lines(s, y, width, rows, &ht_mono_20, ink, marked, true, widths);
    // The host's continuation marker and the display's own row-overflow marker
    // both reserve " +". Replace only that final sign with the desktop action
    // glyph; keeping the space and cell width preserves wrapping and centering.
    for (int i = s->count - 1; i >= start; i--) {
        ht_run_t *r = &s->runs[i];
        size_t n = strlen(r->text);
        if (!n) continue;
        // Wrapping can leave the marker on a row of its own. Bring the last
        // word with it when it fits, so the arrow stays attached to prose.
        if (n == 1 && r->text[0] == '+' && i > start) {
            ht_run_t *prev = &s->runs[i - 1];
            char *word = strrchr(prev->text, ' ');
            word = word ? word + 1 : prev->text;
            const char *p = word;
            int cells = 0;
            while (*p) { ht_utf8_next(&p); cells++; }
            if (cells && cells + 2 <= (widths ? widths[i - start] : width) / ht_mono_20.width &&
                strlen(word) + 3 <= sizeof r->text) {
                strcpy(r->text, word);
                strcat(r->text, " +");
                while (word > prev->text && word[-1] == ' ') word--;
                *word = 0;
                p = prev->text;
                int kept = 0;
                while (*p) { ht_utf8_next(&p); kept++; }
                prev->w = kept * ht_mono_20.width;
                prev->x = (HT_WIDTH - prev->w) / 2;
                r->w = (cells + 2) * ht_mono_20.width;
                r->x = (HT_WIDTH - r->w) / 2;
                n = strlen(r->text);
            }
        }
        if ((n >= 2 && !strcmp(r->text + n - 2, " +")) ||
            (n == 1 && r->text[0] == '+')) {
            r->text[n - 1] = 0;
            r->w -= ht_mono_20.width;
            ht_text(s, r->x + r->w, r->y, ht_open_20.width, &ht_open_20,
                    ink, s->background, "\xe2\x86\x97");
        }
        break;
    }
    if (centered) {
        int bottom = y;
        for (int i = start; i < s->count; i++)
            if (s->runs[i].text[0]) bottom = s->runs[i].y + ht_mono_20.height;
        // y describes the full five-row area. Center the actual prose inside it.
        int shift = (rows * ht_mono_20.height - (bottom - y)) / 2;
        for (int i = start; i < s->count; i++) s->runs[i].y += shift;
    }
}

void ht_recap_lines(ht_scene_t *s, int y, uint16_t ink, const char *recap)
{
    recap_lines(s, y, 336, 3, false, NULL, ink, recap);
}
bool ht_octopus_short_recap(const char *recap)
{
    return recap && *recap && ht_text_rows(recap, &ht_mono_20, 324) <= 3;
}

static void recipient(ht_scene_t *s, const ht_tim_face_t *f, int y)
{
    // In reading mode the name labels the message directly underneath it.
    // Long names wrap without changing the text size.
    lines(s, y, 320, 2, &ht_mono_20, f->dim, f->recipient, false, NULL);
}

void ht_octopus_face(ht_scene_t *s, const ht_tim_face_t *f, uint8_t frame, uint16_t ink,
                     const char *recap)
{
    if (frame >= HT_OCTOPUS_FRAMES) frame = 0;
    // The outcome owns the reading space after a turn. Artwork and its label
    // move together above the recap; the status footer stays fixed.
    bool result = recap && *recap;
    bool brief = result && ht_octopus_short_recap(recap);
    bool compact = f->focus || f->carrying;
    const ht_font_t *font = result ? (brief ? &ht_octopus_font_6 : &ht_octopus_font_4) : compact ? &ht_octopus_font_8 : &ht_octopus_font_10;
    int y = result ? (brief ? 78 : 72) : compact ? 113 : 98;
    int x = (HT_WIDTH - HT_OCTOPUS_COLS * font->width) / 2;
    if (f->mood == HT_TIM_OFFLINE || f->mood == HT_TIM_ASLEEP) ink = f->dim;
    for (int i = 0; i < HT_OCTOPUS_ROWS; i++) {
        char row[55]; memcpy(row, octopus_frames[frame][i], sizeof row);
        expression(row, i, octopus_eyes[frame], f);
        ht_text(s, x, y + i * font->height, HT_OCTOPUS_COLS * font->width, font, ink, s->background, row);
    }
    if (f->straight_title) recipient(s, f, ht_octopus_title_y(result, compact));
    else ht_arc_title(s, f->dim, f->recipient);
    // Keep slots stable through long titles and animation; damage stays local.
    static const int reading_widths[] = {396, 396, 384, 372, 348, 324, 276};
    static const int brief_widths[] = {372, 348, 324};
    if (result) recap_lines(s, brief ? 252 : 194, brief ? 372 : 396,
        brief ? 3 : 7, false, brief ? brief_widths : reading_widths, f->foreground, recap);
    else lines(s, 337, 320, 1, &ht_mono_20, f->dim, compact ? f->detail : "", false, NULL);
    if (!f->footer_action && !f->straight_title) ht_arc_status(s, f->ink, f->status);
    else lines(s, f->footer_action ? 369 : 385, 276, 1, &ht_mono_20, f->ink, f->status, false, NULL);
    lines(s, 417, 210, 1, &ht_mono_20, f->dim, f->hint, false, NULL);
}
