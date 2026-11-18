// What Harness Max's screen tests share: the check macro, a roster and a render into one scene.
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "max_ui_draw.h"   // max_hit
#include "max_ui_internal.h"
#include "pro_canvas.h"
#include "theme.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static ht_scene_t S;

// Agents named after their ids, on one machine, of one engine.
static inline void roster_of(const char *const ids[], int n, const char *engine)
{
    pro_agent_row_t rows[MAX_AGENTS + 4];
    for (int i = 0; i < n; i++) rows[i] = (pro_agent_row_t){ids[i], ids[i], engine, "m1", "MacBook Pro", NULL, NULL};
    max_ui_agents(rows, n, 0);
}
// Claude's, whose pet moves in the room; the cable is up.
static inline void roster(const char *const ids[], int n) { roster_of(ids, n, "claude"); }
static inline void linked(const char *const ids[], int n)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    roster(ids, n);
}
static inline void render(uint32_t now)
{
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, now);
}
// The middle of lane i as the last render drew it.
static inline int lane_x(int i) { return max_m.lane_box[i].x + max_m.lane_box[i].w / 2; }
static inline int lane_y(int i) { return max_m.lane_box[i].y + max_m.lane_box[i].h / 2; }
// The room's card and buttons as the finger reads them, wherever a view draws them: the card is the room agent's as it
// stands now, and each button asked for gets a box of its own along the top edge of the glass, above every lane.
static inline void room_card(void)
{
    const max_agent_t *a = max_find(max_m.selected);
    CHECK(a != NULL);
    max_copy(max_m.card_id, sizeof max_m.card_id, a->id);
    max_m.card_key = max_card_key(a);
}
static inline const max_hit_t *room_hit(max_hit_kind_t kind, int arg)
{
    const int i = max_m.hit_count;
    max_hit(i * 100, 0, 90, 10, kind, arg);
    CHECK(max_m.hit_count == i + 1);
    return &max_m.hits[i];
}
// The first text run holding `t`, or NULL.
static inline const ht_run_t *text_run(const char *t)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == 1 && strstr(S.runs[i].text, t)) return &S.runs[i];
    return NULL;
}
// The lane order as ids, joined by spaces ("d e b a c").
static inline const char *order_ids(char *buf, size_t cap)
{
    int o[MAX_AGENTS], n = max_order(o);
    buf[0] = 0;
    for (int i = 0; i < n; i++) {
        size_t len = strlen(buf);
        snprintf(buf + len, cap - len, "%s%s", i ? " " : "", max_m.agents[o[i]].id);
    }
    return buf;
}
