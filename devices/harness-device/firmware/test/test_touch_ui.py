"""Replay physical contacts through the production Habitat handler and render its actual scenes."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import defines, typedef

here = Path(__file__).resolve().parent
native = here / '../main/ui/habitat'
source = Path(os.environ.get('UI_SOURCE', native / 'ui_habitat.c')).read_text()
def function(name):
    m = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert m, name
    body = m.group(0)
    if name == 'control':
        body = body.replace('{', "{\n    if (label[0] == '[') assert(ht_can_display(label, UI_FONT, w, 1));", 1)
    return body + '\n'

code = r'''
#include "runtime.h"
#include "../../cable_features.h"
#include "gestures.h"
#include "scroll.h"
#include "selection.h"
#include "carry.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "octopus.h"
#include "character.h"
#include "workspace.h"
#include "command_face.h"
#include "arc_geometry.inc"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
'''
# Keep real protocol capacities: a larger fake buffer can hide target truncation.
code += defines('CABLE_READ_TOKEN_MAX','ID_MAX','CABLE_NAME_MAX','SWARM_ID_MAX','SWARMS_MAX','CABLE_MAX_AGENTS','MAX_PROJECTS')
code += defines('NOTICES','QUESTION_MAX','OPTION_MAX','PANE_MEMORY_MAX','UI_FONT','Q_ROWS','DRAFT_ROWS',source=source)
if '#define PANE_RESULT_BYTES ' in source:
    code += defines('PANE_RESULT_BYTES', source=source)
code += '\n'.join(re.findall(r'^#define TAB_\w+ \d+$', source, re.M)) + '\n'
code += source[source.index('typedef enum {'):source.index('static EXT_RAM_BSS_ATTR struct {')]
code += typedef('cable_swarm_t') + typedef('cable_notif_t')
code += r'''
static struct {
    bool ready, locked, connected, loading, voice_open, voice_start_pending, voice_waiting, voice_carry, voice_review, voice_draft_append, voice_review_preview, voice_search;
    bool coasting, touch_brake, touch_down, touch_cancelled, pattern_error, lock_armed, quiet, nap, rim_enabled, focus_face, straight_title, muted;
    int brightness;
    char pattern[32], voice_target[CABLE_NAME_MAX];
    int pattern_mask, pattern_len, view, voice_return, offset, active, count, pressed, hit_count;
    int draft_drag, tab_drag, start_x, start_y, last_x, last_y, tab_count, machine_count, model_count, notice_count, pet_pose;
    uint32_t touch_started, coast_until, character_activity, pet_until, last_celebration;
    uint32_t notice_sequence, voice_retry_until;
    uint8_t status_phase;
    cable_swarm_t tabs[SWARMS_MAX];
    struct { char id[64], name[96], state[16]; bool local; } machines[2];
    char selected_tab[ID_MAX], pending_focus[ID_MAX], opening_notice[ID_MAX], title[80], message[256];
    cable_notif_t notice[NOTICES];
    notice_receipt_t notice_reads[NOTICES];
    uint8_t notice_read_next;
    uint32_t notice_revision, notice_frame;
    pane_memory_t memory[PANE_MEMORY_MAX];
    uint32_t memory_serial;
    struct { char id[192]; } models[2];
    char model_agent[64];
    question_t q;
    agent_t agents[MAX_PROJECTS]; hit_t hits[24];
    ht_rect_t caption_arc;
} s;
static ht_gesture_t gesture;
static ht_character_t character;
static ht_character_caption_t home_caption;
static ht_character_id_t test_character;
static int character_saves, saved_character;
static unsigned notice_reads_sent; static action_t notice_read_queued;
static ht_scroll_t scroll;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static action_t visit_queued;
static int visit_sends,visit_wire;
static char visit_wire_op[16];
static bool question_pending;
static bool visit_emit(const ht_visit_command_t *c,void *ctx);
static ht_form_t form;
static ht_draft_t draft;
static ht_workspace_t workspace;
static ht_tab_carousel_t tab_carousel;
static int tab_switches;
static char tab_target[64];
static action_t tab_queued;
static int draft_actions, reviews;
static ht_draft_command_t draft_command;
static bool draft_emit(const ht_draft_command_t *c, void *ctx) { (void)ctx; draft_command=*c; draft_actions++; return true; }
static ht_select_command_t selected_command;
static int selections;
static int carry_prepares, carry_drops, question_sends, desktop_opens;
static char opened_agent[64];
static char voice_context[48];
static bool scroll_reversed, congestion, recording;
static uint32_t host_features = 31;
static bool cable_client_supports(uint32_t features) { return (host_features & features) == features; }
typedef struct cJSON { const char *string,*valuestring; int type; struct cJSON *child,*next; } cJSON;
enum { JSTRING=1,JTRUE=2 };
static bool cJSON_IsString(const cJSON *v) { return v && v->type==JSTRING; }
static bool cJSON_IsTrue(const cJSON *v) { return v && v->type==JTRUE; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *key) {
    for(const cJSON *p=v?v->child:NULL;p;p=p->next) if(p->string && !strcmp(p->string,key)) return p;
    return NULL;
}
static action_t pressed_action;
static int returns, form_actions;
static ht_form_command_t form_command;
static bool form_emit(const ht_form_command_t *c, void *ctx) {
    (void)ctx; form_command=*c; form_actions++; return true;
}
static int starts, stops, boops, switches, down_reports, moves, ups, travel, waiting_count;
static char target[64];
#define COPY(dst, src) snprintf(dst, sizeof(dst), "%s", src)
#include "theme.h"
static uint16_t color(unsigned rgb);
static unsigned preview_brightness = 100;
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define ERROR color(HT_THEME_ERROR)
#define SEL color(HT_THEME_SELECTION)
#define ESP_LOGI(...) ((void)0)
#define EXT_RAM_BSS_ATTR
static void change(void) {}
static void display_lock(void) {}
static void display_unlock(void) {}
static void display_wake(void) {}
static bool config_check_lock(const char *s_) { (void)s_; return false; }
static bool fake_asleep, present_scene=true;
static bool display_is_asleep(void) { return fake_asleep; }
static bool audio_client_active(void) { return recording; }
static bool audio_client_recording(void) { return recording; }
static unsigned audio_client_input_level(void) { return 3; }
static agent_t *active(void) { return s.active >= 0 && s.active < s.count ? &s.agents[s.active] : NULL; }
static int find(const char *id);
static bool is_question(const char *id) { (void)id; return question_pending; }
static void open_question(void) { s.view=QUESTION; }
static bool visit_emit(const ht_visit_command_t *c,void *ctx) {
    (void)ctx; if(congestion)return false;
    visit_queued=(action_t){.kind=A_VISIT_SEND,.value=c->op,.revision=c->request};
    COPY(visit_queued.id,c->agent); COPY(visit_queued.text,c->id); visit_sends++; return true;
}
static void cable_client_visit(const char *id,uint32_t request,const char *op,const char *agent) {
    assert(id[0] && request); (void)agent; COPY(visit_wire_op,op); visit_wire++;
}
static int waiting(void) { return waiting_count; }
static int working(void) { return s.agents[0].busy + s.agents[1].busy; }
static bool select_emit(const ht_select_command_t *c, void *ctx) {
    (void)ctx; if (congestion) return false; selected_command=*c; selections++; return true;
}
static bool carry_emit(const ht_carry_command_t *c, void *ctx) {
    (void)ctx; if (congestion) return false;
    if (c->cancel) carry_drops++;
    else { carry_prepares++; assert(!strcmp(c->selection,"pick-test") && !strcmp(c->agent,"a")); }
    return true;
}
static uint32_t fake_ms;
static uint32_t ms(void) { return fake_ms ? fake_ms : gesture.began+75; }
static uint32_t esp_random(void) { return 123; }
static bool queue(action_t a) {
    if (congestion) return false;
    if (a.kind==A_CHARACTER_SAVE) { character_saves++; saved_character=a.value; }
    if (a.kind==A_ANSWER) question_sends++;
    if (a.kind==A_TAB) { tab_switches++; COPY(tab_target,a.id); tab_queued=a; }
    if (a.kind==A_TAB_REFRESH) tab_queued=a;
    if (a.kind==A_NOTICE_READ) { notice_reads_sent++; notice_read_queued=a; }
    if (a.kind==A_DESKTOP) { desktop_opens++; COPY(opened_agent,a.id); }
    return true;
}
static bool scroll_emit(ht_scroll_phase_t phase, int dy, int velocity, void *ctx) {
    (void)velocity; (void)ctx;
    if (congestion) return false;
    if (phase == HT_SCROLL_DOWN) down_reports++;
    if (phase == HT_SCROLL_MOVE) { moves++; travel += dy; }
    if (phase == HT_SCROLL_UP) { ups++; travel += dy; }
    return true;
}
'''
code += function('color')
code += function('settings_item') + function('settings_count') + function('hit_contains')
code += function('find')
for name in ['copy', 'recap_preview', 'notice_unread', 'notice_was_read', 'notice_forget_read', 'notice_flush_reads', 'notice_mark_read', 'habitat_scene_receipt', 'habitat_scene_presented', 'pane_memory', 'pane_memory_apply', 'dismiss_result', 'activity_text', 'ensure', 'input_cancel', 'view', 'notice_open', 'workspace_index', 'tabs_open', 'workspace_failed', 'ui_scroll_reportable', 'control', 'home_footer', 'footer_control', 'text', 'center', 'render_brand', 'heading', 'render_companion', 'choose_character', 'question_view', 'question_rows', 'question_move', 'question_text', 'render_question', 'render_choices', 'render_answer_review', 'question_answer', 'send_answer', 'make_action', 'character_mood', 'voice_status', 'home_caption_rotates', 'home_caption_tick', 'status_animated', 'status_speed', 'status_wake_ms', 'surface_tick', 'command_face', 'render_workspace_preview', 'render_home', 'render_voice', 'render_selection', 'render_form', 'draft_move', 'render_draft', 'render_draft_options', 'ui_swarms_replace', 'ui_workspace_applied', 'ui_land_after_reload']:
    code += function(name)
code += function('render_settings') + function('ui_visit_state')
code += function('ui_project_known') + function('ui_focus_project') + function('ui_apply_pending_focus')
code += function('render_agents') + function('tabs_move') + function('tab_name') + function('render_tabs') + function('page_controls') + function('render_notice') + function('render_list')
for name in ['notice_remove', 'notice_sync_view', 'notice_selection', 'notice_restore_selection', 'notice_add', 'ui_notify_task_done', 'ui_notif_seen', 'ui_notif_read', 'ui_notif_replace', 'ui_notif_open', 'ui_question_close', 'ui_answer_receipt']:
    code += function(name)
for name in ['event', 'ui_project_emit', 'ui_project_restore_event', 'ui_project_clear_event', 'ui_project_set_name', 'ui_project_remove', 'ui_project_clear_all', 'ui_project_apply_order']:
    code += function(name)
visit_actions=source.split('    case A_LATEST:',1)[1].split('    case A_TABS:',1)[0]
code+='static void visit_action(action_t a) { switch(a.kind) { case A_LATEST:'+visit_actions+'default: break; } }\n'
notice_actions=source.split('    case A_NOTICE:',1)[1].split('    case A_LATEST:',1)[0]
code+='static void notice_action(action_t a) { switch(a.kind) { case A_NOTICE:'+notice_actions+'default: break; } }\n'
desktop_actions=source.split('    case A_DESKTOP:',1)[1].split('    case A_UP:',1)[0]
code+='static void desktop_action(action_t a) { switch(a.kind) { case A_DESKTOP:'+desktop_actions+'default: break; } }\n'
visit_worker=source.split('static void worker(',1)[1].split('        case A_VISIT_SEND:',1)[1].split('        case A_SELECT_SEND:',1)[0]
code+='static void visit_work(action_t a) { switch(a.kind) { case A_VISIT_SEND:'+visit_worker+'default: break; } }\n'
carry_actions = source.split('case A_CARRY:\n',1)[1].split('case A_COMPANION:',1)[0]
code += 'static void carry_action(action_t a) { switch(a.kind) { case A_CARRY:\n' + carry_actions + 'default: break; } }\n'
code += 'static void dispatch(action_t a);\n'
question_actions = source.split('    case A_QUESTION_CHOICES:\n',1)[1].split('    case A_INBOX:',1)[0]
code += 'static void question_action(action_t a) { switch(a.kind) { case A_QUESTION_CHOICES:\n'+question_actions+'default: break; } }\n'
draft_actions = source.split('    case A_DRAFT_EDIT:\n',1)[1].split('    case A_HOME:',1)[0]
code += 'static void draft_action(action_t a) { switch(a.kind) { case A_DRAFT_EDIT:\n'+draft_actions+'default: break; } }\n'
form_actions = source.split('    case A_FIND:\n    case A_FORM:',1)[1].split('    case A_SETTINGS:',1)[0]
code += 'static void form_action(action_t a) { switch(a.kind) { case A_FIND:\n    case A_FORM:'+form_actions+'default: break; } }\n'
workspace_actions = source.split('    case A_TABS:',1)[1].split('    case A_MACHINE:',1)[0]
code += 'static void workspace_action(action_t a) { switch(a.kind) { case A_TABS:'+workspace_actions+'default: break; } }\n'
page_actions = source.split('    case A_UP:',1)[1].split('    case A_LOCK:',1)[0]
code += 'static void page_action(action_t a) { switch(a.kind) { case A_UP:'+page_actions+'default: break; } }\n'
code += r'''
static void dispatch(action_t a) {
    if ((s.view==DRAFT || s.view==DRAFT_OPTIONS) && a.kind!=A_VOICE) { draft_action(a); return; }
    if (question_view(s.view) && a.kind!=A_VOICE) { question_action(a); return; }
    if (a.kind==A_CARRY || a.kind==A_CARRY_DROP) { carry_action(a); return; }
    if (a.kind == A_FIND || a.kind == A_FORM || a.kind == A_FORM_MAIN || a.kind == A_FORM_BACK || a.kind == A_FORM_SAY) {
        form_action(a);
    } else if (a.kind == A_SELECT_FIND) { a.kind=A_VOICE; a.value=7; dispatch(a);
    } else if (a.kind == A_VOICE) {
        starts++; COPY(target, a.id); COPY(s.voice_target, a.value==7 ? "Find in output" : active()->name);
        s.voice_carry=a.value==3; s.voice_search=a.value==7; COPY(voice_context,a.text);
        s.voice_return=s.view; s.voice_open = recording = true; view(VOICE);
    } else if (a.kind == A_VOICE_STOP) { stops++; if(a.value==1)reviews++; recording = false; }
    else if (a.kind == A_VOICE_ABORT) { recording = s.voice_open = false; view(HOME); }
    else if (a.kind == A_RETURN || a.kind == A_LATEST) { if(a.kind==A_RETURN)returns++; visit_action(a); }
    else if (a.kind == A_PET) boops++;
    else if (a.kind == A_AGENT) {
        switches++; s.active = !strcmp(a.id, "b") ? 1 : 0; view(AGENT);
    } else if (a.kind == A_CHARACTER) choose_character(a.value);
    else if (a.kind == A_COMPANION) view(COMPANION);
    else if (a.kind == A_SETTINGS) view(SETTINGS);
    else if (a.kind == A_FIND) view(FORM);
    else if (a.kind == A_AGENTS) view(AGENTS);
    else if (a.kind == A_INBOX) notice_open();
    else if (a.kind == A_HOME) view(HOME);
    else if (a.kind == A_NOTICE) notice_action(a);
    else if (a.kind == A_RECAP_DISMISS) dismiss_result(a.id);
    else if (a.kind == A_DESKTOP) desktop_action(a);
    else if (a.kind == A_UP || a.kind == A_DOWN) page_action(a);
    else if (a.kind == A_TABS || a.kind == A_TAB) workspace_action(a);
    else if (a.kind == A_SELECT_BEGIN) {
        view(SELECTION); ht_selection_open(&selection,"pick-test",active()->id,1800,select_emit,NULL);
    } else if (a.kind == A_SELECT_EXTEND) ht_selection_extend(&selection,3000);
}
'''
code += function('habitat_touch') + function('habitat_touch_cancel')
code += r'''
static ht_scene_t scene;
static void scene_take(void) {
    ht_scene_clear(&scene, BG); s.hit_count = 0; s.notice_frame = 0;
    if (s.view == OTA) render_brand(&scene);
    else if (s.view == DRAFT) render_draft(&scene);
    else if (s.view == DRAFT_OPTIONS) render_draft_options(&scene);
    else if (s.view == QUESTION) render_question(&scene);
    else if (s.view == CHOICE) render_choices(&scene);
    else if (s.view == ANSWER_REVIEW) render_answer_review(&scene);
    else if (s.view == FORM) render_form(&scene);
    else if (s.view == VOICE) render_voice(&scene);
    else if (s.view == COMPANION) render_companion(&scene);
    else if (s.view == TABS || s.view == INBOX || s.view == MACHINES) render_list(&scene);
    else if (s.view == AGENTS) render_agents(&scene);
    else if (s.view == SELECTION) render_selection(&scene); else render_home(&scene);
    if (s.view == SETTINGS) { ht_scene_clear(&scene,BG); s.hit_count=0; render_settings(&scene); }
    if (present_scene) habitat_scene_presented(habitat_scene_receipt());
}
static void reset(void) {
    host_features=31; fake_ms=0; fake_asleep=false; present_scene=true;
    memset(&visit,0,sizeof visit); visit_sends=visit_wire=returns=0; question_pending=false;
    memset(&tab_carousel,0,sizeof tab_carousel);
    memset(&workspace,0,sizeof workspace); tab_switches=0; tab_target[0]=0;
    memset(&selection,0,sizeof(selection)); selections=0;
    memset(&carry,0,sizeof(carry)); carry_prepares=carry_drops=0; voice_context[0]=0;
    ht_draft_reset(&draft); draft_actions=reviews=0; ht_form_reset(&form); form_actions=0;
    memset(&home_caption,0,sizeof home_caption); memset(&character,0,sizeof character); ht_character_select(&character,test_character); character_saves=0; saved_character=-1; memset(&s, 0, sizeof(s)); memset(&gesture, 0, sizeof(gesture)); memset(&scroll, 0, sizeof(scroll));
    s.ready = s.connected = true; s.count = 2; s.active = 0; s.view = HOME; s.pressed = -1;
    s.brightness = preview_brightness;
    strcpy(s.agents[0].id, "a"); strcpy(s.agents[1].id, "b");
    strcpy(s.agents[0].name, "Deploy latest firmware"); strcpy(s.agents[1].name, "Agent B");
    recording = congestion = false; starts = stops = boops = switches = question_sends = 0;
    down_reports = moves = ups = travel = waiting_count = 0; target[0] = 0;
    desktop_opens=0; opened_agent[0]=0; notice_reads_sent=0;
    scene_take();
}
static void workspace_setup(void) {
    reset(); s.tab_count=4; strcpy(s.selected_tab,"tab-1");
    static const char *names[]={"M2","Product","Device","Research"};
    for(int i=0;i<s.tab_count;i++) {
        snprintf(s.tabs[i].id,sizeof s.tabs[i].id,"tab-%d",i);
        snprintf(s.tabs[i].name,sizeof s.tabs[i].name,"%s",names[i]);
        s.tabs[i].panes=i;
    }
    scene_take();
}
static void tap(uint32_t t, int x, int y) {
    habitat_touch(true, x, y, t);
    habitat_touch(false, x, y, t + 75);
    scene_take();
}
static bool action_enabled(action_kind_t action) {
    for (int i=0;i<s.hit_count;i++) if (s.hits[i].action==action) return s.hits[i].enabled;
    return false;
}
static bool status_is(const char *text) {
    if (!text[0]) {
        for(int i=0;i<scene.count;i++) if(scene.runs[i].arc==2 || scene.runs[i].y==385 || scene.runs[i].y==HT_NOTIFICATION_Y) return false;
        return true;
    }
    char footer[32]="";
    for (int i=0;i<scene.count;i++) if(scene.runs[i].y==HT_NOTIFICATION_Y) {
        if(footer[0]) strcat(footer," ");
        assert(strlen(footer)+strlen(scene.runs[i].text)<sizeof footer);
        strcat(footer,scene.runs[i].text);
    }
    if(footer[0] && !strcmp(footer,text)) return true;
    for (int i=0;i<scene.count;i++)
        if ((scene.runs[i].arc==2 || scene.runs[i].y==385 || scene.runs[i].y==HT_NOTIFICATION_Y) &&
            !strcmp(scene.runs[i].text,text)) return true;
    return false;
}
static bool inbox_mark_is(const char *mark, uint16_t ink) {
    for (int i=0;i<scene.count;i++) if(!strcmp(scene.runs[i].text,mark))
        return scene.runs[i].fg==ink && scene.runs[i].font==&ht_mono_28;
    return false;
}
static bool title_is(const char *text) {
    for(int i=0;i<scene.count;i++)
        if((scene.runs[i].arc==1 || (s.straight_title && scene.runs[i].y==41)) && !strcmp(scene.runs[i].text,text)) return true;
    return false;
}
static void portrait(const char *dir, const char *name) {
    if (!dir) return;
    char path[1024]; snprintf(path, sizeof(path), "%s/%s.ppm", dir, name);
    FILE *fp = fopen(path, "wb"); assert(fp);
    fprintf(fp, "P6\n466 466\n255\n");
    uint16_t row[466];
    for (int y=0; y<466; y++) {
        ht_raster(&scene, (ht_rect_t){0,y,466,1}, row);
        for (int x=0; x<466; x++) {
            uint16_t c = (uint16_t)((row[x] >> 8) | (row[x] << 8));
            unsigned char rgb[3] = {(unsigned char)(((c>>11)&31)*255/31),
                (unsigned char)(((c>>5)&63)*255/63),(unsigned char)((c&31)*255/31)};
            if ((x-233)*(x-233)+(y-233)*(y-233)>233*233) memset(rgb, 0, 3);
            fwrite(rgb, 1, 3, fp);
        }
    }
    fclose(fp);
}
static void carry_return_setup(bool with_text) {
    reset();
    assert(ht_visit_latest(&visit,"reading-return","a",100,visit_emit,NULL));
    assert(ht_visit_reply(&visit,visit.id,visit.request,true,"Your reading"));
    if(with_text) {
        ht_carry_open(&carry,"carried-passage","a","pick-test",1,200,carry_emit,NULL);
        assert(ht_carry_reply(&carry,carry.id,carry.request,true,"Research helper","Keep this paragraph",3,300000,NULL,250));
    }
    scene_take();
}
static bool result_visible(void) {
    for (int i=0;i<scene.count;i++) if ((scene.runs[i].font->height<=6 && strlen(scene.runs[i].text)>=32)) return true;
    return false;
}static void recap_checks(const char *dir) {
    // The live row has always received the 1,024-byte memory record's prefix.
    // Exercise actual production capacities before/after removing unused tail
    // storage, and preserve all fields through full-roster permutations.
    static char complete[8193];
    static const size_t lengths[] = {0, 1, 239, 1023, 1024, 4095, 8192};
    for (unsigned sample=0; sample<sizeof lengths/sizeof lengths[0]; sample++) {
        reset();
        size_t len=lengths[sample];
        for (size_t i=0;i<len;i++) complete[i]=(char)('a'+i%26);
        complete[len]=0;
        ui_project_emit("a","session-a","summary",complete,"Visible recap.");
        const char *want=len?complete:"Visible recap.";
        size_t kept=strlen(want);
        if (kept>=sizeof s.memory[0].full) kept=sizeof s.memory[0].full-1;
        assert(strlen(s.agents[0].full)==kept && !memcmp(s.agents[0].full,want,kept));
        assert(!strcmp(s.agents[0].preview,"Visible recap."));
    }
    reset(); ui_project_clear_all();
    char ids[MAX_PROJECTS][ID_MAX]; const char *order[MAX_PROJECTS];
    for (int i=0;i<MAX_PROJECTS;i++) {
        snprintf(ids[i],sizeof ids[i],"pane-%d",i);
        ui_project_set_name(ids[i],ids[i]);
        ui_project_emit(ids[i],ids[i],"summary",ids[i],ids[i]);
    }
    s.active=MAX_PROJECTS/2;
    for (int pass=0;pass<64;pass++) {
        for (int i=0;i<MAX_PROJECTS;i++) order[i]=ids[(MAX_PROJECTS-1-i+pass)%MAX_PROJECTS];
        ui_project_apply_order(order,MAX_PROJECTS);
        assert(!strcmp(s.agents[s.active].id,ids[MAX_PROJECTS/2]));
        for (int i=0;i<MAX_PROJECTS;i++) {
            assert(!strcmp(s.agents[i].id,order[i]));
            assert(!strcmp(s.agents[i].name,order[i]));
            assert(!strcmp(s.agents[i].full,order[i]));
            assert(!strcmp(s.agents[i].preview,order[i]));
        }
    }
    printf("roster storage: sizeof(agent_t)=%zu; full=%zu; exact result prefixes and 64 full-roster permutations PASS\n", sizeof(agent_t),sizeof s.agents[0].full);
    reset();
    char preview[32];
    activity_text(preview,sizeof preview,"Wandering..."); assert(!strcmp(preview,"Wandering"));
    activity_text(preview,sizeof preview,"Coalescing\xe2\x80\xa6"); assert(!strcmp(preview,"Coalescing"));
    activity_text(preview,sizeof preview,"Working"); assert(!strcmp(preview,"Working"));
    activity_text(preview,sizeof preview,"A...B"); assert(!strcmp(preview,"A...B"));
    activity_text(preview,sizeof preview,"  Working ... \n"); assert(!strcmp(preview,"Working"));
    activity_text(preview,sizeof preview,"\tMessages to be submitted after "); assert(!strcmp(preview,"Messages to be submitted after"));
    recap_preview(preview,sizeof preview," \nFixed\t the\r\nparser.  ");
    assert(!strcmp(preview,"Fixed the parser."));
    recap_preview(preview,5,"caf\xc3\xa9"); assert(!strcmp(preview,"caf"));
    recap_preview(preview,6,"caf\xc3\xa9"); assert(!strcmp(preview,"caf\xc3\xa9"));
    recap_preview(preview,sizeof preview," \t\r\n"); assert(!preview[0]);
    recap_preview(preview,sizeof preview,"bad\xe2"); assert(!strcmp(preview,"bad?"));
    recap_preview(preview,1,"x"); assert(!preview[0]);
    recap_preview(preview,sizeof preview,"Details continue\xe2\x80\xa6"); assert(!strcmp(preview,"Details continue +"));
    recap_preview(preview,sizeof preview,"Details continue+"); assert(!strcmp(preview,"Details continue +"));
    recap_preview(preview,sizeof preview,"Details continue +"); assert(!strcmp(preview,"Details continue +"));
    recap_preview(preview,sizeof preview,"Written in C++"); assert(!strcmp(preview,"Written in C++"));
    recap_preview(preview,sizeof preview,"Wait... then proceed."); assert(!strcmp(preview,"Wait... then proceed."));

    reset();
    ui_project_emit("a","session-a","summary","It isn't external. That is the branch name.","It isn't external.");
    scene_take(); portrait(dir,"complete-sentence");
    ui_project_emit("a","session-a","summary","Yes. The fix is installed.","Yes. The fix is installed.");
    scene_take(); portrait(dir,"acknowledgment-explanation");
    ui_project_emit("a","session-a","summary","Yes. The fix is installed and the device has reconnected successfully to the desktop application.","Yes. The fix is installed and the device has reconnected successfully to the+");
    scene_take(); portrait(dir,"continued-sentence");
    ui_project_emit("a","session-a","summary","Fixed the parser. All tests pass. Voice input now sends to the selected agent. More details follow.","Fixed the parser. All tests pass. Voice input now sends to the selected agent.");
    scene_take(); portrait(dir,"three-sentences");
    const char *long_result="The update is installed. Voice input sends to the selected agent. The summary has more room, the octopus is larger, and unread messages open from the bottom edge of the screen.";
    assert(strlen(long_result)>160);
    ui_project_emit("a","session-a","summary",long_result,long_result);
    scene_take(); portrait(dir,"long-reading");
    char visible[400]="";
    for(int i=0;i<scene.count;i++) if(scene.runs[i].font==&ht_mono_28 && !scene.runs[i].arc && scene.runs[i].y>=HT_CHARACTER_READING_TEXT_Y && scene.runs[i].y<400) {
        if(visible[0] && scene.runs[i].text[0])strcat(visible," ");
        strcat(visible,scene.runs[i].text);
    }
    assert(strlen(visible)>60 && strlen(visible)<=HT_CHARACTER_RECAP_CHARS);
    for(int i=0;i<scene.count;i++) assert(scene.runs[i].font!=&ht_nav_32 && scene.runs[i].font!=&ht_open_20);
    assert(strstr(visible,"...") && !strcmp(s.agents[0].full,long_result));
    ui_notify_task_done("b","Other pane","M2","The checks passed.");
    scene_take(); portrait(dir,"long-reading-inbox");
    ui_project_emit("a","session-a","summary","\xe2\x80\x9cReady\xe2\x80\x9d \xe2\x80\x94 don\xe2\x80\x99t change the \xe2\x80\x9c" "cache\xe2\x80\x9d.","\xe2\x80\x9cReady\xe2\x80\x9d \xe2\x80\x94 don\xe2\x80\x99t change the \xe2\x80\x9c" "cache\xe2\x80\x9d.");
    scene_take(); portrait(dir,"punctuation");
    const char *growth="Egg → developing cracks → hatch → baby Tim → growing Tim → adult Tim.";
    ui_project_emit("a","session-a","summary",growth,growth);
    scene_take(); portrait(dir,"growth-arrows");

    reset();
    ui_project_emit("a","session-a","processing",NULL,NULL);
    ui_project_emit("a","session-a","summary","Full explanation in the reader.","Fixed the parser. All tests pass.");
    scene_take(); assert(result_visible()); portrait(dir,"completed");
    assert(!strcmp(s.agents[0].preview,"Fixed the parser. All tests pass."));
    assert(!strcmp(s.agents[0].full,"Full explanation in the reader."));
    surface_tick(60000); scene_take(); assert(result_visible()); // no timed dismissal
    ui_project_emit("b","session-b","summary","Another agent's result.","Updated the website.");
    scene_take(); assert(result_visible() && s.active==0);
    bool recipient_above=false;
    for(int i=0;i<scene.count;i++) {
        const ht_run_t *r=&scene.runs[i];
        if(!strcmp(r->text,"Deploy latest firmware")) {
            assert(r->arc==1);
            recipient_above=true;
        }
    }
    assert(recipient_above);
    tap(61000,233,310); // The same central tap starts voice over a summary.
    assert(!desktop_opens && starts==1 && s.view==VOICE && !result_visible());
    scene_take(); portrait(dir,"summary-listening");
    bool large=false;
    for(int i=0;i<scene.count;i++) if(scene.runs[i].font->height>=10 && scene.runs[i].font->height<=12 && strlen(scene.runs[i].text)>=50)large=true;
    assert(large);
    dispatch((action_t){.kind=A_VOICE_ABORT}); scene_take(); assert(result_visible());
    ui_project_restore_event("a","summary","Full explanation in the reader.","Fixed the parser. All tests pass.");
    scene_take(); assert(result_visible()); // Recording never dismisses the result.
    ui_project_emit("a","session-a","summary","Full explanation in the reader.","Fixed the parser. All tests pass.");
    scene_take(); assert(result_visible());
    tap(61600,233,150); // The small portrait has its own target above the summary.
    assert(starts==2 && !strcmp(target,"a") && s.view==VOICE && !result_visible());
    portrait(dir,"completed-listening");
    tap(62600,233,220); assert(stops==1);
    dispatch((action_t){.kind=A_VOICE_ABORT}); scene_take(); assert(result_visible());
    ui_project_emit("a","session-a","processing",NULL,NULL);
    scene_take(); assert(!result_visible()); portrait(dir,"next-turn");
    ui_project_restore_event("a","summary","Old restored answer.","Old restored recap.");
    scene_take(); assert(!result_visible() && s.agents[0].busy);
    assert(!strcmp(s.agents[0].preview,"Fixed the parser. All tests pass."));
    ui_project_emit("a","session-a","done",NULL,NULL);
    scene_take(); assert(!result_visible()); // Done alone cannot resurrect the previous turn.
    ui_project_restore_event("a","summary","Fixed the parser. All tests pass.","Fixed the parser. All tests pass.");
    scene_take(); assert(!result_visible());
    ui_project_emit("a","session-a","summary","Patched the voice handler.","Patched the voice handler.");
    scene_take(); assert(result_visible());
    waiting_count=1; scene_take(); assert(result_visible()); portrait(dir,"completed-attention");
    waiting_count=0; s.connected=false; scene_take(); assert(!result_visible());
    s.connected=true; s.loading=true; scene_take(); assert(!result_visible());
    s.loading=false; s.nap=true; scene_take(); assert(!result_visible());
    s.nap=false; carry.active=true; scene_take(); assert(!result_visible());
    carry.active=false; scene_take(); assert(result_visible());
    // Scrolling and switching work across the smaller portrait and outcome.
    habitat_touch(true,233,310,63000); habitat_touch(true,233,250,63050);
    habitat_touch(false,233,250,63100); assert(moves && starts==2);
    s.coasting=false; s.coast_until=0;
    habitat_touch(true,320,220,64000); habitat_touch(false,150,220,64120);
    scene_take(); assert(switches==1 && s.active==1 && result_visible());
    assert(!strcmp(s.agents[1].preview,"Updated the website."));
    ui_project_clear_event("b"); scene_take(); assert(!result_visible());
    ui_project_restore_event("b","summary","Cached completion.","Cached completion.");
    scene_take(); assert(result_visible());
    ui_project_emit("b",NULL,"summary"," \n",NULL); scene_take(); assert(result_visible());
    // A recap gesture remains pinned and cannot open a different pane on release.
    reset(); ui_project_emit("a","session-a","summary","Fixed.","Fixed."); scene_take();
    habitat_touch(true,233,285,65000); s.active=1; input_cancel();
    habitat_touch(false,233,285,65100); assert(!desktop_opens && !starts);
    // Reading motion still scrolls; returning to its origin never opens or talks.
    reset(); ui_project_emit("a","session-a","summary","Fixed.","Fixed."); scene_take();
    habitat_touch(true,233,285,66000); habitat_touch(true,233,225,66040);
    habitat_touch(true,233,285,66080); habitat_touch(false,233,285,66120);
    assert(moves && !desktop_opens && !starts);
    reset();
}
static void notice_checks(const char *dir) {
    // Opening a read notification must not present its recap a second time.
    // Exercise either receipt order, panes outside the current roster, and a
    // notification restored before that pane's result history has arrived.
    for(int off_tab=0;off_tab<2;off_tab++) for(int cached=0;cached<2;cached++)
    for(int seen_first=0;seen_first<2;seen_first++) {
        reset();
        const char *id=off_tab ? "outside" : "a";
        const char *result="The build is installed. All checks passed.";
        if(cached) ui_project_emit(id,"session","summary",result,result);
        ui_notify_task_done(id,"Build","M2",result);
        ui_notify_task_done("b","Another pane","M2","The website is ready.");
        ui_notif_open(); s.offset=1; scene_take();
        tap(1000,233,340);
        assert(desktop_opens==1 && !strcmp(opened_agent,id));
        assert(s.notice_count==2 && s.view==INBOX); // wait for host acknowledgement
        ui_apply_pending_focus();
        assert(s.view==INBOX); // a periodic roster refresh is not an open receipt
        if(seen_first) ui_notif_seen(id);
        else ui_focus_project(id);
        if(off_tab) {
            assert(find(id)<0); // opening never fabricates a local roster row
            ui_project_set_name(id,"Build");
            ui_apply_pending_focus();
        }
        if(seen_first) ui_focus_project(id);
        else ui_notif_seen(id);
        scene_take();
        assert(active() && !strcmp(active()->id,id) && s.view==HOME);
        assert(s.notice_count==1 && !result_visible() && !starts && !question_sends);
        // History fills the reader, while the already-read recap stays hidden.
        ui_project_restore_event(id,"summary",result,result);
        scene_take(); assert(!result_visible() && !strcmp(active()->full,result));
        ui_project_remove(id); ui_project_set_name(id,"Build"); ui_focus_project(id);
        ui_project_restore_event(id,"summary",result,result);
        scene_take(); assert(!result_visible());
        if(!off_tab && cached && !seen_first) portrait(dir,"notification-opened");
        ui_project_emit(id,"session","processing","Working",NULL);
        ui_project_emit(id,"session","done",NULL,NULL);
        ui_project_emit(id,"session","summary","The next change is ready.","The next change is ready.");
        scene_take(); assert(result_visible());
    }
    // A refused local queue keeps the result/card available; viewing still clears its bell count.
    reset();
    ui_project_emit("a","session","summary","The build is ready.","The build is ready.");
    ui_notify_task_done("a","Build","M2","The build is ready.");
    ui_notif_open(); congestion=true;
    dispatch((action_t){.kind=A_NOTICE,.id="a"});
    assert(!desktop_opens && !s.pending_focus[0] && !s.opening_notice[0] && s.notice_count==1);
    assert(s.agents[0].recap_ready && !pane_memory("a",false)->dismissed);
    // Reading a question is never an approval or a completed-result dismissal.
    reset();
    ui_project_emit("a","session","summary","The previous build is ready.","The previous build is ready.");
    cable_notif_t pending_question={.agent_id="a",.name="Build",.question=true,
        .summary="May I deploy this build?"};
    ui_notif_replace(&pending_question,1); ui_notif_open();
    dispatch((action_t){.kind=A_NOTICE,.id="a"}); ui_notif_seen("a");
    assert(desktop_opens==1 && !question_sends && s.notice_count==1);
    assert(!pane_memory("a",false)->dismissed);
    // Desktop navigation without an Open gesture changes the recipient, but
    // keeps the inbox on the card being read, including an off-tab focus.
    reset();
    ui_notify_task_done("a","Build","M2","The build is installed.");
    ui_notify_task_done("b","Website","M2","The site is deployed.");
    ui_notif_open();
    ui_focus_project("outside"); ui_project_set_name("outside","Other tab");
    ui_apply_pending_focus(); assert(s.view==INBOX && s.notice_count==2);
    // Back cancels the pending inbox landing, even if a delayed receipt arrives
    // after the user has reopened the inbox to read another message.
    reset();
    ui_notify_task_done("a","Build","M2","The build is installed.");
    ui_notify_task_done("b","Website","M2","The site is deployed.");
    ui_notif_open(); dispatch((action_t){.kind=A_NOTICE,.id="a"});
    view(HOME); assert(!s.opening_notice[0]);
    ui_notif_open(); ui_focus_project("a"); assert(s.view==INBOX);
    const char *recaps[]={
        "It isn't external.",
        "Yes. The fix is installed.",
        "Fixed the parser. All tests pass. Voice input now sends to the selected agent.",
        "Yes. The fix is installed and the device has reconnected successfully to the +",
        "A much longer recap from an older host needs to fit three rows, with the same continuation as the home result.",
        "“Yes” means “go”; “no” means “stop”. Keep “A”, “B”, “C”, “D”, “E”, “F”.",
        "All three dials are working now: Tim, Tux seed 1363, and the production UI.",
        "Harness Pro board support: committed by 0xdiego25, commit",
        "Fixed and merged into main: PR #436. All 62 relevant tests and static analysis passed.",
        "Swipes need about ⅓ the previous travel.",
        "Fixed: 1⅓ seconds → ½ second; x ≠ y. Tests ✅"
    };
    for(unsigned i=0;i<sizeof recaps/sizeof recaps[0];i++) {
        reset();
        ui_project_emit("a","session-a","summary",recaps[i],recaps[i]);
        scene_take();
        for(int j=0;j<scene.count;j++) {
            const ht_run_t *r=&scene.runs[j];
            assert(r->font!=&ht_nav_32 && r->font!=&ht_open_20);
            if(r->font->height<=6 && strlen(r->text)>=32)
                assert(r->font->height==4 && r->y+r->font->height<=HT_CHARACTER_READING_TEXT_Y);
        }
        if(i==6) portrait(dir,"photo-summary-dials");
        if(i==7) portrait(dir,"photo-summary-board");
        if(i==8) {
            strcpy(active()->name,"Investigate firmware harness");
            scene_take(); portrait(dir,"photo-summary-spacing");
        }
        if(i>=9) {
            bool fraction=false;
            assert(!strcmp(active()->preview,recaps[i])); // wire/source stays original UTF-8
            for(int j=0;j<scene.count;j++) {
                const ht_run_t *r=&scene.runs[j];
                if(r->font!=&ht_mono_28) continue;
                assert(!strchr(r->text,'?'));
                if(strstr(r->text,"1/3")) fraction=true;
            }
            assert(fraction);
            portrait(dir,i==9?"summary-fraction":"summary-symbols");
        }
        // Notifications may name a pane outside the device's current tab.
        ui_notify_task_done("off-tab","Other pane","Another Mac",recaps[i]);
        ui_notif_open(); scene_take();
        int icons=0;
        for(int j=0;j<scene.count;j++) {
            const ht_run_t *r=&scene.runs[j];
            assert(!r->arc && !r->shimmer && r->font->height>=28); // no creature or home arc
            if(r->font==&ht_nav_32) {
                assert(r->x==223 && r->y==400 && !strcmp(r->text,"\xe2\x86\x90"));
                assert(ht_can_display(r->text,r->font,r->w,1)); icons++;
            }
            if(r->font==&ht_mono_28 && r->text[0])
                assert(r->y>=72 && r->y+r->font->height<=382);
        }
        assert(icons==1); // Only Back; the full message opens the pane.
        // The inbox keeps its own reading layout and the same source message.
        assert(!strcmp(s.notice[0].summary,s.agents[0].preview));
        assert(s.view==INBOX && s.notice_count==1 && !desktop_opens && !starts);
        if(i==2) portrait(dir,"notification-preview");
        if(i==1) portrait(dir,"notification-short");
        if(i==3) portrait(dir,"notification-clipped");
        if(i==5) { assert(strlen(recaps[i])>100); portrait(dir,"notification-punctuation"); }
        if(i>=9) {
            bool fraction=false;
            for(int j=0;j<scene.count;j++) {
                const ht_run_t *r=&scene.runs[j];
                assert(!strchr(r->text,'?'));
                if(strstr(r->text,"1/3")) fraction=true;
            }
            assert(fraction);
            portrait(dir,i==9?"notification-fraction":"notification-symbols");
        }
        tap(1000,233,340);
        assert(desktop_opens==1 && !strcmp(opened_agent,"off-tab") && !starts);
        assert(s.notice_count==1); // Opening is reconciled by the host's seen event.
    }
    reset();
    ui_notify_task_done("a","Deploy latest firmware","M2","Yes. The fix is installed.");
    ui_notify_task_done("b","Website","M2","The new page is live.");
    ui_notif_open(); scene_take(); portrait(dir,"notification-multiple");
    habitat_touch(true,300,260,2000); habitat_touch(true,170,260,2060);
    habitat_touch(false,170,260,2120); scene_take();
    assert(s.offset==1 && s.notice_count==2 && !desktop_opens && !starts);
    habitat_touch(true,233,275,2500); habitat_touch(true,233,190,2560);
    habitat_touch(false,233,190,2620); scene_take();
    assert(s.offset==0 && s.notice_count==2 && !desktop_opens && !moves && !starts);
    tap(3000,233,250); assert(desktop_opens==1 && !strcmp(opened_agent,"b"));
    reset();
    cable_notif_t question={.agent_id="off-tab",.name="Release",.question=true,
        .summary="Should I deploy this build to staging?"};
    ui_notif_replace(&question,1); ui_notif_open(); scene_take();
    bool question_shown=false;
    for(int i=0;i<scene.count;i++) if(strstr(scene.runs[i].text,"Should I deploy"))question_shown=true;
    assert(question_shown && s.notice_count==1 && !question_sends);
    assert(inbox_mark_is("?", color(HT_THEME_QUESTION)));
    portrait(dir,"notification-question");
    s.connected=false; scene_take(); assert(!action_enabled(A_NOTICE));
    portrait(dir,"inbox-offline");
    tap(3500,233,260); assert(s.view==INBOX && !desktop_opens && !question_sends && !starts);
    tap(3700,233,415); assert(s.view==HOME && !desktop_opens && !question_sends && !starts);
    s.connected=true; ui_notif_open(); scene_take();
    habitat_touch(true,233,260,3900); scene_take(); portrait(dir,"inbox-open-pressed");
    habitat_touch(false,233,260,3975); scene_take();
    assert(desktop_opens==1 && !strcmp(opened_agent,"off-tab") && !starts);
    reset(); ui_notify_task_done("a","No saved recap","M2",NULL); ui_notif_open(); scene_take();
    bool fallback=false;
    for(int i=0;i<scene.count;i++) if(!strcmp(scene.runs[i].text,"No preview available."))fallback=true;
    assert(fallback); portrait(dir,"notification-missing");
    reset();
}
static uint32_t soak_random(uint32_t *state) {
    *state ^= *state << 13; *state ^= *state >> 17; *state ^= *state << 5;
    return *state;
}
static void pane_notification_soak(void) {
    // Long mixed histories exercise cache eviction and list reconciliation,
    // including contacts held across host updates and both 32-bit wraps.
    // Everything uses local production handlers; no desktop or audio I/O.
    reset(); s.memory_serial=UINT32_MAX-100;
    uint32_t seed=0x48a6197u; fake_ms=UINT32_MAX-300000;
    unsigned operations[12]={0},contacts=0,rasters=0;
    static uint16_t pixels[HT_WIDTH*HT_HEIGHT];
    for(unsigned step=0;step<200000;step++) {
        uint32_t r=soak_random(&seed);
        char id[ID_MAX],name[80],result[260];
        snprintf(id,sizeof id,"soak-%03u",(r>>8)%256);
        snprintf(name,sizeof name,"Pane %u / turn %u",(r>>8)%256,step);
        snprintf(result,sizeof result,"Turn %u is complete. The parser handles the next result after a notification has been opened.",step);
        fake_ms+=17;
        bool held=s.view==INBOX && s.notice_count && (r&31)==0;
        if(held) { scene_take(); habitat_touch(true,233,250,fake_ms); contacts++; }
        unsigned op=r%12; operations[op]++;
        switch(op) {
        case 0: ui_project_set_name(id,name); break;
        case 1: ui_project_remove(id); break;
        case 2: ui_project_emit(id,"soak-session","processing","Working",NULL); break;
        case 3: ui_project_emit(id,"soak-session","summary",result,result); break;
        case 4: ui_project_restore_event(id,"summary",result,result); break;
        case 5: ui_notify_task_done(id,name,"M2",result); break;
        case 6: ui_notif_seen(id); break;
        case 7: ui_notif_open(); break;
        case 8: ui_focus_project(id); ui_apply_pending_focus(); break;
        case 9: {
            cable_notif_t rows[NOTICES]={0};
            int count=(r>>16)%(NOTICES+1);
            for(int i=0;i<count;i++) {
                snprintf(rows[i].agent_id,sizeof rows[i].agent_id,"soak-%03u",((r>>8)+i)%256);
                COPY(rows[i].name,name); COPY(rows[i].summary,result);
                rows[i].question=(i%5)==0;
            }
            ui_notif_replace(rows,count); break;
        }
        case 10:
            if(s.view==INBOX && s.notice_count) {
                action_t a={.kind=A_NOTICE}; COPY(a.id,s.notice[s.offset].agent_id);
                congestion=(r&256)!=0; dispatch(a); congestion=false;
            }
            break;
        case 11:
            if(r&256) view(HOME);
            else ui_project_clear_all();
            break;
        }
        if(held) habitat_touch(false,233,250,fake_ms+75);
        assert(s.count>=0 && s.count<=MAX_PROJECTS);
        assert(s.active>=-1 && s.active<s.count);
        assert(s.notice_count>=0 && s.notice_count<=NOTICES);
        if(s.view==INBOX) assert(s.notice_count && s.offset>=0 && s.offset<s.notice_count);
        for(int i=0;i<s.notice_count;i++) {
            assert(s.notice[i].agent_id[0] && memchr(s.notice[i].agent_id,0,ID_MAX));
            assert(memchr(s.notice[i].summary,0,sizeof s.notice[i].summary));
            for(int j=0;j<i;j++) assert(strcmp(s.notice[i].agent_id,s.notice[j].agent_id));
        }
        if((step&255)==0) {
            for(int i=0;i<PANE_MEMORY_MAX;i++) {
                const pane_memory_t *m=&s.memory[i];
                assert(memchr(m->id,0,sizeof m->id));
                assert(memchr(m->preview,0,sizeof m->preview));
                assert(memchr(m->full,0,sizeof m->full));
                if(m->id[0]) for(int j=0;j<i;j++) assert(strcmp(m->id,s.memory[j].id));
            }
            scene_take(); assert(scene.count<=HT_RUNS && s.hit_count<=24);
        }
        if((step&4095)==0) {
            ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels); rasters++;
        }
        assert(!starts && !question_sends); // inbox activity cannot start a mic/answer
    }
    for(unsigned i=0;i<12;i++) assert(operations[i]>10000);
    assert(contacts>100);
    printf("Pane/inbox soak: 200000 mixed updates, 256 identities, %u held contacts, %u full rasters, cache/time wraps; bounds/identity/modal invariants PASS\n",contacts,rasters);
    reset();
}
static void pane_memory_checks(const char *dir) {
    // The reported failure: leave mobile's tab, receive its completion while
    // absent, then return without any history replay from the bridge.
    reset();
    ui_project_emit("a","mobile-session","processing","Coalescing...",NULL);
    ui_project_remove("a"); assert(find("a")==-1);
    ui_project_emit("a","mobile-session","done",NULL,NULL);
    ui_project_emit("a","mobile-session","summary","The mobile build is installed. All checks passed.","The mobile build is installed. All checks passed.");
    assert(find("a")==-1 && !starts && !desktop_opens); // background data never adds a visible pane
    ui_project_set_name("a","Mobile app build and deploy"); s.active=find("a"); scene_take();
    assert(result_visible() && !active()->busy && !strcmp(active()->preview,"The mobile build is installed. All checks passed."));
    portrait(dir,"mobile-restored");
    ui_project_remove("a"); ui_project_set_name("a","Mobile app build and deploy");
    s.active=find("a"); scene_take(); assert(result_visible());
    // Starting the next turn returns to the large companion and hides old prose.
    ui_project_emit("a","mobile-session","processing","Coalescing...",NULL); scene_take();
    assert(!result_visible() && active()->busy && !strcmp(active()->tool,"Coalescing"));
    bool caption=false;
    for(int i=0;i<scene.count;i++) if(!strcmp(scene.runs[i].text,"Last result"))caption=true;
    assert(!caption); portrait(dir,"mobile-working");
    s.notice_count=2; scene_take(); portrait(dir,"working-notifications-activity");
    fake_ms+=3400; surface_tick(fake_ms); scene_take();
    bool footer=false;
    for(int i=0;i<scene.count;i++) if(strstr(scene.runs[i].text,"Coalescing")) {
        assert(scene.runs[i].arc==1 && scene.runs[i].fg==FG); footer=true;
    }
    assert(footer); s.notice_count=0;
    scene_take(); footer=false;
    for(int i=0;i<scene.count;i++) if(strstr(scene.runs[i].text,"Coalescing")) {
        assert(scene.runs[i].arc==1 && scene.runs[i].fg==FG); footer=true;
    }
    assert(footer);
    ui_project_emit("a",NULL,"processing","Processing",NULL);
    assert(!strcmp(active()->tool,"Coalescing")); // heartbeat never flashes a replacement label

    ui_project_remove("a"); ui_project_emit("a","mobile-session","activity","Summarizing...",NULL);
    ui_project_set_name("a","Mobile app build and deploy"); s.active=find("a"); scene_take();
    assert(!result_visible() && active()->busy && !strcmp(active()->tool,"Summarizing"));
    ui_project_restore_event("a","summary","An older result.","An older result.");
    assert(!strcmp(active()->preview,"The mobile build is installed. All checks passed."));
    ui_project_emit("a","mobile-session","done",NULL,NULL); scene_take(); assert(!result_visible());
    ui_project_emit("a","mobile-session","summary","The next build is installed.","The next build is installed.");
    assert(!strcmp(active()->preview,"The next build is installed."));
    scene_take(); assert(result_visible() && !active()->busy); portrait(dir,"next-result");
    // History arriving before the roster is safe too, without a notification.
    ui_project_clear_all(); ui_project_restore_event("history","summary","Saved result.","Saved result.");
    assert(!s.count && !s.notice_count);
    ui_project_set_name("history","History"); s.active=find("history"); scene_take(); assert(result_visible());
    ui_project_clear_event("history"); ui_project_remove("history"); ui_project_set_name("history","History");
    s.active=find("history"); scene_take(); assert(!result_visible());
    // Bounded cache: current panes stay pinned; old off-tab slots are evicted.
    reset(); ui_project_emit("a",NULL,"summary","Pinned.","Pinned.");
    ui_project_emit("b",NULL,"summary","Also pinned.","Also pinned.");
    for(int i=0;i<PANE_MEMORY_MAX+40;i++) {
        char id[64]; snprintf(id,sizeof id,"background-%d",i);
        ui_project_emit(id,NULL,"summary","Background result.","Background result.");
    }
    assert(pane_memory("a",false) && pane_memory("b",false) && !pane_memory("background-0",false));
    ui_project_remove("a"); ui_project_set_name("a","Pinned"); s.active=find("a"); scene_take();
    assert(result_visible() && !strcmp(active()->preview,"Pinned."));
    s.memory_serial=UINT32_MAX;
    ui_project_emit("wrap",NULL,"summary","Wrap-safe.","Wrap-safe.");
    assert(pane_memory("wrap",false) && pane_memory("b",false));
    reset(); ui_project_emit("a",NULL,"processing","",NULL); scene_take();
    assert(!active()->tool[0] && !result_visible());
    assert(title_is("Deploy latest firmware") && status_is(""));
    fake_ms+=3400; surface_tick(fake_ms); scene_take();
    assert(title_is("Working")); portrait(dir,"working-without-footer");
    s.straight_title=true; scene_take(); assert(title_is("Working"));
    s.straight_title=false;
    ui_project_emit("a",NULL,"activity","Coalescing...",NULL); scene_take();
    assert(title_is("Coalescing") && !title_is("Working"));
    // A native footer disappearing must not erase the known busy state.
    ui_project_emit("a",NULL,"activity","",NULL); scene_take();
    assert(!active()->tool[0] && title_is("Working"));
    s.notice_count=2; scene_take(); assert(title_is("Working") && !title_is("[2] Working"));
    s.notice_count=0; ui_project_emit("a",NULL,"done",NULL,NULL); scene_take();
    assert(!active()->busy && !title_is("Working"));
    // A late activity read cannot bring the completed status back.
    ui_project_emit("a",NULL,"activity","Coalescing",NULL); scene_take();
    assert(!title_is("Working") && !title_is("Coalescing"));
    ui_project_emit("a",NULL,"processing","Processing",NULL); scene_take();
    fake_ms+=3400; surface_tick(fake_ms); scene_take();
    assert(!active()->tool[0] && title_is("Working"));
    s.nap=true; scene_take(); assert(!title_is("Working")); s.nap=false;
    s.connected=false; scene_take(); assert(scene.count==1 && !strcmp(scene.runs[0].text,"Harness")); s.connected=true;
    ui_project_emit("a",NULL,"activity","Working",NULL);
    strcpy(active()->name,"hn"); scene_take(); portrait(dir,"short-name-working");
    strcpy(active()->name,"firmware v2");
    strcpy(active()->tool,"Messages to be submitted after");
    scene_take(); portrait(dir,"photo-long-status");
    strcpy(active()->tool,"Working");
    home_caption.initialized=false; fake_ms=0; scene_take();
    for (int frame=0;frame<32;frame++) {
        fake_ms=3240+frame*64; surface_tick(fake_ms); scene_take();
        int shimmer=0;
        for(int i=0;i<scene.count;i++) if(scene.runs[i].shimmer) {
            assert(scene.runs[i].arc==1 && !strcmp(scene.runs[i].text,"Working")); shimmer++;
        }
        assert(shimmer==1);
        char label[40]; snprintf(label,sizeof label,"working-shimmer-%02d",frame); portrait(dir,label);
    }
    s.quiet=true; surface_tick(fake_ms); scene_take();
    for(int i=0;i<scene.count;i++) assert(!scene.runs[i].shimmer);
    s.quiet=false;
    ui_project_remove("a"); pane_memory_t *m=pane_memory("a",false); assert(m);
    m->last_busy=ms()-26000; ui_project_set_name("a","Expired busy");
    assert(!s.agents[find("a")].busy); scene_take(); assert(!title_is("Working"));
    reset(); strcpy(active()->name,"Mobile app build and deploy");
    ui_project_emit("a",NULL,"processing","Coalescing",NULL); scene_take();
    tap(2000,233,41); assert(s.view==AGENTS && !starts); // top caption always picks panes
    reset(); ui_project_emit("a",NULL,"summary","The result is ready.","The result is ready.");
    scene_take(); tap(3000,233,280); scene_take(); assert(!result_visible() && !desktop_opens && starts==1);
    dispatch((action_t){.kind=A_VOICE_ABORT}); scene_take(); assert(result_visible());
    ui_project_remove("a"); ui_project_set_name("a","Return to pane"); s.active=find("a");
    ui_project_restore_event("a","summary","The result is ready.","The result is ready.");
    ui_project_emit("a",NULL,"processing","Processing",NULL);
    scene_take(); assert(!result_visible());
    ui_project_emit("a",NULL,"summary","A new result is ready.","A new result is ready.");
    scene_take(); assert(result_visible());
    printf("pane memory: PASS (off-tab completion, returning panes, late restores, live activity, alternating work/results, 128-slot bound); %zu bytes\n",sizeof s.memory);
    reset();
}
static void bell_checks(const char *dir) {
    static const int points[][2]={{233,399},{100,408},{150,430},{315,415},{370,405},{233,450}};
    assert(ht_can_display(HT_BELL " 32", &ht_mono_28, 68, 1));
    reset(); scene_take();
    bool found=false;
    for(int i=0;i<scene.count;i++) if(!strcmp(scene.runs[i].text,HT_BELL)) {
        assert(false); // An empty inbox has no bell run.
        found=true;
    }
    assert(!found && !action_enabled(A_INBOX));
    // A restored host failure is distinct from a completed task. Questions
    // keep priority; an ordinary fresh result must clear any old failure mark.
    cable_notif_t failed={.agent_id="b",.name="Website",.failed=true,
        .summary="The deployment failed. Check the terminal for details."};
    ui_notif_replace(&failed,1); ui_notif_open(); scene_take();
    assert(inbox_mark_is(HT_FAILED, color(HT_THEME_FAILED)));
    portrait(dir,"notification-failed");
    failed.question=true; ui_notif_replace(&failed,1); scene_take();
    assert(inbox_mark_is("?", color(HT_THEME_QUESTION)));
    ui_notify_task_done("b","Website","M2","The site is deployed."); scene_take();
    assert(inbox_mark_is(HT_DONE, color(HT_THEME_DONE)));
    for(int i=0;i<scene.count;i++) assert(!strstr(scene.runs[i].text,"----"));
    reset(); scene_take();
    portrait(dir,"bell-empty");
    for(unsigned i=0;i<sizeof points/sizeof points[0];i++) {
        reset(); tap(1000,points[i][0],points[i][1]);
        assert(s.view==HOME && !starts && !desktop_opens && !switches);
        cable_notif_t n={.agent_id="b",.name="Other pane",.summary="The update is ready. All checks pass."};
        ui_notif_replace(&n,1); scene_take();
        assert(status_is(HT_BELL " 1") && action_enabled(A_INBOX));
        for(int j=0;j<scene.count;j++) if(scene.runs[j].font->height<=6)
            assert(scene.runs[j].bg==BG); // no reverse-video envelope on either character
        tap(2000,points[i][0],points[i][1]);
        assert(s.view==INBOX && !starts && !desktop_opens);
        for(int j=0;j<scene.count;j++) assert(!scene.runs[j].arc && scene.runs[j].font->height>=28);
        tap(3000,233,100); // The pane title, like its message, opens that pane.
        assert(desktop_opens==1 && !strcmp(opened_agent,"b") && !starts);
    }
    reset(); ui_notify_task_done("b","Other pane","M2","Finished."); scene_take();
    habitat_touch(true,233,420,1000); ui_notif_seen("b"); scene_take();
    habitat_touch(false,233,420,1080); assert(s.view==HOME && !starts && !desktop_opens);
    reset(); habitat_touch(true,233,420,1000);
    ui_notify_task_done("b","Other pane","M2","Finished."); scene_take();
    habitat_touch(false,233,420,1080); assert(s.view==HOME && !starts && !desktop_opens);
    scene_take(); portrait(dir,"bell-unread");
    tap(2000,233,220); assert(s.view==VOICE && starts==1); scene_take();
    assert(!status_is(HT_BELL " 1"));
    dispatch((action_t){.kind=A_VOICE_ABORT}); scene_take(); assert(status_is(HT_BELL " 1"));
    reset(); active()->busy=true; scene_take();
    fake_ms=3400;surface_tick(fake_ms);scene_take();assert(title_is("Working"));
    ui_notify_task_done("b","Other pane","M2","Finished.");scene_take();
    assert(title_is("Working") && status_is(HT_BELL " 1"));
    fake_ms=6400;surface_tick(fake_ms);scene_take();assert(title_is(active()->name));
    portrait(dir,"bell-working-name");
    fake_ms=9400;surface_tick(fake_ms);scene_take();assert(title_is("Working"));
    portrait(dir,"bell-working-activity");
    tap(10000,233,41);assert(s.view==AGENTS && !starts && !desktop_opens);
    reset(); active()->busy=true;
    memset(active()->name,'x',32);active()->name[32]=0;scene_take();
    fake_ms=2800;surface_tick(fake_ms);scene_take();
    int end_x=233+(205*arc_trig[31][0]>>14),end_y=233-(205*arc_trig[31][1]>>14);
    habitat_touch(true,end_x,end_y,2800);fake_ms=3100;surface_tick(fake_ms);scene_take();
    assert(title_is(active()->name)); // Rotation cannot shrink a held caption target.
    habitat_touch(false,end_x,end_y,3150);assert(s.view==AGENTS && !starts && !desktop_opens);
    puts("bell/inbox: empty/active glyphs, wide separate targets, arrivals/removal during contact, title/message open, no creature, voice restoration, caption rotation PASS");
    reset();
}

static void notification_read_checks(const char *dir) {
    // Exact occurrence receipts: no focus, no answering, idempotent retries.
    cable_notif_t synced={.agent_id="a",.name="Build",.summary="The build passed. All checks are green.",.read_token="turn-1"};
    reset(); ui_notif_replace(&synced,1); ui_notif_open(); scene_take();
    assert(notice_reads_sent==1 && !notice_unread() && !strcmp(notice_read_queued.text,"turn-1"));
    assert(!desktop_opens && !starts && !question_sends);
    notice_flush_reads(ms()); assert(notice_reads_sent==1);
    fake_ms=10000; notice_flush_reads(ms()); assert(notice_reads_sent==2);
    ui_notif_replace(NULL,0); assert(s.view==INBOX && s.notice_count==1 && !notice_unread());
    fake_ms+=3000; notice_flush_reads(ms()); assert(notice_reads_sent==2); // app acknowledged, keep reading
    view(HOME); ui_notif_replace(NULL,0); assert(!s.notice_count);
    strcpy(synced.read_token,"turn-2"); ui_notif_replace(&synced,1); assert(notice_unread()==1);
    ui_notif_read("a","turn-1"); assert(notice_unread()==1); // stale, identical text
    ui_notif_read("a","turn-2"); assert(!s.notice_count); // desktop clear
    synced.question=true; strcpy(synced.read_token,"question-1");
    ui_notif_replace(&synced,1); ui_notif_open(); congestion=true; scene_take();
    assert(!notice_unread() && s.view==INBOX && !question_sends);
    unsigned before=notice_reads_sent; congestion=false; fake_ms+=3000; notice_flush_reads(ms());
    assert(notice_reads_sent==before+1 && !strcmp(notice_read_queued.text,"question-1"));
    ui_notif_read("a","question-1"); ui_notif_replace(NULL,0);
    assert(s.view==INBOX && s.notice_count==1 && !question_sends); // reading never answers
    reset(); ui_notif_replace(&synced,1); ui_notif_open(); present_scene=false; scene_take();
    uint32_t old_frame=habitat_scene_receipt(); strcpy(synced.read_token,"question-2");
    ui_notif_replace(&synced,1); habitat_scene_presented(old_frame);
    assert(notice_unread()==1 && !notice_reads_sent); // late DMA cannot read a new occurrence

    cable_notif_t rows[2]={
        {.agent_id="a",.name="Build",.summary="The build passed. All checks are green."},
        {.agent_id="b",.name="Release",.summary="May I publish this release?",.question=true}};
    reset(); ui_notif_replace(rows,2); scene_take();
    assert(notice_unread()==2 && status_is(HT_BELL " 2"));
    ui_notif_open(); assert(s.notice[s.offset].question);
    present_scene=false; scene_take(); uint32_t frame=habitat_scene_receipt();
    assert(frame && notice_unread()==2); // Constructing a frame is not reading it.
    fake_asleep=true; habitat_scene_presented(frame); assert(notice_unread()==2);
    fake_asleep=false; s.locked=true; habitat_scene_presented(frame); assert(notice_unread()==2);
    s.locked=false; habitat_scene_presented(frame); habitat_scene_presented(frame);
    assert(notice_unread()==1 && s.view==INBOX && s.notice_count==2 && s.notice[s.offset].question);
    assert(!question_sends && !desktop_opens && !starts);
    present_scene=true; view(HOME); scene_take(); assert(status_is(HT_BELL " 1"));
    ui_notif_open(); assert(!strcmp(s.notice[s.offset].agent_id,"a")); scene_take();
    assert(!notice_unread() && s.notice_count==2 && s.view==INBOX);
    portrait(dir,"inbox-read-stays");
    tap(1000,233,430); assert(s.view==HOME && status_is("") && !action_enabled(A_INBOX));
    for(int i=0;i<scene.count;i++) assert(scene.runs[i].font!=&ht_bell_footer);
    portrait(dir,"bell-all-read");
    ui_notif_replace(NULL,0); ui_notif_replace(rows,2); scene_take();
    assert(!notice_unread() && status_is("")); // Late/reconnect snapshot stays read.
    strcpy(rows[0].summary,"The next build is ready.");
    ui_notif_replace(rows,2); assert(notice_unread()==1);
    ui_notif_open(); scene_take(); assert(!notice_unread());
    // A new live result, even with identical words, is a new unread message.
    ui_notify_task_done("a","Build","M2",rows[0].summary);
    assert(notice_unread()==1);
    present_scene=false; scene_take(); frame=habitat_scene_receipt();
    ui_notify_task_done("a","Build","M2",rows[0].summary);
    habitat_scene_presented(frame); assert(notice_unread()==1); // Old DMA, new same-text result.
    scene_take(); frame=habitat_scene_receipt();
    view(HOME); habitat_scene_presented(frame); assert(notice_unread()==1);
    ui_notif_open(); scene_take(); frame=habitat_scene_receipt();
    cable_notif_t newer={.agent_id="a",.name="Build",.summary="This message replaced the old frame."};
    ui_notif_replace(&newer,1); habitat_scene_presented(frame); assert(notice_unread()==1);
    scene_take(); frame=habitat_scene_receipt();
    ui_notif_seen("a"); habitat_scene_presented(frame); assert(!notice_unread() && s.view==HOME);
    ui_notif_replace(&newer,1); assert(!notice_unread());
    newer.failed=true; ui_notif_replace(&newer,1); assert(notice_unread()==1);
    s.notice_revision=UINT32_MAX; ui_notif_replace(&newer,1);
    ui_notif_open(); scene_take(); assert(habitat_scene_receipt()!=0);
    // Open clears the bell even before a display receipt and even if the local
    // focus queue refuses it. A queue failure must never pretend to open a pane.
    congestion=true; dispatch((action_t){.kind=A_NOTICE,.id="a"});
    assert(!notice_unread() && !desktop_opens && !question_sends && !starts);
    congestion=false; present_scene=true; view(HOME); ui_notif_open(); scene_take();
    tap(2000,233,250); assert(!notice_unread() && desktop_opens==1 && !strcmp(opened_agent,"a"));
    // Bounded read history reuses a slot for the same pane and remains safe as
    // more than a full inbox's distinct identities are read.
    reset();
    for(int i=0;i<NOTICES*3;i++) {
        char id[ID_MAX]; snprintf(id,sizeof id,"read-%d",i);
        ui_notify_task_done(id,"Build","M2","Finished.");
        ui_notif_open(); scene_take(); assert(!notice_unread());
        assert(s.notice_read_next<NOTICES && s.notice_count<=NOTICES);
    }
    assert(!starts && !question_sends && !desktop_opens);
    puts("Notification read: post-DMA only, sleep/lock, stale/identical replacements, read/open idempotence, questions, hidden empty bell, reconnect snapshots and bounded receipt history PASS");
    reset();
}

static void tab_frame_checks(void) {
    static uint16_t full[466*466], delta[466*466], patch[466*466];
    ht_scene_t previous={0};
    workspace_setup();
    COPY(s.tabs[1].name,"Device firmware and voice interaction experiments");
    strcpy(s.tabs[2].name,"Caf\xc3\xa9 / infrastructure");
    dispatch((action_t){.kind=A_TABS});
    for(int position=-80;position<=3*HT_TAB_PITCH+80;position+=17) {
        tab_carousel.position=position; scene_take();
        ht_damage_t damage; ht_damage(position==-80 ? NULL : &previous,&scene,&damage);
        for(int i=0;i<damage.count;i++) {
            ht_rect_t r=damage.rect[i]; ht_raster(&scene,r,patch);
            for(int y=0;y<r.h;y++) memcpy(delta+(r.y+y)*466+r.x,patch+y*r.w,(size_t)r.w*2);
        }
        ht_raster(&scene,(ht_rect_t){0,0,466,466},full);
        assert(!memcmp(full,delta,sizeof full));
        uint16_t bg=(uint16_t)((BG>>8)|(BG<<8));
        for(int y=0;y<466;y++) for(int x=0;x<466;x++) if(full[y*466+x]!=bg)
            assert((x-233)*(x-233)+(y-233)*(y-233)<232*232);
        previous=scene;
    }
    puts("tab frames: long/UTF-8 names, rim bounds, clipped movement and exact partial redraw PASS");
    reset();
}
int main(int argc, char **argv) {
    test_character = getenv("HABITAT_TEST_TUX") ? HT_CHARACTER_TUX : HT_CHARACTER_TIM;
    notification_read_checks(argc>1 ? argv[1] : NULL);
    bell_checks(argc>1 ? argv[1] : NULL);
    reset(); view(COMPANION); scene_take();
    assert(action_enabled(A_CHARACTER));
    ht_character_id_t next=(character.id+1)%HT_CHARACTER_COUNT;
    tap(1000,233,140);
    assert(character.id==next && character_saves==1 && saved_character==(int)next);
    assert(s.view==COMPANION && s.active==0 && !starts && !switches && !moves);
    if(argc>1) portrait(argv[1],"companion");
    congestion=true; assert(!choose_character(test_character) && character.id==next);
    assert(!choose_character(255) && character.id==next); congestion=false;
    // Artwork can switch during an existing voice session without touching its owner or audio.
    reset(); tap(1000,233,220); assert(recording && starts==1);
    assert(choose_character((character.id+1)%HT_CHARACTER_COUNT));
    assert(recording && s.voice_open && s.view==VOICE && starts==1 && !stops && !strcmp(target,"a"));

    const char *brightness = getenv("HABITAT_PREVIEW_BRIGHTNESS");
    if (brightness) {
        char *end; long value = strtol(brightness, &end, 10);
        assert(*brightness && !*end && value >= 0 && value <= 100);
        preview_brightness = (unsigned)value;
    }
    // Identity boundaries are exact, including IDs that share a full-length prefix.
    {
    reset();
    char exact[ID_MAX], oversized[ID_MAX+1];
    memset(exact,'a',sizeof exact-1);exact[sizeof exact-1]=0;
    snprintf(oversized,sizeof oversized,"%sx",exact);
    int count=s.count, target=ensure(exact);assert(target==count);
    assert(ensure(oversized)==-1 && s.count==count+1);
    assert(ensure(NULL)==-1 && ensure("")==-1);
    strcpy(s.pending_focus,"b");ui_focus_project(oversized);
    assert(!strcmp(s.pending_focus,"b"));
    s.active=0;ui_apply_pending_focus();assert(s.active==1 && !s.pending_focus[0]);
    ui_focus_project(exact);assert(s.active==target);
    notice_add(exact,"Exact target","M2","This target fits.",false,false);
    unsigned exact_notices=s.notice_count;
    notice_add(oversized,"Wrong target","M2","Must not alias another pane.",false,false);
    assert((unsigned)s.notice_count==exact_notices && !strcmp(s.notice[0].agent_id,exact));
    reset();
    }
    const char *dir = argc > 1 ? argv[1] : NULL;
    recap_checks(dir);
    notice_checks(dir);
    pane_memory_checks(dir);
    pane_notification_soak();
    carry_return_setup(true);
    assert(action_enabled(A_RETURN) && action_enabled(A_CARRY_DROP));
    portrait(dir,"carry-return");
    tap(1000,173,410);
    assert(visit.pending && visit.op==HT_VISIT_BACK && carry.active && !carry_drops && !starts);
    assert(!strcmp(carry.id,"carried-passage") && !strcmp(carry.excerpt,"Keep this paragraph"));
    assert(!down_reports && !moves && !ups); // A footer is not a terminal contact.
    {
        char request[32]; snprintf(request,sizeof request,"visit-%lu",(unsigned long)visit.request);
        cJSON fields[]={
            {.string="requestId",.type=JSTRING,.valuestring=request},
            {.string="visitId",.type=JSTRING,.valuestring=visit.id},
            {.string="agentId",.type=JSTRING,.valuestring="a"},
            {.string="ok",.type=JTRUE}};
        for(int i=0;i<3;i++)fields[i].next=&fields[i+1];
        cJSON reply={.child=fields}; ui_visit_state(&reply); scene_take();
        assert(s.view==HOME && !visit.available && carry.active && !carry_drops);
        assert(action_enabled(A_CARRY_DROP) && !action_enabled(A_RETURN));
        portrait(dir,"carry-after-return");
    }
    carry_return_setup(true); s.rim_enabled=true; scene_take();
    tap(1000,317,413); // This point is on the rim; visible Drop owns it.
    assert(!carry.active && carry_drops==1 && visit.available && !visit.pending);
    assert(!starts && !switches && !down_reports && !moves && !ups);
    tap(1700,233,420); assert(visit.pending && visit.op==HT_VISIT_BACK);
    carry_return_setup(true); s.rim_enabled=true; scene_take();
    tap(1000,173,413); assert(visit.pending && carry.active && !carry_drops && !moves);
    carry_return_setup(false); s.rim_enabled=true; scene_take();
    tap(1000,233,425); assert(visit.pending && !starts && !moves && !down_reports);
    // Sliding off either button, crossing to the other one, or a sensor loss
    // cannot discard, navigate, scroll, or start speech.
    for(int rim=0;rim<2;rim++) {
        static const int drags[][4]={{173,410,317,410},{317,410,173,410},{173,410,233,250},{317,410,233,250}};
        for(size_t i=0;i<sizeof drags/sizeof drags[0];i++) {
            carry_return_setup(true); s.rim_enabled=rim; scene_take();
            habitat_touch(true,drags[i][0],drags[i][1],1000);
            habitat_touch(true,drags[i][2],drags[i][3],1070);
            habitat_touch(false,drags[i][2],drags[i][3],1150);
            assert(carry.active && visit.available && !visit.pending && !carry_drops && visit_sends==1);
            assert(!starts && !switches && !down_reports && !moves && !ups);
        }
    }
    carry_return_setup(true); habitat_touch(true,173,410,1000); habitat_touch_cancel();
    habitat_touch(false,173,410,1100); assert(!visit.pending && carry.active && !carry_drops);
    carry_return_setup(true); s.coasting=true; s.coast_until=2000;
    tap(1000,317,410); assert(carry.active && !carry_drops && down_reports==1 && ups==1);
    tap(1700,317,410); assert(!carry.active && carry_drops==1 && visit.available);
    carry_return_setup(true); congestion=true; tap(1000,173,410);
    assert(!visit.pending && visit.available && carry.active && !carry_drops && s.view==MESSAGE);
    congestion=false; view(HOME); scene_take(); tap(1700,173,410); assert(visit.pending && carry.active);
    carry_return_setup(true); s.connected=false; scene_take();
    assert(!action_enabled(A_RETURN) && !action_enabled(A_CARRY_DROP));
    tap(1000,173,410); assert(!visit.pending && carry.active);
    tap(1700,317,410); assert(carry.active && !carry_drops);
    s.connected=true; scene_take();
    tap(2400,317,410); assert(!carry.active && carry_drops==1);
    // Expiry changes the carry identity. An old finger cannot drop a new quote.
    carry_return_setup(true); habitat_touch(true,317,410,1000);
    assert(ht_carry_tick(&carry,300250)); scene_take(); portrait(dir,"carry-expired-return");
    assert(action_enabled(A_RETURN) && action_enabled(A_CARRY_DROP));
    ht_carry_open(&carry,"replacement-passage","a","pick-test",1,1100,carry_emit,NULL);
    assert(ht_carry_reply(&carry,carry.id,carry.request,true,"New source","New quote",1,300000,NULL,1101));
    int drops=carry_drops; habitat_touch(false,317,410,1150);
    assert(carry.active && !strcmp(carry.id,"replacement-passage") && carry_drops==drops);
    carry_return_setup(true); habitat_touch(true,173,410,1000);
    ht_visit_close(&visit);
    assert(ht_visit_latest(&visit,"new-reading","b",1100,visit_emit,NULL));
    assert(ht_visit_reply(&visit,visit.id,visit.request,true,"Different reading"));
    int sends=visit_sends; habitat_touch(false,173,410,1150);
    assert(!visit.pending && visit.available && visit_sends==sends && carry.active);
    reset(); s.view=SETTINGS; s.offset=6; scene_take(); assert(action_enabled(A_LATEST)); portrait(dir,"reading-controls");
    tap(1000,233,336); assert(visit.pending && visit.op==HT_VISIT_LATEST && visit_sends==1 && !starts);
    action_t old_visit=visit_queued; visit_work(old_visit); assert(visit_wire==1 && !strcmp(visit_wire_op,"latest"));
    char visit_request[32]; snprintf(visit_request,sizeof visit_request,"visit-%lu",(unsigned long)visit.request);
    cJSON visit_fields[]={
        {.string="requestId",.type=JSTRING,.valuestring=visit_request},
        {.string="visitId",.type=JSTRING,.valuestring=visit.id},
        {.string="agentId",.type=JSTRING,.valuestring="a"},
        {.string="label",.type=JSTRING,.valuestring="Your reading"},
        {.string="ok",.type=JTRUE},{.string="active",.type=JTRUE}};
    for(int i=0;i<5;i++)visit_fields[i].next=&visit_fields[i+1];
    cJSON visit_reply={.child=visit_fields};
    question_pending=true; ui_visit_state(&visit_reply); scene_take();
    assert(s.view==HOME && visit.available && !visit.pending && !starts); // Latest never opens a question.
    portrait(dir,"reading-return");
    tap(2000,233,410); assert(visit.pending && visit.op==HT_VISIT_BACK);
    visit_work(visit_queued); assert(visit_wire==2 && !strcmp(visit_wire_op,"back"));
    snprintf(visit_request,sizeof visit_request,"visit-%lu",(unsigned long)visit.request);
    visit_fields[5].type=0; ui_visit_state(&visit_reply); assert(!visit.available && s.view==HOME);
    reset(); dispatch((action_t){.kind=A_LATEST,.id="a"}); old_visit=visit_queued;
    ht_visit_close(&visit); visit_work(old_visit); assert(!visit_wire); // A cancelled queued action cannot jump later.
    dispatch((action_t){.kind=A_LATEST,.id="a"}); visit_work(old_visit); assert(!visit_wire && visit.pending);
    reset(); s.view=SETTINGS; s.offset=6; scene_take(); habitat_touch(true,233,336,1000); s.active=1;
    habitat_touch(false,233,336,1080); assert(!visit_sends && !starts); // Destination changed under the finger.
    reset(); s.view=SETTINGS; s.offset=6; scene_take(); congestion=true;
    tap(1000,233,336); assert(!visit.pending && !visit_sends && s.view==MESSAGE);
    reset(); s.connected=false; s.view=SETTINGS; scene_take(); assert(!action_enabled(A_LATEST));
    tab_frame_checks();
    workspace_setup(); assert(!action_enabled(A_TABS)); portrait(dir,"workspace-home");
    for(int i=0;i<scene.count;i++) assert(!strstr(scene.runs[i].text,"Product") && !strstr(scene.runs[i].text,"[ tabs ]"));
    assert(action_enabled(A_AGENTS) && title_is(active()->name) && status_is(""));
    tap(1000,233,41); assert(s.view==AGENTS && !starts && !tab_switches);
    workspace_setup();
    habitat_touch(true,233,230,2000); habitat_touch(true,233,230,2700);
    habitat_touch(true,233,100,2800); habitat_touch(false,233,100,2900);
    assert(s.view==TABS && !starts && !tab_switches); // Hold opens Tabs; later motion is consumed.
    // Hold reveals Tabs before release, without scrolling or opening a mic.
    workspace_setup(); habitat_touch(true,233,230,2000);
    habitat_touch(true,233,230,2700); habitat_touch(true,100,230,2800); scene_take();
    assert(s.view==TABS && s.touch_cancelled && !starts && !moves && !tab_switches);
    portrait(dir,"shortcut-tabs");
    habitat_touch(false,100,230,2900); scene_take();
    assert(s.view==TABS && !starts && !tab_switches && !moves);
    // The visible top name keeps a stable pane-picker target. Notifications
    // use a separate bottom bell; top name/activity share one stable target.
    const int update_contacts[][2]={{233,28},{233,41},{100,49},{366,49},{233,61}};
    for (int question=0;question<2;question++) for (unsigned i=0;i<sizeof update_contacts/sizeof update_contacts[0];i++) {
        workspace_setup(); s.notice_count=1; waiting_count=question; s.rim_enabled=true; active()->busy=true; scene_take();
        assert(action_enabled(A_INBOX) && action_enabled(A_AGENTS) && !action_enabled(A_TABS));
        bool label=false;
        for (int j=0;j<scene.count;j++) {
            assert(strcmp(scene.runs[j].text,"[1]"));
            if(!strcmp(scene.runs[j].text,active()->name)) {
                assert(scene.runs[j].arc==1); label=true;
            }
        }
        assert(label);
        tap(1000,update_contacts[i][0],update_contacts[i][1]);
        assert(s.view==AGENTS && !tab_switches && !starts);
    }
    workspace_setup(); s.notice_count=1; scene_take(); portrait(dir,"clear-notification");
    // Long top labels curve below y=66. Their visible end letters must
    // remain caption targets, even where the old rectangle reached the portrait.
    for(int length=11;length<=32;length++) for(int side=-1;side<=1;side+=2) for(int dy=-6;dy<=6;dy+=6) {
        workspace_setup();s.notice_count=1;s.rim_enabled=true;active()->busy=true;
        memset(active()->name,'x',(size_t)length);active()->name[length]=0;scene_take();
        int x=233+side*(205*arc_trig[length-1][0]>>14);
        int y=233-(205*arc_trig[length-1][1]>>14)+dy;
        tap(1000,x,y);assert(s.view==AGENTS&&!starts&&!tab_switches&&!moves);
    }
    workspace_setup();s.notice_count=1;active()->busy=true;
    strcpy(active()->tool,"Recontextualizing");scene_take();portrait(dir,"long-curved-notification");
    tap(1000,233,220);assert(starts==1&&s.view==VOICE); // the central companion still speaks
    workspace_setup(); s.notice_count=1; active()->busy=true; scene_take();
    habitat_touch(true,233,41,1000); habitat_touch(true,233,140,1100);
    habitat_touch(false,233,140,1200);
    assert(s.view==HOME && !tab_switches && !starts); // drag never opens the inbox or microphone
    // The bell opens the inbox; hold no longer has a directional action.
    workspace_setup(); s.notice_count=1; scene_take(); tap(2000,233,420);
    assert(s.view==INBOX && !starts && !tab_switches);
    // A host clear during contact leaves the caption action unchanged.
    workspace_setup(); s.notice_count=1; active()->busy=true; scene_take(); habitat_touch(true,233,41,1000);
    s.notice_count=0; scene_take(); habitat_touch(false,233,41,1080);
    assert(s.view==AGENTS && !tab_switches && !starts);
    // Hold still reaches workspaces while updates wait.
    workspace_setup(); s.notice_count=1; scene_take(); habitat_touch(true,233,230,1000);
    habitat_touch(true,233,230,1700); habitat_touch(true,100,230,1800);
    habitat_touch(false,100,230,1900); assert(s.view==TABS && !starts && !tab_switches);
    workspace_setup(); s.notice_count=1; scene_take(); s.notice_count=0; scene_take();
    assert(!action_enabled(A_TABS) && !action_enabled(A_INBOX));
    workspace_setup(); fake_ms=30000; surface_tick(fake_ms);
    ui_notify_task_done("b","Other pane","M2","Finished.");
    assert(s.pet_pose==3 && s.pet_until==32000);
    fake_ms=30010; surface_tick(fake_ms); scene_take(); portrait(dir,"notification-glance-right");
    assert(character.motion.reaction.pose.look==2);
    fake_ms=30170; surface_tick(fake_ms); scene_take(); portrait(dir,"mail-lift");
    assert(!character.delivery.moving && !character.delivery.lift && status_is(HT_BELL " 1"));
    fake_ms=30400; surface_tick(fake_ms); scene_take(); portrait(dir,"notification-glance-left");
    assert(character.motion.reaction.pose.look==-2);
    surface_tick(30860); assert(character.motion.reaction.pose.blink);
    surface_tick(31400); assert(!character.motion.reaction.pose.look && !character.motion.reaction.pose.blink);
    s.pet_pose=0; fake_ms=33000; surface_tick(fake_ms); scene_take();
    assert(character_mood()!=HT_TIM_DONE && action_enabled(A_INBOX)); portrait(dir,"unread-persistent");
    active()->recap_ready=true;
    strcpy(active()->preview,"The update is ready. All checks pass.");
    scene_take(); portrait(dir,"mail-with-summary");
    active()->recap_ready=false; active()->preview[0]=0;
    cable_notif_t restored={.agent_id="b",.name="Other pane",.summary="Finished."};
    ui_notif_replace(&restored,1); assert(!s.pet_pose); // history never replays a celebration
    waiting_count=1; surface_tick(33500); scene_take(); portrait(dir,"needs-attention");
    assert(character_mood()==HT_TIM_ATTENTION);
    surface_tick(60000); assert(character_mood()==HT_TIM_ATTENTION); // persists until resolved
    waiting_count=0; surface_tick(61000); assert(character_mood()!=HT_TIM_ATTENTION);
    ui_notif_seen("b"); assert(!s.notice_count); scene_take(); portrait(dir,"inbox-handled");
    // The last seen result exits the inbox even while a finger is on the card.
    workspace_setup(); ui_notify_task_done("a","Deploy latest firmware","M2","Installed.");
    ui_notif_open(); scene_take(); portrait(dir,"inbox-unread");
    assert(s.view==INBOX && action_enabled(A_NOTICE));
    habitat_touch(true,233,215,1000); ui_notif_seen("a"); scene_take();
    assert(s.view==HOME && !s.notice_count && s.touch_cancelled);
    habitat_touch(false,233,215,1100); assert(!starts && !desktop_opens);
    ui_notif_open(); assert(s.view==HOME); // no empty-inbox dead end
    // Snapshot reconciliation is atomic: replacing the only row stays in inbox.
    cable_notif_t notices[2]={
        {.agent_id="a",.name="Deploy latest firmware",.machine="M2",.summary="Installed."},
        {.agent_id="b",.name="Research",.machine="M2",.summary="Which branch?",.question=true}};
    ui_notif_replace(notices,1); ui_notif_open();
    ui_notif_replace(notices,1); assert(s.view==INBOX && s.notice_count==1);
    ui_notif_replace(notices,2); s.offset=1;
    ui_notif_seen("a"); assert(s.view==INBOX && s.notice_count==1 && s.offset==0);
    ui_notif_seen("b"); assert(s.view==INBOX && s.notice_count==1); // a glance is not an answer
    scene_take(); portrait(dir,"inbox-question");
    ui_question_close("b","question-1"); assert(s.view==HOME && !s.notice_count);
    ui_notif_replace(notices,1); ui_notif_open(); scene_take();
    habitat_touch(true,233,215,2000); ui_notif_replace(NULL,0); scene_take();
    assert(s.view==HOME && s.touch_cancelled);
    habitat_touch(false,233,215,2100); assert(!starts && !desktop_opens);
    // Clearing notifications never interrupts another screen or a live microphone.
    s.view=TABS; ui_notif_replace(NULL,0); assert(s.view==TABS);
    s.view=VOICE; s.voice_open=true; ui_notif_replace(NULL,0); assert(s.view==VOICE);
    // New arrivals, repeated updates and reordered host snapshots must preserve
    // the message being read. A changed card consumes an in-flight release.
    workspace_setup();
    ui_notify_task_done("a","First pane","M2","The update is installed. Voice input sends to the selected agent. The summary has more room, the octopus is larger, and unread messages open from the bottom edge of the screen.");
    ui_notify_task_done("b","Second pane","M2","All tests pass.");
    ui_notif_open(); s.offset=1; scene_take(); portrait(dir,"notification-long-reading");
    assert(!strcmp(s.notice[s.offset].agent_id,"a"));
    habitat_touch(true,233,250,3000);
    ui_notify_task_done("c","Third pane","M2","The build is ready.");
    assert(!strcmp(s.notice[s.offset].agent_id,"a")&&s.touch_cancelled);
    habitat_touch(false,233,250,3100);assert(!desktop_opens&&!starts);
    ui_notify_task_done("a","First pane","M2","A newer result from the same pane.");
    assert(!strcmp(s.notice[s.offset].agent_id,"a")&&s.offset==0);
    cable_notif_t reordered[3]={
        {.agent_id="d",.name="Fourth",.summary="The deploy is complete."},
        {.agent_id="a",.name="First pane",.summary="A newer result from the same pane."},
        {.agent_id="b",.name="Second pane",.summary="All tests pass."}};
    ui_notif_replace(reordered,3);assert(!strcmp(s.notice[s.offset].agent_id,"a")&&s.offset==1);
    ui_notif_seen("d");assert(!strcmp(s.notice[s.offset].agent_id,"a")&&s.offset==0);
    scene_take();tap(3700,150,430);assert(s.view==HOME&&!desktop_opens&&!starts);
    ui_notif_open();scene_take();tap(4400,233,260);
    assert(desktop_opens==1&&!strcmp(opened_agent,"b")&&!starts); // Reopening chooses the remaining unread card.
    // A full inbox evicts another row instead of the oldest card being read.
    workspace_setup();
    for(int i=0;i<NOTICES;i++) {
        char id[24];snprintf(id,sizeof id,"notice-%d",i);
        ui_notify_task_done(id,"A pane","M2","A complete result to read.");
    }
    ui_notif_open();s.offset=NOTICES-1;
    for(int i=0;i<2*NOTICES;i++) {
        char id[24];snprintf(id,sizeof id,"incoming-%d",i);
        ui_notify_task_done(id,"New pane","M2","Another result arrived.");
        assert(s.notice_count==NOTICES&&!strcmp(s.notice[s.offset].agent_id,"notice-0"));
    }
    ui_notif_seen(NULL);assert(s.notice_count==NOTICES);
    ui_notif_replace(NULL,1000);assert(s.view==HOME&&!s.notice_count);
    // Centered name plus previous/next previews; all six remain reachable.
    workspace_setup(); s.tab_count=6;
    strcpy(s.tabs[4].id,"tab-4"); strcpy(s.tabs[4].name,"Tools");
    strcpy(s.tabs[5].id,"tab-5"); strcpy(s.tabs[5].name,"Notes");
    dispatch((action_t){.kind=A_TABS}); scene_take(); portrait(dir,"tabs-names");
    assert(s.view==TABS && s.hit_count==4 && !action_enabled(A_UP) && !action_enabled(A_DOWN));
    assert(action_enabled(A_HOME) && !action_enabled(A_SETTINGS) && !action_enabled(A_MACHINES));
    assert(ht_tab_carousel_index(&tab_carousel)==1);
    for(int i=0;i<scene.count;i++) {
        assert(!strstr(scene.runs[i].text,"panes") && !strstr(scene.runs[i].text,"selected"));
        assert(scene.runs[i].bg==BG); // no list boxes or alternating row fills
    }
    bool previous_visible=false,next_visible=false;
    for(int i=0;i<scene.count;i++) if(scene.runs[i].font==UI_FONT && !scene.runs[i].arc && scene.runs[i].w) {
        const ht_run_t *r=&scene.runs[i];
        if(r->x+r->w<=119) previous_visible=true;
        if(r->x>=347) next_visible=true;
        assert(strcmp(r->text,"controls"));
    }
    assert(previous_visible && next_visible);
    habitat_touch(true,300,233,3000); habitat_touch(true,240,233,3120); scene_take();
    assert(tab_carousel.position==HT_TAB_PITCH+120 && !tab_switches && !starts && !moves);
    portrait(dir,"tabs-dragging");
    habitat_touch(false,220,233,3150); scene_take();
    assert(tab_carousel.animating && !tab_switches && !starts);
    surface_tick(3250); scene_take(); portrait(dir,"tabs-settling");
    // A touch brakes a moving page. It must never also open the old rendered target.
    tap(3260,233,233); assert(s.view==TABS && !tab_switches && !starts);
    surface_tick(3650); scene_take();
    int chosen=ht_tab_carousel_index(&tab_carousel);
    char chosen_id[ID_MAX]; COPY(chosen_id,s.tabs[chosen].id);
    tap(3900,233,233); assert(tab_switches==1 && !strcmp(tab_target,chosen_id));
    // Tapping a visible neighbor opens that exact tab, never the centered name.
    workspace_setup(); dispatch((action_t){.kind=A_TABS}); scene_take();
    tap(4000,80,233); assert(tab_switches==1 && !strcmp(tab_target,"tab-0") && !starts);
    workspace_setup(); dispatch((action_t){.kind=A_TABS}); scene_take();
    tap(4000,386,233); assert(tab_switches==1 && !strcmp(tab_target,"tab-2") && !starts);
    // Vertical/out-and-back motion stays in the picker and never opens a tab.
    workspace_setup(); dispatch((action_t){.kind=A_TABS}); scene_take();
    habitat_touch(true,233,300,4000); habitat_touch(true,233,120,4100);
    habitat_touch(false,233,300,4200); scene_take();
    assert(ht_tab_carousel_index(&tab_carousel)==1 && !tab_switches && !starts && s.view==TABS);
    habitat_touch(true,233,233,4400); habitat_touch(true,120,233,4500);
    habitat_touch(true,233,233,4700); habitat_touch(false,233,233,4900);
    surface_tick(5200); scene_take(); assert(ht_tab_carousel_index(&tab_carousel)==1 && !tab_switches);
    // All 24 tabs remain reachable. Physical left/right is independent of desktop scroll preference.
    workspace_setup(); s.tab_count=24;
    for(int i=4;i<24;i++) {
        snprintf(s.tabs[i].id,sizeof s.tabs[i].id,"tab-%d",i);
        snprintf(s.tabs[i].name,sizeof s.tabs[i].name,"Workspace %d",i);
    }
    strcpy(s.selected_tab,"tab-23"); dispatch((action_t){.kind=A_TABS}); scene_take();
    assert(ht_tab_carousel_index(&tab_carousel)==23 && s.hits[0].value==23);
    portrait(dir,"tabs-last");
    scroll_reversed=true;
    for(int wanted=22;wanted>=0;wanted--) {
        uint32_t t=6000+(22-wanted)*1000;
        habitat_touch(true,203,233,t); habitat_touch(true,263,233,t+300);
        habitat_touch(false,263,233,t+450); surface_tick(t+700); scene_take();
        assert(ht_tab_carousel_index(&tab_carousel)==wanted && !tab_switches && !starts);
    }
    scroll_reversed=false;
    // Changed identities cancel stale contacts; only pane-count changes preserve motion.
    habitat_touch(true,233,233,30000);
    s.tabs[0].panes++; ui_swarms_replace(s.tabs,24,"tab-23");
    assert(!s.touch_cancelled);
    ui_swarms_replace(s.tabs,2,"tab-1");
    habitat_touch(false,233,233,30075); scene_take();
    assert(!tab_switches && !starts && s.hit_count==3 && ht_tab_carousel_index(&tab_carousel)==0);
    ui_swarms_replace(NULL,0,NULL); scene_take(); portrait(dir,"tabs-empty");
    assert(s.hit_count==1 && action_enabled(A_HOME) && !action_enabled(A_TAB));
    workspace_setup(); s.connected=false; dispatch((action_t){.kind=A_TABS}); scene_take();
    assert(!action_enabled(A_TAB)); tap(32000,233,233); assert(!tab_switches && !starts);
    // Long names wrap without painting into the rim. The only footer is Back.
    workspace_setup(); COPY(s.tabs[1].name,"A workspace with a longer name for device development");
    dispatch((action_t){.kind=A_TABS}); scene_take(); portrait(dir,"tabs-long-name");
    tap(33000,233,420); assert(s.view==HOME && !tab_switches && !starts);
    reset(); s.view=INBOX; dispatch((action_t){.kind=A_NOTICE,.id="off-tab-agent"});
    assert(desktop_opens==1 && !strcmp(opened_agent,"off-tab-agent") && s.view==INBOX);
    assert(!visit.pending && !visit_sends && !starts); // Works with the shipping agent.open protocol.
    reset(); s.view=INBOX; s.connected=false; dispatch((action_t){.kind=A_NOTICE,.id="a"});
    assert(!desktop_opens && !visit_sends);
    reset(); s.view=INBOX; congestion=true; dispatch((action_t){.kind=A_NOTICE,.id="a"});
    assert(!desktop_opens && s.view==MESSAGE && !visit.pending);
    workspace_setup(); habitat_touch(true,233,230,1000);
    habitat_touch(true,233,230,1700); habitat_touch(true,100,230,1800);
    habitat_touch(false,100,230,1900); scene_take(); portrait(dir,"tabs-from-gesture");
    habitat_touch(true,263,233,2000); habitat_touch(true,203,233,2300); habitat_touch(false,203,233,2450);
    surface_tick(2700); scene_take();
    habitat_touch(true,263,233,3000); habitat_touch(true,203,233,3300); habitat_touch(false,203,233,3450);
    surface_tick(3700); scene_take(); tap(4000,233,233); // Research. The normal switch receipt still applies.
    assert(tab_switches==1 && !strcmp(tab_target,"tab-3") && s.loading && s.view==MESSAGE);
    uint32_t serial=workspace.serial;
    ui_land_after_reload(); assert(s.loading); // A periodic refresh is not a switch receipt.
    ui_workspace_applied("tab-3",3); ui_land_after_reload(); assert(s.loading);
    ui_swarms_replace(s.tabs,s.tab_count,"tab-3"); assert(tab_queued.kind==A_TAB_REFRESH);
    assert(ht_workspace_refresh(&workspace,serial,10));
    ui_workspace_applied("tab-1",11); ui_land_after_reload(); assert(s.loading);
    ui_workspace_applied("tab-3",10); ui_land_after_reload(); assert(s.loading);
    ui_workspace_applied("tab-3",11); ui_land_after_reload(); assert(!s.loading && s.view==HOME);
    assert(workspace.phase==HT_WORKSPACE_IDLE && !starts);
    // Empty tabs have a valid receipt too, without inventing a voice recipient.
    dispatch((action_t){.kind=A_TAB,.id="tab-0"});
    ui_swarms_replace(s.tabs,s.tab_count,"tab-0"); assert(ht_workspace_refresh(&workspace,workspace.serial,11));
    s.count=0; s.active=-1; ui_workspace_applied("tab-0",12); ui_land_after_reload();
    assert(!s.loading && s.view==HOME && !active() && !starts);
    workspace_setup(); habitat_touch(true,233,230,1000); habitat_touch(true,233,230,1700);
    habitat_touch(true,100,230,1800); habitat_touch_cancel(); habitat_touch(false,100,230,1900);
    assert(!tab_switches && !starts && s.view==TABS);
    // The same gesture works on the smaller completed-turn portrait.
    workspace_setup(); s.agents[0].recap_ready=true; s.agents[0].has_event=true;
    strcpy(s.agents[0].preview,"Installed. The device reconnected."); scene_take(); portrait(dir,"completed-quiet-footer");
    habitat_touch(true,233,130,2000); habitat_touch(true,233,130,2700);
    habitat_touch(true,100,130,2800); habitat_touch(false,100,130,2900); scene_take();
    assert(s.view==TABS && !starts && !desktop_opens && !tab_switches);
    workspace_setup(); s.rim_enabled=true; active()->busy=true; scene_take(); tap(1000,233,41);
    assert(s.view==AGENTS && !starts && !moves);
    workspace_setup(); s.coasting=true; s.coast_until=2000; active()->busy=true; scene_take(); tap(1000,233,41);
    assert(s.view==HOME && down_reports==1 && ups==1 && !tab_switches && !starts);
    tap(1300,233,41); assert(s.view==AGENTS && !starts && !tab_switches);
    workspace_setup(); visit.available=true; strcpy(visit.label,"Return"); scene_take();
    assert(action_enabled(A_RETURN) && !action_enabled(A_TABS));
    workspace_setup(); carry.active=true; scene_take();
    assert(action_enabled(A_CARRY_DROP) && !action_enabled(A_TABS));
    workspace_setup(); congestion=true; dispatch((action_t){.kind=A_TAB,.id="tab-2"});
    assert(!s.loading && s.view==MESSAGE && workspace.phase==HT_WORKSPACE_IDLE && !tab_switches);
    reset(); dispatch((action_t){.kind=A_FIND}); scene_take();
    assert(s.view==FORM && form.pending && form.id[0] && form_actions==1 && form_command.op==HT_FORM_OPEN);
    char opening_id[48]; COPY(opening_id,form.id); uint32_t opening_request=form.request;
    assert(action_enabled(A_FORM_BACK) && !action_enabled(A_FORM_SAY));
    tap(2000,113,389); assert(s.view==HOME && !form.id[0] && form_command.op==HT_FORM_CLOSE);
    ht_form_page_t late={.active=true,.can_query=true,.revision=1};
    assert(!ht_form_reply(&form,opening_id,opening_request,true,&late,2100));
    dispatch((action_t){.kind=A_FIND}); assert(form.pending && form.request>opening_request);
    assert(ht_form_tick(&form,6000)); scene_take();
    assert(form.failed && action_enabled(A_FORM_BACK));
    tap(6500,113,389); assert(s.view==HOME && !form.id[0]);
    // A background refresh can coincide with any repaint. Its unchanged reply
    // must restore both the visible Say control and its real touch target.
    reset(); view(FORM);
    ht_form_page_t finder_page={.active=true,.can_query=true,.revision=1,
        .title="Find Harness",.label="Say a name",.action="open"};
    ht_form_open(&form,"find-test",1000,form_emit,NULL);
    if (ht_form_reply(&form,"find-test",form.request,true,&finder_page,1010)) scene_take();
    assert(action_enabled(A_FORM_SAY));
    ht_form_tick(&form,2010); assert(form.pending);
    scene_take(); // Touch or an agent status causes a frame while the read is in flight.
    assert(!action_enabled(A_FORM_SAY));
    if (ht_form_reply(&form,"find-test",form.request,true,&finder_page,2020)) scene_take();
    assert(action_enabled(A_FORM_SAY));
    tap(2200,223,389); assert(starts==1);
    reset(); portrait(dir, "ready");
    s.agents[0].busy = true; strcpy(s.agents[0].tool,"Running firmware checks"); scene_take(); portrait(dir, "working");
    habitat_touch(true,233,220,1000); assert(!starts); // act only on release
    habitat_touch(false,233,220,1075); scene_take();
    assert(starts==1 && !strcmp(target,"a") && s.view==VOICE);
    portrait(dir,"listening");
    bool listening_arc=false;
    for(int i=0;i<scene.count;i++) {
        assert(!strstr(scene.runs[i].text,"discard"));
        if(strstr(scene.runs[i].text,"Listening")) {
            assert(!strcmp(scene.runs[i].text,"Listening") && scene.runs[i].arc==2 && scene.runs[i].shimmer);
            listening_arc=true;
        }
    }
    assert(listening_arc && !action_enabled(A_VOICE_ABORT));
    tap(1200,233,220); tap(1400,233,220); assert(!stops); // double/triple are one intent
    s.active=1; input_cancel();
    assert(!strcmp(target,"a") && !strcmp(s.voice_target,"Deploy latest firmware"));
    tap(2400,233,220); assert(stops==1);
    tap(3200,233,422); assert(s.view==VOICE && s.voice_open && stops==1);
    dispatch((action_t){.kind=A_VOICE_ABORT}); // Finish the fixture's pending host reply.
    tap(4000,233,220); assert(starts==2 && !strcmp(target,"b"));

    reset(); tap(1000,233,220); tap(1200,233,422);
    assert(s.voice_open && s.view==VOICE && !stops); // Bottom caption never discards a capture.

    // Recording has a steady word (no clock to rerotate) over a moving body.
    // Listening alone gets the faster sweep; transmission keeps the moving body.
    reset(); tap(1000,233,220);
    unsigned first_frame=character.motion.frame;
    bool moved_while_listening=false;
    for(int i=0;i<32;i++) {
        fake_ms=2000+i*256; surface_tick(fake_ms); scene_take();
        moved_while_listening |= character.motion.frame != first_frame;
        assert(character.motion.running && character.motion.rate==2);
        bool animated=false;
        for(int j=0;j<scene.count;j++) if(scene.runs[j].arc==2) {
            assert(!strcmp(scene.runs[j].text,"Listening") && scene.runs[j].shimmer);
            animated=true;
        }
        assert(animated && !stops && !strcmp(target,"a"));
        char label[40];snprintf(label,sizeof label,"listening-live-%02d",i);portrait(dir,label);
    }
    assert(moved_while_listening);
    fake_ms=12288;surface_tick(fake_ms);scene_take();assert(s.status_phase==1);
    fake_ms=12320;surface_tick(fake_ms);scene_take();assert(s.status_phase==2);
    assert(status_wake_ms(12321)==31 && status_wake_ms(UINT32_MAX)==1);
    fake_ms=13312;surface_tick(fake_ms);scene_take();assert(s.status_phase==1);
    s.quiet=true;surface_tick(fake_ms);scene_take();
    assert(!character.motion.running);
    for(int j=0;j<scene.count;j++)assert(!scene.runs[j].shimmer);
    s.quiet=false;tap(fake_ms+1000,233,220);assert(stops==1);
    s.voice_waiting=true;recording=false;surface_tick(fake_ms);scene_take();portrait(dir,"voice-transmitting");
    assert(character.motion.running && !status_animated());
    for(int j=0;j<scene.count;j++) {
        assert(scene.runs[j].arc!=2 && !scene.runs[j].shimmer);
        assert(!strstr(scene.runs[j].text,"Listening") && !strstr(scene.runs[j].text,"Sending"));
    }
    s.voice_return=FORM; fake_ms=16384; surface_tick(fake_ms); scene_take();
    assert(status_is("Finding") && status_speed()==1 && status_wake_ms(16385)==63);
    s.view=HOME; active()->busy=true; fake_ms=15000; surface_tick(fake_ms); fake_ms=18432; surface_tick(fake_ms); scene_take(); assert(s.status_phase==1);
    fake_ms+=32; surface_tick(fake_ms); assert(s.status_phase==1);
    fake_ms+=32; surface_tick(fake_ms); assert(s.status_phase==2);

    reset(); habitat_touch(true,233,220,1000); s.active=1; input_cancel();
    habitat_touch(false,233,220,1075); assert(!starts);
    tap(1200,233,220); assert(starts==1 && !strcmp(target,"b"));
    reset(); habitat_touch(true,233,220,1000); habitat_touch_cancel();
    habitat_touch(false,233,220,1080); assert(!starts);
    tap(1200,233,220); assert(starts==1);
    reset(); habitat_touch(true,233,220,1000);
    habitat_touch(true,233,170,1020); assert(moves>0 && !starts && travel==-50);
    habitat_touch(true,233,220,1040); habitat_touch(false,233,220,1080);
    assert(!starts && s.coasting);
    tap(1200,233,220); assert(!starts); // tap brakes, even over Tim
    tap(1500,233,220); assert(starts==1);
    reset(); habitat_touch(true,233,220,1000);
    habitat_touch(true,310,220,1020); habitat_touch(true,233,220,1040);
    habitat_touch(false,233,220,1080); assert(!starts && !switches);
    tap(1200,233,220); assert(starts==1);
    reset(); habitat_touch(true,320,220,1000); habitat_touch(false,150,220,1120);
    assert(switches==1 && s.active==1 && !moves);
    reset(); congestion=true;
    habitat_touch(true,233,220,1200); habitat_touch(true,233,300,1220);
    habitat_touch(false,233,220,1270); assert(!starts);
    tap(1390,233,220); assert(starts==1);
    reset(); habitat_touch(true,233,220,1000); habitat_touch(false,233,220,1700);
    assert(s.view==TABS && !starts);
    reset(); active()->busy=true; scene_take(); tap(1000,233,41); assert(s.view==AGENTS && !starts);
    reset(); s.connected=false; scene_take(); portrait(dir,"offline");
    assert(scene.count==1 && !strcmp(scene.runs[0].text,"Harness") && !s.hit_count);
    assert(!scene.runs[0].arc && !scene.runs[0].shimmer);
    ht_rect_t brand=ht_run_bounds(&scene.runs[0]);
    assert(abs(brand.x*2+brand.w-466)<=1 && abs(brand.y*2+brand.h-466)<=1);
    tap(1000,233,220); assert(!starts);
    surface_tick(1500); assert(!character.motion.running);
    // Handshake alone is not ready: retain the wordmark until the roster lands.
    s.connected=true; s.loading=true; scene_take(); portrait(dir,"connecting");
    assert(scene.count==1 && !strcmp(scene.runs[0].text,"Harness") && !s.hit_count);
    surface_tick(2000); assert(!character.motion.running);
    ui_land_after_reload(); scene_take(); assert(scene.count>1);
    s.view=OTA; scene_take(); portrait(dir,"updating");
    assert(scene.count==1 && !strcmp(scene.runs[0].text,"Harness") && !s.hit_count);
    reset(); s.count=0; s.active=-1; scene_take();
    tap(1000,233,220); assert(!starts);
    // A missed utterance keeps the entire creature as the retry target.
    reset(); ui_project_emit("a",NULL,"summary","Previous result stays saved.","Previous result stays saved.");
    s.voice_retry_until=4000; scene_take(); portrait(dir,"voice-retry");
    assert(status_is("Try again") && !result_visible() && action_enabled(A_PET));
    for(int i=0;i<scene.count;i++)assert(!scene.runs[i].shimmer);
    s.voice_retry_until=0; scene_take(); assert(result_visible());
    s.voice_retry_until=4000; scene_take(); tap(1000,233,220);
    assert(starts==1 && s.view==VOICE && !s.voice_retry_until && !strcmp(target,"a"));
    // Hold opens one destination immediately; every direction of the opening contact is consumed.
    const int hold_ends[][2]={{233,220},{330,220},{130,220},{233,130},{233,320}};
    for(unsigned i=0;i<sizeof hold_ends/sizeof hold_ends[0];i++) {
        workspace_setup(); habitat_touch(true,233,220,1000); surface_tick(1650);
        assert(s.view==TABS && s.touch_cancelled && !starts); scene_take();
        habitat_touch(true,hold_ends[i][0],hold_ends[i][1],1700);
        habitat_touch(false,hold_ends[i][0],hold_ends[i][1],1800);
        assert(s.view==TABS && !starts && !moves && !tab_switches && ht_tab_carousel_index(&tab_carousel)==1);
    }
    scene_take(); portrait(dir,"hold-tabs");
    tap(2000,233,420); assert(s.view==HOME && !starts);
    // Legacy controls remain covered without a Controls entry in the picker.
    dispatch((action_t){.kind=A_SETTINGS}); scene_take(); portrait(dir,"controls");
    dispatch((action_t){.kind=A_SELECT_BEGIN});
    assert(s.view==SELECTION && !starts && selected_command.op==HT_SELECT_BEGIN);
    assert(ht_selection_reply(&selection,selection.request,"pick-test",true,1,"Which part should change?",1,false,NULL,1810));
    scene_take(); portrait(dir,"selection");
    habitat_touch(true,233,290,2100); habitat_touch(true,233,240,2160);
    habitat_touch(false,233,240,2210); assert(!starts && !moves && selection.pending);
    assert(selected_command.op==HT_SELECT_STEP && selected_command.delta==2);
    scene_take(); tap(2400,233,220); assert(!starts); // await the current highlight
    assert(ht_selection_reply(&selection,selection.request,"pick-test",true,2,"A highlighted paragraph",3,true,NULL,2500));
    scene_take(); portrait(dir,"selection-range");
    action_t to_carry=make_action((hit_t){.action=A_CARRY});
    to_carry.dy--; dispatch(to_carry); assert(!carry.pending && !carry_prepares);
    tap(2650,330,350); assert(carry.pending && carry_prepares==1 && !starts);
    tap(2800,233,220); assert(!starts); // no voice while the selected text is being frozen
    assert(ht_carry_reply(&carry,carry.id,carry.request,true,"Research helper","A highlighted paragraph",3,300000,NULL,3000));
    ht_selection_close(&selection); view(HOME); s.active=1; scene_take(); portrait(dir,"carry-home");
    tap(3400,233,220); assert(starts==1 && s.voice_carry && !strcmp(target,"b") && !strcmp(voice_context,carry.id));
    scene_take(); portrait(dir,"carry-listening");
    dispatch((action_t){.kind=A_VOICE_ABORT}); scene_take();
    tap(4100,233,410); assert(!carry.active && carry_drops==1 && starts==1);
    reset(); view(SELECTION); ht_selection_open(&selection,"pick-test","a",1000,select_emit,NULL);
    assert(ht_selection_reply(&selection,selection.request,"pick-test",true,1,"A highlighted paragraph",3,true,NULL,1010));
    action_t selected_action=make_action((hit_t){.action=A_PET});
    assert(!strcmp(selected_action.text,"pick-test") && selected_action.dy==1);
    tap(2700,233,220); assert(starts==1 && s.view==VOICE && !strcmp(target,"a"));
    reset(); habitat_touch(true,233,220,1000); surface_tick(1650); habitat_touch_cancel();
    habitat_touch(false,233,220,1800); assert(s.view==TABS && !starts);
    reset(); habitat_touch(true,233,220,1000); surface_tick(1650); surface_tick(6000);
    habitat_touch(false,233,220,6100); assert(s.view==TABS && !starts); // resting hand never selects a tab
    reset(); habitat_touch(true,233,220,1000); habitat_touch(true,233,170,1100);
    surface_tick(1650); habitat_touch(false,233,170,1800);
    assert(s.view==HOME && !starts); // a drag can never become a hold
    reset(); habitat_touch(true,233,220,1000); habitat_touch(false,53,220,1700);
    assert(s.view!=TABS && switches==1 && !starts); // delayed final motion is classified before hold
    reset(); habitat_touch(true,233,220,1000); habitat_touch(true,233,80,1700);
    habitat_touch(false,233,80,1800); assert(s.view==HOME && moves && !starts);
    reset(); s.rim_enabled=true; tap(1000,433,233); assert(!starts && !switches);
    habitat_touch(true,433,233,2000); habitat_touch(true,418,310,2100);
    habitat_touch(true,374,374,2200); habitat_touch(true,310,418,2300);
    habitat_touch(false,233,433,2400); assert(travel<0 && !switches && !starts && !s.coasting);
    reset(); s.rim_enabled=true; congestion=true;
    habitat_touch(true,433,233,2000); habitat_touch(true,233,433,2100);
    habitat_touch(false,33,233,2200); assert(!starts && !switches); // even backpressured rim owns contact
    reset(); s.focus_face=true; s.agents[0].busy=true;
    strcpy(s.agents[0].tool,"Running firmware checks"); scene_take(); portrait(dir,"focus");
    tap(1000,233,220); assert(starts==1); // same voice muscle memory in both faces
    reset(); s.straight_title=true; scene_take(); portrait(dir,"straight-title");
    reset(); s.nap=true; scene_take(); portrait(dir,"asleep");
    reset(); s.pet_pose=3; scene_take(); portrait(dir,"done");
    reset(); s.pet_pose=1; scene_take(); portrait(dir,"booped");
    reset(); waiting_count=1; s.notice_count=1; scene_take(); portrait(dir,"attention");
    tap(1000,233,375); assert(s.view==VOICE && starts==1);
    dispatch((action_t){.kind=A_VOICE_ABORT}); starts=0; scene_take();
    tap(2700,233,420); assert(s.view==INBOX && !starts);
    reset(); visit.available=true; scene_take(); portrait(dir,"return");
    tap(1000,233,409); assert(returns==1 && !starts); visit.available=false;
    reset(); COPY(s.agents[0].name,"A very long recipient name that still needs to be readable on a tiny circular display");
    scene_take(); portrait(dir,"long-name");
    reset(); ht_form_open(&form,"form-test",100,form_emit,NULL);
    ht_form_page_t page={.active=true,.enabled=true,.revision=1,.position=4,.total=4,
        .title="New Harness",.label="New Harness",.action="start",.previous="Options",
        .detail="Claude Code\nM2:~/code/harness"};
    ht_form_reply(&form,"form-test",form.request,true,&page,101); s.view=FORM; scene_take();
    portrait(dir,"new-harness");
    tap(1000,290,375); assert(form_actions==2 && form_command.op==HT_FORM_ACTIVATE && !starts);
    page.revision++; ht_form_reply(&form,"form-test",form.request,true,&page,1090); scene_take();
    tap(1200,290,375); assert(form_actions==2); // a double tap cannot launch twice
    tap(1700,290,375); assert(form_actions==3 && !starts);
    ht_form_reply(&form,"form-test",form.request,true,&page,1800); scene_take();
    int before=form_actions;
    habitat_touch(true,233,260,2500); habitat_touch(true,234,180,2590); habitat_touch(false,234,180,2660);
    assert(form_actions==before+1 && form_command.op==HT_FORM_MOVE && !starts && !switches);
    page.revision++; ht_form_reply(&form,"form-test",form.request,true,&page,2700); scene_take();
    habitat_touch(true,120,233,3100); habitat_touch(true,280,234,3190); habitat_touch(false,280,234,3260);
    assert(form_command.op==HT_FORM_BACK && !starts && !switches);
    page.revision++; strcpy(page.error,"Choices changed. Try again.");
    ht_form_reply(&form,"form-test",form.request,false,&page,3300); scene_take(); portrait(dir,"new-harness-stale");
    page.can_query=true; strcpy(page.title,"Project"); strcpy(page.label,"harness");
    strcpy(page.query,"harness"); strcpy(page.action,"choose"); page.error[0]=0;
    form.page=page; form.pending=false; scene_take(); portrait(dir,"spoken-project");
    int speech_before=starts;
    habitat_touch(true,220,390,4000); habitat_touch(true,220,300,4090); habitat_touch(false,220,300,4160);
    assert(starts==speech_before); // a drag starting on Say is still only movement
    page.revision++; ht_form_reply(&form,"form-test",form.request,true,&page,4200); scene_take();
    tap(5000,220,391); assert(starts==speech_before+1);
    tap(5200,220,391); assert(starts==speech_before+1); // rapid duplicate cannot open twice
    reset(); strcpy(form.id,"find-test"); s.view=FORM;
    form.page=(ht_form_page_t){.active=true,.enabled=true,.can_query=true,.revision=1,
        .position=1,.total=2,.title="Find Harness",.label="Fix login screen",
        .detail="Codex / M2\nopenharness",.query="login",.next="Login flow tests",.action="open"};
    scene_take(); portrait(dir,"find-named");
    reset(); s.view=QUESTION; s.q.valid=s.q.supported=true; s.q.count=1; s.q.revision=1;
    strcpy(s.q.agent,"a"); strcpy(s.q.token,"token-a"); strcpy(s.q.name,"Research helper");
    strcpy(s.q.item[0].prompt,"One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight");
    s.q.item[0].count=3;
    strcpy(s.q.item[0].options[0],"This file"); strcpy(s.q.item[0].options[1],"Whole project"); strcpy(s.q.item[0].options[2],"Leave it");
    scene_take(); habitat_touch(true,233,270,1000); habitat_touch(true,233,150,1100); habitat_touch(false,233,150,1180);
    assert(s.offset==3 && !starts && !question_sends && !s.q.item[0].selected);
    scene_take(); tap(2000,300,370); assert(s.view==CHOICE);
    scene_take(); habitat_touch(true,233,240,2500); habitat_touch(true,233,195,2580); habitat_touch(false,233,195,2650);
    assert(s.q.choice==1 && !s.q.item[0].selected && !question_sends);
    scene_take(); tap(3000,233,320); assert(s.q.item[0].selected==2);
    scene_take(); tap(4000,305,393); assert(s.view==ANSWER_REVIEW && !question_sends);
    scene_take(); tap(4150,305,393); assert(!question_sends); // Rapid second tap cannot skip review.
    scene_take(); tap(4800,305,393); assert(question_sends==1 && s.q.pending && !starts);
    strcpy(s.agents[0].name,"Research helper");
    s.q.pending=false;s.q.item[0].selected=0;s.q.item[0].can_text=true;question_sends=0;view(QUESTION);scene_take();
    habitat_touch(true,223,350,6000);habitat_touch(true,223,280,6100);habitat_touch(false,223,280,6180);
    assert(!starts && !question_sends); // Drag beginning on Say still reads.
    scene_take();tap(7000,223,350);assert(starts==1 && s.view==VOICE && s.voice_return==QUESTION);
    assert(!strcmp(target,"a") && !strcmp(voice_context,"token-a"));scene_take();portrait(dir,"question-listening");
    tap(7140,233,220);assert(!stops); // Say's second tap cannot instantly end the new capture.
    tap(7800,233,220);assert(stops==1 && !question_sends);
    s.voice_open=false;strcpy(s.q.item[0].draft,"reviewed-draft");
    strcpy(s.q.item[0].answer,"Keep the public API. Only change the parser.");view(ANSWER_REVIEW);
    ht_gesture_guard(&gesture,9000);scene_take();tap(9050,330,350);assert(!question_sends);
    scene_take();tap(9600,330,350);assert(question_sends==1);

    reset(); tap(1000,233,220); scene_take();
    habitat_touch(true,233,220,2000); surface_tick(2675); assert(s.voice_review_preview); scene_take(); portrait(dir,"voice-review-hold");
    habitat_touch(false,233,220,2750); assert(stops==1 && reviews==1);
    reset(); tap(1000,233,220); scene_take();
    habitat_touch(true,233,220,2000); habitat_touch(true,233,195,2050); surface_tick(2700);
    assert(!s.voice_review_preview); habitat_touch(false,233,220,2800); assert(!stops && !reviews);
    reset(); tap(1000,233,220); scene_take();
    habitat_touch(true,233,220,2000); surface_tick(4000); habitat_touch(false,233,220,4100);
    assert(!stops && !reviews); // Resting a hand is not review.
    reset(); s.view=DRAFT;
    ht_draft_page_t draft_page={.active=true,.revision=1,.can_send=true,.id="draft-one",.agent="a",.name="Parser helper",
        .text="Keep the public API.\n\nOnly change the parser.\nPreserve existing tests.\nAdd Unicode coverage.\nDo not rename exports.\nKeep async behavior.\nKeep all exported types.",.position=1,.total=2};
    ht_draft_open(&draft,&draft_page,draft_emit,NULL);scene_take();portrait(dir,"voice-draft");
    ht_gesture_guard(&gesture,1000);tap(1100,300,389);assert(!draft_actions); // Fast second tap cannot Send.
    scene_take();habitat_touch(true,233,250,2000);habitat_touch(true,233,170,2080);habitat_touch(false,233,170,2160);
    assert(!starts && s.offset==2 && !draft_actions);scene_take();
    habitat_touch(true,233,250,3000);habitat_touch(true,233,90,3080);habitat_touch(false,233,90,3160);
    assert(!draft_actions && !starts);
    scene_take();
    habitat_touch(true,233,280,3200); habitat_touch(true,233,60,3260); habitat_touch(false,233,60,3340);
    assert(draft_actions==1 && draft_command.op==HT_DRAFT_MOVE && !starts);
    draft_page.revision=2;draft_page.position=2;strcpy(draft_page.text,"And keep the documentation up to date.");
    ht_draft_reply(&draft,draft_page.id,draft.request,true,&draft_page);scene_take();tap(4000,233,220);
    assert(starts==1 && s.voice_return==DRAFT && !strcmp(voice_context,"draft-one"));
    s.voice_open=recording=false;view(DRAFT);scene_take();
    habitat_touch(true,233,220,5000);habitat_touch(false,233,220,5750);scene_take();
    assert(s.view==DRAFT_OPTIONS && starts==1);portrait(dir,"voice-draft-options");
    tap(6400,200,330);assert(s.view==DRAFT);scene_take();tap(7200,305,389);
    assert(draft.pending && draft_command.op==HT_DRAFT_SEND && draft_actions==2);
    reset(); view(SELECTION); ht_selection_open(&selection,"pick-test","a",1000,select_emit,NULL);
    assert(ht_selection_reply(&selection,selection.request,"pick-test",true,1,"A remembered phrase",1,false,NULL,1010));
    scene_take(); tap(1600,110,362); assert(starts==1 && s.voice_search && !strcmp(voice_context,"pick-test"));
    scene_take(); portrait(dir,"search-listening");
    tap(2300,233,220); assert(stops==1 && !reviews);
    s.voice_open=recording=false; view(SELECTION);
    assert(ht_selection_found(&selection,"pick-test","a",2,"ERROR: connection refused. Retrying in five seconds.",2,"connection refused",2,7));
    scene_take(); portrait(dir,"output-search");
    habitat_touch(true,233,290,3000); habitat_touch(true,233,230,3060); habitat_touch(false,233,230,3120);
    assert(selected_command.op==HT_SELECT_MATCH && selected_command.delta==1 && starts==1 && !moves);
    assert(ht_selection_reply_search(&selection,selection.request,"pick-test",true,3,"connection refused again",1,false,NULL,"connection refused",3,7,3200));
    scene_take(); tap(3700,233,220); assert(starts==2 && !s.voice_search); // matched passage becomes ordinary quoted speech
    s.voice_open=recording=false; view(SELECTION);
    assert(ht_selection_found(&selection,"pick-test","a",4,"",0,"missing phrase",0,0));
    scene_take(); portrait(dir,"output-search-empty");
    tap(4400,233,220); assert(starts==2); // Nothing to quote.
    tap(5100,233,362); assert(starts==3 && s.voice_search); // Search remains usable.
    // Pane navigation remains available from the home caption.
    reset(); tap(1000,233,41); assert(s.view==AGENTS && !starts && !moves);
    scene_take(); portrait(dir,"panes");
    reset(); s.count=8; s.active=7;
    for(int i=0;i<8;i++) { snprintf(s.agents[i].id,sizeof s.agents[i].id,"pane-%d",i); snprintf(s.agents[i].name,sizeof s.agents[i].name,"Pane %d",i); }
    view(AGENTS); scene_take(); assert(s.hit_count==5);
    habitat_touch(true,233,380,1000); habitat_touch(true,233,100,1300);
    assert(s.offset==4 && !starts && !switches && !moves);
    habitat_touch(false,233,100,1375); scene_take();
    assert(s.offset==4 && !strcmp(make_action(s.hits[4]).id,"pane-7"));
    portrait(dir,"panes-last");
    // Every advertised optional control is present, none appear for a legacy host.
    reset(); host_features=0; view(SETTINGS); scene_take();
    assert(settings_count()==7 && !action_enabled(A_FORM) && !action_enabled(A_LATEST));
    portrait(dir,"controls-core");
    habitat_touch(true,233,370,1000); habitat_touch(true,233,160,1250); habitat_touch(false,233,160,1300);
    scene_take(); assert(s.offset==3 && action_enabled(A_MUTE) && action_enabled(A_BRIGHT));
    portrait(dir,"controls-core-scroll");
    dispatch((action_t){.kind=A_FIND}); assert(s.view==AGENTS && !form_actions && !starts);
    dispatch((action_t){.kind=A_LATEST,.id="a"}); assert(!visit_sends);
    reset(); host_features=0; tap(1000,233,220); assert(starts==1 && recording);
    habitat_touch(true,233,220,2000); surface_tick(2700); assert(!s.voice_review_preview);
    habitat_touch(false,233,220,2800); assert(!stops && !reviews && recording);
    tap(3400,233,220); assert(stops==1 && !reviews);
    puts("touch UI: PASS (production contacts/renderers; voice start/finish/discard, target pinning, sensor cancellation, immediate scroll, swipes, round trips, congestion and holds)");
}
'''
extra_sources = []
extra_includes = ['-DDEVICE_HABITAT_ORANGE=1'] if os.environ.get('HABITAT_TEST_ORANGE') else []
if os.environ.get('HABITAT_COMPANION_TEST'):
    assert not os.environ.get('HABITAT_BRIDGE_TRACE'), 'Run the two specialized replays separately'
    from companion_touch_replay import instrument
    code = instrument(code, source)
    json_dir = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'
    extra_sources = [str(native / 'companion.c'), str(json_dir / 'cJSON.c')]
    extra_includes += ['-DDEVICE_DESKTOP_COMPANION=1', '-I', str(json_dir), '-Wno-deprecated-declarations']
if os.environ.get('HABITAT_BRIDGE_TRACE'):
    from bridge_flow_replay import instrument
    code = instrument(code, os.environ['HABITAT_BRIDGE_TRACE'], native.parent.parent)
    json_dir = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'
    extra_sources = [str(json_dir / 'cJSON.c'), str(native.parent.parent / 'cable_frame.c'),
                     str(native.parent.parent / 'cable_json_guard.c')]
    extra_includes += ['-I', str(json_dir), '-I', str(native.parent.parent), '-Wno-deprecated-declarations']

with tempfile.TemporaryDirectory(prefix='harness-touch-ui-') as d:
    out = Path(d)
    (out / 'touch_ui.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g',
                    '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
                    *extra_includes, '-I',str(native),str(out/'touch_ui.c'), *extra_sources, str(native/'gestures.c'),
                    str(native/'form.c'),str(native/'visit.c'),str(native/'draft.c'), str(native/'scroll.c'),str(native/'selection.c'),str(native/'carry.c'),str(native/'tim.c'),str(native/'character_motion.c'),str(native/'character_layout.c'),str(native/'character.c'),str(native/'tux.c'),str(native/'terminal.c'),
                    str(native/'fonts.c'),str(native/'octopus.c'),str(native/'ascii_clip.c'),str(native/'octopus_font.c'),str(native/'workspace.c'),str(native/'command_face.c'),'-o',str(out/'touch_ui')],check=True)
    args=[str(out/'touch_ui')]
    if os.environ.get('HABITAT_PREVIEW_DIR'):
        dest=Path(os.environ['HABITAT_PREVIEW_DIR']);dest.mkdir(parents=True,exist_ok=True)
        args.append(str(dest))
    subprocess.run(args,check=True)
    tux_env = dict(os.environ, HABITAT_TEST_TUX='1')
    if len(args) == 2:
        tux_preview = Path(args[1]) / 'tux'; tux_preview.mkdir(exist_ok=True)
        args[1] = str(tux_preview)
    subprocess.run(args,check=True,env=tux_env)
