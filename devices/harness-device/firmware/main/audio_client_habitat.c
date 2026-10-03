// Continuous 10ms capture. A separate, lower-priority sender absorbs USB backpressure.
#include "audio_client.h"
#include "audio_capture.h"
#include "audio_probe.h"
#include "voice_buffer.h"
#include "config_store.h"
#include "ram_telemetry.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define CAPTURE_SAMPLES 160
#define BUFFER_BYTES 32768
static const char *TAG = "audio_fast";
static TaskHandle_t capture_task, sender_task;
static uint8_t *storage;
static voice_buffer_t buffer;
static atomic_bool active, recording, stop_requested, abort_requested, capture_done, heard;
static atomic_uint input_level;
static portMUX_TYPE state_lock = portMUX_INITIALIZER_UNLOCKED;
static char agent[ID_MAX], upload[24];
static char selection[48];
static unsigned selection_revision;
static char search_id[48];
static unsigned search_revision;
static char form_id[48];
static char carry_id[48];
static unsigned form_revision;
static char question_token[48];
static unsigned question_index;
static char draft_id[48];
static unsigned draft_revision;
static bool draft_append;
static atomic_bool review_requested;
static voice_cmd_t command;
static uint32_t produced, high_water, read_max_us;

static void capture(void *unused)
{
    (void)unused;
    int16_t pcm[CAPTURE_SAMPLES];
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        voice_gate_t gate = {0};
        voice_level_t meter = {0};
        unsigned failures = 0;
        if (!audio_capture_start()) {
            atomic_store(&abort_requested, true);
            goto complete;
        }
        while (!atomic_load(&stop_requested)) {
            int64_t before = esp_timer_get_time();
            int n = audio_capture_read((uint8_t *)pcm, sizeof(pcm));
            uint32_t elapsed = (uint32_t)(esp_timer_get_time() - before);
            if (elapsed > read_max_us)
                read_max_us = elapsed;
            if (n <= 0) {
                if (++failures >= 3) {
                    atomic_store(&abort_requested, true);
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(2));
                continue;
            }
            failures = 0;
            if (audio_capture_overruns()) {
                ESP_LOGE(TAG, "DMA dropped samples; discarding this utterance");
                atomic_store(&abort_requested, true);
                break;
            }
            if (atomic_load(&abort_requested))
                break;
            voice_gate_feed(&gate, pcm, (size_t)n / 2, AUDIO_SAMPLE_RATE);
            atomic_store_explicit(&input_level, voice_level_feed(&meter, pcm, (size_t)n / 2),
                                  memory_order_relaxed);
            atomic_store(&heard, gate.heard);
            if (!voice_buffer_write(&buffer, (uint8_t *)pcm, (size_t)n)) {
                ESP_LOGE(TAG, "USB stalled beyond the PCM buffer; discarding utterance");
                atomic_store(&abort_requested, true);
                break;
            }
            produced += (uint32_t)n;
            uint32_t used = voice_buffer_used(&buffer);
            if (used > high_water)
                high_water = used;
            xTaskNotifyGive(sender_task);
        }
        audio_capture_stop();
    complete:
        atomic_store_explicit(&input_level, 0, memory_order_relaxed);
        atomic_store(&recording, false);
        atomic_store_explicit(&capture_done, true, memory_order_release);
        xTaskNotifyGive(sender_task);
    }
}

