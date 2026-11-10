"""Boot-time preferences from production NVS code: the brightness default, and that no saved character is read."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
native = here / '../main/ui/habitat'
config = (here / '../main/config_store.c').read_text()
ui = (native / 'ui_habitat.c').read_text()


def function(name, source):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0)


init = function('ui_init', ui)
load = init[init.index('    memset(&character,'):init.index('    ESP_LOGI("habitat"')]
code = r'''
#include "character.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef int nvs_handle_t;
enum { ESP_OK, NVS_READONLY, NVS_READWRITE };
static const char *NS = "pair";
static bool bright_present; static uint8_t bright_stored;
static unsigned reads;
static int nvs_open(const char *ns, int mode, nvs_handle_t *h) {
    assert(!strcmp(ns, "pair") && mode == NVS_READONLY);
    *h = 123; return ESP_OK;
}
static int nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *value) {
    assert(h == 123);
    reads++;
    // Focus is the only character: boot never asks NVS which one a dial last wore.
    assert(!strcmp(key, "bright"));
    if (!bright_present) return -1;
    *value = bright_stored; return ESP_OK;
}
static void nvs_close(nvs_handle_t h) { assert(h == 123); }
static ht_character_t character;
static ht_character_caption_t home_caption;
'''
code += function('config_load_brightness', config) + '\n'
code += 'static void boot(void) {\n' + load + '}\n'
code += r'''
int main(void) {
    // And at 80%: no "bright" key is 204 (80 of 100 once the UI rounds it), a saved one is kept exactly.
    bright_present = false; assert(config_load_brightness() == 204 && (204 * 100 + 127) / 255 == 80);
    bright_present = true; bright_stored = 102; assert(config_load_brightness() == 102);
    bright_present = false;
    home_caption.initialized = true;
    unsigned before = reads;
    boot(); assert(character.id == HT_CHARACTER_FOCUS && !home_caption.initialized && reads == before);
    puts("Boot preferences: brightness default and saved value, Focus without reading a saved character PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-character-pref-') as directory:
    out = Path(directory)
    (out / 'test.c').write_text(code)
    sources = ['character.c', 'character_motion.c', 'character_layout.c', 'focus.c', 'lvgl_fonts.c', 'lvgl_icons.c', 'focus_marks.c', 'focus_faces.c', 'pets.c',
               'terminal.c', 'fonts.c', '../../pet_store.c', '../../elapsed.c']
    subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
        '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
        '-I', str(native), '-I', str(native.parent.parent), str(out / 'test.c'), *(str(native / f) for f in sources),
        '-o', str(out / 'test'), '-lm'], check=True)
    subprocess.run([str(out / 'test')], check=True)
