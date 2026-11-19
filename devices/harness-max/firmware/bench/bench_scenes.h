// The scenes the bench times, the same on the host and on the ESP32-P4: test/max_render.c's screens (the ones the
// goldens hash) and a few frames that change only part of a screen. Each call sets up the UI model afresh.
#pragma once

#include "terminal.h"

int bench_screen_count(void);
const char *bench_screen_name(int i);
// Screen i, drawn as max_app.c draws it, into `out`.
void bench_screen(int i, ht_scene_t *out);
// The last screen set up, drawn again into `out`: the scene building alone, which the render task does every frame.
void bench_redraw(ht_scene_t *out);

int bench_partial_count(void);
const char *bench_partial_name(int i);
// Frame i: the screen as drawn at one moment (`before`) and a moment later (`after`). The damage between them is what
// a frame repaints. The last is a synthetic frame of motion: most of Overview 40 px to the right.
void bench_partial(int i, ht_scene_t *before, ht_scene_t *after);

// The row's motions (test/max_motions.h): motion i replayed from its page at rest, one frame every MAX_ROW_FRAME_MS of
// the row's clock from T0 until the row rests, each frame drawn by `frame` (its number, or -1 for the frames that set
// the page up). Returns the motion's frames; at most BENCH_MOTION_FRAMES.
enum { BENCH_MOTION_FRAMES = 128 };
int bench_motion_count(void);
const char *bench_motion_name(int i);
int bench_motion(int i, void (*frame)(uint32_t now, int f));
// The UI as it stands drawn at `now` into `out`, as the render task draws it.
void bench_draw(ht_scene_t *out, uint32_t now);
