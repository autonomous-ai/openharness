// The incremental DMA result must exactly match a fresh full render, including removed text.
#include "../main/ui/habitat/terminal.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint16_t full[HT_WIDTH * HT_HEIGHT], incremental[HT_WIDTH * HT_HEIGHT];
static uint16_t scratch[HT_WIDTH * HT_HEIGHT];
static uint32_t rng = 0x5eed;
static unsigned next(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }

static void transition(const ht_scene_t *before, const ht_scene_t *after)
{
    ht_damage_t d;
    ht_damage(before, after, &d);
    uint32_t pixels = 0;
    for (int i = 0; i < d.count; i++) {
        ht_rect_t r = d.rect[i];
        assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= HT_WIDTH && r.y + r.h <= HT_HEIGHT);
        assert(!((r.x | r.y | r.w | r.h) & 1));
        assert(r.w > 0 && r.h > 0);
        pixels += r.w * r.h;
        ht_raster(after, r, scratch);
        for (int y = 0; y < r.h; y++)
            memcpy(incremental + (r.y+y)*HT_WIDTH+r.x, scratch+y*r.w, (size_t)r.w*2);
    }
    assert(pixels == d.pixels);
    ht_raster(after, (ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT}, full);
    assert(memcmp(incremental, full, sizeof(full)) == 0);
}

