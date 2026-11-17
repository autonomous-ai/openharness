// Dev tool: renders one screen of a fixed demo model to a 1920 x 480 PPM, through the same calls max_app.c makes.
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

static void cable(int agents)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
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
static void five(void)
{
    cable(5);
    work("fw", "Infusing...", "Turning each 24-line strip into the portrait framebuffer", 134, FW_STEPS, 3);
    work("be", "Brewing", "Preparing the migration", 301, BE_STEPS, 2);
    max_ui_question("be", "q1", "Run the migration on the dev database now?", T0);
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
static void tap(int x, int y)
{
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, T0);
    max_ui_touch(true, x, y, T0);
    max_act_t act = max_ui_touch(false, x, y, T0 + 60);
    if (act.kind == MAX_ACT_TALK) max_ui_talk(MAX_TALK_RECORDING);
}

static void s_linkdown(void) { max_ui_reset(); }
static void s_noagents(void) { cable(0); }
static void s_working(void) { three_working(); }
static void s_asking(void)
{
    three_working();
    max_ui_question("be", "q1", "Run the migration on the dev database now? It drops the sessions table and rebuilds it "
                    "from the audit log, which takes about four minutes.", T0);
}
static void s_failed(void)
{
    three_working();
    max_ui_turn("be", "error", "pnpm test exited with 1: 3 tests failed in auth/session.spec.ts", 0, T0);
    max_ui_summary("web", "The pricing cards now match the design, and the footer links work again.", NULL, false,
                   POD_TIER_ALERT, T0);
}
static void s_five_p1(void) { five(); }
static void s_five_p2(void) { five(); swipe_left(); }
static void s_listening(void)
{
    three_working();
    tap(MAX_LANE_X + MAX_LANE_W + 200, 240);   // select backend
    tap(MAX_TALK_X + MAX_TALK_W / 2, 240);     // Talk: recording for it
}
static void s_sending(void) { s_listening(); max_ui_talk(MAX_TALK_SENDING); }
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
    max_ui_question("vq", "q", "Chạy lại toàn bộ bài kiểm thử trên máy build không?", T0);
    max_ui_focus("vi");
}
static void s_notice(void) { three_working(); max_ui_notice("Sent to backend", 3000, T0); }

typedef struct { const char *name; void (*setup)(void); } screen_t;
static const screen_t SCREENS[] = {
    {"linkdown", s_linkdown}, {"noagents", s_noagents}, {"working", s_working}, {"asking", s_asking},
    {"failed", s_failed}, {"five-p1", s_five_p1}, {"five-p2", s_five_p2}, {"listening", s_listening},
    {"sending", s_sending}, {"update", s_update}, {"long", s_long}, {"notice", s_notice},
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
