// Host tests for the scripted demo daemon (main/demo/max_demo.c), on a fake clock.
//
// Every frame the demo sends is parsed and held to the shape the real daemon gives that message
// (cli/src/cable/cableSession.ts): its field names, their types, and nothing else. `seq` is checked from each welcome on.
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "cable/cable_frame.h"
#include "demo/max_demo.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

// ── what the demo sent ──────────────────────────────────────────────────────────────────────────────

#define SEEN_MAX 8192
static cJSON *seen[SEEN_MAX];
static uint32_t seen_at[SEEN_MAX];
static int seen_n;
static uint32_t now;
static long long next_seq = -1;   // the seq the next frame must carry; -1: frames carry none
static size_t tick_bytes, tick_frames;
// The device answers every ping with a pong, as the firmware does; the silence test turns that off.
static bool answer_pings = true, pinged;

static void forget(void)
{
    for (int i = 0; i < seen_n; i++) cJSON_Delete(seen[i]);
    seen_n = 0;
}

static const char *s_of(const cJSON *o, const char *k)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}
static double n_of(const cJSON *o, const char *k)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
    return cJSON_IsNumber(v) ? v->valuedouble : -1e18;
}
static bool b_of(const cJSON *o, const char *k) { return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(o, k)); }
static bool has(const cJSON *o, const char *k) { return cJSON_GetObjectItemCaseSensitive(o, k) != NULL; }
static bool eq(const char *a, const char *b) { return a && b && !strcmp(a, b); }

// ── the daemon's shapes ─────────────────────────────────────────────────────────────────────────────
// One line per message the demo may send: each field, its type, and whether it is required. Types: s string, n number,
// b bool, o object, a array, S array of strings. Read off cableSession.ts (and windowForm.ts, questionInbox.ts).
typedef struct { const char *key; char type; bool required; } field_t;
typedef struct { const char *t; field_t f[24]; } shape_t;

#define FORM_FIELDS {"ok", 'b', true}, {"active", 'b', true}, {"title", 's', false}, {"label", 's', false}, \
    {"detail", 's', false}, {"previous", 's', false}, {"next", 's', false}, {"error", 's', false}, {"status", 's', false}, \
    {"action", 's', false}, {"query", 's', false}, {"revision", 'n', false}, {"position", 'n', false}, {"total", 'n', false}, \
    {"busy", 'b', false}, {"enabled", 'b', false}, {"canQuery", 'b', false}, {"queryId", 's', false}

static const shape_t SHAPES[] = {
    {"welcome", {{"proto", 'n', true}, {"app", 's', true}, {"machine", 'o', true}, {"selected", 's', true},
                 {"voiceLang", 's', true}, {"features", 'S', true}}},
    {"ping", {{0}}},
    {"machines.begin", {{0}}},
    {"machine", {{"id", 's', true}, {"name", 's', true}, {"state", 's', true}, {"local", 'b', true}}},
    {"machines.end", {{"selected", 's', true}, {"source", 's', true}}},
    {"machine.selected", {{"machineId", 's', true}}},
    {"machine.error", {{"machineId", 's', true}, {"code", 's', true}, {"message", 's', true}}},
    {"swarms", {{"selected", 's', true}, {"items", 'a', true}, {"tiles", 'a', true}}},
    {"agents.begin", {{0}}},
    {"agent", {{"id", 's', true}, {"name", 's', true}, {"engine", 's', true}, {"model", 's', true}, {"effort", 's', true},
               {"machineId", 's', true}, {"machine", 's', true}, {"host", 's', false}, {"caps", 's', false}}},
    {"agents.end", {{"total", 'n', true}, {"tab", 's', true}, {"view", 's', false}}},
    {"player.library", {{"request", 'n', true}, {"offset", 'n', true}, {"total", 'n', true}, {"rows", 'a', true},
                        {"machines", 'n', true}}},
    {"focus", {{"agentId", 's', true}}},
    {"turn.started", {{"agentId", 's', true}, {"text", 's', true}}},
    {"turn.activity", {{"agentId", 's', true}, {"text", 's', true}, {"action", 's', false}, {"elapsedSeconds", 'n', false},
                       {"step", 's', false}}},
    {"turn.stats", {{"agentId", 's', true}, {"testsPassed", 'n', false}, {"testsFailed", 'n', false},
                    {"commits", 'n', false}, {"tokensIn", 'n', false}, {"tokensOut", 'n', false}}},
    {"turn.done", {{"agentId", 's', true}}},
    {"turn.error", {{"agentId", 's', true}, {"message", 's', true}}},
    {"summary", {{"agentId", 's', true}, {"name", 's', false}, {"engine", 's', false}, {"machine", 's', false},
                 {"recap", 's', true}, {"text", 's', true}, {"full", 's', false}, {"tier", 's', false},
                 {"quiet", 'b', false}, {"silent", 'b', false}, {"restore", 'b', false}}},
    {"notif.replace", {{"items", 'a', true}}},
    {"notif.seen", {{"agentId", 's', true}, {"readToken", 's', false}}},
    {"question", {{"agentId", 's', true}, {"name", 's', true}, {"engine", 's', true}, {"machine", 's', true},
                  {"id", 's', true}, {"questions", 'a', true}, {"permission", 'b', false}}},
    {"question.close", {{"agentId", 's', true}, {"id", 's', true}}},
    {"question.state", {{"agentId", 's', true}, {"requestId", 's', true}, {"name", 's', true}, {"engine", 's', true},
                        {"machine", 's', true}, {"ok", 'b', true}, {"id", 's', false}, {"token", 's', false},
                        {"questions", 'a', false}, {"submitted", 'b', false}, {"error", 's', false}}},
    {"answer.receipt", {{"agentId", 's', true}, {"token", 's', true}, {"requestId", 's', true}, {"ok", 'b', true},
                        {"pending", 'b', false}, {"error", 's', false}}},
    {"voice.transcript", {{"routeId", 's', true}, {"text", 's', true}, {"agentId", 's', true}, {"agentName", 's', true},
                          {"needsConfirm", 'b', true}, {"uploadId", 's', false}}},
    {"voice.error", {{"message", 's', true}, {"uploadId", 's', false}}},
    {"voice.form", {{"formId", 's', true}, {"uploadId", 's', false}, FORM_FIELDS}},
    {"form.state", {{"requestId", 's', true}, {"formId", 's', true}, FORM_FIELDS}},
};

static bool typed(const cJSON *v, char type)
{
    switch (type) {
    case 's': return cJSON_IsString(v);
    case 'n': return cJSON_IsNumber(v);
    case 'b': return cJSON_IsBool(v);
    case 'o': return cJSON_IsObject(v);
    case 'a': return cJSON_IsArray(v);
    case 'S': {
        if (!cJSON_IsArray(v)) return false;
        const cJSON *e;
        cJSON_ArrayForEach(e, v) if (!cJSON_IsString(e)) return false;
        return true;
    }
    }
    return false;
}

