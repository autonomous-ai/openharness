// The bar's three chimes (main/app/max_chime.h): their samples as both boards render them (main/audio/max_chime_pcm.c),
// the Orange Pi's padding of each (linux/audio/bar_chime.c), and which speaker plays them there and at what level. The
// sounds are V3's (devices/harness-max/flutter/lib/link/aplay_chime.dart and its test), tuned on the bar on 19 Nov.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio/bar_chime.h"
#include "audio/max_chime_pcm.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static int16_t pcm[MAX_CHIME_SAMPLES_MAX], wave[BAR_CHIME_WAVE_MAX];

static void render_all(max_chime_t sound, int loudness)
{
    max_chime_render(sound, loudness, 0, pcm, max_chime_samples(sound));
}

static int peak_of(const int16_t *s, size_t n)
{
    int peak = 0;
    for (size_t i = 0; i < n; i++) peak = abs(s[i]) > peak ? abs(s[i]) : peak;
    return peak;
}

// A question or a failure: two ~2 kHz square tones of 110 ms with 160 ms between them (270 ms from start to start), as
// V3 tuned them: 80 ms tones 60 ms apart were heard as one sound on the bar.
static void test_two_tones(void)
{
    CHECK(max_chime_samples(MAX_CHIME_ASK) == 6080);
    CHECK(max_chime_samples(MAX_CHIME_FAILED) == 6080);
    render_all(MAX_CHIME_ASK, 2700);
    CHECK(pcm[0] == -2700 && pcm[4] == 2700 && pcm[1759] == 2700);
    CHECK(pcm[1760] == 0 && pcm[4319] == 0);   // the gap: 110 ms in, to 270 ms
    CHECK(pcm[4320] == -2700 && pcm[6079] == 2700);
    CHECK(peak_of(pcm, 6080) == 2700);
    static int16_t failed[6080];
    max_chime_render(MAX_CHIME_FAILED, 2700, 0, failed, 6080);
    CHECK(!memcmp(failed, pcm, sizeof failed));   // a failure sounds as a question does
    // The ESP32-P4 rings them at the Pro's beep loudness.
    render_all(MAX_CHIME_ASK, 6000);
    CHECK(pcm[0] == -6000 && pcm[4] == 6000 && pcm[4320] == -6000 && peak_of(pcm, 6080) == 6000);
}

// A finished turn: a soft G5 then C6 150 ms later, each swelling in over 10 ms and dying away, 600 ms long, its last
// 30 ms fading so it ends without a click; at 2200/2700 of a question's loudness.
static void test_soft_done(void)
{
    const size_t n = max_chime_samples(MAX_CHIME_DONE);
    CHECK(n == 9600 && n <= MAX_CHIME_SAMPLES_MAX);
    render_all(MAX_CHIME_DONE, 2700);
    const int peak = peak_of(pcm, n);
    CHECK(peak >= 2000 && peak <= 2700);
    CHECK(abs(pcm[0]) < 50 && abs(pcm[n - 1]) < 50);   // no click going in, nor going out
    bool value_seen[65536] = {false};
    int distinct = 0;
    for (size_t i = 0; i < n; i++) distinct += !value_seen[pcm[i] + 32768], value_seen[pcm[i] + 32768] = true;
    CHECK(distinct > 500);   // a curve, not a square
    // The second note comes in at 150 ms: the swell before it has died down to well under its own start.
    CHECK(peak_of(pcm + 2200, 200) < peak_of(pcm + 2400, 400));
    // The ESP32-P4 scales it with its louder tones, as V3 scaled 2200 to 2700.
    static int16_t loud[9600];
    max_chime_render(MAX_CHIME_DONE, 6000, 0, loud, n);
    for (size_t i = 0; i < n; i++) CHECK(abs(loud[i] - pcm[i] * 6000 / 2700) <= 2);
    CHECK(peak_of(loud, n) <= 6000 * 2200 / 2700 * 2);
}

// The ESP32-P4 renders 20 ms at a time: any cut gives the samples of the whole.
static void test_blocks(void)
{
    static int16_t whole[MAX_CHIME_SAMPLES_MAX], blocks[MAX_CHIME_SAMPLES_MAX];
    for (int s = MAX_CHIME_ASK; s <= MAX_CHIME_DONE; s++) {
        const size_t n = max_chime_samples((max_chime_t)s);
        max_chime_render((max_chime_t)s, 6000, 0, whole, n);
        for (size_t at = 0; at < n; at += 320) max_chime_render((max_chime_t)s, 6000, at, blocks + at, n - at < 320 ? n - at : 320);
        CHECK(!memcmp(whole, blocks, n * sizeof whole[0]));
    }
    // An odd cut too.
    max_chime_render(MAX_CHIME_DONE, 2700, 0, whole, 9600);
    max_chime_render(MAX_CHIME_DONE, 2700, 0, blocks, 777);
    max_chime_render(MAX_CHIME_DONE, 2700, 777, blocks + 777, 9600 - 777);
    CHECK(!memcmp(whole, blocks, 9600 * sizeof whole[0]));
}

