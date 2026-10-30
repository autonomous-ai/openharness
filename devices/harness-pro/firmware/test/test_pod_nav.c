// Host test for Pod navigation (main/pod/pod_nav.c). Models are built through the public feeds only.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/pod_nav.h"
#include "pod/pod_view.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

static pod_model_t M;
static pod_nav_t N;

static const pod_frame_t *top(void) { return &N.stack[N.depth - 1]; }
static pod_out_t act(pod_action_t a, int arg, uint32_t t) { return pod_nav_act(&N, &M, a, arg, t); }

// Tab 0 "Build": a1 a2 a3 (a3 done with a recap). Tab 1 "Docs": a4 only. a1 working, a2 idle, a4 asking.
// A whole turn: a done alone, with no turn before it, is not a task (pod_model_turn).
static void task(const char *id, uint32_t t) { pod_model_turn(&M, id, "started", NULL, 0, t - 1); pod_model_turn(&M, id, "done", NULL, 0, t); }

static void fresh(void) {
    pod_model_reset(&M);
    pod_model_agent(&M, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&M, "a2", "Beta", "codex", "mac");
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agent(&M, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&M);
    static const char *x[] = {"a1", "a2", "a3"}, *y[] = {"a4"};
    const char *const *ids[2] = {x, y};
    uint8_t cnt[2] = {3, 1};
    cable_swarm_t it[2] = {{"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&M, it, ids, cnt, 2, "s1", NULL, 0);
    pod_model_turn(&M, "a1", "started", NULL, 0, 10);
    task("a3", 20);
    pod_model_recap(&M, "a3", "It works. Tests pass. Shipped.", false);
    pod_model_question(&M, "a4", "Proceed?");
    pod_nav_init(&N);
}

// fresh() with nobody working: Home's pages are then the Notices card and the tabs only.
static void fresh_still(void) {
    fresh();
    pod_model_turn(&M, "a1", "done", NULL, 0, 11);
}

static void to_agent(int tab, int idx) {
    act(POD_A_OPEN_TAB, tab, 0);
    act(POD_A_OPEN_AGENT, idx, 0);
}

static void nav_test_open_by_state(void) {
    fresh();
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(N.depth == 2 && top()->view == POD_V_TAB && top()->tab == 0);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 3 && !strcmp(l[2]->id, "a3"));
    pod_out_t o = act(POD_A_OPEN_AGENT, 2, 0);   // done with a recap
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a3") && top()->view == POD_V_RECAP && N.depth == 3);
    act(POD_A_BACK, 0, 0);                       // a room's back is Home: the TAB frame is never drawn
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    act(POD_A_OPEN_TAB, 0, 0);
    o = act(POD_A_OPEN_AGENT, 0, 0);             // working
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a1") && top()->view == POD_V_AGENT);
    CHECK(!strcmp(top()->agent, "a1") && top()->tab == 0);
    act(POD_A_BACK, 0, 0);
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(act(POD_A_OPEN_AGENT, 9, 0).fx == POD_FX_NONE && N.depth == 2);
    act(POD_A_BACK, 0, 0);                       // a list pops one level
    CHECK(act(POD_A_OPEN_TAB, 7, 0).fx == POD_FX_NONE && N.depth == 1);
    act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);   // BACK on the root does nothing
}

static void nav_test_prev_next_wrap(void) {
    fresh();
    to_agent(0, 0);
    pod_out_t o = act(POD_A_PREV, 0, 0);          // wraps to a3, which opens on its recap
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a3") && top()->view == POD_V_RECAP && N.depth == 3);
    o = act(POD_A_NEXT, 0, 0);                    // wraps to a1
    CHECK(!strcmp(o.agent, "a1") && top()->view == POD_V_AGENT && top()->tab == 0);
    act(POD_A_NEXT, 0, 0);
    CHECK(!strcmp(top()->agent, "a2") && top()->view == POD_V_AGENT && N.depth == 3);
    // a single-agent tab wraps to itself
    act(POD_A_BACK, 0, 0); act(POD_A_BACK, 0, 0);
    to_agent(1, 0);
    act(POD_A_NEXT, 0, 0);
    CHECK(!strcmp(top()->agent, "a4") && N.depth == 3);
}

static void nav_test_talk_send(void) {
    fresh();
    to_agent(0, 0);
    pod_out_t o = act(POD_A_TALK, 0, 1234);
    CHECK(o.fx == POD_FX_VOICE_BEGIN && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK && N.talk_started_ms == 1234);
    o = act(POD_A_TALK, 0, 5000);
    CHECK(o.fx == POD_FX_VOICE_END && !strcmp(o.agent, "a1") && top()->view == POD_V_TALK && N.depth == 3 && N.sending);
    CHECK(N.send_started_ms == 5000 && !strcmp(N.sent_agent, "a1"));
    // a tap while sending is ignored: no second recording, nothing moves
    o = act(POD_A_TALK, 0, 5500);
    CHECK(o.fx == POD_FX_NONE && top()->view == POD_V_TALK && N.send_started_ms == 5000);
    // talk_over clears it and goes back
    pod_nav_talk_over(&N);
    CHECK(top()->view == POD_V_AGENT && !N.sending);
}

// Sending leaves TALK only on a real turn (not the optimistic sent), or after POD_SENT_WAIT_MS.
static void sending_to(const char *id, uint32_t at) {
    fresh();
    to_agent(0, 1);                               // a2 (idle)
    if (strcmp(id, "a2")) { act(POD_A_BACK, 0, 0); to_agent(0, 0); }   // a1 (working)
    act(POD_A_TALK, 0, at - 1000);
    act(POD_A_TALK, 0, at);
}
static void nav_test_send_release(void) {
    // idle agent: the optimistic Working keeps the voice screen; a real turn releases it to AGENT
    sending_to("a2", 5000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK && N.sending);
    pod_model_sent(&M, "a2", 5100);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK && N.sending);
    pod_model_clock(&M, 5000 + POD_SENT_WAIT_MS - 1);
    pod_nav_flip_recaps(&N, &M);
    CHECK(top()->view == POD_V_TALK);
    pod_model_turn(&M, "a2", "started", NULL, 0, 7000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT && !N.sending && N.depth == 3);
    // an agent already working: the old turn does not release; the send is marked, then the daemon speaks
    sending_to("a1", 20000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK);
    pod_model_sent(&M, "a1", 20100);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK);
    pod_model_turn(&M, "a1", "activity", "Reading", 3, 21000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT && !N.sending);
    // no turn: back after POD_SENT_WAIT_MS, to the screen TALK came from
    sending_to("a2", 50000);
    pod_model_sent(&M, "a2", 50100);
    pod_model_clock(&M, 50000 + POD_SENT_WAIT_MS);
    pod_nav_flip_recaps(&N, &M);
    CHECK(top()->view == POD_V_AGENT && !N.sending);
    // unsend and BACK clear it
    sending_to("a2", 90000);
    pod_nav_unsend(&N);
    CHECK(top()->view == POD_V_AGENT && !N.sending && N.sent_agent[0] == 0);
    sending_to("a2", 95000);
    CHECK(act(POD_A_BACK, 0, 95100).fx == POD_FX_VOICE_ABORT && !N.sending);
}

