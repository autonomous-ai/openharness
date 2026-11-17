// The scripted demo daemon: see max_demo.h.
//
// What it says, and in what order, is cableSession.ts's (cli/src/cable): the same messages and fields, so a bar showing
// this story shows a real computer the same way. It leaves out what only a real computer has: firmware updates, pets,
// apps and windows, model lists, drafts and passages.
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
    CYCLE_MS = 150000,       // one telling of the story
    STEP_CAP_MS = 10000,     // a host that stalled does not fast-forward the story through the stall
    THINK_MS = 1500,         // from the end of a recording to its words
    CLOSE_MS = 1000,         // from an answer's receipt to its question closing (the agent taking it)
    VOICE_TURN_MS = 500,     // from the words to the agent starting on them
    CREATE_MS = 1500,        // New Harness starting an agent
    UNATTENDED_MS = 40000,   // story time an unanswered question waits before it is answered on the computer
    MIN_PCM = 3200,          // 0.1 s of 16 kHz, 16-bit audio: less is nothing said
    VOICE_MAX_BYTES = 10 * 60 * 32000,   // the daemon's ceiling on one recording
    MAX_AGENTS = 8,
    SCRIPTED = 5,
    PAGE_ROWS = 6,           // cableSession.ts: a library page
    DRAWER_ROWS = 8,
    ID_MAX = 64,             // the longest id the device may send that is said back
};

static bool due(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }

// ── the cast ────────────────────────────────────────────────────────────────────────────────────────

static const struct { const char *id, *name; } MACHINES[] = {
    {"m-mbp", "MacBook Pro"}, {"m-studio", "Mac Studio"}, {"m-build", "Build server"}};
enum { LOCAL = 0, N_MACHINES = 3 };   // the computer the cable is on

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
// sent with `permission: true` as the daemon marks one, so the bar draws it as approve/deny.
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

// harness-web: a spinner on the sign-in button. It asks where the spinner goes, and each answer ends its own way.
static const beat_t WEB_INSIDE[] = {
    START(0, "Working…"),
    ACT(5, "Styling the button", "Putting the spinner inside the button; its width stays fixed so the label never jumps."),
    STEP(10, "Edit · SignInButton.css"),
    STEP(15, "Bash · npm test -- SignInButton"),
    TIMER(20, "Running tests"),
    STATS(25, 42, 0, 1, 31, 4),
    DONE(0, TIER_ALERT, "Sign-in button shows a spinner",
         "The sign-in button shows a spinner inside it while signing in, and stays disabled until it ends. 42/42 tests pass.",
         "Added an isLoading prop to SignInButton, driven by useSignIn. While a sign-in is in flight the button is disabled "
         "and shows a 16 px spinner in place of its label; its width is fixed so nothing shifts. 42/42 tests pass. "
         "One commit: Show a spinner while signing in."),
    END};
static const beat_t WEB_NEXT[] = {
    START(0, "Working…"),
    ACT(5, "Styling the button", "Placing the spinner beside the button, aligned to its baseline."),
    STEP(10, "Edit · SignInForm.css"),
    STEP(15, "Bash · npm test -- SignInButton"),
    TIMER(20, "Running tests"),
    STATS(25, 42, 0, 1, 29, 4),
    DONE(0, TIER_ALERT, "Sign-in button shows a spinner",
         "A spinner now sits next to the button while signing in, and the button stays disabled. 42/42 tests pass.",
         "Added an isLoading prop to SignInButton, driven by useSignIn. While a sign-in is in flight the button is disabled "
         "and a 16 px spinner sits next to the button, on its baseline. 42/42 tests pass. "
         "One commit: Show a spinner while signing in."),
    END};
static const beat_t WEB_OVERLAY[] = {
    START(0, "Working…"),
    ACT(5, "Adding the overlay", "Covering the form with a dimmed overlay and a centered spinner while it signs in."),
    STEP(10, "Edit · SignInForm.tsx"),
    STEP(15, "Bash · npm test -- SignIn"),
    TIMER(20, "Running tests"),
    STATS(25, 42, 0, 1, 33, 5),
    DONE(0, TIER_ALERT, "Sign-in shows a loading overlay",
         "A full-screen overlay with a spinner now covers the form while signing in. 42/42 tests pass.",
         "Added a LoadingOverlay over the sign-in form, shown while useSignIn is loading; it blocks input and centers a "
         "spinner. 42/42 tests pass. One commit: Show an overlay while signing in."),
    END};
