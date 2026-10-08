"""Exercise production NVS character storage and boot selection, including failures."""
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
# The character write moved into the worker's one settings case when the preferences moved to the app.
# Still taken from production source, and still the exact two lines that touch NVS.
save = re.search(r'            if \(fields & UI_SETTING_CHARACTER[^\n]*\n[^\n]*ui_cable_toast[^\n]*',
                 function('worker', ui), re.S).group(0)
code = r'''
#include "character.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef int nvs_handle_t;
enum { ESP_OK, NVS_READONLY, NVS_READWRITE };
// Only the one field the sliced lines read; the real struct lives behind ESP headers.
enum { UI_SETTING_CHARACTER = 1u << 2 };
typedef struct { uint8_t character; } ui_settings_t;
static const char *NS = "pair";
static bool present, fail_open, fail_get, fail_set, fail_commit, writable;
static uint8_t stored, staged;
static unsigned opens, closes, writes, commits, errors;
static int nvs_open(const char *ns, int mode, nvs_handle_t *h) {
    assert(!strcmp(ns, "pair"));
    if (fail_open) return -1;
    opens++; *h = 123; writable = mode == NVS_READWRITE; staged = stored; return ESP_OK;
}
static bool bright_present; static uint8_t bright_stored;
static int nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *value) {
    assert(h == 123);
    if (!strcmp(key, "bright")) {
        if (!bright_present) return -1;
        *value = bright_stored; return ESP_OK;
    }
    assert(!strcmp(key, "habitat_char"));
    if (!present || fail_get) return -1;
    *value = stored; return ESP_OK;
}
static int nvs_set_u8(nvs_handle_t h, const char *key, uint8_t value) {
    assert(h == 123 && writable && !strcmp(key, "habitat_char"));
    writes++; if (fail_set) return -1;
    staged = value; return ESP_OK;
}
static int nvs_commit(nvs_handle_t h) {
    assert(h == 123 && writable); commits++;
    if (fail_commit) return -1;
    stored = staged; present = true; return ESP_OK;
}
static void nvs_close(nvs_handle_t h) { assert(h == 123); closes++; }
static ht_character_t character;
static ht_character_id_t device_skin, desktop_companion;
static ht_character_caption_t home_caption;
static void ui_cable_toast(const char *message) {
    assert(!strcmp(message, "Character changed; saving failed.")); errors++;
}
'''
code += function('config_load_brightness', config) + '\n'
code += function('config_load_habitat_character', config) + '\n'
code += function('config_save_habitat_character', config) + '\n'
code += 'static void boot(void) {\n' + load + '}\n'
code += ('static void save(int value) {\n'
         '    uint32_t fields = UI_SETTING_CHARACTER;\n'
         '    ui_settings_t want = {.character = (uint8_t)value};\n'
         + save + '\n}\n')
code += r'''
int main(void) {
#ifdef DEVICE_DEFAULT_CHARACTER_TUX
    assert(ht_character_default() == HT_CHARACTER_TUX);
#else
    // Focus is what a dial shows before anybody has chosen (owner's decision, 2026-09-30).
    assert(ht_character_default() == HT_CHARACTER_FOCUS);
#endif
    // And at 80%: no "bright" key is 204 (80 of 100 once the UI rounds it), a saved one is kept exactly.
    bright_present = false; assert(config_load_brightness() == 204 && (204 * 100 + 127) / 255 == 80);
    bright_present = true; bright_stored = 102; assert(config_load_brightness() == 102);
    bright_present = false;
    home_caption.initialized=true;
    boot(); assert(character.id == ht_character_default() && !home_caption.initialized);
    assert(!writes && !commits); // Boot cannot overwrite a previous preference.
    for (unsigned id = 0; id <= 255; id++) {
        save(id); assert(stored == id && !errors);
        boot(); assert(character.id == (id <= HT_CHARACTER_FOCUS ? id : ht_character_default()));
    }
    save(HT_CHARACTER_TUX); boot(); assert(character.id == HT_CHARACTER_TUX);
    save(HT_CHARACTER_TIM); boot(); assert(character.id == HT_CHARACTER_TIM);
    fail_get = true; boot(); assert(character.id == ht_character_default()); fail_get = false;
    unsigned previous = commits;
    fail_open = true; save(HT_CHARACTER_TUX); boot();
    assert(errors == 1 && commits == previous && character.id == ht_character_default()); fail_open = false;
    fail_set = true; save(HT_CHARACTER_TUX);
    assert(errors == 2 && commits == previous && stored == HT_CHARACTER_TIM); fail_set = false;
    fail_commit = true; save(HT_CHARACTER_TUX);
    assert(errors == 3 && commits == previous + 1 && stored == HT_CHARACTER_TIM); fail_commit = false;
    boot(); assert(character.id == HT_CHARACTER_TIM);
    assert(opens == closes);
    puts("Character preference: missing/invalid keys, both boot defaults, 256 saved values and NVS failures PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-character-pref-') as directory:
    out = Path(directory)
    (out / 'test.c').write_text(code)
    sources = ['character.c', 'illustrated.c', 'character_motion.c', 'character_layout.c', 'tux.c', 'focus.c', 'lvgl_fonts.c', 'lvgl_icons.c', 'focus_marks.c', 'focus_faces.c', 'pets.c',
               'octopus.c', 'octopus_font.c', 'ascii_clip.c', 'terminal.c', 'fonts.c', '../../pet_store.c']
    for flags in ([], ['-DDEVICE_DEFAULT_CHARACTER_TUX=1']):
        subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
            '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'), *flags,
            '-I', str(native), '-I', str(native.parent.parent), str(out / 'test.c'), *(str(native / f) for f in sources),
            '-o', str(out / 'test')], check=True)
        subprocess.run([str(out / 'test')], check=True)
