#include "illustrated.h"
#include "../../../assets/companions/companion_art.h"
#include <assert.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "miniz.h"
#else
#include <stdlib.h>
#include <zlib.h>
#endif

#ifdef HABITAT_NO_COMPANION_ART
/*
 * A Focus-only build carries no artwork (main/CMakeLists.txt): the pack is empty, no cache is
 * allocated, and a sprite that names an asset is dropped rather than decoded. Nothing selects an
 * illustrated companion in that build, so this is the belt to HABITAT_FOCUS_ONLY's braces.
 */
static const uint8_t companion_pack_start[1], *const companion_pack_end = companion_pack_start;
#else
extern const uint8_t companion_pack_start[] __asm__("_binary_companion_art_pack_start");
extern const uint8_t companion_pack_end[] __asm__("_binary_companion_art_pack_end");
#endif
typedef struct { uint8_t *memory; uint32_t revision; ht_sprite_t sprite; } cache_t;
static cache_t cache[COMPANION_ROLES];

// Shrink the selected layer inside its fixed cache. Source alpha stays intact
// while RGB is written forwards; the consumed material planes hold output alpha.
// Sampling premultiplied colour avoids a dark fringe around transparent edges.
static void shrink(uint8_t *memory, unsigned sw, unsigned sh, unsigned dw, unsigned dh)
{
    assert(dw && dh && dw <= sw && dh <= sh);
    if (sw == dw && sh == dh) return;
    size_t source_count = (size_t)sw * sh, target_count = (size_t)dw * dh;
    const uint8_t *alpha = memory + source_count * 2;
    uint8_t *target_alpha = memory + source_count * 3;
    for (unsigned y = 0; y < dh; y++) {
        unsigned fy = ((2*y+1)*sh*128/dh)-128, sy = fy/256;
        unsigned wy = fy%256, ny = sy+1 < sh ? sy+1 : sy;
        for (unsigned x = 0; x < dw; x++) {
            unsigned fx = ((2*x+1)*sw*128/dw)-128, sx = fx/256;
            unsigned wx = fx%256, nx = sx+1 < sw ? sx+1 : sx;
            size_t positions[4] = {sy*sw+sx, sy*sw+nx, ny*sw+sx, ny*sw+nx};
            unsigned weights[4] = {(256-wx)*(256-wy), wx*(256-wy), (256-wx)*wy, wx*wy};
            uint64_t channels[3] = {0}; unsigned a = 0;
            for (unsigned n=0;n<4;n++) {
                size_t p=positions[n];
                unsigned v=(memory[p*2]<<8)|memory[p*2+1], aw=alpha[p]*weights[n];
                a+=aw;
                channels[0]+=(uint64_t)(v>>11)*aw;
                channels[1]+=(uint64_t)((v>>5)&63)*aw;
                channels[2]+=(uint64_t)(v&31)*aw;
            }
            unsigned v = a ? ((channels[0]+a/2)/a)<<11 | ((channels[1]+a/2)/a)<<5 | (channels[2]+a/2)/a : 0;
            size_t p=(size_t)y*dw+x;
            memory[p*2]=v>>8; memory[p*2+1]=v;
            target_alpha[p]=(a+32768)/65536;
        }
    }
    memmove(memory+target_count*2, target_alpha, target_count);
}

void ht_illustrated_init(void)
{
#ifdef HABITAT_NO_COMPANION_ART
    return;
#endif
    for (unsigned i = 0; i < COMPANION_ROLES; i++) {
        if (cache[i].memory) continue;
#ifdef ESP_PLATFORM
        cache[i].memory = heap_caps_malloc(companion_capacity[i], MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
        cache[i].memory = malloc(companion_capacity[i]);
#endif
        assert(cache[i].memory);
    }
}

void ht_illustrated_prepare(ht_scene_t *scene)
{
    const companion_asset_t *selected[COMPANION_ROLES] = {0};
    for (unsigned i = 0; i < scene->count; i++) {
        ht_sprite_t *sprite = &scene->runs[i].sprite;
        if (!sprite->asset) continue;
#ifdef HABITAT_NO_COMPANION_ART
        *sprite = (ht_sprite_t){0};
        continue;
#endif
        const companion_asset_t *asset = sprite->asset;
        assert(asset->role < COMPANION_ROLES);
        unsigned role = asset->role;
        assert(!selected[role] || selected[role]->offset == asset->offset);
        selected[role] = asset;
        cache_t *c = &cache[role];
        assert(c->memory);
        if (c->revision != sprite->revision) {
            size_t length = (size_t)(companion_pack_end - companion_pack_start);
            size_t raw = (size_t)asset->width * asset->height * 9;
            assert(asset->offset <= length && asset->length <= length - asset->offset);
            assert(raw <= companion_capacity[role]);
#ifdef ESP_PLATFORM
            size_t got = tinfl_decompress_mem_to_mem(c->memory, companion_capacity[role],
                companion_pack_start + asset->offset, asset->length, TINFL_FLAG_PARSE_ZLIB_HEADER);
            assert(got == raw);
#else
            uLongf got = companion_capacity[role];
            int result = uncompress(c->memory, &got, companion_pack_start + asset->offset, asset->length);
            assert(result == Z_OK && got == raw);
#endif
            size_t count=raw/9;
            uint8_t colour=sprite->colour, mark=sprite->mark;
            for (size_t px=0;px<count;px++) {
                unsigned v=(c->memory[px*2]<<8)|c->memory[px*2+1];
                unsigned rgb[3]={(v>>11)*255/31,((v>>5)&63)*255/63,(v&31)*255/31};
                unsigned shade=c->memory[count*3+px],weight=c->memory[count*4+px];
                for (unsigned ch=0;ch<3;ch++) {
                    if (colour<6 && sprite->species<10) {
                        int dark=companion_palettes[sprite->species][colour][0][ch];
                        int light=companion_palettes[sprite->species][colour][1][ch];
                        int value=(int)rgb[ch]*(255-weight)+dark*weight+(light-dark)*shade+127;
                        rgb[ch]=value<0?0:(unsigned)(value/255)>255?255:(unsigned)(value/255);
                    }
                    if (mark>=1 && mark<=4) rgb[ch]=rgb[ch]*(255-c->memory[count*(4+mark)+px]*100/255)/255;
                }
                v=(rgb[0]>>3)<<11|(rgb[1]>>2)<<5|(rgb[2]>>3);
                c->memory[px*2]=v>>8;c->memory[px*2+1]=v;
            }
            shrink(c->memory, asset->width, asset->height, sprite->width, sprite->height);
            count=(size_t)sprite->width*sprite->height;
            uint32_t revision=sprite->revision;
            c->sprite = (ht_sprite_t){.pixels=(const uint16_t *)c->memory,
                .alpha=c->memory + count*2, .asset=asset, .revision=revision,
                .species=sprite->species,.colour=colour,.mark=mark,
                .width=sprite->width, .height=sprite->height};
            c->revision = revision;
        }
        *sprite = c->sprite;
    }
}
