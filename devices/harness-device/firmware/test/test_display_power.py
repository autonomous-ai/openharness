"""Run the production render loop with deterministic cross-task power interleavings."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
path = Path(os.environ.get('DISPLAY_SOURCE', root / 'main/ui/habitat/display_habitat.c'))
source = path.read_text()


def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;\n]*\) \{[^\n]*\}', source, re.M)
    if not match:
        match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'


code = r'''
#include "terminal.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <setjmp.h>
static atomic_bool asleep, force_frame;
static atomic_uint last_activity;
static atomic_uint requested_brightness = 40;
#define ESP_LOGI(...) ((void)0)
static int esp_lcd_panel_co5300_set_brightness(int p, unsigned level) { (void)p; assert(level <= 100); return 0; }
static void ht_illustrated_prepare(ht_scene_t *scene) { (void)scene; }
static ht_scene_t scenes[2];
static bool painted;
static void (*power_cb)(bool);
static uint32_t clock_ms;
static unsigned frames, ticks, waits, locks, sleeps, wakes, full_frames, notifications;
static unsigned stop_after;
static int mode;
static bool panel_on = true;
static int panel, render_guard;
static jmp_buf finished;
enum { RENDER_MODEL, RENDER_POWER, RENDER_DAMAGE, RENDER_RASTER, RENDER_DMA,
       RENDER_SUBMIT, RENDER_HEALTH, RENDER_WAIT };
typedef struct { void (*callback)(void *); const char *name; } esp_timer_create_args_t;
#define pdTRUE 1
#define pdMS_TO_TICKS(n) (n)
#define ESP_ERROR_CHECK(expr) assert((expr) == 0)
static int esp_task_wdt_add(void *p) { (void)p; return 0; }
static int esp_task_wdt_reset(void) { return 0; }
static int esp_timer_create(const esp_timer_create_args_t *a, int *out) {
    assert(a->callback && a->name); *out=1; return 0;
}
static int esp_timer_start_periodic(int timer, int us) { assert(timer && us==1000000); return 0; }
static void render_watch(void *arg) { (void)arg; }
static void render_progress(unsigned stage) { assert(stage<=RENDER_WAIT); }
static uint32_t now_ms(void) { return clock_ms; }
static void heartbeat(void) {}
static void habitat_render_notify(void) { notifications++; }
static void display_wake(void);
static void display_sleep(void);
static void display_bump_activity(void);
static bool display_is_asleep(void) { return atomic_load(&asleep); }
static void power(bool on) { if(on) wakes++; else sleeps++; }
static void display_lock(void) {
    locks++;
    // Touch wins the model lock while the renderer is waiting to auto-sleep.
    if (mode==2 && locks==2) display_bump_activity();
}
static void display_unlock(void) {}
static void habitat_tick(void) { ticks++; }
static bool habitat_scene_take(ht_scene_t *out) { (void)out; return mode==4 || mode==5; }
static unsigned receipts;
static uint32_t habitat_scene_receipt(void) { return mode==4 || mode==5 ? 77 : 0; }
static void habitat_scene_presented(uint32_t receipt) { assert(receipt==77 && panel_on && frames>0); receipts++; }
static uint32_t habitat_next_wake_ms(void) { return 1000; }
static int esp_lcd_panel_disp_on_off(int p, bool on) {
    (void)p; panel_on=on;
    // Power input arrives after the renderer sampled asleep, during panel OFF.
    if (!on && mode==1) display_wake();
    return 0;
}
void ht_damage(const ht_scene_t *before, const ht_scene_t *after, ht_damage_t *out) {
    assert(after); memset(out,0,sizeof *out);
    if (!before) { out->count=1; out->pixels=HT_WIDTH*HT_HEIGHT; full_frames++; }
}
static uint32_t paint(const ht_scene_t *scene, const ht_damage_t *damage) {
    assert(scene && panel_on && damage->count); frames++; return 0;
}
static unsigned ulTaskNotifyTake(int clear, uint32_t timeout) {
    assert(clear && timeout<=1000);
    if (++waits==stop_after) longjmp(finished,1);
    // Normal idle wake follows a quiet/asleep iteration, with no fresh model.
    if (mode==3 && waits==1) display_wake();
    return 0;
}
'''
for name in ['elapsed_since', 'display_bump_activity', 'display_sleep', 'display_wake', 'render_task']:
    code += function(name)
code += r'''
static void run(int which, uint32_t now, uint32_t activity, bool sleep, unsigned loops) {
    mode=which; clock_ms=now; atomic_store(&last_activity,activity);
    atomic_store(&asleep,sleep); atomic_store(&force_frame,false);
    memset(scenes,0,sizeof scenes); painted=mode!=4; panel_on=true; receipts=0; power_cb=power;
    frames=ticks=waits=locks=sleeps=wakes=full_frames=notifications=0;
    stop_after=loops;
    if (!setjmp(finished)) render_task(NULL);
    assert(waits==loops);
}
int main(void) {
    run(4,1000,1000,false,1); assert(frames==1 && receipts==1);
    run(5,1000,1000,true,1); assert(!frames && !receipts);
    // A wake between power sampling and force-frame consumption must survive.
    run(1,1000,1000,true,2);
    assert(!display_is_asleep() && panel_on && wakes==1);
    assert(frames==1 && full_frames==1);
    // The idle decision must re-check activity once it owns the model lock.
    run(2,300001,0,false,1);
    assert(!display_is_asleep() && !sleeps);
    // Still/quiet screens repaint on wake even when the scene never changes.
    run(3,1000,1000,true,2);
    assert(frames==1 && full_frames==1 && panel_on);
    // Normal idle expiry, the boundary, and the 32-bit uptime wrap.
    run(0,300001,0,false,1); assert(display_is_asleep() && sleeps==1);
    run(0,300000,0,false,1); assert(!display_is_asleep() && !sleeps);
    run(0,100,UINT32_MAX-100,false,1); assert(!display_is_asleep() && !sleeps);
    run(0,299900,UINT32_MAX-100,false,1); assert(display_is_asleep() && sleeps==1);
    // Repeated requests are idempotent; no extra callbacks/notifications.
    unsigned n=notifications, s=sleeps, w=wakes;
    display_sleep(); assert(notifications==n && sleeps==s);
    display_wake(); display_wake(); assert(notifications==n+1 && wakes==w+1);
    puts("Display power: production render-loop wake/repaint and touch/idle races, quiet wake, boundaries and wrap PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-display-power-') as folder:
    folder = Path(folder)
    (folder / 'power.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(root / 'main/ui/habitat'), str(folder / 'power.c'),
                    '-o', str(folder / 'power')], check=True)
    subprocess.run([str(folder / 'power')], check=True)
