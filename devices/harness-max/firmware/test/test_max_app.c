// Harness Max's app layer (main/app/max_app.c) over the real model. Below it the host plays the device: a fake clock
// and wall clock, the render task run one pass at a time, the mic's level, and the cable, the recorder and the speaker
// as recorders. Every one of them checks that the app's lock is NOT held: nothing leaves the device under it. The
// pages' targets are planted as the drawing records them (max_test.h), after the pass that drew them.
#include <setjmp.h>
#include <stdarg.h>
#include <time.h>

#include "max_test.h"

#include "app/max_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "audio/pro_recorder.h"
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
static TaskFunction_t RENDER_FN;
static jmp_buf PASS;
static bool IN_PASS;   // render_pass() runs the render task: its wait ends the pass
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) { return calloc(1, sizeof(struct host_mutex)); }
BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t m, TickType_t w) { (void)m; (void)w; LOCK_DEPTH++; return pdTRUE; }
BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t m) { (void)m; CHECK(LOCK_DEPTH > 0); LOCK_DEPTH--; return pdTRUE; }
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack, void *arg, unsigned prio,
                                   TaskHandle_t *out, int core)
{
    (void)stack; (void)arg; (void)prio; (void)core;
    CHECK(!strcmp(name, "pro_render"));   // ram_telemetry and the heartbeat know it by this name
    RENDER_FN = fn;                       // run a pass at a time by render_pass()
    *out = &RENDERER;
    return pdPASS;
}
BaseType_t xTaskNotifyGive(TaskHandle_t t) { CHECK(t == &RENDERER); NOTIFIES++; return pdPASS; }
uint32_t ulTaskNotifyTake(BaseType_t clear, TickType_t wait)
{
    (void)clear; (void)wait;
    CHECK(LOCK_DEPTH == 0);
    if (IN_PASS) longjmp(PASS, 1);   // the pass is done: back to the test
    return 0;
}
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
static char PICKED[PRO_APP_ID_BYTES];
bool pro_cable_app_pick(const char *app, bool wait)
{
    (void)wait;
    CHECK(LOCK_DEPTH == 0);
    snprintf(PICKED, sizeof PICKED, "%s", app);
    return true;
}

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
// The mic's envelope, and the wall clock (0 is 1970: a clock nobody set).
static unsigned LEVEL;
unsigned pro_rec_level(void) { return LEVEL; }
static time_t WALL;
time_t time(time_t *out)
{
    if (out) *out = WALL;
    return WALL;
}
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
// a..f: two pages of Overview's cells.
static const char *const IDS[] = {"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"};
enum { AGENTS = MAX_CELLS + 1 };
_Static_assert(AGENTS <= sizeof IDS / sizeof IDS[0], "IDS holds two pages of cells");

// One pass of the render task: its tick (the mic's level, the clock's send, the wall clock, the outbox), the draw, and
// its wait. A touch keeps the screen from sleeping meanwhile.
static void render_pass(void)
{
    pro_app_bump_activity();
    IN_PASS = true;
    if (!setjmp(PASS)) RENDER_FN(NULL);
    IN_PASS = false;
    CHECK(LOCK_DEPTH == 0);
}

// Overview as drawn: the bell, then the cells of the page shown.
static void overview_drawn(void)
{
    drawn_page(MAX_VIEW_OVERVIEW);
    plant(MAX_HIT_BELL, 0);
    plant_cells();
}
// The agent page as drawn: Back, the strip, X while it records, then the body.
static void agent_drawn(void)
{
    CHECK(max_m.view == MAX_VIEW_AGENT);
    drawn_page(MAX_VIEW_AGENT);
    plant(MAX_HIT_BACK, 0);
    plant_strip();
    if (max_m.talk == MAX_TALK_RECORDING) plant(MAX_HIT_TALK_CANCEL, 0);
    plant_page(MAX_HIT_BODY);
}
// Attention as drawn: the card's options, Say it, then the page around them.
static void attention_drawn(int options)
{
    CHECK(max_m.view == MAX_VIEW_ATTENTION);
    drawn_page(MAX_VIEW_ATTENTION);
    plant_card();
    for (int i = 0; i < options; i++) plant(MAX_HIT_OPTION, i);
    plant(MAX_HIT_SAY_IT, 0);
    plant_page(MAX_HIT_AWAY);
}

