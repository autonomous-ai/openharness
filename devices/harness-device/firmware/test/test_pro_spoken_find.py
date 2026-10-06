"""Spoken output Find through real Pro actions, audio worker and callbacks.

The inherited fixture counts individual queue/audio/transport boundaries; it
does not model FreeRTOS scheduling or record sound. Optional captured wire JSON
is parsed by the pinned SDK's cJSON before reaching the production callbacks.
"""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
fixture = HERE / "test_pro_carry_journey.py"
ns = {"__file__": str(fixture), "__name__": "spoken_find_fixture"}
exec(compile(fixture.read_text().split(
    'with tempfile.TemporaryDirectory(prefix="harness-pro-carry-journey-")'
)[0], str(fixture), "exec"), ns)
code, function, cases = ns["code"], ns["function"], ns["cases"]
NATIVE, FONTS, SOURCE = ns["NATIVE"], ns["FONTS"], ns["SOURCE"]
code = code.replace("int main(int argc,char **argv)", "void carry_prior_main(int argc,char **argv)")
code = code.replace(
    'static void audio_client_start_search(const char *a,const char *b,unsigned r){(void)a;(void)b;(void)r;assert(false);}',
    'static void audio_client_start_search(const char *a,const char *b,unsigned r){assert(a[0]&&b[0]&&r);starts++;recording=true;COPY(audio_agent,a);COPY(audio_carry,b);}')
