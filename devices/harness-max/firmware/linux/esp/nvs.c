// NVS on Linux (include/nvs.h, include/nvs_flash.h): a few settings (brightness, mute, voice language) in a text file,
// one "namespace<TAB>key<TAB>type<TAB>value" line each, at ${XDG_CONFIG_HOME:-~/.config}/harness-max/nvs.
#include "nvs.h"
#include "nvs_flash.h"

#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_log.h"

static const char *TAG = "nvs";

#define NAME_MAX_LEN 15   // ESP-IDF's limit for a namespace or a key
#define STR_MAX 64        // the longest string the shared sources store is a language code
#define ENTRIES_MAX 32
#define SPACES_MAX 8

typedef struct {
    char space[NAME_MAX_LEN + 1];
    char key[NAME_MAX_LEN + 1];
    bool is_str;
    uint8_t u8;
    char str[STR_MAX];
} entry_t;

static pthread_mutex_t s_mu = PTHREAD_MUTEX_INITIALIZER;
static entry_t s_entries[ENTRIES_MAX];
static int s_count;
static char s_spaces[SPACES_MAX][NAME_MAX_LEN + 1];   // a handle is its namespace's index + 1, plus READONLY_BIT
#define READONLY_BIT 0x100u

static bool path_of(char *out, size_t cap, bool make_dir)
{
    const char *xdg = getenv("XDG_CONFIG_HOME"), *home = getenv("HOME");
    char dir[512];
    if (xdg && xdg[0]) snprintf(dir, sizeof dir, "%s/harness-max", xdg);
    else if (home && home[0]) snprintf(dir, sizeof dir, "%s/.config/harness-max", home);
    else return false;
    if (make_dir) {
        char parent[512];
        snprintf(parent, sizeof parent, "%.*s", (int)(strrchr(dir, '/') - dir), dir);
        mkdir(parent, 0755);   // ~/.config may not exist yet
        if (mkdir(dir, 0755) != 0 && errno != EEXIST) return false;
    }
    return snprintf(out, cap, "%s/nvs", dir) < (int)cap;
}

static bool name_ok(const char *name) { return name && name[0] && strlen(name) <= NAME_MAX_LEN; }

esp_err_t nvs_flash_init(void)
{
    char path[600];
    pthread_mutex_lock(&s_mu);
    s_count = 0;
    FILE *f = path_of(path, sizeof path, false) ? fopen(path, "r") : NULL;
    if (f) {
        char line[256];
        while (fgets(line, sizeof line, f)) {
            line[strcspn(line, "\n")] = 0;
            char *space = strtok(line, "\t"), *key = strtok(NULL, "\t"), *type = strtok(NULL, "\t");
            char *value = strtok(NULL, "");
            if (!name_ok(space) || !name_ok(key) || !type || s_count == ENTRIES_MAX) continue;
            entry_t *e = &s_entries[s_count];
            memset(e, 0, sizeof *e);
            snprintf(e->space, sizeof e->space, "%s", space);
            snprintf(e->key, sizeof e->key, "%s", key);
            if (!strcmp(type, "u8") && value) {
                e->u8 = (uint8_t)strtoul(value, NULL, 10);
            } else if (!strcmp(type, "str")) {
                e->is_str = true;
                snprintf(e->str, sizeof e->str, "%s", value ? value : "");
            } else {
                ESP_LOGW(TAG, "%s: skipped a line of unknown type", path);
                continue;
            }
            s_count++;
        }
        fclose(f);
    }
    pthread_mutex_unlock(&s_mu);
    return ESP_OK;
}

esp_err_t nvs_flash_erase(void)
{
    char path[600];
    pthread_mutex_lock(&s_mu);
    s_count = 0;
    if (path_of(path, sizeof path, false)) remove(path);
    pthread_mutex_unlock(&s_mu);
    return ESP_OK;
}

esp_err_t nvs_open(const char *name, nvs_open_mode_t mode, nvs_handle_t *out)
{
    if (!name_ok(name)) return ESP_ERR_NVS_INVALID_NAME;
    esp_err_t err = ESP_ERR_NVS_NOT_ENOUGH_SPACE;
    pthread_mutex_lock(&s_mu);
    for (unsigned i = 0; i < SPACES_MAX; i++) {
        if (!s_spaces[i][0]) snprintf(s_spaces[i], sizeof s_spaces[i], "%s", name);
        if (!strcmp(s_spaces[i], name)) {
            *out = (i + 1) | (mode == NVS_READONLY ? READONLY_BIT : 0);
            err = ESP_OK;
            break;
        }
    }
    pthread_mutex_unlock(&s_mu);
    return err;
}

void nvs_close(nvs_handle_t handle) { (void)handle; }

// The handle's namespace, or NULL. Under s_mu.
static const char *space_of(nvs_handle_t handle)
{
    const unsigned i = (handle & ~READONLY_BIT) - 1;
    return i < SPACES_MAX && s_spaces[i][0] ? s_spaces[i] : NULL;
}

