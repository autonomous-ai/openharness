// The finger on the pages: what a tap or a sideways swipe does on each page, and what the clock owes a recording. The
// targets are planted as the pages record them (max_test.h), never drawn: the drawing's layout is its own. While a
// recording is up the glass is its send: X cancels, any other tap sends (a sliver too); only the Dial's tap counts
// then, and a voice action's guard takes the touches right after it.
#include "max_test.h"
#include "max_ui_motion.h"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
// More agents than two pages of cells hold.
static const char *const XS[] = {"x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x10", "x11"};
_Static_assert(2 * MAX_CELLS + 1 <= sizeof XS / sizeof XS[0], "XS holds more than two pages of cells");

static bool near_px(int got, int want)
{
    if (got >= want - 1 && got <= want + 1) return true;
    fprintf(stderr, "  got %d px, want %d\n", got, want);
    return false;
}
// The finger's clock: each touch a second after the last, past the guard a voice action leaves (MAX_GUARD_MS).
static uint32_t T;
static max_act_t tap_at(int x, int y, uint32_t now)
{
    max_ui_touch(true, x, y, now);
    max_ui_touch(true, x + 3, y - 2, now + 40);   // a finger never holds still
    return max_ui_touch(false, x + 3, y - 2, now + 90);
}
static max_act_t tap(int x, int y)
{
    T += 1000;
    return tap_at(x, y, T);
}
static max_act_t drag(int x, int y, int dx, int dy)
{
    T += 1000;
    max_ui_touch(true, x, y, T);
    for (int k = 1; k <= 4; k++) max_ui_touch(true, x + dx * k / 4, y + dy * k / 4, T + (uint32_t)k * 30);
    return max_ui_touch(false, x + dx, y + dy, T + 150);
}
// A touch from `at`, let go `ms` later at (dx, dy) from where it went down.
static max_act_t press_for(int x, int y, int dx, int dy, uint32_t at, uint32_t ms)
{
    max_ui_touch(true, x, y, at);
    max_ui_touch(true, x + dx, y + dy, at + ms / 2);
    return max_ui_touch(false, x + dx, y + dy, at + ms);
}
static max_act_t tap_on(const max_hit_t *h) { return tap(h->x + h->w / 2, h->y + h->h / 2); }
static max_act_t tap_box(const max_box_t *b) { return tap(b->x + b->w / 2, b->y + b->h / 2); }
// Where no button is: on a page-wide target when one is planted.
static max_act_t tap_page(void) { return tap(HT_WIDTH / 2, HT_HEIGHT - 20); }
static max_act_t swipe_left(void) { return drag(HT_WIDTH / 2, HT_HEIGHT / 2, -200, 10); }
static max_act_t swipe_right(void) { return drag(HT_WIDTH / 2, HT_HEIGHT / 2, 200, 10); }

static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;
static int take(uint32_t now) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, now); }
static const pro_ask_item_t DB = {"db", "Which database?", {"Dev", "Staging"}, 2, false, true};
static const pro_ask_item_t DEPLOY = {"perm", "Approve Bash command: npm run deploy", {"Yes", "No"}, 2, false, true};

static bool noticed(const char *text) { return max_notice_shown(0) && !strcmp(max_m.notice, text); }
static void no_notice(void) { max_ui_notice(NULL, 0, 0); }

// ---- the pages as drawn ----
static void overview_drawn(void)
{
    drawn_page(MAX_VIEW_OVERVIEW);
    plant(MAX_HIT_BELL, 0);
    plant_cells();
}
// The open agent (max_m.selected) as App Detail draws it: its X, the slivers beside it, its panel (the body), which
// lies clear of the slivers.
static void agent_drawn(void)
{
    CHECK(max_m.view == MAX_VIEW_AGENT);
    drawn_page(MAX_VIEW_AGENT);
    plant(MAX_HIT_AGENT_X, 0);
    plant_slivers();
    plant_at(MAX_HIT_BODY, 0, 0, 320, HT_WIDTH, HT_HEIGHT - 320);
}
static const max_hit_t *x_of_agent(void) { return &max_m.hits[0]; }
// This agent open across the row, as a cell's tap would open it, the mic closed.
static void agent_page(const char *id)
{
    max_open(id);
    agent_drawn();
}
// Attention: `options` answers and Say it when asked for, then the rest of the page.
static void attention_drawn(int options, bool say)
{
    CHECK(max_m.view == MAX_VIEW_ATTENTION);
    drawn_page(MAX_VIEW_ATTENTION);
    plant_card();
    for (int i = 0; i < options; i++) plant(MAX_HIT_OPTION, i);
    if (say) plant(MAX_HIT_SAY_IT, 0);
    plant_page(MAX_HIT_AWAY);
}
// A recording for the agent page's agent, words heard or not.
static void recording(bool heard)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, max_m.selected);
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    if (heard) max_ui_level(3, 0);
    agent_drawn();
}

// ---- Overview ----