code = code.replace("static unsigned selections;", 'static unsigned selections; static int selection_delta; static char selection_op[16];')
code = code.replace('assert(op[0]);(void)delta;(void)extend;', 'assert(op[0]);selection_delta=delta;COPY(selection_op,op);(void)extend;')
needle = "static void dispatch(action_t a) { if(s.locked)return;switch(a.kind) {\n"
code = code.replace(needle, needle + cases("A_SELECT_FIND", "A_VOICE"))
code += function("ui_voice_search") + function("ui_voice_error")
code += r'''
static unsigned search_checks;
static void select_begin(void) {
    fresh(true); COPY(s.agents[0].engine,"terminal");
    view(LAUNCHER);act(A_READER,0);act(A_SELECT_BEGIN,1);journey_worker(sent);selection_reply();
    assert(ht_selection_ready(&selection)&&pro_selection_owned()&&visit.available);
}
static void search_start(void) {
    act(A_SELECT_FIND,0);assert(sent.kind==A_VOICE&&sent.value==7&&s.voice_start_pending);
    journey_worker(sent);assert(recording&&s.voice_search&&!s.voice_review);
    act(A_VOICE_STOP,0);assert(!recording&&s.voice_waiting&&!review_requested);
}
static void result(bool voice,const char *query,int match,int matches,const char *excerpt,int rows,bool extending) {
    char id[48],agent[48],request[48];COPY(id,selection.id);COPY(agent,selection.agent);
    snprintf(request,sizeof request,"pick-%lu",(unsigned long)selection.request);
    cJSON fields[]={{.string="requestId",.type=JSTRING,.valuestring=request},
        {.string="selectionId",.type=JSTRING,.valuestring=id},
        {.string="agentId",.type=JSTRING,.valuestring=agent},{.string="ok",.type=JTRUE},
        number("revision",(int)selection.revision+1),number("rows",rows),
        {.string="excerpt",.type=JSTRING,.valuestring=excerpt},
        {.string="extending",.type=extending?JTRUE:0},
        {.string="query",.type=JSTRING,.valuestring=query},number("match",match),number("matches",matches)};
    cJSON p=object(fields,query?11:8);if(voice)ui_voice_search(&p);else ui_selection_state(&p);
}
static void search_render(const char *dir,const char *name) {
    ht_scene_t f;s.hit_count=0;ht_scene_clear(&f,BG);pro_selection(&f);assert(f.count<HT_RUNS);portrait(&f,dir,name);
}
static void journey(const char *dir) {
    select_begin();search_start();result(true,"cache [ready]",1,3,"cache [ready] first",1,false);
    assert(s.view==SELECTION&&!s.voice_open&&selection.match==1&&selection.matches==3&&visit.available);
    search_render(dir,"find-first-match");assert(controls(A_SELECT_MATCH)==2);search_checks++;
    // Incoming later result text cannot rewrite the selected host snapshot.
    COPY(s.agents[0].full,"New output arrived after this search.");
    assert(!strcmp(selection.excerpt,"cache [ready] first"));search_checks++;
    selection.remainder=59;act(A_SELECT_MATCH,1);assert(selection.pending);journey_worker(sent);
    assert(!strcmp(selection_op,"match")&&selection_delta==1);
    result(false,"cache [ready]",2,4,"CACHE [READY] second",1,false);
    assert(selection.match==2&&selection.matches==4);search_checks++;
    act(A_SELECT_MATCH,-1);journey_worker(sent);assert(selection_delta==-1);
    result(false,"cache [ready]",1,4,"cache [ready] first",1,false);search_checks++;
    action_t old=make_action(hit(A_SELECT_MATCH,1));act(A_SELECT_MATCH,1);journey_worker(sent);
    result(false,"cache [ready]",2,4,"CACHE [READY] second",1,false);
    unsigned before=enqueued;dispatch(old);assert(enqueued==before&&!selection.pending);search_checks++;
    act(A_SELECT_EXTEND,0);journey_worker(sent);assert(!strcmp(selection_op,"lines"));
    result(false,NULL,0,0,"CACHE [READY] second",1,false);
    assert(!selection.query[0]&&!selection.extending);search_render(dir,"find-by-line");search_checks++;
    act(A_SELECT_EXTEND,0);journey_worker(sent);assert(!strcmp(selection_op,"extend"));
    result(false,NULL,0,0,"CACHE [READY] second",1,true);
    ht_selection_move(&selection,40,now);journey_worker(sent);assert(!strcmp(selection_op,"step")&&selection_delta==2);
    result(false,NULL,0,0,"CACHE [READY] second\nKeep this context.\nAnd this line.",3,true);
    search_render(dir,"find-range");assert(selection.rows==3&&selection.extending);search_checks++;
    act(A_CARRY,0);assert(carry.pending);journey_worker(sent);assert(carry_wires==1&&!draft_wires);
    carry_reply();assert(carry.active&&s.view==AGENTS&&s.carry_route.choosing&&!selection.active&&visit.available);search_checks++;
}
static void none_retry_cancel(const char *dir) {
    select_begin();search_start();result(true,"missing phrase",0,0,"",0,false);
    assert(ht_selection_ready(&selection)&&!selection.rows&&!selection.excerpt[0]);
    search_render(dir,"find-no-matches");assert(!controls(A_SELECT_MATCH)&&controls(A_SELECT_FIND)==1&&!controls(A_CARRY));
    assert(!controls(A_SELECT_EXTEND));search_checks++;
    search_start();result(true,"cache [ready]",1,1,"cache [ready] retry",1,false);
    assert(selection.matches==1&&ht_selection_ready(&selection));search_checks++;
    char id[48];COPY(id,selection.id);search_start();act(A_VOICE_ABORT,0);journey_worker(sent);
    assert(s.view==HOME&&!selection.active&&!s.voice_open&&visit.available&&!carry_wires&&!draft_wires);search_checks++;
    result(true,"late cancelled phrase",1,1,"late",1,false);assert(!selection.active&&s.view==HOME);search_checks++;
    select_begin();search_start();ui_voice_error("Say the phrase again");
    assert(s.view==SELECTION&&!s.voice_open&&selection.error[0]&&!pro_selection_owned());
    search_render(dir,"find-retry");COPY(id,selection.id);act(A_SELECT_BEGIN,0);
    assert(selection.pending&&strcmp(id,selection.id)&&pro_selection_owned()&&!selection.query[0]);search_checks++;
}
static void ownership(void) {
    for(int stage=0;stage<3;stage++)for(int cause=0;cause<4;cause++) {
        select_begin();action_t a=make_action(hit(A_SELECT_FIND,0));
        if(stage){dispatch(a);a=sent;assert(s.voice_start_pending);}
        if(stage==2){journey_worker(a);act(A_VOICE_STOP,0);assert(s.voice_waiting);}
        unsigned before=starts;
        if(cause==0){ui_focus_project("build");ui_focus_project("design");}
        if(cause==1){ui_focus_project("unknown");ui_focus_project("design");}
        if(cause==2)ui_draft_source("other-host");
        if(cause==3)ui_set_connected(false);
        if(stage==0)dispatch(a);
        else if(stage==1)journey_worker(a);
        else result(true,"cache [ready]",1,3,"late wrong-owner",1,false);
        assert(starts==before&&!s.voice_open&&!carry_wires&&!draft_wires);search_checks++;
    }
    select_begin();result(false,"cache [ready]",1,3,"cache [ready]",1,false);
    // A stale control may not fall through to a replacement selection.
    action_t a=make_action(hit(A_SELECT_EXTEND,0));selection.revision++;unsigned before=enqueued;
    dispatch(a);assert(enqueued==before);search_checks++;
    select_begin();search_start();result(true,"cache [ready]",1,3,"cache [ready]",1,false);
    a=make_action(hit(A_SELECT_MATCH,1));ui_focus_project("build");ui_focus_project("design");
    before=enqueued;dispatch(a);assert(enqueued==before&&!selection.pending);search_checks++;
}
int main(int argc,char **argv) {
    const char *dir=argc>1?argv[1]:NULL;journey(dir);none_retry_cancel(dir);ownership();
    printf("Pro spoken Find: PASS (%u production action/worker/callback cases; counted queue/audio boundaries)\n",search_checks);
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-spoken-find-") as directory:
    build = Path(directory)
    (build / "spoken_find.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "spoken_find.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        *[str(NATIVE / (name + ".c")) for name in ("visit", "carry", "workspace", "form", "draft", "selection", "gestures")],
        "-o", str(build / "spoken_find"),
    ], check=True)
    args = [str(build / "spoken_find")]
    if os.environ.get("HABITAT_PRO_PREVIEW_DIR"):
        destination = Path(os.environ["HABITAT_PRO_PREVIEW_DIR"])
        destination.mkdir(parents=True, exist_ok=True)
        args.append(str(destination))
    subprocess.run(args, check=True)
