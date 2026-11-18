// The lanes model: what the cable's feeds do to the lanes, their order, the pages and the clock.
#include "max_test.h"
#include "max_ui_motion.h"

static const char *const ABC[] = {"a", "b", "c"};
static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
// Enough agents for the room's and two pages of lanes, whatever MAX_LANES is.
static const char *const XS[] = {"x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9"};
_Static_assert(MAX_LANES + 2 <= sizeof XS / sizeof XS[0], "XS holds the room and two pages of lanes");

static bool utf8_valid(const char *s)
{
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        int n = *p < 0x80 ? 0 : (*p & 0xe0) == 0xc0 ? 1 : (*p & 0xf0) == 0xe0 ? 2 : (*p & 0xf8) == 0xf0 ? 3 : -1;
        if (n < 0) return false;
        for (int i = 1; i <= n; i++) if ((p[i] & 0xc0) != 0x80) return false;
        p += n + 1;
    }
    return true;
}

static void test_reset(void)
{
    max_ui_reset();
    CHECK(!max_m.link && max_m.count == 0 && max_m.machine_count == 0);
    CHECK(max_ui_selected() == NULL);
    CHECK(max_m.update_pct == -1 && max_m.talk == MAX_TALK_IDLE && !max_notice_shown(0));
}

static void test_link_down_clears_everything(void)
{
    max_ui_reset();
    CHECK(max_ui_link(true, "MacBook Pro", 0));
    CHECK(!max_ui_link(true, "MacBook Pro", 10));
    CHECK(max_ui_link(true, "Mac Studio", 20));
    CHECK(!strcmp(max_m.computer, "Mac Studio"));
    roster(ABCDE, 5);
    cable_machine_t m = {.id = "m1", .name = "MacBook Pro", .state = "ready", .local = true};
    CHECK(max_ui_machines(&m, 1, "m1"));
    max_ui_turn("b", "started", "", 0, 30);
    CHECK(max_ui_focus("e"));
    max_m.page = 1;
    CHECK(max_ui_link(false, NULL, 40));
    CHECK(!max_m.link && max_m.computer[0] == 0);
    CHECK(max_m.count == 0 && max_m.machine_count == 0 && max_m.page == 0);
    CHECK(max_ui_selected() == NULL);
    CHECK(!max_ui_link(false, NULL, 50));
}