// The nested rows the daemon sends, by their own shapes.
static void check_row(const cJSON *row, const field_t *f)
{
    CHECK(cJSON_IsObject(row));
    const cJSON *kid;
    cJSON_ArrayForEach(kid, row) {
        bool known = false;
        for (const field_t *x = f; x->key; x++) if (!strcmp(x->key, kid->string)) { known = true; CHECK(typed(kid, x->type)); }
        if (!known) fprintf(stderr, "unknown row field '%s'\n", kid->string);
        CHECK(known);
    }
    for (const field_t *x = f; x->key; x++) if (x->required) CHECK(has(row, x->key));
}
static const field_t QUESTION_ROW[] = {{"key", 's', true}, {"q", 's', true}, {"options", 'S', true}, {"multi", 'b', true},
                                       {"canText", 'b', false}, {0}};
static const field_t LIBRARY_ROW[] = {{"id", 's', true}, {"machineId", 's', true}, {"name", 's', true},
                                      {"engine", 's', true}, {"status", 's', true}, {"ageSeconds", 'n', true}, {0}};
static const field_t NOTICE_ROW[] = {{"agentId", 's', true}, {"name", 's', true}, {"machine", 's', true},
                                     {"summary", 's', true}, {"question", 'b', true}, {"readToken", 's', false}, {0}};
static const field_t MACHINE_ID[] = {{"id", 's', true}, {"name", 's', true}, {0}};

static void check_shape(const cJSON *m)
{
    const char *t = s_of(m, "t");
    CHECK(t);
    const shape_t *shape = NULL;
    for (size_t i = 0; i < sizeof SHAPES / sizeof SHAPES[0]; i++) if (!strcmp(SHAPES[i].t, t)) shape = &SHAPES[i];
    if (!shape) fprintf(stderr, "a message the daemon never sends: '%s'\n", t);
    CHECK(shape);
    const cJSON *kid;
    cJSON_ArrayForEach(kid, m) {
        if (!strcmp(kid->string, "t")) continue;
        if (!strcmp(kid->string, "seq")) { CHECK(cJSON_IsNumber(kid)); continue; }
        bool known = false;
        for (const field_t *f = shape->f; f->key; f++)
            if (!strcmp(f->key, kid->string)) { known = true; CHECK(typed(kid, f->type)); }
        if (!known) fprintf(stderr, "'%s' carries '%s', which the daemon never puts on it\n", t, kid->string);
        CHECK(known);
    }
    for (const field_t *f = shape->f; f->key; f++) if (f->required) CHECK(has(m, f->key));
    const cJSON *e;
    if (!strcmp(t, "welcome")) check_row(cJSON_GetObjectItemCaseSensitive(m, "machine"), MACHINE_ID);
    if (!strcmp(t, "question") || !strcmp(t, "question.state"))
        cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "questions")) check_row(e, QUESTION_ROW);
    if (!strcmp(t, "player.library")) cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "rows")) check_row(e, LIBRARY_ROW);
    if (!strcmp(t, "notif.replace")) cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "items")) check_row(e, NOTICE_ROW);
    if (!strcmp(t, "summary")) {
        const char *tier = s_of(m, "tier");
        CHECK(!tier || eq(tier, "alert") || eq(tier, "list") || eq(tier, "silent"));
        CHECK(b_of(m, "restore") ? !tier : tier != NULL);   // history carries no tier; news always does
        CHECK(b_of(m, "quiet") == eq(tier, "list"));
        CHECK(b_of(m, "silent") == eq(tier, "silent"));
    }
    if (!strcmp(t, "machine")) {
        const char *state = s_of(m, "state");
        CHECK(eq(state, "ready") || eq(state, "offline") || eq(state, "unknown") || eq(state, "needs-link"));
    }
}

static void emit(uint8_t type, const uint8_t *payload, size_t len, void *ctx)
{
    (void)ctx;
    CHECK(type == CABLE_TYPE_JSON);
    CHECK(len > 0 && len <= CABLE_MAX_PAYLOAD);
    tick_bytes += len;
    tick_frames++;
    cJSON *m = cJSON_ParseWithLength((const char *)payload, len);
    CHECK(m && cJSON_IsObject(m));
    check_shape(m);
    const char *t = s_of(m, "t");
    // The count restarts at each welcome; a welcome without one turns it off (cable.md, `seq`).
    if (!strcmp(t, "welcome")) next_seq = has(m, "seq") ? 0 : -1;
    // A ping with no count: the session went silent and ended (the daemon closes the port), so the count went with it.
    if (!strcmp(t, "ping") && !has(m, "seq")) next_seq = -1;
    if (next_seq >= 0) {
        CHECK(n_of(m, "seq") == (double)next_seq);
        next_seq++;
    } else if (strcmp(t, "ping")) {
        CHECK(!has(m, "seq"));
    }
    pinged |= !strcmp(t, "ping");
    if (seen_n < SEEN_MAX) { seen[seen_n] = m; seen_at[seen_n++] = now; }
    else cJSON_Delete(m);
}

// Run the clock to `until`, ticking whenever the demo asks to be ticked.
static void run_to(uint32_t until)
{
    while ((int32_t)(until - now) > 0) {
        uint32_t next = max_demo_next_ms(now);
        CHECK((int32_t)(next - now) >= 0 && (int32_t)(next - now) <= 1000);
        if ((int32_t)(next - until) > 0) next = until;
        if (next == now) { tick_bytes = tick_frames = 0; max_demo_tick(now, emit, NULL); }
        if (pinged && answer_pings) max_demo_receive(CABLE_TYPE_JSON, (const uint8_t *)"{\"t\":\"pong\"}", 12, now);
        pinged = false;
        if (max_demo_next_ms(now) == now) continue;   // more due at once
        now = next == now ? now + 1 : next;
    }
    max_demo_tick(now, emit, NULL);
}
static void run(uint32_t ms) { run_to(now + ms); }

static void say(const char *json)
{
    max_demo_receive(CABLE_TYPE_JSON, (const uint8_t *)json, strlen(json), now);
}
static void sayf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void sayf(const char *fmt, ...)
{
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    say(buf);
}

// The first frame of type `t` at or after index `from` (for `agentId` when given), or -1.
static int find_from(int from, const char *t, const char *agent)
{
    for (int i = from; i < seen_n; i++)
        if (eq(s_of(seen[i], "t"), t) && (!agent || eq(s_of(seen[i], "agentId"), agent))) return i;
    return -1;
}
static int find(const char *t, const char *agent) { return find_from(0, t, agent); }
static int count(const char *t, const char *agent)
{
    int n = 0;
    for (int i = 0; i < seen_n; i++) n += eq(s_of(seen[i], "t"), t) && (!agent || eq(s_of(seen[i], "agentId"), agent));
    return n;
}
// Run until a frame of type `t` (for `agent`) arrives, at most `ms`; its index.
static int wait_for(const char *t, const char *agent, uint32_t ms)
{
    const uint32_t end = now + ms;
    for (;;) {
        int at = find(t, agent);
        if (at >= 0) return at;
        if ((int32_t)(now - end) >= 0) return -1;
        run(100);
    }
}

