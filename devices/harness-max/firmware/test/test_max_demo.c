// Host tests for the scripted demo daemon (main/demo/max_demo.c), on a fake clock.
//
// Every frame the demo sends is parsed and held to the shape the real daemon gives that message
// (cli/src/cable/cableSession.ts on main): its field names, their types, and nothing else. `seq` is checked from each
// welcome on. Most tests run the self-playing story (`--story`); the person's demo (`--demo`) has its own.
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
// The hello last answered said appFilter "v1": every ring comes right after its `apps`, and only then is `apps` sent.
// Taken at its welcome, since replies written before the hello still go out first, under the session they answer: each
// harness hello said waits here for its own welcome.
static bool expect_apps, hellos[64];
static unsigned hellos_in, hellos_out;
static char last_t[32];

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
    {"apps", {{"shown", 's', true}, {"apps", 'a', true}}},
    {"agents.begin", {{0}}},
    {"agent", {{"id", 's', true}, {"name", 's', true}, {"engine", 's', true}, {"model", 's', true}, {"effort", 's', true},
               {"machineId", 's', true}, {"machine", 's', true}, {"host", 's', false}, {"caps", 's', false}}},
    {"agents.end", {{"total", 'n', true}, {"tab", 's', true}, {"view", 's', false}}},
    {"player.library", {{"request", 'n', true}, {"offset", 'n', true}, {"total", 'n', true}, {"rows", 'a', true},
                        {"machines", 'n', true}}},
    {"focus", {{"agentId", 's', true}}},
    {"toast", {{"text", 's', true}}},
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
    // main's giveQuestion: a summary only, without the engine. `permission` is the Max's daemon's mark on it.
    {"question", {{"agentId", 's', true}, {"name", 's', true}, {"machine", 's', true}, {"id", 's', true},
                  {"questions", 'a', true}, {"permission", 'b', false}}},
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
// A `question` frame's one row: the first question's words as a drawer row holds them (noticeSummary, 239 B), no options.
static const field_t SUMMARY_ROW[] = {{"key", 's', true}, {"q", 's', true}, {"options", 'S', true}, {0}};
static const field_t LIBRARY_ROW[] = {{"id", 's', true}, {"machineId", 's', true}, {"name", 's', true},
                                      {"engine", 's', true}, {"status", 's', true}, {"ageSeconds", 'n', true}, {0}};
static const field_t NOTICE_ROW[] = {{"agentId", 's', true}, {"name", 's', true}, {"machine", 's', true},
                                     {"summary", 's', true}, {"question", 'b', true}, {"readToken", 's', false}, {0}};
static const field_t MACHINE_ID[] = {{"id", 's', true}, {"name", 's', true}, {0}};
static const field_t APP_ROW[] = {{"id", 's', true}, {"name", 's', true}, {"count", 'n', true}, {"waiting", 'n', true}, {0}};

// The demo's apps: the mockup's, by hostDetect.ts's ids and names, in its order, and what the bar may do with each one's
// agents.
static const struct { const char *id, *name, *caps; } APPS[] = {
    {"harness", "Harness", "svfa"}, {"orca", "Orca", "sv"}, {"herdr", "herdr", "sv"}, {"vscode", "VS Code", "s"},
    {"cursor", "Cursor", "s"}, {"claude", "Claude", "s"}, {"codex", "ChatGPT", "s"}, {"terminal-app", "Terminal", "s"},
    {"ghostty", "Ghostty", "s"}, {"iterm", "iTerm2", "s"}, {"cmux", "cmux", "s"}};
enum { N_APPS = sizeof APPS / sizeof APPS[0] };

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
    if (!strcmp(t, "question")) {
        const cJSON *questions = cJSON_GetObjectItemCaseSensitive(m, "questions");
        CHECK(cJSON_GetArraySize(questions) == 1);
        e = cJSON_GetArrayItem(questions, 0);
        check_row(e, SUMMARY_ROW);
        CHECK(eq(s_of(e, "key"), "") && cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(e, "options")) == 0);
        CHECK(strlen(s_of(e, "q")) > 0 && strlen(s_of(e, "q")) <= 239);
    }
    if (!strcmp(t, "question.state"))
        cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "questions")) check_row(e, QUESTION_ROW);
    if (!strcmp(t, "player.library")) cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "rows")) check_row(e, LIBRARY_ROW);
    if (!strcmp(t, "notif.replace")) cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "items")) check_row(e, NOTICE_ROW);
    if (!strcmp(t, "apps")) cJSON_ArrayForEach(e, cJSON_GetObjectItemCaseSensitive(m, "apps")) check_row(e, APP_ROW);
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
    // Every agent says where it runs and what the device may do with it, by its app's own letters.
    if (!strcmp(t, "agent")) {
        bool known = false;
        for (size_t i = 0; i < sizeof APPS / sizeof APPS[0]; i++)
            if (eq(s_of(m, "host"), APPS[i].id)) { known = true; CHECK(eq(s_of(m, "caps"), APPS[i].caps)); }
        CHECK(known);
    }
}

// Every agent the demo named, by name, wherever it was listed: a ring holds one app's, the library pages all of them.
static char known_ids[24][48], known_names[24][48];
static int known_n;
static void learn(const char *id, const char *name)
{
    if (!id || !name) return;
    for (int i = 0; i < known_n; i++) if (eq(known_names[i], name)) { snprintf(known_ids[i], sizeof known_ids[i], "%s", id); return; }
    if (known_n >= 24) return;
    snprintf(known_ids[known_n], sizeof known_ids[0], "%s", id);
    snprintf(known_names[known_n++], sizeof known_names[0], "%s", name);
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
    if (!strcmp(t, "welcome")) {
        next_seq = has(m, "seq") ? 0 : -1;
        CHECK(hellos_out < hellos_in);
        expect_apps = hellos[hellos_out++ % 64];
    }
    // A ping with no count: the session went silent and ended (the daemon closes the port), so the count went with it.
    if (!strcmp(t, "ping") && !has(m, "seq")) next_seq = -1;
    if (next_seq >= 0) {
        CHECK(n_of(m, "seq") == (double)next_seq);
        next_seq++;
    } else if (strcmp(t, "ping")) {
        CHECK(!has(m, "seq"));
    }
    // A device that says appFilter gets `apps` right before each ring; any other gets no `apps` at all.
    if (!strcmp(t, "agents.begin")) CHECK(eq(last_t, "apps") == expect_apps);
    if (!strcmp(t, "apps")) CHECK(expect_apps);
    snprintf(last_t, sizeof last_t, "%s", t);
    if (!strcmp(t, "agent")) learn(s_of(m, "id"), s_of(m, "name"));
    const cJSON *row;
    if (!strcmp(t, "player.library"))
        cJSON_ArrayForEach(row, cJSON_GetObjectItemCaseSensitive(m, "rows")) learn(s_of(row, "id"), s_of(row, "name"));
    pinged |= !strcmp(t, "ping");
    if (seen_n < SEEN_MAX) { seen[seen_n] = m; seen_at[seen_n++] = now; }
    else cJSON_Delete(m);
}

// The demo the next reset starts: the self-playing story, or the one a person drives.
static bool story = true;

// A fresh demo: the replies it held, welcomes among them, are gone.
static void reset_demo(void)
{
    max_demo_reset(now, story);
    hellos_in = hellos_out = 0;
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
    // A hello from the harness product starts a session: whether it said appFilter decides how its rings come.
    if (strstr(json, "\"t\":\"hello\"") && strstr(json, "\"product\":\"harness\""))
        hellos[hellos_in++ % 64] = strstr(json, "\"appFilter\":\"v1\"") != NULL;
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
// An agent's first answer as news (a tier, not history) at or after `from`, or -1.
static int news_from(int from, const char *agent)
{
    for (int i = find_from(from, "summary", agent); i >= 0; i = find_from(i + 1, "summary", agent))
        if (!b_of(seen[i], "restore")) return i;
    return -1;
}
static int news(const char *agent) { return news_from(0, agent); }
// Run until `agent` answers as news, at most `ms`; its index.
static int wait_news(const char *agent, uint32_t ms)
{
    const uint32_t end = now + ms;
    for (;;) {
        int at = news(agent);
        if (at >= 0) return at;
        if ((int32_t)(now - end) >= 0) return -1;
        run(100);
    }
}
// The first `apps` frame at or after `from` that shows `app`, or -1.
static int find_shown(int from, const char *app)
{
    for (int i = find_from(from, "apps", NULL); i >= 0; i = find_from(i + 1, "apps", NULL))
        if (eq(s_of(seen[i], "shown"), app)) return i;
    return -1;
}
// The `apps` frame's row for `app`, or NULL.
static const cJSON *app_row(const cJSON *apps, const char *app)
{
    const cJSON *row;
    cJSON_ArrayForEach(row, cJSON_GetObjectItemCaseSensitive(apps, "apps")) if (eq(s_of(row, "id"), app)) return row;
    return NULL;
}
// A `question` frame's one summary row.
static const cJSON *summary_row(const cJSON *question)
{
    return cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(question, "questions"), 0);
}
// Whether a notif.replace holds a row for `agent` of that kind.
static bool drawer_has(const cJSON *drawer, const char *agent, bool question)
{
    const cJSON *row;
    cJSON_ArrayForEach(row, cJSON_GetObjectItemCaseSensitive(drawer, "items"))
        if (eq(s_of(row, "agentId"), agent) && b_of(row, "question") == question) return true;
    return false;
}
// The whole question as question.state gives it (requestId `request`), read now.
static const cJSON *read_question(const char *agent, const char *request)
{
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"%s\"}", agent, request);
    run(50);
    for (int i = seen_n - 1; i >= 0; i--)
        if (eq(s_of(seen[i], "t"), "question.state") && eq(s_of(seen[i], "requestId"), request)) return seen[i];
    fprintf(stderr, "no question.state for %s\n", request);
    abort();
}
// Its first question's options, joined by '|'.
static const char *options_of(const cJSON *state)
{
    static char out[256];
    out[0] = 0;
    const cJSON *option;
    const cJSON *first = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(state, "questions"), 0);
    cJSON_ArrayForEach(option, cJSON_GetObjectItemCaseSensitive(first, "options"))
        snprintf(out + strlen(out), sizeof out - strlen(out), "%s%s", out[0] ? "|" : "", option->valuestring);
    return out;
}

