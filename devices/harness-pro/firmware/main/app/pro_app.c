// The app layer. pro_cable's callbacks (pro_app_api.h) become feeds into Pod (pod_glue.h), the touch task's
// contacts become Pod gestures, and the render task draws Pod's frame. The rules here are the ones the Pod build of
// the round dial's ui_habitat.c followed (docs/port-inventory.md; row ids R* and P* below name its entries).
//
// THREADS: three tasks meet here. The cable_link task (STACK_CABLE_LINK, 12 KB) calls the pro_app_* callbacks; the touch task
// calls pro_app_touch; the render task ticks, draws and paints. One recursive mutex guards the Pod object, the
// busy/question/machine tables and the dirty flag. Nothing that leaves the device is sent under it: effects and
// requests are queued while the mutex is held and sent by leave() after it is released.
#include "app/pro_app.h"

#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

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
#include "task_stacks.h"
#include "theme.h"

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#ifndef ESP_PLATFORM
#define EXT_RAM_BSS_ATTR   // the host has no PSRAM
#endif

static const char *TAG = "pro";

#define IDLE_SLEEP_MS 300000u       // no touch for this long and the screen sleeps (R / P25)
#define HEARTBEAT_MS 60000u
#define FX_MAX 4                    // effects queued under the lock until leave()
#define SCROLL_MAX 16               // recap-scroll reports queued by the touch task
#define SWEEP_RETRY_MS 1000         // a request that could not be sent
#define SWEEP_STALL_MS 3000         // a request nobody answered

// Pod's model, scenes and tables. All in PSRAM: the model alone is ~130 KB, two scenes of 192 runs ~80 KB (R18).
static EXT_RAM_BSS_ATTR pod_ui_t s_pod;
static EXT_RAM_BSS_ATTR ht_scene_t s_scene[2];
static EXT_RAM_BSS_ATTR pod_roster_row_t s_rows[POD_AGENTS_MAX];   // not on the cable_link stack (P9)
static EXT_RAM_BSS_ATTR struct { char id[ID_MAX], machine_id[ID_MAX]; } s_info[POD_AGENTS_MAX];   // the roster's machine ids
static EXT_RAM_BSS_ATTR char s_busy[POD_AGENTS_MAX][ID_MAX];       // agents in a live turn ("" = free slot)
static EXT_RAM_BSS_ATTR char s_quest[POD_AGENTS_MAX][ID_MAX];      // agents with an open question
// Agents whose open question already woke the glass, and a hash of its prompt. A link drop does not clear it: the daemon
// re-sends the open question after the relink and that must not beep again. A close (answered, withdrawn) clears it.
static EXT_RAM_BSS_ATTR char s_alerted[POD_AGENTS_MAX][ID_MAX];
static uint32_t s_alerted_h[POD_AGENTS_MAX];
static EXT_RAM_BSS_ATTR cable_machine_t s_mach[CABLE_MAX_MACHINES];
static int s_mach_n;

static SemaphoreHandle_t s_lock;
static TaskHandle_t s_renderer;
static bool s_started, s_linked, s_dirty;

static pod_out_t s_fxq[FX_MAX];
static int s_fxn;
static bool s_beepq;   // an alert landed and the last beep is old enough: beep once after the lock is released
static bool s_wakeq;   // an alert landed: light a dark glass after the lock is released
static bool s_beep_set;
static uint32_t s_beep_ms;   // when the last beep was queued (POD_BEEP_COALESCE_MS)

// The library sweep's request state. The walk itself is the glue's (pod_ui_sweep_*).
static int s_sweep_offset;        // the offset the running sweep asks for next
static uint32_t s_sweep_try_ms;   // last (re)request, so a busy link is retried once a second
static uint32_t s_lib_request;    // id of the latest player.library.get
static uint32_t s_lib_asked_ms;
static bool s_lib_pending;
static struct { bool on; int offset; uint32_t request; } s_libq;   // a request to send once the lock is released

typedef struct { ht_scroll_phase_t phase; int dy, velocity; } scroll_ev_t;
static scroll_ev_t s_sq[SCROLL_MAX];
static int s_sqn;

static atomic_bool s_asleep, s_force_frame;
static atomic_bool s_updating, s_painted;   // a firmware image is being written (mirrors pod_ui_updating, readable without the lock); the first frame is out
static char s_ota_from[24], s_ota_to[24];   // the update screen's versions, set at its begin
static char s_updated[24];                  // "Updated to X": set by pro_app_note_update, shown (3 s) once the cable is up
static atomic_uint s_last_activity;

static uint32_t ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

// ---- the lock, the dirty flag, the effect queue ---------------------------------------------------------

void pro_app_lock(void)
{
    if (s_lock) xSemaphoreTakeRecursive(s_lock, portMAX_DELAY);
}

void pro_app_unlock(void)
{
    if (s_lock) xSemaphoreGiveRecursive(s_lock);
}

// Mark the scene stale and wake the renderer (UH change()).
static void change(void)
{
    s_dirty = true;
    if (s_renderer) xTaskNotifyGive(s_renderer);
}

// After any feed: queue its effect for leave(), then redraw if the model or the stack moved (UH pod_settle).
static void settle(pod_out_t o)
{
    if (o.fx != POD_FX_NONE && s_fxn < FX_MAX) s_fxq[s_fxn++] = o;
    (void)pod_ui_start(&s_pod, ms());   // Pets: after the first swarms of a link, enter tab 0 (device-local: no agent.open to the desktop)
    if (pod_ui_take_changed(&s_pod)) change();
}

static void voice_begin_effect(const char *agent);
static void voice_end_effect(void);
static void send_library(uint32_t request, int offset);

// An alert for someone else's screen (the caller holds the lock): wake the glass, and beep unless one was queued in the last
// POD_BEEP_COALESCE_MS. Quiet over the update: the Inbox has it.
static void alert_locked(void)
{
    if (pod_ui_updating(&s_pod)) return;
    s_wakeq = true;
    const uint32_t now = ms();
    if (!s_beep_set || (int32_t)(now - s_beep_ms) >= POD_BEEP_COALESCE_MS) {
        s_beep_set = true;
        s_beep_ms = now;
        s_beepq = true;
    }
}

static void perform(const pod_out_t *o)
{
    switch (o->fx) {
    case POD_FX_AGENT_OPEN:   // agent.open, as the desktop's button (P3)
        pro_cable_send_open(o->agent);
        break;
    case POD_FX_VOICE_BEGIN: voice_begin_effect(o->agent); break;
    case POD_FX_VOICE_END: voice_end_effect(); break;
    case POD_FX_VOICE_ABORT: pro_voice_end(false); break;
    case POD_FX_NONE: break;
    }
}