// ── the roster, as the demo sent it ─────────────────────────────────────────────────────────────────

static char ids[16][48], names[16][48], machines_of[16][48];
static int roster_n;
static void read_roster(void)
{
    int last_begin = -1;
    for (int i = 0; i < seen_n; i++) if (eq(s_of(seen[i], "t"), "agents.begin")) last_begin = i;
    CHECK(last_begin >= 0);
    roster_n = 0;
    for (int i = last_begin + 1; i < seen_n && !eq(s_of(seen[i], "t"), "agents.end"); i++) {
        if (!eq(s_of(seen[i], "t"), "agent") || roster_n >= 16) continue;
        snprintf(ids[roster_n], sizeof ids[0], "%s", s_of(seen[i], "id"));
        snprintf(names[roster_n], sizeof names[0], "%s", s_of(seen[i], "name"));
        snprintf(machines_of[roster_n], sizeof machines_of[0], "%s", s_of(seen[i], "machine"));
        roster_n++;
    }
}
static const char *id_of(const char *name)
{
    for (int i = 0; i < roster_n; i++) if (!strcmp(names[i], name)) return ids[i];
    fprintf(stderr, "no agent named %s\n", name);
    abort();
}

#define HELLO_MAX "{\"t\":\"hello\",\"fw\":\"0.1.0\",\"product\":\"harness\",\"proto\":3,\"hw\":\"max-nano\",\"board\":\"max\"," \
    "\"swarms\":\"members-v1\",\"recap\":\"long-v1\",\"activity\":\"steps-v1\",\"stats\":\"turn-v1\",\"player\":\"library-v1\"," \
    "\"ota\":\"v1\",\"mac\":\"aa:bb:cc:dd:ee:ff\",\"settings\":{\"brightness\":80}}"

// A fresh demo with a Max greeted and the attach push read.
static void attach(void)
{
    forget();
    now = 1000;
    next_seq = -1;
    max_demo_reset(now);
    say(HELLO_MAX);
    run(50);
    read_roster();
}

// ── the tests ───────────────────────────────────────────────────────────────────────────────────────

static void test_handshake(void)
{
    forget();
    now = 5000;
    next_seq = -1;
    max_demo_reset(now);
    run(200);
    CHECK(count("welcome", NULL) == 0);   // nothing but pings before a hello
    CHECK(count("agents.begin", NULL) == 0);

    say(HELLO_MAX);
    run(50);
    // The welcome first, numbered 0, with what the daemon gives a Max hello.
    int w = find("welcome", NULL);
    CHECK(w >= 0 && n_of(seen[w], "seq") == 0);
    CHECK(n_of(seen[w], "proto") == 3);
    CHECK(eq(s_of(seen[w], "app"), "harness"));
    CHECK(eq(s_of(seen[w], "voiceLang"), "en"));
    const cJSON *machine = cJSON_GetObjectItemCaseSensitive(seen[w], "machine");
    CHECK(eq(s_of(machine, "name"), "MacBook Pro"));
    CHECK(eq(s_of(seen[w], "selected"), s_of(machine, "id")));
    static const char *const features[] = {"voice.draft", "agents.refresh", "player.library", "resync", "form", "selection",
                                           "visit", "question.review", "settings"};
    const cJSON *list = cJSON_GetObjectItemCaseSensitive(seen[w], "features");
    CHECK(cJSON_GetArraySize(list) == (int)(sizeof features / sizeof features[0]));
    for (int i = 0; i < cJSON_GetArraySize(list); i++) CHECK(eq(cJSON_GetArrayItem(list, i)->valuestring, features[i]));

    // Then the attach push, in the daemon's order: machines, tabs, agents, the library, history, the drawer.
    static const char *const order[] = {"welcome", "machines.begin", "machine", "machine", "machine", "machines.end", "swarms",
                                        "agents.begin"};
    for (size_t i = 0; i < sizeof order / sizeof order[0]; i++) CHECK(eq(s_of(seen[w + (int)i], "t"), order[i]));
    int end = find("agents.end", NULL);
    CHECK(end > w && n_of(seen[end], "total") == 5 && eq(s_of(seen[end], "tab"), "") && eq(s_of(seen[end], "view"), "machine"));
    read_roster();
    CHECK(roster_n == 5);
    // Three machines, the cabled one local; agents on each of them.
    int machine_rows = 0, locals = 0;
    for (int i = 0; i < seen_n; i++) if (eq(s_of(seen[i], "t"), "machine")) { machine_rows++; locals += b_of(seen[i], "local"); }
    CHECK(machine_rows == 3 && locals == 1);
    bool on[3] = {false, false, false};
    for (int i = 0; i < roster_n; i++) {
        on[0] |= eq(machines_of[i], "MacBook Pro");
        on[1] |= eq(machines_of[i], "Mac Studio");
        on[2] |= eq(machines_of[i], "Build server");
    }
    CHECK(on[0] && on[1] && on[2]);
    int sw = find("swarms", NULL);
    CHECK(eq(s_of(seen[sw], "selected"), "") && cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(seen[sw], "items")) == 0);
    int lib = find("player.library", NULL);
    CHECK(lib > end && n_of(seen[lib], "total") == 5 && n_of(seen[lib], "machines") == 3);
    CHECK(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(seen[lib], "rows")) == 5);
    CHECK(count("summary", NULL) == 5);   // each lane's last answer, as history
    for (int i = find("summary", NULL); i >= 0; i = find_from(i + 1, "summary", NULL)) CHECK(b_of(seen[i], "restore"));
    CHECK(find("notif.replace", NULL) > lib);

    // A keepalive (same mac, same firmware) gets its welcome and nothing else; the count restarts.
    forget();
    say(HELLO_MAX);
    run(50);
    CHECK(seen_n == 1 && eq(s_of(seen[0], "t"), "welcome") && n_of(seen[0], "seq") == 0);

    // The device's own asks after a welcome: the machines, then the whole push again.
    forget();
    say("{\"t\":\"machines.list\"}");
    say("{\"t\":\"agents.list\"}");
    run(50);
    CHECK(eq(s_of(seen[0], "t"), "machines.begin"));
    CHECK(count("machines.begin", NULL) == 2 && count("agents.begin", NULL) == 1 && count("notif.replace", NULL) == 1);

    // A round dial (no board, no capabilities): no seq, no resync, no library, no steps.
    forget();
    max_demo_reset(now);
    next_seq = -1;
    say("{\"t\":\"hello\",\"fw\":\"0.0.58\",\"product\":\"harness\",\"proto\":3,\"mac\":\"11:22\"}");
    run(50);
    w = find("welcome", NULL);
    CHECK(w >= 0 && !has(seen[w], "seq"));
    list = cJSON_GetObjectItemCaseSensitive(seen[w], "features");
    for (int i = 0; i < cJSON_GetArraySize(list); i++) {
        CHECK(!eq(cJSON_GetArrayItem(list, i)->valuestring, "resync"));
        CHECK(!eq(cJSON_GetArrayItem(list, i)->valuestring, "player.library"));
    }
    CHECK(count("player.library", NULL) == 0);
    run(60000);
    CHECK(count("turn.started", NULL) > 0);
    for (int i = 0; i < seen_n; i++) {
        CHECK(!has(seen[i], "seq") && !has(seen[i], "step") && !has(seen[i], "action") && !has(seen[i], "full"));
        CHECK(!eq(s_of(seen[i], "t"), "turn.stats"));
    }

    // Another product's dial gets no session at all.
    forget();
    max_demo_reset(now);
    next_seq = -1;
    say("{\"t\":\"hello\",\"fw\":\"1\",\"product\":\"other\",\"mac\":\"x\"}");
    run(30000);
    CHECK(count("welcome", NULL) == 0 && count("agents.begin", NULL) == 0 && count("turn.started", NULL) == 0);
    CHECK(count("ping", NULL) >= 5);
}