// ── the roster, as the demo sent it ─────────────────────────────────────────────────────────────────

static char ids[16][48], names[16][48], machines_of[16][48], hosts[16][24], caps[16][8], engines[16][16];
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
        snprintf(hosts[roster_n], sizeof hosts[0], "%s", s_of(seen[i], "host"));
        snprintf(caps[roster_n], sizeof caps[0], "%s", s_of(seen[i], "caps"));
        snprintf(engines[roster_n], sizeof engines[0], "%s", s_of(seen[i], "engine"));
        roster_n++;
    }
}
static const char *id_of(const char *name)
{
    for (int i = 0; i < known_n; i++) if (!strcmp(known_names[i], name)) return known_ids[i];
    fprintf(stderr, "no agent named %s\n", name);
    abort();
}
// The ring holds exactly these names, in this order, all of one app.
static void ring_is(const char *app, const char *const want[], int n)
{
    read_roster();
    CHECK(roster_n == n);
    for (int i = 0; i < n; i++) CHECK(eq(names[i], want[i]) && eq(hosts[i], app) && eq(machines_of[i], "MacBook Pro"));
}

static const char *const ORCA_RING[] = {"auth-refactor", "landing-hero", "flaky-e2e", "rate-limiter", "docs-sweep"};
static const char *const HARNESS_RING[] = {"firmware-max", "harness-cli", "docs"};
static const char *const HERDR_RING[] = {"billing-export", "release-notes"};

#define HELLO_MAX "{\"t\":\"hello\",\"fw\":\"0.1.0\",\"product\":\"harness\",\"proto\":3,\"hw\":\"max-nano\",\"board\":\"max\"," \
    "\"swarms\":\"members-v1\",\"recap\":\"long-v1\",\"activity\":\"steps-v1\",\"stats\":\"turn-v1\",\"player\":\"library-v1\"," \
    "\"ota\":\"v1\",\"appFilter\":\"v1\",\"mac\":\"aa:bb:cc:dd:ee:ff\",\"settings\":{\"brightness\":80}}"
// The Pro says no appFilter: it holds the window's tab, and is sent one ring of every agent.
#define HELLO_PRO "{\"t\":\"hello\",\"fw\":\"0.1.0\",\"product\":\"harness\",\"proto\":3,\"hw\":\"pro\",\"board\":\"pro\"," \
    "\"swarms\":\"members-v1\",\"recap\":\"long-v1\",\"activity\":\"steps-v1\",\"stats\":\"turn-v1\",\"player\":\"library-v1\"," \
    "\"ota\":\"v1\",\"mac\":\"11:22:33:44:55:66\"}"
// A Max that also says questionTier: a question it was told comes back to it as a silent row (main's giveQuestion).
#define HELLO_MAX_TIER "{\"t\":\"hello\",\"fw\":\"0.1.0\",\"product\":\"harness\",\"proto\":3,\"board\":\"max\"," \
    "\"appFilter\":\"v1\",\"questionTier\":\"v1\",\"mac\":\"aa:bb:cc:dd:ee:01\"}"

// A fresh demo with a Max greeted and the attach push read. The library's last page names the agents no ring shows yet.
static void attach_as(bool self_playing)
{
    forget();
    known_n = 0;
    now = 1000;
    next_seq = -1;
    story = self_playing;
    reset_demo();
    say(HELLO_MAX);
    run(50);
    say("{\"t\":\"player.library.get\",\"offset\":5,\"request\":1}");
    run(10);
    CHECK(known_n == 11);
    read_roster();
}
static void attach(void) { attach_as(true); }

// ── the tests ───────────────────────────────────────────────────────────────────────────────────────

// The welcome's features, as main's welcome lists them for that hello.
static void features_are(const cJSON *welcome, const char *const want[], int n)
{
    const cJSON *list = cJSON_GetObjectItemCaseSensitive(welcome, "features");
    CHECK(cJSON_GetArraySize(list) == n);
    for (int i = 0; i < cJSON_GetArraySize(list) && i < n; i++) CHECK(eq(cJSON_GetArrayItem(list, i)->valuestring, want[i]));
}

static void test_handshake(void)
{
    forget();
    now = 5000;
    next_seq = -1;
    story = true;
    reset_demo();
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
    // apps.switch: its hello said appFilter, so its Apps is a control the daemon answers.
    static const char *const features[] = {"voice.draft", "agents.refresh", "player.library", "resync", "form", "selection",
                                           "visit", "question.review", "apps.switch", "settings"};
    features_are(seen[w], features, (int)(sizeof features / sizeof features[0]));

    // Then the attach push, in the daemon's order: the one machine, tabs, the apps, the shown app's ring, the library,
    // the ring's history, the drawer.
    static const char *const order[] = {"welcome", "machines.begin", "machine", "machines.end", "swarms", "apps", "agents.begin"};
    for (size_t i = 0; i < sizeof order / sizeof order[0]; i++) CHECK(eq(s_of(seen[w + (int)i], "t"), order[i]));
    CHECK(b_of(seen[w + 2], "local") && eq(s_of(seen[w + 2], "name"), "MacBook Pro"));
    // The app in front is Orca: it is shown, and every app of the mockup is listed in its order, those with no agents
    // too (the daemon lists only apps with agents; the demo's Apps is as full as the mockup's).
    const cJSON *apps = seen[w + 5];
    CHECK(eq(s_of(apps, "shown"), "orca") && cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(apps, "apps")) == N_APPS);
    static const int counts[N_APPS] = {3, 5, 2, 1};
    for (int i = 0; i < N_APPS; i++) {
        const cJSON *row = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(apps, "apps"), i);
        CHECK(eq(s_of(row, "id"), APPS[i].id) && eq(s_of(row, "name"), APPS[i].name));
        CHECK(n_of(row, "count") == counts[i] && n_of(row, "waiting") == 0);
    }
    int end = find("agents.end", NULL);
    CHECK(end > w && n_of(seen[end], "total") == 5 && eq(s_of(seen[end], "tab"), "") && eq(s_of(seen[end], "view"), "machine"));
    // Orca's ring: its five agents in their fixed order, watched and spoken to, never answered on the bar.
    ring_is("orca", ORCA_RING, 5);
    static const char *const engine_of[] = {"claude", "codex", "claude", "codex", "muse"};   // the mockup's engines
    for (int i = 0; i < 5; i++) CHECK(eq(caps[i], "sv") && eq(engines[i], engine_of[i]));
    int sw = find("swarms", NULL);
    CHECK(eq(s_of(seen[sw], "selected"), "") && cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(seen[sw], "items")) == 0);
    // The library is every agent on the computer, a page at a time.
    int lib = find("player.library", NULL);
    CHECK(lib > end && n_of(seen[lib], "total") == 11 && n_of(seen[lib], "machines") == 1);
    CHECK(cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(seen[lib], "rows")) == 6);
    CHECK(count("summary", NULL) == 5);   // the ring's last answers, as history
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
    CHECK(count("machines.begin", NULL) == 2 && count("apps", NULL) == 1 && count("agents.begin", NULL) == 1);
    CHECK(count("notif.replace", NULL) == 1);

    // A Max that says questionTier is told the daemon files a question it sends again as a row: question.tier.
    forget();
    reset_demo();
    next_seq = -1;
    say(HELLO_MAX_TIER);
    run(50);
    static const char *const tiered[] = {"voice.draft", "agents.refresh", "resync", "form", "selection", "visit",
                                         "question.review", "apps.switch", "question.tier", "settings"};
    features_are(seen[find("welcome", NULL)], tiered, (int)(sizeof tiered / sizeof tiered[0]));

    // A round dial (no board, no capabilities): no seq, no resync, no library, no steps, no apps, no app switch.
    forget();
    reset_demo();
    next_seq = -1;
    say("{\"t\":\"hello\",\"fw\":\"0.0.58\",\"product\":\"harness\",\"proto\":3,\"mac\":\"11:22\"}");
    run(50);
    w = find("welcome", NULL);
    CHECK(w >= 0 && !has(seen[w], "seq"));
    static const char *const plain[] = {"voice.draft", "agents.refresh", "form", "selection", "visit", "question.review",
                                        "settings"};
    features_are(seen[w], plain, (int)(sizeof plain / sizeof plain[0]));
    CHECK(count("player.library", NULL) == 0 && count("apps", NULL) == 0);
    run(60000);
    CHECK(count("turn.started", NULL) > 0);
    for (int i = 0; i < seen_n; i++) {
        CHECK(!has(seen[i], "seq") && !has(seen[i], "step") && !has(seen[i], "action") && !has(seen[i], "full"));
        CHECK(!eq(s_of(seen[i], "t"), "turn.stats"));
    }

    // Another product's dial gets no session at all.
    forget();
    reset_demo();
    next_seq = -1;
    say("{\"t\":\"hello\",\"fw\":\"1\",\"product\":\"other\",\"mac\":\"x\"}");
    run(30000);
    CHECK(count("welcome", NULL) == 0 && count("agents.begin", NULL) == 0 && count("turn.started", NULL) == 0);
    CHECK(count("ping", NULL) >= 5);
}