// The Swarm cards' select / open / recap.get frames the Lead view owes the daemon (pod_ui_take_supertab reconciles them with what is on screen). Taken under the
// lock, sent after it. Its own frame: the queue is too big for leave()'s (1 KB cap).
static __attribute__((noinline)) void send_supertabs(void)
{
    pod_supertab_out_t q[POD_SUPERTAB_OUT_MAX];
    pro_app_lock();
    const uint32_t rev = s_pod.model.revision;
    const int n = pod_ui_take_supertab(&s_pod, q, POD_SUPERTAB_OUT_MAX);
    if (s_pod.model.revision != rev) change();   // asking for a recap puts it LOADING: a change no feed announced (the flag is the model's revision: not consumed here)
    pro_app_unlock();
    bool lost[POD_SUPERTAB_OUT_MAX] = {0}, side_lost[POD_SUPERTAB_OUT_MAX] = {0};
    bool any = false;
    for (int i = 0; i < n; i++) {
        if (!strcmp(q[i].t, "supertab.side")) {   // not owed again: the next supertab frame shows the true side
            if (!pro_cable_supertab_side(q[i].tab, q[i].side)) { lost[i] = false; side_lost[i] = true; any = true; }
            continue;
        }
        any |= lost[i] = !pro_cable_supertab_send(q[i].t, q[i].tab, q[i].lead);
    }
    if (!any) return;
    pro_app_lock();   // a frame the link dropped is owed again (open / recap.get are retried)
    for (int i = 0; i < n; i++) {
        if (lost[i]) pod_ui_supertab_unsent(&s_pod, &q[i]);
        if (side_lost[i]) { pod_ui_side_unsent(&s_pod, q[i].tab); change(); }   // the tapped segment would never be answered
    }
    pro_app_unlock();
}

// Release the lock, then do what the feeds asked for. Every entry that took the lock ends here.
static void leave(void)
{
    pod_out_t q[FX_MAX];
    const int n = s_fxn;
    memcpy(q, s_fxq, (size_t)n * sizeof q[0]);
    s_fxn = 0;
    const bool lib = s_libq.on;
    const int lib_offset = s_libq.offset;
    const uint32_t lib_request = s_libq.request;
    s_libq.on = false;
    const bool beep = s_beepq, wake = s_wakeq;
    s_beepq = s_wakeq = false;
    pod_read_out_t reads[POD_READS_MAX];
    const int read_n = pod_ui_take_reads(&s_pod, reads, POD_READS_MAX);   // entries read on the Pod: tell the host
    pro_app_unlock();
    for (int i = 0; i < n; i++) perform(&q[i]);
    for (int i = 0; i < read_n; i++) pro_cable_send_notif_read(reads[i].agent, reads[i].token);
    send_supertabs();
    if (wake) pro_app_wake();   // an alert: light a dark glass so its banner is seen
    if (beep && !pro_settings_muted() && !atomic_load(&s_updating)) audio_beep();   // and chime, unless muted
    if (lib) send_library(lib_request, lib_offset);
}

// ---- text helpers (verbatim from the round dial's ui_habitat.c) -----------------------------------------

// Copy at most cap-1 bytes, never splitting a UTF-8 character.
static void copy_cut(char *dst, size_t cap, const char *src)
{
    if (!cap) return;
    size_t n = src ? strnlen(src, cap) : 0;
    if (n >= cap) {
        n = cap - 1;
        while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80) n--;
    }
    if (n) memcpy(dst, src, n);
    dst[n] = 0;
}

// UH recap_preview: collapses whitespace, keeps whole UTF-8 characters, replaces invalid bytes with '?', rewrites a
// trailing U+2026 to '+'. Used for the `action` sentence under the pet (R3).
static void recap_preview(char *dst, size_t cap, const char *src)
{
    if (!cap) return;
    size_t used = 0;
    bool space = false;
    const unsigned char *p = (const unsigned char *)(src ? src : "");
    while (*p) {
        if (*p == ' ' || (*p >= '\t' && *p <= '\r')) {
            space = used > 0;
            p++;
            continue;
        }
        size_t n = *p < 0x80 ? 1 : *p >= 0xc2 && *p <= 0xdf ? 2 : *p >= 0xe0 && *p <= 0xef ? 3 : *p >= 0xf0 && *p <= 0xf4 ? 4 : 0;
        for (size_t i = 1; i < n; i++) {
            if ((p[i] & 0xc0) != 0x80) {
                n = 0;
                break;
            }
        }
        size_t bytes = n ? n : 1;
        if (used + space + bytes >= cap) break;   // keep whole UTF-8 characters, including at the buffer edge
        if (space) dst[used++] = ' ';
        if (n) memcpy(dst + used, p, n);
        else dst[used] = '?';
        used += bytes;
        p += bytes;
        space = false;
    }
    if (used >= 3 && !memcmp(dst + used - 3, "\xe2\x80\xa6", 3)) {
        dst[used - 3] = '+';
        used -= 2;
    }
    if (used > 1 && dst[used - 1] == '+' && dst[used - 2] != '+' && dst[used - 2] != ' ' && used + 1 < cap) {
        dst[used - 1] = ' ';
        dst[used++] = '+';
    }
    dst[used] = 0;
}

// UH activity_text: the engine's word without the spinner dots (R2).
static void activity_text(char *dst, size_t cap, const char *src)
{
    while (src && (*src == ' ' || *src == '\t' || *src == '\r' || *src == '\n')) src++;
    copy_cut(dst, cap, src);
    size_t n = strlen(dst);
    while (n && (dst[n - 1] == ' ' || dst[n - 1] == '\t' || dst[n - 1] == '\r' || dst[n - 1] == '\n')) dst[--n] = 0;
    if (n >= 3 && (!memcmp(dst + n - 3, "...", 3) || !memcmp(dst + n - 3, "\xe2\x80\xa6", 3))) {
        n -= 3;
        dst[n] = 0;
    }
    while (n && dst[n - 1] == ' ') dst[--n] = 0;
}

// ---- tables keyed by agent id ---------------------------------------------------------------------------

static bool held(const char *id) { return pod_model_find(&s_pod.model, id) != NULL; }

static bool id_ok(const char *id) { return id && id[0] && strnlen(id, ID_MAX) < ID_MAX; }

