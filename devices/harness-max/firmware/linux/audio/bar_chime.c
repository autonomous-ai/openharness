// The chimes as the Orange Pi bar plays them: see bar_chime.h.
#include "audio/bar_chime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// V3's loudness on the bar: the Pro beep's 6000 read as too loud on the desk (the owner's call, 19 Nov).
#define LOUDNESS 2700

// The board's speaker: the ES8389 codec on I2S, as Near's voice service plays it; Near's fallback when the codec fails
// is the screen's HDMI audio.
#define SPEAKER "plughw:CARD=sndi2s4,DEV=0"
#define FALLBACK "plughw:CARD=allwinnerhdmi,DEV=0"
#define CODEC_CARD "sndi2s4"
// The codec's DAC level (0..255, 191 is 0 dB). It boots at 64, about -63 dB, where nothing is heard; 0 dB was too loud
// on the desk, so about half as loud (the owner's call, 19 Nov).
#define DAC_LEVEL 171

size_t bar_chime_wave(max_chime_t sound, int16_t out[BAR_CHIME_WAVE_MAX])
{
    const size_t own = max_chime_samples(sound), n = BAR_CHIME_LEAD + own + BAR_CHIME_TAIL;
    memset(out, 0, n * sizeof out[0]);
    max_chime_render(sound, LOUDNESS, 0, out + BAR_CHIME_LEAD, own);
    // The codec mutes on digital silence and comes back slowly: a gap of zeros between two tones swallowed the second
    // (the mic heard it about 20 times fainter). A floor of one step, far below hearing, keeps it awake.
    for (size_t i = 0; i < n; i++) if (!out[i]) out[i] = (int16_t)((i & 1) ? 1 : -1);
    return n;
}

// The device names the codec's card: "CARD=sndi2s4" and not the start of a longer name.
static bool names_codec(const char *device)
{
    const char *at = strstr(device, "CARD=" CODEC_CARD);
    if (!at) return false;
    const char next = at[sizeof "CARD=" CODEC_CARD - 1];
    return !((next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z') || (next >= '0' && next <= '9') || next == '_');
}

static long dac_level(void)
{
    const char *text = getenv("HARNESS_MAX_SPEAKER_VOLUME");
    char *end = NULL;
    const long level = text && *text ? strtol(text, &end, 10) : -1;
    return end && !*end && level >= 0 && level <= 255 ? level : DAC_LEVEL;
}

void bar_chime_play(bar_chime_speaker_t *sp, const bar_chime_out_t *out, const int16_t *pcm, size_t n)
{
    if (!sp->device[0]) {
        const char *named = getenv("HARNESS_MAX_SPEAKER");
        snprintf(sp->device, sizeof sp->device, "%s", named && *named ? named : SPEAKER);
    }
    if (!sp->level_done && names_codec(sp->device)) {
        sp->level_done = true;
        const long level = dac_level();
        out->set(CODEC_CARD, "DACL Playback Volume", level);
        out->set(CODEC_CARD, "DACR Playback Volume", level);
    }
    if (out->play(sp->device, pcm, n) || !strcmp(sp->device, FALLBACK)) return;
    snprintf(sp->device, sizeof sp->device, "%s", FALLBACK);
    out->play(sp->device, pcm, n);
}
