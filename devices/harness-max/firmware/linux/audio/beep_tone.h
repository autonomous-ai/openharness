// The notification beep's samples, the device's (main/audio/max_audio.c): three ~2 kHz square tones of 80 ms with
// 60 ms gaps, 16 kHz mono.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "audio/audio_capture.h"

#define BEEP_TONE_SAMPLES (AUDIO_SAMPLE_RATE * (3 * 80 + 2 * 60) / 1000)

static inline void beep_tone(int16_t out[BEEP_TONE_SAMPLES])
{
    const size_t tone = AUDIO_SAMPLE_RATE * 80 / 1000, gap = AUDIO_SAMPLE_RATE * 60 / 1000;
    const size_t half = AUDIO_SAMPLE_RATE / 2000 / 2;   // half a period of ~2 kHz
    for (size_t i = 0; i < BEEP_TONE_SAMPLES; i++) {
        const size_t phase = i % (tone + gap);
        out[i] = phase < tone ? (((phase / half) & 1) ? 6000 : -6000) : 0;
    }
}
