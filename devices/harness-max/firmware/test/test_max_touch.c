// The finger: a tap opens a lane, talks from the room, presses a card's button, the toast, the pager or the form's, a
// sideways swipe turns the page (or moves the form), anything else does nothing; while a recording is up, only its Send
// and Cancel act.
#include "max_test.h"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
// Enough agents for the room's and three pages of lanes, whatever MAX_LANES is.
static const char *const XS[] = {"x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9"};
_Static_assert(2 * MAX_LANES + 2 <= sizeof XS / sizeof XS[0], "XS holds the room and three pages of lanes");

static max_act_t tap(int x, int y)
{
    max_ui_touch(true, x, y, 0);
    max_ui_touch(true, x + 3, y - 2, 40);   // a finger never holds still
    return max_ui_touch(false, x + 3, y - 2, 90);
}
static max_act_t drag(int x, int y, int dx, int dy)
{
    max_ui_touch(true, x, y, 0);
    for (int k = 1; k <= 4; k++) max_ui_touch(true, x + dx * k / 4, y + dy * k / 4, (uint32_t)k * 30);
    return max_ui_touch(false, x + dx, y + dy, 150);
}
static max_act_t tap_on(const max_hit_t *h) { return tap(h->x + h->w / 2, h->y + h->h / 2); }
static const max_hit_t *find_hit(max_hit_kind_t kind, int arg)
{
    for (int i = 0; i < max_m.hit_count; i++)
        if (max_m.hits[i].kind == kind && max_m.hits[i].arg == arg) return &max_m.hits[i];
    return NULL;
}
static max_act_t press(max_hit_kind_t kind, int arg)
{
    const max_hit_t *h = find_hit(kind, arg);
    CHECK(h != NULL);
    return tap_on(h);
}
// The lane the last render drew for this agent, or -1.
static int lane_of(const char *id)
{
    for (int i = 0; i < max_m.lane_hits; i++)
        if (!strcmp(max_m.lane_id[i], id)) return i;
    return -1;
}
static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;
static int take(uint32_t now) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, now); }
static const pro_ask_item_t DB = {"db", "Which database?", {"Dev", "Staging"}, 2, false, true};
static const pro_ask_item_t DEPLOY = {"perm", "Approve Bash command: npm run deploy", {"Yes", "No"}, 2, false, true};

static void test_tap_opens_a_lane(void)
{
    linked(ABCDE, 5);   // the room shows a, the lanes the others
    render(0);
    CHECK(!strcmp(max_m.lane_id[0], "b"));
    max_act_t act = tap(lane_x(0), lane_y(0));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b"));
    CHECK(!strcmp(max_ui_selected(), "b"));
    CHECK(max_ui_tick(0));   // the room changed: draw again
    render(0);
    CHECK(!max_ui_tick(0));
    // a is back among the lanes. The card's corner is still the lane (a finger's 80 px fit anywhere in it).
    CHECK(!strcmp(max_m.lane_id[0], "a") && !strcmp(max_m.lane_id[1], "c"));
    act = tap(max_m.lane_box[1].x + 2, max_m.lane_box[1].y + 2);
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "c"));
    // The gaps between the room, the lanes and the side column, and the band below them are nobody's.
    const max_box_t first = max_m.lane_box[0];
    CHECK(tap(MAX_ROOM_X + MAX_ROOM_W + 8, lane_y(0)).kind == MAX_ACT_NONE);
    CHECK(tap(MAX_LANE_X + MAX_LANES_W + 8, lane_y(0)).kind == MAX_ACT_NONE);
    CHECK(tap((first.x + first.w + max_m.lane_box[1].x) / 2, lane_y(0)).kind == MAX_ACT_NONE);
    CHECK(tap(lane_x(0), first.y + first.h + 2).kind == MAX_ACT_NONE);
    CHECK(!strcmp(max_ui_selected(), "c"));
}

