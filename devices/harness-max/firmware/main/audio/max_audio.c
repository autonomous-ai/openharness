// Harness Max's audio behind the Pro's audio/audio_capture.h, and its chimes (app/max_chime.h). ONE ES8311 is both the
// microphone (its ADC) and the speaker (its DAC), on one full-duplex I2S bus. esp_codec_dev pairs two codec instances on
// the same chip (one ADC, one DAC) and counts their opens; this file makes them take turns, so the chip is never set up
// for one while the other runs.
#include "audio/audio_capture.h"

#include <stdatomic.h>

#include "app/max_chime.h"
#include "audio/max_chime_pcm.h"

#include "max_i2c.h"
#include "pins_max.h"
#include "task_stacks.h"

#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "max_audio";

// The ES8311's analog PGA goes in 6 dB steps (0..42). The Pro's ES7210 records at 37.5; 36 is the nearest step below.
#define MIC_GAIN_DB 36.0f

static i2s_chan_handle_t s_rx, s_tx;
static const audio_codec_data_if_t *s_data_if;
static const audio_codec_ctrl_if_t *s_ctrl_if;   // the ES8311 on I2C, shared by both codec instances
static const audio_codec_gpio_if_t *s_gpio_if;
static const audio_codec_if_t *s_adc, *s_dac;
static esp_codec_dev_handle_t s_mic, s_spk;
static SemaphoreHandle_t s_chip;   // held while the mic or the speaker is being opened, closed or played
static atomic_bool s_open;         // the mic is open or opening: the chime task reads it and steps aside
static TaskHandle_t s_chime_task;
static atomic_bool s_chime_busy;   // a chime is waiting for the task or playing: another one is dropped
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
    if (s_adc) { audio_codec_delete_codec_if(s_adc); s_adc = NULL; }
    if (s_gpio_if) { audio_codec_delete_gpio_if(s_gpio_if); s_gpio_if = NULL; }
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
    if (!s_chip && !(s_chip = xSemaphoreCreateMutex())) return capture_init_failed("lock");

    // Full duplex, as the Pro: the ES8311's ADC and DAC share BCLK and WS, and the speaker's TX needs the same clocks.
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;   // an idle TX channel plays silence, not stale DMA contents
    chan_cfg.dma_frame_num = 160; // 10 ms of mono PCM at 16 kHz
    chan_cfg.dma_desc_num = 12;   // 120 ms of DMA headroom, independent of the USB sender
    if (i2s_new_channel(&chan_cfg, &s_tx, &s_rx) != ESP_OK) return capture_init_failed("I2S allocation");

    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = MAX_I2S_MCLK,
            .bclk = MAX_I2S_BCLK,
            .ws = MAX_I2S_WS,
            .dout = MAX_I2S_DOUT,
            .din = MAX_I2S_DIN,
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

    audio_codec_i2s_cfg_t i2s_cfg = { .port = I2S_NUM_0, .rx_handle = s_rx, .tx_handle = s_tx };
    s_data_if = audio_codec_new_i2s_data(&i2s_cfg);
    if (!s_data_if) return capture_init_failed("I2S interface allocation");

    i2c_master_bus_handle_t bus = max_i2c_bus();
    if (!bus) return capture_init_failed("no I2C bus");
    audio_codec_i2c_cfg_t i2c_cfg = { .port = MAX_I2C_PORT, .addr = ES8311_CODEC_DEFAULT_ADDR, .bus_handle = bus };
    s_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    s_gpio_if = audio_codec_new_gpio();
    if (!s_ctrl_if || !s_gpio_if) return capture_init_failed("control/GPIO allocation");

    // The ADC half. It is created first, so the chip is first set up with its settings: a mono capture, nothing of the
    // DAC mixed into the second slot. It has no amplifier: recording never powers the speaker.
    es8311_codec_cfg_t adc_cfg = {
        .ctrl_if = s_ctrl_if,
        .gpio_if = s_gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_ADC,
        .pa_pin = -1,
        .use_mclk = true,
        .no_dac_ref = true,
    };
    s_adc = es8311_codec_new(&adc_cfg);
    if (!s_adc) return capture_init_failed("codec allocation");

    esp_codec_dev_cfg_t dev_cfg = { .dev_type = ESP_CODEC_DEV_TYPE_IN, .codec_if = s_adc, .data_if = s_data_if };
    s_mic = esp_codec_dev_new(&dev_cfg);
    if (!s_mic) return capture_init_failed("device allocation");
    ESP_LOGI(TAG, "mic (ES8311 ADC) ready");
    return true;
}

// The chimes at the Pro beep's loudness: a question's square tones peak at 6000, a finished turn's notes at 2200/2700
// of it, as V3 set them against each other on the bar. Rendered 20 ms at a time.
#define CHIME_LOUDNESS 6000
#define CHIME_BLOCK_SAMPLES (AUDIO_SAMPLE_RATE / 50)
static int16_t s_block[CHIME_BLOCK_SAMPLES];

