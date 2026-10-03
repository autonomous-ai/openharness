#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { HT_VISIT_OPEN, HT_VISIT_BACK, HT_VISIT_CANCEL, HT_VISIT_LATEST } ht_visit_op_t;
typedef struct { ht_visit_op_t op; const char *id, *agent; uint32_t request; } ht_visit_command_t;
typedef bool (*ht_visit_emit_t)(const ht_visit_command_t *, void *);
typedef struct {
    char id[48], agent[64], label[80];
    uint32_t serial, request, deadline;
    bool pending, available;
    ht_visit_op_t op;
    ht_visit_emit_t emit;
    void *ctx;
} ht_visit_t;
bool ht_visit_open(ht_visit_t *, const char *id, const char *agent, uint32_t now, ht_visit_emit_t, void *);
bool ht_visit_latest(ht_visit_t *, const char *id, const char *agent, uint32_t now, ht_visit_emit_t, void *);
bool ht_visit_back(ht_visit_t *, uint32_t now);
void ht_visit_close(ht_visit_t *);
bool ht_visit_reply(ht_visit_t *, const char *id, uint32_t request, bool available, const char *label);
bool ht_visit_tick(ht_visit_t *, uint32_t now);
