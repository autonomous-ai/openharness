// Dev tool: renders one screen of a fixed demo model to a PPM at the glass it is built for (1920 x HT_HEIGHT), through
// the same calls max_app.c makes.
//   max_render <screen> <out.ppm>   one screen (max_render.py turns them into PNGs, golden.sh hashes them)
//   max_render --list               the screens, one a line
//   max_render --check-all          every screen within the run budget (run.sh)
#include <stdio.h>
#include <string.h>

#include "max_ui_internal.h"
#include "pro_canvas.h"
#include "theme.h"

#define T0 100000u
static ht_scene_t S;
static uint16_t px[HT_WIDTH * HT_HEIGHT];

static const cable_machine_t MACHINES[] = {{.id = "m1", .name = "MacBook Pro", .state = "ready", .local = true},
                                           {.id = "m2", .name = "Mac Studio", .state = "ready"},
                                           {.id = "m3", .name = "Build server", .state = "offline"}};
static const pro_agent_row_t AGENTS[] = {{"fw", "firmware-max", "claude", "m1", "MacBook Pro"},
                                         {"be", "backend", "codex", "m2", "Mac Studio"},
                                         {"web", "website", "claude", "m1", "MacBook Pro"},
                                         {"docs", "docs", "codex", "m1", "MacBook Pro"},
                                         {"cli", "harness-cli", "claude", "m2", "Mac Studio"}};

// The daemon offers New Harness, as cableHost does.
static void cable(int agents)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_offers(true);
    max_ui_machines(MACHINES, 3, "m1");
    max_ui_agents(AGENTS, agents, T0);
}
static void work(const char *id, const char *verb, const char *activity, int elapsed_s, const char *const steps[], int n)
{
    max_ui_turn(id, "started", "", 0, T0 - (uint32_t)elapsed_s * 1000u);
    for (int i = n - 1; i >= 0; i--) max_ui_turn(id, "step", steps[i], -1, T0);
    max_ui_turn(id, "verb", verb, -1, T0);
    max_ui_turn(id, "activity", activity, elapsed_s, T0);
}
static const char *const FW_STEPS[] = {"Edit \xc2\xb7 main/display/max_panel.c", "Read \xc2\xb7 esp_lcd_ota7290b.h",
                                       "Bash \xc2\xb7 idf.py build"};
static const char *const BE_STEPS[] = {"Bash \xc2\xb7 pnpm test auth", "Edit \xc2\xb7 src/auth/session.ts"};
static const char *const WEB_STEPS[] = {"Read \xc2\xb7 pricing.tsx"};
static void three_working(void)
{
    cable(3);
    work("fw", "Infusing...", "Turning each 24-line strip into the portrait framebuffer", 134, FW_STEPS, 3);
    work("be", "Brewing\xe2\x80\xa6", "Running the auth tests \xe2\x80\x94 212 of 640", 3723, BE_STEPS, 2);
    work("web", "Drawing", "Drawing the pricing cards", 12, WEB_STEPS, 1);
}
// ---- questions ----
static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;
static int take(void) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, T0); }
static void hit(const char *id, max_hit_kind_t kind, int arg) { max_ask_hit(max_find(id), kind, arg, T0); }

// The question as pro_app_ask has it; on the reviewed path, read whole as the daemon answers question.read.
static void ask(const char *id, const char *request, const pro_ask_item_t *items, int n, bool permission, bool review)
{
    max_ui_question(id, request, items[0].q, items, n, permission, review, T0);
    if (!review) return;
    take();
    max_ui_question_state(id, max_ask_of(id)->fetch, true, request, "tok-1", false, NULL, items, n, T0);
}
static const pro_ask_item_t MIGRATE = {"run", "Run the migration on the dev database now?", {"Run it", "Not now"}, 2,
                                       false, true};
static const pro_ask_item_t DATABASE = {"db", "Which database should the migration run on?", {"Dev", "Staging"}, 2,
                                        false, true};
