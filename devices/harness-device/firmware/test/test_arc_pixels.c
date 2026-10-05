// Golden 24 px pixels from the dense reference48 renderer. Optimizations
// must preserve every coverage/color value at all supported text lengths.
#include "../main/ui/habitat/terminal.h"
#include "../main/ui/habitat/focus_faces.h"
#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#ifndef HT_UPDATE_ARC_GOLDEN
static const uint64_t expected[] = {
#include "arc_pixels.inc"
};
#endif
static uint16_t pixels[HT_WIDTH * HT_HEIGHT];
#ifndef HT_UPDATE_ARC_GOLDEN
static void arc_title_is_mono(void)
{
    // ht_arc_title is exactly the GeistMono face (the non-Focus skins' curved title).
    ht_scene_t x,y; ht_scene_clear(&x,ht_rgb(0x183c25)); ht_scene_clear(&y,ht_rgb(0x183c25));
    ht_arc_title(&x,ht_rgb(0xc8a9f0),"harness-pro");
    ht_arc_title_face(&y,ht_rgb(0xc8a9f0),"harness-pro",&ht_arc_geist);
    assert(ht_arc_geist.mono==&ht_mono_24 && !memcmp(&x.runs[0],&y.runs[0],sizeof x.runs[0]));
}
// The proportional (Inter Medium 26, upper-arc name face and lower face) arcs: ink inside r 230 and clear of the canvas edge (so nothing is
// clipped), inside the run's bounds, kerned, a different mask from the mono face, fitted to the span.
static void prop_face(const ht_arc_face_t *pf, const ht_pfont_t *font, int first_edge, int edges)
{
    assert(pf->prop==font && ht_arc_measure(pf,"AV")<ht_arc_measure(pf,"A")+ht_arc_measure(pf,"V"));
    static const char *labels[]={
        "Deploy latest firmware","I","W","Landing page","harness-pro","\xe2\x80\xa6",
        "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW","MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM",
        "\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86\xe1\xba\xbe\xe1\xbb\x86",
        "\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80\xc3\x80",
        "gjpqy gjpqy gjpqy gjpqy gjpqy gjpqy gjpqy",
        "Nguy\xe1\xbb\x85n V\xc4\x83n \xe1\xba\xbe \xe1\xbb\x86 d\xe1\xbb\xb1 \xc3\xa1n r\xe1\xba\xa5t d\xc3\xa0i nh\xc6\xb0 th\xe1\xba\xbf n\xc3\xa0y",
        "Quick brown fox jumps over the lazy dog","Supercalifragilisticexpialidocious-and-then-some-more-letters",
        "Tr\xe1\xba\xa7n Th\xe1\xbb\x8b H\xe1\xbb\x93ng \xc4\x90\xc3\xa0o","AVATAR AWAY Type To",
        "Tri\xe1\xbb\x83n khai firmware m\xe1\xbb\x9bi nh\xe1\xba\xa5t"};
    static uint16_t blank[HT_WIDTH*HT_HEIGHT];
    for (int edge=first_edge;edge<edges;edge++) for (unsigned i=0;i<sizeof labels/sizeof labels[0];i++) {
        ht_scene_t scene; ht_scene_clear(&scene,ht_rgb(0x101018));
        if(edge) ht_arc_status_face(&scene,ht_rgb(0xeaeaf0),labels[i],pf); else ht_arc_title_face(&scene,ht_rgb(0xeaeaf0),labels[i],pf);
        const ht_run_t *run=&scene.runs[0];
        assert(scene.count==1 && run->arc==edge+1 && run->font==&font->base);
        assert(ht_arc_measure(pf,run->text)<=HT_ARC_SPAN);
        if(strlen(run->text)<strlen(labels[i])) { // cut: ends "…" at a word where there is one ("…" never on a bare face)
            size_t keep=strlen(run->text)-(pf->bare?0:3);
            assert(pf->bare ? !strstr(run->text,"\xe2\x80\xa6") || !strncmp(labels[i],"\xe2\x80\xa6",3)
                            : !strcmp(run->text+keep,"\xe2\x80\xa6"));
            assert(!strncmp(run->text,labels[i],keep));
        } else assert(!strcmp(run->text,labels[i]));
        ht_rect_t b=ht_run_bounds(run);
        ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels);
        ht_scene_t empty; ht_scene_clear(&empty,ht_rgb(0x101018));
        ht_raster(&empty,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},blank);
        int top=run->y, bottom=run->y+HT_ARC_HEIGHT-1;
        unsigned ink=0;
        for (int y=0;y<HT_HEIGHT;y++) for (int x=0;x<HT_WIDTH;x++) if (pixels[y*HT_WIDTH+x]!=blank[y*HT_WIDTH+x]) {
            ink++;
            assert((x-233)*(x-233)+(y-233)*(y-233)<230*230);
            assert(x>=b.x && x<b.x+b.w && y>=b.y && y<b.y+b.h);       // tight bounds contain the ink
            assert(y!=top && y!=bottom && x!=HT_ARC_X && x!=HT_ARC_X+HT_ARC_WIDTH-1); // the canvas clips none
        }
        assert(ink>0);
        // The mono face, same text, between two proportional draws: another mask, and the cache recovers.
        uint64_t hp=0,hm=0,hp2=0;
        for (int k=0;k<3;k++) {
            ht_scene_t one; ht_scene_clear(&one,ht_rgb(0x101018));
            if(k==1) { if(edge) ht_arc_status_face(&one,ht_rgb(0xeaeaf0),run->text,&ht_arc_geist); else ht_arc_title_face(&one,ht_rgb(0xeaeaf0),run->text,&ht_arc_geist); }
            else { if(edge) ht_arc_status_face(&one,ht_rgb(0xeaeaf0),run->text,pf); else ht_arc_title_face(&one,ht_rgb(0xeaeaf0),run->text,pf); }
            ht_raster(&one,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels);
            uint64_t h=UINT64_C(14695981039346656037);
            for (int j=0;j<HT_WIDTH*HT_HEIGHT;j++) { h^=pixels[j]; h*=UINT64_C(1099511628211); }
            if(k==0) hp=h; else if(k==1) hm=h; else hp2=h;
        }
        assert(hp!=hm && hp==hp2);
    }
    // The cut: a word boundary only when it keeps half the span, else letters (the mono rule's half).
    {
        ht_scene_t cut; ht_scene_clear(&cut,ht_rgb(0x101018));
        ht_arc_title_face(&cut,ht_rgb(0xeaeaf0),"M2 harness-pro-firmware-release-candidate",pf);
        const char *t=cut.runs[0].text;
        assert(strcmp(t,pf->bare?"M2":"M2\xe2\x80\xa6") && !strncmp(t,"M2 harness-pro",14) && ht_arc_measure(pf,t)>=HT_ARC_SPAN/2);
        ht_scene_clear(&cut,ht_rgb(0x101018));
        ht_arc_title_face(&cut,ht_rgb(0xeaeaf0),"Deploy the latest firmware release to every harness device now",pf);
        t=cut.runs[0].text;
        if(pf->bare) assert(!strncmp(t,"Deploy the latest",17) && !strstr(t,"\xe2\x80\xa6") && t[strlen(t)-1]!=' ' &&
                            "Deploy the latest firmware release to every harness device now"[strlen(t)]==' ');   // a whole word, no "…"
        else assert(!strncmp(t,"Deploy the latest",17) && !strcmp(t+strlen(t)-3,"\xe2\x80\xa6") && t[strlen(t)-4]!=' ');
        assert(ht_arc_measure(pf,t)<=HT_ARC_SPAN && ht_arc_measure(pf,t)>=HT_ARC_SPAN/2);
    }
    // Bounds are laid out once with the run and survive copies and comparisons.
    {
        ht_scene_t one,two; ht_scene_clear(&one,ht_rgb(0x101018)); ht_scene_clear(&two,ht_rgb(0x101018));
        ht_arc_status_face(&one,ht_rgb(0xeaeaf0),"Deploy latest firmware",pf);
        ht_arc_status_face(&two,ht_rgb(0xeaeaf0),"Deploy latest firmware",pf);
        assert(one.runs[0].ink && !memcmp(&one.runs[0],&two.runs[0],sizeof one.runs[0]));
        ht_run_t bare=one.runs[0]; bare.ink=0; memset(&bare.ink_box,0,sizeof bare.ink_box);
        ht_rect_t a=ht_run_bounds(&one.runs[0]),b=ht_run_bounds(&bare);   // stored vs laid out on the fly
        assert(a.x==b.x && a.y==b.y && a.w==b.w && a.h==b.h && a.w>0);
    }
    // A shimmer sweep and a partial strip draw the same ink as the full frame (4-bit levels in both).
    ht_scene_t scene; ht_scene_clear(&scene,ht_rgb(0x101018));
    ht_arc_title_face(&scene,ht_rgb(0xeaeaf0),"Deploy latest firmware",pf);
    ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels);
    static uint16_t strip[HT_WIDTH*8];
    ht_raster(&scene,(ht_rect_t){0,20,HT_WIDTH,8},strip);
    assert(!memcmp(strip,pixels+20*HT_WIDTH,sizeof strip));
    scene.runs[0].shimmer=9;
    ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels);
}
#endif
// The lower arc with a gain per glyph: no gains is ht_arc_status_face to the pixel, a gain scales its glyph's
// coverage (the ground is black here, so the dimmed colour), the mask cache is keyed by the gains.
static unsigned green(uint16_t panel) { return ((uint16_t)(panel<<8|panel>>8)>>5)&63; }   // the green channel of a panel-order pixel
static void sweep_face(void)
{
    static uint16_t plain[HT_WIDTH*HT_HEIGHT], got[HT_WIDTH*HT_HEIGHT];
    const ht_rect_t all={0,0,HT_WIDTH,HT_HEIGHT};
    ht_scene_t a, b;
    ht_scene_clear(&a,0); ht_arc_status_face(&a,ht_rgb(0x00ff2f),"Listening",&ht_arc_inter_lower);
    ht_raster(&a,all,plain);
    uint8_t full[HT_ARC_GAINS], none[HT_ARC_GAINS]={0}, one[HT_ARC_GAINS];
    for (int i=0;i<HT_ARC_GAINS;i++) full[i]=one[i]=255;
    one[0]=0;
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Listening",&ht_arc_inter_lower,NULL);
    assert(b.count==1 && !b.runs[0].gained && b.runs[0].arc==2);
    ht_raster(&b,all,got); assert(!memcmp(plain,got,sizeof plain));
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Listening",&ht_arc_inter_lower,full);
    assert(b.count==1 && b.runs[0].gained);
    ht_raster(&b,all,got); assert(!memcmp(plain,got,sizeof plain));
    // The same bounds as the plain run, whatever the gains: damage and hit areas do not move.
    ht_rect_t rb=ht_run_bounds(&b.runs[0]), ra=ht_run_bounds(&a.runs[0]);
    assert(rb.x==ra.x && rb.y==ra.y && rb.w==ra.w && rb.h==ra.h);
    // All dark: no ink. First letter dark: only pixels at the left of the word change, all dimmer.
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Listening",&ht_arc_inter_lower,none);
    ht_raster(&b,all,got);
    for (unsigned i=0;i<sizeof got/sizeof got[0];i++) assert(!got[i]);
    uint32_t builds=ht_arc_cache_builds();
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Listening",&ht_arc_inter_lower,one);
    ht_raster(&b,all,got);
    assert(ht_arc_cache_builds()==builds+1);
    int changed=0;
    for (int y=0;y<HT_HEIGHT;y++) for (int x=0;x<HT_WIDTH;x++) if (got[y*HT_WIDTH+x]!=plain[y*HT_WIDTH+x]) {
        changed++; assert(x<200 && green(got[y*HT_WIDTH+x])<green(plain[y*HT_WIDTH+x]));   // the L's ink only, and only dimmer
    }
    assert(changed>20);
    ht_raster(&b,all,got); assert(ht_arc_cache_builds()==builds+1);   // same text, same gains: the mask is reused
    // Half brightness: every inked pixel dimmer than full and brighter than black, in the 565 green channel.
    uint8_t half[HT_ARC_GAINS]; for (int i=0;i<HT_ARC_GAINS;i++) half[i]=128;
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Listening",&ht_arc_inter_lower,half);
    ht_raster(&b,all,got);
    int inked=0;
    for (unsigned i=0;i<sizeof got/sizeof got[0];i++) if (plain[i]) { inked++; assert(green(got[i])<=green(plain[i]) && (green(got[i])>0 || green(plain[i])<4)); }
    assert(inked>200);
    // Another label's glyph count outside the table keeps full gain; a mono face ignores gains.
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Listening and then some more words",&ht_arc_inter_lower,none);
    ht_scene_clear(&b,0); ht_arc_status_sweep(&b,ht_rgb(0x00ff2f),"Hi",&ht_arc_geist,none);
    assert(b.count==1 && !b.runs[0].gained);
}
int main(void)
{
    for (int edge=0;edge<2;edge++) for (int length=1;length<=HT_ARC_COLS;length++) {
        char text[HT_ARC_COLS+1];
        for (int i=0;i<length;i++) text[i]=32+(i*17+length*7)%95;
        text[length]=0;
        ht_scene_t scene; ht_scene_clear(&scene,ht_rgb(0x183c25));
        if(edge) ht_arc_status(&scene,ht_rgb(0xc8a9f0),text);
        else ht_arc_title(&scene,ht_rgb(0xc8a9f0),text);
        ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels);
        uint64_t hash=UINT64_C(14695981039346656037);
        for (unsigned i=0;i<sizeof pixels/sizeof pixels[0];i++) {
            hash^=pixels[i]; hash*=UINT64_C(1099511628211);
        }
#ifdef HT_UPDATE_ARC_GOLDEN
        printf("UINT64_C(0x%016" PRIx64 "),\n",hash);
#else
        assert(hash==expected[edge*HT_ARC_COLS+length-1]);
#endif
    }
