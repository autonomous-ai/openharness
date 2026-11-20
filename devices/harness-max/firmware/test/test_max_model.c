// The pages model: what the cable's feeds do to the agents, which page is up and why (Attention, Ambient), Inbox, the
// cells' pages and the clock. Nothing here draws: the clock's picture is taken as drawn (as_drawn).
#include "max_test.h"
#include "max_ui_motion.h"

static const char *const ABC[] = {"a", "b", "c"};
static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
// More agents than two pages of cells hold.
static const char *const XS[] = {"x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x10", "x11"};
_Static_assert(2 * MAX_CELLS + 1 <= sizeof XS / sizeof XS[0], "XS holds more than two pages of cells");

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
    CHECK(!max_m.link && max_m.count == 0 && max_m.machine_count == 0 && max_m.inbox_count == 0);
    CHECK(max_m.view == MAX_VIEW_AMBIENT && max_ui_selected() == NULL);   // no computer: Ambient says so
    CHECK(max_m.update_pct == -1 && max_m.talk == MAX_TALK_IDLE && !max_notice_shown(0));
}

static void test_link_down_clears_everything(void)
{
    max_ui_reset();
    CHECK(max_ui_link(true, "MacBook Pro", 0));
    CHECK(!max_ui_link(true, "MacBook Pro", 10));
    CHECK(max_ui_link(true, "Mac Studio", 20));
    CHECK(!strcmp(max_m.computer, "Mac Studio") && max_m.view == MAX_VIEW_AMBIENT);   // no agents yet
    roster(ABCDE, 5);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    cable_machine_t m = {.id = "m1", .name = "MacBook Pro", .state = "ready", .local = true};
    CHECK(max_ui_machines(&m, 1, "m1"));
    max_ui_turn("b", "started", "", 0, 30);
    max_ui_turn("c", "error", "boom", 0, 35);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c"));
    CHECK(max_ui_link(false, NULL, 40));
    CHECK(!max_m.link && max_m.computer[0] == 0);
    CHECK(max_m.count == 0 && max_m.machine_count == 0 && max_m.row_first == 0);
    CHECK(max_m.view == MAX_VIEW_AMBIENT && max_ui_selected() == NULL && max_m.attn_id[0] == 0);
    // Inbox is the bar's own: its notices stay.
    CHECK(max_m.inbox_count == 1 && !strcmp(max_m.inbox[0].id, "c"));
    CHECK(!max_ui_link(false, NULL, 50));
}

static void test_roster_replace(void)
{
    linked(ABC, 3);
    max_ui_turn("b", "activity", "Editing touch.c", 12, 100);
    const pro_agent_row_t same[] = {{"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"b", "b", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"c", "c", "claude", "m1", "MacBook Pro", NULL, NULL}};
    CHECK(!max_ui_agents(same, 3, 200));
    // b stays (and keeps its turn), a goes, d comes: each with its app and what the bar may do with it.
    const pro_agent_row_t next[] = {{"c", "c", "codex", "m1", "MacBook Pro", "orca", "sv"},
                                    {"b", "backend", "claude", "m2", "Mac Studio", NULL, NULL},
                                    {"d", "d", "claude", "m1", "MacBook Pro", "harness", ""}};
    CHECK(max_ui_agents(next, 3, 300));
    CHECK(max_m.count == 3);
    CHECK(!strcmp(max_m.agents[0].id, "c") && !strcmp(max_m.agents[0].engine, "codex"));
    CHECK(!strcmp(max_m.agents[0].host, "orca") && max_m.agents[0].caps == MAX_CAP_VOICE);
    const max_agent_t *b = max_find("b");
    CHECK(b == &max_m.agents[1] && !strcmp(b->name, "backend") && !strcmp(b->machine, "Mac Studio"));
    CHECK(b->state == MAX_WORKING && !strcmp(b->activity, "Editing touch.c"));
    CHECK(b->host[0] == 0 && b->caps == MAX_CAPS_ALL);   // left out: all of them, as the dial reads it
    const max_agent_t *d = max_find("d");
    CHECK(d->state == MAX_IDLE && d->caps == 0 && d->since_ms == 300 && max_find("a") == NULL);
    // The agent page's agent leaves the ring: its page goes, back to Overview.
    max_copy(max_m.selected, sizeof max_m.selected, "b");
    max_show(MAX_VIEW_AGENT);
    CHECK(!strcmp(max_ui_selected(), "b"));
    CHECK(max_ui_agents(next, 1, 400));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.selected[0] == 0 && max_ui_selected() == NULL);
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
    // The ring empties: nothing to show but Ambient's "No agents yet".
    CHECK(max_ui_agents(NULL, 0, 600));
    CHECK(max_m.count == 0 && max_m.view == MAX_VIEW_AMBIENT);
}

static void test_turn_kinds(void)
{
    linked(ABC, 3);
    CHECK(!max_ui_turn("zz", "started", "", 0, 0));   // not on the roster
    CHECK(max_ui_turn("a", "started", "Reading the issue", 0, 1000));
    max_agent_t *a = max_find("a");
    CHECK(a->state == MAX_WORKING && a->clock && max_secs(a, 1000) == 0 && max_secs(a, 3999) == 2);
    CHECK(a->since_ms == 1000);   // the state's change: the agent page's "ago"
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
    CHECK(a->since_ms == 10000);   // progress in between changed no state
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
    // An agent off the ring: its notice, and it waits for its agent (test_max_ask.c), which does not appear for it.
    CHECK(max_ui_question("zz", "r", "?", NULL, 0, false, false, 0) && !max_find("zz") && max_m.inbox[0].id[0] == 'z');
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
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d b e a c"));   // asking, working, failed, then the rest
    // Progress on a working agent never moves it.
    for (int i = 0; i < 20; i++) {
        max_ui_turn("b", "activity", i % 2 ? "Editing" : "Reading", i, 100 + (uint32_t)i);
        max_ui_turn("b", "verb", i % 2 ? "Musing" : "Brewing", -1, 100 + (uint32_t)i);
        max_ui_turn("b", "step", i % 2 ? "Read \xc2\xb7 x" : "Edit \xc2\xb7 y", -1, 100 + (uint32_t)i);
        CHECK(!strcmp(order_ids(buf, sizeof buf), "d b e a c"));
    }
    // Done goes after failed and before resting; the clock running its summary out keeps it there.
    max_ui_turn("a", "started", "", 0, 0);
    max_ui_summary("a", "Done it", NULL, false, POD_TIER_ALERT, 200);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d b e a c"));
    max_ui_turn("c", "started", "", 0, 210);
    max_ui_summary("c", "Done too", NULL, false, POD_TIER_LIST, 220);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d b e a c"));
    max_ui_tick(200 + MAX_DONE_MS);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d b e a c"));
    // The question answered: d works again, after b (the ring's order within a state).
    max_ui_question_close("d");
    CHECK(!strcmp(order_ids(buf, sizeof buf), "b d e a c"));
    max_ui_turn("e", "started", "", 0, 300);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "b d e a c"));
    max_ui_turn("c", "started", "", 0, 310);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "b c d e a"));
}

