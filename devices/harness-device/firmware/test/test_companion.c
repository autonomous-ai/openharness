// Replay real desktop/bridge messages through the production C parser/rendering.
#include "companion.h"
#include "cJSON.h"
#include "cable_frame.h"
#include "cable_json_guard.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static ht_companion_t companion;
static ht_scene_t before,after;
static uint16_t full[HT_WIDTH*HT_HEIGHT],partial[HT_WIDTH*HT_HEIGHT],strip[HT_WIDTH*HT_HEIGHT];
static ht_character_face_t face={.recipient="openharness",.status="",.hint="",.detail="",
    .foreground=0xffff,.ink=0xffff,.dim=0x8410,.primary_title=true,.roomy_reading=true};
static bool wire_result;
static unsigned wire_calls;
static uint32_t wire_now;
static void receive(uint8_t version,uint8_t type,const uint8_t *bytes,size_t length,void *ctx) {
    (void)ctx;assert(version==CABLE_FRAME_VERSION&&type==CABLE_TYPE_JSON);
    wire_calls++;
    assert(cable_json_guard(bytes,length));
    cJSON *message=cJSON_ParseWithLength((const char *)bytes,length);assert(message);
    wire_result=ht_companion_receive(&companion,message,wire_now);cJSON_Delete(message);
}
static void draw(ht_scene_t *scene) {
    ht_scene_clear(scene,ht_rgb(0x101010));
    ht_companion_face(scene,&companion,&face,NULL);
    ht_notification_bell(scene,2,face.dim);
    assert(scene->count<=HT_RUNS);
}
static void ppm(const char *dir,const char *name) {
    char path[1024];snprintf(path,sizeof path,"%s/%s.ppm",dir,name);
    FILE *f=fopen(path,"wb");assert(f);fprintf(f,"P6\n466 466\n255\n");
    const unsigned char *bytes=(const unsigned char *)full;
    for(int i=0;i<HT_WIDTH*HT_HEIGHT;i++) {
        unsigned color=((unsigned)bytes[2*i]<<8)|bytes[2*i+1];
        unsigned char rgb[]={(unsigned char)(((color>>11)&31)*255/31),
            (unsigned char)(((color>>5)&63)*255/63),(unsigned char)((color&31)*255/31)};
        fwrite(rgb,1,3,f);
    }
    fclose(f);
}
int main(int argc,char **argv) {
    assert(argc==3);FILE *file=fopen(argv[1],"r");assert(file);
    char line[32768];unsigned accepted=0,rejected=0,scenes=0;
    ht_companion_reset(&companion);
    while(fgets(line,sizeof line,file)) {
        cJSON *row=cJSON_Parse(line);assert(row);
        uint32_t now=(uint32_t)cJSON_GetObjectItemCaseSensitive(row,"at")->valuedouble;
        bool expected=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(row,"accept"));
        const char *hex=cJSON_GetObjectItemCaseSensitive(row,"wire")->valuestring;
        size_t length=strlen(hex)/2;assert(length<=CABLE_MAX_FRAME&&strlen(hex)==length*2);
        uint8_t bytes[CABLE_MAX_FRAME];
        for(size_t i=0;i<length;i++){unsigned byte;assert(sscanf(hex+i*2,"%2x",&byte)==1);bytes[i]=(uint8_t)byte;}
        cable_decoder_t decoder;cable_decoder_init(&decoder);wire_calls=0;wire_now=now;
        const size_t chunks[]={1,7,64,8192};size_t chunk=chunks[(accepted+rejected)%4];
        for(size_t at=0;at<length;at+=chunk)cable_decoder_feed(&decoder,bytes+at,length-at<chunk?length-at:chunk,receive,NULL);
        assert(wire_calls==1&&!decoder.corrupt_frames&&!decoder.discarded_bytes);
        bool result=wire_result;
        if(result!=expected) {fprintf(stderr,"unexpected verdict on %s\n",line);abort();}
        if(result)accepted++;else rejected++;
        const cJSON *name=cJSON_GetObjectItemCaseSensitive(row,"scene");
        if(cJSON_IsString(name)) {
            assert(companion.enabled&&companion.clips[companion.active].complete);
            ht_companion_tick(&companion,now,false,true);draw(&before);
            ht_raster(&before,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},partial);
            unsigned ms=companion.clips[companion.active].frame_ms;
            for(unsigned frame=0;frame<8;frame++) {
                ht_companion_tick(&companion,now+ms*frame,false,true);draw(&after);
                ht_damage_t damage;ht_damage(&before,&after,&damage);
                for(int r=0;r<damage.count;r++) {
                    ht_rect_t box=damage.rect[r];ht_raster(&after,box,strip);
                    for(int y=0;y<box.h;y++)memcpy(partial+(box.y+y)*HT_WIDTH+box.x,strip+y*box.w,box.w*2);
                }
                ht_raster(&after,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
                assert(!memcmp(partial,full,sizeof full));before=after;scenes++;
                if(frame==3&&name->valuestring[0])ppm(argv[2],name->valuestring);
            }
            // Copying a scene owns every dynamic cell's color. Account changes,
            // new transfers and DMA can no longer race an external color buffer.
            ht_companion_t *c=&companion;unsigned active=c->active;
            uint16_t color=c->clips[active].palette[0];c->clips[active].palette[0]^=0xffff;
            ht_raster(&before,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},partial);
            assert(!memcmp(partial,full,sizeof full));c->clips[active].palette[0]=color;
            ht_companion_tick(c,now+1000,true,true);assert(c->frame==0);
            // The settings brightness applies to streamed palette ink too.
            c->brightness=100;draw(&before);c->brightness=25;draw(&after);
            for(int r=0;r<after.count;r++)for(int col=0;col<after.runs[r].cell_color_count;col++) {
                unsigned bright=before.runs[r].cell_colors[col],dim=after.runs[r].cell_colors[col];
                assert((dim>>11)<=(bright>>11)&&((dim>>5)&63)<=((bright>>5)&63)&&(dim&31)<=(bright&31));
            }
            c->brightness=100;
            char uid[65];strcpy(uid,c->uid);ht_companion_disconnect(c);
            assert(c->managed&&c->enabled&&!c->motion&&!c->pending&&!strcmp(uid,c->uid));
            assert(!strcmp(c->emotion,"offline"));
        }
        cJSON_Delete(row);
    }
    fclose(file);assert(accepted>100&&rejected>=10&&scenes>100);
    printf("Companion: %u accepted, %u refused, %u incremental/full frames identical; framed bytes, JSON guard, scene-owned colors, quiet/brightness PASS\n",accepted,rejected,scenes);
    printf("Companion storage: %zu bytes; scene: %zu bytes\n",sizeof companion,sizeof before);
}