static void test_roster_replace(void)
{
    linked(ABC, 3);
    CHECK(max_ui_focus("b"));
    max_ui_turn("b", "activity", "Editing touch.c", 12, 100);
    const pro_agent_row_t same[] = {{"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL}, {"b", "b", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"c", "c", "claude", "m1", "MacBook Pro", NULL, NULL}};
    CHECK(!max_ui_agents(same, 3, 200));
    // b stays (and keeps its turn), a goes, d comes: the selection stays on b.
    const pro_agent_row_t next[] = {{"c", "c", "codex", "m1", "MacBook Pro", NULL, NULL}, {"b", "backend", "claude", "m2", "Mac Studio", NULL, NULL},
                                    {"d", "d", "claude", "m1", "MacBook Pro", NULL, NULL}};
    CHECK(max_ui_agents(next, 3, 300));
    CHECK(max_m.count == 3);
    CHECK(!strcmp(max_m.agents[0].id, "c") && !strcmp(max_m.agents[0].engine, "codex"));
    const max_agent_t *b = max_find("b");
    CHECK(b == &max_m.agents[1] && !strcmp(b->name, "backend") && !strcmp(b->machine, "Mac Studio"));
    CHECK(b->state == MAX_WORKING && !strcmp(b->activity, "Editing touch.c"));
    CHECK(max_find("d")->state == MAX_IDLE && max_find("a") == NULL);
    CHECK(!strcmp(max_ui_selected(), "b"));
    // b goes: the room takes the agent that leads the lanes.
    CHECK(max_ui_agents(next, 1, 400));
    CHECK(!strcmp(max_ui_selected(), "c"));
    // An absent name reads as the id; a repeated id is kept once; rows past the cap are dropped.
    pro_agent_row_t many[MAX_AGENTS + 3];
    char ids[MAX_AGENTS + 3][8];
    for (int i = 0; i < MAX_AGENTS + 3; i++) {
        snprintf(ids[i], sizeof ids[i], "x%d", i);
        many[i] = (pro_agent_row_t){ids[i], NULL, NULL, NULL, NULL, NULL, NULL};
    }
    many[1].id = "x0";
    CHECK(max_ui_agents(many, MAX_AGENTS + 3, 500));
    CHECK(max_m.count == MAX_AGENTS);
    CHECK(!strcmp(max_m.agents[0].name, "x0") && !strcmp(max_m.agents[1].id, "x2"));
    CHECK(!strcmp(max_ui_selected(), "x0"));
    CHECK(max_ui_agents(NULL, 0, 600));
    CHECK(max_m.count == 0 && max_ui_selected() == NULL);
}

static void test_turn_kinds(void)
{
    linked(ABC, 3);
    CHECK(!max_ui_turn("zz", "started", "", 0, 0));   // not on the roster
    CHECK(max_ui_turn("a", "started", "Reading the issue", 0, 1000));
    max_agent_t *a = max_find("a");
    CHECK(a->state == MAX_WORKING && a->clock && max_secs(a, 1000) == 0 && max_secs(a, 3999) == 2);
    CHECK(!strcmp(a->activity, "Reading the issue"));
    CHECK(max_ui_turn("a", "verb", "Infusing\xe2\x80\xa6", -1, 1100));
    CHECK(!strcmp(a->verb, "Infusing"));
    CHECK(max_ui_turn("a", "verb", "Thinking...", -1, 1200));
    CHECK(!strcmp(a->verb, "Thinking"));
    CHECK(!max_ui_turn("a", "verb", "Thinking...", -1, 1300));
    // An activity rebases the clock on the daemon's count; an empty one says nothing new.
    CHECK(max_ui_turn("a", "activity", "Editing pod_model.c", 125, 5000));
    CHECK(!strcmp(a->activity, "Editing pod_model.c") && max_secs(a, 5000) == 125 && max_secs(a, 14000) == 134);
    max_ui_turn("a", "activity", "", -1, 6000);
    CHECK(!strcmp(a->activity, "Editing pod_model.c") && max_secs(a, 6000) == 126);
    // Steps: newest first, a repeat moves up, three kept.
    max_ui_turn("a", "step", "Read \xc2\xb7 a.c", -1, 7000);
    max_ui_turn("a", "step", "Edit \xc2\xb7 b.c", -1, 7100);
    max_ui_turn("a", "step", "Bash \xc2\xb7 make", -1, 7200);
    max_ui_turn("a", "step", "Read \xc2\xb7 a.c", -1, 7300);
    max_ui_turn("a", "step", "Grep \xc2\xb7 TODO", -1, 7400);
    CHECK(a->step_count == 3);
    CHECK(!strcmp(a->steps[0], "Grep \xc2\xb7 TODO") && !strcmp(a->steps[1], "Read \xc2\xb7 a.c") &&
          !strcmp(a->steps[2], "Bash \xc2\xb7 make"));
    // done: the clock stops where it was.
    CHECK(max_ui_turn("a", "done", "", 0, 10000));
    CHECK(a->state == MAX_DONE && max_secs(a, 10000) == 130 && max_secs(a, 99000) == 130);
    // error: red with its message, the clock stopped; the next turn clears it.
    max_ui_turn("b", "started", "", 0, 0);
    CHECK(max_ui_turn("b", "error", "pnpm test exited with 1", 0, 61000));
    max_agent_t *b = max_find("b");
    CHECK(b->state == MAX_FAILED && !strcmp(b->note, "pnpm test exited with 1") && max_secs(b, 90000) == 61);
    CHECK(max_ui_turn("b", "started", "", 0, 95000));
    CHECK(b->state == MAX_WORKING && b->note[0] == 0 && b->step_count == 0 && b->verb[0] == 0);
    // An agent with no turn seen has no clock until the daemon gives one.
    CHECK(max_ui_turn("c", "verb", "Musing", -1, 100));
    CHECK(max_find("c")->state == MAX_WORKING && max_secs(max_find("c"), 100) == -1);
}

static void test_question(void)
{
    linked(ABC, 3);
    max_ui_turn("b", "started", "", 0, 0);
    CHECK(max_ui_question("b", "r1", "Run the migration on the dev database now?", NULL, 0, false, false, 1000));
    max_agent_t *b = max_find("b");
    CHECK(b->state == MAX_ASKING && !strcmp(b->question, "Run the migration on the dev database now?"));
    CHECK(!max_ui_question("b", "r1", "Run the migration on the dev database now?", NULL, 0, false, false, 1100));
    CHECK(max_ui_question("b", "r2", "Run the migration on the dev database now?", NULL, 0, false, false, 1200));
    // While it asks, the turn's progress waits; the clock runs on.
    CHECK(!max_ui_turn("b", "activity", "Migrating", 3, 2000));
    CHECK(!max_ui_turn("b", "step", "Bash \xc2\xb7 migrate", -1, 2000));
    CHECK(b->state == MAX_ASKING && max_secs(b, 5000) == 5);
    CHECK(max_ui_question_close("b"));
    CHECK(b->state == MAX_WORKING && b->question[0] == 0);
    CHECK(!max_ui_question_close("b"));
    CHECK(!max_ui_question("zz", "r", "?", NULL, 0, false, false, 0));
    // A turn that ends while it asks ends the question too.
    max_ui_question("b", "r3", "Push?", NULL, 0, false, false, 6000);
    max_ui_turn("b", "done", "", 0, 7000);
    CHECK(b->state == MAX_DONE && b->question[0] == 0);
}

static void test_summary_tiers(void)
{
    linked(ABCDE, 5);
    // alert and list: the turn ends and its text shows for MAX_DONE_MS.
    max_ui_turn("a", "started", "", 0, 0);
    CHECK(max_ui_summary("a", "Fixed the login race", "Long recap", false, POD_TIER_ALERT, 1000));
    max_agent_t *a = max_find("a");
    CHECK(a->state == MAX_DONE && !strcmp(a->note, "Fixed the login race"));
    CHECK(max_note_shown(a, 1000) && max_note_shown(a, 1000 + MAX_DONE_MS - 1) && !max_note_shown(a, 1000 + MAX_DONE_MS));
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_summary("b", "Docs updated", NULL, false, POD_TIER_LIST, 2000);
    CHECK(max_find("b")->state == MAX_DONE && max_note_shown(max_find("b"), 2000));
    // silent: the turn ends, nothing new to say.
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_summary("c", "Sub-agent finished", NULL, false, POD_TIER_SILENT, 3000);
    CHECK(max_find("c")->state == MAX_DONE && !max_note_shown(max_find("c"), 3000));
    // restore: history, never news: an idle lane stays as it was.
    CHECK(!max_ui_summary("d", "Old news", "Old recap", true, POD_TIER_SILENT, 4000));
    CHECK(max_find("d")->state == MAX_IDLE && !max_note_shown(max_find("d"), 4000));
    // "done" is the daemon's placeholder: the recap speaks instead.
    max_ui_summary("d", "done", "The recap", false, POD_TIER_ALERT, 5000);
    CHECK(!strcmp(max_find("d")->note, "The recap"));
    // A failed turn keeps its error; with none, the summary says what happened.
    max_ui_turn("e", "error", "Build failed", 0, 6000);
    max_ui_summary("e", "Gave up", NULL, false, POD_TIER_ALERT, 6100);
    CHECK(max_find("e")->state == MAX_FAILED && !strcmp(max_find("e")->note, "Build failed"));
    max_ui_turn("e", "error", "", 0, 7000);
    max_ui_summary("e", "Could not reach the API", NULL, false, POD_TIER_ALERT, 7100);
    CHECK(!strcmp(max_find("e")->note, "Could not reach the API"));
    CHECK(!max_ui_summary("zz", "x", NULL, false, POD_TIER_ALERT, 0));
}

static void test_order_and_stability(void)
{
    char buf[128];
    linked(ABCDE, 5);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "a b c d e"));
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_turn("d", "started", "", 0, 0);
    max_ui_question("d", "r", "Push?", NULL, 0, false, false, 10);
    max_ui_turn("e", "error", "Boom", 0, 20);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d e b a c"));
    // Progress on a working lane never moves it.
    for (int i = 0; i < 20; i++) {
        max_ui_turn("b", "activity", i % 2 ? "Editing" : "Reading", i, 100 + (uint32_t)i);
        max_ui_turn("b", "verb", i % 2 ? "Musing" : "Brewing", -1, 100 + (uint32_t)i);
        max_ui_turn("b", "step", i % 2 ? "Read \xc2\xb7 x" : "Edit \xc2\xb7 y", -1, 100 + (uint32_t)i);
        CHECK(!strcmp(order_ids(buf, sizeof buf), "d e b a c"));
    }
    // Neither does the clock: a summary running out keeps a done lane where it is.
    max_ui_turn("a", "started", "", 0, 0);
    max_ui_summary("a", "Done it", NULL, false, POD_TIER_ALERT, 200);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d e b a c"));
    max_ui_tick(200 + MAX_DONE_MS);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d e b a c"));
    // The question answered: d works again, after e.
    max_ui_question_close("d");
    CHECK(!strcmp(order_ids(buf, sizeof buf), "e b d a c"));
    max_ui_turn("e", "started", "", 0, 300);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "b d e a c"));
}