static void leave_case(pod_action_t a, int want_depth, const char *want_agent) {
    fresh();
    to_agent(0, 1);                               // a2
    CHECK(act(POD_A_TALK, 0, 100).fx == POD_FX_VOICE_BEGIN);
    pod_out_t o = act(a, 0, 200);
    CHECK(o.fx == POD_FX_VOICE_ABORT && !strcmp(o.agent, "a2"));
    CHECK(N.depth == want_depth);
    if (want_agent) CHECK(top()->view != POD_V_TALK && !strcmp(top()->agent, want_agent));
    // nothing more is emitted, and an END never comes after
    CHECK(act(POD_A_NONE, 0, 300).fx == POD_FX_NONE);
    CHECK(N.send_started_ms == 0 && N.sent_agent[0] == 0);
}

static void nav_test_leave_talk_aborts(void) {
    leave_case(POD_A_BACK, 1, NULL);              // a room's back is Home
    leave_case(POD_A_PANES, 1, NULL);
    leave_case(POD_A_TABS, 1, NULL);
    leave_case(POD_A_PREV, 3, "a1");
    leave_case(POD_A_NEXT, 3, "a3");
}

// TABS goes straight to the root from any agent screen (PANES to the tab's list); on a list or the root it does nothing.
static void nav_test_tabs_button(void) {
    fresh();
    to_agent(0, 1);                               // a2: AGENT, depth 3
    CHECK(act(POD_A_TABS, 0, 0).fx == POD_FX_NONE && N.depth == 1 && top()->view == POD_V_TABS);
    to_agent(0, 2);                               // a3 opens on its recap
    CHECK(top()->view == POD_V_RECAP);
    CHECK(act(POD_A_TABS, 0, 0).fx == POD_FX_NONE && N.depth == 1);
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(act(POD_A_PANES, 0, 0).fx == POD_FX_NONE && N.depth == 2 && top()->view == POD_V_TAB);   // a list: nothing
    CHECK(act(POD_A_TABS, 0, 0).fx == POD_FX_NONE && N.depth == 1);   // Home from any screen
    act(POD_A_BACK, 0, 0);
    CHECK(act(POD_A_TABS, 0, 0).fx == POD_FX_NONE && N.depth == 1);
}

static void nav_test_recap_toggle(void) {
    fresh();
    to_agent(0, 1);                               // a2 idle, no recap: AGENT
    CHECK(top()->view == POD_V_AGENT);
    act(POD_A_RECAP, 0, 0);
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_RECAP, 0, 0);
    CHECK(top()->view == POD_V_AGENT);
    act(POD_A_BACK, 0, 0);
    act(POD_A_OPEN_TAB, 0, 0);
    act(POD_A_OPEN_AGENT, 2, 0);                  // a3 opens on its recap: RECAP does nothing
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_RECAP, 0, 0);
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_PANES, 0, 0);
    CHECK(top()->view == POD_V_TABS && N.depth == 1);   // Home: the TAB frame is never shown
    to_agent(0, 1);
    // scroll clamps at 0
    act(POD_A_SCROLL, 50, 0); act(POD_A_SCROLL, -80, 0);
    CHECK(top()->scroll == 0);
    act(POD_A_SCROLL, 30, 0);
    CHECK(top()->scroll == 30);
}

static void nav_test_agent_vanishes(void) {
    fresh();
    to_agent(0, 1);                               // a2
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agent(&M, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&M);
    static const char *x[] = {"a1", "a2", "a3"}, *y[] = {"a4"};
    const char *const *ids[2] = {x, y};
    uint8_t cnt[2] = {3, 1};
    cable_swarm_t it[2] = {{"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&M, it, ids, cnt, 2, "s1", NULL, 0);
    CHECK(pod_model_find(&M, "a2") == NULL);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);   // Home: the TAB frame is never shown
    // the tab itself goes
    act(POD_A_BACK, 0, 0);
    to_agent(1, 0);                               // Docs: a4
    CHECK(N.depth == 3 && !strcmp(top()->agent, "a4") && top()->tab == 1);
    cable_swarm_t gone[1] = {{"s1", "Build", 3, 3}};
    const char *const *idsg[1] = {x};
    uint8_t cg[1] = {3};
    pod_model_swarms(&M, gone, idsg, cg, 1, "s1", NULL, 0);   // Docs is closed
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    cable_swarm_t one[1] = {{"s2", "Docs", 1, 1}};
    const char *const *ids1[1] = {y};
    uint8_t c1[1] = {1};
    pod_model_swarms(&M, one, ids1, c1, 1, "s2", NULL, 0);
    // a recording on a vanished agent reports its abort
    to_agent(0, 0);                               // a4 (Docs is tab 0 now)
    act(POD_A_TALK, 0, 1);
    pod_model_agents_begin(&M);
    pod_model_agents_end(&M);
    pod_out_t o = pod_nav_sync(&N, &M);
    CHECK(o.fx == POD_FX_VOICE_ABORT && !strcmp(o.agent, "a4"));
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    // a stable model changes nothing
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && N.depth == 1);
}

static void nav_test_recent_list(void) {
    fresh();
    pod_model_turn(&M, "a2", "started", NULL, 0, 30);   // a1, a2 working; a4 asking; a3 done at 20
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    CHECK(top()->view == POD_V_TAB && top()->tab == POD_TAB_RECENT);
    const pod_agent_t *w[POD_AGENTS_MAX];
    int n = pod_model_recent(&M, w, POD_RECENT_MAX);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(n == 4 && pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == n);
    for (int i = 0; i < n; i++) CHECK(l[i] == w[i]);
    CHECK(!strcmp(l[0]->id, "a2") && !strcmp(l[1]->id, "a3") && !strcmp(l[2]->id, "a4") && !strcmp(l[3]->id, "a1"));
    act(POD_A_OPEN_AGENT, 2, 100);                      // a4: opening is not a task, the order stays
    CHECK(!strcmp(top()->agent, "a4") && top()->tab == POD_TAB_RECENT);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4 && !strcmp(l[0]->id, "a2") && !strcmp(l[2]->id, "a4"));
    act(POD_A_PREV, 0, 101);                            // steps within the Recent list
    CHECK(!strcmp(top()->agent, "a3") && top()->tab == POD_TAB_RECENT);
    act(POD_A_NEXT, 0, 102);
    CHECK(!strcmp(top()->agent, "a4"));
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4 && !strcmp(l[0]->id, "a2"));
    // a4 stops asking: it stays open and in the list
    pod_model_question_close(&M, "a4");
    pod_model_turn(&M, "a4", "done", NULL, 0, 40);
    pod_nav_sync(&N, &M);
    CHECK(N.depth == 3 && !strcmp(top()->agent, "a4"));
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4);
}

