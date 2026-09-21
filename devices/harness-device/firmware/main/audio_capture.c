#include "audio_capture.h"
#include "board_pins.h"
#include "board/board_i2c.h"
#include "board/cores3_board.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "es7210_adc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "audio_cap";

static i2s_chan_handle_t s_rx, s_tx;
static const audio_codec_data_if_t *s_data_if;
static const audio_codec_ctrl_if_t *s_ctrl_if;
static const audio_codec_if_t *s_es7210;
static esp_codec_dev_handle_t s_mic;
static bool s_open;

// Speaker codec: ES8311 on the round dial, AW88298 smart amp on CoreS3 — both OUT paths for
// the notification beep, sharing the I2C control bus and the full-duplex I2S port with the mic.
static const audio_codec_ctrl_if_t *s_spk_ctrl;
static const audio_codec_gpio_if_t *s_gpio_if;
static const audio_codec_if_t *s_spk_codec;
static esp_codec_dev_handle_t s_spk;
static TaskHandle_t s_beep_task;

// Pre-rendered "beep beep beep": BEEP_COUNT 80ms ~2kHz square tones with 60ms gaps, at AUDIO_SAMPLE_RATE.
#define BEEP_SAMPLES (AUDIO_SAMPLE_RATE * 80 / 1000)
#define GAP_SAMPLES  (AUDIO_SAMPLE_RATE * 60 / 1000)
#define BEEP_COUNT   3
#define TONE_SAMPLES (BEEP_SAMPLES * BEEP_COUNT + GAP_SAMPLES * (BEEP_COUNT - 1))
static int16_t s_tone[TONE_SAMPLES];

static void render_tone(void)
{
    const int half = AUDIO_SAMPLE_RATE / 2000 / 2;   // half-period of a ~2kHz square wave
    const int16_t amp = 6000;
    int i = 0;
    for (int b = 0; b < BEEP_COUNT; b++) {
        for (int n = 0; n < BEEP_SAMPLES; n++, i++)
            s_tone[i] = ((n / (half > 0 ? half : 1)) & 1) ? amp : -amp;
        if (b < BEEP_COUNT - 1) for (int n = 0; n < GAP_SAMPLES; n++, i++) s_tone[i] = 0;
    }
}

static void play_beep(void)
{
    if (!s_spk) return;
    esp_codec_dev_sample_info_t fs = { .sample_rate = AUDIO_SAMPLE_RATE, .channel = 1, .bits_per_sample = 16 };
    if (esp_codec_dev_open(s_spk, &fs) != ESP_OK) { ESP_LOGW(TAG, "spk open failed"); return; }
    esp_codec_dev_set_out_vol(s_spk, 100);
    esp_codec_dev_write(s_spk, s_tone, sizeof(s_tone));
    esp_codec_dev_close(s_spk);
    ESP_LOGI(TAG, "beep");
}

static void beep_task(void *arg)
{
    (void)arg;
    while (1) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        play_beep();
    }
}

void audio_notify_init(void)
{
    if (s_beep_task) return;
    if (!s_mic && !audio_capture_init()) { ESP_LOGW(TAG, "notify init: I2S unavailable"); return; }

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = I2C_NUM_0,
#if defined(DEVICE_BOARD_M5CORES3)
        .addr = AW88298_CODEC_DEFAULT_ADDR,
#else
        .addr = ES8311_CODEC_DEFAULT_ADDR,
#endif
        .bus_handle = board_i2c_get(),
    };
    s_spk_ctrl = audio_codec_new_i2c_ctrl(&i2c_cfg);
    s_gpio_if = audio_codec_new_gpio();
    if (!s_spk_ctrl || !s_gpio_if) { ESP_LOGW(TAG, "spk ctrl/gpio if failed"); return; }

#if defined(DEVICE_BOARD_M5CORES3)
    // AW88298 smart amp: RST is AW9523 P0.1 (xiaozhi ResetAw88298). pa_gain 15 per esp-bsp.
    cores3_aw88298_reset();
    cores3_audio_rail(true);
    aw88298_codec_cfg_t aw_cfg = {
        .ctrl_if = s_spk_ctrl,
        .gpio_if = s_gpio_if,
        .reset_pin = -1,  // hardware reset is AW9523 P0.1, not a GPIO
        .hw_gain = { .pa_voltage = 5.0f, .codec_dac_voltage = 3.3f, .pa_gain = 15 },
    };
    s_spk_codec = aw88298_codec_new(&aw_cfg);
    if (!s_spk_codec) { ESP_LOGW(TAG, "aw88298 new — no speaker"); return; }
#else
    es8311_codec_cfg_t es_cfg = {
        .ctrl_if = s_spk_ctrl,
        .gpio_if = s_gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = BSP_PA_IO,            // speaker power-amp enable — codec toggles it on open/close
        .use_mclk = true,
    };
    s_spk_codec = es8311_codec_new(&es_cfg);
    if (!s_spk_codec) { ESP_LOGW(TAG, "es8311 new — no speaker?"); return; }
