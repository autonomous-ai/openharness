#include "../main/ui/habitat/octopus.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
static ht_scene_t a,b;
static uint32_t seed=0x741bc;
static unsigned next(void) {seed=seed*1664525u+1013904223u;return seed;}
static void identical(void) {
    assert(a.count==b.count&&a.background==b.background);
    assert(!memcmp(a.runs,b.runs,a.count*sizeof *a.runs));
}
int main(void) {
    const ht_font_t *fonts[]={&ht_octopus_font_2,&ht_octopus_font_4,&ht_octopus_font_6,
        &ht_octopus_font_8,&ht_octopus_font_10,&ht_mono_20};
    size_t page=(size_t)sysconf(_SC_PAGESIZE);
    char *map=mmap(NULL,page*3,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);
    assert(map!=MAP_FAILED&&!mprotect(map+page,page,PROT_READ|PROT_WRITE));
    for(unsigned trial=0;trial<10000;trial++) {
        unsigned n=next()%256;char reference[257];char *asset=map+2*page-n;
        for(unsigned i=0;i<n;i++)reference[i]=asset[i]=(char)(32+next()%95);
        reference[n]=0;
        const ht_font_t *font=fonts[next()%6];int w=1+next()%700;
        int x=(int)(next()%600)-70,y=(int)(next()%600)-70;
        uint16_t fg=(uint16_t)next(),bg=(uint16_t)next();
        ht_scene_clear(&a,bg);ht_scene_clear(&b,bg);
        assert(ht_text(&a,x,y,w,font,fg,bg,reference));
        // No terminator is readable after the asset: exactly n bytes are enough.
        assert(ht_ascii_text(&b,x,y,w,font,fg,bg,asset,n));identical();
    }
    assert(!munmap(map,page*3));
    ht_scene_clear(&b,0);
    assert(!ht_ascii_text(&b,0,0,40,NULL,0,0,"x",1));
    ht_font_t invalid=ht_mono_20;invalid.width=0;
    assert(!ht_ascii_text(&b,0,0,40,&invalid,0,0,"x",1));
    assert(!ht_ascii_text(&b,0,0,40,&ht_mono_20,0,0,NULL,1));
    for(int i=0;i<HT_RUNS;i++)assert(ht_ascii_text(&b,0,0,40,&ht_mono_20,0,0,NULL,0));
    assert(!ht_ascii_text(&b,0,0,40,&ht_mono_20,0,0,"x",1));
    for(unsigned frame=0;frame<HT_OCTOPUS_FRAMES;frame++) for(unsigned mood=0;mood<=HT_TIM_LISTENING;mood++)
    for(unsigned size=0;size<5;size++) {
        ht_tim_face_t face={.mood=(ht_tim_mood_t)mood,.dim=0x8410,.unread=frame%2,
            .pose={.look=(int)(frame%5)-2,.blink=frame%3==0,.pressed=frame%4==0,.level=frame%5}};
        ht_scene_clear(&a,0);ht_scene_clear(&b,0);
        ht_octopus_fast_scene(false);ht_octopus_portrait(&a,&face,frame,0xfedc,fonts[size],80);
        ht_octopus_fast_scene(true);ht_octopus_portrait(&b,&face,frame,0xfedc,fonts[size],80);identical();
    }
    puts("ASCII scene: 10000 exact-length guarded assets + 2520 full portrait scenes match UTF-8 construction byte for byte PASS");
}