static void nav_test_recent_agent_keeps_open_when_it_falls_off(void) {
    fresh();
    pod_model_turn(&M, "a1", "done", NULL, 0, 21);        // nobody busy: only recency ranks
    pod_model_question_close(&M, "a4");
    pod_model_turn(&M, "a4", "done", NULL, 0, 22);
    for (int i = 0; i < 10; i++) {
        char id[8]; snprintf(id, sizeof id, "x%d", i);
        pod_model_agent(&M, id, id, "claude", "mac");
        task(id, 1000 + 10u * (uint32_t)i);
    }
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == POD_RECENT_MAX);
    act(POD_A_OPEN_AGENT, 7, 2000);                     // the 8th, the oldest: opening does not move it
    char open_id[ID_MAX];
    snprintf(open_id, sizeof open_id, "%s", top()->agent);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == POD_RECENT_MAX && !strcmp(l[POD_RECENT_MAX - 1]->id, open_id));
    for (int i = 0; i < 10; i++) {                      // ten others get news: the open one falls off the 8
        char id[8]; snprintf(id, sizeof id, "x%d", i);
        if (strcmp(id, open_id)) task(id, 3000 + 10u * (uint32_t)i);
    }
    int n = pod_nav_list(&N, &M, l, POD_AGENTS_MAX);
    CHECK(n == POD_RECENT_MAX + 1 && !strcmp(l[n - 1]->id, open_id));
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && N.depth == 3);
}

static void nav_test_working_agent_finishes_stays(void) {
    fresh();                                      // a1 working, a4 asking, a3 done
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    act(POD_A_OPEN_AGENT, 2, 60);                 // a1 (a3, a4, a1 by recency; a2 has had no task)
    CHECK(!strcmp(top()->agent, "a1") && top()->view == POD_V_AGENT && N.depth == 3);
    pod_model_turn(&M, "a1", "done", NULL, 0, 70);
    pod_model_recap(&M, "a1", "Done it. All green.", false);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE);
    CHECK(N.depth == 3 && !strcmp(top()->agent, "a1") && top()->tab == POD_TAB_RECENT && top()->view == POD_V_RECAP);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 3 && !strcmp(l[0]->id, "a1"));
    // stepping works from where it sits
    act(POD_A_NEXT, 0, 80);
    CHECK(!strcmp(top()->agent, l[1]->id));
    // not while talking: the view stays TALK
    act(POD_A_BACK, 0, 0);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    act(POD_A_OPEN_AGENT, 2, 90);                 // a1, a3, a4: a4
    CHECK(!strcmp(top()->agent, "a4") && top()->view == POD_V_AGENT);
    act(POD_A_TALK, 0, 99);
    pod_model_question_close(&M, "a4");
    pod_model_turn(&M, "a4", "done", NULL, 0, 100);
    pod_model_recap(&M, "a4", "Answered.", false);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && top()->view == POD_V_TALK && N.depth == 3);
}

static void nav_test_working_agent_removed_pops(void) {
    fresh();
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    act(POD_A_OPEN_AGENT, 2, 0);                  // a1
    CHECK(!strcmp(top()->agent, "a1"));
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "a2", "Beta", "codex", "mac");
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agent(&M, "a4", "Delta", "claude", "box");
    pod_model_agents_end(&M);
    CHECK(pod_model_find(&M, "a1") == NULL);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);   // Home: the TAB frame is never shown
}

static void nav_test_depth_cap(void) {
    fresh();
    for (int i = 0; i < 50; i++) {
        act(POD_A_OPEN_TAB, 0, i);
        act(POD_A_OPEN_AGENT, 0, i);
        act(POD_A_OPEN_TAB, 0, i);
        act(POD_A_OPEN_AGENT, 1, i);
        act(i & 1 ? POD_A_NEXT : POD_A_PREV, 0, i);
        act(POD_A_TALK, 0, i);
        CHECK(N.depth <= 4);
    }
    CHECK(N.depth == 3);
    for (int i = 0; i < 10; i++) act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1);
}

// M9: a frame names its tab by id. A tab inserted before the open one moves its index; the frame follows.
static void nav_test_tab_identity(void) {
    fresh();
    act(POD_A_OPEN_TAB, 1, 0);                              // Docs
    CHECK(top()->tab == 1 && !strcmp(top()->tab_id, "s2"));
    act(POD_A_OPEN_AGENT, 0, 0);                            // a4 on Docs
    CHECK(N.depth == 3 && top()->tab == 1 && !strcmp(top()->tab_id, "s2"));
    static const char *x[] = {"a1", "a2", "a3"}, *y[] = {"a4"};
    const char *const *ids[3] = {NULL, x, y};
    uint8_t cnt[3] = {0, 3, 1};
    cable_swarm_t it[3] = {{"s0", "Inbox", 1, 1}, {"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
    pod_model_swarms(&M, it, ids, cnt, 3, "s1", NULL, 0);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE);
    CHECK(N.depth == 3 && N.stack[1].tab == 2 && top()->tab == 2);
    CHECK(!strcmp(M.tabs[top()->tab].name, "Docs"));
    // the tab is closed: its frames pop
    cable_swarm_t only[1] = {{"s1", "Build", 3, 3}};
    const char *const *ids1[1] = {x};
    uint8_t c1[1] = {3};
    pod_model_swarms(&M, only, ids1, c1, 1, "s1", NULL, 0);
    pod_nav_sync(&N, &M);
    CHECK(N.depth == 1);
}

// M10: a talk that ends without the person (refused start, link lost, the cap) goes back to the screen it came
// from, and never pops.
static void nav_test_talk_over_restores(void) {
    fresh();
    to_agent(0, 0);                                         // a1, working: Agent
    act(POD_A_TALK, 0, 5);
    CHECK(top()->view == POD_V_TALK && N.depth == 3);
    pod_nav_talk_over(&N);
    CHECK(top()->view == POD_V_AGENT && N.depth == 3 && !strcmp(top()->agent, "a1"));
    act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);       // Home: the TAB frame is never shown
    to_agent(0, 2);                                         // a3, done with a recap: Recap
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_TALK, 0, 6);
    CHECK(top()->view == POD_V_TALK);
    pod_nav_talk_over(&N);
    CHECK(top()->view == POD_V_RECAP && N.depth == 3);
    pod_nav_talk_over(&N);                                  // not talking: nothing
    CHECK(top()->view == POD_V_RECAP && N.depth == 3);
}