// A device that does not say appFilter (the Pro) gets one ring of every agent, each with its app's host and caps.
static void test_one_ring_without_app_filter(void)
{
    forget();
    known_n = 0;
    now = 1000;
    next_seq = -1;
    story = true;
    reset_demo();
    say(HELLO_PRO);
    run(50);
    CHECK(count("apps", NULL) == 0);
    int end = find("agents.end", NULL);
    CHECK(end >= 0 && n_of(seen[end], "total") == 11);
    read_roster();
    CHECK(roster_n == 11);
    // V3's cast, in the mockup's engines: herdr's two after the story's nine.
    static const char *const want[][4] = {
        {"auth-refactor", "orca", "sv", "claude"}, {"landing-hero", "orca", "sv", "codex"},
        {"flaky-e2e", "orca", "sv", "claude"}, {"rate-limiter", "orca", "sv", "codex"}, {"docs-sweep", "orca", "sv", "muse"},
        {"firmware-max", "harness", "svfa", "claude"}, {"harness-cli", "harness", "svfa", "claude"},
        {"docs", "harness", "svfa", "muse"}, {"api-client", "vscode", "s", "claude"},
        {"billing-export", "herdr", "sv", "muse"}, {"release-notes", "herdr", "sv", "claude"}};
    for (int i = 0; i < 11; i++)
        CHECK(eq(names[i], want[i][0]) && eq(hosts[i], want[i][1]) && eq(caps[i], want[i][2]) && eq(engines[i], want[i][3]));
    CHECK(count("summary", NULL) == 11);   // its ring is every agent: the history of each
    // app.pick is not its to send: ignored.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"harness\"}");
    run(50);
    CHECK(count("apps", NULL) == 0 && count("agents.begin", NULL) == 0);
    // The app in front changes during the story: nothing is pushed to it for that.
    forget();
    run(135000);
    CHECK(count("agents.begin", NULL) == 0 && count("turn.started", NULL) > 0);
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
    CHECK(count("welcome", NULL) == 1 && count("apps", NULL) == 1 && count("agents.begin", NULL) == 1);
    answer_pings = true;
}

static void test_resync(void)
{
    attach();
    forget();
    say("{\"t\":\"resync\"}");
    run(50);
    CHECK(count("machines.begin", NULL) == 1 && count("swarms", NULL) == 1 && count("apps", NULL) == 1);
    CHECK(count("agents.begin", NULL) == 1);
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
    CHECK(count("apps", NULL) == 1 && count("agents.begin", NULL) == 1 && count("swarms", NULL) == 1);
    CHECK(count("machines.begin", NULL) == 0);
    forget();
    say("{\"t\":\"player.library.get\",\"offset\":7,\"request\":77}");
    run(50);
    int lib = find("player.library", NULL);
    CHECK(lib >= 0 && n_of(seen[lib], "request") == 77 && n_of(seen[lib], "offset") == 5);   // 11 rows: the last page is 5..10
    forget();
    say("{\"t\":\"player.library.get\",\"offset\":-1,\"request\":78}");   // refused, as the daemon refuses it
    run(50);
    CHECK(count("player.library", NULL) == 0);
}

// app.pick: the shown app's ring, after the `apps` that names it (docs/specs/2026-11-14-dial-app-filter.md).
static void test_app_pick(void)
{
    attach();
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"harness\"}");
    run(50);
    int a = find("apps", NULL);
    CHECK(a >= 0 && eq(s_of(seen[a], "shown"), "harness") && eq(s_of(seen[a + 1], "t"), "agents.begin"));
    CHECK(count("apps", NULL) == 1 && count("agents.begin", NULL) == 1);
    ring_is("harness", HARNESS_RING, 3);
    for (int i = 0; i < 3; i++) CHECK(eq(caps[i], "svfa"));
    CHECK(n_of(seen[find("agents.end", NULL)], "total") == 3);
    // The ring's history follows it, once since the attach: its agents were on no ring sent before.
    CHECK(count("summary", NULL) == 3 && find("summary", NULL) > find("agents.end", NULL));
    for (int i = find("summary", NULL); i >= 0; i = find_from(i + 1, "summary", NULL)) CHECK(b_of(seen[i], "restore"));
    // The app already shown: nothing.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"harness\"}");
    run(50);
    CHECK(count("apps", NULL) == 0 && count("agents.begin", NULL) == 0);
    // An app the daemon does not list: the list is told again, and the bar keeps the ring it holds.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"nope\"}");
    say("{\"t\":\"app.pick\",\"app\":\"Orca\"}");
    run(50);
    CHECK(count("apps", NULL) == 2 && count("agents.begin", NULL) == 0 && find_shown(0, "harness") >= 0);
    // Longer than an app id, or no app at all: dropped unanswered, as cableSession.ts drops them.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"0123456789abcdefg\"}");
    say("{\"t\":\"app.pick\",\"app\":7}");
    say("{\"t\":\"app.pick\"}");
    run(50);
    CHECK(count("apps", NULL) == 0 && count("agents.begin", NULL) == 0);
    // An app listed with no agents has no ring to turn to: the list is told again, as for one the daemon does not list.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"cursor\"}");
    run(50);
    CHECK(count("apps", NULL) == 1 && count("agents.begin", NULL) == 0 && find_shown(0, "harness") >= 0);
    CHECK(n_of(app_row(seen[find("apps", NULL)], "cursor"), "count") == 0);
    // herdr's two, which the bar watches and talks to, with their history.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"herdr\"}");
    run(50);
    ring_is("herdr", HERDR_RING, 2);
    CHECK(eq(caps[0], "sv") && eq(caps[1], "sv") && count("summary", NULL) == 2);
    // VS Code's one agent, which the bar may only watch.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"vscode\"}");
    run(50);
    static const char *const vscode[] = {"api-client"};
    ring_is("vscode", vscode, 1);
    CHECK(eq(caps[0], "s"));
    CHECK(count("summary", NULL) == 1 && b_of(seen[find("summary", NULL)], "restore"));
    // Back to a ring whose history the bar already has: the ring alone.
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"harness\"}");
    run(50);
    CHECK(count("agents.begin", NULL) == 1 && count("summary", NULL) == 0);
    forget();
    say("{\"t\":\"app.pick\",\"app\":\"vscode\"}");
    run(50);
    CHECK(find_shown(0, "vscode") >= 0 && count("summary", NULL) == 0);

    // The pick holds until another app comes to the front: Harness, at 70 s of the story, after the person's quiet minute.
    forget();
    run(120000);
    for (int i = find("apps", NULL); i >= 0; i = find_from(i + 1, "apps", NULL)) CHECK(eq(s_of(seen[i], "shown"), "vscode"));
    CHECK(count("agents.begin", NULL) == 0);
    run(15000);
    a = find_shown(0, "harness");
    CHECK(a >= 0 && eq(s_of(seen[a + 1], "t"), "agents.begin"));
}

