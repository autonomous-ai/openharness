// The screen drawn from the model: the run budget, every run inside its column, the hit areas, the empty states,
// what each lane says, and the clock that redraws it.
#include "max_test.h"

enum { K_TEXT = 1, K_RECT_AA = 4 };
static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};

// Columns: the rail, the lanes as drawn (three equal, or an open card and its narrow neighbours; one sheet when New
// Harness is up), the Talk slot. A run lies in exactly one, or in the band under the lanes.
static void check_columns(void)
{
    int edge[MAX_LANES + 4], edges = 0;
    edge[edges++] = 0;
    edge[edges++] = MAX_LANE_X;
    for (int i = 0; i + 1 < max_m.lane_hits; i++) edge[edges++] = max_m.lane_box[i].x + max_m.lane_box[i].w + MAX_INSET;
    edge[edges++] = MAX_TALK_X;
    edge[edges++] = HT_WIDTH;
    for (int i = 0; i < S.count; i++) {
        const ht_rect_t b = ht_run_bounds(&S.runs[i]);
        CHECK(b.x >= 0 && b.y >= 0 && b.x + b.w <= HT_WIDTH && b.y + b.h <= HT_HEIGHT);
        if (b.y >= MAX_BAND_Y) {   // the page dots and the notice: under the lanes
            CHECK(b.x >= MAX_LANE_X && b.x + b.w <= MAX_TALK_X);
            continue;
        }
        bool inside = false;
        for (int c = 0; c + 1 < edges; c++)
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
    // A question's card and its narrow neighbours, with their words cut to their columns.
    for (int i = 0; i < 3; i++) {
        if (i == 2) max_ui_turn(ids[i], "error", LONG_TEXT, 0, 0);
        else max_ui_question(ids[i], "r", i ? VIET_TEXT : LONG_TEXT, NULL, 0, false, false, 0);
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
    render(0);
    CHECK(text_run("Infusing") && text_run("Editing touch_gt911.c") && text_run("Edit \xc2\xb7 main/display/pro_d"));
    CHECK(text_run("claude \xc2\xb7 MacBook Pro") != NULL && text_run("2:14") != NULL);
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_question("b", "r", "Run the migration on the dev database now?", NULL, 0, false, false, 0);
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_turn("c", "error", "pnpm test exited with 1", 0, 61000);
    render(61000);
    // Asking and failed lead, working follows. The question's card is open; beside it each lane keeps its state and clock.
    CHECK(!strcmp(max_m.lane_id[0], "b") && !strcmp(max_m.lane_id[1], "c") && !strcmp(max_m.lane_id[2], "a"));
    CHECK(!strcmp(max_m.card_id, "b") && text_run("Asks") && text_run("Run the migration"));
    CHECK(max_m.lane_box[1].w == MAX_NARROW_W - 2 * MAX_INSET && max_m.lane_box[2].w == MAX_NARROW_W - 2 * MAX_INSET);
    const ht_run_t *failed = text_run("Failed");
    CHECK(failed && failed->fg == ht_rgb(HT_THEME_FAILED));
    CHECK(text_run("1:01") != NULL);   // the failed turn's length, stopped
    CHECK(text_run("Infusing") && !text_run("Editing touch_gt911.c"));
    CHECK(text_run("2:14") == NULL && text_run("3:15") != NULL);   // 134 s at 0, then 61 s more
    check_columns();
    // The failed lane, selected, opens its card: the error in full.
    max_ui_focus("c");
    render(61000);
    const ht_run_t *err = text_run("pnpm test exited with 1");
    CHECK(!strcmp(max_m.card_id, "c") && err && err->fg == ht_rgb(HT_THEME_ERROR) && text_run("Dismiss"));
    check_columns();
    // Done: the summary's card shows, then runs out; the lane says Done.
    max_ui_summary("a", "Fixed the touch rotation", NULL, false, POD_TIER_ALERT, 70000);
    max_ui_focus("a");
    render(70000);
    CHECK(!strcmp(max_m.card_id, "a") && text_run("Done") && text_run("Fixed the touch rotation"));
    render(70000 + MAX_DONE_MS);
    CHECK(strcmp(max_m.card_id, "a") && text_run("Done") && !text_run("Fixed the touch rotation"));
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
    for (int i = 0; i < 3; i++) max_ui_question(ABCDE[i], "r", "?", NULL, 0, false, false, 0);
    max_ui_turn("d", "started", "", 0, 0);
    render(0);
    CHECK(max_ui_next_wake_ms(0) == MAX_WAKE_MS && !max_ui_tick(5000));
}

// ---- cards and New Harness ----

static const max_hit_t *find_hit(max_hit_kind_t kind, int arg)
{
    for (int i = 0; i < max_m.hit_count; i++)
        if (max_m.hits[i].kind == kind && max_m.hits[i].arg == arg) return &max_m.hits[i];
    return NULL;
}
static int hits_of(max_hit_kind_t kind)
{
    int n = 0;
    for (int i = 0; i < max_m.hit_count; i++) n += max_m.hits[i].kind == kind;
    return n;
}
// Every button a finger's size (80 px at 480, scaled with the glass), inside `box`, and none over another.
static void check_hits(max_box_t box)
{
    CHECK(max_m.hit_count > 0 && max_m.hit_count < MAX_HITS);
    for (int i = 0; i < max_m.hit_count; i++) {
        const max_hit_t *h = &max_m.hits[i];
        CHECK(h->w >= 80 && h->h >= MAX_Y(80) && h->h >= 69);
        if (h->kind == MAX_HIT_NEW) continue;   // on the rail
        CHECK(h->x >= box.x && h->y >= box.y && h->x + h->w <= box.x + box.w && h->y + h->h <= box.y + box.h);
        for (int j = 0; j < i; j++) {
            const max_hit_t *o = &max_m.hits[j];
            CHECK(h->x >= o->x + o->w || o->x >= h->x + h->w || h->y >= o->y + o->h || o->y >= h->y + h->h);
        }
    }
}
// A text run inside the hit area h.
static const ht_run_t *label_on(const max_hit_t *h)
{
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_TEXT && r->x >= h->x && r->x + r->w <= h->x + h->w && r->y >= h->y && r->y < h->y + h->h)
            return r;
    }
    return NULL;
}
// A filled rect exactly over the hit area h, in rgb.
static bool filled(const max_hit_t *h, unsigned rgb)
{
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT_AA && r->x == h->x && r->y == h->y && r->w == h->w && r->fg == ht_rgb(rgb)) return true;
    }
    return false;
}
static bool form_failed(void) { return max_m.form.failed; }
static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;
static int take(uint32_t now) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, now); }

