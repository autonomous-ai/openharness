// Microphone capture for the Pro. Taken from the round firmware's audio_capture.c (the Habitat/Pod build): the same
// full-duplex I2S set-up, because the ES7210 and the ES8311 share BCLK and WS and an RX-only channel leaves the
// shared clocks mis-configured (silence). The speech output is not part of the Pro; the notification beep is.
#include "audio/audio_capture.h"

#include <stdatomic.h>

#include "board/board_i2c.h"
#include "board_pins.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "audio_cap";

static i2s_chan_handle_t s_rx, s_tx;
static const audio_codec_data_if_t *s_data_if;
static const audio_codec_ctrl_if_t *s_ctrl_if;
static const audio_codec_if_t *s_es7210;
static esp_codec_dev_handle_t s_mic;
static atomic_bool s_open;   // the mic stream; read by the beep task
static const audio_codec_ctrl_if_t *s_spk_ctrl;
static const audio_codec_gpio_if_t *s_gpio_if;
static const audio_codec_if_t *s_es8311;
static esp_codec_dev_handle_t s_spk;
static TaskHandle_t s_beep_task;
static atomic_uint s_rx_overruns;

uint32_t audio_capture_overruns(void) { return atomic_load(&s_rx_overruns); }

static bool rx_overrun(i2s_chan_handle_t channel, i2s_event_data_t *event, void *ctx)
{
    (void)channel; (void)event; (void)ctx;
    atomic_fetch_add_explicit(&s_rx_overruns, 1, memory_order_relaxed);
    return false;
}

static bool capture_init_failed(const char *why)
{
    if (s_mic) { esp_codec_dev_delete(s_mic); s_mic = NULL; }
    if (s_es7210) { audio_codec_delete_codec_if(s_es7210); s_es7210 = NULL; }
    if (s_ctrl_if) { audio_codec_delete_ctrl_if(s_ctrl_if); s_ctrl_if = NULL; }
    if (s_data_if) { audio_codec_delete_data_if(s_data_if); s_data_if = NULL; }
    if (s_rx) { i2s_channel_disable(s_rx); i2s_del_channel(s_rx); s_rx = NULL; }
    if (s_tx) { i2s_channel_disable(s_tx); i2s_del_channel(s_tx); s_tx = NULL; }
    ESP_LOGE(TAG, "microphone unavailable: %s", why);
    return false;
}

bool audio_capture_init(void)
{
    if (s_mic) return true;

    // Full-duplex I2S (BSP-exact): both channels are created and enabled.
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;   // an idle TX channel plays silence, not stale DMA contents
    chan_cfg.dma_frame_num = 160; // 10 ms of mono PCM at 16 kHz
    chan_cfg.dma_desc_num = 12;   // 120 ms of DMA headroom, independent of the USB sender
    if (i2s_new_channel(&chan_cfg, &s_tx, &s_rx) != ESP_OK) return capture_init_failed("I2S allocation");

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
    if (i2s_channel_init_std_mode(s_tx, &std) != ESP_OK) return capture_init_failed("I2S TX init");
    if (i2s_channel_init_std_mode(s_rx, &std) != ESP_OK) return capture_init_failed("I2S RX init");
    i2s_event_callbacks_t callbacks = {.on_recv_q_ovf = rx_overrun};
    if (i2s_channel_register_event_callback(s_rx, &callbacks, NULL) != ESP_OK)
        return capture_init_failed("I2S callback");
    if (i2s_channel_enable(s_tx) != ESP_OK) return capture_init_failed("I2S TX enable");
    if (i2s_channel_enable(s_rx) != ESP_OK) return capture_init_failed("I2S RX enable");

    // esp_codec_dev: I2S data interface + the ES7210 over the shared I2C control bus.
    audio_codec_i2s_cfg_t i2s_cfg = { .port = I2S_NUM_0, .rx_handle = s_rx, .tx_handle = s_tx };
    s_data_if = audio_codec_new_i2s_data(&i2s_cfg);
    if (!s_data_if) return capture_init_failed("I2S interface allocation");

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = I2C_NUM_0,
        .addr = ES7210_CODEC_DEFAULT_ADDR,
        .bus_handle = board_i2c_get(),
    };
    s_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    if (!s_ctrl_if) return capture_init_failed("control interface allocation");

    // mic_selected stays at the driver default, as in the vendor BSP and the round firmware: an explicit wrong
    // selection captures silence.
    es7210_codec_cfg_t es_cfg = { .ctrl_if = s_ctrl_if };
    s_es7210 = es7210_codec_new(&es_cfg);
    if (!s_es7210) return capture_init_failed("codec allocation");

    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
        .codec_if = s_es7210,
        .data_if = s_data_if,
    };
    s_mic = esp_codec_dev_new(&dev_cfg);
    if (!s_mic) return capture_init_failed("device allocation");
    ESP_LOGI(TAG, "mic (ES7210) ready");
    return true;
}

