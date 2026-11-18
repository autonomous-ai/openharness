// The scripted demo daemon: see max_demo.h.
//
// What it says, and in what order, is cableSession.ts's (cli/src/cable): the same messages and fields, so a bar showing
// this story shows a real computer the same way. It leaves out what only a real computer has: firmware updates, pets,
// windows and tabs, model lists, drafts and passages. One computer runs agents in three apps. A device that says
// appFilter (the Max) is shown one app's agents at a time, as the daemon shows them
// (docs/specs/2026-11-14-dial-app-filter.md); any other gets one ring of every agent.
#include "demo/max_demo.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "cable/cable_frame.h"
#include "cable/cable_json_guard.h"

enum {
    PING_MS = 5000,          // cableSession.ts PING_EVERY_MS: the device reads a longer gap as absence
    SILENCE_MS = 20000,      // cableSession.ts SILENCE_MS: the daemon closes the port and starts over
    RESYNC_GAP_MS = 2000,    // a device that lost its place is answered at most this often
    LIBRARY_MS = 10000,      // the library page is said again this often, as the daemon does
    QUIET_MS = 60000,        // a person's last touch holds the story this long
    CYCLE_MS = 160000,       // one telling of the story
    STEP_CAP_MS = 10000,     // a host that stalled does not fast-forward the story through the stall
    THINK_MS = 1500,         // from the end of a recording to its words
    CLOSE_MS = 1000,         // from an answer's receipt to its question closing (the agent taking it)
    OUTSIDE_MS = 6000,       // from a tap that brings up another app's question to the person answering it there
    VOICE_TURN_MS = 500,     // from the words to the agent starting on them
    CREATE_MS = 1500,        // New Harness starting an agent
    UNATTENDED_MS = 40000,   // story time an unanswered question waits before it is answered on the computer
    MIN_PCM = 3200,          // 0.1 s of 16 kHz, 16-bit audio: less is nothing said
    VOICE_MAX_BYTES = 10 * 60 * 32000,   // the daemon's ceiling on one recording
    MAX_AGENTS = 12,
    SCRIPTED = 9,
    PAGE_ROWS = 6,           // cableSession.ts: a library page
    DRAWER_ROWS = 8,
    ID_MAX = 64,             // the longest id the device may send that is said back
    APP_ID_MAX = 16,         // cableSession.ts: a longer app.pick is dropped unanswered
};

static bool due(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }

// ── the cast ────────────────────────────────────────────────────────────────────────────────────────

// The one computer, the one the cable is on.
#define MACHINE_ID "m-mbp"
#define MACHINE_NAME "MacBook Pro"

// The apps the agents run in, by hostDetect.ts's ids and names, in the order the daemon lists them, and what the
// device may do with each one's agents (services/devices.ts): s show, v talk to, f bring forward, a answer.
enum { APP_ORCA, APP_HARNESS, APP_VSCODE, N_APPS };
static const struct { const char *id, *name, *caps; } APPS[N_APPS] = {
    {"orca", "Orca", "sv"}, {"harness", "Harness", "svfa"}, {"vscode", "VS Code", "s"}};

static const char *const ENGINES[] = {"claude", "codex"};
static const char *const ENGINE_NAMES[] = {"Claude Code", "Codex"};

// A turn is a list of beats, each played some tenths of a second after the one before it.
enum { B_END, B_START, B_ACT, B_STEP, B_ASK, B_STATS, B_DONE, B_FAIL };
enum { TIER_ALERT, TIER_LIST, TIER_SILENT };
static const char *const TIERS[] = {"alert", "list", "silent"};

typedef struct question question_t;
typedef struct {
    uint8_t kind, tier;
    bool timer;              // B_ACT: the footer's timer rides along (elapsedSeconds)
    uint16_t wait_ds;
    const char *a, *b, *c;   // START: status. ACT: status, sentence. STEP: step. DONE: recap, text, full. FAIL: message
    const question_t *ask;
    uint16_t n[5];           // STATS: tests passed, failed, commits, thousands of tokens in, out
} beat_t;

// One question with up to three options; each answer goes on with its own beats. A permission prompt is one of these,
// sent with `permission: true` as the daemon marks one, so the bar draws it as approve/deny. An agent the device may
// not answer asks it shown-only: the bar draws the question and the app to answer it in, and the app answers with the
// first option. The beats after an answer start with no turn.started: the turn goes on.
struct question {
    const char *q;
    const char *options[3];
    uint8_t count;
    bool permission;
    const beat_t *next[3];
};

#define START(w, s) {.kind = B_START, .wait_ds = (w), .a = (s)}
#define ACT(w, s, said) {.kind = B_ACT, .wait_ds = (w), .a = (s), .b = (said)}
#define TIMER(w, s) {.kind = B_ACT, .wait_ds = (w), .a = (s), .timer = true}
#define STEP(w, s) {.kind = B_STEP, .wait_ds = (w), .a = (s)}
#define ASK(w, q) {.kind = B_ASK, .wait_ds = (w), .ask = &(q)}
#define STATS(w, p, f, c, i, o) {.kind = B_STATS, .wait_ds = (w), .n = {(p), (f), (c), (i), (o)}}
#define DONE(w, t, r, x, l) {.kind = B_DONE, .wait_ds = (w), .tier = (t), .a = (r), .b = (x), .c = (l)}
#define FAIL(w, m) {.kind = B_FAIL, .wait_ds = (w), .a = (m)}
#define END {.kind = B_END}

// Orca's auth-refactor: the session lookup out of the middleware, with spinner words and steps under them.
static const beat_t AUTH_SPLIT[] = {
    START(0, "Working…"),
    ACT(10, "Planning", "Splitting the auth middleware: the session lookup moves out of the request handler."),
    STEP(10, "Read · middleware.ts"),
    STEP(15, "Read · session.ts"),
    ACT(20, "Editing", "Moving the session lookup into its own module, with the cache beside it."),
    STEP(10, "Edit · session.ts"),
    STEP(20, "Edit · middleware.ts"),
    STEP(20, "Bash · npm test -- auth"),
    TIMER(30, "Running tests"),
    TIMER(30, "Running tests"),
    STATS(20, 64, 0, 1, 38, 6),
    DONE(0, TIER_LIST, "Session lookup split out of the auth middleware",
         "The session lookup lives in session.ts now and the middleware only calls it. 64/64 tests pass.",
         "Moved the session lookup and its cache out of the auth middleware into session.ts. The middleware calls "
         "getSession() and nothing else changed for callers. 64/64 tests pass. One commit: Split the session lookup."),
    END};
// ...and later, small work nobody needs to hear about.
static const beat_t AUTH_FOLLOW[] = {
    START(0, "Working…"),
    ACT(10, "Cleaning up", "Removing the old session helpers nothing calls any more."),
    STEP(10, "Edit · legacySession.ts"),
    STEP(15, "Bash · npm test -- auth"),
    TIMER(20, "Running tests"),
    STATS(15, 64, 0, 1, 9, 1),
    DONE(0, TIER_SILENT, "Removed the unused session helpers", "Three helpers nothing called are gone. 64/64 tests pass.",
         "Deleted legacySession.ts's three helpers, which nothing has called since the split. 64/64 tests pass. "
         "One commit: Remove unused session helpers."),
    END};

// Orca's landing-hero asks what only Orca can answer: the bar shows it, and says where.
static const beat_t HERO_IMAGE[] = {
    ACT(5, "Editing", "Swapping the hero video for the new image, with a blurred placeholder while it loads."),
    STEP(10, "Edit · Hero.tsx"),
    STEP(15, "Bash · npm run build"),
    TIMER(20, "Building"),
    STATS(15, 0, 0, 1, 21, 3),
    DONE(0, TIER_LIST, "Hero uses the new image", "The landing hero shows the new image; the video is gone and the page is 2 MB lighter.",
         "Replaced the hero video with hero.webp at three sizes, with a blurred placeholder while it loads. The page "
         "weighs 2 MB less. One commit: Use the new hero image."),
    END};
static const question_t Q_HERO = {
    "Use the new image in the hero, or keep the video?", {"Use the image"}, 1, false, {HERO_IMAGE}};
static const beat_t HERO_ASK[] = {
    START(0, "Working…"),
    ACT(10, "Reading", "Looking at the landing page's hero section."),
    STEP(10, "Read · Hero.tsx"),
    STEP(15, "Bash · ls public/hero"),
    ACT(15, "Thinking", "There is a new hero image in the design folder. Before I swap it in: image or video?"),
    ASK(20, Q_HERO),
    END};

// Orca's flaky-e2e: a flake found and fixed, said out loud.
static const beat_t E2E_FIX[] = {
    START(0, "Working…"),
    ACT(10, "Reproducing", "Running the checkout test 20 times to catch the flake."),
    STEP(10, "Bash · npx playwright test checkout --repeat-each 20"),
    TIMER(30, "Running tests"),
    TIMER(30, "Running tests"),
    ACT(20, "Thinking", "It fails when the cart request beats the page's hydration: the test clicks too early."),
    STEP(15, "Edit · checkout.spec.ts"),
    STEP(15, "Bash · npx playwright test checkout --repeat-each 50"),
    TIMER(30, "Running tests"),
    STATS(30, 50, 0, 1, 44, 7),
    DONE(0, TIER_ALERT, "Checkout e2e is stable: 50/50 runs pass",
         "The checkout test waited too little for the page. It now waits for the cart, and 50 runs in a row pass.",
         "The checkout e2e clicked Pay before hydration finished whenever the cart request came back first. It now "
         "waits for the cart's ready mark. 50/50 repeated runs pass. One commit: Wait for the cart in checkout e2e."),
    END};

// Orca's rate-limiter: a test run that fails, then the fix.
static const beat_t RATE_LIMIT[] = {
    START(0, "Working…"),
    ACT(10, "Reading", "Adding a sliding-window limit to the public API."),
    STEP(10, "Read · limiter.ts"),
    STEP(15, "Edit · limiter.ts"),
    STEP(15, "Bash · npm test"),
    TIMER(25, "Running tests"),
    FAIL(30, "npm test failed: 3 rate-limit tests time out"),
    END};
static const beat_t RATE_FIX[] = {
    START(0, "Working…"),
    ACT(10, "Fixing", "The tests wait on the real clock; moving them to fake timers."),
    STEP(10, "Edit · limiter.test.ts"),
    STEP(10, "Bash · npm test"),
    TIMER(20, "Running tests"),
    STATS(15, 112, 0, 1, 19, 3),
    DONE(0, TIER_LIST, "Rate limiter in; its tests on fake timers",
         "The public API allows 60 requests a minute per token. The three slow tests use fake timers. 112/112 pass.",
         "Added a sliding-window limit of 60 requests a minute per token, with Retry-After on a 429. The three tests "
         "that timed out waited on the real clock; they use fake timers now. 112/112 pass. One commit: Rate-limit the API."),
    END};