// One tap on a cell: an agent that asks opens Attention; one that takes voice opens its page with the mic on (the
// computer opens it too); any other opens its page with the mic closed.
static void test_cell_tap(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    const pro_agent_row_t rows[] = {{"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"b", "b", "codex", "m1", "MacBook Pro", "orca", "sf"},
                                    {"c", "c", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"d", "d", "claude", "m1", "MacBook Pro", NULL, NULL}};
    max_ui_agents(rows, 4, 0);
    overview_drawn();
    max_act_t act = tap_box(cell_of("a"));
    CHECK(act.kind == MAX_ACT_OPEN_TALK && !strcmp(act.agent_id, "a") && !strcmp(max_m.talk_id, "a"));
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "a") && max_m.dirty);
    // No voice (caps without v): its page, and the computer opens it ("Talk to it in <App>").
    max_m.talk_id[0] = 0;
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    act = tap_box(cell_of("b"));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b") && max_m.talk_id[0] == 0);
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "b"));
    // An agent that asks: its question on Attention, nothing recorded or sent.
    max_ui_question("c", "r1", DB.q, &DB, 1, false, false, 0);
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    act = tap_box(cell_of("c"));
    CHECK(act.kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c"));
    CHECK(max_m.attn == MAX_ATTN_ASK && max_m.talk_id[0] == 0);
    // While the last words are still being sent the page opens with the mic closed.
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    max_m.row_first = max_row_last();   // scrolled to its end: c a b d, d the row's last
    overview_drawn();
    max_ui_talk(MAX_TALK_SENDING, 0);
    act = tap_box(cell_of("d"));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(max_ui_selected(), "d"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    // A cell whose agent left the ring since it was drawn opens nothing; nor does the space between cells.
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    const max_box_t gone = *cell_of("d");
    max_ui_agents(rows, 3, 0);
    CHECK(tap_box(&gone).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(tap(max_m.cell_box[0].x + max_m.cell_box[0].w + 5, max_m.cell_box[0].y + 5).kind == MAX_ACT_NONE);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
}

static void test_drag_is_not_a_tap(void)
{
    linked(ABCDE, 5);
    overview_drawn();
    const max_box_t *b = cell_of("a");
    const int x = b->x + b->w / 2, y = b->y + b->h / 2;
    CHECK(drag(x, y, 0, MAX_TAP_SLOP + 6).kind == MAX_ACT_NONE);
    CHECK(drag(x, y, MAX_TAP_SLOP + 6, 0).kind == MAX_ACT_NONE);
    // Out and back within one contact is still a drag.
    max_ui_touch(true, x, y, 0);
    max_ui_touch(true, x, y + 60, 50);
    CHECK(max_ui_touch(false, x, y, 100).kind == MAX_ACT_NONE);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.row_first == 0);
    // A lift with no contact is nothing.
    CHECK(max_ui_touch(false, x, y, 200).kind == MAX_ACT_NONE);
}

// ---- the row under the finger (max_ui_row.c), on the row as a render lays it out ----

static int row_px(uint32_t now)
{
    static max_place_t at[MAX_AGENTS];
    int px;
    max_row_layout(now, at, &px);
    return px;
}
// App Detail with n agents at rest, drawn.
static void row_drawn(int n)
{
    linked(XS, n);
    max_show(MAX_VIEW_OVERVIEW);
    T += 1000;
    render(T);
}
// A drag from (x, y) at T + 1000: past the slop at 20 ms, then to dx by 40 ms; let go `rest` ms later. The row takes
// the finger from where it passed the slop (Flutter's DragStartBehavior.start): the row moves dx + 30.
static max_act_t drag_row(int x, int y, int dx, uint32_t rest)
{
    T += 1000;
    max_ui_touch(true, x, y, T);
    max_ui_touch(true, x + (dx < 0 ? -30 : 30), y, T + 20);
    max_ui_touch(true, x + dx, y, T + 40);
    return max_ui_touch(false, x + dx, y, T + 40 + rest);
}

// The row follows the finger px by px from where it passes the slop, within the row there is; a contact within the
// slop moves nothing. Every move asks for a frame.
static void test_drag_follows_the_finger(void)
{
    row_drawn(2 * MAX_CELLS + 1);   // seven: the row's last cells from 4
    const int x = ROW_X + 700, y = HT_HEIGHT / 2;
    T += 1000;
    max_ui_touch(true, x, y, T);
    max_ui_touch(true, x - MAX_TAP_SLOP, y, T + 20);
    CHECK(!max_m.row.drag && row_px(T + 20) == 0 && !max_m.dirty);
    max_ui_touch(true, x - 100, y, T + 40);
    CHECK(max_m.row.drag && row_px(T + 40) == 0 && max_m.dirty);
    max_ui_touch(true, x - 400, y, T + 60);
    CHECK(row_px(T + 60) == 300);
    render(T + 60);   // the first cell cut by the row's left end, and its hit with it
    CHECK(!strcmp(max_m.cell_id[0], "x0") && max_m.cell_box[0].x == ROW_X && max_m.cell_box[0].w == CELL_W - 300);
    CHECK(max_m.cell_hits == 4 && max_m.cell_box[3].x + max_m.cell_box[3].w == ROW_X + ROW_W);
    max_ui_touch(true, x + 200, y, T + 80);   // back past the row's start: it stops there
    CHECK(row_px(T + 80) == 0);
    max_ui_touch(true, x - 3000, y, T + 100);   // past its end: its last cells
    CHECK(row_px(T + 100) == 4 * CELL_W);
    // Not on the columns beside the row, nor over the form.
    row_drawn(7);
    drag_row(ROW_X - 20, y, -300, 0);
    drag_row(ROW_X + ROW_W + 10, y, -300, 0);
    CHECK(row_px(T + 500) == 0 && max_m.row_first == 0);
    max_ui_form_open("form-1", T);
    drag_row(x, y, -300, 0);
    CHECK(row_px(T + 500) == 0 && max_m.row_first == 0);
}

// Let go, the row settles on a cell's edge as V3's SnapPhysics: the nearest when the finger had stopped or was slow,
// the next one the way it went when flung, eased by kRowEase over 420 ms; row_first is that cell.
static void test_release_settles(void)
{
    row_drawn(7);
    const int x = ROW_X + 700, y = HT_HEIGHT / 2;
    CHECK(drag_row(x, y, -230, 60).kind == MAX_ACT_NONE);   // 200 px, then a rest before the lift: no fling
    CHECK(max_m.row_first == 0 && row_px(T + 100) == 200 && max_m.dirty);
    render(T + 100);
    CHECK(near_px(row_px(T + 310), 11) && row_px(T + 520) == 0 && max_motion_ms(T + 100) == MAX_ROW_FRAME_MS);
    drag_row(x, y, -330, 60);   // 300 px of 507, at rest: the nearer edge is the next cell's
    CHECK(max_m.row_first == 1 && row_px(T + 520) == CELL_W);
    // Flung: 200 px in 40 ms, let go at once, it goes on to the next cell; back the other way, to the one before.
    row_drawn(7);
    drag_row(x, y, -230, 10);
    CHECK(max_m.row_first == 1 && row_px(T + 50) == 200 && row_px(T + 470) == CELL_W);
    render(T + 470);
    drag_row(x, y, 130, 10);   // 100 px back from the first cell's edge: flung, to the row's start
    CHECK(max_m.row_first == 0 && row_px(T + 470) == 0);
    // A flick too short to be a fling (under 23 px in its last 100 ms) settles on the nearest edge.
    row_drawn(7);
    T += 1000;
    max_ui_touch(true, x, y, T);
    max_ui_touch(true, x - 30, y, T + 200);
    max_ui_touch(true, x - 230, y, T + 400);
    max_ui_touch(true, x - 245, y, T + 480);
    max_ui_touch(false, x - 245, y, T + 490);
    CHECK(max_m.row_first == 0 && row_px(T + 1000) == 0);
    // Three agents fill the row: it does not move.
    row_drawn(3);
    drag_row(x, y, -300, 10);
    CHECK(max_m.row_first == 0 && row_px(T + 50) == 0);
}

// Taps keep the Dial's rules while the row moves, and act on what the last render drew: a cell as it lies mid-settle,
// a sliver mid-carry; one within the guard of a voice action is part of it.
static void test_taps_while_moving(void)
{
    row_drawn(7);
    const int y = HT_HEIGHT / 2;
    drag_row(ROW_X + 700, y, -230, 10);   // flung to the next cell
    render(T + 150);
    const max_box_t *b = cell_of("x2");
    CHECK(b && max_row_moving(T + 150));
    CHECK(tap_at(b->x + b->w / 2, y, T + 160).kind == MAX_ACT_OPEN_TALK && !strcmp(max_ui_selected(), "x2"));
    // Opened by the model mid-carry, a sliver as drawn opens its own agent.
    row_drawn(7);
    max_open("x4");
    render(T + 1);
    render(T + 150);
    b = cell_of("x3");
    CHECK(b && max_row_moving(T + 150) && b->w < CELL_W && b->w > SLIVER_W);
    CHECK(tap_at(b->x + b->w / 2, y, T + 160).kind == MAX_ACT_OPEN_TALK && !strcmp(max_ui_selected(), "x3"));
    // Within the guard of the mic that tap opened, a tap on another agent is part of it; after, it opens.
    render(T + 300);
    b = cell_of("x4");
    CHECK(b && tap_at(b->x + b->w / 2, y, T + 320).kind == MAX_ACT_NONE && !strcmp(max_ui_selected(), "x3"));
    render(T + 1200);
    b = cell_of("x4");
    CHECK(tap_at(b->x + b->w / 2, y, T + 1220).kind == MAX_ACT_OPEN_TALK);
    CHECK(!strcmp(max_ui_selected(), "x4"));
}

// Open, the row follows a finger that starts on a sliver and rests where it is let go, a fling or not; a drag that
// starts on the open agent is its own: the row stays. While the mic is open a drag moves the row and nothing else:
// nothing is sent, nothing cancelled.
static void test_drag_while_open(void)
{
    row_drawn(7);
    max_open("x3");
    render(T + 1);
    render(T + 600);
    const int y = HT_HEIGHT / 2, at = row_px(T + 600);
    CHECK(at == 2 * SLIVER_W && max_m.row.open_l == ROW_X + SLIVER_W);
    drag_row(ROW_X + SLIVER_W + 300, y, -200, 10);   // on the open agent
    CHECK(row_px(T + 500) == at && !max_m.row.drag && max_m.view == MAX_VIEW_AGENT);
    drag_row(ROW_X + 50, y, 130, 10);   // on the sliver before it, flung: it rests 100 px on
    CHECK(row_px(T + 50) == at - 100 && row_px(T + 600) == at - 100 && !strcmp(max_ui_selected(), "x3"));
    render(T + 600);
    max_ui_talk(MAX_TALK_RECORDING, T + 600);
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "x3");
    take(0);
    CHECK(drag_row(ROW_X + 30, y, 230, 10).kind == MAX_ACT_NONE && row_px(T + 600) == at - 300);
    CHECK(max_m.talk == MAX_TALK_RECORDING && take(0) == 0 && max_m.view == MAX_VIEW_AGENT);
}

