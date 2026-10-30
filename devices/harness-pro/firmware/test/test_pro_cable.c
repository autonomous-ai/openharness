// Host test for pro_cable (main/cable/pro_cable.c): framed JSON in, pro_app_* calls out. Built against the real
// cJSON from $IDF_PATH/components/json/cJSON, the real cable_json_guard, cable_features, cable_machines and
// cable_scroll, a recording stub of pro_app_api.h and a stub cable_link (see run.sh for the flags).
#define _GNU_SOURCE
#include <assert.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cable/pro_cable.h"
#include "cable_features.h"
#include "cable_frame.h"
#include "cable_link.h"
#include "esp_app_desc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "pod/pod_model.h"
#include "pro_app_api.h"
#include "sys/device_mac.h"
#include "task_stacks.h"
#include "sys/last_words.h"
#include "esp_task_wdt.h"
#include "board/board.h"
#include "sys/config_store.h"
#include "sys/fw_update.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

// ---- the recorder --------------------------------------------------------------------------------------
enum { EV_STATS, EV_LINK, EV_AGENTS, EV_SWARMS, EV_LIBRARY, EV_CONTEXT, EV_TURN, EV_SUMMARY, EV_QUESTION, EV_QCLOSE, EV_FOCUS,
       EV_VOICE, EV_MACHINES, EV_NREPLACE, EV_NSEEN, EV_STIDS, EV_SUPERTAB, EV_STRECAP, EV_STFOCUS };
typedef struct { int kind; char id[64]; char a[2400], b[2400], c[2400], d[128]; long n1, n2, n3, n4, n5; } ev_t;
#define EV_MAX 64
static ev_t evs[EV_MAX];
static int nev;
static cable_swarm_t rec_swarms[SWARMS_MAX];
static cable_swarm_members_t rec_members;
static cable_tile_t rec_tiles[SWARM_TILES_MAX];
static char rec_agent_ids[POD_AGENTS_MAX][ID_MAX];

static ev_t *add(int kind, const char *id)
{
    CHECK(nev < EV_MAX);
    ev_t *e = &evs[nev++];
    memset(e, 0, sizeof *e);
    e->kind = kind;
    snprintf(e->id, sizeof e->id, "%s", id ? id : "<null>");
    return e;
}
static void put(char *dst, const char *s) { snprintf(dst, 2400, "%s", s ? s : "<null>"); }

void pro_app_link(bool up, const char *machine) { ev_t *e = add(EV_LINK, NULL); e->n1 = up; put(e->a, machine); }
void pro_app_agents(const pro_agent_row_t *rows, int n)
{
    ev_t *e = add(EV_AGENTS, NULL);
    e->n1 = n;
    for (int i = 0; i < n && i < POD_AGENTS_MAX; i++) snprintf(rec_agent_ids[i], ID_MAX, "%s", rows[i].id);
    if (n > 0) { put(e->a, rows[0].name); put(e->b, rows[0].machine); put(e->c, rows[0].engine); }
}
void pro_app_swarms(const cable_swarm_t *items, int n, const cable_swarm_members_t *members, const char *selected,
                    const cable_tile_t *tiles, int tile_n)
{
    ev_t *e = add(EV_SWARMS, NULL);
    e->n1 = n; e->n2 = members != NULL; e->n3 = tile_n;
    put(e->a, selected);
    memcpy(rec_swarms, items, (size_t)n * sizeof *items);
    if (members) memcpy(&rec_members, members, sizeof rec_members);
    memcpy(rec_tiles, tiles, (size_t)tile_n * sizeof *tiles);
}
static pod_swarm_t rec_card;
static char rec_ids[SWARMS_CARD_MAX][ID_MAX];
void pro_app_supertab_ids(const char (*ids)[ID_MAX], int n)
{
    ev_t *e = add(EV_STIDS, NULL);
    e->n1 = n;
    memcpy(rec_ids, ids, (size_t)n * sizeof *ids);
}
void pro_app_supertab(const pod_swarm_t *sw)
{
    ev_t *e = add(EV_SUPERTAB, sw->id);
    rec_card = *sw;
    e->n1 = sw->lead_n;
}
void pro_app_supertab_recap(const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none)
{
    ev_t *e = add(EV_STRECAP, tab); put(e->a, lead); put(e->b, text); snprintf(e->d, sizeof e->d, "%s", chat_id); e->n1 = at; e->n2 = none;
}
void pro_app_supertab_focus(const char *tab, const char *lead) { ev_t *e = add(EV_STFOCUS, tab); put(e->a, lead); }
void pro_app_library(const pro_library_row_t *rows, int count, int offset, int total)
{
    ev_t *e = add(EV_LIBRARY, NULL);
    e->n1 = count; e->n2 = offset; e->n3 = total;
    if (count > 0) { put(e->a, rows[0].name); put(e->b, rows[0].machine); put(e->c, rows[0].status); e->n4 = rows[0].age_s; }
}
void pro_app_context(const char *id, const char *machine, const char *project, const char *branch, const char *engine)
{
    ev_t *e = add(EV_CONTEXT, id); put(e->a, machine); put(e->b, project); put(e->c, branch); (void)engine;
}
void pro_app_turn(const char *id, const char *kind, const char *text, int elapsed_s)
{
    ev_t *e = add(EV_TURN, id); put(e->a, kind); put(e->b, text); e->n1 = elapsed_s;
}
void pro_app_turn_stats(const char *id, int passed, int failed, int commits, int tokens_in, int tokens_out)
{
    ev_t *e = add(EV_STATS, id); e->n1 = passed; e->n2 = failed; e->n3 = commits; e->n4 = tokens_in; e->n5 = tokens_out;
}
void pro_app_summary(const char *id, const char *text, const char *recap, const char *full, bool restore, pod_tier_t tier)
{
    ev_t *e = add(EV_SUMMARY, id); put(e->a, text); put(e->b, recap); put(e->c, full); e->n1 = restore; e->n2 = tier;
}
void pro_app_notif_replace(const pro_notif_row_t *rows, int n)
{
    ev_t *e = add(EV_NREPLACE, NULL); e->n1 = n;
    if (n > 0) { put(e->a, rows[0].agent_id); put(e->b, rows[0].summary); put(e->c, rows[0].token); }
    if (n > 1) snprintf(e->d, sizeof e->d, "%s", rows[n - 1].token);
}
void pro_app_notif_seen(const char *id, const char *token)
{
    ev_t *e = add(EV_NSEEN, id); put(e->a, token ? token : "(none)");
}
void pro_app_question(const char *id, const char *request, const char *text, const char *super_tab, pod_attention_t attention)
{
    ev_t *e = add(EV_QUESTION, id); (void)request; put(e->a, text); put(e->b, super_tab); e->n1 = attention;
}
void pro_app_question_close(const char *id) { add(EV_QCLOSE, id); }
void pro_app_focus(const char *id) { add(EV_FOCUS, id); }
void pro_app_voice_result(int kind, const char *text) { ev_t *e = add(EV_VOICE, NULL); e->n1 = kind; put(e->a, text); }
void pro_app_machines(const cable_machine_t *rows, int count, const char *selected)
{
    ev_t *e = add(EV_MACHINES, NULL); e->n1 = count; put(e->a, selected);
    if (count > 0) put(e->b, rows[0].name);
}

// ---- stubs for everything below pro_cable ---------------------------------------------------------------
static char sent[16][8192];
static int nsent;
bool cable_link_send(uint8_t type, const uint8_t *payload, size_t len)
{
    if (type == CABLE_TYPE_JSON && nsent < 16 && len < sizeof sent[0]) { memcpy(sent[nsent], payload, len); sent[nsent++][len] = 0; }
    return true;
}
static uint32_t link_corrupt;
void cable_link_counters(uint32_t *c, uint32_t *d) { *c = link_corrupt; *d = 0; }
static int nowait_sent;
bool cable_link_send_nowait(uint8_t type, const uint8_t *payload, size_t len)
{
    nowait_sent++;
    return cable_link_send(type, payload, len);
}
bool cable_link_start(cable_frame_cb cb, cable_tick_cb tick, void *ctx) { (void)cb; (void)tick; (void)ctx; return true; }
void cable_link_set_log_framing(bool on) { (void)on; }
static int decoder_resets;
void cable_link_reset_decoder(void) { decoder_resets++; }
static bool host_present;   // off unless a test turns it on: with no host the self re-plug's clock never runs
bool cable_link_host_present(void) { return host_present; }
static int replugs;
void cable_link_replug(void) { replugs++; }
static bool rx_pending;     // part of a frame is in (test_cable_link covers when the real reader says so)
bool cable_link_rx_pending(void) { return rx_pending; }
static int64_t now_us = 1000000;
int64_t esp_timer_get_time(void) { return now_us; }
const esp_app_desc_t *esp_app_get_description(void) { static const esp_app_desc_t d = { .version = "0.0.0" }; return &d; }
const board_t *board(void) { static const board_t b = { .name = "stub" }; return &b; }
bool device_mac_str(char *o, size_t n) { snprintf(o, n, "aa"); return true; }
void last_words_report(void) {}
void last_words_phase(lw_task_t t, const char *p) { (void)t; (void)p; }
void last_words_rx(uint32_t ms) { (void)ms; }
esp_err_t esp_task_wdt_add(void *t) { (void)t; return ESP_OK; }
esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }
struct host_mutex { pthread_mutex_t m; };
SemaphoreHandle_t xSemaphoreCreateMutex(void) { struct host_mutex *m = malloc(sizeof *m); pthread_mutex_init(&m->m, NULL); return m; }
BaseType_t xSemaphoreTake(SemaphoreHandle_t m, TickType_t w) { (void)w; pthread_mutex_lock(&m->m); return pdTRUE; }
BaseType_t xSemaphoreGive(SemaphoreHandle_t m) { pthread_mutex_unlock(&m->m); return pdTRUE; }
BaseType_t xTaskCreate(TaskFunction_t f, const char *n, uint32_t s, void *a, unsigned p, TaskHandle_t *o)
{ (void)f; (void)n; (void)s; (void)a; (void)p; (void)o; return pdPASS; }
void vTaskDelete(TaskHandle_t t) { (void)t; }
void vTaskDelay(TickType_t t) { (void)t; }
uint32_t ulTaskNotifyTake(BaseType_t c, TickType_t w) { (void)c; (void)w; return 0; }
BaseType_t xTaskNotifyGive(TaskHandle_t t) { (void)t; return pdPASS; }

// ---- settings: an in-memory config_store and the panel ----
static uint8_t cfg_bright = 220, panel_level;
static bool cfg_muted = true;
static char cfg_lang[CFG_VLANG_MAX] = "en";
uint8_t config_load_brightness(void) { return cfg_bright; }
void config_save_brightness(uint8_t l) { cfg_bright = l; }
bool config_load_muted(void) { return cfg_muted; }
bool config_save_muted(bool m) { cfg_muted = m; return true; }
void config_load_voicelang(char *o, size_t n) { snprintf(o, n, "%s", cfg_lang); }
bool config_save_voicelang(const char *l) { snprintf(cfg_lang, sizeof cfg_lang, "%s", l); return true; }
void pro_app_set_brightness(uint8_t level) { panel_level = level; }

