#pragma once
// Pod's screens. Each view fills an ht_scene_t and a hit list from the navigation stack and the model. Pure
// C11 apart from the scene: no I/O and no clock (now_ms is passed in).
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#include "pod_draw.h"
#include "pod_nav.h"
#include "pod_pet.h"

// A hit names what it opens: arg is the index at draw time, id the agent or tab (empty for the Recent list and for
// the buttons). The list can reorder before the tap lands, so the glue resolves the id, not the index.
typedef struct { int16_t x, y, w, h; pod_action_t action; int16_t arg; char id[ID_MAX]; } pod_hit_t;
// tabs_moving / tabs_off: the Tabs grid's pixel offset from the top of page 0 (page * pod_tabs_pitch() at rest; below 0 or past
// the last page while the finger pulls the end), given by the glue while the grid is dragged or settling. Zero: at rest.
typedef struct { ht_scene_t *scene; pod_hit_t hits[32]; uint8_t hit_count; bool tabs_moving; int tabs_off; } pod_out_frame_t;

// Layout, in px on the 720 x 720 glass.
enum { POD_W = 720, POD_STATUS_H = 54, POD_TRANSPORT_H = 126, POD_TRANSPORT_Y = 720 - POD_TRANSPORT_H };

// What a pane diagram draws, as flags: the engine marks, the state foot of working and asking panes, and the
// 1 px outline of the box (without it the box is a plain pale fill). The Tabs and Tab views pick the richest of
// POD_DETAIL_LADDER that keeps the screen within HT_RUNS.
enum { POD_DETAIL_TINT = 0, POD_DETAIL_MARKS = 1, POD_DETAIL_FEET = 2, POD_DETAIL_BORDER = 4,
       POD_DETAIL_FULL = POD_DETAIL_MARKS | POD_DETAIL_FEET | POD_DETAIL_BORDER };
#define POD_DETAIL_LADDER {POD_DETAIL_FULL, POD_DETAIL_MARKS | POD_DETAIL_BORDER, POD_DETAIL_MARKS, POD_DETAIL_TINT}

// ---- the screen -----------------------------------------------------------------------------------------
// Dispatches on the top frame. While !model->linked it draws the status bar and "Connecting…" only (the stack
// is untouched, the only hit is BACK).
// It advances the model's clock to now_ms first (pod_model_clock), so every reader applies the same stale rule.
void pod_render(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);

// ---- scrolling is in rows ---------------------------------------------------------------------------------
// Frame.scroll counts rows, whatever the screen draws a row as. Pixels of finger travel become rows in the glue:
// the pitch is the px one row occupies on the top screen (0: it does not scroll) and the max is its last valid
// offset (the views clamp their own draw to it as well).
int pod_scroll_pitch(const pod_nav_t *);
int pod_scroll_max(const pod_nav_t *, const pod_model_t *);

