// The screen drawn from the model: the run budget, every run inside its column, the hit areas, the empty states,
// what each lane says, and the clock that redraws it.
#include "max_test.h"

enum { K_TEXT = 1, K_RECT_AA = 4 };
static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};

// Columns: the rail, three lanes, the Talk slot. A run lies in exactly one, or in the band under the lanes.
static void check_columns(void)
{
    static const int edge[] = {0, MAX_LANE_X, MAX_LANE_X + MAX_LANE_W, MAX_LANE_X + 2 * MAX_LANE_W, MAX_TALK_X, HT_WIDTH};
    for (int i = 0; i < S.count; i++) {
        const ht_rect_t b = ht_run_bounds(&S.runs[i]);
        CHECK(b.x >= 0 && b.y >= 0 && b.x + b.w <= HT_WIDTH && b.y + b.h <= HT_HEIGHT);
        if (b.y >= MAX_BAND_Y) {   // the page dots and the notice: under the lanes
            CHECK(b.x >= MAX_LANE_X && b.x + b.w <= MAX_TALK_X);
            continue;
        }
        bool inside = false;
        for (int c = 0; c + 1 < (int)(sizeof edge / sizeof edge[0]); c++)
            inside |= b.x >= edge[c] && b.x + b.w <= edge[c + 1];
        if (!inside) fprintf(stderr, "run %d (%d,%d %dx%d) \"%s\" crosses a column\n", i, b.x, b.y, b.w, b.h, S.runs[i].text);
        CHECK(inside);
        CHECK(b.y + b.h <= MAX_BAND_Y);
    }
}
static int max_runs;
static void check_budget(void)
{
    CHECK(S.count < HT_RUNS);   // below the cap: no run was refused
    if (S.count > max_runs) max_runs = S.count;
}

static void long_lanes(void)
{
    const pro_agent_row_t rows[] = {
        {"a", "an-agent-name-that-is-far-too-long-for-one", "claude", "m1", "A machine with a long name"},
        {"b", "Tr\xe1\xbb\xa3 l\xc3\xbd ti\xe1\xba\xbfng Vi\xe1\xbb\x87t", "codex", "m2", "M\xc3\xa1y ch\xe1\xbb\xa7"},
        {"c", "c", "claude", "m1", "MacBook Pro"}, {"d", "d", "claude", "m1", "MacBook Pro"}};
    max_ui_agents(rows, 4, 0);
}
static const char *LONG_TEXT = "Editing the touch driver so that the panel and the finger agree on which way is up, "
    "then running every host test again before the build, because a rotated panel hides its mistakes well";
static const char *VIET_TEXT = "\xc4\x90\xc3\xa2y l\xc3\xa0 m\xe1\xbb\x99t c\xc3\xa2u ti\xe1\xba\xbfng Vi\xe1\xbb\x87t "
    "d\xc3\xa0i \xc4\x91\xe1\xbb\x83 xem ch\xe1\xbb\xaf c\xc3\xb3 d\xe1\xba\xa5u v\xe1\xba\xabn v\xe1\xba\xbd \xc4\x91\xc3\xban "
    "v\xc3\xa0 c\xe1\xba\xaft \xc4\x91\xc3\xban ch\xe1\xbb\x97 khi h\xe1\xba\xbft ch\xe1\xbb\x97 tr\xc3\xaan l\xc3\xa0n";

static void working(const char *id, const char *text, uint32_t now)
{
    max_ui_turn(id, "started", "", 0, now);
    max_ui_turn(id, "verb", "Infusing...", -1, now);
    max_ui_turn(id, "activity", text, 134, now);
    max_ui_turn(id, "step", "Read \xc2\xb7 main/display/touch_gt911.c with a long path that runs on and on", -1, now);
    max_ui_turn(id, "step", "Edit \xc2\xb7 main/display/pro_display.c", -1, now);
    max_ui_turn(id, "step", "Bash \xc2\xb7 bash devices/harness-max/firmware/test/run.sh --and-more-flags", -1, now);
}

