// Harness Max's voice language before anyone chooses one (main/app/max_voice_lang.c), over the Linux NVS and the Pro's
// config_store.c as the bar runs them: Vietnamese on a new bar, and a language the person saved is never overwritten.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "app/max_voice_lang.h"
#include "nvs_flash.h"
#include "sys/config_store.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } checks++; } while (0)

static char s_dir[256], s_file[300];

static bool file_has(const char *text)
{
    char buf[1024] = "";
    FILE *f = fopen(s_file, "r");
    if (!f) return false;
    const size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    buf[n] = 0;
    return strstr(buf, text) != NULL;
}

static void lang_is(const char *want)
{
    char lang[CFG_VLANG_MAX];
    config_load_voicelang(lang, sizeof lang);
    CHECK(!strcmp(lang, want));
}

// A new bar: nothing saved, so the Pro's factory English would be read; the default writes Vietnamese, once.
static void test_new_bar_speaks_vietnamese(void)
{
    CHECK(nvs_flash_erase() == ESP_OK);
    config_store_init();
    lang_is("en");   // the Pro's own default, which the Max overrides
    CHECK(max_voice_lang_default());
    lang_is(MAX_VOICE_LANG_DEFAULT);
    CHECK(!strcmp(MAX_VOICE_LANG_DEFAULT, "vi"));
    CHECK(file_has("pair\tvlang\tstr\tvi\n"));
    // The next boot finds it saved and writes nothing.
    config_store_init();
    CHECK(!max_voice_lang_default());
    lang_is("vi");
}

// A language the person chose (settings.set voiceLang) stays through every later boot.
static void test_saved_choice_stays(void)
{
    CHECK(nvs_flash_erase() == ESP_OK);
    config_store_init();
    CHECK(config_save_voicelang("en"));
    config_store_init();
    CHECK(!max_voice_lang_default());
    lang_is("en");
    CHECK(!file_has("\tvi\n"));
}

// Other settings saved before the language (brightness) do not count as a language.
static void test_other_settings_are_not_a_language(void)
{
    CHECK(nvs_flash_erase() == ESP_OK);
    config_store_init();
    config_save_brightness(90);
    config_store_init();
    CHECK(max_voice_lang_default());
    lang_is("vi");
    CHECK(config_load_brightness() == 90);
}

int main(void)
{
    snprintf(s_dir, sizeof s_dir, "%s/test_voice_lang.XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp");
    CHECK(mkdtemp(s_dir) != NULL);
    setenv("XDG_CONFIG_HOME", s_dir, 1);
    snprintf(s_file, sizeof s_file, "%s/harness-max/nvs", s_dir);
    test_new_bar_speaks_vietnamese();
    test_saved_choice_stays();
    test_other_settings_are_not_a_language();
    CHECK(nvs_flash_erase() == ESP_OK);
    char dir[300];
    snprintf(dir, sizeof dir, "%s/harness-max", s_dir);
    rmdir(dir);
    rmdir(s_dir);
    printf("test_voice_lang: %d checks passed\n", checks);
    return 0;
}