static void test_ping_and_silence(void)
{
    attach();
    forget();
    answer_pings = false;
    // A ping every 5 s; a pong is only proof of life.
    for (int i = 0; i < 6; i++) { run(5000); say("{\"t\":\"pong\"}"); }
    CHECK(count("ping", NULL) == 6);
    for (int i = 0; i < seen_n; i++) if (eq(s_of(seen[i], "t"), "ping")) CHECK(has(seen[i], "seq"));   // counted in a session
    for (int i = 1; i < seen_n; i++)
        if (eq(s_of(seen[i], "t"), "ping")) {
            int prev = -1;
            for (int j = i - 1; j >= 0; j--) if (eq(s_of(seen[j], "t"), "ping")) { prev = j; break; }
            if (prev >= 0) CHECK(seen_at[i] - seen_at[prev] == 5000);
        }
    // Silent for 20 s: the device is gone. Its next hello, even the same one, is a fresh attach.
    run(21000);
    forget();
    next_seq = -1;
    say(HELLO_MAX);
    run(50);
    CHECK(count("welcome", NULL) == 1 && count("agents.begin", NULL) == 1);
    answer_pings = true;
}

static void test_resync(void)
{
    attach();
    forget();
    say("{\"t\":\"resync\"}");
    run(50);
    CHECK(count("machines.begin", NULL) == 1 && count("swarms", NULL) == 1 && count("agents.begin", NULL) == 1);
    CHECK(count("notif.replace", NULL) == 1 && count("summary", NULL) == 0);   // no history replay
    // At most once per 2 s.
    forget();
    say("{\"t\":\"resync\"}");
    run(50);
    CHECK(count("agents.begin", NULL) == 0);
    run(2000);
    say("{\"t\":\"resync\"}");
    run(50);
    CHECK(count("agents.begin", NULL) == 1);
    // The other asks, each answered with its own part.
    forget();
    say("{\"t\":\"agents.refresh\"}");
    say("{\"t\":\"swarms.list\"}");
    run(50);
    CHECK(count("agents.begin", NULL) == 1 && count("swarms", NULL) == 1 && count("machines.begin", NULL) == 0);
    forget();
    say("{\"t\":\"player.library.get\",\"offset\":3,\"request\":77}");
    run(50);
    int lib = find("player.library", NULL);
    CHECK(lib >= 0 && n_of(seen[lib], "request") == 77 && n_of(seen[lib], "offset") == 0);   // 5 rows: one page from 0
    forget();
    say("{\"t\":\"player.library.get\",\"offset\":-1,\"request\":78}");   // refused, as the daemon refuses it
    run(50);
    CHECK(count("player.library", NULL) == 0);
}

static void test_open_and_focus(void)
{
    attach();
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("ios-release"));
    run(50);
    int f = find("focus", NULL);
    CHECK(f >= 0 && eq(s_of(seen[f], "agentId"), id_of("ios-release")));
    // A question screen that came up by itself, or an agent nobody lists, moves nothing.
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\",\"reason\":\"question\"}", id_of("harness-web"));
    say("{\"t\":\"agent.open\",\"agentId\":\"nobody\"}");
    run(50);
    CHECK(count("focus", NULL) == 0);
    // The record is re-asserted after a push, as the daemon does.
    forget();
    say("{\"t\":\"agents.refresh\"}");
    run(50);
    f = find("focus", NULL);
    CHECK(f > find("agents.end", NULL) && eq(s_of(seen[f], "agentId"), id_of("ios-release")));
}

static void pcm(size_t bytes)
{
    static uint8_t chunk[4096];
    while (bytes) {
        size_t n = bytes < sizeof chunk ? bytes : sizeof chunk;
        max_demo_receive(CABLE_TYPE_PCM, chunk, n, now);
        bytes -= n;
    }
}

