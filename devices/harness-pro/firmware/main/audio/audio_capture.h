// Microphone capture: I2S RX + ES7210 ADC (esp_codec_dev) -> mono 16-bit PCM. Ported from the round firmware's
// audio_capture.c with the notification beep and the speech output left out: the Pro only records (Task 7).
#pragma once

#include <stdbool.h>
#include <stdint.h>

// 16 kHz mono, the rate the speech models are trained on. It travels with the audio (`voice.begin` carries it as
// `sr`), so the daemon writes the right WAV header.
#define AUDIO_SAMPLE_RATE 16000

// One-time init of I2S (TX and RX, which share BCLK/WS) and the ES7210. False: no microphone. Safe to repeat.
bool audio_capture_init(void);

// Open the mic stream (16k/mono/16-bit) before reading. Returns true on success.
bool audio_capture_start(void);

// Blocking read of exactly `len` PCM bytes. Returns `len`, or <= 0 on error.
int audio_capture_read(uint8_t *buf, int len);

// Close the mic stream.
void audio_capture_stop(void);

// DMA queue overflows since the current capture opened; a count above zero means lost samples.
uint32_t audio_capture_overruns(void);

// One-time init of the ES8311 speaker path (after audio_capture_init). On failure it logs once and audio_beep stays a no-op.
void audio_beep_init(void);

// The notification beep: three short ~2 kHz tones. Never blocks, safe from any task; silent while a recording is open.
void audio_beep(void);
