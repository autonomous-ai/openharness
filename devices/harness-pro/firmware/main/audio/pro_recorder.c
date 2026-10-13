// Continuous 10 ms capture; a separate lower-priority sender absorbs cable backpressure. From the round firmware's
// audio_client_habitat.c (the Pod build), reduced to the one thing the Pro does: a plain voice message to an agent,
// with no draft/form/carry/selection/search/question contexts and no /goal or /loop. It sends over pro_cable.
#include "audio/pro_recorder.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "audio/audio_capture.h"
#include "audio/voice_buffer.h"
#include "cable/cable_types.h"
#include "cable/pro_cable.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sys/config_store.h"
#include "sys/ram_telemetry.h"

#define CAPTURE_SAMPLES 160       // 10 ms at 16 kHz
#define BUFFER_BYTES 32768        // the same ring as the round firmware: a power of two, in PSRAM
#define VOICE_CHUNK 1024          // one cable frame of PCM
#define CAPTURE_STACK 5120        // as the round firmware
#define SENDER_STACK 5120

static const char *TAG = "pro_rec";
static TaskHandle_t s_capture_task, s_sender_task;
static uint8_t *s_storage;
static voice_buffer_t s_buffer;
static atomic_bool s_active, s_recording, s_stop, s_abort, s_quiet, s_capture_done, s_mic_tried, s_heard;
static atomic_uint s_level;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static char s_agent[ID_MAX], s_upload[24], s_lang[CFG_VLANG_MAX];
static uint32_t s_produced, s_high_water, s_read_max_us;

static void capture(void *unused)
{
    (void)unused;
    int16_t pcm[CAPTURE_SAMPLES];
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        voice_gate_t gate = {0};
        voice_level_t meter = {0};
        unsigned failures = 0;
        const bool opened = audio_capture_start();
        atomic_store(&s_mic_tried, true);
        if (!opened) {
            atomic_store(&s_abort, true);
        } else {
            while (!atomic_load(&s_stop)) {
                const int64_t before = esp_timer_get_time();
                const int n = audio_capture_read((uint8_t *)pcm, sizeof pcm);
                const uint32_t elapsed = (uint32_t)(esp_timer_get_time() - before);
                if (elapsed > s_read_max_us) s_read_max_us = elapsed;
                if (n <= 0) {
                    if (++failures >= 3) { atomic_store(&s_abort, true); break; }
                    vTaskDelay(pdMS_TO_TICKS(2));
                    continue;
                }
                failures = 0;
                if (audio_capture_overruns()) {
                    ESP_LOGE(TAG, "DMA dropped samples; discarding this utterance");
                    atomic_store(&s_abort, true);
                    break;
                }
                if (atomic_load(&s_abort)) break;
                voice_gate_feed(&gate, pcm, (size_t)n / 2, AUDIO_SAMPLE_RATE);
                atomic_store_explicit(&s_level, voice_level_feed(&meter, pcm, (size_t)n / 2), memory_order_relaxed);
                atomic_store(&s_heard, gate.heard);
                if (!voice_buffer_write(&s_buffer, (uint8_t *)pcm, (size_t)n)) {
                    ESP_LOGE(TAG, "cable stalled beyond the PCM buffer; discarding utterance");
                    atomic_store(&s_abort, true);
                    break;
                }
                s_produced += (uint32_t)n;
                const uint32_t used = voice_buffer_used(&s_buffer);
                if (used > s_high_water) s_high_water = used;
                xTaskNotifyGive(s_sender_task);
            }
            audio_capture_stop();
        }
        atomic_store_explicit(&s_level, 0, memory_order_relaxed);
        atomic_store(&s_recording, false);
        atomic_store_explicit(&s_capture_done, true, memory_order_release);
        xTaskNotifyGive(s_sender_task);
    }
}

