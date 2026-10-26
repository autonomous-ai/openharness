#include "pro_cable.h"

#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "board/board.h"
#include "cJSON.h"
#include "cable_features.h"
#include "cable_frame.h"
#include "cable_json_guard.h"
#include "cable_link.h"
#include "cable_machines.h"
#include "cable_scroll.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "app/pro_voice.h"
#include "pod/pod_mem.h"
#include "pod/pod_model.h"
#include "pro_app_api.h"
#include "sys/config_store.h"
#include "sys/device_mac.h"
#include "sys/fw_update.h"
#include "sys/last_words.h"
#include "esp_task_wdt.h"
#include "task_stacks.h"

static const char *TAG = "pro_cable";

// ── session timing ──────────────────────────────────────────────────────────────────────────────────
// Over a cable the daemon quitting looks exactly like the daemon having nothing to say: both are silence. The daemon
// pings on a fixed cadence while it is alive, and a gap reads as absence. The device greets on a cadence of its own
// (it has no port-open event to wait on): often while alone, slowly as a keepalive once a session is up, which also
// re-introduces it to a daemon that restarted inside the silence window.
#define HELLO_ALONE_MS   2000
#define HELLO_SESSION_MS 15000
#define SILENCE_MS       15000
// Self re-plug (replug_tick). After a cold start beside a booting Mac the link could stay dead both ways until a hand
// replugged the Pro; a fresh enumeration is that replug. A daemon greets within a hello or two, so a host driving the port
// with no session for 30 s is stuck or has no daemon; the waits double to 10 min so the second case sees it rarely.
#define REPLUG_ALONE_MS  30000
#define REPLUG_MAX_MS    600000
#define NOTIF_ROWS       16   // notif.replace items kept (the daemon sends at most 8)

// Everything below runs on the cable_link task (12 KB stack) unless the comment says otherwise. Parsing therefore
// goes into static scratch, never into a stack local over 1 KB (the host test caps every frame at 1024 B).
_Static_assert(POD_RECAP_BYTES == PRO_RECAP_BYTES, "the recap buffers of pro_cable and Pod must agree");

static atomic_bool s_session;
static atomic_uint s_features;
static bool        s_started;
// Only the cable_link task touches these after start.
static int64_t     s_last_rx_us;
static uint32_t    s_bad, s_unknown;
static char        s_machine_name[CABLE_NAME_MAX];
static char        s_machine_id[MACHINE_ID_MAX];
static cable_machines_t s_machines;
// The daemon numbers every JSON frame it sends us (`seq`, reset by each welcome); a hole means a frame was lost on the way in.
static int64_t     s_seq_last = -1;   // -1: none seen this session
static uint32_t    s_seq_gaps;
static bool        s_resync_pending;
static unsigned    s_replugs;         // self re-plugs since the last session
static bool        s_seq_on;          // the welcome carried a seq

// The id of the recording in flight: written by the voice task, read by the cable_link task to match a reply.
static SemaphoreHandle_t s_upload_lock;
static char s_upload[24];
// The latest player.library request. Written before the request is sent, so a fast reply cannot beat it.
static atomic_uint s_lib_request;
static atomic_bool s_lib_requested;

// ── text helpers ────────────────────────────────────────────────────────────────────────────────────

// Copy at most cap-1 bytes of src, never splitting a UTF-8 character.
static void copy_cut(char *dst, size_t cap, const char *src)
{
    size_t n = strnlen(src, cap);
    if (n >= cap) {
        n = cap - 1;
        while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80) n--;   // src[n] would start mid-character
    }
    memcpy(dst, src, n);
    dst[n] = 0;
}

static const char *str_of(const cJSON *o, const char *key)
{
    const cJSON *v = o ? cJSON_GetObjectItemCaseSensitive(o, key) : NULL;
    return cJSON_IsString(v) && v->valuestring ? v->valuestring : NULL;
}

// The field cut into `buf`, or NULL when the daemon did not send it.
static const char *cut_of(const cJSON *o, const char *key, char *buf, size_t cap)
{
    const char *s = str_of(o, key);
    if (!s) return NULL;
    copy_cut(buf, cap, s);
    return buf;
}

// ── outbound ────────────────────────────────────────────────────────────────────────────────────────

// Serialise and send. Takes ownership of `root`, so an early return cannot leak a tree.
static bool send_json_with(cJSON *root, bool wait)
{
    if (!root) return false;
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!text) return false;
    const bool ok = wait ? cable_link_send(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text))
                         : cable_link_send_nowait(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text));
    cJSON_free(text);
    return ok;
}
static bool send_json(cJSON *root) { return send_json_with(root, true); }

static cJSON *msg(const char *t)
{
    cJSON *root = cJSON_CreateObject();
    if (root && !cJSON_AddStringToObject(root, "t", t)) {
        cJSON_Delete(root);
        return NULL;
    }
    return root;
}

// One allocation failure invalidates the whole command: a voice.begin that lost its agentId would route differently.
// The failure is sticky: the tree is released and the caller's pointer cleared, so later fields are no-ops and
// send_json(NULL) emits nothing.
static bool msg_check(cJSON **root, bool ok)
{
    if (!ok) { cJSON_Delete(*root); *root = NULL; }
    return ok;
}
static bool msg_string(cJSON **root, const char *key, const char *value)
{
    return *root && msg_check(root, cJSON_AddStringToObject(*root, key, value) != NULL);
}
static bool msg_number(cJSON **root, const char *key, double value)
{
    return *root && msg_check(root, cJSON_AddNumberToObject(*root, key, value) != NULL);
}

const char *pro_cable_fw_version(void)
{
    // Read from the running image, so the daemon's version comparison cannot be lied to.
    return esp_app_get_description()->version;
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────────
// The app's per-device card (Sound, Brightness, Voice language). The wire brightness is a percent, like the round
// dial's; NVS and the panel keep 0..255. The round-only fields are fixed: the app parses the object only when every key
// is present, and a set that names one of them differently is refused.
static int bright_pct(void) { return (config_load_brightness() * 100 + 127) / 255; }

static bool msg_settings(cJSON **root)
{
    if (!*root) return false;
    char lang[CFG_VLANG_MAX];
    config_load_voicelang(lang, sizeof lang);
    cJSON *o = cJSON_CreateObject();
    if (!o || !cJSON_AddItemToObject(*root, "settings", o)) { cJSON_Delete(o); return msg_check(root, false); }
    return msg_check(root, cJSON_AddNumberToObject(o, "brightness", bright_pct()) &&
                           cJSON_AddNumberToObject(o, "character", 0) && cJSON_AddNumberToObject(o, "face", 0) &&
                           cJSON_AddStringToObject(o, "voiceLang", lang) &&
                           cJSON_AddBoolToObject(o, "muted", config_load_muted()) &&
                           cJSON_AddBoolToObject(o, "quiet", false) && cJSON_AddBoolToObject(o, "straightTitle", false) &&
                           cJSON_AddBoolToObject(o, "focusFace", false) && cJSON_AddBoolToObject(o, "scrollReversed", false) &&
                           cJSON_AddBoolToObject(o, "round", false));
}

// Absent means unchanged. The whole set is checked before any of it is applied.
static void handle_settings_set(const cJSON *p)
{
    const char *error = NULL;
    static const char *const flags[] = {"quiet", "straightTitle", "focusFace", "scrollReversed", "round"};
    for (unsigned i = 0; i < sizeof flags / sizeof flags[0]; i++) {
        const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, flags[i]);
        if (cJSON_IsTrue(v)) error = "Not on this device.";
    }
    const char *numbers[] = {"character", "face"};
    for (unsigned i = 0; i < 2; i++) {
        const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, numbers[i]);
        if (cJSON_IsNumber(v) && v->valuedouble != 0) error = "Not on this device.";
    }
    const cJSON *bright = cJSON_GetObjectItemCaseSensitive(p, "brightness");
    const cJSON *muted = cJSON_GetObjectItemCaseSensitive(p, "muted");
    const cJSON *lang = cJSON_GetObjectItemCaseSensitive(p, "voiceLang");
    if (cJSON_IsString(lang) && (!lang->valuestring || !lang->valuestring[0] || strlen(lang->valuestring) >= CFG_VLANG_MAX))
        error = "Language code is not valid.";
    if (!error) {
        if (cJSON_IsNumber(bright)) {
            const double pct = bright->valuedouble < 0 ? 0 : bright->valuedouble > 100 ? 100 : bright->valuedouble;
            const uint8_t level = (uint8_t)((pct * 255 + 50) / 100);
            config_save_brightness(level);
            pro_app_set_brightness(level);
        }
        if (cJSON_IsBool(muted) && !config_save_muted(cJSON_IsTrue(muted))) error = "Could not save.";
        if (cJSON_IsString(lang) && !config_save_voicelang(lang->valuestring)) error = "Could not save.";
    }
    ESP_LOGI(TAG, "settings.set ok=%d muted=%d", error == NULL, (int)config_load_muted());
    cJSON *root = msg("settings.state");
    if (!root) return;
    cJSON_AddBoolToObject(root, "ok", error == NULL);
    if (error) msg_string(&root, "error", error);
    msg_settings(&root);   // the values read back, never the ones asked for
    send_json(root);
}

