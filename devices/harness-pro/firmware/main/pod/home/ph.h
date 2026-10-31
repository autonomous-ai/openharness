// Harness Pro Pets, the only interface. ph_render draws the whole frame.
#pragma once
#include "pod/pod_view.h"

void ph_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms);

// ---- chrome (ph_chrome.c): the Update screen's bar and the equaliser ------------------------------------
// The tokens the Update screen draws on: the ground, the raised surface and edges, ink and muted ink, and the accent green (PH_RUN, PH_FOCUS).
enum { PH_GROUND = 0x221F1D, PH_RAISED = 0x2C2826, PH_BORDER = 0x47413C, PH_EDGE = 0x47413C,
       PH_TRACK = 0x4A443F, PH_INK = 0xEFE7DE, PH_INK2 = 0xEFE7DE, PH_MUTED = 0x8F8790, PH_DIM = 0x8F8790,
       PH_RUN = 0x3EE05B, PH_FOCUS = 0x3EE05B };
// The room's dark tokens (Pets design, "Look (dark)"): the scene ground, ink, muted ink, and the working green.
enum { PH_ROOM_BG = 0x221F1D, PH_ROOM_INK = 0xEFE7DE, PH_ROOM_MUTED = 0x8F8790, PH_ROOM_GREEN = 0x3EE05B };
// Home's cover cards (gradient top, bottom per main engine), the name and numeral ink on them, and the status tints.
enum { PH_HOME_BG = 0x151413,
       PH_TINT_CODEX1 = 0x4F6CF2, PH_TINT_CODEX2 = 0x1C2A78, PH_TINT_CLAUDE1 = 0xE0805A, PH_TINT_CLAUDE2 = 0x7A3420,
       PH_TINT_MUSE1 = 0xC2A684, PH_TINT_MUSE2 = 0x56442F, PH_TINT_OTHER1 = 0x55555C, PH_TINT_OTHER2 = 0x1D1D21,
       PH_TINT_KILO1 = 0x8F8A2A, PH_TINT_KILO2 = 0x2C2A0C,
       PH_NOTICE1 = 0xFF9A52, PH_NOTICE2 = 0x9C3F10,   // the notice orange (toast bar, peeking Notices card's name)
       PH_LETTER = 0xF4EEE3, PH_LETTER_MID = 0xD9CFBF, PH_LETTER_BACK = 0xBFB3A1, PH_LETTER_INK = 0x1F1A14, PH_LETTER_RULE = 0xE2D8C8,   // the Notices card: a letter
       PH_LETTER_WHO = 0x9A5A2E, PH_LETTER_MORE = 0x9A8A76, PH_LETTER_MARK = 0xD9622B, PH_LETTER_BADGE = 0xFF7A2F,
       PH_TOAST_FILL = 0x1B2A3D, PH_TOAST_EDGE = 0x2A3D55, PH_TOAST_NAME = 0xFFB36B, PH_TOAST_INK = 0xF2F7FC, PH_TOAST_BAR = 0xFF8A3D,   // the notice toast
       PH_CARD_INK = 0xFFFFFF, PH_PILL_WORK = 0x9DFFC0, PH_PILL_ASK = 0xFFC796,
       PH_SWARM1 = 0x6B4FA3, PH_SWARM2 = 0x231A3B,   // the Swarm card's gradient (the Super Tab purple of Notices, darkened toward the ground)
       PH_LEAD_WORK = 0x3EE05B, PH_LEAD_ASK = 0xFFC796, PH_LEAD_STUCK = 0xFFB0B0 };   // a Lead's status line: working, needs you, stuck (done is white at 60 %)

// Home's equaliser: four 8 px bars 5 px apart (47 wide) in a 36 px box at (x, y), PH_ROOM_GREEN, a triangle wave between 40 % and 100 %, 900 ms.
void ph_working_mark_big(ht_scene_t *, int x, int y, uint32_t now_ms);
// A title centred on x 360 at y 46 (ph_sb_26, PH_ROOM_INK), control characters as spaces, cut with an ellipsis at 640 px: the room's name, "Notices".
void ph_title(ht_scene_t *, const char *);
// Whether the agent has recap text (a non-empty line).
bool ph_has_recap(const pod_agent_t *);
// Text on one line, vertically centred on cy (the lowercase band), cut with an ellipsis at w px.
void ph_text(ht_scene_t *, int x, int cy, int w, const ht_pro_font_t *, unsigned rgb, const char *);
// The runs a frame has used so far (the budget tests).
int ph_runs(const pod_out_frame_t *);
// pct % of colour a over colour b, per channel (0xRRGGBB).
unsigned ph_mix(unsigned a, unsigned b, unsigned pct);
// A Buddy's avatar (ph_avatar.c): a disc of diameter d at (x, y), `color` 22 % over bg, with a 3 px ring at 33 %, and the desktop's 5 x 5 agent pattern
// (the 15-bit half `cells`, mirrored) over it in `color`. At most 27 runs.
void ph_buddy_avatar(ht_scene_t *, int x, int y, int d, uint16_t cells, uint32_t color, unsigned bg);