// After SEND the voice screen stays up until the agent's real turn starts; then it is the Agent screen even for a done
// agent with a recap, and its answer flips back to the Recap. With no turn in POD_SENT_WAIT_MS it returns to where TALK came from.
static void nav_test_send_stays_on_agent(void) {
    fresh();
    to_agent(0, 2);                                         // a3: done, recap
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_TALK, 0, 1000);
    act(POD_A_TALK, 0, 1000);                               // SEND
    CHECK(top()->view == POD_V_TALK && N.sending);
    pod_model_clock(&M, 1000 + POD_SENT_WAIT_MS - 1);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK);
    pod_model_turn(&M, "a3", "started", NULL, 0, 2000);     // the message was taken: it is working
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT && !N.sending);
    pod_model_turn(&M, "a3", "done", NULL, 0, 3000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP);                      // its answer is the recap now
    // no turn ever starts: after POD_SENT_WAIT_MS it goes back to the Recap it came from
    act(POD_A_TALK, 0, 5000);
    act(POD_A_TALK, 0, 5000);
    CHECK(top()->view == POD_V_TALK);
    pod_model_clock(&M, 5000 + POD_SENT_WAIT_MS - 1);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK);
    pod_model_clock(&M, 5000 + POD_SENT_WAIT_MS);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP && !N.sending);
}

// An agent open on its Recap that starts working (or asking) shows its Agent screen: no effect, same depth. Not under TALK,
// and not for a Recap the person chose on an agent that was already working.
static void nav_test_recap_flips_to_agent_when_work_starts(void) {
    fresh();
    to_agent(0, 2);                                         // a3: done, recap
    CHECK(top()->view == POD_V_RECAP && N.depth == 3);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && top()->view == POD_V_RECAP);   // nothing changed: stays
    pod_model_turn(&M, "a3", "started", NULL, 0, 2000);
    pod_out_t o = pod_nav_sync(&N, &M);
    CHECK(o.fx == POD_FX_NONE && N.depth == 3 && top()->view == POD_V_AGENT && !strcmp(top()->agent, "a3"));
    pod_model_turn(&M, "a3", "done", NULL, 0, 3000);        // finishes: back to its recap (existing flip)
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP);
    // asking counts too
    pod_model_question(&M, "a3", "Proceed?");
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && top()->view == POD_V_AGENT && N.depth == 3);

    // the clock alone (no feed) never starts work, but a render-time flip call sees a feed made since the last sync
    fresh();
    to_agent(0, 2);
    pod_nav_flip_recaps(&N, &M);
    pod_model_turn(&M, "a3", "started", NULL, 0, 2000);
    pod_nav_flip_recaps(&N, &M);
    CHECK(top()->view == POD_V_AGENT);

    // not while TALK: the view stays TALK, and the edge still fires when the talk is over
    fresh();
    to_agent(0, 2);
    pod_nav_sync(&N, &M);
    act(POD_A_TALK, 0, 1000);
    CHECK(top()->view == POD_V_TALK);
    pod_model_turn(&M, "a3", "started", NULL, 0, 2000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_TALK && N.depth == 3);
    pod_nav_talk_over(&N);
    CHECK(top()->view == POD_V_RECAP);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT);

    // a Recap chosen on an agent that was already working stays (no edge)
    fresh();
    to_agent(0, 0);                                         // a1 working, no recap yet: AGENT
    pod_nav_sync(&N, &M);
    act(POD_A_RECAP, 0, 0);
    CHECK(top()->view == POD_V_RECAP);
    pod_nav_sync(&N, &M);
    pod_model_turn(&M, "a1", "activity", "Reading", 3, 50);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP);

    // another agent's work does not move this view
    fresh();
    to_agent(0, 2);
    pod_nav_sync(&N, &M);
    pod_model_turn(&M, "a2", "started", NULL, 0, 2000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP);
}

// M12: the Recent list uses the effective state: a real turn stays working however quiet; a send whose turn never came
// stops counting as working after POD_SENT_WAIT_MS.
static void nav_test_stale_leaves_working(void) {
    fresh();
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 3);    // the three with tasks; a1 working, a4 asking
    pod_model_clock(&M, 10 + 900000);
    CHECK(pod_model_eff(&M, pod_model_find(&M, "a1")) == POD_WORKING);
    pod_model_sent(&M, "a2", 10 + 900000);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4 && pod_model_eff(&M, pod_model_find(&M, "a2")) == POD_WORKING);
    pod_model_clock(&M, 10 + 900000 + POD_SENT_WAIT_MS + 1);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4);
    CHECK(pod_model_eff(&M, pod_model_find(&M, "a2")) == POD_IDLE && pod_model_eff(&M, pod_model_find(&M, "a4")) == POD_ASKING);
}

// The Tabs grid scrolls by rows in the root frame: SCROLL adds (never below 0), a model change or sync leaves it, and the
// root frame holds no tab (the chosen cover is the model's selected tab).
static void nav_test_grid_scroll(void) {
    fresh_still();
    act(POD_A_SCROLL, 1, 0);
    CHECK(top()->scroll == 1 && N.depth == 1 && top()->tab_id[0] == 0);
    act(POD_A_SCROLL, -5, 0);
    CHECK(top()->scroll == -2);                   // the Notices card (a4 asks)
    act(POD_A_SCROLL, 3, 0);
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == 1 && top()->view == POD_V_TABS && N.depth == 1);   // clamped to the last tab
    act(POD_A_OPEN_TAB, 0, 0);                    // opening a tab leaves the root's offset where it was
    act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1 && top()->scroll == 1);
}

static void nav_test_follow(void) {
    fresh();
    // Other tab: a4 is only in "Docs" (tab 1); a4 is asking -> Agent. No effect, the stack is replaced.
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(pod_nav_follow(&N, &M, "a4", 100));
    CHECK(N.depth == 3 && N.stack[0].view == POD_V_TABS && N.stack[1].view == POD_V_TAB);
    CHECK(N.stack[1].tab == 1 && !strcmp(N.stack[1].tab_id, "s2"));
    CHECK(top()->view == POD_V_AGENT && !strcmp(top()->agent, "a4") && top()->tab == 1);
    CHECK(!M.agents[3].has_act || M.agents[3].act_ms != 100);   // following is not a task: Recent does not move
    // Done with a recap -> Recap; selected tab holds it.
    CHECK(pod_nav_follow(&N, &M, "a3", 200));
    CHECK(N.depth == 3 && N.stack[1].tab == 0 && top()->view == POD_V_RECAP && !strcmp(top()->agent, "a3"));
    // The same agent again: no-op.
    N.stack[2].scroll = 5;
    CHECK(!pod_nav_follow(&N, &M, "a3", 300) && N.stack[2].scroll == 5);
    // Unknown agent: nothing.
    CHECK(!pod_nav_follow(&N, &M, "zz", 300) && N.depth == 3 && !strcmp(top()->agent, "a3"));
    // Working agent opens on Agent.
    CHECK(pod_nav_follow(&N, &M, "a1", 400) && top()->view == POD_V_AGENT && N.stack[1].tab == 0);
    // TALK on top: ignored.
    act(POD_A_TALK, 0, 500);
    CHECK(top()->view == POD_V_TALK);
    CHECK(!pod_nav_follow(&N, &M, "a4", 600) && top()->view == POD_V_TALK && !strcmp(top()->agent, "a1"));
    pod_nav_talk_over(&N);
    // In two tabs: the window's selected tab wins; otherwise the first that holds it.
    static const char *x[] = {"a1", "a2", "a3"}, *y[] = {"a4", "a3"};
    const char *const *ids[2] = {x, y};
    uint8_t cnt[2] = {3, 2};
    cable_swarm_t it[2] = {{"s1", "Build", 3, 3}, {"s2", "Docs", 2, 2}};
    pod_model_swarms(&M, it, ids, cnt, 2, "s2", NULL, 0);
    pod_nav_sync(&N, &M);
    CHECK(pod_nav_follow(&N, &M, "a3", 700) && N.stack[1].tab == 1 && !strcmp(N.stack[1].tab_id, "s2"));
    pod_model_swarms(&M, it, ids, cnt, 2, "s1", NULL, 0);
    pod_nav_init(&N);
    CHECK(pod_nav_follow(&N, &M, "a3", 800) && N.stack[1].tab == 0);
    // Not in any tab: Recent.
    pod_model_agent(&M, "a9", "Zeta", "claude", "mac");
    pod_model_agents_end(&M);
    pod_model_swarms(&M, it, ids, cnt, 2, "s1", NULL, 0);
    CHECK(pod_nav_follow(&N, &M, "a9", 900));
    CHECK(N.depth == 3 && N.stack[1].tab == POD_TAB_RECENT && !N.stack[1].tab_id[0] && !strcmp(top()->agent, "a9"));
    const pod_agent_t *l[POD_AGENTS_MAX];
    int n = pod_nav_list(&N, &M, l, POD_AGENTS_MAX);   // held at the end while open, but following is not a task
    CHECK(n >= 1 && !strcmp(l[n - 1]->id, "a9"));
    n = pod_model_recent(&M, l, POD_RECENT_MAX);
    for (int i = 0; i < n; i++) CHECK(strcmp(l[i]->id, "a9") != 0);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && N.depth == 3);
}