// Harness's harness-cli asks what the bar answers.
static const beat_t CLI_BUMP[] = {
    ACT(5, "Editing", "Bumping the cable protocol to 4 and gating the app list on it."),
    STEP(10, "Edit · cableSession.ts"),
    STEP(15, "Bash · npm test -- cable"),
    TIMER(20, "Running tests"),
    STATS(15, 412, 0, 1, 52, 8),
    DONE(0, TIER_ALERT, "Cable protocol bumped to 4",
         "The daemon speaks proto 4 and sends the app list only to dials that say it. 412/412 tests pass.",
         "Bumped the cable protocol to 4. The app list and app.pick are sent only to a dial whose hello says proto 4; "
         "older dials get proto 3 as before. 412/412 tests pass. One commit: Cable protocol 4."),
    END};
static const beat_t CLI_KEEP[] = {
    ACT(5, "Editing", "Keeping proto 3 and adding appFilter to the hello."),
    STEP(10, "Edit · cableSession.ts"),
    STEP(15, "Bash · npm test -- cable"),
    TIMER(20, "Running tests"),
    STATS(15, 410, 0, 1, 47, 7),
    DONE(0, TIER_ALERT, "The app list rides on proto 3",
         "The protocol stays at 3: a dial that says appFilter gets the app list, others nothing new. 410/410 tests pass.",
         "Kept the cable protocol at 3 and added an optional appFilter field to the hello. Only a dial that sends it gets "
         "apps and may send app.pick. 410/410 tests pass. One commit: Add appFilter to the hello."),
    END};
static const question_t Q_PROTO = {
    "Bump the cable protocol to 4, or keep 3 and add a field?", {"Bump to 4", "Keep 3"}, 2, false, {CLI_BUMP, CLI_KEEP}};
static const beat_t CLI_PROTO[] = {
    START(0, "Working…"),
    ACT(10, "Reading", "Reading the cable session and the dial's hello for the new app list."),
    STEP(10, "Read · cableSession.ts"),
    STEP(15, "Read · cable.md"),
    ACT(15, "Thinking", "The app list is a new frame. Old dials ignore frames they do not know."),
    ASK(15, Q_PROTO),
    END};

// Harness's firmware-max needs a person's yes to flash the bar.
static const beat_t FW_DONE[] = {
    ACT(5, "Flashing", "Writing the new image to the Max."),
    STEP(5, "Bash · idf.py -p /dev/ttyACM0 flash"),
    TIMER(25, "Flashing"),
    STATS(20, 0, 0, 1, 18, 2),
    DONE(0, TIER_ALERT, "The Max is flashed with the app picker",
         "The new firmware is on the Max and it booted into the agents page. Hold a face to pick an app.",
         "Built the firmware with the app picker, flashed it over /dev/ttyACM0 and watched it boot to the agents page. "
         "One commit: Max app picker."),
    END};
static const beat_t FW_STOP[] = {
    DONE(5, TIER_LIST, "Stopped before flashing",
         "You declined the flash, so the Max still runs yesterday's image. The build is ready.",
         "Built the firmware with the app picker. Flashing was declined, so the Max runs yesterday's image. Run "
         "idf.py -p /dev/ttyACM0 flash when you are ready."),
    END};
static const question_t Q_FLASH = {"Bash: idf.py -p /dev/ttyACM0 flash", {"Allow", "Deny"}, 2, true, {FW_DONE, FW_STOP}};
static const beat_t FW_FLASH[] = {
    START(0, "Working…"),
    ACT(10, "Building", "Building the Max firmware with the new app picker."),
    STEP(10, "Bash · idf.py build"),
    TIMER(25, "Building"),
    TIMER(25, "Building"),
    ACT(15, "Ready to flash", "Built. Flashing the Max needs your yes."),
    ASK(5, Q_FLASH),
    END};

// Harness's docs finishes quietly.
static const beat_t DOCS_PAGE[] = {
    START(0, "Working…"),
    ACT(10, "Writing", "Documenting the apps frame and app.pick on the cable page."),
    STEP(10, "Edit · cable.md"),
    STEP(20, "Edit · dial-app-filter.md"),
    TIMER(20, "Writing"),
    STATS(15, 0, 0, 1, 12, 2),
    DONE(0, TIER_LIST, "Cable docs cover apps and app.pick",
         "The cable page documents the apps frame, app.pick and the hello's appFilter.",
         "Added the apps frame, app.pick and appFilter to the cable page, with an example of a pick and the ring that "
         "follows it."),
    END};

enum { AUTH, HERO, E2E, RATE, SWEEP, FW, CLI, DOCS, API };
static const struct { uint32_t at; uint8_t agent; const beat_t *turn; } STORY[] = {
    {1000, AUTH, AUTH_SPLIT}, {3000, HERO, HERO_ASK}, {6000, E2E, E2E_FIX}, {10000, RATE, RATE_LIMIT},
    {40000, RATE, RATE_FIX}, {72000, CLI, CLI_PROTO}, {75000, FW, FW_FLASH}, {80000, DOCS, DOCS_PAGE},
    {135000, AUTH, AUTH_FOLLOW}};
enum { N_STORY = sizeof STORY / sizeof STORY[0] };
// The app in front on the computer, each change at the end of the daemon's 1 s settle: the person works in Orca, moves
// to Harness for the protocol and the flash, and comes back.
static const struct { uint32_t at; uint8_t app; } FRONT[] = {{0, APP_ORCA}, {70000, APP_HARNESS}, {130000, APP_ORCA}};
enum { N_FRONT = sizeof FRONT / sizeof FRONT[0] };

// What a person says, in turn, and what the agent then does.
static const beat_t SAID_RETRY[] = {
    START(0, "Working…"),
    ACT(10, "Reading the API client", "Adding a retry with backoff around the request."),
    STEP(5, "Edit · apiClient.ts"),
    STEP(15, "Bash · npm test -- apiClient"),
    TIMER(20, "Running tests"),
    STATS(15, 18, 0, 1, 16, 3),
    DONE(0, TIER_ALERT, "Requests retry 3 times with backoff",
         "The API client retries a failed request 3 times, waiting 1, 2 and 4 s. 18/18 tests pass.",
         "Wrapped the request in a retry: three tries on a network error or a 5xx, waiting 1, 2 and 4 seconds, "
         "never on a 4xx. Added tests for each case; 18/18 pass. One commit: Retry failed requests."),
    END};
static const beat_t SAID_TEST[] = {
    START(0, "Working…"),
    ACT(10, "Writing the test", "Adding a test that renders the cart with nothing in it."),
    STEP(5, "Edit · cart.test.tsx"),
    STEP(15, "Bash · npm test -- cart"),
    TIMER(20, "Running tests"),
    STATS(15, 88, 0, 1, 11, 2),
    DONE(0, TIER_ALERT, "Added a test for the empty cart",
         "A new test renders the cart with nothing in it and checks the empty state. 88/88 tests pass.",
         "Added cart.test.tsx: it renders the cart with no items and checks the empty-state text and the Shop button. "
         "88/88 tests pass. One commit: Test the empty cart."),
    END};
static const beat_t SAID_RECAP[] = {
    START(0, "Working…"),
    STEP(10, "Bash · git log --since=8am --oneline"),
    ACT(15, "Reading the log", "Reading today's commits."),
    DONE(20, TIER_ALERT, "Today: 5 commits, auth and checkout",
         "Since this morning: the session split, a stable checkout test, the rate limiter and the new hero.",
         "Five commits since 8 am: the session lookup out of the auth middleware, the checkout e2e fix, the rate "
         "limiter with its tests on fake timers, the new hero image and the cable docs. Nothing is waiting on you."),
    END};
static const struct { const char *said; const beat_t *turn; } SAID[] = {
    {"Add a retry to the API client", SAID_RETRY},
    {"Write a test for the empty cart", SAID_TEST},
    {"What changed since this morning?", SAID_RECAP}};
enum { N_SAID = sizeof SAID / sizeof SAID[0] };

// A new agent's first turn.
static const beat_t SETUP[] = {
    START(0, "Working…"),
    ACT(10, "Reading the project", "Reading the README and the scripts to get my bearings."),
    STEP(10, "Read · README.md"),
    STEP(15, "Bash · npm install"),
    TIMER(20, "Installing"),
    DONE(15, TIER_LIST, "Set up and ready", "Read the project and installed its dependencies. Tell me what to work on.",
         "Read the README, package.json and the CI config, installed the dependencies and ran the tests once: all pass. "
         "Ready for a first task."),
    END};

// The nine agents the story is about, in the daemon's list order, and what each did last (the history a ring restores).
static const struct {
    const char *id, *name;
    uint8_t engine, app;
    const char *recap, *text, *full;
} CAST[SCRIPTED] = {
    {"ag-auth", "auth-refactor", 0, APP_ORCA, "Sign-in posts to the new auth API",
     "The sign-in form posts to /v2/auth and keeps the session in a cookie. 61/61 tests pass.",
     "Moved the sign-in form to /v2/auth, which sets an httpOnly session cookie instead of a stored token. 61/61 pass."},
    {"ag-hero", "landing-hero", 1, APP_ORCA, "Landing copy matches the new pricing",
     "The landing page's headline and plan cards say the new prices.",
     "Rewrote the landing headline and the three plan cards for the new pricing, and linked the FAQ from each card."},
    {"ag-e2e", "flaky-e2e", 0, APP_ORCA, "Two flaky e2e tests found",
     "Search and checkout fail about one run in ten. Both are on the list to fix.",
     "Ran the e2e suite 30 times: search and checkout fail about one run in ten, each for a different reason."},
    {"ag-rate", "rate-limiter", 1, APP_ORCA, "Read the API's request path",
     "Every public route goes through one handler, so a limit there covers them all.",
     "Traced the public API's request path: every route passes through handleRequest, the place for a rate limit."},
    {"ag-sweep", "docs-sweep", 0, APP_ORCA, "Fixed 12 broken links in the docs",
     "Twelve links pointed at pages that moved; they point at the new ones.",
     "check-links found twelve links to pages that moved in the last restructure. They now point at the new pages."},
    {"ag-fw", "firmware-max", 0, APP_HARNESS, "The Max boots to the agents page",
     "The Max skips the splash and opens on the agents page in 2.1 s.",
     "Dropped the boot splash and started the cable before the display, so the Max opens on its agents in 2.1 s."},
    {"ag-cli", "harness-cli", 1, APP_HARNESS, "harness status names each agent's app",
     "harness status shows which app each agent runs in, from the host detection.",
     "Added an App column to harness status, filled from the host detection the devices already use."},
    {"ag-docs", "docs", 0, APP_HARNESS, "Getting started covers the Max",
     "The getting-started guide has a page for the Max: plugging it in and what it shows.",
     "Wrote the Max page of the getting-started guide: the one cable, the agents page and the app picker."},
    {"ag-api", "api-client", 0, APP_VSCODE, "API client regenerated from the spec",
     "The typed client matches the OpenAPI spec again, with the two new billing routes.",
     "Regenerated the typed API client from the OpenAPI spec: the two new billing routes and one renamed field."},
};

