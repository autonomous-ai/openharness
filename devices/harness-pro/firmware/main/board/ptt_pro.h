// The Pro side button: tap to go back/stop, hold 0.8 s to toggle the screen.
#pragma once

#include <stdbool.h>

typedef struct {
    void (*on_press)(void);   // fresh press edge, acted on at once
    void (*on_hold)(void);    // once per press, after 0.8 s down
} ptt_handlers_t;

// Set before ptt_start(); the handlers run on the button task.
void ptt_set_handlers(const ptt_handlers_t *handlers);

// Start the button poll task.
void ptt_start(void);
