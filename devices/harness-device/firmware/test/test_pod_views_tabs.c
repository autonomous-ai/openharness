// Task 7: the Tabs and Tab screens (and the "Connecting..." state of pod_render).
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/pod_view.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3 };   // pro_canvas.c's run kinds

static pod_model_t M;
static pod_nav_t N;
static pod_out_frame_t F;
static ht_scene_t S;

static void render(uint32_t now) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    pod_render(&F, &N, &M, now);
}
static int count_kind(int kind) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == kind) n++;
    return n;
}
static int count_rect(uint16_t ink) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ink) n++;
    return n;
}
static const ht_run_t *find_text(const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
static const pod_hit_t *find_hit(pod_action_t a, int arg) {
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == a && F.hits[i].arg == arg) return &F.hits[i];
    return NULL;
}

// n tabs, each with `per` agents named a<i>_<k> (claude), ids in the swarms feed.
static char ids[POD_TABS_MAX][12][8];
static const char *idp[POD_TABS_MAX][12];
static const char *const *idl[POD_TABS_MAX];
static uint8_t idn[POD_TABS_MAX];
static cable_swarm_t sw[POD_TABS_MAX];
static void build(int tabs, int per, bool with_ids) {
    pod_model_reset(&M);
    for (int i = 0; i < tabs; i++)
        for (int k = 0; k < per; k++) {
            snprintf(ids[i][k], 8, "t%dk%d", i, k);
            char name[16]; snprintf(name, sizeof name, "agent%d%d", i, k);
            pod_model_agent(&M, ids[i][k], name, "claude", "mac");
        }
    pod_model_agents_end(&M);
    for (int i = 0; i < tabs; i++) {
        for (int k = 0; k < per; k++) idp[i][k] = ids[i][k];
        idl[i] = idp[i]; idn[i] = (uint8_t)per;
        memset(&sw[i], 0, sizeof sw[i]);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "Tab%d", i);
        sw[i].panes = per; sw[i].agents = per;
    }
    const char *const *const *lists = with_ids ? (const char *const *const *)idl : NULL;
    pod_model_swarms(&M, sw, (const char *const **)lists, with_ids ? idn : NULL, tabs, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
}

static int count_in(int kind, int x, int y, int side);
static int default_marks_in(int x, int y, int side) {   // the default mark's outline rects inside a square
    int n = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x9aa09a) && b.x >= x && b.y >= y && b.x + b.w <= x + side && b.y + b.h <= y + side) n++;
    }
    return n;
}
static void build_shared(int tabs, int per);
static void tab_test_rows(void) {
    build(1, 3, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t0k2", "done", NULL, 0, 20);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(5000);
    const ht_run_t *a = find_text("agent00"), *b = find_text("agent01"), *c = find_text("agent02");
    CHECK(a && b && c && a->y < b->y && b->y < c->y);
    CHECK(find_text("1") == NULL);             // the working row shows the equaliser, not its number
    CHECK(find_text("2") != NULL && find_text("3") != NULL);
    CHECK(find_text("Idle") == NULL);          // agent01 is idle: its row says nothing on the right
    CHECK(find_text("Tab0") != NULL && find_text("Tab0")->y < 54 && find_text("3 panes") == NULL && find_text("TAB") == NULL);   // no head: the status bar names the tab
    CHECK(find_hit(POD_A_BACK, 0) != NULL);
    CHECK(a->y < 54 + 84);               // the first row starts right under the status bar
    for (int k = 0; k < 3; k++) CHECK(find_hit(POD_A_OPEN_AGENT, k) != NULL);
    // The working row's name is blue.
    CHECK(a->fg == ht_rgb(0x1f63d1) && b->fg == ht_rgb(0x111111));
    // Three equaliser bars in blue sit left of the first row's name.
    int bars = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x1f63d1) && S.runs[i].w < 10 && S.runs[i].y > 54) bars++;
    CHECK(bars == 3);
    // The Recent list prefixes the tab name and heads itself RECENT / Recent / N agents.
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    render(5000);
    CHECK(find_text("Tab0 ") != NULL && find_text("RECENT") == NULL && find_text("EVERY TAB") == NULL);
    CHECK(find_text("Recent") != NULL && find_text("Recent")->y < 54 && find_text("3 agents") == NULL);   // only the status bar title; the head is gone
    CHECK(count_kind(K_IMAGE) >= 3);
}

// With the head gone a tab lists up to seven rows, the first right under the status bar, and scrolls past them.
static void tab_test_many_rows(void) {
    build_shared(1, 9);
    for (int k = 0; k < 9; k++) pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(100);
    int rows = 0;
    for (int k = 0; k < 9; k++) if (find_hit(POD_A_OPEN_AGENT, k)) rows++;
    CHECK(rows == 7 && S.count <= HT_RUNS && find_hit(POD_A_OPEN_AGENT, 0)->y == 54);
    CHECK(find_hit(POD_A_OPEN_AGENT, 6)->y + 84 <= 720);
    CHECK(pod_tab_max_row(&N, &M) == 2);
    pod_nav_act(&N, &M, POD_A_SCROLL, 9, 0);
    render(100);
    CHECK(find_hit(POD_A_OPEN_AGENT, 8) != NULL && find_hit(POD_A_OPEN_AGENT, 1) == NULL && S.count <= HT_RUNS);
}

