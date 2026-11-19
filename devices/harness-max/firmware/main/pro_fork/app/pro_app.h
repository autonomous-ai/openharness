// Harness Max's stand-in for the Pro's app/pro_app.h. The Pro's touch task (app/pro_touch.c) and voice task
// (audio/pro_voice.c), compiled as they are, include "app/pro_app.h" for the finger, the screen's power and the notice
// line; main/pro_fork is first on every Max build's include path, so they read this header and not the Pro's, which
// brings in Pod. Only those declarations, as the Pro's pro_app.h has them; main/app/max_app.c implements them.
// pro_fork upstream: devices/harness-pro/firmware/main/app/pro_app.h
// pro_fork blob: ccb6c90166f97a12f324fc78bc8c20a0e44b35e0 (main 91f60b6a7b)
// scripts/check_pro_forks.py fails once the upstream file is no longer that blob: re-port its change here, then
// record its new blob on these lines and in main/pro_fork/upstream.txt.
// Every call takes the app's lock itself; any task may call it.
#pragma once
#include <stdbool.h>

// ---- the finger (touch task). x, y are upright glass coordinates; `down` is the contact state. ----
// False when the screen is asleep: the contact was cancelled instead and the caller swallows the rest of it.
bool pro_app_touch(bool down, int x, int y);
void pro_app_touch_cancel(void);

// ---- the screen's power. Idle for 300 s sleeps it; a touch or the power key wakes it. ----
bool pro_app_asleep(void);
void pro_app_sleep(void);
void pro_app_wake(void);
void pro_app_bump_activity(void);

// Pod's notice line under the status bar, 3 s.
void pro_app_notice(const char *text);
