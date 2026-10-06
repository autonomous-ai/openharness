// Habitat: bounded state + text runs. Protocol callbacks update data, never create widgets.
#include "runtime.h"
#include "scroll.h"
#include "workspace.h"
#include "selection.h"
#include "carry.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "gestures.h"
#include "character.h"
#ifdef DEVICE_TIM_ILLUSTRATED
#include "tim_illustrated.h"
#endif
#include "perf_bench.h"
#include "command_face.h"
#include "theme.h"
#ifdef DEVICE_PRO_COMPANION
#include "pro_canvas.h"
#include "pro_visual.h"
#include "pro_work_intent.h"
#include "pro_metrics.h"
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "audio_speech.h"
#include "../companion_speech.h"
#endif
#ifdef DEVICE_CREATURE_GALLERY
#include "creature_gallery.h"
static ht_gallery_t gallery;
#endif
#include "ui_screens.h"
#include "display.h"
#include "audio_client.h"
#include "audio_capture.h"
#include "config_store.h"
#include "cable_client.h"
#include "esp_attr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_app_desc.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "cJSON.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <assert.h>
#ifdef DEVICE_PRO_COMPANION
#include "../../pro_voice_samples.h"
#endif

#ifdef DEVICE_PRO_COMPANION
#define NOTICES 72 // Host catalog: 64 pending questions plus eight unread notices.
#else
#define NOTICES 24
#endif
#define QUESTION_MAX 4
#define OPTION_MAX 6
// FOUR ROWS, PITCH 64. Five at 56 put the last line at 112 + 4*56 + 14 + 38 = 388, two pixels into
// the footer at 390. Four at 64 end at 356 and leave it alone.
#define TAB_ROWS 4
#define TAB_ROW_HEIGHT 64
#define TAB_TOP 112
#define PANE_MEMORY_MAX 128
#define PANE_RESULT_BYTES 1024
typedef enum {
    HOME,
#ifdef DEVICE_PRO_COMPANION
    LAUNCHER, WORK_INTENT, TODAY, CARRY_PREVIEW,
    DAEMONS, SCENES, VOICE_SAMPLES, VOICE_PARAMS, LANGUAGE,
#endif
    AGENTS,
    AGENT,
    READER,
    QUESTION,
    CHOICE,
    ANSWER_REVIEW,
    INBOX,
    TABS,
    MACHINES,
    VOICE,
    SELECTION,
    FORM,
    DRAFT,
    DRAFT_OPTIONS,
    COMPANION,
    SETTINGS,
    STOP,
    MODELS,
    MESSAGE,
    OTA
} view_t;
typedef enum {
    A_NONE,
    A_FIND, A_FORM, A_FORM_MAIN, A_FORM_BACK, A_FORM_SEND, A_FORM_SAY,
    A_HOME,
#ifdef DEVICE_PRO_COMPANION
    A_LAUNCHER, A_WORK_INTENT, A_WORK_MODE, A_WORK_RECORD, A_AGENT_LAYOUT,
    A_TODAY, A_TODAY_REFRESH, A_METRICS_GET,
    A_CARRY_PREVIEW, A_QUESTION_CLOSE, A_DRAFT_STORE,
    A_LANGUAGE, A_LANGUAGE_SET,
    A_DAEMONS, A_SCENES, A_APPEAR_PREVIOUS, A_APPEAR_NEXT, A_APPEAR_USE, A_APPEAR_SAVE,
    A_VOICE_SAMPLES, A_SAMPLE_PREVIOUS, A_SAMPLE_NEXT, A_SAMPLE_PLAY,
    A_SAMPLE_VOLUME, A_SAMPLE_PARAMS,
#endif
    A_AGENTS,
    A_AGENT,
    A_READER,
#ifdef DEVICE_PRO_COMPANION
    A_READER_BACK,
#endif
    A_QUESTION,
    A_CHOICE,
    A_ANSWER, A_QUESTION_READ, A_QUESTION_CHOICES, A_QUESTION_REVIEW, A_QUESTION_BACK, A_QUESTION_SAY,
    A_INBOX,
    A_NOTICE,
    A_TABS,
    A_TAB, A_TAB_REFRESH,
#if HT_FACE_PX >= 720
    // The Pro's tab strip, walked two at a time. Declared only on the square face: the dispatch
    // switch is built with -Werror=switch, so an action that exists but is never handled is a
    // compile error rather than a silent no-op.
    A_TAB_STRIP_LEFT, A_TAB_STRIP_RIGHT,
#endif
    A_MACHINES,
    A_MACHINE,
    A_VOICE,
    A_VOICE_STOP,
    A_VOICE_ABORT,
    A_PET,
    A_COMPANION,
    A_CHARACTER, A_CHARACTER_SAVE,
    A_NAP,
    A_QUIET,
    A_FACE,
    A_RIM,
    A_HABITAT_SAVE,
    A_MUTE,
    A_SETTINGS,
    A_BRIGHT,
    A_STOP,
    A_STOP_YES,
    A_MODELS,
    A_MODEL,
    A_RECAP_DISMISS,
    A_DESKTOP,
    A_UP,
    A_DOWN,
    A_LOCK,
    A_SCROLL,
    A_SELECT_BEGIN, A_SELECT_FIND, A_SELECT_EXTEND, A_SELECT_SEND, A_RETURN, A_LATEST, A_VISIT_SEND,
    A_CARRY, A_CARRY_DROP, A_CARRY_SEND,
    A_DRAFT_EDIT, A_DRAFT_APPEND, A_DRAFT_UNDO, A_DRAFT_SEND, A_DRAFT_DISCARD,
    A_DRAFT_STATE, A_DRAFT_OPTIONS, A_DRAFT_BACK, A_DRAFT_COMMAND, A_NOTICE_READ
} action_kind_t;
#ifdef DEVICE_PRO_COMPANION
typedef enum {
    PRO_SPEECH_WARM, PRO_SPEECH_HAPPY, PRO_SPEECH_EXCITED, PRO_SPEECH_GENTLE,
    PRO_SPEECH_SAD, PRO_SPEECH_THOUGHTFUL, PRO_SPEECH_CURIOUS, PRO_SPEECH_ANGRY
} pro_speech_emotion_t;
#endif
typedef struct {
    action_kind_t kind;
    int value;
    char id[ID_MAX];
    char text[192];
    uint32_t revision;
    int dy, velocity;
#ifdef DEVICE_PRO_COMPANION
    uint32_t reader_serial;
#endif
} action_t;
typedef struct {
    ht_rect_t rect;
    action_kind_t action;
    int value;
    bool enabled;
} hit_t;
typedef struct {
    char id[ID_MAX], session[80], preview[240], full[PANE_RESULT_BYTES], activity[100];
    uint32_t used, busy_ms, last_busy;
    bool busy, live_summary, dismissed, awaiting_result;
} pane_memory_t;
typedef struct {
    char id[ID_MAX], name[CABLE_NAME_MAX], engine[12], machine_id[ID_MAX], machine[CABLE_NAME_MAX], model[192],
        session[80];
    // The row receives the same bounded result stored in pane memory. Keeping
    // an unused 4 KB tail here wasted RAM and enlarged every roster swap.
    char preview[240], full[PANE_RESULT_BYTES], tool[100];
    bool busy, has_event, recap_ready;
    uint32_t busy_ms, last_busy;
    int tokens;
} agent_t;
typedef struct {
    char key[256], prompt[256], options[OPTION_MAX][256], answer[1600];
    int count;
    bool multi, can_text;
    char draft[48];
    uint8_t selected;
} question_item_t;
typedef struct {
    char agent[ID_MAX], request[80], name[64];
    question_item_t item[QUESTION_MAX];
    int count, index, choice, drag;
    bool valid, pending, supported, loading, uncertain;
    char token[48], fetch[48], error[120], speech_error[96];
#ifdef DEVICE_PRO_COMPANION
    char notice_token[CABLE_READ_TOKEN_MAX], host[ID_MAX];
    uint64_t signature;
#endif
    uint32_t revision, deadline;
} question_t;
typedef struct {
    char agent[ID_MAX], fetch[48], token[48];
    uint8_t choices[QUESTION_MAX];
    char drafts[QUESTION_MAX][48];
    int count;
} question_submit_t;
typedef struct {
    char id[ID_MAX], summary[240];
    char token[CABLE_READ_TOKEN_MAX];
    uint32_t sent_at;
    bool pending;
    bool question, failed;
} notice_receipt_t;
static EXT_RAM_BSS_ATTR struct {
    agent_t agents[MAX_PROJECTS];
    pane_memory_t memory[PANE_MEMORY_MAX];
    uint32_t memory_serial;
    int count, active, total;
    bool connected, window, loading, ready, dirty;
    int bulk, offset;
    view_t view, voice_return;
    bool quiet, nap, locked, lock_armed, rim_enabled, focus_face, straight_title;
#ifdef DEVICE_PRO_COMPANION
    pro_scene_id_t scene_choice, preview_scene;
    uint8_t pro_agent_layout;
    char work_agent[ID_MAX];
    char work_host[ID_MAX];
    char reader_agent[ID_MAX];
    struct {
        char host[ID_MAX], name[CABLE_NAME_MAX], text[PANE_RESULT_BYTES], token[CABLE_READ_TOKEN_MAX];
        uint32_t serial, notice_revision, source_generation;
        int entry, origin, row;
        bool captured, from_notice, failed;
    } reader;
    uint32_t result_generation, reader_focus_generation;
    uint32_t work_revision, work_generation;
    uint32_t work_roster_after;
    bool work_roster_pending;
    uint8_t work_mode, work_voice_mode;
    struct {
        char machine[ID_MAX], session[80], engine[12];
    } work_capture;
    pro_metrics_t metrics;
    pro_carry_review_t carry_review;
    pro_draft_recovery_t draft_recovery;
    uint32_t pro_busy_second;
    bool pro_busy_visible;
    struct {
        char draft[48], agent[ID_MAX], host[ID_MAX], machine[ID_MAX], session[80];
        uint32_t request, until;
        uint8_t mode;
        bool accepted;
    } send_feedback;
    ht_character_t preview_character;
    struct {
        uint32_t id, poll_due;
        char agent[ID_MAX], caption[240];
        uint8_t emotion, level;
        bool playing, pending;
    } speech;
    uint32_t speech_error_until;
    unsigned voice_sample;
    uint8_t sample_volume;
    bool sample_volume_set;
    uint32_t sample_poll_due;
    char voice_language[8];
    bool language_saving, language_error;
#endif
    bool muted;
    int pet_pose;
    uint32_t pet_until, nap_until, last_celebration;
    cable_swarm_t tabs[SWARMS_MAX];
#if HT_FACE_PX >= 720
    // Set when a tab was chosen from the strip, consumed by ui_land_after_reload(). A one-shot flag
    // rather than changing where every reload lands: the same function catches a boot and a
    // reconnect, and those still belong on the companion face.
    bool land_on_desk;
    int tab_first;           // the strip's left-most tab; yours while you walk it
    int tab_strip_drag;      // accumulated horizontal travel while walking the strip
    bool tab_strip_held;     // this contact began on the strip, so it is the strip's to consume
    // The selected tab's SHAPE, as the window laid it out: normalised 0..1000 rectangles plus the
    // agent at each seat, tagged with the tab they belong to. The dial has no spatial desk and no
    // use for these — see cable_client.c.
    cable_tile_t tiles[SWARM_TILES_MAX];
    int tile_count;
    char tile_tab[ID_MAX];
#endif
    int tab_count, tab_drag;
    char selected_tab[ID_MAX];
    cable_machine_t machines[CABLE_MAX_MACHINES];
    int machine_count;
    char selected_machine[ID_MAX], pending_machine[ID_MAX];
    uint32_t machine_deadline;
#ifdef DEVICE_PRO_COMPANION
    char notice_host[ID_MAX];
    bool notice_overflow;
#endif
    cable_notif_t notice[NOTICES];
    notice_receipt_t notice_reads[NOTICES];
    uint8_t notice_read_next;
    uint32_t notice_revision, notice_frame;
    int notice_count;
    uint32_t notice_sequence;
    question_t q;
    char message[256], title[80], pending_focus[ID_MAX], opening_notice[ID_MAX];
    char voice_target[CABLE_NAME_MAX];
    uint32_t voice_retry_until;
    model_item_t models[48];
    int model_count;
    bool model_request;
    char model_agent[ID_MAX], model_selected[192];
    char stop_agent[ID_MAX];
    int brightness;
    uint32_t voice_started;
    bool voice_open, voice_start_pending, voice_waiting, voice_carry;
    bool voice_review, voice_review_preview, voice_draft_append, voice_search;
    uint32_t voice_draft_revision;
    int draft_drag;
    uint32_t voice_generation, voice_question_revision;
    int voice_question_index;
    uint32_t voice_wait_until;
    hit_t hits[24];
    ht_rect_t caption_arc;
    int hit_count, pressed;
    bool touch_down, touch_cancelled;
#ifdef DEVICE_PRO_COMPANION
    bool workspace_chord;
    char chord_tab[ID_MAX], chord_previous[ID_MAX], chord_next[ID_MAX], chord_machine[ID_MAX];
#endif
    bool touch_brake, coasting;
    uint32_t coast_until;
    uint32_t character_activity;
    uint8_t status_phase;
    int start_x, start_y, last_x, last_y;
    uint32_t touch_started;
    char pattern[32];
    uint16_t pattern_mask;
    int pattern_len;
    bool pattern_error;
} s;
#ifdef DEVICE_PRO_COMPANION
#include "pro_i18n.h"
#define PRO_TR(text) pro_translate(s.voice_language, (text))
#else
#define PRO_TR(text) (text)
#endif
static QueueHandle_t actions;
static _Atomic(TaskHandle_t) reload_waiter;
static atomic_bool reload_requested;
static bool scroll_reversed;
static ht_scroll_t scroll;
static ht_selection_t selection;
static ht_workspace_t workspace;
static ht_tab_carousel_t tab_carousel;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static bool selection_emit(const ht_select_command_t *command, void *ctx);
static ht_gesture_t gesture;
static ht_character_t character;
static ht_character_caption_t home_caption;
static action_t pressed_action;
#if HT_FACE_PX >= 720
// The rectangle the contact went down on. A written control activates when the finger comes up inside
// it, so the rect has to outlive s.pressed, which the release path clears before it decides anything.
static ht_rect_t pressed_rect;
#endif
static bool queue(action_t a);
static void view(view_t v);
#ifdef DEVICE_PRO_COMPANION
static void notice_sync_view(void);
#endif
static const char *voice_status(void);
#ifdef DEVICE_PRO_COMPANION
static void pro_speech_cancel(bool any);
static void pro_speech_tick(uint32_t now);
static bool pro_speech_visible(void);
static void pro_render_home(ht_scene_t *f);
static void pro_render_voice(ht_scene_t *f);
#endif
static uint32_t ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static void copy(char *dst, size_t cap, const char *src)
{
    if (!cap)
        return;
    if (!src)
        src = "";
    size_t n = strnlen(src, cap - 1);
    memmove(dst, src, n);
    dst[n] = 0;
}
#define COPY(dst, src) copy(dst, sizeof(dst), src)
static void recap_preview(char *dst, size_t cap, const char *src)
{
    if (!cap)
        return;
    size_t used = 0;
    bool space = false;
    const unsigned char *p = (const unsigned char *)(src ? src : "");
    while (*p) {
        if (*p == ' ' || (*p >= '\t' && *p <= '\r')) {
            space = used > 0;
            p++;
            continue;
        }
        size_t n = *p < 0x80 ? 1 : *p >= 0xc2 && *p <= 0xdf ? 2 :
                   *p >= 0xe0 && *p <= 0xef ? 3 : *p >= 0xf0 && *p <= 0xf4 ? 4 : 0;
        for (size_t i = 1; i < n; i++) {
            if ((p[i] & 0xc0) != 0x80) {
                n = 0;
                break;
            }
        }
        size_t bytes = n ? n : 1;
        if (used + space + bytes >= cap)
            break; // Keep whole UTF-8 characters, including at the buffer edge.
        if (space)
            dst[used++] = ' ';
        if (n)
            memcpy(dst + used, p, n);
        else
            dst[used] = '?';
        used += bytes;
        p += bytes;
        space = false;
    }
    // Older hosts cached their clipping marker as U+2026. Render that trailing
    // marker with the same printable-ASCII continuation sign as new recaps.
    if (used >= 3 && !memcmp(dst + used - 3, "\xe2\x80\xa6", 3)) {
        dst[used - 3] = '+';
        used -= 2;
    }
    // Give the continuation sign breathing room, including recaps cached by
    // older hosts. Do not change a literal C++ or add a second existing space.
    if (used > 1 && dst[used - 1] == '+' && dst[used - 2] != '+' &&
        dst[used - 2] != ' ' && used + 1 < cap) {
        dst[used - 1] = ' ';
        dst[used++] = '+';
    }
    dst[used] = 0;
}
static void change(void)
{
    s.dirty = true;
    habitat_render_notify();
}
static unsigned notice_unread(void)
{
    unsigned count = 0;
    for (int i = 0; i < s.notice_count; i++) count += !s.notice[i].read_on_dial;
    return count;
}
static bool notice_was_read(const cable_notif_t *n)
{
    for (int i = 0; i < NOTICES; i++) {
        const notice_receipt_t *r = &s.notice_reads[i];
        if (!strcmp(r->id, n->agent_id) && r->question == n->question &&
            r->failed == n->failed && !strcmp(r->token, n->read_token) &&
            !strcmp(r->summary, n->summary)) return true;
    }
    return false;
}
static void notice_forget_read(const char *id)
{
    for (int i = 0; i < NOTICES; i++)
        if (!strcmp(s.notice_reads[i].id, id)) s.notice_reads[i].id[0] = 0;
}
static void notice_flush_reads(uint32_t now)
{
    if (!s.connected) return;
    for (int i = 0; i < NOTICES; i++) {
        notice_receipt_t *r = &s.notice_reads[i];
        if (!r->pending || !r->id[0] || !r->token[0] ||
            (r->sent_at && now - r->sent_at < 2000)) continue;
        action_t a = {.kind = A_NOTICE_READ}; COPY(a.id, r->id); COPY(a.text, r->token);
        if (queue(a)) r->sent_at = now ? now : 1;
        // At most one tiny receipt per tick; touch/audio retain queue capacity.
        break;
    }
}
static void notice_mark_read(cable_notif_t *n)
{
    if (n->read_on_dial) return;
    int slot = -1;
    for (int i = 0; i < NOTICES; i++)
        if (!strcmp(s.notice_reads[i].id, n->agent_id)) { slot = i; break; }
    if (slot < 0) for (int i = 0; i < NOTICES; i++)
        if (!s.notice_reads[i].id[0]) { slot = i; break; }
    if (slot < 0) { slot = s.notice_read_next; s.notice_read_next = (slot + 1) % NOTICES; }
    notice_receipt_t *r = &s.notice_reads[slot];
    COPY(r->id, n->agent_id); COPY(r->summary, n->summary);
    COPY(r->token, n->read_token); r->sent_at = 0; r->pending = r->token[0] != 0;
    r->question = n->question; r->failed = n->failed;
    n->read_on_dial = true;
    notice_flush_reads(ms());
    // Read is not answered, removed or focused. Keep this exact card in place.
    change();
}
static void notice_open(void)
{
#ifdef DEVICE_PRO_COMPANION
    view(s.notice_count || s.q.pending || s.notice_overflow ? INBOX : HOME);
#else
    view(s.notice_count ? INBOX : HOME);
#endif
    if (s.view == INBOX) for (int i = 0; i < s.notice_count; i++)
        if (!s.notice[i].read_on_dial) { s.offset = i; break; }
}
uint32_t habitat_scene_receipt(void)
{
    return s.notice_frame;
}
void habitat_scene_presented(uint32_t receipt)
{
    display_lock();
    // A late DMA completion must not mark a replacement message as read, nor
    // acknowledge a card hidden by the lock screen or a sleeping panel.
    if (receipt && receipt == s.notice_frame && s.view == INBOX && !s.locked &&
        !display_is_asleep() && s.offset >= 0 && s.offset < s.notice_count &&
        s.notice[s.offset].display_revision == receipt)
        notice_mark_read(&s.notice[s.offset]);
    display_unlock();
}
static int find(const char *id)
{
    if (!id)
        return -1;
    for (int i = 0; i < s.count; i++)
        if (!strcmp(id, s.agents[i].id))
            return i;
    return -1;
}
static agent_t *active(void)
{
    return s.active >= 0 && s.active < s.count ? &s.agents[s.active] : NULL;
}
static pane_memory_t *pane_memory(const char *id, bool create)
{
    if (!id || !*id || strnlen(id, ID_MAX) >= ID_MAX) return NULL;
    pane_memory_t *slot = NULL;
    for (int i = 0; i < PANE_MEMORY_MAX; i++) {
        pane_memory_t *m = &s.memory[i];
        if (!strcmp(m->id, id)) {
            m->used = ++s.memory_serial;
            return m;
        }
        if (!m->id[0] && !slot) slot = m;
    }
    if (!create) return NULL;
    if (!slot) {
        // Keep every on-screen pane pinned. Evict only the least recently used
        // off-tab record; the normal roster is much smaller than this cache.
        uint32_t age = 0;
        for (int i = 0; i < PANE_MEMORY_MAX; i++) {
            pane_memory_t *m = &s.memory[i];
            uint32_t elapsed = s.memory_serial - m->used;
            if (find(m->id) < 0 && (!slot || elapsed > age)) { slot = m; age = elapsed; }
        }
    }
    if (!slot) return NULL;
    memset(slot, 0, sizeof *slot);
    COPY(slot->id, id);
    slot->used = ++s.memory_serial;
    return slot;
}
static void pane_memory_apply(agent_t *a, pane_memory_t *m)
{
    if (!a || !m) return;
    if (m->busy && ms() - m->last_busy > 25000) m->busy = false;
    COPY(a->session, m->session);
    COPY(a->preview, m->preview);
    COPY(a->full, m->full);
    COPY(a->tool, m->activity);
    a->busy = m->busy;
    a->busy_ms = m->busy_ms;
    a->last_busy = m->last_busy;
    a->has_event = m->preview[0] != 0;
    a->recap_ready = a->has_event && !m->dismissed && !m->awaiting_result && !m->busy;
}
#ifdef DEVICE_PRO_COMPANION
static bool pro_reader_source(void)
{
    return s.reader.captured && s.reader.source_generation==s.result_generation &&
        !strcmp(s.reader.host,s.notice_host);
}
static bool pro_reader_owner(void)
{
    return s.reader.host[0] && pro_reader_source();
}
static bool pro_reader_matches(const cable_notif_t *n)
{
    if (!s.reader.from_notice || !pro_reader_source() || n->question ||
        strcmp(n->agent_id,s.reader_agent) || strcmp(n->summary,s.reader.text) || n->failed!=s.reader.failed)
        return false;
    // Tokenless legacy cards have only a local occurrence. Equal words do not
    // associate them with a later callback, or with the separate summary cache.
    return s.reader.token[0] ? !strcmp(n->read_token,s.reader.token) :
        !n->read_token[0] && n->display_revision==s.reader.notice_revision;
}
static int pro_reader_notice_index(void)
{
    for (int i=0;i<s.notice_count;i++) if (pro_reader_matches(&s.notice[i])) return i;
    return -1;
}
static bool pro_reader_openable(void)
{
    return pro_reader_owner() && s.connected && !s.loading && !visit.pending &&
        !s.pending_focus[0] && !s.pending_machine[0] &&
        (s.reader.from_notice || find(s.reader_agent)>=0);
}
static bool pro_reader_latest(void)
{
    const agent_t *a=active();
    return pro_reader_owner() && a && !strcmp(a->id,s.reader_agent) &&
        cable_client_supports(CABLE_FEATURE_VISIT);
}
static void pro_reader_focus(const char *id)
{
    const agent_t *a=active();
    const char *current=s.pending_focus[0] ? s.pending_focus : a ? a->id : "";
    if (id && !strcmp(id,current)) return;
    // A -> B -> A must not revive a contact or queued Latest for the first A.
    // Repeated echoes of the same focused pane leave the contact alone.
    if (!++s.reader_focus_generation) ++s.reader_focus_generation;
}
static void pro_reader_copy(char *dst, size_t cap, const char *src)
{
    if (!cap) return;
    copy(dst,cap,src);
    // Older cache writes may end part-way through a UTF-8 character. Preserve
    // line breaks and every complete character without displaying a broken tail.
    size_t len=strlen(dst), start=len;
    while (start && ((unsigned char)dst[start-1]&0xc0)==0x80) start--;
    if (start) start--;
    unsigned char lead=(unsigned char)dst[start];
    size_t bytes=lead>=0xc2 && lead<=0xdf ? 2 : lead>=0xe0 && lead<=0xef ? 3 :
                 lead>=0xf0 && lead<=0xf4 ? 4 : 1;
    if (len-start<bytes) dst[start]=0;
}
static void pro_reader_begin(action_t a)
{
    if (strcmp(a.text,s.notice_host) || (uint32_t)a.dy!=s.result_generation) return;
    cable_notif_t *n=NULL;
    const agent_t *agent=NULL;
    if (a.value==1) {
        if (s.view!=INBOX) return;
        for (int i=0;i<s.notice_count;i++) if (!s.notice[i].question &&
            s.notice[i].display_revision==a.revision && !strcmp(s.notice[i].agent_id,a.id)) {
            n=&s.notice[i]; break;
        }
        if (!n || ht_pro_text_rows(n->summary,&ht_pro_32,624)<=7) return;
    } else {
        if (s.view!=LAUNCHER && s.view!=HOME && s.view!=AGENT) return;
        int i=find(a.id);
        if (i<0) return;
        agent=&s.agents[i];
    }
    bool same=n ? pro_reader_matches(n) : pro_reader_source() && !s.reader.from_notice &&
        !strcmp(a.id,s.reader_agent) && !strcmp(agent->full,s.reader.text);
    int row=same ? s.reader.row : 0;
    uint32_t serial=s.reader.serial+1;
    if (!serial) serial=1;
    memset(&s.reader,0,sizeof s.reader);
    s.reader.serial=serial; s.reader.captured=true; s.reader.from_notice=n!=NULL;
    s.reader.source_generation=s.result_generation;
    s.reader.entry=s.view; s.reader.origin=s.offset; s.reader.row=row;
    COPY(s.reader_agent,a.id); COPY(s.reader.host,s.notice_host);
    COPY(s.reader.name,n ? n->name : agent->name);
    pro_reader_copy(s.reader.text,sizeof s.reader.text,n ? n->summary : agent->full);
    if (n) {
        COPY(s.reader.token,n->read_token); s.reader.notice_revision=n->display_revision;
        s.reader.failed=n->failed;
        // An explicit Read can beat the display-complete callback. Record the
        // exact card now so its later ACK/empty unread snapshot keeps our place.
        notice_mark_read(n);
    }
    view(READER);
    if (s.view==READER) s.offset=row;
}
static void pro_reader_back(action_t a)
{
    if (s.view!=READER || a.revision!=s.reader.serial || strcmp(a.id,s.reader_agent)) return;
    s.reader.row=s.offset;
    if (s.reader.from_notice) {
        int at=pro_reader_notice_index();
        if (at<0 && pro_reader_source()) for (int i=0;i<s.notice_count;i++)
            if (!strcmp(s.notice[i].agent_id,s.reader_agent)) { at=i; break; }
        if (at<0) at=s.reader.origin<s.notice_count ? s.reader.origin : s.notice_count-1;
        view(INBOX); s.offset=at>=0 ? at : 0;
    } else view(s.reader.entry==AGENT ? AGENT : s.reader.entry==HOME ? HOME : LAUNCHER);
}
static void pro_send_feedback_clear(void)
{
    memset(&s.send_feedback, 0, sizeof s.send_feedback);
}
static bool pro_send_feedback_matches(void)
{
    const agent_t *a = active();
    return s.connected && s.send_feedback.agent[0] && a &&
        !strcmp(a->id, s.send_feedback.agent) &&
        !strcmp(a->machine_id, s.send_feedback.machine) &&
        !strcmp(a->session, s.send_feedback.session) &&
        !strcmp(s.draft_recovery.current_host, s.send_feedback.host);
}
static void pro_send_feedback_begin(uint32_t request)
{
    pro_send_feedback_clear();
    int i = find(draft.page.agent);
    if (i < 0 || !s.connected || !pro_draft_recovery_same_host(&s.draft_recovery)) return;
    COPY(s.send_feedback.draft, draft.page.id);
    COPY(s.send_feedback.agent, draft.page.agent);
    COPY(s.send_feedback.host, s.draft_recovery.current_host);
    COPY(s.send_feedback.machine, s.agents[i].machine_id);
    COPY(s.send_feedback.session, s.agents[i].session);
    s.send_feedback.request = request;
    s.send_feedback.mode = s.work_voice_mode;
}
static const char *pro_send_feedback_text(uint32_t now)
{
    if (!s.send_feedback.accepted || !s.send_feedback.until ||
        (int32_t)(now - s.send_feedback.until) >= 0 || !pro_send_feedback_matches()) return NULL;
    return s.send_feedback.mode == PRO_WORK_TASK ? "Passed to Harness" : "Request sent";
}
static bool pro_work_local(const agent_t *a)
{
    // current_host came from the complete welcome identity, not the legacy
    // truncated cable_client_machine_id() buffer or selected remote machine.
    return a && a->machine_id[0] && s.draft_recovery.current_host[0] &&
        !strcmp(a->machine_id, s.draft_recovery.current_host);
}
static bool pro_work_visible(const agent_t *a, int mode)
{
    if (mode == PRO_WORK_TASK) return true;
    return pro_work_local(a) &&
        pro_work_supported(a->engine, mode, cable_client_supports(CABLE_FEATURE_DRAFT));
}
static const char *pro_work_block_reason(const agent_t *a, int mode)
{
    // Negative evidence only. Roster presence and voice.draft cannot attest
    // process readiness; the host still validates delivery at submission.
    if (!s.connected) return "Connect to Harness.";
    if (s.work_roster_pending) return "Finding your panes...";
    if (s.loading || !a) return "Choose a pane.";
    if (!strcmp(a->engine, "terminal")) return "Choose an agent pane.";
    if (!pro_work_local(a) && a->machine_id[0]) {
        for (int i = 0; i < s.machine_count; i++) if (!strcmp(a->machine_id, s.machines[i].id)) {
            if (!strcmp(s.machines[i].state, "offline")) return "This computer is offline.";
            if (!strcmp(s.machines[i].state, "needs-link")) return "Link this computer in Harness.";
            break; // unknown or an absent row says nothing about reachability
        }
    }
    if (mode != PRO_WORK_TASK && !pro_work_local(a) &&
        pro_work_supported(a->engine, mode, cable_client_supports(CABLE_FEATURE_DRAFT)))
        return !strcmp(a->engine, "claude") ? "Goal and Loop need a local pane." : "Goal needs a local pane.";
    if (!pro_work_visible(a, mode)) return "Choose the pane and instruction again.";
    for (int i = 0; i < s.notice_count; i++) {
        const cable_notif_t *n = &s.notice[i];
        if (n->question && n->question_current && !strcmp(a->id, n->agent_id))
            return n->question_unavailable ? "Check its question in Harness." : "Answer its question first.";
    }
    if (mode != PRO_WORK_TASK && a->busy && (uint32_t)(ms() - a->last_busy) <= 25000)
        return "Wait for this turn to finish.";
    return NULL;
}
static bool pro_work_available(const agent_t *a, int mode)
{
    return !pro_work_block_reason(a, mode);
}
static void pro_work_capture_pin(const agent_t *a, int mode)
{
    COPY(s.work_capture.machine, a->machine_id);
    COPY(s.work_capture.session, a->session);
    COPY(s.work_capture.engine, a->engine);
    pro_draft_recovery_pin(&s.draft_recovery, a->id, (uint8_t)mode);
}
static bool pro_work_capture_available(const char *agent, int mode)
{
    int recipient = find(agent);
    return recipient >= 0 && pro_work_available(&s.agents[recipient], mode) &&
        !strcmp(s.agents[recipient].machine_id, s.work_capture.machine) &&
        !strcmp(s.agents[recipient].session, s.work_capture.session) &&
        !strcmp(s.agents[recipient].engine, s.work_capture.engine) &&
        !strcmp(agent, s.draft_recovery.recipient) && mode == s.draft_recovery.mode &&
        s.draft_recovery.capture_generation == s.draft_recovery.generation &&
        !strcmp(s.draft_recovery.original_host, s.draft_recovery.current_host) &&
        (mode == PRO_WORK_TASK || pro_draft_recovery_same_host(&s.draft_recovery));
}
static bool pro_work_draft_available(void)
{
    // A new busy/question observation must not strand words already recorded.
    // The reviewed writer owns final readiness checks when Send is requested.
    int recipient = find(draft.page.agent);
    return s.work_voice_mode == PRO_WORK_TASK ||
        (s.connected && !s.loading && recipient >= 0 &&
         pro_work_visible(&s.agents[recipient], s.work_voice_mode) &&
         !strcmp(draft.page.agent, s.work_agent) &&
         !strcmp(draft.page.agent, s.draft_recovery.recipient) &&
         s.work_voice_mode == s.draft_recovery.mode &&
         s.draft_recovery.capture_generation == s.draft_recovery.generation &&
         pro_draft_recovery_same_host(&s.draft_recovery));
}
static void pro_busy_reset(void)
{
    // These anchors describe this device's uninterrupted observation, not
    // engine runtime. Invalidate off-roster memory too before a reload.
    for (int i = 0; i < PANE_MEMORY_MAX; i++) {
        s.memory[i].busy = false;
        s.memory[i].busy_ms = s.memory[i].last_busy = 0;
        s.memory[i].activity[0] = 0;
    }
    for (int i = 0; i < s.count; i++) {
        s.agents[i].busy = false;
        s.agents[i].busy_ms = s.agents[i].last_busy = 0;
        s.agents[i].tool[0] = 0;
    }
    s.pro_busy_visible = false;
}
#endif
static void dismiss_result(const char *id)
{
    pane_memory_t *m = pane_memory(id, true);
    if (!m) return;
    m->dismissed = true;
    int i = find(id);
    if (i >= 0) s.agents[i].recap_ready = false;
    change();
}
static void activity_text(char *dst, size_t cap, const char *src)
{
    // Keep the engine's word; trailing spinner dots unbalance the curved label.
    // This is presentation only. Do not alter dots inside a phrase or the recap.
    while (src && (*src == ' ' || *src == '\t' || *src == '\r' || *src == '\n')) src++;
    copy(dst, cap, src);
    size_t n = strlen(dst);
    while (n && (dst[n - 1] == ' ' || dst[n - 1] == '\t' || dst[n - 1] == '\r' || dst[n - 1] == '\n')) dst[--n] = 0;
    if (n >= 3 && (!memcmp(dst + n - 3, "...", 3) ||
                   !memcmp(dst + n - 3, "\xe2\x80\xa6", 3))) { n -= 3; dst[n] = 0; }
    while (n && dst[n - 1] == ' ') dst[--n] = 0;
}

static int ensure(const char *id)
{
    if (!id || !*id || strnlen(id, ID_MAX) >= ID_MAX) return -1;
    int i = find(id);
    if (i >= 0)
        return i;
    if (s.count >= MAX_PROJECTS)
        return -1;
    i = s.count++;
    memset(&s.agents[i], 0, sizeof(agent_t));
    COPY(s.agents[i].id, id);
    pane_memory_apply(&s.agents[i], pane_memory(id, false));
    return i;
}
static void input_cancel(void)
{
#ifdef DEVICE_PRO_COMPANION
    s.workspace_chord = false;
    pro_speech_cancel(true);
#endif
    ht_gesture_cancel(&gesture);
    ht_workspace_cancel_touch(&workspace);
    ht_scroll_cancel(&scroll);
    s.coasting = false;
    ht_tab_carousel_cancel(&tab_carousel);
    s.voice_review_preview = false;
    if (s.touch_down) s.touch_cancelled = true;
    s.pressed = -1;
}
static void view(view_t v)
{
    // A swipe, desktop refresh or late reply must not hide a live microphone. Only an
    // explicit finish/cancel or the matching voice result releases this screen.
    if (form.id[0] && s.view == FORM && v != FORM &&
        !(v == VOICE && s.voice_open && s.voice_return == FORM)) return;
    if (draft.page.active && v != DRAFT && v != DRAFT_OPTIONS &&
#ifdef DEVICE_PRO_COMPANION
        v != CARRY_PREVIEW &&
#endif
        !(v == VOICE && s.voice_open && s.voice_return == DRAFT)) return;
    if (s.voice_open && v != VOICE)
        return;
#ifdef DEVICE_PRO_COMPANION
    if (s.view==READER && v!=READER) s.reader.row=s.offset;
    if (v != VOICE_SAMPLES && v != VOICE_PARAMS) pro_voice_sample_stop();
    if (v != TODAY) pro_metrics_close(&s.metrics);
#endif
    if (carry.pending && v != SELECTION) ht_carry_close(&carry);
    if (selection.active && v != SELECTION && v != VOICE) ht_selection_close(&selection);
    if (s.view == INBOX && v != INBOX) s.opening_notice[0] = 0;
    input_cancel();
    s.voice_retry_until = 0;
    s.view = v;
    s.offset = 0;
    s.pressed = -1;
    change();
}
static void voice_close(void)
{
    s.voice_open = s.voice_start_pending = s.voice_waiting = false;
    s.voice_carry = false;
    s.voice_review = s.voice_review_preview = false;
#ifdef DEVICE_PRO_COMPANION
    if (!s.carry_review.draft[0]) memset(&s.carry_review, 0, sizeof s.carry_review);
#endif
    s.voice_generation++; // invalidate a start still queued behind another cable action
}
static int workspace_index(const char *id)
{
    if (!id || !*id) return -1;
    for (int i=0;i<s.tab_count;i++) if (!strcmp(id,s.tabs[i].id)) return i;
    return -1;
}
static void tabs_open(void)
{
    view(TABS);
    if (s.view != TABS) return;
    ht_tab_carousel_reset(&tab_carousel, s.tab_count, workspace_index(s.selected_tab));
}
static void workspace_failed(const char *message)
{
    ht_workspace_cancel_request(&workspace);
#ifdef DEVICE_PRO_COMPANION
    pro_reader_focus(NULL);
#endif
    s.loading=false; s.active=-1;
    COPY(s.title,"Workspaces"); COPY(s.message,message); view(MESSAGE);
}
static int waiting(void)
{
    int n = 0;
    for (int i = 0; i < s.notice_count; i++)
        n += s.notice[i].question
#ifdef DEVICE_PRO_COMPANION
            && !s.notice[i].question_unavailable
#endif
            ;
    return n;
}
static int working(void)
{
    int n = 0;
    for (int i = 0; i < s.count; i++)
        n += s.agents[i].busy;
    return n;
}
static bool is_question(const char *id)
{
    for (int i = 0; i < s.notice_count; i++)
        if (s.notice[i].question && !strcmp(id, s.notice[i].agent_id)
#ifdef DEVICE_PRO_COMPANION
            && !s.notice[i].question_unavailable
#endif
            )
            return true;
    return false;
}
static uint16_t color(unsigned rgb)
{
#ifdef DEVICE_PRO_COMPANION
    // An LCD's brightness belongs to its backlight. Keep ink contrast intact.
    return ht_rgb(rgb);
#else
    unsigned b = s.brightness < 8 ? 8 : s.brightness;
    if (rgb == HT_THEME_CANVAS) {
        // RGB565 has an extra green bit. Independently truncating a dim gray
        // makes it green; the canvas's 0..24 range has exact neutral steps of 8.
        unsigned gray = (((rgb & 255) * b + 400) / 800) * 8;
        return ht_rgb(gray * 0x010101u);
    }
    return ht_rgb((((rgb >> 16) * b / 100) << 16) | ((((rgb >> 8) & 255) * b / 100) << 8) |
                  ((rgb & 255) * b / 100));
#endif
}
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define ERROR color(HT_THEME_ERROR)
#define SEL color(HT_THEME_SELECTION)
/*
 * THE INTERFACE FONT LIVES IN THESE THREE HELPERS AND NOWHERE ELSE.
 *
 * ht_mono_28 is a 17 x 38 cell against mono_20's 12 x 28 — 42% wider and 36% taller, the nearest step
 * fonts.c holds; there is no mono_30, and a true +50% would mean generating one.
 *
 * Everything downstream is arithmetic on the cell, so the bump is neither free nor local: a run holds
 * width / 17 characters instead of width / 12 — a THIRD fewer on every line — and a row is 38 tall.
 * The screens below are re-seated for that, not merely re-fonted.
 *
 * The two ARCS keep mono_20 deliberately: their cell pitch is baked into arc_trig[32][2] on a 205 px
 * radius and their bounds come from ht_mono_20_ink[], so a different cell there is a different table.
 */
