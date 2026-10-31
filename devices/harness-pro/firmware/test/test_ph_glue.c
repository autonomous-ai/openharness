// Pets gestures in the glue (pod_glue.c): tap to talk (hands free: a later tap sends), the bar's swipe down, tab swipes.
// Synthetic times; the hits come from a real render of the Pets views.
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app/pod_glue.h"
#include "pod/home/ph.h"

// A recap only lands on a Lead that was asked for (LOADING), as the Lead view does: the fixtures ask first.
static void asked_recap(pod_model_t *m, const char *tab, const char *lead, const char *text, uint32_t at, bool none)
{
    pod_model_supertab_loading(m, tab, lead);
    pod_model_supertab_recap(m, tab, lead, "", text, at, none);
}

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); abort(); } checks++; } while (0)

static pod_ui_t U;
static ht_scene_t S;
static int sc_events, sc_down, sc_move, sc_up;
static bool sink(ht_scroll_phase_t p, int dy, int v, void *c) {
    (void)dy; (void)v; (void)c;
    sc_events++;
    if (p == HT_SCROLL_DOWN) sc_down++; else if (p == HT_SCROLL_MOVE) sc_move++; else sc_up++;
    return true;
}

static const pod_frame_t *top(void) { return &U.nav.stack[U.nav.depth - 1]; }
static void render(uint32_t t) { ht_scene_clear(&S, ht_rgb(0x08090A)); pod_ui_render(&U, &S, t); }
static pod_out_t act(pod_action_t a, int arg) { return pod_nav_act(&U.nav, &U.model, a, arg, 0); }
static const pod_hit_t *find(pod_action_t a) { for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == a) return &U.frame.hits[i]; return NULL; }
static pod_out_t t_(bool down, int x, int y, uint32_t t) { bool c; return pod_ui_touch(&U, down, x, y, t, &c); }

// Tab 0 "Build": a1 working, a2 idle, a3 done with a recap. Tab 1 "Docs": a4 asking.
static void fresh(void) {
    memset(&U, 0, sizeof U);
    pod_ui_init(&U);
    pod_model_reset(&U.model);
    pod_model_agent(&U.model, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&U.model, "a2", "Beta", "codex", "mac");
    pod_model_agent(&U.model, "a3", "Gamma", "gemini", "box");
    pod_model_agent(&U.model, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&U.model);
    static const char *x[] = {"a1", "a2", "a3"}, *y[] = {"a4"};
    const char *const *ids[2] = {x, y};
    uint8_t cnt[2] = {3, 1};
    cable_swarm_t it[2] = {{"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&U.model, it, ids, cnt, 2, "s1", NULL, 0);
    pod_model_turn(&U.model, "a1", "started", NULL, 0, 10);
    pod_model_turn(&U.model, "a3", "started", NULL, 0, 19);
    pod_model_turn(&U.model, "a3", "done", NULL, 0, 20);
    pod_model_recap(&U.model, "a3", "It works. Tests pass. Shipped.", false);
    pod_model_question(&U.model, "a4", "Proceed?");
    U.model.linked = true;
    pod_ui_scroll_sink(&U, sink, NULL, false);
    sc_events = sc_down = sc_move = sc_up = 0;
}
static void to_tab(int tab) { act(POD_A_OPEN_TAB, tab); }
static void to_agent(int tab, int idx) { to_tab(tab); act(POD_A_OPEN_AGENT, idx); }
// Nobody works: a1 finishes its turn (a3 is done, a4 asks).
static void calm(void) { pod_model_turn(&U.model, "a1", "done", NULL, 0, 30); }

#define MID_X 360
#define MID_Y 400

// A new contact (DOWN then UP) at x,y: the hands-free send.
static pod_out_t tap_(int x, int y, uint32_t t) { t_(true, x, y, t); return t_(false, x, y, t + 50); }

static void tap_agent(void) {
    fresh();
    to_agent(0, 0);   // a1, working: Agent
    CHECK(top()->view == POD_V_AGENT);
    render(1000);
    CHECK(t_(true, MID_X, MID_Y, 1000).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    CHECK(t_(true, MID_X, MID_Y, 1400).fx == POD_FX_NONE && top()->view == POD_V_AGENT);   // a still finger alone does nothing
    pod_out_t o = t_(false, MID_X, MID_Y, 1450);   // the lift talks
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK && !U.nav.sending && U.hands_free);
    render(1700);
    o = tap_(MID_X, MID_Y, 2000);   // the next tap sends
    CHECK(o.fx == POD_FX_VOICE_END && top()->view == POD_V_TALK && U.nav.sending && !U.hands_free);
    // A tap on a recap talks too.
    fresh();
    to_agent(0, 2);
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    o = tap_(MID_X, MID_Y, 1000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a3") && top()->view == POD_V_TALK);
}

// A drag past the slop is never a tap: it scrolls (or swipes) and does not talk, even if it comes back to the DOWN.
static void drag_is_not_a_tap(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(true, MID_X, MID_Y + 60, 1100);
    CHECK(t_(false, MID_X, MID_Y, 1200).fx == POD_FX_NONE && top()->view == POD_V_AGENT && !U.hands_free);
    // A lift farther than the slop from the DOWN, with no sample in between.
    t_(true, MID_X, MID_Y, 2000);
    CHECK(t_(false, MID_X + 40, MID_Y, 2050).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
}

static void drift_cancels(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(true, MID_X, MID_Y + 30, 1200);
    CHECK(top()->view == POD_V_AGENT && !U.talk_armed);
    t_(true, MID_X, MID_Y + 60, 1550);
    t_(false, MID_X, MID_Y + 60, 1600);
    CHECK(sc_events > 0 && top()->view == POD_V_AGENT && U.nav.depth == 3);   // Pets: a drag on the room scrolls the host's pane and changes nothing else
    // Recap: the same contact scrolls the host's pane too, and no recording starts.
    fresh();
    to_agent(0, 2);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    t_(true, MID_X, MID_Y - 30, 1200);
    CHECK(!U.talk_armed);
    t_(true, MID_X, MID_Y - 60, 1550);
    t_(false, MID_X, MID_Y - 60, 1600);
    CHECK(sc_events > 0 && top()->view == POD_V_RECAP && U.nav.depth == 3);   // the host pane scrolls; the nav stays
}

static void bar_swipe(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    int x = 200, y = 20;
    int depth = U.nav.depth;
    t_(true, x, y, 1000);
    t_(true, x, y + 50, 1050);
    t_(false, x, y + 90, 1100);
    CHECK(U.nav.depth == depth + 1 && top()->view == POD_V_INBOX);   // the Inbox (notifications), and no crumb tap on top of it
    // 79 px is not enough; mostly sideways is not a swipe-down.
    act(POD_A_TABS, 0);
    to_agent(0, 0);
    render(1200);
    CHECK(U.nav.depth == 3);
    t_(true, 200, 20, 2000); t_(false, 200, 99, 2100);
    CHECK(U.nav.depth == 3);
    t_(true, 200, 20, 3000); t_(false, 330, 110, 3100);
    CHECK(U.nav.depth == 3 || top()->view == POD_V_AGENT || top()->view == POD_V_RECAP);
    // On the root the swipe down from the top edge opens the Inbox too.
    act(POD_A_TABS, 0);
    render(4000);
    t_(true, 200, 20, 4000); t_(false, 200, 120, 4100);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_INBOX);
}

static void no_talk_views(void) {
    fresh();
    calm();   // Home on tab 0
    render(1000);
    U.frame.hit_count = 0;   // a tap on nothing on Home
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_NONE && top()->view == POD_V_TABS && !pod_ui_talking(&U));
    act(POD_A_INBOX, 0);
    CHECK(top()->view == POD_V_INBOX);
    render(3000);
    U.frame.hit_count = 0;
    CHECK(tap_(MID_X, MID_Y, 3000).fx == POD_FX_NONE && top()->view == POD_V_INBOX);
}

static void offline(void) {
    fresh();
    to_agent(0, 0);
    ((pod_agent_t *)pod_model_find(&U.model, "a1"))->state = POD_OFFLINE;
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_NONE);
    CHECK(U.notice_on && !strcmp(U.notice, "That machine is offline") && top()->view == POD_V_AGENT);
}

// The tap talks on the touch path: its lift begins the recording, on the task that also ends or aborts it.
static void tap_talks_on_its_lift(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(t_(true, MID_X, MID_Y, 1000).fx == POD_FX_NONE);
    for (uint32_t t = 1004; t < 2000; t += 4) CHECK(t_(true, MID_X, MID_Y, t).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    pod_out_t o = t_(false, MID_X, MID_Y, 2000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK);
    // A move inside the slop keeps it armed.
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(t_(true, MID_X + 5, MID_Y, 1100).fx == POD_FX_NONE);
    o = t_(false, MID_X + 5, MID_Y, 1150);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK);
}

// A cancelled contact (an untrusted sample, a second finger, sleep) never talks, and never ends a hands-free recording.
static void cancel_keeps_recording(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    render(1100);
    t_(true, MID_X, MID_Y, 1200);
    pod_out_t o = pod_ui_touch_cancel(&U);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_TALK && U.hands_free);
    CHECK(t_(false, MID_X, MID_Y, 1300).fx == POD_FX_NONE);
    render(1600);
    CHECK(tap_(MID_X, MID_Y, 1700).fx == POD_FX_VOICE_END);   // still sends with a new tap
    // A cancel before the lift: the contact never talks.
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(pod_ui_touch_cancel(&U).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    CHECK(t_(false, MID_X, MID_Y, 1100).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    // A refused start (the glue already left Talk): the cancel has nothing to abort.
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    CHECK(pod_ui_touch_cancel(&U).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
}

// Hands free: any new tap on Talk sends, even over the bar crumb or the chip; a swipe from the bar does nothing.
static void hands_free_taps_anywhere(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    render(1600);
    CHECK(U.frame.hit_count >= 1 && U.frame.hits[U.frame.hit_count - 1].action == POD_A_TALK);   // the topmost hit
    CHECK(U.frame.hits[U.frame.hit_count - 1].w == POD_W && U.frame.hits[U.frame.hit_count - 1].y == 0);
    // Over the bar's back crumb (y 20): a send, not a back.
    const pod_hit_t *b = find(POD_A_BACK);
    int bx = b ? b->x + b->w / 2 : 100;
    pod_out_t o = tap_(bx, 20, 2000);
    CHECK(o.fx == POD_FX_VOICE_END && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK && U.nav.sending);
    // A swipe down from the bar does not go back while recording; a tap then sends.
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    render(1600);
    t_(true, 300, 20, 2000);
    t_(true, 300, 70, 2050);
    CHECK(t_(false, 300, 120, 2100).fx == POD_FX_NONE && top()->view == POD_V_TALK);
    // The orphan guard's sibling: Talk ended elsewhere, the flag is dropped on the next contact.
    pod_ui_talk_over(&U);
    CHECK(!U.hands_free);
}

// The send tap right after the talk tap, before Talk is drawn: whatever the old Agent frame had at that point (it had a back crumb) must not apply.
static void send_before_talk_drawn(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(!find(POD_A_BACK));   // the room has no bar and no back crumb: the tap lands where the bar was
    int bx = 100, by = 36;
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    pod_out_t o = tap_(bx, by, 1600);   // no render in between
    CHECK(o.fx == POD_FX_VOICE_END && top()->view == POD_V_TALK && U.nav.sending);
}

// Hands free, then the agent's machine goes offline: the next tap discards the recording instead of leaving the mic open.
static void offline_tap_aborts(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    render(1600);
    ((pod_agent_t *)pod_model_find(&U.model, "a1"))->state = POD_OFFLINE;
    pod_out_t o = tap_(MID_X, MID_Y, 2000);
    CHECK(o.fx == POD_FX_VOICE_ABORT && !strcmp(o.agent, "a1") && !pod_ui_talking(&U) && !U.hands_free && U.notice_on);
}

// Pets Home with a working or asking agent in its tab wakes at 66 ms (the equaliser, the pulse); a still tab, a second.
static void working_bars_wake(void) {
    fresh();   // Home on tab 0: a1 works
    CHECK(pod_ui_wake_ms(&U, 330) == 66 && pod_ui_wake_ms(&U, 340) == 56);
    fresh();
    U.nav.stack[0].scroll = 1;   // tab 1: a4 asks: the pulse
    CHECK(pod_ui_wake_ms(&U, 330) <= 66);
    fresh();
    calm();   // tab 0: nobody works or asks
    CHECK(pod_ui_wake_ms(&U, 330) > 66);
}

// v3 Task 4: the Pets equaliser and spinner step at 66 ms and the voice wave at 100 ms.
static void animation_rates(void) {
    uint32_t most = 0;
    fresh();
    to_agent(0, 0);   // a1 works: the room wakes for its pet and the status line's second, and for nothing else (no bar, no mark)
    for (uint32_t t = 1000; t < 1400; t += 7) {
        uint32_t w = pod_ui_wake_ms(&U, t), want = ph_room_next_ms(&U.nav, &U.model, t);
        if (want > 1000 - t % 1000) want = 1000 - t % 1000;
        CHECK(w == want);
        if (w > most) most = w;
    }
    CHECK(most > 33);   // not held to the old 33 ms frame
    fresh();
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    fresh();
    calm();
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    most = 0;
    for (uint32_t t = 1000; t < 1400; t += 7) { uint32_t w = pod_ui_wake_ms(&U, t); CHECK(w <= 100); if (w > most) most = w; }
    CHECK(most > 33 || most == 33);   // the pet's own animation sets the beat: there is no wave
}

// M9: voice on an asking agent stays refused, so the tap does not arm there (no notice either).
static void asking_agents_do_not_talk(void) {
    fresh();
    to_agent(1, 0);   // a4, asking
    CHECK(top()->view == POD_V_AGENT && !strcmp(top()->agent, "a4"));
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    CHECK(!U.talk_armed);
    CHECK(t_(false, MID_X, MID_Y, 1050).fx == POD_FX_NONE && top()->view == POD_V_AGENT && !U.notice_on);
}

// L10: the tap belongs to the screen and agent it was armed on; a contact on nothing carries no stale hit.
static void talk_stays_with_its_target(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    pod_nav_act(&U.nav, &U.model, POD_A_NEXT, 0, 1010);   // a pane swipe's effect, a notification or a host focus change the agent
    CHECK(strcmp(top()->agent, "a1") != 0);
    CHECK(t_(false, MID_X, MID_Y, 1050).fx == POD_FX_NONE && top()->view != POD_V_TALK);
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, MID_X, MID_Y, 1000);
    act(POD_A_BACK, 0);   // the screen changed under the finger: Home
    CHECK(t_(false, MID_X, MID_Y, 1050).fx == POD_FX_NONE && top()->view != POD_V_TALK);
}

// L11: a refused start (the gate refused the recording) leaves the tap's agent screen where it was.
static void refused_talk_stays_on_the_agent(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    CHECK(top()->view == POD_V_AGENT);
    fresh();   // and on a Recap
    to_agent(0, 2);
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    CHECK(top()->view == POD_V_RECAP);
}

// ---- v3 gestures -------------------------------------------------------------------------------------------

// Six tabs: Overview has two pages.
static void fresh6(void) {
    fresh();
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[6] = {x, x, x, x, x, x};
    uint8_t cnt[6] = {3, 3, 3, 3, 3, 3};
    cable_swarm_t it[6] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3}, {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, 6, "s1", NULL, 0);
}
static void swipe(int x0, int y0, int x1, int y1, uint32_t t) {
    t_(true, x0, y0, t);
    t_(true, (x0 + x1) / 2, (y0 + y1) / 2, t + 40);
    t_(false, x1, y1, t + 80);
}

// Pets Inbox: a sideways swipe either way goes back; a vertical drag scrolls and stays.
// Pets Inbox: a sideways swipe either way goes back; a swipe up goes back unless it scrolled rows.
static void inbox_swipe_goes_back(void) {
    for (int k = 0; k < 4; k++) {
        fresh();
        if (k >= 2) to_agent(0, 0);
        act(POD_A_INBOX, 0);
        CHECK(top()->view == POD_V_INBOX && U.nav.depth == (k >= 2 ? 4 : 2));
        render(1000);
        if (k % 2 == 0) swipe(560, 300, 200, 310, 1000); else swipe(200, 300, 560, 310, 1000);
        if (k < 2) CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS);
        else CHECK(U.nav.depth == 3 && top()->view == POD_V_AGENT);
    }
    // a swipe up with nothing to scroll goes back; a swipe down from the top edge does nothing (the Inbox is already open)
    fresh();
    act(POD_A_INBOX, 0);
    render(1000);
    int d0 = U.nav.depth;
    swipe(360, 710, 360, 450, 1000);
    CHECK(U.nav.depth == d0 - 1);
    fresh();
    act(POD_A_INBOX, 0);
    render(1000);
    t_(true, 360, 20, 1000);
    t_(true, 360, 70, 1050);
    t_(false, 360, 110, 1100);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_INBOX);
    fresh();   // too short (59 px) and too steep: nothing
    act(POD_A_INBOX, 0);
    render(1000);
    int depth = U.nav.depth;
    swipe(400, 300, 341, 305, 1000);
    CHECK(U.nav.depth == depth);
    swipe(400, 300, 300, 420, 2000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_INBOX);
    // a list that scrolls: the swipe up scrolls its rows and does not go back
    for (int i = 0; i < 8; i++) {
        char id[8], nm[8];
        snprintf(id, sizeof id, "u%d", i);
        snprintf(nm, sizeof nm, "n%d", i);
        pod_model_unread_add(&U.model, id, nm, "A finished turn with a message long enough to wrap over a few lines in the inbox list view.", 40, 900);
    }
    render(3000);
    int before = top()->scroll;
    swipe(360, 600, 360, 150, 3000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_INBOX && top()->scroll > before);
    // pushed past its end (already at the last row): a swipe up that moves no row goes back
    render(3500);
    for (int i = 0; i < 20 && top()->scroll < pod_scroll_max(&U.nav, &U.model); i++) swipe(360, 600, 360, 150, 3500 + 200 * (uint32_t)i);
    CHECK(U.nav.depth == depth && top()->scroll == pod_scroll_max(&U.nav, &U.model));
    swipe(360, 600, 360, 150, 5000);
    CHECK(U.nav.depth == depth - 1);
}