static void send_hello(void)
{
    cJSON *root = msg("hello");
    if (!root) return;
    msg_string(&root, "fw", pro_cable_fw_version());
    msg_string(&root, "product", CABLE_PRODUCT);
    msg_number(&root, "proto", CABLE_PROTO_VERSION);
    msg_string(&root, "hw", board()->name);
    msg_string(&root, "board", "pro");
    msg_string(&root, "swarms", "members-v1");
    msg_string(&root, "recap", "long-v1");
    msg_string(&root, "activity", "steps-v1");
    msg_string(&root, "stats", "turn-v1");
    msg_string(&root, "player", "library-v1");
    msg_string(&root, "superTab", "wait-v1");   // a question with superTab + attention is shown as a wait (handle_question)
    msg_string(&root, "swarmCard", "v1");       // supertabs / supertab.recap / supertab.focus: the Swarm cards (handle_supertab)
    msg_string(&root, "ota", "v1");
    char mac[24] = "";
    device_mac_str(mac, sizeof(mac));
    msg_string(&root, "mac", mac);
    msg_settings(&root);
    send_json(root);
}

// ── firmware update, the wire half (fw_update.c decides, this sends) ─────────────────────────────────
void fw_update_send_accept(void) { send_json(msg("fw.accept")); }
void fw_update_send_done(void) { send_json(msg("fw.done")); }
void fw_update_send_progress(int written)
{
    cJSON *root = msg("fw.progress");
    msg_number(&root, "written", written);
    send_json(root);
}
void fw_update_send_resend(int written)
{
    cJSON *root = msg("fw.progress");
    msg_number(&root, "written", written);
    if (root && !cJSON_AddTrueToObject(root, "resend")) { cJSON_Delete(root); root = NULL; }
    send_json(root);
}
void fw_update_send_error(const char *message)
{
    uint32_t corrupt = 0, discarded = 0;   // a frame lost on the way in is the usual cause of a stall
    cable_link_counters(&corrupt, &discarded);
    ESP_LOGW(TAG, "fw.error '%s' (corrupt frames %lu, discarded %lu B)", message ? message : "", (unsigned long)corrupt,
             (unsigned long)discarded);
    cJSON *root = msg("fw.error");
    msg_string(&root, "message", message ? message : "");
    send_json(root);
}

bool pro_cable_send_open(const char *agent_id)
{
    if (!agent_id || !agent_id[0]) return false;
    cJSON *root = msg("agent.open");
    msg_string(&root, "agentId", agent_id);
    return send_json(root);
}

bool pro_cable_supertab_send(const char *t, const char *tab, const char *lead)
{
    if (!t || !tab || !tab[0]) return false;
    if (strcmp(t, "supertab.recap.get") && strcmp(t, "supertab.open") && strcmp(t, "supertab.select")) return false;
    cJSON *root = msg(t);
    msg_string(&root, "tab", tab);
    msg_string(&root, "lead", lead ? lead : "");
    return send_json_with(root, false);   // false: dropped on a busy link (the caller retries)
}

bool pro_cable_send_scroll(pro_scroll_phase_t phase, int dy, int velocity)
{
    _Static_assert(PRO_SCROLL_DOWN == 0 && PRO_SCROLL_MOVE == 1 && PRO_SCROLL_UP == 2, "scroll phase wire order");
    char wire[CABLE_SCROLL_JSON_MAX];
    const size_t n = cable_scroll_encode(wire, sizeof wire, (int)phase, dy, velocity);
    return n && cable_link_send_nowait(CABLE_TYPE_JSON, (const uint8_t *)wire, n);   // the render/touch tasks must not wait
}

bool pro_cable_request_library(int offset, uint32_t request)
{
    if (offset < 0 || offset > 1000000) return false;
    atomic_store(&s_lib_request, request);
    atomic_store(&s_lib_requested, true);
    cJSON *root = msg("player.library.get");
    msg_number(&root, "offset", offset);
    msg_number(&root, "request", request);
    return send_json_with(root, false);   // from the render task: a request not sent is asked for again by the sweep
}

static void remember_upload(const char *upload_id)
{
    if (!s_upload_lock) return;
    xSemaphoreTake(s_upload_lock, portMAX_DELAY);
    copy_cut(s_upload, sizeof s_upload, upload_id ? upload_id : "");
    xSemaphoreGive(s_upload_lock);
}

// A reply that names an upload must name the current one. A reply that names none is accepted.
static bool upload_matches(const char *upload_id)
{
    if (!upload_id) return true;
    bool same = false;
    if (s_upload_lock && xSemaphoreTake(s_upload_lock, portMAX_DELAY) == pdTRUE) {
        same = !strcmp(upload_id, s_upload);
        xSemaphoreGive(s_upload_lock);
    }
    return same;
}

bool pro_cable_voice_begin(const char *agent_id, const char *lang, int sample_rate, const char *upload_id)
{
    if (!upload_id || !upload_id[0]) return false;
    remember_upload(upload_id);
    cJSON *root = msg("voice.begin");
    // OMITTED, not empty, without an agent: absence tells the daemon to route the transcript itself.
    if (agent_id && agent_id[0]) msg_string(&root, "agentId", agent_id);
    msg_string(&root, "lang", lang && lang[0] ? lang : "en");
    msg_number(&root, "sr", sample_rate);
    msg_string(&root, "uploadId", upload_id);
    return send_json(root);
}

bool pro_cable_voice_pcm(const uint8_t *pcm, size_t len)
{
    return cable_link_send(CABLE_TYPE_PCM, pcm, len);
}

bool pro_cable_voice_end(const char *upload_id)
{
    cJSON *root = msg("voice.end");
    msg_string(&root, "uploadId", upload_id ? upload_id : "");
    return send_json(root);
}

bool pro_cable_voice_abort(const char *upload_id, const char *why)
{
    cJSON *root = msg("voice.abort");
    if (why && why[0]) msg_string(&root, "why", why);
    msg_string(&root, "uploadId", upload_id ? upload_id : "");
    return send_json(root);
}