static const question_t Q_SPINNER = {
    "Where should the spinner go?", {"Inside the button", "Next to the button", "Full-screen overlay"}, 3, false,
    {WEB_INSIDE, WEB_NEXT, WEB_OVERLAY}};
static const beat_t WEB_SPINNER[] = {
    START(0, "Working…"),
    ACT(10, "Reading the sign-in form", "Finding where the sign-in button handles its pending state."),
    STEP(5, "Read · SignInButton.tsx"),
    STEP(15, "Read · useSignIn.ts"),
    ACT(15, "Thinking", "The button has no pending state; I'll drive one from useSignIn's isLoading."),
    STEP(15, "Edit · SignInButton.tsx"),
    ACT(20, "Choosing a layout", "Before I style it: where should the spinner sit?"),
    ASK(10, Q_SPINNER),
    END};

// harness-backend: a deploy to staging, which needs a person's yes.
static const beat_t API_DEPLOY[] = {
    START(0, "Working…"),
    STEP(5, "Bash · npm run deploy:staging"),
    TIMER(20, "Deploying"),
    TIMER(20, "Deploying"),
    ACT(15, "Checking health", "Deployed. Checking /health on staging."),
    STEP(5, "Bash · curl -fsS https://staging.harness.dev/health"),
    STATS(15, 128, 0, 0, 22, 4),
    DONE(0, TIER_ALERT, "API is live on staging", "The API is deployed to staging and /health answers 200.",
         "Built the API, ran its 128 tests (all pass), deployed it to staging with npm run deploy:staging and checked "
         "/health, which answers 200. Nothing else changed."),
    END};
static const beat_t API_STOP[] = {
    DONE(5, TIER_LIST, "Stopped before deploying to staging",
         "You declined the deploy, so nothing was pushed. The build and its 128 tests are green.",
         "Built the API and ran its 128 tests (all pass). The deploy was declined, so staging still runs yesterday's "
         "build. Run npm run deploy:staging when you are ready."),
    END};
static const question_t Q_DEPLOY = {
    "Approve Bash command: npm run deploy:staging", {"Yes", "Yes, and don't ask again for: npm run deploy:*", "No"}, 3, true,
    {API_DEPLOY, API_DEPLOY, API_STOP}};
static const beat_t API_PREPARE[] = {
    START(0, "Working…"),
    ACT(10, "Checking the branch", "Building the API and running its tests before the staging deploy."),
    STEP(10, "Bash · npm run build"),
    TIMER(20, "Building"),
    STEP(15, "Bash · npm test"),
    TIMER(20, "Running tests"),
    ACT(15, "Ready to deploy", "Build and tests are green. The deploy script needs your approval."),
    ASK(10, Q_DEPLOY),
    END};

// ios-release: a long build, with the footer's timer.
static const beat_t IOS_SHIP[] = {
    START(0, "Working…"),
    ACT(10, "Bumping the build", "Bumping the build to 0.1.71 (212), then archiving the release."),
    STEP(5, "Edit · pubspec.yaml"),
    STEP(15, "Bash · flutter build ipa --release"),
    TIMER(30, "Archiving"),
    TIMER(40, "Archiving"),
    TIMER(40, "Archiving"),
    ACT(30, "Signing", "The archive is built. Signing it with the App Store profile."),
    STEP(20, "Bash · xcrun altool --upload-app"),
    TIMER(30, "Uploading"),
    TIMER(40, "Uploading"),
    ACT(30, "Processing", "Uploaded. Waiting for App Store Connect to finish processing."),
    TIMER(40, "Processing"),
    STATS(30, 0, 0, 1, 12, 2),
    DONE(0, TIER_ALERT, "0.1.71 is on TestFlight",
         "Build 0.1.71 (212) is uploaded and processed. Testers can install it from TestFlight now.",
         "Bumped the version to 0.1.71 (212), archived and signed the release, uploaded it and waited for processing. "
         "It is in TestFlight for the internal group. One commit: Release 0.1.71."),
    END};