// ---- fw_update recorders: this test is about ROUTING, so fw_update.c is not linked (its own test covers the logic) ----
static bool voice_is_open;
bool pro_voice_open(void) { return voice_is_open; }
static struct { int offers, slices, aborts, ticks; char version[32], sha[80], why[32]; int size; bool busy; size_t slice_len; uint8_t first; uint32_t now; } fw;
// What the gate says, how long the stubbed fw_update_* "block" (the slot erase, the read-back hash), what they answer.
static bool gate_ok = true, offer_accepts, offer_active;
static int gate_begins, gate_ends, confirms, confirm_downs, notes;
static uint32_t confirm_at;
static int64_t block_us;
bool pro_app_begin_update_gate(void) { gate_begins++; return gate_ok; }
void pro_app_end_update_gate(void) { gate_ends++; }
void pro_app_note_update(void) { notes++; }
void fw_confirm_session_up(uint32_t ms) { confirms++; confirm_at = ms; }
void fw_confirm_session_down(void) { confirm_downs++; }
bool fw_update_active(void) { return offer_active; }
bool fw_update_offer(const char *v, int size, const char *sha, bool busy)
{
    now_us += block_us;
    fw.offers++; fw.size = size; fw.busy = busy;
    snprintf(fw.version, sizeof fw.version, "%s", v ? v : "<null>");
    snprintf(fw.sha, sizeof fw.sha, "%s", sha ? sha : "<null>");
    return offer_accepts;
}
void fw_update_slice(const uint8_t *d, size_t n) { now_us += block_us; fw.slices++; fw.slice_len = n; fw.first = n ? d[0] : 0; }
void fw_update_abort(const char *why) { fw.aborts++; snprintf(fw.why, sizeof fw.why, "%s", why); }
void fw_update_tick(uint32_t now) { fw.ticks++; fw.now = now; }

// ---- helpers -------------------------------------------------------------------------------------------
static void reset(void) { nev = 0; nsent = 0; }

static void feed(const char *json)
{
    pro_cable_on_frame(CABLE_FRAME_VERSION, CABLE_TYPE_JSON, (const uint8_t *)json, strlen(json), NULL);
}
// printf into a heap buffer, then feed it (the long-string cases).
static void feedf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void feedf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    char *s = NULL;
    int n = vasprintf(&s, fmt, ap);
    va_end(ap);
    CHECK(n > 0 && s);
    feed(s);
    free(s);
}
static char *repeat(const char *unit, int times)
{
    size_t u = strlen(unit);
    char *s = malloc(u * (size_t)times + 1);
    for (int i = 0; i < times; i++) memcpy(s + (size_t)i * u, unit, u);
    s[u * (size_t)times] = 0;
    return s;
}
static bool utf8_ok(const char *s)
{
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        int n = *p < 0x80 ? 0 : (*p >> 5) == 6 ? 1 : (*p >> 4) == 14 ? 2 : (*p >> 3) == 30 ? 3 : -1;
        if (n < 0) return false;
        p++;
        while (n--) { if ((*p & 0xC0) != 0x80) return false; p++; }
    }
    return true;
}
static void welcome(void)
{
    feed("{\"t\":\"welcome\",\"machine\":{\"id\":\"m1\",\"name\":\"Mac\"},\"features\":[\"player.library\"]}");
}

// ---- cases ---------------------------------------------------------------------------------------------
static void pro_cable_test_turn_activity(void)
{
    welcome();   // frames only count inside a session
    reset();
    feed("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"text\":\"Infusing...\",\"action\":\"Reading\",\"step\":\"Read \xC2\xB7 x.c\",\"elapsedSeconds\":12}");
    CHECK(nev == 3);
    CHECK(evs[0].kind == EV_TURN && !strcmp(evs[0].id, "a") && !strcmp(evs[0].a, "verb") && !strcmp(evs[0].b, "Infusing...") && evs[0].n1 == -1);
    CHECK(evs[1].kind == EV_TURN && !strcmp(evs[1].a, "activity") && !strcmp(evs[1].b, "Reading") && evs[1].n1 == 12);
    CHECK(evs[2].kind == EV_TURN && !strcmp(evs[2].a, "step") && !strcmp(evs[2].b, "Read \xC2\xB7 x.c") && evs[2].n1 == -1);

    // An empty text gives no verb; the step still comes.
    reset();
    feed("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"text\":\"\",\"step\":\"Bash \xC2\xB7 ls\"}");
    CHECK(nev == 1 && !strcmp(evs[0].a, "step"));
    reset();   // an empty step too: nothing at all
    feed("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"text\":\"\",\"step\":\"\"}");
    CHECK(nev == 0);

    // elapsedSeconds: only an integer 0..2592000; anything else is -1 (keep the model's clock).
    const char *bad[] = { "-1", "1.5", "2592001", "\"12\"", "null", "1e999" };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        reset();
        feedf("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"action\":\"x\",\"elapsedSeconds\":%s}", bad[i]);
        CHECK(nev == 1 && evs[0].n1 == -1);
    }
    reset();   // elapsed alone is an activity with an empty sentence; the limits are inclusive
    feed("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"elapsedSeconds\":2592000}");
    CHECK(nev == 1 && !strcmp(evs[0].a, "activity") && !strcmp(evs[0].b, "") && evs[0].n1 == 2592000);
    reset();
    feed("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"elapsedSeconds\":0}");
    CHECK(nev == 1 && evs[0].n1 == 0);

    // The rest of a turn.
    reset();
    feed("{\"t\":\"turn.started\",\"agentId\":\"a\",\"text\":\"Working\"}");
    feed("{\"t\":\"turn.started\",\"agentId\":\"b\"}");
    feed("{\"t\":\"turn.done\",\"agentId\":\"a\"}");
    feed("{\"t\":\"turn.error\",\"agentId\":\"a\",\"message\":\"boom\"}");
    feed("{\"t\":\"focus\",\"agentId\":\"a\"}");
    feed("{\"p\":{\"agentId\":\"c\"},\"t\":\"turn.done\"}");   // enveloped form
    CHECK(nev == 6);
    CHECK(!strcmp(evs[0].a, "started") && !strcmp(evs[0].b, "Working") && evs[0].n1 == 0);
    CHECK(!strcmp(evs[1].a, "started") && !strcmp(evs[1].b, "") && !strcmp(evs[1].id, "b"));
    CHECK(!strcmp(evs[2].a, "done") && !strcmp(evs[2].b, ""));
    CHECK(!strcmp(evs[3].a, "error"));
    CHECK(evs[4].kind == EV_FOCUS && !strcmp(evs[4].id, "a"));
    CHECK(evs[5].kind == EV_TURN && !strcmp(evs[5].id, "c"));
    // No agent, or one too long for ID_MAX: dropped.
    reset();
    feed("{\"t\":\"turn.done\"}");
    feed("{\"t\":\"turn.done\",\"agentId\":\"\"}");
    feedf("{\"t\":\"turn.done\",\"agentId\":\"%0*d\"}", ID_MAX, 7);
    CHECK(nev == 0);
}

static void pro_cable_test_old_daemon(void)
{
    welcome();   // frames only count inside a session
    // turn.activity with only `text`: a verb, nothing else.
    reset();
    feed("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"text\":\"Thinking...\"}");
    CHECK(nev == 1 && !strcmp(evs[0].a, "verb") && !strcmp(evs[0].b, "Thinking..."));

    // summary without `full`.
    reset();
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"done it\",\"recap\":\"short\"}");
    CHECK(nev == 1 && evs[0].kind == EV_SUMMARY);
    CHECK(!strcmp(evs[0].a, "done it") && !strcmp(evs[0].b, "short") && !strcmp(evs[0].c, "<null>") && evs[0].n1 == 0);
    reset();   // no recap either, restore on
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"restore\":true}");
    CHECK(nev == 1 && !strcmp(evs[0].b, "<null>") && !strcmp(evs[0].c, "<null>") && evs[0].n1 == 1);
    reset();   // a full that is present arrives, and an empty one is not NULL
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"recap\":\"r\",\"full\":\"the long one\"}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"full\":\"\"}");
    CHECK(!strcmp(evs[0].c, "the long one") && !strcmp(evs[1].c, ""));

    // swarms without agentIds/members/tiles: members NULL, panes falls back to agents.
    reset();
    feed("{\"t\":\"swarms\",\"selected\":\"s1\",\"items\":[{\"id\":\"s1\",\"name\":\"One\",\"agents\":3},{\"id\":\"s2\",\"name\":\"Two\",\"agents\":1,\"panes\":4}]}");
    CHECK(nev == 1 && evs[0].kind == EV_SWARMS && evs[0].n1 == 2 && evs[0].n2 == 0 && evs[0].n3 == 0);
    CHECK(!strcmp(evs[0].a, "s1") && rec_swarms[0].agents == 3 && rec_swarms[0].panes == 3 && rec_swarms[1].panes == 4);
    // agentIds without members (a daemon that sends the ids only): members present, nothing described.
    reset();
    feed("{\"t\":\"swarms\",\"items\":[{\"id\":\"s1\",\"agents\":2,\"agentIds\":[\"x\",\"y\"]}]}");
    CHECK(nev == 1 && evs[0].n2 == 1 && !strcmp(evs[0].a, "<null>"));
    CHECK(rec_members.count[0] == 2 && !strcmp(rec_members.id[0][1], "y") && !rec_members.meta[0][0].has && !rec_members.meta[0][1].has);
    // ...and with members: matched by id, an unknown id skipped, online defaults to true.
    reset();
    feed("{\"t\":\"swarms\",\"items\":[{\"id\":\"s1\",\"agentIds\":[\"x\",\"y\"],\"members\":[{\"id\":\"y\",\"name\":\"Why\",\"engine\":\"codex\",\"machine\":\"Box\",\"online\":false},{\"id\":\"zz\",\"name\":\"no\"},{\"id\":\"x\",\"name\":\"Ex\"}]}],\"tiles\":[{\"x1\":0,\"y1\":0,\"x2\":500,\"y2\":1000,\"a\":\"x\"},{\"x1\":9,\"y1\":0,\"x2\":5,\"y2\":9}]}");
    CHECK(evs[0].n3 == 1 && !strcmp(rec_tiles[0].agent_id, "x") && rec_tiles[0].x2 == 500);
    CHECK(rec_members.meta[0][1].has && !rec_members.meta[0][1].online && !strcmp(rec_members.meta[0][1].machine, "Box"));
    CHECK(rec_members.meta[0][0].has && rec_members.meta[0][0].online && !strcmp(rec_members.meta[0][0].name, "Ex"));

    // welcome with no features: no library; roster and machines still flow.
    reset();
    feed("{\"t\":\"welcome\",\"machine\":{\"id\":\"m9\",\"name\":\"Old\"}}");
    CHECK(pro_cable_connected() && !pro_cable_library_supported());
    feed("{\"t\":\"agents.begin\"}");
    feed("{\"t\":\"agent\",\"id\":\"a1\",\"name\":\"Alpha\",\"engine\":\"claude\"}");
    feed("{\"t\":\"agents.end\"}");
    int agents = -1;
    for (int i = 0; i < nev; i++) if (evs[i].kind == EV_AGENTS) { agents = (int)evs[i].n1; CHECK(!strcmp(evs[i].a, "Alpha")); }
    CHECK(agents == 1);
}

