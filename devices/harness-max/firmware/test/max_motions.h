// App Detail's row in motion, as the benches replay it (test/max_motion_bench.c on the host, bench/ on the ESP32-P4):
// each from its page at rest (set_up, drawing through the bench's own frame what it must), started at T0 (go), and
// stepped before each of its first `steps` frames, one frame every MAX_ROW_FRAME_MS, until the row stops moving.
// Included after max_render.c: its demo model and its helpers.
#pragma once

typedef void (*max_motion_draw_t)(uint32_t now);
typedef struct {
    const char *name;
    void (*set_up)(max_motion_draw_t draw);
    void (*go)(void);
    void (*step)(int frame, uint32_t now);
    int steps;
} max_motion_t;

static void motion_overview(max_motion_draw_t draw)
{
    (void)draw;
    orca();
    show(MAX_VIEW_OVERVIEW, NULL);
}
static void motion_agent(max_motion_draw_t draw)
{
    orca();
    show(MAX_VIEW_OVERVIEW, NULL);
    draw(T0 - 2000);
    max_open("rate");
}
static void motion_none(void) {}
static void motion_open(void) { max_open("rate"); }
static void motion_close(void) { max_show(MAX_VIEW_OVERVIEW); }
// A finger across the row at 750 px/s for 40 frames from 1400, then let go: the row follows it, then settles.
static void motion_drag_row(int frame, uint32_t now)
{
    if (frame == 0) max_ui_touch(true, 1400, 240, now);
    else if (frame <= 40) max_ui_touch(true, 1400 - 12 * frame, 240, now);
    else if (frame == 41) max_ui_touch(false, 1400 - 12 * 40, 240, now);
}
// The same over the slivers beside the open agent: from the right one, the row dragged the other way.
static void motion_drag_slivers(int frame, uint32_t now)
{
    if (frame == 0) max_ui_touch(true, 1650, 240, now);
    else if (frame <= 30) max_ui_touch(true, 1650 + 4 * frame, 240, now);
    else if (frame == 31) max_ui_touch(false, 1650 + 4 * 30, 240, now);
}

static const max_motion_t MAX_MOTIONS[] = {
    {"drag + snap", motion_overview, motion_none, motion_drag_row, 42},
    {"open", motion_overview, motion_open, NULL, 0},
    {"close", motion_agent, motion_close, NULL, 0},
    {"drag slivers", motion_agent, motion_none, motion_drag_slivers, 32},
};
enum { MAX_MOTION_COUNT = sizeof MAX_MOTIONS / sizeof MAX_MOTIONS[0] };
