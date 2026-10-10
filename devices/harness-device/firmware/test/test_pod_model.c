// Host test for the Pod model (main/ui/habitat/pod/pod_model.c). Pure C: no clock, no ESP-IDF.
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "pod/pod_model.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

static bool utf8_ok(const char *s) {
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        int n = *p < 0x80 ? 0 : (*p >> 5) == 6 ? 1 : (*p >> 4) == 14 ? 2 : (*p >> 3) == 30 ? 3 : -1;
        if (n < 0) return false;
        p++;
        while (n--) { if ((*p & 0xC0) != 0x80) return false; p++; }
    }
    return true;
}

static pod_model_t M;

static void fresh(void) {
    pod_model_reset(&M);
    pod_model_agent(&M, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&M, "a2", "Beta", "codex", "mac");
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agents_end(&M);
}

static void pod_model_test_states(void) {
    fresh();
    CHECK(M.agent_count == 3);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    CHECK(a && !strcmp(a->name, "Alpha") && !strcmp(a->engine, "claude") && !strcmp(a->machine, "mac"));
    CHECK(pod_model_find(&M, "zz") == NULL);
    CHECK(pod_model_state(&M, a, 0) == POD_IDLE);

    const char *ls[][2] = {{"idle", "I"}, {"working", "W"}, {"question", "A"}, {"finished", "D"},
                           {"failed", "I"}, {"paused", "I"}, {"offline", "I"}};
    uint32_t t = 100;
    for (unsigned i = 0; i < sizeof ls / sizeof ls[0]; i++, t += 10) {
        pod_model_library_status(&M, "a1", ls[i][0], t);
        pod_state_t want = ls[i][1][0] == 'W' ? POD_WORKING : ls[i][1][0] == 'A' ? POD_ASKING
                         : ls[i][1][0] == 'D' ? POD_DONE : POD_IDLE;
        CHECK(pod_model_state(&M, a, t) == want);
    }

    pod_model_turn(&M, "a2", "started", NULL, 0, 1000);
    a = pod_model_find(&M, "a2");
    CHECK(pod_model_state(&M, a, 1000) == POD_WORKING);
    CHECK(a->since_ms == 1000 && a->activity[0] == 0);
    pod_model_turn(&M, "a2", "activity", "Reading files", 7, 1500);
    CHECK(pod_model_state(&M, a, 1500) == POD_WORKING && !strcmp(a->activity, "Reading files") && a->elapsed_s == 7);
    CHECK(a->since_ms == 1000);
    pod_model_turn(&M, "a2", "started", NULL, 0, 2000);
    CHECK(a->activity[0] == 0 && a->since_ms == 2000);
    pod_model_turn(&M, "a2", "done", NULL, 0, 2500);
    CHECK(pod_model_state(&M, a, 2500) == POD_DONE);
    pod_model_turn(&M, "a2", "error", NULL, 0, 3000);
    CHECK(pod_model_state(&M, a, 3000) == POD_IDLE);

    // question
    pod_model_turn(&M, "a3", "started", NULL, 0, 10);
    pod_model_question(&M, "a3", "Delete the build folder?");
    a = pod_model_find(&M, "a3");
    CHECK(a->state == POD_ASKING && !strcmp(a->question, "Delete the build folder?"));
    pod_model_question_close(&M, "a3");
    CHECK(a->state == POD_WORKING);
    pod_model_turn(&M, "a3", "done", NULL, 0, 20);
    pod_model_question_close(&M, "a3");           // not asking: unchanged
    CHECK(a->state == POD_DONE);
    // long question: clamped on a codepoint boundary
    char q[2000]; q[0] = 0;
    for (int i = 0; i < 150; i++) strcat(q, "Đồng ý?");
    pod_model_question(&M, "a3", q);
    CHECK(strlen(a->question) < sizeof a->question && utf8_ok(a->question) && a->state == POD_ASKING);
    pod_model_question(&M, "nobody", "x");        // unknown id: ignored, no crash
}

static void pod_model_test_stale_busy(void) {
    fresh();
    pod_model_library_status(&M, "a1", "working", 1000);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    CHECK(pod_model_state(&M, a, 1000 + 25000) == POD_WORKING);
    CHECK(pod_model_state(&M, a, 1000 + 25001) == POD_IDLE);
    pod_model_turn(&M, "a1", "activity", "x", 1, 20000);   // a fresh event revives it
    CHECK(pod_model_state(&M, a, 40000) == POD_WORKING);
    pod_model_question(&M, "a1", "ok?");                    // asking never goes stale
    CHECK(pod_model_state(&M, a, 900000) == POD_ASKING);
}

static void pod_model_test_library_vs_turn_order(void) {
    fresh();
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_library_status(&M, "a1", "idle", 100);
    pod_model_turn(&M, "a1", "started", NULL, 0, 200);      // newer turn beats older library
    CHECK(pod_model_state(&M, a, 200) == POD_WORKING);
    pod_model_library_status(&M, "a1", "idle", 150);        // older library arrives late: ignored
    CHECK(pod_model_state(&M, a, 200) == POD_WORKING);
    pod_model_library_status(&M, "a1", "finished", 300);    // newer library beats the turn
    CHECK(pod_model_state(&M, a, 300) == POD_DONE && a->event_ms == 300);
    pod_model_turn(&M, "a1", "activity", "late", 3, 250);   // older turn event: ignored
    CHECK(pod_model_state(&M, a, 300) == POD_DONE && a->activity[0] == 0);
    pod_model_turn(&M, "a1", "started", NULL, 0, 300);      // same ms: the later call wins
    CHECK(pod_model_state(&M, a, 300) == POD_WORKING);
}

static const char *ids_a[] = {"a1", "a2"};
static const char *ids_b[] = {"a3", "ghost", "a1"};
static const char *ids_c[] = {"a2"};