// Inbox as drawn: Close, then a card for each notice.
static void inbox_drawn(void)
{
    drawn_page(MAX_VIEW_INBOX);
    plant(MAX_HIT_CLOSE, 0);
    for (int i = 0; i < max_m.inbox_count; i++) plant(MAX_HIT_NOTE, i);
}
// The card of this agent's newest notice of this kind, as inbox_drawn() drew it.
static const max_hit_t *note_of(const char *id, max_attn_t kind)
{
    for (int i = 0; i < max_m.inbox_count; i++)
        if (!strcmp(max_m.inbox[i].id, id) && max_m.inbox[i].kind == kind) return &max_m.hits[1 + i];
    CHECK(!"no such notice");
    return &max_m.hits[0];
}

// The bell opens Inbox. A tap on a notice of an agent that still asks and is answered on the bar opens its Attention;
// any other brings its agent up on the computer (the daemon turns to its app) and says so. Leaving reads them all.
static void test_inbox(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    const pro_app_row_t apps[] = {{"orca", "Orca", 3, 2}};
    max_ui_apps("orca", apps, 1, 0);
    const pro_agent_row_t rows[] = {{"a", "a", "claude", "m1", "MacBook Pro", "orca", NULL},
                                    {"b", "b", "codex", "m1", "MacBook Pro", "orca", "sv"},
                                    {"c", "c", "claude", "m1", "MacBook Pro", "orca", NULL}};
    max_ui_agents(rows, 3, 0);
    max_ui_question("a", "r1", DB.q, &DB, 1, false, false, 0);
    max_ui_question("b", "r2", DB.q, &DB, 1, false, false, 10);   // b takes no answers on the bar
    max_ui_turn("c", "error", "boom", 0, 20);
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    CHECK(max_unread() == 3 && tap_on(&max_m.hits[0]).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_INBOX);
    inbox_drawn();
    CHECK(!strcmp(max_m.inbox[0].id, "c") && !strcmp(max_m.inbox[2].id, "a"));
    max_act_t act = tap_on(note_of("a", MAX_ATTN_ASK));
    CHECK(act.kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "a"));
    CHECK(max_unread() == 0);
    // b: answered on the computer only.
    max_ui_question("c", "r3", DB.q, &DB, 1, false, false, 30);   // unread again for the next look
    max_show(MAX_VIEW_INBOX);
    inbox_drawn();
    no_notice();
    act = tap_on(note_of("b", MAX_ATTN_ASK));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b") && noticed("b is up in Orca"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_unread() == 0);
    // c's failure, with c asking since: c is answered on the bar, so its notice opens its question.
    max_show(MAX_VIEW_INBOX);
    CHECK(tap_on(note_of("c", MAX_ATTN_FAIL)).kind == MAX_ACT_NONE && !strcmp(max_m.attn_id, "c"));
    // An agent gone from the ring: brought up on the computer by its id, under the name and app its notice kept.
    max_show(MAX_VIEW_INBOX);
    max_ui_agents(rows + 1, 2, 40);
    no_notice();
    act = tap_on(note_of("a", MAX_ATTN_ASK));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "a") && noticed("a is up in Orca"));
    // A notice past the cards there are opens nothing. Close: Overview.
    max_show(MAX_VIEW_INBOX);
    CHECK(tap_on(plant(MAX_HIT_NOTE, MAX_INBOX)).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_INBOX);
    CHECK(tap_on(&max_m.hits[0]).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    // No computer: nothing to bring up, and the notice says so.
    max_ui_link(false, NULL, 50);
    max_show(MAX_VIEW_INBOX);
    act = tap_on(note_of("a", MAX_ATTN_ASK));
    CHECK(act.kind == MAX_ACT_NONE && noticed("Not connected") && max_m.view == MAX_VIEW_INBOX);
}

