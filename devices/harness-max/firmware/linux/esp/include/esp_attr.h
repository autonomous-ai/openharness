// The device's memory placement attributes mean nothing in a Linux process: one memory, and no reset it survives, so
// RTC_NOINIT data starts zeroed every run (last_words.c then sees a power-on).
#pragma once

#define IRAM_ATTR
#define RTC_NOINIT_ATTR