static void pod_model_test_tabs_with_ids(void) {
    fresh();
    cable_swarm_t it[3] = {{"s1", "Build", 2, 2}, {"s2", "Docs", 3, 3}, {"s3", "Solo", 1, 1}};
    const char *const *ids[3] = {ids_a, ids_b, ids_c};
    uint8_t cnt[3] = {2, 3, 1};
    cable_tile_t tiles[2] = {{0, 0, 500, 1000, "a1"}, {500, 0, 1000, 1000, "a2"}};
    uint32_t rev = M.revision;
    pod_model_swarms(&M, it, ids, cnt, 3, "s1", tiles, 2);
    CHECK(M.revision > rev);
    CHECK(M.tab_count == 3 && M.selected == 0);
    CHECK(!strcmp(M.tabs[0].id, "s1") && !strcmp(M.tabs[0].name, "Build"));
    CHECK(M.tabs[0].members_known && M.tabs[0].count == 2 && M.tabs[0].panes == 2);
    CHECK(M.tabs[0].agent[0] == 0 && M.tabs[0].agent[1] == 1);
    CHECK(M.tabs[0].has_rects && M.tabs[0].rect[1].x1 == 500 && M.tabs[0].rect[1].x2 == 1000);
    CHECK(M.tabs[1].members_known && M.tabs[1].count == 3 && !M.tabs[1].has_rects);
    CHECK(M.tabs[1].agent[0] == 2 && M.tabs[1].agent[1] == -1 && M.tabs[1].agent[2] == 0);
    CHECK(M.tabs[2].agent[0] == 1 && M.tabs[2].count == 1);
    // selecting another tab moves the rects
    rev = M.revision;
    pod_model_swarms(&M, it, ids, cnt, 3, "s2", NULL, 0);
    CHECK(M.revision > rev && M.selected == 1 && !M.tabs[0].has_rects && !M.tabs[1].has_rects);
    // the same feed again changes nothing
    rev = M.revision;
    pod_model_swarms(&M, it, ids, cnt, 3, "s2", NULL, 0);
    CHECK(M.revision == rev);
}

static void pod_model_test_no_agent_ids(void) {
    fresh();
    cable_swarm_t it[2] = {{"s1", "Build", 2, 2}, {"s2", "Docs", 3, 4}};
    cable_tile_t tiles[3] = {{0, 0, 500, 1000, "a2"}, {500, 0, 1000, 500, ""}, {500, 500, 1000, 1000, "a3"}};
    pod_model_swarms(&M, it, NULL, NULL, 2, "s1", tiles, 3);
    CHECK(M.tab_count == 2 && M.selected == 0);
    CHECK(!M.tabs[1].members_known && M.tabs[1].count == 3 && M.tabs[1].panes == 4);
    CHECK(M.tabs[0].members_known && M.tabs[0].has_rects);
    CHECK(M.tabs[0].agent[0] == 1 && M.tabs[0].agent[1] == -1 && M.tabs[0].agent[2] == 2);
    CHECK(M.tabs[0].rect[2].y1 == 500);
    // counts of 0 behave like absent
    const char *const *ids[2] = {NULL, NULL};
    uint8_t cnt[2] = {0, 0};
    pod_model_swarms(&M, it, ids, cnt, 2, "s2", NULL, 0);
    CHECK(!M.tabs[0].members_known && !M.tabs[1].members_known && M.selected == 1);
}

static void pod_model_test_shared_agent(void) {
    fresh();
    cable_swarm_t it[2] = {{"s1", "One", 2, 2}, {"s2", "Two", 2, 2}};
    static const char *x[] = {"a1", "a2"}, *y[] = {"a1", "a3"};
    const char *const *ids[2] = {x, y};
    uint8_t cnt[2] = {2, 2};
    pod_model_swarms(&M, it, ids, cnt, 2, "s1", NULL, 0);
    CHECK(M.tabs[0].agent[0] == 0 && M.tabs[1].agent[0] == 0);
    CHECK(M.tabs[0].agent[1] == 1 && M.tabs[1].agent[1] == 2);
    // more members than panes: capped at POD_PANES_MAX
    char names[30][8];
    const char *many[30];
    for (int i = 0; i < 30; i++) { snprintf(names[i], 8, "a%d", i); many[i] = names[i]; }
    const char *const *ids2[1] = {many};
    uint8_t c2[1] = {30};
    cable_swarm_t one[1] = {{"s1", "One", 30, 30}};
    pod_model_swarms(&M, one, ids2, c2, 1, "s1", NULL, 0);
    CHECK(M.tabs[0].count == POD_PANES_MAX);
}

static void pod_model_test_recap_lines(void) {
    fresh();
    pod_model_recap(&M, "a1", "A. B! C?", false);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    CHECK(a->recap_lines == 3);
    CHECK(!strcmp(a->recap + a->line_at[0], "A.") && !strcmp(a->recap + a->line_at[1], "B!") &&
          !strcmp(a->recap + a->line_at[2], "C?"));
    pod_model_recap(&M, "a1", "Fixed the bug.\nAdded a test. Tidy 3.5 version", false);
    CHECK(a->recap_lines == 3 && !strcmp(a->recap + a->line_at[1], "Added a test.") &&
          !strcmp(a->recap + a->line_at[2], "Tidy 3.5 version"));
    pod_model_recap(&M, "a1", "", false);
    CHECK(a->recap_lines == 0);
    // opens on recap: done or idle with a recap
    pod_model_recap(&M, "a1", "Done it.", false);
    pod_model_library_status(&M, "a1", "finished", 10);
    CHECK(pod_model_opens_on_recap(&M, a));
    pod_model_library_status(&M, "a1", "idle", 11);
    CHECK(pod_model_opens_on_recap(&M, a));
    pod_model_library_status(&M, "a1", "working", 12);
    CHECK(!pod_model_opens_on_recap(&M, a));
    pod_model_library_status(&M, "a1", "idle", 13);
    CHECK(!pod_model_opens_on_recap(&M, pod_model_find(&M, "a2")));   // idle, no recap
}