// The app in front moves on the computer during the story: Orca, then Harness at 70 s, then Orca at 130 s. Each move
// is `apps` and the new ring, at the moment the daemon's 1 s settle ends.
static void test_front_moves(void)
{
    attach();   // its push is the first `apps`: Orca's
    run(165000);
    char order[8][16];
    int n = 0;
    for (int i = find("apps", NULL); i >= 0; i = find_from(i + 1, "apps", NULL)) {
        const char *shown = s_of(seen[i], "shown");
        if (n && eq(order[n - 1], shown)) continue;   // the same app, its counts changed: no ring
        CHECK(n < 8);
        snprintf(order[n++], sizeof order[0], "%s", shown);
        CHECK(eq(s_of(seen[i + 1], "t"), "agents.begin"));
    }
    CHECK(n == 3 && eq(order[0], "orca") && eq(order[1], "harness") && eq(order[2], "orca"));
    const int to_harness = find_shown(0, "harness");
    CHECK(seen_at[to_harness] >= 71000 && seen_at[to_harness] <= 71100);   // attached at 1 s: story 70 s
    const int to_orca = find_shown(to_harness, "orca");
    CHECK(seen_at[to_orca] >= 131000 && seen_at[to_orca] <= 131100);
    // Each ring is that app's.
    for (int i = to_harness + 1; !eq(s_of(seen[i], "t"), "agents.end"); i++)
        if (eq(s_of(seen[i], "t"), "agent")) CHECK(eq(s_of(seen[i], "host"), "harness"));

    // Nothing moves while a person is at the bar: the story waits for their quiet minute.
    attach();
    forget();
    run(60000);
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("auth-refactor"));
    run(55000);
    CHECK(find_shown(0, "harness") < 0);
    run(20000);
    CHECK(find_shown(0, "harness") >= 0);
}

static void test_open_and_focus(void)
{
    attach();
    // Another app's agent, tapped in Inbox: the bar is turned to its app's ring, on it (decision 7 A).
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("firmware-max"));
    run(50);
    int a = find("apps", NULL);
    CHECK(a >= 0 && eq(s_of(seen[a], "shown"), "harness") && eq(s_of(seen[a + 1], "t"), "agents.begin"));
    ring_is("harness", HARNESS_RING, 3);
    int f = find("focus", NULL);
    CHECK(f > find("agents.end", NULL) && eq(s_of(seen[f], "agentId"), id_of("firmware-max")) && count("focus", NULL) == 1);
    // A question screen that came up by itself, or an agent nobody lists, moves nothing.
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\",\"reason\":\"question\"}", id_of("landing-hero"));
    say("{\"t\":\"agent.open\",\"agentId\":\"nobody\"}");
    run(50);
    CHECK(count("focus", NULL) == 0 && count("apps", NULL) == 0);
    // An agent of the ring shown: brought up on the computer, and the bar is told so.
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("harness-cli"));
    run(50);
    f = find("focus", NULL);
    CHECK(f >= 0 && eq(s_of(seen[f], "agentId"), id_of("harness-cli")) && count("apps", NULL) == 0);
    // The record is re-asserted after a push, as the daemon does.
    forget();
    say("{\"t\":\"agents.refresh\"}");
    run(50);
    f = find("focus", NULL);
    CHECK(f > find("agents.end", NULL) && eq(s_of(seen[f], "agentId"), id_of("harness-cli")));
    // Back to an Orca agent: Orca's ring, on it.
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("flaky-e2e"));
    run(50);
    CHECK(find_shown(0, "orca") >= 0);
    ring_is("orca", ORCA_RING, 5);
    f = find("focus", NULL);
    CHECK(f > find("agents.end", NULL) && eq(s_of(seen[f], "agentId"), id_of("flaky-e2e")));
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
    // Talk to docs-sweep, which rests through the story.
    const char *sweep = id_of("docs-sweep");
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"lang\":\"en\",\"sr\":16000,\"uploadId\":\"up-1\"}", sweep);
    pcm(32000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-1\"}");
    run(300);
    CHECK(count("voice.transcript", NULL) == 0);   // a moment to think first
    int at = wait_for("voice.transcript", NULL, 5000);
    CHECK(at >= 0);
    const cJSON *v = seen[at];
    CHECK(eq(s_of(v, "agentId"), sweep) && eq(s_of(v, "agentName"), "docs-sweep") && eq(s_of(v, "uploadId"), "up-1"));
    // The mockup's line for that agent, which is also the status of the turn it starts.
    CHECK(eq(s_of(v, "routeId"), "") && !b_of(v, "needsConfirm") && eq(s_of(v, "text"), "Sweep the setup docs for dead links"));
    // ...and that agent goes to work on it, then answers.
    int started = wait_for("turn.started", sweep, 3000);
    CHECK(started > at && eq(s_of(seen[started], "text"), "Sweep the setup docs for dead links"));
    CHECK(wait_news(sweep, 40000) > started);

    // VS Code's agent takes no words from the bar: the daemon's refusal, before anything else is said of the recording.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-v\"}", id_of("api-client"));
    pcm(32000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-v\"}");
    run(50);
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-w\"}", id_of("api-client"));
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-w\"}");
    run(5000);
    CHECK(count("voice.error", NULL) == 2 && count("voice.transcript", NULL) == 0);
    for (int i = find("voice.error", NULL); i >= 0; i = find_from(i + 1, "voice.error", NULL))
        CHECK(eq(s_of(seen[i], "message"), "This agent is in VS Code. Talking to it from the device comes in an update."));

    // Nothing recorded: the daemon's own words.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-2\"}", sweep);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-2\"}");
    run(50);
    at = find("voice.error", NULL);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "Didn't catch that") && eq(s_of(seen[at], "uploadId"), "up-2"));

    // Aborted: nothing comes back, and an end for another upload is not this one's.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-3\"}", sweep);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"other\"}");
    say("{\"t\":\"voice.abort\",\"uploadId\":\"up-3\"}");
    run(5000);
    CHECK(count("voice.transcript", NULL) == 0 && count("voice.error", NULL) == 0);
    // Discarded after its end, while its words are on their way: they never come (main's voiceGeneration).
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-3b\"}", sweep);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-3b\"}");
    run(200);
    say("{\"t\":\"voice.abort\",\"uploadId\":\"up-3b\",\"why\":\"discarded\"}");
    run(5000);
    CHECK(count("voice.transcript", NULL) == 0 && count("voice.error", NULL) == 0);
    // An abort queued for an earlier recording does not cancel this one.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-3c\"}", sweep);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-3c\"}");
    run(200);
    say("{\"t\":\"voice.abort\",\"uploadId\":\"up-3b\",\"why\":\"discarded\"}");
    run(5000);
    CHECK(count("voice.transcript", NULL) == 1 && eq(s_of(seen[find("voice.transcript", NULL)], "uploadId"), "up-3c"));

    // A new recording drops the reply the last one was waiting on.
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-4\"}", sweep);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-4\"}");
    run(200);
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"up-5\"}", sweep);
    pcm(8000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-5\"}");
    run(5000);
    CHECK(count("voice.transcript", NULL) == 1 && eq(s_of(seen[find("voice.transcript", NULL)], "uploadId"), "up-5"));

    // No agent named: the words go to the one the bar is on.
    run(60000);
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("rate-limiter"));
    forget();
    say("{\"t\":\"voice.begin\",\"uploadId\":\"up-6\"}");
    pcm(16000);
    say("{\"t\":\"voice.end\",\"uploadId\":\"up-6\"}");
    at = wait_for("voice.transcript", NULL, 5000);
    CHECK(at >= 0 && eq(s_of(seen[at], "agentId"), id_of("rate-limiter")));

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
    int at = wait_for("question", id_of(name), 120000);
    CHECK(at >= 0);
    return at;
}

