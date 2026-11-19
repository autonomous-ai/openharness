// The three chimes' samples (app/max_chime.h), 16 kHz mono, rendered a block at a time so the ESP32-P4 needs no buffer
// for a whole sound. The sounds are V3's, tuned on the Orange Pi bar on 19 Nov (devices/harness-max/flutter/lib/link/
// aplay_chime.dart): each board plays them at its own loudness (main/audio/max_audio.c, linux/audio/bar_chime.c).
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "app/max_chime.h"
#include "audio/audio_capture.h"

// The longest sound, a finished turn's 600 ms.
#define MAX_CHIME_SAMPLES_MAX (AUDIO_SAMPLE_RATE * 600 / 1000)

// How many samples `sound` lasts.
size_t max_chime_samples(max_chime_t sound);

// Samples [offset, offset + count) of `sound` into `out`; `offset + count` is at most max_chime_samples(sound).
// `loudness` is the peak of a question's square tones; a finished turn's two notes swell to 2200/2700 of it each.
void max_chime_render(max_chime_t sound, int loudness, size_t offset, int16_t *out, size_t count);
