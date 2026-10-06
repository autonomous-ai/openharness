"""Carry recipient journey through production actions, workers and callbacks.

Uses the shared real UI fixture. Audio, NVS and cable writes are counted local
boundaries; no physical recording, terminal input or host bookmark is simulated.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
fixture = HERE / "test_pro_app_interactions.py"
ns = {"__file__": str(fixture), "__name__": "carry_journey_fixture"}
exec(compile(fixture.read_text().split(
    'with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-")'
)[0], str(fixture), "exec"), ns)
code, function, cases = ns["code"], ns["function"], ns["cases"]
NATIVE, FONTS, SOURCE, SHEETS = ns["NATIVE"], ns["FONTS"], ns["SOURCE"], ns["SHEETS"]
code = code.replace("Build / reading line 42", "Reading Design")
code = code.replace("The original pane was closed.", "That pane is unavailable.")
code = code.replace("static action_t sent,transport;", "static action_t sent,transport,captured_open;")
code = code.replace("sent=a;enqueued++;", "sent=a;if(a.kind==A_CARRY_OPEN)captured_open=a;enqueued++;")
code = code.replace("int main(int argc,char **argv)", "void prior_main(int argc,char **argv)")
code = code.replace("int type; double valuedouble;", "int type,valueint; double valuedouble;")
code = code.replace("static void view(view_t v) { input_cancel();s.view=v;s.offset=0; }",
                    "static void pro_voice_sample_stop(void) {}\n" + function("view"))
code = code.replace("static void voice_close(void) { s.voice_open=s.voice_waiting=s.voice_start_pending=false; }", function("voice_close"))
code = code.replace("static bool audio_client_active(void) { return false; }", r'''
static bool recording,review_requested;
static unsigned starts,stops,carry_wires,visit_wires,plain_opens,draft_wires,save_calls,clear_calls;
static char audio_agent[48],audio_carry[48],last_visit[48],last_op[16],last_agent[48];
enum {VOICE_CMD_NONE,VOICE_CMD_GOAL,VOICE_CMD_LOOP};
static bool audio_client_active(void) { return recording; }
static bool audio_client_recording(void) { return recording; }
static void audio_client_stop(void) { recording=false;stops++; }
static void audio_client_request_review(void) { review_requested=true; }
static void audio_client_copy_upload_id(char *out,size_t cap) { snprintf(out,cap,"fixture-upload"); }
static void audio_client_start_carry(const char *agent,const char *id) {
    starts++;recording=true;review_requested=false;COPY(audio_agent,agent);COPY(audio_carry,id);
}
static void audio_client_start_draft(const char *id,unsigned revision,bool append) {
    assert(!strcmp(id,draft.page.id)&&revision==draft.page.revision);(void)append;starts++;recording=true;review_requested=false;
}
static void audio_client_start_search(const char *a,const char *b,unsigned r){(void)a;(void)b;(void)r;assert(false);}
static void audio_client_start_question(const char *a,const char *b,unsigned r){(void)a;(void)b;(void)r;assert(false);}
static void audio_client_start_form(const char *a,unsigned r){(void)a;(void)r;assert(false);}
static void audio_client_start_selection(const char *a,const char *b,unsigned r){(void)a;(void)b;(void)r;assert(false);}
static void audio_client_start_cable(const char *a,int c){(void)a;(void)c;assert(false);}
static void cable_client_voice_cancel(const char *id){assert(id[0]);}
static bool config_save_pro_recovery(const pro_recovery_bookmark_t *b){save_calls++;return pro_recovery_bookmark_valid(b);}
static bool config_clear_pro_recovery(void){clear_calls++;return true;}
static void cable_client_carry(const char *id,const char *agent,const char *selection_id,uint32_t request,uint32_t revision,bool cancel){
    assert(id[0]);if(cancel)return;assert(agent[0]&&selection_id[0]&&request&&revision);carry_wires++;
}
static void cable_client_visit(const char *id,uint32_t request,const char *op,const char *agent){
    assert(id[0]&&request);visit_wires++;COPY(last_visit,id);COPY(last_op,op);COPY(last_agent,agent);
}
static void cable_client_send_open(const char *id,const char *unused){(void)unused;assert(id[0]);plain_opens++;COPY(last_agent,id);}
static void cable_client_draft(const char *id,const char *op,uint32_t request,uint32_t revision,int delta){
    assert(id[0]&&request&&revision);(void)delta;draft_wires++;COPY(last_op,op);
}
''')
code = code.replace("static void audio_client_abort(void) {}", "static void audio_client_abort(void) {recording=false;}")
code = code.replace('assert(!strcmp(op,"begin")||!strcmp(op,"cancel"));', 'assert(op[0]);')
extra = "#define DRAFT_ROWS 6\n" + "\n".join(re.findall(r"^#define TAB_\w+ \d+$", SOURCE, re.M)) + "\n" + function("is_question")
for name in ("pro_work_available", "pro_work_capture_available", "pro_work_draft_available",
             "pro_send_feedback_matches", "pro_send_feedback_begin", "pro_send_feedback_text",
             "draft_emit", "pro_draft_forget", "pro_draft_store_queue", "pro_draft_store_work",
             "ui_draft_source", "selection_search_fields", "ui_selection_state", "ui_carry_state",
             "draft_page", "ui_voice_draft", "ui_draft_state"):
    extra += function(name)
code = code.replace("static void dispatch(action_t a) { if(s.locked)return;switch(a.kind) {\n",
                    extra + "static void dispatch(action_t a) { if(s.locked)return;switch(a.kind) {\n" +
                    cases("A_DRAFT_EDIT", "A_HOME") + cases("A_HOME", "A_READER") + cases("A_VOICE_STOP", "A_PET"))
worker = SOURCE.split("static void worker(", 1)[1]
code += "static void journey_worker(action_t a) { switch(a.kind) {\n"
code += cases("A_DRAFT_COMMAND", "A_FORM_SEND", worker, "        ")
code += cases("A_VISIT_SEND", "A_SELECT_SEND", worker, "        ")
code += cases("A_VOICE", "A_STOP_YES", worker, "        ")
code += "case A_DRAFT_STORE:pro_draft_store_work(a);break;default:work(a);break;}}\n"
for name in ("pro_pager", "pro_clamp_list", "pro_row", "pro_map_rect", "pro_map_ready", "pro_map_focusable",
             "pro_map_prefers_list", "pro_map_unlisted", "pro_agent_map", "pro_agents", "pro_draft", "pro_carry_preview", "pro_message"):
    code += function(name, SHEETS)
code += r'''
static unsigned checks;
static void fresh(bool bookmarked) {
    reset();s.notice_count=0;s.view=HOME;now=1000;recording=review_requested=false;
    starts=stops=carry_wires=visit_wires=plain_opens=draft_wires=save_calls=clear_calls=0;
    pro_draft_recovery_source(&s.draft_recovery,"fixture-host");pro_reader_focus("design");
    for(int i=0;i<s.count;i++){COPY(s.agents[i].machine_id,"fixture-host");COPY(s.agents[i].engine,"claude");COPY(s.agents[i].session,i?"session-build":"session-design");}
    if(bookmarked){assert(ht_visit_latest(&visit,"visit-preserved","design",now,visit_emit,NULL));assert(ht_visit_reply(&visit,visit.id,visit.request,true,true,"Reading Design"));}
}
static cJSON number(const char *key,int n){return(cJSON){.string=key,.type=JNUMBER,.valueint=n,.valuedouble=n};}
static void selection_reply(void) {
    char request[48];snprintf(request,sizeof request,"pick-%lu",(unsigned long)selection.request);
    cJSON fields[]={{.string="requestId",.type=JSTRING,.valuestring=request},
        {.string="selectionId",.type=JSTRING,.valuestring=selection.id},{.string="ok",.type=JTRUE},
        number("revision",1),number("rows",3),{.string="excerpt",.type=JSTRING,.valuestring="Keep the title short.\nShow the chosen pane.\nLeave room for the words."}};
    cJSON reply=object(fields,6);ui_selection_state(&reply);
}
static void carry_reply(void) {
    char request[48];snprintf(request,sizeof request,"carry-%lu",(unsigned long)carry.request);
    cJSON fields[]={{.string="requestId",.type=JSTRING,.valuestring=request},
        {.string="carryId",.type=JSTRING,.valuestring=carry.id},{.string="ok",.type=JTRUE},
        {.string="sourceName",.type=JSTRING,.valuestring="Design"},number("rows",3),number("ttlMs",300000),
        {.string="excerpt",.type=JSTRING,.valuestring="Keep the title short. Show the chosen pane. Leave room for the words."}};
    cJSON reply=object(fields,7);ui_carry_state(&reply);
}
static void prepare(bool bookmarked) {
    fresh(bookmarked);view(LAUNCHER);act(A_READER,0);act(A_SELECT_BEGIN,1);
    assert(selection.pending&&pro_selection_owned());journey_worker(sent);assert(selections==1);
    selection_reply();assert(ht_selection_ready(&selection));act(A_CARRY,0);
    assert(carry.pending&&sent.kind==A_CARRY_SEND);journey_worker(sent);assert(carry_wires==1);
    carry_reply();assert(carry.active&&s.carry_route.choosing&&s.view==AGENTS&&!selection.active);
    assert(!starts&&!plain_opens&&!visit_wires&&visit.available==bookmarked&&!form.pending);
}
static void chooser_render(const char *dir,const char *name) {
    ht_scene_t f;s.hit_count=0;ht_scene_clear(&f,BG);pro_agents(&f);assert(f.count<HT_RUNS);
    assert(text_has(&f,"Choose a pane")&&text_has(&f,"From Design"));
    assert(!controls(A_FIND)&&!controls(A_TABS)&&!controls(A_AGENT));
    assert(controls(A_CARRY_TARGET)>0);portrait(&f,dir,name);
}
static void draft_reply(bool inactive,bool ok,bool sent_receipt) {
    char request[48],id[48],carried[48];COPY(id,draft.page.id[0]?draft.page.id:"carry-draft");COPY(carried,s.carry_review.id);
    snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);
    cJSON fields[]={{.string="requestId",.type=JSTRING,.valuestring=request},
        {.string="id",.type=JSTRING,.valuestring=id},number("revision",draft.page.revision?draft.page.revision:1),
        {.string="active",.type=inactive?0:JTRUE},{.string="ok",.type=ok?JTRUE:0},
        {.string="agentId",.type=JSTRING,.valuestring=s.carry_review.agent},
        {.string="name",.type=JSTRING,.valuestring="Build"},number("position",1),number("total",1),
        {.string="text",.type=JSTRING,.valuestring="Apply these three design notes. Keep the explanation brief."},
        {.string="canSend",.type=JTRUE},{.string="carryId",.type=JSTRING,.valuestring=carried},
        {.string="sent",.type=sent_receipt?JTRUE:0}};
    cJSON receipt[]={fields[0],fields[1],fields[2],fields[3],fields[4],fields[11],fields[12]};
    cJSON reply=inactive?object(receipt,7):object(fields,11);if(s.voice_waiting)ui_voice_draft(&reply);else ui_draft_state(&reply);
}
static void end_to_end(const char *dir) {
    prepare(true);chooser_render(dir,"carry-choose-list");
    s.tile_count=2;COPY(s.tile_tab,"workspace");COPY(s.selected_tab,"workspace");
    for(int i=0;i<2;i++){COPY(s.tiles[i].agent_id,s.agents[i].id);s.tiles[i].x1=i*500;s.tiles[i].y1=0;s.tiles[i].x2=(i+1)*500;s.tiles[i].y2=1000;}
    s.pro_agent_layout=2;chooser_render(dir,"carry-choose-map");
    char tray[48];COPY(tray,carry.id);unsigned queued=enqueued;
    act(A_CARRY_TARGET,0);assert(s.view==HOME&&visit.available&&!visit.pending&&enqueued==queued&&!starts);checks++;
    act(A_CARRY_CHOOSE,0);assert(s.view==AGENTS);act(A_HOME,0);assert(carry.active&&visit.available&&!visit.pending&&enqueued==queued);checks++;
    act(A_CARRY_CHOOSE,0);act(A_CARRY_TARGET,1);assert(visit.pending&&!strcmp(visit.id,"visit-preserved")&&sent.kind==A_CARRY_OPEN);
    action_t open=sent;journey_worker(open);assert(visit_wires==1&&!strcmp(last_agent,"build")&&!strcmp(last_op,"open"));
    ui_focus_project("build");assert(visit.pending&&s.carry_route.navigating&&!s.carry_route.interrupted&&!starts);
    visit_reply("build",true,true,NULL);assert(s.view==HOME&&s.active==1&&visit.available&&!s.carry_route.navigating&&!starts);checks++;
    // Live source/name updates cannot rewrite the frozen quote or chooser source.
    COPY(s.agents[0].name,"Renamed source");COPY(s.agents[0].full,"A later result");assert(!strcmp(carry.source,"Design"));
    action_t voice=make_action(hit(A_PET,0));voice.kind=A_VOICE;dispatch(voice);assert(s.voice_open&&s.voice_start_pending&&!starts);journey_worker(sent);
    assert(starts==1&&recording&&review_requested&&!strcmp(audio_agent,"build")&&!strcmp(audio_carry,tray));checks++;
    act(A_VOICE_STOP,0);assert(s.voice_waiting&&stops==1&&!draft_wires);draft_reply(false,true,false);
    assert(s.view==DRAFT&&pro_carry_review_owns(&s.carry_review,&draft.page)&&!strcmp(draft.page.agent,"build"));
    journey_worker(sent);assert(save_calls==1);ht_scene_t f;s.hit_count=0;ht_scene_clear(&f,BG);pro_draft(&f);portrait(&f,dir,"carry-reviewed-message");
    act(A_CARRY_PREVIEW,0);s.hit_count=0;ht_scene_clear(&f,BG);pro_carry_preview(&f);portrait(&f,dir,"carry-passage-preview");act(A_DRAFT_BACK,0);
    assert(!draft_wires);act(A_DRAFT_SEND,0);journey_worker(sent);assert(draft_wires==1&&!strcmp(last_op,"send"));
    draft_reply(true,true,true);assert(draft.page.active);journey_worker(sent);
    assert(!draft.page.active&&!carry.active&&clear_calls==1&&s.view==HOME&&visit.available);assert(pro_send_feedback_text(now));checks++;
    act(A_RETURN,0);s.hit_count=0;ht_scene_clear(&f,BG);pro_message(&f);portrait(&f,dir,"carry-returning");journey_worker(sent);assert(!strcmp(last_op,"back")&&!strcmp(last_visit,"visit-preserved")&&!strcmp(last_agent,"build"));
    visit_reply("design",true,false,NULL);assert(s.view==HOME&&s.active==0&&!visit.available);checks++;
}
static void refusals_and_identity(const char *dir) {
    for(int stage=0;stage<2;stage++)for(int mutation=0;mutation<8;mutation++) {
        prepare(true);action_t target=make_action(hit(A_CARRY_TARGET,1));
        if(stage){dispatch(target);target=sent;assert(visit.pending);}
        if(mutation==0)now=carry.deadline;
        if(mutation==1)COPY(carry.id,"replaced-carry");
        if(mutation==2)ui_set_connected(false);
        if(mutation==3)ui_draft_source("other-host");
        if(mutation==4)COPY(s.agents[1].session,"replacement-session");
        if(mutation==5)COPY(s.agents[1].machine_id,"other-machine");
        if(mutation==6)COPY(s.agents[1].engine,"other-engine");
        if(mutation==7){ui_focus_project("unknown");ui_focus_project("design");}
        unsigned before=visit_wires;if(stage)journey_worker(target);else dispatch(target);
        assert(visit_wires==before&&!plain_opens&&!starts);checks++;
    }
    prepare(true);action_t stale=make_action(hit(A_CARRY_TARGET,1));act(A_HOME,0);dispatch(stale);
    assert(s.view==HOME&&s.active==0&&visit.available&&!visit.pending);checks++;
    prepare(true);congested=true;act(A_CARRY_TARGET,1);assert(!visit.pending&&visit.available&&!s.carry_route.navigating);checks++;
    prepare(true);act(A_CARRY_TARGET,1);journey_worker(sent);visit_reply("design",true,true,NULL);
    assert(visit.pending&&s.active==0);visit_reply("build",false,true,NULL);
    assert(visit.available&&!visit.pending&&!strcmp(visit.agent,"design")&&!s.carry_route.navigating);
    ht_scene_t error_scene;s.hit_count=0;ht_scene_clear(&error_scene,BG);pro_message(&error_scene);portrait(&error_scene,dir,"carry-visit-refused");checks++;
    // Chosen origin: the host restores the old place and ends the detour.
    prepare(true);act(A_CARRY_TARGET,1);journey_worker(sent);ui_focus_project("build");visit_reply("build",true,false,NULL);
    assert(s.active==1&&s.view==HOME&&!visit.available&&!visit.pending&&carry.active);checks++;
    prepare(true);act(A_CARRY_TARGET,1);journey_worker(sent);ui_focus_project("unknown");ui_focus_project("design");
    visit_reply("build",true,true,NULL);assert(s.active==0&&!visit.available&&!s.carry_route.navigating&&!starts);checks++;
    prepare(false);act(A_CARRY_TARGET,1);assert(visit.pending&&visit.id[0]);journey_worker(sent);visit_reply("build",true,true,NULL);
    assert(visit.available&&s.active==1&&!starts);checks++;
    prepare(true);features&=~CABLE_FEATURE_VISIT;act(A_CARRY_TARGET,1);assert(!visit.available&&captured_open.kind==A_CARRY_OPEN&&!captured_open.value);
    journey_worker(captured_open);assert(plain_opens==1&&!visit_wires);ui_focus_project("build");assert(s.view==HOME&&s.active==1&&!visit.available&&!starts);checks++;
    // A queued Select or Carry cannot cross an observed focus change.
    fresh(true);view(LAUNCHER);act(A_READER,0);act(A_SELECT_BEGIN,1);action_t select=sent;
    ui_focus_project("build");journey_worker(select);assert(!selections&&!carry_wires);checks++;
    fresh(true);view(LAUNCHER);act(A_READER,0);act(A_SELECT_BEGIN,1);journey_worker(sent);selection_reply();act(A_CARRY,0);action_t pending=sent;
    ui_focus_project("build");journey_worker(pending);assert(!carry_wires&&!carry.pending&&!carry.active);checks++;
}
int main(int argc,char **argv) {
    const char *dir=argc>1?argv[1]:NULL;end_to_end(dir);refusals_and_identity(dir);
    printf("Pro Carry journey: PASS (%u actual-handler/worker/callback cases; no physical audio, terminal input or host bookmark claim)\n",checks);
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-carry-journey-") as directory:
    build = Path(directory)
    (build / "carry_journey.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "carry_journey.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        *[str(NATIVE / (name + ".c")) for name in ("visit", "carry", "workspace", "form", "draft", "selection", "gestures")],
        "-o", str(build / "carry_journey"),
    ], check=True)
    args = [str(build / "carry_journey")]
    if os.environ.get("HABITAT_PRO_PREVIEW_DIR"):
        destination = Path(os.environ["HABITAT_PRO_PREVIEW_DIR"])
        destination.mkdir(parents=True, exist_ok=True)
        args.append(str(destination))
    subprocess.run(args, check=True)
