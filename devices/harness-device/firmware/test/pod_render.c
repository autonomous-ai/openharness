// Dev tool (not run by run-pod.sh): renders one Pod screen of a fixed demo model to a 720 x 720 PPM.
// Usage: pod_render <screen> <out.ppm> [now_ms]      pod_render.py builds it and converts the PPMs to PNG.
//   screens: tabs[:<rows scrolled>[+<more tabs>][@<px offset: mid-drag>] | :mock] (the album grid; mock = the mockup's six covers, one empty), default[:tab|:talk] (default marks), recent, chrome[:talk] (the status bar and transport alone), tab:<n>, agent:<id>, recap:<id>, talk:<id>   (ids: fw ota be cli web desk docs vault
//   site cur notes2 kilo). The demo is the HTML mockup's (mockup/pro-ipod.html): the same agents, tabs and times.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "pod/pod_view.h"

#define T0 100000u

typedef struct { const char *id, *name, *engine, *machine; } demo_agent_t;
static const demo_agent_t AGENTS[] = {
    {"fw", "firmware-pro", "claude", "MacBook Pro"}, {"ota", "dial-ota", "claude", "MacBook Pro"},
    {"be", "backend", "codex", "Mac Studio"},        {"cli", "harness-cli", "codex", "MacBook Pro"},
    {"web", "website", "muse", "Mac Studio"},        {"desk", "desktop", "claude", "Mac Studio"},
    {"docs", "docs", "codex", "Mac Studio"},         {"vault", "obsidian-vault", "muse", "MacBook Pro"},
    {"site", "landing", "codex", "Mac Studio"},      {"cur", "api-client", "cursor", "MacBook Pro"},
    {"notes2", "reading-list", "muse", "MacBook Pro"},
    {"kilo", "kilo-agent", "kilo", "Mac Studio"},
};
static const char *const T_FW[] = {"fw", "ota"}, *const T_BE[] = {"be", "cli", "web"},
    *const T_DESK[] = {"desk", "docs", "vault", "site"}, *const T_NOTES[] = {"vault", "notes2", "kilo"},
    *const T_WEB[] = {"web", "site", "cur"};
static const char *const T_REPO[] = {"fw", "be", "web", "docs", "cur", "notes2"};   // six panes, laid out 3 x 2 by the window
static const char *const *TAB_IDS[] = {T_FW, T_BE, T_DESK, T_NOTES, T_WEB, T_REPO};
static const uint8_t TAB_N[] = {2, 3, 4, 3, 3, 6};
static const char *const TAB_NAMES[] = {"Firmware", "Backend", "Desktop", "Notes", "Web", "Harness repo"};
#define TABS 6

static pod_model_t M;
static pod_nav_t N;
static ht_scene_t S;
static pod_out_frame_t F;

static void demo(void)
{
    pod_model_reset(&M);
    pod_model_agents_begin(&M);
    for (unsigned i = 0; i < sizeof AGENTS / sizeof AGENTS[0]; i++)
        pod_model_agent(&M, AGENTS[i].id, AGENTS[i].name, AGENTS[i].engine, AGENTS[i].machine);
    pod_model_agents_end(&M);
    cable_swarm_t sw[TABS];
    for (int i = 0; i < TABS; i++) {
        memset(&sw[i], 0, sizeof sw[i]);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", TAB_NAMES[i]);
        sw[i].panes = TAB_N[i]; sw[i].agents = TAB_N[i];
    }
    cable_tile_t tiles[6];   // the selected tab, "Harness repo": 3 columns x 2 rows
    memset(tiles, 0, sizeof tiles);
    for (int k = 0; k < 6; k++) {
        tiles[k].x1 = (int16_t)(k % 3 * 333); tiles[k].x2 = (int16_t)(k % 3 == 2 ? 1000 : (k % 3 + 1) * 333);
        tiles[k].y1 = (int16_t)(k / 3 * 500); tiles[k].y2 = (int16_t)((k / 3 + 1) * 500);
        snprintf(tiles[k].agent_id, sizeof tiles[k].agent_id, "%s", T_REPO[k]);
    }
    pod_model_swarms(&M, sw, TAB_IDS, TAB_N, TABS, "s5", tiles, 6);
    pod_model_link(&M, true);
    pod_model_turn(&M, "fw", "activity", "Editing touch_gt911.c \xe2\x80\x94 turning the touch the same way as the panel", 134, T0);
    pod_model_turn(&M, "ota", "activity", "Building with idf.py \xe2\x80\x94 1,204 of 1,530", 301, T0);
    pod_model_turn(&M, "be", "activity", "Running pnpm test \xe2\x80\x94 212 of 640", 48, T0);
    pod_model_turn(&M, "web", "activity", "Drawing the pricing cards", 12, T0);
    pod_model_turn(&M, "cur", "activity", "Regenerating the OpenAPI client", 73, T0);
    pod_model_turn(&M, "cli", "activity", "Preparing the migration", 29, T0);
    pod_model_question(&M, "cli", "Run the migration on the dev database now?");
    pod_model_turn(&M, "desk", "activity", "Wrapping up", 252, T0);
    pod_model_turn(&M, "desk", "done", NULL, 0, T0);
    pod_model_recap(&M, "desk", "The Relaxing chip now follows Rest until you pick a row for it. Rest reads Idle, so the two are not "
                    "confused. All 54 pet settings tests pass. Nothing is committed yet.", false);
    pod_model_turn(&M, "docs", "activity", "Wrapping up", 77, T0);
    pod_model_turn(&M, "docs", "done", NULL, 0, T0);
    pod_model_recap(&M, "docs", "The release guide now says to reuse the Desktop receipt. No other page changed.", false);
    pod_model_recap(&M, "kilo", "Sorted the imports and removed the dead branch in the router. Tests pass.", false);
    pod_model_turn(&M, "kilo", "done", NULL, 0, T0);
    pod_model_recap(&M, "vault", "Added two more poems to Poems and Themes.md: \xe2\x80\x9cMorning Window\xe2\x80\x9d and "
                    "\xe2\x80\x9cThe River\xe2\x80\x9d.", true);
    pod_nav_init(&N);
}