static void sender(void *unused)
{
    (void)unused;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        if (!atomic_load(&s_active)) continue;
        char agent[ID_MAX], upload[24], lang[CFG_VLANG_MAX];
        portENTER_CRITICAL(&s_mux);
        snprintf(agent, sizeof agent, "%s", s_agent);
        snprintf(upload, sizeof upload, "%s", s_upload);
        snprintf(lang, sizeof lang, "%s", s_lang);
        portEXIT_CRITICAL(&s_mux);
        const int64_t began = esp_timer_get_time();
        xTaskNotifyGive(s_capture_task);
        if (!pro_cable_voice_begin(agent, lang, AUDIO_SAMPLE_RATE, upload)) atomic_store(&s_abort, true);
        uint32_t delivered = 0, send_max_us = 0;
        for (;;) {
            if (atomic_load(&s_abort)) break;
            const uint8_t *data;
            const size_t n = voice_buffer_peek(&s_buffer, &data, VOICE_CHUNK);
            if (!n) {
                if (atomic_load_explicit(&s_capture_done, memory_order_acquire)) {
                    // Acquire done before the final head check: do not lose the producer's last chunk.
                    if (!voice_buffer_peek(&s_buffer, &data, VOICE_CHUNK)) break;
                    continue;
                }
                ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
                continue;
            }
            const int64_t before = esp_timer_get_time();
            const bool ok = pro_cable_voice_pcm(data, n);
            const uint32_t elapsed = (uint32_t)(esp_timer_get_time() - before);
            if (elapsed > send_max_us) send_max_us = elapsed;
            if (!ok) { atomic_store(&s_abort, true); break; }
            voice_buffer_consume(&s_buffer, n);
            delivered += (uint32_t)n;
        }
        atomic_store(&s_stop, true);
        while (!atomic_load_explicit(&s_capture_done, memory_order_acquire)) ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
        // A dead cable (pro_rec_abort(quiet)) is sent nothing.
        if (atomic_load(&s_abort)) {
            if (!atomic_load(&s_quiet)) (void)pro_cable_voice_abort(upload, "capture or cable interrupted");
        } else {
            (void)pro_cable_voice_end(upload);
        }
        ESP_LOGI(TAG,
                 "voice_ms=%lu produced=%lu delivered=%lu ring_peak=%lu read_max_us=%lu send_max_us=%lu "
                 "rx_overruns=%lu aborted=%d heard=%d stack_rx=%u stack_tx=%u",
                 (unsigned long)((esp_timer_get_time() - began) / 1000), (unsigned long)s_produced,
                 (unsigned long)delivered, (unsigned long)s_high_water, (unsigned long)s_read_max_us,
                 (unsigned long)send_max_us, (unsigned long)audio_capture_overruns(), atomic_load(&s_abort),
                 atomic_load(&s_heard), (unsigned)uxTaskGetStackHighWaterMark(s_capture_task),
                 (unsigned)uxTaskGetStackHighWaterMark(NULL));
        // The next utterance cannot reuse the metadata or the ring until capture and finalisation finished.
        atomic_store_explicit(&s_active, false, memory_order_release);
    }
}

bool pro_rec_init(void)
{
    if (s_storage) return true;
    s_storage = ram_psram_alloc(BUFFER_BYTES, "voice_stream_ring");
    if (!s_storage) {
        ESP_LOGE(TAG, "PCM buffer allocation failed");
        return false;
    }
    voice_buffer_init(&s_buffer, s_storage, BUFFER_BYTES);
    const BaseType_t a = xTaskCreatePinnedToCore(capture, "voice_capture", CAPTURE_STACK, NULL, 6, &s_capture_task, 0);
    const BaseType_t b = xTaskCreatePinnedToCore(sender, "voice_send", SENDER_STACK, NULL, 4, &s_sender_task, 0);
    if (a != pdPASS || b != pdPASS) {
        if (s_capture_task) vTaskDelete(s_capture_task);
        if (s_sender_task) vTaskDelete(s_sender_task);
        s_capture_task = s_sender_task = NULL;
        heap_caps_free(s_storage);
        s_storage = NULL;
        ESP_LOGE(TAG, "audio task allocation failed");
        return false;
    }
    ESP_LOGI(TAG, "10 ms PCM capture; independent sender; %d-byte ring", BUFFER_BYTES);
    return true;
}

bool pro_rec_start(const char *agent_id, const char *lang, const char *upload_id)
{
    if (!s_capture_task || !s_sender_task) {
        ESP_LOGE(TAG, "audio unavailable");
        return false;
    }
    portENTER_CRITICAL(&s_mux);
    if (atomic_load(&s_active)) {
        portEXIT_CRITICAL(&s_mux);
        return false;
    }
    snprintf(s_agent, sizeof s_agent, "%s", agent_id ? agent_id : "");
    snprintf(s_upload, sizeof s_upload, "%s", upload_id ? upload_id : "");
    snprintf(s_lang, sizeof s_lang, "%s", lang ? lang : "");
    s_produced = s_high_water = s_read_max_us = 0;
    voice_buffer_init(&s_buffer, s_storage, BUFFER_BYTES);
    atomic_store(&s_heard, false);
    atomic_store(&s_level, 0);
    atomic_store(&s_stop, false);
    atomic_store(&s_abort, false);
    atomic_store(&s_quiet, false);
    atomic_store(&s_capture_done, false);
    atomic_store(&s_mic_tried, false);
    atomic_store(&s_recording, true);
    atomic_store(&s_active, true);
    portEXIT_CRITICAL(&s_mux);
    xTaskNotifyGive(s_sender_task);
    return true;
}

void pro_rec_stop(void)
{
    if (atomic_load(&s_active)) atomic_store(&s_stop, true);
}

void pro_rec_abort(bool quiet)
{
    if (!atomic_load(&s_active)) return;
    if (quiet) atomic_store(&s_quiet, true);
    atomic_store(&s_abort, true);
    atomic_store(&s_stop, true);
}

bool pro_rec_active(void) { return atomic_load_explicit(&s_active, memory_order_acquire); }
bool pro_rec_recording(void) { return atomic_load(&s_recording); }
bool pro_rec_mic_tried(void) { return atomic_load(&s_mic_tried); }
bool pro_rec_heard(void) { return atomic_load(&s_heard); }
unsigned pro_rec_level(void) { return atomic_load_explicit(&s_level, memory_order_relaxed); }
