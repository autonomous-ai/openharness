// Harness Max's app layer, after the Pro's pro_app.c. pro_cable's callbacks (pro_app_api.h) become feeds into the
// model of the pages (max_ui.h), the touch task's contacts become taps and swipes, and the render task draws the model.
//
// THREADS: the cable_link task calls the pro_app_* callbacks; the touch task calls pro_app_touch; the voice tasks call
// pro_app_notice; the render task ticks, draws and paints. One recursive mutex guards the model, the dirty flag and the
// state below. Nothing that leaves the device is sent under it: a tap's agent.open or app pick, a recording's start and
// its send (a tap's or the clock's), the chime and the wake happen after the mutex is released. So does the model's
// outbox (answers, question reads, the New Harness form): taken under the mutex, sent after it, by the touch task (a
// tap's, waiting for the port as agent.open does) or the render task (the clock's, never waiting).
#include "app/max_app.h"

#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "app/max_chime.h"
#include "app/max_ui.h"
#include "app/max_voice_lang.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "audio/audio_capture.h"
#include "audio/pro_recorder.h"
#include "cable/max_cable.h"
#include "cable/cable_link.h"
#include "cable/pro_cable.h"
#include "display/max_frame.h"
#include "display/max_present.h"
#include "pro_app_api.h"
#include "pro_display.h"
#include "pro_frame.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"
#include "sys/last_words.h"
#include "sys/ram_telemetry.h"
#include "task_stacks.h"
#include "terminal.h"
#include "theme.h"

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#ifndef ESP_PLATFORM
#define EXT_RAM_BSS_ATTR   // the host has no PSRAM
#endif

_Static_assert(HT_WIDTH == PRO_DISPLAY_W && HT_HEIGHT == PRO_DISPLAY_H, "the scene is the glass");

static const char *TAG = "max";

#define IDLE_SLEEP_MS 300000u       // no touch for this long and the screen sleeps, as the Pro
#define HEARTBEAT_MS 60000u
#define CHIME_COALESCE_MS 30000     // one chime of a sound for its alerts of this long (V3's, the Pro's beep's)
#define ASKED_MAX 32                // pro_app_agents sends at most 32 agents
#define WARM_ROOM_US 5000           // a step painted ahead only with this much left before the next frame is due
#define WARM_STEP_US 3000           // a step painting out of the lock: no band begun that the last says ends past it

static EXT_RAM_BSS_ATTR ht_scene_t s_scene[2];

static SemaphoreHandle_t s_lock;
static TaskHandle_t s_renderer;
static bool s_started, s_linked, s_dirty;
static bool s_update_shown;   // the update screen is up (fw_update_ui_begin .. a failure)
static unsigned s_chimeq;     // 1 << max_chime_t: the sounds to play once the lock is released
static bool s_wakeq;          // an alert landed: light a dark glass once the lock is released
static bool s_chimed[MAX_CHIME_DONE + 1];
static uint32_t s_chimed_ms[MAX_CHIME_DONE + 1];   // when each sound was last queued
// The questions already chimed for: the agent and its question's request and prompt. Kept over a relink, so a question
// the daemon sends again when the cable comes back does not chime twice; its close forgets it.
static struct { char id[ID_MAX]; uint32_t key; } s_asked[ASKED_MAX];

static atomic_bool s_asleep, s_force_frame;
static atomic_bool s_updating, s_painted;   // an image is being written (readable without the lock); the first frame is out
static atomic_uint s_last_activity;
static char s_ota_to[24];    // the version being installed (the cable task's)
static char s_updated[24];   // "Updated to X": set by pro_app_note_update, shown once the cable is up
// What each sending task takes from the outbox: its own, so neither waits on the other's.
typedef struct {
    max_out_t out[MAX_OUTBOX];
    max_answer_t answer;
    int n;
} outbox_t;
static EXT_RAM_BSS_ATTR outbox_t s_touch_out, s_tick_out;

static uint32_t ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

static bool id_ok(const char *id) { return id && id[0] && strnlen(id, ID_MAX) < ID_MAX; }

// ---- the lock, the dirty flag, the queued effects --------------------------------------------------------

static void lock(void)
{
    if (s_lock) xSemaphoreTakeRecursive(s_lock, portMAX_DELAY);
}

static void unlock(void)
{
    if (s_lock) xSemaphoreGiveRecursive(s_lock);
}