static void play_chime(max_chime_t sound)
{
    xSemaphoreTake(s_chip, portMAX_DELAY);
    if (atomic_load(&s_open)) {   // a recording is open or opening
        xSemaphoreGive(s_chip);
        return;
    }
    esp_codec_dev_sample_info_t fs = { .sample_rate = AUDIO_SAMPLE_RATE, .channel = 1, .bits_per_sample = 16 };
    if (esp_codec_dev_open(s_spk, &fs) != ESP_CODEC_DEV_OK) {
        xSemaphoreGive(s_chip);
        ESP_LOGW(TAG, "spk open failed");
        return;
    }
    esp_codec_dev_set_out_vol(s_spk, 100);
    const size_t total = max_chime_samples(sound);
    for (size_t offset = 0; offset < total;) {
        if (atomic_load(&s_open)) break;   // a recording wants the chip: let go within one 20 ms write
        size_t count = total - offset;
        if (count > CHIME_BLOCK_SAMPLES) count = CHIME_BLOCK_SAMPLES;
        max_chime_render(sound, CHIME_LOUDNESS, offset, s_block, count);
        if (esp_codec_dev_write(s_spk, s_block, (int)(count * sizeof s_block[0])) != ESP_CODEC_DEV_OK) { ESP_LOGW(TAG, "spk write failed"); break; }
        offset += count;
    }
    esp_codec_dev_close(s_spk);
    xSemaphoreGive(s_chip);
    ESP_LOGI(TAG, "chime %d", (int)sound);
}

static void chime_task(void *arg)
{
    (void)arg;
    for (;;) {
        uint32_t sound = 0;
        xTaskNotifyWait(0, 0, &sound, portMAX_DELAY);
        play_chime((max_chime_t)sound);
        atomic_store(&s_chime_busy, false);
    }
}

static void speaker_init_failed(const char *why)
{
    // The control and GPIO interfaces are the microphone's too: they stay.
    if (s_spk) { esp_codec_dev_delete(s_spk); s_spk = NULL; }
    if (s_dac) { audio_codec_delete_codec_if(s_dac); s_dac = NULL; }
    ESP_LOGW(TAG, "speaker unavailable: %s", why);
}

void audio_beep_init(void)
{
    if (s_chime_task) return;
    if (!s_mic && !audio_capture_init()) { ESP_LOGW(TAG, "speaker: the ES8311 is unavailable"); return; }
    es8311_codec_cfg_t dac_cfg = {
        .ctrl_if = s_ctrl_if,
        .gpio_if = s_gpio_if,
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = MAX_PA_IO,   // the amplifier's enable; the codec raises it on open and drops it on close
        .use_mclk = true,
        // The vendor's numbers for this board (5 V amplifier, 3.3 V DAC), so a volume means the same loudness.
        .hw_gain = { .pa_voltage = 5.0, .codec_dac_voltage = 3.3 },
    };
    s_dac = es8311_codec_new(&dac_cfg);
    if (!s_dac) { speaker_init_failed("codec allocation"); return; }
    esp_codec_dev_cfg_t dev_cfg = { .dev_type = ESP_CODEC_DEV_TYPE_OUT, .codec_if = s_dac, .data_if = s_data_if };
    s_spk = esp_codec_dev_new(&dev_cfg);
    if (!s_spk) { speaker_init_failed("device allocation"); return; }
    if (xTaskCreate(chime_task, "chime", STACK_BEEP, NULL, 5, &s_chime_task) != pdPASS) {
        s_chime_task = NULL;
        speaker_init_failed("task allocation");
        return;
    }
    ESP_LOGI(TAG, "speaker (ES8311 DAC) ready");
}

void max_chime(max_chime_t sound)
{
    bool idle = false;
    if (!s_chime_task || atomic_load(&s_open) || !atomic_compare_exchange_strong(&s_chime_busy, &idle, true)) return;
    xTaskNotify(s_chime_task, (uint32_t)sound, eSetValueWithOverwrite);
}

// The Pro's alert sound, for a caller of its audio_capture.h: a question's chime.
void audio_beep(void) { max_chime(MAX_CHIME_ASK); }

bool audio_capture_start(void)
{
    if (!s_mic && !audio_capture_init()) return false;
    if (atomic_load(&s_open)) return true;
    // Claim the chip before waiting for it: a chime that is playing sees the claim and stops within one block.
    atomic_store(&s_open, true);
    xSemaphoreTake(s_chip, portMAX_DELAY);
    esp_codec_dev_sample_info_t fs = {
        .sample_rate = AUDIO_SAMPLE_RATE,
        .channel = 1,
        .bits_per_sample = 16,
    };
    const bool opened = esp_codec_dev_open(s_mic, &fs) == ESP_CODEC_DEV_OK;
    if (opened) {
        // esp_codec_dev_open may leave the I2S RX clock disabled.
        esp_err_t en = i2s_channel_enable(s_rx);
        if (en != ESP_OK && en != ESP_ERR_INVALID_STATE) ESP_LOGW(TAG, "i2s enable: %s", esp_err_to_name(en));
        esp_codec_dev_set_in_gain(s_mic, MIC_GAIN_DB);
        atomic_store(&s_rx_overruns, 0);
    } else {
        atomic_store(&s_open, false);
    }
    xSemaphoreGive(s_chip);
    if (!opened) {
        ESP_LOGE(TAG, "codec open");
        return false;
    }
    ESP_LOGI(TAG, "mic stream open (%d Hz mono)", AUDIO_SAMPLE_RATE);
    return true;
}

int audio_capture_read(uint8_t *buf, int len)
{
    if (!atomic_load(&s_open)) return -1;
    int r = esp_codec_dev_read(s_mic, buf, len);
    return (r == ESP_CODEC_DEV_OK) ? len : -1;
}

void audio_capture_stop(void)
{
    if (!atomic_load(&s_open)) return;
    xSemaphoreTake(s_chip, portMAX_DELAY);
    esp_codec_dev_close(s_mic);
    atomic_store(&s_open, false);
    xSemaphoreGive(s_chip);
}