static void test_budget_three_full_lanes(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    cable_machine_t m[CABLE_MAX_MACHINES];
    for (int i = 0; i < CABLE_MAX_MACHINES; i++) {
        m[i] = (cable_machine_t){.state = "ready", .local = i == 0};
        snprintf(m[i].id, sizeof m[i].id, "m%d", i + 1);
        snprintf(m[i].name, sizeof m[i].name, "Machine number %d with a long name", i + 1);
    }
    max_ui_machines(m, CABLE_MAX_MACHINES, "m1");
    pro_agent_row_t rows[MAX_AGENTS];
    char ids[MAX_AGENTS][8];
    for (int i = 0; i < MAX_AGENTS; i++) {
        snprintf(ids[i], sizeof ids[i], "x%d", i);
        rows[i] = (pro_agent_row_t){ids[i], "an-agent-name-that-is-far-too-long-for-one", "claude", "m1", "MacBook Pro"};
    }
    max_ui_agents(rows, MAX_AGENTS, 0);
    for (int i = 0; i < 3; i++) working(ids[i], i == 1 ? VIET_TEXT : LONG_TEXT, 0);
    max_ui_focus("x1");
    max_ui_notice("Sent to an-agent-name-that-is-far-too-long-for-one", 3000, 0);
    max_ui_talk(MAX_TALK_RECORDING);
    render(1000);
    check_budget();
    check_columns();
    // Questions and failures fill a lane with text rows instead.
    for (int i = 0; i < 3; i++) {
        if (i == 2) max_ui_turn(ids[i], "error", LONG_TEXT, 0, 0);
        else max_ui_question(ids[i], "r", i ? VIET_TEXT : LONG_TEXT, 0);
    }
    max_ui_notice(NULL, 0, 0);
    render(1000);
    check_budget();
    check_columns();
    printf("test_max_view: at most %d runs of %d on a full screen\n", max_runs, HT_RUNS);
}

static void test_hit_areas(void)
{
    linked(ABCDE, 5);
    max_ui_focus("a");
    render(0);
    CHECK(max_m.lane_hits == 3 && max_m.talk_hit);
    for (int i = 0; i < max_m.lane_hits; i++) {
        const max_box_t b = max_m.lane_box[i];
        CHECK(b.w >= 80 && b.h >= 80);
        CHECK(b.x >= MAX_LANE_X + i * MAX_LANE_W && b.x + b.w <= MAX_LANE_X + (i + 1) * MAX_LANE_W);
    }
    CHECK(!strcmp(max_m.lane_id[0], "a") && !strcmp(max_m.lane_id[2], "c"));
    CHECK(max_m.talk_box.w >= 80 && max_m.talk_box.h >= 80 && max_m.talk_box.x >= MAX_TALK_X);
    check_columns();
    max_ui_focus("e");
    render(0);
    CHECK(max_m.lane_hits == 2 && !strcmp(max_m.lane_id[0], "d") && !strcmp(max_m.lane_id[1], "e"));
    check_columns();
}

static void test_empty_states(void)
{
    max_ui_reset();
    render(0);
    CHECK(text_run("Not connected") != NULL);
    CHECK(max_m.lane_hits == 0 && !max_m.talk_hit);
    max_ui_link(true, "MacBook Pro", 0);
    render(0);
    const ht_run_t *none = text_run("No agents");
    CHECK(none && none->x >= MAX_LANE_X && none->x + none->w <= MAX_TALK_X);
    CHECK(text_run("MacBook Pro") != NULL && text_run("Not connected") == NULL);
    CHECK(max_m.lane_hits == 0 && !max_m.talk_hit);
}

