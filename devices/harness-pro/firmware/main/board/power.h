// Pro supply policy and battery status.
#pragma once

#include <stdbool.h>

// Configure the supply latch before other initialization.
// The dock-only Pro leaves the battery supply disabled.
void power_hold_init(void);

// Idempotent; safe to call from any task.
bool power_init(void);

// True while the battery is actively charging (drives the charge bolt). False if unknown.
bool power_is_charging(void);