// The mockup's Option B: Recent, then five tabs with the second selected, the last one empty.
static void mock_tabs(void)
{
    static const char *const names[] = {"Harness repo", "Doi song", "Thoi trang", "Harness Store", "New Swarm"};
    static const char *const *ids[] = {T_REPO, T_BE, T_FW, T_DESK, NULL};
    static const uint8_t n[] = {6, 3, 2, 4, 0};
    cable_swarm_t sw[5];
    memset(sw, 0, sizeof sw);
    for (int i = 0; i < 5; i++) {
        snprintf(sw[i].id, SWARM_ID_MAX, "m%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", names[i]);
        sw[i].panes = sw[i].agents = n[i];
    }
    pod_model_swarms(&M, sw, ids, n, 5, "m0", NULL, 0);
}

// The demo's tabs followed by `extra` more, each a copy of one of them (same panes), so the grid has pages to scroll.
static void more_tabs(int extra)
{
    enum { MAXT = 24 };
    cable_swarm_t sw[MAXT];
    const char *const *ids[MAXT];
    uint8_t n[MAXT];
    static char names[MAXT][CABLE_NAME_MAX];
    int total = TABS + extra < MAXT ? TABS + extra : MAXT;
    memset(sw, 0, sizeof sw);
    for (int i = 0; i < total; i++) {
        int k = i % TABS;
        ids[i] = TAB_IDS[k]; n[i] = TAB_N[k];
        if (i < TABS) snprintf(names[i], CABLE_NAME_MAX, "%s", TAB_NAMES[i]); else snprintf(names[i], CABLE_NAME_MAX, "%s %d", TAB_NAMES[k], i / TABS + 1);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", names[i]);
        sw[i].panes = sw[i].agents = TAB_N[k];
    }
    pod_model_swarms(&M, sw, ids, n, total, "s5", NULL, 0);
}

static bool open_agent(const char *id)
{
    for (int t = 0; t < TABS; t++)
        for (int k = 0; k < TAB_N[t]; k++)
            if (!strcmp(TAB_IDS[t][k], id)) {
                pod_nav_act(&N, &M, POD_A_OPEN_TAB, t, T0);
                pod_nav_act(&N, &M, POD_A_OPEN_AGENT, k, T0);
                return true;
            }
    return false;
}

