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
// pro_frame_present repaints.
void bench_partial(int i, ht_scene_t *before, ht_scene_t *after);
