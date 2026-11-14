// What pro_app needs from the recorder, implemented in audio/pro_voice.c (the state machine) over
// audio/pro_recorder.c (the capture and sender tasks).
//
// Every call is made WITHOUT pro_app's lock held, from whichever task asked (touch, render, cable_link): an
// implementation may call back into pro_app_notice / pro_app_talk_over, and may send on the cable.
#pragma once
#include <stdbool.h>
#include <stdint.h>

// Boot: reserve the PSRAM ring and the tasks, open the microphone. False: no recorder (every start is refused).
bool pro_voice_init(void);

// Start a recording for `agent_id` (a gate-checked agent). After it returns pro_voice_start_pending() is true until
// the recorder is running; false at once if the start was refused.
void pro_voice_begin(const char *agent_id);
// send=true: stop and send what was recorded (the reply arrives as pro_app_voice_result). send=false: discard it.
void pro_voice_end(bool send);

bool pro_voice_open(void);            // a recording, or a send still waiting for its reply
bool pro_voice_start_pending(void);   // begun but the recorder has not started yet
bool pro_voice_waiting(void);         // stopped and sent; the daemon's reply is awaited
// The reply came (or was dropped): the voice state is over.
void pro_voice_close(void);
// The link went down: end any recording WITHOUT telling the daemon (the cable is dead).
void pro_voice_link_lost(void);
// Once per render step: the 600 s cap, a recorder that died, a reply that never came.
void pro_voice_tick(uint32_t now_ms);
