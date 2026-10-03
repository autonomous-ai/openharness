// Every supported curved glyph at every rotation, plus arbitrary mixed labels.
#include "../main/ui/habitat/terminal.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint16_t original[HT_ARC_WIDTH * HT_ARC_HEIGHT + 1];
static uint16_t tight[HT_ARC_WIDTH * HT_ARC_HEIGHT + 1];
static uint32_t seed = 0x517ca;
static unsigned next(void) { seed = seed * 1664525u + 1013904223u; return seed; }
static size_t encode(char *p, unsigned cp)
{
    if (cp < 128) { p[0]=(char)cp; return 1; }
    if (cp < 2048) { p[0]=(char)(0xc0|(cp>>6));p[1]=(char)(0x80|(cp&63));return 2; }
    p[0]=(char)(0xe0|(cp>>12));p[1]=(char)(0x80|((cp>>6)&63));p[2]=(char)(0x80|(cp&63));return 3;
}
static const ht_arc_face_t *face;
static void compare(const char *text, int edge)
{
    if(edge && face==&ht_arc_inter_prop) return; // the Inter name (mid 16) is upper arc only
    ht_scene_t scene;
    ht_scene_clear(&scene,ht_rgb(next()&0xffffff));
    if(edge) ht_arc_status_face(&scene,ht_rgb(next()&0xffffff),text,face);
    else ht_arc_title_face(&scene,ht_rgb(next()&0xffffff),text,face);
    ht_rect_t rect={HT_ARC_X,edge ? HT_HEIGHT-HT_ARC_Y-HT_ARC_HEIGHT : HT_ARC_Y,
                    HT_ARC_WIDTH,HT_ARC_HEIGHT};
    const size_t pixels=(size_t)rect.w*rect.h;
    original[pixels]=tight[pixels]=0x7ced;
    ht_arc_tight_bounds(false);ht_raster(&scene,rect,original);
    ht_arc_tight_bounds(true);ht_raster(&scene,rect,tight);
    assert(original[pixels]==0x7ced&&tight[pixels]==0x7ced);
    assert(!memcmp(original,tight,pixels*sizeof *tight));
}
static void run(void)
{
    // The two longest labels cover every rotation-table entry in both
    // directions. Every Latin-1 glyph, arrow and bell occupies each one.
    for(unsigned glyph=32;glyph<=258;glyph++) {
        unsigned cp=glyph==258 ? 0x2192 : glyph==257 ? 0xe000 : glyph==256 ? 0x2197 : glyph;
        for(int length=HT_ARC_COLS-1;length<=HT_ARC_COLS;length++) for(int edge=0;edge<2;edge++) {
            char text[HT_TEXT_BYTES];size_t n=0;
            for(int i=0;i<length;i++)n+=encode(text+n,cp);
            text[n]=0;compare(text,edge);
        }
    }
    for(int trial=0;trial<2000;trial++) {
        char text[HT_TEXT_BYTES];size_t n=0;unsigned length=1+next()%HT_ARC_COLS;
        for(unsigned i=0;i<length;i++) {
            unsigned cp=32+next()%228;
            n+=encode(text+n,cp==256 ? 0x2197 : cp==257 ? 0xe000 : cp==258 ? 0x2192 : cp==259 ? 0x2014 : cp);
        }
        text[n]=0;compare(text,trial&1);
    }
}
int main(void)
{
    face=&ht_arc_geist; run();
    // The proportional faces: the same sweeps, here with their own 1/16 px layout.
    face=&ht_arc_inter_lower; run();   // both arcs
    face=&ht_arc_inter_prop; run();    // upper arc only
    puts("arc bounds: Inter Medium 26 (lower face on both arcs, name face on the upper) matches too; 227 glyphs at every upper/lower rotation + 2000 mixed labels match full-cell pixels PASS");
}
