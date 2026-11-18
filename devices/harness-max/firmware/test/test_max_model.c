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
    CHECK(max_m.count == 0 && max_m.machine_count == 0 && max_m.cell_page == 0);
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

// Overview's cells: five a page, in the ring's order; the page stays within the pages there are.
static void test_cell_pages(void)
{
    enum { N = 2 * MAX_CELLS + 1 };
    linked(XS, N);
    int c[MAX_CELLS];
    CHECK(max_cell_pages() == 3 && max_m.cell_page == 0);
    CHECK(max_cells(c) == MAX_CELLS && c[0] == 0 && c[MAX_CELLS - 1] == MAX_CELLS - 1);
    max_m.cell_page = 2;
    CHECK(max_cells(c) == 1 && c[0] == N - 1);
    // A question on the second page: its dot is yellow, and only its.
    max_ui_question(XS[MAX_CELLS + 1], "r1", "Ok?", NULL, 0, false, false, 0);
    CHECK(!max_page_waits(0) && max_page_waits(1) && !max_page_waits(2));
    // Fewer agents: the page comes back within the pages there are.
    roster(XS, MAX_CELLS + 1);
    CHECK(max_cell_pages() == 2 && max_m.cell_page == 1);
    roster(XS, 2);
    CHECK(max_cell_pages() == 1 && max_m.cell_page == 0);
    // Another app's ring starts on its first page.
    roster(XS, N);
    max_m.cell_page = 2;
    const pro_app_row_t apps[] = {{"orca", "Orca", N, 0}, {"vscode", "VS Code", 2, 0}};
    CHECK(max_ui_apps("orca", apps, 2, 0) && max_m.cell_page == 0);
    max_m.cell_page = 2;
    CHECK(!max_ui_apps("orca", apps, 2, 0) && max_m.cell_page == 2);   // the same app: the page stays
    CHECK(max_ui_apps("vscode", apps, 2, 0) && max_m.cell_page == 0);
    roster(NULL, 0);
    CHECK(max_cell_pages() == 0 && max_m.cell_page == 0);
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

// A failed turn and an alert's summary take Attention (red, green) and go back to Overview by themselves; a quieter
// summary or history does not. A question replaces a turn's end on the page; a turn's end waits in Inbox behind a
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
    // An alert's summary: done.
    max_ui_turn("e", "started", "", 0, 12000);
    CHECK(max_ui_summary("e", "Fixed the login race", NULL, false, POD_TIER_ALERT, 13000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "e") && max_m.attn == MAX_ATTN_DONE);
    // One with nothing to say ends the turn, and is no news.
    max_ui_turn("d", "started", "", 0, 13000);
    CHECK(max_ui_summary("d", NULL, NULL, false, POD_TIER_ALERT, 13500));
    CHECK(max_find("d")->state == MAX_DONE && !strcmp(max_m.attn_id, "e") && max_m.inbox_count == 2);
    // A question replaces a turn's end on the page.
    CHECK(max_ui_question("b", "r1", "Push?", NULL, 0, false, false, 14000));
    CHECK(!strcmp(max_m.attn_id, "b") && max_m.attn == MAX_ATTN_ASK && max_m.attn_from == 14000);
    // A turn's end while another agent's question is up: Inbox only.
    max_ui_turn("c", "started", "", 0, 14500);
    CHECK(max_ui_turn("c", "error", "boom", 0, 15000));
    CHECK(!strcmp(max_m.attn_id, "b") && !strcmp(max_m.inbox[0].id, "c") && max_m.inbox[0].kind == MAX_ATTN_FAIL);
    // A done page whose agent starts again is over at once.
    max_ui_question_close("b");
    max_ui_tick(16000);
    CHECK(max_ui_summary("e", "Fixed it again", NULL, false, POD_TIER_ALERT, 17000) && !strcmp(max_m.attn_id, "e"));
    CHECK(max_ui_turn("e", "started", "", 0, 18000) && max_m.view == MAX_VIEW_OVERVIEW);
    // So is a failed page whose agent leaves the ring.
    max_ui_turn("e", "error", "boom", 0, 19000);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "e"));
    roster(ABCDE, 4);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
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
    // No `apps` yet: a notice names the agent's own app (its host).
    CHECK(max_ui_question("a", "r1", "Keep the dark gradient?", NULL, 0, false, false, 1000));
    const max_inbox_t *n = &max_m.inbox[0];
    CHECK(max_m.inbox_count == 1 && !strcmp(n->id, "a") && !strcmp(n->name, "alpha") && !strcmp(n->engine, "codex"));
    CHECK(!strcmp(n->app, "orca") && n->kind == MAX_ATTN_ASK && !strcmp(n->text, "Keep the dark gradient?"));
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