bool pro_cable_voice_cancel(const char *upload_id)
{
    if (!upload_id || !upload_id[0]) return false;
    cJSON *root = msg("voice.abort");
    msg_string(&root, "uploadId", upload_id);
    msg_string(&root, "why", "discarded");
    return send_json(root);
}

bool pro_cable_connected(void) { return atomic_load(&s_session); }

bool pro_cable_library_supported(void)
{
    return atomic_load(&s_session) && (atomic_load(&s_features) & CABLE_FEATURE_PLAYER_LIBRARY);
}

void pro_cable_counters(uint32_t *bad, uint32_t *unknown)
{
    if (bad) *bad = s_bad;
    if (unknown) *unknown = s_unknown;
}

uint32_t pro_cable_seq_gaps(void) { return s_seq_gaps; }

// A frame with a `seq` that does not follow the last one means frames in between never arrived (the USB path drops
// whole packets, and a small frame vanishes without a trace). Count it and ask for a snapshot (link_resync).
static void track_seq(const cJSON *root, bool welcome)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(root, "seq");
    const bool ok = cJSON_IsNumber(v) && v->valuedouble >= 0 && v->valuedouble < 4294967296.0;
    if (welcome) s_seq_on = ok;   // a daemon that does not number its frames is not checked at all
    if (!s_seq_on || !ok) return;
    const int64_t seq = (int64_t)v->valuedouble;
    if (!welcome && s_seq_last >= 0 && seq != s_seq_last + 1) { s_seq_gaps++; s_resync_pending = true; }
    s_seq_last = seq;   // a welcome restarts the count
}

// ── the agent list ──────────────────────────────────────────────────────────────────────────────────
// It arrives streamed (begin, one `agent` per agent, end) because a frame is capped and a list is not. The Pro
// holds it in static scratch and hands pro_app the whole roster once, at `agents.end`.

typedef struct {
    char id[ID_MAX], name[CABLE_NAME_MAX], engine[12], machine_id[ID_MAX], machine[CABLE_NAME_MAX];
} agent_store_t;
static EXT_RAM_BSS_ATTR agent_store_t s_agent_store[POD_AGENTS_MAX];
static pro_agent_row_t s_agent_rows[POD_AGENTS_MAX];
static int  s_agent_count;
static bool s_agents_building;

static void handle_agent(const cJSON *p)
{
    const char *id = str_of(p, "id");
    // Ids are opaque routing targets: a cut or duplicated one would make a name point at another pane.
    if (!s_agents_building || !id || !id[0] || strlen(id) >= ID_MAX || s_agent_count >= POD_AGENTS_MAX) return;
    for (int i = 0; i < s_agent_count; i++)
        if (!strcmp(s_agent_store[i].id, id)) return;
    agent_store_t *a = &s_agent_store[s_agent_count];
    memset(a, 0, sizeof *a);
    snprintf(a->id, sizeof a->id, "%s", id);
    const char *name = str_of(p, "name");
    copy_cut(a->name, sizeof a->name, name && name[0] ? name : id);
    const char *engine = str_of(p, "engine");
    if (engine) copy_cut(a->engine, sizeof a->engine, engine);
    const char *machine_id = str_of(p, "machineId");
    if (machine_id && strlen(machine_id) < sizeof a->machine_id) snprintf(a->machine_id, sizeof a->machine_id, "%s", machine_id);
    const char *machine = str_of(p, "machine");
    if (machine) copy_cut(a->machine, sizeof a->machine, machine);
    s_agent_count++;
}

static void handle_agents_end(void)
{
    if (!s_agents_building) return;
    s_agents_building = false;
    for (int i = 0; i < s_agent_count; i++) {
        const agent_store_t *a = &s_agent_store[i];
        s_agent_rows[i] = (pro_agent_row_t){ a->id, a->name, a->engine, a->machine_id, a->machine };
    }
    ESP_LOGI(TAG, "agents: %d", s_agent_count);
    pro_app_agents(s_agent_rows, s_agent_count);
}

// ── tabs ────────────────────────────────────────────────────────────────────────────────────────────

// 24 x 24 x 48 B = 27 KB: PSRAM, not internal RAM.
static EXT_RAM_BSS_ATTR cable_swarm_members_t s_swarm_members;
static cable_swarm_t s_swarm_rows[SWARMS_MAX];
static cable_tile_t  s_tiles[SWARM_TILES_MAX];

static void read_members(const cJSON *it, int n)
{
    // Optional (an older daemon omits it). Row n keeps its ids in slot n; a bad entry is skipped, not fatal.
    const cJSON *ids_raw = cJSON_GetObjectItemCaseSensitive(it, "agentIds");
    const cJSON *ids = cJSON_IsArray(ids_raw) ? ids_raw : NULL;
    const cJSON *aid = NULL;
    cJSON_ArrayForEach(aid, ids) {
        if (s_swarm_members.count[n] >= SWARM_MEMBERS_MAX) break;
        if (!cJSON_IsString(aid) || !aid->valuestring[0] || strlen(aid->valuestring) >= ID_MAX) continue;
        snprintf(s_swarm_members.id[n][s_swarm_members.count[n]++], ID_MAX, "%s", aid->valuestring);
    }
    // `members` says who each id is, for the ones nobody else lists (an offline machine's agent). Matched to the ids
    // above by id; an entry whose id is not among them, or that is malformed, is skipped.
    const cJSON *mem = NULL, *raw = cJSON_GetObjectItemCaseSensitive(it, "members");
    const cJSON *mem_list = cJSON_IsArray(raw) ? raw : NULL;
    cJSON_ArrayForEach(mem, mem_list) {
        const char *mid = str_of(mem, "id");
        if (!mid) continue;
        for (int k = 0; k < s_swarm_members.count[n]; k++) {
            if (strcmp(s_swarm_members.id[n][k], mid)) continue;
            cable_swarm_member_meta_t *mm = &s_swarm_members.meta[n][k];
            const char *nm = str_of(mem, "name"), *en = str_of(mem, "engine"), *ma = str_of(mem, "machine");
            const cJSON *on = cJSON_GetObjectItemCaseSensitive(mem, "online");
            copy_cut(mm->name, sizeof mm->name, nm ? nm : "");
            copy_cut(mm->engine, sizeof mm->engine, en ? en : "");
            copy_cut(mm->machine, sizeof mm->machine, ma ? ma : "");
            mm->online = !cJSON_IsBool(on) || cJSON_IsTrue(on);
            mm->has = true;
            break;
        }
    }
}

static int read_tiles(const cJSON *p)
{
    int tn = 0;
    const cJSON *ti = NULL;
    cJSON_ArrayForEach(ti, cJSON_GetObjectItemCaseSensitive(p, "tiles")) {
        if (tn >= SWARM_TILES_MAX) break;
        const cJSON *c[4] = { cJSON_GetObjectItemCaseSensitive(ti, "x1"), cJSON_GetObjectItemCaseSensitive(ti, "y1"),
                              cJSON_GetObjectItemCaseSensitive(ti, "x2"), cJSON_GetObjectItemCaseSensitive(ti, "y2") };
        bool ok = true;
        for (int i = 0; i < 4; i++)   // reject out-of-range, NaN and infinite coordinates before converting
            ok = ok && cJSON_IsNumber(c[i]) && c[i]->valuedouble >= 0 && c[i]->valuedouble <= 1000;
        if (!ok) continue;
        cable_tile_t *t = &s_tiles[tn];
        t->x1 = (int16_t)c[0]->valuedouble; t->y1 = (int16_t)c[1]->valuedouble;
        t->x2 = (int16_t)c[2]->valuedouble; t->y2 = (int16_t)c[3]->valuedouble;
        // The daemon already refuses an empty rectangle, so one here is a wire fault: drop it.
        if (t->x2 <= t->x1 || t->y2 <= t->y1) continue;
        const cJSON *a = cJSON_GetObjectItemCaseSensitive(ti, "a");
        copy_cut(t->agent_id, sizeof t->agent_id, cJSON_IsString(a) ? a->valuestring : "");
        tn++;
    }
    return tn;
}