static void pro_cable_test_oversize(void)
{
    welcome();   // frames only count inside a session
    // A 400-character step (199 two-byte letters after an 'a': the cut at 120 B falls inside a letter) arrives cut
    // on a boundary, at 120 B or less.
    char *step_tail = repeat("\xC3\xA9", 199);
    reset();
    feedf("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"step\":\"a%s\"}", step_tail);
    CHECK(nev == 1 && !strcmp(evs[0].a, "step"));
    CHECK(strlen(evs[0].b) <= 120 && strlen(evs[0].b) >= 118 && utf8_ok(evs[0].b));
    free(step_tail);
    char *ascii = repeat("x", 400);   // plain ASCII: exactly 120
    reset();
    feedf("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"step\":\"%s\"}", ascii);
    CHECK(strlen(evs[0].b) == 120);
    free(ascii);

    // A 900-character activity and verb fit their buffers.
    char *act = repeat("\xE2\x80\xA6", 300);   // 900 chars, 900 bytes (3-byte ellipses), so every cut is mid-letter
    reset();
    feedf("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"text\":\"%s\",\"action\":\"%s\"}", act, act);
    CHECK(nev == 2);
    CHECK(strlen(evs[0].b) <= PRO_VERB_BYTES - 1 && strlen(evs[0].b) > 0 && utf8_ok(evs[0].b));
    CHECK(strlen(evs[1].b) <= PRO_ACTION_BYTES - 1 && strlen(evs[1].b) > 0 && utf8_ok(evs[1].b));
    free(act);

    // A 3000-character full is cut to fit the 2048 B recap; text and recap likewise.
    char *big = repeat("\xC3\xA9", 3000);
    reset();
    // (a frame is capped at 8192 B, so each field gets its own frame)
    feedf("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"%s\"}", big);
    feedf("{\"t\":\"summary\",\"agentId\":\"a\",\"recap\":\"%s\"}", big);
    feedf("{\"t\":\"summary\",\"agentId\":\"a\",\"full\":\"%s\"}", big);
    CHECK(nev == 3);
    const char *got[3] = { evs[0].a, evs[1].b, evs[2].c };
    for (int i = 0; i < 3; i++)
        CHECK(strlen(got[i]) <= POD_RECAP_BYTES - 1 && strlen(got[i]) >= POD_RECAP_BYTES - 2 && utf8_ok(got[i]));
    free(big);

    // A question prompt and a library-free voice error are cut the same way.
    char *prompt = repeat("\xC3\xA9", 600);
    reset();
    feedf("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"%s\"}]}", prompt);
    CHECK(nev == 1 && evs[0].kind == EV_QUESTION && strlen(evs[0].a) <= PRO_QUESTION_BYTES - 1 && utf8_ok(evs[0].a));
    free(prompt);

    // 64 swarms over the cap: exactly SWARMS_MAX come through, once, and the call returns.
    char *items = malloc(64 * 20);
    items[0] = 0;
    for (int i = 0; i < 64; i++) sprintf(items + strlen(items), "%s{\"id\":\"t%d\"}", i ? "," : "", i);
    reset();
    feedf("{\"t\":\"swarms\",\"items\":[%s]}", items);
    CHECK(nev == 1 && evs[0].n1 == SWARMS_MAX && !strcmp(rec_swarms[SWARMS_MAX - 1].id, "t23"));
    free(items);
    // 64 full-size swarms are over the JSON guard's token budget: the frame is refused as bad, no call, no loop.
    char *full = malloc(64 * 120);
    full[0] = 0;
    for (int i = 0; i < 64; i++)
        sprintf(full + strlen(full), "%s{\"id\":\"t%d\",\"name\":\"n%d\",\"agents\":1,\"panes\":1,\"agentIds\":[\"x%d\"]}", i ? "," : "", i, i, i);
    uint32_t bad0, unknown0, bad1;
    pro_cable_counters(&bad0, &unknown0);
    reset();
    feedf("{\"t\":\"swarms\",\"items\":[%s]}", full);
    pro_cable_counters(&bad1, &unknown0);
    CHECK(nev == 0 && bad1 == bad0 + 1);
    free(full);
    // ...and 24 members x 24 tabs of ids within the budget are bounded by SWARM_MEMBERS_MAX.
    char *ids = malloc(40 * 30);
    ids[0] = 0;
    for (int i = 0; i < 40; i++) sprintf(ids + strlen(ids), "%s\"p%d\"", i ? "," : "", i);
    reset();
    feedf("{\"t\":\"swarms\",\"items\":[{\"id\":\"s\",\"agentIds\":[%s]}]}", ids);
    CHECK(nev == 1 && rec_members.count[0] == SWARM_MEMBERS_MAX);
    free(ids);

    // 40 agents: the roster holds POD_AGENTS_MAX; duplicate and over-long ids are dropped.
    reset();
    feed("{\"t\":\"agents.begin\"}");
    feed("{\"t\":\"agent\",\"id\":\"d0\"}");
    feed("{\"t\":\"agent\",\"id\":\"d0\",\"name\":\"again\"}");
    feedf("{\"t\":\"agent\",\"id\":\"%0*d\"}", ID_MAX, 1);
    for (int i = 1; i < 40; i++) feedf("{\"t\":\"agent\",\"id\":\"d%d\",\"name\":\"N%d\"}", i, i);
    feed("{\"t\":\"agents.end\"}");
    CHECK(nev == 1 && evs[0].kind == EV_AGENTS && evs[0].n1 == POD_AGENTS_MAX);
    CHECK(!strcmp(rec_agent_ids[0], "d0") && !strcmp(rec_agent_ids[POD_AGENTS_MAX - 1], "d31") && !strcmp(evs[0].a, "d0"));
    reset();   // an end with no begin is not a roster
    feed("{\"t\":\"agents.end\"}");
    CHECK(nev == 0);

    // A frame bigger than the JSON guard's byte budget, a deep one and a non-object are refused, never parsed.
    uint32_t b0, b1;
    pro_cable_counters(&b0, &unknown0);
    char *deep = repeat("[", 40);
    reset();
    feedf("{\"t\":\"x\",\"v\":%s}", deep);
    feed("[1,2]");
    feed("{\"t\":\"turn.done\"");
    pro_cable_counters(&b1, &unknown0);
    CHECK(nev == 0 && b1 == b0 + 3);
    free(deep);
}

static void pro_cable_test_ignores_round(void)
{
    welcome();   // frames only count inside a session
    const char *round[] = {
        "{\"t\":\"carry.state\",\"agentId\":\"a\",\"carryId\":\"c1\",\"state\":\"ready\"}",
        "{\"t\":\"draft.state\",\"agentId\":\"a\",\"draftId\":\"d\",\"text\":\"x\"}",
        "{\"t\":\"visit.state\",\"agentId\":\"a\",\"visitId\":\"v\"}",
        "{\"t\":\"form.state\",\"formId\":\"f\"}",
        "{\"t\":\"selection.state\",\"agentId\":\"a\"}",
        "{\"t\":\"metrics.state\",\"requestId\":\"r\"}",
        "{\"t\":\"workspace.state\"}",
        "{\"t\":\"perf\"}",
        "{\"t\":\"toast\",\"text\":\"hi\"}",
        "{\"t\":\"models\",\"agentId\":\"a\",\"items\":[]}",
        "{\"t\":\"speech.state\",\"agentId\":\"a\"}",
        "{\"t\":\"wifi.configure\",\"ssid\":\"x\",\"password\":\"y\"}",
        "{\"t\":\"voice.draft\",\"agentId\":\"a\"}",
        "{\"t\":\"player.overview\",\"harnesses\":1}",
        "{\"t\":\"question.state\",\"agentId\":\"a\"}",
        "{\"t\":\"no.such.message\"}",
    };
    uint32_t bad0, unknown0, bad1, unknown1;
    pro_cable_counters(&bad0, &unknown0);
    reset();
    for (unsigned i = 0; i < sizeof round / sizeof round[0]; i++) feed(round[i]);
    pro_cable_counters(&bad1, &unknown1);
    CHECK(nev == 0 && nsent == 0);
    CHECK(unknown1 == unknown0 + sizeof round / sizeof round[0] && bad1 == bad0);
    // The frame kinds the Pro does not take (PCM, speech 0x05; firmware slices 0x03 are routed, see fw_frame_routes) are counted too.
    pro_cable_counters(&bad0, &unknown0);
    pro_cable_on_frame(CABLE_FRAME_VERSION, CABLE_TYPE_PCM, (const uint8_t *)"abc", 3, NULL);
    pro_cable_on_frame(CABLE_FRAME_VERSION, 0x05, (const uint8_t *)"abc", 3, NULL);
    pro_cable_counters(&bad1, &unknown1);
    CHECK(nev == 0 && unknown1 == unknown0 + 2);
}

static void end_session(void)
{
    now_us += 16 * 1000000;
    pro_cable_tick(NULL);
    CHECK(!pro_cable_connected());
}

// Without a session (before the welcome, or after it ended) only welcome and ping are heard: nothing reaches pro_app.
static void pro_cable_test_no_session(void)
{
    reset();
    CHECK(!pro_cable_connected());
    feed("{\"t\":\"agents.begin\"}");
    feed("{\"t\":\"agent\",\"id\":\"a1\",\"name\":\"Alpha\",\"engine\":\"claude\"}");
    feed("{\"t\":\"agents.end\"}");
    feed("{\"t\":\"turn.started\",\"agentId\":\"a1\",\"text\":\"Working\"}");
    feed("{\"t\":\"question\",\"agentId\":\"a1\",\"id\":\"q\",\"questions\":[{\"q\":\"x\"}]}");
    feed("{\"t\":\"summary\",\"agentId\":\"a1\",\"text\":\"done\"}");
    feed("{\"t\":\"swarms\",\"items\":[{\"id\":\"s1\",\"agents\":1}]}");
    feed("{\"t\":\"focus\",\"agentId\":\"a1\"}");
    feed("{\"t\":\"machines.begin\"}");
    feed("{\"t\":\"machines.end\"}");
    feed("{\"t\":\"agent.updated\",\"agentId\":\"a1\"}");
    CHECK(nev == 0 && nsent == 0);   // no pro_app call, no reply on the wire
    feed("{\"t\":\"ping\"}");
    CHECK(nev == 0 && nsent == 1 && strstr(sent[0], "pong"));   // the link's own keepalive still answers
    // After a session ends the same holds: the welcome opens the gate, the silence closes it.
    welcome();
    CHECK(pro_cable_connected() && nev == 1 && evs[0].kind == EV_LINK);
    reset();
    end_session();
    reset();
    feed("{\"t\":\"turn.started\",\"agentId\":\"a1\"}");
    feed("{\"t\":\"agents.begin\"}");
    CHECK(nev == 0 && nsent == 0);
}

