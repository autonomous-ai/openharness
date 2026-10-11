// The notification screens: the bell in the status bar, the Inbox, and the banner (pod_view_inbox.c, pod_chrome.c).
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/pod_view.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3 };

static pod_model_t M;
static pod_nav_t N;
static pod_out_frame_t F;
static ht_scene_t S;
static int max_runs;

// banner: the glue's order: flag first, pod_render, then pod_banner for the entry.
static void render_with(uint32_t now, const char *banner_agent) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    const pod_unread_t *u = banner_agent ? pod_model_unread_find(&M, banner_agent) : NULL;
    F.banner = u != NULL;
    pod_render(&F, &N, &M, now);
    if (u) pod_banner(&F, &M, u, now);
    if (S.count > max_runs) max_runs = S.count;
    CHECK(S.count <= HT_RUNS);
}
static void render(uint32_t now) { render_with(now, NULL); }

static const ht_run_t *find_text(const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
static const pod_hit_t *find_hit(pod_action_t a) {
    for (int i = F.hit_count - 1; i >= 0; i--) if (F.hits[i].action == a) return &F.hits[i];
    return NULL;
}
static int count_rect(uint16_t ink, int minx, int miny) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ink && S.runs[i].x >= minx && S.runs[i].y >= miny) n++;
    return n;
}
static bool overlap(ht_rect_t a, ht_rect_t b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

static const char *const NAMES[] = {"firmware-pro", "dial-ota", "backend", "harness-cli", "website", "desktop", "docs", "vault"};
static const char *const ENG[] = {"claude", "claude", "codex", "codex", "muse", "claude", "codex", "cursor"};
static char ids[8][8];
static const char *idp[8];
static const char *const *idl[1];
static uint8_t idn[1] = {8};
static cable_swarm_t sw[1];
static void build(void) {
    pod_model_reset(&M);
    for (int i = 0; i < 8; i++) {
        snprintf(ids[i], 8, "k%d", i);
        idp[i] = ids[i];
        pod_model_agent(&M, ids[i], NAMES[i], ENG[i], "Mac");
    }
    pod_model_agents_end(&M);
    idl[0] = idp;
    memset(sw, 0, sizeof sw);
    snprintf(sw[0].id, SWARM_ID_MAX, "s0");
    snprintf(sw[0].name, CABLE_NAME_MAX, "Firmware");
    sw[0].panes = sw[0].agents = 8;
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 1, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_nav_init(&N);
}

static void test_bell(void) {
    build();
    render(1000);
    int base = S.count;
    CHECK(!find_hit(POD_A_INBOX) && count_rect(ht_rgb(0x1f63d1), 500, 0) == 0);   // nothing unread: nothing drawn
    pod_model_unread_add(&M, "k0", "firmware-pro", "Done.", 10, 1000);
    render(1000);
    CHECK(S.count == base + POD_BELL_RUNS);
    const pod_hit_t *h = find_hit(POD_A_INBOX);
    CHECK(h && h->x > 500 && h->x + h->w == POD_W && h->y == 0 && h->h >= 54);
    // The pill: blue, at the right end of the bar, inside the bar, with the count in white beside the bell.
    const ht_run_t *pill = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x1f63d1) && S.runs[i].x > 500 && S.runs[i].y < POD_STATUS_H) pill = &S.runs[i];
    CHECK(pill);
    ht_rect_t pb = ht_run_bounds(pill);
    CHECK(pb.y >= 0 && pb.y + pb.h <= POD_STATUS_H && pb.x + pb.w <= POD_W - 12 && pb.w >= 60 && pb.w <= 110);
    const ht_run_t *cnt = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < POD_STATUS_H && !strcmp(S.runs[i].text, "1")) cnt = &S.runs[i];
    CHECK(cnt && cnt->fg == ht_rgb(0xffffff) && cnt->pro_font == &ht_pro_24);
    CHECK(count_rect(ht_rgb(0xffffff), pb.x, 0) >= 4);   // knob, dome, rim and clapper
    // It does not touch the title (Tabs, or a long tab name) nor the back hit.
    const ht_run_t *title = find_text("Tabs");
    CHECK(title && !overlap(ht_run_bounds(title), pb));
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    snprintf(M.tabs[0].name, sizeof M.tabs[0].name, "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW");
    render(1000);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < POD_STATUS_H && strncmp(S.runs[i].text, "1", 2)) CHECK(!overlap(ht_run_bounds(&S.runs[i]), pb));
    h = find_hit(POD_A_BACK);
    CHECK(h && h->x + h->w <= pb.x);
    // The count grows with the list, capped at what the list holds.
    for (int i = 1; i < 8; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "Done.", 5, 1000 + (uint32_t)i);
    render(1000);
    CHECK(find_text("8") && find_hit(POD_A_INBOX));
    // Tabs with working agents: "N working" moves left of the bell, clear of the title and the pill.
    pod_nav_init(&N);
    pod_model_turn(&M, "k1", "started", NULL, 0, 10);
    pod_model_turn(&M, "k2", "started", NULL, 0, 10);
    render(1000);
    const ht_run_t *wk = find_text("2 working");
    CHECK(wk);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x1f63d1) && S.runs[i].x > 500 && S.runs[i].y < POD_STATUS_H)
            CHECK(!overlap(ht_run_bounds(wk), ht_run_bounds(&S.runs[i])));
    CHECK(!overlap(ht_run_bounds(wk), ht_run_bounds(find_text("Tabs"))) && wk->x + ht_pro_width(&ht_pro_24, "2 working") <= 620);
    pod_model_turn(&M, "k1", "done", NULL, 0, 20);
    pod_model_turn(&M, "k2", "done", NULL, 0, 20);

    // Not drawn: on the Inbox itself, while talking, or with no cable.
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(1000);
    CHECK(!find_hit(POD_A_INBOX));
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0);
    render(1000);
    CHECK(find_hit(POD_A_INBOX) != NULL);   // the Agent / Recap screens have the bar and the bell
    pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
    CHECK(N.stack[N.depth - 1].view == POD_V_TALK);
    render(1000);
    CHECK(!find_hit(POD_A_INBOX));
    pod_nav_init(&N);
    pod_model_link(&M, false);
    render(1000);
    CHECK(!find_hit(POD_A_INBOX));
    pod_model_link(&M, true);
}

