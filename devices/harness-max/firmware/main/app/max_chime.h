// The bar's three chimes (V3's, 19 Nov): a question and a failure ring two short tones, a loud finished turn two soft
// notes. max_app.c decides when to ring (one sound each at most every 30 s); the board plays it: main/audio/max_audio.c
// on the ESP32-P4, linux/audio on the Orange Pi and the Mac's simulator.
#pragma once

typedef enum { MAX_CHIME_ASK, MAX_CHIME_FAILED, MAX_CHIME_DONE } max_chime_t;

// Play `sound` now, from any task. Returns at once; a chime already playing, an open mic or a board with no speaker
// drops it, so a person talking never hears one.
void max_chime(max_chime_t sound);
