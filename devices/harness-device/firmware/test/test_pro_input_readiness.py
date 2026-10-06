"""Exercise Pro recording readiness through production dispatch and audio worker.

The app fixture supplies the actual UI state, notice handlers and A_VOICE
dispatcher. This adds the actual queued A_VOICE worker and counted microphone
boundaries. No USB, live app, model, audio device or hardware writes are used.
Availability is only rejection of known blockers, never host preflight proof.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
fixture = HERE / "test_pro_app_interactions.py"
ns = {"__file__": str(fixture), "__name__": "pro_readiness_fixture"}
exec(compile(fixture.read_text().split(
    'with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-")'
)[0], str(fixture), "exec"), ns)
code, function, cases = ns["code"], ns["function"], ns["cases"]
NATIVE, SOURCE, FONTS = ns["NATIVE"], ns["SOURCE"], ns["FONTS"]
CABLE = (NATIVE / "../../cable_client.c").resolve().read_text()
code = code.replace("int main(int argc,char **argv)", "void prior_main(int argc,char **argv)")
code = "#include <stdatomic.h>\n" + code
code = code.replace("int type; double valuedouble;", "int type; int valueint; double valuedouble;")
assert "static uint32_t now=100,random_value=1,features=~0u;" in code
code = code.replace("static uint32_t now=100,random_value=1,features=~0u;",
                    "static uint32_t now=100,random_value=1;\nstatic atomic_uint features=~0u;")

# These are production functions, not copies of the availability predicate.
for name in ("pro_work_available", "pro_work_capture_pin", "pro_work_capture_available", "pro_work_draft_available"):
    if not re.search(r"static[^\n]*\b" + name + r"\(", code):
        code += function(name)

# Exercise the real greeting/stream callbacks and snapshot boundary. Only the
# transport, RTOS lock and decoded JSON allocation are substituted; ownership,
# generation, cache invalidation and request decisions remain production code.
for name in ("ui_draft_source", "ui_workspace_applied", "ui_machines_clear", "ui_set_selected_machine"):
    if not re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{", code, re.M):
        code += function(name)
code += ns["typedef"]("cable_agent_t", source=CABLE)
code += ns["typedef"]("project_t") + ns["typedef"]("cable_agent_snapshot_t")
code += r'''
#define s_features features
#define s_agents_generation roster_generation
#undef ESP_LOGI
#define ESP_LOGI(tag,...) do{(void)(tag);if(false)fprintf(stderr,__VA_ARGS__);}while(0)
static const char *TAG="cable";
static char s_machine_name[40],s_machine_id[48],s_agents_tab[ID_MAX];
static bool s_session,s_agents_building,s_has_window;
static int s_agent_count,s_agents_total,s_agents_lock=1;
static cable_agent_t agent_rows[CABLE_MAX_AGENTS],*s_agents=agent_rows;
static cable_machines_t s_machines;
static unsigned roster_requests,machine_requests,reloads,boot_reports,framing_starts,framing_stops,held;
#define portMAX_DELAY 0
static void xSemaphoreTake(int lock,int wait) { assert(lock&&!held);(void)wait;held++; }
static void xSemaphoreGive(int lock) { assert(lock&&held==1);held--; }
static void ui_request_agent_reload(void) { reloads++; }
static void ui_metrics_source(const char *id,bool supported) { (void)id;(void)supported; }
static void cable_link_set_log_framing(bool enabled) { if(enabled)framing_starts++;else framing_stops++; }
static void cable_speech_disconnect(void) {}
static void fw_update_abort(const char *why) { assert(why&&why[0]); }
static void last_words_report(void) { boot_reports++; }
static cJSON *msg(const char *type) {
    cJSON *p=calloc(1,sizeof *p);assert(p);p->valuestring=type;return p;
}
static void send_json(cJSON *p) {
    assert(p);
    if(!strcmp(p->valuestring,"machines.list"))machine_requests++;
    else if(!strcmp(p->valuestring,"agents.list"))roster_requests++;
    else assert(false);
    free(p);
}
static bool cJSON_IsArray(const cJSON *p) { return p&&p->type==JARRAY; }
'''
code += function("cable_features_parse", (NATIVE / "../../cable_features.c").resolve().read_text())
for name in ("str_of", "session_up", "session_down", "handle_agents_begin", "handle_agent",
             "handle_agents_end", "cable_client_list_agents_snapshot"):
    code += function(name, CABLE)

audio = (NATIVE / "../../audio_client.h").resolve().read_text()
command = re.search(r"typedef enum \{[^}]+\} voice_cmd_t;", audio)
assert command, "Production voice command enum must be available"
code += command.group(0) + "\n"
code += r'''
static unsigned mic_starts, review_requests;
static int mic_kind;
static voice_cmd_t mic_command;
static char mic_agent[ID_MAX];
static void microphone(int kind,const char *agent) {
    mic_starts++;mic_kind=kind;COPY(mic_agent,agent?agent:"");
}
static void audio_client_start_cable(const char *agent,voice_cmd_t command) {
    microphone(0,agent);mic_command=command;
}
static void audio_client_start_form(const char *id,unsigned revision) {
    assert(id&&id[0]&&revision);microphone(2,NULL);
}
static void audio_client_start_carry(const char *agent,const char *id) {
    assert(id&&id[0]);microphone(3,agent);
}
static void audio_client_start_question(const char *agent,const char *token,unsigned index) {
    assert(token&&token[0]&&index==0);microphone(4,agent);
}
static void audio_client_start_draft(const char *id,unsigned revision,bool append) {
    assert(id&&id[0]&&revision);microphone(append?6:5,NULL);
}
static void audio_client_start_search(const char *agent,const char *id,unsigned revision) {
    assert(id&&id[0]&&revision);microphone(7,agent);
}
static void audio_client_start_selection(const char *agent,const char *id,unsigned revision) {
    assert(id&&id[0]&&revision);microphone(9,agent);
}
static void audio_client_request_review(void) { review_requests++; }
'''
worker = SOURCE.split("static void worker(", 1)[1]
code += "static void record_worker(action_t a) { switch(a.kind) {\n"
code += cases("A_VOICE", "A_VOICE_ABORT", worker, "        ")
code += "default:assert(false);}}\n"
code += r'''
static unsigned scenarios;
static void fresh(void) {
    reset();now=100000;s.notice_count=0;s.view=HOME;s.loading=false;
    memset(&s.draft_recovery,0,sizeof s.draft_recovery);
    pro_draft_recovery_source(&s.draft_recovery,"fixture-host");
    COPY(s.agents[0].engine,"claude");COPY(s.agents[0].machine_id,"fixture-host");
    COPY(s.agents[0].session,"session-original");s.agents[0].busy=false;
    s.machine_count=2;
    COPY(s.machines[0].id,"fixture-host");COPY(s.machines[0].state,"ready");s.machines[0].local=true;
    COPY(s.machines[1].id,"remote-host");COPY(s.machines[1].state,"ready");s.machines[1].local=false;
    mic_starts=review_requests=0;mic_kind=-1;mic_command=VOICE_CMD_NONE;mic_agent[0]=0;
    s_session=true;roster_generation=1;s_agents_building=false;s_agent_count=s_agents_total=0;
    s_has_window=false;s_agents_tab[0]=0;memset(agent_rows,0,sizeof agent_rows);cable_machines_init(&s_machines);
    roster_requests=machine_requests=reloads=boot_reports=framing_starts=framing_stops=0;assert(!held);
}
static void availability(int mode,bool allowed) {
    assert(pro_work_available(active(),mode)==allowed);
    assert((pro_work_block_reason(active(),mode)==NULL)==allowed);scenarios++;
}
static void pending_question(bool current,bool unavailable) {
    s.notice_count=1;s.notice[0]=(cable_notif_t){.question=true,
        .question_current=current,.question_unavailable=unavailable,.read_on_dial=true};
    COPY(s.notice[0].agent_id,"design");COPY(s.notice[0].question_id,"question-original");
}
static action_t instruction(int value) {
    action_t a={.kind=A_VOICE,.value=value};COPY(a.id,"design");
    if(value==3) {
        s.view=CARRY_PREVIEW;carry.active=true;carry.deadline=now+10000;
        COPY(carry.id,"carry-original");COPY(carry.source,"source-agent");
        COPY(a.text,carry.id);
    }
    return a;
}
static void unavailable(action_t a) {
    dispatch(a);assert(!enqueued&&!voice_commands&&!mic_starts&&!s.voice_start_pending);scenarios++;
}
static action_t queued_instruction(int value) {
    dispatch(instruction(value));assert(enqueued==1&&voice_commands==1&&!mic_starts);
    assert(s.voice_open&&s.voice_start_pending&&sent.kind==A_VOICE);
    return sent;
}
static void starts(int value) {
    action_t a=queued_instruction(value);record_worker(a);
    assert(mic_starts==1&&!strcmp(mic_agent,"design")&&!s.voice_start_pending);
    assert(mic_kind==(value==3?3:0));
    assert(review_requests==(unsigned)(value==1||value==3||value==8));
    if(value!=3)assert(mic_command==(value==1?VOICE_CMD_GOAL:value==8?VOICE_CMD_LOOP:VOICE_CMD_NONE));
    scenarios++;
}
static void helper_matrix(void) {
    fresh();COPY(active()->engine,"terminal");
    for(int mode=0;mode<3;mode++)availability(mode,false);
    // Task remains a discoverable instruction; its recording action is blocked.
    assert(pro_work_visible(active(),PRO_WORK_TASK));
    fresh();COPY(active()->engine,"custom");assert(pro_work_visible(active(),PRO_WORK_TASK));
    availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,false);availability(PRO_WORK_LOOP,false);
    fresh();COPY(active()->engine,"codex");availability(PRO_WORK_GOAL,true);availability(PRO_WORK_LOOP,false);
    fresh();features&=~CABLE_FEATURE_DRAFT;availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,false);

    const char *states[]={"offline","needs-link","unknown","ready"};
    for(unsigned i=0;i<4;i++) {
        fresh();COPY(active()->machine_id,"remote-host");COPY(s.machines[1].state,states[i]);
        availability(PRO_WORK_TASK,i>=2);availability(PRO_WORK_GOAL,false);availability(PRO_WORK_LOOP,false);
        // The selected wheel row is not the instruction's recipient.
        COPY(s.selected_machine,"fixture-host");availability(PRO_WORK_TASK,i>=2);
        fresh();COPY(s.machines[0].state,states[i]);availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,true);
    }
    fresh();COPY(active()->machine_id,"remote-host");s.machine_count=0;availability(PRO_WORK_TASK,true);
    fresh();active()->machine_id[0]=0;availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,false);

    const uint32_t ages[]={0,1,24999,25000,25001};
    for(unsigned wrapped=0;wrapped<2;wrapped++)for(unsigned i=0;i<5;i++) {
        fresh();now=wrapped?4:100000;active()->busy=true;active()->last_busy=now-ages[i];
        availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,ages[i]>25000);availability(PRO_WORK_LOOP,ages[i]>25000);
    }
    for(unsigned current=0;current<2;current++)for(unsigned unsupported=0;unsupported<2;unsupported++) {
        fresh();pending_question(current,unsupported);
        for(int mode=0;mode<3;mode++)availability(mode,!current);
        COPY(s.notice[0].agent_id,"build");availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,true);
    }
}
static void dispatch_and_worker(void) {
    const int values[]={0,1,3,8};
    for(unsigned i=0;i<4;i++) {
        int value=values[i];fresh();starts(value);
        const view_t surfaces[]={HOME,AGENT,WORK_INTENT};
        for(unsigned surface=0;surface<3;surface++) {
            fresh();COPY(active()->engine,"terminal");action_t rejected=instruction(value);
            s.view=surfaces[surface];unavailable(rejected);
            assert(s.view==((value==1||value==8)&&surfaces[surface]!=WORK_INTENT?MESSAGE:surfaces[surface]));
            fresh();action_t queued=instruction(value);s.view=surfaces[surface];dispatch(queued);
            assert(enqueued==1&&s.voice_start_pending);pending_question(true,true);record_worker(sent);
            assert(!mic_starts);
            assert(s.view==((value==1||value==8)&&surfaces[surface]!=WORK_INTENT?MESSAGE:surfaces[surface]));
            scenarios++;
        }
        fresh();COPY(active()->engine,"terminal");unavailable(instruction(value));
        fresh();pending_question(true,true);unavailable(instruction(value));
        fresh();COPY(active()->machine_id,"remote-host");COPY(s.machines[1].state,"offline");unavailable(instruction(value));
        fresh();COPY(active()->machine_id,"remote-host");COPY(s.machines[1].state,"needs-link");unavailable(instruction(value));
        fresh();active()->busy=true;active()->last_busy=now;
        if(value==1||value==8)unavailable(instruction(value));else starts(value);

        // A queued tap is not authority to start a microphone after state changes.
        for(int mutation=0;mutation<10;mutation++) {
            fresh();action_t a=queued_instruction(value);
            switch(mutation) {
            case 0:COPY(active()->engine,"terminal");break;
            case 1:pending_question(true,true);break;
            case 2:COPY(active()->machine_id,"remote-host");COPY(s.machines[1].state,"offline");break;
            case 3:s.draft_recovery.generation++;break;
            case 4:COPY(s.draft_recovery.current_host,"different-host");break;
            case 5:COPY(active()->session,"replacement-session");break;
            case 6:COPY(active()->engine,"codex");break;
            case 7:COPY(s.draft_recovery.recipient,"build");break;
            case 8:s.draft_recovery.mode=(uint8_t)((s.draft_recovery.mode+1)%3);break;
            case 9:s.count=0;break;
            }
            record_worker(a);assert(!mic_starts);scenarios++;
        }
        fresh();action_t a=queued_instruction(value);s.connected=false;record_worker(a);assert(!mic_starts);scenarios++;
        fresh();a=queued_instruction(value);s.voice_generation++;record_worker(a);assert(!mic_starts);scenarios++;
        if(value==1||value==8) {
            fresh();a=queued_instruction(value);active()->busy=true;active()->last_busy=now;
            record_worker(a);assert(!mic_starts);scenarios++;
        }
        // A changed current pane never retargets the explicit original recipient.
        fresh();a=queued_instruction(value);s.active=1;record_worker(a);
        assert(mic_starts==1&&!strcmp(mic_agent,"design"));scenarios++;
    }
    // Older hosts may omit welcome.machine.id. Task/Carry still bind both empty
    // identities plus their generation and recipient, without gaining Goal/Loop.
    for(unsigned i=0;i<2;i++) {
        int value=i?3:0;fresh();pro_draft_recovery_source(&s.draft_recovery,"");starts(value);
        fresh();pro_draft_recovery_source(&s.draft_recovery,"");action_t a=queued_instruction(value);
        s.draft_recovery.generation++;record_worker(a);assert(!mic_starts);scenarios++;
        // Reachability changes independently of the captured recipient tuple.
        const char *states[]={"offline","needs-link","unknown"};
        for(unsigned state=0;state<3;state++) {
            fresh();COPY(active()->machine_id,"remote-host");a=queued_instruction(value);
            COPY(s.machines[1].state,states[state]);record_worker(a);
            assert(mic_starts==(unsigned)(state==2));scenarios++;
        }
    }
    fresh();pro_draft_recovery_source(&s.draft_recovery,"");unavailable(instruction(1));
    fresh();pro_draft_recovery_source(&s.draft_recovery,"");unavailable(instruction(8));
}
static void special_recordings(void) {
    // An ordinary-instruction blocker must not swallow the existing explicit
    // answer, field, draft-edit or selected-output search recording paths.
    for(int value=2;value<=7;value++) {
        if(value==3)continue;
        fresh();COPY(active()->engine,"terminal");pending_question(true,true);
        action_t a={.kind=A_VOICE,.value=value};COPY(a.id,"design");
        if(value==2) {
            s.view=FORM;COPY(form.id,"form-original");form.page.active=form.page.can_query=true;
            form.page.revision=7;COPY(a.text,form.id);a.dy=7;
        } else if(value==4) {
            s.view=QUESTION;s.q.valid=s.q.supported=true;s.q.count=1;s.q.index=0;s.q.revision=8;
            s.q.item[0].can_text=true;COPY(s.q.agent,"design");COPY(s.q.token,"question-token");
            COPY(a.text,s.q.token);a.revision=8;
        } else if(value==5||value==6) {
            s.view=DRAFT;draft.page.active=true;draft.page.revision=9;COPY(draft.page.id,"draft-original");
            COPY(a.text,draft.page.id);a.revision=9;a.dy=9;
        } else {
            s.view=SELECTION;selection.active=selection.announced=true;selection.revision=10;
            COPY(selection.id,"selection-original");COPY(selection.agent,"design");
            COPY(a.text,selection.id);a.dy=10;
        }
        dispatch(a);assert(enqueued==1&&sent.kind==A_VOICE);record_worker(sent);
        assert(mic_starts==1&&mic_kind==value);scenarios++;
    }
}
static void recorded_draft_is_not_new_capture(void) {
    for(int mode=0;mode<3;mode++) {
        fresh();COPY(s.work_agent,"design");s.work_voice_mode=(uint8_t)mode;
        COPY(draft.page.agent,"design");pro_work_capture_pin(active(),mode);
        assert(pro_work_draft_available());active()->busy=true;active()->last_busy=now;
        pending_question(true,true);
        assert(pro_work_draft_available());scenarios++;
    }
}
static void question_freshness(void) {
    fresh();ui_question_show("design","Design","Fixture","question-current",NULL);
    assert(s.notice_count==1&&s.notice[0].question_current);availability(PRO_WORK_TASK,false);
    ui_set_connected(false);assert(s.notice_count==1&&!s.notice[0].question_current);
    ui_set_connected(true);availability(PRO_WORK_TASK,false);
    ui_workspace_applied("",++roster_generation);availability(PRO_WORK_TASK,true);
    cable_notif_t incoming={.question=true};COPY(incoming.agent_id,"design");COPY(incoming.read_token,"fresh-token");
    ui_notif_replace(&incoming,1);assert(s.notice[0].question_current);availability(PRO_WORK_TASK,false);
    ui_notif_read("design","fresh-token");assert(s.notice[0].question_current);availability(PRO_WORK_TASK,false);
    ui_question_show("design","Design","Fixture","question-next",NULL);
    ui_question_close("design","question-current");availability(PRO_WORK_TASK,false);
    ui_question_close("design","question-next");availability(PRO_WORK_TASK,true);

    // A retained card is not fresh pending evidence until an actual correlated
    // read response re-establishes it on this link.
    fresh();pending_question(false,false);view(INBOX);act(A_QUESTION,0);
    assert(s.q.loading&&enqueued==1);
    question_state_reply(true,false,"question-original","question-token");
    assert(s.q.valid&&s.notice[0].question_current);availability(PRO_WORK_TASK,false);
}
static void greeting(const char *host) {
    cJSON machine_fields[]={{.string="name",.type=JSTRING,.valuestring="Fixture computer"},
        {.string="id",.type=JSTRING,.valuestring=host}};
    cJSON machine=object(machine_fields,host?2:1);machine.string="machine";
    cJSON feature={.type=JSTRING,.valuestring="voice.draft"};
    cJSON fields[]={machine,{.string="features",.type=JARRAY,.child=&feature}};
    cJSON welcome=object(fields,2);session_up(&welcome);
}
static void stream_agent(const char *host) {
    cJSON fields[]={{.string="id",.type=JSTRING,.valuestring="design"},
        {.string="name",.type=JSTRING,.valuestring="Design"},
        {.string="engine",.type=JSTRING,.valuestring="claude"},
        {.string="machineId",.type=JSTRING,.valuestring=host?host:""}};
    cJSON row=object(fields,4);handle_agent(&row);
}
static void stream_end(void) {
    cJSON fields[]={{.string="tab",.type=JSTRING,.valuestring="workspace-fixture"},
        {.string="total",.type=JNUMBER,.valueint=1,.valuedouble=1}};
    cJSON end=object(fields,2);handle_agents_end(&end);
}
static cable_agent_snapshot_t complete_roster(const char *host) {
    handle_agents_begin();stream_agent(host);stream_end();
    project_t rows[2];cable_agent_snapshot_t snapshot;
    assert(cable_client_list_agents_snapshot(rows,2,&snapshot)==1);
    assert(!strcmp(rows[0].id,"design")&&!strcmp(rows[0].engine,"claude"));
    assert(!strcmp(rows[0].machine_id,host?host:""));
    // app_main reconciles these snapshot rows before calling the real applied
    // callback. Supply those rows to the test UI, without bypassing that callback.
    s.count=1;s.active=0;COPY(s.agents[0].id,rows[0].id);COPY(s.agents[0].name,rows[0].name);
    COPY(s.agents[0].engine,rows[0].engine);COPY(s.agents[0].machine_id,rows[0].machine_id);
    ui_workspace_applied(snapshot.tab,snapshot.generation);return snapshot;
}
static void seed_machine_cache(void) {
    cable_machines_begin(&s_machines);
    assert(cable_machines_add(&s_machines,"old-remote","Old computer","offline",false));
    assert(cable_machines_end(&s_machines,"old-remote"));
    COPY(s_machine_id,"fixture-host");
}
static void greeting_and_roster_readiness(void) {
    const int values[]={0,1,3,8};
    char oversized[80];memset(oversized,'x',sizeof oversized-1);oversized[sizeof oversized-1]=0;
    const char *hosts[]={"next-host",NULL,oversized};
    for(unsigned host=0;host<3;host++)for(unsigned value=0;value<4;value++) {
        fresh();cable_agent_snapshot_t old=complete_roster("fixture-host");seed_machine_cache();
        // An unfinished old stream is not a new-owner roster merely because
        // its end arrives after welcome. Its decoded rows are discarded too.
        handle_agents_begin();stream_agent("fixture-host");
        project_t rows[2];cable_agent_snapshot_t snapshot;
        assert(cable_client_list_agents_snapshot(rows,2,&snapshot)==-1);
        greeting(hosts[host]);
        assert(s.work_roster_pending&&s.work_roster_after==old.generation);
        assert(roster_generation==old.generation&&!s_agents_building&&!s_agent_count);
        assert(!s_agents_total&&!s_has_window&&!s_agents_tab[0]);
        assert(!s_machines.count&&!s_machines.building&&!s.machine_count);
        assert(machine_requests==1&&roster_requests==1&&!boot_reports&&!framing_starts);
        assert(!strcmp(pro_work_block_reason(active(),PRO_WORK_TASK),"Finding your panes..."));
        if(!hosts[host])assert(!s_machine_id[0]&&!s.selected_machine[0]);
        if(host)assert(!s.draft_recovery.current_host[0]);
        unavailable(instruction(values[value]));

        // A previously copied complete snapshot may still reach the UI; its
        // generation cannot grant authority after the owner boundary.
        ui_workspace_applied(old.tab,old.generation);assert(s.work_roster_pending);
        ui_workspace_applied(old.tab,old.generation-1);assert(s.work_roster_pending);
        stream_agent("fixture-host");stream_end();assert(roster_generation==old.generation);
        assert(cable_client_list_agents_snapshot(rows,2,&snapshot)==0);
        ui_workspace_applied(snapshot.tab,snapshot.generation);assert(s.work_roster_pending);
        unavailable(instruction(values[value]));

        // Only a completed new begin/rows/end cycle clears the pending state.
        const char *next=host?NULL:hosts[host];
        snapshot=complete_roster(next);assert(snapshot.generation==old.generation+1&&!s.work_roster_pending);
        if(host&&(values[value]==1||values[value]==8))unavailable(instruction(values[value]));
        else starts(values[value]);
        scenarios++;
    }
    // The same live owner's keepalive must not erase an in-flight valid stream
    // or repeatedly issue list requests, frame-log starts or boot reports.
    fresh();seed_machine_cache();handle_agents_begin();stream_agent("fixture-host");
    uint32_t before=roster_generation;greeting("fixture-host");
    assert(s_agents_building&&s_agent_count==1&&roster_generation==before);
    assert(s_machines.count==1&&!s.work_roster_pending);
    assert(!machine_requests&&!roster_requests&&!reloads&&!framing_starts&&!boot_reports);
    stream_end();assert(roster_generation==before+1);scenarios++;

    // A genuine same-host reconnect is a new roster boundary even when the
    // host ID, pane IDs and visible UI rows all happen to be unchanged.
    for(unsigned value=0;value<4;value++) {
        fresh();complete_roster("fixture-host");session_down("fixture unplug");
        uint32_t after_down=roster_generation;
        ui_workspace_applied("workspace-fixture",after_down+1);assert(s.work_roster_pending);
        greeting("fixture-host");assert(s.work_roster_pending&&s.work_roster_after==after_down);
        assert(machine_requests==1&&roster_requests==1&&boot_reports==1&&framing_starts==1&&framing_stops==1);
        ui_workspace_applied("workspace-fixture",after_down);unavailable(instruction(values[value]));
        complete_roster("fixture-host");starts(values[value]);scenarios++;
    }
    // Older hosts omit their ID. A first connection still discards pre-welcome
    // staging; after a new roster, only the existing Task/Carry path is available.
    fresh();pro_draft_recovery_source(&s.draft_recovery,NULL);s_session=false;s.connected=false;
    handle_agents_begin();stream_agent(NULL);seed_machine_cache();greeting(NULL);
    assert(s.work_roster_pending&&!s_agents_building&&!s_agent_count&&!s_machines.count);
    assert(machine_requests==1&&roster_requests==1&&boot_reports==1&&framing_starts==1);
    before=roster_generation;stream_end();assert(roster_generation==before);
    complete_roster(NULL);availability(PRO_WORK_TASK,true);availability(PRO_WORK_GOAL,false);
    // Two unidentifiable live greetings cannot prove an invisible host change.
    greeting(NULL);assert(!s.work_roster_pending&&machine_requests==1&&roster_requests==1);scenarios++;

    // The signed serial comparison accepts the next generation across wrap,
    // while equal, older and half-range ambiguous serials remain blocked.
    const uint32_t boundaries[]={0,1,UINT32_MAX-1,UINT32_MAX};
    for(unsigned i=0;i<4;i++) {
        fresh();roster_generation=boundaries[i];greeting("next-host");
        const uint32_t stale[]={boundaries[i],boundaries[i]-1,boundaries[i]+UINT32_C(0x80000000)};
        for(unsigned n=0;n<3;n++) {
            ui_workspace_applied("workspace-fixture",stale[n]);assert(s.work_roster_pending);scenarios++;
        }
        complete_roster("next-host");assert(!s.work_roster_pending);starts(0);scenarios++;
    }
    // A queued recording from before the actual greeting cannot start audio on
    // its new link, even if a later fresh roster restores general availability.
    for(unsigned value=0;value<4;value++) {
        fresh();action_t a=queued_instruction(values[value]);greeting("next-host");
        complete_roster("next-host");record_worker(a);assert(!mic_starts);scenarios++;
    }
}
int main(void) {
    helper_matrix();dispatch_and_worker();special_recordings();recorded_draft_is_not_new_capture();question_freshness();
    greeting_and_roster_readiness();
    printf("Pro input readiness: PASS (%u cases; actual greeting/roster/snapshot callbacks, dispatch/queued worker, exact recipient/host/generation/process labels, known blockers, preserved Task/special recording/draft behavior; no preflight guarantee)\n",scenarios);
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-input-readiness-") as directory:
    build = Path(directory)
    (build / "readiness.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "readiness.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        str(NATIVE / "../../cable_machines.c"),
        *[str(NATIVE / (name + ".c")) for name in ("visit", "carry", "workspace", "form", "draft", "selection", "gestures")],
        "-o", str(build / "readiness"),
    ], check=True, timeout=45)
    subprocess.run([str(build / "readiness")], check=True, timeout=10)

    # The shared function's non-Pro branch retains its existing greeting
    # behavior. No UI, roster, machine-cache or capability extension is enabled.
    round_code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct cJSON { const char *string,*valuestring; int type,valueint;struct cJSON *child,*next; } cJSON;
enum { JSTRING=1,JOBJECT=2,JNUMBER=3 };
static bool cJSON_IsString(const cJSON *v) { return v&&v->type==JSTRING; }
static bool cJSON_IsNumber(const cJSON *v) { return v&&v->type==JNUMBER; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *key) {
    for(const cJSON *p=v?v->child:NULL;p;p=p->next)if(p->string&&!strcmp(p->string,key))return p;
    return NULL;
}
static uint32_t cable_features_parse(const cJSON *p) { assert(p);return 7; }
static atomic_uint s_features;
static char s_machine_name[40],s_machine_id[48],selected[48];
static bool s_session;
static unsigned connections,logs,framing,reports,writes;
static const char *TAG="round";
#define ESP_LOGI(tag,...) do{(void)(tag);logs++;if(false)fprintf(stderr,__VA_ARGS__);}while(0)
static void ui_set_selected_machine(const char *id) { snprintf(selected,sizeof selected,"%s",id); }
static void ui_set_connected(bool connected) { assert(connected);connections++; }
static void cable_link_set_log_framing(bool enabled) { assert(enabled);framing++; }
static void last_words_report(void) { reports++; }
static cJSON *msg(const char *type) { cJSON *p=calloc(1,sizeof *p);assert(p);p->valuestring=type;return p; }
static void send_json(cJSON *p) {
    assert(p&&!strcmp(p->valuestring,writes%2?"agents.list":"machines.list"));writes++;free(p);
}
'''
    round_code += function("str_of", CABLE) + function("session_up", CABLE)
    round_code += r'''
int main(void) {
    cJSON id={.string="id",.type=JSTRING,.valuestring="round-host"};
    cJSON name={.string="name",.type=JSTRING,.valuestring="Round fixture",.next=&id};
    cJSON machine={.string="machine",.type=JOBJECT,.child=&name};
    cJSON welcome={.type=JOBJECT,.child=&machine};
    session_up(&welcome);
    assert(s_session&&atomic_load(&s_features)==7&&!strcmp(selected,"round-host"));
    assert(connections==1&&writes==2&&logs==1&&framing==1&&reports==1);
    session_up(&welcome);
    assert(connections==2&&writes==2&&logs==1&&framing==1&&reports==1);
    s_session=false;session_up(&welcome);
    assert(connections==3&&writes==4&&logs==2&&framing==2&&reports==2);
    // Owner-change refresh is Pro-only; the existing round live greeting path
    // still updates its selected identity without extra list/report traffic.
    id.valuestring="other-round-host";session_up(&welcome);
    assert(!strcmp(selected,"other-round-host")&&connections==4&&writes==4&&logs==2&&framing==2&&reports==2);
    puts("Round greeting compatibility: PASS (4 actual session_up cases; ordered list requests, once-only log/report)");
    return 0;
}
'''
    (build / "round-greeting.c").write_text(round_code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        str(build / "round-greeting.c"), "-o", str(build / "round-greeting"),
    ], check=True, timeout=15)
    subprocess.run([str(build / "round-greeting")], check=True, timeout=10)