static void tab_test_empty(void) {
    build(0, 0, true);
    pod_model_swarms(&M, sw, NULL, NULL, 0, "", NULL, 0);
    cable_swarm_t one = {"e", "Empty", 0, 0};
    pod_model_swarms(&M, &one, NULL, NULL, 1, "e", NULL, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(0);
    CHECK(find_text("No panes in this tab") != NULL);
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    render(0);
    CHECK(find_text("No recent agents") != NULL);   // an empty Recent list says so
    CHECK(find_text("No panes in this tab") == NULL);
    CHECK(find_text("No recent agents")->y > 54 + 200 && find_text("No recent agents")->y < 720 - 200);   // centred under the status bar
    pod_nav_init(&N);
    render(0);   // the Tabs grid: Recent reads "0 agents" and stays tappable
    CHECK(find_text("Recent") != NULL && find_text("0 agents") != NULL);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL);
}

static void tabs_test_no_ids(void) {
    build(2, 3, false);          // an older daemon: counts only
    render(0);
    CHECK(count_in(K_IMAGE, 262, 86, 196) == 0 && count_in(K_IMAGE, 490, 86, 196) == 0);   // the tabs' panes are blank, Recent's agents have marks
    CHECK(find_text("3 panes") != NULL);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 6);   // both tabs' three blank panes, each with the default mark's outline
    CHECK(find_hit(POD_A_OPEN_TAB, 0) != NULL && find_hit(POD_A_OPEN_TAB, 1) != NULL);
}

// A pane whose agent or engine has no mark, and a tab with no panes, show the default mark, never an empty pane.
static void tabs_test_default_mark(void) {
    // Members listed but the roster does not know them (a tab of another window), and an agent with no engine.
    build(1, 2, true);
    pod_model_agent(&M, ids[0][1], "blank", "", "mac");
    pod_model_agent(&M, ids[0][0], "odd", "zzz-unknown", "mac");
    render(0);
    CHECK(default_marks_in(262, 86, 196) == 2 && count_rect(ht_rgb(0x9aa09a)) == 4);   // the tab's two panes; Recent holds the same two agents
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x9aa09a)) CHECK(S.runs[i].w == POD_DEFAULT_MARK_SIDE && S.runs[i].pro_height == POD_DEFAULT_MARK_SIDE);
    CHECK(find_text(">_") != NULL && find_text(">_")->fg == ht_rgb(0x6f746f) && find_text(">_")->pro_font == &ht_pro_24);
    // A tab with zero panes is an Empty cover (no pane, no mark).
    pod_model_reset(&M);
    cable_swarm_t none = {"e", "Empty", 0, 0};
    pod_model_swarms(&M, &none, NULL, NULL, 1, "e", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
    render(0);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 0 && find_text(">_") == NULL && find_text("Empty") != NULL);   // a "+" cover, no mark
    // Members unknown (older daemon) with 2 panes: two default marks.
    cable_swarm_t two = {"e", "Two", 2, 2};
    pod_model_swarms(&M, &two, NULL, NULL, 1, "e", NULL, 0);
    render(0);
    CHECK(default_marks_in(262, 86, 196) == 2);
    // The Tab screen has no pane diagram now, and members unknown list no rows.
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(0);
    CHECK(count_rect(ht_rgb(0x9aa09a)) == 0 && find_text("No panes in this tab") != NULL);
    CHECK(pod_mark_runs("zzz") == POD_DEFAULT_MARK_RUNS && pod_mark_runs(NULL) == POD_DEFAULT_MARK_RUNS);
}


// ---- the album grid ---------------------------------------------------------------------------------------

