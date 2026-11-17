// Harness Max's app layer (main/app/max_app.c) over the real lanes model. Below it the host plays the device: a fake
// clock, the renderer as a notification counter, and the cable, the recorder and the speaker as recorders. Every one of
// them checks that the app's lock is NOT held: nothing leaves the device under it.
#include <stdarg.h>

#include "max_test.h"

#include "app/max_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "cable/cable_features.h"
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
#include "esp_random.h"
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

// What the bar sends besides agent.open: each recorded as one line ("form form-1 open 0 0"), the port refusing while
// PORT_FULL. The welcome's features are FEATURES.
static char SENT[16][160];
static int SENDS;
static bool PORT_FULL, WAITED;
static uint32_t FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW;
static char VOICE_FORM[64];
static int VOICE_REVISION;
static bool sent(bool wait, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static bool sent(bool wait, const char *fmt, ...)
{
    CHECK(LOCK_DEPTH == 0);
    WAITED = wait;
    if (PORT_FULL) return false;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(SENT[SENDS % 16], sizeof SENT[0], fmt, ap);
    va_end(ap);
    SENDS++;
    return true;
}
static const char *last_sent(void) { return SENDS ? SENT[(SENDS - 1) % 16] : ""; }
bool pro_cable_supports(uint32_t feature) { return (FEATURES & feature) == feature; }
bool pro_cable_question_read(const char *agent_id, const char *request_id, bool wait)
{
    return sent(wait, "question.read %s %s", agent_id, request_id);
}
bool pro_cable_answer_reviewed(const char *agent_id, const char *token, const char *request_id, const uint8_t *choices,
                               int count, bool wait)
{
    return sent(wait, "answer.reviewed %s %s %s %d:%d", agent_id, token, request_id, count, count ? choices[0] : -1);
}
bool pro_cable_answer(const char *agent_id, const char *request_id, const char *const keys[], const char *const values[],
                      int count, bool wait)
{
    return sent(wait, "answer %s %s %d %s=%s", agent_id, request_id, count, count ? keys[0] : "", count ? values[0] : "");
}
bool pro_cable_form(const char *form_id, const char *request_id, const char *op, int revision, int delta, bool wait)
{
    return sent(wait, "form %s %s %s %d %d", form_id, request_id, op, revision, delta);
}
void pro_cable_voice_form(const char *form_id, int revision)
{
    CHECK(LOCK_DEPTH == 0);
    snprintf(VOICE_FORM, sizeof VOICE_FORM, "%s", form_id ? form_id : "");
    VOICE_REVISION = revision;
}
uint32_t esp_random(void) { return 0xc0ffee; }
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
// a, b, c...: the room's agent and two pages of lanes, whatever MAX_LANES is.
static const char *const IDS[] = {"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"};
enum { AGENTS = MAX_LANES + 2 };
_Static_assert(AGENTS <= sizeof IDS / sizeof IDS[0], "IDS holds the room and two pages of lanes");

// The cable says hello and lists the agents; the glass shows what the model holds (the render task's draw). The room
// shows a.
static void fresh(void)
{
    pro_app_link(false, NULL);
    pro_app_link(true, "MacBook Pro");
    pro_agent_row_t rows[AGENTS];
    for (int i = 0; i < AGENTS; i++) rows[i] = (pro_agent_row_t){IDS[i], IDS[i], "claude", "m1", "MacBook Pro"};
    pro_app_agents(rows, AGENTS);
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

// A button the view drew.
static const max_hit_t *find_hit(max_hit_kind_t kind, int arg)
{
    for (int i = 0; i < max_m.hit_count; i++)
        if (max_m.hits[i].kind == kind && max_m.hits[i].arg == arg) return &max_m.hits[i];
    return NULL;
}
static void press(max_hit_kind_t kind, int arg)
{
    render(now);
    const max_hit_t *h = find_hit(kind, arg);
    CHECK(h != NULL);
    contact(h->x + h->w / 2, h->y + h->h / 2, 0, 0);
}
// A button of the room: its card's, its pet, Send and Cancel while it records, the form's Say.
static void press_room(max_hit_kind_t kind, int arg)
{
    render(now);
    room_card();
    const max_hit_t *h = room_hit(kind, arg);
    contact(h->x + h->w / 2, h->y + h->h / 2, 0, 0);
}

// ---- tests ----

// A swipe turns the page and a tap moves the selection: the model only marks itself for redraw (max_ui_touch returns
// MAX_ACT_NONE), so the touch path must wake the render task, or the new page shows at its next wake, up to 60 s later.
static void test_touch_wakes_the_renderer(void)
{
    fresh();
    contact(lane_x(1), lane_y(1), -(MAX_SWIPE_PX + 40), 0);
    CHECK(max_m.page == 1);
    CHECK(NOTIFIES > 0);

    fresh();
    contact(lane_x(1), lane_y(1), 3, -2);
    CHECK(!strcmp(max_ui_selected(), "c"));
    CHECK(NOTIFIES > 0);
}

// A lane tap sends agent.open for that agent, once, after the lock is released (the recorders check the lock).
static void test_tap_opens_the_lane(void)
{
    fresh();
    OPENS = 0;
    contact(lane_x(0), lane_y(0), 2, 1);
    CHECK(OPENS == 1 && !strcmp(OPENED, "b"));
    // A swipe opens nothing.
    contact(lane_x(0), lane_y(0), -(MAX_SWIPE_PX + 40), 0);
    CHECK(OPENS == 1);
}

// The room's pet records for its agent, Send sends, and the reply ends it; the room follows the recorder.
static void test_talk_records_and_sends(void)
{
    fresh();
    V_BEGINS = 0;
    contact(lane_x(0), lane_y(0), 0, 0);   // the room shows b
    NOTIFIES = 0;
    press_room(MAX_HIT_TALK, 0);
    CHECK(V_BEGINS == 1 && !strcmp(V_AGENT, "b") && V_OPEN);
    CHECK(max_m.talk == MAX_TALK_RECORDING && NOTIFIES > 0);

    press_room(MAX_HIT_TALK_SEND, 0);
    CHECK(V_WAITING && max_m.talk == MAX_TALK_SENDING);

    pro_app_voice_result(PRO_VOICE_ERROR, "Nobody heard that");
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE);
    CHECK(!strcmp(max_m.notice, "Nobody heard that"));
}

// Cancel stops the recording and sends nothing; the room's agent takes voice again.
static void test_cancel_sends_nothing(void)
{
    fresh();
    press_room(MAX_HIT_TALK, 0);
    CHECK(V_OPEN && max_m.talk == MAX_TALK_RECORDING);
    press_room(MAX_HIT_TALK_CANCEL, 0);
    CHECK(!V_OPEN && !V_WAITING && max_m.talk == MAX_TALK_IDLE && LOCK_DEPTH == 0);
    V_BEGINS = 0;
    press_room(MAX_HIT_TALK, 0);
    CHECK(V_BEGINS == 1 && V_OPEN && !strcmp(V_AGENT, "a"));
    press_room(MAX_HIT_TALK_CANCEL, 0);
}

// An accepted update offer holds voice off: a tap on the pet says so and starts nothing.
static void test_update_gate_holds_talk(void)
{
    fresh();
    CHECK(pro_app_begin_update_gate());
    V_BEGINS = 0;
    press_room(MAX_HIT_TALK, 0);
    CHECK(V_BEGINS == 0 && !V_OPEN && max_m.talk == MAX_TALK_IDLE);
    CHECK(!strcmp(max_m.notice, "Updating"));
    pro_app_end_update_gate();
    press_room(MAX_HIT_TALK, 0);
    CHECK(V_BEGINS == 1 && V_OPEN);
    press_room(MAX_HIT_TALK_SEND, 0);
    pro_app_voice_result(PRO_VOICE_OK, "a");
    CHECK(!V_OPEN);
}

// A sleeping screen takes no contact: the caller swallows it.
static void test_asleep_refuses_the_finger(void)
{
    fresh();
    pro_app_sleep();
    CHECK(!pro_app_touch(true, lane_x(0), lane_y(0)));
    CHECK(LOCK_DEPTH == 0);
    pro_app_wake();
    CHECK(pro_app_touch(true, lane_x(0), lane_y(0)));
    pro_app_touch_cancel();
}

// A question chimes once: sent again after the cable came back it is the same one; a new one chimes again.
static void test_question_chimes_once(void)
{
    fresh();
    now += 60000;   // past the last chime's coalescing window
    BEEPS = 0;
    pro_app_ask("a", "r1", "Proceed?", NULL, 0, false);
    CHECK(BEEPS == 1);
    now += 60000;
    fresh();
    pro_app_ask("a", "r1", "Proceed?", NULL, 0, false);
    CHECK(BEEPS == 1);
    pro_app_question_close("a");
    now += 60000;
    pro_app_ask("a", "r2", "And this?", NULL, 0, false);
    CHECK(BEEPS == 2);
    // A failed turn is an alert too, but a second alert within 30 s does not chime again.
    pro_app_turn("b", "started", "", 0);
    pro_app_turn("b", "error", "boom", 0);
    CHECK(BEEPS == 2);
}

// ---- answering and New Harness ----

static const pro_ask_item_t DB = {"db", "Which database?", {"Dev", "Staging"}, 2, false, true};

// The reviewed path end to end: the read goes out after the lock (with the next contact's take, as with the clock's),
// the option's answer under the read's token, and the receipt's "Sent".
static void test_reviewed_answer_is_sent_after_the_lock(void)
{
    fresh();
    FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW;
    SENDS = OPENS = 0;
    pro_app_ask("a", "toolu_1", DB.q, &DB, 1, false);
    CHECK(SENDS == 0);   // nothing goes from the cable_link task's callback
    contact(MAX_RAIL_W / 2, 20, 0, 0);
    CHECK(SENDS == 1 && WAITED && !strcmp(last_sent(), "question.read a q1"));
    pro_app_question_state("a", "q1", true, "toolu_1", "tok", false, NULL, &DB, 1);
    press_room(MAX_HIT_OPTION, 1);
    CHECK(SENDS == 2 && WAITED && !strcmp(last_sent(), "answer.reviewed a tok q1 1:2"));
    CHECK(OPENS == 0);   // a button is not the lane
    pro_app_answer_receipt("a", "q1", "tok", true, false, NULL);
    CHECK(!strcmp(max_m.notice, "Sent") && max_find("a")->state == MAX_WORKING);
    // The daemon refuses it: its words.
    pro_app_ask("a", "toolu_2", DB.q, &DB, 1, true);
    contact(MAX_RAIL_W / 2, 20, 0, 0);
    pro_app_question_state("a", "q2", true, "toolu_2", "tok2", false, NULL, &DB, 1);
    press_room(MAX_HIT_OPTION, 0);
    pro_app_answer_receipt("a", "q2", "tok2", false, false, "Permission prompts cannot be answered from here.");
    CHECK(!strcmp(max_m.notice, "Permission prompts cannot be answered from here."));
    CHECK(LOCK_DEPTH == 0);
}

// Without question.review the answer goes plain, its words echoed; a port with no room says so and keeps the card.
static void test_plain_answer_and_a_full_port(void)
{
    fresh();
    FEATURES = CABLE_FEATURE_FORM;
    SENDS = 0;
    pro_app_ask("a", "toolu_1", DB.q, &DB, 1, false);
    PORT_FULL = true;
    press_room(MAX_HIT_OPTION, 0);
    PORT_FULL = false;
    CHECK(SENDS == 0 && !strcmp(max_m.notice, "Not sent") && max_ask_of("a")->phase == MAX_ASK_READY);
    press_room(MAX_HIT_OPTION, 0);
    CHECK(SENDS == 1 && !strcmp(last_sent(), "answer a toolu_1 1 db=Dev") && !strcmp(max_m.notice, "Sent"));
    FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW;
}

// New Harness: the open after the lock under a fresh name, a spoken name for the field, the reply ending the recording,
// Close; a turn for an agent names no form.
static void test_new_harness(void)
{
    fresh();
    max_ui_offers(true);   // as the render task's tick reads the welcome
    SENDS = 0;
    press(MAX_HIT_NEW, 0);
    CHECK(SENDS == 1 && WAITED && max_form_open());
    char form_id[MAX_FORM_ID_BYTES], request[MAX_FETCH_BYTES];
    CHECK(sscanf(last_sent(), "form %48s %15s open 0 0", form_id, request) == 2);
    CHECK(!strncmp(form_id, "form-00c0ffee-", 14) && !strcmp(request, "form-1") && !strcmp(form_id, max_m.form.id));
    const pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "", .previous = "",
                                  .next = "website", .error = "", .status = "", .action = "choose", .query = "",
                                  .revision = 7, .position = 1, .total = 5, .active = true, .enabled = true,
                                  .can_query = true};
    pro_app_form_state("form-1", form_id, true, &page);
    // Say: the recording names the form, not an agent.
    V_BEGINS = 0;
    press_room(MAX_HIT_FORM_SAY, 0);
    CHECK(V_BEGINS == 1 && V_OPEN && !strcmp(V_AGENT, "") && !strcmp(VOICE_FORM, form_id) && VOICE_REVISION == 7);
    CHECK(max_m.talk == MAX_TALK_RECORDING);
    press_room(MAX_HIT_TALK_SEND, 0);
    CHECK(V_WAITING);
    pro_form_page_t found = page;
    found.revision = 8;
    found.label = "website";
    pro_app_voice_form(form_id, true, &found);
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE && !strcmp(max_m.form.page.label, "website"));
    // Close goes out, and the form leaves the bar.
    press(MAX_HIT_FORM_CLOSE, 0);
    CHECK(!max_form_open() && strstr(last_sent(), " close 8 0"));
    // Talk for an agent clears the form's name from the next recording.
    press_room(MAX_HIT_TALK, 0);
    CHECK(V_OPEN && !strcmp(V_AGENT, "a") && VOICE_FORM[0] == 0);
    press_room(MAX_HIT_TALK_SEND, 0);
    pro_app_voice_result(PRO_VOICE_OK, "a");
    CHECK(LOCK_DEPTH == 0);
}

// The daemon's toast is the notice line.
static void test_toast(void)
{
    fresh();
    pro_app_toast("Permission prompts cannot be answered from here.");
    CHECK(!strcmp(max_m.notice, "Permission prompts cannot be answered from here.") && NOTIFIES > 0);
}

int main(void)
{
    pro_app_start();
    test_touch_wakes_the_renderer();
    test_tap_opens_the_lane();
    test_talk_records_and_sends();
    test_cancel_sends_nothing();
    test_update_gate_holds_talk();
    test_asleep_refuses_the_finger();
    test_question_chimes_once();
    test_reviewed_answer_is_sent_after_the_lock();
    test_plain_answer_and_a_full_port();
    test_new_harness();
    test_toast();
    printf("test_max_app: %d checks passed\n", checks);
    return 0;
}