static void pod_model_test_recap_cut(void) {
    fresh();
    char buf[1800]; buf[0] = 0;
    for (int i = 1; i <= POD_RECAP_LINES + 4; i++) { char s[32]; snprintf(s, sizeof s, "Sentence %d here. ", i); strcat(buf, s); }
    pod_model_recap(&M, "a1", buf, false);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    CHECK(a->recap_lines == POD_RECAP_LINES);
    const char *last = a->recap + a->line_at[POD_RECAP_LINES - 1];
    size_t n = strlen(last);
    CHECK(a->recap_cut && n >= 3 && strcmp(last + n - 3, "\xE2\x80\xA6"));   // no "…" glyph: the view draws "..."
    char want[32]; snprintf(want, sizeof want, "Sentence %d here.", POD_RECAP_LINES);
    CHECK(!strncmp(last, want, strlen(want)));
    // fewer sentences than the cap: nothing dropped, no ellipsis
    pod_model_recap(&M, "a1", "One. Two. Three. Four. Five. Six. Seven. Eight.", false);
    last = a->recap + a->line_at[7];
    CHECK(a->recap_lines == 8 && !strcmp(last, "Eight.") && !a->recap_cut);
    // a source cut marker is stripped and flagged: the daemon's old " +", and a trailing "…"
    pod_model_recap(&M, "a1", "It renamed the module and then +", false);
    CHECK(a->recap_cut && !strcmp(a->recap, "It renamed the module and then"));
    pod_model_recap(&M, "a1", "It renamed the module and then\xE2\x80\xA6", false);
    CHECK(a->recap_cut && !strcmp(a->recap, "It renamed the module and then"));
    pod_model_recap(&M, "a1", "Whole sentence.", false);
    CHECK(!a->recap_cut);

    // ~3 KB of Vietnamese in one long sentence
    static char vi[4000]; vi[0] = 0;
    while (strlen(vi) < 3000) strcat(vi, "Tôi đã sửa lỗi đăng nhập và thêm bài kiểm tra mới cho phần thanh toán, ");
    pod_model_recap(&M, "a1", vi, false);
    CHECK(a->recap_lines >= 1);
    size_t total = a->line_at[a->recap_lines - 1] + strlen(a->recap + a->line_at[a->recap_lines - 1]) + 1;
    CHECK(total <= POD_RECAP_BYTES);
    CHECK(utf8_ok(a->recap));
    last = a->recap + a->line_at[a->recap_lines - 1];
    n = strlen(last);
    CHECK(a->recap_cut && utf8_ok(last));
    // many short Vietnamese sentences with multibyte chars at the budget edge
    static char vs[9000]; vs[0] = 0;
    for (int i = 0; i < 150; i++) strcat(vs, "Đã xong ấy nhé! ");
    pod_model_recap(&M, "a1", vs, false);
    CHECK(a->recap_lines == POD_RECAP_LINES && a->recap_cut && utf8_ok(a->recap));
    // every line start lies inside the buffer and is a codepoint boundary
    for (int i = 0; i < a->recap_lines; i++) CHECK(a->line_at[i] < POD_RECAP_BYTES && utf8_ok(a->recap + a->line_at[i]));
}

static void pod_model_test_agents_end_drops(void) {
    fresh();
    cable_swarm_t it[1] = {{"s1", "One", 3, 3}};
    static const char *x[] = {"a1", "a2", "a3"};
    const char *const *ids[1] = {x};
    uint8_t cnt[1] = {3};
    pod_model_swarms(&M, it, ids, cnt, 1, "s1", NULL, 0);
    pod_model_recap(&M, "a3", "Keep me.", false);
    uint32_t rev = M.revision;
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agents_end(&M);
    CHECK(M.revision > rev && M.agent_count == 2);
    CHECK(pod_model_find(&M, "a2") == NULL && pod_model_find(&M, "a3") != NULL);
    CHECK(pod_model_find(&M, "a3")->recap_lines == 1);        // survivors keep their state
    CHECK(M.tabs[0].agent[0] == 0 && M.tabs[0].agent[1] == -1 && M.tabs[0].agent[2] == 1);  // indices remapped
    // a full resend changes nothing
    rev = M.revision;
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "a1", "Alpha", "claude", "mac");
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agents_end(&M);
    CHECK(M.revision == rev);
    // working list in roster order
    pod_model_library_status(&M, "a3", "working", 5);
    pod_model_library_status(&M, "a1", "question", 6);
    const pod_agent_t *w[POD_AGENTS_MAX];
    int n = pod_model_working(&M, w, POD_AGENTS_MAX);
    CHECK(n == 2 && !strcmp(w[0]->id, "a1") && !strcmp(w[1]->id, "a3"));
    CHECK(pod_model_working(&M, w, 1) == 1);
    // link flag
    rev = M.revision;
    pod_model_link(&M, true);
    CHECK(M.linked && M.revision > rev);
    rev = M.revision;
    pod_model_link(&M, true);
    CHECK(M.revision == rev);
}

static void pod_model_test_restore_vs_live(void) {
    fresh();
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_recap(&M, "a1", "Old history. Older.", true);          // a restore fills an empty recap
    CHECK(a->recap_lines == 2);
    pod_model_recap(&M, "a1", "Live one.", false);                   // a live summary replaces it
    CHECK(a->recap_lines == 1 && !strcmp(a->recap, "Live one."));
    uint32_t rev = M.revision;
    pod_model_recap(&M, "a1", "Late restore of old history.", true); // and a later restore never overwrites it
    CHECK(a->recap_lines == 1 && !strcmp(a->recap, "Live one.") && M.revision == rev);
    pod_model_recap(&M, "a1", "Newer live.", false);
    CHECK(!strcmp(a->recap, "Newer live."));
    pod_model_recap(&M, "a2", "R1.", true);                          // a second restore replaces a restore
    pod_model_recap(&M, "a2", "R2.", true);
    CHECK(!strcmp(pod_model_find(&M, "a2")->recap, "R2."));
}


// ---- the library as a second roster source ---------------------------------------------------------------

static void pod_model_test_library_row_adds(void) {
    fresh();   // a1..a3 come from the tab
    uint32_t rev = M.revision;
    pod_model_library_row(&M, "b1", "Delta", "codex", "box", "working", 30, 1000);
    const pod_agent_t *b = pod_model_find(&M, "b1");
    CHECK(b && M.agent_count == 4 && M.revision > rev);
    CHECK(!strcmp(b->name, "Delta") && !strcmp(b->engine, "codex") && !strcmp(b->machine, "box"));
    CHECK(b->src == POD_SRC_LIBRARY && pod_model_state(&M, b, 1000) == POD_WORKING);
    // a row for a tab agent adds the source, fills only what is empty, and applies the status
    pod_model_agent(&M, "e1", "Eps", "", "");
    pod_model_library_row(&M, "e1", "Other", "claude", "mac", "question", 5, 1100);
    const pod_agent_t *e = pod_model_find(&M, "e1");
    CHECK(e->src == (POD_SRC_TAB | POD_SRC_LIBRARY) && !strcmp(e->name, "Eps"));
    CHECK(!strcmp(e->engine, "claude") && !strcmp(e->machine, "mac") && e->state == POD_ASKING);
    // the same row again changes nothing
    rev = M.revision;
    pod_model_library_row(&M, "b1", "Delta", "codex", "box", "working", 31, 1200);
    CHECK(M.revision == rev && M.agent_count == 5);
    // an empty id is no agent
    pod_model_library_row(&M, "", "x", "y", "z", "idle", 0, 1300);
    CHECK(M.agent_count == 5);
}