// Pets never draws a TAB frame (so Recent is never a tab there): a swipe on one does nothing.
static void recent_swipe_steps_tabs(void) {
    fresh();
    to_tab(0);
    render(1000);
    int depth = U.nav.depth;
    swipe(560, 300, 200, 310, 1000);
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == 0);
    fresh();
    act(POD_A_OPEN_TAB, POD_TAB_RECENT);
    render(1000);
    depth = U.nav.depth;
    swipe(360, 600, 360, 150, 1000);   // a vertical drag does nothing on a TAB frame in Pets
    CHECK(U.nav.depth == depth && top()->view == POD_V_TAB && top()->tab == POD_TAB_RECENT);
}

static void overview_pages(void) {   // Home pages by tab: the frame's scroll is the tab index
    fresh6();
    pod_model_question_close(&U.model, "a4");   // no notice, so no Notices card: the pages are the tabs (home_notices_pages has the card)
    calm(); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // and nobody works: no Working card either
    render(1000);
    CHECK(top()->view == POD_V_TABS && U.nav.depth == 1 && pod_tabs_pages_of(&U.nav, &U.model) == 6 && top()->scroll == 0);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->scroll == 1);
    CHECK(pod_ui_wake_ms(&U, 1200) > 16);
    render(1300);
    for (int i = 0; i < 6; i++) swipe(600, 300, 200, 310, 2000 + 200 * (uint32_t)i);   // past the last tab: stays
    CHECK(top()->scroll == 5);
    swipe(200, 300, 600, 310, 4000);
    CHECK(top()->scroll == 4);
    for (int i = 0; i < 6; i++) swipe(200, 300, 600, 310, 5000 + 200 * (uint32_t)i);   // before the first tab: stays
    CHECK(top()->scroll == 0);
    // A vertical drag leaves the page alone, and nothing animates.
    swipe(360, 250, 360, 310, 7000);   // 60 px: under the Inbox swipe's 80
    swipe(360, 450, 360, 250, 8000);   // up: nothing (Home is home)
    CHECK(top()->scroll == 0 && pod_ui_wake_ms(&U, 9000) > 16 && sc_events == 0 && U.nav.depth == 1);
}

// home_pages: 3 tabs, two left swipes -> scroll 2, a third stays at 2.
static void home_pages(void) {
    fresh();
    pod_model_question_close(&U.model, "a4");   // no notice: no Notices card
    calm(); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // and nobody works: no Working card either
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[3] = {x, x, x};
    uint8_t cnt[3] = {3, 3, 3};
    cable_swarm_t it[3] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, 3, "s1", NULL, 0);
    render(1000);
    swipe(600, 300, 200, 310, 1000);
    swipe(600, 300, 200, 310, 1200);
    CHECK(top()->scroll == 2);
    swipe(600, 300, 200, 310, 1400);
    CHECK(top()->scroll == 2 && U.nav.depth == 1);
}

// Pets: a swipe up (>= 80 px, vertical dominant) from anywhere on the room is Home; the Inbox goes back only when the swipe
// did not scroll its rows; no bottom-zone back any more.
static void bottom_up_goes_back(void) {
    for (int k = 0; k < 3; k++) {
        fresh();
        if (k == 0) to_agent(0, 0);
        else if (k == 1) to_agent(0, 2);   // Recap
        else act(POD_A_INBOX, 0);          // not scrollable: goes back one level
        static const pod_view_t want[] = {POD_V_AGENT, POD_V_RECAP, POD_V_INBOX};
        CHECK(top()->view == want[k]);
        render(1000);
        int depth = U.nav.depth, y0 = 690;
        t_(true, 360, y0, 1000);
        t_(true, 360, y0 - 50, 1040);
        CHECK(U.nav.depth == depth);   // nothing until the lift
        t_(false, 360, y0 - 120, 1080);
        CHECK(U.nav.depth == (k == 2 ? depth - 1 : 1));
        if (k == 1) CHECK(sc_events == 0);
    }
    // 79 px is not enough.
    fresh();
    to_agent(0, 0);
    render(1000);
    swipe(360, 690, 360, 611, 1000);
    CHECK(U.nav.depth == 3);
    // Talk: no home (the swipe does not leave the recording); the root: nothing.
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(MID_X, MID_Y, 1000).fx == POD_FX_VOICE_BEGIN);
    render(1600);
    int d = U.nav.depth;
    swipe(360, 690, 360, 500, 2000);
    CHECK(U.nav.depth == d && top()->view == POD_V_TALK);
    fresh();
    render(1000);
    swipe(360, 690, 360, 500, 1000);
    CHECK(U.nav.depth == 1);
}

// swipe_up_home: a swipe up that STARTS in the bottom zone (y >= 620) is Home; one that starts above scrolls the host's pane and never goes Home.
static void swipe_up_home(void) {
    for (int k = 0; k < 2; k++) {   // Agent, Recap
        fresh();
        to_agent(0, k ? 2 : 0);
        render(1000);
        CHECK(U.nav.depth == 3);
        swipe(360, 700, 360, 560, 1000);   // from y 700: Home, no host scroll
        CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS && sc_events == 0);
        fresh();
        to_agent(0, k ? 2 : 0);
        render(1000);
        swipe(360, POD_BOTTOM_Y, 360, POD_BOTTOM_Y - 100, 1000);   // exactly on the zone's edge
        CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS);
        fresh();
        to_agent(0, k ? 2 : 0);
        render(1000);
        swipe(360, POD_BOTTOM_Y - 1, 360, POD_BOTTOM_Y - 150, 1000);   // one pixel above: the terminal scrolls
        CHECK(U.nav.depth == 3 && sc_events > 0);
        for (int from = 300; from <= 500; from += 100) {   // mid-screen up: host scroll, never Home, the screen stays
            fresh();
            to_agent(0, k ? 2 : 0);
            render(1000);
            swipe(360, from, 360, from - 200, 1000);
            CHECK(U.nav.depth == 3 && top()->view == (k ? POD_V_RECAP : POD_V_AGENT) && sc_events > 0);
        }
        fresh();   // mid-screen down: host scroll too
        to_agent(0, k ? 2 : 0);
        render(1000);
        swipe(360, 250, 360, 450, 1000);
        CHECK(U.nav.depth == 3 && sc_events > 0);
        fresh();   // up from the top band: nothing but a (synthetic) drag there
        to_agent(0, k ? 2 : 0);
        render(1000);
        swipe(360, 40, 360, -50, 1000);
        CHECK(U.nav.depth == 3);
    }
    // slanted (|dy| < 1.5 |dx|) from the bottom zone: not Home
    fresh();
    to_agent(0, 0);
    render(1000);
    swipe(300, 680, 400, 550, 1000);
    CHECK(U.nav.depth == 3);
}

// down_from_top_notices (y 40) and down_mid_is_nothing (y 300); not on Talk or the Inbox.
static void down_from_top_notices(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    swipe(360, 40, 360, 160, 1000);
    CHECK(U.nav.depth == 4 && top()->view == POD_V_INBOX);
}
static void down_mid_is_nothing(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    swipe(360, 300, 360, 420, 1000);
    CHECK(U.nav.depth == 3 && top()->view == POD_V_AGENT && sc_events > 0);   // a mid-screen drag scrolls the host pane, no nav change
    fresh();   // Home too
    render(1000);
    swipe(360, 300, 360, 420, 1000);
    CHECK(U.nav.depth == 1);
}

// A finished agent's RECAP frame (the Story, drawn at once, no collapsed state and no tap-to-open): a vertical drag in the middle scrolls the
// host's terminal pane (begin + move + end), exactly as on the Agent room, and never changes the nav; the device's own text does not scroll.
static void recap_and_agent_host_scroll(void) {
    for (int k = 0; k < 2; k++) {   // 0: AGENT (a1 working), 1: RECAP (a3 done)
        const pod_view_t want = k ? POD_V_RECAP : POD_V_AGENT;
        for (int dir = -1; dir <= 1; dir += 2) {
            fresh();
            to_agent(0, k ? 2 : 0);
            render(1000);
            CHECK(top()->view == want && U.nav.depth == 3);
            const int y0 = dir < 0 ? 520 : 200;
            swipe(360, y0, 360, y0 + dir * 200, 1200);
            CHECK(sc_down >= 1 && sc_move >= 1 && sc_up == 1);
            CHECK(U.nav.depth == 3 && top()->view == want && top()->scroll == 0);
        }
        // a long drag in several moves still ends with one UP
        fresh();
        to_agent(0, k ? 2 : 0);
        render(1000);
        t_(true, 360, 500, 1200);
        for (int i = 1; i <= 6; i++) t_(true, 360, 500 - i * 50, 1200 + (uint32_t)i * 20);
        t_(false, 360, 200, 1400);
        CHECK(sc_down == 1 && sc_move >= 2 && sc_up == 1 && U.nav.depth == 3 && top()->view == want);
    }
    // a Pets RECAP frame has no row scroll of its own, however long the recap
    fresh();
    static char big[2400];
    big[0] = 0;
    for (int i = 0; i < 40; i++) strcat(big, "Edited a file and ran the tests again. ");
    pod_model_recap(&U.model, "a3", big, false);
    to_agent(0, 2);
    render(1000);
    CHECK(pod_scroll_pitch(&U.nav) == 0 && pod_scroll_max(&U.nav, &U.model) == 0);
    swipe(360, 600, 360, 150, 1200);
    CHECK(sc_move >= 1 && top()->scroll == 0 && U.nav.depth == 3 && top()->view == POD_V_RECAP);
    // from the bottom zone a swipe up is Home, with no host scroll
    fresh();
    to_agent(0, 2);
    render(1000);
    swipe(360, 700, 360, 450, 1200);
    CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS && sc_events == 0);
}

// A Pets RECAP frame has no hit: a tap on it talks to its agent (no tap-to-open, no close), and it read the entry when it opened.
static void recap_has_no_tap_and_reads(void) {
    fresh();
    pod_model_unread_add(&U.model, "a3", "Gamma", "It works.", 20, 21);
    to_agent(0, 2);
    CHECK(top()->view == POD_V_RECAP && U.model.unread_count == 0);
    render(1000);
    CHECK(U.frame.hit_count == 0 || !find(POD_A_NONE));
    pod_out_t t = tap_(360, 400, 1000);
    CHECK(t.fx == POD_FX_VOICE_BEGIN && !strcmp(t.agent, "a3") && top()->view == POD_V_TALK);
    // Notices: a row opens the agent on its recap, read
    fresh();
    pod_model_unread_add(&U.model, "a3", "Gamma", "It works.", 20, 21);
    act(POD_A_INBOX, 0);
    render(1000);
    const pod_hit_t *h = find(POD_A_OPEN_NOTIF);
    CHECK(h);
    pod_out_t o = tap_(h->x + h->w / 2, h->y + h->h / 2, 1000);
    CHECK(o.fx == POD_FX_AGENT_OPEN && top()->view == POD_V_RECAP && !strcmp(top()->agent, "a3") && U.model.unread_count == 0);
}

// An agent open on screen that leaves the roster lands on Home (depth 1), not on the invisible TAB frame.
static void room_agent_gone_lands_home(void) {
    fresh();
    to_agent(0, 0);
    CHECK(U.nav.depth == 3 && !strcmp(top()->agent, "a1"));
    static const pod_roster_row_t rows[] = {{"a2", "Beta", "codex", "mac"}, {"a3", "Gamma", "gemini", "box"}, {"a4", "Delta", "claude", "box"}};
    pod_ui_roster(&U, rows, 3);
    CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS);
}

