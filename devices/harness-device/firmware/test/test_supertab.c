#include "../main/ui/habitat/supertab.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ht_supertabs_t model;   // 54 KB: never on the stack, as on the board

static ht_lead_in_t lead(const char *id, const char *state, int order)
{
    return (ht_lead_in_t){.id=id, .project_id="p", .project=id, .engine="claude", .owner="", .local="",
                          .state=state, .order=order, .since=-1};
}
static void frame(ht_supertab_t *t, const char *id, int n, const char *const *states, const int *orders)
{
    assert(ht_supertab_init(t, id, "", id, n));
    for (int i = 0; i < n; i++) {
        char lid[16]; snprintf(lid, sizeof lid, "L%d", i);
        ht_lead_in_t in = lead(lid, states[i], orders ? orders[i] : -1);
        assert(ht_supertab_lead_add(t, &in));
    }
}

static void order_and_limits(void)
{
    static ht_supertab_t t;
    ht_supertabs_reset(&model);
    const char ids[2][ID_MAX] = {"s1", "s2"};
    ht_supertabs_ids(&model, ids, 2, NULL, 0);
    const char *st[4] = {"done", "work", "ask", "stuck"};
    int orders[4] = {2, 0, 2, 1};
    frame(&t, "s1", 4, st, orders);
    ht_supertabs_put(&model, &t, 0, NULL, 0);
    const ht_supertab_t *r = ht_supertabs_find(&model, "s1");
    assert(r && r->lead_n == 4);
    // By order, ties stable: L1(0) L3(1) L0(2) L2(2).
    assert(!strcmp(r->leads[0].id, "L1") && !strcmp(r->leads[1].id, "L3"));
    assert(!strcmp(r->leads[2].id, "L0") && !strcmp(r->leads[3].id, "L2"));
    assert(r->leads[0].state == HT_LEAD_WORK && r->leads[1].state == HT_LEAD_STUCK);
    // A daemon without `order`: frame order.
    frame(&t, "s2", 4, st, NULL);
    ht_supertabs_put(&model, &t, 0, NULL, 0);
    r = ht_supertabs_find(&model, "s2");
    for (int i = 0; i < 4; i++) { char lid[4]; snprintf(lid, sizeof lid, "L%d", i); assert(!strcmp(r->leads[i].id, lid)); }

    // 13 in, 12 kept.
    assert(ht_supertab_init(&t, "s1", "", "s1", 13));
    for (int i = 0; i < 13; i++) {
        char lid[8]; snprintf(lid, sizeof lid, "L%d", i);
        ht_lead_in_t in = lead(lid, "work", i);
        assert(ht_supertab_lead_add(&t, &in) == (i < HT_SUPERTAB_LEADS_MAX));
    }
    assert(t.lead_n == 12 && t.count == 13);
    // A name over 48 bytes is cut on a UTF-8 boundary: 47 ASCII bytes then "é" (2 bytes) leaves 47.
    char name[64]; memset(name, 'a', 47); strcpy(name + 47, "\xc3\xa9tail");
    assert(ht_supertab_init(&t, "s1", "", name, 1));
    assert(strlen(t.name) == 47 && t.name[46] == 'a');
    memset(name, 'b', 46); strcpy(name + 46, "\xc3\xa9tail");   // fits exactly at 48
    assert(ht_supertab_init(&t, "s1", "", name, 1) && strlen(t.name) == 48);
    // An id of ID_MAX bytes or more is rejected, for the Swarm and for a Lead; a Lead without one too.
    char long_id[ID_MAX + 1]; memset(long_id, 'x', ID_MAX); long_id[ID_MAX] = 0;
    assert(!ht_supertab_init(&t, long_id, "", "n", 1));
    assert(!ht_supertab_init(&t, "s1", long_id, "n", 1));
    long_id[ID_MAX - 1] = 0; assert(ht_supertab_init(&t, long_id, "", "n", 1));
    assert(ht_supertab_init(&t, "s1", "", "n", 3));
    ht_lead_in_t bad = lead(long_id, "work", 0); long_id[ID_MAX - 1] = 'x';
    assert(!ht_supertab_lead_add(&t, &bad));
    bad = lead("", "work", 0); assert(!ht_supertab_lead_add(&t, &bad));
    bad = lead(NULL, "work", 0); assert(!ht_supertab_lead_add(&t, &bad));
    bad = lead("L0", "work", 0); assert(ht_supertab_lead_add(&t, &bad) && !ht_supertab_lead_add(&t, &bad));
    assert(ht_supertab_init(&t, "s1", "", "n", 3));
    bad = lead("L9", NULL, 0); bad.project = NULL; bad.local = NULL;   // optional fields may be absent
    assert(ht_supertab_lead_add(&t, &bad) && t.lead_n == 1);
    // Unknown state reads as done; `since` absent stays absent.
    assert(t.leads[0].state == HT_LEAD_DONE && t.leads[0].since_s < 0 && !t.leads[0].project[0]);
    bad = lead("L8", "thinking", 0); bad.since = 134;
    assert(ht_supertab_lead_add(&t, &bad) && t.leads[1].state == HT_LEAD_DONE && t.leads[1].since_s == 134);

    // A put for an id not in the last list is dropped; a list without a Swarm drops its record.
    frame(&t, "s3", 4, st, NULL);
    assert(ht_supertabs_put(&model, &t, 0, NULL, 0) == 0 && !ht_supertabs_find(&model, "s3"));
    const char one[1][ID_MAX] = {"s2"};
    ht_supertabs_ids(&model, one, 1, NULL, 0);
    assert(!ht_supertabs_find(&model, "s1") && ht_supertabs_find(&model, "s2") && model.n == 1);
    // 16 Swarms at most.
    char many[17][ID_MAX];
    for (int i = 0; i < 17; i++) snprintf(many[i], ID_MAX, "m%d", i);
    ht_supertabs_ids(&model, (const char (*)[ID_MAX])many, 17, NULL, 0);
    assert(model.id_n == HT_SUPERTABS_MAX && !ht_supertabs_find(&model, "s2"));
    puts("supertab: order (stable, frame order without it), caps, UTF-8 cut, ids, unknown state PASS");
}

