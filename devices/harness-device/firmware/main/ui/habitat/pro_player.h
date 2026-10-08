#pragma once
#include <stdbool.h>
#include <stdint.h>

// Bounded, separate from the live footer: a recent action is not a busy state.
typedef struct {
    char action[192];
    uint32_t elapsed_seconds, observed_ms;
    bool has_elapsed, finished, failed;
} pro_player_state_t;

typedef struct {
    int harnesses, machines, models;
    uint32_t received_ms, valid_ms;
    bool received;
} pro_player_overview_t;

#define PRO_PLAYER_CONTEXTS 24
typedef struct {
    char id[48], machine[64], project[80], branch[96], engine[16];
    int remaining_bp; // Basis points; -1 means unavailable. Preserve a positive <1%.
    uint32_t received_ms, valid_ms, revision;
} pro_player_context_t;

static inline bool pro_player_elapsed(const pro_player_state_t *p, uint32_t now, uint32_t *seconds)
{
    if (!p->has_elapsed || (uint32_t)(now-p->observed_ms)>25000) return false;
    *seconds=p->elapsed_seconds+(uint32_t)(now-p->observed_ms)/1000;
    return true;
}