// The story on its own, once round: every page's beat.
static void test_beats(void)
{
    attach();
    forget();
    run(155000);
    const char *auth = id_of("auth-refactor"), *hero = id_of("landing-hero"), *e2e = id_of("flaky-e2e");
    const char *rate = id_of("rate-limiter"), *cli = id_of("harness-cli"), *fw = id_of("firmware-max");
    // Orca's agents at work: spinner words, and steps under them.
    bool planning = false, editing = false, session = false;
    for (int i = find("turn.activity", auth); i >= 0; i = find_from(i + 1, "turn.activity", auth)) {
        planning |= eq(s_of(seen[i], "text"), "Planning");
        editing |= eq(s_of(seen[i], "text"), "Editing");
        session |= eq(s_of(seen[i], "step"), "Edit \xc2\xb7 session.ts");
    }
    CHECK(planning && editing && session);

    // landing-hero asks in Orca, which answers it: a question the bar only shows, as the daemon asks it of an agent the
    // device may not answer (services/devices.ts: shown:<id>, one prompt naming the app, its one option the app).
    // As main sends a question, the frame is its summary: the words of the inbox's prompt; the whole of it is read.
    int q = find("question", hero);
    CHECK(q >= 0 && !strncmp(s_of(seen[q], "id"), "shown:", 6) && !has(seen[q], "permission"));
    const char *words = "Use the new image in the hero, or keep the video? \xc2\xb7 answer in Orca";
    CHECK(eq(s_of(summary_row(seen[q]), "q"), words));
    CHECK(eq(s_of(seen[q], "name"), "landing-hero") && eq(s_of(seen[q], "machine"), "MacBook Pro"));
    // The drawer is redrawn after it, the question's row first, in the same words.
    const int drawn = find_from(q, "notif.replace", NULL);
    CHECK(drawn > q);
    const cJSON *first = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[drawn], "items"), 0);
    CHECK(eq(s_of(first, "agentId"), hero) && b_of(first, "question") && eq(s_of(first, "summary"), words));
    const int hero_closed = find_from(q, "question.close", hero);
    CHECK(hero_closed > q && eq(s_of(seen[hero_closed], "id"), s_of(seen[q], "id")));
    // Closed, its row goes with the next drawer.
    const int redrawn = find_from(hero_closed, "notif.replace", NULL);
    CHECK(redrawn > hero_closed && !drawer_has(seen[redrawn], hero, true));
    CHECK(news_from(hero_closed, hero) > hero_closed);
    // The turn goes on after the answer without starting again: a turn.started would drop the bar's open question.
    CHECK(count("turn.started", hero) == 1);
    // While it waits, Orca's row in `apps` counts it.
    int waiting = find_from(q, "apps", NULL);
    CHECK(waiting > q && n_of(app_row(seen[waiting], "orca"), "waiting") == 1);

    // flaky-e2e ends loud.
    int done = news(e2e);
    CHECK(done >= 0 && eq(s_of(seen[done], "tier"), "alert") && find("turn.done", e2e) < done);
    // rate-limiter fails, then is fixed.
    int failed = find("turn.error", rate);
    CHECK(failed >= 0 && strlen(s_of(seen[failed], "message")) > 0);
    CHECK(find_from(failed, "turn.started", rate) > failed && news_from(failed, rate) > failed);

    // harness-cli asks what the bar answers.
    q = find("question", cli);
    CHECK(q >= 0 && strncmp(s_of(seen[q], "id"), "shown:", 6) && !has(seen[q], "permission"));
    CHECK(eq(s_of(summary_row(seen[q]), "q"), "Bump the cable protocol to 4, or keep 3 and add a field?"));
    // firmware-max asks for a permission: the Max's daemon marks it on the summary, so the bar draws approve and deny.
    q = find("question", fw);
    CHECK(q >= 0 && b_of(seen[q], "permission") && strncmp(s_of(seen[q], "id"), "shown:", 6));
    CHECK(eq(s_of(summary_row(seen[q]), "q"), "Bash: idf.py -p /dev/ttyACM0 flash"));
    // While both wait, Harness's row counts two.
    waiting = find_from(q, "apps", NULL);
    CHECK(waiting > q && n_of(app_row(seen[waiting], "harness"), "waiting") == 2);
    // Nobody at the bar: both are answered on the computer, with their first option, and the turns go on.
    CHECK(find("question.close", cli) > 0 && find("question.close", fw) > 0);
    CHECK(news(cli) >= 0 && strstr(s_of(seen[news(cli)], "recap"), "4"));
    CHECK(news(fw) >= 0 && strstr(s_of(seen[news(fw)], "recap"), "flashed"));
    CHECK(count("turn.started", cli) == 1 && count("turn.started", fw) == 1);
    // docs finishes; docs-sweep and api-client rest.
    CHECK(news(id_of("docs")) >= 0);
    CHECK(count("turn.started", id_of("docs-sweep")) == 0 && count("turn.started", id_of("api-client")) == 0);
}

// Left alone, a question the bar only shows is answered in its app after 12 s, one the bar answers after 40 s; and the
// story's failure comes after Orca's question closed, so its Attention is not held behind the question.
static void test_unattended_waits(void)
{
    attach();
    const char *hero = id_of("landing-hero"), *cli = id_of("harness-cli"), *rate = id_of("rate-limiter");
    until_asked("landing-hero");
    forget();
    run(11500);
    CHECK(find("question.close", hero) < 0);
    run(1000);
    CHECK(find("question.close", hero) >= 0);
    const int failed = wait_for("turn.error", rate, 30000);
    CHECK(failed >= 0 && find("question.close", hero) < failed);
    until_asked("harness-cli");
    forget();
    run(39000);
    CHECK(find("question.close", cli) < 0);
    run(2000);
    CHECK(find("question.close", cli) >= 0);
}

// An Orca agent's question: the bar shows it and cannot answer it. A tap brings it up in Orca, which answers it.
static void test_outside_question(void)
{
    attach();
    const char *hero = id_of("landing-hero");
    int q = until_asked("landing-hero");
    char qid[64];
    snprintf(qid, sizeof qid, "%s", s_of(seen[q], "id"));
    // Read: the daemon's inbox holds it, and it takes no spoken answer.
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"r1\"}", hero);
    run(50);
    int st = find("question.state", NULL);
    CHECK(st >= 0 && b_of(seen[st], "ok") && eq(s_of(seen[st], "id"), qid));
    CHECK(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[st], "questions"), 0), "canText")));
    char token[64];
    snprintf(token, sizeof token, "%s", s_of(seen[st], "token"));
    // An answer from the bar is refused in the daemon's words, either way it comes.
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"r2\",\"choices\":[1]}", hero, token);
    sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"%s\",\"answers\":{\"prompt\":\"In Orca\"}}", hero, qid);
    run(50);
    int r = find("answer.receipt", NULL);
    CHECK(r >= 0 && !b_of(seen[r], "ok") && eq(s_of(seen[r], "error"), "Answer it in Orca."));
    int t = find("toast", NULL);
    CHECK(t >= 0 && eq(s_of(seen[t], "text"), "Answer it in Orca."));
    CHECK(count("question.close", NULL) == 0);
    // The tap brings it up in Orca, where the person answers it a moment later; the turn goes on.
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", hero);
    run(50);
    CHECK(eq(s_of(seen[find("focus", NULL)], "agentId"), hero));
    run(5000);
    CHECK(count("question.close", hero) == 0);
    run(2000);
    int closed = find("question.close", hero);
    CHECK(closed >= 0 && eq(s_of(seen[closed], "id"), qid));
    CHECK(wait_news(hero, 20000) > closed);
    // A stop from the bar is refused for an agent outside Harness.
    forget();
    sayf("{\"t\":\"turn.stop\",\"agentId\":\"%s\"}", id_of("flaky-e2e"));
    run(50);
    t = find("toast", NULL);
    CHECK(t >= 0 && eq(s_of(seen[t], "text"), "This agent is in Orca. Stopping it from the device comes in an update."));
    CHECK(count("turn.done", NULL) == 0);
}