static void nav_test_follow_scrolls_row_into_sight(void) {
    pod_model_reset(&M);
    static char names[12][4];
    static const char *ids[12];
    for (int i = 0; i < 12; i++) { snprintf(names[i], sizeof names[i], "b%d", i); ids[i] = names[i]; pod_model_agent(&M, ids[i], ids[i], "claude", "mac"); }
    pod_model_agents_end(&M);
    const char *const *all[1] = {ids};
    uint8_t cnt[1] = {12};
    cable_swarm_t it[1] = {{"s1", "Big", 12, 12}};
    pod_model_swarms(&M, it, all, cnt, 1, "s1", NULL, 0);
    pod_nav_init(&N);
    CHECK(pod_nav_follow(&N, &M, "b10", 5));
    CHECK(N.stack[1].scroll == 7 && N.stack[1].scroll <= 12 - 7 + 2);   // row 10, view clamps to 5..11
    pod_nav_init(&N);
    CHECK(pod_nav_follow(&N, &M, "b1", 5) && N.stack[1].scroll == 0);
}

static void nav_test_inbox(void) {
    fresh();
    // Open from Tabs; from a TAB too; BACK pops; a second open does nothing; TALK refuses it.
    CHECK(act(POD_A_INBOX, 0, 0).fx == POD_FX_NONE && N.depth == 2 && top()->view == POD_V_INBOX && top()->tab == POD_TAB_RECENT);
    act(POD_A_INBOX, 0, 0);
    CHECK(N.depth == 2);
    act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    to_agent(0, 0);
    act(POD_A_TALK, 0, 5);
    act(POD_A_INBOX, 0, 6);
    CHECK(top()->view == POD_V_TALK && N.depth == 3);
    act(POD_A_TABS, 0, 7);
    CHECK(N.depth == 1);
    to_agent(0, 2);                                   // an agent screen: the Inbox goes over it
    act(POD_A_INBOX, 0, 8);
    CHECK(N.depth == 4 && top()->view == POD_V_INBOX);
    act(POD_A_BACK, 0, 9);
    CHECK(N.depth == 3 && top()->view == POD_V_RECAP && !strcmp(top()->agent, "a3"));

    // Opening a row: that agent over the Inbox, AGENT_OPEN, the entry read (a token one queued for the host).
    fresh();
    pod_model_unread_append(&M, "a3", "Gamma", "tok3", "It works.", 100);
    pod_model_unread_append(&M, "a1", "Alpha", "", "more", 100);
    pod_model_unread_append(&M, "gone", "Ghost", "tokg", "not on the roster", 100);
    act(POD_A_INBOX, 0, 100);
    CHECK(act(POD_A_OPEN_NOTIF, 7, 100).fx == POD_FX_NONE && M.unread_count == 3);        // out of range
    pod_out_t o = act(POD_A_OPEN_NOTIF, 0, 100);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a3") && N.depth == 3 && top()->view == POD_V_RECAP);
    CHECK(top()->tab == 0 && M.unread_count == 2 && !pod_model_unread_find(&M, "a3"));   // the room is the agent's own tab (Build)
    pod_read_out_t r[4];
    CHECK(pod_model_take_reads(&M, r, 4) == 1 && !strcmp(r[0].agent, "a3") && !strcmp(r[0].token, "tok3"));
    act(POD_A_BACK, 0, 101);
    CHECK(N.depth == 2 && top()->view == POD_V_INBOX);
    o = act(POD_A_OPEN_NOTIF, 0, 102);                      // a1 is working: its Agent screen
    CHECK(o.fx == POD_FX_AGENT_OPEN && top()->view == POD_V_AGENT && !strcmp(top()->agent, "a1") && M.read_count == 0);
    act(POD_A_BACK, 0, 103);
    int gone = -1;
    for (int i = 0; i < M.unread_count; i++) if (!strcmp(M.unread[i].agent, "gone")) gone = i;
    o = act(POD_A_OPEN_NOTIF, gone, 104);                   // not on the roster: read, nothing opens
    CHECK(o.fx == POD_FX_NONE && N.depth == 2 && M.unread_count == 1 && pod_model_take_reads(&M, r, 4) == 1);   // a1's entry waits: its Agent screen has no recap

    // From an agent screen the Inbox is the 4th frame; opening a row there keeps the stack within its cap.
    fresh();
    pod_model_unread_append(&M, "a2", "Beta", "t2", "hi", 1);
    to_agent(0, 0);
    act(POD_A_INBOX, 0, 1);
    CHECK(N.depth == 4);
    o = act(POD_A_OPEN_NOTIF, 0, 2);
    CHECK(o.fx == POD_FX_AGENT_OPEN && N.depth == 3 && N.stack[1].view == POD_V_INBOX && top()->view == POD_V_RECAP && !strcmp(top()->agent, "a2"));   // an entry is told by the recap
    pod_model_unread_append(&M, "a4", "Delta", "t4", "q", 3);
    pod_model_turn(&M, "a2", "started", NULL, 0, 4);
    pod_model_turn(&M, "a4", "started", NULL, 0, 4);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) >= 2);
    pod_nav_sync(&N, &M);
    CHECK(N.depth == 3 && N.stack[1].view == POD_V_INBOX);   // sync keeps the Inbox frame

    // Opening an agent whose recap shows marks it read, and so does a follow; an Agent screen has no recap, so it reads nothing.
    fresh();
    pod_model_unread_append(&M, "a1", "Alpha", "t1", "x", 1);
    pod_model_unread_append(&M, "a3", "Gamma", "t3", "y", 1);
    act(POD_A_OPEN_TAB, 0, 2);
    act(POD_A_OPEN_AGENT, 0, 2);                            // a1 works: its Agent screen
    CHECK(pod_model_unread_find(&M, "a1") && pod_model_unread_find(&M, "a3") && M.read_count == 0);
    act(POD_A_BACK, 0, 2);
    act(POD_A_OPEN_TAB, 0, 2);
    act(POD_A_OPEN_AGENT, 2, 2);                            // a3 is done: its recap is on screen
    CHECK(pod_model_unread_find(&M, "a1") && !pod_model_unread_find(&M, "a3") && M.read_count == 1);
    pod_nav_init(&N);
    pod_model_unread_append(&M, "a3", "Gamma", "t3", "z", 3);
    CHECK(pod_nav_follow(&N, &M, "a3", 3) && !pod_model_unread_find(&M, "a3") && M.read_count == 2);
}