static const pro_ask_item_t BOARD = {"board", "Which board should I flash the new panel driver to?",
                                     {"ESP32-P4 Function EV", "Harness Max rev A", "Harness Max rev B", "Harness Pro",
                                      "Dial", "None of these"}, 6, false, true};
static const pro_ask_item_t PUSH[] = {
    {"branch", "Where should the fix go?", {"main", "release/0.9"}, 2, false, true},
    {"checks", "Which checks should run before the push?", {"Lint", "Type check", "Unit tests", "E2E on staging"}, 4,
     true, true},
};
static const pro_ask_item_t DEPLOY = {"perm", "Approve Bash command: npm run deploy:staging",
                                      {"Yes", "Yes, and don't ask again for npm run commands",
                                       "No, and tell Claude what to do differently"}, 3, false, true};
static const pro_ask_item_t SHOWN = {"shown", "Allow Edit of src/auth/session.ts?", {"In Orca"}, 1, false, true};
static const pro_ask_item_t LONG_EN = {"plan", "The auth tests fail on the session table that the migration dropped. "
                                       "Should I restore it from the audit log, rebuild it from scratch, or stop here "
                                       "so you can look at the failing tests yourself first?",
                                       {"Restore it from the audit log and run the tests again",
                                        "Rebuild the table from scratch with an empty set of sessions",
                                        "Stop here and leave everything as it is"}, 3, false, true};
static const pro_ask_item_t LONG_VI = {"vi", "Bài kiểm thử xác thực lỗi vì bảng phiên đã bị xoá. Tôi nên khôi phục từ "
                                       "nhật ký kiểm toán, dựng lại từ đầu, hay dừng ở đây để bạn tự xem?",
                                       {"Khôi phục từ nhật ký kiểm toán rồi chạy lại", "Dựng lại bảng từ đầu",
                                        "Dừng ở đây", "Hỏi lại tôi sau khi build xong"}, 4, false, true};

static void five(void)
{
    cable(5);
    work("fw", "Infusing...", "Turning each 24-line strip into the portrait framebuffer", 134, FW_STEPS, 3);
    work("be", "Brewing", "Preparing the migration", 301, BE_STEPS, 2);
    ask("be", "q1", &MIGRATE, 1, false, false);
    work("cli", "Musing", "Reading the hello handshake", 48, NULL, 0);
    max_ui_turn("web", "started", "", 0, T0 - 252000);
    max_ui_summary("web", "The pricing cards now match the design, and the footer links work again.", NULL, false,
                   POD_TIER_ALERT, T0 - 5000);
}
static void swipe_left(void)
{
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, T0);
    max_ui_touch(true, 1400, 240, T0);
    max_ui_touch(true, 1250, 244, T0 + 40);
    max_ui_touch(false, 1150, 246, T0 + 80);
}
// A person talks to `id` (NULL: says a name for the form's field), as the app sets it when the pet is tapped.
static void talk(const char *id, max_talk_t state)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, id);
    max_ui_talk(state);
}
// A question that arrived while a person was at the bar: the toast, `age_ms` into its time.
static void toast(const char *id, uint32_t age_ms)
{
    max_copy(max_m.toast_id, sizeof max_m.toast_id, id);
    max_m.toast_from = T0 - age_ms;
}

