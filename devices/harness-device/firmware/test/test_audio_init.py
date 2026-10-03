"""Fail every codec initialization step; retries must not leak or double-free."""
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
#include <stdlib.h>
#include "audio_capture.h"
#define DEVICE_HABITAT 1
#define ESP_OK 0
#define pdPASS 1
#define ESP_LOGI(...) ((void)0)
static void log_ignore(const char *fmt,...) { (void)fmt; }
#define ESP_LOGW(tag,...) log_ignore(__VA_ARGS__)
#define ESP_LOGE(tag,...) log_ignore(__VA_ARGS__)
#define I2S_NUM_0 0
#define I2C_NUM_0 0
#define I2S_ROLE_MASTER 0
#define I2S_CHANNEL_DEFAULT_CONFIG(a,b) ((i2s_chan_config_t){0})
#define I2S_STD_CLK_DEFAULT_CONFIG(a) 0
#define I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(a,b) 0
#define BSP_I2S_MCLK 0
#define BSP_I2S_BCLK 1
#define BSP_I2S_WS 2
#define BSP_I2S_DOUT 3
#define BSP_I2S_DIN 4
#define BSP_PA_IO 5
#define ES7210_CODEC_DEFAULT_ADDR 0
#define ES8311_CODEC_DEFAULT_ADDR 1
#define ESP_CODEC_DEV_WORK_MODE_DAC 1
#define ESP_CODEC_DEV_TYPE_IN 1
#define ESP_CODEC_DEV_TYPE_OUT 2
typedef struct resource { int kind; bool enabled; struct resource *dependency; } resource;
typedef struct { int dma_frame_num,dma_desc_num; } i2s_chan_config_t;
typedef struct { int clk_cfg,slot_cfg; struct { int mclk,bclk,ws,dout,din;struct{bool mclk_inv,bclk_inv,ws_inv;}invert_flags;}gpio_cfg; } i2s_std_config_t;
typedef struct { bool (*on_recv_q_ovf)(void *,void *,void *); } i2s_event_callbacks_t;
typedef struct { int port; resource *rx_handle,*tx_handle; } audio_codec_i2s_cfg_t;
typedef struct { int port,addr; void *bus_handle; } audio_codec_i2c_cfg_t;
typedef struct { resource *ctrl_if; } es7210_codec_cfg_t;
typedef struct { resource *ctrl_if,*gpio_if; int codec_mode,pa_pin;bool use_mclk; } es8311_codec_cfg_t;
typedef struct { int dev_type;resource *codec_if,*data_if; } esp_codec_dev_cfg_t;
static resource *s_codec_lock,*s_tx,*s_rx,*s_data_if,*s_ctrl_if,*s_es7210,*s_mic;
static resource *s_spk_ctrl,*s_gpio_if,*s_es8311,*s_spk,*s_beep_task;
static atomic_bool s_muted;
static unsigned operation, fail_at,live;
static bool fail(void) { return ++operation==fail_at; }
static resource *acquire(int kind,resource *dependency) {
    resource *p=calloc(1,sizeof *p);assert(p);p->kind=kind;p->dependency=dependency;live++;return p;
}
static void release(resource *p) { assert(p&&live);if(p->dependency)assert(p->dependency->kind);p->kind=0;live--;free(p); }
static resource *xSemaphoreCreateMutex(void) { return fail()?NULL:acquire(1,NULL); }
static void vSemaphoreDelete(resource *p) { release(p); }
static int i2s_new_channel(const i2s_chan_config_t *cfg,resource **tx,resource **rx) {
    assert(cfg->dma_desc_num==12&&cfg->dma_frame_num==160);
    if(fail())return 1;*tx=acquire(2,NULL);
    if(fail())return 1;*rx=acquire(2,NULL);return ESP_OK;
}
static int i2s_channel_init_std_mode(resource *p,const i2s_std_config_t *cfg) { (void)cfg;assert(p);return fail(); }
static int i2s_channel_register_event_callback(resource *p,const i2s_event_callbacks_t *cb,void *ctx) { (void)ctx;assert(p&&cb->on_recv_q_ovf);return fail(); }
static int i2s_channel_enable(resource *p) { assert(p);if(fail())return 1;p->enabled=true;return 0; }
static int i2s_channel_disable(resource *p) { assert(p);p->enabled=false;return 0; }
static void i2s_del_channel(resource *p) { assert(!p->enabled);release(p); }
static resource *audio_codec_new_i2s_data(const audio_codec_i2s_cfg_t *c) { assert(c->tx_handle&&c->rx_handle);return fail()?NULL:acquire(3,c->rx_handle); }
static resource *audio_codec_new_i2c_ctrl(const audio_codec_i2c_cfg_t *c) { (void)c;return fail()?NULL:acquire(4,NULL); }
static resource *audio_codec_new_gpio(void) { return fail()?NULL:acquire(5,NULL); }
static resource *es7210_codec_new(const es7210_codec_cfg_t *c) { assert(c->ctrl_if);return fail()?NULL:acquire(6,c->ctrl_if); }
static resource *es8311_codec_new(const es8311_codec_cfg_t *c) { assert(c->ctrl_if&&c->gpio_if);return fail()?NULL:acquire(6,c->ctrl_if); }
static resource *esp_codec_dev_new(const esp_codec_dev_cfg_t *c) { assert(c->codec_if&&c->data_if);return fail()?NULL:acquire(7,c->codec_if); }
static void esp_codec_dev_delete(resource *p) { release(p); }
static void audio_codec_delete_codec_if(resource *p) { release(p); }
static void audio_codec_delete_ctrl_if(resource *p) { release(p); }
static void audio_codec_delete_gpio_if(resource *p) { release(p); }
static void audio_codec_delete_data_if(resource *p) { release(p); }
static void *board_i2c_get(void) { return (void *)1; }
static bool config_load_muted(void) { return true; }
static void config_save_muted(bool on) { assert(on); }
bool audio_notify_is_muted(void) { return atomic_load(&s_muted); }
static bool rx_overrun(void *a,void *b,void *c) { (void)a;(void)b;(void)c;return false; }
static void beep_task(void *arg) { (void)arg; }
static int xTaskCreate(void (*fn)(void *),const char *name,int stack,void *arg,int priority,resource **task) {
    (void)name;(void)arg;(void)priority;assert(fn==beep_task&&stack==4096);
    if(fail())return 0;*task=acquire(8,NULL);return pdPASS;
}
'''
for name in ['capture_init_failed', 'audio_capture_init', 'notify_init_failed', 'audio_notify_init']:
    code += function(name)
code += r'''
static void assert_mic_empty(void) {
    assert(!s_codec_lock&&!s_tx&&!s_rx&&!s_data_if&&!s_ctrl_if&&!s_es7210&&!s_mic&&!live);
}
int main(void) {
    assert(audio_capture_init());unsigned steps=operation;assert(live==7);
    unsigned before=operation;assert(audio_capture_init()&&operation==before);
    capture_init_failed("test cleanup");assert_mic_empty();
    for(unsigned step=1;step<=steps;step++) {
        operation=0;fail_at=step;assert(!audio_capture_init());assert_mic_empty();
        operation=fail_at=0;assert(audio_capture_init());capture_init_failed("retry cleanup");assert_mic_empty();
    }
    operation=fail_at=0;assert(audio_capture_init());unsigned mic_live=live;
    operation=0;audio_notify_init();unsigned speaker_steps=operation;assert(s_beep_task&&live==mic_live+5);
    before=operation;audio_notify_init();assert(operation==before);
    release(s_beep_task);s_beep_task=NULL;notify_init_failed("test cleanup");assert(live==mic_live);
    for(unsigned step=1;step<=speaker_steps;step++) {
        operation=0;fail_at=step;audio_notify_init();
        assert(!s_spk_ctrl&&!s_gpio_if&&!s_es8311&&!s_spk&&!s_beep_task&&live==mic_live);
        operation=fail_at=0;audio_notify_init();assert(s_beep_task);
        release(s_beep_task);s_beep_task=NULL;notify_init_failed("retry cleanup");assert(live==mic_live);
    }
    capture_init_failed("final cleanup");assert_mic_empty();
    printf("Audio init: %u microphone + %u speaker failure points, partial channel allocation and retries, no leaked resources PASS (offline)\n",steps,speaker_steps);
}
'''
with tempfile.TemporaryDirectory(prefix='harness-audio-init-') as folder:
    out = Path(folder)
    (out / 'init.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(out / 'init.c'), '-o', str(out / 'init')], check=True)
    subprocess.run([str(out / 'init')], check=True)