// `swarms`: the whole list, replaced on arrival. Rows without an id are dropped; a name is optional. Rows past
// SWARMS_MAX are ignored (the loop ends there, it does not spin on the rest).
static void handle_swarms(const cJSON *p)
{
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p, "items");
    if (!cJSON_IsArray(items)) return;
    memset(s_swarm_members.count, 0, sizeof s_swarm_members.count);
    memset(s_swarm_members.meta, 0, sizeof s_swarm_members.meta);
    bool has_ids = false;
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
        if (n >= SWARMS_MAX) break;
        const char *id = str_of(it, "id");
        if (!id || !id[0] || strlen(id) >= sizeof s_swarm_rows[n].id) continue;
        bool duplicate = false;
        for (int i = 0; i < n; i++) if (!strcmp(s_swarm_rows[i].id, id)) duplicate = true;
        if (duplicate) continue;
        cable_swarm_t *row = &s_swarm_rows[n];
        memset(row, 0, sizeof *row);
        snprintf(row->id, sizeof row->id, "%s", id);
        const char *name = str_of(it, "name");
        copy_cut(row->name, sizeof row->name, name ? name : "");
        const cJSON *agents = cJSON_GetObjectItemCaseSensitive(it, "agents");
        row->agents = cJSON_IsNumber(agents) && agents->valueint > 0 ? agents->valueint : 0;
        // Absent from an older daemon: the agent count, which is what this row meant before tiles were counted.
        const cJSON *panes = cJSON_GetObjectItemCaseSensitive(it, "panes");
        row->panes = cJSON_IsNumber(panes) ? (panes->valueint > 0 ? panes->valueint : 0) : row->agents;
        has_ids = has_ids || cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(it, "agentIds"));
        read_members(it, n);
        n++;
    }
    const char *selected = str_of(p, "selected");
    if (selected && strlen(selected) >= ID_MAX) selected = NULL;
    // The selected tab's grid rides the same frame so the rows and the rectangles can never be read half updated.
    const int tn = read_tiles(p);
    ESP_LOGI(TAG, "swarms: %d (%d tiles)%s", n, tn, has_ids ? " with ids" : "");
    pro_app_swarms(s_swarm_rows, n, has_ids ? &s_swarm_members : NULL, selected, s_tiles, tn);
}

// ── the Swarm cards ─────────────────────────────────────────────────────────────────────────────────
// Two frames, so each stays under the JSON guard's token budget: `supertabs` {ids} is the set and order, `supertab` one Swarm with its
// Leads (about 200 tokens at 12). A Swarm or Lead that is not an object, has no usable id, or repeats an id is skipped (the
// frame survives); an unknown `state` reads as done. Parsed into PSRAM staging: the model copies it and keeps the cached recap
// texts, so the Lead `text` pointers stay NULL here.

static EXT_RAM_BSS_ATTR pod_swarm_t s_card;
static char s_card_ids[SWARMS_CARD_MAX][ID_MAX];
static char s_card_text[SWARM_TEXT_MAX];

static bool id_fits(const char *s) { return s && s[0] && strlen(s) < ID_MAX; }

static pod_lead_state_t lead_state(const char *s)
{
    if (s && !strcmp(s, "ask")) return POD_LEAD_ASK;
    if (s && !strcmp(s, "stuck")) return POD_LEAD_STUCK;
    if (s && !strcmp(s, "work")) return POD_LEAD_WORK;
    return POD_LEAD_DONE;
}

// The Leads in the Swarm's order (each Lead's `order`, the project's index in the app), whatever their urgency; a Lead without one keeps its place as it came.
static void read_leads(const cJSON *it, pod_swarm_t *sw)
{
    double order[SWARM_LEADS_MAX];
    const cJSON *l = NULL;
    cJSON_ArrayForEach(l, cJSON_GetObjectItemCaseSensitive(it, "leads")) {
        if (sw->lead_n >= SWARM_LEADS_MAX) break;
        const char *id = str_of(l, "id");
        if (!id_fits(id)) continue;
        bool duplicate = false;
        for (int i = 0; i < sw->lead_n; i++) if (!strcmp(sw->leads[i].id, id)) duplicate = true;
        if (duplicate) continue;
        const cJSON *o = cJSON_GetObjectItemCaseSensitive(l, "order");
        const double key = cJSON_IsNumber(o) ? o->valuedouble : sw->lead_n;
        int at = sw->lead_n;
        while (at > 0 && order[at - 1] > key) at--;   // after every equal one: ties keep their arrival order
        memmove(&sw->leads[at + 1], &sw->leads[at], (size_t)(sw->lead_n - at) * sizeof sw->leads[0]);
        memmove(&order[at + 1], &order[at], (size_t)(sw->lead_n - at) * sizeof order[0]);
        order[at] = key;
        sw->lead_n++;
        pod_lead_t *ld = &sw->leads[at];
        memset(ld, 0, sizeof *ld);
        snprintf(ld->id, sizeof ld->id, "%s", id);
        const char *pid = str_of(l, "projectId");
        if (pid && strlen(pid) < sizeof ld->projectId) snprintf(ld->projectId, sizeof ld->projectId, "%s", pid);   // whole or none
        cut_of(l, "project", ld->project, sizeof ld->project);
        cut_of(l, "engine", ld->engine, sizeof ld->engine);
        cut_of(l, "owner", ld->owner, sizeof ld->owner);
        const char *local = str_of(l, "local");
        if (local && strlen(local) < sizeof ld->local) snprintf(ld->local, sizeof ld->local, "%s", local);   // a harness id: whole or none
        ld->state = lead_state(str_of(l, "state"));
        const cJSON *since = cJSON_GetObjectItemCaseSensitive(l, "since");
        if (cJSON_IsNumber(since) && since->valuedouble > 0) ld->since_s = since->valuedouble > 2592000 ? 2592000u : (uint32_t)since->valuedouble;
        ld->recap = POD_RECAP_NONE;
    }
}

static void handle_supertabs(const cJSON *p)
{
    const cJSON *ids = cJSON_GetObjectItemCaseSensitive(p, "ids");
    if (!cJSON_IsArray(ids)) return;
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, ids) {
        if (n >= SWARMS_CARD_MAX) break;
        if (!cJSON_IsString(it) || !id_fits(it->valuestring)) continue;
        bool duplicate = false;
        for (int i = 0; i < n; i++) if (!strcmp(s_card_ids[i], it->valuestring)) duplicate = true;
        if (duplicate) continue;
        snprintf(s_card_ids[n++], ID_MAX, "%s", it->valuestring);
    }
    ESP_LOGI(TAG, "supertabs: %d", n);
    pro_app_supertab_ids(s_card_ids, n);
}