static void test_session_machines_library_voice(void)
{
    end_session();
    // welcome: link up, then machines.list + agents.list are asked for; a repeat greeting does nothing more.
    reset();
    welcome();
    CHECK(nev == 1 && evs[0].kind == EV_LINK && evs[0].n1 == 1 && !strcmp(evs[0].a, "Mac"));
    CHECK(nsent == 2 && strstr(sent[0], "machines.list") && strstr(sent[1], "agents.list"));
    CHECK(pro_cable_connected() && pro_cable_library_supported());
    reset();
    welcome();
    CHECK(nev == 0 && nsent == 0);
    feed("{\"t\":\"ping\"}");
    CHECK(nsent == 1 && strstr(sent[0], "pong"));
    reset();
    feed("{\"t\":\"agent.updated\",\"agentId\":\"a\"}");
    CHECK(nsent == 1 && strstr(sent[0], "agents.list"));

    // machines: an identical list is not re-delivered; an update that changes a row is.
    reset();
    feed("{\"t\":\"machines.begin\"}");
    feed("{\"t\":\"machine\",\"id\":\"m1\",\"name\":\"Mac\",\"state\":\"ready\",\"local\":true}");
    feed("{\"t\":\"machine\",\"id\":\"m2\",\"name\":\"Box\",\"state\":\"offline\"}");
    feed("{\"t\":\"machines.end\",\"selected\":\"m1\"}");
    CHECK(nev == 1 && evs[0].kind == EV_MACHINES && evs[0].n1 == 2 && !strcmp(evs[0].a, "m1"));
    reset();
    feed("{\"t\":\"machines.begin\"}");
    feed("{\"t\":\"machine\",\"id\":\"m1\",\"name\":\"Mac\",\"state\":\"ready\",\"local\":true}");
    feed("{\"t\":\"machine\",\"id\":\"m2\",\"name\":\"Box\",\"state\":\"offline\"}");
    feed("{\"t\":\"machines.end\",\"selected\":\"m1\"}");
    CHECK(nev == 0);
    feed("{\"t\":\"machine.updated\",\"id\":\"m2\",\"state\":\"ready\"}");
    CHECK(nev == 1 && evs[0].kind == EV_MACHINES && evs[0].n1 == 2);

    // library: only the latest request's reply, strictly parsed; the machine id becomes the machine name.
    const char *page = "{\"t\":\"player.library\",\"request\":%d,\"offset\":0,\"total\":2,\"machines\":2,\"rows\":["
        "{\"id\":\"a\",\"machineId\":\"m2\",\"name\":\"Alpha\",\"engine\":\"claude\",\"status\":\"working\",\"ageSeconds\":5},"
        "{\"id\":\"b\",\"machineId\":\"zz\",\"name\":\"Beta\",\"engine\":\"codex\",\"status\":\"idle\",\"ageSeconds\":-1}]}";
    reset();
    feedf(page, 7);   // never requested: dropped
    CHECK(nev == 0);
    CHECK(pro_cable_request_library(0, 7) && nsent == 1 && strstr(sent[0], "player.library.get") && strstr(sent[0], "\"request\":7"));
    CHECK(!pro_cable_request_library(-1, 8) && !pro_cable_request_library(1000001, 8));
    feedf(page, 6);   // an older request: dropped
    CHECK(nev == 0);
    feedf(page, 7);
    CHECK(nev == 1 && evs[0].kind == EV_LIBRARY && evs[0].n1 == 2 && evs[0].n3 == 2);
    CHECK(!strcmp(evs[0].a, "Alpha") && !strcmp(evs[0].b, "Box") && !strcmp(evs[0].c, "working") && evs[0].n4 == 5);
    reset();   // a count that does not match min(6, total - offset) rejects the whole page
    feed("{\"t\":\"player.library\",\"request\":7,\"offset\":0,\"total\":3,\"machines\":1,\"rows\":[{\"id\":\"a\",\"machineId\":\"m\",\"name\":\"A\",\"engine\":\"e\",\"status\":\"idle\",\"ageSeconds\":0}]}");
    feed("{\"t\":\"player.library\",\"request\":7,\"offset\":0,\"total\":1,\"machines\":1,\"rows\":[{\"id\":\"a\",\"machineId\":\"m\",\"name\":\"A\",\"engine\":\"e\",\"status\":\"sleeping\",\"ageSeconds\":0}]}");
    CHECK(nev == 0);

    // questions
    reset();
    feed("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"Proceed?\"}]}");
    feed("{\"t\":\"question\",\"agentId\":\"b\",\"id\":\"q2\"}");
    feed("{\"t\":\"question\",\"agentId\":\"c\"}");
    feed("{\"t\":\"question.close\",\"agentId\":\"a\",\"id\":\"q1\"}");
    feed("{\"t\":\"question.close\",\"agentId\":\"a\"}");
    CHECK(nev == 3 && !strcmp(evs[0].a, "Proceed?") && !strcmp(evs[1].a, "Needs your answer") && evs[2].kind == EV_QCLOSE);
    CHECK(!strcmp(evs[0].b, "<null>") && evs[0].n1 == POD_ATTN_NONE && !strcmp(evs[1].b, "<null>") && evs[1].n1 == POD_ATTN_NONE);   // a plain question: as before

    // a Super Tab's question: superTab names the project, attention says decision or stuck (an unknown one is a decision)
    reset();
    feed("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"Staging or prod?\"}],\"superTab\":\"Launch v2\",\"attention\":\"decision\"}");
    feed("{\"t\":\"question\",\"agentId\":\"b\",\"id\":\"q2\",\"questions\":[{\"q\":\"Stuck: no write access\"}],\"superTab\":\"Launch v2\",\"attention\":\"stuck\"}");
    feed("{\"t\":\"question\",\"agentId\":\"c\",\"id\":\"q3\",\"questions\":[{\"q\":\"Which?\"}],\"superTab\":\"Launch v2\",\"attention\":\"blocked-ish\"}");
    feed("{\"t\":\"question\",\"agentId\":\"d\",\"id\":\"q4\",\"questions\":[{\"q\":\"Which?\"}],\"superTab\":\"Launch v2\"}");
    CHECK(nev == 4 && evs[0].kind == EV_QUESTION && !strcmp(evs[0].a, "Staging or prod?") && !strcmp(evs[0].b, "Launch v2") && evs[0].n1 == POD_ATTN_DECISION);
    CHECK(!strcmp(evs[1].id, "b") && !strcmp(evs[1].a, "Stuck: no write access") && !strcmp(evs[1].b, "Launch v2") && evs[1].n1 == POD_ATTN_STUCK);
    CHECK(evs[2].n1 == POD_ATTN_DECISION && evs[3].n1 == POD_ATTN_DECISION && !strcmp(evs[3].b, "Launch v2"));
    reset();   // attention without a Super Tab, an empty or a non-string superTab: a plain question
    feed("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"x\"}],\"attention\":\"stuck\"}");
    feed("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"x\"}],\"superTab\":\"\",\"attention\":\"stuck\"}");
    feed("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"x\"}],\"superTab\":7,\"attention\":\"stuck\"}");
    CHECK(nev == 3);
    for (int i = 0; i < 3; i++) CHECK(!strcmp(evs[i].b, "<null>") && evs[i].n1 == POD_ATTN_NONE);
    {   // a long Super Tab name is cut to SUPER_TAB_MAX - 1 bytes on a UTF-8 boundary
        char *tab = repeat("\xC3\xA9", 40);
        reset();
        feedf("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q1\",\"questions\":[{\"q\":\"x\"}],\"superTab\":\"%s\",\"attention\":\"stuck\"}", tab);
        CHECK(nev == 1 && strlen(evs[0].b) <= SUPER_TAB_MAX - 1 && strlen(evs[0].b) >= SUPER_TAB_MAX - 2 && utf8_ok(evs[0].b) && evs[0].n1 == POD_ATTN_STUCK);
        free(tab);
    }

    // player.context is delivered (pro_app ignores it)
    reset();
    feed("{\"t\":\"player.context\",\"id\":\"a\",\"machine\":\"Mac\",\"project\":\"p\",\"branch\":\"main\",\"engine\":\"claude\"}");
    CHECK(nev == 1 && evs[0].kind == EV_CONTEXT && !strcmp(evs[0].a, "Mac"));

    // voice: replies for another upload are dropped; a route that needs confirming is confirmed
    reset();
    CHECK(pro_cable_voice_begin("a", NULL, 16000, "up1") && nsent == 1 && strstr(sent[0], "\"lang\":\"en\"") && strstr(sent[0], "\"uploadId\":\"up1\""));
    feed("{\"t\":\"voice.transcript\",\"uploadId\":\"up0\",\"agentId\":\"a\"}");
    feed("{\"t\":\"voice.error\",\"uploadId\":\"up0\",\"message\":\"no\"}");
    CHECK(nev == 0);
    feed("{\"t\":\"voice.transcript\",\"uploadId\":\"up1\",\"agentId\":\"a\",\"needsConfirm\":true,\"routeId\":\"r1\"}");
    CHECK(nev == 1 && evs[0].kind == EV_VOICE && evs[0].n1 == PRO_VOICE_OK && !strcmp(evs[0].a, "a"));
    CHECK(nsent == 2 && strstr(sent[1], "voice.confirm") && strstr(sent[1], "\"routeId\":\"r1\""));
    feed("{\"t\":\"voice.error\",\"uploadId\":\"up1\",\"message\":\"Didn't catch that\"}");
    CHECK(nev == 2 && evs[1].n1 == PRO_VOICE_ERROR && !strcmp(evs[1].a, "Didn't catch that"));
    feed("{\"t\":\"voice.error\"}");   // no upload id named: accepted
    CHECK(nev == 3 && !strcmp(evs[2].a, ""));

    // sends
    reset();
    CHECK(pro_cable_send_open("a") && strstr(sent[0], "\"t\":\"agent.open\"") && strstr(sent[0], "\"agentId\":\"a\""));
    nowait_sent = 0;
    CHECK(pro_cable_send_scroll(PRO_SCROLL_UP, -5, 300) && strstr(sent[1], "\"phase\":\"up\"") && strstr(sent[1], "\"v\":300"));
    CHECK(pro_cable_send_scroll(PRO_SCROLL_DOWN, 0, 0) && !strstr(sent[2], "\"v\""));
    CHECK(!pro_cable_send_open(""));
    CHECK(nowait_sent == 2);   // both scroll echoes went out without waiting; the open (a tap) may wait
    CHECK(pro_cable_request_library(0, 77) && nowait_sent == 3 && strstr(sent[nsent - 1], "player.library.get"));
    CHECK(pro_cable_voice_pcm((const uint8_t *)"ab", 2) && pro_cable_voice_end("up1") && pro_cable_voice_abort("up1", "short")
          && pro_cable_voice_cancel("up1"));

    // the link goes quiet for SILENCE_MS: the session ends, and everything the daemon said is withdrawn
    reset();
    now_us += 16 * 1000000;
    pro_cable_tick(NULL);
    CHECK(nev == 2 && evs[0].kind == EV_MACHINES && evs[0].n1 == 0 && evs[1].kind == EV_LINK && evs[1].n1 == 0);
    CHECK(!pro_cable_connected() && !pro_cable_library_supported());
    reset();
    pro_cable_tick(NULL);
    CHECK(nev == 0);
}

// ---- the small stack -------------------------------------------------------------------------------------
// pro_cable's parser runs on the cable_link task: STACK_CABLE_LINK (12 KB), shared with the reader loop and the decoder. This runs the
// heaviest frames on a thread whose stack is painted first, and measures how deep it went.
#define PAINT 0xA5
static size_t used_bytes;

static void *parse_heavy(void *arg)
{
    (void)arg;
    char *big = repeat("\xC3\xA9", 1100);
    reset();
    welcome();
    for (int round = 0; round < 2; round++) {
        feedf("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"%s\",\"recap\":\"%s\",\"full\":\"%s\"}", big, big, big);
        feedf("{\"t\":\"turn.activity\",\"agentId\":\"a\",\"text\":\"%s\",\"action\":\"%s\",\"step\":\"%s\",\"elapsedSeconds\":9}", big, big, big);
        feedf("{\"t\":\"question\",\"agentId\":\"a\",\"id\":\"q\",\"questions\":[{\"q\":\"%s\"}]}", big);
        feed("{\"t\":\"swarms\",\"selected\":\"s0\",\"items\":["
             "{\"id\":\"s0\",\"name\":\"A\",\"agents\":2,\"panes\":2,\"agentIds\":[\"a\",\"b\"],\"members\":[{\"id\":\"a\",\"name\":\"x\",\"engine\":\"claude\",\"machine\":\"m\",\"online\":true}]},"
             "{\"id\":\"s1\",\"name\":\"B\",\"agents\":1,\"agentIds\":[\"c\"]}],"
             "\"tiles\":[{\"x1\":0,\"y1\":0,\"x2\":500,\"y2\":1000,\"a\":\"a\"},{\"x1\":500,\"y1\":0,\"x2\":1000,\"y2\":1000,\"a\":\"b\"}]}");
        feed("{\"t\":\"machines.begin\"}");
        feed("{\"t\":\"machine\",\"id\":\"m1\",\"name\":\"Mac\",\"state\":\"ready\"}");
        feed("{\"t\":\"machines.end\",\"selected\":\"m1\"}");
        pro_cable_request_library(0, 3 + (uint32_t)round);
        feedf("{\"t\":\"player.library\",\"request\":%d,\"offset\":0,\"total\":2,\"machines\":1,\"rows\":["
              "{\"id\":\"a\",\"machineId\":\"m1\",\"name\":\"Alpha\",\"engine\":\"claude\",\"status\":\"working\",\"ageSeconds\":5},"
              "{\"id\":\"b\",\"machineId\":\"m1\",\"name\":\"Beta\",\"engine\":\"codex\",\"status\":\"idle\",\"ageSeconds\":-1}]}", 3 + round);
        feed("{\"t\":\"agents.begin\"}");
        feed("{\"t\":\"agent\",\"id\":\"a\",\"name\":\"Alpha\",\"engine\":\"claude\",\"machineId\":\"m1\",\"machine\":\"Mac\"}");
        feed("{\"t\":\"agents.end\"}");
        feed("{\"t\":\"voice.transcript\",\"agentId\":\"a\",\"needsConfirm\":true,\"routeId\":\"r\"}");
    }
    free(big);
    CHECK(nev > 10);
    return NULL;
}

