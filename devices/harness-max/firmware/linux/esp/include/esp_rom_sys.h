// The ROM's raw reset code on Linux: 0. last_words.c asks only after an abnormal reset, which a Linux run never is.
#pragma once

static inline unsigned esp_rom_get_reset_reason(int cpu) { (void)cpu; return 0; }
