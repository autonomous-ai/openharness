// What Demo V2's pages read from the model: App Detail's cells on the glass and an open agent's window, Inbox's unread
// count, the shown app's name, and what the bar may do with an agent (its caps). Pure reads of max_m.
#include <string.h>

#include "max_ui_internal.h"

int max_row_last(void)
{
    int row[MAX_AGENTS];
    const int last = max_row(row) - MAX_CELLS;
    return last > 0 ? last : 0;
}

int max_cells(int out[MAX_CELLS])
{
    int row[MAX_AGENTS], k = 0;
    const int n = max_row(row), last = max_row_last();
    const int first = max_m.row_first < 0 ? 0 : max_m.row_first > last ? last : max_m.row_first;
    for (int i = first; i < n && k < MAX_CELLS; i++) out[k++] = row[i];
    return k;
}

int max_open_first(int i, int n)
{
    const int last = n - MAX_CELLS > 0 ? n - MAX_CELLS : 0;
    return i - 1 < 0 ? 0 : i - 1 > last ? last : i - 1;
}

const char *max_summary(const max_agent_t *a)
{
    if (a->state == MAX_WORKING) return a->activity[0] ? a->activity : a->step_count ? a->steps[0] : "";
    return a->state == MAX_ASKING ? a->question : a->note;
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