#define UI_FONT (&ht_mono_28)
static void text(ht_scene_t *f, int x, int y, int w, const char *t, uint16_t c)
{
    ht_text(f, x, y, w, UI_FONT, c, BG, t);
}
static void center(ht_scene_t *f, int y, const char *t, uint16_t c)
{
    ht_center(f, y, UI_FONT, c, t);
}
static void render_brand(ht_scene_t *f)
{
#ifdef DEVICE_PRO_COMPANION
    ht_pro_center(f, 276, &ht_pro_56, FG, "Harness");
    ht_pro_center(f, 374, &ht_pro_32, DIM, PRO_TR("A little update."));
    ht_pro_center(f, 438, &ht_pro_24, DIM, PRO_TR("Keep your companion connected."));
#else
    center(f, (466 - UI_FONT->height) / 2, "Harness", FG);
#endif
}
static void control(ht_scene_t *f, int x, int y, int w, const char *label, action_kind_t a,
                    int value, bool enabled)
{
    if (s.hit_count >= 24)
        return;
    int n = s.hit_count++;
    // 66, not 60: the target is the line plus a thumb's margin, and the line is ten pixels taller now.
    // Keeping 60 would have made the control smaller than its own text.
    s.hits[n] = (hit_t){{x, y - 14, w, 66}, a, value, enabled};
    ht_text(f, x, y, w, UI_FONT, enabled ? (a == A_STOP_YES ? ERROR : n == s.pressed ? ACCENT : FG) : DIM,
            n == s.pressed ? SEL : BG, label);
}
#if HT_FACE_PX >= 720
/*
 * A ONE-PANE TAB HAS NO LAYOUT WORTH SHOWING.
 *
 * The desk exists to say WHERE an agent is among others. With one pane there is no "among": the page
 * is a single rectangle filling the glass and a name in the corner of it, and every visit costs a tap
 * to get past. So a tab with one pane opens on the companion instead.
 *
 * Read off cable_swarm_t.panes rather than counted from the tiles, because this decides where to GO
 * and the rectangles arrive a frame later than the decision does. `panes` counts tiles of any kind —
 * a tab holding one terminal and no agent is still one pane — which is the count this question is
 * actually asking about. A daemon too old to send it reports panes == agents, which lands the same way.
 */
static int pro_panes_of(const char *id)
{
    if (!id || !*id) return 0;
    for (int i = 0; i < s.tab_count; i++)
        if (!strcmp(id, s.tabs[i].id)) return s.tabs[i].panes;
    return 0;
}
/*
 * A LABEL IS NOT A GESTURE.
 *
 * ht_gesture_end() classifies a contact as TAP only between 25 and 350 ms, and as HOLD only between
 * 650 and 1800 — so a press of 400 ms is neither, and returns HT_TOUCH_NONE. On the dial almost every
 * target is the companion itself, where that dead band is invisible. This face is made of written
 * controls, and a deliberate press on a small written label lands in it constantly: the symptom is a
 * button that works perhaps half the time, which reads as a broken screen rather than as a timing rule.
 *
 * These are the controls that say what they do. A press that did not move activates them, full stop.
 * A_PET is deliberately NOT here: its tap and its hold mean two different things, and that is the one
 * place on this face where duration is content.
 */
static bool pro_written_control(action_kind_t a)
{
#ifdef DEVICE_PRO_COMPANION
    return a != A_NONE && a != A_PET && a != A_DRAFT_EDIT;
#else
    return a == A_VOICE_ABORT || a == A_TAB || a == A_TAB_STRIP_LEFT || a == A_TAB_STRIP_RIGHT ||
           a == A_INBOX || a == A_AGENT || a == A_AGENTS || a == A_NOTICE;
#endif
}
#endif
static bool home_footer(action_kind_t action)
{
#ifdef DEVICE_PRO_COMPANION
    return action != A_NONE && action != A_PET;
#else
    return action == A_TABS || action == A_INBOX || action == A_AGENTS || action == A_RETURN || action == A_CARRY_DROP;
#endif
}
static bool hit_contains(const hit_t *hit, int x, int y, bool surface)
{
    ht_rect_t r = hit->rect;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
    if (!surface || hit->action != A_AGENTS || s.straight_title) return false;
    r = s.caption_arc;
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return false;
    int dx = x - 233, dy = y - 233, radius = dx * dx + dy * dy;
    // Follow the top label's visible extent without stealing the central
    // companion. Long labels descend beyond the broad target at the top.
    return y < 233 && radius >= 180 * 180 && radius <= 233 * 233;
}
static void footer_control(ht_scene_t *f, int x, int w, const char *label,
                           action_kind_t action, bool enabled)
{
    if (s.hit_count >= 24) return;
    int n = s.hit_count++;
    bool inbox = action == A_INBOX;
    s.hits[n] = (hit_t){{x, inbox ? 359 : 389, w, inbox ? 80 : 50}, action, 0, enabled};
    // These short footer labels are ASCII. The two targets stay separate and
    // retain a full finger-height hit area even at the bottom of the circle.
    int width = (int)strlen(label) * ht_mono_20.width;
    if (inbox && width > 276) width = 276;
    ht_text(f, x + (w - width) / 2, inbox ? 385 : 399, width, &ht_mono_20,
            enabled ? (inbox || n == s.pressed ? ACCENT : FG) : DIM,
            inbox && n == s.pressed ? SEL : BG, label);
}
static void heading(ht_scene_t *f, const char *title)
{
    control(f, 87, 67, 48, "<", A_HOME, 0, true);
    text(f, 147, 67, 252, title, FG);
}
static void render_companion(ht_scene_t *f)
{
    heading(f, "companion");
    char label[48];
    snprintf(label, sizeof label, "Character  %s", ht_character_name(character.id));
    control(f, 71, 129, 324, label, A_CHARACTER, (character.id + 1) % HT_CHARACTER_COUNT, true);
    control(f, 71, 193, 324, s.straight_title ? "Edge text  Straight" : "Edge text  Curved", A_FACE, 0, true);
    control(f, 71, 257, 324, s.rim_enabled ? "[x] Rim scrolling" : "[ ] Rim scrolling", A_RIM, 0, true);
    control(f, 71, 321, 324, s.quiet ? "[x] Still character" : "[ ] Still character", A_QUIET, 0, true);
    control(f, 95, 381, 120, s.nap ? "[wake]" : "[nap]", A_NAP, 0, true);
    control(f, 251, 381, 120, "[home]", A_HOME, 0, true);
}
static bool choose_character(int id)
{
    if ((unsigned)id >= HT_CHARACTER_COUNT) return false;
    if (character.id == (ht_character_id_t)id) return true;
#ifdef DEVICE_PRO_COMPANION
    if (!queue((action_t){.kind=A_APPEAR_SAVE, .value=id | (s.scene_choice << 8)})) return false;
#else
    if (!queue((action_t){.kind=A_CHARACTER_SAVE, .value=id})) return false;
#endif
    ht_character_select(&character, (ht_character_id_t)id);
    change();
    return true;
}
#ifdef DEVICE_PRO_COMPANION
static bool pro_appearance_view(void)
{
    return s.view == DAEMONS || s.view == SCENES;
}
static void pro_appearance_open(view_t target)
{
    view(target);
    if (s.view != target) return;
    s.preview_character = character;
    memset(&s.preview_character.motion, 0, sizeof s.preview_character.motion);
    memset(&s.preview_character.delivery, 0, sizeof s.preview_character.delivery);
    s.preview_scene = s.scene_choice;
}
static void pro_appearance_move(int delta)
{
    if (!pro_appearance_view()) return;
    if (s.view == DAEMONS) {
        int count = (int)pro_daemon_count();
        int index = ((int)pro_daemon_index(s.preview_character.id) + delta + count) % count;
        ht_character_select(&s.preview_character, pro_daemon_at((unsigned)index)->id);
    } else {
        s.preview_scene = (pro_scene_id_t)(((int)s.preview_scene + delta + PRO_SCENE_COUNT) % PRO_SCENE_COUNT);
    }
    change();
}
static bool pro_appearance_use(void)
{
    if (!pro_appearance_view()) return false;
    ht_character_id_t id = s.preview_character.id;
    pro_scene_id_t scene = s.preview_scene;
    if ((unsigned)id >= HT_CHARACTER_COUNT || (unsigned)scene >= PRO_SCENE_COUNT) return false;
    if (id != character.id || scene != s.scene_choice) {
        if (!queue((action_t){.kind=A_APPEAR_SAVE, .value=(int)id | ((int)scene << 8)})) return false;
        ht_character_select(&character, id);
        s.scene_choice = scene;
    }
    view(HOME);
    return true;
}
static bool pro_speech_allowed(const char *agent_id)
{
    const agent_t *a = active();
    return s.ready && s.connected && !s.loading && !s.locked && !display_is_asleep() &&
        (s.view == HOME || s.view == AGENT) && a && agent_id && !strcmp(a->id, agent_id) &&
        !s.voice_open && !s.voice_start_pending && !s.voice_waiting && !audio_client_active() &&
        !s.touch_down && !s.nap && !s.voice_retry_until && !carry.active &&
        !carry.error[0] && !visit.pending && !is_question(a->id);
}
static bool pro_speech_visible(void)
{
    return s.speech.id && pro_speech_allowed(s.speech.agent);
}
static uint8_t pro_speech_emotion(const char *emotion)
{
    static const char *const names[] = {
        "warm", "happy", "excited", "gentle", "sad", "thoughtful", "curious", "angry"
    };
    for (unsigned i = 0; emotion && i < sizeof names / sizeof names[0]; i++)
        if (!strcmp(emotion, names[i])) return (uint8_t)i;
    return PRO_SPEECH_WARM;
}
static void pro_speech_caption(char *dst, size_t cap, const char *src)
{
    if (!cap) return;
    size_t used = 0;
    bool space = false, clipped = false;
    while (*src) {
        const char *start = src;
        uint32_t cp = ht_utf8_next(&src);
        if (cp <= 32 || cp == 127) { space = used > 0; continue; }
        size_t bytes = cp == 0xfffd ? 1 : (size_t)(src - start);
        if (used + space + bytes >= cap) { clipped = true; break; }
        if (space) dst[used++] = ' ';
        if (cp == 0xfffd) dst[used] = '?';
        else memcpy(dst + used, start, bytes);
        used += bytes;
        space = false;
    }
    if (clipped && cap >= 4) {
        while (used && (used + 3 >= cap || dst[used - 1] == ' ')) {
            used--;
            while (used && ((unsigned char)dst[used] & 0xc0) == 0x80) used--;
        }
        memcpy(dst + used, "\xe2\x80\xa6", 3);
        used += 3;
    }
    dst[used] = 0;
}
static void pro_speech_cancel(bool any)
{
    // abort is a metadata update plus worker notification, never codec I/O.
    // Cancelling even the not-yet-presented session closes the begin/DOWN race.
    if (s.speech.id) audio_speech_abort(s.speech.id);
    else if (any && !pro_voice_sample_owns_audio()) audio_speech_abort(0);
    if (s.speech.id) { memset(&s.speech, 0, sizeof s.speech); change(); }
}
bool ui_companion_speech_begin(uint32_t id, const char *agent_id,
                               const char *caption, const char *emotion)
{
    if (!id || !agent_id || !*agent_id || strnlen(agent_id, ID_MAX) >= ID_MAX ||
        !caption || !*caption || strnlen(caption, 1025) > 1024) return false;
    display_lock();
    audio_speech_state_t audio;
    audio_speech_snapshot(&audio);
    bool empty_session = audio.id == id && audio.active && !audio.playing && !audio.received &&
        audio.error == AUDIO_SPEECH_ERROR_NONE;
    // The audio worker can finish and accept a new empty session between two
    // 40 ms UI polls. Its new ID proves the old presentation has already ended.
    if (empty_session && s.speech.id && s.speech.id != id) {
        memset(&s.speech, 0, sizeof s.speech);
        change();
    }
    bool accepted = !s.speech.id && pro_speech_allowed(agent_id) && empty_session;
    if (accepted) {
        pro_speech_caption(s.speech.caption, sizeof s.speech.caption, caption);
        accepted = s.speech.caption[0] != 0;
        if (accepted) {
            s.speech.id = id;
            COPY(s.speech.agent, agent_id);
            s.speech.emotion = pro_speech_emotion(emotion);
            s.speech.pending = true;
            s.speech.poll_due = ms();
            s.speech_error_until = 0;
            change();
        }
    }
    display_unlock();
    return accepted;
}
void ui_companion_speech_clear(uint32_t id)
{
    display_lock();
    if (!id || s.speech.id == id) pro_speech_cancel(id == 0);
    display_unlock();
}
static void pro_speech_tick(uint32_t now)
{
    if (s.speech_error_until && (int32_t)(now - s.speech_error_until) >= 0) {
        s.speech_error_until = 0;
        change();
    }
    if (!s.speech.id) return;
    if (!pro_speech_allowed(s.speech.agent)) { pro_speech_cancel(false); return; }
    if ((int32_t)(now - s.speech.poll_due) < 0) return;
    s.speech.poll_due = now + 40;
    audio_speech_state_t audio;
    audio_speech_snapshot(&audio);
    if (audio.id != s.speech.id || (!audio.active && !audio.playing) ||
        audio.error != AUDIO_SPEECH_ERROR_NONE) {
        bool failed = audio.id == s.speech.id &&
            (audio.error == AUDIO_SPEECH_ERROR_UNAVAILABLE || audio.error == AUDIO_SPEECH_ERROR_CODEC ||
             audio.error == AUDIO_SPEECH_ERROR_TIMEOUT);
        // Normal end is observed only after the last speaker DMA drain. Never
        // dismiss or overwrite the pane's underlying result while speaking.
        memset(&s.speech, 0, sizeof s.speech);
        if (failed) s.speech_error_until = now + 5000;
        change();
        return;
    }
    bool playing = audio.playing;
    bool pending = !playing;
    uint8_t level = playing ? (audio.level > 4 ? 4 : audio.level) : 0;
    bool visible_change = s.speech.playing != playing || s.speech.pending != pending ||
        (!s.quiet && s.speech.level != level);
    s.speech.playing = playing;
    s.speech.pending = pending;
    s.speech.level = level;
    if (visible_change) change();
}
#endif
static ht_character_mood_t character_mood(void)
{
    if (!s.connected)
        return HT_CHARACTER_OFFLINE;
    if (waiting())
        return HT_CHARACTER_ATTENTION;
    if (s.nap)
        return HT_CHARACTER_ASLEEP;
    if (!s.quiet && (s.pet_pose == 1 || s.pet_pose == 2))
        return HT_CHARACTER_BOOPED;
    if (!s.quiet && s.pet_pose == 3)
        return HT_CHARACTER_DONE;
#ifdef DEVICE_PRO_COMPANION
    if (active() && active()->busy)
#else
    if (working() > 0)
#endif
        return HT_CHARACTER_WORKING;
    return HT_CHARACTER_IDLE;
}
#ifdef DEVICE_PRO_COMPANION
static bool pro_busy_elapsed(const agent_t *a, uint32_t now, uint32_t *seconds)
{
    if ((s.view != HOME && s.view != AGENT) || !a || !a->busy || !s.connected ||
        s.loading || s.nap || s.locked || display_is_asleep() || s.voice_open ||
        s.voice_retry_until || s.speech_error_until || pro_speech_visible() ||
        pro_send_feedback_text(now) ||
        carry.active || carry.error[0] || is_question(a->id) || now - a->last_busy > 25000)
        return false;
    *seconds = (now - a->busy_ms) / 1000;
    return true;
}
static ht_character_mood_t pro_surface_mood(void)
{
    if (s.view == VOICE) return !s.voice_start_pending && !s.voice_waiting && audio_client_recording() ?
        HT_CHARACTER_LISTENING : HT_CHARACTER_WORKING;
    if (pro_speech_visible()) return s.speech.playing ? HT_CHARACTER_LISTENING : HT_CHARACTER_IDLE;
    return character_mood();
}
#endif
static bool home_caption_rotates(void)
{
#ifdef DEVICE_PRO_COMPANION
    return false; // Pane identity and activity each have their own stable line.
#else
    const agent_t *a = active();
    return (s.view == HOME || s.view == AGENT) && a && a->busy && s.connected &&
        !s.loading && !s.nap && !s.quiet && !s.locked && !display_is_asleep() &&
        !s.voice_retry_until && !carry.active && !carry.error[0] && !visit.available;
#endif
}
static bool home_caption_tick(uint32_t now)
{
    // A caption's long end letters are part of its touch target. Do not
    // replace them with a shorter activity label while a finger is down.
    if (s.touch_down && !s.touch_cancelled && home_caption.initialized) return false;
    const agent_t *a = active();
    return ht_character_caption_tick(&home_caption, now, a ? a->id : "", home_caption_rotates());
}
static bool status_animated(void)
{
    if (s.nap || s.quiet || s.locked || display_is_asleep() || s.touch_down)
        return false;
    if (s.view == VOICE) return !s.voice_review_preview && voice_status()[0];
    return home_caption_rotates() && home_caption.activity && !s.straight_title;
}
static unsigned status_speed(void)
{
    return s.view == VOICE && !s.voice_start_pending && !s.voice_waiting &&
        audio_client_recording() ? 2 : 1;
}
static uint32_t status_wake_ms(uint32_t now)
{
    unsigned speed = status_speed();
    return (ht_shimmer_wake_ms(now * speed) + speed - 1) / speed;
}
static void surface_tick(uint32_t now)
{
#ifdef DEVICE_PRO_COMPANION
    if (s.send_feedback.agent[0] && (!pro_send_feedback_matches() ||
        (!s.send_feedback.accepted && !draft.pending) ||
        (s.send_feedback.until && (int32_t)(now - s.send_feedback.until) >= 0))) {
        pro_send_feedback_clear(); change();
    }
    uint32_t busy_second = 0;
    bool busy_visible = pro_busy_elapsed(active(), now, &busy_second);
    if (busy_visible != s.pro_busy_visible ||
        (busy_visible && busy_second != s.pro_busy_second)) {
        s.pro_busy_visible = busy_visible;
        s.pro_busy_second = busy_second;
        change();
    }
    if (s.view == TODAY && pro_metrics_tick(&s.metrics,now)) change();
    if (s.view == VOICE_SAMPLES || s.view == VOICE_PARAMS) {
        if (s.locked || display_is_asleep()) pro_voice_sample_stop();
        if ((int32_t)(now - s.sample_poll_due) >= 0) {
            pro_voice_progress_t before = pro_voice_sample_progress();
            pro_voice_sample_tick(now);
            pro_voice_progress_t after = pro_voice_sample_progress();
            if (before.phase != after.phase || before.consumed != after.consumed) change();
            s.sample_poll_due = now + 20;
        }
    }
    pro_speech_tick(now);
    if (pro_appearance_view() && !s.locked && !display_is_asleep()) {
        ht_character_tick(&s.preview_character, now, HT_CHARACTER_IDLE, s.quiet, true,
                          false, HT_WIDTH / 2, 0, 0);
        if (pro_visual_changed(&s.preview_character, HT_CHARACTER_IDLE, now, s.quiet, false)) change();
    }
#endif
    notice_flush_reads(now);
    if (s.view == TABS && !s.locked && !display_is_asleep() && ht_tab_carousel_tick(&tab_carousel, now)) change();
    if (home_caption_tick(now)) change();
    uint8_t phase = status_animated() ? ht_shimmer_phase(now * status_speed()) : 0;
    if (phase != s.status_phase) { s.status_phase = phase; change(); }
    bool main = s.view == HOME || s.view == AGENT;
    bool visible = !s.locked && !display_is_asleep() &&
#ifdef DEVICE_PRO_COMPANION
        (main || s.view == VOICE);
#else
        ((main && s.connected && !s.loading) || s.view == VOICE);
#endif
    uint32_t held = now - s.touch_started;
    bool review_preview = cable_client_supports(CABLE_FEATURE_DRAFT) &&
        visible && s.view == VOICE && s.voice_open && !s.voice_search &&
        !s.voice_waiting && !s.voice_start_pending && audio_client_recording() &&
        (s.voice_return == HOME || s.voice_return == AGENT || s.voice_return == SELECTION) &&
        s.touch_down && !s.touch_cancelled && gesture.live && !gesture.moved && !gesture.guarded &&
        pressed_action.kind == A_PET && held >= 650 && held <= 1800;
    if (review_preview != s.voice_review_preview) { s.voice_review_preview = review_preview; change(); }
    if (visible && main && s.touch_down && !s.touch_cancelled && gesture.live && !gesture.guarded &&
        pressed_action.kind == A_PET && !gesture.moved && held >= 650 && held < 5000) {
        // Enter directly. The opening contact is consumed until a real release,
        // so lifting or sliding after the hold cannot also select a tab.
#ifdef DEVICE_PRO_COMPANION
        view(LAUNCHER);
#else
        tabs_open();
#endif
        return;
    }
    ht_character_mood_t mood =
#ifdef DEVICE_PRO_COMPANION
        pro_surface_mood();
#else
        s.view == VOICE ?
        (!s.voice_start_pending && !s.voice_waiting && audio_client_recording() ? HT_CHARACTER_LISTENING : HT_CHARACTER_WORKING) :
        character_mood();
#endif
    bool changed = ht_character_tick(&character, now, mood, s.quiet, visible,
                           s.touch_down && !s.touch_cancelled,
                           s.last_x,
                           mood == HT_CHARACTER_LISTENING ? audio_client_input_level() : 0, s.character_activity);
#ifdef DEVICE_PRO_COMPANION
    (void)changed; // ASCII motion is shared state; only visible bitmap changes need paint.
    bool pro_visible = !s.locked && !display_is_asleep() && (main || s.view == VOICE);
    ht_character_delivery_tick(&character, now, notice_unread() > 0, s.notice_sequence,
                               pro_visible && main && !s.quiet);
    ht_character_t portrait = character;
    if (pro_speech_visible()) {
        portrait.motion.reaction.pose.level = s.speech.level;
        portrait.motion.reaction.pose.emotion = s.speech.emotion;
    }
    if (pro_visible && pro_visual_changed(&portrait, mood, now, s.quiet, main && notice_unread() > 0)) change();
#else
    if (changed) change();
#endif
}
static void page_controls(ht_scene_t *f, int count)
{
    control(f, 111, 390, 60, "<", A_UP, 0, s.offset > 0);
    control(f, 183, 390, 108, "[home]", A_HOME, 0, true);
    control(f, 321, 390, 36, ">", A_DOWN, count, s.offset + 3 < count);
}
// Secondary screens retain explicit choices. The main face is the touch surface itself.
static void command_face(ht_scene_t *f, const char *heading_, const char *subject,
                         const char *context, const char *primary, const char *secondary,
                         bool attention, hit_t links[4])
{
    ht_command_face_t face_ = {.heading = heading_, .subject = subject, .context = context,
                              .primary = primary, .secondary = secondary,
                              .foreground = FG, .dim = DIM, .accent = attention ? ERROR : ACCENT,
                              .selection = SEL, .pressed = s.pressed, .enabled = links[2].enabled};
    ht_command_face(f, &face_);
    for (int i = 0; i < 4; i++) {
        links[i].rect = ht_command_targets[i];
        s.hits[s.hit_count++] = links[i];
    }
}
#if HT_FACE_PX >= 720
/*
 * THE FIRST LINE IS THE TAB STRIP — every tab, not just the one you are in.
 *
 * The dial names the current tab on the arc above the agent and stops there, because a curved line
 * that wide is all the room it has. A square has a whole 54-cell row, which is enough to carry the
 * switcher itself: the names in sequence, the one you are in filled with SEL, and a tap that goes
 * straight to that tab's panes.
 *
 * TWO RUNS, NOT ONE PER TAB. The strip is drawn once in DIM across the full width, then the selected
 * label is drawn again over it with the selection fill. Six tabs as six runs would cost six of the
 * forty a scene has, and the agent's result page already spends 27 on the companion and 6 on the
 * recap. Two is what the budget can afford, and overdraw is free here — later runs paint over earlier
 * ones by construction.
 *
 * The hit rects are per tab and cost nothing from that budget.
 */
static void pro_tab_strip(ht_scene_t *f)
{
    const int CELLS = 648 / ht_mono_20.width;   /* 54 */
    if (s.tab_count <= 0) {
        ht_text(f, 36, 40, 648, &ht_mono_20, DIM, BG, s.loading ? "loading tabs" : "no tabs");
        return;
    }
    int sel = -1;
    for (int i = 0; i < s.tab_count; i++)
        if (!strcmp(s.selected_tab, s.tabs[i].id)) { sel = i; break; }

    /* A tab costs its name plus a space either side — the same space that becomes the selection's
     * padding, so a filled tab never has its first letter against the fill's edge. */
    int span[SWARMS_MAX], cells[SWARMS_MAX];
    for (int i = 0; i < s.tab_count; i++) {
        int n = 0;
        for (const char *q = s.tabs[i].name; *q; ) { ht_utf8_next(&q); n++; }
        cells[i] = n > 14 ? 14 : n;        /* one long name must not eat the whole line */
        span[i] = cells[i] + 2;
    }
    if (s.tab_first < 0) s.tab_first = 0;
    if (s.tab_first >= s.tab_count) s.tab_first = s.tab_count - 1;

    /*
     * WALKING THE STRIP. `tab_first` is yours while you use < and >, and the device only overrides it
     * when the tab you are actually in has scrolled off — otherwise the strip would snap back under
     * your finger every time you moved it.
     *
     * The arrows cost two cells each and are only reserved when there is something past that edge, so
     * a strip that fits uses the whole line.
     */
    for (int pass = 0; pass < 2; pass++) {
        int left_arrow = s.tab_first > 0 ? 2 : 0, room = CELLS - left_arrow, used = 0, last = s.tab_first;
        while (last < s.tab_count && used + span[last] <= room) { used += span[last]; last++; }
        if (last < s.tab_count) {                       /* something past the right edge: reserve > */
            room -= 2;
            while (last > s.tab_first + 1 && used > room) used -= span[--last];
        }
        if (pass || sel < 0 || (sel >= s.tab_first && sel < last)) {
            /* draw */
            char strip[HT_TEXT_BYTES];
            size_t bytes = 0;
            int at = left_arrow, sel_x = -1, sel_cells = 0;
            char sel_text[40] = "";
            if (left_arrow) { strip[bytes++] = '<'; strip[bytes++] = ' '; }
            for (int i = s.tab_first; i < last; i++) {
                char label[40];
                int n = 0; size_t lb = 0;
                label[lb++] = ' ';
                for (const char *q = s.tabs[i].name; *q && n < cells[i]; n++) {
                    const char *begin = q;
                    ht_utf8_next(&q);
                    size_t w = (size_t)(q - begin);
                    if (lb + w + 2 >= sizeof label) break;
                    memcpy(label + lb, begin, w); lb += w;
                }
                label[lb++] = ' '; label[lb] = 0;
                if (bytes + lb + 3 >= sizeof strip) break;
                memcpy(strip + bytes, label, lb); bytes += lb;
                if (i == sel) { sel_x = at; sel_cells = span[i]; snprintf(sel_text, sizeof sel_text, "%s", label); }
                if (s.hit_count < 24)
                    s.hits[s.hit_count++] = (hit_t){{(int16_t)(36 + at * ht_mono_20.width), 26,
                                                     (int16_t)(span[i] * ht_mono_20.width), 56},
                                                    A_TAB, i, s.connected};
                at += span[i];
            }
            bool right_arrow = last < s.tab_count;
            if (right_arrow) {
                while (at < CELLS - 1 && bytes + 2 < sizeof strip) { strip[bytes++] = ' '; at++; }
                if (bytes + 1 < sizeof strip) strip[bytes++] = '>';
            }
            strip[bytes] = 0;
            ht_text(f, 36, 40, 648, &ht_mono_20, DIM, BG, strip);
            if (sel_x >= 0)
                ht_text(f, 36 + sel_x * ht_mono_20.width, 40, sel_cells * ht_mono_20.width,
                        &ht_mono_20, ACCENT, SEL, sel_text);
            if (left_arrow && s.hit_count < 24)
                s.hits[s.hit_count++] = (hit_t){{36, 26, 48, 56}, A_TAB_STRIP_LEFT, 0, true};
            if (right_arrow && s.hit_count < 24)
                s.hits[s.hit_count++] = (hit_t){{36 + (CELLS - 2) * ht_mono_20.width, 26, 48, 56},
                                                A_TAB_STRIP_RIGHT, 0, true};
            return;
        }
        /* The tab we are in is off the strip. Anchor on it and lay the line out again. */
        s.tab_first = sel;
        while (s.tab_first > 0) {
            int back = s.tab_first - 1, total = span[back], k = back + 1;
            while (k <= sel) total += span[k++];
            if (total + 4 > CELLS) break;      /* 4 = room for both arrows */
            s.tab_first = back;
        }
    }
}

#endif
static void render_workspace_preview(ht_scene_t *f)
{
    int i=workspace.choice;
    if (i<0 || i>=s.tab_count) return;
    hit_t links[4]={0};
    command_face(f,"workspaces",s.tabs[i].name,"",
        i==workspace.origin ? "release to stay" : "release to open","slide back to cancel",false,links);
}
static void render_home(ht_scene_t *f)
{
    s.caption_arc = (ht_rect_t){0};
    if (!s.connected || s.loading) { render_brand(f); return; }
    if (workspace.touching && workspace.moved && !workspace.cancelled) { render_workspace_preview(f); return; }
#if HT_FACE_PX >= 720
    pro_tab_strip(f);   // the first line is the whole switcher on this face
#endif
    agent_t *a = active();
    // The top caption belongs to the current pane; only completed work gets
    // a recap. The bell has its own lower target, outside the voice surface.
    const char *recap = a && !a->busy && a->recap_ready && s.connected && !s.loading &&
        !s.nap && !s.voice_retry_until && !carry.active && !carry.error[0] ? a->preview : NULL;
    // A live turn can outlast its terminal footer (or have no readable footer).
    // Keep its busy state visible while more specific activity is unavailable.
    const char *activity = a && a->busy && s.connected && !s.loading && !s.nap ?
        (a->tool[0] ? a->tool : "Working") : "";
    home_caption_tick(ms());
    bool rotating = home_caption_rotates();
    const char *caption = rotating && home_caption.activity ? activity : a ? a->name : "Choose a pane";
    bool bell = !s.voice_retry_until && !carry.active && !carry.error[0] && !visit.available;
    unsigned unread = notice_unread();
    bell = bell && unread > 0;
    char status[100];
    if (s.voice_retry_until) COPY(status, "Try again");
    else status[0] = 0;
    ht_character_face_t f_ = {.recipient = caption, .status = bell ? "" : status,
        .hint = "",
        .detail = "",
        .mood = character_mood(), .pose = character.motion.reaction.pose,
#if HT_FACE_PX >= 720
        // Always straight here. ht_arc_title bends text around a 205 px radius baked into
        // arc_trig[32][2]; at 720 the same table draws the name through the companion.
        .straight_title = true,
#else
        .straight_title = s.straight_title,
#endif
        .footer_action = carry.active || carry.error[0] || visit.available,
        .ink = FG, .foreground = FG, .dim = DIM,
        .primary_title = true, .roomy_reading = true};
    char carried[128];
    if (carry.active) {
        snprintf(carried,sizeof(carried),"%d line%s from %.70s",carry.rows,carry.rows==1?"":"s",carry.source);
        f_.detail=carried; f_.carrying=true; f_.hint="";
    } else if (carry.error[0]) {
        f_.status="Text expired"; f_.detail="Select it again or drop text"; f_.hint=""; f_.focus=true;
    }
    if (visit.available) f_.hint = "";
    ht_character_face(f, &character, &f_, ACCENT, recap);
    if (bell) ht_notification_bell(f, unread, f_.ink);
    s.status_phase = status_animated() ? ht_shimmer_phase(ms()) : 0;
    for (int i = 0; i < f->count; i++) {
        ht_run_t *run = &f->runs[i];
        if (run->arc == 1 || (run->font == &ht_mono_20 &&
#if HT_FACE_PX >= 720
                             (run->y == 80 || run->y == 108))) {
#else
                             s.straight_title && (run->y == 41 || run->y == 69))) {
#endif
            run->fg = rotating ? ht_character_caption_ink(FG, BG, home_caption.opacity) : FG;
            if (run->arc) run->shimmer = s.status_phase;
        }
    }
    if ((carry.active || carry.error[0]) && visit.available) {
        footer_control(f, 95, 156, "[return]", A_RETURN, s.connected && !visit.pending);
        footer_control(f, 263, 108, "[drop]", A_CARRY_DROP, true);
    } else if (carry.active || carry.error[0]) {
        footer_control(f, 113, 240, "[ drop text ]", A_CARRY_DROP, true);
    } else if (visit.available) {
        footer_control(f, 113, 240, "[ return ]", A_RETURN, s.connected && !visit.pending);
    }
    if (!carry.active && !carry.error[0] && !visit.available) {
        // Both phases of the caption open the same pane picker.
#if HT_FACE_PX >= 720
        s.hits[s.hit_count++] = (hit_t){{36, 76, 648, 46}, A_AGENTS, 0, true};
#else
        s.hits[s.hit_count++] = (hit_t){{83, 0, 300, 66}, A_AGENTS, 0, true};
#endif
        for (int i = 0; i < f->count; i++) if (f->runs[i].arc == 1) {
            ht_rect_t r = ht_run_bounds(&f->runs[i]);
            s.caption_arc = (ht_rect_t){r.x - 14, r.y - 14, r.w + 28, r.h + 28};
            break;
        }
    }
    if (bell)
#if HT_FACE_PX >= 720
        // Under the bell at HT_NOTIFICATION_Y, in the row the hint leaves empty on this face.
        s.hits[s.hit_count++] = (hit_t){{144, 646, 432, 66}, A_INBOX, 0, unread > 0};
#else
        s.hits[s.hit_count++] = (hit_t){{83, 382, 300, 84}, A_INBOX, 0, unread > 0};
#endif
    // The bell and the creature never share a target, even when the bell is
    // hidden or its count changes under a finger. Centre always starts voice.
#if HT_FACE_PX >= 720
    // The font_16 companion exactly: 54*8 x 27*16 at x=(720-432)/2, y=140.
    s.hits[s.hit_count++] = (hit_t){{144, 140, 432, 432}, A_PET, 0, true};
#else
    s.hits[s.hit_count++] = (hit_t){{33, 66, 400, 316}, A_PET, 0, true};
#endif
}
#if HT_FACE_PX >= 720
/*
 * PAGE ONE: the tab's agents, in the window's own layout.
 *
 * The desktop does not send a list, it sends a SHAPE — normalised rectangles from
 * app_state.dart's activeTileShape, one per pane, including the ones this device cannot drive, because
 * "a shell or a viewer holds its place in the grid, and dropping it would leave the shape with a hole
 * in it". So the device is not choosing a layout here. It is being told one, and its only job is to
 * land it on a cell grid without lying about the proportions.
 *
 * 54 x 18 CELLS, and both numbers are chosen for their divisors. Every preset in pane_preset.dart is
 * built from halves, thirds, sixths and ninths; 54 and 18 divide by all four, so a half is exactly a
 * half and a third is exactly a third with no rounding drift anywhere. 54 * 12 x 18 * 28 = 648 x 504,
 * which is 1.286:1 against the window's 1.344:1 — within 4.3%.
 *
 * (The LVGL desk on this same board is 656 x 600 = 1.093:1. Its comment still claims 1.34:1, which was
 * true at the original DESK_GRID_H 488; raising it to 600 for the extra room left every rectangle the
 * window sends 23% too tall. Worth fixing there separately.)
 *
 * A TILE IS THREE RUNS, not a box: a rule of ':' along its top edge, the name a row below it, and the
 * state as a WORD a row below that. Nine tiles is 27 runs, plus the tab row, the status and the control
 * row — 30 of HT_RUNS 40. A fourth line per tile would not fit, and neither would a tenth tile.
 * The ':' is from the octopus's own density ramp; ht_mono_* covers 32..255 and has no box-drawing set
 * at all, so a border made of U+2500 would be an empty cell on the glass.
 */
