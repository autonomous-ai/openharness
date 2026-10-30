// The shapes the Pro's tab list and pane grid are built from: the vocabulary of the cable protocol's `swarms`
// frame. They live apart from the cable client so that Pod's pure-C model can use them without ESP-IDF.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define ID_MAX   48   // agentId (uuid or 32-hex) + nul
#define CABLE_NAME_MAX 40

// The window's swarms: named groups of agents (tabs), one of them on screen. The daemon relays the whole list
// in one `swarms` frame whenever it changes.
// A desk id is 32 HEX CHARACTERS (desktop desk_sync.dart `newDeskId`), so the cap is an agent id's, which already
// counts its NUL.
#define SWARM_ID_MAX ID_MAX
#define SWARMS_MAX   24   // the window's own ceiling (AppNotifier.maxSwarms)
typedef struct {
    char id[SWARM_ID_MAX];
    char name[CABLE_NAME_MAX];
    int  agents;          // how many agents it holds, drawn as a count
    // How many TILES it holds, of any kind: agents, shells, viewers. A tab with a terminal and no agent has
    // agents=0 and panes=1. A daemon too old to send it reports panes==agents.
    int  panes;
} cable_swarm_t;

/* What the daemon knows about a member (`members` on a `swarms` item): who it is and whether its machine is
 * online. meta[i][k] belongs to id[i][k]; has is false for a member the daemon described nothing about (and for
 * every member of an older daemon). */
typedef struct {
    char name[CABLE_NAME_MAX], engine[12], machine[CABLE_NAME_MAX];
    bool has, online;
} cable_swarm_member_meta_t;

/*
 * Which agents each tab holds, as the daemon lists them (`agentIds` on a `swarms` item, in the window's order).
 * count[i] belongs to the i-th row of the SAME frame, after the rows that were dropped for a missing or duplicate
 * id. An item without the field (an older daemon) has count 0. Ids that do not fit are dropped, as are ids past
 * SWARM_MEMBERS_MAX.
 */
#define SWARM_MEMBERS_MAX 24   // the window's own ceiling on panes in a tab (== SWARM_TILES_MAX)
typedef struct {
    uint8_t count[SWARMS_MAX];
    char id[SWARMS_MAX][SWARM_MEMBERS_MAX][ID_MAX];
    cable_swarm_member_meta_t meta[SWARMS_MAX][SWARM_MEMBERS_MAX];
} cable_swarm_members_t;

/*
 * How loud a finished turn is (the summary frame's `tier`): alert = beep, wake, toast and an entry in Notices; list = the
 * entry only; silent = nothing new (the pet and the card still update). A question and a failed turn are always alerts.
 */
typedef enum { POD_TIER_ALERT, POD_TIER_LIST, POD_TIER_SILENT } pod_tier_t;

/*
 * WHAT A SUPER TAB QUESTION ASKS FOR (the question frame's optional `attention`, sent with `superTab`, the shared
 * multi-agent project's name): decision = a human has to choose, stuck = the agent cannot go on. Both are alerts whose
 * toast stays until it is dismissed, answered or seen in Notices. NONE: a plain question (no `superTab`), as before.
 */
typedef enum { POD_ATTN_NONE, POD_ATTN_DECISION, POD_ATTN_STUCK } pod_attention_t;
#define SUPER_TAB_MAX 49   // the Super Tab's name: at most 48 bytes, NUL included here

/*
 * ONE TILE OF THE SELECTED TAB'S GRID, exactly where the window put it: a unit rectangle in THOUSANDTHS of the
 * grid. `agent_id` is empty for a tile this device cannot drive (a shell, a viewer); it still holds its place.
 * Relayed, never derived. An empty list means a daemon or window too old to send one.
 */
#define SWARM_TILES_MAX 24   // the window's own ceiling, same as the rows above
typedef struct {
    int16_t x1, y1, x2, y2;   // 0..1000
    char    agent_id[ID_MAX];
} cable_tile_t;

/*
 * THE SWARM CARDS (hello `swarmCard:"v1"`; the `supertabs` id list and one `supertab` frame per Swarm): the account's Swarms, each with its project Leads. A Swarm is
 * not the window's tab (cable_swarm_t above): it is the shared multi-agent project the Super Tab waits name, read from the
 * backend by the daemon. `tab` links it to the desk tab of the same Swarm ("" when the desktop has none open).
 */
enum { SWARMS_CARD_MAX = 16, SWARM_LEADS_MAX = 12, SWARM_TEXT_MAX = 1501 };   // text: 1,500 bytes + NUL
typedef enum { POD_LEAD_ASK, POD_LEAD_STUCK, POD_LEAD_WORK, POD_LEAD_DONE } pod_lead_state_t;   // needs you, stuck, working, done
typedef enum { POD_CHAT_NONE, POD_CHAT_LEAD, POD_CHAT_PM, POD_CHAT_GROUP, POD_CHAT_BUDDY } pod_chat_t;   // the chat the Lead's face shows
typedef enum { POD_RECAP_NONE, POD_RECAP_LOADING, POD_RECAP_LOADED, POD_RECAP_EMPTY } pod_recap_state_t;
typedef enum { POD_SIDE_NONE, POD_SIDE_PM, POD_SIDE_BUDDY } pod_side_t;   // the side of a Swarm the person looks at (NONE: the frame named none)
typedef struct {
    char chat_id[ID_MAX], name[49], engine[16];   // the reader's Buddy chat; name as project: 48 bytes + NUL, cut on a codepoint
    uint16_t cells;                      // the avatar's pattern, 15 bits (0..32767)
    uint32_t color;                      // 0xRRGGBB
    bool live;                           // the Buddy is answering now
} pod_buddy_t;
enum { POD_BUDDY_INK = 0xC49BFF };   // the lilac of a Buddy: its default colour, the pill's segment, the dot, its name
typedef struct {
    char id[ID_MAX], projectId[ID_MAX], project[49], engine[16], owner[49], local[ID_MAX];   // owner: another person's machine; local: the harness to talk to
    pod_lead_state_t state;
    uint32_t since_s, since_at_ms;       // seconds into the turn when the frame arrived (local Lead in a turn), and the device clock then
    pod_chat_t chat;                     // NONE: the frame named no chat (an older daemon): today's Lead view
    char chat_id[ID_MAX], chat_name[49]; // chat_name as project: 48 bytes + NUL, cut on a codepoint
    pod_recap_state_t recap;
    char *text;                          // the Lead's last message, PSRAM, owned by the model (NULL unless LOADED); the cable side leaves it NULL
    uint32_t text_at;                    // when it was written (epoch seconds)
    bool buddies;                        // the Lead has a Buddy side (JSON true only)
    bool has_buddy;                      // `buddy` is a usable block
    bool buddy_unread;                   // the Buddy spoke while the person was elsewhere; device-local, a frame never sets it
    pod_buddy_t buddy;
} pod_lead_t;
typedef struct {
    char id[ID_MAX], tab[ID_MAX], name[49];
    uint16_t count;                      // workspaces (projects that have a Lead)
    uint8_t lead_n;
    pod_side_t side;                     // the side the desktop shows for this Swarm
    pod_lead_t leads[SWARM_LEADS_MAX];   // in card order
} pod_swarm_t;