static int set_find(char (*set)[ID_MAX], const char *id)
{
    for (int i = 0; i < POD_AGENTS_MAX; i++)
        if (set[i][0] && !strcmp(set[i], id)) return i;
    return -1;
}

// Add `id`; a full table first drops entries for agents Pod no longer holds. False when it is still full.
static bool set_add(char (*set)[ID_MAX], const char *id)
{
    if (set_find(set, id) >= 0) return true;
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i < POD_AGENTS_MAX; i++) {
            if (!set[i][0]) {
                copy_cut(set[i], ID_MAX, id);
                return true;
            }
        }
        for (int i = 0; i < POD_AGENTS_MAX; i++)
            if (!held(set[i])) set[i][0] = 0;
    }
    return false;
}

static void set_remove(char (*set)[ID_MAX], const char *id)
{
    const int i = set_find(set, id);
    if (i >= 0) set[i][0] = 0;
}

static void show_updated(void);

// ---- the link -------------------------------------------------------------------------------------------

void pro_app_features(uint32_t features)
{
    pro_app_lock();
    pod_ui_set_swarm_remote(&s_pod, (features & CABLE_FEATURE_SWARM_REMOTE) != 0);
    pro_app_unlock();
}

void pro_app_link(bool up, const char *machine)
{
    (void)machine;
    if (!up) pro_voice_link_lost();   // the cable is dead: end the recording without telling the daemon (P7)
    pro_app_lock();
    if (!up) {
        // A drop clears everything the daemon told us: no busy agent outlives its link (owner decision 1), a sweep
        // is abandoned and the next link starts it again from offset 0.
        s_linked = false;
        memset(s_busy, 0, sizeof s_busy);
        memset(s_quest, 0, sizeof s_quest);
        s_mach_n = 0;
        s_lib_pending = false;
        s_sweep_offset = 0;
        s_libq.on = false;
        (void)pod_ui_link(&s_pod, false);   // the effect is moot: its abort would target a dead cable
        settle((pod_out_t){0});
    } else {
        const bool was = s_linked;
        s_linked = true;
        s_lib_pending = false;
        s_sweep_offset = 0;
        const pod_out_t fx = pod_ui_link(&s_pod, true);
        if (was) s_pod.sweep.restart = true;   // another computer: look the library up again
        settle(fx);
        if (s_updated[0]) show_updated();   // the first screen the new image shows with a cable (owner, 2026-10-11): "Updated to X.Y.Z", 3 s
    }
    change();
    leave();
}

// ---- roster, tabs, library ------------------------------------------------------------------------------

void pro_app_agents(const pro_agent_row_t *rows, int n)
{
    pro_app_lock();
    int m = 0;
    memset(s_info, 0, sizeof s_info);
    for (int i = 0; i < n && m < POD_AGENTS_MAX; i++) {
        const pro_agent_row_t *r = &rows[i];
        if (!id_ok(r->id)) continue;
        bool dup = false;
        for (int k = 0; k < m; k++)
            if (!strcmp(s_rows[k].id, r->id)) dup = true;
        if (dup) continue;
        s_rows[m] = (pod_roster_row_t){r->id, r->name && r->name[0] ? r->name : r->id, r->engine ? r->engine : "",
                                       r->machine ? r->machine : ""};
        copy_cut(s_info[m].id, ID_MAX, r->id);
        // An oversize machine id is no id (UH 5579-5740): the agent then has no machine to gate on.
        if (r->machine_id && strnlen(r->machine_id, ID_MAX) < ID_MAX) copy_cut(s_info[m].machine_id, ID_MAX, r->machine_id);
        m++;
    }
    settle(pod_ui_roster(&s_pod, s_rows, m));
    leave();
}

void pro_app_swarms(const cable_swarm_t *items, int n, const cable_swarm_members_t *members, const char *selected,
                    const cable_tile_t *tiles, int tile_n)
{
    pro_app_lock();
    pod_model_clock(&s_pod.model, ms());   // the focus echo window is measured on this clock, which otherwise stands still while the glass sleeps
    settle(pod_ui_swarms(&s_pod, items, n, members, selected, tiles, tile_n));   // every frame, changed or not (P12)
    leave();
}

// The Swarm cards. The model copies the list and keeps the Lead recap texts (pod_model_supertab); a recap lands on its Lead.
// supertab.focus is recorded by the model (focus_*) and acted on by the glue after the feed (apply_lead_focus): the Lead view opens.
void pro_app_supertab_ids(const char (*ids)[ID_MAX], int n)
{
    pro_app_lock();
    settle(pod_ui_supertab_ids(&s_pod, ids, n));
    leave();
}

void pro_app_supertab(const pod_swarm_t *sw)
{
    pro_app_lock();
    settle(pod_ui_supertab(&s_pod, sw, ms()));
    leave();
}

void pro_app_supertab_recap(const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none)
{
    pro_app_lock();
    settle(pod_ui_supertab_recap(&s_pod, tab, lead, chat_id, text, at, none));
    leave();
}

void pro_app_supertab_focus(const char *tab, const char *lead)
{
    pro_app_lock();
    settle(pod_ui_supertab_focus(&s_pod, tab, lead, ms()));
    leave();
}

void pro_app_supertab_notice(const char *tab, const char *lead, const char *chat, const char *chat_id, const char *text)
{
    pro_app_lock();
    if (pod_ui_swarm_notice(&s_pod, tab, lead, chat, chat_id, text, !pro_app_asleep(), ms())) alert_locked();
    settle((pod_out_t){0});
    leave();
}

void pro_app_supertab_notice_read(const char *tab, const char *lead, const char *chat_id)
{
    pro_app_lock();
    pod_ui_swarm_notice_read(&s_pod, tab, lead, chat_id);
    settle((pod_out_t){0});
    leave();
}

_Static_assert(sizeof(pro_library_row_t) == sizeof(pod_library_row_t) &&
               offsetof(pro_library_row_t, id) == offsetof(pod_library_row_t, id) &&
               offsetof(pro_library_row_t, name) == offsetof(pod_library_row_t, name) &&
               offsetof(pro_library_row_t, engine) == offsetof(pod_library_row_t, engine) &&
               offsetof(pro_library_row_t, machine) == offsetof(pod_library_row_t, machine) &&
               offsetof(pro_library_row_t, status) == offsetof(pod_library_row_t, status) &&
               offsetof(pro_library_row_t, age_s) == offsetof(pod_library_row_t, age_s),
               "pro_library_row_t must be pod_library_row_t");

