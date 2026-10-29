#include "supertab.h"
#include <stdio.h>
#include <string.h>

// Copies at most size-1 bytes and never splits a UTF-8 sequence.
static void put_text(char *dst, size_t size, const char *src)
{
    size_t n = src ? strlen(src) : 0;
    if (n >= size) {
        n = size - 1;
        while (n && ((unsigned char)src[n] & 0xC0) == 0x80) n--;
    }
    if (n) memcpy(dst, src, n);
    dst[n] = 0;
}
static bool put_id(char *dst, const char *src, bool required)
{
    size_t n = src ? strlen(src) : 0;
    if (n >= ID_MAX || (required && !n)) return false;
    put_text(dst, ID_MAX, src);
    return true;
}
static bool asking(ht_lead_state_t s)
{
    return s == HT_LEAD_ASK || s == HT_LEAD_STUCK;
}
static int emit(ht_lead_event_t *ev, int ev_max, int n, ht_lead_event_kind_t kind, const char *tab, const char *lead)
{
    if (!ev || n >= ev_max) return n;
    ev[n].kind = kind;
    snprintf(ev[n].tab, sizeof ev[n].tab, "%s", tab);
    snprintf(ev[n].lead, sizeof ev[n].lead, "%s", lead);
    return n + 1;
}

bool ht_supertab_init(ht_supertab_t *t, const char *id, const char *tab, const char *name, int count)
{
    memset(t, 0, sizeof *t);
    if (!put_id(t->id, id, true) || !put_id(t->tab, tab, false)) return false;
    put_text(t->name, sizeof t->name, name);
    t->count = count < 0 ? 0 : count > UINT16_MAX ? UINT16_MAX : (uint16_t)count;
    return true;
}
bool ht_supertab_lead_add(ht_supertab_t *t, const ht_lead_in_t *in)
{
    if (t->lead_n >= HT_SUPERTAB_LEADS_MAX) return false;
    for (int i = 0; in->id && i < t->lead_n; i++) if (!strcmp(t->leads[i].id, in->id)) return false;   // a repeated id
    ht_lead_t *l = &t->leads[t->lead_n];
    memset(l, 0, sizeof *l);
    if (!put_id(l->id, in->id, true) || !put_id(l->project_id, in->project_id, false) ||
        !put_id(l->local, in->local, false)) return false;
    put_text(l->project, sizeof l->project, in->project);
    put_text(l->engine, sizeof l->engine, in->engine);
    put_text(l->owner, sizeof l->owner, in->owner);
    const char *s = in->state ? in->state : "";
    l->state = !strcmp(s, "ask") ? HT_LEAD_ASK : !strcmp(s, "stuck") ? HT_LEAD_STUCK :
               !strcmp(s, "work") ? HT_LEAD_WORK : HT_LEAD_DONE;
    l->order = in->order < 0 ? -1 : in->order;
    l->since_s = in->since < 0 ? -1 : in->since > INT32_MAX ? INT32_MAX : (int32_t)in->since;
    // The chat on the face. One this dial cannot name (an unknown kind, an id it cannot hold) is the Lead chat with no
    // id: the Lead stays, and no chat's recap is taken for it.
    const char *c = in->chat ? in->chat : "";
    l->chat = !strcmp(c, "group") ? HT_CHAT_GROUP : !strcmp(c, "pm") ? HT_CHAT_PM : HT_CHAT_LEAD;
    bool named = (!strcmp(c, "group") || !strcmp(c, "pm") || !strcmp(c, "lead")) && put_id(l->chat_id, in->chat_id, true);
    if (named) put_text(l->chat_name, sizeof l->chat_name, in->chat_name);
    else { l->chat = HT_CHAT_LEAD; l->chat_id[0] = 0; l->chat_name[0] = 0; }
    t->lead_n++;
    return true;
}

void ht_supertabs_reset(ht_supertabs_t *s)
{
    memset(s, 0, sizeof *s);
}
const ht_supertab_t *ht_supertabs_find(const ht_supertabs_t *s, const char *id)
{
    if (!id || !*id) return NULL;
    for (int i = 0; i < s->n; i++) if (!strcmp(s->tabs[i].id, id)) return &s->tabs[i];
    return NULL;
}
const ht_supertab_t *ht_supertabs_at(const ht_supertabs_t *s, int i)
{
    for (int k = 0; k < s->id_n; k++) {
        const ht_supertab_t *t = ht_supertabs_find(s, s->ids[k]);
        if (t && i-- == 0) return t;
    }
    return NULL;
}
const ht_supertab_t *ht_supertabs_for_desk(const ht_supertabs_t *s, const char *desk_tab_id)
{
    if (!desk_tab_id || !*desk_tab_id) return NULL;
    for (int i = 0; i < s->n; i++) if (!strcmp(s->tabs[i].tab, desk_tab_id)) return &s->tabs[i];
    return NULL;
}
const ht_lead_t *ht_supertabs_lead_by_local(const ht_supertabs_t *s, const char *harness_id, const ht_supertab_t **tab)
{
    if (!harness_id || !*harness_id) return NULL;
    for (int i = 0; i < s->n; i++) for (int k = 0; k < s->tabs[i].lead_n; k++)
        if (!strcmp(s->tabs[i].leads[k].local, harness_id)) {
            if (tab) *tab = &s->tabs[i];
            return &s->tabs[i].leads[k];
        }
    return NULL;
}