// New Harness: an engine and a project, then Start. Its agents run in Harness.
enum { ROW_AGENT, ROW_PROJECT, ROW_START, ROWS };
static const char *const ROW_LABELS[] = {"Agent", "Project", "New Harness"};
static const struct { const char *title, *detail; } PROJECTS[] = {
    {"harness-web", "~/work/harness-web"}, {"harness-cli", "~/work/harness-cli"}, {"infra", "~/work/infra"}};
static const char *const ENGINE_DETAILS[] = {"Anthropic", "OpenAI"};
// What a person "says" into the Agent and the Project field, and the option it lands on.
static const struct { const char *said; uint8_t pick; } HEARD[] = {{"Codex", 1}, {"harness-cli", 1}};
enum { N_PROJECTS = sizeof PROJECTS / sizeof PROJECTS[0] };

// ── state ───────────────────────────────────────────────────────────────────────────────────────────

enum { ST_IDLE, ST_WORKING, ST_QUESTION, ST_FINISHED, ST_FAILED };
static const char *const STATUS[] = {"idle", "working", "question", "finished", "failed"};
enum { ASK_NONE, ASK_OPEN, ASK_TAKEN };   // TAKEN: answered, closing in a moment

typedef struct {
    bool used, made;             // made: by a person, with New Harness
    bool restored;               // its history went to the device since the attach (cableSession.ts `restored`)
    char id[16], name[24];
    uint8_t engine, app;
    const beat_t *turn;          // the beats playing; NULL between turns
    uint8_t beat, status;
    uint32_t beat_at, started_at;
    const question_t *q;         // while a question is open or being taken
    uint8_t ask, choice;
    uint32_t serial, asked_story, close_at;
    const char *recap, *text, *full;   // the last answer
    bool unread;
    uint32_t read_serial;
    int8_t said;                 // words a person said, waiting for the agent to be free; -1 none
    uint32_t said_at;
} agent_t;

enum { OWE_FULL = 1, OWE_MACHINES = 2, OWE_AGENTS = 4, OWE_SWARMS = 8, OWE_RESYNC = 16 };

static struct {
    uint32_t now;                // the clock at the call in progress
    bool greeted, seq_on, long_recap, steps, stats, player;
    bool app_filter;             // the device said appFilter "v1": it is shown one app's ring, after `apps`
    uint32_t seq;
    char mac[40], fw[40];
    uint32_t last_rx, last_ping, last_tick, resync_ok_at, library_at;
    char library_key[MAX_AGENTS + 1];
    char apps_key[2 + 2 * N_APPS];   // the last `apps` sent, as apps_key() writes it
    int64_t library_request, library_offset;
    unsigned owed;               // pushes the next tick makes
    char focus[16];              // the agent both screens are on
    uint8_t shown, front;        // the app whose ring the device is shown; the app in front on the computer
    bool person;
    uint32_t person_at;
    uint32_t story_pos, story_total;
    uint8_t next_entry, next_front;
    uint32_t serial;             // questions, tokens, notices and form revisions: every number only goes up
    uint8_t said_next, made;
    uint32_t dropped;            // frames that did not fit: this module's bug, never the device's
} s;

static agent_t agents[MAX_AGENTS];   // in the daemon's list order, the scripted nine first

enum { V_AGENT, V_FORM, V_QUESTION, V_DRAFT, V_CARRY, V_SEARCH, V_SELECTION };
static struct {
    bool open, thinking;
    uint8_t kind, said;
    char upload[ID_MAX + 1];
    bool named, form_ok;         // named: the device said whose words these are
    char agent[ID_MAX + 1], form_id[49];
    int64_t form_rev;
    uint32_t bytes, ready_at;
} v;

static struct {
    bool active, closed;         // closed: it started its agent, or the device shut it; `state` then answers inactive
    char id[49];
    uint32_t revision;
    uint8_t row, pick, engine, project;
    bool picking, busy;
    uint32_t start_at;
    const char *query, *error;
} form;

// ── frames out ──────────────────────────────────────────────────────────────────────────────────────
// One frame is written at a time, into `fb`. Inside max_demo_tick it goes straight to `emit`; replies written by
// max_demo_receive wait in a small queue for the tick, which sends them first. `seq` is given as each frame is
// finished, so it counts in the order the device reads.

static max_demo_emit_fn sink;
static void *sink_ctx;
static char fb[4096];
static size_t fl;
static bool f_over, f_ping;

enum { QUEUE_BYTES = 16 * 1024, QUEUE_FRAMES = 48 };
static char q_buf[QUEUE_BYTES];
static uint16_t q_len[QUEUE_FRAMES];
static size_t q_used;
static unsigned q_n;

static void put(const char *p, size_t n)
{
    if (f_over || n > sizeof fb - fl) { f_over = true; return; }
    memcpy(fb + fl, p, n);
    fl += n;
}
static void put_c(const char *p) { put(p, strlen(p)); }
static void put_str(const char *p)
{
    static const char HEX[] = "0123456789abcdef";
    put("\"", 1);
    const char *run = p;
    for (; *p; p++) {
        const unsigned char c = (unsigned char)*p;
        if (c >= 0x20 && c != '"' && c != '\\') continue;
        put(run, (size_t)(p - run));
        run = p + 1;
        if (c == '"' || c == '\\') {
            const char e[2] = {'\\', (char)c};
            put(e, 2);
        } else {
            const char e[6] = {'\\', 'u', '0', '0', HEX[c >> 4], HEX[c & 15]};
            put(e, 6);
        }
    }
    put(run, (size_t)(p - run));
    put("\"", 1);
}
static void put_int(int64_t n)
{
    char b[24];
    size_t i = sizeof b;
    uint64_t u = n < 0 ? (uint64_t)0 - (uint64_t)n : (uint64_t)n;
    do { b[--i] = (char)('0' + u % 10); u /= 10; } while (u);
    if (n < 0) b[--i] = '-';
    put(b + i, sizeof b - i);
}
static void key(const char *k) { put(",", 1); put_str(k); put(":", 1); }
static void f_s(const char *k, const char *val) { key(k); put_str(val ? val : ""); }
static void f_i(const char *k, int64_t n) { key(k); put_int(n); }
static void f_b(const char *k, bool b) { key(k); put_c(b ? "true" : "false"); }
static void f_begin(const char *t)
{
    fl = 0;
    f_over = false;
    f_ping = !strcmp(t, "ping");
    put_c("{\"t\":");
    put_str(t);
}
static void f_end(void)
{
    // Nothing but pings until the device greets: everything else is an answer to a hello.
    if (!s.greeted && !f_ping) return;
    if (s.seq_on) f_i("seq", s.seq);
    put("}", 1);
    if (f_over) { s.dropped++; return; }
    if (sink) {
        sink(CABLE_TYPE_JSON, (const uint8_t *)fb, fl, sink_ctx);
    } else if (q_n < QUEUE_FRAMES && fl <= QUEUE_BYTES - q_used) {
        memcpy(q_buf + q_used, fb, fl);
        q_used += fl;
        q_len[q_n++] = (uint16_t)fl;
    } else {
        s.dropped++;   // a burst bigger than any device sends; the next push puts the device right
        return;
    }
    if (s.seq_on) s.seq++;
}

// ── small things ────────────────────────────────────────────────────────────────────────────────────

static const char *str_of(const cJSON *m, const char *k)
{
    const cJSON *val = cJSON_GetObjectItemCaseSensitive(m, k);
    return cJSON_IsString(val) && val->valuestring ? val->valuestring : NULL;
}
static bool has_key(const cJSON *m, const char *k) { return cJSON_GetObjectItemCaseSensitive(m, k) != NULL; }
// A whole number JavaScript holds exactly (Number.isSafeInteger), as the daemon checks.
static bool int_of(const cJSON *m, const char *k, int64_t *out)
{
    const cJSON *val = cJSON_GetObjectItemCaseSensitive(m, k);
    if (!cJSON_IsNumber(val)) return false;
    const double d = val->valuedouble;
    if (!(d >= -9007199254740991.0 && d <= 9007199254740991.0)) return false;
    const int64_t n = (int64_t)d;
    if ((double)n != d) return false;
    *out = n;
    return true;
}
// An id the device sent that is said back: present, not empty, and short.
static const char *id_of(const cJSON *m, const char *k)
{
    const char *id = str_of(m, k);
    return id && id[0] && strlen(id) <= ID_MAX ? id : NULL;
}
static bool word(const char *p, size_t most, bool underscore)   // [a-zA-Z0-9-]{1,most}, with _ when asked
{
    size_t n = 0;
    for (; p && p[n]; n++) {
        const char c = p[n];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || (underscore && c == '_')))
            return false;
    }
    return p && n >= 1 && n <= most;
}
static void copy(char *dst, size_t cap, const char *src)
{
    size_t n = src ? strlen(src) : 0;
    if (n >= cap) n = cap - 1;
    if (n) memcpy(dst, src, n);
    dst[n] = 0;
}

static int agent_count(void)
{
    int n = 0;
    while (n < MAX_AGENTS && agents[n].used) n++;
    return n;
}
static int find_agent(const char *id)
{
    if (!id || !id[0]) return -1;
    for (int i = 0; i < MAX_AGENTS && agents[i].used; i++) if (!strcmp(agents[i].id, id)) return i;
    return -1;
}
static uint8_t status_of(const agent_t *a)
{
    if (a->ask == ASK_OPEN) return ST_QUESTION;
    if (a->turn) return ST_WORKING;
    return a->status;
}

