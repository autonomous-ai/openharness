// Dev tool: renders one screen of a fixed demo model to a PPM at the glass it is built for (1920 x HT_HEIGHT), through
// the same calls max_app.c makes. Each scene sets its page and its listening straight in max_m too, so it shows that
// page whatever the model's own moves between pages.
//   max_render <screen> <out.ppm>   one screen (max_render.py turns them into PNGs, golden.sh hashes them)
//   max_render --list               the screens, one a line
//   max_render --check-all          every screen within the run budget (run.sh)
// bench/ compiles the screens without the tool (MAX_RENDER_SCREENS_ONLY), to time the very scenes the goldens hash.
#include <stdio.h>
#include <string.h>

#include "max_ui_internal.h"
#include "pro_canvas.h"
#include "theme.h"

#define T0 20000000u
static ht_scene_t S;
#ifndef MAX_RENDER_SCREENS_ONLY
static uint16_t px[HT_WIDTH * HT_HEIGHT];
#endif

// Diego's mockup's agents: Orca's five, whose answers the bar does not take, and Harness's three, whose it does.
static const pro_agent_row_t ORCA[] = {{"auth", "auth-refactor", "claude", "m1", "MacBook Pro", "orca", "svf"},
                                       {"hero", "landing-hero", "codex", "m1", "MacBook Pro", "orca", "svf"},
                                       {"e2e", "flaky-e2e", "claude", "m1", "MacBook Pro", "orca", "svf"},
                                       {"rate", "rate-limiter", "codex", "m1", "MacBook Pro", "orca", "svf"},
                                       {"sweep", "docs-sweep", "muse", "m1", "MacBook Pro", "orca", "svf"}};
static const pro_agent_row_t HARNESS[] = {{"fw", "firmware-max", "claude", "m1", "MacBook Pro", "harness", NULL},
                                          {"cli", "harness-cli", "claude", "m1", "MacBook Pro", "harness", NULL},
                                          {"docs", "docs", "muse", "m1", "MacBook Pro", "harness", NULL}};
static const pro_app_row_t APPS[] = {{"harness", "Harness", 3, 1}, {"orca", "Orca", 5, 1}, {"herdr", "herdr", 2, 0},
                                     {"vscode", "VS Code", 1, 0},  {"ghostty", "Ghostty", 1, 0},
                                     {"terminal", "Terminal", 2, 1}, {"iterm", "iTerm2", 1, 0}};

static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;
static int take(void) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, T0); }

static void work(const char *id, const char *verb, const char *activity, int elapsed_s, const char *const steps[], int n)
{
    max_ui_turn(id, "started", "", 0, T0 - (uint32_t)elapsed_s * 1000u);
    for (int i = 0; i < n; i++) max_ui_turn(id, "step", steps[i], -1, T0);
    max_ui_turn(id, "verb", verb, -1, T0);
    max_ui_turn(id, "activity", activity, elapsed_s, T0);
}
// The question as pro_app_ask has it; on the reviewed path, read whole as the daemon answers question.read.
static void ask(const char *id, const char *request, const pro_ask_item_t *items, int n, bool permission, bool review)
{
    max_ui_question(id, request, items[0].q, items, n, permission, review, T0);
    if (!review) return;
    take();
    max_ui_question_state(id, max_ask_of(id)->fetch, true, request, "tok-1", false, NULL, items, n, T0);
}
static void ago(const char *id, uint32_t secs) { max_find(id)->since_ms = T0 - secs * 1000u; }

static const char *const AUTH_STEPS[] = {"Thinking", "Reading", "Editing"};
static const char *const RATE_STEPS[] = {"Planning", "Editing"};
static const char *const FW_STEPS[] = {"Reading", "Editing", "Building"};
static const pro_ask_item_t HERO = {"hero", "Both hero versions build. Keep the dark gradient, or switch to the product "
                                    "photo?", {"Gradient", "Photo"}, 2, false, true};