// The entry for the key, or NULL. Under s_mu.
static entry_t *find(const char *space, const char *key)
{
    for (int i = 0; i < s_count; i++)
        if (!strcmp(s_entries[i].space, space) && !strcmp(s_entries[i].key, key)) return &s_entries[i];
    return NULL;
}

// The entry to write the key into, new or kept, or NULL with *err set. Under s_mu.
static entry_t *slot(nvs_handle_t handle, const char *key, esp_err_t *err)
{
    const char *space = space_of(handle);
    if (!space) { *err = ESP_ERR_NVS_INVALID_HANDLE; return NULL; }
    if (handle & READONLY_BIT) { *err = ESP_ERR_NVS_READ_ONLY; return NULL; }
    if (!name_ok(key)) { *err = ESP_ERR_NVS_INVALID_NAME; return NULL; }
    entry_t *e = find(space, key);
    if (e) return e;
    if (s_count == ENTRIES_MAX) { *err = ESP_ERR_NVS_NOT_ENOUGH_SPACE; return NULL; }
    e = &s_entries[s_count++];
    memset(e, 0, sizeof *e);
    snprintf(e->space, sizeof e->space, "%s", space);
    snprintf(e->key, sizeof e->key, "%s", key);
    return e;
}

esp_err_t nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *out)
{
    esp_err_t err = ESP_ERR_NVS_INVALID_HANDLE;
    pthread_mutex_lock(&s_mu);
    const char *space = space_of(handle);
    if (space) {
        const entry_t *e = find(space, key);
        err = !e ? ESP_ERR_NVS_NOT_FOUND : e->is_str ? ESP_ERR_NVS_TYPE_MISMATCH : ESP_OK;
        if (err == ESP_OK) *out = e->u8;
    }
    pthread_mutex_unlock(&s_mu);
    return err;
}

esp_err_t nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value)
{
    esp_err_t err = ESP_OK;
    pthread_mutex_lock(&s_mu);
    entry_t *e = slot(handle, key, &err);
    if (e) {
        e->is_str = false;
        e->u8 = value;
    }
    pthread_mutex_unlock(&s_mu);
    return err;
}

esp_err_t nvs_get_str(nvs_handle_t handle, const char *key, char *out, size_t *length)
{
    esp_err_t err = ESP_ERR_NVS_INVALID_HANDLE;
    pthread_mutex_lock(&s_mu);
    const char *space = space_of(handle);
    if (space) {
        const entry_t *e = find(space, key);
        err = !e ? ESP_ERR_NVS_NOT_FOUND : !e->is_str ? ESP_ERR_NVS_TYPE_MISMATCH : ESP_OK;
        if (err == ESP_OK) {
            // As ESP-IDF: NULL asks for the length, a short buffer is refused, the length counts the NUL.
            const size_t need = strlen(e->str) + 1;
            if (out && *length < need) err = ESP_ERR_NVS_INVALID_LENGTH;
            else if (out) memcpy(out, e->str, need);
            *length = need;
        }
    }
    pthread_mutex_unlock(&s_mu);
    return err;
}

esp_err_t nvs_set_str(nvs_handle_t handle, const char *key, const char *value)
{
    if (!value || strlen(value) >= STR_MAX) return ESP_ERR_NVS_VALUE_TOO_LONG;
    if (strpbrk(value, "\t\n")) return ESP_ERR_INVALID_ARG;   // the file's separators
    esp_err_t err = ESP_OK;
    pthread_mutex_lock(&s_mu);
    entry_t *e = slot(handle, key, &err);
    if (e) {
        e->is_str = true;
        snprintf(e->str, sizeof e->str, "%s", value);
    }
    pthread_mutex_unlock(&s_mu);
    return err;
}

esp_err_t nvs_commit(nvs_handle_t handle)
{
    char path[600], tmp[610];
    esp_err_t err = ESP_FAIL;
    pthread_mutex_lock(&s_mu);
    if (!space_of(handle)) {
        err = ESP_ERR_NVS_INVALID_HANDLE;
    } else if (path_of(path, sizeof path, true)) {
        snprintf(tmp, sizeof tmp, "%s.new", path);
        FILE *f = fopen(tmp, "w");
        bool ok = f != NULL;
        for (int i = 0; ok && i < s_count; i++) {
            const entry_t *e = &s_entries[i];
            ok = e->is_str ? fprintf(f, "%s\t%s\tstr\t%s\n", e->space, e->key, e->str) > 0
                           : fprintf(f, "%s\t%s\tu8\t%u\n", e->space, e->key, e->u8) > 0;
        }
        if (f && fclose(f) != 0) ok = false;
        if (ok && rename(tmp, path) == 0) err = ESP_OK;
        else ESP_LOGE(TAG, "%s not written: %s", path, strerror(errno));
    }
    pthread_mutex_unlock(&s_mu);
    return err;
}