// What the device may do with an agent, by its app's letters; and whether the agent runs outside Harness.
static bool lacks(const agent_t *a, char cap) { return !strchr(APPS[a->app].caps, cap); }
static bool outside(const agent_t *a) { return a->app != APP_HARNESS; }
// On the ring the device is shown: the shown app's agents for a device that says appFilter, every agent otherwise.
static bool in_ring(const agent_t *a) { return !s.app_filter || a->app == s.shown; }
static int find_app(const char *id)
{
    for (int i = 0; id && i < N_APPS; i++) if (!strcmp(APPS[i].id, id)) return i;
    return -1;
}
// An app's agents, or those of them that need the person.
static int app_agents(unsigned app, bool waiting)
{
    int n = 0;
    for (int i = 0; i < MAX_AGENTS && agents[i].used; i++)
        n += agents[i].app == app && (!waiting || agents[i].ask == ASK_OPEN);
    return n;
}

// The daemon's line for an agent outside Harness: "<before><its app's name><after>". One at a time: the caller sends it
// before asking for another.
static const char *in_app(const agent_t *a, const char *before, const char *after)
{
    static char line[160];
    const int n = snprintf(line, sizeof line, "%s%s%s", before, APPS[a->app].name, after);
    if (n < 0 || (size_t)n >= sizeof line) line[0] = 0;
    return line;
}

static void question_id(const agent_t *a, char *out, size_t cap)
{
    // A question the device may only show carries the daemon's shown-only prefix (cableSession.ts SHOWN_ONLY_PREFIX).
    const int n = lacks(a, 'a') ? snprintf(out, cap, "shown:%s-%lu", a->id, (unsigned long)a->serial)
                                : snprintf(out, cap, "q-%s-%lu", a->id, (unsigned long)a->serial);
    if (n < 0 || (size_t)n >= cap) out[0] = 0;
}
// Names these exact contents: a new question is a new token, so an answer to the old one is refused.
static void question_token(const agent_t *a, char *out, size_t cap)
{
    const int n = snprintf(out, cap, "%08lx-demo-%s", (unsigned long)(a->serial * 2654435761u), a->id);
    if (n < 0 || (size_t)n >= cap) out[0] = 0;
}
static void read_token(const agent_t *a, char *out, size_t cap)
{
    const int n = snprintf(out, cap, "rt%lu", (unsigned long)a->read_serial);
    if (n < 0 || (size_t)n >= cap) out[0] = 0;
}

static void person(void) { s.person = true; s.person_at = s.now; }
static bool person_here(uint32_t now) { return s.person && (uint32_t)(now - s.person_at) < QUIET_MS; }

// ── what the daemon sends ───────────────────────────────────────────────────────────────────────────

static void who(const agent_t *a)
{
    f_s("name", a ? a->name : "");
    f_s("engine", a ? ENGINES[a->engine] : "");
    f_s("machine", a ? MACHINE_NAME : "");
}

static void send_welcome(void)
{
    static const char *const FEATURES[] = {"voice.draft", "agents.refresh", "player.library", "resync", "form",
                                           "selection", "visit", "question.review", "settings"};
    f_begin("welcome");
    f_i("proto", 3);
    f_s("app", "harness");
    key("machine");
    put_c("{\"id\":");
    put_str(MACHINE_ID);
    f_s("name", MACHINE_NAME);
    put("}", 1);
    f_s("selected", MACHINE_ID);
    f_s("voiceLang", "en");
    key("features");
    put("[", 1);
    bool first = true;
    for (size_t i = 0; i < sizeof FEATURES / sizeof FEATURES[0]; i++) {
        // As the daemon: the library for a device that named it, resync for one that counts frames.
        if (!strcmp(FEATURES[i], "player.library") && !s.player) continue;
        if (!strcmp(FEATURES[i], "resync") && !s.seq_on) continue;
        if (!first) put(",", 1);
        put_str(FEATURES[i]);
        first = false;
    }
    put("]", 1);
    f_end();
}

static void push_machines(void)
{
    f_begin("machines.begin");
    f_end();
    f_begin("machine");
    f_s("id", MACHINE_ID);
    f_s("name", MACHINE_NAME);
    f_s("state", "ready");
    f_b("local", true);
    f_end();
    f_begin("machines.end");
    f_s("selected", MACHINE_ID);
    f_s("source", "backend");
    f_end();
}

static void push_swarms(void)
{
    f_begin("swarms");
    f_s("selected", "");
    key("items");
    put_c("[]");
    key("tiles");
    put_c("[]");
    f_end();
}

static void send_focus(const agent_t *a)
{
    f_begin("focus");
    f_s("agentId", a->id);
    f_end();
}

static void send_toast(const char *text)
{
    f_begin("toast");
    f_s("text", text);
    f_end();
}

// What `apps` says, as a short key: the shown app, then each app's count and waiting count.
static void apps_key(char *out)
{
    size_t n = 0;
    out[n++] = (char)('0' + s.shown);
    for (unsigned i = 0; i < N_APPS; i++) {
        out[n++] = (char)('A' + app_agents(i, false));
        out[n++] = (char)('A' + app_agents(i, true));
    }
    out[n] = 0;
}

// The apps with agents on this computer, in the daemon's fixed order, and the one whose ring the device holds.
static void push_apps(void)
{
    f_begin("apps");
    f_s("shown", APPS[s.shown].id);
    key("apps");
    put("[", 1);
    for (unsigned i = 0, rows = 0; i < N_APPS; i++) {
        const int count = app_agents(i, false);
        if (!count) continue;
        if (rows++) put(",", 1);
        put_c("{\"id\":");
        put_str(APPS[i].id);
        f_s("name", APPS[i].name);
        f_i("count", count);
        f_i("waiting", app_agents(i, true));
        put("}", 1);
    }
    put("]", 1);
    f_end();
    apps_key(s.apps_key);
}

// History, not news: no tier, no beep (cableSession.ts pushRestores). Each agent's once per attach, when it is first on
// the ring sent, so a ring the device is turned to later brings its agents' history with it.
static void push_restores(void)
{
    for (int i = 0; i < MAX_AGENTS && agents[i].used; i++) {
        agent_t *a = &agents[i];
        if (!in_ring(a) || a->restored) continue;
        a->restored = true;
        if (!a->recap) continue;
        f_begin("summary");
        f_s("agentId", a->id);
        f_s("recap", a->recap);
        f_s("text", a->text);
        if (s.long_recap && a->full) f_s("full", a->full);
        f_b("restore", true);
        f_end();
    }
}

// The ring: the apps first for a device that says appFilter, which draws the ring under the app it names.
static void push_agents(bool restore)
{
    if (s.app_filter) push_apps();
    f_begin("agents.begin");
    f_end();
    int total = 0;
    for (int i = 0; i < MAX_AGENTS && agents[i].used; i++) {
        const agent_t *a = &agents[i];
        if (!in_ring(a)) continue;
        total++;
        f_begin("agent");
        f_s("id", a->id);
        f_s("name", a->name);
        f_s("engine", ENGINES[a->engine]);
        f_s("model", "");
        f_s("effort", "");
        f_s("machineId", MACHINE_ID);
        f_s("machine", MACHINE_NAME);
        f_s("host", APPS[a->app].id);
        f_s("caps", APPS[a->app].caps);
        f_end();
    }
    f_begin("agents.end");
    f_i("total", total);
    f_s("tab", "");
    f_s("view", "machine");
    f_end();
    // The list changed shape under the device: say again which agent both screens are on (the daemon's one re-assert),
    // when the ring holds it.
    const int f = find_agent(s.focus);
    if (f >= 0 && in_ring(&agents[f])) send_focus(&agents[f]);
    if (restore) push_restores();
}

static void library_key(char *out)
{
    const int n = agent_count();
    for (int i = 0; i < n; i++) out[i] = (char)('0' + status_of(&agents[i]));
    out[n] = 0;
}

// Every agent on the computer, whatever ring the device holds.
static void push_library(void)
{
    const int total = agent_count();
    int64_t offset = s.library_offset;
    const int64_t last = total > PAGE_ROWS ? total - PAGE_ROWS : 0;
    if (offset > last) offset = last;
    f_begin("player.library");
    f_i("request", s.library_request);
    f_i("offset", offset);
    f_i("total", total);
    key("rows");
    put("[", 1);
    for (int i = (int)offset, row = 0; i < total && row < PAGE_ROWS; i++, row++) {
        const agent_t *a = &agents[i];
        if (row) put(",", 1);
        put_c("{\"id\":");
        put_str(a->id);
        f_s("machineId", MACHINE_ID);
        f_s("name", a->name);
        f_s("engine", ENGINES[a->engine]);
        f_s("status", STATUS[status_of(a)]);
        f_i("ageSeconds", -1);
        put("}", 1);
    }
    put("]", 1);
    f_i("machines", 1);
    f_end();
    library_key(s.library_key);
    s.library_at = s.now;
}

// The bell and the inbox count every agent on this computer, not only the ring's.
static void push_drawer(void)
{
    f_begin("notif.replace");
    key("items");
    put("[", 1);
    const int n = agent_count();
    for (int i = 0, rows = 0; i < n && rows < DRAWER_ROWS; i++) {
        const agent_t *a = &agents[i];
        const bool question = a->ask == ASK_OPEN;
        if (!question && !(a->unread && a->recap)) continue;
        if (rows++) put(",", 1);
        put_c("{\"agentId\":");
        put_str(a->id);
        f_s("name", a->name);
        f_s("machine", MACHINE_NAME);
        f_s("summary", question ? a->q->q : a->recap);
        f_b("question", question);
        if (!question) {
            char token[24];
            read_token(a, token, sizeof token);
            f_s("readToken", token);
        }
        put("}", 1);
    }
    put("]", 1);
    f_end();
}

// The question as the inbox holds it; `state` adds what question.read adds: an agent outside Harness takes no spoken
// answer. One the device may not answer is the daemon's shown-only question (hosts/observed.ts askedLine): one prompt
// naming the app to answer it in, its one option that app.
static void put_questions(const agent_t *a, bool state)
{
    key("questions");
    put_c("[{\"key\":");
    if (lacks(a, 'a')) {
        char line[160];
        int n = snprintf(line, sizeof line, "%s \xc2\xb7 answer in %s", a->q->q, APPS[a->app].name);
        if (n < 0 || (size_t)n >= sizeof line) line[0] = 0;
        put_str("prompt");
        f_s("q", line);
        n = snprintf(line, sizeof line, "In %s", APPS[a->app].name);
        if (n < 0 || (size_t)n >= sizeof line) line[0] = 0;
        key("options");
        put("[", 1);
        put_str(line);
        put("]", 1);
    } else {
        put_str(a->q->q);
        f_s("q", a->q->q);
        key("options");
        put("[", 1);
        for (unsigned o = 0; o < a->q->count; o++) {
            if (o) put(",", 1);
            put_str(a->q->options[o]);
        }
        put("]", 1);
    }
    f_b("multi", false);
    if (state && outside(a)) f_b("canText", false);
    put_c("}]");
}