enum { DESK_COLS = 54, DESK_ROWS = 18, DESK_X = 36, DESK_Y = 100 };
static int desk_col(int v) { return (v * DESK_COLS + 500) / 1000; }
static int desk_row(int v) { return (v * DESK_ROWS + 500) / 1000; }
static int desk_agent(const char *id)
{
    if (!id || !*id) return -1;
    for (int i = 0; i < s.count; i++) if (!strcmp(s.agents[i].id, id)) return i;
    return -1;
}
static void render_desk(ht_scene_t *f)
{
    pro_tab_strip(f);
    // The shape must be the SELECTED tab's. A roster that has moved on while the shape has not is the
    // one case that would draw agents at another tab's seats, so it falls back to saying so.
    bool tagged = !strcmp(s.tile_tab, s.selected_tab);
    /*
     * EVERY NAMED SEAT MUST RESOLVE, or this shape belongs to a roster we do not have yet.
     *
     * The window's shape and the device's roster ride DIFFERENT frames, so after a tab switch the
     * rectangles routinely land a beat before the agents that go in them. Drawing anyway fills the
     * desk with the word "pane" — every seat unnamed — and it stays that way in the eye long after
     * the roster arrives, because that is what the person saw. The LVGL desk on this board hit
     * exactly this and answered it the same way (desk_tiles_usable in ui_screens.c).
     *
     * A seat with an empty agentId is a shell or a viewer and is legitimately unnamed; only the named
     * ones have to be found.
     */
    int named = 0, resolved = 0;
    for (int i = 0; i < s.tile_count; i++) {
        if (!s.tiles[i].agent_id[0]) continue;
        named++;
        if (desk_agent(s.tiles[i].agent_id) >= 0) resolved++;
    }
    /*
     * ONE SEAT THAT NEVER RESOLVES MUST NOT HOLD THE WHOLE DESK.
     *
     * Requiring every named seat was right for the transient case and wrong for the steady one: a
     * window can hold a pane this device's roster does not carry — an agent on another machine, or one
     * the roster filters — and then "3 of 4 named" is the permanent truth, not a beat of lag. Waiting
     * on it showed a sentence instead of a desk, forever.
     *
     * So the bar is that SOMETHING resolves. Nothing resolving is the roster being a frame behind, and
     * that is the case worth waiting out; the odd unresolvable seat is drawn as what it is.
     */
    bool ready = named == 0 || resolved > 0;
    bool shaped = s.tile_count > 0 && tagged && ready;
    if (!shaped) {
        // Three different failures used to read as one sentence, which is no use to anyone standing in
        // front of the device: nothing to lay out, a shape that belongs to another tab, or a window
        // that has not described this one yet.
        ht_center(f, 330, UI_FONT, FG,
                  s.loading            ? "Loading..."
                  : !s.count           ? "No panes in this tab."
                  : !s.tile_count      ? "No layout from the app yet."
                  : !tagged            ? "Layout is for another tab."
                                       : "Matching panes to agents...");
        if (!ready && tagged && s.tile_count) {
            // The counts, so a shape that never resolves can be told from one that is merely early.
            char why[64];
            snprintf(why, sizeof why, "%d of %d named %s roster %d", resolved, named, "\xc2\xb7", s.count);
            ht_center(f, 386, &ht_mono_20, DIM, why);
        }
        return;
    }
    /*
     * THE SEPARATORS ARE ONE RUN PER GRID ROW, not one per tile edge.
     *
     * A run is a single line of text, so a VERTICAL line costs one run per row it crosses — eighteen
     * of them for a full-height boundary, and a 3 x 3 desk has two such boundaries. That is the whole
     * scene budget spent on lines. Drawing the grid into a character buffer first and emitting one run
     * per row inverts the cost: every vertical boundary at that row shares the run, so the lines cost
     * 18 runs no matter how many columns the window is using.
     *
     * Budget, against HT_RUNS 40: 18 line rows + 2 per tile + the tab strip's 2 + the status. Nine
     * tiles is 39. That is the ceiling, and it is why a tile gets two text rows and not three.
     */
    char grid[DESK_ROWS][DESK_COLS + 1];
    memset(grid, ' ', sizeof grid);
    int working = 0, idle = 0;
    struct { int16_t x, y, w; int ai; bool pane; const char *state; } seat[SWARM_TILES_MAX];
    int seats = 0;

    for (int i = 0; i < s.tile_count; i++) {
        const cable_tile_t *t = &s.tiles[i];
        int c0 = desk_col(t->x1), c1 = desk_col(t->x2);
        int r0 = desk_row(t->y1), r1 = desk_row(t->y2);
        if (c1 <= c0 || r1 <= r0) continue;          // a rectangle thinner than one cell
        if (c1 > DESK_COLS) c1 = DESK_COLS;
        if (r1 > DESK_ROWS) r1 = DESK_ROWS;
        // The tile's top edge, across its own width.
        for (int c = c0; c < c1; c++) grid[r0][c] = ':';
        /*
         * The left edge, full height, TWO COLUMNS of the same ':' — one column reads as a hairline
         * between two panes that are themselves full of text, which is not enough separation at a
         * glance. Doubling the column rather than changing the character keeps the dotted texture the
         * rest of the face is drawn in; '|' or '=' made it a different object entirely.
         *
         * Only where it is an INTERIOR boundary. The canvas has no outer border: the face's own margin
         * is the border, and a box drawn around the whole grid would read as a window inside a window.
         *
         * The second column costs one cell of the tile's width, which is why the labels below start
         * two cells in.
         */
        if (c0 > 0)
            for (int r = r0; r < r1; r++) {
                grid[r][c0] = ':';
                if (c0 + 1 < DESK_COLS) grid[r][c0 + 1] = ':';
            }

        int ai = desk_agent(t->agent_id);
        agent_t *a = ai >= 0 ? &s.agents[ai] : NULL;
        if (a && a->busy) working++; else if (a) idle++;
        if (seats < SWARM_TILES_MAX)
            seat[seats++] = (typeof(seat[0])){
                (int16_t)(DESK_X + c0 * ht_mono_20.width), (int16_t)(DESK_Y + r0 * ht_mono_20.height),
                (int16_t)((c1 - c0) * ht_mono_20.width), ai, !t->agent_id[0],
                !t->agent_id[0] ? "pane" : !a ? "unknown"
                                 : a->busy ? "working" : a->recap_ready ? "done" : "idle"};
        if (s.hit_count < 24)
            s.hits[s.hit_count++] = (hit_t){{(int16_t)(DESK_X + c0 * ht_mono_20.width),
                                             (int16_t)(DESK_Y + r0 * ht_mono_20.height),
                                             (int16_t)((c1 - c0) * ht_mono_20.width),
                                             (int16_t)((r1 - r0) * ht_mono_20.height)},
                                            A_AGENT, ai, ai >= 0 && s.connected};
    }

    for (int r = 0; r < DESK_ROWS; r++) {
        grid[r][DESK_COLS] = 0;
        if (!memchr(grid[r], ':', DESK_COLS)) continue;   // a row with no line on it costs no run
        ht_ascii_text(f, DESK_X, DESK_Y + r * ht_mono_20.height, DESK_COLS * ht_mono_20.width,
                      &ht_mono_20, DIM, BG, grid[r], DESK_COLS);
    }

    // The labels go on top of the lines, inset by one cell on each side so a name can never paint out
    // the boundary of the tile beside it.
    for (int i = 0; i < seats; i++) {
        int ai = seat[i].ai;
        bool focused = ai >= 0 && ai == s.active;
        // Two cells in from the doubled rule, and one clear of the next tile's, so a name can never
        // paint out either column of a boundary.
        int w = seat[i].w - 3 * ht_mono_20.width;
        if (w < ht_mono_20.width) continue;
        char label[HT_TEXT_BYTES];
        // Three states, three words: a seat with no agent at all is a shell or a viewer ("pane"); a
        // seat naming an agent this device does not carry is "agent"; the rest have their own name.
        snprintf(label, sizeof label, "%s", seat[i].pane ? "pane" : ai < 0 ? "agent" : s.agents[ai].name);
        ht_text(f, seat[i].x + 2 * ht_mono_20.width, seat[i].y + ht_mono_20.height, w, &ht_mono_20,
                !s.connected ? DIM : focused ? ACCENT : seat[i].pane ? DIM : FG, BG, label);
        ht_text(f, seat[i].x + 2 * ht_mono_20.width, seat[i].y + 2 * ht_mono_20.height, w, &ht_mono_20,
                DIM, BG, seat[i].state);
    }
    /* The unread count leads here too, in the same brackets and the same place as on the agent face,
     * so one habit reaches the inbox from either page. */
    char tally[64];
    if (s.notice_count > 0)
        snprintf(tally, sizeof tally, "[%d]  %d working %s %d idle", s.notice_count, working, "\xc2\xb7", idle);
    else
        snprintf(tally, sizeof tally, "%d working %s %d idle", working, "\xc2\xb7", idle);
    ht_center(f, 600, UI_FONT, s.notice_count > 0 ? ACCENT : DIM, tally);
}
#endif
static void render_agents(ht_scene_t *f)
{
#if HT_FACE_PX >= 720
    // On a square the pane list IS the desk: the window's shape, not a column of rows.
    render_desk(f);
    return;
#endif
    heading(f, "panes");
    int last = s.count > TAB_ROWS ? s.count - TAB_ROWS : 0;
    if (s.offset > last) s.offset = last;
    if (s.offset < 0) s.offset = 0;
    if (!s.count) {
        center(f, 192, s.loading ? "Loading..." : "No panes in this tab.", FG);
        control(f, 131, 283, 204, "Choose a tab", A_TABS, 0, s.connected);
        return;
    }
    for (int row = 0; row < TAB_ROWS && s.offset + row < s.count; row++) {
        int i = s.offset + row, y = TAB_TOP + row * TAB_ROW_HEIGHT;
        agent_t *a = &s.agents[i];
        int hit = s.hit_count++;
        s.hits[hit] = (hit_t){{59, y, 348, TAB_ROW_HEIGHT}, A_AGENT, i, s.connected};
        bool selected = i == s.active || hit == s.pressed;
        char label[HT_TEXT_BYTES]; snprintf(label, sizeof label, " %s", a->name);
        ht_text(f, 71, y + 14, 324, UI_FONT,
            !s.connected ? DIM : is_question(a->id) || selected ? ACCENT : FG,
            selected ? SEL : BG, label);
    }
}
static void render_agent(ht_scene_t *f)
{
    render_home(f); // One companion surface; changing panes only changes its recipient.
}
static bool question_view(view_t v)
{
    return v == QUESTION || v == CHOICE || v == ANSWER_REVIEW;
}
// THREE ROWS, NOT FIVE. Five at 38 px run 146 -> 336, past the position line; three end at 260.
// A page is 348 / 17 = 20 cells x 3 = 60 characters, where it used to be 29 x 5 = 145 — so a long
// question is three pages now, not one. That is the honest cost of the size.
#ifdef DEVICE_PRO_COMPANION
#define Q_ROWS 6
#else
#define Q_ROWS 3
#endif
static int question_rows(const char *value)
{
#ifdef DEVICE_PRO_COMPANION
    return ht_pro_text_rows(value, &ht_pro_32, 608);
#else
    return ht_text_rows(value, UI_FONT, 348);
#endif
}
static void question_text(ht_scene_t *f, const char *value)
{
    int rows = question_rows(value), last = rows > Q_ROWS ? rows - Q_ROWS : 0;
    if (s.offset > last) s.offset = last;
    if (s.offset < 0) s.offset = 0;
    ht_wrap(f, 59, 146, 348, Q_ROWS, s.offset, UI_FONT, FG, value);
    char position[40];
    if (rows > Q_ROWS) snprintf(position,sizeof position,"%d-%d / %d  drag to read",s.offset+1,s.offset+Q_ROWS,rows);
    else if (s.view==CHOICE) COPY(position,"drag for choices");
    else position[0] = 0;
    // mono_20 at 276: this is chrome ABOUT the text, not the text.
    if (!s.q.speech_error[0]) ht_text(f, 85, 276, 296, &ht_mono_20, DIM, BG, position);
}
static void render_question(ht_scene_t *f)
{
    heading(f, s.q.name[0] ? s.q.name : "Question");
    if (s.q.loading) {
        center(f, 214, "Reading the question...", DIM);
        control(f, 122, 346, 187, "[ later ]", A_HOME, 0, true);
        return;
    }
    if (s.q.error[0] || !s.q.valid || !s.q.supported) {
        ht_wrap(f, 65, 173, 336, 5, 0, UI_FONT, DIM,
            s.q.error[0] ? s.q.error : !s.q.valid ? "Answered elsewhere." : "This question needs the desktop.");
        control(f, 116, 346, 238, "[ on desktop ]", A_DESKTOP, 1, s.connected);
        return;
    }
    question_item_t *q = &s.q.item[s.q.index];
    char label[40]; snprintf(label,sizeof label,"question %d / %d",s.q.index+1,s.q.count);
    text(f, 125, 109, 216, label, DIM);
    question_text(f, q->prompt);
    if (s.q.speech_error[0]) ht_wrap(f,77,319,312,2,0,&ht_mono_20,ERROR,s.q.speech_error);
    if (q->can_text) {
        /*
     * UP TO y=336, AND THE RIM IS WHY.
     *
     * At 17 px a cell these labels are 119 + 85 + 102 = 306 px of text. The chord at y=417, where the
     * old row ended, is 143 px — the outer two would have been cut in half by the glass. At 336 the
     * chord is 364 and the row fits with margin.
     *
     * "[choices]" (153 px) went with it: three labels at this size do not share a line on a circle.
     * The choices screen is still one drag away, which is what the position line says.
     */
    control(f,54,336,119,"[later]",A_HOME,0,true);
        control(f,184,336,119,q->draft[0] ? "[draft]" : "[say]",
                q->draft[0] ? A_QUESTION_REVIEW : A_QUESTION_SAY,0,!s.q.pending);
        control(f,313,336,102,"[next]",A_QUESTION_CHOICES,0,!s.q.pending);
    } else {
        control(f,79,346,153,"[ later ]",A_HOME,0,true);
        control(f,236,346,153,"[choices]",A_QUESTION_CHOICES,0,!s.q.pending);
    }
}
static void render_choices(ht_scene_t *f)
{
    heading(f, s.q.name);
    question_item_t *q = &s.q.item[s.q.index];
    char label[64]; snprintf(label,sizeof label,"%s %d / %d",q->multi ? "choose any" : "choose one",s.q.choice+1,q->count);
    text(f, 107, 109, 252, label, DIM);
    question_text(f, q->options[s.q.choice]);
    bool chosen = (q->selected & (1u << s.q.choice)) != 0;
    control(f, 131, 300, 204, chosen ? "[ selected ]" : "[ select ]", A_CHOICE, s.q.choice, !s.q.pending);
    // 366, where the chord is 380. At the old 387 two labels of 102 + 136 would not have cleared it.
    control(f, 88, 366, 102, "[back]", A_QUESTION_BACK, 0, true);
    control(f, 258, 366, 136, "[review]", A_QUESTION_REVIEW, 0, q->selected && !s.q.pending);
}
static void render_answer_review(ht_scene_t *f)
{
    heading(f, s.q.name);
    if (s.q.error[0]) {
        ht_wrap(f,65,166,336,5,0,UI_FONT,DIM,s.q.error);
        control(f,116,346,238,"[ on desktop ]",A_DESKTOP,1,s.connected);
        return;
    }
    question_item_t *q = &s.q.item[s.q.index];
    char label[40]; snprintf(label,sizeof label,"answer %d / %d",s.q.index+1,s.q.count);
    text(f,125,109,216,label,DIM);
    question_text(f,q->answer);
    if (s.q.speech_error[0]) ht_wrap(f,77,319,312,2,0,&ht_mono_20,ERROR,s.q.speech_error);
    if (s.q.pending) { center(f, 346, "Waiting...", DIM); return; }
    int footer_y = q->draft[0] ? 332 : 366;
    control(f,q->draft[0] ? 54 : 88,footer_y,102,"[back]",A_QUESTION_BACK,0,true);
    if (q->draft[0]) control(f,176,footer_y,119,"[again]",A_QUESTION_SAY,0,true);
    control(f,q->draft[0] ? 313 : 258,footer_y,102,s.q.index+1 < s.q.count ? "[next]" : "[send]",
        A_ANSWER,0,s.connected && !s.q.pending && (q->selected || q->draft[0]));
}
static const char *settings_item(int wanted, action_kind_t *action)
{
    static const struct { const char *label; action_kind_t action; uint32_t feature; } items[] = {
        {"Inbox", A_INBOX, 0}, {"Machines", A_MACHINES, 0},
        {"Model", A_MODELS, 0}, {"Stop current turn", A_STOP, 0},
        {"Companion / gestures", A_COMPANION, 0}, {"Brightness", A_BRIGHT, 0},
        {"Sound", A_MUTE, 0},
        {"Find Harness", A_FIND, CABLE_FEATURE_FORM},
        {"New Harness", A_FORM, CABLE_FEATURE_FORM},
        {"Latest output", A_LATEST, CABLE_FEATURE_VISIT},
        {"Select text", A_SELECT_BEGIN, CABLE_FEATURE_SELECTION},
    };
    for (unsigned i = 0; i < sizeof items / sizeof items[0]; i++) {
        if (items[i].feature && !cable_client_supports(items[i].feature)) continue;
        if (wanted-- == 0) {
            if (action) *action = items[i].action;
            return items[i].label;
        }
    }
    return NULL;
}
static int settings_count(void)
{
    int count = 0;
    while (settings_item(count, NULL)) count++;
    return count;
}
static void tabs_move(int dy)
{
    // Move by one name while the finger is down, rather than paging by three
    // after release. The existing gesture recognizer owns tap cancellation.
    s.tab_drag += dy;
    int step = s.tab_drag / TAB_ROW_HEIGHT;
    if (!step) return;
    s.tab_drag %= TAB_ROW_HEIGHT;
    int count = s.view == AGENTS ? s.count : s.view == SETTINGS ? settings_count() : s.tab_count;
    int last = count > TAB_ROWS ? count - TAB_ROWS : 0;
    int next = s.offset + step;
    if (next < 0) next = 0;
    if (next > last) next = last;
    if (next != s.offset) { s.offset = next; change(); }
    else s.tab_drag = 0; // Overscroll never builds up travel to undo on reversal.
}
static void tab_name(ht_scene_t *f, const char *name, int center_x, uint16_t ink)
{
    int first = f->count;
    const int width = 12 * UI_FONT->width;
    ht_wrap(f, 0, 0, width, 6, 0, UI_FONT, ink, name[0] ? name : "Untitled");
    while (f->count > first && !f->runs[f->count - 1].text[0]) f->count--;
    int rows = f->count - first;
    for (int i = first; i < f->count; i++) {
        ht_run_t *r = &f->runs[i];
        const char *p = r->text;
        int cells = 0;
        while (*p) { ht_utf8_next(&p); cells++; }
        int dx = center_x - 233;
        if (dx < -HT_TAB_PITCH) dx = -HT_TAB_PITCH;
        if (dx > HT_TAB_PITCH) dx = HT_TAB_PITCH;
        // Center the chosen name. Neighbors align toward the visible edge of
        // their own page so even a short name peeks in. Alignment moves smoothly
        // with the page and never crosses the 24 px gap between names.
        int x = center_x - cells * UI_FONT->width / 2 -
            dx * (width - cells * UI_FONT->width) / (2 * HT_TAB_PITCH);
        p = r->text;
        // The moving names stay inside a central, round-screen-safe viewport.
        // Discard whole cells at its edges; no framebuffer or scissor allocation.
        while (*p && x < 42) { ht_utf8_next(&p); x += UI_FONT->width; cells--; }
        memmove(r->text, p, strlen(p) + 1);
        int room = x >= 424 ? 0 : (424 - x) / UI_FONT->width;
        if (room < cells) cells = room;
        p = r->text;
        for (int n = 0; n < cells; n++) ht_utf8_next(&p);
        r->text[p - r->text] = 0;
        r->x = x; r->y = 233 - rows * UI_FONT->height / 2 + (i - first) * UI_FONT->height;
        r->w = cells * UI_FONT->width;
    }
}
static void render_tabs(ht_scene_t *f)
{
    ht_arc_title(f, DIM, "tabs");
    int current = ht_tab_carousel_index(&tab_carousel);
    if (current < 0) center(f, 214, "No tabs yet.", DIM);
    else {
        for (int i = current - 1; i <= current + 1; i++) {
            if (i < 0 || i >= s.tab_count) continue;
            int dx = i * HT_TAB_PITCH - tab_carousel.position;
            uint16_t ink = !s.connected ? DIM : !strcmp(s.tabs[i].id, s.selected_tab) ? ACCENT : FG;
            int fade = abs(dx) * 140 / HT_TAB_PITCH;
            ink = ht_character_caption_ink(ink, BG, fade < 210 ? 255 - fade : 45);
            tab_name(f, s.tabs[i].name, 233 + dx, ink);
        }
        // Each visible name owns its tap; a swipe from any page only browses.
        // Keep the centered page first for stable accessibility/test ordering.
        for (int n = 0; n < 3; n++) {
            int i = current + (n == 1 ? -1 : n == 2 ? 1 : 0);
            if (i < 0 || i >= s.tab_count) continue;
            int cx = 233 + i * HT_TAB_PITCH - tab_carousel.position;
            int left = i ? cx - HT_TAB_PITCH / 2 : 33;
            int right = i + 1 < s.tab_count ? cx + HT_TAB_PITCH / 2 : 433;
            if (left < 33) left = 33;
            if (right > 433) right = 433;
            if (right > left) s.hits[s.hit_count++] = (hit_t){{left, 110, right - left, 252},
                A_TAB, i, s.connected && !s.loading};
        }
    }
    ht_text(f, 223, 400, 20, &ht_nav_32, DIM, BG, "←");
    s.hits[s.hit_count++] = (hit_t){{83, 392, 300, 74}, A_HOME, 0, true};
}
static void render_notice(ht_scene_t *f)
{
    if (s.offset >= s.notice_count) s.offset = s.notice_count - 1;
    if (s.offset < 0) s.offset = 0;
    const cable_notif_t *n = &s.notice[s.offset];
    // Inbox is a text card, not another companion surface. Browsing never
    // changes desktop focus; a tap on the name/message opens that exact pane.
    int body = s.hit_count++;
    s.hits[body] = (hit_t){{33, 55, 400, 327}, A_NOTICE, s.offset, s.connected};
    uint16_t mark = color(n->question ? HT_THEME_QUESTION : n->failed ? HT_THEME_FAILED : HT_THEME_DONE);
    ht_inbox_card(f, n->question ? "?" : n->failed ? HT_FAILED : HT_DONE, n->name,
                  n->summary[0] ? n->summary : "No preview available.",
                  s.connected ? FG : DIM, s.connected ? mark : DIM);
    s.notice_frame = n->read_on_dial ? 0 : n->display_revision;
    s.hits[s.hit_count++] = (hit_t){{83, 392, 300, 74}, A_HOME, 0, true};
    ht_text(f, 223, 400, 20, &ht_nav_32,
        s.pressed == body + 1 ? FG : DIM, BG, "\xe2\x86\x90");
}
static void render_list(ht_scene_t *f)
{
    if (s.view == TABS) { render_tabs(f); return; }
    if (s.view == INBOX && s.notice_count) {
        render_notice(f);
        return;
    }
    const char *title = s.view == MACHINES ? "machines" : "inbox";
    heading(f, title);
    int count = s.view == MACHINES ? s.machine_count : s.notice_count;
    if (!count) {
        center(f, 198, s.view == INBOX ? "All caught up." : "Nothing here yet.", DIM);
    }
    for (int i = s.offset; i < count && i < s.offset + 3; i++) {
        char label[80], detail[80] = "";
        action_kind_t a;
        bool enabled = true;
        int y = 140 + (i - s.offset) * 76;
        if (s.view == MACHINES) {
            snprintf(label, sizeof(label), "@ %s", s.machines[i].name);
            COPY(detail, s.machines[i].state);
            a = A_MACHINE;
            enabled = s.connected && (!strcmp(s.machines[i].state, "ready") || s.machines[i].local);
        } else {
            snprintf(label, sizeof(label), "%s %s", s.notice[i].question ? "?" : "+",
                     s.notice[i].name);
            COPY(detail, s.notice[i].question ? "Needs your answer" : s.notice[i].summary);
            a = A_NOTICE;
        }
        control(f, 59, y, 348, label, a, i, enabled);
        // y + 42, not y + 31: a 38 px line starting at y ends at y + 38, so the old offset put the
        // detail three pixels inside the label above it.
        text(f, 71, y + 42, 324, detail, DIM);
    }
    page_controls(f, count);
}
static const char *voice_status(void)
{
    if (s.voice_start_pending) return "Starting";
    if (!audio_client_recording() || s.voice_waiting)
        return (s.voice_return == FORM || s.voice_search) ? "Finding" :
            question_view(s.voice_return) || s.voice_return == DRAFT || s.voice_review ? "Writing" : "";
    return s.voice_review_preview ? "Release to review" : "Listening";
}
static void render_voice(ht_scene_t *f)
{
    char draft_detail[64];
    snprintf(draft_detail, sizeof draft_detail, s.voice_draft_append ? "Add to your message" : "Replace part %d / %d",
        draft.page.position, draft.page.total);
    ht_character_face_t f_ = {.recipient = s.voice_target, .status = voice_status(),
        .hint = "",
        .mood = !s.voice_start_pending && !s.voice_waiting && audio_client_recording() ? HT_CHARACTER_LISTENING : HT_CHARACTER_WORKING,
        .pose = character.motion.reaction.pose, .ink = FG, .foreground = FG, .dim = DIM, .primary_title = true,
        .detail = s.voice_search ? "Say a phrase from the output" : s.voice_return == DRAFT ? draft_detail :
            question_view(s.voice_return) ? "Your answer" :
            s.voice_carry ? carry.excerpt : selection.active ? selection.excerpt : NULL,
        .carrying = s.voice_carry};
    f_.focus = f_.detail && *f_.detail;
    ht_character_face(f, &character, &f_, ACCENT, NULL);
    s.status_phase = status_animated() ? ht_shimmer_phase(ms() * status_speed()) : 0;
    for (int i = 0; i < f->count; i++)
        if (f->runs[i].arc == 2) f->runs[i].shimmer = s.status_phase;
    s.hits[s.hit_count++] = (hit_t){{33, 97, 400, 274}, A_PET, 0, true};
}
static void render_selection(ht_scene_t *f)
{
    heading(f, selection.query[0] ? "find in output" : "select text");
    agent_t *a = active();
    text(f, 71, 116, 324, selection.query[0] ? selection.query : a ? a->name : "Harness", DIM);
    if (carry.pending) {
        center(f, 207, "Picking up the text...", FG);
        center(f, 285, "Then choose who gets it", DIM);
        return;
    }
    if (selection.error[0]) {
        ht_wrap(f, 65, 180, 336, 5, 0, UI_FONT, FG, selection.error);
        control(f, 137, 349, 192, "[try again]", A_SELECT_BEGIN, 0, s.connected);
        return;
    }
    char status[64];
    snprintf(status, sizeof(status), "%s%d line%s", selection.pending ? "choosing / " : "", selection.rows,
             selection.rows == 1 ? "" : "s");
    if (selection.query[0]) {
        if (selection.matches) snprintf(status, sizeof status, "%d / %d matches", selection.match, selection.matches);
        else COPY(status, "No matches");
    }
    center(f, 167, (selection.rows || selection.query[0]) ? status : "Look at your desktop", FG);
    ht_wrap(f, 65, 203, 336, 3, 0, UI_FONT, FG,
            selection.excerpt[0] ? selection.excerpt : selection.pending ? "Finding the text..." : selection.query[0] ? "Try another phrase." : "Blank line");
    if (ht_selection_ready(&selection) && selection.excerpt[0]) {
        s.hits[s.hit_count++] = (hit_t){{53, 151, 360, 184}, A_PET, 0, true};
    }
    if (selection.query[0] && !selection.matches && !selection.pending) {
        control(f, 137, 349, 192, "[ find ]", A_SELECT_FIND, 0, ht_selection_ready(&selection));
        return;
    }
    control(f, 46, 332, 102, "[find]", A_SELECT_FIND, 0, ht_selection_ready(&selection));
    control(f, 165, 332, 119, selection.query[0] ? "[lines]" : selection.extending ? "[range]" : "[line]",
            A_SELECT_EXTEND, 0, ht_selection_ready(&selection) && selection.rows > 0);
    control(f, 301, 332, 119, "[carry]", A_CARRY, 0,
            ht_selection_ready(&selection) && selection.excerpt[0]);
    center(f, 395, selection.pending ? "choosing..." : "drag to read", DIM);
}
static void render_form(ht_scene_t *f)
{
    const ht_form_page_t *p = &form.page;
    bool finding = !strncmp(form.id, "find-", 5);
    center(f, 79, p->title[0] ? p->title : !strncmp(form.id, "find-", 5) ? "Find Harness" : "New Harness", DIM);
    char count[32]; snprintf(count, sizeof count, "%d / %d", p->position, p->total);
    if (p->query[0]) text(f, 95, 113, 276, p->query, DIM);
    else if (p->total) center(f, 113, count, DIM);
    text(f, 77, 158, 312, p->previous, DIM);
    ht_wrap(f, 65, 199, 336, 2, 0, UI_FONT, ACCENT,
            p->label[0] ? p->label : form.failed ? "Could not open" : "Opening...");
    if (!p->error[0]) ht_wrap(f, 65, 275, 336, 2, 0, UI_FONT, FG, p->busy ? p->status : p->detail);
    if (!form.pending && p->active && p->enabled && !p->busy && !form.failed)
        s.hits[s.hit_count++] = (hit_t){{49, 185, 368, 124}, A_FORM_MAIN, 0, true};
    // The current choice and its detail own the center; footer actions keep
    // a full line at the larger interface size. Errors replace the detail.
    if (p->error[0]) ht_wrap(f, 65, 275, 336, 2, 0, UI_FONT, ERROR, p->error);
    control(f, 60, 352, 102, "[back]", A_FORM_BACK, 0, !form.pending || finding);
    control(f, 173, 352, 85, "[say]", A_FORM_SAY, 0,
            !form.pending && !form.failed && p->active && p->can_query && !p->busy);
    char action[44];
    snprintf(action, sizeof action, "[%.23s]", form.failed ? "retry" : p->busy ? "wait" :
             form.pending && form.pending_op != HT_FORM_STATE ? "..." : !strcmp(p->action, "check status") ? "check" : p->action[0] ? p->action : "wait");
    control(f, 267, 352, 136, action, A_FORM_MAIN, 0,
            !form.pending && (form.failed || (p->active && p->enabled && !p->busy)));
}
// Keep the scroll limit and drawn rows identical at the 28 px text size.
#ifdef DEVICE_PRO_COMPANION
#define DRAFT_ROWS 6
#else
#define DRAFT_ROWS 3
#endif
static void render_draft(ht_scene_t *f)
{
    const ht_draft_page_t *p = &draft.page;
    control(f, 83, 67, 48, "<", A_DRAFT_OPTIONS, 0, !draft.pending);
    text(f, 137, 67, 264, p->name, FG);
    char position[48];
    snprintf(position, sizeof position, "draft / part %d of %d", p->position, p->total);
    center(f, 111, position, DIM);
    int rows = question_rows(p->text), last = rows > DRAFT_ROWS ? rows - DRAFT_ROWS : 0;
    if (s.offset > last) s.offset = last;
    ht_wrap(f, 59, 153, 348, DRAFT_ROWS, s.offset, UI_FONT, FG, p->text);
    if (rows > DRAFT_ROWS) snprintf(position, sizeof position, "%d-%d / %d  drag to read", s.offset+1, s.offset+DRAFT_ROWS, rows);
    else COPY(position, p->total > 1 ? "drag for other parts" : p->context);
    text(f, 71, 297, 324, position, DIM);
    if (p->error[0]) ht_wrap(f, 65, 326, 336, 2, 0, &ht_mono_20, ERROR, p->error);
    else if (!p->can_send) ht_wrap(f, 65, 326, 336, 2, 0, &ht_mono_20, DIM,
        "Some characters cannot display. Re-speak that part.");
    else center(f, 333, draft.pending ? (draft.op == HT_DRAFT_SEND ? "Sending..." : "One moment...") :
        "tap to re-speak part", DIM);
    bool editable = !draft.pending && !draft.failed && !p->locked;
    s.hits[s.hit_count++] = (hit_t){{49, 139, 368, 151}, A_DRAFT_EDIT, 0, editable};
    control(f, 83, 370, 156, p->locked ? "[close]" : "[discard]", A_DRAFT_DISCARD, 0, !draft.pending);
    bool checking = draft.failed || p->locked;
    control(f, 281, 370, 120, checking ? "[check]" : "[send]",
        checking ? A_DRAFT_STATE : A_DRAFT_SEND, 0, !draft.pending && (checking || p->can_send));
}
static void render_draft_options(ht_scene_t *f)
{
    center(f, 83, "Your draft", FG);
    text(f, 77, 118, 312, draft.page.context, DIM);
    bool editable = !draft.pending && !draft.failed && !draft.page.locked;
    control(f, 65, 167, 336, "Add to message", A_DRAFT_APPEND, 0, editable);
    control(f, 65, 245, 336, "Undo last edit", A_DRAFT_UNDO, 0, editable && draft.page.can_undo);
    control(f, 65, 323, 336, "Back to draft", A_DRAFT_BACK, 0, true);
    center(f, 380, draft.page.locked ? "Check terminal" : "Nothing sent yet", DIM);
}
static void render_settings(ht_scene_t *f)
{
    heading(f, "controls");
    int last = settings_count() - TAB_ROWS;
    if (last < 0) last = 0;
    if (s.offset > last) s.offset = last;
    if (s.offset < 0) s.offset = 0;
    for (int row = 0; row < TAB_ROWS; row++) {
        action_kind_t action;
        const char *label = settings_item(s.offset + row, &action);
        if (!label) break;
        char dynamic[48];
        if (action == A_BRIGHT) {
            snprintf(dynamic, sizeof dynamic, "Brightness  %d%%", s.brightness);
            label = dynamic;
        } else if (action == A_MUTE) label = s.muted ? "Sound muted" : "Sound on";
        bool enabled = action == A_INBOX || action == A_BRIGHT || action == A_MUTE || action == A_COMPANION ||
            (s.connected && ((action != A_STOP && action != A_MODELS && action != A_SELECT_BEGIN && action != A_LATEST) ||
                (active() && (action != A_STOP || active()->busy) && (action != A_LATEST || !visit.pending))));
        int y = TAB_TOP + row * TAB_ROW_HEIGHT, hit = s.hit_count++;
        s.hits[hit] = (hit_t){{59, y, 348, TAB_ROW_HEIGHT}, action, 0, enabled};
        ht_text(f, 83, y + 14, 300, UI_FONT,
            !enabled ? DIM : hit == s.pressed ? ACCENT : FG, hit == s.pressed ? SEL : BG, label);
    }
}
static void render_lock(ht_scene_t *f)
{
#ifdef DEVICE_PRO_COMPANION
    ht_pro_center(f, 56, &ht_pro_42, FG, PRO_TR("A quiet moment."));
    ht_pro_center(f, 126, &ht_pro_24, DIM, PRO_TR("Draw your pattern to return."));
    for (int i = 0; i < 9; i++) {
        int x = HT_PATTERN_X + (i % 3) * HT_PATTERN_STEP_X;
        int y = HT_PATTERN_Y + (i / 3) * HT_PATTERN_STEP_Y;
        bool selected = s.pattern_mask & (1 << i);
        ht_pro_rect(f, x - 24, y - 24, 48, 48, 24, selected ? ACCENT : SEL);
        ht_pro_rect(f, x - 7, y - 7, 14, 14, 7, selected ? color(0xfffdf5) : DIM);
    }
    ht_pro_center(f, 668, &ht_pro_24, s.pattern_error ? ERROR : DIM,
                  s.pattern_error ? PRO_TR("That pattern didn't match. Try again.") : PRO_TR("Your companion is locked."));
#else
    center(f, 89, "Draw your pattern", FG);
    for (int i = 0; i < 9; i++) {
        int x = 137 + (i % 3) * 80, y = 156 + (i / 3) * 74;
        ht_text(f, x, y, 40, &ht_lock_dot, s.pattern_mask & (1 << i) ? ACCENT : DIM, BG, "o");
    }
    center(f, 386, s.pattern_error ? "Try again" : "Locked", DIM);
#endif
}
#ifdef DEVICE_PRO_COMPANION
#include "pro_controls.inc"
#include "pro_home.inc"
#endif
bool habitat_scene_take(ht_scene_t *f)
{
#ifdef DEVICE_CREATURE_GALLERY
    // App snapshots never choose a scene in this visual-only build.
    if (!s.ready) return false;
    return ht_gallery_take(&gallery, f, ms());
#endif
    if (!s.ready || !s.dirty || s.bulk)
        return false;
    s.dirty = false;
    s.notice_frame = 0;
    s.hit_count = 0;
    ht_scene_clear(f, BG);
    if (s.locked) {
        render_lock(f);
        return true;
    }
#ifdef DEVICE_PRO_COMPANION
    if (s.view == HOME || s.view == AGENT) { pro_render_home(f); return true; }
    if (s.view == VOICE) { pro_render_voice(f); return true; }
    if (pro_render_controls(f)) return true;
#endif
    switch (s.view) {
#ifdef DEVICE_PRO_COMPANION
    case LAUNCHER:
    case WORK_INTENT:
    case TODAY:
    case CARRY_PREVIEW:
    case DAEMONS:
    case SCENES:
    case VOICE_SAMPLES:
    case VOICE_PARAMS:
    case LANGUAGE:
        break; // Handled by the Pro controls sheet above.
#endif
    case FORM:
        render_form(f);
        break;
    case DRAFT:
        render_draft(f);
        break;
    case DRAFT_OPTIONS:
        render_draft_options(f);
        break;
    case HOME:
        render_home(f);
        break;
    case AGENTS:
        render_agents(f);
        break;
    case AGENT:
        render_agent(f);
        break;
    case QUESTION:
        render_question(f);
        break;
    case CHOICE:
        render_choices(f);
        break;
    case ANSWER_REVIEW:
        render_answer_review(f);
        break;
    case TABS:
    case MACHINES:
    case INBOX:
        render_list(f);
        break;
    case VOICE:
        render_voice(f);
        break;
    case SELECTION:
        render_selection(f);
        break;
    case SETTINGS:
        render_settings(f);
        break;
    case READER: {
        agent_t *a = active();
        heading(f, "latest result");
        if (a)
            ht_wrap(f, 59, 125, 348, 5, s.offset, UI_FONT, FG, a->full);
        control(f, 119, 387, 72, "<", A_UP, 0, s.offset > 0);
        control(f, 205, 366, 153, "[desktop]", A_DESKTOP, 0, s.connected);
        break;
    }
    case COMPANION:
        render_companion(f);
        break;
    case STOP:
        heading(f, "stop this turn?");
        center(f, 185, "Your work stays.", FG);
        center(f, 227, "This turn stops.", DIM);
        control(f, 83, 355, 156, "[cancel]", A_HOME, 0, true);
        control(f, 263, 355, 120, "[stop]", A_STOP_YES, 0, s.connected);
        break;
    case MODELS:
        heading(f, "model");
        if (s.model_count < 0)
            center(f, 211, "Loading models...", DIM);
        else if (!s.model_count)
            center(f, 211, "No models available.", DIM);
        else
            for (int i = s.offset; i < s.model_count && i < s.offset + 3; i++) {
                const char *label = strrchr(s.models[i].id, ':');
                control(f, 59, 153 + (i - s.offset) * 72, 348, label ? label + 1 : s.models[i].id,
                        A_MODEL, i, s.connected);
            }
        page_controls(f, s.model_count);
        break;
    case OTA:
        render_brand(f);
        break;
    case MESSAGE:
        heading(f, s.title);
        ht_wrap(f, 65, 161, 336, 5, 0, UI_FONT, FG, s.message);
        break;
    }
    return true;
}

