// Pin map for the Harness device (ESP32-S3, 466x466 round AMOLED).
//
// Verified on both shipped boards — see board/board.c for how the two are told apart at boot.
// The AMOLED is powered directly (no AXP2101 rail gating needed for display),
// reset is a real GPIO, and the panel uses the espressif/esp_lcd_co5300 driver.
//
// DEVICE_BOARD_M5CORES3: M5Stack CoreS3 port (ESP32-S3R8, 2.0" 320x240 ILI9342C, FT6336U
// touch, AXP2101 PMIC, AW9523B IO expander, ES7210 mic ADC, AW88298 speaker amp).
// Pins cross-checked against m5stack/M5GFX, m5stack/M5Unified and espressif/esp-bsp
// (bsp/m5stack_core_s3). The 466x466 round UI renders into a virtual LVGL display and is
// downscaled onto the 320x240 panel — see ui/display.c.
#pragma once

#if defined(DEVICE_BOARD_M5CORES3)

// ---- ILI9342C panel: SPI (landscape 320x240) ----
// Same SPI2 bus also carries the TF card (CS GPIO4); this app does not use the card.
#define BSP_PANEL_H_RES       320
#define BSP_PANEL_V_RES       240
#define BSP_LCD_BIT_PER_PIXEL 16          // RGB565

#define BSP_LCD_SPI_HOST      SPI3_HOST
#define BSP_LCD_SCLK          36
#define BSP_LCD_MOSI          37          // D/C shares GPIO35 with the card MISO — we never read the panel
#define BSP_LCD_CS            3
#define BSP_LCD_DC            35
#define BSP_LCD_RST_GPIO      -1          // reset lives on the AW9523B expander (P1_1), not a GPIO
#define BSP_LCD_PIXEL_CLK_HZ  (40 * 1000 * 1000)

// Virtual 466×466 LVGL surface, integer-halved onto the 320×240 panel.
// Non-integer nearest-neighbour (29/50) shreds 4-bpp fonts (bell, "0 agents"); 1/2 is the
// standard downsample: every panel pixel is a 2×2 of virtual pixels, centred with black bars.
#define BSP_LCD_H_RES         466
#define BSP_LCD_V_RES         466
#define BSP_SCALE_NUM         1
#define BSP_SCALE_DEN         2
#define BSP_PANEL_OFF_X       (-86)       // (320 - 233) / 2 = 43 → virtual 0 at panel x=43
#define BSP_PANEL_OFF_Y       (-6)        // (240 - 233) / 2 = 3  → virtual 0 at panel y=3

// ---- I2C bus (touch + PMIC + codec + expander share it) ----
#define BSP_I2C_SDA          12
#define BSP_I2C_SCL          11
#define BSP_I2C_FREQ_HZ      400000

// ---- Capacitive touch: FT6336U (FT5x06-compatible, I2C 0x38) ----
#define BSP_TOUCH_ADDR        0x38
#define BSP_TOUCH_INT         21          // routed via the AW9523B; polled reads don't need it
#define BSP_TOUCH_INT_NOT_USED 0

// ---- Power management: AXP2101 (I2C) ----
#define BSP_AXP2101_I2C_ADDR 0x34
// AW9523B IO expander (I2C 0x58): drives LCD reset, touch/speaker enables, SY7088 boost.
#define BSP_AW9523_I2C_ADDR   0x58
#define AW9523_P0_OUT         0x02
#define AW9523_P1_OUT         0x03
#define AW9523_P0_CFG         0x04
#define AW9523_P1_CFG         0x05
#define AW9523_GCR            0x11        // bit4: P1 push-pull, bit0: P0 push-pull

// ---- Audio: ES7210 mic ADC + AW88298 smart amp, shared I2S port ----
#define BSP_I2S_MCLK         0            // ES7210 master clock
#define BSP_I2S_BCLK         34
#define BSP_I2S_WS           33
#define BSP_I2S_DOUT         13           // ESP → AW88298 amp
#define BSP_I2S_DIN          14           // ES7210 → ESP (mic data)
#define BSP_PA_IO            -1           // amp enable is AW9523B P0_2 + AXP2101 ALDO1, not a GPIO
#define BSP_ES7210_I2C_ADDR  0x40
#define BSP_AW88298_I2C_ADDR 0x36

// ---- Buttons ----
#define BSP_BOOT_BUTTON      0            // no exposed BOOT key on CoreS3 (GPIO0 is the ES7210 MCLK);
#define BSP_HAS_BOOT_BUTTON  0            // PWR (AXP2101 PWRON) is the only button — see ptt.c

#else  // round Harness dial (upstream pin map)

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
#define BSP_HAS_BOOT_BUTTON  1

#endif
