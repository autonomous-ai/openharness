// AXP2101 PMIC (I2C 0x34, shared bus) — minimal read-only battery status for the status bar.
#pragma once

#include <stdbool.h>

// Lazily attach the AXP2101 to the shared I2C bus. Idempotent; safe to call from any task.
// Returns false if the device couldn't be added (then the getters report "unknown").
bool power_init(void);

// Drain a single short-press "tap" of button A (the PWR key, wired to the AXP2101 PWRON pin, not a GPIO),
// read over I2C. Returns true once per short press. A LONG press is handled by the AXP2101 itself as a
// hardware restart and is never seen here.
bool power_take_pwrkey_tap(void);