static void s_linkdown(void) { max_ui_reset(); }
static void s_noagents(void) { cable(0); }
static void s_working(void) { three_working(); max_ui_focus("fw"); }
// A question the daemon's inbox cannot hold: only the computer answers it.
static void s_asking(void)
{
    three_working();
    max_ui_question("be", "q1", "Run the migration on the dev database now? It drops the sessions table and rebuilds it "
                    "from the audit log, which takes about four minutes.", NULL, 0, false, true, T0);
    max_ui_focus("be");
}
static void s_failed(void)
{
    three_working();
    max_ui_turn("be", "error", "pnpm test exited with 1: 3 tests failed in auth/session.spec.ts", 0, T0);
    max_ui_summary("web", "The pricing cards now match the design, and the footer links work again.", NULL, false,
                   POD_TIER_ALERT, T0);
    max_ui_focus("be");
}
static void s_five_p1(void) { five(); max_ui_focus("be"); }
static void s_five_p2(void) { five(); max_ui_focus("be"); swipe_left(); }
// The room on an agent at work, the others beside it: one asks, one waits for a permission, one failed, one is done.
static void watching(void)
{
    five();
    ask("docs", "q2", &DEPLOY, 1, true, true);
    max_ui_turn("cli", "error", "flutter test failed: 2 golden snapshots out of date", 0, T0);
    max_ui_focus("fw");
}
static void s_watching(void) { watching(); }
static void s_toast(void) { watching(); toast("be", 1200); }
static void s_toast_notice(void) { watching(); toast("be", 3900); max_ui_notice("Sent", 3000, T0); }
static void s_listening(void) { three_working(); max_ui_focus("be"); talk("be", MAX_TALK_RECORDING); }
static void s_sending(void) { three_working(); max_ui_focus("be"); talk("be", MAX_TALK_SENDING); }
// Talking while a question waits: everything but the room rests, the toast too.
static void s_talk_toast(void) { watching(); toast("be", 600); talk("fw", MAX_TALK_RECORDING); }
static void s_update(void) { three_working(); max_ui_update(40, "0.9.0"); }
static void s_long(void)
{
    static const pro_agent_row_t rows[] = {
        {"en", "an-agent-name-that-is-far-too-long-for-one-lane", "claude", "m1", "A MacBook Pro with a long name"},
        {"vi", "Trợ lý viết tài liệu tiếng Việt cho nhóm", "codex", "m2", "Máy chủ ở văn phòng"},
        {"vq", "Kiểm thử", "claude", "m1", "MacBook Pro"}};
    max_ui_reset();
    max_ui_link(true, "MacBook Pro của nhóm ở văn phòng", T0);
    max_ui_agents(rows, 3, T0);
    work("en", "Infusing", "Editing the touch driver so that the panel and the finger agree on which way is up, then "
         "running every host test again", 59, FW_STEPS, 3);
    work("vi", "Đang viết", "Đang viết lại hướng dẫn cài đặt cho thanh Harness Max, từ cách cắm cáp đến cách chọn "
         "một làn và nói với nó", 7384, NULL, 0);
    max_ui_turn("vq", "started", "", 0, T0);
    max_ui_turn("vq", "step", "Bash \xc2\xb7 chạy lại toàn bộ bài kiểm thử trên máy build", -1, T0);
    max_ui_focus("vi");
}
static void s_notice(void) { three_working(); max_ui_focus("fw"); max_ui_notice("Sent to backend", 3000, T0); }
// More agents than a page of lanes holds: the dots under them.
static void s_pages(void)
{
    static const pro_agent_row_t more[] = {{"a1", "landing-page", "claude", "m1", "MacBook Pro"},
                                           {"a2", "billing", "codex", "m2", "Mac Studio"},
                                           {"a3", "search", "gemini", "m2", "Mac Studio"},
                                           {"a4", "mobile", "muse", "m1", "MacBook Pro"}};
    pro_agent_row_t rows[9];
    memcpy(rows, AGENTS, sizeof AGENTS);
    memcpy(rows + 5, more, sizeof more);
    cable(0);
    max_ui_agents(rows, 9, T0);
    work("fw", "Infusing...", "Turning each 24-line strip into the portrait framebuffer", 134, FW_STEPS, 3);
    work("a2", "Billing", "Moving the invoices to the new tax table", 45, NULL, 0);
    work("a3", "Searching", "Reindexing the docs", 12, NULL, 0);
    ask("a4", "q3", &MIGRATE, 1, false, true);
    max_ui_focus("fw");
}

