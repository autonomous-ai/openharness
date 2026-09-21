// M5Stack CoreS3 board bring-up: AW9523B IO expander + AXP2101 power rails.
//
// DEVICE_BOARD_M5CORES3 only (see CMakeLists.txt). Everything here is cross-checked
// against three independent sources: m5stack/M5GFX (panel reset + backlight via AXP2101
// DLDO1), m5stack/M5Unified (rail voltages, SY7088 boost, AW88298/ES7210 enable bits)
// and espressif/esp-bsp bsp/m5stack_core_s3 (expander pin map, DLDO1 backlight voltage).
#pragma once

#include <stdbool.h>
#include <stdint.h>

// One-time bring-up: configures the expander, enables the rails the screen/audio need.
// Safe to call again; later calls return the same answer.
void cores3_board_power_init(void);

// LCD reset lives on AW9523B P1_1 (there is no GPIO reset line). Pulse low → high and
// settle — call before esp_lcd_panel_init().
void cores3_lcd_reset(void);

// Panel backlight = AXP2101 DLDO1 voltage. 0 turns the LDO off; 255 ≈ 3.3V.
// Same (level + 641) >> 5 mapping M5GFX uses on this board.
void cores3_backlight_set(uint8_t level);

// Speaker/mic analog front-end: AW9523B P0_2 (+ ALDO1 1.8V for the AW88298 on speaker use).
// The AW88298's own I2C registers are the amp's real on/off; this is the rail side.
void cores3_audio_rail(bool on);

// Pulse AW9523B P0.1 (AW88298 reset, active-low). Call before opening the speaker codec.
void cores3_aw88298_reset(void);

// CoreS3 mic routing: the register sequence M5Unified writes on this board (bias, HPF,
// channel power-down, gains), applied after esp_codec_dev's open so the known-good
// board-specific values win. Talks to the ES7210 @0x40 on the shared bus.
void cores3_es7210_apply_sequence(void);
