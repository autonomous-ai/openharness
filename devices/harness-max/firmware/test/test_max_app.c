// Harness Max's app layer (main/app/max_app.c) over the real lanes model. Below it the host plays the device: a fake
// clock, the renderer as a notification counter, and the cable, the recorder and the speaker as recorders. Every one of
// them checks that the app's lock is NOT held: nothing leaves the device under it.
#include "max_test.h"

#include "app/max_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "cable/cable_link.h"
#include "cable/pro_cable.h"
#include "pro_app_api.h"
#include "pro_display.h"
#include "pro_frame.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"
#include "sys/last_words.h"
#include "sys/ram_telemetry.h"

#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static uint32_t now = 1000;
static int LOCK_DEPTH;
static int NOTIFIES;   // the render task's wake-ups

// ---- FreeRTOS and the clock ----
struct host_mutex { int unused; };
struct host_task { int unused; };
static struct host_task RENDERER;
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) { return calloc(1, sizeof(struct host_mutex)); }
BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t m, TickType_t w) { (void)m; (void)w; LOCK_DEPTH++; return pdTRUE; }
BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t m) { (void)m; CHECK(LOCK_DEPTH > 0); LOCK_DEPTH--; return pdTRUE; }
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack, void *arg, unsigned prio,
                                   TaskHandle_t *out, int core)
{
    (void)fn; (void)stack; (void)arg; (void)prio; (void)core;
    CHECK(!strcmp(name, "pro_render"));   // ram_telemetry and the heartbeat know it by this name
    *out = &RENDERER;                     // never run: the test is the render task's only observer
    return pdPASS;
}
BaseType_t xTaskNotifyGive(TaskHandle_t t) { CHECK(t == &RENDERER); NOTIFIES++; return pdPASS; }
uint32_t ulTaskNotifyTake(BaseType_t clear, TickType_t wait) { (void)clear; (void)wait; return 0; }
void vTaskDelay(TickType_t ticks) { now += ticks; }
uint32_t uxTaskGetStackHighWaterMark(TaskHandle_t t) { (void)t; return 0; }
int64_t esp_timer_get_time(void) { return (int64_t)now * 1000; }
esp_err_t esp_task_wdt_add(void *task) { (void)task; return ESP_OK; }
esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }
size_t heap_caps_get_free_size(unsigned caps) { (void)caps; return 0; }
size_t heap_caps_get_largest_free_block(unsigned caps) { (void)caps; return 0; }

// ---- the recorder: one recording at a time; a stop with send waits for the daemon's reply ----
static bool V_OPEN, V_PENDING, V_WAITING;
static int V_BEGINS;
static char V_AGENT[ID_MAX];
bool pro_voice_open(void) { return V_OPEN; }
bool pro_voice_start_pending(void) { return V_PENDING; }
bool pro_voice_waiting(void) { return V_WAITING; }
void pro_voice_begin(const char *agent_id)
{
    CHECK(LOCK_DEPTH == 0);
    V_BEGINS++;
    if (V_OPEN) return;   // refused: the last send still waits for its reply
    snprintf(V_AGENT, sizeof V_AGENT, "%s", agent_id);
    V_OPEN = true;        // and the recorder runs at once
}
void pro_voice_end(bool send)
{
    CHECK(LOCK_DEPTH == 0);
    if (!V_OPEN) return;
    if (send) V_WAITING = true;
    else V_OPEN = V_PENDING = V_WAITING = false;
}
void pro_voice_close(void) { V_OPEN = V_PENDING = V_WAITING = false; }
void pro_voice_link_lost(void) { CHECK(LOCK_DEPTH == 0); V_OPEN = V_PENDING = V_WAITING = false; }
void pro_voice_tick(uint32_t now_ms) { (void)now_ms; CHECK(LOCK_DEPTH == 0); }

// ---- the cable, the speaker and the rest below the app ----
static char OPENED[ID_MAX];
static int OPENS, BEEPS;
bool pro_cable_send_open(const char *agent_id)
{
    CHECK(LOCK_DEPTH == 0);
    OPENS++;
    snprintf(OPENED, sizeof OPENED, "%s", agent_id);
    return true;
}
void audio_beep(void) { CHECK(LOCK_DEPTH == 0); BEEPS++; }
bool pro_settings_muted(void) { return false; }
void pro_cable_counters(uint32_t *bad, uint32_t *unknown) { *bad = *unknown = 0; }
uint32_t pro_cable_seq_gaps(void) { return 0; }
cable_link_stats_t cable_link_stats(void) { return (cable_link_stats_t){0}; }
void pro_touch_stats(pro_touch_stats_t *out) { memset(out, 0, sizeof *out); }
void pro_display_power(bool on) { (void)on; }
void pro_display_set_brightness(uint8_t level) { (void)level; }
void pro_frame_init(void) {}
uint32_t pro_frame_present(const ht_scene_t *prev, const ht_scene_t *next, uint32_t *pushed_px)
{
    (void)prev; (void)next;
    *pushed_px = 0;
    return 0;
}
uint8_t config_load_brightness(void) { return 255; }
bool fw_was_updated(char *version, size_t cap) { (void)version; (void)cap; return false; }
void last_words_phase(lw_task_t task, const char *phase) { (void)task; (void)phase; }
void ram_telemetry_periodic(const char *tag) { (void)tag; }

// ---- helpers ----
static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
enum { CARD_CY = MAX_CARD_Y + MAX_CARD_H / 2 };
static int lane_cx(int i) { return MAX_LANE_X + i * MAX_LANE_W + MAX_LANE_W / 2; }
static const int TALK_CX = MAX_TALK_X + MAX_TALK_W / 2;