static void test_voice(void)
{
    attach();
    run(1000);
    forget();
    // Talk to the docs agent, which is idle at the start of the story.
    const char *docs = id_of("docs-site");
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"lang\":\"en\",\"sr\":16000,\"uploadId\":\"up-1\"}", docs);
    pcm(32000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-1\"}");
    run(300);
    CHECK(count("voice.transcript", NULL) == 0);   // a moment to think first
    int at = wait_for("voice.transcript", NULL, 5000);
    CHECK(at >= 0);
    const cJSON *v = seen[at];
    CHECK(eq(s_of(v, "agentId"), docs) && eq(s_of(v, "agentName"), "docs-site") && eq(s_of(v, "uploadId"), "up-1"));
    CHECK(eq(s_of(v, "routeId"), "") && !b_of(v, "needsConfirm") && strlen(s_of(v, "text")) > 0);
    // ...and that agent goes to work on it, then answers.
    int started = wait_for("turn.started", docs, 3000);
    CHECK(started > at);
    CHECK(wait_for("summary", docs, 40000) > started);

    // Nothing recorded: the daemon's own words.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-2\"}", docs);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-2\"}");
    run(50);
    at = find("voice.error", NULL);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "Didn't catch that") && eq(s_of(seen[at], "uploadId"), "up-2"));

    // Aborted: nothing comes back, and an end for another upload is not this one's.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-3\"}", docs);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"other\"}");
    say("{\"t\":\"voice.abort\",\"uploadId\":\"up-3\"}");
    run(5000);
    CHECK(count("voice.transcript", NULL) == 0 && count("voice.error", NULL) == 0);

    // A new recording drops the reply the last one was waiting on.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-4\"}", docs);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-4\"}");
    run(200);
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-5\"}", docs);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-5\"}");
    run(5000);
    CHECK(count("voice.transcript", NULL) == 1 && eq(s_of(seen[find("voice.transcript", NULL)], "uploadId"), "up-5"));

    // No agent named: the words go to the one the bar is on.
    run(60000);
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("near-app"));
    forget();
    say("{\"t\":\"voice.begin\",\"uploadId\":\"up-6\"}");
    pcm(16000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-6\"}");
    at = wait_for("voice.transcript", NULL, 5000);
    CHECK(at >= 0 && eq(s_of(seen[at], "agentId"), id_of("near-app")));

    // An agent nobody lists cannot be reached.
    forget();
    say("{\"t\":\"voice.begin\",\"agentId\":\"nobody\",\"uploadId\":\"up-7\"}");
    pcm(16000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-7\"}");
    at = wait_for("voice.error", NULL, 5000);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "Could not reach that harness. Check its connection and try again."));

    // A spoken answer to a question that takes no words.
    forget();
    say("{\"t\":\"voice.begin\",\"agentId\":\"x\",\"questionToken\":\"t\",\"questionIndex\":0,\"uploadId\":\"up-8\"}");
    pcm(16000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-8\"}");
    run(50);
    at = find("voice.error", NULL);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "This question changed. Open it again."));
}

// Run the story until `name` asks; the question frame's index.
static int until_asked(const char *name)
{
    int at = wait_for("question", id_of(name), 60000);
    CHECK(at >= 0);
    return at;
}

static void test_question(void)
{
    attach();
    const char *web = id_of("harness-web");
    int q = until_asked("harness-web");
    const cJSON *questions = cJSON_GetObjectItemCaseSensitive(seen[q], "questions");
    CHECK(cJSON_GetArraySize(questions) == 1);
    const cJSON *first = cJSON_GetArrayItem(questions, 0);
    CHECK(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(first, "options")) >= 2);
    CHECK(eq(s_of(seen[q], "name"), "harness-web") && eq(s_of(seen[q], "machine"), "MacBook Pro"));
    CHECK(!has(seen[q], "permission"));   // a plain question carries no mark
    char qid[64];
    snprintf(qid, sizeof qid, "%s", s_of(seen[q], "id"));
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", web);   // a person is here: the story waits for them

    // Read it: the token that names these exact contents.
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"rq-1\"}", web);
    run(50);
    int st = find("question.state", NULL);
    CHECK(st >= 0 && b_of(seen[st], "ok") && eq(s_of(seen[st], "requestId"), "rq-1") && eq(s_of(seen[st], "id"), qid));
    CHECK(!b_of(seen[st], "submitted"));
    // The local machine's agent may take spoken words: no canText:false on its questions.
    CHECK(!has(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[st], "questions"), 0), "canText"));
    char token[64];
    snprintf(token, sizeof token, "%s", s_of(seen[st], "token"));

    // A wrong token, a wrong count and a mask with no option are refused in the daemon's words.
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"stale\",\"requestId\":\"rq-2\",\"choices\":[1]}", web);
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-3\",\"choices\":[1,1]}", web, token);
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-4\",\"choices\":[3]}", web, token);
    run(50);
    CHECK(count("answer.receipt", NULL) == 3);
    CHECK(eq(s_of(seen[0], "error"), "This question changed. Open it again.") && eq(s_of(seen[0], "token"), "stale"));
    CHECK(eq(s_of(seen[1], "error"), "Review every answer first."));
    CHECK(eq(s_of(seen[2], "error"), "Choose an answer from this question."));
    for (int i = 0; i < 3; i++) CHECK(!b_of(seen[i], "ok"));
    CHECK(count("question.close", NULL) == 0);

    // The second option: taken, the dialog closes, and the agent goes on with that choice.
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-5\",\"choices\":[2]}", web, token);
    run(50);
    int r = find("answer.receipt", NULL);
    CHECK(r >= 0 && b_of(seen[r], "ok") && !has(seen[r], "pending") && eq(s_of(seen[r], "requestId"), "rq-5"));
    // Sent twice, done once: the same receipt, no second answer.
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-6\",\"choices\":[2]}", web, token);
    run(50);
    CHECK(count("answer.receipt", NULL) == 2 && b_of(seen[find_from(r + 1, "answer.receipt", NULL)], "ok"));
    int closed = wait_for("question.close", web, 3000);
    CHECK(closed >= 0 && eq(s_of(seen[closed], "id"), qid));
    CHECK(count("question.close", web) == 1);
    int done = wait_for("summary", web, 40000);
    CHECK(done > closed && strstr(s_of(seen[done], "text"), "next to the button"));
    CHECK(eq(s_of(seen[done], "tier"), "alert") && has(seen[done], "full"));
    CHECK(find("turn.stats", web) >= 0 && find("turn.done", web) < done);
    // Closed: there is nothing left to read.
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"rq-7\"}", web);
    run(50);
    st = find("question.state", NULL);
    CHECK(st >= 0 && !b_of(seen[st], "ok") && eq(s_of(seen[st], "error"), "No readable question. Check the terminal."));
}

static void test_question_legacy_answer(void)
{
    attach();
    const char *web = id_of("harness-web");
    int q = until_asked("harness-web");
    char qid[64], key[256];
    snprintf(qid, sizeof qid, "%s", s_of(seen[q], "id"));
    snprintf(key, sizeof key, "%s", s_of(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[q], "questions"), 0), "key"));
    forget();
    // An answer for another request is not this one's.
    sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"old\",\"answers\":{\"%s\":\"Full-screen overlay\"}}", web, key);
    run(3000);
    CHECK(count("question.close", NULL) == 0);
    sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"%s\",\"answers\":{\"%s\":\"Full-screen overlay\"}}", web, qid, key);
    int closed = wait_for("question.close", web, 3000);
    CHECK(closed >= 0 && count("answer.receipt", NULL) == 0);   // the old answer gets no receipt
    int done = wait_for("summary", web, 40000);
    CHECK(done > closed && strstr(s_of(seen[done], "text"), "overlay"));
}

