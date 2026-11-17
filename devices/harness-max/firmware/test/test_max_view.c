// The screen drawn from the model: the run budget, every run in its column and every word inside its box, the room
// and its card, Talk, the lanes, the toast, New Harness, the empty states, and what moves by the clock.
#include "max_test.h"
#include "max_ui_motion.h"

enum { K_TEXT = 1, K_RECT_AA = 4 };
static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
static const char *const SIX[] = {"a", "b", "c", "d", "e", "f"};
static const max_box_t RAIL = {MAX_RAIL_X, MAX_CARD_Y, MAX_RAIL_W, MAX_CARD_H};
static const max_box_t ROOM = {MAX_ROOM_X, MAX_CARD_Y, MAX_ROOM_W, MAX_CARD_H};
static const max_box_t SHEET = {MAX_ROOM_X, MAX_CARD_Y, MAX_LANE_X + MAX_LANES_W - MAX_ROOM_X, MAX_CARD_H};   // the form
static const max_box_t LANES = {MAX_LANE_X, 0, MAX_LANES_W, HT_HEIGHT};   // the lanes, and the toast over them

static bool within(ht_rect_t b, max_box_t o)
{
    return b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h;
}
static max_box_t box_of(const max_hit_t *h) { return (max_box_t){h->x, h->y, h->w, h->h}; }
static ht_rect_t rect_of(max_box_t b) { return (ht_rect_t){b.x, b.y, b.w, b.h}; }
static bool apart(max_box_t a, max_box_t b)
{
    return a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h;
}
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
// A text run inside the hit area h.
static const ht_run_t *label_on(const max_hit_t *h)
{
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_TEXT && within(ht_run_bounds(r), box_of(h))) return r;
    }
    return NULL;
}
// A filled rect exactly over the box b, in rgb.
static bool filled(max_box_t b, unsigned rgb)
{
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT_AA && r->x == b.x && r->y == b.y && r->w == b.w && r->pro_height == b.h &&
            r->fg == ht_rgb(rgb))
            return true;
    }
    return false;
}
// A run that covers the box b whole: the veil over what rests while a person talks.
static bool veiled(max_box_t b)
{
    for (int i = 0; i < S.count; i++) {
        const ht_rect_t r = ht_run_bounds(&S.runs[i]);
        if (within(rect_of(b), (max_box_t){r.x, r.y, r.w, r.h})) return true;
    }
    return false;
}

// Every run on the glass and in one column: the rail, the room (the form's sheet spans the lanes too), or the lanes.
static void check_columns(void)
{
    const int room_end = max_form_open() ? HT_WIDTH : MAX_ROOM_X + MAX_ROOM_W;
    for (int i = 0; i < S.count; i++) {
        const ht_rect_t b = ht_run_bounds(&S.runs[i]);
        CHECK(b.x >= 0 && b.y >= 0 && b.x + b.w <= HT_WIDTH && b.y + b.h <= HT_HEIGHT);
        const bool in = b.x + b.w <= MAX_ROOM_X || (b.x >= MAX_ROOM_X && b.x + b.w <= room_end) ||
                        b.x >= MAX_ROOM_X + MAX_ROOM_W;
        if (!in) fprintf(stderr, "run %d (%d,%d %dx%d) \"%s\" crosses a column\n", i, b.x, b.y, b.w, b.h, S.runs[i].text);
        CHECK(in);
    }
}
// Every word inside the box it belongs to: the rail, the room or the form's sheet, a lane, the toast, the notice's
// navy card over the lanes. While a person talks the lanes record no boxes: their words stay in the lanes' column.
static void check_words(void)
{
    const max_hit_t *toast = find_hit(MAX_HIT_TOAST, 0);
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_TEXT) continue;
        const ht_rect_t b = ht_run_bounds(r);
        bool in = within(b, RAIL) || within(b, max_form_open() ? SHEET : ROOM);
        for (int l = 0; l < max_m.lane_hits; l++) in |= within(b, max_m.lane_box[l]);
        if (toast) in |= within(b, box_of(toast));
        if (r->fg == ht_rgb(NAVY_INK) || max_m.talk != MAX_TALK_IDLE) in |= within(b, LANES);
        if (!in) fprintf(stderr, "word run %d (%d,%d %dx%d) \"%s\" outside its box\n", i, b.x, b.y, b.w, b.h, r->text);
        CHECK(in);
        CHECK(!strstr(r->text, "\xe2\x80\xa6\xe2\x80\xa6"));   // never cut after an ellipsis
    }
}
// Every button a finger's size (80 px at 480, scaled with the glass), inside `box`, and none over another. New Harness
// stands on the rail and the toast over the lanes.
static void check_hits(max_box_t box)
{
    CHECK(max_m.hit_count > 0 && max_m.hit_count < MAX_HITS);
    for (int i = 0; i < max_m.hit_count; i++) {
        const max_hit_t *h = &max_m.hits[i];
        if (h->kind == MAX_HIT_NEW || h->kind == MAX_HIT_TOAST) continue;
        CHECK(h->w >= 80 && h->h >= MAX_Y(80) && h->h >= 69);
        CHECK(within(rect_of(box_of(h)), box));
        for (int j = 0; j < i; j++)
            if (max_m.hits[j].kind != MAX_HIT_TOAST) CHECK(apart(box_of(h), box_of(&max_m.hits[j])));
    }
}
static int most_runs;
static void check_budget(void)
{
    CHECK(S.count < HT_RUNS);   // below the cap: no run was refused
    if (S.count > most_runs) most_runs = S.count;
}
// The colour of the room's outline: at rest, asking, or a person talking to it. 0: none of them.
static unsigned room_edge(void)
{
    static const unsigned EDGES[] = {EDGE, PEACH, YOU};
    for (size_t i = 0; i < sizeof EDGES / sizeof EDGES[0]; i++)
        if (filled(ROOM, EDGES[i])) return EDGES[i];
    return 0;
}

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
// A tap where nothing is drawn: a person at the bar from `at`.
static void touch_at(uint32_t at)
{
    max_ui_touch(true, HT_WIDTH - 2, HT_HEIGHT - 2, at);
    max_ui_touch(false, HT_WIDTH - 2, HT_HEIGHT - 2, at);
}
// A recording for the agent id ("" : the form's spoken name).
static void talk(const char *id, max_talk_t state)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, id);
    max_ui_talk(state);
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
}

