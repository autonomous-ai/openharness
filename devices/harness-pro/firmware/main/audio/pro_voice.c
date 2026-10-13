// The Pro's voice state machine: what pro_app (app/pro_voice.h) calls, over the recorder (pro_recorder.h) and the
// cable (pro_cable_voice_*). Ported from the round firmware's Pod voice path in ui_habitat.c (A_VOICE, A_VOICE_STOP,
// A_VOICE_ABORT and the voice timers in habitat_tick) and audio_client_habitat.c.
//
// LOCK ORDER. This file takes exactly one lock, s_mux, a leaf spinlock that guards four scalars and is never held
// across a call (no cable send, no pro_app_*, no recorder call). The getters pro_app's tick reads before it takes its
// own lock (pro_voice_open / _waiting / _start_pending) are atomics only. So the order is: pro_app's mutex is never
// held when a pro_voice_* function runs (app/pro_voice.h), and pro_voice_* calls pro_app_notice only after releasing
// s_mux, so pro_app's mutex can be taken there without any voice lock held. Cable sends happen with no lock at all.
#include "app/pro_voice.h"

#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "app/pro_app.h"
#include "audio/audio_capture.h"
#include "audio/pro_recorder.h"
#include "cable/pro_cable.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sys/config_store.h"

#define CAP_MS 600000u         // the 600 s duration cap (UH:5265)
#define REPLY_WAIT_MS 65000u   // how long a sent clip waits for the daemon's reply
#define DEAD_MS 700u           // a recorder that stopped by itself this long after the start
#define START_MS 5000u         // the mic never opened

static const char *TAG = "pro_voice";
static atomic_bool s_open, s_waiting;
// STARTING: pro_voice_begin is between claiming the recording and pro_rec_start returning. pro_voice_tick ignores
// the voice until it clears, so it never judges (and discards) a start that is still being assembled.
static atomic_bool s_starting;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_started_ms, s_wait_until;
static char s_upload[24];

static uint32_t ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

bool pro_voice_init(void)
{
    const bool rec = pro_rec_init();
    // Opening the I2S channels and the codec at boot, not on the first press: the first recording must not wait for
    // them, and a large contiguous block is hard to get later.
    if (!audio_capture_init()) ESP_LOGW(TAG, "microphone not ready at boot; it is retried on the first recording");
    return rec;
}

bool pro_voice_open(void) { return atomic_load(&s_open); }
bool pro_voice_waiting(void) { return atomic_load(&s_waiting); }
// Begun but the recorder has not opened the microphone yet.
bool pro_voice_start_pending(void) { return atomic_load(&s_open) && !atomic_load(&s_waiting) && !pro_rec_mic_tried(); }

#ifdef PRO_VOICE_TEST_HOOK
// Host replay only: runs between the steps of pro_voice_begin so a test can interleave the render task's tick.
extern void pro_voice_test_step(int step);
#define TEST_STEP(n) pro_voice_test_step(n)
#else
#define TEST_STEP(n) ((void)0)
#endif

void pro_voice_begin(const char *agent_id)
{
    bool expected = false;
    if (!atomic_compare_exchange_strong(&s_starting, &expected, true)) return;   // another begin is mid-flight
    TEST_STEP(1);
    expected = false;
    // Open at once so the Talk frame is never judged "no recording behind it"; STARTING keeps the tick away.
    if (!atomic_compare_exchange_strong(&s_open, &expected, true)) {   // a recording or a send is in flight
        atomic_store(&s_starting, false);
        return;
    }
    TEST_STEP(2);
    char lang[CFG_VLANG_MAX];
    config_load_voicelang(lang, sizeof lang);   // NVS: may block, which is why the tick must not run meanwhile
    TEST_STEP(3);
    char upload[24];
    snprintf(upload, sizeof upload, "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
    portENTER_CRITICAL(&s_mux);
    snprintf(s_upload, sizeof s_upload, "%s", upload);
    s_started_ms = ms();
    portEXIT_CRITICAL(&s_mux);
    atomic_store(&s_waiting, false);
    TEST_STEP(4);
    const bool started = pro_rec_start(agent_id, lang, upload);   // unavailable, or the last clip is still finishing
    TEST_STEP(5);
    if (!started) atomic_store(&s_open, false);
    atomic_store(&s_starting, false);
    // A link drop or a discard that landed while the recorder was starting found nothing to stop: do it now, quietly,
    // so the microphone is never left streaming for a recording that is no longer open.
    if (started && !atomic_load(&s_open)) pro_rec_abort(true);
}

// Discard the utterance and tell the daemon (A_VOICE_ABORT): stop the recorder, close the state, and cancel the
// host's work, which the recorder's own abort cannot reach once the clip has been sent.
static void discard(void)
{
    char upload[24];
    portENTER_CRITICAL(&s_mux);
    snprintf(upload, sizeof upload, "%s", s_upload);
    portEXIT_CRITICAL(&s_mux);
    atomic_store(&s_open, false);
    atomic_store(&s_waiting, false);
    pro_rec_abort(false);
    (void)pro_cable_voice_cancel(upload);
}

void pro_voice_end(bool send)
{
    if (!atomic_load(&s_open)) return;
    if (send) {
        if (atomic_load(&s_waiting)) return;   // the clip already went; its reply is awaited
        if (!pro_voice_start_pending() && pro_rec_recording()) {
            portENTER_CRITICAL(&s_mux);
            s_wait_until = ms() + REPLY_WAIT_MS;
            portEXIT_CRITICAL(&s_mux);
            atomic_store(&s_waiting, true);   // before the stop, so the tick never sees "stopped, not waiting"
            pro_rec_stop();
            return;
        }
        // Nothing to send: the mic never opened, or the recorder already died. Fall through to discard.
    }
    discard();
}

void pro_voice_close(void)
{
    atomic_store(&s_open, false);
    atomic_store(&s_waiting, false);
    // A reply that arrives while the mic is still open (the daemon refused the clip) ends the recording too; the
    // daemon already knows, so nothing is sent back.
    if (pro_rec_recording()) pro_rec_abort(true);
}

void pro_voice_link_lost(void)
{
    atomic_store(&s_open, false);
    atomic_store(&s_waiting, false);
    pro_rec_abort(true);   // the cable is dead: send nothing; the sender finishes quietly
}

void pro_voice_tick(uint32_t now)
{
    if (!atomic_load(&s_open) || atomic_load(&s_starting)) return;
    uint32_t started, wait_until;
    portENTER_CRITICAL(&s_mux);
    started = s_started_ms;
    wait_until = s_wait_until;
    portEXIT_CRITICAL(&s_mux);
    const bool waiting = atomic_load(&s_waiting);
    const uint32_t age = now - started;
    const char *notice = NULL;
    if (!waiting && pro_rec_recording() && age / 1000 >= CAP_MS / 1000) {
        // The 600 s cap: finish exactly as a tap on Done would. pro_app_tick then leaves Talk (waiting).
        portENTER_CRITICAL(&s_mux);
        s_wait_until = now + REPLY_WAIT_MS;
        portEXIT_CRITICAL(&s_mux);
        atomic_store(&s_waiting, true);
        pro_rec_stop();
        return;
    }
    if (waiting && (int32_t)(now - wait_until) >= 0) notice = "No response yet. Check Harness on your computer.";
    else if (!waiting && pro_voice_start_pending() && age > START_MS) notice = "The microphone did not start.";
    else if (!waiting && !pro_voice_start_pending() && !pro_rec_active() && age > DEAD_MS)
        notice = "Recording stopped. Please try again.";
    if (!notice) return;
    discard();
    pro_app_notice(notice);   // no voice lock is held here
}
