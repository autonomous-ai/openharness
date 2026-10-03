// Smaller transfer regions must still produce exactly the fully rendered frame.
#include "../main/ui/habitat/octopus.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint16_t frame[HT_WIDTH*HT_HEIGHT], full[HT_WIDTH*HT_HEIGHT];
static uint16_t scratch[HT_WIDTH*HT_HEIGHT+2];
static uint32_t seed=0xdaba84;
static unsigned next(void) { seed=seed*1664525u+1013904223u;return seed; }
static unsigned improved;
static void transition(const ht_scene_t *a,const ht_scene_t *b)
{
    ht_damage_t old,d;
    ht_damage_banded(false);ht_damage(a,b,&old);
    ht_damage_banded(true);ht_damage(a,b,&d);
    if(d.pixels!=old.pixels || d.count!=old.count) {
        assert(d.pixels+d.count*256u+64<old.pixels+old.count*256u);improved++;
    }
    assert(d.count<=HT_DAMAGE_MAX);
    uint32_t area=0;
    for(int i=0;i<d.count;i++) {
        ht_rect_t r=d.rect[i];
        assert(r.x>=0&&r.y>=0&&r.w>0&&r.h>0&&r.x+r.w<=HT_WIDTH&&r.y+r.h<=HT_HEIGHT);
        assert(!((r.x|r.y|r.w|r.h)&1));
        unsigned count=r.w*r.h;area+=count;
        scratch[0]=0x8411;scratch[count+1]=0x8412;ht_raster(b,r,scratch+1);
        assert(scratch[0]==0x8411&&scratch[count+1]==0x8412);
        for(int y=0;y<r.h;y++)memcpy(frame+(r.y+y)*HT_WIDTH+r.x,scratch+1+y*r.w,r.w*sizeof *frame);
    }
    assert(area==d.pixels);
    ht_raster(b,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
    assert(!memcmp(frame,full,sizeof frame));
}
int main(void)
{
    ht_scene_t a,b;ht_scene_clear(&a,ht_rgb(0x080c08));transition(NULL,&a);
    const char *recaps[]={NULL,"Fixed. All checks passed.",
        "The update is installed. Voice input now sends to the selected agent. The result stays in the center."};
    for(int i=0;i<768;i++) {
        ht_tim_face_t f={.recipient=i%2?"Deploy latest firmware":"hn",.status=i%3?"Inbox 2 / Working":"Coalescing",
            .mood=i%8,.foreground=0xffff,.dim=0x7777,.ink=0xafe0,.straight_title=i%7==0,
            .pose={.look=i%3-1,.blink=i%11==0,.level=i%5}};
        ht_scene_clear(&b,a.background);ht_octopus_face(&b,&f,i%HT_OCTOPUS_FRAMES,ht_rgb(0xc8a9f0),recaps[i%3]);
        transition(&a,&b);a=b;
    }
    static const char *labels[]={"","A longer line","x","abc 123", "↗", "café — ready"};
    for(int trial=0;trial<2000;trial++) {
        ht_scene_clear(&b,trial%37?a.background:(uint16_t)next());
        unsigned rows=next()%HT_RUNS;
        for(unsigned row=0;row<rows;row++) {
            const ht_font_t *font=next()%2?&ht_mono_16:&ht_mono_20;
            int x=(int)(next()%550)-40,y=(int)(next()%545)-40,w=1+next()%400;
            ht_text(&b,x,y,w,font,next(),next()%4?b.background:(uint16_t)next(),labels[next()%6]);
        }
        if(trial%5==0)ht_arc_title(&b,0xffff,"A curved title");
        transition(&a,&b);a=b;
    }
    // Forty isolated thin rows force the 24-region budget to coalesce safely.
    ht_scene_clear(&b,a.background);
    for(int i=0;i<40;i++)ht_text(&b,(i*31)%360,i*10,60,&ht_octopus_font_2,0xffff,b.background,".:::::::.");
    transition(&a,&b);a=b;
    ht_scene_clear(&b,a.background);transition(&a,&b);
    assert(improved>500);
    printf("Damage bands: 768 real layout/pose transitions + 2000 overlapping/clipped scenes, region-budget pressure and guarded partial redraws match full frames; %u smaller updates PASS\n",improved);
}
