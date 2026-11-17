// Pin map of the Harness Max bring-up board: a Waveshare ESP32-P4-NANO (ESP32-P4NRW32X, chip v3.x, 16 MB flash,
// 32 MB PSRAM, an ESP32-C6 over SDIO) with the Waveshare 8.8-DSI-TOUCH-A panel.
//
// NONE OF THESE NUMBERS HAS BEEN ON A BENCH. They come from Waveshare's BSP (`waveshare/esp32_p4_platform` 2.0.1,
// `waveshare/esp_lcd_ota7290b` 2.0.0) and the board's wiki. Where the bench disagrees, the bench wins: change them
// here and say so in this comment, as pins_pro.h does for the Pro.
#pragma once

// ---- The ESP32-C6: unused (the bar talks over the cable), its enable held low ----
#define MAX_C6_RESET          54          // the C6's CHIP_PU: low = held in reset (esp_hosted's reset line on the NANO)

// ---- Panel: OTA7290B, 480 x 1920 native portrait, MIPI-DSI ----
#define MAX_LCD_H_RES         480
#define MAX_LCD_V_RES         1920
#define MAX_LCD_BIT_PER_PIXEL 16          // RGB565
#define MAX_LCD_DSI_PHY_LDO_CHAN 3        // internal LDO channel VO3 feeds VDD_MIPI_DPHY …
#define MAX_LCD_DSI_PHY_LDO_MV   2500     // … at 2500 mV, up before the DSI bus is created
// No reset line: the panel comes up with the display board's power, below.

// ---- The display board's MCU: the panel's power and its backlight ----
// Register 0x95 powers the panel (0x11, then 0x17: the panel driver writes both while it opens the panel).
#define MAX_DISP_MCU_ADDR     0x45
#define MAX_DISP_MCU_I2C_HZ   100000      // the speed the BSP and the panel driver talk to it at
#define MAX_DISP_REG_LEVEL    0x96        // backlight 0x00 (dark) .. 0xFF

// ---- I2C: touch, codec and the display MCU on one bus ----
// The panel driver opens port 1 on GPIO7/8 by itself (literals in esp_lcd_ota7290b.c), so these must stay these.
#define MAX_I2C_PORT          1
#define MAX_I2C_SDA           7
#define MAX_I2C_SCL           8
#define MAX_I2C_HZ            400000

// ---- Touch: GT9271, read through the GT911 driver ----
// INT and RST are not wired to the P4, so the address is whatever the chip strapped itself to (probe both) and the
// controller is polled.
#define MAX_TOUCH_ADDR        0x14
#define MAX_TOUCH_ADDR_ALT    0x5D

// ---- Audio: one ES8311 (speaker DAC and one analog mic ADC), one I2S bus ----
#define MAX_I2S_MCLK          13
#define MAX_I2S_BCLK          12
#define MAX_I2S_WS            10
#define MAX_I2S_DOUT          9           // P4 -> ES8311 (speaker)
#define MAX_I2S_DIN           11          // ES8311 -> P4 (microphone)
#define MAX_PA_IO             53          // speaker amplifier enable

// ---- The cable ----
// The P4's own USB-Serial-JTAG is on GPIO24 (D-) and GPIO25 (D+). The NANO does not route it to a connector (its USB-C
// is a CH343 on UART0), so bring-up wires those two pins to a USB cable; the product board exposes them.
