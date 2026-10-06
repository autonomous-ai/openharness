"""Verify the real Pro registry, common animation state, and production boot restoration."""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent / "main/ui/habitat"
REPO = HERE.parents[3]
roster = json.loads((REPO / "daemons/roster.json").read_text())
expected = [d["id"] for d in roster["daemons"] if d["drop"] == "init"]
assert len(expected) == 10
source = (NATIVE / "ui_habitat.c").read_text()
start = source.index("    memset(&character,", source.index("void ui_init(void)"))
end = source.index('    ESP_LOGI("habitat"', start)
boot = source[start:end]
code = r'''
#include "pro_daemon.h"
#include "pro_visual.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static ht_character_t character;
static ht_character_caption_t home_caption;
static struct { pro_scene_id_t scene_choice; } s;
static uint8_t legacy;
static uint16_t appearance;
static bool stored;
static unsigned visual_inits;
static uint8_t config_load_habitat_character(uint8_t fallback) { return legacy==255?fallback:legacy; }
static uint16_t config_load_pro_appearance(uint16_t fallback) { return stored?appearance:fallback; }
void pro_visual_init(void) { visual_inits++; }
void pro_living_init(void) {}
static ht_character_id_t painted;
void pro_visual_paint(ht_scene_t *scene, ht_character_id_t id, const ht_character_face_t *face,
                      uint8_t frame, ht_character_size_t size, int y) {
    (void)scene;(void)face;(void)frame;(void)size;(void)y;painted=id;
}
void ht_character_layout(ht_scene_t *scene, const ht_character_face_t *face, uint8_t frame,
                         uint16_t ink, const char *recap, ht_character_painter_t paint) {
    (void)recap;paint(scene,face,frame,ink,HT_CHARACTER_FULL,150);
}
'''
code += "static void boot(void) {\n" + boot + "}\n"
code += "static const char *expected[]={" + ",".join(json.dumps(x) for x in expected) + "};\n"
code += r'''
int main(void) {
    assert(HT_CHARACTER_TIM==0&&HT_CHARACTER_TUX==1&&HT_CHARACTER_COUNT==10);
    assert(pro_daemon_count()==10);
    unsigned ids=0;
    for(unsigned i=0;i<pro_daemon_count();i++) {
        const pro_daemon_definition_t *d=pro_daemon_at(i);
        assert(!strcmp(d->key,expected[i])&&d->name[0]);
        assert(!(ids&(1u<<d->id)));ids|=1u<<d->id;
        assert(pro_daemon_index(d->id)==i&&!strcmp(ht_character_name(d->id),d->name));
        assert(pro_scene_resolve(PRO_SCENE_MATCH,d->id)==d->scene);
        assert(pro_scene_resolve((pro_scene_id_t)255,d->id)==d->scene);
        for(int scene=1;scene<PRO_SCENE_COUNT;scene++)assert(pro_scene_resolve((pro_scene_id_t)scene,d->id)==(pro_scene_id_t)scene);
        for(int mood=0;mood<HT_CHARACTER_MOODS;mood++) {
            ht_character_t c={0};assert(ht_character_select(&c,d->id));
            assert(ht_character_tick(&c,1000,(ht_character_mood_t)mood,false,true,false,360,0,0));
            for(unsigned t=1001;t<6500;t+=17) {
                ht_character_tick(&c,t,(ht_character_mood_t)mood,false,true,false,360,0,1);
                assert(c.motion.frame<24&&c.motion.next_ms>=1&&c.motion.next_ms<=1000);
            }
            if(mood==HT_CHARACTER_DONE||mood==HT_CHARACTER_BOOPED)assert(c.motion.frame==23);
            if(mood==HT_CHARACTER_OFFLINE)assert(c.motion.frame==0);
            ht_character_face_t face={.mood=(ht_character_mood_t)mood};
            ht_character_portrait(NULL,&c,&face,0,HT_CHARACTER_FULL,150);assert(painted==d->id);
            ht_character_face(NULL,&c,&face,0,NULL);assert(painted==d->id);
        }
        ht_character_t c={.id=d->id};
        ht_character_tick(&c,UINT32_MAX-20,HT_CHARACTER_WORKING,false,true,false,360,0,0);
        ht_character_tick(&c,100,HT_CHARACTER_WORKING,false,true,false,360,0,0);assert(c.motion.frame==1);
        ht_character_tick(&c,200,HT_CHARACTER_WORKING,true,true,false,360,0,0);assert(!c.motion.frame);
        ht_character_tick(&c,300,HT_CHARACTER_WORKING,true,true,false,360,0,0);assert(!c.motion.frame);
        ht_character_tick(&c,400,HT_CHARACTER_WORKING,false,true,false,360,0,0);
        unsigned paused=c.motion.frame;
        ht_character_tick(&c,600,HT_CHARACTER_WORKING,false,false,false,360,0,0);
        ht_character_tick(&c,1600,HT_CHARACTER_WORKING,false,false,false,360,0,0);
        ht_character_tick(&c,2600,HT_CHARACTER_WORKING,false,true,false,360,0,0);assert(c.motion.frame==paused);
        ht_character_tick(&c,3000,HT_CHARACTER_IDLE,false,true,true,0,0,0);assert(c.motion.reaction.pose.pressed&&c.motion.reaction.pose.look==-2);
        ht_character_tick(&c,3100,HT_CHARACTER_IDLE,false,true,true,720,0,0);assert(c.motion.reaction.pose.look==2);
        ht_character_tick(&c,3500,HT_CHARACTER_LISTENING,false,true,false,360,99,0);assert(c.motion.reaction.pose.level==4);
        c.delivery.sequence=77;c.delivery.initialized=true;
        assert(ht_character_select(&c,pro_daemon_at((i+1)%10)->id));
        assert(!c.motion.initialized&&c.delivery.sequence==77&&c.delivery.initialized);
        ht_character_t before=c;assert(!ht_character_select(&c,(ht_character_id_t)255));assert(!memcmp(&before,&c,sizeof c));
    }
    assert(ids==1023u);
    stored=false;legacy=1;boot();assert(character.id==HT_CHARACTER_TUX&&s.scene_choice==PRO_SCENE_MATCH);
    legacy=255;boot();assert(character.id==ht_character_default()&&s.scene_choice==PRO_SCENE_MATCH);
    legacy=201;boot();assert(character.id==ht_character_default());
    stored=true;
    for(unsigned value=0;value<=UINT16_MAX;value++) {
        appearance=value;home_caption.initialized=true;boot();
        assert(character.id==((value&255)<HT_CHARACTER_COUNT?(value&255):(unsigned)ht_character_default()));
        assert(s.scene_choice==(value>>8<PRO_SCENE_COUNT?value>>8:PRO_SCENE_MATCH));
        assert(!home_caption.initialized);
    }
    assert(visual_inits==65539);
    puts("Pro registry/boot: exact10 init IDs, shared8 moods, finite/quiet/hidden/wrap clocks, painter dispatch, gaze/amplitude, migration and all65536 saved appearances PASS");
}
'''
with tempfile.TemporaryDirectory(prefix="harness-pro-registry-") as directory:
    out = Path(directory)
    (out / "test.c").write_text(code)
    binary = out / "test"
    subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
                    "-fsanitize=" + os.environ.get("SANITIZERS", "undefined,bounds"),
                    "-DDEVICE_PRO_COMPANION=1", "-DHT_FACE_PX=720", "-I", str(NATIVE), str(out / "test.c"),
                    *[str(NATIVE / (name + ".c")) for name in ("character", "character_motion", "pro_daemon")],
                    "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
