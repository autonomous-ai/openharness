// Pin map for the Harness device (ESP32-S3, 466x466 round AMOLED).
//
// Verified on both shipped boards — see board/board.c for how the two are told apart at boot.
// The AMOLED is powered directly (no AXP2101 rail gating needed for display),
// reset is a real GPIO, and the panel uses the espressif/esp_lcd_co5300 driver.
#pragma once

// ---- AMOLED panel: CO5300 over QSPI ----
#define BSP_LCD_H_RES         466
#define BSP_LCD_V_RES         466
#define BSP_LCD_BIT_PER_PIXEL 16          // RGB565

#define BSP_LCD_QSPI_CS      12
#define BSP_LCD_QSPI_SCLK    38
#define BSP_LCD_QSPI_D0      4
#define BSP_LCD_QSPI_D1      5
#define BSP_LCD_QSPI_D2      6
#define BSP_LCD_QSPI_D3      7
// LCD reset: per board — board()->lcd_rst (board.h). GPIO39 on the CST9217 dial, GPIO1 on the CST816S one.

// ---- I2C bus (touch + PMIC share it) ----
#define BSP_I2C_SDA          15
#define BSP_I2C_SCL          14
#define BSP_I2C_FREQ_HZ      400000

// ---- Capacitive touch: CST9217 (I2C) — wired for future use, not required in v1 ----
// Touch controller address and reset: per board — board()->touch / ->touch_rst (board.h).
#define BSP_TOUCH_INT        11

// ---- Power management: AXP2101 (I2C) ----
#define BSP_AXP2101_I2C_ADDR 0x34         // present only when board()->has_pmic

// ---- Audio: dual-mic → ES7210 ADC (capture) + ES8311 codec, on the shared I2C; I2S bus ----
// Mic capture (ES7210) only in v1.
#define BSP_I2S_MCLK         16           // MCLK is GPIO16 on the shipped board (not 42)
#define BSP_I2S_BCLK         9
#define BSP_I2S_WS           45
#define BSP_I2S_DOUT         8            // codec → ESP (mic data in to ESP)
#define BSP_I2S_DIN          10           // ESP → codec (speaker; unused for mic-only)
#define BSP_PA_IO            46           // speaker power-amp enable (unused for mic-only)
// ES7210 (ADC) + ES8311 (codec) default I2C addresses (esp_codec_dev defaults).

// ---- Buttons ----
#define BSP_BOOT_BUTTON      0            // hold at power-on to factory-reset pairing