// The room shows one agent large; the lanes page through the others, in lane order.
static void test_room_and_lanes(void)
{
    enum { N = MAX_LANES + 2 };   // the room's agent and two pages of lanes
    linked(XS, N);
    // There was no room when the agents arrived: it takes the one that leads the lanes.
    CHECK(!strcmp(max_ui_selected(), "x0"));
    CHECK(max_pages() == 2 && max_m.page == 0);
    int v[MAX_LANES], n = max_visible(v);
    CHECK(n == MAX_LANES && !strcmp(max_m.agents[v[0]].id, "x1") && !strcmp(max_m.agents[v[n - 1]].id, XS[MAX_LANES]));
    max_m.page = 1;
    CHECK(max_visible(v) == 1 && !strcmp(max_m.agents[v[0]].id, XS[N - 1]));
    // The computer's window moved: the room shows that agent, and the one it showed goes back to the lanes.
    CHECK(!max_ui_focus("zz") && !max_ui_focus("x0"));
    CHECK(max_ui_focus(XS[N - 1]));
    CHECK(!strcmp(max_ui_selected(), XS[N - 1]) && max_m.page == 1);
    CHECK(max_visible(v) == 1 && !strcmp(max_m.agents[v[0]].id, XS[MAX_LANES]));
    // The room's agent leaves: the room takes the one that leads the lanes, a failure before the idle ones.
    max_ui_turn("x2", "error", "boom", 0, 0);
    roster(XS, N - 1);
    CHECK(!strcmp(max_ui_selected(), "x2"));
    // Fewer agents: the page comes back within the pages there are.
    CHECK(max_pages() == 1 && max_m.page == 0);
    roster(XS, 1);
    CHECK(!strcmp(max_ui_selected(), "x0") && max_pages() == 0 && max_m.page == 0);
    roster(NULL, 0);
    CHECK(max_ui_selected() == NULL && max_pages() == 0 && max_m.page == 0);
}