static const pro_ask_item_t BUMP = {"bump", "Bump the cable protocol to 4, or keep 3 and add a field?",
                                    {"Bump to 4", "Keep 3"}, 2, false, true};
static const pro_ask_item_t FLASH = {"perm", "Approve Bash command: make flash PORT=usb",
                                     {"Yes", "Yes, and don't ask again for: make flash*",
                                      "No, and tell Claude what to do differently"}, 3, false, true};

// The cable, the daemon's apps and Orca's ring, as the mockup's Overview has them.
static void orca(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_offers(true);
    max_ui_apps("orca", APPS, 7, T0);
    max_ui_agents(ORCA, 5, T0);
    work("auth", "Editing", "session.ts", 269, AUTH_STEPS, 3);
    max_ui_turn("hero", "started", "", 0, T0 - 61000);
    ask("hero", "q-hero", &HERO, 1, false, true);
    max_ui_turn("e2e", "started", "", 0, T0 - 400000);
    max_ui_summary("e2e", "Found it: the checkout test raced the cart request. It now waits for the response, and 50 "
                   "runs in a row pass.", NULL, false, POD_TIER_ALERT, T0 - 120000);
    work("rate", "Planning", "4 steps, starting with the middleware", 534, RATE_STEPS, 2);
    ago("e2e", 120);
    ago("sweep", 3600);
    ago("auth", 269);
}
// Harness's ring: its agents take answers on the bar.
static void harness(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_offers(true);
    max_ui_apps("harness", APPS, 7, T0);
    max_ui_agents(HARNESS, 3, T0);
    work("fw", "Flashing", "the bar over USB, 40%", 190, FW_STEPS, 3);
    max_ui_turn("cli", "started", "", 0, T0 - 60000);
    work("cli", "Editing", "cable/protocol.ts", 60, NULL, 0);
    max_ui_turn("docs", "started", "", 0, T0 - 600000);
    max_ui_summary("docs", "The setup guide now covers the menu-bar app and the one cable.", NULL, false,
                   POD_TIER_ALERT, T0 - 300000);
    ago("docs", 300);
}
// n unread notices, in place of what the model put in Inbox.
static void unread(int n)
{
    max_m.inbox_count = 0;
    for (int i = 0; i < n && i < MAX_INBOX; i++) {
        max_inbox_t *e = &max_m.inbox[max_m.inbox_count++];
        snprintf(e->id, sizeof e->id, "n%d", i);
        snprintf(e->name, sizeof e->name, "landing-hero");
        snprintf(e->engine, sizeof e->engine, "codex");
        snprintf(e->app, sizeof e->app, "Orca");
        snprintf(e->text, sizeof e->text, "%s", HERO.q);
        e->at = T0 - 60000;
        e->unread = true;
    }
}
static void show(max_view_t view, const char *id)
{
    max_m.view = view;
    if (view == MAX_VIEW_AGENT) max_copy(max_m.selected, sizeof max_m.selected, id);
}
static void attention(const char *id, max_attn_t kind)
{
    max_m.view = MAX_VIEW_ATTENTION;
    max_copy(max_m.attn_id, sizeof max_m.attn_id, id);
    max_m.attn = kind;
    max_m.attn_from = T0 - 700;
}
// A recording for `id`, `secs` in, the mic's last levels a speech-like run (or none), quiet for quiet_ms since.
static void talk(const char *id, uint32_t secs, bool heard, uint32_t quiet_ms)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, id);
    max_ui_talk(MAX_TALK_RECORDING, T0 - secs * 1000u);
    static const uint8_t SPEECH[] = {0, 1, 2, 3, 2, 4, 3, 2, 3, 4, 4, 3, 2, 3, 2, 1, 3, 4, 3, 2, 4, 3, 3, 2,
                                     1, 2, 3, 4, 2, 3, 4, 3, 2, 2, 3, 1, 2, 3, 2, 1, 1, 0, 1, 0, 0, 0, 0, 0};
    for (int i = 0; heard && i < MAX_LEVELS; i++) max_ui_level(SPEECH[i], T0 - (MAX_LEVELS - i) * 100u);
    for (int i = 0; !heard && i < (int)secs * 10 && i < MAX_LEVELS; i++) max_ui_level(0, T0 - (MAX_LEVELS - i) * 100u);
    if (heard) max_m.talk_quiet_from = T0 - quiet_ms;
}

