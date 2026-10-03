"""Compile the actual Habitat voice handlers with deterministic hardware/queue stubs.

Exercises asynchronous start, discard, late replies, screen ownership and duration limits.
This tests production function bodies, not a second implementation of the state machine.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

native = Path(__file__).resolve().parent / '../main/ui/habitat'
source = (native / 'ui_habitat.c').read_text()


def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'


harness = re.search(r'^#define PANE_MEMORY_MAX \d+$', source, re.M).group(0) + '\n'
harness += r'''
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <assert.h>
#include "../../cable_features.h"
static uint32_t host_features=31;
static bool cable_client_supports(uint32_t features) { return (host_features & features)==features; }
#include "selection.h"
#include "carry.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "workspace.h"
enum { HOME, AGENTS, AGENT, COMPANION, VOICE, MESSAGE, SELECTION, FORM, QUESTION, CHOICE, ANSWER_REVIEW, DRAFT, DRAFT_OPTIONS, INBOX };
enum { A_VOICE, A_VOICE_STOP, A_VOICE_ABORT };
enum { VOICE_CMD_NONE, VOICE_CMD_GOAL };
typedef int view_t;
typedef struct { int kind, value, dy; uint32_t revision; char id[64], text[192]; } action_t;
typedef struct { char name[64], id[64], engine[12]; } agent_t;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static ht_workspace_t workspace;
enum { HT_CHARACTER_COUNT = 13 };
static int desktop_companion;
typedef struct { int8_t colour; } ui_companion_t;
static ui_companion_t desktop_identity;
static bool companion_celebrating;
static void select_companion(void) {}
static ht_tab_carousel_t tab_carousel;
#define PANE_PITCH 60
static struct {
    bool quick_open, coasting, ready, connected, loading, nap, voice_open, voice_start_pending, voice_waiting, voice_carry, voice_review, voice_review_preview, voice_draft_append, voice_search, touch_down, touch_cancelled;
    int pet_pose, view, voice_return, offset, pressed, active, pane_pos;
    uint32_t pet_until, nap_until, voice_retry_until, voice_started, voice_wait_until, voice_generation, voice_question_revision, voice_draft_revision;
    int voice_question_index;
    char title[80], message[256], voice_target[64], voice_engine[12], pending_focus[64], pending_machine[64], opening_notice[48];
    struct { bool valid, supported, loading, pending, uncertain; uint32_t revision, deadline; int index; char error[120],speech_error[96],agent[64],token[48]; struct { bool can_text; } item[4]; } q;
    agent_t agents[1];
    struct { bool live_summary; } memory[PANE_MEMORY_MAX];
} s;
static uint32_t now;
static bool audio_active, recording, abort_requested, queue_full;
static int starts, stops, aborts, cancels, confirms, scroll, gesture, reviews;
static action_t queued;
static agent_t *active(void) { return &s.agents[0]; }
#define COPY(dst, src) snprintf(dst, sizeof(dst), "%s", (src) ? (src) : "")
#define ESP_LOGI(...) ((void)0)
uint32_t ms(void) { return now; }
void change(void) {}
void surface_tick(uint32_t value) { (void)value; }
void display_lock(void) {}
void display_unlock(void) {}
void display_bump_activity(void) {}
void ht_scroll_cancel(int *value) { (void)value; }
void ht_gesture_guard(int *value, uint32_t time) { (void)value; (void)time; }
void ht_gesture_cancel(int *value) { (void)value; }
bool audio_client_active(void) { return audio_active; }
bool audio_client_recording(void) { return recording; }
void audio_client_stop(void) { stops++; }
void audio_client_request_review(void) { reviews++; }
void audio_client_abort(void) { aborts++; abort_requested = true; }
void audio_client_copy_upload_id(char *dst, size_t cap) { snprintf(dst, cap, "capture-%d", starts); }
void audio_client_start_cable(const char *id, int cmd) {
    (void)id; (void)cmd; starts++; audio_active = recording = true; abort_requested = false;
}
void audio_client_start_search(const char *id, const char *selected, unsigned revision) {
    assert(!strcmp(selected,"search-test") && revision==3); audio_client_start_cable(id,VOICE_CMD_NONE);
}
void audio_client_start_form(const char *id, unsigned revision) {
    assert(!strcmp(id, "form-test") && revision==3); audio_client_start_cable(NULL, VOICE_CMD_NONE);
}
void audio_client_start_question(const char *id,const char *token,unsigned index) {
    assert(!strcmp(token,"question-token") && index==0); audio_client_start_cable(id,VOICE_CMD_NONE);
}
void audio_client_start_draft(const char *id, unsigned revision, bool append) {
    assert(!strcmp(id,"draft-test") && revision==3); (void)append; audio_client_start_cable(NULL,VOICE_CMD_NONE);
}
void cable_client_voice_cancel(const char *id) { assert(id[0]); cancels++; }
void audio_client_start_selection(const char *id, const char *selected, unsigned revision) {
    assert(selected && selected[0] && revision); audio_client_start_cable(id, VOICE_CMD_NONE);
}
void audio_client_start_carry(const char *id, const char *carried) {
    assert(!strcmp(carried,"carry-test")); audio_client_start_cable(id, VOICE_CMD_NONE);
}
void cable_client_voice_confirm(const char *route, const char *id) { (void)route; (void)id; confirms++; }
int find(const char *id) { return id && !strcmp(id, "agent") ? 0 : -1; }
bool is_question(const char *id) { (void)id; return false; }
void open_question(void) { assert(false); }
bool queue(action_t action) { if (queue_full) return false; queued = action; return true; }
'''
harness += function('question_view') + function('copy') + function('input_cancel') + function('view') + function('voice_close') + function('workspace_failed')
dispatch = source.split('case A_VOICE:\n', 1)[1].split('case A_PET:', 1)[0]
harness += 'static void dispatch(action_t a) { switch (a.kind) { case A_VOICE:\n' + dispatch + '} }\n'
worker = source.split('static void worker(', 1)[1].split('case A_VOICE:\n', 1)[1].split('case A_STOP_YES:', 1)[0]
harness += 'static void work(action_t a) { switch (a.kind) { case A_VOICE:\n' + worker + '} }\n'
for name in ['habitat_tick', 'ui_set_connected', 'ui_show_error', 'ui_cable_toast',
             'ui_voice_error', 'ui_voice_routed', 'ui_voice_route_abort']:
    harness += function(name)
harness += r'''
static void reset(void) {
    memset(&workspace,0,sizeof workspace);
    memset(&tab_carousel,0,sizeof tab_carousel);
    host_features=31; memset(&draft,0,sizeof draft); reviews=0; memset(&s, 0, sizeof(s)); memset(&visit, 0, sizeof(visit)); memset(&carry,0,sizeof(carry)); now = 1000;
    s.ready = s.connected = true; s.view = HOME;
    strcpy(s.agents[0].name, "Agent");
    audio_active = recording = abort_requested = queue_full = false;
    starts = stops = aborts = cancels = confirms = 0;
}
static void speak(void) { dispatch((action_t){.kind = A_VOICE, .id = "agent"}); }
static void done(void) { dispatch((action_t){.kind = A_VOICE_STOP}); }
static void discard(void) { dispatch((action_t){.kind = A_VOICE_ABORT}); }
static void finish_audio(void) { audio_active = recording = false; }
static void begin(void) { speak(); work(queued); assert(recording && s.view == VOICE); }
int main(void) {
    // The listening scene follows whom the turn is for: an agent's engine, nothing for a draft.
    reset(); strcpy(s.agents[0].engine, "claude"); begin(); assert(!strcmp(s.voice_engine, "claude"));
    reset(); host_features=0; begin(); dispatch((action_t){.kind=A_VOICE_STOP,.value=1});
    assert(!reviews && !s.voice_review && s.voice_waiting);
    reset(); begin(); dispatch((action_t){.kind=A_VOICE_STOP,.value=1});
    assert(reviews==1 && s.voice_review && s.voice_waiting);
    finish_audio(); ui_voice_routed(true,false,"","agent","Agent",1);
    assert(s.voice_open && s.voice_waiting); // Normal route receipt cannot bypass review.
    discard(); assert(!s.voice_open && !s.voice_review);
    reset(); strcpy(s.agents[0].engine, "claude"); s.view=DRAFT; draft.page=(ht_draft_page_t){.active=true,.revision=3,.id="draft-test",.name="Original"};
    view(HOME); assert(s.view==DRAFT);
    action_t edit={.kind=A_VOICE,.value=5,.revision=2,.dy=2,.text="draft-test"};
    dispatch(edit); assert(!s.voice_open);
    edit.revision=edit.dy=3; dispatch(edit); work(queued);
    assert(starts==1 && s.voice_return==DRAFT && s.voice_review && !strcmp(s.voice_target,"Original") && !s.voice_engine[0]);
    done(); finish_audio(); ui_voice_error("Couldn't hear it");
    assert(s.view==DRAFT && draft.failed && draft.page.error[0]);
    draft.failed=false; dispatch(edit); work(queued); discard(); finish_audio();
    assert(s.view==DRAFT && draft.page.active && !s.voice_open);
    ui_set_connected(false); assert(s.view==HOME && !draft.page.active);

    reset(); s.view=QUESTION; s.q.valid=s.q.supported=s.q.item[0].can_text=true;
    s.q.revision=5; strcpy(s.q.token,"question-token"); strcpy(s.q.agent,"agent");
    action_t question_voice={.kind=A_VOICE,.value=4,.revision=4,.dy=0,.id="agent",.text="question-token"};
    dispatch(question_voice); assert(!s.voice_open && !starts); // stale target never records
    question_voice.revision=5; dispatch(question_voice); work(queued);
    assert(recording && s.voice_return==QUESTION && s.voice_question_revision==5 && s.voice_question_index==0);
    done(); finish_audio(); ui_voice_routed(true,false,"","agent","Agent",1);
    assert(s.voice_open && s.voice_waiting); // a task-routing reply cannot consume question speech
    ui_voice_error("Transcription failed"); assert(!s.voice_open && s.view==QUESTION && s.q.speech_error[0]);
    dispatch(question_voice); work(queued); discard(); finish_audio();
    assert(!s.voice_open && s.view==QUESTION && starts==2); // Discard goes back to the question
    reset(); carry.active=true; strcpy(carry.id,"carry-test"); carry.deadline=now+100;
    dispatch((action_t){.kind=A_VOICE,.value=3,.id="agent",.text="wrong"});
    assert(!s.voice_open && !starts);
    dispatch((action_t){.kind=A_VOICE,.value=3,.id="agent",.text="carry-test"});
    work(queued); assert(s.voice_carry && recording);
    now+=200; habitat_tick(); assert(carry.active); // the started recording keeps its frozen context
    discard(); finish_audio(); assert(carry.active); // Discard drops audio, not the held text
    habitat_tick(); assert(!carry.active && carry.error[0]);
    speak(); assert(!s.voice_open && starts==1); // expiry cannot fall through to bare voice
    ht_carry_close(&carry); begin(); assert(recording && !s.voice_carry);
    reset(); carry.active=true; strcpy(carry.id,"carry-test"); carry.deadline=now+300000;
    dispatch((action_t){.kind=A_VOICE,.value=3,.id="agent",.text="carry-test"});
    work(queued); done(); finish_audio(); ui_voice_routed(true,false,"","agent","Agent",1);
    assert(!carry.active && !s.voice_carry && !s.voice_open);
    reset(); strcpy(form.id, "form-test"); speak();
    assert(!s.voice_open && !starts && s.view==FORM);
    memset(&form,0,sizeof form);
    reset(); visit.pending=true; speak();
    assert(!s.voice_open && !starts); // Do not speak to a pane during an unresolved visit.
    reset(); dispatch((action_t){.kind = A_VOICE});
    assert(!s.voice_open && !starts); // Home routing is deferred, never fall into Cmd-B by accident.
    reset(); speak(); action_t delayed = queued;
    now += 5000; habitat_tick();
    assert(s.voice_start_pending && s.view == VOICE && !starts);
    discard(); work(delayed);
    assert(!starts && !s.voice_open && s.view == HOME);
    begin();
    for (; now < 66000; now += 50) habitat_tick();
    assert(recording && s.voice_open && !stops);
    view(HOME); ui_cable_toast("unrelated desktop notice");
    ui_voice_error("old route failed");
    ui_voice_routed(true, false, "", "agent", "Agent", 1);
    assert(s.view == VOICE && recording && s.voice_open);
    done(); uint32_t deadline = s.voice_wait_until;
    now += 20; done();
    assert(stops == 1 && s.voice_wait_until == deadline);
    finish_audio();
    ui_cable_toast("unrelated desktop notice"); view(HOME);
    assert(s.view == VOICE && s.voice_waiting);
    discard(); work(queued);
    assert(cancels == 1 && s.view == HOME && !s.voice_waiting);
    ui_voice_error("discarded route failed");
    ui_voice_routed(true, false, "", "agent", "Agent", 1);
    assert(s.view == HOME);
    begin();
    ui_voice_error("discarded route replied during new capture");
    assert(s.view == VOICE && recording);
    done(); finish_audio(); ui_voice_error("current route failed");
    assert(s.view == MESSAGE && !s.voice_open);
    begin(); done(); finish_audio();
    ui_voice_routed(true, false, "", "agent", "Agent", 1);
    assert(s.view == AGENT && !s.voice_open);

    // Empty transcription is a transient hint on the companion, not a modal.
    reset(); begin(); done(); finish_audio(); now=UINT32_MAX-1000;
    ui_voice_error("Didn't catch that");
    assert(s.view==HOME && !s.voice_open && !s.voice_waiting && s.voice_retry_until);
    uint32_t retry_deadline=s.voice_retry_until;
    now=retry_deadline-1; habitat_tick(); assert(s.voice_retry_until==retry_deadline);
    now=retry_deadline; habitat_tick(); assert(!s.voice_retry_until && s.view==HOME);
    begin(); done(); finish_audio(); ui_voice_error("Didn't catch that");
    assert(s.voice_retry_until && starts==2);
    begin(); assert(recording && starts==3 && !s.voice_retry_until);
    ui_voice_error("Didn't catch that"); assert(recording && s.view==VOICE); // old reply
    done(); finish_audio(); now=UINT32_MAX-2999; ui_voice_error("Didn't catch that");
    assert(s.voice_retry_until==1); now=1; habitat_tick(); assert(!s.voice_retry_until);
    begin(); done(); finish_audio(); ui_voice_error("Didn't catch that");
    ui_set_connected(false); assert(!s.voice_retry_until);

    reset(); begin(); now = 601000; habitat_tick();
    assert(stops == 1 && s.voice_waiting);
    deadline = s.voice_wait_until;
    now++; habitat_tick(); assert(stops == 1 && s.voice_wait_until == deadline);
    finish_audio(); now = deadline; habitat_tick();
    assert(s.view == MESSAGE && !s.voice_open && !s.voice_waiting);
    begin(); // expiration must not disable the next Speak

    reset(); speak(); delayed = queued; COPY(s.pending_machine,"machine"); ui_set_connected(false); work(delayed);
    assert(!s.pending_machine[0]);
    assert(!starts && !s.voice_open && s.view == HOME);
    ui_set_connected(true); begin();
    // Recover from a legacy hidden capture without allocating a second one.
    s.view = HOME; s.voice_open = false; speak();
    assert(s.view == VOICE && s.voice_open && starts == 1);
    ui_set_connected(false); assert(abort_requested && !s.voice_open);

    reset(); queue_full = true; speak();
    assert(!s.voice_open && !s.voice_start_pending && !starts);
    queue_full = false; begin(); finish_audio(); now += 1000; habitat_tick();
    assert(s.view == MESSAGE && !s.voice_open);
    reset(); strcpy(form.id,"form-test"); form.page.active=form.page.can_query=true;
    form.page.revision=3; s.view=FORM;
    action_t search={.kind=A_VOICE,.value=2,.dy=2,.text="form-test"};
    dispatch(search); assert(!starts && !s.voice_open); // stale field
    search.dy=3; dispatch(search); work(queued);
    assert(starts==1 && recording && s.view==VOICE && s.voice_return==FORM);
    done(); finish_audio(); ui_voice_routed(true,false,"","agent","Agent",1);
    assert(s.view==VOICE && s.voice_waiting); // never accept a task-routing reply
    ui_voice_error("No matches yet"); assert(s.view==FORM && !s.voice_open);
    assert(!strcmp(form.page.error,"No matches yet"));
    dispatch(search); work(queued); discard(); work(queued); finish_audio();
    assert(s.view==FORM && !s.voice_open && cancels==1);
    dispatch(search); delayed=queued; discard(); work(delayed); assert(starts==2);
    memset(&form,0,sizeof form);
    reset(); memset(&selection,0,sizeof selection); selection.active=true; selection.revision=3;
    strcpy(selection.id,"search-test"); strcpy(selection.agent,"agent"); s.view=SELECTION;
    action_t lookup={.kind=A_VOICE,.value=7,.dy=2,.id="agent",.text="search-test"};
    dispatch(lookup); assert(!s.voice_open); lookup.dy=3; dispatch(lookup); work(queued);
    assert(recording && s.voice_search && s.voice_return==SELECTION && !s.voice_review);
    dispatch((action_t){.kind=A_VOICE_STOP,.value=1}); assert(s.voice_waiting && !s.voice_review && !reviews);
    finish_audio(); ui_voice_routed(true,false,"","agent","Agent",1); assert(s.voice_open);
    ui_voice_error("Say the phrase again"); assert(!s.voice_open && s.view==SELECTION && selection.error[0]);
    selection.error[0]=0; dispatch(lookup); work(queued); discard(); finish_audio();
    assert(!selection.active && s.view==HOME);
    puts("voice UI: PASS (production handlers; queued cancellation, discard/retry, late replies, modal ownership, timeout, cap, disconnect and hidden-capture recovery)");
}
'''

with tempfile.TemporaryDirectory(prefix='harness-voice-ui-') as directory:
    root = Path(directory)
    (root / 'voice_ui.c').write_text(harness)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(native), str(root / 'voice_ui.c'), str(native / 'selection.c'), str(native / 'carry.c'), str(native / 'visit.c'), str(native / 'form.c'), str(native / 'draft.c'), str(native / 'workspace.c'),
                    '-o', str(root / 'voice_ui')], check=True)
    subprocess.run([str(root / 'voice_ui')], check=True)