// Three lanes a page: the room's agent and six lanes are two pages, a seventh lane makes three.
static void test_pages_of_three(void)
{
    CHECK(MAX_LANES == 3);
    linked(XS, 7);
    CHECK(max_pages() == 2);
    linked(XS, 8);
    int v[MAX_LANES];
    CHECK(max_pages() == 3 && max_visible(v) == 3);
    max_m.page = 2;
    CHECK(max_visible(v) == 1 && !strcmp(max_m.agents[v[0]].id, "x7"));
}

// The pager's badge: an agent on a page of lanes not shown asks. The room's agent is on no page.
static void test_asks_off_page(void)
{
    linked(XS, 8);   // the room shows x0; x1..x7 on three pages
    CHECK(!max_asks_off_page());
    max_ui_turn("x7", "error", "boom", 0, 0);   // a failure leads the lanes too, but it does not ask
    max_m.page = 1;
    CHECK(!max_asks_off_page());
    max_ui_question("x0", "r0", "Ok?", NULL, 0, false, false, 0);   // the room's own question
    CHECK(!strcmp(max_ui_selected(), "x0") && !max_asks_off_page());
    max_ui_question("x5", "r5", "Ok?", NULL, 0, false, false, 0);   // it leads the lanes: on the first page
    max_m.page = 0;
    CHECK(!max_asks_off_page());
    max_m.page = 1;
    CHECK(max_asks_off_page());
    max_m.page = 2;
    CHECK(max_asks_off_page());
    max_ui_question_close("x5");
    CHECK(!max_asks_off_page());
}