// The agent page draws its agent's clock while it works, else how long ago its state changed: the render task wakes
// for each, and Overview draws neither.
static void test_agent_page_clock(void)
{
    linked(XS, 3);
    max_ui_turn("x1", "started", "", 0, 1000);
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1500) == MAX_WAKE_MS && !max_ui_tick(5000));
    max_copy(max_m.selected, sizeof max_m.selected, "x1");
    max_show(MAX_VIEW_AGENT);
    as_drawn(1000);
    CHECK(max_ui_next_wake_ms(1500) == 500 && !max_ui_tick(1999) && max_ui_tick(2000));
    // Done: "just now", then "1m ago" as its summary stops showing, then each minute.
    max_ui_summary("x1", "Done it", NULL, false, POD_TIER_LIST, 4000);
    as_drawn(4000);
    CHECK(max_ui_next_wake_ms(34000) == 30000);
    CHECK(!max_ui_tick(63999) && max_ui_tick(64000));
    as_drawn(64000);
    CHECK(!max_ui_tick(123999) && max_ui_tick(124000));
}

// While a recording is up the band redraws every MAX_TALK_FRAME_MS, and the render task wakes for what the clock owes
// it: the send after the quiet, or the mic closing when nothing was heard.
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
    // Speech: the waveform takes each level, and the send is due MAX_SILENCE_MS after the last of it.
    CHECK(max_ui_level(3, 1200) && max_m.talk_heard && max_m.talk_quiet_from == 1200);
    CHECK(max_ui_level(9, 1300) && max_m.levels[max_m.level_count - 1] == 4);   // past the scale: its top
    CHECK(max_ui_level(1, 1400) && max_m.talk_quiet_from == 1300 && max_m.level_count == 3);
    CHECK(max_ui_next_wake_ms(1300 + MAX_SILENCE_MS - 40) == 40);
    for (int i = 0; i < MAX_LEVELS + 5; i++) max_ui_level(0, 1500);
    CHECK(max_m.level_count == MAX_LEVELS && max_m.levels[0] == 0);
    // Not recording: no levels, no frames.
    max_ui_talk(MAX_TALK_SENDING, 2000);
    CHECK(!max_ui_level(3, 2000));
    as_drawn(2000);
    CHECK(max_ui_next_wake_ms(2000) == 60000 - 2000 && !max_ui_tick(2000 + MAX_TALK_FRAME_MS));
    // A new recording starts its own clock, nothing heard.
    CHECK(max_ui_talk(MAX_TALK_RECORDING, 5000) && max_m.talk_from == 5000 && !max_m.talk_heard && !max_m.level_count);
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
    test_cell_pages();
    test_focus_changes_no_page();
    test_questions_take_attention_oldest_first();
    test_turn_ends_take_attention();
    test_inbox();
    test_ambient();
    test_caps();
    test_no_talk_while_an_answer_waits();
    test_agent_page_clock();
    test_recording_clock();
    test_elapsed_format();
    test_app_state();
    printf("test_max_model: %d checks passed\n", checks);
    return 0;
}