// Queue a player.library.get for after the lock. The id is taken and `pending` set BEFORE it is sent, so a fast
// reply cannot be undone by a late write (a failed send clears it again in send_library).
static void queue_library(int offset, uint32_t now)
{
    s_libq.on = true;
    s_libq.offset = offset;
    s_libq.request = ++s_lib_request;
    s_lib_pending = true;
    s_lib_asked_ms = now;
}

static void send_library(uint32_t request, int offset)
{
    if (pro_cable_request_library(offset, request)) return;
    pro_app_lock();
    if (s_lib_request == request) s_lib_pending = false;   // retried on the next tick
    pro_app_unlock();
}

void pro_app_library(const pro_library_row_t *rows, int count, int offset, int total)
{
    pro_app_lock();
    s_lib_pending = false;
    const pod_library_row_t *lib = (const pod_library_row_t *)rows;
    const uint32_t now = ms();
    pod_out_t fx = {0};
    // pro_cable delivers only the reply to the latest request, so a page that arrives while a sweep runs is its page.
    if (s_linked && pod_ui_sweeping(&s_pod)) {
        const int next = pod_ui_library_page(&s_pod, lib, count, offset, total, now, &fx);
        s_sweep_offset = next < 0 ? 0 : next;
        if (next >= 0) {
            s_sweep_try_ms = now;
            queue_library(next, now);
        }
    } else {
        fx = pod_ui_library_rows(&s_pod, lib, count, now);   // a page someone else asked for: status and roster only
    }
    settle(fx);
    leave();
}

void pro_app_context(const char *id, const char *machine, const char *project, const char *branch, const char *engine)
{
    (void)id; (void)machine; (void)project; (void)branch; (void)engine;   // owner decision 4: nothing shows it yet
}

void pro_app_machines(const cable_machine_t *rows, int count, const char *selected)
{
    (void)selected;
    pro_app_lock();
    s_mach_n = 0;
    for (int i = 0; i < count && i < CABLE_MAX_MACHINES; i++) s_mach[s_mach_n++] = rows[i];
    pro_app_unlock();
}

// ---- turns, recaps, questions, focus --------------------------------------------------------------------

static bool generic_label(const char *text)
{
    return !strcmp(text, "Processing") || !strcmp(text, "Summarizing...") || !strcmp(text, "Summarizing\xe2\x80\xa6");
}

static int model_elapsed(const char *id)
{
    const pod_agent_t *pa = pod_model_find(&s_pod.model, id);
    return pa ? (int)pa->elapsed_s : 0;
}

// The footer word, if the text is one: its own field, keeping the model's clock (R2).
static void feed_verb(const char *id, const char *text, uint32_t now)
{
    char word[PRO_VERB_BYTES];
    if (!text || !text[0] || generic_label(text)) return;
    activity_text(word, sizeof word, text);
    if (word[0]) settle(pod_ui_turn(&s_pod, id, "verb", word, model_elapsed(id), now));
}

static void turn_locked(const char *id, const char *kind, const char *text, int elapsed_s)
{
    const uint32_t now = ms();
    if (!held(id)) return;   // an agent Pod does not hold: ignored (owner decision 5)
    if (!strcmp(kind, "started")) {
        if (!s_linked) return;
        // R1: only a NEW turn starts the clock; a heartbeat refreshes the word it carries.
        const bool new_turn = set_find(s_busy, id) < 0;
        if (!set_add(s_busy, id)) return;
        // Only turn.started or question.close ends a question; a Super Tab's survives the turn (pod_model set_state).
        const pod_agent_t *asked = pod_model_find(&s_pod.model, id);
        if (!(asked && asked->state == POD_ASKING && asked->super_tab[0])) set_remove(s_quest, id);
        if (new_turn) settle(pod_ui_turn(&s_pod, id, "started", "", 0, now));
        feed_verb(id, text, now);
    } else if (!strcmp(kind, "verb")) {
        if (set_find(s_busy, id) >= 0) feed_verb(id, text, now);   // a late read never revives an idle pane
    } else if (!strcmp(kind, "activity")) {
        if (set_find(s_busy, id) < 0) return;
        const bool has_text = text && text[0];
        const bool has_elapsed = elapsed_s >= 0 && elapsed_s <= 2592000;
        if (!has_text && !has_elapsed) return;
        char clean[PRO_ACTION_BYTES];
        recap_preview(clean, sizeof clean, has_text ? text : "");
        // The sentence only; an absent one blanks nothing and an absent elapsed keeps the model's (R3).
        settle(pod_ui_turn(&s_pod, id, "activity", clean, has_elapsed ? elapsed_s : model_elapsed(id), now));
    } else if (!strcmp(kind, "step")) {
        // R4: only into a live turn, by the model's own state; a step after turn.done must not revive the agent.
        const pod_agent_t *pa = pod_model_find(&s_pod.model, id);
        if (text && text[0] && pa && pa->state == POD_WORKING)
            settle(pod_ui_turn(&s_pod, id, "step", text, (int)pa->elapsed_s, now));
    } else if (!strcmp(kind, "done") || !strcmp(kind, "error")) {
        set_remove(s_busy, id);
        settle(pod_ui_turn(&s_pod, id, kind, "", 0, now));
        if (!strcmp(kind, "error")) {   // a failure is always an alert, whatever the daemon's tiers say
            if (pod_ui_notify_text(&s_pod, id, POD_TIER_ALERT, text && text[0] ? text : "The turn failed", false, !pro_app_asleep(), now)) alert_locked();
            change();
        }
    }
}

void pro_app_turn(const char *id, const char *kind, const char *text, int elapsed_s)
{
    if (!id_ok(id) || !kind) return;
    pro_app_lock();
    turn_locked(id, kind, text, elapsed_s);
    leave();
}

void pro_app_turn_stats(const char *id, int tests_passed, int tests_failed, int commits, int tokens_in, int tokens_out)
{
    if (!id_ok(id)) return;
    pro_app_lock();
    settle(pod_ui_turn_stats(&s_pod, id, tests_passed, tests_failed, commits, tokens_in, tokens_out));
    leave();
}