// The room's clock and summary are drawn too: they wake the render task and redraw, whatever page the lanes show. And
// the room's pet moves: the render task wakes for its next step.
static void test_room_clock(void)
{
    enum { N = MAX_LANES + 2 };
    linked(XS, N);
    roster_of(XS, N, "gemini");   // a logo for a pet: it holds still, so only the clocks wake the render task
    max_ui_focus(XS[N - 1]);
    max_m.page = 0;
    max_ui_turn(XS[N - 1], "started", "", 0, 1000);
    render(1000);
    CHECK(!max_ui_tick(1999) && max_ui_tick(2000));
    CHECK(max_ui_next_wake_ms(1500) == 500);
    max_ui_summary(XS[N - 1], "Done it", NULL, false, POD_TIER_LIST, 4000);
    render(4000);
    CHECK(max_ui_next_wake_ms(4000 + MAX_DONE_MS - 10) == 10 && max_ui_tick(4000 + MAX_DONE_MS));
    // Claude's pet at work: its next step wakes the render task, sooner than the clock's next second.
    roster(XS, N);
    max_ui_turn(XS[N - 1], "started", "", 0, 10000);
    render(10000);
    const uint32_t step = max_ui_next_wake_ms(10000);
    CHECK(step >= POD_PH_ANIM_MS && step < 1000 && step == max_motion_ms(10000));
    CHECK(!max_ui_tick(10000 + step - 1) && max_ui_tick(10000 + step));
}

// A tap where nothing is drawn: a person at the bar from `at`.
static void touch_at(uint32_t at)
{
    max_ui_touch(true, HT_WIDTH - 2, HT_HEIGHT - 2, at);
    max_ui_touch(false, HT_WIDTH - 2, HT_HEIGHT - 2, at);
}