static void test_question(void)
{
    attach();
    const char *cli = id_of("harness-cli");
    int q = until_asked("harness-cli");
    const cJSON *questions = cJSON_GetObjectItemCaseSensitive(seen[q], "questions");
    CHECK(cJSON_GetArraySize(questions) == 1);
    CHECK(eq(s_of(seen[q], "name"), "harness-cli") && eq(s_of(seen[q], "machine"), "MacBook Pro"));
    CHECK(!has(seen[q], "permission"));   // a plain question carries no mark
    char qid[64];
    snprintf(qid, sizeof qid, "%s", s_of(seen[q], "id"));
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", cli);   // a person is here: the story waits for them

    // Read it: the token that names these exact contents.
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"rq-1\"}", cli);
    run(50);
    int st = find("question.state", NULL);
    CHECK(st >= 0 && b_of(seen[st], "ok") && eq(s_of(seen[st], "requestId"), "rq-1") && eq(s_of(seen[st], "id"), qid));
    CHECK(!b_of(seen[st], "submitted"));
    // A Harness agent may take spoken words: no canText:false on its questions.
    const cJSON *whole = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(seen[st], "questions"), 0);
    CHECK(!has(whole, "canText"));
    // The whole of it, which the frame left out: its words and both options.
    CHECK(eq(s_of(whole, "q"), "Bump the cable protocol to 4, or keep 3 and add a field?"));
    CHECK(eq(options_of(seen[st]), "Bump to 4|Keep 3") && eq(s_of(seen[st], "engine"), "claude"));
    char token[64];
    snprintf(token, sizeof token, "%s", s_of(seen[st], "token"));

    // A wrong token, a wrong count and a mask with no option are refused in the daemon's words.
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"stale\",\"requestId\":\"rq-2\",\"choices\":[1]}", cli);
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-3\",\"choices\":[1,1]}", cli, token);
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-4\",\"choices\":[4]}", cli, token);
    run(50);
    CHECK(count("answer.receipt", NULL) == 3);
    CHECK(eq(s_of(seen[0], "error"), "This question changed. Open it again.") && eq(s_of(seen[0], "token"), "stale"));
    CHECK(eq(s_of(seen[1], "error"), "Review every answer first."));
    CHECK(eq(s_of(seen[2], "error"), "Choose an answer from this question."));
    for (int i = 0; i < 3; i++) CHECK(!b_of(seen[i], "ok"));
    CHECK(count("question.close", NULL) == 0);

    // The second option: taken, the dialog closes, and the agent goes on with that choice.
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-5\",\"choices\":[2]}", cli, token);
    run(50);
    int r = find("answer.receipt", NULL);
    CHECK(r >= 0 && b_of(seen[r], "ok") && !has(seen[r], "pending") && eq(s_of(seen[r], "requestId"), "rq-5"));
    // Sent twice, done once: the same receipt, no second answer.
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"rq-6\",\"choices\":[2]}", cli, token);
    run(50);
    CHECK(count("answer.receipt", NULL) == 2 && b_of(seen[find_from(r + 1, "answer.receipt", NULL)], "ok"));
    int closed = wait_for("question.close", cli, 3000);
    CHECK(closed >= 0 && eq(s_of(seen[closed], "id"), qid));
    CHECK(count("question.close", cli) == 1);
    int done = wait_news(cli, 40000);
    CHECK(done > closed && strstr(s_of(seen[done], "text"), "stays at 3"));
    CHECK(eq(s_of(seen[done], "tier"), "alert") && has(seen[done], "full"));
    CHECK(find("turn.stats", cli) >= 0 && find("turn.done", cli) < done);
    // Closed: there is nothing left to read.
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"rq-7\"}", cli);
    run(50);
    st = find("question.state", NULL);
    CHECK(st >= 0 && !b_of(seen[st], "ok") && eq(s_of(seen[st], "error"), "No readable question. Check the terminal."));
}

static void test_question_legacy_answer(void)
{
    attach();
    const char *cli = id_of("harness-cli");
    int q = until_asked("harness-cli");
    char qid[64], key[256];
    snprintf(qid, sizeof qid, "%s", s_of(seen[q], "id"));
    // The frame's row is a summary with no key: the key asked with is read off the whole question.
    const cJSON *st = read_question(cli, "lq");
    snprintf(key, sizeof key, "%s", s_of(cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(st, "questions"), 0), "key"));
    CHECK(key[0]);
    forget();
    // An answer for another request is not this one's.
    sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"old\",\"answers\":{\"%s\":\"Keep 3\"}}", cli, key);
    run(3000);
    CHECK(count("question.close", NULL) == 0);
    sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"%s\",\"answers\":{\"%s\":\"Keep 3\"}}", cli, qid, key);
    int closed = wait_for("question.close", cli, 3000);
    CHECK(closed >= 0 && count("answer.receipt", NULL) == 0 && count("toast", NULL) == 0);   // the old answer: no receipt
    int done = wait_news(cli, 40000);
    CHECK(done > closed && strstr(s_of(seen[done], "text"), "stays at 3"));
}

static void test_permission(void)
{
    // Allowed: the bar is flashed.
    attach();
    const char *fw = id_of("firmware-max");
    int q = until_asked("firmware-max");
    CHECK(eq(s_of(summary_row(seen[q]), "q"), "Bash: idf.py -p /dev/ttyACM0 flash"));
    CHECK(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(seen[q], "permission")));   // drawn as approve/deny
    CHECK(eq(options_of(read_question(fw, "p0")), "Allow|Deny"));
    // A resync gives it back as the drawer's row, as main's drawer carries an open question: never a second ring.
    forget();
    say("{\"t\":\"resync\"}");
    run(50);
    const int d = find("notif.replace", NULL);
    CHECK(count("question", NULL) == 0 && d >= 0 && drawer_has(seen[d], fw, true));
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"p1\"}", fw);
    run(50);
    int st = find("question.state", NULL);
    CHECK(st >= 0 && b_of(seen[st], "ok"));
    char token[64];
    snprintf(token, sizeof token, "%s", s_of(seen[st], "token"));
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"p2\",\"choices\":[1]}", fw, token);
    run(50);
    int r = find("answer.receipt", NULL);
    CHECK(r >= 0 && b_of(seen[r], "ok") && !has(seen[r], "pending"));   // this computer takes it at once
    CHECK(wait_for("question.close", fw, 3000) >= 0);
    int done = wait_news(fw, 40000);
    CHECK(done >= 0 && strstr(s_of(seen[done], "recap"), "flashed") && eq(s_of(seen[done], "tier"), "alert"));
    CHECK(find("turn.error", fw) < 0);

    // Denied: it stops.
    attach();
    q = until_asked("firmware-max");
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"p3\"}", fw);
    run(50);
    snprintf(token, sizeof token, "%s", s_of(seen[find("question.state", NULL)], "token"));
    forget();
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"p4\",\"choices\":[2]}", fw, token);
    CHECK(wait_for("question.close", fw, 3000) >= 0);
    done = wait_news(fw, 10000);
    CHECK(done >= 0 && strstr(s_of(seen[done], "recap"), "Stopped") && eq(s_of(seen[done], "tier"), "list"));
    CHECK(find("turn.done", fw) >= 0 && find("turn.done", fw) < done);
    // ...and does no more work in this turn.
    run(30000);
    CHECK(count("turn.activity", fw) == 0);
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

    // Up to the project row, open its list, walk to the last project and choose it.
    s = form_rev("move", -1);
    CHECK(b_of(s, "ok") && eq(s_of(s, "label"), "Project") && eq(s_of(s, "action"), "open") && b_of(s, "canQuery"));
    CHECK(n_of(s, "revision") > first_revision);
    s = form_rev("activate", 0);
    CHECK(eq(s_of(s, "title"), "Project") && eq(s_of(s, "action"), "choose") && n_of(s, "total") == 3);
    s = form_rev("move", 2);
    CHECK(eq(s_of(s, "label"), "infra") && eq(s_of(s, "detail"), "~/work/infra"));
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
    // The new agent arrives in Harness, whose window comes to the front: the bar shows Harness's ring, on the new agent.
    int end = -1;
    for (int tries = 0; tries < 50 && end < 0; tries++) {
        run(100);
        for (int i = 0; i < seen_n; i++)
            if (eq(s_of(seen[i], "t"), "agents.end") && n_of(seen[i], "total") == 4) end = i;
    }
    CHECK(end >= 0);
    CHECK(find_shown(0, "harness") >= 0 && n_of(app_row(seen[find_shown(0, "harness")], "harness"), "count") == 4);
    static const char *const ring[] = {"firmware-max", "harness-cli", "docs", "infra"};
    ring_is("harness", ring, 4);
    CHECK(eq(caps[3], "svfa") && eq(engines[3], "claude"));
    int f = find_from(end, "focus", NULL);
    CHECK(f > end && eq(s_of(seen[f], "agentId"), ids[3]));
    CHECK(wait_for("turn.started", ids[3], 3000) >= 0);
    // The form has gone from the window.
    s = form("state", "\"revision\":0");
    CHECK(b_of(s, "ok") && !b_of(s, "active") && !has(s, "revision"));

    // A quiet minute and the end of the story's loop take the person's agents away again.
    run(300000);
    say("{\"t\":\"app.pick\",\"app\":\"orca\"}");
    say("{\"t\":\"app.pick\",\"app\":\"harness\"}");
    run(50);
    ring_is("harness", HARNESS_RING, 3);
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
    run(160000);
    const int started = count("turn.started", NULL);
    CHECK(started == 9);
    CHECK(count("question", NULL) == 3);
    CHECK(count("question.close", NULL) == 3);   // answered on the computer when nobody is at the bar
    CHECK(count("turn.error", NULL) == 1);
    CHECK(count("turn.done", NULL) == 8);
    int tiers[3] = {0, 0, 0};
    for (int i = 0; i < seen_n; i++) {
        if (!eq(s_of(seen[i], "t"), "summary")) continue;
        tiers[0] += eq(s_of(seen[i], "tier"), "alert");
        tiers[1] += eq(s_of(seen[i], "tier"), "list");
        tiers[2] += eq(s_of(seen[i], "tier"), "silent");
    }
    CHECK(tiers[0] == 3 && tiers[1] == 4 && tiers[2] == 1);
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
    run(160000);
    CHECK(count("turn.started", NULL) == started);
    CHECK(count("question", NULL) == 3 && count("turn.error", NULL) == 1);
}