void pro_app_summary(const char *id, const char *text, const char *recap, const char *full, bool restore, pod_tier_t tier)
{
    if (!id_ok(id)) return;
    pro_app_lock();
    if (held(id)) {
        const uint32_t now = ms();
        if (!restore) {   // R5: a live summary ends the turn
            set_remove(s_busy, id);
            settle(pod_ui_turn(&s_pod, id, "done", "", 0, now));
        }
        const bool has_text = text && text[0] && strcmp(text, "done");
        if ((recap && recap[0]) || has_text) settle(pod_ui_recap(&s_pod, id, recap && recap[0] ? recap : text, restore));
        if (full && full[0]) settle(pod_ui_recap(&s_pod, id, full, restore));   // the long recap wins last (R6)
        if (!restore && tier != POD_TIER_SILENT) {   // news: an entry; an alert also toasts, wakes and beeps
            if (pod_ui_notify(&s_pod, id, tier, !pro_app_asleep(), now)) alert_locked();
            change();
        }
    }
    leave();
}

void pro_app_notif_replace(const pro_notif_row_t *rows, int n)
{
    pro_app_lock();
    const uint32_t now = ms();
    pod_ui_notif_begin(&s_pod);
    for (int i = 0; i < n; i++)
        if (id_ok(rows[i].agent_id)) pod_ui_notif_row(&s_pod, rows[i].agent_id, rows[i].name, rows[i].token, rows[i].summary, now);
    pod_ui_notif_end(&s_pod);
    settle((pod_out_t){0});
    leave();
}

void pro_app_notif_seen(const char *id, const char *token)
{
    if (!id_ok(id)) return;
    pro_app_lock();
    pod_ui_notif_seen(&s_pod, id, token);
    settle((pod_out_t){0});
    leave();
}