// Mark the scene stale and wake the renderer.
static void change(void)
{
    s_dirty = true;
    if (s_renderer) xTaskNotifyGive(s_renderer);
}

static void changed_if(bool changed)
{
    if (changed) change();
}

// What rang in the model (MAX_NEWS_*; the caller holds the lock): wake the glass, and queue each alert's sound (V3's: a
// question MAX_CHIME_ASK, a failure MAX_CHIME_FAILED, a loud finished turn MAX_CHIME_DONE) unless that sound was queued
// in the last CHIME_COALESCE_MS, so a soft done never holds back a question's chime. Quiet over an update.
static void alert_locked(unsigned news)
{
    if (!news || atomic_load(&s_updating)) return;
    s_wakeq = true;
    const uint32_t now = ms();
    static const struct { unsigned news; max_chime_t sound; } SOUNDS[] = {
        {MAX_NEWS_ASK, MAX_CHIME_ASK}, {MAX_NEWS_FAILED, MAX_CHIME_FAILED}, {MAX_NEWS_DONE, MAX_CHIME_DONE}};
    for (size_t i = 0; i < sizeof SOUNDS / sizeof SOUNDS[0]; i++) {
        const max_chime_t sound = SOUNDS[i].sound;
        if (!(news & SOUNDS[i].news) || (s_chimed[sound] && (int32_t)(now - s_chimed_ms[sound]) < CHIME_COALESCE_MS))
            continue;
        s_chimed[sound] = true;
        s_chimed_ms[sound] = now;
        s_chimeq |= 1u << sound;
    }
}

// Release the lock, then light and chime as the feeds asked. Every feed that took the lock ends here.
static void leave(void)
{
    alert_locked(max_ui_take_news());
    const unsigned chimes = s_chimeq;
    const bool wake = s_wakeq;
    s_chimeq = 0;
    s_wakeq = false;
    unlock();
    if (wake) pro_app_wake();
    for (int sound = MAX_CHIME_ASK; sound <= MAX_CHIME_DONE; sound++)
        if ((chimes & (1u << sound)) && !pro_settings_muted() && !atomic_load(&s_updating))
            max_chime((max_chime_t)sound);
}

static void notice_locked(const char *text) { changed_if(max_ui_notice(text, MAX_NOTICE_MS, ms())); }

// ---- the outbox ----------------------------------------------------------------------------------------------

// Under the lock: what the model queued, into this task's box.
static void take_locked(outbox_t *box)
{
    box->n = max_ui_take(box->out, MAX_OUTBOX, &box->answer, ms());
    changed_if(box->n > 0);   // a plain answer shows as sent, a read leaves its card as it was: drawing again is cheap
}

static bool send_one(const max_out_t *o, const max_answer_t *answer, bool wait)
{
    switch (o->kind) {
    case MAX_OUT_READ: return pro_cable_question_read(o->agent, o->fetch, wait);
    case MAX_OUT_REVIEWED: return pro_cable_answer_reviewed(o->agent, o->token, o->fetch, o->choices, o->count, wait);
    case MAX_OUT_ANSWER: {
        const char *keys[PRO_ASK_ITEMS], *values[PRO_ASK_ITEMS];
        for (int i = 0; i < answer->count && i < PRO_ASK_ITEMS; i++) keys[i] = answer->keys[i], values[i] = answer->values[i];
        return pro_cable_answer(o->agent, o->request, keys, values, answer->count, wait);
    }
    case MAX_OUT_FORM: return pro_cable_form(o->form, o->fetch, max_form_op_name(o->op), o->revision, o->delta, wait);
    }
    return false;
}

// After the lock: send what was taken; tell the model of each that did not go out.
static void send_taken(outbox_t *box, bool wait)
{
    for (int i = 0; i < box->n; i++) {
        if (send_one(&box->out[i], &box->answer, wait)) continue;
        lock();
        changed_if(max_ui_unsent(&box->out[i], ms()));
        unlock();
    }
    box->n = 0;
}

static void show_updated(void);

// ---- the link and the roster ------------------------------------------------------------------------------

void pro_app_link(bool up, const char *machine)
{
    if (!up) pro_voice_link_lost();   // the cable is dead: end the recording without telling the daemon
    lock();
    s_linked = up;
    changed_if(max_ui_link(up, machine, ms()));
    if (up && s_updated[0]) show_updated();   // the first screen the new image shows with a cable: "Updated to X.Y.Z"
    leave();
}

