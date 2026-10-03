#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef DEVICE_PERF_BENCH
void ui_perf_flush(size_t bytes);
void ui_perf_flush_done(void);
int64_t ui_perf_last_done(void);
void ui_perf_run(void);
#else
static inline void ui_perf_flush(size_t bytes) { (void)bytes; }
static inline void ui_perf_flush_done(void) {}
#endif