// App Detail's row: three cells on the glass from row_first, which stays within the row there is; another app's ring
// starts at its front.
static void test_row_scrolls(void)
{
    enum { N = 2 * MAX_CELLS + 1 };
    linked(XS, N);
    max_show(MAX_VIEW_OVERVIEW);
    int c[MAX_CELLS];
    CHECK(max_row_last() == N - MAX_CELLS && max_m.row_first == 0);
    CHECK(max_cells(c) == MAX_CELLS && c[0] == 0 && c[MAX_CELLS - 1] == MAX_CELLS - 1);
    max_m.row_first = N - MAX_CELLS;
    CHECK(max_cells(c) == MAX_CELLS && c[0] == N - MAX_CELLS && c[MAX_CELLS - 1] == N - 1);
    // Fewer agents: the row comes back within itself.
    roster(XS, MAX_CELLS + 1);
    CHECK(max_m.row_first == 1 && max_cells(c) == MAX_CELLS && c[0] == 1);
    roster(XS, 2);
    CHECK(max_m.row_first == 0 && max_row_last() == 0 && max_cells(c) == 2);
    // Another app's ring starts at its front.
    roster(XS, N);
    max_m.row_first = 2;
    const pro_app_row_t apps[] = {{"orca", "Orca", N, 0}, {"vscode", "VS Code", 2, 0}};
    CHECK(max_ui_apps("orca", apps, 2, 0) && max_m.row_first == 0);
    max_m.row_first = 2;
    CHECK(!max_ui_apps("orca", apps, 2, 0) && max_m.row_first == 2);   // the same app: the row stays
    CHECK(max_ui_apps("vscode", apps, 2, 0) && max_m.row_first == 0);
    roster(NULL, 0);
    CHECK(max_row_last() == 0 && max_m.row_first == 0 && max_cells(c) == 0);
    // An open agent's window: a sliver before it where there is one, the row's end in view.
    CHECK(max_open_first(0, 7) == 0 && max_open_first(1, 7) == 0 && max_open_first(3, 7) == 2);
    CHECK(max_open_first(6, 7) == 4 && max_open_first(5, 7) == 4 && max_open_first(1, 2) == 0);
}

// An agent open across the row holds the order it opened on as states change; one that comes meanwhile goes after
// them by need, and one that leaves leaves. Closed, the row is by need again with the agent that was open one cell
// in; from any other page it starts at its front.
static void test_row_holds_while_open(void)
{
    char buf[128];
    linked(ABCDE, 5);
    max_show(MAX_VIEW_OVERVIEW);
    max_open("c");
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(order_ids(buf, sizeof buf), "a b c d e"));
    max_ui_turn("e", "started", "", 0, 10);
    max_ui_question("d", "r1", "Ok?", NULL, 0, false, false, 20);
    CHECK(max_m.view == MAX_VIEW_ATTENTION);   // a question takes the glass: the row is by need again
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d e a b c"));
    max_open("c");
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d e a b c"));
    max_ui_question_close("d");
    max_ui_turn("e", "done", "", 0, 30);
    max_ui_turn("a", "started", "", 0, 40);
    CHECK(!strcmp(order_ids(buf, sizeof buf), "d e a b c"));   // held
    const pro_agent_row_t rows[] = {{"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"b", "b", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"c", "c", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"e", "e", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"f", "f", "claude", "m1", "MacBook Pro", NULL, NULL}};
    max_ui_agents(rows, 5, 50);   // d leaves, f comes
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(order_ids(buf, sizeof buf), "e a b c f"));
    // Another agent opened from a sliver keeps the order held.
    max_open("b");
    CHECK(!strcmp(order_ids(buf, sizeof buf), "e a b c f") && !strcmp(max_ui_selected(), "b"));
    // Closed: by need (a at work, e done, the rest resting), b one cell in from the left where it stands.
    CHECK(max_show(MAX_VIEW_OVERVIEW) && !strcmp(order_ids(buf, sizeof buf), "a e b c f") && max_m.row_first == 1);
    max_open("f");
    CHECK(max_show(MAX_VIEW_OVERVIEW) && max_m.row_first == max_row_last());   // the last: the row's end in view
    max_open("a");
    CHECK(max_show(MAX_VIEW_OVERVIEW) && max_m.row_first == 0);
    // From any other page the row starts at its front.
    max_m.row_first = 2;
    max_show(MAX_VIEW_INBOX);
    CHECK(max_show(MAX_VIEW_OVERVIEW) && max_m.row_first == 0);
    // The open agent leaves the ring: Overview, at the row's front.
    max_open("f");
    max_ui_agents(rows, 4, 60);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.row_first == 0 && max_m.held_count == 0);
}

// An agent moving up past the cells before the glass would go out of sight: the row goes to its front, unless a
// finger holds it. One moving within the glass or after it leaves the row where it is.
static void test_row_front_if_passed(void)
{
    linked(XS, 8);
    max_show(MAX_VIEW_OVERVIEW);
    max_ui_tick(0);
    max_m.row_first = 2;
    // x6 starts work: it moves up to the row's front, past x0 and x1.
    max_ui_turn("x6", "started", "", 0, 10);
    CHECK(max_m.row_first == 0);
    // The same agents before the glass in another order: the row stays (x0 starts work, before x6 by the ring).
    max_m.row_first = 3;
    max_ui_tick(20);
    max_ui_turn("x0", "started", "", 0, 30);
    CHECK(max_m.row_first == 3);
    // A finger on the glass holds the row where it is.
    max_ui_touch(true, 900, 200, 40);
    max_ui_turn("x7", "started", "", 0, 50);
    CHECK(max_m.row_first == 3);
    max_ui_touch_cancel();
    max_ui_tick(60);
    CHECK(max_m.row_first == 3);   // what it passed meanwhile is the row as it stands
    // Off Overview the row is not watched.
    max_ui_question("x5", "r1", "Ok?", NULL, 0, false, false, 70);
    CHECK(max_m.view == MAX_VIEW_ATTENTION);
}