// The app column opens Apps when the daemon lists them; a card picks its app (the daemon's next `apps` names it shown),
// unless it lists no agents: then Apps stays and says why (V3 pickApp). "+ New" names a form, Close goes back.
static void test_apps(void)
{
    linked(ABCDE, 3);
    max_ui_offers(true);
    overview_drawn();
    const max_hit_t *column = plant(MAX_HIT_APPS, 0);
    CHECK(tap_on(column).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);   // no `apps`: no Apps page
    const pro_app_row_t apps[] = {{"orca", "Orca", 3, 1}, {"vscode", "VS Code", 2, 0}, {"ghostty", "Ghostty", 0, 0}};
    max_ui_apps("orca", apps, 3, 0);
    CHECK(tap_on(column).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_APPS);
    drawn_page(MAX_VIEW_APPS);
    const max_hit_t *close = plant(MAX_HIT_CLOSE, 0), *orca = plant(MAX_HIT_APP, 0), *vscode = plant(MAX_HIT_APP, 1),
                    *ghostty = plant(MAX_HIT_APP, 2), *past = plant(MAX_HIT_APP, 3), *add = plant(MAX_HIT_NEW, 0);
    CHECK(tap_on(past).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_APPS);
    no_notice();
    CHECK(tap_on(ghostty).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_APPS && noticed("No agents in Ghostty"));
    max_act_t act = tap_on(vscode);
    CHECK(act.kind == MAX_ACT_PICK && !strcmp(act.app, "vscode") && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(!strcmp(max_m.shown, "orca"));   // until the daemon says otherwise
    max_show(MAX_VIEW_APPS);
    CHECK(tap_on(orca).kind == MAX_ACT_PICK && !strcmp(max_ui_touch(false, 0, 0, 0).app, ""));
    max_show(MAX_VIEW_APPS);
    CHECK(tap_on(add).kind == MAX_ACT_NEW && max_ui_form_open("form-1", 0));
    CHECK(tap_on(add).kind == MAX_ACT_NONE);   // one form at a time
    max_form_dismiss();
    CHECK(tap_on(close).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    // TEMP (the owner's call of 20 Nov, to try Ambient): Relax opens Ambient, only from Apps.
    max_show(MAX_VIEW_APPS);
    drawn_page(MAX_VIEW_APPS);
    const max_hit_t *relax = plant(MAX_HIT_RELAX, 0);
    max_m.view = MAX_VIEW_INBOX;   // a tap between a change and the redraw
    CHECK(tap_on(relax).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_INBOX);
    max_m.view = MAX_VIEW_APPS;
    CHECK(tap_on(relax).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_AMBIENT);
}

// Ambient: a tap anywhere is Overview, and a person at the bar. The demo's first Ambient (max_ui_demo, V3
// restNow(wakeToApps)) opens Apps instead, once, while there is another app to pick; with none, Overview.
static void test_ambient_wakes(void)
{
    linked(ABCDE, 3);
    max_show(MAX_VIEW_AMBIENT);
    drawn_page(MAX_VIEW_AMBIENT);
    plant_page(MAX_HIT_WAKE);
    CHECK(tap_at(10, 10, 5000).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW && max_m.idle_from == 5090);
    // The demo: the link up, its first ring all quiet: Ambient at once, whose tap opens Apps.
    max_ui_demo(true);
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    const pro_app_row_t apps[] = {{"harness", "Harness", 3, 0}, {"orca", "Orca", 2, 0}};
    max_ui_apps("orca", apps, 2, 0);
    roster(ABCDE, 3);
    CHECK(max_m.view == MAX_VIEW_AMBIENT);
    drawn_page(MAX_VIEW_AMBIENT);
    plant_page(MAX_HIT_WAKE);
    CHECK(tap_page().kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_APPS);
    // The next Ambient wakes to Overview, as always.
    max_show(MAX_VIEW_AMBIENT);
    drawn_page(MAX_VIEW_AMBIENT);
    plant_page(MAX_HIT_WAKE);
    CHECK(tap_page().kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    // Only the shown app listed: Overview.
    max_ui_link(false, NULL, 0);
    max_ui_link(true, "MacBook Pro", 0);
    max_ui_apps("orca", apps + 1, 1, 0);
    roster(ABCDE, 3);
    CHECK(max_m.view == MAX_VIEW_AMBIENT);
    drawn_page(MAX_VIEW_AMBIENT);
    plant_page(MAX_HIT_WAKE);
    CHECK(tap_page().kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_demo(false);
}

// ---- the open agent ----

// A tap on its panel opens the mic for it (one without voice is brought up on the computer instead). While it records,
// a tap on the panel sends at once, says so, and the row comes back. X drops the recording, says so when words were
// heard, and the row comes back; with no recording X only closes it.
static void test_agent_page_talks(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    const pro_agent_row_t rows[] = {{"a", "a", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"b", "b", "codex", "m1", "MacBook Pro", "orca", "f"}};
    max_ui_agents(rows, 2, 0);
    agent_page("a");
    max_act_t act = tap_page();
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "a") && !strcmp(max_m.talk_id, "a"));
    max_ui_talk(MAX_TALK_RECORDING, 0);
    agent_drawn();
    no_notice();
    act = tap_on(x_of_agent());
    CHECK(act.kind == MAX_ACT_CANCEL && !strcmp(act.agent_id, "a") && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(!max_notice_shown(0));   // nothing was heard: nothing to say
    max_ui_talk(MAX_TALK_IDLE, 0);
    // Words heard, then X: dropped, and the bar says nothing went.
    agent_page("a");
    recording(true);
    act = tap_on(x_of_agent());
    CHECK(act.kind == MAX_ACT_CANCEL && noticed("Cancelled, nothing sent") && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 0);
    // The mic again: a tap sends, whether or not the level said anything was heard.
    agent_page("a");
    CHECK(tap_page().kind == MAX_ACT_TALK);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    agent_drawn();
    no_notice();
    act = tap_page();
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "a") && noticed("Sent to a"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.dirty);
    // While it is sent the panel takes no voice: a tap there brings the agent up instead.
    max_ui_talk(MAX_TALK_SENDING, 0);
    agent_page("a");
    act = tap_page();
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "a"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    // No voice: brought up on the computer; X closes it, nothing else.
    agent_page("b");
    act = tap_page();
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b") && max_m.talk_id[0] != 'b');
    CHECK(tap_on(x_of_agent()).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    // A permission prompt takes Yes or No only, and an answer on its way no voice either.
    max_ui_question("a", "r1", DEPLOY.q, &DEPLOY, 1, true, false, 0);
    agent_page("a");
    CHECK(tap_page().kind == MAX_ACT_OPEN);
    max_ui_question("a", "r2", DB.q, &DB, 1, false, false, 0);
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 0, 0);
    agent_page("a");
    CHECK(max_ask_of("a")->phase == MAX_ASK_SENDING && tap_page().kind == MAX_ACT_OPEN);
    // A panel whose agent left the ring since it was drawn opens nothing.
    agent_page("b");
    max_ui_agents(rows, 1, 0);
    CHECK(tap_page().kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
}

// A sliver opens its agent as a cell's tap does (the mic on, the row's order held); one that asks opens its Attention.
// While a recording is up a sliver is glass like the rest: the tap sends, and opens nothing.
static void test_slivers(void)
{
    linked(ABCDE, 5);
    agent_page("c");   // a b c d e: b and d beside it
    CHECK(max_m.cell_hits == 2 && cell_of("b") && cell_of("d"));
    max_act_t act = tap_box(cell_of("d"));
    CHECK(act.kind == MAX_ACT_OPEN_TALK && !strcmp(act.agent_id, "d") && !strcmp(max_m.talk_id, "d"));
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "d") && max_m.held_count == 5);
    // Recording for d: a sliver sends d's words, and the row comes back.
    max_ui_talk(MAX_TALK_RECORDING, 0);
    agent_drawn();
    no_notice();
    act = tap_box(cell_of("c"));
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "d") && noticed("Sent to d"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 0);
    // A held press on a sliver while recording: the dead zone.
    agent_page("c");
    recording(true);
    const max_box_t b = *cell_of("b");
    CHECK(press_for(b.x + 4, b.y + 4, 0, 0, T += 1000, MAX_TAP_MAX_MS + 50).kind == MAX_ACT_NONE);
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "c"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    T += 1000;
    // A sliver whose agent asks: its question on Attention, nothing recorded.
    max_ui_question("b", "r1", DB.q, &DB, 1, false, false, 0);
    agent_page("a");   // b a c d e: b and c beside it
    max_m.talk_id[0] = 0;
    act = tap_box(cell_of("b"));
    CHECK(act.kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "b"));
    CHECK(max_m.talk_id[0] == 0);
    // A sliver whose agent left the ring since it was drawn opens nothing.
    max_ui_question_close("b");
    agent_page("c");
    const max_box_t gone = *cell_of("d");
    roster((const char *const[]){"a", "b", "c", "e"}, 4);
    CHECK(tap_box(&gone).kind == MAX_ACT_NONE && !strcmp(max_ui_selected(), "c"));
}

// While a recording is up, a tap on anything but X sends it: the toast (then its Attention), a cell, the bare glass.
static void test_any_other_tap_sends(void)
{
    linked(ABCDE, 5);
    agent_page("a");
    recording(false);
    max_ui_question("c", "r1", DB.q, &DB, 1, false, false, 0);   // a person talks: only the toast
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_m.toast_id, "c") && max_toast_shown(0));
    drawn_page(MAX_VIEW_AGENT);
    const max_hit_t *toast = plant(MAX_HIT_TOAST, 0);
    max_act_t act = tap_on(toast);   // the words first, then what the toast announced
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "a") && max_m.view == MAX_VIEW_ATTENTION);
    CHECK(!strcmp(max_m.attn_id, "c") && max_m.attn == MAX_ATTN_ASK && max_m.toast_id[0] == 0);
    overview_drawn();
    CHECK(tap_box(cell_of("b")).kind == MAX_ACT_SEND && max_m.view == MAX_VIEW_OVERVIEW);
    drawn_page(MAX_VIEW_OVERVIEW);
    CHECK(tap(5, 5).kind == MAX_ACT_SEND);
    // Swipes rest everywhere but the agent page.
    overview_drawn();
    CHECK(swipe_left().kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
}

// ---- Attention ----

