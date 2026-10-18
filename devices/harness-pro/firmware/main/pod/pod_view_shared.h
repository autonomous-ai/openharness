#pragma once
// Helpers Pets' screens share (pod_shared.c). Internal to Pod's views.
#include "pod_view.h"
#include "pro_canvas.h"

enum { POD_ROW_MAX = HT_TEXT_BYTES };

static inline uint16_t pod_c(unsigned rgb) { return ht_rgb(rgb); }

// The agent the top frame names, or NULL when the model no longer has it.
const pod_agent_t *pod_view_agent_of(const pod_nav_t *, const pod_model_t *);
// Greedy word wrap of text into at most max_rows rows of at most width px. When text remains after the last
// row, that row holds the rest (ht_pro_text then ends it with an ellipsis). Returns the rows used.
int pod_wrap(const char *text, const ht_pro_font_t *, int width, int max_rows, char rows[][POD_ROW_MAX]);
