// What the max_ui_*.c drawing files share: Demo V2's look (docs/superpowers/specs/2026-11-18-harness-max-v2-design.md),
// the text, shape, icon, button and pet helpers, and the page each file draws. Private to them and their host tests.
#pragma once
#include "max_ui_internal.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(max_tinted(rgb))
// What fades by its colours (a word, a chip, a panel coming in): every colour C() takes is `keep` of 256 its own, the
// rest `toward`, the colour under it, until max_tint(0, 256).
void max_tint(unsigned toward, unsigned keep);
unsigned max_tinted(unsigned rgb);
// What a sliver dims by its colours on the glass (an agent of the row between looks): every colour C() takes, after
// its tint, dimmed `t` of MAX_ONE of the way as V3's dimMatrix(t) dims it, until max_dim(0). max_dim_now: that t.
void max_dim(int t);
int max_dim_now(void);
// V3's dimMatrix(t) in 4096ths (brightness, the Filter Effects saturate, and the opacity over black), and a colour
// (0xRRGGBB, or 8 bits a channel) through it.
typedef struct { int32_t m[9]; } max_dim_t;
max_dim_t max_dim_of(int t);
unsigned max_dim_rgb(const max_dim_t *d, unsigned rgb);
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
// App Detail's row between the app column and the bell (V3 kRowW 1172): three cells to the glass while no agent is
// open; open, the agent (kOpenW 900) between two slivers (kSliverW 136), which fill the row as the cells did.
enum {
    APP_W = DX(196), BELL_W = DX(112), ROW_X = APP_W, ROW_W = HT_WIDTH - APP_W - BELL_W, CELL_W = ROW_W / MAX_CELLS,
    SLIVER_W = DX(136), OPEN_W = ROW_W - 2 * SLIVER_W,
    PANEL_GLOW_H = DY(160),   // the open agent's glow, from its top
};
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
// pct % of colour a over colour b (0xRRGGBB), as the Pro's ph_mix; and q of MAX_ONE of a over b, rounded.
unsigned max_mix(unsigned a, unsigned b, unsigned pct);
unsigned max_mix_q(unsigned a, unsigned b, int32_t q);
// Remember a hit area the finger can use (dropped past MAX_HITS).
void max_hit(int x, int y, int w, int h, max_hit_kind_t kind, int arg);

// ---- icons, the mockup's 24-unit strokes at `size` px from (x, y) ----
void max_icon_x(ht_scene_t *s, int x, int y, int size, unsigned rgb);
void max_icon_bell(ht_scene_t *s, int x, int y, int size, unsigned rgb);
void max_icon_grid(ht_scene_t *s, int x, int y, int size, unsigned rgb);
void max_icon_mic(ht_scene_t *s, int x, int y, int size, unsigned rgb);
// An app's icon, size x size from (x, y): its own (V3's, pre-rendered at that size) when there is one, else a rounded
// square in the app's colour with its initial. `app` is an app id ("orca") or name ("Orca"); `name` gives the initial
// ("" falls back to `app`).
void max_app_icon(ht_scene_t *s, int x, int y, int size, const char *app, const char *name);
// The app's own icon at exactly size px (max_ui_icons.c), or NULL. The app by V3's key: case and anything but letters
// and digits aside ("VS Code": "vscode").
const ht_pro_bitmap_t *max_icon_find(const char *app, int size);

