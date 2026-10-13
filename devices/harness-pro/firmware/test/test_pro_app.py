#!/usr/bin/env python3
"""Replay contacts and cable feeds through the Pro's app layer (main/app/pro_app.c, pod_glue.c, pro_touch.c) and Pod.

Ported from the round firmware's test_pod_touch_ui.py (every test keeps its name). The production glue, the app layer
and the finger task's contact rules are compiled here as they are, with Pod's views, the Pro canvas and the generated
fonts. Below pro_app the host plays the device: a fake clock, the cable and the recorder as recorders (every send
checks that pro_app's mutex is NOT held), and the GT911 whose contacts pro_display.c turns upright. The effects Pod
returns are performed by pro_app and read back from those recorders.
Also built with -DPOD_PANEL_TURN=180: a contact at (700, 700) on the controller's axes hits what (19, 19) hits upright,
and the turn is applied exactly once (see test_turn_is_applied_once). No USB, hardware writes or microphone.
"""
from pathlib import Path
import os
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
FW = HERE.parent
MAIN = FW / "main"
APP = MAIN / "app"
POD = MAIN / "pod"
DISP = MAIN / "display"

code = r'''

#include <assert.h>
#include <pthread.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "app/pro_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "app/pod_turn.h"
#include "cable/pro_cable.h"
#include "pro_app_api.h"
#include "pro_canvas.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"
#include "sys/ram_telemetry.h"
#include "pro_display.h"
#include "pro_frame.h"

#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

// pro_app owns the one Pod object; the replays read and feed it directly where SRC's did.
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
// ---- the host plays the parts the device has below pro_app ------------------------------------------------------
// The clock is `now`. The GT911 reports a contact on its own axes; pro_display.c's pro_touch_poll() turns it upright
// (once), which is what pod_turn_coord() states, and pro_touch_feed() hands it to pro_app_touch(). The cable and the
// recorder are recorders, and every send checks that pro_app's mutex is NOT held (nothing leaves under the lock).
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
size_t heap_caps_get_free_size(unsigned c) { (void)c; return 0; }
size_t heap_caps_get_largest_free_block(unsigned c) { (void)c; return 0; }
uint8_t config_load_brightness(void) { return 220; }
bool config_load_muted(void) { return true; }
static bool MUTED = false;   // the Sound setting the beep reads
static int BEEPS, READS;
static char READ_AGENT[ID_MAX], READ_TOKEN[64];
bool pro_settings_muted(void) { return MUTED; }
void audio_beep(void) { CHECK(LOCK_DEPTH == 0); BEEPS++; }
bool pro_cable_send_notif_read(const char *a, const char *t) { CHECK(LOCK_DEPTH == 0); READS++; snprintf(READ_AGENT, sizeof READ_AGENT, "%s", a); snprintf(READ_TOKEN, sizeof READ_TOKEN, "%s", t); return true; }
static bool WAS_UPDATED;   // fw_was_updated: this boot is the first of an update
bool fw_was_updated(char *version, size_t cap) { if (WAS_UPDATED) snprintf(version, cap, "0.1.0"); return WAS_UPDATED; }
void ram_telemetry_periodic(const char *tag) { (void)tag; }
void pro_frame_init(void) {}
uint32_t pro_frame_present(const ht_scene_t *p, const ht_scene_t *n) { (void)p; (void)n; return 0; }
void pro_display_set_brightness(uint8_t l) { (void)l; }
void pro_display_power(bool on) { (void)on; }
pro_touch_sample_t pro_touch_poll(int *x, int *y) { (void)x; (void)y; return PRO_TOUCH_NONE; }   // the task body only

static struct {   // what the last contact (or call) made the app send
    int opens, begins, end_send, end_abort, lib_fail_next;
    bool abort_was_pending;
    char open_id[ID_MAX];
} R;
static struct { bool open, pending, waiting, hold_pending, refuse; int lost; char agent[ID_MAX]; } V;
static struct { int n, offset[64]; uint32_t request[64]; bool ok, supported; } LIB = {.ok = true, .supported = true};
static struct { int n; ht_scroll_phase_t phase[64]; int dy[64], v[64]; } SC;

bool pro_cable_send_open(const char *id) { CHECK(LOCK_DEPTH == 0); R.opens++; snprintf(R.open_id, sizeof R.open_id, "%s", id); return true; }
bool pro_cable_send_scroll(pro_scroll_phase_t phase, int dy, int velocity) {
    CHECK(LOCK_DEPTH == 0);
    if (SC.n < 64) { SC.phase[SC.n] = (ht_scroll_phase_t)phase; SC.dy[SC.n] = dy; SC.v[SC.n] = velocity; SC.n++; }
    return true;
}
bool pro_cable_request_library(int offset, uint32_t request) {
    CHECK(LOCK_DEPTH == 0);
    if (LIB.n < 64) { LIB.offset[LIB.n] = offset; LIB.request[LIB.n] = request; LIB.n++; }
    return LIB.ok;
}
bool pro_cable_library_supported(void) { return LIB.supported; }
static bool GATE_IN_BEGIN;   // the race: an offer's gate lands while a voice start is between its gate check and its begin
void pro_voice_begin(const char *agent) {
    CHECK(LOCK_DEPTH == 0);
    if (GATE_IN_BEGIN) (void)pro_app_begin_update_gate();
    R.begins++;
    if (V.refuse) return;
    V.open = true; V.pending = true; V.waiting = false;
    snprintf(V.agent, sizeof V.agent, "%s", agent);
}
void pro_voice_end(bool send) {
    CHECK(LOCK_DEPTH == 0);
    if (send) { R.end_send++; V.waiting = true; }
    else { R.end_abort++; R.abort_was_pending = V.pending; V.open = V.pending = V.waiting = false; }
}
bool pro_voice_open(void) { return V.open; }
bool pro_voice_start_pending(void) { return V.pending; }
bool pro_voice_waiting(void) { return V.waiting; }
void pro_voice_close(void) { V.open = V.pending = V.waiting = false; }
void pro_voice_link_lost(void) { CHECK(LOCK_DEPTH == 0); V.lost++; V.open = V.pending = V.waiting = false; }
void pro_voice_tick(uint32_t t) { (void)t; }

static pro_touch_t TCH;
// What a performed effect looks like as the pod_out_t SRC's replays compare.
static pod_out_t effect_of(void) {
    pod_out_t o;
    memset(&o, 0, sizeof o);
    if (R.opens) { o.fx = POD_FX_AGENT_OPEN; snprintf(o.agent, sizeof o.agent, "%s", R.open_id); }
    else if (R.begins) { o.fx = POD_FX_VOICE_BEGIN; snprintf(o.agent, sizeof o.agent, "%s", V.agent); }
    else if (R.end_send) { o.fx = POD_FX_VOICE_END; snprintf(o.agent, sizeof o.agent, "%s", V.agent); }
    else if (R.end_abort) { o.fx = R.abort_was_pending ? POD_FX_VOICE_END : POD_FX_VOICE_ABORT; snprintf(o.agent, sizeof o.agent, "%s", V.agent); }
    return o;
}
// A contact on the controller's axes, through the finger task's rules into pro_app. The recorder "starts" (the
// async worker) once the contact returns, unless a test holds it back.
static pod_out_t contact(bool down, int x, int y, bool *changed) {
    now += 16;
    (void)pod_ui_take_changed(&U);
    (void)pro_app_test_take_dirty();
    memset(&R, 0, sizeof R);
    const int ux = pod_turn_coord(x), uy = pod_turn_coord(y);
    // The controller reports no position on a lift, so the task hands Pod the last held point. SRC's replays name a
    // lift point of their own (to test the tap's hit and slop), so those go to pro_app_touch directly.
    if (!down && TCH.prev && (ux != TCH.last_x || uy != TCH.last_y)) {
        CHECK(pro_app_touch(false, ux, uy));
        TCH.prev = false;
        if (!V.hold_pending) V.pending = false;
        *changed = pro_app_test_take_dirty();
        return effect_of();
    }
    pro_touch_feed(&TCH, down ? PRO_TOUCH_ONE : PRO_TOUCH_NONE, ux, uy);
    if (!V.hold_pending) V.pending = false;
    *changed = pro_app_test_take_dirty();
    CHECK(LOCK_DEPTH == 0);
    return effect_of();
}
// The same, for a point on the upright glass: the panel reports it turned when POD_PANEL_TURN=180.
static pod_out_t ucontact(bool down, int x, int y, bool *changed) {
    return contact(down, pod_turn_coord(x), pod_turn_coord(y), changed);
}
// A tap on the rendered hit: DOWN and UP at its centre, as the GT911 reports it, then the redraw a change causes.
static pod_out_t tap_at(int x, int y) {
    bool c1 = false, c2 = false;
    pod_out_t d = ucontact(true, x, y, &c1);
    CHECK(d.fx == POD_FX_NONE);
    pod_out_t u = ucontact(false, x, y, &c2);
    render();
    return u;
}
static pod_out_t tap(pod_action_t a, int arg) {
    const pod_hit_t *h = hit(a, arg);
    CHECK(h);
    CHECK(h->w >= 1 && h->h >= 1);
    return tap_at(h->x + h->w / 2, h->y + h->h / 2);
}
static void expect(pod_out_t o, pod_effect_t fx, const char *agent) {
    CHECK(o.fx == fx);
    if (agent) CHECK(!strcmp(o.agent, agent));
}

// Two tabs. Backend holds a1 (working) and a2 (done, with a recap); Frontend holds a3.
static const char *IDS0[] = {"a1", "a2"}, *IDS1[] = {"a3"};
static void setup(void) {
    pro_app_test_reset();
    memset(&V, 0, sizeof V);
    memset(&TCH, 0, sizeof TCH);
    memset(&R, 0, sizeof R);
    memset(&SC, 0, sizeof SC);
    LIB.n = 0; LIB.ok = true; LIB.supported = true;
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "mac"}, {"a2", "Bravo", "codex", "mac"}, {"a3", "Charlie", "claude", "mac"}};
    pod_ui_roster(&U, rows, 3);
    cable_swarm_t sw[2] = {{.agents = 2, .panes = 2}, {.agents = 1, .panes = 1}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    snprintf(sw[1].id, sizeof sw[1].id, "s1"); snprintf(sw[1].name, sizeof sw[1].name, "Frontend");
    static cable_swarm_members_t members;
    memset(&members, 0, sizeof members);
    members.count[0] = 2; snprintf(members.id[0][0], ID_MAX, "a1"); snprintf(members.id[0][1], ID_MAX, "a2");
    members.count[1] = 1; snprintf(members.id[1][0], ID_MAX, "a3");
    (void)IDS0; (void)IDS1;
    pod_ui_swarms(&U, sw, 2, &members, "s0", NULL, 0);
    pro_app_link(true, "mac");
    pod_ui_turn(&U, "a1", "started", "", 0, 500);
    pod_ui_turn(&U, "a1", "activity", "Reading files", 3, 600);
    pod_ui_turn(&U, "a2", "done", "", 0, 500);
    pod_ui_recap(&U, "a2", "Fixed the parser. Added two tests.", false);
    pod_ui_recap(&U, "a1", "Earlier it renamed the module.", true);
    render();
}

static void journey(void) {
    setup();
    CHECK(top() == POD_V_TABS);
    CHECK(U.frame.hit_count > 0 && U.frame.hit_count <= 32);
    // Backend is tab 0.
    CHECK(!strcmp(U.model.tabs[0].name, "Backend"));
    expect(tap(POD_A_OPEN_TAB, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB);
    // Row 1: the working agent, a1 (it opens on its Agent screen).
    expect(tap(POD_A_OPEN_AGENT, 0), POD_FX_AGENT_OPEN, "a1");
    CHECK(top() == POD_V_AGENT && !strcmp(U.nav.stack[U.nav.depth - 1].agent, "a1"));
    CHECK(U.nav.depth == 3);
    CHECK(!pod_ui_talking(&U));
    // The triangle: begin a recording for a1.
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");
    CHECK(top() == POD_V_TALK && pod_ui_talking(&U));
    // The square: send it; the voice screen stays up, sending, until the agent's turn begins.
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_END, "a1");
    CHECK(top() == POD_V_TALK && U.nav.sending);
    pod_model_turn(&U.model, "a1", "started", NULL, 0, 5000);
    pod_nav_sync(&U.nav, &U.model);
    CHECK(top() == POD_V_AGENT && !pod_ui_talking(&U));
    // NEXT steps to a2, which is done and opens on its Recap.
    expect(tap(POD_A_NEXT, 0), POD_FX_AGENT_OPEN, "a2");
    CHECK(top() == POD_V_RECAP);
    // Back out: Tab, then Tabs.
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB && U.nav.depth == 2);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    // Nothing was left recording, and a sync after all this has nothing to abort.
    pod_out_t again = pod_ui_link(&U, true);
    CHECK(again.fx == POD_FX_NONE);
}

static void to_talk(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");
    CHECK(top() == POD_V_TALK);
}

static void tabs_button_from_everywhere(void) {
    to_talk();
    expect(tap(POD_A_TABS, 0), POD_FX_VOICE_ABORT, "a1");     // from Talking: abort, then the root
    CHECK(top() == POD_V_TABS && U.nav.depth == 1 && !pod_ui_talking(&U));
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 1);                                   // a2: done, opens on its Recap
    CHECK(top() == POD_V_RECAP);
    expect(tap(POD_A_PANES, 0), POD_FX_NONE, NULL);           // PANES: the tab's list
    CHECK(top() == POD_V_TAB && U.nav.depth == 2);
    tap(POD_A_OPEN_AGENT, 0);
    expect(tap(POD_A_TABS, 0), POD_FX_NONE, NULL);            // TABS from an Agent screen
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    CHECK(hit(POD_A_RECAP, 0) == NULL);
    // PANES from Talking aborts and lands on the tab's list
    tap(POD_A_OPEN_TAB, 0); tap(POD_A_OPEN_AGENT, 0); tap(POD_A_TALK, 0);
    expect(tap(POD_A_PANES, 0), POD_FX_VOICE_ABORT, "a1");
    CHECK(top() == POD_V_TAB && U.nav.depth == 2);
}

// A recap longer than the space scrolls with a vertical drag, one wrapped line per step; a short one does not.
static void recap_drag_scrolls(void) {
    setup();
    char big[900] = "";
    for (int i = 1; i <= 30; i++) { char s[40]; snprintf(s, sizeof s, "Sentence-%02d-wide-token ", i); strcat(big, s); }   // 30 words (the cap is 50), a row each
    pod_ui_recap(&U, "a2", big, false);
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 1);
    CHECK(top() == POD_V_RECAP);
    CHECK(pod_scroll_max(&U.nav, &U.model) > 0 && pod_scroll_pitch(&U.nav) == ht_pro_32.height);
    CHECK(U.nav.stack[U.nav.depth - 1].scroll == 0);
    bool c = false;
    ucontact(true, 360, 450, &c);
    ucontact(true, 360, 450 - 2 * ht_pro_32.height, &c);
    CHECK(c && U.nav.stack[U.nav.depth - 1].scroll == 2);
    ucontact(false, 360, 450 - 2 * ht_pro_32.height, &c);
    CHECK(U.nav.stack[U.nav.depth - 1].scroll == 2 && top() == POD_V_RECAP);   // a drag is not a tap
    ucontact(true, 360, 100, &c); ucontact(true, 360, 100 + 10 * ht_pro_32.height, &c); ucontact(false, 360, 100, &c);
    CHECK(U.nav.stack[U.nav.depth - 1].scroll == 0);
}


// ---- the horizontal swipe steps panes (swipe left = next, right = previous, as the round dial) -------------------------
// A drag from (x0,y0) to (x1,y1) in n MOVEs of 16 ms each, then the lift. Returns the effect of the lift.
static pod_out_t drag(int x0, int y0, int x1, int y1, int n) {
    bool c = false;
    ucontact(true, x0, y0, &c);
    for (int i = 1; i <= n; i++) ucontact(true, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, &c);
    pod_out_t o = ucontact(false, x1, y1, &c);
    render();
    return o;
}
static const char *cur(void) { return U.nav.stack[U.nav.depth - 1].agent; }
static void to_agent(int row) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, row);
}
static void swipe_steps_panes(void) {
    to_agent(0);
    CHECK(top() == POD_V_AGENT && !strcmp(cur(), "a1"));
    expect(drag(500, 300, 300, 310, 8), POD_FX_AGENT_OPEN, "a2");      // finger right-to-left: next
    CHECK(!strcmp(cur(), "a2") && U.nav.depth == 3);
    expect(drag(200, 300, 520, 290, 8), POD_FX_AGENT_OPEN, "a1");      // left-to-right: previous
    CHECK(!strcmp(cur(), "a1") && top() == POD_V_AGENT);
    // a Recap steps too, and a quick flick shorter in time counts
    tap(POD_A_NEXT, 0);
    CHECK(top() == POD_V_RECAP);
    expect(drag(520, 400, 300, 400, 3), POD_FX_AGENT_OPEN, "a1");
}
static void swipe_slow_does_nothing(void) {
    to_agent(0);
    expect(drag(520, 300, 300, 300, 60), POD_FX_NONE, NULL);           // ~1 s and slow all along
    CHECK(!strcmp(cur(), "a1"));
    // a tap still works
    expect(tap(POD_A_NEXT, 0), POD_FX_AGENT_OPEN, "a2");
}
static void swipe_short_and_diagonal(void) {
    to_agent(0);
    expect(drag(500, 300, 450, 300, 4), POD_FX_NONE, NULL);
    expect(drag(500, 300, 360, 420, 6), POD_FX_NONE, NULL);
    expect(drag(500, 200, 400, 340, 6), POD_FX_NONE, NULL);
    CHECK(!strcmp(cur(), "a1") && top() == POD_V_AGENT);
    expect(drag(500, 300, 300, 300, 8), POD_FX_AGENT_OPEN, "a2");      // the same gesture, wide enough
}
static void swipe_in_talking_aborts_first(void) {
    to_talk();
    expect(drag(500, 300, 300, 300, 8), POD_FX_VOICE_ABORT, "a1");
    CHECK(!pod_ui_talking(&U) && !strcmp(cur(), "a2"));
    CHECK(pod_ui_link(&U, true).fx == POD_FX_NONE);
}
static void swipe_from_the_transport_is_ignored(void) {
    to_agent(0);
    int y = POD_TRANSPORT_Y + 60;
    expect(drag(560, y, 160, y, 8), POD_FX_NONE, NULL);
    CHECK(!strcmp(cur(), "a1"));
    to_talk();
    expect(drag(560, y, 160, y, 8), POD_FX_NONE, NULL);
    CHECK(pod_ui_talking(&U));
}
static void swipe_on_tabs_and_tab_does_nothing(void) {
    setup();
    expect(drag(560, 300, 160, 300, 8), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    tap(POD_A_OPEN_TAB, 0);
    expect(drag(560, 300, 160, 300, 8), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB && U.nav.depth == 2);
}
static void swipe_does_not_scroll_the_recap(void) {
    setup();
    char big[900] = "";
    for (int i = 1; i <= 30; i++) { char s[40]; snprintf(s, sizeof s, "Sentence-%02d-wide-token ", i); strcat(big, s); }
    pod_ui_recap(&U, "a2", big, false);
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 1);
    CHECK(top() == POD_V_RECAP && pod_scroll_max(&U.nav, &U.model) > 0);
    // a wide swipe with some vertical wobble: no rows scrolled, a swipe not a scroll
    expect(drag(520, 300, 300, 340, 8), POD_FX_AGENT_OPEN, "a1");
    CHECK(U.nav.stack[U.nav.depth - 1].scroll == 0);
    tap(POD_A_NEXT, 0);
    CHECK(U.nav.stack[U.nav.depth - 1].scroll == 0);
    // the vertical drag still scrolls
    bool c = false;
    ucontact(true, 360, 450, &c);
    ucontact(true, 360, 450 - 2 * ht_pro_32.height, &c);
    CHECK(c && U.nav.stack[U.nav.depth - 1].scroll == 2);
    pod_out_t o = ucontact(false, 360, 450 - 2 * ht_pro_32.height, &c);
    CHECK(o.fx == POD_FX_NONE && U.nav.stack[U.nav.depth - 1].scroll == 2 && top() == POD_V_RECAP);
}

static void next_from_talking_aborts(void) {
    to_talk();
    pod_out_t o = tap(POD_A_NEXT, 0);
    expect(o, POD_FX_VOICE_ABORT, "a1");          // never VOICE_END, and not AGENT_OPEN
    CHECK(top() == POD_V_AGENT || top() == POD_V_RECAP);
    CHECK(!strcmp(U.nav.stack[U.nav.depth - 1].agent, "a2"));
    CHECK(!pod_ui_talking(&U));
    // Exactly once: nothing else asks for it afterwards.
    CHECK(pod_ui_link(&U, true).fx == POD_FX_NONE);
}

static void prev_and_back_from_talking_abort(void) {
    to_talk();
    expect(tap(POD_A_PREV, 0), POD_FX_VOICE_ABORT, "a1");
    CHECK(!pod_ui_talking(&U));
    to_talk();
    expect(tap(POD_A_BACK, 0), POD_FX_VOICE_ABORT, "a1");
    CHECK(top() == POD_V_TAB);
    to_talk();
    // The agent leaves the roster while talking: sync pops Talking and asks for the abort, once.
    pod_roster_row_t rows[] = {{"a2", "Bravo", "codex", "mac"}, {"a3", "Charlie", "claude", "mac"}};
    expect(pod_ui_roster(&U, rows, 2), POD_FX_VOICE_ABORT, "a1");
    CHECK(!pod_ui_talking(&U));
    CHECK(pod_ui_link(&U, true).fx == POD_FX_NONE);
}

static void talk_over_leaves_quietly(void) {
    to_talk();
    pod_ui_talk_over(&U);                 // a refused start or an ended recording
    CHECK(!pod_ui_talking(&U) && top() == POD_V_AGENT && U.nav.depth == 3);   // M10: back on the Agent screen
    CHECK(pod_ui_link(&U, true).fx == POD_FX_NONE);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);        // a later back is an ordinary back: no abort
    CHECK(top() == POD_V_TAB);
}

// M10: the link drops while talking: the stack stays; the recording is over (the app ends it without a cancel on a dead
// cable), so the tick leaves Talking for the screen it came from.
static void link_drop_keeps_the_stack(void) {
    to_talk();
    CHECK(V.open);
    pro_app_link(false, NULL);
    CHECK(V.lost == 1 && !V.open);
    pro_app_tick();
    CHECK(U.nav.depth == 3 && top() == POD_V_AGENT && !pod_ui_talking(&U));
    pro_app_link(true, "mac");
    CHECK(U.nav.depth == 3 && !strcmp(U.nav.stack[2].agent, "a1"));
}

// M11a: SEND while the recorder was still starting sends nothing: no send scene, "Not sent", on the Agent screen.
// pro_app performs the VOICE_END itself: it cancels the start and tells Pod.
static void send_before_recorder_started(void) {
    to_talk();
    V.hold_pending = true; V.pending = true;               // the recorder is still starting
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_END, "a1");
    CHECK(R.end_abort == 1 && R.end_send == 0);            // the start was cancelled, nothing was sent
    CHECK(U.nav.sent_agent[0] == 0 && !U.nav.sending);
    CHECK(top() == POD_V_AGENT && U.notice_on && !strcmp(U.notice, "Not sent"));
    render();
    CHECK(S.count <= HT_RUNS);
}

// M11b: the 600 s cap stops the recording and the message is on its way: Talking is left for the Agent screen,
// so a later back is a plain back (no abort of the message already sent).
static void cap_leaves_talking(void) {
    to_talk();
    pod_ui_talk_over(&U);
    CHECK(top() == POD_V_AGENT);
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3 && !pod_ui_talking(&U));
}

// LOW: a hit names its agent; the list may have reordered before the tap lands.
static void tap_resolves_by_id(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);                                 // Backend: a1, a2
    const pod_hit_t *h = hit(POD_A_OPEN_AGENT, 0);
    CHECK(h && !strcmp(h->id, "a1"));
    int cx = h->x + h->w / 2, cy = h->y + h->h / 2;
    bool c;
    ucontact(true, cx, cy, &c);
    static cable_swarm_t sw[2];                             // the members swap places before the finger lifts
    memset(sw, 0, sizeof sw);
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend"); sw[0].panes = sw[0].agents = 2;
    snprintf(sw[1].id, sizeof sw[1].id, "s1"); snprintf(sw[1].name, sizeof sw[1].name, "Frontend"); sw[1].panes = sw[1].agents = 1;
    static cable_swarm_members_t mem;
    memset(&mem, 0, sizeof mem);
    mem.count[0] = 2; snprintf(mem.id[0][0], ID_MAX, "a2"); snprintf(mem.id[0][1], ID_MAX, "a1");
    mem.count[1] = 1; snprintf(mem.id[1][0], ID_MAX, "a3");
    pod_ui_swarms(&U, sw, 2, &mem, "s0", NULL, 0);
    pod_out_t o = ucontact(false, cx, cy, &c);
    expect(o, POD_FX_AGENT_OPEN, "a1");
    // and a tab that is gone opens nothing
    setup();
    render();
    h = hit(POD_A_OPEN_TAB, 1);                             // Frontend's cover
    CHECK(h && !strcmp(h->id, "s1"));
    cx = h->x + h->w / 2; cy = h->y + h->h / 2;
    ucontact(true, cx, cy, &c);
    pod_ui_swarms(&U, sw, 1, &mem, "s0", NULL, 0);          // Frontend closes
    ucontact(false, cx, cy, &c);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    render();
    CHECK(hit(POD_A_OPEN_TAB, 0) != NULL && hit(POD_A_OPEN_TAB, 1) == NULL);   // the grid is the tab that is left
}

static bool utf8_ok(const char *s) {
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        int n = *p < 0x80 ? 0 : (*p >> 5) == 6 ? 1 : (*p >> 4) == 14 ? 2 : (*p >> 3) == 30 ? 3 : -1;
        if (n < 0) return false;
        p++;
        while (n--) { if ((*p & 0xC0) != 0x80) return false; p++; }
    }
    return true;
}

// LOW: the notice (80 bytes) and the two lines the views build are cut on a codepoint boundary.
static void utf8_cuts(void) {
    setup();
    char long_text[200];
    long_text[0] = 0;
    for (int i = 0; i < 60; i++) strcat(long_text, "\xc4\x91");   // 2-byte codepoints: an odd cut would split one
    pod_ui_notice(&U, long_text, now);
    CHECK(utf8_ok(U.notice) && strlen(U.notice) < sizeof U.notice);
    char sub[96] = "";
    snprintf(sub, sizeof sub, "%s", "ab\xe2\x80\xa2\xe2\x80");
    pod_utf8_trim(sub);
    CHECK(utf8_ok(sub) && !strcmp(sub, "ab\xe2\x80\xa2"));
}

// M7: now_ms wraps. The sweep clock and the elapsed clock use signed differences.
static void clock_wrap(void) {
    setup();
    pod_ui_sweep_begin(&U, 0x10u);
    CHECK(!pod_ui_sweep_due(&U, 0xFFFFFFF0u));            // 0xFFFFFFF0 is before 0x10 on the wrapped clock
    pod_ui_sweep_abort(&U);
    pod_agent_t a;
    memset(&a, 0, sizeof a);
    a.state = POD_WORKING; a.elapsed_s = 5; a.event_ms = 0xFFFFFFF0u;
    CHECK(pod_agent_secs(&a, 0xFFFFFFF0u + 70000u) == 75);
    CHECK(pod_agent_secs(&a, 0xFFFFFFE0u) == 5);          // a clock behind the event: no huge elapsed
}

// LOW: the equaliser moves faster than once a second while an agent is working on the Tab screen; the Tabs grid wakes every
// 300 ms (the Playing ribbon's bars) only while a ribbon shows, else once a second; the 16 ms animation takes precedence.
static void equaliser_wakes_fast(void) {
    setup();                                              // a1 is working
    now = 1100;
    CHECK(pod_ui_wake_ms(&U, now) == 300 - now % 300);    // on Tabs with a ribbon (a1 works in Backend): the bars step every 300 ms
    CHECK(pod_ui_clock_tick(&U, now));
    CHECK(!pod_ui_clock_tick(&U, now + 20));
    CHECK(pod_ui_clock_tick(&U, now + 200));              // the next bar step
    tap(POD_A_OPEN_TAB, 0);
    CHECK(pod_ui_wake_ms(&U, now) <= 150);
    CHECK(pod_ui_clock_tick(&U, now));
    CHECK(!pod_ui_clock_tick(&U, now + 20));
    CHECK(pod_ui_clock_tick(&U, now + 160));
    pro_app_test_reset();                                       // nothing working: once a second
    pod_ui_link(&U, true);
    CHECK(pod_ui_wake_ms(&U, 1100) == 900);
}

// Eight tabs: nine covers in the grid (three rows of three, offsets 0..1), the selected tab t0 the second.
static void many_tabs(void) {
    setup();
    static cable_swarm_t sw[8];
    memset(sw, 0, sizeof sw);
    for (int i = 0; i < 8; i++) { snprintf(sw[i].id, sizeof sw[i].id, "t%d", i); snprintf(sw[i].name, sizeof sw[i].name, "Tab %d", i); sw[i].panes = 1; }
    pod_ui_swarms(&U, sw, 8, NULL, "t0", NULL, 0);
    render();
}

// Tab screen: scroll counts rows, the glue turns finger travel into rows (half a row of travel steps one) and clamps.
static void drag_scrolls_tab_and_is_not_a_tap(void) {
    bool c;
    {
        setup();
        static pod_roster_row_t rows[8];
        static char ids[8][8];
        for (int i = 0; i < 8; i++) { snprintf(ids[i], 8, "r%d", i); rows[i] = (pod_roster_row_t){ids[i], "Agent", "claude", "mac"}; }
        pod_ui_roster(&U, rows, 8);
        static cable_swarm_t one[1];
        static cable_swarm_members_t mem;
        memset(one, 0, sizeof one); memset(&mem, 0, sizeof mem);
        snprintf(one[0].id, sizeof one[0].id, "t0"); snprintf(one[0].name, sizeof one[0].name, "Big");
        one[0].panes = one[0].agents = 8; mem.count[0] = 8;
        for (int i = 0; i < 8; i++) snprintf(mem.id[0][i], ID_MAX, "r%d", i);
        pod_ui_swarms(&U, one, 1, &mem, "t0", NULL, 0);
        render();
        tap(POD_A_OPEN_TAB, 0);
        CHECK(top() == POD_V_TAB && pod_scroll_pitch(&U.nav) == 84 && pod_scroll_max(&U.nav, &U.model) == 1);   // seven rows fit under the status bar
        ucontact(true, 360, 600, &c);
        ucontact(true, 360, 500, &c);                   // 100 px: one row
        CHECK(c && U.nav.stack[U.nav.depth - 1].scroll == 1);
        ucontact(true, 360, 0, &c);                     // clamped at 8 - 7
        CHECK(U.nav.stack[U.nav.depth - 1].scroll == 1);
        ucontact(false, 360, 0, &c);
        render();
        CHECK(hit(POD_A_OPEN_AGENT, 1) != NULL && hit(POD_A_OPEN_AGENT, 7) != NULL && hit(POD_A_OPEN_AGENT, 0) == NULL);
    }
}

// ---- the Tabs grid: pages of two rows, the grid follows the finger and settles onto a page --------------------------------
static int shown_off(void) { return U.frame.tabs_moving ? U.frame.tabs_off : U.nav.stack[0].scroll / 2 * pod_tabs_pitch(); }
// Run the settling clock to its end: every step is a wake of at most 16 ms, a redraw, an offset between where it was and
// where it goes; at the end the grid is on the page exactly and nothing wakes faster than the clock's second any more.
static int settle(int dir /* +1: offset grows, -1 falls */, int target) {
    int prev = shown_off(), steps = 0;
    uint32_t t0 = now;
    while (U.pg_mode == POD_PG_ANIM) {
        uint32_t w = pod_ui_wake_ms(&U, now);
        CHECK(w >= 1 && w <= 16 && steps < 20);
        now += w;
        CHECK(pod_ui_clock_tick(&U, now));
        render();
        int o = shown_off();
        CHECK((o - prev) * dir >= 0 && (o - target) * dir <= 0);   // monotonic, no overshoot
        prev = o; steps++;
    }
    CHECK(steps == 0 || (now - t0 >= 150 && now - t0 <= 186 + 16));   // 170 ms, 16 ms steps
    CHECK(!U.frame.tabs_moving && shown_off() == target);
    CHECK(pod_ui_wake_ms(&U, now) == 1000 - now % 1000 || pod_ui_wake_ms(&U, now) == 300 - now % 300);   // a ribbon on the page or not
    return steps;
}
static void grid_drag(int dy, int holds) {   // DOWN at y 600, the move in four steps of 16 ms, then `holds` more contacts there
    bool c;
    ucontact(true, 360, 600, &c);
    for (int k = 1; k <= 4; k++) ucontact(true, 360, 600 + dy * k / 4, &c);
    for (int k = 0; k < holds; k++) ucontact(true, 360, 600 + dy, &c);
}

static void drag_follows_and_snaps(void) {
    many_tabs();                                        // nine covers: two pages
    CHECK(pod_scroll_pitch(&U.nav) == 560 && pod_scroll_max(&U.nav, &U.model) == 2);
    CHECK(U.frame.hit_count == 6 && hit(POD_A_OPEN_TAB, 4) != NULL && hit(POD_A_OPEN_TAB, 5) == NULL && !U.frame.tabs_moving);
    bool c;
    ucontact(true, 360, 600, &c);
    ucontact(true, 360, 590, &c);                       // 10 px: still a tap
    CHECK(!c); render(); CHECK(!U.frame.tabs_moving);
    ucontact(true, 360, 480, &c);                       // 120 px up: the grid follows, pixel for pixel
    CHECK(c); render(); CHECK(U.frame.tabs_moving && U.frame.tabs_off == 120);
    ucontact(true, 360, 300, &c);
    render(); CHECK(U.frame.tabs_off == 300);
    CHECK(U.nav.stack[0].scroll == 0);                  // the resting page changes at the release
    CHECK(hit(POD_A_OPEN_TAB, 5) != NULL && hit(POD_A_OPEN_TAB, 2) != NULL && U.frame.hit_count <= 32);   // both pages, tappable
    for (int i = 0; i < U.frame.hit_count; i++) CHECK(U.frame.hits[i].y >= 54 && U.frame.hits[i].y + U.frame.hits[i].h <= 720);
    CHECK(S.count <= HT_RUNS);
    ucontact(true, 360, 280, &c); render(); CHECK(U.frame.tabs_off == 320);   // follows on, dy = -320
    for (int k = 0; k < 8; k++) ucontact(true, 360, 280, &c);   // the finger rests: no flick
    ucontact(false, 360, 280, &c);
    CHECK(c && U.nav.stack[0].scroll == 2 && top() == POD_V_TABS && U.nav.depth == 1);   // past the middle: page 1, a drag is not a tap
    render();
    int steps = settle(+1, 560);
    CHECK(steps >= 5);
    render();
    CHECK(hit(POD_A_OPEN_TAB, 0) == NULL && hit(POD_A_OPEN_TAB, 5) != NULL && hit(POD_A_OPEN_TAB, 5)->y == 104 && hit(POD_A_OPEN_TAB, 7) != NULL);
    // Back down, slowly, less than half a page: it returns to page 1.
    grid_drag(200, 8);                                  // the finger down 200 px: offset 360
    render(); CHECK(U.frame.tabs_off == 560 - 200);
    ucontact(false, 360, 800, &c);
    CHECK(U.nav.stack[0].scroll == 2);
    render(); settle(+1, 560);
    // More than half down: page 0.
    grid_drag(300, 8);
    ucontact(false, 360, 900, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(-1, 0);
    // A short drag, nothing under half a page, slow: stays.
    grid_drag(-100, 8);
    ucontact(false, 360, 500, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(-1, 0);
}

static void flick_turns_the_page(void) {
    many_tabs();
    bool c;
    grid_drag(-40, 0);                                  // 40 px in 64 ms, finger still moving: 0.6 px/ms, well over 0.3
    ucontact(false, 360, 560, &c);
    CHECK(U.nav.stack[0].scroll == 2);                  // the next page though it is only 40 px away
    render(); settle(+1, 560);
    grid_drag(60, 0);                                   // a flick down: back to page 0
    ucontact(false, 360, 660, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(-1, 0);
    grid_drag(60, 0);                                   // a flick down on the first page: nothing before it
    render(); CHECK(U.frame.tabs_moving && U.frame.tabs_off == -20);   // pulled 60 px: a third of it
    ucontact(false, 360, 660, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(+1, 0);                            // back up to 0
    // A drag to page 1 and back the other way fast: the flick wins, the page it left is where it goes.
    grid_drag(-400, 8);                                 // offset 400, the finger at rest
    ucontact(true, 360, 220, &c); ucontact(true, 360, 260, &c);   // ... then 40 px down in 16 ms, 2.5 px/ms
    ucontact(false, 360, 260, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(-1, 0);
    // A stale flick does not count: the finger rested 120 ms.
    grid_drag(-40, 0);
    now += 120;
    ucontact(false, 360, 560, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(-1, 0);
}

static void drag_is_not_a_tap_and_a_tap_is(void) {
    many_tabs();
    bool c;
    const pod_hit_t *h = hit(POD_A_OPEN_TAB, 1);
    int x = h->x + h->w / 2, y = h->y + h->h / 2;
    ucontact(true, x, y, &c);
    ucontact(true, x, y + 20, &c);                      // 20 px: a tap
    ucontact(false, x, y, &c);
    render();
    CHECK(top() == POD_V_TAB && U.pg_mode == POD_PG_IDLE);   // opened, nothing animated
    tap(POD_A_BACK, 0);
    h = hit(POD_A_OPEN_TAB, 1);
    y = h->y + h->h / 2;
    ucontact(true, x, y, &c);
    ucontact(true, x, y - 30, &c);                      // 30 px: a drag, and it ends over the cover
    ucontact(true, x, y, &c);
    ucontact(false, x, y, &c);
    render();
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);     // a drag never opens a cover
    CHECK(U.pg_mode == POD_PG_IDLE);                    // it ended where it began: nothing moves, nothing animates
    settle(-1, 0);
    ucontact(true, 500, 400, &c);                       // a horizontal stroke does nothing
    ucontact(true, 300, 400, &c);
    ucontact(false, 300, 400, &c);
    CHECK(U.nav.stack[0].scroll == 0 && U.nav.depth == 1 && U.pg_mode == POD_PG_IDLE);
}

static void grid_ends_rubber_band(void) {
    many_tabs();
    bool c;
    grid_drag(150, 8);                                  // pulled down on the first page
    render(); CHECK(U.frame.tabs_moving && U.frame.tabs_off == -50);   // a third of the pull
    ucontact(true, 360, 1050, &c);                      // far: 450 -> -150
    render(); CHECK(U.frame.tabs_off == -150);
    for (int k = 0; k < 8; k++) ucontact(true, 360, 1050, &c);
    ucontact(false, 360, 1050, &c);
    CHECK(U.nav.stack[0].scroll == 0);
    render(); settle(+1, 0);                       // back up to 0, exactly
    pod_nav_act(&U.nav, &U.model, POD_A_SCROLL, 2, now);   // the last page
    render();
    grid_drag(-300, 8);                                 // pulled up past the last page: 560 + 300 / 3
    render(); CHECK(U.frame.tabs_off == 660);
    ucontact(false, 360, 300, &c);
    CHECK(U.nav.stack[0].scroll == 2);
    render(); settle(-1, 560);
}

static void grid_caught_while_settling(void) {
    many_tabs();
    bool c;
    grid_drag(-40, 0);                                  // a flick to page 1
    ucontact(false, 360, 560, &c);
    render();
    now += 48; render();
    int mid = shown_off();
    CHECK(mid > 40 && mid < 560 && U.pg_mode == POD_PG_ANIM);
    const pod_hit_t *h = hit(POD_A_OPEN_TAB, 1);
    int x = h ? h->x + 10 : 100, y = h ? h->y + 10 : 200;
    ucontact(true, x, y, &c);                           // a touch on the moving grid stops it where it is
    render();
    int held = shown_off();
    CHECK(U.pg_mode == POD_PG_DRAG && held >= mid && held < 560);
    now += 100; render();
    CHECK(shown_off() == held);
    ucontact(false, x, y, &c);                          // and lifting it again settles, without opening what is under it
    CHECK(top() == POD_V_TABS && U.nav.depth == 1 && U.nav.stack[0].scroll == (held > 280 ? 2 : 0));
    render();
    settle(held > 280 ? +1 : -1, held > 280 ? 560 : 0);
    // A cancelled contact (the touch driver lost it) settles too.
    pod_nav_act(&U.nav, &U.model, POD_A_SCROLL, -2, now); render();   // page 0
    grid_drag(-400, 8);
    pro_app_touch_cancel();
    CHECK(U.nav.stack[0].scroll == 2 && U.pg_mode == POD_PG_ANIM);
    render(); settle(+1, 560);
    // The screen changes under a settling grid: it ends, nothing keeps waking.
    grid_drag(60, 0);   // from page 1
    ucontact(false, 360, 660, &c);
    CHECK(U.pg_mode == POD_PG_ANIM);
    pod_ui_link(&U, true);
    U.nav.depth = 2; U.nav.stack[1] = U.nav.stack[0]; U.nav.stack[1].view = POD_V_TAB;
    render();
    CHECK(U.pg_mode == POD_PG_IDLE && !U.frame.tabs_moving);
}

static void one_page_does_not_move(void) {
    setup(); render();                                  // two tabs: three covers, one page
    bool c;
    const pod_hit_t *h = hit(POD_A_OPEN_TAB, 0);
    int x = h->x + h->w / 2, y = h->y + h->h / 2;
    ucontact(true, x, y, &c);
    ucontact(true, x, y - 100, &c);
    render();
    CHECK(!U.frame.tabs_moving && U.pg_mode == POD_PG_IDLE);
    ucontact(false, x, y, &c);
    CHECK(U.nav.depth == 1 && U.nav.stack[0].scroll == 0);   // still not a tap
}

// A tap on a cover opens its tab (Recent included, by POD_TAB_RECENT; a tab by its id), also after a scroll.
static void tap_cover_opens_tab(void) {
    many_tabs();
    expect(tap(POD_A_OPEN_TAB, POD_TAB_RECENT), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB && U.nav.stack[U.nav.depth - 1].tab == POD_TAB_RECENT);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    expect(tap(POD_A_OPEN_TAB, 2), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB && !strcmp(U.nav.stack[U.nav.depth - 1].tab_id, "t2"));
    tap(POD_A_BACK, 0);
    pod_nav_act(&U.nav, &U.model, POD_A_SCROLL, 2, now);   // the second page of covers
    render();
    expect(tap(POD_A_OPEN_TAB, 6), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB && !strcmp(U.nav.stack[U.nav.depth - 1].tab_id, "t6"));
    tap(POD_A_BACK, 0);
    CHECK(U.nav.stack[0].scroll == 2);                  // the grid is where it was left
    // A slow slide off the cover is not a tap either.
    render();
    const pod_hit_t *h = hit(POD_A_OPEN_TAB, 6);
    CHECK(h);
    bool c;
    ucontact(true, h->x + 5, h->y + 5, &c);
    ucontact(true, h->x + 5 + 30, h->y + 5, &c);
    ucontact(false, h->x + 5 + 30, h->y + 5, &c);
    CHECK(top() == POD_V_TABS);
    // A tab inserted before it, by the feed: the tap resolves its id, not the index drawn.
    static cable_swarm_t more[9];
    memset(more, 0, sizeof more);
    snprintf(more[0].id, sizeof more[0].id, "new"); snprintf(more[0].name, sizeof more[0].name, "Newest"); more[0].panes = 1;
    for (int i = 0; i < 8; i++) { snprintf(more[i + 1].id, sizeof more[i + 1].id, "t%d", i); snprintf(more[i + 1].name, sizeof more[i + 1].name, "Tab %d", i); more[i + 1].panes = 1; }
    h = hit(POD_A_OPEN_TAB, 6);
    int cx = h->x + h->w / 2, cy = h->y + h->h / 2;
    ucontact(true, cx, cy, &c);
    pod_ui_swarms(&U, more, 9, NULL, "t0", NULL, 0);
    ucontact(false, cx, cy, &c);
    CHECK(top() == POD_V_TAB && !strcmp(U.nav.stack[U.nav.depth - 1].tab_id, "t6") && U.nav.stack[U.nav.depth - 1].tab == 7);
}

static void release_off_the_hit_cancels(void) {
    setup();
    bool c;
    const pod_hit_t *h = hit(POD_A_OPEN_TAB, 0);
    CHECK(h);
    ucontact(true, h->x + 5, h->y + 5, &c);
    pod_out_t o = ucontact(false, h->x + 5, h->y + h->h + 3, &c);   // inside the slop, outside the hit
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_TABS);
    pro_app_touch_cancel();
    ucontact(true, h->x + 5, h->y + 5, &c);
    pro_app_touch_cancel();
    o = ucontact(false, h->x + 5, h->y + 5, &c);
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_TABS);        // a cancelled contact never taps
}

static void panel_turn(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    CHECK(top() == POD_V_TAB);
    // (19, 19) is inside the ‹ back hit. Upright, (700, 700) is not; turned 180, a contact there is (19, 19).
    bool c;
    contact(true, 700, 700, &c);
    pod_out_t o = contact(false, 700, 700, &c);
    (void)o;
#ifdef POD_PANEL_TURN
    CHECK(top() == POD_V_TABS);                         // the turned contact hit BACK
    CHECK(pod_turn_coord(700) == 19 && pod_turn_coord(19) == 700);
#else
    CHECK(top() == POD_V_TAB);                          // upright, it hits nothing
    contact(true, 19, 19, &c);
    contact(false, 19, 19, &c);
    CHECK(top() == POD_V_TABS);                         // while (19, 19) is BACK
    CHECK(pod_turn_coord(700) == 700);
#endif
}

// Wake rate on the paged grid: 300 ms while a ribbon shows on the resting page, 1000 ms without one, 16 ms while it drags or snaps.
static void ribbon_wakes(void) {
    many_tabs();                                          // nine covers; a1 works, Recent (page 0) counts it, page 1 has no working agent
    now = 5000;
    CHECK(pod_ui_wake_ms(&U, now) == 300 - now % 300);
    bool c;
    ucontact(true, 360, 600, &c);
    ucontact(true, 360, 480, &c);                         // dragging: the glue renders per move, the clock stays at its slow unit
    CHECK(U.pg_mode == POD_PG_DRAG && pod_ui_wake_ms(&U, now) == 1000 - now % 1000);
    ucontact(true, 360, 280, &c);
    for (int k = 0; k < 8; k++) ucontact(true, 360, 280, &c);
    ucontact(false, 360, 280, &c);
    CHECK(U.nav.stack[0].scroll == 2);
    CHECK(U.pg_mode == POD_PG_ANIM && pod_ui_wake_ms(&U, now) <= 16);   // the snap's 16 ms steps win over the bars
    render();
    settle(+1, 560);
    CHECK(U.nav.stack[0].scroll == 2 && U.pg_mode == POD_PG_IDLE);
    CHECK(pod_ui_wake_ms(&U, now) == 1000 - now % 1000);  // page 1: no ribbon, once a second
    CHECK(pod_ui_clock_tick(&U, now + 1000) && !pod_ui_clock_tick(&U, now + 1001));
    pro_app_test_reset();                                      // not linked: nothing to wake for but the second
    CHECK(pod_ui_wake_ms(&U, 1100) == 900);
}

static void pet_clock(void) {
    setup();
    CHECK(!pod_ui_pet_on_screen(&U));
    CHECK(pod_ui_wake_ms(&U, 1250) == 300 - 1250 % 300);     // a1 is working: a ribbon on Tabs, the bars step
    tap(POD_A_OPEN_TAB, 0);
    CHECK(pod_ui_wake_ms(&U, 1250) == 150 - 1250 % 150);     // the Tab screen's equaliser ticks at 150 ms
    tap(POD_A_OPEN_AGENT, 0);
    CHECK(pod_ui_pet_on_screen(&U));
    CHECK(pod_ui_wake_ms(&U, 1250) >= 1 && pod_ui_wake_ms(&U, 1250) <= POD_PET_STEP_MS);   // a1 works: the LCD bars move every frame
    CHECK(pod_ui_clock_tick(&U, 5000));
    CHECK(!pod_ui_clock_tick(&U, 5001));
    CHECK(pod_ui_clock_tick(&U, 5000 + POD_PET_STEP_MS));
    pod_ui_link(&U, false);
    CHECK(!pod_ui_pet_on_screen(&U));                       // "Connecting…" has no pet
}

// Wake at the pet's next step, but never later than another animation on the screen needs.
static void pet_wakes_at_next_step(void) {
    pro_app_test_reset();
    pod_roster_row_t rows[] = {{"m1", "Muse", "muse", "mac"}, {"c1", "Codex", "codex", "mac"}, {"x1", "Cursor", "cursor", "mac"}};
    pod_ui_roster(&U, rows, 3);
    pro_app_link(true, "mac");
    now = 5000;
    pod_ui_focus(&U, "m1", now);
    CHECK(top() == POD_V_AGENT && pod_ui_pet_on_screen(&U));
    render();
    for (uint32_t t = now; t < now + 600; t += 7) {              // an idle muse rests: a step is 46-217 ms, not every frame
        uint32_t w = pod_ui_wake_ms(&U, t);
        CHECK(w >= 1 && w <= 217);
    }
    CHECK(pod_ui_wake_ms(&U, now) > POD_PET_STEP_MS || pod_ui_wake_ms(&U, now + 50) > POD_PET_STEP_MS);
    for (uint32_t t = now; t < now + 3000; t += 11) {            // the wake is the redraw: due exactly at t + wake, not before
        uint32_t w = pod_ui_wake_ms(&U, t);
        (void)pod_ui_clock_tick(&U, t);
        CHECK(!pod_ui_clock_tick(&U, t + w - 1));
        CHECK(pod_ui_clock_tick(&U, t + w));
        t += w;
    }
    pod_ui_turn(&U, "m1", "started", "", 0, now);                // working: the LCD pill's bars move every frame
    for (uint32_t t = now + 1; t < now + 800; t += 5) CHECK(pod_ui_wake_ms(&U, t) <= POD_PET_STEP_MS);
    pod_ui_turn(&U, "m1", "done", "", 0, now + 900);
    pod_ui_focus(&U, "c1", now + 1000);                          // Codex listening draws bars in code: every frame
    expect(pod_nav_act(&U.nav, &U.model, POD_A_TALK, 0, now + 1000), POD_FX_VOICE_BEGIN, "c1");
    CHECK(top() == POD_V_TALK);
    CHECK(pod_ui_wake_ms(&U, now + 1234) == POD_PET_STEP_MS - (now + 1234) % POD_PET_STEP_MS || pod_ui_wake_ms(&U, now + 1234) <= POD_PET_STEP_MS);
    for (uint32_t t = now + 1100; t < now + 1400; t += 3) CHECK(pod_ui_wake_ms(&U, t) <= POD_PET_STEP_MS);
    pod_ui_talk_over(&U);
    pod_ui_focus(&U, "x1", now + 3000);                          // an engine with no pet, idle: a still logo, the second beat
    CHECK(pod_ui_wake_ms(&U, now + 3001) == 999);
    pod_ui_notice(&U, "Not sent", now + 3500);                   // a notice clears on time, not at the next beat
    CHECK(pod_ui_wake_ms(&U, now + 3500 + 2950) == 50);
    pod_ui_focus(&U, "m1", now + 9000);                          // and on a pet screen too
    pod_ui_notice(&U, "Not sent", now + 9000);
    CHECK(pod_ui_wake_ms(&U, now + 9000 + 2995) <= 5);
}

static void roster_after_swarms_rebuilds_tabs(void) {
    // The swarm frame can land before the roster: the tabs follow when the agents arrive.
    pro_app_test_reset();
    cable_swarm_t sw[1] = {{.agents = 1, .panes = 1}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    static cable_swarm_members_t members;
    memset(&members, 0, sizeof members);
    members.count[0] = 1; snprintf(members.id[0][0], ID_MAX, "a1");
    pod_ui_swarms(&U, sw, 1, &members, "s0", NULL, 0);
    CHECK(U.model.tabs[0].agent[0] == -1);
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "mac"}};
    pod_ui_roster(&U, rows, 1);
    CHECK(U.model.tabs[0].agent[0] == 0);
    // An older daemon: no members at all. The tab still counts its agents.
    pod_ui_swarms(&U, sw, 1, NULL, "s0", NULL, 0);
    CHECK(!U.model.tabs[0].members_known && U.model.tabs[0].count == 1);
    CHECK(pod_ui_take_changed(&U));
    CHECK(!pod_ui_take_changed(&U));
}


// Glue replay: an agent open on its Recap that starts working is on its Agent screen after the feed, and the render's
// own flip call (every frame) does not undo it. Same stack depth, no effect.
static void recap_flips_to_agent_when_work_starts(void) {
    setup();
    expect(tap(POD_A_OPEN_TAB, 0), POD_FX_NONE, NULL);
    expect(tap(POD_A_OPEN_AGENT, 1), POD_FX_AGENT_OPEN, "a2");     // done, with a recap
    CHECK(top() == POD_V_RECAP && U.nav.depth == 3);
    pod_out_t o = pod_ui_turn(&U, "a2", "started", "", 0, now + 100);
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_AGENT && U.nav.depth == 3);
    render();
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);
    pod_ui_turn(&U, "a2", "done", "", 0, now + 200);
    render();
    CHECK(top() == POD_V_RECAP);                                    // and back when it finishes
}


// Moving an agent in the window (swap two panes, or hand one to another tab) changes who sits where and nothing else.
// Each frame must reach the model as a change, and the same frame twice must not.
static void moved_agent_reaches_the_model(void) {
    pro_app_test_reset();
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "mac"}, {"a2", "Bravo", "codex", "mac"}, {"a3", "Charlie", "claude", "mac"}};
    pod_ui_roster(&U, rows, 3);
    cable_swarm_t sw[2] = {{.agents = 2, .panes = 2}, {.agents = 1, .panes = 1}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    snprintf(sw[1].id, sizeof sw[1].id, "s1"); snprintf(sw[1].name, sizeof sw[1].name, "Frontend");
    static cable_swarm_members_t m;
    memset(&m, 0, sizeof m);
    m.count[0] = 2; snprintf(m.id[0][0], ID_MAX, "a1"); snprintf(m.id[0][1], ID_MAX, "a2");
    m.count[1] = 1; snprintf(m.id[1][0], ID_MAX, "a3");
    cable_tile_t t[2] = {{0, 0, 500, 1000, "a1"}, {500, 0, 1000, 1000, "a2"}};
    pod_ui_swarms(&U, sw, 2, &m, "s0", t, 2);
    CHECK(pod_ui_take_changed(&U));
    pod_ui_swarms(&U, sw, 2, &m, "s0", t, 2);
    CHECK(!pod_ui_take_changed(&U));                         // the same frame: nothing to redraw
    // Swap the two panes: same tab, same counts, same rectangles.
    snprintf(t[0].agent_id, ID_MAX, "a2"); snprintf(t[1].agent_id, ID_MAX, "a1");
    snprintf(m.id[0][0], ID_MAX, "a2"); snprintf(m.id[0][1], ID_MAX, "a1");
    uint32_t rev = U.model.revision;
    pod_ui_swarms(&U, sw, 2, &m, "s0", t, 2);
    CHECK(U.model.revision != rev && pod_ui_take_changed(&U));
    CHECK(U.model.tabs[0].agent[0] == 1 && U.model.tabs[0].agent[1] == 0);
    // Move a2 to the other tab: both tabs' members change, the selected tab keeps its count of one.
    m.count[0] = 1; snprintf(m.id[0][0], ID_MAX, "a1");
    m.count[1] = 2; snprintf(m.id[1][0], ID_MAX, "a3"); snprintf(m.id[1][1], ID_MAX, "a2");
    sw[0].agents = sw[0].panes = 1; sw[1].agents = sw[1].panes = 2;
    pod_ui_swarms(&U, sw, 2, &m, "s1", NULL, 0);
    CHECK(pod_ui_take_changed(&U));
    CHECK(U.model.tabs[1].count == 2 && U.model.tabs[0].count == 1);
    // Only the order of a non-selected tab's members changes (no tiles for it): still a change.
    snprintf(m.id[1][0], ID_MAX, "a2"); snprintf(m.id[1][1], ID_MAX, "a3");
    pod_ui_swarms(&U, sw, 2, &m, "s0", t, 1);
    pod_ui_take_changed(&U);
    snprintf(m.id[1][0], ID_MAX, "a3"); snprintf(m.id[1][1], ID_MAX, "a2");
    pod_ui_swarms(&U, sw, 2, &m, "s0", t, 1);
    CHECK(pod_ui_take_changed(&U));
}

// Tab B's agents are only in the library: the roster (agents.*) holds tab A's.
static void library_fills_other_tabs(void) {
    pro_app_test_reset();
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "mac"}, {"a2", "Bravo", "codex", "mac"}};
    pod_ui_roster(&U, rows, 2);
    cable_swarm_t sw[2] = {{.agents = 2, .panes = 2}, {.agents = 2, .panes = 2}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    snprintf(sw[1].id, sizeof sw[1].id, "s1"); snprintf(sw[1].name, sizeof sw[1].name, "Frontend");
    static cable_swarm_members_t members;
    memset(&members, 0, sizeof members);
    members.count[0] = 2; snprintf(members.id[0][0], ID_MAX, "a1"); snprintf(members.id[0][1], ID_MAX, "a2");
    members.count[1] = 2; snprintf(members.id[1][0], ID_MAX, "b1"); snprintf(members.id[1][1], ID_MAX, "b2");
    pod_ui_swarms(&U, sw, 2, &members, "s0", NULL, 0);
    pod_ui_link(&U, true);
    CHECK(pod_ui_sweep_due(&U, 1000));                   // link up starts a sweep
    pod_ui_sweep_begin(&U, 1000);
    CHECK(pod_ui_sweeping(&U) && !pod_ui_sweep_due(&U, 2000));
    // 8 sessions, two pages of 6 (the second is clamped to offset 2 by the daemon).
    pod_library_row_t p0[] = {
        {"a1", "Alpha", "claude", "Mac", "working", 4}, {"a2", "Bravo", "codex", "Mac", "idle", 90},
        {"b1", "Delta", "gemini", "Box", "working", 3}, {"b2", "Echo", "codex", "Box", "question", 8},
        {"c1", "Other", "claude", "Box", "idle", 500}, {"c2", "Other2", "claude", "Box", "idle", 600}};
    pod_out_t fx;
    int next = pod_ui_library_page(&U, p0, 6, 0, 8, 2000, &fx);
    CHECK(next == 6 && fx.fx == POD_FX_NONE && pod_ui_sweeping(&U));
    pod_library_row_t p1[] = {
        {"b1", "Delta", "gemini", "Box", "working", 3}, {"b2", "Echo", "codex", "Box", "question", 8},
        {"c1", "Other", "claude", "Box", "idle", 500}, {"c2", "Other2", "claude", "Box", "idle", 600},
        {"c3", "Other3", "claude", "Box", "idle", 700}, {"c4", "Other4", "claude", "Box", "idle", 800}};
    next = pod_ui_library_page(&U, p1, 6, 2, 8, 2100, &fx);
    CHECK(next == -1 && !pod_ui_sweeping(&U));
    // The agent already working at link time reads WORKING after the first page; tab B lists its agents.
    CHECK(pod_model_state(&U.model, pod_model_find(&U.model, "a1"), 2100) == POD_WORKING);
    render();
    tap(POD_A_OPEN_TAB, 1);                              // Frontend
    CHECK(top() == POD_V_TAB);
    const pod_agent_t *l[8];
    int n = pod_nav_list(&U.nav, &U.model, l, 8);
    CHECK(n == 2);
    CHECK(!strcmp(l[0]->name, "Delta") && !strcmp(l[0]->engine, "gemini") && !strcmp(l[0]->machine, "Box"));
    CHECK(!strcmp(l[1]->name, "Echo") && !strcmp(l[1]->engine, "codex"));
    CHECK(pod_model_state(&U.model, l[0], 2200) == POD_WORKING && pod_model_state(&U.model, l[1], 2200) == POD_ASKING);
    expect(tap(POD_A_OPEN_AGENT, 1), POD_FX_AGENT_OPEN, "b2");
    // A later sweep that no longer lists b2 drops it, and the open agent's screen pops to its tab.
    pod_ui_sweep_begin(&U, 40000);
    pod_out_t gone;
    next = pod_ui_library_page(&U, p0, 3, 0, 3, 40100, &gone);   // a1, a2, b1 only
    CHECK(next == -1 && !pod_model_find(&U.model, "b2") && top() == POD_V_TAB);
    CHECK(gone.fx == POD_FX_NONE);
}

static void sweep_schedule(void) {
    pro_app_test_reset();
    CHECK(!pod_ui_sweep_due(&U, 0));                       // not linked
    pod_ui_link(&U, true);
    CHECK(pod_ui_sweep_due(&U, 100));
    pod_ui_sweep_begin(&U, 100);
    pod_library_row_t r[] = {{"a1", "A", "claude", "", "idle", 1}};
    pod_out_t fx;
    CHECK(pod_ui_library_page(&U, r, 1, 0, 1, 150, &fx) == -1);
    CHECK(!pod_ui_sweep_due(&U, 20000));                   // quiet until 30 s after the start
    CHECK(pod_ui_sweep_due(&U, 100 + POD_SWEEP_MS));
    pod_ui_sweep_begin(&U, 100 + POD_SWEEP_MS);
    CHECK(!pod_ui_sweep_due(&U, 100 + POD_SWEEP_MS + 1));
    CHECK(pod_ui_sweep_due(&U, 100 + 2 * POD_SWEEP_MS + 1));   // a stalled sweep starts over
    pod_ui_link(&U, false);                                // the link drops: abandoned, no end
    CHECK(!pod_ui_sweeping(&U) && !pod_ui_sweep_due(&U, 900000));
    pod_ui_link(&U, true);
    CHECK(pod_ui_sweep_due(&U, 900001));
    pod_ui_sweep_begin(&U, 900001);
    pod_ui_library_page(&U, r, 1, 0, 1, 900002, &fx);
    // The swarms changing asks for another.
    cable_swarm_t sw[1] = {{.agents = 1, .panes = 1}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0");
    CHECK(!pod_ui_sweep_due(&U, 900100));
    pod_ui_swarms(&U, sw, 1, NULL, "s0", NULL, 0);
    CHECK(pod_ui_sweep_due(&U, 900200));
    pod_ui_sweep_begin(&U, 900200);
    pod_ui_library_page(&U, r, 1, 0, 1, 900210, &fx);
    pod_ui_swarms(&U, sw, 1, NULL, "s0", NULL, 0);        // the same frame again: nothing to look up
    CHECK(!pod_ui_sweep_due(&U, 900300));
    // A page that does not move on ends the walk instead of looping.
    pod_ui_sweep_begin(&U, 910000);
    CHECK(pod_ui_library_page(&U, r, 1, 0, 50, 910001, &fx) == 1);
    CHECK(pod_ui_library_page(&U, r, 1, 0, 50, 910002, &fx) == -1 && !pod_ui_sweeping(&U));
}

enum { K_TEXT = 1, K_RECT = 2 };
static void notice_shows_three_seconds(void) {
    setup();
    int base;
    render();
    base = S.count;
    pod_ui_notice(&U, "Still sending the last message", now);
    CHECK(pod_ui_take_changed(&U));
    render();
    CHECK(S.count == base + 2);                           // the pill and its line
    // The pill sits just above the transport bar, centred: it never covers the agent's name or the art above y = 300.
    for (int i = base; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        int h = r->pro_kind == K_TEXT ? ht_pro_24.height : 40;
        CHECK(r->y >= 300 && r->y + h <= POD_TRANSPORT_Y);
    }
    CHECK(S.runs[base].pro_kind == K_RECT && S.runs[base].y + 40 < POD_TRANSPORT_Y && abs(S.runs[base].x * 2 + S.runs[base].w - 720) <= 1);
    now += 2900; render();
    CHECK(S.count == base + 2);
    now += 200; render();
    CHECK(S.count == base);                               // gone after 3 s
    CHECK(S.count <= HT_RUNS);
}

// Every pro_app callback runs on the device's cable_link task: a 6 KB stack. The render task has 24 KB. This runs the
// exact on-device sequence (link up, empty roster, empty swarms, library pages, then populated feeds) through the real
// callbacks on a small painted stack with a guard below it, and fails if they touch more than the budget (a ~10 KB local
// also faults on the guard, as the device did: "Stack protection fault"). The draw then runs on the main stack, as the
// render task does.
static cable_swarm_t CS[SWARMS_MAX];
static cable_swarm_members_t CM;
static cable_tile_t CT[SWARM_TILES_MAX];
static pro_agent_row_t CA[POD_AGENTS_MAX];
static char CIDS[POD_AGENTS_MAX][ID_MAX];
static void *cable_task(void *arg) {
    (void)arg;
    pro_app_test_reset();
    pro_app_link(true, "mac");
    pro_app_agents(NULL, 0);
    pro_app_swarms(NULL, 0, NULL, NULL, NULL, 0);
    pro_app_tick();                                          // the sweep begins and asks for offset 0
    pro_library_row_t lib[6] = {
        {"a1", "Alpha", "claude", "mac", "working", 5}, {"a2", "Bravo", "codex", "mac", "finished", 60},
        {"a3", "Charlie", "claude", "mac", "question", 9}, {"a4", "Delta", "codex", "pc", "idle", -1},
        {"a5", "Echo", "claude", "pc", "failed", 3}, {"a6", "Foxtrot", "claude", "pc", "paused", 70},
    };
    pro_app_library(lib, 6, 0, 6);
    pro_app_library(lib, 6, 0, 6);                           // rows outside a sweep
    // Populated: 24 tabs, each with members, and 24 tiles on the selected one.
    memset(CS, 0, sizeof CS); memset(&CM, 0, sizeof CM); memset(CT, 0, sizeof CT);
    for (int i = 0; i < SWARMS_MAX; i++) {
        snprintf(CS[i].id, sizeof CS[i].id, "s%d", i); snprintf(CS[i].name, sizeof CS[i].name, "Tab %d", i);
        CS[i].agents = CS[i].panes = 6;
        CM.count[i] = 6;
        for (int k = 0; k < 6; k++) snprintf(CM.id[i][k], ID_MAX, "a%d", k + 1);
    }
    for (int k = 0; k < SWARM_TILES_MAX; k++) { CT[k].x2 = 100; CT[k].y2 = 100; snprintf(CT[k].agent_id, sizeof CT[k].agent_id, "a%d", k % 6 + 1); }
    pro_app_swarms(CS, SWARMS_MAX, &CM, "s3", CT, SWARM_TILES_MAX);
    for (int n = 0; n < POD_AGENTS_MAX; n++) {
        snprintf(CIDS[n], ID_MAX, "a%d", n + 1);
        CA[n] = (pro_agent_row_t){CIDS[n], "Agent", "claude", "m1", "mac"};
    }
    pro_app_agents(CA, POD_AGENTS_MAX);
    pro_app_agents(NULL, 0);
    pro_app_agents(CA, POD_AGENTS_MAX);
    pro_app_turn("a1", "started", "Thinking...", 0);
    pro_app_turn("a1", "verb", "Reading...", -1);
    pro_app_turn("a1", "activity", "Reading files", 3);
    pro_app_turn("a1", "step", "Read - pod_model.c", -1);
    pro_app_question("a3", "Which branch?");
    pro_app_question_close("a3");
    pro_app_summary("a2", "Fixed the parser.", "Fixed the parser. Added two tests.", "Fixed the parser. Added two tests. Then more.", false, false);
    pro_app_focus("a4");
    pro_app_turn("a1", "done", "", 0);
    pro_app_swarms(NULL, 0, NULL, NULL, NULL, 0);
    (void)pro_app_voice_block_reason("a1");
    return NULL;
}

#define STACK_BYTES 16384   // the smallest stack pthreads accept everywhere (macOS refuses less)
#define CABLE_STACK_BUDGET 3584   // of the device's 6 KB: the rest is the cable_link task's own parse and dispatch frames
static void *idle_task(void *arg) { (void)arg; return NULL; }
// Run fn on a fresh STACK_BYTES stack painted with 0xA5; return the bytes it touched (the high-water mark).
// The stack is mmap'd with a PROT_NONE page below it, so running past the 16 KB faults like the device's guard does.
static size_t stack_used(void *(*fn)(void *)) {
    size_t pg = (size_t)sysconf(_SC_PAGESIZE);
    size_t guard = pg < STACK_BYTES ? STACK_BYTES : pg;
    unsigned char *m = mmap(NULL, guard + STACK_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    CHECK(m != MAP_FAILED);
    CHECK(mprotect(m, guard, PROT_NONE) == 0);
    unsigned char *stk = m + guard;
    memset(stk, 0xA5, STACK_BYTES);
    pthread_attr_t attr;
    CHECK(pthread_attr_init(&attr) == 0);
    CHECK(pthread_attr_setstack(&attr, stk, STACK_BYTES) == 0);
    pthread_t th;
    CHECK(pthread_create(&th, &attr, fn, NULL) == 0);
    CHECK(pthread_join(th, NULL) == 0);
    size_t low = 0;
    while (low < STACK_BYTES && stk[low] == 0xA5) low++;
    munmap(m, guard + STACK_BYTES);
    return STACK_BYTES - low;
}

static void small_cable_stack(void) {
    size_t base = stack_used(idle_task);   // what the thread itself puts on it (TLS, start frames)
    size_t used = stack_used(cable_task) - base;
    printf("cable_link callbacks used %zu bytes of stack (budget %d)\n", used, CABLE_STACK_BUDGET);
    CHECK(used <= CABLE_STACK_BUDGET);
    render();
    CHECK(S.count <= HT_RUNS);
}

// ---- following the host's focus -------------------------------------------------------------------------------
static const pod_frame_t *frame_at(int i) { return &U.nav.stack[i]; }

static void follow_from_tabs(void) {
    setup();
    CHECK(!pod_ui_take_changed(&U));
    pod_out_t o = pod_ui_focus(&U, "a2", now);
    CHECK(o.fx == POD_FX_NONE);
    CHECK(pod_ui_take_changed(&U));
    CHECK(U.nav.depth == 3 && frame_at(0)->view == POD_V_TABS && frame_at(1)->view == POD_V_TAB && frame_at(1)->tab == 0);
    CHECK(top() == POD_V_RECAP && !strcmp(frame_at(2)->agent, "a2"));   // done, with a recap
    render();
    CHECK(top() == POD_V_RECAP && U.nav.depth == 3);
    // Back goes to the tab's list, then Tabs.
    tap(POD_A_PANES, 0);
    CHECK(top() == POD_V_TAB);
    // The working agent opens on its Agent screen, in the other tab's list.
    now += 10000;
    pod_ui_focus(&U, "a3", now);
    CHECK(U.nav.depth == 3 && frame_at(1)->tab == 1 && !strcmp(frame_at(1)->tab_id, "s1") && !strcmp(frame_at(2)->agent, "a3"));
    pod_ui_focus(&U, "a1", now);
    CHECK(top() == POD_V_AGENT && frame_at(1)->tab == 0);
}

// The real cable cadence for a working agent (dial log 2026-10-10 15:08-15:09): every ~5 s the daemon's heartbeat
// sends turn.started(text) then turn.activity(text, action), then at once turn.activity with NO text (no terminal
// footer); between heartbeats an empty turn.activity every ~3 s. pro_cable turns those into pro_app_turn calls
// (verb, activity, step) and pro_app into these pod feeds. The Agent screen's body must not change between them.
static void activity_text_is_stable_through_the_real_cadence(void) {
    setup();
    const uint32_t saved_now = now;
    now = 10000;
    pod_ui_focus(&U, "a1", now);
    CHECK(top() == POD_V_AGENT);
    pro_app_turn("a1", "started", "", 0);
    pro_app_turn("a1", "activity", "Reading files", 0);
    render();
    static ht_scene_t base;
    memcpy(&base, &S, sizeof base);
    for (int beat = 0; beat < 12; beat++) {
        now += 3000 + (beat & 1) * 2000;   // 3 s refresh ticks and 5 s heartbeats
        const pod_agent_t *a = pod_model_find(&U.model, "a1");
        if (beat & 1) {   // heartbeat: started text (no new turn), its action, then the empty footer read
            pro_app_turn("a1", "activity", "Reading files", (int)a->elapsed_s);
            pro_app_turn("a1", "activity", "Reading files", (int)a->elapsed_s + 1);
        }
        pro_app_turn("a1", "verb", "", -1);                                 // event(): empty footer text
        pro_app_turn("a1", "activity", "", (int)a->elapsed_s);              // elapsedSeconds only: no action
        CHECK(top() == POD_V_AGENT && !strcmp(a->activity, "Reading files"));
        render();
        // Same clock: the text runs are the same pixels. (The LCD time and equaliser change with `now`, so compare
        // the frame at the same instant against a frame of the earlier feeds.)
        static ht_scene_t again;
        memcpy(&again, &S, sizeof again);
        pro_app_turn("a1", "activity", "", (int)a->elapsed_s);
        render();
        CHECK(!memcmp(&again, &S, sizeof again));
    }
    (void)base;
    now = saved_now;
}

static void follow_from_another_agent(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    expect(tap(POD_A_OPEN_AGENT, 0), POD_FX_AGENT_OPEN, "a1");
    CHECK(!strcmp(frame_at(2)->agent, "a1"));
    now += 5000;
    pod_out_t o = pod_ui_focus(&U, "a2", now);
    CHECK(o.fx == POD_FX_NONE && U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a2") && top() == POD_V_RECAP);
    CHECK(!pod_ui_talking(&U));
}

static void follow_same_agent_is_a_no_op(void) {
    setup();
    pod_ui_focus(&U, "a1", now);
    CHECK(pod_ui_take_changed(&U) && top() == POD_V_AGENT);
    pod_ui_focus(&U, "a1", now + 50);
    CHECK(!pod_ui_take_changed(&U) && U.nav.depth == 3);
    // An open Recap on a working agent still flips by the usual rules.
    pod_ui_focus(&U, "a2", now + 100);
    CHECK(top() == POD_V_RECAP);
    (void)pod_ui_take_changed(&U);
    pod_ui_focus(&U, "a2", now + 150);
    CHECK(!pod_ui_take_changed(&U));
    pod_ui_turn(&U, "a2", "started", "", 0, now + 200);
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);
}

static void follow_ignored_while_talking(void) {
    setup();
    now += 5000;
    pod_ui_focus(&U, "a1", now);
    pod_out_t o = pod_nav_act(&U.nav, &U.model, POD_A_TALK, 0, now);
    expect(o, POD_FX_VOICE_BEGIN, "a1");
    CHECK(pod_ui_talking(&U));
    (void)pod_ui_take_changed(&U);
    o = pod_ui_focus(&U, "a2", now + 100);
    CHECK(o.fx == POD_FX_NONE && pod_ui_talking(&U) && !strcmp(frame_at(2)->agent, "a1") && !pod_ui_take_changed(&U));
    pod_ui_talk_over(&U);
    now += 6000;
    pod_ui_focus(&U, "a2", now);   // it was dropped, not kept: only a new focus moves it
    CHECK(top() == POD_V_RECAP && !strcmp(frame_at(2)->agent, "a2"));
}

static void follow_waits_out_the_users_touch(void) {
    setup();
    now += 5000;
    tap(POD_A_OPEN_TAB, 0);
    CHECK(top() == POD_V_TAB);
    (void)pod_ui_take_changed(&U);
    pod_out_t o = pod_ui_focus(&U, "a2", now + 100);   // 4 s have not passed since the touch
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_TAB && U.nav.depth == 2 && !pod_ui_take_changed(&U));
    o = pod_ui_focus(&U, "a2", now + 3900);
    CHECK(top() == POD_V_TAB);
    now += 4200;
    pod_ui_focus(&U, "a2", now);
    CHECK(top() == POD_V_RECAP && U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a2"));
    // A finger that is still down is driving too.
    bool c;
    now += 10000;
    ucontact(true, 360, 360, &c);
    now += 5000;
    pod_ui_focus(&U, "a1", now);
    CHECK(!strcmp(frame_at(2)->agent, "a2"));
    pro_app_touch_cancel();
}

static void follow_pends_until_the_agent_arrives(void) {
    setup();
    now += 5000;
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "mac"}, {"a2", "Bravo", "codex", "mac"}, {"a3", "Charlie", "claude", "mac"},
                               {"a9", "Zeta", "codex", "mac"}};
    pod_ui_focus(&U, "a9", now);
    CHECK(U.nav.depth == 1 && !pod_ui_take_changed(&U));
    pod_ui_turn(&U, "a1", "activity", "x", 1, now + 2000);    // other feeds do not apply it
    CHECK(U.nav.depth == 1);
    pod_out_t o = pod_ui_roster(&U, rows, 4);                 // arrives within 5 s
    CHECK(o.fx == POD_FX_NONE && U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a9") && frame_at(1)->tab == POD_TAB_RECENT);
    // One that arrives too late is dropped.
    pod_ui_roster(&U, rows, 3);
    CHECK(U.nav.depth == 2);        // the agent went: back on the tab's list
    now += 10000;
    pod_ui_focus(&U, "a9", now);
    pod_ui_turn(&U, "a1", "activity", "y", 2, now + 6000);
    pod_ui_roster(&U, rows, 4);
    CHECK(!pod_ui_take_changed(&U) || strcmp(U.nav.stack[U.nav.depth - 1].agent, "a9"));
    CHECK(U.nav.depth < 3 || strcmp(U.nav.stack[U.nav.depth - 1].agent, "a9"));
}


// ---- item 6: ONE focus from the desktop app on the Tabs screen must move the device --------------------------
// The replays below put the real feeds in the order the app/daemon produce them (followApp: agents list, then
// `focus`; the app may switch its selected tab in the same moment, so a swarms push and roster feeds follow).
static cable_swarm_members_t FM;
static void feed_swarms(const char *selected, const cable_tile_t *tiles, int ntiles) {
    cable_swarm_t sw[2] = {{.agents = 2, .panes = 2}, {.agents = 1, .panes = 1}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    snprintf(sw[1].id, sizeof sw[1].id, "s1"); snprintf(sw[1].name, sizeof sw[1].name, "Frontend");
    memset(&FM, 0, sizeof FM);
    FM.count[0] = 2; snprintf(FM.id[0][0], ID_MAX, "a1"); snprintf(FM.id[0][1], ID_MAX, "a2");
    FM.count[1] = 1; snprintf(FM.id[1][0], ID_MAX, "a3");
    pod_ui_swarms(&U, sw, 2, &FM, selected, tiles, ntiles);
}
static void feed_roster_of_tab(int tab) {   // agents.* is the window's tab
    pod_roster_row_t r0[] = {{"a1", "Alpha", "claude", "mac"}, {"a2", "Bravo", "codex", "mac"}};
    pod_roster_row_t r1[] = {{"a3", "Charlie", "claude", "mac"}};
    if (tab == 0) pod_ui_roster(&U, r0, 2); else pod_ui_roster(&U, r1, 1);
}
static void library_all(void) {
    pod_library_row_t rows[] = {{"a1", "Alpha", "claude", "mac", "working", 5}, {"a2", "Bravo", "codex", "mac", "finished", 50},
                                {"a3", "Charlie", "claude", "mac", "idle", 70}};
    pod_ui_sweep_begin(&U, now);
    pod_ui_library_page(&U, rows, 3, 0, 3, now, NULL);
}

// The user got to the Tabs screen with a tap (the transport's Tabs button) and went to the desktop app: the focus that
// follows a few seconds later is not "the user driving the device".
static void follow_first_focus_after_opening_tabs_by_tap(void) {
    setup();
    now += 5000;
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    CHECK(U.nav.depth == 3);
    tap(POD_A_TABS, 0);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    now += 1500;                                  // the hand moved to the mouse
    pod_ui_focus(&U, "a2", now);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a2"));
}
// The same while a finger is on the glass or the grid is being dragged: that still waits.
static void follow_waits_for_a_finger_on_tabs(void) {
    setup();
    now += 5000;
    bool c;
    ucontact(true, 360, 360, &c);
    pod_ui_focus(&U, "a2", now + 100);
    CHECK(U.nav.depth == 1);
    pro_app_touch_cancel();
}
// A focus for an agent of a tab that is not the window's: the app then switches tab (swarms, roster) right after.
static void follow_other_tab_then_the_app_switches(void) {
    setup();
    library_all();
    now += 5000;
    pod_ui_focus(&U, "a3", now);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3") && frame_at(1)->tab == 1);
    // the app's tab switch: swarms with s1 selected (tiles absent, then present), the roster of s1
    feed_swarms("s1", NULL, 0);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3"));
    feed_roster_of_tab(1);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3"));
    cable_tile_t t[1] = {{.x1 = 0, .y1 = 0, .x2 = 1000, .y2 = 1000}};
    snprintf(t[0].agent_id, sizeof t[0].agent_id, "a3");
    feed_swarms("s1", t, 1);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3"));
    render();
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3"));
}
// The same without the library having listed the agent first: the roster feed brings it.
static void follow_other_tab_agent_only_in_the_new_roster(void) {
    setup();
    now += 5000;
    pod_ui_focus(&U, "a3", now);                  // unknown: pending
    feed_swarms("s1", NULL, 0);
    feed_roster_of_tab(1);                        // the window's tab is now s1: a3 arrives (a1, a2 leave the roster)
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3"));
    cable_tile_t t[1] = {{.x1 = 0, .y1 = 0, .x2 = 1000, .y2 = 1000}};
    snprintf(t[0].agent_id, sizeof t[0].agent_id, "a3");
    feed_swarms("s1", t, 1);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3"));
}
// The selected tab switches first (swarms), then the focus for an agent of the new tab.
static void follow_after_the_switch(void) {
    setup();
    library_all();
    now += 5000;
    feed_swarms("s1", NULL, 0);
    feed_roster_of_tab(1);
    pod_ui_focus(&U, "a3", now);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a3") && frame_at(1)->tab == 1);
    // and back to an agent of s0, whose roster is a library row now
    now += 6000;
    pod_ui_focus(&U, "a1", now);
    CHECK(U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a1") && frame_at(1)->tab == 0);
}

// ---- item 8: a Recap drag also scrolls the agent's pane in the desktop app, as the round dial does ----------------
static void open_recap_for_scroll(bool reversed) {
    setup();
    now += 5000;
    memset(&SC, 0, sizeof SC);
    (void)reversed;   // the Pro has no reversed-scroll setting: the sink is always natural
    tap(POD_A_OPEN_TAB, 0);
    SC.n = 0;
    expect(tap(POD_A_OPEN_AGENT, 1), POD_FX_AGENT_OPEN, "a2");   // the host is told which agent (agent.open) as it opens
    CHECK(top() == POD_V_RECAP);
    CHECK(SC.n == 0);     // taps send no scroll
    (void)hit;
}
static void recap_drag_scrolls_the_host(void) {
    open_recap_for_scroll(false);
    bool c;
    ucontact(true, 360, 300, &c);
    CHECK(SC.n == 0);                      // a finger that only landed is not yet a scroll
    for (int y = 300; y >= 120; y -= 20) { now += 16; ucontact(true, 360, y, &c); }   // up the glass
    now += 16;
    ucontact(false, 360, 120, &c);
    CHECK(SC.n >= 4 && SC.phase[0] == HT_SCROLL_DOWN && SC.phase[SC.n - 1] == HT_SCROLL_UP);
    int total = 0;
    for (int i = 0; i < SC.n; i++) {
        if (SC.phase[i] == HT_SCROLL_MOVE) CHECK(SC.dy[i] < 0 && SC.v[i] == 0);   // the finger went up: negative
        if (SC.phase[i] != HT_SCROLL_DOWN) total += SC.dy[i];
    }
    CHECK(total == -180);                                   // every pixel of travel reaches the host
    CHECK(SC.v[SC.n - 1] < -100);                           // the fling carries the speed, signed with the finger
    // Down the glass is positive (the Pro has no reversed setting).
    open_recap_for_scroll(false);
    ucontact(true, 360, 150, &c);
    for (int y = 150; y <= 330; y += 20) { now += 16; ucontact(true, 360, y, &c); }
    now += 16; ucontact(false, 360, 330, &c);
    total = 0;
    for (int i = 0; i < SC.n; i++) if (SC.phase[i] != HT_SCROLL_DOWN) total += SC.dy[i];
    CHECK(total == 180 && SC.v[SC.n - 1] > 100);
    // A tap, or a cancelled contact, closes cleanly: nothing for a tap; a cancelled drag ends with a zero UP.
    open_recap_for_scroll(false);
    ucontact(true, 360, 300, &c); now += 40; ucontact(false, 360, 300, &c);
    CHECK(SC.n == 0);
    ucontact(true, 360, 300, &c);
    for (int y = 300; y >= 220; y -= 20) { now += 16; ucontact(true, 360, y, &c); }
    pro_app_touch_cancel();
    CHECK(SC.n >= 3 && SC.phase[SC.n - 1] == HT_SCROLL_UP && SC.dy[SC.n - 1] == 0 && SC.v[SC.n - 1] == 0);
}

// A pane swipe on the Recap sends the desktop nothing (only the agent.open for the neighbour); the vertical drag still does.
static void swipe_sends_no_host_scroll(void) {
    open_recap_for_scroll(false);
    bool c;
    ucontact(true, 520, 300, &c);
    for (int x = 520; x >= 300; x -= 20) { now += 16; ucontact(true, x, 300 + (520 - x) / 10, &c); }
    now += 16;
    pod_out_t o = ucontact(false, 300, 322, &c);
    CHECK(SC.n == 0);
    CHECK(o.fx == POD_FX_AGENT_OPEN);
    open_recap_for_scroll(false);
    ucontact(true, 360, 300, &c);
    for (int y = 300; y >= 120; y -= 20) { now += 16; ucontact(true, 360, y, &c); }
    now += 16;
    o = ucontact(false, 360, 120, &c);
    CHECK(SC.n >= 4 && SC.phase[SC.n - 1] == HT_SCROLL_UP && o.fx == POD_FX_NONE);   // A_SCROLL path intact
}
// Only Recap reports: a drag on the Tab list moves that list, not the host.
static void tab_drag_does_not_scroll_the_host(void) {
    setup();
    now += 5000;
    memset(&SC, 0, sizeof SC);
    tap(POD_A_OPEN_TAB, 0);
    bool c;
    ucontact(true, 360, 400, &c);
    for (int y = 400; y >= 200; y -= 20) { now += 16; ucontact(true, 360, y, &c); }
    ucontact(false, 360, 200, &c);
    CHECK(SC.n == 0);
}

// ---- item 7 through the glue: an offline member from the swarms frame, and the play button's notice ------------------
static void offline_member_through_the_glue(void) {
    setup();
    now += 5000;
    cable_swarm_t sw[1] = {{.agents = 3, .panes = 3}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Thoi trang");
    static cable_swarm_members_t mem;
    memset(&mem, 0, sizeof mem);
    mem.count[0] = 3;
    snprintf(mem.id[0][0], ID_MAX, "a1"); snprintf(mem.id[0][1], ID_MAX, "a2"); snprintf(mem.id[0][2], ID_MAX, "far");
    mem.meta[0][2] = (cable_swarm_member_meta_t){"Stylist", "codex", "Diego's Mac", true, false};
    pod_ui_swarms(&U, sw, 1, &mem, "s0", NULL, 0);
    const pod_agent_t *far = pod_model_find(&U.model, "far");
    CHECK(far && far->state == POD_OFFLINE);
    // A roster refresh and a library sweep that do not list it do not drop it (the glue rebuilds the tabs from the retained frame).
    pod_roster_row_t rows[] = {{"a1", "Alpha", "claude", "mac"}, {"a2", "Bravo", "codex", "mac"}};
    pod_ui_roster(&U, rows, 2);
    library_all();
    CHECK(pod_model_find(&U.model, "far") != NULL);
    render();
    tap(POD_A_OPEN_TAB, 0);
    CHECK(top() == POD_V_TAB);
    pod_out_t o = tap(POD_A_OPEN_AGENT, 2);
    expect(o, POD_FX_AGENT_OPEN, "far");
    CHECK(top() == POD_V_AGENT && !strcmp(frame_at(2)->agent, "far"));
    // The play button: no recording, a notice instead.
    o = tap(POD_A_TALK, 0);
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_AGENT && !pod_ui_talking(&U));
    CHECK(U.notice_on && !strcmp(U.notice, "That machine is offline"));
    // The daemon stops describing it: the screen falls back to the tab's list.
    memset(mem.meta, 0, sizeof mem.meta);
    pod_ui_swarms(&U, sw, 1, &mem, "s0", NULL, 0);
    CHECK(top() == POD_V_TAB && pod_model_find(&U.model, "far") == NULL);
}


// ---- what pro_app adds: the app layer's own rules ------------------------------------------------------------------
static const pod_agent_t *agent(const char *id) { return pod_model_find(&U.model, id); }
static pro_library_row_t LP0[6], LP1[2];
static void library_pages(void) {
    static const pro_library_row_t p0[6] = {
        {"a1", "Alpha", "claude", "Mac", "working", 4}, {"a2", "Bravo", "codex", "Mac", "idle", 90},
        {"b1", "Delta", "gemini", "Box", "working", 3}, {"b2", "Echo", "codex", "Box", "question", 8},
        {"c1", "Other", "claude", "Box", "idle", 500}, {"c2", "Other2", "claude", "Box", "idle", 600}};
    static const pro_library_row_t p1[2] = {{"c3", "Other3", "claude", "Box", "idle", 700}, {"c4", "Other4", "claude", "Box", "idle", 800}};
    memcpy(LP0, p0, sizeof LP0);
    memcpy(LP1, p1, sizeof LP1);
}

// R3: a started turn, then a pane that is not live: the late read must not revive it (no 25 s expiry either).
static void pro_app_test_turn_gates(void) {
    setup();
    now = 2000;
    // A read before any turn started on a2 says nothing.
    pro_app_turn("a2", "verb", "Reading...", -1);
    pro_app_turn("a2", "activity", "Looking", 1);
    CHECK(agent("a2")->state == POD_DONE && !agent("a2")->verb[0] && !agent("a2")->activity[0]);
    // An agent Pod does not hold is ignored (owner decision 5): nothing is created.
    pro_app_turn("zz", "started", "Thinking", 0);
    CHECK(agent("zz") == NULL);
    // A generic label is liveness, not a word.
    pro_app_turn("a2", "started", "Processing", 0);
    CHECK(agent("a2")->state == POD_WORKING && !agent("a2")->verb[0]);
    pro_app_turn("a2", "verb", "Pondering...", -1);
    CHECK(!strcmp(agent("a2")->verb, "Pondering"));
    // The sentence under the pet comes from `action`, whitespace collapsed; an absent elapsed keeps the model's.
    now = 5000;
    pro_app_turn("a2", "activity", "  Reading   the\n files ", 7);
    CHECK(!strcmp(agent("a2")->activity, "Reading the files") && agent("a2")->elapsed_s == 7);
    pro_app_turn("a2", "activity", "", -1);
    CHECK(!strcmp(agent("a2")->activity, "Reading the files") && agent("a2")->elapsed_s == 7);
    pro_app_turn("a2", "activity", "", 9);
    CHECK(agent("a2")->elapsed_s == 9);
    // 25 s is not a limit: still working after a minute of silence, and a late read still counts (owner decision 1).
    now += 60000;
    pro_app_turn("a2", "verb", "Still going", -1);
    CHECK(agent("a2")->state == POD_WORKING && !strcmp(agent("a2")->verb, "Still going"));
    // After done, the late reads are dropped.
    pro_app_turn("a2", "done", "", 0);
    CHECK(agent("a2")->state == POD_DONE);
    pro_app_turn("a2", "verb", "Late", -1);
    pro_app_turn("a2", "activity", "Late sentence", 3);
    CHECK(agent("a2")->state == POD_DONE && strcmp(agent("a2")->verb, "Late") && strcmp(agent("a2")->activity, "Late sentence"));
    // error ends it too
    pro_app_turn("a2", "started", "", 0);
    pro_app_turn("a2", "error", "", 0);
    CHECK(agent("a2")->state == POD_IDLE);
}

static void pro_app_test_step_after_done(void) {
    setup();
    now = 2000;
    pro_app_turn("a2", "started", "Thinking", 0);
    pro_app_turn("a2", "step", "Read - pod_model.c", -1);
    CHECK(agent("a2")->state == POD_WORKING && agent("a2")->step_count == 1);
    pro_app_turn("a2", "done", "", 0);
    CHECK(agent("a2")->state == POD_DONE);
    int steps = agent("a2")->step_count;
    pro_app_turn("a2", "step", "Edit - pod_nav.c", -1);
    CHECK(agent("a2")->state == POD_DONE && agent("a2")->step_count == steps);
    // A step into an agent that never started is not a turn either.
    pro_app_turn("a3", "step", "Read - x.c", -1);
    CHECK(agent("a3")->state != POD_WORKING);
}

static void pro_app_test_new_turn_only(void) {
    setup();
    now = 2000;
    pro_app_turn("a2", "started", "Thinking", 0);
    CHECK(agent("a2")->since_ms == 2000 && agent("a2")->elapsed_s == 0 && !strcmp(agent("a2")->verb, "Thinking"));
    now = 9000;
    pro_app_turn("a2", "activity", "Reading", 7);
    pro_app_turn("a2", "started", "Pondering", 0);            // the heartbeat of the same live turn
    CHECK(agent("a2")->since_ms == 2000);                    // the clock was reset once, not again
    CHECK(agent("a2")->elapsed_s == 7 && !strcmp(agent("a2")->activity, "Reading"));   // the sentence survives it
    CHECK(!strcmp(agent("a2")->verb, "Pondering"));          // it only refreshed the word
    pro_app_turn("a2", "done", "", 0);
    now = 12000;
    pro_app_turn("a2", "started", "Again", 0);               // a new turn after done is a new clock
    CHECK(agent("a2")->since_ms == 12000 && agent("a2")->elapsed_s == 0);
    // A link drop ends every turn's liveness: the next started is a new turn.
    now = 13000;
    pro_app_link(false, NULL);
    pro_app_link(true, "mac");
    now = 14000;
    pro_app_turn("a2", "started", "Again", 0);
    CHECK(agent("a2")->since_ms == 14000);
}

// The real cadence, in its own fine grain: a verb and an activity ~40 ms apart, most of them empty reads.
static void pro_app_test_verb_activity_cadence(void) {
    setup();
    now = 10000;
    pod_ui_focus(&U, "a1", now);
    pro_app_turn("a1", "started", "Reading...", 0);
    pro_app_turn("a1", "activity", "Reading files", 2);
    render();
    char verb[POD_VERB_BYTES], act[POD_ACTIVITY_BYTES];
    snprintf(verb, sizeof verb, "%s", agent("a1")->verb);
    snprintf(act, sizeof act, "%s", agent("a1")->activity);
    CHECK(!strcmp(verb, "Reading") && !strcmp(act, "Reading files"));
    static ht_scene_t before, after;
    memcpy(&before, &S, sizeof before);
    for (int i = 0; i < 40; i++) {
        now += 40;
        pro_app_turn("a1", "verb", i & 1 ? "" : "Reading...", -1);
        now += 40;
        pro_app_turn("a1", "activity", "", i & 2 ? -1 : 2);   // an empty read, with or without the clock
        CHECK(!strcmp(agent("a1")->verb, verb) && !strcmp(agent("a1")->activity, act));
    }
    now = 10000;
    render();
    memcpy(&after, &S, sizeof after);
    CHECK(!memcmp(&before, &after, sizeof before));
}

static void pro_app_test_summary_and_question(void) {
    setup();
    now = 3000;
    pro_app_turn("a1", "started", "", 0);
    // A live summary ends the turn; `full` wins over `recap`.
    pro_app_summary("a1", "short", "the recap", "the long recap", false, false);
    CHECK(agent("a1")->state == POD_DONE && strstr(agent("a1")->recap, "the long recap") && !strstr(agent("a1")->recap, "the recap\n"));
    // A restore summary is history: no end of turn.
    pro_app_turn("a2", "started", "", 0);
    pro_app_summary("a2", "old text", NULL, NULL, true, false);
    CHECK(agent("a2")->state == POD_WORKING);
    // "done" is not a text
    pro_app_summary("a3", "done", NULL, NULL, false, false);
    CHECK(agent("a3")->recap[0] == 0);
    // Questions: held while open, closed by the daemon or by a new turn.
    pro_app_question("a1", "Which branch?");
    CHECK(pro_app_question_open("a1") && agent("a1")->state == POD_ASKING);
    pro_app_question_close("a1");
    CHECK(!pro_app_question_open("a1"));
    pro_app_question("a1", NULL);
    CHECK(pro_app_question_open("a1") && !strcmp(agent("a1")->question, "Needs your answer"));
    pro_app_turn("a1", "started", "", 0);
    CHECK(!pro_app_question_open("a1"));
    pro_app_question("zz", "ghost?");
    CHECK(!pro_app_question_open("zz"));
}

// R14/R15: the sweep is driven from the tick, one request in flight, retried, and it dies with the link.
static void pro_app_test_link_drop(void) {
    setup();
    library_pages();
    now = 1000;
    pro_app_tick();                                           // linked, never swept: due
    CHECK(pod_ui_sweeping(&U) && LIB.n == 1 && LIB.offset[0] == 0);
    uint32_t first = LIB.request[0];
    pro_app_library(LP0, 6, 0, 8);                            // page 0 of 8: the walk goes on to offset 6
    CHECK(pod_ui_sweeping(&U) && LIB.n == 2 && LIB.offset[1] == 6 && LIB.request[1] > first);
    // Sweep in flight, link drops: no sweep, nothing waits forever.
    pro_app_link(false, NULL);
    CHECK(!pod_ui_sweeping(&U));
    int n = LIB.n;
    now = 1500;
    pro_app_tick();
    CHECK(LIB.n == n && !pod_ui_sweeping(&U));                 // unlinked: no request
    pro_app_link(true, "mac");
    now = 2000;
    pro_app_tick();                                            // the next sweep restarts at offset 0
    CHECK(pod_ui_sweeping(&U) && LIB.n == n + 1 && LIB.offset[n] == 0);
    pro_app_library(LP0, 6, 0, 8);
    pro_app_library(LP1, 2, 6, 8);                             // the last page: the sweep is over
    CHECK(!pod_ui_sweeping(&U) && LIB.n == n + 2);
    CHECK(agent("c4") != NULL);
}

static void pro_app_test_sweep_retries(void) {
    setup();
    library_pages();
    now = 1000;
    LIB.ok = false;                                            // the link is not draining
    pro_app_tick();
    CHECK(pod_ui_sweeping(&U) && LIB.n == 1);
    now = 1500; pro_app_tick(); CHECK(LIB.n == 1);             // not before a second
    now = 2100; LIB.ok = true; pro_app_tick(); CHECK(LIB.n == 2 && LIB.offset[1] == 0);   // the failed one is retried
    now = 4000; pro_app_tick(); CHECK(LIB.n == 2);             // asked at 2100, answered by nobody: wait out 3 s
    now = 5200; pro_app_tick(); CHECK(LIB.n == 3 && LIB.offset[2] == 0 && LIB.request[2] > LIB.request[1]);
    // An older daemon with no library: no sweep, no request
    setup();
    LIB.supported = false;
    now = 1000; pro_app_tick();
    CHECK(LIB.n == 0 && !pod_ui_sweeping(&U));
    // A page nobody asked for feeds rows only
    LIB.supported = true;
    library_pages();
    pro_app_library(LP1, 2, 6, 8);
    CHECK(agent("c3") != NULL && !pod_ui_sweeping(&U));
}

static void pro_app_test_voice_gate(void) {
    setup();
    cable_machine_t m[2];
    memset(m, 0, sizeof m);
    snprintf(m[0].id, sizeof m[0].id, "m-off"); snprintf(m[0].name, sizeof m[0].name, "Box"); snprintf(m[0].state, sizeof m[0].state, "offline");
    snprintf(m[1].id, sizeof m[1].id, "m-link"); snprintf(m[1].name, sizeof m[1].name, "Pc"); snprintf(m[1].state, sizeof m[1].state, "needs-link");
    pro_app_machines(m, 2, "m-off");
    static pro_agent_row_t rows[4];
    rows[0] = (pro_agent_row_t){"a1", "Alpha", "claude", "m-ok", "Mac"};
    rows[1] = (pro_agent_row_t){"a2", "Bravo", "codex", "m-off", "Box"};
    rows[2] = (pro_agent_row_t){"a3", "Charlie", "claude", "m-link", "Pc"};
    rows[3] = (pro_agent_row_t){"a4", "Shell", "terminal", "m-ok", "Mac"};
    pro_app_agents(rows, 4);
    CHECK(pro_app_voice_block_reason("a1") == NULL);
    CHECK(!strcmp(pro_app_voice_block_reason("a2"), "This computer is offline."));
    CHECK(!strcmp(pro_app_voice_block_reason("a3"), "Link this computer in Harness."));
    CHECK(!strcmp(pro_app_voice_block_reason("a4"), "Choose an agent pane."));
    CHECK(pro_app_voice_block_reason("nobody") == NULL);        // unknown: allowed
    pro_app_question("a1", "Which?");
    CHECK(!strcmp(pro_app_voice_block_reason("a1"), "Answer its question first."));
    pro_app_question_close("a1");
    CHECK(pro_app_voice_block_reason("a1") == NULL);
    // Library-only agents are matched by the machine NAME the row carries.
    pro_library_row_t lib[1] = {{"far", "Far", "claude", "Box", "idle", 5}};
    pro_app_library(lib, 1, 0, 1);
    CHECK(!strcmp(pro_app_voice_block_reason("far"), "This computer is offline."));
    // The session ends: everything the daemon said is gone, including the machines.
    pro_app_link(false, NULL);
    CHECK(!strcmp(pro_app_voice_block_reason("a1"), "Not connected"));
    pro_app_link(true, "mac");
    CHECK(pro_app_voice_block_reason("a2") == NULL);            // the machine list was dropped with the session
}

// A refused start leaves Talk and says why; a reply ends the voice state.
static void pro_app_test_voice_paths(void) {
    to_talk();
    CHECK(top() == POD_V_TALK && V.open);
    pro_app_voice_result(PRO_VOICE_ERROR, "Didn't catch that");
    CHECK(!V.open && top() == POD_V_AGENT && U.notice_on && !strcmp(U.notice, "Didn't catch that"));
    // A reply nobody waits for changes nothing
    pro_app_notice("x"); U.notice_on = false;
    pro_app_voice_result(PRO_VOICE_ERROR, "stale");
    CHECK(!U.notice_on);
    // A refused recorder: Talk is left, a notice says so
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    V.refuse = true;
    pod_out_t o = tap(POD_A_TALK, 0);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && R.begins == 1);
    CHECK(top() == POD_V_AGENT && !pod_ui_talking(&U) && U.notice_on && !strcmp(U.notice, "Can't talk right now"));
    // A gate refusal never reaches the recorder
    V.refuse = false;
    pro_app_question("a1", "Which?");
    tap(POD_A_TALK, 0);
    CHECK(R.begins == 0 && !pod_ui_talking(&U) && !strcmp(U.notice, "Answer its question first."));
    // The tick: Talk with no recording behind it ends; a sent one (waiting) ends too
    pro_app_question_close("a1");
    tap(POD_A_TALK, 0);
    CHECK(pod_ui_talking(&U));
    V.waiting = true;                                          // the 600 s cap stopped and sent it
    pro_app_tick();
    CHECK(!pod_ui_talking(&U) && top() == POD_V_AGENT);
}

// The finger rules: a second finger, a lost sample or the touch that wakes the screen is never a tap.
static void pro_app_test_touch_rules(void) {
    setup();
    render();
    const pod_hit_t *h = hit(POD_A_OPEN_TAB, 0);
    CHECK(h);
    int x = h->x + h->w / 2, y = h->y + h->h / 2;
    bool c;
    // a second finger lands mid-contact: cancel, and the first finger's lift is not a tap
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_BAD, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);                 // one finger left, still the same contact
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    // and the next contact works again
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TAB);
    render();
    tap(POD_A_BACK, 0);
    // a failed read mid-contact is not a lift
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_ERROR, 0, 0);
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TABS);
    // a failed read with nothing down swallows nothing
    pro_touch_feed(&TCH, PRO_TOUCH_ERROR, 0, 0);
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TAB);
    render();
    tap(POD_A_BACK, 0);
    // the touch that wakes a sleeping screen is swallowed, whole
    pro_app_sleep();
    CHECK(pro_app_asleep());
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    CHECK(!pro_app_asleep());
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TABS);
    (void)c;
    // the screen sleeps halfway through a contact: the rest of it is consumed
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_app_sleep();
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TABS);
    pro_app_wake();
    pro_touch_feed(&TCH, PRO_TOUCH_ONE, x, y);
    pro_touch_feed(&TCH, PRO_TOUCH_NONE, 0, 0);
    CHECK(top() == POD_V_TAB);
}

// The turn lives in pro_display.c, once. Nothing above it may turn a contact again.
static void pro_app_test_roster_and_swarms(void) {
    setup();
    static pro_agent_row_t rows[POD_AGENTS_MAX + 4];
    static char ids[POD_AGENTS_MAX + 4][ID_MAX];
    for (int i = 0; i < POD_AGENTS_MAX + 4; i++) { snprintf(ids[i], ID_MAX, "r%d", i); rows[i] = (pro_agent_row_t){ids[i], NULL, "claude", "m", "mac"}; }
    rows[1] = rows[0];                                         // a duplicate id
    rows[2].id = "";                                           // no id
    pro_app_agents(rows, POD_AGENTS_MAX + 4);
    CHECK(agent("r0") && !strcmp(agent("r0")->name, "r0"));      // the name falls back to the id
    CHECK(agent("r3") != NULL && agent("a1") == NULL);
    int held_n = 0;
    for (int i = 0; i < POD_AGENTS_MAX + 4; i++) held_n += agent(ids[i]) != NULL;
    CHECK(held_n <= POD_AGENTS_MAX);
    // focus: the glue's timers, with an id of the wrong size dropped
    now = 20000;
    pro_app_focus("r0");
    CHECK(top() == POD_V_AGENT || top() == POD_V_RECAP);
    char big[ID_MAX + 8];
    memset(big, 'x', sizeof big); big[sizeof big - 1] = 0;
    pro_app_focus(big);
}

// M1: the side button. A press wakes a sleeping screen and does nothing else; awake it abandons a recording, else goes
// home; a hold sleeps the screen, except the hold of the press that woke it.
static void side_button(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    CHECK(top() == POD_V_AGENT && !pro_app_asleep());
    // Awake, on an agent: a press goes home to Tabs.
    pro_app_button_press();
    CHECK(top() == POD_V_TABS && U.nav.depth == 1 && LOCK_DEPTH == 0);
    render();
    // A hold sleeps the screen; the next press wakes it and does not navigate.
    tap(POD_A_OPEN_TAB, 0);
    CHECK(top() == POD_V_TAB);
    pro_app_button_press(); pro_app_button_hold();
    CHECK(pro_app_asleep() && LOCK_DEPTH == 0);
    pro_app_button_press();
    CHECK(!pro_app_asleep() && top() == POD_V_TABS);   // the press that slept it went home first; the waking one did not move
    pro_app_button_hold();                         // the same press held on: it woke the screen, so no sleep
    CHECK(!pro_app_asleep());
    render();
    tap(POD_A_OPEN_TAB, 0);
    // Recording: a press abandons it, leaves Talk, and goes no further.
    tap(POD_A_OPEN_AGENT, 0);
    memset(&R, 0, sizeof R);
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");
    CHECK(top() == POD_V_TALK);
    memset(&R, 0, sizeof R);
    pro_app_button_press();
    CHECK(R.end_abort == 1 && top() == POD_V_AGENT && !pod_ui_talking(&U) && LOCK_DEPTH == 0);
    // The idle screen: a hold from a fresh press sleeps it again.
    pro_app_button_press(); pro_app_button_hold();
    CHECK(pro_app_asleep());
    pro_app_wake();
}

// L3: a question that arrives with no link is not taken (the cable drops everything but welcome/ping then, and the app
// does not trust a late callback either).
static void question_needs_the_link(void) {
    setup();
    pro_app_link(false, NULL);
    pro_app_question("a1", "Which one?");
    CHECK(!pro_app_question_open("a1"));
    pro_app_link(true, "mac");
    pro_app_question("a1", "Which one?");
    CHECK(pro_app_question_open("a1"));
}

// ---- notifications: the banner, the bell, the Inbox, the beep ----------------------------------------------------
static void notif_setup(void) {
    setup();
    MUTED = false; BEEPS = 0; READS = 0;
    now = 5300;
    render();
}
static const pod_hit_t *banner(void) { return hit(POD_A_BANNER, 0); }

static void notify_banner_beep_and_expiry(void) {
    notif_setup();
    // A plain live summary: an unread entry, the banner, one beep, the bell.
    pro_app_summary("a3", "t", "Shipped the thing. Tests pass.", NULL, false, true);
    CHECK(BEEPS == 1 && U.model.unread_count == 1 && !strcmp(U.model.unread[0].agent, "a3"));
    CHECK(pod_ui_take_changed(&U));
    render();
    const pod_hit_t *b = banner();
    CHECK(b && !strcmp(b->id, "a3") && b->x == 16 && b->y == POD_STATUS_H + 12 && hit(POD_A_INBOX, 0));
    CHECK(U.frame.hits[U.frame.hit_count - 1].action == POD_A_BANNER && S.count <= HT_RUNS);
    // Visible 6 s: the clock wakes for the expiry (200 ms left at 11100, though the second ticks at 900), then it is gone.
    now = 11100; render();
    CHECK(banner() && pod_ui_wake_ms(&U, now) == 200);
    uint32_t stamp_before = U.clock_stamp;
    CHECK(pod_ui_clock_tick(&U, now) || stamp_before != U.clock_stamp);
    now = 11299; render();
    CHECK(banner() != NULL);
    now = 11300; render();
    CHECK(banner() == NULL && U.model.unread_count == 1 && hit(POD_A_INBOX, 0));   // it stays unread in the Inbox
    // A newer one replaces the shown one, and moves to the top of the list.
    now = 20000;
    pro_app_summary("a1", "t", "Renamed the module.", NULL, false, true);
    render();
    CHECK(BEEPS == 2 && U.model.unread_count == 2 && !strcmp(U.model.unread[0].agent, "a1") && banner() && !strcmp(banner()->id, "a1"));
    now = 22000;
    pro_app_summary("a3", "t", "And again.", NULL, false, true);
    render();
    CHECK(BEEPS == 3 && U.model.unread_count == 2 && !strcmp(banner()->id, "a3") && !strcmp(U.model.unread[0].agent, "a3"));
    // Muted: the entry and the banner come, the beep does not.
    MUTED = true;
    now = 30000;
    pro_app_summary("a2", "t", "Muted one.", NULL, false, true);
    CHECK(BEEPS == 3 && U.model.unread_count == 3);
    MUTED = false;
    // quiet / silent / restore (notify false): no entry, no beep, no banner; a restore also leaves the turn state alone.
    notif_setup();
    now = 6000;
    pro_app_summary("a3", "t", "quiet", NULL, false, false);
    pro_app_summary("a3", "t", "restored", NULL, true, false);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    render();
    CHECK(banner() == NULL && hit(POD_A_INBOX, 0) == NULL);
    // A restore that claims to notify still does not (the cable never sends that; the app does not trust it).
    pro_app_summary("a3", "t", "restored", NULL, true, true);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    // An agent the roster does not hold: nothing.
    pro_app_summary("zz", "t", "ghost", NULL, false, true);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    // Awake on that agent's own screen: already looking, nothing. Dark on it: news, and the glass lights.
    notif_setup();
    now = 40000;
    pod_ui_focus(&U, "a3", now);
    CHECK(top() == POD_V_AGENT || top() == POD_V_RECAP);
    pro_app_summary("a3", "t", "Looked at.", NULL, false, true);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    pro_app_sleep();
    CHECK(pro_app_asleep());
    pro_app_summary("a3", "t", "In the dark.", NULL, false, true);
    CHECK(BEEPS == 1 && U.model.unread_count == 1 && !pro_app_asleep());
}

static void notify_tap_opens_and_swipe_dismisses(void) {
    notif_setup();
    tap(POD_A_OPEN_TAB, 0);                         // the Backend list: a1 and a2 rows sit right under the banner
    CHECK(top() == POD_V_TAB);
    now = 6000;
    pro_app_summary("a3", "t", "Shipped the thing. Tests pass.", NULL, false, true);
    render();
    const pod_hit_t *b = banner();
    CHECK(b && hit(POD_A_OPEN_AGENT, 0));
    int cx = b->x + b->w / 2, cy = b->y + b->h / 2;
    // The banner is over the first row: a tap on it opens a3 (its tab, its screen), never the row below.
    pod_out_t o = tap_at(cx, cy);
    expect(o, POD_FX_AGENT_OPEN, "a3");
    CHECK(top() == POD_V_RECAP && !strcmp(U.nav.stack[U.nav.depth - 1].agent, "a3") && U.nav.depth == 3);   // it has a recap now
    CHECK(U.model.unread_count == 0 && banner() == NULL && READS == 0);   // read; a live summary has no token to report
    // A swipe up dismisses; the entry stays unread and nothing opens.
    notif_setup();
    now = 7000;
    pro_app_summary("a3", "t", "Again.", NULL, false, true);
    render();
    b = banner();
    CHECK(b);
    cx = b->x + b->w / 2; cy = b->y + b->h / 2;
    bool c;
    CHECK(ucontact(true, cx, cy, &c).fx == POD_FX_NONE);
    ucontact(true, cx, cy - 30, &c); ucontact(true, cx, cy - 60, &c);
    pod_out_t up = ucontact(false, cx, cy - 60, &c);
    render();
    CHECK(up.fx == POD_FX_NONE && banner() == NULL && U.model.unread_count == 1 && top() == POD_V_TABS && hit(POD_A_INBOX, 0));
    // A drag down or sideways on the banner is neither a tap nor a dismissal.
    now = 8000;
    pro_app_summary("a3", "t", "Third.", NULL, false, true);
    render();
    b = banner();
    cx = b->x + b->w / 2; cy = b->y + b->h / 2;
    ucontact(true, cx, cy, &c); ucontact(true, cx, cy + 60, &c);
    up = ucontact(false, cx, cy + 60, &c);
    render();
    CHECK(up.fx == POD_FX_NONE && banner() != NULL && top() == POD_V_TABS);
    // It does not take touches that begin elsewhere: the bell opens the Inbox even with the banner up.
    expect(tap(POD_A_INBOX, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_INBOX);
}

static void notify_never_over_talk(void) {
    notif_setup();
    tap(POD_A_OPEN_TAB, 0);
    expect(tap(POD_A_OPEN_AGENT, 0), POD_FX_AGENT_OPEN, "a1");
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");
    CHECK(pod_ui_talking(&U));
    now = 6000;
    pro_app_summary("a3", "t", "Done while talking.", NULL, false, true);
    render();
    CHECK(banner() == NULL && hit(POD_A_INBOX, 0) == NULL && U.model.unread_count == 1);   // in the Inbox; no bell over a recording
    now = 7000; render();
    CHECK(banner() == NULL);
    // The talk ends within the 6 s: the banner does not pop up late.
    pod_ui_talk_over(&U);
    now = 8000; render();
    CHECK(banner() == NULL && hit(POD_A_INBOX, 0));
    // Looking at the agent already: no entry, no beep.
    notif_setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    int beeps = BEEPS;
    pro_app_summary("a1", "t", "I am looking at it.", NULL, false, true);
    CHECK(BEEPS == beeps && U.model.unread_count == 0);
    // No cable: no banner.
    notif_setup();
    now = 6000;
    pro_app_summary("a3", "t", "x", NULL, false, true);
    pro_app_link(false, NULL);
    render();
    CHECK(banner() == NULL);
    pro_app_link(true, "mac");
    render();
    CHECK(banner() != NULL);
}

static void notify_replace_seen_and_read(void) {
    notif_setup();
    pro_notif_row_t rows[] = {{"a1", "Alpha", "Renamed the module.", "tok_a1"}, {"a2", "Bravo", "Fixed the parser.", ""}, {"nobody", "Ghost", "Gone.", "tok_g"}};
    pro_app_notif_replace(rows, 3);
    render();
    CHECK(BEEPS == 0 && banner() == NULL && U.model.unread_count == 3 && hit(POD_A_INBOX, 0));   // the whole list; no beep, no banner
    pro_notif_row_t one[] = {{"a2", "Bravo", "Fixed the parser.", "tok_a2"}};
    pro_app_notif_replace(one, 1);                                                                 // replaces, not adds
    CHECK(U.model.unread_count == 1 && !strcmp(U.model.unread[0].token, "tok_a2"));
    pro_app_notif_replace(rows, 3);
    pro_app_notif_seen("a2", NULL);                                                                // read on the window
    CHECK(U.model.unread_count == 2 && READS == 0);
    pro_app_notif_seen("a1", "other");                                                             // another occurrence of a1
    CHECK(U.model.unread_count == 2);
    pro_app_notif_seen("a1", "tok_a1");
    CHECK(U.model.unread_count == 1);
    pro_app_notif_replace(rows, 3);
    // The Inbox: the bell opens it, a row opens the agent, marks it read and sends notif.read with its token.
    render();
    expect(tap(POD_A_INBOX, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_INBOX);
    const pod_hit_t *r = hit(POD_A_OPEN_NOTIF, 0);
    CHECK(r && r->y == POD_STATUS_H && !strcmp(r->id, "a1"));
    pod_out_t o = tap(POD_A_OPEN_NOTIF, 0);
    expect(o, POD_FX_AGENT_OPEN, "a1");
    CHECK(READS == 1 && !strcmp(READ_AGENT, "a1") && !strcmp(READ_TOKEN, "tok_a1") && U.model.unread_count == 2 && top() == POD_V_AGENT);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_INBOX);
    expect(tap(POD_A_OPEN_NOTIF, 0), POD_FX_AGENT_OPEN, "a2");                                     // no token: opens, nothing to report
    CHECK(READS == 1 && U.model.unread_count == 1);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    expect(tap(POD_A_OPEN_NOTIF, 0), POD_FX_NONE, NULL);                                           // not on the roster: read, nothing to open
    CHECK(READS == 2 && !strcmp(READ_TOKEN, "tok_g") && U.model.unread_count == 0 && top() == POD_V_INBOX);
    render();
    CHECK(hit(POD_A_INBOX, 0) == NULL);   // the list is empty: "No notifications", no bell
    // Opening an agent from a tab list reads its entry too (the host hears of it).
    pro_app_notif_replace(rows, 3);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    tap(POD_A_OPEN_TAB, 0);
    expect(tap(POD_A_OPEN_AGENT, 0), POD_FX_AGENT_OPEN, "a1");
    CHECK(READS == 3 && !strcmp(READ_TOKEN, "tok_a1") && U.model.unread_count == 2);
    // And the host focusing it.
    pro_app_focus("a2");
    CHECK(U.model.unread_count == 1 || U.pending_focus[0] == 0);
}

// ---- the software update screen ----------------------------------------------------------------------------------
static void ota_end(void) { fw_update_ui_failed(); }   // the screen goes; the notice it leaves is checked where it matters

static void ota_screen_and_touch(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);
    render();
    const int depth = U.nav.depth;
    CHECK(hit(POD_A_TALK, 0));
    fw_update_ui_begin("0.1.2", "0.1.3");
    CHECK(pod_ui_updating(&U) && pod_ui_take_changed(&U));
    render();
    CHECK(U.frame.hit_count == 0 && S.count > 0 && S.count <= HT_RUNS);   // the update's own screen: no transport, nothing to hit
    int runs0 = S.count;
    // Every touch is ignored: the TALK button's place, the middle, the back corner, a swipe. Nothing moves, nothing is sent.
    memset(&R, 0, sizeof R);
    bool changed = false;
    static const int pts[][2] = {{360, 640}, {360, 360}, {30, 27}};
    for (unsigned i = 0; i < 3; i++) {
        pod_out_t d = ucontact(true, pts[i][0], pts[i][1], &changed);
        CHECK(d.fx == POD_FX_NONE && !changed);
        pod_out_t u = ucontact(false, pts[i][0], pts[i][1], &changed);
        CHECK(u.fx == POD_FX_NONE && !changed);
    }
    ucontact(true, 600, 360, &changed); ucontact(true, 100, 365, &changed); ucontact(false, 100, 365, &changed);
    CHECK(R.opens == 0 && R.begins == 0 && R.end_abort == 0 && top() == POD_V_AGENT && U.nav.depth == depth && !changed);
    // Progress redraws the same screen (the bar's fill moves; the run count does not shrink) and the button does not go home.
    fw_update_ui_pct(42);
    CHECK(pod_ui_take_changed(&U));
    render();
    CHECK(S.count == runs0 && U.ota_pct == 42);
    pro_app_button_press();
    CHECK(U.nav.depth == depth && pod_ui_updating(&U) && LOCK_DEPTH == 0);
    fw_update_ui_restarting("0.1.3");
    render();
    CHECK(U.ota_restarting && U.ota_pct == 100 && S.count > 0 && S.count <= HT_RUNS && U.frame.hit_count == 0);
    // The failed path ends it: the stack comes back as it was.
    ota_end();
    render();
    CHECK(!pod_ui_updating(&U) && U.nav.depth == depth && top() == POD_V_AGENT && hit(POD_A_TALK, 0));
}

static void voice_refused_while_updating(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    const pod_hit_t *talk = hit(POD_A_TALK, 0);
    CHECK(talk && pro_app_voice_block_reason("a1") == NULL);
    const int tx = talk->x + talk->w / 2, ty = talk->y + talk->h / 2;
    fw_update_ui_begin("0.1.2", "0.1.3");
    CHECK(!strcmp(pro_app_voice_block_reason("a1"), "Updating"));
    // The record button's place, and the side button: no recording starts and none is left open.
    memset(&R, 0, sizeof R);
    bool changed;
    ucontact(true, tx, ty, &changed); ucontact(false, tx, ty, &changed);
    pro_app_button_press();
    CHECK(R.begins == 0 && !V.open && !pod_ui_talking(&U) && top() == POD_V_AGENT);
    // A start that was already on its way (Pod returned the effect before the update began) is refused at the gate.
    ota_end();
    CHECK(pro_app_voice_block_reason("a1") == NULL);
    render();
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");   // and the gate opens again afterwards
}

// The offer's gate: refuses while a voice start or recording is open; otherwise holds voice off WITHOUT a screen, and a
// refusal that left nothing in flight releases it with no screen and no notice.
static void update_gate(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    render();
    V.open = true;
    CHECK(!pro_app_begin_update_gate() && !pod_ui_updating(&U));
    V.open = false; V.pending = true;
    CHECK(!pro_app_begin_update_gate());
    V.pending = false;
    CHECK(pro_app_voice_block_reason("a1") == NULL);               // a refused gate holds nothing
    CHECK(pro_app_begin_update_gate() && LOCK_DEPTH == 0);
    CHECK(!pod_ui_updating(&U) && !strcmp(pro_app_voice_block_reason("a1"), "Updating"));
    pro_app_end_update_gate();                                     // the offer was refused before accept
    CHECK(pro_app_voice_block_reason("a1") == NULL && !pod_ui_updating(&U) && !U.notice_on && LOCK_DEPTH == 0);
    render();
    CHECK(!U.notice_on && hit(POD_A_TALK, 0));
    // The race: the gate lands inside a start that already passed its own check. The start is cancelled, not recorded.
    const pod_hit_t *talk = hit(POD_A_TALK, 0);
    const int tx = talk->x + talk->w / 2, ty = talk->y + talk->h / 2;
    memset(&R, 0, sizeof R);
    GATE_IN_BEGIN = true;
    bool changed;
    ucontact(true, tx, ty, &changed); ucontact(false, tx, ty, &changed);
    GATE_IN_BEGIN = false;
    CHECK(R.begins == 1 && R.end_abort == 1 && !V.open && !pod_ui_talking(&U));
    fw_update_ui_failed();                                         // an accepted transfer that failed also lets go
    CHECK(pro_app_voice_block_reason("a1") == NULL);
}

static void ota_failed_returns(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    render();
    const int depth = U.nav.depth;
    now = 20000;
    fw_update_ui_begin("0.1.2", "0.1.3");
    fw_update_ui_pct(10);
    now = 21000;
    fw_update_ui_failed();
    CHECK(!pod_ui_updating(&U) && U.nav.depth == depth && top() == POD_V_TAB);
    CHECK(pod_ui_take_changed(&U));
    render();
    CHECK(U.notice_on);
    CHECK(!strcmp(U.notice, "Update failed \xc2\xb7 trying again later") && U.notice_bad);   // the red pill
    CHECK(hit(POD_A_BACK, 0));
    now = 23900; render();
    CHECK(U.notice_on);
    now = 24100; render();
    CHECK(!U.notice_on);
}

static void ota_keeps_awake(void) {
    setup();
    pro_app_sleep();
    CHECK(pro_app_asleep());
    fw_update_ui_begin("0.1.2", "0.1.3");
    CHECK(!pro_app_asleep());                       // a dark glass lights for it
    pro_app_sleep();                                // the idle timer
    CHECK(!pro_app_asleep());
    pro_app_button_press(); pro_app_button_hold();  // the 0.8 s hold
    CHECK(!pro_app_asleep());
    fw_update_ui_restarting("0.1.3");
    pro_app_sleep();
    CHECK(!pro_app_asleep());
    ota_end();
    pro_app_sleep();
    CHECK(pro_app_asleep());                        // over: it may sleep again
}

static void ota_notifications_quiet(void) {
    notif_setup();
    tap(POD_A_OPEN_TAB, 0);
    render();
    const int depth = U.nav.depth;
    fw_update_ui_begin("0.1.2", "0.1.3");
    now += 100;
    pro_app_summary("a3", "t", "Shipped the thing.", NULL, false, true);
    CHECK(BEEPS == 0 && U.model.unread_count == 1 && !U.ban_on);   // in the Inbox, no beep, no banner
    render();
    CHECK(banner() == NULL && U.frame.hit_count == 0 && !U.frame.banner);
    pro_app_summary("a1", "t", "Another.", NULL, false, true);
    CHECK(BEEPS == 0 && U.model.unread_count == 2);
    ota_end();
    CHECK(U.nav.depth == depth);
    now += 100; render();
    CHECK(banner() == NULL && hit(POD_A_INBOX, 0));   // the bell shows them; the banner never came
    // Back to normal afterwards.
    pro_app_summary("a2", "t", "After.", NULL, false, true);
    CHECK(BEEPS == 1 && U.ban_on);
}

static void updated_notice(void) {
    setup();
    WAS_UPDATED = false;
    pro_app_note_update();
    CHECK(!U.notice_on);
    // First boot of an update, the cable not up yet: nothing to see on "Connecting", the notice waits for the link.
    pro_app_link(false, NULL);
    WAS_UPDATED = true;
    pro_app_note_update();
    CHECK(!U.notice_on);
    now = 40000;
    pro_app_link(true, "mac");
    render();
    CHECK(U.notice_on && !strcmp(U.notice, "Updated to 0.1.0") && !U.notice_bad);
    now = 42900; render();
    CHECK(U.notice_on);
    now = 43100; render();
    CHECK(!U.notice_on);
    pro_app_link(false, NULL); pro_app_link(true, "mac");   // once only
    CHECK(!U.notice_on);
    // Already linked when it is noticed: shown at once.
    now = 50000;
    pro_app_note_update();
    CHECK(U.notice_on && !strcmp(U.notice, "Updated to 0.1.0"));
    WAS_UPDATED = false;
}

int main(int argc, char **argv) {
    static const struct { const char *name; void (*run)(void); } tests[] = {
        {"journey", journey}, {"tabs_button_from_everywhere", tabs_button_from_everywhere}, {"recap_drag_scrolls", recap_drag_scrolls},
        {"swipe_steps_panes", swipe_steps_panes}, {"swipe_slow_does_nothing", swipe_slow_does_nothing},
        {"swipe_short_and_diagonal", swipe_short_and_diagonal}, {"swipe_in_talking_aborts_first", swipe_in_talking_aborts_first},
        {"swipe_from_the_transport_is_ignored", swipe_from_the_transport_is_ignored},
        {"swipe_on_tabs_and_tab_does_nothing", swipe_on_tabs_and_tab_does_nothing}, {"swipe_does_not_scroll_the_recap", swipe_does_not_scroll_the_recap},
        {"swipe_sends_no_host_scroll", swipe_sends_no_host_scroll},
        {"next_from_talking_aborts", next_from_talking_aborts},
        {"prev_and_back_from_talking_abort", prev_and_back_from_talking_abort},
        {"talk_over_leaves_quietly", talk_over_leaves_quietly},
        {"drag_scrolls_tab_and_is_not_a_tap", drag_scrolls_tab_and_is_not_a_tap}, {"drag_follows_and_snaps", drag_follows_and_snaps}, {"flick_turns_the_page", flick_turns_the_page},
        {"drag_is_not_a_tap_and_a_tap_is", drag_is_not_a_tap_and_a_tap_is}, {"grid_ends_rubber_band", grid_ends_rubber_band},
        {"grid_caught_while_settling", grid_caught_while_settling}, {"one_page_does_not_move", one_page_does_not_move},
        {"tap_cover_opens_tab", tap_cover_opens_tab},
        {"release_off_the_hit_cancels", release_off_the_hit_cancels},
        {"panel_turn", panel_turn}, {"pet_clock", pet_clock}, {"pet_wakes_at_next_step", pet_wakes_at_next_step}, {"ribbon_wakes", ribbon_wakes},
        {"roster_after_swarms_rebuilds_tabs", roster_after_swarms_rebuilds_tabs},
        {"moved_agent_reaches_the_model", moved_agent_reaches_the_model},
        {"recap_flips_to_agent_when_work_starts", recap_flips_to_agent_when_work_starts},
        {"library_fills_other_tabs", library_fills_other_tabs}, {"sweep_schedule", sweep_schedule},
        {"notice_shows_three_seconds", notice_shows_three_seconds}, {"link_drop_keeps_the_stack", link_drop_keeps_the_stack},
        {"send_before_recorder_started", send_before_recorder_started}, {"cap_leaves_talking", cap_leaves_talking},
        {"tap_resolves_by_id", tap_resolves_by_id}, {"utf8_cuts", utf8_cuts}, {"clock_wrap", clock_wrap}, {"equaliser_wakes_fast", equaliser_wakes_fast}, {"small_cable_stack", small_cable_stack},
        {"activity_text_is_stable_through_the_real_cadence", activity_text_is_stable_through_the_real_cadence},
        {"follow_from_tabs", follow_from_tabs}, {"follow_from_another_agent", follow_from_another_agent}, {"follow_same_agent_is_a_no_op", follow_same_agent_is_a_no_op},
        {"follow_ignored_while_talking", follow_ignored_while_talking}, {"follow_waits_out_the_users_touch", follow_waits_out_the_users_touch},
        {"follow_pends_until_the_agent_arrives", follow_pends_until_the_agent_arrives},
        {"follow_first_focus_after_opening_tabs_by_tap", follow_first_focus_after_opening_tabs_by_tap},
        {"follow_waits_for_a_finger_on_tabs", follow_waits_for_a_finger_on_tabs},
        {"follow_other_tab_then_the_app_switches", follow_other_tab_then_the_app_switches},
        {"follow_other_tab_agent_only_in_the_new_roster", follow_other_tab_agent_only_in_the_new_roster},
        {"follow_after_the_switch", follow_after_the_switch}, {"offline_member_through_the_glue", offline_member_through_the_glue},
        {"recap_drag_scrolls_the_host", recap_drag_scrolls_the_host}, {"tab_drag_does_not_scroll_the_host", tab_drag_does_not_scroll_the_host},
        {"pro_app_test_link_drop", pro_app_test_link_drop}, {"pro_app_test_step_after_done", pro_app_test_step_after_done},
        {"pro_app_test_new_turn_only", pro_app_test_new_turn_only}, {"pro_app_test_verb_activity_cadence", pro_app_test_verb_activity_cadence},
        {"pro_app_test_turn_gates", pro_app_test_turn_gates}, {"pro_app_test_summary_and_question", pro_app_test_summary_and_question},
        {"pro_app_test_sweep_retries", pro_app_test_sweep_retries}, {"pro_app_test_voice_gate", pro_app_test_voice_gate},
        {"pro_app_test_voice_paths", pro_app_test_voice_paths}, {"pro_app_test_touch_rules", pro_app_test_touch_rules},
        {"pro_app_test_roster_and_swarms", pro_app_test_roster_and_swarms}, {"side_button", side_button}, {"question_needs_the_link", question_needs_the_link},
        {"notify_banner_beep_and_expiry", notify_banner_beep_and_expiry}, {"notify_tap_opens_and_swipe_dismisses", notify_tap_opens_and_swipe_dismisses},
        {"notify_never_over_talk", notify_never_over_talk}, {"notify_replace_seen_and_read", notify_replace_seen_and_read},
        {"ota_screen_and_touch", ota_screen_and_touch}, {"voice_refused_while_updating", voice_refused_while_updating},
        {"update_gate", update_gate}, {"ota_failed_returns", ota_failed_returns}, {"ota_keeps_awake", ota_keeps_awake},
        {"ota_notifications_quiet", ota_notifications_quiet}, {"updated_notice", updated_notice},
    };
    for (unsigned i = 0; i < sizeof tests / sizeof tests[0]; i++)
        if (argc == 1 || !strcmp(argv[1], tests[i].name)) { tests[i].run(); printf("PASS %s\n", tests[i].name); }
    return 0;
}
'''