enum { COVER = 196, COL_X0 = 34, COL_PITCH = 228, ROW_Y0 = 104, ROW_PITCH = 280 };
#define RING_BLUE ht_rgb(0x0a84ff)
static int dots_in(int x, int y, int side) {   // the 12 px (cards) and 9 px (captions) state dots inside a box
    int n = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_RECT || r->w != 12 || (r->fg != ht_rgb(0x34c759) && r->fg != ht_rgb(0xff9f0a))) continue;
        ht_rect_t b = ht_run_bounds(r);
        if (b.x >= x && b.y >= y && b.x + b.w <= x + side && b.y + b.h <= y + side) n++;
    }
    return n;
}
// Runs of a kind (-1: any but text) whose bounds lie inside the square at (x, y).
static int count_in(int kind, int x, int y, int side) {
    int n = 0;
    for (int i = 0; i < S.count; i++) {
        if (S.runs[i].pro_kind == K_TEXT) continue;
        if (kind >= 0 && S.runs[i].pro_kind != kind) continue;
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (b.x >= x && b.y >= y && b.x + b.w <= x + side && b.y + b.h <= y + side) n++;
    }
    return n;
}
static void cover_xy(int i, int *x, int *y) { *x = COL_X0 + i % 3 * COL_PITCH; *y = ROW_Y0 + i / 3 * ROW_PITCH; }
// Every tab lists the same first `per` agents (the roster holds 32): a real mark in every pane of every cover.
static void build_shared(int tabs, int per) {
    pod_model_reset(&M);
    for (int k = 0; k < per; k++) {
        snprintf(ids[0][k], 8, "m%d", k);
        pod_model_agent(&M, ids[0][k], "member", k % 3 == 2 ? "cursor" : "claude", "mac");
    }
    pod_model_agents_end(&M);
    for (int k = 0; k < per; k++) idp[0][k] = ids[0][k];
    for (int i = 0; i < tabs; i++) {
        idl[i] = idp[0]; idn[i] = (uint8_t)per;
        memset(&sw[i], 0, sizeof sw[i]);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "Tab%d", i);
        sw[i].panes = (uint8_t)per; sw[i].agents = (uint8_t)per;
    }
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, tabs, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
}

// 1 to 24 tabs, 0 to 9 panes a tab, every scroll position, members known or counts only: always within the run and hit
// budgets, and the same count whatever the clock says (the screen is static).
static int max_runs;
static void grid_test_budget(void) {
    static const int tabs_for[] = {1, 2, 5, 7, 12, 24};
    for (int j = 0; j < 6; j++)
        for (int per = 0; per <= 9; per++)
            for (int known = 0; known < 2; known++) {
                if (known) build_shared(tabs_for[j], per); else build(tabs_for[j], per, false);
                if (per) {
                    pod_model_turn(&M, known ? "m0" : "t0k0", "started", NULL, 0, 10);
                    if (known && per > 1) pod_model_question(&M, "m1", "ok?");
                }
                for (int k = 0; k < per && known; k++) pod_model_opened(&M, ids[0][k], 20 + (uint32_t)k);
                for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
                    pod_nav_init(&N);
                    pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
                    render(1000);
                    int want = S.count;
                    if (want > max_runs) max_runs = want;
                    CHECK(want > 0 && want <= HT_RUNS && F.hit_count <= 32);
                    for (uint32_t t = 1000; t < 3000; t += 331) { render(t); CHECK(S.count == want); }
                }
            }
    // The worst: nine panes, every mark a light (Cursor) chip, a mover on every card, eight recent agents.
    build_shared(12, 9);
    for (int k = 0; k < 9; k++) { pod_model_agent(&M, ids[0][k], "x", "cursor", "mac"); pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5); pod_model_opened(&M, ids[0][k], 6 + (uint32_t)k); }
    for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
        pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
        render(100);
        CHECK(S.count <= HT_RUNS && F.hit_count <= 32);
    }
}

// Six covers (Recent and five tabs of six panes): every pane draws its mark, and the busy ones their dots.
static void grid_test_six_covers(void) {
    build_shared(5, 6);
    pod_model_turn(&M, "m0", "started", NULL, 0, 10);
    pod_model_question(&M, "m1", "ok?");
    render(500);
    CHECK(F.hit_count == 6 && S.count <= HT_RUNS);
    for (int i = 1; i < 6; i++) {
        int x, y;
        cover_xy(i, &x, &y);
        // Every cover wears a ribbon (eight runs), so the last covers lose their marks first; the selected one keeps all six
        // (a mark in each pane; Cursor's light mark is an image on a chip).
        CHECK(i == 1 ? count_in(K_IMAGE, x, y, COVER) == 6 : count_in(K_IMAGE, x, y, COVER) <= 6);
        CHECK(count_in(K_RECT, x, y, COVER) >= 6 + 2 || i > 1);   // cards and the light marks' chips
    }
    // Six covers of six busy panes cost more than a frame holds: the dots go first, the last covers' first, the selected one's last.
    int x1, y1, x5, y5;
    cover_xy(1, &x1, &y1); cover_xy(5, &x5, &y5);
    CHECK(dots_in(x1, y1, COVER) <= 2 && dots_in(x5, y5, COVER) <= dots_in(x1, y1, COVER));   // the eight-run ribbons crowd the dots out first
    // With four panes a cover and a ribbon on each, the dots still all fit: every busy pane has its dot, on every cover.
    build_shared(5, 4);
    pod_model_turn(&M, "m0", "started", NULL, 0, 10);
    pod_model_question(&M, "m1", "ok?");
    render(500);
    for (int i = 1; i < 6; i++) {
        int x, y;
        cover_xy(i, &x, &y);
        CHECK(dots_in(x, y, COVER) <= 2 && count_in(K_IMAGE, x, y, COVER) <= 4);   // m0 working (green), m1 asking (amber)
        CHECK(i != 1 || count_in(K_IMAGE, x, y, COVER) == 4);   // the selected cover keeps its marks
    }
    CHECK(count_in(POD_TRI, 0, 54, 720) == 0);               // no triangles on the grid (the status bar's play triangle is above it)
    CHECK(count_kind(POD_CELL) == 0);
}