static void nav_test_back_and_steps(void) {   // (the Pets attention chip is gone: Pets has no bar)
    fresh();
    // BACK with arg
    fresh();
    to_agent(0, 0);
    act(POD_A_BACK, 2, 0);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    to_agent(0, 0);
    act(POD_A_BACK, 1, 0);
    CHECK(N.depth == 1);                           // a room's back is Home
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(N.depth == 2);
    act(POD_A_BACK, 5, 0);                         // clamps at the root
    CHECK(N.depth == 1);

    // PREV/NEXT on a TAB frame do nothing: no TAB frame is drawn, so it never cycles tabs (and never reaches Recent)
    fresh();
    act(POD_A_OPEN_TAB, 0, 0);
    act(POD_A_NEXT, 0, 0);
    CHECK(top()->view == POD_V_TAB && top()->tab == 0);
    act(POD_A_NEXT, 0, 0);
    act(POD_A_PREV, 0, 0);
    CHECK(top()->view == POD_V_TAB && top()->tab == 0 && N.depth == 2);
    fresh();   // Recent does not step
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    act(POD_A_NEXT, 0, 0);
    CHECK(top()->tab == POD_TAB_RECENT);

    // FOLLOW (arg: index into model->agents): the Inbox rows without an unread entry
    fresh();
    act(POD_A_INBOX, 0, 0);
    pod_out_t o = act(POD_A_FOLLOW, pod_model_find(&M, "a4") - M.agents, 0);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a4") && top()->view == POD_V_AGENT && !strcmp(top()->agent, "a4"));
    CHECK(act(POD_A_FOLLOW, 99, 0).fx == POD_FX_NONE);
}

static void test_origin_label(void) {
    fresh();
    CHECK(!strcmp(pod_nav_origin(&N, &M), "Back"));   // the root
    to_agent(0, 0);
    CHECK(!strcmp(pod_nav_origin(&N, &M), "Build"));
    act(POD_A_TABS, 0, 0);
    to_agent(1, 0);
    CHECK(!strcmp(pod_nav_origin(&N, &M), "Docs"));
    act(POD_A_TABS, 0, 0);
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    CHECK(!strcmp(pod_nav_origin(&N, &M), "Tabs"));   // the Recent list itself came from Tabs (its view shows "Back")
    act(POD_A_OPEN_AGENT, 0, 0);
    CHECK(top()->view != POD_V_TAB && !strcmp(pod_nav_origin(&N, &M), "Recent"));
    act(POD_A_TABS, 0, 0);
    act(POD_A_INBOX, 0, 0);
    CHECK(!strcmp(pod_nav_origin(&N, &M), "Tabs"));   // the Inbox view itself shows "Back"
    pod_model_unread_add(&M, "a3", "Gamma", "Shipped.", 5, 100);
    act(POD_A_OPEN_NOTIF, 0, 0);
    CHECK(top()->view == POD_V_RECAP || top()->view == POD_V_AGENT);
    CHECK(!strcmp(pod_nav_origin(&N, &M), "Inbox"));
}

// ---- Pets: the recap (a RECAP frame has its recap on screen: opening it reads the unread entry) -----------------------------
static void pets_fresh_with_unread(void) {
    fresh();
    pod_model_unread_add(&M, "a3", "Gamma", "It works.", 20, 21);
}

static void nav_test_pets_recap_open_reads(void) {
    pets_fresh_with_unread();
    to_agent(0, 2);   // a3 opens on its Recap, which is on screen at once: read
    CHECK(top()->view == POD_V_RECAP && M.unread_count == 0);
    // PREV / NEXT onto it
    pets_fresh_with_unread();
    to_agent(0, 0);
    CHECK(M.unread_count == 1);
    for (int i = 0; i < 3 && M.unread_count; i++) act(POD_A_NEXT, 0, 30 + i);
    CHECK(top()->view == POD_V_RECAP && !strcmp(top()->agent, "a3") && M.unread_count == 0);
    // follow / focus
    pets_fresh_with_unread();
    pod_nav_follow(&N, &M, "a3", 32);
    CHECK(top()->view == POD_V_RECAP && M.unread_count == 0);
    // Notices: a tap opens the agent on its recap
    pets_fresh_with_unread();
    act(POD_A_INBOX, 0, 40);
    pod_out_t o = act(POD_A_OPEN_NOTIF, 0, 41);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(top()->agent, "a3") && top()->view == POD_V_RECAP);
    CHECK(M.unread_count == 0 && N.depth == 3 && N.stack[1].view == POD_V_INBOX);
    // an Agent frame flipping to its Recap (the agent finished under it) reads it
    pets_fresh_with_unread();
    to_agent(0, 2);
    pod_model_unread_add(&M, "a3", "Gamma", "More.", 20, 25);
    N.stack[N.depth - 1].view = POD_V_AGENT;
    pod_nav_flip_recaps(&N, &M);
    CHECK(top()->view == POD_V_RECAP && M.unread_count == 0);
}

static void nav_test_pets_room_does_not_read(void) {
    fresh();
    pod_model_unread_add(&M, "a1", "Alpha", "Note.", 20, 21);   // an entry for an agent that opens on a room (no recap)
    to_agent(0, 0);
    CHECK(top()->view == POD_V_AGENT && M.unread_count == 1);
}

static void nav_test_recap_flips_to_agent_on_work(void) {
    pets_fresh_with_unread();
    to_agent(0, 2);
    pod_nav_flip_recaps(&N, &M);
    CHECK(top()->view == POD_V_RECAP);
    pod_model_turn(&M, "a3", "started", NULL, 0, 40);
    pod_nav_flip_recaps(&N, &M);
    CHECK(top()->view == POD_V_AGENT);
}