static void test_drag_is_not_a_tap(void)
{
    linked(ABCDE, 5);
    render(0);
    const int x = lane_x(0), y = lane_y(0);
    CHECK(drag(x, y, 0, MAX_TAP_SLOP + 6).kind == MAX_ACT_NONE);
    CHECK(drag(x, y, MAX_TAP_SLOP + 6, 0).kind == MAX_ACT_NONE);
    // Out and back within one contact is still a drag.
    max_ui_touch(true, x, y, 0);
    max_ui_touch(true, x, y + 60, 50);
    CHECK(max_ui_touch(false, x, y, 100).kind == MAX_ACT_NONE);
    CHECK(!strcmp(max_ui_selected(), "a") && max_m.page == 0);
    // A lift with no contact is nothing.
    CHECK(max_ui_touch(false, x, y, 200).kind == MAX_ACT_NONE);
}

static void test_swipe_turns_the_page(void)
{
    enum { N = MAX_LANES + 2 };
    linked(XS, N);   // the room shows x0; two pages of lanes
    render(0);
    const int last = lane_x(MAX_LANES - 1), first = lane_x(0), y = lane_y(0);
    CHECK(drag(last, y, -200, 30).kind == MAX_ACT_NONE);
    CHECK(max_m.page == 1 && max_ui_tick(0));
    render(0);
    CHECK(max_m.lane_hits == 1 && !strcmp(max_m.lane_id[0], XS[N - 1]));
    drag(last, y, -200, 0);   // the last page: no further
    CHECK(max_m.page == 1);
    drag(first, y, MAX_SWIPE_PX, 0);
    CHECK(max_m.page == 0);
    drag(first, y, 300, 0);   // the first page: no further back
    CHECK(max_m.page == 0);
    // Too short, or more down than across: no page.
    drag(last, y, -(MAX_SWIPE_PX - 1), 0);
    CHECK(max_m.page == 0);
    drag(last, 60, -120, 300);
    CHECK(max_m.page == 0);
    // A swipe that starts on the room's pet turns the page too, and never talks.
    render(0);
    const max_hit_t *pet = room_hit(MAX_HIT_TALK, 0);
    CHECK(drag(pet->x + pet->w / 2, pet->y + pet->h / 2, -200, 0).kind == MAX_ACT_NONE && max_m.page == 1);
    // One page: a swipe does nothing.
    linked(ABCDE, 3);
    render(0);
    drag(lane_x(1), y, -200, 0);
    CHECK(max_m.page == 0 && !max_ui_tick(0));
}

// The pager: a tap shows the next page of lanes, the first again after the last. Like any tap it means a person is at
// the bar. One page takes no tap; nor does a pager drawn before the form covered the lanes or the pages went.
static void test_pager_turns_the_page(void)
{
    enum { N = 2 * MAX_LANES + 2 };
    linked(XS, N);   // the room shows x0; three pages of lanes
    render(0);
    CHECK(max_pages() == 3 && max_m.page == 0);
    for (int want = 1; want <= 3; want++) {
        const max_hit_t *turn = find_hit(MAX_HIT_PAGE, 0);
        CHECK(turn && tap_on(turn).kind == MAX_ACT_NONE);
        CHECK(max_m.page == want % 3 && max_ui_tick(90) && max_m.touched && max_m.touched_ms == 90);
        render(90);
        CHECK(!max_ui_tick(90) && !strcmp(max_m.lane_id[0], XS[1 + want % 3 * MAX_LANES]));
    }
    // A person at the bar: a new question waits in its toast rather than take the room.
    max_ui_question("x5", "r1", DB.q, &DB, 1, false, false, 100);
    CHECK(!strcmp(max_ui_selected(), "x0") && max_toast_shown(100));
    // The pager drawn, then the form up: it turns nothing.
    max_ui_offers(true);
    render(100);
    const max_hit_t turn = *find_hit(MAX_HIT_PAGE, 0);
    CHECK(press(MAX_HIT_NEW, 0).kind == MAX_ACT_NEW && max_ui_form_open("form-1", 100));
    CHECK(tap_on(&turn).kind == MAX_ACT_NONE && max_m.page == 0 && max_form_open());
    max_form_dismiss();
    // The pager drawn, then all but a page of lanes gone: it turns nothing.
    render(100);
    roster(XS, MAX_LANES + 1);
    CHECK(tap_on(&turn).kind == MAX_ACT_NONE && max_m.page == 0 && !max_m.dirty);
    // One page: no pager to tap, and a tap there turns nothing.
    render(100);
    CHECK(!find_hit(MAX_HIT_PAGE, 0) && tap_on(&turn).kind == MAX_ACT_NONE && max_m.page == 0 && !max_m.dirty);
}