static void send_audio(void *unused)
{
    (void)unused;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        if (!atomic_load(&active))
            continue;
        char lang[CFG_VLANG_MAX];
        config_load_voicelang(lang, sizeof(lang));
        const char *cmd = command == VOICE_CMD_GOAL   ? "goal"
                          : command == VOICE_CMD_LOOP ? "loop"
                                                      : "";
        int64_t began = esp_timer_get_time();
        xTaskNotifyGive(capture_task);
        if (!audio_stream_begin(agent[0] ? agent : NULL, cmd, lang, AUDIO_SAMPLE_RATE))
            atomic_store(&abort_requested, true);
        uint32_t delivered = 0, send_max_us = 0;
        for (;;) {
            if (atomic_load(&abort_requested))
                break;
            const uint8_t *data;
            size_t n = voice_buffer_peek(&buffer, &data, CABLE_VOICE_CHUNK);
            if (!n) {
                if (atomic_load_explicit(&capture_done, memory_order_acquire)) {
                    // Acquire done before the final head check: do not lose the producer's last
                    // chunk.
                    if (!voice_buffer_peek(&buffer, &data, CABLE_VOICE_CHUNK))
                        break;
                    continue;
                }
                ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
                continue;
            }
            int64_t before = esp_timer_get_time();
            bool ok = audio_stream_pcm(data, n);
            uint32_t elapsed = (uint32_t)(esp_timer_get_time() - before);
            if (elapsed > send_max_us)
                send_max_us = elapsed;
            if (!ok) {
                atomic_store(&abort_requested, true);
                break;
            }
            voice_buffer_consume(&buffer, n);
            delivered += (uint32_t)n;
        }
        atomic_store(&stop_requested, true);
        while (!atomic_load_explicit(&capture_done, memory_order_acquire))
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(20));
        if (atomic_load(&abort_requested))
            audio_stream_abort("capture or cable interrupted");
        else
            audio_stream_end();
        ESP_LOGI(TAG,
                 "voice_ms=%lu produced=%lu delivered=%lu ring_peak=%lu read_max_us=%lu "
                 "send_max_us=%lu rx_overruns=%lu aborted=%d energy_gate=%d stack_rx=%u stack_tx=%u",
                 (unsigned long)((esp_timer_get_time() - began) / 1000), (unsigned long)produced,
                 (unsigned long)delivered, (unsigned long)high_water, (unsigned long)read_max_us,
                 (unsigned long)send_max_us, (unsigned long)audio_capture_overruns(),
                 atomic_load(&abort_requested), atomic_load(&heard),
                 (unsigned)uxTaskGetStackHighWaterMark(capture_task),
                 (unsigned)uxTaskGetStackHighWaterMark(NULL));
        // The next gesture cannot reuse metadata or the ring until capture and finalization
        // finished.
        atomic_store_explicit(&active, false, memory_order_release);
    }
}