static void test_lanes_say_their_state(void)
{
    linked(ABCDE, 5);
    working("a", "Editing touch_gt911.c", 0);
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_question("b", "r", "Run the migration on the dev database now?", 0);
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_turn("c", "error", "pnpm test exited with 1", 0, 61000);
    render(61000);
    // Asking and failed lead, working follows.
    CHECK(!strcmp(max_m.lane_id[0], "b") && !strcmp(max_m.lane_id[1], "c") && !strcmp(max_m.lane_id[2], "a"));
    CHECK(text_run("Asks") && text_run("Run the migration"));
    const ht_run_t *failed = text_run("Failed"), *err = text_run("pnpm test exited with 1");
    CHECK(failed && failed->fg == ht_rgb(HT_THEME_FAILED) && err && err->fg == ht_rgb(HT_THEME_ERROR));
    CHECK(text_run("1:01") != NULL);   // the failed turn's length, stopped
    CHECK(text_run("Infusing") && text_run("Editing touch_gt911.c") && text_run("Edit \xc2\xb7 main/display/pro_d"));
    CHECK(text_run("claude \xc2\xb7 MacBook Pro") != NULL);
    CHECK(text_run("2:14") == NULL && text_run("3:15") != NULL);   // 134 s at 0, then 61 s more
    // Done: the summary shows, then runs out; the lane says Done.
    max_ui_summary("a", "Fixed the touch rotation", NULL, false, POD_TIER_ALERT, 70000);
    render(70000);
    CHECK(text_run("Done") && text_run("Fixed the touch rotation"));
    render(70000 + MAX_DONE_MS);
    CHECK(text_run("Done") && !text_run("Fixed the touch rotation"));
    max_ui_focus("d");
    render(70000 + MAX_DONE_MS);
    CHECK(text_run("Idle") != NULL);
}

static void test_selected_lane(void)
{
    linked(ABCDE, 5);
    max_ui_focus("b");
    render(0);
    const max_box_t sel = max_m.lane_box[1];
    int accent = 0, elsewhere = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_RECT_AA || r->fg != ht_rgb(HT_THEME_ACCENT) || r->w < 200) continue;
        if (r->x == sel.x && r->y == sel.y && r->w == sel.w && r->pro_height == sel.h) accent++;
        else if (r->x < MAX_TALK_X) elsewhere++;
    }
    CHECK(accent == 1 && elsewhere == 0);
    CHECK(text_run("Talk") != NULL && text_run("Tap a lane") == NULL);
}

static void test_names_and_text_fit(void)
{
    linked(NULL, 0);
    long_lanes();
    working("a", LONG_TEXT, 0);
    working("b", VIET_TEXT, 0);
    render(0);
    check_columns();
    const ht_run_t *name = text_run("an-agent-name");
    CHECK(name && name->w <= MAX_LANE_W - 2 * (MAX_INSET + MAX_PAD));
    CHECK(!strcmp(name->text + strlen(name->text) - 3, "\xe2\x80\xa6"));
    // A paragraph's last row ends between words, with nothing dangling before the ellipsis: whatever the text.
    static const char *const LONG_WORDS = "Reconfiguring the internationalization and synchronization of the "
        "documentation infrastructure, then reconsidering the characterization of every administration";
    for (int shift = 0; shift < 24; shift++) {
        char source[400];
        snprintf(source, sizeof source, "%.*s%s", shift % 12, "Wwwwwwwwwwww", shift < 12 ? LONG_TEXT : LONG_WORDS);
        max_ui_turn("a", "activity", source, -1, 0);
        render(0);
        int last = -1;
        for (int i = 0; i < S.count; i++)
            if (S.runs[i].pro_font == &ph_rg_28 && S.runs[i].x < MAX_LANE_X + MAX_LANE_W) last = i;
        char row[HT_TEXT_BYTES];
        snprintf(row, sizeof row, "%s", S.runs[last].text);
        const size_t len = strlen(row);
        CHECK(len > 4 && !strcmp(row + len - 3, "\xe2\x80\xa6"));
        row[len - 3] = 0;
        const char *at = strstr(source, row);
        CHECK(at && row[len - 4] != ' ' && row[len - 4] != ',' && strchr(" ,", at[len - 3]));
    }
    // Vietnamese draws as itself: no fallback, no cut.
    const char *viet = max_find("b")->name;
    const ht_run_t *vn = text_run("Tr\xe1\xbb\xa3 l\xc3\xbd");
    CHECK(vn && !strcmp(vn->text, viet));
    char shown[HT_TEXT_BYTES];
    CHECK(ht_display_text_ex(shown, sizeof shown, viet, vn->pro_font) && !strcmp(shown, viet));
    CHECK(text_run("\xc4\x90\xc3\xa2y l\xc3\xa0 m\xe1\xbb\x99t") != NULL);
    CHECK(text_run("M\xc3\xa1y ch\xe1\xbb\xa7") != NULL);
}

