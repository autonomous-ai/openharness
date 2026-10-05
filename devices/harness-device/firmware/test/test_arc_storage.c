// Exercise the actual packed cache, its hard capacity bound, and exact pixels
// against the habitat.79 dense-cache algorithm, adapted to the 24 px metrics.
#include "../main/ui/habitat/terminal.c"
#include "reference79/reference.h"
#include <assert.h>
#include <stdio.h>

static uint16_t dense[HT_ARC_WIDTH * HT_ARC_HEIGHT + 2];
static uint16_t packed[HT_ARC_WIDTH * HT_ARC_HEIGHT + 2];
static uint32_t seed = 0x80cace;
static unsigned next(void) { seed = seed * 1664525u + 1013904223u; return seed; }
static size_t encode(char *p, unsigned cp)
{
    if (cp < 128) { p[0]=(char)cp; return 1; }
    if (cp < 2048) { p[0]=(char)(0xc0|(cp>>6));p[1]=(char)(0x80|(cp&63));return 2; }
    p[0]=(char)(0xe0|(cp>>12));p[1]=(char)(0x80|((cp>>6)&63));p[2]=(char)(0x80|(cp&63));return 3;
}
static void compare(const char *text, int edge, bool partial)
{
    ht_scene_t scene;
    ht_scene_clear(&scene,ht_rgb(next()&0xffffff));
    ht_text(&scene,25,edge ? 345 : 20,416,&ht_mono_20,ht_rgb(0xabcdef),scene.background,
            "Underlying text stays under gaps");
    if(edge) ht_arc_status(&scene,ht_rgb(next()&0xffffff),text);
    else ht_arc_title(&scene,ht_rgb(next()&0xffffff),text);
    ht_rect_t rect={HT_ARC_X,edge ? HT_HEIGHT-HT_ARC_Y-HT_ARC_HEIGHT : HT_ARC_Y,
                    HT_ARC_WIDTH,HT_ARC_HEIGHT};
    if(partial) {
        int dx=next()%300,dy=next()%96;
        rect.x+=dx;rect.y+=dy;rect.w=1+next()%(HT_ARC_WIDTH-dx);rect.h=1+next()%(HT_ARC_HEIGHT-dy);
    }
    const size_t pixels=(size_t)rect.w*rect.h;
    dense[0]=packed[0]=0x61ac;dense[pixels+1]=packed[pixels+1]=0x8ace;
    ht79_raster(&scene,rect,dense+1);ht_raster(&scene,rect,packed+1);
    assert(dense[0]==0x61ac&&packed[0]==0x61ac);
    assert(dense[pixels+1]==0x8ace&&packed[pixels+1]==0x8ace);
    assert(!memcmp(dense+1,packed+1,pixels*sizeof *packed));
}

