// The Pro's audio/audio_capture.h on ALSA: the "default" capture device, opened for each recording as the device opens
// its codec, and the beep on the "default" output from a thread of its own. No microphone (or one another program
// holds): recording fails, as on a device whose codec does not answer.
#include "audio/audio_capture.h"

#include <alsa/asoundlib.h>
#include <pthread.h>
#include <stdatomic.h>

#include "audio/beep_tone.h"

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "audio";

#define DEVICE "default"
#define LATENCY_US 100000   // ALSA's buffer: 100 ms, the device's DMA headroom

static snd_pcm_t *s_mic;   // the recording's; open between start and stop
static atomic_bool s_open;
static atomic_uint s_overruns;
static pthread_mutex_t s_beep_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t s_beep_cv = PTHREAD_COND_INITIALIZER;
static bool s_beep_due, s_beep_ready;
static int16_t s_tone[BEEP_TONE_SAMPLES];

static snd_pcm_t *open_pcm(snd_pcm_stream_t stream)
{
    snd_pcm_t *pcm = NULL;
    int err = snd_pcm_open(&pcm, DEVICE, stream, 0);
    if (err == 0) err = snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 1,
                                           AUDIO_SAMPLE_RATE, 1, LATENCY_US);
    if (err < 0) {
        ESP_LOGW(TAG, "%s %s: %s", DEVICE, stream == SND_PCM_STREAM_CAPTURE ? "capture" : "playback", snd_strerror(err));
        if (pcm) snd_pcm_close(pcm);
        return NULL;
    }
    return pcm;
}

uint32_t audio_capture_overruns(void) { return atomic_load(&s_overruns); }

bool audio_capture_init(void)
{
    // Asks once whether there is a microphone at all; each recording opens it again.
    snd_pcm_t *probe = open_pcm(SND_PCM_STREAM_CAPTURE);
    if (!probe) {
        ESP_LOGE(TAG, "microphone unavailable");
        return false;
    }
    snd_pcm_close(probe);
    ESP_LOGI(TAG, "mic (ALSA %s) ready", DEVICE);
    return true;
}

bool audio_capture_start(void)
{
    if (atomic_load(&s_open)) return true;
    s_mic = open_pcm(SND_PCM_STREAM_CAPTURE);
    if (!s_mic) {
        ESP_LOGE(TAG, "codec open");
        return false;
    }
    atomic_store(&s_overruns, 0);
    atomic_store(&s_open, true);
    ESP_LOGI(TAG, "mic stream open (%d Hz mono)", AUDIO_SAMPLE_RATE);
    return true;
}

int audio_capture_read(uint8_t *buf, int len)
{
    if (!atomic_load(&s_open) || len < 2) return -1;
    snd_pcm_uframes_t want = (snd_pcm_uframes_t)len / 2, got = 0;
    while (got < want) {
        snd_pcm_sframes_t n = snd_pcm_readi(s_mic, buf + got * 2, want - got);
        if (n == -EPIPE) {   // overrun: samples were lost; carry on, as the device counts a DMA queue overflow
            atomic_fetch_add(&s_overruns, 1);
            n = snd_pcm_recover(s_mic, (int)n, 1);
        }
        if (n < 0) {
            ESP_LOGW(TAG, "read: %s", snd_strerror((int)n));
            return -1;
        }
        got += (snd_pcm_uframes_t)n;
    }
    return len;
}

void audio_capture_stop(void)
{
    if (!atomic_exchange(&s_open, false)) return;
    snd_pcm_close(s_mic);
    s_mic = NULL;
}

static void *beep_thread(void *arg)
{
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&s_beep_mu);
        while (!s_beep_due) pthread_cond_wait(&s_beep_cv, &s_beep_mu);
        s_beep_due = false;
        pthread_mutex_unlock(&s_beep_mu);
        snd_pcm_t *spk = open_pcm(SND_PCM_STREAM_PLAYBACK);
        if (!spk) continue;
        snd_pcm_sframes_t n = snd_pcm_writei(spk, s_tone, BEEP_TONE_SAMPLES);
        if (n < 0) n = snd_pcm_recover(spk, (int)n, 1);
        if (n >= 0) snd_pcm_drain(spk);
        snd_pcm_close(spk);
    }
    return NULL;
}

void audio_beep_init(void)
{
    if (s_beep_ready) return;
    beep_tone(s_tone);
    pthread_t thread;
    if (pthread_create(&thread, NULL, beep_thread, NULL) != 0) {
        ESP_LOGW(TAG, "speaker unavailable: no beep thread");
        return;
    }
    pthread_detach(thread);
    s_beep_ready = true;
    ESP_LOGI(TAG, "speaker (ALSA %s) ready", DEVICE);
}

void audio_beep(void)
{
    // As the device: at most one chime a second, and none while a recording is open. Never blocks.
    static atomic_uint_least32_t last;
    const uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
    uint32_t was = atomic_load(&last);
    if (!s_beep_ready || atomic_load(&s_open) || (was && now - was < 1000) ||
        !atomic_compare_exchange_strong(&last, &was, now ? now : 1))
        return;
    pthread_mutex_lock(&s_beep_mu);
    s_beep_due = true;
    pthread_cond_signal(&s_beep_cv);
    pthread_mutex_unlock(&s_beep_mu);
}