// The chosen tab is ringed in blue and its name is blue; no other is.
static void grid_test_chosen_ring(void) {
    build(3, 2, true);
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 3, "s1", NULL, 0);   // Tab1 is the window's selected tab
    render(0);
    CHECK(find_text("Tab1") && find_text("Tab1")->fg == RING_BLUE);
    CHECK(find_text("Tab0")->fg == ht_rgb(0x111111) && find_text("Tab2")->fg == ht_rgb(0x111111) && find_text("Recent")->fg == ht_rgb(0x111111));
    int rings = 0, x, y;
    cover_xy(2, &x, &y);   // cover 2 is Tab1
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_RECT || r->fg != RING_BLUE) continue;
        rings++;
        ht_rect_t b = ht_run_bounds(r);
        CHECK(b.x < x && b.x + b.w > x + COVER && b.y < y && b.y + b.h > y + COVER && b.x >= x - 12 && b.w <= COVER + 24);
    }
    CHECK(rings == 1);
}

// A tab with no panes: a grey cover with a "+" ring, captioned Empty.
static void grid_test_empty_tab(void) {
    pod_model_reset(&M);
    cable_swarm_t two[2] = {{"a", "Alpha", 0, 0}, {"b", "Beta", 0, 0}};
    pod_model_swarms(&M, two, NULL, NULL, 2, "a", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
    render(0);
    CHECK(find_text("Empty") != NULL && find_text("Empty")->pro_font == &ht_pro_24 && find_text("0 panes") == NULL);
    int x, y;
    cover_xy(1, &x, &y);
    int arcs = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (S.runs[i].pro_kind == POD_ARC && b.x > x && b.x + b.w < x + COVER && b.y > y && b.y + b.h < y + COVER) arcs++;
    }
    CHECK(arcs == 1);                                       // the ring
    CHECK(count_in(K_RECT, x, y, COVER) == 2);              // the plus: two bars (the cover itself is a gradient)
    CHECK(count_in(K_IMAGE, x, y, COVER) == 0 && find_hit(POD_A_OPEN_TAB, 0) != NULL);
}

// Recent: up to 8 agents' marks in a 4 x 2 grid of white squares, a dot on the working ones; "N agents" and what is working.
static void grid_test_recent_face(void) {
    build_shared(1, 9);
    for (int k = 0; k < 9; k++) pod_model_opened(&M, ids[0][k], 20 + (uint32_t)k);
    pod_model_turn(&M, "m3", "started", NULL, 0, 30);
    pod_model_turn(&M, "m4", "started", NULL, 0, 30);
    render(40);
    CHECK(count_in(K_IMAGE, COL_X0, ROW_Y0, COVER) == 8);   // the newest 8 of 9
    CHECK(dots_in(COL_X0, ROW_Y0, COVER) == 2);
    CHECK(find_text("8 agents") != NULL);
    CHECK(find_text("Working") != NULL);   // the ribbon says what the caption no longer does (the status bar still says "2 working")
    pod_model_reset(&M);                                    // nobody recent: the clock face, "0 agents"
    cable_swarm_t one = {"a", "Alpha", 1, 1};
    pod_model_swarms(&M, &one, NULL, NULL, 1, "a", NULL, 0);
    pod_model_link(&M, true);
    render(0);
    CHECK(find_text("0 agents") != NULL && count_in(K_IMAGE, COL_X0, ROW_Y0, COVER) == 0);
}

// The runs that are not text, the glass or the status bar: covers, rings, cards, marks, dots (y >= the glass top).
static int lowest_cover_edge(void) {
    int low = 0;
    for (int i = 0; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        if (b.w >= 720 || b.y < 54 || (S.runs[i].pro_kind == K_RECT && b.w == 6 && b.h == 6)) continue;   // the glass, the status bar, the page dots
        if (b.y + b.h > low) low = b.y + b.h;
    }
    return low;
}
static int page_dots(int *dark) {   // the page dots: 6 px circles; how many, and the position of the dark one
    int n = 0;
    *dark = -1;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].w == 6 && S.runs[i].pro_height == 6) { if (S.runs[i].fg == ht_rgb(0x4a4e5a)) *dark = n; n++; }
    return n;
}