static const pro_ask_item_t DB = {"db", "Which database should the migration run on?", {"Dev", "Staging"}, 2, false,
                                  true};
static const pro_ask_item_t DEPLOY = {"perm", "Approve Bash command: npm run deploy:staging",
                                      {"Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently"},
                                      3, false, true};

// The most one screen holds, at both glasses: every machine on the rail and New Harness; in the room a question of six
// options at its second step (Back and Send too) and its asking pet; four lanes at work in long words; the toast and the
// notice. Then the same while a person talks to the room's agent, its listening pet the busiest it plays.
static void test_budget(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    max_ui_offers(true);
    cable_machine_t m[CABLE_MAX_MACHINES];
    for (int i = 0; i < CABLE_MAX_MACHINES; i++) {
        m[i] = (cable_machine_t){.state = "ready", .local = i == 0};
        snprintf(m[i].id, sizeof m[i].id, "m%d", i + 1);
        snprintf(m[i].name, sizeof m[i].name, "Machine number %d with a long name", i + 1);
    }
    max_ui_machines(m, CABLE_MAX_MACHINES, "m1");
    static const char *const ENGINES[] = {"claude", "codex", "muse", "gemini"};
    pro_agent_row_t rows[MAX_AGENTS];
    char ids[MAX_AGENTS][8];
    for (int i = 0; i < MAX_AGENTS; i++) {
        snprintf(ids[i], sizeof ids[i], "x%d", i);
        rows[i] = (pro_agent_row_t){ids[i], "an-agent-name-that-is-far-too-long-for-one", ENGINES[i % 4], "m1",
                                    "Machine number 1 with a long name"};
    }
    max_ui_agents(rows, MAX_AGENTS, 0);
    for (int i = 1; i < 5; i++) working(ids[i], i == 2 ? VIET_TEXT : LONG_TEXT, 0);
    static const pro_ask_item_t two[] = {
        {"branch", "Where should the fix go?", {"main", "release/0.9"}, 2, false, true},
        {"board", "Which boards should the panel driver be flashed to before the release goes out?",
         {"ESP32-P4 Function EV", "Max rev A", "Max rev B", "Harness Pro", "Dial", "None of these"}, 6, true, true}};
    asked("x0", two, 2, false);
    max_ask_hit(max_find("x0"), MAX_HIT_OPTION, 0, 0);
    max_ask_hit(max_find("x0"), MAX_HIT_OPTION, 2, 0);
    max_ui_question("x5", "r", LONG_TEXT, NULL, 0, false, false, 0);
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "x5");
    max_m.toast_from = 0;
    max_ui_notice("Sent to an-agent-name-that-is-far-too-long-for-one", 3000, 0);
    render(1000);
    CHECK(!strcmp(max_ui_selected(), "x0") && max_m.lane_hits == MAX_LANES && find_hit(MAX_HIT_TOAST, 0));
    CHECK(find_hit(MAX_HIT_STEP_BACK, 0) && find_hit(MAX_HIT_SEND, 0) && hits_of(MAX_HIT_OPTION) == 6);
    check_budget();
    check_columns();
    check_words();
    for (int e = 0; e < 3; e++) {   // listening, for each engine with a pet
        max_copy(max_find("x0")->engine, sizeof max_find("x0")->engine, ENGINES[e]);
        talk("x0", MAX_TALK_RECORDING);
        render(1000);
        CHECK(text_run("Talking to") && find_hit(MAX_HIT_TALK_SEND, 0));
        check_budget();
        check_columns();
        check_words();
        talk("x0", MAX_TALK_IDLE);
    }
    printf("test_max_view: at most %d runs of %d on a full screen\n", most_runs, HT_RUNS);
}

