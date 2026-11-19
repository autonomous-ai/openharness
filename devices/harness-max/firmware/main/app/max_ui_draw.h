// What the max_ui_*.c drawing files share: Demo V2's look (docs/superpowers/specs/2026-11-18-harness-max-v2-design.md),
// the text, shape, icon, button and pet helpers, and the page each file draws. Private to them and their host tests.
#pragma once
#include "max_ui_internal.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
// The dial's tokens, as Diego's mockup draws them (the spec's Tokens), and the few shades the mockup adds.
enum {
    GROUND = 0x000000, FG = 0xEAEAF0, INK = 0xEFE7DE, RECAP = 0xD6D6D2, DIM = 0xADA6AD, REST = 0x9A9AA6,
    FAINT = 0x585863, CARD = 0x1C1E26, RIM = 0x3D3F47, LINE = 0x16161C, ACCENT = 0xC6AAEF,
    DONE = 0x0DBC79, WAIT = 0xE5E510, FAIL = 0xFF6B6B, FAIL_RAIL = 0xCD3131, VOICE = 0x00FF2F,
    CLAUDE = 0xFF9E64, CODEX = 0x8FB4FF, MUSE = 0xF2DCB8,
    IDLE_RAIL = 0x2A2A33, SIDE_RAIL = 0x1A1A22,                       // a resting agent's rail; the app and bell columns'
    NOTE_BG = 0x0B0B10, NOTE_LIT = 0x121219, NOTE_RIM = 0x22222A,     // an Inbox card, read and unread
    APP_BG = 0x0C0C11, APP_RIM = 0x24242C,                            // an Apps card
    ALLOW_INK = 0x00130B, DENY_INK = 0xFFB4B4, DENY_RIM = 0xAA3333,   // Allow's words; Deny's words and outline
    MONO_INK = 0xF3EBFF, TRACK = 0x2C2C35, FLOW = 0x111111,           // a command; the send ring's track; the flow bar
    CHIP_IDLE = 0x6B6B77,                                             // a resting agent's chip
    PANEL = 0x060609, BAND_BG = 0x0B0B0F,                             // the open agent; its band at rest (rim APP_RIM)
};
// Diego's mockup is 1480 x 320. Across, a design px is 1920 / 1480 of the glass's; down, 1.5 px at 480, which MAX_Y
// scales to the demo bar's 415. The text keeps its size at both heights.
#define DX(px) ((px) * 1297 / 1000)
#define DY(px) MAX_Y((px) * 3 / 2)
enum {
    ROW_BYTES = HT_TEXT_BYTES,
    MAX_ROWS = 8,               // the most rows max_wrap lays out
    RAIL_H = DY(5),             // a status rail along a column's top
    ROUND_D = DY(64),           // a round button: the bell, Inbox's Close
    BUTTON_R = 21,              // an answer button's corners (16 design px)
    NOTICE_H = DY(46),
};

// t as one run of at most `width` px into out: whole when it fits, else cut before an ellipsis (between words with
// `words` when that keeps half of what fits).
void max_cut(char out[ROW_BYTES], const char *t, const ht_pro_font_t *f, int width, bool words);
// The top that centres a face's lowercase band on cy.
int max_top_of(const ht_pro_font_t *f, int cy);
// One row, cut to w, centred on cy / centred on cx and cy / ending at x. They return the width drawn.
int max_text(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t);
void max_text_centered(ht_scene_t *s, int cx, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t);
int max_text_right(ht_scene_t *s, int x, int cy, int w, const ht_pro_font_t *f, unsigned rgb, const char *t);
void max_dot(ht_scene_t *s, int x, int cy, int d, unsigned rgb);
// The bytes of t that fill a row of `width` px, ending at a word.
size_t max_fit(const char *t, const ht_pro_font_t *f, int width);
// t word-wrapped to `w` px in at most max_rows rows (MAX_ROWS at most), the last one cut. Returns the rows.
int max_wrap(char rows[][ROW_BYTES], int max_rows, const char *t, const ht_pro_font_t *f, int w);
// t word-wrapped from y down in at most max_rows rows, the last one cut. Returns the y under the last row.
int max_paragraph(ht_scene_t *s, int x, int y, int w, const ht_pro_font_t *f, unsigned rgb, const char *t, int max_rows);
// Whether ph_sb_48, cut to letters, digits and ".-+_%…" (gen_fonts.py CONSOLE_CUT), draws every character of t.
bool max_big_can_draw(const char *t);
// A clock ("4:29", "15:07") in a face that may have no colon (ph_num_230, ph_bd_84, ph_sb_48): the colon is drawn as
// two dots. Its width, and the clock from x, centred on cy.
int max_clock_w(const ht_pro_font_t *f, const char *t);
void max_clock(ht_scene_t *s, int x, int cy, const ht_pro_font_t *f, unsigned rgb, const char *t);
// How long ago `at` was at now_ms: "just now", "4 min ago", "2 h ago", "3 d ago".
void max_ago(char *out, size_t cap, uint32_t at, uint32_t now_ms);