void pro_app_question(const char *id, const char *request, const char *text, const char *super_tab, pod_attention_t attention)
{
    if (!id_ok(id)) return;
    pro_app_lock();
    if (s_linked && held(id) && set_add(s_quest, id)) {
        const char *q = text && text[0] ? text : "Needs your answer";
        settle(pod_ui_question(&s_pod, id, q, super_tab, attention));
        uint32_t h = 2166136261u;   // FNV-1a of the request id and the prompt: a lost close must not mute the next one
        for (const char *c = request ? request : ""; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
        h = (h ^ 0u) * 16777619u;
        for (const char *c = q; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
        int a = set_find(s_alerted, id);
        const bool again = a >= 0 && s_alerted_h[a] == h;   // filed already, re-sent after a relink: no second beep
        if (!again && set_add(s_alerted, id)) { a = set_find(s_alerted, id); s_alerted_h[a] = h; }
        // A question is an alert; filed again after a relink it is the same one, and only the row returns.
        if (pod_ui_notify_text(&s_pod, id, POD_TIER_ALERT, q, true, !pro_app_asleep(), ms()) && !again) alert_locked();
        change();
    }
    leave();
}

void pro_app_question_close(const char *id)
{
    if (!id_ok(id)) return;
    pro_app_lock();
    set_remove(s_quest, id);
    set_remove(s_alerted, id);
    settle(pod_ui_question_close(&s_pod, id));
    leave();
}

bool pro_app_question_open(const char *agent_id)
{
    if (!id_ok(agent_id)) return false;
    pro_app_lock();
    const bool open = set_find(s_quest, agent_id) >= 0;
    pro_app_unlock();
    return open;
}

void pro_app_focus(const char *id)
{
    if (!id_ok(id)) return;
    pro_app_lock();
    settle(pod_ui_focus(&s_pod, id, ms()));   // the 4 s / 0.8 s / 5 s timers are the glue's (R7, owner decision 8)
    leave();
}

// ---- voice ----------------------------------------------------------------------------------------------

void pro_app_notice(const char *text)
{
    pro_app_lock();
    pod_ui_notice(&s_pod, text, ms());
    change();
    pro_app_unlock();
}

void pro_app_talk_over(void)
{
    pro_app_lock();
    pod_ui_talk_over(&s_pod);
    change();
    pro_app_unlock();
}

// UH pod_voice_block_reason (R8), with the open-question set standing in for the notice list.
const char *pro_app_voice_block_reason(const char *agent_id)
{
    const char *why = NULL;
    pro_app_lock();
    const pod_agent_t *pa = id_ok(agent_id) ? pod_model_find(&s_pod.model, agent_id) : NULL;
    if (pod_ui_updating(&s_pod) || atomic_load(&s_updating)) {   // the flag alone: an offer's gate holds voice off before its screen
        why = "Updating";   // a recording over a firmware write would starve it (owner, 2026-10-11)
    } else if (!s_linked) {
        why = "Not connected";
    } else if (pa) {
        const cable_machine_t *mach = NULL;
        for (int i = 0; i < POD_AGENTS_MAX && !mach; i++) {
            if (strcmp(s_info[i].id, agent_id) || !s_info[i].machine_id[0]) continue;
            for (int k = 0; k < s_mach_n; k++)
                if (!strcmp(s_mach[k].id, s_info[i].machine_id)) mach = &s_mach[k];
        }
        for (int k = 0; !mach && pa->machine[0] && k < s_mach_n; k++)
            if (!strcmp(s_mach[k].name, pa->machine)) mach = &s_mach[k];
        if (!strcmp(pa->engine, "terminal")) why = "Choose an agent pane.";
        else if (mach && !strcmp(mach->state, "offline")) why = "This computer is offline.";
        else if (mach && !strcmp(mach->state, "needs-link")) why = "Link this computer in Harness.";
        // A Super Tab wait is not answered here: talking to the agent is how a person unblocks it.
        else if (set_find(s_quest, agent_id) >= 0 && !pa->super_tab[0]) why = "Answer its question first.";
    }
    pro_app_unlock();
    return why;   // a literal, valid after the unlock
}

void pro_app_voice_result(int kind, const char *text)
{
    if (!pro_voice_open()) return;   // a reply nobody waits for
    pro_voice_close();               // MUST end the state, or the next start is refused (P22)
    pro_app_lock();
    // An error leaves the voice screen; a sent clip stays on it, sending, until its turn speaks. Words for a Swarm face were posted in
    // its chat (the round's rule): no turn of that harness follows, so the transcript is the end.
    if (kind != PRO_VOICE_OK || pod_ui_talking_to_swarm(&s_pod)) pod_ui_talk_over(&s_pod);
    else if (text && text[0] && held(text)) settle(pod_ui_sent(&s_pod, text, ms()));   // Working until its turn speaks
    if (kind == PRO_VOICE_ERROR)     // owner decision 2: the daemon's message, as Pod's notice
        pod_ui_notice(&s_pod, text && text[0] ? text : "Voice failed", ms());
    change();
    pro_app_unlock();
}

// Pod asked to record (R8, P3). The gate and the recorder run without the lock; the refusal path takes it.
static void voice_begin_effect(const char *agent)
{
    const char *why = pro_app_voice_block_reason(agent);
    const bool was_open = pro_voice_open();
    if (!why) {
        pro_voice_begin(agent);
        // The offer's gate raises s_updating BEFORE it reads whether voice is open, and a start opens voice BEFORE this reads
        // s_updating: one of the two always sees the other, so a recording never starts over an accepted update.
        if (atomic_load(&s_updating)) { pro_voice_end(false); why = "Updating"; }
    }
    if (why || !pro_voice_start_pending()) {
        // A start that was refused must not leave Talk up, and says why for a moment.
        pro_app_lock();
        pod_ui_talk_over(&s_pod);
        pod_ui_notice(&s_pod, why ? why : !s_linked ? "Not connected" : was_open ? "Still sending the last message" : "Can't talk right now", ms());
        change();
        pro_app_unlock();
    }
}

// R12: stopped before the recorder even started means nothing was recorded: cancel the start, say "Not sent".
static void voice_end_effect(void)
{
    if (pro_voice_open() && pro_voice_start_pending()) {
        pro_voice_end(false);
        pro_app_lock();
        pod_ui_unsend(&s_pod, ms());
        change();
        pro_app_unlock();
    } else {
        pro_voice_end(true);
    }
}

// ---- the finger -----------------------------------------------------------------------------------------

// Pod's Recap drag, reported to the desktop (R16). Called inside pod_ui_touch under the lock, so it only queues;
// pro_app_touch sends after the release. DOWN and MOVE need two free slots so the UP that ends the stroke always
// has one.
static bool scroll_emit(ht_scroll_phase_t phase, int dy, int velocity, void *ctx)
{
    (void)ctx;
    const int free_slots = SCROLL_MAX - s_sqn;
    if (phase == HT_SCROLL_UP ? free_slots < 1 : free_slots < 2) return false;
    s_sq[s_sqn++] = (scroll_ev_t){phase, dy, velocity};
    return true;
}

static void flush_scroll(void)
{
    scroll_ev_t q[SCROLL_MAX];
    pro_app_lock();
    const int n = s_sqn;
    memcpy(q, s_sq, (size_t)n * sizeof q[0]);
    s_sqn = 0;
    pro_app_unlock();
    for (int i = 0; i < n; i++) {
        const pro_scroll_phase_t phase = q[i].phase == HT_SCROLL_DOWN ? PRO_SCROLL_DOWN : q[i].phase == HT_SCROLL_MOVE ? PRO_SCROLL_MOVE : PRO_SCROLL_UP;
        pro_cable_send_scroll(phase, q[i].dy, q[i].velocity);
    }
}

static void cancel_locked(void)
{
    pod_ui_scroll_sink(&s_pod, scroll_emit, NULL, false);
    settle(pod_ui_touch_cancel(&s_pod));   // a cancelled drag ends with a zero UP (P4); an open recording stays (the next tap sends it)
}

bool pro_app_touch(bool down, int x, int y)
{
    pro_app_lock();
    if (pro_app_asleep()) {
        // The screen went to sleep halfway through this contact (a power key, say). Nothing is delivered; the
        // caller swallows the rest of the contact.
        cancel_locked();
        leave();
        flush_scroll();
        return false;
    }
    pod_ui_scroll_sink(&s_pod, scroll_emit, NULL, false);   // before every contact (P5); no reversed setting on the Pro
    bool redraw = false;
    const pod_out_t fx = pod_ui_touch(&s_pod, down, x, y, ms(), &redraw);
    if (redraw) change();
    settle(fx);
    leave();
    flush_scroll();
    return true;
}

void pro_app_touch_cancel(void)
{
    pro_app_lock();
    cancel_locked();
    leave();
    flush_scroll();
}

// ---- the screen's power ---------------------------------------------------------------------------------

bool pro_app_asleep(void) { return atomic_load(&s_asleep); }

void pro_app_bump_activity(void) { atomic_store(&s_last_activity, ms()); }

void pro_app_sleep(void)
{
    if (atomic_load(&s_updating)) return;   // the glass stays lit while an image is written (owner, 2026-10-11)
    if (atomic_exchange(&s_asleep, true)) return;
    if (s_renderer) xTaskNotifyGive(s_renderer);
}

void pro_app_wake(void)
{
    if (!atomic_exchange(&s_asleep, false)) return;
    pro_app_bump_activity();
    atomic_store(&s_force_frame, true);
    if (s_renderer) xTaskNotifyGive(s_renderer);
}

// ---- the side button (board/ptt_pro.c calls these on its own task) ----------------------------------------
// A press acts at once, as the round dial's ui_boot_pressed did for Pod: it wakes a sleeping screen (and does nothing
// else, since nothing is visible yet); otherwise it abandons a recording or a waiting send, else goes home to Tabs.
// A 0.8 s hold puts an awake screen to sleep; the hold that belongs to the press which just woke it does nothing, so
// holding the button to wake the screen does not put it straight back to sleep.
static bool s_button_woke;   // under the lock: the press in progress woke the screen

void pro_app_button_press(void)
{
    pro_app_lock();
    s_button_woke = pro_app_asleep();
    if (s_button_woke) pro_app_wake();
    else pro_app_bump_activity();
    const bool updating = pod_ui_updating(&s_pod);
    pro_app_unlock();
    if (s_button_woke || updating) return;   // the update screen ignores the button as it ignores touches
    if (pro_voice_open()) {
        pro_voice_end(false);   // no lock held: it may notify pro_app and send on the cable
        pro_app_lock();
        if (pod_ui_talking(&s_pod)) pod_ui_talk_over(&s_pod);
        change();
        pro_app_unlock();
        return;
    }
    pro_app_lock();
    pod_ui_navigated(&s_pod);
    pod_out_t out = {0};
    if (pod_ui_talking(&s_pod)) out = pod_nav_act(&s_pod.nav, &s_pod.model, POD_A_TABS, 0, ms());
    if (s_pod.nav.depth > 1) out = pod_nav_act(&s_pod.nav, &s_pod.model, POD_A_BACK, 0, ms());   // back one level, nothing at the root
    change();
    settle(out);
    leave();
}

void pro_app_button_hold(void)
{
    pro_app_lock();
    if (!s_button_woke) {
        if (pro_app_asleep()) pro_app_wake();
        else pro_app_sleep();
    }
    pro_app_unlock();
}

// ---- the render task's steps ----------------------------------------------------------------------------

void pro_app_tick(void)
{
    const uint32_t now = ms();
    pro_voice_tick(now);
    const bool voice_open = pro_voice_open(), voice_waiting = pro_voice_waiting();   // read before the lock
    if (voice_open || atomic_load(&s_updating)) pro_app_bump_activity();
    pro_app_lock();
    // R11: Talk on screen with no recording behind it (the start failed, the link dropped) or one the 600 s cap
    // already stopped and sent. A later back must not abort a message that is already on its way.
    // A tapped stop is not that: the voice screen stays up, sending, until the agent's turn begins (pod_nav.c).
    if (pod_ui_talking(&s_pod) && !s_pod.nav.sending && (!voice_open || voice_waiting)) {
        pod_ui_talk_over(&s_pod);
        change();
    }
    // A cross-task abort (link lost, side button, nav sync) can land between leave() and pro_voice_begin claiming
    // s_open, leaving a recording with no Talk screen. A voice with neither Talk nor a sent clip is that orphan.
    const bool orphan = pro_voice_open() && !pro_voice_waiting() && !pod_ui_talking(&s_pod);
    if (!pro_app_asleep() && pod_ui_clock_tick(&s_pod, now)) change();
    // R15: the library sweep (pod_glue.h). The request is pinned by its id; a request nobody answered is retried
    // after 3 s, one that could not be sent after 1 s.
    if (s_linked && pro_cable_library_supported()) {
        if (pod_ui_sweeping(&s_pod) &&
            (!s_lib_pending ? now - s_sweep_try_ms >= SWEEP_RETRY_MS : now - s_lib_asked_ms > SWEEP_STALL_MS)) {
            s_sweep_try_ms = now;
            queue_library(s_sweep_offset, now);
        }
        if (pod_ui_sweep_due(&s_pod, now)) {
            pod_ui_sweep_begin(&s_pod, now);
            s_sweep_offset = 0;
            s_sweep_try_ms = now;
            queue_library(0, now);
        }
    }
    leave();
    if (orphan) pro_voice_end(false);   // no lock held: it may notify pro_app and send on the cable
}

uint32_t pro_app_next_wake_ms(void)
{
    uint32_t wake = 1000;
    pro_app_lock();
    if (!pro_app_asleep()) wake = pod_ui_wake_ms(&s_pod, ms());
    pro_app_unlock();
    return wake;
}

bool pro_app_take_scene(ht_scene_t *scene)
{
    bool fresh = false;
    pro_app_lock();
    if (s_dirty) {   // R9; the hits stay in s_pod.frame for the touch task
        s_dirty = false;
        ht_scene_clear(scene, ht_rgb(HT_THEME_CANVAS));
        s_pod.frame.mic_level = (int)pro_rec_level();   // the Pets voice wave
        pod_ui_render(&s_pod, scene, ms());
        fresh = true;
    }
    pro_app_unlock();
    return fresh;
}

static void heartbeat(uint32_t frames, uint32_t raster_max_us, uint32_t frame_max_us)
{
    static uint32_t last;
    const uint32_t now = ms();
    if (!last) {
        last = now;
        return;
    }
    if (now - last < HEARTBEAT_MS) return;
    last = now;
    pro_touch_stats_t touch;
    pro_touch_stats(&touch);
    const cable_link_stats_t link = cable_link_stats();
    uint32_t bad = 0, unknown = 0;
    pro_cable_counters(&bad, &unknown);
    // The host watches this line while the renderer is alive, including while asleep.
    ESP_LOGI(TAG, "alive up=%lus heap=%u/%u psram=%u touches=%lu read_fails=%lu frames=%lu raster_max_us=%lu frame_max_us=%lu stack_free=%u muted=%d isr_rx=%lu ring_drop=%lu seq_gaps=%lu link_rx=%lu link_frames=%lu link_corrupt=%lu link_discarded=%lu link_dropped_logs=%lu msg_bad=%lu msg_unknown=%lu%s%s",
             (unsigned long)(now / 1000), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned long)touch.presses, (unsigned long)touch.read_failures, (unsigned long)frames,
             (unsigned long)raster_max_us, (unsigned long)frame_max_us,
             (unsigned)uxTaskGetStackHighWaterMark(NULL), (int)pro_settings_muted(),
             (unsigned long)link.isr_rx, (unsigned long)link.ring_drop, (unsigned long)pro_cable_seq_gaps(),
             (unsigned long)link.rx_bytes, (unsigned long)link.frames_ok, (unsigned long)link.corrupt_frames,
             (unsigned long)link.discarded_bytes, (unsigned long)link.dropped_logs, (unsigned long)bad, (unsigned long)unknown,
             touch.controller_ok ? "" : " TOUCH-DEAD", pro_app_asleep() ? " asleep" : "");
    ram_telemetry_periodic("alive");   // the heap checkpoint, and every tenth time the long-lived tasks' stack marks
}

static void render_task(void *arg)
{
    (void)arg;
    // Under the task watchdog: a render task that stops turning (a blocked panel call) is a reboot whose reason and
    // last log lines come back over the cable (last_words.c), not a frozen glass.
    ESP_ERROR_CHECK(esp_task_wdt_add(NULL));
    int front = 0;
    bool painted = false, panel_on = true;
    uint32_t frames = 0, raster_max_us = 0, frame_max_us = 0;
    for (;;) {
        ESP_ERROR_CHECK(esp_task_wdt_reset());
        last_words_phase(LW_RENDER, "render");
        pro_app_tick();
        const bool fresh = pro_app_take_scene(&s_scene[front ^ 1]);
        uint32_t wake_ms = pro_app_next_wake_ms();
        const int64_t wake_at = esp_timer_get_time() + (int64_t)wake_ms * 1000;
        const bool on = !pro_app_asleep();
        if (on != panel_on) {
            // Backlit, so "off" is the light: cutting the DSI stream would need a full re-init to come back from.
            pro_display_power(on);
            panel_on = on;
        }
        // A touch or power wake can arrive after `on` was sampled; keep its repaint request until an awake pass.
        const bool force = on && atomic_exchange(&s_force_frame, false);
        if (on && (fresh || force)) {
            if (!fresh) s_scene[front ^ 1] = s_scene[front];
            const int64_t started = esp_timer_get_time();
            uint32_t pushed_px = 0;
            const uint32_t raster_us = pro_frame_present(painted && !force ? &s_scene[front] : NULL, &s_scene[front ^ 1], &pushed_px);
            const uint32_t frame_us = (uint32_t)(esp_timer_get_time() - started);
            if (pushed_px) {   // a scene identical to the last one paints nothing: it is no frame, and its few microseconds of damage compare must not
                if (raster_us > raster_max_us) raster_max_us = raster_us;   // dilute the heartbeat's frame count or hide the slowest real frame
                if (frame_us > frame_max_us) frame_max_us = frame_us;
                frames++;
            }
            front ^= 1;
            painted = true;
            atomic_store(&s_painted, true);
        }
        if (!on && fresh) {
            front ^= 1;
            painted = false;
        }
        if (on && ms() - atomic_load(&s_last_activity) > IDLE_SLEEP_MS) {
            pro_app_lock();
            // A touch may have refreshed the activity while we waited for the lock: do not act on the stale reading.
            if (ms() - atomic_load(&s_last_activity) > IDLE_SLEEP_MS) pro_app_sleep();
            pro_app_unlock();
        }
        heartbeat(frames, raster_max_us, frame_max_us);
        // Painting used part of this frame's budget: waiting the whole interval again would halve the pet's cadence.
        const int64_t remaining = (wake_at - esp_timer_get_time() + 999) / 1000;
        wake_ms = remaining > 0 ? (uint32_t)remaining : 1;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wake_ms > 1000 ? 1000 : wake_ms));
    }
}

