"""The Pro's hello: exactly the keys owner decision 7 names, in order, and none of the round dial's.

send_hello is lifted out of main/cable/pro_cable.c and compiled against stubs that record each key and value, so this
checks the real builder. The capability keys (swarms, recap, activity, player) are what make the daemon send the Pro
extra fields; the round dial's carry, draft, form, visit, workspace, selection and metrics, and speech, must not appear."""
from pathlib import Path
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / "../main"
source = (main / "cable/pro_cable.c").read_text()
match = re.search(r"^static void send_hello\(void\)\n\{.*?^\}", source, re.M | re.S)
assert match, "send_hello not found in pro_cable.c"
body = match.group(0)
settings = re.search(r"^static bool msg_settings\(cJSON \*\*root\)\n\{.*?^\}", source, re.M | re.S)
assert settings, "msg_settings not found in pro_cable.c"
body = re.search(r"^static int bright_pct.*$", source, re.M).group(0) + "\n" + settings.group(0) + "\n" + body

code = r'''
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef struct cJSON { int unused; } cJSON;
typedef struct { const char *name; } board_t;
static const board_t *board(void) { static const board_t b = {"pro-stub"}; return &b; }
static cJSON root_obj;
static const char *pro_cable_fw_version(void) { return "0.0.0"; }
static bool device_mac_str(char *o, size_t n) { snprintf(o, n, "aa"); return true; }
static cJSON *msg(const char *t) { printf("type=%s\n", t); return &root_obj; }
static bool msg_string(cJSON **r, const char *k, const char *v) { (void)r; printf("%s=%s\n", k, v); return true; }
static bool msg_number(cJSON **r, const char *k, double v) { (void)r; printf("%s=%d\n", k, (int)v); return true; }
static void send_json(cJSON *r) { (void)r; }
static bool msg_check(cJSON **r, bool ok) { (void)r; return ok; }
static cJSON obj;
static cJSON *cJSON_CreateObject(void) { return &obj; }
static bool cJSON_AddItemToObject(cJSON *o, const char *k, cJSON *v) { (void)o; (void)v; printf("%s={\n", k); return true; }
static void cJSON_Delete(cJSON *o) { (void)o; }
static cJSON *cJSON_AddNumberToObject(cJSON *o, const char *k, double v) { printf("S.%s=num:%d\n", k, (int)v); return o; }
static cJSON *cJSON_AddBoolToObject(cJSON *o, const char *k, bool v) { printf("S.%s=bool:%d\n", k, v); return o; }
static cJSON *cJSON_AddStringToObject(cJSON *o, const char *k, const char *v) { printf("S.%s=str:%s\n", k, v); return o; }
static uint8_t config_load_brightness(void) { return 220; }
static bool config_load_muted(void) { return true; }
static void config_load_voicelang(char *o, size_t n) { snprintf(o, n, "en"); }
#define CFG_VLANG_MAX 8
#define CABLE_PRODUCT "harness"
#define CABLE_PROTO_VERSION 3
''' + body + r'''
int main(void) { send_hello(); return 0; }
'''

with tempfile.TemporaryDirectory() as d:
    src = Path(d) / "hello.c"
    src.write_text(code)
    exe = Path(d) / "hello"
    subprocess.run(["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Werror", "-Wno-unused-function", "-o", str(exe), str(src)], check=True)
    lines = subprocess.run([str(exe)], check=True, capture_output=True, text=True).stdout.split()

# The settings object: every key the app's DeviceSettings.fromJson requires, with its JSON type. Otherwise the app
# drops the whole object.
sett = {l[2:].split("=", 1)[0]: l.split("=", 1)[1] for l in lines if l.startswith("S.")}
want = {"brightness": "num:86", "character": "num:0", "face": "num:0", "voiceLang": "str:en", "muted": "bool:1",
        "quiet": "bool:0", "straightTitle": "bool:0", "focusFace": "bool:0", "scrollReversed": "bool:0", "round": "bool:0"}
assert sett == want, sett
lines = [l for l in lines if not l.startswith("S.")]

assert lines[0] == "type=hello", lines
pairs = [tuple(x.split("=", 1)) for x in lines[1:]]
# Exactly these keys, in this order (owner decision 7 + the activity capability).
assert pairs == [
    ("fw", "0.0.0"),
    ("product", "harness"),
    ("proto", "3"),
    ("hw", "pro-stub"),
    ("board", "pro"),
    ("swarms", "members-v1"),
    ("recap", "long-v1"),
    ("activity", "steps-v1"),
    ("player", "library-v1"),
    ("ota", "v1"),
    ("mac", "aa"),
    ("settings", "{"),
], pairs
keys = {k for k, _ in pairs}
for round_only in ("carry", "draft", "speech", "form", "visit", "workspace", "selection", "metrics", "pcm16"):
    assert round_only not in keys and round_only not in body, f"hello mentions {round_only}"
# The real hello is not conditional on a board define: nothing in it may be compiled out.
assert "#if" not in body and "DEVICE_" not in body
print("Pro hello: fw product proto hw board swarms recap activity player ota mac, and no round-dial keys")