// Two rows of covers a page, whole pages: nothing of the next row shows at rest, the frame's scroll is the page's first row.
static void grid_test_scroll(void) {
    build(10, 2, true);                                     // 11 covers: 4 rows, 2 pages
    CHECK(pod_tabs_pitch() == 2 * ROW_PITCH && pod_tabs_pages(&M) == 2 && pod_tabs_max_row(&M) == 2);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) && find_hit(POD_A_OPEN_TAB, 4) && !find_hit(POD_A_OPEN_TAB, 5));   // covers 0..5 only
    CHECK(F.hit_count == 6);
    CHECK(find_text("Tab4") != NULL && find_text("Tab5") == NULL);
    CHECK(lowest_cover_edge() <= ROW_Y0 + ROW_PITCH + COVER + 90);   // nothing below the second row's captions
    CHECK(F.hits[5].y + F.hits[5].h <= 720 && F.hits[5].y + F.hits[5].h <= ROW_Y0 + ROW_PITCH + 300);
    int dark;
    CHECK(page_dots(&dark) == 2 && dark == 0);
    pod_nav_act(&N, &M, POD_A_SCROLL, 2, 0);               // the second page: covers 6..10
    render(0);
    CHECK(!find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) && find_hit(POD_A_OPEN_TAB, 5) && find_hit(POD_A_OPEN_TAB, 9) && F.hit_count == 5);
    CHECK(find_hit(POD_A_OPEN_TAB, 5)->y == ROW_Y0 && find_hit(POD_A_OPEN_TAB, 9)->y == ROW_Y0 + ROW_PITCH);
    CHECK(page_dots(&dark) == 2 && dark == 1);
    pod_nav_act(&N, &M, POD_A_SCROLL, 50, 0);               // past the end: the draw clamps
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, 9) && !find_hit(POD_A_OPEN_TAB, 4));
    const pod_hit_t *last = find_hit(POD_A_OPEN_TAB, 9);
    CHECK(last->y + last->h <= 720 && last->x >= 0 && last->x + last->w <= 720);
    pod_nav_act(&N, &M, POD_A_SCROLL, 3, 0);                // an odd row: its page
    pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, 1, 0);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL);
    pod_nav_act(&N, &M, POD_A_SCROLL, -100, 0);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL);
    build(4, 1, true);                                      // five covers: nothing to scroll, no dots
    CHECK(pod_tabs_max_row(&M) == 0 && pod_tabs_pages(&M) == 1);
    render(0);
    CHECK(page_dots(&dark) == 0);
    F.tabs_moving = true; F.tabs_off = 200; ht_scene_clear(&S, ht_rgb(0xffffff)); pod_render(&F, &N, &M, 0);   // one page does not move
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT)->y == ROW_Y0);
    build(0, 0, true);
    render(0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) != NULL && F.hit_count == 1);
}

static void render_at(int off, uint32_t now) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    F.tabs_moving = true;
    F.tabs_off = off;
    pod_render(&F, &N, &M, now);
}

// While the grid is dragged it is drawn at the pixel offset: both pages, the rows that meet the glass, the status bar over
// whatever has scrolled under it, the hits clipped to the glass; on a page boundary it is the resting screen.
static void grid_test_motion(void) {
    build(10, 2, true);                                     // 11 covers, 2 pages
    int rest0;
    render(0);
    rest0 = S.count;
    render_at(0, 0);
    CHECK(S.count == rest0 && F.hit_count == 6 && find_hit(POD_A_OPEN_TAB, 0)->y == ROW_Y0);   // offset 0: the resting page 0
    render_at(2 * ROW_PITCH, 0);
    CHECK(F.hit_count == 5 && find_hit(POD_A_OPEN_TAB, 5)->y == ROW_Y0 && !find_hit(POD_A_OPEN_TAB, 4));   // a boundary: the resting page 1
    render_at(300, 0);                                      // 300 px into the first page
    const pod_hit_t *h = find_hit(POD_A_OPEN_TAB, 2);       // cover 3 (tab 2), the second row: it moved up by the offset
    CHECK(h && h->x == COL_X0 && h->y == ROW_Y0 + ROW_PITCH - 300);
    CHECK(find_hit(POD_A_OPEN_TAB, 5) && find_hit(POD_A_OPEN_TAB, 5)->y == ROW_Y0 + 2 * ROW_PITCH - 300);   // the next page's first row
    CHECK(find_text("Tab5") != NULL && find_text("Tab8") == NULL);   // row 3 (covers 9, 10) peeks in at 644: its cover shows, its name (850) does not
    CHECK(find_hit(POD_A_OPEN_TAB, 8) && find_hit(POD_A_OPEN_TAB, 8)->y == ROW_Y0 + 3 * ROW_PITCH - 300 && find_hit(POD_A_OPEN_TAB, 8)->y + find_hit(POD_A_OPEN_TAB, 8)->h == 720);
    for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].y >= 54 && F.hits[i].y + F.hits[i].h <= 720);
    // The status bar is drawn last: every run after its gradient lies in the bar, and nothing before it is in the way.
    int bar = -1;
    for (int i = 0; i < S.count; i++) { ht_rect_t b = ht_run_bounds(&S.runs[i]); if (b.y == 0 && b.h == 54 && b.w == 720) bar = i; }
    CHECK(bar >= 0);
    for (int i = bar; i < S.count; i++) CHECK(ht_run_bounds(&S.runs[i]).y < 54 && ht_run_bounds(&S.runs[i]).y + ht_run_bounds(&S.runs[i]).h <= 56);
    int dark;
    CHECK(page_dots(&dark) == 2 && dark == 1);              // 300 of 560: nearer the second page
    render_at(200, 0);
    CHECK(page_dots(&dark) == 2 && dark == 0);
    // A mid-motion row that has scrolled wholly under the bar is not drawn; a row below the glass neither.
    render_at(400, 0);
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT) == NULL);   // row 0 at 104 - 400: wholly under the bar, gone
    render_at(-100, 0);                                     // the end pulled down: the first page lower, nothing before it
    CHECK(find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT)->y == ROW_Y0 + 100 && find_hit(POD_A_OPEN_TAB, 5) == NULL);
}