// The cable says hello and lists five agents; the glass shows what the model holds (the render task's draw).
static void fresh(void)
{
    pro_app_link(false, NULL);
    pro_app_link(true, "MacBook Pro");
    pro_agent_row_t rows[5];
    for (int i = 0; i < 5; i++) rows[i] = (pro_agent_row_t){ABCDE[i], ABCDE[i], "claude", "m1", "MacBook Pro"};
    pro_app_agents(rows, 5);
    render(now);
    NOTIFIES = 0;
}

static void contact(int x, int y, int dx, int dy)
{
    CHECK(pro_app_touch(true, x, y));
    for (int k = 1; k <= 4; k++) {
        now += 30;
        CHECK(pro_app_touch(true, x + dx * k / 4, y + dy * k / 4));
    }
    now += 30;
    CHECK(pro_app_touch(false, x + dx, y + dy));
    CHECK(LOCK_DEPTH == 0);
}

// ---- tests ----

// A swipe turns the page and a tap moves the selection: the model only marks itself for redraw (max_ui_touch returns
// MAX_ACT_NONE), so the touch path must wake the render task, or the new page shows at its next wake, up to 60 s later.
static void test_touch_wakes_the_renderer(void)
{
    fresh();
    contact(lane_cx(1), CARD_CY, -(MAX_SWIPE_PX + 40), 0);
    CHECK(max_m.page == 1);
    CHECK(NOTIFIES > 0);

    fresh();
    contact(lane_cx(2), CARD_CY, 3, -2);
    CHECK(!strcmp(max_ui_selected(), "c"));
    CHECK(NOTIFIES > 0);
}

// A lane tap sends agent.open for that agent, once, after the lock is released (the recorders check the lock).
static void test_tap_opens_the_lane(void)
{
    fresh();
    OPENS = 0;
    contact(lane_cx(1), CARD_CY, 2, 1);
    CHECK(OPENS == 1 && !strcmp(OPENED, "b"));
    // A swipe opens nothing.
    contact(lane_cx(0), CARD_CY, -(MAX_SWIPE_PX + 40), 0);
    CHECK(OPENS == 1);
}

// Talk records for the selected agent, a second tap sends, and the reply ends it; the slot follows the recorder.
static void test_talk_records_and_sends(void)
{
    fresh();
    V_BEGINS = 0;
    contact(TALK_CX, CARD_CY, 0, 0);   // no lane selected: "Tap a lane", nothing starts
    CHECK(V_BEGINS == 0 && max_m.talk == MAX_TALK_IDLE);

    contact(lane_cx(1), CARD_CY, 0, 0);
    render(now);
    NOTIFIES = 0;
    contact(TALK_CX, CARD_CY, 0, 0);
    CHECK(V_BEGINS == 1 && !strcmp(V_AGENT, "b") && V_OPEN);
    CHECK(max_m.talk == MAX_TALK_RECORDING && NOTIFIES > 0);

    render(now);
    contact(TALK_CX, CARD_CY, 0, 0);
    CHECK(V_WAITING && max_m.talk == MAX_TALK_SENDING);

    pro_app_voice_result(PRO_VOICE_ERROR, "Nobody heard that");
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE);
    CHECK(!strcmp(max_m.notice, "Nobody heard that"));
}

// An accepted update offer holds voice off: a Talk tap says so and starts nothing.
static void test_update_gate_holds_talk(void)
{
    fresh();
    contact(lane_cx(0), CARD_CY, 0, 0);
    render(now);
    CHECK(pro_app_begin_update_gate());
    V_BEGINS = 0;
    contact(TALK_CX, CARD_CY, 0, 0);
    CHECK(V_BEGINS == 0 && !V_OPEN && max_m.talk == MAX_TALK_IDLE);
    CHECK(!strcmp(max_m.notice, "Updating"));
    pro_app_end_update_gate();
    contact(TALK_CX, CARD_CY, 0, 0);
    CHECK(V_BEGINS == 1 && V_OPEN);
    contact(TALK_CX, CARD_CY, 0, 0);
    pro_app_voice_result(PRO_VOICE_OK, "a");
    CHECK(!V_OPEN);
}

// A sleeping screen takes no contact: the caller swallows it.
static void test_asleep_refuses_the_finger(void)
{
    fresh();
    pro_app_sleep();
    CHECK(!pro_app_touch(true, lane_cx(0), CARD_CY));
    CHECK(LOCK_DEPTH == 0);
    pro_app_wake();
    CHECK(pro_app_touch(true, lane_cx(0), CARD_CY));
    pro_app_touch_cancel();
}

// A question chimes once: sent again after the cable came back it is the same one; a new one chimes again.
static void test_question_chimes_once(void)
{
    fresh();
    now += 60000;   // past the last chime's coalescing window
    BEEPS = 0;
    pro_app_question("a", "r1", "Proceed?");
    CHECK(BEEPS == 1);
    now += 60000;
    fresh();
    pro_app_question("a", "r1", "Proceed?");
    CHECK(BEEPS == 1);
    pro_app_question_close("a");
    now += 60000;
    pro_app_question("a", "r2", "And this?");
    CHECK(BEEPS == 2);
    // A failed turn is an alert too, but a second alert within 30 s does not chime again.
    pro_app_turn("b", "started", "", 0);
    pro_app_turn("b", "error", "boom", 0);
    CHECK(BEEPS == 2);
}

int main(void)
{
    pro_app_start();
    test_touch_wakes_the_renderer();
    test_tap_opens_the_lane();
    test_talk_records_and_sends();
    test_update_gate_holds_talk();
    test_asleep_refuses_the_finger();
    test_question_chimes_once();
    printf("test_max_app: %d checks passed\n", checks);
    return 0;
}
