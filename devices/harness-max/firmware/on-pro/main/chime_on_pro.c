// The Max's chimes (app/max_chime.h) on the Pro's speaker: the Pro's audio (audio/audio_capture.c, compiled where it
// is) has one sound, its notification beep, so every chime is that beep. Silent while a recording is open, as the Pro's.
#include "app/max_chime.h"
#include "audio/audio_capture.h"

void max_chime(max_chime_t sound)
{
    (void)sound;
    audio_beep();
}
