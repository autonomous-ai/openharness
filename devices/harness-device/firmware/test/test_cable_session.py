"""Run the real connection loops with an adversarial task-start/read schedule."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
client = (main / 'cable_client.c').read_text()
link = (main / 'cable_link.c').read_text()

def function(source, name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'

# Single-writer ownership is part of the contract, not a timing hope.
assert 'session_down(' not in function(client, 'session_task')
assert 's_last_rx_us' not in function(client, 'session_task')
assert 'static int64_t' in client and 'static atomic_bool' in client

code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdatomic.h>
#include <setjmp.h>
#define READ_CHUNK 256
#define READ_WAIT_MS 100
#define FRAME_IDLE_US INT64_C(15000000)
#define SILENCE_MS 15000
#define READER_STACK 6144
#define USJ_TX_BUF 2048
#define USJ_RX_BUF 32768
#define CABLE_FRAME_VERSION 1
#define CABLE_MAX_FRAME 8204
#define CABLE_MAX_AGENTS 4
#define CABLE_PROTO_VERSION 3
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define ESP_OK 0
#define pdPASS 1
#define pdMS_TO_TICKS(ms) (ms)
typedef int esp_err_t;
typedef void (*cable_frame_cb)(uint8_t,uint8_t,const uint8_t *,size_t,void *);
typedef void (*cable_tick_cb)(void *);
typedef struct { int tx_buffer_size,rx_buffer_size; } usb_serial_jtag_driver_config_t;
static bool connected, driver, fail_driver, fail_reader, new_task_ready, s_started;
typedef void *TaskHandle_t;
static TaskHandle_t hello_handle;
static unsigned attempts, fail_at, live, hellos, notifications;
static atomic_bool s_session, s_running;
static void *s_tx_lock, *s_agents_lock, *s_models_sem;
static int s_machines;
static int64_t now, s_last_rx_us;
static unsigned read_index, ticks, down_count, frames;
static int owner;
static jmp_buf loop_done;
static cable_frame_cb s_cb;
static cable_tick_cb s_tick;
static void *s_ctx;
typedef struct {size_t len;} decoder_t;
static decoder_t s_decoder;
typedef int cable_agent_t;
static cable_agent_t *s_agents;
static int64_t esp_timer_get_time(void) { return now; }
static void fw_update_tick(void) {}
static void ui_set_connected(bool value) { connected = value; }
static void session_down(const char *why) {
    (void)why; assert(owner == 1); down_count++; s_session = false; connected = false;
}
'''
code += function(client, 'session_tick')
code += r'''
static void on_frame(uint8_t version,uint8_t type,const uint8_t *p,size_t n,void *ctx) {
    (void)version; (void)type; (void)p; (void)n; assert(ctx == NULL && owner == 1);
    frames++; s_last_rx_us = now; s_session = true; connected = true;
}
static void cable_decoder_init(decoder_t *d) { d->len = 0; }
static void cable_decoder_reset(decoder_t *d) { d->len = 0; }
static void cable_decoder_feed(decoder_t *d,const uint8_t *p,size_t n,cable_frame_cb cb,void *ctx) {
    (void)d; assert(n == 1); cb(1,1,p,n,ctx);
}
static void counted_tick(void *ctx) { ticks++; session_tick(ctx); }
static int usb_serial_jtag_read_bytes(uint8_t *p,size_t n,int timeout) {
    assert(n == READ_CHUNK && timeout == 100 && owner == 1);
    switch (read_index++) {
    case 0: now = (INT64_C(1) << 32) - 1; p[0] = 0; return 1;
    case 1: now += 100; return 0; // 32-bit low word rolled over, still connected.
    case 2: assert(s_session); now += INT64_C(15000001); return -1;
    case 3: assert(!s_session && down_count == 1); p[0] = 0; return 1;
    default: assert(s_session && down_count == 1); longjmp(loop_done,1);
    }
}
static bool allocation(void) { return ++attempts != fail_at; }
static void *tracked_calloc(size_t n,size_t size) {
    if(!allocation())return NULL;
    void *p=calloc(n,size);assert(p);live++;return p;
}
static void tracked_free(void *p) { if(p){assert(live);live--;free(p);} }
static void *xSemaphoreCreateMutex(void) { return tracked_calloc(1,1); }
static void *xSemaphoreCreateBinary(void) { return tracked_calloc(1,1); }
static void vSemaphoreDelete(void *lock) { assert(lock);tracked_free(lock); }
static int usb_serial_jtag_driver_install(const usb_serial_jtag_driver_config_t *cfg) {
    assert(cfg->rx_buffer_size == USJ_RX_BUF);
    driver = allocation() && !fail_driver; return !driver;
}
static void usb_serial_jtag_driver_uninstall(void) { driver = false; }
static void cable_machines_init(int *m) { *m = 1; }
static void session_task(void *arg) { (void)arg; }
static void reader_task(void *arg);
static int xTaskCreate(void (*task)(void *),const char *name,int stack,void *arg,int priority,void *handle) {
    (void)name; (void)stack; (void)arg; (void)priority;
    if(!allocation())return 0;
    if (task != reader_task) {
        assert(task == session_task && handle && !hellos);
        hello_handle=(void *)2;*(TaskHandle_t *)handle=hello_handle;hellos++;return pdPASS;
    }
    if (fail_reader) return 0;
    assert(driver && s_running && s_tick && !connected && s_last_rx_us == now);
    // A welcome can arrive on the new reader before xTaskCreate returns.
    owner = 1; s_cb(1,1,NULL,0,s_ctx); owner = 0; new_task_ready = true;
    return pdPASS;
}
static void vTaskDelete(TaskHandle_t task) { assert(task==hello_handle&&hellos);hellos--;hello_handle=NULL; }
static void xTaskNotifyGive(TaskHandle_t task) {
    assert(task==hello_handle&&hellos&&s_running&&driver&&new_task_ready);notifications++;
}
#define calloc tracked_calloc
#define free tracked_free
'''
code += function(link, 'reader_task')
code += function(link, 'cable_link_start')
code += function(client, 'cable_client_start')
code += r'''
int main(void) {
    // Array, both metadata locks, handshake task, transmit lock, driver, reader.
    // Every startup failure must release all resources and allow a clean retry.
    for(unsigned failure=1;failure<=7;failure++) {
        attempts=0;fail_at=failure;
        assert(!cable_client_start());
        assert(!s_agents&&!s_agents_lock&&!s_models_sem&&!s_tx_lock&&!s_started);
        assert(!s_running&&!driver&&!hellos&&!live&&!notifications);
    }
    attempts=fail_at=0;
    now = 91; assert(cable_client_start());
    assert(new_task_ready && s_running && connected && s_session && notifications==1);
    unsigned calls=attempts;assert(cable_client_start());assert(calls==attempts&&notifications==1);
    s_tick = counted_tick; owner = 1;
    if (!setjmp(loop_done)) reader_task(NULL);
    assert(ticks == 4 && frames == 3 && down_count == 1);
    owner = 0; s_running = false; connected = false;
    vSemaphoreDelete(s_tx_lock);s_tx_lock=NULL;usb_serial_jtag_driver_uninstall();
    fail_driver = true; assert(!cable_link_start(on_frame,session_tick,NULL));
    assert(!s_running && !driver && !s_tx_lock);
    fail_driver = false; fail_reader = true;
    assert(!cable_link_start(on_frame,session_tick,NULL));
    assert(!s_running && !driver && !s_tx_lock);
    free(s_agents);
    vSemaphoreDelete(s_agents_lock);vSemaphoreDelete(s_models_sem);vTaskDelete(hello_handle);
    assert(!live&&!hellos);
    puts("USB session: seven startup failures/retries, idempotence, early welcome, idle/error reads, timeout/reconnect and 64-bit wrap PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-cable-session-') as folder:
    out = Path(folder)
    (out / 'session.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    str(out / 'session.c'), '-o', str(out / 'session')], check=True)
    subprocess.run([str(out / 'session')], check=True)