static void handle_supertab(const cJSON *p)
{
    const char *id = str_of(p, "id");
    if (!id_fits(id)) return;
    pod_swarm_t *sw = &s_card;
    memset(sw, 0, sizeof *sw);
    snprintf(sw->id, sizeof sw->id, "%s", id);
    const char *tab = str_of(p, "tab");
    if (tab && strlen(tab) < sizeof sw->tab) snprintf(sw->tab, sizeof sw->tab, "%s", tab);
    cut_of(p, "name", sw->name, sizeof sw->name);
    read_leads(p, sw);
    const cJSON *count = cJSON_GetObjectItemCaseSensitive(p, "count");   // absent: the Leads listed
    sw->count = cJSON_IsNumber(count) ? (count->valuedouble > 0 ? (count->valuedouble > 65535 ? 65535 : (uint16_t)count->valuedouble) : 0)
                                      : sw->lead_n;
    pro_app_supertab(sw);
}

// `supertab.recap`: one Lead's last message, cut to 1,500 bytes on a UTF-8 boundary. `none` (or no text) is "No message yet".
static void handle_supertab_recap(const cJSON *p)
{
    char tab[ID_MAX], lead[ID_MAX];
    const char *t = str_of(p, "tab"), *l = str_of(p, "lead");
    if (!id_fits(t) || !id_fits(l)) return;
    snprintf(tab, sizeof tab, "%s", t);
    snprintf(lead, sizeof lead, "%s", l);
    const cJSON *none = cJSON_GetObjectItemCaseSensitive(p, "none"), *at = cJSON_GetObjectItemCaseSensitive(p, "at");
    const char *text = cut_of(p, "text", s_card_text, sizeof s_card_text);
    if (!text) s_card_text[0] = 0;
    const bool empty = cJSON_IsTrue(none);
    if (empty) s_card_text[0] = 0;
    const double secs = cJSON_IsNumber(at) && at->valuedouble > 0 ? at->valuedouble : 0;
    pro_app_supertab_recap(tab, lead, s_card_text, secs > 4294967295.0 ? 0xFFFFFFFFu : (uint32_t)secs, empty);
}

static void handle_supertab_focus(const cJSON *p)
{
    char tab[ID_MAX], lead[ID_MAX];
    const char *t = str_of(p, "tab"), *l = str_of(p, "lead");
    if (!id_fits(t) || !id_fits(l)) return;
    snprintf(tab, sizeof tab, "%s", t);
    snprintf(lead, sizeof lead, "%s", l);
    pro_app_supertab_focus(tab, lead);
}

// ── the machine list ────────────────────────────────────────────────────────────────────────────────
// Streamed like the agents. cable_machines_end() answers "did anything change" before pro_app is touched, so the
// daemon re-sending an identical list (its own diff key resets on every port reopen) costs one comparison.

static void stage_machine(const cJSON *p)
{
    const cJSON *local = cJSON_GetObjectItemCaseSensitive(p, "local");
    if (!cable_machines_add(&s_machines, str_of(p, "id"), str_of(p, "name"), str_of(p, "state"), cJSON_IsTrue(local)))
        ESP_LOGW(TAG, "machine row dropped");   // the two halves disagree about the caps
}

static void handle_machines_end(const cJSON *p)
{
    const char *selected = str_of(p, "selected");
    if (!cable_machines_end(&s_machines, selected)) return;
    pro_app_machines(s_machines.rows, s_machines.count, s_machines.applied_selected);
}

static void handle_machine_updated(const cJSON *p)
{
    const cJSON *local = cJSON_GetObjectItemCaseSensitive(p, "local");
    if (!cable_machines_update(&s_machines, str_of(p, "id"), str_of(p, "name"), str_of(p, "state"), cJSON_IsTrue(local)))
        return;
    pro_app_machines(s_machines.rows, s_machines.count, s_machines.applied_selected);
}

// ── turns, recaps, questions ────────────────────────────────────────────────────────────────────────

static char s_verb[PRO_VERB_BYTES], s_action[PRO_ACTION_BYTES], s_step[PRO_STEP_BYTES];
static EXT_RAM_BSS_ATTR char s_text[PRO_RECAP_BYTES], s_recap[PRO_RECAP_BYTES], s_full[PRO_RECAP_BYTES];

// elapsedSeconds is an integer 0..2592000; anything else (absent, fractional, negative, NaN) is -1: keep the model's.
static int elapsed_of(const cJSON *p)
{
    const cJSON *e = cJSON_GetObjectItemCaseSensitive(p, "elapsedSeconds");
    if (!cJSON_IsNumber(e) || !(e->valuedouble >= 0 && e->valuedouble <= 2592000)) return -1;
    const int seconds = (int)e->valuedouble;
    return (double)seconds == e->valuedouble ? seconds : -1;
}

static void handle_turn_activity(const char *id, const cJSON *p)
{
    // In this order: the spinner word, the progress sentence (with the clock), then the tool card.
    const char *verb = cut_of(p, "text", s_verb, sizeof s_verb);
    if (verb && verb[0]) pro_app_turn(id, "verb", verb, -1);
    const char *action = cut_of(p, "action", s_action, sizeof s_action);
    const int elapsed = elapsed_of(p);
    if (action || elapsed >= 0) pro_app_turn(id, "activity", action ? action : "", elapsed);
    const char *step = cut_of(p, "step", s_step, sizeof s_step);
    if (step && step[0]) pro_app_turn(id, "step", step, -1);
}

// One optional count: absent is -1 (unknown); present must be a whole number 0..max, else the message is refused.
static bool stat_of(const cJSON *p, const char *key, int max, int *out)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, key);
    *out = -1;
    if (!v) return true;
    if (!cJSON_IsNumber(v) || !(v->valuedouble >= 0 && v->valuedouble <= max) ||
        v->valuedouble != (double)(int)v->valuedouble) return false;
    *out = (int)v->valuedouble;
    return true;
}

static void handle_turn_stats(const char *id, const cJSON *p)
{
    int passed, failed, commits, tin, tout;
    if (!stat_of(p, "testsPassed", 1000000, &passed) || !stat_of(p, "testsFailed", 1000000, &failed) ||
        !stat_of(p, "commits", 1000000, &commits) || !stat_of(p, "tokensIn", 50000000, &tin) ||
        !stat_of(p, "tokensOut", 50000000, &tout)) {
        s_bad++;
        return;
    }
    pro_app_turn_stats(id, passed, failed, commits, tin, tout);
}

static bool flag(const cJSON *p, const char *key) { return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, key)); }

// The recap is always applied; how loud the end is comes from `tier` (alert / list / silent). restore is history filled back
// in: never news. A summary with no (or an unknown) tier is from an older daemon: quiet ("the desktop already shows this agent")
// and silent (a sub-agent's turn) drop the entry as before, anything else is an alert. Absent flags are false.
static pod_tier_t tier_of(const cJSON *p)
{
    if (flag(p, "restore")) return POD_TIER_SILENT;
    const char *tier = str_of(p, "tier");
    if (tier && !strcmp(tier, "alert")) return POD_TIER_ALERT;
    if (tier && !strcmp(tier, "list")) return POD_TIER_LIST;
    if (tier && !strcmp(tier, "silent")) return POD_TIER_SILENT;
    return flag(p, "quiet") || flag(p, "silent") ? POD_TIER_SILENT : POD_TIER_ALERT;
}

static void handle_summary(const char *id, const cJSON *p)
{
    pro_app_summary(id, cut_of(p, "text", s_text, sizeof s_text), cut_of(p, "recap", s_recap, sizeof s_recap),
                    cut_of(p, "full", s_full, sizeof s_full), flag(p, "restore"), tier_of(p));
}

// The fixed field the daemon sizes a readToken by: [A-Za-z0-9_-]{1,63}. Anything else is not a token.
static bool token_ok(const char *t)
{
    size_t n = t ? strlen(t) : 0;
    if (n < 1 || n > 63) return false;
    for (size_t i = 0; i < n; i++)
        if (!((t[i] >= 'a' && t[i] <= 'z') || (t[i] >= 'A' && t[i] <= 'Z') || (t[i] >= '0' && t[i] <= '9') || t[i] == '_' || t[i] == '-')) return false;
    return true;
}