// Pets: a room opened from Notices is the agent's own tab, so sideways swipes stay among its tab-mates (not the whole Recent list).
static void nav_test_pets_notice_room_keeps_tab(void) {
    pets_fresh_with_unread();
    act(POD_A_INBOX, 0, 5);
    act(POD_A_OPEN_NOTIF, 0, 6);
    CHECK(!strcmp(top()->agent, "a3") && top()->tab == 0 && !strcmp(top()->tab_id, "s1"));
    for (int k = 0; k < 6; k++) {
        act(POD_A_NEXT, 0, 7 + k);
        CHECK(strcmp(top()->agent, "a4") != 0 && top()->tab == 0);   // a4 lives in the other tab
    }
    for (int k = 0; k < 6; k++) {
        act(POD_A_PREV, 0, 20 + k);
        CHECK(strcmp(top()->agent, "a4") != 0 && top()->tab == 0);
    }
}

// The side button (BACK) from a room goes Home, not to the TAB frame Pets never draws; from a room over Notices it goes back to Notices.
static void nav_test_pets_back_from_room(void) {
    fresh();
    act(POD_A_ENTER_TAB, 0, 0);
    CHECK(N.depth == 3);
    act(POD_A_BACK, 0, 1);
    CHECK(N.depth == 1 && top()->view == POD_V_TABS);
    act(POD_A_ENTER_TAB, 0, 2);
    act(POD_A_TALK, 0, 3);
    CHECK(top()->view == POD_V_TALK);
    CHECK(act(POD_A_BACK, 0, 4).fx == POD_FX_VOICE_ABORT && N.depth == 1);
    pets_fresh_with_unread();
    act(POD_A_INBOX, 0, 5);
    act(POD_A_OPEN_NOTIF, 0, 6);
    CHECK(N.depth == 3);
    act(POD_A_BACK, 0, 7);
    CHECK(N.depth == 2 && top()->view == POD_V_INBOX);
    act(POD_A_BACK, 0, 8);
    CHECK(N.depth == 1);
}

static void nav_test_enter_tab_pushes(void) {   // Pets Home: ENTER_TAB opens a tab on its first agent, TAB frame below
    fresh();
    pod_out_t o = act(POD_A_ENTER_TAB, 0, 0);
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a1") && N.depth == 3);
    CHECK(N.stack[1].view == POD_V_TAB && N.stack[1].tab == 0 && !strcmp(N.stack[1].tab_id, "s1"));
    CHECK(top()->view == POD_V_AGENT && !strcmp(top()->agent, "a1") && top()->tab == 0);
    act(POD_A_TABS, 0, 0);
    o = act(POD_A_ENTER_TAB, 1, 0);   // Docs: a4 asks
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a4") && N.depth == 3 && N.stack[1].tab == 1);
}
static void nav_test_enter_tab_empty_noop(void) {
    fresh();
    CHECK(act(POD_A_ENTER_TAB, 5, 0).fx == POD_FX_NONE && N.depth == 1);    // unknown tab
    CHECK(act(POD_A_ENTER_TAB, -1, 0).fx == POD_FX_NONE && N.depth == 1);
    static const char *none[] = {"zz"};                                      // a tab whose agents are not on the roster
    const char *const *ids[1] = {none};
    uint8_t cnt[1] = {1};
    cable_swarm_t it[1] = {{"s9", "Ghost", 1, 1}};
    pod_model_swarms(&M, it, ids, cnt, 1, "s9", NULL, 0);
    CHECK(act(POD_A_ENTER_TAB, 0, 0).fx == POD_FX_NONE && N.depth == 1);
}
static void nav_test_enter_tab_not_from_room(void) {
    fresh();
    to_agent(0, 0);
    CHECK(N.depth == 3);
    CHECK(act(POD_A_ENTER_TAB, 1, 0).fx == POD_FX_NONE && N.depth == 3 && !strcmp(top()->agent, "a1"));
    act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1);   // Pets: home
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(act(POD_A_ENTER_TAB, 1, 0).fx == POD_FX_NONE && N.depth == 2);
}


// ---- Pets Home's Notices card: the TABS frame's scroll is the tab index, -2 the Notices card (only while there are notices) ----
static void nav_test_home_notices_scroll(void) {
    fresh_still();   // a4 asks: one notice
    CHECK(pod_notice_count(&M) == 1 && pod_tabs_pages_of(&N, &M) == 3);   // two tabs and the Notices card
    act(POD_A_SCROLL, -2, 0);
    CHECK(top()->scroll == -2);
    act(POD_A_SCROLL, -2, 0);
    CHECK(top()->scroll == -2);   // the card is the first page
    act(POD_A_SCROLL, 3, 0);
    CHECK(top()->scroll == 1);
    // the notices go: Home never rests on a page that does not exist
    act(POD_A_SCROLL, -3, 0);
    CHECK(top()->scroll == -2);
    pod_model_question_close(&M, "a4");
    pod_model_turn(&M, "a4", "done", NULL, 0, 12);   // it went back to work: finish it, so no Working card
    CHECK(pod_notice_count(&M) == 0 && pod_tabs_pages_of(&N, &M) == 2);
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == 0);   // the Notices card went: tab 0
    act(POD_A_SCROLL, -2, 0);
    CHECK(top()->scroll == 0);   // and there is no card to scroll to
    // a notice arriving does not move the person: the tab they are on stays
    act(POD_A_SCROLL, 1, 0);
    CHECK(top()->scroll == 1);
    pod_model_unread_add(&M, "a3", "Gamma", "It works.", 20, 21);
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == 1 && pod_tabs_pages_of(&N, &M) == 3);
    // tabs going away clamp to the last
    act(POD_A_SCROLL, 5, 0);
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[1] = {x};
    uint8_t cnt[1] = {3};
    cable_swarm_t it[1] = {{"s1", "Build", 3, 3}};
    pod_model_swarms(&M, it, ids, cnt, 1, "s1", NULL, 0);
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == 0);
    // no tabs, a notice: the Notices card alone
    pod_model_swarms(&M, NULL, NULL, NULL, 0, "", NULL, 0);
    act(POD_A_SCROLL, -2, 0);
    pod_nav_sync(&N, &M);
    CHECK(pod_tabs_pages_of(&N, &M) == 1 && top()->scroll == -2);
    // a Pets TAB frame (never drawn) keeps the ordinary clamp
    fresh_still();
    act(POD_A_OPEN_TAB, 0, 0);
    act(POD_A_SCROLL, -2, 0);
    CHECK(top()->scroll == 0);
}

