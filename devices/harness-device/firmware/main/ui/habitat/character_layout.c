#include "character_layout.h"
#include <stdio.h>
#include <string.h>

bool ht_character_caption_tick(ht_character_caption_t *c, uint32_t now,
                                const char *pane, bool working)
{
    if (!pane) pane = "";
    bool activity = c->activity;
    uint8_t opacity = c->opacity;
    if (!c->initialized || c->working != working || strcmp(c->pane, pane)) {
        size_t n = strlen(pane);
        if (n >= sizeof c->pane) n = sizeof c->pane - 1;
        memcpy(c->pane, pane, n); c->pane[n] = 0;
        c->began = now; c->initialized = true; c->working = working;
    }
    c->activity = false; c->opacity = 255; c->next_ms = 1000;
    if (working) {
        uint32_t age = now - c->began, phase = age % 3000;
        c->activity = (age / 3000) % 2;
        if (phase >= 2760) {
            c->opacity = (3000 - phase) * 255 / 240;
            c->next_ms = 40;
        } else if (phase < 240 && age >= 3000) {
            c->opacity = phase * 255 / 240;
            c->next_ms = 40;
        } else c->next_ms = 2760 - phase;
    }
    return activity != c->activity || opacity != c->opacity;
}
uint16_t ht_character_caption_ink(uint16_t fg, uint16_t bg, uint8_t opacity)
{
    unsigned inverse = 255 - opacity;
    unsigned r = (((fg >> 11) * opacity + (bg >> 11) * inverse) + 127) / 255;
    unsigned g = ((((fg >> 5) & 63) * opacity + ((bg >> 5) & 63) * inverse) + 127) / 255;
    unsigned b = (((fg & 31) * opacity + (bg & 31) * inverse) + 127) / 255;
    return (uint16_t)((r << 11) | (g << 5) | b);
}

void ht_character_letter(ht_scene_t *s, const ht_character_face_t *f,
                         const ht_font_t *font, int x, int y)
{
    static const char letter[4][12] = {
        "\\         /", "  \\     /  ", "    \\_/    ", "           "
    };
    uint16_t paper = f->mood == HT_CHARACTER_OFFLINE || f->mood == HT_CHARACTER_ASLEEP
        ? f->dim : f->foreground;
    // Reverse-video ASCII cells make unread mail a solid light envelope.
    // Reuse the text ink so saved brightness still applies; no image asset.
    for (int row = 0; row < 4; row++)
        ht_ascii_text(s, x, y + row * font->height, 11 * font->width,
                      font, s->background, paper, letter[row], 11);
}

static void lines(ht_scene_t *s, int y, int width, int count, const ht_font_t *font,
                  uint16_t ink, const char *text, bool mark, const int *widths)
{
    if (!text) text = "";
    int start = s->count;
    const char *rest = text;
    for (int row = 0; row < count; row++) {
        int w = widths ? widths[row] : width;
        const char *begin = rest, *end = ht_take_display_line(&rest, w / font->width, font);
        char line[HT_TEXT_BYTES];
        size_t n = (size_t)(end - begin);
        if (n >= sizeof line) n = sizeof line - 1;
        memcpy(line, begin, n); line[n] = 0;
        ht_text(s, (HT_WIDTH - w) / 2, y + row * font->height, w, font, ink, s->background, line);
    }
    if (mark && *rest && s->count > start) {
        char *line = s->runs[s->count - 1].text, *p = line, *space = NULL;
        int keep = (widths ? widths[count - 1] : width) / font->width - 3;
        for (int i = 0; *p && i < keep; i++) {
            if (*p == ' ') space = p;
            const char *next = p; ht_utf8_next(&next); p = (char *)next;
        }
        if (*p && *p != ' ' && space) p = space;
        while (p > line && p[-1] == ' ') p--;
        strcpy(p, "...");
    }
    for (int i = start; i < s->count; i++) {
        ht_run_t *r = &s->runs[i]; const char *p = r->text; int n = 0;
        while (*p) { ht_utf8_next(&p); n++; }
        r->w = n * font->width; r->x = (HT_WIDTH - r->w) / 2;
    }
}

