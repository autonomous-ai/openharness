// The round dial: 466x466 AMOLED, 1.75" across, 10.48 px/mm.
//
// EVERY NUMBER HERE IS WHAT SHIPPED. It was lifted out of ui_screens.c unchanged when the square board
// arrived, comments and all, so that the extraction could be proved by the dial rendering identically.
// Treat a change to this file as a change to the dial, not as tidying.
//
// The governing constraint, and the reason so many of these are odd numbers: content must stay inside
// the inscribed square or the corners clip it, and the usable WIDTH varies with height — so a value
// here is often a chord measured at one particular y, not a margin anyone chose.
#pragma once

// ── the face ────────────────────────────────────────────────────────────────────────────────────────
#define UI_FACE_W      466
#define UI_FACE_H      466
#define UI_CX          233          // centre; also the rim radius, which is why it appears in clearances
#define UI_CY          233

// ── the readable column ─────────────────────────────────────────────────────────────────────────────
#define SCREEN_PAD     18
// A CHORD, not a margin: the widest column whose corners never clip, measured across the circle's mid
// band where the usable width is much larger than the inscribed square's.
#define SAFE_CONTENT_W 384
#define SAFE_W         lv_pct(72)   // ~335px — wrapped text on the side screens stays inside the curve

// ── Overview (mockup/overview-v3.html, "H · Halo, no ring") ──────────────────────────────────────────
// FIXED seats, not a growing column: nothing moves when the status changes, the words change. The far
// corner of every control is inside the 233px rim, above the home-swipe band (y >= 400) and below the
// notification pull-down band (y < 90).
#define OV_ROW_Y       118          // "8 agents" on one baseline: the count at 64, the word at 38
#define OV_NUM_H       72           // the row's height — the digit's line box
#define OV_ROW_GAP     14           // between the digit and the word
#define OV_STATUS_Y    204          // "N working" / "All idle", Geist 38
#define OV_SIDE_D      64           // Inbox and Settings: 64px rounds, 30px glyphs
#define OV_BELL_X      78
#define OV_GEAR_X      324
#define OV_SIDE_Y      308
// Voice: an 88px round on the axis, dropped 50px below the sides so the three follow the bezel the way
// the old arc did, the middle one nearest the resting thumb. Its lowest point is 434 — 201px from the
// centre, 32px inside the rim.
#define OV_VOICE_D     88
#define OV_VOICE_X     189
#define OV_VOICE_Y     346

// ── agent tile ──────────────────────────────────────────────────────────────────────────────────────
#define TILE_PAD_TOP   119          // 84 -> 117 -> 112 -> 109 -> 124 -> 109 -> 119 (row stays at y=69)
#define TILE_NAME_GAP  21
#define TILE_ARC_Y     322          // the action arc, and the floor a centred block must clear
#define TILE_ARC_GAP   20

// ── the action arc ──────────────────────────────────────────────────────────────────────────────────
// AN ARC, NOT A ROW, and that is the bezel's doing: three 80px buttons need ~300px of width, and at the
// height a thumb wants them this face is only 148px wide. Spread on a radius-160 arc at +/-36 degrees
// the farthest point of any button is 200px from centre, 33px inside the glass. Voice stays dead centre
// at the bottom — the one pressed ten times to the others' one must not move — and sits 31px lower,
// which is the vertical half of that same offset.
#define ACT_BTN_D      80
#define ACT_PREV_X     79
#define ACT_NEXT_X     307
#define ACT_Y          322
#define ACT_VOICE_D    80
#define ACT_VOICE_X    193
#define ACT_VOICE_Y    353

// ── notification drawer ─────────────────────────────────────────────────────────────────────────────
// A centred band, because the top and bottom of a circle are not there to put a list in.
#define NOTIF_LIST_W   360
#define NOTIF_LIST_H   320

// ── settings, pairing, pickers ──────────────────────────────────────────────────────────────────────
// 320 wide only fits the circle between y~64 and y~402 — 338px, i.e. exactly four 84px rows, which is
// why the fifth has to be scrolled to rather than squeezed in.
#define SET_ROW_W      320
#define SET_ROW_H      84
#define SET_LIST_PAD   65
#define PAIR_W         360
#define PICK_PAD_V     200
#define BRIGHT_BOX_W   427
#define MACHINE_ROW_W  427

// ── pattern lock ────────────────────────────────────────────────────────────────────────────────────
#define LK_GAP         113          // dot spacing — matches the "Create your pattern" Figma grid
#define LK_CX          UI_CX
#define LK_CY          UI_CY

// ── voice waveform ──────────────────────────────────────────────────────────────────────────────────
// Seven bars, Figma 1:1 on this face. The pitch is expressed as tenths so the centre column lands on a
// whole pixel: 224/10 = 22.4px between bars.
#define WAVE_PITCH_X10 224

// ── gesture edge bands (ui/touch.c) ─────────────────────────────────────────────────────────────────
// An upward swipe must START at or below UI_HOME_EDGE_Y to count as a bottom-edge swipe to Overview.
// Bottom ~14% band; well below where mid-tile "swipe-up = open detail" gestures begin.
// The reader's is much narrower — the bottom ~20px — because there the only non-scroll vertical gesture
// is that one swipe.
#define UI_HOME_EDGE_Y         400
#define UI_READER_HOME_EDGE_Y  446

// ── how much the tile body holds ────────────────────────────────────────────────────────────────────
// All three follow from ONE number: the body is 136px here (y 166 -> the 302 clamp), and everything
// below is what fits in it. They are not preferences.
//
// RECAP_MAX_CHARS is two lines of the retired LVGL card face (Geist 28; Focus now sets its recap in Inter 30) across SAFE_CONTENT_W, and the comment at the card says
// why it is a cap at all: forty glyphs is what fits without the card touching the action arc.
// How many lines the recap card is pinned to. Two, and the cap above follows from it: a third would reach the action arc at y=322.
#define RECAP_LINES         2
#define RECAP_MAX_CHARS     40
#define TODO_VISIBLE_ROWS   4   // the rest scroll — keeps the status line on screen
#define AGENTS_VISIBLE_ROWS 3   // the rest scroll — coexists with the tool line

// ── the desk grid ───────────────────────────────────────────────────────────────────────────────────
// NOT ON THIS FACE. The grid draws the tab's agents in the same arrangement the Mac has them in, which
// needs a rectangle big enough to hold a recognisable shape: a 466 circle can carry one tile, and one
// tile is what the carousel already is. The dial's home stays the carousel.
#define UI_DESK_GRID   0

// ── the notification pill ───────────────────────────────────────────────────────────────────────────
// WHAT SHIPPED, unchanged: a small badge in the top band, where a 466 circle has room for a small badge
// and nothing else. The square's version is a corner control and is sized for a thumb — see its file.
#define NOTIF_FAB_PAD_H    13
#define NOTIF_FAB_PAD_V    4
#define NOTIF_PILL_FONT    (&lv_font_montserrat_22)
#define NOTIF_PILL_GAP     6

