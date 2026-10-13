// Host-test stand-in for esp_system.h (fw_update.c's weak restart; the test overrides it).
#pragma once
void esp_restart(void);
