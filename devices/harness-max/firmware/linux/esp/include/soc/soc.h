// Register access on Linux: the LP store registers last_words.c reads after a watchdog reset read 0 and keep nothing,
// as after a power cut.
#pragma once

#define REG_READ(reg) ((void)(reg), 0u)
#define REG_WRITE(reg, value) ((void)(reg), (void)(value))
