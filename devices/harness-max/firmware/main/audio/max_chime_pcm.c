// The three chimes' samples: see max_chime_pcm.h. Single-precision maths: the ESP32-P4's FPU has no double.
#include "audio/max_chime_pcm.h"

#include <math.h>

#define MS(ms) ((size_t)AUDIO_SAMPLE_RATE * (ms) / 1000)

// A question or a failure: two of the Pro beep's ~2 kHz square tones, 110 ms each with 160 ms between them. The beep's
// own 80 ms tones 60 ms apart ran together into one sound on the bar (the owner heard two as one, 19 Nov).
#define TONE MS(110)
#define GAP MS(160)
#define HALF_PERIOD (AUDIO_SAMPLE_RATE / 2000 / 2)

// A finished turn, gently: G5, then C6 150 ms later, each a sine that swells in over 10 ms and dies away with a 120 ms
// time constant; the last 30 ms fade to nothing, so it ends without a click.
#define SOFT MS(600)
#define SECOND_NOTE MS(150)
#define SWELL MS(10)
#define FADE MS(30)
#define TWO_PI 6.28318531f

size_t max_chime_samples(max_chime_t sound)
{
    return sound == MAX_CHIME_DONE ? SOFT : 2 * TONE + GAP;
}

static float note(size_t i, size_t start, float hz)
{
    if (i < start) return 0;
    const float t = (float)(i - start);
    const float swell = t < SWELL ? t / SWELL : 1.0f;
    return swell * expf(-t / (AUDIO_SAMPLE_RATE * 0.12f)) * sinf(TWO_PI * hz * t / AUDIO_SAMPLE_RATE);
}

void max_chime_render(max_chime_t sound, int loudness, size_t offset, int16_t *out, size_t count)
{
    if (sound != MAX_CHIME_DONE) {
        for (size_t k = 0; k < count; k++) {
            const size_t phase = (offset + k) % (TONE + GAP);
            out[k] = (int16_t)(phase >= TONE ? 0 : ((phase / HALF_PERIOD) & 1) ? loudness : -loudness);
        }
        return;
    }
    // V3's 2200 next to its tones' 2700: the soft notes stay under a question's loudness on every board.
    const float peak = loudness * (2200.0f / 2700.0f);
    for (size_t k = 0; k < count; k++) {
        const size_t i = offset + k, end = SOFT - 1 - i;
        const float tail = end < FADE ? (float)end / FADE : 1.0f;
        out[k] = (int16_t)lroundf(peak * tail * (note(i, 0, 783.99f) + note(i, SECOND_NOTE, 1046.5f)));
    }
}