// Voice goes to the room's agent: its pet starts a recording, and while it records only Send and Cancel act.
static void test_talk_from_the_room(void)
{
    linked(XS, MAX_LANES + 2);   // the room shows x0; two pages of lanes
    max_ui_offers(true);
    max_ui_question("x0", "toolu_1", DB.q, &DB, 1, false, false, 0);
    render(0);
    room_card();
    const max_hit_t pet = *room_hit(MAX_HIT_TALK, 0), send = *room_hit(MAX_HIT_TALK_SEND, 0),
                    cancel = *room_hit(MAX_HIT_TALK_CANCEL, 0), option = *room_hit(MAX_HIT_OPTION, 0),
                    toast = *room_hit(MAX_HIT_TOAST, 0);
    // Idle, Send and Cancel do nothing; the pet records for the room's agent, which may answer its question by voice.
    CHECK(tap_on(&send).kind == MAX_ACT_NONE && tap_on(&cancel).kind == MAX_ACT_NONE);
    max_act_t act = tap_on(&pet);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "x0") && !strcmp(max_m.talk_id, "x0"));
    max_ui_talk(MAX_TALK_RECORDING, 0);
    // While it records everything else rests: the pet, the card's buttons, the toast, New, the pager, a lane, a swipe.
    max_ui_question("x1", "toolu_2", DB.q, &DB, 1, false, false, 10);
    CHECK(max_toast_shown(10) && tap_on(&toast).kind == MAX_ACT_NONE);
    CHECK(tap_on(&pet).kind == MAX_ACT_NONE && tap_on(&option).kind == MAX_ACT_NONE && max_m.out_count == 0);
    CHECK(press(MAX_HIT_NEW, 0).kind == MAX_ACT_NONE);
    CHECK(press(MAX_HIT_PAGE, 0).kind == MAX_ACT_NONE && max_m.page == 0);
    CHECK(tap(lane_x(0), lane_y(0)).kind == MAX_ACT_NONE && !strcmp(max_ui_selected(), "x0"));
    drag(lane_x(0), lane_y(0), -200, 0);
    CHECK(max_m.page == 0 && !strcmp(max_ui_selected(), "x0"));
    // Cancel stops it: nothing is sent.
    CHECK(tap_on(&cancel).kind == MAX_ACT_CANCEL && !strcmp(max_ui_selected(), "x0"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_ui_question_close("x1");
    // Send finishes the next for x0; while it is sent nothing acts, until the reply ends it.
    CHECK(tap_on(&pet).kind == MAX_ACT_TALK);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    act = tap_on(&send);
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "x0"));
    max_ui_talk(MAX_TALK_SENDING, 0);
    CHECK(tap_on(&send).kind == MAX_ACT_NONE && tap_on(&cancel).kind == MAX_ACT_NONE);
    max_ui_talk(MAX_TALK_IDLE, 0);
    // A permission prompt takes Yes or No only, and an answer on its way no voice either.
    max_ui_question("x0", "toolu_3", DEPLOY.q, &DEPLOY, 1, true, false, 20);
    CHECK(tap_on(&pet).kind == MAX_ACT_NONE);
    max_ui_question("x0", "toolu_4", DB.q, &DB, 1, false, false, 30);
    max_ask_hit(max_find("x0"), MAX_HIT_OPTION, 0, 30);
    CHECK(max_ask_of("x0")->phase == MAX_ASK_SENDING && tap_on(&pet).kind == MAX_ACT_NONE);
    // The room's agent left the roster before the tap: the room shows another, and the pet is its.
    roster(XS + 2, 3);
    act = tap_on(&pet);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, max_ui_selected()));
}