#ifndef HT_UPDATE_ARC_GOLDEN
    arc_title_is_mono();
    prop_face(&ht_arc_inter_lower, &ht_lv_inter_med_26, 1, 2);   // the lower face: lower arc only (mid 11 would clip stacked marks above)
    prop_face(&ht_arc_inter_prop, &ht_lv_inter_med_26, 0, 1);   // the Focus name: upper arc only
    {   // the name face carries the curve nearer the centre than the lower face (same glyphs, another mask)
        ht_scene_t g,l; ht_scene_clear(&g,0); ht_scene_clear(&l,0);
        ht_arc_title_face(&g,ht_rgb(0xeaeaf0),"Payments refactor",&ht_arc_inter_lower);
        ht_arc_title_face(&l,ht_rgb(0xeaeaf0),"Payments refactor",&ht_arc_inter_prop);
        assert(ht_arc_inter_lower.mid==11 && g.runs[0].arc_mid==11 && ht_arc_inter_prop.mid>11 && l.runs[0].arc_mid==ht_arc_inter_prop.mid);
        assert(l.runs[0].font==g.runs[0].font && l.runs[0].arc_mid!=g.runs[0].arc_mid);
    }
    sweep_face();
    puts("arc pixels: Inter Medium 26 arcs (name face and lower face) kerned, ink in r230 and inside tight bounds, unclipped, own mask per face, fitted with an ellipsis");
    puts("arc pixels: per-glyph gains scale the proportional lower arc, none/full are ht_arc_status_face to the pixel");
    printf("arc pixels: all %u upper/lower 24 px angle/color hashes preserved\n",2*HT_ARC_COLS);
#endif
}