static void pod_model_test_agents_end_keeps_library(void) {
    fresh();
    pod_model_library_row(&M, "a1", "Alpha", "claude", "mac", "idle", 1, 10);   // a1 in both sources
    pod_model_library_row(&M, "b1", "Delta", "codex", "box", "idle", 1, 10);    // library only
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "a3", "Gamma", "gemini", "box");
    pod_model_agents_end(&M);                       // the window changed tab: a1, a2 leave the TAB source
    CHECK(pod_model_find(&M, "a3") && pod_model_find(&M, "b1"));
    const pod_agent_t *a1 = pod_model_find(&M, "a1");
    CHECK(a1 && a1->src == POD_SRC_LIBRARY);        // still listed by the library
    CHECK(pod_model_find(&M, "a2") == NULL);        // tab only: gone
    CHECK(M.agent_count == 3);
}

static void pod_model_test_library_sweep_drops_stale(void) {
    pod_model_reset(&M);
    pod_model_library_begin(&M);
    pod_model_library_row(&M, "b1", "B1", "claude", "", "idle", 1, 10);
    pod_model_library_row(&M, "b2", "B2", "claude", "", "idle", 1, 10);
    pod_model_library_end(&M);
    CHECK(M.agent_count == 2);
    pod_model_agent(&M, "t1", "T1", "claude", "");   // also on the tab
    pod_model_library_row(&M, "t1", "T1", "claude", "", "idle", 1, 20);
    pod_model_agents_end(&M);
    pod_model_library_begin(&M);
    pod_model_library_row(&M, "b2", "B2", "claude", "", "working", 1, 30);
    uint32_t rev = M.revision;
    pod_model_library_end(&M);                      // b1 and t1 were not in the sweep
    CHECK(M.revision > rev);
    CHECK(pod_model_find(&M, "b1") == NULL);
    CHECK(pod_model_find(&M, "b2") && pod_model_state(&M, pod_model_find(&M, "b2"), 30) == POD_WORKING);
    const pod_agent_t *t1 = pod_model_find(&M, "t1");
    CHECK(t1 && t1->src == POD_SRC_TAB);            // the tab still lists it
    // the tabs follow the compaction
    static const char *ids[] = {"b2"};
    static const char *const *lists[] = {ids};
    uint8_t counts[] = {1};
    cable_swarm_t sw = {.agents = 1, .panes = 1};
    snprintf(sw.id, sizeof sw.id, "s0");
    pod_model_swarms(&M, &sw, lists, counts, 1, "s0", NULL, 0);
    CHECK(M.tabs[0].agent[0] == (int8_t)(pod_model_find(&M, "b2") - M.agents));
    pod_model_library_begin(&M);
    pod_model_library_end(&M);                      // an empty sweep drops b2
    CHECK(pod_model_find(&M, "b2") == NULL && M.tabs[0].agent[0] == -1 && M.agent_count == 1);
}

static void pod_model_test_library_cap_preference(void) {
    pod_model_reset(&M);
    char id[8];
    // 32 library agents m0..m31: m0 is a tab member, every one idle with age 100+i s (m31 the oldest)
    static char mem[1][POD_PANES_MAX][ID_MAX];
    static const char *memp[1][POD_PANES_MAX];
    static const char *const *lists[1];
    snprintf(mem[0][0], ID_MAX, "m0");
    snprintf(mem[0][1], ID_MAX, "x-member");        // a member that is not in the roster yet
    memp[0][0] = mem[0][0]; memp[0][1] = mem[0][1]; lists[0] = memp[0];
    uint8_t counts[] = {2};
    cable_swarm_t sw = {.agents = 2, .panes = 2};
    snprintf(sw.id, sizeof sw.id, "s0");
    pod_model_swarms(&M, &sw, lists, counts, 1, "s0", NULL, 0);
    pod_model_library_begin(&M);
    for (int i = 0; i < POD_AGENTS_MAX; i++) {
        snprintf(id, sizeof id, "m%d", i);
        pod_model_library_row(&M, id, id, "claude", "", "idle", 100 + i, 10);
    }
    CHECK(M.agent_count == POD_AGENTS_MAX);
    // an old idle stranger does not get in
    pod_model_library_row(&M, "old", "old", "claude", "", "idle", 99999, 10);
    CHECK(pod_model_find(&M, "old") == NULL && M.agent_count == POD_AGENTS_MAX);
    // a more recent idle one replaces the oldest (m31)
    pod_model_library_row(&M, "fresh", "fresh", "claude", "", "idle", 1, 10);
    CHECK(pod_model_find(&M, "fresh") && pod_model_find(&M, "m31") == NULL);
    // a working one replaces the oldest idle (m30), though it is the older of the two
    pod_model_library_row(&M, "busy", "busy", "claude", "", "working", 50000, 10);
    CHECK(pod_model_find(&M, "busy") && pod_model_find(&M, "m30") == NULL);
    // a tab member replaces the lowest-ranked non-member even though it is idle and old
    pod_model_library_row(&M, "x-member", "xm", "claude", "", "idle", 99999, 10);
    CHECK(pod_model_find(&M, "x-member") && pod_model_find(&M, "m29") == NULL);
    // members are never the ones to go: m0 is oldest-but-one and still here
    CHECK(pod_model_find(&M, "m0") && M.agent_count == POD_AGENTS_MAX);
    // a tab agent (agents.*) always makes room, evicting a library-only one
    pod_model_agent(&M, "tabby", "tabby", "claude", "");
    CHECK(pod_model_find(&M, "tabby") && M.agent_count == POD_AGENTS_MAX);
}

