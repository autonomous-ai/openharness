// Identical-content comparison against the actual pre-optimization renderer.
#include "reference48/reference.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint16_t old_pixels[HT_WIDTH*HT_HEIGHT], new_pixels[HT_WIDTH*HT_HEIGHT];
static uint16_t region_pixels[HT_WIDTH*HT_HEIGHT];
static ht_scene_t previous_old, previous_new, old_scene, new_scene;

static ht_scene_t artwork_only(ht_scene_t scene)
{
    unsigned kept=0;
    for(unsigned i=0;i<scene.count;i++) {
        const ht_run_t *r=&scene.runs[i];
        if(!r->arc && r->y>=194 && r->y<400 &&
           (r->font==&ht_mono_20 || r->font==&ht_open_20)) continue;
        scene.runs[kept++]=*r;
    }
    scene.count=kept;
    return scene;
}

int main(void)
{
    const char *recaps[]={NULL,"The change is ready to try.",
        "The update is installed. Voice input now sends to the selected agent. The result stays in the center."};
    unsigned scenes=0;
    for(int layout=0;layout<4;layout++) for(int mood=0;mood<8;mood++) {
        memset(&previous_old,0,sizeof previous_old);memset(&previous_new,0,sizeof previous_new);
        for(int frame=0;frame<HT_OCTOPUS_FRAMES;frame++) {
            ht_tim_face_t f={.recipient=frame%2?"Deploy latest firmware":"Mobile app build and deploy",
                .status=frame%3?"Inbox 2 / Working":"Inbox 2 / Wandering",.mood=mood,
                .foreground=0xffff,.dim=ht_rgb(0x909990),.ink=ht_rgb(0xb9ed80),
                .unread=(frame%2)!=0,.straight_title=layout==3,
                .pose={.look=frame%3-1,.blink=frame%13==0,.level=frame%5,.pressed=frame%17==0}};
            ht_scene_clear(&old_scene,ht_rgb(0x080c08)); ht_scene_clear(&new_scene,old_scene.background);
            const char *recap=recaps[layout%3];
            ht48_octopus_face(&old_scene,&f,frame,ht_rgb(0xc8a9f0),recap);
            ht_octopus_face(&new_scene,&f,frame,ht_rgb(0xc8a9f0),recap);
            if(recap) {
                // Summary punctuation intentionally changed: the open action is
                // now a separate inbox control. Keep exact legacy artwork checks,
                // then give both rasterizers the same current summary content.
                ht_scene_t old_art=artwork_only(old_scene),new_art=artwork_only(new_scene);
                assert(old_art.count==new_art.count);
                assert(!memcmp(old_art.runs,new_art.runs,old_art.count*sizeof(ht_run_t)));
                old_scene=new_scene;
            }
            if(old_scene.count!=new_scene.count || memcmp(old_scene.runs,new_scene.runs,old_scene.count*sizeof(ht_run_t))) {
                fprintf(stderr,"Scene mismatch layout=%d mood=%d frame=%d\n",layout,mood,frame);return 1;
            }
            ht_damage_t new_damage;
            ht_damage(frame?&previous_new:NULL,&new_scene,&new_damage);
            assert(new_damage.count<=HT_DAMAGE_MAX);
            for(int n=0;n<new_damage.count;n++) {
                ht_rect_t r=new_damage.rect[n];
                assert(r.x>=0&&r.y>=0&&r.w>0&&r.h>0&&r.x+r.w<=HT_WIDTH&&r.y+r.h<=HT_HEIGHT);
                ht_raster(&new_scene,r,region_pixels);
                for(int y=0;y<r.h;y++)memcpy(new_pixels+(y+r.y)*HT_WIDTH+r.x,region_pixels+y*r.w,r.w*sizeof *new_pixels);
            }
            ht_rect_t full={0,0,HT_WIDTH,HT_HEIGHT};
            ht48_raster(&old_scene,full,old_pixels);
            if(memcmp(old_pixels,new_pixels,sizeof old_pixels)) {
                fprintf(stderr,"Incremental pixel mismatch layout=%d mood=%d frame=%d\n",layout,mood,frame);return 1;
            }
            if(frame%7==0) {
                ht_raster(&new_scene,full,region_pixels);
                assert(!memcmp(old_pixels,region_pixels,sizeof old_pixels));
            }
            previous_old=old_scene;previous_new=new_scene;scenes++;
        }
    }
    printf("Renderer reference: %u exact scenes/incremental frames and 288 additional full renders across four layouts/eight moods PASS\n",scenes);
}
