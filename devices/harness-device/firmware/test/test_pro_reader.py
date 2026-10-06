"""Frozen Pro summaries through production actions, notices and owner callbacks.

The shared app fixture supplies actual UI types/dispatch/renderers. Cable/audio
boundaries are counted substitutes; this never focuses a real pane or device.
"""
from pathlib import Path
import os
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
fixture = HERE / "test_pro_app_interactions.py"
ns = {"__file__": str(fixture), "__name__": "pro_reader_fixture"}
exec(compile(fixture.read_text().split(
    'with tempfile.TemporaryDirectory(prefix="harness-pro-app-interactions-")'
)[0], str(fixture), "exec"), ns)
code, function = ns["code"], ns["function"]
NATIVE, FONTS = ns["NATIVE"], ns["FONTS"]
code = code.replace("int main(int argc,char **argv)", "void prior_main(int argc,char **argv)")
code = code.replace("static void view(view_t v) { input_cancel();s.view=v;s.offset=0; }",
                    "static void pro_voice_sample_stop(void) {}\n" + function("view"))
code += "static bool display_is_asleep(void) { return false; }\n"
for name in ("habitat_scene_receipt", "habitat_scene_presented", "pane_memory", "pane_memory_apply", "ensure", "activity_text", "event", "ui_project_emit",
             "ui_project_restore_event", "ui_project_clear_event", "ui_project_set_name",
             "ui_project_remove", "ui_project_clear_all", "ui_draft_source"):
    code += function(name)