// Its answers answer, and the question waiting longest takes the page; Say it opens the mic on the agent page (never on
// a permission prompt); anywhere else brings the agent up on the computer and goes to Overview.
static void test_attention(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", 0);
    const pro_app_row_t apps[] = {{"orca", "Orca", 5, 2}};
    max_ui_apps("orca", apps, 1, 0);
    roster(ABCDE, 5);
    max_ui_question("a", "r1", DB.q, &DB, 1, false, false, 0);
    max_ui_question("c", "r2", DB.q, &DB, 1, false, false, 10);
    attention_drawn(2, true);
    max_act_t act = tap_on(&max_m.hits[1]);
    CHECK(act.kind == MAX_ACT_NONE && take(20) == 1 && !strcmp(ANSWER.values[0], "Staging"));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c"));
    // Say it: c's page with the mic on. The words are its answer: sent, and with none waiting, Overview.
    attention_drawn(2, true);
    act = tap_on(&max_m.hits[2]);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "c") && !strcmp(max_m.talk_id, "c"));
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "c"));
    max_ui_talk(MAX_TALK_RECORDING, 0);
    agent_drawn();
    act = tap_page();
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "c") && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 0);
    // A permission prompt: Say it does nothing. The rest of the page brings the agent up in its app.
    max_ui_question("e", "r3", DEPLOY.q, &DEPLOY, 1, true, false, 30);
    attention_drawn(2, true);
    CHECK(tap_on(&max_m.hits[2]).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_ATTENTION);
    no_notice();
    act = tap_page();
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "e") && noticed("e is up in Orca"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.out_count == 0);
    // A turn's end: the same, anywhere on it.
    max_ui_turn("b", "error", "boom", 0, 40);
    attention_drawn(0, false);
    act = tap_page();
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b") && max_m.view == MAX_VIEW_OVERVIEW);
    // An answer drawn for a question that changed since does nothing; the page around it still brings it up.
    max_ui_question("d", "r4", DB.q, &DB, 1, false, false, 50);
    attention_drawn(2, true);
    max_ui_question("d", "r5", "Which other database?", &DB, 1, false, false, 60);
    CHECK(tap_on(&max_m.hits[0]).kind == MAX_ACT_NONE && max_m.out_count == 0 && max_m.view == MAX_VIEW_ATTENTION);
    // Its targets do nothing once Attention is down.
    attention_drawn(2, true);
    max_show(MAX_VIEW_OVERVIEW);
    CHECK(tap_on(&max_m.hits[2]).kind == MAX_ACT_NONE && tap_page().kind == MAX_ACT_NONE);
}

// The toast (what needed the person while they talked): a tap opens its Attention; over New Harness, the form closes
// first (and the computer is told). Gone, it opens nothing.
static void test_toast(void)
{
    linked(ABCDE, 5);
    agent_page("a");
    recording(false);
    max_ui_turn("b", "error", "boom", 0, 100);
    CHECK(!strcmp(max_m.toast_id, "b") && max_m.toast_attn == MAX_ATTN_FAIL && max_toast_shown(100));
    CHECK(max_toast_shown(100 + MAX_TOAST_MS - 1) && !max_toast_shown(100 + MAX_TOAST_MS));
    max_ui_talk(MAX_TALK_IDLE, 0);
    drawn_page(MAX_VIEW_AGENT);
    const max_hit_t toast = *plant(MAX_HIT_TOAST, 0);
    CHECK(tap_at(toast.x + 5, toast.y + 5, 200).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_ATTENTION);
    CHECK(!strcmp(max_m.attn_id, "b") && max_m.attn == MAX_ATTN_FAIL && max_m.attn_from == 290);
    CHECK(max_m.toast_id[0] == 0 && tap_on(&toast).kind == MAX_ACT_NONE);
    // Over the form.
    max_show(MAX_VIEW_APPS);
    max_ui_offers(true);
    CHECK(max_ui_form_open("form-1", 0) && take(0) == 1);
    max_ui_question("c", "r1", DB.q, &DB, 1, false, false, 300);
    CHECK(max_m.view == MAX_VIEW_APPS && !strcmp(max_m.toast_id, "c"));
    CHECK(tap_on(&toast).kind == MAX_ACT_NONE && !max_form_open() && !strcmp(max_m.attn_id, "c"));
    CHECK(take(300) == 1 && OUT[0].kind == MAX_OUT_FORM && OUT[0].op == MAX_FORM_CLOSE);
    // Answered on the computer before the tap: nothing.
    max_show(MAX_VIEW_OVERVIEW);
    max_ui_form_open("form-2", 0);
    max_ui_question("d", "r2", DB.q, &DB, 1, false, false, 400);
    max_ui_question_close("d");
    CHECK(tap_on(&toast).kind == MAX_ACT_NONE && max_form_open() && max_m.view == MAX_VIEW_OVERVIEW);
}