static void test_inbox(void) {
    build();
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(1000);
    CHECK(find_text("Inbox") && find_text("Inbox")->y < POD_STATUS_H && find_text("No notifications") && find_hit(POD_A_BACK));
    CHECK(pod_scroll_pitch(&N) == 84 && pod_scroll_max(&N, &M) == 0);
    pod_nav_init(&N);
    pod_model_unread_add(&M, "k0", "firmware-pro", "Fixed the cable resync. Tests pass on the host and the device, and the frame time is back under forty five milliseconds.", 134, 1000);
    pod_model_unread_add(&M, "k2", "backend", "Migration ran.", 20, 61000);     // newer
    pod_model_unread_add(&M, "zz", "stranger", "From a machine this roster does not hold.", -1, 62000);
    pod_nav_act(&N, &M, POD_A_INBOX, 0, 0);
    render(3600 * 1000 + 1000);
    const ht_run_t *a = find_text("stranger"), *b = find_text("backend"), *c = find_text("firmware-pro");
    CHECK(a && b && c && a->y == 54 + 8 && b->y == 54 + 84 + 8 && c->y == 54 + 2 * 84 + 8);   // newest first, 84 px rows from the bar
    CHECK(a->pro_font == &ht_pro_32 && a->x == 118);
    const ht_run_t *line = find_text("Fixed the cable");
    CHECK(line && line->pro_font == &ht_pro_24 && line->y == c->y + 38 && line->x == 118);
    // Ages on the right in grey: now / 1h / ...
    CHECK(find_text("1h") && find_text("1h")->y == c->y + 22 && find_text("59m") != NULL);
    CHECK(find_text("1h")->x > 600);
    // A blue dot per row at the left, and the rows' hits name their agent.
    int dots = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x1f63d1) && S.runs[i].x < 60 && S.runs[i].y > POD_STATUS_H) dots++;
    CHECK(dots == 3);
    int rows = 0;
    for (int i = 0; i < F.hit_count; i++)
        if (F.hits[i].action == POD_A_OPEN_NOTIF) {
            CHECK(F.hits[i].arg == rows && F.hits[i].y == 54 + rows * 84 && F.hits[i].h == 84 && F.hits[i].id[0]);
            rows++;
        }
    CHECK(rows == 3 && find_hit(POD_A_OPEN_NOTIF) && !strcmp(find_hit(POD_A_OPEN_NOTIF)->id, "k0"));   // the last row is the oldest
    // 16 entries: 7 rows, scrolled by rows; the last offset shows the last 7.
    for (int i = 0; i < 8; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "More.", 3, 70000 + (uint32_t)i);
    for (int i = 0; i < 8; i++) { char id[8]; snprintf(id, sizeof id, "x%d", i); pod_model_unread_add(&M, id, id, "Filler.", 3, 71000 + (uint32_t)i); }
    CHECK(M.unread_count == 16 && pod_scroll_max(&N, &M) == 9);
    render(80000);
    rows = 0;
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == POD_A_OPEN_NOTIF) rows++;
    CHECK(rows == 7 && find_text("x7") && !find_text("x0"));
    pod_nav_act(&N, &M, POD_A_SCROLL, 9, 0);
    render(80000);
    CHECK(find_text("x0") == NULL && find_text("Filler.") == NULL && find_text("More.") != NULL);
    // Constant run counts across frames (the age text changes, the structure does not).
    int n0 = 0;
    for (uint32_t t = 80000; t < 80000 + 7000; t += 733) { render(t); if (!n0) n0 = S.count; CHECK(S.count == n0); }
}

