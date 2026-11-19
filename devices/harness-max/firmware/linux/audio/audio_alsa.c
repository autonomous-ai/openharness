// The Pro's audio/audio_capture.h on ALSA: the capture device HARNESS_MAX_MIC names (an ALSA PCM, as `arecord -L` lists
// them; "default" when unset), opened for each recording as the device opens its codec. And the chimes
// (app/max_chime.h) from a thread of their own, on the speaker bar_chime.c picks (the board's codec unless
// HARNESS_MAX_SPEAKER names another). No microphone (or one another program holds): recording fails, as on a device
// whose codec does not answer.
#include "audio/audio_capture.h"

#include <alsa/asoundlib.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

#include "app/max_chime.h"
#include "audio/bar_chime.h"

#include "esp_log.h"

static const char *TAG = "audio";

#define DEVICE "default"
#define MIC_ENV "HARNESS_MAX_MIC"
#define LATENCY_US 100000   // ALSA's buffer: 100 ms, the device's DMA headroom
#define CHIME_BLOCK (AUDIO_SAMPLE_RATE / 50)   // a chime is written 20 ms at a time, so a recording can cut it short

static snd_pcm_t *s_mic;   // the recording's; open between start and stop
static atomic_bool s_open;
static atomic_uint s_overruns;
static pthread_mutex_t s_chime_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t s_chime_cv = PTHREAD_COND_INITIALIZER;
static bool s_chime_due;            // under s_chime_mu
static max_chime_t s_chime_sound;   // under s_chime_mu
static atomic_bool s_chime_ready, s_chime_busy;   // busy: a chime is waiting for the thread or playing
static int16_t s_wave[BAR_CHIME_WAVE_MAX];        // the chime thread's
static bar_chime_speaker_t s_speaker;             // the chime thread's

// A board's default card need not be the one with a microphone (the Orange Pi's is its codec, with none wired).
static const char *mic_name(void)
{
    const char *name = getenv(MIC_ENV);
    return name && *name ? name : DEVICE;
}

static snd_pcm_t *open_pcm(const char *name, snd_pcm_stream_t stream)
{
    snd_pcm_t *pcm = NULL;
    int err = snd_pcm_open(&pcm, name, stream, 0);
    if (err == 0) err = snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 1,
                                           AUDIO_SAMPLE_RATE, 1, LATENCY_US);
    if (err < 0) {
        ESP_LOGW(TAG, "%s %s: %s", name, stream == SND_PCM_STREAM_CAPTURE ? "capture" : "playback", snd_strerror(err));
        if (pcm) snd_pcm_close(pcm);
        return NULL;
    }
    return pcm;
}

uint32_t audio_capture_overruns(void) { return atomic_load(&s_overruns); }

bool audio_capture_init(void)
{
    // Asks once whether there is a microphone at all; each recording opens it again.
    snd_pcm_t *probe = open_pcm(mic_name(), SND_PCM_STREAM_CAPTURE);
    if (!probe) {
        ESP_LOGE(TAG, "microphone unavailable");
        return false;
    }
    snd_pcm_close(probe);
    ESP_LOGI(TAG, "mic (ALSA %s) ready", mic_name());
    return true;
}