// ---- chrome (pod_chrome.c) ------------------------------------------------------------------------------
// The 54 px status bar: ‹ back (a BACK hit), or "▶ N" when working > 0 and there is no back, then the title.
void pod_status(pod_out_frame_t *, const char *title, bool back, int working);
// The y that centres a status bar line's capitals on the bar (pod_chrome.c).
int pod_status_text_y(const ht_pro_font_t *font);
// The title the top frame wants in the status bar.
const char *pod_view_title(const pod_nav_t *, const pod_model_t *);
// An engine's mark in a 36 x 36 slot at (x, y): the 27 px mark centred, on a dark chip when the mark is light
// (pod_logo_draw draws the bare logo; this is the chip around it). Runs: pod_mark_runs.
bool pod_mark_chip(ht_scene_t *, int x, int y, const char *engine);
// The same on a ground other than white (the default mark's inside takes it); engine may be NULL.
bool pod_mark_chip_on(ht_scene_t *, int x, int y, const char *engine, uint16_t ground);
unsigned pod_mark_runs(const char *engine);
// The same, dimmed (an offline agent's card): the logo at POD_MARK_DIM opacity, a light mark's dark square lightened. Same runs.
#define POD_MARK_DIM 90
bool pod_mark_chip_dim_on(ht_scene_t *, int x, int y, const char *engine, uint16_t ground);
// The three-bar equaliser, 23 x 20 at (x, y), moving with now_ms. Always 3 runs.
void pod_eq(ht_scene_t *, int x, int y, uint16_t ink, uint32_t now_ms);
// A tab drawn as its panes in a side x side box at (x, y), at full detail. pod_panes_ex picks the detail and
// pod_panes_runs says what it costs.
void pod_panes(ht_scene_t *, int x, int y, int side, const pod_model_t *, const pod_tab_t *);
void pod_panes_ex(ht_scene_t *, int x, int y, int side, const pod_model_t *, const pod_tab_t *, int detail);
// A tab as an album cover on the Tabs grid: white rounded cards on the cover (a mark on each, a green or amber dot top right
// of a working or asking agent's), in the side x side cover at (x, y). detail is POD_COVER_MARKS | POD_COVER_FEET (the dots);
// pod_cover_cards_runs says what it costs. pod_cover_layout gives the cards' boxes relative to the cover (the count
// returned; *extra panes beyond them are the "+N" box after the last). pod_cover_recent draws Recent's up to 8 marks in
// a 4 x 2 grid of white squares; pod_cover_empty is a tab with no panes (grey, a "+" ring).
enum { POD_COVER_MARKS = 1, POD_COVER_FEET = 2, POD_COVER_FULL = 3 };
typedef struct { int x, y, w, h; } pod_box_t;
int pod_cover_layout(const pod_tab_t *, int side, pod_box_t out[POD_PANES_MAX], int *extra);
unsigned pod_cover_cards_runs(const pod_model_t *, const pod_tab_t *, int side, int detail);
void pod_cover_cards(ht_scene_t *, int x, int y, int side, const pod_model_t *, const pod_tab_t *, int detail);
unsigned pod_cover_recent_runs(const pod_model_t *, int side, int detail);
void pod_cover_recent(ht_scene_t *, int x, int y, int side, const pod_model_t *, int detail);
unsigned pod_cover_empty_runs(void);
void pod_cover_empty(ht_scene_t *, int x, int y, int side, int radius);
unsigned pod_panes_runs(const pod_model_t *, const pod_tab_t *, int side, int detail);   // side: marks drop from panes too small for one
// The 126 px transport at the bottom: TABS · ⏮ · ▶ (the send plane while listening) · ⏭ · PANES. Icons only on the big button. Adds the
// hits TABS, PREV, TALK, NEXT and PANES, each at least 80 x 80. 18 runs, the same whether or not talking.
void pod_transport(pod_out_frame_t *, bool talking);
enum { POD_TRANSPORT_RUNS = 18 };
bool pod_hit_add(pod_out_frame_t *, int x, int y, int w, int h, pod_action_t action, int arg);
bool pod_hit_add_id(pod_out_frame_t *, int x, int y, int w, int h, pod_action_t action, int arg, const char *id);
// The Tab screen's scroll geometry (see pod_scroll_*), and the Tabs grid's: a page is two rows of three covers; the frame's
// scroll is the page's first row (even), so max_row is the last page's. pitch is a page's height in px.
int pod_tabs_pitch(void);
int pod_tabs_pages(const pod_model_t *);
// The Playing ribbon's bars step through three heights every POD_TABS_BAR_MS; pod_tabs_ribbon: does a ribbon show on this resting page?
enum { POD_TABS_BAR_MS = 300 };
bool pod_tabs_ribbon(const pod_model_t *, int page);
int pod_tabs_max_row(const pod_model_t *);
int pod_tab_pitch(void);
int pod_tab_max_row(const pod_nav_t *, const pod_model_t *);
// The Recap screen's: a row is one wrapped line of the recap; the last offset shows its last lines.
int pod_recap_max_row(const pod_nav_t *, const pod_model_t *);
// The Recent tile's face: a gradient with a small clock (a ring and two hands), side x side at (x, y). 4 runs.
void pod_recent_face(ht_scene_t *, int x, int y, int side);
void pod_recent_face_r(ht_scene_t *, int x, int y, int side, int radius);   // the same with the cover's corner radius
unsigned pod_recent_face_runs(void);

// Small helpers shared by the views.
void pod_engine_name(char *out, size_t n, const char *engine);
void pod_fmt_time(char *out, size_t n, uint32_t secs);                      // "m:ss"
uint32_t pod_agent_secs(const pod_agent_t *, uint32_t now_ms);              // elapsed while working, else the last
// Working and asking agents among a tab's known members.
void pod_tab_counts(const pod_model_t *, const pod_tab_t *, int *working, int *asking);
int pod_tab_panes(const pod_tab_t *);   // the pane count to show: the daemon's panes, else the members
const pod_tab_t *pod_tab_of(const pod_model_t *, const pod_agent_t *);      // the first tab holding the agent
int pod_agent_pane(const pod_model_t *, const pod_agent_t *, const pod_tab_t *);   // its 1-based pane in the tab, or 0
int pod_agent_index(const pod_model_t *, const pod_agent_t *);

// Drawing primitives Pod's glyph-free icons are made of (the Pro fonts have no arrows or chevrons).
// A play triangle in the w x h box with top-left (x, y): dir 0 points right, 1 points left. One POD_TRI run.
void pod_play(ht_scene_t *, int x, int y, int w, int h, int dir, uint16_t ink);
// A chevron ‹ with its tip at (x, y); legs a px across and down, one mitered stroke (4 runs).
void pod_chevron(ht_scene_t *, int x, int y, int a, uint16_t ink);
// A tick ✓ in a box with top-left (x, y), about 20 x 15 (4 runs).
void pod_tick(ht_scene_t *, int x, int y, uint16_t ink);

// ---- views ----------------------------------------------------------------------------------------------
void pod_view_tabs(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
void pod_view_tab(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
// Task 8 provides these three.
void pod_view_agent(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
void pod_view_recap(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
void pod_view_talk(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
