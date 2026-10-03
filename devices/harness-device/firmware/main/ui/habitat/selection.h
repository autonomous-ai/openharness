#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { HT_SELECT_BEGIN, HT_SELECT_STEP, HT_SELECT_EXTEND, HT_SELECT_LINE, HT_SELECT_CANCEL, HT_SELECT_MATCH, HT_SELECT_LINES } ht_select_op_t;
typedef struct {
    ht_select_op_t op;
    const char *id, *agent;
    uint32_t request, revision;
    int delta;
} ht_select_command_t;
typedef bool (*ht_select_emit_t)(const ht_select_command_t *, void *);

typedef struct {
    char id[48], agent[48], excerpt[241], error[160], query[121];
    bool active, pending, extending, announced;
    uint32_t serial, request, revision, deadline;
    int rows, queued, remainder, match, matches;
    ht_select_emit_t emit;
    void *ctx;
} ht_selection_t;

void ht_selection_open(ht_selection_t *, const char *id, const char *agent, uint32_t now,
                       ht_select_emit_t, void *ctx);
void ht_selection_close(ht_selection_t *);
void ht_selection_move(ht_selection_t *, int pixels, uint32_t now);
void ht_selection_extend(ht_selection_t *, uint32_t now);
bool ht_selection_reply(ht_selection_t *, uint32_t request, const char *id, bool ok,
                        uint32_t revision, const char *excerpt, int rows, bool extending,
                        const char *error, uint32_t now);
bool ht_selection_tick(ht_selection_t *, uint32_t now);
bool ht_selection_ready(const ht_selection_t *);

// Extended replies apply search mode before draining queued finger travel.
bool ht_selection_reply_search(ht_selection_t *, uint32_t request, const char *id, bool ok,
                        uint32_t revision, const char *excerpt, int rows, bool extending,
                        const char *error, const char *query, int match, int matches, uint32_t now);
// A spoken search advances the selection once, outside the gesture request queue.
bool ht_selection_found(ht_selection_t *, const char *id, const char *agent,
                        uint32_t revision, const char *excerpt, int rows,
                        const char *query, int match, int matches);
