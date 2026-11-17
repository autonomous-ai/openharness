// What the max_ui_*.c drawing files share: Max's look, the text, bubble, button and pet helpers, and what each file
// draws. Private to them and their host tests.
#pragma once
#include "max_ui_internal.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
// Max's tokens: the values of the Pro's dark Pets look (pod/home/ph.h, ph_bubble.c). Max draws its own screen, so it
// compiles none of the Pro's ph_*.c and keeps the values here.
enum {
    GROUND = 0x221F1D,                    // PH_ROOM_BG: the glass, and the room inside its edge
    RAISED = 0x2C2826, EDGE = 0x47413C,   // PH_RAISED, PH_EDGE: a thought bubble, the Talk pill; every outline
    INK = 0xEFE7DE, MUTED = 0x8F8790,     // PH_ROOM_INK, PH_ROOM_MUTED
    GREEN = 0x3EE05B, GREEN_INK = 0x0D2414,   // PH_ROOM_GREEN: working, Yes and Send (dark words)
    TRACK = 0x4A443F,                     // PH_TRACK: the update's bar
    PEACH = 0xFFC796, MINT = 0x9DFFC0,    // PH_PILL_ASK, PH_PILL_WORK: asking (the ring, the state); a lane at work
    FAIL_INK = 0xF3A6AB, LANE_FAIL = 0xFFD9DB, NO_EDGE = 0xB9787D, NO_INK = 0xF3C3C6,   // Failed, and No's outline
    PAPER = 0xF7F2EA, PAPER_INK = 0x1B1918, PAPER_EDGE = 0xE6DDD1,   // ph_bubble.c speech, and the answers on it
    BAD = 0xF3D9DA, BAD_INK = 0x9B5A5F,                             // a failure's paper
    YOU = 0xC6AAEF, YOU_INK = 0x1D1426,                             // the person talking
    LETTER = 0xF4EEE3, LETTER_INK = 0x1F1A14,                       // PH_LETTER: a summary
    NAVY = 0x1B2A3D, NAVY_EDGE = 0x2A3D55, NAVY_NAME = 0xFFB36B, NAVY_INK = 0xF2F7FC, NAVY_BAR = 0xFF8A3D,   // the toast
    NAVY_MUTED = 0x9FB0CF, NAVY_RAISED = 0x22354D, NAVY_FOCUS = 0x8FB0FF,   // the form's hints, choices, focused one
    LANE_INK = 0xFFFFFF,                  // PH_CARD_INK: words on a lane's gradient
};
enum {
    ROW_BYTES = HT_TEXT_BYTES,
    MAX_ROWS = 8,               // the most rows max_wrap lays out
    LINE_W = 2,                 // an outline
    CARD_R = 30,                // the room and the lanes
    BUTTON_R = 18, SELECT_W = 3,
    DIM_K = 166,                // 65 % toward the ground: what rests while a person talks
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
// The same ending at x (right-aligned). Returns the width drawn.
int max_text_right(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t);
void max_dot(ht_scene_t *s, int x, int cy, int d, unsigned rgb);
// The bytes of t that fill a row of `width` px, ending at a word.
size_t max_fit(const char *t, const ht_pro_font_t *f, int width);
// t word-wrapped to `w` px in at most max_rows rows (MAX_ROWS at most), the last one cut. Returns the rows.
int max_wrap(char rows[][ROW_BYTES], int max_rows, const char *t, const ht_pro_font_t *f, int w);
// t word-wrapped from y down in at most max_rows rows, the last one cut. Returns the y under the last row.
int max_paragraph(ht_scene_t *s, int x, int y, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, int max_rows);
// A rounded box in `fill` inside a `line` px `edge` (line 0: no edge).
void max_box(ht_scene_t *s, int x, int y, int w, int h, int r, int line, unsigned edge, unsigned fill);
// pct % of colour a over colour b (0xRRGGBB), as the Pro's ph_mix.
unsigned max_mix(unsigned a, unsigned b, unsigned pct);
// Remember a hit area the finger can use (dropped past MAX_HITS).
void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg);
// "Working" for a turn with no spinner word yet, "Asks", "Done", "Failed", "Idle".
const char *max_state_word(const max_agent_t *);
// The state line: the word, with the turn's clock while it runs ("Asks 1:05", "Uploading… 4:14").
void max_state_line(char *out, size_t cap, const max_agent_t *a, const char *word, uint32_t now_ms);