// Pets: no toast over Home or Notices; the unread entry and the beep (notify's true) stay.
static void no_toast_on_home_pets(void) {
    fresh();
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1000));   // on Home
    render(1000);
    CHECK(!U.frame.banner && !U.ban_on && !find(POD_A_BANNER) && pod_model_unread_find(&U.model, "a3"));
    fresh();
    act(POD_A_INBOX, 0);   // on Notices
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1000));
    render(1000);
    CHECK(!U.frame.banner && !U.ban_on && !find(POD_A_BANNER) && pod_model_unread_find(&U.model, "a3"));
}
// ---- the window's selected tab moves the device (Pets) ----
static pod_out_t sw_select(const char *sel) {
    static cable_swarm_members_t mem;
    memset(&mem, 0, sizeof mem);
    mem.count[0] = 3; strcpy(mem.id[0][0], "a1"); strcpy(mem.id[0][1], "a2"); strcpy(mem.id[0][2], "a3");
    mem.count[1] = 1; strcpy(mem.id[1][0], "a4");
    cable_swarm_t it[2] = {{"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
    return pod_ui_swarms(&U, it, 2, &mem, sel, NULL, 0);
}
static void selected_tab_follows(void) {
    // In a room of tab 0, the window selects tab 1: tab 1's first agent, device-local, sideways stays in tab 1.
    fresh();
    sw_select("s1");                                   // the first frame only records it
    to_agent(0, 1);
    CHECK(top()->view != POD_V_TABS && !strcmp(top()->agent, "a2"));
    pod_out_t o = sw_select("s1");                     // unchanged: nothing
    CHECK(o.fx == POD_FX_NONE && !strcmp(top()->agent, "a2"));
    o = sw_select("s2");
    CHECK(o.fx == POD_FX_NONE);                        // no agent.open: the app made the change
    CHECK(U.nav.depth == 3 && !strcmp(top()->agent, "a4") && !strcmp(top()->tab_id, "s2") && U.nav.stack[1].tab == 1);
    CHECK(U.nav.stack[0].view == POD_V_TABS && U.nav.stack[0].scroll == 1);
    act(POD_A_TABS, 0);                                // swipe up lands on tab 1's card
    CHECK(U.nav.depth == 1 && U.nav.stack[0].scroll == 1);
    // The agent already in the new tab: the same agent, the tab updated, sideways inside the new tab.
    fresh();
    sw_select("s2");
    pod_nav_act(&U.nav, &U.model, POD_A_OPEN_TAB, 1, 0);
    act(POD_A_OPEN_AGENT, 0);
    CHECK(!strcmp(top()->agent, "a4") && !strcmp(top()->tab_id, "s2"));
    sw_select("s1");                                   // a4 is not in s1: moves to s1's first
    CHECK(!strcmp(top()->agent, "a1") && !strcmp(top()->tab_id, "s1"));
    // member of the new tab: stays, frames updated (a2 opened over tab s2? simulate via Recent-less stack edit)
    fresh();
    sw_select("s2");
    to_agent(0, 1);                                    // a2 in tab 0, window on s2 (opened from the device)
    CHECK(!strcmp(top()->agent, "a2") && !strcmp(top()->tab_id, "s1"));
    U.nav.stack[1].tab = U.nav.stack[2].tab = 1; strcpy(U.nav.stack[1].tab_id, "s2"); strcpy(U.nav.stack[2].tab_id, "s2");   // as if the frames were stale
    sw_select("s1");                                   // a2 is a member of s1: same agent, tab frames now s1
    CHECK(!strcmp(top()->agent, "a2") && !strcmp(top()->tab_id, "s1") && U.nav.stack[1].tab == 0 && !strcmp(U.nav.stack[1].tab_id, "s1"));
    CHECK(U.nav.stack[0].scroll == 0);
    // On Home the card follows; on Notices and in Talk nothing moves.
    fresh();
    sw_select("s1");
    CHECK(U.nav.depth == 1 && U.nav.stack[0].scroll == 0);
    sw_select("s2");
    CHECK(U.nav.depth == 1 && U.nav.stack[0].scroll == 1);
    act(POD_A_INBOX, 0);
    sw_select("s1");
    CHECK(top()->view == POD_V_INBOX && U.nav.stack[0].scroll == 1);
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    sw_select("s2");
    CHECK(top()->view == POD_V_TALK && !strcmp(top()->agent, "a1"));
    // A contact down: nothing; the update: nothing.
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    U.down = true;
    sw_select("s2");
    CHECK(!strcmp(top()->agent, "a1"));
    U.down = false;
    U.ota = true;
    sw_select("s1"); sw_select("s2");
    CHECK(!strcmp(top()->agent, "a1"));
    U.ota = false;
    // The selection leaves the model's tabs (hidden window tab), or the new tab has no agents: the room stays.
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    sw_select("zz");
    CHECK(!strcmp(top()->agent, "a1"));
    // Order: the selection changes, then the host focuses an agent: the focused agent. Focus then the same selection: no bounce.
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    sw_select("s2");
    CHECK(!strcmp(top()->agent, "a4"));
    pod_ui_focus(&U, "a3", 5000);
    CHECK(!strcmp(top()->agent, "a3") && !strcmp(top()->tab_id, "s1"));
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    pod_ui_focus(&U, "a4", 5000);                      // the app selected s2 and focused a4; the focus arrives first
    CHECK(!strcmp(top()->agent, "a4"));
    U.model.clock_ms = 5100;
    sw_select("s2");
    CHECK(U.nav.depth == 3 && !strcmp(top()->agent, "a4"));
    sw_select("s2");
    CHECK(!strcmp(top()->agent, "a4"));
    // After the echo window a selected-tab change follows again, and an old focus never blocks it once the clock wraps.
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    pod_ui_focus(&U, "a3", 5000);
    CHECK(!strcmp(top()->agent, "a3"));
    U.model.clock_ms = 5000 + POD_FOLLOW_ECHO_MS;
    sw_select("s2");
    CHECK(!strcmp(top()->agent, "a4") && !U.followed);
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    pod_ui_focus(&U, "a3", 5000);
    U.model.clock_ms = 5000u + 0x80000000u + 100u;   // ~24.8 days later: a signed difference would read as "just now"
    sw_select("s2");
    CHECK(!strcmp(top()->agent, "a4"));
    // A new link only records the first frame.
    fresh();
    sw_select("s1");
    to_agent(0, 0);
    pod_ui_link(&U, false);
    pod_ui_link(&U, true);
    sw_select("s2");
    CHECK(!strcmp(top()->agent, "a1"));
}
// ---- the start ----
static void feed_pets(void) {   // a fresh Pets glue with no model yet
    pod_ui_init(&U);
    pod_ui_scroll_sink(&U, sink, NULL, false);
}
static pod_out_t feed_swarms(int n0) {
    static cable_swarm_members_t mem;
    memset(&mem, 0, sizeof mem);
    mem.count[0] = (uint8_t)n0;
    strcpy(mem.id[0][0], "a"); strcpy(mem.id[0][1], "b");
    mem.count[1] = 1;
    strcpy(mem.id[1][0], "c");
    cable_swarm_t it[2] = {{"s1", "Build", 2, 2}, {"s2", "Docs", 1, 1}};
    return pod_ui_swarms(&U, it, 2, &mem, "s1", NULL, 0);
}
static void feed_roster(void) {
    static const pod_roster_row_t rows[] = {{"a", "Alpha", "claude", "mac"}, {"b", "Beta", "codex", "mac"}, {"c", "Gamma", "claude", "box"}};
    pod_ui_roster(&U, rows, 3);
}
static int starts;
static void model_changed(void) {   // what pro_app's settle does
    if (pod_ui_start(&U, 2000)) starts++;
}
static void start_enters_first_tab(void) {
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    model_changed();
    CHECK(U.nav.depth == 1 && starts == 0);   // nothing to enter yet
    feed_roster();
    model_changed();
    CHECK(U.nav.depth == 1 && starts == 0);   // no swarms of this link yet
    feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 3 && !strcmp(top()->agent, "a") && (top()->view == POD_V_AGENT || top()->view == POD_V_RECAP));
    CHECK(U.nav.stack[1].view == POD_V_TAB && U.nav.stack[1].tab == 0);
    act(POD_A_TABS, 0);                        // the user goes Home: a second model change does not re-run the start
    feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 1);
    // A glue that never saw a link-up never starts.
    pod_ui_init(&U);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(U.nav.depth == 1);
}
static void start_then_focus(void) {
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && !strcmp(top()->agent, "a"));
    pod_ui_focus(&U, "b", 5000);
    CHECK(U.nav.depth == 3 && !strcmp(top()->agent, "b"));
    model_changed();
    CHECK(starts == 1 && !strcmp(top()->agent, "b"));
    // and a focus first: the start never overrides it
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_roster();
    pod_ui_focus(&U, "c", 5000);
    feed_swarms(2);
    model_changed();
    CHECK(starts == 0 && !strcmp(top()->agent, "c"));
}
// A new link starts over from the new link's swarms, never from the previous link's retained roster.
static void start_after_relink(void) {
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(starts == 1);
    pod_ui_link(&U, false);
    act(POD_A_TABS, 0);
    pod_ui_link(&U, true);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 1 && !U.started);   // the retained roster and swarms are the last link's: wait
    feed_swarms(2);
    model_changed();
    CHECK(starts == 2 && U.nav.depth == 3);
    pod_ui_link(&U, true);    // a second link-up with no drop in between is not a new link
    CHECK(U.started);
}
// Relink while in a room: the new link's swarms end the start there; going Home afterwards and a later feed do not start.
static void start_never_yanks(void) {
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 3);
    pod_ui_link(&U, false);
    pod_ui_link(&U, true);                    // still in the room
    feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 3 && U.started);
    act(POD_A_TABS, 0);                       // home, then a feed
    feed_swarms(2);
    model_changed();
    feed_roster();
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 1);
    // Relink in a room, the person swipes Home BEFORE the new swarms arrive: still no start.
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 3);
    pod_ui_link(&U, false);
    pod_ui_link(&U, true);
    render(1000);
    swipe(360, 690, 360, 540, 1000);          // swipe up from the bottom zone: Home
    CHECK(U.nav.depth == 1 && U.started);
    feed_swarms(2);
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 1);
    // A touch on Home before the model arrives (a tap on nothing) also ends it.
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    render(1000);
    tap_(360, 400, 1000);
    CHECK(U.started);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(starts == 0 && U.nav.depth == 1);
    // The side button (pro_app calls pod_ui_navigated) does too.
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    pod_ui_navigated(&U);
    feed_roster(); feed_swarms(2);
    model_changed();
    CHECK(starts == 0 && U.nav.depth == 1);
}
// Tab 0 with no agents ends the start for this link (it does not stay armed to yank later); a tab 0 whose agents are
// not on the roster yet waits for them.
static void start_waits_for_agents(void) {
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_roster(); feed_swarms(0);
    model_changed();
    CHECK(starts == 0 && U.nav.depth == 1 && U.started);
    feed_swarms(2);
    model_changed();
    CHECK(starts == 0 && U.nav.depth == 1);
    feed_pets();
    starts = 0;
    pod_ui_link(&U, true);
    feed_swarms(2);                         // swarms before the roster
    model_changed();
    CHECK(starts == 0 && !U.started);
    feed_roster();
    model_changed();
    CHECK(starts == 1 && U.nav.depth == 3);
}
static void room_sideways_wraps(void) {
    fresh();
    to_agent(0, 2);   // the last of tab 0
    render(1000);
    swipe(560, 300, 200, 310, 1000);   // left = next: wraps to the first
    CHECK(U.nav.depth == 3 && !strcmp(top()->agent, "a1"));
}

static void bottom_start_sideways_is_a_pane_swipe(void) {
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, 300, 690, 1000);
    t_(true, 380, 680, 1040);
    t_(false, 450, 660, 1080);   // dx 150, dy -30
    CHECK(U.nav.depth == 3 && (top()->view == POD_V_AGENT || top()->view == POD_V_RECAP) && strcmp(top()->agent, "a1") != 0);   // NEXT pane, not BACK
    // A tap in the bottom zone still talks, and is not a back.
    fresh();
    to_agent(0, 0);
    render(1000);
    CHECK(tap_(360, 690, 1000).fx == POD_FX_VOICE_BEGIN && top()->view == POD_V_TALK && U.nav.depth == 3);
}

static void bar_down_opens_inbox(void) {
    // from an agent (and a tab, and Recent) a swipe down from the bar opens the Inbox on top; on the Inbox it does nothing
    for (int k = 0; k < 4; k++) {
        fresh();
        if (k == 0) to_agent(0, 0); else if (k == 1) to_tab(0); else if (k == 2) act(POD_A_OPEN_TAB, POD_TAB_RECENT); else act(POD_A_INBOX, 0);
        render(1000);
        int depth = U.nav.depth;
        CHECK(depth >= 2);
        t_(true, 360, 20, 1000);
        t_(true, 360, 70, 1040);
        t_(false, 360, 140, 1080);
        CHECK(top()->view == POD_V_INBOX && U.nav.depth == (k == 3 ? depth : depth + 1));
    }
}

static int hits_of_banner(void) { int n = 0; for (int i = 0; i < U.frame.hit_count; i++) n += U.frame.hits[i].action == POD_A_BANNER; return n; }
static void toast_and_edges(void) {
    // A toast over a room: the bar's swipe down still opens Notices, but a contact on the toast belongs to the toast (below).
    fresh();
    to_agent(0, 0);
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1000));
    render(1000);
    CHECK(U.ban_on && U.frame.banner);
    t_(true, 360, 190, 1100); t_(true, 360, 240, 1140); t_(false, 360, 300, 1180);   // under the toast: a drag on the room
    CHECK(U.nav.depth == 3);
}


// ---- the notice toast (Pets): a new notice over a room; 5 s, tap -> Notices, swipe up dismisses, never over Home, Notices, Talk, the update or its own agent ----
static void toast_shows_and_expires(void) {
    fresh();
    calm();
    to_agent(0, 2);   // a3's Recap: a still room
    CHECK(pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000));   // the beep still plays
    CHECK(U.ban_on && U.ban_until == 6000 && pod_ui_banner_shown_ms(&U) == 1000);
    render(1000);
    CHECK(U.frame.banner && hits_of_banner() == 1);
    const pod_hit_t *h = find(POD_A_BANNER);
    CHECK(h->x == 40 && h->y == 24 && h->w == 640 && h->h == 118 && !strcmp(h->id, "a1"));
    render(5999);
    CHECK(U.frame.banner && U.ban_on);
    render(6000);   // the bar ran out: the toast goes, the entry stays unread
    CHECK(!U.frame.banner && !U.ban_on && pod_model_unread_find(&U.model, "a1") && !find(POD_A_BANNER));
    CHECK(top()->view == POD_V_RECAP && U.nav.depth == 3);
    // the bar needs a render each 66 ms while it shows, and the expiry is an edge
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    render(1000);
    for (uint32_t t = 1000; t < 6000; t += 5) CHECK(pod_ui_wake_ms(&U, t) <= 66);
    // a newer notice replaces it: 5 s from then
    CHECK(pod_ui_notify(&U, "a2", POD_TIER_ALERT, true, 3000));
    CHECK(!strcmp(U.ban_agent, "a2") && U.ban_until == 8000 && pod_ui_banner_shown_ms(&U) == 3000);
}
// A Super Tab's question (decision or stuck) raises a toast that does not run out: it stays past POD_TOAST_MS with no 66 ms
// beat after its slide, and goes when swiped up, when the question closes, or once Notices is on screen. A plain question's runs out.
static void supertab_ask(const char *id, const char *q, pod_attention_t attn, uint32_t t) {
    pod_ui_question(&U, id, q, attn == POD_ATTN_NONE ? NULL : "Launch v2", attn);
    pod_ui_notify_text(&U, id, POD_TIER_ALERT, q, true, true, t);
}
static void supertab_toast_stays(void) {
    fresh();
    calm();
    to_agent(0, 2);   // a3's Recap: a still room
    supertab_ask("a1", "Staging first, or straight to prod?", POD_ATTN_DECISION, 1000);
    CHECK(U.ban_on && U.ban_stay && pod_ui_banner_shown_ms(&U) == 1000);
    for (uint32_t t = 1000; t < 1000 + POD_TOAST_SLIDE_MS; t += 7) { render(t); CHECK(U.frame.banner && pod_ui_wake_ms(&U, t) <= 66); }
    {   // after the slide nothing on the toast moves: the room's own beat, as if there were no toast
        render(3000);
        const uint32_t with = pod_ui_wake_ms(&U, 3000);
        U.ban_on = false;
        const uint32_t without = pod_ui_wake_ms(&U, 3000);
        U.ban_on = true;
        CHECK(with == without);
    }
    render(6000);
    CHECK(U.frame.banner && U.ban_on);   // past the 5 s of a plain toast
    render(600000);
    CHECK(U.frame.banner && U.ban_on && find(POD_A_BANNER) && !strcmp(find(POD_A_BANNER)->id, "a1"));
    pod_ui_question_close(&U, "a1");   // answered elsewhere: its entry goes, and the toast with it
    render(600100);
    CHECK(!U.frame.banner && !U.ban_on && !pod_model_unread_find(&U.model, "a1"));

    // a stuck agent's stays too; a swipe up dismisses it, the entry stays listed
    supertab_ask("a2", "Stuck: no write access to staging", POD_ATTN_STUCK, 700000);
    render(700000);
    render(800000);
    CHECK(U.frame.banner && U.ban_stay);
    t_(true, 360, 110, 800100); t_(true, 360, 80, 800140); t_(false, 360, 40, 800180);
    render(800200);
    CHECK(!U.ban_on && !U.frame.banner && pod_model_unread_find(&U.model, "a2") && top()->view == POD_V_RECAP);

    // Notices on screen ends it: back in the room it does not return
    fresh();
    calm();
    to_agent(0, 2);
    supertab_ask("a1", "Staging first, or straight to prod?", POD_ATTN_DECISION, 1000);
    render(9000);
    CHECK(U.frame.banner);
    const int depth = U.nav.depth;
    act(POD_A_INBOX, 0);
    render(9100);
    CHECK(!U.ban_on && !U.frame.banner && top()->view == POD_V_INBOX);
    act(POD_A_BACK, 0);
    render(9200);
    CHECK(U.nav.depth == depth && top()->view == POD_V_RECAP && !U.frame.banner && pod_model_unread_find(&U.model, "a1"));

    // a plain question's toast runs out as before
    fresh();
    calm();
    to_agent(0, 2);
    supertab_ask("a1", "Which branch?", POD_ATTN_NONE, 1000);
    CHECK(U.ban_on && !U.ban_stay);
    render(5999);
    CHECK(U.frame.banner);
    render(6000);
    CHECK(!U.frame.banner && !U.ban_on && pod_model_unread_find(&U.model, "a1"));
    // and a newer plain notice replaces a staying toast (and runs out)
    supertab_ask("a2", "Staging first, or straight to prod?", POD_ATTN_DECISION, 7000);
    CHECK(U.ban_stay);
    CHECK(pod_ui_notify(&U, "a4", POD_TIER_ALERT, true, 8000));
    CHECK(!strcmp(U.ban_agent, "a4") && !U.ban_stay);
    // not while talking: no toast is raised for it at all (as for any alert)
    fresh();
    calm();
    to_agent(0, 2);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    supertab_ask("a1", "Staging first, or straight to prod?", POD_ATTN_DECISION, 1000);
    CHECK(!U.ban_on);
}
static void toast_tap_opens_notices(void) {
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    render(1000);
    const int depth = U.nav.depth;
    pod_out_t o = tap_(360, 80, 1100);
    CHECK(o.fx == POD_FX_NONE && U.nav.depth == depth + 1 && top()->view == POD_V_INBOX && !U.ban_on);
    CHECK(pod_model_unread_find(&U.model, "a1"));   // still unread: Notices lists it
    render(1200);
    CHECK(!U.frame.banner);
    // a tap beside the toast reaches the room: it talks to the room's agent, not to the toast's
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    render(1000);
    o = tap_(360, 300, 1100);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a3") && top()->view == POD_V_TALK);
}
static void toast_swipe_up_dismisses(void) {
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    render(1000);
    const int depth = U.nav.depth;
    CHECK(!U.talk_armed);
    t_(true, 360, 110, 1100);
    CHECK(!U.talk_armed);   // a contact on the toast never talks
    t_(true, 360, 80, 1140);
    t_(false, 360, 40, 1180);
    CHECK(!U.ban_on && U.nav.depth == depth && top()->view == POD_V_RECAP && pod_model_unread_find(&U.model, "a1"));
    // a swipe down that starts on the toast does not reach the bar's Notices swipe, and nothing else happens
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    render(1000);
    t_(true, 360, 40, 1100); t_(true, 360, 90, 1140); t_(false, 360, 170, 1180);
    CHECK(U.nav.depth == 3 && top()->view == POD_V_RECAP && U.ban_on);
}
static void toast_not_here(void) {
    // not over Home or Notices (covered by no_toast_on_home_pets); not for the agent on screen, awake or not
    fresh();
    calm();
    to_agent(0, 2);
    CHECK(!pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1000) && !U.ban_on);
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, false, 1100) && !U.ban_on);
    CHECK(pod_model_unread_find(&U.model, "a3"));
    // a room over Notices (opened from a notice) shows toasts for the others
    // not over Talk: recording or sending
    fresh();
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    CHECK(top()->view == POD_V_TALK);
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1000) && !U.ban_on);
    render(1000);
    CHECK(!U.frame.banner);
    // not over the update
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_ota(&U, "0.1.1", "0.1.2", 10, false);
    CHECK(pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000) && !U.ban_on);
    pod_ui_ota(&U, NULL, NULL, -1, false);
    render(1100);
    CHECK(!U.frame.banner && pod_model_unread_find(&U.model, "a1"));
    // a toast already up is hidden when the person goes Home, Notices or into Talk, and the entry stays
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    render(1000);
    CHECK(U.frame.banner);
    act(POD_A_INBOX, 0);
    render(1100);
    CHECK(!U.frame.banner && pod_model_unread_find(&U.model, "a1"));
    // the agent's own room opened while the toast is up: it is that agent's recap/room now, no toast for itself
    fresh();
    calm();
    to_agent(0, 2);
    pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000);
    act(POD_A_PREV, 0);   // a3 -> a2
    act(POD_A_PREV, 0);   // a2 -> a1
    render(1100);
    CHECK(top()->view == POD_V_AGENT && !strcmp(top()->agent, "a1") && !U.frame.banner);
}

