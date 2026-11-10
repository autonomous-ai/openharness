"""The settings the desktop app reads and writes, driven through the production functions.

The device OWNS these. The app proposes, and every answer is read back from here rather than echoed —
which is the whole reason a refusal corrects the window instead of leaving it hopeful. Four things
that look fine when they are wrong, and so each gets a case:

  * an absent field is UNCHANGED, not defaulted. Two windows open on one device would otherwise
    overwrite each other with whatever each of them last saw.
  * a refusal writes NOTHING. Validation runs before the first assignment, so a frame naming four
    rows and failing on the third cannot leave two of them changed.
  * nothing reaches flash from the render path. The live state moves under the display lock and the
    NVS writes are staged for the worker, exactly as the finger path has always done.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
native = here / '../main/ui/habitat'
ui = Path(os.environ.get('UI_SOURCE', native / 'ui_habitat.c')).read_text()


def function(name, text=ui):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', text, re.M | re.S)
    assert match, name
    return match.group(0)


worker_save = re.search(r'        case A_SETTINGS_SAVE: \{.*?\n        \}', function('worker'), re.S).group(0)
pending = re.search(r'static struct \{\n    ui_settings_t values;.*?\n\} settings_pending;', ui, re.S).group(0)

code = r'''
#include "character.h"
#include "terminal.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define CFG_VLANG_MAX 8
enum { UI_CHARACTER_FOCUS_WIRE = 2 };
typedef struct {
    uint8_t brightness;
    uint8_t character;
    uint16_t face;
    bool muted, quiet, straight_title, focus_face, scroll_reversed, round;
    char voicelang[CFG_VLANG_MAX];
} ui_settings_t;
enum {
    UI_SETTING_BRIGHTNESS = 1u << 0, UI_SETTING_MUTED          = 1u << 1,
    UI_SETTING_CHARACTER  = 1u << 2,
    UI_SETTING_QUIET      = 1u << 4, UI_SETTING_STRAIGHT_TITLE = 1u << 5,
    UI_SETTING_FOCUS_FACE = 1u << 6, UI_SETTING_SCROLL         = 1u << 7,
    UI_SETTING_VOICELANG  = 1u << 8,
};
typedef enum { A_NONE, A_SETTINGS_SAVE } action_kind_t;
typedef struct { action_kind_t kind; } action_t;

// The pieces of the screen these functions touch, and nothing else.
static struct {
    int brightness;
    bool muted, quiet, focus_face, straight_title, connected, nap, touch_down;
    int view;
} s;
static bool scroll_reversed;
static ht_character_t character;
#define ESP_LOGI(...) ((void)0)
static void display_set_brightness(uint8_t value) { (void)value; }
static bool congestion, changed;
static unsigned queued;

// NVS, counted rather than written.
static uint8_t nvs_brightness = 0x99, nvs_options;
static bool nvs_scroll, nvs_muted;
static char nvs_lang[CFG_VLANG_MAX] = "en";
static unsigned writes, toasts;
static bool fail_options, fail_mute;

static void display_lock(void) {}
static void display_unlock(void) {}
static void change(void) { changed = true; }
static bool queue(action_t a) { if (congestion) return false; queued += a.kind == A_SETTINGS_SAVE; return true; }
static void ui_cable_toast(const char *message) { (void)message; toasts++; }
static void config_save_brightness(uint8_t v) { nvs_brightness = v; writes++; }
static bool config_save_habitat_options(uint8_t v) { writes++; if (fail_options) return false; nvs_options = v; return true; }
static void config_save_scroll_reversed(bool v) { nvs_scroll = v; writes++; }
static void config_save_voicelang(const char *v) { snprintf(nvs_lang, sizeof nvs_lang, "%s", v); writes++; }
static void config_load_voicelang(char *out, size_t cap) { snprintf(out, cap, "%s", nvs_lang); }
static bool audio_notify_set_muted(bool v) { writes++; if (fail_mute) return false; nvs_muted = v; return true; }
static void cable_client_report_settings(void);
'''
code += pending + '\n'
code += function('ui_settings_read') + '\n'
code += function('ui_settings_apply') + '\n'
code += function('ui_settings_changed') + '\n'
code += 'static void worker_once(void) {\n    action_t a = {A_SETTINGS_SAVE};\n    switch (a.kind) {\n' \
        + worker_save + '\n    default: break;\n    }\n}\n'
code += r'''
static unsigned reports;
static ui_settings_t reported;
static void cable_client_report_settings(void) { reports++; ui_settings_read(&reported); }

static ui_settings_t now(void) { ui_settings_t v; ui_settings_read(&v); return v; }

int main(void)
{
    ht_character_select(&character, ht_character_default());
    s.brightness = 60;
    ui_settings_t base = now();
    assert(base.brightness == 60 && !strcmp(base.voicelang, "en"));
    // The face, stated for the app rather than inferred by it. This firmware only builds round; the
    // field is on the wire because another device speaking this protocol may not be.
    assert(base.round && base.face == HT_WIDTH);

    // One field crosses; the other nine are left exactly where they were.
    char error[96];
    ui_settings_t want = base;
    want.quiet = true;
    want.brightness = 5;           // named in the struct but NOT in the mask: must be ignored
    assert(ui_settings_apply(&want, UI_SETTING_QUIET, error, sizeof error));
    assert(!error[0] && now().quiet && now().brightness == 60);
    assert(queued == 1 && !writes && changed);   // nothing reached flash from the render path
    worker_once();
    assert(writes == 1 && nvs_options == 4 && reports == 1 && reported.quiet);

    // A refusal writes nothing at all, and says why in one line.
    want = now();
    want.focus_face = true;       // a field no earlier case has touched, so its absence is the proof
    want.brightness = 200;
    unsigned before = writes;
    assert(!ui_settings_apply(&want, UI_SETTING_FOCUS_FACE | UI_SETTING_BRIGHTNESS, error, sizeof error));
    assert(error[0] && writes == before && !now().focus_face && now().brightness == 60);
    want.brightness = 60;
    char oversize[CFG_VLANG_MAX + 4] = "vietnamese";
    snprintf(want.voicelang, sizeof want.voicelang, "%s", "vi");
    memcpy(want.voicelang, oversize, sizeof want.voicelang);   // unterminated is refused, not truncated
    want.voicelang[CFG_VLANG_MAX - 1] = 'x';
    assert(!ui_settings_apply(&want, UI_SETTING_VOICELANG, error, sizeof error) && error[0]);
    assert(writes == before);

    // Everything at once, then read back from the device rather than echoed.
    want = now();
    want.brightness = 35; want.muted = true;
    want.quiet = false; want.focus_face = true; want.scroll_reversed = true;
    snprintf(want.voicelang, sizeof want.voicelang, "vi");
    assert(ui_settings_apply(&want, UI_SETTING_BRIGHTNESS | UI_SETTING_MUTED |
                             UI_SETTING_QUIET | UI_SETTING_FOCUS_FACE |
                             UI_SETTING_SCROLL | UI_SETTING_VOICELANG, error, sizeof error));
    worker_once();
    ui_settings_t after = now();
    assert(after.brightness == 35 && after.muted &&
           !after.quiet && after.focus_face && after.scroll_reversed &&
           !strcmp(after.voicelang, "vi"));
    // Bit 1 is retired with rim scrolling and must never be set again — see config_store.h.
    assert(nvs_options == 1 && nvs_scroll && nvs_muted &&
           !strcmp(nvs_lang, "vi"));

    // Focus is the only face: the character row reads Focus whatever the app asks for, nothing is written
    // for it, and asking is not an error (an older app still sends it). The straight title is Focus's too.
    want = now(); want.character = 200; want.straight_title = !now().straight_title;
    unsigned staged = queued, kept = writes;
    assert(ui_settings_apply(&want, UI_SETTING_CHARACTER | UI_SETTING_STRAIGHT_TITLE, error, sizeof error));
    assert(!error[0] && queued == staged && writes == kept);
    assert(now().character == UI_CHARACTER_FOCUS_WIRE && now().straight_title != want.straight_title);
    assert(character.id == HT_CHARACTER_FOCUS);

    // A failed NVS write is told to the app, and the report still carries the truth.
    fail_options = true;
    want = now(); want.quiet = true;
    unsigned toasted = toasts;
    assert(ui_settings_apply(&want, UI_SETTING_QUIET, error, sizeof error));
    worker_once();
    assert(toasts == toasted + 1 && now().quiet);
    fail_options = false;

    // A full action queue is a refusal the app can act on, not a silent loss.
    congestion = true;
    want = now(); want.quiet = true;
    assert(!ui_settings_apply(&want, UI_SETTING_QUIET, error, sizeof error) && error[0]);
    congestion = false;

    puts("Device settings: absent fields unchanged, refusals write nothing, "
         "every write staged off the render path PASS");
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix='harness-device-settings-') as directory:
    out = Path(directory)
    (out / 'test.c').write_text(code)
    sources = ['character.c', 'character_motion.c', 'character_layout.c', 'focus.c', 'lvgl_fonts.c', 'lvgl_icons.c', 'focus_marks.c', 'focus_faces.c', 'pets.c',
               'terminal.c', 'fonts.c', '../../pet_store.c', '../../elapsed.c']
    subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
        '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
        '-I', str(native), '-I', str(native.parent.parent), str(out / 'test.c'), *(str(native / f) for f in sources),
        '-o', str(out / 'test')], check=True)
    subprocess.run([str(out / 'test')], check=True)