def test_turn_is_applied_once():
    """The 180 turn lives in pro_display.c (picture and touch). Nothing in main/app turns a contact again."""
    display = (DISP / "pro_display.c").read_text()
    turn = (DISP / "pro_turn.h").read_text()
    frame = (DISP / "pro_frame.c").read_text()
    assert display.count("pro_turn_coord(tx)") == 1 and display.count("pro_turn_coord(ty)") == 1, \
        "pro_display.c must turn the contact once"
    assert display.count("pro_turn_pixels(") == 1 and display.count("pro_turn_rect(") == 1, \
        "pro_display.c must turn the picture once (pixels in place, rectangle mapped)"
    assert "POD_PANEL_TURN == 180" in turn and "PRO_TURN_PX - 1 - v" in turn, "pro_turn.h holds the turn rules"
    assert "POD_PANEL_TURN" not in frame and "pro_turn" not in frame, \
        "the turn rules live in pro_turn.h only; pro_frame.c paints upright"
    for source in list(APP.glob("*.c")) + list(APP.glob("*.h")):
        if source.name == "pod_turn.h":
            continue
        text = source.read_text()
        assert "pod_turn_coord" not in text and "POD_PANEL_TURN" not in text, \
            f"{source.name} must not turn the glass: pro_display.c does, once"


