// The dial's physical key: a tap is back / stop turn (ui_boot_pressed) — BOOT (GPIO0) on the round
// dials, the PWR key on CoreS3. Voice is not on a key; it starts from the on-screen mic (see ptt.c).
// (GPIO0 doubles as factory-reset, but ONLY when held at power-on.)
#pragma once

// Start the button poll task. Call after ui_set_voice().
void ptt_start(void);