static bool queue(action_t a)
{
#ifdef DEVICE_CREATURE_GALLERY
    (void)a;
    return false; // Never enqueue a desktop or audio action in the visual study.
#endif
    // Background read receipts must never occupy the last touch/audio slot or
    // replace the screen with a cable-busy warning. Retry quietly next tick.
    if (a.kind == A_NOTICE_READ)
        return actions && uxQueueSpacesAvailable(actions) > 1 && xQueueSend(actions, &a, 0) == pdPASS;
    // A live scroll owns the final slot, so a stalled USB writer cannot drop its UP.
    if (actions && ((!scroll.live && !selection.active && !visit.id[0]) || uxQueueSpacesAvailable(actions) > 1) &&
        xQueueSend(actions, &a, 0) == pdPASS)
        return true;
    COPY(s.title, "One moment");
    COPY(s.message, "The cable is busy. Try again.");
    view(MESSAGE);
    return false;
}
static bool scroll_emit(ht_scroll_phase_t phase, int dy, int velocity, void *ctx)
{
    (void)ctx;
    action_t a = {.kind = A_SCROLL, .value = (int)phase, .dy = dy, .velocity = velocity};
    unsigned required = phase == HT_SCROLL_UP ? 1 : 2;
    if (!actions || uxQueueSpacesAvailable(actions) < required) return false;
    bool ok = xQueueSend(actions, &a, 0) == pdPASS;
    // Every producer holds display_lock. DOWN/MOVE and other actions reserve this slot.
    if (phase == HT_SCROLL_UP) assert(ok);
    return ok;
}
static bool form_emit(const ht_form_command_t *c, void *ctx)
{
    (void)ctx;
    if (!actions || uxQueueSpacesAvailable(actions) < 2) return false;
    action_t a = {.kind = A_FORM_SEND, .value = c->op, .revision = c->request,
                  .dy = (int)c->revision, .velocity = c->delta};
    COPY(a.id, c->id);
    return xQueueSend(actions, &a, 0) == pdPASS;
}
static bool draft_emit(const ht_draft_command_t *c, void *ctx)
{
    (void)ctx;
    if (!actions || uxQueueSpacesAvailable(actions) < 2) return false;
    action_t a = {.kind = A_DRAFT_COMMAND, .value = c->op, .revision = c->request,
        .dy = (int)c->revision, .velocity = c->delta};
    COPY(a.id, c->id);
#ifdef DEVICE_PRO_COMPANION
    if (c->op == HT_DRAFT_SEND && !pro_work_draft_available()) return false;
    if (draft.read_only) {
        if (!s.connected || !cable_client_supports(CABLE_FEATURE_DRAFT) ||
            !pro_draft_recovery_same_host(&s.draft_recovery) ||
            (c->op != HT_DRAFT_STATE && c->op != HT_DRAFT_MOVE) ||
            (c->op == HT_DRAFT_MOVE && !s.draft_recovery.ready)) return false;
        s.draft_recovery.request_generation = s.draft_recovery.generation;
        copy(a.text, sizeof s.draft_recovery.original_host, s.draft_recovery.original_host);
    }
#endif
    return xQueueSend(actions, &a, 0) == pdPASS;
}
#ifdef DEVICE_PRO_COMPANION
static void pro_draft_forget(void)
{
    if (s.send_feedback.accepted && pro_send_feedback_matches()) {
        s.send_feedback.until = ms() + 3000;
        if (!s.send_feedback.until) s.send_feedback.until = 1;
    } else pro_send_feedback_clear();
    if (pro_carry_review_owns(&s.carry_review, &draft.page)) {
        if (!strcmp(s.carry_review.id, carry.id)) ht_carry_close(&carry);
        memset(&s.carry_review, 0, sizeof s.carry_review);
    }
    ht_draft_reset(&draft); pro_draft_recovery_close(&s.draft_recovery); view(HOME);
}
static bool pro_draft_store_queue(bool clear)
{
    pro_draft_recovery_t *r = &s.draft_recovery;
    if (r->store == PRO_RECOVERY_CLEARING) return false;
    if (!clear && r->store != PRO_RECOVERY_NONE) return false;
    if (clear) {
        ht_draft_detach(&draft); pro_draft_recovery_advance(r);
        if (pro_carry_review_owns(&s.carry_review, &draft.page)) s.carry_review.detached = true;
    }
    if (!++r->bookmark_generation) ++r->bookmark_generation;
    action_t a = {.kind = A_DRAFT_STORE, .value = clear, .revision = r->bookmark_generation};
    COPY(a.id, draft.page.id);
    r->store = clear ? PRO_RECOVERY_CLEARING : PRO_RECOVERY_SAVING;
    if (actions && uxQueueSpacesAvailable(actions) >= 2 && xQueueSend(actions, &a, 0) == pdPASS) {
        change(); return true;
    }
    r->store = clear ? PRO_RECOVERY_CLEAR_FAILED : PRO_RECOVERY_SAVE_FAILED;
    snprintf(draft.page.error, sizeof draft.page.error, "%s",
        clear ? "Couldn't clear recovery. Try Close again." : "Recovery unavailable after power loss.");
    change(); return false;
}
static void pro_draft_store_work(action_t a)
{
    pro_recovery_bookmark_t bookmark = {0};
    display_lock();
    pro_draft_recovery_t *r = &s.draft_recovery;
    bool current = draft.page.active && !strcmp(a.id, draft.page.id) && a.revision == r->bookmark_generation &&
        r->store == (a.value ? PRO_RECOVERY_CLEARING : PRO_RECOVERY_SAVING);
    if (current && !a.value) {
        bookmark.magic = 0x48524431u; bookmark.schema = 1; bookmark.mode = r->mode;
        bookmark.carried = r->carried; bookmark.revision = draft.page.revision;
        COPY(bookmark.id, draft.page.id); COPY(bookmark.agent, r->recipient); COPY(bookmark.host, r->original_host);
        COPY(bookmark.name, pro_carry_review_owns(&s.carry_review, &draft.page) ? s.carry_review.name : draft.page.name);
        bookmark.checksum = pro_recovery_checksum(&bookmark);
    }
    display_unlock();
    if (!current) return;
    // Only this FIFO worker writes the bookmark. Close stays visible until its
    // erase commits; an obsolete save cannot reappear after a successful Close.
    bool ok = a.value ? config_clear_pro_recovery() : config_save_pro_recovery(&bookmark);
    display_lock();
    current = draft.page.active && !strcmp(a.id, draft.page.id) && a.revision == r->bookmark_generation &&
        r->store == (a.value ? PRO_RECOVERY_CLEARING : PRO_RECOVERY_SAVING);
    if (current) {
        if (ok && a.value) pro_draft_forget();
        else {
            r->store = ok ? PRO_RECOVERY_SAVED : a.value ? PRO_RECOVERY_CLEAR_FAILED : PRO_RECOVERY_SAVE_FAILED;
            if (!ok) snprintf(draft.page.error, sizeof draft.page.error, "%s",
                a.value ? "Couldn't clear recovery. Try Close again." : "Recovery unavailable after power loss.");
            input_cancel(); change();
        }
    }
    display_unlock();
}
static void pro_draft_restore(void)
{
    pro_recovery_bookmark_t b;
    if (!config_load_pro_recovery(&b)) return;
    ht_draft_page_t page = {.active = true, .locked = true, .revision = b.revision};
    COPY(page.id, b.id); COPY(page.agent, b.agent); COPY(page.name, b.name);
    ht_draft_open(&draft, &page, draft_emit, NULL); ht_draft_detach(&draft);
    pro_draft_recovery_t *r = &s.draft_recovery;
    COPY(r->original_host, b.host); COPY(r->recipient, b.agent); r->mode = b.mode; r->carried = b.carried;
    r->store = PRO_RECOVERY_SAVED; r->has_words = false;
    if (!++r->bookmark_generation) ++r->bookmark_generation;
    pro_draft_recovery_advance(r); s.view = DRAFT;
}
#endif
static bool visit_emit(const ht_visit_command_t *c, void *ctx)
{
    (void)ctx;
    if (!actions || uxQueueSpacesAvailable(actions) < (c->op == HT_VISIT_CANCEL ? 1 : 2)) return false;
    action_t a = {.kind = A_VISIT_SEND, .value = c->op, .revision = c->request};
    COPY(a.id, c->agent); COPY(a.text, c->id);
#ifdef DEVICE_PRO_COMPANION
    if (c->op==HT_VISIT_LATEST && s.view==READER) {
        _Static_assert(sizeof visit.id+sizeof s.reader.host<=sizeof a.text,"Reader visit owner fits queued text");
        a.reader_serial=s.reader.serial;
        a.dy=(int)s.reader.source_generation; a.velocity=(int)s.reader_focus_generation;
        copy(a.text+sizeof visit.id,sizeof s.reader.host,s.reader.host);
    }
#endif
    return xQueueSend(actions, &a, 0) == pdPASS;
}
static bool selection_emit(const ht_select_command_t *c, void *ctx)
{
    (void)ctx;
    // Selection keeps a slot for cancellation, just as scrolling keeps one for UP.
    if (!actions || uxQueueSpacesAvailable(actions) < (c->op == HT_SELECT_CANCEL ? 1 : 2)) return false;
    action_t a = {.kind = A_SELECT_SEND, .value = c->op, .revision = c->revision,
                  .dy = c->delta, .velocity = (int)c->request};
    COPY(a.id, c->agent); COPY(a.text, c->id);
    return xQueueSend(actions, &a, 0) == pdPASS;
}
static bool carry_emit(const ht_carry_command_t *c, void *ctx)
{
    (void)ctx;
    if (!actions || uxQueueSpacesAvailable(actions) < (c->cancel ? 1 : 2)) return false;
    action_t a = {.kind=A_CARRY_SEND,.value=c->cancel,.revision=c->revision,.dy=(int)c->request};
    COPY(a.id,c->agent); copy(a.text,48,c->id); copy(a.text+48,48,c->selection);
    return xQueueSend(actions,&a,0)==pdPASS;
}
static action_t make_action(hit_t h)
{
    action_t a = {.kind = h.action, .value = h.value, .revision = s.q.revision};
#ifdef DEVICE_PRO_COMPANION
    if (h.action == A_WORK_MODE || h.action == A_WORK_RECORD) {
        COPY(a.id, s.work_agent); a.revision = s.work_revision;
        return a;
    }
    if (s.view==INBOX && h.action==A_READER && h.value==1 && s.offset>=0 && s.offset<s.notice_count) {
        COPY(a.id,s.notice[s.offset].agent_id);
        copy(a.text,sizeof s.notice_host,s.notice_host);
        a.dy=(int)s.result_generation;
        a.revision=s.notice[s.offset].display_revision;
        return a;
    }
    if (h.action==A_READER) {
        if (active()) COPY(a.id,active()->id);
        copy(a.text,sizeof s.notice_host,s.notice_host);
        a.dy=(int)s.result_generation;
        return a;
    }
    if (s.view == INBOX && (h.action == A_NOTICE || h.action == A_QUESTION) &&
        h.value >= 0 && h.value < s.notice_count) {
        COPY(a.id, s.notice[h.value].agent_id);
        a.revision = s.notice[h.value].display_revision;
        return a;
    }
    if (s.view == INBOX && h.action == A_QUESTION && h.value == -1 && s.q.pending) {
        COPY(a.id,s.q.agent);
        return a;
    }
    if (s.view == READER) {
        COPY(a.id, s.reader_agent);
        a.revision=s.reader.serial;
        if (h.action==A_LATEST) {
            a.reader_serial=s.reader.serial;
            copy(a.text,sizeof s.reader.host,s.reader.host);
            a.dy=(int)s.reader.source_generation; a.velocity=(int)s.reader_focus_generation;
        }
        if (h.action==A_UP || h.action==A_DOWN) a.value=1;
        return a;
    }
    if (s.view == SELECTION && h.action == A_SELECT_BEGIN) {
        COPY(a.id, selection.agent);
        copy(a.text, sizeof selection.id, selection.id);
        a.dy = (int)selection.revision;
        return a;
    }
#endif
    if (s.view == DRAFT || s.view == DRAFT_OPTIONS
#ifdef DEVICE_PRO_COMPANION
        || s.view == CARRY_PREVIEW
#endif
        ) {
        a.revision = draft.page.revision; a.dy = (int)draft.page.revision;
        copy(a.text, sizeof draft.page.id, draft.page.id);
#ifdef DEVICE_PRO_COMPANION
        a.velocity = (int)s.draft_recovery.generation;
#endif
    } else if (h.action == A_FORM_MAIN || h.action == A_FORM_BACK || h.action == A_FORM_SAY) {
        a.revision = form.page.revision;
        a.dy = (int)form.page.revision;
        copy(a.text, sizeof form.id, form.id);
    } else if (s.view == SELECTION && (h.action == A_PET || h.action == A_CARRY || h.action == A_SELECT_FIND)) {
        COPY(a.id, selection.agent);
        copy(a.text, sizeof selection.id, selection.id);
        a.dy = (int)selection.revision;
    } else if ((s.view == HOME || s.view == AGENT) && h.action == A_PET && carry.active) {
        if (active()) COPY(a.id,active()->id);
        copy(a.text,sizeof carry.id,carry.id); a.value=3;
    } else if (h.action == A_RETURN) {
        copy(a.text,sizeof visit.id,visit.id); a.revision=visit.request;
    } else if (h.action == A_CARRY_DROP) {
        copy(a.text,sizeof carry.id,carry.id); a.revision=carry.serial;
    } else if (h.action == A_AGENT && h.value < s.count)
        COPY(a.id, s.agents[h.value].id);
    else if (h.action == A_NOTICE && h.value < s.notice_count)
        COPY(a.id, s.notice[h.value].agent_id);
    else if (h.action == A_TAB && h.value < s.tab_count)
        COPY(a.id, s.tabs[h.value].id);
    else if (h.action == A_MACHINE && h.value < s.machine_count)
        COPY(a.id, s.machines[h.value].id);
    else if (h.action == A_MODEL && h.value < s.model_count) {
        COPY(a.id, s.model_agent);
        COPY(a.text, s.models[h.value].id);
    } else if (question_view(s.view)
#ifndef DEVICE_PRO_COMPANION
               && h.action != A_HOME
#endif
               ) {
        COPY(a.id,s.q.agent); a.dy=s.q.index;
    } else if (h.action == A_DESKTOP && h.value == 1)
        COPY(a.id, s.q.agent);
    else if (active())
        COPY(a.id, active()->id);
    return a;
}
static void read_question(const char *id, const char *label)
{
    if (!s.connected || !id || !*id || !cable_client_supports(CABLE_FEATURE_QUESTIONS)) return;
#ifdef DEVICE_PRO_COMPANION
    // A lost receipt is not permission to send another answer or replace its
    // correlation token. The matching receipt/close event can still settle it.
    if (s.q.pending) {
        if (!strcmp(id, s.q.agent)) view(QUESTION);
        return;
    }
#endif
    char agent[ID_MAX], name[64]; COPY(agent,id); COPY(name,label ? label : "");
    uint32_t revision = s.q.revision + 1;
    memset(&s.q,0,sizeof s.q); s.q.revision=revision; s.q.loading=true;
    COPY(s.q.agent,agent); COPY(s.q.name,name);
#ifdef DEVICE_PRO_COMPANION
    COPY(s.q.host,s.notice_host);
    for (int i=0; i<s.notice_count; i++) if (s.notice[i].question && !strcmp(s.notice[i].agent_id,agent)) {
        COPY(s.q.request,s.notice[i].question_id); s.q.signature=s.notice[i].question_signature;
        COPY(s.q.notice_token,s.notice[i].read_token);
        break;
    }
#endif
    snprintf(s.q.fetch,sizeof s.q.fetch,"q-%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
    s.q.deadline=ms()+4000;
    action_t a={.kind=A_QUESTION_READ,.revision=revision}; COPY(a.id,agent); copy(a.text,sizeof s.q.fetch,s.q.fetch);
    if (!queue(a)) { s.q.loading=false; COPY(s.q.error,"Could not load. Open the alert again."); }
    view(QUESTION);
}
static void open_question(void)
{
    if (!s.connected || !active()) return;
    if (!cable_client_supports(CABLE_FEATURE_QUESTIONS)) {
        action_t open={.kind=A_DESKTOP}; COPY(open.id,active()->id);
        queue(open);
        return;
    }
    read_question(active()->id, active()->name);
}
#ifdef DEVICE_PRO_COMPANION
static void pro_open_in_app(const char *agent)
{
    if (!s.connected || s.voice_open || s.loading || visit.pending || !agent || !*agent) return;
    if (!cable_client_supports(CABLE_FEATURE_VISIT)) {
        action_t open = {.kind=A_DESKTOP}; COPY(open.id,agent);
        if (queue(open)) {
            // An older host can open the pane but cannot promise a saved place.
            ht_visit_close(&visit);
            COPY(s.opening_notice,agent);
        } else {
            COPY(s.title,"Device busy"); COPY(s.message,"Open the update again."); view(MESSAGE);
        }
        return;
    }
    char id[48];
    if (visit.available) COPY(id,visit.id);
    else snprintf(id,sizeof id,"visit-%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
    if (!ht_visit_open(&visit,id,agent,ms(),visit_emit,NULL)) {
        COPY(s.title,"Visit"); COPY(s.message,"The cable is busy. Try again."); view(MESSAGE);
        return;
    }
    COPY(s.title,"On your desktop"); COPY(s.message,"Keeping your reading place..."); view(MESSAGE);
}
#endif
static bool question_answer(void)
{
    question_item_t *q=&s.q.item[s.q.index];
    if (!s.q.supported) return false;
    if (q->draft[0]) return q->can_text && q->answer[0];
    if (!q->selected) return false;
    q->answer[0]=0; size_t used=0;
    for (int i=0;i<q->count;i++) if (q->selected & (1u<<i)) {
        int n=snprintf(q->answer+used,sizeof q->answer-used,"%s%s",used ? "\n\n" : "",q->options[i]);
        if (n<0 || (size_t)n>=sizeof q->answer-used) return false;
        used+=(size_t)n;
    }
    return used>0;
}
static void question_move(int delta)
{
    bool retained = false;
#ifdef DEVICE_PRO_COMPANION
    retained = s.q.pending && s.q.uncertain && s.q.count > 0 && s.q.index >= 0 && s.q.index < s.q.count;
#endif
    if (!question_view(s.view) || s.q.loading ||
        (!retained && (!s.q.valid || !s.q.supported || s.q.pending || s.q.error[0]))) return;
    s.q.drag+=delta;
    while (s.q.drag>=40 || s.q.drag<=-40) {
        int step=s.q.drag>0 ? 1 : -1; s.q.drag-=step*40;
        question_item_t *q=&s.q.item[s.q.index];
        const char *value=retained ? q->answer : s.view==QUESTION ? q->prompt : s.view==CHOICE ? q->options[s.q.choice] : q->answer;
        int last=question_rows(value)-Q_ROWS; if (last<0) last=0;
        if (step>0 && s.offset<last) s.offset++;
        else if (step<0 && s.offset>0) s.offset--;
        else if (retained && s.q.index+step>=0 && s.q.index+step<s.q.count) {
            // The submitted packet is immutable. Only the local reading position
            // changes, including when its answer receipt was lost offline.
            s.q.index+=step; s.offset=step>0 ? 0 : question_rows(s.q.item[s.q.index].answer)-Q_ROWS;
            if (s.offset<0) s.offset=0;
        } else if (!retained && s.view==CHOICE && s.q.choice+step>=0 && s.q.choice+step<q->count) {
            s.q.choice+=step; s.offset=step>0 ? 0 : question_rows(q->options[s.q.choice])-Q_ROWS;
            if (s.offset<0) s.offset=0;
        }
        change();
    }
}
#ifdef DEVICE_PRO_COMPANION
static void pro_question_back(action_t a)
{
    if (!question_view(s.view) || a.revision != s.q.revision || a.dy != s.q.index ||
        strcmp(a.id, s.q.agent) || !s.q.valid || !s.q.supported || s.q.loading ||
        s.q.pending || s.q.error[0] || s.q.index < 0 || s.q.index >= s.q.count) return;
    if (s.view == QUESTION) {
        if (!s.q.index) { view(HOME); return; }
        // This is local review of the same packet, never a fresh read. Keep
        // every answer, the recipient and the host's submission token intact.
        question_item_t *q = &s.q.item[--s.q.index];
        s.q.choice = 0;
        if (q->selected) for (int i = 0; i < q->count; i++)
            if (q->selected & (1u << i)) { s.q.choice = i; break; }
        s.q.speech_error[0] = 0;
        view(q->answer[0] ? ANSWER_REVIEW : QUESTION);
    } else {
        view(s.view == ANSWER_REVIEW && !s.q.item[s.q.index].draft[0] ? CHOICE : QUESTION);
    }
}
#endif
static void send_answer(void)
{
    if (!s.connected || s.view!=ANSWER_REVIEW || !s.q.valid || s.q.pending ||
        !s.q.supported || !s.q.token[0] || !question_answer()) return;
    if (s.q.index+1<s.q.count) { s.q.index++; s.q.choice=0; view(QUESTION); return; }
    for (int i=0;i<s.q.count;i++) if (!s.q.item[i].selected && !s.q.item[i].draft[0]) return;
    action_t a={.kind=A_ANSWER,.revision=s.q.revision}; COPY(a.id,s.q.agent);
    if (queue(a)) { s.q.pending=true; s.q.deadline=ms()+15000; change(); }
}
static void draft_move(int delta, uint32_t now)
{
    if (s.view != DRAFT || draft.pending) return;
    bool read_only = draft.failed || draft.page.locked;
#ifdef DEVICE_PRO_COMPANION
    if (read_only && !draft.read_only && !pro_carry_review_owns(&s.carry_review, &draft.page)) return;
#else
    if (read_only) return;
#endif
    s.draft_drag += delta;
    while (s.draft_drag >= 40 || s.draft_drag <= -40) {
        int step = s.draft_drag > 0 ? 1 : -1;
        s.draft_drag -= step * 40;
        int last = question_rows(draft.page.text) - DRAFT_ROWS;
        if (last < 0) last = 0;
        if (step > 0 && s.offset < last) s.offset++;
        else if (step < 0 && s.offset > 0) s.offset--;
        else if ((!read_only
#ifdef DEVICE_PRO_COMPANION
                  || (draft.read_only && s.draft_recovery.ready)
#endif
                 ) && ((step > 0 && draft.page.position < draft.page.total) || (step < 0 && draft.page.position > 1))) {
            ht_draft_command(&draft, HT_DRAFT_MOVE, draft.page.revision, step, now);
            s.draft_drag = 0; change(); return;
        }
        change();
    }
}
static void dispatch(action_t a)
{
#ifdef DEVICE_CREATURE_GALLERY
    (void)a;
    return; // Defense in depth: no voice, commands, approvals, or pane navigation.
#endif
    if (s.locked)
        return;
    switch (a.kind) {
#ifdef DEVICE_PRO_COMPANION
    case A_LAUNCHER:
        view(LAUNCHER);
        break;
    case A_TODAY:
    case A_TODAY_REFRESH: {
        if (!s.connected || !s.metrics.supported || !cable_client_supports(CABLE_FEATURE_METRICS) ||
            (a.kind==A_TODAY_REFRESH && s.view!=TODAY)) break;
        view(TODAY);
        if (s.view!=TODAY || !pro_metrics_begin(&s.metrics,ms(),esp_random(),esp_random())) break;
        action_t request={.kind=A_METRICS_GET,.revision=s.metrics.serial};
        COPY(request.id,s.metrics.request); COPY(request.text,s.metrics.machine);
        if (!queue(request)) { s.metrics.phase=PRO_METRICS_ERROR; s.metrics.request[0]=0; }
        change(); break;
    }
    case A_METRICS_GET:
    case A_DRAFT_STORE:
        break; // Worker-only, never a touch target.
    case A_WORK_INTENT:
        if (!s.connected || s.loading || !active() || s.voice_open || carry.active || carry.error[0]) break;
        COPY(s.work_agent, active()->id);
        COPY(s.work_host, s.draft_recovery.current_host);
        s.work_generation = s.draft_recovery.generation;
        s.work_mode = PRO_WORK_TASK;
        s.work_revision++;
        view(WORK_INTENT);
        break;
    case A_WORK_MODE:
    case A_WORK_RECORD: {
        if (s.view != WORK_INTENT || !s.connected || s.loading || s.voice_open ||
            a.revision != s.work_revision || strcmp(a.id, s.work_agent)) break;
        int recipient = find(s.work_agent);
        if (recipient < 0) break;
        int mode = a.kind == A_WORK_MODE ? a.value : s.work_mode;
        if (!pro_work_visible(&s.agents[recipient], mode) ||
            (mode != PRO_WORK_TASK && (s.work_generation != s.draft_recovery.generation ||
                                      strcmp(s.work_host, s.draft_recovery.current_host)))) break;
        if (a.kind == A_WORK_MODE) { s.work_mode = (uint8_t)mode; change(); break; }
        if (!pro_work_available(&s.agents[recipient], mode)) { change(); break; }
        a.kind = A_VOICE; a.value = pro_work_voice_value(mode);
        a.text[0] = 0; a.dy = 0;
        ht_gesture_guard(&gesture, ms());
        dispatch(a);
        break;
    }
    case A_LANGUAGE:
        view(LANGUAGE);
        break;
    case A_LANGUAGE_SET:
        if (s.view != LANGUAGE || s.language_saving || (a.value != 0 && a.value != 1)) break;
        if (!strcmp(s.voice_language, a.value ? "vi" : "en") && !s.language_error) break;
        s.language_saving = queue(a);
        s.language_error = !s.language_saving;
        change();
        break;
    case A_VOICE_SAMPLES:
        if (!s.sample_volume_set) { s.sample_volume = 80; s.sample_volume_set = true; }
        view(VOICE_SAMPLES);
        break;
    case A_SAMPLE_PARAMS:
        if (s.view == VOICE_SAMPLES) view(VOICE_PARAMS);
        break;
    case A_SAMPLE_PREVIOUS:
    case A_SAMPLE_NEXT:
        if (s.view != VOICE_SAMPLES) break;
        pro_voice_sample_stop();
        if (a.kind == A_SAMPLE_NEXT && s.voice_sample + 1 < pro_voice_sample_count()) s.voice_sample++;
        if (a.kind == A_SAMPLE_PREVIOUS && s.voice_sample) s.voice_sample--;
        change();
        break;
    case A_SAMPLE_PLAY: {
        if (s.view != VOICE_SAMPLES) break;
        pro_voice_progress_t progress = pro_voice_sample_progress();
        if (progress.phase == PRO_VOICE_STARTING || progress.phase == PRO_VOICE_PLAYING) pro_voice_sample_stop();
        else pro_voice_sample_play(s.voice_sample, s.sample_volume, ms());
        s.sample_poll_due = ms();
        change();
        break;
    }
    case A_SAMPLE_VOLUME: {
        if (s.view != VOICE_SAMPLES || (a.value != -10 && a.value != 10)) break;
        int volume = (int)s.sample_volume + a.value;
        if (volume < 0) volume = 0;
        if (volume > 100) volume = 100;
        s.sample_volume = (uint8_t)volume;
        s.sample_volume_set = true;
        // Applies on the codec worker's next block, without restarting the clip.
        pro_voice_sample_volume(s.sample_volume);
        s.sample_poll_due = ms();
        change();
        break;
    }
    case A_DAEMONS:
        pro_appearance_open(DAEMONS);
        break;
    case A_SCENES:
        pro_appearance_open(SCENES);
        break;
    case A_APPEAR_PREVIOUS:
        pro_appearance_move(-1);
        break;
    case A_APPEAR_NEXT:
        pro_appearance_move(1);
        break;
    case A_APPEAR_USE:
        pro_appearance_use();
        break;
    case A_APPEAR_SAVE:
        break; // Worker-only persistence, never emitted by browsing.
#endif
    case A_DRAFT_EDIT:
    case A_DRAFT_APPEND:
    case A_DRAFT_UNDO:
    case A_DRAFT_SEND:
    case A_DRAFT_DISCARD:
    case A_DRAFT_STATE:
    case A_DRAFT_OPTIONS:
    case A_DRAFT_BACK:
#ifdef DEVICE_PRO_COMPANION
    case A_CARRY_PREVIEW:
#endif
        if ((s.view != DRAFT && s.view != DRAFT_OPTIONS
#ifdef DEVICE_PRO_COMPANION
             && s.view != CARRY_PREVIEW
#endif
             ) || !draft.page.active ||
            (draft.pending
#ifdef DEVICE_PRO_COMPANION
             && !(draft.read_only && a.kind == A_DRAFT_DISCARD)
#endif
            ) || a.revision != draft.page.revision || strcmp(a.text, draft.page.id)) break;
#ifdef DEVICE_PRO_COMPANION
        if (a.kind == A_DRAFT_DISCARD) pro_send_feedback_clear();
        if (draft.read_only) {
            if ((uint32_t)a.velocity != s.draft_recovery.generation) break;
            if (a.kind == A_DRAFT_DISCARD) {
                pro_draft_store_queue(true);
                break; // Local Close never acknowledges or retries delivery.
            }
            if (s.draft_recovery.store == PRO_RECOVERY_CLEARING) break;
            if (a.kind != A_DRAFT_STATE && a.kind != A_CARRY_PREVIEW &&
                a.kind != A_DRAFT_BACK && a.kind != A_DRAFT_OPTIONS) break;
        }
        if (a.kind == A_CARRY_PREVIEW) {
            if (pro_carry_review_owns(&s.carry_review, &draft.page)) {
                s.carry_review.draft_offset = s.offset;
                s.carry_review.preview_revision = draft.page.revision;
                view(CARRY_PREVIEW);
            }
            break;
        }
        if (!draft.read_only && s.carry_review.detached && pro_carry_review_owns(&s.carry_review, &draft.page)) {
            if (a.kind == A_DRAFT_DISCARD) {
                if (!strcmp(s.carry_review.id, carry.id)) ht_carry_close(&carry);
                pro_draft_store_queue(true);
                break;
            }
            if (a.kind != A_DRAFT_BACK && a.kind != A_DRAFT_OPTIONS) break;
        }
        if (a.kind == A_DRAFT_SEND && s.carry_review.id[0] &&
            (!s.connected || !pro_carry_review_owns(&s.carry_review, &draft.page) ||
             find(s.carry_review.agent) < 0 || !cable_client_supports(CABLE_FEATURE_DRAFT))) {
            COPY(draft.page.error, "Recipient unavailable. Your message is still here.");
            change(); break;
        }
        if (a.kind == A_DRAFT_SEND && s.work_voice_mode != PRO_WORK_TASK) {
            if (!pro_work_draft_available()) {
                COPY(draft.page.error, "Instruction unavailable. Your words are still here.");
                change(); break;
            }
        }
#endif
        if (a.kind == A_DRAFT_OPTIONS) view(DRAFT_OPTIONS);
        else if (a.kind == A_DRAFT_BACK) {
#ifdef DEVICE_PRO_COMPANION
            int row = s.view == CARRY_PREVIEW && pro_carry_review_owns(&s.carry_review, &draft.page) &&
                s.carry_review.preview_revision == draft.page.revision ? s.carry_review.draft_offset : 0;
#endif
            view(DRAFT);
#ifdef DEVICE_PRO_COMPANION
            s.offset = row;
#endif
        }
        else if (a.kind == A_DRAFT_EDIT || a.kind == A_DRAFT_APPEND) {
            if (draft.failed || draft.page.locked) break;
            view(DRAFT);
            a.value = a.kind == A_DRAFT_APPEND ? 6 : 5; a.kind = A_VOICE;
            ht_gesture_guard(&gesture, ms()); dispatch(a);
        } else {
            ht_draft_op_t op = a.kind == A_DRAFT_SEND ? HT_DRAFT_SEND : a.kind == A_DRAFT_DISCARD ? HT_DRAFT_DISCARD :
                a.kind == A_DRAFT_UNDO ? HT_DRAFT_UNDO : HT_DRAFT_STATE;
            if (ht_draft_command(&draft, op, a.revision, 0, ms())) {
                view(DRAFT); ht_gesture_guard(&gesture, ms());
            }
        }
        break;
    case A_HOME:
        if (workspace.phase!=HT_WORKSPACE_IDLE) {
#ifdef DEVICE_PRO_COMPANION
            pro_reader_focus(NULL);
#endif
            ht_workspace_cancel_request(&workspace); s.loading=false; s.active=-1;
        }
        if (visit.pending) { ht_visit_close(&visit); s.pending_focus[0] = 0; }
        view(HOME);
        break;
    case A_AGENTS: {
        view(AGENTS);
#ifdef DEVICE_PRO_COMPANION
        s.pro_agent_layout = 0;
#endif
        int last = s.count > TAB_ROWS ? s.count - TAB_ROWS : 0;
        s.offset = s.active - TAB_ROWS / 2;
        if (s.offset > last) s.offset = last;
        if (s.offset < 0) s.offset = 0;
        break;
    }
#ifdef DEVICE_PRO_COMPANION
    case A_AGENT_LAYOUT:
        if (s.view == AGENTS && a.value >= 0 && a.value <= 2) {
            s.pro_agent_layout = (uint8_t)a.value;
            s.offset = 0;
            change();
        }
        break;
#endif
    case A_AGENT: {
        int i = find(a.id);
        if (i < 0)
            break;
        if (visit.available && strcmp(visit.agent, a.id)) ht_visit_close(&visit);
#ifdef DEVICE_PRO_COMPANION
        if (s.active != i) pro_send_feedback_clear();
        pro_reader_focus(a.id);
#endif
        s.active = i;
        view(AGENT);
        if (s.connected)
            queue(a);
        break;
    }
    case A_READER:
#ifdef DEVICE_PRO_COMPANION
        pro_reader_begin(a);
        break;
    case A_READER_BACK:
        pro_reader_back(a);
#else
        view(READER);
#endif
        break;
    case A_QUESTION:
#ifdef DEVICE_PRO_COMPANION
        // Only the explicit retained-answer control may reopen a pending Q1.
        // A current Q2 card or Home shortcut must not silently show Q1 instead.
        if (s.q.pending && !(s.view==INBOX && a.value==-1)) break;
        if (s.view == INBOX) {
            if (a.value == -1) {
                if (s.q.pending && a.revision==s.q.revision && !strcmp(a.id,s.q.agent)) view(QUESTION);
                break;
            }
            for (int i=0; i<s.notice_count; i++) {
                const cable_notif_t *n=&s.notice[i];
                if (n->question && !n->question_unavailable && n->display_revision==a.revision && !strcmp(n->agent_id,a.id)) {
                    read_question(n->agent_id,n->name);
                    break;
                }
            }
        } else if ((s.view==HOME || s.view==AGENT) && active() && !strcmp(active()->id,a.id)) {
            open_question();
        }
#else
        if (find(a.id) >= 0) s.active = find(a.id);
        open_question();
#endif
        break;
#ifdef DEVICE_PRO_COMPANION
    case A_QUESTION_CLOSE:
        if (question_view(s.view) && s.q.pending && s.q.uncertain &&
            a.revision==s.q.revision && a.dy==s.q.index && !strcmp(a.id,s.q.agent)) {
            // Close removes this local copy, not the host's question or answer.
            // Advancing the revision also invalidates an old queued submission.
            uint32_t revision=s.q.revision+1;
            memset(&s.q,0,sizeof s.q); s.q.revision=revision;
            view(INBOX);
        }
        break;
#endif
    case A_QUESTION_CHOICES:
    case A_QUESTION_REVIEW:
    case A_QUESTION_BACK:
    case A_QUESTION_SAY:
    case A_CHOICE:
    case A_ANSWER:
        if (!question_view(s.view) || a.revision!=s.q.revision || a.dy!=s.q.index ||
            !s.q.valid || s.q.loading || s.q.pending || s.q.error[0] || strcmp(a.id,s.q.agent)) break;
        if (a.kind==A_QUESTION_SAY && s.q.item[s.q.index].can_text) {
            a.kind=A_VOICE; a.value=4; copy(a.text,sizeof s.q.token,s.q.token);
            ht_gesture_guard(&gesture,ms()); dispatch(a);
        } else if (a.kind==A_QUESTION_CHOICES && s.view==QUESTION) view(CHOICE);
        else if (a.kind==A_QUESTION_BACK) {
#ifdef DEVICE_PRO_COMPANION
            pro_question_back(a);
#else
            view(s.view==ANSWER_REVIEW && !s.q.item[s.q.index].draft[0] ? CHOICE : QUESTION);
#endif
        }
        else if (a.kind==A_CHOICE && s.view==CHOICE && a.value>=0 && a.value<s.q.item[s.q.index].count) {
            question_item_t *q=&s.q.item[s.q.index];
            q->draft[0]=q->answer[0]=0; s.q.speech_error[0]=0;
            if (q->multi) q->selected^=1u<<a.value;
            else q->selected=1u<<a.value;
            change();
        } else if (a.kind==A_QUESTION_REVIEW && (s.view==CHOICE || (s.view==QUESTION && s.q.item[s.q.index].draft[0])) && question_answer()) {
            view(ANSWER_REVIEW); ht_gesture_guard(&gesture,ms());
        }
        else if (a.kind==A_ANSWER) send_answer();
        break;
    case A_INBOX:
#ifdef DEVICE_PRO_COMPANION
        if (a.value == 1) {
            if (s.view != HOME && s.view != AGENT) break;
            if (s.q.pending) { view(QUESTION); break; }
            view(INBOX);
            for (int i = 0; i < s.notice_count; i++)
                if (s.notice[i].question && !s.notice[i].question_unavailable) { s.offset = i; break; }
            if (!waiting()) for (int i = 0; i < s.notice_count; i++)
                if (!s.notice[i].read_on_dial) { s.offset = i; break; }
            break;
        }
#endif
        notice_open();
        break;
    case A_NOTICE: {
        if (s.connected && !visit.pending && a.id[0]) {
#ifdef DEVICE_PRO_COMPANION
            bool current=false;
            for (int i=0; i<s.notice_count; i++)
                if (!strcmp(s.notice[i].agent_id,a.id) && s.notice[i].display_revision==a.revision) current=true;
            if (!current || s.view!=INBOX) break;
            for (int i=0; i<s.notice_count; i++)
                if (!strcmp(s.notice[i].agent_id,a.id)) notice_mark_read(&s.notice[i]);
            pro_open_in_app(a.id);
#else
            for (int i = 0; i < s.notice_count; i++)
                if (!strcmp(s.notice[i].agent_id, a.id)) notice_mark_read(&s.notice[i]);
            // The shipping bridge supports agent.open, but not the experiment's
            // visit/bookmark protocol. Stay in the inbox while the app opens it;
            // its usual focus/seen messages reconcile the recipient and inbox.
            action_t open={.kind=A_DESKTOP}; COPY(open.id,a.id);
            if (queue(open)) {
                ht_visit_close(&visit);
                COPY(s.opening_notice, a.id);
                // The outcome was already read on this card. Keep its pane in
                // presence mode, including panes whose history arrives later.
                // Opening a question never answers or dismisses that question.
                for (int i = 0; i < s.notice_count; i++)
                    if (!strcmp(s.notice[i].agent_id, a.id) && !s.notice[i].question) {
                        dismiss_result(a.id);
                        break;
                    }
            }
            else {
                COPY(s.title,"Device busy");
                COPY(s.message,"Open the update again.");
                view(MESSAGE);
            }
#endif
        }
        break;
    }
    case A_LATEST:
#ifdef DEVICE_PRO_COMPANION
        if (a.value==1 && (s.view!=READER || a.reader_serial!=s.reader.serial ||
            a.revision!=s.reader.serial || strcmp(a.id,s.reader_agent) ||
            strcmp(a.text,s.reader.host) || (uint32_t)a.dy!=s.reader.source_generation ||
            (uint32_t)a.velocity!=s.reader_focus_generation ||
            !pro_reader_openable() || !pro_reader_latest())) break;
#endif
        if (cable_client_supports(CABLE_FEATURE_VISIT) && s.connected && !s.voice_open && !s.loading && !visit.pending &&
            active() && !strcmp(active()->id,a.id)) {
            char id[48];
            if (visit.available) COPY(id,visit.id);
            else snprintf(id,sizeof id,"visit-%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
            if (!ht_visit_latest(&visit,id,a.id,ms(),visit_emit,NULL)) {
                COPY(s.title,"Latest output"); COPY(s.message,"The cable is busy. Try again."); view(MESSAGE);
                break;
            }
            COPY(s.title,"Latest output");
            COPY(s.message,"Keeping your reading place...");
            view(MESSAGE);
        }
        break;
    case A_RETURN:
        if (!s.connected || !visit.available || visit.pending || !a.text[0] ||
            strcmp(a.text,visit.id) || a.revision!=visit.request) break;
        if (ht_visit_back(&visit, ms())) {
            COPY(s.title, "Returning");
            snprintf(s.message, sizeof(s.message), "%.79s", visit.label[0] ? visit.label : "Your previous pane");
            view(MESSAGE);
        } else {
            COPY(s.title,"Return"); COPY(s.message,"The cable is busy. Try again."); view(MESSAGE);
        }
        break;
    case A_TABS:
        tabs_open();
        break;
#if HT_FACE_PX >= 720
    case A_TAB_STRIP_LEFT:
    case A_TAB_STRIP_RIGHT:
        // Two at a time: one felt like nothing had happened on a strip this wide.
        s.tab_first += a.kind == A_TAB_STRIP_LEFT ? -2 : 2;
        if (s.tab_first < 0) s.tab_first = 0;
        if (s.tab_first >= s.tab_count) s.tab_first = s.tab_count ? s.tab_count - 1 : 0;
        change();
        break;
#endif
    case A_MACHINES:
        view(MACHINES);
        break;
    case A_TAB:
        if (!s.connected || s.voice_open || s.loading || workspace_index(a.id)<0) break;
#if HT_FACE_PX >= 720
#ifdef DEVICE_PRO_COMPANION
        if (!strcmp(a.id,s.selected_tab)) { view(HOME); break; }
        s.land_on_desk = false; // A workspace change returns to its companion; Panes is explicit.
#else
        if (!strcmp(a.id,s.selected_tab)) { view(pro_panes_of(a.id) > 1 ? AGENTS : HOME); break; }
        s.land_on_desk = pro_panes_of(a.id) > 1;
#endif
#else
        if (!strcmp(a.id,s.selected_tab)) { view(HOME); break; }
#endif
        if (ht_workspace_request(&workspace,a.id,ms())) {
            a.revision=workspace.serial;
            if (!queue(a)) { workspace_failed("Device busy. Choose the tab again."); break; }
            ht_visit_close(&visit); s.pending_focus[0]=0;
#ifdef DEVICE_PRO_COMPANION
            view(HOME); s.loading=true;
#elif HT_FACE_PX >= 720
            // NO INTERSTITIAL. Going to MESSAGE meant leaving the companion for a near-empty screen
            // and coming back — two whole-face repaints for well under a second, which reads as the
            // screen flashing rather than as progress. The panes page is where this is going anyway.
            view(AGENTS); s.loading=true;
#else
            COPY(s.title,"Switching tab"); COPY(s.message,"Opening your workspace...");
            view(MESSAGE); s.loading=true;
#endif
        }
        break;
    case A_MACHINE:
        if (s.connected && queue(a)) {
            ht_visit_close(&visit);
            COPY(s.pending_machine, a.id);
            s.machine_deadline = ms() + 6000;
            change();
        }
        break;
    case A_SELECT_FIND:
        a.kind = A_VOICE; a.value = 7;
        dispatch(a); break;
    case A_VOICE:
#ifdef DEVICE_PRO_COMPANION
        if (carry.active && s.view != SELECTION && (a.value == 0 || a.value == 1 || a.value == 8)) break;
        if (a.value == 3 && (!cable_client_supports(CABLE_FEATURE_DRAFT) ||
            find(a.id) < 0 || (int32_t)(ms() - carry.deadline) >= 0)) break;
        // A question sheet can only record for its explicit reviewed question.
        if (question_view(s.view) && a.value != 4) break;
        // Reject known engine/recipient mismatches before recording. Existing
        // voice.draft support does not attest a host's strict intent handling.
        if (a.value == 0 || a.value == 1 || a.value == 3 || a.value == 8) {
            int recipient = find(a.id);
            const char *reason = pro_work_block_reason(recipient >= 0 ? &s.agents[recipient] : NULL,
                                                       pro_work_voice_mode(a.value));
            if (reason) {
                if (s.view != WORK_INTENT &&
                    ((a.value == 1 || a.value == 8) || (s.view != HOME && s.view != AGENT))) {
                    COPY(s.title, "Instruction unavailable"); COPY(s.message, reason); view(MESSAGE);
                }
                change(); break;
            }
        }
        pro_speech_cancel(true);
#endif
        if (a.value != 2 && a.value != 4 && a.value != 5 && a.value != 6 && a.value != 7 && s.view != SELECTION && carry.error[0]) {
            COPY(s.title,"Carried text"); copy(s.message,sizeof carry.error,carry.error); view(MESSAGE); break;
        }
        if (a.value == 4 && (!question_view(s.view) || !s.q.valid || !s.q.supported || s.q.pending ||
            a.revision!=s.q.revision || a.dy!=s.q.index || !s.q.item[s.q.index].can_text ||
            strcmp(a.id,s.q.agent) || strcmp(a.text,s.q.token))) break;
        if (a.value == 3 && (!carry.active || strcmp(a.text,carry.id) || !a.id[0])) break;
        if (a.value == 5 || a.value == 6) {
            if (s.view != DRAFT || !draft.page.active || draft.pending || draft.failed || draft.page.locked ||
                a.revision != draft.page.revision || strcmp(a.text, draft.page.id)) break;
            a.id[0] = 0;
        } else if (draft.page.active) { view(DRAFT); break; }
        if (a.value == 2) {
            if (s.view != FORM || form.pending || form.failed || !form.page.active ||
                !form.page.can_query || form.page.busy || strcmp(a.text, form.id) ||
                a.dy < 0 || (uint32_t)a.dy != form.page.revision) break;
        } else if (form.id[0]) { view(FORM); break; }
        if (a.value == 7 && (s.view != SELECTION || strcmp(a.id,selection.agent) ||
            strcmp(a.text,selection.id) || a.dy <= 0 || (uint32_t)a.dy != selection.revision)) break;
        if (s.view == SELECTION && (carry.pending || !ht_selection_ready(&selection) ||
            (a.value != 7 && !selection.excerpt[0]))) break;
        if (s.voice_open || audio_client_active() || s.voice_waiting) {
            s.voice_open = true;
            view(VOICE);
            break;
        }
        if (s.connected && !visit.pending) {
            // Main-surface voice always has an explicit recipient. Home orchestration is deferred.
            if (s.view == HOME || s.view == AGENT) {
                if (!a.id[0] || s.loading) break;
            }
            if (a.value==4) {
                s.voice_question_revision=s.q.revision; s.voice_question_index=s.q.index;
                s.q.speech_error[0]=0;
            }
            a.revision = ++s.voice_generation;
            if (!queue(a))
                break;
            s.voice_open = s.voice_start_pending = true;
#ifdef DEVICE_PRO_COMPANION
            pro_send_feedback_clear();
#endif
            s.voice_carry = a.value == 3;
            s.voice_search = a.value == 7;
            s.voice_review = a.value == 5 || a.value == 6;
#ifdef DEVICE_PRO_COMPANION
            if (a.value == 3) {
                pro_carry_review_begin(&s.carry_review, &carry, a.id, s.agents[find(a.id)].name);
                s.voice_review = true;
            }
            if (a.value != 5 && a.value != 6) {
                s.work_voice_mode = pro_work_voice_mode(a.value);
                if (a.value == 0 || a.value == 1 || a.value == 3 || a.value == 8)
                    pro_work_capture_pin(&s.agents[find(a.id)], s.work_voice_mode);
                else pro_draft_recovery_pin(&s.draft_recovery, a.id, (uint8_t)s.work_voice_mode);
            }
            if (a.value == 1 || a.value == 8) {
                COPY(s.work_agent, a.id);
                s.voice_review = true;
            }
#endif
            s.voice_draft_append = a.value == 6;
            s.voice_draft_revision = (uint32_t)a.dy;
            s.nap = false;
            s.voice_return = s.view;
            int target = find(a.id);
            if (a.value == 2) snprintf(s.voice_target, sizeof s.voice_target, PRO_TR("Find %.48s"),
                !strcmp(form.page.title, "Find Harness") ? "Harness" :
                !strcmp(form.page.title, "New Harness") ? form.page.label : form.page.title);
            else if (a.value == 7) COPY(s.voice_target, PRO_TR("Find in output"));
            else if (a.value == 5 || a.value == 6) {
#ifdef DEVICE_PRO_COMPANION
                if (pro_carry_review_owns(&s.carry_review, &draft.page)) COPY(s.voice_target, s.carry_review.name);
                else
#endif
                COPY(s.voice_target, draft.page.name);
            }
#ifdef DEVICE_PRO_COMPANION
            else if (a.value == 4) COPY(s.voice_target, s.q.name);
#endif
            else COPY(s.voice_target, target >= 0 ? s.agents[target].name : "harness");
            s.voice_started = ms();
            view(VOICE);
            ESP_LOGI("habitat", "voice queued generation=%lu", (unsigned long)a.revision);
        }
        break;
    case A_VOICE_STOP:
        if (s.voice_open && !s.voice_start_pending && !s.voice_waiting && audio_client_recording()) {
            if (a.value == 1 && cable_client_supports(CABLE_FEATURE_DRAFT) && !s.voice_search && (s.voice_return == HOME || s.voice_return == AGENT || s.voice_return == SELECTION
#ifdef DEVICE_PRO_COMPANION
                || s.voice_return == WORK_INTENT
#endif
                )) {
                s.voice_review = true; audio_client_request_review();
            }
            audio_client_stop();
            s.voice_waiting = true;
            s.voice_wait_until = ms() + 65000;
            change();
        }
        break;
    case A_VOICE_ABORT:
        audio_client_abort();
        audio_client_copy_upload_id(a.text, sizeof(a.text));
        voice_close();
        queue(a); // also cancel host work after capture has already finished
        ht_gesture_guard(&gesture, ms());
        view(s.voice_return == DRAFT && draft.page.active ? DRAFT : s.voice_return == FORM && form.id[0] ? FORM : question_view(s.voice_return) && s.q.valid ? s.voice_return : HOME);
        if (s.view == DRAFT) ht_draft_command(&draft, HT_DRAFT_STATE, draft.page.revision, 0, ms());
        break;
    case A_PET:
        s.nap = false;
        s.pet_pose = 1;
        s.pet_until = ms() + 900;
        change();
        break;
    case A_SELECT_BEGIN:
        if (cable_client_supports(CABLE_FEATURE_SELECTION) && s.connected && !s.loading && active()) {
#ifdef DEVICE_PRO_COMPANION
            // A cached result can outlive desktop focus. Selection always starts
            // from fresh host output for the captured source, never today's active
            // pane substituted for a reader or retry action captured earlier.
            if (visit.pending || s.pending_focus[0] || s.pending_machine[0] || strcmp(a.id, active()->id)) break;
            if (a.value == 1 && (s.view != READER || strcmp(a.id, s.reader_agent) ||
                a.revision!=s.reader.serial || s.reader.from_notice || !pro_reader_owner())) break;
            if (s.view == SELECTION && (strcmp(a.id, selection.agent) ||
                strcmp(a.text, selection.id) || (uint32_t)a.dy != selection.revision)) break;
            if (a.value != 1 && s.view != SETTINGS && s.view != SELECTION) break;
#endif
            ht_carry_close(&carry);
            char id[48]; snprintf(id, sizeof(id), "pick-%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
            view(SELECTION);
            ht_selection_open(&selection, id, active()->id, ms(), selection_emit, NULL);
            change();
        }
        break;
    case A_SELECT_EXTEND:
        ht_selection_extend(&selection, ms()); change();
        break;
    case A_CARRY:
#ifdef DEVICE_PRO_COMPANION
        if (!cable_client_supports(CABLE_FEATURE_DRAFT)) break;
#endif
        if (s.view == SELECTION && !carry.pending && ht_selection_ready(&selection) &&
            selection.excerpt[0] && !strcmp(a.id,selection.agent) &&
            !strcmp(a.text,selection.id) && (uint32_t)a.dy==selection.revision) {
            char id[48]; snprintf(id,sizeof(id),"carry-%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
            ht_carry_open(&carry,id,a.id,a.text,(uint32_t)a.dy,ms(),carry_emit,NULL);
            if (carry.error[0]) COPY(selection.error,carry.error);
            change();
        }
        break;
    case A_CARRY_DROP:
        if (a.revision==carry.serial && !strcmp(a.text,carry.id)) {
            ht_carry_close(&carry); change();
        }
        break;
    case A_COMPANION:
        view(COMPANION);
        break;
    case A_CHARACTER:
        choose_character(a.value);
        break;
    case A_NAP:
#ifdef DEVICE_PRO_COMPANION
        pro_speech_cancel(true);
#endif
        s.nap = !s.nap;
        s.nap_until = ms() + 15 * 60 * 1000;
        change();
        break;
    case A_QUIET:
    case A_FACE:
    case A_RIM: {
        if (a.kind == A_QUIET) s.quiet = !s.quiet;
        if (a.kind == A_FACE) s.straight_title = !s.straight_title;
        if (a.kind == A_RIM) s.rim_enabled = !s.rim_enabled;
        action_t save = {.kind = A_HABITAT_SAVE,
            .value = (s.focus_face ? 1 : 0) | (s.rim_enabled ? 2 : 0) | (s.quiet ? 4 : 0) | (s.straight_title ? 8 : 0)};
        bool saved = queue(save);
        if (a.kind == A_FACE && saved) view(HOME); // compare immediately, without hunting for a back button
        change();
        break;
    }
    case A_MUTE:
        s.muted = !s.muted;
        a.value = s.muted;
        queue(a);
        change();
        break;
    case A_FIND:
    case A_FORM: {
        if (!s.connected || s.voice_open) break;
        if (!cable_client_supports(CABLE_FEATURE_FORM)) {
            if (a.kind == A_FIND) view(AGENTS);
            else { COPY(s.title,"New Harness"); COPY(s.message,"Open New Harness on your computer."); view(MESSAGE); }
            break;
        }
        if (!form.id[0]) {
            char id[48]; snprintf(id, sizeof id, "%s-%08lx-%08lx", a.kind == A_FIND ? "find" : "form",
                                  (unsigned long)esp_random(), (unsigned long)ms());
            ht_visit_close(&visit);
            ht_form_open(&form, id, ms(), form_emit, NULL);
        }
        ht_gesture_guard(&gesture, ms());
        view(FORM);
        break;
    }
    case A_FORM_SAY:
        if (s.view == FORM) {
            a.kind = A_VOICE; a.value = 2;
            ht_gesture_guard(&gesture, ms());
            dispatch(a);
        }
        break;
    case A_FORM_MAIN:
        if (s.view == FORM && s.connected) {
            if (form.failed) {
                action_kind_t destination = !strncmp(form.id, "find-", 5) ? A_FIND : A_FORM;
                ht_form_reset(&form); dispatch((action_t){.kind = destination});
            } else ht_form_command(&form, HT_FORM_ACTIVATE, a.revision, 0, ms());
            ht_gesture_guard(&gesture, ms()); change();
        }
        break;
    case A_FORM_BACK:
        if (s.view == FORM && (!form.id[0] ||
            (!strncmp(form.id,"find-",5) && (!s.connected || form.pending || form.failed || !form.page.active)))) {
            ht_form_dismiss(&form); view(HOME); ht_gesture_guard(&gesture,ms());
        } else if (s.view == FORM && s.connected) {
            if (form.failed) {
                action_kind_t destination = !strncmp(form.id, "find-", 5) ? A_FIND : A_FORM;
                ht_form_reset(&form); dispatch((action_t){.kind = destination});
            } else ht_form_command(&form, HT_FORM_BACK, a.revision, 0, ms());
            change();
        }
        break;
    case A_SETTINGS:
        view(SETTINGS);
        break;
    case A_BRIGHT:
        // Saved stock settings can be any percentage (the default is 60).
        // Advance to a preset, never beyond 100 or through an overflowing byte.
        s.brightness = s.brightness >= 100 ? 25 : (s.brightness / 25 + 1) * 25;
        a.value = s.brightness;
#ifdef DEVICE_PRO_COMPANION
        display_set_brightness((uint8_t)((s.brightness * 255 + 50) / 100));
#endif
        queue(a);
        change();
        break;
    case A_STOP:
        COPY(s.stop_agent, a.id);
        view(STOP);
        break;
    case A_STOP_YES:
        if (s.connected && find(s.stop_agent) >= 0 && s.agents[find(s.stop_agent)].busy) {
            COPY(a.id, s.stop_agent);
            queue(a);
            view(AGENT);
        }
        break;
    case A_MODELS:
        if (s.connected && active()) {
            COPY(s.model_agent, active()->id);
            COPY(s.model_selected, active()->model);
            s.model_count = -1;
            s.model_request = true;
            view(MODELS);
            if (reload_waiter)
                xTaskNotifyGive(reload_waiter);
        }
        break;
    case A_MODEL:
        if (s.connected) {
            queue(a);
            view(AGENT);
        }
        break;
    case A_RECAP_DISMISS:
        dismiss_result(a.id);
        break;
    case A_DESKTOP:
#ifdef DEVICE_PRO_COMPANION
        if (a.value==2) {
            if (s.view==READER && a.id[0] && !strcmp(a.id,s.reader_agent) &&
                a.revision==s.reader.serial && pro_reader_openable())
                pro_open_in_app(a.id);
            break;
        }
        if (a.value==1) {
            if (question_view(s.view) && a.revision==s.q.revision && !strcmp(a.id,s.q.agent))
                pro_open_in_app(a.id);
            break;
        }
#endif
        if (s.connected)
            queue(a);
        break;
    case A_UP:
#ifdef DEVICE_PRO_COMPANION
        if (a.value==1 && s.view!=READER) break;
        if (s.view==READER && (a.revision!=s.reader.serial || strcmp(a.id,s.reader_agent))) break;
#endif
        s.offset -= s.view == READER ? 5 : 3;
        if (s.offset < 0)
            s.offset = 0;
        change();
        break;
    case A_DOWN:
#ifdef DEVICE_PRO_COMPANION
        if (a.value==1 && s.view!=READER) break;
        if (s.view==READER && (a.revision!=s.reader.serial || strcmp(a.id,s.reader_agent))) break;
#endif
        if (s.view == INBOX)
            s.offset = s.notice_count ? (s.offset + 1) % s.notice_count : 0;
        else s.offset += s.view == READER ? 5 : 3;
        change();
        break;
    case A_LOCK:
        if (config_lock_enabled()) {
#ifdef DEVICE_PRO_COMPANION
            pro_speech_cancel(true);
#endif
            s.locked = true;
            change();
        }
        break;
    case A_QUESTION_READ:
    case A_NOTICE_READ:
    case A_TAB_REFRESH:
    case A_NONE:
    case A_SELECT_SEND:
    case A_CARRY_SEND:
    case A_FORM_SEND:
    case A_DRAFT_COMMAND:
    case A_VISIT_SEND:
    case A_SCROLL:
    case A_HABITAT_SAVE:
    case A_CHARACTER_SAVE:
        break;
    }
}
static void worker(void *unused)
{
    (void)unused;
    action_t a;
    static EXT_RAM_BSS_ATTR question_submit_t packet;
    while (xQueueReceive(actions, &a, portMAX_DELAY) == pdTRUE) {
        switch (a.kind) {
#ifdef DEVICE_PRO_COMPANION
        case A_DRAFT_STORE:
            pro_draft_store_work(a);
            break;
        case A_METRICS_GET: {
            display_lock();
            bool current=s.connected && s.view==TODAY && s.metrics.phase==PRO_METRICS_WAIT &&
                (int32_t)(ms()-s.metrics.deadline)<0 &&
                a.revision==s.metrics.serial && !strcmp(a.id,s.metrics.request) && !strcmp(a.text,s.metrics.machine);
            display_unlock();
            if (current && !cable_client_metrics_get(a.id)) {
                display_lock();
                if (s.metrics.phase==PRO_METRICS_WAIT && a.revision==s.metrics.serial && !strcmp(a.id,s.metrics.request)) {
                    s.metrics.phase=PRO_METRICS_ERROR; s.metrics.request[0]=0; change();
                }
                display_unlock();
            }
            break;
        }
#endif
        case A_DRAFT_COMMAND: {
            static const char *ops[] = {"state", "move", "undo", "discard", "send"};
#ifdef DEVICE_PRO_COMPANION
            display_lock();
            bool current = s.connected && draft.page.active && draft.pending &&
                !strcmp(a.id, draft.page.id) && a.revision == draft.request &&
                (uint32_t)a.dy == draft.page.revision && a.value == (int)draft.op;
            if (draft.read_only) current = current &&
                pro_draft_recovery_same_host(&s.draft_recovery) &&
                s.draft_recovery.request_generation == s.draft_recovery.generation &&
                !strcmp(a.text, s.draft_recovery.original_host) &&
                (a.value == HT_DRAFT_STATE || (a.value == HT_DRAFT_MOVE && s.draft_recovery.ready));
            else current = current && !s.carry_review.detached;
            if (current && a.value == HT_DRAFT_SEND && !pro_work_draft_available()) {
                // No bytes left this worker: retain the reviewed words without
                // claiming a terminal receipt or leaving a false pending send.
                draft.pending = false;
                COPY(draft.page.error, "Instruction unavailable. Your words are still here.");
                change(); current = false;
            }
            if (current && a.value == HT_DRAFT_SEND) pro_send_feedback_begin(a.revision);
            else if (current && a.value == HT_DRAFT_DISCARD) pro_send_feedback_clear();
            display_unlock();
            if (!current) break;
#endif
            if (a.value >= 0 && a.value <= HT_DRAFT_SEND)
                cable_client_draft(a.id, ops[a.value], a.revision, (uint32_t)a.dy, a.velocity);
            break;
        }
        case A_CARRY_SEND:
            cable_client_carry(a.text,a.id,a.text+48,(uint32_t)a.dy,a.revision,a.value!=0);
            break;
        case A_FORM_SEND: {
            static const char *ops[] = {"open", "state", "move", "activate", "back", "close"};
            if (a.value >= 0 && a.value < 6)
                cable_client_form(a.id, a.revision, ops[a.value], (uint32_t)a.dy, a.velocity);
            break;
        }
        case A_VISIT_SEND: {
            static const char *ops[] = {"open", "back", "cancel", "latest"};
            display_lock();
            bool current=a.value==HT_VISIT_CANCEL ||
                (visit.pending && a.revision==visit.request && a.value==(int)visit.op && !strcmp(a.text,visit.id));
#ifdef DEVICE_PRO_COMPANION
            if (current && a.value==HT_VISIT_LATEST && a.reader_serial) {
                bool reader=s.connected && !s.voice_open && !s.loading && !s.pending_focus[0] &&
                    !s.pending_machine[0] && a.reader_serial==s.reader.serial &&
                    !strcmp(a.id,s.reader_agent) && !strcmp(a.id,visit.pending_agent) &&
                    !strcmp(a.text+sizeof visit.id,s.reader.host) &&
                    (uint32_t)a.dy==s.reader.source_generation &&
                    (uint32_t)a.velocity==s.reader_focus_generation && pro_reader_latest();
                if (!reader) {
                    // Nothing left this worker. Keep an acknowledged Return
                    // only if its source and focus survived the unsent peek.
                    bool same_source=(uint32_t)a.dy==s.result_generation &&
                        !strcmp(a.text+sizeof visit.id,s.notice_host);
                    bool same_focus=(uint32_t)a.velocity==s.reader_focus_generation;
                    ht_visit_reply(&visit,a.text,a.revision,false,same_source && same_focus && visit.available,NULL);
                    if (s.view==MESSAGE && a.reader_serial==s.reader.serial) {
                        view(READER); s.offset=s.reader.row;
                    }
                    change(); current=false;
                }
            }
#endif
            display_unlock();
            if (current && a.value >= 0 && a.value <= HT_VISIT_LATEST)
                cable_client_visit(a.text, a.revision, ops[a.value], a.id);
            break;
        }
        case A_SELECT_SEND: {
            static const char *ops[] = {"begin", "step", "extend", "extend", "cancel", "match", "lines"};
            if (a.value >= 0 && a.value <= HT_SELECT_LINES)
                cable_client_select_text(a.id, a.text, (uint32_t)a.velocity, a.revision,
                                         ops[a.value], a.dy, a.value == HT_SELECT_EXTEND);
            break;
        }
        case A_SCROLL:
            cable_client_send_scroll((cable_scroll_phase_t)a.value, a.dy, a.velocity);
            break;
        case A_AGENT:
            cable_client_send_focus(a.id);
            break;
        case A_DESKTOP:
            cable_client_send_open(a.id, NULL);
            break;
        case A_NOTICE_READ:
            cable_client_notification_read(a.id, a.text);
            break;
        case A_TAB: {
            display_lock();
            bool valid=s.connected && workspace.phase==HT_WORKSPACE_WAIT_TAB &&
                a.revision==workspace.serial && !strcmp(a.id,workspace.pending);
            display_unlock();
            if (valid) cable_client_select_swarm(a.id);
            break;
        }
        case A_TAB_REFRESH: {
            uint32_t generation=cable_client_agent_generation();
            display_lock();
            bool valid=s.connected && ht_workspace_refresh(&workspace,a.revision,generation);
            display_unlock();
            if (valid && !cable_client_request_agents()) {
                display_lock();
                if (a.revision==workspace.serial && workspace.phase!=HT_WORKSPACE_IDLE)
                    workspace_failed("Could not refresh the tab. Try again.");
                display_unlock();
            }
            break;
        }
        case A_MACHINE:
            cable_client_select_machine(a.id);
            break;
        case A_VOICE:
            display_lock();
            if (s.connected && s.voice_open && s.voice_start_pending &&
                a.revision == s.voice_generation) {
#ifdef DEVICE_PRO_COMPANION
                if (a.value == 3 && (!cable_client_supports(CABLE_FEATURE_DRAFT) || find(a.id) < 0 ||
                    strcmp(a.id, s.carry_review.agent) || strcmp(a.text, s.carry_review.id) ||
                    !carry.active || strcmp(a.text, carry.id) || (int32_t)(ms() - carry.deadline) >= 0)) {
                    voice_close();
                    COPY(s.title, "Carried text");
                    COPY(s.message, "Carry review is unavailable. Your text was not sent.");
                    view(MESSAGE);
                    display_unlock();
                    break;
                }
                if (a.value == 0 || a.value == 1 || a.value == 3 || a.value == 8) {
                    if (!pro_work_capture_available(a.id, pro_work_voice_mode(a.value))) {
                        int recipient = find(a.id);
                        const char *reason = pro_work_block_reason(recipient >= 0 ? &s.agents[recipient] : NULL,
                                                                   pro_work_voice_mode(a.value));
                        voice_close();
                        COPY(s.title, "Instruction unavailable");
                        COPY(s.message, reason ? reason : "Choose the pane and instruction again.");
                        if (reason && (s.voice_return == WORK_INTENT ||
                            ((a.value == 0 || a.value == 3) && (s.voice_return == HOME || s.voice_return == AGENT))))
                            view(s.voice_return);
                        else view(MESSAGE);
                        display_unlock();
                        break;
                    }
                }
#endif
                if (a.value == 7) audio_client_start_search(a.id, a.text, (unsigned)a.dy);
                else if (a.value == 5 || a.value == 6) audio_client_start_draft(a.text, (unsigned)a.dy, a.value == 6);
                else if (a.value == 4) audio_client_start_question(a.id,a.text,(unsigned)a.dy);
                else if (a.value == 2) audio_client_start_form(a.text, (unsigned)a.dy);
                else if (a.value == 3) audio_client_start_carry(a.id,a.text);
                else if (a.text[0] && a.dy > 0) audio_client_start_selection(a.id, a.text, (unsigned)a.dy);
                else audio_client_start_cable(a.id[0] ? a.id : NULL,
                                              a.value == 1 ? VOICE_CMD_GOAL :
#ifdef DEVICE_PRO_COMPANION
                                              a.value == 8 ? VOICE_CMD_LOOP :
#endif
                                              VOICE_CMD_NONE);
#ifdef DEVICE_PRO_COMPANION
                // Set before yielding to UI input; every finish path, including
                // the duration cap, then emits voice.end review=true.
                if (a.value == 1 || a.value == 8 || a.value == 3) audio_client_request_review();
#endif
                s.voice_start_pending = false;
                change();
            }
            display_unlock();
            break;
        case A_VOICE_ABORT:
            cable_client_voice_cancel(a.text);
            break;
        case A_STOP_YES:
            cable_client_stop_turn(a.id);
            break;
        case A_MODEL: {
            const char *p = strrchr(a.text, ':');
            char model[128];
            COPY(model, p ? p + 1 : a.text);
            char *effort = strrchr(model, '@');
            if (effort)
                *effort++ = 0;
            cable_client_agent_update(a.id, model, effort);
            break;
        }
        case A_BRIGHT:
            config_save_brightness((uint8_t)((a.value * 255 + 50) / 100));
            break;
        case A_CHARACTER_SAVE:
            if (!config_save_habitat_character((uint8_t)a.value))
                ui_cable_toast("Character changed; saving failed.");
            break;
#ifdef DEVICE_PRO_COMPANION
        case A_LANGUAGE_SET: {
            if (a.value != 0 && a.value != 1) break;
            // NVS writes stay on the action worker, away from rendering/touch.
            const char *lang = a.value ? "vi" : "en";
            bool saved = config_save_voicelang(lang);
            char actual[CFG_VLANG_MAX];
            config_load_voicelang(actual, sizeof actual);
            display_lock();
            COPY(s.voice_language, actual);
            s.language_saving = false;
            s.language_error = !saved || strcmp(actual, lang);
            change();
            display_unlock();
            break;
        }
        case A_APPEAR_SAVE:
            if (!config_save_pro_appearance((uint16_t)a.value))
                ui_cable_toast("Appearance changed; saving failed.");
            break;
#endif
        case A_HABITAT_SAVE:
            if (!config_save_habitat_options((uint8_t)a.value))
                ui_cable_toast("Preference changed; saving failed.");
            break;
        case A_MUTE:
            if (!audio_notify_set_muted(a.value != 0))
                ui_cable_toast("Sound changed; saving failed.");
            break;
        case A_QUESTION_READ:
            cable_client_question_read(a.id,a.text);
            break;
        case A_ANSWER: {
            display_lock();
            bool valid=s.q.valid && s.q.pending && s.q.revision==a.revision && !strcmp(a.id,s.q.agent);
            if (valid) {
                COPY(packet.agent,s.q.agent); COPY(packet.fetch,s.q.fetch); COPY(packet.token,s.q.token);
                packet.count=s.q.count;
                for (int i=0;i<packet.count;i++) {
                    packet.choices[i]=s.q.item[i].selected; COPY(packet.drafts[i],s.q.item[i].draft);
                }
            }
            display_unlock();
            if (!valid) break;
            bool sent=cable_client_answer_reviewed(packet.agent,packet.fetch,packet.token,packet.choices,packet.drafts,packet.count);
            if (!sent) {
                display_lock();
                if (s.q.revision==a.revision) {
                    s.q.uncertain=true; COPY(s.q.error,"Could not confirm sending. Check the terminal."); change();
                }
                display_unlock();
            }
            break;
        }
        default:
            break;
        }
    }
}
void habitat_touch(bool down, int x, int y, uint32_t now)
{
#ifdef DEVICE_CREATURE_GALLERY
    if (s.ready) {
        ht_gallery_touch(&gallery, down, x, y, now);
        habitat_render_notify();
    }
    return;
#endif
    if (!s.ready)
        return;
#ifdef DEVICE_PRO_COMPANION
    if (down && !s.touch_down) pro_speech_cancel(true);
#endif
    if (s.locked) {
        if (down && !s.touch_down) {
            s.pattern[0] = 0;
            s.pattern_mask = 0;
            s.pattern_len = 0;
            s.pattern_error = false;
        }
        if (down)
            for (int i = 0; i < 9; i++) {
                int dx = x - (HT_PATTERN_X + i % 3 * HT_PATTERN_STEP_X);
                int dy = y - (HT_PATTERN_Y + i / 3 * HT_PATTERN_STEP_Y);
                if (dx * dx + dy * dy < HT_PATTERN_RADIUS * HT_PATTERN_RADIUS && !(s.pattern_mask & (1 << i))) {
                    size_t n = strlen(s.pattern);
                    snprintf(s.pattern + n, sizeof(s.pattern) - n, "%s%d", n ? "," : "", i);
                    s.pattern_mask |= 1 << i;
                    s.pattern_len++;
                    change();
                }
            }
        if (!down && s.touch_down) {
            if (s.pattern_len >= 4 && config_check_lock(s.pattern)) {
                s.locked = false;
                s.lock_armed = false;
                view(HOME);
            } else {
                s.pattern_error = true;
                s.pattern_mask = 0;
                change();
            }
        }
        s.touch_down = down;
        return;
    }
    bool surface = s.view == HOME || s.view == AGENT;
    if (s.touch_down && !s.touch_cancelled) {
        // Classify this sample before the hold deadline. A delayed MOVE/UP
        // must not turn a long swipe into a stationary hold.
        ht_gesture_move(&gesture, x, y);
        surface_tick(now);
    }
    surface = s.view == HOME || s.view == AGENT;
    if (down && !s.touch_down) {
        s.touch_cancelled = false;
        s.touch_brake = s.coasting && (int32_t)(now - s.coast_until) < 0;
        s.coasting = false;
        ht_scroll_cancel(&scroll);
        scroll = (ht_scroll_t){0};
        s.start_x = x;
        s.start_y = y;
        s.touch_started = now;
        if (question_view(s.view)) s.q.drag=0;
        s.draft_drag = 0;
        s.tab_drag = 0;
        s.pressed = -1;
        pressed_action = make_action((hit_t){.action = A_NONE});
        for (int i = 0; i < s.hit_count; i++) {
            hit_t h = s.hits[i];
            if (h.enabled && hit_contains(&h, x, y, surface)) {
                s.pressed = i;
                pressed_action = make_action(h);
#if HT_FACE_PX >= 720
                pressed_rect = h.rect;
#endif
                break;
            }
        }
        // A visible footer owns its entire contact, including the nearby rim.
        if (surface && !home_footer(pressed_action.kind) && s.rim_enabled && ht_scroll_on_rim(x, y)) pressed_action.kind = A_NONE;
#ifndef DEVICE_PRO_COMPANION
        if (surface && pressed_action.kind==A_TABS && !s.touch_brake)
            ht_workspace_touch(&workspace,workspace_index(s.selected_tab),s.tab_count,x,y,now);
#endif
#if HT_FACE_PX >= 720
        // The strip's band is the first row of the face — 26..82 plus a thumb's margin.
#ifdef DEVICE_PRO_COMPANION
        s.tab_strip_held = false;
#else
        s.tab_strip_held = (s.view == HOME || s.view == AGENT || s.view == AGENTS) && y < 96;
#endif
        s.tab_strip_drag = 0;
#endif
        if (s.view == TABS && pressed_action.kind == A_TAB) ht_tab_carousel_begin(&tab_carousel, x, now);
        ht_gesture_begin(&gesture, x, y, now, ((uint32_t)s.view << 8) | pressed_action.kind);
        if (pressed_action.kind != A_PET && pressed_action.kind != A_FORM_MAIN && pressed_action.kind != A_FORM_SAY &&
            pressed_action.kind != A_ANSWER && pressed_action.kind != A_DRAFT_SEND && pressed_action.kind != A_DRAFT_EDIT &&
            pressed_action.kind != A_DRAFT_APPEND && pressed_action.kind != A_DRAFT_UNDO) gesture.guarded = false; // Discard is always immediate.
        if (s.pressed >= 0 && ((!surface && s.view != VOICE) || home_footer(pressed_action.kind))) change();
        if (ui_scroll_reportable()) {
            if (surface && home_footer(pressed_action.kind)) {
                // Footer choices send no terminal scroll. A contact
                // that stops an existing fling still has to reach the app.
                if (s.touch_brake) {
                    ht_scroll_begin(&scroll,x,y,now,scroll_reversed,false,scroll_emit,NULL);
                    ht_scroll_cancel(&scroll);
                }
            } else ht_scroll_begin(&scroll, x, y, now, scroll_reversed, s.rim_enabled, scroll_emit, NULL);
        }
    } else if (down && !s.touch_cancelled) {
        ht_gesture_move(&gesture, x, y);
        if (surface && home_footer(pressed_action.kind)) {
#ifndef DEVICE_PRO_COMPANION
            if (pressed_action.kind==A_TABS && ht_workspace_move(&workspace,x,y,gesture.axis,now)) change();
#endif
        } else if (s.view == TABS) {
            if (gesture.axis == 2 && ht_tab_carousel_move(&tab_carousel, x, now)) change();
        } else if ((s.view == AGENTS || s.view == SETTINGS) && gesture.axis == 1) {
            tabs_move((s.last_y - y) * (scroll_reversed ? -1 : 1));
        } else if (s.view == DRAFT && gesture.axis == 1) {
            draft_move((s.last_y - y) * (scroll_reversed ? -1 : 1), now);
        } else if (s.view == FORM && gesture.axis == 1) {
            ht_form_move(&form, (s.last_y - y) * (scroll_reversed ? -1 : 1), now);
        } else if (question_view(s.view) && gesture.axis == 1) {
            question_move((s.last_y-y)*(scroll_reversed ? -1 : 1));
        } else if (s.view == SELECTION && gesture.axis == 1) {
            int travel = (s.last_y - y) * (scroll_reversed ? -1 : 1);
            ht_selection_move(&selection, travel, now);
            change();
#if HT_FACE_PX >= 720
        } else if (s.tab_strip_held && gesture.axis == 2) {
            /*
             * WALKING THE STRIP BY DRAGGING IT, which is what the LVGL tab strip on this board did and
             * what a row of names on a touchscreen should do. The arrows stay for precision; this is
             * for getting somewhere.
             *
             * 90 px a tab, not one tab per pixel of travel: the strip is 648 px wide and a tab is about
             * 150 of it, so a drag that moves the line by roughly half a tab advances one. Accumulated
             * rather than derived from the total, so a slow drag and a fast one cover the same ground.
             */
            s.tab_strip_drag += s.last_x - x;
            while (s.tab_strip_drag >= 90 && s.tab_first < s.tab_count - 1) {
                s.tab_strip_drag -= 90; s.tab_first++; change();
            }
            while (s.tab_strip_drag <= -90 && s.tab_first > 0) {
                s.tab_strip_drag += 90; s.tab_first--; change();
            }
            if (s.tab_first <= 0 && s.tab_strip_drag < -90) s.tab_strip_drag = -90;
            if (s.tab_first >= s.tab_count - 1 && s.tab_strip_drag > 90) s.tab_strip_drag = 90;
#endif
        } else ht_scroll_move(&scroll, x, y, now);
        if (gesture.moved && s.pressed >= 0) {
            s.pressed = -1;
            if ((!surface && s.view != VOICE) || home_footer(pressed_action.kind)) change();
        }
    }
    if (!down && s.touch_down) {
        ht_touch_result_t result = ht_gesture_end(&gesture, x, y, now);
        if (!s.touch_cancelled && (s.view == AGENTS || s.view == SETTINGS) && gesture.axis == 1)
            tabs_move((s.last_y - y) * (scroll_reversed ? -1 : 1));
        bool tab_contact = s.view == TABS && tab_carousel.touching;
        bool tab_tap = tab_contact && ht_tab_carousel_end(&tab_carousel, x, gesture.axis == 2, now);
        bool scrolled = ht_scroll_end(&scroll, x, y, now);
        if (scrolled) {
            uint32_t coast = ht_scroll_coast_ms(scroll.velocity);
            s.coasting = coast > 0;
            s.coast_until = now + coast;
        }
        int dx = x - s.start_x, dy = y - s.start_y;
        s.pressed = -1;
#if HT_FACE_PX >= 720
        if (s.tab_strip_held && gesture.moved && gesture.axis == 2) {
            // The strip consumed this contact while it was moving; its end is not a choice.
        } else if (!tab_contact && pro_written_control(pressed_action.kind) &&
                   !s.touch_cancelled && !gesture.guarded && !gesture.moved && !scrolled &&
                   now - s.touch_started >= 25 && now - s.touch_started < 5000 &&
                   x >= pressed_rect.x && x < pressed_rect.x + pressed_rect.w &&
                   y >= pressed_rect.y && y < pressed_rect.y + pressed_rect.h) {
            // A deliberate written-control press may last longer than a creature tap.
            // Motion, scroll ownership, cancellation, and leaving the target still cancel it.
            ht_gesture_cancel(&gesture);
            dispatch(pressed_action);
        } else
#endif
        if (scrolled || s.touch_cancelled) {
            // Motion owns this entire contact, even if it returns to its start.
        } else if (tab_contact) {
            int index = pressed_action.value;
            if (tab_tap && result == HT_TOUCH_TAP && pressed_action.kind == A_TAB && index >= 0 &&
                index < s.tab_count && !strcmp(pressed_action.id, s.tabs[index].id)) dispatch(pressed_action);
            change();
        } else if (result == HT_TOUCH_TAP && s.touch_brake) {
            // DOWN already stopped desktop inertia. This entire tap is only a brake.
        } else if (surface && pressed_action.kind==A_TABS) {
            bool cancelled=workspace.cancelled || (workspace.touching && now-workspace.began>=5000);
            int chosen=ht_workspace_release(&workspace,x,y,gesture.axis,now);
            if (!s.touch_brake && !cancelled) {
                if (chosen>=0 && chosen<s.tab_count) {
                    action_t tab={.kind=A_TAB}; COPY(tab.id,s.tabs[chosen].id); dispatch(tab);
                } else if (result==HT_TOUCH_TAP || result==HT_TOUCH_HOLD) dispatch((action_t){.kind=A_TABS});
            }
            change();
        } else if (surface && home_footer(pressed_action.kind)) {
            // Dragging off a footer button cancels the choice; it cannot become
            // a pane swipe, a rim scroll, or speech on the portrait.
            if (result == HT_TOUCH_TAP) dispatch(pressed_action);
            change();
        } else if (result == HT_TOUCH_TAP && pressed_action.kind == A_PET &&
                   (surface || s.view == VOICE || s.view == SELECTION)) {
            ht_gesture_guard(&gesture, now);
            if (s.view == VOICE) {
                ESP_LOGI("habitat", "gesture tap: finish voice");
                dispatch((action_t){.kind = A_VOICE_STOP});
            } else if (s.connected && !s.loading && pressed_action.id[0]) {
                ESP_LOGI("habitat", "gesture tap: start voice");
                pressed_action.kind = A_VOICE;
                dispatch(pressed_action);
            }
        } else if (result == HT_TOUCH_HOLD) {
            if (s.view == VOICE && pressed_action.kind == A_PET && cable_client_supports(CABLE_FEATURE_DRAFT)) {
                ht_gesture_guard(&gesture, now);
                dispatch((action_t){.kind = A_VOICE_STOP, .value = 1});
            } else if (s.view == DRAFT && pressed_action.kind == A_DRAFT_EDIT) {
                pressed_action.kind = A_DRAFT_OPTIONS; dispatch(pressed_action);
            } else if (surface && pressed_action.kind == A_PET)
#ifdef DEVICE_PRO_COMPANION
                view(LAUNCHER);
#else
                tabs_open();
#endif
        } else if (result == HT_TOUCH_TAP) {
            if (pressed_action.kind == A_PET) {
                if (surface) dispatch(pressed_action); // immediate, harmless acknowledgement
            } else {
                ht_gesture_cancel(&gesture);
                dispatch(pressed_action);
            }
        }
#ifdef DEVICE_PRO_COMPANION
        else if (pro_appearance_view() && gesture.moved) {
            // Preview motion is local. Neither direction can scroll the desktop,
            // leave this sheet, save a preference or start the microphone.
            if (gesture.axis == 2 && abs(dx) > 60 && abs(dx) > abs(dy))
                pro_appearance_move(dx < 0 ? 1 : -1);
        }
#endif
        else if (gesture.axis == 1 && abs(dy) > 55 && abs(dy) > abs(dx)) {
            if (s.view == TABS || s.view == AGENTS || s.view == SETTINGS) {
                // The list consumed the drag already, including its final sample.
            } else if (s.view == DRAFT || s.view == DRAFT_OPTIONS) {
                // Reading a draft never submits or starts recording.
            } else if (s.view == FORM) {
                // The form cursor consumed the drag; never launch from motion.
            } else if (question_view(s.view)) {
                // Reading/choosing consumed this contact; motion cannot submit an answer.
            } else if (s.view == SELECTION) {
                // Its bounded reading cursor already consumed this vertical drag.
            } else if (surface) {
                // A congested scroll queue cannot turn a scroll into navigation or voice.
#ifdef DEVICE_PRO_COMPANION
            } else if (s.view == CARRY_PREVIEW) {
                s.offset += dy < 0 ? 3 : -3;
                if (s.offset < 0) s.offset = 0;
            } else if (s.view == READER) {
                if (pressed_action.revision==s.reader.serial && !strcmp(pressed_action.id,s.reader_agent)) {
                    int next=s.offset+(dy<0 ? 5 : -5);
                    s.offset=next<0 ? 0 : next;
                }
#endif
            } else if (s.start_y >= HT_HEIGHT - 66 && dy < 0)
                view(HOME);
#ifndef DEVICE_PRO_COMPANION
            else if (s.view == READER) {
                int next = s.offset + (dy < 0 ? 5 : -5);
                s.offset = next < 0 ? 0 : next;
            }
#endif
            else if (s.view == INBOX && s.notice_count)
                s.offset = (s.offset + (dy < 0 ? 1 : s.notice_count - 1)) % s.notice_count;
            else {
                int count = s.view == AGENTS     ? s.count
                            : s.view == TABS     ? s.tab_count
                            : s.view == MACHINES ? s.machine_count
                            : s.view == MODELS   ? s.model_count
                            : s.view == SETTINGS ? 9
                            : s.view == QUESTION ? s.q.item[s.q.index].count : 0;
                int next = s.offset + (dy < 0 ? 3 : -3);
                if (next >= 0 && next < count) s.offset = next;
            }
        } else if (gesture.axis == 2 && abs(dx) > 60 && abs(dx) > abs(dy)) {
            if (s.view == TABS) {
                // The carousel owns horizontal motion, including contacts that began on its footer.
            } else if (s.view == DRAFT || s.view == DRAFT_OPTIONS
#ifdef DEVICE_PRO_COMPANION
                       || s.view == CARRY_PREVIEW
#endif
                       ) {
                if (dx > 0) {
                    action_t a = make_action((hit_t){.action = s.view == DRAFT ? A_DRAFT_OPTIONS : A_DRAFT_BACK});
                    dispatch(a);
                }
            } else if (s.view == FORM) {
                if (dx > 0) dispatch((action_t){.kind = A_FORM_BACK, .revision = form.page.revision});
            } else if (question_view(s.view)) {
                if (dx>0 && !s.q.pending) {
#ifdef DEVICE_PRO_COMPANION
                    action_t back = pressed_action;
                    back.kind = s.view == QUESTION && (s.q.loading || !s.q.valid ||
                        !s.q.supported || s.q.error[0]) ? A_HOME : A_QUESTION_BACK;
                    dispatch(back);
#else
                    view(s.view==ANSWER_REVIEW ? CHOICE : s.view==CHOICE ? QUESTION : HOME);
#endif
                }
            }
#ifdef DEVICE_PRO_COMPANION
            else if (s.view==READER) {
                if (dx>0) { action_t back=pressed_action; back.kind=A_READER_BACK; dispatch(back); }
            }
#endif
            else if (s.view == INBOX && s.notice_count)
                s.offset = (s.offset + (dx < 0 ? 1 : s.notice_count - 1)) % s.notice_count;
            else if (surface && s.count && s.connected && !s.loading) {
                int i = s.active < 0 ? 0 : (s.active + (dx < 0 ? 1 : s.count - 1)) % s.count;
                action_t a = {.kind = A_AGENT};
                COPY(a.id, s.agents[i].id);
                dispatch(a);
            } else if (!surface)
                view(HOME);
        }
        change();
    }
#if HT_FACE_PX >= 720
    if (!down) { s.tab_strip_held = false; s.tab_strip_drag = 0; }
#endif
    s.touch_down = down;
    s.last_x = x;
    s.last_y = y;
    surface_tick(now);
}
void habitat_touch_cancel(void)
{
#ifdef DEVICE_CREATURE_GALLERY
    ht_gallery_cancel(&gallery);
    return;
#endif
    bool visible = s.touch_down || s.pressed >= 0;
    input_cancel();
    s.touch_down = false; // driver swallows the rest of this contact until a trustworthy UP
    if (visible) change();
}
#ifdef DEVICE_PRO_COMPANION
static bool workspace_gesture_allowed(void)
{
    return s.ready && s.connected && !s.loading && !s.locked &&
           (s.view == HOME || s.view == AGENT) && !display_is_asleep() &&
           !s.voice_open && !s.voice_start_pending && !s.voice_waiting && !audio_client_active() &&
           !form.id[0] && !draft.page.active && !selection.active && !carry.pending &&
           !visit.pending && !s.pending_machine[0] && !s.pending_focus[0] &&
           workspace.phase == HT_WORKSPACE_IDLE && s.tab_count >= 2 &&
           workspace_index(s.selected_tab) >= 0;
}
bool habitat_workspace_gesture_begin(void)
{
    // Promotion ends any one-finger scroll with zero release travel. There is
    // never a synthetic tap UP, including on a written control or voice portrait.
    habitat_touch_cancel();
    if (!workspace_gesture_allowed()) return false;
    int i = workspace_index(s.selected_tab);
    COPY(s.chord_tab, s.selected_tab);
    COPY(s.chord_machine, s.selected_machine);
    COPY(s.chord_previous, i > 0 ? s.tabs[i - 1].id : "");
    COPY(s.chord_next, i + 1 < s.tab_count ? s.tabs[i + 1].id : "");
    s.workspace_chord = true;
    return true;
}
void habitat_workspace_gesture_end(int step)
{
    bool armed = s.workspace_chord;
    s.workspace_chord = false;
    if (!armed || (step != -1 && step != 1) || !workspace_gesture_allowed() ||
        strcmp(s.chord_tab, s.selected_tab) || strcmp(s.chord_machine, s.selected_machine)) return;
    int target = workspace_index(s.selected_tab) + step;
    const char *id = step < 0 ? s.chord_previous : s.chord_next;
    if (!id[0] || target < 0 || target >= s.tab_count || strcmp(id, s.tabs[target].id)) return;
    action_t action = {.kind = A_TAB};
    COPY(action.id, id);
    dispatch(action); // Existing correlated workspace request and roster acknowledgement.
}
#endif
bool habitat_is_voice_view(void) { return s.view == VOICE; }
uint32_t habitat_next_wake_ms(void)
{
#ifdef DEVICE_CREATURE_GALLERY
    return display_is_asleep() ? 1000 : ht_gallery_wake(&gallery, ms());
#endif
    uint32_t delay = 1000, now = ms();
    if (!s.ready)
        return delay;
#ifdef DEVICE_PRO_COMPANION
    if ((s.view == VOICE_SAMPLES || s.view == VOICE_PARAMS) && pro_voice_sample_owns_audio()) {
        int32_t left = (int32_t)(s.sample_poll_due - now);
        delay = left > 0 ? (uint32_t)left : 1;
    }
    if (!s.locked && !display_is_asleep() && pro_appearance_view())
        delay = pro_visual_next_wake_ms(&s.preview_character, HT_CHARACTER_IDLE, now, s.quiet, false);
    if (!s.locked && !display_is_asleep() && (s.view == HOME || s.view == AGENT || s.view == VOICE)) {
        ht_character_t portrait = character;
        if (pro_speech_visible()) {
            portrait.motion.reaction.pose.level = s.speech.level;
            portrait.motion.reaction.pose.emotion = s.speech.emotion;
        }
        delay = pro_visual_next_wake_ms(&portrait, pro_surface_mood(), now, s.quiet,
                                        s.view != VOICE && notice_unread() > 0);
    }
    if (s.speech.id) {
        int32_t left = (int32_t)(s.speech.poll_due - now);
        uint32_t due = left > 0 ? (uint32_t)left : 1;
        if (due < delay) delay = due;
    }
    uint32_t busy_second;
    if (pro_busy_elapsed(active(), now, &busy_second)) {
        uint32_t due = 1000 - (now - active()->busy_ms) % 1000;
        if (due < delay) delay = due;
    }
#endif
    if (s.voice_open && delay > 125)
        delay = 125;
    if (s.view == TABS && tab_carousel.animating && !s.locked && !display_is_asleep()) delay = 16;
    if (selection.pending && delay > 100) delay = 100;
    if (visit.pending && delay > 100) delay = 100;
    if (s.view == FORM && delay > 100) delay = 100;
#ifndef DEVICE_PRO_COMPANION
    if (character.motion.next_ms && character.motion.next_ms < delay) delay = character.motion.next_ms;
#endif
    if (home_caption_rotates() && home_caption.next_ms && home_caption.next_ms < delay)
        delay = home_caption.next_ms;
    if (status_animated()) {
        uint32_t due = status_wake_ms(now);
        if (due < delay) delay = due;
    }
    if ((s.view == HOME || s.view == AGENT) && pressed_action.kind == A_PET && s.touch_down && !s.touch_cancelled &&
        gesture.live && !gesture.moved && !gesture.guarded) {
        uint32_t elapsed = now - s.touch_started;
        uint32_t due = 650;
        uint32_t left = elapsed >= due ? 1 : due - elapsed;
        if (left < delay) delay = left;
    }
    uint32_t deadlines[] = {
#ifdef DEVICE_PRO_COMPANION
                            s.speech_error_until,
                            s.send_feedback.until,
#endif
                            s.pet_pose ? s.pet_until : 0, s.nap ? s.nap_until : 0,
                            s.voice_retry_until};
    for (unsigned i = 0; i < sizeof(deadlines) / sizeof(deadlines[0]); i++)
        if (deadlines[i]) {
            int32_t left = (int32_t)(deadlines[i] - now);
            if (left <= 0)
                return 1;
            if ((uint32_t)left < delay)
                delay = (uint32_t)left;
        }
    return delay;
}
void habitat_tick(void)
{
#ifdef DEVICE_CREATURE_GALLERY
    if (s.ready && !display_is_asleep()) ht_gallery_tick(&gallery, ms());
    return;
#endif
    if (!s.ready)
        return;
    uint32_t now = ms();
    if (s.voice_retry_until && (int32_t)(now - s.voice_retry_until) >= 0) {
        s.voice_retry_until = 0;
        change();
    }
    surface_tick(now);
    if (ht_workspace_tick(&workspace,now)) workspace_failed("The tab did not open. Choose it again.");
    if ((s.q.loading || (s.q.pending && !s.q.uncertain)) && (int32_t)(now-s.q.deadline)>=0) {
        if (s.q.loading) { s.q.loading=false; COPY(s.q.error,"Question did not arrive. Open the alert again."); }
        else { s.q.uncertain=true; COPY(s.q.error,"No answer receipt. Check the terminal before trying again."); }
        change();
    }
    if (ht_selection_tick(&selection, now)) change();
    bool carry_held = s.voice_open && s.voice_carry;
#ifdef DEVICE_PRO_COMPANION
    carry_held = (carry_held || pro_carry_review_owns(&s.carry_review, &draft.page)) &&
        s.carry_review.id[0] && !strcmp(carry.id, s.carry_review.id);
#endif
    if (!carry_held && ht_carry_tick(&carry,now)) {
        if (carry.error[0] && s.view==SELECTION) COPY(selection.error,carry.error);
        change();
    }
    // A background read must not begin halfway through a person's tap/drag.
    // An already pending request still settles or times out normally.
    if (s.view == FORM && (!s.touch_down || form.pending) && ht_form_tick(&form, now)) change();
    if (ht_draft_tick(&draft, now)) {
#ifdef DEVICE_PRO_COMPANION
        if (draft.read_only) s.draft_recovery.ready = false;
#endif
        change();
    }
    if (ht_visit_tick(&visit, now)) {
        s.pending_focus[0] = 0;
        COPY(s.title, "Visit ended");
        COPY(s.message, "The app did not answer. Try the alert again.");
        view(MESSAGE);
    }
    if (selection.active && !s.voice_open &&
        (!s.connected || !active() || strcmp(active()->id, selection.agent))) view(HOME);
    if (s.pet_pose && (int32_t)(now - s.pet_until) >= 0) {
        s.pet_pose = 0;
        change();
    }
    if (s.nap && (int32_t)(now - s.nap_until) >= 0) {
        s.nap = false;
        change();
    }
    if (s.voice_open) {
        display_bump_activity();
        uint32_t second = (now - s.voice_started) / 1000;
        // Recording is explicitly started and finished by the person. The energy estimate can
        // miss quiet speech and normal gaps between syllables; it must never discard their words.
        // Keep the existing duration cap, using the same finalization as tapping Done.
        if (audio_client_recording() && !s.voice_waiting && second >= 600) {
            audio_client_stop();
            s.voice_waiting = true;
            s.voice_wait_until = now + 65000;
            change();
        }
        if (!s.voice_start_pending && !audio_client_active() && !s.voice_waiting &&
            now - s.voice_started > 700) {
            dispatch((action_t){.kind = A_VOICE_ABORT});
            if (s.view == FORM) {
                COPY(form.page.error, "Recording stopped. Say the name again."); form.poll = now + 6000; change();
            } else if (s.view == DRAFT) {
                COPY(draft.page.error, "Recording stopped. Checking your draft."); change();
            } else {
                COPY(s.title, "Voice"); COPY(s.message, "Recording stopped. Please try again."); view(MESSAGE);
            }
        }
        if (s.voice_waiting && (int32_t)(now - s.voice_wait_until) >= 0) {
            dispatch((action_t){.kind = A_VOICE_ABORT});
            if (s.view == FORM) {
                COPY(form.page.error, "Search timed out. Say the name again."); form.poll = now + 6000; change();
            } else if (s.view == DRAFT) {
                COPY(draft.page.error, "No voice reply. Checking your draft."); change();
            } else {
                COPY(s.title, "Voice"); COPY(s.message, "No response yet. Check Harness on your computer."); view(MESSAGE);
            }
        }
    }
}
static void power(bool on)
{
    if (!on) {
#ifdef DEVICE_PRO_COMPANION
        if (pro_appearance_view()) view(HOME);
#endif
        input_cancel();
        if (!s.voice_open && selection.active) view(HOME);
        s.lock_armed = config_lock_enabled();
        return;
    }
    if (s.lock_armed) {
        s.locked = true;
        s.pattern[0] = 0;
        s.pattern_mask = 0;
        s.pattern_len = 0;
        change();
    }
}
void ui_init(void)
{
    display_lock();
    memset(&s, 0, sizeof(s));
    s.active = -1;
    s.pressed = -1;
    s.brightness = (config_load_brightness() * 100 + 127) / 255;
    s.muted = config_load_muted();
#ifdef DEVICE_PRO_COMPANION
    config_load_voicelang(s.voice_language, sizeof s.voice_language);
#endif
    memset(&character, 0, sizeof character);
#ifdef DEVICE_TIM_ILLUSTRATED
    ht_tim_illustrated_init();
    if (!config_select_illustrated_tim_once())
        ESP_LOGW("tim-art", "first-run character selection was not saved");
#endif
    memset(&home_caption, 0, sizeof home_caption);
    uint8_t saved_character = config_load_habitat_character((uint8_t)ht_character_default());
    if (!ht_character_select(&character, (ht_character_id_t)saved_character))
        ht_character_select(&character, ht_character_default());
#ifdef DEVICE_PRO_COMPANION
    uint16_t appearance = config_load_pro_appearance((uint16_t)character.id | (PRO_SCENE_MATCH << 8));
    if (!ht_character_select(&character, (ht_character_id_t)(appearance & 255)))
        ht_character_select(&character, ht_character_default());
    unsigned scene = appearance >> 8;
    s.scene_choice = scene < PRO_SCENE_COUNT ? (pro_scene_id_t)scene : PRO_SCENE_MATCH;
    pro_visual_init();
#endif
    ESP_LOGI("habitat", "character %s; shared moods and controls", ht_character_name(character.id));
    uint8_t options = config_load_habitat_options();
    s.focus_face = (options & 1) != 0;
    s.rim_enabled = (options & 2) != 0;
    s.quiet = (options & 4) != 0;
    s.straight_title = (options & 8) != 0;
    s.ready = true;
#ifdef DEVICE_CREATURE_GALLERY
    ht_gallery_init(&gallery, ms());
    ESP_LOGI("gallery", "20 text creatures / local only; swipe X creature, Y mood or speed, tap replay");
#endif
    s.loading = true;
    s.view = HOME;
#ifdef DEVICE_PRO_COMPANION
    pro_draft_restore();
#endif
    s.dirty = true;
    scroll_reversed = config_load_scroll_reversed();
    s.locked = config_lock_enabled();
    display_set_power_cb(power);
    actions = xQueueCreate(8, sizeof(action_t));
    assert(actions);
    assert(xTaskCreate(worker, "habitat_actions", 6144, NULL, 4, NULL) == pdPASS);
    display_unlock();
    habitat_render_notify();
}
void ui_set_brightness(uint8_t level)
{
    display_lock();
    s.brightness = (level * 100 + 127) / 255;
#ifdef DEVICE_PRO_COMPANION
    display_set_brightness(level);
#endif
    change();
    display_unlock();
}

// Protocol-facing adapter. The cable reader never waits for rendering or a DMA transaction.
#ifdef DEVICE_PRO_COMPANION
static void pro_result_source_reset(void)
{
    if (!++s.result_generation) ++s.result_generation;
    s.notice_count=0;
    memset(s.notice_reads,0,sizeof s.notice_reads);
    s.notice_read_next=0;
    memset(s.memory,0,sizeof s.memory);
    s.memory_serial=0;
    for (int i=0;i<s.count;i++) {
        s.agents[i].preview[0]=s.agents[i].full[0]=0;
        s.agents[i].has_event=s.agents[i].recap_ready=false;
    }
}
static void pro_notice_source(const char *host)
{
    const char *next=host && host[0] && strnlen(host,ID_MAX)<ID_MAX ? host : "";
    if (next[0] && !strcmp(next,s.notice_host)) return;
    // Agent IDs and unread tokens are scoped to the cable owner. A repeated
    // legacy welcome without an identity is not another computer, but cannot
    // establish question ownership or enable the reader's desktop actions.
    if (strcmp(next,s.notice_host)) pro_result_source_reset();
    else {
        for (int i=s.notice_count-1;i>=0;i--) if (s.notice[i].question) {
            memmove(&s.notice[i],&s.notice[i+1],(size_t)(s.notice_count-i-1)*sizeof s.notice[0]);
            s.notice_count--;
        }
        for (int i=0;i<NOTICES;i++) if (s.notice_reads[i].question)
            memset(&s.notice_reads[i],0,sizeof s.notice_reads[i]);
    }
    // An open reader keeps its frozen words and original owner, read-only.
    input_cancel();
    COPY(s.notice_host,next);s.notice_overflow=false;
    if (!s.q.pending) {
        s.q.valid=s.q.loading=false; s.q.revision++;
        if (question_view(s.view)) view(HOME);
    } else {
        s.q.valid=s.q.loading=false; s.q.uncertain=true; s.q.revision++;
        COPY(s.q.error,"No answer receipt. Check the terminal before trying again.");
    }
    notice_sync_view();
    change();
}
#endif
void ui_set_connected(bool value)
{
#ifdef DEVICE_PRO_COMPANION
    uint32_t roster_generation = cable_client_agent_generation();
#endif
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if (s.connected != value) {
        pro_reader_focus(NULL);
        s.work_roster_pending = true;
        s.work_roster_after = roster_generation;
    }
#endif
    if (!value) {
#ifdef DEVICE_PRO_COMPANION
        pro_send_feedback_clear();
        for (int i = 0; i < s.notice_count; i++) s.notice[i].question_current = false;
        if (!s.notice_host[0]) {
            // An unidentified host cannot prove ownership after a new link.
            pro_result_source_reset();
            pro_notice_source(NULL);
        }
        pro_busy_reset();
        pro_metrics_source(&s.metrics,NULL,false);
        pro_draft_recovery_disconnect(&s.draft_recovery);
#endif
        input_cancel();
        s.voice_retry_until = 0;
        s.pending_machine[0] = 0;
        // A reconnect may bring a newer saved result than our last live event.
        for (int i = 0; i < PANE_MEMORY_MAX; i++) s.memory[i].live_summary = false;
        if (workspace.phase!=HT_WORKSPACE_IDLE) {
            ht_workspace_cancel_request(&workspace); s.loading=false; s.active=-1; view(HOME);
        }
#ifdef DEVICE_PRO_COMPANION
        if (s.q.pending) {
            s.q.valid=s.q.loading=false; s.q.uncertain=true; s.q.revision++;
            COPY(s.q.error,"No answer receipt. Check the terminal before trying again.");
            if (question_view(s.view)) view(QUESTION);
        } else {
            s.q.valid=s.q.loading=false; s.q.revision++;
            if (question_view(s.view)) view(HOME);
        }
#else
        s.q.valid=s.q.loading=s.q.pending=false; s.q.revision++;
        if (question_view(s.view)) view(HOME);
#endif
        ht_visit_close(&visit);
        ht_carry_close(&carry);
    }
    s.connected = value;
    if (!value && form.id[0]) { ht_form_reset(&form); view(HOME); }
    if (!value && draft.page.active) {
#ifdef DEVICE_PRO_COMPANION
        ht_draft_detach(&draft);
        if (pro_carry_review_owns(&s.carry_review, &draft.page)) s.carry_review.detached = true;
        COPY(draft.page.error, "Connection ended. Only this part is here.");
#else
        ht_draft_reset(&draft); view(HOME);
#endif
    }
    if (!value && (s.voice_open || audio_client_active())) {
        audio_client_abort();
        voice_close();
#ifdef DEVICE_PRO_COMPANION
        if (draft.page.active) view(DRAFT);
        else
#endif
        view(HOME);
    }
#ifdef DEVICE_PRO_COMPANION
    if (!value && draft.page.active) view(DRAFT);
#endif
    change();
    display_unlock();
}
#ifdef DEVICE_PRO_COMPANION
bool ui_draft_source(const char *machine)
{
    uint32_t roster_generation = cable_client_agent_generation();
    display_lock();
    pro_notice_source(s.connected ? machine : NULL);
    bool changed = pro_draft_recovery_source(&s.draft_recovery, s.connected ? machine : NULL);
    if (changed) {
        // A welcome can change owner without a prior disconnect. Old rows and
        // fleet state are not evidence about the new computer. Only a newer
        // completed roster may enable a fresh recording after this boundary.
        s.work_roster_pending = true;
        s.work_roster_after = roster_generation;
        s.machine_count = 0;
        pro_send_feedback_clear();
        pro_busy_reset();
        input_cancel();
        if (draft.page.active) {
            ht_draft_detach(&draft);
            if (pro_carry_review_owns(&s.carry_review, &draft.page)) s.carry_review.detached = true;
            snprintf(draft.page.error, sizeof draft.page.error, "%s", s.draft_recovery.has_words ? "Only this part is here." : "");
        }
        // A new welcome cannot accept an edit result captured on the prior link.
        if (s.voice_open || audio_client_active()) {
            audio_client_abort(); voice_close();
            if (!draft.page.active) view(HOME);
        }
        if (draft.page.active) view(DRAFT);
        change();
    }
    display_unlock();
    return changed;
}
void ui_metrics_source(const char *machine, bool supported)
{
    display_lock();
    bool was=s.metrics.supported; char previous[48]; COPY(previous,s.metrics.machine);
    pro_metrics_source(&s.metrics,machine,supported && s.connected);
    if (was!=s.metrics.supported || strcmp(previous,s.metrics.machine)) {
        if (s.view==TODAY) input_cancel();
        change();
    }
    display_unlock();
}
void ui_metrics_state(const cJSON *p)
{
    display_lock();
    if (s.connected && s.view==TODAY && s.metrics.supported && pro_metrics_reply(&s.metrics,p,ms())) change();
    display_unlock();
}
#endif
void ui_project_set_name(const char *id, const char *name)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    int previous = find(id);
    if ((s.view == AGENTS || s.workspace_chord) &&
        (previous < 0 || strcmp(s.agents[previous].name, name ? name : ""))) input_cancel();
#endif
    int i = ensure(id);
    if (i >= 0) {
        COPY(s.agents[i].name, name);
        change();
    }
    display_unlock();
}
void ui_project_set_engine(const char *id, const char *engine)
{
    display_lock();
    int i = find(id);
    if (i >= 0) {
        COPY(s.agents[i].engine, engine);
        change();
    }
    display_unlock();
}
void ui_project_set_machine(const char *id, const char *machine_id, const char *name)
{
    display_lock();
    int i = find(id);
    if (i >= 0) {
#ifdef DEVICE_PRO_COMPANION
        // Never turn an oversized opaque identity into a matching prefix.
        if (!machine_id || strnlen(machine_id, ID_MAX) >= ID_MAX) machine_id = "";
        if (!strcmp(s.send_feedback.agent, id) && strcmp(s.agents[i].machine_id, machine_id))
            pro_send_feedback_clear();
#endif
        COPY(s.agents[i].machine_id, machine_id);
        COPY(s.agents[i].machine, name);
        change();
    }
    display_unlock();
}
void ui_project_fill_missing_engine(const char *engine)
{
    display_lock();
    for (int i = 0; i < s.count; i++)
        if (!s.agents[i].engine[0])
            COPY(s.agents[i].engine, engine);
    change();
    display_unlock();
}
void ui_project_set_selected_model(const char *id, const char *model)
{
    display_lock();
    int i = find(id);
    if (i >= 0) {
        COPY(s.agents[i].model, model);
        change();
    }
    display_unlock();
}
void ui_project_reconcile_selected_model(const char *id, const char *model)
{
    ui_project_set_selected_model(id, model);
}
void ui_projects_bulk_begin(void)
{
    display_lock();
    s.bulk++;
    display_unlock();
}
void ui_projects_bulk_end(void)
{
    display_lock();
    if (s.bulk)
        s.bulk--;
    change();
    display_unlock();
}
void ui_project_remove(const char *id)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if (id && !strcmp(id, s.send_feedback.agent)) pro_send_feedback_clear();
#endif
    int i = find(id);
    if (i >= 0) {
#ifdef DEVICE_PRO_COMPANION
        if (s.active==i) pro_reader_focus(NULL);
#endif
        if (s.active == i
#ifdef DEVICE_PRO_COMPANION
            || s.view == AGENTS || s.workspace_chord
#endif
        ) {
            input_cancel();
        }
        memmove(&s.agents[i], &s.agents[i + 1], (size_t)(s.count - i - 1) * sizeof(agent_t));
        s.count--;
        if (s.active > i)
            s.active--;
        else if (s.active >= s.count)
            s.active = s.count - 1;
        change();
    }
    display_unlock();
}
void ui_project_clear_all(void)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    pro_send_feedback_clear();
    pro_reader_focus(NULL);
#endif
    input_cancel();
    s.count = 0;
    s.active = -1;
    change();
    display_unlock();
}
void ui_project_apply_order(const char *const *ids, int n)
{
    static EXT_RAM_BSS_ATTR agent_t swap;
    display_lock();
    char selected[ID_MAX] = "";
    if (active())
        COPY(selected, active()->id);
    for (int i = 0; i < n && i < s.count; i++) {
        int j = find(ids[i]);
        if (j >= 0 && j != i) {
#ifdef DEVICE_PRO_COMPANION
            if (s.view == AGENTS || s.workspace_chord) input_cancel();
#endif
            swap = s.agents[i];
            s.agents[i] = s.agents[j];
            s.agents[j] = swap;
        }
    }
    s.active = find(selected);
    change();
    display_unlock();
}
int ui_project_count(void)
{
    display_lock();
    int n = s.count;
    display_unlock();
    return n;
}
bool ui_project_id_at(int i, char *buf, size_t n)
{
    display_lock();
    bool ok = i >= 0 && i < s.count;
    if (ok)
        copy(buf, n, s.agents[i].id);
    display_unlock();
    return ok;
}
bool ui_project_known(const char *id)
{
    display_lock();
    bool ok = find(id) >= 0;
    display_unlock();
    return ok;
}
bool ui_project_has_event(const char *id)
{
    display_lock();
    int i = find(id);
    bool ok = i >= 0 && s.agents[i].has_event;
    display_unlock();
    return ok;
}
bool ui_project_is_busy(const char *id)
{
    display_lock();
    int i = find(id);
    bool ok = i >= 0 && s.agents[i].busy;
    display_unlock();
    return ok;
}
static void event(const char *id, const char *session, const char *kind, const char *text_,
                  const char *recap, bool restore)
{
    display_lock();
    pane_memory_t *m = pane_memory(id, true);
    if (!m) { display_unlock(); return; }
    int i = find(id);
    agent_t *a = i >= 0 ? &s.agents[i] : NULL;
#ifdef DEVICE_PRO_COMPANION
    if (session && *session && !strcmp(s.send_feedback.agent, id) &&
        strcmp(s.send_feedback.session, session)) pro_send_feedback_clear();
    if (!restore && session && *session && strcmp(m->session, session)) {
        m->busy = false;
        m->busy_ms = m->last_busy = 0;
        m->activity[0] = 0;
        if (a) {
            a->busy = false;
            a->busy_ms = a->last_busy = 0;
            a->tool[0] = 0;
            COPY(a->session, session);
            change();
        }
    }
#endif
    if (session && *session)
        COPY(m->session, session);
    if (kind && !strcmp(kind, "activity")) {
        // Activity is a read of the current terminal, not a new turn or a recap.
        // A late read must never reanimate an idle pane.
        if (m->busy && ms() - m->last_busy <= 25000) {
            activity_text(m->activity, sizeof m->activity, text_);
            if (a) { COPY(a->tool, m->activity); change(); }
        }
        display_unlock(); return;
    }
    if (kind && (!strcmp(kind, "processing") || !strcmp(kind, "summarizing"))) {
        if (!restore
#ifdef DEVICE_PRO_COMPANION
            && s.connected
#endif
        ) {
#ifdef DEVICE_PRO_COMPANION
            // A heartbeat can arrive before the periodic stale-state prune.
            if (m->busy && ms() - m->last_busy > 25000) m->busy = false;
#endif
            if (!m->busy) {
                m->busy_ms = ms();
                m->activity[0] = 0;
                if (a && i == s.active) s.character_activity++;
            }
            m->busy = true;
            m->awaiting_result = true;
            m->last_busy = ms();
            // Old bridges send these generic labels. Keep liveness, but do not
            // pretend they are words being displayed by the agent itself.
            if (text_ && *text_ && strcmp(text_, "Processing") &&
                strcmp(text_, "Summarizing...") && strcmp(text_, "Summarizing\xe2\x80\xa6"))
                activity_text(m->activity, sizeof m->activity, text_);
            if (a) {
                a->busy = true;
                a->recap_ready = false;
                a->busy_ms = m->busy_ms;
                a->last_busy = m->last_busy;
                COPY(a->session, m->session);
                COPY(a->tool, m->activity);
            }
        }
        if (a) change();
        display_unlock();
        return;
    }
    if (!restore) { m->busy = false; m->activity[0] = 0; }
    bool has_text = text_ && *text_ && strcmp(text_, "done");
    if ((has_text || (recap && *recap)) && !(restore && (m->live_summary || m->awaiting_result || m->busy))) {
        char preview[sizeof m->preview];
        recap_preview(preview, sizeof preview, recap && *recap ? recap : text_);
        // Retain history privately, but a new turn stays in presence mode until
        // its own live result arrives. Late history cannot resurrect an old recap.
        if (preview[0]) {
            m->awaiting_result = false;
            // An opened off-tab notification can precede its first history
            // snapshot. Fill that empty record without showing the same result
            // twice. Every new live result still becomes visible normally.
            if (!restore || (m->preview[0] && strcmp(m->preview, preview))) m->dismissed = false;
            COPY(m->preview, preview);
            COPY(m->full, has_text ? text_ : recap);
            if (!restore) m->live_summary = true;
        }
    }
    pane_memory_apply(a, m);
    // Agent events may belong to an earlier turn. Only the voice result finishes voice UI.
    if (a) change();
    display_unlock();
}
void ui_project_emit(const char *id, const char *session, const char *kind, const char *text_,
                     const char *recap)
{
    event(id, session, kind, text_, recap, false);
}
void ui_project_restore_event(const char *id, const char *kind, const char *text_,
                              const char *recap)
{
    event(id, NULL, kind, text_, recap, true);
}
void ui_project_clear_event(const char *id)
{
    display_lock();
    pane_memory_t *m = pane_memory(id, false);
    if (m) { m->preview[0] = m->full[0] = 0; m->live_summary = false; }
    int i = find(id);
    if (i >= 0) {
        s.agents[i].preview[0] = 0;
        s.agents[i].full[0] = 0;
        s.agents[i].has_event = false;
        s.agents[i].recap_ready = false;
        change();
    }
    display_unlock();
}
void ui_project_set_busy_tokens(const char *id, int tokens)
{
    display_lock();
    int i = find(id);
    if (i >= 0)
        s.agents[i].tokens = tokens;
    display_unlock();
}
void ui_project_set_tool(const char *id, const char *name, const char *title, const char *hex,
                         const char *detail)
{
    (void)hex;
    (void)detail;
    display_lock();
    int i = find(id);
    if (i >= 0) {
        char next[sizeof(s.agents[i].tool)];
        snprintf(next, sizeof(next), "%s%s%s", name ? name : "",
                 title && *title ? ": " : "", title ? title : "");
        if (i == s.active && strcmp(next, s.agents[i].tool)) s.character_activity++;
        snprintf(s.agents[i].tool, sizeof(s.agents[i].tool), "%s%s%s", name ? name : "",
                 title && *title ? ": " : "", title ? title : "");
        change();
    }
    display_unlock();
}
void ui_project_set_todos(const char *id, const cJSON *todos)
{
    display_lock();
    int i = find(id);
    if (i >= 0) {
        const cJSON *t;
        cJSON_ArrayForEach(t, todos)
        {
            const cJSON *status = cJSON_GetObjectItemCaseSensitive(t, "status"),
                        *content = cJSON_GetObjectItemCaseSensitive(t, "content");
            if (cJSON_IsString(status) && !strcmp(status->valuestring, "in_progress") &&
                cJSON_IsString(content)) {
                if (i == s.active && strcmp(s.agents[i].tool, content->valuestring)) s.character_activity++;
                COPY(s.agents[i].tool, content->valuestring);
                change();
                break;
            }
        }
    }
    display_unlock();
}
void ui_project_set_agents(const char *id, const cJSON *agents)
{
    (void)id;
    (void)agents; /* Detail stays on the desktop; the face shows the current tool. */
}
int ui_prune_stale_busy(void)
{
    display_lock();
    int n = 0;
    uint32_t now = ms();
    for (int i = 0; i < s.count; i++)
        if (s.agents[i].busy && now - s.agents[i].last_busy > 25000) {
            s.agents[i].busy = false;
            pane_memory_t *m = pane_memory(s.agents[i].id, false);
            if (m) m->busy = false;
            n++;
        }
    if (n)
        change();
    display_unlock();
    return n;
}
void ui_cancel_acked(const char *session)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    for (int i = 0; i < PANE_MEMORY_MAX; i++)
        if (session && *session && !strcmp(s.memory[i].session, session))
            s.memory[i].busy = false;
#endif
    for (int i = 0; i < s.count; i++)
        if (session && !strcmp(s.agents[i].session, session)) {
            s.agents[i].busy = false;
            pane_memory_t *m = pane_memory(s.agents[i].id, false);
            if (m) m->busy = false;
            change();
        }
    display_unlock();
}
void ui_fleet_set(int total, bool window)
{
    display_lock();
    s.total = total;
    s.window = window;
    change();
    display_unlock();
}
void ui_focus_project(const char *id)
{
    if (!id || !*id || strnlen(id, ID_MAX) >= ID_MAX) return;
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    pro_reader_focus(id);
#endif
    int i = find(id);
    if (i < 0) {
        COPY(s.pending_focus, id);
        display_unlock();
        return;
    }
    bool requested = s.pending_focus[0] && !strcmp(s.pending_focus, id);
    s.pending_focus[0] = 0;
    bool opened = s.opening_notice[0] && !strcmp(s.opening_notice, id);
    if (opened) s.opening_notice[0] = 0;
    if (s.active != i) {
#ifdef DEVICE_PRO_COMPANION
        pro_send_feedback_clear();
#endif
        input_cancel();
    }
    s.active = i;
    // Focus changes the main surface's recipient. Voice and confirmations keep their pinned targets.
    // A requested remote open lands only after the host has supplied that agent.
    if (opened && s.view == INBOX) view(HOME);
    else if (requested && s.view == MESSAGE && !visit.pending) {
#ifndef DEVICE_PRO_COMPANION
        if (visit.available && !strcmp(visit.agent,id) && is_question(id)) open_question();
        else view(AGENT);
#else
        view(AGENT);
#endif
    }
    if (visit.available && !visit.pending && strcmp(visit.agent, id)) ht_visit_close(&visit);
    change();
    display_unlock();
}
void ui_apply_pending_focus(void)
{
    display_lock();
    char id[ID_MAX];
    COPY(id, s.pending_focus);
    display_unlock();
    if (id[0] && ui_project_known(id))
        ui_focus_project(id);
}
void ui_show_projects(void)
{
    display_lock();
    view(HOME);
    display_unlock();
}
void ui_enter_boot_loading(void)
{
    display_lock();
    s.loading = true;
    view(HOME);
    display_unlock();
}
void ui_land_after_reload(void)
{
    display_lock();
    if (s.loading && (workspace.phase==HT_WORKSPACE_IDLE || workspace.phase==HT_WORKSPACE_READY)) {
        ht_workspace_cancel_request(&workspace);
        s.loading = false;
#if HT_FACE_PX >= 720
        // Re-checked here as well as at the tap: the swarm row can arrive with a truer pane count
        // between asking for a tab and landing in it, and this is the last moment it matters.
        view(s.land_on_desk && pro_panes_of(s.selected_tab) > 1 ? AGENTS : HOME);
        s.land_on_desk = false;
#else
        view(HOME);
#endif
    }
    change();
    display_unlock();
}
void ui_workspace_applied(const char *tab, uint32_t generation)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if (s.connected && s.work_roster_pending && (int32_t)(generation - s.work_roster_after) > 0) {
        s.work_roster_pending = false;
        change();
    }
#endif
    if (!strcmp(s.selected_tab,workspace.pending)) ht_workspace_applied(&workspace,tab,generation);
    display_unlock();
}
void ui_report_active_agent(void)
{
    display_lock();
    action_t a = {.kind = A_AGENT};
    if (active())
        COPY(a.id, active()->id);
    if (a.id[0])
        queue(a);
    display_unlock();
}
int ui_get_active_project_index(void)
{
    display_lock();
    int i = s.view == HOME || s.view == AGENT || s.view == READER || s.view == QUESTION ? s.active : -1;
    display_unlock();
    return i;
}
const char *ui_get_active_project_id(void) { return active() ? active()->id : NULL; }
const char *ui_get_active_session_id(void) { return active() ? active()->session : NULL; }
bool ui_is_projects_active(void)
{
    return !s.locked && (s.view == HOME || s.view == AGENT || s.view == AGENTS);
}
bool ui_reader_is_open(void) { return s.view == READER; }
bool ui_picker_is_open(void) { return s.view == MODELS || s.view == MACHINES || s.view == TABS; }
bool ui_switch_is_open(void) { return s.view == TABS; }
bool ui_scroll_reportable(void)
{
    return s.ready && s.connected && !s.loading && !s.locked && (s.view == HOME || s.view == AGENT) && active() &&
           !display_is_asleep() && !s.voice_open && !audio_client_active();
}
int ui_notif_pull_zone_px(void) { return 0; }
bool ui_action_hit(uint16_t x, uint16_t y)
{
    (void)x;
    (void)y;
    return true;
}
void ui_swipe_begin(void) {}
void ui_swipe_end(int dir)
{
    display_lock();
    if (s.count) {
        int next=(s.active + (dir > 0 ? 1 : s.count - 1)) % s.count;
#ifdef DEVICE_PRO_COMPANION
        pro_reader_focus(s.agents[next].id);
#endif
        s.active = next;
        view(AGENT);
    }
    display_unlock();
}
void ui_home_overview(void)
{
    display_lock();
    view(HOME);
    display_unlock();
}
void ui_tap(int32_t x, int32_t y)
{
    display_lock();
    habitat_touch(true, x, y, ms());
    habitat_touch(false, x, y, ms());
    display_unlock();
}
void ui_notif_open(void)
{
    display_lock();
    notice_open();
    display_unlock();
}
void ui_notif_close(void)
{
    display_lock();
    if (s.view == INBOX)
        view(HOME);
    display_unlock();
}
bool ui_notif_is_open(void) { return s.view == INBOX; }
bool ui_notif_pill_hit(uint16_t x, uint16_t y)
{
    (void)x;
    (void)y;
    return false;
}
void ui_notif_swipe_up(void) { ui_notif_close(); }
static void notice_remove(const char *id, bool questions_too)
{
    if (!id) return;
    for (int i = s.notice_count - 1; i >= 0; i--)
        if (!strcmp(s.notice[i].agent_id, id) && (questions_too || !s.notice[i].question)) {
            memmove(&s.notice[i], &s.notice[i + 1],
                    (size_t)(s.notice_count - i - 1) * sizeof(cable_notif_t));
            s.notice_count--;
            if (s.view == INBOX && i < s.offset) s.offset--;
        }
}
static void notice_sync_view(void)
{
    if (s.view != INBOX) return;
    // Reconcile after the complete mutation, never during remove-then-add.
    // Cancel a finger already down so the new home cannot receive its release.
    input_cancel();
    if (!s.notice_count) {
#ifdef DEVICE_PRO_COMPANION
        if (s.q.pending || s.notice_overflow) { s.offset=0; return; }
#endif
        view(HOME);
    }
    else if (s.offset >= s.notice_count) s.offset = s.notice_count - 1;
}
static void notice_selection(char *id, size_t capacity)
{
#ifdef DEVICE_PRO_COMPANION
    if (s.view==READER && pro_reader_notice_index()>=0) { copy(id,capacity,s.reader_agent); return; }
#endif
    copy(id, capacity, s.view == INBOX && s.offset >= 0 && s.offset < s.notice_count
        ? s.notice[s.offset].agent_id : "");
}
static void notice_restore_selection(const char *id)
{
    if (s.view != INBOX || !id[0]) return;
    for (int i = 0; i < s.notice_count; i++)
        if (!strcmp(id, s.notice[i].agent_id)) { s.offset = i; return; }
}
#ifdef DEVICE_PRO_COMPANION
static bool pro_notice_pinned(const cable_notif_t *n, const char *selected)
{
    if (!strcmp(n->agent_id,selected)) return true;
    if (!n->question || strcmp(n->agent_id,s.q.agent) || strcmp(s.q.host,s.notice_host) ||
        !(s.q.pending || (question_view(s.view) && (s.q.valid || s.q.loading)))) return false;
    return (s.q.request[0] && !strcmp(n->question_id,s.q.request) && n->question_signature==s.q.signature) ||
        (s.q.notice_token[0] && !strcmp(n->read_token,s.q.notice_token));
}
#endif
static void notice_add(const char *id, const char *name, const char *machine, const char *recap,
                       bool question, bool failed)
{
    if (!id || !*id || strnlen(id, ID_MAX) >= ID_MAX) return;
    char selected[ID_MAX]; notice_selection(selected, sizeof selected);
#ifdef DEVICE_PRO_COMPANION
    // A completion/unread result does not resolve an independently pending question.
    if (!question) for (int i=0; i<s.notice_count; i++)
        if (s.notice[i].question && !strcmp(s.notice[i].agent_id,id)) return;
#endif
    notice_remove(id, true);
    if (s.notice_count == NOTICES) {
        // Keep a message being read even when the bounded inbox fills. The
        // oldest other message gives way; arrival never moves the current card.
        int drop = s.notice_count - 1;
#ifdef DEVICE_PRO_COMPANION
        // The host has at most 64 pending questions. Results may consume spare
        // rows but cannot evict an unresolved question or the current reader.
        while (drop>=0 && (s.notice[drop].question || !strcmp(selected,s.notice[drop].agent_id))) drop--;
        if (drop<0 && question) {
            // Overflow is a local display limit, never an answered/closed event.
            drop=s.notice_count-1;
            while (drop>=0 && pro_notice_pinned(&s.notice[drop],selected)) drop--;
            if (drop>=0) s.notice_overflow=true;
        }
        if (drop<0) return;
#else
        if (!strcmp(selected, s.notice[drop].agent_id)) drop--;
#endif
        memmove(&s.notice[drop], &s.notice[drop + 1],
                (size_t)(s.notice_count - drop - 1) * sizeof(cable_notif_t));
        s.notice_count--;
    }
    int pos = 0;
    if (!question)
        while (pos < s.notice_count && s.notice[pos].question)
            pos++;
    memmove(&s.notice[pos + 1], &s.notice[pos],
            (size_t)(s.notice_count - pos) * sizeof(cable_notif_t));
    s.notice_count++;
    cable_notif_t *n = &s.notice[pos];
    memset(n, 0, sizeof(*n));
    COPY(n->agent_id, id);
    COPY(n->name, name && *name ? name : "Harness");
    COPY(n->machine, machine);
    recap_preview(n->summary, sizeof n->summary, recap);
    n->question = question;
    n->failed = failed;
    n->read_on_dial = notice_was_read(n);
    if (!++s.notice_revision) ++s.notice_revision;
    n->display_revision = s.notice_revision;
    notice_restore_selection(selected);
    notice_sync_view();
}
void ui_notify_task_done(const char *id, const char *name, const char *machine, const char *recap)
{
    if (!id || !*id || strnlen(id, ID_MAX) >= ID_MAX) return;
    display_lock();
    notice_forget_read(id); // A fresh completion is new even if its words repeat.
    notice_add(id, name, machine, recap, false, false);
    s.notice_sequence++;
    uint32_t now = ms();
    if (!waiting() && !s.nap && !s.quiet && (!s.last_celebration || now - s.last_celebration >= 20000)) {
        s.pet_pose = 3;
        s.pet_until = now + 2000;
        s.last_celebration = now;
    }
    change();
    display_wake();
    display_unlock();
}
void ui_notif_seen(const char *id)
{
    display_lock();
    bool opened = id && s.opening_notice[0] && !strcmp(s.opening_notice, id);
    for (int i = 0; id && i < s.notice_count; i++)
        if (!strcmp(s.notice[i].agent_id, id)) notice_mark_read(&s.notice[i]);
#ifdef DEVICE_PRO_COMPANION
    int held=s.view==READER ? pro_reader_notice_index() : -1;
    if (opened || held<0 || !id || strcmp(id,s.notice[held].agent_id)) notice_remove(id,false);
#else
    notice_remove(id, false);
#endif
    notice_sync_view();
    change();
    display_unlock();
    // An already-focused desktop pane may only echo "seen", with no focus
    // change. That acknowledgement also completes the requested inbox open.
    if (opened) ui_focus_project(id);
}
void ui_notif_read(const char *id, const char *token)
{
    if (!id || !token || !token[0]) return;
    display_lock();
    for (int i = 0; i < NOTICES; i++)
        if (!strcmp(s.notice_reads[i].id, id) && !strcmp(s.notice_reads[i].token, token))
            s.notice_reads[i].pending = false;
    bool opened = false;
    for (int i = 0; i < s.notice_count; i++) {
        cable_notif_t *n = &s.notice[i];
        if (strcmp(n->agent_id, id) || strcmp(n->read_token, token)) continue;
        n->read_on_dial = true;
        opened = !strcmp(s.opening_notice, id);
#ifdef DEVICE_PRO_COMPANION
        if (!n->question && (opened || ((s.view!=INBOX || i!=s.offset) &&
            (s.view!=READER || !pro_reader_matches(n))))) {
#else
        if (s.view != INBOX || i != s.offset || opened) {
#endif
            notice_remove(id, true); notice_sync_view();
        }
        change(); break;
    }
    display_unlock();
    if (opened) ui_focus_project(id);
}
#ifdef DEVICE_PRO_COMPANION
typedef struct {
    uint32_t revision;
    int8_t old, row, token;
} pro_notice_plan_t;

static const cable_notif_t *pro_notice_plan_source(const pro_notice_plan_t *p, const cable_notif_t *rows)
{
    return p->row >= 0 ? &rows[p->row] : &s.notice[p->old];
}
static void pro_notice_plan_card(cable_notif_t *dst, const pro_notice_plan_t *p,
                                 const cable_notif_t *rows, const cable_notif_t *old)
{
    if (p->row < 0) { *dst=*old; return; }
    const cable_notif_t *row=&rows[p->row];
    memset(dst,0,sizeof *dst);
    COPY(dst->agent_id,row->agent_id);
    COPY(dst->name,row->name[0] ? row->name : "Harness");
    COPY(dst->machine,row->machine);
    recap_preview(dst->summary,sizeof dst->summary,row->summary);
    dst->question=row->question;dst->failed=row->failed;
    COPY(dst->read_token,rows[p->token].read_token);
    dst->read_on_dial=notice_was_read(dst);
    dst->display_revision=p->revision;
    dst->question_current=dst->question && s.connected;
    if (old) {
        COPY(dst->question_id,old->question_id);
        dst->question_signature=old->question_signature;
        dst->question_unavailable=old->question_unavailable;
        dst->read_on_dial=old->read_on_dial;
    }
}
static void pro_notice_replace(const cable_notif_t *rows, int count, const char *selected)
{
    // The display lock protects this small plan. Keep every old card intact
    // until the merge is decided; no second 72-card copy or heap allocation.
    static pro_notice_plan_t plan[NOTICES];
    static uint8_t origin[NOTICES];
    _Static_assert(NOTICES <= INT8_MAX, "notification plan indices must fit");
    cable_notif_t card;
    int old_count=s.notice_count, used=0, cursor=s.offset, held=-1;
    int selected_index=s.view==READER ? pro_reader_notice_index() : s.view==INBOX ? s.offset : -1;
    if (selected[0] && selected_index>=0 && selected_index<old_count &&
        s.notice[selected_index].read_on_dial &&
        (s.notice[selected_index].read_token[0] || s.view==READER)) held=selected_index;
    // Mirror notice_add's ordering and revisions without overwriting sources.
    for (int i=count-1;i>=0;i--) {
        const cable_notif_t *row=&rows[i];
        if (!row->agent_id[0] || strnlen(row->agent_id,ID_MAX)>=ID_MAX) continue;
        int found=-1;
        for (int j=0;j<used;j++) if (!strcmp(pro_notice_plan_source(&plan[j],rows)->agent_id,row->agent_id)) { found=j;break; }
        if (found>=0 && !row->question && pro_notice_plan_source(&plan[found],rows)->question) {
            plan[found].token=i; // Same duplicate-row behavior as notice_add + token assignment.
            continue;
        }
        const char *current=s.view==INBOX && cursor>=0 && cursor<used ? pro_notice_plan_source(&plan[cursor],rows)->agent_id : "";
        if (found>=0) {
            memmove(&plan[found],&plan[found+1],(size_t)(used-found-1)*sizeof *plan);used--;
            if (s.view==INBOX && found<cursor) cursor--;
        }
        int pos=0;
        if (!row->question) while (pos<used && pro_notice_plan_source(&plan[pos],rows)->question) pos++;
        memmove(&plan[pos+1],&plan[pos],(size_t)(used-pos)*sizeof *plan);used++;
        if (!++s.notice_revision) ++s.notice_revision;
        plan[pos]=(pro_notice_plan_t){.old=-1,.row=i,.token=i,.revision=s.notice_revision};
        if (s.view==INBOX) {
            if (current[0]) for (int j=0;j<used;j++) if (!strcmp(pro_notice_plan_source(&plan[j],rows)->agent_id,current)) { cursor=j;break; }
            if (cursor>=used) cursor=used-1;
        }
    }
    // Reserve the selected read result before retaining absent questions.
    if (held>=0 && !s.notice[held].question) {
        bool present=false;
        for (int i=0;i<used;i++) if (!strcmp(pro_notice_plan_source(&plan[i],rows)->agent_id,selected)) present=true;
        if (!present) {
            int at=used<NOTICES ? used++ : -1;
            if (at<0) for (int i=used-1;i>=0;i--) if (!pro_notice_plan_source(&plan[i],rows)->question) { at=i;break; }
            if (at>=0) plan[at]=(pro_notice_plan_t){.old=held,.row=-1,.token=-1};
        }
    }
    for (int k=0;k<old_count;k++) {
        const cable_notif_t *old=&s.notice[k];
        if (!old->question) continue;
        int at=-1;
        for (int i=0;i<used;i++) if (!strcmp(pro_notice_plan_source(&plan[i],rows)->agent_id,old->agent_id)) { at=i;break; }
        if (at>=0 && pro_notice_plan_source(&plan[at],rows)->question) {
            pro_notice_plan_card(&card,&plan[at],rows,plan[at].old>=0 ? &s.notice[plan[at].old] : NULL);
            if (!strcmp(card.read_token,old->read_token) ||
                (!old->read_token[0] && old->question_id[0] && !strcmp(card.summary,old->summary))) plan[at].old=k;
            continue;
        }
        if (at<0) {
            if (used==NOTICES) {
                for (int i=used-1;i>=0;i--) {
                    const cable_notif_t *n=pro_notice_plan_source(&plan[i],rows);
                    if (!n->question && strcmp(n->agent_id,selected)) { at=i;break; }
                }
                if (at<0 && pro_notice_pinned(old,selected)) for (int i=used-1;i>=0;i--) {
                    pro_notice_plan_card(&card,&plan[i],rows,plan[i].old>=0 ? &s.notice[plan[i].old] : NULL);
                    if (!pro_notice_pinned(&card,selected)) { at=i;break; }
                }
                if (at<0) { s.notice_overflow=true;continue; }
                if (pro_notice_plan_source(&plan[at],rows)->question) s.notice_overflow=true;
            } else at=used++;
        }
        plan[at]=(pro_notice_plan_t){.old=k,.row=-1,.token=-1};
    }
    bool retained=false;
    for (int i=0;i<used;i++) if (!strcmp(pro_notice_plan_source(&plan[i],rows)->agent_id,selected)) retained=true;
    if (held>=0 && !retained && used<NOTICES) plan[used++]=(pro_notice_plan_t){.old=held,.row=-1,.token=-1};
    // Every retained old source occurs at most once in the plan. Permute those
    // sources first, including cycles, then materialize incoming rows in place.
    for (int i=0;i<NOTICES;i++) origin[i]=i;
    for (int i=0;i<used;i++) if (plan[i].old>=0) {
        int from=0;while (origin[from]!=plan[i].old) from++;
        if (from!=i) {
            card=s.notice[i];s.notice[i]=s.notice[from];s.notice[from]=card;
            uint8_t at=origin[i];origin[i]=origin[from];origin[from]=at;
        }
    }
    for (int i=0;i<used;i++) if (plan[i].row>=0) {
        pro_notice_plan_card(&card,&plan[i],rows,plan[i].old>=0 ? &s.notice[i] : NULL);
        s.notice[i]=card;
    }
    s.notice_count=used;
    if (s.view==INBOX) s.offset=cursor;
}
#endif
void ui_notif_replace(const cable_notif_t *rows, int count)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if (!s.connected) { display_unlock(); return; }
#endif
    char selected[ID_MAX]; notice_selection(selected, sizeof selected);
#ifndef DEVICE_PRO_COMPANION
    cable_notif_t held = {0};
    if (selected[0] && s.notice[s.offset].read_on_dial && s.notice[s.offset].read_token[0])
        held = s.notice[s.offset];
#endif
    if (!rows || count < 0) count = 0;
    if (count > NOTICES) count = NOTICES;
#ifdef DEVICE_PRO_COMPANION
    pro_notice_replace(rows,count,selected);
#else
    s.notice_count = 0;
    for (int i = count - 1; i >= 0; i--) {
        notice_add(rows[i].agent_id, rows[i].name, rows[i].machine, rows[i].summary,
                   rows[i].question, rows[i].failed);
        for (int j = 0; j < s.notice_count; j++) if (!strcmp(s.notice[j].agent_id, rows[i].agent_id)) {
            COPY(s.notice[j].read_token, rows[i].read_token);
            s.notice[j].read_on_dial = notice_was_read(&s.notice[j]);
            break;
        }
    }
#endif
#ifdef DEVICE_PRO_COMPANION
    if (!s.q.pending && (s.q.valid || s.q.loading) && s.q.notice_token[0]) {
        for (int i=0; i<s.notice_count; i++) {
            const cable_notif_t *n=&s.notice[i];
            if (!n->question || strcmp(n->agent_id,s.q.agent) || !strcmp(n->read_token,s.q.notice_token)) continue;
            s.q.valid=s.q.loading=false;s.q.revision++;
            COPY(s.q.error,"The question changed. Open the alert again.");
            if (question_view(s.view)) view(QUESTION);
            break;
        }
    }
#endif
    // An unread absence acknowledges the read, not an answer. Keep the current
    // result card in place as before; Pro questions remain until exact resolution.
    for (int i = 0; i < NOTICES; i++) if (s.notice_reads[i].pending) {
        bool present = false;
        for (int j = 0; j < count; j++)
            if (!strcmp(rows[j].agent_id, s.notice_reads[i].id) &&
                !strcmp(rows[j].read_token, s.notice_reads[i].token)) present = true;
        if (!present) s.notice_reads[i].pending = false;
    }
#ifndef DEVICE_PRO_COMPANION
    bool retained = false;
    for (int i = 0; i < s.notice_count; i++) if (!strcmp(s.notice[i].agent_id, selected)) retained = true;
    if (held.agent_id[0] && !retained && s.notice_count < NOTICES) {
        s.notice[s.notice_count++] = held;
    }
#endif
    notice_restore_selection(selected);
    notice_sync_view();
    change();
    display_unlock();
}
static void question_load(const cJSON *questions)
{
    s.q.count=s.q.index=s.q.choice=0; s.q.supported=true; s.q.valid=false;
    memset(s.q.item,0,sizeof s.q.item);
    const cJSON *item;
    cJSON_ArrayForEach(item,questions) {
        if (s.q.count==QUESTION_MAX) { s.q.supported=false; break; }
        question_item_t *q=&s.q.item[s.q.count++];
        const cJSON *key=cJSON_GetObjectItemCaseSensitive(item,"key"),
            *prompt=cJSON_GetObjectItemCaseSensitive(item,"q"),
            *options=cJSON_GetObjectItemCaseSensitive(item,"options");
        COPY(q->key,cJSON_IsString(key) ? key->valuestring : "");
        COPY(q->prompt,cJSON_IsString(prompt) ? prompt->valuestring : "");
        q->multi=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(item,"multi"));
        q->can_text=!q->multi && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(item,"canText"));
        if (!cJSON_IsString(key) || !q->key[0] || strlen(key->valuestring)>=sizeof q->key ||
            !cJSON_IsString(prompt) || !q->prompt[0] || strlen(prompt->valuestring)>=sizeof q->prompt ||
            !ht_can_display(q->prompt,UI_FONT,348,256)) s.q.supported=false;
        const cJSON *option;
        cJSON_ArrayForEach(option,options) {
            if (q->count==OPTION_MAX) { s.q.supported=false; break; }
            if (!cJSON_IsString(option) || !option->valuestring[0]) { s.q.supported=false; continue; }
            if (strlen(option->valuestring)>=sizeof q->options[0] ||
                !ht_can_display(option->valuestring,UI_FONT,348,256)) s.q.supported=false;
            COPY(q->options[q->count++],option->valuestring);
        }
        if (!q->count) s.q.supported=false;
    }
    s.q.valid=s.q.count>0;
}
#ifdef DEVICE_PRO_COMPANION
static uint64_t pro_question_signature(const cJSON *questions)
{
    // A local change detector, never submission authority. Hash the ordered
    // semantic fields so JSON spacing/key order cannot restart a read question.
    uint64_t h=UINT64_C(14695981039346656037);
    const cJSON *q,*option;
    cJSON_ArrayForEach(q,questions) {
        const char *keys[]={"key","q"};
        for (unsigned k=0;k<2;k++) {
            const cJSON *v=cJSON_GetObjectItemCaseSensitive(q,keys[k]);
            const unsigned char *p=(const unsigned char *)(cJSON_IsString(v)?v->valuestring:"");
            do { h=(h ^ *p)*UINT64_C(1099511628211); } while (*p++);
        }
        cJSON_ArrayForEach(option,cJSON_GetObjectItemCaseSensitive(q,"options")) {
            const unsigned char *p=(const unsigned char *)(cJSON_IsString(option)?option->valuestring:"");
            do { h=(h ^ *p)*UINT64_C(1099511628211); } while (*p++);
        }
        h=(h ^ 0xff)*UINT64_C(1099511628211);
        h=(h ^ cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(q,"multi")))*UINT64_C(1099511628211);
        // canText is current host speech eligibility, not question identity.
    }
    return h ? h : 1;
}
#endif
void ui_question_show(const char *id, const char *name, const char *machine, const char *request,
                      const cJSON *questions)
{
    if (!id || !request) return;
    display_lock();
    const cJSON *first=cJSON_GetArrayItem(questions,0);
    const cJSON *prompt=cJSON_GetObjectItemCaseSensitive(first,"q");
#ifdef DEVICE_PRO_COMPANION
    if (!s.connected || !id[0] || strnlen(id,ID_MAX)>=ID_MAX) { display_unlock(); return; }
    bool identifiable=request[0] && strnlen(request,sizeof s.q.request)<sizeof s.q.request;
    uint64_t signature=pro_question_signature(questions);
    bool same=false, read=false, unavailable=false; char read_token[CABLE_READ_TOKEN_MAX]="";
    char preview[240];recap_preview(preview,sizeof preview,cJSON_IsString(prompt)?prompt->valuestring:"Needs your answer");
    for (int i=0; i<s.notice_count; i++) {
        const cable_notif_t *n=&s.notice[i];
        if (!n->question || strcmp(n->agent_id,id)) continue;
        same=identifiable && !strcmp(n->question_id,request) && n->question_signature==signature && !strcmp(n->summary,preview);
        if (same || !n->question_id[0]) COPY(read_token,n->read_token);
        read=same && n->read_on_dial; unavailable=same && n->question_unavailable;
        break;
    }
    if (!same) notice_forget_read(id);
#else
    notice_forget_read(id);
#endif
#ifdef DEVICE_PRO_COMPANION
    if (!same)
#endif
    notice_add(id,name,machine,cJSON_IsString(prompt) ? prompt->valuestring : "Needs your answer",true,false);
#ifdef DEVICE_PRO_COMPANION
    for (int i=0; i<s.notice_count; i++) if (!strcmp(s.notice[i].agent_id,id)) {
        cable_notif_t *n=&s.notice[i];
        COPY(n->question_id,identifiable?request:""); n->question_signature=signature;
        COPY(n->read_token,read_token);n->read_on_dial=read;n->question_unavailable=!identifiable || unavailable;
        n->question_current=true;
        break;
    }
    if (!same) s.notice_sequence++;
#else
    s.notice_sequence++;
#endif
    // A different agent's alert cannot replace the question being read.
    if ((s.q.valid
#ifdef DEVICE_PRO_COMPANION
         || s.q.loading
#endif
        )
#ifdef DEVICE_PRO_COMPANION
        && !s.q.pending
#endif
        && !strcmp(s.q.agent,id) && (strcmp(s.q.request,request)
#ifdef DEVICE_PRO_COMPANION
            || (s.q.signature && s.q.signature!=signature)
#endif
            )) {
        s.q.valid=false; s.q.pending=false;
#ifdef DEVICE_PRO_COMPANION
        s.q.loading=false;
#endif
        s.q.revision++;
        if (question_view(s.view)) { COPY(s.q.error,"The question changed. Open the alert again."); view(QUESTION); }
    }
    change(); display_unlock();
}
void ui_question_state(const cJSON *p)
{
    const cJSON *agent=cJSON_GetObjectItemCaseSensitive(p,"agentId"),
        *fetch=cJSON_GetObjectItemCaseSensitive(p,"requestId"),
        *id=cJSON_GetObjectItemCaseSensitive(p,"id"),
        *token=cJSON_GetObjectItemCaseSensitive(p,"token"),
        *name=cJSON_GetObjectItemCaseSensitive(p,"name"),
        *error=cJSON_GetObjectItemCaseSensitive(p,"error");
    if (!cJSON_IsString(agent) || !cJSON_IsString(fetch)) return;
    display_lock();
    if (s.q.loading && s.view==QUESTION && !strcmp(agent->valuestring,s.q.agent) && !strcmp(fetch->valuestring,s.q.fetch)) {
        s.q.loading=false;
#ifdef DEVICE_PRO_COMPANION
        cable_notif_t *notice=NULL;
        for (int i=0; i<s.notice_count; i++) if (s.notice[i].question && !strcmp(s.notice[i].agent_id,s.q.agent)) { notice=&s.notice[i]; break; }
        if (notice && strcmp(s.q.notice_token,notice->read_token)) {
            s.q.valid=false;COPY(s.q.error,"The question changed. Open the alert again.");
            input_cancel();change();display_unlock();return;
        }
#endif
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"ok")) && cJSON_IsString(id) &&
#ifdef DEVICE_PRO_COMPANION
            id->valuestring[0] &&
