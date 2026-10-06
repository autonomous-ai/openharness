"""Render the actual Pro sheets with live-sized state and check glass/text bounds.

No USB, microphone, app actions or ESP stubs are needed: the production sheet
include consumes the real state declarations and uses the real rasterizer/fonts.
HABITAT_PRO_PREVIEW_DIR optionally receives pixel-exact 720 px PPMs.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

from native_shapes import defines, typedef
from native_voice import voice_assets

HERE = Path(__file__).resolve().parent
NATIVE = (HERE / "../main/ui/habitat").resolve()
SOURCE = (NATIVE / "ui_habitat.c").read_text()
FONTS = HERE / "../../prototype/pro-companion/generated/pro_fonts.c"


def function(name):
    match = re.search(r"^[^\n]*\b" + name + r"\([^;]*?\)\n\{.*?^\}", SOURCE, re.M | re.S)
    assert match, name
    return match.group(0) + "\n"


code = r'''
#include "runtime.h"
#include "pro_canvas.h"
#include "pro_metrics.h"
#include "../../pro_voice_samples.h"
#include "pro_visual.h"
#include "../../cable_features.h"
#include "../../cable_machines.h"
#include "workspace.h"
#include "selection.h"
#include "carry.h"
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "visit.h"
#include "form.h"
#include "draft.h"
#include "character.h"
#include "theme.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define COPY(dst,src) snprintf(dst,sizeof(dst),"%s",src)
'''
code += defines("CABLE_READ_TOKEN_MAX", "ID_MAX", "CABLE_NAME_MAX", "SWARM_ID_MAX", "SWARMS_MAX",
                "SWARM_TILES_MAX", "CABLE_MAX_AGENTS", "MAX_PROJECTS")
code += defines("NOTICES", "QUESTION_MAX", "OPTION_MAX", "PANE_MEMORY_MAX", "PANE_RESULT_BYTES", source=SOURCE)
for name in ("cable_swarm_t", "cable_notif_t", "cable_tile_t", "model_item_t"):
    code += typedef(name)
code += SOURCE[SOURCE.index("typedef enum {"):SOURCE.index("static QueueHandle_t actions;")]
code += r'''
static ht_tab_carousel_t tab_carousel;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static bool native_voice_available = true;
bool audio_speech_available(void) { return native_voice_available; }
bool audio_speech_begin(uint32_t id, uint32_t rate, uint8_t volume) { (void)id;(void)rate;(void)volume;return true; }
bool audio_speech_push(uint32_t id,uint32_t offset,const void *pcm,size_t bytes) { (void)id;(void)offset;(void)pcm;(void)bytes;return true; }
bool audio_speech_end(uint32_t id,uint32_t bytes) { (void)id;(void)bytes;return true; }
bool audio_speech_set_volume(uint32_t id,uint8_t volume) { (void)id;(void)volume;return true; }
#include "../../audio_speech.h"
void audio_speech_snapshot(audio_speech_state_t *out) { memset(out,0,sizeof *out); }
void audio_speech_abort(uint32_t id) { (void)id; }
static uint32_t ms(void) { return 1000; }
const char *ht_character_name(ht_character_id_t id) { return pro_daemon_definition(id)->name; }
void pro_visual_background(ht_scene_t *f, pro_scene_id_t scene, ht_character_id_t id) {
    (void)scene; (void)id; ht_pro_rect(f,0,0,720,720,0,ht_rgb(0xf4f2e8));
}
void pro_visual_character(ht_scene_t *f, const ht_character_t *c, ht_character_mood_t mood,
                          bool small, int x, int y, uint32_t now, bool quiet, bool mail) {
    (void)c;(void)mood;(void)now;(void)quiet;(void)mail;
    int size=small?160:350;ht_pro_rect(f,x,y,size,size,0,ht_rgb(0xe6e8dc));
}
static uint32_t features = ~0u;
static bool cable_client_supports(uint32_t feature) { return (features & feature) == feature; }
static agent_t *active(void) { return s.active >= 0 && s.active < s.count ? &s.agents[s.active] : NULL; }
static int find(const char *id) { for(int i=0;i<s.count;i++) if(!strcmp(id,s.agents[i].id)) return i; return -1; }
static bool is_question(const char *id) { return !strcmp(id,"agent-1"); }
static uint16_t color(unsigned rgb) { return ht_rgb(rgb); }
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define ERROR color(HT_THEME_ERROR)
#define SEL color(HT_THEME_SELECTION)
'''
code += function("settings_item") + function("settings_count")
code += '#include "pro_controls.inc"\n'
code += r'''
static void fill(char *out,size_t n) { memset(out,'W',n-1);out[n-1]=0; }
static void reset(bool stress) {
    memset(&s,0,sizeof s); memset(&form,0,sizeof form); memset(&draft,0,sizeof draft);
    memset(&selection,0,sizeof selection); memset(&carry,0,sizeof carry); memset(&visit,0,sizeof visit);
    s.connected=s.ready=true; s.active=0; s.pressed=-1; s.brightness=75;
    s.sample_volume=80; s.sample_volume_set=true;
    s.count=7; s.tab_count=3; s.machine_count=3; s.model_count=3;
    for(int i=0;i<s.count;i++) {
        snprintf(s.agents[i].id,sizeof s.agents[i].id,"agent-%d",i);
        snprintf(s.agents[i].name,sizeof s.agents[i].name,"%s",i==0?"A little company":i==1?"Design the next chapter":"Build something wonderful");
        COPY(s.agents[i].full,"The new companion experience is ready. The octopus follows your work, listens when you tap, and keeps the desktop close at hand. Swipe to read the rest without losing your place. A quieter layout gives your words more room and keeps the controls predictable.");
        COPY(s.agents[i].tool,"Working on the next idea"); s.agents[i].busy=i==2;
        if(stress) { fill(s.agents[i].name,sizeof s.agents[i].name);fill(s.agents[i].full,sizeof s.agents[i].full); }
    }
    for(int i=0;i<s.tab_count;i++) {
        snprintf(s.tabs[i].id,sizeof s.tabs[i].id,"tab-%d",i);
        COPY(s.tabs[i].name,i==0?"My first workspace":i==1?"A studio for small, wonderful things":"The next chapter");
        if(stress) fill(s.tabs[i].name,sizeof s.tabs[i].name);
    }
    COPY(s.work_agent,"agent-0");COPY(s.agents[0].engine,"claude");
    COPY(s.selected_tab,"tab-1");ht_tab_carousel_reset(&tab_carousel,s.tab_count,1);
    for(int i=0;i<s.machine_count;i++) {
        snprintf(s.machines[i].id,sizeof s.machines[i].id,"machine-%d",i);
        COPY(s.machines[i].name,i==0?"Your Mac":i==1?"Studio computer":"Home desktop");
        COPY(s.machines[i].state,i==2?"offline":"ready");s.machines[i].local=i==0;
        if(stress) fill(s.machines[i].name,sizeof s.machines[i].name);
    }
    COPY(s.selected_machine,"machine-0");
    for(int i=0;i<s.model_count;i++) {
        snprintf(s.models[i].id,sizeof s.models[i].id,"runtime:model-%d@high",i);
        if(stress) fill(s.models[i].id,sizeof s.models[i].id);
    }
    COPY(s.model_selected,s.models[0].id);
    s.notice_count=2;COPY(s.notice[0].agent_id,"agent-0");COPY(s.notice[0].name,"A little company");
    COPY(s.notice[0].summary,"The companion now listens, moves between panes, and brings your latest work back to you.");
    s.notice[0].display_revision=123;
    s.q.valid=s.q.supported=true;s.q.count=2;s.q.index=0;s.q.choice=0;
    COPY(s.q.name,"Design the next chapter");COPY(s.q.agent,"agent-1");
    question_item_t *q=&s.q.item[0];q->can_text=true;q->count=3;q->selected=1;
    COPY(q->prompt,"Which direction should we explore for the next version of the companion?");
    COPY(q->options[0],"A quieter landscape with a bigger, more expressive creature and clearer text.");
    COPY(q->answer,q->options[0]);COPY(q->draft,"spoken-answer");
    COPY(selection.agent,"agent-0");COPY(selection.id,"selection");selection.active=true;selection.announced=true;selection.rows=3;
    selection.revision=1;COPY(selection.excerpt,"A quieter layout gives your words more room, and keeps every interaction predictable.");
    COPY(form.id,"find-fixture");form.page.active=form.page.enabled=form.page.can_query=true;
    COPY(form.page.title,"Find Harness");COPY(form.page.previous,"Yesterday's sketchbook");
    COPY(form.page.label,"A little company");COPY(form.page.detail,"The Pro companion prototype. Last worked on moments ago, on this computer.");
    COPY(form.page.action,"Open");form.page.position=2;form.page.total=12;
    COPY(draft.page.id,"draft-fixture");COPY(draft.page.name,"A little company");
    COPY(draft.page.text,"Let's make the companion feel calm, useful, and alive. Keep one tap for voice, and give every result enough room to read.");
    COPY(draft.page.context,"A message for your selected pane");
    draft.page.active=draft.page.can_send=draft.page.can_undo=true;draft.page.position=1;draft.page.total=2;
    COPY(s.stop_agent,"agent-2");COPY(s.title,"A quick note");
    COPY(s.message,"The computer disconnected. Your companion is still here. Reconnect the cable to continue where you left off.");
    if(stress) {
        fill(s.notice[0].name,sizeof s.notice[0].name);fill(s.notice[0].summary,sizeof s.notice[0].summary);
        fill(q->prompt,sizeof q->prompt);fill(q->options[0],sizeof q->options[0]);fill(q->answer,sizeof q->answer);
        fill(selection.excerpt,sizeof selection.excerpt);fill(form.page.label,sizeof form.page.label);
        fill(form.page.detail,sizeof form.page.detail);fill(draft.page.text,sizeof draft.page.text);
        fill(s.message,sizeof s.message);
    }
}
static bool overlap(ht_rect_t a,ht_rect_t b) {
    return a.x<b.x+b.w && b.x<a.x+a.w && a.y<b.y+b.h && b.y<a.y+a.h;
}
static unsigned action_count(action_kind_t action,bool enabled) {
    unsigned n=0;
    for(int i=0;i<s.hit_count;i++) if(s.hits[i].action==action&&(!enabled||s.hits[i].enabled))n++;
    return n;
}
static void inspect(const ht_scene_t *f,const char *name) {
    assert(f->count<HT_RUNS && s.hit_count<=24);
    for(int i=0;i<f->count;i++) {
        ht_rect_t b=ht_run_bounds(&f->runs[i]);
        if(b.x<0||b.y<0||b.x+b.w>720||b.y+b.h>720) {
            fprintf(stderr,"%s outside glass: run%d %d,%d %dx%d [%s]\n",name,i,b.x,b.y,b.w,b.h,f->runs[i].text);abort();
        }
        if(f->runs[i].pro_kind!=1||!f->runs[i].text[0]) continue;
        for(int j=i+1;j<f->count;j++) {
            if(f->runs[j].pro_kind!=1||!f->runs[j].text[0])continue;
            if(overlap(b,ht_run_bounds(&f->runs[j]))) {
                fprintf(stderr,"%s text overlap: [%s] with [%s]\n",name,f->runs[i].text,f->runs[j].text);abort();
            }
        }
    }
    for(int i=0;i<s.hit_count;i++) {
        ht_rect_t b=s.hits[i].rect;
        assert(b.x>=0&&b.y>=0&&b.x+b.w<=720&&b.y+b.h<=720&&b.w>0&&b.h>=60);
        if(s.view==LAUNCHER || s.view==LANGUAGE || s.view==AGENTS)
            for(int j=i+1;j<s.hit_count;j++) assert(!overlap(b,s.hits[j].rect));
        if(s.hits[i].action==A_STOP_YES) assert(s.view==STOP);
        if(s.hits[i].action==A_ANSWER) assert(s.view==ANSWER_REVIEW);
        if(s.hits[i].action==A_DRAFT_SEND) assert(s.view==DRAFT&&!draft.page.locked);
    }
}
static void portrait(const ht_scene_t *f,const char *dir,const char *name) {
    if(!dir)return;
    static uint16_t pixels[720*720];ht_raster(f,(ht_rect_t){0,0,720,720},pixels);
    char path[1024];snprintf(path,sizeof path,"%s/%s.ppm",dir,name);FILE *out=fopen(path,"wb");assert(out);
    fprintf(out,"P6\n720 720\n255\n");
    for(size_t i=0;i<720*720;i++) {
        unsigned p=pixels[i];unsigned char rgb[3]={(unsigned char)((p>>11)*255/31),
            (unsigned char)(((p>>5)&63)*255/63),(unsigned char)((p&31)*255/31)};
        fwrite(rgb,1,3,out);
    }
    fclose(out);
}
static bool has_text(const ht_scene_t *f,const char *text) {
    for(unsigned i=0;i<f->count;i++) if(f->runs[i].pro_kind==1 && !strcmp(f->runs[i].text,text))return true;
    return false;
}
static void map_fixture(int columns,int rows,int count,bool duplicate) {
    reset(false);s.view=AGENTS;s.pro_agent_layout=2;s.tile_count=count;
    COPY(s.tile_tab,s.selected_tab);
    for(int i=0;i<count;i++) {
        s.tiles[i]=(cable_tile_t){.x1=(i%columns)*1000/columns,.x2=(i%columns+1)*1000/columns,
            .y1=(i/columns)*1000/rows,.y2=(i/columns+1)*1000/rows};
        COPY(s.tiles[i].agent_id,s.agents[duplicate?0:i%s.count].id);
    }
}
static void map_checks(const char *dir) {
    ht_scene_t map;
    for(int lang=0;lang<2;lang++)for(int count=1;count<=24;count++)for(int cols=1;cols<=count;cols++)for(int duplicate=0;duplicate<2;duplicate++) {
        map_fixture(cols,(count+cols-1)/cols,count,duplicate);COPY(s.voice_language,lang?"vi":"en");
        if(duplicate)for(int i=0;i<s.count;i++)fill(s.agents[i].name,sizeof s.agents[i].name);
        assert(pro_map_ready());ht_scene_clear(&map,BG);assert(pro_render_controls(&map));inspect(&map,"map geometry/budget");
        assert(action_count(A_HOME,true)==1&&action_count(A_AGENT_LAYOUT,true)==1);
        assert(action_count(A_TABS,true)==1&&action_count(A_FIND,true)==1&&action_count(A_AGENT,true)<=20);
        for(int i=0;i<s.hit_count;i++)if(s.hits[i].action==A_AGENT) {
            assert(s.hits[i].rect.w>=96&&s.hits[i].rect.h>=96);
            bool exact=false;for(int j=0;j<count;j++) {
                ht_rect_t r=pro_map_rect(&s.tiles[j]);
                if(!memcmp(&r,&s.hits[i].rect,sizeof r)&&!strcmp(s.tiles[j].agent_id,s.agents[s.hits[i].value].id))exact=true;
            }
            assert(exact); // Hit targets preserve the host rectangle and roster identity.
        }
    }
    map_fixture(2,2,3,false);ht_scene_clear(&map,BG);assert(pro_render_controls(&map));
    assert(action_count(A_AGENT,true)==3);portrait(&map,dir,"map-three-panes");
    map_fixture(6,4,24,true);ht_scene_clear(&map,BG);assert(pro_render_controls(&map));
    assert(action_count(A_AGENT,true)==20);inspect(&map,"map dense duplicate IDs");portrait(&map,dir,"map-dense");
    s.pro_agent_layout=0;s.hit_count=0;ht_scene_clear(&map,BG);assert(pro_render_controls(&map));
    assert(action_count(A_AGENT,true)==4&&action_count(A_DOWN,true)==1); // Dense map defaults to usable list.
    map_fixture(24,1,24,false);ht_scene_clear(&map,BG);assert(pro_render_controls(&map));
    assert(!action_count(A_AGENT,true)&&action_count(A_AGENT_LAYOUT,true)==1);portrait(&map,dir,"map-tiny-panes");
    map_fixture(2,2,4,false);s.connected=false;ht_scene_clear(&map,BG);assert(pro_render_controls(&map));
    assert(!action_count(A_AGENT,true)&&!action_count(A_TABS,true)&&!action_count(A_FIND,true));
    assert(action_count(A_AGENT_LAYOUT,true)==1); // Layout preference remains local.
    for(int invalid=0;invalid<8;invalid++) {
        map_fixture(2,2,4,false);
        switch(invalid) {
        case 0:COPY(s.tile_tab,"old-tab");break;case 1:s.loading=true;break;
        case 2:s.tiles[0].x1=-1;break;case 3:s.tiles[0].x2=1001;break;
        case 4:s.tiles[0].y2=s.tiles[0].y1;break;case 5:s.tiles[0]=s.tiles[1];break;
        case 6:for(int i=0;i<s.tile_count;i++)COPY(s.tiles[i].agent_id,"missing");break;
        case 7:s.tile_count=0;break;
        }
        assert(!pro_map_ready());ht_scene_clear(&map,BG);assert(pro_render_controls(&map));inspect(&map,"map fallback");
        assert(!action_count(A_AGENT_LAYOUT,true)&&action_count(A_AGENT,true)==4&&has_text(&map,"The layout is updating."));
    }
    map_fixture(2,2,4,false);s.tiles[1].agent_id[0]=0;COPY(s.tiles[2].agent_id,"missing");
    ht_scene_clear(&map,BG);assert(pro_render_controls(&map));inspect(&map,"map mixed roster");
    assert(action_count(A_AGENT,true)==2&&has_text(&map,"App pane")&&has_text(&map,"Unavailable"));
    portrait(&map,dir,"map-mixed-panes");
    map_fixture(2,2,3,false);s.pro_agent_layout=1;ht_scene_clear(&map,BG);assert(pro_render_controls(&map));
    inspect(&map,"explicit list");assert(action_count(A_AGENT,true)==4&&action_count(A_AGENT_LAYOUT,true)==1);
    portrait(&map,dir,"map-list");
}
int main(int argc,char **argv) {
    const char *dir=argc>1?argv[1]:NULL;
    map_checks(dir);
    for(int lang=0;lang<2;lang++)for(int stress=0;stress<2;stress++)for(int state=0;state<4;state++) {
        reset(stress);COPY(s.voice_language,lang?"vi":"en");
        carry=(ht_carry_t){.active=true,.rows=4,.id="carry-original",.source="Research",.excerpt="Keep the landscape quiet. Give the creature room to breathe, and let clear words lead when there is something to read."};
        COPY(draft.page.agent,"agent-0");
        pro_carry_review_begin(&s.carry_review,&carry,"agent-0",draft.page.name);
        COPY(s.carry_review.draft,draft.page.id);
        if(stress) {fill(s.carry_review.source,sizeof s.carry_review.source);fill(s.carry_review.excerpt,sizeof s.carry_review.excerpt);}
        if(state==1) {draft.failed=true;COPY(draft.page.error,"Recipient unavailable. Your message is still here.");}
        if(state==2) {draft.failed=draft.page.locked=s.carry_review.detached=true;COPY(draft.page.error,"Connection ended. Check the desktop before starting again.");}
        if(state==3)draft.pending=true;
        s.view=DRAFT;ht_scene_t sheet;ht_scene_clear(&sheet,BG);assert(pro_render_controls(&sheet));inspect(&sheet,"carried draft");
        assert(action_count(A_CARRY_PREVIEW,true)==(unsigned)(state!=3));
        assert(action_count(A_DRAFT_SEND,true)==(unsigned)(state==0));
        assert(action_count(A_DRAFT_STATE,true)==(unsigned)(state==1));
        char name[64];snprintf(name,sizeof name,"carry-review-%s-%d",lang?"vi":"en",state);if(!stress)portrait(&sheet,dir,name);
        s.view=CARRY_PREVIEW;s.hit_count=0;ht_scene_clear(&sheet,BG);assert(pro_render_controls(&sheet));inspect(&sheet,"passage preview");
        assert(!action_count(A_DRAFT_SEND,false)&&!action_count(A_DRAFT_EDIT,false));
        assert(has_text(&sheet,PRO_TR(state==2?"Preview kept here.":"Full passage stays attached.")));
        assert(action_count(A_DOWN,true)==(unsigned)(stress!=0));
        snprintf(name,sizeof name,"carry-preview-%s-%d",lang?"vi":"en",state);if(!stress)portrait(&sheet,dir,name);
        if(stress) {s.offset=999;s.hit_count=0;ht_scene_clear(&sheet,BG);assert(pro_render_controls(&sheet));inspect(&sheet,"last preview rows");assert(action_count(A_UP,true)&&!action_count(A_DOWN,true));}
    }
    static const struct { view_t view;const char *name; } screens[]={
        {LAUNCHER,"launcher"},{WORK_INTENT,"instruction"},{TODAY,"today-empty"},{LANGUAGE,"language"},{VOICE_SAMPLES,"voice"},{VOICE_PARAMS,"voice-params"},{AGENTS,"panes"},{TABS,"tabs"},{INBOX,"updates"},{MACHINES,"machines"},
        {MODELS,"models"},{SETTINGS,"controls"},{COMPANION,"companion"},{READER,"read"},
        {QUESTION,"question"},{CHOICE,"choices"},{ANSWER_REVIEW,"answer"},{SELECTION,"selection"},
        {FORM,"form"},{DRAFT,"draft"},{DRAFT_OPTIONS,"draft-options"},{STOP,"stop"},{MESSAGE,"message"},
    };
    for(unsigned lang=0;lang<2;lang++) for(unsigned stress=0;stress<2;stress++) for(unsigned i=0;i<sizeof screens/sizeof screens[0];i++) {
        reset(stress);COPY(s.voice_language,lang ? "vi" : "en");s.view=screens[i].view;ht_scene_t scene;ht_scene_clear(&scene,BG);
        assert(pro_render_controls(&scene));inspect(&scene,screens[i].name);
        if(s.view==INBOX)assert(s.notice_frame==123&&action_count(A_NOTICE,false)==1);
        if(!stress) {char name[80];snprintf(name,sizeof name,"%s-%s",screens[i].name,lang ? "vi" : "en");portrait(&scene,dir,name);}
    }
    for(unsigned lang=0;lang<2;lang++) for(unsigned sample=0;sample<pro_voice_sample_count();sample++) {
        reset(false);COPY(s.voice_language,lang ? "vi" : "en");s.voice_sample=sample;s.view=VOICE_SAMPLES;ht_scene_t voice;ht_scene_clear(&voice,BG);
        assert(pro_render_controls(&voice));inspect(&voice,"voice sample");
        s.view=VOICE_PARAMS;ht_scene_clear(&voice,BG);assert(pro_render_controls(&voice));inspect(&voice,"voice params");
    }
    for(int support=0;support<2;support++) {
        reset(false);features=support?~0u:0;s.metrics.supported=true;s.view=LAUNCHER;
        ht_scene_t menu;ht_scene_clear(&menu,BG);assert(pro_render_controls(&menu));inspect(&menu,"today entry");
        assert(action_count(A_TODAY,true)==(unsigned)support);
    }
    features=~0u;
    for(int lang=0;lang<2;lang++)for(int state=0;state<9;state++) {
        reset(false);COPY(s.voice_language,lang?"vi":"en");s.view=TODAY;s.metrics.supported=true;
        s.metrics.phase=PRO_METRICS_READY;s.metrics.received=1000;
        pro_metrics_usage_t *u=&s.metrics.usage;
        COPY(u->machine_name,"Studio Mac");COPY(u->day,"2026-10-06");
        u->start=1000000;u->end=87400000;u->generated=4600000;u->as_of=4570000;u->has_cost=true;u->cost=12.34;
        u->providers[0]=(pro_metrics_provider_t){.enabled=true,.priced=true,.state=PRO_SOURCE_OK};
        if(state==0)u->cost=0;
        if(state==1){u->has_cost=false;u->coverage=PRO_METRICS_UNAVAILABLE;u->providers[0]=(pro_metrics_provider_t){0};}
        if(state==2){u->coverage=PRO_METRICS_PARTIAL;u->providers[1]=(pro_metrics_provider_t){.enabled=true,.state=PRO_SOURCE_FAILED};}
        if(state==3){u->stale=true;u->as_of-=600000;}
        if(state==4)s.metrics.phase=PRO_METRICS_WAIT;
        if(state==5)s.metrics.phase=PRO_METRICS_EXPIRED;
        if(state==6)s.metrics.phase=PRO_METRICS_ERROR;
        if(state==7)u->cost=1e9;
        if(state==8)u->cost=0.001;
        ht_scene_t today;ht_scene_clear(&today,BG);assert(pro_render_controls(&today));inspect(&today,"today states");
        if(state==0)assert(has_text(&today,"$0.00"));
        if(state==1)assert(has_text(&today,PRO_TR("Unavailable")) && !has_text(&today,"$0.00"));
        if(state==2)assert(has_text(&today,PRO_TR("Partial coverage")));
        if(state==8)assert(has_text(&today,"<$0.01"));
        assert(action_count(A_TODAY_REFRESH,true)==(unsigned)(state!=4));
        char name[48];snprintf(name,sizeof name,"today-%d-%s",state,lang?"vi":"en");portrait(&today,dir,name);
    }
    const char *engines[]={"claude","codex","opencode","","CLAUDE","claude-extra"};
    for(unsigned engine=0;engine<sizeof engines/sizeof *engines;engine++) for(int review=0;review<2;review++) {
        reset(false);COPY(s.agents[0].engine,engines[engine]);features=review?~0u:0;s.view=WORK_INTENT;
        ht_scene_t work;ht_scene_clear(&work,BG);assert(pro_render_controls(&work));inspect(&work,"instruction capabilities");
        unsigned expected=1+(review&&engine<2)+(review&&engine==0);
        assert(action_count(A_WORK_MODE,true)==expected&&action_count(A_WORK_RECORD,true)==1);
    }
    features=~0u;
    reset(false);s.view=WORK_INTENT;s.connected=false;ht_scene_t missing;ht_scene_clear(&missing,BG);
    assert(pro_render_controls(&missing));inspect(&missing,"instruction offline");assert(!action_count(A_WORK_RECORD,true));
    reset(false);s.view=WORK_INTENT;s.work_mode=PRO_WORK_LOOP;COPY(s.agents[0].engine,"codex");ht_scene_clear(&missing,BG);
    assert(pro_render_controls(&missing));inspect(&missing,"instruction changed engine");assert(!action_count(A_WORK_RECORD,true));
    reset(false);s.view=WORK_INTENT;s.work_mode=PRO_WORK_GOAL;ht_scene_clear(&missing,BG);
    assert(pro_render_controls(&missing));portrait(&missing,dir,"instruction-goal");
    s.view=DRAFT;s.work_voice_mode=PRO_WORK_GOAL;ht_scene_clear(&missing,BG);
    assert(pro_render_controls(&missing));inspect(&missing,"goal draft");portrait(&missing,dir,"goal-draft");
    reset(false);s.view=SETTINGS;s.offset=7;ht_scene_t scene;ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"controls-more");portrait(&scene,dir,"controls-more");
    for(int connected=0;connected<2;connected++) {
        reset(false);s.view=COMPANION;s.connected=connected;ht_scene_clear(&scene,BG);
        assert(pro_render_controls(&scene));inspect(&scene,"companion-docked");
        assert(action_count(A_BRIGHT,true)==1);
        assert(action_count(A_QUIET,true)==1&&action_count(A_NAP,true)==1);
    }
    for(int v=DAEMONS;v<=SCENES;v++)for(unsigned i=0;i<pro_daemon_count();i++)for(int c=0;c<PRO_SCENE_COUNT;c++) {
        reset(false);s.view=(view_t)v;s.preview_character.id=pro_daemon_at(i)->id;s.preview_scene=(pro_scene_id_t)c;
        ht_scene_clear(&scene,BG);assert(pro_render_controls(&scene));inspect(&scene,"appearance");
        assert(action_count(A_APPEAR_USE,true)==1&&action_count(A_LAUNCHER,true)==1);
    }
    reset(false);s.view=INBOX;s.notice_count=0;ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"empty-updates");portrait(&scene,dir,"empty-updates");
    reset(false);s.view=QUESTION;COPY(s.q.speech_error,"Please say your answer again.");ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"question-error");portrait(&scene,dir,"question-error");
    reset(false);s.view=FORM;COPY(form.page.error,"That choice changed. Please choose again.");ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"form-error");portrait(&scene,dir,"form-error");
    reset(false);s.view=ANSWER_REVIEW;s.q.pending=true;ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"answer-pending");
    assert(!action_count(A_ANSWER,true)&&!action_count(A_QUESTION_BACK,true)&&!action_count(A_QUESTION_CLOSE,true));
    for(int language=0;language<2;language++)for(int connected=0;connected<2;connected++)
    for(int state=0;state<3;state++)for(int view=0;view<2;view++) {
        reset(true);COPY(s.voice_language,language?"vi":"en");s.connected=connected;
        s.view=view?ANSWER_REVIEW:QUESTION;s.q.pending=s.q.uncertain=true;s.q.valid=false;
        if(state==1)s.q.item[0].answer[0]=0;
        if(state==2)s.q.count=0;
        ht_scene_clear(&scene,BG);assert(pro_render_controls(&scene));inspect(&scene,"answer-unknown");
        assert(action_count(A_QUESTION_CLOSE,true)==1&&action_count(A_DESKTOP,true)==(unsigned)connected);
        assert(!action_count(A_ANSWER,true)&&!action_count(A_QUESTION_SAY,true)&&!action_count(A_CHOICE,true));
    }
    reset(false);s.view=DRAFT;draft.page.locked=true;ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"draft-uncertain");
    assert(!action_count(A_DRAFT_SEND,true)&&action_count(A_DRAFT_STATE,true)==1);
    portrait(&scene,dir,"draft-uncertain");
    reset(false);s.view=DRAFT;draft.pending=true;ht_scene_clear(&scene,BG);
    assert(pro_render_controls(&scene));inspect(&scene,"draft-pending");
    assert(!action_count(A_DRAFT_SEND,true)&&!action_count(A_DRAFT_OPTIONS,true));
    puts("Pro controls: PASS (real sheets, normal/stress text, glass bounds, text overlap, hit sizes, read receipt, explicit send/stop and pending-delivery guards)");
}
'''

with tempfile.TemporaryDirectory(prefix="harness-pro-controls-") as d:
    build = Path(d)
    (build / "controls.c").write_text(code)
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
        "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-DHT_PANEL_NATIVE=1",
        "-I", str(NATIVE), str(build / "controls.c"), str(NATIVE / "pro_canvas.c"),
        str(FONTS), str(NATIVE / "terminal.c"), str(NATIVE / "fonts.c"),
        str(NATIVE / "workspace.c"), str(NATIVE / "selection.c"),
        str(NATIVE / "pro_daemon.c"), str(NATIVE / "character_motion.c"),
        *voice_assets(build), "-o", str(build / "controls"),
    ], check=True)
    args = [str(build / "controls")]
    if os.environ.get("HABITAT_PRO_PREVIEW_DIR"):
        dest = Path(os.environ["HABITAT_PRO_PREVIEW_DIR"])
        dest.mkdir(parents=True, exist_ok=True)
        args.append(str(dest))
    subprocess.run(args, check=True)