void pro_app_agents(const pro_agent_row_t *rows, int n)
{
    lock();
    changed_if(max_ui_agents(rows, n, ms()));
    leave();
}

void pro_app_apps(const char *shown, const pro_app_row_t *rows, int n)
{
    lock();
    changed_if(max_ui_apps(shown, rows, n, ms()));
    leave();
}

void pro_app_machines(const cable_machine_t *rows, int count, const char *selected)
{
    lock();
    changed_if(max_ui_machines(rows, count, selected));
    leave();
}

// The Max has no tabs, no library and no context line: these are parsed by pro_cable and dropped here.
void pro_app_swarms(const cable_swarm_t *items, int n, const cable_swarm_members_t *members, const char *selected,
                    const cable_tile_t *tiles, int tile_n)
{
    (void)items; (void)n; (void)members; (void)selected; (void)tiles; (void)tile_n;
}

void pro_app_library(const pro_library_row_t *rows, int count, int offset, int total)
{
    (void)rows; (void)count; (void)offset; (void)total;
}

void pro_app_context(const char *id, const char *machine, const char *project, const char *branch, const char *engine)
{
    (void)id; (void)machine; (void)project; (void)branch; (void)engine;
}

// ---- turns, summaries, questions, focus -----------------------------------------------------------------

void pro_app_turn(const char *id, const char *kind, const char *text, int elapsed_s)
{
    if (!id_ok(id) || !kind) return;
    lock();
    changed_if(max_ui_turn(id, kind, text, elapsed_s, ms()));   // a failure rings (leave)
    leave();
}

void pro_app_turn_stats(const char *id, int tests_passed, int tests_failed, int commits, int tokens_in, int tokens_out)
{
    (void)id; (void)tests_passed; (void)tests_failed; (void)commits; (void)tokens_in; (void)tokens_out;
}

void pro_app_summary(const char *id, const char *text, const char *recap, const char *full, bool restore, pod_tier_t tier)
{
    (void)full;   // the pages show a short note: the long recap has nowhere to go
    if (!id_ok(id)) return;
    lock();
    changed_if(max_ui_summary(id, text, recap, restore, tier, ms()));   // the loud tier rings (leave), list only shows
    leave();
}

// The daemon's drawer: its question rows are questions it gives the bar no other way (max_ui_notices), filed silently,
// as they rang before. Its news rows add nothing: the bar keeps its own Inbox from the turns it sees.
void pro_app_notif_replace(const pro_notif_row_t *rows, int n)
{
    const bool review = pro_cable_supports(CABLE_FEATURE_QUESTION_REVIEW);
    lock();
    changed_if(max_ui_notices(rows, n, review, ms()));
    leave();
}

void pro_app_notif_seen(const char *id, const char *token)
{
    (void)id; (void)token;
}