// The computer's window moving is not a person at the bar: no page changes.
static void test_focus_changes_no_page(void)
{
    linked(ABC, 3);
    CHECK(!max_ui_focus("b") && max_m.view == MAX_VIEW_OVERVIEW && max_ui_selected() == NULL);
    max_copy(max_m.selected, sizeof max_m.selected, "a");
    max_show(MAX_VIEW_AGENT);
    CHECK(!max_ui_focus("b") && !strcmp(max_ui_selected(), "a"));
}

// A new question takes Attention at once; a question sent again does not; questions that come while another agent's
// is up wait their turn, the oldest first, and take the page when it is answered or gone.
static void test_questions_take_attention_oldest_first(void)
{
    linked(ABCDE, 5);
    max_ui_turn("a", "started", "", 0, 0);
    CHECK(max_ui_question("c", "r1", "Deploy?", NULL, 0, false, false, 1000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c") && max_m.attn == MAX_ATTN_ASK);
    CHECK(max_m.attn_from == 1000 && !strcmp(max_ui_selected(), "c") && max_m.toast_id[0] == 0);
    // Sent again (the same request and prompt): no news, and the page keeps its time.
    CHECK(!max_ui_question("c", "r1", "Deploy?", NULL, 0, false, false, 1500));
    CHECK(max_m.attn_from == 1000 && max_m.inbox_count == 1);
    // c's is up: d's and b's wait, d's the older.
    CHECK(max_ui_question("d", "r2", "Merge?", NULL, 0, false, false, 2000));
    CHECK(max_ui_question("b", "r3", "Push?", NULL, 0, false, false, 3000));
    CHECK(!strcmp(max_m.attn_id, "c") && max_m.inbox_count == 3);
    // c's answered on the computer: the clock moves Attention to the question that has waited longest.
    max_ui_question_close("c");
    CHECK(max_ui_tick(4000) && !strcmp(max_m.attn_id, "d") && max_m.attn_from == 4000);
    // c asks again (a new question): it waits behind d's. d's own new one takes its page again, from its time.
    CHECK(max_ui_question("c", "r4", "Deploy now?", NULL, 0, false, false, 4500));
    CHECK(!strcmp(max_m.attn_id, "d"));
    CHECK(max_ui_question("d", "r5", "Merge now?", NULL, 0, false, false, 5000));
    CHECK(!strcmp(max_m.attn_id, "d") && max_m.attn_from == 5000);
    // d leaves the ring: b's (3000) has waited longer than c's (4500).
    const pro_agent_row_t rows[] = {{"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"b", "b", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"c", "c", "claude", "m1", "MacBook Pro", NULL, NULL}};
    CHECK(max_ui_agents(rows, 3, 6000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "b"));
    // None waits: Overview.
    max_ui_question_close("b");
    max_ui_question_close("c");
    CHECK(max_ui_tick(7000) && max_m.view == MAX_VIEW_OVERVIEW && max_ui_selected() == NULL);
}

// A failed turn takes Attention (red) and goes back to Overview by itself; an alert's summary only leaves its note, a
// quieter summary or history nothing. A question replaces a failure on the page; a failure waits in Inbox behind a
// question.
static void test_turn_ends_take_attention(void)
{
    linked(ABCDE, 5);
    max_ui_turn("a", "started", "", 0, 0);
    CHECK(max_ui_turn("a", "error", "pnpm test exited with 1", 0, 1000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "a") && max_m.attn == MAX_ATTN_FAIL);
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1000) == MAX_ATTN_END_MS);
    CHECK(!max_ui_tick(1000 + MAX_ATTN_END_MS - 1) && max_m.view == MAX_VIEW_ATTENTION);
    CHECK(max_ui_tick(1000 + MAX_ATTN_END_MS) && max_m.view == MAX_VIEW_OVERVIEW);
    // A list or a silent summary only shows on its agent; history is never news.
    max_ui_turn("b", "started", "", 0, 10000);
    CHECK(max_ui_summary("b", "Docs updated", NULL, false, POD_TIER_LIST, 11000) && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_turn("c", "started", "", 0, 10000);
    CHECK(max_ui_summary("c", "Sub-agent finished", NULL, false, POD_TIER_SILENT, 11000));
    CHECK(!max_ui_summary("d", "Old news", "Old recap", true, POD_TIER_ALERT, 12000));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.inbox_count == 1);
    // An alert's summary: done. It never takes the glass: its note, and its notice.
    max_ui_turn("e", "started", "", 0, 12000);
    CHECK(max_ui_summary("e", "Fixed the login race", NULL, false, POD_TIER_ALERT, 13000));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && strcmp(max_m.attn_id, "e") && max_m.toast_id[0] == 0);
    CHECK(!strcmp(max_m.done_id, "e") && max_done_shown(13000));
    // One with nothing to say ends the turn, and is no news.
    max_ui_turn("d", "started", "", 0, 13000);
    CHECK(max_ui_summary("d", NULL, NULL, false, POD_TIER_ALERT, 13500));
    CHECK(max_find("d")->state == MAX_DONE && !strcmp(max_m.done_id, "e") && max_m.inbox_count == 2);
    // A question replaces a turn's end on the page.
    CHECK(max_ui_question("b", "r1", "Push?", NULL, 0, false, false, 14000));
    CHECK(!strcmp(max_m.attn_id, "b") && max_m.attn == MAX_ATTN_ASK && max_m.attn_from == 14000);
    // A turn's end while another agent's question is up: Inbox only.
    max_ui_turn("c", "started", "", 0, 14500);
    CHECK(max_ui_turn("c", "error", "boom", 0, 15000));
    CHECK(!strcmp(max_m.attn_id, "b") && !strcmp(max_m.inbox[0].id, "c") && max_m.inbox[0].kind == MAX_ATTN_FAIL);
    // A done note whose agent starts again is over at once.
    max_ui_question_close("b");
    max_ui_tick(16000);
    CHECK(max_ui_summary("e", "Fixed it again", NULL, false, POD_TIER_ALERT, 17000) && max_done_shown(17000));
    CHECK(max_ui_turn("e", "started", "", 0, 18000) && !max_done_shown(18000) && max_m.view == MAX_VIEW_OVERVIEW);
    // So is a failed page whose agent leaves the ring.
    max_ui_turn("e", "error", "boom", 0, 19000);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "e"));
    roster(ABCDE, 4);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
}

