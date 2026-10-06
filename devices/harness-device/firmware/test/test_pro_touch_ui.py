"""Replay native Pro contacts through the production Habitat gesture dispatcher.

Uses the real UI state, hit/action types, input cancellation, hold timer and touch
handler, with command emission as the boundary. This complements the round-dial
renderer suite: it deliberately enables the 720 px branches that suite omits.
Requires the generated Pro fonts/art header from prototype/pro-companion/tools.
Actual home/voice renderers and proportional fonts are checked for bounds and
non-overlap; only bitmap decoding is stubbed, using generated asset dimensions.
No USB, hardware writes, microphone or live app commands are used.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

from native_voice import voice_assets
from native_shapes import defines, typedef

HERE = Path(__file__).resolve().parent
NATIVE = HERE / "../main/ui/habitat"
SOURCE = Path(os.environ.get("UI_SOURCE", NATIVE / "ui_habitat.c")).read_text()


def function(name, source=SOURCE):
    match = re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{.*?^\}", source, re.M | re.S)
    assert match, f"production function missing: {name}"
    return match.group(0) + "\n"


code = r'''
#include "runtime.h"
#include "../../cable_features.h"
#include "../../cable_machines.h"
#include "gestures.h"
#include "scroll.h"
#include "workspace.h"
#include "selection.h"
#include "carry.h"
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "character.h"
#include "pro_canvas.h"
#include "pro_work_intent.h"
#include "pro_metrics.h"
#include "../../pro_voice_samples.h"
#include "pro_visual.h"
#include "pro_art.h"
#include "../../audio_speech.h"
#include "../companion_speech.h"
#include "theme.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define ESP_LOGI(tag, ...) do { (void)(tag); if (false) fprintf(stderr, __VA_ARGS__); } while (0)
#define COPY(dst, src) snprintf(dst, sizeof(dst), "%s", src)
'''
code += defines("CABLE_READ_TOKEN_MAX", "ID_MAX", "CABLE_NAME_MAX", "SWARM_ID_MAX", "SWARMS_MAX",
                "SWARM_TILES_MAX", "CABLE_MAX_AGENTS", "MAX_PROJECTS")
code += defines("NOTICES", "QUESTION_MAX", "OPTION_MAX", "PANE_MEMORY_MAX", "PANE_RESULT_BYTES", "DRAFT_ROWS", "Q_ROWS", source=SOURCE)
code += "\n".join(re.findall(r"^#define TAB_\w+ \d+$", SOURCE, re.M)) + "\n"
for name in ("cable_swarm_t", "cable_notif_t", "cable_tile_t", "model_item_t"):
    code += typedef(name)
code += SOURCE[SOURCE.index("typedef enum {"):SOURCE.index("static QueueHandle_t actions;")]
# Allows the suite to demonstrate the missing launcher against the old baseline.
if not re.search(r"\bA_LAUNCHER\b", SOURCE):
    code += "#define LAUNCHER ((view_t)1000)\n#define A_LAUNCHER ((action_kind_t)1000)\n"
code += r'''
static ht_gesture_t gesture;
static ht_scroll_t scroll;
static ht_workspace_t workspace;
static ht_tab_carousel_t tab_carousel;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static ht_character_t character;
static ht_character_caption_t home_caption;
static action_t pressed_action;
static ht_rect_t pressed_rect;
static bool scroll_reversed, recording, asleep, congested;
static char saved_language[8]="en";
static bool fail_language_save;
static bool config_save_voicelang(const char *lang) { if(fail_language_save)return false; snprintf(saved_language,sizeof saved_language,"%s",lang); return true; }
static void config_load_voicelang(char *out,size_t n) {snprintf(out,n,"%s",saved_language);}
#define CFG_VLANG_MAX 8
static unsigned starts, stops, discards, switches, launches, selected, down_reports, moves, ups, queued;
static int travel;
static action_t sent, queued_action;
static uint32_t now, visual_wake=1000;
static unsigned unread, lock_checks;
static unsigned changes, speech_aborts, speech_snapshots;
static uint32_t aborted_id;
static audio_speech_state_t speech_audio;
static bool drawn_compact;
static ht_character_mood_t drawn_mood;
static unsigned drawn_level, drawn_emotion;
static ht_rect_t drawn_portrait;
static bool native_voice_available = true;
bool audio_speech_available(void) { return native_voice_available; }
bool audio_speech_begin(uint32_t id, uint32_t rate, uint8_t volume) { (void)rate;(void)volume;speech_audio=(audio_speech_state_t){.id=id,.active=true,.pending=true};return true; }
bool audio_speech_push(uint32_t id,uint32_t offset,const void *pcm,size_t bytes) { (void)id;(void)offset;(void)pcm;(void)bytes;return true; }
bool audio_speech_end(uint32_t id,uint32_t bytes) { (void)id;(void)bytes;return true; }
bool audio_speech_set_volume(uint32_t id,uint8_t volume) { (void)id;(void)volume;return true; }
static uint32_t ms(void) { return now; }
static uint32_t esp_random(void) { return 0x12345678; }
static void change(void) { changes++; }
static void display_lock(void) {}
static void display_unlock(void) {}
static bool queue(action_t action) {
    if (congested) return false;
    queued++; queued_action=action; return true;
}
static bool config_check_lock(const char *pattern) {
    lock_checks++; return !strcmp(pattern,"0,1,2,5");
}
static bool display_is_asleep(void) { return asleep; }
static bool audio_client_active(void) { return recording; }
static void audio_client_abort(void) { recording=false; }
static bool audio_client_recording(void) { return recording; }
static unsigned audio_client_input_level(void) { return 0; }
static bool cable_client_supports(uint32_t feature) { (void)feature; return true; }
static agent_t *active(void) { return s.active >= 0 && s.active < s.count ? &s.agents[s.active] : NULL; }
static void notice_flush_reads(uint32_t at) { (void)at; }
static unsigned notice_unread(void) { return unread; }
static bool home_caption_tick(uint32_t at) { (void)at; return false; }
static bool status_animated(void) { return false; }
static unsigned status_speed(void) { return 1; }
static bool home_caption_rotates(void) { return false; }
static ht_character_mood_t character_mood(void) { return HT_CHARACTER_IDLE; }
void audio_speech_snapshot(audio_speech_state_t *out) { speech_snapshots++; *out=speech_audio; }
void audio_speech_abort(uint32_t id) {
    speech_aborts++; aborted_id=id;
    if (!id || id==speech_audio.id) {
        speech_audio.active=speech_audio.playing=speech_audio.pending=false;
        speech_audio.error=AUDIO_SPEECH_ERROR_ABORTED;
    }
}
bool pro_visual_changed(const ht_character_t *c,ht_character_mood_t mood,uint32_t at,bool quiet,bool mail) {
    (void)c;(void)mood;(void)at;(void)quiet;(void)mail;return false;
}
uint32_t pro_visual_next_wake_ms(const ht_character_t *c,ht_character_mood_t mood,uint32_t at,bool quiet,bool mail) {
    (void)c;(void)mood;(void)at;(void)quiet;(void)mail;return visual_wake;
}
static bool config_lock_enabled(void) { return true; }
static void open_question(void);
bool ht_character_tick(ht_character_t *c, uint32_t at, ht_character_mood_t mood,
                       bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity) {
    (void)c; (void)at; (void)mood; (void)quiet; (void)visible; (void)down;
    (void)x; (void)level; (void)activity; return false;
}
bool ht_character_delivery_tick(ht_character_t *c, uint32_t at, bool pending,
                                uint32_t sequence, bool animate) {
    (void)c; (void)at; (void)pending; (void)sequence; (void)animate; return false;
}
static bool scroll_emit(ht_scroll_phase_t phase, int dy, int velocity, void *ctx) {
    (void)velocity; (void)ctx;
    if (congested) return false;
    if (phase == HT_SCROLL_DOWN) down_reports++;
    if (phase == HT_SCROLL_MOVE) { moves++; travel += dy; }
    if (phase == HT_SCROLL_UP) { ups++; travel += dy; }
    return true;
}
static void dispatch(action_t action);
'''
for name in ("copy", "find", "pane_memory", "pane_memory_apply", "pro_work_local", "pro_work_available", "pro_work_capture_available", "pro_work_draft_available", "pro_busy_reset", "ensure", "waiting", "is_question", "pro_speech_allowed", "pro_speech_visible", "pro_speech_emotion",
             "pro_speech_caption", "pro_speech_cancel", "ui_companion_speech_begin", "ui_companion_speech_clear",
             "pro_speech_tick", "pro_busy_elapsed", "pro_surface_mood", "status_wake_ms",
             "question_view", "hit_contains", "home_footer", "pro_written_control",
             "settings_item", "settings_count", "tabs_move", "make_action", "input_cancel", "view",
             "question_rows", "question_move", "draft_move",
             "pro_appearance_view", "pro_appearance_open", "pro_appearance_move", "pro_appearance_use",
             "workspace_index", "tabs_open", "workspace_failed", "pro_panes_of",
             "ui_land_after_reload", "voice_status", "ui_scroll_reportable", "habitat_next_wake_ms",
             "voice_close", "power", "ui_set_connected", "ui_draft_source", "ui_focus_project",
             "ui_swarms_replace", "ui_tiles_replace", "ui_project_remove", "ui_project_apply_order",
             "ui_project_clear_all", "ui_project_set_name", "ui_project_set_machine", "ui_set_selected_machine",
             "recap_preview", "activity_text", "event", "ui_project_emit", "ui_project_restore_event",
             "ui_prune_stale_busy", "ui_cancel_acked") :
    code += function(name)
agent_layout_actions = SOURCE.split("    case A_AGENTS:", 1)[1].split("    case A_AGENT:", 1)[0]
code += "static bool agent_layout_action(action_t a) { switch(a.kind) { case A_AGENTS:" + agent_layout_actions + "default: return false; } return true; }\n"
workspace_actions = SOURCE.split("    case A_TABS:", 1)[1].split("    case A_MACHINE:", 1)[0]
code += "static void workspace_action(action_t a) { switch(a.kind) { case A_TABS:" + workspace_actions + "default: break; } }\n"
language_actions = SOURCE.split("    case A_LANGUAGE:", 1)[1].split("    case A_VOICE_SAMPLES:", 1)[0]
code += "static bool language_action(action_t a) { switch(a.kind) { case A_LANGUAGE:" + language_actions + "default: return false; } return true; }\n"
language_save = function("worker").split("        case A_LANGUAGE_SET: {", 1)[1].split("        case A_APPEAR_SAVE:", 1)[0]
code += "static void language_worker(action_t a) { switch(a.kind) { case A_LANGUAGE_SET: {" + language_save + "default: break; } }\n"
sample_actions = SOURCE.split("    case A_VOICE_SAMPLES:", 1)[1].split("    case A_DAEMONS:", 1)[0]
code += "static bool sample_action(action_t a) { switch(a.kind) { case A_VOICE_SAMPLES:" + sample_actions + "default: return false; } return true; }\n"
metrics_actions = SOURCE.split("    case A_TODAY:", 1)[1].split("    case A_WORK_INTENT:", 1)[0]
code += "static bool metrics_action(action_t a) { switch(a.kind) { case A_TODAY:" + metrics_actions + "default: return false; } return true; }\n"
question_close = SOURCE.split("    case A_QUESTION_CLOSE:", 1)[1].split("\n#endif\n    case A_QUESTION_CHOICES:", 1)[0]
code += "static bool question_close_action(action_t a) { switch(a.kind) { case A_QUESTION_CLOSE:" + question_close + "default: return false; } return true; }\n"
code += function("ht_character_select", (NATIVE / "character.c").read_text())
code += r'''
const char *ht_character_name(ht_character_id_t id) { return pro_daemon_definition(id)->name; }
static void open_question(void) { view(QUESTION); }
static void dispatch(action_t action) {
    sent = action;
    if (language_action(action) || sample_action(action) || metrics_action(action) || agent_layout_action(action) || question_close_action(action)) return;
    if (action.kind == A_DAEMONS) pro_appearance_open(DAEMONS);
    else if (action.kind == A_SCENES) pro_appearance_open(SCENES);
    else if (action.kind == A_APPEAR_PREVIOUS) pro_appearance_move(-1);
    else if (action.kind == A_APPEAR_NEXT) pro_appearance_move(1);
    else if (action.kind == A_APPEAR_USE) pro_appearance_use();
    else if (action.kind == A_VOICE) {
        starts++; s.voice_return = s.view; s.voice_open = recording = true; view(VOICE);
    } else if (action.kind == A_VOICE_STOP) {
        stops++; recording = false;
    } else if (action.kind == A_VOICE_ABORT) {
        discards++; s.voice_open = recording = false; view(HOME);
    } else if (action.kind == A_AGENT) {
        switches++; s.active = !strcmp(action.id, "b") ? 1 : 0; view(AGENT);
    } else if (action.kind == A_LAUNCHER) {
        launches++; view(LAUNCHER);
    } else if (action.kind == A_HOME) {
        selected++; view(HOME);
    } else if (action.kind == A_TABS) {
        selected++; workspace_action(action);
    } else if (action.kind == A_TAB) {
        selected++; workspace_action(action);
    } else {
        selected++;
    }
}
'''
code += function("surface_tick") + function("habitat_touch") + function("habitat_touch_cancel")
code += function("workspace_gesture_allowed") + function("habitat_workspace_gesture_begin") + function("habitat_workspace_gesture_end")
code += function("color")
code += r'''
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define ERROR color(HT_THEME_ERROR)
#define SEL color(HT_THEME_SELECTION)
/* Only art decoding is outside this fixture. Its generated native dimensions
 * are preserved, while the actual text, layout and hit registration run here. */
void pro_visual_background(ht_scene_t *f, pro_scene_id_t choice, ht_character_id_t id) {
    (void)choice; (void)id;
    ht_pro_rect(f,0,0,720,720,0,ht_rgb(0xd9e8cf));
}
void pro_visual_character(ht_scene_t *f, const ht_character_t *c, ht_character_mood_t mood,
                          bool compact, int x, int y, uint32_t at, bool quiet, bool mail) {
    (void)at; (void)quiet; (void)mail;
    drawn_mood=mood;drawn_level=c->motion.reaction.pose.level;drawn_emotion=c->motion.reaction.pose.emotion;
    int width=pro_art_sizes[compact ? PRO_ART_COMPACT : PRO_ART_HERO];
    drawn_compact=compact; drawn_portrait=(ht_rect_t){x,y,width,width};
    ht_pro_rect(f,x,y,width,width,0,ht_rgb(0x9974af));
}
'''
controls = (NATIVE / "pro_controls.inc").read_text()
code += function("pro_hit", controls) + function("pro_control", controls) + function("pro_heading", controls) + function("pro_appearance", controls)
code += function("pro_voice_samples", controls) + function("pro_voice_params", controls) + function("pro_launcher", controls) + function("pro_row", controls) + function("pro_language", controls)
code += function("pro_note", controls) + function("pro_today", controls)
code += function("pro_read_text", controls) + function("pro_unknown_answer", controls)
code += (NATIVE / "pro_home.inc").read_text()
code += function("render_lock") + function("render_brand")
code += r'''
static void hit(action_kind_t kind, int value, int x, int y, int w, int h) {
    s.hits[s.hit_count++] = (hit_t){{x,y,w,h},kind,value,true};
}
static void reset(void) {
    pro_voice_sample_stop();
    memset(&s,0,sizeof s); memset(&gesture,0,sizeof gesture); memset(&scroll,0,sizeof scroll);
    memset(&workspace,0,sizeof workspace); memset(&tab_carousel,0,sizeof tab_carousel);
    memset(&selection,0,sizeof selection); memset(&carry,0,sizeof carry); memset(&visit,0,sizeof visit);
    memset(&form,0,sizeof form); memset(&draft,0,sizeof draft); memset(&character,0,sizeof character);
    memset(&home_caption,0,sizeof home_caption); memset(&pressed_action,0,sizeof pressed_action);
    memset(&pressed_rect,0,sizeof pressed_rect); memset(&sent,0,sizeof sent); memset(&queued_action,0,sizeof queued_action);
    memset(&speech_audio,0,sizeof speech_audio);
    changes=speech_aborts=speech_snapshots=0;aborted_id=0;
    config_load_voicelang(s.voice_language,sizeof s.voice_language);
    s.ready = s.connected = true; s.view = HOME; s.count = 2; s.active = 0; s.pressed = -1;
    strcpy(s.agents[0].id,"a"); strcpy(s.agents[0].name,"Design");
    strcpy(s.agents[1].id,"b"); strcpy(s.agents[1].name,"Code");
    recording = asleep = congested = scroll_reversed = false;
    starts = stops = discards = switches = launches = selected = down_reports = moves = ups = queued = 0;
    travel = 0; now = 1000; visual_wake=1000; unread=lock_checks=0;
    hit(A_PET,0,40,106,640,474);
}
static void sample(bool down, int x, int y, uint32_t at) {
    now = at; habitat_touch(down,x,y,at);
}
static void tap(int x, int y, unsigned duration) {
    uint32_t at = now + 1000;
    sample(true,x,y,at); sample(false,x,y,at+duration);
}
static void swipe(int x0, int y0, int x1, int y1) {
    sample(true,x0,y0,2000);
    for (int i=1;i<=5;i++) sample(true,x0+(x1-x0)*i/5,y0+(y1-y0)*i/5,2000+i*30);
    sample(false,x1,y1,2200);
}
static void only_control(action_kind_t kind) {
    s.hit_count=0; hit(kind,1,40,200,640,160);
}
static void center_voice(void) {
    reset(); tap(360,340,75); assert(starts==1 && !switches && !travel);
}
static void summary_voice(void) {
    reset(); s.agents[0].recap_ready=true; strcpy(s.agents[0].preview,"Your layouts are ready.");
    tap(360,505,75); assert(starts==1 && !strcmp(sent.id,"a") && s.agents[0].recap_ready);
}
static void deliberate_tap(void) {
    reset(); tap(360,340,450); assert(starts==1 && !launches && !switches);
}
static void thumb_drift(void) {
    reset(); sample(true,360,340,2000); sample(true,375,352,2100); sample(false,375,352,2160);
    assert(starts==1 && !moves && !travel);
}
static void panes(void) {
    reset(); swipe(520,340,260,343); assert(switches==1 && s.active==1 && !starts && !travel);
    reset(); s.active=1; swipe(230,340,550,337); assert(switches==1 && s.active==0 && !starts && !travel);
}
static void pane_after_diagonal_start(void) {
    reset(); sample(true,520,340,2000); sample(true,500,360,2040);
    sample(true,480,361,2080); sample(true,380,361,2120); sample(false,260,361,2180);
    assert(switches==1 && s.active==1 && !starts && !travel);
}
static void scroll_output(void) {
    reset(); swipe(360,480,366,220); assert(moves>0 && travel<0 && !switches && !starts);
    reset(); swipe(360,220,365,490); assert(moves>0 && travel>0 && !switches && !starts);
}
static void congested_scroll(void) {
    reset(); congested=true; swipe(360,480,362,220); assert(!starts && !switches && !selected);
}
static void diagonal(void) {
    reset(); swipe(250,200,450,400); assert(!starts && !switches && !selected && !travel);
}
static void hold_launcher(void) {
    reset(); sample(true,360,340,2000); now=2650; surface_tick(now);
    assert(s.view==LAUNCHER && !starts);
    unsigned before=selected+launches+switches;
    sample(false,360,340,2800); assert(selected+launches+switches==before && !starts);
}
static void offline_launcher(void) {
    reset(); s.connected=false; s.count=0; s.active=-1;
    sample(true,360,340,2000); now=2650; surface_tick(now);
    assert(s.view==LAUNCHER && !starts);
    sample(false,360,340,2800); assert(!starts && !switches);
}
static void cancelled_written_control(void) {
    reset(); s.view=AGENTS; only_control(A_AGENT);
    sample(true,100,240,2000); input_cancel(); sample(false,100,240,2120);
    assert(!switches && !selected && !starts);
}
static void changed_screen_contact(void) {
    reset(); s.view=AGENTS; only_control(A_AGENT);
    sample(true,100,240,2000); view(SETTINGS); sample(false,100,240,2120);
    assert(s.view==SETTINGS && !switches && !selected && !starts);
}
static void scroll_return_to_row(void) {
    reset(); s.view=AGENTS; s.count=8; only_control(A_AGENT);
    sample(true,100,270,2000); sample(true,100,190,2060);
    sample(true,100,270,2120); sample(false,100,270,2200);
    assert(!switches && !selected && !starts);
}
static void deliberate_written_control(void) {
    reset(); s.view=AGENTS; only_control(A_AGENT); tap(100,270,450);
    assert(switches==1 && s.active==1);
}
static void draft_hold_options(void) {
    reset(); s.view=DRAFT; only_control(A_DRAFT_EDIT);
    tap(100,270,800); assert(sent.kind==A_DRAFT_OPTIONS && !starts && !switches);
}
static unsigned retained_transport;
static bool retained_emit(const ht_draft_command_t *command,void *ctx) {
    (void)command;(void)ctx;retained_transport++;return true;
}
static void carry_retained_reading(void) {
    reset();s.view=DRAFT;s.hit_count=0;
    draft.page=(ht_draft_page_t){.active=true,.locked=true,.id="retained",.agent="agent",.revision=3,.position=2,.total=3};
    COPY(draft.page.text,"One line\nTwo lines\nThree lines\nFour lines\nFive lines\nSix lines\nSeven lines\nEight lines\nNine lines\nTen lines\nEleven lines\nTwelve lines");
    carry=(ht_carry_t){.active=true,.id="quote",.source="Research",.excerpt="Retained preview"};
    pro_carry_review_begin(&s.carry_review,&carry,"agent","Original recipient");
    COPY(s.carry_review.draft,"retained");s.carry_review.detached=draft.failed=true;
    draft.emit=retained_emit;retained_transport=0;
    assert(question_rows(draft.page.text)>DRAFT_ROWS);
    sample(true,300,480,2000);sample(true,300,240,2060);sample(false,300,220,2120);
    assert(s.offset>0&&!starts&&!moves&&!switches&&!retained_transport);
    draft_move(4000,2200);assert(s.offset==question_rows(draft.page.text)-DRAFT_ROWS);
    draft_move(-4000,2250);assert(s.offset==0&&!retained_transport&&!draft.pending);
    s.view=CARRY_PREVIEW;s.offset=2;s.hit_count=0;
    sample(true,300,480,3000);sample(true,300,240,3060);sample(false,300,220,3120);
    assert(s.offset>2&&!starts&&!moves&&!retained_transport);
    sample(true,220,360,4000);sample(true,480,360,4060);sample(false,500,360,4120);
    assert(sent.kind==A_DRAFT_BACK&&sent.revision==3&&!strcmp(sent.text,"retained"));
}
static void render_actual(void);
static void question_retained_reading(void) {
    reset();s.view=QUESTION;s.q.pending=s.q.uncertain=true;s.q.valid=false;s.q.count=2;s.q.revision=12;
    COPY(s.q.agent,"a");COPY(s.q.name,"Design");COPY(s.q.item[0].answer,
        "One line\nTwo lines\nThree lines\nFour lines\nFive lines\nSix lines\nSeven lines\nEight lines\nNine lines\nTen lines\nEleven lines\nTwelve lines");
    COPY(s.q.item[1].answer,"The second retained answer.");
    render_actual();assert(question_rows(s.q.item[0].answer)>Q_ROWS);
    sample(true,300,480,2000);sample(true,300,240,2060);sample(false,300,220,2120);
    assert(s.offset>0&&s.q.pending&&!starts&&!moves&&!switches&&!selected);
    question_move(4000);assert(s.q.index==1&&s.q.pending);
    render_actual();sample(true,100,630,3000);s.q.revision++;sample(false,100,630,3080);
    assert(s.q.pending&&!starts&&!moves&&!selected); // Stale down-captured Close.
    render_actual();sample(true,100,630,4000);sample(true,100,500,4060);sample(false,100,500,4120);
    assert(s.q.pending&&!starts&&!moves&&!selected); // Reading cannot become Close.
    render_actual();tap(100,630,450);
    assert(!s.q.pending&&s.view==INBOX&&!starts&&!moves&&!switches&&!selected);
}
static void cancellation_matrix(void) {
    const action_kind_t controls[]={A_AGENT,A_HOME,A_NOTICE,A_MACHINE,A_MODEL,A_ANSWER,A_DRAFT_SEND};
    const unsigned durations[]={25,75,349,450,649,800,1800};
    for (unsigned k=0;k<sizeof controls/sizeof controls[0];k++)
        for (unsigned t=0;t<sizeof durations/sizeof durations[0];t++) {
            reset(); s.view=SETTINGS; only_control(controls[k]);
            int x=60+(int)k*80;
            sample(true,x,270,2000); input_cancel(); sample(false,x,270,2000+durations[t]);
            assert(!starts && !switches && !selected && !stops && !discards);
        }
}
static void full_width_voice(void) {
    reset(); s.view=VOICE; s.voice_open=recording=true;
    s.hit_count=0; hit(A_PET,0,40,106,640,440); tap(630,340,75);
    assert(stops==1 && !starts && !switches);
}
static void voice_guard(void) {
    reset(); sample(true,360,340,2000); sample(false,360,340,2075); assert(starts==1);
    s.hit_count=0; hit(A_PET,0,40,106,640,440);
    sample(true,360,340,2200); sample(false,360,340,2275); assert(!stops);
    sample(true,360,340,2700); sample(false,360,340,2775); assert(stops==1);
}
static void discard_is_immediate(void) {
    reset(); sample(true,360,340,2000); sample(false,360,340,2075); assert(starts==1);
    s.hit_count=0; hit(A_VOICE_ABORT,0,56,600,240,80);
    sample(true,160,640,2200); sample(false,160,640,2275);
    assert(discards==1 && !recording && !s.voice_open && s.view==HOME);
}
static void sensor_cancel_then_next_contact(void) {
    reset(); sample(true,360,340,2000); habitat_touch_cancel();
    // The driver swallows the broken contact through its real UP.
    sample(true,360,340,3000); sample(false,360,340,3075);
    assert(starts==1 && !switches);
}
static void no_hidden_home_from_reader(void) {
    reset(); s.view=READER; s.hit_count=0;
    swipe(360,550,360,400); assert(s.view==READER && s.offset>0);
}
static bool overlap(ht_rect_t a, ht_rect_t b) {
    return a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h;
}
static ht_scene_t scene;
static void check_scene(void) {
    assert(scene.count < HT_RUNS);
    for (unsigned i=0;i<scene.count;i++) {
        const ht_run_t *r=&scene.runs[i];
        assert(r->x>=0 && r->y>=0 && r->w>0 && r->pro_height>0);
        assert(r->x+r->w<=720 && r->y+r->pro_height<=720);
        if (r->pro_kind != 1) continue;
        for (unsigned j=i+1;j<scene.count;j++) {
            const ht_run_t *b=&scene.runs[j];
            if (b->pro_kind==1)
                assert(!overlap((ht_rect_t){r->x,r->y,r->w,r->pro_height},
                                (ht_rect_t){b->x,b->y,b->w,b->pro_height}));
        }
    }
    for (int i=0;i<s.hit_count;i++) {
        hit_t a=s.hits[i];
        assert(a.rect.x>=0 && a.rect.y>=0 && a.rect.w>0 && a.rect.h>0);
        assert(a.rect.x+a.rect.w<=720 && a.rect.y+a.rect.h<=720);
        for (int j=i+1;j<s.hit_count;j++)
            if (a.enabled && s.hits[j].enabled) assert(!overlap(a.rect,s.hits[j].rect));
    }
}
static void render_actual(void) {
    s.hit_count=0; ht_scene_clear(&scene,ht_rgb(0xd9e8cf));
    if (s.locked) render_lock(&scene);
    else if (s.view==OTA) render_brand(&scene);
    else if (pro_appearance_view()) pro_appearance(&scene);
    else if (s.view==TODAY) pro_today(&scene);
    else if (question_view(s.view) && s.q.pending && s.q.uncertain) pro_unknown_answer(&scene);
    else if (s.view==VOICE) pro_render_voice(&scene); else pro_render_home(&scene);
    check_scene();
}
static const hit_t *action_hit(action_kind_t action) {
    for (int i=0;i<s.hit_count;i++) if (s.hits[i].action==action) return &s.hits[i];
    return NULL;
}
static void home_render_geometry(void) {
    reset(); render_actual(); assert(!drawn_compact);
    const hit_t *pet=action_hit(A_PET); assert(pet && pet->enabled);
    ht_rect_t home=pet->rect;
    assert(home.x<=40 && home.x+home.w>=680 && home.y<=106 && home.y+home.h>=580);
    s.agents[0].recap_ready=true; strcpy(s.agents[0].preview,"A short result.");
    render_actual(); assert(drawn_compact); ht_rect_t small=drawn_portrait;
    assert(!memcmp(&home,&action_hit(A_PET)->rect,sizeof home));
    memset(s.agents[0].preview,'W',sizeof s.agents[0].preview-1);
    s.agents[0].preview[sizeof s.agents[0].preview-1]=0; unread=3;
    render_actual(); assert(drawn_compact && !memcmp(&small,&drawn_portrait,sizeof small));
    assert(!memcmp(&home,&action_hit(A_PET)->rect,sizeof home));
    tap(630,520,75); assert(starts==1 && !strcmp(sent.id,"a"));
}
static void home_state_geometry(void) {
    for (int state=0;state<8;state++) {
        reset();
        if (state==0) s.connected=false;
        if (state==1) s.loading=true;
        if (state==2) s.agents[0].busy=true;
        if (state==3) s.nap=true;
        if (state==4) { carry.active=true; carry.rows=4; strcpy(carry.source,"A long source title"); }
        if (state==5) strcpy(carry.error,"Selected text expired");
        if (state==6) visit.available=true;
        if (state==7) { s.notice_count=1; s.notice[0].question=true; strcpy(s.notice[0].agent_id,"a"); }
        memset(s.agents[0].name,'W',sizeof s.agents[0].name-1);
        s.agents[0].name[sizeof s.agents[0].name-1]=0;
        render_actual();
        assert(action_hit(A_LAUNCHER) && action_hit(A_LAUNCHER)->enabled);
        if (state==7) assert(action_hit(A_QUESTION) && action_hit(A_QUESTION)->enabled);
    }
}
static void actual_home_tabs(void) {
    reset(); s.tab_count=4; strcpy(s.selected_tab,"tab-1");
    for (int i=0;i<s.tab_count;i++) {
        snprintf(s.tabs[i].id,sizeof s.tabs[i].id,"tab-%d",i);
        snprintf(s.tabs[i].name,sizeof s.tabs[i].name,"Workspace %d",i);
    }
    render_actual();
}
static void workspace_chord_navigation(void) {
    actual_home_tabs(); sample(true,360,340,2000);
    assert(habitat_workspace_gesture_begin() && s.workspace_chord && !s.touch_down);
    assert(down_reports==1 && ups==1 && !travel && !starts);
    habitat_workspace_gesture_end(1);
    assert(queued==1 && queued_action.kind==A_TAB && !strcmp(queued_action.id,"tab-2"));
    assert(workspace.phase!=HT_WORKSPACE_IDLE && s.loading && !s.workspace_chord && !starts && !switches);
    habitat_workspace_gesture_end(-1); assert(queued==1); // At most one request.
    actual_home_tabs(); assert(habitat_workspace_gesture_begin()); habitat_workspace_gesture_end(-1);
    assert(queued==1 && !strcmp(queued_action.id,"tab-0"));
    actual_home_tabs(); strcpy(s.selected_tab,"tab-0"); assert(habitat_workspace_gesture_begin());
    habitat_workspace_gesture_end(-1); assert(!queued && !starts && !selected); // No edge wrap.
    actual_home_tabs(); assert(habitat_workspace_gesture_begin()); habitat_workspace_gesture_end(0);
    assert(!queued && !s.workspace_chord);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin()); congested=true;
    habitat_workspace_gesture_end(1); assert(!queued && workspace.phase==HT_WORKSPACE_IDLE && !s.workspace_chord);
}
static void workspace_chord_gates(void) {
    for (int page=HOME;page<=OTA;page++) {
        actual_home_tabs(); s.view=(view_t)page;
        assert(habitat_workspace_gesture_begin()==(page==HOME || page==AGENT));
        habitat_workspace_gesture_end(0);
    }
    for (int reason=0;reason<18;reason++) {
        actual_home_tabs(); sample(true,360,340,2000);
        switch(reason) {
        case 0:s.ready=false;break;case 1:s.connected=false;break;case 2:s.loading=true;break;
        case 3:s.locked=true;break;case 4:asleep=true;break;case 5:s.voice_open=true;break;
        case 6:s.voice_start_pending=true;break;case 7:s.voice_waiting=true;break;case 8:recording=true;break;
        case 9:strcpy(form.id,"form");break;case 10:draft.page.active=true;break;
        case 11:selection.active=true;break;case 12:carry.pending=true;break;case 13:visit.pending=true;break;
        case 14:strcpy(s.pending_machine,"remote");break;case 15:strcpy(s.pending_focus,"b");break;
        case 16:workspace.phase=HT_WORKSPACE_WAIT_TAB;break;case 17:s.tab_count=1;break;
        }
        assert(!habitat_workspace_gesture_begin() && !s.workspace_chord && !s.touch_down && !starts);
        habitat_workspace_gesture_end(1); assert(!queued);
    }
}
static void workspace_chord_context(void) {
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    ui_swarms_replace(s.tabs,s.tab_count,s.selected_tab); assert(s.workspace_chord); // Identical context is stable.
    habitat_workspace_gesture_end(1); assert(queued==1);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    cable_swarm_t tabs[4];memcpy(tabs,s.tabs,sizeof tabs);COPY(tabs[2].id,"replacement");
    ui_swarms_replace(tabs,4,"tab-1"); assert(!s.workspace_chord);
    habitat_workspace_gesture_end(1); assert(!queued);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    ui_set_selected_machine("remote");ui_set_selected_machine("");habitat_workspace_gesture_end(1);assert(!queued);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    ui_set_connected(false);ui_set_connected(true);habitat_workspace_gesture_end(1);assert(!queued);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    ui_project_remove("b");habitat_workspace_gesture_end(1);assert(!queued);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    const char *order[]={"b","a"};ui_project_apply_order(order,2);habitat_workspace_gesture_end(1);assert(!queued);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    view(LAUNCHER);view(HOME);habitat_workspace_gesture_end(1);assert(!queued);
    actual_home_tabs(); assert(habitat_workspace_gesture_begin());
    COPY(s.tabs[2].id,"replacement");habitat_workspace_gesture_end(1);assert(!queued); // Guard even if a future updater forgets cancellation.
}
static void map_layout_is_local(void) {
    actual_home_tabs();dispatch((action_t){.kind=A_AGENTS});assert(s.view==AGENTS&&s.pro_agent_layout==0);
    only_control(A_AGENT_LAYOUT);tap(100,270,75);
    assert(s.view==AGENTS&&s.pro_agent_layout==1&&!queued&&!switches&&!starts&&!selected);
    dispatch((action_t){.kind=A_AGENT_LAYOUT,.value=2});assert(s.pro_agent_layout==2&&!queued);
    dispatch((action_t){.kind=A_AGENT_LAYOUT,.value=99});assert(s.pro_agent_layout==2&&!queued);
    view(HOME);dispatch((action_t){.kind=A_AGENT_LAYOUT,.value=1});assert(s.pro_agent_layout==2&&!queued);
    dispatch((action_t){.kind=A_AGENTS});assert(s.pro_agent_layout==0&&!queued);
}
static void map_contact_invalidation(void) {
    for (int change=0;change<9;change++) {
        actual_home_tabs();s.view=AGENTS;only_control(A_AGENT);
        cable_tile_t tile={.x1=0,.y1=0,.x2=1000,.y2=1000};COPY(tile.agent_id,"b");
        ui_tiles_replace(&tile,1,s.selected_tab);sample(true,100,270,2000);
        switch(change) {
        case 0:tile.x2=900;ui_tiles_replace(&tile,1,s.selected_tab);break;
        case 1:ui_tiles_replace(&tile,1,"another-tab");break;
        case 2:ui_project_remove("b");break;
        case 3:{const char *ids[]={"b","a"};ui_project_apply_order(ids,2);break;}
        case 4:ui_project_clear_all();break;
        case 5:ui_swarms_replace(s.tabs,s.tab_count,"tab-2");break;
        case 6:ui_set_selected_machine("remote");break;
        case 7:ui_project_set_name("new-pane","New pane");break;
        case 8:ui_project_set_name("b","New label");break;
        }
        sample(false,100,270,2120);assert(!switches&&!starts&&!selected);
    }
    actual_home_tabs();s.view=AGENTS;only_control(A_AGENT);
    cable_tile_t tile={.x1=0,.y1=0,.x2=1000,.y2=1000};COPY(tile.agent_id,"b");
    ui_tiles_replace(&tile,1,s.selected_tab);sample(true,100,270,2000);
    ui_tiles_replace(&tile,1,s.selected_tab);sample(false,100,270,2120);
    assert(switches==1 && !starts); // An identical geometry refresh does not eat a valid tap.
    actual_home_tabs();s.view=AGENTS;only_control(A_AGENT);sample(true,100,270,2000);
    assert(!habitat_workspace_gesture_begin());habitat_workspace_gesture_end(1);
    assert(!switches&&!starts&&!queued&&!s.touch_down); // Two fingers cannot click the map.
}
static void home_header_drag_cancel(void) {
    const int delta[][2]={{-190,0},{190,0},{0,-40},{0,200}};
    for (unsigned i=0;i<sizeof delta/sizeof delta[0];i++) {
        actual_home_tabs(); const hit_t *header=action_hit(A_TABS); assert(header && header->enabled);
        assert(header->rect.x==32 && header->rect.y==24 && header->rect.w==248 && header->rect.h==80);
        int x=header->rect.x+header->rect.w/2, y=header->rect.y+header->rect.h/2;
        sample(true,x,y,2000);
        // This is a plain button. It must not arm the invisible legacy workspace preview.
        assert(!workspace.touching && !workspace.moved);
        for (int step=1;step<=5;step++)
            sample(true,x+delta[i][0]*step/5,y+delta[i][1]*step/5,2000+step*30);
        sample(false,x+delta[i][0],y+delta[i][1],2200);
        assert(s.view==HOME && s.active==0 && !strcmp(s.selected_tab,"tab-1"));
        assert(workspace.phase==HT_WORKSPACE_IDLE && !workspace.touching && !workspace.moved);
        assert(!starts && !stops && !switches && !selected && !launches && !down_reports && !moves && !ups);
        assert(s.tab_first==0 && !s.loading);
    }
}
static void home_header_tap_tabs(void) {
    const unsigned durations[]={75,450};
    for (unsigned i=0;i<sizeof durations/sizeof durations[0];i++) {
        actual_home_tabs(); const hit_t *header=action_hit(A_TABS); assert(header && header->enabled);
        tap(header->rect.x+header->rect.w/2,header->rect.y+header->rect.h/2,durations[i]);
        assert(s.view==TABS && sent.kind==A_TABS && selected==1);
        assert(!starts && !stops && !switches && !down_reports && !moves && !ups);
        assert(!strcmp(s.selected_tab,"tab-1") && ht_tab_carousel_index(&tab_carousel)==1);
    }
}
static void current_tab_returns_home(void) {
    actual_home_tabs(); s.tabs[1].panes=4; s.tabs[2].panes=6;
    s.view=TABS;
    dispatch((action_t){.kind=A_TAB,.id="tab-1"});
    assert(s.view==HOME && !s.loading && !queued && !s.land_on_desk);
    assert(!strcmp(s.selected_tab,"tab-1") && workspace.phase==HT_WORKSPACE_IDLE);
}
static void changed_tab_stays_on_home(void) {
    actual_home_tabs(); s.tabs[1].panes=4; s.tabs[2].panes=6; s.view=TABS;
    dispatch((action_t){.kind=A_TAB,.id="tab-2"});
    assert(s.view==HOME && s.loading && !s.land_on_desk && queued==1);
    assert(queued_action.kind==A_TAB && !strcmp(queued_action.id,"tab-2"));
    assert(workspace.phase==HT_WORKSPACE_WAIT_TAB && !strcmp(workspace.pending,"tab-2"));
    ui_land_after_reload(); assert(s.view==HOME && s.loading);
    assert(ht_workspace_selected(&workspace,"tab-2"));
    assert(ht_workspace_refresh(&workspace,queued_action.revision,10));
    assert(!ht_workspace_applied(&workspace,"tab-1",11));
    ui_land_after_reload(); assert(s.view==HOME && s.loading);
    strcpy(s.selected_tab,"tab-2");
    assert(ht_workspace_applied(&workspace,"tab-2",11));
    ui_land_after_reload();
    assert(s.view==HOME && !s.loading && !s.land_on_desk && queued==1);
    assert(workspace.phase==HT_WORKSPACE_IDLE && !starts && !switches);
}
static void carried_excerpt_is_readable(void) {
    reset(); carry.active=true; carry.rows=2;
    strcpy(carry.source,"Research"); strcpy(carry.excerpt,"Keep the actual selected words.");
    render_actual(); bool body=false, attribution=false;
    for (unsigned i=0;i<scene.count;i++) {
        const ht_run_t *r=&scene.runs[i];
        if (r->pro_kind!=1) continue;
        if (r->y>=310 && !strcmp(r->text,carry.excerpt)) body=true;
        if (strstr(r->text,"2 lines from Research")) attribution=true;
    }
    assert(body && attribution && drawn_compact && action_hit(A_CARRY_DROP));
}
static bool has_text(const char *text) {
    for (unsigned i=0;i<scene.count;i++)
        if (scene.runs[i].pro_kind==1 && !strcmp(scene.runs[i].text,text)) return true;
    return false;
}

static unsigned observed_seconds(void) {
    uint32_t seconds=UINT32_MAX;
    assert(pro_busy_elapsed(active(),now,&seconds));return seconds;
}
static void busy_heartbeat(const char *id,const char *session,uint32_t at) {
    now=at;ui_project_emit(id,session,"processing","Processing",NULL);
}
static void busy_observation(void) {
    reset();ui_draft_source("host-a");
    busy_heartbeat("a","session-a",1000);assert(observed_seconds()==0);
    ui_project_emit("a","session-a","activity","Reading the source...",NULL);
    assert(!strcmp(active()->tool,"Reading the source"));
    busy_heartbeat("a","session-a",20000);assert(observed_seconds()==19);
    busy_heartbeat("b","session-b",22000);ui_focus_project("b");assert(observed_seconds()==0);
    now=23000;ui_focus_project("a");assert(observed_seconds()==22);
    // Roster replacement reuses only the same still-live pane's anchor.
    ui_project_clear_all();ui_project_set_name("b","Code");ui_project_set_name("a","Design");
    ui_focus_project("a");assert(observed_seconds()==22);
    const char *order[]={"a","b"};ui_project_apply_order(order,2);assert(observed_seconds()==22);
    ui_project_restore_event("a","processing","Past work",NULL);assert(observed_seconds()==22);
    // A missed periodic prune may never turn a fresh heartbeat into old runtime.
    busy_heartbeat("a","session-a",50001);assert(observed_seconds()==0&&!active()->tool[0]);
    busy_heartbeat("a","new-session",54001);assert(observed_seconds()==0);
    ui_project_emit("a","newer-session","activity","Late old activity",NULL);
    uint32_t ignored;assert(!pro_busy_elapsed(active(),now,&ignored)&&!active()->busy);
    busy_heartbeat("a","newer-session",55000);now=81000;assert(ui_prune_stale_busy()==2);
    assert(!pro_busy_elapsed(active(),now,&ignored));
    busy_heartbeat("a","newer-session",82000);ui_project_emit("a","newer-session","done","Result",NULL);
    assert(!active()->busy);busy_heartbeat("a","newer-session",84000);assert(observed_seconds()==0);
    ui_cancel_acked("different-session");assert(active()->busy);
    ui_cancel_acked("newer-session");assert(!active()->busy);
    // Cancellation also reaches a pane hidden by a workspace roster change.
    busy_heartbeat("b","session-b",85000);ui_project_remove("b");ui_cancel_acked("session-b");
    ui_project_set_name("b","Code");assert(!s.agents[find("b")].busy);
    assert(!queued&&!starts&&!stops);
}
static void busy_connection_loss(void) {
    reset();ui_draft_source("host-a");busy_heartbeat("a","session-a",1000);
    busy_heartbeat("b","session-b",2000);ui_project_remove("b");
    ui_set_connected(false);assert(!active()->busy&&!pane_memory("b",false)->busy);
    busy_heartbeat("a","session-a",2100);assert(!active()->busy); // Late offline event.
    ui_set_connected(true);ui_draft_source("host-a");
    ui_project_clear_all();ui_project_set_name("a","Design");ui_project_set_name("b","Code");ui_focus_project("a");
    ui_project_restore_event("a","processing","Restored history",NULL);
    assert(!active()->busy&&!s.agents[find("b")].busy);
    busy_heartbeat("a","session-a",3000);assert(observed_seconds()==0);
    now=4000;ui_draft_source("host-a");assert(observed_seconds()==1); // Same welcome is not a reset.
    ui_draft_source("host-b");assert(!active()->busy);
    busy_heartbeat("a","session-a",5000);assert(observed_seconds()==0);
    ui_draft_source(NULL);assert(!active()->busy);
    assert(!queued&&!starts&&!stops);
}
static void busy_precedence(void) {
    for(int reason=0;reason<16;reason++) {
        reset();busy_heartbeat("a","session-a",1000);now=2000;uint32_t seconds;
        switch(reason) {
        case 0:s.connected=false;break;
        case 1:s.loading=true;break;
        case 2:s.nap=true;break;
        case 3:s.voice_retry_until=3000;break;
        case 4:s.notice_count=1;s.notice[0].question=true;COPY(s.notice[0].agent_id,"a");break;
        case 5:s.speech_error_until=3000;break;
        case 6:s.speech.id=1;s.speech.pending=true;COPY(s.speech.agent,"a");break;
        case 7:s.speech.id=1;s.speech.playing=true;COPY(s.speech.agent,"a");break;
        case 8:carry.active=true;break;
        case 9:COPY(carry.error,"Expired");break;
        case 10:s.locked=true;break;
        case 11:asleep=true;break;
        case 12:s.voice_open=true;break;
        case 13:s.view=VOICE;break;
        case 14:s.view=WORK_INTENT;s.work_mode=PRO_WORK_GOAL;break;
        case 15:s.view=DRAFT;s.work_voice_mode=PRO_WORK_LOOP;break;
        }
        assert(!pro_busy_elapsed(active(),now,&seconds));render_actual();assert(!has_text("1s"));
    }
    reset();busy_heartbeat("a","session-a",1000);s.quiet=true;s.nap=true;
    busy_heartbeat("a","session-a",10000);s.nap=false;assert(observed_seconds()==9);
    // Rest hides, never turns wall-clock observation into accumulated compute time.
    power(false);busy_heartbeat("a","session-a",15000);power(true);s.locked=false;
    assert(observed_seconds()==14);
    s.notice_count=1;s.notice[0].question=true;COPY(s.notice[0].agent_id,"b");
    assert(observed_seconds()==14); // Another pane's question doesn't relabel this work.
}
static void busy_tick_schedule(void) {
    reset();s.quiet=true;visual_wake=9000;busy_heartbeat("a","session-a",1000);
    surface_tick(now);unsigned before=changes;assert(s.pro_busy_visible&&!s.pro_busy_second);
    now=1999;surface_tick(now);assert(changes==before&&habitat_next_wake_ms()==1);
    now=2000;surface_tick(now);assert(changes==before+1&&s.pro_busy_second==1&&habitat_next_wake_ms()==1000);
    surface_tick(now);assert(changes==before+1);
    s.nap=true;surface_tick(now);assert(changes==before+2&&!s.pro_busy_visible);
    surface_tick(now);assert(changes==before+2&&habitat_next_wake_ms()==9000);
    s.nap=false;surface_tick(now);assert(s.pro_busy_visible);
    now=26001;surface_tick(now);assert(!s.pro_busy_visible);uint32_t sec;
    assert(!pro_busy_elapsed(active(),now,&sec));
    reset();busy_heartbeat("a","session-a",UINT32_MAX-500);now=499;
    assert(observed_seconds()==1);render_actual();assert(has_text("1s"));
}
static void busy_render_boundaries(void) {
    const unsigned at[]={0,59,60,3599,3600};
    const char *label[]={"0s","59s","1m 00s","59m 59s","60m 00s"};
    for(unsigned n=0;n<sizeof at/sizeof at[0];n++)for(int long_label=0;long_label<2;long_label++) {
        reset();busy_heartbeat("a","session-a",0);
        for(now=20000;now<=at[n]*1000;now+=20000)ui_project_emit("a","session-a","processing","Processing",NULL);
        now=at[n]*1000;ui_project_emit("a","session-a","activity",long_label?
            "Reviewing the complete interaction contract and every recovery boundary":"Reading the source",NULL);
        render_actual();assert(has_text(label[n]));
        const ht_run_t *clock=NULL,*status=NULL;
        for(unsigned i=0;i<scene.count;i++)if(scene.runs[i].pro_kind==1&&scene.runs[i].y==668) {
            if(!strcmp(scene.runs[i].text,label[n]))clock=&scene.runs[i];else status=&scene.runs[i];
        }
        assert(clock&&status&&clock->pro_font==&ht_pro_24&&status->pro_font==&ht_pro_24);
        assert(clock->x+clock->w==522&&status->x==44&&status->x+status->w+16<=clock->x);
        ht_rect_t foot=action_hit(A_AGENTS)->rect;assert(foot.x==32&&foot.y==598&&foot.w==492&&foot.h==104);
        assert(action_hit(A_PET)->rect.y==106);
    }
}


static void work_identity_callbacks(void) {
    reset();ui_draft_source("host-a");ui_project_set_machine("a","host-a","Cable host");
    assert(pro_work_local(active())&&pro_work_available(active(),PRO_WORK_TASK));
    COPY(active()->engine,"claude");assert(pro_work_available(active(),PRO_WORK_GOAL)&&pro_work_available(active(),PRO_WORK_LOOP));
    ui_project_set_machine("a","remote","Other host");assert(!pro_work_local(active())&&!pro_work_available(active(),PRO_WORK_GOAL));
    assert(pro_work_available(active(),PRO_WORK_TASK));
    ui_project_set_machine("a",NULL,"Missing");assert(!active()->machine_id[0]&&!pro_work_local(active()));
    char exact[48],longer[49];memset(exact,'h',47);exact[47]=0;snprintf(longer,sizeof longer,"%sx",exact);
    ui_draft_source(exact);ui_project_set_machine("a",exact,"Complete identity");assert(pro_work_local(active()));
    ui_project_set_machine("a",longer,"Must not alias");assert(!active()->machine_id[0]&&!pro_work_local(active()));
    ui_project_set_machine("a",exact,"Complete identity");ui_draft_source(longer);assert(!pro_work_local(active()));
    ui_draft_source(exact);assert(pro_work_local(active()));ui_set_connected(false);assert(!pro_work_local(active()));
    ui_set_connected(true);ui_draft_source(exact);ui_project_clear_all();ui_project_set_name("a","Design");ui_focus_project("a");
    assert(!pro_work_local(active()));ui_project_set_machine("a",exact,"Complete identity");assert(pro_work_local(active()));
}

static void home_hierarchy(void) {
    for (int language=0;language<2;language++) {
        reset();strcpy(s.voice_language,language?"vi":"en");render_actual();
        assert(has_text(PRO_TR("Ready when you are")));
        ht_rect_t footer=action_hit(A_AGENTS)->rect;
        assert(footer.x==32&&footer.y==598&&footer.w==492&&footer.h==104);
        bool name=false,workspace=false;
        for(unsigned i=0;i<scene.count;i++) {
            const ht_run_t *r=&scene.runs[i];
            if(r->pro_kind!=1)continue;
            if(r->y==604){assert(r->pro_font==&ht_pro_42);name=true;}
            if(r->x==44&&r->y==36){assert(r->pro_font==&ht_pro_24);workspace=true;}
            if(r->y==668)assert(r->y+r->pro_height<=footer.y+footer.h);
        }
        assert(name&&workspace);
        memset(s.agents[0].name,'W',sizeof s.agents[0].name-1);
        s.agents[0].name[sizeof s.agents[0].name-1]=0;render_actual();
        for(unsigned i=0;i<scene.count;i++)
            if(scene.runs[i].pro_kind==1&&scene.runs[i].y==604)assert(scene.runs[i].pro_font==&ht_pro_32);
        assert(!memcmp(&footer,&action_hit(A_AGENTS)->rect,sizeof footer));
        s.agents[0].recap_ready=true;strcpy(s.agents[0].preview,"A result.");render_actual();
        assert(has_text(PRO_TR("A result is ready"))&&!has_text(PRO_TR("Ready when you are")));
        s.agents[0].busy=true;render_actual();assert(has_text(PRO_TR("Working")));
        s.voice_retry_until=now+1000;render_actual();assert(has_text(PRO_TR("Voice was not sent. Try again.")));
        s.connected=false;render_actual();assert(has_text(PRO_TR("Connect to your computer")));
    }
}
static void docked_connection_policy(void) {
    reset();
    for (int connected=0;connected<=1;connected++) {
        s.connected=connected; render_actual();
        assert(has_text("Menu") && !has_text("On the go") && !has_text("Connected"));
        assert(has_text(connected ? "Workspace" : "Connect to Harness"));
        assert(action_hit(A_TABS)->enabled==(bool)connected);
        assert(action_hit(A_AGENTS)->enabled==(bool)connected);
        assert(!drawn_compact && drawn_portrait.x==185 && drawn_portrait.y==164);
        assert(drawn_portrait.w==350 && drawn_portrait.h==350);
        bool footer=false;
        for (unsigned i=0;i<scene.count;i++) {
            const ht_run_t *r=&scene.runs[i];
            if (r->pro_kind==2 && r->x==0 && r->y==596 && r->w==720 && r->pro_height==124)
                footer=true;
        }
        assert(footer);
    }
}
static void home_gesture_consistency(void) {
    for (int summary=0;summary<=1;summary++) for (int action=0;action<8;action++) {
        reset();
        if (summary) {
            s.agents[0].recap_ready=true;
            strcpy(s.agents[0].preview,"A readable thought, with the same controls.");
        }
        render_actual();
        if (action==0) {
            tap(360,340,75); assert(starts==1 && !switches && !travel);
        } else if (action==1) {
            tap(630,520,450); assert(starts==1 && !switches && !travel);
        } else if (action==2) {
            swipe(520,340,260,343); assert(switches==1 && s.active==1 && !starts && !travel);
        } else if (action==3) {
            s.active=1; render_actual(); swipe(230,340,550,337);
            assert(switches==1 && s.active==0 && !starts && !travel);
        } else if (action==4) {
            swipe(360,480,366,220); assert(moves && travel<0 && !switches && !starts);
        } else if (action==5) {
            swipe(360,220,365,490); assert(moves && travel>0 && !switches && !starts);
        } else if (action==6) {
            sample(true,360,340,2000); now=2650; surface_tick(now);
            assert(s.view==LAUNCHER && !starts);
            sample(false,360,340,2800); assert(!starts && !selected && !switches);
        } else {
            swipe(250,200,450,400); assert(!starts && !switches && !selected && !travel);
        }
    }
}
static void voice_render_geometry(void) {
    reset(); s.view=VOICE; s.voice_open=recording=true; s.voice_return=HOME;
    copy(s.voice_target,sizeof s.voice_target,"A long pane name for your current project"); render_actual();
    const hit_t *pet=action_hit(A_PET), *discard=action_hit(A_VOICE_ABORT), *review=action_hit(A_VOICE_STOP);
    assert(pet && pet->enabled && pet->rect.x+pet->rect.w>=680);
    assert(discard && discard->enabled && review && review->enabled);
    assert(discard->rect.h>=64 && review->rect.h>=64);
    tap(630,350,75); assert(stops==1 && !starts);
    for(int lang=0;lang<2;lang++) for(int mode=PRO_WORK_GOAL;mode<=PRO_WORK_LOOP;mode++) {
        reset(); COPY(s.voice_language,lang?"vi":"en");
        s.view=VOICE; s.voice_open=s.voice_review=recording=true;
        s.voice_return=WORK_INTENT; s.work_voice_mode=mode;
        copy(s.voice_target,sizeof s.voice_target,"A long pane name for your current project");
        render_actual(); assert(has_text(PRO_TR(pro_work_label(mode))) && has_text(PRO_TR("Tap to review.")));
        assert(!has_text(PRO_TR("Tap to send. Hold to review first.")));
    }
}
static void voice_wait_discard(void) {
    reset(); s.view=VOICE; s.voice_open=s.voice_waiting=true; recording=false;
    render_actual(); const hit_t *discard=action_hit(A_VOICE_ABORT);
    assert(discard && discard->enabled);
    tap(discard->rect.x+discard->rect.w/2,discard->rect.y+discard->rect.h/2,75);
    assert(discards==1 && !s.voice_open && !recording && s.view==HOME);
}
static int lock_x(int i) { return 192+(i%3)*168; }
static int lock_y(int i) { return 252+(i/3)*168; }
static void lock_points(const int *points, unsigned count, uint32_t at) {
    for (unsigned i=0;i<count;i++) sample(true,lock_x(points[i]),lock_y(points[i]),at+i*90);
    sample(false,lock_x(points[count-1]),lock_y(points[count-1]),at+count*90);
}
static void lock_render_geometry(void) {
    reset(); s.locked=true; s.pattern_mask=(1<<0)|(1<<1)|(1<<2)|(1<<5);
    render_actual(); assert(!s.hit_count);
    for (int i=0;i<9;i++) {
        int rings=0,centres=0;
        for (unsigned j=0;j<scene.count;j++) {
            const ht_run_t *r=&scene.runs[j];
            if (r->pro_kind!=2) continue;
            if (r->x+r->w/2!=lock_x(i) || r->y+r->pro_height/2!=lock_y(i)) continue;
            if (r->w==48 && r->pro_height==48) {
                rings++; assert(r->fg==((s.pattern_mask&(1<<i)) ? ACCENT : SEL));
            }
            if (r->w==14 && r->pro_height==14) centres++;
        }
        assert(rings==1 && centres==1);
    }
}
static void lock_saved_pattern(void) {
    const int accepted[]={0,1,2,5};
    reset(); s.locked=s.lock_armed=true; render_actual();
    lock_points(accepted,4,2000);
    assert(lock_checks==1 && !s.locked && !s.lock_armed && s.view==HOME);
    assert(!starts && !stops && !selected && !queued && !moves && !switches);
    render_actual(); tap(360,340,75); assert(starts==1); // Unlock release never doubles as voice.
}
static void lock_short_wrong_then_retry(void) {
    const int short_pattern[]={0,1,2}, wrong[]={0,3,6,7}, accepted[]={0,1,2,5};
    reset(); s.locked=s.lock_armed=true; render_actual();
    lock_points(short_pattern,3,2000);
    assert(s.locked && s.pattern_error && !s.pattern_mask && !lock_checks);
    render_actual();
    lock_points(wrong,4,3000);
    assert(s.locked && s.pattern_error && !s.pattern_mask && lock_checks==1);
    render_actual();
    lock_points(accepted,4,4000);
    assert(!s.locked && !s.pattern_error && lock_checks==2 && s.view==HOME);
    assert(!starts && !stops && !selected && !queued && !moves && !switches);
}
static void lock_all_centres_and_radius(void) {
    reset(); s.locked=true;
    for (int i=0;i<9;i++) {
        sample(true,lock_x(i),lock_y(i),2000+i*90);
        sample(true,lock_x(i),lock_y(i),2040+i*90); // Repeated samples do not add the same dot twice.
    }
    assert(s.pattern_len==9 && s.pattern_mask==0x1ff && !strcmp(s.pattern,"0,1,2,3,4,5,6,7,8"));
    sample(false,lock_x(8),lock_y(8),2900); assert(s.locked && s.pattern_error);
    reset(); s.locked=true;
    sample(true,lock_x(0)+53,lock_y(0),2000); assert(!s.pattern_len);
    sample(true,lock_x(0)+51,lock_y(0),2040); assert(s.pattern_len==1 && s.pattern_mask==1);
    sample(false,lock_x(0)+51,lock_y(0),2080); assert(s.locked);
}
static void ota_brand_centered(void) {
    reset(); s.view=OTA; render_actual(); assert(!s.hit_count);
    unsigned text=0;
    for (unsigned i=0;i<scene.count;i++) {
        const ht_run_t *r=&scene.runs[i];
        if (r->pro_kind!=1) continue;
        text++; assert(abs((r->x+r->w/2)-360)<=1);
        assert(r->y>=250 && r->y+r->pro_height<520);
    }
    assert(text==3);
}
static void empty_speaker(void) {
    speech_audio=(audio_speech_state_t){.id=23,.active=true,.pending=true};
}
static void speech_start(const char *emotion) {
    empty_speaker();
    assert(ui_companion_speech_begin(23,"a","Your new layout is ready to review.",emotion));
    assert(s.speech.id==23 && s.speech.pending && !s.speech.playing && !s.speech.level);
}
static void speech_acceptance_gates(void) {
    for (int reason=0;reason<24;reason++) {
        reset(); empty_speaker(); const char *agent="a";
        switch(reason) {
        case 0:s.ready=false;break;
        case 1:s.connected=false;break;
        case 2:s.loading=true;break;
        case 3:s.locked=true;break;
        case 4:asleep=true;break;
        case 5:s.active=-1;break;
        case 6:agent="b";break;
        case 7:s.voice_open=true;break;
        case 8:s.voice_start_pending=true;break;
        case 9:s.voice_waiting=true;break;
        case 10:recording=true;break;
        case 11:s.touch_down=true;break;
        case 12:s.nap=true;break;
        case 13:s.voice_retry_until=3000;break;
        case 14:carry.active=true;break;
        case 15:strcpy(carry.error,"Expired selection");break;
        case 16:visit.pending=true;break;
        case 17:s.notice_count=1;s.notice[0].question=true;strcpy(s.notice[0].agent_id,"a");break;
        case 18:speech_audio.id=24;break;
        case 19:speech_audio.active=false;break;
        case 20:speech_audio.playing=true;break;
        case 21:speech_audio.received=2;break;
        case 22:speech_audio.error=AUDIO_SPEECH_ERROR_CODEC;break;
        case 23:s.speech.id=23;break;
        }
        assert(!ui_companion_speech_begin(23,agent,"A useful caption.","warm"));
        assert(!changes && !speech_aborts);
    }
    for (int page=HOME;page<=OTA;page++) {
        reset(); empty_speaker(); s.view=(view_t)page;
        assert(ui_companion_speech_begin(23,"a","A useful caption.","warm")==
               (page==HOME || page==AGENT));
    }
    // Notification beeps and still-character preferences do not disable an
    // explicitly requested conversation. Another pane's question is unrelated.
    reset();s.muted=s.quiet=true;s.notice_count=1;s.notice[0].question=true;
    strcpy(s.notice[0].agent_id,"b");speech_start("curious");
    assert(s.speech.emotion==PRO_SPEECH_CURIOUS);
}
static void speech_input_boundaries(void) {
    reset();empty_speaker();
    assert(!ui_companion_speech_begin(0,"a","Caption","warm"));
    assert(!ui_companion_speech_begin(23,NULL,"Caption","warm"));
    assert(!ui_companion_speech_begin(23,"","Caption","warm"));
    assert(!ui_companion_speech_begin(23,"a",NULL,"warm"));
    assert(!ui_companion_speech_begin(23,"a","","warm"));
    assert(!ui_companion_speech_begin(23,"a"," \n\t\r ","warm"));
    char long_id[ID_MAX+1];memset(long_id,'a',sizeof long_id);long_id[ID_MAX]=0;
    assert(!ui_companion_speech_begin(23,long_id,"Caption","warm"));
    char too_long[1026];memset(too_long,'a',sizeof too_long);too_long[1025]=0;
    assert(!ui_companion_speech_begin(23,"a",too_long,"warm"));
    char text[601];
    for (unsigned i=0;i<600;i+=3)memcpy(text+i,"\xe7\x8c\xab",3);
    text[600]=0;
    assert(ui_companion_speech_begin(23,"a",text,"unknown"));
    assert(s.speech.emotion==PRO_SPEECH_WARM && strlen(s.speech.caption)<sizeof s.speech.caption);
    const char *p=s.speech.caption;unsigned count=0;uint32_t cp;
    while ((cp=ht_utf8_next(&p))) {assert(cp==0x732b || cp==0x2026);count++;}
    assert(count>1 && !memcmp(s.speech.caption+strlen(s.speech.caption)-3,"\xe2\x80\xa6",3));
    ui_companion_speech_clear(0);empty_speaker();
    assert(ui_companion_speech_begin(23,"a"," \tA  calm\n reply. \xf0\x9f","gentle"));
    assert(!strcmp(s.speech.caption,"A calm reply. ?") && s.speech.emotion==PRO_SPEECH_GENTLE);
}
static void speech_playback_caption(void) {
    reset();s.agents[0].recap_ready=true;strcpy(s.agents[0].preview,"The original pane summary.");
    speech_start("happy");render_actual();
    assert(drawn_compact && drawn_mood==HT_CHARACTER_IDLE && !drawn_level);
    assert(has_text("One moment...") && !has_text("Speaking. Touch to interrupt."));
    assert(has_text("Your new layout is ready to review.") && !has_text(s.agents[0].preview));
    assert(!strcmp(s.agents[0].preview,"The original pane summary.") && s.agents[0].recap_ready);
    assert(action_hit(A_PET) && action_hit(A_PET)->enabled);
    speech_audio.pending=false;speech_audio.playing=true;speech_audio.level=3;
    surface_tick(now);render_actual();
    assert(drawn_compact && drawn_mood==HT_CHARACTER_LISTENING && drawn_level==3);
    assert(has_text("Speaking. Touch to interrupt.") && !has_text("A little voice."));
    for (unsigned i=0;i<scene.count;i++) assert(!strstr(scene.runs[i].text,"listening"));
    unsigned snapshots=speech_snapshots,changed=changes;
    now+=20;surface_tick(now);assert(speech_snapshots==snapshots && changes==changed);
    assert(habitat_next_wake_ms()==20);
    now+=20;surface_tick(now);assert(speech_snapshots==snapshots+1 && changes==changed);
    speech_audio.level=255;now+=40;surface_tick(now);assert(s.speech.level==4 && changes==changed+1);
    // Host EOF is not audible completion: keep the caption through final DMA.
    speech_audio.active=false;speech_audio.ended=true;now+=40;surface_tick(now);assert(s.speech.id==23);
    speech_audio.playing=false;now+=40;surface_tick(now);render_actual();
    assert(!s.speech.id && has_text("The original pane summary.") && s.agents[0].recap_ready);
    assert(!speech_aborts);
    reset();s.quiet=true;speech_start("warm");speech_audio.playing=true;speech_audio.pending=false;
    surface_tick(now);changed=changes;
    speech_audio.level=4;now+=40;surface_tick(now);
    assert(s.speech.level==4 && changes==changed); // Hidden mouth changes need no repaint.
}
static void speech_touch_interrupts(void) {
    reset();speech_start("warm");speech_audio.playing=true;speech_audio.pending=false;surface_tick(now);
    render_actual();sample(true,360,340,2000);
    assert(!s.speech.id && !speech_audio.active && speech_aborts==1 && aborted_id==23 && !starts);
    sample(false,360,340,2075);assert(starts==1 && s.view==VOICE);
    // DOWN can arrive after the empty audio session starts but before UI begin.
    reset();empty_speaker();sample(true,360,340,2000);
    assert(!ui_companion_speech_begin(23,"a","Race should be rejected.","warm"));
    assert(!s.speech.id && !speech_audio.active);
    reset();speech_start("warm");render_actual();swipe(520,340,260,343);
    assert(!s.speech.id && !speech_audio.active && switches==1 && s.active==1 && !starts);
}
static void speech_context_cancellation(void) {
    for (int cause=0;cause<8;cause++) {
        reset();speech_start("warm");
        switch(cause) {
        case 0:view(READER);break;
        case 1:ui_set_connected(false);break;
        case 2:ui_focus_project("b");break;
        case 3:power(false);break;
        case 4:s.locked=true;surface_tick(now);break;
        case 5:s.nap=true;surface_tick(now);break;
        case 6:s.loading=true;surface_tick(now);break;
        case 7:strcpy(carry.error,"Expired selection");surface_tick(now);break;
        }
        assert(!s.speech.id && !speech_audio.active && speech_aborts>=1);
    }
    reset();speech_start("warm");unsigned aborted=speech_aborts;
    ui_companion_speech_clear(999);assert(s.speech.id==23 && speech_aborts==aborted);
    ui_companion_speech_clear(23);assert(!s.speech.id && speech_aborts==aborted+1 && aborted_id==23);
    speech_audio=(audio_speech_state_t){.id=24,.active=true,.pending=true};
    assert(ui_companion_speech_begin(24,"a","The new session remains.","thoughtful"));
    ui_companion_speech_clear(23);assert(s.speech.id==24 && speech_audio.active);
    // A fresh audio session proves the previous worker finished, even if its
    // final UI poll has not happened. Accept without aborting the new speaker.
    speech_audio=(audio_speech_state_t){.id=25,.active=true,.pending=true};
    aborted=speech_aborts;
    assert(ui_companion_speech_begin(25,"a","A prompt follow-up.","warm"));
    assert(s.speech.id==25 && speech_aborts==aborted);
    ui_companion_speech_clear(0);assert(!s.speech.id && !speech_audio.active);
}
static void speech_error_and_emotions(void) {
    const char *emotions[]={"warm","happy","excited","gentle","sad","thoughtful","curious","angry"};
    for (unsigned i=0;i<sizeof emotions/sizeof emotions[0];i++) {
        reset();speech_start(emotions[i]);assert(s.speech.emotion==i);
        speech_audio.playing=true;speech_audio.pending=false;speech_audio.level=i%5;surface_tick(now);
        render_actual();assert(drawn_compact && drawn_level==i%5 && drawn_emotion==i);
    }
    reset();s.agents[0].recap_ready=true;strcpy(s.agents[0].preview,"Your summary stays readable.");
    speech_start("warm");speech_audio.active=false;speech_audio.error=AUDIO_SPEECH_ERROR_CODEC;
    surface_tick(now);render_actual();
    assert(!s.speech.id && has_text(s.agents[0].preview));
    assert(has_text("Voice unavailable. Text is still here."));
    now+=5000;surface_tick(now);assert(!s.speech_error_until);
    render_actual();assert(!has_text("Voice unavailable. Text is still here."));
    reset();speech_start("warm");s.notice_count=1;s.notice[0].question=true;strcpy(s.notice[0].agent_id,"a");
    surface_tick(now);render_actual();assert(!s.speech.id && has_text("Needs your answer"));
}
static void appearance_browse_is_local(void) {
    for(int page=0;page<2;page++) {
        reset();dispatch((action_t){.kind=page?A_SCENES:A_DAEMONS});render_actual();
        assert(pro_appearance_view());unsigned count=page?PRO_SCENE_COUNT:pro_daemon_count();
        for(unsigned i=1;i<=count;i++) {
            swipe(560,330,160,332);render_actual();
            assert((page?(unsigned)s.preview_scene:pro_daemon_index(s.preview_character.id))==i%count);
            assert(character.id==HT_CHARACTER_TIM&&s.scene_choice==PRO_SCENE_MATCH);
            assert(!queued&&!starts&&!switches&&!moves&&!down_reports&&!ups);
        }
        swipe(360,420,360,180);assert(pro_appearance_view()&&!queued&&!starts&&!switches);
        swipe(360,180,360,460);assert(pro_appearance_view()&&!queued&&!starts&&!switches);
        render_actual();tap(360,320,450);assert(pro_appearance_view()&&!queued&&!starts);
    }
}
static void appearance_use_and_cancel(void) {
    for(unsigned i=0;i<pro_daemon_count();i++) {
        reset();dispatch((action_t){.kind=A_DAEMONS});
        for(unsigned n=0;n<i;n++)pro_appearance_move(1);
        render_actual();tap(75,60,450);
        assert(s.view==LAUNCHER&&character.id==HT_CHARACTER_TIM&&!queued);
        dispatch((action_t){.kind=A_DAEMONS});assert(s.preview_character.id==HT_CHARACTER_TIM);
        for(unsigned n=0;n<i;n++)pro_appearance_move(1);
        render_actual();tap(360,660,450);
        assert(s.view==HOME&&character.id==pro_daemon_at(i)->id);
        assert(queued==(i?1u:0u));
        if(i)assert(queued_action.kind==A_APPEAR_SAVE&&queued_action.value==(int)character.id);
        assert(!starts&&!switches&&!moves);
    }
}
static void appearance_scene_override(void) {
    reset();dispatch((action_t){.kind=A_SCENES});
    for(int i=0;i<PRO_SCENE_PAPER;i++)pro_appearance_move(1);
    assert(pro_appearance_use()&&s.scene_choice==PRO_SCENE_PAPER);
    assert(queued==1&&queued_action.value==(PRO_SCENE_PAPER<<8));
    dispatch((action_t){.kind=A_DAEMONS});pro_appearance_move(1);assert(pro_appearance_use());
    assert(character.id==HT_CHARACTER_GNU&&s.scene_choice==PRO_SCENE_PAPER);
    assert(queued==2&&queued_action.value==((PRO_SCENE_PAPER<<8)|HT_CHARACTER_GNU));
    dispatch((action_t){.kind=A_SCENES});pro_appearance_move(1);assert(s.preview_scene==PRO_SCENE_MATCH);
    assert(pro_appearance_use()&&queued==3&&queued_action.value==HT_CHARACTER_GNU);
}
static void appearance_interrupted(void) {
    for(int reason=0;reason<4;reason++) {
        reset();dispatch((action_t){.kind=A_DAEMONS});pro_appearance_move(1);render_actual();
        if(reason==0){congested=true;assert(!pro_appearance_use());}
        if(reason==1){power(false);assert(s.view==HOME);}
        if(reason==2){ui_set_connected(false);}
        if(reason==3){sample(true,360,660,2000);input_cancel();sample(false,360,660,2080);}
        assert(character.id==HT_CHARACTER_TIM&&s.scene_choice==PRO_SCENE_MATCH&&!queued&&!starts&&!switches);
    }
}
typedef void (*test_fn)(void);

static void language_controls(void) {
    strcpy(saved_language,"en");fail_language_save=false;reset();s.connected=false;
    s.view=LAUNCHER;s.hit_count=0;ht_scene_t frame;ht_scene_clear(&frame,BG);pro_launcher(&frame);
    const hit_t *entry=action_hit(A_LANGUAGE);assert(entry&&entry->enabled);
    tap(entry->rect.x+40,entry->rect.y+30,75);assert(s.view==LANGUAGE&&!queued);
    s.hit_count=0;ht_scene_clear(&frame,BG);pro_language(&frame);
    const hit_t *english=action_hit(A_LANGUAGE_SET);assert(english&&english->value==0);
    tap(100,442,75); // Vietnamese row: real hit geometry and production dispatch.
    assert(s.language_saving&&queued==1&&!strcmp(saved_language,"en"));
    assert(queued_action.kind==A_LANGUAGE_SET&&queued_action.value==1);
    dispatch((action_t){.kind=A_LANGUAGE_SET,.value=0});assert(queued==1);
    language_worker(queued_action);assert(!s.language_saving&&!s.language_error);
    assert(!strcmp(saved_language,"vi")&&!strcmp(PRO_TR("Language"),"Ngôn ngữ"));
    reset();assert(!strcmp(s.voice_language,"vi")); // Fresh UI reads persisted choice.
    s.view=LANGUAGE;congested=true;
    dispatch((action_t){.kind=A_LANGUAGE_SET,.value=0});
    assert(s.language_error&&!s.language_saving&&!strcmp(s.voice_language,"vi"));
    congested=false;fail_language_save=true;
    dispatch((action_t){.kind=A_LANGUAGE_SET,.value=0});language_worker(queued_action);
    assert(s.language_error&&!s.language_saving&&!strcmp(s.voice_language,"vi"));
    fail_language_save=false;
    dispatch((action_t){.kind=A_LANGUAGE_SET,.value=0});language_worker(queued_action);
    assert(!s.language_error&&!strcmp(s.voice_language,"en")&&!strcmp(saved_language,"en"));
    unsigned before=queued;
    dispatch((action_t){.kind=A_LANGUAGE_SET,.value=0});
    dispatch((action_t){.kind=A_LANGUAGE_SET,.value=2});assert(queued==before);
    view(HOME);dispatch((action_t){.kind=A_LANGUAGE_SET,.value=1});assert(queued==before);
    assert(!starts&&!recording); // Changing a preference cannot start/send audio.
}

static void voice_sample_controls(void) {
    reset();s.connected=false;s.loading=true;native_voice_available=true;
    s.view=LAUNCHER;s.hit_count=0;ht_scene_t frame;ht_scene_clear(&frame,BG);pro_launcher(&frame);
    const hit_t *entry=action_hit(A_VOICE_SAMPLES);assert(entry&&entry->enabled);
    tap(entry->rect.x+40,entry->rect.y+30,75);
    assert(s.view==VOICE_SAMPLES&&s.sample_volume==80&&!starts&&!recording);
    s.hit_count=0;ht_scene_clear(&frame,BG);pro_voice_samples(&frame);
    const hit_t *play=action_hit(A_SAMPLE_PLAY);assert(play&&play->enabled);
    tap(play->rect.x+40,play->rect.y+30,75);
    assert(pro_voice_sample_owns_audio());
    unsigned index=s.voice_sample;
    dispatch((action_t){.kind=A_SAMPLE_VOLUME,.value=-10});assert(s.sample_volume==70&&s.voice_sample==index);
    for(int n=0;n<20;n++)dispatch((action_t){.kind=A_SAMPLE_VOLUME,.value=-10});
    assert(s.sample_volume==0);
    for(int n=0;n<20;n++)dispatch((action_t){.kind=A_SAMPLE_VOLUME,.value=10});
    assert(s.sample_volume==100);
    dispatch((action_t){.kind=A_SAMPLE_PARAMS});assert(s.view==VOICE_PARAMS&&pro_voice_sample_owns_audio());
    dispatch((action_t){.kind=A_VOICE_SAMPLES});assert(s.view==VOICE_SAMPLES&&s.sample_volume==100);
    unsigned aborted=speech_aborts;ui_focus_project("b");assert(speech_aborts==aborted&&pro_voice_sample_owns_audio());
    dispatch((action_t){.kind=A_SAMPLE_NEXT});assert(s.voice_sample==index+1&&!pro_voice_sample_owns_audio());
    dispatch((action_t){.kind=A_SAMPLE_PLAY});assert(pro_voice_sample_owns_audio());
    dispatch((action_t){.kind=A_LAUNCHER});assert(s.view==LAUNCHER&&!pro_voice_sample_owns_audio());
    assert(!starts&&!recording);
    reset();native_voice_available=false;dispatch((action_t){.kind=A_VOICE_SAMPLES});
    dispatch((action_t){.kind=A_SAMPLE_PLAY});assert(pro_voice_sample_progress().phase==PRO_VOICE_ERROR);
    native_voice_available=true;
}

static void today_read_only(void) {
    reset();pro_metrics_source(&s.metrics,"local",true);view(LAUNCHER);
    s.hit_count=0;ht_scene_clear(&scene,BG);pro_launcher(&scene);
    const hit_t *entry=action_hit(A_TODAY);assert(entry&&entry->enabled);
    tap(entry->rect.x+40,entry->rect.y+30,75);
    assert(s.view==TODAY&&s.metrics.phase==PRO_METRICS_WAIT&&queued==1);
    assert(queued_action.kind==A_METRICS_GET);
    render_actual();const hit_t *refresh=action_hit(A_TODAY_REFRESH);
    assert(refresh&&!refresh->enabled&&habitat_next_wake_ms()<=1000);
    tap(360,340,75);swipe(360,480,366,220);
    assert(s.view==TODAY&&queued==1&&!starts&&!switches&&!travel&&!down_reports);
    swipe(230,340,550,337);
    assert(s.view==HOME&&s.metrics.phase==PRO_METRICS_EMPTY&&!s.metrics.request[0]);
    assert(queued==1&&!starts&&!switches&&!travel&&!down_reports);
}

static void today_refresh_contact(void) {
    reset();pro_metrics_source(&s.metrics,"local",true);view(TODAY);
    s.metrics.phase=PRO_METRICS_ERROR;render_actual();
    const hit_t *refresh=action_hit(A_TODAY_REFRESH);assert(refresh&&refresh->enabled);
    int x=refresh->rect.x+40,y=refresh->rect.y+30;
    sample(true,x,y,2000);sample(true,x,y-80,2070);sample(true,x,y,2140);sample(false,x,y,2200);
    assert(!queued&&!starts&&!switches&&!travel);
    view(TODAY);render_actual();tap(x,y,75);
    assert(queued==1&&s.metrics.phase==PRO_METRICS_WAIT);
    render_actual();tap(x,y,75);assert(queued==1);
    ui_set_connected(false);
    assert(!s.metrics.supported&&!s.metrics.request[0]&&!s.metrics.usage.has_cost);
    assert(!starts&&!switches&&!travel&&!down_reports);
}

int main(int argc,char **argv) {
    const struct { const char *name; test_fn run; } tests[]={
        {"work_identity_callbacks",work_identity_callbacks},{"busy_observation",busy_observation},{"busy_connection_loss",busy_connection_loss},{"busy_precedence",busy_precedence},
        {"busy_tick_schedule",busy_tick_schedule},{"busy_render_boundaries",busy_render_boundaries},
        {"today_read_only",today_read_only},{"today_refresh_contact",today_refresh_contact},{"home_hierarchy",home_hierarchy},
        {"language_controls",language_controls},{"voice_sample_controls",voice_sample_controls},{"center_voice",center_voice},{"summary_voice",summary_voice},{"deliberate_tap",deliberate_tap},
        {"thumb_drift",thumb_drift},{"panes",panes},{"pane_after_diagonal_start",pane_after_diagonal_start},
        {"scroll_output",scroll_output},
        {"congested_scroll",congested_scroll},{"diagonal",diagonal},{"hold_launcher",hold_launcher},
        {"offline_launcher",offline_launcher},
        {"cancelled_written_control",cancelled_written_control},{"changed_screen_contact",changed_screen_contact},
        {"scroll_return_to_row",scroll_return_to_row},{"deliberate_written_control",deliberate_written_control},
        {"draft_hold_options",draft_hold_options},{"carry_retained_reading",carry_retained_reading},{"cancellation_matrix",cancellation_matrix},
        {"full_width_voice",full_width_voice},{"voice_guard",voice_guard},
        {"discard_is_immediate",discard_is_immediate},{"sensor_cancel_then_next_contact",sensor_cancel_then_next_contact},
        {"no_hidden_home_from_reader",no_hidden_home_from_reader},
        {"home_render_geometry",home_render_geometry},{"home_state_geometry",home_state_geometry},
        {"home_header_drag_cancel",home_header_drag_cancel},{"home_header_tap_tabs",home_header_tap_tabs},
        {"current_tab_returns_home",current_tab_returns_home},{"changed_tab_stays_on_home",changed_tab_stays_on_home},
        {"carried_excerpt_is_readable",carried_excerpt_is_readable},{"question_retained_reading",question_retained_reading},
        {"docked_connection_policy",docked_connection_policy},{"home_gesture_consistency",home_gesture_consistency},
        {"workspace_chord_navigation",workspace_chord_navigation},{"workspace_chord_gates",workspace_chord_gates},
        {"workspace_chord_context",workspace_chord_context},{"map_contact_invalidation",map_contact_invalidation},{"map_layout_is_local",map_layout_is_local},
        {"voice_render_geometry",voice_render_geometry},{"voice_wait_discard",voice_wait_discard},
        {"lock_render_geometry",lock_render_geometry},{"lock_saved_pattern",lock_saved_pattern},
        {"lock_short_wrong_then_retry",lock_short_wrong_then_retry},
        {"lock_all_centres_and_radius",lock_all_centres_and_radius},{"ota_brand_centered",ota_brand_centered},
        {"speech_acceptance_gates",speech_acceptance_gates},{"speech_input_boundaries",speech_input_boundaries},
        {"speech_playback_caption",speech_playback_caption},{"speech_touch_interrupts",speech_touch_interrupts},
        {"speech_context_cancellation",speech_context_cancellation},{"speech_error_and_emotions",speech_error_and_emotions},
        {"appearance_browse_is_local",appearance_browse_is_local},{"appearance_use_and_cancel",appearance_use_and_cancel},
        {"appearance_scene_override",appearance_scene_override},{"appearance_interrupted",appearance_interrupted}
    };
    for(unsigned i=0;i<sizeof tests/sizeof tests[0];i++)
        if(argc==1 || !strcmp(argv[1],tests[i].name)) { tests[i].run(); printf("PASS %s\n",tests[i].name); }
    return 0;
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-touch-") as directory:
    generated = Path(directory) / "pro_touch.c"
    executable = Path(directory) / "pro_touch"
    generated.write_text(code)
    modules = ("gestures", "scroll", "workspace", "selection", "carry", "visit", "form", "draft",
               "terminal", "fonts", "pro_canvas", "pro_daemon", "character_motion")
    generated_assets = HERE / "../../prototype/pro-companion/generated"
    command = [os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
               "-Wno-unused-function", "-Wno-unused-variable", "-O1", "-g",
               "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
               "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-I", str(NATIVE), "-I", str(generated_assets),
               str(generated), *[str(NATIVE / f"{module}.c") for module in modules],
               str(generated_assets / "pro_fonts.c"), *voice_assets(directory), "-o", str(executable)]
    subprocess.run(command, check=True)
    names = re.findall(r'\{"([a-z_]+)",[a-z_]+\}', code)
    failures = []
    for name in names:
        result = subprocess.run([str(executable), name], text=True, capture_output=True)
        if result.returncode:
            failures.append(name)
            print(f"FAIL {name}: {result.stderr.strip()}")
        else:
            print(result.stdout.strip())
    assert not failures, f"Pro touch regressions: {', '.join(failures)}"
    print(f"Pro native touch: {len(names)} production-handler replays passed")
    # The same shared caller can include this API on the round target without
    # linking any speaker UI or introducing a new behavior there.
    round_source = Path(directory) / "round_speech.c"
    round_source.write_text('''#include "../companion_speech.h"
#include <assert.h>
int main(void) {
    assert(!ui_companion_speech_begin(1,"pane","Text","happy"));
    ui_companion_speech_clear(0); ui_companion_speech_clear(1); return 0;
}
''')
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(NATIVE), str(round_source), "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
    print("Round companion speech API: inert inline stubs passed")