// The room left of the lanes; the lanes right of it, sharing their width, a full page's width on every page.
static void test_room_and_lanes(void)
{
    linked(ABCDE, 5);
    render(0);
    CHECK(!strcmp(max_ui_selected(), "a") && max_m.lane_hits == MAX_LANES && room_edge() == EDGE);
    const int w = (MAX_LANES_W - (MAX_LANES - 1) * MAX_LANE_GAP) / MAX_LANES;
    for (int i = 0; i < max_m.lane_hits; i++) {
        const max_box_t b = max_m.lane_box[i];
        CHECK(b.x == MAX_LANE_X + i * (w + MAX_LANE_GAP) && b.w == w && b.y == MAX_CARD_Y && b.h == MAX_CARD_H);
        CHECK(b.x >= MAX_ROOM_X + MAX_ROOM_W && b.x + b.w <= MAX_LANE_X + MAX_LANES_W && apart(b, ROOM));
        CHECK(strcmp(max_m.lane_id[i], "a"));   // the room's agent is not a lane too
    }
    CHECK(!strcmp(max_m.card_id, "a") && max_m.card_key == max_card_key(max_find("a")));
    check_columns();
    check_words();
    // One lane takes the lanes' width; with only the room's agent there is none.
    linked(ABCDE, 2);
    render(0);
    CHECK(max_m.lane_hits == 1 && max_m.lane_box[0].w == MAX_LANES_W && !strcmp(max_m.lane_id[0], "b"));
    linked(ABCDE, 1);
    render(0);
    CHECK(max_m.lane_hits == 0 && text_run("a"));
    check_columns();
    // Five lanes: two pages, and the second page's lane as wide as the first page's.
    linked(SIX, 6);
    render(0);
    CHECK(max_pages() == 2 && max_m.lane_hits == MAX_LANES && max_m.lane_box[0].w == w);
    max_m.page = 1;
    render(0);
    CHECK(max_m.lane_hits == 1 && max_m.lane_box[0].x == MAX_LANE_X && max_m.lane_box[0].w == w);
    check_words();
}

// Talk: the room's pet and Tap to talk are one hit, only when its agent can take voice. While a person talks: Cancel
// and Send in the room, nothing else to press, the rest of the screen under a veil.
static void test_talk(void)
{
    linked(ABCDE, 5);
    render(0);
    const max_hit_t *t = find_hit(MAX_HIT_TALK, 0);
    CHECK(max_can_talk(max_find("a")) && t && within(rect_of(box_of(t)), ROOM));
    const ht_run_t *pill = text_run("Tap to talk");
    CHECK(pill && within(ht_run_bounds(pill), box_of(t)));
    CHECK(!find_hit(MAX_HIT_TALK_SEND, 0) && !find_hit(MAX_HIT_TALK_CANCEL, 0) && !veiled(LANES));
    check_hits(ROOM);
    // A permission prompt takes no voice, nor an answer on its way.
    asked("a", &DEPLOY, 1, true);
    render(0);
    CHECK(!max_can_talk(max_find("a")) && !find_hit(MAX_HIT_TALK, 0) && !text_run("Tap to talk"));
    asked("a", &DB, 1, false);
    render(0);
    CHECK(max_can_talk(max_find("a")) && find_hit(MAX_HIT_TALK, 0));
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 0, 0);
    render(0);
    CHECK(!max_can_talk(max_find("a")) && !find_hit(MAX_HIT_TALK, 0) && max_m.hit_count == 0);
    // Recording for the room's agent, with New Harness offered and a toast up: only Cancel and Send, in the room.
    linked(ABCDE, 5);
    max_ui_offers(true);
    touch_at(1000);
    max_ui_question("c", "r", "Deploy?", NULL, 0, false, false, 1000);
    talk("a", MAX_TALK_RECORDING);
    render(1000);
    CHECK(max_toast_shown(1000) && text_run("c asks"));
    CHECK(max_m.hit_count == 2 && find_hit(MAX_HIT_TALK_CANCEL, 0) && find_hit(MAX_HIT_TALK_SEND, 0));
    check_hits(ROOM);
    CHECK(max_m.lane_hits == 0 && !find_hit(MAX_HIT_TALK, 0) && !find_hit(MAX_HIT_NEW, 0) && !find_hit(MAX_HIT_TOAST, 0));
    CHECK(text_run("Talking to a") && text_run("Listening") && room_edge() == YOU);
    CHECK(veiled((max_box_t){0, 0, MAX_RAIL_X + MAX_RAIL_W, HT_HEIGHT}) && veiled(LANES));
    check_columns();
    check_words();
    // Sent: nothing to press until it is through.
    talk("a", MAX_TALK_SENDING);
    render(1000);
    CHECK(max_m.hit_count == 0 && max_m.lane_hits == 0 && text_run("Sending") && !text_run("Cancel"));
    // Done: the screen comes back.
    talk("a", MAX_TALK_IDLE);
    render(1000);
    CHECK(find_hit(MAX_HIT_TALK, 0) && find_hit(MAX_HIT_NEW, 0) && find_hit(MAX_HIT_TOAST, 0) && max_m.lane_hits == 4);
}