// A finished turn never takes the glass (the owner's call, 18 Nov): its note at the bottom right for MAX_DONE_NOTE_MS,
// the newest in the corner, over whatever is up, talk, New Harness and Ambient too; its notice stays unread in Inbox.
static void test_done_note(void)
{
    linked(ABCDE, 5);
    max_ui_turn("c", "started", "", 0, 0);
    CHECK(max_ui_summary("c", "Fixed the login race", NULL, false, POD_TIER_ALERT, 1000));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.attn_id[0] == 0 && max_m.toast_id[0] == 0);
    CHECK(!strcmp(max_m.done_id, "c") && max_m.done_from == 1000);
    CHECK(!strcmp(max_m.inbox[0].id, "c") && max_m.inbox[0].kind == MAX_ATTN_DONE && max_unread() == 1);
    // Its clock: drawn until MAX_DONE_NOTE_MS, then gone, its notice still unread.
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1000) == MAX_DONE_NOTE_MS);
    CHECK(max_done_shown(1000 + MAX_DONE_NOTE_MS - 1) && !max_done_shown(1000 + MAX_DONE_NOTE_MS));
    CHECK(max_time_key(1000) != max_time_key(1000 + MAX_DONE_NOTE_MS));
    CHECK(max_ui_tick(1000 + MAX_DONE_NOTE_MS) && max_unread() == 1);
    // The newer note takes the corner.
    max_ui_turn("c", "started", "", 0, 2000);
    max_ui_summary("c", "Fixed it", NULL, false, POD_TIER_ALERT, 2000);
    max_ui_turn("d", "started", "", 0, 2000);
    max_ui_summary("d", "Docs updated", NULL, false, POD_TIER_ALERT, 2100);
    CHECK(!strcmp(max_m.done_id, "d") && max_done_shown(2100));
    // A list summary is no news: no note.
    max_ui_turn("b", "started", "", 0, 2000);
    max_ui_summary("b", "Sub-agent finished", NULL, false, POD_TIER_LIST, 2200);
    CHECK(!strcmp(max_m.done_id, "d"));
    // While a person talks: the same note, no toast, the talk goes on.
    max_open("a");
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "a");
    max_ui_talk(MAX_TALK_RECORDING, 3000);
    max_ui_turn("e", "started", "", 0, 3000);
    max_ui_summary("e", "Fixed", NULL, false, POD_TIER_ALERT, 3100);
    CHECK(!strcmp(max_m.done_id, "e") && max_m.toast_id[0] == 0 && max_m.talk == MAX_TALK_RECORDING);
    CHECK(max_m.view == MAX_VIEW_AGENT);
    max_ui_talk(MAX_TALK_IDLE, 3200);
    // On Ambient: Ambient stays.
    max_ui_turn("c", "started", "", 0, 4000);
    max_show(MAX_VIEW_AMBIENT);
    max_ui_summary("c", "Again", NULL, false, POD_TIER_ALERT, 4100);
    CHECK(max_m.view == MAX_VIEW_AMBIENT && !strcmp(max_m.done_id, "c") && max_done_shown(4100));
    // A failure still takes the glass; its agent's note is over.
    max_ui_turn("c", "started", "", 0, 5000);
    max_ui_turn("c", "error", "boom", 0, 5100);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && max_m.attn == MAX_ATTN_FAIL && !max_done_shown(5100));
    // Its agent leaves the ring: over; the link goes: forgotten.
    max_ui_turn("d", "started", "", 0, 6000);
    max_ui_summary("d", "Docs again", NULL, false, POD_TIER_ALERT, 6100);
    roster(ABCDE, 3);
    CHECK(!max_done_shown(6100));
    max_ui_summary("a", "Done", NULL, false, POD_TIER_ALERT, 6200);
    CHECK(max_done_shown(6200));
    max_ui_link(false, NULL, 6300);
    CHECK(max_m.done_id[0] == 0);
}

// Inbox: every event an unread notice, newest first, kept after its agent leaves; the same one again moves to the top,
// unread again; leaving Inbox reads them all.
static void test_inbox(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    const pro_agent_row_t rows[] = {{"a", "alpha", "codex", "m1", "MacBook Pro", "orca", NULL},
                                    {"b", "b", "claude", "m1", "MacBook Pro", NULL, NULL}};
    max_ui_agents(rows, 2, 0);
    // No `apps` yet: a notice names the agent's own app (its host, by the daemon's name for it).
    CHECK(max_ui_question("a", "r1", "Keep the dark gradient?", NULL, 0, false, false, 1000));
    const max_inbox_t *n = &max_m.inbox[0];
    CHECK(max_m.inbox_count == 1 && !strcmp(n->id, "a") && !strcmp(n->name, "alpha") && !strcmp(n->engine, "codex"));
    CHECK(!strcmp(n->app, "Orca") && n->kind == MAX_ATTN_ASK && !strcmp(n->text, "Keep the dark gradient?"));
    CHECK(n->at == 1000 && n->unread && max_unread() == 1);
    // With `apps`, the shown app's name.
    const pro_app_row_t apps[] = {{"orca", "Orca", 2, 1}};
    max_ui_apps("orca", apps, 1, 1500);
    max_ui_turn("b", "error", "boom", 0, 2000);
    CHECK(max_m.inbox_count == 2 && !strcmp(max_m.inbox[0].id, "b") && max_m.inbox[0].kind == MAX_ATTN_FAIL);
    CHECK(!strcmp(max_m.inbox[0].app, "Orca") && !strcmp(max_m.inbox[0].text, "boom") && max_unread() == 2);
    // Opened and left: read. Only leaving does it.
    CHECK(max_show(MAX_VIEW_INBOX) && max_unread() == 2);
    CHECK(max_show(MAX_VIEW_OVERVIEW) && max_unread() == 0);
    // The cable comes back and the daemon sends the same question again: on top, unread again, not twice.
    max_ui_link(false, NULL, 3000);
    max_ui_link(true, "MacBook Pro", 3000);
    max_ui_apps("orca", apps, 1, 3000);
    max_ui_agents(rows, 2, 3000);
    CHECK(max_ui_question("a", "r1", "Keep the dark gradient?", NULL, 0, false, false, 5000));
    CHECK(max_m.inbox_count == 2 && !strcmp(max_m.inbox[0].id, "a") && max_m.inbox[0].unread);
    CHECK(max_m.inbox[0].at == 5000 && !max_m.inbox[1].unread && max_unread() == 1);
    // Its agent leaves the ring: the notice keeps who and where.
    max_ui_agents(rows + 1, 1, 6000);
    CHECK(!strcmp(max_m.inbox[0].name, "alpha") && !strcmp(max_m.inbox[0].app, "Orca"));
    // MAX_INBOX kept: the oldest goes.
    char text[16];
    for (int i = 0; i < MAX_INBOX; i++) {
        snprintf(text, sizeof text, "boom %d", i);
        max_ui_turn("b", "started", "", 0, 7000);
        max_ui_turn("b", "error", text, 0, 7000 + (uint32_t)i);
    }
    CHECK(max_m.inbox_count == MAX_INBOX && !strcmp(max_m.inbox[0].text, text));
    CHECK(!strcmp(max_m.inbox[MAX_INBOX - 1].text, "boom 0"));
    // A failure with no words of its own: its summary's words are its notice's.
    max_ui_turn("b", "started", "", 0, 8000);
    max_ui_turn("b", "error", "", 0, 8100);
    CHECK(max_m.inbox[0].text[0] == 0);
    CHECK(max_ui_summary("b", "Could not reach the API", NULL, false, POD_TIER_ALERT, 8200));
    CHECK(max_m.inbox_count == MAX_INBOX && !strcmp(max_m.inbox[0].text, "Could not reach the API"));
    CHECK(!strcmp(max_m.inbox[1].text, text));
}