static void test_talk_slot(void)
{
    linked(ABCDE, 5);
    render(0);
    CHECK(text_run("Talk") && text_run("Tap a lane"));
    max_ui_focus("c");
    render(0);
    CHECK(text_run("Talk") && !text_run("Tap a lane"));
    max_ui_talk(MAX_TALK_RECORDING);
    render(0);
    CHECK(text_run("Listening") && !text_run("Talk"));
    max_ui_talk(MAX_TALK_SENDING);
    render(0);
    CHECK(text_run("Sending") && !text_run("Listening"));
    CHECK(max_m.talk_hit);
}

static void test_pages_and_notice(void)
{
    linked(ABCDE, 5);
    render(0);
    int dots = 0, lit = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->y < MAX_BAND_Y || r->pro_kind != K_RECT_AA) continue;
        dots++;
        lit += r->fg == ht_rgb(HT_THEME_ACCENT);
    }
    CHECK(dots == 2 && lit == 1);
    max_ui_notice("Sent to b", 3000, 0);
    render(0);
    const ht_run_t *n = text_run("Sent to b");
    CHECK(n && n->y >= MAX_BAND_Y);
    check_columns();
    render(3000);
    CHECK(!text_run("Sent to b"));
    roster(ABCDE, 3);
    render(3000);
    for (int i = 0; i < S.count; i++) CHECK(S.runs[i].y < MAX_BAND_Y);   // one page: no dots
}

static void test_update_screen(void)
{
    linked(ABCDE, 5);
    max_ui_update(40, "0.9.0");
    render(0);
    CHECK(text_run("Updating") && text_run("40%") && text_run("0.9.0"));
    CHECK(max_m.lane_hits == 0 && !max_m.talk_hit);
    CHECK(S.count < HT_RUNS);
}

static void test_clock(void)
{
    // A working lane on the page shown: a redraw every second, on the second.
    linked(ABCDE, 5);
    max_ui_turn("a", "started", "", 0, 1000);
    render(1000);
    CHECK(!max_ui_tick(1999) && max_ui_tick(2000));
    CHECK(max_ui_next_wake_ms(1000) == 1000 && max_ui_next_wake_ms(1500) == 500);
    // Nothing timed on the page: the longest sleep, no redraw.
    linked(ABCDE, 5);
    render(0);
    CHECK(max_ui_next_wake_ms(0) == MAX_WAKE_MS && !max_ui_tick(500000));
    // A notice and a summary run out.
    max_ui_notice("Sent", 3000, 0);
    render(0);
    CHECK(max_ui_next_wake_ms(0) == 3000 && !max_ui_tick(2999) && max_ui_tick(3000));
    max_ui_summary("b", "Done it", NULL, false, POD_TIER_ALERT, 4000);
    render(4000);
    CHECK(max_ui_next_wake_ms(4000 + MAX_DONE_MS - 10) == 10 && max_ui_tick(4000 + MAX_DONE_MS));
    // A clock on another page wakes nothing.
    linked(ABCDE, 5);
    for (int i = 0; i < 3; i++) max_ui_question(ABCDE[i], "r", "?", 0);
    max_ui_turn("d", "started", "", 0, 0);
    render(0);
    CHECK(max_ui_next_wake_ms(0) == MAX_WAKE_MS && !max_ui_tick(5000));
}

int main(void)
{
    test_budget_three_full_lanes();
    test_hit_areas();
    test_empty_states();
    test_lanes_say_their_state();
    test_selected_lane();
    test_names_and_text_fit();
    test_talk_slot();
    test_pages_and_notice();
    test_update_screen();
    test_clock();
    printf("test_max_view: %d checks passed\n", checks);
    return 0;
}
