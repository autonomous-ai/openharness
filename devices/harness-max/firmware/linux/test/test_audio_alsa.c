// The bar's microphone (linux/audio/audio_alsa.c): HARNESS_MAX_MIC names the ALSA capture device a recording opens.
// ALSA's null device stands in for a microphone that is there.
#include <stdio.h>
#include <stdlib.h>

#include "audio/audio_capture.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

int main(void)
{
    // A named device that is not there: no microphone, as on a device whose codec does not answer.
    setenv("HARNESS_MAX_MIC", "harness_max_no_such_pcm", 1);
    CHECK(!audio_capture_init());
    CHECK(!audio_capture_start());

    // The named device is the one a recording opens, and reads come back whole.
    setenv("HARNESS_MAX_MIC", "null", 1);
    CHECK(audio_capture_init());
    CHECK(audio_capture_start());
    uint8_t buf[640];   // 20 ms at 16 kHz
    CHECK(audio_capture_read(buf, sizeof buf) == (int)sizeof buf);
    audio_capture_stop();
    CHECK(audio_capture_read(buf, sizeof buf) == -1);   // nothing to read once stopped

    printf("test_audio_alsa: %d checks passed\n", checks);
    return 0;
}