// ---- Overview ----
static void s_overview(void) { orca(); unread(2); show(MAX_VIEW_OVERVIEW, NULL); }
static void s_overview_harness(void)
{
    harness();
    unread(1);
    show(MAX_VIEW_OVERVIEW, NULL);
    max_ui_notice("Following Harness on your Mac", 3000, T0 - 300);   // up whole: it fades in over 300 ms
}
static void s_overview_one(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_agents(HARNESS, 1, T0);
    work("fw", "Flashing", "the bar over USB, 40%", 190, FW_STEPS, 3);
    show(MAX_VIEW_OVERVIEW, NULL);
}
// More agents than the glass holds: the row scrolled a cell on, past the question waiting at its front.
static void s_overview_pages(void)
{
    orca();
    static const pro_agent_row_t more[] = {{"bill", "billing-export", "muse", "m1", "MacBook Pro", "orca", "svf"},
                                           {"notes", "release-notes", "claude", "m1", "MacBook Pro", "orca", "svf"},
                                           {"css", "css-cleanup", "claude", "m1", "MacBook Pro", "orca", "svf"}};
    pro_agent_row_t rows[8];
    memcpy(rows, ORCA, sizeof ORCA);
    memcpy(rows + 5, more, sizeof more);
    max_ui_agents(rows, 8, T0);
    work("bill", "Reading", "the invoices schema", 97, NULL, 0);
    unread(2);
    show(MAX_VIEW_OVERVIEW, NULL);
    max_m.row_first = 1;
}
static void s_overview_long(void)
{
    static const pro_agent_row_t rows[] = {
        {"en", "an-agent-name-that-is-far-too-long-for-one-cell", "claude", "m1", "MacBook Pro", NULL, NULL},
        {"vi", "Trợ lý viết tài liệu tiếng Việt cho nhóm", "codex", "m1", "MacBook Pro", NULL, NULL},
        {"vq", "Kiểm thử", "muse", "m1", "MacBook Pro", NULL, NULL}};
    max_ui_reset();
    max_ui_link(true, "MacBook Pro của nhóm ở văn phòng", T0);
    max_ui_agents(rows, 3, T0);
    work("en", "Reticulating splines", "Editing", 59, NULL, 0);
    work("vi", "Đang viết", "Đang viết lại hướng dẫn cài đặt", 7384, NULL, 0);
    show(MAX_VIEW_OVERVIEW, NULL);
}

// ---- the agent page ----
static void s_agent_reading(void) { orca(); show(MAX_VIEW_AGENT, "e2e"); }
static void s_agent_working(void) { orca(); show(MAX_VIEW_AGENT, "auth"); }
static void s_agent_mic_closed(void)
{
    orca();
    show(MAX_VIEW_AGENT, "sweep");
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "sweep");
    max_m.talk_closed = true;   // 5 s with nothing heard
}
static void s_agent_listening(void) { orca(); show(MAX_VIEW_AGENT, "e2e"); talk("e2e", 2, true, 700); }
static void s_agent_listening_start(void) { orca(); show(MAX_VIEW_AGENT, "sweep"); talk("sweep", 1, false, 0); }
static void s_agent_working_talking(void) { orca(); show(MAX_VIEW_AGENT, "auth"); talk("auth", 2, true, 200); }
static void s_agent_sending(void)
{
    orca();
    show(MAX_VIEW_AGENT, "e2e");
    talk("e2e", 3, true, 1600);
    max_ui_talk(MAX_TALK_SENDING, T0);
}
// An agent the bar cannot record for: where to talk to it instead.
static void s_agent_no_voice(void)
{
    static const pro_agent_row_t rows[] = {{"term", "deploy-bot", "codex", "m1", "MacBook Pro", "terminal", "s"}};
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_apps("terminal", APPS, 7, T0);
    max_ui_agents(rows, 1, T0);
    max_ui_turn("term", "started", "", 0, T0 - 30000);
    max_ui_summary("term", "Staging is on 0.9.0. The smoke tests pass.", NULL, false, POD_TIER_LIST, T0 - 30000);
    ago("term", 30);
    show(MAX_VIEW_AGENT, "term");
}
// A question while the person talks to another agent: the toast.
static void s_toast(void)
{
    orca();
    show(MAX_VIEW_AGENT, "auth");
    talk("auth", 4, true, 300);
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "hero");
    max_m.toast_from = T0 - 1000;
}

