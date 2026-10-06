#include "pro_living.h"
#include "pro_living_assets.h"
#include "esp_heap_caps.h"
#include "miniz.h"
#include <assert.h>
#include <string.h>

extern const uint8_t living_start[] asm("_binary_pro_living_pack_start");
extern const uint8_t living_end[] asm("_binary_pro_living_pack_end");
static const uint8_t living_tag;
static uint8_t *packed, *poses[2], *output;
static unsigned loaded[2] = {99,99};
static uint32_t rendered_revision;
static unsigned rendered_size;

// One fixed working set. No allocations in animation, switching or UI locks.
void pro_living_init(void)
{
    if (output) return;
    packed=heap_caps_malloc(PRO_LIVING_RAW_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    for (unsigned i=0;i<2;i++)
        poses[i]=heap_caps_malloc(PRO_LIVING_SOURCE*PRO_LIVING_SOURCE*3,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    output=heap_caps_malloc(PRO_LIVING_MAX_SIZE*PRO_LIVING_MAX_SIZE*3,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    assert(packed && poses[0] && poses[1] && output);
}

void pro_living_image(ht_scene_t *scene,unsigned character,unsigned mood,unsigned frame,
                      int x,int y,unsigned size)
{
    assert(character<PRO_LIVING_CHARACTERS && mood<PRO_LIVING_MOODS);
    assert(size && size<=PRO_LIVING_MAX_SIZE);
    ht_pro_bitmap_t bitmap={.width=size,.height=size,.asset=&living_tag,
        .revision=1+frame%PRO_LIVING_FRAMES+PRO_LIVING_FRAMES*(mood+PRO_LIVING_MOODS*character)};
    ht_pro_image(scene,x,y,&bitmap);
}

static void load_pose(unsigned slot,unsigned index)
{
    if (loaded[slot]==index) return;
    const pro_living_asset_t *a=&pro_living_assets[index];
    size_t bytes=(size_t)(living_end-living_start);
    assert(a->offset<=bytes && a->length<=bytes-a->offset);
    size_t got=tinfl_decompress_mem_to_mem(packed,PRO_LIVING_RAW_BYTES,
        living_start+a->offset,a->length,TINFL_FLAG_PARSE_ZLIB_HEADER);
    assert(got==PRO_LIVING_RAW_BYTES);
    const unsigned count=PRO_LIVING_SOURCE*PRO_LIVING_SOURCE;
    uint16_t *rgb=(uint16_t*)poses[slot];uint8_t *alpha=poses[slot]+count*2;
    for (unsigned i=0;i<count;i++) {
        const uint8_t *p=packed+packed[512+i]*2;
        rgb[i]=(uint16_t)p[0]|((uint16_t)p[1]<<8);alpha[i]=255;
    }
    loaded[slot]=index;
}

// A smooth integer sine approximation; bounded +/-256, continuous at wrap.
static int wave(unsigned phase,unsigned period)
{
    unsigned p=phase%period;bool neg=p>=period/2;
    unsigned x=neg?p-period/2:p, half=period/2;
    unsigned product=x*(half-x);
    int value=(int)(4096*product/(5*half*half-4*product));
    return neg?-value:value;
}
static uint16_t blend(uint16_t a,uint16_t b,unsigned t)
{
    unsigned u=256-t;
    return (uint16_t)(((((a>>11)*u+(b>>11)*t)>>8)<<11) |
        (((((a>>5)&63)*u+((b>>5)&63)*t)>>8)<<5) |
        (((a&31)*u+(b&31)*t)>>8));
}

static uint16_t sample(const uint16_t *pixels,unsigned x,unsigned y,unsigned fx,unsigned fy)
{
    unsigned p=y*PRO_LIVING_SOURCE+x;
    return blend(blend(pixels[p],pixels[p+1],fx),
                 blend(pixels[p+PRO_LIVING_SOURCE],pixels[p+PRO_LIVING_SOURCE+1],fx),fy);
}

static void animate(unsigned character,unsigned mood,unsigned frame,unsigned size)
{
    static const uint8_t open_pose[6]={0,2,4,6,7,8};
    unsigned pose=open_pose[mood], blink=0;
    if (mood<3) {
        unsigned age=frame==79||frame==183?2:frame==78||frame==80||frame==182||frame==184?1:0;
        blink=age==2?256:age==1?144:0;
    }
    load_pose(0,character*9+pose);
    if (blink) load_pose(1,character*9+pose+1);
    const uint16_t *rgb=(const uint16_t*)poses[0], *closed=(const uint16_t*)poses[1];
    uint16_t *dst=(uint16_t*)output;uint8_t *mask=output+size*size*2;
    int breath=wave(frame,mood==4?200:100);
    int sway=wave(frame+character*7,200);
    int bounce=mood==3?-((wave(frame,50)+256)*6/256):0;
    if (mood==5) bounce=-((wave(frame,100)+256)*3/256);
    int stretch=1024+breath*(mood==4?14:8)/256;
    int center=128, floor=240;
    for (unsigned y=0;y<size;y++) {
        int py=(int)(y*256*256/size);
        int syq=floor*256+(py-floor*256-bounce*256)*1024/stretch;
        int sy=syq/256;
        int head=sy<170?170-sy:0;
        int bend=sway*head*(mood==1?5:mood==2?3:1)/170;
        int appendage=sy<90?(90-sy):sy>175?sy-175:0;
        int limb=wave(frame+(character==0?sy/3:0),50)*appendage/32;
        int widen=1024-breath*5/256;
        int source_y=syq*PRO_LIVING_SOURCE/256;
        if (source_y<0 || source_y>=(PRO_LIVING_SOURCE-1)*256) {
            memset(mask+y*size,0,size);memset(dst+y*size,0,size*2);continue;
        }
        unsigned iy=(unsigned)source_y/256,fy=(unsigned)source_y%256;
        for (unsigned x=0;x<size;x++) {
            int sxq=center*256+((int)(x*256*256/size)-center*256)*1024/widen-bend;
            int sx=sxq/256;
            // Ears and tentacle tips move relative to the breathing torso.
            int side=sx<center?-1:1;
            if (sx<center-45 || sx>center+45) sxq+=side*limb;
            unsigned d=y*size+x;
            int source_x=sxq*PRO_LIVING_SOURCE/256;
            if (source_x<0 || source_x>=(PRO_LIVING_SOURCE-1)*256) {mask[d]=0;dst[d]=0;continue;}
            unsigned ix=(unsigned)source_x/256,fx=(unsigned)source_x%256;
            mask[d]=255;dst[d]=sample(rgb,ix,iy,fx,fy);
            // A short eyelid gesture, retaining the stable body registration.
            if (blink && sx>48 && sx<211 && sy>82 && sy<179) {
                unsigned edge=(unsigned)(sx-48);
                if ((unsigned)(211-sx)<edge) edge=(unsigned)(211-sx);
                if ((unsigned)(sy-82)<edge) edge=(unsigned)(sy-82);
                if ((unsigned)(179-sy)<edge) edge=(unsigned)(179-sy);
                unsigned t=blink*(edge<10?edge:10)/10;
                dst[d]=blend(dst[d],sample(closed,ix,iy,fx,fy),t);
            }
        }
    }
}

void pro_living_prepare(ht_scene_t *scene)
{
    for (unsigned i=0;i<scene->count;i++) {
        ht_pro_bitmap_t *b=&scene->runs[i].bitmap;
        if (b->asset!=&living_tag) continue;
        assert(output && b->width==b->height && b->width<=PRO_LIVING_MAX_SIZE);
        if (rendered_revision!=b->revision || rendered_size!=b->width) {
            unsigned id=b->revision-1,frame=id%PRO_LIVING_FRAMES;
            id/=PRO_LIVING_FRAMES;
            animate(id/PRO_LIVING_MOODS,id%PRO_LIVING_MOODS,frame,b->width);
            rendered_revision=b->revision;rendered_size=b->width;
        }
        b->pixels=(const uint16_t*)output;b->alpha=output+b->width*b->height*2;
        b->asset=NULL;
    }
}