// near-app: a test run that fails, then the fix.
static const beat_t NEAR_CARDS[] = {
    START(0, "Working…"),
    ACT(10, "Updating the roster", "Moving the roster screen to the new card layout."),
    STEP(5, "Edit · roster_card.dart"),
    STEP(15, "Edit · roster_screen.dart"),
    STEP(15, "Bash · flutter test test/roster"),
    TIMER(15, "Running tests"),
    FAIL(20, "flutter test failed: 2 golden snapshots out of date"),
    END};
static const beat_t NEAR_FIX[] = {
    START(0, "Working…"),
    ACT(10, "Updating goldens", "Both goldens changed on purpose with the new cards; updating them."),
    STEP(5, "Bash · flutter test --update-goldens test/roster"),
    TIMER(20, "Running tests"),
    STEP(10, "Bash · flutter test"),
    TIMER(20, "Running tests"),
    STATS(10, 87, 0, 1, 14, 2),
    DONE(0, TIER_LIST, "Roster goldens updated; 87/87 pass",
         "The two roster goldens now match the new card layout. 87/87 tests pass.",
         "The failures were the two roster goldens, which changed on purpose with the new cards. Regenerated them, "
         "checked the images by eye and ran the whole suite: 87/87 pass. One commit: Update roster goldens."),
    END};

// docs-site: small work nobody needs to hear about.
static const beat_t DOCS_LINKS[] = {
    START(0, "Working…"),
    ACT(10, "Checking links", "Scanning the docs for broken links."),
    STEP(5, "Bash · npm run check-links"),
    TIMER(20, "Checking links"),
    STEP(15, "Edit · getting-started.md"),
    STEP(10, "Edit · cable.md"),
    STATS(15, 0, 0, 1, 8, 1),
    DONE(0, TIER_SILENT, "Fixed 3 broken links in the docs", "Three links pointed at pages that moved; they point at the new ones.",
         "check-links found three links to pages that moved in the last restructure, in getting-started.md and cable.md. "
         "They now point at the new pages. One commit: Fix moved links."),
    END};

// harness-web again: the review on its pull request.
static const beat_t WEB_REVIEW[] = {
    START(0, "Working…"),
    ACT(10, "Reading the review", "Going through the four review comments on the sign-in pull request."),
    STEP(5, "Bash · gh pr view 412 --comments"),
    STEP(15, "Edit · SignInButton.tsx"),
    STEP(15, "Edit · useSignIn.ts"),
    STEP(10, "Bash · npm test"),
    TIMER(20, "Running tests"),
    STATS(15, 42, 0, 1, 26, 3),
    DONE(0, TIER_LIST, "Review comments addressed on PR #412",
         "All four review comments on the sign-in PR are addressed and pushed. 42/42 tests pass.",
         "Renamed isLoading to pending, moved the spinner size into the theme, added an aria-busy attribute and a test "
         "for a failed sign-in. 42/42 tests pass. Pushed to the PR; it is ready for another look."),
    END};

static const struct { uint32_t at; uint8_t agent; const beat_t *turn; } STORY[] = {
    {2000, 0, WEB_SPINNER}, {5000, 4, IOS_SHIP}, {9000, 2, API_PREPARE}, {30000, 1, NEAR_CARDS},
    {58000, 1, NEAR_FIX}, {75000, 3, DOCS_LINKS}, {100000, 0, WEB_REVIEW}};
enum { N_STORY = sizeof STORY / sizeof STORY[0] };

// What a person says, in turn, and what the agent then does.
static const beat_t SAID_RETRY[] = {
    START(0, "Working…"),
    ACT(10, "Reading the upload client", "Adding a retry with backoff around the upload request."),
    STEP(5, "Edit · uploadClient.ts"),
    STEP(15, "Bash · npm test -- upload"),
    TIMER(20, "Running tests"),
    STATS(15, 18, 0, 1, 16, 3),
    DONE(0, TIER_ALERT, "Uploads retry 3 times with backoff",
         "The upload client retries a failed upload 3 times, waiting 1, 2 and 4 s. 18/18 tests pass.",
         "Wrapped the upload request in a retry: three tries on a network error or a 5xx, waiting 1, 2 and 4 seconds, "
         "never on a 4xx. Added tests for each case; 18/18 pass. One commit: Retry failed uploads."),
    END};