// The toast: top right over the lanes, never over the room; its bar runs down; a tap on it is the first hit.
static void test_toast(void)
{
    linked(ABCDE, 5);
    touch_at(1000);
    max_ui_question("c", "r", "Run the migration on the dev database now?", NULL, 0, false, false, 2000);
    render(2000);
    CHECK(!strcmp(max_ui_selected(), "a") && !strcmp(max_m.toast_id, "c"));
    const max_hit_t *t = find_hit(MAX_HIT_TOAST, 0);
    CHECK(t && t == &max_m.hits[0] && within(rect_of(box_of(t)), LANES) && apart(box_of(t), ROOM));
    const ht_run_t *who = text_run("c asks"), *q = text_run("Run the migration");
    CHECK(who && who->fg == ht_rgb(NAVY_NAME) && within(ht_run_bounds(who), box_of(t)));
    CHECK(q && q->fg == ht_rgb(NAVY_INK) && within(ht_run_bounds(q), box_of(t)));
    check_columns();
    check_words();
    int bar[2] = {0, 0};
    for (int k = 0; k < 2; k++) {
        render(2000 + k * MAX_TOAST_MS / 2);
        for (int i = 0; i < S.count; i++)
            if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(NAVY_BAR)) bar[k] = S.runs[i].w;
    }
    CHECK(bar[0] > 0 && bar[1] > 0 && bar[1] <= bar[0] / 2 + 1 && bar[1] >= bar[0] / 2 - 70);
    render(2000 + MAX_TOAST_MS);
    CHECK(!find_hit(MAX_HIT_TOAST, 0) && !text_run("c asks"));
}

// The room's card: its question and answers, the permission's Yes and No, Back and Send, and nothing to press while
// an answer goes.
static void test_room_card(void)
{
    linked(ABCDE, 3);
    asked("b", &DB, 1, false);
    render(0);
    // Nobody at the bar: the question takes the room, its edge peach.
    CHECK(!strcmp(max_ui_selected(), "b") && !strcmp(max_m.card_id, "b") && room_edge() == PEACH);
    CHECK(max_m.card_key == max_card_key(max_find("b")));
    check_hits(ROOM);
    CHECK(hits_of(MAX_HIT_OPTION) == 2 && !find_hit(MAX_HIT_SEND, 0) && !find_hit(MAX_HIT_STEP_BACK, 0));
    CHECK(!strcmp(label_on(find_hit(MAX_HIT_OPTION, 1))->text, "Staging"));
    CHECK(text_run("Which database should the") && text_run("Asks"));
    check_words();
    // Six options: two rows of three, the question still over them.
    static const pro_ask_item_t board = {"board", "Which board?", {"ESP32-P4 Function EV", "Max rev A", "Max rev B",
                                         "Harness Pro", "Dial", "None of these"}, 6, false, true};
    asked("b", &board, 1, false);
    render(0);
    check_hits(ROOM);
    CHECK(hits_of(MAX_HIT_OPTION) == 6 && find_hit(MAX_HIT_OPTION, 3)->y > find_hit(MAX_HIT_OPTION, 2)->y);
    CHECK(find_hit(MAX_HIT_OPTION, 0)->y == find_hit(MAX_HIT_OPTION, 2)->y && text_run("Which board?"));
    // Long answers get more rows rather than a cut, the question keeping a line over them.
    static const pro_ask_item_t plan = {"plan", "The auth tests fail on the session table that the migration dropped. "
                                        "Should I restore it from the audit log, rebuild it, or stop here?",
                                        {"Restore it from the audit log and run the tests again",
                                         "Rebuild the table from scratch with an empty set of sessions",
                                         "Stop here and leave everything as it is"}, 3, false, true};
    asked("b", &plan, 1, false);
    render(0);
    check_hits(ROOM);
    check_words();
    CHECK(find_hit(MAX_HIT_OPTION, 2)->y > find_hit(MAX_HIT_OPTION, 0)->y && text_run("The auth tests fail"));
    // A permission prompt: the daemon's own words; the yes green, the no outlined in the failure's ink.
    asked("b", &DEPLOY, 1, true);
    render(0);
    CHECK(text_run("Permission") && filled(box_of(find_hit(MAX_HIT_OPTION, 0)), GREEN));
    CHECK(!filled(box_of(find_hit(MAX_HIT_OPTION, 1)), GREEN));
    CHECK(label_on(find_hit(MAX_HIT_OPTION, 2))->fg == ht_rgb(NO_INK));
    check_hits(ROOM);
    // Two questions, the second of several choices: Back and Send, Send live once something is chosen.
    static const pro_ask_item_t two[] = {{"branch", "Where should the fix go?", {"main", "release/0.9"}, 2, false, true},
                                         {"checks", "Which checks?", {"Lint", "Types", "Tests"}, 3, true, true}};
    asked("b", two, 2, false);
    render(0);
    CHECK(text_run("1 / 2") && !find_hit(MAX_HIT_STEP_BACK, 0));
    max_ask_hit(max_find("b"), MAX_HIT_OPTION, 1, 0);
    render(0);
    CHECK(text_run("2 / 2") && find_hit(MAX_HIT_STEP_BACK, 0) && !find_hit(MAX_HIT_SEND, 0) && text_run("Send"));
    max_ask_hit(max_find("b"), MAX_HIT_OPTION, 0, 0);
    render(0);
    const max_hit_t *send = find_hit(MAX_HIT_SEND, 0);
    CHECK(send && filled(box_of(send), GREEN) && text_run("\xe2\x9c\x93 Lint"));
    check_hits(ROOM);
    // Sending: the choices stay drawn, and nothing can be pressed, Talk neither.
    max_ask_hit(max_find("b"), MAX_HIT_SEND, 0, 0);
    render(0);
    CHECK(max_m.hit_count == 0 && text_run("Sending"));
    CHECK(S.count < HT_RUNS);
}