// ---- what an agent's state looks like ----
// The status word's colour: working lavender, waiting yellow, done green, failed red, resting faint.
unsigned max_state_ink(const max_agent_t *);
// Its rail's: the same, failed in the rail's red, resting dark.
unsigned max_rail_ink(const max_agent_t *);
// Its chip's and glow's: the rail's, a resting agent's a quiet grey.
unsigned max_chip_ink(const max_agent_t *);
// The state chip (App Detail): a pill in the chip's colour (.15 over the ground, its rim .4), its dot and the status
// word, at most max_w wide, from x and centred on cy; `small` beside the open agent's name. As V3's chip loops: a
// working agent's dot fades to .25 and back every 1.2 s, an asking agent's chip to .35 every 1 s (toward the colour
// max_tint fades toward). Returns its width.
int max_chip(ht_scene_t *s, int x, int cy, const max_agent_t *a, bool small, int max_w, uint32_t now_ms);
int max_chip_w(const max_agent_t *a, bool small, int max_w);
// An Inbox notice's or Attention's colour by why it came.
unsigned max_kind_ink(max_attn_t kind);
// Its glow from the top of its column, fading to none down it: .25 for any agent not at rest (the mockup's .08, then
// .14, did not show on the black ground), none at rest, in %;
// and the glow's top over `under` as drawn at now_ms, a waiting one's breathing .25 to .05 and back every 1 s unless
// `still`.
unsigned max_glow_pct(const max_agent_t *a);
unsigned max_glow_top(const max_agent_t *a, unsigned under, uint32_t now_ms, bool still);
// Its status rail along the top of x..x + w over `under` (what lies under the rail's top row), as V3's rail loops
// unless `still`: a waiting agent's pulses to .35 and back every 1 s, a working agent's has a white light 55 % of the
// rail long sweeping along it every 1.5 s.
void max_rail(ht_scene_t *s, int x, int w, const max_agent_t *a, unsigned under, uint32_t now_ms, bool still);
// The talk band's live dot's glow (V3's MaskFilter.blur(BlurStyle.outer, 7)), outside a dot LIVE_DOT across from x
// centred on cy, `o` of MAX_ONE there (and as much of what max_tint keeps).
void max_voice_halo(ht_scene_t *s, int x, int cy, int32_t o);

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
// What loops by the clock (V3's Motion): where a loop of period_ms is at now_ms, Q16 of the way round from when the
// page came up; the render task wakes MAX_LOOP_FRAME_MS on for its next frame.
int32_t max_loop(uint32_t now_ms, uint32_t period_ms);
// V3's keyframes(p, from, to, curve): `from` to `to` over the loop's first half, back over its second, in from's units.
int32_t max_keyframes(int32_t p, int32_t from, int32_t to, max_curve_t curve);
#define MAX_PULSE_LOW (MAX_ONE * 35 / 100)   // V3's pulse: down to .35 of the way and back