static const beat_t SAID_TEST[] = {
    START(0, "Working…"),
    ACT(10, "Writing the test", "Adding a test that renders the roster with no agents."),
    STEP(5, "Edit · roster_test.dart"),
    STEP(15, "Bash · flutter test test/roster_test.dart"),
    TIMER(20, "Running tests"),
    STATS(15, 88, 0, 1, 11, 2),
    DONE(0, TIER_ALERT, "Added a test for the empty roster",
         "A new test renders the roster with no agents and checks the empty state. 88/88 tests pass.",
         "Added roster_test.dart: it renders the roster with no agents and checks the empty-state text and the New "
         "Harness button. 88/88 tests pass. One commit: Test the empty roster."),
    END};
static const beat_t SAID_RECAP[] = {
    START(0, "Working…"),
    STEP(10, "Bash · git log --since=8am --oneline"),
    ACT(15, "Reading the log", "Reading today's commits."),
    DONE(20, TIER_ALERT, "Today: 4 commits, sign-in and uploads",
         "Since this morning: a spinner on sign-in, review fixes, upload retries and a release bump.",
         "Four commits since 8 am: a spinner on the sign-in button, the review fixes on PR #412, retries for failed "
         "uploads and the 0.1.71 version bump. Nothing is waiting on you."),
    END};
static const struct { const char *said; const beat_t *turn; } SAID[] = {
    {"Add a retry to the upload client", SAID_RETRY},
    {"Write a test for the empty roster", SAID_TEST},
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

// The five agents the story is about, and what each did last (the history a fresh attach restores).
static const struct {
    const char *id, *name;
    uint8_t engine, machine;
    const char *recap, *text, *full;
} CAST[SCRIPTED] = {
    {"ag-web", "harness-web", 0, 0, "Login page on the new form layout",
     "The login page uses the shared form layout; the old LoginCard is gone. 40/40 tests pass.",
     "Moved the login page onto the shared FormLayout and deleted LoginCard and its styles. 40/40 tests pass."},
    {"ag-near", "near-app", 1, 0, "Roster cards show each agent's machine",
     "Each roster card shows the machine its agent runs on, under the name. 85/85 tests pass.",
     "Added the machine name under each agent on the roster cards, from the agent list's machine field. 85/85 pass."},
    {"ag-api", "harness-backend", 0, 1, "Rate limits on the public API",
     "The public API allows 60 requests a minute per token and answers 429 past that. 126/126 tests pass.",
     "Added a token-bucket limit of 60 requests a minute per token to the public API, with Retry-After on a 429. "
     "126/126 tests pass."},
    {"ag-docs", "docs-site", 1, 1, "Cable protocol page covers proto 3",
     "The cable protocol page documents proto 3: seq, resync and the library page.",
     "Documented proto 3 on the cable page: the seq counter, resync, and the player library page, with examples."},
    {"ag-ios", "ios-release", 0, 2, "0.1.70 is on TestFlight",
     "Build 0.1.70 (211) is uploaded and processed; testers have it.",
     "Archived, signed and uploaded 0.1.70 (211). It is in TestFlight for the internal group."},
};

// New Harness: an engine and a project, then Start.
enum { ROW_AGENT, ROW_PROJECT, ROW_START, ROWS };
static const char *const ROW_LABELS[] = {"Agent", "Project", "New Harness"};
static const struct { const char *title, *detail; uint8_t machine; } PROJECTS[] = {
    {"harness-web", "MacBook Pro", 0}, {"harness-backend", "Mac Studio", 1}, {"infra", "Build server", 2}};
static const char *const ENGINE_DETAILS[] = {"Anthropic", "OpenAI"};
// What a person "says" into the Agent and the Project field, and the option it lands on.
static const struct { const char *said; uint8_t pick; } HEARD[] = {{"Codex", 1}, {"harness-backend", 1}};
enum { N_PROJECTS = sizeof PROJECTS / sizeof PROJECTS[0] };

// ── state ───────────────────────────────────────────────────────────────────────────────────────────

enum { ST_IDLE, ST_WORKING, ST_QUESTION, ST_FINISHED, ST_FAILED };
static const char *const STATUS[] = {"idle", "working", "question", "finished", "failed"};
enum { ASK_NONE, ASK_OPEN, ASK_TAKEN };   // TAKEN: answered, closing in a moment

typedef struct {
    bool used, made;             // made: by a person, with New Harness
    char id[16], name[24];
    uint8_t engine, machine;
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
    uint32_t seq;
    char mac[40], fw[40];
    uint32_t last_rx, last_ping, last_tick, resync_ok_at, library_at;
    char library_key[MAX_AGENTS + 1];
    int64_t library_request, library_offset;
    unsigned owed;               // pushes the next tick makes
    char focus[16];              // the agent both screens are on
    uint8_t selected;            // machine
    bool person;
    uint32_t person_at;
    uint32_t story_pos, story_total;
    uint8_t next_entry;
    uint32_t serial;             // questions, tokens, notices and form revisions: every number only goes up
    uint8_t said_next, made;
    uint32_t dropped;            // frames that did not fit: this module's bug, never the device's
} s;

static agent_t agents[MAX_AGENTS];   // in roster order, the scripted five first

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
static void question_id(const agent_t *a, char *out, size_t cap)
{
    const int n = snprintf(out, cap, "q-%s-%lu", a->id, (unsigned long)a->serial);
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
    f_s("machine", a ? MACHINES[a->machine].name : "");
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
    put_str(MACHINES[LOCAL].id);
    f_s("name", MACHINES[LOCAL].name);
    put("}", 1);
    f_s("selected", MACHINES[s.selected].id);
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
    for (unsigned m = 0; m < N_MACHINES; m++) {
        f_begin("machine");
        f_s("id", MACHINES[m].id);
        f_s("name", MACHINES[m].name);
        f_s("state", "ready");
        f_b("local", m == LOCAL);
        f_end();
    }
    f_begin("machines.end");
    f_s("selected", MACHINES[s.selected].id);
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

static void push_agents(void)
{
    f_begin("agents.begin");
    f_end();
    const int n = agent_count();
    for (int i = 0; i < n; i++) {
        const agent_t *a = &agents[i];
        f_begin("agent");
        f_s("id", a->id);
        f_s("name", a->name);
        f_s("engine", ENGINES[a->engine]);
        f_s("model", "");
        f_s("effort", "");
        f_s("machineId", MACHINES[a->machine].id);
        f_s("machine", MACHINES[a->machine].name);
        f_s("host", "harness");
        f_s("caps", "svfa");
        f_end();
    }
    f_begin("agents.end");
    f_i("total", n);
    f_s("tab", "");
    f_s("view", "machine");
    f_end();
    // The list changed shape under the device: say again which agent both screens are on (the daemon's one re-assert).
    const int f = find_agent(s.focus);
    if (f >= 0) send_focus(&agents[f]);
}

static void library_key(char *out)
{
    const int n = agent_count();
    for (int i = 0; i < n; i++) out[i] = (char)('0' + status_of(&agents[i]));
    out[n] = 0;
}

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
        f_s("machineId", MACHINES[a->machine].id);
        f_s("name", a->name);
        f_s("engine", ENGINES[a->engine]);
        f_s("status", STATUS[status_of(a)]);
        f_i("ageSeconds", -1);
        put("}", 1);
    }
    put("]", 1);
    f_i("machines", N_MACHINES);
    f_end();
    library_key(s.library_key);
    s.library_at = s.now;
}

