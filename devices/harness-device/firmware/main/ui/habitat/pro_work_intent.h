#pragma once
#include <stdbool.h>
#include <string.h>

// This is the host's existing slash-command contract (cli/src/lib/goalCommand.ts),
// not a promise that every engine can keep working or schedule a loop. Unknown
// engines stay on Task. Longer-lived instructions require host draft review.
enum { PRO_WORK_TASK, PRO_WORK_GOAL, PRO_WORK_LOOP };
static inline bool pro_work_supported(const char *engine, int mode, bool review)
{
    if (mode == PRO_WORK_TASK) return true;
    if (!review || !engine) return false;
    if (mode == PRO_WORK_GOAL) return !strcmp(engine, "claude") || !strcmp(engine, "codex");
    if (mode == PRO_WORK_LOOP) return !strcmp(engine, "claude");
    return false;
}
static inline const char *pro_work_label(int mode)
{
    return mode == PRO_WORK_GOAL ? "Goal" : mode == PRO_WORK_LOOP ? "Loop" : "Task";
}
// A_VOICE's values 2..7 already identify form/carry/question/draft/search capture.
// Preserve those meanings; 1 has always meant Goal in the shared dispatcher.
static inline int pro_work_voice_value(int mode)
{
    return mode == PRO_WORK_GOAL ? 1 : mode == PRO_WORK_LOOP ? 8 : 0;
}
static inline int pro_work_voice_mode(int value)
{
    return value == 1 ? PRO_WORK_GOAL : value == 8 ? PRO_WORK_LOOP : PRO_WORK_TASK;
}