int main(int argc, char **argv)
{
    if (argc < 3) { fprintf(stderr, "usage: pod_render <screen> <out.ppm> [now_ms]\n"); return 2; }
    const char *screen = argv[1];
    bool timing = !strncmp(screen, "time:", 5);   // time:<screen>: rasterise the screen 50 times, print the mean us per full frame
    if (timing) screen += 5;
    uint32_t now = argc > 3 ? (uint32_t)strtoul(argv[3], NULL, 10) : T0;
    demo();
    if (!strncmp(screen, "tabs", 4)) {   // tabs, or tabs:<n>: the Cover Flow with cover n (0 = Recent) chosen
        if (screen[4] == ':' && !strcmp(screen + 5, "mock")) mock_tabs();
        else if (screen[4] == ':') {
            const char *plus = strchr(screen, '+');   // tabs:<rows>+<n>: n more tabs
            if (plus) more_tabs(atoi(plus + 1));
            pod_nav_act(&N, &M, POD_A_SCROLL, atoi(screen + 5), T0);   // rows (2 a page)
        }
        const char *at = strchr(screen, '@');   // tabs:<rows>@<px>: mid-drag, the grid at this offset from the top of page 0
        if (at) { F.tabs_moving = true; F.tabs_off = atoi(at + 1); }
    } else if (!strncmp(screen, "default", 7)) {   // default marks: a tab with no panes, one of unknown agents, one with a stranger
        pod_model_agents_begin(&M);
        pod_model_agent(&M, "zz", "stranger", "zzz", "MacBook Pro");
        pod_model_agent(&M, "fw", "firmware-pro", "claude", "MacBook Pro");
        pod_model_agents_end(&M);
        static const char *const A[] = {"zz", "nobody"}, *const B[] = {"fw", "zz", "nobody"};
        static const char *const *L[] = {NULL, A, B};
        static const uint8_t NN[] = {0, 2, 3};
        cable_swarm_t sw[3];
        memset(sw, 0, sizeof sw);
        snprintf(sw[0].id, SWARM_ID_MAX, "e0"); snprintf(sw[0].name, CABLE_NAME_MAX, "Empty");
        snprintf(sw[1].id, SWARM_ID_MAX, "e1"); snprintf(sw[1].name, CABLE_NAME_MAX, "Strangers"); sw[1].panes = sw[1].agents = 2;
        snprintf(sw[2].id, SWARM_ID_MAX, "e2"); snprintf(sw[2].name, CABLE_NAME_MAX, "Mixed"); sw[2].panes = sw[2].agents = 3;
        pod_model_swarms(&M, sw, L, NN, 3, "e0", NULL, 0);
        if (strstr(screen, "tab")) pod_nav_act(&N, &M, POD_A_OPEN_TAB, 2, T0);
        if (strstr(screen, "talk")) { pod_nav_act(&N, &M, POD_A_OPEN_TAB, 1, T0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, T0); }
    } else if (!strcmp(screen, "recent")) {
        pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, T0);
    } else if (!strncmp(screen, "tab:", 4)) {
        pod_nav_act(&N, &M, POD_A_OPEN_TAB, atoi(screen + 4), T0);
    } else if (!strncmp(screen, "agent:", 6) || !strncmp(screen, "recap:", 6) || !strncmp(screen, "talk:", 5)) {
        const char *id = strchr(screen, ':') + 1;
        if (!open_agent(id)) { fprintf(stderr, "no such agent: %s\n", id); return 2; }
        if (screen[0] == 'a' && N.stack[N.depth - 1].view != POD_V_AGENT) pod_nav_act(&N, &M, POD_A_RECAP, 0, T0);
        if (screen[0] == 'r' && N.stack[N.depth - 1].view != POD_V_RECAP) pod_nav_act(&N, &M, POD_A_RECAP, 0, T0);
        if (screen[0] == 't') pod_nav_act(&N, &M, POD_A_TALK, 0, T0);
    } else if (!strncmp(screen, "chrome", 6)) {
    } else {
        fprintf(stderr, "unknown screen: %s\n", screen);
        return 2;
    }
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    if (!strncmp(screen, "chrome", 6)) {   // the status bar and the transport alone: chrome or chrome:talk
        pod_status(&F, "Firmware", true, 0);
        pod_transport(&F, strstr(screen, "talk") != NULL);
    } else {
        pod_render(&F, &N, &M, now);
    }
    static uint16_t px[720 * 720];
    ht_rect_t all = {0, 0, 720, 720};
    if (timing) {
        enum { REPS = 50 };
        struct timespec a, b;
        double build = 0, raster = 0;
        for (int i = 0; i < REPS; i++) {
            clock_gettime(CLOCK_MONOTONIC, &a);
            ht_scene_clear(&S, ht_rgb(0xffffff));
            pod_render(&F, &N, &M, now);
            clock_gettime(CLOCK_MONOTONIC, &b);
            build += (double)(b.tv_sec - a.tv_sec) * 1e6 + (double)(b.tv_nsec - a.tv_nsec) / 1e3;
            clock_gettime(CLOCK_MONOTONIC, &a);
            ht_raster(&S, all, px);
            clock_gettime(CLOCK_MONOTONIC, &b);
            raster += (double)(b.tv_sec - a.tv_sec) * 1e6 + (double)(b.tv_nsec - a.tv_nsec) / 1e3;
        }
        printf("%s: %d runs; mean per full frame over %d: %.0f us rasterise, %.0f us build the scene\n", screen, S.count, REPS,
               raster / REPS, build / REPS);
        return 0;
    }
    ht_raster(&S, all, px);
    FILE *f = fopen(argv[2], "wb");
    if (!f) { perror(argv[2]); return 1; }
    fprintf(f, "P6\n720 720\n255\n");
    for (int i = 0; i < 720 * 720; i++) {
        unsigned v = px[i];
        unsigned char rgb[3] = {(unsigned char)((v >> 11) * 255 / 31), (unsigned char)(((v >> 5) & 63) * 255 / 63),
                                (unsigned char)((v & 31) * 255 / 31)};
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    printf("%s: %d runs, %d hits\n", screen, S.count, F.hit_count);
    return 0;
}
