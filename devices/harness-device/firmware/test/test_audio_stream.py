"""Exercise actual capture/sender loops against an offline synthetic byte sink."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = Path(os.environ.get('AUDIO_STREAM_SOURCE', main / 'audio_client_habitat.c')).read_text()

def function(name):
    match = re.search(r'^static void ' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'

code = r'''
#include "voice_buffer.h"
#include <assert.h>
#include <stdarg.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#define CAPTURE_SAMPLES 160
#define BUFFER_BYTES 32768
#define AUDIO_SAMPLE_RATE 16000
#define CABLE_VOICE_CHUNK 1024
#define CFG_VLANG_MAX 16
#define pdTRUE 1
#define portMAX_DELAY (-1)
#define pdMS_TO_TICKS(ms) (ms)
static const char *TAG="offline-test";
static void log_noop(const char *tag,const char *format,...) {(void)tag;(void)format;}
#define ESP_LOGI(...) log_noop(__VA_ARGS__)
#define ESP_LOGE(...) log_noop(__VA_ARGS__)
typedef void *TaskHandle_t;
static int capture_token, sender_token;
static TaskHandle_t capture_task=&capture_token,sender_task=&sender_token;
static voice_buffer_t buffer;
static atomic_bool active, recording, stop_requested, abort_requested, capture_done, heard;
static atomic_uint input_level;
static char agent[]="target-agent";
enum { VOICE_CMD_NONE,VOICE_CMD_GOAL,VOICE_CMD_LOOP };
static int command;
static uint32_t produced,high_water,read_max_us;
enum { HEALTHY, BEGIN_FAIL, START_FAIL, READ_FAIL, READ_RECOVER, TX_FAIL, OVERFLOW, DMA_LOSS, MODES };
static int mode,role;
static unsigned capture_waits,sender_waits,reads,raw_bytes,sent_bytes,pcm_calls;
static unsigned starts,stops,begins,ends,aborts,notifications,overruns;
static uint64_t clock_us;
static jmp_buf captured,finished;
static void capture(void *unused);
static int64_t esp_timer_get_time(void) {return (int64_t)(clock_us+=100);}
static unsigned uxTaskGetStackHighWaterMark(TaskHandle_t task) {(void)task;return 4096;}
static int ulTaskNotifyTake(int clear,int wait) {
    assert(clear==pdTRUE&&wait==portMAX_DELAY);
    if(role==1) {if(capture_waits++)longjmp(captured,1);}
    else {if(sender_waits++){assert(!active);longjmp(finished,1);}}
    return 1;
}
static void xTaskNotifyGive(TaskHandle_t task) {
    notifications++;
    if(task==sender_task)return;
    assert(task==capture_task&&role==2);role=1;
    if(!setjmp(captured))capture(NULL);
    role=2;
}
static void vTaskDelay(unsigned ticks) {clock_us+=ticks*1000;}
static bool audio_capture_start(void) {starts++;return mode!=START_FAIL;}
static int audio_capture_read(uint8_t *out,int capacity) {
    assert(capacity==CAPTURE_SAMPLES*2);reads++;
    if(mode==READ_FAIL||(mode==READ_RECOVER&&reads<=2))return -1;
    for(int i=0;i<capacity;i++)out[i]=(uint8_t)(raw_bytes+i);
    raw_bytes+=(unsigned)capacity;
    if(mode==DMA_LOSS&&reads==3)overruns++;
    if(mode!=OVERFLOW&&raw_bytes==64*CAPTURE_SAMPLES*2)atomic_store(&stop_requested,true);
    return capacity;
}
static unsigned audio_capture_overruns(void) {return overruns;}
static void audio_capture_stop(void) {stops++;}
static void config_load_voicelang(char *out,size_t n) {snprintf(out,n,"en");}
static bool audio_stream_begin(const char *id,const char *cmd,const char *lang,int rate) {
    assert(id&&!strcmp(id,"target-agent")&&!strcmp(cmd,"")&&!strcmp(lang,"en")&&rate==16000);
    begins++;return mode!=BEGIN_FAIL;
}
static bool audio_stream_pcm(const uint8_t *bytes,size_t n) {
    assert(begins==1&&mode!=BEGIN_FAIL&&n&&n<=CABLE_VOICE_CHUNK);pcm_calls++;
    for(size_t i=0;i<n;i++)assert(bytes[i]==(uint8_t)(sent_bytes+i));
    if(mode==TX_FAIL&&pcm_calls==3)return false;
    sent_bytes+=(unsigned)n;return true;
}
static void audio_stream_end(void) {
    assert(capture_done&&!abort_requested&&sent_bytes==produced);ends++;
}
static void audio_stream_abort(const char *why) {assert(why&&capture_done);aborts++;}
'''
code += function('capture') + function('send_audio')
code += r'''
int main(void) {
    static uint8_t guarded[BUFFER_BYTES+16];
    for(unsigned round=0;round<100;round++)for(mode=0;mode<MODES;mode++) {
        memset(guarded,0xa5,sizeof guarded);voice_buffer_init(&buffer,guarded+8,BUFFER_BYTES);
        if(round&1) {atomic_store(&buffer.head,UINT32_MAX-255);atomic_store(&buffer.tail,UINT32_MAX-255);}
        active=recording=true;stop_requested=abort_requested=capture_done=heard=false;
        input_level=produced=high_water=read_max_us=0;
        capture_waits=sender_waits=reads=raw_bytes=sent_bytes=pcm_calls=0;
        starts=stops=begins=ends=aborts=notifications=overruns=0;clock_us=0;role=2;
        if(!setjmp(finished))send_audio(NULL);
        assert(!active&&!recording&&capture_done&&input_level==0&&begins==1&&starts==1);
        assert(stops==(unsigned)(mode!=START_FAIL));
        assert(high_water<=BUFFER_BYTES);
        if(mode==HEALTHY||mode==READ_RECOVER) {
            assert(ends==1&&!aborts&&sent_bytes==20480&&!voice_buffer_used(&buffer));
        } else {
            assert(!ends&&aborts==1);
            if(mode!=TX_FAIL)assert(!pcm_calls);
        }
        for(int i=0;i<8;i++)assert(guarded[i]==0xa5&&guarded[BUFFER_BYTES+8+i]==0xa5);
    }
    puts("Audio workers: 800 offline sessions; exact PCM order, failed begin/start, read retry/failure, USB failure, ring overflow, DMA loss and 32-bit wrap PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-audio-stream-') as folder:
    out = Path(folder)
    (out / 'stream.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(out / 'stream.c'), str(main / 'voice_buffer.c'),
                    '-o', str(out / 'stream')], check=True)
    subprocess.run([str(out / 'stream')], check=True, timeout=30)