static void send_question(const agent_t *a)
{
    char id[40];
    question_id(a, id, sizeof id);
    f_begin("question");
    f_s("agentId", a->id);
    who(a);
    f_s("id", id);
    put_questions(a, false);
    // Absent, not false, on a plain question: as the daemon sends it. A shown-only one is never a permission.
    if (a->q->permission && !lacks(a, 'a')) f_b("permission", true);
    f_end();
}

// Every open question, whichever ring its agent is on: each is a drawer row.
static void push_questions(void)
{
    const int n = agent_count();
    for (int i = 0; i < n; i++) if (agents[i].ask == ASK_OPEN) send_question(&agents[i]);
}

// Everything a device that has just greeted has lost, in the daemon's order (pushAgents).
static void push_full(void)
{
    for (int i = 0; i < MAX_AGENTS; i++) agents[i].restored = false;   // a device that greets has no history at all
    push_machines();
    push_swarms();
    push_agents(false);
    if (s.player) push_library();
    push_restores();
    push_drawer();
    push_questions();
}

static void push_owed(void)
{
    const unsigned owed = s.owed;
    s.owed = 0;
    if (owed & OWE_MACHINES) push_machines();
    if (owed & OWE_FULL) { push_full(); return; }   // it says everything below
    if (owed & OWE_RESYNC) {
        push_machines();
        push_swarms();
        push_agents(true);
        push_drawer();
        push_questions();
        return;
    }
    if (owed & OWE_SWARMS) push_swarms();
    if (owed & OWE_AGENTS) push_agents(true);
}

// ── turns ───────────────────────────────────────────────────────────────────────────────────────────

static void begin_beats(agent_t *a, const beat_t *turn, uint32_t delay)
{
    a->turn = turn;
    a->beat = 0;
    a->beat_at = s.now + delay + turn[0].wait_ds * 100u;
}
static void start_turn(agent_t *a, const beat_t *turn, uint32_t delay)
{
    begin_beats(a, turn, delay);
    a->started_at = s.now + delay;
}

static void end_turn(agent_t *a, uint8_t status)
{
    a->turn = NULL;
    a->q = NULL;
    a->ask = ASK_NONE;
    a->status = status;
    // Words said while it was busy go next, after a breath.
    if (a->said >= 0 && !due(a->said_at, s.now + 1000)) a->said_at = s.now + 1000;
}

static void send_stats(const agent_t *a, const beat_t *b)
{
    if (!s.stats) return;
    f_begin("turn.stats");
    f_s("agentId", a->id);
    if (b->n[0] || b->n[1]) {
        f_i("testsPassed", b->n[0]);
        f_i("testsFailed", b->n[1]);
    }
    if (b->n[2]) f_i("commits", b->n[2]);
    f_i("tokensIn", b->n[3] * 1000);
    f_i("tokensOut", b->n[4] * 1000);
    f_end();
}

// An agent's news goes to the device whichever ring it is on: the bell and the inbox count every agent.
static void finish(agent_t *a, const beat_t *b)
{
    f_begin("turn.done");
    f_s("agentId", a->id);
    f_end();
    f_begin("summary");
    f_s("agentId", a->id);
    who(a);
    f_s("recap", b->a);
    f_s("text", b->b);
    if (s.long_recap && b->c) f_s("full", b->c);
    f_s("tier", TIERS[b->tier]);
    if (b->tier == TIER_LIST) f_b("quiet", true);
    if (b->tier == TIER_SILENT) f_b("silent", true);
    f_end();
    a->recap = b->a;
    a->text = b->b;
    a->full = b->c;
    // A silent answer draws its tile and nothing else; the others wait in the drawer until read.
    a->unread = b->tier != TIER_SILENT;
    a->read_serial = ++s.serial;
    end_turn(a, ST_FINISHED);
}

static void ask(agent_t *a, const question_t *q)
{
    a->q = q;
    a->ask = ASK_OPEN;
    a->serial = ++s.serial;
    a->asked_story = s.story_total;
    send_question(a);
}

// The question closes and the agent goes on with the answer it was given.
static void take_answer(agent_t *a)
{
    char id[40];
    question_id(a, id, sizeof id);
    f_begin("question.close");
    f_s("agentId", a->id);
    f_s("id", id);
    f_end();
    const beat_t *next = a->q->next[a->choice < a->q->count ? a->choice : 0];
    a->q = NULL;
    a->ask = ASK_NONE;
    begin_beats(a, next, 0);
}

static void play(agent_t *a)
{
    const beat_t *b = &a->turn[a->beat];
    switch (b->kind) {
    case B_START:
        f_begin("turn.started");
        f_s("agentId", a->id);
        f_s("text", b->a);
        f_end();
        break;
    case B_ACT:
        f_begin("turn.activity");
        f_s("agentId", a->id);
        f_s("text", b->a);
        // steps-v1 only, as the daemon gates them: the agent's sentence and the footer's timer.
        if (s.steps && b->b) f_s("action", b->b);
        if (s.steps && b->timer) f_i("elapsedSeconds", (uint32_t)(s.now - a->started_at) / 1000u);
        f_end();
        break;
    case B_STEP:
        if (s.steps) {
            f_begin("turn.activity");
            f_s("agentId", a->id);
            f_s("text", "");
            f_s("step", b->a);
            f_end();
        }
        break;
    case B_STATS:
        send_stats(a, b);
        break;
    case B_ASK:
        a->beat++;
        ask(a, b->ask);
        return;
    case B_DONE:
        finish(a, b);
        return;
    case B_FAIL:
        f_begin("turn.error");
        f_s("agentId", a->id);
        f_s("message", b->a);
        f_end();
        end_turn(a, ST_FAILED);
        return;
    default:
        end_turn(a, ST_IDLE);
        return;
    }
    a->beat++;
    a->beat_at = s.now + a->turn[a->beat].wait_ds * 100u;
}

static void run_agent(agent_t *a)
{
    if (a->ask == ASK_TAKEN && due(s.now, a->close_at)) take_answer(a);
    // Bounded: beats with no wait between them all go now, and the guard stops a list that never waits.
    for (unsigned guard = 0; guard < 16 && a->turn && a->ask == ASK_NONE && due(s.now, a->beat_at); guard++) play(a);
    if (!a->turn && a->ask == ASK_NONE && a->said >= 0 && due(s.now, a->said_at)) {
        start_turn(a, SAID[a->said].turn, 0);
        a->said = -1;
    }
}

// ── the story ───────────────────────────────────────────────────────────────────────────────────────

static bool idle(const agent_t *a) { return !a->turn && a->ask == ASK_NONE && a->said < 0; }

// The device is turned to an app's ring: `apps` and the ring follow (cableSession.ts syncAgents after a switch).
static void show(uint8_t app)
{
    s.shown = app;
    if (s.app_filter) s.owed |= OWE_AGENTS;
}

// The app in front changed and its settle is over (AppFilter step 2): it ends a pick on the device, and the device is
// shown it when it has agents and is not shown already.
static void to_front(uint8_t app)
{
    if (app == s.front) return;
    s.front = app;
    if (app != s.shown && app_agents(app, false)) show(app);
}

// The agents a person made leave when the story starts over, so the next person finds the same nine.
static void forget_made(void)
{
    for (int i = MAX_AGENTS - 1; i >= SCRIPTED; i--) {
        agent_t *a = &agents[i];
        if (!a->used || !a->made || !idle(a)) continue;
        if (!strcmp(s.focus, a->id)) s.focus[0] = 0;
        memmove(&agents[i], &agents[i + 1], (size_t)(MAX_AGENTS - 1 - i) * sizeof *a);
        memset(&agents[MAX_AGENTS - 1], 0, sizeof *a);
        agents[MAX_AGENTS - 1].said = -1;
        s.owed |= OWE_AGENTS;
    }
}

static void advance_story(uint32_t dt)
{
    s.story_total += dt;
    s.story_pos += dt;
    for (;;) {
        for (; s.next_entry < N_STORY && s.story_pos >= STORY[s.next_entry].at; s.next_entry++) {
            agent_t *a = &agents[STORY[s.next_entry].agent];   // the scripted nine never move
            if (idle(a)) start_turn(a, STORY[s.next_entry].turn, 0);   // busy with a person's words: skipped this time
        }
        for (; s.next_front < N_FRONT && s.story_pos >= FRONT[s.next_front].at; s.next_front++) to_front(FRONT[s.next_front].app);
        if (s.story_pos < CYCLE_MS) break;
        s.story_pos -= CYCLE_MS;
        s.next_entry = 0;
        s.next_front = 0;
        forget_made();
    }
    // Nobody at the bar to answer: it is answered on the computer, with the first option.
    const int n = agent_count();
    for (int i = 0; i < n; i++) {
        agent_t *a = &agents[i];
        if (a->ask != ASK_OPEN || s.story_total - a->asked_story < UNATTENDED_MS) continue;
        a->choice = 0;
        take_answer(a);
    }
}

// Where story time last counted to: it does not count while a person is here.
static uint32_t story_from(void)
{
    uint32_t from = s.last_tick;
    if (s.person && (int32_t)(s.person_at + QUIET_MS - from) > 0) from = s.person_at + QUIET_MS;
    return from;
}

// Story milliseconds until the story next does something by itself.
static uint32_t story_wait(void)
{
    uint32_t wait = CYCLE_MS - s.story_pos;
    if (s.next_entry < N_STORY && STORY[s.next_entry].at - s.story_pos < wait) wait = STORY[s.next_entry].at - s.story_pos;
    if (s.next_front < N_FRONT && FRONT[s.next_front].at - s.story_pos < wait) wait = FRONT[s.next_front].at - s.story_pos;
    const int n = agent_count();
    for (int i = 0; i < n; i++) {
        const agent_t *a = &agents[i];
        if (a->ask != ASK_OPEN) continue;
        const uint32_t waited = s.story_total - a->asked_story;
        const uint32_t left = waited >= UNATTENDED_MS ? 0 : UNATTENDED_MS - waited;
        if (left < wait) wait = left;
    }
    return wait;
}

// ── what the device asks ────────────────────────────────────────────────────────────────────────────

static void end_session(void)
{
    // The daemon closes the port on silence, and a new port is a new device: no greeting, no count, nothing owed.
    s.greeted = s.seq_on = s.long_recap = s.steps = s.stats = s.player = s.app_filter = false;
    s.seq = 0;
    s.mac[0] = s.fw[0] = 0;
    s.owed = 0;
    s.library_request = s.library_offset = 0;
    q_n = 0;
    q_used = 0;
    memset(&v, 0, sizeof v);
}