// Hard proportional labels on both arcs: whatever arc_text lets through must fit the mask and draw ink,
// never a blank label. `raw_peak` is the worst mask a label needed before any mask-driven re-fit.
static uint16_t sweep_px[HT_WIDTH*HT_HEIGHT], sweep_blank[HT_WIDTH*HT_HEIGHT];
static unsigned sweep_peak, sweep_raw_peak, sweep_refit;
static void hard_label(const char *label,int edge,const ht_arc_face_t *pf)
{
    ht_scene_t scene;ht_scene_clear(&scene,ht_rgb(0x101018));
    char fitted[HT_TEXT_BYTES];
    arc_prop_fit(fitted,sizeof fitted,pf->prop,label,pf->bare);
    if(edge) ht_arc_status_face(&scene,ht_rgb(0xeaeaf0),label,pf); else ht_arc_title_face(&scene,ht_rgb(0xeaeaf0),label,pf);
    const ht_run_t *run=&scene.runs[0];
    assert(scene.count==1 && ht_arc_measure(pf,run->text)<=HT_ARC_SPAN);
    ht_run_t raw=*run;snprintf(raw.text,sizeof raw.text,"%s",fitted);
    arc_span_t spans[HT_ARC_HEIGHT][2];
    unsigned need=arc_prop_geometry(&raw,pf->prop,spans),got=arc_prop_geometry(run,pf->prop,spans);
    if(need>sweep_raw_peak) sweep_raw_peak=need;
    if(strcmp(fitted,run->text)) { sweep_refit++; assert(need>ARC_MASK_BYTES); }
    assert(got<=ARC_MASK_BYTES);
    if(got>sweep_peak) sweep_peak=got;
    arc_cache_t *cache=&arc_caches[edge];
    arc_prepare(run,cache);
    assert(cache->mask_bytes==got);
    ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},sweep_px);
    unsigned ink=0;
    for(int i=0;i<HT_WIDTH*HT_HEIGHT;i++) ink+=sweep_px[i]!=sweep_blank[i];
    assert(ink>0);
}
static void hard_labels(const ht_arc_face_t *pf,int edges)
{
    ht_scene_t empty;ht_scene_clear(&empty,ht_rgb(0x101018));
    ht_raster(&empty,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},sweep_blank);
    static const char *fixed[]={
        "\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xc4\xa2\xe1\xba\xae\xc4\xa2\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xc4\xa2\xe1\xba\xa8\xc4\x9c\xc4\xb4",
        "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW","MWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMW",
        "gjpqy gjpqy gjpqy gjpqy gjpqy gjpqy gjpqy gjpqy","M2 harness-pro-firmware-release-candidate"};
    for(int edge=0;edge<edges;edge++) for(unsigned i=0;i<sizeof fixed/sizeof fixed[0];i++) hard_label(fixed[i],edge,pf);
    // Stacked capitals (two-mark Vietnamese), descenders and wide capitals, mixed at random to the maximum length.
    static const unsigned pool[]={0x1ea8,0x1eae,0x1eb2,0x1eac,0x1ec6,0x1ed4,0x1ed8,0x1eaa,0x122,0x11c,0x134,0x1b0,'W','M','g','j','y','Q',' ','A'};
    for(int trial=0;trial<600;trial++) {
        char text[HT_TEXT_BYTES];size_t n=0;unsigned length=1+next()%40;
        for(unsigned i=0;i<length&&n<sizeof text-4;i++) n+=encode(text+n,pool[next()%(sizeof pool/sizeof pool[0])]);
        text[n]=0;hard_label(text,(trial&1)%edges,pf);
    }
    assert(sweep_peak<=ARC_MASK_BYTES);
    // The re-fit step: each trim drops one glyph, keeps the "…" and only shrinks the mask, down to "…" alone.
    {
        ht_scene_t scene;ht_scene_clear(&scene,ht_rgb(0x101018));
        ht_arc_title_face(&scene,ht_rgb(0xeaeaf0),fixed[0],pf);
        ht_run_t run=scene.runs[0];
        arc_span_t spans[HT_ARC_HEIGHT][2];
        unsigned last=arc_prop_geometry(&run,pf->prop,spans);
        int steps=0;
        while(arc_prop_trim(run.text,false)) {   // the "…" path; a bare face drops glyphs the same way
            unsigned now=arc_prop_geometry(&run,pf->prop,spans);
            assert(now<=last && !strcmp(run.text+strlen(run.text)-3,"\xe2\x80\xa6") && ++steps<64);
            last=now;
        }
        assert(!strcmp(run.text,"\xe2\x80\xa6") && steps>=12);   // Inter is wide: few glyphs fit the span
    }
    printf("Hard proportional labels (%s): mask <=%u/%uB after fit (raw worst %u B, %u re-fitted shorter), every label inks PASS\n",
           pf==&ht_arc_inter_prop ? "Inter Medium 26, upper arc" : "Inter Medium 26, lower face",sweep_peak,ARC_MASK_BYTES,sweep_raw_peak,sweep_refit);
    sweep_peak=sweep_raw_peak=sweep_refit=0;
}
int main(void)
{
    assert(ht_mono_24.width==HT_ARC_CELL_WIDTH && ht_mono_24.height==HT_ARC_CELL_HEIGHT);
    unsigned peak=0;
    for(int count=1;count<=HT_ARC_COLS;count++) for(int edge=0;edge<2;edge++) {
        arc_cache_t cache={0};
        ht_run_t run={.arc=edge+1,.y=edge ? HT_HEIGHT-HT_ARC_Y-HT_ARC_HEIGHT : HT_ARC_Y};
        assert(arc_pack_geometry(&run,&cache,count));
        if(cache.mask_bytes>peak) peak=cache.mask_bytes;
        for(int y=0;y<HT_ARC_HEIGHT;y++) for(int h=0;h<2;h++) {
            arc_span_t span=cache.spans[y][h];
            assert(span.first<=ARC_HALF&&span.last<=ARC_HALF);
            if(span.first<span.last) assert(span.offset+(span.last-span.first+3)/4<=cache.mask_bytes);
        }
        char text[HT_ARC_COLS+1];memset(text,'W',count);text[count]=0;
        compare(text,edge,false);
        memset(text,' ',count);compare(text,edge,false);
    }
    assert(peak==4538);
    assert(sizeof arc_caches==21856); // was 12576: the mask holds 4-bit proportional labels (9216 B, was 4608) and the entry a pfont key + bpp; +32: each entry keys its mask by the 16 per-glyph gains too
    for(unsigned glyph=32;glyph<=258;glyph++) {
        unsigned cp=glyph==258 ? 0x2192 : glyph==257 ? 0xe000 : glyph==256 ? 0x2197 : glyph;
        for(int length=HT_ARC_COLS-1;length<=HT_ARC_COLS;length++) for(int edge=0;edge<2;edge++) {
            char text[HT_TEXT_BYTES];size_t n=0;
            for(int i=0;i<length;i++) n+=encode(text+n,cp);
            text[n]=0;compare(text,edge,false);
        }
    }
    for(int trial=0;trial<4000;trial++) {
        char text[HT_TEXT_BYTES];size_t n=0;unsigned length=1+next()%HT_ARC_COLS;
        for(unsigned i=0;i<length;i++) {
            unsigned cp=32+next()%228;
            n+=encode(text+n,cp==256 ? 0x2197 : cp==257 ? 0xe000 : cp==258 ? 0x2192 : cp==259 ? 0x2014 : cp);
        }
        text[n]=0;compare(text,trial&1,trial%3!=0);
    }
    hard_labels(&ht_arc_inter_lower,2);
    hard_labels(&ht_arc_inter_prop,1);
    printf("Packed arcs: all %u geometries <=%u/%uB; 227 glyphs at every angle, 4000 mixed/clipped labels match dense pixels; caches=%zuB PASS\n",2*HT_ARC_COLS,peak,ARC_MASK_BYTES,sizeof arc_caches);
}