// A finished turn while the person is on App Detail: its note at the bottom right, the glass left as it was.
static void s_done_note(void)
{
    orca();
    max_ui_turn("sweep", "started", "", 0, T0 - 90000);
    max_ui_summary("sweep", "Swept 41 pages: 6 dead links fixed, 2 pages merged, the sidebar regenerated.", NULL, false,
                   POD_TIER_ALERT, T0 - 1000);
    show(MAX_VIEW_OVERVIEW, NULL);
}

// ---- Attention ----
static void s_attention_question(void)
{
    harness();
    max_ui_turn("cli", "started", "", 0, T0 - 60000);
    ask("cli", "q-bump", &BUMP, 1, false, true);
    attention("cli", MAX_ATTN_ASK);
    max_ui_notice("Sent to auth-refactor", 3000, T0 - 300);
}
static void s_attention_permission(void)
{
    harness();
    ask("fw", "q-flash", &FLASH, 1, true, true);
    attention("fw", MAX_ATTN_ASK);
    max_ui_notice("Sent: Keep 3", 3000, T0 - 300);
}
static void s_attention_outside(void)
{
    orca();
    attention("hero", MAX_ATTN_ASK);
    max_ui_notice("Allowed: make flash PORT=usb", 3000, T0 - 300);
}
static void s_attention_done(void)
{
    orca();
    max_ui_summary("auth", "Token refresh retries once, then signs out cleanly. Auth suite: 14 of 14.", NULL, false,
                   POD_TIER_ALERT, T0);
    max_m.done_id[0] = 0;   // its note is done-note's
    attention("auth", MAX_ATTN_DONE);
}
static void s_attention_failed(void)
{
    harness();
    max_ui_turn("fw", "error", "idf.py flash exited with 2: no serial port at /dev/cu.usbmodem1101", 0, T0);
    attention("fw", MAX_ATTN_FAIL);
}
static void s_attention_six(void)
{
    static const pro_ask_item_t board = {"board", "Which board should I flash the new panel driver to?",
                                         {"ESP32-P4 Function EV", "Harness Max rev A", "Harness Max rev B", "Harness Pro",
                                          "Dial", "None of these"}, 6, false, true};
    harness();
    ask("cli", "q-board", &board, 1, false, true);
    attention("cli", MAX_ATTN_ASK);
}
static void s_attention_multi(void)
{
    static const pro_ask_item_t push[] = {
        {"branch", "Where should the fix go?", {"main", "release/0.9"}, 2, false, true},
        {"checks", "Which checks should run before the push?", {"Lint", "Type check", "Unit tests", "E2E on staging"}, 4,
         true, true}};
    harness();
    ask("cli", "q-push", push, 2, false, true);
    max_ask_hit(max_find("cli"), MAX_HIT_OPTION, 1, T0);   // release/0.9: on to the checks
    max_ask_hit(max_find("cli"), MAX_HIT_OPTION, 0, T0);
    max_ask_hit(max_find("cli"), MAX_HIT_OPTION, 2, T0);
    attention("cli", MAX_ATTN_ASK);
}
static void s_attention_error(void)
{
    harness();
    ask("cli", "q-bump", &BUMP, 1, false, true);
    max_ask_hit(max_find("cli"), MAX_HIT_OPTION, 1, T0 - 300);
    take();
    // 300 ms before: its notice up whole, past its fade in.
    max_ui_answer_receipt("cli", max_ask_of("cli")->fetch, "tok-1", false, false, "Question changed.", T0 - 300);
    attention("cli", MAX_ATTN_ASK);
}
static void s_attention_long_vi(void)
{
    static const pro_ask_item_t vi = {"vi", "Bài kiểm thử xác thực lỗi vì bảng phiên đã bị xoá. Tôi nên khôi phục từ "
                                      "nhật ký kiểm toán, dựng lại từ đầu, hay dừng ở đây để bạn tự xem?",
                                      {"Khôi phục từ nhật ký kiểm toán rồi chạy lại", "Dựng lại bảng từ đầu",
                                       "Dừng ở đây", "Hỏi lại tôi sau khi build xong"}, 4, false, true};
    static const pro_agent_row_t rows[] = {{"vq", "Trợ lý kiểm thử tiếng Việt của nhóm", "claude", "m1", "MacBook Pro",
                                            "harness", NULL}};
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_apps("harness", APPS, 7, T0);
    max_ui_agents(rows, 1, T0);
    ask("vq", "q-vi", &vi, 1, false, true);
    attention("vq", MAX_ATTN_ASK);
}