static void test_permission(void)
{
    // Approved: the agent goes on to deploy.
    attach();
    const char *api = id_of("harness-backend");
    int q = until_asked("harness-backend");
    const cJSON *row = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[q], "questions"), 0);
    CHECK(strstr(s_of(row, "q"), "Approve Bash command") == s_of(row, "q"));
    CHECK(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(seen[q], "permission")));   // drawn as approve/deny
    say("{\"t\":\"resync\"}");
    run(50);
    const int again = find_from(q + 1, "question", api);
    CHECK(again > q && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(seen[again], "permission")));
    const cJSON *options = cJSON_GetObjectItemCaseSensitive(row, "options");
    CHECK(eq(cJSON_GetArrayItem(options, 0)->valuestring, "Yes"));
    CHECK(eq(cJSON_GetArrayItem(options, cJSON_GetArraySize(options) - 1)->valuestring, "No"));
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"p1\"}", api);
    run(50);
    int st = find("question.state", NULL);
    // Another machine's agent takes no spoken answer: canText false, as the daemon says for a remote question.
    CHECK(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[st], "questions"), 0), "canText")));
    char token[64];
    snprintf(token, sizeof token, "%s", s_of(seen[st], "token"));
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"p2\",\"choices\":[1]}", api, token);
    run(50);
    int r = find("answer.receipt", NULL);
    CHECK(r >= 0 && b_of(seen[r], "ok") && b_of(seen[r], "pending"));   // handed to another machine
    CHECK(wait_for("question.close", api, 3000) >= 0);
    int done = wait_for("summary", api, 40000);
    CHECK(done >= 0 && strstr(s_of(seen[done], "recap"), "live"));
    CHECK(find("turn.error", api) < 0);

    // Denied: it stops.
    attach();
    q = until_asked("harness-backend");
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"p3\"}", api);
    run(50);
    snprintf(token, sizeof token, "%s", s_of(seen[find("question.state", NULL)], "token"));
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"p4\",\"choices\":[4]}", api, token);
    CHECK(wait_for("question.close", api, 3000) >= 0);
    done = wait_for("summary", api, 10000);
    CHECK(done >= 0 && strstr(s_of(seen[done], "recap"), "Stopped") && eq(s_of(seen[done], "tier"), "list"));
    CHECK(find("turn.done", api) >= 0 && find("turn.done", api) < done);
    // ...and does no more work in this turn.
    run(30000);
    CHECK(count("turn.activity", api) == 0);
}

// One `form` request; the form.state answering it.
static const cJSON *form(const char *op, const char *extra)
{
    static int request;
    char json[512];
    snprintf(json, sizeof json, "{\"t\":\"form\",\"op\":\"%s\",\"formId\":\"f-1\",\"requestId\":\"fr-%d\"%s%s}", op, ++request,
             extra && extra[0] ? "," : "", extra ? extra : "");
    int before = seen_n;
    say(json);
    run(20);
    char want[16];
    snprintf(want, sizeof want, "fr-%d", request);
    for (int i = before; i < seen_n; i++)
        if (eq(s_of(seen[i], "t"), "form.state") && eq(s_of(seen[i], "requestId"), want)) return seen[i];
    fprintf(stderr, "no form.state for %s\n", json);
    abort();
}
static const cJSON *form_rev(const char *op, int delta)
{
    static char extra[96];
    int rev = 0;   // the last snapshot's (a refusal carries none)
    for (int i = seen_n - 1; i >= 0; i--)
        if ((eq(s_of(seen[i], "t"), "form.state") || eq(s_of(seen[i], "t"), "voice.form")) && has(seen[i], "revision")) {
            rev = (int)n_of(seen[i], "revision");
            break;
        }
    if (delta) snprintf(extra, sizeof extra, "\"revision\":%d,\"delta\":%d", rev, delta);
    else snprintf(extra, sizeof extra, "\"revision\":%d", rev);
    return form(op, extra);
}

static void test_new_harness(void)
{
    attach();
    forget();
    const cJSON *s = form("open", "\"surface\":\"new\"");
    CHECK(b_of(s, "ok") && b_of(s, "active") && eq(s_of(s, "title"), "New Harness"));
    CHECK(eq(s_of(s, "action"), "start") && n_of(s, "position") == n_of(s, "total") && b_of(s, "enabled"));
    CHECK(eq(s_of(s, "formId"), "f-1"));
    const double first_revision = n_of(s, "revision");

    // Up to the project row, open its list, walk to the build server's project and choose it.
    s = form_rev("move", -1);
    CHECK(b_of(s, "ok") && eq(s_of(s, "label"), "Project") && eq(s_of(s, "action"), "open") && b_of(s, "canQuery"));
    CHECK(n_of(s, "revision") > first_revision);
    s = form_rev("activate", 0);
    CHECK(eq(s_of(s, "title"), "Project") && eq(s_of(s, "action"), "choose") && n_of(s, "total") == 3);
    s = form_rev("move", 2);
    CHECK(eq(s_of(s, "label"), "infra") && eq(s_of(s, "detail"), "Build server"));
    s = form_rev("activate", 0);
    CHECK(eq(s_of(s, "label"), "Project") && strstr(s_of(s, "detail"), "infra"));

    // A stale revision is refused, the form unchanged.
    char stale[64];
    snprintf(stale, sizeof stale, "\"revision\":%d,\"delta\":1", (int)first_revision);
    s = form("move", stale);
    CHECK(!b_of(s, "ok") && b_of(s, "active") && eq(s_of(s, "error"), "Choices changed. Try again."));
    CHECK(eq(s_of(s, "label"), "Project"));
    // Malformed: the window form's own refusal.
    s = form("move", "\"revision\":1,\"delta\":0");
    CHECK(!b_of(s, "ok") && !b_of(s, "active") && eq(s_of(s, "error"), "Invalid form command."));
    // Another form's id.
    say("{\"t\":\"form\",\"op\":\"state\",\"formId\":\"f-2\",\"requestId\":\"x-1\",\"revision\":0}");
    run(20);
    CHECK(eq(s_of(seen[seen_n - 1], "error"), "Open New Harness again."));

    // To the start row, and start.
    s = form_rev("move", 1);
    CHECK(eq(s_of(s, "action"), "start") && strstr(s_of(s, "detail"), "infra") && strstr(s_of(s, "detail"), "Claude Code"));
    s = form_rev("activate", 0);
    CHECK(b_of(s, "ok") && b_of(s, "active") && b_of(s, "busy") && !b_of(s, "enabled") && strlen(s_of(s, "status")) > 0);
    // The new agent arrives on the build server, the bar is turned to it, and it gets to work.
    int end = -1;
    for (int tries = 0; tries < 50 && end < 0; tries++) {
        run(100);
        for (int i = 0; i < seen_n; i++)
            if (eq(s_of(seen[i], "t"), "agents.end") && n_of(seen[i], "total") == 6) end = i;
    }
    CHECK(end >= 0);
    read_roster();
    CHECK(roster_n == 6 && eq(names[5], "infra") && eq(machines_of[5], "Build server"));
    int f = find_from(end, "focus", NULL);
    CHECK(f > end && eq(s_of(seen[f], "agentId"), ids[5]));
    CHECK(wait_for("turn.started", ids[5], 3000) >= 0);
    // The form has gone from the window.
    s = form("state", "\"revision\":0");
    CHECK(b_of(s, "ok") && !b_of(s, "active") && !has(s, "revision"));

    // A quiet minute and the end of the story's loop take the person's agents away again.
    run(300000);
    say("{\"t\":\"agents.refresh\"}");
    run(50);
    read_roster();
    CHECK(roster_n == 5);
}

