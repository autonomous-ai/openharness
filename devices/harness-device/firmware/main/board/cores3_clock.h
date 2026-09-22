// The CoreS3's wall clock (BM8563 RTC + the computer's UTC offset). DEVICE_BOARD_M5CORES3 only.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

// Read the RTC into the system time, and the saved UTC offset. After board_i2c is up.
void cores3_clock_init(void);

// The daemon's time (Unix ms) and its UTC offset (minutes east). Sets the system time and the RTC.
void cores3_clock_set(int64_t epoch_ms, int tz_min);

// The computer's local time, or false while the time has never been set.
bool cores3_clock_local(struct tm *out);