// A question the bar was told before, back as a `tier: "list"` row (pro_app_ask's `listed`): filed quietly. Its agent
// asks, but the page, the toast and Ambient's clock are left alone, and its notice keeps its place and whether it was
// read; one the Inbox does not hold comes back unread. It waits on its tile, never in Attention's queue.
static void test_quiet_question(void)
{
    linked(ABC, 3);
    CHECK(max_ui_question("a", "r1", "Deploy?", NULL, 0, false, false, 1000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && max_m.inbox[0].unread);
    CHECK(max_show(MAX_VIEW_INBOX) && max_show(MAX_VIEW_OVERVIEW) && max_unread() == 0);
    max_ui_link(false, NULL, 2000);   // the bar loses its questions with the link; back, the daemon refiles a's
    max_ui_link(true, "MacBook Pro", 2000);
    roster(ABC, 3);
    CHECK(max_find("a")->state != MAX_ASKING);
    const uint32_t idle = max_m.idle_from;
    CHECK(max_ui_question_quiet("a", "r1", "Deploy?", NULL, 0, false, false, 3000));
    CHECK(max_find("a")->state == MAX_ASKING && !strcmp(max_find("a")->question, "Deploy?"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.toast_id[0] == 0 && max_m.idle_from == idle);
    CHECK(max_m.inbox_count == 1 && max_m.inbox[0].at == 1000 && !max_m.inbox[0].unread && max_unread() == 0);
    CHECK(!max_ui_question_quiet("a", "r1", "Deploy?", NULL, 0, false, false, 3100));   // sent again: no change
    // One the Inbox does not hold: a new notice, unread, and still no page.
    CHECK(max_ui_question_quiet("b", "r2", "Merge?", NULL, 0, false, false, 4000));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.inbox_count == 2 && !strcmp(max_m.inbox[0].id, "b"));
    CHECK(max_m.inbox[0].unread && max_unread() == 1);
    // While a person talks: no toast either.
    max_ui_talk(MAX_TALK_RECORDING, 4500);
    CHECK(max_ui_question_quiet("c", "r3", "Push?", NULL, 0, false, false, 5000));
    CHECK(max_m.toast_id[0] == 0 && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 5100);
    // c's next question rings and takes the page; answered on the computer, the quiet ones do not take it after.
    CHECK(max_ui_question("c", "r4", "Push now?", NULL, 0, false, false, 6000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c"));
    max_ui_question_close("c");
    max_ui_tick(7000);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(max_find("a")->state == MAX_ASKING && max_find("b")->state == MAX_ASKING);
    // A quiet one that is asked again (a new question of b's) rings: it takes the page.
    CHECK(max_ui_question("b", "r5", "Merge now?", NULL, 0, false, false, 8000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "b"));
}

// Ambient: with no computer, with no agents, and on Overview when nothing works or waits and nobody touched for
// MAX_AMBIENT_MS. A turn that starts or an agent that needs the person leaves it.
static void test_ambient(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    CHECK(max_m.view == MAX_VIEW_AMBIENT);
    roster(ABC, 3);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    as_drawn(0);
    CHECK(max_ui_next_wake_ms(1000) == MAX_AMBIENT_MS - 1000);
    CHECK(!max_ui_tick(MAX_AMBIENT_MS - 1) && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(max_ui_tick(MAX_AMBIENT_MS) && max_m.view == MAX_VIEW_AMBIENT);
    // A turn that starts: Overview. While it works, no Ambient however long nobody touches.
    uint32_t t = 70000;
    CHECK(max_ui_turn("a", "started", "", 0, t) && max_m.view == MAX_VIEW_OVERVIEW);
    as_drawn(t);
    CHECK(max_ui_next_wake_ms(t) == MAX_WAKE_MS);
    max_ui_tick(t + 10 * MAX_AMBIENT_MS);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    // It ends: the wait starts from then.
    t = 800000;
    max_ui_turn("a", "done", "", 0, t);
    CHECK(!max_ui_tick(t + MAX_AMBIENT_MS - 1) && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(max_ui_tick(t + MAX_AMBIENT_MS) && max_m.view == MAX_VIEW_AMBIENT);
    // A question: Attention.
    t = 900000;
    max_ui_question("b", "r1", "Push?", NULL, 0, false, false, t);
    CHECK(max_m.view == MAX_VIEW_ATTENTION);
    max_ui_question_close("b");
    max_ui_turn("b", "done", "", 0, t);
    max_ui_tick(t);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    // A touch is a person at the bar: the wait starts from the lift.
    t = 1000000;
    max_ui_touch(true, 5, 5, t);
    max_ui_touch(false, 5, 5, t + 90);
    CHECK(max_m.idle_from == t + 90);
    CHECK(!max_ui_tick(t + 90 + MAX_AMBIENT_MS - 1) && max_ui_tick(t + 90 + MAX_AMBIENT_MS));
    CHECK(max_m.view == MAX_VIEW_AMBIENT);
    // Only Overview goes: another page stays, however long.
    max_show(MAX_VIEW_INBOX);
    max_ui_tick(t + 10 * MAX_AMBIENT_MS);
    CHECK(max_m.view == MAX_VIEW_INBOX);
    // Nor while a recording or New Harness is up.
    max_show(MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_RECORDING, t);
    max_ui_tick(t + 20 * MAX_AMBIENT_MS);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, t);
    CHECK(max_ui_form_open("form-1", t));
    max_ui_tick(t + 20 * MAX_AMBIENT_MS);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    max_form_dismiss();
    CHECK(max_ui_tick(t + 20 * MAX_AMBIENT_MS) && max_m.view == MAX_VIEW_AMBIENT);
    // The ring empties: Ambient at once. Agents again: Overview, waiting from then.
    t = 3000000;
    max_show(MAX_VIEW_OVERVIEW);
    roster(NULL, 0);
    CHECK(max_m.view == MAX_VIEW_AMBIENT);
    const pro_agent_row_t row = {"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL};
    CHECK(max_ui_agents(&row, 1, t) && max_m.view == MAX_VIEW_OVERVIEW && max_m.idle_from == t);
    // The link goes: Ambient at once, from any page.
    max_show(MAX_VIEW_APPS);
    CHECK(max_ui_link(false, NULL, t) && max_m.view == MAX_VIEW_AMBIENT);
}

// The demo (max_ui_demo, kept over max_ui_reset as the program's mode): when the link comes up and its first ring has
// nothing at work or waiting, Ambient at once rather than a quiet minute later, and its first tap opens Apps (V3
// restNow(wakeToApps)). Leaving that Ambient any other way forgets it, a turn that starts at once too; without the
// demo, the first ring is Overview as always.
static void test_demo_rests_at_once(void)
{
    max_ui_demo(true);
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    CHECK(max_m.view == MAX_VIEW_AMBIENT);
    roster(ABC, 3);
    CHECK(max_m.view == MAX_VIEW_AMBIENT && max_m.wake_to_apps);
    // Only the first ring after the link came up.
    max_show(MAX_VIEW_OVERVIEW);
    CHECK(!max_m.wake_to_apps);
    roster(ABCDE, 5);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    // Left another way (a turn that starts): forgotten.
    max_ui_link(false, NULL, 1000);
    max_ui_link(true, "MacBook Pro", 1000);
    roster(ABC, 3);
    CHECK(max_m.view == MAX_VIEW_AMBIENT && max_m.wake_to_apps);
    max_ui_turn("a", "started", "", 0, 2000);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && !max_m.wake_to_apps);
    max_show(MAX_VIEW_AMBIENT);
    CHECK(!max_m.wake_to_apps);
    // The link goes with it.
    max_ui_link(false, NULL, 3000);
    max_ui_link(true, "MacBook Pro", 3000);
    roster(ABC, 3);
    max_ui_link(false, NULL, 3000);
    CHECK(!max_m.wake_to_apps);
    // Not the demo: the first ring is Overview.
    max_ui_demo(false);
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    roster(ABC, 3);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && !max_m.wake_to_apps);
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

// The open agent draws no clock and no "ago" (App Detail): neither the agent page nor Overview wakes the render task
// for a turn's seconds or minutes.
static void test_agent_page_clock(void)
{
    linked(XS, 3);
    max_ui_turn("x1", "started", "", 0, 1000);
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1500) == MAX_WAKE_MS && !max_ui_tick(5000));
    max_open("x1");
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1500) == MAX_WAKE_MS && !max_ui_tick(2000) && !max_ui_tick(5000));
    max_ui_summary("x1", "Done it", NULL, false, POD_TIER_LIST, 4000);
    as_drawn(4000);
    CHECK(max_ui_next_wake_ms(34000) == MAX_WAKE_MS && !max_ui_tick(64000));
}

