// Pro supply policy and battery status.
#pragma once

#include <stdbool.h>

// Configure the supply latch before other initialization.
// The dock-only Pro leaves the battery supply disabled.
void power_hold_init(void);

// Idempotent; safe to call from any task.
bool power_init(void);

// Battery charge percent 0..100, or -1 if unknown (no driver/battery/read error).
int power_battery_pct(void);

// True while the battery is actively charging (drives the charge bolt). False if unknown.
bool power_is_charging(void);

// True while plugged into external power — actively charging OR full/standby. Use this (not
// power_is_charging) to decide "on the charger", so a full battery still counts as plugged in.
bool power_is_on_external(void);