static void on_hello(const cJSON *m)
{
    const char *product = str_of(m, "product");
    if (!product || strcmp(product, "harness")) return;   // another product's device gets no session at all
    const char *mac = str_of(m, "mac"), *fw = str_of(m, "fw"), *board = str_of(m, "board");
    char mac_c[sizeof s.mac], fw_c[sizeof s.fw];
    copy(mac_c, sizeof mac_c, mac);
    copy(fw_c, sizeof fw_c, fw);
    const char *filter = str_of(m, "appFilter");
    const bool app_filter = filter && !strcmp(filter, "v1");
    // The same device on the same image is a keepalive: its welcome and nothing else.
    const bool keepalive = s.greeted && !strcmp(mac_c, s.mac) && !strcmp(fw_c, s.fw) && app_filter == s.app_filter;
    // swarms:"members-v1" changes nothing here: the demo has no tabs to send members of.
    const char *recap = str_of(m, "recap"), *activity = str_of(m, "activity");
    const char *stats = str_of(m, "stats"), *player = str_of(m, "player");
    s.long_recap = recap && !strcmp(recap, "long-v1");
    s.steps = activity && !strcmp(activity, "steps-v1");
    s.stats = stats && !strcmp(stats, "turn-v1");
    s.player = player && !strcmp(player, "library-v1");
    s.app_filter = app_filter;
    s.seq_on = board && (!strcmp(board, "pro") || !strcmp(board, "max"));   // isP4Board
    s.seq = 0;
    s.greeted = true;
    memcpy(s.mac, mac_c, sizeof s.mac);
    memcpy(s.fw, fw_c, sizeof s.fw);
    send_welcome();
    if (keepalive) return;
    s.owed = OWE_FULL;
    s.resync_ok_at = s.now;
    s.last_tick = s.now;   // the story counts from the greeting
}

// cableSession.ts app.pick: another app with agents is switched to; one with none, or none listed, is ignored and the
// list told again; the app already shown changes nothing.
static void on_app_pick(const cJSON *m)
{
    const char *app = str_of(m, "app");
    if (!s.app_filter || !app || !app[0] || strlen(app) > APP_ID_MAX) return;
    person();
    const int i = find_app(app);
    if (i < 0 || !app_agents((unsigned)i, false)) { push_apps(); return; }
    if (i != s.shown) show((uint8_t)i);
}

static void on_agent_open(const cJSON *m)
{
    const char *reason = str_of(m, "reason");
    // A question screen that came up by itself is not a person, and moves nothing.
    if (reason && !strcmp(reason, "question")) return;
    person();
    const int i = find_agent(str_of(m, "agentId"));
    if (i < 0) return;
    agent_t *a = &agents[i];
    copy(s.focus, sizeof s.focus, a->id);
    a->unread = false;
    // Another app's agent turns the device to that app's ring, on it (decision 7 A): the push re-asserts the focus.
    if (in_ring(a)) send_focus(a);
    else show(a->app);
    // Brought up in its own app, where the person answers what the device could only show.
    if (a->ask == ASK_OPEN && lacks(a, 'a')) {
        a->choice = 0;
        a->ask = ASK_TAKEN;
        a->close_at = s.now + OUTSIDE_MS;
    }
}

static void voice_error(const char *message)
{
    f_begin("voice.error");
    f_s("message", message);
    if (v.upload[0]) f_s("uploadId", v.upload);
    f_end();
}

static void on_voice_begin(const cJSON *m)
{
    person();
    memset(&v, 0, sizeof v);   // a new recording drops the reply the last one was waiting on
    v.open = true;
    const char *upload = str_of(m, "uploadId");
    if (upload && strlen(upload) <= ID_MAX) copy(v.upload, sizeof v.upload, upload);
    // As the daemon: the presence of a purpose's key, even malformed, selects that purpose.
    if (has_key(m, "formId") || has_key(m, "formRevision")) v.kind = V_FORM;
    else if (has_key(m, "searchId") || has_key(m, "searchRevision")) v.kind = V_SEARCH;
    else if (has_key(m, "draftId") || has_key(m, "draftRevision") || has_key(m, "draftOp")) v.kind = V_DRAFT;
    else if (has_key(m, "questionToken") || has_key(m, "questionIndex")) v.kind = V_QUESTION;
    else if (has_key(m, "carryId")) v.kind = V_CARRY;
    else if (has_key(m, "selectionId")) v.kind = V_SELECTION;
    else v.kind = V_AGENT;
    if (v.kind == V_FORM) {
        const char *form_id = str_of(m, "formId");
        v.form_ok = word(form_id, 48, false) && word(upload, 64, false) && int_of(m, "formRevision", &v.form_rev) &&
                    v.form_rev >= 0 && !has_key(m, "agentId") && !has_key(m, "selectionId") && !has_key(m, "cmd");
        if (v.form_ok) copy(v.form_id, sizeof v.form_id, form_id);
    } else if (v.kind == V_AGENT && has_key(m, "agentId")) {
        v.named = true;
        const char *agent = id_of(m, "agentId");
        if (agent) copy(v.agent, sizeof v.agent, agent);
    }
}

// Why the field cannot take spoken words now, in the daemon's and the desktop's words; NULL when it can.
static const char *form_voice_refusal(void)
{
    if (!v.form_ok) return "Open a field and say its name again.";
    if (!form.active || strcmp(form.id, v.form_id)) return "Open New Harness again.";
    if (form.busy) return "Wait for the current choice.";
    if (v.form_rev != (int64_t)form.revision) return "Choices changed. Try again.";
    if (!form.picking && form.row == ROW_START) return "Choose an Agent or Project field to search.";
    return NULL;
}

// The agent unnamed words go to: the one the bar is on, else the first free one the device may talk to.
static int voice_target(void)
{
    int target = find_agent(s.focus);
    if (target >= 0 && lacks(&agents[target], 'v')) target = -1;
    const int n = agent_count();
    for (int i = 0; target < 0 && i < n; i++) if (idle(&agents[i]) && !lacks(&agents[i], 'v')) target = i;
    for (int i = 0; target < 0 && i < n; i++) if (!lacks(&agents[i], 'v')) target = i;
    return target < 0 ? 0 : target;
}

static void on_voice_end(const cJSON *m)
{
    const char *upload = str_of(m, "uploadId");
    if (!v.open || strcmp(upload ? upload : "", v.upload)) return;   // not the recording in progress
    person();
    v.open = false;
    const char *refusal = NULL;
    switch (v.kind) {
    case V_QUESTION: refusal = "This question changed. Open it again."; break;   // no question here takes words
    case V_DRAFT: refusal = "That draft changed. Review it again."; break;
    case V_CARRY: refusal = "Choose the carried text and its recipient again."; break;
    case V_SEARCH: refusal = "Choose the passage again."; break;
    case V_SELECTION: refusal = "Choose the text again."; break;
    case V_FORM: refusal = form_voice_refusal(); break;
    default: break;
    }
    // An agent whose terminal the device cannot type into: refused whatever was recorded, as the daemon keeps none of it.
    const int named = v.kind == V_AGENT && v.named ? find_agent(v.agent) : -1;
    if (!refusal && named >= 0 && lacks(&agents[named], 'v'))
        refusal = in_app(&agents[named], "This agent is in ", ". Talking to it from the device comes in an update.");
    if (!refusal && v.bytes < MIN_PCM) refusal = "Didn't catch that";
    if (!refusal && v.kind == V_AGENT && v.named && named < 0)
        refusal = "Could not reach that harness. Check its connection and try again.";
    if (refusal) {
        voice_error(refusal);
        memset(&v, 0, sizeof v);
        return;
    }
    if (v.kind == V_AGENT && !v.named) copy(v.agent, sizeof v.agent, agents[voice_target()].id);
    v.said = s.said_next;
    if (v.kind == V_AGENT) s.said_next = (uint8_t)((s.said_next + 1) % N_SAID);
    v.thinking = true;
    v.ready_at = s.now + THINK_MS;
}

static void on_voice_abort(const cJSON *m)
{
    const char *upload = str_of(m, "uploadId");
    person();
    if (!upload || !strcmp(upload, v.upload)) memset(&v, 0, sizeof v);
}

static void put_form(bool ok, const char *error)
{
    f_b("ok", ok);
    f_b("active", form.active);
    if (form.active) {
        f_i("revision", form.revision);
        if (form.picking) {
            const bool engines = form.row == ROW_AGENT;
            const unsigned count = engines ? 2 : N_PROJECTS;
            const unsigned p = form.pick;
#define OPTION(i) (engines ? ENGINE_NAMES[i] : PROJECTS[i].title)
            f_s("title", ROW_LABELS[form.row]);
            f_s("label", OPTION(p));
            f_s("detail", engines ? ENGINE_DETAILS[p] : PROJECTS[p].detail);
            f_s("previous", p > 0 ? OPTION(p - 1) : "");
            f_s("next", p + 1 < count ? OPTION(p + 1) : "");
#undef OPTION
            f_s("action", "choose");
            f_i("position", p + 1);
            f_i("total", count);
            f_b("canQuery", true);
            f_s("query", form.query);
        } else {
            char start[64];
            const int n = snprintf(start, sizeof start, "%s\n%s", ENGINE_NAMES[form.engine], PROJECTS[form.project].title);
            if (n < 0 || (size_t)n >= sizeof start) start[0] = 0;
            const char *detail = form.row == ROW_AGENT ? ENGINE_NAMES[form.engine]
                               : form.row == ROW_PROJECT ? PROJECTS[form.project].title : start;
            f_s("title", "New Harness");
            f_s("label", ROW_LABELS[form.row]);
            f_s("detail", detail);
            f_s("previous", form.row > 0 ? ROW_LABELS[form.row - 1] : "");
            f_s("next", form.row + 1 < ROWS ? ROW_LABELS[form.row + 1] : "");
            f_s("action", form.row == ROW_START ? "start" : "open");
            f_i("position", form.row + 1);
            f_i("total", ROWS);
            f_b("canQuery", form.row != ROW_START);
            f_s("query", "");
        }
        f_b("busy", form.busy);
        f_b("enabled", !form.busy);
        if (form.busy) f_s("status", "Starting…");
    }
    if (error || form.error) f_s("error", error ? error : form.error);
}

static void form_reply(const char *request, const char *id, bool ok, const char *error)
{
    f_begin("form.state");
    f_s("requestId", request);
    f_s("formId", id);
    put_form(ok, error);
    f_end();
}

// windowForm.ts's refusal: no snapshot, only why.
static void form_fail(const char *request, const char *id, const char *error)
{
    f_begin("form.state");
    f_s("requestId", request);
    f_s("formId", id);
    f_b("ok", false);
    f_b("active", false);
    f_s("error", error);
    f_end();
}

