#include "cable_client.h"
#include "cable_scroll.h"

#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include <math.h>

#include "cJSON.h"
#include "cable_link.h"
#include "cable_json_guard.h"
#include "cable_machines.h"
#include "device_mac.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "audio_capture.h"   // audio_notify_done() — the completion beep
#include "audio_client.h"
#include "esp_timer.h"
#include "fw_update.h"
#include "last_words.h"
#include "pet_store.h"
#include "board/board.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ui/ui_screens.h"

static const char *TAG = "cable_client";

// ── session timing ──────────────────────────────────────────────────────────────────────────────────
// Over a cable there is no connection to lose: the daemon quitting looks exactly like the daemon having
// nothing to say. Both are silence. So the daemon pings on a fixed cadence for as long as it is alive,
// and the dial reads a gap as absence.
//
// The dial greets on a cadence of its own because it has no port-open event to wait on. The SLOW one is
// load-bearing rather than noise: if the daemon restarts inside the silence window, the dial never
// notices it left — the new instance's ping refreshes the same timer — so without a periodic greeting the
// dial would hold stale tiles forever, connected to a daemon that has never sent it a `welcome`.
#define HELLO_ALONE_MS   2000    // no session: introduce myself often, the daemon cannot see me until I speak
#define HELLO_SESSION_MS 15000   // session up: a keepalive, and a re-introduction if the daemon restarted
#define SILENCE_MS       15000   // nothing of any kind for this long → the daemon is gone

typedef struct {
    char id[ID_MAX];
    char name[CABLE_NAME_MAX];
    char engine[12];
    char model[24];
    char effort[16];
    char machine_id[ID_MAX];    // which machine this agent lives on ("" from a daemon that predates it)
    char machine[CABLE_NAME_MAX];     // that machine's name, drawn under the agent's
} cable_agent_t;


static cable_agent_t     *s_agents;
static int                s_agent_count;
static bool               s_agents_building;
static SemaphoreHandle_t  s_agents_lock;

// The machine wheel, staged and gated here rather than in the UI. `cable_machines_end()` answers the one
// question that matters — did anything actually change — BEFORE any display lock is taken, so an
// unchanged list costs a memcmp on the reader task instead of a full rebuild. See cable_machines.h for
// the measurement that made that necessary.
static cable_machines_t  s_machines;
static char              s_machine_id[MACHINE_ID_MAX];

static atomic_bool       s_session;
static atomic_uint       s_features;
static bool              s_started; // boot owner; successful start is idempotent
// Only the USB reader accesses this after start. A volatile 64-bit value is
// not atomic on this 32-bit CPU; session expiry must share the reader's owner.
static int64_t           s_last_rx_us;
static char              s_machine_name[CABLE_NAME_MAX];
static uint32_t          s_bad, s_unknown;

bool cable_client_supports(uint32_t features)
{
    return (atomic_load(&s_features) & features) == features;
}

// ── outbound ────────────────────────────────────────────────────────────────────────────────────────

// Serialise and send. Takes ownership of `root` — every caller builds a tree for exactly one message, and
// making the send own it is what keeps an early return from leaking one.
static bool send_json(cJSON *root)
{
    if (!root) return false;
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!text) return false;
    const bool ok = cable_link_send(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text));
    cJSON_free(text);
    return ok;
}

// A message with a `t` and nothing else, or with one string field. cJSON does the escaping, which is not
// optional: an agent name or a spoken sentence carries quotes, backslashes and newlines, and hand-built
// JSON turns those into a payload the far end drops as unreadable.
static cJSON *msg(const char *t)
{
    cJSON *root = cJSON_CreateObject();
    if (root && !cJSON_AddStringToObject(root, "t", t)) {
        cJSON_Delete(root);
        return NULL;
    }
    return root;
}

// One allocation failure invalidates the entire command. A partially built
// voice.begin must never lose its agentId and become a different routing mode.
// Keep failure sticky by releasing the tree and clearing the caller's pointer;
// subsequent fields become no-ops and send_json(NULL) cannot emit anything.
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
static bool msg_bool(cJSON **root, const char *key, bool value)
{
    return *root && msg_check(root, cJSON_AddBoolToObject(*root, key, value) != NULL);
}
static cJSON *msg_array(cJSON **root, const char *key)
{
    if (!*root) return NULL;
    cJSON *array = cJSON_AddArrayToObject(*root, key);
    msg_check(root, array != NULL);
    return array;
}
static bool msg_item(cJSON **root, const char *key, cJSON *item)
{
    if (!*root || !cJSON_AddItemToObject(*root, key, item)) {
        cJSON_Delete(item);
        return msg_check(root, false);
    }
    return true;
}

const char *cable_fw_version(void)
{
    // Never NULL: esp_app_get_description() reads a structure linked into this very image. Read from the
    // running image rather than a constant so the daemon's version comparison cannot be lied to.
    return esp_app_get_description()->version;
}

/*
 * Habitat only, and deliberately. The LVGL build keeps its settings on the glass, so it has nothing to
 * report and nothing to be told; sending it anyway would put rows in the app that the device's own
 * screens would then contradict. When LVGL goes, so does this guard.
 */
/*
 * THE SETTINGS OBJECT, one shape written once and read once.
 *
 * Named booleans, not the NVS bitmask: the bit positions in config_store.h are this firmware's private
 * arrangement, and an app that knew them would have to be updated in step with a header it cannot see.
 * `round` is the face, not a preference — it tells the app which rows to leave out entirely.
 */
static cJSON *companion_json(const ui_companion_t *identity)
{
    if (!identity->id[0]) return cJSON_CreateNull();
    cJSON *o=cJSON_CreateObject();
    if (!o) return NULL;
    if (!cJSON_AddStringToObject(o,"id",identity->id) || !cJSON_AddStringToObject(o,"uid",identity->uid) ||
        !cJSON_AddStringToObject(o,"name",identity->name) || !cJSON_AddStringToObject(o,"version",identity->version) ||
        !cJSON_AddNumberToObject(o,"seed",identity->seed) || !cJSON_AddNumberToObject(o,"colour",identity->colour) ||
        !cJSON_AddNumberToObject(o,"mark",identity->mark)) { cJSON_Delete(o); return NULL; }
    return o;
}
static const char *str_of(const cJSON *o, const char *key);
static bool companion_parse(const cJSON *o,ui_companion_t *identity)
{
    memset(identity,0,sizeof *identity);
    const char *keys[]={"id","uid","name","version"};
    char *values[]={identity->id,identity->uid,identity->name,identity->version};
    const size_t caps[]={sizeof identity->id,sizeof identity->uid,sizeof identity->name,sizeof identity->version};
    for (unsigned i=0;i<4;i++) {
        const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,keys[i]);
        if (!cJSON_IsString(v) || !v->valuestring || !v->valuestring[0] || strlen(v->valuestring)>=caps[i]) return false;
        for (const unsigned char *p=(const unsigned char *)v->valuestring;*p;p++) if (*p<32 || *p>126) return false;
        if (i==1) for (const char *p=v->valuestring;*p;p++)
            if (!((*p>='A' && *p<='Z') || (*p>='a' && *p<='z') || (*p>='0' && *p<='9') || *p=='_' || *p=='-')) return false;
        memcpy(values[i],v->valuestring,strlen(v->valuestring)+1);
    }
    if (strcmp(identity->version,"0.1") && strcmp(identity->version,"1.0") && strcmp(identity->version,"2.0")) return false;
    const cJSON *seed=cJSON_GetObjectItemCaseSensitive(o,"seed"),*colour=cJSON_GetObjectItemCaseSensitive(o,"colour"),*mark=cJSON_GetObjectItemCaseSensitive(o,"mark");
    if (!cJSON_IsNumber(seed) || !isfinite(seed->valuedouble) || seed->valuedouble<0 || seed->valuedouble>4294967295.0 || seed->valuedouble!=(uint32_t)seed->valuedouble ||
        !cJSON_IsNumber(colour) || colour->valuedouble < -1 || colour->valuedouble>5 || colour->valuedouble!=colour->valueint ||
        !cJSON_IsNumber(mark) || mark->valuedouble<0 || mark->valuedouble>4 || mark->valuedouble!=mark->valueint) return false;
    identity->seed=(uint32_t)seed->valuedouble;identity->colour=colour->valueint;identity->mark=mark->valueint;
    return true;
}
static void msg_settings(cJSON **root)
{
    ui_settings_t now;
    ui_settings_read(&now);
    if (!*root) return;
    cJSON *object = cJSON_CreateObject();
    if (!object || !cJSON_AddItemToObject(*root, "settings", object)) {
        cJSON_Delete(object);
        msg_check(root, false);
        return;
    }
    cJSON *held = object;   // owned by the tree now; failures below fall to msg_check on the root
    bool ok = cJSON_AddNumberToObject(held, "brightness", now.brightness) &&
              cJSON_AddNumberToObject(held, "character", now.character) &&
              cJSON_AddNumberToObject(held, "face", now.face) &&
              cJSON_AddBoolToObject(held, "muted", now.muted) &&
              cJSON_AddBoolToObject(held, "quiet", now.quiet) &&
              cJSON_AddBoolToObject(held, "straightTitle", now.straight_title) &&
              cJSON_AddBoolToObject(held, "focusFace", now.focus_face) &&
              cJSON_AddBoolToObject(held, "scrollReversed", now.scroll_reversed) &&
              cJSON_AddBoolToObject(held, "round", now.round) &&
              cJSON_AddBoolToObject(held, "followCompanion", now.follow_companion) &&
              (now.companion[0] ? cJSON_AddStringToObject(held, "companion", now.companion)
                                : cJSON_AddNullToObject(held, "companion")) &&
              cJSON_AddStringToObject(held, "voiceLang", now.voicelang) &&
              cJSON_AddNumberToObject(held,"companionProtocol",2);
    cJSON *identity=companion_json(&now.companion_details);
    if (!identity || !cJSON_AddItemToObject(held,"companionDetails",identity)) { cJSON_Delete(identity);ok=false; }
    msg_check(root, ok);
}
void cable_client_report_settings(void)
{
    cJSON *root = msg("settings.state");
    if (!root) return;
    msg_bool(&root, "ok", true);
    msg_settings(&root);
    send_json(root);
}
/*
 * `settings.set`. Absent means unchanged — a frame naming one row must not restate the other ten, or
 * two windows open on the same device would fight over every setting each of them last saw.
 */
