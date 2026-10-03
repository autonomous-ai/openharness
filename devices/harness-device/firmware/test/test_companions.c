// Decode the shipped assets and prove dirty rectangles reproduce a full frame,
// including alpha layering, changes of species, small portraits and held mail.
#include "character.h"
#include "illustrated.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint16_t full[HT_WIDTH * HT_HEIGHT], partial[HT_WIDTH * HT_HEIGHT];
static uint16_t strip[HT_WIDTH * HT_HEIGHT];
static unsigned scenes;

static void growth_centres(void)
{
    // Measure the actual decoded pixels, without labels or mail. All ages
    // must share the adult's visual centre in both home and reading layouts.
    for (unsigned species=0; species<10; species++) for (unsigned small=0; small<2; small++) {
        int centres[3][2];
        for (unsigned stage=0; stage<3; stage++) {
            ht_scene_t scene;
            ht_scene_clear(&scene, 0);
            ht_character_face_t face={.mood=HT_CHARACTER_IDLE,
                .companion_style={.stage=stage,.colour=255}};
            ht_illustrated_draw(&scene,species,&face,0,0xffff,
                small?HT_CHARACTER_BRIEF:HT_CHARACTER_FULL,100);
            ht_illustrated_prepare(&scene);
            ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},full);
            int left=HT_WIDTH,right=-1,top=HT_HEIGHT,bottom=-1;
            for(int y=0;y<HT_HEIGHT;y++) for(int x=0;x<HT_WIDTH;x++) {
                uint16_t pixel=full[y*HT_WIDTH+x];
                uint16_t rgb=(pixel>>8)|(pixel<<8);
                if ((rgb>>11)+((rgb>>5)&63)+(rgb&31)<8) continue;
                if(x<left)left=x;
                if(x>right)right=x;
                if(y<top)top=y;
                if(y>bottom)bottom=y;
            }
            assert(right>left && bottom>top);
            centres[stage][0]=left+right; centres[stage][1]=top+bottom;
        }
        for(unsigned stage=0;stage<2;stage++) for(unsigned axis=0;axis<2;axis++) {
            int delta=abs(centres[stage][axis]-centres[2][axis]);
            if(delta>6) fprintf(stderr,"growth centre species=%u small=%u stage=%u axis=%u delta=%.1fpx\n",
                species,small,stage,axis,delta/2.0);
            // Cropped layers round independently, and subpixel whiskers or
            // antennae can disappear when reduced. Allow three raster pixels.
            assert(delta<=6);
        }
    }
    puts("Growth alignment: all ten species, three ages and both layouts share the adult centre PASS");
}

static void redraw(const ht_scene_t *before, ht_scene_t *after)
{
    ht_illustrated_prepare(after);
    ht_damage_t damage;
    ht_damage(before, after, &damage);
    for (unsigned i = 0; i < damage.count; i++) {
        ht_rect_t r = damage.rect[i];
        assert(r.x >= 0 && r.y >= 0 && r.x+r.w <= HT_WIDTH && r.y+r.h <= HT_HEIGHT);
        ht_raster(after, r, strip);
        for (int y = 0; y < r.h; y++)
            memcpy(partial + (r.y+y)*HT_WIDTH+r.x, strip+y*r.w, r.w*2);
    }
    ht_raster(after, (ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT}, full);
    assert(!memcmp(partial, full, sizeof full));
    scenes++;
}

