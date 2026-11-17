// The finger: a tap opens a lane or talks, a sideways swipe turns the page, anything else does nothing.
#include "max_test.h"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};
enum { CARD_CY = MAX_CARD_Y + MAX_CARD_H / 2 };
static int lane_cx(int i) { return MAX_LANE_X + i * MAX_LANE_W + MAX_LANE_W / 2; }
static const int TALK_CX = MAX_TALK_X + MAX_TALK_W / 2;

// A text run in the Talk slot that reads exactly t.
static bool talk_says(const char *t)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == 1 && S.runs[i].x >= MAX_TALK_X && !strcmp(S.runs[i].text, t)) return true;
    return false;
}
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

static void test_tap_opens_a_lane(void)
{
    linked(ABCDE, 5);
    render(0);
    max_act_t act = tap(lane_cx(1), CARD_CY);
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "b"));
    CHECK(!strcmp(max_ui_selected(), "b"));
    CHECK(max_ui_tick(0));   // the highlight moved: draw again
    render(0);
    CHECK(!max_ui_tick(0));
    // The card's corner is still the lane (a finger's 80 px fit anywhere in it).
    act = tap(MAX_LANE_X + 2 * MAX_LANE_W + MAX_INSET + 2, MAX_CARD_Y + 2);
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "c"));
    // The rail, the gap between cards and the band below them are nobody's.
    CHECK(tap(MAX_RAIL_W / 2, CARD_CY).kind == MAX_ACT_NONE);
    CHECK(tap(MAX_LANE_X + MAX_LANE_W, CARD_CY).kind == MAX_ACT_NONE);
    CHECK(tap(lane_cx(0), MAX_BAND_Y + 20).kind == MAX_ACT_NONE);
    CHECK(!strcmp(max_ui_selected(), "c"));
}

static void test_drag_is_not_a_tap(void)
{
    linked(ABCDE, 5);
    render(0);
    CHECK(drag(lane_cx(0), CARD_CY, 0, MAX_TAP_SLOP + 6).kind == MAX_ACT_NONE);
    CHECK(drag(lane_cx(0), CARD_CY, MAX_TAP_SLOP + 6, 0).kind == MAX_ACT_NONE);
    // Out and back within one contact is still a drag.
    max_ui_touch(true, lane_cx(0), CARD_CY, 0);
    max_ui_touch(true, lane_cx(0), CARD_CY + 60, 50);
    CHECK(max_ui_touch(false, lane_cx(0), CARD_CY, 100).kind == MAX_ACT_NONE);
    CHECK(max_ui_selected() == NULL && max_m.page == 0);
    // A lift with no contact is nothing.
    CHECK(max_ui_touch(false, lane_cx(0), CARD_CY, 200).kind == MAX_ACT_NONE);
}

static void test_swipe_turns_the_page(void)
{
    linked(ABCDE, 5);
    render(0);
    CHECK(drag(lane_cx(2), CARD_CY, -200, 30).kind == MAX_ACT_NONE);
    CHECK(max_m.page == 1 && max_ui_tick(0));
    render(0);
    CHECK(max_m.lane_hits == 2 && !strcmp(max_m.lane_id[0], "d"));
    drag(lane_cx(2), CARD_CY, -200, 0);   // the last page: no further
    CHECK(max_m.page == 1);
    drag(lane_cx(0), CARD_CY, MAX_SWIPE_PX, 0);
    CHECK(max_m.page == 0);
    drag(lane_cx(0), CARD_CY, 300, 0);   // the first page: no further back
    CHECK(max_m.page == 0);
    // Too short, or more down than across: no page.
    drag(lane_cx(2), CARD_CY, -(MAX_SWIPE_PX - 1), 0);
    CHECK(max_m.page == 0);
    drag(lane_cx(2), 60, -120, 300);
    CHECK(max_m.page == 0);
    // A swipe from the Talk slot turns the page too, and never talks.
    max_ui_focus("a");
    render(0);
    CHECK(drag(TALK_CX, CARD_CY, -200, 0).kind == MAX_ACT_NONE && max_m.page == 1);
    // One page: a swipe does nothing.
    linked(ABCDE, 3);
    render(0);
    drag(lane_cx(2), CARD_CY, -200, 0);
    CHECK(max_m.page == 0 && !max_ui_tick(0));
}

