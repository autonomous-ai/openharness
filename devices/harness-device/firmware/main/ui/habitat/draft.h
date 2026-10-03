#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { HT_DRAFT_STATE, HT_DRAFT_MOVE, HT_DRAFT_UNDO, HT_DRAFT_DISCARD, HT_DRAFT_SEND } ht_draft_op_t;
typedef struct {
    char id[48], agent[48], name[96], context[96], text[512], error[128];
    uint32_t revision;
    int position, total;
    bool active, locked, can_undo, can_send;
} ht_draft_page_t;
typedef struct {
    const char *id;
    uint32_t request, revision;
    ht_draft_op_t op;
    int delta;
} ht_draft_command_t;
typedef bool (*ht_draft_emit_t)(const ht_draft_command_t *, void *);
typedef struct {
    ht_draft_page_t page;
    uint32_t serial, request, deadline;
    bool pending, failed;
    ht_draft_op_t op;
    int delta;
    ht_draft_emit_t emit;
    void *ctx;
} ht_draft_t;
void ht_draft_reset(ht_draft_t *);
void ht_draft_open(ht_draft_t *, const ht_draft_page_t *, ht_draft_emit_t, void *);
bool ht_draft_command(ht_draft_t *, ht_draft_op_t, uint32_t revision, int delta, uint32_t now);
bool ht_draft_reply(ht_draft_t *, const char *id, uint32_t request, bool ok, const ht_draft_page_t *);
bool ht_draft_tick(ht_draft_t *, uint32_t now);