static void *painted_entry(void *arg)
{
    unsigned char *base = arg;
    (void)base;
    return parse_heavy(NULL);
}

static void pro_cable_test_small_stack(void)
{
    // (1) A real thread at the device's size: max(STACK_CABLE_LINK, PTHREAD_STACK_MIN). The OS minimum is 16 KB on macOS and
    // glibc, so this proves the parser runs on a thread of that kind, not that the stack is enough.
    size_t want = STACK_CABLE_LINK > (size_t)PTHREAD_STACK_MIN ? STACK_CABLE_LINK : (size_t)PTHREAD_STACK_MIN;
    pthread_attr_t attr;
    pthread_t th;
    CHECK(pthread_attr_init(&attr) == 0 && pthread_attr_setstacksize(&attr, want) == 0);
    CHECK(pthread_create(&th, &attr, parse_heavy, NULL) == 0 && pthread_join(th, NULL) == 0);
    pthread_attr_destroy(&attr);

    // (2) The real measurement: our own 64 KB stack, painted, and the deepest untouched byte read back. The parser
    // plus the reader loop's own frames (decoder + 256 B read chunk, < 1.5 KB) must fit in STACK_CABLE_LINK (task_stacks.h).
    const size_t size = 64 * 1024 > (size_t)PTHREAD_STACK_MIN ? 64 * 1024 : (size_t)PTHREAD_STACK_MIN;   // 128 KB minimum on aarch64 glibc
    unsigned char *stack = NULL;
    CHECK(posix_memalign((void **)&stack, 4096, size) == 0);
    memset(stack, PAINT, size);
    CHECK(pthread_attr_init(&attr) == 0 && pthread_attr_setstack(&attr, stack, size) == 0);
    CHECK(pthread_create(&th, &attr, painted_entry, stack) == 0 && pthread_join(th, NULL) == 0);
    pthread_attr_destroy(&attr);
    size_t low = 0;
    while (low < size && stack[low] == PAINT) low++;
    used_bytes = size - low;
    free(stack);
    fprintf(stderr, "pro_cable parser stack high-water: %zu B on the host (thread stack for case 1: %zu B)\n", used_bytes, want);
    CHECK(used_bytes + 1536 <= 12288);
}

static void test_settings(void)
{
    reset();
    welcome();
    reset();
    // muted round-trip: the reply carries every key the app's parser requires, and the value read back
    feed("{\"t\":\"settings.set\",\"muted\":false}");
    CHECK(nsent == 1 && strstr(sent[0], "\"t\":\"settings.state\"") && strstr(sent[0], "\"ok\":true"));
    CHECK(strstr(sent[0], "\"muted\":false") && !cfg_muted);
    CHECK(strstr(sent[0], "\"voiceLang\":\"en\"") && strstr(sent[0], "\"round\":false") && strstr(sent[0], "\"character\":0"));
    // absent fields stay: brightness untouched by the muted-only set
    CHECK(cfg_bright == 220 && panel_level == 0);
    reset();
    // brightness is a percent on the wire; the panel and NVS keep 0..255. Clamped, applied and stored.
    feed("{\"t\":\"settings.set\",\"brightness\":50,\"voiceLang\":\"vi\"}");
    CHECK(nsent == 1 && strstr(sent[0], "\"ok\":true") && strstr(sent[0], "\"brightness\":50") && strstr(sent[0], "\"voiceLang\":\"vi\""));
    CHECK(cfg_bright == 128 && panel_level == 128 && !strcmp(cfg_lang, "vi") && !cfg_muted);
    reset();
    feed("{\"t\":\"settings.set\",\"brightness\":500}");
    CHECK(strstr(sent[0], "\"brightness\":100") && cfg_bright == 255);
    // an invalid language refuses the whole set: nothing changes, the values are read back
    reset();
    feed("{\"t\":\"settings.set\",\"muted\":true,\"voiceLang\":\"waytoolongcode\"}");
    CHECK(nsent == 1 && strstr(sent[0], "\"ok\":false") && strstr(sent[0], "\"error\"") && strstr(sent[0], "\"muted\":false"));
    CHECK(!cfg_muted && !strcmp(cfg_lang, "vi"));
    // a round-only field that differs is refused; the same value as the Pro's fixed one is accepted
    reset();
    feed("{\"t\":\"settings.set\",\"muted\":true,\"quiet\":true}");
    CHECK(nsent == 1 && strstr(sent[0], "\"ok\":false") && strstr(sent[0], "Not on this device") && strstr(sent[0], "\"quiet\":false"));
    CHECK(!cfg_muted);
    reset();
    feed("{\"t\":\"settings.set\",\"face\":3}");
    CHECK(strstr(sent[0], "\"ok\":false") && strstr(sent[0], "\"face\":0"));
    reset();
    feed("{\"t\":\"settings.set\",\"muted\":true,\"quiet\":false,\"round\":false,\"character\":0}");
    CHECK(strstr(sent[0], "\"ok\":true") && cfg_muted);
    // screenTurned is gone: never reported, and an old app's settings.set carrying it is ignored without an error
    reset();
    feed("{\"t\":\"settings.set\",\"screenTurned\":true}");
    CHECK(nsent == 1 && strstr(sent[0], "\"ok\":true") && !strstr(sent[0], "screenTurned"));
}

// turn.stats: whole numbers 0..1000000 only; an absent field is -1 (unknown); a bad one refuses the whole message.
static void test_turn_stats(void)
{
    welcome();
    reset();
    feed("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"testsPassed\":44,\"testsFailed\":0,\"commits\":1}");
    CHECK(nev == 1 && evs[0].kind == EV_STATS && !strcmp(evs[0].id, "a") && evs[0].n1 == 44 && evs[0].n2 == 0 && evs[0].n3 == 1);
    reset();
    feed("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"commits\":2}");
    CHECK(nev == 1 && evs[0].n1 == -1 && evs[0].n2 == -1 && evs[0].n3 == 2);
    const char *bad[] = { "-1", "1.5", "1000001", "\"4\"", "null" };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        reset();
        feedf("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"testsPassed\":%s}", bad[i]);
        CHECK(nev == 0);
    }
    reset();
    feed("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"testsPassed\":1000000}");
    CHECK(nev == 1 && evs[0].n1 == 1000000);
    reset();
    feed("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"tokensIn\":42900,\"tokensOut\":18500}");
    CHECK(nev == 1 && evs[0].n1 == -1 && evs[0].n4 == 42900 && evs[0].n5 == 18500);
    reset();
    feed("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"tokensIn\":50000000}");
    CHECK(nev == 1 && evs[0].n4 == 50000000 && evs[0].n5 == -1);
    const char *badt[] = { "50000001", "-1", "1.5" };
    for (unsigned i = 0; i < sizeof badt / sizeof badt[0]; i++) {
        reset();
        feedf("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"tokensIn\":%s}", badt[i]);
        CHECK(nev == 0);
        reset();
        feedf("{\"t\":\"turn.stats\",\"agentId\":\"a\",\"commits\":2,\"tokensOut\":%s}", badt[i]);
        CHECK(nev == 0);
    }
    reset();
    feed("{\"t\":\"turn.stats\",\"testsPassed\":3}");   // no agent
    CHECK(nev == 0);
}

// uiSkin: Pets is the only interface. settings.state no longer reports it, and a host that still sends one (an older daemon) is
// ignored: the set is accepted, nothing else changes.
static void test_ui_skin_ignored(void)
{
    welcome();
    reset();
    feed("{\"t\":\"settings.set\",\"muted\":true}");
    CHECK(nsent == 1 && strstr(sent[0], "\"ok\":true") && !strstr(sent[0], "uiSkin"));
    const char *skins[] = { "\"classic\"", "\"console\"", "\"neon\"", "1", "null" };
    for (unsigned i = 0; i < sizeof skins / sizeof skins[0]; i++) {
        reset();
        feedf("{\"t\":\"settings.set\",\"uiSkin\":%s}", skins[i]);
        CHECK(nsent == 1 && strstr(sent[0], "\"ok\":true") && !strstr(sent[0], "uiSkin") && !strstr(sent[0], "error"));
    }
}

// summary flags: only a plain live summary is news; quiet, silent and restore still deliver the recap.
static void test_notifications(void)
{
    welcome();
    reset();
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"recap\":\"r\"}");
    CHECK(nev == 1 && evs[0].kind == EV_SUMMARY && evs[0].n1 == 0 && evs[0].n2 == POD_TIER_ALERT);   // plain, no tier (an old daemon): an alert
    reset();
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"quiet\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"silent\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"restore\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"quiet\":false,\"silent\":false,\"restore\":false}");
    CHECK(nev == 4 && evs[0].n2 == POD_TIER_SILENT && evs[1].n2 == POD_TIER_SILENT && evs[2].n2 == POD_TIER_SILENT && evs[2].n1 == 1 &&
          evs[3].n2 == POD_TIER_ALERT);

    // tier: it wins over the old flags (a new daemon sends quiet with list, silent with silent); an unknown one is no tier.
    reset();
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"tier\":\"alert\"}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"tier\":\"list\",\"quiet\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"tier\":\"silent\",\"silent\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"tier\":\"list\",\"restore\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"tier\":\"loud\",\"quiet\":true}");
    feed("{\"t\":\"summary\",\"agentId\":\"a\",\"text\":\"t\",\"tier\":7}");
    CHECK(nev == 6 && evs[0].n2 == POD_TIER_ALERT && evs[1].n2 == POD_TIER_LIST && evs[2].n2 == POD_TIER_SILENT &&
          evs[3].n2 == POD_TIER_SILENT && evs[3].n1 == 1 && evs[4].n2 == POD_TIER_SILENT && evs[5].n2 == POD_TIER_ALERT);

    // turn.error carries its message to the app (the failed entry's text).
    reset();
    feed("{\"t\":\"turn.error\",\"agentId\":\"a\",\"message\":\"Build broke\"}");
    CHECK(nev == 1 && evs[0].kind == EV_TURN && !strcmp(evs[0].a, "error") && !strcmp(evs[0].b, "Build broke"));

    // notif.replace: every valid item, in order; duplicates pass through (the model drops them); a bad token is blanked.
    reset();
    feed("{\"t\":\"notif.replace\",\"items\":[{\"agentId\":\"a\",\"name\":\"A\",\"summary\":\"did a\",\"readToken\":\"tok_1-x\"},"
         "{\"agentId\":\"\",\"summary\":\"no id\"},{\"summary\":\"no id either\"},{\"agentId\":\"b\",\"summary\":\"did b\",\"readToken\":\"bad token!\"}]}");
    CHECK(nev == 1 && evs[0].kind == EV_NREPLACE && evs[0].n1 == 2);
    CHECK(!strcmp(evs[0].a, "a") && !strcmp(evs[0].b, "did a") && !strcmp(evs[0].c, "tok_1-x") && !strcmp(evs[0].d, ""));
    reset();
    feed("{\"t\":\"notif.replace\",\"items\":[]}");
    CHECK(nev == 1 && evs[0].n1 == 0);
    reset();
    feed("{\"t\":\"notif.replace\"}");
    CHECK(nev == 0);

    // notif.seen: by agent, or with a valid token; an invalid token drops it.
    reset();
    feed("{\"t\":\"notif.seen\",\"agentId\":\"a\"}");
    feed("{\"t\":\"notif.seen\",\"agentId\":\"a\",\"readToken\":\"tok_1-x\"}");
    feed("{\"t\":\"notif.seen\",\"agentId\":\"a\",\"readToken\":\"no good\"}");
    feed("{\"t\":\"notif.seen\",\"agentId\":\"a\",\"readToken\":7}");
    feed("{\"t\":\"notif.seen\"}");
    CHECK(nev == 2 && evs[0].kind == EV_NSEEN && !strcmp(evs[0].id, "a") && !strcmp(evs[0].a, "(none)") && !strcmp(evs[1].a, "tok_1-x"));

    // notif.read goes out with the token, and never without a valid one.
    reset();
    CHECK(pro_cable_send_notif_read("a", "tok_1-x"));
    CHECK(nsent == 1 && strstr(sent[0], "\"t\":\"notif.read\"") && strstr(sent[0], "\"agentId\":\"a\"") && strstr(sent[0], "\"readToken\":\"tok_1-x\""));
    reset();
    CHECK(!pro_cable_send_notif_read("a", "") && !pro_cable_send_notif_read("a", NULL) && !pro_cable_send_notif_read("", "t") &&
          !pro_cable_send_notif_read("a", "no good") && nsent == 0);
}