// ---- Home's Notices card: paging, tap, and a position that survives notices coming and going ----
static void home_notices_pages(void) {
    fresh(); calm();   // a4 asks: one notice, so the card exists: Notices, Build, Docs
    render(1000);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 3 && top()->scroll == 0);
    swipe(200, 300, 600, 310, 1000);   // right: the page before tab 0
    CHECK(top()->scroll == -2);
    render(1200);
    CHECK(find(POD_A_INBOX) && !find(POD_A_ENTER_TAB));
    swipe(200, 300, 600, 310, 2000);   // the first page: stays
    CHECK(top()->scroll == -2);
    swipe(600, 300, 200, 310, 3000);
    CHECK(top()->scroll == 0);
    swipe(600, 300, 200, 310, 4000);
    CHECK(top()->scroll == 1);
    swipe(600, 300, 200, 310, 5000);   // the last tab: stays
    CHECK(top()->scroll == 1 && U.nav.depth == 1);
    // a tap on the Notices card opens Notices, and Back returns to the card
    swipe(200, 300, 600, 310, 6000); swipe(200, 300, 600, 310, 7000);
    CHECK(top()->scroll == -2);
    render(8000);
    pod_out_t o = tap_(360, 300, 8100);
    CHECK(o.fx == POD_FX_NONE && U.nav.depth == 2 && top()->view == POD_V_INBOX);
    act(POD_A_BACK, 1);
    CHECK(U.nav.depth == 1 && top()->scroll == -2);
    // a tap on a tab card still enters the tab
    swipe(600, 300, 200, 310, 9000);
    render(9500);
    tap_(360, 300, 9600);
    CHECK(U.nav.depth == 3 && !strcmp(top()->agent, "a1"));
}
static void home_notices_come_and_go(void) {
    // on tab 1 with a notice: the notice goes, the page under the person is still tab 1; a notice comes, still tab 1
    fresh(); calm();
    act(POD_A_SCROLL, 1);
    render(1000);
    CHECK(top()->scroll == 1 && pod_tabs_pages_of(&U.nav, &U.model) == 3);
    pod_ui_question_close(&U, "a4"); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // back to work, then done: no Working card
    CHECK(top()->scroll == 1 && pod_tabs_pages_of(&U.nav, &U.model) == 2);
    render(1100);
    CHECK(find(POD_A_ENTER_TAB) && !strcmp(find(POD_A_ENTER_TAB)->id, "s2"));
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1200));
    CHECK(top()->scroll == 1 && pod_tabs_pages_of(&U.nav, &U.model) == 3);
    render(1300);
    CHECK(find(POD_A_ENTER_TAB) && !strcmp(find(POD_A_ENTER_TAB)->id, "s2"));
    // on the Notices card the last notice goes: Home settles on tab 0
    fresh(); calm();
    act(POD_A_SCROLL, -2);
    CHECK(top()->scroll == -2);
    pod_ui_question_close(&U, "a4"); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // back to work, then done: no Working card
    pod_nav_sync(&U.nav, &U.model);
    CHECK(top()->scroll == 0 && U.nav.depth == 1);
    render(1000);
    CHECK(find(POD_A_ENTER_TAB) && !strcmp(find(POD_A_ENTER_TAB)->id, "s1") && !find(POD_A_INBOX));
    // a swipe right on the first tab with no notices goes nowhere
    swipe(200, 300, 600, 310, 2000);
    CHECK(top()->scroll == 0);
}
static void home_swipe_up_lands_on_room_tab(void) {
    fresh(); calm();
    act(POD_A_SCROLL, -2);       // Home was left on the Notices card
    to_agent(1, 0);              // a room of Docs, opened another way
    CHECK(U.nav.depth == 3 && U.nav.stack[0].scroll == -2);
    render(1000);
    swipe(360, 660, 360, 520, 1000);   // up from the bottom zone
    CHECK(U.nav.depth == 1 && top()->scroll == 1);
    render(1200);
    CHECK(find(POD_A_ENTER_TAB) && !strcmp(find(POD_A_ENTER_TAB)->id, "s2"));
}

// ---- v3b -----------------------------------------------------------------------------------------------------

// A: on Overview a swipe down (>= 80 px, |dy| > 1.5 |dx|) opens the Inbox, wherever it starts.
// A: a swipe down (>= 80 px, |dy| > 1.5 |dx|) opens the Inbox from the top edge only (y < 72); lower down it does nothing.
static void overview_down_opens_inbox(void) {
    static const int start[][2] = {{360, 20}, {200, 40}, {600, 60}, {100, 71}};   // the top edge
    for (unsigned k = 0; k < sizeof start / sizeof start[0]; k++) {
        fresh();
        render(1000);
        CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS);
        swipe(start[k][0], start[k][1], start[k][0], start[k][1] + 100, 1000);
        CHECK(U.nav.depth == 2 && top()->view == POD_V_INBOX);
    }
    static const int below[][2] = {{360, 72}, {360, 300}, {600, 500}, {100, 560}};   // a card, the right, the bottom zone
    for (unsigned k = 0; k < sizeof below / sizeof below[0]; k++) {
        fresh();
        render(1000);
        swipe(below[k][0], below[k][1], below[k][0], below[k][1] + 100, 1000);
        CHECK(U.nav.depth == 1);
    }
    // too short, too slanted, upward: nothing
    fresh();
    render(1000);
    swipe(360, 20, 360, 99, 1000);
    CHECK(U.nav.depth == 1);
    swipe(300, 20, 400, 150, 2000);   // dy 130 but dx 100: 130 < 1.5 * 100
    CHECK(U.nav.depth == 1);
    swipe(360, 430, 360, 300, 2000);
    CHECK(top()->view == POD_V_TABS);
    // the paging swipe still pages (six tabs)
    fresh6();
    render(1000);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->view == POD_V_TABS && top()->scroll == 1);
    // not from an agent screen below the edge
    fresh();
    to_agent(0, 0);
    render(1000);
    swipe(360, 300, 360, 420, 1000);
    CHECK(top()->view == POD_V_AGENT);
}

// M2: Overview paging is absolute and the scroll follows a shrinking tab list.
static void fresh8(void) {
    fresh();
    pod_model_question_close(&U.model, "a4");   // no notice, so no Notices card: the pages are the tabs
    calm(); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // and nobody works: no Working card either
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[8] = {x, x, x, x, x, x, x, x};
    uint8_t cnt[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    cable_swarm_t it[8] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3}, {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}, {"s7", "T7", 3, 3}, {"s8", "T8", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, 8, "s1", NULL, 0);
}
static void shrink_tabs_to(int n) {
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[8] = {x, x, x, x, x, x, x, x};
    uint8_t cnt[8] = {3, 3, 3, 3, 3, 3, 3, 3};
    cable_swarm_t it[8] = {{"s1", "T1", 3, 3}, {"s2", "T2", 3, 3}, {"s3", "T3", 3, 3}, {"s4", "T4", 3, 3}, {"s5", "T5", 3, 3}, {"s6", "T6", 3, 3}, {"s7", "T7", 3, 3}, {"s8", "T8", 3, 3}};
    pod_model_swarms(&U.model, it, ids, cnt, n, "s1", NULL, 0);
}
static void overview_scroll_follows_tab_removal(void) {
    // the glue alone: the frame keeps scroll 6 (tab 7 of 8) while the list shrinks to 6 tabs; a right swipe lands one before the last
    fresh8();
    render(1000);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 8);
    act(POD_A_SCROLL, 6);
    CHECK(top()->scroll == 6);
    shrink_tabs_to(6);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 6);
    render(2000);
    swipe(200, 300, 600, 310, 2000);
    CHECK(top()->scroll == 4);
    // and with the nav synced (the cable's path), the scroll is clamped to the last tab at once
    fresh8();
    render(1000);
    act(POD_A_SCROLL, 6);
    shrink_tabs_to(6);
    pod_nav_sync(&U.nav, &U.model);
    CHECK(top()->scroll == 5);
    render(2000);
    swipe(200, 300, 600, 310, 2000);
    CHECK(top()->scroll == 4);
    // down to two tabs
    fresh8();
    act(POD_A_SCROLL, 6);
    shrink_tabs_to(2);
    pod_nav_sync(&U.nav, &U.model);
    CHECK(top()->scroll == 1);
    // still pages normally, one tab a swipe, clamped
    fresh8();
    render(1000);
    swipe(600, 300, 200, 310, 1000);
    CHECK(top()->scroll == 1);
    swipe(600, 300, 200, 310, 2000);
    CHECK(top()->scroll == 2);
    for (int i = 0; i < 8; i++) swipe(600, 300, 200, 310, 3000 + 200 * (uint32_t)i);
    CHECK(top()->scroll == 7);
}

// L3: the tap does not arm anywhere in the bar's band.
static void talk_not_in_bar(void) {
    // a DOWN anywhere in the bar (no hit there) does not arm either
    fresh();
    to_agent(0, 0);
    render(1000);
    t_(true, 330, 10, 1000);
    CHECK(!U.talk_armed);
    CHECK(t_(false, 330, 10, 1100).fx == POD_FX_NONE && top()->view == POD_V_AGENT);
    // and the body still arms
    t_(true, MID_X, MID_Y, 2000);
    CHECK(U.talk_armed);
}

// L4: no bar swipe on Talk.
static void talk_ignores_bar_swipe(void) {
    fresh();
    to_agent(0, 0);
    act(POD_A_TALK, 0);
    render(1000);
    CHECK(top()->view == POD_V_TALK);
    int depth = U.nav.depth;
    t_(true, 330, 20, 1000); t_(true, 330, 70, 1040); t_(false, 330, 140, 1080);
    CHECK(U.nav.depth == depth && top()->view == POD_V_TALK);
}

// L5: the toast's 66 ms wake only while the toast is drawn; Home and Notices keep their own beat.
static void toast_cap_only_when_drawn(void) {
    fresh();
    calm();
    to_agent(0, 2);   // a3's Recap: a still room
    CHECK(pod_ui_notify(&U, "a1", POD_TIER_ALERT, true, 1000));
    render(1000);
    CHECK(U.ban_on && U.frame.banner);
    for (uint32_t t = 1000; t < 2000; t += 7) CHECK(pod_ui_wake_ms(&U, t) <= 66);
    // the toast's 5 s end is a wake edge too, and the bar needs no faster than 66 ms
    for (uint32_t t = 5900; t < 6000; t += 7) CHECK(pod_ui_wake_ms(&U, t) <= 66);
    // away from the room (Home): the toast is not drawn, the cap is off (a still Home sleeps until the expiry edge at most)
    act(POD_A_TABS, 0);
    render(1500);
    CHECK(!U.frame.banner);
    uint32_t most = 0;
    for (uint32_t t = 1500; t < 2500; t += 7) { uint32_t w = pod_ui_wake_ms(&U, t); if (w > most) most = w; }
    CHECK(most > 66);
}

// B and L6: Home's equaliser wakes at 66 ms while its tab works or asks; the other screens wake for what they draw.
static uint32_t wakes_in(uint32_t from, uint32_t span, uint32_t *min_gap) {
    uint32_t n = 0, t = from;
    *min_gap = 99999;
    while (t < from + span) { render(t); uint32_t w = pod_ui_wake_ms(&U, t); if (w < *min_gap) *min_gap = w; t += w; n++; }
    return n;
}
static void wake_rates(void) {
    uint32_t mn;
    {   // a1 works: Home moves its equaliser at 66 ms
        fresh();
        render(1000);
        for (uint32_t t = 1000; t < 1400; t += 13) CHECK(pod_ui_wake_ms(&U, t) <= 66);
        uint32_t n = wakes_in(2000, 10000, &mn);
        CHECK(n >= 10000 / 66 && n <= 10000 / 66 + 40);
    }
    {   // the Inbox has no bar and no pet: it is redrawn only when a visible age text turns over (nothing aged on screen: not at all until the model changes,
        // however many agents work); a working room is never forced to 66 ms
        fresh();
        act(POD_A_INBOX, 0);
        render(1000);
        uint32_t n = wakes_in(2000, 10000, &mn);
        CHECK(n == 1 && mn == 60000);
        pod_model_unread_clear(&U.model);
        pod_model_unread_add(&U.model, "a1", "a1", "Fixed the test. All green.", 40, 1000);   // "now" until it is a minute old, then "1m", "2m"
        render(1000);
        CHECK(pod_ui_wake_ms(&U, 1000) == 60000 && pod_ui_wake_ms(&U, 30000) == 31000);
        n = wakes_in(2000, 240000, &mn);
        CHECK(n == 5 && mn >= 1000);   // 2 s in, then the 1m, 2m, 3m and 4m marks: five wakes in four minutes, not 240
        pod_model_unread_clear(&U.model);
        CHECK(pod_ui_wake_ms(&U, 1000) == 60000);
        fresh();
        fresh();
        to_agent(1, 0);   // a4 asks while a1 works elsewhere
        render(1000);
        for (uint32_t t = 1000; t < 1400; t += 13) CHECK(pod_ui_wake_ms(&U, t) == ph_room_next_ms(&U.nav, &U.model, t) || pod_ui_wake_ms(&U, t) == 1000 - t % 1000);
        n = wakes_in(2000, 10000, &mn);
        uint32_t changes = 0;
        for (uint32_t t = 2000; t < 12000;) { uint32_t w = ph_room_next_ms(&U.nav, &U.model, t); if (w > 1000 - t % 1000) w = 1000 - t % 1000; changes++; t += w; }
        CHECK(n <= changes + 2);
    }
    {   // nobody works but Delta asks: Home has no pet and no equaliser, so it wakes once a second
        fresh();
        calm();
        render(1000);
        CHECK(!pod_ui_pet_on_screen(&U));
        uint32_t n = wakes_in(2000, 10000, &mn);
        CHECK(n == 10 && mn == 1000);
    }
    for (int k = 0; k < 2; k++) {   // nobody works or asks: Home and the Inbox, with no pet, wake once a second
        fresh();
        calm();
        pod_model_question_close(&U.model, "a4");
        calm(); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // and nobody works: no Working card either
        pod_model_turn(&U.model, "a4", "done", NULL, 0, 30);
        if (k == 1) act(POD_A_INBOX, 0);
        render(1000);
        uint32_t n = wakes_in(2000, 10000, &mn);
        if (k == 0) CHECK(n == 10 && mn == 1000);
        else CHECK(n == 1 && mn >= 1000);   // the Inbox (its two finished entries are "now" for a minute): no second beat, only an age turning over
    }
}

// M1: a Pets agent screen wakes for what it draws. The hero pet is drawn, so it steps at the pet's own rate; with no agent
// (nothing is drawn) or a pet-less engine it is once a second.
static void agent_screen_wakes(void) {
    uint32_t mn;
    fresh();
    calm();
    to_agent(0, 2);   // a3: gemini, done, with a recap
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    uint32_t n = wakes_in(2000, 10000, &mn);
    uint32_t pet_step = pod_pet_next_step_ms("gemini", ph_room_scene(&U.model, pod_model_find(&U.model, "a3")), 2000, 0);
    CHECK(pet_step >= 1000 ? n == 10 : n <= 10000 / 33);
    // a claude recap: bounded by its pet's step (never the 33 ms frame, no more than the pet changes)
    fresh();
    calm();
    pod_model_recap(&U.model, "a1", "Done.", false);
    to_agent(0, 0);
    CHECK(top()->view == POD_V_RECAP);
    render(1000);
    n = wakes_in(2000, 10000, &mn);
    uint32_t changes = 0;
    for (uint32_t t = 2000; t < 12000;) { uint32_t w = pod_pet_next_step_ms("claude", POD_SCENE_RELAX, t, 0); changes++; t += w; }
    CHECK(n <= changes + 10 && n < 10000 / 33);
    // the agent leaves the roster under an open screen: nothing is drawn, so a second
    fresh();
    calm();
    to_agent(0, 2);
    pod_model_agents_begin(&U.model);
    pod_model_agent(&U.model, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&U.model, "a2", "Beta", "codex", "mac");
    pod_model_agent(&U.model, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&U.model);
    CHECK(!pod_model_find(&U.model, "a3"));
    render(1000);
    n = wakes_in(2000, 10000, &mn);
    CHECK(n == 10 && mn == 1000);
}

// Pets Home (Task 8): one tab a page, sideways moves the page, a tap walks into the tab; the equaliser sets the 66 ms beat.
static void home_page(void) {
    fresh();
    pod_model_agents_begin(&U.model);
    static const char *const ids[] = {"a1", "a2", "a3"};
    for (int i = 0; i < 3; i++) pod_model_agent(&U.model, ids[i], ids[i], "claude", "mac");
    pod_model_agents_end(&U.model);
    const char *const *l[2] = {ids, ids + 2};
    uint8_t cnt[2] = {2, 1};
    cable_swarm_t it[2] = {{"s1", "Build", 2, 2}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&U.model, it, l, cnt, 2, "s1", NULL, 0);
    render(1000);
    CHECK(top()->view == POD_V_TABS && pod_scroll_max(&U.nav, &U.model) == 1);
    const pod_hit_t *h = find(POD_A_ENTER_TAB);
    CHECK(h && h->arg == 0 && !strcmp(h->id, "s1"));
    swipe(560, 300, 200, 310, 1100);   // sideways: the next tab
    render(1300);
    h = find(POD_A_ENTER_TAB);
    CHECK(top()->view == POD_V_TABS && top()->scroll == 1 && h && h->arg == 1 && !strcmp(h->id, "s2"));
    CHECK(tap_(h->x + h->w / 2, h->y + h->h / 2, 1400).fx == POD_FX_AGENT_OPEN && !strcmp(top()->agent, "a3"));
}

