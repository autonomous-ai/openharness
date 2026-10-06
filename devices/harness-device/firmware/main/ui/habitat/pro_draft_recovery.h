#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "../../pro_recovery_bookmark.h"

typedef enum { PRO_RECOVERY_NONE, PRO_RECOVERY_SAVING, PRO_RECOVERY_SAVED, PRO_RECOVERY_SAVE_FAILED,
               PRO_RECOVERY_CLEARING, PRO_RECOVERY_CLEAR_FAILED } pro_recovery_store_t;

// Only the visible draft part lives on the device. Full words remain in the
// host's bounded archive; recovering them never restores submission authority.
typedef struct {
    char current_host[48], original_host[48], recipient[48];
    uint32_t generation, capture_generation, request_generation, bookmark_generation;
    uint8_t mode;
    bool ready, has_words, carried;
    pro_recovery_store_t store;
} pro_draft_recovery_t;

static inline void pro_draft_recovery_advance(pro_draft_recovery_t *r)
{
    if (!++r->generation) ++r->generation;
    r->ready = false;
}
static inline bool pro_draft_recovery_source(pro_draft_recovery_t *r, const char *host)
{
    bool valid = host && host[0] && strlen(host) < sizeof r->current_host;
    const char *next = valid ? host : "";
    if (!strcmp(r->current_host, next)) return false;
    snprintf(r->current_host, sizeof r->current_host, "%s", next);
    pro_draft_recovery_advance(r);
    return true;
}
static inline void pro_draft_recovery_disconnect(pro_draft_recovery_t *r)
{
    r->current_host[0] = 0;
    pro_draft_recovery_advance(r);
}
static inline void pro_draft_recovery_pin(pro_draft_recovery_t *r, const char *agent, uint8_t mode)
{
    snprintf(r->original_host, sizeof r->original_host, "%s", r->current_host);
    snprintf(r->recipient, sizeof r->recipient, "%s", agent ? agent : "");
    r->capture_generation = r->generation;
    r->request_generation = 0; r->mode = mode; r->ready = false; r->has_words = false; r->carried = false;
}
static inline bool pro_draft_recovery_same_host(const pro_draft_recovery_t *r)
{
    return r->original_host[0] && r->current_host[0] && !strcmp(r->original_host, r->current_host);
}
static inline void pro_draft_recovery_close(pro_draft_recovery_t *r)
{
    r->original_host[0] = r->recipient[0] = 0;
    r->capture_generation = r->request_generation = 0; r->mode = 0;
    r->has_words = r->carried = false; r->store = PRO_RECOVERY_NONE;
    pro_draft_recovery_advance(r);
}
