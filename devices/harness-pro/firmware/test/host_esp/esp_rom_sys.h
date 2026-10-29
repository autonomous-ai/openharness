// Host-test stand-in for esp_rom_sys.h: the test supplies the reset reason per core.
#pragma once
unsigned esp_rom_get_reset_reason(int cpu_no);