bool pro_cable_send_notif_read(const char *agent_id, const char *read_token)
{
    if (!agent_id || !agent_id[0] || strlen(agent_id) >= ID_MAX || !token_ok(read_token)) return false;
    cJSON *root = msg("notif.read");
    msg_string(&root, "agentId", agent_id);
    msg_string(&root, "readToken", read_token);
    return send_json(root);
}

// notif.replace {items:[{agentId, name, machine, summary, question, readToken?}]}: the whole unread list. The rows point into
// the parsed message and are valid until pro_app_notif_replace returns.
static void handle_notif_replace(const cJSON *p)
{
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p, "items");
    if (!cJSON_IsArray(items)) return;
    pro_notif_row_t rows[NOTIF_ROWS];
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
        if (n >= NOTIF_ROWS) break;
        const char *aid = str_of(it, "agentId");
        if (!aid || !aid[0] || strnlen(aid, ID_MAX) >= ID_MAX) continue;
        const char *name = str_of(it, "name"), *summary = str_of(it, "summary"), *token = str_of(it, "readToken");
        rows[n++] = (pro_notif_row_t){aid, name ? name : "", summary ? summary : "", token_ok(token) ? token : ""};
    }
    pro_app_notif_replace(rows, n);
}

// notif.seen {agentId, readToken?}: read elsewhere. A readToken that is present but not valid drops the message (as the round does).
static void handle_notif_seen(const cJSON *p)
{
    const char *id = str_of(p, "agentId");
    if (!id || !id[0] || strnlen(id, ID_MAX) >= ID_MAX) return;
    const cJSON *token = cJSON_GetObjectItemCaseSensitive(p, "readToken");
    if (token && !(cJSON_IsString(token) && token_ok(token->valuestring))) return;
    pro_app_notif_seen(id, token ? token->valuestring : NULL);
}

// question {agentId, id, questions:[{q}], superTab?, attention?}. A Super Tab's question names the project (`superTab`, cut to
// SUPER_TAB_MAX - 1 bytes) and what it needs (`attention`: "stuck", else a decision, whatever an unknown value says). Without
// a non-empty superTab it is a plain question, attention or not.
static void handle_question(const char *id, const cJSON *p)
{
    static char s_tab[SUPER_TAB_MAX];
    const char *request = str_of(p, "id");   // the request this question belongs to
    if (!request) return;
    const cJSON *questions = cJSON_GetObjectItemCaseSensitive(p, "questions");
    const char *prompt = str_of(cJSON_GetArrayItem(questions, 0), "q");
    copy_cut(s_text, PRO_QUESTION_BYTES, prompt ? prompt : "Needs your answer");
    const char *tab = cut_of(p, "superTab", s_tab, sizeof s_tab), *attn = str_of(p, "attention");
    if (tab && !tab[0]) tab = NULL;
    const pod_attention_t a = !tab ? POD_ATTN_NONE : attn && !strcmp(attn, "stuck") ? POD_ATTN_STUCK : POD_ATTN_DECISION;
    pro_app_question(id, request, s_text, tab, a);
}

static void handle_question_close(const char *id, const cJSON *p)
{
    const char *request = str_of(p, "id");
    if (!request || !request[0] || strlen(request) >= 64) return;
    pro_app_question_close(id);
}

// ── the player library ──────────────────────────────────────────────────────────────────────────────

#define LIB_ROWS 6   // the page size
typedef struct { char id[ID_MAX], machine_id[ID_MAX], name[96], engine[16], status[16]; int32_t age; } lib_store_t;
static lib_store_t s_lib_store[LIB_ROWS];
static pro_library_row_t s_lib_rows[LIB_ROWS];

static bool whole_number(const cJSON *p, const char *key, double min, double max, double *value)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, key);
    if (!cJSON_IsNumber(v) || !(v->valuedouble >= min && v->valuedouble <= max) ||
        v->valuedouble != (double)(long long)v->valuedouble) return false;
    *value = v->valuedouble;
    return true;
}
static bool exact_string(const cJSON *p, const char *key, char *dst, size_t cap)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(p, key);
    if (!cJSON_IsString(v) || strlen(v->valuestring) >= cap) return false;
    memcpy(dst, v->valuestring, strlen(v->valuestring) + 1);
    return true;
}

// A page is taken whole or not at all: one bad field rejects it.
static void handle_library(const cJSON *p)
{
    double n;
    if (!whole_number(p, "request", 0, UINT32_MAX, &n)) return;
    const uint32_t request = (uint32_t)n;
    if (!whole_number(p, "offset", 0, 1000000, &n)) return;
    const int offset = (int)n;
    if (!whole_number(p, "total", 0, 1000000, &n)) return;
    const int total = (int)n;
    if (!whole_number(p, "machines", 0, 1000000, &n)) return;
    // Only the answer to the latest request: an older reply is a page nobody is waiting for.
    if (!atomic_load(&s_lib_requested) || request != atomic_load(&s_lib_request)) return;
    if (offset > (total > LIB_ROWS ? total - LIB_ROWS : 0)) return;
    const cJSON *rows = cJSON_GetObjectItemCaseSensitive(p, "rows");
    if (!cJSON_IsArray(rows) || cJSON_GetArraySize(rows) > LIB_ROWS) return;
    static const char *const states[] = { "idle", "working", "question", "finished", "failed", "paused", "offline" };
    int count = 0;
    const cJSON *r;
    cJSON_ArrayForEach(r, rows) {
        lib_store_t *row = &s_lib_store[count];
        if (!exact_string(r, "id", row->id, sizeof row->id) || !row->id[0] ||
            !exact_string(r, "machineId", row->machine_id, sizeof row->machine_id) || !row->machine_id[0] ||
            !exact_string(r, "name", row->name, sizeof row->name) ||
            !exact_string(r, "engine", row->engine, sizeof row->engine) ||
            !exact_string(r, "status", row->status, sizeof row->status) ||
            !whole_number(r, "ageSeconds", -1, 315360000, &n)) return;
        row->age = (int32_t)n;
        bool known = false;
        for (unsigned i = 0; i < sizeof states / sizeof states[0]; i++) known = known || !strcmp(row->status, states[i]);
        if (!known) return;
        for (int i = 0; i < count; i++) if (!strcmp(s_lib_store[i].id, row->id)) return;
        count++;
    }
    if (count != (total - offset < LIB_ROWS ? total - offset : LIB_ROWS)) return;
    for (int i = 0; i < count; i++) {
        const lib_store_t *row = &s_lib_store[i];
        const cable_machine_t *m = cable_machines_find(&s_machines, row->machine_id);
        s_lib_rows[i] = (pro_library_row_t){ row->id, row->name, row->engine, m ? m->name : "", row->status, row->age };
    }
    pro_app_library(s_lib_rows, count, offset, total);
}

static void handle_context(const cJSON *p)
{
    const char *id = str_of(p, "id");
    if (!id || !id[0] || strlen(id) >= ID_MAX) return;
    static char machine[64], project[80], branch[96], engine[16];
    pro_app_context(id, cut_of(p, "machine", machine, sizeof machine) ? machine : "",
                    cut_of(p, "project", project, sizeof project) ? project : "",
                    cut_of(p, "branch", branch, sizeof branch) ? branch : "",
                    cut_of(p, "engine", engine, sizeof engine) ? engine : "");
}

// ── voice replies ───────────────────────────────────────────────────────────────────────────────────

