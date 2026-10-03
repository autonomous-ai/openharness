#include "creature_gallery.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "creature_art.inc"

typedef struct {
    const char *name;
    uint8_t cols, rows;
    uint16_t count;
    uint32_t duration;
    const ht_font_t *font;
    unsigned color;
    const char *const *frames;
    const uint32_t *ends;
} ht_gallery_clip_t;
#include "creature_clips.inc"

static const ht_gallery_clip_t *clip_for(const ht_gallery_t *g)
{
    unsigned c = g->creature % HT_CREATURES;
    return c < HT_ORIGINAL_CREATURES ? NULL : &clips[c-HT_ORIGINAL_CREATURES];
}
static uint32_t clip_phase(const ht_gallery_t *g, const ht_gallery_clip_t *c, uint32_t now)
{
    uint32_t elapsed = now-g->entered;
    unsigned mode = g->mood % HT_CREATURE_MOODS;
    if (mode == 1) return (elapsed/2) % c->duration;
    if (mode == 2) return (elapsed % c->duration)*2 % c->duration;
    if (mode == 3) return (elapsed/4) % c->duration;
    return elapsed % c->duration;
}
static unsigned clip_frame(const ht_gallery_clip_t *c, uint32_t phase)
{
    unsigned i = 0;
    while (i+1 < c->count && phase >= c->ends[i]) i++;
    return i;
}

static const char *const moods[HT_CREATURE_MOODS] = {"calm", "curious", "playful", "sleepy"};
const char *ht_gallery_name(unsigned creature)
{
    creature %= HT_CREATURES;
    return creature < HT_ORIGINAL_CREATURES ? names[creature] : clips[creature-HT_ORIGINAL_CREATURES].name;
}
const char *ht_gallery_mood(unsigned mood) { return moods[mood % HT_CREATURE_MOODS]; }