// Run budget in motion: 24 tabs, nine marked panes a cover, the worst two partial pages (12 covers), every offset.
static void grid_test_motion_budget(void) {
    for (int per = 0; per <= 9; per += (per < 6 ? 2 : 1)) {
        build_shared(24, per);
        for (int k = 0; k < per; k++) { pod_model_agent(&M, ids[0][k], "x", k % 2 ? "cursor" : "claude", "mac"); pod_model_turn(&M, ids[0][k], "started", NULL, 0, 5); pod_model_opened(&M, ids[0][k], 6 + (uint32_t)k); }
        if (per > 1) pod_model_question(&M, "m1", "ok?");
        int pages = pod_tabs_pages(&M), most = 0, worst_total = 0;
        CHECK(pages == 5);                                  // 25 covers: 9 rows
        for (int off = -170; off <= 4 * 560 + 170; off += 11) {
            render_at(off, 100);
            int dark;
            CHECK(S.count > 0 && S.count <= HT_RUNS && F.hit_count <= 32 && page_dots(&dark) == pages);
            if (S.count > most) most = S.count;
            worst_total += F.hit_count;
        }
        CHECK(most > 40 && worst_total > 0);
    }
    // Resting is constant: the same count at every clock, and no more than the worst of the motion.
    build_shared(24, 9);
    for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
        pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
        render(0);
        int want = S.count;
        for (uint32_t t = 0; t < 3000; t += 331) { render(t); CHECK(S.count == want); render_at(row / 2 * 560, t); CHECK(S.count == want); }
    }
}

// Tap a cover: its tab (a normal tab by its id), Recent included.
static void grid_test_taps(void) {
    build(4, 2, true);
    render(0);
    const pod_hit_t *h = find_hit(POD_A_OPEN_TAB, POD_TAB_RECENT);
    CHECK(h && h->id[0] == 0 && h->x == COL_X0 && h->y == ROW_Y0);
    pod_nav_act(&N, &M, (pod_action_t)h->action, h->arg, 0);
    CHECK(N.depth == 2 && N.stack[1].view == POD_V_TAB && N.stack[1].tab == POD_TAB_RECENT);
    pod_nav_init(&N);
    render(0);
    h = find_hit(POD_A_OPEN_TAB, 2);
    CHECK(h && !strcmp(h->id, "s2"));
    CHECK(h->x == COL_X0 && h->y == ROW_Y0 + ROW_PITCH);   // cover 3 is row 1, column 0
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, h->arg, 0);
    CHECK(N.depth == 2 && N.stack[1].tab == 2 && !strcmp(N.stack[1].tab_id, "s2"));
    for (int i = 0; i < F.hit_count; i++) {                // every hit is on the glass and big enough to tap
        CHECK(F.hits[i].w >= 150 && F.hits[i].x >= 0 && F.hits[i].x + F.hits[i].w <= 720 && F.hits[i].y >= 54 && F.hits[i].y + F.hits[i].h <= 720);
        CHECK(F.hits[i].action == POD_A_OPEN_TAB);
    }
}

// The captions: name in 32, count line in 24 grey; working in green, asking in amber, each after a dot; the status bar.
static void grid_test_captions(void) {
    build(3, 2, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t1k0", "started", NULL, 0, 10);
    pod_model_question(&M, "t2k1", "ok?");
    render(20);
    const ht_run_t *name = find_text("Tab0"), *sub = find_text("2 panes");
    CHECK(name && sub && name->pro_font == &ht_pro_32 && sub->pro_font == &ht_pro_24 && sub->fg == ht_rgb(0x7b7d84));
    CHECK(name->fg == RING_BLUE);                           // Tab0 is the selected one
    CHECK(!find_text("1 asking"));   // the captions are the name and the count alone (the status bar keeps "3 working")
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y > 54 && strstr(S.runs[i].text, "working")) CHECK(0);
    CHECK(find_text("Tabs") != NULL && find_text("3 working") != NULL && find_text("3 working")->fg == ht_rgb(0x2fa84f));   // the status bar: working and asking
    CHECK(find_text("Tab1") != NULL && find_text("Tab2") != NULL && find_text("Recent") != NULL && find_text("6 agents") != NULL);
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].w == 9 && S.runs[i].pro_height == 9) CHECK(0);   // no caption dots
}