static void punctuation_checks(void)
{
    static const char *unicode[]={"‐","‑","‒","–","—","―","−","‘","’","‚","‛","“","”","„","‟"};
    static const char *ascii[]={"-","-","-","-","-","-","-","'","'","'","'","\"","\"","\"","\""};
    const ht_font_t *fonts[]={&ht_mono_16,&ht_mono_20,&ht_mono_24,&ht_mono_28,&ht_pixel_40};
    for (unsigned f=0;f<sizeof fonts/sizeof fonts[0];f++) {
        for (unsigned i=0;i<sizeof unicode/sizeof unicode[0];i++) {
            ht_scene_t a,b; ht_scene_clear(&a,0); ht_scene_clear(&b,0);
            ht_text(&a,80,100,fonts[f]->width,fonts[f],0xffff,0,unicode[i]);
            ht_text(&b,80,100,fonts[f]->width,fonts[f],0xffff,0,ascii[i]);
            assert(!strcmp(a.runs[0].text,unicode[i])); // storage remains exact
            assert(ht_can_display(unicode[i],fonts[f],fonts[f]->width,1));
            ht_raster(&a,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
            ht_raster(&b,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
            assert(!memcmp(full,scratch,sizeof full));
            ht_damage_t damage; ht_damage(&a,&b,&damage); assert(!damage.count);
            ht_scene_clear(&b,0);
            ht_text(&b,80,100,fonts[f]->width,fonts[f],0xffff,0,"?");
            ht_raster(&b,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
            assert(memcmp(full,scratch,sizeof full)); // no fallback question mark
        }
    }
}

static void vietnamese_checks(void)
{
    // Every codepoint Vietnamese needs beyond Latin-1: the 0x1EA0 block and the eight that live
    // outside it. Each must be one cell, must not fall back to '?', and must keep its exact bytes
    // in the scene — the wire text is never rewritten, only the cell it is drawn from changes.
    static const uint32_t scattered[]={0x102,0x103,0x110,0x111,0x1a0,0x1a1,0x1af,0x1b0};
    const ht_font_t *fonts[]={&ht_mono_16,&ht_mono_20,&ht_mono_24,&ht_mono_28};
    for (unsigned f=0;f<sizeof fonts/sizeof fonts[0];f++) {
        for (unsigned i=0;i<0x5a+sizeof scattered/sizeof scattered[0];i++) {
            uint32_t cp = i<0x5a ? 0x1ea0+i : scattered[i-0x5a];
            char utf8[4]={(char)(0xe0|(cp>>12)),(char)(0x80|((cp>>6)&0x3f)),(char)(0x80|(cp&0x3f)),0};
            if (cp<0x800) { utf8[0]=(char)(0xc0|(cp>>6)); utf8[1]=(char)(0x80|(cp&0x3f)); utf8[2]=0; }
            assert(ht_can_display(utf8,fonts[f],fonts[f]->width,1));
            ht_scene_t a,b; ht_scene_clear(&a,0); ht_scene_clear(&b,0);
            ht_text(&a,80,100,fonts[f]->width,fonts[f],0xffff,0,utf8);
            assert(!strcmp(a.runs[0].text,utf8)); // storage remains exact
            ht_raster(&a,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
            ht_text(&b,80,100,fonts[f]->width,fonts[f],0xffff,0,"?");
            ht_raster(&b,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
            assert(memcmp(full,scratch,sizeof full)); // a real glyph, not the fallback
        }
    }
    // The gate the work was specified against, and two more shapes a recap actually takes.
    assert(ht_can_display("Đã sửa xong phần flush",&ht_mono_28,384,4));
    assert(ht_can_display("Lượng bộ nhớ đã giảm",&ht_mono_20,348,6));
    assert(ht_can_display("Kiểm tra lại các tuỳ chọn",&ht_mono_24,420,4));
    // The horned pair is the one place a missing tail entry would still look plausible.
    ht_scene_t horn,plain; ht_scene_clear(&horn,0); ht_scene_clear(&plain,0);
    ht_text(&horn,80,100,ht_mono_28.width,&ht_mono_28,0xffff,0,"ư");
    ht_text(&plain,80,100,ht_mono_28.width,&ht_mono_28,0xffff,0,"u");
    ht_raster(&horn,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
    ht_raster(&plain,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
    assert(memcmp(full,scratch,sizeof full));
    // The pixel face carries no Vietnamese and must say so rather than draw a wrong cell.
    assert(!ht_can_display("đã",&ht_pixel_40,400,4));
}

static void inline_arrow_checks(void)
{
    const ht_font_t *fonts[]={&ht_mono_20,&ht_mono_28};
    const ht_font_t *arrows[][2]={{&ht_right_20,&ht_open_20},{&ht_right_28,&ht_open_28}};
    const char *marks[]={"→","↗"};
    for(unsigned size=0;size<2;size++) for(unsigned mark=0;mark<2;mark++) {
    const int x = 80, y = 100, cell = fonts[size]->width;
    assert(arrows[size][mark]->width==cell && arrows[size][mark]->height==fonts[size]->height);
    ht_scene_t inline_text, separate, question;
    ht_scene_clear(&inline_text, 0);
    ht_scene_clear(&separate, 0);
    ht_scene_clear(&question, 0);
    char text[32]; snprintf(text,sizeof text,"Open %s now",marks[mark]);
    ht_text(&inline_text, x, y, cell * 10, fonts[size], 0xffff, 0, text);
    ht_text(&separate, x, y, cell * 5, fonts[size], 0xffff, 0, "Open ");
    ht_text(&separate, x + cell * 5, y, cell, arrows[size][mark], 0xffff, 0, marks[mark]);
    ht_text(&separate, x + cell * 6, y, cell * 4, fonts[size], 0xffff, 0, " now");
    ht_text(&question, x, y, cell * 10, fonts[size], 0xffff, 0, "Open ? now");
    assert(!strcmp(inline_text.runs[0].text, text));
    assert(ht_can_display(text, fonts[size], cell * 10, 1));
    ht_raster(&inline_text, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, full);
    ht_raster(&separate, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, scratch);
    assert(!memcmp(full, scratch, sizeof full));
    ht_raster(&question, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, scratch);
    assert(memcmp(full, scratch, sizeof full));
    // The damage pass must not mistake the arrow for the old fallback glyph.
    ht_damage_t d; ht_damage(&question, &inline_text, &d);
    assert(d.count && d.pixels >= (uint32_t)(cell * fonts[size]->height));
    transition(NULL, &question);
    transition(&question, &inline_text);
    transition(&inline_text, &question);
    // Rendering a clipped portion uses the same pixels and never leaves the atlas.
    ht_rect_t clip = {x + cell * 5 + 2, y + 4, 6, 16};
    ht_raster(&inline_text, clip, full);
    ht_raster(&separate, clip, scratch);
    assert(!memcmp(full, scratch, (size_t)clip.w * clip.h * sizeof *full));
    }
    // Curved titles have a separate cached-mask path and must accept → too.
    ht_scene_t a,b; ht_scene_clear(&a,0); ht_scene_clear(&b,0);
    ht_arc_title(&a,0xffff,"Egg → Tim"); ht_arc_title(&b,0xffff,"Egg ? Tim");
    transition(NULL,&a); memcpy(scratch,full,sizeof full);
    ht_raster(&b,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
    assert(memcmp(full,scratch,sizeof full));
    transition(&a,&b); transition(&b,&a);
    puts("Inline arrows: right/diagonal, native 20/28 px cells, curved label, no fallback or atlas overread PASS");
}


static void bell_checks(void)
{
    const ht_font_t *faces[]={&ht_mono_20,&ht_mono_28};
    const char *labels[]={HT_BELL, HT_BELL " 1", HT_BELL " 9", HT_BELL " 10", HT_BELL " 32", HT_BELL};
    for(unsigned f=0;f<2;f++) {
        ht_scene_t a,b;
        ht_scene_clear(&a,ht_rgb(0x191919));
        ht_center(&a,399,faces[f],ht_rgb(0x777777),HT_BELL);
        transition(NULL,&a);
        assert(ht_can_display(HT_BELL,faces[f],faces[f]->width,1));
        b=a;strcpy(b.runs[0].text,"?");ht_raster(&b,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
        assert(memcmp(full,scratch,sizeof full)); // authored bell, never fallback '?'
        for(unsigned i=0;i<sizeof labels/sizeof labels[0];i++) {
            ht_scene_clear(&b,a.background);ht_center(&b,399,faces[f],i==5?ht_rgb(0x777777):0xffff,labels[i]);
            transition(&a,&b);a=b;
        }
        ht_scene_clear(&b,a.background);transition(&a,&b); // no residual count pixels
    }
    puts("bell glyph: both native cells, no fallback, empty/active/count/clear incremental raster PASS");
}

static void notification_marks(void)
{
    const char *marks[] = {HT_DONE, "?", HT_FAILED};
    ht_scene_t a, b;
    ht_scene_clear(&a, ht_rgb(0x191919));
    transition(NULL, &a);
    for (unsigned i = 0; i < sizeof marks / sizeof marks[0]; i++) {
        ht_scene_clear(&b, a.background);
        char text[32]; snprintf(text, sizeof text, "%s Release", marks[i]);
        assert(ht_can_display(text, &ht_mono_28, 170, 1));
        ht_center(&b, 90, &ht_mono_28, 0xffff, text);
        transition(&a, &b); a = b;
        if (i != 1) {
            strcpy(b.runs[0].text, "? Release");
            ht_raster(&b, (ht_rect_t){0, 0, HT_WIDTH, HT_HEIGHT}, scratch);
            assert(memcmp(full, scratch, sizeof full));
        }
    }
    ht_scene_clear(&b, a.background); transition(&a, &b);
    puts("Inbox status: check/question/cross glyphs, no fallback, incremental transitions PASS");
}

static void shimmer_checks(void)
{
    // Exercise the production damage + raster path, including skipped frames,
    // rest, wake, palette changes and the 32-bit clock rollover.
    for (uint32_t t = 0; t < 4096; t++) {
        uint32_t wait = ht_shimmer_wake_ms(t);
        assert(wait >= 1 && wait <= 768);
        assert(ht_shimmer_phase(t + wait) != ht_shimmer_phase(t));
        for (uint32_t i = 1; i < wait; i++)
            assert(ht_shimmer_phase(t + i) == ht_shimmer_phase(t));
    }
    assert(ht_shimmer_phase(UINT32_MAX) == 21 && ht_shimmer_wake_ms(UINT32_MAX) == 1);
    assert(ht_shimmer_phase(0) == 1);
    const char *labels[] = {"W", "Working", "Coalescing", "Messages to be submitted after", "caf\xc3\xa9", "                                "};
    uint32_t largest = 0;
    for (int edge=0;edge<2;edge++) for (unsigned label = 0; label < sizeof labels / sizeof labels[0]; label++) {
        ht_scene_t a, b;
        ht_scene_clear(&a, ht_rgb(0x181818));
        ht_arc_title(&a, ht_rgb(0xefe7de), edge ? "Stable pane name" : labels[label]);
        ht_arc_status(&a, ht_rgb(0xefe7de), edge ? labels[label] : "Stable bottom");
        transition(NULL, &a);
        uint32_t builds = ht_arc_cache_builds();
        for (unsigned frame = 0; frame < 100; frame++) {
            b = a;
            b.runs[edge].shimmer = frame < 22 ? frame : next() % 22;
            ht_damage_t damage; ht_damage(&a, &b, &damage);
            for (int i = 0; i < damage.count; i++) assert(edge ? damage.rect[i].y >= 320 : damage.rect[i].y + damage.rect[i].h <= 144);
            if (a.runs[edge].shimmer && b.runs[edge].shimmer && damage.pixels > largest)
                largest = damage.pixels;
            transition(&a, &b);
            assert(ht_arc_cache_builds() == builds); // No rerotation during a sweep.
            a = b;
        }
        b = a; b.runs[edge].fg = ht_rgb(0xad9bb5); transition(&a, &b); a = b;
        b.runs[edge].shimmer = 0; transition(&a, &b);
        assert(ht_arc_cache_builds() == builds);
    }
    assert(largest < HT_WIDTH * HT_HEIGHT / 4);
    printf("Curved shimmer: cached glyphs, clipped incremental redraws, rest/wake/wrap; peak dirty area %u pixels PASS\n", largest);
}

static void arc_checks(void)
{
    const char *names[] = {"", "hn", "Deploy latest firmware", "Mobile app build and deploy",
        "12345678901234567890123456789012", "A name that extends well beyond the available arc",
        "caf\xc3\xa9 \xe2\x80\x94 \xe2\x80\x9cReady\xe2\x80\x9d \xe2\x86\x97", "a\xf0\x9f"};
    ht_scene_t a, b;
    ht_scene_clear(&a, 0); transition(NULL, &a);
    for (int edge = 0; edge < 2; edge++) for (unsigned n = 0; n < sizeof names / sizeof names[0]; n++) {
        ht_scene_clear(&b, 0);
        if (edge) ht_arc_status(&b, 0xffff, names[n]); else ht_arc_title(&b, 0xffff, names[n]);
        if (!names[n][0]) { assert(!b.count); transition(&a, &b); a = b; continue; }
        assert(b.count == 1 && b.runs[0].arc);
        const char *p = b.runs[0].text; int count = 0;
        while (*p) { ht_utf8_next(&p); count++; }
        assert(count <= HT_ARC_COLS);
        transition(&a, &b); a = b;
        uint32_t builds = ht_arc_cache_builds();
        // Arbitrary subregions must be pixel-identical to full rendering.
        // The output guard catches an accidental stride based on the full cache.
        for (int i = 0; i < 50; i++) {
            ht_rect_t r = {(int)(next()%466), (int)(next()%466), 1+next()%90, 1+next()%35};
            if (r.x+r.w > HT_WIDTH) r.w = HT_WIDTH-r.x;
            if (r.y+r.h > HT_HEIGHT) r.h = HT_HEIGHT-r.y;
            uint32_t size = r.w*r.h; scratch[size] = 0xabc1;
            ht_raster(&b, r, scratch);
            assert(scratch[size] == 0xabc1);
            for (int y = 0; y < r.h; y++)
                assert(!memcmp(scratch+y*r.w, full+(y+r.y)*HT_WIDTH+r.x, r.w*2));
        }
        assert(ht_arc_cache_builds() == builds); // no rotation on animation/strip redraw
        b.runs[0].fg = ht_rgb(0x999999);
        transition(&a, &b); a = b;
        assert(ht_arc_cache_builds() == builds); // recoloring reuses coverage
        ht_damage_t d; ht_damage(&a, &a, &d); assert(!d.count);
        // Straight/curved/removed names clear all old pixels in either direction.
        ht_scene_clear(&b, 0); ht_center(&b, 41, &ht_mono_20, 0xffff, names[n]);
        transition(&a, &b); a = b;
        ht_scene_clear(&b, 0); ht_arc_title(&b, 0xffff, names[n]);
        transition(&a, &b); a = b;
    }
    ht_scene_clear(&b, 0); transition(&a, &b);
    ht_scene_clear(&a, 0); ht_arc_title(&a, 0xffff, "Agent A"); ht_arc_status(&a, 0xffff, "[1] Coalescing...");
    transition(NULL, &a); uint32_t builds = ht_arc_cache_builds();
    for (int i = 0; i < 40; i++) transition(&a, &a);
    assert(ht_arc_cache_builds() == builds); // independent top/bottom cache keys never evict each other
    puts("arc: upper/lower clipped/full comparisons; UTF-8, removal, recoloring and warm-cache reuse passed");
}

static void lock_dot_checks(void)
{
    assert(ht_lock_dot.first=='o'&&ht_lock_dot.last=='o');
    assert(ht_lock_dot.width==ht_pixel_40.width&&ht_lock_dot.height==ht_pixel_40.height);
    size_t bytes=((size_t)ht_lock_dot.width*ht_lock_dot.height+3)/4;
    assert(!memcmp(ht_lock_dot.pixels,ht_pixel_40.pixels+('o'-ht_pixel_40.first)*bytes,bytes));
    ht_scene_t original,compact;
    ht_scene_clear(&original,0);ht_scene_clear(&compact,0);
    for(int i=0;i<9;i++) {
        int x=137+i%3*80,y=156+i/3*74;
        uint16_t fg=ht_rgb(i%2?0xb9ed80:0x969f91);
        ht_text(&original,x,y,40,&ht_pixel_40,fg,0,"o");
        ht_text(&compact,x,y,40,&ht_lock_dot,fg,0,"o");
    }
    ht_raster(&original,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
    ht_raster(&compact,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
    assert(!memcmp(full,scratch,sizeof full));
    puts("lock dot: exact old glyph bytes and nine-dot screen; 45120 unused font bytes removed");
}

static size_t utf8_encode(char *p, unsigned cp)
{
    if(cp<0x80) { p[0]=(char)cp; return 1; }
    if(cp<0x800) { p[0]=(char)(0xc0|(cp>>6));p[1]=(char)(0x80|(cp&63));return 2; }
    if(cp<0x10000) { p[0]=(char)(0xe0|(cp>>12));p[1]=(char)(0x80|((cp>>6)&63));p[2]=(char)(0x80|(cp&63));return 3; }
    p[0]=(char)(0xf0|(cp>>18));p[1]=(char)(0x80|((cp>>12)&63));p[2]=(char)(0x80|((cp>>6)&63));p[3]=(char)(0x80|(cp&63));return 4;
}
static void display_text_checks(void)
{
    const char *cases[][2]={
        {"Swipes need about ⅓ the previous travel.","Swipes need about 1/3 the previous travel."},
        {"1⅓ + ⅔ = 2", "1 1/3 + 2/3 = 2"}, {"⅓⅔", "1/3 2/3"}, {"⅓2", "1/3 2"},
        {"½ ¼ ¾ ⅐ ⅑ ⅒ ⅕ ⅖ ⅗ ⅘ ⅙ ⅚ ⅛ ⅜ ⅝ ⅞", "1/2 1/4 3/4 1/7 1/9 1/10 1/5 2/5 3/5 4/5 1/6 5/6 1/8 3/8 5/8 7/8"},
        {"≤ ≥ ≠ ≮ ≯ ≰ ≱ ≈", "<= >= != !< !> !<= !>= ~="},
        {"⇒ ↔ ⇔", "=> <-> <=>"}, {"Egg → Tim ↗", "Egg → Tim ↗"},
        {"x₂ xⁿ 𝟠 ① ＡＢＣ ﬁx ﬃ", "x_2 x^n 8 1 ABC fix ffi"},
        {"“café”—naïve ✓ ✗", "“café”—naïve ✓ ✗"},
        {"✅ ❌ ⚠️ 🔔", "[ok] [x] [!] [bell]"},
        {"a\u00a0b\u2009c\u200bd", "a b cd"},
        {"👾 猫", "[U+1F47E] [U+732B]"},
        {"Literal ? stays ?", "Literal ? stays ?"},
        {"\xed\xa0\x80", "[U+FFFD]"}, {"\xf4\x90\x80\x80", "[U+FFFD]"},
        {"\xe0\x80\x80", "[U+FFFD]"}, {"\xf0\x9f", "[U+FFFD]"},
    };
    char actual[256];
    for(unsigned i=0;i<sizeof cases/sizeof cases[0];i++) {
        assert(ht_display_text(actual,sizeof actual,cases[i][0],&ht_mono_28));
        if(strcmp(actual,cases[i][1])) { fprintf(stderr,"Fallback mismatch: %s -> %s (wanted %s)\n",cases[i][0],actual,cases[i][1]); abort(); }
        assert(ht_can_display(actual,&ht_mono_28,400,256));
        char again[256]; ht_display_text(again,sizeof again,actual,&ht_mono_28);
        assert(!strcmp(actual,again)); // normalization is idempotent
        for(size_t cap=1;cap<100;cap++) {
            unsigned char guarded[104]; memset(guarded,0xa5,sizeof guarded);
            ht_display_text((char *)guarded+1,cap,cases[i][0],&ht_mono_28);
            assert(guarded[0]==0xa5 && guarded[cap+1]==0xa5);
            assert(strlen((char *)guarded+1)<cap);
            assert(ht_can_display((char *)guarded+1,&ht_mono_28,400,256));
        }
        ht_scene_t raw,converted;
        ht_scene_clear(&raw,0); ht_scene_clear(&converted,0);
        ht_wrap(&raw,63,100,340,6,0,&ht_mono_28,0xffff,cases[i][0]);
        ht_wrap(&converted,63,100,340,6,0,&ht_mono_28,0xffff,cases[i][1]);
        ht_raster(&raw,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
        ht_raster(&converted,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
        assert(!memcmp(full,scratch,sizeof full));
        transition(NULL,&raw); transition(&raw,&converted);
        ht_scene_clear(&raw,0); ht_scene_clear(&converted,0);
        ht_arc_title(&raw,0xffff,cases[i][0]); ht_arc_title(&converted,0xffff,cases[i][1]);
        ht_raster(&raw,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
        ht_raster(&converted,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},scratch);
        assert(!memcmp(full,scratch,sizeof full));
    }
    assert(!ht_display_text(NULL,0,"⅓",&ht_mono_28));
    assert(ht_text_rows("a ⅓ b",&ht_mono_28,3*ht_mono_28.width)==3);
    // A readable fallback never makes unsupported approval labels approvable.
    assert(!ht_can_display("Approve ≤ ⅓?",&ht_mono_28,340,4));
    assert(!ht_can_display("¼",&ht_mono_28,ht_mono_28.width,1));
    assert(ht_can_display("¼",&ht_mono_28,3*ht_mono_28.width,1));
    assert(!ht_can_display("\xed\xa0\x80",&ht_mono_28,340,4));
    for(unsigned cp=1;cp<=0x10ffff;cp++) {
        if(cp>=0xd800 && cp<=0xdfff) continue;
        char source[5];source[utf8_encode(source,cp)]=0;
        assert(ht_display_text(actual,sizeof actual,source,&ht_mono_28));
        assert(ht_can_display(actual,&ht_mono_28,340,8));
        // Question-mark presentation/fullwidth forms legitimately normalize
        // to '?'; no unrelated scalar may silently turn into that glyph.
        assert(cp=='?' || cp==0xfe16 || cp==0xfe56 || cp==0xff1f || strcmp(actual,"?"));
    }
    // Random bytes exercise invalid/truncated UTF-8 and very small line widths.
    for(unsigned trial=0;trial<3000;trial++) {
        char source[64];for(unsigned i=0;i<sizeof source-1;i++)source[i]=(char)(1+next()%255);
        source[sizeof source-1]=0;
        ht_display_text(actual,sizeof actual,source,&ht_mono_28);
        assert(ht_can_display(actual,&ht_mono_28,340,256));
        assert(ht_text_rows(source,&ht_mono_28,17*(1+trial%24))<=63);
    }
    puts("Display fallback: all Unicode scalars, 3000 malformed-byte strings, bounded copies, fraction/math meaning, wrap/arc pixels and strict approvals PASS");
}

int main(void)
{
    lock_dot_checks();
    arc_checks();
    punctuation_checks();
    vietnamese_checks();
    inline_arrow_checks();
    bell_checks();
    notification_marks();
    shimmer_checks();
    display_text_checks();
    ht_scene_t a = {0}, b = {0};
    assert(ht_text_rows("one\ntwo\nthree",&ht_mono_20,348)==3);
    assert(ht_text_rows("abcdefghi",&ht_mono_20,ht_mono_20.width*3)==3);
    assert(ht_text_rows("",&ht_mono_20,348)==0);
    assert(ht_text_rows("cannot fit",&ht_mono_20,1)==0);
    ht_scene_clear(&a, ht_rgb(0x080c08));
    ht_text(&a, 70, 121, 324, &ht_mono_20, ht_rgb(0xb9ed80), a.background, "A complete thread name");
    transition(NULL, &a);
    ht_damage_t d;
    ht_damage(&a, &a, &d);
    assert(d.count == 0 && d.pixels == 0);
    ht_scene_clear(&b, a.background);
    ht_text(&b, 70, 121, 324, &ht_mono_20, ht_rgb(0xb9ed80), b.background, "A");
    transition(&a, &b);
    a = b;
    ht_scene_clear(&b, a.background);
    transition(&a, &b); // removed run clears its old pixels
    a = b;
    static const char *labels[] = {"", "3 working", "1 needs you", "caf\xc3\xa9", "=^o.o^=", "\xf0\x9f\x90\x88 cat", "short", "A longer line of work"};
    for (int frame = 0; frame < 500; frame++) {
        ht_scene_clear(&b, frame % 23 ? a.background : ht_rgb(next() & 0xffffff));
        unsigned count = next() % HT_RUNS;
        for (unsigned i = 0; i < count; i++) {
            int x = (int)(next()%560)-45, y = (int)(next()%540)-40;
            const ht_font_t *font = next()&1 ? &ht_mono_20 : &ht_mono_16;
            ht_text(&b, x, y, 1+next()%390, font, ht_rgb(next()&0xffffff),
                    next()%5 ? b.background : ht_rgb(0x263720), labels[next()%8]);
        }
        transition(&a, &b);
        a = b;
    }
    ht_scene_clear(&b, 0);
    assert(ht_wrap(&b, 0, 0, 1, 10, 0, &ht_mono_20, 0xffff, "no infinite loop") == 0);
    assert(ht_wrap(&b, 0, 0, 36, 3, 1, &ht_mono_20, 0xffff, "one two three four") > 0);
    const char *truncated = "\xf0\x9f";
    assert(ht_utf8_next(&truncated) == 0xfffd);
    for (int i=0; i<3 && *truncated; i++) ht_utf8_next(&truncated);
    assert(*truncated == 0);
    assert(ht_can_display("A short answer",&ht_mono_20,348,6));
    assert(!ht_can_display("one\ntwo\nthree\nfour",&ht_mono_20,348,3));
    assert(!ht_can_display("\xf0\x9f\x90\x88",&ht_mono_20,348,3));
    assert(!ht_can_display("this is long",&ht_mono_20,36,1));
    // A compact Unicode atlas has neither space nor '?'. Neither may index
    // before the atlas. Unsupported codepoints are empty cells; damage agrees.
    static const uint8_t block_pixels[] = {255,255,255,255};
    const ht_font_t blocks = {0x2588,0x2588,4,4,block_pixels};
    assert(ht_can_display("█ █",&blocks,24,1));
    assert(!ht_can_display("?",&blocks,24,1));
    ht_scene_clear(&a,0);
    ht_text(&a,10,10,24,&blocks,0xffff,0,"█ ?█");
    transition(NULL,&a);
    ht_scene_clear(&b,0);
    ht_text(&b,10,10,24,&blocks,0xffff,0,"█ A█");
    ht_damage(&a,&b,&d);assert(d.count==0);
    transition(&a,&b);
    a=b;
    ht_scene_clear(&b,0);
    ht_text(&b,10,10,24,&blocks,0xffff,0," █ ");
    transition(&a,&b);
    puts("terminal: 503 incremental/full-frame equivalence checks; UTF-8, clipping, bounds, wrap passed");
    return 0;
}