// A notice for the agent already on screen is shown in place: no beep or wake (false), no toast, and its entry is read at once.
// Dark (not awake), the same screen is not looked at: the entry stays and the glass is to be lit.
static void notify_while_looking(void) {
    fresh();
    to_agent(0, 2);   // a3, Recap
    CHECK(!pod_ui_notify(&U, "a3", POD_TIER_ALERT, true, 1000));
    CHECK(pod_model_unread_find(&U.model, "a3") == NULL && !U.ban_on);
    CHECK(pod_ui_notify(&U, "a3", POD_TIER_ALERT, false, 1100));
    CHECK(pod_model_unread_find(&U.model, "a3") != NULL);
    // list: filed, never a beep (false) nor a toast; silent: nothing filed.
    CHECK(!pod_ui_notify(&U, "a1", POD_TIER_LIST, true, 1200) && pod_model_unread_find(&U.model, "a1") && !U.ban_on);
    CHECK(!pod_ui_notify(&U, "a2", POD_TIER_SILENT, true, 1300) && !pod_model_unread_find(&U.model, "a2"));
}

// One swipe is one page, in the list's order: Notices, Working, Build, Docs.
static void home_pages_one_swipe_each(void) {
    fresh();   // a1 works, a4 asks
    render(1000);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 4);
    swipe(200, 300, 600, 310, 1000); CHECK(top()->scroll == -1);
    swipe(200, 300, 600, 310, 2000); CHECK(top()->scroll == -2);
    swipe(200, 300, 600, 310, 3000); CHECK(top()->scroll == -2);
    for (int i = 0; i < 4; i++) swipe(600, 300, 200, 310, 4000 + i * 1000);
    CHECK(top()->scroll == 1);
    swipe(200, 300, 600, 310, 9000); swipe(200, 300, 600, 310, 10000);
    CHECK(top()->scroll == -1);
    pod_ui_question_close(&U, "a4");   // Notices goes: Working is still the page shown
    CHECK(top()->scroll == -1);
    swipe(200, 300, 600, 310, 11000);  // the first page now
    CHECK(top()->scroll == -1);
}

// Home's Working card: a swipe starting on the pet band pages the pets, any other swipe pages cards, a tap opens a pet, Back returns to the card.
static void working_card(int n) {
    fresh();
    static const char *const id[6] = {"w1", "w2", "w3", "w4", "w5", "w6"};
    static const uint32_t since[6] = {10000, 50000, 30000, 40000, 20000, 5000};   // turn starts, ms: the newest (w2) first
    static const char *x[] = {"w1", "w2", "w3", "w4", "w5", "w6"};
    pod_model_reset(&U.model);
    pod_model_agents_begin(&U.model);
    for (int i = 0; i < n; i++) pod_model_agent(&U.model, id[i], id[i], "claude", "mac");
    pod_model_agents_end(&U.model);
    const char *const *ids[1] = {x};
    uint8_t cnt[1] = {(uint8_t)n};
    cable_swarm_t it[1] = {{"s1", "Build", (uint8_t)n, (uint8_t)n}};
    pod_model_swarms(&U.model, it, ids, cnt, 1, "s1", NULL, 0);
    for (int i = 0; i < n; i++) pod_model_turn(&U.model, id[i], "started", NULL, 0, since[i]);
    pod_model_clock(&U.model, 100000u);
    U.model.linked = true;
    U.nav.stack[0].scroll = POD_HOME_WORKING;
    render(100000);
}
static void working_card_swipes(void) {
    working_card(5);
    CHECK(top()->scroll == POD_HOME_WORKING && U.nav.work_page == 0);
    swipe(600, 430, 200, 440, 1000);
    CHECK(U.nav.work_page == 1 && top()->scroll == POD_HOME_WORKING);
    swipe(600, 256, 200, 440, 1300);   // the band's first row (where the pet hits start): still the pets; already the last page
    CHECK(U.nav.work_page == 1 && top()->scroll == POD_HOME_WORKING);
    swipe(200, 536, 600, 440, 1600);
    CHECK(U.nav.work_page == 0 && top()->scroll == POD_HOME_WORKING);
    swipe(200, 430, 600, 440, 1900);   // before the first pet page: stays, and the cards do not page
    CHECK(U.nav.work_page == 0 && top()->scroll == POD_HOME_WORKING);
    swipe(600, 430, 200, 440, 2200);
    swipe(600, 150, 200, 160, 2500);   // the title area: the next card, and the pets go back to page 0
    CHECK(top()->scroll == 0 && U.nav.work_page == 0);
    swipe(200, 150, 600, 160, 2800);
    CHECK(top()->scroll == POD_HOME_WORKING);
    swipe(600, 255, 200, 160, 3100);   // just above the band: cards
    CHECK(top()->scroll == 0);
    swipe(200, 150, 600, 160, 3400);
    swipe(600, 537, 200, 440, 3700);   // just below the band: cards
    CHECK(top()->scroll == 0 && U.nav.work_page == 0);
    working_card(6);   // a multiple of 3: two pages, no empty third
    swipe(600, 430, 200, 440, 1000);
    swipe(600, 430, 200, 440, 1300);
    CHECK(U.nav.work_page == 1 && top()->scroll == POD_HOME_WORKING);
    working_card(3);   // exactly 3: nothing to page, so the band swipe pages cards like any other (work_page stays 0)
    swipe(600, 430, 200, 440, 1000);
    CHECK(U.nav.work_page == 0 && top()->scroll == 0);
}
static void working_card_shrinks(void) {
    working_card(5);
    swipe(600, 430, 200, 440, 1000);
    CHECK(U.nav.work_page == 1);
    pod_model_turn(&U.model, "w1", "done", NULL, 0, 60000);   // 4 left: still 2 pages
    pod_nav_sync(&U.nav, &U.model);
    CHECK(U.nav.work_page == 1);
    pod_model_turn(&U.model, "w5", "done", NULL, 0, 61000);   // 3 left: one page
    pod_nav_sync(&U.nav, &U.model);
    CHECK(U.nav.work_page == 0 && top()->scroll == POD_HOME_WORKING);
}
static void working_card_tap_and_back(void) {
    working_card(5);
    const pod_hit_t *h = &U.frame.hits[0];
    int x = h->x + h->w / 2, y = h->y + h->h / 2;
    pod_out_t o = tap_(x, y, 2000);   // slot 0: the newest, w2
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "w2") && top()->view != POD_V_TABS && !strcmp(top()->agent, "w2"));
    act(POD_A_BACK, 1);
    CHECK(U.nav.depth == 1 && top()->view == POD_V_TABS && top()->scroll == POD_HOME_WORKING);
    render(103000);
    o = tap_(x, y, 4000);
    CHECK(o.fx == POD_FX_AGENT_OPEN);
    swipe(360, 690, 360, 500, 5000);   // the swipe up home
    CHECK(U.nav.depth == 1 && top()->scroll == POD_HOME_WORKING);
    // the agent leaves the model between draw and tap: nothing opens, and the screen is redrawn
    render(106000);
    pod_model_agents_begin(&U.model);
    pod_model_agent(&U.model, "w1", "w1", "claude", "mac");
    pod_model_agent(&U.model, "w3", "w3", "claude", "mac");
    pod_model_agent(&U.model, "w4", "w4", "claude", "mac");
    pod_model_agent(&U.model, "w5", "w5", "claude", "mac");
    pod_model_agents_end(&U.model);
    bool changed = false;
    t_(true, x, y, 7000);
    o = pod_ui_touch(&U, false, x, y, 7050, &changed);
    CHECK(o.fx == POD_FX_NONE && changed && U.nav.depth == 1);
}


// Home's Swarm card: tab "s1" (Build) is linked to Swarm sw1 with n Leads, an unlinked Swarm sw2 follows the tabs. A swipe in the pet band pages the Leads,
// past the last page it moves to the next card, anywhere else it pages cards; a tap on a pet is a POD_A_LEAD hit and opens nothing yet.
static void swarm_home(int n) {
    fresh();
    pod_model_question_close(&U.model, "a4");   // no notice: no Notices card
    calm(); pod_model_turn(&U.model, "a4", "done", NULL, 0, 31);   // nobody works: no Working card
    static const char sw_ids[2][ID_MAX] = {"sw1", "sw2"};
    static pod_swarm_t sw;
    pod_model_supertab_ids(&U.model, sw_ids, 2);
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "s1"); snprintf(sw.name, sizeof sw.name, "openharness");
    sw.count = (uint16_t)n; sw.lead_n = (uint8_t)n;
    for (int i = 0; i < n; i++) {
        snprintf(sw.leads[i].id, ID_MAX, "l%d", i); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj%d", i);
        snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); sw.leads[i].state = POD_LEAD_DONE;
    }
    pod_model_supertab(&U.model, &sw, 1000);
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw2"); snprintf(sw.name, sizeof sw.name, "Solo"); sw.count = 1; sw.lead_n = 1;
    snprintf(sw.leads[0].id, ID_MAX, "s0"); snprintf(sw.leads[0].project, sizeof sw.leads[0].project, "ops"); snprintf(sw.leads[0].engine, sizeof sw.leads[0].engine, "claude");
    pod_model_supertab(&U.model, &sw, 1000);
    U.nav.stack[0].scroll = 0;
    render(2000);
}
static void swarm_card_pages(void) {
    swarm_home(4);
    CHECK(pod_tabs_pages_of(&U.nav, &U.model) == 3 && top()->scroll == 0 && U.nav.swarm_page == 0);   // Build (the Swarm), Docs, then Solo with no desk tab
    CHECK(find(POD_A_LEAD) && !find(POD_A_ENTER_TAB));
    swipe(600, 430, 200, 440, 3000);   // the pet band: the second page of Leads
    CHECK(U.nav.swarm_page == 1 && top()->scroll == 0);
    swipe(600, 256, 200, 440, 3300);   // the band's first row; past the last page: the next card
    CHECK(top()->scroll == 1 && U.nav.swarm_page == 0);
    swipe(200, 150, 600, 160, 3600);   // back on the Swarm
    CHECK(top()->scroll == 0);
    swipe(600, 430, 200, 440, 4000);
    swipe(200, 536, 600, 440, 4300);   // the band's last row, to the first page
    CHECK(U.nav.swarm_page == 0 && top()->scroll == 0);
    swipe(200, 430, 600, 440, 4600);   // before the first page: no card before it, nothing moves
    CHECK(U.nav.swarm_page == 0 && top()->scroll == 0);
    swipe(600, 430, 200, 440, 5000);
    swipe(600, 150, 200, 160, 5300);   // the title area pages cards and the Leads go back to page 0
    CHECK(top()->scroll == 1 && U.nav.swarm_page == 0);
    swipe(600, 150, 200, 160, 5600);   // Solo, the Swarm with no desk tab, is the last page
    CHECK(top()->scroll == 2);
    render(6000);
    CHECK(find(POD_A_LEAD) && !strcmp(find(POD_A_LEAD)->id, "sw2"));
    swipe(600, 430, 200, 440, 6300);   // one page of Leads only: the band swipe moves on, and there is no card after the last
    CHECK(top()->scroll == 2);
    swipe(200, 430, 600, 440, 6600);   // and back
    CHECK(top()->scroll == 1);
}
static void swarm_card_few_leads(void) {
    swarm_home(3);   // exactly 3: nothing to page, so the band swipe pages cards like any other
    swipe(600, 430, 200, 440, 3000);
    CHECK(U.nav.swarm_page == 0 && top()->scroll == 1);
}
static uint32_t NOW = 3000;   // the clock a focus is fed (the quiet window counts from the last touch)
static pod_supertab_out_t Q[POD_SUPERTAB_OUT_MAX];
static int take(void) { return pod_ui_take_supertab(&U, Q, POD_SUPERTAB_OUT_MAX); }
static bool is_q(int i, const char *t, const char *tab, const char *lead) { return !strcmp(Q[i].t, t) && !strcmp(Q[i].tab, tab) && !strcmp(Q[i].lead, lead); }
static int hit_count_of(pod_action_t a) { int n = 0; for (int i = 0; i < U.frame.hit_count; i++) n += U.frame.hits[i].action == a; return n; }
static void tap_lead(int k, uint32_t t) {   // a tap on the pet of the card's Lead at index k (the page holding it must be on screen)
    render(t - 50);
    for (int i = 0; i < U.frame.hit_count; i++)
        if (U.frame.hits[i].action == POD_A_LEAD && U.frame.hits[i].arg == k) { tap_(U.frame.hits[i].x + U.frame.hits[i].w / 2, U.frame.hits[i].y + U.frame.hits[i].h / 2, t); return; }
    CHECK(!"no hit for that Lead");
}
static void swarm_card_tap(void) {
    swarm_home(4);
    const pod_hit_t *h = find(POD_A_LEAD);
    CHECK(h && h->arg == 0 && !strcmp(h->id, "sw1"));
    const int x = h->x + h->w / 2, y = h->y + h->h / 2;
    pod_out_t o = tap_(x, y, 3000);   // the tap opens the Lead view over Home (the card's page stays under it) and picks the Lead on the desktop
    CHECK(o.fx == POD_FX_NONE && U.nav.depth == 2 && top()->view == POD_V_LEAD && U.nav.stack[0].view == POD_V_TABS && U.nav.stack[0].scroll == 0);
    CHECK(!strcmp(top()->swarm, "sw1") && !strcmp(top()->lead_id, "l0") && top()->lead == 0);
    swarm_home(4);
    swipe(600, 430, 200, 440, 4000);
    render(4500);
    h = find(POD_A_LEAD);
    CHECK(h && h->arg == 3 && !strcmp(h->id, "sw1"));
    CHECK(tap_(h->x + h->w / 2, h->y + h->h / 2, 5000).fx == POD_FX_NONE && top()->view == POD_V_LEAD && top()->lead == 3 && U.nav.swarm_page == 1);
}

// A notice of a harness that is a Swarm's Lead: its row opens that Lead's view in the Swarm (and picks it on the desktop), not the agent as a plain one
// (which sent agent.open, and the desktop opened the agent in a new tab). The entry is read. A notice of any other agent still opens the agent.
static void notice_opens_lead(void) {
    swarm_home(4);
    snprintf(U.model.swarms[0].leads[2].local, ID_MAX, "a3");
    pod_model_unread_add(&U.model, "a3", "Gamma", "Merged.", 20, 2100);
    act(POD_A_INBOX, 0);
    render(2500);
    const pod_hit_t *h = find(POD_A_OPEN_NOTIF);
    CHECK(h && !strcmp(h->id, "a3"));
    take();
    pod_out_t o = tap_(h->x + h->w / 2, h->y + h->h / 2, 3000);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_LEAD && !strcmp(top()->swarm, "sw1") && !strcmp(top()->lead_id, "l2"));
    CHECK(U.nav.depth == 2 && U.nav.stack[0].view == POD_V_TABS && !pod_model_unread_find(&U.model, "a3"));   // Back lands on the Swarm's card
    CHECK(take() >= 1 && is_q(0, "supertab.select", "sw1", "l2"));
    // not a Lead: the agent opens as before
    swarm_home(4);
    pod_model_unread_add(&U.model, "a2", "Beta", "Done.", 20, 2100);
    act(POD_A_INBOX, 0);
    render(2500);
    h = find(POD_A_OPEN_NOTIF);
    CHECK(h && !strcmp(h->id, "a2"));
    o = tap_(h->x + h->w / 2, h->y + h->h / 2, 3000);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a2") && top()->view != POD_V_LEAD);
}