static int events(const ht_lead_event_t *ev, int n, ht_lead_event_kind_t kind, const char *lead_id)
{
    int c = 0;
    for (int i = 0; i < n; i++) if (ev[i].kind == kind && !strcmp(ev[i].lead, lead_id) && !strcmp(ev[i].tab, "s1")) c++;
    return c;
}

static void transitions(void)
{
    static ht_supertab_t t;
    ht_lead_event_t ev[32];
    ht_supertabs_reset(&model);
    const char ids[1][ID_MAX] = {"s1"};
    ht_supertabs_ids(&model, ids, 1, NULL, 0);
    // First seen: ask raises, done/work do not.
    const char *a[3] = {"done", "ask", "work"};
    frame(&t, "s1", 3, a, NULL);
    int n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 1 && events(ev, n, HT_LEAD_RAISED_ASK, "L1") == 1);
    // DONE→ASK raises ask once; ASK→ASK raises nothing.
    const char *b[3] = {"ask", "ask", "work"};
    frame(&t, "s1", 3, b, NULL);
    n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 1 && events(ev, n, HT_LEAD_RAISED_ASK, "L0") == 1);
    n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 0);
    // ASK→STUCK raises stuck; STUCK→WORK clears.
    const char *c[3] = {"stuck", "ask", "work"};
    frame(&t, "s1", 3, c, NULL);
    n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 1 && events(ev, n, HT_LEAD_RAISED_STUCK, "L0") == 1);
    const char *d[3] = {"work", "ask", "work"};
    frame(&t, "s1", 3, d, NULL);
    n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 1 && events(ev, n, HT_LEAD_CLEARED, "L0") == 1);
    // A Lead gone from the frame clears (L1 was asking); a quiet Lead leaving says nothing.
    const char *e[1] = {"work"};
    frame(&t, "s1", 1, e, NULL);
    n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 1 && events(ev, n, HT_LEAD_CLEARED, "L1") == 1);
    // A Swarm leaving the list clears its asking Leads.
    frame(&t, "s1", 2, b, NULL);
    n = ht_supertabs_put(&model, &t, 0, ev, 32);
    assert(n == 2);
    n = ht_supertabs_ids(&model, ids, 0, ev, 32);
    assert(n == 2 && events(ev, n, HT_LEAD_CLEARED, "L0") == 1 && events(ev, n, HT_LEAD_CLEARED, "L1") == 1);
    // The event buffer is never overrun.
    ht_supertabs_ids(&model, ids, 1, NULL, 0);
    frame(&t, "s1", 2, b, NULL);
    assert(ht_supertabs_put(&model, &t, 0, ev, 1) == 1);
    // since is held with the dial clock at receipt.
    assert(ht_supertab_init(&t, "s1", "", "s1", 1));
    ht_lead_in_t w = lead("L0", "work", 0); w.since = 134;
    assert(ht_supertab_lead_add(&t, &w));
    ht_supertabs_put(&model, &t, 5000, NULL, 0);
    const ht_lead_t *l = &ht_supertabs_find(&model, "s1")->leads[0];
    assert(l->since_s == 134 && l->since_at_ms == 5000);
    puts("supertab: raise once, ask->stuck, clear on work/gone/swarm gone, bounded events PASS");
}