// H2: a line that ends exactly at the end of the 2048-byte buffer, with more text after it, used to wrap
// `room = cap - 1 - pos` to SIZE_MAX (a read of s[-1] and a huge memcpy).
static void pod_model_test_recap_exact_fill(void) {
    fresh();
    static char text[4096];
    size_t used = 0;
    for (int i = 0; i < 7; i++) {                       // 7 sentences; each line costs n + 1 (its NUL) bytes
        size_t cost = i < 6 ? 292 : POD_RECAP_BYTES - 6 * 292;
        size_t n = cost - 1;
        memset(text + used, 'a', n - 1);
        text[used + n - 1] = '.';
        text[used + n] = ' ';
        used += n + 1;
    }
    strcpy(text + used, "More text after the buffer is full.");
    pod_model_recap(&M, "a1", text, false);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    CHECK(a->recap_lines >= 7 && a->recap_lines <= POD_RECAP_LINES);
    CHECK(a->recap[POD_RECAP_BYTES - 1] == 0 && utf8_ok(a->recap));
    const char *last = a->recap + a->line_at[a->recap_lines - 1];
    CHECK(a->recap_cut && strlen(last) > 0);   // the cut is flagged; the view draws the "..."
    // the same with no text after it: nothing is cut
    text[used] = 0;
    pod_model_recap(&M, "a1", text, false);
    CHECK(a->recap_lines == 7 && !a->recap_cut);
}

// M7: now_ms is a uint32 that wraps (after 49.7 days): ordering is by signed difference.
static void pod_model_test_clock_wrap(void) {
    fresh();
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_turn(&M, "a1", "started", NULL, 0, 0xFFFFFFF0u);
    CHECK(pod_model_state(&M, a, 0xFFFFFFF0u) == POD_WORKING);
    pod_model_turn(&M, "a1", "activity", "after the wrap", 1, 0x10u);   // newer than 0xFFFFFFF0
    CHECK(!strcmp(a->activity, "after the wrap") && a->event_ms == 0x10u);
    pod_model_library_status(&M, "a1", "finished", 0xFFFFFFF8u);        // older than 0x10: ignored
    CHECK(a->state == POD_WORKING && a->event_ms == 0x10u);
    pod_model_library_row(&M, "a1", "Alpha", "claude", "mac", "idle", 3, 0xFFFFFFF0u);   // older row: no state change
    CHECK(a->state == POD_WORKING);
    pod_model_library_row(&M, "a1", "Alpha", "claude", "mac", "finished", 3, 0x20u);
    CHECK(a->state == POD_DONE && a->event_ms == 0x20u);
    // an event just ahead of the clock is not stale, and the busy window crosses the wrap
    pod_model_turn(&M, "a2", "started", NULL, 0, 0xFFFFFFF0u);
    const pod_agent_t *b = pod_model_find(&M, "a2");
    CHECK(pod_model_state(&M, b, 0x10u) == POD_WORKING);
    CHECK(pod_model_state(&M, b, 0xFFFFFFF0u + 25001u) == POD_IDLE);
    CHECK(pod_model_state(&M, b, 0xFFFFFFE0u) == POD_WORKING);
}

// M8: on the selected tab the tiles say who is where. A shell tile first, ids in another order: each rect keeps
// its own agent, the shell is -1 and holds its place.
static void pod_model_test_tiles_beat_ids(void) {
    fresh();
    cable_swarm_t it[1] = {{"s1", "Build", 3, 3}};
    const char *ids[] = {"a1", "a2", "a3"};
    const char *const *list[1] = {ids};
    uint8_t cnt[1] = {3};
    cable_tile_t tiles[3];
    memset(tiles, 0, sizeof tiles);
    tiles[0] = (cable_tile_t){0, 0, 500, 1000, ""};
    tiles[1] = (cable_tile_t){500, 0, 1000, 500, "a3"};
    tiles[2] = (cable_tile_t){500, 500, 1000, 1000, "a1"};
    pod_model_swarms(&M, it, list, cnt, 1, "s1", tiles, 3);
    const pod_tab_t *t = &M.tabs[0];
    CHECK(t->has_rects && t->members_known && t->count == 3);
    CHECK(t->agent[0] == -1 && t->agent[1] == 2 && t->agent[2] == 0);
    CHECK(t->rect[1].x1 == 500 && t->rect[2].y1 == 500);
    CHECK(t->member_hash[0] == 0);   // the shell tile has no agent
    // fewer ids than tiles, or none: the same answer
    pod_model_swarms(&M, it, NULL, NULL, 1, "s1", tiles, 3);
    CHECK(M.tabs[0].agent[1] == 2 && M.tabs[0].agent[2] == 0 && M.tabs[0].count == 3);
}

// M12: one effective state everywhere. An agent whose turn.done was missed leaves Working after 25 s: the
// working list, the recap rule and the cap's ranking all follow it.
static void pod_model_test_effective_state(void) {
    fresh();
    pod_model_turn(&M, "a1", "started", NULL, 0, 1000);
    pod_model_recap(&M, "a1", "Did it.", false);
    const pod_agent_t *a = pod_model_find(&M, "a1"), *w[POD_AGENTS_MAX];
    pod_model_clock(&M, 1000 + 24000);
    CHECK(pod_model_eff(&M, a) == POD_WORKING && pod_model_working(&M, w, POD_AGENTS_MAX) == 1);
    CHECK(!pod_model_opens_on_recap(&M, a));
    pod_model_clock(&M, 1000 + 25001);
    CHECK(pod_model_eff(&M, a) == POD_IDLE && pod_model_working(&M, w, POD_AGENTS_MAX) == 0);
    CHECK(pod_model_opens_on_recap(&M, a));
    // the clock never goes back
    pod_model_clock(&M, 5);
    CHECK(M.clock_ms == 1000 + 25001);
    // eviction rank: a stale "working" library agent ranks as idle (it is evicted before a live one)
    pod_model_reset(&M);
    for (int i = 0; i < POD_AGENTS_MAX; i++) {
        char id[8]; snprintf(id, sizeof id, "m%d", i);
        pod_model_library_row(&M, id, id, "claude", "", i == 0 ? "working" : "idle", i == 0 ? 9999 : 100 + i, 100);
    }
    pod_model_clock(&M, 100 + 30000);                      // m0's "working" is 30 s old: effectively idle
    pod_model_library_row(&M, "live", "live", "claude", "", "working", 5, 100 + 30000);
    CHECK(pod_model_find(&M, "live") != NULL && pod_model_find(&M, "m0") == NULL);
}