// A recording sent for the room's agent while it asked is its answer: the room moves on to the question that has waited
// longest, or stays when none waits. Spoken to an agent that does not ask, it moves nothing.
static void test_spoken_answer_moves_the_room(void)
{
    linked(ABCDE, 5);
    max_ui_question("a", "toolu_1", DB.q, &DB, 1, false, false, 0);
    max_ui_question("c", "toolu_2", DB.q, &DB, 1, false, false, 10);
    render(0);
    const max_hit_t pet = *room_hit(MAX_HIT_TALK, 0), send = *room_hit(MAX_HIT_TALK_SEND, 0);
    CHECK(tap_on(&pet).kind == MAX_ACT_TALK);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    max_act_t act = tap_on(&send);
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "a") && !strcmp(max_ui_selected(), "c") && max_ui_tick(0));
    max_ui_talk(MAX_TALK_IDLE, 0);
    max_ui_question_close("a");   // the daemon took it
    // c's question answered by voice, and none waits: the room stays to show c at work.
    act = tap_on(&pet);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "c"));
    max_ui_talk(MAX_TALK_RECORDING, 0);
    CHECK(tap_on(&send).kind == MAX_ACT_SEND && !strcmp(max_ui_selected(), "c"));
    max_ui_talk(MAX_TALK_IDLE, 0);
    // c no longer asks: talking to it moves nothing, whatever waits.
    max_ui_question_close("c");
    max_ui_question("b", "toolu_3", DB.q, &DB, 1, false, false, 20);
    CHECK(tap_on(&pet).kind == MAX_ACT_TALK);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    CHECK(tap_on(&send).kind == MAX_ACT_SEND && !strcmp(max_ui_selected(), "c"));
    max_ui_talk(MAX_TALK_IDLE, 0);
}

// A question that came while a person was at the bar: a tap on its toast opens it; a lane tap puts the toast away.
static void test_toast_opens_its_agent(void)
{
    linked(ABCDE, 5);
    render(0);
    tap(HT_WIDTH - 2, HT_HEIGHT - 2);   // nothing there, but a person at the bar
    max_ui_question("c", "r1", "Ok?", NULL, 0, false, false, 100);
    CHECK(!strcmp(max_ui_selected(), "a") && max_toast_shown(100));
    render(100);
    const max_hit_t toast = *room_hit(MAX_HIT_TOAST, 0);
    max_act_t act = tap_on(&toast);
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "c") && !strcmp(max_ui_selected(), "c"));
    CHECK(max_m.toast_id[0] == 0 && max_ui_tick(100));
    CHECK(tap_on(&toast).kind == MAX_ACT_NONE);   // gone: it opens nothing
    max_ui_question("d", "r2", "Ok?", NULL, 0, false, false, 200);
    CHECK(max_toast_shown(200) && !strcmp(max_m.toast_id, "d"));
    render(200);
    const int b = lane_of("b");
    CHECK(b >= 0);
    act = tap(lane_x(b), lane_y(b));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(max_ui_selected(), "b") && max_m.toast_id[0] == 0);
}

// The toast while New Harness is up: the person chose that question over the form, so the form closes (and the computer
// is told) and the room opens the agent.
static void test_toast_over_the_form(void)
{
    linked(ABCDE, 5);
    max_ui_offers(true);
    render(0);
    CHECK(press(MAX_HIT_NEW, 0).kind == MAX_ACT_NEW && max_ui_form_open("form-1", 0) && take(0) == 1);
    const pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "", .previous = "backend",
                                  .next = "website", .error = "", .status = "", .action = "choose", .query = "",
                                  .revision = 7, .position = 2, .total = 5, .active = true, .enabled = true};
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    max_ui_question("c", "r1", "Ok?", NULL, 0, false, false, 100);
    CHECK(max_toast_shown(100) && !strcmp(max_ui_selected(), "a"));
    render(100);
    max_act_t act = press(MAX_HIT_TOAST, 0);
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "c") && !strcmp(max_ui_selected(), "c"));
    CHECK(!max_form_open() && max_m.toast_id[0] == 0 && max_ui_tick(100));
    CHECK(take(100) == 1 && OUT[0].kind == MAX_OUT_FORM && OUT[0].op == MAX_FORM_CLOSE && !strcmp(OUT[0].form, "form-1"));
    // The room shows it, its card's buttons at hand, New Harness back in reach and the pager turning again.
    render(100);
    CHECK(!strcmp(max_m.card_id, "c") && max_m.lane_hits == MAX_LANES && find_hit(MAX_HIT_NEW, 0));
    CHECK(find_hit(MAX_HIT_PAGE, 0));
}

