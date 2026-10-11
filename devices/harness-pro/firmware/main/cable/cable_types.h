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
 * ONE TILE OF THE SELECTED TAB'S GRID, exactly where the window put it: a unit rectangle in THOUSANDTHS of the
 * grid. `agent_id` is empty for a tile this device cannot drive (a shell, a viewer); it still holds its place.
 * Relayed, never derived. An empty list means a daemon or window too old to send one.
 */
#define SWARM_TILES_MAX 24   // the window's own ceiling, same as the rows above
typedef struct {
    int16_t x1, y1, x2, y2;   // 0..1000
    char    agent_id[ID_MAX];
} cable_tile_t;
