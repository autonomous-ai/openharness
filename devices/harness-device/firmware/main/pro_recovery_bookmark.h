#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

// Durable identity only: no transcript, current part or carried passage is stored.
// Fixed layout makes schema/length/checksum validation independent of UI structs.
typedef struct {
    uint32_t magic;
    uint8_t schema, mode, carried, reserved;
    uint32_t revision;
    char id[48], host[48], agent[48], name[96];
    uint32_t checksum;
} pro_recovery_bookmark_t;
_Static_assert(sizeof(pro_recovery_bookmark_t) == 256, "recovery bookmark wire size");
static inline uint32_t pro_recovery_checksum(const pro_recovery_bookmark_t *b)
{
    const uint8_t *bytes = (const uint8_t *)b;
    uint32_t sum = 2166136261u;
    for (size_t i = 0; i < offsetof(pro_recovery_bookmark_t, checksum); i++) sum = (sum ^ bytes[i]) * 16777619u;
    return sum;
}
static inline bool pro_recovery_bookmark_valid(const pro_recovery_bookmark_t *b)
{
    return b && b->magic == 0x48524431u && b->schema == 1 && b->mode <= 2 && b->carried <= 1 && !b->reserved &&
        b->revision > 0 && b->revision <= INT32_MAX && b->id[0] && memchr(b->id, 0, sizeof b->id) &&
        b->host[0] && memchr(b->host, 0, sizeof b->host) && b->agent[0] && memchr(b->agent, 0, sizeof b->agent) &&
        memchr(b->name, 0, sizeof b->name) && b->checksum == pro_recovery_checksum(b);
}