void audio_client_init(void)
{
    if (storage)
        return;
    storage = ram_psram_alloc(BUFFER_BYTES, "voice_stream_ring");
    if (!storage) {
        ESP_LOGE(TAG, "PCM buffer allocation failed");
        return;
    }
    voice_buffer_init(&buffer, storage, BUFFER_BYTES);
    BaseType_t a =
        xTaskCreatePinnedToCore(capture, "voice_capture", 5120, NULL, 6, &capture_task, 0);
    BaseType_t b =
        xTaskCreatePinnedToCore(send_audio, "voice_send", 5120, NULL, 4, &sender_task, 0);
    if (a != pdPASS || b != pdPASS) {
        if (capture_task)
            vTaskDelete(capture_task);
        if (sender_task)
            vTaskDelete(sender_task);
        capture_task = sender_task = NULL;
        free(storage);
        storage = NULL;
        ESP_LOGE(TAG, "Audio task allocation failed");
        return;
    }
    ESP_LOGI(TAG, "10ms PCM capture; independent sender; %d-byte ring", BUFFER_BYTES);
}
static void start_context(const char *id, voice_cmd_t cmd, const char *selected, unsigned revision, const char *form, unsigned form_rev, const char *carried, const char *question, unsigned index, const char *draft, unsigned draft_rev, bool append, const char *search, unsigned search_rev)
{
    if (!capture_task || !sender_task) {
        ESP_LOGE(TAG, "Audio unavailable");
        return;
    }
    uint32_t u0 = esp_random(), u1 = esp_random();
    portENTER_CRITICAL(&state_lock);
    if (atomic_load(&active)) {
        portEXIT_CRITICAL(&state_lock);
        return;
    }
    snprintf(agent, sizeof(agent), "%s", id ? id : "");
    snprintf(selection, sizeof(selection), "%s", selected ? selected : "");
    selection_revision = revision;
    snprintf(search_id, sizeof search_id, "%s", search ? search : "");
    search_revision = search_rev;
    snprintf(form_id, sizeof(form_id), "%s", form ? form : "");
    form_revision = form_rev;
    snprintf(carry_id, sizeof(carry_id), "%s", carried ? carried : "");
    snprintf(upload, sizeof(upload), "%08lx%08lx", (unsigned long)u0, (unsigned long)u1);
    snprintf(question_token, sizeof(question_token), "%s", question ? question : "");
    question_index = index;
    snprintf(draft_id, sizeof(draft_id), "%s", draft ? draft : "");
    draft_revision = draft_rev; draft_append = append;
    atomic_store(&review_requested, false);
    command = cmd;
    produced = high_water = read_max_us = 0;
    voice_buffer_init(&buffer, storage, BUFFER_BYTES);
    atomic_store(&heard, false);
    atomic_store(&input_level, 0);
    atomic_store(&stop_requested, false);
    atomic_store(&abort_requested, false);
    atomic_store(&capture_done, false);
    atomic_store(&recording, true);
    atomic_store(&active, true);
    portEXIT_CRITICAL(&state_lock);
    xTaskNotifyGive(sender_task);
}
void audio_client_start_cable(const char *id, voice_cmd_t cmd) { start_context(id, cmd, NULL, 0, NULL, 0, NULL, NULL, 0, NULL, 0, false, NULL, 0); }
void audio_client_start_selection(const char *id, const char *selected, unsigned revision)
{
    if (id && *id && selected && *selected && revision) start_context(id, VOICE_CMD_NONE, selected, revision, NULL, 0, NULL, NULL, 0, NULL, 0, false, NULL, 0);
}
void audio_client_start_form(const char *id, unsigned revision)
{
    if (id && *id) start_context(NULL, VOICE_CMD_NONE, NULL, 0, id, revision, NULL, NULL, 0, NULL, 0, false, NULL, 0);
}
void audio_client_start_carry(const char *id, const char *carried)
{
    if (id && *id && carried && *carried) start_context(id, VOICE_CMD_NONE, NULL, 0, NULL, 0, carried, NULL, 0, NULL, 0, false, NULL, 0);
}
void audio_client_request_review(void) { atomic_store(&review_requested,true); }
bool audio_client_review_requested(void) { return atomic_load(&review_requested); }
void audio_client_start_draft(const char *id,unsigned revision,bool append)
{
    if (id && *id) start_context(NULL,VOICE_CMD_NONE,NULL,0,NULL,0,NULL,NULL,0,id,revision,append,NULL,0);
}
void audio_client_copy_draft(char *out,size_t capacity,unsigned *revision,bool *append)
{
    portENTER_CRITICAL(&state_lock);
    if (capacity) snprintf(out,capacity,"%s",draft_id);
    if (revision) *revision=draft_revision;
    if (append) *append=draft_append;
    portEXIT_CRITICAL(&state_lock);
}
void audio_client_start_question(const char *id, const char *token, unsigned index)
{
    if (id && *id && token && *token && index < 4)
        start_context(id, VOICE_CMD_NONE, NULL, 0, NULL, 0, NULL, token, index, NULL, 0, false, NULL, 0);
}
void audio_client_copy_question(char *out, size_t capacity, unsigned *index)
{
    portENTER_CRITICAL(&state_lock);
    if (capacity) snprintf(out, capacity, "%s", question_token);
    if (index) *index = question_index;
    portEXIT_CRITICAL(&state_lock);
}
void audio_client_copy_carry(char *out, size_t capacity)
{
    portENTER_CRITICAL(&state_lock);
    if (capacity) snprintf(out, capacity, "%s", carry_id);
    portEXIT_CRITICAL(&state_lock);
}
void audio_client_copy_form(char *out, size_t capacity, unsigned *revision)
{
    portENTER_CRITICAL(&state_lock);
    if (capacity) snprintf(out, capacity, "%s", form_id);
    if (revision) *revision = form_revision;
    portEXIT_CRITICAL(&state_lock);
}
void audio_client_copy_selection(char *out, size_t capacity, unsigned *revision)
{
    portENTER_CRITICAL(&state_lock);
    if (capacity) snprintf(out, capacity, "%s", selection);
    if (revision) *revision = selection_revision;
    portEXIT_CRITICAL(&state_lock);
}
void audio_client_stop(void)
{
    portENTER_CRITICAL(&state_lock);
    if (atomic_load(&active))
        atomic_store(&stop_requested, true);
    portEXIT_CRITICAL(&state_lock);
}
void audio_client_abort(void)
{
    portENTER_CRITICAL(&state_lock);
    if (atomic_load(&active)) {
        atomic_store(&abort_requested, true);
        atomic_store(&stop_requested, true);
    }
    portEXIT_CRITICAL(&state_lock);
}
bool audio_client_active(void) { return atomic_load_explicit(&active, memory_order_acquire); }
bool audio_client_recording(void) { return atomic_load(&recording); }
bool audio_client_heard_voice(void) { return atomic_load(&heard); }
unsigned audio_client_input_level(void) { return atomic_load_explicit(&input_level, memory_order_relaxed); }
void audio_client_copy_upload_id(char *out, size_t capacity)
{
    portENTER_CRITICAL(&state_lock);
    snprintf(out, capacity, "%s", upload);
    portEXIT_CRITICAL(&state_lock);
}
bool audio_client_upload_matches(const char *id)
{
    bool match;
    portENTER_CRITICAL(&state_lock);
    match = id && *id && !strcmp(id, upload);
    portEXIT_CRITICAL(&state_lock);
    return match;
}

void audio_client_start_search(const char *id, const char *selected, unsigned revision)
{
    if (id && *id && selected && *selected && revision)
        start_context(id,VOICE_CMD_NONE,NULL,0,NULL,0,NULL,NULL,0,NULL,0,false,selected,revision);
}
void audio_client_copy_search(char *out,size_t capacity,unsigned *revision)
{
    portENTER_CRITICAL(&state_lock);
    if (capacity) snprintf(out,capacity,"%s",search_id);
    if (revision) *revision=search_revision;
    portEXIT_CRITICAL(&state_lock);
}