static void on_form(const cJSON *m)
{
    const char *op = str_of(m, "op"), *id = id_of(m, "formId"), *request = id_of(m, "requestId");
    if (!request || !id) return;   // nothing to say the answer to
    person();
    int64_t revision = -1, delta = 0;
    const bool has_revision = int_of(m, "revision", &revision);
    const bool has_delta = int_of(m, "delta", &delta);
    const char *surface = str_of(m, "surface");
    static const char *const OPS[] = {"open", "state", "move", "activate", "back", "close"};
    bool known = false;
    for (size_t i = 0; op && i < sizeof OPS / sizeof OPS[0]; i++) known |= !strcmp(op, OPS[i]);
    // windowForm.ts's checks. Only the New Harness surface is here: a search picker is not part of the demo.
    if (!known || !word(id, 48, false) || (has_key(m, "surface") && !(surface && !strcmp(surface, "new"))) ||
        (!strcmp(op, "move") && (!has_delta || !delta || delta > 8 || delta < -8)) ||
        (strcmp(op, "open") && (!has_revision || revision < 0))) {
        form_fail(request, id, "Invalid form command.");
        return;
    }
    if (!strcmp(op, "open")) {
        if (!form.active || strcmp(form.id, id)) {
            memset(&form, 0, sizeof form);
            copy(form.id, sizeof form.id, id);
            form.active = true;
            form.row = ROW_START;   // the desktop's default: ready to start with what it last had
            form.revision = ++s.serial;
        }
        form_reply(request, id, true, NULL);
        return;
    }
    if (strcmp(form.id, id) || (!form.active && !form.closed)) { form_fail(request, id, "Open New Harness again."); return; }
    if (!form.active) {
        if (!strcmp(op, "state") || !strcmp(op, "close")) form_reply(request, id, true, NULL);
        else form_fail(request, id, "Open New Harness again.");
        return;
    }
    if (!strcmp(op, "state")) { form_reply(request, id, true, NULL); return; }
    if (form.busy) { form_reply(request, id, false, "Wait for the current choice."); return; }
    if (revision != (int64_t)form.revision) { form_reply(request, id, false, "Choices changed. Try again."); return; }
    form.error = NULL;
    if (!strcmp(op, "move")) {
        const int count = form.picking ? (form.row == ROW_AGENT ? 2 : N_PROJECTS) : ROWS;
        int at = (form.picking ? form.pick : form.row) + (int)delta;
        if (at < 0) at = 0;
        if (at > count - 1) at = count - 1;
        if (form.picking && at != form.pick) { form.pick = (uint8_t)at; form.query = NULL; form.revision = ++s.serial; }
        if (!form.picking && at != form.row) { form.row = (uint8_t)at; form.revision = ++s.serial; }
    } else if (!strcmp(op, "activate")) {
        if (form.picking) {
            if (form.row == ROW_AGENT) form.engine = form.pick;
            else form.project = form.pick;
            form.picking = false;
            form.query = NULL;
        } else if (form.row == ROW_START) {
            form.busy = true;
            form.start_at = s.now + CREATE_MS;
        } else {
            form.picking = true;
            form.pick = form.row == ROW_AGENT ? form.engine : form.project;
        }
        form.revision = ++s.serial;
    } else if (!strcmp(op, "back")) {
        if (form.picking) {
            form.picking = false;
            form.query = NULL;
            form.revision = ++s.serial;
        } else {
            form.active = false;
            form.closed = true;
        }
    } else {   // close
        form.active = false;
        form.closed = true;
    }
    form_reply(request, id, true, NULL);
}

// New Harness's Start, a moment later: the agent arrives in Harness, whose window comes to the front, so the device is
// turned to Harness's ring, on the new agent.
static void create_agent(void)
{
    form.busy = false;
    form.revision = ++s.serial;
    const int n = agent_count();
    if (n >= MAX_AGENTS) {
        form.error = "The bar holds 12 agents. Wait for one to finish.";
        return;
    }
    agent_t *a = &agents[n];
    memset(a, 0, sizeof *a);
    a->used = a->made = true;
    a->said = -1;
    a->engine = form.engine;
    a->app = APP_HARNESS;
    s.made = (uint8_t)(s.made + 1);
    int w = snprintf(a->id, sizeof a->id, "ag-new-%u", (unsigned)s.made);
    if (w < 0 || (size_t)w >= sizeof a->id) a->id[0] = 0;
    // Named after its project, as the desktop names one; a second on the same project is told apart.
    copy(a->name, sizeof a->name, PROJECTS[form.project].title);
    for (unsigned k = 2; k < 10; k++) {
        bool taken = false;
        for (int i = 0; i < n; i++) taken |= !strcmp(agents[i].name, a->name);
        if (!taken) break;
        w = snprintf(a->name, sizeof a->name, "%s-%u", PROJECTS[form.project].title, k);
        if (w < 0 || (size_t)w >= sizeof a->name) break;
    }
    copy(s.focus, sizeof s.focus, a->id);   // the push re-asserts it once the tile is there
    s.front = APP_HARNESS;
    s.shown = APP_HARNESS;
    s.owed |= OWE_AGENTS;
    form.active = false;
    form.closed = true;
    start_turn(a, SETUP, VOICE_TURN_MS);
}

// The spoken name lands in the field's list: the list opens on what was heard.
static void hear_form(void)
{
    const char *refusal = form_voice_refusal();
    if (refusal) { voice_error(refusal); return; }
    const unsigned field = form.row == ROW_AGENT ? 0 : 1;
    form.picking = true;
    form.pick = HEARD[field].pick;
    form.query = HEARD[field].said;
    form.revision = ++s.serial;
    f_begin("voice.form");
    f_s("uploadId", v.upload);
    f_s("formId", form.id);
    put_form(true, NULL);
    f_end();
}

static void hear_agent(void)
{
    const int i = find_agent(v.agent);
    if (i < 0) { voice_error("Could not reach that harness. Check its connection and try again."); return; }
    agent_t *a = &agents[i];
    f_begin("voice.transcript");
    f_s("routeId", "");
    f_s("text", SAID[v.said].said);
    f_s("agentId", a->id);
    f_s("agentName", a->name);
    f_b("needsConfirm", false);
    if (v.upload[0]) f_s("uploadId", v.upload);
    f_end();
    a->said = (int8_t)v.said;   // goes when the agent is free
    a->said_at = s.now + VOICE_TURN_MS;
}

static void on_question_read(const cJSON *m)
{
    const char *agent = id_of(m, "agentId"), *request = id_of(m, "requestId");
    if (!agent || !request) return;
    // No person(): the Max reads every question the moment it arrives, so a read says nobody is at the bar.
    const int i = find_agent(agent);
    const agent_t *a = i >= 0 ? &agents[i] : NULL;
    f_begin("question.state");
    f_s("agentId", agent);
    f_s("requestId", request);
    who(a);
    if (a && a->ask != ASK_NONE) {
        char id[40], token[48];
        question_id(a, id, sizeof id);
        question_token(a, token, sizeof token);
        f_b("ok", true);
        f_s("id", id);
        f_s("token", token);
        put_questions(a, true);
        f_b("submitted", a->ask == ASK_TAKEN);
    } else {
        f_b("ok", false);
        f_s("error", "No readable question. Check the terminal.");
    }
    f_end();
}

// questionInbox.ts submit: one mask per question, one bit per option, one bit for a single choice.
static const char *review_refusal(const agent_t *a, const cJSON *m)
{
    const cJSON *choices = cJSON_GetObjectItemCaseSensitive(m, "choices");
    if (!cJSON_IsArray(choices) || cJSON_GetArraySize(choices) != 1) return "Review every answer first.";
    const cJSON *mask = cJSON_GetArrayItem(choices, 0);
    const double d = cJSON_IsNumber(mask) ? mask->valuedouble : 0;
    unsigned bit = 0;
    for (; bit < a->q->count && d != (double)(1u << bit); bit++) {}
    if (bit >= a->q->count) return "Choose an answer from this question.";
    const cJSON *drafts = cJSON_GetObjectItemCaseSensitive(m, "drafts"), *draft;
    // A spoken answer the demo never took cannot be part of this one.
    cJSON_ArrayForEach(draft, drafts) if (!cJSON_IsNull(draft)) return "Review the spoken answer again.";
    return NULL;
}

static void on_answer_reviewed(const cJSON *m)
{
    const char *agent = id_of(m, "agentId"), *token = id_of(m, "token"), *request = id_of(m, "requestId");
    if (!agent || !token || !request) return;
    person();
    const int i = find_agent(agent);
    agent_t *a = i >= 0 ? &agents[i] : NULL;
    char current[48] = "";
    if (a && a->ask != ASK_NONE) question_token(a, current, sizeof current);
    // A shown-only question is refused before anything is taken: taken, it would read as sent on the device.
    const char *refusal = current[0] && lacks(a, 'a') ? in_app(a, "Answer it in ", ".")
                        : !current[0] || strcmp(current, token) ? "This question changed. Open it again."
                        : a->ask == ASK_TAKEN ? NULL   // sent twice, taken once: the same receipt again
                        : review_refusal(a, m);
    if (!refusal && a->ask == ASK_OPEN) {
        const cJSON *mask = cJSON_GetArrayItem(cJSON_GetObjectItemCaseSensitive(m, "choices"), 0);
        uint8_t choice = 0;
        while (mask->valuedouble != (double)(1u << choice)) choice++;
        a->choice = choice;
        a->ask = ASK_TAKEN;
        a->close_at = s.now + CLOSE_MS;
    }
    // This computer takes it at once: never `pending`, which is another machine's.
    f_begin("answer.receipt");
    f_s("agentId", agent);
    f_s("token", token);
    f_s("requestId", request);
    f_b("ok", !refusal);
    if (refusal) f_s("error", refusal);
    f_end();
}

// The older answer: the label chosen, by the key asked with, for the question named by requestId. No receipt; an
// agent the device may not answer gets the daemon's toast instead.
static void on_answer(const cJSON *m)
{
    const char *request = str_of(m, "requestId");
    const cJSON *answers = cJSON_GetObjectItemCaseSensitive(m, "answers");
    if (!str_of(m, "agentId") || !request || !cJSON_IsObject(answers)) return;
    person();
    const int i = find_agent(str_of(m, "agentId"));
    if (i >= 0 && lacks(&agents[i], 'a')) {
        send_toast(!strncmp(request, "shown:", 6) ? in_app(&agents[i], "Answer it in ", ".")
                   : in_app(&agents[i], "This agent is in ", ". Answering it from the device comes in an update."));
        return;
    }
    if (i < 0 || agents[i].ask != ASK_OPEN) return;
    agent_t *a = &agents[i];
    char id[40];
    question_id(a, id, sizeof id);
    if (strcmp(id, request)) return;
    const char *label = str_of(answers, a->q->q);
    for (uint8_t o = 0; label && o < a->q->count; o++) {
        if (strcmp(label, a->q->options[o])) continue;
        a->choice = o;
        a->ask = ASK_TAKEN;
        a->close_at = s.now + CLOSE_MS;
        return;
    }
}