// A person takes over: the story starts nothing new for a quiet minute, then goes on.
static void test_person_takes_over(void)
{
    attach();
    forget();
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", id_of("rate-limiter"));
    run(55000);
    CHECK(count("turn.started", NULL) == 0);
    CHECK(count("ping", NULL) >= 10);
    run(10000);
    CHECK(count("turn.started", NULL) >= 1);

    // The Max reads a question the moment it arrives, with nobody at the bar: that read is no person, and the
    // question is still answered on the computer when its wait is up.
    attach();
    const char *cli = id_of("harness-cli");
    until_asked("harness-cli");
    forget();
    sayf("{\"t\":\"question.read\",\"agentId\":\"%s\",\"requestId\":\"k0\"}", cli);
    run(45000);
    CHECK(count("question.close", cli) == 1);

    // An open question waits for a person, however long they stay.
    attach();
    until_asked("harness-cli");
    for (int i = 0; i < 6; i++) {
        sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", cli);
        run(20000);
    }
    CHECK(count("question.close", cli) == 0);
    // Left alone, it is answered on the computer after the quiet minute and a while more.
    run(120000);
    CHECK(count("question.close", cli) == 1);

    // The drawer on a fresh attach holds the open question, and the finished answers not yet seen.
    attach();
    until_asked("harness-cli");   // flaky-e2e has finished, loud, long before
    forget();
    say("{\"t\":\"resync\"}");
    run(50);
    int d = find("notif.replace", NULL);
    CHECK(d >= 0);
    bool question = false, finished = false;
    const char *token = NULL;
    const cJSON *row;
    cJSON_ArrayForEach(row, cJSON_GetObjectItemCaseSensitive(seen[d], "items")) {
        question |= b_of(row, "question") && eq(s_of(row, "agentId"), cli);
        if (!b_of(row, "question") && eq(s_of(row, "agentId"), id_of("flaky-e2e"))) { finished = true; token = s_of(row, "readToken"); }
    }
    CHECK(question && finished && token);
    char tok[64];
    snprintf(tok, sizeof tok, "%s", token);
    forget();
    sayf("{\"t\":\"notif.read\",\"agentId\":\"%s\",\"readToken\":\"%s\"}", id_of("flaky-e2e"), tok);
    run(50);
    int seen_at_ = find("notif.seen", NULL);
    CHECK(seen_at_ >= 0 && eq(s_of(seen[seen_at_], "readToken"), tok));
}

// main's drawer (replaceNotifications): the open questions first, in their frames' words, then the answers not yet
// read, one row per agent, at most eight. It is sent again whenever its rows change, after the frames that changed them.
static void test_drawer(void)
{
    attach();
    const char *e2e = id_of("flaky-e2e"), *cli = id_of("harness-cli"), *fw = id_of("firmware-max");
    const int q = until_asked("harness-cli");
    // flaky-e2e's loud answer put its row in the drawer, with the token that reads it.
    const int done = news(e2e);
    const int with_news = find_from(done, "notif.replace", NULL);
    CHECK(done >= 0 && with_news > done && drawer_has(seen[with_news], e2e, false));
    // harness-cli's question, right after its frame: first, as the frame words it, and no token.
    const int d = find_from(q, "notif.replace", NULL);
    CHECK(d > q);
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(seen[d], "items");
    const cJSON *first = cJSON_GetArrayItem(items, 0);
    CHECK(eq(s_of(first, "agentId"), cli) && b_of(first, "question") && !has(first, "readToken"));
    CHECK(eq(s_of(first, "summary"), s_of(summary_row(seen[q]), "q")));
    CHECK(cJSON_GetArraySize(items) <= 8);
    bool had_news = false;
    const cJSON *row, *other;
    cJSON_ArrayForEach(row, items) {
        // Questions before news; one row per agent.
        if (b_of(row, "question")) CHECK(!had_news);
        else had_news = true;
        CHECK(b_of(row, "question") != has(row, "readToken"));
        int same = 0;
        cJSON_ArrayForEach(other, items) same += eq(s_of(other, "agentId"), s_of(row, "agentId"));
        CHECK(same == 1);
    }
    CHECK(had_news);
    char token[64] = "";
    cJSON_ArrayForEach(row, items) if (eq(s_of(row, "agentId"), e2e)) snprintf(token, sizeof token, "%s", s_of(row, "readToken"));
    CHECK(token[0]);
    // Read on the bar: notif.seen, then the drawer without that row.
    forget();
    sayf("{\"t\":\"notif.read\",\"agentId\":\"%s\",\"readToken\":\"%s\"}", e2e, token);
    run(50);
    const int read = find("notif.seen", NULL);
    const int after = find_from(read, "notif.replace", NULL);
    CHECK(read >= 0 && after > read && count("notif.replace", NULL) == 1);
    CHECK(!drawer_has(seen[after], e2e, false) && drawer_has(seen[after], cli, true));
    // firmware-max asks too: both questions lead.
    const int fq = wait_for("question", fw, 30000);
    const int both = find_from(fq, "notif.replace", NULL);
    CHECK(fq >= 0 && both > fq);
    items = cJSON_GetObjectItemCaseSensitive(seen[both], "items");
    CHECK(b_of(cJSON_GetArrayItem(items, 0), "question") && b_of(cJSON_GetArrayItem(items, 1), "question"));
    CHECK(drawer_has(seen[both], cli, true) && drawer_has(seen[both], fw, true));
    // A greeting with questions open: its push's drawer carries them, and no question frame rings them again (main's
    // greeting asks only what its drawer could not hold, and the demo never has eight questions open).
    forget();
    say(HELLO_MAX_TIER);
    run(50);
    const int g = find("notif.replace", NULL);
    CHECK(count("welcome", NULL) == 1 && count("question", NULL) == 0 && g >= 0);
    CHECK(drawer_has(seen[g], cli, true) && drawer_has(seen[g], fw, true));
}

// Words to `name` from the bar, with seen forgotten first; the transcript's index.
static int talk(const char *name)
{
    static int upload;
    forget();
    sayf("{\"t\":\"voice.begin\",\"agentId\":\"%s\",\"uploadId\":\"pm-%d\"}", id_of(name), ++upload);
    pcm(16000);
    sayf("{\"t\":\"voice.end\",\"uploadId\":\"pm-%d\"}", upload);
    const int at = wait_for("voice.transcript", NULL, 5000);
    CHECK(at >= 0 && eq(s_of(seen[at], "agentId"), id_of(name)));
    return at;
}
// Words to `name` that are heard as `line` and start its turn, with `line` as the turn's status.
static void heard(const char *name, const char *line)
{
    const int at = talk(name);
    CHECK(eq(s_of(seen[at], "text"), line));
    const int started = wait_for("turn.started", id_of(name), 3000);
    CHECK(started > at && eq(s_of(seen[started], "text"), line));
}