static void render_test_connecting(void) {
    build(2, 2, true);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0);
    int depth = N.depth;
    char who[ID_MAX]; strcpy(who, N.stack[N.depth - 1].agent);
    pod_model_link(&M, false);
    render(0);
    CHECK(find_text("Connecting") != NULL);
    CHECK(count_kind(K_IMAGE) == 0);
    for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != POD_CELL);
    CHECK(F.hit_count == 1 && F.hits[0].action == POD_A_BACK);
    CHECK(N.depth == depth && !strcmp(N.stack[N.depth - 1].agent, who));
    const ht_run_t *c = find_text("Connecting");
    CHECK(c->fg == ht_rgb(0x7b7d84) && c->pro_font == &ht_pro_32);
    pod_model_link(&M, true);
    render(0);
    CHECK(find_text("Connecting") == NULL);
}

static void transport_test_shape(void) {
    build(1, 1, true);
    int runs[2];
    for (int talking = 0; talking < 2; talking++) {
        memset(&F, 0, sizeof F);
        ht_scene_clear(&S, ht_rgb(0xffffff));
        F.scene = &S;
        pod_transport(&F, talking);
        runs[talking] = S.count;
        CHECK(F.hit_count == 5);
        for (int i = 0; i < F.hit_count; i++) {
            CHECK(F.hits[i].w >= 80 && F.hits[i].h >= 80);
            CHECK(F.hits[i].y >= POD_TRANSPORT_Y && F.hits[i].y + F.hits[i].h <= 720);
        }
        CHECK(find_hit(POD_A_TABS, 0) && find_hit(POD_A_PANES, 0) && find_hit(POD_A_PREV, 0) && find_hit(POD_A_TALK, 0) &&
              find_hit(POD_A_NEXT, 0) && !find_hit(POD_A_RECAP, 0));
        CHECK(!find_text("SEND") && !find_text("TALK") && find_text("TABS") && find_text("PANES"));
    }
    CHECK(runs[0] == runs[1] && runs[0] == POD_TRANSPORT_RUNS);
}