// The cable says hello and lists the agents (a..f, every one taking voice); the glass shows Overview as drawn.
static void fresh(void)
{
    pro_app_link(false, NULL);
    V_OPEN = V_PENDING = V_WAITING = false;
    LEVEL = 0;
    pro_app_link(true, "MacBook Pro");
    pro_agent_row_t rows[AGENTS];
    for (int i = 0; i < AGENTS; i++) rows[i] = (pro_agent_row_t){IDS[i], IDS[i], "claude", "m1", "MacBook Pro", NULL, NULL};
    pro_app_agents(rows, AGENTS);
    render_pass();
    overview_drawn();
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
static void tap_on(const max_hit_t *h) { contact(h->x + h->w / 2, h->y + h->h / 2, 0, 0); }
static void tap_cell(const char *id)
{
    const max_box_t *b = cell_of(id);
    contact(b->x + b->w / 2, b->y + b->h / 2, 2, 1);
}
static void tap_page(void) { contact(HT_WIDTH / 2, HT_HEIGHT - 20, 0, 0); }
// The hit of this kind as planted.
static const max_hit_t *find_hit(max_hit_kind_t kind, int arg)
{
    for (int i = 0; i < max_m.hit_count; i++)
        if (max_m.hits[i].kind == kind && max_m.hits[i].arg == arg) return &max_m.hits[i];
    CHECK(!"no such hit");
    return &max_m.hits[0];
}

// ---- tests ----

// A swipe that pages the cells and a tap that opens a page only mark the model for redraw (max_ui_touch returns
// MAX_ACT_NONE for them): the touch path must wake the render task, or the page shows at its next wake, up to 60 s
// later.
static void test_touch_wakes_the_renderer(void)
{
    fresh();
    contact(HT_WIDTH / 2, HT_HEIGHT / 2, -(MAX_SWIPE_PX + 40), 0);
    CHECK(max_m.cell_page == 1 && NOTIFIES > 0);

    fresh();
    tap_on(find_hit(MAX_HIT_BELL, 0));
    CHECK(max_m.view == MAX_VIEW_INBOX && NOTIFIES > 0);
}

// One tap on a cell: agent.open for it, and the mic opens for it, both after the lock is released (the recorders check
// the lock). The agent page shows it, recording.
static void test_cell_tap_opens_and_listens(void)
{
    fresh();
    OPENS = V_BEGINS = 0;
    tap_cell("b");
    CHECK(OPENS == 1 && !strcmp(OPENED, "b") && V_BEGINS == 1 && !strcmp(V_AGENT, "b") && V_OPEN);
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "b") && max_m.talk == MAX_TALK_RECORDING);
    CHECK(NOTIFIES > 0);
    // A swipe opens nothing.
    fresh();
    OPENS = 0;
    const max_box_t *b = cell_of("a");
    contact(b->x + b->w / 2, b->y + b->h / 2, -(MAX_SWIPE_PX + 40), 0);
    CHECK(OPENS == 0 && !V_OPEN);
}

