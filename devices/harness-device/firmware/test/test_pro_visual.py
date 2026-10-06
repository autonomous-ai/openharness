"""Verify Pro art decodes only on renderer preparation, outside scene assembly.

Uses the actual pro_visual.c, packed art, canvas and font sources under sanitizers.
The host zlib/heap adapters count work so lock-sensitive build paths can be
asserted allocation/decode-free. Independent eager decodes supply pixel oracles.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent / "main/ui/habitat"
GENERATED = HERE.parents[1] / "prototype/pro-companion/generated"

CODE = r'''
#include "pro_visual.h"
#include "pro_art.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <zlib.h>
extern const uint8_t pack_start[] asm("_binary_pro_art_pack_start");
size_t allocations,allocation_bytes,inflates,inflate_bytes;
double inflate_cpu_us;
static uint16_t actual[720*720],expected[720*720],incremental[720*720],strip[720*720];
static unsigned renders;
void *test_allocate(size_t n){allocations++;allocation_bytes+=n;return malloc(n);}
size_t test_inflate(void *dst,size_t cap,const void *src,size_t n){
    clock_t start=clock();uLongf got=cap;int result=uncompress(dst,&got,src,n);
    inflate_cpu_us+=(double)(clock()-start)*1000000.0/CLOCKS_PER_SEC;
    inflates++;inflate_bytes+=got;return result==Z_OK?got:(size_t)-1;
}
static void build(ht_scene_t *s,ht_character_t *c,ht_character_mood_t mood,bool small,bool mail,pro_scene_id_t backdrop){
    size_t old_inflates=inflates,old_allocations=allocations;
    ht_scene_clear(s,ht_rgb(0xf4f2e8));pro_visual_background(s,backdrop,c->id);
    pro_visual_character(s,c,mood,small,small?280:185,small?115:164,1000,false,mail);
    ht_pro_text(s,44,540,632,&ht_pro_32,ht_rgb(0x263b34),"A readable result.");
    assert(inflates==old_inflates&&allocations==old_allocations);
    unsigned roles=0;
    for(unsigned i=0;i<s->count;i++)if(s->runs[i].bitmap.asset){
        const ht_pro_bitmap_t *b=&s->runs[i].bitmap;
        const pro_art_frame_t *a=b->asset;
        assert(!b->pixels&&!b->alpha&&b->width&&b->height&&b->revision);
        assert(a->role<PRO_ART_ROLE_COUNT&&!(roles&(1u<<a->role)));roles|=1u<<a->role;
        ht_rect_t r=ht_run_bounds(&s->runs[i]);assert(r.x>=0&&r.y>=0&&r.x+r.w<=720&&r.y+r.h<=720);
    }
    assert(roles==(mail?63u:31u));
}
static void eager_pixels(const ht_scene_t *s){
    ht_scene_t oracle=*s;void *memory[HT_RUNS]={0};
    for(unsigned i=0;i<oracle.count;i++)if(oracle.runs[i].bitmap.asset){
        ht_pro_bitmap_t *bitmap=&oracle.runs[i].bitmap;
        const pro_art_frame_t *frame=bitmap->asset;
        memory[i]=malloc(frame->raw_length);assert(memory[i]);uLongf got=frame->raw_length;
        assert(uncompress(memory[i],&got,pack_start+frame->offset,frame->length)==Z_OK&&got==frame->raw_length);
        if(frame->base_length){
            uint8_t *base=malloc(frame->raw_length);assert(base);uLongf n=frame->raw_length;
            assert(uncompress(base,&n,pack_start+frame->base_offset,frame->base_length)==Z_OK&&n==frame->raw_length);
            for(size_t j=0;j<n;j++)((uint8_t*)memory[i])[j]^=base[j];
            free(base);
        }
        bitmap->pixels=memory[i];bitmap->alpha=frame->alpha?(const uint8_t*)memory[i]+frame->width*frame->height*2:NULL;
        bitmap->asset=NULL;
    }
    ht_raster(&oracle,(ht_rect_t){0,0,720,720},expected);
    for(unsigned i=0;i<oracle.count;i++)free(memory[i]);
}
static void pixel_check(const ht_scene_t *s){
    ht_raster(s,(ht_rect_t){0,0,720,720},actual);eager_pixels(s);
    assert(!memcmp(actual,expected,sizeof actual));renders++;
}
static void partial_check(const ht_scene_t *old,const ht_scene_t *next){
    ht_damage_t damage;ht_damage(old,next,&damage);
    for(unsigned i=0;i<damage.count;i++){
        ht_rect_t r=damage.rect[i];ht_raster(next,r,strip);
        for(int y=0;y<r.h;y++)memcpy(incremental+(r.y+y)*720+r.x,strip+y*r.w,(size_t)r.w*2);
    }
    ht_raster(next,(ht_rect_t){0,0,720,720},actual);
    assert(!memcmp(actual,incremental,sizeof actual));
}
static void transition(ht_scene_t *first,ht_character_t *c,int mood,bool small,bool mail,pro_scene_id_t backdrop){
    ht_scene_t next,saved=*first;size_t before=inflates;
    build(&next,c,(ht_character_mood_t)mood,small,mail,backdrop);
    assert(!memcmp(first,&saved,sizeof saved));
    ht_raster(first,(ht_rect_t){0,0,720,720},actual);
    assert(!memcmp(actual,incremental,sizeof actual)&&inflates==before);
    pro_visual_prepare(&next);assert(allocations==PRO_ART_ROLE_COUNT);
    pixel_check(&next);partial_check(first,&next);*first=next;
}
static void clock_checks(void){
    size_t before=inflates,allocated=allocations;unsigned transitions=0;
    ht_scene_t scene;
    for(unsigned id=0;id<pro_daemon_count();id++)for(int mood=0;mood<8;mood++){
        ht_character_t c={.id=pro_daemon_at(id)->id};
        ht_character_tick(&c,1000,(ht_character_mood_t)mood,false,true,false,360,3,0);
        ht_scene_clear(&scene,0);pro_visual_character(&scene,&c,(ht_character_mood_t)mood,false,185,164,1000,false,false);
        uint32_t wake=pro_visual_next_wake_ms(&c,(ht_character_mood_t)mood,1000,false,false);
        for(uint32_t age=1;age<=6500;age++){
            ht_character_tick(&c,1000+age,(ht_character_mood_t)mood,false,true,false,360,3,0);
            bool changed=pro_visual_changed(&c,(ht_character_mood_t)mood,1000+age,false,false);
            assert(c.motion.frame<24);
            if(age<wake)assert(!changed);
            if(age==wake){
                if(changed){ht_scene_clear(&scene,0);pro_visual_character(&scene,&c,(ht_character_mood_t)mood,false,185,164,1000+age,false,false);transitions++;}
                uint32_t delay=pro_visual_next_wake_ms(&c,(ht_character_mood_t)mood,1000+age,false,false);
                assert(delay>=1&&delay<=1000);wake=age+delay;
            }
        }
        if(mood==HT_CHARACTER_DONE||mood==HT_CHARACTER_BOOPED)assert(c.motion.frame==23);
        if(mood==HT_CHARACTER_OFFLINE)assert(!c.motion.frame);
    }
    assert(inflates==before&&allocations==allocated);
    printf("Shared Pro motion: 520000 millisecond transitions, %u rendered changes; no early bitmap changes or decode/allocation in queries PASS\n",transitions);
}
int main(void){
    ht_character_t character={0};ht_scene_t first,next;
    size_t budget=0;for(unsigned i=0;i<PRO_ART_ROLE_COUNT;i++)budget+=pro_art_cache_bytes[i];
    pro_visual_init();assert(allocations==PRO_ART_ROLE_COUNT&&allocation_bytes==budget);
    pro_visual_init();assert(allocations==PRO_ART_ROLE_COUNT&&!inflates);
    build(&first,&character,HT_CHARACTER_IDLE,false,true,PRO_SCENE_MATCH);assert(!inflates);
    pro_visual_prepare(&first);pixel_check(&first);memcpy(incremental,actual,sizeof actual);
    size_t before=inflates;pro_visual_prepare(&first);assert(inflates==before);
    build(&next,&character,HT_CHARACTER_IDLE,false,true,PRO_SCENE_MATCH);pro_visual_prepare(&next);
    ht_damage_t damage;ht_damage(&first,&next,&damage);assert(!damage.count&&inflates==before);
    for(unsigned id=0;id<pro_daemon_count();id++)for(int small=0;small<2;small++)for(int mood=0;mood<8;mood++)for(unsigned frame=0;frame<24;frame++){
        character.id=pro_daemon_at(id)->id;character.motion.frame=frame;
        character.motion.reaction.pose=(ht_character_pose_t){.level=frame%5,.emotion=frame%8,.blink=frame==13};
        character.delivery.moving=frame%3==0;character.delivery.lift=frame%2;
        transition(&first,&character,mood,small,frame%2,PRO_SCENE_MATCH);
    }
    for(unsigned id=0;id<pro_daemon_count();id++)for(int small=0;small<2;small++){
        character.id=pro_daemon_at(id)->id;character.motion.frame=0;
        for(int look=-2;look<=2;look++){
            character.motion.reaction.pose=(ht_character_pose_t){.pressed=true,.look=look};
            transition(&first,&character,HT_CHARACTER_BOOPED,small,false,PRO_SCENE_PAPER);
        }
        for(int emotion=0;emotion<8;emotion++)for(int level=0;level<5;level++){
            character.motion.reaction.pose=(ht_character_pose_t){.emotion=emotion,.level=level};
            transition(&first,&character,HT_CHARACTER_LISTENING,small,false,PRO_SCENE_PAPER);
            const pro_art_frame_t *expected=&pro_art_daemons[id].speech[small][emotion][level];
            const ht_pro_bitmap_t *face=&first.runs[4].bitmap;
            assert(face->revision==expected->offset+1&&face->width==expected->width&&face->height==expected->height);
        }
        for(int scene=0;scene<PRO_SCENE_COUNT;scene++)transition(&first,&character,HT_CHARACTER_IDLE,small,true,(pro_scene_id_t)scene);
    }
    uint16_t raw[]={0xf800,0x07e0,0x001f,0xffff};
    ht_pro_bitmap_t bitmap={.pixels=raw,.width=2,.height=2,.revision=9};
    ht_scene_clear(&next,0);assert(ht_pro_image(&next,0,0,&bitmap));ht_scene_t saved=next;before=inflates;
    pro_visual_prepare(&next);assert(inflates==before&&!memcmp(&next,&saved,sizeof next));
    clock_checks();
    printf("Layered Pro art: %u scenes, all10 daemons/8 moods/2 sizes, speech/gaze/scenes; eager and incremental pixels PASS; %zu fixedbytes, %zu inflates (host mean %.1fus)\n",renders,allocation_bytes,inflates,inflate_cpu_us/inflates);
}

'''


def main():
    with tempfile.TemporaryDirectory(prefix="harness-pro-visual-") as directory:
        out=Path(directory)
        (out/"test.c").write_text(CODE)
        (out/"esp_heap_caps.h").write_text("#pragma once\n#include <stddef.h>\n#define MALLOC_CAP_SPIRAM 1\n#define MALLOC_CAP_8BIT 2\nvoid *test_allocate(size_t);\nstatic inline void *heap_caps_malloc(size_t n,unsigned flags){(void)flags;return test_allocate(n);}\n")
        (out/"esp_log.h").write_text("#pragma once\n#define ESP_LOGI(...) ((void)0)\n")
        (out/"miniz.h").write_text("#pragma once\n#include <stddef.h>\n#define TINFL_FLAG_PARSE_ZLIB_HEADER 1\nsize_t test_inflate(void*,size_t,const void*,size_t);\nstatic inline size_t tinfl_decompress_mem_to_mem(void *d,size_t c,const void *s,size_t n,int f){(void)f;return test_inflate(d,c,s,n);}\n")
        pack=str((GENERATED/"pro_art.pack").resolve()).replace("\\","\\\\").replace('"','\\"')
        (out/"art.S").write_text('#ifdef __APPLE__\n.section __DATA,__const\n#else\n.section .rodata\n#endif\n.balign 8\n.globl _binary_pro_art_pack_start\n_binary_pro_art_pack_start:\n.incbin "'+pack+'"\n.globl _binary_pro_art_pack_end\n_binary_pro_art_pack_end:\n')
        binary=out/"test"
        subprocess.run([os.environ.get("CC","cc"),"-std=gnu11","-O1","-g","-Wall","-Wextra","-Werror",
                        "-fsanitize="+os.environ.get("SANITIZERS","address,undefined,bounds"),"-fno-omit-frame-pointer",
                        "-DHT_FACE_PX=720","-DDEVICE_PRO_COMPANION=1","-I",str(out),"-I",str(NATIVE),"-I",str(GENERATED),
                        str(out/"test.c"),str(out/"art.S"),*[str(NATIVE/(name+".c")) for name in ("pro_visual","pro_daemon","character","character_motion","character_layout","pro_canvas","terminal","fonts")],
                        str(GENERATED/"pro_fonts.c"),"-lz","-o",str(binary)],check=True)
        env=dict(os.environ)
        env.setdefault("ASAN_OPTIONS",("detect_leaks=0:" if sys.platform=="darwin" else "detect_leaks=1:")+"abort_on_error=1")
        env.setdefault("UBSAN_OPTIONS","halt_on_error=1:print_stacktrace=1")
        subprocess.run([str(binary)],env=env,check=True)


if __name__=="__main__":
    main()