int main(int argc, char **argv)
{
    static const char *ids[] = {"tim","gnu","lynx","mutt","yak","gopher","bug","tux","auk","beastie"};
    ht_illustrated_init();
    growth_centres();
    ht_scene_t before, after;
    ht_scene_clear(&before, ht_rgb(0x181818)); redraw(NULL, &before);
    ht_character_t character = {0};
    ht_character_face_t face = {.recipient="Đang làm · GNU", .status="Working", .foreground=0xffff,
        .ink=0xafe0, .dim=0x7777, .roomy_reading=true};
    for (unsigned species = 0; species < 10; species++) {
        ht_character_id_t id = ht_character_companion(ids[species]);
        assert(id >= HT_CHARACTER_ILLUSTRATED_TIM && id < HT_CHARACTER_COUNT);
        assert(!strcmp(ht_character_species(id), ids[species]));
        assert(ht_character_select(&character, id));
        for (unsigned mood = 0; mood < HT_CHARACTER_MOODS; mood++) {
            face.mood = mood;
            for (unsigned variation = 0; variation < 8; variation++) {
                for (unsigned small = 0; small < 2; small++) {
                    character.motion.frame = variation * 3;
                    face.unread = variation & 1;
                    face.pose = (ht_character_pose_t){.pressed=variation==2, .look=(int)species%5-2};
                    ht_scene_clear(&after, before.background);
                    ht_character_face(&after, &character, &face, 0xffff,
                        small ? "The companion follows your desktop choice." : NULL);
                    redraw(&before, &after);
                    if (!mood && !variation && !small && argc > 1) {
                        char path[1024]; snprintf(path, sizeof path, "%s/%s.ppm", argv[1], ids[species]);
                        FILE *file=fopen(path,"wb"); assert(file);
                        fprintf(file,"P6\n%d %d\n255\n",HT_WIDTH,HT_HEIGHT);
                        for(unsigned px=0;px<HT_WIDTH*HT_HEIGHT;px++) {
                            uint16_t rgb=(full[px]>>8)|(full[px]<<8);
                            uint8_t bytes[]={(rgb>>11)*255/31,((rgb>>5)&63)*255/63,(rgb&31)*255/31};
                            assert(fwrite(bytes,1,3,file)==3);
                        }
                        fclose(file);
                    }
                    before=after;
                }
            }
        }
        // Identity-only changes must invalidate every decoded material cache.
        for (unsigned stage=0;stage<3;stage++) for (unsigned colour=0;colour<6;colour++) {
            character.companion_style=(ht_companion_style_t){.stage=stage,.colour=colour,.mark=(colour+species)%5};
            face.mood=HT_CHARACTER_IDLE; face.unread=0; face.pose=(ht_character_pose_t){0};
            ht_scene_clear(&after,before.background);
            ht_character_face(&after,&character,&face,0xffff,NULL);
            redraw(&before,&after); before=after;
            if (argc>1 && colour==2) {
                char path[1024];snprintf(path,sizeof path,"%s/%s-%u.ppm",argv[1],ids[species],stage);
                FILE *file=fopen(path,"wb");assert(file);fprintf(file,"P6\n%d %d\n255\n",HT_WIDTH,HT_HEIGHT);
                for(unsigned px=0;px<HT_WIDTH*HT_HEIGHT;px++) {
                    uint16_t rgb=(full[px]>>8)|(full[px]<<8);
                    uint8_t bytes[]={(rgb>>11)*255/31,((rgb>>5)&63)*255/63,(rgb&31)*255/31};
                    assert(fwrite(bytes,1,3,file)==3);
                }
                fclose(file);
            }
        }
        // Eight simulated hours, including a uint32 clock wrap, with sleep,
        // touch and quiet intervals. No catch-up burst or unbounded phase.
        for (uint32_t elapsed=0;elapsed<8*60*60*1000;elapsed+=200) {
            uint32_t now=UINT32_MAX-4000+elapsed;
            unsigned cycle=elapsed/1000;
            bool quiet=cycle%83<5, visible=cycle%113>=10, down=cycle%71<2;
            ht_character_tick(&character,now,HT_CHARACTER_IDLE,quiet,visible,down,233,0,0);
            assert(character.motion.frame<4);
        }
        // Touch freezes motion, quiet mode remains still, and switching resets it.
        ht_character_tick(&character, 0, HT_CHARACTER_WORKING, false, true, false, 233, 0, 0);
        ht_character_tick(&character, 100, HT_CHARACTER_WORKING, false, true, true, 330, 0, 0);
        uint16_t held=character.motion.phase;
        ht_character_tick(&character, 5000, HT_CHARACTER_WORKING, false, true, true, 330, 0, 0);
        assert(character.motion.phase==held && character.motion.reaction.pose.pressed);
        ht_character_tick(&character, 6000, HT_CHARACTER_WORKING, true, true, false, 233, 0, 0);
        assert(character.motion.frame==0);
    }
    assert(ht_character_companion(NULL)==HT_CHARACTER_COUNT && ht_character_companion("unknown")==HT_CHARACTER_COUNT);
    assert(ht_character_select(&character, HT_CHARACTER_FOCUS));
    ht_scene_clear(&after, before.background); ht_character_face(&after,&character,&face,0xffff,NULL);
    redraw(&before,&after);
    printf("Illustrated companions: ten species, eight moods, two layouts, all growth/colour families and eight-hour clocks; %u exact incremental redraws PASS\n",scenes);
}