static void test_talk_and_send(void)
{
    linked(ABCDE, 5);
    render(0);
    CHECK(tap(TALK_CX, CARD_CY).kind == MAX_ACT_NONE);   // nobody selected
    tap(lane_cx(0), CARD_CY);
    render(0);
    max_act_t act = tap(TALK_CX, CARD_CY);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "a"));
    max_ui_talk(MAX_TALK_RECORDING);
    render(0);
    // While it records, a lane tap still opens that lane; the recording stays a's.
    CHECK(tap(lane_cx(1), CARD_CY).kind == MAX_ACT_OPEN);
    render(0);
    CHECK(talk_says("Listening") && talk_says("a"));
    act = tap(TALK_CX, CARD_CY);
    CHECK(act.kind == MAX_ACT_SEND && !strcmp(act.agent_id, "a"));
    max_ui_talk(MAX_TALK_SENDING);
    render(0);
    CHECK(tap(TALK_CX, CARD_CY).kind == MAX_ACT_NONE);
    max_ui_talk(MAX_TALK_IDLE);
    render(0);
    act = tap(TALK_CX, CARD_CY);
    CHECK(act.kind == MAX_ACT_TALK && !strcmp(act.agent_id, "b"));
    // The selected agent left the roster before the tap: no talk.
    roster(ABCDE + 2, 3);
    CHECK(tap(TALK_CX, CARD_CY).kind == MAX_ACT_NONE);
}

static void test_cancel(void)
{
    linked(ABCDE, 5);
    render(0);
    // A cancelled contact's lift is nothing (pro_touch.c delivers no more of it; the next DOWN is a new contact).
    max_ui_touch(true, lane_cx(0), CARD_CY, 0);
    max_ui_touch_cancel();
    CHECK(max_ui_touch(false, lane_cx(0), CARD_CY, 60).kind == MAX_ACT_NONE);
    max_ui_touch(true, lane_cx(2), CARD_CY, 100);
    max_ui_touch(true, lane_cx(2) - 150, CARD_CY, 130);
    max_ui_touch_cancel();
    max_ui_touch(false, lane_cx(2) - 200, CARD_CY, 160);
    CHECK(max_m.page == 0 && max_ui_selected() == NULL);
    // The next contact works.
    CHECK(tap(lane_cx(0), CARD_CY).kind == MAX_ACT_OPEN);
}

static void test_drawn_lanes_are_what_a_tap_hits(void)
{
    // The tap acts on the lanes the person saw, even when the order moved since.
    linked(ABCDE, 5);
    render(0);
    max_ui_question("c", "r", "Ok?", 0);
    max_act_t act = tap(lane_cx(0), CARD_CY);
    CHECK(act.kind == MAX_ACT_OPEN && !strcmp(act.agent_id, "a"));
    // A lane whose agent left before the tap opens nothing.
    render(0);
    roster(ABCDE + 1, 4);
    CHECK(tap(lane_cx(1), CARD_CY).kind == MAX_ACT_NONE);
    // Nothing is tappable on the update screen, and nothing turns.
    linked(ABCDE, 5);
    max_ui_update(10, "0.9.0");
    render(0);
    CHECK(tap(lane_cx(0), CARD_CY).kind == MAX_ACT_NONE && tap(TALK_CX, CARD_CY).kind == MAX_ACT_NONE);
    drag(lane_cx(2), CARD_CY, -200, 0);
    CHECK(max_m.page == 0);
}

int main(void)
{
    test_tap_opens_a_lane();
    test_drag_is_not_a_tap();
    test_swipe_turns_the_page();
    test_talk_and_send();
    test_cancel();
    test_drawn_lanes_are_what_a_tap_hits();
    printf("test_max_touch: %d checks passed\n", checks);
    return 0;
}