static void test_cancel(void)
{
    linked(ABCDE, 5);
    render(0);
    // A cancelled contact's lift is nothing (pro_touch.c delivers no more of it; the next DOWN is a new contact).
    const int y = lane_y(0);
    max_ui_touch(true, lane_x(0), y, 0);
    max_ui_touch_cancel();
    CHECK(max_ui_touch(false, lane_x(0), y, 60).kind == MAX_ACT_NONE);
    max_ui_touch(true, lane_x(2), y, 100);
    max_ui_touch(true, lane_x(2) - 150, y, 130);
    max_ui_touch_cancel();
    max_ui_touch(false, lane_x(2) - 200, y, 160);
    CHECK(max_m.page == 0 && !strcmp(max_ui_selected(), "a"));
    // The next contact works.
    CHECK(tap(lane_x(0), y).kind == MAX_ACT_OPEN);
}

static void test_drawn_lanes_are_what_a_tap_hits(void)
{
    // The tap acts on the lanes the person saw, even when the order moved since.
    linked(ABCDE, 5);
    render(0);
    max_ui_question("c", "r", "Ok?", NULL, 0, false, false, 0);
    max_act_t act = tap(lane_x(0), lane_y(0));
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b"));
    // A lane whose agent left before the tap opens nothing.
    render(0);
    CHECK(!strcmp(max_m.lane_id[1], "a"));
    roster(ABCDE + 1, 4);
    CHECK(tap(lane_x(1), lane_y(1)).kind == MAX_ACT_NONE);
    // Nothing is tappable on the update screen, and nothing turns.
    linked(XS, MAX_LANES + 2);
    render(0);
    const int x = lane_x(0), y = lane_y(0);
    max_ui_update(10, "0.9.0");
    render(0);
    CHECK(tap(x, y).kind == MAX_ACT_NONE && tap_on(room_hit(MAX_HIT_TALK, 0)).kind == MAX_ACT_NONE);
    drag(x, y, -200, 0);
    CHECK(max_m.page == 0);
}

// ---- the card's buttons and New Harness ----

// The room's card: its buttons answer, and a button of a card that changed since it was drawn does nothing.
static void test_card_buttons(void)
{
    linked(ABCDE, 3);
    max_ui_question("a", "toolu_1", DB.q, &DB, 1, false, false, 0);
    render(0);
    room_card();
    // An option answers; the tap opens nothing and the answer waits in the outbox for the app.
    CHECK(tap_on(room_hit(MAX_HIT_OPTION, 1)).kind == MAX_ACT_NONE && max_ui_tick(0));
    CHECK(take(0) == 1 && OUT[0].kind == MAX_OUT_ANSWER && !strcmp(ANSWER.values[0], "Staging"));
    CHECK(!strcmp(max_ui_selected(), "a"));
    // Another question, or the same one sent, since the card was drawn.
    max_ui_question("a", "toolu_2", DB.q, &DB, 1, false, false, 0);
    render(0);
    room_card();
    const max_hit_t old = *room_hit(MAX_HIT_OPTION, 0);
    max_ui_question("a", "toolu_3", "Which other database?", &DB, 1, false, false, 0);
    CHECK(tap_on(&old).kind == MAX_ACT_NONE && max_m.out_count == 0);
    render(0);
    room_card();
    const max_hit_t first = *room_hit(MAX_HIT_OPTION, 0);
    max_ask_hit(max_find("a"), MAX_HIT_OPTION, 1, 0);   // answered meanwhile (a tap a moment earlier)
    take(0);
    tap_on(&first);
    CHECK(max_m.out_count == 0);
    // A failure's card: Dismiss closes it.
    max_ui_turn("a", "error", "boom", 0, 0);
    render(0);
    room_card();
    CHECK(tap_on(room_hit(MAX_HIT_DISMISS, 0)).kind == MAX_ACT_NONE && !max_find("a")->card && max_ui_tick(0));
}