// While a recording is up the band redraws every MAX_TALK_FRAME_MS, and the render task wakes for what the clock owes
// it: the mic closing when nothing was heard, else the send at MAX_TALK_MAX_MS (the quiet after speech owes nothing).
static void test_recording_clock(void)
{
    linked(ABC, 3);
    roster_of(ABC, 3, "gemini");
    max_copy(max_m.selected, sizeof max_m.selected, "a");
    max_show(MAX_VIEW_AGENT);
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "a");
    CHECK(max_ui_talk(MAX_TALK_RECORDING, 1000) && max_m.talk_from == 1000 && !max_m.talk_heard);
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1000) == MAX_TALK_FRAME_MS);
    CHECK(!max_ui_tick(1000 + MAX_TALK_FRAME_MS - 1) && max_ui_tick(1000 + MAX_TALK_FRAME_MS));
    CHECK(max_ui_next_wake_ms(1000 + MAX_HEAR_MS - 30) == 30);
    // Speech: the waveform takes each level, and the clock owes nothing for the quiet after it, nor the close.
    CHECK(max_ui_level(3, 1200) && max_m.talk_heard);
    CHECK(max_ui_level(9, 1300) && max_m.levels[max_m.level_count - 1] == 4);   // past the scale: its top
    CHECK(max_ui_level(1, 1400) && max_m.talk_heard && max_m.level_count == 3);
    CHECK(max_ui_next_wake_ms(1300 + 2500 - 40) > 40);   // 2.5 s of quiet sent it before (20 Nov)
    CHECK(max_ui_next_wake_ms(1000 + MAX_HEAR_MS - 30) > 30);
    // Speech that never stops: the send is due at MAX_TALK_MAX_MS all the same.
    max_ui_level(3, 1000 + MAX_TALK_MAX_MS - 100);
    CHECK(max_ui_next_wake_ms(1000 + MAX_TALK_MAX_MS - 40) == 40);
    for (int i = 0; i < MAX_LEVELS + 5; i++) max_ui_level(0, 1500);
    CHECK(max_m.level_count == MAX_LEVELS && max_m.levels[0] == 0);
    // Not recording: no levels, no frames.
    max_ui_talk(MAX_TALK_SENDING, 2000);
    CHECK(!max_ui_level(3, 2000));
    as_drawn(2000);
    CHECK(max_ui_next_wake_ms(2000) == MAX_WAKE_MS && !max_ui_tick(2000 + MAX_TALK_FRAME_MS));
    // A new recording starts its own clock, nothing heard, and "Mic closed" goes.
    max_m.talk_closed = true;
    CHECK(max_ui_talk(MAX_TALK_RECORDING, 5000) && max_m.talk_from == 5000 && !max_m.talk_heard && !max_m.level_count);
    CHECK(!max_m.talk_closed);
    // "Mic closed" belongs to the page it closed on.
    max_m.talk_closed = true;
    CHECK(max_show(MAX_VIEW_OVERVIEW) && !max_m.talk_closed);
}