static void lookups_and_recap(void)
{
    static ht_supertab_t t;
    ht_supertabs_reset(&model);
    const char ids[2][ID_MAX] = {"s1", "s2"};
    ht_supertabs_ids(&model, ids, 2, NULL, 0);
    assert(ht_supertab_init(&t, "s1", "desk-7", "openharness", 2));
    ht_lead_in_t a = lead("L0", "work", 0); a.local = "h-local";
    ht_lead_in_t b = lead("L1", "work", 1);
    assert(ht_supertab_lead_add(&t, &a) && ht_supertab_lead_add(&t, &b));
    ht_supertabs_put(&model, &t, 0, NULL, 0);
    assert(ht_supertab_init(&t, "s2", "", "mobile", 0));
    ht_supertabs_put(&model, &t, 0, NULL, 0);
    assert(ht_supertabs_for_desk(&model, "desk-7") == ht_supertabs_find(&model, "s1"));
    assert(!ht_supertabs_for_desk(&model, "") && !ht_supertabs_for_desk(&model, "desk-8"));
    const ht_supertab_t *in = NULL;
    const ht_lead_t *l = ht_supertabs_lead_by_local(&model, "h-local", &in);
    assert(l && !strcmp(l->id, "L0") && in == ht_supertabs_find(&model, "s1"));
    assert(!ht_supertabs_lead_by_local(&model, "", &in) && !ht_supertabs_lead_by_local(&model, NULL, &in));
    // `at` walks the list order, skipping Swarms whose frame has not come.
    assert(ht_supertabs_at(&model, 0) == ht_supertabs_find(&model, "s1"));
    assert(ht_supertabs_at(&model, 1) == ht_supertabs_find(&model, "s2") && !ht_supertabs_at(&model, 2));

    // Recap: only the open Lead's text lands.
    ht_supertabs_recap_open(&model, "s1", "L0", 100);
    assert(model.recap.state == HT_RECAP_LOADING && model.recap.asked_ms == 100 && !model.recap.text[0]);
    assert(!ht_supertabs_recap_put(&model, "s1", "L1", "", "other", 1, false));
    assert(model.recap.state == HT_RECAP_LOADING && !model.recap.text[0]);
    char *big = malloc(1601); memset(big, 'r', 1599); strcpy(big + 1499, "\xe2\x80\xa6"); memset(big + 1502, 'r', 98); big[1600] = 0;
    assert(ht_supertabs_recap_put(&model, "s1", "L0", "", big, 1792560000u, false));
    assert(model.recap.state == HT_RECAP_LOADED && strlen(model.recap.text) == 1499 && model.recap.at == 1792560000u);
    free(big);
    ht_supertabs_recap_open(&model, "s1", "L1", 200);
    assert(model.recap.state == HT_RECAP_LOADING && !model.recap.text[0]);
    assert(ht_supertabs_recap_put(&model, "s1", "L1", "", "", 0, true) && model.recap.state == HT_RECAP_EMPTY);
    ht_supertabs_recap_open(&model, "", "", 300);
    assert(model.recap.state == HT_RECAP_NONE && !ht_supertabs_recap_put(&model, "", "", "", "x", 0, false));
    ht_supertabs_recap_open(&model, "s1", "L0", 400);
    ht_supertabs_reset(&model);
    assert(model.n == 0 && model.id_n == 0 && model.recap.state == HT_RECAP_NONE && !model.recap.lead[0]);
    puts("supertab: desk link, local Lead, list order, recap slot (one Lead, UTF-8 cut, none), reset PASS");
}