// ES8311 speaker path for the notification beep, ported from the round firmware: 3 tones of 80 ms at ~2 kHz with 60 ms
// gaps, generated 20 ms at a time. It shares the I2S and the I2C bus with the microphone.
#define BEEP_SAMPLES (AUDIO_SAMPLE_RATE * 80 / 1000)
#define GAP_SAMPLES  (AUDIO_SAMPLE_RATE * 60 / 1000)
#define BEEP_COUNT   3
#define TONE_SAMPLES (BEEP_SAMPLES * BEEP_COUNT + GAP_SAMPLES * (BEEP_COUNT - 1))
#define TONE_BLOCK_SAMPLES (AUDIO_SAMPLE_RATE / 50)
static int16_t s_tone[TONE_BLOCK_SAMPLES];

static void render_tone(size_t offset, size_t count)
{
    const int half = AUDIO_SAMPLE_RATE / 2000 / 2;   // half-period of a ~2 kHz square wave
    const int16_t amp = 6000;
    for (size_t i = 0; i < count; i++) {
        size_t phase = (offset + i) % (BEEP_SAMPLES + GAP_SAMPLES);
        s_tone[i] = phase < BEEP_SAMPLES ? (((phase / (half > 0 ? half : 1)) & 1) ? amp : -amp) : 0;
    }
}

static void play_beep(void)
{
    if (s_open) return;   // a recording is open
    esp_codec_dev_sample_info_t fs = { .sample_rate = AUDIO_SAMPLE_RATE, .channel = 1, .bits_per_sample = 16 };
    if (esp_codec_dev_open(s_spk, &fs) != ESP_OK) { ESP_LOGW(TAG, "spk open failed"); return; }
    esp_codec_dev_set_out_vol(s_spk, 100);
    for (size_t offset = 0; offset < TONE_SAMPLES;) {
        if (s_open) break;   // a recording started: stop within one 20 ms write
        size_t count = TONE_SAMPLES - offset;
        if (count > TONE_BLOCK_SAMPLES) count = TONE_BLOCK_SAMPLES;
        render_tone(offset, count);
        if (esp_codec_dev_write(s_spk, s_tone, (int)(count * sizeof s_tone[0])) != ESP_CODEC_DEV_OK) { ESP_LOGW(TAG, "spk write failed"); break; }
        offset += count;
    }
    esp_codec_dev_close(s_spk);
    ESP_LOGI(TAG, "beep");
}

static void beep_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        play_beep();
    }
}

static void speaker_init_failed(const char *why)
{
    if (s_spk) { esp_codec_dev_delete(s_spk); s_spk = NULL; }
    if (s_es8311) { audio_codec_delete_codec_if(s_es8311); s_es8311 = NULL; }
    if (s_gpio_if) { audio_codec_delete_gpio_if(s_gpio_if); s_gpio_if = NULL; }
    if (s_spk_ctrl) { audio_codec_delete_ctrl_if(s_spk_ctrl); s_spk_ctrl = NULL; }
    ESP_LOGW(TAG, "speaker unavailable: %s", why);
}

void audio_beep_init(void)
{
    if (s_beep_task) return;
    if (!s_mic && !audio_capture_init()) { ESP_LOGW(TAG, "speaker: I2S unavailable"); return; }
    audio_codec_i2c_cfg_t i2c_cfg = { .port = I2C_NUM_0, .addr = ES8311_CODEC_DEFAULT_ADDR, .bus_handle = board_i2c_get() };
    s_spk_ctrl = audio_codec_new_i2c_ctrl(&i2c_cfg);
    s_gpio_if = audio_codec_new_gpio();
    if (!s_spk_ctrl || !s_gpio_if) { speaker_init_failed("control/GPIO allocation"); return; }
    es8311_codec_cfg_t es_cfg = {
        .ctrl_if = s_spk_ctrl,
        .gpio_if = s_gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = BSP_PA_IO,   // NS4150B amplifier enable; the codec toggles it on open/close
        .use_mclk = true,
    };
    s_es8311 = es8311_codec_new(&es_cfg);
    if (!s_es8311) { speaker_init_failed("codec allocation"); return; }
    esp_codec_dev_cfg_t dev_cfg = { .dev_type = ESP_CODEC_DEV_TYPE_OUT, .codec_if = s_es8311, .data_if = s_data_if };
    s_spk = esp_codec_dev_new(&dev_cfg);
    if (!s_spk) { speaker_init_failed("device allocation"); return; }
    if (xTaskCreate(beep_task, "beep", 4096, NULL, 5, &s_beep_task) != pdPASS) {
        s_beep_task = NULL;
        speaker_init_failed("task allocation");
        return;
    }
    ESP_LOGI(TAG, "speaker (ES8311) ready");
}

void audio_beep(void)
{
    // At most one chime a second (the round's rule): two turns ending together ring once.
    static atomic_uint_least32_t last;
    const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    uint32_t was = atomic_load(&last);
    if (!s_beep_task || s_open || (was && now - was < 1000) || !atomic_compare_exchange_strong(&last, &was, now ? now : 1)) return;
    xTaskNotifyGive(s_beep_task);
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
    // esp_codec_dev_open may leave the I2S RX clock disabled.
    esp_err_t en = i2s_channel_enable(s_rx);
    if (en != ESP_OK && en != ESP_ERR_INVALID_STATE) ESP_LOGW(TAG, "i2s enable: %s", esp_err_to_name(en));
    esp_codec_dev_set_in_gain(s_mic, 37.5);   // higher analog mic gain
    atomic_store(&s_rx_overruns, 0);
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