int ht_supertabs_ids(ht_supertabs_t *s, const char ids[][ID_MAX], int n, ht_lead_event_t *ev, int ev_max)
{
    s->id_n = 0;
    for (int i = 0; i < n && s->id_n < HT_SUPERTABS_MAX; i++)
        if (ids[i][0] && memchr(ids[i], 0, ID_MAX)) snprintf(s->ids[s->id_n++], ID_MAX, "%s", ids[i]);
    int events = 0, kept = 0;
    for (int i = 0; i < s->n; i++) {
        bool listed = false;
        for (int k = 0; k < s->id_n && !listed; k++) listed = !strcmp(s->ids[k], s->tabs[i].id);
        if (listed) {
            if (kept != i) s->tabs[kept] = s->tabs[i];
            kept++;
            continue;
        }
        for (int k = 0; k < s->tabs[i].lead_n; k++)
            if (asking(s->tabs[i].leads[k].state))
                events = emit(ev, ev_max, events, HT_LEAD_CLEARED, s->tabs[i].id, s->tabs[i].leads[k].id);
    }
    s->n = kept;
    return events;
}

int ht_supertabs_put(ht_supertabs_t *s, const ht_supertab_t *in, uint32_t now_ms, ht_lead_event_t *ev, int ev_max)
{
    bool listed = false;
    for (int k = 0; k < s->id_n && !listed; k++) listed = !strcmp(s->ids[k], in->id);
    if (!listed) return 0;
    ht_supertab_t *t = (ht_supertab_t *)ht_supertabs_find(s, in->id);
    if (!t) {
        if (s->n >= HT_SUPERTABS_MAX) return 0;
        t = &s->tabs[s->n++];
        t->lead_n = 0;
    }
    int events = 0;
    for (int i = 0; i < in->lead_n; i++) {
        const ht_lead_t *was = NULL;
        for (int k = 0; k < t->lead_n && !was; k++) if (!strcmp(t->leads[k].id, in->leads[i].id)) was = &t->leads[k];
        ht_lead_state_t now = in->leads[i].state;
        if (asking(now) && (!was || was->state != now))
            events = emit(ev, ev_max, events, now == HT_LEAD_ASK ? HT_LEAD_RAISED_ASK : HT_LEAD_RAISED_STUCK, in->id, in->leads[i].id);
        else if (!asking(now) && was && asking(was->state))
            events = emit(ev, ev_max, events, HT_LEAD_CLEARED, in->id, in->leads[i].id);
    }
    for (int k = 0; k < t->lead_n; k++) {
        if (!asking(t->leads[k].state)) continue;
        bool kept = false;
        for (int i = 0; i < in->lead_n && !kept; i++) kept = !strcmp(t->leads[k].id, in->leads[i].id);
        if (!kept) events = emit(ev, ev_max, events, HT_LEAD_CLEARED, in->id, t->leads[k].id);
    }
    *t = *in;
    if (t->lead_n > HT_SUPERTAB_LEADS_MAX) t->lead_n = HT_SUPERTAB_LEADS_MAX;
    // Insertion sort: stable, so equal (or absent) orders keep the frame's order.
    for (int i = 1; i < t->lead_n; i++) {
        ht_lead_t l = t->leads[i];
        int k = i;
        for (; k > 0 && t->leads[k - 1].order > l.order; k--) t->leads[k] = t->leads[k - 1];
        t->leads[k] = l;
    }
    for (int i = 0; i < t->lead_n; i++) t->leads[i].since_at_ms = now_ms;
    return events;
}

void ht_supertabs_recap_open(ht_supertabs_t *s, const char *tab, const char *lead, uint32_t now_ms)
{
    bool open = lead && *lead && tab && *tab;
    // The Lead already on the face keeps what it shows until a new recap replaces it: emptying it left the resting pet
    // for the 5 s retry on every reopen (Diego, 2026-10-29). Only while the face's chat is still the one it was for.
    // A kept recap is not LOADING, so its refresh has no 5 s retry: one lost on the way waits for the next push.
    if (open && (s->recap.state == HT_RECAP_LOADED || s->recap.state == HT_RECAP_EMPTY) && !strcmp(s->recap.tab, tab) && !strcmp(s->recap.lead, lead)) {
        const ht_supertab_t *t = ht_supertabs_find(s, tab);
        for (int i = 0; t && i < t->lead_n; i++)
            if (!strcmp(t->leads[i].id, lead) && !strcmp(t->leads[i].chat_id, s->recap.chat_id)) {
                s->recap.asked_ms = now_ms;
                return;
            }
    }
    put_text(s->recap.tab, sizeof s->recap.tab, open ? tab : "");
    put_text(s->recap.lead, sizeof s->recap.lead, open ? lead : "");
    s->recap.chat_id[0] = 0;
    s->recap.text[0] = 0;
    s->recap.at = 0;
    s->recap.asked_ms = now_ms;
    s->recap.state = open ? HT_RECAP_LOADING : HT_RECAP_NONE;
}
bool ht_supertabs_recap_put(ht_supertabs_t *s, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none)
{
    if (s->recap.state == HT_RECAP_NONE || !tab || !lead || strcmp(s->recap.tab, tab) || strcmp(s->recap.lead, lead))
        return false;
    // A recap for another chat than the one on the face (the desktop moved on while it was read) is not this face's.
    const ht_supertab_t *t = ht_supertabs_find(s, tab);
    const char *face = "";
    for (int i = 0; t && i < t->lead_n; i++) if (!strcmp(t->leads[i].id, lead)) face = t->leads[i].chat_id;
    if (strcmp(chat_id ? chat_id : "", face)) return false;
    put_text(s->recap.chat_id, sizeof s->recap.chat_id, face);
    put_text(s->recap.text, sizeof s->recap.text, none ? "" : text);
    s->recap.at = at;
    s->recap.state = s->recap.text[0] ? HT_RECAP_LOADED : HT_RECAP_EMPTY;
    return true;
}