// ---- answering and New Harness ----
static void s_q_two(void) { three_working(); ask("be", "q1", &DATABASE, 1, false, true); max_ui_focus("be"); }
static void s_q_six(void) { three_working(); ask("fw", "q1", &BOARD, 1, false, true); max_ui_focus("fw"); }
static void s_q_multi(void)
{
    three_working();
    ask("web", "q1", PUSH, 2, false, true);
    hit("web", MAX_HIT_OPTION, 1);   // release/0.9: on to the checks
    hit("web", MAX_HIT_OPTION, 0);
    hit("web", MAX_HIT_OPTION, 2);
    max_ui_focus("web");
}
static void s_q_permission(void) { three_working(); ask("be", "q1", &DEPLOY, 1, true, true); max_ui_focus("be"); }
static void s_q_shown(void) { three_working(); ask("be", "shown:toolu_7", &SHOWN, 1, true, true); max_ui_focus("be"); }
static void s_q_error(void)
{
    three_working();
    ask("be", "q1", &DEPLOY, 1, true, true);
    hit("be", MAX_HIT_OPTION, 0);
    take();
    max_ui_answer_receipt("be", max_ask_of("be")->fetch, "tok-1", false, false,
                          "Permission prompts cannot be answered from here.", T0);
    max_ui_focus("be");
}
static void s_q_sent(void)
{
    three_working();
    ask("be", "q1", &DATABASE, 1, false, true);
    hit("be", MAX_HIT_OPTION, 0);
    take();
    max_ui_answer_receipt("be", max_ask_of("be")->fetch, "tok-1", true, true, NULL, T0);
    max_ui_focus("be");
}
static void s_q_long(void) { three_working(); ask("fw", "q1", &LONG_EN, 1, false, true); max_ui_focus("fw"); }
static void s_q_long_vi(void)
{
    s_long();
    ask("vq", "q", &LONG_VI, 1, false, true);
    max_ui_focus("vq");
}
static void s_done(void)
{
    three_working();
    max_ui_summary("web", "The pricing cards now match the design, and the footer links work again. I also moved the "
                   "price table into its own component so the annual toggle can share it.", NULL, false,
                   POD_TIER_ALERT, T0);
    max_ui_focus("web");
}

// ---- New Harness, as the demo daemon's form answers ----
static void form_open(void)
{
    three_working();
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
static void s_form_say(void) { s_form_page(); talk(NULL, MAX_TALK_RECORDING); }   // a name for the field
static void s_form_toast(void) { s_form_page(); max_ui_question("be", "q1", MIGRATE.q, &MIGRATE, 1, false, false, T0); toast("be", 2000); }

typedef struct { const char *name; void (*setup)(void); } screen_t;
static const screen_t SCREENS[] = {
    {"linkdown", s_linkdown}, {"noagents", s_noagents}, {"working", s_working}, {"asking", s_asking},
    {"failed", s_failed}, {"five-p1", s_five_p1}, {"five-p2", s_five_p2}, {"watching", s_watching},
    {"toast", s_toast}, {"toast-notice", s_toast_notice}, {"listening", s_listening}, {"sending", s_sending},
    {"talk-toast", s_talk_toast}, {"update", s_update}, {"long", s_long}, {"notice", s_notice}, {"pages", s_pages},
    {"q-two", s_q_two}, {"q-six", s_q_six}, {"q-multi", s_q_multi}, {"q-permission", s_q_permission},
    {"q-shown", s_q_shown}, {"q-error", s_q_error}, {"q-sent", s_q_sent}, {"q-long", s_q_long},
    {"q-long-vi", s_q_long_vi}, {"done", s_done}, {"form-opening", s_form_opening}, {"form-page", s_form_page},
    {"form-start", s_form_start}, {"form-busy", s_form_busy}, {"form-failed", s_form_failed}, {"form-say", s_form_say},
    {"form-toast", s_form_toast},
};
enum { SCREEN_COUNT = sizeof SCREENS / sizeof SCREENS[0] };

static const screen_t *find(const char *name)
{
    for (int i = 0; i < SCREEN_COUNT; i++)
        if (!strcmp(SCREENS[i].name, name)) return &SCREENS[i];
    return NULL;
}
static void draw(const screen_t *sc)
{
    sc->setup();
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, T0);
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