// ---- shapes ----
// A rounded box in `fill` inside a `line` px `edge` (line 0: no edge).
void max_box(ht_scene_t *s, int x, int y, int w, int h, int r, int line, unsigned edge, unsigned fill);
// A round button d across, centred on (cx, cy): the card's fill inside the rim.
void max_round(ht_scene_t *s, int cx, int cy, int d);
// A line from (x0, y0) to (x1, y1), `w` px thick, in sixteenths of a px: two triangles that share their seam.
void max_stroke16(ht_scene_t *s, int x0, int y0, int x1, int y1, int w, unsigned rgb);
// pct % of colour a over colour b (0xRRGGBB), as the Pro's ph_mix.
unsigned max_mix(unsigned a, unsigned b, unsigned pct);
// Remember a hit area the finger can use (dropped past MAX_HITS).
void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg);

// ---- icons, the mockup's 24-unit strokes at `size` px from (x, y) ----
void max_icon_x(ht_scene_t *s, int x, int y, int size, unsigned rgb);
void max_icon_bell(ht_scene_t *s, int x, int y, int size, unsigned rgb);
void max_icon_grid(ht_scene_t *s, int x, int y, int size, unsigned rgb);
void max_icon_mic(ht_scene_t *s, int x, int y, int size, unsigned rgb);
// An app's icon, size x size from (x, y): a rounded square in the app's colour with its initial. `app` is an app id
// ("orca") or name ("Orca"); `name` gives the initial ("" falls back to `app`).
void max_app_icon(ht_scene_t *s, int x, int y, int size, const char *app, const char *name);

// ---- what an agent's state looks like ----
// The status word's colour: working lavender, waiting yellow, done green, failed red, resting faint.
unsigned max_state_ink(const max_agent_t *);
// Its rail's: the same, failed in the rail's red, resting dark.
unsigned max_rail_ink(const max_agent_t *);
// Its chip's and glow's: the rail's, a resting agent's a quiet grey.
unsigned max_chip_ink(const max_agent_t *);
// The state chip (App Detail): a pill in the chip's colour (.15 over the ground, its rim .4), its dot and the status
// word, at most max_w wide, from x and centred on cy; `small` beside the open agent's name. Returns its width.
int max_chip(ht_scene_t *s, int x, int cy, const max_agent_t *a, bool small, int max_w);
int max_chip_w(const max_agent_t *a, bool small, int max_w);
// An Inbox notice's or Attention's colour by why it came.
unsigned max_kind_ink(max_attn_t kind);

// ---- buttons ----
typedef enum { STYLE_PLAIN, STYLE_CHOSEN, STYLE_PRIMARY, STYLE_REJECT, STYLE_GHOST, STYLE_OFF } max_style_t;
// A button's words on one row of ph_sb_26, else two of ph_sb_22, the second cut; `mic` puts the mic before them.
void max_button(ht_scene_t *s, int x, int y, int w, int h, max_style_t style, const char *label, bool mic);
// The width a button needs for its words on one row, `pad` each side.
int max_button_w(const char *label, bool mic, int pad);

// ---- pets (max_ui_pet.c): the Pro's pet player on the black glass ----
// The scene an agent plays: asking, working or resting; on its own page, listening or sending while a person talks to
// it, and relaxing when it rests with nothing to say.
pod_scene_t max_pet_scene(const max_agent_t *, bool page);
// The engine's pet with its feet on `foot`, centred on cx, at most max_h tall and 2 * half wide, on a ground of one
// colour `ground`. A moving one plays by now_ms; a `still` one holds one frame. An engine with no pet shows its logo,
// else ">_". Returns the top of what is drawn.
int max_pet(ht_scene_t *s, const char *engine, pod_scene_t scene, int cx, int foot, int half, int max_h,
            unsigned ground, uint32_t now_ms, bool still);
// The height max_pet draws with these, for a page that centres its pet.
int max_pet_h(const char *engine, pod_scene_t scene, int half, int max_h, bool still);
// When a moving pet drawn at now_ms in `scene` next changes: ms from now_ms.
uint32_t max_pet_next_ms(const char *engine, pod_scene_t scene, uint32_t now_ms);
// Something drawn moves on by the clock alone in `ms`: the render task wakes for it (max_motion_ms).
void max_motion(uint32_t now_ms, uint32_t ms);

// ---- the pages, each over the whole glass ----
// App Detail: the app column, the row of agents and the bell; an agent open across the row while the agent page is up.
void max_draw_overview(ht_scene_t *s, uint32_t now_ms);                          // max_ui_overview.c
void max_draw_ambient(ht_scene_t *s);                                            // max_ui_overview.c
// The open agent in the row, x..x + w over the glass's height (max_ui_agent.c).
void max_draw_agent(ht_scene_t *s, const max_agent_t *a, int x, int w, uint32_t now_ms);
void max_draw_attention(ht_scene_t *s, const max_agent_t *a, uint32_t now_ms);   // max_ui_card.c
void max_draw_inbox(ht_scene_t *s, uint32_t now_ms);                             // max_ui_lists.c
void max_draw_apps(ht_scene_t *s);                                               // max_ui_lists.c
// New Harness over the whole glass: its title row with Close at the right end, its choices under it, its buttons at
// the foot. The toast and the notice keep to the title row, left of Close, while it is up.
enum {
    FORM_PAD = 26, FORM_CLOSE_W = 160, FORM_X = MAX_ROOM_X, FORM_W = HT_WIDTH - 2 * MAX_ROOM_X,
    FORM_HEAD_Y = MAX_CARD_Y + MAX_Y(16), FORM_CHOICES_Y = FORM_HEAD_Y + MAX_BUTTON_H + MAX_Y(16),
    FORM_CLOSE_X = FORM_X + FORM_W - FORM_PAD - FORM_CLOSE_W,
};
void max_draw_form(ht_scene_t *s);