// A finished turn's note: a tap opens its agent across the row with the mic closed, to read what it did, and reads
// that agent's done notices; the others stay unread. While the mic is open only the Dial's tap counts: the words go
// first (what was heard is sent, else dropped), then the note's agent opens. Its agent gone since it was drawn: Inbox,
// where its notice still is.
static void test_done_note(void)
{
    linked(ABCDE, 5);
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_summary("c", "Fixed the login race", NULL, false, POD_TIER_ALERT, 0);
    max_ui_turn("d", "started", "", 0, 0);
    max_ui_summary("d", "Docs updated", NULL, false, POD_TIER_ALERT, 0);
    CHECK(!strcmp(max_m.done_id, "d") && max_m.view == MAX_VIEW_OVERVIEW);
    overview_drawn();
    max_m.dirty = false;
    max_act_t act = tap_on(plant(MAX_HIT_DONE_NOTE, 0));
    CHECK(act.kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "d"));
    CHECK(max_m.talk_id[0] == 0 && max_m.talk == MAX_TALK_IDLE && max_m.done_id[0] == 0 && max_m.dirty);
    for (int i = 0; i < max_m.inbox_count; i++) CHECK(max_m.inbox[i].unread == !strcmp(max_m.inbox[i].id, "c"));
    // The mic open for a, words heard: a held press is the dead zone; the Dial's tap sends, then opens e.
    agent_page("a");
    recording(true);
    max_ui_turn("e", "started", "", 0, 0);
    max_ui_summary("e", "Fixed", NULL, false, POD_TIER_ALERT, 0);
    CHECK(max_m.talk == MAX_TALK_RECORDING && !strcmp(max_m.done_id, "e"));
    drawn_page(MAX_VIEW_AGENT);
    const max_hit_t note = *plant(MAX_HIT_DONE_NOTE, 0);
    CHECK(press_for(note.x + 5, note.y + 5, 0, 0, T += 1000, MAX_TAP_MAX_MS + 50).kind == MAX_ACT_NONE);
    CHECK(max_m.talk == MAX_TALK_RECORDING && !strcmp(max_m.done_id, "e"));
    no_notice();
    act = tap_on(&note);
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "a") && noticed("Sent to a"));
    CHECK(max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "e") && max_m.done_id[0] == 0);
    max_ui_talk(MAX_TALK_IDLE, 0);
    // Nothing heard: dropped, and the next touch within the guard is part of it.
    agent_page("a");
    recording(false);
    max_ui_turn("c", "started", "", 0, 0);
    max_ui_summary("c", "Fixed again", NULL, false, POD_TIER_ALERT, 0);
    drawn_page(MAX_VIEW_AGENT);
    plant(MAX_HIT_DONE_NOTE, 0);
    act = tap_on(&note);
    CHECK(act.kind == MAX_ACT_CANCEL && !strcmp(act.agent_id, "a") && !strcmp(max_ui_selected(), "c"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    agent_drawn();
    CHECK(tap_at(HT_WIDTH / 2, HT_HEIGHT - 20, T + 90 + MAX_GUARD_MS - 1).kind == MAX_ACT_NONE);
    // Its agent left the ring since the note was drawn: Inbox.
    max_ui_turn("b", "started", "", 0, 0);
    max_ui_summary("b", "Shipped", NULL, false, POD_TIER_ALERT, 0);
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    plant(MAX_HIT_DONE_NOTE, 0);
    roster((const char *const[]){"a", "c", "d", "e"}, 4);
    CHECK(tap_on(&max_m.hits[1]).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_INBOX);
    // Read since (the tap above cleared it): a stale hit opens nothing.
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    CHECK(tap_on(plant(MAX_HIT_DONE_NOTE, 0)).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
}

// ---- the clock's side of a recording ----

// A cell's tap opens its agent's page at once and its mic a second later (the owner, 20 Nov: at once was hurried), the
// clock waking for it. A tap on the page meanwhile opens the mic then; X, or the link dropping, opens none; a finger on
// the glass as the mic opens acts on nothing.
static void test_cell_tap_opens_the_mic_a_second_later(void)
{
    linked(ABCDE, 5);
    overview_drawn();
    const max_box_t b = *cell_of("a");
    const int cx = b.x + b.w / 2, cy = b.y + b.h / 2, px = HT_WIDTH / 2, py = HT_HEIGHT - 20;
    uint32_t t = (T += 1000) + 90;   // each tap lets go 90 ms after it went down
    CHECK(tap_at(cx, cy, t - 90).kind == MAX_ACT_OPEN_TALK && max_m.view == MAX_VIEW_AGENT);
    CHECK(max_m.talk_soon && max_m.talk == MAX_TALK_IDLE && !strcmp(max_m.talk_id, "a"));
    max_m.dirty = false;
    CHECK(max_ui_next_wake_ms(t + 600) <= 400);
    CHECK(max_ui_talk_due(t + 999).kind == MAX_ACT_NONE && max_m.talk_soon && max_m.view == MAX_VIEW_AGENT);
    max_act_t act = max_ui_talk_due(t + 1000);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "a") && !max_m.talk_soon && max_m.dirty);
    max_ui_talk(MAX_TALK_RECORDING, t + 1000);   // the recorder max_app.c starts for it
    CHECK(max_ui_talk_due(t + 1100).kind == MAX_ACT_NONE && max_m.talk == MAX_TALK_RECORDING);
    max_ui_talk(MAX_TALK_IDLE, 0);
    // A tap on the page while it waits (past the opening tap's guard): the mic then, and the clock opens none after.
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    t = (T += 3000) + 90;
    CHECK(tap_at(cx, cy, t - 90).kind == MAX_ACT_OPEN_TALK);
    agent_drawn();
    CHECK(tap_at(px, py, t + MAX_GUARD_MS).kind == MAX_ACT_TALK && !max_m.talk_soon);
    CHECK(max_ui_talk_due(t + 1000).kind == MAX_ACT_NONE);
    // X while it waits: Overview, and no mic.
    max_show(MAX_VIEW_OVERVIEW);
    overview_drawn();
    t = (T += 3000) + 90;
    CHECK(tap_at(cx, cy, t - 90).kind == MAX_ACT_OPEN_TALK);
    agent_drawn();
    const max_hit_t *x = x_of_agent();
    CHECK(tap_at(x->x + x->w / 2, x->y + x->h / 2, t + 300).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(max_ui_talk_due(t + 1000).kind == MAX_ACT_NONE && !max_m.talk_soon);
    // The link drops while it waits: no mic.
    overview_drawn();
    t = (T += 3000) + 90;
    CHECK(tap_at(cx, cy, t - 90).kind == MAX_ACT_OPEN_TALK && max_m.talk_soon);
    max_ui_link(false, NULL, t + 200);
    CHECK(max_ui_talk_due(t + 1000).kind == MAX_ACT_NONE && !max_m.talk_soon);
    // A finger on the glass as the mic opens: its lift sends nothing.
    linked(ABCDE, 5);
    overview_drawn();
    t = (T += 3000) + 90;
    CHECK(tap_at(cx, cy, t - 90).kind == MAX_ACT_OPEN_TALK);
    agent_drawn();
    max_ui_touch(true, px, py, t + 950);
    CHECK(max_ui_talk_due(t + 1000).kind == MAX_ACT_TALK);
    max_ui_talk(MAX_TALK_RECORDING, t + 1000);
    CHECK(max_ui_touch(false, px, py, t + 1040).kind == MAX_ACT_NONE && max_m.talk == MAX_TALK_RECORDING);
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_show(MAX_VIEW_OVERVIEW);
    T += 3000;
}

// The owner's numbers, in ms rather than the constants: speech then 2.5 s of quiet sends (20 Nov, 5 s before), a mic
// that hears nothing closes after 5 s.
static void test_talk_due_times(void)
{
    linked(ABCDE, 5);
    agent_page("a");
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "a");
    max_ui_talk(MAX_TALK_RECORDING, 1000);
    max_ui_level(3, 1100);
    max_ui_level(0, 1200);
    CHECK(max_ui_talk_due(1100 + 2499).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_AGENT);
    CHECK(max_ui_talk_due(1100 + 2500).kind == MAX_ACT_SEND);
    max_ui_talk(MAX_TALK_IDLE, 0);
    agent_page("a");
    max_ui_talk(MAX_TALK_RECORDING, 5000);
    max_ui_level(1, 6000);   // below speech
    CHECK(max_ui_talk_due(5000 + 4999).kind == MAX_ACT_NONE);
    CHECK(max_ui_talk_due(5000 + 5000).kind == MAX_ACT_CANCEL);
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_show(MAX_VIEW_OVERVIEW);
}

// Speech, then MAX_SILENCE_MS of quiet: sent, as a tap on the page; so is speech that runs MAX_TALK_MAX_MS. Nothing
// heard in MAX_HEAR_MS: the mic closes, nothing is sent, no notice, and the page stays and says so. Its agent leaving
// the ring: what was heard is sent, else dropped; Overview. No link: nothing.
static void test_talk_due(void)
{
    linked(ABCDE, 5);
    agent_page("a");
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "a");
    max_ui_talk(MAX_TALK_RECORDING, 1000);
    CHECK(max_ui_talk_due(1000).kind == MAX_ACT_NONE);
    max_ui_level(3, 1100);
    max_ui_level(0, 1200);
    CHECK(max_ui_talk_due(1100 + MAX_SILENCE_MS - 1).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_AGENT);
    no_notice();
    max_act_t act = max_ui_talk_due(1100 + MAX_SILENCE_MS);
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "a") && noticed("Sent to a"));
    CHECK(max_m.view == MAX_VIEW_OVERVIEW && max_m.dirty);
    // Speech that never stops: sent at the cap.
    max_ui_talk(MAX_TALK_IDLE, 0);
    agent_page("a");
    max_ui_talk(MAX_TALK_RECORDING, 2000);
    max_ui_level(3, 2000 + MAX_TALK_MAX_MS - 10);
    CHECK(max_ui_talk_due(2000 + MAX_TALK_MAX_MS - 1).kind == MAX_ACT_NONE);
    CHECK(max_ui_talk_due(2000 + MAX_TALK_MAX_MS).kind == MAX_ACT_SEND && max_m.view == MAX_VIEW_OVERVIEW);
    // Nothing heard: the mic closes with no notice, and the page says so until it goes.
    max_ui_talk(MAX_TALK_IDLE, 0);
    agent_page("a");
    max_ui_talk(MAX_TALK_RECORDING, 5000);
    max_ui_level(1, 6000);   // below speech
    CHECK(max_ui_talk_due(5000 + MAX_HEAR_MS - 1).kind == MAX_ACT_NONE);
    no_notice();
    act = max_ui_talk_due(5000 + MAX_HEAR_MS);
    CHECK(act.kind == MAX_ACT_CANCEL && !strcmp(act.agent_id, "a") && !max_notice_shown(0));
    CHECK(max_m.talk_closed && max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "a"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    CHECK(max_m.talk_closed);   // the app's idle keeps it: the page still says so
    max_show(MAX_VIEW_OVERVIEW);
    CHECK(!max_m.talk_closed);
    // Another agent's page: not its mic that closed.
    agent_page("a");
    max_m.talk_closed = true;
    max_open("b");
    CHECK(!strcmp(max_ui_selected(), "b") && !max_m.talk_closed);
    // The form's spoken name has no band: the notice says the mic closed.
    max_m.talk_id[0] = 0;
    max_ui_talk(MAX_TALK_RECORDING, 7000);
    no_notice();
    CHECK(max_ui_talk_due(7000 + MAX_HEAR_MS).kind == MAX_ACT_CANCEL && noticed("Mic closed") && !max_m.talk_closed);
    // Not recording: nothing owed.
    max_ui_talk(MAX_TALK_SENDING, 0);
    CHECK(max_ui_talk_due(99999).kind == MAX_ACT_NONE);
    // Words to an agent that asked are its answer: the question waiting longest takes the page.
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_ui_question("b", "r1", DB.q, &DB, 1, false, false, 10000);
    max_ui_question("c", "r2", DB.q, &DB, 1, false, false, 10100);
    agent_page("b");
    recording(true);
    max_m.talk_quiet_from = 10000;
    act = max_ui_talk_due(10000 + MAX_SILENCE_MS);
    CHECK(act.kind == MAX_ACT_SEND && max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    // The recording's agent leaves the ring: its page goes at once, and the clock sends what was heard ("Sent").
    agent_page("d");
    recording(true);
    roster(ABCDE, 3);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    no_notice();
    act = max_ui_talk_due(20000);
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "d") && noticed("Sent") && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 0);
    roster(ABCDE, 5);
    agent_page("e");
    recording(false);
    roster(ABCDE, 3);
    CHECK(max_ui_talk_due(20000).kind == MAX_ACT_CANCEL && max_m.view == MAX_VIEW_OVERVIEW);
    // The link went: nothing to send to (the app ended the recording with it).
    max_ui_talk(MAX_TALK_IDLE, 0);
    agent_page("a");
    recording(true);
    max_ui_link(false, NULL, 0);
    CHECK(max_ui_talk_due(99999).kind == MAX_ACT_NONE);
}