static void recap_lines(ht_scene_t *s, int y, int width, int rows, bool centered, const int *widths,
                        uint16_t ink, const char *recap, const ht_font_t *font, int max_chars)
{
    // Summary text has no action glyph. Only incomplete prose gets an ellipsis;
    // the desktop action lives in the inbox footer. Bound cached UTF-8 input.
    char marked[7 * HT_TEXT_BYTES + 4];
    // Normalize before the character budget and round-screen line wrapping.
    // The stored message remains untouched; ⅓ occupies three display cells.
    ht_display_text(marked,sizeof marked - 3,recap,font);
    size_t used = strlen(marked);
    while (used && marked[used - 1] == ' ') used--;
    marked[used] = 0;
    if (used >= 2 && !strcmp(marked + used - 2, " +"))
        strcpy(marked + used - 2, "...");
    if (max_chars > 3) {
        const char *end = marked;
        for (int count = 0; *end && count < max_chars; count++) ht_utf8_next(&end);
        if (*end) {
            // Count glyphs, not UTF-8 bytes. The ellipsis is inside the budget;
            // finish at the last whole word whenever the text supplies one.
            char *cut = marked, *space = NULL;
            for (int count = 0; *cut && count < max_chars - 3; count++) {
                if (*cut == ' ') space = cut;
                const char *next = cut; ht_utf8_next(&next); cut = (char *)next;
            }
            if (*cut && *cut != ' ' && space) cut = space;
            while (cut > marked && (cut[-1] == ' ' || cut[-1] == '.')) cut--;
            strcpy(cut, "...");
        }
    }
    int start = s->count;
    lines(s, y, width, rows, font, ink, marked, true, widths);
    if (centered) {
        int bottom = y;
        for (int i = start; i < s->count; i++)
            if (s->runs[i].text[0]) bottom = s->runs[i].y + font->height;
        // y describes the full reading area. Center the actual prose inside it.
        int shift = (rows * font->height - (bottom - y)) / 2;
        for (int i = start; i < s->count; i++) s->runs[i].y += shift;
    }
}

void ht_recap_lines(ht_scene_t *s, int y, uint16_t ink, const char *recap)
{
    recap_lines(s, y, 336, 3, false, NULL, ink, recap, &ht_mono_20, 0);
}
void ht_inbox_card(ht_scene_t *s, const char *mark, const char *name,
                   const char *message, uint16_t foreground, uint16_t status_ink)
{
    ht_inbox_card_badged(s, mark, name, message, foreground, status_ink, NULL, 0);
}
void ht_inbox_card_badged(ht_scene_t *s, const char *mark, const char *name,
                          const char *message, uint16_t foreground, uint16_t status_ink,
                          const char *badge, uint16_t badge_ink)
{
    // One balanced text block. A fixed 28 px gap separates label and message,
    // whether they take two lines or six. No divider or empty reserved rows.
    /*
     * With a badge the status mark goes, and the NAME carries the status colour instead — the
     * design's reading of this row (a green name for a finished turn), and what stops "claude ?"
     * reading as two marks in a row. Without one the mark stays: on a creature skin it is the only
     * thing on the card that says done, failed or asking.
     */
    char title[HT_TEXT_BYTES];
    if (badge) snprintf(title, sizeof title, "%s", name);
    else snprintf(title, sizeof title, "%s %s", mark, name);
    int start = s->count;
    // The badge spends part of the title's width, so the title is wrapped in what is left. Without
    // this the pair is wider than the row it was measured for and its ends reach the bezel.
    int badge_w = badge ? ht_engine.width + 8 : 0;
    lines(s, 0, 374 - badge_w, 2, &ht_mono_28, badge ? status_ink : foreground, title, true, NULL);
    while (s->count > start && !s->runs[s->count - 1].text[0]) s->count--;
    int body = s->count;
    recap_lines(s, 0, 391, HT_CHARACTER_RECAP_ROWS, false, NULL,
                foreground, message, &ht_mono_28, HT_CHARACTER_RECAP_CHARS);
    while (s->count > body && !s->runs[s->count - 1].text[0]) s->count--;
    int title_height = (body - start) * ht_mono_28.height;
    int body_height = (s->count - body) * ht_mono_28.height;
    int top = 72 + (310 - title_height - 28 - body_height) / 2;
    for (int i = start; i < s->count; i++)
        s->runs[i].y += i < body ? top : top + title_height + 28;
    if (body > start && badge) {
        // The badge leads the FIRST title line, and the pair is centred together.
        ht_run_t *r = &s->runs[start];
        int x = (HT_WIDTH - badge_w - r->w) / 2;
        r->x = x + badge_w;
        ht_text(s, x, r->y, ht_engine.width, &ht_engine, badge_ink, s->background, badge);
    }
    if (body > start && !badge) {
        // Put the colored symbol in its own immutable run. Avoid a shared
        // mutable per-cell palette between the compositor's two scene buffers.
        ht_run_t *r = &s->runs[start];
        const char *next = r->text; ht_utf8_next(&next);
        memmove(r->text + 1, next, strlen(next) + 1); r->text[0] = ' ';
        ht_text(s, r->x, r->y, ht_mono_28.width, &ht_mono_28, status_ink, s->background, mark);
    }
}
void ht_notification_bell(ht_scene_t *s, unsigned count, uint16_t ink)
{
    ht_notification_bell_at(s, count, ink, HT_NOTIFICATION_Y);
}
void ht_notification_bell_at(ht_scene_t *s, unsigned count, uint16_t ink, int y)
{
    char number[12];
    snprintf(number, sizeof number, "%u", count);
    int digits = count ? (int)strlen(number) * ht_mono_28.width : 0;
    int width = ht_bell_footer.width + (count ? 8 + digits : 0);
    int x = (HT_WIDTH - width) / 2;
    ht_text(s, x, y, ht_bell_footer.width, &ht_bell_footer, ink, s->background, HT_BELL);
    if (count) ht_text(s, x + ht_bell_footer.width + 8, y, digits,
                       &ht_mono_28, ink, s->background, number);
}
static void recipient(ht_scene_t *s, const ht_character_face_t *f, int y)
{
    // In reading mode the name labels the message directly underneath it.
    // Long names wrap without changing the text size.
    lines(s, y, 320, 2, &ht_mono_20, f->primary_title ? f->foreground : f->dim, f->recipient, false, NULL);
}

