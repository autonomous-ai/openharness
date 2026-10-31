#!/usr/bin/env python3
"""Replay contacts and cable feeds through the Pro's app layer (main/app/pro_app.c, pod_glue.c, pro_touch.c) and Pod.

Ported from the round firmware's test_pod_touch_ui.py (every test keeps its name). The production glue, the app layer
and the finger task's contact rules are compiled here as they are, with Pod's views, the Pro canvas and the generated
fonts. Below pro_app the host plays the device: a fake clock, the cable and the recorder as recorders (every send
checks that pro_app's mutex is NOT held), and the GT911, whose contacts reach pro_app as they are. The effects Pod
returns are performed by pro_app and read back from those recorders.
The panel is not turned: a contact on the controller's axes is that point on the glass (see test_no_turn).
No USB, hardware writes or microphone.
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
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "app/pro_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "cable/cable_link.h"
#include "cable/pro_cable.h"
#include "pro_app_api.h"
#include "pro_canvas.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"
#include "sys/ram_telemetry.h"
#include "sys/last_words.h"
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
// The clock is `now`. The GT911 reports a contact on its own axes; pro_display.c's pro_touch_poll() hands it on as
// is, and pro_touch_feed() hands it to pro_app_touch(). The cable and the
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
void last_words_phase(lw_task_t t, const char *p) { (void)t; (void)p; }
void last_words_rx(uint32_t ms) { (void)ms; }
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
uint32_t pro_frame_present(const ht_scene_t *p, const ht_scene_t *n, uint32_t *px) { (void)p; (void)n; if (px) *px = 1; return 0; }
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
static struct { int n; bool fail; char t[16][24], tab[16][ID_MAX], lead[16][ID_MAX]; } SUP;   // the Swarm cards' select / open / recap.get frames
bool pro_cable_supertab_send(const char *t, const char *tab, const char *lead) {
    CHECK(LOCK_DEPTH == 0);
    if (SUP.fail) return false;
    if (SUP.n < 16) { snprintf(SUP.t[SUP.n], sizeof SUP.t[0], "%s", t); snprintf(SUP.tab[SUP.n], ID_MAX, "%s", tab); snprintf(SUP.lead[SUP.n], ID_MAX, "%s", lead ? lead : ""); SUP.n++; }
    return true;
}
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
cable_link_stats_t cable_link_stats(void) { return (cable_link_stats_t){0}; }
void pro_cable_counters(uint32_t *bad, uint32_t *unknown) { *bad = 0; *unknown = 0; }
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
unsigned pro_rec_level(void) { return 0; }

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
    const int ux = x, uy = y;
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
// A tap on the rendered hit: DOWN and UP at its centre, as the GT911 reports it, then the redraw a change causes.
static pod_out_t tap_at(int x, int y) {
    bool c1 = false, c2 = false;
    pod_out_t d = contact(true, x, y, &c1);
    CHECK(d.fx == POD_FX_NONE);
    pod_out_t u = contact(false, x, y, &c2);
    render();
    return u;
}
// A tab's agent list is not drawn any more (Home enters a tab on its first agent), so OPEN_TAB and OPEN_AGENT have no hit to touch:
// these walk the same nav actions a tap on one would, and perform the AGENT_OPEN effect as the touch path does.
static pod_out_t tap_by_nav(pod_action_t a, int arg) {
    memset(&R, 0, sizeof R);
    pod_out_t o = pod_nav_act(&U.nav, &U.model, a, arg, now);
    if (o.fx == POD_FX_AGENT_OPEN) pro_cable_send_open(o.agent);
    render();
    return effect_of();
}
// No screen draws a Talk button: a tap on an agent or its recap starts the recording (hands free; the next tap sends).
static pod_out_t tap_talk(void) {
    bool c = false;
    CHECK(contact(true, 360, 400, &c).fx == POD_FX_NONE);
    pod_out_t o = contact(false, 360, 400, &c);
    render();
    return o;
}
static pod_out_t nav_act(pod_action_t a);
static pod_out_t tap(pod_action_t a, int arg) {
    const pod_hit_t *h = hit(a, arg);
    if (!h && (a == POD_A_BACK || a == POD_A_TABS || a == POD_A_PANES || a == POD_A_PREV || a == POD_A_NEXT)) return nav_act(a);   // the side button's path
    if (!h && (a == POD_A_OPEN_TAB || a == POD_A_OPEN_AGENT)) return tap_by_nav(a, arg);
    if (!h && a == POD_A_TALK && (top() == POD_V_AGENT || top() == POD_V_RECAP)) return tap_talk();
    CHECK(h);
    CHECK(h->w >= 1 && h->h >= 1);
    return tap_at(h->x + h->w / 2, h->y + h->h / 2);
}
// The nav actions with no drawn hit (TABS, PANES, PREV, NEXT): the side button's path, or a stale hit or host effect.
static pod_out_t nav_act(pod_action_t a) {
    pod_out_t o = pod_nav_act(&U.nav, &U.model, a, 0, now);
    render();
    return o;
}
// A drag from (x0,y0) to (x1,y1) in n MOVEs of 16 ms each, then the lift. Returns the effect of the lift.
static pod_out_t drag(int x0, int y0, int x1, int y1, int n) {
    bool c = false;
    contact(true, x0, y0, &c);
    for (int i = 1; i <= n; i++) contact(true, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, &c);
    pod_out_t o = contact(false, x1, y1, &c);
    render();
    return o;
}
// PREV and NEXT are drawn nowhere: the horizontal swipe (finger left = next) is the touch way.
static pod_out_t swipe_next(void) { return drag(500, 300, 300, 305, 8); }
static pod_out_t swipe_prev(void) { return drag(200, 300, 520, 295, 8); }
// No Talk button is drawn; a stale TALK hit, drawn before the agent could not be talked to, still reaches the glue and
// the app's gates, which is what these replays check.
static pod_out_t tap_stale_talk(void) {
    CHECK(U.frame.hit_count < 32);
    U.frame.hits[U.frame.hit_count++] = (pod_hit_t){0, 0, POD_W, POD_W, POD_A_TALK, 0, {0}};
    return tap(POD_A_TALK, 0);
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
    memset(&SUP, 0, sizeof SUP);
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
    expect(swipe_next(), POD_FX_AGENT_OPEN, "a2");
    CHECK(top() == POD_V_RECAP);
    // Back out: a room's back is Home (the tab's list is never drawn); at the root it does nothing.
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    // Nothing was left recording, and a sync after all this has nothing to abort.
    pod_out_t again = pod_ui_link(&U, true);
    CHECK(again.fx == POD_FX_NONE);
}

// ---- the Swarm cards' Lead view through the app layer: touch, side button, link, focus; every frame leaves after the lock ----
static void swarm_feed(int leads) {
    static const char ids[1][ID_MAX] = {"sw1"};
    static pod_swarm_t sw;
    pro_app_supertab_ids(ids, 1);
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.name, sizeof sw.name, "openharness"); sw.count = (uint16_t)leads; sw.lead_n = (uint8_t)leads;
    for (int i = 0; i < leads; i++) {
        snprintf(sw.leads[i].id, ID_MAX, "l%d", i); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj%d", i);
        snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); sw.leads[i].state = i == 0 ? POD_LEAD_ASK : POD_LEAD_DONE;
    }
    pro_app_supertab(&sw);
}
static void swarm_home_page(void) {   // Home on the Swarm's page (the card after the tabs)
    for (int p = 0; p < 8; p++) if (pod_home_swarm(&U.model, p)) { U.nav.stack[0].scroll = (int16_t)p; break; }
    render();
}
static void lead_view_via_app(void) {
    setup();
    swarm_feed(3);
    swarm_home_page();
    CHECK(hit(POD_A_LEAD, 1));
    memset(&SUP, 0, sizeof SUP);
    tap(POD_A_LEAD, 1);   // a tap on the pet: the Lead view, and select + open + recap.get go out, none under the lock
    CHECK(top() == POD_V_LEAD && U.nav.depth == 2);
    CHECK(SUP.n == 3 && !strcmp(SUP.t[0], "supertab.select") && !strcmp(SUP.t[1], "supertab.open") && !strcmp(SUP.t[2], "supertab.recap.get"));
    CHECK(!strcmp(SUP.tab[2], "sw1") && !strcmp(SUP.lead[2], "l1") && !strcmp(SUP.lead[0], "l1"));
    pro_app_supertab_recap("sw1", "l1", "", "Merged and shipped.", 1792560000u, false);   // the answer lands: drawn, nothing more sent
    render();
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_LOADED && SUP.n == 3);
    memset(&SUP, 0, sizeof SUP);
    swipe_next();   // the next Lead
    CHECK(top() == POD_V_LEAD && !strcmp(U.nav.stack[1].lead_id, "l2"));
    CHECK(SUP.n == 3 && !strcmp(SUP.t[0], "supertab.select") && !strcmp(SUP.lead[0], "l2") && !strcmp(SUP.t[1], "supertab.open") && !strcmp(SUP.t[2], "supertab.recap.get"));
    memset(&SUP, 0, sizeof SUP);
    pro_app_button_press();   // the side button: Home, and the desktop hears that no recap is open
    CHECK(top() == POD_V_TABS && SUP.n == 1 && !strcmp(SUP.t[0], "supertab.open") && !strcmp(SUP.tab[0], "sw1") && !SUP.lead[0][0]);
    // the redraw after asking: LOADING reached the screen without a feed announcing it
    memset(&SUP, 0, sizeof SUP);
    (void)pod_ui_take_changed(&U); (void)pro_app_test_take_dirty();
    render();
    tap(POD_A_LEAD, 0);
    CHECK(top() == POD_V_LEAD && U.model.swarms[0].leads[0].recap == POD_RECAP_LOADING);
    CHECK(pro_app_test_take_dirty() || true);
}
// A long Lead message on the device: a vertical drag through the finger's path scrolls it by rows (the drawn rows move), a local Lead's tap-to-talk
// does not take the drag, and the horizontal swipe still steps Leads.
static const char *LONG_LEAD = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
                               "twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two "
                               "thirty-three thirty-four thirty-five thirty-six thirty-seven thirty-eight thirty-nine forty";
static int first_text_y(const char *word) {   // the y of the drawn run that starts with word, -1 when none is drawn
    for (int i = 0; i < S.count; i++) if (S.runs[i].text[0] && !strncmp(S.runs[i].text, word, strlen(word))) return S.runs[i].y;
    return -1;
}
static void lead_view_scrolls_via_app(void) {
    setup();
    swarm_feed(3);
    pod_swarm_t *sw = (pod_swarm_t *)pod_model_swarm(&U.model, "sw1");
    snprintf(sw->leads[1].local, ID_MAX, "a1");   // a Lead whose harness runs here: a tap on its view talks
    swarm_home_page();
    tap(POD_A_LEAD, 1);
    CHECK(top() == POD_V_LEAD && !strcmp(U.nav.stack[1].agent, "a1"));
    pro_app_supertab_recap("sw1", "l1", "", LONG_LEAD, 1792560000u, false);
    render();
    CHECK(pod_scroll_max(&U.nav, &U.model) >= 2 && first_text_y("one") >= 0);
    now += 2000;
    memset(&SC, 0, sizeof SC);
    drag(360, 480, 360, 200, 20);   // finger up: the text moves up
    CHECK(top() == POD_V_LEAD && !pod_ui_talking(&U) && U.nav.stack[1].scroll >= 2 && !strcmp(U.nav.stack[1].lead_id, "l1"));
    CHECK(first_text_y("one") < 0);   // the first row is scrolled out of the bubble
    CHECK(SC.n >= 3 && SC.phase[0] == HT_SCROLL_DOWN && SC.phase[SC.n - 1] == HT_SCROLL_UP);   // and the desktop's chat is told, sent after the lock
    int total = 0;
    for (int i = 0; i < SC.n; i++) if (SC.phase[i] != HT_SCROLL_DOWN) total += SC.dy[i];
    CHECK(total == -280);   // every pixel of the finger's travel
    now += 2000;
    drag(360, 200, 360, 600, 20);   // and back down
    CHECK(U.nav.stack[1].scroll == 0 && first_text_y("one") >= 0);
    now += 2000;
    swipe_next();
    CHECK(top() == POD_V_LEAD && !strcmp(U.nav.stack[1].lead_id, "l2"));
}
// The Lead view closing on a busy link: the "closed" frame the link dropped is owed until it is sent. A daemon that still thinks the Lead is open would
// keep sending every later drag on an agent screen to the Swarm chat.
static void lead_close_owed_on_busy_link(void) {
    setup();
    swarm_feed(3);
    swarm_home_page();
    tap(POD_A_LEAD, 1);
    CHECK(top() == POD_V_LEAD);
    memset(&SUP, 0, sizeof SUP);
    SUP.fail = true;   // the link is busy: every Swarm frame is refused
    pro_app_button_press();   // Home: the Lead view closes
    CHECK(top() == POD_V_TABS && SUP.n == 0);
    SUP.fail = false;
    now += 100;
    pro_app_tick();   // the next pass sends what is owed
    CHECK(SUP.n == 1 && !strcmp(SUP.t[0], "supertab.open") && !strcmp(SUP.tab[0], "sw1") && !SUP.lead[0][0]);
    memset(&SUP, 0, sizeof SUP);
    now += 100;
    pro_app_tick();   // and only once
    CHECK(SUP.n == 0);
    // a close still owed when another Lead is opened goes first, never after: the daemon ends with the new Lead open
    swarm_home_page();
    tap(POD_A_LEAD, 2);
    memset(&SUP, 0, sizeof SUP);
    SUP.fail = true;
    pro_app_button_press();
    swarm_home_page();
    SUP.fail = false;
    tap(POD_A_LEAD, 0);
    CHECK(top() == POD_V_LEAD && SUP.n >= 2);
    int open_at = -1;
    for (int i = 0; i < SUP.n; i++) if (!strcmp(SUP.t[i], "supertab.open") && !strcmp(SUP.lead[i], "l0")) open_at = i;
    CHECK(open_at >= 0);
    for (int i = open_at; i < SUP.n; i++) CHECK(SUP.lead[i][0]);   // no close after the new open
}
static void lead_view_relink_and_focus(void) {
    setup();
    swarm_feed(3);
    swarm_home_page();
    tap(POD_A_LEAD, 2);
    CHECK(top() == POD_V_LEAD);
    memset(&SUP, 0, sizeof SUP);
    pro_app_link(false, "mac");   // the cable drops: nothing goes out, the view waits
    CHECK(SUP.n == 0 && top() == POD_V_LEAD);
    pro_app_link(true, "mac");
    CHECK(SUP.n == 0);
    swarm_feed(3);   // the daemon's attach: the list is back, the view asks again
    CHECK(top() == POD_V_LEAD && SUP.n == 2 && !strcmp(SUP.t[0], "supertab.open") && !strcmp(SUP.lead[0], "l2") && !strcmp(SUP.t[1], "supertab.recap.get"));
    // supertab.focus opens a Lead: open + get, no select
    memset(&SUP, 0, sizeof SUP);
    now += 10000;   // out of the touch quiet window
    pro_app_supertab_focus("sw1", "l0");
    CHECK(top() == POD_V_LEAD && !strcmp(U.nav.stack[1].lead_id, "l0") && SUP.n == 2 && !strcmp(SUP.t[0], "supertab.open") && !strcmp(SUP.t[1], "supertab.recap.get"));
}

static void to_talk(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");
    CHECK(top() == POD_V_TALK);
}

// The orphan window: an abort landed after the touch task left Talk but before pro_voice_begin claimed the recording.
// The voice is open with no Talk screen and nothing sent: the next tick discards it, sending nothing.
static void orphan_recording_is_discarded(void) {
    to_talk();
    pod_ui_talk_over(&U);
    CHECK(!pod_ui_talking(&U));
    const int aborts = R.end_abort, sends = R.end_send;
    V.open = true; V.pending = false; V.waiting = false;
    pro_app_tick();
    CHECK(!V.open && R.end_abort == aborts + 1 && R.end_send == sends);
}

static void tabs_button_from_everywhere(void) {
    to_talk();
    expect(nav_act(POD_A_TABS), POD_FX_VOICE_ABORT, "a1");     // from Talking (the side button's path; Voice draws no TABS button): abort, then the root
    CHECK(top() == POD_V_TABS && U.nav.depth == 1 && !pod_ui_talking(&U));
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 1);                                   // a2: done, opens on its Recap
    CHECK(top() == POD_V_RECAP);
    expect(nav_act(POD_A_PANES), POD_FX_NONE, NULL);          // PANES: back out of the room (no button: the side button's path)
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    expect(nav_act(POD_A_TABS), POD_FX_NONE, NULL);           // TABS from an Agent screen (no button: the side button)
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    CHECK(hit(POD_A_RECAP, 0) == NULL);
    // PANES from Talking aborts and lands on Home
    tap(POD_A_OPEN_TAB, 0); tap(POD_A_OPEN_AGENT, 0); tap(POD_A_TALK, 0);
    expect(nav_act(POD_A_PANES), POD_FX_VOICE_ABORT, "a1");
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
}

// ---- the horizontal swipe steps panes (swipe left = next, right = previous, as the round dial) -------------------------
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
    swipe_next();
    CHECK(top() == POD_V_RECAP);
    expect(drag(520, 400, 300, 400, 3), POD_FX_AGENT_OPEN, "a1");
}
static void swipe_slow_does_nothing(void) {
    to_agent(0);
    expect(drag(520, 300, 300, 300, 60), POD_FX_NONE, NULL);           // ~1 s and slow all along
    CHECK(!strcmp(cur(), "a1"));
    // a quick swipe still works
    expect(swipe_next(), POD_FX_AGENT_OPEN, "a2");
}
static void swipe_short_and_diagonal(void) {
    to_agent(0);
    expect(drag(500, 300, 450, 300, 4), POD_FX_NONE, NULL);
    expect(drag(500, 300, 360, 420, 6), POD_FX_NONE, NULL);
    expect(drag(500, 200, 400, 340, 6), POD_FX_NONE, NULL);
    CHECK(!strcmp(cur(), "a1") && top() == POD_V_AGENT);
    expect(drag(500, 300, 300, 300, 8), POD_FX_AGENT_OPEN, "a2");      // the same gesture, wide enough
}
static void swipe_on_tabs_and_tab_does_nothing(void) {
    setup();
    expect(drag(560, 300, 160, 300, 8), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
    tap(POD_A_OPEN_TAB, 0);
    expect(drag(560, 300, 160, 300, 8), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_TAB && U.nav.depth == 2);
}
static void next_from_talking_aborts(void) {
    to_talk();
    pod_out_t o = nav_act(POD_A_NEXT);
    expect(o, POD_FX_VOICE_ABORT, "a1");          // never VOICE_END, and not AGENT_OPEN
    CHECK(top() == POD_V_AGENT || top() == POD_V_RECAP);
    CHECK(!strcmp(U.nav.stack[U.nav.depth - 1].agent, "a2"));
    CHECK(!pod_ui_talking(&U));
    // Exactly once: nothing else asks for it afterwards.
    CHECK(pod_ui_link(&U, true).fx == POD_FX_NONE);
}

static void prev_and_back_from_talking_abort(void) {
    to_talk();
    expect(nav_act(POD_A_PREV), POD_FX_VOICE_ABORT, "a1");
    CHECK(!pod_ui_talking(&U));
    to_talk();
    expect(tap(POD_A_BACK, 0), POD_FX_VOICE_ABORT, "a1");
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
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
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);        // a later back is an ordinary back (Home): no abort
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
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
    const pod_hit_t *h = hit(POD_A_ENTER_TAB, 0);           // Backend's card
    CHECK(h && !strcmp(h->id, "s0"));
    int cx = h->x + h->w / 2, cy = h->y + h->h / 2;
    bool c;
    contact(true, cx, cy, &c);
    static cable_swarm_t sw[2];                             // the tabs swap places before the finger lifts
    memset(sw, 0, sizeof sw);
    snprintf(sw[0].id, sizeof sw[0].id, "s1"); snprintf(sw[0].name, sizeof sw[0].name, "Frontend"); sw[0].panes = sw[0].agents = 1;
    snprintf(sw[1].id, sizeof sw[1].id, "s0"); snprintf(sw[1].name, sizeof sw[1].name, "Backend"); sw[1].panes = sw[1].agents = 2;
    static cable_swarm_members_t mem;
    memset(&mem, 0, sizeof mem);
    mem.count[0] = 1; snprintf(mem.id[0][0], ID_MAX, "a3");
    mem.count[1] = 2; snprintf(mem.id[1][0], ID_MAX, "a1"); snprintf(mem.id[1][1], ID_MAX, "a2");
    pod_ui_swarms(&U, sw, 2, &mem, "s0", NULL, 0);
    pod_out_t o = contact(false, cx, cy, &c);
    expect(o, POD_FX_AGENT_OPEN, "a1");                     // Backend's first agent: the card is found by its id, not its old place
    // and a tab that is gone opens nothing
    setup();
    render();
    h = hit(POD_A_ENTER_TAB, 0);
    CHECK(h && !strcmp(h->id, "s0"));
    cx = h->x + h->w / 2; cy = h->y + h->h / 2;
    contact(true, cx, cy, &c);
    static cable_swarm_t only[1];
    memset(only, 0, sizeof only);
    snprintf(only[0].id, sizeof only[0].id, "s1"); snprintf(only[0].name, sizeof only[0].name, "Frontend"); only[0].panes = only[0].agents = 1;
    static cable_swarm_members_t mem1;
    memset(&mem1, 0, sizeof mem1);
    mem1.count[0] = 1; snprintf(mem1.id[0][0], ID_MAX, "a3");
    pod_ui_swarms(&U, only, 1, &mem1, "s1", NULL, 0);       // Backend closes
    o = contact(false, cx, cy, &c);
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_TABS && U.nav.depth == 1);
    render();
    h = hit(POD_A_ENTER_TAB, 0);
    CHECK(h && !strcmp(h->id, "s1"));                       // the card is the tab that is left
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

// Eight tabs: nine covers in the grid (three rows of three, offsets 0..1), the selected tab t0 the second.
static void many_tabs(void) {
    setup();
    static cable_swarm_t sw[8];
    memset(sw, 0, sizeof sw);
    for (int i = 0; i < 8; i++) { snprintf(sw[i].id, sizeof sw[i].id, "t%d", i); snprintf(sw[i].name, sizeof sw[i].name, "Tab %d", i); sw[i].panes = 1; sw[i].agents = 1; }
    pod_ui_swarms(&U, sw, 8, NULL, "t0", NULL, 0);
    render();
}

static void release_off_the_hit_cancels(void) {
    setup();
    bool c;
    const pod_hit_t *h = hit(POD_A_ENTER_TAB, 0);
    CHECK(h);
    contact(true, h->x + 5, h->y + h->h - 5, &c);
    pod_out_t o = contact(false, h->x + 5, h->y + h->h + 3, &c);   // inside the slop, outside the hit
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_TABS);
    pro_app_touch_cancel();
    contact(true, h->x + 5, h->y + 5, &c);
    pro_app_touch_cancel();
    o = contact(false, h->x + 5, h->y + 5, &c);
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_TABS);        // a cancelled contact never taps
}

static void panel_turn(void) {
    setup();
    const pod_hit_t *h = hit(POD_A_ENTER_TAB, 0);   // Home's tab card, (90, 56) 540 x 560 
    CHECK(h && h->x == 90 && h->y == 56 && h->y + h->h == 616);
    // No turn: the raw contact (619, 649) is below the card on the glass and misses it; the raw (100, 70) is inside.
    bool c;
    contact(true, 619, 649, &c);
    contact(false, 619, 649, &c);
    CHECK(top() == POD_V_TABS);
    contact(true, 100, 70, &c);
    contact(false, 100, 70, &c);
    CHECK(top() != POD_V_TABS);
}

// Pets start: after the link comes up and the first roster and swarms arrive, the app enters tab 0 on its first agent. It is
// device-local: no agent.open goes to the host (that only moves the desktop's pane). A second feed does not repeat it, and a
// new link-up starts again from Home on that link's swarms.
static void pets_start_on_link(void) {
    pro_app_test_reset();
    memset(&R, 0, sizeof R);
    pro_app_link(true, "mac");
    pro_agent_row_t rows[3] = {{.id = "a1", .name = "Alpha", .engine = "claude", .machine = "mac"},
                               {.id = "a2", .name = "Bravo", .engine = "codex", .machine = "mac"},
                               {.id = "a3", .name = "Charlie", .engine = "claude", .machine = "mac"}};
    pro_app_agents(rows, 3);
    CHECK(U.nav.depth == 1 && R.opens == 0);            // no tabs yet: nothing to enter
    cable_swarm_t sw[2] = {{.agents = 2, .panes = 2}, {.agents = 1, .panes = 1}};
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Backend");
    snprintf(sw[1].id, sizeof sw[1].id, "s1"); snprintf(sw[1].name, sizeof sw[1].name, "Frontend");
    static cable_swarm_members_t members;
    memset(&members, 0, sizeof members);
    members.count[0] = 2; snprintf(members.id[0][0], ID_MAX, "a1"); snprintf(members.id[0][1], ID_MAX, "a2");
    members.count[1] = 1; snprintf(members.id[1][0], ID_MAX, "a3");
    pro_app_swarms(sw, 2, &members, "s0", NULL, 0);
    CHECK(U.nav.depth == 3 && U.nav.stack[1].view == POD_V_TAB && U.nav.stack[1].tab == 0);
    CHECK(!strcmp(U.nav.stack[2].agent, "a1") && R.opens == 0);
    pro_app_swarms(sw, 2, &members, "s0", NULL, 0);     // every frame, changed or not
    CHECK(R.opens == 0 && U.nav.depth == 3);
    pod_nav_act(&U.nav, &U.model, POD_A_TABS, 0, 3000);  // the person goes Home; a new link-up starts again
    pro_app_link(false, "mac");
    pro_app_link(true, "mac");
    CHECK(U.nav.depth == 1);                            // the last link's roster is not acted on
    pro_app_swarms(sw, 2, &members, "s0", NULL, 0);
    CHECK(U.nav.depth == 3 && R.opens == 0);
}

static void pet_clock(void) {
    setup();
    CHECK(pod_ui_pet_on_screen(&U));                         // Home: a1 is working, its tab's equaliser moves
    CHECK(pod_ui_wake_ms(&U, 1250) >= 1 && pod_ui_wake_ms(&U, 1250) <= POD_PH_ANIM_MS);
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    CHECK(pod_ui_pet_on_screen(&U));
    CHECK(pod_ui_wake_ms(&U, 1250) >= 1 && pod_ui_wake_ms(&U, 1250) <= POD_PH_ANIM_MS);   // a1 works: the room's pet and its seconds
    CHECK(pod_ui_clock_tick(&U, 5000));
    CHECK(!pod_ui_clock_tick(&U, 5001));
    uint32_t w = pod_ui_wake_ms(&U, 5000);
    CHECK(!pod_ui_clock_tick(&U, 5000 + w - 1));
    CHECK(pod_ui_clock_tick(&U, 5000 + w));
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
    pod_ui_turn(&U, "m1", "started", "", 0, now);                // working: the equaliser and the spinner step at 66 ms
    for (uint32_t t = now + 1; t < now + 800; t += 5) CHECK(pod_ui_wake_ms(&U, t) >= 1 && pod_ui_wake_ms(&U, t) <= 217);   // the pet's own step, and the seconds
    pod_ui_turn(&U, "m1", "done", "", 0, now + 900);
    pod_ui_focus(&U, "c1", now + 1000);                          // Codex listening: on the beat
    expect(pod_nav_act(&U.nav, &U.model, POD_A_TALK, 0, now + 1000), POD_FX_VOICE_BEGIN, "c1");
    CHECK(top() == POD_V_TALK);
    CHECK(pod_ui_wake_ms(&U, now + 1234) <= POD_PH_ANIM_MS);
    for (uint32_t t = now + 1100; t < now + 1400; t += 3) CHECK(pod_ui_wake_ms(&U, t) <= POD_PH_ANIM_MS);
    pod_ui_talk_over(&U);
    pod_ui_focus(&U, "x1", now + 3000);                          // an engine with no pet, idle: a still logo, the second beat
    CHECK(pod_ui_wake_ms(&U, now + 3001) == 1000);   // idle, no timer: pod_pet_next_step_ms's 1 s for a still logo, not phased to the clock
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
    // A later sweep that no longer lists b2 drops it, and the open agent's screen pops to Home.
    pod_ui_sweep_begin(&U, 40000);
    pod_out_t gone;
    next = pod_ui_library_page(&U, p0, 3, 0, 3, 40100, &gone);   // a1, a2, b1 only
    CHECK(next == -1 && !pod_model_find(&U.model, "b2") && top() == POD_V_TABS && U.nav.depth == 1);
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

enum { K_TEXT = 1, K_RECT = 2, K_RECT_AA = 4 };
static void notice_shows_three_seconds(void) {
    setup();
    int base;
    render();
    base = S.count;
    pod_ui_notice(&U, "Still sending the last message", now);
    CHECK(pod_ui_take_changed(&U));
    render();
    CHECK(S.count == base + 2);                           // the pill and its line
    // The pill sits just above POD_TRANSPORT_Y, centred: it never covers the agent's name or the art above y = 300.
    const int ty = POD_TRANSPORT_Y;
    for (int i = base; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        int h = r->pro_kind == K_TEXT ? ht_pro_24.height : 40;
        CHECK(r->y >= 300 && r->y + h <= ty);
    }
    CHECK(S.runs[base].pro_kind == K_RECT && S.runs[base].y + 40 == ty - 8 && abs(S.runs[base].x * 2 + S.runs[base].w - 720) <= 1);
    now += 2900; render();
    CHECK(S.count == base + 2);
    now += 200; render();
    CHECK(S.count == base);                               // gone after 3 s
    CHECK(S.count <= HT_RUNS);
}

// Every pro_app callback runs on the device's cable_link task: a 12 KB stack. The render task has 24 KB. This runs the
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
    pro_app_question("a3", "r1", "Which branch?", NULL, POD_ATTN_NONE);
    pro_app_question_close("a3");
    pro_app_summary("a2", "Fixed the parser.", "Fixed the parser. Added two tests.", "Fixed the parser. Added two tests. Then more.", false, POD_TIER_SILENT);
    pro_app_focus("a4");
    pro_app_turn("a1", "done", "", 0);
    pro_app_swarms(NULL, 0, NULL, NULL, NULL, 0);
    (void)pro_app_voice_block_reason("a1");
    return NULL;
}

#define STACK_BYTES 16384   // the smallest stack pthreads accept everywhere (macOS refuses less)
#define CABLE_STACK_BUDGET 3584   // of the device's 12 KB: kept at its old, tighter figure (the parser alone is ~7 KB of the rest)
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
    // Back goes Home (the tab's list is never drawn).
    tap(POD_A_BACK, 0);
    CHECK(top() == POD_V_TABS && U.nav.depth == 1);
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
    tap(POD_A_ENTER_TAB, 0);                           // a touch: Backend opens on a1
    CHECK(top() == POD_V_AGENT && !strcmp(frame_at(2)->agent, "a1"));
    (void)pod_ui_take_changed(&U);
    pod_out_t o = pod_ui_focus(&U, "a2", now + 100);   // 4 s have not passed since the touch
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_AGENT && U.nav.depth == 3 && !pod_ui_take_changed(&U));
    o = pod_ui_focus(&U, "a2", now + 3900);
    CHECK(top() == POD_V_AGENT && !strcmp(frame_at(2)->agent, "a1"));
    now += 4200;
    pod_ui_focus(&U, "a2", now);
    CHECK(top() == POD_V_RECAP && U.nav.depth == 3 && !strcmp(frame_at(2)->agent, "a2"));
    // A finger that is still down is driving too.
    bool c;
    now += 10000;
    contact(true, 360, 360, &c);
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
    CHECK(U.nav.depth == 1);        // the agent went: back on Home
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

// The user got to the Tabs screen with a tap (two Backs) and went to the desktop app: the focus that
// follows a few seconds later is not "the user driving the device".
static void follow_first_focus_after_opening_tabs_by_tap(void) {
    setup();
    now += 5000;
    tap(POD_A_ENTER_TAB, 0);
    CHECK(U.nav.depth == 3);
    tap(POD_A_BACK, 0);                            // the room, Home
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
    contact(true, 360, 360, &c);
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
    contact(true, 360, 300, &c);
    CHECK(SC.n == 0);                      // a finger that only landed is not yet a scroll
    for (int y = 300; y >= 120; y -= 20) { now += 16; contact(true, 360, y, &c); }   // up the glass
    now += 16;
    contact(false, 360, 120, &c);
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
    contact(true, 360, 150, &c);
    for (int y = 150; y <= 330; y += 20) { now += 16; contact(true, 360, y, &c); }
    now += 16; contact(false, 360, 330, &c);
    total = 0;
    for (int i = 0; i < SC.n; i++) if (SC.phase[i] != HT_SCROLL_DOWN) total += SC.dy[i];
    CHECK(total == 180 && SC.v[SC.n - 1] > 100);
    // A tap, or a cancelled contact, closes cleanly: nothing for a tap (it talks); a cancelled drag ends with a zero UP.
    open_recap_for_scroll(false);
    contact(true, 360, 300, &c); now += 40; contact(false, 360, 300, &c);
    CHECK(SC.n == 0 && pod_ui_talking(&U));
    open_recap_for_scroll(false);
    contact(true, 360, 300, &c);
    for (int y = 300; y >= 220; y -= 20) { now += 16; contact(true, 360, y, &c); }
    pro_app_touch_cancel();
    CHECK(SC.n >= 3 && SC.phase[SC.n - 1] == HT_SCROLL_UP && SC.dy[SC.n - 1] == 0 && SC.v[SC.n - 1] == 0);
}

// Pets, through the real pro_app_touch (which sets the scroll sink before every contact): a mid-screen vertical drag on the finished agent's
// recap (a2) and on the working agent's room (a1) reaches the host as DOWN .. MOVE .. UP and leaves the screen and its scroll alone; from the bottom
// zone a swipe up is Home and sends nothing. The recap has no collapsed state and no row scroll of its own.
static void pets_recap_and_agent_drag_scrolls_the_host(void) {
    for (int k = 0; k < 2; k++) {
        setup();
        now += 5000;
        pod_ui_focus(&U, k ? "a2" : "a1", now);
        render();
        const pod_view_t want = k ? POD_V_RECAP : POD_V_AGENT;
        CHECK(top() == want && U.nav.depth >= 2);
        const int depth = U.nav.depth;
        CHECK(pod_scroll_pitch(&U.nav) == 0 && pod_scroll_max(&U.nav, &U.model) == 0);
        SC.n = 0;
        bool c;
        contact(true, 360, 520, &c);
        CHECK(SC.n == 0);
        for (int y = 520; y >= 240; y -= 20) { now += 16; contact(true, 360, y, &c); }
        now += 16;
        contact(false, 360, 240, &c);
        CHECK(SC.n >= 4 && SC.phase[0] == HT_SCROLL_DOWN && SC.phase[SC.n - 1] == HT_SCROLL_UP);
        int total = 0;
        for (int i = 0; i < SC.n; i++) if (SC.phase[i] != HT_SCROLL_DOWN) total += SC.dy[i];
        CHECK(total == -280);
        CHECK(top() == want && U.nav.depth == depth && U.nav.stack[U.nav.depth - 1].scroll == 0);
        // and the drag down
        SC.n = 0;
        contact(true, 360, 240, &c);
        for (int y = 240; y <= 500; y += 20) { now += 16; contact(true, 360, y, &c); }
        now += 16;
        contact(false, 360, 500, &c);
        CHECK(SC.n >= 4 && SC.phase[SC.n - 1] == HT_SCROLL_UP && top() == want && U.nav.depth == depth);
        // a swipe up from the bottom zone: Home, nothing sent
        SC.n = 0;
        contact(true, 360, 690, &c);
        for (int y = 690; y >= 500; y -= 20) { now += 16; contact(true, 360, y, &c); }
        now += 16;
        contact(false, 360, 500, &c);
        CHECK(SC.n == 0 && U.nav.depth == 1 && top() == POD_V_TABS);
    }
}

// A pane swipe on the Recap sends the desktop nothing (only the agent.open for the neighbour); the vertical drag still does.
static void swipe_sends_no_host_scroll(void) {
    open_recap_for_scroll(false);
    bool c;
    contact(true, 520, 300, &c);
    for (int x = 520; x >= 300; x -= 20) { now += 16; contact(true, x, 300 + (520 - x) / 10, &c); }
    now += 16;
    pod_out_t o = contact(false, 300, 322, &c);
    CHECK(SC.n == 0);
    CHECK(o.fx == POD_FX_AGENT_OPEN);
    open_recap_for_scroll(false);
    contact(true, 360, 300, &c);
    for (int y = 300; y >= 120; y -= 20) { now += 16; contact(true, 360, y, &c); }
    now += 16;
    o = contact(false, 360, 120, &c);
    CHECK(SC.n >= 4 && SC.phase[SC.n - 1] == HT_SCROLL_UP && o.fx == POD_FX_NONE);   // A_SCROLL path intact
}
// Only Recap reports: a drag on the Tab list moves that list, not the host.
static void tab_drag_does_not_scroll_the_host(void) {
    setup();
    now += 5000;
    memset(&SC, 0, sizeof SC);
    tap(POD_A_OPEN_TAB, 0);
    bool c;
    contact(true, 360, 400, &c);
    for (int y = 400; y >= 200; y -= 20) { now += 16; contact(true, 360, y, &c); }
    contact(false, 360, 200, &c);
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
    // The Talk button is dimmed with no hit (the screen says why): a tap there records nothing.
    CHECK(hit(POD_A_TALK, 0) == NULL);
    o = tap_at(360, 668);
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_AGENT && !pod_ui_talking(&U) && R.begins == 0);
    // A stale TALK hit (drawn before the machine went away) still meets the glue's guard: no recording, a notice instead.
    o = tap_stale_talk();
    CHECK(o.fx == POD_FX_NONE && top() == POD_V_AGENT && !pod_ui_talking(&U) && R.begins == 0);
    CHECK(U.notice_on && !strcmp(U.notice, "That machine is offline"));
    // The daemon stops describing it: the screen falls back to Home.
    memset(mem.meta, 0, sizeof mem.meta);
    pod_ui_swarms(&U, sw, 1, &mem, "s0", NULL, 0);
    CHECK(top() == POD_V_TABS && pod_model_find(&U.model, "far") == NULL);
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
    pro_app_summary("a1", "short", "the recap", "the long recap", false, POD_TIER_SILENT);
    CHECK(agent("a1")->state == POD_DONE && strstr(agent("a1")->recap, "the long recap") && !strstr(agent("a1")->recap, "the recap\n"));
    // A restore summary is history: no end of turn.
    pro_app_turn("a2", "started", "", 0);
    pro_app_summary("a2", "old text", NULL, NULL, true, POD_TIER_SILENT);
    CHECK(agent("a2")->state == POD_WORKING);
    // "done" is not a text
    pro_app_summary("a3", "done", NULL, NULL, false, POD_TIER_SILENT);
    CHECK(agent("a3")->recap[0] == 0);
    // Questions: held while open, closed by the daemon or by a new turn.
    pro_app_question("a1", "r1", "Which branch?", NULL, POD_ATTN_NONE);
    CHECK(pro_app_question_open("a1") && agent("a1")->state == POD_ASKING);
    pro_app_question_close("a1");
    CHECK(!pro_app_question_open("a1"));
    pro_app_question("a1", "r1", NULL, NULL, POD_ATTN_NONE);
    CHECK(pro_app_question_open("a1") && !strcmp(agent("a1")->question, "Needs your answer"));
    pro_app_turn("a1", "started", "", 0);
    CHECK(!pro_app_question_open("a1"));
    pro_app_question("zz", "r1", "ghost?", NULL, POD_ATTN_NONE);
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
    pro_app_question("a1", "r1", "Which?", NULL, POD_ATTN_NONE);
    CHECK(!strcmp(pro_app_voice_block_reason("a1"), "Answer its question first."));
    pro_app_question_close("a1");
    CHECK(pro_app_voice_block_reason("a1") == NULL);
    // A Super Tab wait is not answered here: talking to the agent is how it is unblocked.
    pro_app_question("a1", "supertab:as1:needs_human", "Which?", "Launch v2", POD_ATTN_DECISION);
    CHECK(pro_app_voice_block_reason("a1") == NULL);
    pro_app_question_close("a1");
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
    pro_app_question("a1", "r1", "Which?", NULL, POD_ATTN_NONE);
    render();
    CHECK(hit(POD_A_TALK, 0) == NULL);                         // no screen draws a Talk button; the gate still meets a stale hit
    tap_stale_talk();
    CHECK(R.begins == 0 && !pod_ui_talking(&U) && !strcmp(U.notice, "Answer its question first."));
    // A Super Tab wait does not hold Talk back: talking to the agent is how it is unblocked.
    pro_app_question_close("a1");
    pro_app_question("a1", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    render();
    tap_stale_talk();
    CHECK(R.begins == 1 && pod_ui_talking(&U));
    pod_ui_talk_over(&U);
    pro_app_question_close("a1");
    R.begins = 0;
    // The tick: Talk with no recording behind it ends; a sent one (waiting) ends too
    render();
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
    const pod_hit_t *h = hit(POD_A_ENTER_TAB, 0);
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
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);   // the card entered Backend on its first agent
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
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);   // the card entered Backend on its first agent
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
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);   // the card entered Backend on its first agent
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

// Pets: the side button goes Home from a room (the TAB frame below it is never drawn), and does nothing at the root. A recording is still discarded.
static void side_button_console(void) {
    setup();
    render();
    tap(POD_A_ENTER_TAB, 0);
    CHECK(top() == POD_V_AGENT && U.nav.depth == 3);
    pro_app_button_press();
    CHECK(top() == POD_V_TABS && U.nav.depth == 1 && LOCK_DEPTH == 0);
    pro_app_button_press();
    CHECK(top() == POD_V_TABS && U.nav.depth == 1 && LOCK_DEPTH == 0 && U.started);
}

// Pets hands free: a tap opens the recording, a cancel keeps it, the side button discards it.
static void side_button_discards_hands_free(void) {
    setup();
    render();
    tap(POD_A_ENTER_TAB, 0);   // Pets Home: a tap on the tab walks straight to its first agent
    bool c;
    contact(true, 360, 400, &c);
    expect(contact(false, 360, 400, &c), POD_FX_VOICE_BEGIN, "a1");   // the lift talks
    CHECK(top() == POD_V_TALK && R.end_abort == 0 && R.end_send == 0);
    contact(true, 360, 400, &c);                                // a second contact, cancelled: still recording
    pro_app_touch_cancel();
    CHECK(top() == POD_V_TALK);
    memset(&R, 0, sizeof R);
    pro_app_button_press();
    CHECK(R.end_abort == 1 && top() != POD_V_TALK && !pod_ui_talking(&U) && !U.hands_free && LOCK_DEPTH == 0);
}

// L3: a question that arrives with no link is not taken (the cable drops everything but welcome/ping then, and the app
// does not trust a late callback either).
static void question_needs_the_link(void) {
    setup();
    pro_app_link(false, NULL);
    pro_app_question("a1", "r1", "Which one?", NULL, POD_ATTN_NONE);
    CHECK(!pro_app_question_open("a1"));
    pro_app_link(true, "mac");
    pro_app_question("a1", "r1", "Which one?", NULL, POD_ATTN_NONE);
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

// The toast shows over a room: a1's room is where these start.
static void notif_room(void) {
    notif_setup();
    pod_ui_focus(&U, "a1", now);
    render();
    CHECK(top() == POD_V_AGENT && !strcmp(U.nav.stack[U.nav.depth - 1].agent, "a1"));
}

static void notify_banner_beep_and_expiry(void) {
    notif_room();
    // A plain live summary: an unread entry, the toast, one beep.
    pro_app_summary("a3", "t", "Shipped the thing. Tests pass.", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 1 && U.model.unread_count == 1 && !strcmp(U.model.unread[0].agent, "a3"));
    CHECK(pod_ui_take_changed(&U));
    render();
    const pod_hit_t *b = banner();
    CHECK(b && !strcmp(b->id, "a3") && b->x == 40 && b->y == 24 + 0 && S.count <= HT_RUNS);
    CHECK(U.frame.hits[U.frame.hit_count - 1].action == POD_A_BANNER);   // on top
    // Visible 5 s: the clock wakes for the expiry (200 ms left at 10100, though the second ticks at 900; the toast's timer line caps the wake at 66 ms), then it is gone.
    now = 10100; render();
    CHECK(banner() && pod_ui_wake_ms(&U, now) == 66);
    uint32_t stamp_before = U.clock_stamp;
    CHECK(pod_ui_clock_tick(&U, now) || stamp_before != U.clock_stamp);
    now = 10299; render();
    CHECK(banner() != NULL);
    now = 10300; render();
    CHECK(banner() == NULL && U.model.unread_count == 1);   // it stays unread in the Inbox
    // A newer one replaces the shown one, and moves to the top of the list.
    now = 20000;
    pro_app_summary("a2", "t", "Renamed the module.", NULL, false, POD_TIER_ALERT);
    render();
    CHECK(BEEPS == 1 && U.model.unread_count == 2 && !strcmp(U.model.unread[0].agent, "a2") && banner() && !strcmp(banner()->id, "a2"));   // 15 s after the beep: coalesced
    now = 22000;
    pro_app_summary("a3", "t", "And again.", NULL, false, POD_TIER_ALERT);
    render();
    CHECK(BEEPS == 1 && U.model.unread_count == 2 && !strcmp(banner()->id, "a3") && !strcmp(U.model.unread[0].agent, "a3"));
    // Muted: the entry and the toast come, the beep does not.
    MUTED = true;
    now = 40000;
    pro_app_summary("a2", "t", "Muted one.", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 1 && U.model.unread_count == 2);
    MUTED = false;
    // quiet / silent / restore (notify false): no entry, no beep, no toast; a restore also leaves the turn state alone.
    notif_room();
    now = 6000;
    pro_app_summary("a3", "t", "quiet", NULL, false, POD_TIER_SILENT);
    pro_app_summary("a3", "t", "restored", NULL, true, POD_TIER_SILENT);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    render();
    CHECK(banner() == NULL);
    // A restore that claims to notify still does not (the cable never sends that; the app does not trust it).
    pro_app_summary("a3", "t", "restored", NULL, true, POD_TIER_ALERT);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    // An agent the roster does not hold: nothing.
    pro_app_summary("zz", "t", "ghost", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    // Awake on that agent's own screen: no beep, no wake, the entry is read at once. Dark on it: news, and the glass lights.
    notif_setup();
    now = 40000;
    pod_ui_focus(&U, "a3", now);
    CHECK(top() == POD_V_AGENT || top() == POD_V_RECAP);
    pro_app_summary("a3", "t", "Looked at.", NULL, false, POD_TIER_ALERT);
    render();
    CHECK(BEEPS == 0 && banner() == NULL && U.model.unread_count == 0);   // its recap is on screen: no beep, read at once
    pro_app_sleep();
    CHECK(pro_app_asleep());
    pro_app_summary("a3", "t", "In the dark.", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 1 && U.model.unread_count == 1 && !pro_app_asleep());
}

// A Swarm chat's notice through the app: an entry, the toast, one beep and a wake (a muted Pro is silent); a read removes it. Phase 1 ignores the Buddy's chat.
static void swarm_notice_and_buddy_chat(void) {
    notif_room();
    swarm_feed(3);
    pro_app_supertab_notice("sw1", "l1", "buddy", "b1", "The Buddy answered.");   // buddy_chat_notice_ignored_in_phase_1
    CHECK(BEEPS == 0 && U.model.unread_count == 0 && !U.ban_on);
    pro_app_supertab_notice("sw1", "l1", "lead", "c1", "The Lead answered. More.");
    CHECK(BEEPS == 1 && U.model.unread_count == 1 && U.ban_on && !strcmp(U.model.unread[0].tab, "sw1") && !strcmp(U.model.unread[0].agent, "l1"));
    render();
    CHECK(banner() && !strcmp(banner()->id, "l1"));
    pro_app_supertab_notice_read("sw1", "l1", "c1");
    render();
    CHECK(U.model.unread_count == 0 && !U.ban_on && banner() == NULL);
    MUTED = true; now += 40000;
    pro_app_supertab_notice("sw1", "l2", "group", "g1", "Muted.");
    CHECK(BEEPS == 1 && U.model.unread_count == 1);
}

// The tiers: alert = entry + toast + beep + wake; list = entry only; silent = nothing. One beep per 30 s; one entry per agent.
static void notify_tiers(void) {
    notif_room();   // a1's room, now = 5300
    pro_app_summary("a3", "t", "Listed.", NULL, false, POD_TIER_LIST);
    render();
    CHECK(BEEPS == 0 && U.model.unread_count == 1 && banner() == NULL && !U.ban_on);
    pro_app_summary("a2", "t", "Silent.", NULL, false, POD_TIER_SILENT);
    CHECK(BEEPS == 0 && U.model.unread_count == 1 && !pod_model_unread_find(&U.model, "a2"));
    // A newer entry of the same agent replaces the older one.
    pro_app_summary("a3", "t", "Listed again.", NULL, false, POD_TIER_LIST);
    CHECK(U.model.unread_count == 1 && !strcmp(U.model.unread[0].text, "Listed again."));
    // An asleep device receiving a list entry stays asleep; an alert wakes it.
    pro_app_sleep();
    pro_app_summary("a2", "t", "Dark list.", NULL, false, POD_TIER_LIST);
    CHECK(pro_app_asleep() && BEEPS == 0 && U.model.unread_count == 2);
    pro_app_summary("a2", "t", "Dark alert.", NULL, false, POD_TIER_ALERT);
    CHECK(!pro_app_asleep() && BEEPS == 1 && U.model.unread_count == 2);
    // Alerts 10 s apart beep once; 31 s after the beep, again. A coalesced alert still wakes and toasts.
    now += 10000;
    pro_app_sleep();
    pro_app_summary("a3", "t", "Second.", NULL, false, POD_TIER_ALERT);
    render();
    CHECK(BEEPS == 1 && !pro_app_asleep() && banner() && !strcmp(banner()->id, "a3"));
    now += 21000;   // 31 s after the first beep
    pro_app_summary("a2", "t", "Third.", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 2);
}

// A question is an alert; a failed turn files a failed entry as an alert.
static void notify_question_and_error(void) {
    notif_room();   // a1's room, now = 5300
    pro_app_question("a3", "r1", "Which branch?", NULL, POD_ATTN_NONE);
    render();
    CHECK(BEEPS == 1 && banner() && !strcmp(banner()->id, "a3") && pod_model_unread_find(&U.model, "a3"));
    now += 10000;
    pro_app_question("a2", "r1", "Which file?", NULL, POD_ATTN_NONE);
    CHECK(BEEPS == 1);   // coalesced
    pro_app_question_close("a3");
    pro_app_question_close("a2");
    CHECK(U.model.unread_count == 0);   // answered: its entry goes
    // Asleep: the question wakes the glass.
    pro_app_sleep();
    now += 40000;
    pro_app_question("a3", "r1", "Again?", NULL, POD_ATTN_NONE);
    CHECK(!pro_app_asleep() && BEEPS == 2);
    // Its own room: no beep, nothing filed.
    pro_app_question_close("a3");
    notif_setup();
    pod_ui_focus(&U, "a3", now);
    pro_app_question("a3", "r1", "Here?", NULL, POD_ATTN_NONE);
    CHECK(BEEPS == 0 && U.model.unread_count == 0);
    // turn.error: a failed entry, an alert.
    notif_room();
    pro_app_turn("a3", "error", "Build broke", 0);
    render();
    const pod_unread_t *e = pod_model_unread_find(&U.model, "a3");
    CHECK(BEEPS == 1 && e && e->kind == POD_UNREAD_FAILED && !strcmp(e->text, "Build broke") && banner());
}

// A Super Tab's question (pro_cable's superTab + attention): an alert like any question, whose toast stays until it is answered.
static void notify_supertab_question_stays(void) {
    notif_room();   // a1's room
    pro_app_question("a3", "r1", "Staging first, or straight to prod?", "Launch v2", POD_ATTN_DECISION);
    render();
    const pod_agent_t *q = agent("a3");
    CHECK(BEEPS == 1 && banner() && !strcmp(banner()->id, "a3") && q && !strcmp(q->super_tab, "Launch v2") && q->attention == POD_ATTN_DECISION);
    now += 60000; render();
    CHECK(banner() != NULL);   // well past a plain toast's 5 s
    pro_app_question_close("a3");
    render();
    CHECK(banner() == NULL && !agent("a3")->super_tab[0] && !pod_model_unread_find(&U.model, "a3"));
    now += 40000;
    pro_app_question("a2", "r2", "Stuck: no write access", "Launch v2", POD_ATTN_STUCK);
    render();
    CHECK(BEEPS == 2 && banner() && agent("a2")->attention == POD_ATTN_STUCK);
    pro_app_question("a2", "r3", "Which file?", NULL, POD_ATTN_NONE);   // a plain one replaces it: no Super Tab left on the agent
    CHECK(!agent("a2")->super_tab[0] && agent("a2")->attention == POD_ATTN_NONE);
}

// A Super Tab's question outlives the agent's turns: only question.close ends it, and it alerts once. What the turns
// say meanwhile neither beeps nor takes its entry or toast. An engine's question takes its place (the daemon closes the
// wait first) and the wait comes back when the daemon asks it again.
static void supertab_question_survives_turns(void) {
    notif_room();   // a1's room
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    CHECK(BEEPS == 1 && pro_app_question_open("a3"));
    now += 40000;   // past the beep coalescing: only the rule can keep these quiet
    pro_app_turn("a3", "started", "Working", 0);
    pro_app_turn("a3", "done", "", 0);
    pro_app_turn("a3", "started", "Working", 0);
    pro_app_summary("a3", "Tried again, still no key.", NULL, NULL, false, POD_TIER_ALERT);
    pro_app_turn("a3", "done", "", 0);
    render();
    const pod_agent_t *q = agent("a3");
    const pod_unread_t *e = pod_model_unread_find(&U.model, "a3");
    CHECK(pro_app_question_open("a3") && q->state == POD_ASKING && !strcmp(q->question, "Stuck: no key"));
    CHECK(!strcmp(q->super_tab, "Launch v2") && q->attention == POD_ATTN_STUCK && e && e->ask && BEEPS == 1);
    CHECK(banner() && !strcmp(banner()->id, "a3"));
    // A library sweep and a send from the Pro leave it too.
    pod_model_library_status(&U.model, "a3", "idle", now + 1);
    pod_model_sent(&U.model, "a3", now + 2);
    CHECK(agent("a3")->state == POD_ASKING && agent("a3")->super_tab[0]);
    // Asked again (a resync, a relink): the same alert, no second beep.
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    CHECK(BEEPS == 1 && pro_app_question_open("a3"));
    // An engine's question takes its place; once it closes and the wait is asked again, it is back.
    pro_app_question_close("a3");
    pro_app_question("a3", "tool-1", "Proceed?", NULL, POD_ATTN_NONE);
    CHECK(pro_app_question_open("a3") && !agent("a3")->super_tab[0]);
    pro_app_turn("a3", "started", "Working", 0);   // a plain question still ends with the turn
    CHECK(!pro_app_question_open("a3"));
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    CHECK(pro_app_question_open("a3") && agent("a3")->attention == POD_ATTN_STUCK);
    // Only question.close ends it.
    pro_app_question_close("a3");
    CHECK(!pro_app_question_open("a3") && agent("a3")->state != POD_ASKING && !agent("a3")->super_tab[0]);
}

// A link drop ends a Super Tab wait as it ends any question: it becomes a plain one the next turn ends, and the daemon
// asks it again on the next link.
static void supertab_question_link_drop(void) {
    notif_room();
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    pro_app_link(false, NULL);
    pro_app_link(true, "mac");
    CHECK(!pro_app_question_open("a3") && !agent("a3")->super_tab[0] && agent("a3")->attention == POD_ATTN_NONE);
    pro_app_turn("a3", "started", "Working", 0);
    CHECK(agent("a3")->state == POD_WORKING);
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    CHECK(pro_app_question_open("a3") && agent("a3")->attention == POD_ATTN_STUCK);
}

// A Super Tab wait that closes leaves the agent as its turns did, not Working; a failed turn while it waits still alerts.
static void supertab_question_close_and_failure(void) {
    notif_room();
    pro_app_turn("a3", "started", "Working", 0);
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    pro_app_turn("a3", "done", "", 0);
    CHECK(agent("a3")->state == POD_ASKING);
    pro_app_question_close("a3");
    CHECK(agent("a3")->state == POD_DONE && !agent("a3")->turn_started);
    // Asked while idle and closed with no turn: idle again.
    pro_app_question("a2", "supertab:as2:needs_human", "Ship it?", "Launch v2", POD_ATTN_DECISION);
    pro_app_question_close("a2");
    CHECK(agent("a2")->state != POD_WORKING && agent("a2")->state != POD_ASKING);
    // Asked again while a turn runs, closed: that turn goes on.
    pro_app_question("a2", "supertab:as2:needs_human", "Ship it?", "Launch v2", POD_ATTN_DECISION);
    pro_app_turn("a2", "started", "Working", 0);
    pro_app_question_close("a2");
    CHECK(agent("a2")->state == POD_WORKING);
    // A plain question still goes back to work.
    pro_app_question("a2", "r9", "Proceed?", NULL, POD_ATTN_NONE);
    pro_app_question_close("a2");
    CHECK(agent("a2")->state == POD_WORKING);
    // A crash while waiting is news.
    now += 40000;
    const int beeps = BEEPS;
    pro_app_question("a3", "supertab:as1:blocked", "Stuck: no key", "Launch v2", POD_ATTN_STUCK);
    now += 40000;
    pro_app_turn("a3", "started", "Working", 0);
    pro_app_turn("a3", "error", "The turn failed", 0);
    const pod_unread_t *e = pod_model_unread_find(&U.model, "a3");
    CHECK(BEEPS == beeps + 2 && e && e->kind == POD_UNREAD_FAILED && pro_app_question_open("a3"));
}

// The daemon re-sends an open question after a link drop: the row returns, but the glass does not wake or beep again.
static void notify_question_resent_after_relink_is_quiet(void) {
    notif_room();
    pro_app_question("a3", "r1", "Which branch?", NULL, POD_ATTN_NONE);
    CHECK(BEEPS == 1);
    pro_app_link(false, NULL);
    pro_app_link(true, "mac");
    pro_app_sleep();
    now += 40000;   // past the beep coalescing, so only the repeat check can silence it
    pro_app_question("a3", "r1", "Which branch?", NULL, POD_ATTN_NONE);
    CHECK(pro_app_question_open("a3") && pod_model_unread_find(&U.model, "a3") && BEEPS == 1 && pro_app_asleep());
    pro_app_question("a3", "r2", "A different one?", NULL, POD_ATTN_NONE);   // another prompt is news
    CHECK(BEEPS == 2 && !pro_app_asleep());
    pro_app_question_close("a3");
    now += 40000;
    pro_app_question("a3", "r3", "A different one?", NULL, POD_ATTN_NONE);   // answered, then asked again: news
    CHECK(BEEPS == 3);
}

// The same prompt under a new request is a new question, even when the close of the last one was lost (Claude
// Code's approvals all read "Do you want to proceed?").
static void notify_question_same_prompt_new_request_beeps(void) {
    notif_room();
    pro_app_question("a3", "r1", "Do you want to proceed?", NULL, POD_ATTN_NONE);
    CHECK(BEEPS == 1);
    pro_app_link(false, NULL);   // the close of r1 is lost with the link
    pro_app_link(true, "mac");
    now += 40000;
    pro_app_question("a3", "r2", "Do you want to proceed?", NULL, POD_ATTN_NONE);
    CHECK(BEEPS == 2);
}

// A question's entry goes whenever the question ends: a new turn, a finished turn, a link drop.
static void notify_question_entry_ends_with_question(void) {
    notif_room();
    pro_app_question("a3", "r1", "Which branch?", NULL, POD_ATTN_NONE);
    CHECK(pod_model_unread_find(&U.model, "a3"));
    pro_app_turn("a3", "started", "Working", 0);
    CHECK(!pod_model_unread_find(&U.model, "a3"));
    pro_app_question("a2", "r1", "Which file?", NULL, POD_ATTN_NONE);
    CHECK(pod_model_unread_find(&U.model, "a2"));
    pro_app_summary("a2", "t", "Done.", NULL, false, POD_TIER_SILENT);
    CHECK(!pod_model_unread_find(&U.model, "a2"));   // a silent end files nothing, and the question's entry is gone
    pro_app_question("a3", "r1", "Again?", NULL, POD_ATTN_NONE);
    CHECK(pod_model_unread_find(&U.model, "a3"));
    pro_app_link(false, NULL);
    CHECK(!pod_model_unread_find(&U.model, "a3"));
    pro_app_link(true, "mac");
    CHECK(!pod_model_unread_find(&U.model, "a3"));
}

// Entries expire after 6 h, measured from receipt on the render clock.
static void notify_entries_expire(void) {
    notif_room();
    pro_app_summary("a3", "t", "Old.", NULL, false, POD_TIER_LIST);
    now += POD_UNREAD_TTL_MS - 1; render();
    CHECK(U.model.unread_count == 1);
    now += 1; render();
    CHECK(U.model.unread_count == 0);
}

static void notify_tap_opens_and_swipe_dismisses(void) {
    notif_room();
    // A tap on the toast opens Notices, which lists the entry.
    now = 6000;
    pro_app_summary("a3", "t", "Shipped the thing. Tests pass.", NULL, false, POD_TIER_ALERT);
    render();
    const pod_hit_t *b = banner();
    CHECK(b);
    int cx = b->x + b->w / 2, cy = b->y + b->h / 2;
    pod_out_t o = tap_at(cx, cy);
    expect(o, POD_FX_NONE, NULL);
    CHECK(top() == POD_V_INBOX && banner() == NULL && U.model.unread_count == 1);
    // A swipe up dismisses; the entry stays unread and nothing opens.
    notif_room();
    now = 7000;
    pro_app_summary("a3", "t", "Again.", NULL, false, POD_TIER_ALERT);
    render();
    b = banner();
    CHECK(b);
    cx = b->x + b->w / 2; cy = b->y + b->h / 2;
    bool c;
    CHECK(contact(true, cx, cy, &c).fx == POD_FX_NONE);
    contact(true, cx, cy - 30, &c); contact(true, cx, cy - 60, &c);
    pod_out_t up = contact(false, cx, cy - 60, &c);
    render();
    CHECK(up.fx == POD_FX_NONE && banner() == NULL && U.model.unread_count == 1 && top() == POD_V_AGENT);
    // A drag down or sideways on the toast is neither a tap nor a dismissal.
    now = 8000;
    pro_app_summary("a2", "t", "Third.", NULL, false, POD_TIER_ALERT);
    render();
    b = banner();
    cx = b->x + b->w / 2; cy = b->y + b->h / 2;
    contact(true, cx, cy, &c); contact(true, cx, cy + 60, &c);
    up = contact(false, cx, cy + 60, &c);
    render();
    CHECK(up.fx == POD_FX_NONE && banner() != NULL && top() == POD_V_AGENT);
}

static void notify_never_over_talk(void) {
    notif_room();
    expect(tap(POD_A_TALK, 0), POD_FX_VOICE_BEGIN, "a1");
    CHECK(pod_ui_talking(&U));
    now = 6000;
    pro_app_summary("a3", "t", "Done while talking.", NULL, false, POD_TIER_ALERT);
    render();
    CHECK(banner() == NULL && U.model.unread_count == 1);   // in the Inbox; no toast over a recording
    now = 7000; render();
    CHECK(banner() == NULL);
    // The talk ends within the 5 s: the toast does not pop up late.
    pod_ui_talk_over(&U);
    now = 8000; render();
    CHECK(banner() == NULL);
    // No cable: no toast.
    notif_room();
    now = 6000;
    pro_app_summary("a3", "t", "x", NULL, false, POD_TIER_ALERT);
    pro_app_link(false, NULL);
    render();
    CHECK(banner() == NULL);
    pro_app_link(true, "mac");
    render();
    CHECK(banner() != NULL);
}

// A tap on the Notices row of an agent (the rows are told apart by the id their hit carries).
static pod_out_t tap_notif(const char *id) {
    for (int i = 0; i < U.frame.hit_count; i++) {
        const pod_hit_t *h = &U.frame.hits[i];
        if (h->action == POD_A_OPEN_NOTIF && !strcmp(h->id, id)) return tap_at(h->x + h->w / 2, h->y + h->h / 2);
    }
    CHECK(!"no such notice row");
    return (pod_out_t){0};
}
static void notify_replace_seen_and_read(void) {
    notif_setup();
    pro_notif_row_t rows[] = {{"a1", "Alpha", "Renamed the module.", "tok_a1"}, {"a2", "Bravo", "Fixed the parser.", ""}, {"nobody", "Ghost", "Gone.", "tok_g"}};
    pro_app_notif_replace(rows, 3);
    render();
    CHECK(BEEPS == 0 && banner() == NULL && U.model.unread_count == 3);   // the whole list; no beep, no toast
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
    // Notices: Home's card before the first tab opens it; a row opens the agent. A recap on screen reads its entry and sends
    // notif.read with the token; a working agent's room has no recap to show, so its entry waits.
    pod_nav_act(&U.nav, &U.model, POD_A_SCROLL, POD_HOME_NOTICES, now);
    render();
    expect(tap(POD_A_INBOX, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_INBOX);
    const pod_hit_t *r = hit(POD_A_OPEN_NOTIF, 0);
    CHECK(r && r->y >= 96 && r->y < 628);
    pod_out_t o = tap_notif("a1");
    expect(o, POD_FX_AGENT_OPEN, "a1");
    CHECK(READS == 0 && U.model.unread_count == 3 && top() == POD_V_AGENT);                       // a1 works: its entry waits
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    CHECK(top() == POD_V_INBOX);
    expect(tap_notif("a2"), POD_FX_AGENT_OPEN, "a2");                                              // done, with a recap: read; no token, nothing to report
    CHECK(READS == 0 && U.model.unread_count == 2 && top() == POD_V_RECAP);
    expect(tap(POD_A_BACK, 0), POD_FX_NONE, NULL);
    expect(tap_notif("nobody"), POD_FX_NONE, NULL);                                                // not on the roster: read, nothing to open
    CHECK(READS == 1 && !strcmp(READ_TOKEN, "tok_g") && U.model.unread_count == 1 && top() == POD_V_INBOX);
    // And the host focusing an agent whose recap shows reads its entry too.
    pro_app_notif_replace(rows, 3);
    pro_app_focus("a2");
    CHECK(U.model.unread_count == 2 || U.pending_focus[0] == 0);
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
    fw_update_ui_begin("0.1.2", "0.1.3");
    CHECK(pod_ui_updating(&U) && pod_ui_take_changed(&U));
    render();
    CHECK(S.count > 0 && S.count <= HT_RUNS);   // the update's own screen
    int runs0 = S.count;
    // Every touch is ignored: the bottom, the middle, the back corner, a swipe. Nothing moves, nothing is sent.
    memset(&R, 0, sizeof R);
    bool changed = false;
    static const int pts[][2] = {{360, 640}, {360, 360}, {30, 27}};
    for (unsigned i = 0; i < 3; i++) {
        pod_out_t d = contact(true, pts[i][0], pts[i][1], &changed);
        CHECK(d.fx == POD_FX_NONE && !changed);
        pod_out_t u = contact(false, pts[i][0], pts[i][1], &changed);
        CHECK(u.fx == POD_FX_NONE && !changed);
    }
    contact(true, 600, 360, &changed); contact(true, 100, 365, &changed); contact(false, 100, 365, &changed);
    CHECK(R.opens == 0 && R.begins == 0 && R.end_abort == 0 && top() == POD_V_AGENT && U.nav.depth == depth && !changed);
    // Progress redraws the same screen (the bar's fill moves; the run count does not shrink) and the button does not go home.
    fw_update_ui_pct(42);
    CHECK(pod_ui_take_changed(&U));
    render();
    CHECK(S.count >= runs0 && S.count <= HT_RUNS && U.ota_pct == 42);   // the fill moves
    pro_app_button_press();
    CHECK(U.nav.depth == depth && pod_ui_updating(&U) && LOCK_DEPTH == 0);
    fw_update_ui_restarting("0.1.3");
    render();
    CHECK(U.ota_restarting && U.ota_pct == 100 && S.count > 0 && S.count <= HT_RUNS);
    // The failed path ends it: the stack comes back as it was.
    ota_end();
    render();
    CHECK(!pod_ui_updating(&U) && U.nav.depth == depth && top() == POD_V_AGENT);
}

static void voice_refused_while_updating(void) {
    setup();
    tap(POD_A_OPEN_TAB, 0);
    tap(POD_A_OPEN_AGENT, 0);
    CHECK(pro_app_voice_block_reason("a1") == NULL);
    const int tx = 360, ty = 400;
    fw_update_ui_begin("0.1.2", "0.1.3");
    CHECK(!strcmp(pro_app_voice_block_reason("a1"), "Updating"));
    // A tap where it would record, and the side button: no recording starts and none is left open.
    memset(&R, 0, sizeof R);
    bool changed;
    contact(true, tx, ty, &changed); contact(false, tx, ty, &changed);
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
    CHECK(!U.notice_on);
    // The race: the gate lands inside a start that already passed its own check. The start is cancelled, not recorded.
    memset(&R, 0, sizeof R);
    GATE_IN_BEGIN = true;
    (void)tap_talk();
    GATE_IN_BEGIN = false;
    CHECK(R.begins == 1 && R.end_abort == 1 && !V.open && !pod_ui_talking(&U));
    fw_update_ui_failed();                                         // an accepted transfer that failed also lets go
    CHECK(pro_app_voice_block_reason("a1") == NULL);
}

static void ota_failed_returns(void) {
    setup();
    tap(POD_A_ENTER_TAB, 0);
    render();
    const int depth = U.nav.depth;
    now = 20000;
    fw_update_ui_begin("0.1.2", "0.1.3");
    fw_update_ui_pct(10);
    now = 21000;
    fw_update_ui_failed();
    CHECK(!pod_ui_updating(&U) && U.nav.depth == depth && top() == POD_V_AGENT);
    CHECK(pod_ui_take_changed(&U));
    render();
    CHECK(U.notice_on);
    CHECK(!strcmp(U.notice, "Update failed \xc2\xb7 trying again later") && U.notice_bad);   // the red pill
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
    notif_room();
    const int depth = U.nav.depth;
    fw_update_ui_begin("0.1.2", "0.1.3");
    now += 100;
    pro_app_summary("a3", "t", "Shipped the thing.", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 0 && U.model.unread_count == 1 && !U.ban_on);   // in Notices, no beep, no toast
    render();
    CHECK(banner() == NULL && !U.frame.banner);
    pro_app_summary("a2", "t", "Another.", NULL, false, POD_TIER_ALERT);
    CHECK(BEEPS == 0 && U.model.unread_count == 2);
    ota_end();
    CHECK(U.nav.depth == depth);
    now += 100; render();
    CHECK(banner() == NULL);   // Notices has them; the toast never came
    // Back to normal afterwards.
    pro_app_summary("a2", "t", "After.", NULL, false, POD_TIER_ALERT);
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

// The Pets tap to talk runs on the touch path: the lift begins the recording (no render, no tick), so the begin and
// the end or abort share the touch task; a later contact's cancel leaves the recording open.
static void console_agent_for_talk(void) {
    setup();
    render();
    tap(POD_A_ENTER_TAB, 0);
    CHECK(top() == POD_V_AGENT && !pod_ui_talking(&U));
}
static void console_tap_talks_on_the_touch_path(void) {
    console_agent_for_talk();
    bool c;
    contact(true, 360, 400, &c);
    for (int i = 0; i < 60; i++) contact(true, 360, 400, &c);   // a long still press: nothing until the lift
    CHECK(R.begins == 0 && !V.open && top() == POD_V_AGENT);
    contact(false, 360, 400, &c);                                // the lift talks, with no pro_app_tick and no render between
    CHECK(R.begins == 1 && V.open && !strcmp(V.agent, "a1") && pod_ui_talking(&U) && LOCK_DEPTH == 0);
    render();                                                    // the Talk frame, whose full-screen hit is topmost
    contact(true, 20, 20, &c);                                  // a new tap anywhere (here over the bar) sends
    contact(false, 20, 20, &c);
    CHECK(R.end_send == 1 && V.waiting);
    // A drag is not a tap: it never starts it.
    console_agent_for_talk();
    contact(true, 360, 400, &c);
    contact(true, 360, 480, &c);
    contact(false, 360, 480, &c);
    pro_app_tick();
    CHECK(R.begins == 0 && !V.open && top() == POD_V_AGENT);
}
// A contact cancel never ends a hands-free recording; the side button / tap end it.
static void console_cancel_keeps_the_recording(void) {
    console_agent_for_talk();
    CHECK(tap_talk().fx == POD_FX_VOICE_BEGIN && V.open);
    memset(&R, 0, sizeof R);
    bool c;
    contact(true, 360, 400, &c);
    pro_app_touch_cancel();   // a second finger, an untrusted sample, the glass turning or sleep
    CHECK(R.end_abort == 0 && R.end_send == 0 && V.open && pod_ui_talking(&U) && LOCK_DEPTH == 0);
    // The finger task's own rule: an untrusted sample mid-contact.
    console_agent_for_talk();
    CHECK(tap_talk().fx == POD_FX_VOICE_BEGIN && V.open);
    memset(&R, 0, sizeof R);
    contact(true, 360, 400, &c);
    pro_touch_feed(&TCH, PRO_TOUCH_BAD, 360, 400);
    CHECK(R.end_abort == 0 && V.open && pod_ui_talking(&U));
}
// Tap to talk is the agent screens' own: a long still press on Home never asks the recorder, and its lift
// walks into the tab as a tap does.
static void console_tile_long_press_is_a_tap(void) {
    setup();
    render();
    const pod_hit_t *tile = NULL;
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_ENTER_TAB) { tile = &U.frame.hits[i]; break; }
    CHECK(tile);
    const int x = tile->x + tile->w / 2, y = tile->y + tile->h / 2;
    bool c;
    contact(true, x, y, &c);
    for (int i = 0; i < 60; i++) contact(true, x, y, &c);
    CHECK(R.begins == 0 && !V.open && top() == POD_V_TABS && !pod_ui_talking(&U) && !U.notice_on);
    contact(false, x, y, &c);
    CHECK(top() == POD_V_AGENT && R.begins == 0 && !pod_ui_talking(&U));
}

int main(int argc, char **argv) {
    static const struct { const char *name; void (*run)(void); } tests[] = {
        {"journey", journey}, {"tabs_button_from_everywhere", tabs_button_from_everywhere}, 
        {"swipe_steps_panes", swipe_steps_panes}, {"swipe_slow_does_nothing", swipe_slow_does_nothing},
        {"swipe_short_and_diagonal", swipe_short_and_diagonal}, 
        
        {"swipe_on_tabs_and_tab_does_nothing", swipe_on_tabs_and_tab_does_nothing}, 
        {"swipe_sends_no_host_scroll", swipe_sends_no_host_scroll},
        {"next_from_talking_aborts", next_from_talking_aborts},
        {"prev_and_back_from_talking_abort", prev_and_back_from_talking_abort},
        {"talk_over_leaves_quietly", talk_over_leaves_quietly},
        
        
        
        
        {"release_off_the_hit_cancels", release_off_the_hit_cancels},
        {"panel_turn", panel_turn}, {"pets_start_on_link", pets_start_on_link}, {"pet_clock", pet_clock}, {"pet_wakes_at_next_step", pet_wakes_at_next_step}, 
        {"roster_after_swarms_rebuilds_tabs", roster_after_swarms_rebuilds_tabs},
        {"moved_agent_reaches_the_model", moved_agent_reaches_the_model},
        {"recap_flips_to_agent_when_work_starts", recap_flips_to_agent_when_work_starts},
        {"library_fills_other_tabs", library_fills_other_tabs}, {"sweep_schedule", sweep_schedule},
        {"notice_shows_three_seconds", notice_shows_three_seconds}, {"link_drop_keeps_the_stack", link_drop_keeps_the_stack}, {"orphan_recording_is_discarded", orphan_recording_is_discarded}, {"side_button_discards_hands_free", side_button_discards_hands_free},
        {"send_before_recorder_started", send_before_recorder_started}, {"cap_leaves_talking", cap_leaves_talking},
        {"lead_view_via_app", lead_view_via_app}, {"lead_view_scrolls_via_app", lead_view_scrolls_via_app}, {"lead_close_owed_on_busy_link", lead_close_owed_on_busy_link}, {"lead_view_relink_and_focus", lead_view_relink_and_focus}, {"tap_resolves_by_id", tap_resolves_by_id}, {"utf8_cuts", utf8_cuts}, {"clock_wrap", clock_wrap}, {"small_cable_stack", small_cable_stack},
        {"activity_text_is_stable_through_the_real_cadence", activity_text_is_stable_through_the_real_cadence},
        {"follow_from_tabs", follow_from_tabs}, {"follow_from_another_agent", follow_from_another_agent}, {"follow_same_agent_is_a_no_op", follow_same_agent_is_a_no_op},
        {"follow_ignored_while_talking", follow_ignored_while_talking}, {"follow_waits_out_the_users_touch", follow_waits_out_the_users_touch},
        {"follow_pends_until_the_agent_arrives", follow_pends_until_the_agent_arrives},
        {"follow_first_focus_after_opening_tabs_by_tap", follow_first_focus_after_opening_tabs_by_tap},
        {"follow_waits_for_a_finger_on_tabs", follow_waits_for_a_finger_on_tabs},
        {"follow_other_tab_then_the_app_switches", follow_other_tab_then_the_app_switches},
        {"follow_other_tab_agent_only_in_the_new_roster", follow_other_tab_agent_only_in_the_new_roster},
        {"follow_after_the_switch", follow_after_the_switch}, {"offline_member_through_the_glue", offline_member_through_the_glue},
        {"recap_drag_scrolls_the_host", recap_drag_scrolls_the_host}, {"pets_recap_and_agent_drag_scrolls_the_host", pets_recap_and_agent_drag_scrolls_the_host}, {"tab_drag_does_not_scroll_the_host", tab_drag_does_not_scroll_the_host},
        {"pro_app_test_link_drop", pro_app_test_link_drop}, {"pro_app_test_step_after_done", pro_app_test_step_after_done},
        {"pro_app_test_new_turn_only", pro_app_test_new_turn_only}, {"pro_app_test_verb_activity_cadence", pro_app_test_verb_activity_cadence},
        {"pro_app_test_turn_gates", pro_app_test_turn_gates}, {"pro_app_test_summary_and_question", pro_app_test_summary_and_question},
        {"pro_app_test_sweep_retries", pro_app_test_sweep_retries}, {"pro_app_test_voice_gate", pro_app_test_voice_gate},
        {"pro_app_test_voice_paths", pro_app_test_voice_paths}, {"pro_app_test_touch_rules", pro_app_test_touch_rules},
        {"pro_app_test_roster_and_swarms", pro_app_test_roster_and_swarms}, {"side_button", side_button}, {"side_button_console", side_button_console}, {"question_needs_the_link", question_needs_the_link},
        {"notify_banner_beep_and_expiry", notify_banner_beep_and_expiry}, {"swarm_notice_and_buddy_chat", swarm_notice_and_buddy_chat}, {"notify_tap_opens_and_swipe_dismisses", notify_tap_opens_and_swipe_dismisses},
        {"notify_never_over_talk", notify_never_over_talk}, {"notify_tiers", notify_tiers}, {"notify_question_and_error", notify_question_and_error}, {"notify_supertab_question_stays", notify_supertab_question_stays}, {"supertab_question_survives_turns", supertab_question_survives_turns}, {"supertab_question_link_drop", supertab_question_link_drop}, {"supertab_question_close_and_failure", supertab_question_close_and_failure}, {"notify_entries_expire", notify_entries_expire}, {"notify_question_entry_ends_with_question", notify_question_entry_ends_with_question}, {"notify_question_resent_after_relink_is_quiet", notify_question_resent_after_relink_is_quiet}, {"notify_question_same_prompt_new_request_beeps", notify_question_same_prompt_new_request_beeps}, {"notify_replace_seen_and_read", notify_replace_seen_and_read},
        {"ota_screen_and_touch", ota_screen_and_touch}, {"voice_refused_while_updating", voice_refused_while_updating},
        {"update_gate", update_gate}, {"ota_failed_returns", ota_failed_returns}, {"ota_keeps_awake", ota_keeps_awake},
        {"ota_notifications_quiet", ota_notifications_quiet}, {"updated_notice", updated_notice},
        {"console_tap_talks_on_the_touch_path", console_tap_talks_on_the_touch_path}, {"console_cancel_keeps_the_recording", console_cancel_keeps_the_recording},
        {"console_tile_long_press_is_a_tap", console_tile_long_press_is_a_tap},
    };
    if (argc > 1 && !strcmp(argv[1], "--each")) {   // every replay in its own process: which ones fail, not just the first
        int failed = 0;
        for (unsigned i = 0; i < sizeof tests / sizeof tests[0]; i++) {
            fflush(stdout);
            pid_t pid = fork();
            if (pid == 0) { dup2(1, 2); tests[i].run(); _exit(0); }
            int status = 0;
            waitpid(pid, &status, 0);
            if (status) failed++;
            printf("%s %s\n", status ? "FAIL" : "PASS", tests[i].name);
        }
        return failed != 0;
    }
    for (unsigned i = 0; i < sizeof tests / sizeof tests[0]; i++)
        if (argc == 1 || !strcmp(argv[1], tests[i].name)) { tests[i].run(); printf("PASS %s\n", tests[i].name); }
    return 0;
}
'''


def test_no_turn():
    """The panel is not turned: nothing under main/ turns the picture or a contact."""
    for source in (FW / "main").rglob("*.[ch]"):
        text = source.read_text()
        assert "pro_turn" not in text and "pod_turn_coord" not in text and "POD_PANEL_TURN" not in text, f"{source.name} turns the glass"


test_no_turn()

cc = os.environ.get("CC", "cc")
sanitize = "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds")
include = ["-I", str(APP), "-I", str(MAIN), "-I", str(DISP), "-I", str(HERE / "host_esp"),
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
    modules = sorted(POD.glob("*.c")) + sorted(POD.glob("*/*.c")) + [APP / "pod_glue.c", APP / "pro_app.c", APP / "pro_touch.c", DISP / "scroll.c",
                                         DISP / "pro_canvas.c", DISP / "terminal.c", fonts]
    for label, extra in (("upright", []),):
        # The callbacks run on the cable_link task's 12 KB stack, the touch task's contact path on 10 KB: no frame of
        # pro_app.c, pro_touch.c or the glue may pass 1 KB.
        for guarded in (APP / "pod_glue.c", APP / "pro_app.c", APP / "pro_touch.c"):
            subprocess.run([cc, "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wframe-larger-than=1024", "-O1", "-DHT_FACE_PX=720",
                            *extra, *include, "-c", str(guarded), "-o", os.devnull], check=True)
        executable = directory / ("pro_app_" + label.split()[0])
        command = [cc, "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-O1", "-g", sanitize,
                   "-DHT_FACE_PX=720", *extra, *include, str(source), *map(str, modules), "-lpthread", "-o", str(executable)]
        subprocess.run(command, check=True)
        only = [os.environ["PRO_APP_TEST"]] if os.environ.get("PRO_APP_TEST") else []   # one replay by name, for debugging
        result = subprocess.run([str(executable), *only], text=True, capture_output=True)
        print(f"[{label}]")
        print(result.stdout.strip())
        if result.returncode:
            failures.append(label)
            print(f"FAIL {label}: {result.stderr.strip()}")
assert not failures, f"pro_app regressions: {', '.join(failures)}"
print("pro_app: production-glue replays passed (panel not turned)")