static void test_new_harness(void)
{
    linked(ABCDE, 3);
    max_ui_offers(true);
    render(0);
    // New asks the app to name a form and open it.
    CHECK(press(MAX_HIT_NEW, 0).kind == MAX_ACT_NEW);
    CHECK(max_ui_form_open("form-1", 0) && take(0) == 1);
    const pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "", .previous = "backend",
                                  .next = "website", .error = "", .status = "", .action = "choose", .query = "",
                                  .revision = 7, .position = 2, .total = 5, .active = true, .enabled = true,
                                  .can_query = true};
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    render(0);
    // A tap on the neighbours moves; on the focused choice it chooses; one at a time.
    CHECK(press(MAX_HIT_FORM_MOVE, 1).kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].op == MAX_FORM_MOVE && OUT[0].delta == 1);
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    // A swipe moves too: to the left is the next choice.
    CHECK(drag(HT_WIDTH / 2, HT_HEIGHT / 2, -200, 0).kind == MAX_ACT_NONE && max_m.page == 0);
    CHECK(take(0) == 1 && OUT[0].delta == 1);
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    drag(HT_WIDTH / 2, HT_HEIGHT / 2, 200, 0);
    CHECK(take(0) == 1 && OUT[0].delta == -1);
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    render(0);
    // Say takes a spoken name for the field, at the page drawn, and Send finishes it; the room's pet is for agents.
    CHECK(tap_on(room_hit(MAX_HIT_TALK, 0)).kind == MAX_ACT_NONE);
    max_act_t act = tap_on(room_hit(MAX_HIT_FORM_SAY, 0));
    CHECK(act.kind == MAX_ACT_SAY && !strcmp(act.form_id, "form-1") && act.revision == 7 && max_m.talk_id[0] == 0);
    max_ui_talk(MAX_TALK_RECORDING, 0);
    act = tap_on(room_hit(MAX_HIT_TALK_SEND, 0));
    CHECK(act.kind == MAX_ACT_SEND && act.agent_id[0] == 0);
    max_ui_talk(MAX_TALK_IDLE, 0);
    render(0);
    CHECK(press(MAX_HIT_FORM_PICK, 0).kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].op == MAX_FORM_ACTIVATE);
    // A page that changed since it was drawn (here by a spoken name) takes no tap.
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, 0);
    render(0);
    pro_form_page_t next = page;
    next.revision = 8;
    max_ui_voice_form("form-1", true, &next, 0);
    CHECK(press(MAX_HIT_FORM_PICK, 0).kind == MAX_ACT_NONE && take(0) == 0);
    CHECK(tap_on(room_hit(MAX_HIT_FORM_SAY, 0)).kind == MAX_ACT_NONE);
    render(0);
    CHECK(press(MAX_HIT_FORM_BACK, 0).kind == MAX_ACT_NONE && take(0) == 1 && OUT[0].op == MAX_FORM_BACK);
    // Close: the form goes, and the lanes are back.
    render(0);
    CHECK(press(MAX_HIT_FORM_CLOSE, 0).kind == MAX_ACT_NONE && !max_form_open());
    CHECK(take(0) == 1 && OUT[0].op == MAX_FORM_CLOSE);
    render(0);
    CHECK(max_m.lane_hits == 2 && find_hit(MAX_HIT_NEW, 0));
    // A failed form: Retry names a new one.
    max_ui_form_open("form-2", 0);
    take(0);
    max_form_due(MAX_FORM_WAIT_MS);
    render(0);
    CHECK(press(MAX_HIT_FORM_RETRY, 0).kind == MAX_ACT_NEW && !max_form_open());
    // A page that takes no name: Say does nothing.
    max_ui_form_open("form-3", 0);
    render(0);
    CHECK(tap_on(room_hit(MAX_HIT_FORM_SAY, 0)).kind == MAX_ACT_NONE);
}

int main(void)
{
    test_tap_opens_a_lane();
    test_drag_is_not_a_tap();
    test_swipe_turns_the_page();
    test_pager_turns_the_page();
    test_talk_from_the_room();
    test_spoken_answer_moves_the_room();
    test_toast_opens_its_agent();
    test_toast_over_the_form();
    test_cancel();
    test_drawn_lanes_are_what_a_tap_hits();
    test_card_buttons();
    test_new_harness();
    printf("test_max_touch: %d checks passed\n", checks);
    return 0;
}