// ---- a Swarm chat's notice: the alert tier of the glue (toast + Notices row), read by its chat, opening its Lead ----
static void swarm_lead_open(int k) {   // sw1 on Home, the Lead at index k open
    swarm_home(4);
    tap_lead(k, 3000);
    CHECK(top()->view == POD_V_LEAD && top()->lead == k);
    take();
    render(3300);
}
static void swarm_notice_toasts_and_beeps(void) {
    swarm_lead_open(1);   // l1's view: a notice from l2 is for another screen
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l2", "pm", "c1", "Cable fit now counts tokens. More.", true, 3400));
    const pod_unread_t *e = pod_model_unread_find(&U.model, "l2");
    CHECK(e && !strcmp(e->tab, "sw1") && !strcmp(e->chat_id, "c1") && !strcmp(e->name, "proj2") && U.model.unread_count == 1);
    CHECK(U.ban_on && U.ban_until == 3400 + POD_TOAST_MS && !U.ban_stay);
    render(3400);
    CHECK(U.frame.banner && hits_of_banner() == 1 && !strcmp(find(POD_A_BANNER)->id, "l2"));
    // it runs out like any toast; the row stays
    render(3400 + POD_TOAST_MS);
    CHECK(!U.frame.banner && !U.ban_on && pod_model_unread_find(&U.model, "l2"));
    // a room is a place for it too, and a notice for a Lead the model does not hold is dropped
    fresh();
    to_agent(0, 2);
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l9", "pm", "c1", "x", true, 4000) && U.model.unread_count == 0);
    swarm_home(4);
    to_agent(0, 2);
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l0", "pm", "c1", "Hi.", true, 4000) && U.ban_on);
    render(4000);
    CHECK(U.frame.banner);
    // a dark glass is news: the row, and the caller wakes
    swarm_lead_open(1);
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l1", "pm", "c1", "Hi.", false, 4000) && pod_model_unread_find(&U.model, "l1"));
}
static void notif_replace_keeps_swarm_notices(void) {
    swarm_lead_open(1);
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l2", "pm", "c1", "Merged.", true, 3400));
    pod_model_unread_add(&U.model, "a2", "Beta", "Done.", 20, 3410);
    pod_ui_notif_begin(&U);
    CHECK(pod_model_unread_find(&U.model, "l2") && !pod_model_unread_find(&U.model, "a2") && U.model.unread_count == 1);
    pod_ui_notif_end(&U);
}
static void swarm_notice_on_its_lead_view_reads_at_once(void) {
    swarm_lead_open(1);
    snprintf(U.model.swarms[0].leads[1].chat_id, ID_MAX, "c1");   // the face shows the chat the notice is for
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l1", "pm", "c1", "Seen already.", true, 3400));
    CHECK(U.model.unread_count == 0 && !U.ban_on);
    render(3500);
    CHECK(!U.frame.banner);
}
static void notice_for_other_chat_on_lead_view_files_row(void) {
    swarm_lead_open(1);
    snprintf(U.model.swarms[0].leads[1].chat_id, ID_MAX, "g1");   // the face shows g1; the notice is for c1
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l1", "pm", "c1", "Elsewhere.", true, 3400));
    const pod_unread_t *e = pod_model_unread_find(&U.model, "l1");
    CHECK(e && !strcmp(e->chat_id, "c1"));
}
static void notice_for_face_chat_on_lead_view_clears_old_row(void) {
    swarm_lead_open(1);
    snprintf(U.model.swarms[0].leads[1].chat_id, ID_MAX, "g1");
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l1", "pm", "c1", "Older.", true, 3300));   // an older row of this Lead
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l1", "pm", "g1", "Seen.", true, 3400));
    CHECK(!pod_model_unread_find(&U.model, "l1") && U.model.unread_count == 0);
}
static void chat_switch_asks_recap_at_once(void) {
    swarm_lead_open(1);
    take();
    U.model.clock_ms += 10 * POD_SUPERTAB_RETRY_MS;
    for (int i = 0; i < POD_SUPERTAB_RETRIES + 2; i++) { U.model.clock_ms += POD_SUPERTAB_RETRY_MS; take(); }   // retries exhausted, the bubble is "..."
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_LOADING && take() == 0);
    static pod_swarm_t sw;
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "s1"); snprintf(sw.name, sizeof sw.name, "openharness"); sw.count = 4; sw.lead_n = 4;
    for (int i = 0; i < 4; i++) { snprintf(sw.leads[i].id, ID_MAX, "l%d", i); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj"); snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); }
    snprintf(sw.leads[1].chat_id, ID_MAX, "g9");
    pod_ui_supertab(&U, &sw, U.model.clock_ms);
    int n = take();
    bool got = false;
    for (int i = 0; i < n; i++) got |= is_q(i, "supertab.recap.get", "sw1", "l1");
    CHECK(got);
}
static void swarm_toast_tap_opens_lead_and_selects(void) {
    swarm_lead_open(1);
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l2", "pm", "c1", "Merged.", true, 3400));
    render(3400);
    CHECK(U.frame.banner);
    pod_out_t o = tap_(360, 80, 3500);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_LEAD && !strcmp(top()->swarm, "sw1") && !strcmp(top()->lead_id, "l2") && U.nav.depth == 2);
    CHECK(!U.ban_on && U.model.unread_count == 0);
    CHECK(take() >= 1 && is_q(0, "supertab.select", "sw1", "l2"));
}
static void swarm_row_tap_opens_lead_and_selects(void) {
    swarm_home(4);
    pod_model_unread_add(&U.model, "a2", "Beta", "Done.", 20, 2100);
    CHECK(pod_ui_swarm_notice(&U, "sw1", "l3", "pm", "c1", "Merged.", true, 2200));
    act(POD_A_INBOX, 0);
    render(2500);
    const pod_hit_t *h = NULL;
    for (int i = 0; i < U.frame.hit_count; i++) if (U.frame.hits[i].action == POD_A_OPEN_NOTIF && !strcmp(U.frame.hits[i].id, "l3")) h = &U.frame.hits[i];
    CHECK(h);
    take();
    pod_out_t o = tap_(h->x + h->w / 2, h->y + h->h / 2, 3000);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_LEAD && !strcmp(top()->swarm, "sw1") && !strcmp(top()->lead_id, "l3"));
    CHECK(U.nav.depth == 2 && U.nav.stack[0].view == POD_V_TABS && !pod_model_unread_find(&U.model, "l3") && pod_model_unread_find(&U.model, "a2"));
    CHECK(take() >= 1 && is_q(0, "supertab.select", "sw1", "l3"));
}
static void swarm_notice_read_ends_toast(void) {
    swarm_lead_open(1);
    pod_ui_swarm_notice(&U, "sw1", "l2", "pm", "c1", "Merged.", true, 3400);
    render(3400);
    CHECK(U.frame.banner);
    pod_ui_swarm_notice_read(&U, "sw1", "l2", "c2");   // another chat's read: the row and the toast stay
    render(3500);
    CHECK(U.frame.banner && pod_model_unread_find(&U.model, "l2"));
    pod_ui_swarm_notice_read(&U, "sw1", "l2", "c1");
    render(3600);
    CHECK(!U.ban_on && !U.frame.banner && !pod_model_unread_find(&U.model, "l2"));
    // a read of an entry that is not the toast's leaves that toast up
    pod_ui_swarm_notice(&U, "sw1", "l2", "pm", "c1", "Merged.", true, 3700);
    pod_model_unread_add(&U.model, "a1", "Alpha", "x", 1, 3700);
    pod_ui_swarm_notice(&U, "sw1", "l0", "pm", "c5", "Other.", true, 3750);   // the newer toast is l0's
    pod_ui_swarm_notice_read(&U, "sw1", "l2", "c1");
    render(3800);
    CHECK(U.ban_on && !strcmp(U.ban_agent, "l0") && U.frame.banner);
}

// ---- the Lead view ----
static void lead_tap_sends(void) {
    swarm_home(4);
    tap_lead(1, 3000);
    CHECK(top()->view == POD_V_LEAD && top()->lead == 1 && !strcmp(top()->lead_id, "l1"));
    CHECK(take() == 3 && is_q(0, "supertab.select", "sw1", "l1") && is_q(1, "supertab.open", "sw1", "l1") && is_q(2, "supertab.recap.get", "sw1", "l1"));
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_LOADING && take() == 0);   // asked once; nothing repeats while nothing changes
    render(3500);
    CHECK(U.frame.hit_count == 0);
    // the text arrives: LOADED, nothing more is sent
    pod_ui_supertab_recap(&U, "sw1", "l1", "", "Merged.", 1792560000u, false);
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_LOADED && take() == 0);
    pod_nav_act(&U.nav, &U.model, POD_A_BACK, 0, 4000);
    CHECK(take() == 1 && is_q(0, "supertab.open", "sw1", ""));
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_NONE && U.model.swarms[0].leads[1].text == NULL);   // closed: its text would go stale, so it goes
    // a Lead whose text is already LOADED is not asked for again: select and open only
    swarm_home(4);
    asked_recap(&U.model, "sw1", "l2", "Cached.", 1, false);
    tap_lead(2, 3000);
    CHECK(take() == 2 && is_q(0, "supertab.select", "sw1", "l2") && is_q(1, "supertab.open", "sw1", "l2"));
}
// A lost supertab.open / supertab.recap.get is asked again every 3 s while the Lead is LOADING (5 times at most); a loaded Lead hears supertab.open once more.
static void lead_retry(void) {
    swarm_home(4);
    tap_lead(1, 3000);
    CHECK(take() == 3 && U.model.swarms[0].leads[1].recap == POD_RECAP_LOADING);
    render(5000);
    CHECK(take() == 0);   // not yet
    for (int k = 1; k <= POD_SUPERTAB_RETRIES; k++) {
        render(3000 + 3000u * (uint32_t)k);
        CHECK(take() == 2 && is_q(0, "supertab.open", "sw1", "l1") && is_q(1, "supertab.recap.get", "sw1", "l1"));
        render(3000 + 3000u * (uint32_t)k + 2999);
        CHECK(take() == 0);
    }
    render(60000);
    CHECK(take() == 0 && U.model.swarms[0].leads[1].recap == POD_RECAP_LOADING);   // then it stops, the "…" stays
    // a send the link dropped is not counted: the retry comes again in 3 s
    swarm_home(4);
    tap_lead(1, 3000);
    CHECK(take() == 3);
    render(6000);
    CHECK(take() == 2);
    pod_ui_supertab_unsent(&U, &Q[0]);
    pod_ui_supertab_unsent(&U, &Q[1]);
    render(8999);
    CHECK(take() == 0);
    render(9000);
    CHECK(take() == 2 && U.sup_tries == 1);
    // a Lead that answered is told once more that it is open, then left alone
    pod_ui_supertab_recap(&U, "sw1", "l1", "", "Merged.", 1792560000u, false);
    render(12000);
    CHECK(take() == 1 && is_q(0, "supertab.open", "sw1", "l1"));
    render(20000);
    CHECK(take() == 0);
    // a re-open that was dropped is owed again
    swarm_home(4);
    pod_model_supertab_loading(&U.model, "sw1", "l2");
    asked_recap(&U.model, "sw1", "l2", "Cached.", 1, false);
    tap_lead(2, 3000);
    CHECK(take() == 2);
    render(6000);
    CHECK(take() == 1);
    pod_ui_supertab_unsent(&U, &Q[0]);
    render(9000);
    CHECK(take() == 1 && is_q(0, "supertab.open", "sw1", "l2"));
    // a full queue records nothing: the next sync sends the whole of it
    swarm_home(4);
    tap_lead(1, 3000);
    U.sup_qn = POD_SUPERTAB_OUT_MAX - 1;
    CHECK(take() == POD_SUPERTAB_OUT_MAX - 1 && U.sup_lead[0] == 0 && U.model.swarms[0].leads[1].recap == POD_RECAP_NONE);
    CHECK(take() == 2 && is_q(0, "supertab.open", "sw1", "l1") && is_q(1, "supertab.recap.get", "sw1", "l1") && U.model.swarms[0].leads[1].recap == POD_RECAP_LOADING);
}
static void lead_swipe_steps(void) {
    swarm_home(4);
    tap_lead(1, 3000);
    CHECK(take() == 3);
    pod_ui_supertab_recap(&U, "sw1", "l1", "", "One.", 1, false);
    render(3500);
    swipe(600, 400, 200, 410, 4000);   // left: the next Lead, in card order
    CHECK(top()->view == POD_V_LEAD && top()->lead == 2 && !strcmp(top()->lead_id, "l2") && U.nav.depth == 2);
    CHECK(take() == 3 && is_q(0, "supertab.select", "sw1", "l2") && is_q(1, "supertab.open", "sw1", "l2") && is_q(2, "supertab.recap.get", "sw1", "l2"));
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_NONE);   // the one left goes cold
    swipe(200, 400, 600, 410, 5000);   // right: back to the previous
    CHECK(top()->lead == 1 && take() == 3 && is_q(0, "supertab.select", "sw1", "l1"));
    swipe(200, 400, 600, 410, 6000);
    swipe(200, 400, 600, 410, 7000);
    CHECK(top()->lead == 3);   // before the first Lead is the last: the Leads go round like panes
    CHECK(take() >= 3);
    swipe(600, 400, 200, 410, 8000);
    CHECK(top()->lead == 0);
    CHECK(sc_events == 0);   // no pane of the host scrolls for a swipe or a drag here
    // a Swarm with one Lead has nowhere to go: no select
    swarm_home(4);
    U.nav.stack[0].scroll = 2;
    render(2000);
    tap_lead(0, 3000);
    CHECK(!strcmp(top()->swarm, "sw2") && take() == 3);
    swipe(600, 400, 200, 410, 4000);
    CHECK(top()->lead == 0 && take() == 0);
}
static void lead_leave_closes(void) {
    swarm_home(4);
    swipe(600, 430, 200, 440, 2500);   // the second page of Leads
    CHECK(U.nav.swarm_page == 1);
    tap_lead(3, 3000);
    CHECK(top()->view == POD_V_LEAD && take() == 3);
    CHECK(U.nav.depth == 2 && U.nav.swarm_page == 1);   // Home kept the page it was on under the view
    pod_nav_act(&U.nav, &U.model, POD_A_BACK, 1, 4000);   // the side button
    CHECK(U.nav.depth == 1 && U.nav.swarm_page == 1 && take() == 1 && is_q(0, "supertab.open", "sw1", ""));
    render(4500);
    CHECK(find(POD_A_LEAD) && find(POD_A_LEAD)->arg == 3);   // back on the card, on the page the person left
    // a swipe up from the bottom zone is Home too
    tap_lead(3, 5000);
    CHECK(top()->view == POD_V_LEAD && take() == 3);
    render(5500);
    swipe(360, 690, 360, 400, 6000);
    CHECK(U.nav.depth == 1 && U.nav.swarm_page == 1 && take() == 1 && is_q(0, "supertab.open", "sw1", ""));
    // Notices over the view closes it for the desktop, and Back from Notices opens it again
    tap_lead(3, 7000);
    take();
    pod_nav_act(&U.nav, &U.model, POD_A_INBOX, 0, 7500);
    CHECK(top()->view == POD_V_INBOX && take() == 1 && is_q(0, "supertab.open", "sw1", ""));
    pod_nav_act(&U.nav, &U.model, POD_A_BACK, 1, 8000);
    CHECK(top()->view == POD_V_LEAD && take() == 2 && is_q(0, "supertab.open", "sw1", "l3") && is_q(1, "supertab.recap.get", "sw1", "l3"));
}
static void lead_scrolls(void) {
    swarm_home(4);
    tap_lead(0, 3000);
    take();
    pod_ui_supertab_recap(&U, "sw1", "l0", "", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
                          "twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two", 1, false);
    render(3500);
    CHECK(pod_scroll_max(&U.nav, &U.model) > 1 && top()->scroll == 0);
    t_(true, 360, 500, 4000); t_(true, 360, 400, 4100); t_(true, 360, 300, 4200); t_(false, 360, 300, 4250);
    CHECK(top()->view == POD_V_LEAD && top()->scroll >= 1 && top()->lead == 0 && take() == 0);   // the drag moved the text and sent no Swarm frame
    CHECK(sc_down == 1 && sc_move > 0 && sc_up == 1);   // and the desktop's chat follows it, as an agent screen's drag scrolls its pane
    t_(true, 360, 300, 5000); t_(true, 360, 500, 5100); t_(true, 360, 700, 5200); t_(false, 360, 700, 5250);
    CHECK(top()->scroll == 0);
}
static void lead_talk(void) {
    swarm_home(4);
    pod_swarm_t *sw = (pod_swarm_t *)pod_model_swarm(&U.model, "sw1");
    snprintf(sw->leads[1].local, ID_MAX, "a1");   // Alpha is this Lead's harness
    tap_lead(1, 3000);
    CHECK(!strcmp(top()->agent, "a1") && take() == 3);
    render(3500);
    pod_out_t o = tap_(MID_X, MID_Y, 4000);   // a tap on the view: talk to the harness
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK && !strcmp(top()->swarm, "sw1") && take() == 0);   // still the open recap: no close
    render(4500);
    o = tap_(MID_X, MID_Y, 5000);
    CHECK(o.fx == POD_FX_VOICE_END && top()->view == POD_V_TALK);
    pod_ui_talk_over(&U);
    CHECK(top()->view == POD_V_LEAD && take() == 0 && U.nav.depth == 2);
    // a step while talking moves nothing
    pod_nav_act(&U.nav, &U.model, POD_A_TALK, 0, 6000);
    CHECK(top()->view == POD_V_TALK);
    pod_nav_act(&U.nav, &U.model, POD_A_NEXT, 0, 6100);
    CHECK(top()->view == POD_V_TALK && top()->lead == 1);
    pod_ui_talk_over(&U);
    // a remote Lead (no local harness, no swarm.remote) has no talk control; one whose local harness is off the roster does: see local_lead_not_in_roster_talks_with_local
    swipe(600, 400, 200, 410, 7000);
    CHECK(top()->lead == 2 && !top()->agent[0]);
    render(7500);
    CHECK(tap_(MID_X, MID_Y, 8000).fx == POD_FX_NONE && top()->view == POD_V_LEAD);
    swipe(600, 400, 200, 410, 9000);
    CHECK(top()->lead == 3 && !top()->agent[0] && tap_(MID_X, MID_Y, 10000).fx == POD_FX_NONE && top()->view == POD_V_LEAD);
    CHECK(pod_nav_act(&U.nav, &U.model, POD_A_TALK, 0, 11000).fx == POD_FX_NONE && top()->view == POD_V_LEAD);
}
static void lead_focus(void) {
    swarm_home(4);
    pod_ui_supertab_focus(&U, "sw1", "l2", NOW);   // the desktop opened that project
    CHECK(U.nav.depth == 2 && top()->view == POD_V_LEAD && top()->lead == 2 && !U.model.focus_pending && U.nav.stack[0].scroll == 0 && U.nav.swarm_page == 0);
    CHECK(take() == 2 && is_q(0, "supertab.open", "sw1", "l2") && is_q(1, "supertab.recap.get", "sw1", "l2"));   // no select: the desktop is already there
    pod_ui_supertab_focus(&U, "sw1", "l2", NOW);   // the same Lead again: nothing changes
    CHECK(top()->lead == 2 && take() == 0);
    pod_ui_supertab_focus(&U, "sw1", "l3", NOW);   // another: the view moves on, the open recap follows
    CHECK(top()->lead == 3 && U.nav.swarm_page == 1 && take() == 2 && is_q(0, "supertab.open", "sw1", "l3"));
    // a Swarm the person has no desk tab for: Home lands on its own page
    pod_ui_supertab_focus(&U, "sw2", "s0", NOW);
    CHECK(top()->view == POD_V_LEAD && !strcmp(top()->swarm, "sw2") && U.nav.stack[0].scroll == 2 && U.nav.swarm_page == 0);
    take();
    // not while recording
    swarm_home(4);
    to_agent(0, 0);
    render(1000);
    pod_out_t o = tap_(MID_X, MID_Y, 5000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && pod_ui_talking(&U));
    pod_ui_supertab_focus(&U, "sw1", "l2", NOW);
    CHECK(pod_ui_talking(&U) && top()->view == POD_V_TALK && !U.model.focus_pending);   // dropped, not kept
    // not while the update is on screen
    swarm_home(4);
    pod_ui_ota(&U, "0.1.0", "0.1.1", 30, false);
    pod_ui_supertab_focus(&U, "sw1", "l2", NOW);
    CHECK(U.nav.depth == 1 && !U.model.focus_pending);
    pod_ui_ota(&U, NULL, NULL, -1, false);
    // not while the person is driving elsewhere (a touch within the quiet window)
    swarm_home(4);
    to_agent(0, 2);
    render(1000);
    U.touched = true; U.last_touch_ms = 1000;   // a touch a moment ago
    U.model.clock_ms = 1500;
    pod_ui_supertab_focus(&U, "sw1", "l1", NOW);
    CHECK(top()->view == POD_V_RECAP && !U.model.focus_pending);
    // pending until the Swarm list has it
    swarm_home(4);
    pod_ui_supertab_focus(&U, "sw9", "x1", NOW);
    CHECK(U.nav.depth == 1 && U.model.focus_pending);
    static const char ids[3][ID_MAX] = {"sw1", "sw2", "sw9"};
    pod_ui_supertab_ids(&U, ids, 3);
    CHECK(U.nav.depth == 1 && U.model.focus_pending);   // listed, not received
    static pod_swarm_t sw;
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw9"); snprintf(sw.name, sizeof sw.name, "Late"); sw.count = 1; sw.lead_n = 1;
    snprintf(sw.leads[0].id, ID_MAX, "x1"); snprintf(sw.leads[0].project, sizeof sw.leads[0].project, "p"); snprintf(sw.leads[0].engine, sizeof sw.leads[0].engine, "claude");
    pod_ui_supertab(&U, &sw, 2000);
    CHECK(top()->view == POD_V_LEAD && !strcmp(top()->swarm, "sw9") && !U.model.focus_pending && take() == 2);
    // a focus that never finds its Lead is dropped after the waiting time
    swarm_home(4);
    pod_ui_supertab_focus(&U, "sw1", "ghost", NOW);
    CHECK(U.model.focus_pending);
    U.model.clock_ms += POD_FOLLOW_PENDING_MS + 100;
    pod_ui_supertab_ids(&U, ids, 2);
    CHECK(!U.model.focus_pending && U.nav.depth == 1);
}
static void empty_focus_opens_last_lead(void) {
    swarm_home(4);
    pod_ui_supertab_focus(&U, "sw1", "l2", NOW);
    take();   // the Lead view is on screen: the sync remembers it
    U.nav.depth = 1; U.dirty = true;   // back at Home
    take();
    pod_ui_supertab_focus(&U, "sw1", "", NOW);   // the desktop opened the Swarm with no project: the Lead last shown here
    CHECK(U.nav.depth == 2 && top()->view == POD_V_LEAD && top()->lead == 2 && !strcmp(top()->swarm, "sw1") && !U.model.focus_pending);
}
static void empty_focus_opens_first_without_history(void) {
    swarm_home(4);
    pod_ui_supertab_focus(&U, "sw1", "", NOW);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_LEAD && top()->lead == 0 && !strcmp(top()->swarm, "sw1") && !U.model.focus_pending);
}
static void empty_focus_last_lead_gone_opens_first(void) {
    swarm_home(4);
    pod_ui_supertab_focus(&U, "sw1", "l3", NOW);
    take();
    U.nav.depth = 1; U.dirty = true;
    take();
    static pod_swarm_t sw;   // l3 leaves the Swarm
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "s1"); snprintf(sw.name, sizeof sw.name, "openharness"); sw.count = 3; sw.lead_n = 3;
    for (int i = 0; i < 3; i++) { snprintf(sw.leads[i].id, ID_MAX, "l%d", i); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj"); snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); }
    pod_ui_supertab(&U, &sw, 3000);
    pod_ui_supertab_focus(&U, "sw1", "", NOW);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_LEAD && top()->lead == 0 && !U.model.focus_pending);
}
static void empty_focus_unknown_swarm_waits_then_drops(void) {
    swarm_home(4);
    pod_ui_supertab_focus(&U, "swX", "", NOW);
    CHECK(U.model.focus_pending && U.nav.depth == 1);
    U.model.clock_ms += POD_FOLLOW_PENDING_MS + 100;
    static const char ids[2][ID_MAX] = {"sw1", "sw2"};
    pod_ui_supertab_ids(&U, ids, 2);
    CHECK(!U.model.focus_pending && U.nav.depth == 1);
}
static void empty_focus_respects_quiet_window(void) {
    swarm_home(4);
    U.touched = true; U.last_touch_ms = 1400;   // a touch 100 ms ago
    pod_ui_supertab_focus(&U, "sw1", "", 1500);
    CHECK(U.nav.depth == 1 && !U.model.focus_pending);
}
static void lead_removed(void) {
    swarm_home(4);
    tap_lead(1, 3000);
    take();
    // l1 leaves: the view moves to the Lead that took its place (the next one)
    static pod_swarm_t sw;
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "s1"); snprintf(sw.name, sizeof sw.name, "openharness"); sw.count = 3; sw.lead_n = 3;
    const char *keep[3] = {"l0", "l2", "l3"};
    for (int i = 0; i < 3; i++) { snprintf(sw.leads[i].id, ID_MAX, "%s", keep[i]); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj"); snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); }
    pod_ui_supertab(&U, &sw, 4000);
    CHECK(U.nav.depth == 2 && top()->view == POD_V_LEAD && !strcmp(top()->lead_id, "l2") && top()->lead == 1);
    CHECK(take() == 2 && is_q(0, "supertab.open", "sw1", "l2") && is_q(1, "supertab.recap.get", "sw1", "l2"));
    // it leaves too: the next one again (l3 is now at its index)
    snprintf(sw.leads[1].id, ID_MAX, "l3"); sw.lead_n = 2;
    pod_ui_supertab(&U, &sw, 4050);
    CHECK(!strcmp(top()->lead_id, "l3") && top()->lead == 1 && U.nav.depth == 2);
    take();
    // the last Lead leaves while it is the one open: the one before it
    sw.lead_n = 1;
    pod_ui_supertab(&U, &sw, 4100);
    CHECK(!strcmp(top()->lead_id, "l0") && top()->lead == 0 && U.nav.depth == 2 && take() == 2);
    // the Lead's index moved (a Lead ahead of it arrived): the id still names it
    snprintf(sw.leads[0].id, ID_MAX, "new"); snprintf(sw.leads[1].id, ID_MAX, "l0"); sw.lead_n = 2;
    pod_ui_supertab(&U, &sw, 4200);
    CHECK(!strcmp(top()->lead_id, "l0") && top()->lead == 1 && take() == 0);
    // none left: Home, and the desktop is told the recap closed
    sw.lead_n = 0; sw.count = 0;
    pod_ui_supertab(&U, &sw, 4300);
    CHECK(U.nav.depth == 1 && take() == 1 && is_q(0, "supertab.open", "sw1", ""));
    // the Swarm itself goes
    swarm_home(4);
    tap_lead(0, 3000);
    take();
    static const char ids[1][ID_MAX] = {"sw2"};
    pod_ui_supertab_ids(&U, ids, 1);
    CHECK(U.nav.depth == 1 && take() == 1 && is_q(0, "supertab.open", "sw1", ""));
}
static void lead_relink(void) {
    swarm_home(4);
    tap_lead(1, 3000);
    take();
    pod_ui_link(&U, false);   // the model drops the list; the view stays and nothing is sent to a dead cable
    CHECK(top()->view == POD_V_LEAD && U.nav.depth == 2 && take() == 0 && !pod_ui_pet_on_screen(&U));
    render(3500);
    pod_ui_link(&U, true);
    CHECK(top()->view == POD_V_LEAD && take() == 0);   // linked, but the daemon has not sent the list yet: wait
    static const char ids[2][ID_MAX] = {"sw1", "sw2"};
    pod_ui_supertab_ids(&U, ids, 2);
    CHECK(top()->view == POD_V_LEAD && take() == 0);   // the Swarm is listed, not received
    static pod_swarm_t sw;
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "s1"); snprintf(sw.name, sizeof sw.name, "openharness"); sw.count = 4; sw.lead_n = 4;
    for (int i = 0; i < 4; i++) { snprintf(sw.leads[i].id, ID_MAX, "l%d", i); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj%d", i); snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); }
    pod_ui_supertab(&U, &sw, 4000);
    CHECK(top()->view == POD_V_LEAD && !strcmp(top()->lead_id, "l1") && take() == 2 && is_q(0, "supertab.open", "sw1", "l1") && is_q(1, "supertab.recap.get", "sw1", "l1"));
    CHECK(U.model.swarms[0].leads[1].recap == POD_RECAP_LOADING);
    // after the list comes back without that Swarm the view goes
    pod_ui_link(&U, false);
    pod_ui_link(&U, true);
    static const char one[1][ID_MAX] = {"sw2"};
    pod_ui_supertab_ids(&U, one, 1);
    CHECK(U.nav.depth == 1 && take() == 0);   // nothing was open as far as the new link knows
}
static void swarm_card_shrinks(void) {
    swarm_home(4);
    swipe(600, 430, 200, 440, 3000);
    CHECK(U.nav.swarm_page == 1);
    static const char sw_ids[1][ID_MAX] = {"sw2"};
    pod_model_supertab_ids(&U.model, sw_ids, 1);   // sw1 is gone: the page list changes under the person
    pod_nav_sync(&U.nav, &U.model);
    CHECK(U.nav.swarm_page == 0 && pod_tabs_pages_of(&U.nav, &U.model) == 3);   // Build and Docs are plain tab cards again, Solo the last
    CHECK(top()->scroll == 0);
    render(6000);
    CHECK(!find(POD_A_LEAD) && find(POD_A_ENTER_TAB));
}

