// Host test for Pod navigation (main/ui/habitat/pod/pod_nav.c). Models are built through the public feeds only.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/pod_nav.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

static pod_model_t M;
static pod_nav_t N;

static const pod_frame_t *top(void) { return &N.stack[N.depth - 1]; }
static pod_out_t act(pod_action_t a, int arg, uint32_t t) { return pod_nav_act(&N, &M, a, arg, t); }

// Tab 0 "Build": a1 a2 a3 (a3 done with a recap). Tab 1 "Docs": a4 only. a1 working, a2 idle, a4 asking.
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
    pod_model_turn(&M, "a3", "done", NULL, 0, 20);
    pod_model_recap(&M, "a3", "It works. Tests pass. Shipped.", false);
    pod_model_question(&M, "a4", "Proceed?");
    pod_nav_init(&N);
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
    act(POD_A_BACK, 0, 0);
    o = act(POD_A_OPEN_AGENT, 0, 0);             // working
    CHECK(o.fx == POD_FX_AGENT_OPEN && !strcmp(o.agent, "a1") && top()->view == POD_V_AGENT);
    CHECK(!strcmp(top()->agent, "a1") && top()->tab == 0);
    act(POD_A_BACK, 0, 0);
    CHECK(act(POD_A_OPEN_AGENT, 9, 0).fx == POD_FX_NONE && N.depth == 2);
    act(POD_A_BACK, 0, 0);
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
    CHECK(o.fx == POD_FX_VOICE_END && !strcmp(o.agent, "a1") && top()->view == POD_V_AGENT && N.depth == 3);
    CHECK(N.send_started_ms == 5000 && !strcmp(N.sent_agent, "a1"));
    // from a recap too
    act(POD_A_PREV, 0, 0);
    CHECK(top()->view == POD_V_RECAP);
    CHECK(act(POD_A_TALK, 0, 6000).fx == POD_FX_VOICE_BEGIN && top()->view == POD_V_TALK);
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
    leave_case(POD_A_BACK, 2, NULL);
    leave_case(POD_A_PANES, 2, NULL);
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
    CHECK(act(POD_A_TABS, 0, 0).fx == POD_FX_NONE && N.depth == 2 && top()->view == POD_V_TAB);   // a list: nothing
    CHECK(act(POD_A_PANES, 0, 0).fx == POD_FX_NONE && N.depth == 2);
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
    act(POD_A_OPEN_AGENT, 2, 0);                  // a3 opens on its recap: RECAP does nothing
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_RECAP, 0, 0);
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_PANES, 0, 0);
    CHECK(top()->view == POD_V_TAB && N.depth == 2);
    act(POD_A_OPEN_AGENT, 1, 0);
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
    CHECK(N.depth == 2 && top()->view == POD_V_TAB && top()->tab == 0);
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
    CHECK(N.depth == 2 && top()->view == POD_V_TAB);
    // a stable model changes nothing
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && N.depth == 2);
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
    act(POD_A_OPEN_AGENT, 2, 100);                      // a4: opening bumps it to the top
    CHECK(!strcmp(top()->agent, "a4") && top()->tab == POD_TAB_RECENT);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4 && !strcmp(l[0]->id, "a4") && !strcmp(l[1]->id, "a2"));
    act(POD_A_PREV, 0, 101);                            // wraps within the Recent list, and does not reorder it
    CHECK(!strcmp(top()->agent, "a1") && top()->tab == POD_TAB_RECENT);
    act(POD_A_NEXT, 0, 102);
    CHECK(!strcmp(top()->agent, "a4"));
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4 && !strcmp(l[0]->id, "a4"));
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
        pod_model_turn(&M, id, "done", NULL, 0, 1000 + 10u * (uint32_t)i);
    }
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == POD_RECENT_MAX);
    act(POD_A_OPEN_AGENT, 7, 2000);                     // the 8th: opening makes it the newest
    char open_id[ID_MAX];
    snprintf(open_id, sizeof open_id, "%s", top()->agent);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == POD_RECENT_MAX && !strcmp(l[0]->id, open_id));
    for (int i = 0; i < 10; i++) {                      // ten others get news: the open one falls off the 8
        char id[8]; snprintf(id, sizeof id, "x%d", i);
        if (strcmp(id, open_id)) pod_model_turn(&M, id, "done", NULL, 0, 3000 + 10u * (uint32_t)i);
    }
    int n = pod_nav_list(&N, &M, l, POD_AGENTS_MAX);
    CHECK(n == POD_RECENT_MAX + 1 && !strcmp(l[n - 1]->id, open_id));
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE && N.depth == 3);
}