// The question read whole, as the daemon answers question.read.
static void asked(const char *id, const pro_ask_item_t *items, int n, bool permission)
{
    max_ui_question(id, "toolu_1", items[0].q, items, n, permission, true, 0);
    take(0);
    max_ui_question_state(id, max_ask_of(id)->fetch, true, "toolu_1", "tok", false, NULL, items, n, 0);
}

static void test_question_card(void)
{
    linked(ABCDE, 3);
    static const pro_ask_item_t db = {"db", "Which database should the migration run on?", {"Dev", "Staging"}, 2, false,
                                      true};
    asked("b", &db, 1, false);
    render(0);
    // The asking lane leads as the wide card; the other two stand narrow beside it.
    CHECK(!strcmp(max_m.card_id, "b") && !strcmp(max_m.lane_id[0], "b") && max_m.lane_hits == 3);
    const max_box_t card = max_m.lane_box[0];
    CHECK(card.x == MAX_LANE_X + MAX_INSET && card.w == MAX_TALK_X - MAX_LANE_X - 2 * MAX_NARROW_W - 2 * MAX_INSET);
    CHECK(card.w >= 960 && max_m.lane_box[2].x + max_m.lane_box[2].w + MAX_INSET == MAX_TALK_X);
    check_columns();
    check_hits(card);
    CHECK(hits_of(MAX_HIT_OPTION) == 2 && !find_hit(MAX_HIT_SEND, 0) && !find_hit(MAX_HIT_STEP_BACK, 0));
    CHECK(!strcmp(label_on(find_hit(MAX_HIT_OPTION, 1))->text, "Staging"));
    CHECK(text_run("Which database should the migration run on?") && text_run("Asks"));
    // Six options: two rows of three, the question still over them.
    static const pro_ask_item_t board = {"board", "Which board?", {"ESP32-P4 Function EV", "Max rev A", "Max rev B",
                                         "Harness Pro", "Dial", "None of these"}, 6, false, true};
    asked("b", &board, 1, false);
    render(0);
    check_hits(card);
    CHECK(hits_of(MAX_HIT_OPTION) == 6 && find_hit(MAX_HIT_OPTION, 3)->y > find_hit(MAX_HIT_OPTION, 2)->y);
    CHECK(find_hit(MAX_HIT_OPTION, 0)->y == find_hit(MAX_HIT_OPTION, 2)->y && text_run("Which board?"));
    // Long words get more rows rather than a cut, the question keeping a line over them.
    static const pro_ask_item_t plan = {"plan", "The auth tests fail on the session table that the migration dropped. "
                                        "Should I restore it from the audit log, rebuild it, or stop here?",
                                        {"Restore it from the audit log and run the tests again",
                                         "Rebuild the table from scratch with an empty set of sessions",
                                         "Stop here and leave everything as it is"}, 3, false, true};
    asked("b", &plan, 1, false);
    render(0);
    check_hits(card);
    CHECK(find_hit(MAX_HIT_OPTION, 2)->y > find_hit(MAX_HIT_OPTION, 0)->y && text_run("The auth tests fail"));
    for (int i = 0; i < S.count; i++) CHECK(!strstr(S.runs[i].text, "\xe2\x80\xa6") || S.runs[i].y < find_hit(MAX_HIT_OPTION, 0)->y);
    CHECK(S.count < HT_RUNS);
}

