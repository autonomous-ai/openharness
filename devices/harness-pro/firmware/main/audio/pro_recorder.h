// The recorder under pro_voice: a 10 ms capture task, a 32 KB PSRAM ring and a lower-priority sender task that
// streams the PCM over the cable (pro_cable_voice_*). It knows nothing of Pod, pro_app or the 600 s / 65 s rules:
// pro_voice.c owns those and drives this through the calls below. Split from pro_voice.c so the state machine can be
// replayed on the host with a fake recorder (test/test_pro_voice_gate.py).
//
// Locking: one spinlock guards the metadata (agent, upload id) while a utterance starts; everything else is an atomic.
// Nothing here calls pro_app or takes any lock another module can hold across a call into this file.
#pragma once
#include <stdbool.h>
#include <stddef.h>

// Reserve the ring (PSRAM) and the two tasks, once, at boot. False: no recorder (every start is refused).
bool pro_rec_init(void);

// Begin one utterance: the capture task opens the mic, the sender sends voice.begin and then the PCM. False when
// the recorder is unavailable or a previous utterance is still being finalised.
bool pro_rec_start(const char *agent_id, const char *lang, const char *upload_id);
// Finish normally: stop capturing, drain the ring, send voice.end.
void pro_rec_stop(void);
// Discard it. quiet=true: the cable is dead, send nothing (otherwise voice.abort goes out).
void pro_rec_abort(bool quiet);

bool pro_rec_active(void);      // an utterance is recording or still being finalised
bool pro_rec_recording(void);   // the mic is (being) captured; false once the clip is only being sent
bool pro_rec_mic_tried(void);   // the capture task has finished its attempt to open the mic (it worked or failed)
bool pro_rec_heard(void);       // coarse energy estimate; never used to discard audio
unsigned pro_rec_level(void);   // 0..4 mic envelope, for visual feedback
