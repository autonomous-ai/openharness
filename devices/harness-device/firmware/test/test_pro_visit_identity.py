"""Pro Return survives a refused detour using actual UI and queued worker code.

The existing app fixture supplies production state and callbacks. This adds the
actual A_VISIT_SEND worker and a counted cable boundary. It does not open a real
app, send terminal input, or simulate a successful host bookmark with local UI
state: every commit requires a correlated visit.state callback.
"""
from pathlib import Path
import os
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
fixture = HERE / "test_pro_app_interactions.py"
ns = {"__file__": str(fixture), "__name__": "pro_visit_identity_fixture"}
exec(compile(fixture.read_text().split(
    'with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-")'
)[0], str(fixture), "exec"), ns)
code, cases = ns["code"], ns["cases"]
NATIVE, SOURCE, FONTS = ns["NATIVE"], ns["SOURCE"], ns["FONTS"]
code = code.replace("int main(int argc,char **argv)", "void prior_main(int argc,char **argv)")
code += r'''
static unsigned wires,checks;
static char wire_id[48],wire_agent[64],wire_op[16];
static uint32_t wire_request;
static void cable_client_visit(const char *id,uint32_t request,const char *op,const char *agent) {
    wires++;COPY(wire_id,id);COPY(wire_agent,agent);COPY(wire_op,op);wire_request=request;
}
'''
worker = SOURCE.split("static void worker(", 1)[1]
code += "static void visit_worker(action_t a) { switch(a.kind) {\n"
code += cases("A_VISIT_SEND", "A_SELECT_SEND", worker, "        ")
code += "default:assert(false);}}\n"
code += r'''
static void fresh(void) {
    reset();s.view=HOME;s.notice_count=0;now=1000;wires=0;
    COPY(s.agents[2].id,"research");COPY(s.agents[2].name,"Research");s.count=3;
}
static void reply_as(const char *id,uint32_t request,const char *agent,bool ok,bool available,const char *label) {
    char serial[32];snprintf(serial,sizeof serial,"visit-%lu",(unsigned long)request);
    cJSON fields[]={{.string="requestId",.type=JSTRING,.valuestring=serial},
        {.string="visitId",.type=JSTRING,.valuestring=id},
        {.string="agentId",.type=agent?JSTRING:0,.valuestring=agent},
        {.string="ok",.type=ok?JTRUE:0},{.string="active",.type=available?JTRUE:0},
        {.string="label",.type=label?JSTRING:0,.valuestring=label},
        {.string="error",.type=JSTRING,.valuestring="Close the picker and return to the terminal."}};
    cJSON frame=object(fields,7);ui_visit_state(&frame);
}
static void reply(const char *agent,bool ok,bool available,const char *label) {
    char id[48];COPY(id,visit.id);reply_as(id,visit.request,agent,ok,available,label);
}
static action_t opening(const char *agent) {
    unsigned queued=enqueued;pro_open_in_app(agent);
    assert(visit.pending&&enqueued==queued+1&&sent.kind==A_VISIT_SEND);
    assert(!strcmp(visit.pending_agent,agent)&&!strcmp(sent.id,agent));return sent;
}
static void settle_on_build(void) {
    fresh();action_t first=opening("build");
    assert(!visit.agent[0]&&!visit.available);visit_worker(first);
    assert(wires==1&&!strcmp(wire_agent,"build")&&!strcmp(wire_op,"open"));
    reply("build",true,true,"Design / reading line 42");
    assert(visit.available&&!visit.pending&&!strcmp(visit.agent,"build")&&!visit.pending_agent[0]);
    assert(s.active==1&&!strcmp(visit.label,"Design / reading line 42"));checks++;
}
static action_t returning(void) {
    unsigned queued=enqueued;act(A_RETURN,0);
    assert(visit.pending&&enqueued==queued+1&&sent.kind==A_VISIT_SEND&&sent.value==HT_VISIT_BACK);
    return sent;
}
static void refusal_preserves_return(void) {
    const char *error_labels[]={NULL,"","Incorrect replacement label"};
    for(unsigned i=0;i<3;i++) {
        settle_on_build();char original[48];COPY(original,visit.id);
        action_t second=opening("research");
        assert(!strcmp(visit.agent,"build"));visit_worker(second);
        assert(wires==2&&!strcmp(wire_agent,"research"));
        reply(NULL,false,true,error_labels[i]);
        assert(visit.available&&!visit.pending&&!strcmp(visit.agent,"build")&&!visit.pending_agent[0]);
        assert(!strcmp(visit.id,original)&&!strcmp(visit.label,"Design / reading line 42"));
        assert(s.active==1&&s.view==MESSAGE);
        unsigned queued=enqueued;ui_focus_project("build");
        assert(visit.available&&enqueued==queued&&s.active==1);checks++;
        // A stale queued second Open must not be sent after its refusal.
        visit_worker(second);assert(wires==2);checks++;
        action_t back=returning();visit_worker(back);
        assert(wires==3&&!strcmp(wire_id,original)&&!strcmp(wire_agent,"build")&&!strcmp(wire_op,"back"));
        reply("design",true,false,NULL);
        assert(s.active==0&&s.view==HOME&&!visit.available&&!visit.pending&&!visit.id[0]);
        assert(!visit.agent[0]&&!visit.pending_agent[0]&&!visit.label[0]);checks++;
    }
}
static void only_correlated_success_commits(void) {
    settle_on_build();action_t second=opening("research");
    char id[48];COPY(id,visit.id);
    reply_as("wrong-visit",visit.request,"research",true,true,"wrong");
    reply_as(id,visit.request-1,"research",true,true,"wrong");
    assert(visit.pending&&!strcmp(visit.agent,"build")&&!strcmp(visit.pending_agent,"research"));checks++;
    // Even a correlated successful receipt must name the requested Open pane.
    reply("design",true,true,"wrong");
    assert(visit.pending&&s.active==1&&!strcmp(visit.agent,"build"));checks++;
    visit_worker(second);assert(wires==2&&!strcmp(wire_agent,"research")&&wire_request==second.revision);
    reply("research",true,true,"Design / reading line 42");
    assert(s.active==2&&!strcmp(visit.agent,"research")&&!visit.pending_agent[0]);
    ui_focus_project("research");assert(visit.available);checks++;
    // A different ordinary focus still ends Return deliberately.
    ui_focus_project("build");assert(!visit.available&&sent.value==HT_VISIT_CANCEL);checks++;
}
static void refused_return_can_retry(void) {
    settle_on_build();action_t back=returning();visit_worker(back);
    reply(NULL,false,true,NULL);
    assert(visit.available&&!visit.pending&&!strcmp(visit.agent,"build"));
    assert(!strcmp(visit.label,"Design / reading line 42"));ui_focus_project("build");
    assert(visit.available);checks++;
    action_t next=returning();unsigned count=wires;visit_worker(back);assert(wires==count);
    visit_worker(next);assert(wires==count+1&&!strcmp(wire_op,"back"));
    reply("design",true,false,NULL);assert(!visit.available&&s.active==0);checks++;
}
static void failed_emit_and_timeout(void) {
    settle_on_build();unsigned queued=enqueued;congested=true;pro_open_in_app("research");
    assert(enqueued==queued&&!visit.pending&&visit.available&&!strcmp(visit.agent,"build"));
    assert(!visit.pending_agent[0]&&!strcmp(visit.label,"Design / reading line 42"));
    ui_focus_project("build");assert(visit.available);congested=false;checks++;
    action_t back=returning();visit_worker(back);reply("design",true,false,NULL);
    assert(!visit.available&&s.active==0);checks++;

    settle_on_build();action_t second=opening("research");char id[48];COPY(id,visit.id);
    assert(!ht_visit_tick(&visit,visit.deadline-1));
    assert(ht_visit_tick(&visit,visit.deadline));
    assert(!visit.available&&!visit.pending&&!visit.agent[0]&&!visit.pending_agent[0]);
    action_t cancel=sent;assert(cancel.value==HT_VISIT_CANCEL);unsigned count=wires;
    visit_worker(second);assert(wires==count);visit_worker(cancel);assert(wires==count+1&&!strcmp(wire_op,"cancel"));
    reply_as(id,second.revision,"research",true,true,"late");assert(!visit.available&&s.active==1);checks++;
    // A late receipt for a previous visit cannot consume a newly pending Open.
    action_t next=opening("design");reply_as(id,second.revision,NULL,false,true,"old");
    assert(visit.pending&&visit.request==next.revision&&!strcmp(visit.pending_agent,"design"));
    visit_worker(next);reply("design",true,true,"New reading");
    assert(visit.available&&!strcmp(visit.agent,"design")&&!strcmp(visit.label,"New reading"));checks++;
}
static void unavailable_never_invents_bookmark(void) {
    fresh();action_t first=opening("build");visit_worker(first);reply(NULL,false,true,"unconfirmed");
    assert(!visit.available&&!visit.id[0]&&!visit.agent[0]&&!visit.pending_agent[0]&&!visit.label[0]);checks++;
    settle_on_build();opening("research");reply(NULL,false,false,"ended");
    assert(!visit.available&&!visit.pending&&!visit.agent[0]&&!visit.pending_agent[0]);checks++;
    settle_on_build();action_t second=opening("research");ui_set_connected(false);
    assert(!visit.available&&!visit.pending);unsigned count=wires;visit_worker(second);assert(wires==count);checks++;
}
int main(void) {
    refusal_preserves_return();only_correlated_success_commits();refused_return_can_retry();
    failed_emit_and_timeout();unavailable_never_invents_bookmark();
    printf("Pro visit identity: PASS (%u checks; actual callbacks/queued worker, failed detour retains Return, success commits exact target, stale/error/timeout/congestion; no real input)\n",checks);
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-visit-identity-") as directory:
    build = Path(directory)
    (build / "visit_identity.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "visit_identity.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        *[str(NATIVE / (name + ".c")) for name in ("visit", "carry", "workspace", "form", "draft", "selection", "gestures")],
        "-o", str(build / "visit_identity"),
    ], check=True, timeout=45)
    subprocess.run([str(build / "visit_identity")], check=True, timeout=10)
