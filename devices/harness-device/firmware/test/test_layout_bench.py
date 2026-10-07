"""Validate diagnostic workloads/exit paths before flashing the display benchmark."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

native = Path(__file__).resolve().parent / '../main/ui/habitat'
source = re.sub(r'^#include .*\n', '', (native/'layout_bench.c').read_text(), flags=re.M)
code = r'''
#include "octopus.h"
#include "ascii_clip.h"
#include "reference48/reference.h"
#include "reference79/reference.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <limits.h>
#define RTC_NOINIT_ATTR
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_SPIRAM 2
#define pdMS_TO_TICKS(ms) (ms)
typedef struct { unsigned presses,read_failures; } touch_stats_t;
typedef struct { const char *version; } esp_app_desc_t;
static unsigned blocks,ends,cancels,skips,paints,queries,cancel_at=UINT_MAX;
static int64_t clock_us;
static uint16_t scratch[HT_WIDTH*24];
static ht_scene_t a,b;
static void log_message(const char *tag,const char *fmt,...) {
    (void)tag;
    blocks+=!strncmp(fmt,"BLOCK",5);ends+=!strncmp(fmt,"END",3);
    cancels+=!strncmp(fmt,"CANCEL",6);skips+=!strncmp(fmt,"already attempted",17);
}
#define ESP_LOGI(...) log_message(__VA_ARGS__)
#define ESP_LOGW(...) log_message(__VA_ARGS__)
static int64_t esp_timer_get_time(void) { return ++clock_us; }
static const esp_app_desc_t *esp_app_get_description(void) { static const esp_app_desc_t d={"test.65"};return &d; }
static void esp_task_wdt_reset(void) {}
static void vTaskDelay(unsigned ms) { clock_us+=ms*1000; }
static bool cable_client_is_connected(void) { return true; }
static bool heap_caps_check_integrity_all(bool noisy) { (void)noisy;return true; }
static size_t heap_caps_get_free_size(int cap) { (void)cap;return 100000; }
static size_t heap_caps_get_largest_free_block(int cap) { (void)cap;return 50000; }
static unsigned uxTaskGetStackHighWaterMark(void *task) { (void)task;return 2000; }
static void touch_stats(touch_stats_t *t) { *t=(touch_stats_t){0}; }
static uint32_t touch_activity_generation(void) { return ++queries>=cancel_at; }
void cable_scroll_benchmark(void) {}
static uint32_t fake_paint(const ht_scene_t *scene,const ht_damage_t *damage) {
    assert(scene->count<=HT_RUNS && damage->count && damage->count<=HT_DAMAGE_MAX);
    for(int i=0;i<damage->count;i++) {
        ht_rect_t r=damage->rect[i];
        assert(r.x>=0 && r.y>=0 && r.w>0 && r.h>0 && r.x+r.w<=HT_WIDTH && r.y+r.h<=HT_HEIGHT);
    }
    paints++;return 1;
}
'''
code += source
code += r'''
int main(void) {
    ht_layout_benchmark(scratch,&a,&b,fake_paint);
    assert(blocks==120 && ends==1 && !cancels && paints==2460);
    ht_layout_benchmark(scratch,&a,&b,fake_paint);
    assert(skips==1 && blocks==120);
    attempted[0]=attempted[1]=0;queries=0;cancel_at=99;
    ht_layout_benchmark(scratch,&a,&b,fake_paint);
    assert(cancels==1 && ends==1 && a.count==0 && b.count==0);
    puts("Layout benchmark: 4800 nonzero-damage workloads, 2460 bounded panel calls, one-shot reset guard and physical-input cancellation PASS (offline)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-layout-bench-') as d:
    out=Path(d);(out/'bench.c').write_text(code)
    for baseline in [48,79,82]:
        defines=[f'-DDEVICE_LAYOUT_BASELINE{baseline}=1'] if baseline!=48 else []
        sources=[f'reference{baseline}/terminal_ref.c'] if baseline!=82 else []
        if baseline==48: sources+=['reference48/octopus_ref.c']
        subprocess.run(['cc','-std=c11', '-D_POSIX_C_SOURCE=200809L','-Wall','-Wextra','-Werror','-O1','-g','-DDEVICE_LAYOUT_BENCH=1',*defines,
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-I',str(native),'-I',str(Path(__file__).resolve().parent),
        str(out/'bench.c'),*[str(native/f) for f in ['octopus.c','ascii_clip.c','octopus_font.c','tim.c','character_motion.c','character_layout.c','terminal.c','fonts.c']],
        *[str(Path(__file__).resolve().parent/f) for f in sources],
        '-o',str(out/'bench')],check=True)
        subprocess.run([str(out/'bench')],check=True)