// ---- Inbox, Apps, Ambient ----
static void s_inbox(void)
{
    static const struct { const char *name, *engine, *app; max_attn_t kind; const char *text; uint32_t ago_s; bool unread; }
        NOTES[] = {
            {"firmware-max", "claude", "Harness", MAX_ATTN_ASK, "Wants to run: make flash PORT=usb", 20, false},
            {"harness-cli", "claude", "Harness", MAX_ATTN_ASK, "Bump the cable protocol to 4, or keep 3 and add a field?",
             30, false},
            {"auth-refactor", "claude", "Orca", MAX_ATTN_DONE,
             "Token refresh retries once, then signs out cleanly. Auth suite: 14 of 14.", 40, false},
            {"landing-hero", "codex", "Orca", MAX_ATTN_ASK, "Both hero versions build. Keep the dark gradient, or switch "
             "to the product photo?", 60, true},
            {"api-docs", "codex", "VS Code", MAX_ATTN_FAIL, "The docs build failed: 3 broken links.", 540, false}};
    orca();
    max_m.inbox_count = 0;
    for (size_t i = 0; i < sizeof NOTES / sizeof NOTES[0]; i++) {
        max_inbox_t *e = &max_m.inbox[max_m.inbox_count++];
        snprintf(e->id, sizeof e->id, "n%d", (int)i);
        snprintf(e->name, sizeof e->name, "%s", NOTES[i].name);
        snprintf(e->engine, sizeof e->engine, "%s", NOTES[i].engine);
        snprintf(e->app, sizeof e->app, "%s", NOTES[i].app);
        snprintf(e->text, sizeof e->text, "%s", NOTES[i].text);
        e->kind = NOTES[i].kind;
        e->at = T0 - NOTES[i].ago_s * 1000u;
        e->unread = NOTES[i].unread;
    }
    show(MAX_VIEW_INBOX, NULL);
    max_ui_notice("Following Harness on your Mac", 3000, T0 - 300);
}
static void s_inbox_empty(void)
{
    orca();
    max_m.inbox_count = 0;
    show(MAX_VIEW_INBOX, NULL);
}
static void s_apps(void) { orca(); show(MAX_VIEW_APPS, NULL); }
static void s_ambient(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    static const pro_agent_row_t rows[] = {{"fw", "firmware-max", "claude", "m1", "MacBook Pro", "harness", NULL},
                                           {"docs", "docs", "muse", "m1", "MacBook Pro", "harness", NULL},
                                           {"hero", "landing-hero", "codex", "m1", "MacBook Pro", "orca", NULL}};
    max_ui_agents(rows, 3, T0);
    max_ui_wall(true, 15, 7, 3, 18, 10);
    show(MAX_VIEW_AMBIENT, NULL);
}
static void s_ambient_no_agents(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_wall(true, 9, 41, 1, 3, 0);
    show(MAX_VIEW_AMBIENT, NULL);
}
static void s_not_connected(void) { max_ui_reset(); show(MAX_VIEW_AMBIENT, NULL); }
static void s_update(void) { orca(); max_ui_update(40, "0.9.0"); }