// History, not news: no tier, no beep (cableSession.ts pushRestores).
static void push_restores(void)
{
    const int n = agent_count();
    for (int i = 0; i < n; i++) {
        const agent_t *a = &agents[i];
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
        f_s("machine", MACHINES[a->machine].name);
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

// The question as the inbox holds it; `state` adds what question.read adds: a remote agent takes no spoken answer.
static void put_questions(const agent_t *a, bool state)
{
    key("questions");
    put_c("[{\"key\":");
    put_str(a->q->q);
    f_s("q", a->q->q);
    key("options");
    put("[", 1);
    for (unsigned o = 0; o < a->q->count; o++) {
        if (o) put(",", 1);
        put_str(a->q->options[o]);
    }
    put("]", 1);
    f_b("multi", false);
    if (state && a->machine != LOCAL) f_b("canText", false);
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
    if (a->q->permission) f_b("permission", true);   // absent, not false, on a plain question: as the daemon sends it
    f_end();
}

static void push_questions(void)
{
    const int n = agent_count();
    for (int i = 0; i < n; i++) if (agents[i].ask == ASK_OPEN) send_question(&agents[i]);
}

// Everything a device that has just greeted has lost, in the daemon's order (pushAgents).
static void push_full(void)
{
    push_machines();
    push_swarms();
    push_agents();
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
        push_agents();
        push_drawer();
        push_questions();
        return;
    }
    if (owed & OWE_SWARMS) push_swarms();
    if (owed & OWE_AGENTS) push_agents();
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

// The agents a person made leave when the story starts over, so the next person finds the same five.
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
            agent_t *a = &agents[STORY[s.next_entry].agent];   // the scripted five never move
            if (idle(a)) start_turn(a, STORY[s.next_entry].turn, 0);   // busy with a person's words: skipped this time
        }
        if (s.story_pos < CYCLE_MS) break;
        s.story_pos -= CYCLE_MS;
        s.next_entry = 0;
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
    s.greeted = s.seq_on = s.long_recap = s.steps = s.stats = s.player = false;
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
    // The same device on the same image is a keepalive: its welcome and nothing else.
    const bool keepalive = s.greeted && !strcmp(mac_c, s.mac) && !strcmp(fw_c, s.fw);
    // swarms:"members-v1" changes nothing here: the demo has no tabs to send members of.
    const char *recap = str_of(m, "recap"), *activity = str_of(m, "activity");
    const char *stats = str_of(m, "stats"), *player = str_of(m, "player");
    s.long_recap = recap && !strcmp(recap, "long-v1");
    s.steps = activity && !strcmp(activity, "steps-v1");
    s.stats = stats && !strcmp(stats, "turn-v1");
    s.player = player && !strcmp(player, "library-v1");
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
    send_focus(a);
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
    if (!refusal && v.bytes < MIN_PCM) refusal = "Didn't catch that";
    if (!refusal && v.kind == V_AGENT && v.named && find_agent(v.agent) < 0)
        refusal = "Could not reach that harness. Check its connection and try again.";
    if (refusal) {
        voice_error(refusal);
        memset(&v, 0, sizeof v);
        return;
    }
    if (v.kind == V_AGENT && !v.named) {
        // No agent named: the words go to the one the bar is on, else the first with nothing to do.
        int target = find_agent(s.focus);
        const int n = agent_count();
        for (int i = 0; target < 0 && i < n; i++) if (idle(&agents[i])) target = i;
        if (target < 0) target = 0;
        copy(v.agent, sizeof v.agent, agents[target].id);
    }
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

// New Harness's Start, a moment later: the agent arrives on the project's machine and the bar is turned to it.
static void create_agent(void)
{
    form.busy = false;
    form.revision = ++s.serial;
    const int n = agent_count();
    if (n >= MAX_AGENTS) {
        form.error = "The bar holds 8 agents. Wait for one to finish.";
        return;
    }
    agent_t *a = &agents[n];
    memset(a, 0, sizeof *a);
    a->used = a->made = true;
    a->said = -1;
    a->engine = form.engine;
    a->machine = PROJECTS[form.project].machine;
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
    const char *refusal = !current[0] || strcmp(current, token) ? "This question changed. Open it again."
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
    f_begin("answer.receipt");
    f_s("agentId", agent);
    f_s("token", token);
    f_s("requestId", request);
    f_b("ok", !refusal);
    // Another machine takes it in its own time: the daemon says it was handed on, not that it landed.
    if (!refusal && a->machine != LOCAL) f_b("pending", true);
    if (refusal) f_s("error", refusal);
    f_end();
}

// The older answer: the label chosen, by the key asked with, for the question named by requestId. No receipt.
static void on_answer(const cJSON *m)
{
    const char *request = str_of(m, "requestId");
    const int i = find_agent(str_of(m, "agentId"));
    person();
    if (i < 0 || !request || agents[i].ask != ASK_OPEN) return;
    agent_t *a = &agents[i];
    char id[40];
    question_id(a, id, sizeof id);
    if (strcmp(id, request)) return;
    const char *label = str_of(cJSON_GetObjectItemCaseSensitive(m, "answers"), a->q->q);
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
    for (uint8_t i = 0; i < N_MACHINES; i++) {
        if (strcmp(id, MACHINES[i].id)) continue;
        s.selected = i;
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
    for (int i = 0; i < SCRIPTED; i++) {
        agent_t *a = &agents[i];
        a->used = true;
        copy(a->id, sizeof a->id, CAST[i].id);
        copy(a->name, sizeof a->name, CAST[i].name);
        a->engine = CAST[i].engine;
        a->machine = CAST[i].machine;
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
    if (s.owed && s.greeted) push_owed();   // the story's own roster changes
    s.owed = 0;

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