static void handle_voice_transcript(const char *agent_id, const cJSON *p)
{
    if (!upload_matches(str_of(p, "uploadId"))) return;
    // A route the daemon was unsure of waits for us to say yes. The Pod has nothing to ask, so it confirms.
    const char *route = str_of(p, "routeId");
    if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "needsConfirm")) && route && agent_id) {
        cJSON *root = msg("voice.confirm");
        msg_string(&root, "routeId", route);
        msg_string(&root, "agentId", agent_id);
        send_json(root);
    }
    pro_app_voice_result(PRO_VOICE_OK, agent_id ? agent_id : "");
}

static void handle_voice_error(const cJSON *p)
{
    if (!upload_matches(str_of(p, "uploadId"))) return;
    const char *message = cut_of(p, "message", s_verb, sizeof s_verb);
    pro_app_voice_result(PRO_VOICE_ERROR, message ? message : "");
}

// ── session ─────────────────────────────────────────────────────────────────────────────────────────

static void session_up(const cJSON *p)
{
    atomic_store(&s_features, cable_features_parse(p));
    const cJSON *machine = p ? cJSON_GetObjectItemCaseSensitive(p, "machine") : NULL;
    const char *name = str_of(machine, "name");
    copy_cut(s_machine_name, sizeof s_machine_name, name ? name : "Machine");
    // The CABLED computer's identity. A welcome that names another one is a changed host on a live link.
    const char *mid = str_of(machine, "id");
    char previous[MACHINE_ID_MAX];
    snprintf(previous, sizeof previous, "%s", s_machine_id);
    if (mid) copy_cut(s_machine_id, sizeof s_machine_id, mid); else s_machine_id[0] = 0;
    const bool was = atomic_load(&s_session);
    const bool moved = was && strcmp(previous, s_machine_id) != 0;
    atomic_store(&s_session, true);
    if (!was) {
        // Route the log through the link only once a peer is listening. Unplugged, the port stays an ordinary
        // console and `idf.py monitor` behaves as it always has.
        cable_link_set_log_framing(true);
        ESP_LOGI(TAG, "session up: %s", s_machine_name);
        if (s_replugs) ESP_LOGW(TAG, "usb: came back after %u self re-plug(s)", s_replugs);
        s_replugs = 0;
        fw_confirm_session_up((uint32_t)(esp_timer_get_time() / 1000));   // starts the clock a fresh image is confirmed on (fw_update.h)
    }
    if (was && !moved) return;
    // Anything held belonged to another host. Drop a half-streamed roster before its end can make it current.
    cable_machines_clear(&s_machines);
    s_agents_building = false;
    s_agent_count = 0;
    atomic_store(&s_lib_requested, false);
    pro_app_link(true, s_machine_name);
    // ASK FOR BOTH, EXPLICITLY: a rebooted device greets with the same mac and version, which the daemon reads as a
    // keepalive and answers with nothing.
    send_json(msg("machines.list"));
    send_json(msg("agents.list"));
    if (!was) last_words_report();   // now that someone is listening: why this boot happened
}

static void session_down(const char *why)
{
    if (!atomic_load(&s_session)) return;
    atomic_store(&s_session, false);
    atomic_store(&s_features, 0);
    atomic_store(&s_lib_requested, false);
    // A row is a claim that something is reachable right now; with the cable gone nothing vouches for it.
    cable_machines_clear(&s_machines);
    s_agents_building = false;
    s_agent_count = 0;
    s_machine_name[0] = 0;
    s_machine_id[0] = 0;
    s_seq_last = -1;
    s_seq_on = false;
    s_resync_pending = false;
    cable_link_reset_decoder();   // runs on the tick: whatever is half-received belonged to the session that ended
    cable_link_set_log_framing(false);   // first: what follows should be readable on a plain monitor
    ESP_LOGI(TAG, "session down (%s)", why);
    fw_confirm_session_down();
    fw_update_abort("session down");
    pro_app_machines(s_machines.rows, 0, "");
    pro_app_link(false, NULL);
}

static void handle_message(const cJSON *root)
{
    const char *t = str_of(root, "t");
    if (!t) { s_bad++; return; }
    const cJSON *p = cJSON_GetObjectItemCaseSensitive(root, "p");
    if (!p) p = root;   // flat messages are legal; `p` is a convenience

    if (!strcmp(t, "welcome")) { session_up(p); return; }
    if (!strcmp(t, "ping")) { send_json(msg("pong")); return; }
    // Everything else belongs to a session: before the welcome (or after the session ended) there is no link for
    // pro_app to show, so a stray frame must not build a roster or open a question on a screen that says "Not connected".
    if (!atomic_load(&s_session)) { s_unknown++; return; }
    if (!strcmp(t, "agents.begin")) { s_agent_count = 0; s_agents_building = true; return; }
    if (!strcmp(t, "agent")) { handle_agent(p); return; }
    if (!strcmp(t, "agents.end")) { handle_agents_end(); return; }
    if (!strcmp(t, "agent.updated")) { send_json(msg("agents.list")); return; }   // cheapest correct answer: re-ask
    if (!strcmp(t, "machines.begin")) { cable_machines_begin(&s_machines); return; }
    if (!strcmp(t, "machine")) { stage_machine(p); return; }
    if (!strcmp(t, "machines.end")) { handle_machines_end(p); return; }
    if (!strcmp(t, "machine.updated")) { handle_machine_updated(p); return; }
    if (!strcmp(t, "swarms")) { handle_swarms(p); return; }
    if (!strcmp(t, "supertabs")) { handle_supertabs(p); return; }
    if (!strcmp(t, "supertab")) { handle_supertab(p); return; }
    if (!strcmp(t, "supertab.recap")) { handle_supertab_recap(p); return; }
    if (!strcmp(t, "supertab.focus")) { handle_supertab_focus(p); return; }
    if (!strcmp(t, "player.library")) { handle_library(p); return; }
    if (!strcmp(t, "player.context")) { handle_context(p); return; }
    if (!strcmp(t, "settings.set")) { handle_settings_set(p); return; }
    if (!strcmp(t, "notif.replace")) { handle_notif_replace(p); return; }
    if (!strcmp(t, "notif.seen")) { handle_notif_seen(p); return; }

    if (!strcmp(t, "fw.offer")) {
        // A missing or mistyped field becomes NULL/0, which fw_update refuses (and answers with fw.error).
        const cJSON *sz = cJSON_GetObjectItemCaseSensitive(p, "size");
        const int size = cJSON_IsNumber(sz) && sz->valuedouble > 0 && sz->valuedouble < INT_MAX ? (int)sz->valuedouble : 0;
        // The gate (pro_app) refuses while a voice start or recording is open and otherwise holds voice off from then on.
        const bool gate = pro_app_begin_update_gate();
        const bool taken = fw_update_offer(str_of(p, "version"), size, str_of(p, "sha256"), !gate);
        // A refusal with nothing in flight lets voice back in (no screen, no notice); a transfer already running keeps it.
        if (!taken && !fw_update_active()) pro_app_end_update_gate();
        s_last_rx_us = esp_timer_get_time();   // the slot erase blocked this reader for seconds
        return;
    }

    const char *agent_id = str_of(p, "agentId");
    // An oversized identity must not turn into another pane through a bounded copy.
    if (agent_id && strnlen(agent_id, ID_MAX) >= ID_MAX) { s_bad++; return; }
    if (!strcmp(t, "voice.transcript")) { handle_voice_transcript(agent_id, p); return; }
    if (!strcmp(t, "voice.error")) { handle_voice_error(p); return; }

    const bool turn = !strncmp(t, "turn.", 5);
    if (agent_id && agent_id[0] && (turn || !strcmp(t, "summary") || !strcmp(t, "focus") ||
                                    !strcmp(t, "question") || !strcmp(t, "question.close"))) {
        if (!strcmp(t, "focus")) { pro_app_focus(agent_id); return; }
        if (!strcmp(t, "turn.started")) {
            const char *text = cut_of(p, "text", s_verb, sizeof s_verb);
            pro_app_turn(agent_id, "started", text ? text : "", 0);
            return;
        }
        if (!strcmp(t, "turn.activity")) { handle_turn_activity(agent_id, p); return; }
        if (!strcmp(t, "turn.done")) { pro_app_turn(agent_id, "done", "", 0); return; }
        if (!strcmp(t, "turn.error")) {
            const char *message = cut_of(p, "message", s_text, sizeof s_text);
            pro_app_turn(agent_id, "error", message ? message : "", 0);
            return;
        }
        if (!strcmp(t, "turn.stats")) { handle_turn_stats(agent_id, p); return; }
        if (!strcmp(t, "summary")) { handle_summary(agent_id, p); return; }
        if (!strcmp(t, "question")) { handle_question(agent_id, p); return; }
        if (!strcmp(t, "question.close")) { handle_question_close(agent_id, p); return; }
    }

    // Everything else the round dial uses (carry, draft, form, visit, workspace, selection, metrics,
    // models, speech, toast, wifi...). Counted, never fatal.
    s_unknown++;
    ESP_LOGD(TAG, "unhandled message '%s'", t);
}