static void test_form_voice(void)
{
    attach();
    forget();
    form("open", "");
    form_rev("move", -1);   // the project row, which takes a spoken name
    int rev = 0;
    for (int i = seen_n - 1; i >= 0; i--) if (eq(s_of(seen[i], "t"), "form.state")) { rev = (int)n_of(seen[i], "revision"); break; }
    sayf("{\"t\":\"voice.begin\",\"formId\":\"f-1\",\"formRevision\":%d,\"uploadId\":\"vf-1\",\"lang\":\"en\",\"sr\":16000}", rev);
    pcm(16000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"vf-1\"}");
    int at = wait_for("voice.form", NULL, 5000);
    CHECK(at >= 0);
    const cJSON *v = seen[at];
    CHECK(b_of(v, "ok") && b_of(v, "active") && eq(s_of(v, "formId"), "f-1") && eq(s_of(v, "uploadId"), "vf-1"));
    CHECK(eq(s_of(v, "title"), "Project") && eq(s_of(v, "action"), "choose") && strlen(s_of(v, "query")) > 0);
    CHECK(eq(s_of(v, "label"), s_of(v, "query")));
    // The start row takes no spoken name: the desktop's refusal, said as a voice error.
    form_rev("back", 0);
    form_rev("move", 1);
    rev = (int)n_of(seen[seen_n - 1], "revision");
    forget();
    sayf("{\"t\":\"voice.begin\",\"formId\":\"f-1\",\"formRevision\":%d,\"uploadId\":\"vf-2\"}", rev);
    pcm(16000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"vf-2\"}");
    run(50);
    at = find("voice.error", NULL);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "Choose an Agent or Project field to search."));
    // A malformed one.
    forget();
    say("{\"t\":\"voice.begin\",\"formId\":\"f 1\",\"formRevision\":1,\"uploadId\":\"vf-3\"}");
    say("{\"t\":\"voice.end\",\"uploadId\":\"vf-3\"}");
    run(50);
    at = find("voice.error", NULL);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "Open a field and say its name again."));
}

// The story on its own: every kind of card, then the same again.
static void test_story_loops(void)
{
    attach();
    forget();
    run(140000);
    const int started = count("turn.started", NULL);
    CHECK(started >= 7);
    CHECK(count("question", NULL) == 2);
    CHECK(count("question.close", NULL) == 2);   // answered on the computer when nobody is at the bar
    CHECK(count("turn.error", NULL) == 1);
    CHECK(count("turn.done", NULL) >= 6);
    int tiers[3] = {0, 0, 0};
    for (int i = 0; i < seen_n; i++) {
        if (!eq(s_of(seen[i], "t"), "summary")) continue;
        tiers[0] += eq(s_of(seen[i], "tier"), "alert");
        tiers[1] += eq(s_of(seen[i], "tier"), "list");
        tiers[2] += eq(s_of(seen[i], "tier"), "silent");
    }
    CHECK(tiers[0] >= 3 && tiers[1] >= 2 && tiers[2] >= 1);
    CHECK(count("turn.activity", NULL) > 30);
    int elapsed = 0, steps = 0;
    for (int i = 0; i < seen_n; i++) {
        elapsed += has(seen[i], "elapsedSeconds");
        steps += has(seen[i], "step");
    }
    CHECK(elapsed > 5 && steps > 15);
    // Busy agents show in the library.
    bool working = false;
    for (int i = 0; i < seen_n; i++) {
        if (!eq(s_of(seen[i], "t"), "player.library")) continue;
        const cJSON *row;
        cJSON_ArrayForEach(row, cJSON_GetObjectItemCaseSensitive(seen[i], "rows")) working |= eq(s_of(row, "status"), "working");
    }
    CHECK(working);
    // The loop again: the same story, as many cards.
    forget();
    run(140000);
    CHECK(count("turn.started", NULL) == started);
    CHECK(count("question", NULL) == 2 && count("turn.error", NULL) == 1);
}

// A person takes over: the story starts nothing new for a quiet minute, then goes on.
static void test_person_takes_over(void)
{
    attach();
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("near-app"));
    run(55000);
    CHECK(count("turn.started", NULL) == 0);
    CHECK(count("ping", NULL) >= 10);
    run(10000);
    CHECK(count("turn.started", NULL) >= 1);

    // The Max reads a question the moment it arrives, with nobody at the bar: that read is no person, and the
    // question is still answered on the computer when its wait is up.
    attach();
    const char *web = id_of("harness-web");
    until_asked("harness-web");
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"k0\"}", web);
    run(45000);
    CHECK(count("question.close", web) == 1);

    // An open question waits for a person, however long they stay.
    attach();
    until_asked("harness-web");
    for (int i = 0; i < 6; i++) {
        sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", web);
        run(20000);
    }
    CHECK(count("question.close", web) == 0);
    // Left alone, it is answered on the computer after the quiet minute and a while more.
    run(120000);
    CHECK(count("question.close", web) == 1);

    // The drawer on a fresh attach holds the open question, and the finished answers not yet seen.
    attach();
    until_asked("harness-web");
    run(70000);   // ios-release ships meanwhile
    forget();
    say("{\"t\":\"resync\"}");
    run(50);
    int d = find("notif.replace", NULL);
    CHECK(d >= 0);
    bool question = false, finished = false;
    const char *token = NULL;
    const cJSON *row;
    cJSON_ArrayForEach(row, cJSON_GetObjectItemCaseSensitive(seen[d], "items")) {
        question |= b_of(row, "question");
        if (!b_of(row, "question") && eq(s_of(row, "agentId"), id_of("ios-release"))) { finished = true; token = s_of(row, "readToken"); }
    }
    CHECK(finished && token);
    (void)question;
    char tok[64];
    snprintf(tok, sizeof tok, "%s", token);
    forget();
    sayf("{\"t\":\"notif.read\",\"agentId\":\"%s\",\"readToken\":\"%s\"}", id_of("ios-release"), tok);
    run(50);
    int seen_at_ = find("notif.seen", NULL);
    CHECK(seen_at_ >= 0 && eq(s_of(seen[seen_at_], "readToken"), tok));
}