static void test_cards_without_answers(void)
{
    linked(ABCDE, 3);
    // Shown only: where to answer it, and nothing to press.
    static const pro_ask_item_t shown = {"shown", "Allow Edit of src/auth/session.ts?", {"In Orca"}, 1, false, true};
    max_ui_question("a", "shown:toolu_1", shown.q, &shown, 1, true, true, 0);
    render(0);
    CHECK(text_run("Answer it in Orca") && text_run("Allow Edit of") && max_m.hit_count == 0);
    // Only the computer can answer it; voice still can.
    max_ui_question("a", "toolu_2", "Proceed?", NULL, 0, false, true, 0);
    render(0);
    CHECK(text_run("Answer it on the computer") && max_m.hit_count == 1 && find_hit(MAX_HIT_TALK, 0));
    // The reviewed path's failure: why, and Reload.
    asked("a", &DB, 1, false);
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 0, 0);
    take(0);
    max_ui_answer_receipt("a", max_ask_of("a")->fetch, "tok", false, false, "Question changed.", 0);
    render(0);
    const ht_run_t *why = text_run("Question changed.");
    CHECK(why && why->fg == ht_rgb(FAIL_INK) && find_hit(MAX_HIT_RELOAD, 0));
    check_hits(ROOM);
    // A failure: its words on the bad paper, Failed in the header, and Dismiss.
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_turn("b", "error", "pnpm test exited with 1", 0, 0);
    max_ui_focus("b");
    render(0);
    const ht_run_t *err = text_run("pnpm test exited with 1"), *failed = text_run("Failed");
    CHECK(!strcmp(max_m.card_id, "b") && err && err->fg == ht_rgb(BAD_INK) && failed && failed->fg == ht_rgb(FAIL_INK));
    CHECK(find_hit(MAX_HIT_DISMISS, 0) && within(ht_run_bounds(err), ROOM));
    check_hits(ROOM);
    // A summary on its letter, with Dismiss while it shows; then the room says Done.
    max_ui_summary("c", "Fixed the touch rotation", NULL, false, POD_TIER_ALERT, 70000);
    max_ui_focus("c");
    render(70000);
    const ht_run_t *note = text_run("Fixed the touch rotation");
    CHECK(note && note->fg == ht_rgb(LETTER_INK) && find_hit(MAX_HIT_DISMISS, 0) && text_run("Done"));
    render(70000 + MAX_DONE_MS);
    CHECK(!find_hit(MAX_HIT_DISMISS, 0) && text_run("Done") && !text_run("Fixed the touch rotation"));
    // At work: what it does in a thought, and its newest step under it, in mono.
    working("c", "Editing touch_gt911.c", 80000);
    render(80000);
    const ht_run_t *doing = text_run("Editing touch_gt911.c"), *step = text_run("Edit \xc2\xb7 main/display/pro_d");
    CHECK(doing && within(ht_run_bounds(doing), ROOM) && step && step->pro_font == &ph_mono_18);
    const ht_run_t *state = text_run("Infusing");
    CHECK(state && state->fg == ht_rgb(GREEN) && text_run("2:14") && room_edge() == EDGE);
    check_words();
}

