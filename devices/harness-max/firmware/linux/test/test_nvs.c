// NVS on Linux (linux/esp/nvs.c) under the Pro's config_store.c, the one caller: the settings survive a restart in a
// file under XDG_CONFIG_HOME, with ESP-IDF's codes for what the device would refuse.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "nvs.h"
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

// A new device: no file, the factory defaults, and nothing written until a setting is saved.
static void test_defaults(void)
{
    config_store_init();
    char lang[CFG_VLANG_MAX];
    config_load_voicelang(lang, sizeof lang);
    CHECK(!strcmp(lang, "en"));
    CHECK(config_load_brightness() == 220);
    CHECK(config_load_muted());
    CHECK(access(s_file, F_OK) != 0);
}

// What is saved is there after a restart (a fresh load of the file), and only the saved keys changed.
static void test_survives_restart(void)
{
    CHECK(config_save_voicelang("vi"));
    CHECK(config_save_muted(false));
    config_save_brightness(90);
    CHECK(file_has("pair\tvlang\tstr\tvi\n") && file_has("pair\tbright\tu8\t90\n"));
    config_store_init();   // the next run
    char lang[CFG_VLANG_MAX];
    config_load_voicelang(lang, sizeof lang);
    CHECK(!strcmp(lang, "vi"));
    CHECK(!config_load_muted());
    CHECK(config_load_brightness() == 90);
    CHECK(config_save_voicelang("en"));   // an overwrite, not a second entry
    config_store_init();
    config_load_voicelang(lang, sizeof lang);
    CHECK(!strcmp(lang, "en"));
}

// ESP-IDF's answers where the device would refuse.
static void test_refusals(void)
{
    nvs_handle_t ro, rw;
    CHECK(nvs_open("pair", NVS_READONLY, &ro) == ESP_OK && nvs_open("pair", NVS_READWRITE, &rw) == ESP_OK);
    CHECK(nvs_set_u8(ro, "x", 1) == ESP_ERR_NVS_READ_ONLY);
    uint8_t u = 7;
    CHECK(nvs_get_u8(ro, "nothing", &u) == ESP_ERR_NVS_NOT_FOUND && u == 7);
    CHECK(nvs_get_u8(ro, "vlang", &u) == ESP_ERR_NVS_TYPE_MISMATCH);
    size_t len = 0;
    CHECK(nvs_get_str(ro, "vlang", NULL, &len) == ESP_OK && len == 3);   // "en" and its NUL
    char two[2];
    len = sizeof two;
    CHECK(nvs_get_str(ro, "vlang", two, &len) == ESP_ERR_NVS_INVALID_LENGTH);
    CHECK(nvs_set_str(rw, "k", "a\tb") == ESP_ERR_INVALID_ARG);          // the file's separators
    char long_value[100];
    memset(long_value, 'x', sizeof long_value - 1);
    long_value[sizeof long_value - 1] = 0;
    CHECK(nvs_set_str(rw, "k", long_value) == ESP_ERR_NVS_VALUE_TOO_LONG);
    CHECK(nvs_set_u8(rw, "sixteen_chars_xx", 1) == ESP_ERR_NVS_INVALID_NAME);
    CHECK(nvs_open("", NVS_READWRITE, &rw) == ESP_ERR_NVS_INVALID_NAME);
    CHECK(nvs_get_u8(0, "vlang", &u) == ESP_ERR_NVS_INVALID_HANDLE);
}

// A damaged line is skipped and the rest still loads; erasing forgets everything, file included.
static void test_damage_and_erase(void)
{
    FILE *f = fopen(s_file, "w");
    CHECK(f && fputs("pair\tjunk\n\tno-namespace\tu8\t1\npair\tbright\tu8\t42\n", f) >= 0 && fclose(f) == 0);
    config_store_init();
    CHECK(config_load_brightness() == 42);
    CHECK(nvs_flash_erase() == ESP_OK);
    CHECK(access(s_file, F_OK) != 0);
    CHECK(config_load_brightness() == 220);
}

int main(void)
{
    snprintf(s_dir, sizeof s_dir, "%s/test_nvs.XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp");
    CHECK(mkdtemp(s_dir) != NULL);
    setenv("XDG_CONFIG_HOME", s_dir, 1);
    snprintf(s_file, sizeof s_file, "%s/harness-max/nvs", s_dir);
    test_defaults();
    test_survives_restart();
    test_refusals();
    test_damage_and_erase();
    char dir[300];
    snprintf(dir, sizeof dir, "%s/harness-max", s_dir);
    rmdir(dir);
    rmdir(s_dir);
    printf("test_nvs: %d checks passed\n", checks);
    return 0;
}