// Speech, then MAX_SILENCE_MS of quiet: the render task's tick sends it, after the lock, and says so.
static void test_the_clock_sends_after_silence(void)
{
    fresh();
    tap_cell("a");
    LEVEL = 3;
    render_pass();
    CHECK(max_m.talk_heard && max_m.level_count == 1 && max_m.levels[0] == 3);
    LEVEL = 0;
    now += MAX_SILENCE_MS - 1;
    render_pass();
    CHECK(V_OPEN && !V_WAITING && max_m.talk == MAX_TALK_RECORDING);
    now += 1;
    render_pass();
    CHECK(V_WAITING && max_m.talk == MAX_TALK_SENDING && !strcmp(max_m.notice, "Sent to a"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    pro_app_voice_result(PRO_VOICE_OK, "a");
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE);
}

// Nothing heard in MAX_HEAR_MS: the mic closes, nothing is sent, and the agent page stays to be tapped again.
static void test_the_mic_closes_when_nothing_is_heard(void)
{
    fresh();
    tap_cell("a");
    LEVEL = 1;   // a room's hum
    now += MAX_HEAR_MS - 1;
    render_pass();
    CHECK(V_OPEN && max_m.talk == MAX_TALK_RECORDING);
    now += 1;
    render_pass();
    CHECK(!V_OPEN && !V_WAITING && max_m.talk == MAX_TALK_IDLE);
    CHECK(!strcmp(max_m.notice, "Mic closed \xc2\xb7 tap to talk") && max_m.view == MAX_VIEW_AGENT);
}

// The agent page's body opens the mic, X drops it (the page stays), and the body again sends it.
static void test_the_body_talks_and_x_cancels(void)
{
    fresh();
    tap_cell("a");
    agent_drawn();
    tap_on(find_hit(MAX_HIT_TALK_CANCEL, 0));
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE && max_m.view == MAX_VIEW_AGENT);
    agent_drawn();
    V_BEGINS = 0;
    tap_page();
    CHECK(V_BEGINS == 1 && V_OPEN && !strcmp(V_AGENT, "a") && max_m.talk == MAX_TALK_RECORDING);
    agent_drawn();
    tap_page();
    CHECK(V_WAITING && max_m.talk == MAX_TALK_SENDING && max_m.view == MAX_VIEW_OVERVIEW);
    pro_app_voice_result(PRO_VOICE_ERROR, "Nobody heard that");
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE && !strcmp(max_m.notice, "Nobody heard that"));
}

// The wall clock: read each tick, known once it is past 2024 (a board that never synced reads 1970).
static void test_the_wall_clock(void)
{
    fresh();
    setenv("TZ", "UTC0", 1);
    tzset();
    WALL = 0;
    render_pass();
    CHECK(!max_m.wall_known);
    WALL = 1795006800;   // Wednesday 18 November 2026, 13:00 UTC
    render_pass();
    CHECK(max_m.wall_known && max_m.wall_hour == 13 && max_m.wall_min == 0 && max_m.wall_wday == 3);
    CHECK(max_m.wall_mday == 18 && max_m.wall_mon == 10);
    WALL += 61;
    render_pass();
    CHECK(max_m.wall_min == 1);
    WALL = 0;
    render_pass();
    CHECK(!max_m.wall_known);
}

// Apps: a card picks its app on the computer, after the lock; the bar goes back to Overview.
static void test_an_app_card_picks_it(void)
{
    fresh();
    const pro_app_row_t apps[] = {{"orca", "Orca", 6, 0}, {"vscode", "VS Code", 2, 0}};
    pro_app_apps("orca", apps, 2);
    tap_on(plant(MAX_HIT_APPS, 0));
    CHECK(max_m.view == MAX_VIEW_APPS);
    drawn_page(MAX_VIEW_APPS);
    PICKED[0] = 0;
    tap_on(plant(MAX_HIT_APP, 1));
    CHECK(!strcmp(PICKED, "vscode") && max_m.view == MAX_VIEW_OVERVIEW);
    // The daemon turns to it: the person's own pick, so no "Following"; the computer turning it back is followed.
    pro_app_toast(NULL);
    pro_app_apps("vscode", apps, 2);
    CHECK(!max_notice_shown(now) && LOCK_DEPTH == 0);
    pro_app_apps("orca", apps, 2);
    CHECK(!strcmp(max_m.notice, "Following Orca on your Mac"));
}