static void handle_settings_set(const cJSON *p)
{
    ui_settings_t want;
    ui_settings_read(&want);   // the unnamed fields keep what the device holds
    uint32_t fields = 0;
    const cJSON *item;
    struct { const char *key; uint32_t bit; bool *slot; } flags[] = {
        {"muted", UI_SETTING_MUTED, &want.muted},
        {"quiet", UI_SETTING_QUIET, &want.quiet},
        {"straightTitle", UI_SETTING_STRAIGHT_TITLE, &want.straight_title},
        {"focusFace", UI_SETTING_FOCUS_FACE, &want.focus_face},
        {"scrollReversed", UI_SETTING_SCROLL, &want.scroll_reversed},
        {"followCompanion", UI_SETTING_FOLLOW_COMPANION, &want.follow_companion},
    };
    for (unsigned i = 0; i < sizeof flags / sizeof flags[0]; i++) {
        item = cJSON_GetObjectItemCaseSensitive(p, flags[i].key);
        if (cJSON_IsBool(item)) { *flags[i].slot = cJSON_IsTrue(item); fields |= flags[i].bit; }
    }
    item = cJSON_GetObjectItemCaseSensitive(p, "brightness");
    if (cJSON_IsNumber(item)) {
        // Clamped here rather than refused: a slider that overshoots by a pixel is not an error, and
        // ui_settings_apply still refuses anything this cannot make sense of.
        double value = item->valuedouble;
        want.brightness = (uint8_t)(value < 0 ? 0 : value > 100 ? 100 : value);
        fields |= UI_SETTING_BRIGHTNESS;
    }
    item = cJSON_GetObjectItemCaseSensitive(p, "character");
    if (cJSON_IsNumber(item) && item->valuedouble >= 0 && item->valuedouble < 255) {
        want.character = (uint8_t)item->valuedouble;
        fields |= UI_SETTING_CHARACTER;
    }
    item = cJSON_GetObjectItemCaseSensitive(p, "voiceLang");
    if (cJSON_IsString(item) && item->valuestring) {
        snprintf(want.voicelang, sizeof want.voicelang, "%s", item->valuestring);
        fields |= UI_SETTING_VOICELANG;
    }
    char error[96] = "";
    bool ok = ui_settings_apply(&want, fields, error, sizeof error);
    cJSON *root = msg("settings.state");
    if (!root) return;
    msg_bool(&root, "ok", ok);
    if (!ok) msg_string(&root, "error", error);
    msg_settings(&root);   // always the values read back, never the ones asked for
    send_json(root);
}
static void handle_companion_set(const cJSON *p)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(p, "id");
    bool valid = cJSON_IsNull(id) || (cJSON_IsString(id) && id->valuestring);
    ui_companion_t identity;
    const cJSON *details=cJSON_GetObjectItemCaseSensitive(p,"identity");
    bool ok = details ? valid && !cJSON_IsNull(id) && companion_parse(details,&identity) &&
        !strcmp(identity.id,id->valuestring) && ui_set_companion_identity(&identity) :
        valid && ui_set_companion(cJSON_IsNull(id) ? NULL : id->valuestring);
    cJSON *root = msg("settings.state");
    if (!root) return;
    msg_bool(&root, "ok", ok);
    if (!ok) msg_string(&root, "error", "Unknown companion.");
    msg_settings(&root);
    send_json(root);
}
static void handle_companion_celebrate(const cJSON *p)
{
    ui_companion_t identity;
    const char *kind=str_of(p,"kind"),*token=str_of(p,"token");
    bool ok=companion_parse(cJSON_GetObjectItemCaseSensitive(p,"identity"),&identity) &&
        ui_companion_celebrate(&identity,kind,token);
    cJSON *root=msg("companion.event");
    msg_bool(&root,"ok",ok);if (token) msg_string(&root,"token",token);send_json(root);
}
static void send_hello(void)
{
    cJSON *root = msg("hello");
    if (!root) return;
    msg_string(&root, "fw", cable_fw_version());
    // Named before anything else about this dial is believed. See CABLE_PRODUCT.
    msg_string(&root, "product", CABLE_PRODUCT);
    msg_number(&root, "proto", CABLE_PROTO_VERSION);
    // Which of the two dials this is (board.h) — informational, so a log or a bug report can say. A
    // daemon that predates the field ignores it.
    msg_string(&root, "hw", board()->name);
    // Also the device's USB serial number, so the daemon can tell one dial from another before a byte is
    // exchanged — and can tell a keepalive greeting from a new board.
    char mac[24] = "";
    device_mac_str(mac, sizeof(mac));
    msg_string(&root, "mac", mac);
    // Carried on every greeting so the app's pane opens on what the device holds rather than on what
    // this computer last sent it — which after a reboot, a reset or a second window is not the same.
    msg_settings(&root);
    // Custom pets: the pack version this build understands (a number, so a later format can say 2), and
    // these packs are already held, so the daemon sends only what is missing.
    msg_number(&root, "pets", 1);
    {
        char held[PET_STORE_MAX_PACKS][17];
        const size_t n = pet_store_held(held, PET_STORE_MAX_PACKS);
        cJSON *ids = msg_array(&root, "petIds");
        for (size_t i = 0; root && ids && i < n; i++) {
            cJSON *id = cJSON_CreateString(held[i]);
            if (!msg_check(&root, id != NULL)) break;
            if (!cJSON_AddItemToArray(ids, id)) { cJSON_Delete(id); msg_check(&root, false); }
        }
    }
    send_json(root);
}

void cable_client_list_machines(void)
{
    send_json(msg("machines.list"));
}

void cable_client_select_machine(const char *machine_id)
{
    if (!machine_id || !machine_id[0]) return;
    cJSON *root = msg("machine.select");
    if (!root) return;
    msg_string(&root, "machineId", machine_id);
    send_json(root);
}

const char *cable_client_machine_id(void) { return s_machine_id; }

void cable_client_select_swarm(const char *swarm_id)
{
    if (!swarm_id || !swarm_id[0]) return;
    cJSON *root = msg("swarm.select");
    if (!root) return;
    msg_string(&root, "swarmId", swarm_id);
    send_json(root);
}

void cable_client_list_swarms(void)
{
    send_json(msg("swarms.list"));
}


void cable_client_send_turn(const char *agent_id, const char *text)
{
    if (!agent_id || !agent_id[0] || !text) return;
    cJSON *root = msg("turn.send");
    if (!root) return;
    msg_string(&root, "agentId", agent_id);
    msg_string(&root, "text", text);
    send_json(root);
}

void cable_client_stop_turn(const char *agent_id)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("turn.stop");
    if (!root) return;
    msg_string(&root, "agentId", agent_id);
    send_json(root);
}

void cable_client_send_focus(const char *agent_id)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("focus");
    if (!root) return;
    msg_string(&root, "agentId", agent_id);
    send_json(root);
}

void cable_client_send_open(const char *agent_id, const char *reason)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("agent.open");
    if (!root) return;
    msg_string(&root, "agentId", agent_id);
    // Absent for a tap: an older daemon reads the frame exactly as before.
    if (reason && reason[0]) msg_string(&root, "reason", reason);
    send_json(root);
}