// A send's page (the Pro's voice screen): max_send_begin holds the SEND scene on the agent's own page only. The send
// settles once the scene has played (max_pet_send_ms) and the words were taken or the agent's turn began, at once on
// an error, or at MAX_SENT_WAIT_MS with neither: then the pane shrinks back into Overview, its cell showing what the
// agent does now (the owner, 20 Nov). Taken, the agent works on the bar's word alone until a turn event, else goes back
// to what it was at MAX_SENT_WAIT_MS. The page left, another agent opened or the agent gone: let go where it is.
static void test_send_hold(void)
{
    linked(ABC, 3);
    roster_of(ABC, 3, "claude");
    const uint32_t play = max_pet_send_ms("claude");
    CHECK(play >= 500 && play < 5000);       // Claude's letter into the mailbox, on the beat
    CHECK(max_pet_send_ms("cursor") == 0);   // a pet-less engine plays none
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "a");
    max_show(MAX_VIEW_OVERVIEW);
    max_send_begin(100);   // not its page: nothing held
    CHECK(!max_m.sending);
    max_open("a");
    max_send_begin(1000);
    CHECK(max_send_holds("a") && !max_send_holds("b") && max_m.send_from == 1000 && max_m.send_play_ms == play);
    CHECK(max_pet_scene(max_find("a"), true) == POD_SCENE_SEND);
    CHECK(max_pet_scene(max_find("a"), false) != POD_SCENE_SEND);   // a cell plays its state
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1000 + play - 20) <= 20);
    // Played, but nothing taken and no turn: it holds, until MAX_SENT_WAIT_MS shrinks it back.
    CHECK(!max_ui_tick(1000 + play) || max_send_holds("a"));
    CHECK(max_send_holds("a"));
    as_drawn(1000 + play);
    CHECK(max_ui_next_wake_ms(1000 + MAX_SENT_WAIT_MS - 20) <= 20);
    CHECK(!max_ui_tick(1000 + MAX_SENT_WAIT_MS - 1) || max_send_holds("a"));
    CHECK(max_send_holds("a") && max_m.view == MAX_VIEW_AGENT);
    CHECK(max_ui_tick(1000 + MAX_SENT_WAIT_MS) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    // A turn begun after the tap, though no reply came: the scene plays out, then the pane shrinks back.
    max_open("a");
    max_send_begin(40000);
    max_ui_turn("a", "started", "", 0, 40000 + play / 2);
    CHECK(max_send_holds("a") && max_m.view == MAX_VIEW_AGENT);
    CHECK(max_ui_tick(40000 + play) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_turn("a", "done", "", 0, 41000 + play);
    // The words taken: Working at once on the bar's word alone, the page on SEND until the scene has played; then the
    // pane shrinks back and the cell works, "Starting..." until a turn event says more.
    max_open("a");
    max_send_begin(50000);
    CHECK(max_ui_voice_result(true, "a", 50400));
    max_agent_t *a = max_find("a");
    CHECK(a->state == MAX_WORKING && a->sent && a->sent_was == MAX_DONE && max_send_holds("a"));
    CHECK(!strcmp(max_summary(a), "Starting\xe2\x80\xa6"));   // no word of its own yet
    as_drawn(50400);
    CHECK(max_ui_next_wake_ms(50000 + play - 10) <= 10);
    CHECK(!max_ui_tick(50000 + play - 1) || max_send_holds("a"));
    CHECK(max_send_holds("a") && max_m.view == MAX_VIEW_AGENT);
    CHECK(max_ui_tick(50000 + play) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW && a->sent);
    CHECK(max_pet_scene(a, false) == POD_SCENE_WORK);   // its cell works
    CHECK(max_ui_turn("a", "activity", "Reading", -1, 50100 + play) && !a->sent && a->state == MAX_WORKING);
    max_ui_turn("a", "done", "", 0, 51000 + play);
    // The scene played before the words were taken: the reply shrinks it back at once. Then no turn event: Working
    // ends at MAX_SENT_WAIT_MS from the reply.
    max_open("a");
    max_send_begin(60000);
    max_ui_tick(60000 + play + 500);
    CHECK(max_send_holds("a"));
    const uint32_t took = 60000 + play + 600;
    CHECK(max_ui_voice_result(true, "a", took) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    as_drawn(took);
    CHECK(max_ui_next_wake_ms(took + MAX_SENT_WAIT_MS - 30) <= 30);
    max_ui_tick(took + MAX_SENT_WAIT_MS - 1);
    CHECK(a->sent && a->state == MAX_WORKING);
    CHECK(max_ui_tick(took + MAX_SENT_WAIT_MS) && !a->sent && a->state == MAX_DONE);
    // Words the daemon routed to another agent still went: that one works, and the page shrinks back once played.
    max_open("a");
    max_send_begin(100000);
    max_ui_voice_result(true, "c", 100300);
    CHECK(max_find("c")->state == MAX_WORKING && max_find("c")->sent && max_send_holds("a") && max_m.sent_seen);
    CHECK(max_find("a")->state != MAX_WORKING);   // not on the bar's word: they did not go to it
    CHECK(max_ui_tick(100000 + play) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    // Taken with no agent named: the same.
    max_open("a");
    max_send_begin(101000);
    max_ui_voice_result(true, "", 101300);   // nothing on the glass changes yet
    CHECK(max_send_holds("a") && max_m.sent_seen);
    CHECK(max_ui_tick(101000 + play) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    // An error shrinks it back at once; with nothing held, nothing changes.
    max_open("a");
    max_send_begin(102000);
    CHECK(max_ui_voice_result(false, NULL, 102100) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(!max_ui_voice_result(false, NULL, 102200));
    // Its turn began and the scene played while the reply is still awaited: the pane shrinks back anyway; a recording
    // begun on the page keeps it there.
    max_open("a");
    max_send_begin(103000);
    max_ui_talk(MAX_TALK_SENDING, 103000);
    max_ui_turn("a", "started", "", 0, 103100);
    CHECK(max_ui_tick(103000 + play) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 103000 + play);
    max_ui_turn("a", "done", "", 0, 103100 + play);
    max_open("a");
    max_send_begin(104000);
    max_ui_talk(MAX_TALK_RECORDING, 104000);
    CHECK(max_ui_voice_result(false, NULL, 104100) && !max_send_holds("a") && max_m.view == MAX_VIEW_AGENT);
    max_ui_talk(MAX_TALK_IDLE, 104200);
    // The page left, another agent opened, the agent gone: let go where it is.
    max_open("a");
    max_send_begin(110000);
    max_show(MAX_VIEW_APPS);
    CHECK(!max_m.sending);
    max_open("a");
    max_send_begin(110100);
    max_open("b");
    CHECK(!max_m.sending && max_m.view == MAX_VIEW_AGENT && !strcmp(max_m.selected, "b"));
    max_open("a");
    max_send_begin(110200);
    roster_of((const char *const[]){"b", "c"}, 2, "claude");
    max_ui_tick(110300);
    CHECK(!max_m.sending && max_m.view == MAX_VIEW_OVERVIEW);   // its page went with it
    // A pet-less engine's send: the words taken shrink it back at once.
    roster_of(ABC, 3, "cursor");
    max_open("a");
    max_send_begin(120000);
    CHECK(max_send_holds("a") && max_m.send_play_ms == 0);
    CHECK(max_ui_voice_result(true, "a", 120300) && !max_send_holds("a") && max_m.view == MAX_VIEW_OVERVIEW);
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
    static const struct { uint32_t ms; const char *want; } ago[] = {
        {0, "just now"}, {59999, "just now"}, {60000, "1m ago"}, {3599999, "59m ago"}, {3600000, "1h ago"},
        {86399999, "23h ago"}, {86400000, "1d ago"}, {3 * 86400000u, "3d ago"}};
    for (unsigned i = 0; i < sizeof ago / sizeof ago[0]; i++) {
        max_fmt_ago(t, sizeof t, 5000, 5000 + ago[i].ms);
        CHECK(!strcmp(t, ago[i].want));
    }
}

// `apps`: Harness first, as V3 lists it. The window's tab names Harness shown in a list that leaves it out
// (cableHost.ts tabApps): the bar adds it, its count the ring's. The computer turning the bar to another app says so
// ("Following <App> on your Mac"): not for the first list, not for the app the person picked, not while they talk.
static void test_apps(void)
{
    linked(ABC, 3);
    const pro_app_row_t rows[] = {{"orca", "Orca", 2, 1}, {"harness", "Harness", 3, 0}, {"cmux", "", 1, 0}};
    CHECK(max_ui_apps("orca", rows, 3, 100));
    CHECK(max_m.app_count == 3 && !strcmp(max_m.apps[0].id, "harness") && !strcmp(max_m.apps[1].id, "orca"));
    CHECK(!strcmp(max_m.apps[2].id, "cmux") && !strcmp(max_m.apps[2].name, "cmux"));   // no name: the daemon's
    CHECK(!max_notice_shown(100));   // the first list: nothing followed
    // The tab: Harness shown, left out of the list.
    const pro_app_row_t tab[] = {{"orca", "Orca", 2, 1}};
    CHECK(max_ui_apps("harness", tab, 1, 200));
    CHECK(max_m.app_count == 2 && !strcmp(max_m.apps[0].id, "harness") && !strcmp(max_m.apps[0].name, "Harness"));
    CHECK(max_m.apps[0].count == 3 && !strcmp(max_shown_app()->name, "Harness") && !strcmp(max_m.apps[1].id, "orca"));
    CHECK(max_notice_shown(200) && !strcmp(max_m.notice, "Following Harness on your Mac"));
    CHECK(!max_ui_apps("harness", tab, 1, 250));   // the same list again
    roster(ABCDE, 5);   // its count follows the ring
    CHECK(max_m.apps[0].count == 5);
    // A full list: Harness takes the first place, the last row goes.
    static char ids[PRO_APPS_MAX][8];
    pro_app_row_t full[PRO_APPS_MAX];
    for (int i = 0; i < PRO_APPS_MAX; i++) {
        snprintf(ids[i], sizeof ids[i], "app%d", i);
        full[i] = (pro_app_row_t){ids[i], ids[i], 1, 0};
    }
    CHECK(max_ui_apps("harness", full, PRO_APPS_MAX, 300) && max_m.app_count == PRO_APPS_MAX);
    CHECK(!strcmp(max_m.apps[0].id, "harness") && !strcmp(max_m.apps[PRO_APPS_MAX - 1].id, ids[PRO_APPS_MAX - 2]));
    // The person picks Orca: the daemon turning to it is no news.
    max_ui_app_picked("orca");
    max_ui_notice(NULL, 0, 400);
    CHECK(max_ui_apps("orca", rows, 3, 400) && !max_notice_shown(400));
    // The computer turns it to cmux, then back to Orca (the pick is spent): followed, by the app's name.
    CHECK(max_ui_apps("cmux", rows, 3, 500) && !strcmp(max_m.notice, "Following cmux on your Mac"));
    CHECK(max_ui_apps("orca", rows, 3, 600) && !strcmp(max_m.notice, "Following Orca on your Mac"));
    // Not over a person talking.
    max_ui_notice(NULL, 0, 700);
    max_ui_talk(MAX_TALK_RECORDING, 700);
    CHECK(max_ui_apps("harness", rows, 3, 800) && !max_notice_shown(800));
    max_ui_talk(MAX_TALK_IDLE, 900);
    // The link goes and the apps with it: the next list is a first one again.
    max_ui_link(false, NULL, 1000);
    CHECK(!max_m.apps_known && max_m.app_count == 0 && !max_m.shown[0]);
    max_ui_link(true, "MacBook Pro", 1100);
    CHECK(max_ui_apps("cmux", rows, 3, 1200) && !max_notice_shown(1200));
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
    test_row_scrolls();
    test_row_holds_while_open();
    test_row_front_if_passed();
    test_focus_changes_no_page();
    test_questions_take_attention_oldest_first();
    test_turn_ends_take_attention();
    test_done_note();
    test_inbox();
    test_quiet_question();
    test_ambient();
    test_demo_rests_at_once();
    test_caps();
    test_no_talk_while_an_answer_waits();
    test_agent_page_clock();
    test_recording_clock();
    test_send_hold();
    test_elapsed_format();
    test_apps();
    test_app_state();
    printf("test_max_model: %d checks passed\n", checks);
    return 0;
}