// Each lane on its engine's colours: its words, a short bubble, its pet and its state in the state's colour; a lane
// that asks in a peach ring.
static void test_lanes_say_their_state(void)
{
    linked(ABCDE, 5);
    working("a", "Editing touch_gt911.c", 0);
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_question("b", "r", "Run the migration on the dev database now?", NULL, 0, false, false, 0);
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_turn("c", "error", "pnpm test exited with 1", 0, 61000);
    max_ui_summary("d", "Fixed the touch rotation", NULL, false, POD_TIER_ALERT, 61000);
    max_ui_focus("e");
    render(61000);
    // Asking and failed lead, working follows, then the rest.
    CHECK(!strcmp(max_m.lane_id[0], "b") && !strcmp(max_m.lane_id[1], "c") && !strcmp(max_m.lane_id[2], "a"));
    CHECK(!strcmp(max_m.lane_id[3], "d") && !strcmp(max_ui_selected(), "e") && text_run("Idle"));
    check_columns();
    check_words();
    const struct { const char *word; unsigned ink; int lane; } STATES[] = {
        {"Asks 1:01", PEACH, 0}, {"Failed", LANE_FAIL, 1}, {"Infusing\xe2\x80\xa6 3:15", MINT, 2}, {"Done", 0, 3}};
    for (size_t i = 0; i < sizeof STATES / sizeof STATES[0]; i++) {
        const ht_run_t *r = text_run(STATES[i].word);
        CHECK(r && within(ht_run_bounds(r), max_m.lane_box[STATES[i].lane]));
        if (STATES[i].ink) CHECK(r->fg == ht_rgb(STATES[i].ink));
    }
    CHECK(filled(max_m.lane_box[0], PEACH));
    for (int i = 1; i < max_m.lane_hits; i++) CHECK(!filled(max_m.lane_box[i], PEACH));
    const char *bubbles[] = {"Run the", "pnpm test", "Editing", "Fixed the"};
    for (int i = 0; i < 4; i++) {
        const ht_run_t *r = text_run(bubbles[i]);
        CHECK(r && within(ht_run_bounds(r), max_m.lane_box[i]));
    }
    // A long spinner word in a narrow lane: the word alone, rather than cut after it.
    max_ui_turn("a", "verb", "Reticulating", -1, 61000);
    render(61000);
    const ht_run_t *verb = text_run("Reticulating");
    CHECK(verb && !strcmp(verb->text, "Reticulating\xe2\x80\xa6") && within(ht_run_bounds(verb), max_m.lane_box[2]));
    check_words();
}

