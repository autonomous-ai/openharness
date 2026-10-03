"""Exercise production log framing while the USB writer is busy or re-enters."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = (main / 'cable_link.c').read_text()

def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'

code = r'''
#include "cable_frame.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define LOG_WRITE_WAIT_MS 5
#define LOG_LINE_MAX 512
#define pdTRUE 1
#define pdMS_TO_TICKS(ms) (ms)
typedef int TickType_t;
typedef int (*vprintf_like_t)(const char *,va_list);
static bool isr, lock_busy, recurse, stalled;
static atomic_bool s_running, s_log_framing;
static atomic_uint s_dropped_logs;
static int owner, s_tx_lock=1, taken, plain_calls, framed, installed;
static uint8_t s_tx_frame[CABLE_MAX_FRAME], wire[8192];
static size_t wire_bytes;
static char saved[LOG_LINE_MAX];
static vprintf_like_t hook;
static int plain(const char *fmt,va_list args) { (void)fmt; (void)args;plain_calls++;return 1; }
static _Atomic(vprintf_like_t) s_prev_vprintf=plain;
static bool xPortInIsrContext(void) { return isr; }
static int xTaskGetCurrentTaskHandle(void) { return 9; }
static int xSemaphoreGetMutexHolder(int lock) { assert(lock==1);return owner; }
static bool xSemaphoreTake(int lock,int wait) {
    assert(lock==1&&wait==5&&owner!=9);taken++;
    if(lock_busy)return false;
    assert(!owner);owner=9;return true;
}
static void xSemaphoreGive(int lock) { assert(lock==1&&owner==9);owner=0; }
static int log_vprintf(const char *fmt,va_list args);
static int log_line(const char *fmt,...) {
    va_list args;va_start(args,fmt);int n=log_vprintf(fmt,args);va_end(args);return n;
}
static int usb_serial_jtag_write_bytes(const void *p,size_t len,int wait) {
    assert(owner==9&&wait==5);
    if(recurse){recurse=false;assert(log_line("recursive driver log")==0);}
    if(stalled)return 0;
    assert(wire_bytes+len<=sizeof wire);memcpy(wire+wire_bytes,p,len);wire_bytes+=len;return (int)len;
}
static void last_words_add(const char *p,size_t n) { assert(n<sizeof saved);memcpy(saved,p,n);saved[n]=0; }
static vprintf_like_t esp_log_set_vprintf(vprintf_like_t next) {
    vprintf_like_t old=hook;hook=next;installed++;return old;
}
'''
code += function('send_locked') + function('log_vprintf') + function('cable_link_set_log_framing')
code += r'''
static void received(uint8_t version,uint8_t type,const uint8_t *p,size_t n,void *ctx) {
    (void)ctx;assert(version==CABLE_FRAME_VERSION&&type==CABLE_TYPE_LOG);
    if(framed==0){assert(n==7&&!memcmp(p,"hello 7",n));}
    else if(framed==1){assert(n==5&&!memcmp(p,"outer",n));}
    else {assert(n==511);for(size_t i=0;i<n;i++)assert(p[i]=='x');}
    framed++;
}
int main(void) {
    hook=plain;s_running=true;
    cable_link_set_log_framing(true);assert(hook==log_vprintf&&installed==1);
    cable_link_set_log_framing(true);assert(installed==1);
    assert(log_line("hello %d\r\n",7)==9&&!strcmp(saved,"hello 7"));
    assert(!plain_calls&&!atomic_load(&s_dropped_logs)&&!owner);
    lock_busy=true;owner=8;assert(!log_line("congested"));assert(!plain_calls);
    lock_busy=false;owner=9;int before=taken;assert(!log_line("already owns tx"));
    assert(taken==before);owner=0;
    isr=true;assert(!log_line("ISR"));assert(taken==before);isr=false;
    recurse=true;assert(log_line("outer")==5);assert(atomic_load(&s_dropped_logs)==3);
    stalled=true;before=(int)wire_bytes;assert(log_line("not draining")==12);
    assert((int)wire_bytes==before&&!plain_calls&&!strcmp(saved,"not draining"));stalled=false;
    assert(atomic_load(&s_dropped_logs)==4);
    char long_line[2048];memset(long_line,'x',sizeof long_line-1);long_line[sizeof long_line-1]=0;
    assert(log_line("%s",long_line)==2047&&strlen(saved)==511);
    cable_decoder_t decoder;cable_decoder_init(&decoder);
    cable_decoder_feed(&decoder,wire,wire_bytes,received,NULL);
    assert(framed==3&&!decoder.corrupt_frames&&!decoder.discarded_bytes);
    cable_link_set_log_framing(false);assert(hook==plain&&installed==2);
    // A previously captured hook may still execute after removal on another core.
    assert(log_line("late callback")==1&&plain_calls==1);
    cable_link_set_log_framing(false);assert(installed==2);
    cable_link_set_log_framing(true);assert(hook==log_vprintf&&installed==3);
    puts("USB logging: bounded contention, same-task recursion, ISR, late hook, truncation; exact framed bytes PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-cable-log-') as folder:
    out = Path(folder)
    (out / 'log.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(out / 'log.c'), str(main / 'cable_frame.c'),
                    '-o', str(out / 'log')], check=True)
    subprocess.run([str(out / 'log')], check=True)
