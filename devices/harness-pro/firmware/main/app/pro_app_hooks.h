// What the shared drivers ask of the app: the touch task (pro_touch.c) and the voice task (pro_voice.c). Kept apart
// from pro_app.h so those files build without Pod's headers: Harness Max compiles them against its own app.
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

// The notice line under the status bar, 3 s.
void pro_app_notice(const char *text);