static void test_names_and_text_fit(void)
{
    linked(NULL, 0);
    const pro_agent_row_t rows[] = {
        {"a", "an-agent-name-that-is-far-too-long-for-one", "claude", "m1", "A machine with a long name"},
        {"b", "Tr\xe1\xbb\xa3 l\xc3\xbd ti\xe1\xba\xbfng Vi\xe1\xbb\x87t", "codex", "m2", "M\xc3\xa1y ch\xe1\xbb\xa7"},
        {"c", "c", "claude", "m1", "MacBook Pro"}, {"d", "d", "claude", "m1", "MacBook Pro"}};
    max_ui_agents(rows, 4, 0);
    working("a", LONG_TEXT, 0);
    working("b", VIET_TEXT, 0);
    render(0);
    check_columns();
    check_words();
    const ht_run_t *name = text_run("an-agent-name");
    CHECK(name && within(ht_run_bounds(name), ROOM) && !strcmp(name->text + strlen(name->text) - 3, "\xe2\x80\xa6"));
    // The room's thought ends between words, with nothing dangling before the ellipsis: whatever the text.
    static const char *const LONG_WORDS = "Reconfiguring the internationalization and synchronization of the "
        "documentation infrastructure, then reconsidering the characterization of every administration";
    for (int shift = 0; shift < 24; shift++) {
        char source[400];
        snprintf(source, sizeof source, "%.*s%s", shift % 12, "Wwwwwwwwwwww", shift < 12 ? LONG_TEXT : LONG_WORDS);
        max_ui_turn("a", "activity", source, -1, 0);
        render(0);
        int last = -1;   // the thought's last row: its face, right of the pet, under the header
        for (int i = 0; i < S.count; i++)
            if (S.runs[i].pro_font == &ph_sb_26 && S.runs[i].x > MAX_ROOM_X + 240 && S.runs[i].y > MAX_CARD_Y + 60 &&
                S.runs[i].x < MAX_ROOM_X + MAX_ROOM_W)
                last = i;
        CHECK(last >= 0);
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
    CHECK(text_run("M\xc3\xa1y ch\xe1\xbb\xa7") != NULL);
    max_ui_focus("b");
    render(0);
    CHECK(text_run("\xc4\x90\xc3\xa2y l\xc3\xa0 m\xe1\xbb\x99t") != NULL);
    check_words();
}

static void test_empty_states(void)
{
    max_ui_reset();
    render(0);
    const ht_run_t *down = text_run("Not connected"), *wait = text_run("Waiting for the computer");
    CHECK(down && within(ht_run_bounds(down), RAIL) && wait && within(ht_run_bounds(wait), ROOM));
    CHECK(max_m.lane_hits == 0 && max_m.hit_count == 0);
    max_ui_link(true, "MacBook Pro", 0);
    render(0);
    const ht_run_t *none = text_run("No agents");
    CHECK(none && within(ht_run_bounds(none), ROOM));
    CHECK(text_run("MacBook Pro") != NULL && text_run("Not connected") == NULL);
    CHECK(max_m.lane_hits == 0 && max_m.hit_count == 0);
    check_columns();
}

static void test_pages_and_notice(void)
{
    linked(SIX, 6);
    render(0);
    int dots = 0, lit = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->y < MAX_BAND_Y || r->pro_kind != K_RECT_AA) continue;
        CHECK(within(ht_run_bounds(r), LANES));
        dots++;
        lit += r->fg == ht_rgb(INK);
    }
    CHECK(dots == 2 && lit == 1);
    // The notice: on navy over the lanes, at the top right, never over the room; then gone.
    max_ui_notice("Sent to b", 3000, 0);
    render(0);
    const ht_run_t *n = text_run("Sent to b");
    CHECK(n && n->fg == ht_rgb(NAVY_INK) && within(ht_run_bounds(n), LANES) && n->y < MAX_CARD_Y + MAX_CARD_H / 2);
    check_columns();
    check_words();
    render(3000);
    CHECK(!text_run("Sent to b"));
    linked(ABCDE, 5);
    render(3000);
    for (int i = 0; i < S.count; i++) CHECK(S.runs[i].y < MAX_BAND_Y);   // one page: no dots
}

static void test_update_screen(void)
{
    linked(ABCDE, 5);
    max_ui_update(40, "0.9.0");
    render(0);
    CHECK(text_run("Updating") && text_run("40%") && text_run("0.9.0"));
    CHECK(max_m.lane_hits == 0 && max_m.hit_count == 0 && max_motion_ms(0) == MAX_WAKE_MS);
    CHECK(S.count < HT_RUNS);
}

// What moves by the clock alone: the room's pet and the toast's bar. A lane's pet and a logo hold still.
static void test_motion(void)
{
    max_ui_reset();
    render(0);
    CHECK(max_motion_ms(0) == MAX_WAKE_MS);
    linked(ABCDE, 5);
    render(0);
    const max_agent_t *a = max_find("a");
    const uint32_t step = max_motion_ms(0);
    CHECK(step == max_pet_next_ms(a, max_pet_scene(a, true), 0) && step >= POD_PH_ANIM_MS && step < MAX_WAKE_MS);
    CHECK(max_motion_ms(step - 1) == 1 && max_motion_ms(step) == 0);
    // A logo in the room, pets in the lanes: nothing moves.
    const pro_agent_row_t rows[] = {{"a", "a", "gemini", "m1", "MacBook Pro"}, {"b", "b", "claude", "m1", "MacBook Pro"},
                                    {"c", "c", "codex", "m1", "MacBook Pro"}};
    max_ui_agents(rows, 3, 0);
    working("b", "Editing", 0);
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_question("c", "r", "Deploy?", NULL, 0, false, false, 0);
    max_ui_focus("a");
    render(0);
    CHECK(max_m.lane_hits == 2 && max_motion_ms(0) == MAX_WAKE_MS);
    // The toast's bar: a step at a time while it shows.
    touch_at(1000);
    max_ui_turn("b", "error", "boom", 0, 1000);
    max_ui_question("b", "r2", "Merge?", NULL, 0, false, false, 1000);
    render(1000);
    CHECK(max_toast_shown(1000) && max_motion_ms(1000) > 0 && max_motion_ms(1000) < MAX_TOAST_MS);
    render(1000 + MAX_TOAST_MS);
    CHECK(max_motion_ms(1000 + MAX_TOAST_MS) == MAX_WAKE_MS);
    // Listening: the room's pet plays it, and moves.
    linked(ABCDE, 5);
    talk("a", MAX_TALK_RECORDING);
    render(0);
    CHECK(max_pet_scene(max_find("a"), true) == POD_SCENE_LISTEN && max_motion_ms(0) < MAX_WAKE_MS);
    CHECK(max_pet_scene(max_find("b"), false) == POD_SCENE_REST);
    talk("a", MAX_TALK_IDLE);
}