// ---- the Dial's touch around the mic (18 Nov) ----

// While the mic is open only the Dial's tap sends: down MAX_TAP_MIN_MS..MAX_TAP_MAX_MS, never past 1.2 mm (10.6 px)
// from where it went down. A shorter or longer press, or a finger that slid (out and back too), is the dead zone:
// nothing happens and the mic stays open. X cancels whatever the touch.
static void test_only_the_dials_tap_sends(void)
{
    linked(ABCDE, 5);
    agent_page("a");
    recording(true);
    const int x = HT_WIDTH / 2, y = HT_HEIGHT - 20;
    no_notice();
    CHECK(press_for(x, y, 0, 0, T += 1000, MAX_TAP_MIN_MS - 1).kind == MAX_ACT_NONE);
    CHECK(press_for(x, y, 0, 0, T += 1000, MAX_TAP_MAX_MS + 1).kind == MAX_ACT_NONE);
    CHECK(press_for(x, y, 8, 8, T += 1000, 100).kind == MAX_ACT_NONE);   // 11.3 px
    T += 1000;
    max_ui_touch(true, x, y, T);
    max_ui_touch(true, x + 9, y + 9, T + 40);
    CHECK(max_ui_touch(false, x, y, T + 90).kind == MAX_ACT_NONE);   // out and back
    CHECK(swipe_left().kind == MAX_ACT_NONE);
    CHECK(!max_notice_shown(0) && max_m.view == MAX_VIEW_AGENT && !strcmp(max_ui_selected(), "a"));
    // X: held long, it still cancels.
    const max_hit_t *x_hit = x_of_agent();
    CHECK(x_hit->kind == MAX_HIT_AGENT_X);
    CHECK(press_for(x_hit->x + 4, x_hit->y + 4, 0, 0, T += 1000, 2000).kind == MAX_ACT_CANCEL);
    // The Dial's tap at its edges sends: the shortest, and the longest that moved 10 px.
    agent_page("a");
    recording(true);
    CHECK(press_for(x, y, 10, 0, T += 3000, MAX_TAP_MIN_MS).kind == MAX_ACT_SEND);
    agent_page("a");
    recording(true);
    CHECK(press_for(x, y, 7, 7, T += 1000, MAX_TAP_MAX_MS).kind == MAX_ACT_SEND && noticed("Sent to a"));
}

// A touch that opens the mic lets go before MAX_HOLD_MS; held longer it opens nothing, not even the page.
static void test_a_hold_opens_no_mic(void)
{
    linked(ABCDE, 3);
    overview_drawn();
    const max_box_t b = *cell_of("a");
    const int x = b.x + b.w / 2, y = b.y + b.h / 2;
    CHECK(press_for(x, y, 0, 0, T += 1000, MAX_HOLD_MS).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_OVERVIEW);
    max_act_t act = press_for(x, y, 0, 0, T += 1000, MAX_HOLD_MS - 1);
    CHECK(act.kind == MAX_ACT_OPEN_TALK && !strcmp(act.agent_id, "a") && max_m.view == MAX_VIEW_AGENT);
    // The agent page's body the same (past the opening's guard).
    agent_drawn();
    CHECK(press_for(HT_WIDTH / 2, HT_HEIGHT - 20, 0, 0, T += 2000, MAX_HOLD_MS).kind == MAX_ACT_NONE);
    CHECK(press_for(HT_WIDTH / 2, HT_HEIGHT - 20, 0, 0, T += 2000, MAX_HOLD_MS - 1).kind == MAX_ACT_TALK);
    T += 2000;
}

// A voice action (the mic opening, a send, X) takes the touches that begin within MAX_GUARD_MS after it as part of
// it: a double tap is one intent. X itself is never held back.
static void test_the_guard(void)
{
    linked(ABCDE, 5);
    overview_drawn();
    const max_box_t b = *cell_of("a"), c = *cell_of("b");
    const int page_x = HT_WIDTH / 2, page_y = HT_HEIGHT - 20;
    uint32_t t = T += 1000;
    CHECK(tap_at(b.x + b.w / 2, b.y + b.h / 2, t).kind == MAX_ACT_OPEN_TALK);   // the mic opens at t + 90
    max_ui_talk(MAX_TALK_RECORDING, t + 90);
    agent_drawn();
    // The second tap of a double tap is part of the first: the mic stays open.
    CHECK(tap_at(page_x, page_y, t + 90 + MAX_GUARD_MS - 1).kind == MAX_ACT_NONE && max_m.view == MAX_VIEW_AGENT);
    // Past the guard the tap sends (at t + 90 + MAX_GUARD_MS + 90).
    CHECK(tap_at(page_x, page_y, t + 90 + MAX_GUARD_MS).kind == MAX_ACT_SEND);
    max_ui_talk(MAX_TALK_IDLE, 0);
    t += 90 + MAX_GUARD_MS + 90;
    overview_drawn();
    CHECK(tap_at(c.x + c.w / 2, c.y + c.h / 2, t + MAX_GUARD_MS - 1).kind == MAX_ACT_NONE);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(tap_at(c.x + c.w / 2, c.y + c.h / 2, t + MAX_GUARD_MS).kind == MAX_ACT_OPEN_TALK);
    t += MAX_GUARD_MS + 90;
    max_ui_talk(MAX_TALK_RECORDING, t);
    agent_drawn();
    // X right after the mic opened: never held back. Then the cancel's own guard, on the row X brought back.
    const max_hit_t x_hit = *x_of_agent();
    CHECK(tap_at(x_hit.x + 4, x_hit.y + 4, t + 10).kind == MAX_ACT_CANCEL && max_m.view == MAX_VIEW_OVERVIEW);
    max_ui_talk(MAX_TALK_IDLE, 0);
    t += 100;
    overview_drawn();
    const max_box_t d = *cell_of("a");
    CHECK(tap_at(d.x + d.w / 2, d.y + d.h / 2, t + MAX_GUARD_MS - 1).kind == MAX_ACT_NONE);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(tap_at(d.x + d.w / 2, d.y + d.h / 2, t + MAX_GUARD_MS).kind == MAX_ACT_OPEN_TALK);
    T = t + 10000;
}