bool cable_client_notification_read(const char *agent_id, const char *read_token)
{
    if (!agent_id || !agent_id[0] || strlen(agent_id) >= ID_MAX ||
        !read_token || !read_token[0] || strlen(read_token) >= CABLE_READ_TOKEN_MAX) return false;
    cJSON *root = msg("notif.read");
    msg_string(&root, "agentId", agent_id);
    msg_string(&root, "readToken", read_token);
    return send_json(root);
}

void cable_client_send_scroll(cable_scroll_phase_t phase, int dy, int velocity)
{
    _Static_assert(CABLE_SCROLL_DOWN == 0 && CABLE_SCROLL_MOVE == 1 && CABLE_SCROLL_UP == 2,
                   "scroll phase wire order");
    // NO EARLY-OUT ON A ZERO dy. The two ends of a stroke are the whole point of this message: a `down`
    // with nothing in it is what stops a fling still running, and an `up` with nothing in it is a finger
    // that came to rest before it lifted — which must land as a stop, not as a throw.
    char wire[CABLE_SCROLL_JSON_MAX];
    size_t n = cable_scroll_encode(wire, sizeof wire, phase, dy, velocity);
    if (n) cable_link_send(CABLE_TYPE_JSON, (const uint8_t *)wire, n);
}

void cable_client_answer(const char *agent_id, const char *request_id, const cJSON *answers)
{
    if (!agent_id || !request_id || !answers) return;
    cJSON *root = msg("answer");
    if (!root) return;
    msg_string(&root, "agentId", agent_id);
    msg_string(&root, "requestId", request_id);
    // Duplicated, not adopted: the caller keeps its own tree and this one is deleted with the message.
    cJSON *copy = cJSON_Duplicate(answers, true);
    if (!copy) { cJSON_Delete(root); return; }
    msg_item(&root, "answers", copy);
    send_json(root);
}

void cable_client_question_read(const char *agent_id, const char *request_id)
{
    cJSON *root=msg("question.read"); if (!root) return;
    msg_string(&root,"agentId",agent_id);
    msg_string(&root,"requestId",request_id);
    send_json(root);
}
bool cable_client_answer_reviewed(const char *agent_id, const char *request_id, const char *token,
                                  const uint8_t *choices, const char drafts[][48], int count)
{
    if (!agent_id || !request_id || !token || !choices || count<1 || count>4) return false;
    cJSON *root=msg("answer.reviewed"); if (!root) return false;
    msg_string(&root,"agentId",agent_id);
    msg_string(&root,"requestId",request_id);
    msg_string(&root,"token",token);
    cJSON *array=msg_array(&root,"choices");
    if (!array) { cJSON_Delete(root); return false; }
    for (int i=0;i<count;i++) {
        cJSON *value=cJSON_CreateNumber(choices[i]);
        if (!value) { cJSON_Delete(root); return false; }
        cJSON_AddItemToArray(array,value);
    }
    cJSON *spoken=msg_array(&root,"drafts");
    if (!spoken) { cJSON_Delete(root); return false; }
    for (int i=0;i<count;i++) {
        cJSON *value=cJSON_CreateString(drafts ? drafts[i] : "");
        if (!value) { cJSON_Delete(root); return false; }
        cJSON_AddItemToArray(spoken,value);
    }
    return send_json(root);
}

// ── models: the one round trip ──────────────────────────────────────────────────────────────────────
// Everything else here is fire-and-forget, which is what keeps a spoken turn off the critical path. The
// picker is the exception because there is nothing to draw until the catalog arrives, so this waits — on
// refresh_task, never on the LVGL task.
#define MODELS_WAIT_MS 4000

static SemaphoreHandle_t s_models_sem;
static model_item_t     *s_models_out;
static int               s_models_max;
static int               s_models_n;
static char              s_models_agent[ID_MAX];
static uint32_t          s_models_request;
static bool              s_models_replied;


static void handle_models(const cJSON *p)
{
    if (!s_models_sem || !s_agents_lock) return;
    // The caller owns the output storage. Its timeout may run on the other core
    // while this reader is copying a reply, so pointer + capacity + completion
    // share the client data lock. Never hold it while waiting for the reply.
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    const cJSON *agent_id = cJSON_GetObjectItemCaseSensitive(p, "agentId");
    const cJSON *request = cJSON_GetObjectItemCaseSensitive(p, "request");
    // Legacy hosts echo agentId. Newer hosts also echo the request serial, so
    // an old same-agent response cannot complete a later picker. Accept only
    // the first matching reply while the caller still owns its output buffer.
    if (!s_models_out || s_models_replied || !cJSON_IsString(agent_id) ||
        strcmp(agent_id->valuestring, s_models_agent) ||
        (request && (!cJSON_IsNumber(request) || request->valuedouble != s_models_request))) {
        xSemaphoreGive(s_agents_lock); return;
    }
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p, "items");
    if (!cJSON_IsArray(items)) { xSemaphoreGive(s_agents_lock); return; }
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
        if (n >= s_models_max) break;
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(it, "id");
        if (!cJSON_IsString(id) || !id->valuestring[0] ||
            strlen(id->valuestring) >= sizeof s_models_out[n].id) continue;
        snprintf(s_models_out[n].id, sizeof(s_models_out[n].id), "%s", id->valuestring);
        n++;
    }
    s_models_n = n;
    s_models_replied = true;
    xSemaphoreGive(s_models_sem);
    xSemaphoreGive(s_agents_lock);
}

int cable_client_models_list(const char *agent_id, const char *picker_mode, const char *selected_model,
                             model_item_t *arr, int max)
{
    if (!agent_id || !agent_id[0] || strlen(agent_id) >= sizeof s_models_agent ||
        !arr || max <= 0 || !s_models_sem || !s_agents_lock) return -1;

    // Build the complete request before publishing a borrowed output pointer.
    // A failed allocation must not leave a late reply pointing at caller memory.
    cJSON *root = msg("models.list");
    if (!root) return -1;
    if (!msg_string(&root, "agentId", agent_id) ||
        (picker_mode && !msg_string(&root, "mode", picker_mode)) ||
        (selected_model && selected_model[0] &&
         !msg_string(&root, "selected", selected_model))) {
        cJSON_Delete(root);
        return -1;
    }

    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    if (s_models_out) { xSemaphoreGive(s_agents_lock); cJSON_Delete(root); return -1; }
    s_models_request = s_models_request >= INT32_MAX ? 1 : s_models_request + 1;
    if (!msg_number(&root, "request", s_models_request)) {
        xSemaphoreGive(s_agents_lock); return -1;
    }
    snprintf(s_models_agent, sizeof s_models_agent, "%s", agent_id);
    s_models_replied = false;
    s_models_out = arr;
    s_models_max = max;
    s_models_n = 0;
    // Drain a stale give from a previous request that timed out and then answered.
    xSemaphoreTake(s_models_sem, 0);
    xSemaphoreGive(s_agents_lock);

    const bool sent = send_json(root);
    const bool answered = sent && xSemaphoreTake(s_models_sem, pdMS_TO_TICKS(MODELS_WAIT_MS)) == pdTRUE;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    const int n = answered ? s_models_n : -1;
    s_models_out = NULL;
    s_models_max = 0;
    xSemaphoreGive(s_agents_lock);
    if (sent && !answered) ESP_LOGW(TAG, "models: no answer in %d ms", MODELS_WAIT_MS);
    return n;
}

void cable_client_agent_update(const char *agent_id, const char *model, const char *effort)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("agent.update");
    if (!root) return;
    msg_string(&root, "agentId", agent_id);
    if (model && model[0]) msg_string(&root, "model", model);
    if (effort && effort[0]) msg_string(&root, "effort", effort);
    send_json(root);
}