// ---- Home (ph_overview.c) ------------------------------------------------------------------------------------------
// Cover cards (the owner's mockup): the TABS frame's scroll is the tab (clamped; Recent is not a page). The tab is a 540 x 560 card at (90, 56)
// with a vertical gradient in its main engine's colours (most agents, a tie to the first in pane order; codex, claude, muse, kilo, others),
// its name on one line (ph_sb_48, else ph_sb_34; "Untitled" when empty; cut with an ellipsis), the agent count in ph_num_230 with "agents"
// beside it, status pills (N working with a 4-bar equaliser, N asking with a pulsing dot, else a check and "All done") and up to five 72 px
// engine logos (asking, working, done; the done ones faded; a state dot under each; more than five: four and "+N"). The previous and next tabs
// peek at the sides at 86 %, faded 45 % toward the ground (their gradient and name). Ground PH_HOME_BG. No dots, bell, title or pets.
// One POD_A_ENTER_TAB hit (arg = the tab index, id = the tab's id) over the card; none for a tab with 0 agents. No tabs: the "Harness" wordmark (ph_bd_84, as the round dial's), centred, no hits.
void ph_view_home(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Whether Home has something that moves (a working agent's equaliser, an asking agent's pulse) and the ms to its next step (the 66 ms beat, else 1000).
bool ph_home_moves(const pod_nav_t *, const pod_model_t *);
bool ph_home_brand(const pod_nav_t *, const pod_model_t *);   // Home shows the first screen (the wordmark): no tabs, no notices, linked or not
uint32_t ph_home_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
// The pet scene a card plays for an agent (WORK, ASK, else REST), the agent screen's scenes.
pod_scene_t ph_card_scene(const pod_model_t *, const pod_agent_t *);
// An agent's art centred on (cx, cy), straight on the ground (no box): its pet playing its state's scene (ph_card_scene) in a
// side x side square, else its 72 px logo, else a ">_" outline on `fill`.
// An engine's logo at exactly `size` (a baked one: 44 or 72) at (x, y), else a ">_" outline box of that size on `fill` (0xRRGGBB).
void ph_engine_logo(ht_scene_t *, int x, int y, int size, const char *engine, unsigned fill);
// Home's Notices card (ph_overview.c header): while pod_notice_count > 0 it is the page before tab 0; the TABS frame's scroll is the tab index, POD_HOME_NOTICES (-2) the Notices card.
// A tap on it is one POD_A_INBOX hit.
// Home's Swarm card (ph_overview.c header): the pet scene a Lead plays, WORK while it works, ASK when it needs you or is stuck, else REST.
pod_scene_t ph_lead_scene(pod_lead_state_t);
// A Lead's status line and its colour (PH_LEAD_*; `dim`, the caller's, for "done"): "working · m:ss" (a remote Lead without a clock: "working"), "needs you", "stuck", "done".
unsigned ph_lead_status(const pod_lead_t *, uint32_t now_ms, char *line, size_t n, unsigned dim);
// Home's Working card: the working agents newest turn first (the least pod_agent_secs, ties in model order); returns how many are listed (at most cap).
int ph_working_list(const pod_model_t *, const pod_agent_t **out, int cap, uint32_t now_ms);
// The card colours of an engine (the tab cards' mapping; NULL or an unknown engine: the grey pair), and the Working card's: Codex's blue.
void ph_engine_tint(const char *engine, unsigned *c1, unsigned *c2);
void ph_working_tint(const pod_model_t *, unsigned *c1, unsigned *c2);
void ph_card_art(ht_scene_t *, int cx, int cy, int side, const pod_model_t *, const pod_agent_t *, unsigned fill, uint32_t now_ms);

// ---- Agent, Recap, Talk, Notices, Update (ph_agent.c, ph_recap.c, ph_talk.c, ph_inbox.c, ph_ota.c) ----
// Agent and Recap draw the pet's room (ph_room, below): no bar, the agent's name, its pet and its bubble.
void ph_view_agent(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Recap (mockup "the pet signs it", group centred): a finished or failed agent's recap on a navy ground, no title: a speech bubble (x 60, 600 wide, only as
// tall as its text: 28 px above and below, 34 at the sides, at most 8 ph_rg_36 rows 46 px apart; failed: pink), the last visible row lighter and cut with an
// ellipsis when longer. A tail under its bottom left, then the who row: the pet (RELAX, REST when failed) in a 150 px box at x 16 and the agent's name
// (ph_sb_34) beside it, centred on the pet. The group is centred vertically (40 px clear at least). No hit, no scroll: a vertical drag scrolls the host's pane.
void ph_view_recap(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Talk, in the room: only the pet and the agent's name (centred on top). Listening = the LISTEN scene at 2x, sending = the SEND scene at 2x. No bubbles, dots or wave;
// one full-screen POD_A_TALK hit while listening.
void ph_view_talk(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Ms to its next change: the pet's next step, never sooner than the 66 ms beat (the listening scene costs a frame each).
uint32_t ph_talk_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
// Notices: "Notices" centred at y 46, then rows newest first: the asking agents (model order, their question; POD_A_FOLLOW), then the unread entries
// by at_ms (the first sentence; POD_A_OPEN_NOTIF). A row: a 96 px face box with the pet's REST frame (the logo or ">_" without a pet) and a
// speech bubble with a left tail holding "name . age" (mono; asking: "asks") and the text in ph_sb_26, one or two rows. Pitch 146 from y 96,
// four rows visible, scrolled by rows. Nothing: "Nothing new".
void ph_view_inbox(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// The software update, drawn by the glue instead of the stack: pct 0..100, restarting after the image is verified.
void ph_view_ota(pod_out_frame_t *, const char *from, const char *to, int pct, bool restarting);
// Scroll geometry (rows) for the Inbox.
// Ms to the next change of what Notices shows: the earliest age text among the visible rows turning over (a minute, an hour or a day), else a minute.
uint32_t ph_inbox_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
int ph_inbox_pitch(void);
int ph_inbox_max_row(const pod_model_t *);
// The first `max` notices in the order Notices lists them (pod_notice_count of them in all), for Home's Notices card: the agent's engine (NULL when it is
// off the roster) and the one-line text (an entry's first sentence, "Done" / "Failed" without one; an asking agent's question). Returns how many were filled.
typedef struct { const char *engine, *name; char text[160]; } ph_notice_line_t;   // name: the agent's, "" when unknown
int ph_notices_top(const pod_model_t *, int max, ph_notice_line_t *out);

// ---- The Lead view (ph_lead.c): a Swarm card's Lead, its last message in a paper bubble (see the file's header) ----
// The top frame's Lead (pod_nav_lead): the Swarm's name and the project on top, the bubble (loaded text, "..." loading, no bubble and "No message yet" when empty; an orange
// inner left edge for a Lead that needs you, red for stuck), the Lead's pet signing it with "Lead" and its status line. No hit. Draws nothing while the model does not hold the Lead.
void ph_view_lead(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// A long message scrolls by rows: 46 px a row, the last valid offset (rows past the 7 shown), 0 for any other state.
int ph_lead_pitch(void);
int ph_lead_max_row(const pod_nav_t *, const pod_model_t *);
// Ms to its next change: the pet's next step (no sooner than the Pets beat) and the status line's seconds.
uint32_t ph_lead_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);

// ---- The notice toast (ph_toast.c) ----
// The toast for unread entry `u` over whatever the frame holds (call it last, as the glue draws it): see the file's header. shown_ms: when it appeared; it
// slides in over POD_TOAST_SLIDE_MS and its bar runs out at shown_ms + POD_TOAST_MS (a Super Tab question's bar stays full: pod_model_attention). Adds one POD_A_BANNER hit (arg 0, id = the agent). Returns the
// card's height. At most 9 runs.
int ph_toast(pod_out_frame_t *, const pod_model_t *, const pod_unread_t *u, uint32_t shown_ms, uint32_t now_ms);

// ---- Bubbles (ph_bubble.c): the speech, thought and "you" bubbles of the pet's room (mockup .sp .th .yo, .td, .bell) ----
typedef enum { PH_SPEECH, PH_SPEECH_BAD, PH_THOUGHT, PH_YOU } ph_bubble_kind_t;
// A bubble with its top-left at (x, y), w wide. SPEECH fill #F7F2EA / ink #1B1918 / muted #7B746C; SPEECH_BAD #F3D9DA / #9B5A5F;
// THOUGHT fill #2C2826 with a 2 px #47413C edge, ink #EFE7DE, muted #ADA6AD; YOU #C6AAEF / #1D1426. Corner radius 30 (THOUGHT 40),
// padding 22 px above and below, 28 px left and right; rows are f->height apart.
// Tail: a 36 px square turned 45 degrees (the part that shows is one anti-aliased triangle, ~42 px wide, 22 px proud).
//   tail_dir 0: points DOWN from the bottom edge, its middle at x = tail_x (absolute screen x).
//   tail_dir 1: points LEFT from the left edge, its middle at y = tail_x (absolute screen y; the parameter name is shared).
//   any other tail_dir: no tail.
// Text: wrapped to the bubble's inner width in at most max_rows rows (clamped to 1..6); when it needs more, the last row is cut
// with "\xe2\x80\xa6". `muted` (may be NULL or empty) is ONE extra row below the text rows (6 px lower), outside the max_rows budget,
// in the muted ink and cut with the same ellipsis. Returns the bubble's height (not counting the tail): 44 + rows * f->height
// (+ 6 + f->height with muted). Runs: body 1 (THOUGHT 2) + tail 1 (THOUGHT 2) + one a text row + one for the muted row.
int ph_bubble(ht_scene_t *, ph_bubble_kind_t, int x, int y, int w, int tail_x, int tail_dir, const ht_pro_font_t *, const char *text,
              int max_rows, const char *muted);
// What ph_bubble would use for `text`, by its own wrapping (a placed bubble is sized by these, never by another wrapper): the rows, and the height
// (44 + rows * f->height, + 6 + f->height with a muted row).
int ph_bubble_rows(const ht_pro_font_t *, int w, const char *text, int max_rows);
int ph_bubble_height(const ht_pro_font_t *, int w, const char *text, int max_rows, bool muted);
// How many bubble layouts have been computed rather than looked up in the last-layouts cache (a test hook: a repeated text costs none).
unsigned ph_bubble_layouts(void);
// The first sentence of text: newlines, returns and tabs read as spaces, a short opener ("Done!") takes the next sentence too, no sentence end: the
// whole text. out may be text itself. (Room bubbles and Notices rows share it.)
void ph_first_sentence(char *out, size_t cap, const char *text);
// Just the bubble's body and tail (no text), h tall: ph_bubble's first part, for a bubble that sizes itself (the Story).
void ph_bubble_box(ht_scene_t *, ph_bubble_kind_t, int x, int y, int w, int h, int tail_x, int tail_dir);
// Two thought dots in the THOUGHT fill and edge: a 28 px circle centred on (x0, y0) and a 16 px one centred on (x1, y1).
void ph_thought_dots(ht_scene_t *, int x0, int y0, int x1, int y1);
// A bell glyph (18 x 22 px, top-left (x, y)) and `count` after it (ph_sb_26), both #006FFF.
void ph_bell(ht_scene_t *, int x, int y, int count);

// ---- The room (ph_chrome.c, ph_agent.c): one pet at a time on its floor, thinking or speaking in a bubble ---------------------
// The scene the room plays for the agent: WORK while working, ASK while asking, RELAX when it has a recap (or an unread FINISHED entry) and did not fail, else REST (failed, offline, nothing to say).
pod_scene_t ph_room_scene(const pod_model_t *, const pod_agent_t *);
// A working agent's scene, for the room and the Home card alike: the builder (WORK_ALT) when its turn drew it and its pet
// has one (pod_agent_t.work_alt, Claude's), else WORK.
pod_scene_t ph_work_scene(const pod_agent_t *);
// The agent's pet in `scene`, 2x, its feet on `foot`, centred on cx (an engine with no pet: its 72 px logo or the ">_" outline). Returns the top of what is drawn.
int ph_room_pet(ht_scene_t *, const pod_model_t *, const pod_agent_t *, pod_scene_t scene, int cx, int foot, uint32_t now_ms, uint32_t started_ms);
// The room's frame: the scene ground (PH_ROOM_BG), no glow (a flat block bands and shows its edge), the agent's name centred on x 360 (ph_title:
// ph_sb_26, cut with an ellipsis at 640 px). No dots.
void ph_room_chrome(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, const pod_agent_t *);
// A faint floor shadow (one pod_grad_aa, 12 % black, a 28 px pill 3/4 of w wide), centred on x = cx and on y = foot.
void ph_room_floor(ht_scene_t *, int cx, int foot, int w);
// The room itself (the Agent screen): chrome, floor, the pet (2x, feet on y = foot) and the state's bubble and line.
void ph_room(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Ms to the room's next change: the pet scene's next step (never sooner than POD_PH_ANIM_MS: a 2x pet redraws a lot), and the status line's second.
uint32_t ph_room_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
