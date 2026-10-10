"""Replay Pod's record button through the production A_VOICE gates in ui_habitat.c.

Pod runs underneath Player 1's state: s.view stays HOME and s.agents is only the window's tab, while Pod can open
any agent of the library. pod_perform(POD_FX_VOICE_BEGIN) dispatches A_VOICE and the action worker starts the
recorder; both are sliced out of the production source here, with the cable, the audio client and the queue as the
boundary. Every case ends the way pod_perform's own check does: s.voice_start_pending set, or a notice that says why.
No USB, hardware writes or microphone.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

from native_shapes import defines, typedef

HERE = Path(__file__).resolve().parent
NATIVE = HERE / "../main/ui/habitat"
SOURCE = (NATIVE / "ui_habitat.c").read_text()


def function(name):
    match = re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{.*?^\}", SOURCE, re.M | re.S)
    assert match, f"production function missing: {name}"
    return match.group(0) + "\n"


def between(start, end):
    a = SOURCE.index(start)
    return SOURCE[a + len(start):SOURCE.index(end, a)]


code = r'''
#include "runtime.h"
#include "../../cable_features.h"
#include "../../cable_machines.h"
#include "gestures.h"
#include "scroll.h"
#include "workspace.h"
#include "selection.h"
#include "carry.h"
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "character.h"
#include "pro_canvas.h"
#include "pro_work_intent.h"
#include "pod_glue.h"
#include "pro_visual.h"
#include "pro_metrics.h"
#include "pro_art.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define ESP_LOGI(tag, ...) do { (void)(tag); if (false) fprintf(stderr, __VA_ARGS__); } while (0)
'''
code += defines("CABLE_READ_TOKEN_MAX", "ID_MAX", "CABLE_NAME_MAX", "SWARM_ID_MAX", "SWARMS_MAX",
                "SWARM_TILES_MAX", "CABLE_MAX_AGENTS", "MAX_PROJECTS")
code += defines("NOTICES", "QUESTION_MAX", "OPTION_MAX", "PANE_MEMORY_MAX", "PANE_RESULT_BYTES", "DRAFT_ROWS", "Q_ROWS", source=SOURCE)
code += "\n".join(re.findall(r"^#define TAB_\w+ \d+$", SOURCE, re.M)) + "\n"
code += SOURCE[SOURCE.index("typedef enum {"):SOURCE.index("static QueueHandle_t actions;")]
code += r'''
static void copy(char *dst, size_t cap, const char *src);
#define COPY(dst, src) copy(dst, sizeof(dst), src)
static ht_scroll_t scroll;
static ht_selection_t selection;
static ht_workspace_t workspace;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static pod_ui_t pod;
static uint32_t now = 5000;
static unsigned queued, changes, recorder_starts, queue_space = 20;
static action_t queued_action;
static char recorder_agent[ID_MAX];
static bool recorder_on;
static uint32_t ms(void) { return now; }
static void change(void) { changes++; }
static void display_lock(void) {}
static void display_unlock(void) {}
static bool queue(action_t a) {
    if (!queue_space) { COPY(s.title, "One moment"); COPY(s.message, "The cable is busy. Try again."); s.view = MESSAGE; return false; }
    queued++; queued_action = a; return true;
}
static void view(view_t v) { if (s.voice_open && v != VOICE) return; s.view = v; }
static bool audio_client_active(void) { return recorder_on; }
static bool audio_client_recording(void) { return recorder_on; }
static void audio_client_abort(void) { recorder_on = false; }
static void audio_client_copy_upload_id(char *out, size_t n) { snprintf(out, n, "up"); }
static void audio_client_request_review(void) {}
static void audio_client_stop(void) {}
static void audio_client_start_search(const char *a, const char *t, unsigned r) { (void)a; (void)t; (void)r; }
static void audio_client_start_draft(const char *t, unsigned r, bool x) { (void)t; (void)r; (void)x; }
static void audio_client_start_question(const char *a, const char *t, unsigned r) { (void)a; (void)t; (void)r; }
static void audio_client_start_form(const char *t, unsigned r) { (void)t; (void)r; }
static void audio_client_start_carry(const char *a, const char *t) { (void)a; (void)t; }
static void audio_client_start_selection(const char *a, const char *t, unsigned r) { (void)a; (void)t; (void)r; }
typedef enum { VOICE_CMD_NONE, VOICE_CMD_GOAL, VOICE_CMD_LOOP } voice_cmd_t;
static void audio_client_start_cable(const char *agent, voice_cmd_t cmd) {
    (void)cmd; recorder_starts++; recorder_on = true; snprintf(recorder_agent, sizeof recorder_agent, "%s", agent ? agent : "");
}
bool cable_client_supports(uint32_t feature) { (void)feature; return true; }
static agent_t *active(void) { return s.active >= 0 && s.active < s.count ? &s.agents[s.active] : NULL; }
static void pro_speech_cancel(bool any) { (void)any; }
static void pro_selection_search_refuse(void) {}
static bool pro_selection_owned(void) { return false; }
static bool pro_carry_available(void) { return false; }
static bool question_view(view_t v) { return v == QUESTION; }
static void pro_send_feedback_clear(void) { memset(&s.send_feedback, 0, sizeof s.send_feedback); }
static void voice_close(void);
static void dispatch(action_t a);
'''
for name in ("copy", "find", "pro_work_local", "pro_work_visible", "pro_work_block_reason", "pro_work_available",
             "pod_voice_block_reason", "pro_work_capture_pin", "pro_work_capture_available", "voice_close", "pod_perform"):
    code += function(name)
code += ("static void dispatch(action_t a) {\n    switch (a.kind) {\n    case A_VOICE:\n" +
         between("    case A_VOICE:\n#ifdef DEVICE_PRO_COMPANION\n", "    case A_VOICE_STOP:").join(["#ifdef DEVICE_PRO_COMPANION\n", ""]) +
         "    case A_VOICE_ABORT: audio_client_abort(); voice_close(); break;\n    default: break;\n    }\n}\n")
code += ("static void worker(action_t a) {\n    switch (a.kind) {\n        case A_VOICE:\n" +
         between("        case A_VOICE:\n            display_lock();\n", "        case A_VOICE_ABORT:\n            cable_client_voice_cancel").join(["            display_lock();\n", ""]) +
         "        default: break;\n    }\n}\n")
code += r'''
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); exit(1); } } while (0)
static void agent(int i, const char *id, const char *name, const char *engine, const char *machine) {
    snprintf(s.agents[i].id, ID_MAX, "%s", id); snprintf(s.agents[i].name, sizeof s.agents[i].name, "%s", name);
    snprintf(s.agents[i].engine, sizeof s.agents[i].engine, "%s", engine);
    snprintf(s.agents[i].machine_id, sizeof s.agents[i].machine_id, "%s", machine);
}
// The device's real situation: the daemon session is up, the window's tab holds three agents, Pod sits on HOME.
static void situation(void) {
    memset(&s, 0, sizeof s); memset(&scroll, 0, sizeof scroll); memset(&workspace, 0, sizeof workspace);
    memset(&selection, 0, sizeof selection); memset(&carry, 0, sizeof carry); memset(&visit, 0, sizeof visit);
    memset(&form, 0, sizeof form); memset(&draft, 0, sizeof draft);
    pod_ui_init(&pod);
    queued = changes = recorder_starts = 0; queue_space = 20; recorder_on = false; recorder_agent[0] = 0;
    s.ready = s.connected = true; s.view = HOME; s.pressed = -1; s.active = 0; s.count = 3;
    strcpy(s.draft_recovery.current_host, "host-mac");
    agent(0, "a1", "Alpha", "claude", "host-mac"); agent(1, "a2", "Bravo", "codex", "host-mac");
    agent(2, "a3", "Charlie", "claude", "host-mac");
    strcpy(s.machines[0].id, "host-mac"); strcpy(s.machines[0].state, "online"); s.machine_count = 1;
    pod_ui_link(&pod, true);
}
// What pod_perform does for the triangle, then the worker that the queued action reaches.
static const char *press(const char *id, bool *started) {
    pod_out_t o; memset(&o, 0, sizeof o);
    o.fx = POD_FX_VOICE_BEGIN; snprintf(o.agent, sizeof o.agent, "%s", id);
    queued = 0; pod_perform(o);
    if (queued) { worker(queued_action); }
    *started = s.voice_open && recorder_on && !strcmp(recorder_agent, id);
    return pod.notice_on ? pod.notice : "";
}
static void in_roster(void) {
    situation(); bool ok; const char *n = press("a2", &ok);
    CHECK(ok && !n[0]);
}
static void library_only(void) {
    situation(); bool ok; const char *n = press("lib-7", &ok);
    fprintf(stderr, "library-only: started=%d notice='%s' title='%s' message='%s'\n", ok, n, s.title, s.message);
    CHECK(ok && !n[0]);
}
static void roster_not_yet_refreshed(void) {   // the reconnect's roster has not been confirmed (work_roster_pending)
    situation(); s.work_roster_pending = true; bool ok; const char *n = press("a2", &ok);
    fprintf(stderr, "roster pending: started=%d notice='%s'\n", ok, n);
    CHECK(ok && !n[0]);
}
static void booting(void) {                    // s.loading is still up
    situation(); s.loading = true; bool ok; const char *n = press("a2", &ok);
    fprintf(stderr, "loading: started=%d notice='%s'\n", ok, n);
    CHECK(ok && !n[0]);
}
static void question_agent_says_why(void) {
    situation();
    cable_notif_t *q = &s.notice[0]; memset(q, 0, sizeof *q); s.notice_count = 1;
    strcpy(q->agent_id, "a2"); q->question = q->question_current = true;
    bool ok; const char *n = press("a2", &ok);
    CHECK(!ok && !strcmp(n, "Answer its question first."));
}
static void offline_machine_says_why(void) {
    situation(); strcpy(s.machines[0].state, "offline"); strcpy(s.agents[1].machine_id, "other");
    strcpy(s.machines[1].id, "other"); strcpy(s.machines[1].state, "offline"); s.machine_count = 2;
    bool ok; const char *n = press("a2", &ok);
    CHECK(!ok && !strcmp(n, "This computer is offline."));
}
static void busy_cable_says_why(void) {
    situation(); queue_space = 0; bool ok; const char *n = press("a2", &ok);
    CHECK(!ok && n[0] && strcmp(n, "Can't talk right now"));
    CHECK(s.view == HOME);   // the cable-busy MESSAGE must not strand Pod's gates on another view
}
static void library_only_after_message_view(void) {
    situation(); s.view = MESSAGE; bool ok; const char *n = press("lib-7", &ok);
    CHECK(ok && !n[0]);
}
static void not_connected(void) {
    situation(); s.connected = false; bool ok; const char *n = press("a2", &ok);
    CHECK(!ok && !strcmp(n, "Not connected"));
}
int main(int argc, char **argv) {
    static const struct { const char *name; void (*run)(void); } tests[] = {
        {"in_roster", in_roster}, {"library_only", library_only}, {"roster_not_yet_refreshed", roster_not_yet_refreshed},
        {"booting", booting}, {"question_agent_says_why", question_agent_says_why},
        {"offline_machine_says_why", offline_machine_says_why}, {"busy_cable_says_why", busy_cable_says_why},
        {"library_only_after_message_view", library_only_after_message_view}, {"not_connected", not_connected},
    };
    int failed = 0;
    for (unsigned i = 0; i < sizeof tests / sizeof tests[0]; i++)
        if (argc == 1 || !strcmp(argv[1], tests[i].name)) { tests[i].run(); printf("PASS %s\n", tests[i].name); }
    return failed;
}
'''

modules = sorted(p for p in (NATIVE / "pod").glob("*.c")) + [NATIVE / "pod_glue.c", NATIVE / "pro_canvas.c", NATIVE / "terminal.c",
                                                           NATIVE / "fonts.c", NATIVE / "gestures.c", NATIVE / "scroll.c",
                                                           NATIVE / "workspace.c", NATIVE / "selection.c", NATIVE / "carry.c",
                                                           NATIVE / "visit.c", NATIVE / "form.c", NATIVE / "draft.c"]
GENERATED = HERE / "../../prototype/pro-companion/generated"
names = re.findall(r'\{"([a-z_]+)", [a-z_]+\}', code)
with tempfile.TemporaryDirectory(prefix="harness-pod-voice-") as directory:
    source = Path(directory) / "pod_voice.c"
    source.write_text(code)
    executable = Path(directory) / "pod_voice"
    command = [os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
               "-Wno-unused-variable", "-O1", "-g", "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
               "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DDEVICE_POD=1",
               "-I", str(NATIVE), "-I", str(HERE / "../main"), "-I", str(HERE / "host_stubs"), "-I", str(GENERATED),
               str(source), *map(str, modules), str(GENERATED / "pro_fonts.c"), "-lpthread", "-o", str(executable)]
    subprocess.run(command, check=True)
    failures = []
    for name in names:
        result = subprocess.run([str(executable), name], text=True, capture_output=True)
        if result.stderr.strip():
            print(result.stderr.strip())
        if result.returncode:
            failures.append(name)
            print(f"FAIL {name}")
        else:
            print(result.stdout.strip())
    assert not failures, f"Pod voice gate regressions: {', '.join(failures)}"
    print(f"Pod voice gates: {len(names)} production-handler replays passed")
