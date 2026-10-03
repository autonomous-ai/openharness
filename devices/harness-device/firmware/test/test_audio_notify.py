"""Offline waveform equivalence and mute/mic preemption; no physical audio."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = (main / 'audio_capture.c').read_text()

def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'

code = r'''
#include <assert.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include "audio_capture.h"
#define ESP_OK 0
#define ESP_CODEC_DEV_OK 0
#define pdTRUE 1
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
typedef struct { int sample_rate,channel,bits_per_sample; } esp_codec_dev_sample_info_t;
static int s_spk=1,s_codec_lock=1,s_beep_task=1,held,opens,closes,writes,notifications;
static atomic_bool s_capture_requested;
static bool muted,open_fail,write_fail,mute_on_lock,reenter;
static int stop_after,mute_after;
static int16_t received[10000];
static size_t received_count;
static int64_t clock_us;
bool audio_notify_is_muted(void) { return muted; }
static bool xSemaphoreTake(int lock,int ticks) {
    assert(lock==1&&ticks==0);if(held)return false;held=1;if(mute_on_lock)muted=true;return true;
}
static void xSemaphoreGive(int lock) { assert(lock==1&&held);held=0; }
static int esp_codec_dev_open(int dev,const esp_codec_dev_sample_info_t *fs) {
    assert(dev==1&&held&&fs->sample_rate==AUDIO_SAMPLE_RATE);opens++;return open_fail;
}
static void esp_codec_dev_set_out_vol(int dev,int v) { assert(dev==1&&v==100&&held); }
static void esp_codec_dev_close(int dev) { assert(dev==1&&held);closes++; }
static int esp_codec_dev_write(int dev,void *p,int bytes) {
    assert(dev==1&&held&&bytes>0&&bytes<=AUDIO_SAMPLE_RATE*2/50);writes++;
    if(write_fail)return 1;
    assert(received_count+(size_t)bytes/2<10000);
    memcpy(received+received_count,p,(size_t)bytes);received_count+=(size_t)bytes/2;
    if(stop_after&&writes==stop_after)atomic_store(&s_capture_requested,true);
    if(mute_after&&writes==mute_after)muted=true;
    return 0;
}
static void xTaskNotifyGive(int task) { assert(task==1);notifications++; }
static int64_t esp_timer_get_time(void) {
    int64_t sampled=clock_us;
    if(reenter){reenter=false;clock_us+=1000;audio_notify_done();}
    return sampled;
}
'''
for line in source.splitlines():
    if re.match(r'#define (BEEP_|GAP_|TONE_)', line) or line.startswith('static int16_t s_tone['):
        code += line + '\n'
for name in ['render_tone', 'play_beep', 'audio_notify_done']:
    code += function(name)
code += r'''
static void reset(void) {
    muted=open_fail=write_fail=mute_on_lock=false;atomic_store(&s_capture_requested,false);
    held=opens=closes=writes=stop_after=mute_after=0;received_count=0;
}
int main(void) {
    int16_t original[TONE_SAMPLES];int at=0;
    // The old full-waveform construction, retained as the reference.
    const int half=AUDIO_SAMPLE_RATE/2000/2;
    for(int b=0;b<BEEP_COUNT;b++) {
        for(int n=0;n<BEEP_SAMPLES;n++)original[at++]=((n/(half>0?half:1))&1)?6000:-6000;
        if(b<BEEP_COUNT-1)for(int n=0;n<GAP_SAMPLES;n++)original[at++]=0;
    }
    assert(at==TONE_SAMPLES&&sizeof s_tone==640);
    reset();play_beep();assert(!held&&opens==1&&closes==1&&received_count==TONE_SAMPLES);
    assert(!memcmp(original,received,sizeof original));
    reset();muted=true;play_beep();assert(!opens&&!writes);
    reset();atomic_store(&s_capture_requested,true);play_beep();assert(!opens&&!writes);
    reset();mute_on_lock=true;play_beep();assert(!held&&!opens&&!writes);
    reset();held=1;play_beep();assert(!opens&&!writes);held=0;
    for(int n=1;n<18;n++) {
        reset();stop_after=n;play_beep();assert(writes==n&&!held&&closes==1);
        assert(!memcmp(original,received,received_count*sizeof *received));
        reset();mute_after=n;play_beep();assert(writes==n&&!held&&closes==1);
    }
    reset();open_fail=true;play_beep();assert(!held&&opens==1&&!closes&&!writes);
    reset();write_fail=true;play_beep();assert(!held&&opens==1&&closes==1&&writes==1);
    reset();clock_us=1000000;audio_notify_done();assert(notifications==1);
    clock_us=1999000;audio_notify_done();assert(notifications==1);
    clock_us=2000000;audio_notify_done();assert(notifications==2);
    clock_us=3000000;reenter=true;audio_notify_done();assert(notifications==3);
    clock_us=(int64_t)(UINT32_MAX-500u)*1000;audio_notify_done();assert(notifications==4);
    clock_us=((INT64_C(1)<<32)+498)*1000;audio_notify_done();assert(notifications==4);
    clock_us+=1000;audio_notify_done();assert(notifications==5);
    muted=true;clock_us+=1000000;audio_notify_done();assert(notifications==5);
    puts("Notification: exact 5760-sample waveform with 640B buffer; mute/mic/error release, concurrent debounce and wrap PASS (offline)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-notify-') as folder:
    out = Path(folder)
    (out / 'notify.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(out / 'notify.c'), '-o', str(out / 'notify')], check=True)
    subprocess.run([str(out / 'notify')], check=True)