// ---- App Detail's row off the glass (max_ui_layer.c) ----
// Paints one agent of the row from the glass's x.
typedef void (*max_paint_t)(ht_scene_t *s, int x, const void *arg);
// A frame of the row begins: the patches drawn for the last one are done with.
void max_layer_frame(void);
// The glass's [l, r) of a settled sliver from x (SLIVER_W wide), dimmed and blurred whole: painted from x 0 and kept
// while what it paints stays the same.
void max_layer_kept(ht_scene_t *s, int x, int l, int r, max_paint_t paint, const void *arg);
// The runs from `from` on (a pet, a logo or the ">_" mark, drawn on one colour `ground`) as one image over the glass:
// dimmed and blurred `dim` (MAX_ONE whole) of the way as a sliver's are, and `keep` of 256 there by its alpha, so what
// lies under it shows through (no box of the ground over it, as a fade by colours would leave). Painted again only
// when the runs, the ground or the dim change. Undimmed and whole, it is drawn as it is: its frames below 1x on one
// colour baked as the Pro bakes them, a warming's a band at a time (pod_cell_bake_some), or, with no room for its bake,
// as an image of what the bake would be that the warming made.
void max_layer_pet(ht_scene_t *s, int from, unsigned ground, int dim, unsigned keep);
// The runs from `from` on, an agent of the row drawn on the glass from x (w wide) with its colours dimmed `dim` of the
// way (max_dim) and its pets by max_layer_pet, cut to the glass's [l, r) as its own layer would be cut, and its rail
// and its sides blurred as the layer's blur would blur them: those a warming made ahead for the same runs and place
// kept like a pet's image, the rest worked out in the frame.
void max_layer_cut(ht_scene_t *s, int from, int x, int w, int l, int r, int dim);
// A light across a rail from the glass's lx, lw wide: `base` at its ends, `peak` in its middle, cut to the glass's
// [l, r) and RAIL_H down from the top, as one of this frame's images (dithered: a ramp this long bands in RGB565).
// Left out when the frame has no room for it.
void max_layer_light(ht_scene_t *s, int lx, int lw, int l, int r, unsigned base, unsigned peak);
// How many layers and pets were rasterised so far (a test's count of what was kept).
unsigned max_layer_painted(void);
// How many agents between looks had their edges worked out on the glass so far, none kept for them (a test's count).
unsigned max_layer_edges(void);
// Every kept layer and pet image dropped, the pets' pixels scribbled over (a test's fresh start).
void max_layer_forget(void);
// The frame being drawn: what max_layer_warm keeps from.
uint32_t max_layer_now(void);
// What a warming step met: room for all it drew, an image or a layer it needs left to make (max_layer_warm_paint), or
// no room.
typedef enum { MAX_WARM_DONE, MAX_WARM_MORE, MAX_WARM_FULL } max_warm_t;
// A step of frames drawn off the glass to paint what a motion will show (max_ui_warm.c) begins, from `from` (a
// max_layer_now) on, or the step ends (0). In it no image or layer used since `from` is given up for one (the glass's
// and what the warming made stay), nothing is painted: the first image or layer it needs (none while one is owed) is
// taken and left for max_layer_warm_paint; and its agents between looks are left uncut (their cuts are each frame's
// own), their edges left to make like an image. Returns what the step that ends met.
max_warm_t max_layer_warm(uint32_t from);
// The image or layer a warming step left made, a band of rows at a time (about a ms on the P4), while go_on() says
// so, at least one band: true while some of it is left. It reads none of the model: out of
// its lock, on the render task, between its frames.
bool max_layer_warm_paint(bool (*go_on)(void));
// Whether a warming step left an image or a layer to make.
bool max_layer_owes(void);
// The Max's pod_draw.c (main/pro_fork): the rows of a frame below 1x on one colour (pod_cell_flat) still to bake into
// its arena, once its next ones (about px) are baked, a band at a time (px 0: only asked); -1 when it is not such a
// frame or has no room there without starting the arena over. A raster that meets one not baked whole bakes the rest.
int pod_cell_bake_some(const ht_run_t *r, int px);

// max_ui_render into s, cleared, for a frame the glass never shows: when the glass's own next frame is due
// (max_motion_ms) stays as the glass's last render left it.
void max_render_aside(ht_scene_t *s, uint32_t now_ms);   // max_ui_view.c

// ---- the pages, each over the whole glass ----
// App Detail: the app column, the row of agents and the bell; an agent open across the row while the agent page is up.
void max_draw_overview(ht_scene_t *s, uint32_t now_ms);                          // max_ui_overview.c
void max_draw_ambient(ht_scene_t *s, uint32_t now_ms);                           // max_ui_overview.c
// Ambient's drift (max_ui_overview.c), for the tests: speck i's place in V3's px (false past the last), and the 60 Hz
// steps its clock has passed.
bool max_drift_speck(int i, float *x, float *y);
int max_drift_frames(void);
// The open agent in the row, x..x + w over the glass's height (max_ui_agent.c).
void max_draw_agent(ht_scene_t *s, const max_agent_t *a, int x, int w, uint32_t now_ms);
// Its pet, words, band and X without its ground, glow and rail, over `under` and its glow glow_h px down: as it fades
// in or out, `keep` of 256 there (its words by their colours, its pet by its alpha), its hits recorded all the same.
void max_agent_body(ht_scene_t *s, const max_agent_t *a, int x, int w, unsigned keep, unsigned under, int glow_h,
                    uint32_t now_ms);
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