#define SHA64 "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
static void fw_offer_routes(void)
{
    welcome(); reset(); memset(&fw, 0, sizeof fw);
    feed("{\"t\":\"fw.offer\",\"p\":{\"version\":\"1.2.3\",\"size\":4096,\"sha256\":\"" SHA64 "\"}}");
    CHECK(fw.offers == 1 && fw.size == 4096 && !fw.busy && !strcmp(fw.version, "1.2.3") && !strcmp(fw.sha, SHA64));
    gate_ok = false;
    feed("{\"t\":\"fw.offer\",\"version\":\"1.2.3\",\"size\":1,\"sha256\":\"" SHA64 "\"}");   // flat form
    CHECK(fw.offers == 2 && fw.busy);
    gate_ok = true;
    // wrong or missing types reach fw_update as NULL / 0, which it refuses
    feed("{\"t\":\"fw.offer\",\"p\":{\"version\":7,\"size\":\"big\"}}");
    CHECK(fw.offers == 3 && !strcmp(fw.version, "<null>") && !strcmp(fw.sha, "<null>") && fw.size == 0);
    feed("{\"t\":\"fw.offer\",\"p\":{\"version\":\"1\",\"size\":1e99,\"sha256\":\"x\"}}");
    CHECK(fw.offers == 4 && fw.size == 0);
    // no session: not heard
    end_session(); memset(&fw, 0, sizeof fw);
    feed("{\"t\":\"fw.offer\",\"p\":{\"version\":\"1.2.3\",\"size\":4096,\"sha256\":\"" SHA64 "\"}}");
    CHECK(fw.offers == 0);
}

static void fw_frame_routes(void)
{
    uint32_t bad0, unk0, bad1, unk1;
    memset(&fw, 0, sizeof fw);
    pro_cable_counters(&bad0, &unk0);
    const uint8_t slice[3] = { 0xAB, 2, 3 };
    pro_cable_on_frame(CABLE_FRAME_VERSION, CABLE_TYPE_FW, slice, sizeof slice, NULL);
    pro_cable_counters(&bad1, &unk1);
    CHECK(fw.slices == 1 && fw.slice_len == 3 && fw.first == 0xAB && unk1 == unk0 && bad1 == bad0);
    fw.ticks = 0;
    now_us += 5000000;
    pro_cable_tick(NULL);
    CHECK(fw.ticks == 1 && fw.now == (uint32_t)(now_us / 1000));
}

// LOW: slices keep the silence timer alive, and so do the blocking calls (the slot erase on the offer, the read-back hash
// after the last slice) - the reader cannot hear the daemon meanwhile.
static void fw_keeps_the_session_alive(void)
{
    welcome(); memset(&fw, 0, sizeof fw);
    now_us += 10 * 1000000;
    const uint8_t slice[3] = { 1, 2, 3 };
    pro_cable_on_frame(CABLE_FRAME_VERSION, CABLE_TYPE_FW, slice, sizeof slice, NULL);   // 10 s after the welcome
    now_us += 10 * 1000000;                                                              // 20 s: silent but for the slice
    pro_cable_tick(NULL);
    CHECK(pro_cable_connected());
    block_us = 12 * 1000000;   // the final slice's checks take 12 s: the clock is refreshed after it returns
    pro_cable_on_frame(CABLE_FRAME_VERSION, CABLE_TYPE_FW, slice, sizeof slice, NULL);
    now_us += 5 * 1000000;
    pro_cable_tick(NULL);
    CHECK(pro_cable_connected());
    feed("{\"t\":\"fw.offer\",\"p\":{\"version\":\"1.2.3\",\"size\":4096,\"sha256\":\"" SHA64 "\"}}");   // erase: 12 s
    now_us += 5 * 1000000;
    pro_cable_tick(NULL);
    CHECK(pro_cable_connected());
    block_us = 0;
    end_session();
}

// LOW: the gate decides busy and holds voice off; a refusal that left nothing in flight releases it (no screen, no notice).
static void fw_offer_gate(void)
{
    welcome(); memset(&fw, 0, sizeof fw); gate_begins = gate_ends = 0;
    const char *offer = "{\"t\":\"fw.offer\",\"p\":{\"version\":\"1.2.3\",\"size\":4096,\"sha256\":\"" SHA64 "\"}}";
    offer_accepts = false; offer_active = false;                   // refused (a bad field), nothing in flight
    feed(offer);
    CHECK(gate_begins == 1 && !fw.busy && gate_ends == 1);
    offer_accepts = true;                                          // accepted: the gate stays held for the transfer
    feed(offer);
    CHECK(gate_begins == 2 && gate_ends == 1);
    offer_accepts = false; offer_active = true;                    // a second offer while one is in flight: not ours to release
    feed(offer);
    CHECK(gate_begins == 3 && gate_ends == 1);
    offer_active = false; gate_ok = false;                         // voice open: busy, and nothing to release but the call is safe
    feed(offer);
    CHECK(fw.busy);
    gate_ok = true;
    end_session();
}

// H3: the welcome starts the clock a fresh image is confirmed on (once per session-up), and the end of the session stops it.
static void fw_confirms_on_welcome(void)
{
    confirms = confirm_downs = notes = 0;
    welcome();
    CHECK(confirms == 1 && confirm_at == (uint32_t)(now_us / 1000) && notes == 0);
    welcome();                          // a repeat welcome on a live session is not a new session
    CHECK(confirms == 1 && confirm_downs == 0);
    end_session();
    CHECK(confirm_downs == 1);
    welcome();                          // a new session starts the clock again
    CHECK(confirms == 2);
    end_session();
}

static void session_down_aborts_then_new_offer_ok(void)
{
    welcome(); memset(&fw, 0, sizeof fw);
    end_session();
    CHECK(fw.aborts == 1 && !strcmp(fw.why, "session down"));
    welcome();
    feed("{\"t\":\"fw.offer\",\"p\":{\"version\":\"1.2.4\",\"size\":10,\"sha256\":\"" SHA64 "\"}}");
    CHECK(fw.offers == 1 && !strcmp(fw.version, "1.2.4"));
}

static void send_shapes(void)
{
    welcome(); reset();
    fw_update_send_accept();
    fw_update_send_progress(65536);
    fw_update_send_done();
    fw_update_send_error("bad sha256");
    CHECK(nsent == 4);
    CHECK(!strcmp(sent[0], "{\"t\":\"fw.accept\"}"));
    CHECK(!strcmp(sent[1], "{\"t\":\"fw.progress\",\"written\":65536}"));
    CHECK(!strcmp(sent[2], "{\"t\":\"fw.done\"}"));
    CHECK(!strcmp(sent[3], "{\"t\":\"fw.error\",\"message\":\"bad sha256\"}"));
    reset();
    fw_update_send_resend(4096);
    CHECK(nsent == 1 && !strcmp(sent[0], "{\"t\":\"fw.progress\",\"written\":4096,\"resend\":true}"));
}

// A frame lost on the way in outside a transfer: ask for the snapshot once, not again within 2 s, never mid-transfer.
// A welcome that advertises `resync` gets the one request; an older daemon's gets the old swarms.list + agents.list.
static void link_resync_with(const char *welcome_json, bool new_daemon)
{
    feed(welcome_json); reset();
    now_us += 10000 * 1000;   // clear the previous window
    pro_cable_tick(NULL); CHECK(nsent == 0);                  // counter unchanged
    link_corrupt++; pro_cable_tick(NULL);
    if (new_daemon) CHECK(nsent == 1 && !strcmp(sent[0], "{\"t\":\"resync\"}"));
    else CHECK(nsent == 2 && strstr(sent[0], "swarms.list") && strstr(sent[1], "agents.list"));
    const int per = nsent;
    reset(); link_corrupt++; now_us += 1999 * 1000; pro_cable_tick(NULL); CHECK(nsent == 0);
    now_us += 1000 * 1000; pro_cable_tick(NULL);               // past 2 s: the pending loss is answered
    CHECK(nsent == per);
    reset(); offer_active = true; link_corrupt++; now_us += 6000 * 1000; pro_cable_tick(NULL);
    CHECK(nsent == 0);                                        // a transfer covers it with resend
    offer_active = false; pro_cable_tick(NULL); CHECK(nsent == 0);   // and the loss during it is not replayed
    end_session();
}
static void link_resync(void)
{
    link_resync_with("{\"t\":\"welcome\",\"machine\":{\"id\":\"m1\",\"name\":\"Mac\"},\"features\":[\"resync\"]}", true);
    link_resync_with("{\"t\":\"welcome\",\"machine\":{\"id\":\"m1\",\"name\":\"Mac\"},\"features\":[\"player.library\"]}", false);
}

// The daemon's `seq`: contiguous frames are silent; a hole counts and asks for a resync (rate-limited); a welcome
// restarts the count; frames without seq (round-style, old daemon) change nothing; ending the session clears it.
static void seq_gaps(void)
{
    now_us += 10000 * 1000;   // clear link_resync's window
    feed("{\"t\":\"welcome\",\"seq\":0,\"machine\":{\"id\":\"m\",\"name\":\"M\"},\"features\":[\"resync\"]}");
    reset();
    const uint32_t g0 = pro_cable_seq_gaps();
    feed("{\"t\":\"ping\",\"seq\":1}"); feed("{\"t\":\"ping\",\"seq\":2}"); feed("{\"t\":\"ping\"}");
    pro_cable_tick(NULL);
    CHECK(pro_cable_seq_gaps() == g0);
    for (int i = 0; i < nsent; i++) CHECK(!strstr(sent[i], "resync"));
    reset();
    feed("{\"t\":\"ping\",\"seq\":4}");                 // 3 never arrived
    CHECK(pro_cable_seq_gaps() == g0 + 1);
    reset(); pro_cable_tick(NULL);
    CHECK(nsent == 1 && strstr(sent[0], "resync"));
    reset(); feed("{\"t\":\"ping\",\"seq\":5}"); pro_cable_tick(NULL);
    for (int i = 0; i < nsent; i++) CHECK(!strstr(sent[i], "resync"));   // 5 follows 4: back in step
    CHECK(pro_cable_seq_gaps() == g0 + 1);
    reset();
    feed("{\"t\":\"ping\",\"seq\":9}"); pro_cable_tick(NULL);        // a second hole inside the 2 s window
    CHECK(pro_cable_seq_gaps() == g0 + 2);
    int resyncs = 0;
    for (int i = 0; i < nsent; i++) resyncs += strstr(sent[i], "resync") != NULL;
    CHECK(resyncs == 0);
    reset(); now_us += 2000 * 1000; pro_cable_tick(NULL);
    CHECK(nsent == 1 && strstr(sent[0], "resync"));   // answered once the window passes
    reset();
    feed("{\"t\":\"welcome\",\"seq\":0,\"machine\":{\"id\":\"m\",\"name\":\"M\"},\"features\":[\"resync\"]}");   // the count starts over
    feed("{\"t\":\"ping\",\"seq\":1}");
    CHECK(pro_cable_seq_gaps() == g0 + 2);
    end_session();
    CHECK(decoder_resets >= 1);                               // the session ended: no half-frame carried over
    reset();
    feed("{\"t\":\"welcome\",\"machine\":{\"id\":\"m\",\"name\":\"M\"}}");   // a daemon without seq
    feed("{\"t\":\"ping\"}"); feed("{\"t\":\"ping\",\"seq\":40}");
    CHECK(pro_cable_seq_gaps() == g0 + 2);                    // a welcome without seq turns the check off for the session
    end_session();
}