bool cable_client_voice_begin(const char *agent_id, const char *cmd, const char *lang, int sample_rate)
{
    cJSON *root = msg("voice.begin");
    if (!root) return false;
    // OMITTED, not empty, when there is no agent: absence is what tells the daemon it has to route the
    // transcript itself. An empty string would read as "this agent", and there is no agent called "".
    if (agent_id && agent_id[0]) msg_string(&root, "agentId", agent_id);
    if (cmd && cmd[0]) msg_string(&root, "cmd", cmd);
    msg_string(&root, "lang", lang && lang[0] ? lang : "en");
    msg_number(&root, "sr", sample_rate);
    char upload_id[24];
    audio_client_copy_upload_id(upload_id, sizeof(upload_id));
    msg_string(&root, "uploadId", upload_id);
    char carried[48];
    audio_client_copy_carry(carried, sizeof(carried));
    if (carried[0]) msg_string(&root, "carryId", carried);
    char form[48]; unsigned form_revision = 0;
    audio_client_copy_form(form, sizeof(form), &form_revision);
    if (form[0]) {
        msg_string(&root, "formId", form);
        msg_number(&root, "formRevision", form_revision);
    }
    char draft[48]; unsigned draft_revision=0; bool append=false;
    audio_client_copy_draft(draft,sizeof draft,&draft_revision,&append);
    if (draft[0]) {
        msg_string(&root,"draftId",draft);
        msg_number(&root,"draftRevision",draft_revision);
        msg_string(&root,"draftOp",append ? "append" : "replace");
    }
    char question[48]; unsigned question_index = 0;
    audio_client_copy_question(question, sizeof(question), &question_index);
    if (question[0]) {
        msg_string(&root, "questionToken", question);
        msg_number(&root, "questionIndex", question_index);
    }
    char search[48]; unsigned search_revision = 0;
    audio_client_copy_search(search, sizeof search, &search_revision);
    if (search[0]) {
        msg_string(&root,"searchId",search);
        msg_number(&root,"searchRevision",search_revision);
    }
    char selected[48]; unsigned revision = 0;
    audio_client_copy_selection(selected, sizeof(selected), &revision);
    if (selected[0] && revision) {
        msg_string(&root, "selectionId", selected);
        msg_number(&root, "selectionRevision", revision);
    }
    return send_json(root);
}

void cable_client_carry(const char *id, const char *agent, const char *selection,
                        uint32_t request, uint32_t revision, bool cancel)
{
    cJSON *root=msg(cancel ? "carry.cancel" : "carry.prepare");
    if (!root) return;
    msg_string(&root,"carryId",id);
    if (!cancel) {
        char request_id[24]; snprintf(request_id,sizeof(request_id),"carry-%lu",(unsigned long)request);
        msg_string(&root,"requestId",request_id);
        msg_string(&root,"agentId",agent);
        msg_string(&root,"selectionId",selection);
        msg_number(&root,"revision",revision);
    }
    send_json(root);
}
void cable_client_form(const char *id, uint32_t request, const char *op, uint32_t revision, int delta)
{
    cJSON *root = msg("form");
    if (!root) return;
    char request_id[24]; snprintf(request_id, sizeof request_id, "form-%lu", (unsigned long)request);
    msg_string(&root, "requestId", request_id);
    msg_string(&root, "formId", id);
    msg_string(&root, "surface", !strncmp(id, "find-", 5) ? "find" : "new");
    msg_string(&root, "op", op);
    msg_number(&root, "revision", revision);
    msg_number(&root, "delta", delta);
    bool sent=send_json(root);
    if (strcmp(op,"state") || !sent)
        ESP_LOGI(TAG,"picker %s req=%lu revision=%lu sent=%d",op,
            (unsigned long)request,(unsigned long)revision,sent);
}
void cable_client_visit(const char *id, uint32_t request, const char *op, const char *agent)
{
    cJSON *root = msg("visit");
    if (!root) return;
    char request_id[24]; snprintf(request_id, sizeof request_id, "visit-%lu", (unsigned long)request);
    msg_string(&root, "requestId", request_id);
    msg_string(&root, "visitId", id);
    msg_string(&root, "op", op);
    msg_string(&root, "agentId", agent);
    send_json(root);
}

void cable_client_select_text(const char *agent_id, const char *selection_id, uint32_t request,
                             uint32_t revision, const char *op, int delta, bool extend)
{
    cJSON *root = msg("selection");
    if (!root) return;
    char request_id[24]; snprintf(request_id, sizeof(request_id), "pick-%lu", (unsigned long)request);
    msg_string(&root, "requestId", request_id);
    msg_string(&root, "agentId", agent_id);
    msg_string(&root, "selectionId", selection_id);
    msg_string(&root, "op", op);
    msg_number(&root, "revision", revision);
    msg_number(&root, "delta", delta);
    msg_bool(&root, "extend", extend);
    send_json(root);
}

bool cable_client_voice_pcm(const uint8_t *pcm, size_t len)
{
    return cable_link_send(CABLE_TYPE_PCM, pcm, len);
}

void cable_client_draft(const char *id,const char *op,uint32_t request,uint32_t revision,int delta)
{
    cJSON *root=msg("draft.command");if(!root)return;
    char req[32];snprintf(req,sizeof req,"draft-%lu",(unsigned long)request);
    msg_string(&root,"draftId",id);msg_string(&root,"requestId",req);
    msg_string(&root,"op",op);msg_number(&root,"revision",revision);
    msg_number(&root,"delta",delta);send_json(root);
}
void cable_client_voice_end(void)
{
    cJSON *root=msg("voice.end"); if (!root) return;
    char upload[24]; audio_client_copy_upload_id(upload,sizeof upload);
    msg_string(&root,"uploadId",upload);
    if (audio_client_review_requested()) msg_bool(&root,"review",true);
    send_json(root);
}

void cable_client_voice_abort(const char *why)
{
    cJSON *root = msg("voice.abort");
    if (!root) return;
    if (why && why[0]) msg_string(&root, "why", why);
    char upload_id[24];
    audio_client_copy_upload_id(upload_id, sizeof(upload_id));
    msg_string(&root, "uploadId", upload_id);
    send_json(root);
}

void cable_client_voice_cancel(const char *upload_id)
{
    if (!upload_id || !*upload_id) return;
    cJSON *root = msg("voice.abort");
    if (!root) return;
    msg_string(&root, "uploadId", upload_id);
    msg_string(&root, "why", "discarded");
    send_json(root);
}

void cable_client_voice_confirm(const char *route_id, const char *agent_id)
{
    if (!route_id || !agent_id) return;
    cJSON *root = msg("voice.confirm");
    if (!root) return;
    msg_string(&root, "routeId", route_id);
    msg_string(&root, "agentId", agent_id);
    send_json(root);
}

void cable_client_fw_accept(void) { send_json(msg("fw.accept")); }
void cable_client_fw_done(void)   { send_json(msg("fw.done")); }

void cable_client_fw_progress(uint32_t written)
{
    cJSON *root = msg("fw.progress");
    if (!root) return;
    msg_number(&root, "written", (double)written);
    send_json(root);
}

void cable_client_fw_error(const char *message)
{
    cJSON *root = msg("fw.error");
    if (!root) return;
    msg_string(&root, "message", message ? message : "");
    send_json(root);
}

// ── the agent list ──────────────────────────────────────────────────────────────────────────────────

const char *cable_client_machine_name(void) { return s_machine_name; }

// Set by `agents.end`, read by the refresh that applies the list — see ui_fleet_set.
static int  s_agents_total;
static bool s_has_window;
static char s_agents_tab[ID_MAX];
static uint32_t s_agents_generation;

int cable_client_agent_total(void)
{
    if (!s_agents_lock) return 0;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    const int n = s_agents_total;
    xSemaphoreGive(s_agents_lock);
    return n;
}

bool cable_client_has_window(void)
{
    if (!s_agents_lock) return false;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    const bool w = s_has_window;
    xSemaphoreGive(s_agents_lock);
    return w;
}

bool cable_client_request_agents(void)
{
    // Shipping bridges understand agents.list. The narrower refresh is optional;
    // sending it without negotiation strands a successful tab switch at its
    // snapshot receipt until the workspace timeout.
    return send_json(msg(cable_client_supports(CABLE_FEATURE_AGENTS_REFRESH)
                         ? "agents.refresh" : "agents.list"));
}
uint32_t cable_client_agent_generation(void)
{
    if (!s_agents_lock) return 0;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    uint32_t generation = s_agents_generation;
    xSemaphoreGive(s_agents_lock);
    return generation;
}
int cable_client_list_agents(project_t *out, int max)
{
    return cable_client_list_agents_snapshot(out,max,NULL);
}
int cable_client_list_agents_snapshot(project_t *out, int max, cable_agent_snapshot_t *snapshot)
{
    if (snapshot) memset(snapshot,0,sizeof *snapshot);
    if (!out || max <= 0 || !s_agents_lock || !s_agents) return 0;
    int n = 0;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    if (s_agents_building) { xSemaphoreGive(s_agents_lock); return -1; }
    if (snapshot) {
        snprintf(snapshot->tab,sizeof snapshot->tab,"%s",s_agents_tab);
        snapshot->generation=s_agents_generation; snapshot->total=s_agents_total; snapshot->window=s_has_window;
    }
    for (int i = 0; i < s_agent_count && n < max; i++) {
        memset(&out[n], 0, sizeof(out[n]));
        snprintf(out[n].id, sizeof(out[n].id), "%s", s_agents[i].id);
        snprintf(out[n].name, sizeof(out[n].name), "%s", s_agents[i].name);
        snprintf(out[n].engine, sizeof(out[n].engine), "%s", s_agents[i].engine);
        snprintf(out[n].machine_id, sizeof(out[n].machine_id), "%s", s_agents[i].machine_id);
        snprintf(out[n].machine, sizeof(out[n].machine), "%s", s_agents[i].machine);

        // The [mark][Model][Effort] chip row reads ONE shape — the opaque runtime-v1 profile — so the
        // daemon's plain model/effort are assembled into it here rather than teaching the UI a second
        // format. A model with no effort axis gets "auto", which the chip hides.
        if (s_agents[i].model[0]) {
            snprintf(out[n].selected_model, sizeof(out[n].selected_model), "runtime-v1:%s:%s:%s@%s",
                     s_agents[i].id, s_agents[i].engine[0] ? s_agents[i].engine : "claude",
                     s_agents[i].model, s_agents[i].effort[0] ? s_agents[i].effort : "auto");
        }
        n++;
    }
    xSemaphoreGive(s_agents_lock);
    return n;
}

