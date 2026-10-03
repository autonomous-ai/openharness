#include "../main/ui/habitat/creature_gallery.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

static void stroke(ht_gallery_t *g, int x, int y, uint32_t now)
{
    ht_gallery_touch(g,true,233,233,now);
    ht_gallery_touch(g,true,x,y,now+60);
    ht_gallery_touch(g,false,0,0,now+90); // unreliable UP coordinates, as on hardware
}
static void render_file(const ht_scene_t *s, const char *dir, unsigned creature, unsigned mood, unsigned frame)
{
    char path[512];
    snprintf(path,sizeof(path),"%s/%02u-%u-%02u.ppm",dir,creature,mood,frame);
    FILE *f=fopen(path,"wb"); assert(f);
    fprintf(f,"P6\n466 466\n255\n");
    uint16_t line[466];
    for(int y=0;y<466;y++) {
        ht_raster(s,(ht_rect_t){0,y,466,1},line);
        for(int x=0;x<466;x++) {
            uint16_t p=(uint16_t)((line[x]>>8)|(line[x]<<8));
            unsigned char rgb[]={(unsigned char)(((p>>11)&31)*255/31),
                (unsigned char)(((p>>5)&63)*255/63),(unsigned char)((p&31)*255/31)};
            fwrite(rgb,1,3,f);
        }
    }
    fclose(f);
}
int main(int argc, char **argv)
{
    ht_gallery_t g; ht_gallery_init(&g,100);
    assert(g.creature==HT_GALLERY_START);
    g.creature=0; // Preserve original gesture/reaction traces independently of boot selection.
    stroke(&g,100,237,1000); assert(g.creature==1 && g.mood==0 && !g.booped);
    stroke(&g,366,236,2000); assert(g.creature==0);
    stroke(&g,366,236,3000); assert(g.creature==HT_CREATURES-1); // wrapping
    g.creature=9;
    stroke(&g,240,100,4000); assert(g.mood==1 && g.creature==9);
    stroke(&g,236,366,5000); assert(g.mood==0);
    stroke(&g,236,366,6000); assert(g.mood==3);
    stroke(&g,300,300,7000); assert(g.creature==9 && g.mood==3 && !g.booped); // ambiguous diagonal
    ht_gallery_touch(&g,true,233,233,8000);
    ht_gallery_touch(&g,true,260,234,8010);
    ht_gallery_touch(&g,true,233,233,8030);
    ht_gallery_touch(&g,false,233,233,8050);
    assert(!g.booped); // returning to the start after a drag is not a tap
    ht_gallery_touch(&g,true,233,233,9000);
    ht_gallery_cancel(&g);
    // Production driver suppresses the rest of the damaged contact. A duplicate
    // release is harmless; cancellation must not wait for one to arrive.
    ht_gallery_touch(&g,false,100,233,9100);
    assert(g.creature==9 && !g.booped && !g.down);
    ht_gallery_touch(&g,true,233,233,10000);
    ht_gallery_touch(&g,false,0,0,10040);
    assert(g.booped);
    ht_gallery_tick(&g,11641); assert(!g.booped);
    // Uptime wrap must not strand an animation or a contact.
    ht_gallery_init(&g,UINT32_MAX-100);
    g.creature=0;
    ht_gallery_touch(&g,true,233,233,UINT32_MAX-20);
    ht_gallery_touch(&g,false,0,0,15); assert(g.booped);
    ht_gallery_tick(&g,1700); assert(!g.booped);

    uint64_t total=0; unsigned frames=0,max_pixels=0;
    for(unsigned c=0;c<HT_CREATURES;c++) for(unsigned m=0;m<HT_CREATURE_MOODS;m++) {
        ht_gallery_init(&g,0);g.creature=c;g.mood=m;
        ht_scene_t prior,scene; unsigned changes=0;
        for(unsigned frame=0;frame<320;frame++) {
            ht_gallery_render(&g,&scene,frame*125);
            assert(scene.count<=HT_RUNS);
            for(unsigned i=0;i<scene.count;i++) {
                const ht_run_t *r=&scene.runs[i];
                assert(r->x>=0 && r->y>=0 && r->x+r->w<=466 && r->y+r->font->height<=466);
                const char *p=r->text;
                unsigned cells=0;
                while(*p) {
                    uint32_t cp=ht_utf8_next(&p); cells++;
                    assert(cp==' ' || (cp>=r->font->first && cp<=r->font->last));
                }
                assert(cells*r->font->width <= (unsigned)r->w);
            }
            if(frame) {
                ht_damage_t d;ht_damage(&prior,&scene,&d);
                if(d.count) changes++;
                total+=d.pixels;frames++;
                if(d.pixels>max_pixels) max_pixels=d.pixels;
            }
            if(argc==2 && (frame==0 || (m==2 && frame<12))) render_file(&scene,argv[1],c,m,frame);
            prior=scene;
        }
        assert(changes>=3); // Every creature in every mood is visibly animated.
    }
    // Stored-clip input cannot call voice; a tap simply restarts its animation.
    ht_gallery_init(&g,100);
    ht_gallery_touch(&g,true,233,233,1000);
    ht_gallery_touch(&g,false,0,0,1040);
    assert(g.entered==1040 && !g.booped);
    ht_scene_t scene;
    assert(ht_gallery_take(&g,&scene,1040));
    uint32_t wake=ht_gallery_wake(&g,1040);
    assert(wake>0 && wake<2000);
    ht_gallery_tick(&g,1040+wake);
    assert(ht_gallery_take(&g,&scene,1040+wake));
    // Last -> first clip and mood changes must not select a null asset.
    g.creature=HT_CREATURES-1;
    stroke(&g,100,233,2000); assert(g.creature==0);
    printf("gallery: %d creatures x 4 modes x 320 frames; supported glyphs, bounded scenes, gestures and timer wrap pass\n",HT_CREATURES);
    printf("gallery damage: %u samples, mean=%" PRIu64 " px, max=%u px (full=217156)\n",frames,total/frames,max_pixels);
    return 0;
}