// Each Lead's face chat: chat / chatId / chatName on the Lead; a bad field leaves the chat NONE, never drops the Lead or the frame.
static void test_swarm_chat(void)
{
    welcome();
    reset();   // supertab_reads_chat_fields
    feed("{\"t\":\"supertab\",\"id\":\"S1\",\"leads\":[{\"id\":\"L1\",\"chat\":\"group\",\"chatId\":\"g1\",\"chatName\":\"review-cable-fit\"},"
         "{\"id\":\"L2\",\"chat\":\"pm\",\"chatId\":\"p1\",\"chatName\":\"Mai\"},{\"id\":\"L3\",\"chat\":\"lead\"},"
         "{\"id\":\"L4\",\"chat\":\"buddy\"},{\"id\":\"L5\",\"chat\":\"other\",\"chatId\":\"x\"},{\"id\":\"L6\"}]}");
    CHECK(nev == 1 && rec_card.lead_n == 6);
    CHECK(rec_card.leads[0].chat == POD_CHAT_GROUP && !strcmp(rec_card.leads[0].chat_id, "g1") && !strcmp(rec_card.leads[0].chat_name, "review-cable-fit"));
    CHECK(rec_card.leads[1].chat == POD_CHAT_PM && !strcmp(rec_card.leads[1].chat_id, "p1") && !strcmp(rec_card.leads[1].chat_name, "Mai"));
    CHECK(rec_card.leads[2].chat == POD_CHAT_LEAD && rec_card.leads[3].chat == POD_CHAT_BUDDY);
    CHECK(rec_card.leads[4].chat == POD_CHAT_NONE && rec_card.leads[5].chat == POD_CHAT_NONE &&
          rec_card.leads[5].chat_id[0] == 0 && rec_card.leads[5].chat_name[0] == 0);

    reset();   // chat_name_cut_on_codepoint: 60 bytes of "é" cut to 48 whole letters
    char *name = repeat("\xc3\xa9", 30);
    feedf("{\"t\":\"supertab\",\"id\":\"S1\",\"leads\":[{\"id\":\"L1\",\"chat\":\"group\",\"chatName\":\"%s\"}]}", name);
    free(name);
    CHECK(nev == 1 && strlen(rec_card.leads[0].chat_name) == 48);

    reset();   // bad_chat_types_keep_frame
    feed("{\"t\":\"supertab\",\"id\":\"S1\",\"leads\":[{\"id\":\"L1\",\"chat\":7,\"chatId\":9,\"chatName\":[]},"
         "{\"id\":\"L2\",\"chat\":\"group\",\"chatId\":\"0123456789012345678901234567890123456789012345678\"}]}");
    CHECK(nev == 1 && rec_card.lead_n == 2 && !strcmp(rec_card.leads[0].id, "L1"));
    CHECK(rec_card.leads[0].chat == POD_CHAT_NONE && rec_card.leads[0].chat_id[0] == 0 && rec_card.leads[0].chat_name[0] == 0);
    CHECK(rec_card.leads[1].chat == POD_CHAT_GROUP && rec_card.leads[1].chat_id[0] == 0);   // an id that does not fit is empty, whole or none

    reset();   // supertab_recap_reads_chat_id
    feed("{\"t\":\"supertab.recap\",\"tab\":\"S1\",\"lead\":\"L1\",\"chatId\":\"g1\",\"text\":\"hi\",\"at\":5}");
    CHECK(nev == 1 && evs[0].kind == EV_STRECAP && !strcmp(evs[0].d, "g1") && !strcmp(evs[0].b, "hi"));
    reset();
    feed("{\"t\":\"supertab.recap\",\"tab\":\"S1\",\"lead\":\"L1\",\"text\":\"hi\",\"at\":5}");
    CHECK(nev == 1 && evs[0].d[0] == 0);
}