void pro_app_set_brightness(uint8_t level) { pro_display_set_brightness(level); }

void pro_app_start(void)
{
    if (s_started) return;
    s_started = true;
    s_lock = xSemaphoreCreateRecursiveMutex();
    assert(s_lock);
    pod_ui_init(&s_pod);
    s_dirty = true;
    pro_frame_init();
    pro_display_set_brightness(config_load_brightness());
    pro_app_bump_activity();
    BaseType_t ok = xTaskCreatePinnedToCore(render_task, "pro_render", STACK_RENDER, NULL, 5, &s_renderer, 1);
    assert(ok == pdPASS);
    (void)ok;
    ESP_LOGI(TAG, "app up: Pod, render stack %d B", STACK_RENDER);
}

// ---- firmware update (sys/fw_update.c calls these, from the cable task) -----------------------------------------

static void ota_screen(const char *from, const char *to, int pct, bool restarting)
{
    pro_app_lock();
    pod_ui_ota(&s_pod, from, to, pct, restarting);
    atomic_store(&s_updating, pct >= 0);
    change();
    pro_app_unlock();
}

bool pro_app_begin_update_gate(void)
{
    pro_app_lock();
    atomic_store(&s_updating, true);   // first: a voice start that opens after this sees it and backs out
    const bool busy = pro_voice_open() || pro_voice_start_pending();
    if (busy) atomic_store(&s_updating, false);
    pro_app_unlock();
    return !busy;
}