// New Harness: a button on the rail; the form on the toast's navy over the room and the lanes, with Say while its field
// takes a spoken name, and Cancel and Send while one is recorded.
static void test_new_harness(void)
{
    linked(ABCDE, 3);
    render(0);
    CHECK(!find_hit(MAX_HIT_NEW, 0) && !text_run("New Harness"));
    max_ui_offers(true);
    render(0);
    const max_hit_t *add = find_hit(MAX_HIT_NEW, 0);
    CHECK(add && within(rect_of(box_of(add)), RAIL) && add->h >= MAX_Y(80) && add->w >= 200);
    check_columns();
    check_words();
    CHECK(max_ui_form_open("form-1", 0));
    render(0);
    CHECK(!find_hit(MAX_HIT_NEW, 0) && max_m.lane_hits == 0 && text_run("Opening") && !find_hit(MAX_HIT_TALK, 0));
    CHECK(find_hit(MAX_HIT_FORM_CLOSE, 0) && !find_hit(MAX_HIT_FORM_PICK, 0) && !find_hit(MAX_HIT_FORM_BACK, 0));
    CHECK(!find_hit(MAX_HIT_FORM_SAY, 0));
    check_columns();
    take(0);
    pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "~/work/harness",
                            .previous = "backend", .next = "website", .error = "", .status = "", .action = "choose",
                            .query = "", .revision = 7, .position = 2, .total = 5, .active = true, .enabled = true,
                            .can_query = true};
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    render(0);
    check_hits(SHEET);
    check_words();
    CHECK(find_hit(MAX_HIT_FORM_MOVE, -1) && find_hit(MAX_HIT_FORM_MOVE, 1) && hits_of(MAX_HIT_FORM_PICK) == 2);
    CHECK(text_run("harness-max-firmware") && text_run("2 / 5") && text_run("Choose") && text_run("backend"));
    CHECK(max_form_can_say() && find_hit(MAX_HIT_FORM_SAY, 0) && text_run("Say") && max_m.form_revision == 7);
    // A spoken name: only Cancel and Send while it records, nothing while it goes.
    talk("", MAX_TALK_RECORDING);
    render(0);
    CHECK(max_m.hit_count == 2 && find_hit(MAX_HIT_TALK_CANCEL, 0) && find_hit(MAX_HIT_TALK_SEND, 0));
    CHECK(text_run("Listening") && !text_run("Say"));
    check_hits(SHEET);
    talk("", MAX_TALK_SENDING);
    render(0);
    CHECK(max_m.hit_count == 0 && text_run("Sending"));
    talk("", MAX_TALK_IDLE);
    // A field that takes no spoken name: no Say.
    take(0);
    page.can_query = false;
    page.revision = 8;
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    max_ui_voice_form("form-1", true, &page, 0);
    render(0);
    CHECK(!max_form_can_say() && !find_hit(MAX_HIT_FORM_SAY, 0) && !text_run("Say"));
    // A question that waits: its toast over the form, the first hit, as it lies over Close.
    touch_at(1000);
    max_ui_question("b", "r", "Deploy?", NULL, 0, false, false, 1000);
    render(1000);
    CHECK(max_m.hits[0].kind == MAX_HIT_TOAST && find_hit(MAX_HIT_FORM_CLOSE, 0) && text_run("b asks"));
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
    busy.revision = 9;
    max_ui_form_state(OUT[0].fetch, "form-1", true, &busy, 0);
    render(0);
    CHECK(text_run("Wait") && text_run("Starting") && hits_of(MAX_HIT_FORM_PICK) == 0 && !find_hit(MAX_HIT_FORM_MOVE, 1));
    // Failed: why, and Retry.
    max_form_due(MAX_FORM_WAIT_MS + 1000);
    take(MAX_FORM_WAIT_MS + 1000);
    max_form_due(2 * MAX_FORM_WAIT_MS + 2000);
    render(0);
    CHECK(max_m.form.failed && text_run("No reply. Check Harness on desktop.") && find_hit(MAX_HIT_FORM_RETRY, 0));
    check_hits(SHEET);
    check_words();
    CHECK(S.count < HT_RUNS);
}

int main(void)
{
    test_budget();
    test_room_and_lanes();
    test_talk();
    test_toast();
    test_room_card();
    test_cards_without_answers();
    test_lanes_say_their_state();
    test_names_and_text_fit();
    test_empty_states();
    test_pages_and_notice();
    test_update_screen();
    test_motion();
    test_new_harness();
    printf("test_max_view: %d checks passed\n", checks);
    return 0;
}