// Nobody at the bar: a question takes the room at once, unless the room's agent asks itself; then the questions wait,
// and the one that has waited longest takes the room next.
static void test_questions_take_the_room_oldest_first(void)
{
    linked(ABCDE, 5);
    max_ui_turn("a", "started", "", 0, 0);
    CHECK(max_ui_question("c", "r1", "Deploy?", NULL, 0, false, false, 1000));
    CHECK(!strcmp(max_ui_selected(), "c") && max_m.toast_id[0] == 0 && max_find("c")->ask_since == 1000);
    // c asks: d's and b's wait, d's the older though b leads the lanes; d's sent again is the same question.
    CHECK(max_ui_question("d", "r2", "Merge?", NULL, 0, false, false, 2000));
    CHECK(max_ui_question("b", "r3", "Push?", NULL, 0, false, false, 3000));
    CHECK(!max_ui_question("d", "r2", "Merge?", NULL, 0, false, false, 4000));
    CHECK(!strcmp(max_ui_selected(), "c") && max_find("d")->ask_since == 2000);
    max_ui_question_close("c");   // answered on the computer
    max_ui_tick(4000);
    CHECK(!strcmp(max_ui_selected(), "d"));
    // Another question for an agent that asks already is a new one: it waits from when it came.
    max_ui_question("e", "r4", "Tag?", NULL, 0, false, false, 4500);
    max_ui_question("b", "r5", "Push now?", NULL, 0, false, false, 5000);
    CHECK(max_find("b")->ask_since == 5000);
    max_ui_question_close("d");
    max_ui_tick(5000);
    CHECK(!strcmp(max_ui_selected(), "e"));
    // The computer's window moving is no person at the bar: the next question still takes the room.
    linked(ABCDE, 5);
    CHECK(max_ui_focus("b"));
    max_ui_question("d", "r6", "Merge?", NULL, 0, false, false, 6000);
    CHECK(!strcmp(max_ui_selected(), "d"));
}