// ── inbound ─────────────────────────────────────────────────────────────────────────────────────────

static const char *str_of(const cJSON *o, const char *key)
{
    const cJSON *v = o ? cJSON_GetObjectItemCaseSensitive(o, key) : NULL;
    return cJSON_IsString(v) && v->valuestring ? v->valuestring : NULL;
}

// `swarms`: the whole list, replaced on arrival. Rows missing an id are dropped; a name is optional
// (the window's default is "New swarm", but a blank one still has to be a row that can be picked).
static void handle_swarms(const cJSON *p)
{
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p, "items");
    if (!cJSON_IsArray(items)) return;
    static cable_swarm_t rows[SWARMS_MAX];   // static: 24 × ~96 B is too much for the reader task's stack
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
        if (n >= SWARMS_MAX) break;
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(it, "id");
        if (!cJSON_IsString(id) || !id->valuestring[0] ||
            strlen(id->valuestring) >= sizeof rows[n].id) continue;
        bool duplicate = false;
        for (int i = 0; i < n; i++) if (!strcmp(rows[i].id, id->valuestring)) duplicate = true;
        if (duplicate) continue;
        snprintf(rows[n].id, sizeof(rows[n].id), "%s", id->valuestring);
        const cJSON *name = cJSON_GetObjectItemCaseSensitive(it, "name");
        snprintf(rows[n].name, sizeof(rows[n].name), "%s", cJSON_IsString(name) ? name->valuestring : "");
        const cJSON *agents = cJSON_GetObjectItemCaseSensitive(it, "agents");
        rows[n].agents = cJSON_IsNumber(agents) && agents->valueint > 0 ? agents->valueint : 0;
        // Absent from an older daemon: fall back to the agent count, which is what this row meant
        // before tiles were counted separately.
        const cJSON *panes = cJSON_GetObjectItemCaseSensitive(it, "panes");
        rows[n].panes = cJSON_IsNumber(panes) ? (panes->valueint > 0 ? panes->valueint : 0) : rows[n].agents;
        n++;
    }
    const char *selected = str_of(p, "selected");
    if (selected && strlen(selected) >= ID_MAX) selected = NULL;
    ui_swarms_replace(rows, n, selected);

/* …and the selected tab's shape, which rides the same frame so the two can never be read half
 * updated: a grid drawn against the previous tab's rectangles puts agents where they are not.
 *
 * THE ROUND DIAL IS THE ONLY BUILD THAT SKIPS THIS. A spatial desk needs corners: habitat on the dial
 * shows its panes as a list of rows and has no use for a rectangle, while habitat on the Pro draws the
 * app's own shape and needs every one of them. */
}

static void session_up(const cJSON *p)
{
    atomic_store(&s_features, cable_features_parse(p));
    const char *app = str_of(p, "app");
    const cJSON *machine = p ? cJSON_GetObjectItemCaseSensitive(p, "machine") : NULL;
    const char *name = str_of(machine, "name");
    snprintf(s_machine_name, sizeof(s_machine_name), "%s", name ? name : "Machine");
    // The CABLED computer's identity, and what `local` is judged against. Proto 1 put the dial's own MAC
    // here, which named nothing anyone could select.
    const char *mid = str_of(machine, "id");
    if (mid) snprintf(s_machine_id, sizeof(s_machine_id), "%s", mid);
    // Stated in `welcome` so the ✓ is right from the first frame — before any list arrives, which matters
    // after a dial reboot that lands mid-session on a machine that is not this one.
    const char *selected = str_of(p, "selected");
    ui_set_selected_machine(selected && selected[0] ? selected : s_machine_id);

    const bool was = s_session;
    s_session = true;
    ui_set_connected(true);
    if (!was) {
        // Route the log through the link only once a peer is listening. Unplugged — or plugged into a
        // machine with no daemon — the port stays an ordinary console and `idf.py monitor` behaves as it
        // always has. That is the only debugging instrument this single-port board has.
        cable_link_set_log_framing(true);
        ESP_LOGI(TAG, "session up: %s (%s, proto %d)", s_machine_name, app ? app : "daemon",
                 (cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(p, "proto"))
                           ? cJSON_GetObjectItemCaseSensitive(p, "proto")->valueint
                           : 0));
        // ASK FOR BOTH, EXPLICITLY. A rebooted dial greets with the same mac and the same firmware, so
        // the daemon's re-attach test reads that greeting as a keepalive and pushes nothing at all — the
        // dial would sit on an empty carousel opposite a daemon convinced it had already spoken.
        send_json(msg("machines.list"));
        send_json(msg("agents.list"));
        // Now that someone is listening: why this boot happened, and what was said before it if the
        // answer is a crash. Framed like every other line, so it lands in the same file.
        last_words_report();
    }
}

static void pet_forget_transfer(void);
static void session_down(const char *why)
{
    if (!s_session) return;
    s_session = false;
    atomic_store(&s_features, 0);

    // FORGET THE AGENTS. They belonged to a daemon that is no longer there, and a tile is not a memory —
    // it is a claim that something is running on the other end of this cable right now. Keeping the list
    // up leaves the dial showing agents from whichever computer it was last plugged into, which reads as
    // working rather than as disconnected: the "Not connected" badge is one line of text against a full
    // carousel that says otherwise, and the carousel wins.
    if (s_agents_lock) {
        xSemaphoreTake(s_agents_lock, portMAX_DELAY);
        s_agent_count = 0;
        s_agents_total = 0; s_has_window = false;
        s_agents_tab[0] = 0; s_agents_generation++;
        s_agents_building = false;
        xSemaphoreGive(s_agents_lock);
        ui_request_agent_reload();   // refresh_task reconciles the now-empty list → the tiles go
    }
    // FORGET THE MACHINES, for the same reason. A row is a claim that a computer is reachable right now,
    // and with the cable gone nothing on this side can vouch for any of them. `s_selected_machine` is left
    // alone deliberately: a session that comes back on the same computer should land where it was.
    cable_machines_clear(&s_machines);
    ui_machines_clear();
    s_machine_name[0] = '\0';
    s_machine_id[0] = '\0';
    // Restore the plain console FIRST: whatever follows this point should be readable by a developer with
    // a serial monitor, which is exactly the situation a dropped session puts them in.
    cable_link_set_log_framing(false);
    fw_update_abort("session down");   // no more slices are coming; the running image is untouched
    pet_forget_transfer();             // likewise a half-received pet pack; the held packs stay
    ESP_LOGI(TAG, "session down (%s)", why);
    ui_set_connected(false);
}

static void handle_agent(const cJSON *p)
{
    const char *id = str_of(p, "id");
    if (!id || !id[0] || strlen(id) >= ID_MAX || !s_agents || !s_agents_lock) return;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    if (s_agents_building && s_agent_count < CABLE_MAX_AGENTS) {
        // IDs are opaque routing targets. Truncation or duplicate rows can
        // make a displayed name refer to a different pane when it is tapped.
        for (int i = 0; i < s_agent_count; i++) if (!strcmp(s_agents[i].id, id)) {
            xSemaphoreGive(s_agents_lock); return;
        }
        cable_agent_t *a = &s_agents[s_agent_count++];
        memset(a, 0, sizeof(*a));
        snprintf(a->id, sizeof(a->id), "%s", id);
        const char *name = str_of(p, "name");
        snprintf(a->name, sizeof(a->name), "%s", name && name[0] ? name : id);
        const char *engine = str_of(p, "engine");
        if (engine) snprintf(a->engine, sizeof(a->engine), "%s", engine);
        const char *model = str_of(p, "model");
        if (model && strlen(model) < sizeof a->model) snprintf(a->model, sizeof(a->model), "%s", model);
        const char *effort = str_of(p, "effort");
        if (effort && strlen(effort) < sizeof a->effort) snprintf(a->effort, sizeof(a->effort), "%s", effort);
        const char *machine_id = str_of(p, "machineId");
        if (machine_id && strlen(machine_id) < sizeof a->machine_id)
            snprintf(a->machine_id, sizeof(a->machine_id), "%s", machine_id);
        const char *machine = str_of(p, "machine");
        if (machine) snprintf(a->machine, sizeof(a->machine), "%s", machine);

    }
    xSemaphoreGive(s_agents_lock);
}

