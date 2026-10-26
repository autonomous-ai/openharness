#!/usr/bin/env python3
"""Replay the Pro's record button through the production voice path: pro_app.c's gate and effects, pod_glue.c, and
the real state machine in audio/pro_voice.c, with the recorder (pro_recorder.h), the cable and the clock as host fakes.

Ported from the round firmware's test_pod_voice_gate.py, which sliced Pod's A_VOICE handling out of ui_habitat.c. The
nine replays keep their names and A_VOICE value 9 (Pod's "plain voice to a named agent": the action POD_FX_VOICE_BEGIN
stands for, which skips the Player-1 pane gates). The Pro has no queue, no loading flag and no notice list, so:
  busy_cable_says_why             the cable is still carrying the last clip: a refusal that is not the generic one
  booting / roster_not_yet_refreshed   nothing the daemon says about machines or the roster is needed to record
  library_only_after_message_view     a notice on screen does not strand the gate
Each replay ends the way pod_perform's own check does: the recorder running for that agent, or a notice that says why.
Also: `voice: link drop ends talk` (Review Focus 3), the 600 s cap, the 65 s reply wait, unsend, and a reply that
arrives mid-recording. No USB, hardware writes or microphone.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
FW = HERE.parent
MAIN = FW / "main"
APP = MAIN / "app"
POD = MAIN / "pod"
DISP = MAIN / "display"
AUDIO = MAIN / "audio"

code = r'''
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "app/pro_app.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "audio/pro_recorder.h"
#include "cable/cable_link.h"
#include "cable/pro_cable.h"
#include "pro_app_api.h"
#include "pro_canvas.h"
#include "sys/config_store.h"
#include "sys/ram_telemetry.h"
#include "sys/last_words.h"
#include "app/pro_touch.h"
#include "pro_display.h"
#include "pro_frame.h"

#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

// Pod's "plain voice to a named agent" is A_VOICE value 9 in the round firmware; here it is POD_FX_VOICE_BEGIN. Value 9
// skips the Player-1 pane gates, so the replays below must pass for any agent the library lists.
enum { A_VOICE = 9 };
#define U (*pro_app_test_pod())
static ht_scene_t S;
static uint32_t now = 1000;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); exit(1); } } while (0)

static void render(void) { ht_scene_clear(&S, ht_rgb(0xffffff)); pod_ui_render(&U, &S, now); }
static pod_view_t top(void) { return U.nav.stack[U.nav.depth - 1].view; }
static const pod_hit_t *hit(pod_action_t a, int arg) {
    for (int i = 0; i < U.frame.hit_count; i++)
        if (U.frame.hits[i].action == a && U.frame.hits[i].arg == arg) return &U.frame.hits[i];
    return NULL;
}

// ---- the host plays what the device has below pro_app ----------------------------------------------------------
// pro_app's mutex, depth-counted: nothing may leave the app (cable, recorder) while it is held, and no voice call
// may be made under it (app/pro_voice.h).
static int LOCK_DEPTH;
struct host_mutex { int unused; };
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) { return calloc(1, sizeof(struct host_mutex)); }
BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t m, TickType_t w) { (void)m; (void)w; LOCK_DEPTH++; return pdTRUE; }
BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t m) { (void)m; CHECK(LOCK_DEPTH > 0); LOCK_DEPTH--; return pdTRUE; }
int64_t esp_timer_get_time(void) { return (int64_t)now * 1000; }
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t f, const char *n, uint32_t s, void *a, unsigned p, TaskHandle_t *o, int core) { (void)f; (void)n; (void)s; (void)a; (void)p; (void)o; (void)core; return pdPASS; }
BaseType_t xTaskNotifyGive(TaskHandle_t t) { (void)t; return pdTRUE; }
uint32_t ulTaskNotifyTake(BaseType_t c, TickType_t w) { (void)c; (void)w; return 0; }
void vTaskDelay(TickType_t t) { (void)t; }
uint32_t uxTaskGetStackHighWaterMark(TaskHandle_t t) { (void)t; return 0; }
esp_err_t esp_task_wdt_add(void *t) { (void)t; return ESP_OK; }
esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }
void last_words_phase(lw_task_t t, const char *p) { (void)t; (void)p; }
void last_words_rx(uint32_t ms) { (void)ms; }
size_t heap_caps_get_free_size(unsigned c) { (void)c; return 0; }
size_t heap_caps_get_largest_free_block(unsigned c) { (void)c; return 0; }
uint8_t config_load_brightness(void) { return 220; }
bool config_load_muted(void) { return true; }
bool pro_settings_muted(void) { return true; }
void audio_beep(void) {}
bool pro_cable_send_notif_read(const char *a, const char *t) { (void)a; (void)t; return true; }
void config_load_voicelang(char *out, size_t cap) { snprintf(out, cap, "vi"); }
void ram_telemetry_periodic(const char *tag) { (void)tag; }
bool fw_was_updated(char *version, size_t cap) { (void)version; (void)cap; return false; }
void pro_frame_init(void) {}
uint32_t pro_frame_present(const ht_scene_t *p, const ht_scene_t *n, uint32_t *px) { (void)p; (void)n; if (px) *px = 1; return 0; }
void pro_display_set_brightness(uint8_t l) { (void)l; }
void pro_display_power(bool on) { (void)on; }
uint32_t esp_random(void) { static uint32_t n = 0x1000; return n++; }
bool audio_capture_init(void) { return true; }
pro_touch_sample_t pro_touch_poll(int *x, int *y) { (void)x; (void)y; return PRO_TOUCH_NONE; }

// The cable: what pro_app and pro_voice send.
static struct { int opens, cancels; char cancel_id[24]; } CAB;
bool pro_cable_send_open(const char *id) { CHECK(LOCK_DEPTH == 0); (void)id; CAB.opens++; return true; }
bool pro_cable_supertab_send(const char *t, const char *tab, const char *lead) { CHECK(LOCK_DEPTH == 0); (void)t; (void)tab; (void)lead; return true; }
bool pro_cable_send_scroll(pro_scroll_phase_t p, int dy, int v) { CHECK(LOCK_DEPTH == 0); (void)p; (void)dy; (void)v; return true; }
bool pro_cable_request_library(int offset, uint32_t request) { CHECK(LOCK_DEPTH == 0); (void)offset; (void)request; return true; }
bool pro_cable_library_supported(void) { return false; }
cable_link_stats_t cable_link_stats(void) { return (cable_link_stats_t){0}; }
void pro_cable_counters(uint32_t *bad, uint32_t *unknown) { *bad = 0; *unknown = 0; }
bool pro_cable_voice_cancel(const char *id) { CHECK(LOCK_DEPTH == 0); CAB.cancels++; snprintf(CAB.cancel_id, sizeof CAB.cancel_id, "%s", id); return true; }

// The recorder: the capture and sender tasks are replaced by flags the test flips.
void (*pro_test_in_start)(void);
static struct {
    bool tick_inside;   // the render task ticks while the recorder is starting (the stream is already live)
    bool init_ok, refuse, active, recording, mic_tried, finalising;
    int starts, stops, aborts, aborts_quiet;
    char agent[ID_MAX], lang[CFG_VLANG_MAX], upload[24];
} REC;
bool pro_rec_init(void) { return REC.init_ok; }
bool pro_rec_start(const char *agent, const char *lang, const char *upload) {
    CHECK(LOCK_DEPTH == 0);
    if (REC.refuse || REC.active) return false;
    REC.starts++;
    REC.active = REC.recording = true;
    REC.mic_tried = false;
    snprintf(REC.agent, sizeof REC.agent, "%s", agent);
    snprintf(REC.lang, sizeof REC.lang, "%s", lang);
    snprintf(REC.upload, sizeof REC.upload, "%s", upload);
    if (REC.tick_inside) pro_voice_tick(now + 20000);   // the render task, mid-start
    if (pro_test_in_start) pro_test_in_start();
    return true;
}
void pro_rec_stop(void) { CHECK(LOCK_DEPTH == 0); REC.stops++; REC.recording = false; }   // the sender then finalises
void pro_rec_abort(bool quiet) {
    CHECK(LOCK_DEPTH == 0);
    if (!REC.active) return;
    REC.aborts++;
    if (quiet) REC.aborts_quiet++;
    REC.recording = false;
}
bool pro_rec_active(void) { return REC.active; }
bool pro_rec_recording(void) { return REC.recording; }
bool pro_rec_mic_tried(void) { return REC.mic_tried; }
bool pro_rec_heard(void) { return false; }
unsigned pro_rec_level(void) { return 0; }
// The capture task opened the mic, and (later) the sender finished with the clip.
static void mic_opens(void) { REC.mic_tried = true; }
static void sender_done(void) { REC.active = REC.recording = false; }

// ---- the app ----------------------------------------------------------------------------------------------------
static pod_out_t tap_at_(int x, int y) {
    now += 16;
    CHECK(pro_app_touch(true, x, y));
    now += 16;
    CHECK(pro_app_touch(false, x, y));
    CHECK(LOCK_DEPTH == 0);
    render();
    return (pod_out_t){0};
}
// No screen draws a Talk button or a tab's agent list: a still press on an agent starts the recording (the lift keeps it, hands
// free; a later tap sends), and a tab's agents open through the nav, as a tap on one would.
static void hold_press(void) {
    now += 16;
    CHECK(pro_app_touch(true, 360, 400));
    now += 450;
    CHECK(pro_app_touch(true, 360, 400));   // the still sample that finds the deadline
    now += 16;
    CHECK(pro_app_touch(false, 360, 400));
    CHECK(LOCK_DEPTH == 0);
    render();
}
static void tap(pod_action_t a, int arg) {
    const pod_hit_t *h = hit(a, arg);
    if (!h && a == POD_A_BACK) { pro_app_button_press(); render(); return; }   // the side button: back one level, a recording discarded
    if (!h && (a == POD_A_OPEN_TAB || a == POD_A_OPEN_AGENT)) { pod_nav_act(&U.nav, &U.model, a, arg, now); render(); return; }
    if (!h && a == POD_A_TALK && (top() == POD_V_AGENT || top() == POD_V_RECAP)) { hold_press(); return; }
    CHECK(h);
    tap_at_(h->x + h->w / 2, h->y + h->h / 2);
}

static pro_agent_row_t ROWS[4];
static void machines(const char *a, const char *b) {   // a: the machine "m-a" (Mac), b: "m-b" (Box); "" = none
    cable_machine_t m[2];
    memset(m, 0, sizeof m);
    int n = 0;
    if (a[0]) { snprintf(m[n].id, sizeof m[n].id, "m-a"); snprintf(m[n].name, sizeof m[n].name, "Mac"); snprintf(m[n].state, sizeof m[n].state, "%s", a); n++; }
    if (b[0]) { snprintf(m[n].id, sizeof m[n].id, "m-b"); snprintf(m[n].name, sizeof m[n].name, "Box"); snprintf(m[n].state, sizeof m[n].state, "%s", b); n++; }
    pro_app_machines(m, n, "m-a");
}
// The device's real situation: linked, one tab holding a1 and a2, a3 on another computer. Pod sits on the Tabs list.
static void situation(void) {
    pro_app_test_reset();
    memset(&REC, 0, sizeof REC); REC.init_ok = true;
    memset(&CAB, 0, sizeof CAB);
    pro_voice_close(); pro_voice_link_lost();   // the real state machine starts clean, like a fresh boot
    memset(&REC, 0, sizeof REC); REC.init_ok = true;
    LOCK_DEPTH = 0;
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "Mac"}, {"a2", "Bravo", "codex", "Mac"}, {"a3", "Charlie", "claude", "Box"}};
    pod_ui_roster(&U, rows, 3);
    cable_swarm_t sw[1] = {{.agents = 2, .panes = 2}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    static cable_swarm_members_t members;
    memset(&members, 0, sizeof members);
    members.count[0] = 2; snprintf(members.id[0][0], ID_MAX, "a1"); snprintf(members.id[0][1], ID_MAX, "a2");
    pod_ui_swarms(&U, sw, 1, &members, "s0", NULL, 0);
    pro_app_link(true, "mac");
    ROWS[0] = (pro_agent_row_t){"a1", "Alpha", "claude", "m-a", "Mac"};
    ROWS[1] = (pro_agent_row_t){"a2", "Bravo", "codex", "m-a", "Mac"};
    ROWS[2] = (pro_agent_row_t){"a3", "Charlie", "claude", "m-b", "Box"};
    pro_app_agents(ROWS, 3);
    machines("online", "online");
    render();
}
// Open the Agent screen of a roster agent (the window's tab 0, row `n`).
static void to_agent(int n) {
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, n);
    CHECK(top() == POD_V_AGENT);
}
// Press the triangle on the open Agent screen; the capture task then opens the mic once pro_voice has begun.
static void press(void) {
    tap(POD_A_TALK, 0);
}
// No Talk button is drawn. A stale TALK hit, drawn before the agent asked, still
// reaches the app's voice gate, which is what these replays check.
static void press_stale(void) {
    CHECK(U.frame.hit_count < 32);
    U.frame.hits[U.frame.hit_count++] = (pod_hit_t){0, 0, 720, 720, POD_A_TALK, 0, {0}};
    tap(POD_A_TALK, 0);
}
static_assert(A_VOICE == 9, "A_VOICE value 9 is Pod's plain voice");
static bool recording_for(const char *id) { return REC.active && REC.recording && !strcmp(REC.agent, id); }

// ---- the replays (names from test_pod_voice_gate.py) ------------------------------------------------------------
static void in_roster(void) {
    situation(); to_agent(1);
    press();
    CHECK(recording_for("a2") && pro_voice_open() && pro_voice_start_pending());
    CHECK(top() == POD_V_TALK && !U.notice_on);
    CHECK(!strcmp(REC.lang, "vi") && strlen(REC.upload) == 16);   // the language setting travels with the clip
}
static void library_only(void) {   // an agent only the library lists: no pane, no roster row
    situation();
    pro_library_row_t lib[1] = {{"lib-7", "Library", "claude", "Mac", "idle", 5}};
    pro_app_library(lib, 1, 0, 1);
    pro_app_focus("lib-7");
    render();
    CHECK(top() == POD_V_AGENT);
    press();
    CHECK(recording_for("lib-7") && !U.notice_on);
}
static void roster_not_yet_refreshed(void) {   // the reconnect's agent list has not arrived: still allowed
    situation(); to_agent(0);
    pro_app_link(true, "other");           // another computer's hello; its agent list has not come yet
    render();
    press();
    CHECK(recording_for("a1") && !U.notice_on);
}
static void booting(void) {   // no machines.end yet: the gate does not wait for it
    situation(); to_agent(0);
    machines("", "");
    press();
    CHECK(recording_for("a1") && !U.notice_on);
}
static void question_agent_says_why(void) {
    situation(); to_agent(1);
    pro_app_question("a2", "r1", "Which one?", NULL, POD_ATTN_NONE);
    render();
    CHECK(!hit(POD_A_TALK, 0));
    press_stale();
    CHECK(!REC.active && REC.starts == 0 && top() == POD_V_AGENT);
    CHECK(U.notice_on && !strcmp(U.notice, "Answer its question first."));
}
static void offline_machine_says_why(void) {
    situation(); to_agent(1);
    machines("offline", "online");
    press();
    CHECK(!REC.active && REC.starts == 0 && top() == POD_V_AGENT);
    CHECK(U.notice_on && !strcmp(U.notice, "This computer is offline."));
}
static void busy_cable_says_why(void) {   // the cable is still carrying the last clip
    situation(); to_agent(0);
    press();
    mic_opens();
    tap(POD_A_TALK, 0);                   // Done: the clip goes; its reply is awaited
    CHECK(pro_voice_waiting() && top() == POD_V_TALK && U.nav.sending);
    tap_at_(360, 400);                    // the voice screen is sending: a tap on it starts nothing
    CHECK(REC.starts == 1 && top() == POD_V_TALK && !U.notice_on);
    pro_app_turn("a1", "started", "", 0); // the turn begins before the reply: back on the Agent screen
    CHECK(top() == POD_V_AGENT);
    render();
    press();                              // a new press while the last one is on the wire
    CHECK(REC.starts == 1 && top() == POD_V_AGENT);
    CHECK(U.notice_on && !strcmp(U.notice, "Still sending the last message"));
}
static void library_only_after_message_view(void) {   // a notice on screen (the old MESSAGE view) strands nothing
    situation(); to_agent(0);
    pro_app_notice("Something else");
    CHECK(U.notice_on);
    press();
    CHECK(recording_for("a1"));
}
static void not_connected(void) {
    situation(); to_agent(1);
    pro_app_link(false, NULL);
    render();
    pro_app_link(true, "mac");            // the link is back but the session's machine and agent data are gone
    pro_app_link(false, NULL);
    CHECK(!strcmp(pro_app_voice_block_reason("a2"), "Not connected"));
    CHECK(!REC.active);
}

// ---- the rest of the lifecycle ----------------------------------------------------------------------------------
// A start that the recorder refuses: Talk is left and a notice says so.
static void refused_start(void) {
    situation(); to_agent(0);
    REC.refuse = true;
    press();
    CHECK(top() == POD_V_AGENT && !pro_voice_open() && U.notice_on && !strcmp(U.notice, "Can't talk right now"));
}
// Done: send. The recorder stops; waiting; the reply ends it.
static void send_and_reply(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    CHECK(!pro_voice_start_pending());
    tap(POD_A_TALK, 0);
    CHECK(REC.stops == 1 && pro_voice_waiting() && pro_voice_open() && top() == POD_V_TALK && U.nav.sending);   // the voice screen, sending
    sender_done();
    pro_app_voice_result(PRO_VOICE_OK, "a1");
    CHECK(!pro_voice_open() && !pro_voice_waiting() && CAB.cancels == 0);
    const pod_agent_t *sent = pod_model_find(&U.model, "a1");   // Working at once, before its turn starts
    CHECK(sent && sent->sent && pod_model_eff(&U.model, sent) == POD_WORKING);
    CHECK(top() == POD_V_TALK && U.nav.sending);                // the optimistic Working does not leave the voice screen
    pro_app_tick();
    CHECK(top() == POD_V_TALK);
    pro_app_turn("a1", "started", "", 0);                    // the daemon's real turn: the Agent screen, working
    CHECK(top() == POD_V_AGENT && !U.nav.sending);
    render();
    press();                               // the next recording starts
    CHECK(REC.starts == 2 && recording_for("a1"));
}
// A voice.error becomes a notice (owner decision 2) and frees the next start.
static void error_is_a_notice(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    tap(POD_A_TALK, 0); sender_done();
    pro_app_voice_result(PRO_VOICE_ERROR, "Didn't catch that");
    CHECK(!pro_voice_open() && U.notice_on && !strcmp(U.notice, "Didn't catch that") && top() == POD_V_AGENT);
    CHECK(!pod_model_find(&U.model, "a1")->sent);   // nothing was sent: the state is the daemon's
}
// An error that arrives while the mic is still open ends the recording; nothing goes back to the daemon.
static void error_mid_recording(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    pro_app_voice_result(PRO_VOICE_ERROR, "Quota");
    CHECK(!pro_voice_open() && REC.aborts == 1 && REC.aborts_quiet == 1 && top() == POD_V_AGENT && U.notice_on);
}
// R12: stopped before the recorder ever started = nothing recorded, "Not sent".
static void unsend(void) {
    situation(); to_agent(0);
    press();
    CHECK(pro_voice_start_pending());
    tap(POD_A_TALK, 0);
    CHECK(!pro_voice_open() && REC.aborts == 1 && CAB.cancels == 1 && !strcmp(CAB.cancel_id, REC.upload));
    CHECK(top() == POD_V_AGENT && !pod_ui_talking(&U));
}
// Back out of Talk while recording: discard and tell the daemon.
static void back_discards(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    tap(POD_A_BACK, 0);
    CHECK(!pro_voice_open() && REC.aborts == 1 && CAB.cancels == 1 && !pod_ui_talking(&U));
}
// R13: the 600 s cap sends what was said (as Done), and the reply wait is 65 s.
static void cap_and_reply_wait(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    uint32_t t0 = now;
    now = t0 + 599000; pro_app_tick();
    CHECK(pro_voice_open() && !pro_voice_waiting() && top() == POD_V_TALK);
    now = t0 + 600000; pro_app_tick();
    CHECK(REC.stops == 1 && pro_voice_waiting() && top() == POD_V_AGENT && !U.nav.sending);   // Talk is left, the clip is on its way
    sender_done();
    now += 64000; pro_app_tick();
    CHECK(pro_voice_open() && !U.notice_on);
    now += 1000; pro_app_tick();
    CHECK(!pro_voice_open() && CAB.cancels == 1 && U.notice_on && !strcmp(U.notice, "No response yet. Check Harness on your computer."));
}
// R13: a recorder that stopped by itself (mic failed, DMA overrun) is aborted with a notice, not left on Talk.
static void recorder_died(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    sender_done();                         // the capture task gave up and the sender finalised the abort
    now += 300; pro_app_tick();            // not yet: the 700 ms rule
    CHECK(pro_voice_open());
    now += 500; pro_app_tick();
    CHECK(!pro_voice_open() && CAB.cancels == 1 && top() == POD_V_AGENT);
    CHECK(U.notice_on && !strcmp(U.notice, "Recording stopped. Please try again."));
}
// The mic never opens: the start guard gives up instead of waiting for ever.
static void mic_never_opens(void) {
    situation(); to_agent(0);
    press();
    now += 5100; pro_app_tick();
    CHECK(!pro_voice_open() && REC.aborts == 1 && top() == POD_V_AGENT && U.notice_on);
}
// Review Focus 3: the link dropping while TALK is on top.
static void voice_link_drop_ends_talk(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    CHECK(top() == POD_V_TALK);
    int cancels = CAB.cancels;
    pro_app_link(false, NULL);
    pro_app_tick();
    CHECK(top() == POD_V_AGENT && !pod_ui_talking(&U));       // back where it came from
    CHECK(!pro_voice_open() && !pro_voice_waiting());          // nothing waits for ever
    CHECK(REC.aborts == 1 && REC.aborts_quiet == 1);           // the recorder is told, and sends nothing (the cable is dead)
    CHECK(CAB.cancels == cancels);                             // and no voice.abort goes to a dead link
    // Reconnect: the next recording starts clean.
    sender_done();
    pro_app_link(true, "mac");
    pro_app_agents(ROWS, 3);
    machines("online", "online");
    render();
    press();
    CHECK(recording_for("a1"));
}
// The same while a clip is waiting for its reply.
static void voice_link_drop_while_waiting(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    tap(POD_A_TALK, 0); sender_done();
    CHECK(pro_voice_waiting());
    pro_app_link(false, NULL);
    CHECK(!pro_voice_open() && !pro_voice_waiting());
    now += 70000; pro_app_tick();
    CHECK(CAB.cancels == 0 && !U.notice_on);                   // no stale 65 s timeout fires afterwards
}
// Talk on screen with the recorder gone (a drop that came without a link_lost) leaves Talk at the next step.
static void talk_over_in_tick(void) {
    situation(); to_agent(0);
    press(); mic_opens();
    pro_voice_close();
    pro_app_tick();
    CHECK(top() == POD_V_AGENT);
}

// M2: the render task's tick lands between every step of pro_voice_begin (a hook inside pro_voice.c). The tick is far
// past every limit (so any step it judged would discard), yet a begin in flight is never discarded and never orphaned.
static int STEPS_SEEN;
static bool HOOK_ON;
void pro_voice_test_step(int step) {
    if (!HOOK_ON) return;
    STEPS_SEEN |= 1 << step;
    pro_voice_tick(now + 20000);
    CHECK(CAB.cancels == 0 && REC.aborts == 0);   // no discard mid-begin
}
static void begin_is_atomic_to_the_tick(void) {
    situation();
    STEPS_SEEN = 0; HOOK_ON = true; REC.tick_inside = true;
    pro_voice_begin("a1");
    HOOK_ON = false; REC.tick_inside = false;
    CHECK(STEPS_SEEN == 0x3e);                         // steps 1..5 all interleaved
    CHECK(pro_voice_open() && REC.active && REC.recording && !strcmp(REC.agent, "a1"));
    CHECK(CAB.cancels == 0 && REC.aborts == 0 && !U.notice_on);
    // A start the recorder refuses, ticked the same way, closes cleanly and the next begin is not blocked.
    pro_voice_close(); sender_done();
    REC.aborts = REC.aborts_quiet = 0; REC.refuse = true; STEPS_SEEN = 0; HOOK_ON = true;
    pro_voice_begin("a1");
    HOOK_ON = false;
    CHECK(!pro_voice_open() && !REC.active && REC.starts == 1);
    REC.refuse = false;
    pro_voice_begin("a1");
    CHECK(pro_voice_open() && REC.active && REC.starts == 2);
    // A link drop that lands while the recorder is starting must not leave the microphone streaming.
    pro_voice_close(); sender_done();
}
static void link_lost_mid_start_leaves_no_stream(void) {
    situation();
    HOOK_ON = false;
    REC.tick_inside = false;
    // Drop the link from inside pro_rec_start (the cable_link task against the touch task's begin).
    pro_test_in_start = pro_voice_link_lost;
    pro_voice_begin("a1");
    pro_test_in_start = NULL;
    CHECK(!pro_voice_open());
    CHECK(!REC.recording && REC.aborts >= 1);          // the stream that began mid-drop was aborted afterwards
}

int main(int argc, char **argv) {
    static const struct { const char *name; void (*run)(void); } tests[] = {
        {"in_roster", in_roster}, {"library_only", library_only}, {"roster_not_yet_refreshed", roster_not_yet_refreshed},
        {"booting", booting}, {"question_agent_says_why", question_agent_says_why},
        {"offline_machine_says_why", offline_machine_says_why}, {"busy_cable_says_why", busy_cable_says_why},
        {"library_only_after_message_view", library_only_after_message_view}, {"not_connected", not_connected},
        {"refused_start", refused_start}, {"send_and_reply", send_and_reply}, {"error_is_a_notice", error_is_a_notice},
        {"error_mid_recording", error_mid_recording}, {"unsend", unsend}, {"back_discards", back_discards},
        {"cap_and_reply_wait", cap_and_reply_wait}, {"recorder_died", recorder_died}, {"mic_never_opens", mic_never_opens},
        {"voice_link_drop_ends_talk", voice_link_drop_ends_talk},
        {"voice_link_drop_while_waiting", voice_link_drop_while_waiting}, {"talk_over_in_tick", talk_over_in_tick},
        {"begin_is_atomic_to_the_tick", begin_is_atomic_to_the_tick},
        {"link_lost_mid_start_leaves_no_stream", link_lost_mid_start_leaves_no_stream},
    };
    for (unsigned i = 0; i < sizeof tests / sizeof tests[0]; i++)
        if (argc == 1 || !strcmp(argv[1], tests[i].name)) { tests[i].run(); printf("PASS %s\n", tests[i].name); }
    return 0;
}
'''

# The gate's copy is the screen's: fixed here so a reword in pro_app.c shows up as a failing test, not a silent change.
COPY = {"offline_machine": "This computer is offline.", "busy_cable": "Still sending the last message",
        "not_connected": "Not connected", "library_only": "Link this computer in Harness."}


def check_sources():
    app = (APP / "pro_app.c").read_text()
    for key, text in COPY.items():
        assert f'"{text}"' in app, f"voice gate copy for {key} changed: {text!r}"
    src = (AUDIO / "pro_voice.c").read_text()
    assert "pro_app_lock" not in src and "pro_app_unlock" not in src, "pro_voice.c must never take pro_app's lock"


check_sources()
cc = os.environ.get("CC", "cc")
sanitize = "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds")
include = ["-I", str(APP), "-I", str(MAIN), "-I", str(DISP), "-I", str(HERE / "host_esp"),
           "-I", str(POD)]
failures = []
with tempfile.TemporaryDirectory(prefix="harness-pro-voice-") as directory:
    directory = Path(directory)
    fonts = directory / "pro_fonts.c"
    font_args = []
    if os.environ.get("PRO_FONT"):
        font = Path(os.environ["PRO_FONT"])
        font_args = ["--font", str(font if font.is_absolute() else FW / font)]
    subprocess.run([sys.executable, str(FW / "scripts" / "gen_fonts.py"), *font_args, "--out", str(fonts)], check=True)
    source = directory / "pro_voice_test.c"
    source.write_text(code)
    modules = sorted(POD.glob("*.c")) + sorted(POD.glob("*/*.c")) + [APP / "pod_glue.c", APP / "pro_app.c", APP / "pro_touch.c", AUDIO / "pro_voice.c", DISP / "scroll.c",
                                         DISP / "pro_canvas.c", DISP / "terminal.c", fonts]
    # The voice state machine runs on the touch, render and cable_link tasks: no frame past 1 KB.
    subprocess.run([cc, "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wframe-larger-than=1024", "-O1", "-DHT_FACE_PX=720",
                    "-DPRO_VOICE_TEST_HOOK", *include, "-c", str(AUDIO / "pro_voice.c"), "-o", os.devnull], check=True)
    executable = directory / "pro_voice_gate"
    subprocess.run([cc, "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-O1", "-g", sanitize,
                    "-DHT_FACE_PX=720", "-DPRO_VOICE_TEST_HOOK", *include, str(source), *map(str, modules), "-lpthread", "-o", str(executable)],
                   check=True)
    result = subprocess.run([str(executable)], text=True, capture_output=True)
    print(result.stdout.strip())
    if result.returncode:
        failures.append("voice gate")
        print(f"FAIL: {result.stderr.strip()}")
assert not failures, f"Pro voice regressions: {', '.join(failures)}"
print("Pro voice: production-handler replays passed")
