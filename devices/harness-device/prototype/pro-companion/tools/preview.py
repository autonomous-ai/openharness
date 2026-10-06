#!/usr/bin/env python3
"""Render actual Pro firmware scenes and art on the host, pixel for pixel.

Platform allocation and zlib decoding are adapted; audio is unavailable. Layouts, typography,
RGB565 blending, character selection, and the illustrated asset pack are the
production sources. Fixture state supplies illustrative desktop content.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DEVICE = ROOT.parents[1]
NATIVE = DEVICE / "firmware/main/ui/habitat"
GENERATED = ROOT / "generated"
OUT = GENERATED / "preview"
sys.path.insert(0, str(DEVICE / "firmware/test"))
from native_shapes import defines, typedef  # noqa: E402
from native_voice import voice_assets  # noqa: E402

STATES = ("idle", "idle_paper", "working", "summary", "summary_paper", "mail", "needs_answer", "listening",
          "voice_preparing", "voice_sending", "offline", "done", "asleep",
          "carrying", "launcher", "companion", "daemons", "scenes", "updates", "question", "reader", "locked", "updating",
          "carry_listening", "carry_review", "carry_preview", "carry_rejected", "carry_offline", "carry_preview_offline",
          "carry_offline_long", "carry_offline_scrolled",
          "panes_map", "panes_list", "panes_dense", "panes_mixed", "panes_waiting",
          "instruction", "goal", "loop", "goal_listening", "loop_listening", "goal_review", "loop_review",
          "today", "today_zero", "today_missing", "today_partial", "today_stale", "today_loading", "today_expired",
          "speech_pending", "speaking_warm",
          "speaking_happy", "speaking_excited", "speaking_gentle", "speaking_sad",
          "speaking_thoughtful", "speaking_curious", "speaking_angry")


def function(name, source):
    match = re.search(r"^[^\n]*\b" + re.escape(name) + r"\([^;]*?\)\n\{.*?^\}", source, re.M | re.S)
    assert match, f"Production function missing: {name}"
    return match.group(0) + "\n"


def native_source():
    source = (NATIVE / "ui_habitat.c").read_text()
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
#include "pro_metrics.h"
#include "../../pro_voice_samples.h"
#include "../../audio_speech.h"
#include "pro_visual.h"
#include "theme.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define COPY(dst, src) snprintf(dst,sizeof(dst),"%s",src)
'''
    code += defines("CABLE_READ_TOKEN_MAX", "ID_MAX", "CABLE_NAME_MAX", "SWARM_ID_MAX", "SWARMS_MAX",
                    "SWARM_TILES_MAX", "CABLE_MAX_AGENTS", "MAX_PROJECTS")
    code += defines("NOTICES", "QUESTION_MAX", "OPTION_MAX", "PANE_MEMORY_MAX", "PANE_RESULT_BYTES", source=source)
    code += "\n".join(re.findall(r"^#define TAB_\w+ \d+$", source, re.M)) + "\n"
    for name in ("cable_swarm_t", "cable_notif_t", "cable_tile_t", "model_item_t"):
        code += typedef(name)
    code += source[source.index("typedef enum {"):source.index("static QueueHandle_t actions;")]
    code += r'''
static ht_tab_carousel_t tab_carousel;
static ht_selection_t selection;
static ht_carry_t carry;
static ht_visit_t visit;
static ht_form_t form;
static ht_draft_t draft;
static ht_character_t character;
static bool recording;
static uint32_t now=1000;
// The real audition catalog is linked, but a preview never opens audio devices.
bool audio_speech_available(void) { return false; }
bool audio_speech_begin(uint32_t id,uint32_t rate,uint8_t volume) { (void)id;(void)rate;(void)volume;return false; }
bool audio_speech_push(uint32_t id,uint32_t offset,const void *pcm,size_t bytes) { (void)id;(void)offset;(void)pcm;(void)bytes;return false; }
bool audio_speech_end(uint32_t id,uint32_t bytes) { (void)id;(void)bytes;return false; }
bool audio_speech_set_volume(uint32_t id,uint8_t volume) { (void)id;(void)volume;return false; }
void audio_speech_snapshot(audio_speech_state_t *out) { memset(out,0,sizeof *out); }
void audio_speech_abort(uint32_t id) { (void)id; }
static uint32_t ms(void) { return now; }
static bool audio_client_recording(void) { return recording; }
static bool audio_client_active(void) { return recording; }
static bool display_is_asleep(void) { return false; }
static bool cable_client_supports(uint32_t feature) { (void)feature; return true; }
'''
    for name in ("find", "active", "waiting", "working", "is_question", "notice_unread", "color",
                 "character_mood", "question_view", "settings_item", "settings_count",
                 "pro_speech_allowed", "pro_speech_visible", "pro_speech_emotion", "pro_surface_mood"):
        code += function(name, source)
    code += r'''
#define BG color(HT_THEME_CANVAS)
#define FG color(HT_THEME_TEXT)
#define DIM color(HT_THEME_SECONDARY)
#define ACCENT color(HT_THEME_ACCENT)
#define ERROR color(HT_THEME_ERROR)
#define SEL color(HT_THEME_SELECTION)
'''
    code += (NATIVE / "pro_controls.inc").read_text()
    code += (NATIVE / "pro_home.inc").read_text()
    code += function("render_lock", source) + function("render_brand", source)
    code += r'''
static ht_scene_t scene;
static uint16_t pixels[720*720];
static void reset(void) {
    memset(&s,0,sizeof s); memset(&character,0,sizeof character); recording=false;
    s.ready=s.connected=true;s.view=HOME;s.count=3;s.active=0;s.pressed=-1;s.brightness=86;
    COPY(s.agents[0].id,"design");COPY(s.agents[0].name,"Design");
    COPY(s.agents[0].engine,"claude");COPY(s.work_agent,"design");
    s.metrics.supported=true;COPY(s.metrics.machine,"local");
    COPY(s.agents[1].id,"build");COPY(s.agents[1].name,"Build");
    COPY(s.agents[2].id,"research");COPY(s.agents[2].name,"Research");
    s.tab_count=1;COPY(s.selected_tab,"studio");COPY(s.tabs[0].id,"studio");
    COPY(s.tabs[0].name,"Your creative studio");
    COPY(s.voice_target,"Design");s.voice_return=HOME;
    COPY(s.agents[0].preview,"Your new layouts are ready. Six directions, saved on your Mac. Take a look when you're ready.");
    COPY(s.agents[0].full,"Your new layouts are ready. Six directions, saved on your Mac.\n\nThe companion stays with you while you work. A tap starts voice, a horizontal swipe changes panes, and a vertical swipe scrolls the desktop.\n\nThe landscape gives Tim a place to live, with clear text whenever there is something to read.");
    COPY(s.notice[0].agent_id,"design");COPY(s.notice[0].name,"Design");
    COPY(s.notice[0].summary,"Your new layouts are ready. Six directions, saved on your Mac. Take a look when you're ready.");
    s.notice[0].display_revision=1;
    COPY(s.q.agent,"design");COPY(s.q.name,"Design");s.q.valid=s.q.supported=true;s.q.count=1;
    COPY(s.q.item[0].prompt,"Which direction should we develop next? The quiet landscape keeps Tim close, while the paper layout gives longer updates more room.");
    s.q.item[0].can_text=true;s.q.item[0].count=2;
    COPY(s.q.item[0].options[0],"Keep the landscape");COPY(s.q.item[0].options[1],"Try the paper layout");
}
static void fixture(const char *name) {
    reset();
    if(!strcmp(name,"idle_paper")){s.scene_choice=PRO_SCENE_PAPER;}
    else if(!strcmp(name,"summary_paper")){s.scene_choice=PRO_SCENE_PAPER;s.agents[0].recap_ready=true;}
    else if(!strcmp(name,"working")){s.agents[0].busy=true;COPY(s.agents[0].tool,"Refining your next idea");}
    else if(!strcmp(name,"summary")){s.agents[0].recap_ready=true;}
    else if(!strcmp(name,"mail")){s.notice_count=1;}
    else if(!strcmp(name,"needs_answer")){s.notice_count=1;s.notice[0].question=true;}
    else if(!strcmp(name,"listening")){s.view=VOICE;s.voice_open=recording=true;character.motion.reaction.pose.level=3;}
    else if(!strcmp(name,"voice_preparing")){s.view=VOICE;s.voice_open=s.voice_start_pending=true;}
    else if(!strcmp(name,"voice_sending")){s.view=VOICE;s.voice_open=s.voice_waiting=true;}
    else if(!strcmp(name,"speech_pending") || !strncmp(name,"speaking_",9)){
        s.speech.id=23;COPY(s.speech.agent,"design");s.agents[0].recap_ready=true;
        s.speech.pending=!strcmp(name,"speech_pending");s.speech.playing=!s.speech.pending;
        s.speech.level=s.speech.playing?3:0;
        s.speech.emotion=pro_speech_emotion(s.speech.playing?name+9:"warm");
        COPY(s.speech.caption,"Your new layout is ready. I kept the landscape quiet and gave the words more room. Take a look when you're ready.");
    }
    else if(!strcmp(name,"offline")){s.connected=false;}
    else if(!strcmp(name,"done")){s.pet_pose=3;s.notice_count=1;character.delivery.moving=true;}
    else if(!strcmp(name,"asleep")){s.nap=true;}
    else if(!strcmp(name,"carrying")){carry.active=true;carry.rows=4;COPY(carry.source,"Research");COPY(carry.excerpt,"Keep the landscape quiet. Give the creature room to breathe, and let clear words lead whenever there is something to read.");}
    else if(!strncmp(name,"carry_",6)){
        carry=(ht_carry_t){.active=true,.rows=4,.id="carry-original",.source="Research",.excerpt="Keep the landscape quiet. Give the creature room to breathe, and let clear words lead whenever there is something to read."};
        pro_carry_review_begin(&s.carry_review,&carry,"design","Design");
        if(!strcmp(name,"carry_listening")) {
            s.view=VOICE;s.voice_open=s.voice_carry=s.voice_review=recording=true;s.voice_return=HOME;
        } else {
            s.view=DRAFT;COPY(s.carry_review.draft,"carry-draft");
            draft.page=(ht_draft_page_t){.active=true,.can_send=true,.revision=1,.position=1,.total=1,.agent="design",.name="Design",.id="carry-draft"};
            COPY(draft.page.text,"Use this direction to refine the home screen. Keep the character expressive and the controls quiet.");
            if(!strcmp(name,"carry_rejected")) {draft.failed=true;COPY(draft.page.error,"Recipient unavailable. Your message is still here.");}
            if(strstr(name,"offline")) {s.connected=false;s.carry_review.detached=true;draft.failed=draft.page.locked=true;draft.page.can_send=false;COPY(draft.page.error,"Connection ended. Check the desktop before starting again.");}
            if(!strcmp(name,"carry_offline_long") || !strcmp(name,"carry_offline_scrolled")) {
                COPY(draft.page.text,"Keep the home screen calm.\nLet the character breathe.\nKeep one tap for speaking.\nMake every gesture deliberate.\nGive the words room to read.\nKeep the recipient visible.\nPreserve the selected passage.\nReview the words before sending.\nKeep the context through edits.\nHold the place while reading.\nMake uncertain delivery clear.\nNever send the message twice.");
                if(!strcmp(name,"carry_offline_scrolled"))s.offset=6;
            }
            if(!strncmp(name,"carry_preview",13))s.view=CARRY_PREVIEW;
        }
    }
    else if(!strcmp(name,"launcher")){s.view=LAUNCHER;}
    else if(!strncmp(name,"today",5)){
        s.view=TODAY;s.metrics.phase=PRO_METRICS_READY;s.metrics.received=now;
        pro_metrics_usage_t *u=&s.metrics.usage;
        COPY(u->machine_name,"Studio Mac");COPY(u->day,"2026-10-06");
        u->start=1000000;u->end=87400000;u->generated=4600000;u->as_of=4570000;u->has_cost=true;u->cost=12.34;
        u->providers[0]=(pro_metrics_provider_t){.enabled=true,.priced=true,.state=PRO_SOURCE_OK};
        if(!strcmp(name,"today_zero"))u->cost=0;
        if(!strcmp(name,"today_missing")){u->has_cost=false;u->coverage=PRO_METRICS_UNAVAILABLE;u->providers[0]=(pro_metrics_provider_t){0};}
        if(!strcmp(name,"today_partial")){u->coverage=PRO_METRICS_PARTIAL;u->providers[1]=(pro_metrics_provider_t){.enabled=true,.state=PRO_SOURCE_FAILED};}
        if(!strcmp(name,"today_stale")){u->stale=true;u->as_of-=600000;}
        if(!strcmp(name,"today_loading"))s.metrics.phase=PRO_METRICS_WAIT;
        if(!strcmp(name,"today_expired"))s.metrics.phase=PRO_METRICS_EXPIRED;
    }
    else if(!strcmp(name,"instruction") || !strcmp(name,"goal") || !strcmp(name,"loop")){
        s.view=WORK_INTENT;s.work_mode=!strcmp(name,"goal")?PRO_WORK_GOAL:!strcmp(name,"loop")?PRO_WORK_LOOP:PRO_WORK_TASK;
    }
    else if(!strcmp(name,"goal_listening") || !strcmp(name,"loop_listening")){
        s.view=VOICE;s.voice_open=s.voice_review=recording=true;s.voice_return=WORK_INTENT;
        s.work_voice_mode=!strcmp(name,"goal_listening")?PRO_WORK_GOAL:PRO_WORK_LOOP;
    }
    else if(!strcmp(name,"goal_review") || !strcmp(name,"loop_review")){
        s.view=DRAFT;s.work_voice_mode=!strcmp(name,"goal_review")?PRO_WORK_GOAL:PRO_WORK_LOOP;
        draft.page=(ht_draft_page_t){.active=true,.can_send=true,.revision=1,.position=1,.total=1,.agent="design",.name="Design",.id="example"};
        COPY(draft.page.text,s.work_voice_mode==PRO_WORK_GOAL?
            "Make the new layout readable and accessible. Keep working until the contrast and touch checks pass.":
            "Every 30 minutes, check the build and tell me if a new failure needs my attention.");
    }
    else if(!strncmp(name,"panes_",6)){
        s.view=AGENTS;s.pro_agent_layout=!strcmp(name,"panes_list")?1:2;
        COPY(s.tile_tab,s.selected_tab);s.tile_count=3;
        s.tiles[0]=(cable_tile_t){.x1=0,.y1=0,.x2=550,.y2=1000,.agent_id="design"};
        s.tiles[1]=(cable_tile_t){.x1=550,.y1=0,.x2=1000,.y2=500,.agent_id="build"};
        s.tiles[2]=(cable_tile_t){.x1=550,.y1=500,.x2=1000,.y2=1000,.agent_id="research"};
        s.agents[1].busy=true;s.agents[2].recap_ready=true;
        if(!strcmp(name,"panes_dense")){
            s.tile_count=24;
            for(int i=0;i<24;i++){
                s.tiles[i]=(cable_tile_t){.x1=i%6*1000/6,.x2=(i%6+1)*1000/6,.y1=i/6*250,.y2=(i/6+1)*250};
                COPY(s.tiles[i].agent_id,s.agents[i%3].id);
            }
        }
        if(!strcmp(name,"panes_mixed")){s.tiles[1].agent_id[0]=0;COPY(s.tiles[2].agent_id,"not-in-roster");}
        if(!strcmp(name,"panes_waiting")){COPY(s.tile_tab,"previous-tab");}
    }
    else if(!strcmp(name,"companion")){s.view=COMPANION;}
    else if(!strcmp(name,"daemons")){s.view=DAEMONS;s.preview_character.id=HT_CHARACTER_TUX;}
    else if(!strcmp(name,"scenes")){s.view=SCENES;s.preview_scene=PRO_SCENE_SHORE;}
    else if(!strcmp(name,"updates")){s.view=INBOX;s.notice_count=1;}
    else if(!strcmp(name,"question")){s.view=QUESTION;s.notice_count=1;s.notice[0].question=true;}
    else if(!strcmp(name,"reader")){s.view=READER;s.agents[0].recap_ready=true;}
    else if(!strcmp(name,"locked")){s.locked=true;s.pattern_mask=7;}
    else if(!strcmp(name,"updating")){s.view=OTA;}
    else assert(!strcmp(name,"idle"));
}
static void render(void) {
    s.hit_count=0;ht_scene_clear(&scene,BG);
    ht_character_tick(&character,now,pro_surface_mood(),s.quiet,true,false,360,recording?3:0,0);
    ht_character_tick(&s.preview_character,now,HT_CHARACTER_IDLE,s.quiet,true,false,360,0,0);
    if(s.locked)render_lock(&scene);
    else if(s.view==OTA)render_brand(&scene);
    else if(s.view==VOICE)pro_render_voice(&scene);
    else if(s.view==HOME)pro_render_home(&scene);
    else assert(pro_render_controls(&scene));
    assert(scene.count<HT_RUNS && s.hit_count<=24);
    for(unsigned i=0;i<scene.count;i++) {
        const ht_run_t *r=&scene.runs[i];ht_rect_t a=ht_run_bounds(r);
        assert(a.x>=0&&a.y>=0&&a.x+a.w<=720&&a.y+a.h<=720);
        if(r->pro_kind!=1||!r->text[0])continue;
        for(unsigned j=i+1;j<scene.count;j++) {
            const ht_run_t *other=&scene.runs[j];
            if(other->pro_kind!=1||!other->text[0])continue;
            ht_rect_t b=ht_run_bounds(other);
            if(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h) {
                fprintf(stderr,"Preview text overlap: [%s] with [%s]\n",r->text,other->text);abort();
            }
        }
    }
    pro_visual_prepare(&scene);
    ht_raster(&scene,(ht_rect_t){0,0,720,720},pixels);
}
static void quoted(FILE *f,const char *text) {
    fputc('"',f);
    for(const unsigned char *p=(const unsigned char*)text;*p;p++) {
        if(*p=='"'||*p=='\\')fprintf(f,"\\%c",*p);
        else if(*p<32)fprintf(f,"\\u%04x",*p);
        else fputc(*p,f);
    }
    fputc('"',f);
}
static void save(const char *base) {
    char path[2048];snprintf(path,sizeof path,"%s.ppm",base);
    FILE *f=fopen(path,"wb");assert(f);fprintf(f,"P6\n720 720\n255\n");
    for(size_t i=0;i<720*720;i++) {
        uint16_t p=pixels[i];unsigned char rgb[3]={(p>>11)*255/31,((p>>5)&63)*255/63,(p&31)*255/31};
        assert(fwrite(rgb,1,3,f)==3);
    }
    fclose(f);snprintf(path,sizeof path,"%s.json",base);f=fopen(path,"w");assert(f);
    fprintf(f,"{\"runs\":[");
    for(unsigned i=0;i<scene.count;i++) {
        ht_run_t *r=&scene.runs[i];
        fprintf(f,"%s{\"kind\":%u,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"text\":",i?",":"",r->pro_kind,r->x,r->y,r->w,r->pro_height);
        quoted(f,r->text);fputc('}',f);
    }
    fprintf(f,"],\"hits\":[");
    for(int i=0;i<s.hit_count;i++) {
        hit_t *h=&s.hits[i];fprintf(f,"%s{\"action\":%u,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"enabled\":%s}",i?",":"",h->action,h->rect.x,h->rect.y,h->rect.w,h->rect.h,h->enabled?"true":"false");
    }
    fprintf(f,"]}\n");fclose(f);
}
int main(int argc,char **argv) {
    assert(argc==4);fixture(argv[1]);pro_visual_init();render();
    int frames=atoi(argv[3]);
    if(frames<=1){now+=480;render();save(argv[2]);}
    else for(int i=0;i<frames;i++) {
        now=1000+i*120;
        if(recording)character.motion.reaction.pose.level=(i/2)%5;
        render();char base[2048];snprintf(base,sizeof base,"%s-%02d",argv[2],i);save(base);
    }
    return 0;
}
'''
    return code


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", choices=STATES, action="append", help="Render only these fixture states")
    parser.add_argument("--animate", action="store_true", help="Also export idle, listening and delivery GIFs")
    args=parser.parse_args()
    states=args.state or STATES
    OUT.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="harness-pro-preview-") as directory:
        temp=Path(directory)
        (temp/"preview.c").write_text(native_source())
        (temp/"esp_heap_caps.h").write_text("#pragma once\n#include <stdlib.h>\n#define MALLOC_CAP_SPIRAM 1\n#define MALLOC_CAP_8BIT 2\nstatic inline void *heap_caps_malloc(size_t n,unsigned caps){(void)caps;return malloc(n);}\n")
        (temp/"esp_log.h").write_text("#pragma once\n#define ESP_LOGI(...) ((void)0)\n")
        (temp/"miniz.h").write_text("#pragma once\n#include <stddef.h>\n#include <zlib.h>\n#define TINFL_FLAG_PARSE_ZLIB_HEADER 1\nstatic inline size_t tinfl_decompress_mem_to_mem(void *dst,size_t cap,const void *src,size_t n,int flags){(void)flags;uLongf got=cap;return uncompress(dst,&got,src,n)==Z_OK?got:(size_t)-1;}\n")
        pack=str((GENERATED/"pro_art.pack").resolve()).replace("\\","\\\\").replace('"','\\"')
        (temp/"art.S").write_text('#ifdef __APPLE__\n.section __DATA,__const\n#else\n.section .rodata\n#endif\n.balign 8\n.globl _binary_pro_art_pack_start\n_binary_pro_art_pack_start:\n.incbin "'+pack+'"\n.globl _binary_pro_art_pack_end\n_binary_pro_art_pack_end:\n')
        executable=temp/"preview"
        command=[os.environ.get("CC","cc"),"-std=gnu11","-O1","-g","-Wall","-Wextra","-Werror",
                 "-Wno-unused-function","-Wno-unused-variable","-fsanitize=address,undefined,bounds",
                 "-DHT_FACE_PX=720","-DDEVICE_PRO_COMPANION=1","-DHT_PANEL_NATIVE=1","-I",str(temp),"-I",str(NATIVE),"-I",str(GENERATED),
                 str(temp/"preview.c"),str(temp/"art.S"),*[str(NATIVE/(name+".c")) for name in ("pro_visual","pro_daemon","character","character_motion","character_layout","pro_canvas","terminal","fonts","workspace","selection")],
                 str(GENERATED/"pro_fonts.c"),*voice_assets(temp),"-lz","-o",str(executable)]
        subprocess.run(command,check=True)
        env=dict(os.environ);env.setdefault("ASAN_OPTIONS",("detect_leaks=0:" if sys.platform=="darwin" else "detect_leaks=1:")+"abort_on_error=1")
        env.setdefault("UBSAN_OPTIONS","halt_on_error=1:print_stacktrace=1")
        for state in states:
            target=temp/state
            subprocess.run([str(executable),state,str(target),"1"],check=True,env=env)
            Image.open(target.with_suffix(".ppm")).save(OUT/(state+".png"))
            (OUT/(state+".json")).write_text(target.with_suffix(".json").read_text())
        if args.animate:
            for state in ("idle","listening","done"):
                target=temp/state
                subprocess.run([str(executable),state,str(target),"24"],check=True,env=env)
                frames=[Image.open(temp/f"{state}-{i:02d}.ppm").resize((540,540),Image.Resampling.LANCZOS) for i in range(24)]
                frames[0].save(OUT/(state+".gif"),save_all=True,append_images=frames[1:],duration=120,loop=0,disposal=2)

    columns=4;rows=(len(states)+columns-1)//columns
    sheet=Image.new("RGB",(columns*360,rows*396),"#f4f2e8");draw=ImageDraw.Draw(sheet)
    try: font=ImageFont.truetype("/System/Library/Fonts/Menlo.ttc",18)
    except OSError: font=ImageFont.load_default()
    for index,state in enumerate(states):
        x,y=(index%columns)*360,(index//columns)*396
        sheet.paste(Image.open(OUT/(state+".png")).resize((360,360),Image.Resampling.LANCZOS),(x,y))
        draw.text((x+12,y+368),state.replace("_"," "),font=font,fill="#263b34")
    sheet.save(OUT/"contact-sheet.png")
    inputs=[NATIVE/name for name in ("ui_habitat.c","pro_home.inc","pro_controls.inc","pro_work_intent.h","pro_carry_review.h","pro_draft_recovery.h","../../pro_recovery_bookmark.h","pro_metrics.h","pro_metrics.c","pro_canvas.c","pro_visual.c","terminal.c")]
    inputs += [GENERATED/"pro_fonts.c",GENERATED/"pro_art.pack"]
    manifest={"description":"Actual production firmware renderer with illustrative state fixtures; RGB565 expanded to PNG.","states":list(states),
              "source_sha256":{str(path.relative_to(DEVICE)):hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}}
    (OUT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    cards="".join(f'<figure><img src="{state}.png" alt="{state}"><figcaption>{state.replace("_"," ")}</figcaption></figure>' for state in states)
    (OUT/"index.html").write_text('<!doctype html><meta charset="utf-8"><title>Pro companion · actual firmware previews</title><style>body{background:#e6e8dc;color:#263b34;font:18px system-ui;margin:32px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}figure{margin:0}img{width:100%;border-radius:20px}figcaption{padding:10px}h1{font-weight:500}</style><h1>Pro companion</h1><p>Actual firmware pixels. Illustrative app content.</p><main>'+cards+'</main>')
    print(json.dumps({"output":str(OUT),"states":len(states),"renderer":"production","sanitizers":"address,undefined,bounds"}))


if __name__=="__main__":
    main()