// ---- New Harness, as the demo daemon's form answers ----
static void form_open(void)
{
    orca();
    max_ui_form_open("form-0badc0de-000186a0", T0);
    take();
}
static void form_page(const pro_form_page_t *page)
{
    char request[MAX_FETCH_BYTES];
    snprintf(request, sizeof request, "form-%lu", (unsigned long)max_m.form.request);
    max_ui_form_state(request, max_m.form.id, true, page, T0);
}
static const pro_form_page_t START = {
    .title = "New Harness", .label = "New Harness", .detail = "Claude Code\nharness-max-firmware", .previous = "Project",
    .next = "", .error = "", .status = "", .action = "start", .query = "", .revision = 4, .position = 3, .total = 3,
    .active = true, .enabled = true};
static const pro_form_page_t PROJECT = {
    .title = "Project", .label = "harness-max-firmware", .detail = "~/work/harness/devices/harness-max/firmware",
    .previous = "backend", .next = "website", .error = "", .status = "", .action = "choose", .query = "",
    .revision = 7, .position = 2, .total = 5, .active = true, .enabled = true, .can_query = true};
static void s_form_opening(void) { form_open(); }
static void s_form_page(void) { form_open(); form_page(&PROJECT); }
static void s_form_start(void) { form_open(); form_page(&START); }
static void s_form_busy(void)
{
    form_open();
    form_page(&START);
    max_form_command(MAX_FORM_ACTIVATE, 0, T0);
    take();
    pro_form_page_t busy = START;
    busy.busy = true;
    busy.enabled = false;
    busy.status = "Starting\xe2\x80\xa6";
    form_page(&busy);
}
static void s_form_failed(void) { form_open(); max_form_due(T0 + MAX_FORM_WAIT_MS); }
static void s_form_say(void)   // a name for the field
{
    s_form_page();
    max_m.talk_id[0] = 0;
    max_ui_talk(MAX_TALK_RECORDING, T0);
}
static void s_form_toast(void)
{
    s_form_page();
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "hero");
    max_m.toast_from = T0 - 2000;
    max_ui_notice("Sent to auth-refactor", 3000, T0 - 300);
}

// App Detail's row in motion, at a frame the render task draws: an agent opening half way through the row's move
// (210 ms of 420), its neighbours narrowing and dimming, the row carried along; one closing three quarters through its
// panel's fade out (225 ms of 300), its face coming back across it; the row under a finger mid-drag, the cells cut at
// its ends. The frames before are drawn here, the one shown by draw().
static void frame(uint32_t now)
{
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, now);
}
static void s_row_opening(void)
{
    orca();
    show(MAX_VIEW_OVERVIEW, NULL);
    frame(T0 - 1000);
    max_open("rate");
    frame(T0 - 210);
}
static void s_row_closing(void)
{
    orca();
    show(MAX_VIEW_AGENT, "rate");
    frame(T0 - 2000);
    max_show(MAX_VIEW_OVERVIEW);
    frame(T0 - 225);
}
// The page up 750 ms: the asking agent's rail, chip and glow at their faintest, the working agents' lights half way
// along their rails, their chips' dots part way faded.
static void s_overview_loops(void)
{
    orca();
    show(MAX_VIEW_OVERVIEW, NULL);
    frame(T0 - 750);
}
static void s_row_drag(void)
{
    orca();
    show(MAX_VIEW_OVERVIEW, NULL);
    frame(T0 - 100);
    max_ui_touch(true, 1200, 240, T0 - 80);
    max_ui_touch(true, 1100, 240, T0 - 60);   // past the slop: the row takes the finger from here
    max_ui_touch(true, 900, 240, T0 - 40);
}

