// What max_ui_view.c and max_ui_card.c share to draw: the colours beside the theme, a card's rows and the text helpers.
// Private to the two and their host tests.
#pragma once
#include "max_ui_internal.h"
#include "pro_canvas.h"
#include "theme.h"

#define C(rgb) ht_rgb(rgb)
// Beside the theme: the lane card and its edge, the asking and failed tints, the desktop's working cyan
// (activityColor), the unlit page dot, the Talk slot's second line on its dark fill and a button's face.
enum {
    LANE_FILL = 0xf7f6f0, LANE_EDGE = HT_THEME_SELECTION,
    ASK_FILL = 0xf7f0c8, ASK_EDGE = 0xe0d27a, ASK_DOT = 0xd9b300,
    FAIL_FILL = 0xf8e3e0, FAIL_EDGE = 0xe6b3ad,
    WORKING_INK = 0x11a8cd, IDLE_DOT = 0xb4b3ab, TALK_SUB = 0xb9b8b0,
    BUTTON_FILL = 0xffffff,
};
// A card's rows, drawn for 480 and scaled: name, engine and machine, state, then the body down to CARD_BOTTOM.
enum {
    CARD_R = 18, SELECT_W = 3, DOT = 14, BUTTON_R = 14,
    NAME_CY = MAX_CARD_Y + MAX_Y(42), META_CY = MAX_CARD_Y + MAX_Y(82),     // 56, 96 at 480
    STATE_CY = MAX_CARD_Y + MAX_Y(128), BODY_Y = MAX_CARD_Y + MAX_Y(162),   // 142, 176
    CARD_BOTTOM = MAX_CARD_Y + MAX_CARD_H - MAX_Y(16),
    ROW_BYTES = HT_TEXT_BYTES,
};

// t as one run of at most `width` px into out: whole when it fits, else cut before an ellipsis (between words with
// `words` when that keeps half of what fits).
void max_cut(char out[ROW_BYTES], const char *t, const ht_pro_font_t *f, int width, bool words);
// The top that centres a face's lowercase band on cy.
int max_top_of(const ht_pro_font_t *f, int cy);
// One row, cut to w, from its top / centred on cy / centred on cx and cy. max_text returns the width drawn.
void max_line(ht_scene_t *s, int x, int top, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, bool words);
int max_text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t);
void max_text_centered(ht_scene_t *s, int cx, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t);
void max_dot(ht_scene_t *s, int x, int cy, int d, unsigned rgb);
// The bytes of t that fill a row of `width` px, ending at a word.
size_t max_fit(const char *t, const ht_pro_font_t *f, int width);
// t word-wrapped from y down in at most max_rows rows, the last one cut. Returns the y under the last row.
int max_paragraph(ht_scene_t *s, int x, int y, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, int max_rows);
// A card's frame: the fill inside its edge, or inside the dark border of the selected lane.
void max_card_frame(ht_scene_t *s, int x, int y, int w, int h, unsigned fill, unsigned edge, bool selected);
const char *max_state_word(const max_agent_t *);
unsigned max_state_dot(max_state_t);
// Remember a hit area the finger can use (dropped past MAX_HITS).
void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg);

// ---- max_ui_card.c ----
// The open card of a lane in the column at col_x, col_w wide: a question with its buttons, or a finished or failed
// turn with Dismiss. Records the card and its buttons for the finger.
void max_draw_card(ht_scene_t *s, int col_x, int col_w, const max_agent_t *a, uint32_t now_ms);
// New Harness over the lanes.
void max_draw_form(ht_scene_t *s);