// LOW: activity text that is its own source, and an activity while asking.
static void pod_model_test_activity_edges(void) {
    fresh();
    pod_model_turn(&M, "a1", "started", NULL, 0, 10);
    pod_model_turn(&M, "a1", "activity", "Reading files", 2, 20);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_turn(&M, "a1", "activity", a->activity, 3, 30);            // its own source
    CHECK(!strcmp(a->activity, "Reading files") && a->elapsed_s == 3);
    pod_model_question(&M, "a1", "Proceed?");
    pod_model_turn(&M, "a1", "activity", "still going", 4, 40);          // does not answer the question
    CHECK(a->state == POD_ASKING && !strcmp(a->question, "Proceed?"));
    pod_model_question_close(&M, "a1");
    CHECK(a->state == POD_WORKING && a->question[0] == 0);
    pod_model_turn(&M, "a1", "activity", "now it counts", 5, 50);
    CHECK(!strcmp(a->activity, "now it counts"));
}

// The turn's steps: the sentences the agent moved on from, newest first. The footer verb has its own field and never
// touches them; a repeat does not stack, the oldest falls off at POD_STEPS_MAX, a new turn or the end of work clears them.
static void pod_model_test_steps(void) {
    fresh();
    pod_model_turn(&M, "a1", "started", NULL, 0, 10);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_turn(&M, "a1", "activity", "Reading the model", 1, 20);
    CHECK(a->step_count == 0);
    pod_model_turn(&M, "a1", "verb", "Infusing...", 2, 30);   // the verb leaves the sentence and the steps alone
    CHECK(a->step_count == 0 && !strcmp(a->activity, "Reading the model") && !strcmp(a->verb, "Infusing"));
    pod_model_turn(&M, "a1", "activity", "Editing pod_model.c now", 3, 40);
    CHECK(a->step_count == 1 && !strcmp(a->steps[0], "Reading the model") && !strcmp(a->verb, "Infusing"));
    pod_model_turn(&M, "a1", "activity", "Reading the model", 4, 50);   // an old sentence again: not both current and step
    CHECK(a->step_count == 1 && !strcmp(a->steps[0], "Editing pod_model.c now") && !strcmp(a->activity, "Reading the model"));
    pod_model_turn(&M, "a1", "activity", "", 5, 60);
    pod_model_turn(&M, "a1", "activity", "Reading the model", 5, 61);
    CHECK(a->step_count == 1);
    pod_model_turn(&M, "a1", "activity", "Running the tests", 6, 70);
    pod_model_turn(&M, "a1", "activity", "Fixing a failure", 7, 80);
    pod_model_turn(&M, "a1", "activity", "Running them again", 8, 90);
    CHECK(a->step_count == POD_STEPS_MAX && !strcmp(a->steps[0], "Fixing a failure") &&
          !strcmp(a->steps[1], "Running the tests") && !strcmp(a->steps[2], "Reading the model"));
    pod_model_turn(&M, "a1", "done", NULL, 0, 100);
    CHECK(a->step_count == 0 && a->verb[0] == 0 && a->activity[0] == 0);
    pod_model_turn(&M, "a1", "started", NULL, 0, 110);
    pod_model_turn(&M, "a1", "activity", "One thing", 1, 120);
    pod_model_turn(&M, "a1", "activity", "Another thing", 2, 130);
    CHECK(a->step_count == 1);
    pod_model_turn(&M, "a1", "started", NULL, 0, 140);
    CHECK(a->step_count == 0 && a->activity[0] == 0 && a->verb[0] == 0);
    pod_model_turn(&M, "a1", "activity", "x y", 1, 150);
    pod_model_turn(&M, "a1", "activity", "y z", 1, 151);
    pod_model_question(&M, "a1", "Which?");
    CHECK(a->step_count == 0);
}

// A tool step (turn.activity `step`) joins the same newest-first list, never touches the sentence or the verb, and an empty one
// says nothing; a question still clears the list.
static void pod_model_test_tool_steps(void) {
    fresh();
    pod_model_turn(&M, "a1", "started", NULL, 0, 10);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    unsigned rev = M.revision;
    pod_model_turn(&M, "a1", "step", "Read \xc2\xb7 pod_model.c", 1, 20);
    CHECK(a->step_count == 1 && !strcmp(a->steps[0], "Read \xc2\xb7 pod_model.c") && a->activity[0] == 0 && M.revision != rev);
    pod_model_turn(&M, "a1", "activity", "Checking the model", 2, 30);
    pod_model_turn(&M, "a1", "step", "Bash \xc2\xb7 make test", 3, 40);
    CHECK(a->step_count == 2 && !strcmp(a->steps[0], "Bash \xc2\xb7 make test") && !strcmp(a->activity, "Checking the model"));
    pod_model_turn(&M, "a1", "step", "", 4, 50);
    pod_model_turn(&M, "a1", "step", NULL, 4, 50);
    CHECK(a->step_count == 2);
    pod_model_turn(&M, "a1", "step", "Read \xc2\xb7 pod_model.c", 5, 60);   // again: moves to the top, not twice
    CHECK(a->step_count == 2 && !strcmp(a->steps[0], "Read \xc2\xb7 pod_model.c"));
    pod_model_question(&M, "a1", "Which?");
    pod_model_turn(&M, "a1", "step", "Edit \xc2\xb7 x.c", 6, 70);   // asking: no step lands
    CHECK(a->step_count == 0 && a->state == POD_ASKING);
}