// A person at the bar (a tap in the last MAX_QUIET_MS, a recording, the form): a question never takes the room; the
// toast says it came. Left alone, the room goes back to the question waiting.
static void test_a_person_at_the_bar_keeps_the_room(void)
{
    linked(ABCDE, 5);
    roster_of(ABCDE, 5, "gemini");   // pets that hold still: the clocks below are the toast's and the quiet's
    touch_at(1000);
    CHECK(max_ui_question("c", "r1", "Deploy?", NULL, 0, false, false, 2000));
    CHECK(!strcmp(max_ui_selected(), "a") && !strcmp(max_m.toast_id, "c"));
    CHECK(max_toast_shown(2000) && max_toast_shown(2000 + MAX_TOAST_MS - 1) && !max_toast_shown(2000 + MAX_TOAST_MS));
    // The render task wakes for the toast's bar as it runs down, when the toast runs out, and when the person has been
    // away long enough.
    render(2000);
    CHECK(max_ui_next_wake_ms(2000) == max_motion_ms(2000) && max_motion_ms(2000) < MAX_TOAST_MS);
    render(2000 + MAX_TOAST_MS - 50);
    CHECK(max_ui_next_wake_ms(2000 + MAX_TOAST_MS - 50) == 50);
    CHECK(!max_ui_tick(2000 + MAX_TOAST_MS - 1) && max_ui_tick(2000 + MAX_TOAST_MS));
    render(2000 + MAX_TOAST_MS);
    CHECK(max_ui_next_wake_ms(2000 + MAX_TOAST_MS) == 1000 + MAX_QUIET_MS - (2000 + MAX_TOAST_MS));
    CHECK(!max_ui_tick(1000 + MAX_QUIET_MS - 1) && !strcmp(max_ui_selected(), "a"));
    CHECK(max_ui_tick(1000 + MAX_QUIET_MS) && !strcmp(max_ui_selected(), "c") && !max_toast_shown(1000 + MAX_QUIET_MS));
    render(1000 + MAX_QUIET_MS);
    CHECK(max_ui_next_wake_ms(1000 + MAX_QUIET_MS) == MAX_WAKE_MS);
    // The room's own agent asks again: nothing to announce.
    touch_at(30000);
    max_ui_question("c", "r2", "Deploy now?", NULL, 0, false, false, 30500);
    CHECK(!strcmp(max_ui_selected(), "c") && !max_toast_shown(30500));
    // A recording is a person at the bar, however long ago the last tap.
    max_ui_question_close("c");
    max_ui_talk(MAX_TALK_RECORDING, 0);
    max_ui_question("d", "r3", "Merge?", NULL, 0, false, false, 60000);
    CHECK(!strcmp(max_m.toast_id, "d"));
    max_ui_tick(90000);
    CHECK(!strcmp(max_ui_selected(), "c"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_ui_tick(90000);
    CHECK(!strcmp(max_ui_selected(), "d"));
    // So is the form, until it goes.
    max_ui_question_close("d");
    CHECK(max_ui_form_open("form-1", 91000));
    max_ui_question("e", "r4", "Tag?", NULL, 0, false, false, 92000);
    max_ui_tick(120000);
    CHECK(!strcmp(max_ui_selected(), "d"));
    max_form_dismiss();
    max_ui_tick(120000);
    CHECK(!strcmp(max_ui_selected(), "e"));
    // Left alone, the room keeps an agent that asks.
    max_ui_question("b", "r5", "Push?", NULL, 0, false, false, 121000);
    max_ui_tick(200000);
    CHECK(!strcmp(max_ui_selected(), "e"));
}

static bool ends_cut(const char *s) { const size_t n = strlen(s); return n >= 3 && !strcmp(s + n - 3, "\xe2\x80\xa6"); }

static void test_caps(void)
{
    max_ui_reset();
    // A name longer than the cable allows ends in an ellipsis, so the screen never shows a cut word as if whole.
    max_ui_link(true, "A computer whose name is far longer than the cable allows", 0);
    CHECK(!strcmp(max_m.computer, "A computer whose name is far longer\xe2\x80\xa6"));   // no space before the ellipsis
    // 100 x "ế" (3 bytes): every cut lands between letters.
    char viet[301];
    for (int i = 0; i < 100; i++) memcpy(viet + i * 3, "\xe1\xba\xbf", 3);
    viet[300] = 0;
    const pro_agent_row_t row = {"v", viet, "claude", "m1", "MacBook Pro", NULL, NULL};
    max_ui_agents(&row, 1, 0);
    max_agent_t *v = max_find("v");
    CHECK(strlen(v->name) == 39 && utf8_valid(v->name) && ends_cut(v->name));
    max_ui_turn("v", "activity", viet, 1, 0);
    CHECK(strlen(v->activity) == 189 && utf8_valid(v->activity));
    max_ui_question("v", "r", viet, NULL, 0, false, false, 0);
    CHECK(strlen(v->question) == 237 && utf8_valid(v->question));
    max_ui_turn("v", "verb", viet, -1, 0);
    CHECK(strlen(v->verb) == 0);   // asking: the spinner word waits
    max_ui_question_close("v");
    max_ui_turn("v", "verb", viet, -1, 0);
    CHECK(strlen(v->verb) == 45 && utf8_valid(v->verb));
    // A two-byte letter cut in half, and control characters, never reach the screen.
    char odd[CABLE_NAME_MAX + 4];
    memset(odd, 'x', sizeof odd);
    memcpy(odd + CABLE_NAME_MAX - 2, "\xc3\xa9", 2);
    odd[sizeof odd - 1] = 0;
    const pro_agent_row_t row2 = {"w", odd, "codex", "m1", "Mac\nStudio\t1", NULL, NULL};
    max_ui_agents(&row2, 1, 0);
    CHECK(strlen(max_find("w")->name) == CABLE_NAME_MAX - 1 && utf8_valid(max_find("w")->name) && ends_cut(max_find("w")->name));
    CHECK(!strcmp(max_find("w")->machine, "Mac Studio 1"));
    // One that just fits is whole.
    char fits[CABLE_NAME_MAX];
    memset(fits, 'y', sizeof fits - 1);
    fits[sizeof fits - 1] = 0;
    const pro_agent_row_t row3 = {"y", fits, "codex", "m1", "Mac Studio", NULL, NULL};
    max_ui_agents(&row3, 1, 0);
    CHECK(!strcmp(max_find("y")->name, fits));
    const pro_agent_row_t row4 = {"z", "z", "codex", "m1", "A machine whose name is far longer than the cable allows", NULL, NULL};
    max_ui_agents(&row4, 1, 0);
    CHECK(strlen(max_find("z")->machine) == CABLE_NAME_MAX - 1 && ends_cut(max_find("z")->machine));
    max_ui_notice("A notice far longer than the line it is shown on, which the model keeps only in part, "
                  "cut where a letter ends \xe1\xba\xbf", 1000, 0);
    CHECK(strlen(max_m.notice) < MAX_NOTICE_BYTES && utf8_valid(max_m.notice));
}

// The room's pet takes no voice while an answer is on its way or in and the computer has not closed the question.
static void test_no_talk_while_an_answer_waits(void)
{
    max_ui_reset();
    max_ui_link(true, "Mac", 0);
    const pro_agent_row_t row = {"a", "a", "claude", "m1", "Mac", NULL, NULL};
    max_ui_agents(&row, 1, 0);
    max_ui_question("a", "r1", "Which one?", NULL, 0, false, false, 0);
    max_agent_t *a = max_find("a");
    max_ask_t *k = max_ask_of("a");
    CHECK(a->state == MAX_ASKING && k && max_can_talk(a));
    k->phase = MAX_ASK_SENDING;
    CHECK(!max_can_talk(a));
    k->phase = MAX_ASK_SENT;
    CHECK(!max_can_talk(a));
    k->phase = MAX_ASK_FAILED;   // it did not go: the person may say it instead
    CHECK(max_can_talk(a));
    max_ui_question_close("a");
    CHECK(max_can_talk(a));
}

static void test_elapsed_format(void)
{
    char t[16];
    static const struct { int64_t s; const char *want; } cases[] = {
        {0, "0:00"}, {59, "0:59"}, {134, "2:14"}, {3599, "59:59"}, {3600, "1:00:00"}, {3723, "1:02:03"},
        {90000, "25:00:00"}, {-1, ""}};
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        max_fmt_elapsed(t, sizeof t, cases[i].s);
        CHECK(!strcmp(t, cases[i].want));
    }
}

static void test_app_state(void)
{
    max_ui_reset();
    CHECK(max_ui_notice("Voice failed", 3000, 100));
    CHECK(max_notice_shown(3099) && !max_notice_shown(3100));
    CHECK(max_ui_notice(NULL, 0, 200));
    CHECK(!max_notice_shown(200));
    CHECK(!max_ui_notice("", 0, 300));
    CHECK(max_ui_talk(MAX_TALK_RECORDING, 0));
    CHECK(!max_ui_talk(MAX_TALK_RECORDING, 0));
    CHECK(max_ui_update(40, "0.9.0"));
    CHECK(!max_ui_update(40, "0.9.0"));
    CHECK(max_ui_update(41, "0.9.0"));
    CHECK(max_ui_update(-1, NULL));
    CHECK(max_m.update_pct == -1);
    // A machine list that did not change is no change.
    cable_machine_t m[2] = {{.id = "m1", .name = "MacBook Pro", .state = "ready", .local = true},
                            {.id = "m2", .name = "Mac Studio", .state = "offline"}};
    CHECK(max_ui_machines(m, 2, "m1"));
    CHECK(!max_ui_machines(m, 2, "m1"));
    CHECK(max_ui_machines(m, 1, "m1"));
    CHECK(max_ui_machines(NULL, 0, ""));
    CHECK(max_m.machine_count == 0);
}

int main(void)
{
    test_reset();
    test_link_down_clears_everything();
    test_roster_replace();
    test_turn_kinds();
    test_question();
    test_summary_tiers();
    test_order_and_stability();
    test_room_and_lanes();
    test_pages_of_three();
    test_asks_off_page();
    test_room_clock();
    test_questions_take_the_room_oldest_first();
    test_a_person_at_the_bar_keeps_the_room();
    test_caps();
    test_no_talk_while_an_answer_waits();
    test_elapsed_format();
    test_app_state();
    printf("test_max_model: %d checks passed\n", checks);
    return 0;
}