static void test_banner(void) {
    build();
    pod_model_unread_add(&M, "k0", "firmware-pro", "Fixed the cable resync. Tests pass on the host and the device, frame time back under 45 ms, and the long summary goes on well past two lines of the card.", 134, 5000);
    render_with(5000, "k0");
    const pod_hit_t *h = find_hit(POD_A_BANNER);
    CHECK(h && h->x == 16 && h->y == POD_STATUS_H + 12 && h->w == 688 && !strcmp(h->id, "k0"));
    CHECK(h->y + h->h < 300 && F.hits[F.hit_count - 1].action == POD_A_BANNER);   // last = on top
    // Everything of the card sits inside its 16 px margins and under the status bar.
    int card = -1;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0xffffff) && ht_run_bounds(&S.runs[i]).w == 686) card = i;
    CHECK(card > 0);
    for (int i = card - 1; i < S.count; i++) {
        ht_rect_t b = ht_run_bounds(&S.runs[i]);
        CHECK(b.x >= 16 && b.x + b.w <= 704 && b.y >= POD_STATUS_H + 12 && b.y + b.h <= h->y + h->h);
    }
    const ht_run_t *name = find_text("firmware-pro"), *age = find_text("now"), *done = find_text("Done");
    CHECK(name && name->pro_font == &ht_pro_32 && name->fg == ht_rgb(0x111111));
    CHECK(age && age->pro_font == &ht_pro_24 && age->fg == ht_rgb(0x7b7d84) && age->x > 500);
    CHECK(done && done->fg == ht_rgb(0x34c759) && !strcmp(done->text, "Done \xc2\xb7 2m 14s"));
    const ht_run_t *r1 = find_text("Fixed the cable"), *r2 = NULL;
    for (int i = 0; i < S.count; i++) if (&S.runs[i] != r1 && S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x333333)) r2 = &S.runs[i];
    CHECK(r1 && r2 && r1->fg == ht_rgb(0x333333) && r2->y == r1->y + ht_pro_24.height && strstr(r2->text, "..."));   // two lines, the second cut
    CHECK(name->y < r1->y && r2->y < done->y);
    const int tall = h->h;
    // Short recap: one line, no elapsed time -> a bare "Done"; the card shrinks.
    pod_model_unread_add(&M, "k1", "dial-ota", "Fast fix.", -1, 5000);
    render_with(5000, "k1");
    CHECK(find_text("Done") && !strcmp(find_text("Done")->text, "Done") && find_hit(POD_A_BANNER)->h < tall);
    // It covers whatever is under it: a Tab list's first rows, and its hits come last.
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render_with(5000, "k0");
    CHECK(F.hits[F.hit_count - 1].action == POD_A_BANNER && find_hit(POD_A_OPEN_AGENT) != NULL);
    // Not drawn when the hit list is full: the banner still gets its hit.
    F.hit_count = 32;
    render_with(5000, "k0");
    CHECK(F.hits[F.hit_count - 1].action == POD_A_BANNER);
}

