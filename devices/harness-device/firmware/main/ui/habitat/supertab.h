// The Swarms (Super Tabs) and their Leads, as the daemon's `supertabs`/`supertab` frames describe them.
// Pure: no LVGL and no cJSON. cable_client.c parses a frame into an ht_supertab_t with the two builders
// below and the UI keeps the result here.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifndef ID_MAX
#define ID_MAX 48   // the same value as cable_client.h, which a pure module cannot include
#endif

enum { HT_SUPERTABS_MAX = 16, HT_SUPERTAB_LEADS_MAX = 12, HT_SUPERTAB_NAME = 49, HT_SUPERTAB_TEXT = 1501 };
typedef enum { HT_LEAD_DONE, HT_LEAD_WORK, HT_LEAD_ASK, HT_LEAD_STUCK } ht_lead_state_t;
// The chat on a Lead's face (design 2026-10-28-round-dial-swarm-chat): its project's Lead conversation, the reader's Chat
// with PM, a group, or the reader's own Buddy chat (spec 2026-10-29-round-dial-pm-buddy, a swarmBuddy daemon only). A
// daemon without `swarmChat` sends none, which reads as the Lead chat with no id.
typedef enum { HT_CHAT_LEAD, HT_CHAT_PM, HT_CHAT_GROUP, HT_CHAT_BUDDY } ht_chat_kind_t;
typedef struct {
    char id[ID_MAX], project_id[ID_MAX], project[HT_SUPERTAB_NAME], engine[12], owner[HT_SUPERTAB_NAME], local[ID_MAX];
    ht_lead_state_t state;
    int order;                  // -1 from a daemon that does not send it
    int32_t since_s;            // -1 when the daemon sent none (a remote Lead)
    uint32_t since_at_ms;       // the dial's clock when since_s arrived
    ht_chat_kind_t chat;
    char chat_id[ID_MAX], chat_name[HT_SUPERTAB_NAME];   // "" from a daemon without swarmChat
    // The Swarm has Buddies on, and the reader's own Buddy in this project: its chat, name, engine, the 15 half bits of
    // Desktop's avatar pattern (bit i = half cell i) and its colour 0xRRGGBB. `live` false while the Buddy is down.
    bool buddies;
    struct { bool has, live; char chat_id[ID_MAX], name[HT_SUPERTAB_NAME], engine[16]; uint16_t cells; uint32_t color; } buddy;
} ht_lead_t;
// The side a swarmBuddy daemon says the Swarm is on (its cards' side, which the dial follows); NONE from an older daemon.
typedef enum { HT_SIDE_NONE, HT_SIDE_PM, HT_SIDE_BUDDY } ht_side_t;
typedef struct {
    char id[ID_MAX], tab[ID_MAX], name[HT_SUPERTAB_NAME];
    uint16_t count;             // the Swarm's real project count; at most 12 Leads come
    ht_side_t side;
    uint8_t lead_n;
    ht_lead_t leads[HT_SUPERTAB_LEADS_MAX];
} ht_supertab_t;
typedef enum { HT_RECAP_NONE, HT_RECAP_LOADING, HT_RECAP_LOADED, HT_RECAP_EMPTY } ht_recap_state_t;
typedef struct {
    ht_supertab_t tabs[HT_SUPERTABS_MAX];   // the records that have arrived, in arrival order
    int n;
    char ids[HT_SUPERTABS_MAX][ID_MAX];     // the last `supertabs` list: the order Swarms are shown in
    int id_n;
    // One slot: the recap of the Lead on the face, and nothing else.
    // `chat_id`: the chat the text is the last message of ("" from a daemon without swarmChat).
    struct { char tab[ID_MAX], lead[ID_MAX], chat_id[ID_MAX], text[HT_SUPERTAB_TEXT]; uint32_t at, asked_ms; ht_recap_state_t state; } recap;
} ht_supertabs_t;
typedef enum { HT_LEAD_RAISED_ASK, HT_LEAD_RAISED_STUCK, HT_LEAD_CLEARED } ht_lead_event_kind_t;
typedef struct { ht_lead_event_kind_t kind; char tab[ID_MAX], lead[ID_MAX]; } ht_lead_event_t;

// One Lead of a frame, as read off the wire. NULL strings are absent fields.
// `color` is "#rrggbb"; a block that does not read (no chat id, a bad colour, cells past 15 bits) is dropped, not the Lead.
typedef struct { bool present, live; const char *chat_id, *name, *engine, *color; long cells; } ht_buddy_in_t;
typedef struct { const char *id, *project_id, *project, *engine, *owner, *local, *state; int order; long since; const char *chat, *chat_id, *chat_name;
                 bool buddies; ht_buddy_in_t buddy; } ht_lead_in_t;
// false: an empty or overlong id or tab. Names are cut on a UTF-8 boundary.
bool ht_supertab_init(ht_supertab_t *, const char *id, const char *tab, const char *name, int count);
// false: the Lead is malformed or repeats an id (skipped, not the frame), or the record already holds 12.
bool ht_supertab_lead_add(ht_supertab_t *, const ht_lead_in_t *);

void ht_supertabs_reset(ht_supertabs_t *);
// Drops records gone from the list; their asking Leads come back as CLEARED events. Returns the event count.
int  ht_supertabs_ids(ht_supertabs_t *, const char ids[][ID_MAX], int n, ht_lead_event_t *ev, int ev_max);
// Sorts the Leads by order (stable, so frame order without it) and returns the transition events:
// a Lead entering ask or stuck (also when first seen), and an asking Lead leaving ask/stuck or the frame.
int  ht_supertabs_put(ht_supertabs_t *, const ht_supertab_t *in, uint32_t now_ms, ht_lead_event_t *ev, int ev_max);
const ht_supertab_t *ht_supertabs_find(const ht_supertabs_t *, const char *id);
// The i-th Swarm of the list whose record has arrived.
const ht_supertab_t *ht_supertabs_at(const ht_supertabs_t *, int i);
const ht_supertab_t *ht_supertabs_for_desk(const ht_supertabs_t *, const char *desk_tab_id);
const ht_lead_t *ht_supertabs_lead_by_local(const ht_supertabs_t *, const char *harness_id, const ht_supertab_t **tab);
// LOADING with no text; an empty lead closes the slot (NONE).
void ht_supertabs_recap_open(ht_supertabs_t *, const char *tab, const char *lead, uint32_t now_ms);
// false: not the open Lead, or not the chat on its face (`chat_id` "" is the Lead's own, from a daemon without swarmChat).
bool ht_supertabs_recap_put(ht_supertabs_t *, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none);