// Attention outside its buttons brings the agent up on the computer, after the lock, and says where.
static void test_away_brings_the_agent_up(void)
{
    fresh();
    const pro_app_row_t apps[] = {{"orca", "Orca", 6, 1}};
    pro_app_apps("orca", apps, 1);
    pro_app_turn("c", "started", "", 0);
    pro_app_turn("c", "error", "boom", 0);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c") && max_m.attn == MAX_ATTN_FAIL);
    attention_drawn(0);
    OPENS = 0;
    tap_page();
    CHECK(OPENS == 1 && !strcmp(OPENED, "c") && !strcmp(max_m.notice, "c is up in Orca"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
}

// An accepted update offer holds voice off: a cell still opens its agent, but the mic says why it stays closed.
static void test_update_gate_holds_talk(void)
{
    fresh();
    CHECK(pro_app_begin_update_gate());
    OPENS = V_BEGINS = 0;
    tap_cell("a");
    CHECK(OPENS == 1 && V_BEGINS == 0 && !V_OPEN && max_m.talk == MAX_TALK_IDLE);
    CHECK(!strcmp(max_m.notice, "Updating") && max_m.view == MAX_VIEW_AGENT);
    pro_app_end_update_gate();
    agent_drawn();
    tap_page();
    CHECK(V_BEGINS == 1 && V_OPEN);
    agent_drawn();
    tap_page();
    pro_app_voice_result(PRO_VOICE_OK, "a");
    CHECK(!V_OPEN);
}

// A sleeping screen takes no contact: the caller swallows it.
static void test_asleep_refuses_the_finger(void)
{
    fresh();
    const max_box_t *b = cell_of("a");
    pro_app_sleep();
    CHECK(!pro_app_touch(true, b->x + 5, b->y + 5));
    CHECK(LOCK_DEPTH == 0);
    pro_app_wake();
    CHECK(pro_app_touch(true, b->x + 5, b->y + 5));
    pro_app_touch_cancel();
}

// A question chimes once: sent again after the cable came back it is the same one; a new one chimes again.
static void test_question_chimes_once(void)
{
    fresh();
    now += 60000;   // past the last chime's coalescing window
    BEEPS = 0;
    pro_app_ask("a", NULL, "r1", "Proceed?", NULL, 0, false, false);
    CHECK(BEEPS == 1);
    now += 60000;
    fresh();
    pro_app_ask("a", NULL, "r1", "Proceed?", NULL, 0, false, false);
    CHECK(BEEPS == 1);
    pro_app_question_close("a");
    now += 60000;
    pro_app_ask("a", NULL, "r2", "And this?", NULL, 0, false, false);
    CHECK(BEEPS == 2);
    // A failed turn is an alert too, but a second alert within 30 s does not chime again.
    pro_app_turn("b", "started", "", 0);
    pro_app_turn("b", "error", "boom", 0);
    CHECK(BEEPS == 2);
}

// A `tier: "list"` question (one the bar was told before) is filed silently once the welcome lists question.tier: no
// chime, no wake, no Attention. From a daemon that did not list it the flag vouches for nothing: it rings.
static void test_listed_question_is_silent(void)
{
    fresh();
    FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW | CABLE_FEATURE_QUESTION_TIER;
    now += 60000;   // past the last chime's coalescing window
    BEEPS = 0;
    pro_app_sleep();
    pro_app_ask("a", NULL, "r1", "Proceed?", NULL, 0, false, true);
    CHECK(BEEPS == 0 && pro_app_asleep() && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(max_find("a")->state == MAX_ASKING && max_m.inbox[0].unread && LOCK_DEPTH == 0);
    FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW;
    pro_app_ask("b", NULL, "r2", "And this?", NULL, 0, false, true);
    CHECK(BEEPS == 1 && !pro_app_asleep() && max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "b"));
}

// A question of an agent off the ring (another app's) rings once and files its notice under the frame's name; the page
// stays, as its agent is not on the bar.
static void test_question_off_the_ring_rings_once(void)
{
    fresh();
    now += 60000;
    BEEPS = 0;
    pro_app_ask("zz", "Zed", "r9", "Ship it?", NULL, 0, false, false);
    CHECK(BEEPS == 1 && max_m.view == MAX_VIEW_OVERVIEW && !strcmp(max_m.inbox[0].name, "Zed"));
    CHECK(!strcmp(max_m.inbox[0].text, "Ship it?") && max_m.inbox[0].unread && LOCK_DEPTH == 0);
    now += 60000;
    pro_app_ask("zz", "Zed", "r9", "Ship it?", NULL, 0, false, false);
    CHECK(BEEPS == 1);
}

// notif.replace: a question row makes its ring agent ask, silently (the daemon sends no `question` for it); news rows
// file nothing.
static void test_drawer_rows(void)
{
    fresh();
    now += 60000;
    BEEPS = 0;
    const int inbox = max_m.inbox_count;
    const pro_notif_row_t rows[] = {{"c", "c", "Keep the dark gradient?", "", true}, {"d", "d", "Done.", "t1", false}};
    pro_app_notif_replace(rows, 2);
    CHECK(max_find("c")->state == MAX_ASKING && !strcmp(max_find("c")->question, "Keep the dark gradient?"));
    CHECK(BEEPS == 0 && max_m.view == MAX_VIEW_OVERVIEW && max_m.inbox_count == inbox + 1 && LOCK_DEPTH == 0);
    CHECK(max_find("d")->state != MAX_DONE);
}

// ---- answering and New Harness ----

static const pro_ask_item_t DB = {"db", "Which database?", {"Dev", "Staging"}, 2, false, true};

// The reviewed path end to end on Attention: the read goes out after the lock (with the next contact's take, as with
// the clock's), the option's answer under the read's token, and the receipt's "Sent".
static void test_reviewed_answer_is_sent_after_the_lock(void)
{
    fresh();
    FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW;
    SENDS = OPENS = 0;
    pro_app_ask("a", NULL, "toolu_1", DB.q, &DB, 1, false, false);
    CHECK(SENDS == 0 && max_m.view == MAX_VIEW_ATTENTION);   // nothing goes from the cable_link task's callback
    drawn_page(MAX_VIEW_ATTENTION);
    contact(HT_WIDTH - 2, HT_HEIGHT - 2, 0, 0);   // where nothing is drawn
    // Reads are numbered across the run (earlier tests' questions were read too): the card names this one's.
    char fetch[16], want[64];
    snprintf(fetch, sizeof fetch, "%s", max_ask_of("a")->fetch);
    snprintf(want, sizeof want, "question.read a %s", fetch);
    CHECK(SENDS == 1 && WAITED && !strcmp(last_sent(), want));
    pro_app_question_state("a", fetch, true, "toolu_1", "tok", false, NULL, &DB, 1);
    attention_drawn(2);
    tap_on(find_hit(MAX_HIT_OPTION, 1));
    snprintf(want, sizeof want, "answer.reviewed a tok %s 1:2", fetch);
    CHECK(SENDS == 2 && WAITED && !strcmp(last_sent(), want));
    CHECK(OPENS == 0 && max_m.view == MAX_VIEW_OVERVIEW);   // a button is not the page around it
    pro_app_answer_receipt("a", fetch, "tok", true, false, NULL);
    CHECK(!strcmp(max_m.notice, "Sent") && max_find("a")->state == MAX_WORKING);
    // The daemon refuses it: its words.
    pro_app_ask("a", NULL, "toolu_2", DB.q, &DB, 1, true, false);
    drawn_page(MAX_VIEW_ATTENTION);
    contact(HT_WIDTH - 2, HT_HEIGHT - 2, 0, 0);   // where nothing is drawn
    snprintf(fetch, sizeof fetch, "%s", max_ask_of("a")->fetch);
    pro_app_question_state("a", fetch, true, "toolu_2", "tok2", false, NULL, &DB, 1);
    attention_drawn(2);
    tap_on(find_hit(MAX_HIT_OPTION, 0));
    pro_app_answer_receipt("a", fetch, "tok2", false, false, "Permission prompts cannot be answered from here.");
    CHECK(!strcmp(max_m.notice, "Permission prompts cannot be answered from here."));
    CHECK(LOCK_DEPTH == 0);
}

// Without question.review the answer goes plain, its words echoed; a port with no room says so and keeps the card.
static void test_plain_answer_and_a_full_port(void)
{
    fresh();
    FEATURES = CABLE_FEATURE_FORM;
    SENDS = 0;
    pro_app_ask("a", NULL, "toolu_1", DB.q, &DB, 1, false, false);
    attention_drawn(2);
    PORT_FULL = true;
    tap_on(find_hit(MAX_HIT_OPTION, 0));
    PORT_FULL = false;
    CHECK(SENDS == 0 && !strcmp(max_m.notice, "Not sent") && max_ask_of("a")->phase == MAX_ASK_READY);
    attention_drawn(2);
    tap_on(find_hit(MAX_HIT_OPTION, 0));
    CHECK(SENDS == 1 && !strcmp(last_sent(), "answer a toolu_1 1 db=Dev") && !strcmp(max_m.notice, "Sent"));
    FEATURES = CABLE_FEATURE_FORM | CABLE_FEATURE_QUESTION_REVIEW;
}

// New Harness: the open after the lock under a fresh name, a spoken name for the field (sent by a tap), the reply
// ending the recording, Close; a recording for an agent names no form.
static void test_new_harness(void)
{
    fresh();
    max_ui_offers(true);   // as the render task's tick reads the welcome
    const pro_app_row_t apps[] = {{"orca", "Orca", 6, 0}};
    pro_app_apps("orca", apps, 1);
    tap_on(plant(MAX_HIT_APPS, 0));
    drawn_page(MAX_VIEW_APPS);
    SENDS = 0;
    tap_on(plant(MAX_HIT_NEW, 0));
    CHECK(SENDS == 1 && WAITED && max_form_open());
    char form_id[MAX_FORM_ID_BYTES], request[MAX_FETCH_BYTES];
    CHECK(sscanf(last_sent(), "form %48s %15s open 0 0", form_id, request) == 2);
    CHECK(!strncmp(form_id, "form-00c0ffee-", 14) && !strcmp(request, "form-1") && !strcmp(form_id, max_m.form.id));
    const pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "", .previous = "",
                                  .next = "website", .error = "", .status = "", .action = "choose", .query = "",
                                  .revision = 7, .position = 1, .total = 5, .active = true, .enabled = true,
                                  .can_query = true};
    pro_app_form_state("form-1", form_id, true, &page);
    max_m.form_revision = 7;   // the page drawn
    drawn_page(MAX_VIEW_APPS);
    const max_hit_t *say = plant(MAX_HIT_FORM_SAY, 0), *close = plant(MAX_HIT_FORM_CLOSE, 0);
    // Say: the recording names the form, not an agent; a tap sends it.
    V_BEGINS = 0;
    tap_on(say);
    CHECK(V_BEGINS == 1 && V_OPEN && !strcmp(V_AGENT, "") && !strcmp(VOICE_FORM, form_id) && VOICE_REVISION == 7);
    CHECK(max_m.talk == MAX_TALK_RECORDING);
    tap_on(say);
    CHECK(V_WAITING && max_form_open());
    pro_form_page_t found = page;
    found.revision = 8;
    found.label = "website";
    pro_app_voice_form(form_id, true, &found);
    CHECK(!V_OPEN && max_m.talk == MAX_TALK_IDLE && !strcmp(max_m.form.page.label, "website"));
    // Close goes out, and the form leaves the bar.
    tap_on(close);
    CHECK(!max_form_open() && strstr(last_sent(), " close 8 0"));
    // Talk for an agent clears the form's name from the next recording.
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    tap_cell("a");
    CHECK(V_OPEN && !strcmp(V_AGENT, "a") && VOICE_FORM[0] == 0);
    agent_drawn();
    tap_page();
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
    CHECK(RENDER_FN != NULL);
    test_touch_wakes_the_renderer();
    test_cell_tap_opens_and_listens();
    test_the_clock_sends_after_silence();
    test_the_mic_closes_when_nothing_is_heard();
    test_the_body_talks_and_x_cancels();
    test_the_wall_clock();
    test_an_app_card_picks_it();
    test_away_brings_the_agent_up();
    test_update_gate_holds_talk();
    test_asleep_refuses_the_finger();
    test_question_chimes_once();
    test_listed_question_is_silent();
    test_question_off_the_ring_rings_once();
    test_drawer_rows();
    test_reviewed_answer_is_sent_after_the_lock();
    test_plain_answer_and_a_full_port();
    test_new_harness();
    test_toast();
    printf("test_max_app: %d checks passed\n", checks);
    return 0;
}
