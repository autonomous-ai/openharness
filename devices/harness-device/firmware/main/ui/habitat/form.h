#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { HT_FORM_OPEN, HT_FORM_STATE, HT_FORM_MOVE, HT_FORM_ACTIVATE, HT_FORM_BACK, HT_FORM_CLOSE } ht_form_op_t;
typedef struct {
    char title[80], label[160], detail[384], previous[96], next[96];
    char error[180], status[96], action[32];
    uint32_t revision;
    int position, total;
    bool active, busy, enabled, can_query;
    char query[96];
} ht_form_page_t;
typedef struct {
    ht_form_op_t op;
    const char *id;
    uint32_t request, revision;
    int delta;
} ht_form_command_t;
typedef bool (*ht_form_emit_t)(const ht_form_command_t *, void *);
typedef struct {
    char id[48];
    ht_form_page_t page;
    uint32_t serial, request, deadline, poll;
    int queued, remainder;
    bool pending, failed;
    ht_form_op_t pending_op;
    ht_form_emit_t emit;
    void *ctx;
} ht_form_t;

void ht_form_reset(ht_form_t *);
// Leave locally even if the desktop never replied; late replies cannot reopen it.
// Returns whether the best-effort close could be queued.
bool ht_form_dismiss(ht_form_t *);
bool ht_form_open(ht_form_t *, const char *id, uint32_t now, ht_form_emit_t, void *);
bool ht_form_command(ht_form_t *, ht_form_op_t, uint32_t revision, int delta, uint32_t now);
void ht_form_move(ht_form_t *, int pixels, uint32_t now);
bool ht_form_reply(ht_form_t *, const char *id, uint32_t request, bool ok, const ht_form_page_t *, uint32_t now);
bool ht_form_tick(ht_form_t *, uint32_t now);
