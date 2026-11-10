"""Focus is the dial's only mode: nothing else is built, and an old saved skin draws Focus."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
fw = here.parent
native = fw / 'main/ui/habitat'

# 1. None of the other characters, the companions, the gallery or their build options is left in the firmware.
banned = re.compile(r'illustrated|companion_art|followCompanion|companionProtocol|companionDetails|DEVICE_ALL_SKINS|'
                    r'HABITAT_FOCUS_ONLY|ht_tux_|ht_octopus_|ht_tim_|creature_gallery', re.I)
files = [fw / 'CMakeLists.txt'] + [p for p in (fw / 'main').rglob('*') if p.is_file()]
hits = []
for path in files:
    if path.suffix in ('.c', '.h', '.inc', '.txt', '.cmake'):
        for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
            if banned.search(line):
                hits.append(f'{path.relative_to(fw)}:{number}: {line.strip()[:100]}')
assert not hits, '\n'.join(hits[:20])

# 2. The registry holds Focus only, and whatever id an older firmware saved boots as Focus.
ui = (native / 'ui_habitat.c').read_text()
match = re.search(r'^void ui_init\(void\)\n\{.*?^\}', ui, re.M | re.S)
assert match
init = match.group(0)
load = init[init.index('    memset(&character,'):init.index('    ESP_LOGI("habitat"')]
code = r'''
#include "character.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
_Static_assert(HT_CHARACTER_COUNT == 1, "Focus is the only character");
_Static_assert(HT_CHARACTER_FOCUS == 0, "Focus is id 0");
// What an older firmware may have saved: Tim, Tux, an illustrated companion. Nothing may read it back as anything else.
__attribute__((unused)) static uint8_t config_load_habitat_character(uint8_t fallback) { (void)fallback; return 7; }
static ht_character_t character;
static ht_character_caption_t home_caption;
static void boot(void) {
''' + load + r'''}
int main(void) {
    boot();
    assert(character.id == HT_CHARACTER_FOCUS && !strcmp(ht_character_name(character.id), "Focus"));
    for (unsigned id = 0; id <= 255; id++) {
        ht_character_t c;
        memset(&c, 0, sizeof c);
        assert(ht_character_select(&c, (ht_character_id_t)id) && c.id == HT_CHARACTER_FOCUS);
    }
    assert(ht_character_default() == HT_CHARACTER_FOCUS);
    puts("Focus only: one character, any saved id selects it PASS");
}
'''
sources = ['character.c', 'character_motion.c', 'character_layout.c', 'focus.c', 'lvgl_fonts.c', 'lvgl_icons.c',
           'focus_marks.c', 'focus_faces.c', 'pets.c', 'terminal.c', 'fonts.c', '../../pet_store.c', '../../elapsed.c']
with tempfile.TemporaryDirectory(prefix='harness-focus-only-') as directory:
    out = Path(directory)
    (out / 'test.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
        '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
        '-I', str(native), '-I', str(native.parent.parent), str(out / 'test.c'), *(str(native / f) for f in sources),
        '-o', str(out / 'test'), '-lm'], check=True)
    subprocess.run([str(out / 'test')], check=True)
