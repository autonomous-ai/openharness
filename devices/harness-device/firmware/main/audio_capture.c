#include "audio_capture.h"
#include "config_store.h"
#include "audio_probe.h"
#include "board_pins.h"
#include "board/board_i2c.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include <string.h>
#include <stdatomic.h>

static const char *TAG = "audio_cap";

static i2s_chan_handle_t s_rx, s_tx;
static const audio_codec_data_if_t *s_data_if;
static const audio_codec_ctrl_if_t *s_ctrl_if;
static const audio_codec_if_t *s_es7210;
static esp_codec_dev_handle_t s_mic;
static bool s_open;
static SemaphoreHandle_t s_codec_lock;
static atomic_bool s_capture_requested;
static atomic_uint s_rx_overruns;
uint32_t audio_capture_overruns(void){return atomic_load(&s_rx_overruns);}
static bool rx_overrun(i2s_chan_handle_t channel,i2s_event_data_t *event,void *ctx)
{
    (void)channel;(void)event;(void)ctx;
    atomic_fetch_add_explicit(&s_rx_overruns,1,memory_order_relaxed);
    return false;
}

// ES8311 speaker (OUT) path for the notification beep — shares the I2S + I2C with the mic.
static const audio_codec_ctrl_if_t *s_spk_ctrl;
static const audio_codec_gpio_if_t *s_gpio_if;
static const audio_codec_if_t *s_es8311;
static esp_codec_dev_handle_t s_spk;
static TaskHandle_t s_beep_task;
static atomic_bool s_muted = true;

bool audio_notify_is_muted(void)
{
    return atomic_load_explicit(&s_muted, memory_order_relaxed);
}

bool audio_notify_set_muted(bool muted)
{
    atomic_store_explicit(&s_muted, muted, memory_order_relaxed);
    return config_save_muted(muted);
}

// BEEP_COUNT 80ms ~2kHz tones with 60ms gaps. Generate only the next 20ms,
// retaining the identical waveform without reserving 11 KiB for an idle sound.
#define BEEP_SAMPLES (AUDIO_SAMPLE_RATE * 80 / 1000)
#define GAP_SAMPLES  (AUDIO_SAMPLE_RATE * 60 / 1000)
#define BEEP_COUNT   3
#define TONE_SAMPLES (BEEP_SAMPLES * BEEP_COUNT + GAP_SAMPLES * (BEEP_COUNT - 1))
#define TONE_BLOCK_SAMPLES (AUDIO_SAMPLE_RATE / 50)
static int16_t s_tone[TONE_BLOCK_SAMPLES];

static void render_tone(size_t offset, size_t count)
{
    const int half = AUDIO_SAMPLE_RATE / 2000 / 2;   // half-period of a ~2kHz square wave
    const int16_t amp = 6000;
    for (size_t i = 0; i < count; i++) {
        size_t phase = (offset + i) % (BEEP_SAMPLES + GAP_SAMPLES);
        s_tone[i] = phase < BEEP_SAMPLES
            ? (((phase / (half > 0 ? half : 1)) & 1) ? amp : -amp) : 0;
    }
}

