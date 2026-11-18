// What Demo V2's pages read from the model: Overview's cells and their pages, the agent page's strip, Inbox's unread
// count, the shown app's name, and what the bar may do with an agent (its caps). Pure reads of max_m.
#include <string.h>

#include "max_ui_internal.h"

int max_cell_pages(void) { return (max_m.count + MAX_CELLS - 1) / MAX_CELLS; }

int max_cells(int out[MAX_CELLS])
{
    int k = 0;
    for (int i = max_m.cell_page * MAX_CELLS; i < max_m.count && k < MAX_CELLS; i++) out[k++] = i;
    return k;
}

bool max_page_waits(int page)
{
    for (int i = page * MAX_CELLS; i >= 0 && i < max_m.count && i < (page + 1) * MAX_CELLS; i++)
        if (max_m.agents[i].state == MAX_ASKING) return true;
    return false;
}

// The window keeps the selected agent in it, as near its middle as the roster's ends allow, so the strip shifts by one
// as the person browses rather than jumping a page.
int max_segs(int out[MAX_SEGS])
{
    const max_agent_t *sel = max_find(max_m.selected);
    const int at = sel ? (int)(sel - max_m.agents) : 0;
    int from = at - MAX_SEGS / 2;
    if (from > max_m.count - MAX_SEGS) from = max_m.count - MAX_SEGS;
    if (from < 0) from = 0;
    int k = 0;
    for (int i = from; i < max_m.count && k < MAX_SEGS; i++) out[k++] = i;
    return k;
}

int max_unread(void)
{
    int n = 0;
    for (int i = 0; i < max_m.inbox_count; i++) n += max_m.inbox[i].unread;
    return n;
}

const max_app_t *max_shown_app(void)
{
    for (int i = 0; max_m.shown[0] && i < max_m.app_count; i++)
        if (!strcmp(max_m.apps[i].id, max_m.shown)) return &max_m.apps[i];
    return NULL;
}

const char *max_app_label(void)
{
    const max_app_t *app = max_shown_app();
    if (app && app->name[0]) return app->name;
    return max_m.computer[0] ? max_m.computer : "Harness";
}

const char *max_app_of(const max_agent_t *a)
{
    const max_app_t *app = max_shown_app();
    if (app && app->name[0]) return app->name;
    return a ? a->host : "";
}

bool max_takes_answers(const max_agent_t *a)
{
    if (!a || !(a->caps & MAX_CAP_ANSWER)) return false;
    const max_ask_t *k = max_ask_of(a->id);
    return k && (k->path == MAX_PATH_PLAIN || k->path == MAX_PATH_REVIEWED);
}

bool max_takes_voice(const max_agent_t *a) { return a && (a->caps & MAX_CAP_VOICE); }

const char *max_status_word(const max_agent_t *a)
{
    switch (a->state) {
    case MAX_ASKING: return "Needs you";
    case MAX_WORKING: return a->verb[0] ? a->verb : "Working";
    case MAX_DONE: return "Done";
    case MAX_FAILED: return "Failed";
    default: return "Resting";
    }
}

uint8_t max_caps_of(const char *letters)
{
    if (!letters) return MAX_CAPS_ALL;
    uint8_t caps = 0;
    if (strchr(letters, 'v')) caps |= MAX_CAP_VOICE;
    if (strchr(letters, 'f')) caps |= MAX_CAP_FOCUS;
    if (strchr(letters, 'a')) caps |= MAX_CAP_ANSWER;
    return caps;
}
