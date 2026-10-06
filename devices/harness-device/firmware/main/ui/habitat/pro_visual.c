#include "pro_visual.h"
#include "pro_art.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "miniz.h"
#include <assert.h>
#include <string.h>

extern const uint8_t pro_art_start[] asm("_binary_pro_art_pack_start");
extern const uint8_t pro_art_end[] asm("_binary_pro_art_pack_end");
typedef struct {
    uint8_t *memory;
    size_t capacity;
    const pro_art_frame_t *asset;
    ht_pro_bitmap_t bitmap;
} cache_t;
static cache_t caches[PRO_ART_ROLE_COUNT];
typedef struct {
    const pro_art_frame_t *rear,*body,*front,*face,*letter;
    ht_character_id_t id;
    int16_t bob,letter_lift;
    uint8_t size;
} selection_t;
static selection_t last;
static bool presented;

void pro_visual_init(void)
{
    if (caches[0].memory) return;
    for (unsigned i=0;i<PRO_ART_ROLE_COUNT;i++) {
        caches[i].capacity=pro_art_cache_bytes[i];
        caches[i].memory=heap_caps_malloc(caches[i].capacity,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
        assert(caches[i].memory);
    }
    ESP_LOGI("pro-companion","illustrated companion: %u daemons, 8 moods, layered bitmap renderer",pro_daemon_count());
}
static const ht_pro_bitmap_t *decode(cache_t *cache,const pro_art_frame_t *asset)
{
    const pro_art_frame_t *old=cache->asset;
    if (old && old->offset==asset->offset && old->length==asset->length &&
        old->width==asset->width && old->height==asset->height && old->alpha==asset->alpha)
        return &cache->bitmap;
    {
        size_t pack_size=(size_t)(pro_art_end-pro_art_start);
        assert(asset->offset<=pack_size && asset->length<=pack_size-asset->offset);
        assert(asset->raw_length<=cache->capacity);
        assert(asset->raw_length==(uint32_t)asset->width*asset->height*(asset->alpha?3:2));
        size_t got=tinfl_decompress_mem_to_mem(cache->memory,cache->capacity,
            pro_art_start+asset->offset,asset->length,TINFL_FLAG_PARSE_ZLIB_HEADER);
        assert(got==asset->raw_length);
        if (asset->base_length) {
            assert(asset->base_offset<=pack_size && asset->base_length<=pack_size-asset->base_offset);
            assert(asset->raw_length*2<=cache->capacity);
            uint8_t *base=cache->memory+asset->raw_length;
            got=tinfl_decompress_mem_to_mem(base,asset->raw_length,
                pro_art_start+asset->base_offset,asset->base_length,TINFL_FLAG_PARSE_ZLIB_HEADER);
            assert(got==asset->raw_length);
            for (size_t i=0;i<asset->raw_length;i++) cache->memory[i]^=base[i];
        }
    }
    cache->asset=asset;
    cache->bitmap=(ht_pro_bitmap_t){.pixels=(const uint16_t*)cache->memory,
        .alpha=asset->alpha?cache->memory+asset->width*asset->height*2:NULL,
        .width=asset->width,.height=asset->height,.revision=asset->offset+1,.asset=asset};
    return &cache->bitmap;
}
static void image(ht_scene_t *scene,int x,int y,const pro_art_frame_t *asset)
{
    ht_pro_bitmap_t deferred={.width=asset->width,.height=asset->height,
        .revision=asset->offset+1,.asset=asset};
    ht_pro_image(scene,x+asset->x,y+asset->y,&deferred);
}
void pro_visual_prepare(ht_scene_t *scene)
{
    assert(caches[0].memory);
    const pro_art_frame_t *selected[PRO_ART_ROLE_COUNT]={0};
    for (unsigned i=0;i<scene->count;i++) {
        ht_pro_bitmap_t *bitmap=&scene->runs[i].bitmap;
        if (!bitmap->asset) continue;
        const pro_art_frame_t *asset=bitmap->asset;
        assert(asset->role<PRO_ART_ROLE_COUNT);
        unsigned slot=asset->role;
        // A scene contains one daemon. Explicit roles permit arbitrary crops;
        // a tiny face must never be mistaken for an envelope or a background.
        assert(!selected[slot] || selected[slot]==asset);
        selected[slot]=asset;
        assert(bitmap->width==asset->width && bitmap->height==asset->height);
        *bitmap=*decode(&caches[slot],asset);
    }
}
void pro_visual_background(ht_scene_t *scene,pro_scene_id_t choice,ht_character_id_t daemon)
{
    pro_scene_id_t resolved=pro_scene_resolve(choice,daemon);
    image(scene,0,0,&pro_art_scenes[resolved-PRO_SCENE_MEADOW]);
}
void pro_visual_landscape(ht_scene_t *scene) { pro_visual_background(scene,PRO_SCENE_MEADOW,HT_CHARACTER_TIM); }

static selection_t select_layers(const ht_character_t *c,ht_character_mood_t mood,bool small,bool quiet,bool mail)
{
    static const int8_t bounce[24]={0,1,1,2,2,3,3,3,2,2,1,1,0,-1,-1,-2,-2,-3,-3,-3,-2,-2,-1,-1};
    if ((unsigned)mood>=HT_CHARACTER_MOODS) mood=HT_CHARACTER_IDLE;
    unsigned index=pro_daemon_index(c->id),size=small?PRO_ART_COMPACT:PRO_ART_HERO;
    const pro_art_daemon_t *art=&pro_art_daemons[index];
    const pro_daemon_definition_t *definition=pro_daemon_at(index);
    const ht_character_pose_t *p=&c->motion.reaction.pose;
    unsigned frame=c->motion.frame<PRO_ART_FRAMES?c->motion.frame:0;
    if (quiet || mood==HT_CHARACTER_OFFLINE || p->pressed) frame=0;
    unsigned group=mood==HT_CHARACTER_WORKING?1:mood==HT_CHARACTER_ATTENTION?2:mood==HT_CHARACTER_DONE?3:0;
    unsigned phase=frame*PRO_ART_MOTION_FRAMES/PRO_ART_FRAMES;
    if (mood==HT_CHARACTER_ASLEEP || mood==HT_CHARACTER_OFFLINE) group=phase=0;
    unsigned expression=mood==HT_CHARACTER_IDLE?0:mood==HT_CHARACTER_WORKING?2:
        mood==HT_CHARACTER_ATTENTION?3:mood==HT_CHARACTER_DONE?4:mood==HT_CHARACTER_OFFLINE?5:
        mood==HT_CHARACTER_ASLEEP?6:mood==HT_CHARACTER_BOOPED?7:0;
    const pro_art_frame_t *face=&art->face[size][expression];
    if (p->blink && mood!=HT_CHARACTER_ASLEEP && mood!=HT_CHARACTER_OFFLINE) face=&art->face[size][1];
    if (mood==HT_CHARACTER_LISTENING) {
        unsigned level=quiet?0:p->level<5?p->level:4;
        unsigned emotion=p->emotion<8?p->emotion:0;
        face=&art->speech[size][emotion][level];
    }
    if (p->pressed && !quiet) {
        int gaze=p->look+2;if(gaze<0)gaze=0;if(gaze>4)gaze=4;
        face=&art->touch[size][gaze];
    }
    int bob=quiet || p->pressed || mood==HT_CHARACTER_OFFLINE?0:bounce[frame]*definition->bob/3;
    if (mood==HT_CHARACTER_DONE && !quiet && !p->pressed) bob=frame<12?-(int)frame/2:-(23-(int)frame)/2;
    if (small) bob=bob*160/350;
    return (selection_t){.rear=&art->rear[size][group][phase],.body=&art->body[size],
        .front=&art->front[size][group][phase],.face=face,.letter=mail?&pro_art_letter[size]:NULL,
        .id=definition->id,.bob=bob,.letter_lift=c->delivery.moving&&!quiet?c->delivery.lift*(small?2:4):0,.size=size};
}
static bool same_frame(const pro_art_frame_t *a,const pro_art_frame_t *b)
{
    if (a==b) return true;
    return a && b && a->offset==b->offset && a->length==b->length &&
        a->width==b->width && a->height==b->height && a->alpha==b->alpha &&
        a->x==b->x && a->y==b->y;
}
static bool same_selection(const selection_t *a,const selection_t *b)
{
    return a->id==b->id && a->size==b->size && a->bob==b->bob && a->letter_lift==b->letter_lift &&
        same_frame(a->rear,b->rear) && same_frame(a->body,b->body) &&
        same_frame(a->front,b->front) && same_frame(a->face,b->face) && same_frame(a->letter,b->letter);
}
bool pro_visual_changed(const ht_character_t *c,ht_character_mood_t mood,uint32_t now,bool quiet,bool mail)
{
    (void)now;
    selection_t next=select_layers(c,mood,last.size==PRO_ART_COMPACT,quiet,mail);
    return !presented || !same_selection(&last,&next);
}
uint32_t pro_visual_next_wake_ms(const ht_character_t *c,ht_character_mood_t mood,uint32_t now,bool quiet,bool mail)
{
    if (pro_visual_changed(c,mood,now,quiet,mail)) return 1;
    uint32_t next=c->motion.next_ms;
    return next>=1 && next<=1000?next:1000;
}
void pro_visual_character(ht_scene_t *scene,const ht_character_t *c,ht_character_mood_t mood,
                          bool small,int x,int y,uint32_t now,bool quiet,bool mail)
{
    (void)now;
    selection_t chosen=select_layers(c,mood,small,quiet,mail);
    image(scene,x,y+chosen.bob,chosen.rear);
    image(scene,x,y+chosen.bob,chosen.body);
    image(scene,x,y+chosen.bob,chosen.front);
    image(scene,x,y+chosen.bob,chosen.face);
    if (chosen.letter) {
        const pro_art_daemon_t *art=&pro_art_daemons[pro_daemon_index(c->id)];
        image(scene,x+art->letter_anchor[chosen.size][0],
            y+art->letter_anchor[chosen.size][1]+chosen.bob-chosen.letter_lift,chosen.letter);
    }
    last=chosen;presented=true;
}
void pro_visual_paint(ht_scene_t *scene,ht_character_id_t id,const ht_character_face_t *face,
                      uint8_t frame,ht_character_size_t size,int y)
{
    ht_character_t c={.id=id};c.motion.frame=frame;c.motion.reaction.pose=face->pose;
    bool small=size!=HT_CHARACTER_FULL;
    pro_visual_character(scene,&c,face->mood,small,(HT_WIDTH-(small?160:350))/2,y,0,false,face->unread);
}