static void nav_test_working_agent_finishes_stays(void) {
    fresh();                                      // a1 working, a4 asking, a3 done
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    act(POD_A_OPEN_AGENT, 2, 60);                 // a1 (a3, a4, a1, a2 by recency)
    CHECK(!strcmp(top()->agent, "a1") && top()->view == POD_V_AGENT && N.depth == 3);
    pod_model_turn(&M, "a1", "done", NULL, 0, 70);
    pod_model_recap(&M, "a1", "Done it. All green.", false);
    CHECK(pod_nav_sync(&N, &M).fx == POD_FX_NONE);
    CHECK(N.depth == 3 && !strcmp(top()->agent, "a1") && top()->tab == POD_TAB_RECENT && top()->view == POD_V_RECAP);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4 && !strcmp(l[0]->id, "a1"));
    // stepping works from where it sits
    act(POD_A_NEXT, 0, 80);
    CHECK(!strcmp(top()->agent, l[1]->id));
    // not while talking: the view stays TALK
    act(POD_A_BACK, 0, 0);
    act(POD_A_OPEN_AGENT, 2, 90);                 // a1, a3, a4, a2: a4
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
    CHECK(N.depth == 2 && top()->view == POD_V_TAB && top()->tab == POD_TAB_RECENT);
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
    cable_swarm_t it[3] = {{"s0", "Inbox", 0, 0}, {"s1", "Build", 3, 3}, {"s2", "Docs", 1, 1}};
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
    // a Working-list frame has no tab id and survives a reorder
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    pod_model_swarms(&M, it, ids, cnt, 3, "s1", NULL, 0);
    pod_nav_sync(&N, &M);
    CHECK(N.depth == 2 && top()->tab == POD_TAB_RECENT);
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
    CHECK(N.depth == 2 && top()->view == POD_V_TAB);
    act(POD_A_BACK, 0, 0);
    to_agent(0, 2);                                         // a3, done with a recap: Recap
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_TALK, 0, 6);
    CHECK(top()->view == POD_V_TALK);
    pod_nav_talk_over(&N);
    CHECK(top()->view == POD_V_RECAP && N.depth == 3);
    pod_nav_talk_over(&N);                                  // not talking: nothing
    CHECK(top()->view == POD_V_RECAP && N.depth == 3);
}

// M5: after SEND the view stays Agent ("then the agent is working, on the Agent screen") until the agent's next
// turn starts or 15 s pass, even though a done agent with a recap would otherwise flip to Recap.
static void nav_test_send_stays_on_agent(void) {
    fresh();
    to_agent(0, 2);                                         // a3: done, recap
    CHECK(top()->view == POD_V_RECAP);
    act(POD_A_TALK, 0, 1000);
    act(POD_A_TALK, 0, 1000);                               // SEND
    CHECK(top()->view == POD_V_AGENT);
    pod_model_clock(&M, 1000 + 14999);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT);
    pod_model_turn(&M, "a3", "started", NULL, 0, 2000);     // the message was taken: it is working
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT);
    pod_model_turn(&M, "a3", "done", NULL, 0, 3000);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP);                      // its answer is the recap now
    // no turn ever starts: after 15 s it flips
    act(POD_A_TALK, 0, 5000);
    act(POD_A_TALK, 0, 5000);
    CHECK(top()->view == POD_V_AGENT);
    pod_model_clock(&M, 5000 + 14999);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_AGENT);
    pod_model_clock(&M, 5000 + 15001);
    pod_nav_sync(&N, &M);
    CHECK(top()->view == POD_V_RECAP);
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

// M12: the Recent list uses the effective state: an agent whose turn.done was missed stops counting as working after 25 s.
static void nav_test_stale_leaves_working(void) {
    fresh();
    act(POD_A_OPEN_TAB, POD_TAB_RECENT, 0);
    const pod_agent_t *l[POD_AGENTS_MAX];
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4);    // every agent; a1 working, a4 asking
    CHECK(pod_model_eff(&M, pod_model_find(&M, "a1")) == POD_WORKING);
    pod_model_clock(&M, 10 + 25001);
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) == 4);
    CHECK(pod_model_eff(&M, pod_model_find(&M, "a1")) == POD_IDLE && pod_model_eff(&M, pod_model_find(&M, "a4")) == POD_ASKING);
}

// The Tabs grid scrolls by rows in the root frame: SCROLL adds (never below 0), a model change or sync leaves it, and the
// root frame holds no tab (the chosen cover is the model's selected tab).
static void nav_test_grid_scroll(void) {
    fresh();
    act(POD_A_SCROLL, 1, 0);
    CHECK(top()->scroll == 1 && N.depth == 1 && top()->tab_id[0] == 0);
    act(POD_A_SCROLL, -5, 0);
    CHECK(top()->scroll == 0);
    act(POD_A_SCROLL, 2, 0);
    pod_nav_sync(&N, &M);
    CHECK(top()->scroll == 2 && top()->view == POD_V_TABS && N.depth == 1);
    act(POD_A_OPEN_TAB, 0, 0);                    // opening a tab leaves the root's offset where it was
    act(POD_A_BACK, 0, 0);
    CHECK(N.depth == 1 && top()->scroll == 2);
}

static void nav_test_follow(void) {
    fresh();
    // Other tab: a4 is only in "Docs" (tab 1); a4 is asking -> Agent. No effect, the stack is replaced.
    act(POD_A_OPEN_TAB, 0, 0);
    CHECK(pod_nav_follow(&N, &M, "a4", 100));
    CHECK(N.depth == 3 && N.stack[0].view == POD_V_TABS && N.stack[1].view == POD_V_TAB);
    CHECK(N.stack[1].tab == 1 && !strcmp(N.stack[1].tab_id, "s2"));
    CHECK(top()->view == POD_V_AGENT && !strcmp(top()->agent, "a4") && top()->tab == 1);
    CHECK(M.agents[3].has_open && M.agents[3].open_ms == 100);
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
    CHECK(pod_nav_list(&N, &M, l, POD_AGENTS_MAX) >= 1 && !strcmp(l[0]->id, "a9"));
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

int main(void) {
    nav_test_grid_scroll();
    nav_test_open_by_state();
    nav_test_prev_next_wrap();
    nav_test_talk_send();
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
    printf("Pod nav: PASS (%d checks)\n", checks);
    return 0;
}