// A side the person picked is owed to the daemon as supertab.side {tab, side}; it takes a queue slot like the other frames.
static void side_frame_queued(void) {
    swarm_home(4);
    take();
    CHECK(pod_ui_supertab_side(&U, "S1", POD_SIDE_BUDDY));
    CHECK(pod_ui_supertab_side(&U, "S1", POD_SIDE_PM));
    CHECK(!pod_ui_supertab_side(&U, "S1", POD_SIDE_NONE));
    const int n = take();
    CHECK(n == 2 && !strcmp(Q[0].t, "supertab.side") && !strcmp(Q[0].tab, "S1") && !strcmp(Q[0].side, "buddy") && !strcmp(Q[1].side, "pm"));
    for (int i = 0; i < POD_SUPERTAB_OUT_MAX; i++) CHECK(pod_ui_supertab_side(&U, "S1", POD_SIDE_PM));
    CHECK(!pod_ui_supertab_side(&U, "S1", POD_SIDE_PM));   // full: not sent
    take();
}


// ---- PM | Buddy: the pill on the Lead view (a hit, never a talk), the Buddy's quiet dot ----
static pod_swarm_t *buddy_swarm(void) { return (pod_swarm_t *)pod_model_swarm(&U.model, "sw1"); }
static void buddy_lead_open(void) {   // sw1's Lead l1 open (its harness a1, talkable), with a Buddy side
    swarm_home(4);
    pod_swarm_t *sw = buddy_swarm();
    snprintf(sw->leads[1].local, ID_MAX, "a1");
    for (int i = 0; i < 4; i++) { sw->leads[i].buddies = true; sw->leads[i].has_buddy = true; snprintf(sw->leads[i].buddy.chat_id, ID_MAX, "bc%d", i); snprintf(sw->leads[i].buddy.name, sizeof sw->leads[i].buddy.name, "Mira"); }
    sw->side = POD_SIDE_PM;
    tap_lead(1, 3000);
    CHECK(top()->view == POD_V_LEAD && top()->lead == 1);
    take();
    render(3300);
}
static void pill_tap_sends_side(void) {
    buddy_lead_open();
    CHECK(hit_count_of(POD_A_SIDE) == 2);
    pod_out_t o = tap_(435, 38, 4000);   // the Buddy segment
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_LEAD);
    CHECK(take() == 1 && !strcmp(Q[0].t, "supertab.side") && !strcmp(Q[0].tab, "sw1") && !strcmp(Q[0].side, "buddy"));
    render(4500);
    o = tap_(285, 38, 5000);   // PM
    CHECK(o.fx == POD_FX_NONE && take() == 1 && !strcmp(Q[0].t, "supertab.side") && !strcmp(Q[0].side, "pm"));
}
static void pill_tap_never_talks(void) {
    buddy_lead_open();
    t_(true, 435, 38, 4000);
    CHECK(!U.talk_armed);
    pod_out_t o = t_(false, 435, 38, 4050);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_LEAD && !U.hands_free);
    take();
    render(4200);
    t_(true, MID_X, MID_Y, 5000);   // an armed talk on the body ...
    CHECK(U.talk_armed);
    t_(true, 435, 38, 5100);   // ... is dropped when the finger leaves for the pill
    CHECK(!U.talk_armed);
    o = t_(false, 435, 38, 5150);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_LEAD && !U.hands_free);
    // and the body still talks
    take();
    o = tap_(MID_X, MID_Y, 6000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1"));
}
// ---- Talk to a remote Lead and to the Buddy (swarm.remote): voice.begin carries the Lead's id, the talk view signs the Buddy ----
static int talk_bars(void) { int n = 0; for (int i = 0; i < S.count; i++) n += S.runs[i].pro_kind == 4 && S.runs[i].w == 9 && S.runs[i].fg == ht_rgb(0x00FF2F); return n; }
static bool talk_text(const char *t, unsigned rgb) {
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == 1 && !strcmp(S.runs[i].text, t) && (!rgb || S.runs[i].fg == ht_rgb(rgb))) return true;
    return false;
}
static void remote_lead_talks_with_swarm_remote(void) {
    swarm_home(4);
    pod_ui_set_swarm_remote(&U, true);
    tap_lead(2, 3000);   // l2 has no local harness
    take();
    render(3300);
    CHECK(!top()->agent[0]);
    pod_out_t o = tap_(MID_X, MID_Y, 4000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "l2") && top()->view == POD_V_TALK && pod_ui_talking(&U));
    render(4500);
    CHECK(talk_text("Lead", 0));   // no roster agent, but the voice view still draws: the Lead's name, as its who row
    o = tap_(MID_X, MID_Y, 5000);
    CHECK(o.fx == POD_FX_VOICE_END && top()->view == POD_V_TALK);
    // swarm_talk_ends_on_transcript: words for a Swarm face go to its chat, not a terminal turn: the daemon's
    // transcript ends the voice screen at once (pro_app_voice_result), as on the round, instead of 30 s of "sending"
    CHECK(pod_ui_talking_to_swarm(&U));
    pod_ui_talk_over(&U);
    CHECK(top()->view == POD_V_LEAD && !pod_ui_talking_to_swarm(&U));
    // the link going down takes the feature with it
    pod_ui_link(&U, false);
    CHECK(!U.swarm_remote);
}
static void remote_lead_no_talk_without_feature(void) {
    swarm_home(4);
    tap_lead(2, 3000);
    take();
    render(3300);
    CHECK(tap_(MID_X, MID_Y, 4000).fx == POD_FX_NONE && top()->view == POD_V_LEAD && !U.talk_armed);
    pod_ui_set_swarm_remote(&U, true);
    pod_ui_set_swarm_remote(&U, false);
    CHECK(tap_(MID_X, MID_Y, 5000).fx == POD_FX_NONE && top()->view == POD_V_LEAD);
}
static void buddy_screen_talks_with_lead_id(void) {
    buddy_lead_open();   // l1: local a1
    buddy_swarm()->leads[1].chat = POD_CHAT_BUDDY;
    buddy_swarm()->leads[2].chat = POD_CHAT_BUDDY;
    render(3500);
    pod_out_t o = tap_(MID_X, MID_Y, 4000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1"));   // the same id as the PM side: the daemon picks the Buddy chat from the side it holds
    CHECK(pod_ui_talking_to_swarm(&U));   // a local Lead's face too: the Buddy's chat, never a1's terminal turn
    pod_ui_talk_over(&U);
    buddy_swarm()->leads[1].chat = POD_CHAT_PM;
    render(4500);
    o = tap_(MID_X, MID_Y, 5000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1"));
    pod_ui_talk_over(&U);
    // a remote Lead on its Buddy side: its own id
    pod_ui_set_swarm_remote(&U, true);
    pod_nav_act(&U.nav, &U.model, POD_A_NEXT, 0, 6000);
    take();
    CHECK(top()->lead == 2);
    render(6500);
    o = tap_(MID_X, MID_Y, 7000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "l2"));
}
static void buddy_talk_uses_buddy_engine_pet(void) {
    buddy_lead_open();   // the Lead is claude (a pet); give the Buddy an engine without one
    pod_lead_t *l = &buddy_swarm()->leads[1];
    snprintf(l->engine, sizeof l->engine, "claude");
    snprintf(l->buddy.engine, sizeof l->buddy.engine, "cursor");
    l->chat = POD_CHAT_PM;
    render(3500);
    CHECK(tap_(MID_X, MID_Y, 4000).fx == POD_FX_VOICE_BEGIN);
    render(4500);
    CHECK(talk_bars() == 0);   // the Lead's own pet
    pod_ui_talk_over(&U);
    l->chat = POD_CHAT_BUDDY;
    render(5000);
    CHECK(tap_(MID_X, MID_Y, 5500).fx == POD_FX_VOICE_BEGIN);
    render(6500);
    CHECK(talk_bars() == 7);   // the Buddy's engine has no pet: the round's effect
    CHECK(pod_view_next_ms(&U.nav, &U.model, 6500) == 80 - 6500 % 80);
}
static void buddy_talk_names_buddy(void) {
    buddy_lead_open();
    pod_lead_t *l = &buddy_swarm()->leads[1];
    l->chat = POD_CHAT_BUDDY;
    render(3500);
    CHECK(tap_(MID_X, MID_Y, 4000).fx == POD_FX_VOICE_BEGIN);
    render(4500);
    CHECK(talk_text("Mira", 0xC49BFF) && !talk_text("Alpha", 0));
    pod_ui_talk_over(&U);
    l->chat = POD_CHAT_PM;
    render(5000);
    CHECK(tap_(MID_X, MID_Y, 5500).fx == POD_FX_VOICE_BEGIN);
    render(6500);
    CHECK(talk_text("Alpha", PH_ROOM_INK) && !talk_text("Mira", 0));   // the PM side: the agent, as today
}
static void talk_name_pinned_at_begin(void) {
    buddy_lead_open();
    pod_lead_t *l = &buddy_swarm()->leads[1];
    l->chat = POD_CHAT_BUDDY;
    render(3500);
    CHECK(tap_(MID_X, MID_Y, 4000).fx == POD_FX_VOICE_BEGIN);
    l->chat = POD_CHAT_PM;   // a desktop side flip mid-recording: the daemon posts to the face it pinned at voice.begin
    render(4500);
    CHECK(talk_text("Mira", 0xC49BFF) && !talk_text("Alpha", 0) && !talk_text("Lead", 0));
    pod_ui_talk_over(&U);
    render(5000);
    CHECK(tap_(MID_X, MID_Y, 5500).fx == POD_FX_VOICE_BEGIN);   // PM side now: the next talk pins the agent
    l->chat = POD_CHAT_BUDDY;
    render(6500);
    CHECK(talk_text("Alpha", PH_ROOM_INK) && !talk_text("Mira", 0));
}
static void local_lead_not_in_roster_talks_with_local(void) {
    swarm_home(4);
    snprintf(buddy_swarm()->leads[2].local, ID_MAX, "zz");   // a harness the Pro's agent list does not hold
    pod_ui_set_swarm_remote(&U, true);
    tap_lead(2, 3000);
    take();
    render(3300);
    pod_out_t o = tap_(MID_X, MID_Y, 4000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "zz"));   // the round's rule: `local` whenever set, so the daemon pins the face
    render(4500);
    CHECK(talk_text("Lead", 0));
    pod_ui_talk_over(&U);
    pod_ui_set_swarm_remote(&U, false);   // and without swarm.remote it still talks with its local id
    render(5000);
    CHECK(tap_(MID_X, MID_Y, 5500).fx == POD_FX_VOICE_BEGIN);
}
static void buddy_talk_not_blocked_by_question(void) {
    buddy_lead_open();   // l1: local a1
    pod_model_question(&U.model, "a1", "Proceed?");   // the terminal's question: words for a Swarm face go to its chat
    CHECK(pod_model_eff(&U.model, pod_model_find(&U.model, "a1")) == POD_ASKING);
    buddy_swarm()->leads[1].chat = POD_CHAT_BUDDY;
    render(3500);
    CHECK(tap_(MID_X, MID_Y, 4000).fx == POD_FX_VOICE_BEGIN);
    pod_ui_talk_over(&U);
    buddy_swarm()->leads[1].chat = POD_CHAT_PM;
    render(4500);
    CHECK(tap_(MID_X, MID_Y, 5000).fx == POD_FX_VOICE_BEGIN);
}
static void pill_pressed_until_frame(void) {
    buddy_lead_open();
    tap_(435, 38, 4000);
    CHECK(U.model.side_press == POD_SIDE_BUDDY && !strcmp(U.model.side_press_swarm, "sw1") && buddy_swarm()->side == POD_SIDE_PM);   // pending, the daemon has not answered
    take();
    render(4200);
    { bool buddy_on = false; for (int i = 0; i < S.count; i++) buddy_on |= S.runs[i].x == 360 && S.runs[i].y == 16 && S.runs[i].w == 150; CHECK(buddy_on); }
    static pod_swarm_t fr;   // another Swarm's frame does not end it, this Swarm's does
    memset(&fr, 0, sizeof fr);
    snprintf(fr.id, ID_MAX, "sw2"); snprintf(fr.name, sizeof fr.name, "Solo"); fr.count = 1; fr.lead_n = 1;
    snprintf(fr.leads[0].id, ID_MAX, "s0"); snprintf(fr.leads[0].project, sizeof fr.leads[0].project, "ops"); snprintf(fr.leads[0].engine, sizeof fr.leads[0].engine, "claude");
    pod_ui_supertab(&U, &fr, 4300);
    CHECK(U.model.side_press == POD_SIDE_BUDDY);
    memset(&fr, 0, sizeof fr);
    snprintf(fr.id, ID_MAX, "sw1"); snprintf(fr.tab, ID_MAX, "s1"); snprintf(fr.name, sizeof fr.name, "openharness"); fr.count = 4; fr.lead_n = 4; fr.side = POD_SIDE_BUDDY;
    for (int i = 0; i < 4; i++) { snprintf(fr.leads[i].id, ID_MAX, "l%d", i); snprintf(fr.leads[i].project, sizeof fr.leads[i].project, "proj%d", i); snprintf(fr.leads[i].engine, sizeof fr.leads[i].engine, "claude"); fr.leads[i].buddies = true; }
    pod_ui_supertab(&U, &fr, 4400);
    CHECK(U.model.side_press == POD_SIDE_NONE && buddy_swarm()->side == POD_SIDE_BUDDY);
}
static void buddy_notice_sets_dot_only(void) {
    buddy_lead_open();
    swipe(200, 400, 600, 410, 3500);   // l0: a notice for l1's Buddy is for another screen, where a chat's notice would toast
    take();
    render(3700);
    CHECK(top()->lead == 0);
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l1", "buddy", "bc1", "Hello from your Buddy.", true, 4000));
    CHECK(U.model.unread_count == 0 && !U.ban_on && buddy_swarm()->leads[1].buddy_unread && !buddy_swarm()->leads[0].buddy_unread);
    render(4100);
    CHECK(!U.frame.banner);
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l9", "buddy", "bc1", "x", true, 4200));   // an unknown Lead: nothing
    // the same Buddy chat on screen and the glass lit: seen, no dot
    swipe(600, 400, 200, 410, 4300);
    CHECK(top()->lead == 1);
    buddy_swarm()->leads[1].buddy_unread = false;
    buddy_swarm()->leads[1].chat = POD_CHAT_BUDDY;
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l1", "buddy", "bc1", "Seen.", true, 4600) && !buddy_swarm()->leads[1].buddy_unread && U.model.unread_count == 0);
}
static void opening_buddy_clears_dot(void) {
    buddy_lead_open();
    buddy_swarm()->leads[1].buddy_unread = true;
    buddy_swarm()->leads[2].buddy_unread = true;   // another Lead's dot is its own
    render(3400);
    tap_(435, 38, 4000);
    CHECK(!buddy_swarm()->leads[1].buddy_unread && buddy_swarm()->leads[2].buddy_unread);
    take();
    // the daemon's read of the Buddy chat clears it too (a lost tap frame never leaves it)
    pod_ui_swarm_notice_read(&U, "sw1", "l2", "bc2");
    CHECK(!buddy_swarm()->leads[2].buddy_unread);
    buddy_swarm()->leads[2].buddy_unread = true;
    pod_ui_swarm_notice_read(&U, "sw1", "l2", "other");
    CHECK(buddy_swarm()->leads[2].buddy_unread);
    // a tap on PM keeps it
    tap_(285, 38, 6000);
    CHECK(buddy_swarm()->leads[2].buddy_unread);
}
static void relink_clears_buddy_dot(void) {
    buddy_lead_open();
    buddy_swarm()->leads[1].buddy_unread = true;
    tap_(285, 38, 4000);   // a pending side
    pod_ui_link(&U, false);
    CHECK(U.model.side_press == POD_SIDE_NONE);
    pod_ui_link(&U, true);
    static const char ids[2][ID_MAX] = {"sw1", "sw2"};
    pod_ui_supertab_ids(&U, ids, 2);
    static pod_swarm_t sw;
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "s1"); snprintf(sw.name, sizeof sw.name, "openharness"); sw.count = 4; sw.lead_n = 4; sw.side = POD_SIDE_BUDDY;
    for (int i = 0; i < 4; i++) { snprintf(sw.leads[i].id, ID_MAX, "l%d", i); snprintf(sw.leads[i].project, sizeof sw.leads[i].project, "proj%d", i); snprintf(sw.leads[i].engine, sizeof sw.leads[i].engine, "claude"); sw.leads[i].buddies = true; }
    pod_ui_supertab(&U, &sw, 5000);
    for (int i = 0; i < 4; i++) CHECK(!buddy_swarm()->leads[i].buddy_unread);
    CHECK(buddy_swarm()->side == POD_SIDE_BUDDY);   // the side comes from the daemon's frame
}
static void side_kept_across_swipe(void) {
    buddy_lead_open();
    buddy_swarm()->side = POD_SIDE_BUDDY;
    swipe(600, 400, 200, 410, 4000);   // NEXT: l2
    CHECK(top()->lead == 2 && buddy_swarm()->side == POD_SIDE_BUDDY && U.model.side_press == POD_SIDE_NONE);
    for (int i = 0, n = take(); i < n; i++) CHECK(strcmp(Q[i].t, "supertab.side"));   // nothing is said about the side
    render(4300);
    { bool buddy_on = false; for (int i = 0; i < S.count; i++) buddy_on |= S.runs[i].x == 360 && S.runs[i].y == 16 && S.runs[i].w == 150; CHECK(buddy_on); }
}