#endif
            strlen(id->valuestring)<sizeof s.q.request && cJSON_IsString(token) && token->valuestring[0] &&
            strlen(token->valuestring)<sizeof s.q.token) {
            COPY(s.q.request,id->valuestring); COPY(s.q.token,token->valuestring);
#ifdef DEVICE_PRO_COMPANION
            s.q.signature=pro_question_signature(cJSON_GetObjectItemCaseSensitive(p,"questions"));
            if (notice) { COPY(notice->question_id,id->valuestring); notice->question_signature=s.q.signature; notice->question_unavailable=false; notice->question_current=true; }
#endif
            if (cJSON_IsString(name)) COPY(s.q.name,name->valuestring);
            question_load(cJSON_GetObjectItemCaseSensitive(p,"questions"));
#ifdef DEVICE_PRO_COMPANION
            if (notice) notice->question_unavailable=!s.q.valid || !s.q.supported;
#endif
            if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"submitted"))) {
                s.q.pending=s.q.uncertain=true;
                COPY(s.q.error,"An answer was already sent. Check the terminal.");
            }
        } else {
            COPY(s.q.error,cJSON_IsString(error) ? error->valuestring : "Could not load the question.");
#ifdef DEVICE_PRO_COMPANION
            // An unsuccessful read is not a close receipt. Keep its context but
            // require the desktop; do not keep offering an unanswerable dialog.
            if (notice) notice->question_unavailable=true;
#endif
        }
        input_cancel(); change();
    }
    display_unlock();
}
void ui_answer_receipt(const cJSON *p)
{
    const cJSON *agent=cJSON_GetObjectItemCaseSensitive(p,"agentId"),
        *fetch=cJSON_GetObjectItemCaseSensitive(p,"requestId"),
        *token=cJSON_GetObjectItemCaseSensitive(p,"token"),
        *error=cJSON_GetObjectItemCaseSensitive(p,"error");
    if (!cJSON_IsString(agent) || !cJSON_IsString(fetch) || !cJSON_IsString(token)) return;
    display_lock();
    if (s.q.pending &&
#ifdef DEVICE_PRO_COMPANION
        s.q.host[0] && !strcmp(s.q.host,s.notice_host) &&
#endif
        !strcmp(s.q.agent,agent->valuestring) && !strcmp(s.q.fetch,fetch->valuestring) &&
        !strcmp(s.q.token,token->valuestring)) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"ok"))) {
            if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"pending"))) { display_unlock(); return; }
            s.q.valid=s.q.pending=false; s.q.revision++;