#endif

    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
        .codec_if = s_spk_codec,
        .data_if = s_data_if,
    };
    s_spk = esp_codec_dev_new(&dev_cfg);
    if (!s_spk) { ESP_LOGW(TAG, "spk codec_dev new failed"); return; }

    render_tone();
    // The full codec-open path retained only 688 B on a 3 KiB stack during
    // event stress. Four KiB restores the 25% and 1 KiB margins.
    xTaskCreate(beep_task, "beep", 4096, NULL, 5, &s_beep_task);
#if defined(DEVICE_BOARD_M5CORES3)
    ESP_LOGI(TAG, "speaker (AW88298) ready");
#else
    ESP_LOGI(TAG, "speaker (ES8311) ready");
#endif
}

void audio_notify_done(void)
{
    static int64_t last_us;
    if (!s_beep_task) return;
    int64_t now = esp_timer_get_time();
    if (now - last_us < 1000000) return;   // debounce: at most one beep per ~1s
    last_us = now;
    xTaskNotifyGive(s_beep_task);
}

bool audio_capture_init(void)
{
    if (s_mic) return true;

#if defined(DEVICE_BOARD_M5CORES3)
    // The mic path's rails (ALDO2 → ES7210, P0_2 analog front-end) come up with the board.
    cores3_board_power_init();
#endif

    // Full-duplex I2S (BSP-exact): ES7210(ADC)+ES8311/AW88298 share BCLK/WS, so create both
    // tx+rx and enable them — RX-only setups leave the shared clocks misconfigured → silence.
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, &s_tx, &s_rx) != ESP_OK) { ESP_LOGE(TAG, "i2s_new_channel"); return false; }

    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = BSP_I2S_MCLK,
            .bclk = BSP_I2S_BCLK,
            .ws = BSP_I2S_WS,
            .dout = BSP_I2S_DOUT,
            .din = BSP_I2S_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(s_tx, &std) != ESP_OK) { ESP_LOGE(TAG, "i2s init tx"); return false; }
    if (i2s_channel_init_std_mode(s_rx, &std) != ESP_OK) { ESP_LOGE(TAG, "i2s init rx"); return false; }
    i2s_channel_enable(s_tx);
    i2s_channel_enable(s_rx);

    // esp_codec_dev: I2S data interface + ES7210 over the shared I2C control bus.
    audio_codec_i2s_cfg_t i2s_cfg = { .port = I2S_NUM_0, .rx_handle = s_rx, .tx_handle = s_tx };
    s_data_if = audio_codec_new_i2s_data(&i2s_cfg);
    if (!s_data_if) { ESP_LOGE(TAG, "i2s data_if"); return false; }

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = I2C_NUM_0,
        .addr = ES7210_CODEC_DEFAULT_ADDR,
        .bus_handle = board_i2c_get(),
    };
    s_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    if (!s_ctrl_if) { ESP_LOGE(TAG, "es7210 ctrl_if"); return false; }

    es7210_codec_cfg_t es_cfg = {
        .ctrl_if = s_ctrl_if,
#if defined(DEVICE_BOARD_M5CORES3)
        // CoreS3 has two mics on ES7210 ch1/ch2 (xiaozhi also enables MIC3 as a reference
        // channel; we don't do AEC, so just the pair).
        .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2,
#endif
    };
    s_es7210 = es7210_codec_new(&es_cfg);
    if (!s_es7210) { ESP_LOGE(TAG, "es7210 new"); return false; }

    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = s_es7210,
        .data_if = s_data_if,
    };
    s_mic = esp_codec_dev_new(&dev_cfg);
    if (!s_mic) { ESP_LOGE(TAG, "codec_dev new"); return false; }
    ESP_LOGI(TAG, "mic (ES7210) ready");
    return true;
}

bool audio_capture_start(void)
{
    if (!s_mic && !audio_capture_init()) return false;
    if (s_open) return true;
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = AUDIO_SAMPLE_RATE,
        .channel = 1,
        .bits_per_sample = 16,
    };
    if (esp_codec_dev_open(s_mic, &fs) != ESP_OK) { ESP_LOGE(TAG, "codec open"); return false; }
#if defined(DEVICE_BOARD_M5CORES3)
    // The CoreS3 mics sit behind an ES7210 routing M5Unified tunes with a fixed register
    // sequence (mic bias, HPF, channel power-down). The driver's own defaults are written at
    // open; this re-pins the board-specific parts last so its known-good values win.
    cores3_es7210_apply_sequence();
#endif
    // Make sure the I2S RX clock is running (esp_codec_dev_open may leave it disabled).
    esp_err_t en = i2s_channel_enable(s_rx);
    if (en != ESP_OK && en != ESP_ERR_INVALID_STATE) ESP_LOGW(TAG, "i2s enable: %s", esp_err_to_name(en));
    esp_codec_dev_set_in_gain(s_mic, 37.5);  // higher analog mic gain
    s_open = true;
    ESP_LOGI(TAG, "mic stream open (%d Hz mono)", AUDIO_SAMPLE_RATE);
    return true;
}

int audio_capture_read(uint8_t *buf, int len)
{
    if (!s_open) return -1;
    int r = esp_codec_dev_read(s_mic, buf, len);
    return (r == ESP_CODEC_DEV_OK) ? len : -1;
}

void audio_capture_stop(void)
{
    if (s_open) { esp_codec_dev_close(s_mic); s_open = false; }
}
