"""Exercise production brightness loading, persistence conversions, and the dimmed canvas.

Brightness moved to the desktop app when the device's settings screens went (see ui_settings_apply).
That changed what this has to prove. The old screen could only ever store FOUR presets — 25/50/75/100
— so the byte conversion was exercised at four points and a rounding error in between was invisible.
The app sends any of 101 values, so the round trip has to hold at every one of them: a percentage that
comes back one lower after a reboot is a slider that walks downward each time the person restarts.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
source = Path(os.environ.get('UI_SOURCE', here / '../main/ui/habitat/ui_habitat.c')).read_text()

def function(name, text=source):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', text, re.M | re.S)
    assert match, name
    return match.group(0)

load = re.search(r'    s\.brightness = [^;]*config_load_brightness\(\)[^;]*;', function('ui_init')).group(0)
# The two production lines that move a percentage in each direction, taken from where they live now:
# the app's value is staged under the display lock, and the worker writes it off the render path.
stage = re.search(r'    if \(fields & UI_SETTING_BRIGHTNESS\) \{.*?\n    \}',
                  function('ui_settings_apply'), re.S).group(0)
save = re.search(r'            if \(fields & UI_SETTING_BRIGHTNESS\)\n[^\n]*config_save_brightness[^\n]*',
                 function('worker')).group(0)
code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include "theme.h"
static struct { int brightness; } s;
enum { UI_SETTING_BRIGHTNESS = 1u << 0 };
typedef struct { uint8_t brightness; } ui_settings_t;
static uint8_t saved;
static uint8_t config_load_brightness(void) { return saved; }
static void config_save_brightness(uint8_t value) { saved=value; }
static void display_lock(void) {}
static void display_unlock(void) {}
static void change(void) {}
static uint8_t panel_level;
static void display_set_brightness(uint8_t value) { panel_level = value; }
'''
code += function('ui_set_brightness') + '\n'
code += function('ht_rgb', (here / '../main/ui/habitat/terminal.c').read_text()) + '\n'
code += function('color') + '\n'
code += 'static void load_saved(void) {\n' + load + '\n}\n'
code += ('static void app_sets(int percent) {\n'
         '    uint32_t fields = UI_SETTING_BRIGHTNESS;\n'
         '    ui_settings_t w = {.brightness=(uint8_t)percent}, *want = &w;\n'
         + stage + '\n}\n')
code += ('static void persist(void) {\n'
         '    uint32_t fields = UI_SETTING_BRIGHTNESS;\n'
         '    ui_settings_t want = {.brightness=(uint8_t)s.brightness};\n'
         + save + '\n}\n')
code += r'''
int main(void) {
    // The factory byte 0x99 is 60%.
    saved=0x99; load_saved(); assert(s.brightness==60);

    // EVERY percentage the app can send survives a reboot unchanged. With four presets a rounding
    // error here was unreachable; with a slider it is one restart away.
    for (int percent=0;percent<=100;percent++) {
        app_sets(percent);
        assert(s.brightness==percent);
        persist();
        s.brightness=-1;
        load_saved();
        assert(s.brightness==percent);
        ui_set_brightness(saved);
        assert(s.brightness==percent);
    }

    // And every stored byte still loads to a bounded, monotonic percentage — a device that was set
    // by an older firmware holds a byte no slider ever chose.
    int previous=-1;
    for (int level=0;level<=255;level++) {
        saved=(uint8_t)level; load_saved();
        assert(s.brightness>=previous && s.brightness<=100);
        previous=s.brightness;
    }

    for (int percent=0;percent<=100;percent++) {
        s.brightness=percent;
        uint16_t canvas=color(HT_THEME_CANVAS);
        unsigned r=canvas>>11, g=(canvas>>5)&63, b=canvas&31;
        r=(r<<3)|(r>>2); g=(g<<2)|(g>>4); b=(b<<3)|(b>>2);
        assert(r==g && g==b && r<=24);
        assert(r==24 && color(HT_THEME_TEXT)==ht_rgb(HT_THEME_TEXT));
        app_sets(percent);
        assert(panel_level == (percent * 255 + 50) / 100);
    }
    puts("Brightness: 101 app-set percentages survive a reboot exactly, 256 stored bytes load bounded and monotonic, neutral canvas throughout PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-brightness-') as directory:
    out=Path(directory)
    (out/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
        '-I',str(here / '../main/ui/habitat'),str(out/'test.c'),'-o',str(out/'test')],check=True)
    subprocess.run([str(out/'test')],check=True)
