#pragma once
#include "carry.h"
#include "draft.h"
#include <stdio.h>
#include <string.h>

// The host owns the complete immutable quote. This local disclosure is only
// its bounded preview, pinned to one recipient and then one reviewed draft.
typedef struct {
    char id[48], agent[48], name[96], source[96], excerpt[241], draft[48];
    int rows, draft_offset;
    uint32_t preview_revision;
    bool detached;
} pro_carry_review_t;

static inline void pro_carry_review_begin(pro_carry_review_t *r, const ht_carry_t *tray,
                                         const char *agent, const char *name)
{
    memset(r, 0, sizeof *r);
    snprintf(r->id, sizeof r->id, "%s", tray->id);
    snprintf(r->agent, sizeof r->agent, "%s", agent);
    snprintf(r->name, sizeof r->name, "%s", name);
    snprintf(r->source, sizeof r->source, "%s", tray->source);
    snprintf(r->excerpt, sizeof r->excerpt, "%s", tray->excerpt);
    r->rows = tray->rows;
}

static inline bool pro_carry_review_owns(const pro_carry_review_t *r, const ht_draft_page_t *p)
{
    return r->id[0] && r->draft[0] && p->active &&
        !strcmp(r->draft, p->id) && !strcmp(r->agent, p->agent);
}
