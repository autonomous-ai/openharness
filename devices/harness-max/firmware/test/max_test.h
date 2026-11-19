// What Harness Max's screen tests share: the check macro, a roster, a render into one scene, and the finger's targets
// planted as the pages record them.
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "max_ui_draw.h"   // the drawing's helpers, for test_max_view.c
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
// The room's card as the old view drew it (test_max_view.c): the card is the room agent's as it stands now.
static inline void room_card(void)
{
    const max_agent_t *a = max_find(max_m.selected);
    CHECK(a != NULL);
    max_copy(max_m.card_id, sizeof max_m.card_id, a->id);
    max_m.card_key = max_card_key(a);
}
// The first text run holding `t`, or NULL.
static inline const ht_run_t *text_run(const char *t)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == 1 && strstr(S.runs[i].text, t)) return &S.runs[i];
    return NULL;
}
// App Detail's row as ids, joined by spaces ("d e b a c").
static inline const char *order_ids(char *buf, size_t cap)
{
    int o[MAX_AGENTS], n = max_row(o);
    buf[0] = 0;
    for (int i = 0; i < n; i++) {
        size_t len = strlen(buf);
        snprintf(buf + len, cap - len, "%s%s", i ? " " : "", max_m.agents[o[i]].id);
    }
    return buf;
}

// What a render leaves for the clock, without drawing: the time-dependent picture as of now_ms, nothing pending.
static inline void as_drawn(uint32_t now_ms)
{
    max_m.drawn_key = max_time_key(now_ms);
    max_m.dirty = false;
}

// ---- the finger's targets, planted as a page records them, without drawing: the drawing's layout is its own ----
// What the finger reads after a render of this page, before the page records anything: no hits, no cells.
static inline void drawn_page(max_view_t view)
{
    max_m.view = view;
    max_m.hit_count = 0;
    max_m.cell_hits = 0;
}
// A hit area at (x, y, w, h), after those planted before it (the first match wins).
static inline const max_hit_t *plant_at(max_hit_kind_t kind, int arg, int x, int y, int w, int h)
{
    CHECK(max_m.hit_count < MAX_HITS);
    max_hit_t *hit = &max_m.hits[max_m.hit_count++];
    *hit = (max_hit_t){(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, (uint8_t)kind, (int8_t)arg};
    return hit;
}
// A button: a 90 x 40 box of its own, in rows along the top of the glass.
static inline const max_hit_t *plant(max_hit_kind_t kind, int arg)
{
    const int i = max_m.hit_count;
    return plant_at(kind, arg, i % 19 * 100, i / 19 * 50, 90, 40);
}
// A page-wide target (the agent page's body, Attention's away), planted after the buttons as a page records it.
static inline const max_hit_t *plant_page(max_hit_kind_t kind) { return plant_at(kind, 0, 0, 0, HT_WIDTH, HT_HEIGHT); }
// App Detail's cells on the glass, as max_cells() lists them, side by side under the buttons.
static inline void plant_cells(void)
{
    int c[MAX_CELLS];
    max_m.cell_hits = max_cells(c);
    for (int i = 0; i < max_m.cell_hits; i++) {
        max_m.cell_box[i] = (max_box_t){(int16_t)(i * 300), 200, 280, 100};
        max_copy(max_m.cell_id[i], sizeof max_m.cell_id[i], max_m.agents[c[i]].id);
    }
}
// The cell planted for this agent, or NULL.
static inline const max_box_t *cell_of(const char *id)
{
    for (int i = 0; i < max_m.cell_hits; i++)
        if (!strcmp(max_m.cell_id[i], id)) return &max_m.cell_box[i];
    return NULL;
}
// The slivers beside the open agent, as App Detail draws them: the row's window round it, but the open one.
static inline void plant_slivers(void)
{
    int row[MAX_AGENTS], n = max_row(row), at = 0;
    for (int i = 0; i < n; i++)
        if (!strcmp(max_m.agents[row[i]].id, max_m.selected)) at = i;
    const int first = max_open_first(at, n);
    max_m.cell_hits = 0;
    for (int i = first; i < n && i < first + MAX_CELLS; i++) {
        if (i == at) continue;
        const int k = max_m.cell_hits++;
        max_m.cell_box[k] = (max_box_t){(int16_t)(k * 300), 200, 280, 100};
        max_copy(max_m.cell_id[k], sizeof max_m.cell_id[k], max_m.agents[row[i]].id);
    }
}
// Attention's answer buttons stand for the agent on it as it stands now (card_id, card_key).
static inline void plant_card(void)
{
    const max_agent_t *a = max_find(max_m.attn_id);
    CHECK(a != NULL);
    max_copy(max_m.card_id, sizeof max_m.card_id, a->id);
    max_m.card_key = max_card_key(a);
}