static void test_permission_and_several_choices(void)
{
    linked(ABCDE, 3);
    static const pro_ask_item_t deploy = {"perm", "Approve Bash command: npm run deploy:staging",
                                          {"Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently"},
                                          3, false, true};
    asked("a", &deploy, 1, true);
    render(0);
    // The daemon's own words; the yes stands out, the no in the failure's colour.
    CHECK(text_run("Permission") && filled(find_hit(MAX_HIT_OPTION, 0), HT_THEME_ACCENT));
    CHECK(!filled(find_hit(MAX_HIT_OPTION, 1), HT_THEME_ACCENT));
    CHECK(label_on(find_hit(MAX_HIT_OPTION, 2))->fg == ht_rgb(HT_THEME_FAILED));
    check_hits(max_m.lane_box[0]);
    // Two questions, the second of several choices: Back and Send, Send live once something is chosen.
    static const pro_ask_item_t two[] = {{"branch", "Where should the fix go?", {"main", "release/0.9"}, 2, false, true},
                                         {"checks", "Which checks?", {"Lint", "Types", "Tests"}, 3, true, true}};
    asked("a", two, 2, false);
    render(0);
    CHECK(text_run("1 / 2") && !find_hit(MAX_HIT_STEP_BACK, 0));
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 1, 0);
    render(0);
    CHECK(text_run("2 / 2") && find_hit(MAX_HIT_STEP_BACK, 0) && !find_hit(MAX_HIT_SEND, 0) && text_run("Send"));
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 0, 0);
    render(0);
    const max_hit_t *send = find_hit(MAX_HIT_SEND, 0);
    CHECK(send && filled(send, HT_THEME_ACCENT) && text_run("\xe2\x9c\x93 Lint"));
    check_hits(max_m.lane_box[0]);
    // Sending: the choices stay drawn, and nothing can be pressed.
    max_ask_hit(max_find("a"), MAX_HIT_SEND, 0, 0);
    render(0);
    CHECK(max_m.hit_count == 0 && text_run("Sending"));
}

static void test_cards_without_buttons(void)
{
    linked(ABCDE, 3);
    // Shown only: where to answer it, and nothing to press.
    static const pro_ask_item_t shown = {"shown", "Allow Edit of src/auth/session.ts?", {"In Orca"}, 1, false, true};
    max_ui_question("a", "shown:toolu_1", shown.q, &shown, 1, true, true, 0);
    render(0);
    CHECK(text_run("Answer it in Orca") && text_run("Allow Edit of src/auth") && max_m.hit_count == 0);
    // Only the computer can answer it.
    max_ui_question("a", "toolu_2", "Proceed?", NULL, 0, false, true, 0);
    render(0);
    CHECK(text_run("Answer it on the computer") && max_m.hit_count == 0);
    // The reviewed path's failure: why, and Reload.
    static const pro_ask_item_t db = {"db", "Which database?", {"Dev", "Staging"}, 2, false, true};
    asked("a", &db, 1, false);
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 0, 0);
    take(0);
    max_ui_answer_receipt("a", max_ask_of("a")->fetch, "tok", false, false, "Question changed.", 0);
    render(0);
    const ht_run_t *why = text_run("Question changed.");
    CHECK(why && why->fg == ht_rgb(HT_THEME_ERROR) && find_hit(MAX_HIT_RELOAD, 0) && max_m.hit_count == 1);
    check_hits(max_m.lane_box[0]);
    // A failure's card and a summary's: their words, and Dismiss.
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_turn("b", "error", "pnpm test exited with 1", 0, 0);
    max_ui_focus("b");
    render(0);
    CHECK(!strcmp(max_m.card_id, "b") && find_hit(MAX_HIT_DISMISS, 0) && max_m.hit_count == 1);
    check_hits(max_m.lane_box[1]);
}