void ht_character_layout(ht_scene_t *s, const ht_character_face_t *f, uint8_t frame, uint16_t ink,
                         const char *recap, ht_character_painter_t paint)
{
    // The outcome owns the reading space after a turn. Artwork and its label
    // move together above the recap; the home caption stays on the top curve.
    bool result = recap && *recap;
    // The live reading surface has one fixed small portrait for every summary.
    // Legacy benchmark scenes retain their original geometry for comparison.
    bool brief = result && !f->roomy_reading && ht_text_rows(recap, &ht_mono_20, 324) <= 3;
    bool compact = f->focus || f->carrying;
    ht_character_size_t size = result ? (brief ? HT_CHARACTER_BRIEF : HT_CHARACTER_READING) :
        compact ? HT_CHARACTER_COMPACT : HT_CHARACTER_FULL;
    int y = result ? (brief ? 78 : 72) : compact ? 113 : 98;
    if (result && f->roomy_reading) y = HT_CHARACTER_READING_Y;
    else if (!compact && f->roomy_reading) { size = HT_CHARACTER_COMPACT; y = 114; }
    paint(s, f, frame, ink, size, y);
    if (!f->single_label) {
        if (f->straight_title) recipient(s, f, 41);
        else ht_arc_title(s, f->primary_title ? f->foreground : f->dim, f->recipient);
    }
    // Keep slots stable through long titles and animation; damage stays local.
    static const int reading_widths[] = {396, 396, 384, 372, 348, 324, 276};
    static const int brief_widths[] = {372, 348, 324};
    // Larger summaries occupy the center of the circle, with the last row above the footer. Narrow
    // lower rows keep every glyph inside the bezel.
    static const int roomy_widths[] = {408, 408, 391, 340};
    if (result && f->roomy_reading) recap_lines(s, HT_CHARACTER_READING_TEXT_Y,
        408, HT_CHARACTER_RECAP_ROWS, false, roomy_widths, f->foreground, recap,
        &ht_mono_28, HT_CHARACTER_RECAP_CHARS);
    else if (result) recap_lines(s, brief ? 252 : 194, brief ? 372 : 396,
        brief ? 3 : 7, false, brief ? brief_widths : reading_widths, f->foreground, recap, &ht_mono_20, 0);
    else lines(s, 337, 320, 1, &ht_mono_20, f->dim, compact ? f->detail : "", false, NULL);
    if (!f->footer_action && !f->straight_title) ht_arc_status(s, f->ink, f->status);
    else lines(s, f->footer_action ? 369 : 385, 276, 1, &ht_mono_20, f->ink, f->status, false, NULL);
    lines(s, 417, 210, 1, &ht_mono_20, f->dim, f->hint, false, NULL);
}