// The round dial's face follows the chat the desktop has open (design 2026-10-28-round-dial-swarm-chat).
static void chats(void)
{
    static ht_supertab_t t;
    ht_supertabs_reset(&model);
    const char ids[1][ID_MAX] = {"s1"};
    ht_supertabs_ids(&model, ids, 1, NULL, 0);
    assert(ht_supertab_init(&t, "s1", "", "openharness", 3));
    // lead keeps chat, chat_id, chat_name
    ht_lead_in_t g = lead("L0", "work", 0); g.chat = "group"; g.chat_id = "g1"; g.chat_name = "Fix login";
    ht_lead_in_t pm = lead("L1", "done", 1); pm.chat = "pm"; pm.chat_id = "pm1"; pm.chat_name = "PM";
    // a lead without chat fields reads as the Lead chat
    ht_lead_in_t old = lead("L2", "ask", 2);
    assert(ht_supertab_lead_add(&t, &g) && ht_supertab_lead_add(&t, &pm) && ht_supertab_lead_add(&t, &old));
    assert(t.leads[0].chat == HT_CHAT_GROUP && !strcmp(t.leads[0].chat_id, "g1") && !strcmp(t.leads[0].chat_name, "Fix login"));
    assert(t.leads[1].chat == HT_CHAT_PM && !strcmp(t.leads[1].chat_id, "pm1") && !strcmp(t.leads[1].chat_name, "PM"));
    assert(t.leads[2].chat == HT_CHAT_LEAD && !t.leads[2].chat_id[0] && !t.leads[2].chat_name[0]);
    // A long group name is cut to 48 bytes on a UTF-8 boundary; an unknown kind, or a chat id that cannot be held, is the
    // Lead chat with no id, and the Lead is kept.
    static ht_supertab_t u;
    assert(ht_supertab_init(&u, "s1", "", "openharness", 3));
    char name[64]; memset(name, 'n', 47); strcpy(name + 47, "\xc3\xa9tail");
    char longer[ID_MAX + 1]; memset(longer, 'x', ID_MAX); longer[ID_MAX] = 0;
    ht_lead_in_t cut = lead("L0", "work", 0); cut.chat = "group"; cut.chat_id = "g2"; cut.chat_name = name;
    ht_lead_in_t odd = lead("L1", "work", 1); odd.chat = "dm"; odd.chat_id = "c1"; odd.chat_name = "x";
    ht_lead_in_t wide = lead("L2", "work", 2); wide.chat = "group"; wide.chat_id = longer; wide.chat_name = "x";
    assert(ht_supertab_lead_add(&u, &cut) && ht_supertab_lead_add(&u, &odd) && ht_supertab_lead_add(&u, &wide));
    assert(strlen(u.leads[0].chat_name) == 47 && u.leads[0].chat == HT_CHAT_GROUP);
    assert(u.leads[1].chat == HT_CHAT_LEAD && !u.leads[1].chat_id[0] && !u.leads[1].chat_name[0]);
    assert(u.leads[2].chat == HT_CHAT_LEAD && !u.leads[2].chat_id[0]);
    ht_supertabs_put(&model, &t, 0, NULL, 0);

    // drops a recap for another chat: the face is the group's, so the Lead chat's recap (or none named) is not its.
    ht_supertabs_recap_open(&model, "s1", "L0", 100);
    assert(!ht_supertabs_recap_put(&model, "s1", "L0", "lead-web", "the Lead", 1, false));
    assert(!ht_supertabs_recap_put(&model, "s1", "L0", "", "no chat named", 1, false));
    assert(model.recap.state == HT_RECAP_LOADING && !model.recap.text[0]);
    assert(ht_supertabs_recap_put(&model, "s1", "L0", "g1", "Tests green.", 2, false));
    assert(model.recap.state == HT_RECAP_LOADED && !strcmp(model.recap.chat_id, "g1") && !strcmp(model.recap.text, "Tests green."));
    // An old daemon's Lead (no chat) takes the recap that names none, as before.
    ht_supertabs_recap_open(&model, "s1", "L2", 200);
    assert(ht_supertabs_recap_put(&model, "s1", "L2", "", "Shipped.", 3, false) && !model.recap.chat_id[0]);
    // Opening another Lead forgets the chat the last recap was for.
    ht_supertabs_recap_open(&model, "s1", "L1", 300);
    assert(!model.recap.chat_id[0]);
    puts("supertab: chat kind/id/name, old Leads as the Lead chat, recap only for the face's chat PASS");
}

int main(void)
{
    order_and_limits();
    transitions();
    lookups_and_recap();
    chats();
    return 0;
}