// The busiest screens with the bell and the banner on top: within HT_RUNS, and the same count at every animation frame.
static void test_budget(void) {
    build();
    for (int i = 0; i < 8; i++) pod_model_turn(&M, ids[i], "started", NULL, 0, 10);
    pod_model_turn(&M, "k0", "activity", "Editing touch_gt911.c \xe2\x80\x94 turning the touch the same way as the panel", 134, 10);
    pod_model_turn(&M, "k0", "step", "Read \xc2\xb7 pod_glue.c", 134, 10);
    pod_model_turn(&M, "k0", "step", "Edit \xc2\xb7 pod_nav.c", 134, 10);
    pod_model_question(&M, "k2", "Run the migration on the dev database now? It touches every table in the schema.");
    pod_model_turn(&M, "k5", "done", NULL, 0, 20);
    pod_model_recap(&M, "k5", "The Relaxing chip now follows Rest until you pick a row for it. Rest reads Idle, so the two are not confused. All 54 pet settings tests pass. Nothing is committed yet. More words follow here so the Recap screen scrolls past its first page and fills every row it has.", false);
    for (int i = 0; i < 16; i++) {
        char id[8], text[64];
        snprintf(id, sizeof id, i < 8 ? "k%d" : "x%d", i);
        snprintf(text, sizeof text, "Summary number %d, with some words.", i);
        pod_model_unread_add(&M, id, NAMES[i % 8], text, 60 + i, 5000 + (uint32_t)i);
    }
    const char *banner_for = "k3";
    for (int s = 0; s < 8; s++) {
        pod_nav_init(&N);
        switch (s) {
        case 0: break;                                                          // Tabs
        case 1: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); break;               // a tab of 8 rows
        case 2: pod_nav_act(&N, &M, POD_A_OPEN_TAB, POD_TAB_RECENT, 0); break;  // Recent
        case 3: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0); break;   // working, with steps
        case 4: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 2, 0); break;   // asking
        case 5: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 5, 0); break;   // a long recap
        case 6: pod_nav_act(&N, &M, POD_A_INBOX, 0, 0); break;                  // the Inbox, 7 rows
        case 7: pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0); pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 0, 0); pod_nav_act(&N, &M, POD_A_TALK, 0, 0); break;
        }
        int first = -1, firstb = -1;
        for (uint32_t t = 20000; t < 20000 + 4000; t += 130) {
            render(t);
            if (first < 0) first = S.count;
            CHECK(S.count == first || s == 3 || s == 4 || s == 5 || s == 7);   // pets and the clocks animate runs on some screens
            render_with(t, banner_for);
            bool talking = N.stack[N.depth - 1].view == POD_V_TALK;
            if (!talking) {   // the glue never draws the banner over a recording; the budget still holds if it did
                if (firstb < 0) firstb = S.count;
                CHECK(S.count == firstb || s == 3 || s == 4 || s == 5);
            }
        }
    }
}

// The Tabs grid picks its detail by what fits: with the bell and the banner it must still fit (and drop detail, not runs).
static void test_budget_tabs(void) {
    build();
    cable_swarm_t many[12];
    const char *const *lists[12];
    uint8_t counts[12];
    memset(many, 0, sizeof many);
    for (int i = 0; i < 12; i++) {
        snprintf(many[i].id, SWARM_ID_MAX, "m%d", i);
        snprintf(many[i].name, CABLE_NAME_MAX, "Tab number %d", i);
        many[i].panes = many[i].agents = 8;
        lists[i] = idp;
        counts[i] = 8;
    }
    pod_model_swarms(&M, many, lists, counts, 12, "m0", NULL, 0);
    for (int i = 0; i < 8; i++) pod_model_turn(&M, ids[i], "started", NULL, 0, 10);
    for (int i = 0; i < 8; i++) pod_model_unread_add(&M, ids[i], NAMES[i], "Done.", 5, 5000 + (uint32_t)i);
    for (int page = 0; page < 3; page++) {
        pod_nav_init(&N);
        pod_nav_act(&N, &M, POD_A_SCROLL, page * 2, 0);
        for (uint32_t t = 20000; t < 21200; t += 300) { render(t); render_with(t, "k3"); }
    }
}

int main(void) {
    test_bell();
    test_inbox();
    test_banner();
    test_budget();
    test_budget_tabs();
    printf("test_pod_views_inbox: %d checks ok (most runs with the bell and a banner: %d of %d)\n", checks, max_runs, HT_RUNS);
    return 0;
}