typedef struct { const char *name; void (*setup)(void); } screen_t;
static const screen_t SCREENS[] = {
    {"overview", s_overview}, {"overview-harness", s_overview_harness}, {"overview-one", s_overview_one},
    {"overview-pages", s_overview_pages}, {"overview-long", s_overview_long},
    {"agent-reading", s_agent_reading}, {"agent-working", s_agent_working}, {"agent-mic-closed", s_agent_mic_closed},
    {"agent-listening", s_agent_listening}, {"agent-listening-start", s_agent_listening_start},
    {"agent-working-talking", s_agent_working_talking}, {"agent-sending", s_agent_sending},
    {"agent-no-voice", s_agent_no_voice}, {"toast", s_toast}, {"done-note", s_done_note},
    {"attention-question", s_attention_question}, {"attention-permission", s_attention_permission},
    {"attention-outside", s_attention_outside}, {"attention-done", s_attention_done},
    {"attention-failed", s_attention_failed}, {"attention-six", s_attention_six},
    {"attention-multi", s_attention_multi}, {"attention-error", s_attention_error},
    {"attention-long-vi", s_attention_long_vi},
    {"inbox", s_inbox}, {"inbox-empty", s_inbox_empty}, {"apps", s_apps}, {"ambient", s_ambient},
    {"ambient-no-agents", s_ambient_no_agents}, {"not-connected", s_not_connected}, {"update", s_update},
    {"form-opening", s_form_opening}, {"form-page", s_form_page}, {"form-start", s_form_start},
    {"form-busy", s_form_busy}, {"form-failed", s_form_failed}, {"form-say", s_form_say}, {"form-toast", s_form_toast},
    {"row-opening", s_row_opening}, {"row-closing", s_row_closing}, {"row-drag", s_row_drag},
    {"overview-loops", s_overview_loops},
};
enum { SCREEN_COUNT = sizeof SCREENS / sizeof SCREENS[0] };

static void draw(const screen_t *sc)
{
    sc->setup();
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, T0);
}

#ifndef MAX_RENDER_SCREENS_ONLY
static const screen_t *find(const char *name)
{
    for (int i = 0; i < SCREEN_COUNT; i++)
        if (!strcmp(SCREENS[i].name, name)) return &SCREENS[i];
    return NULL;
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--list")) {
        for (int i = 0; i < SCREEN_COUNT; i++) puts(SCREENS[i].name);
        return 0;
    }
    if (argc == 2 && !strcmp(argv[1], "--check-all")) {
        int worst = 0;
        for (int i = 0; i < SCREEN_COUNT; i++) {
            draw(&SCREENS[i]);
            if (S.count >= HT_RUNS) {
                fprintf(stderr, "max_render: %s fills all %d runs\n", SCREENS[i].name, HT_RUNS);
                return 1;
            }
            if (S.count > worst) worst = S.count;
        }
        printf("max_render: %d screens, at most %d runs of %d\n", SCREEN_COUNT, worst, HT_RUNS);
        return 0;
    }
    const screen_t *sc = argc == 3 ? find(argv[1]) : NULL;
    if (!sc) {
        fprintf(stderr, "usage: max_render <screen> <out.ppm> | --list | --check-all\n");
        return 2;
    }
    draw(sc);
    ht_raster(&S, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, px);
    FILE *f = fopen(argv[2], "wb");
    if (!f) {
        perror(argv[2]);
        return 1;
    }
    fprintf(f, "P6\n%d %d\n255\n", HT_WIDTH, HT_HEIGHT);
    for (int i = 0; i < HT_WIDTH * HT_HEIGHT; i++) {
        const unsigned v = px[i];
        const unsigned char rgb[3] = {(unsigned char)((v >> 11) * 255 / 31), (unsigned char)(((v >> 5) & 63) * 255 / 63),
                                      (unsigned char)((v & 31) * 255 / 31)};
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    printf("%s: %d runs\n", sc->name, S.count);
    return 0;
}
#endif