static void test_new_harness(void)
{
    linked(ABCDE, 3);
    render(0);
    CHECK(!find_hit(MAX_HIT_NEW, 0) && !text_run("New Harness"));
    // Offered: a button at the foot of the rail, under the machines.
    max_ui_offers(true);
    render(0);
    const max_hit_t *add = find_hit(MAX_HIT_NEW, 0);
    CHECK(add && add->x + add->w <= MAX_RAIL_W && add->y + add->h <= MAX_BAND_Y && add->h >= MAX_Y(80) && add->w >= 200);
    check_columns();
    // Open: the form over the lanes, the button held down, the Talk slot taking a spoken name.
    CHECK(max_ui_form_open("form-1", 0));
    render(0);
    CHECK(!find_hit(MAX_HIT_NEW, 0) && max_m.lane_hits == 0 && text_run("Opening"));
    CHECK(find_hit(MAX_HIT_FORM_CLOSE, 0) && !find_hit(MAX_HIT_FORM_PICK, 0) && !find_hit(MAX_HIT_FORM_BACK, 0));
    check_columns();
    take(0);
    const pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "~/work/harness",
                                  .previous = "backend", .next = "website", .error = "", .status = "",
                                  .action = "choose", .query = "", .revision = 7, .position = 2, .total = 5,
                                  .active = true, .enabled = true, .can_query = true};
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    render(0);
    const max_box_t sheet = {MAX_LANE_X, MAX_CARD_Y, MAX_TALK_X - MAX_LANE_X, MAX_CARD_H};
    check_hits(sheet);
    CHECK(find_hit(MAX_HIT_FORM_MOVE, -1) && find_hit(MAX_HIT_FORM_MOVE, 1) && hits_of(MAX_HIT_FORM_PICK) == 2);
    CHECK(text_run("harness-max-firmware") && text_run("2 / 5") && text_run("Choose") && text_run("backend"));
    CHECK(text_run("Say") && text_run("Find Project") && max_m.talk_hit && max_m.form_revision == 7);
    check_columns();
    // The desktop working: nothing but Close.
    take(0);
    max_form_command(MAX_FORM_ACTIVATE, 0, 0);
    render(0);
    CHECK(hits_of(MAX_HIT_FORM_PICK) == 0 && !find_hit(MAX_HIT_FORM_BACK, 0) && find_hit(MAX_HIT_FORM_CLOSE, 0));
    take(0);
    pro_form_page_t busy = page;
    busy.busy = true;
    busy.enabled = false;
    busy.status = "Starting\xe2\x80\xa6";
    busy.next = "";
    max_ui_form_state(OUT[0].fetch, "form-1", true, &busy, 0);
    render(0);
    CHECK(text_run("Wait") && text_run("Starting") && hits_of(MAX_HIT_FORM_PICK) == 0 && !find_hit(MAX_HIT_FORM_MOVE, 1));
    // Failed: why, and Retry.
    max_form_due(MAX_FORM_WAIT_MS + 1000);
    take(MAX_FORM_WAIT_MS + 1000);
    max_form_due(2 * MAX_FORM_WAIT_MS + 2000);
    render(0);
    CHECK(form_failed() && text_run("No reply. Check Harness on desktop.") && find_hit(MAX_HIT_FORM_RETRY, 0));
    check_hits(sheet);
    CHECK(S.count < HT_RUNS);
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
    test_question_card();
    test_permission_and_several_choices();
    test_cards_without_buttons();
    test_new_harness();
    printf("test_max_view: %d checks passed\n", checks);
    return 0;
}