// The clock's close or send under a finger: that contact acts on nothing when it lifts, and the next touches within
// the guard are part of it.
static void test_the_clock_voids_the_contact(void)
{
    linked(ABCDE, 5);
    agent_page("a");
    const uint32_t t = T += 1000;
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "a");
    max_ui_talk(MAX_TALK_RECORDING, t);
    agent_drawn();
    const int x = HT_WIDTH / 2, y = HT_HEIGHT - 20;
    max_ui_touch(true, x, y, t + MAX_HEAR_MS - 50);
    CHECK(max_ui_talk_due(t + MAX_HEAR_MS).kind == MAX_ACT_CANCEL);
    max_ui_talk(MAX_TALK_IDLE, 0);
    agent_drawn();
    CHECK(max_ui_touch(false, x, y, t + MAX_HEAR_MS + 40).kind == MAX_ACT_NONE);   // it would have opened the mic
    CHECK(tap_at(x, y, t + MAX_HEAR_MS + MAX_GUARD_MS - 1).kind == MAX_ACT_NONE);
    CHECK(tap_at(x, y, t + MAX_HEAR_MS + MAX_GUARD_MS).kind == MAX_ACT_TALK);
    // The clock's send the same.
    const uint32_t u = t + MAX_HEAR_MS + 2000;
    max_ui_talk(MAX_TALK_RECORDING, u);
    max_ui_level(3, u);
    agent_drawn();
    max_ui_touch(true, x, y, u + MAX_SILENCE_MS - 50);
    CHECK(max_ui_talk_due(u + MAX_SILENCE_MS).kind == MAX_ACT_SEND);
    CHECK(max_ui_touch(false, x, y, u + MAX_SILENCE_MS + 40).kind == MAX_ACT_NONE);
    T = u + 10000;
}

// ---- the rest ----

static void test_cancel(void)
{
    linked(ABCDE, 5);
    overview_drawn();
    // A cancelled contact's lift is nothing (pro_touch.c delivers no more of it; the next DOWN is a new contact).
    const max_box_t *a = cell_of("a");
    const int x = a->x + a->w / 2, y = a->y + a->h / 2;
    max_ui_touch(true, x, y, 0);
    max_ui_touch_cancel();
    CHECK(max_ui_touch(false, x, y, 60).kind == MAX_ACT_NONE);
    // The next contact works.
    CHECK(tap(x, y).kind == MAX_ACT_OPEN_TALK);
}

// Nothing is tappable on the update screen, and nothing turns.
static void test_update_screen(void)
{
    linked(XS, 2 * MAX_CELLS + 1);
    overview_drawn();
    max_ui_update(10, "0.9.0");
    CHECK(tap_box(cell_of("x0")).kind == MAX_ACT_NONE && tap_on(&max_m.hits[0]).kind == MAX_ACT_NONE);
    swipe_left();
    CHECK(max_m.row_first == 0 && max_m.view == MAX_VIEW_OVERVIEW);
}

// New Harness: its moves, choice, Back and Close; Say records a name for its field, sent by a tap or cancelled by X;
// a failed form's Retry names a new one.
static void test_new_harness(void)
{
    linked(ABCDE, 3);
    max_ui_offers(true);
    max_show(MAX_VIEW_APPS);
    drawn_page(MAX_VIEW_APPS);
    CHECK(tap_on(plant(MAX_HIT_NEW, 0)).kind == MAX_ACT_NEW);
    CHECK(max_ui_form_open("form-1", 0) && take(0) == 1);
    const pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "", .previous = "backend",
                                  .next = "website", .error = "", .status = "", .action = "choose", .query = "",
                                  .revision = 7, .position = 2, .total = 5, .active = true, .enabled = true,
                                  .can_query = true};
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    max_m.form_revision = 7;   // the page drawn
    drawn_page(MAX_VIEW_APPS);
    const max_hit_t *next = plant(MAX_HIT_FORM_MOVE, 1), *pick = plant(MAX_HIT_FORM_PICK, 0),
                    *back = plant(MAX_HIT_FORM_BACK, 0), *close = plant(MAX_HIT_FORM_CLOSE, 0),
                    *say = plant(MAX_HIT_FORM_SAY, 0), *x = plant(MAX_HIT_TALK_CANCEL, 0);
    CHECK(tap_on(next).kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].op == MAX_FORM_MOVE && OUT[0].delta == 1);
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    // A swipe moves too: to the left is the next choice.
    CHECK(swipe_left().kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].delta == 1);
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    swipe_right();
    CHECK(take(0) == 1 && OUT[0].delta == -1);
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    // Say: a spoken name for the field at the page drawn. X cancels it; a tap anywhere else sends it, the form stays.
    max_act_t act = tap_on(say);
    CHECK(act.kind == MAX_ACT_SAY && !strcmp(act.form_id, "form-1") && act.revision == 7 && max_m.talk_id[0] == 0);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    CHECK(tap_on(x).kind == MAX_ACT_CANCEL);
    max_ui_talk(MAX_TALK_IDLE, 0);
    CHECK(tap_on(say).kind == MAX_ACT_SAY);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    no_notice();
    act = tap_on(pick);
    CHECK(act.kind == MAX_ACT_SEND && act.agent_id[0] == 0 && !max_notice_shown(0) && max_m.out_count == 0);
    CHECK(max_form_open() && max_m.view == MAX_VIEW_APPS);
    // While a name is said and sent, swipes rest.
    swipe_left();
    CHECK(take(0) == 0);
    max_ui_talk(MAX_TALK_IDLE, 0);
    CHECK(tap_on(pick).kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].op == MAX_FORM_ACTIVATE);
    // A page that changed since it was drawn (here by a spoken name) takes no tap.
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    pro_form_page_t changed = page;
    changed.revision = 8;
    max_ui_voice_form("form-1", true, &changed, 0);
    CHECK(tap_on(pick).kind == MAX_ACT_NONE && take(0) == 0);
    CHECK(tap_on(say).kind == MAX_ACT_NONE);
    max_m.form_revision = 8;
    CHECK(tap_on(back).kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].op == MAX_FORM_BACK);
    // Close: the form goes.
    CHECK(tap_on(close).kind == MAX_ACT_NONE && !max_form_open());
    CHECK(take(0) == 1 && OUT[0].op == MAX_FORM_CLOSE);
    // A failed form: Retry names a new one.
    max_ui_form_open("form-2", 0);
    take(0);
    max_form_due(MAX_FORM_WAIT_MS);
    CHECK(tap_on(plant(MAX_HIT_FORM_RETRY, 0)).kind == MAX_ACT_NEW && !max_form_open());
    // A page that takes no name: Say does nothing.
    max_ui_form_open("form-3", 0);
    CHECK(tap_on(say).kind == MAX_ACT_NONE);
}

int main(void)
{
    test_cell_tap();
    test_drag_is_not_a_tap();
    test_drag_follows_the_finger();
    test_release_settles();
    test_taps_while_moving();
    test_drag_while_open();
    test_inbox();
    test_apps();
    test_ambient_wakes();
    test_agent_page_talks();
    test_slivers();
    test_any_other_tap_sends();
    test_attention();
    test_toast();
    test_done_note();
    test_talk_due();
    test_talk_due_times();
    test_cell_tap_opens_the_mic_a_second_later();
    test_only_the_dials_tap_sends();
    test_a_hold_opens_no_mic();
    test_the_guard();
    test_the_clock_voids_the_contact();
    test_cancel();
    test_update_screen();
    test_new_harness();
    printf("test_max_touch: %d checks passed\n", checks);
    return 0;
}