static void test_machine_select(void)
{
    attach();
    forget();
    say("{\"t\":\"machine.select\",\"machineId\":\"nowhere\"}");
    run(50);
    int e = find("machine.error", NULL);
    CHECK(e >= 0 && eq(s_of(seen[e], "machineId"), "nowhere"));
    forget();
    int m = -1;
    say("{\"t\":\"machines.list\"}");
    run(50);
    for (int i = 0; i < seen_n; i++) if (eq(s_of(seen[i], "t"), "machine") && !b_of(seen[i], "local")) m = i;
    char other[64];
    snprintf(other, sizeof other, "%s", s_of(seen[m], "id"));
    forget();
    sayf("{\"t\":\"machine.select\",\"machineId\":\"%s\"}", other);
    run(50);
    int sel = find("machine.selected", NULL);
    CHECK(sel >= 0 && eq(s_of(seen[sel], "machineId"), other));
    int end = find("machines.end", NULL);
    CHECK(end > sel && eq(s_of(seen[end], "selected"), other));
}

// ── 24 hours of random device frames ────────────────────────────────────────────────────────────────

static uint64_t rng = 0x9e3779b97f4a7c15ull;
static uint32_t rnd(uint32_t n)
{
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return n ? (uint32_t)(rng % n) : 0;
}

static void random_frame(void)
{
    char json[1024];
    const char *agent = roster_n ? ids[rnd((uint32_t)roster_n)] : "x";
    const char *agents[] = {agent, "nobody", "", "\\u0000"};
    const char *a = agents[rnd(4) ? 0 : rnd(4)];
    static int upload;
    switch (rnd(24)) {
    case 0: say(HELLO_MAX); break;
    case 1: say("{\"t\":\"hello\",\"product\":\"harness\",\"board\":\"pro\",\"mac\":\"m2\",\"fw\":\"2\"}"); break;
    case 2: say("{\"t\":\"agents.list\"}"); break;
    case 3: say("{\"t\":\"machines.list\"}"); break;
    case 4: say("{\"t\":\"resync\"}"); break;
    case 5: sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", a); break;
    case 6: sayf("{\"t\":\"focus\",\"agentId\":\"%s\"}", a); break;
    case 7: sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"u%d\"}", a, ++upload); break;
    case 8: pcm(rnd(20000)); break;
    case 9: sayf("{\"t\":\"voice.end\",\"uploadId\":\"u%d\"}", upload - (int)rnd(2)); break;
    case 10: sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"r%u\"}", a, rnd(100)); break;
    case 11: sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"t%u\",\"requestId\":\"r\",\"choices\":[%u]}", a, rnd(3), rnd(9)); break;
    case 12: sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"q%u\",\"answers\":{\"k\":\"Yes\"}}", a, rnd(9)); break;
    case 13: {
        static const char *const ops[] = {"open", "state", "move", "activate", "back", "close", "bogus"};
        sayf("{\"t\":\"form\",\"op\":\"%s\",\"formId\":\"f%u\",\"requestId\":\"r%u\",\"revision\":%u,\"delta\":%d}", ops[rnd(7)],
             rnd(2), rnd(9), rnd(40), (int)rnd(5) - 2);
        break;
    }
    case 14: sayf("{\"t\":\"voice.begin\",\"formId\":\"f%u\",\"formRevision\":%u,\"uploadId\":\"u%d\"}", rnd(2), rnd(40), ++upload); break;
    case 15: sayf("{\"t\":\"player.library.get\",\"offset\":%u,\"request\":%u}", rnd(9), rnd(1000)); break;
    case 16: sayf("{\"t\":\"notif.read\",\"agentId\":\"%s\",\"readToken\":\"rt%u\"}", a, rnd(50)); break;
    case 17: sayf("{\"t\":\"machine.select\",\"machineId\":\"m-%s\"}", rnd(2) ? "studio" : "x"); break;
    case 18: say("{\"t\":\"pong\"}"); break;
    case 19: say("{\"t\":\"voice.abort\"}"); break;
    case 20: {   // bytes that are not JSON, or JSON that is not a message
        size_t n = rnd(sizeof json);
        for (size_t i = 0; i < n; i++) json[i] = (char)rnd(256);
        max_demo_receive(CABLE_TYPE_JSON, (const uint8_t *)json, n, now);
        break;
    }
    case 21: {
        size_t n = rnd(200);
        for (size_t i = 0; i < n; i++) json[i] = '[';
        max_demo_receive(CABLE_TYPE_JSON, (const uint8_t *)json, n, now);
        break;
    }
    case 22: say("{\"t\":7}"); break;
    default: max_demo_receive((uint8_t)rnd(8), (const uint8_t *)"{}", 2, now); break;
    }
}

static void test_soak(void)
{
    forget();
    now = 0xFFFF0000u;   // across the clock's wrap too
    next_seq = -1;
    max_demo_reset(now);
    say(HELLO_MAX);
    run(100);
    read_roster();
    forget();
    const uint32_t start = now;
    size_t worst_bytes = 0, worst_frames = 0, total = 0;
    uint32_t last_frame_at = now;
    while (now - start < 24u * 3600u * 1000u) {
        // Mostly a quiet bar, now and then a burst of somebody using it, rarely a long gap.
        if (rnd(40) == 0) for (int i = (int)rnd(12); i >= 0; i--) random_frame();
        const uint32_t step = rnd(200) == 0 ? 30000 + rnd(120000) : 50 + rnd(1500);
        now += step;
        tick_bytes = tick_frames = 0;
        max_demo_tick(now, emit, NULL);
        if (tick_frames) last_frame_at = now;
        if (tick_bytes > worst_bytes) worst_bytes = tick_bytes;
        if (tick_frames > worst_frames) worst_frames = tick_frames;
        total += tick_bytes;
        // A greeting now and then keeps the session up, as the device's hello every 15 s does.
        if (rnd(10) == 0) say("{\"t\":\"pong\"}");
        if (seen_n > SEEN_MAX / 2) {
            for (int i = 0; i < seen_n; i++) if (eq(s_of(seen[i], "t"), "agents.end")) { read_roster(); break; }
            forget();
        }
        CHECK((int32_t)(max_demo_next_ms(now) - now) <= 1000);
    }
    CHECK(now - last_frame_at < 10000);   // still talking at the end of the day
    CHECK(worst_frames <= 128 && worst_bytes <= 64 * 1024);
    CHECK(total < 400u * 1024u * 1024u);
    printf("soak: 24 h, %zu KB sent, worst tick %zu frames / %zu B\n", total / 1024, worst_frames, worst_bytes);
}

int main(void)
{
    test_handshake();
    test_ping_and_silence();
    test_resync();
    test_open_and_focus();
    test_voice();
    test_question();
    test_question_legacy_answer();
    test_permission();
    test_new_harness();
    test_form_voice();
    test_story_loops();
    test_person_takes_over();
    test_machine_select();
    test_soak();
    forget();
    printf("test_max_demo: %d checks passed\n", checks);
    return 0;
}