#ifdef DEVICE_PRO_COMPANION
            for (int i=0; i<s.notice_count; i++) {
                const cable_notif_t *n=&s.notice[i];
                if (!n->question || strcmp(n->agent_id,s.q.agent)) continue;
                if ((!strcmp(n->question_id,s.q.request) && n->question_signature==s.q.signature) ||
                    (!n->question_id[0] && !strcmp(n->read_token,s.q.notice_token))) notice_remove(s.q.agent,true);
                break;
            }
#else
            notice_remove(s.q.agent,true);
#endif
            if (question_view(s.view)) view(HOME);
            notice_sync_view();
        } else {
            s.q.uncertain=true;
            COPY(s.q.error,cJSON_IsString(error) ? error->valuestring : "Could not confirm. Check the terminal.");
            change();
        }
    }
    display_unlock();
}
void ui_question_close(const char *id, const char *request)
{
    if (!id || !request) return;
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if (!request[0] || strnlen(request,sizeof s.q.request)>=sizeof s.q.request) { display_unlock(); return; }
    bool current=s.q.host[0] && !strcmp(s.q.host,s.notice_host) &&
        !strcmp(s.q.agent,id) && !strcmp(s.q.request,request);
    if (current) {
        s.q.valid=s.q.pending=s.q.loading=false; s.q.revision++;
        if (question_view(s.view)) view(HOME);
    }
    for (int i=0; i<s.notice_count; i++) {
        const cable_notif_t *n=&s.notice[i];
        if (n->question && !strcmp(n->agent_id,id) && n->question_id[0] && !strcmp(n->question_id,request)) {
            notice_remove(id,true); break;
        }
    }
#else
    if (!strcmp(s.q.agent,id) && !strcmp(s.q.request,request)) {
        s.q.valid=s.q.pending=s.q.loading=false; s.q.revision++;
        if (question_view(s.view)) view(HOME);
        notice_remove(id,true);
    } else if (strcmp(s.q.agent,id)) notice_remove(id,true);
#endif
    notice_sync_view();
    change(); display_unlock();
}