// The offer was refused before accept: no screen was shown, so no notice either; voice may start again.
void pro_app_end_update_gate(void)
{
    pro_app_lock();
    if (!pod_ui_updating(&s_pod)) atomic_store(&s_updating, false);
    pro_app_unlock();
}

void fw_update_ui_begin(const char *from, const char *to)
{
    snprintf(s_ota_from, sizeof s_ota_from, "%s", from ? from : "");
    snprintf(s_ota_to, sizeof s_ota_to, "%s", to ? to : "");
    ota_screen(s_ota_from, s_ota_to, 0, false);
    pro_app_wake();   // a dark glass lights for it, and stays lit (pro_app_sleep refuses)
}
void fw_update_ui_pct(int pct) { ota_screen(s_ota_from, s_ota_to, pct < 0 ? 0 : pct, false); }
void fw_update_ui_restarting(const char *to)
{
    snprintf(s_ota_to, sizeof s_ota_to, "%s", to ? to : "");
    ota_screen(s_ota_from, s_ota_to, 100, true);
}
void fw_update_ui_failed(void)
{
    pro_app_lock();
    pod_ui_ota(&s_pod, "", "", -1, false);   // the screen under it comes back
    atomic_store(&s_updating, false);
    pod_ui_notice_bad(&s_pod, "Update failed \xc2\xb7 trying again later", ms());
    change();
    pro_app_unlock();
    pro_app_bump_activity();
}

// After fw_mark_valid: if this boot is the first of an update, say so once the cable is up.
static void show_updated(void)   // under the lock, linked
{
    char text[48];
    snprintf(text, sizeof text, "Updated to %s", s_updated);
    s_updated[0] = 0;
    pod_ui_notice(&s_pod, text, ms());
    change();
}

void pro_app_note_update(void)
{
    char version[24];
    if (!fw_was_updated(version, sizeof version)) return;
    pro_app_lock();
    snprintf(s_updated, sizeof s_updated, "%s", version);
    if (s_linked) show_updated();
    pro_app_unlock();
}

bool pro_app_wait_first_frame(uint32_t timeout_ms)
{
    for (uint32_t waited = 0; !atomic_load(&s_painted); waited += 20) {
        if (waited >= timeout_ms) return false;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    return true;
}

// ---- host test seams ------------------------------------------------------------------------------------

pod_ui_t *pro_app_test_pod(void) { return &s_pod; }

bool pro_app_test_take_dirty(void)
{
    pro_app_lock();
    const bool dirty = s_dirty;
    s_dirty = false;
    pro_app_unlock();
    return dirty;
}

void pro_app_test_reset(void)
{
    if (!s_lock) s_lock = xSemaphoreCreateRecursiveMutex();
    pod_ui_init(&s_pod);
    memset(s_info, 0, sizeof s_info);
    memset(s_busy, 0, sizeof s_busy);
    memset(s_quest, 0, sizeof s_quest);
    memset(s_alerted, 0, sizeof s_alerted);
    s_mach_n = 0;
    s_linked = false;
    s_dirty = true;
    s_fxn = 0;
    s_beepq = s_wakeq = s_beep_set = false;
    s_sqn = 0;
    s_libq.on = false;
    s_sweep_offset = 0;
    s_sweep_try_ms = 0;
    s_lib_request = 0;
    s_lib_asked_ms = 0;
    s_lib_pending = false;
    atomic_store(&s_asleep, false);
    atomic_store(&s_force_frame, false);
    atomic_store(&s_updating, false);
    s_updated[0] = 0;
}