// Leaving a room for Home lands on that room's tab card, never on the Notices card (or whichever page the person left Home on).
static void nav_test_home_lands_on_room_tab(void) {
    fresh_still();
    act(POD_A_SCROLL, -2, 0);   // Home on the Notices card
    to_agent(1, 0);             // a room of tab "Docs" (a4, asks) opened another way (a focus, a notice)
    CHECK(N.depth == 3 && N.stack[0].scroll == -2);
    act(POD_A_TABS, 0, 1);      // swipe up from the bottom zone
    CHECK(N.depth == 1 && top()->scroll == 1);
    act(POD_A_SCROLL, -3, 0);
    to_agent(0, 0);
    act(POD_A_BACK, 0, 2);      // the side button
    CHECK(N.depth == 1 && top()->scroll == 0);
    act(POD_A_SCROLL, -2, 0);
    to_agent(1, 0);
    act(POD_A_TALK, 0, 3);
    act(POD_A_BACK, 0, 4);      // abort the recording
    CHECK(N.depth == 1 && top()->scroll == 1);
    // from the Recent list there is no tab card: the first tab, not the Notices card
    act(POD_A_SCROLL, -3, 0);
    act(POD_A_INBOX, 0, 5);
    CHECK(top()->view == POD_V_INBOX);
    act(POD_A_FOLLOW, 0, 6);
    act(POD_A_TABS, 0, 7);
    CHECK(N.depth == 1 && top()->scroll >= 0);
}

// ---- Home's page list: Notices (-2) while there are notices, Working (-1) while an agent works, then the tabs ----
static const char *pages(void) {
    static char b[96];
    int16_t p[POD_TABS_MAX + 2];
    int n = pod_home_pages(&M, p, POD_TABS_MAX + 2), k = 0;
    b[k++] = '{';
    for (int i = 0; i < n; i++) k += snprintf(b + k, sizeof b - k, "%s%d", i ? "," : "", p[i]);
    b[k++] = '}'; b[k] = 0;
    return b;
}
static void nav_test_home_pages(void) {
    fresh();   // a1 works, a4 asks
    CHECK(pod_home_working(&M) == 1 && !strcmp(pages(), "{-2,-1,0,1}") && pod_tabs_pages_of(&N, &M) == 4);
    pod_model_question_close(&M, "a4");   // a4 goes back to work
    CHECK(!strcmp(pages(), "{-1,0,1}"));
    pod_model_turn(&M, "a1", "done", NULL, 0, 30);
    pod_model_turn(&M, "a4", "done", NULL, 0, 31);
    CHECK(pod_home_working(&M) == 0 && !strcmp(pages(), "{0,1}"));
    pod_model_question(&M, "a4", "Proceed?");
    CHECK(!strcmp(pages(), "{-2,0,1}"));
    pod_model_swarms(&M, NULL, NULL, NULL, 0, "", NULL, 0);   // no tabs
    CHECK(!strcmp(pages(), "{-2}"));
    pod_model_turn(&M, "a1", "started", NULL, 0, 40);
    CHECK(!strcmp(pages(), "{-2,-1}"));
    pod_model_question_close(&M, "a4");
    pod_model_turn(&M, "a1", "done", NULL, 0, 50);
    pod_model_turn(&M, "a4", "done", NULL, 0, 51);
    CHECK(!strcmp(pages(), "{}") && pod_tabs_pages_of(&N, &M) == 0);
}
static void nav_test_home_clamp(void) {
    fresh();   // {-2,-1,0,1}
    N.stack[0].scroll = -1;   // Working vanishes while shown: tab 0, the page to its right
    pod_model_turn(&M, "a1", "done", NULL, 0, 30);
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == 0);
    pod_model_turn(&M, "a1", "started", NULL, 0, 40);   // Notices vanishes while shown: Working, the page to its right
    N.stack[0].scroll = -2;
    pod_model_question_close(&M, "a4");
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == -1);
    pod_model_swarms(&M, NULL, NULL, NULL, 0, "", NULL, 0);   // nothing to the right: the nearest to the left
    pod_model_question(&M, "a4", "Proceed?");
    N.stack[0].scroll = 5;
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == -1);
    N.stack[0].scroll = -2;   // a present page is kept
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == -2);
}

// A room opened from the Working card sits at depth 2: the Inbox still opens at the full stack, and the room follows the app's tab like any other.
static void nav_test_working_card_room(void) {
    fresh();   // a1 works
    N.stack[0].scroll = POD_HOME_WORKING;
    CHECK(act(POD_A_FOLLOW, pod_model_find(&M, "a1") - M.agents, 0).fx == POD_FX_AGENT_OPEN && N.depth == 2);
    pod_model_unread_add(&M, "a3", "Gamma", "It works.", 20, 21);
    act(POD_A_INBOX, 0, 1);
    CHECK(N.depth == 3 && top()->view == POD_V_INBOX);
    act(POD_A_OPEN_NOTIF, 0, 2);   // TABS, AGENT, INBOX, room: full
    CHECK(N.depth == 4 && top()->view != POD_V_INBOX);
    act(POD_A_INBOX, 0, 3);
    CHECK(N.depth == 2 && top()->view == POD_V_INBOX && N.stack[0].scroll == POD_HOME_WORKING);
    act(POD_A_BACK, 0, 4);
    CHECK(N.depth == 1 && N.stack[0].scroll == POD_HOME_WORKING);
    fresh();
    N.stack[0].scroll = POD_HOME_WORKING;
    act(POD_A_FOLLOW, pod_model_find(&M, "a1") - M.agents, 0);
    M.selected = 1;   // the app moved to Docs, which does not hold a1: the room follows to Docs' first agent
    CHECK(pod_nav_follow_tab(&N, &M) && N.depth == 3 && !strcmp(top()->agent, "a4") && N.stack[0].scroll == 1);
}

int main(void) {
    nav_test_home_notices_scroll();
    nav_test_home_pages();
    nav_test_home_clamp();
    nav_test_working_card_room();
    nav_test_home_lands_on_room_tab();
    nav_test_enter_tab_pushes();
    nav_test_enter_tab_empty_noop();
    nav_test_enter_tab_not_from_room();
    test_origin_label();
    nav_test_grid_scroll();
    nav_test_open_by_state();
    nav_test_prev_next_wrap();
    nav_test_talk_send();
    nav_test_send_release();
    nav_test_leave_talk_aborts();
    nav_test_tabs_button();
    nav_test_recap_toggle();
    nav_test_agent_vanishes();
    nav_test_recent_list();
    nav_test_recent_agent_keeps_open_when_it_falls_off();
    nav_test_working_agent_finishes_stays();
    nav_test_working_agent_removed_pops();
    nav_test_depth_cap();
    nav_test_tab_identity();
    nav_test_talk_over_restores();
    nav_test_send_stays_on_agent();
    nav_test_recap_flips_to_agent_when_work_starts();
    nav_test_stale_leaves_working();
    nav_test_follow();
    nav_test_follow_scrolls_row_into_sight();
    nav_test_inbox();
    nav_test_back_and_steps();
    nav_test_pets_recap_open_reads();
    nav_test_pets_room_does_not_read();
    nav_test_recap_flips_to_agent_on_work();
    nav_test_pets_back_from_room();
    nav_test_pets_notice_room_keeps_tab();
    printf("Pod nav: PASS (%d checks)\n", checks);
    return 0;
}
