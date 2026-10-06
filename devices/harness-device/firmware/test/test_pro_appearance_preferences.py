"""Exercise the production Pro appearance NVS functions and round preference isolation."""
from pathlib import Path
import os
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
MAIN = HERE.parent / "main"
CONFIG = (MAIN / "config_store.c").read_text()


def function(name):
    match = re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{.*?^\}", CONFIG, re.M | re.S)
    assert match, name
    return match.group(0)


CODE = r'''
#include "config_store.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef int nvs_handle_t;
enum { ESP_OK, NVS_READONLY, NVS_READWRITE };
static const char *NS = "pair";
static bool opened, writable, present, round_present;
static bool fail_open, fail_get, fail_set, fail_commit;
static bool appearance_pending, round_pending;
static uint16_t stored, staged;
static uint8_t round_stored, round_staged, living_stored, living_staged;
static bool living_present,living_pending;
static unsigned living_writes;
static unsigned opens, closes, reads, writes, round_writes, commits;

static int nvs_open(const char *ns, int mode, nvs_handle_t *handle)
{
    assert(!strcmp(ns, "pair") && !opened);
    assert(mode == NVS_READONLY || mode == NVS_READWRITE);
    if (fail_open) return -1;
    opens++; opened = true; writable = mode == NVS_READWRITE; *handle = 71;
    staged = stored; round_staged = round_stored;
    appearance_pending = round_pending = living_pending = false; living_staged=living_stored;
    return ESP_OK;
}
static int nvs_get_u16(nvs_handle_t handle, const char *key, uint16_t *value)
{
    assert(opened && handle == 71 && !strcmp(key, "pro_look"));
    reads++;
    if (!present) return -1;
    if (fail_get) {
        // Do not accidentally return a partially populated value after a read error.
        *value = 0xdead;
        return -1;
    }
    *value = stored;
    return ESP_OK;
}
static int nvs_set_u16(nvs_handle_t handle, const char *key, uint16_t value)
{
    assert(opened && writable && handle == 71 && !strcmp(key, "pro_look"));
    writes++;
    if (fail_set) return -1;
    staged = value; appearance_pending = true;
    return ESP_OK;
}
static int nvs_get_u8(nvs_handle_t handle, const char *key, uint8_t *value)
{
    assert(opened && handle == 71);
    if(!strcmp(key,"pro_living")) {
        if(fail_get){*value=255;return -1;}
        if(!living_present)return -1;
        *value=living_stored;return ESP_OK;
    }
    assert(!strcmp(key,"habitat_char"));
    if (!round_present) return -1;
    *value = round_stored;
    return ESP_OK;
}
static int nvs_set_u8(nvs_handle_t handle, const char *key, uint8_t value)
{
    assert(opened && writable && handle == 71);
    if(!strcmp(key,"pro_living")) {
        living_writes++;if(fail_set)return -1;
        living_staged=value;living_pending=true;return ESP_OK;
    }
    assert(!strcmp(key,"habitat_char"));
    round_writes++; round_staged = value; round_pending = true;
    return ESP_OK;
}
static int nvs_commit(nvs_handle_t handle)
{
    assert(opened && writable && handle == 71);
    commits++;
    if (fail_commit) return -1;
    if (appearance_pending) { stored = staged; present = true; }
    if (round_pending) { round_stored = round_staged; round_present = true; }
    if (living_pending) { living_stored=living_staged;living_present=true; }
    return ESP_OK;
}
static void nvs_close(nvs_handle_t handle)
{
    assert(opened && handle == 71);
    closes++; opened = false;
}
'''
CODE += "\n".join(function(name) for name in (
    "config_load_pro_appearance", "config_save_pro_appearance",
    "config_load_habitat_character", "config_save_habitat_character",
    "config_load_pro_living", "config_save_pro_living",
))
CODE += r'''

int main(void)
{
    // An existing round selection is only a supplied migration fallback; reads
    // must never perform a migration write or replace that legacy preference.
    assert(config_save_habitat_character(1));
    unsigned initial_commits = commits;
    uint16_t fallback = (uint16_t)(0x7f00 | config_load_habitat_character(0));
    assert(config_load_pro_appearance(fallback) == 0x7f01);
    assert(!writes && commits == initial_commits && round_writes == 1);

    // Storage does not interpret either byte. Every uint16 value survives a
    // fresh open/read, including 0, 0xffff and independently changing bytes.
    for (unsigned value = 0; value <= UINT16_MAX; value++) {
        unsigned before_commits = commits, before_writes = writes;
        assert(config_save_pro_appearance((uint16_t)value));
        assert(writes == before_writes + 1 && commits == before_commits + 1);
        assert(config_load_pro_appearance((uint16_t)~value) == value);
        assert(config_load_habitat_character(0) == 1 && round_writes == 1);
    }
    assert(config_save_pro_appearance(0x0409));
    assert(config_save_habitat_character(0));
    assert(config_load_pro_appearance(0) == 0x0409);
    assert(config_load_habitat_character(1) == 0);

    unsigned before_opens = opens, before_closes = closes;
    unsigned before_writes = writes, before_commits = commits, before_reads = reads;
    fail_open = true;
    assert(config_load_pro_appearance(0xabcd) == 0xabcd);
    assert(!config_save_pro_appearance(0x0203));
    assert(opens == before_opens && closes == before_closes);
    assert(writes == before_writes && commits == before_commits && reads == before_reads);
    fail_open = false;
    assert(config_load_pro_appearance(0) == 0x0409);

    fail_get = true;
    assert(config_load_pro_appearance(0xbeef) == 0xbeef);
    assert(writes == before_writes && commits == before_commits);
    fail_get = false;
    assert(config_load_pro_appearance(0) == 0x0409);

    fail_set = true;
    assert(!config_save_pro_appearance(0x0305));
    assert(writes == before_writes + 1 && commits == before_commits);
    fail_set = false;
    assert(config_load_pro_appearance(0) == 0x0409);

    // This injected backend rejects the commit without changing durable state.
    // The API must report failure and close the handle; the next save can retry.
    fail_commit = true;
    assert(!config_save_pro_appearance(0x0207));
    assert(writes == before_writes + 2 && commits == before_commits + 1);
    fail_commit = false;
    assert(config_load_pro_appearance(0) == 0x0409);
    assert(config_save_pro_appearance(0x0207));
    assert(config_load_pro_appearance(0) == 0x0207);
    assert(config_load_habitat_character(1) == 0 && round_writes == 2);
    assert(opens == closes && !opened);
    assert(config_load_pro_living(2)==2&&!living_writes);
    uint16_t original=stored;uint8_t original_round=round_stored;
    for(unsigned i=0;i<256;i++) {
        living_present=true;living_stored=(uint8_t)i;
        assert(config_load_pro_living(2)==(i<3?i:2));
        unsigned before=opens;
        assert(config_save_pro_living((uint8_t)i)==(i<3));
        if(i>=3)assert(opens==before);
        assert(stored==original&&round_stored==original_round);
    }
    assert(config_save_pro_living(1));fail_set=true;
    assert(!config_save_pro_living(2)&&living_stored==1);fail_set=false;
    fail_commit=true;assert(!config_save_pro_living(2)&&living_stored==1);fail_commit=false;
    fail_open=true;assert(config_load_pro_living(2)==2&&!config_save_pro_living(2));fail_open=false;
    fail_get=true;assert(config_load_pro_living(2)==2);fail_get=false;
    assert(!opened&&opens==closes);
    puts("Pro appearance: 65536 uint16 round trips, missing/read errors, round preference isolation, open/set/commit failures and retry PASS");
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-appearance-") as directory:
    out = Path(directory)
    (out / "test.c").write_text(CODE)
    binary = out / "test"
    subprocess.run([
        os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "address,undefined,bounds"),
        "-fno-omit-frame-pointer", "-I", str(MAIN), str(out / "test.c"), "-o", str(binary),
    ], check=True)
    env = dict(os.environ)
    env.setdefault("ASAN_OPTIONS", ("detect_leaks=0:" if sys.platform == "darwin" else "detect_leaks=1:") + "abort_on_error=1")
    env.setdefault("UBSAN_OPTIONS", "halt_on_error=1:print_stacktrace=1")
    subprocess.run([str(binary)], env=env, check=True)
