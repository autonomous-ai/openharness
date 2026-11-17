// What Harness Max's screen tests share: the check macro, a roster and a render into one scene.
#pragma once
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "max_ui_internal.h"
#include "pro_canvas.h"
#include "theme.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static ht_scene_t S;

// Agents named after their ids, on one machine; the cable is up.
static inline void roster(const char *const ids[], int n)
{
    pro_agent_row_t rows[MAX_AGENTS + 4];
    for (int i = 0; i < n; i++) rows[i] = (pro_agent_row_t){ids[i], ids[i], "claude", "m1", "MacBook Pro"};
    max_ui_agents(rows, n, 0);
}
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