// FNV-1a of the request id and the prompt, as the Pro's: a lost close must not mute the next question.
static uint32_t ask_key(const char *request, const char *text)
{
    uint32_t h = 2166136261u;
    for (const char *c = request ? request : ""; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
    h = (h ^ 0u) * 16777619u;
    for (const char *c = text ? text : ""; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
    return h;
}

// True when this question has not chimed yet, and remember it. A full table chimes and remembers nothing.
static bool ask_is_new(const char *id, uint32_t key)
{
    int free_slot = -1;
    for (int i = 0; i < ASKED_MAX; i++) {
        if (!strcmp(s_asked[i].id, id)) {
            if (s_asked[i].key == key) return false;
            s_asked[i].key = key;
            return true;
        }
        if (free_slot < 0 && !s_asked[i].id[0]) free_slot = i;
    }
    if (free_slot >= 0) {
        snprintf(s_asked[free_slot].id, sizeof s_asked[free_slot].id, "%s", id);
        s_asked[free_slot].key = key;
    }
    return true;
}

// The Max takes the whole question from pro_app_ask, which follows this with the same prompt and its options.
void pro_app_question(const char *id, const char *request, const char *text)
{
    (void)id; (void)request; (void)text;
}

void pro_app_ask(const char *id, const char *name, const char *request, const char *text, const pro_ask_item_t *items,
                 int n, bool permission, bool listed)
{
    if (!id_ok(id)) return;
    const bool review = pro_cable_supports(CABLE_FEATURE_QUESTION_REVIEW);   // the reviewed path, when the daemon has it
    // A list row rang before: silent only when the welcome listed question.tier, so nothing this build cannot vouch
    // for mutes a question (the round dial's rule).
    const bool quiet = listed && pro_cable_supports(CABLE_FEATURE_QUESTION_TIER);
    lock();
    const bool changed = max_ui_question_from(id, name, request, text, items, n, permission, review, quiet, ms());
    changed_if(changed);
    // Remembered either way (a quiet one too): the same question rung again, after the cable came back, is not news.
    unsigned news = max_ui_take_news();
    if (changed && !ask_is_new(id, ask_key(request, text))) news &= ~(unsigned)MAX_NEWS_ASK;
    alert_locked(news);
    leave();
}

void pro_app_question_state(const char *id, const char *fetch, bool ok, const char *request, const char *token,
                            bool submitted, const char *error, const pro_ask_item_t *items, int n)
{
    if (!id_ok(id)) return;
    lock();
    changed_if(max_ui_question_state(id, fetch, ok, request, token, submitted, error, items, n, ms()));
    leave();
}

void pro_app_answer_receipt(const char *id, const char *fetch, const char *token, bool ok, bool pending, const char *error)
{
    if (!id_ok(id)) return;
    lock();
    changed_if(max_ui_answer_receipt(id, fetch, token, ok, pending, error, ms()));
    leave();
}

void pro_app_toast(const char *text)
{
    lock();
    notice_locked(text);
    leave();
}

// ---- New Harness -------------------------------------------------------------------------------------------

void pro_app_form_state(const char *request, const char *form_id, bool ok, const pro_form_page_t *page)
{
    lock();
    changed_if(max_ui_form_state(request, form_id, ok, page, ms()));
    leave();
}

void pro_app_question_close(const char *id)
{
    if (!id_ok(id)) return;
    lock();
    for (int i = 0; i < ASKED_MAX; i++)
        if (!strcmp(s_asked[i].id, id)) s_asked[i].id[0] = 0;
    changed_if(max_ui_question_close(id));
    leave();
}

void pro_app_focus(const char *id)
{
    if (!id_ok(id)) return;
    lock();
    changed_if(max_ui_focus(id));
    leave();
}

// ---- voice -------------------------------------------------------------------------------------------------

void pro_app_notice(const char *text)
{
    lock();
    notice_locked(text);
    unlock();
}

// The bar's voice follows the recorder: recording (or starting), sending (stopped, its reply awaited), or idle. The
// caller reads the recorder before taking the lock.
static void talk_locked(bool open, bool waiting)
{
    changed_if(max_ui_talk(!open ? MAX_TALK_IDLE : waiting ? MAX_TALK_SENDING : MAX_TALK_RECORDING, ms()));
}

static void talk_sync(void)
{
    const bool open = pro_voice_open(), waiting = pro_voice_waiting();
    lock();
    talk_locked(open, waiting);
    unlock();
}

// As the Pro's, the agent Working until its turn speaks; the page's SEND scene, played, shrinks back into Overview,
// and an error's at once.
void pro_app_voice_result(int kind, const char *text)
{
    if (!pro_voice_open()) return;   // a reply nobody waits for
    pro_voice_close();               // MUST end the state, or the next start is refused
    lock();
    talk_locked(false, false);
    changed_if(max_ui_voice_result(kind == PRO_VOICE_OK, kind == PRO_VOICE_OK ? text : NULL, ms()));
    if (kind == PRO_VOICE_ERROR) notice_locked(text && text[0] ? text : "Voice failed");   // the daemon's message
    unlock();
}

// A spoken name's reply: it ends the recording like any voice reply, and moves the form.
void pro_app_voice_form(const char *form_id, bool ok, const pro_form_page_t *page)
{
    if (pro_voice_open()) pro_voice_close();
    lock();
    talk_locked(false, false);
    changed_if(max_ui_voice_form(form_id, ok, page, ms()));
    unlock();
}

// Why a recording must not start now (the screen's copy), or NULL: a firmware write would starve it, and without a
// link there is nobody to send it to.
static const char *voice_gate(void)
{
    const char *why = NULL;
    lock();
    if (atomic_load(&s_updating)) why = "Updating";
    else if (!s_linked) why = "Not connected";
    unlock();
    return why;   // a literal, valid after the unlock
}

// A tap that opens the mic (a cell, the agent page, Say it) or the form's Say: record for this agent ("": the form's).
// No lock held: the recorder may call back.
static void talk_begin(const char *agent)
{
    const char *why = voice_gate();
    const bool was_open = pro_voice_open();
    if (!why) {
        pro_voice_begin(agent);
        // The offer's gate raises s_updating BEFORE it reads whether voice is open, and a start opens voice BEFORE this
        // reads s_updating: one of the two always sees the other, so a recording never starts over an accepted update.
        if (atomic_load(&s_updating)) { pro_voice_end(false); why = "Updating"; }
    }
    // Started: open and not a send still waiting for its reply (which refuses the start and stays open).
    const bool open = pro_voice_open(), waiting = pro_voice_waiting();
    const bool started = !why && open && !waiting;
    lock();
    if (!started)
        notice_locked(why ? why : was_open ? "Still sending the last message" : "Can't talk right now");
    talk_locked(open, waiting);
    unlock();
}

// Send while recording (a tap, or the clock's cap). Stopped before the recorder even started, nothing was recorded.
static void talk_send(void)
{
    if (pro_voice_open() && pro_voice_start_pending()) {
        pro_voice_end(false);
        lock();
        talk_locked(pro_voice_open(), pro_voice_waiting());   // the mic shut first: the page it left shrinks back
        changed_if(max_ui_voice_result(false, NULL, ms()));   // nothing went: no SEND scene
        unlock();
        pro_app_notice("Not sent");
    } else {
        pro_voice_end(true);
    }
    talk_sync();
}

// ---- the finger -------------------------------------------------------------------------------------------

// New Harness under a name of its own: the desktop keeps one form per name.
static void new_form(void)
{
    char id[MAX_FORM_ID_BYTES];
    snprintf(id, sizeof id, "form-%08lx-%08lx", (unsigned long)esp_random(), (unsigned long)ms());
    lock();
    changed_if(max_ui_form_open(id, ms()));
    take_locked(&s_touch_out);
    unlock();
    send_taken(&s_touch_out, true);
}

static void act(const max_act_t *a)
{
    switch (a->kind) {
    case MAX_ACT_OPEN: pro_cable_send_open(a->agent_id); break;   // agent.open, as the Pro's tap on an agent
    case MAX_ACT_TALK:
        pro_cable_voice_form(NULL, 0);   // a turn for the agent
        talk_begin(a->agent_id);
        break;
    case MAX_ACT_SAY:
        pro_cable_voice_form(a->form_id, a->revision);   // a name for the form's field: no agent
        talk_begin("");
        break;
    case MAX_ACT_SEND: talk_send(); break;
    case MAX_ACT_CANCEL:   // stopped, nothing sent
        pro_voice_end(false);
        talk_sync();
        break;
    case MAX_ACT_NEW: new_form(); break;
    case MAX_ACT_OPEN_TALK:   // a cell's one tap: the computer opens the agent; the clock's MAX_ACT_TALK, the mic
        pro_cable_send_open(a->agent_id);
        break;
    case MAX_ACT_PICK:   // the person's pick: the `apps` that answers it is no "Following"
        lock();
        max_ui_app_picked(a->app);
        unlock();
        pro_cable_app_pick(a->app, true);
        break;
    case MAX_ACT_NONE: break;
    }
}

bool pro_app_touch(bool down, int x, int y)
{
    lock();
    if (pro_app_asleep()) {
        // The screen went to sleep halfway through this contact. Nothing is delivered; the caller swallows the rest.
        max_ui_touch_cancel();
        unlock();
        return false;
    }
    const uint32_t now = ms();
    const max_act_t a = max_ui_touch(down, x, y, now);
    take_locked(&s_touch_out);      // an answer or a form command the tap queued
    changed_if(max_ui_tick(now));   // a tap that put a page up, a swipe that paged the cells
    leave();
    send_taken(&s_touch_out, true);
    act(&a);
    return true;
}

void pro_app_touch_cancel(void)
{
    lock();
    max_ui_touch_cancel();
    unlock();
}

// ---- the screen's power -----------------------------------------------------------------------------------

bool pro_app_asleep(void) { return atomic_load(&s_asleep); }

void pro_app_bump_activity(void) { atomic_store(&s_last_activity, ms()); }

void pro_app_sleep(void)
{
    if (atomic_load(&s_updating)) return;   // the glass stays lit while an image is written
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

// ---- the render task --------------------------------------------------------------------------------------

// The wall clock for Ambient, read before the lock: unknown until the daemon or NTP set it (a clock still in 1970).
static void wall(bool *known, struct tm *t)
{
    const time_t now = time(NULL);
    *known = localtime_r(&now, t) != NULL && t->tm_year + 1900 >= 2024;
}

static void tick(void)
{
    const uint32_t now = ms();
    pro_voice_tick(now);
    const bool open = pro_voice_open(), waiting = pro_voice_waiting();   // read before the lock
    const unsigned level = pro_rec_level();
    const bool form = pro_cable_supports(CABLE_FEATURE_FORM);
    struct tm t = {0};
    bool known = false;
    wall(&known, &t);
    if (open || atomic_load(&s_updating)) pro_app_bump_activity();
    lock();
    talk_locked(open, waiting);   // the 600 s cap, a recorder that died, a reply that never came
    changed_if(max_ui_level(level, now));
    const max_act_t due = max_ui_talk_due(now);   // speech then quiet: sent; nothing heard: the mic closes
    changed_if(due.kind != MAX_ACT_NONE);
    changed_if(max_ui_wall(known, t.tm_hour, t.tm_min, t.tm_wday, t.tm_mday, t.tm_mon));
    changed_if(max_ui_offers(form));
    take_locked(&s_tick_out);     // a question read again, the form's poll, a reply that never came
    if (!pro_app_asleep()) changed_if(max_ui_tick(now));
    unlock();
    send_taken(&s_tick_out, false);
    act(&due);
}

static uint32_t next_wake_ms(void)
{
    uint32_t wake = 1000;
    lock();
    if (!pro_app_asleep()) wake = max_ui_next_wake_ms(ms());
    unlock();
    return wake;
}

static bool take_scene(ht_scene_t *scene)
{
    bool fresh = false;
    lock();
    if (s_dirty) {   // the hit areas stay in the model for the touch task
        s_dirty = false;
        ht_scene_clear(scene, ht_rgb(HT_THEME_CANVAS));
        max_ui_render(scene, ms());
        fresh = true;
    }
    unlock();
    return fresh;
}

// What a tap on App Detail's row would show next, painted ahead while it rests (max_ui_warm): while nothing changed and
// the next frame is more than WARM_ROOM_US away, a step at a time. A frame drawn aside under the lock (a fraction of a
// frame's build), or out of it what that frame needs made, WARM_STEP_US of bands (max_ui_warm_paint), none while the row
// moves: a touch or a message waits one frame aside at most, and the glass's own frames come on time.
static int64_t s_warm_until, s_band_from;
// Another band while the last one's time is left before the step's end: a step ends inside it, but for a band longer
// than the step.
static bool warm_on(void)
{
    const int64_t now = esp_timer_get_time(), band = now - s_band_from;
    s_band_from = now;
    return now + band < s_warm_until;
}
static void warm_ahead(int64_t wake_at)
{
    for (bool more = true; more && wake_at - esp_timer_get_time() > WARM_ROOM_US;) {
        lock();
        more = !s_dirty && max_ui_warm_rests(ms());   // a motion's frames first
        unlock();
        s_band_from = esp_timer_get_time();
        s_warm_until = s_band_from + WARM_STEP_US;
        if (more && !max_ui_warm_paint(warm_on)) {
            lock();
            more = !s_dirty && max_ui_warm(ms());
            unlock();
        }
        ESP_ERROR_CHECK(esp_task_wdt_reset());
    }
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
    // The Pro's line, field for field: the host watches it while the renderer is alive, including while asleep.
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
    ram_telemetry_periodic("alive");
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
        tick();
        const bool fresh = take_scene(&s_scene[front ^ 1]);
        uint32_t wake_ms = next_wake_ms();
        const int64_t wake_at = esp_timer_get_time() + (int64_t)wake_ms * 1000;
        const bool on = !pro_app_asleep();
        if (on != panel_on) {
            // "Off" is the light: the picture stays in the framebuffer, so a wake is instant.
            pro_display_power(on);
            panel_on = on;
        }
        // A touch or alert wake can arrive after `on` was sampled; keep its repaint request until an awake pass.
        const bool force = on && atomic_exchange(&s_force_frame, false);
        if (on && (fresh || force)) {
            if (!fresh) s_scene[front ^ 1] = s_scene[front];
            const int64_t started = esp_timer_get_time();
            uint32_t pushed_px = 0;
            const uint32_t raster_us = max_present(painted && !force ? &s_scene[front] : NULL, &s_scene[front ^ 1], &pushed_px);
            if (pushed_px) max_frame_show();   // in the frame's time: a flipping output waits for the screen here
            const uint32_t frame_us = (uint32_t)(esp_timer_get_time() - started);
            if (pushed_px) {   // a scene identical to the last one paints nothing: it is no frame
                if (raster_us > raster_max_us) raster_max_us = raster_us;
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
            lock();
            // A touch may have refreshed the activity while we waited for the lock: do not act on the stale reading.
            if (ms() - atomic_load(&s_last_activity) > IDLE_SLEEP_MS) pro_app_sleep();
            unlock();
        }
        heartbeat(frames, raster_max_us, frame_max_us);
        if (on) warm_ahead(wake_at);
        // Painting used part of this pass's budget; and the recorder's clocks need a tick at least once a second.
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
    max_ui_reset();
    max_ui_share(true);   // the row's blurs: the frame path's two tasks do them, out of the model's lock
    max_present_work(max_ui_work);
    s_dirty = true;
    pro_frame_init();
    max_voice_lang_default();   // before the cable's hello, which reports the language, and before any recording
    pro_display_set_brightness(config_load_brightness());
    pro_app_bump_activity();
    BaseType_t ok = xTaskCreatePinnedToCore(render_task, "pro_render", STACK_RENDER, NULL, 5, &s_renderer, 1);
    assert(ok == pdPASS);
    (void)ok;
    ESP_LOGI(TAG, "app up: pages, render stack %d B", STACK_RENDER);
}

// ---- firmware update (sys/fw_update.c and pro_cable call these, from the cable task) ------------------------

static void update_screen(int pct, const char *to)
{
    lock();
    s_update_shown = pct >= 0;
    atomic_store(&s_updating, pct >= 0);
    changed_if(max_ui_update(pct, to));
    unlock();
}

bool pro_app_begin_update_gate(void)
{
    lock();
    atomic_store(&s_updating, true);   // first: a voice start that opens after this sees it and backs out
    const bool busy = pro_voice_open() || pro_voice_start_pending();
    if (busy) atomic_store(&s_updating, false);
    unlock();
    return !busy;
}

// The offer was refused before accept: no screen was shown, so no notice either; voice may start again.
void pro_app_end_update_gate(void)
{
    lock();
    if (!s_update_shown) atomic_store(&s_updating, false);
    unlock();
}

void fw_update_ui_begin(const char *from, const char *to)
{
    (void)from;   // the screen names the version it installs
    snprintf(s_ota_to, sizeof s_ota_to, "%s", to ? to : "");
    update_screen(0, s_ota_to);
    pro_app_wake();   // a dark glass lights for it, and stays lit (pro_app_sleep refuses)
}

void fw_update_ui_pct(int pct) { update_screen(pct < 0 ? 0 : pct, s_ota_to); }

void fw_update_ui_restarting(const char *to)
{
    snprintf(s_ota_to, sizeof s_ota_to, "%s", to ? to : "");
    update_screen(100, s_ota_to);
}

void fw_update_ui_failed(void)
{
    update_screen(-1, NULL);   // the pages come back
    pro_app_notice("Update failed \xc2\xb7 trying again later");
    pro_app_bump_activity();
}

// After fw_mark_valid: if this boot is the first of an update, say so once the cable is up.
static void show_updated(void)   // under the lock, linked
{
    char text[48];
    snprintf(text, sizeof text, "Updated to %s", s_updated);
    s_updated[0] = 0;
    notice_locked(text);
}

void pro_app_note_update(void)
{
    char version[24];
    if (!fw_was_updated(version, sizeof version)) return;
    lock();
    snprintf(s_updated, sizeof s_updated, "%s", version);
    if (s_linked) show_updated();
    unlock();
}

bool pro_app_wait_first_frame(uint32_t timeout_ms)
{
    for (uint32_t waited = 0; !atomic_load(&s_painted); waited += 20) {
        if (waited >= timeout_ms) return false;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    return true;
}
