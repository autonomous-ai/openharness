// The chimes as the Orange Pi bar plays them, from what V3 found on that board (19 Nov, devices/harness-max/flutter/lib/
// link/aplay_chime.dart): the samples each sound is played as, and which ALSA speaker plays them at what level. Pure C,
// no ALSA: audio_alsa.c gives it the device calls, the host test fakes them. The Mac's simulator plays the same samples.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "audio/max_chime_pcm.h"

// Near silence before and after each sound: the board's playback drops a play's first and last moments (two tones were
// heard as one, three as two), so those fall on these instead of the sound.
#define BAR_CHIME_LEAD (AUDIO_SAMPLE_RATE * 50 / 1000)
#define BAR_CHIME_TAIL (AUDIO_SAMPLE_RATE * 300 / 1000)
#define BAR_CHIME_WAVE_MAX (BAR_CHIME_LEAD + MAX_CHIME_SAMPLES_MAX + BAR_CHIME_TAIL)

// `sound` as the bar plays it, at V3's loudness, between its lead and tail, with no sample of digital silence; its length.
size_t bar_chime_wave(max_chime_t sound, int16_t out[BAR_CHIME_WAVE_MAX]);

// What the speaker needs of ALSA.
typedef struct {
    // Play `n` samples (16 kHz mono) on the PCM `device` to their end. False when the device could not play them.
    bool (*play)(const char *device, const int16_t *pcm, size_t n);
    // Set every channel of the mixer control `control` of the card named `card` to `value`.
    void (*set)(const char *card, const char *control, long value);
} bar_chime_out_t;

// Where the chimes go, from the first chime on. Zeroed: nothing chosen yet.
typedef struct {
    char device[96];
    bool level_done;
} bar_chime_speaker_t;

// Play `pcm` on the bar's speaker: HARNESS_MAX_SPEAKER names an ALSA device, else the board's codec, whose DAC is first
// set to HARNESS_MAX_SPEAKER_VOLUME (0..255, else 171) once. A device that fails gives way to the screen's HDMI audio,
// for good. From one thread at a time.
void bar_chime_play(bar_chime_speaker_t *sp, const bar_chime_out_t *out, const int16_t *pcm, size_t n);