// The demo a person drives (`--demo`): nothing moves by itself. What they say to an agent is the mockup's line for it,
// and the turn it starts; the four agents with a case play it, then their line, then the case again.
static void test_person_mode(void)
{
    attach_as(false);
    const char *rate = id_of("rate-limiter"), *hero = id_of("landing-hero"), *fw = id_of("firmware-max");
    const char *cli = id_of("harness-cli");
    // Five minutes alone: pings and the library, nothing else. No turn, no question, no app to the front, the drawer
    // as the attach drew it.
    forget();
    run(300000);
    CHECK(count("ping", NULL) >= 50 && count("player.library", NULL) > 0);
    CHECK(count("turn.started", NULL) == 0 && count("turn.activity", NULL) == 0 && count("question", NULL) == 0);
    CHECK(count("apps", NULL) == 0 && count("agents.begin", NULL) == 0 && count("notif.replace", NULL) == 0);

    // rate-limiter's case: a test run that fails. Then its line, which ends well; then the case again.
    heard("rate-limiter", "Add a sliding-window limit to the public API");
    int at = wait_for("turn.error", rate, 30000);
    CHECK(at >= 0 && eq(s_of(seen[at], "message"), "npm test failed: 3 rate-limit tests time out"));
    heard("rate-limiter", "Start with the login route only");
    at = wait_news(rate, 30000);
    CHECK(at >= 0 && eq(s_of(seen[at], "recap"), "Only the login route is limited") && eq(s_of(seen[at], "tier"), "alert"));
    heard("rate-limiter", "Add a sliding-window limit to the public API");
    CHECK(wait_for("turn.error", rate, 30000) >= 0);

    // landing-hero's case: a question only Orca answers. Nobody answers it on the computer by itself...
    heard("landing-hero", "Freshen up the landing hero");
    at = wait_for("question", hero, 30000);
    CHECK(at >= 0 && !strncmp(s_of(seen[at], "id"), "shown:", 6));
    forget();
    run(120000);
    CHECK(count("question.close", NULL) == 0);
    // ...until it is brought up in Orca, where the person answers it a moment later.
    sayf("{\"t\":\"agent.open\",\"agentId\":\"%s\"}", hero);
    run(6050);
    CHECK(find("question.close", hero) >= 0);
    at = wait_news(hero, 20000);
    CHECK(at >= 0 && eq(s_of(seen[at], "recap"), "Hero uses the new image"));
    // It has no line of its own: the mockup's line for any other.
    heard("landing-hero", "Run the suite again before you push");
    at = wait_news(hero, 30000);
    CHECK(at >= 0 && eq(s_of(seen[at], "recap"), "The whole suite passes"));

    // firmware-max's case: the permission prompt. Words to it then do not answer it; they wait for the turn to end.
    heard("firmware-max", "Build the firmware with the app picker");
    at = wait_for("question", fw, 30000);
    CHECK(at >= 0 && b_of(seen[at], "permission"));
    at = talk("firmware-max");
    CHECK(eq(s_of(seen[at], "text"), "Flash it when the build is green"));
    run(3000);
    CHECK(count("question.close", NULL) == 0 && count("turn.started", NULL) == 0);
    char token[64];
    snprintf(token, sizeof token, "%s", s_of(read_question(fw, "pm-p"), "token"));
    sayf("{\"t\":\"answer.reviewed\",\"agentId\":\"%s\",\"token\":\"%s\",\"requestId\":\"pm-a\",\"choices\":[1]}", fw, token);
    at = wait_news(fw, 30000);
    CHECK(at >= 0 && eq(s_of(seen[at], "recap"), "The Max is flashed with the app picker"));
    const int next = wait_for("turn.started", fw, 5000);
    CHECK(next > at && eq(s_of(seen[next], "text"), "Flash it when the build is green"));
    run(15000);
    at = news_from(next, fw);
    CHECK(at > next && eq(s_of(seen[at], "recap"), "Built green and flashed"));

    // harness-cli's case: a question the bar answers. Words to it are the answer, with the line's option: Keep 3.
    heard("harness-cli", "Put the app list on the cable");
    CHECK(wait_for("question", cli, 30000) >= 0);
    at = talk("harness-cli");
    CHECK(eq(s_of(seen[at], "text"), "Keep three and add the field"));
    const int closed = wait_for("question.close", cli, 3000);
    CHECK(closed > at);
    at = wait_news(cli, 30000);
    CHECK(at > closed && strstr(s_of(seen[at], "text"), "stays at 3") && count("turn.started", NULL) == 0);
    // An answer is no new turn: its line comes next, as a turn of its own that asks nothing, then the case again.
    heard("harness-cli", "Keep three and add the field");
    CHECK(wait_news(cli, 30000) >= 0 && count("question", NULL) == 0);
    heard("harness-cli", "Put the app list on the cable");
    CHECK(wait_for("question", cli, 30000) >= 0);

    // The others say their line, or the line for any other: herdr's agents too.
    heard("auth-refactor", "Also cover the expired token case with a test");
    at = wait_news(id_of("auth-refactor"), 30000);
    CHECK(at >= 0 && eq(s_of(seen[at], "recap"), "Expired tokens are covered by a test"));
    heard("billing-export", "Run the suite again before you push");
    CHECK(wait_news(id_of("billing-export"), 30000) >= 0);

    // New Harness starts agents, which stay: the bar holds 14 in all.
    for (int i = 0; i < 4; i++) {
        forget();
        form("open", "\"surface\":\"new\"");
        form_rev("activate", 0);
        run(2000);
    }
    const cJSON *st = form("state", "\"revision\":0");
    CHECK(eq(s_of(st, "error"), "The bar holds 14 agents. Wait for one to finish."));
    forget();
    say("{\"t\":\"player.library.get\",\"offset\":0,\"request\":9}");
    run(50);
    CHECK(n_of(seen[find("player.library", NULL)], "total") == 14);
    run(600000);
    say("{\"t\":\"player.library.get\",\"offset\":0,\"request\":10}");
    run(50);
    CHECK(n_of(seen[find("player.library", NULL)], "total") == 14);
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
    say("{\"t\":\"machines.list\"}");
    run(50);
    CHECK(count("machine", NULL) == 1);
    char local[64];
    snprintf(local, sizeof local, "%s", s_of(seen[find("machine", NULL)], "id"));
    forget();
    sayf("{\"t\":\"machine.select\",\"machineId\":\"%s\"}", local);
    run(50);
    int sel = find("machine.selected", NULL);
    CHECK(sel >= 0 && eq(s_of(seen[sel], "machineId"), local));
    int end = find("machines.end", NULL);
    CHECK(end > sel && eq(s_of(seen[end], "selected"), local));
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
    const char *agent = known_n ? known_ids[rnd((uint32_t)known_n)] : "x";
    const char *agents[] = {agent, "nobody", "", "\\u0000"};
    const char *a = agents[rnd(4) ? 0 : rnd(4)];
    static const char *const apps[] = {"orca", "harness", "vscode", "herdr", "cursor", "nope", "", "0123456789abcdefg"};
    static int upload;
    switch (rnd(26)) {
    case 0: say(HELLO_MAX); break;
    case 1: say(HELLO_PRO); break;
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
    case 12: sayf("{\"t\":\"answer\",\"agentId\":\"%s\",\"requestId\":\"%sq%u\",\"answers\":{\"k\":\"Yes\"}}", a,
                  rnd(2) ? "shown:" : "", rnd(9)); break;
    case 13: {
        static const char *const ops[] = {"open", "state", "move", "activate", "back", "close", "bogus"};
        sayf("{\"t\":\"form\",\"op\":\"%s\",\"formId\":\"f%u\",\"requestId\":\"r%u\",\"revision\":%u,\"delta\":%d}", ops[rnd(7)],
             rnd(2), rnd(9), rnd(40), (int)rnd(5) - 2);
        break;
    }
    case 14: sayf("{\"t\":\"voice.begin\",\"formId\":\"f%u\",\"formRevision\":%u,\"uploadId\":\"u%d\"}", rnd(2), rnd(40), ++upload); break;
    case 15: sayf("{\"t\":\"player.library.get\",\"offset\":%u,\"request\":%u}", rnd(15), rnd(1000)); break;
    case 16: sayf("{\"t\":\"notif.read\",\"agentId\":\"%s\",\"readToken\":\"rt%u\"}", a, rnd(50)); break;
    case 17: sayf("{\"t\":\"machine.select\",\"machineId\":\"m-%s\"}", rnd(2) ? "mbp" : "x"); break;
    case 18: say("{\"t\":\"pong\"}"); break;
    case 19: sayf("{\"t\":\"voice.abort\",\"uploadId\":\"u%d\",\"why\":\"discarded\"}", upload - (int)rnd(2)); break;
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
    case 23: sayf("{\"t\":\"app.pick\",\"app\":\"%s\"}", apps[rnd(8)]); break;
    case 24: sayf("{\"t\":\"turn.stop\",\"agentId\":\"%s\"}", a); break;
    default: max_demo_receive((uint8_t)rnd(8), (const uint8_t *)"{}", 2, now); break;
    }
}

static void test_soak(bool self_playing)
{
    forget();
    known_n = 0;
    now = 0xFFFF0000u;   // across the clock's wrap too
    next_seq = -1;
    story = self_playing;
    reset_demo();
    say(HELLO_MAX);
    run(100);
    say("{\"t\":\"player.library.get\",\"offset\":3,\"request\":1}");
    run(10);
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
        if (seen_n > SEEN_MAX / 2) forget();
        CHECK((int32_t)(max_demo_next_ms(now) - now) <= 1000);
    }
    CHECK(now - last_frame_at < 10000);   // still talking at the end of the day
    CHECK(worst_frames <= 128 && worst_bytes <= 64 * 1024);
    CHECK(total < 400u * 1024u * 1024u);
    printf("soak (%s): 24 h, %zu KB sent, worst tick %zu frames / %zu B\n", self_playing ? "story" : "demo", total / 1024,
           worst_frames, worst_bytes);
}

int main(void)
{
    test_handshake();
    test_one_ring_without_app_filter();
    test_ping_and_silence();
    test_resync();
    test_app_pick();
    test_front_moves();
    test_open_and_focus();
    test_voice();
    test_beats();
    test_unattended_waits();
    test_outside_question();
    test_question();
    test_question_legacy_answer();
    test_permission();
    test_new_harness();
    test_form_voice();
    test_story_loops();
    test_person_takes_over();
    test_drawer();
    test_person_mode();
    test_machine_select();
    test_soak(true);
    test_soak(false);
    forget();
    printf("test_max_demo: %d checks passed\n", checks);
    return 0;
}