// The list arrives STREAMED — begin, one message per agent, end — not as one array.
//
// A frame is capped at CABLE_MAX_PAYLOAD, and a hundred agents do not fit in it. One agent per message
// needs no chunk arithmetic and no reassembly, and bounds the message length by construction rather than
// by hoping the names stay short.
static void handle_agents_begin(void)
{
    if (!s_agents_lock) return;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    s_agent_count = 0;
    s_agents_building = true;
    xSemaphoreGive(s_agents_lock);
}

static void handle_agents_end(const cJSON *p)
{
    if (!s_agents_lock) return;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    s_agents_building = false;
    const int n = s_agent_count;
    // The list is the window's active tab. Beside it: how many agents the account has in all (the
    // overview prints that, never the rows), and which tab this is — "" means no window, which is how an
    // empty list reads as "the app is shut" rather than "this tab is empty".
    const cJSON *total = p ? cJSON_GetObjectItemCaseSensitive(p, "total") : NULL;
    const char *tab = p ? str_of(p, "tab") : NULL;
    s_agents_total = cJSON_IsNumber(total) ? (total->valueint > 0 ? total->valueint : 0) : n;
    s_has_window = tab && tab[0];
    snprintf(s_agents_tab,sizeof s_agents_tab,"%s",tab ? tab : "");
    s_agents_generation++;
    xSemaphoreGive(s_agents_lock);
    ESP_LOGI(TAG, "agents: %d of %d%s", n, s_agents_total, s_has_window ? "" : " (no window)");
    // app_main's refresh reads the list and rebuilds the tiles. Going through the same request the
    // backend path used means the carousel's landing, naming and removal logic has one implementation.
    ui_request_agent_reload();
}

// ── the machine wheel ───────────────────────────────────────────────────────────────────────────────
// Streamed begin / one row / end, exactly like the agent list and for the same reason: a frame is capped
// at CABLE_MAX_PAYLOAD and the length is bounded by construction rather than by hoping names stay short.
//
// Everything here runs on the USB READER TASK, so the rule is: decide first, touch the UI second. The
// gate in cable_machines_end() is what makes an unchanged list cost a comparison instead of a rebuild.

static bool bool_of(const cJSON *o, const char *key)
{
    return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(o, key));
}

static void stage_machine(const cJSON *p, const char *id)
{
    if (!cable_machines_add(&s_machines, id, str_of(p, "name"), str_of(p, "state"),
                            bool_of(p, "local"))) {
        // Worth a line: a dropped row means the two halves disagree about the caps, and the symptom on
        // screen is a machine that simply is not there.
        ESP_LOGW(TAG, "machine row dropped: %s", id ? id : "(no id)");
    }
}

static void apply_machines(const char *selected)
{
    // ONE call, one lock, one rebuild — and only when something actually changed.
    ui_machines_replace(s_machines.rows, s_machines.count, selected, s_machines.applied_selected);
}

static void handle_machines_end(const cJSON *p)
{
    const char *selected = str_of(p, "selected");
    const char *source = str_of(p, "source");
    // `source` explains a short list. It is not decoration: one row with no explanation reads as "you own
    // one machine", when the truth may be "this daemon is signed out" or "the backend is unreachable".
    ui_machines_source(source ? source : "backend");
    if (!cable_machines_end(&s_machines, selected)) return;   // identical — no lock, no rebuild
    ESP_LOGI(TAG, "machines: %d (%s)", s_machines.count, source ? source : "?");
    apply_machines(selected);
}

static void handle_machine_updated(const cJSON *p)
{
    const char *id = str_of(p, "id");
    if (!cable_machines_update(&s_machines, id, str_of(p, "name"), str_of(p, "state"),
                               bool_of(p, "local"))) return;
    ESP_LOGI(TAG, "machine.updated %s", id);
    const cable_machine_t *row = cable_machines_find(&s_machines, id);
    if (row) ui_machines_replace_one(row, s_machines.applied_selected);
}

static void handle_notifications(const cJSON *p)
{
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p, "items");
    if (!cJSON_IsArray(items)) return;
    static cable_notif_t rows[8];   // static: too much for the reader task's stack
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
        if (n >= (int)(sizeof(rows) / sizeof(rows[0]))) break;
        const char *aid = str_of(it, "agentId");
        if (!aid || !aid[0] || strlen(aid) >= sizeof rows[n].agent_id) continue;
        bool duplicate = false;
        for (int i = 0; i < n; i++) if (!strcmp(rows[i].agent_id, aid)) duplicate = true;
        if (duplicate) continue;
        memset(&rows[n], 0, sizeof(rows[n]));
        snprintf(rows[n].agent_id, sizeof(rows[n].agent_id), "%s", aid);
        snprintf(rows[n].name, sizeof(rows[n].name), "%s", str_of(it, "name") ? str_of(it, "name") : "");
        snprintf(rows[n].machine, sizeof(rows[n].machine), "%s", str_of(it, "machine") ? str_of(it, "machine") : "");
        snprintf(rows[n].summary, sizeof(rows[n].summary), "%s", str_of(it, "summary") ? str_of(it, "summary") : "");
        rows[n].question = bool_of(it, "question");
        rows[n].failed = bool_of(it, "failed");
        const char *token = str_of(it, "readToken");
        if (token && token[0] && strlen(token) < sizeof rows[n].read_token)
            snprintf(rows[n].read_token, sizeof rows[n].read_token, "%s", token);
        n++;
    }
    ui_notif_replace(rows, n);
}

// ── custom pets ─────────────────────────────────────────────────────────────────────────────────────
// A pack arrives as CABLE_TYPE_PET slices on the reader task, like firmware: each slice is acknowledged with
// `pet.progress`, which is what opens the daemon's credit window (docs/specs/cable-protocol.md §7).

static char     s_pet_id[17];
static uint32_t s_pet_size, s_pet_written;   // reader task only

static void pet_reply(const char *t, const char *id, const char *reason)
{
    cJSON *root = msg(t);
    if (!root) return;
    msg_string(&root, "id", id ? id : "");
    if (reason) msg_string(&root, "reason", reason);
    send_json(root);
}

static void pet_forget_transfer(void)
{
    s_pet_id[0] = 0;
    s_pet_size = s_pet_written = 0;
    pet_store_abort();
}

static void handle_pet_offer(const cJSON *p)
{
    const char *id = str_of(p, "id");
    const cJSON *size = cJSON_GetObjectItemCaseSensitive(p, "size");
    const cJSON *crc = cJSON_GetObjectItemCaseSensitive(p, "crc");
    if (!id || strlen(id) != 16) {
        pet_reply("pet.error", id, "shape");
        return;
    }
    if (!cJSON_IsNumber(size) || !cJSON_IsNumber(crc) || size->valuedouble <= 22 || size->valuedouble > PET_STORE_MAX_BYTES ||
        crc->valuedouble < 0 || crc->valuedouble > 4294967295.0) {
        pet_reply("pet.error", id, "shape");
        return;
    }
    pet_forget_transfer();
    if (!pet_store_offer(id, (uint32_t)size->valuedouble, (uint32_t)crc->valuedouble)) {
        // Four other packs held is `busy` (the daemon drops one and offers again); anything else is memory.
        char held[PET_STORE_MAX_PACKS][17];
        const size_t n = pet_store_held(held, PET_STORE_MAX_PACKS);
        bool same = false;
        for (size_t i = 0; i < n; i++) if (!strcmp(held[i], id)) same = true;
        bool hex = true;
        for (int i = 0; i < 16; i++) if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) hex = false;
        pet_reply("pet.error", id, !hex ? "shape" : n >= PET_STORE_MAX_PACKS && !same ? "busy" : "memory");
        return;
    }
    memcpy(s_pet_id, id, sizeof(s_pet_id) - 1);
    s_pet_id[16] = 0;
    s_pet_size = (uint32_t)size->valuedouble;
    s_pet_written = 0;
    pet_reply("pet.accept", id, NULL);
}

static void handle_pet_slice(const uint8_t *data, size_t len)
{
    if (!s_pet_id[0] || len == 0) return;
    if (!pet_store_slice(data, len)) {
        // The only way a slice fails with an offer open is more bytes than were offered: a shape error.
        pet_reply("pet.error", s_pet_id, "shape");
        pet_forget_transfer();
        return;
    }
    s_pet_written += (uint32_t)len;
    cJSON *root = msg("pet.progress");
    if (root) {
        msg_string(&root, "id", s_pet_id);
        msg_number(&root, "written", (double)s_pet_written);
        send_json(root);
    }
    if (s_pet_written < s_pet_size) return;
    const int err = pet_store_finish();
    if (err == 0) { pet_reply("pet.done", s_pet_id, NULL); ui_pets_changed(); }
    else pet_reply("pet.error", s_pet_id, err == PET_ERR_CRC ? "crc" : err == PET_ERR_VERSION ? "version" : "shape");
    s_pet_id[0] = 0;
    s_pet_size = s_pet_written = 0;
}

