// Pin map for Harness Pro (ESP32-P4, 720x720 square LCD). Reached through board_pins.h, never directly.
//
// Module: WT01P4C5-S1 (Wireless-Tag) — ESP32-P4 + ESP32-C5 in one package, 16 MB flash, 32 MB hex PSRAM.
//
// EVERY NUMBER HERE WAS READ OFF A WORKING BOARD, not off the schematic: they come from the vendor's
// HARDWARE.md §10, which was written from the BSP that runs on this hardware. Where the schematic and
// that document disagree, the document wins — it is the one that has been on a bench.
//
// The ESP32-C5 half of the module is the Wi-Fi coprocessor (internal SDIO on P4 GPIO14-19). This firmware has no
// Wi-Fi; it only holds the C5 in reset: GPIO13 is its enable, low = reset.
#pragma once

#define BSP_C5_RESET         13           // the C5's enable: low = held in reset, high = running

// ---- LCD panel: ST7703I 720x720 over MIPI-DSI ----
#define BSP_LCD_H_RES         720
#define BSP_LCD_V_RES         720
#define BSP_LCD_BIT_PER_PIXEL 16          // RGB565

#define BSP_LCD_RST          4            // ST7703 reset. A SEPARATE LINE from the touch reset below —
                                          // an earlier revision of this board tied them together and
                                          // this one does not, so the two reset sequences must not be
                                          // merged (HARDWARE.md §13).
#define BSP_LCD_DSI_LANES    2
#define BSP_LCD_DSI_LANE_MBPS 480
#define BSP_LCD_DSI_PHY_LDO_CHAN 3        // internal LDO channel VO3 …
#define BSP_LCD_DSI_PHY_LDO_MV   2500     // … at 2500 mV, powered before the DSI bus is created

// ---- Backlight: PWM into the feedback pin of an AP3032 boost ----
// Real dimming: duty is INVERTED (a higher duty is dimmer), so pro_panel_bus.c converts a percentage
// rather than writing it straight through.
#define BSP_LCD_BL_PWM       21           // LEDC
#define BSP_LCD_BL_EN        11           // boost enable (also pulled up by R27)
#define BSP_LCD_BL_FREQ_HZ   5000
#define BSP_LCD_BL_RES_BITS  10

// ---- I2C bus: touch + both codecs + the power IC ----
// Hand-fitted 2.2k pull-ups to 3V3 on both lines, with the P4's internal pull-ups on top.
#define BSP_I2C_PORT         1
#define BSP_I2C_SDA          7
#define BSP_I2C_SCL          8
#define BSP_I2C_FREQ_HZ      400000

// ---- Capacitive touch: GT911 ----
// ⚠️ GT911 LATCHES ITS OWN I2C ADDRESS from the level of INT at the rising edge of RESET, so the order
// in board_pro.c is load-bearing and the esp_lcd_touch driver must be given GPIO_NUM_NC for its reset:
// the board layer has already done it by hand (HARDWARE.md §5).
#define BSP_TOUCH_RST        26
#define BSP_TOUCH_INT        27
#define BSP_TOUCH_ADDR       0x5D         // primary; 0x14 is the fallback the probe tries next
#define BSP_TOUCH_ADDR_ALT   0x14

// ---- Audio: ES8311 (speaker DAC + amp) + ES7210 (3-mic array), one shared I2S bus ----
#define BSP_I2S_MCLK         23
#define BSP_I2S_BCLK         22
#define BSP_I2S_WS           10
#define BSP_I2S_DOUT         9            // P4 → ES8311 (speaker)
#define BSP_I2S_DIN          46           // ES7210 → P4 (microphones)
#define BSP_PA_IO            54           // CTRL_SPK → NS4150B amplifier enable

// THREE mics, and the TDM slot order is NOT the physical order. Measured on this board:
//   slot 0 = MIC1 (front-left)   slot 1 = MIC3 (rear)   slot 2 = MIC2 (front-right)   slot 3 = unwired
// Two kinds of mask follow from that and they must never be swapped even though their bit ranges
// overlap: gain is set per PHYSICAL mic, capture channels are chosen per SERIALIZED TDM slot.
#define BSP_ES7210_TDM_SLOTS 4
#define BSP_ES7210_SLOT_MIC1 0
#define BSP_ES7210_SLOT_MIC3 1
#define BSP_ES7210_SLOT_MIC2 2

// ---- Power: IP5306 charger/boost + the battery-supply gate (kept off: dock-only) ----
#define BSP_IP5306_I2C_ADDR  0x75
// PWR_HOLD is the gate of the board's battery boost supply. This firmware is dock-only (USB powers the board), so
// power_hold_init() drives it LOW at the start of app_main and never raises it; the analog latch the button sets lets go
// on its own, which is fine on USB. A build that must run from the cell would have to drive it high in the first lines.
#define BSP_PWR_HOLD         1            // output, high = stay on; low = cut power immediately
#define BSP_PWR_BTN          2            // input, active low — the physical button, independent of the latch
// Battery percentage comes from a divider, NOT from the IP5306's own fuel-gauge register: that register
// is documented only by community reverse-engineering and reads back nonsense on this board.
#define BSP_VBAT_ADC_GPIO    20           // ADC1 channel 4, VBAT/3 through a 200k/100k divider
#define BSP_VBAT_DIVIDER     3

// ---- Other peripherals ----
#define BSP_WS2812_IO        3            // single RGB LED, RMT, GRB order
#define BSP_HAPTIC_IO        28           // vibration motor, LEDC PWM

// ---- microSD (SDMMC slot 0 — fixed IO MUX pins on the P4, not remappable) ----
#define BSP_SD_D0            39
#define BSP_SD_D1            40
#define BSP_SD_D2            41
#define BSP_SD_D3            42
#define BSP_SD_CLK           43
#define BSP_SD_CMD           44
#define BSP_SD_LDO_CHAN      4            // internal LDO VO4 …
#define BSP_SD_LDO_MV        3300         // … at 3300 mV, required before a card will mount

// ---- Buttons ----
// There is no BOOT-button factory reset on this board: its only button is the
// power button above, and it is read through BSP_PWR_BTN.
