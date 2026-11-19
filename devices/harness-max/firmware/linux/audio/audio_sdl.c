// The Pro's audio/audio_capture.h on SDL: the default capture device, and the chimes (app/max_chime.h) on the default
// output as the Orange Pi bar plays them (the macOS simulator). SDL was initialised on the main thread by the output. The
// microphone is opened for each recording, not at boot: opening it takes macOS seconds (and its permission prompt), and
// lights the microphone indicator while open. No microphone: recording fails, as on a device whose codec does not answer.
#include "audio/audio_capture.h"

#include <SDL.h>
#include <stdatomic.h>

#include "app/max_chime.h"
#include "audio/bar_chime.h"

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "audio";

// The capture callback's PCM waiting for audio_capture_read: one second. Under s_mu.
#define RING_BYTES (AUDIO_SAMPLE_RATE * 2)
// A read waits at most this long for its bytes: a stalled device ends the recording instead of hanging its task.
#define READ_WAIT_MS 1000

static SDL_AudioDeviceID s_mic, s_spk;
static SDL_mutex *s_mu;
static SDL_cond *s_cv;
static uint8_t s_ring[RING_BYTES];
static size_t s_head, s_len;
static atomic_bool s_open;
static atomic_uint s_overruns;
static SDL_mutex *s_spk_mu;   // one chime rendered and queued at a time
static int16_t s_wave[BAR_CHIME_WAVE_MAX];   // under s_spk_mu

static void captured(void *ctx, Uint8 *data, int len)
{
    (void)ctx;
    SDL_LockMutex(s_mu);
    for (int i = 0; i < len; i++) {
        if (s_len == RING_BYTES) {   // the reader is behind: the oldest byte goes, as a DMA queue overflow
            s_head = (s_head + 1) % RING_BYTES;
            s_len--;
            atomic_fetch_add(&s_overruns, 1);
        }
        s_ring[(s_head + s_len++) % RING_BYTES] = data[i];
    }
    SDL_CondSignal(s_cv);
    SDL_UnlockMutex(s_mu);
}

uint32_t audio_capture_overruns(void) { return atomic_load(&s_overruns); }

bool audio_capture_init(void)
{
    if (!s_mu && (!(s_mu = SDL_CreateMutex()) || !(s_cv = SDL_CreateCond()))) return false;
    if (SDL_GetNumAudioDevices(1) <= 0) {
        ESP_LOGE(TAG, "microphone unavailable: no capture device");
        return false;
    }
    return true;
}

bool audio_capture_start(void)
{
    if (atomic_load(&s_open)) return true;
    if (!audio_capture_init()) return false;
    SDL_LockMutex(s_mu);
    s_head = s_len = 0;
    SDL_UnlockMutex(s_mu);
    atomic_store(&s_overruns, 0);
    const SDL_AudioSpec want = {.freq = AUDIO_SAMPLE_RATE, .format = AUDIO_S16LSB, .channels = 1, .samples = 160,
                                .callback = captured};
    s_mic = SDL_OpenAudioDevice(NULL, 1, &want, NULL, 0);   // SDL converts from whatever the microphone gives
    if (!s_mic) {
        ESP_LOGE(TAG, "codec open: %s", SDL_GetError());
        return false;
    }
    atomic_store(&s_open, true);
    if (s_spk) SDL_ClearQueuedAudio(s_spk);   // the person is talking: a chime stops
    SDL_PauseAudioDevice(s_mic, 0);
    ESP_LOGI(TAG, "mic stream open (%d Hz mono)", AUDIO_SAMPLE_RATE);
    return true;
}

int audio_capture_read(uint8_t *buf, int len)
{
    if (!atomic_load(&s_open) || len <= 0 || len > RING_BYTES) return -1;
    const int64_t deadline = esp_timer_get_time() / 1000 + READ_WAIT_MS;
    SDL_LockMutex(s_mu);
    while (s_len < (size_t)len && atomic_load(&s_open)) {
        const int64_t left = deadline - esp_timer_get_time() / 1000;
        if (left <= 0 || SDL_CondWaitTimeout(s_cv, s_mu, (Uint32)left) == SDL_MUTEX_TIMEDOUT) break;
    }
    const bool full = s_len >= (size_t)len;
    for (int i = 0; full && i < len; i++) buf[i] = s_ring[(s_head + (size_t)i) % RING_BYTES];
    if (full) {
        s_head = (s_head + (size_t)len) % RING_BYTES;
        s_len -= (size_t)len;
    }
    SDL_UnlockMutex(s_mu);
    return full ? len : -1;
}

void audio_capture_stop(void)
{
    if (!atomic_exchange(&s_open, false)) return;
    SDL_CloseAudioDevice(s_mic);   // after the callback's last call
    s_mic = 0;
}

void audio_beep_init(void)
{
    if (s_spk) return;
    if (!s_spk_mu && !(s_spk_mu = SDL_CreateMutex())) {
        ESP_LOGW(TAG, "speaker unavailable: %s", SDL_GetError());
        return;
    }
    const SDL_AudioSpec want = {.freq = AUDIO_SAMPLE_RATE, .format = AUDIO_S16LSB, .channels = 1, .samples = 512};
    s_spk = SDL_OpenAudioDevice(NULL, 0, &want, NULL, 0);
    if (!s_spk) {
        ESP_LOGW(TAG, "speaker unavailable: %s", SDL_GetError());
        return;
    }
    SDL_PauseAudioDevice(s_spk, 0);   // plays what is queued, silence otherwise
    ESP_LOGI(TAG, "speaker (the default output) ready");
}

void max_chime(max_chime_t sound)
{
    // Queued, so it never blocks; one still queued is the one playing, and this one is dropped.
    if (!s_spk || atomic_load(&s_open)) return;
    SDL_LockMutex(s_spk_mu);
    if (!SDL_GetQueuedAudioSize(s_spk))
        SDL_QueueAudio(s_spk, s_wave, (Uint32)(bar_chime_wave(sound, s_wave) * sizeof s_wave[0]));
    SDL_UnlockMutex(s_spk_mu);
}

// The Pro's alert sound, for a caller of its audio_capture.h: a question's chime.
void audio_beep(void) { max_chime(MAX_CHIME_ASK); }