void pro_cable_on_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t payload_len, void *ctx)
{
    (void)version;
    (void)ctx;
    if (type == CABLE_TYPE_FW) {
        // A slice is proof of life like a JSON frame, and the last one blocks this reader (the read-back hash).
        s_last_rx_us = esp_timer_get_time();
        fw_update_slice(payload, payload_len);
        s_last_rx_us = esp_timer_get_time();
        return;
    }
    if (type != CABLE_TYPE_JSON) {   // PCM travels the other way; firmware slices and speech are not taken
        s_unknown++;
        return;
    }
    // Parse straight from the bounded frame; the guard caps depth and token count so cJSON fits the cable_link stack.
    if (!cable_json_guard(payload, payload_len)) { s_bad++; ESP_LOGW(TAG, "frame refused by the guard: %u B", (unsigned)payload_len); return; }
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts((const char *)payload, payload_len, &end, false);
    if (root) {
        const char *limit = (const char *)payload + payload_len;
        while (end < limit && (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r')) end++;
        if (end != limit || !cJSON_IsObject(root)) { cJSON_Delete(root); root = NULL; }
    }
    if (!root) { s_bad++; ESP_LOGW(TAG, "frame did not parse: %u B", (unsigned)payload_len); return; }
    s_last_rx_us = esp_timer_get_time();
    const char *kind = str_of(root, "t");
    track_seq(root, kind && !strcmp(kind, "welcome"));
    handle_message(root);
    cJSON_Delete(root);
}

// A frame lost on the way in (a bad CRC or a seq gap) may have been a roster push; `resync` (when the welcome advertises it, else the
// old swarms.list + agents.list) asks the daemon for the whole snapshot: machines, swarms, agents, notices and open questions. During a transfer the resend logic covers it (the loss
// is consumed, not replayed after). At most once per 2 s.
static void link_resync(void)
{
    static uint32_t seen;
    static int64_t last_us = -2000000;
    uint32_t corrupt = 0, discarded = 0;
    cable_link_counters(&corrupt, &discarded);
    if ((corrupt == seen && !s_resync_pending) || !atomic_load(&s_session)) return;
    const int64_t now = esp_timer_get_time();
    if (fw_update_active()) { seen = corrupt; s_resync_pending = false; return; }
    if (now - last_us < 2000000) return;   // keep it pending; the next tick after the window answers
    seen = corrupt;
    s_resync_pending = false;
    last_us = now;
    if (atomic_load(&s_features) & CABLE_FEATURE_RESYNC) {
        send_json(msg("resync"));
    } else {   // a daemon that predates `resync`: the old refresh
        send_json(msg("swarms.list"));
        send_json(msg("agents.list"));
    }
}

// Before the silence check, so the clock starts at the session's last tick. Only a host that is there counts, but its
// absence does not reset the wait: the re-plug itself makes the host vanish for a moment, and a reset would loop at 30 s.
static void replug_tick(int64_t now)
{
    static int64_t since, wait = (int64_t)REPLUG_ALONE_MS * 1000;
    if (atomic_load(&s_session)) wait = (int64_t)REPLUG_ALONE_MS * 1000;
    // Never in the middle of an update or a recording: an unplug there loses the transfer.
    if (atomic_load(&s_session) || !cable_link_host_present() || fw_update_active() || pro_voice_open()) {
        since = now;
        return;
    }
    if (now - since < wait) return;
    s_replugs++;
    ESP_LOGW(TAG, "usb: no session for %llds with the host present: self re-plug #%u",
             (long long)((now - since) / 1000000), s_replugs);
    since = now;
    if (wait < (int64_t)REPLUG_MAX_MS * 1000 / 2) wait *= 2; else wait = (int64_t)REPLUG_MAX_MS * 1000;
    cable_link_replug();
}

void pro_cable_tick(void *ctx)
{
    (void)ctx;
    // Under the task watchdog like the render task, so a hang here is a TASK_WDT panic with a backtrace, not a silent
    // hardware reset. Joined on the first tick (this runs on the link's reader task, which this file does not create).
    static bool watched;
    if (!watched) { watched = esp_task_wdt_add(NULL) == ESP_OK; }
    else esp_task_wdt_reset();
    last_words_phase(LW_CABLE, fw_update_active() ? "ota" : "cable.read");
    last_words_rx((uint32_t)(s_last_rx_us / 1000));
    fw_update_tick((uint32_t)(esp_timer_get_time() / 1000));
    link_resync();
    replug_tick(esp_timer_get_time());
    if (atomic_load(&s_session) && esp_timer_get_time() - s_last_rx_us > (int64_t)SILENCE_MS * 1000)
        session_down("silence");
}

static void hello_task(void *arg)
{
    (void)arg;
    // Reserve the task before exposing the reader: it must not send until the USB driver is ready.
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    int64_t next_hello_us = 0;
    for (;;) {
        const int64_t now = esp_timer_get_time();
        if (now >= next_hello_us) {
            send_hello();
            next_hello_us = now + (int64_t)(atomic_load(&s_session) ? HELLO_SESSION_MS : HELLO_ALONE_MS) * 1000;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

void pro_cable_start(void)
{
    if (s_started) return;
    TaskHandle_t hello = NULL;
    cable_machines_init(&s_machines);
    s_upload_lock = xSemaphoreCreateMutex();
    if (!s_upload_lock) { ESP_LOGE(TAG, "no memory for the upload lock - link disabled"); return; }
    s_last_rx_us = esp_timer_get_time();
    if (xTaskCreate(hello_task, "cable_hello", STACK_CABLE_HELLO, NULL, 4, &hello) != pdPASS) {
        ESP_LOGE(TAG, "hello task create failed - no handshake");
        return;
    }
    if (!cable_link_start(pro_cable_on_frame, pro_cable_tick, NULL)) {
        vTaskDelete(hello);
        return;
    }
    s_started = true;
    xTaskNotifyGive(hello);
    ESP_LOGI(TAG, "cable client started (fw %s, proto %d)", pro_cable_fw_version(), CABLE_PROTO_VERSION);
}

bool pro_settings_muted(void) { return config_load_muted(); }
