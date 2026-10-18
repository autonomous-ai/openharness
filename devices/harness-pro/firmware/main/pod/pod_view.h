#pragma once
// Pod's screens. Each view fills an ht_scene_t and a hit list from the navigation stack and the model. Pure
// C11 apart from the scene: no I/O and no clock (now_ms is passed in).
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#include "pod_draw.h"
#include "pod_nav.h"
#include "pod_pet.h"
#include "pod_time.h"

// A hit names what it opens: arg is the index at draw time, id the agent or tab (empty for the buttons). The list can reorder
// before the tap lands, so the glue resolves the id, not the index.
typedef struct { int16_t x, y, w, h; pod_action_t action; int16_t arg; char id[ID_MAX]; } pod_hit_t;
// banner: set by the glue before pod_render when it will add the notice toast after it (the Update screen clears it).
typedef struct { ht_scene_t *scene; pod_hit_t hits[32]; uint8_t hit_count;
                 bool banner;
                 int mic_level;   // 0..4, pro_rec_level(): set by the app layer before rendering; the Pets voice wave reads it
               } pod_out_frame_t;

// Layout, in px on the 720 x 720 glass. POD_TRANSPORT_Y: the notice pill sits above it.
enum { POD_W = 720, POD_TRANSPORT_Y = 594 };

// ---- the screen -----------------------------------------------------------------------------------------
// Draws the Pets screen the top frame names (ph_render). It advances the model's clock to now_ms first (pod_model_clock),
// so every reader applies the same stale rule.
void pod_render(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);

// ---- scrolling is in rows ---------------------------------------------------------------------------------
// Frame.scroll counts rows, whatever the screen draws a row as. Pixels of finger travel become rows in the glue:
// the pitch is the px one row occupies on the top screen (0: it does not scroll) and the max is its last valid
// offset (the views clamp their own draw to it as well).
int pod_scroll_pitch(const pod_nav_t *);
int pod_scroll_max(const pod_nav_t *, const pod_model_t *);

// ---- shared helpers (pod_shared.c) ------------------------------------------------------------------------
bool pod_hit_add(pod_out_frame_t *, int x, int y, int w, int h, pod_action_t action, int arg);
bool pod_hit_add_id(pod_out_frame_t *, int x, int y, int w, int h, pod_action_t action, int arg, const char *id);
// Home's pages: one a tab, and the Notices card first while there are notices.
int pod_tabs_pages_of(const pod_nav_t *, const pod_model_t *);
uint32_t pod_agent_secs(const pod_agent_t *, uint32_t now_ms);              // elapsed while working, else the last
// Milliseconds until the agent's shown elapsed text next changes (pod_elapsed_next_ms, from where it is in its second);
// UINT32_MAX when it is not working: its clock does not run, nothing to redraw.
uint32_t pod_agent_timer_ms(const pod_agent_t *, uint32_t now_ms);
// "now", "3m", "1h", "2d" for an age in seconds.
void pod_fmt_age(char *out, size_t n, uint32_t secs);

// Pets: the notice toast (ph_toast) shows this long and slides in over POD_TOAST_SLIDE_MS; the glue's banner plumbing times it.
enum { POD_TOAST_MS = 5000, POD_TOAST_SLIDE_MS = 450 };
// Milliseconds until the top screen next draws something different: the pet's next step and every animation beside it.
// POD_PET_STEP_MS when unsure. Always >= 1.
uint32_t pod_view_next_ms(const pod_nav_t *, const pod_model_t *, uint32_t now_ms);
