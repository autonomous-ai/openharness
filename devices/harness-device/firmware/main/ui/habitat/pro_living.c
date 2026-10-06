#include "pro_living.h"
#include "pro_living_assets.h"
#include "esp_heap_caps.h"
#include "miniz.h"
#include <assert.h>
#include <string.h>
#ifdef ESP_PLATFORM
#include "esp_timer.h"
#include "esp_log.h"
#include "driver/ppa.h"
#endif

extern const uint8_t living_start[] asm("_binary_pro_living_pack_start");
extern const uint8_t living_end[] asm("_binary_pro_living_pack_end");
static const uint8_t living_tag;
enum { SIDE=PRO_LIVING_SOURCE, PIXELS=SIDE*SIDE, POSES=9 };
static uint8_t *packed;
static uint16_t *poses, *work, *output;
static unsigned loaded=99, last_mood=99, transition_frame;
static bool transitioning;
static uint16_t row_pixels[PRO_LIVING_SOURCE];
static uint32_t rendered_revision;
static unsigned rendered_size;
#ifdef ESP_PLATFORM
static ppa_client_handle_t scaler;
static uint32_t scale_us;
static void init_scaler(void);
#endif

// Decode the selected character once. Blinks and mood changes never inflate
// assets in a frame. These four fixed allocations also own transition history.
void pro_living_init(void)
{
    if (output) return;
    packed=heap_caps_malloc(PRO_LIVING_RAW_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    poses=heap_caps_malloc(POSES*PIXELS*2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    work=heap_caps_malloc(PIXELS*4,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    // PPA owns complete cache lines while writing this output. The other
    // buffers are CPU inputs; the pinned driver writes them back before DMA.
    output=heap_caps_aligned_alloc(64,PRO_LIVING_MAX_SIZE*PRO_LIVING_MAX_SIZE*2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    assert(packed && poses && work && output);
#ifdef ESP_PLATFORM
    init_scaler();
#endif
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
static void load_character(unsigned character)
{
    if (loaded==character) return;
    for (unsigned pose=0;pose<POSES;pose++) {
        const pro_living_asset_t *a=&pro_living_assets[character*POSES+pose];
        size_t bytes=(size_t)(living_end-living_start);
        assert(a->offset<=bytes && a->length<=bytes-a->offset);
        size_t got=tinfl_decompress_mem_to_mem(packed,PRO_LIVING_RAW_BYTES,
            living_start+a->offset,a->length,TINFL_FLAG_PARSE_ZLIB_HEADER);
        assert(got==PRO_LIVING_RAW_BYTES);
        for (unsigned i=0;i<PIXELS;i++) {
            const uint8_t *p=packed+packed[512+i]*2;
            poses[pose*PIXELS+i]=(uint16_t)p[0]|((uint16_t)p[1]<<8);
        }
    }
    loaded=character;last_mood=99;transitioning=false;
}
static int wave(unsigned phase,unsigned period)
{
    unsigned p=phase%period;bool neg=p>=period/2;
    unsigned x=neg?p-period/2:p, half=period/2;
    unsigned product=x*(half-x);
    int value=(int)(4096*product/(5*half*half-4*product));
    return neg?-value:value;
}
// Three RGB565 lanes in one unsigned multiply. Five fractional bits retain
// subpixel motion without nine channel multiplies for each bilinear sample.
static uint16_t mix(uint16_t a,uint16_t b,unsigned t)
{
    uint32_t aa=((uint32_t)a|((uint32_t)a<<16))&0x07e0f81f;
    uint32_t bb=((uint32_t)b|((uint32_t)b<<16))&0x07e0f81f;
    uint32_t c=(aa+(((bb-aa)*t)>>5))&0x07e0f81f;
    return (uint16_t)(c|(c>>16));
}
static uint16_t average(uint16_t a,uint16_t b)
{
    return (uint16_t)((a&b)+(((a^b)&0xf7de)>>1));
}
static uint16_t sample(const uint16_t *src,unsigned x,unsigned y,unsigned fx,unsigned fy)
{
    unsigned p=y*SIDE+x;
    return mix(mix(src[p],src[p+1],fx),mix(src[p+SIDE],src[p+SIDE+1],fx),fy);
}
#ifdef ESP_PLATFORM
static bool scale_hardware(void)
{
    if (!scaler) return false;
    ppa_srm_oper_config_t job={
        .in={.buffer=work,.pic_w=SIDE,.pic_h=SIDE,.block_w=SIDE,.block_h=SIDE,
             .srm_cm=PPA_SRM_COLOR_MODE_RGB565},
        .out={.buffer=output,.buffer_size=PRO_LIVING_MAX_SIZE*PRO_LIVING_MAX_SIZE*2,
              .pic_w=SIDE*2,.pic_h=SIDE*2,.srm_cm=PPA_SRM_COLOR_MODE_RGB565},
        .scale_x=2,.scale_y=2,.mode=PPA_TRANS_MODE_BLOCKING
    };
    // The blocking fence includes cache synchronization in ESP-IDF. Neither
    // work nor output is reused by the renderer until the DMA has completed.
    esp_err_t result=ppa_do_scale_rotate_mirror(scaler,&job);
    if(result==ESP_OK)return true;
    ESP_LOGW("living","PPA unavailable (%d); using software interpolation",result);
    ppa_unregister_client(scaler);scaler=NULL;
    return false;
}
static void init_scaler(void)
{
    ppa_client_config_t config={.oper_type=PPA_OPERATION_SRM,.max_pending_trans_num=1};
    if(ppa_register_client(&config,&scaler)!=ESP_OK){scaler=NULL;return;}
    // Read back four constant color regions before displaying hardware output.
    // This catches byte order, scaling, alignment and cache coherency failures
    // on the actual board without drawing a diagnostic on the screen.
    const uint16_t colors[]={0x1019,0xf800,0x07e0,0x001f};
    for(unsigned y=0;y<SIDE;y++)for(unsigned x=0;x<SIDE;x++)
        work[y*SIDE+x]=colors[(y>=SIDE/2)*2+(x>=SIDE/2)];
    if(!scale_hardware())return;
    for(unsigned y=0;y<2;y++)for(unsigned x=0;x<2;x++) {
        if(output[(y*SIDE+SIDE/2)*SIDE*2+x*SIDE+SIDE/2]!=colors[y*2+x]) {
            ESP_LOGW("living","PPA readback failed; using software interpolation");
            ppa_unregister_client(scaler);scaler=NULL;return;
        }
    }
    ESP_LOGI("living","PPA 2x bilinear scaling verified");
}
#endif
static void scale(unsigned size)
{
    if (size==SIDE) {memcpy(output,work,PIXELS*2);return;}
    if (size==SIDE*2) {
#ifdef ESP_PLATFORM
        if(scale_hardware())return;
#endif
        // Exact 2x bilinear reconstruction: only shifts/adds, no divisions or
        // per-pixel coordinate work on the full-size home surface.
        for (unsigned y=0;y<SIDE;y++) {
            const uint16_t *a=work+y*SIDE,*b=y+1<SIDE?a+SIDE:a;
            uint16_t *top=output+y*2*size,*bottom=top+size;
            for (unsigned x=0;x<SIDE;x++) {
                unsigned next=x+1<SIDE?x+1:x;
                uint16_t ab=average(a[x],a[next]),cd=average(b[x],b[next]);
                top[x*2]=a[x];top[x*2+1]=ab;
                bottom[x*2]=average(a[x],b[x]);bottom[x*2+1]=average(ab,cd);
            }
        }
        return;
    }
    unsigned step=(SIDE-1)*65536/(size>1?size-1:1);
    for (unsigned y=0;y<size;y++) {
        unsigned sy=y*step,iy=sy>>16,fy=(sy>>11)&31;
        if (iy>=SIDE-1) {iy=SIDE-2;fy=32;}
        for (unsigned x=0,sx=0;x<size;x++,sx+=step) {
            unsigned ix=sx>>16,fx=(sx>>11)&31;
            if (ix>=SIDE-1) {ix=SIDE-2;fx=32;}
            output[y*size+x]=sample(work,ix,iy,fx,fy);
        }
    }
}
static void animate(unsigned character,unsigned mood,unsigned frame,unsigned size)
{
    static const uint8_t open_pose[PRO_LIVING_MOODS]={0,2,4,6,7,8,6};
    static const uint8_t eyelid[]={0,4,16,28,32,24,10,2};
    load_character(character);
    if (last_mood!=mood) {
        transitioning=last_mood!=99;
        if (transitioning) memcpy(work+PIXELS,work,PIXELS*2);
        transition_frame=frame;last_mood=mood;
    }
    unsigned transition=(frame+PRO_LIVING_FRAMES-transition_frame)%PRO_LIVING_FRAMES;
    if(transition>=8)transitioning=false;
    unsigned blend_in=transitioning?transition*4:32;
    unsigned pose=open_pose[mood],blink=0;
    if (mood<3) {
        unsigned at=frame>=184?frame-184:frame>=76?frame-76:99;
        if (at<sizeof eyelid) blink=eyelid[at];
    }
    const uint16_t *rgb=poses+pose*PIXELS,*closed=rgb+PIXELS;
    int breath=wave(frame,mood==4?240:120),sway=wave(frame+character*9,240);
    int bounce=mood==3?-(wave(frame,80)+256)*384:0;
    if (mood==5) bounce=-(wave(frame,120)+256)*192;
    int stretch=65536+breath*(mood==4?5:3),widen=65536-breath*2;
    int xstep=(int)(((int64_t)65536*65536)/widen);
    unsigned attention=frame%240;
    int beckon=mood==PRO_LIVING_ATTENTION && attention<64?wave(attention,32):0;
    uint16_t background=ht_rgb(0x101019);
    for (unsigned y=0;y<SIDE;y++) {
        int syq=300*65536+(int)(((int64_t)((int)y-300)*65536-bounce)*65536/stretch);
        int sy=syq>>16;
        if (sy<0 || sy>=SIDE-1) {for(unsigned x=0;x<SIDE;x++)work[y*SIDE+x]=background;continue;}
        unsigned fy=(unsigned)(syq>>11)&31;
        int head=sy<212?212-sy:0;
        int bend=sway*head*(mood==1?10:mood==2?7:3);
        int appendage=sy<112?112-sy:sy>218?sy-218:0;
        int limb=wave(frame+(character==0?(unsigned)sy/4:0),120)*appendage*32;
        int arm=character==1?(sy<122?122-sy:0):(sy>192?sy-192:0);
        if(arm>64)arm=64;
        // Vertical interpolation is shared by the entire row and stays in
        // internal SRAM. Each moving pixel then needs one horizontal blend.
        const uint16_t *top=rgb+(unsigned)sy*SIDE,*bottom=top+SIDE;
        for(unsigned x=0;x<SIDE;x++) row_pixels[x]=mix(top[x],bottom[x],fy);
        if(blink && sy>102 && sy<224) {
            for(unsigned x=61;x<264;x++) {
                unsigned edge=x-60;
                if(264-x<edge)edge=264-x;
                if((unsigned)(sy-102)<edge)edge=(unsigned)(sy-102);
                if((unsigned)(224-sy)<edge)edge=(unsigned)(224-sy);
                unsigned t=blink*(edge<12?edge:12)/12;
                unsigned index=(unsigned)sy*SIDE+x;
                row_pixels[x]=mix(row_pixels[x],mix(closed[index],closed[index+SIDE],fy),t);
            }
        }
        // Five continuous affine spans give torso and appendages independent
        // motion without divisions, branching envelopes or warps per pixel.
        static const unsigned edges[]={0,51,115,205,269,SIDE};
        int origin=160*65536-160*xstep-bend;
        int right=limb+beckon*arm*70;
        for(unsigned span=0;span<5;span++) {
            unsigned first=edges[span],end=edges[span+1];
            int step=xstep,shift=0;
            if(span==0)shift=-limb;
            if(span==1){step+=limb/64;shift=-limb;}
            if(span==3)step+=right/64;
            if(span==4)shift=right;
            int q=origin+(int)first*xstep+shift;
            for(unsigned x=first;x<end;x++,q+=step) {
                int sx=q>>16;
                uint16_t value=background;
                if(sx>=0 && sx<SIDE-1)
                    value=mix(row_pixels[sx],row_pixels[sx+1],(unsigned)(q>>11)&31);
                unsigned d=y*SIDE+x;
                work[d]=blend_in<32?mix(work[PIXELS+d],value,blend_in):value;
            }
        }
    }
#ifdef ESP_PLATFORM
    int64_t scaling_started=esp_timer_get_time();
#endif
    scale(size);
#ifdef ESP_PLATFORM
    scale_us=(uint32_t)(esp_timer_get_time()-scaling_started);
#endif
}
void pro_living_prepare(ht_scene_t *scene)
{
    for (unsigned i=0;i<scene->count;i++) {
        ht_pro_bitmap_t *b=&scene->runs[i].bitmap;
        if (b->asset!=&living_tag) continue;
        assert(output && b->width==b->height && b->width<=PRO_LIVING_MAX_SIZE);
        if (rendered_revision!=b->revision || rendered_size!=b->width) {
            unsigned id=b->revision-1,frame=id%PRO_LIVING_FRAMES;id/=PRO_LIVING_FRAMES;
#ifdef ESP_PLATFORM
            int64_t started=esp_timer_get_time();
            bool cached=loaded==id/PRO_LIVING_MOODS;
#endif
            animate(id/PRO_LIVING_MOODS,id%PRO_LIVING_MOODS,frame,b->width);
#ifdef ESP_PLATFORM
            static uint32_t count,total,maximum,scaling;
            uint32_t elapsed=(uint32_t)(esp_timer_get_time()-started);
            if (cached) {
                count++;total+=elapsed;scaling+=scale_us;if(elapsed>maximum)maximum=elapsed;
                if(count==150) {
                    ESP_LOGI("living","animation frames=%lu mean_us=%lu max_us=%lu scale_us=%lu size=%u",
                        (unsigned long)count,(unsigned long)(total/count),(unsigned long)maximum,
                        (unsigned long)(scaling/count),b->width);
                    count=total=maximum=scaling=0;
                }
            }
#endif
            rendered_revision=b->revision;rendered_size=b->width;
        }
        b->pixels=output;b->alpha=NULL;b->asset=NULL;
    }
}