static void on_machine_select(const cJSON *m)
{
    const char *id = id_of(m, "machineId");
    if (!id) return;
    person();
    if (!strcmp(id, MACHINE_ID)) {
        f_begin("machine.selected");
        f_s("machineId", id);
        f_end();
        s.owed |= OWE_MACHINES;
        return;
    }
    f_begin("machine.error");
    f_s("machineId", id);
    f_s("code", "unknown-machine");
    f_s("message", "That machine is not on this account.");
    f_end();
}

static void on_notif_read(const cJSON *m)
{
    const int i = find_agent(str_of(m, "agentId"));
    if (i < 0) return;
    person();
    agent_t *a = &agents[i];
    const char *token = str_of(m, "readToken");
    const bool token_ok = token && word(token, 63, true);
    char current[24];
    read_token(a, current, sizeof current);
    if (!token || !strcmp(token, current)) a->unread = false;
    f_begin("notif.seen");
    f_s("agentId", a->id);
    if (token_ok) f_s("readToken", token);
    f_end();
}

static void on_turn_stop(const cJSON *m)
{
    const int i = find_agent(str_of(m, "agentId"));
    if (i < 0) return;
    person();
    agent_t *a = &agents[i];
    if (outside(a)) {
        send_toast(in_app(a, "This agent is in ", ". Stopping it from the device comes in an update."));
        return;
    }
    if (!a->turn && a->ask == ASK_NONE) return;
    if (a->ask != ASK_NONE) {
        char id[40];
        question_id(a, id, sizeof id);
        f_begin("question.close");
        f_s("agentId", a->id);
        f_s("id", id);
        f_end();
    }
    f_begin("turn.done");
    f_s("agentId", a->id);
    f_end();
    end_turn(a, ST_IDLE);
}

static void on_library_get(const cJSON *m)
{
    int64_t offset, request;
    if (!s.player || !int_of(m, "offset", &offset) || !int_of(m, "request", &request) || offset < 0 || request < 0) return;
    s.library_offset = offset;
    s.library_request = request;
    push_library();
}

static void handle(const cJSON *m)
{
    const char *t = str_of(m, "t");
    if (!t) return;
    if (!strcmp(t, "hello")) { on_hello(m); return; }
    if (!s.greeted) return;   // a device that has not greeted is answered nothing else
    if (!strcmp(t, "machines.list")) s.owed |= OWE_MACHINES;
    else if (!strcmp(t, "agents.list")) s.owed |= OWE_FULL;
    else if (!strcmp(t, "agents.refresh")) s.owed |= OWE_AGENTS;
    else if (!strcmp(t, "swarms.list")) s.owed |= OWE_SWARMS;
    else if (!strcmp(t, "resync")) {
        if (!due(s.now, s.resync_ok_at)) return;
        s.resync_ok_at = s.now + RESYNC_GAP_MS;
        s.owed |= OWE_RESYNC;
    }
    else if (!strcmp(t, "player.library.get")) on_library_get(m);
    else if (!strcmp(t, "app.pick")) on_app_pick(m);
    else if (!strcmp(t, "agent.open")) on_agent_open(m);
    else if (!strcmp(t, "focus")) {
        person();
        const int i = find_agent(str_of(m, "agentId"));
        if (i >= 0) copy(s.focus, sizeof s.focus, agents[i].id);
    }
    else if (!strcmp(t, "voice.begin")) on_voice_begin(m);
    else if (!strcmp(t, "voice.end")) on_voice_end(m);
    else if (!strcmp(t, "voice.abort")) on_voice_abort(m);
    else if (!strcmp(t, "question.read")) on_question_read(m);
    else if (!strcmp(t, "answer.reviewed")) on_answer_reviewed(m);
    else if (!strcmp(t, "answer")) on_answer(m);
    else if (!strcmp(t, "form")) on_form(m);
    else if (!strcmp(t, "machine.select")) on_machine_select(m);
    else if (!strcmp(t, "notif.read")) on_notif_read(m);
    else if (!strcmp(t, "turn.stop")) on_turn_stop(m);
    // pong is only proof of life, which every frame already is; the rest a demo has nothing to say to.
}

// ── the four calls ──────────────────────────────────────────────────────────────────────────────────

void max_demo_reset(uint32_t now_ms)
{
    memset(&s, 0, sizeof s);
    memset(agents, 0, sizeof agents);
    memset(&v, 0, sizeof v);
    memset(&form, 0, sizeof form);
    q_n = 0;
    q_used = 0;
    sink = NULL;
    s.now = s.last_rx = s.last_ping = s.last_tick = s.resync_ok_at = s.library_at = now_ms;
    // The story opens with its first app in front, and shown: that entry is played. (Left due at story time 0, it
    // would be due before the story has counted any time, which advances nothing.)
    s.front = s.shown = FRONT[0].app;
    s.next_front = 1;
    for (int i = 0; i < SCRIPTED; i++) {
        agent_t *a = &agents[i];
        a->used = true;
        copy(a->id, sizeof a->id, CAST[i].id);
        copy(a->name, sizeof a->name, CAST[i].name);
        a->engine = CAST[i].engine;
        a->app = CAST[i].app;
        a->recap = CAST[i].recap;
        a->text = CAST[i].text;
        a->full = CAST[i].full;
        a->status = ST_IDLE;
        a->said = -1;
    }
    for (int i = SCRIPTED; i < MAX_AGENTS; i++) agents[i].said = -1;
}

void max_demo_receive(uint8_t type, const uint8_t *payload, size_t len, uint32_t now_ms)
{
    s.now = now_ms;
    s.last_rx = now_ms;   // any frame is proof of life
    if (!payload && len) return;
    if (type == CABLE_TYPE_PCM) {
        if (!s.greeted || !v.open) return;
        person();
        v.bytes = len >= (size_t)(VOICE_MAX_BYTES - v.bytes) ? (uint32_t)VOICE_MAX_BYTES : v.bytes + (uint32_t)len;
        return;
    }
    if (type != CABLE_TYPE_JSON || len == 0 || len > CABLE_MAX_PAYLOAD) return;
    // As the firmware parses the daemon: the guard first, then a complete object and nothing but space after it.
    if (!cable_json_guard(payload, len)) return;
    const char *end = NULL;
    cJSON *m = cJSON_ParseWithLengthOpts((const char *)payload, len, &end, false);
    if (!m) return;
    const char *limit = (const char *)payload + len;
    while (end && end < limit && (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r')) end++;
    if (end == limit && cJSON_IsObject(m)) handle(m);
    cJSON_Delete(m);
}

void max_demo_tick(uint32_t now_ms, max_demo_emit_fn emit, void *ctx)
{
    s.now = now_ms;
    // The replies first, in the order they were written.
    for (unsigned i = 0, at = 0; i < q_n; at += q_len[i], i++) emit(CABLE_TYPE_JSON, (const uint8_t *)q_buf + at, q_len[i], ctx);
    q_n = 0;
    q_used = 0;
    sink = emit;
    sink_ctx = ctx;

    if ((uint32_t)(now_ms - s.last_rx) > SILENCE_MS) {
        end_session();
        s.last_rx = now_ms;
    }
    if ((uint32_t)(now_ms - s.last_ping) >= PING_MS) {
        s.last_ping = now_ms;
        f_begin("ping");
        f_end();
    }
    if (v.thinking && due(now_ms, v.ready_at)) {
        if (v.kind == V_FORM) hear_form();
        else hear_agent();
        memset(&v, 0, sizeof v);
    }
    if (form.active && form.busy && due(now_ms, form.start_at)) create_agent();
    if (s.greeted && s.owed) push_owed();
    s.owed = 0;

    if (s.greeted && !person_here(now_ms)) {
        const uint32_t from = story_from();
        if ((int32_t)(now_ms - from) > 0) {
            const uint32_t dt = now_ms - from;
            advance_story(dt > STEP_CAP_MS ? STEP_CAP_MS : dt);
        }
    }
    s.last_tick = now_ms;
    if (s.person && !person_here(now_ms)) s.person = false;
    for (int i = 0; i < MAX_AGENTS && agents[i].used; i++) run_agent(&agents[i]);
    if (s.owed && s.greeted) push_owed();   // the story's own roster changes, and the app in front
    s.owed = 0;

    if (s.greeted && s.app_filter) {
        // A count, a waiting count or the shown app changed with no ring to carry it: `apps` alone.
        char k[sizeof s.apps_key];
        apps_key(k);
        if (strcmp(k, s.apps_key)) push_apps();
    }
    if (s.greeted && s.player) {
        char k[MAX_AGENTS + 1];
        library_key(k);
        if (strcmp(k, s.library_key) || (uint32_t)(now_ms - s.library_at) >= LIBRARY_MS) push_library();
    }
    sink = NULL;
    sink_ctx = NULL;
}

uint32_t max_demo_next_ms(uint32_t now_ms)
{
    if (q_n || (s.greeted && s.owed)) return now_ms;
    uint32_t best = now_ms + 1000;
#define SOON(at)                                                  \
    do {                                                          \
        const uint32_t at_ = (at);                                \
        if ((int32_t)(at_ - now_ms) <= 0) return now_ms;          \
        if ((int32_t)(at_ - best) < 0) best = at_;                \
    } while (0)
    SOON(s.last_ping + PING_MS);
    SOON(s.last_rx + SILENCE_MS + 1);
    if (v.thinking) SOON(v.ready_at);
    if (form.active && form.busy) SOON(form.start_at);
    for (int i = 0; i < MAX_AGENTS && agents[i].used; i++) {
        const agent_t *a = &agents[i];
        if (a->ask == ASK_TAKEN) SOON(a->close_at);
        else if (a->turn && a->ask == ASK_NONE) SOON(a->beat_at);
        else if (!a->turn && a->said >= 0) SOON(a->said_at);
    }
    if (s.person) SOON(s.person_at + QUIET_MS);
    if (s.greeted) {
        if (s.player) SOON(s.library_at + LIBRARY_MS);
        if (!person_here(now_ms)) SOON(story_from() + story_wait());
    }
#undef SOON
    return best;
}