// M12: a turn.done that never came: after 25 s the agent is no longer counted as working anywhere.
static void tabs_test_stale_working(void) {
    build(1, 3, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    render(20);
    CHECK(find_text("3 panes") != NULL && find_text("Working") != NULL);
    int w, q;
    pod_tab_counts(&M, &M.tabs[0], &w, &q);
    CHECK(w == 1);
    render(10 + 25001);
    CHECK(find_text("Working") == NULL && find_text("3 panes") != NULL);
    pod_tab_counts(&M, &M.tabs[0], &w, &q);
    CHECK(w == 0 && q == 0);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(10 + 25001);
    CHECK(find_text("3 panes") == NULL && find_text("1 working") == NULL);   // the Tab screen has no head
}

// ---- the Playing ribbon ---------------------------------------------------------------------------------------------
static int ribbon_runs_in(int c, int *bars_out /* [3] heights */, int *discs) {   // runs in the cover's foot band; bar heights
    int x, y, n = 0, nb = 0;
    cover_xy(c, &x, &y);
    if (discs) *discs = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        ht_rect_t b = ht_run_bounds(r);
        if (b.x < x || b.x + b.w > x + COVER || b.y < y + COVER - 38 || b.y + b.h > y + COVER) continue;
        n++;
        if (r->pro_kind == K_RECT && r->fg == ht_rgb(0x34c759) && r->w == 5 && nb < 3 && bars_out) bars_out[nb++] = r->pro_height;
        if (r->pro_kind == K_RECT && r->w == 24 && discs) (*discs)++;
    }
    return n;
}
static void ribbon_setup(void) {   // Tab0 has one agent working (two panes), Tab1 only an asking one, Tab2 none
    build(3, 2, true);
    pod_model_turn(&M, "t0k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t1k0", "started", NULL, 0, 10);
    pod_model_turn(&M, "t1k0", "done", NULL, 0, 11);
    pod_model_question(&M, "t1k1", "ok?");
    for (int i = 0; i < 3; i++) pod_model_opened(&M, i == 0 ? "t0k0" : i == 1 ? "t0k1" : "t1k0", 5 + (uint32_t)i);   // Recent lists them
}
static const ht_run_t *foot_text(int c, const char *text) {   // a text run inside cover c's foot band
    int x, y; cover_xy(c, &x, &y);
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_TEXT && !strcmp(r->text, text) && r->x >= x && r->x < x + COVER && r->y >= y + COVER - 38 && r->y < y + COVER) return r;
    }
    return NULL;
}
static void ribbon_test_draws(void) {
    ribbon_setup();
    render(20);
    int disc;
    CHECK(ribbon_runs_in(1, NULL, &disc) == 8 && disc == 1);      // Tab0: band (2), bars (3), PLAYING, disc, count
    const ht_run_t *p = foot_text(1, "Working"), *cnt = foot_text(1, "1");
    CHECK(p && p->fg == ht_rgb(0xffffff) && p->pro_font == &ht_pro_24 && cnt && cnt->x > p->x + 60);
    int x, y; cover_xy(1, &x, &y);
    CHECK(p->x > x && p->x < x + COVER / 2);
    CHECK(foot_text(0, "Working") && foot_text(0, "1"));          // Recent counts its working agents (t0k0)
    CHECK(!foot_text(2, "Working") && ribbon_runs_in(2, NULL, &disc) == 0);   // asking only: no ribbon
    CHECK(!foot_text(3, "Working") && ribbon_runs_in(3, NULL, &disc) == 0);   // idle
    CHECK(!find_text("1 asking"));   // (the status bar keeps its "N working")
    // Two working agents in a tab: the disc says 2.
    pod_model_turn(&M, "t0k1", "started", NULL, 0, 12);
    render(30);
    CHECK(foot_text(1, "2") != NULL && foot_text(0, "2") != NULL);
}
static void ribbon_test_bars(void) {
    ribbon_setup();
    int seen[3] = {0, 0, 0}, last[3] = {0, 0, 0};
    int hs[3];
    static ht_scene_t prev;
    for (int k = 0; k < 6; k++) {
        uint32_t now = 900 + (uint32_t)k * 300;
        render(now);
        int cnt = S.count;
        ribbon_runs_in(1, hs, NULL);
        for (int b = 0; b < 3; b++) { CHECK(hs[b] == 8 || hs[b] == 14 || hs[b] == 20); seen[hs[b] == 8 ? 0 : hs[b] == 14 ? 1 : 2]++; }
        CHECK(hs[0] != hs[1] && hs[1] != hs[2] && hs[0] != hs[2]);   // three different heights at once
        if (k) {
            CHECK(cnt == prev.count);
            int diff = 0;
            for (int i = 0; i < cnt; i++) if (memcmp(&S.runs[i], &prev.runs[i], sizeof S.runs[i])) {
                diff++;
                CHECK(S.runs[i].pro_kind == K_RECT && S.runs[i].w == 5 && S.runs[i].fg == ht_rgb(0x34c759));   // only bar runs differ
            }
            CHECK(diff == 6);                                         // all three bars moved on both ribbons (Recent and Tab0)
            CHECK(hs[0] != last[0]);
        }
        memcpy(&prev, &S, sizeof S);
        memcpy(last, hs, sizeof hs);
        render(now + 299);   // within the same step: identical
        CHECK(!memcmp(&S.runs[0], &prev.runs[0], sizeof S.runs[0]) && S.count == prev.count);
        { int h2[3]; ribbon_runs_in(1, h2, NULL); CHECK(!memcmp(h2, hs, sizeof hs)); }
    }
    CHECK(seen[0] == 6 && seen[1] == 6 && seen[2] == 6);              // each state in each bar's turn
}
// 1..24 tabs, every page, working agents everywhere: the same run count in every step, within the budget.
static void ribbon_test_budget(void) {
    static const int tabs_for[] = {1, 2, 5, 7, 12, 24};
    for (int j = 0; j < 6; j++)
        for (int per = 1; per <= 9; per += 4) {
            build_shared(tabs_for[j], per);
            for (int k = 0; k < per; k++) pod_model_turn(&M, ids[0][k], "started", NULL, 0, 10);
            for (int row = 0; row <= pod_tabs_max_row(&M); row += 2) {
                pod_nav_init(&N); pod_nav_act(&N, &M, POD_A_SCROLL, row, 0);
                render(1000);
                int want = S.count;
                CHECK(want <= HT_RUNS && F.hit_count <= 32);
                for (uint32_t t = 1000; t < 3000; t += 100) { render(t); CHECK(S.count == want); }
                int pl = 0; for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, "Working")) pl++;
                int covers = 1 + tabs_for[j], first = row * 3, shown = covers - first < 6 ? covers - first : 6;
                CHECK(pl == shown);                                   // never dropped at rest
            }
        }
}

int main(void) {
    grid_test_budget();
    grid_test_six_covers();
    grid_test_chosen_ring();
    grid_test_empty_tab();
    grid_test_recent_face();
    grid_test_scroll();
    grid_test_motion();
    grid_test_motion_budget();
    grid_test_taps();
    grid_test_captions();
    tab_test_rows();
    tab_test_empty();
    tabs_test_no_ids();
    tabs_test_default_mark();
    tabs_test_stale_working();
    ribbon_test_draws();
    ribbon_test_bars();
    ribbon_test_budget();
    render_test_connecting();
    transport_test_shape();
    tab_test_many_rows();
    printf("test_pod_views_tabs: %d checks ok (most runs in a Tabs frame: %d of %d)\n", checks, max_runs, HT_RUNS);
    return 0;
}