// The footer verb: trimmed like the dial's activity_text (dots, "…", spaces), UTF-8 safe, an empty read never blanks it, and
// the sentence and the verb never overwrite each other.
static void pod_model_test_verb(void) {
    fresh();
    pod_model_turn(&M, "a1", "started", NULL, 0, 10);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_turn(&M, "a1", "verb", "  Infusing\xe2\x80\xa6 ", 1, 20);
    CHECK(!strcmp(a->verb, "Infusing") && a->activity[0] == 0 && a->state == POD_WORKING);
    pod_model_turn(&M, "a1", "verb", "", 2, 30);
    pod_model_turn(&M, "a1", "verb", NULL, 2, 31);
    pod_model_turn(&M, "a1", "verb", "...", 2, 32);
    CHECK(!strcmp(a->verb, "Infusing"));
    pod_model_turn(&M, "a1", "activity", "Reading the model", 3, 40);
    pod_model_turn(&M, "a1", "verb", "Brewing...", 3, 41);
    pod_model_turn(&M, "a1", "activity", "", 3, 42);
    CHECK(!strcmp(a->verb, "Brewing") && !strcmp(a->activity, "Reading the model") && a->step_count == 0);
    char big[200];
    memset(big, 0, sizeof big);
    for (int i = 0; i < 60; i++) strcat(big, "\xe1\xbb\x87");   // 3-byte codepoints, 180 bytes
    pod_model_turn(&M, "a1", "verb", big, 3, 50);
    CHECK(strlen(a->verb) < POD_VERB_BYTES && strlen(a->verb) % 3 == 0);
    pod_model_turn(&M, "a1", "done", NULL, 0, 60);
    CHECK(a->verb[0] == 0);
    pod_model_turn(&M, "a1", "verb", "late", 1, 5);   // older than the last event: ignored
    CHECK(a->verb[0] == 0);
}

// The daemon's turn.activity carries an empty text when the terminal shows no footer. That is no reading, not an
// empty activity: the line a heartbeat set must stay, while liveness and the clock still refresh.
static void pod_model_test_empty_activity_keeps_the_line(void) {
    fresh();
    pod_model_turn(&M, "a1", "started", NULL, 0, 10);
    pod_model_turn(&M, "a1", "activity", "Reading files", 2, 20);
    const pod_agent_t *a = pod_model_find(&M, "a1");
    pod_model_turn(&M, "a1", "activity", "", 3, 30);
    CHECK(!strcmp(a->activity, "Reading files") && a->elapsed_s == 3 && a->event_ms == 30);
    pod_model_turn(&M, "a1", "activity", NULL, 4, 40);
    CHECK(!strcmp(a->activity, "Reading files") && a->state == POD_WORKING);
    pod_model_turn(&M, "a1", "started", NULL, 0, 50);                    // a new turn starts blank
    CHECK(a->activity[0] == 0);
    pod_model_turn(&M, "a1", "activity", "", 1, 60);
    CHECK(a->activity[0] == 0);
}


// The Recent list: the 8 agents most recently interacted with, working and asking ones kept first.
static void ten(void) {
    pod_model_reset(&M);
    for (int i = 0; i < 10; i++) {
        char id[8], name[8];
        snprintf(id, sizeof id, "r%d", i); snprintf(name, sizeof name, "R%d", i);
        pod_model_agent(&M, id, name, "claude", "mac");
    }
    pod_model_agents_end(&M);
}
static void order(const pod_agent_t *l[], int n, char *out) {
    out[0] = 0;
    for (int i = 0; i < n; i++) { strcat(out, l[i]->id); strcat(out, i + 1 < n ? " " : ""); }
}
static void pod_model_test_recent(void) {
    const pod_agent_t *l[POD_AGENTS_MAX];
    char got[128];
    CHECK(POD_RECENT_MAX == 8);
    ten();
    pod_model_turn(&M, "r1", "started", NULL, 0, 1000);   // three working agents, all older than the rest
    pod_model_turn(&M, "r4", "started", NULL, 0, 2000);
    pod_model_turn(&M, "r7", "started", NULL, 0, 3000);
    for (int i = 0; i < 10; i++) if (i != 1 && i != 4 && i != 7) { char id[8]; snprintf(id, sizeof id, "r%d", i); pod_model_turn(&M, id, "done", NULL, 0, 10000 + 100 * (uint32_t)i); }
    pod_model_clock(&M, 10900);
    int n = pod_model_recent(&M, l, POD_RECENT_MAX);
    order(l, n, got);
    // 10 candidates: all 3 working stay, then the newest others; newest first.
    CHECK(n == 8 && !strcmp(got, "r9 r8 r6 r5 r3 r7 r4 r1"));
    CHECK(pod_model_recent(&M, l, 3) == 3);
    // Opening an agent bumps it to the top (and pulls it in from outside the 8).
    pod_model_opened(&M, "r0", 11000);
    n = pod_model_recent(&M, l, POD_RECENT_MAX);
    order(l, n, got);
    n = pod_model_recent(&M, l, POD_RECENT_MAX);
    order(l, n, got);
    CHECK(n == 8 && !strcmp(got, "r0 r9 r8 r6 r5 r7 r4 r1"));

    // A library age counts, as an absolute time at receipt.
    pod_model_reset(&M);
    pod_model_agent(&M, "y", "Y", "claude", "mac");
    pod_model_agent(&M, "z", "Z", "claude", "mac");
    pod_model_agent(&M, "w", "W", "claude", "mac");
    pod_model_agents_end(&M);
    pod_model_turn(&M, "y", "done", NULL, 0, 5000);
    pod_model_library_begin(&M);
    pod_model_library_row(&M, "z", "Z", "claude", "mac", "idle", 1, 10000);     // last active 1 s ago: 9000
    pod_model_library_row(&M, "w", "W", "claude", "mac", "idle", 600, 10000);   // 10 minutes ago
    pod_model_library_end(&M);
    n = pod_model_recent(&M, l, POD_RECENT_MAX);
    order(l, n, got);
    CHECK(!strcmp(got, "z y w"));
    pod_model_clock(&M, 20000);   // it only ages
    n = pod_model_recent(&M, l, POD_RECENT_MAX);
    order(l, n, got);
    CHECK(!strcmp(got, "z y w"));

    // A stale working agent (no event for over 25 s) is not working: it gets no priority.
    for (int pass = 0; pass < 2; pass++) {
        pod_model_reset(&M);
        for (int i = 0; i < 9; i++) {
            char id[8]; snprintf(id, sizeof id, "q%d", i);
            pod_model_agent(&M, id, id, "claude", "mac");
        }
        pod_model_agents_end(&M);
        pod_model_turn(&M, "q0", "started", NULL, 0, 1000);
        for (int i = 1; i < 9; i++) { char id[8]; snprintf(id, sizeof id, "q%d", i); pod_model_turn(&M, id, "done", NULL, 0, 20000 + 10 * (uint32_t)i); }
        pod_model_clock(&M, pass ? 26001 + 1000 : 20100);
        pod_model_turn(&M, "q8", "done", NULL, 0, pass ? 27001 : 20100);   // keep the clock moving
        n = pod_model_recent(&M, l, POD_RECENT_MAX);
        bool has_q0 = false;
        for (int i = 0; i < n; i++) if (!strcmp(l[i]->id, "q0")) has_q0 = true;
        CHECK(n == 8 && has_q0 == (pass == 0));
        CHECK((pod_model_eff(&M, pod_model_find(&M, "q0")) == POD_WORKING) == (pass == 0));
    }

    // An agent never seen at all still fills a short list; fewer than 8 candidates all show.
    fresh();
    n = pod_model_recent(&M, l, POD_RECENT_MAX);
    CHECK(n == 3);
}

