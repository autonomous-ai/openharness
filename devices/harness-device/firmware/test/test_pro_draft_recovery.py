"""Replay actual Pro draft recovery and native sheets against ESP-IDF cJSON.

Requires IDF_PATH (the same pinned SDK used for the target) and generated Pro
fonts. The normal dependency-free/round suites remain SDK-independent. Optional
HABITAT_RECOVERY_TRANSCRIPT supplies exact CableSession JSON frames; optional
HABITAT_PRO_PREVIEW_DIR receives actual 720 px PPMs. No hardware or sending.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
from native_shapes import defines, typedef

HERE = Path(__file__).resolve().parent
NATIVE = (HERE / "../main/ui/habitat").resolve()
SOURCE = (NATIVE / "ui_habitat.c").read_text()
SHEETS = (NATIVE / "pro_controls.inc").read_text()
CABLE = (NATIVE / "../../cable_client.c").resolve().read_text()
FONTS = HERE / "../../prototype/pro-companion/generated/pro_fonts.c"
JSON_DIR = Path(os.environ["IDF_PATH"]) / "components/json/cJSON"

def function(name, source=SOURCE):
    match = re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{.*?^\}", source, re.M | re.S)
    assert match, name
    return match.group(0) + "\n"

assert "pro_draft_restore();" in function("ui_init"), "The real boot path must load the metadata bookmark."
code = r'''
#include "runtime.h"
#include "pro_canvas.h"
#include "pro_metrics.h"
#include "pro_visual.h"
#include "pro_work_intent.h"
#include "pro_draft_recovery.h"
#include "workspace.h"
#include "selection.h"
#include "carry.h"
#include "pro_carry_review.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "character.h"
#include "gestures.h"
#include "../../cable_features.h"
#include "../../cable_machines.h"
#include "theme.h"
#include "cJSON.h"
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define COPY(dst,src) copy(dst,sizeof(dst),src)
'''
code += defines("CABLE_READ_TOKEN_MAX", "ID_MAX", "CABLE_NAME_MAX", "SWARM_ID_MAX", "SWARMS_MAX",
                "SWARM_TILES_MAX", "CABLE_MAX_AGENTS", "MAX_PROJECTS")
code += defines("NOTICES", "QUESTION_MAX", "OPTION_MAX", "PANE_MEMORY_MAX", "PANE_RESULT_BYTES", "UI_FONT", "Q_ROWS", "DRAFT_ROWS", source=SOURCE)
for name in ("cable_swarm_t", "cable_notif_t", "cable_tile_t", "model_item_t"):
    code += typedef(name)
code += SOURCE[SOURCE.index("typedef enum {"):SOURCE.index("static QueueHandle_t actions;")]
code += function("copy")
code += r'''
static ht_workspace_t workspace;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static ht_gesture_t gesture;
static uint32_t now=100;
static atomic_uint features=~0u;
static bool congested, recording;
static unsigned enqueued, wires, mutations;
static action_t sent, wire;
static uint32_t ms(void) { return now; }
static bool cable_client_supports(uint32_t mask) { return (features&mask)==mask; }
static agent_t *active(void) { return s.active>=0&&s.active<s.count?&s.agents[s.active]:NULL; }
static int find(const char *id) { for(int i=0;i<s.count;i++)if(!strcmp(id,s.agents[i].id))return i;return -1; }
static void change(void) {}
static void display_lock(void) {}
static void display_unlock(void) {}
static void input_cancel(void) { s.pressed=-1; }
static void view(view_t v) { input_cancel();s.view=v;s.offset=0; }
static bool audio_client_active(void) { return recording; }
static void audio_client_abort(void) { recording=false; }
static int actions=1;
#define pdPASS 1
static unsigned uxQueueSpacesAvailable(int q) { (void)q;return congested?0:20; }
static int xQueueSend(int q,const action_t *a,int wait) { (void)q;(void)wait;sent=*a;enqueued++;return pdPASS; }
static void cable_client_draft(const char *id,const char *op,uint32_t request,uint32_t revision,int delta) {
    wires++;wire=(action_t){.revision=request,.dy=(int)revision,.velocity=delta};COPY(wire.id,id);COPY(wire.text,op);
    if(strcmp(op,"state")&&strcmp(op,"move"))mutations++;
}
static uint16_t color(unsigned rgb) { return ht_rgb(rgb); }
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define SEL color(HT_THEME_SELECTION)
static void dispatch(action_t a);
static pro_recovery_bookmark_t stored_bookmark;
static bool stored_present, fail_save, fail_clear;
static unsigned save_calls, clear_calls;
static void (*save_hook)(void);
static bool config_load_pro_recovery(pro_recovery_bookmark_t *b) {if(!stored_present)return false;*b=stored_bookmark;return pro_recovery_bookmark_valid(b);}
static bool config_save_pro_recovery(const pro_recovery_bookmark_t *b) {
    save_calls++;if(save_hook)save_hook();if(fail_save||!pro_recovery_bookmark_valid(b))return false;stored_bookmark=*b;stored_present=true;return true;
}
static bool config_clear_pro_recovery(void) {clear_calls++;if(fail_clear)return false;stored_present=false;return true;}
'''
for name in ("question_view", "question_rows", "voice_close", "draft_emit", "pro_draft_forget", "pro_draft_store_queue", "pro_draft_store_work", "pro_draft_restore", "make_action", "draft_move",
             "ui_set_connected", "ui_draft_source", "draft_page", "ui_voice_draft", "ui_draft_state"):
    code += function(name)
code += "static void dispatch(action_t a) { switch(a.kind) {\n"
code += "    case A_DRAFT_EDIT:" + SOURCE.split("    case A_DRAFT_EDIT:",1)[1].split("    case A_HOME:",1)[0]
code += "default:mutations++;break;} }\n"
worker = SOURCE.split("static void worker(",1)[1]
code += "static void work(action_t a) { switch(a.kind) {\n        case A_DRAFT_COMMAND:" + worker.split("        case A_DRAFT_COMMAND:",1)[1].split("        case A_CARRY_SEND:",1)[0] + "case A_DRAFT_STORE:pro_draft_store_work(a);break;default:assert(false);}}\n"
for name in ("pro_hit", "pro_control", "pro_heading", "pro_note", "pro_row", "pro_read_text", "pro_draft", "pro_draft_options", "pro_carry_preview"):
    code += function(name,SHEETS)
code += r'''
#define s_features features
#define ESP_LOGI(tag,...) do{(void)(tag);if(false)fprintf(stderr,__VA_ARGS__);}while(0)
static const char *TAG="cable";
static char s_machine_name[40],s_machine_id[48],selected_machine[48];
static bool s_session;
static void ui_set_selected_machine(const char *id){COPY(selected_machine,id);}
static void ui_metrics_source(const char *id,bool supported){(void)id;(void)supported;}
static void cable_link_set_log_framing(bool enabled){assert(enabled);}
static void last_words_report(void){}
static cJSON *msg(const char *type){cJSON *p=cJSON_CreateObject();cJSON_AddStringToObject(p,"t",type);return p;}
static void send_json(cJSON *p){cJSON_Delete(p);}
'''
code += function("str_of", CABLE) + function("session_up", CABLE)
code += r'''
static hit_t hit(action_kind_t kind) { return (hit_t){.action=kind,.enabled=true}; }
static void act(action_kind_t kind) { dispatch(make_action(hit(kind)));if(kind==A_DRAFT_DISCARD&&s.draft_recovery.store==PRO_RECOVERY_CLEARING)work(sent); }
static void reset(void) {
    memset(&s,0,sizeof s);memset(&draft,0,sizeof draft);memset(&form,0,sizeof form);memset(&carry,0,sizeof carry);
    memset(&selection,0,sizeof selection);memset(&visit,0,sizeof visit);memset(&workspace,0,sizeof workspace);
    enqueued=wires=mutations=0;features=~0u;congested=recording=false;
    stored_present=fail_save=fail_clear=false;save_calls=clear_calls=0;save_hook=NULL;
    s.connected=s.ready=true;s.active=0;s.count=1;s.pressed=-1;COPY(s.agents[0].id,"original");COPY(s.agents[0].engine,"claude");
    COPY(s.voice_language,"en");ui_draft_source("original-host");
}
static cJSON *page(const char *id,const char *agent,unsigned rev,int position,int total,const char *text,bool active_) {
    cJSON *p=cJSON_CreateObject();assert(p);
    cJSON_AddStringToObject(p,"id",id);cJSON_AddStringToObject(p,"agentId",agent);
    cJSON_AddNumberToObject(p,"revision",rev);cJSON_AddNumberToObject(p,"position",position);cJSON_AddNumberToObject(p,"total",total);
    cJSON_AddStringToObject(p,"name","Original recipient");cJSON_AddStringToObject(p,"context","Original workspace");
    cJSON_AddStringToObject(p,"text",text);cJSON_AddBoolToObject(p,"active",active_);cJSON_AddBoolToObject(p,"ok",true);
    cJSON_AddBoolToObject(p,"canSend",true);cJSON_AddBoolToObject(p,"canUndo",true);return p;
}
static void replace_number(cJSON *p,const char *key,double value) { cJSON_ReplaceItemInObjectCaseSensitive(p,key,cJSON_CreateNumber(value)); }
static void replace_string(cJSON *p,const char *key,const char *value) { cJSON_ReplaceItemInObjectCaseSensitive(p,key,cJSON_CreateString(value)); }
static void record(const char *agent,unsigned mode) {
    s.voice_open=s.voice_waiting=s.voice_review=true;s.voice_return=HOME;s.work_voice_mode=mode;COPY(s.work_agent,agent);
    pro_draft_recovery_pin(&s.draft_recovery,agent,(uint8_t)mode);
}
static void open_draft(unsigned mode,bool carried) {
    reset();record("original",mode);
    if(carried) {
        COPY(s.carry_review.id,"carry-old");COPY(s.carry_review.agent,"original");COPY(s.carry_review.name,"Original recipient");
        COPY(s.carry_review.source,"Original workspace / design");COPY(s.carry_review.excerpt,"Keep this original passage.");s.carry_review.rows=8;
        s.voice_carry=true;
    }
    cJSON *p=page("draft-original","original",7,1,5,"Keep the API.\nRead every part of my original instruction.",true);
    ui_voice_draft(p);cJSON_Delete(p);assert(draft.page.active&&!draft.read_only&&s.view==DRAFT);
    assert(sent.kind==A_DRAFT_STORE);work(sent);assert(stored_present&&save_calls==1);enqueued=0;
}
static cJSON *reply(unsigned rev,int position,int total,const char *text,bool active_) {
    cJSON *p=page("draft-original","original",rev,position,total,text,active_);char request[32];
    snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);cJSON_AddStringToObject(p,"requestId",request);return p;
}
static void respond(unsigned rev,int pos,const char *text) {
    cJSON *p=reply(rev,pos,5,text,true);ui_draft_state(p);cJSON_Delete(p);
}
static void reconnect(const char *host) {
    cJSON *p=cJSON_CreateObject(),*machine=cJSON_AddObjectToObject(p,"machine");
    cJSON_AddStringToObject(machine,"id",host);cJSON_AddStringToObject(machine,"name","Cable computer");
    cJSON_AddStringToObject(p,"selected","remote-focus");cJSON *list=cJSON_AddArrayToObject(p,"features");
    cJSON_AddItemToArray(list,cJSON_CreateString("voice.draft"));session_up(p);cJSON_Delete(p);
    assert(!strcmp(selected_machine,"remote-focus"));
}
static void recover(void) { act(A_DRAFT_STATE);assert(draft.pending);work(sent);assert(!strcmp(wire.text,"state")); }
static bool overlap(ht_rect_t a,ht_rect_t b) {return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;}
static void render(ht_scene_t *f) {
    s.hit_count=0;ht_scene_clear(f,BG);
    if(s.view==CARRY_PREVIEW)pro_carry_preview(f);else if(s.view==DRAFT_OPTIONS)pro_draft_options(f);else pro_draft(f);
    assert(f->count<HT_RUNS);
    if (!s.draft_recovery.has_words && s.connected && pro_draft_recovery_same_host(&s.draft_recovery))
        for(int i=0;i<f->count;i++)assert(!strstr(f->runs[i].text,"Connect to the original"));
    for(int i=0;i<f->count;i++) {
        ht_rect_t r=ht_run_bounds(&f->runs[i]);assert(r.x>=0&&r.y>=0&&r.x+r.w<=720&&r.y+r.h<=720);
        if(f->runs[i].pro_kind!=1||!f->runs[i].text[0])continue;
        for(int j=i+1;j<f->count;j++)if(f->runs[j].pro_kind==1&&f->runs[j].text[0])assert(!overlap(r,ht_run_bounds(&f->runs[j])));
    }
    for(int i=0;i<s.hit_count;i++) {
        ht_rect_t r=s.hits[i].rect;assert(r.w>=64&&r.h>=64&&r.x>=0&&r.y>=0&&r.x+r.w<=720&&r.y+r.h<=720);
        if(s.hits[i].action==A_DRAFT_STATE||s.hits[i].action==A_DRAFT_DISCARD)assert(r.h>=80);
        for(int j=i+1;j<s.hit_count;j++)assert(!overlap(r,s.hits[j].rect));
        if(s.hits[i].enabled)assert(s.hits[i].action!=A_DRAFT_SEND&&s.hits[i].action!=A_DRAFT_EDIT&&s.hits[i].action!=A_DRAFT_APPEND&&s.hits[i].action!=A_DRAFT_UNDO);
    }
}
static void portrait(const ht_scene_t *f,const char *dir,const char *name) {
    if(!dir)return;static uint16_t pixels[720*720];ht_raster(f,(ht_rect_t){0,0,720,720},pixels);
    char path[1024];snprintf(path,sizeof path,"%s/%s.ppm",dir,name);FILE *out=fopen(path,"wb");assert(out);fprintf(out,"P6\n720 720\n255\n");
    for(size_t i=0;i<720*720;i++){unsigned p=pixels[i];unsigned char rgb[]={(p>>11)*255/31,((p>>5)&63)*255/63,(p&31)*255/31};fwrite(rgb,1,3,out);}fclose(out);
}
static void snapshot(ht_scene_t *f,const char *dir,const char *name) {render(f);portrait(f,dir,name);}
static void test_recovery(const char *dir) {
    ht_scene_t scene;
    for(unsigned mode=0;mode<3;mode++)for(unsigned carried=0;carried<2;carried++) {
        open_draft(mode,carried);action_t stale=make_action(hit(A_DRAFT_SEND));
        assert(ht_draft_command(&draft,HT_DRAFT_SEND,draft.page.revision,0,now));action_t queued=sent;
        ui_set_connected(false);assert(draft.page.active&&draft.read_only&&!draft.pending&&s.view==DRAFT);
        work(queued);dispatch(stale);assert(wires==0&&mutations==0);
        act(A_DRAFT_SEND);act(A_DRAFT_EDIT);act(A_DRAFT_APPEND);act(A_DRAFT_UNDO);assert(!draft.pending&&mutations==0);
        assert(s.draft_recovery.mode==mode&&!strcmp(s.draft_recovery.recipient,"original"));
        if(mode==0&&!carried)snapshot(&scene,dir,"task-offline");
        if(mode==1&&!carried)snapshot(&scene,dir,"goal-offline");
        if(mode==2&&!carried)snapshot(&scene,dir,"loop-offline");
        reconnect("other-host");act(A_DRAFT_STATE);assert(!draft.pending);
        reconnect("original-host");COPY(s.agents[0].id,"new-focus");s.work_voice_mode=PRO_WORK_TASK;COPY(carry.id,"new-tray");
        recover();respond(8,1,"First part. Original words.");
        assert(draft.read_only&&s.draft_recovery.ready&&!draft.page.can_send&&!draft.page.can_undo&&draft.page.locked);
        assert(s.draft_recovery.mode==mode&&!strcmp(draft.page.name,"Original recipient"));
        for(int part=2;part<=5;part++) {
            s.offset=question_rows(draft.page.text)-DRAFT_ROWS;if(s.offset<0)s.offset=0;draft_move(40,now);assert(draft.pending);work(sent);
            assert(!strcmp(wire.text,"move")&&wire.velocity==1);respond((unsigned)(7+part),part,part==5?"Những lời ban đầu của tôi. Giữ đúng nội dung.":"Later original part.\n  Whitespace stays visible.");
            assert(draft.page.position==part&&draft.read_only&&!draft.page.can_send);
        }
        s.offset=0;draft_move(-40,now);assert(draft.pending);work(sent);respond(13,4,"The prior part remains readable.");
        assert(draft.page.position==4&&!draft.pending&&mutations==0);
        // Historical submission metadata cannot clear the user's recovered words.
        recover();cJSON *p=reply(13,4,5,"The prior part remains readable.",true);cJSON_AddBoolToObject(p,"sent",true);
        cJSON_AddStringToObject(p,"error","Read only. Submitted to the original terminal.");ui_draft_state(p);cJSON_Delete(p);
        assert(draft.page.active&&draft.read_only&&!draft.page.can_send);
        if(carried) {assert(!strcmp(s.carry_review.excerpt,"Keep this original passage."));act(A_CARRY_PREVIEW);snapshot(&scene,dir,"carry-preview-recovered");act(A_DRAFT_BACK);}
        if(mode==2&&!carried)snapshot(&scene,dir,"loop-recovered");
        unsigned old=wires;act(A_DRAFT_SEND);act(A_DRAFT_EDIT);act(A_DRAFT_APPEND);act(A_DRAFT_UNDO);assert(wires==old&&mutations==0);
        action_t close=make_action(hit(A_DRAFT_DISCARD));act(A_DRAFT_STATE);assert(draft.pending);
        act(A_DRAFT_DISCARD);assert(!draft.page.active&&!s.draft_recovery.original_host[0]&&s.view==HOME);
        p=reply(14,5,5,"Late response",true);ui_draft_state(p);cJSON_Delete(p);assert(!draft.page.active);
        record("original",mode);p=page("draft-original","original",7,1,5,"A new draft with a reused test UUID.",true);
        ui_voice_draft(p);cJSON_Delete(p);ui_set_connected(false);dispatch(close);assert(draft.page.active);
        act(A_DRAFT_DISCARD);assert(!draft.page.active);
    }
}
'''
code += r'''
static void test_failures(const char *dir) {
    ht_scene_t scene;
    // A same-host welcome can follow a fast daemon restart without an observed
    // disconnect. Unknown normal draft state still preserves every intent.
    for(unsigned mode=0;mode<3;mode++) {
        open_draft(mode,false);unsigned generation=s.draft_recovery.generation;
        ui_draft_source("original-host");assert(s.draft_recovery.generation==generation);
        assert(ht_draft_command(&draft,HT_DRAFT_STATE,7,0,now));
        cJSON *unknown=reply(7,1,5,"",false);cJSON_ReplaceItemInObjectCaseSensitive(unknown,"ok",cJSON_CreateBool(false));
        ui_draft_state(unknown);cJSON_Delete(unknown);
        assert(draft.read_only&&draft.page.active&&!draft.pending&&stored_present&&s.draft_recovery.store==PRO_RECOVERY_SAVED);
        assert(!strcmp(draft.page.text,"Keep the API.\nRead every part of my original instruction."));
        act(A_DRAFT_SEND);act(A_DRAFT_EDIT);assert(!draft.pending&&mutations==0);
        act(A_DRAFT_DISCARD);assert(!draft.page.active&&!stored_present);
    }
    open_draft(PRO_WORK_TASK,false);action_t before_disconnect=make_action(hit(A_DRAFT_DISCARD));
    ui_set_connected(false);dispatch(before_disconnect);assert(draft.page.active);
    const char *longpart="One original line. Two original lines. Three original lines. Four original lines. Five original lines. Six original lines. Seven original lines. Eight original lines. Nine original lines. Ten original lines. Keep the exact original meaning. Do not rewrite or send these words. Only read the copied part. More of this instruction lives on the original computer. This final sentence must also remain readable while disconnected.";
    COPY(draft.page.text,longpart);s.draft_drag=0;s.offset=0;draft_move(4000,now);
    assert(s.offset==question_rows(longpart)-DRAFT_ROWS&&s.offset>0&&wires==0&&enqueued==0);
    snapshot(&scene,dir,"offline-last-rows");
    reconnect("original-host");recover();action_t request=sent;
    cJSON *p=reply(8,1,5,"Mismatched recipient",true);replace_string(p,"agentId","new-focus");ui_draft_state(p);assert(draft.pending&&!strcmp(draft.page.text,longpart));
    replace_string(p,"agentId","original");replace_number(p,"revision",6);ui_draft_state(p);assert(draft.pending);
    replace_number(p,"revision",8);replace_number(p,"position",6);ui_draft_state(p);assert(draft.pending);
    replace_number(p,"position",1);replace_string(p,"id","other-id");ui_draft_state(p);assert(draft.pending);cJSON_Delete(p);
    // Wrong request, malformed/overlong UTF-8 and timeout all preserve the last part.
    p=reply(8,1,5,"Wrong request",true);cJSON_ReplaceItemInObjectCaseSensitive(p,"requestId",cJSON_CreateString("draft-999999"));ui_draft_state(p);assert(draft.pending);cJSON_Delete(p);
    char huge[482];memset(huge,'x',sizeof huge-1);huge[sizeof huge-1]=0;p=reply(8,1,5,huge,true);ui_draft_state(p);assert(draft.pending);cJSON_Delete(p);
    assert(ht_draft_tick(&draft,draft.deadline));s.draft_recovery.ready=false;
    assert(!draft.pending&&!strcmp(draft.page.text,longpart)&&!strcmp(draft.page.error,"Full message unavailable."));
    snapshot(&scene,dir,"message-unavailable");
    p=page("draft-original","original",8,1,5,"Late timed-out reply",true);char rid[32];snprintf(rid,sizeof rid,"draft-%lu",(unsigned long)request.revision);cJSON_AddStringToObject(p,"requestId",rid);ui_draft_state(p);cJSON_Delete(p);assert(!strcmp(draft.page.text,longpart));
    recover();p=reply(8,1,5,"",false);ui_draft_state(p);cJSON_Delete(p);assert(draft.page.active&&!draft.pending&&!s.draft_recovery.ready&&!strcmp(draft.page.text,longpart));
    // A different full cable-host identity invalidates an already queued request.
    recover();request=sent;unsigned old=wires;ui_draft_source("different-host");work(request);assert(wires==old&&!draft.pending);
    p=page("draft-original","original",9,2,5,"Foreign host reply",true);snprintf(rid,sizeof rid,"draft-%lu",(unsigned long)request.revision);cJSON_AddStringToObject(p,"requestId",rid);ui_draft_state(p);cJSON_Delete(p);assert(!strcmp(draft.page.text,longpart));
    ui_draft_source(NULL);act(A_DRAFT_STATE);assert(!draft.pending);
    char oversized[49];memset(oversized,'h',48);oversized[48]=0;ui_draft_source(oversized);act(A_DRAFT_STATE);assert(!draft.pending&&!s.draft_recovery.current_host[0]);
    reconnect(oversized);assert(!s.draft_recovery.current_host[0]); // The actual welcome must not use its truncated legacy buffer.
    ui_draft_source("original-host");features=0;act(A_DRAFT_STATE);assert(!draft.pending);features=~0u;
    recover();respond(8,1,"Recovered first part.");assert(s.draft_recovery.ready);
    draft_move(40,now);assert(draft.pending);p=reply(8,2,5,"Stale move revision",true);ui_draft_state(p);assert(draft.pending);
    replace_number(p,"revision",9);replace_number(p,"total",6);ui_draft_state(p);assert(draft.pending);
    replace_number(p,"total",5);replace_number(p,"position",3);ui_draft_state(p);assert(draft.pending);
    replace_number(p,"position",2);replace_string(p,"text","Những lời ban đầu. Giữ đúng tiếng Việt.");ui_draft_state(p);cJSON_Delete(p);assert(!draft.pending&&draft.page.position==2&&!draft.page.can_send);
    COPY(draft.page.text,"These are your original words. The full message is read only, and each part remains yours to read.");
    snapshot(&scene,dir,"recovered-words");
    act(A_DRAFT_OPTIONS);snapshot(&scene,dir,"recovery-options");act(A_DRAFT_BACK);
    recover();snapshot(&scene,dir,"recovering");act(A_DRAFT_DISCARD);assert(!draft.page.active&&mutations==0);
    // No late voice.draft, even if it repeats a prior UUID, can release the latch.
    open_draft(PRO_WORK_GOAL,false);ui_set_connected(false);reconnect("original-host");
    s.voice_open=s.voice_waiting=s.voice_review=true;s.voice_return=HOME;
    p=page("draft-original","original",8,1,5,"Late editable draft",true);ui_voice_draft(p);cJSON_Delete(p);
    assert(draft.read_only&&!strcmp(draft.page.text,"Keep the API.\nRead every part of my original instruction."));
    voice_close();act(A_DRAFT_DISCARD);assert(!draft.page.active);
    // Unchanged glyph gate: native reading supports NFC VI, current send gate does not.
    p=page("vi","original",1,1,1,"Đọc những lời này.",true);ht_draft_page_t parsed={0};assert(draft_page(p,&parsed)&&!parsed.can_send);cJSON_Delete(p);
}
static void restart_device(void) {
    memset(&s,0,sizeof s);memset(&draft,0,sizeof draft);recording=false;s.pressed=-1;
    COPY(s.voice_language,"en");pro_draft_restore();
}
static void close_during_save(void) {dispatch(make_action(hit(A_DRAFT_DISCARD)));}
static void test_persistence(const char *dir) {
    ht_scene_t scene;
    open_draft(PRO_WORK_LOOP,true);assert(stored_present&&save_calls==1&&sizeof stored_bookmark==256);
    assert(stored_bookmark.mode==PRO_WORK_LOOP&&stored_bookmark.carried&&!strcmp(stored_bookmark.agent,"original"));
    // Accepted edits keep the UUID and do not rewrite the metadata bookmark.
    s.voice_open=s.voice_waiting=s.voice_review=true;s.voice_return=DRAFT;s.voice_draft_revision=7;
    cJSON *edited=page("draft-original","original",8,1,5,"Edited original words.",true);ui_voice_draft(edited);cJSON_Delete(edited);
    assert(draft.page.revision==8&&save_calls==1&&stored_bookmark.revision==7);
    // Text/source are deliberately absent from the durable layout.
    restart_device();assert(draft.read_only&&draft.page.active&&!draft.page.text[0]&&!s.carry_review.id[0]);
    assert(!s.draft_recovery.has_words&&s.draft_recovery.mode==PRO_WORK_LOOP&&s.draft_recovery.carried);
    snapshot(&scene,dir,"restart-bookmark");
    reconnect("wrong-host");act(A_DRAFT_STATE);assert(!draft.pending);
    reconnect("original-host");recover();respond(8,1,"Recovered from the original computer after a restart.");
    assert(draft.read_only&&s.draft_recovery.has_words&&save_calls==1&&!s.carry_review.id[0]);snapshot(&scene,dir,"restart-recovered");
    s.offset=0;draft_move(40,now);respond(9,2,"Second original part.");assert(save_calls==1);
    act(A_DRAFT_DISCARD);assert(!stored_present&&!draft.page.active&&clear_calls==1);
    restart_device();assert(!draft.page.active);
    // Unknown/expired host archive retains only the bookmark after a restart.
    open_draft(PRO_WORK_GOAL,false);restart_device();reconnect("original-host");recover();
    cJSON *p=reply(7,1,1,"",false);ui_draft_state(p);cJSON_Delete(p);
    assert(draft.page.active&&!s.draft_recovery.has_words&&!draft.page.text[0]);snapshot(&scene,dir,"restart-unavailable");
    fail_clear=true;act(A_DRAFT_DISCARD);assert(draft.page.active&&stored_present&&s.draft_recovery.store==PRO_RECOVERY_CLEAR_FAILED);
    snapshot(&scene,dir,"clear-failed");restart_device();assert(draft.page.active&&draft.read_only);
    fail_clear=false;act(A_DRAFT_DISCARD);assert(!draft.page.active&&!stored_present);
    // A rejected save never claims durable recovery. RAM reading still works.
    reset();fail_save=true;record("original",PRO_WORK_TASK);p=page("draft-original","original",7,1,5,"Still readable in RAM.",true);ui_voice_draft(p);cJSON_Delete(p);work(sent);
    assert(!stored_present&&s.draft_recovery.store==PRO_RECOVERY_SAVE_FAILED);ui_set_connected(false);snapshot(&scene,dir,"save-failed");
    restart_device();assert(!draft.page.active);
    // Close supersedes a queued or already-running save. FIFO clear is final.
    reset();record("original",PRO_WORK_TASK);p=page("draft-original","original",7,1,5,"Queued save",true);ui_voice_draft(p);cJSON_Delete(p);
    action_t stale_save=sent;ht_draft_detach(&draft);dispatch(make_action(hit(A_DRAFT_DISCARD)));action_t clear=sent;
    work(stale_save);assert(save_calls==0);work(clear);assert(!stored_present&&!draft.page.active);
    reset();record("original",PRO_WORK_TASK);p=page("draft-original","original",7,1,5,"In-flight save",true);ui_voice_draft(p);cJSON_Delete(p);
    ht_draft_detach(&draft);save_hook=close_during_save;work(sent);save_hook=NULL;assert(stored_present&&s.draft_recovery.store==PRO_RECOVERY_CLEARING);
    clear=sent;work(clear);assert(!stored_present&&!draft.page.active);
    // A stale clear from a prior local lifetime cannot erase a new bookmark.
    record("original",PRO_WORK_GOAL);p=page("draft-new","original",1,1,1,"New message",true);ui_voice_draft(p);cJSON_Delete(p);work(sent);
    assert(stored_present);work(clear);assert(stored_present&&!strcmp(stored_bookmark.id,"draft-new"));
    ui_set_connected(false);snapshot(&scene,dir,"bookmark-current-copy");
    restart_device();snapshot(&scene,dir,"restart-empty-bookmark");
    act(A_DRAFT_DISCARD);assert(!stored_present&&mutations==0);
}
static const char *jstr(const cJSON *p,const char *key) {const cJSON *v=cJSON_GetObjectItemCaseSensitive(p,key);assert(cJSON_IsString(v));return v->valuestring;}
static void transcript(const char *path) {
    if(!path)return;FILE *f=fopen(path,"rb");assert(f);assert(fseek(f,0,SEEK_END)==0);long size=ftell(f);assert(size>0&&size<1024*1024);rewind(f);
    char *bytes=calloc((size_t)size+1,1);assert(bytes&&fread(bytes,1,(size_t)size,f)==(size_t)size);fclose(f);
    cJSON *root=cJSON_Parse(bytes);free(bytes);assert(root);const cJSON *events=cJSON_GetObjectItemCaseSensitive(root,"events");assert(cJSON_IsArray(events));
    reset();const cJSON *event;unsigned replies=0,moved=0;
    cJSON_ArrayForEach(event,events) {
        const char *type=jstr(event,"event");const cJSON *frame=cJSON_GetObjectItemCaseSensitive(event,"frame");
        if(!strcmp(type,"welcome"))reconnect(jstr(event,"machine"));
        else if(!strcmp(type,"record")) {
            const char *mode=jstr(event,"mode");record(jstr(event,"agent"),!strcmp(mode,"goal")?PRO_WORK_GOAL:!strcmp(mode,"loop")?PRO_WORK_LOOP:PRO_WORK_TASK);
            const cJSON *carried=cJSON_GetObjectItemCaseSensitive(event,"carry");
            if(carried) {COPY(s.carry_review.id,jstr(carried,"id"));COPY(s.carry_review.agent,jstr(event,"agent"));COPY(s.carry_review.name,jstr(carried,"name"));
                COPY(s.carry_review.source,jstr(carried,"source"));COPY(s.carry_review.excerpt,jstr(carried,"excerpt"));s.carry_review.rows=cJSON_GetObjectItemCaseSensitive(carried,"rows")->valueint;s.voice_carry=true;}
        } else if(!strcmp(type,"voice.draft")) {assert(frame);ui_voice_draft(frame);assert(draft.page.active&&!draft.read_only);work(sent);}
        else if(!strcmp(type,"disconnect")) {ui_set_connected(false);assert(draft.page.active&&draft.read_only);}
        else if(!strcmp(type,"command")) {
            const char *op=jstr(frame,"op"),*request=jstr(frame,"requestId");assert(!strncmp(request,"draft-",6));
            char *end;unsigned long next=strtoul(request+6,&end,10);assert(!*end&&next>0&&next<UINT32_MAX);draft.serial=(uint32_t)next-1;
            const cJSON *r=cJSON_GetObjectItemCaseSensitive(frame,"revision"),*d=cJSON_GetObjectItemCaseSensitive(frame,"delta");assert(r&&draft.page.revision==(uint32_t)r->valueint);
            assert(!strcmp(jstr(frame,"draftId"),draft.page.id));
            ht_draft_op_t operation=!strcmp(op,"state")?HT_DRAFT_STATE:!strcmp(op,"move")?HT_DRAFT_MOVE:HT_DRAFT_SEND;
            assert(operation!=HT_DRAFT_SEND||!draft.read_only);
            assert(ht_draft_command(&draft,operation,(uint32_t)r->valueint,d?d->valueint:0,now));work(sent);
            assert(wire.revision==next&&!strcmp(wire.text,op)&&!strcmp(wire.id,draft.page.id));if(operation==HT_DRAFT_MOVE)moved++;
        } else if(!strcmp(type,"draft.state")) {
            assert(frame&&draft.read_only&&draft.pending);char previous[512];COPY(previous,draft.page.text);
            ui_draft_state(frame);assert(!draft.pending&&draft.page.active&&draft.read_only&&!draft.page.can_send&&!draft.page.can_undo);
            if(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(frame,"active")))assert(!strcmp(previous,draft.page.text));replies++;
        } else if(!strcmp(type,"close")) {act(A_DRAFT_DISCARD);assert(!draft.page.active);}
        else assert(false);
    }
    assert(replies>=3&&moved>=2);cJSON_Delete(root);printf("Host transcript: PASS (%u exact JSON replies, %u native move commands)\n",replies,moved);
}
int main(int argc,char **argv) {
    test_recovery(argc>1&&argv[1][0]?argv[1]:NULL);test_failures(argc>1&&argv[1][0]?argv[1]:NULL);
    test_persistence(argc>1&&argv[1][0]?argv[1]:NULL);
    transcript(argc>2?argv[2]:NULL);
    printf("Pro recovery: PASS (actual source identity, callbacks, command worker, irreversible readonly, Task/Goal/Loop/Carry, five parts, stale/foreign/missing frames, local Close, native English, unchanged Unicode gate); recovery=%zu draft=%zu\n",sizeof(pro_draft_recovery_t),sizeof draft);
}
'''
with tempfile.TemporaryDirectory(prefix="harness-pro-draft-recovery-") as directory:
    build=Path(directory)
    (build/"recovery.c").write_text(code)
    subprocess.run([
        "cc","-std=c11","-Wall","-Wextra","-Werror","-O1","-g",
        "-fsanitize="+os.environ.get("SANITIZERS","undefined,bounds"),
        "-DHT_FACE_PX=720","-DDEVICE_PRO_COMPANION=1","-DHT_PANEL_NATIVE=1",
        "-I",str(NATIVE),"-I",str(JSON_DIR),str(build/"recovery.c"),str(JSON_DIR/"cJSON.c"),
        str(NATIVE/"../../cable_features.c"),str(NATIVE/"pro_canvas.c"),str(FONTS),str(NATIVE/"terminal.c"),str(NATIVE/"fonts.c"),
        *[str(NATIVE/(name+".c")) for name in ("draft","carry","visit","workspace","form","gestures")],
        "-o",str(build/"recovery")],check=True)
    destination=os.environ.get("HABITAT_PRO_PREVIEW_DIR","")
    if destination:Path(destination).mkdir(parents=True,exist_ok=True)
    args=[str(build/"recovery"),destination]
    if os.environ.get("HABITAT_RECOVERY_TRANSCRIPT"):args.append(os.environ["HABITAT_RECOVERY_TRANSCRIPT"])
    subprocess.run(args,check=True)