// The Swarm cards (the hello's swarmCard:v1 is checked in test_pro_hello.py): supertabs {ids} + one supertab per Swarm +
// supertab.recap / supertab.focus in, pro_app_supertab* out.
static void test_swarm_cards(void)
{
    welcome();
    // the id list: order kept, a bad / repeated id skipped, 20 -> 16
    reset();
    feed("{\"t\":\"supertabs\",\"ids\":[\"S1\",\"S2\",7,\"\",\"S1\",\"S3\"]}");
    CHECK(nev == 1 && evs[0].kind == EV_STIDS && evs[0].n1 == 3 && !strcmp(rec_ids[0], "S1") && !strcmp(rec_ids[2], "S3"));
    reset();
    char big[4096];
    int w = snprintf(big, sizeof big, "{\"t\":\"supertabs\",\"ids\":[");
    for (int i = 0; i < 20; i++) w += snprintf(big + w, sizeof big - (size_t)w, "%s\"s%d\"", i ? "," : "", i);
    snprintf(big + w, sizeof big - (size_t)w, "]}");
    feed(big);
    CHECK(nev == 1 && evs[0].n1 == SWARMS_CARD_MAX && !strcmp(rec_ids[SWARMS_CARD_MAX - 1], "s15"));
    reset();   // not an array: dropped
    feed("{\"t\":\"supertabs\",\"ids\":{}}");
    CHECK(nev == 0);

    // one Swarm with 3 Leads: every field
    reset();
    feed("{\"t\":\"supertab\",\"id\":\"S1\",\"tab\":\"T1\",\"name\":\"openharness\",\"count\":4,\"leads\":["
         "{\"id\":\"L1\",\"projectId\":\"P1\",\"project\":\"mobile\",\"engine\":\"claude\",\"owner\":\"\",\"local\":\"H1\",\"state\":\"ask\",\"since\":134},"
         "{\"id\":\"L2\",\"project\":\"web\",\"engine\":\"codex\",\"owner\":\"Mai\",\"local\":\"\",\"state\":\"stuck\",\"since\":0},"
         "{\"id\":\"L3\",\"project\":\"api\",\"engine\":\"gemini\",\"owner\":\"\",\"local\":\"H3\",\"state\":\"work\",\"since\":9}]}");
    CHECK(nev == 1 && evs[0].kind == EV_SUPERTAB && !strcmp(evs[0].id, "S1") && evs[0].n1 == 3);
    CHECK(!strcmp(rec_card.tab, "T1") && !strcmp(rec_card.name, "openharness") && rec_card.count == 4 && rec_card.lead_n == 3);
    CHECK(!strcmp(rec_card.leads[0].id, "L1") && !strcmp(rec_card.leads[0].projectId, "P1") && !strcmp(rec_card.leads[0].project, "mobile") &&
          !strcmp(rec_card.leads[0].engine, "claude") && !strcmp(rec_card.leads[0].local, "H1") &&
          rec_card.leads[0].state == POD_LEAD_ASK && rec_card.leads[0].since_s == 134 &&
          rec_card.leads[0].recap == POD_RECAP_NONE && rec_card.leads[0].text == NULL);
    CHECK(rec_card.leads[1].state == POD_LEAD_STUCK && !strcmp(rec_card.leads[1].owner, "Mai") && rec_card.leads[1].projectId[0] == 0 &&
          rec_card.leads[2].state == POD_LEAD_WORK && rec_card.leads[2].since_s == 9);

    // `order` (the project's index in the Swarm, the app's order) puts the Leads in that order whatever their urgency; without it they stay as they came
    static const char *plain_leads = "{\"id\":\"L1\",\"projectId\":\"P1\",\"project\":\"mobile\",\"engine\":\"claude\",\"owner\":\"\",\"local\":\"H1\",\"state\":\"ask\",\"since\":134},"
                                     "{\"id\":\"L2\",\"project\":\"web\",\"engine\":\"codex\",\"owner\":\"Mai\",\"local\":\"\",\"state\":\"done\"}";
    static const char *order_leads = "{\"id\":\"L1\",\"projectId\":\"P1\",\"project\":\"mobile\",\"engine\":\"claude\",\"owner\":\"\",\"local\":\"H1\",\"state\":\"ask\",\"order\":2,\"since\":134},"
                                     "{\"order\":0,\"id\":\"L2\",\"project\":\"web\",\"engine\":\"codex\",\"owner\":\"Mai\",\"local\":\"\",\"state\":\"done\"},"
                                     "{\"id\":\"L3\",\"project\":\"api\",\"engine\":\"codex\",\"state\":\"work\",\"order\":1}";
    reset();
    feedf("{\"t\":\"supertab\",\"id\":\"S1\",\"tab\":\"T1\",\"name\":\"openharness\",\"count\":2,\"leads\":[%s]}", plain_leads);
    CHECK(nev == 1 && rec_card.lead_n == 2 && !strcmp(rec_card.leads[0].id, "L1") && !strcmp(rec_card.leads[1].id, "L2"));
    pod_swarm_t plain = rec_card;
    reset();
    feedf("{\"t\":\"supertab\",\"id\":\"S1\",\"tab\":\"T1\",\"name\":\"openharness\",\"count\":3,\"leads\":[%s]}", order_leads);
    CHECK(nev == 1 && evs[0].kind == EV_SUPERTAB && rec_card.lead_n == 3);
    CHECK(!strcmp(rec_card.leads[0].id, "L2") && !strcmp(rec_card.leads[1].id, "L3") && !strcmp(rec_card.leads[2].id, "L1"));
    for (int i = 0; i < 2; i++) {   // each Lead moved whole
        const pod_lead_t *a = &plain.leads[i], *b = &rec_card.leads[i ? 0 : 2];
        CHECK(!strcmp(a->id, b->id) && !strcmp(a->projectId, b->projectId) && !strcmp(a->project, b->project) && !strcmp(a->engine, b->engine) &&
              !strcmp(a->owner, b->owner) && !strcmp(a->local, b->local) && a->state == b->state && a->since_s == b->since_s &&
              a->recap == b->recap && a->text == b->text && a->text_at == b->text_at);
    }
    reset();   // equal orders keep their arrival order
    feed("{\"t\":\"supertab\",\"id\":\"S1\",\"leads\":[{\"id\":\"a\",\"order\":1},{\"id\":\"b\",\"order\":0},{\"id\":\"c\",\"order\":1}]}");
    CHECK(rec_card.lead_n == 3 && !strcmp(rec_card.leads[0].id, "b") && !strcmp(rec_card.leads[1].id, "a") && !strcmp(rec_card.leads[2].id, "c"));

    // 15 Leads -> 12; count absent -> the Leads listed
    reset();
    w = snprintf(big, sizeof big, "{\"t\":\"supertab\",\"id\":\"s\",\"name\":\"n\",\"count\":15,\"leads\":[");
    for (int i = 0; i < 15; i++) w += snprintf(big + w, sizeof big - (size_t)w, "%s{\"id\":\"l%d\",\"state\":\"work\"}", i ? "," : "", i);
    snprintf(big + w, sizeof big - (size_t)w, "]}");
    feed(big);
    CHECK(nev == 1 && rec_card.lead_n == SWARM_LEADS_MAX && !strcmp(rec_card.leads[11].id, "l11") && rec_card.count == 15);
    reset();
    feed("{\"t\":\"supertab\",\"id\":\"s\",\"leads\":[{\"id\":\"a\"},{\"id\":\"b\"}]}");
    CHECK(nev == 1 && rec_card.count == 2);

    // a 60-byte name is cut to 48 on a UTF-8 boundary (the two-byte letter straddles byte 48)
    reset();
    feedf("{\"t\":\"supertab\",\"id\":\"s\",\"name\":\"%s\xc3\xa9%s\",\"leads\":[{\"id\":\"l\",\"project\":\"%s\xc3\xa9%s\"}]}",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbb");
    CHECK(nev == 1 && strlen(rec_card.name) == 47 && strlen(rec_card.leads[0].project) == 47);

    // unknown state -> done; a malformed or repeated Lead is skipped, not the frame; a Swarm without an id is dropped
    reset();
    feed("{\"t\":\"supertab\",\"id\":\"s\",\"name\":\"ok\",\"leads\":[{\"id\":\"a\",\"state\":\"weird\"},"
         "5,{\"project\":\"no id\"},{\"id\":\"b\",\"state\":\"ask\"},{\"id\":\"b\"}]}");
    CHECK(nev == 1 && rec_card.lead_n == 2 && rec_card.leads[0].state == POD_LEAD_DONE &&
          !strcmp(rec_card.leads[1].id, "b") && rec_card.leads[1].state == POD_LEAD_ASK);
    reset();
    feed("{\"t\":\"supertab\",\"name\":\"no id\",\"leads\":[]}");
    CHECK(nev == 0);

    // worst case: 16 Swarms x 12 Leads with every field full is 1 + 16 frames, each inside the JSON guard
    reset();
    int frames = 0;
    w = snprintf(big, sizeof big, "{\"t\":\"supertabs\",\"ids\":[");
    for (int i = 0; i < 16; i++) w += snprintf(big + w, sizeof big - (size_t)w, "%s\"%032d\"", i ? "," : "", i);
    snprintf(big + w, sizeof big - (size_t)w, "]}");
    feed(big); frames++;
    for (int i = 0; i < 16; i++) {
        w = snprintf(big, sizeof big, "{\"t\":\"supertab\",\"id\":\"%032d\",\"tab\":\"%032d\",\"name\":\"%048d\",\"count\":12,\"leads\":[", i, i, i);
        for (int j = 0; j < 12; j++)
            w += snprintf(big + w, sizeof big - (size_t)w,
                          "%s{\"id\":\"%032d\",\"projectId\":\"%032d\",\"project\":\"project-%d\",\"engine\":\"claude\",\"owner\":\"\",\"local\":\"%032d\",\"state\":\"work\",\"since\":134}",
                          j ? "," : "", j, j, j, j);
        snprintf(big + w, sizeof big - (size_t)w, "]}");
        CHECK(strlen(big) < CABLE_MAX_PAYLOAD);
        feed(big); frames++;
    }
    CHECK(frames == 17 && nev == 17 && evs[0].kind == EV_STIDS && evs[16].kind == EV_SUPERTAB && evs[16].n1 == 12);

    // supertab.recap: text stored (cut at 1500), none:true
    reset();
    char *txt = repeat("\xc3\xa9", 1000);   // 2000 bytes
    feedf("{\"t\":\"supertab.recap\",\"tab\":\"S1\",\"lead\":\"L1\",\"text\":\"%s\",\"at\":1792560000,\"none\":false}", txt);
    free(txt);
    CHECK(nev == 1 && evs[0].kind == EV_STRECAP && !strcmp(evs[0].id, "S1") && !strcmp(evs[0].a, "L1") &&
          strlen(evs[0].b) == 1500 && evs[0].n1 == 1792560000L && evs[0].n2 == 0);
    reset();
    feed("{\"t\":\"supertab.recap\",\"tab\":\"S1\",\"lead\":\"L1\",\"text\":\"\",\"at\":5,\"none\":true}");
    CHECK(nev == 1 && evs[0].n2 == 1 && !strcmp(evs[0].b, ""));
    reset();   // no tab / no lead: dropped
    feed("{\"t\":\"supertab.recap\",\"lead\":\"L1\",\"text\":\"x\"}");
    feed("{\"t\":\"supertab.recap\",\"tab\":\"S1\",\"text\":\"x\"}");
    CHECK(nev == 0);

    // supertab.focus
    reset();
    feed("{\"t\":\"supertab.focus\",\"tab\":\"S1\",\"lead\":\"L2\"}");
    CHECK(nev == 1 && evs[0].kind == EV_STFOCUS && !strcmp(evs[0].id, "S1") && !strcmp(evs[0].a, "L2"));
    // an empty or missing lead: open that Swarm on the Lead last shown (the app decides); an empty tab is still nothing
    reset();
    feed("{\"t\":\"supertab.focus\",\"tab\":\"S1\",\"lead\":\"\"}");   // focus_empty_lead_reaches_app
    CHECK(nev == 1 && evs[0].kind == EV_STFOCUS && !strcmp(evs[0].id, "S1") && !strcmp(evs[0].a, ""));
    reset();
    feed("{\"t\":\"supertab.focus\",\"tab\":\"S1\"}");
    CHECK(nev == 1 && evs[0].kind == EV_STFOCUS && !strcmp(evs[0].id, "S1") && !strcmp(evs[0].a, ""));
    reset();
    feed("{\"t\":\"supertab.focus\",\"tab\":\"\",\"lead\":\"L2\"}");
    feed("{\"t\":\"supertab.focus\",\"lead\":\"\"}");
    CHECK(nev == 0);

    // the send helper
    reset();
    CHECK(pro_cable_supertab_send("supertab.recap.get", "S1", "L1"));
    CHECK(pro_cable_supertab_send("supertab.open", "S1", NULL));
    CHECK(!pro_cable_supertab_send("bogus", "S1", "L1"));   // not one of the three: nothing goes out
    CHECK(nsent == 2 && strstr(sent[0], "\"t\":\"supertab.recap.get\"") && strstr(sent[0], "\"tab\":\"S1\"") && strstr(sent[0], "\"lead\":\"L1\""));
    CHECK(strstr(sent[1], "\"t\":\"supertab.open\"") && strstr(sent[1], "\"lead\":\"\""));
}

// Ticks every 5 s for `s` seconds, answering each with a ping when `pings` (a Pro that hears the daemon but cannot greet it).
static void alone_for(int s, bool pings)
{
    for (int t = 0; t < s; t += 5) {
        now_us += 5 * 1000000;
        if (pings) feed("{\"t\":\"ping\"}");
        pro_cable_tick(NULL);
    }
}

// The self re-plug: after a cold start beside a booting Mac the Pro's link stayed dead until a hand replugged it. With a host
// driving the port and no session for 30 s, the Pro drops off the bus so the Mac enumerates it afresh; the waits double to
// 10 min so a Mac with no daemon sees it rarely; never during a session, an update or an open recording.
static void self_replug(void)
{
    if (pro_cable_connected()) end_session();
    replugs = 0; offer_active = false; voice_is_open = false;
    pro_cable_tick(NULL);                 // no host yet: nothing counts
    host_present = true;
    alone_for(25, true);
    now_us += 4 * 1000000; pro_cable_tick(NULL);
    CHECK(replugs == 0);                  // 29 s with pings but no welcome: not yet
    now_us += 1 * 1000000; pro_cable_tick(NULL);
    CHECK(replugs == 1);                  // 30 s
    // Backoff: 60, 120, 240, 480, then 600 s each.
    const int waits[] = { 60, 120, 240, 480, 600, 600 };
    for (int i = 0; i < 6; i++) {
        alone_for(waits[i] - 5, false);
        CHECK(replugs == 1 + i);
        alone_for(5, false);
        CHECK(replugs == 2 + i);
    }
    // No host: an hour unplugged (or the Mac off) never counts, and does not reset the wait (the re-plug itself makes the
    // host vanish for a moment, so a reset there would loop at 30 s).
    host_present = false;
    alone_for(3600, false);
    CHECK(replugs == 7);
    host_present = true;
    alone_for(595, false);
    CHECK(replugs == 7);
    alone_for(5, false);
    CHECK(replugs == 8);
    // A session: never during it, and it resets the wait to 30 s after it ends.
    welcome();
    for (int t = 0; t < 900; t += 10) { now_us += 10 * 1000000; feed("{\"t\":\"ping\"}"); pro_cable_tick(NULL); }
    CHECK(replugs == 8 && pro_cable_connected());
    now_us += 10 * 1000000; pro_cable_tick(NULL);   // the last tick of the session: 10 s since the ping
    end_session();                                   // 26 s: silence ends it
    alone_for(25, false);
    CHECK(replugs == 8);
    alone_for(5, false);
    CHECK(replugs == 9);                  // 30 s after the session's last tick
    // An update or a recording in flight: never, and the clock restarts when it ends.
    offer_active = true;
    alone_for(120, false);
    CHECK(replugs == 9);
    offer_active = false;
    voice_is_open = true;
    alone_for(120, false);
    CHECK(replugs == 9);
    voice_is_open = false;
    alone_for(55, false);
    CHECK(replugs == 9);                  // the wait is 60 s now, counted from the end of the recording
    alone_for(5, false);
    CHECK(replugs == 10);
    host_present = false;
}

// A welcome is longer than one read (295 B with the features, the reader hands over 256 B at a time), so its first read can
// land at the 30 s deadline with the rest still due. That is a link coming up: the re-plug waits for the frame. A partial
// that never completes is dropped by the reader after 300 ms, and the re-plug goes ahead on the next tick.
static void replug_spares_a_frame_in_flight(void)
{
    if (pro_cable_connected()) end_session();
    welcome(); end_session();             // a session resets the wait to 30 s from its last tick
    replugs = 0; host_present = true;
    alone_for(25, false);
    now_us += 5 * 1000000;
    rx_pending = true;                    // 256 B of the welcome are in
    pro_cable_tick(NULL);
    CHECK(replugs == 0);
    rx_pending = false;                   // the rest: the session comes up
    now_us += 10 * 1000;
    welcome();
    pro_cable_tick(NULL);
    CHECK(replugs == 0 && pro_cable_connected());
    // The stale partial: the tail never comes.
    end_session();
    alone_for(25, false);
    now_us += 5 * 1000000;
    rx_pending = true;
    pro_cable_tick(NULL);
    CHECK(replugs == 0);
    now_us += 300 * 1000;
    rx_pending = false;                   // the reader dropped it
    pro_cable_tick(NULL);
    CHECK(replugs == 1 && !pro_cable_connected());
    host_present = false;
}

int main(void)
{
    pro_cable_start();   // the lock and the machine table; no tasks run on the host
    pro_cable_test_no_session();
    pro_cable_test_turn_activity();
    pro_cable_test_old_daemon();
    pro_cable_test_oversize();
    pro_cable_test_ignores_round();
    test_session_machines_library_voice();
    pro_cable_test_small_stack();
    test_settings();
    test_turn_stats();
    test_ui_skin_ignored();
    test_notifications();
    fw_offer_routes();
    fw_frame_routes();
    fw_keeps_the_session_alive();
    fw_offer_gate();
    fw_confirms_on_welcome();
    session_down_aborts_then_new_offer_ok();
    send_shapes();
    link_resync();
    seq_gaps();
    test_swarm_cards();
    test_swarm_chat();
    self_replug();
    replug_spares_a_frame_in_flight();
    printf("test_pro_cable: %d checks passed\n", checks);
    return 0;
}