void ui_service_model_picker(void)
{
    char id[ID_MAX], selected[192];
    display_lock();
    bool request = s.model_request;
    s.model_request = false;
    COPY(id, s.model_agent);
    COPY(selected, s.model_selected);
    display_unlock();
    if (!request)
        return;
    static EXT_RAM_BSS_ATTR model_item_t results[48];
    int n = cable_client_models_list(id, "model", selected, results, 48);
    display_lock();
    if (s.view == MODELS && !strcmp(id, s.model_agent)) {
        s.model_count = n < 0 ? 0 : n;
        memcpy(s.models, results, (size_t)s.model_count * sizeof(model_item_t));
        change();
    }
    display_unlock();
}
void ui_swarms_replace(const cable_swarm_t *rows, int count, const char *selected)
{
    display_lock();
    int bounded=count<0 ? 0 : count>SWARMS_MAX ? SWARMS_MAX : count;
    if (!rows) bounded=0;
    char focused[ID_MAX] = "";
    int focused_index = ht_tab_carousel_index(&tab_carousel);
    if (s.view == TABS && focused_index >= 0 && focused_index < s.tab_count) COPY(focused, s.tabs[focused_index].id);
    bool changed=bounded!=s.tab_count || strcmp(s.selected_tab,selected ? selected : "");
    for (int i=0;!changed && i<bounded;i++) {
        changed=strcmp(rows[i].id,s.tabs[i].id) || strcmp(rows[i].name,s.tabs[i].name);
    }
    if (changed && (workspace.touching || s.view == TABS
#ifdef DEVICE_PRO_COMPANION
                    || s.workspace_chord || s.view == AGENTS
#endif
                    )) input_cancel();
    s.tab_count=bounded;
    if (bounded) memcpy(s.tabs,rows,(size_t)bounded*sizeof *rows);
    COPY(s.selected_tab,selected);
    if (changed && s.view == TABS) {
        int index = workspace_index(focused);
        ht_tab_carousel_reset(&tab_carousel, bounded, index >= 0 ? index : workspace_index(s.selected_tab));
    }
    if (workspace.phase!=HT_WORKSPACE_IDLE && workspace_index(workspace.pending)<0) {
        workspace_failed("That workspace is gone. Choose another.");
    } else if (ht_workspace_selected(&workspace,s.selected_tab)) {
        // Even identical/empty tabs need a fresh roster to acknowledge landing.
        // A narrow refresh forces that snapshot without replaying other state.
        if (!queue((action_t){.kind=A_TAB_REFRESH,.revision=workspace.serial}))
            workspace_failed("Device busy. Choose the tab again.");
    }
    change(); display_unlock();
}
#if HT_FACE_PX >= 720
void ui_tiles_replace(const cable_tile_t *rows, int count, const char *tab)
{
    display_lock();
    int bounded = count < 0 ? 0 : count > SWARM_TILES_MAX ? SWARM_TILES_MAX : count;
    if (!rows) bounded = 0;
    bool changed = bounded != s.tile_count || strcmp(s.tile_tab, tab ? tab : "");
    for (int i = 0; !changed && i < bounded; i++)
        changed = memcmp(&rows[i], &s.tiles[i], sizeof *rows) != 0;
#ifdef DEVICE_PRO_COMPANION
    if (changed && s.view == AGENTS) input_cancel();
#endif
    s.tile_count = bounded;
    if (bounded) memcpy(s.tiles, rows, (size_t)bounded * sizeof *rows);
    COPY(s.tile_tab, tab);
    // Only repaint when the shape actually moved. The window sends this frame on every roster change,
    // and a desk that redraws on an unchanged shape is 27 runs of damage for nothing.
    if (changed) change();
    if (changed) {
        int named = 0, resolved = 0;
        for (int i = 0; i < bounded; i++) {
            if (!s.tiles[i].agent_id[0]) continue;
            named++;
            for (int k = 0; k < s.count; k++)
                if (!strcmp(s.agents[k].id, s.tiles[i].agent_id)) { resolved++; break; }
        }
        ESP_LOGI("habitat", "tiles: %d for '%s' (sel '%s') · named %d resolved %d of roster %d · "
                 "first tile a='%s' roster0='%s'", bounded, tab ? tab : "", s.selected_tab,
                 named, resolved, s.count,
                 bounded ? s.tiles[0].agent_id : "", s.count ? s.agents[0].id : "");
    }
    display_unlock();
}
#endif
void ui_show_machines(void)
{
    display_lock();
    view(MACHINES);
    display_unlock();
}
void ui_machines_replace(const cable_machine_t *rows, int count, const char *selected,
                         const char *previous)
{
    (void)previous;
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if ((s.workspace_chord || s.view == AGENTS) &&
        strcmp(s.selected_machine, selected ? selected : "")) input_cancel();
#endif
    s.machine_count = !rows || count < 0 ? 0 : count > CABLE_MAX_MACHINES ? CABLE_MAX_MACHINES : count;
    if (s.machine_count > 0)
        memcpy(s.machines, rows, (size_t)s.machine_count * sizeof(*rows));
    COPY(s.selected_machine, selected);
    change();
    display_unlock();
}
void ui_machines_replace_one(const cable_machine_t *row, const char *selected)
{
    if (!row) return;
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if ((s.workspace_chord || s.view == AGENTS) &&
        strcmp(s.selected_machine, selected ? selected : "")) input_cancel();
#endif
    for (int i = 0; i < s.machine_count; i++)
        if (!strcmp(s.machines[i].id, row->id)) {
            s.machines[i] = *row;
            break;
        }
    COPY(s.selected_machine, selected);
    change();
    display_unlock();
}
void ui_machines_source(const char *source) { (void)source; }
void ui_machines_clear(void)
{
    display_lock();
    s.machine_count = 0;
    change();
    display_unlock();
}
void ui_set_selected_machine(const char *id)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if ((s.workspace_chord || s.view == AGENTS) &&
        strcmp(s.selected_machine, id ? id : "")) input_cancel();