bool audio_capture_start(void)
{
    if (atomic_load(&s_open)) return true;
    s_mic = open_pcm(mic_name(), SND_PCM_STREAM_CAPTURE);
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

// bar_chime.c's ALSA: play to the end, unless a recording opens meanwhile (the person is talking: the chime stops).
static bool alsa_play(const char *device, const int16_t *pcm, size_t n)
{
    snd_pcm_t *spk = open_pcm(device, SND_PCM_STREAM_PLAYBACK);
    if (!spk) return false;
    bool played = true, cut = false;
    for (size_t done = 0; done < n && !(cut = atomic_load(&s_open));) {
        const size_t count = n - done < CHIME_BLOCK ? n - done : CHIME_BLOCK;
        snd_pcm_sframes_t wrote = snd_pcm_writei(spk, pcm + done, count);
        if (wrote < 0) wrote = snd_pcm_recover(spk, (int)wrote, 1);
        if (wrote < 0) {
            ESP_LOGW(TAG, "%s playback: %s", device, snd_strerror((int)wrote));
            played = false;
            break;
        }
        done += (size_t)wrote;
    }
    if (played && !cut) snd_pcm_drain(spk); else snd_pcm_drop(spk);
    snd_pcm_close(spk);
    return played;
}

// bar_chime.c's mixer: every channel of the card's control `control` to `value`, as `amixer -c <card> cset` does.
static void alsa_set(const char *card, const char *control, long value)
{
    char name[64];
    snprintf(name, sizeof name, "hw:CARD=%s", card);
    snd_ctl_t *ctl = NULL;
    snd_ctl_elem_id_t *id;
    snd_ctl_elem_info_t *info;
    snd_ctl_elem_value_t *val;
    snd_ctl_elem_id_alloca(&id);
    snd_ctl_elem_info_alloca(&info);
    snd_ctl_elem_value_alloca(&val);
    snd_ctl_elem_id_set_interface(id, SND_CTL_ELEM_IFACE_MIXER);
    snd_ctl_elem_id_set_name(id, control);
    snd_ctl_elem_info_set_id(info, id);
    int err = snd_ctl_open(&ctl, name, 0);
    if (err == 0) err = snd_ctl_elem_info(ctl, info);
    if (err == 0 && snd_ctl_elem_info_get_type(info) != SND_CTL_ELEM_TYPE_INTEGER) err = -EINVAL;
    if (err == 0) {
        snd_ctl_elem_value_set_id(val, id);
        for (unsigned i = 0; i < snd_ctl_elem_info_get_count(info); i++) snd_ctl_elem_value_set_integer(val, i, value);
        err = snd_ctl_elem_write(ctl, val);
    }
    if (ctl) snd_ctl_close(ctl);
    if (err < 0) ESP_LOGW(TAG, "%s %s: %s", name, control, snd_strerror(err));
    else ESP_LOGI(TAG, "%s %s = %ld", name, control, value);
}

static const bar_chime_out_t ALSA_OUT = {alsa_play, alsa_set};

static void *chime_thread(void *arg)
{
    (void)arg;
    for (;;) {
        pthread_mutex_lock(&s_chime_mu);
        while (!s_chime_due) pthread_cond_wait(&s_chime_cv, &s_chime_mu);
        s_chime_due = false;
        const max_chime_t sound = s_chime_sound;
        pthread_mutex_unlock(&s_chime_mu);
        if (!atomic_load(&s_open)) bar_chime_play(&s_speaker, &ALSA_OUT, s_wave, bar_chime_wave(sound, s_wave));
        atomic_store(&s_chime_busy, false);
    }
    return NULL;
}

void audio_beep_init(void)
{
    if (atomic_load(&s_chime_ready)) return;
    pthread_t thread;
    if (pthread_create(&thread, NULL, chime_thread, NULL) != 0) {
        ESP_LOGW(TAG, "speaker unavailable: no chime thread");
        return;
    }
    pthread_detach(thread);
    atomic_store(&s_chime_ready, true);
    const char *named = getenv("HARNESS_MAX_SPEAKER");
    ESP_LOGI(TAG, "speaker (ALSA %s) ready", named && *named ? named : "the board's codec");
}

void max_chime(max_chime_t sound)
{
    bool idle = false;
    if (!atomic_load(&s_chime_ready) || atomic_load(&s_open) ||
        !atomic_compare_exchange_strong(&s_chime_busy, &idle, true))
        return;
    pthread_mutex_lock(&s_chime_mu);
    s_chime_sound = sound;
    s_chime_due = true;
    pthread_cond_signal(&s_chime_cv);
    pthread_mutex_unlock(&s_chime_mu);
}

// The Pro's alert sound, for a caller of its audio_capture.h: a question's chime.
void audio_beep(void) { max_chime(MAX_CHIME_ASK); }