void ht_gallery_init(ht_gallery_t *g, uint32_t now)
{
    memset(g, 0, sizeof(*g));
    g->creature = HT_GALLERY_START;
    g->entered = g->tick = now;
    g->dirty = true;
}
void ht_gallery_cancel(ht_gallery_t *g)
{
    // The driver owns the quarantine and hides the damaged/wake contact's UP.
    // Waiting for that UP here would discard the next healthy gesture too.
    g->down = false;
    g->moved = false;
}
void ht_gallery_touch(ht_gallery_t *g, bool down, int x, int y, uint32_t now)
{
    if (down && !g->down) {
        g->down = true;
        g->moved = false;
        g->start_x = g->last_x = (int16_t)x;
        g->start_y = g->last_y = (int16_t)y;
        g->touched = now;
        return;
    }
    if (!g->down) return;
    // UP coordinates on the CST9217 may be zero/stale; use the last real sample.
    if (down) {
        g->last_x = (int16_t)x;
        g->last_y = (int16_t)y;
    }
    int dx = g->last_x-g->start_x, dy = g->last_y-g->start_y;
    int ax = abs(dx), ay = abs(dy);
    if (ax > 16 || ay > 16) g->moved = true;
    if (down) return;
    g->down = false;
    bool changed = false;
    // One decision per contact. Diagonal/short movements never become a tap.
    if (ax >= 52 && ax*4 >= ay*5) {
        g->creature = (uint8_t)((g->creature+(dx < 0 ? 1 : HT_CREATURES-1)) % HT_CREATURES);
        changed = true;
    } else if (ay >= 52 && ay*4 >= ax*5) {
        g->mood = (uint8_t)((g->mood+(dy < 0 ? 1 : HT_CREATURE_MOODS-1)) % HT_CREATURE_MOODS);
        changed = true;
    } else if (!g->moved && now-g->touched < 650) {
        if (clip_for(g)) g->entered = now; // Replay the visual clip, with no action.
        else {
            g->booped = true;
            g->boop_until = now+1600;
        }
        g->dirty = true;
    }
    if (changed) {
        g->entered = now;
        g->booped = false;
        g->dirty = true;
    }
}
uint32_t ht_gallery_wake(const ht_gallery_t *g, uint32_t now)
{
    const ht_gallery_clip_t *c = clip_for(g);
    if (c) {
        if (g->dirty) return 1;
        uint32_t phase = clip_phase(g,c,now);
        uint32_t remaining = c->ends[clip_frame(c,phase)]-phase;
        unsigned mode = g->mood % HT_CREATURE_MOODS;
        if (mode == 1) remaining *= 2;
        else if (mode == 2) remaining = (remaining+1)/2;
        else if (mode == 3) remaining *= 4;
        return remaining ? remaining : 1;
    }
    uint32_t step = g->mood == 3 && !g->booped ? 250 : 125;
    uint32_t elapsed = now-g->tick;
    return elapsed >= step ? 1 : step-elapsed;
}
void ht_gallery_tick(ht_gallery_t *g, uint32_t now)
{
    const ht_gallery_clip_t *c = clip_for(g);
    if (c) {
        if (clip_frame(c,clip_phase(g,c,now)) != clip_frame(c,clip_phase(g,c,g->tick)))
            g->dirty = true;
        g->tick = now;
        return;
    }
    if (g->booped && (int32_t)(now-g->boop_until) >= 0) {
        g->booped = false;
        g->dirty = true;
    }
    uint32_t step = g->mood == 3 && !g->booped ? 250 : 125;
    if (now-g->tick >= step) {
        g->tick = now;
        g->dirty = true;
    }
}
void ht_gallery_render(const ht_gallery_t *g, ht_scene_t *scene, uint32_t now)
{
    unsigned species = g->creature % HT_CREATURES;
    const ht_gallery_clip_t *clip = clip_for(g);
    if (clip) {
        uint16_t bg = ht_rgb(0x080c08);
        ht_scene_clear(scene,bg);
        const char *p = clip->frames[clip_frame(clip,clip_phase(g,clip,now))];
        int width = clip->cols*clip->font->width;
        int x = (HT_WIDTH-width)/2, y = (HT_HEIGHT-clip->rows*clip->font->height)/2;
        for (unsigned row=0; row<clip->rows; row++) {
            char line[HT_TEXT_BYTES];
            const char *end = strchr(p,'\n');
            size_t len = end ? (size_t)(end-p) : strlen(p);
            if (len >= sizeof(line)) len=sizeof(line)-1;
            memcpy(line,p,len);line[len]=0;
            ht_text(scene,x,y+(int)row*clip->font->height,width,clip->font,ht_rgb(clip->color),bg,line);
            p += len;
            if (*p == '\n') p++;
        }
        return;
    }
    unsigned mood = g->mood % HT_CREATURE_MOODS;
    uint32_t t = now-g->entered;
    unsigned q = t/125;
    bool boop = g->booped && (int32_t)(g->boop_until-now) > 0;
    bool playing = mood == 2 || boop;
    unsigned pose;
    if (playing) {
        // Anticipation, two distinct action poses, then a rest. Not a metronomic wiggle.
        static const uint8_t sequence[] = {0,0,2,2,3,3,2,3,3,0,0,1};
        pose = sequence[(boop ? (1600-(g->boop_until-now))/125 : q) % 12];
    } else if (mood == 3) {
        pose = 4+(t%4000 >= 2000);
    } else if (species == 7) {
        pose = (q%14 >= 8); // Jellyfish bell contracts, tentacles follow.
    } else if (species == 9) {
        pose = (q%16 >= 10); // Bat glides, then closes its wings.
    } else {
        pose = ((q+species*3)%29 >= 19); // Ear, tail, leaf, antenna, wing or hem.
    }
    bool blink = mood != 3 && !playing && (q%43 == 20 || q%71 == 47);
    char eye = mood == 3 || blink ? '-' : playing ? '^' : 'o';
    char mouth = species == 3 ? 'v' : species == 4 ? '_' : species == 8 ? '=' : 'w';
    if (species == 1 || species == 5 || species == 7) mouth = '_';
    if (mood == 1) mouth = 'o';
    if (playing) mouth = species == 3 ? 'v' : 'w';
    if (mood == 3) mouth = (t%4000 < 2000) ? '_' : 'o';
    int bob = 0;
    if (species == 5 || species == 7 || species == 9) {
        static const int8_t drift[] = {0,-1,-2,-3,-2,-1,0,1,2,3,2,1};
        bob = drift[(t/375)%12];
    }
    uint16_t bg = ht_rgb(0x080c08), fg = ht_rgb(0xc5ec9a), dim = ht_rgb(0x849079);
    ht_scene_clear(scene, bg);

    // Stable 25-cell runs preserve alignment between poses and enable glyph-level damage.
    for (unsigned row = 0; row < HT_CREATURE_ROWS; row++) {
        char line[HT_CREATURE_COLS+1];
        memcpy(line, art[species][pose][row], sizeof(line));
        for (unsigned c = 0; c < HT_CREATURE_COLS; c++) {
            if (line[c] == '%') line[c] = mood == 1 && !blink ? ((q/12+c)%2 ? 'O' : 'o') : eye;
            else if (line[c] == '?') line[c] = mouth;
        }
        ht_text(scene, (HT_WIDTH-HT_CREATURE_COLS*14)/2, 107+(int)row*28+bob,
                HT_CREATURE_COLS*14, &ht_ascii_art_28, fg, bg, line);
    }
    // The accents are also ordinary ASCII glyphs, never sprites or vector drawing.
    const char *effect = " ";
    if (mood == 1 && !boop) effect = q%24 < 17 ? "?" : ".";
    if (mood == 3 && !boop) effect = t%3000 < 1500 ? "z" : "Z";
    if (boop) effect = "*";
    ht_text(scene, 366, 112, 28, &ht_ascii_art_28, dim, bg, effect);
}
bool ht_gallery_take(ht_gallery_t *g, ht_scene_t *scene, uint32_t now)
{
    if (!g->dirty) return false;
    g->dirty = false;
    ht_gallery_render(g, scene, now);
    return true;
}
