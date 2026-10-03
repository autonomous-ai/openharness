"""Replay interrupted USB reads through the production reader and real decoder."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = Path(os.environ.get('CABLE_LINK_SOURCE', main / 'cable_link.c')).read_text()
reader = re.search(r'static void reader_task\(void \*arg\)\n\{.*?^\}', source, re.M | re.S).group(0)
defines = '\n'.join(re.findall(r'^#define (?:READ_CHUNK|READ_WAIT_MS|FRAME_IDLE_US) .+$', source, re.M))
code = r'''
#include "cable_link.h"
#include <assert.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define pdMS_TO_TICKS(x) (x)
''' + defines + r'''
typedef struct { const uint8_t *bytes; size_t len; int64_t at; } read_t;
static read_t reads[80];
static unsigned read_count, read_at, frames, ticks;
static int64_t now;
static jmp_buf done;
static cable_decoder_t s_decoder;
static cable_frame_cb s_cb;
static cable_tick_cb s_tick;
static void *s_ctx;
static uint8_t payload[CABLE_MAX_PAYLOAD], frame[CABLE_MAX_FRAME], hello[CABLE_MAX_FRAME];
static size_t expected_size;
static const uint8_t *expected;
static int64_t esp_timer_get_time(void) { return now; }
static int usb_serial_jtag_read_bytes(uint8_t *out, size_t cap, int wait) {
    assert(cap == READ_CHUNK && wait == READ_WAIT_MS);
    if (read_at == read_count) longjmp(done, 1);
    const read_t r = reads[read_at++];
    assert(r.len <= cap); now = r.at;
    if (r.len) memcpy(out, r.bytes, r.len);
    return (int)r.len;
}
static void tick(void *ctx) { assert(!ctx); ticks++; }
static void collect(uint8_t version, uint8_t type, const uint8_t *p, size_t n, void *ctx) {
    assert(!ctx && version == CABLE_FRAME_VERSION && type == CABLE_TYPE_JSON);
    assert(n == expected_size && !memcmp(p, expected, n)); frames++;
}
''' + reader + r'''
static void add(const uint8_t *p, size_t len, int64_t *at, int64_t interval) {
    while (len) {
        size_t n = len > READ_CHUNK ? READ_CHUNK : len;
        assert(read_count < sizeof(reads)/sizeof(reads[0]));
        reads[read_count++] = (read_t){p,n,*at}; *at += interval; p += n; len -= n;
    }
}
static void reset(void) {
    read_count = read_at = frames = ticks = 0; now = 0;
    cable_decoder_init(&s_decoder);
    s_decoder.corrupt_frames = 7; s_decoder.discarded_bytes = 11;
    s_cb = collect; s_tick = tick; s_ctx = NULL;
}
static void run(void) {
    if (!setjmp(done)) reader_task(NULL);
    assert(ticks == read_count && frames == 1 && !s_decoder.len);
    assert(s_decoder.corrupt_frames == 7 && s_decoder.discarded_bytes == 11);
}
int main(void) {
    // The old incomplete frame claims the maximum legal length. A later short
    // welcome fits inside that missing payload, so magic/CRC alone cannot rescue it.
    for (size_t i=0; i<sizeof(payload); i++) payload[i]=(uint8_t)(i*71+9);
    int frame_n = cable_frame_encode(CABLE_TYPE_JSON,payload,sizeof(payload),frame,sizeof(frame));
    static const uint8_t greeting[] = "{\"t\":\"welcome\"}";
    int hello_n = cable_frame_encode(CABLE_TYPE_JSON,greeting,sizeof(greeting)-1,hello,sizeof(hello));
    assert(frame_n > 0 && hello_n > 0);
    unsigned checks=0;
    reset(); int64_t first_at=0;
    expected=greeting; expected_size=sizeof(greeting)-1;
    add(frame,CABLE_HEADER_BYTES,&first_at,1000);
    first_at+=15000000;
    add(hello,(size_t)hello_n,&first_at,1000);
    run(); checks++;
    for (int cut=1; cut<frame_n; cut++) for (int idle=0; idle<2; idle++) {
        reset(); int64_t at=0;
        expected=greeting; expected_size=sizeof(greeting)-1;
        add(frame,(size_t)cut,&at,1000);
        at += 15000000;
        if (idle) reads[read_count++]=(read_t){NULL,0,at++};
        add(hello,(size_t)hello_n,&at,1000);
        run(); checks++;
    }
    // A valid frame may take longer than the timeout in total. Only the gap
    // between reads matters; every fragment just below 15 seconds stays intact.
    for (int cut=1; cut<frame_n; cut++) {
        reset(); int64_t at=(INT64_C(1)<<32)-20;
        expected=payload; expected_size=sizeof(payload);
        add(frame,(size_t)cut,&at,14999999);
        add(frame+cut,(size_t)(frame_n-cut),&at,14999999);
        run(); checks++;
    }
    // Idle before the first welcome and repeated empty reads are ordinary.
    reset(); int64_t at=90000000;
    reads[read_count++]=(read_t){NULL,0,0};
    reads[read_count++]=(read_t){NULL,0,at};
    expected=greeting; expected_size=sizeof(greeting)-1;
    add(hello,(size_t)hello_n,&at,1000);run();checks++;
    printf("cable idle: PASS (%u production-reader traces; every interrupted-frame cut, idle/read-gap recovery, slow valid fragments, 64-bit clock and retained counters)\n",checks);
}
'''
with tempfile.TemporaryDirectory(prefix='harness-cable-idle-') as d:
    root = Path(d)
    (root / 'idle.c').write_text(code)
    subprocess.run(['cc', '-std=gnu11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-O1',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), str(root / 'idle.c'), str(main / 'cable_frame.c'),
                    '-o', str(root / 'idle')], check=True)
    subprocess.run([str(root / 'idle')], check=True)