#endif
    COPY(s.selected_machine, id);
    change();
    display_unlock();
}
void ui_machine_selected_ack(const char *id)
{
    if (!id || !*id || strlen(id) >= sizeof s.selected_machine) return;
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if ((s.workspace_chord || s.view == AGENTS) &&
        strcmp(s.selected_machine, id ? id : "")) input_cancel();
#endif
    COPY(s.selected_machine, id);
    // The host owns actual selection. Its older acknowledgement must not
    // consume a more recent request that is still waiting for its own reply.
    if (!strcmp(s.pending_machine, id)) s.pending_machine[0] = 0;
    change();
    display_unlock();
}
void ui_machine_select_error(const char *id, const char *code, const char *message)
{
    (void)code;
    display_lock();
    if (!id || !s.pending_machine[0] || strcmp(s.pending_machine, id)) {
        display_unlock();
        return;
    }
    s.pending_machine[0] = 0;
    display_unlock();
    ui_show_error("Machine", message);
}
void ui_tick_machine_select(void)
{
    display_lock();
    if (s.pending_machine[0] && (int32_t)(ms() - s.machine_deadline) >= 0) {
        s.pending_machine[0] = 0;
        COPY(s.title, "No response");
        COPY(s.message, "The machine did not answer. Please try again.");
        view(MESSAGE);
    }
    display_unlock();
}
void ui_machines_refresh(void)
{
    display_lock();
    change();
    display_unlock();
}
bool ui_selected_machine_is_local(void)
{
    return !s.selected_machine[0] || !strcmp(s.selected_machine, cable_client_machine_id());
}
void ui_set_reload_waiter(TaskHandle_t task) { atomic_store(&reload_waiter, task); }
void ui_request_agent_reload(void)
{
    atomic_store(&reload_requested, true);
    TaskHandle_t waiter = atomic_load(&reload_waiter);
    if (waiter)
        xTaskNotifyGive(waiter);
}
bool ui_take_agent_reload_req(void) { return atomic_exchange(&reload_requested, false); }
bool ui_peek_agent_reload_req(void) { return atomic_load(&reload_requested); }
bool ui_scroll_is_reversed(void) { return scroll_reversed; }
bool ui_take_portal_req(void) { return false; }
bool ui_take_wifi_retry_req(void) { return false; }
void ui_set_creating(bool on)
{
    display_lock();
    if (on) {
        COPY(s.title, "A new thought");
        COPY(s.message, "Finding its home...");
        view(MESSAGE);
    }
    change();
    display_unlock();
}
void ui_show_error(const char *title, const char *detail)
{
    display_lock();
    COPY(s.title, title);
    COPY(s.message, detail);
    view(MESSAGE);
    display_unlock();
}
void ui_carry_state(const cJSON *p)
{
    const cJSON *request=cJSON_GetObjectItemCaseSensitive(p,"requestId"),
        *id=cJSON_GetObjectItemCaseSensitive(p,"carryId"),
        *source=cJSON_GetObjectItemCaseSensitive(p,"sourceName"),
        *excerpt=cJSON_GetObjectItemCaseSensitive(p,"excerpt"),
        *rows=cJSON_GetObjectItemCaseSensitive(p,"rows"),
        *ttl=cJSON_GetObjectItemCaseSensitive(p,"ttlMs"),
        *error=cJSON_GetObjectItemCaseSensitive(p,"error");
    if (!cJSON_IsString(request) || strncmp(request->valuestring,"carry-",6) || !cJSON_IsString(id)) return;
    char *end=NULL; unsigned long serial=strtoul(request->valuestring+6,&end,10);
    if (!serial || !end || *end || serial>UINT32_MAX) return;
    bool ok=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"ok"));
    if (ok && (!cJSON_IsString(source) || !cJSON_IsString(excerpt) ||
        !cJSON_IsNumber(rows) || rows->valuedouble!=rows->valueint ||
        !cJSON_IsNumber(ttl) || ttl->valuedouble!=ttl->valueint || ttl->valueint<1)) return;
    display_lock();
    if (ht_carry_reply(&carry,id->valuestring,(uint32_t)serial,ok,
            cJSON_IsString(source)?source->valuestring:NULL,
            cJSON_IsString(excerpt)?excerpt->valuestring:NULL,
            cJSON_IsNumber(rows)?rows->valueint:0,cJSON_IsNumber(ttl)?(uint32_t)ttl->valueint:0,
            cJSON_IsString(error)?error->valuestring:NULL,ms())) {
        if (carry.active && s.view==SELECTION) {
            ht_selection_close(&selection);
            dispatch((action_t){.kind=A_FIND});
        } else if (s.view==SELECTION) COPY(selection.error,carry.error);
        ht_gesture_guard(&gesture,ms()); change();
    }
    display_unlock();
}
static bool selection_search_fields(const cJSON *p, const char **query, int *match, int *matches)
{
    const cJSON *q = cJSON_GetObjectItemCaseSensitive(p,"query"),
        *m = cJSON_GetObjectItemCaseSensitive(p,"match"), *n = cJSON_GetObjectItemCaseSensitive(p,"matches");
    *query = NULL; *match = *matches = 0;
    if (!q) return !m && !n;
    if (!cJSON_IsString(q) || !q->valuestring[0] || strlen(q->valuestring) > 120 ||
        !cJSON_IsNumber(m) || !cJSON_IsNumber(n) || m->valuedouble != m->valueint ||
        n->valuedouble != n->valueint || m->valueint < 0 || n->valueint < 0 || m->valueint > n->valueint) return false;
    *query = q->valuestring; *match = m->valueint; *matches = n->valueint; return true;
}
void ui_voice_search(const cJSON *p)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(p,"selectionId"),
        *agent = cJSON_GetObjectItemCaseSensitive(p,"agentId"),
        *revision = cJSON_GetObjectItemCaseSensitive(p,"revision"),
        *excerpt = cJSON_GetObjectItemCaseSensitive(p,"excerpt"),
        *rows = cJSON_GetObjectItemCaseSensitive(p,"rows");
    const char *query; int match, matches;
    if (!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"ok")) || !cJSON_IsString(id) || !cJSON_IsString(agent) ||
        !cJSON_IsNumber(revision) || revision->valueint < 1 || revision->valuedouble != revision->valueint ||
        !cJSON_IsNumber(rows) || rows->valuedouble != rows->valueint || !cJSON_IsString(excerpt) ||
        !selection_search_fields(p,&query,&match,&matches) || !query) return;
    display_lock();
    if (s.voice_open && s.voice_waiting && s.voice_search && s.voice_return == SELECTION &&
        ht_selection_found(&selection,id->valuestring,agent->valuestring,(uint32_t)revision->valueint,
            excerpt->valuestring,rows->valueint,query,match,matches)) {
        voice_close(); view(SELECTION); ht_gesture_guard(&gesture,ms());
    }
    display_unlock();
}
void ui_selection_state(const cJSON *p)
{
    const cJSON *request = cJSON_GetObjectItemCaseSensitive(p, "requestId");
    if (!cJSON_IsString(request) || strncmp(request->valuestring, "pick-", 5)) return;
    char *end = NULL;
    unsigned long serial = strtoul(request->valuestring + 5, &end, 10);
    if (!serial || !end || *end || serial > UINT32_MAX) return;
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(p, "selectionId"),
        *revision = cJSON_GetObjectItemCaseSensitive(p, "revision"),
        *excerpt = cJSON_GetObjectItemCaseSensitive(p, "excerpt"),
        *rows = cJSON_GetObjectItemCaseSensitive(p, "rows"),
        *error = cJSON_GetObjectItemCaseSensitive(p, "error");
    bool ok = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "ok"));
    if (ok && (!cJSON_IsNumber(revision) || revision->valueint < 1 ||
        revision->valuedouble != revision->valueint || !cJSON_IsNumber(rows) ||
        rows->valuedouble != rows->valueint || !cJSON_IsString(id) || !cJSON_IsString(excerpt))) return;
    const char *query; int match, matches;
    if (ok && !selection_search_fields(p,&query,&match,&matches)) return;
    if (!ok) { query = NULL; match = matches = 0; }
    display_lock();
    if (ht_selection_reply_search(&selection, (uint32_t)serial, cJSON_IsString(id) ? id->valuestring : NULL, ok,
        cJSON_IsNumber(revision) ? (uint32_t)revision->valueint : 0,
        cJSON_IsString(excerpt) ? excerpt->valuestring : "", cJSON_IsNumber(rows) ? rows->valueint : 0,
        cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "extending")),
        cJSON_IsString(error) ? error->valuestring : NULL, query, match, matches, ms())) change();
    display_unlock();
}

static bool form_page(const cJSON *p, ht_form_page_t *page)
{
#define FORM_TEXT(field) do { const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, #field); \
    if (cJSON_IsString(v)) COPY(page->field, v->valuestring); } while (0)
    FORM_TEXT(title); FORM_TEXT(label); FORM_TEXT(detail); FORM_TEXT(previous); FORM_TEXT(next);
    FORM_TEXT(error); FORM_TEXT(status); FORM_TEXT(action); FORM_TEXT(query);
#undef FORM_TEXT
    page->active = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "active"));
    page->busy = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "busy"));
    page->enabled = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "enabled"));
    const cJSON *revision = cJSON_GetObjectItemCaseSensitive(p, "revision"),
                *position = cJSON_GetObjectItemCaseSensitive(p, "position"),
                *total = cJSON_GetObjectItemCaseSensitive(p, "total");
    if (page->active && (!cJSON_IsNumber(revision) || revision->valuedouble < 0 || revision->valuedouble > INT32_MAX ||
        !cJSON_IsNumber(position) || position->valuedouble < 0 || position->valuedouble > INT32_MAX ||
        !cJSON_IsNumber(total) || total->valuedouble < 0 || total->valuedouble > INT32_MAX)) return false;
    page->revision = cJSON_IsNumber(revision) ? (uint32_t)revision->valueint : 0;
    page->position = cJSON_IsNumber(position) ? position->valueint : 0;
    page->total = cJSON_IsNumber(total) ? total->valueint : 0;
    page->can_query = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "canQuery"));
    return true;
}
static bool draft_page(const cJSON *p, ht_draft_page_t *page)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(p, "id"),
        *revision = cJSON_GetObjectItemCaseSensitive(p, "revision"),
        *position = cJSON_GetObjectItemCaseSensitive(p, "position"),
        *total = cJSON_GetObjectItemCaseSensitive(p, "total"),
        *text_ = cJSON_GetObjectItemCaseSensitive(p, "text"),
        *agent = cJSON_GetObjectItemCaseSensitive(p, "agentId");
    if (!cJSON_IsString(id) || !id->valuestring[0] || strlen(id->valuestring) >= sizeof page->id ||
        !cJSON_IsNumber(revision) || revision->valuedouble < 1 || revision->valuedouble > INT32_MAX ||
        revision->valuedouble != revision->valueint) return false;
    COPY(page->id, id->valuestring); page->revision = (uint32_t)revision->valueint;
    page->active = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "active"));
    const cJSON *error = cJSON_GetObjectItemCaseSensitive(p, "error");
    if (cJSON_IsString(error)) COPY(page->error, error->valuestring);
    if (!page->active) return true;
    if (!cJSON_IsNumber(position) || !cJSON_IsNumber(total) ||
        position->valuedouble != position->valueint || total->valuedouble != total->valueint ||
        position->valueint < 1 || position->valueint > total->valueint || total->valueint > 128 ||
        !cJSON_IsString(text_) || !text_->valuestring[0] || strlen(text_->valuestring) > 480 ||
        !cJSON_IsString(agent) || !agent->valuestring[0] || strlen(agent->valuestring) >= sizeof page->agent) return false;
    COPY(page->text, text_->valuestring); COPY(page->agent, agent->valuestring);
    const cJSON *name = cJSON_GetObjectItemCaseSensitive(p, "name"),
        *context = cJSON_GetObjectItemCaseSensitive(p, "context");
    COPY(page->name, cJSON_IsString(name) ? name->valuestring : "Harness");
    if (cJSON_IsString(context)) COPY(page->context, context->valuestring);
    page->position = position->valueint; page->total = total->valueint;
    page->can_undo = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "canUndo"));
    page->locked = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "locked"));
    page->can_send = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "canSend")) &&
        ht_can_display(page->text, UI_FONT, 348, 512);
    return true;
}
void ui_voice_draft(const cJSON *p)
{
    ht_draft_page_t page = {0};
    if (!draft_page(p, &page) || !page.active || !cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "ok"))) return;
    display_lock();
    if (!s.voice_open || !s.voice_waiting || !s.voice_review ||
#ifdef DEVICE_PRO_COMPANION
        draft.read_only || s.draft_recovery.capture_generation != s.draft_recovery.generation ||
        strcmp(page.agent, s.draft_recovery.recipient) ||
        (s.work_voice_mode != PRO_WORK_TASK && strcmp(page.agent, s.work_agent)) ||
        (s.carry_review.id[0] && (strcmp(page.agent, s.carry_review.agent) ||
            (s.carry_review.draft[0] && strcmp(page.id, s.carry_review.draft)))) ||
#endif
        (s.voice_return == DRAFT && (!draft.page.active || strcmp(page.id, draft.page.id) ||
            draft.page.revision != s.voice_draft_revision || page.revision <= s.voice_draft_revision))) {
        display_unlock(); return;
    }
#ifdef DEVICE_PRO_COMPANION
    if (s.voice_carry && s.carry_review.id[0]) COPY(s.carry_review.draft, page.id);
#endif
#ifdef DEVICE_PRO_COMPANION
    bool first = !draft.page.active;
#endif
    voice_close(); ht_draft_open(&draft, &page, draft_emit, NULL);
#ifdef DEVICE_PRO_COMPANION
    s.draft_recovery.has_words = true;
    s.draft_recovery.carried = pro_carry_review_owns(&s.carry_review, &draft.page);
    if (first) { s.draft_recovery.store = PRO_RECOVERY_NONE; pro_draft_store_queue(false); }
#endif
    view(DRAFT); ht_gesture_guard(&gesture, ms());
    display_unlock();
}
void ui_draft_state(const cJSON *p)
{
    const cJSON *request = cJSON_GetObjectItemCaseSensitive(p, "requestId");
    if (!cJSON_IsString(request) || strncmp(request->valuestring, "draft-", 6)) return;
    char *end = NULL; unsigned long serial = strtoul(request->valuestring+6, &end, 10);
    if (!serial || !end || *end || serial > UINT32_MAX) return;
    ht_draft_page_t page = {0};
    if (!draft_page(p, &page)) return;
    bool ok = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "ok"));
    display_lock();
    ht_draft_op_t op = draft.op; int direction = draft.delta;
#ifdef DEVICE_PRO_COMPANION
    bool carried_draft = pro_carry_review_owns(&s.carry_review, &draft.page);
    if (draft.read_only) {
        // A cached part may only be replaced by a current, explicitly requested
        // page from its original host, draft and recipient. Focus is irrelevant.
        if (!s.connected || !draft.pending || draft.request != (uint32_t)serial ||
            strcmp(page.id, draft.page.id) || !pro_draft_recovery_same_host(&s.draft_recovery) ||
            s.draft_recovery.request_generation != s.draft_recovery.generation ||
            (op != HT_DRAFT_STATE && op != HT_DRAFT_MOVE)) { display_unlock(); return; }
        if (page.active && (strcmp(page.agent, s.draft_recovery.recipient) ||
            page.revision < draft.page.revision ||
            (op == HT_DRAFT_MOVE && (page.revision != draft.page.revision + 1 ||
             page.position != draft.page.position + direction || page.total != draft.page.total)))) {
            display_unlock(); return;
        }
        if (page.active) {
            COPY(page.name, draft.page.name); COPY(page.context, draft.page.context);
        }
        // Even older hosts that return mutable flags cannot restore authority.
        // A historical sent:true never hides recovered words or means completion.
        s.draft_recovery.ready = page.active;
        if (page.active) s.draft_recovery.has_words = true;
    }
    if (!draft.read_only && draft.pending && draft.request == (uint32_t)serial && !strcmp(page.id, draft.page.id)) {
        if (page.active && strcmp(page.agent, draft.page.agent)) { display_unlock(); return; }
        if (!page.active) {
            const cJSON *carried = cJSON_GetObjectItemCaseSensitive(p, "carryId");
            bool sent = ok && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "sent")) &&
                (!carried_draft || (cJSON_IsString(carried) && !strcmp(carried->valuestring, s.carry_review.id)));
            if (sent || (ok && op == HT_DRAFT_DISCARD)) {
                if (sent && op == HT_DRAFT_SEND && pro_send_feedback_matches() &&
                    s.send_feedback.request == (uint32_t)serial && !strcmp(s.send_feedback.draft, page.id))
                    s.send_feedback.accepted = true;
                else pro_send_feedback_clear();
                pro_draft_store_queue(true);
                if (draft.page.active) view(DRAFT);
                display_unlock(); return;
            }
            // Missing records after a fast host restart must preserve every
            // reviewed instruction, even when no disconnect event was observed.
            char error[sizeof page.error]; COPY(error, page.error);
            page = draft.page; page.locked = true; page.can_send = page.can_undo = false;
            COPY(page.error, error[0] ? error : "Delivery not confirmed. Check the desktop.");
            if (carried_draft) s.carry_review.detached = true;
            draft.read_only = true; pro_draft_recovery_advance(&s.draft_recovery);
            ok = false;
        }
        if (op == HT_DRAFT_SEND) pro_send_feedback_clear();
    }
#endif
    if (ht_draft_reply(&draft, page.id, (uint32_t)serial, ok, &page)) {
        if (!draft.page.active) {
#ifdef DEVICE_PRO_COMPANION
            if (carried_draft) {
                if (!strcmp(s.carry_review.id, carry.id)) ht_carry_close(&carry);
                memset(&s.carry_review, 0, sizeof s.carry_review);
            }
#endif
            const cJSON *carried = cJSON_GetObjectItemCaseSensitive(p, "carryId");
            if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "sent")) &&
                cJSON_IsString(carried) && !strcmp(carried->valuestring, carry.id)) ht_carry_close(&carry);
            if (!ok) { COPY(s.title, "Draft"); copy(s.message, sizeof page.error, page.error); view(MESSAGE); }
            else view(HOME);
        } else if (s.view == DRAFT || s.view == DRAFT_OPTIONS
#ifdef DEVICE_PRO_COMPANION
            || s.view == CARRY_PREVIEW
#endif
            ) {
            if ((ok || draft.read_only) && op == HT_DRAFT_MOVE && page.active) {
#ifdef DEVICE_PRO_COMPANION
                s.offset = direction < 0 ? question_rows(page.text)-DRAFT_ROWS : 0;
#else
                s.offset = direction < 0 ? question_rows(page.text)-5 : 0;
#endif
                if (s.offset < 0) s.offset = 0;
            } else if (ok && op == HT_DRAFT_UNDO) s.offset = 0;
            input_cancel(); change();
        }
        ht_gesture_guard(&gesture, ms());
    }
    display_unlock();
}
void ui_form_state(const cJSON *p)
{
    const cJSON *request = cJSON_GetObjectItemCaseSensitive(p, "requestId"),
                *id = cJSON_GetObjectItemCaseSensitive(p, "formId");
    if (!cJSON_IsString(request) || strncmp(request->valuestring, "form-", 5) || !cJSON_IsString(id)) return;
    char *end = NULL;
    unsigned long serial = strtoul(request->valuestring + 5, &end, 10);
    if (!serial || !end || *end || serial > UINT32_MAX) return;
    ht_form_page_t page = {0};
    if (!form_page(p, &page)) return;
    display_lock();
    bool ok=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "ok"));
    if (form.pending && form.request==(uint32_t)serial && !strcmp(form.id,id->valuestring) &&
        (form.pending_op!=HT_FORM_STATE || !ok))
        ESP_LOGI("habitat","picker reply req=%lu ok=%d active=%d query=%d busy=%d",
            serial,ok,page.active,page.can_query,page.busy);
    if (ht_form_reply(&form, id->valuestring, (uint32_t)serial,
            ok, &page, ms())) {
        if (!form.id[0]) { ht_gesture_guard(&gesture, ms()); view(HOME); }
        else if (s.view == FORM) change();
    }
    display_unlock();
}
void ui_voice_question(const cJSON *p)
{
    const cJSON *agent=cJSON_GetObjectItemCaseSensitive(p,"agentId"),
        *token=cJSON_GetObjectItemCaseSensitive(p,"token"),
        *index=cJSON_GetObjectItemCaseSensitive(p,"questionIndex"),
        *draft=cJSON_GetObjectItemCaseSensitive(p,"draftId"),
        *text=cJSON_GetObjectItemCaseSensitive(p,"text");
    display_lock();
    if (!s.voice_open || !s.voice_waiting || !question_view(s.voice_return)) { display_unlock(); return; }
    if (!s.q.valid || s.q.revision!=s.voice_question_revision ||
        !cJSON_IsString(agent) || strcmp(agent->valuestring,s.q.agent) ||
        !cJSON_IsString(token) || strcmp(token->valuestring,s.q.token) ||
        !cJSON_IsNumber(index) || index->valuedouble!=s.voice_question_index || s.q.index!=s.voice_question_index) {
        voice_close(); COPY(s.title,"Question changed"); COPY(s.message,"Open the alert again."); view(MESSAGE);
        display_unlock(); return;
    }
    question_item_t *q=&s.q.item[s.q.index];
    voice_close();
    if (!q->can_text || !cJSON_IsString(draft) || !draft->valuestring[0] || strlen(draft->valuestring)>=sizeof q->draft ||
        !cJSON_IsString(text) || !text->valuestring[0] || strlen(text->valuestring)>1200 ||
        !ht_can_display(text->valuestring,UI_FONT,348,1200)) {
        q->draft[0]=q->answer[0]=0; q->selected=0;
        COPY(s.q.speech_error,"Cannot show that answer. Say it again or use the terminal."); view(QUESTION);
    } else {
        COPY(q->draft,draft->valuestring); COPY(q->answer,text->valuestring); q->selected=0;
        s.q.speech_error[0]=0; view(ANSWER_REVIEW);
    }
    ht_gesture_guard(&gesture,ms());
    display_unlock();
}
void ui_voice_form(const cJSON *p)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(p, "formId");
    if (!cJSON_IsString(id)) return;
    ht_form_page_t page = {0};
    if (!form_page(p, &page)) return;
    display_lock();
    if (!s.voice_open || !s.voice_waiting || s.voice_return != FORM || strcmp(form.id, id->valuestring)) {
        display_unlock(); return;
    }
    voice_close();
    if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "ok")) && !page.active) {
        ht_form_reset(&form); view(HOME);
    } else {
        if (page.active) form.page = page;
        else COPY(form.page.error, page.error[0] ? page.error : "Say the name again.");
        form.poll = ms() + (form.page.error[0] ? 6000 : 1000);
        view(FORM);
    }
    ht_gesture_guard(&gesture, ms());
    display_unlock();
}
void ui_visit_state(const cJSON *p)
{
    const cJSON *request = cJSON_GetObjectItemCaseSensitive(p, "requestId"),
        *id = cJSON_GetObjectItemCaseSensitive(p, "visitId"),
        *label = cJSON_GetObjectItemCaseSensitive(p, "label"),
        *agent = cJSON_GetObjectItemCaseSensitive(p, "agentId"),
        *error = cJSON_GetObjectItemCaseSensitive(p, "error"),
        *note = cJSON_GetObjectItemCaseSensitive(p, "note");
    if (!cJSON_IsString(request) || strncmp(request->valuestring, "visit-", 6) || !cJSON_IsString(id)) return;
    char *end = NULL;
    unsigned long serial = strtoul(request->valuestring + 6, &end, 10);
    if (!serial || !end || *end || serial > UINT32_MAX) return;
    bool ok = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "ok"));
    if (ok && (!cJSON_IsString(agent) || !agent->valuestring[0] || strlen(agent->valuestring) >= ID_MAX)) return;
    display_lock();
#ifndef DEVICE_PRO_COMPANION
    bool inspect=visit.op==HT_VISIT_OPEN;
#endif
    bool latest=visit.op==HT_VISIT_LATEST;
    if (ok && (visit.op==HT_VISIT_OPEN || latest) && strcmp(visit.pending_agent,agent->valuestring)) {
        display_unlock(); return;
    }
    if (ht_visit_reply(&visit, id->valuestring, (uint32_t)serial,
            ok,
            cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "active")),
            cJSON_IsString(label) ? label->valuestring : "")) {
        s.pending_focus[0] = 0;
        if (ok) {
#ifdef DEVICE_PRO_COMPANION
            pro_reader_focus(agent->valuestring);
#endif
            int i = find(agent->valuestring);
            if (i >= 0) {
                input_cancel(); s.active = i;
#ifndef DEVICE_PRO_COMPANION
                if (inspect && visit.available && is_question(agent->valuestring)) open_question();
                else view(HOME);
#else
                view(HOME);
#endif
            } else {
                COPY(s.pending_focus, agent->valuestring);
                COPY(s.title, "On your desktop");
                COPY(s.message, "Waiting for that pane...");
                view(MESSAGE);
            }
            if (cJSON_IsString(note) && note->valuestring[0]) {
                COPY(s.title, "Returned"); COPY(s.message, note->valuestring); view(MESSAGE);
            }
        } else {
            if (latest) COPY(s.title,"Latest output");
            else COPY(s.title,"Visit");
            COPY(s.message, cJSON_IsString(error) ? error->valuestring : "Open the alert again.");
            view(MESSAGE);
        }
        change();
    }
    display_unlock();
}

void ui_cable_toast(const char *message)
{
    display_lock();
    // General desktop notices must not dismiss a live recording or routing request.
    if (s.voice_open) {
        display_unlock();
        return;
    }
    display_unlock();
    ui_show_error("Harness", message);
}
void ui_voice_error(const char *message)
{
    display_lock();
    if (!s.voice_open || !s.voice_waiting) {
        display_unlock();
        return;
    }
    voice_close();
    if (s.voice_search && selection.active) {
        COPY(selection.error, message); view(SELECTION);
    } else if (s.voice_return == DRAFT && draft.page.active) {
        COPY(draft.page.error, message); draft.failed = true; view(DRAFT);
    } else if (question_view(s.voice_return) && s.q.valid && s.q.revision==s.voice_question_revision) {
        COPY(s.q.speech_error,message); view(s.voice_return);
    } else if (s.voice_return == FORM && form.id[0]) {
        COPY(form.page.error, message); form.poll = ms() + 6000; view(FORM);
    } else if (message && !strcmp(message, "Didn't catch that")) {
        // An empty transcript sent nothing. Keep the familiar voice surface
        // available for one-tap retry, then restore its previous result/status.
        view(HOME);
        s.voice_retry_until = ms() + 3000;
        if (!s.voice_retry_until) s.voice_retry_until = 1;
        change();
    } else {
        COPY(s.title, "Voice"); COPY(s.message, message); view(MESSAGE);
    }
    ht_gesture_guard(&gesture, ms());
    display_unlock();
}
void ui_show_connecting(const char *step) { (void)step; ui_enter_boot_loading(); }
void ui_enter_remote_offline(void)
{
    ui_enter_boot_loading();
}
void ui_enter_link_guide(void)
{
    ui_show_error(
        "Link this machine",
        "On that computer:\nharness link create\n\nOn this computer:\nharness link import");
}
void ui_leave_remote_offline_loading(void) { ui_enter_boot_loading(); }
void ui_leave_error_screen(void) { ui_home_overview(); }
void ui_show_pairing(const char *code, int seconds)
{
    (void)seconds;
    ui_show_error("Pair device", code);
}
void ui_show_e2ee_pair(const char *code, int seconds)
{
    (void)seconds;
    ui_show_error("Pair machine", code);
}
void ui_show_e2ee_paired(const char *fingerprint) { ui_show_error("Machine paired", fingerprint); }
void ui_show_unpaired(void) { ui_enter_boot_loading(); }
void ui_show_ota_restarting(void)
{
    display_lock();
    view(OTA);
    display_unlock();
}
void ui_ota_boot_show(const char *version)
{
    (void)version;
    audio_client_abort();
    display_lock();
    voice_close();
    view(OTA);
    display_unlock();
}
void ui_ota_boot_pct(int percent)
{
    (void)percent; // Static wordmark; transfer progress stays in the host logs.
}
bool ui_voice_is_recording(void) { return audio_client_recording(); }
bool ui_voice_is_active(void) { return audio_client_active(); }
uint32_t ui_voice_start_tick(void) { return s.voice_started; }
void ui_voice_start(void)
{
    display_lock();
    action_t a = {.kind = A_VOICE};
    if ((s.view == HOME || s.view == AGENT) && active())
        COPY(a.id, active()->id);
#ifdef DEVICE_PRO_COMPANION
    if (carry.active) { a.value = 3; copy(a.text, sizeof carry.id, carry.id); }
#endif
    dispatch(a);
    display_unlock();
}
void ui_voice_start_goal(void)
{
    display_lock();
    action_t a = {.kind = A_VOICE, .value = 1};
    if ((s.view == HOME || s.view == AGENT) && active())
        COPY(a.id, active()->id);
    dispatch(a);
    display_unlock();
}
void ui_voice_stop(void)
{
    display_lock();
    dispatch((action_t){.kind = A_VOICE_STOP});
    display_unlock();
}
void ui_voice_routed(bool auto_sent, bool need_new, const char *route, const char *id,
                     const char *name, double confidence)
{
    (void)name;
    (void)confidence;
    display_lock();
    if (!s.voice_open || !s.voice_waiting || s.voice_review || s.voice_search || s.voice_return == DRAFT ||
        s.voice_return == FORM || question_view(s.voice_return)) {
        display_unlock();
        return;
    }
    if (auto_sent && s.voice_carry) ht_carry_close(&carry);
    voice_close();
    if (!need_new && id && *id) {
#ifdef DEVICE_PRO_COMPANION
        pro_reader_focus(id);
#endif
        int i = find(id);
        if (i >= 0)
            s.active = i;
        else
            COPY(s.pending_focus, id);
        view(AGENT);
    } else
        view(HOME);
    display_unlock();
    if (!auto_sent && route && *route && id && *id)
        cable_client_voice_confirm(route, id);
}
void ui_voice_route_abort(void)
{
    display_lock();
    dispatch((action_t){.kind = A_VOICE_ABORT});
    display_unlock();
}
void ui_voice_quota_status(int seconds)
{
    (void)seconds; /* Server still enforces quota; exceeded immediately aborts capture below. */
}
void ui_voice_quota_exceeded(void)
{
    ui_voice_route_abort();
    ui_cable_toast("Voice allowance reached.");
}
void ui_stop_active_turn(void)
{
    display_lock();
    if (!s.locked && active() && active()->busy) {
        COPY(s.stop_agent, active()->id);
        view(STOP);
    }
    display_unlock();
}
void ui_boot_pressed(void)
{
    display_lock();
    if (!s.locked) {
        if (s.voice_open || audio_client_active()) {
            dispatch((action_t){.kind = A_VOICE_ABORT});
        } else if (s.view == AGENT && active() && active()->busy) {
            COPY(s.stop_agent, active()->id);
            view(STOP);
        } else
            view(HOME);
    }
    display_unlock();
}
void ui_lock_init_gate(void)
{
    display_lock();
    s.locked = config_lock_enabled();
    change();
    display_unlock();
}
void ui_lock_setup(void)
{
    display_lock();
    if (config_lock_enabled()) {
        s.locked = true;
        change();
    } else {
        COPY(s.title, "Pattern setup");
        COPY(s.message, "Pattern editing is available in the standard firmware.");
        view(MESSAGE);
    }
    display_unlock();
}
bool ui_lock_active(void) { return s.locked; }
void ui_log_state_if_changed(void) {}

#ifdef DEVICE_OCTOPUS_BENCH
// Local fixtures only. No setting is saved and no action is sent to the desktop.
void habitat_bench_prepare(bool animate)
{
    (void)animate; // The benchmark switches only the shared body clock.
    display_lock();
    habitat_touch_cancel();
    s.quiet = s.nap = s.locked = s.focus_face = s.straight_title = false;
    s.pet_pose = 0;
    s.notice_count = 0;
    s.tab_count = 0;
    s.connected = true;
    s.loading = false;
    s.voice_open = false;
    memset(&s.q, 0, sizeof s.q);
    memset(&character.motion, 0, sizeof character.motion);
    view(HOME);
    display_bump_activity();
    display_wake();
    display_unlock();
}
void habitat_bench_reader(void)
{
    display_lock();
    dispatch(make_action((hit_t){.action = A_READER}));
    display_unlock();
}
void habitat_bench_question(const cJSON *questions)
{
    display_lock();
    s.q.loading = s.q.pending = false;
    s.q.error[0] = 0;
    COPY(s.q.name, "Benchmark question");
    question_load(questions);
    view(QUESTION);
    display_unlock();
}
bool habitat_bench_pressed(void)
{
    return s.touch_down && character.motion.reaction.pose.pressed;
}
#endif
