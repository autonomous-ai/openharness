"""The mic's analog gain comes from AUDIO_MIC_GAIN_DB alone, set once each time the stream opens."""
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
#include <stdio.h>
#include "audio_capture.h"
#define ESP_OK 0
#define ESP_ERR_INVALID_STATE 0x103
#define portMAX_DELAY 0xffffffffu
#define ESP_LOGI(...) ((void)0)
static void log_ignore(const char *fmt,...) { (void)fmt; }
#define ESP_LOGW(tag,...) log_ignore(__VA_ARGS__)
#define ESP_LOGE(tag,...) log_ignore(__VA_ARGS__)
typedef int esp_err_t;
typedef struct { int sample_rate,channel,bits_per_sample; } esp_codec_dev_sample_info_t;
static const char *TAG = "audio_cap";
static int mic, rx, lock;
static void *s_mic = &mic, *s_rx = &rx, *s_codec_lock = &lock;
static bool s_open;
static atomic_bool s_capture_requested;
static atomic_uint s_rx_overruns;
static unsigned gains;
static float gain;
bool audio_capture_init(void) { assert(!"the mic is already initialized"); return false; }
static void xSemaphoreTake(void *p,unsigned wait) { assert(p==s_codec_lock&&wait==portMAX_DELAY); }
static void xSemaphoreGive(void *p) { assert(p==s_codec_lock); }
static int esp_codec_dev_open(void *dev,const esp_codec_dev_sample_info_t *fs) {
    assert(dev==s_mic&&fs->sample_rate==AUDIO_SAMPLE_RATE&&fs->channel==1&&fs->bits_per_sample==16);return ESP_OK;
}
static esp_err_t i2s_channel_enable(void *p) { assert(p==s_rx);return ESP_OK; }
static const char *esp_err_to_name(esp_err_t e) { (void)e;return ""; }
static int esp_codec_dev_set_in_gain(void *dev,float db) { assert(dev==s_mic);gains++;gain=db;return ESP_OK; }
'''
code += function('audio_capture_start')
code += r'''
int main(void) {
    (void)TAG;
    assert(AUDIO_MIC_GAIN_DB==30.0f);
    assert(audio_capture_start()&&s_open);
    assert(gains==1&&gain==AUDIO_MIC_GAIN_DB);
    assert(audio_capture_start()&&gains==1);
    printf("Audio gain: the PGA is set once, from AUDIO_MIC_GAIN_DB (%g dB) PASS (offline)\n",(double)AUDIO_MIC_GAIN_DB);
}
'''
with tempfile.TemporaryDirectory(prefix='harness-audio-gain-') as folder:
    out = Path(folder)
    (out / 'gain.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(out / 'gain.c'), '-o', str(out / 'gain')], check=True)
    subprocess.run([str(out / 'gain')], check=True)
