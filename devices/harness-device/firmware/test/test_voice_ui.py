"""Compile the actual Habitat voice handlers with deterministic hardware/queue stubs.

Exercises asynchronous start, discard, late replies, screen ownership and duration limits.
This tests production function bodies, not a second implementation of the state machine.
"""
from pathlib import Path
import os
import re
import subprocess
import sys
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
// Localization is covered separately; exercise both shared and Pro handlers.
#define PRO_TR(text) (text)
#include <assert.h>
#include "../../cable_features.h"
static uint32_t host_features=31;
static bool cable_client_supports(uint32_t features) { return (host_features & features)==features; }
#include "selection.h"
#include "carry.h"
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "workspace.h"
#include "pro_work_intent.h"
#include "pro_metrics.h"
enum { HOME, AGENTS, AGENT, COMPANION, VOICE, MESSAGE, SELECTION, FORM, QUESTION, CHOICE, ANSWER_REVIEW, DRAFT, DRAFT_OPTIONS, INBOX, LAUNCHER, WORK_INTENT, TODAY, CARRY_PREVIEW, VOICE_SAMPLES, VOICE_PARAMS };
enum { A_VOICE, A_VOICE_STOP, A_VOICE_ABORT, A_WORK_INTENT, A_WORK_MODE, A_WORK_RECORD,
    A_DRAFT_EDIT, A_DRAFT_APPEND, A_DRAFT_UNDO, A_DRAFT_SEND, A_DRAFT_DISCARD, A_DRAFT_STATE, A_DRAFT_OPTIONS, A_DRAFT_BACK, A_CARRY_PREVIEW, A_DRAFT_COMMAND };
