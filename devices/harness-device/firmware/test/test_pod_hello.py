"""The Pod hello: a Pro built with DEVICE_POD tells the daemon `"swarms":"members-v1"` and "recap":"long-v1" (top-level strings), which is what
makes the daemon send swarms agentIds and the longer recap text to it. Other builds must not say it. send_hello is lifted out of
main/cable_client.c and compiled against stubs that record each key/value, so this checks the real builder."""
from pathlib import Path
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / "../main"
source = (main / "cable_client.c").read_text()
match = re.search(r"^static void send_hello\(void\)\n\{.*?^\}", source, re.M | re.S)
assert match, "send_hello not found"

code = r'''
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
typedef struct cJSON { int unused; } cJSON;
typedef struct { const char *name; } board_t;
static const board_t *board(void) { static const board_t b = {"stub"}; return &b; }
static cJSON root_obj;
static const char *cable_fw_version(void) { return "0.0.0"; }
static bool audio_speech_available(void) { return true; }
static void device_mac_str(char *o, size_t n) { snprintf(o, n, "aa"); }
static cJSON *msg(const char *t) { printf("type=%s\n", t); return &root_obj; }
static bool msg_string(cJSON **r, const char *k, const char *v) { (void)r; printf("%s=%s\n", k, v); return true; }
static bool msg_number(cJSON **r, const char *k, int v) { (void)r; printf("%s=%d\n", k, v); return true; }
static void send_json(cJSON *r) { (void)r; }
#define CABLE_PRODUCT "harness"
#define CABLE_PROTO_VERSION 1
''' + match.group(0) + r'''
int main(void) { send_hello(); return 0; }
'''

def hello(defines):
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "hello.c"
        src.write_text(code)
        exe = Path(d) / "hello"
        subprocess.run(["cc", "-std=c11", "-Wall", "-Werror", "-Wno-unused-function", *defines, "-o", str(exe), str(src)], check=True)
        return subprocess.run([str(exe)], check=True, capture_output=True, text=True).stdout.split()

pod = hello(["-DDEVICE_PRO_COMPANION", "-DDEVICE_POD"])
assert "swarms=members-v1" in pod and "player=library-v1" in pod and "speech=pcm16-v1" in pod and "recap=long-v1" in pod, pod
pro = hello(["-DDEVICE_PRO_COMPANION"])
assert not any(x.startswith(("swarms=", "recap=")) for x in pro), pro
plain = hello([])
assert not any(x.startswith(("swarms=", "recap=")) for x in plain), plain
print("Pod hello: swarms=members-v1 and recap=long-v1 only in the Pod build")
