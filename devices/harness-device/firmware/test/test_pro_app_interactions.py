"""Native Pro question and app-visit replays, with the real state and handlers.

The queue/USB/audio boundary is deterministic. Production dispatch branches,
recipient capture, callbacks, visit state machine, fonts and sheet rasterizers
run unchanged. This proves local behavior, not physical touch or host bookmarks.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

from native_shapes import defines, typedef

HERE = Path(__file__).resolve().parent
NATIVE = (HERE / "../main/ui/habitat").resolve()
SOURCE = (NATIVE / "ui_habitat.c").read_text()
SHEETS = (NATIVE / "pro_controls.inc").read_text()
HOME = (NATIVE / "pro_home.inc").read_text()
FONTS = HERE / "../../prototype/pro-companion/generated/pro_fonts.c"


def function(name, source=SOURCE):
    match = re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{.*?^\}", source, re.M | re.S)
    assert match, name
    return match.group(0) + "\n"


def cases(first, after, source=SOURCE, indent="    "):
    return indent + "case " + first + ":" + source.split(indent + "case " + first + ":", 1)[1].split(indent + "case " + after + ":", 1)[0]


code = r'''
#include "runtime.h"
#include "pro_canvas.h"
#include "pro_metrics.h"
#include "pro_visual.h"
#include "pro_work_intent.h"
#include "workspace.h"
#include "selection.h"
#include "carry.h"
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "character.h"
#include "gestures.h"
#include "../../cable_features.h"
#include "../../cable_machines.h"
#include "theme.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define ESP_LOGI(...) ((void)0)
#define COPY(dst,src) copy(dst,sizeof(dst),src)
'''
code += defines("CABLE_READ_TOKEN_MAX", "ID_MAX", "CABLE_NAME_MAX", "SWARM_ID_MAX", "SWARMS_MAX",
                "SWARM_TILES_MAX", "CABLE_MAX_AGENTS", "MAX_PROJECTS")
code += defines("NOTICES", "QUESTION_MAX", "OPTION_MAX", "PANE_MEMORY_MAX", "PANE_RESULT_BYTES", "UI_FONT", "Q_ROWS", source=SOURCE)
for name in ("cable_swarm_t", "cable_notif_t", "cable_tile_t", "model_item_t"):
    code += typedef(name)
code += SOURCE[SOURCE.index("typedef enum {"):SOURCE.index("static QueueHandle_t actions;")]
code += function("copy")
code += r'''
typedef struct cJSON { const char *string,*valuestring; int type; double valuedouble; struct cJSON *child,*next; } cJSON;
enum { JSTRING=1,JTRUE=2,JARRAY=3,JOBJECT=4,JNUMBER=5 };
static bool cJSON_IsString(const cJSON *v) { return v && v->type==JSTRING; }
static bool cJSON_IsNumber(const cJSON *v) { return v && v->type==JNUMBER; }
static bool cJSON_IsTrue(const cJSON *v) { return v && v->type==JTRUE; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *key) {
    for(const cJSON *p=v?v->child:NULL;p;p=p->next)if(p->string&&!strcmp(p->string,key))return p;
    return NULL;
}
static const cJSON *cJSON_GetArrayItem(const cJSON *v,int index) {
    const cJSON *p=v?v->child:NULL;while(p&&index--)p=p->next;return p;
}
#define cJSON_ArrayForEach(it,v) for((it)=(v)?(v)->child:NULL;(it);(it)=(it)->next)
static cJSON object(cJSON *children,int n) {
    for(int i=0;i<n;i++)children[i].next=i+1<n?&children[i+1]:NULL;
    return (cJSON){.type=JOBJECT,.child=n?children:NULL};
}
static ht_workspace_t workspace;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static ht_gesture_t gesture;
static question_submit_t packet;
static uint32_t now=100,random_value=1,features=~0u;
static bool congested,transport_ok=true;
static unsigned enqueued,answers,reads,opens,voice_commands,removed;
static action_t sent,transport;
static uint32_t ms(void) { return now; }
static uint32_t esp_random(void) { return random_value++; }
static bool cable_client_supports(uint32_t mask) { return (features&mask)==mask; }
static agent_t *active(void) { return s.active>=0&&s.active<s.count?&s.agents[s.active]:NULL; }
static int find(const char *id) { for(int i=0;i<s.count;i++)if(!strcmp(id,s.agents[i].id))return i;return -1; }
static void change(void) {}
static void display_lock(void) {}
static void display_unlock(void) {}
static void input_cancel(void) { s.pressed=-1; }
static void view(view_t v) { input_cancel();s.view=v;s.offset=0; }
static void voice_close(void) { s.voice_open=s.voice_waiting=s.voice_start_pending=false; }
static bool audio_client_active(void) { return false; }
static void audio_client_abort(void) {}
static void pro_speech_cancel(bool cancel) { (void)cancel; }
static bool queue(action_t a) {
    if(congested)return false;
    sent=a;enqueued++;if(a.kind==A_DESKTOP)opens++;if(a.kind==A_VOICE)voice_commands++;
    return true;
}
static int actions=1;
#define pdPASS 1
static unsigned uxQueueSpacesAvailable(int q) { (void)q;return congested?0:20; }
static int xQueueSend(int q,const action_t *a,int wait) { (void)q;(void)wait;return queue(*a); }
static bool notice_was_read(const cable_notif_t *n) { return n->read_on_dial; }
static void notice_forget_read(const char *id) { (void)id; }
static void notice_add(const char *id,const char *name,const char *machine,const char *text,bool question,bool failed) {
    int i=0;for(;i<s.notice_count;i++)if(!strcmp(id,s.notice[i].agent_id))break;
    assert(i<NOTICES);if(i==s.notice_count)s.notice_count++;
    cable_notif_t *n=&s.notice[i];COPY(n->agent_id,id);COPY(n->name,name);COPY(n->machine,machine);COPY(n->summary,text);
    n->question=question;n->failed=failed;n->display_revision=++s.notice_revision;
}
static void notice_remove(const char *id,bool all) {
    assert(all);removed++;
    for(int i=s.notice_count-1;i>=0;i--)if(!strcmp(id,s.notice[i].agent_id)) {
        memmove(&s.notice[i],&s.notice[i+1],(size_t)(s.notice_count-i-1)*sizeof s.notice[0]);s.notice_count--;
    }
}
static void cable_client_question_read(const char *id,const char *fetch) {
    reads++;transport=(action_t){.kind=A_QUESTION_READ};COPY(transport.id,id);COPY(transport.text,fetch);
}
static bool cable_client_answer_reviewed(const char *id,const char *fetch,const char *token,const uint8_t *choices,const char drafts[][48],int n) {
    assert(fetch[0]&&token[0]&&n>0&&n<=QUESTION_MAX);assert(choices[0]||drafts[0][0]);
    answers++;transport=(action_t){.kind=A_ANSWER};COPY(transport.id,id);COPY(transport.text,token);return transport_ok;
}
static unsigned selections;
static void cable_client_select_text(const char *agent,const char *id,uint32_t request,uint32_t revision,
                                     const char *op,int delta,bool extend) {
    assert(!strcmp(op,"begin")||!strcmp(op,"cancel"));(void)delta;(void)extend;
    selections++;transport=(action_t){.kind=A_SELECT_SEND,.revision=revision,.velocity=(int)request};
    COPY(transport.id,agent);COPY(transport.text,id);
}
static uint16_t color(unsigned rgb) { return ht_rgb(rgb); }
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define SEL color(HT_THEME_SELECTION)
static void dispatch(action_t a);
'''
for name in ("pro_send_feedback_clear", "pro_work_local", "pro_work_available", "pro_busy_reset", "question_view", "waiting", "notice_flush_reads", "notice_mark_read", "notice_open", "notice_sync_view", "notice_selection", "notice_restore_selection", "ui_notif_replace",
             "visit_emit", "selection_emit", "carry_emit", "make_action", "read_question", "open_question",
             "pro_open_in_app", "question_answer", "question_rows", "question_move", "send_answer", "question_load", "ui_question_show",
             "ui_question_state", "ui_answer_receipt", "ui_question_close", "ui_set_connected",
             "ui_focus_project", "ui_visit_state", "ui_voice_question"):
    code += function(name)
code += "static void dispatch(action_t a) { if(s.locked)return;switch(a.kind) {\n"
code += cases("A_READER", "A_TABS")
code += cases("A_DESKTOP", "A_UP")
code += cases("A_VOICE", "A_VOICE_STOP")
code += cases("A_SELECT_BEGIN", "A_COMPANION")
code += "default:break;} }\n"
worker = SOURCE.split("static void worker(", 1)[1]
code += "static void work(action_t a) { switch(a.kind) {\n"
code += cases("A_SELECT_SEND", "A_SCROLL", worker, "        ")
code += "        case A_QUESTION_READ:" + worker.split("        case A_QUESTION_READ:", 1)[1].split("        default:", 1)[0]
code += "default:break;} }\n"
for name in ("pro_hit", "pro_control", "pro_heading", "pro_note", "pro_read_text", "pro_inbox", "pro_reader", "pro_selection", "pro_unknown_answer", "pro_question", "pro_answer"):
    code += function(name, SHEETS)
code += function("pro_home_header", HOME)
code += r'''
static void reset(void) {
    memset(&s,0,sizeof s);memset(&visit,0,sizeof visit);memset(&form,0,sizeof form);memset(&draft,0,sizeof draft);
    memset(&selection,0,sizeof selection);memset(&carry,0,sizeof carry);memset(&workspace,0,sizeof workspace);
    enqueued=answers=reads=opens=voice_commands=removed=selections=0;features=~0u;congested=false;transport_ok=true;
    s.connected=s.ready=true;s.active=0;s.count=2;s.pressed=-1;
    COPY(s.agents[0].id,"design");COPY(s.agents[0].name,"Design");COPY(s.agents[0].full,"The design is ready to review.");
    COPY(s.agents[1].id,"build");COPY(s.agents[1].name,"Build");COPY(s.agents[1].full,"The build passed its checks.");
    notice_add("remote","Research","Other workspace","Which option should we use?",true,false);
    s.view=INBOX;
}
static hit_t hit(action_kind_t kind,int value) { return (hit_t){.action=kind,.value=value,.enabled=true}; }
static void act(action_kind_t kind,int value) { dispatch(make_action(hit(kind,value))); }
static bool overlap(ht_rect_t a,ht_rect_t b) {
    return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
}
static void render(ht_scene_t *f) {
    s.hit_count=0;ht_scene_clear(f,BG);
    if(s.view==HOME)pro_home_header(f);else if(s.view==INBOX)pro_inbox(f);else if(s.view==READER)pro_reader(f);
    else if(s.view==SELECTION)pro_selection(f);
    else if(s.view==ANSWER_REVIEW)pro_answer(f);else {assert(s.view==QUESTION);pro_question(f);}
    assert(f->count<HT_RUNS);
    for(int i=0;i<f->count;i++) {
        ht_rect_t r=ht_run_bounds(&f->runs[i]);assert(r.x>=0&&r.y>=0&&r.x+r.w<=720&&r.y+r.h<=720);
        if(f->runs[i].pro_kind!=1||!f->runs[i].text[0])continue;
        for(int j=i+1;j<f->count;j++)if(f->runs[j].pro_kind==1&&f->runs[j].text[0])
            assert(!overlap(r,ht_run_bounds(&f->runs[j])));
    }
    for(int i=0;i<s.hit_count;i++) {
        ht_rect_t r=s.hits[i].rect;assert(r.w>=64&&r.h>=64&&r.x>=0&&r.y>=0&&r.x+r.w<=720&&r.y+r.h<=720);
        for(int j=i+1;j<s.hit_count;j++)assert(!overlap(r,s.hits[j].rect));
    }
}
static unsigned controls(action_kind_t kind) {
    unsigned n=0;for(int i=0;i<s.hit_count;i++)if(s.hits[i].action==kind&&s.hits[i].enabled)n++;return n;
}
static bool text_has(const ht_scene_t *f,const char *text) {
    for(int i=0;i<f->count;i++)if(f->runs[i].pro_kind==1&&strstr(f->runs[i].text,text))return true;return false;
}
static void portrait(const ht_scene_t *f,const char *dir,const char *name) {
    if(!dir)return;static uint16_t pixels[720*720];ht_raster(f,(ht_rect_t){0,0,720,720},pixels);
    char path[1024];snprintf(path,sizeof path,"%s/%s.ppm",dir,name);FILE *out=fopen(path,"wb");assert(out);
    fprintf(out,"P6\n720 720\n255\n");
    for(size_t i=0;i<720*720;i++) {unsigned p=pixels[i];unsigned char rgb[]={(p>>11)*255/31,((p>>5)&63)*255/63,(p&31)*255/31};fwrite(rgb,1,3,out);}
    fclose(out);
}
static void question_state_reply(bool supported,bool submitted,const char *id,const char *token) {
    cJSON options[]={{.type=JSTRING,.valuestring="This file only"},{.type=JSTRING,.valuestring="The whole project"}};
    cJSON array=object(options,2);
    cJSON fields[]={{.string="key",.type=JSTRING,.valuestring="scope"},
        {.string="q",.type=JSTRING,.valuestring="Which scope should we use?"},
        {.string="options",.type=JARRAY,.child=supported?array.child:NULL},
        {.string="canText",.type=JTRUE}};
    cJSON question=object(fields,4);
    cJSON reply[]={{.string="agentId",.type=JSTRING,.valuestring=s.q.agent},
        {.string="requestId",.type=JSTRING,.valuestring=s.q.fetch},
        {.string="id",.type=JSTRING,.valuestring=id},
        {.string="token",.type=JSTRING,.valuestring=token},
        {.string="name",.type=JSTRING,.valuestring="Research"},
        {.string="ok",.type=JTRUE},{.string="questions",.type=JARRAY,.child=&question},
        {.string="submitted",.type=submitted?JTRUE:0}};
    cJSON root=object(reply,8);ui_question_state(&root);
}
static void question_state(bool supported) { question_state_reply(supported,false,"question-remote","token-remote"); }
static void voice_reply(const char *token) {
    cJSON reply[]={{.string="agentId",.type=JSTRING,.valuestring="remote"},
        {.string="token",.type=JSTRING,.valuestring=token},{.string="questionIndex",.type=JNUMBER,.valuedouble=0},
        {.string="draftId",.type=JSTRING,.valuestring="spoken-answer"},
        {.string="text",.type=JSTRING,.valuestring="Only change the selected file."}};
    cJSON root=object(reply,5);ui_voice_question(&root);
}
static void receipt_frame(const char *agent,const char *fetch,const char *token,bool ok,bool pending) {
    cJSON reply[]={{.string="agentId",.type=JSTRING,.valuestring=agent},
        {.string="requestId",.type=JSTRING,.valuestring=fetch},
        {.string="token",.type=JSTRING,.valuestring=token},{.string="ok",.type=ok?JTRUE:0},
        {.string="error",.type=JSTRING,.valuestring="Could not confirm. Check the terminal."},
        {.string="pending",.type=pending?JTRUE:0}};
    cJSON root=object(reply,6);ui_answer_receipt(&root);
}
static void receipt(const char *token,bool ok) { receipt_frame("remote",s.q.fetch,token,ok,false); }
static void visit_reply(const char *agent,bool ok,bool available,const char *note) {
    char request[48],id[48];snprintf(request,sizeof request,"visit-%lu",(unsigned long)visit.request);COPY(id,visit.id);
    cJSON reply[]={{.string="requestId",.type=JSTRING,.valuestring=request},
        {.string="visitId",.type=JSTRING,.valuestring=id},{.string="agentId",.type=JSTRING,.valuestring=agent},
        {.string="ok",.type=ok?JTRUE:0},{.string="active",.type=available?JTRUE:0},
        {.string="label",.type=JSTRING,.valuestring="Build / reading line 42"},
        {.string="error",.type=JSTRING,.valuestring="The original pane was closed."},
        {.string="note",.type=JSTRING,.valuestring=note?note:""}};
    cJSON root=object(reply,8);ui_visit_state(&root);
}
static action_t submit_choice(void) {
    reset();act(A_QUESTION,0);question_state(true);act(A_QUESTION_CHOICES,0);
    act(A_CHOICE,0);act(A_QUESTION_REVIEW,0);act(A_ANSWER,0);
    assert(s.q.pending&&!s.q.uncertain&&s.view==ANSWER_REVIEW);
    return sent;
}
static void unknown_answer_recovery(const char *dir) {
    ht_scene_t scene;
    // Pending remains protected until a timeout, rejection or disconnect marks
    // delivery uncertain. A pending receipt is not a completed acknowledgement.
    action_t submit=submit_choice();unsigned queued=enqueued;
    action_t close=make_action(hit(A_QUESTION_CLOSE,0));dispatch(close);
    receipt_frame("remote",s.q.fetch,"token-remote",true,true);
    assert(s.q.pending&&!s.q.uncertain&&enqueued==queued);render(&scene);
    assert(!controls(A_QUESTION_CLOSE)&&!controls(A_ANSWER));
    work(submit);assert(answers==1);
    char old_fetch[48];COPY(old_fetch,s.q.fetch);

    // Actual path: submit, disconnect, missed offline close, reconnect, empty
    // notification replacement. Menu/Updates must expose the retained record.
    ui_set_connected(false);view(LAUNCHER);act(A_INBOX,0);
    ui_set_connected(true);ui_notif_replace(NULL,0);
    assert(s.view==INBOX&&s.q.pending&&s.q.uncertain&&!s.notice_count);
    render(&scene);portrait(&scene,dir,"unknown-updates-empty");
    act(A_QUESTION,-1);assert(s.view==QUESTION);render(&scene);
    assert(controls(A_QUESTION_CLOSE)&&controls(A_DESKTOP));portrait(&scene,dir,"unknown-online");
    queued=enqueued;unsigned prior_removed=removed;
    COPY(s.pending_focus,"build");close=make_action(hit(A_QUESTION_CLOSE,0));
    uint32_t revision=s.q.revision;dispatch(close);work(submit);
    assert(!s.q.pending&&!s.q.agent[0]&&s.q.revision==revision+1&&s.view==INBOX);
    assert(answers==1&&enqueued==queued&&removed==prior_removed&&!strcmp(s.pending_focus,"build"));
    render(&scene);assert(text_has(&scene,"All caught up"));portrait(&scene,dir,"unknown-closed");

    // A different agent is now reachable. A late old receipt and a stale Close
    // cannot settle or erase this new question or its notification/read token.
    cable_notif_t next={.question=true};COPY(next.agent_id,"another");COPY(next.name,"Other");
    COPY(next.summary,"Which project?");COPY(next.read_token,"read-another");ui_notif_replace(&next,1);
    act(A_QUESTION,0);assert(s.q.loading&&!strcmp(s.q.agent,"another"));
    question_state_reply(true,false,"question-another","token-another");
    revision=s.q.revision;queued=enqueued;
    receipt_frame("remote",old_fetch,"token-remote",true,false);dispatch(close);
    assert(s.q.valid&&!s.q.pending&&s.q.revision==revision&&!strcmp(s.q.token,"token-another"));
    assert(s.notice_count==1&&!strcmp(s.notice[0].read_token,"read-another")&&enqueued==queued);

    // Closing a retained record does not remove/read-ack its remaining host
    // notification. A queued, never-written old answer is invalidated locally.
    submit=submit_choice();ui_set_connected(false);queued=enqueued;prior_removed=removed;
    COPY(s.notice[0].read_token,"still-unread");
    COPY(s.notice_reads[0].id,"elsewhere");COPY(s.notice_reads[0].token,"pending-read");s.notice_reads[0].pending=true;
    cable_notif_t original=s.notice[0];notice_receipt_t read_record=s.notice_reads[0];
    act(A_QUESTION_CLOSE,0);work(submit);
    assert(s.view==INBOX&&!s.q.pending&&answers==0&&enqueued==queued&&removed==prior_removed);
    assert(s.notice_count==1&&!memcmp(&original,&s.notice[0],sizeof original));
    assert(!memcmp(&read_record,&s.notice_reads[0],sizeof read_record));

    // A new request for the SAME agent also invalidates a Close captured on the
    // old answer. The replacement retains its own token and notice revision.
    submit_choice();ui_set_connected(false);close=make_action(hit(A_QUESTION_CLOSE,0));
    ui_set_connected(true);ui_question_show("remote","Research","","question-new",NULL);
    assert(!s.q.pending);act(A_INBOX,0);act(A_QUESTION,0);
    question_state_reply(true,false,"question-new","token-new");
    revision=s.q.revision;queued=enqueued;original=s.notice[0];dispatch(close);
    ui_question_close("remote","question-remote");
    assert(s.q.valid&&s.q.revision==revision&&!strcmp(s.q.request,"question-new")&&!strcmp(s.q.token,"token-new"));
    assert(enqueued==queued&&s.notice_count==1&&!memcmp(&original,&s.notice[0],sizeof original));

    // A known rejection while still on answer review uses the same read-only
    // recovery. Exact authoritative receipt/close semantics stay unchanged.
    submit_choice();receipt("wrong-token",false);assert(!s.q.uncertain);
    receipt("token-remote",false);assert(s.q.pending&&s.q.uncertain&&s.view==ANSWER_REVIEW);
    queued=enqueued;render(&scene);assert(controls(A_QUESTION_CLOSE)&&!controls(A_ANSWER));
    portrait(&scene,dir,"unknown-rejected");act(A_ANSWER,0);act(A_QUESTION_SAY,0);assert(enqueued==queued);
    receipt("token-remote",true);assert(!s.q.pending&&s.view==HOME);
    submit_choice();ui_set_connected(false);ui_question_close("remote","question-remote");
    assert(!s.q.pending&&s.view==HOME&&!s.notice_count);

    // An already-submitted state from a fresh host read has no device copy.
    reset();act(A_QUESTION,0);question_state_reply(true,true,"question-remote","token-remote");
    render(&scene);assert(text_has(&scene,"No saved answer.")&&controls(A_QUESTION_CLOSE));
    portrait(&scene,dir,"unknown-no-copy");queued=enqueued;act(A_QUESTION_CLOSE,0);
    assert(!s.q.pending&&enqueued==queued&&s.notice_count==1);

    // Read all four retained answers locally, including long text, while
    // offline. Index changes invalidate down-captured Close and never edit the
    // submitted choices/drafts/answer bytes or emit another packet.
    submit_choice();ui_set_connected(false);s.q.count=4;s.q.index=0;
    for(int i=1;i<4;i++)s.q.item[i]=s.q.item[0];
    for(int i=0;i<18;i++)strcat(s.q.item[0].answer," Keep the selected file and its test together.");
    COPY(s.q.item[1].answer,"Second answer: leave the configuration unchanged.");
    COPY(s.q.item[2].answer,"Third answer: use the current branch.");
    COPY(s.q.item[3].answer,"Fourth answer: run the focused checks.");
    question_item_t retained[QUESTION_MAX];memcpy(retained,s.q.item,sizeof retained);
    queued=enqueued;unsigned voices=voice_commands;close=make_action(hit(A_QUESTION_CLOSE,0));
    render(&scene);portrait(&scene,dir,"unknown-long-first");
    int last=question_rows(s.q.item[0].answer)-Q_ROWS;assert(last>0);
    question_move(40*last);assert(s.offset==last&&s.q.index==0);
    render(&scene);portrait(&scene,dir,"unknown-long-last");
    question_move(40);assert(s.q.index==1&&s.offset==0);dispatch(close);assert(s.q.pending);
    question_move(80);assert(s.q.index==3);render(&scene);portrait(&scene,dir,"unknown-fourth");
    question_move(-120);assert(s.q.index==0&&s.offset==last);
    assert(enqueued==queued&&voice_commands==voices&&!memcmp(retained,s.q.item,sizeof retained));
    COPY(s.voice_language,"vi");s.offset=0;render(&scene);portrait(&scene,dir,"unknown-vi");
    assert(controls(A_QUESTION_CLOSE)&&!controls(A_DESKTOP)&&!controls(A_QUESTION_SAY));
    puts("Unknown answer recovery: PASS (real empty notif.replace reachability, local Close, queued-send invalidation, exact stale agent/request/revision/index guards, four-answer read-only scrolling, authoritative receipts, no-copy state)");
}
static void everyday_shortcuts(const char *dir) {
    ht_scene_t scene;
    // Questions retain their count after reading, ahead of unread results.
    reset();notice_add("result","Build","","The build is ready.",false,false);
    cable_notif_t question=s.notice[0];s.notice[0]=s.notice[1];s.notice[1]=question;
    notice_mark_read(&s.notice[1]);view(HOME);render(&scene);
    assert(waiting()==1&&text_has(&scene,"1 needs you")&&controls(A_INBOX)==1);
    assert(!s.notice[0].read_on_dial&&s.notice[1].read_on_dial);
    unsigned before=enqueued;act(A_INBOX,1);
    assert(s.view==INBOX&&s.offset==1&&s.active==0&&enqueued==before&&opens==0&&voice_commands==0);
    render(&scene);portrait(&scene,dir,"direct-read-question");
    notice_mark_read(&s.notice[1]);view(HOME);render(&scene);assert(text_has(&scene,"1 needs you"));

    // New notices may reorder the inbox; Home acts on today's question without
    // emitting a focus command. It does not acknowledge or answer the card.
    action_t attention=make_action(hit(A_INBOX,1));
    notice_add("other","Other","","A second question.",true,false);
    dispatch(attention);assert(s.view==INBOX&&s.notice[s.offset].question&&waiting()==2&&s.active==0&&opens==0);
    view(HOME);render(&scene);assert(text_has(&scene,"2 need you"));
    portrait(&scene,dir,"home-attention-header");

    // A retained answer stays one tap away, even with an empty replacement
    // inbox or a different pending question. Label and destination agree.
    s.q.pending=s.q.uncertain=true;COPY(s.q.name,"Research");COPY(s.q.agent,"remote");
    render(&scene);assert(text_has(&scene,"Review answer"));act(A_INBOX,1);
    assert(s.view==QUESTION&&s.q.pending&&opens==0);
    ui_notif_replace(NULL,0);view(HOME);render(&scene);assert(text_has(&scene,"Review answer"));
    act(A_INBOX,1);assert(s.view==QUESTION);
    s.q.pending=false;view(HOME);render(&scene);assert(text_has(&scene,"Updates"));
    act(A_INBOX,1);render(&scene);assert(s.view==INBOX&&text_has(&scene,"All caught up."));
    view(READER);before=enqueued;dispatch(attention);assert(s.view==READER&&enqueued==before);

    // A result is a cached recap. Select asks the host for fresh output from
    // exactly that source; no recap bytes become a terminal selection.
    reset();s.view=LAUNCHER;act(A_READER,0);render(&scene);
    assert(controls(A_SELECT_BEGIN)==1);portrait(&scene,dir,"reader-select-output");
    action_t choose=make_action(hit(A_SELECT_BEGIN,1));assert(!strcmp(choose.id,"design"));
    dispatch(choose);assert(s.view==SELECTION&&selection.pending&&!selection.excerpt[0]);
    assert(!strcmp(selection.agent,"design")&&sent.kind==A_SELECT_SEND&&sent.value==HT_SELECT_BEGIN);
    work(sent);assert(selections==1&&!strcmp(transport.id,"design")&&!strcmp(transport.text,selection.id));
    assert(ht_selection_reply(&selection,selection.request,selection.id,true,1,"Fresh terminal output.",1,false,NULL,now));
    render(&scene);assert(text_has(&scene,"Current output")&&text_has(&scene,"Design")&&text_has(&scene,"Fresh terminal"));
    assert(!text_has(&scene,"The design is ready"));portrait(&scene,dir,"reader-current-output");
    action_t picked=make_action(hit(A_CARRY,0));dispatch(picked);
    assert(carry.pending&&sent.kind==A_CARRY_SEND&&!strcmp(sent.id,"design")&&!strcmp(sent.text+48,selection.id)&&sent.revision==1);

    // Moving desktop focus while reading disables selection of the old source.
    // A tap captured just before that change is rejected, never rebound.
    reset();s.view=LAUNCHER;act(A_READER,0);choose=make_action(hit(A_SELECT_BEGIN,1));
    ui_focus_project("build");render(&scene);assert(!controls(A_SELECT_BEGIN)&&text_has(&scene,"Open this pane to select."));
    portrait(&scene,dir,"reader-source-not-current");before=enqueued;dispatch(choose);
    assert(s.view==READER&&!selection.active&&s.active==1&&enqueued==before&&opens==0);
    COPY(s.reader_agent,"build");dispatch(choose);assert(!selection.active&&enqueued==before);

    // Known unavailable states are gated both on glass and at dispatch.
    for(int unavailable=0;unavailable<7;unavailable++) {
        reset();s.view=LAUNCHER;act(A_READER,0);choose=make_action(hit(A_SELECT_BEGIN,1));
        if(unavailable==0)s.connected=false;
        if(unavailable==1)s.loading=true;
        if(unavailable==2)features&=~CABLE_FEATURE_SELECTION;
        if(unavailable==3)s.count=0;
        if(unavailable==4)visit.pending=true;
        if(unavailable==5)COPY(s.pending_focus,"build");
        if(unavailable==6)COPY(s.pending_machine,"another-machine");
        render(&scene);assert(!controls(A_SELECT_BEGIN));before=enqueued;dispatch(choose);
        assert(!selection.active&&enqueued==before&&opens==0);
    }

    // Selection failure remains visible for the pinned source, with a guarded
    // retry. A stale retry or Carry cannot use a replaced selection revision.
    reset();s.view=LAUNCHER;act(A_READER,0);act(A_SELECT_BEGIN,1);
    assert(ht_selection_reply(&selection,selection.request,selection.id,false,0,NULL,0,false,"Select that pane in Harness first.",now));
    render(&scene);assert(text_has(&scene,"Select that pane")&&controls(A_SELECT_BEGIN)==1);
    action_t retry=make_action(hit(A_SELECT_BEGIN,0));COPY(selection.id,"replacement");
    before=enqueued;dispatch(retry);dispatch(picked);assert(enqueued==before&&!carry.pending);
    COPY(selection.id,retry.text);act(A_SELECT_BEGIN,0);assert(selection.pending&&!strcmp(selection.agent,"design"));
    puts("Everyday shortcuts: PASS (read questions remain actionable, retained-answer priority, empty Updates, no implicit focus or voice, source-pinned fresh selection, stale/remote-focus guards, Carry revision and 720 px bounds)");
}
int main(int argc,char **argv) {
    const char *dir=argc>1?argv[1]:NULL;ht_scene_t scene;
    everyday_shortcuts(dir);
    unknown_answer_recovery(dir);

    // Reading is pinned even when the app selects another pane meanwhile.
    reset();s.view=LAUNCHER;act(A_READER,0);assert(s.view==READER&&!strcmp(s.reader_agent,"design"));
    ui_focus_project("build");render(&scene);assert(s.active==1&&text_has(&scene,"Design")&&!text_has(&scene,"The build"));
    portrait(&scene,dir,"reader-pinned");act(A_DESKTOP,2);
    assert(visit.pending&&!visit.available&&sent.kind==A_VISIT_SEND&&sent.value==HT_VISIT_OPEN&&!strcmp(sent.id,"design")&&opens==0);
    char id[48];COPY(id,visit.id);unsigned queued=enqueued;act(A_DESKTOP,2);assert(enqueued==queued);
    visit_reply("design",true,true,NULL);assert(s.view==HOME&&s.active==0&&visit.available&&!strcmp(visit.label,"Build / reading line 42"));
    action_t back=make_action(hit(A_RETURN,0));act(A_RETURN,0);
    assert(visit.pending&&sent.value==HT_VISIT_BACK&&!strcmp(sent.text,id));
    queued=enqueued;dispatch(back);assert(enqueued==queued);
    visit_reply("build",true,false,NULL);assert(s.active==1&&s.view==HOME&&!visit.available);

    // Same-pane opens and unsupported hosts never invent a Return bookmark.
    reset();s.view=LAUNCHER;act(A_READER,0);act(A_DESKTOP,2);visit_reply("design",true,false,NULL);assert(!visit.available);
    reset();features&=~CABLE_FEATURE_VISIT;s.view=LAUNCHER;act(A_READER,0);act(A_DESKTOP,2);
    assert(opens==1&&sent.kind==A_DESKTOP&&!strcmp(sent.id,"design")&&!visit.available&&!visit.pending);
    reset();s.view=LAUNCHER;act(A_READER,0);action_t open=make_action(hit(A_DESKTOP,2));s.agents[0]=s.agents[1];s.count=1;
    render(&scene);assert(!controls(A_DESKTOP));dispatch(open);assert(enqueued==0);
    reset();s.view=LAUNCHER;act(A_READER,0);congested=true;act(A_DESKTOP,2);assert(s.view==MESSAGE&&!visit.pending&&!visit.available);

    // Local off-workspace question is independent of the home and desktop focus.
    reset();render(&scene);assert(controls(A_QUESTION)==1&&controls(A_NOTICE)==1);portrait(&scene,dir,"updates-answer");
    act(A_QUESTION,0);assert(s.active==0&&s.view==QUESTION&&s.q.loading&&!strcmp(s.q.agent,"remote")&&opens==0);
    work(sent);assert(reads==1&&!strcmp(transport.id,"remote"));question_state(true);assert(s.q.valid&&s.q.supported);
    render(&scene);portrait(&scene,dir,"question-local");
    queued=enqueued;act(A_VOICE,0);assert(enqueued==queued&&!s.voice_open);
    act(A_QUESTION_SAY,0);assert(s.view==VOICE&&voice_commands==1&&!strcmp(sent.id,"remote")&&!strcmp(sent.text,"token-remote"));
    assert(!strcmp(s.voice_target,"Research")&&s.voice_question_revision==s.q.revision&&s.active==0);
    ui_focus_project("build");s.voice_waiting=true;voice_reply("token-remote");
    assert(s.view==ANSWER_REVIEW&&s.active==1&&!strcmp(s.q.item[0].answer,"Only change the selected file."));
    act(A_ANSWER,0);assert(s.q.pending);action_t submit=sent;work(submit);
    assert(answers==1&&!strcmp(transport.id,"remote")&&!strcmp(transport.text,"token-remote"));
    act(A_ANSWER,0);assert(answers==1&&s.q.pending);
    view(QUESTION);render(&scene);assert(text_has(&scene,"Confirming")&&!controls(A_QUESTION_SAY)&&!controls(A_QUESTION_CLOSE));portrait(&scene,dir,"question-pending");
    ui_set_connected(false);assert(s.q.pending&&s.q.uncertain&&!s.q.valid&&s.view==QUESTION&&!strcmp(s.q.item[0].answer,"Only change the selected file."));
    render(&scene);assert(text_has(&scene,"Delivery unconfirmed")&&text_has(&scene,"Only change")&&!controls(A_DESKTOP)&&controls(A_QUESTION_CLOSE));portrait(&scene,dir,"question-uncertain");
    // Read notifications may disappear; the retained delivery record stays reachable offline.
    cable_notif_t pending_notice=s.notice[0];ui_notif_replace(NULL,0);view(LAUNCHER);act(A_INBOX,0);assert(s.view==INBOX);render(&scene);
    assert(controls(A_QUESTION)==1&&!text_has(&scene,"All caught up"));portrait(&scene,dir,"updates-retained-answer");
    action_t pending_review=make_action(hit(A_QUESTION,-1));dispatch(pending_review);assert(s.view==QUESTION);
    s.notice[0]=pending_notice;s.notice_count=1;
    ui_set_connected(true);view(INBOX);queued=enqueued;act(A_QUESTION,0);
    assert(s.view==QUESTION&&enqueued==queued&&s.q.pending);work(submit);assert(answers==1);
    receipt("wrong-token",true);assert(s.q.pending);receipt("token-remote",true);
    assert(!s.q.pending&&s.view==HOME&&s.active==1&&opens==0);
    view(INBOX);dispatch(pending_review);assert(s.view==INBOX);

    // Notice movement is harmless; replacement and closed questions cancel old actions.
    reset();action_t answer=make_action(hit(A_QUESTION,0));notice_add("another","Other","","Other question",true,false);
    cable_notif_t swap=s.notice[0];s.notice[0]=s.notice[1];s.notice[1]=swap;dispatch(answer);
    assert(s.q.loading&&!strcmp(s.q.agent,"remote")&&s.active==0);
    reset();answer=make_action(hit(A_QUESTION,0));s.notice[0].display_revision++;dispatch(answer);assert(enqueued==0&&s.view==INBOX);
    reset();act(A_QUESTION,0);question_state(true);act(A_QUESTION_CHOICES,0);act(A_CHOICE,0);act(A_QUESTION_REVIEW,0);
    answer=make_action(hit(A_ANSWER,0));ui_question_close("remote","older-question");assert(s.q.valid);
    ui_question_close("remote","question-remote");queued=enqueued;dispatch(answer);assert(enqueued==queued&&!s.q.pending);
    reset();act(A_QUESTION,0);question_state(true);act(A_QUESTION_SAY,0);s.voice_waiting=true;s.q.revision++;voice_reply("token-remote");
    assert(s.view==MESSAGE&&!s.voice_open&&!s.q.item[0].draft[0]);
    reset();act(A_QUESTION,0);question_state(true);act(A_QUESTION_CHOICES,0);act(A_CHOICE,0);act(A_QUESTION_REVIEW,0);act(A_ANSWER,0);
    ui_set_connected(false);ui_set_connected(true);view(INBOX);
    notice_add("another","Other","","Other question",true,false);s.offset=1;render(&scene);assert(controls(A_QUESTION)==1);
    queued=enqueued;act(A_QUESTION,1);assert(enqueued==queued&&s.view==INBOX);
    ui_question_show("remote","Research","","new-question",NULL);assert(!s.q.pending&&!s.q.valid);

    // Unsupported answers stay explicit; an older host only offers the plain app open.
    reset();features&=~CABLE_FEATURE_QUESTIONS;render(&scene);assert(!controls(A_QUESTION)&&controls(A_NOTICE));
    answer=make_action(hit(A_QUESTION,0));dispatch(answer);assert(enqueued==0);
    features&=~CABLE_FEATURE_VISIT;act(A_NOTICE,0);assert(opens==1&&!visit.available&&s.active==0);
    reset();act(A_QUESTION,0);question_state(false);render(&scene);assert(!controls(A_QUESTION_SAY)&&controls(A_DESKTOP));
    act(A_DESKTOP,1);assert(visit.pending&&sent.value==HT_VISIT_OPEN&&!strcmp(sent.id,"remote"));
    visit_reply("remote",true,true,NULL);assert(s.view==MESSAGE&&!strcmp(s.pending_focus,"remote"));
    COPY(s.agents[2].id,"remote");COPY(s.agents[2].name,"Research");s.count=3;ui_focus_project("remote");
    assert(s.view==AGENT&&s.active==2&&visit.available); // Opening never auto-enters Answer.

    // Return invalidation and degraded origins never masquerade as exact restoration.
    reset();act(A_NOTICE,0);visit_reply("build",true,true,NULL);ui_focus_project("design");assert(!visit.available);
    reset();act(A_NOTICE,0);visit_reply("build",true,true,NULL);act(A_RETURN,0);visit_reply("design",true,false,"The original lines are no longer available.");
    assert(s.view==MESSAGE&&strstr(s.message,"no longer available")&&!visit.available);
    reset();act(A_NOTICE,0);visit_reply("build",true,true,NULL);act(A_RETURN,0);visit_reply("design",false,false,NULL);
    assert(s.view==MESSAGE&&strstr(s.message,"closed")&&!visit.available);
    reset();act(A_NOTICE,0);ui_set_connected(false);assert(!visit.available&&!visit.pending);
    reset();act(A_NOTICE,0);assert(ht_visit_tick(&visit,visit.deadline));assert(!visit.available&&!visit.pending);

    // Both supported languages and long names retain separate usable targets.
    for(int language=0;language<2;language++)for(int pending=0;pending<2;pending++) {
        reset();COPY(s.voice_language,language?"vi":"en");memset(s.notice[0].name,'W',sizeof s.notice[0].name-1);
        s.q.pending=pending;COPY(s.q.agent,"remote");render(&scene);
        if(language)portrait(&scene,dir,pending?"updates-vi-pending":"updates-vi");
    }
    puts("Pro app interactions: PASS (real local question/voice handlers, notice identity/revision pinning, stale answers, uncertain receipt recovery, capability-gated visits, reader identity, honest Return and 720 px sheets)");
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-") as directory:
    build = Path(directory)
    (build / "app_interactions.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "app_interactions.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        *[str(NATIVE / (name + ".c")) for name in ("visit", "carry", "workspace", "form", "draft", "selection", "gestures")],
        "-o", str(build / "app_interactions"),
    ], check=True)
    args = [str(build / "app_interactions")]
    if os.environ.get("HABITAT_PRO_PREVIEW_DIR"):
        destination = Path(os.environ["HABITAT_PRO_PREVIEW_DIR"])
        destination.mkdir(parents=True, exist_ok=True)
        args.append(str(destination))
    subprocess.run(args, check=True)