enum { VOICE_CMD_NONE, VOICE_CMD_GOAL, VOICE_CMD_LOOP };
typedef int view_t;
typedef struct { int kind, value, dy, velocity; uint32_t revision; char id[64], text[192]; } action_t;
#define ID_MAX 48
typedef struct { char name[64], id[64], engine[16], machine_id[48], machine[64], session[80]; } agent_t;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static ht_workspace_t workspace;
static ht_tab_carousel_t tab_carousel;
static struct {
    bool workspace_chord, quick_open, coasting, ready, connected, loading, nap, voice_open, voice_start_pending, voice_waiting, voice_carry, voice_review, voice_review_preview, voice_draft_append, voice_search, touch_down, touch_cancelled;
    int pet_pose, view, voice_return, offset, pressed, active;
    uint32_t pet_until, nap_until, voice_retry_until, voice_started, voice_wait_until, voice_generation, voice_question_revision, voice_draft_revision;
    int voice_question_index;
    char title[80], message[256], voice_target[64], pending_focus[64], pending_machine[64], opening_notice[48];
    char notice_host[48];
    char work_agent[64], work_host[48]; uint32_t work_revision, work_generation; uint8_t work_mode, work_voice_mode;
    struct {char draft[48],agent[48],host[48],machine[48],session[80];uint32_t request,until;uint8_t mode;bool accepted;} send_feedback;
    pro_metrics_t metrics; pro_carry_review_t carry_review; pro_draft_recovery_t draft_recovery;
    struct { bool valid, supported, loading, pending, uncertain; uint32_t revision, deadline; int index; char error[120],speech_error[96],agent[64],name[64],token[48]; struct { bool can_text; } item[4]; } q;
    agent_t agents[1];
    struct { bool live_summary; } memory[PANE_MEMORY_MAX];
} s;
static uint32_t now;
static bool audio_active, recording, abort_requested, queue_full, recipient_missing;
static int starts, stops, aborts, cancels, confirms, scroll, gesture, reviews, last_cmd;
static char last_recipient[64];
static action_t queued;
static int draft_writes;
static void cable_client_draft(const char *id,const char *op,uint32_t request,uint32_t revision,int delta) {
    (void)id;(void)op;(void)request;(void)revision;(void)delta;draft_writes++;
}
static agent_t *active(void) { return &s.agents[0]; }
#define COPY(dst, src) snprintf(dst, sizeof(dst), "%s", (src) ? (src) : "")
#define ESP_LOGI(...) ((void)0)
uint32_t ms(void) { return now; }
void change(void) {}
void surface_tick(uint32_t value) { (void)value; }
void display_lock(void) {}
void display_unlock(void) {}
void display_bump_activity(void) {}
#ifdef DEVICE_PRO_COMPANION
// Busy observation uses the full model in test_pro_touch_ui; this is the audio boundary.
static void pro_busy_reset(void) {}
static void pro_speech_cancel(bool any) { (void)any; }
static void pro_voice_sample_stop(void) {}
#endif
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
    COPY(last_recipient,id); last_cmd=cmd; starts++; audio_active = recording = true; abort_requested = false;
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
int find(const char *id) { return !recipient_missing && id && !strcmp(id, "agent") ? 0 : -1; }
bool is_question(const char *id) { (void)id; return false; }
void open_question(void) { assert(false); }
bool queue(action_t action) { if (queue_full) return false; queued = action; return true; }
'''
harness += '#ifdef DEVICE_PRO_COMPANION\n'
for name in ('pro_send_feedback_clear','pro_send_feedback_matches','pro_send_feedback_begin','pro_send_feedback_text','pro_work_local','pro_work_available','pro_work_capture_available','pro_work_draft_available'):
    harness += function(name)
harness += '#endif\n'
harness += function('ui_project_set_machine')
harness += function('question_view') + function('copy') + function('input_cancel') + function('view') + function('voice_close') + function('workspace_failed')
harness += r'''
#ifdef DEVICE_PRO_COMPANION
// Notification lifetime is exercised with real callbacks in test_pro_question_lifetime.py.
static void pro_notice_source(const char *host) { (void)host; }
static bool pro_draft_store_queue(bool clear) {
    if(clear){ht_draft_reset(&draft);memset(&s.carry_review,0,sizeof s.carry_review);pro_draft_recovery_close(&s.draft_recovery);view(HOME);}
    else s.draft_recovery.store=PRO_RECOVERY_SAVED;
    return true;
}
#endif
'''
dispatch = source.split('case A_VOICE:\n', 1)[1].split('case A_PET:', 1)[0]
intent = source.split('case A_WORK_INTENT:\n', 1)[1].split('case A_LANGUAGE:', 1)[0]
draft_actions = source.split('case A_DRAFT_EDIT:\n', 1)[1].split('case A_HOME:', 1)[0]
harness += 'static void dispatch(action_t a) { switch (a.kind) {\n#ifdef DEVICE_PRO_COMPANION\ncase A_WORK_INTENT:\n' + intent + '#endif\ncase A_DRAFT_EDIT:\n' + draft_actions + 'case A_VOICE:\n' + dispatch + '} }\n'
worker = source.split('static void worker(', 1)[1].split('case A_VOICE:\n', 1)[1].split('case A_STOP_YES:', 1)[0]
draft_worker = source.split('static void worker(', 1)[1].split('case A_DRAFT_COMMAND:', 1)[1].split('case A_CARRY_SEND:', 1)[0]
harness += 'static void work(action_t a) { switch (a.kind) { case A_VOICE:\n' + worker + 'case A_DRAFT_COMMAND:' + draft_worker + '} }\n'
for name in ['habitat_tick', 'ui_set_connected', 'ui_show_error', 'ui_cable_toast',
             'ui_voice_error', 'ui_voice_routed', 'ui_voice_route_abort', 'ui_voice_start']:
    harness += function(name)
harness += r'''
static void reset(void) {
    memset(&workspace,0,sizeof workspace);
    memset(&tab_carousel,0,sizeof tab_carousel);
    host_features=31; memset(&draft,0,sizeof draft); reviews=0; memset(&s, 0, sizeof(s)); memset(&visit, 0, sizeof(visit)); memset(&carry,0,sizeof(carry)); now = 1000;
    s.ready = s.connected = true; s.view = HOME;
    strcpy(s.agents[0].name, "Agent");
    strcpy(s.agents[0].id,"agent"); strcpy(s.agents[0].engine,"claude");
    audio_active = recording = abort_requested = queue_full = false;
    recipient_missing=false;ui_project_set_machine("agent","local-host","Cable host");pro_draft_recovery_source(&s.draft_recovery,"local-host"); last_cmd=-1; last_recipient[0]=0;
    starts = stops = aborts = cancels = confirms = 0;
}
static void speak(void) { dispatch((action_t){.kind = A_VOICE, .id = "agent"}); }
static void done(void) { dispatch((action_t){.kind = A_VOICE_STOP}); }
static void discard(void) { dispatch((action_t){.kind = A_VOICE_ABORT}); }
static void finish_audio(void) { audio_active = recording = false; }
static void begin(void) { speak(); work(queued); assert(recording && s.view == VOICE); }
#ifdef DEVICE_PRO_COMPANION
static action_t instruction_action(int kind, int mode) {
    action_t a={.kind=kind,.value=mode,.revision=s.work_revision}; COPY(a.id,s.work_agent); return a;
}
static void choose_instruction(int mode) {
    dispatch((action_t){.kind=A_WORK_INTENT});
    assert(s.view==WORK_INTENT && s.work_mode==PRO_WORK_TASK && !starts && !s.voice_open);
    dispatch(instruction_action(A_WORK_MODE,mode));
}
static int draft_sends;
static bool draft_command(const ht_draft_command_t *command, void *ctx) {
    (void)ctx; if(command->op==HT_DRAFT_SEND) draft_sends++; return true;
}
static void test_pro_instructions(void) {
    reset(); begin(); assert(last_cmd==VOICE_CMD_NONE && !reviews && !s.voice_review);
    for(int mode=PRO_WORK_GOAL;mode<=PRO_WORK_LOOP;mode++) {
        reset(); choose_instruction(mode); assert(s.work_mode==mode && !starts);
        dispatch(instruction_action(A_WORK_RECORD,0));
        assert(s.voice_start_pending && s.voice_review && s.work_voice_mode==mode && !starts);
        work(queued); assert(recording && !strcmp(last_recipient,"agent"));
        assert(last_cmd==(mode==PRO_WORK_GOAL?VOICE_CMD_GOAL:VOICE_CMD_LOOP) && reviews==1);
        assert(s.voice_return==WORK_INTENT); done(); finish_audio();
        ui_voice_routed(true,false,"","agent","Agent",1);
        assert(s.voice_open && s.voice_waiting); // Only a draft reply can release required review.
        discard(); assert(!s.voice_open);
    }
    const char *engines[]={"claude","codex","opencode","","CLAUDE","claude-extra"};
    for(unsigned i=0;i<sizeof engines/sizeof engines[0];i++) for(int review=0;review<2;review++) {
        for(int mode=PRO_WORK_GOAL;mode<=PRO_WORK_LOOP;mode++) {
            reset(); COPY(s.agents[0].engine,engines[i]); host_features=review?CABLE_FEATURE_DRAFT:0;
            choose_instruction(mode);
            bool allowed=review && (mode==PRO_WORK_GOAL?i<2:i==0);
            assert(s.work_mode==(allowed?mode:PRO_WORK_TASK));
            dispatch((action_t){.kind=A_VOICE,.value=pro_work_voice_value(mode),.id="agent"});
            assert(s.voice_open==allowed);
            if(allowed) { work(queued); assert(starts==1 && reviews==1); }
            else assert(!starts);
        }
    }
    reset(); choose_instruction(PRO_WORK_GOAL);
    action_t stale=instruction_action(A_WORK_RECORD,0); stale.revision--;
    dispatch(stale); assert(!s.voice_open); stale=instruction_action(A_WORK_RECORD,0);
    COPY(stale.id,"other-pane"); dispatch(stale); assert(!s.voice_open);
    stale=instruction_action(A_WORK_MODE,PRO_WORK_LOOP); stale.revision--;
    dispatch(stale); assert(s.work_mode==PRO_WORK_GOAL);
    reset(); choose_instruction(PRO_WORK_GOAL); queue_full=true;
    dispatch(instruction_action(A_WORK_RECORD,0)); assert(!s.voice_open && !starts);
    for(int invalidation=0;invalidation<3;invalidation++) {
        reset(); choose_instruction(PRO_WORK_LOOP); dispatch(instruction_action(A_WORK_RECORD,0));
        action_t delayed=queued;
        if(invalidation==0) COPY(s.agents[0].engine,"codex");
        else if(invalidation==1) recipient_missing=true;
        else host_features=0;
        work(delayed); assert(!starts && !s.voice_open && s.view==MESSAGE && s.message[0]);
    }
    reset(); choose_instruction(PRO_WORK_LOOP); dispatch(instruction_action(A_WORK_RECORD,0));
    action_t delayed=queued; discard(); work(delayed); assert(!starts && !s.voice_open);
    reset(); choose_instruction(PRO_WORK_GOAL); dispatch(instruction_action(A_WORK_RECORD,0));
    work(queued); now=601000; habitat_tick(); assert(stops==1 && s.voice_waiting && reviews==1 && s.voice_review);
    for(int invalidation=0;invalidation<5;invalidation++) {
        reset(); s.work_voice_mode=PRO_WORK_LOOP; COPY(s.work_agent,"agent"); s.view=DRAFT; draft_sends=0;
        pro_draft_recovery_pin(&s.draft_recovery,"agent",PRO_WORK_LOOP);
        ht_draft_page_t page={.active=true,.can_send=true,.revision=3,.agent="agent",.id="draft-test"};
        ht_draft_open(&draft,&page,draft_command,NULL);
        if(invalidation==1) COPY(s.agents[0].engine,"codex");
        else if(invalidation==2) recipient_missing=true;
        else if(invalidation==3) host_features=0;
        else if(invalidation==4) COPY(s.work_agent,"different-pane");
        dispatch((action_t){.kind=A_DRAFT_SEND,.revision=3,.text="draft-test"});
        assert(draft_sends==(invalidation==0));
        if(invalidation) assert(draft.page.error[0] && !draft.pending);
    }
    reset(); s.work_voice_mode=PRO_WORK_LOOP; COPY(s.work_agent,"agent"); s.view=DRAFT;
    draft.page=(ht_draft_page_t){.active=true,.revision=3,.id="draft-test",.agent="agent"};
    dispatch((action_t){.kind=A_DRAFT_APPEND,.revision=3,.dy=3,.text="draft-test"});
    work(queued); assert(recording && s.work_voice_mode==PRO_WORK_LOOP && s.voice_review);

    for(int mode=PRO_WORK_GOAL;mode<=PRO_WORK_LOOP;mode++)for(int invalidation=0;invalidation<9;invalidation++) {
        reset();choose_instruction(mode);action_t instruction=instruction_action(A_WORK_RECORD,0);
        if(invalidation==0)ui_project_set_machine("agent","remote","Remote");
        else if(invalidation==1)ui_project_set_machine("agent",NULL,"Unknown");
        else if(invalidation==2) {char long_id[49];memset(long_id,'h',48);long_id[48]=0;ui_project_set_machine("agent",long_id,"Invalid");}
        else if(invalidation==3)pro_draft_recovery_source(&s.draft_recovery,NULL);
        else if(invalidation==4) {pro_draft_recovery_source(&s.draft_recovery,"new-host");ui_project_set_machine("agent","new-host","New host");}
        else if(invalidation==5)s.loading=true;
        else if(invalidation==6)recipient_missing=true;
        else if(invalidation==7)ui_set_connected(false);
        else {ui_set_connected(false);ui_set_connected(true);pro_draft_recovery_source(&s.draft_recovery,"local-host");}
        dispatch(instruction);assert(!s.voice_open&&!starts);
        dispatch((action_t){.kind=A_VOICE,.value=pro_work_voice_value(mode),.id="agent"});
        // A fresh direct request to a known new local host is allowed; the old sheet is not.
        assert(s.voice_open==(invalidation==4||invalidation==8));if(s.voice_open) {work(queued);assert(starts==1);}
        else assert(!starts);
    }
    for(int mode=PRO_WORK_GOAL;mode<=PRO_WORK_LOOP;mode++)for(int invalidation=0;invalidation<7;invalidation++) {
        reset();choose_instruction(mode);dispatch(instruction_action(A_WORK_RECORD,0));action_t queued_start=queued;
        if(invalidation==0)ui_project_set_machine("agent","remote","Remote");
        else if(invalidation==1)ui_project_set_machine("agent","","Unknown");
        else if(invalidation==2)pro_draft_recovery_source(&s.draft_recovery,"new-host");
        else if(invalidation==3)s.draft_recovery.generation++;
        else if(invalidation==4)COPY(s.draft_recovery.recipient,"other");
        else if(invalidation==5)s.draft_recovery.mode=PRO_WORK_TASK;
        else {ui_set_connected(false);ui_set_connected(true);}
        work(queued_start);assert(!starts&&!s.voice_open);
    }
    for(int mode=PRO_WORK_GOAL;mode<=PRO_WORK_LOOP;mode++)for(int invalidation=0;invalidation<7;invalidation++) {
        reset();s.work_voice_mode=mode;COPY(s.work_agent,"agent");s.view=DRAFT;draft_sends=0;
        pro_draft_recovery_pin(&s.draft_recovery,"agent",(uint8_t)mode);
        ht_draft_page_t page={.active=true,.can_send=true,.revision=3,.agent="agent",.id="draft-test",.text="Keep these exact words."};
        ht_draft_open(&draft,&page,draft_command,NULL);
        if(invalidation==0)ui_project_set_machine("agent","remote","Remote");
        else if(invalidation==1)ui_project_set_machine("agent",NULL,"Unknown");
        else if(invalidation==2)pro_draft_recovery_source(&s.draft_recovery,"different-host");
        else if(invalidation==3)s.draft_recovery.generation++;
        else if(invalidation==4)COPY(s.draft_recovery.recipient,"other");
        else if(invalidation==5)s.draft_recovery.mode=PRO_WORK_TASK;
        else s.connected=false;
        dispatch((action_t){.kind=A_DRAFT_SEND,.revision=3,.text="draft-test"});
        assert(!draft_sends&&!draft.pending&&draft.page.active&&!strcmp(draft.page.text,"Keep these exact words."));
        // Revalidate a queued request after the same changes, without a send or timeout claim.
        draft.pending=true;draft.request=8;draft.op=HT_DRAFT_SEND;draft_writes=0;
        work((action_t){.kind=A_DRAFT_COMMAND,.id="draft-test",.value=HT_DRAFT_SEND,.revision=8,.dy=3});
        assert(!draft_writes&&draft.page.active);
        if(invalidation!=6)assert(!draft.pending&&!draft.failed&&draft.page.error[0]);
    }
    reset();ui_project_set_machine("agent","remote","Remote");begin();assert(starts==1&&last_cmd==VOICE_CMD_NONE);

    puts("Pro instructions: PASS (engine/host gates, pinned recipient/revision, explicit review, queued invalidation, cancellation and duration cap)");
}
static void carry_setup(void) {
    reset(); carry.active=true; carry.rows=3; carry.deadline=now+300000;
    COPY(carry.id,"carry-test"); COPY(carry.source,"Research"); COPY(carry.excerpt,"Keep the original API.");
}
static void carry_start(void) {
    dispatch((action_t){.kind=A_VOICE,.value=3,.id="agent",.text="carry-test"});
}
static void carry_review_fixture(void) {
    carry_setup(); carry_start(); work(queued); done(); finish_audio();
    draft.page=(ht_draft_page_t){.active=true,.can_send=true,.revision=3,.id="draft-test",.agent="agent",.text="Use this guidance."};
    COPY(s.carry_review.draft,"draft-test"); voice_close(); view(DRAFT);
    draft.emit=draft_command;
}
static void test_pro_carry_review(void) {
    carry_setup();ui_voice_start();work(queued);
    assert(recording&&s.voice_carry&&s.voice_review&&reviews==1&&!strcmp(last_recipient,"agent"));
    carry_setup();host_features=0;carry_start();assert(!s.voice_open&&!starts);
    for(int invalid=0;invalid<5;invalid++) {
        carry_setup();carry_start();action_t start=queued;
        assert(s.voice_review&&!strcmp(s.carry_review.agent,"agent")&&!strcmp(s.carry_review.source,"Research"));
        if(invalid==0)host_features=0;
        if(invalid==1)recipient_missing=true;
        if(invalid==2)now=carry.deadline;
        if(invalid==3)COPY(carry.id,"new-tray");
        if(invalid==4)carry.active=false;
        work(start);assert(!starts&&!s.voice_open&&!s.carry_review.id[0]);
    }
    carry_setup();speak();assert(!starts&&!s.voice_open);
    carry_start();work(queued);assert(reviews==1&&recording&&s.voice_review);
    COPY(carry.source,"Changed tray");COPY(carry.excerpt,"Different text.");
    assert(!strcmp(s.carry_review.source,"Research")&&!strcmp(s.carry_review.excerpt,"Keep the original API."));
    now=s.voice_started+600001;habitat_tick();assert(s.voice_waiting&&s.voice_review&&stops==1);
    finish_audio();ui_voice_routed(true,false,"","agent","Agent",1);
    assert(s.voice_open&&s.voice_review&&carry.active);

    carry_review_fixture();now=carry.deadline+1;habitat_tick();assert(carry.active&&!carry.error[0]);
    view(HOME);assert(s.view==DRAFT);
    s.offset=3;
    action_t preview={.kind=A_CARRY_PREVIEW,.revision=3,.text="draft-test"};
    dispatch(preview);assert(s.view==CARRY_PREVIEW);
    dispatch((action_t){.kind=A_DRAFT_BACK,.revision=3,.text="draft-test"});assert(s.view==DRAFT&&s.offset==3);
    recipient_missing=true;draft_sends=0;
    dispatch((action_t){.kind=A_DRAFT_SEND,.revision=3,.text="draft-test"});
    assert(!draft_sends&&!draft.pending&&draft.page.error[0]);
    recipient_missing=false;
    COPY(draft.page.name,"Renamed by the host");
    dispatch((action_t){.kind=A_DRAFT_APPEND,.revision=3,.dy=3,.text="draft-test"});
    work(queued);assert(recording&&s.voice_review&&!strcmp(s.voice_target,"Agent"));
    ui_set_connected(false);assert(!s.voice_open&&s.view==DRAFT&&draft.page.active&&s.carry_review.detached);
    assert(!strcmp(draft.page.text,"Use this guidance.")&&!strcmp(s.carry_review.excerpt,"Keep the original API."));
    ui_set_connected(true);dispatch((action_t){.kind=A_DRAFT_SEND,.revision=3,.text="draft-test"});
    assert(!draft_sends&&!draft.pending);
    preview.velocity=(int)s.draft_recovery.generation;
    dispatch(preview);assert(s.view==CARRY_PREVIEW);
    dispatch((action_t){.kind=A_DRAFT_DISCARD,.revision=3,.velocity=(int)s.draft_recovery.generation,.text="draft-test"});
    assert(!draft.page.active&&!s.carry_review.id[0]&&s.view==HOME);

    carry_review_fixture();COPY(carry.id,"newer-tray");now=carry.deadline+1;habitat_tick();
    assert(!carry.active&&carry.error[0]&&pro_carry_review_owns(&s.carry_review,&draft.page));
    assert(!strcmp(s.carry_review.excerpt,"Keep the original API."));

    for(int stale=0;stale<5;stale++) {
        carry_review_fixture();draft_writes=0;
        assert(ht_draft_command(&draft,HT_DRAFT_SEND,3,0,now));
        action_t send={.kind=A_DRAFT_COMMAND,.value=HT_DRAFT_SEND,.revision=draft.request,.dy=3,.id="draft-test"};
        if(stale==1)ui_set_connected(false);
        if(stale==2)draft.pending=false;
        if(stale==3)send.revision++;
        if(stale==4)COPY(send.id,"other-draft");
        work(send);assert(draft_writes==(stale==0));
    }
    puts("Pro Carry: PASS (mandatory review, host/recipient/expiry gates, frozen preview, attached lifetime, disclosure, disconnect retention and queued-send invalidation)");
}
#endif
int main(void) {
#ifdef DEVICE_PRO_COMPANION
    assert(!pro_send_feedback_text(now));
    test_pro_instructions();
    test_pro_carry_review();
#endif
    reset(); host_features=0; begin(); dispatch((action_t){.kind=A_VOICE_STOP,.value=1});
    assert(!reviews && !s.voice_review && s.voice_waiting);
    reset(); begin(); dispatch((action_t){.kind=A_VOICE_STOP,.value=1});
    assert(reviews==1 && s.voice_review && s.voice_waiting);
    finish_audio(); ui_voice_routed(true,false,"","agent","Agent",1);
    assert(s.voice_open && s.voice_waiting); // Normal route receipt cannot bypass review.
    discard(); assert(!s.voice_open && !s.voice_review);
    reset(); s.view=DRAFT; draft.page=(ht_draft_page_t){.active=true,.revision=3,.id="draft-test",.name="Original"};
    view(HOME); assert(s.view==DRAFT);
    action_t edit={.kind=A_VOICE,.value=5,.revision=2,.dy=2,.text="draft-test"};
    dispatch(edit); assert(!s.voice_open);
    edit.revision=edit.dy=3; dispatch(edit); work(queued);
    assert(starts==1 && s.voice_return==DRAFT && s.voice_review && !strcmp(s.voice_target,"Original"));
    done(); finish_audio(); ui_voice_error("Couldn't hear it");
    assert(s.view==DRAFT && draft.failed && draft.page.error[0]);
    draft.failed=false; dispatch(edit); work(queued); discard(); finish_audio();
    assert(s.view==DRAFT && draft.page.active && !s.voice_open);
    ui_set_connected(false);
#ifdef DEVICE_PRO_COMPANION
    assert(s.view==DRAFT && draft.page.active && draft.read_only);
#else
    assert(s.view==HOME && !draft.page.active);
#endif

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
#ifdef DEVICE_PRO_COMPANION
    assert(carry.active && s.voice_carry && s.voice_open && s.voice_review && reviews==1);
#else
    assert(!carry.active && !s.voice_carry && !s.voice_open);
#endif
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
                    *(['-DDEVICE_PRO_COMPANION=1'] if '--pro' in sys.argv else []),
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(native), str(root / 'voice_ui.c'), str(native / 'selection.c'), str(native / 'carry.c'), str(native / 'visit.c'), str(native / 'form.c'), str(native / 'draft.c'), str(native / 'workspace.c'),
                    '-o', str(root / 'voice_ui')], check=True)
    subprocess.run([str(root / 'voice_ui')], check=True)