static void play_beep(void)
{
    if (!s_spk || audio_notify_is_muted() || atomic_load(&s_capture_requested)) return;
    if (xSemaphoreTake(s_codec_lock, 0) != pdTRUE) return;
    if (audio_notify_is_muted() || atomic_load(&s_capture_requested)) {
        xSemaphoreGive(s_codec_lock);
        return;
    }
    esp_codec_dev_sample_info_t fs = { .sample_rate = AUDIO_SAMPLE_RATE, .channel = 1, .bits_per_sample = 16 };
    if (esp_codec_dev_open(s_spk, &fs) != ESP_OK) { xSemaphoreGive(s_codec_lock); ESP_LOGW(TAG, "spk open failed"); return; }
    if (!audio_notify_is_muted()) {
        esp_codec_dev_set_out_vol(s_spk, 100);
        // Let mute or a microphone start interrupt a tone within one 20ms write.
        for (size_t offset=0; offset<TONE_SAMPLES;) {
            if (audio_notify_is_muted() || atomic_load(&s_capture_requested)) break;
            size_t count=TONE_SAMPLES-offset;
            if (count>TONE_BLOCK_SAMPLES) count=TONE_BLOCK_SAMPLES;
            render_tone(offset,count);
            if (esp_codec_dev_write(s_spk, s_tone, (int)(count*sizeof s_tone[0])) != ESP_CODEC_DEV_OK) break;
            offset+=count;
        }
    }
    esp_codec_dev_close(s_spk);
    xSemaphoreGive(s_codec_lock);
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

static void notify_init_failed(const char *why)
{
    // The microphone owns the shared I2S interface. Release only the speaker
    // objects acquired by this attempt, so a later retry cannot leak them.
    if (s_spk) { esp_codec_dev_delete(s_spk); s_spk = NULL; }
    if (s_es8311) { audio_codec_delete_codec_if(s_es8311); s_es8311 = NULL; }
    if (s_gpio_if) { audio_codec_delete_gpio_if(s_gpio_if); s_gpio_if = NULL; }
    if (s_spk_ctrl) { audio_codec_delete_ctrl_if(s_spk_ctrl); s_spk_ctrl = NULL; }
    ESP_LOGW(TAG, "speaker unavailable: %s", why);
}

void audio_notify_init(void)
{
#ifdef DEVICE_CREATURE_GALLERY
    atomic_store_explicit(&s_muted, true, memory_order_relaxed);
    ESP_LOGI(TAG, "notifications muted (local ASCII gallery)");
    return; // No speaker initialization or beep task in the visual-only study.
#endif
    if (s_beep_task) return;
    atomic_store_explicit(&s_muted, config_load_muted(), memory_order_relaxed);
    if (audio_notify_is_muted()) config_save_muted(true);
    ESP_LOGI(TAG, "notifications %s", audio_notify_is_muted() ? "muted" : "audible");
    if (!s_mic && !audio_capture_init()) { ESP_LOGW(TAG, "notify init: I2S unavailable"); return; }

    audio_codec_i2c_cfg_t i2c_cfg = {
        .port = I2C_NUM_0,
        .addr = ES8311_CODEC_DEFAULT_ADDR,
        .bus_handle = board_i2c_get(),
    };
    s_spk_ctrl = audio_codec_new_i2c_ctrl(&i2c_cfg);
    s_gpio_if = audio_codec_new_gpio();
    if (!s_spk_ctrl || !s_gpio_if) { notify_init_failed("control/GPIO allocation"); return; }

    es8311_codec_cfg_t es_cfg = {
        .ctrl_if = s_spk_ctrl,
        .gpio_if = s_gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = BSP_PA_IO,            // speaker power-amp enable — codec toggles it on open/close
        .use_mclk = true,
    };
    s_es8311 = es8311_codec_new(&es_cfg);
    if (!s_es8311) { notify_init_failed("codec allocation"); return; }

    esp_codec_dev_cfg_t dev_cfg = {
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
        .codec_if = s_es8311,
        .data_if = s_data_if,
    };
    s_spk = esp_codec_dev_new(&dev_cfg);
    if (!s_spk) { notify_init_failed("device allocation"); return; }

    // The full codec-open path retained only 688 B on a 3 KiB stack during
    // event stress. Four KiB restores the 25% and 1 KiB safety margins.
    if (xTaskCreate(beep_task, "beep", 4096, NULL, 5, &s_beep_task) != pdPASS) {
        s_beep_task = NULL;
        notify_init_failed("task allocation");
        return;
    }
    ESP_LOGI(TAG, "speaker (ES8311) ready");
}

void audio_notify_done(void)
{
    static atomic_uint last_ms;
    if (!s_beep_task || audio_notify_is_muted()) return;
    uint32_t previous = atomic_load(&last_ms);
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    if (now - previous < 1000) return;
    // A concurrent completion owns the notification if it won this exchange.
    if (!atomic_compare_exchange_strong(&last_ms, &previous, now)) return;
    xTaskNotifyGive(s_beep_task);
}

static bool capture_init_failed(const char *why)
{
    if (s_mic) { esp_codec_dev_delete(s_mic); s_mic = NULL; }
    if (s_es7210) { audio_codec_delete_codec_if(s_es7210); s_es7210 = NULL; }
    if (s_ctrl_if) { audio_codec_delete_ctrl_if(s_ctrl_if); s_ctrl_if = NULL; }
    if (s_data_if) { audio_codec_delete_data_if(s_data_if); s_data_if = NULL; }
    if (s_rx) { i2s_channel_disable(s_rx); i2s_del_channel(s_rx); s_rx = NULL; }
    if (s_tx) { i2s_channel_disable(s_tx); i2s_del_channel(s_tx); s_tx = NULL; }
    if (s_codec_lock) { vSemaphoreDelete(s_codec_lock); s_codec_lock = NULL; }
    ESP_LOGE(TAG, "microphone unavailable: %s", why);
    return false;
}

bool audio_capture_init(void)
{
    if (s_mic) return true;
    if (!s_codec_lock) s_codec_lock=xSemaphoreCreateMutex();
    if (!s_codec_lock) return false;

    // Full-duplex I2S (BSP-exact): ES7210(ADC)+ES8311(codec) share BCLK/WS, so create both
    // tx+rx and enable them — RX-only setups leave the shared clocks misconfigured → silence.
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.dma_frame_num = 160; // 10ms of mono PCM at 16kHz.
    chan_cfg.dma_desc_num = 12;   // 120ms of DMA headroom, independent of the USB sender.
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
    i2s_event_callbacks_t callbacks={.on_recv_q_ovf=rx_overrun};
    if (i2s_channel_register_event_callback(s_rx,&callbacks,NULL) != ESP_OK)
        return capture_init_failed("I2S callback");
    if (i2s_channel_enable(s_tx) != ESP_OK) return capture_init_failed("I2S TX enable");
    if (i2s_channel_enable(s_rx) != ESP_OK) return capture_init_failed("I2S RX enable");

    // esp_codec_dev: I2S data interface + ES7210 over the shared I2C control bus.
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

    es7210_codec_cfg_t es_cfg = {
        .ctrl_if = s_ctrl_if,
        // Match the vendor BSP: leave mic_selected at the driver default (the board's mics
        // aren't necessarily MIC1/MIC2; an explicit wrong selection captures silence).
    };
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

bool audio_capture_start(void)
{
    if (!s_mic && !audio_capture_init()) return false;
    if (s_open) return true;
    atomic_store(&s_capture_requested,true);
    xSemaphoreTake(s_codec_lock,portMAX_DELAY);
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = AUDIO_SAMPLE_RATE,
        .channel = 1,
        .bits_per_sample = 16,
    };
    if (esp_codec_dev_open(s_mic, &fs) != ESP_OK) { atomic_store(&s_capture_requested,false);xSemaphoreGive(s_codec_lock);ESP_LOGE(TAG, "codec open"); return false; }
    // Make sure the I2S RX clock is running (esp_codec_dev_open may leave it disabled).
    esp_err_t en = i2s_channel_enable(s_rx);
    if (en != ESP_OK && en != ESP_ERR_INVALID_STATE) ESP_LOGW(TAG, "i2s enable: %s", esp_err_to_name(en));
    esp_codec_dev_set_in_gain(s_mic, 37.5);  // higher analog mic gain
    atomic_store(&s_rx_overruns,0);
    s_open = true;
    ESP_LOGI(TAG, "mic stream open (%d Hz mono)", AUDIO_SAMPLE_RATE);
    return true;
}

int audio_capture_read(uint8_t *buf, int len)
{
    if (!s_open) return -1;
    int64_t started = esp_timer_get_time();
    int r = esp_codec_dev_read(s_mic, buf, len);
    audio_probe_read((uint32_t)(esp_timer_get_time()-started),r==ESP_CODEC_DEV_OK?len:0);
    return (r == ESP_CODEC_DEV_OK) ? len : -1;
}

void audio_capture_stop(void)
{
    if (s_open) { esp_codec_dev_close(s_mic); s_open = false;atomic_store(&s_capture_requested,false);xSemaphoreGive(s_codec_lock); }
}