code += r'''
static unsigned checks;
static void fresh(void) {
    reset();s.notice_count=0;s.view=HOME;now=1000;
    pro_draft_recovery_source(&s.draft_recovery,"fixture-host");
}
static int card(const char *id) {
    for(int i=0;i<s.notice_count;i++)if(!strcmp(s.notice[i].agent_id,id))return i;
    return -1;
}
static void wide_summary(char *text,size_t cap) {
    // A valid delivered preview can exceed seven lines despite its byte cap.
    memset(text,'W',cap-1);text[cap-1]=0;
    assert(ht_pro_text_rows(text,&ht_pro_32,624)>7);
}
static void add_result(const char *id,const char *name,const char *token,bool failed) {
    char summary[240];wide_summary(summary,sizeof summary);
    notice_add(id,name,"Other workspace",summary,false,failed);
    COPY(s.notice[card(id)].read_token,token);
}
static void read_card(const char *id) {
    view(INBOX);s.offset=card(id);assert(s.offset>=0);
    ht_scene_t visible;render(&visible);habitat_scene_presented(habitat_scene_receipt());
    action_t read=make_action(hit(A_READER,1));
    assert(!strcmp(read.id,id)&&read.revision==s.notice[s.offset].display_revision);
    dispatch(read);assert(s.view==READER&&s.reader.captured&&s.reader.from_notice);
}
static void no_remote_actions(unsigned count,int active_index) {
    assert(enqueued==count&&s.active==active_index&&!answers&&!opens&&!voice_commands);
}
static void gates_and_exact_snapshot(const char *dir) {
    ht_scene_t scene;fresh();notice_add("remote","Research","","A short useful summary.",false,false);
    view(INBOX);render(&scene);assert(!controls(A_READER));
    action_t read=make_action(hit(A_READER,1));dispatch(read);assert(s.view==INBOX&&!s.reader.captured);checks++;
    portrait(&scene,dir,"updates-fitting-summary");
    add_result("remote","Research","result-1",false);s.offset=card("remote");render(&scene);
    assert(controls(A_READER)==1&&controls(A_NOTICE)==1);
    portrait(&scene,dir,"updates-overflow-summary");
    // Even a same-agent longer cache is unrelated to the clicked occurrence.
    ui_project_emit("remote","session-new","summary","DO NOT JOIN THIS NEWER BODY.","A different summary.");
    char original[240];COPY(original,s.notice[s.offset].summary);unsigned queued=enqueued;
    dispatch(make_action(hit(A_READER,1)));
    assert(!strcmp(s.reader.text,original)&&!strcmp(s.reader.name,"Research")&&!strcmp(s.reader.host,"fixture-host"));
    assert(!strcmp(s.reader_agent,"remote")&&find("remote")==-1);
    assert(enqueued==queued+1&&sent.kind==A_NOTICE_READ&&!strcmp(sent.id,"remote"));
    no_remote_actions(enqueued,0);render(&scene);assert(!controls(A_SELECT_BEGIN)&&controls(A_DESKTOP)==1);
    assert(!text_has(&scene,"DO NOT JOIN"));portrait(&scene,dir,"reader-off-workspace-summary");checks++;
    act(A_READER_BACK,0);assert(s.view==INBOX&&s.offset==card("remote"));
    s.notice[s.offset].question=true;render(&scene);assert(!controls(A_READER));
    dispatch(make_action(hit(A_READER,1)));assert(s.view==INBOX);checks++;
    s.notice[s.offset].question=false;s.notice[s.offset].failed=true;render(&scene);assert(controls(A_READER));
    dispatch(make_action(hit(A_READER,1)));assert(s.reader.failed);checks++;
}
static void frozen_normal_reader(const char *dir) {
    ht_scene_t scene;fresh();
    const char *saved="The first summary stays readable while another turn finishes.\n\nThis paragraph belongs to the selected pane at the moment Read was opened.";
    COPY(s.agents[0].full,saved);view(LAUNCHER);act(A_READER,0);
    assert(s.reader.captured&&!s.reader.from_notice&&!strcmp(s.reader.text,saved));
    assert(!strcmp(s.reader.name,"Design")&&s.reader.entry==LAUNCHER);
    unsigned queued=enqueued;
    ui_project_emit("design","new-turn","summary","A replacement result.","Replacement.");
    ui_project_set_name("design","A renamed pane");ui_project_clear_event("design");ui_project_remove("design");
    for(int i=0;i<PANE_MEMORY_MAX+2;i++) {char id[40];snprintf(id,sizeof id,"evict-%d",i);ui_project_emit(id,NULL,"summary","Cache traffic.","Cache traffic.");}
    assert(!strcmp(s.reader.text,saved)&&!strcmp(s.reader.name,"Design"));
    render(&scene);assert(text_has(&scene,"The first summary")&&!text_has(&scene,"replacement result"));
    assert(!controls(A_SELECT_BEGIN)&&!controls(A_DESKTOP));
    portrait(&scene,dir,"reader-frozen-after-eviction");assert(enqueued==queued&&!answers&&!opens&&!voice_commands);checks++;
    act(A_READER_BACK,0);assert(s.view==LAUNCHER);checks++;
    for(int entry=HOME;entry<=AGENT;entry++) {
        if(entry!=HOME&&entry!=AGENT)continue;
        fresh();view((view_t)entry);act(A_READER,0);assert(s.reader.entry==entry);act(A_READER_BACK,0);assert((int)s.view==entry);checks++;
    }
    fresh();COPY(s.agents[0].full,"Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight\nLine nine\nLine ten\nLine eleven\nLine twelve\nLine thirteen");
    view(LAUNCHER);act(A_READER,0);render(&scene);act(A_DOWN,0);render(&scene);int row=s.offset;assert(row>0);
    act(A_READER_BACK,0);act(A_READER,0);render(&scene);assert(s.offset==row);checks++;
    act(A_READER_BACK,0);COPY(s.agents[0].full,"A different result.");act(A_READER,0);assert(s.offset==0);checks++;
}
static void receipts_and_return_position(const char *dir) {
    ht_scene_t scene;
    // Read may dispatch before the compositor reports the Updates frame shown.
    // The exact local origin must survive either host unread-event ordering.
    for(int token=0;token<2;token++)for(int ordering=0;ordering<2;ordering++) {
        fresh();add_result("remote","Research",token?"early-read":"",false);
        view(INBOX);s.offset=card("remote");render(&scene);
        assert(!s.notice[s.offset].read_on_dial);
        uint32_t receipt=habitat_scene_receipt();unsigned queued=enqueued;
        dispatch(make_action(hit(A_READER,1)));
        assert(s.view==READER&&s.notice[card("remote")].read_on_dial);
        assert(enqueued==queued+(unsigned)token);
        if(ordering==0){ui_notif_read("remote",token?"early-read":"");ui_notif_replace(NULL,0);}
        else{ui_notif_replace(NULL,0);ui_notif_read("remote",token?"early-read":"");}
        habitat_scene_presented(receipt); // A late display completion is harmless.
        assert(card("remote")>=0&&s.view==READER);
        act(A_READER_BACK,0);assert(s.view==INBOX&&s.offset==card("remote"));
        no_remote_actions(queued+(unsigned)token,0);checks++;
    }
    for(int ordering=0;ordering<2;ordering++) {
        fresh();add_result("remote","Research","result-1",false);read_card("remote");
        char saved[1024];COPY(saved,s.reader.text);render(&scene);act(A_DOWN,0);render(&scene);int row=s.offset;assert(row>0);
        unsigned queued=enqueued;
        if(ordering==0){ui_notif_read("remote","result-1");ui_notif_replace(NULL,0);}
        else{ui_notif_replace(NULL,0);ui_notif_read("remote","result-1");}
        assert(!strcmp(s.reader.text,saved)&&s.view==READER&&s.offset==row);
        assert(card("remote")>=0);act(A_READER_BACK,0);
        assert(s.view==INBOX&&s.offset==card("remote"));read_card("remote");render(&scene);assert(s.offset==row);
        no_remote_actions(queued,0);checks++;
        portrait(&scene,dir,ordering?"reader-after-empty-then-ack":"reader-after-ack-then-empty");
    }
    fresh();add_result("remote","Research","old",false);read_card("remote");render(&scene);act(A_DOWN,0);render(&scene);
    char saved[1024];COPY(saved,s.reader.text);int row=s.offset;uint32_t old_serial=s.reader.serial;
    cable_notif_t newer={0};COPY(newer.agent_id,"remote");COPY(newer.name,"New Research");COPY(newer.read_token,"new");wide_summary(newer.summary,sizeof newer.summary);newer.summary[0]='M';
    ui_notif_replace(&newer,1);assert(!strcmp(s.reader.text,saved)&&s.offset==row);
    ui_notif_read("remote","old"); // An old read receipt cannot consume the newer occurrence.
    assert(card("remote")>=0&&!strcmp(s.notice[card("remote")].read_token,"new"));
    assert(!strcmp(s.reader.text,saved)&&s.view==READER&&s.offset==row);checks++;
    act(A_READER_BACK,0);assert(s.view==INBOX&&s.offset==card("remote")&&!strcmp(s.notice[s.offset].read_token,"new"));
    read_card("remote");assert(s.reader.serial!=old_serial&&s.offset==0&&!strcmp(s.reader.name,"New Research"));checks++;
    // If the origin is genuinely removed, Back keeps a valid neighbouring card.
    add_result("other","Build notes","other-token",false);notice_remove("remote",true);
    act(A_READER_BACK,0);assert(s.view==INBOX&&s.offset>=0&&s.offset<s.notice_count&&!strcmp(s.notice[s.offset].agent_id,"other"));checks++;
    // Legacy tokenless equal words still require the exact local occurrence.
    fresh();add_result("remote","Research","",false);read_card("remote");render(&scene);act(A_DOWN,0);render(&scene);
    uint32_t revision=s.reader.notice_revision;add_result("remote","Research","",false);
    assert(s.notice[card("remote")].display_revision!=revision);act(A_READER_BACK,0);read_card("remote");assert(s.offset==0);checks++;
}
static void stale_actions_and_owner(const char *dir) {
    ht_scene_t scene;fresh();add_result("remote","Research","first",false);view(INBOX);s.offset=card("remote");
    action_t stale_read=make_action(hit(A_READER,1));add_result("remote","Research","second",false);
    unsigned queued=enqueued;dispatch(stale_read);assert(s.view==INBOX&&!s.reader.captured);no_remote_actions(queued,0);checks++;
    read_card("remote");queued=enqueued;action_t old_back=make_action(hit(A_READER_BACK,0)),old_open=make_action(hit(A_DESKTOP,2));
    action_t old_down=make_action(hit(A_DOWN,0)),old_up=make_action(hit(A_UP,0));
    act(A_READER_BACK,0);read_card("remote");render(&scene);int row=s.offset;
    dispatch(old_back);dispatch(old_open);dispatch(old_down);dispatch(old_up);
    assert(s.view==READER&&s.offset==row&&!visit.pending);no_remote_actions(queued,0);checks++;
    // Same-owner offline reading retains words; neither Open nor Select acts.
    ui_set_connected(false);render(&scene);assert(!controls(A_DESKTOP)&&!controls(A_SELECT_BEGIN));
    dispatch(make_action(hit(A_DESKTOP,2)));assert(s.view==READER&&!visit.pending);no_remote_actions(queued,0);checks++;
    portrait(&scene,dir,"reader-offline");
    ui_set_connected(true);ui_draft_source("other-host");render(&scene);
    assert(!strcmp(s.reader.host,"fixture-host")&&s.reader.text[0]&&!controls(A_DESKTOP));
    assert(!s.notice_count&&!s.agents[0].full[0]&&!s.agents[0].preview[0]);
    for(int i=0;i<PANE_MEMORY_MAX;i++)assert(!s.memory[i].full[0]&&!s.memory[i].preview[0]);
    dispatch(make_action(hit(A_DESKTOP,2)));assert(!visit.pending);no_remote_actions(queued,0);checks++;
    portrait(&scene,dir,"reader-original-owner-only");
    ui_draft_source(NULL);render(&scene);assert(!controls(A_DESKTOP));checks++;
    // A Read queued before a complete owner boundary cannot capture new-owner
    // data, even when that computer reused the pane ID and exact summary bytes.
    for(int notice=0;notice<2;notice++) {
        fresh();if(notice){add_result("remote","Research","owner-token",false);view(INBOX);s.offset=card("remote");}
        else view(LAUNCHER);
        stale_read=make_action(hit(A_READER,notice));
        ui_draft_source("other-host");
        if(notice){add_result("remote","Research","owner-token",false);view(INBOX);s.offset=card("remote");}
        else{COPY(s.agents[0].full,"New-owner result.");view(LAUNCHER);}
        queued=enqueued;dispatch(stale_read);assert(!s.reader.captured);no_remote_actions(queued,0);checks++;
    }
    // Current-roster membership alone never changes a notice preview into selection authority.
    fresh();add_result("design","Design","same-agent",false);read_card("design");render(&scene);
    assert(!controls(A_SELECT_BEGIN));queued=enqueued;dispatch(make_action(hit(A_SELECT_BEGIN,1)));
    assert(!selection.active);no_remote_actions(queued,0);checks++;
    // Exact explicit desktop Open may target a known off-workspace notice.
    fresh();add_result("remote","Research","open-me",false);read_card("remote");act(A_DESKTOP,2);
    assert(visit.pending&&!strcmp(visit.pending_agent,"remote")&&sent.kind==A_VISIT_SEND&&s.active==0);checks++;
}
static void unknown_owner_boundaries(void) {
    ht_scene_t scene;fresh();ui_draft_source(NULL);
    add_result("remote","Legacy Research","legacy-result",false);
    ui_project_emit("design","session","summary","A legacy summary.","Legacy.");
    read_card("remote");render(&scene);act(A_DOWN,0);render(&scene);int row=s.offset;
    uint32_t generation=s.result_generation;char saved[1024];COPY(saved,s.reader.text);
    unsigned queued=enqueued;
    ui_draft_source(NULL);ui_draft_source("");
    assert(s.result_generation==generation&&card("remote")>=0&&!strcmp(s.agents[0].full,"A legacy summary."));
    assert(!strcmp(s.reader.text,saved)&&s.offset==row&&!pro_reader_owner()&&pro_reader_source());
    ui_notif_replace(NULL,0);ui_notif_read("remote","legacy-result");assert(card("remote")>=0&&s.view==READER);
    act(A_READER_BACK,0);read_card("remote");render(&scene);assert(s.offset==row);
    assert(!controls(A_DESKTOP)&&!controls(A_SELECT_BEGIN));no_remote_actions(queued,0);checks++;
    ui_set_connected(false);assert(!s.notice_count&&s.result_generation!=generation&&!s.agents[0].full[0]);
    assert(!strcmp(s.reader.text,saved)&&!pro_reader_source());
    ui_set_connected(true);ui_draft_source(NULL);add_result("remote","A new legacy link","legacy-result",false);
    act(A_READER_BACK,0);read_card("remote");assert(s.offset==0&&!strcmp(s.reader.name,"A new legacy link"));checks++;
    // Returning to a previously named owner also must not re-authorize the old
    // immutable snapshot after an intervening different-owner result generation.
    for(int notice=0;notice<2;notice++) {
        fresh();if(notice){add_result("remote","Research","same-token",false);view(INBOX);s.offset=card("remote");}else view(LAUNCHER);
        action_t old_read=make_action(hit(A_READER,notice));dispatch(old_read);
        action_t old_open=make_action(hit(A_DESKTOP,2));
        ui_draft_source("other-host");ui_draft_source("fixture-host");
        render(&scene);assert(!pro_reader_owner()&&!controls(A_DESKTOP)&&!controls(A_SELECT_BEGIN));
        queued=enqueued;dispatch(old_open);assert(!visit.pending);no_remote_actions(queued,0);
        act(A_READER_BACK,0);
        if(notice){add_result("remote","Research","same-token",false);view(INBOX);s.offset=card("remote");}else COPY(s.agents[0].full,"The design is ready to review.");
        uint32_t serial=s.reader.serial;dispatch(old_read);assert(s.reader.serial==serial&&s.view!=READER);checks++;
    }
}
static void representative_english_reader(const char *dir) {
    ht_scene_t scene;fresh();
    COPY(s.agents[0].full,"The design review is ready. The main voice surface stays quiet, with one clear place to speak and a small Updates entry when something needs attention.\n\nThe result reader now keeps the words you opened, even when a newer update arrives. Back returns to the same card and preserves your reading position. Opening the pane on the computer remains a deliberate action.\n\nThe next review should focus on the physical screen: can a seated person read the type comfortably, find the controls without searching, and return to work without losing context? Software checks cover the boundaries, while those comfort questions still need the device.\n\nKeep the final experience simple. Let the work take the space it needs, and bring controls forward only when they are useful.");
    assert(strlen(s.agents[0].full)>500&&strlen(s.agents[0].full)<900);
    view(LAUNCHER);act(A_READER,0);render(&scene);portrait(&scene,dir,"reader-english-first");
    act(A_DOWN,0);render(&scene);assert(s.offset>0);portrait(&scene,dir,"reader-english-more");
    unsigned guard=0;while(controls(A_DOWN)&&guard++<20){act(A_DOWN,0);render(&scene);}
    assert(guard<20);portrait(&scene,dir,"reader-english-last");checks++;
}
static void unicode_and_render_boundaries(const char *dir) {
    ht_scene_t scene;fresh();memset(s.agents[0].full,'W',sizeof s.agents[0].full-1);
    s.agents[0].full[1021]=(char)0xe2;s.agents[0].full[1022]=(char)0x80;s.agents[0].full[1023]=0;
    view(LAUNCHER);act(A_READER,0);assert(strlen(s.reader.text)==1021);render(&scene);portrait(&scene,dir,"reader-max-summary");
    act(A_DOWN,0);render(&scene);assert(s.offset>0);portrait(&scene,dir,"reader-max-summary-scrolled");checks++;
    fresh();COPY(s.agents[0].full,"A complete UTF-8 ellipsis stays intact: \xe2\x80\xa6");view(LAUNCHER);act(A_READER,0);
    assert(!strcmp(s.reader.text,s.agents[0].full));render(&scene);checks++;
    fresh();s.agents[0].full[0]=0;view(LAUNCHER);act(A_READER,0);render(&scene);
    assert(s.reader.captured&&!s.reader.text[0]&&!controls(A_DOWN));checks++;
}
int main(int argc,char **argv) {
    const char *dir=argc>1?argv[1]:NULL;
    gates_and_exact_snapshot(dir);frozen_normal_reader(dir);receipts_and_return_position(dir);
    stale_actions_and_owner(dir);unknown_owner_boundaries();representative_english_reader(dir);unicode_and_render_boundaries(dir);
    printf("Pro frozen reader: PASS (%u actual-handler/owner/occurrence checks; no real cable or focus)\n",checks);
}
'''
with tempfile.TemporaryDirectory(prefix="harness-pro-reader-") as directory:
    build = Path(directory)
    (build / "reader.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "reader.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        *[str(NATIVE / (name + ".c")) for name in ("visit", "carry", "workspace", "form", "draft", "selection", "gestures")],
        "-o", str(build / "reader"),
    ], check=True)
    args = [str(build / "reader")]
    if os.environ.get("HABITAT_PRO_PREVIEW_DIR"):
        destination = Path(os.environ["HABITAT_PRO_PREVIEW_DIR"])
        destination.mkdir(parents=True, exist_ok=True)
        args.append(str(destination))
    subprocess.run(args, check=True)