// On the Orange Pi each chime sits between a 50 ms lead and a 300 ms tail of near silence, which the board's playback
// may drop instead of the sound, and no sample is 0: the codec mutes on digital silence and swallowed the second tone.
static void test_bar_wave(void)
{
    for (int s = MAX_CHIME_ASK; s <= MAX_CHIME_DONE; s++) {
        const size_t own = max_chime_samples((max_chime_t)s), n = bar_chime_wave((max_chime_t)s, wave);
        CHECK(n == 800 + own + 4800 && n <= BAR_CHIME_WAVE_MAX);
        for (size_t i = 0; i < n; i++) CHECK(wave[i] != 0);
        CHECK(abs(wave[0]) == 1 && abs(wave[799]) == 1 && abs(wave[n - 4800]) == 1 && abs(wave[n - 1]) == 1);
        render_all((max_chime_t)s, 2700);   // the bar's loudness: V3's
        for (size_t i = 0; i < own; i++) CHECK(wave[800 + i] == (pcm[i] ? pcm[i] : wave[800 + i]) && abs(wave[800 + i]) >= 1);
    }
    bar_chime_wave(MAX_CHIME_ASK, wave);
    CHECK(wave[800] == -2700 && wave[800 + 4320] == -2700 && abs(wave[800 + 1760]) == 1);
}

// ── the speaker: a fake ALSA that records what it was asked ────────────────────────────────────────────────────────

static char ran[16][96];
static int ran_n;
static const char *failing;   // a device whose plays fail
static size_t played_n;

static bool fake_play(const char *device, const int16_t *s, size_t n)
{
    (void)s;
    CHECK(ran_n < 16);
    snprintf(ran[ran_n++], sizeof ran[0], "play %s", device);
    played_n = n;
    return !failing || strcmp(device, failing);
}

static void fake_set(const char *card, const char *control, long value)
{
    CHECK(ran_n < 16);
    snprintf(ran[ran_n++], sizeof ran[0], "set %s %s %ld", card, control, value);
}

static const bar_chime_out_t FAKE = {fake_play, fake_set};

static bar_chime_speaker_t sp;

// A program that starts with these overrides: no chime played yet.
static void fresh(const char *speaker, const char *volume)
{
    if (speaker) setenv("HARNESS_MAX_SPEAKER", speaker, 1); else unsetenv("HARNESS_MAX_SPEAKER");
    if (volume) setenv("HARNESS_MAX_SPEAKER_VOLUME", volume, 1); else unsetenv("HARNESS_MAX_SPEAKER_VOLUME");
    memset(&sp, 0, sizeof sp);
    ran_n = 0;
    failing = NULL;
}

static void test_speaker(void)
{
    const size_t n = bar_chime_wave(MAX_CHIME_ASK, wave);
    // The board's codec, its DAC raised once from the 64 it boots at (inaudible) to the owner's 171, before the first.
    fresh(NULL, NULL);
    bar_chime_play(&sp, &FAKE, wave, n);
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(ran_n == 4 && played_n == n);
    CHECK(!strcmp(ran[0], "set sndi2s4 DACL Playback Volume 171"));
    CHECK(!strcmp(ran[1], "set sndi2s4 DACR Playback Volume 171"));
    CHECK(!strcmp(ran[2], "play plughw:CARD=sndi2s4,DEV=0") && !strcmp(ran[3], ran[2]));

    // A codec that fails gives way to the screen's HDMI audio, which the next chimes keep.
    fresh(NULL, NULL);
    failing = "plughw:CARD=sndi2s4,DEV=0";
    bar_chime_play(&sp, &FAKE, wave, n);
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(ran_n == 5);
    CHECK(!strcmp(ran[2], "play plughw:CARD=sndi2s4,DEV=0"));
    CHECK(!strcmp(ran[3], "play plughw:CARD=allwinnerhdmi,DEV=0") && !strcmp(ran[4], ran[3]));

    // Another device named: no codec level; a level named: that one.
    fresh("plughw:CARD=allwinnerhdmi,DEV=0", "200");
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(ran_n == 1 && !strcmp(ran[0], "play plughw:CARD=allwinnerhdmi,DEV=0"));
    fresh("plughw:CARD=sndi2s4,DEV=0", "200");
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(ran_n == 3 && !strcmp(ran[0], "set sndi2s4 DACL Playback Volume 200") && !strcmp(ran[2], "play plughw:CARD=sndi2s4,DEV=0"));
    // A level that is no 0..255 number keeps the owner's 171; an empty speaker is the codec.
    fresh("", "loud");
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(ran_n == 3 && !strcmp(ran[0], "set sndi2s4 DACL Playback Volume 171"));
    fresh(NULL, "300");
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(!strcmp(ran[0], "set sndi2s4 DACL Playback Volume 171"));
    // The fallback failing too: nothing more is tried, and the next chime tries it again (it stays).
    fresh(NULL, NULL);
    failing = "plughw:CARD=sndi2s4,DEV=0";
    bar_chime_play(&sp, &FAKE, wave, n);
    failing = "plughw:CARD=allwinnerhdmi,DEV=0";
    bar_chime_play(&sp, &FAKE, wave, n);
    CHECK(ran_n == 5 && !strcmp(ran[4], "play plughw:CARD=allwinnerhdmi,DEV=0"));
}

int main(void)
{
    test_two_tones();
    test_soft_done();
    test_blocks();
    test_bar_wave();
    test_speaker();
    printf("test_chime: %d checks passed\n", checks);
    return 0;
}