// Item 7: a member that the tab lists and the daemon describes, but no roster source knows (its machine is offline), joins
// the roster as POD_OFFLINE for as long as the tab lists it.
static void pod_model_test_offline_members(void) {
    pod_model_reset(&M);
    pod_model_agent(&M, "mine", "Devin", "claude", "Mac");
    pod_model_agents_end(&M);
    cable_swarm_t sw[1];
    memset(sw, 0, sizeof sw);
    snprintf(sw[0].id, sizeof sw[0].id, "s0"); snprintf(sw[0].name, sizeof sw[0].name, "Thoi trang");
    sw[0].agents = 2; sw[0].panes = 2;
    const char *ids[] = {"mine", "far"};
    const char *const *idl[1] = {ids};
    uint8_t cnt[1] = {2};
    static pod_member_meta_t meta[1][POD_PANES_MAX];
    memset(meta, 0, sizeof meta);
    meta[0][0] = (pod_member_meta_t){"Devin", "claude", "Mac", true, true};
    meta[0][1] = (pod_member_meta_t){"Stylist", "codex", "Diego's Mac", true, false};
    // Without metadata the old behaviour: the unknown member has no slot.
    pod_model_swarms(&M, sw, idl, cnt, 1, "s0", NULL, 0);
    CHECK(M.tabs[0].agent[0] >= 0 && M.tabs[0].agent[1] == -1 && M.agent_count == 1);
    pod_model_swarms_meta(&M, sw, idl, cnt, 1, "s0", NULL, 0, meta);
    CHECK(M.agent_count == 2 && M.tabs[0].agent[1] >= 0);
    const pod_agent_t *far = pod_model_find(&M, "far");
    CHECK(far && far->state == POD_OFFLINE && (far->src & POD_SRC_TAB_META) && !strcmp(far->name, "Stylist") &&
          !strcmp(far->engine, "codex") && !strcmp(far->machine, "Diego's Mac"));
    CHECK(pod_model_eff(&M, far) == POD_OFFLINE);
    // The sweeps that do not list it leave it alone.
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "mine", "Devin", "claude", "Mac");
    pod_model_agents_end(&M);
    pod_model_library_begin(&M);
    pod_model_library_row(&M, "mine", "Devin", "claude", "Mac", "idle", 5, 1000);
    pod_model_library_end(&M);
    CHECK(pod_model_find(&M, "far") && M.tabs[0].agent[1] >= 0);
    // It never ranks in Recent.
    const pod_agent_t *recent[POD_RECENT_MAX];
    int n = pod_model_recent(&M, recent, POD_RECENT_MAX);
    for (int i = 0; i < n; i++) CHECK(strcmp(recent[i]->id, "far") != 0);
    // The machine comes back: the placeholder is idle, then the library's row takes over.
    meta[0][1].online = true;
    pod_model_swarms_meta(&M, sw, idl, cnt, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "far") && pod_model_find(&M, "far")->state == POD_IDLE);
    pod_model_library_begin(&M);
    pod_model_library_row(&M, "far", "Stylist", "codex", "Diego's Mac", "working", 1, 2000);
    pod_model_library_end(&M);
    CHECK(pod_model_find(&M, "far")->state == POD_WORKING);
    // The tab stops listing it (or the daemon stops describing it): it goes unless a source holds it.
    pod_model_reset(&M);
    pod_model_agent(&M, "mine", "Devin", "claude", "Mac");
    meta[0][1].online = false;
    pod_model_swarms_meta(&M, sw, idl, cnt, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "far") != NULL);
    uint8_t one[1] = {1};
    pod_model_swarms_meta(&M, sw, idl, one, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "far") == NULL && M.agent_count == 1);
    pod_model_swarms_meta(&M, sw, idl, cnt, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "far") != NULL);
    memset(meta, 0, sizeof meta);   // a frame without descriptions
    pod_model_swarms_meta(&M, sw, idl, cnt, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "far") == NULL && M.tabs[0].agent[1] == -1);
    // The window's own roster row for it turns a placeholder into a live agent.
    meta[0][1] = (pod_member_meta_t){"Stylist", "codex", "Diego's Mac", true, false};
    pod_model_swarms_meta(&M, sw, idl, cnt, 1, "s0", NULL, 0, meta);
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "far", "Stylist", "codex", "Diego's Mac");
    CHECK(pod_model_find(&M, "far")->state == POD_IDLE);
    pod_model_agents_end(&M);
}

int main(void) {
    pod_model_test_states();
    pod_model_test_stale_busy();
    pod_model_test_library_vs_turn_order();
    pod_model_test_tabs_with_ids();
    pod_model_test_no_agent_ids();
    pod_model_test_shared_agent();
    pod_model_test_recap_lines();
    pod_model_test_recap_cut();
    pod_model_test_agents_end_drops();
    pod_model_test_restore_vs_live();
    pod_model_test_library_row_adds();
    pod_model_test_agents_end_keeps_library();
    pod_model_test_library_sweep_drops_stale();
    pod_model_test_library_cap_preference();
    pod_model_test_recap_exact_fill();
    pod_model_test_clock_wrap();
    pod_model_test_tiles_beat_ids();
    pod_model_test_effective_state();
    pod_model_test_activity_edges();
    pod_model_test_empty_activity_keeps_the_line();
    pod_model_test_steps();
    pod_model_test_verb();
    pod_model_test_tool_steps();
    pod_model_test_recent();
    pod_model_test_offline_members();
    printf("Pod model: PASS (%d checks)\n", checks);
    return 0;
}