test_turn_is_applied_once()

cc = os.environ.get("CC", "cc")
sanitize = "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds")
include = ["-I", str(APP), "-I", str(MAIN), "-I", str(DISP), "-I", str(HERE / "host_esp"), "-I", str(HERE / "host_stubs"),
           "-I", str(POD)]
failures = []
with tempfile.TemporaryDirectory(prefix="harness-pro-app-") as directory:
    directory = Path(directory)
    fonts = directory / "pro_fonts.c"
    font_args = []
    if os.environ.get("PRO_FONT"):
        font = Path(os.environ["PRO_FONT"])
        font_args = ["--font", str(font if font.is_absolute() else FW / font)]
    subprocess.run([sys.executable, str(FW / "scripts" / "gen_fonts.py"), *font_args, "--out", str(fonts)], check=True)
    source = directory / "pro_app_test.c"
    source.write_text(code)
    modules = sorted(POD.glob("*.c")) + [APP / "pod_glue.c", APP / "pro_app.c", APP / "pro_touch.c", DISP / "scroll.c",
                                         DISP / "pro_canvas.c", DISP / "terminal.c", fonts]
    for label, extra in (("upright", []), ("turned 180", ["-DPOD_PANEL_TURN=180"])):
        # The callbacks run on the cable_link task's 6 KB stack, the touch task's contact path on 10 KB: no frame of
        # pro_app.c, pro_touch.c or the glue may pass 1 KB.
        for guarded in (APP / "pod_glue.c", APP / "pro_app.c", APP / "pro_touch.c"):
            subprocess.run([cc, "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wframe-larger-than=1024", "-O1", "-DHT_FACE_PX=720",
                            *extra, *include, "-c", str(guarded), "-o", os.devnull], check=True)
        executable = directory / ("pro_app_" + label.split()[0])
        command = [cc, "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-O1", "-g", sanitize,
                   "-DHT_FACE_PX=720", *extra, *include, str(source), *map(str, modules), "-lpthread", "-o", str(executable)]
        subprocess.run(command, check=True)
        result = subprocess.run([str(executable)], text=True, capture_output=True)
        print(f"[{label}]")
        print(result.stdout.strip())
        if result.returncode:
            failures.append(label)
            print(f"FAIL {label}: {result.stderr.strip()}")
assert not failures, f"pro_app regressions: {', '.join(failures)}"
print("pro_app: production-glue replays passed (upright and POD_PANEL_TURN=180)")
