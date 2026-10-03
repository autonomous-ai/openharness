#pragma once
#ifdef DEVICE_OCTOPUS_BENCH
#include "terminal.h"
#include <stdbool.h>
#include <stdint.h>
struct cJSON;
typedef struct { uint32_t sequence; bool matches; } ht_perf_tag_t;
// All model-facing calls run under display_lock. Completion runs after DMA, outside it.
ht_perf_tag_t octopus_perf_capture(const ht_scene_t *scene, bool fresh);
void octopus_perf_paint(uint32_t raster_us, uint32_t paint_us);
void octopus_perf_commit(ht_perf_tag_t tag, uint32_t bytes, uint32_t model_us, uint32_t damage_us);
void octopus_perf_run(void);
bool octopus_perf_animate(void);
void habitat_bench_prepare(bool animate);
void habitat_bench_reader(void);
void habitat_bench_question(const struct cJSON *questions);
bool habitat_bench_pressed(void);
#endif