static void handle_pet_map(const cJSON *p)
{
    const char *all = str_of(p, "all");
    const char *engines[8], *ids[8];
    size_t n = 0;
    const cJSON *map = cJSON_GetObjectItemCaseSensitive(p, "engines");
    const cJSON *e;
    cJSON_ArrayForEach(e, map) {
        if (n >= 8) break;
        if (!cJSON_IsString(e) || !e->string || !e->valuestring) continue;
        engines[n] = e->string;
        ids[n++] = e->valuestring;
    }
    pet_store_map(all, engines, ids, n);
    ui_pets_changed();
}

static void handle_message(const cJSON *root)
{
    const char *t = str_of(root, "t");
    if (!t) { s_bad++; return; }
    const cJSON *p = cJSON_GetObjectItemCaseSensitive(root, "p");
    if (!p) p = root;   // flat messages are legal; `p` is a convenience, not a requirement

    if (strcmp(t, "welcome") == 0) { session_up(p); return; }
    if (strcmp(t, "ping") == 0) { send_json(msg("pong")); return; }
    if (strcmp(t, "agents.begin") == 0) { handle_agents_begin(); return; }
    if (strcmp(t, "agent") == 0) { handle_agent(p); return; }
    if (strcmp(t, "agents.end") == 0) { handle_agents_end(p); return; }
    if (strcmp(t, "machines.begin") == 0) { cable_machines_begin(&s_machines); return; }
    if (strcmp(t, "machine") == 0) { stage_machine(p, str_of(p, "id")); return; }
    if (strcmp(t, "machines.end") == 0) { handle_machines_end(p); return; }
    if (strcmp(t, "machine.updated") == 0) { handle_machine_updated(p); return; }
    if (strcmp(t, "machine.selected") == 0) {
        // The ONLY writer of the selection. A tap marks a row pending and waits for this — an optimistic
        // write is how the ✓, the Overview eyebrow and the voice gate end up disagreeing after a refusal.
        ui_machine_selected_ack(str_of(p, "machineId"));
        return;
    }
    if (strcmp(t, "machine.error") == 0) {
        // The daemon owns the code set, so its `message` is shown verbatim rather than mapped through a
        // table here that would go stale the first time a code is added at the other end.
        ui_machine_select_error(str_of(p, "machineId"), str_of(p, "code"), str_of(p, "message"));
        return;
    }
    if (strcmp(t, "companion.set") == 0) { handle_companion_set(p); return; }
    if (strcmp(t, "companion.celebrate") == 0) { handle_companion_celebrate(p); return; }
    if (strcmp(t, "settings.set") == 0) { handle_settings_set(p); return; }
    if (strcmp(t, "models") == 0) { handle_models(p); return; }
    if (strcmp(t, "swarms") == 0) { handle_swarms(p); return; }

    if (strcmp(t, "agent.updated") == 0) {
        // One agent changed. Cheapest correct answer is to re-ask: the daemon is on the other end of a
        // cable, and a full list is a few hundred bytes.
        send_json(msg("agents.list"));
        return;
    }

    const char *agent_id = str_of(p, "agentId");
    // A late focus, completion or voice reply must not turn an oversized
    // identity into another pane through a bounded UI copy.
    if (agent_id && strnlen(agent_id, ID_MAX) >= ID_MAX) { s_bad++; return; }

    if (strcmp(t, "focus") == 0) {
        // The daemon's surface moved. Follow it, so the two screens are one desk.
        if (agent_id) ui_focus_project(agent_id);
        return;
    }
    // One line per turn-state message. This is the seam where "the daemon sent it" and "the tile moved"
    // stop being the same question, and it cost an afternoon of guessing to notice that nothing here said
    // which of the two had failed.
    if (strncmp(t, "turn.", 5) == 0 || strcmp(t, "summary") == 0) {
        ESP_LOGI(TAG, "%s %s", t, agent_id ? agent_id : "(no agentId)");
    }
    if (strcmp(t, "turn.started") == 0) {
        // The TEXT is the status line the tile draws — "Working…", the tool that is running, what the turn
        // is waiting on. Dropping it left the tile holding a live turn with nothing on screen that said so,
        // which reads exactly like the turn never started.
        const char *text = str_of(p, "text");
        if (agent_id) ui_project_emit(agent_id, "", "processing", text ? text : "", NULL);
        return;
    }
    if (strcmp(t, "turn.activity") == 0) {
        if (agent_id) ui_project_emit(agent_id, "", "activity", str_of(p, "text"), NULL);
        return;
    }
    if (strcmp(t, "turn.done") == 0) {
        // `done` stops the spinner and deliberately does NOT ring: a turn's completion is announced by
        // the summary that follows, which is the thing a person can act on. Ringing here as well is how
        // an empty turn produced a beep and a blank notification.
        if (agent_id) ui_project_emit(agent_id, "", "done", "", NULL);
        return;
    }
    if (strcmp(t, "summary") == 0) {
        if (!agent_id) return;
        // TWO DOORS, and which one matters more than it looks. A summary the daemon sends unasked marks a
        // turn that JUST finished: it rings, badges and wakes the screen. One sent while reattaching is
        // history being filled back in — the daemon had it on disk the whole time — and taking that door
        // would make plugging the cable in announce every turn that finished while it was unplugged.
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "restore"))) {
            ui_project_restore_event(agent_id, "summary", str_of(p, "text"), str_of(p, "recap"));
            return;
        }
        ui_project_emit(agent_id, "", "summary", str_of(p, "text"), str_of(p, "recap"));
        // The beep and the notification both hang off the SUMMARY, never the bare `done`. A real turn
        // emits done THEN summary; an empty or phantom turn emits only done — so a session that briefly
        // registers and vanishes stays silent, and the notification always carries a real recap.
        //
        // These two lines lived in commander_client.c and went out with it. Nothing else calls them, so
        // for a day the dial updated its tile in complete silence: no beep, no wake, nothing in the
        // drawer — the one part of a finished turn a person is not looking at the screen for.
        //
        // A SUB-AGENT'S turn (`silent`, decided by the daemon: an Orchestrator specialist, or its
        // Director while specialists are still out) is not news at all — the tile above is redrawn and
        // that is the whole of it. A project of four specialists used to ring eight times before the one
        // ring that mattered (owner, 2026-09-21: "chỉ cần báo thằng main thôi"). Absent = false, so an
        // older daemon rings exactly as before.
        if (bool_of(p, "silent")) return;
        // THE BEEP ALWAYS SOUNDS. A finished turn is news even when the person is looking straight at
        // it: they are reading the last one, not watching for the next to end, and three tones is how
        // they learn a task is done without moving their eyes.
        audio_notify_done();
        // The NOTIFICATION is what gets withheld. It exists to reach someone who is not looking —
        // waking a dark panel, filing an entry in the drawer — and `quiet` is the daemon saying the
        // desktop window already has this agent on screen. The tile itself is still redrawn above: the
        // recap is what it draws, and a stale tile is a worse lie than a missing badge.
        //
        // The other half of "already looking" is decided inside ui_notify_task_done(), which skips its
        // own work when the dial is awake, on the carousel, and centred on this very agent.
        //
        // Absent field = false, so a daemon that predates this notifies exactly as it always did.
        //
        // WHO IT IS ABOUT rides on the frame. The dial holds one tab's agents, and this turn may have
        // finished on any of them; the drawer row for one off this tab has nobody else to ask.
        if (!bool_of(p, "quiet")) {
            ui_notify_task_done(agent_id, str_of(p, "name"), str_of(p, "machine"), str_of(p, "recap"));
        }
        return;
    }
    // The WINDOW looked at this agent — its drawer row here is stale. The tap's half of this pair
    // already goes the other way (cable_client_send_open); without the return leg the pill and the
    // window's badge stop agreeing the first time somebody switches to the tab a card was about.
    // The window's whole unread list, replayed because this dial has just attached and its drawer is
    // empty — see ui_notif_replace.
    if (strcmp(t, "notif.replace") == 0) { handle_notifications(p); return; }
    if (strcmp(t, "notif.seen") == 0) {
        const cJSON *token = cJSON_GetObjectItemCaseSensitive(p, "readToken");
        if (agent_id && token) {
            if (cJSON_IsString(token) && token->valuestring[0] &&
                strlen(token->valuestring) < CABLE_READ_TOKEN_MAX)
                ui_notif_read(agent_id, token->valuestring);
        } else if (agent_id) ui_notif_seen(agent_id);
        return;
    }
    if (strcmp(t, "turn.error") == 0) {
        if (agent_id) ui_project_emit(agent_id, "", "done", "", NULL);
        ui_cable_toast(str_of(p, "message"));
        return;
    }
    if (strcmp(t,"question.state")==0) { ui_question_state(p); return; }
    if (strcmp(t,"answer.receipt")==0) { ui_answer_receipt(p); return; }
    if (strcmp(t, "question") == 0) {
        const cJSON *questions = cJSON_GetObjectItemCaseSensitive(p, "questions");
        // The name rides on the frame for the same reason as on `summary`: the asker may be off this tab.
        if (agent_id && questions) ui_question_show(agent_id, str_of(p, "name"), str_of(p, "machine"), str_of(p, "id"), questions);
        return;
    }
    // Somebody else answered it. A question is a dialog in a tmux pane, not a shared object, so this is
    // the ONLY way the dial learns that the thing it is waiting on has already been dealt with — without
    // it the screen sits there offering options that no longer key into anything.
    if (strcmp(t, "question.close") == 0) {
        if (agent_id) ui_question_close(agent_id, str_of(p, "id"));
        return;
    }

    if (strcmp(t,"draft.state")==0) { ui_draft_state(p);return; }
    if (strcmp(t,"voice.draft")==0) {
        const char *upload_id=str_of(p,"uploadId");
        if (!upload_id || !audio_client_upload_matches(upload_id)) return;
        ui_voice_draft(p);return;
    }
    if (strcmp(t, "voice.question") == 0) {
        const char *upload_id = str_of(p, "uploadId");
        if (!upload_id || !audio_client_upload_matches(upload_id)) return;
        ui_voice_question(p);
        return;
    }
    if (strcmp(t, "voice.search") == 0) {
        const cJSON *upload = cJSON_GetObjectItemCaseSensitive(p, "uploadId");
        if (!cJSON_IsString(upload) || !audio_client_upload_matches(upload->valuestring)) return;
        ui_voice_search(p); return;
    }
    if (strcmp(t, "voice.form") == 0) {
        const char *upload_id = str_of(p, "uploadId");
        if (!upload_id || !audio_client_upload_matches(upload_id)) return;
        ui_voice_form(p);
        return;
    }
    if (strcmp(t, "voice.transcript") == 0) {
        const char *upload_id = str_of(p, "uploadId");
        if (upload_id && !audio_client_upload_matches(upload_id)) return;
        const cJSON *conf = cJSON_GetObjectItemCaseSensitive(p, "confidence");
        const bool needs_confirm = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "needsConfirm"));
        ui_voice_routed(!needs_confirm, agent_id == NULL, str_of(p, "routeId"), agent_id,
                        str_of(p, "agentName"), cJSON_IsNumber(conf) ? conf->valuedouble : 1.0);
        return;
    }
    if (strcmp(t, "voice.error") == 0) {
        const char *upload_id = str_of(p, "uploadId");
        if (upload_id && !audio_client_upload_matches(upload_id)) return;
        ui_voice_error(str_of(p, "message"));
        return;
    }
    if (strcmp(t, "selection.state") == 0) { ui_selection_state(p); return; }
    if (strcmp(t, "carry.state") == 0) { ui_carry_state(p); return; }
    if (strcmp(t, "form.state") == 0) { ui_form_state(p); return; }
    if (strcmp(t, "visit.state") == 0) { ui_visit_state(p); return; }
    if (strcmp(t, "toast") == 0) { ui_cable_toast(str_of(p, "text")); return; }
    if (strcmp(t, "fw.offer") == 0) {
        const cJSON *size = cJSON_GetObjectItemCaseSensitive(p, "size");
        // Declining is silence: fw_update_offer() answers with `fw.accept` only when it is willing, and
        // the daemon offers again on the next hello.
        fw_update_offer(str_of(p, "version"),
                        cJSON_IsNumber(size) && size->valuedouble == size->valueint ? size->valueint : 0,
                        str_of(p, "sha256"));
        return;
    }

    if (strcmp(t, "pet.map") == 0) { handle_pet_map(p); return; }
    if (strcmp(t, "pet.offer") == 0) { handle_pet_offer(p); return; }
    if (strcmp(t, "pet.drop") == 0) {
        const char *did = str_of(p, "id");
        if (did && !strcmp(did, s_pet_id)) pet_forget_transfer();   // an in-flight id: the daemon abandoned it
        pet_store_drop(did);
        ui_pets_changed();
        return;
    }

    // A message this build has no case for. Counted, never fatal: it means a daemon running ahead of this
    // firmware, which is a version mismatch someone can act on rather than a fault.
    s_unknown++;
    ESP_LOGD(TAG, "unhandled message '%s'", t);
}

