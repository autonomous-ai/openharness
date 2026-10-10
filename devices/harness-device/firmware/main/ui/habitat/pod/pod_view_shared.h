#pragma once
// Helpers the Agent, Recap and Talking screens share (defined in pod_view_agent.c). Internal to Pod's views.
#include "pod_view.h"
#include "../pro_canvas.h"

enum { POD_ROW_MAX = HT_TEXT_BYTES };

static inline uint16_t pod_c(unsigned rgb) { return ht_rgb(rgb); }

// The agent the top frame names, or NULL when the model no longer has it.
const pod_agent_t *pod_view_agent_of(const pod_nav_t *, const pod_model_t *);
// Greedy word wrap of text into at most max_rows rows of at most width px. When text remains after the last
// row, that row holds the rest (ht_pro_text then ends it with an ellipsis). Returns the rows used.
int pod_wrap(const char *text, const ht_pro_font_t *, int width, int max_rows, char rows[][POD_ROW_MAX]);
// Text centred on cx, clipped to width; the top is y. Adds one run (none for empty text).
void pod_text_center(ht_scene_t *, int cx, int y, int width, const ht_pro_font_t *, uint16_t ink, const char *text);
// The engine name ("Claude") alone on a line in ht_pro_24 dark grey, the tab name alone on the next in blue, the machine
// alone on the next in grey (each omitted when unknown), left aligned at x, one POD_WHO_PITCH apart from the top y.
// Returns the lines drawn (0..3).
// One rhythm for the head's lines (owner, 2026-10-10: the gaps were uneven): 14 px from one line's baseline to the
// next line's capitals. A 24 px line's capitals are 17 px tall and start 6 px into its cell, so 24 px lines sit 31
// apart; the first one goes 14 px under the name's baseline (a 32 px cell's capitals start 9 px in, 23 tall).
enum { POD_LINE_GAP = 14, POD_WHO_PITCH = 17 + POD_LINE_GAP };
static inline int pod_under_32(int name_y) { return name_y + 9 + 23 + POD_LINE_GAP - 6; }
int pod_who_line(ht_scene_t *, int x, int y, int width, const pod_nav_t *, const pod_model_t *, const pod_agent_t *);
// The working status, "S5 . LCD": a dark pill POD_LCD_H tall and `width` wide at (x, y): three animated green bars, the
// dial's verb in light type, the elapsed time m:ss right aligned in light green. 6 runs, whatever the text.
enum { POD_LCD_H = 40 };
void pod_lcd_pill(ht_scene_t *, int x, int y, int width, const pod_agent_t *a, uint32_t now_ms);
// The pill's verb, as the round dial picks it: the engine's activity word (dots dropped) when it is not "Working" and
// fits `room` px, else false and the pill shows the rotating gerund (pod_view_agent.c).
enum { POD_VERB_MAX = 64 };
bool pod_activity_verb(const char *text, char *out, size_t cap, int room);
// The px a pill `width` wide has for its verb: the bars on the left, the time on the right ("00:00" wide).
static inline int pod_lcd_verb_room(int width) { return width - 16 - 33 - 12 - 16 - 62; }
// The verb the round dial shows for a working turn of `secs` seconds ("Working", "Brewing", "Cooking", ...: one per 6 s).
const char *pod_working_verb(uint32_t secs);
