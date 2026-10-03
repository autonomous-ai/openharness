#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    const char *id, *agent, *selection;
    uint32_t request, revision;
    bool cancel;
} ht_carry_command_t;
typedef bool (*ht_carry_emit_t)(const ht_carry_command_t *, void *);
typedef struct {
    char id[48], source[96], excerpt[241], error[160];
    uint32_t serial, request, deadline;
    int rows;
    bool pending, active;
    ht_carry_emit_t emit;
    void *ctx;
} ht_carry_t;

void ht_carry_open(ht_carry_t *, const char *id, const char *agent, const char *selection,
                   uint32_t revision, uint32_t now, ht_carry_emit_t, void *ctx);
void ht_carry_close(ht_carry_t *);
bool ht_carry_reply(ht_carry_t *, const char *id, uint32_t request, bool ok,
                    const char *source, const char *excerpt, int rows, uint32_t ttl,
                    const char *error, uint32_t now);
bool ht_carry_tick(ht_carry_t *, uint32_t now);