static void on_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t payload_len, void *ctx)
{
    (void)version;
    (void)ctx;
    if (type == CABLE_TYPE_FW) {
        s_last_rx_us = esp_timer_get_time();
        // Straight to flash, on this task. That is deliberate and it is what the credit window is sized
        // against: the write blocks the reader for ~16 ms per slice, and nothing drains the port
        // meanwhile — see docs/specs/cable-protocol.md §7.
        fw_update_slice(payload, payload_len);
        return;
    }
    if (type == CABLE_TYPE_PET) {
        s_last_rx_us = esp_timer_get_time();
        handle_pet_slice(payload, payload_len);
        return;
    }
    if (type != CABLE_TYPE_JSON) {
        // PCM travels the other way; anything else is a peer that knows a payload kind this build does not.
        s_unknown++;
        return;
    }

    // Parse directly from the bounded frame. cJSON owns its decoded strings;
    // none of the tree retains this buffer after the callback returns.
    if (!cable_json_guard(payload, payload_len)) { s_bad++; return; }
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts((const char *)payload, payload_len, &end, false);
    if (root) {
        const char *limit = (const char *)payload + payload_len;
        while (end < limit && (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r')) end++;
        if (end != limit || !cJSON_IsObject(root)) { cJSON_Delete(root); root = NULL; }
    }
    if (!root) { s_bad++; return; }
    s_last_rx_us = esp_timer_get_time();
    handle_message(root);
    cJSON_Delete(root);
}

// ── session task ────────────────────────────────────────────────────────────────────────────────────

static void session_tick(void *ctx)
{
    (void)ctx;
    fw_update_tick();
    if (s_session && esp_timer_get_time() - s_last_rx_us > (int64_t)SILENCE_MS * 1000) {
        session_down("silence");
    }
}

static void session_task(void *arg)
{
    (void)arg;
    // Reserve the handshake task before exposing the reader. It must not send
    // until the USB driver is ready, and a failed start can delete it safely.
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    int64_t next_hello_us = 0;
    while (1) {
        const int64_t now = esp_timer_get_time();

        if (now >= next_hello_us) {
            send_hello();
            next_hello_us = now + (int64_t)(s_session ? HELLO_SESSION_MS : HELLO_ALONE_MS) * 1000;
        }

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

bool cable_client_start(void)
{
    if (s_started) return true;
    TaskHandle_t hello_task = NULL;
    cable_machines_init(&s_machines);
    s_agents = calloc(CABLE_MAX_AGENTS, sizeof(cable_agent_t));
    s_agents_lock = xSemaphoreCreateMutex();
    s_models_sem = xSemaphoreCreateBinary();
    if (!s_agents || !s_agents_lock || !s_models_sem) {
        ESP_LOGE(TAG, "no memory for the agent list — link disabled");
        goto failed;
    }
    s_last_rx_us = esp_timer_get_time();
    ui_set_connected(false);
    if (xTaskCreate(session_task, "cable_session", 4096, NULL, 4, &hello_task) != pdPASS) {
        ESP_LOGE(TAG, "session task create failed — no handshake");
        goto failed;
    }
    if (!cable_link_start(on_frame, session_tick, NULL)) {
        vTaskDelete(hello_task);
        goto failed;
    }
    s_started = true;
    xTaskNotifyGive(hello_task);
    ESP_LOGI(TAG, "cable client started (fw %s, proto %d)", cable_fw_version(), CABLE_PROTO_VERSION);
    return true;
failed:
    free(s_agents); s_agents = NULL;
    if (s_agents_lock) vSemaphoreDelete(s_agents_lock);
    if (s_models_sem) vSemaphoreDelete(s_models_sem);
    s_agents_lock = s_models_sem = NULL;
    return false;
}

bool cable_client_is_connected(void) { return s_session; }

void cable_client_counters(uint32_t *bad, uint32_t *unknown)
{
    if (bad) *bad = s_bad;
    if (unknown) *unknown = s_unknown;
}