// The "No Buddy here yet" screen is not a chat: a tap on it talks to nobody (the words would land in the Lead's shared chat).
static void nobuddy_screen_never_talks(void) {
    pod_out_t o;
    buddy_lead_open();
    buddy_swarm()->leads[1].has_buddy = false;
    buddy_swarm()->side = POD_SIDE_BUDDY;
    render(3400);
    take();
    t_(true, MID_X, MID_Y, 6000);
    CHECK(!U.talk_armed);
    o = t_(false, MID_X, MID_Y, 6050);
    CHECK(o.fx != POD_FX_VOICE_BEGIN && !U.talk_armed && !pod_ui_talking(&U));
    buddy_swarm()->side = POD_SIDE_PM;   // and with the PM side up it talks again
    take();
    o = tap_(MID_X, MID_Y, 7000);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1"));
}
// A tapped segment that no frame answers goes back to the Swarm's own side after POD_SUPERTAB_RETRY_MS, and the view wakes to draw it.
static void pressed_side_expires(void) {
    buddy_lead_open();
    tap_(435, 38, 4000);   // the press is taken at 4050
    take();
    CHECK(pod_model_side_shown(&U.model, buddy_swarm()) == POD_SIDE_BUDDY);
    render(4100);
    CHECK(ph_lead_next_ms(&U.nav, &U.model, 4100) <= 2950);   // wakes at the expiry
    pod_model_clock(&U.model, 4050 + 2999);
    CHECK(pod_model_side_shown(&U.model, buddy_swarm()) == POD_SIDE_BUDDY);
    pod_model_clock(&U.model, 4050 + 3001);
    CHECK(pod_model_side_shown(&U.model, buddy_swarm()) == POD_SIDE_PM);
}
static void pressed_side_cleared_when_send_fails(void) {
    buddy_lead_open();
    tap_(435, 38, 4000);
    take();
    CHECK(U.model.side_press == POD_SIDE_BUDDY);
    pod_ui_side_unsent(&U, "sw2");   // another Swarm's frame
    CHECK(U.model.side_press == POD_SIDE_BUDDY);
    pod_ui_side_unsent(&U, "sw1");
    CHECK(U.model.side_press == POD_SIDE_NONE && pod_model_side_shown(&U.model, buddy_swarm()) == POD_SIDE_PM);
}
// The dot also goes whenever the Buddy chat is on the face of a lit screen (a notice that came while another Lead was shown).
static void buddy_dot_clears_when_buddy_face_shown(void) {
    buddy_lead_open();
    buddy_swarm()->leads[2].chat = POD_CHAT_BUDDY;
    CHECK(!pod_ui_swarm_notice(&U, "sw1", "l2", "buddy", "bc2", "Hi.", true, 3500) && buddy_swarm()->leads[2].buddy_unread);
    tap_(435, 38, 4000);   // Buddy on l1
    take();
    swipe(600, 400, 200, 410, 5000);
    CHECK(top()->lead == 2);
    render(5300);
    tap_(285, 38, 6000);   // PM
    CHECK(!buddy_swarm()->leads[2].buddy_unread);
}

int main(void) {
    notify_while_looking();
    swarm_card_pages();
    swarm_card_few_leads();
    swarm_card_tap();
    side_frame_queued();
    pill_tap_sends_side();
    pill_tap_never_talks();
    remote_lead_talks_with_swarm_remote();
    remote_lead_no_talk_without_feature();
    buddy_screen_talks_with_lead_id();
    buddy_talk_uses_buddy_engine_pet();
    buddy_talk_names_buddy();
    talk_name_pinned_at_begin();
    local_lead_not_in_roster_talks_with_local();
    buddy_talk_not_blocked_by_question();
    pill_pressed_until_frame();
    buddy_notice_sets_dot_only();
    opening_buddy_clears_dot();
    relink_clears_buddy_dot();
    side_kept_across_swipe();
    nobuddy_screen_never_talks();
    pressed_side_expires();
    pressed_side_cleared_when_send_fails();
    buddy_dot_clears_when_buddy_face_shown();
    notice_opens_lead();
    swarm_notice_toasts_and_beeps();
    swarm_notice_on_its_lead_view_reads_at_once();
    notice_for_other_chat_on_lead_view_files_row();
    notice_for_face_chat_on_lead_view_clears_old_row();
    chat_switch_asks_recap_at_once();
    notif_replace_keeps_swarm_notices();
    swarm_toast_tap_opens_lead_and_selects();
    swarm_row_tap_opens_lead_and_selects();
    swarm_notice_read_ends_toast();
    lead_tap_sends();
    lead_retry();
    lead_swipe_steps();
    lead_leave_closes();
    lead_scrolls();
    lead_talk();
    lead_focus();
    empty_focus_opens_last_lead();
    empty_focus_opens_first_without_history();
    empty_focus_last_lead_gone_opens_first();
    empty_focus_unknown_swarm_waits_then_drops();
    empty_focus_respects_quiet_window();
    lead_removed();
    lead_relink();
    swarm_card_shrinks();
    overview_pages();
    bottom_up_goes_back();
    swipe_up_home();
    down_from_top_notices();
    down_mid_is_nothing();
    recap_and_agent_host_scroll();
    recap_has_no_tap_and_reads();
    room_agent_gone_lands_home();
    no_toast_on_home_pets();
    toast_shows_and_expires();
    toast_tap_opens_notices();
    toast_swipe_up_dismisses();
    supertab_toast_stays();
    toast_not_here();
    home_notices_pages();
    home_notices_come_and_go();
    home_swipe_up_lands_on_room_tab();
    home_pages_one_swipe_each();
    selected_tab_follows();
    start_enters_first_tab();
    start_then_focus();
    start_after_relink();
    start_never_yanks();
    start_waits_for_agents();
    room_sideways_wraps();
    home_pages();
    bottom_start_sideways_is_a_pane_swipe();
    bar_down_opens_inbox();
    toast_and_edges();
    tap_agent();
    drag_is_not_a_tap();
    drift_cancels();
    bar_swipe();
    no_talk_views();
    offline();
    tap_talks_on_its_lift();
    cancel_keeps_recording();
    hands_free_taps_anywhere();
    send_before_talk_drawn();
    offline_tap_aborts();
    working_bars_wake();
    animation_rates();
    overview_down_opens_inbox();
    inbox_swipe_goes_back();
    home_page();
    recent_swipe_steps_tabs();
    overview_scroll_follows_tab_removal();
    talk_not_in_bar();
    talk_ignores_bar_swipe();
    toast_cap_only_when_drawn();
    wake_rates();
    agent_screen_wakes();
    asking_agents_do_not_talk();
    talk_stays_with_its_target();
    refused_talk_stays_on_the_agent();
    working_card_swipes();
    working_card_shrinks();
    working_card_tap_and_back();
    printf("test_ph_glue: %d checks ok\n", checks);
    return 0;
}