// ---- bubbles: the Pro's speech, thought and "you" papers ----
typedef enum { BUBBLE_SPEECH, BUBBLE_BAD, BUBBLE_LETTER, BUBBLE_YOU, BUBBLE_THOUGHT } max_bubble_kind_t;
// Where the tail goes: from the left edge near the bottom (the room's, towards its pet), or down from the middle (a
// lane's, over its pet). A thought trails two dots there instead.
typedef enum { TAIL_LEFT, TAIL_DOWN } max_tail_t;
typedef struct {
    const ht_pro_font_t *f;
    int pad_x, pad_y, radius;
    max_tail_t tail;
} max_bubble_style_t;
// The bubble's height for n rows.
int max_bubble_h(const max_bubble_style_t *, int n);
// The bubble at (x, y), w wide, with its rows (centred on a lane, from the left in the room).
void max_bubble(ht_scene_t *s, max_bubble_kind_t kind, const max_bubble_style_t *st, int x, int y, int w,
                char rows[][ROW_BYTES], int n);

// ---- buttons ----
typedef enum {
    STYLE_PLAIN, STYLE_CHOSEN, STYLE_PRIMARY, STYLE_REJECT, STYLE_GHOST, STYLE_OFF, STYLE_NAVY, STYLE_NAVY_OFF,
} max_style_t;
// A button's words on one row of ph_sb_22, else two, the second cut.
void max_button(ht_scene_t *s, int x, int y, int w, int h, max_style_t style, const char *label);
// The rows a label takes in a button of `inner` px: 1, 2, or 3 when even two rows cut it.
int max_label_rows(const char *label, int inner);

// ---- pets (max_ui_pet.c): the Pro's pet player, on Max's ground ----
// The scene an agent plays: asking, working or resting; in the room, listening or sending while a person talks to it.
pod_scene_t max_pet_scene(const max_agent_t *, bool room);
// The agent's pet with its feet on `foot`, centred on cx, at most max_h tall and 2 * half wide, on a ground of one colour
// `ground` (a lane passes its gradient's colour there). The room's pet moves with now_ms; a `still` one (a lane's) holds
// one frame. An engine with no pet shows its logo, else ">_". Returns the top of what is drawn.
int max_pet(ht_scene_t *s, const max_agent_t *a, pod_scene_t scene, int cx, int foot, int half, int max_h,
            unsigned ground, uint32_t now_ms, bool still);
// When the room's pet, drawn at now_ms in `scene`, next changes: ms from now_ms.
uint32_t max_pet_next_ms(const max_agent_t *a, pod_scene_t scene, uint32_t now_ms);
// Something drawn moves on by the clock alone in `ms`: the render task wakes for it (max_motion_ms).
void max_motion(uint32_t now_ms, uint32_t ms);

// ---- the room (max_ui_card.c) ----
// The room: the agent `a` (NULL: an empty room that says so), its name and state, its pet over Tap to talk, its bubble
// and its buttons. Records its buttons and Talk for the finger.
void max_draw_room(ht_scene_t *s, const max_agent_t *a, uint32_t now_ms);
// New Harness over the room and the lanes: its title row with Close at the right end, its choices under it. The toast
// and the notice keep to the band above the choices, left of Close, while it is up.
enum {
    FORM_PAD = 26, FORM_CLOSE_W = 160,
    FORM_HEAD_Y = MAX_CARD_Y + MAX_Y(16), FORM_CHOICES_Y = FORM_HEAD_Y + MAX_BUTTON_H + MAX_Y(16),
    FORM_CLOSE_X = MAX_LANE_X + MAX_LANES_W - FORM_PAD - FORM_CLOSE_W,
};
void max_draw_form(ht_scene_t *s);
