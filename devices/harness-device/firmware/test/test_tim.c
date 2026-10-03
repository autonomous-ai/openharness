#include "../main/ui/habitat/tim.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static ht_scene_t scene(ht_tim_pose_t pose, bool focus, ht_tim_mood_t mood)
{
    ht_scene_t s; ht_scene_clear(&s,ht_rgb(0x080c08));
    ht_tim_face_t f={.recipient="Deploy latest firmware",.status="working",.hint="tap to talk",
        .detail="Running firmware checks",.mood=mood,.pose=pose,.focus=focus,
        .ink=ht_rgb(0xb9ed80),.foreground=ht_rgb(0xe8e9df),.dim=ht_rgb(0x969f91)};
    ht_tim_face(&s,&f); assert(s.count<HT_RUNS); return s;
}
int main(void)
{
    ht_tim_motion_t m={0};
    ht_tim_motion_tick(&m,1000,HT_TIM_CONTENT,false,true,false,233,0,0);
    ht_scene_t before=scene(m.pose,false,HT_TIM_CONTENT);
    unsigned frames=0,pixels=0,max_pixels=0;
    for(uint32_t t=1025;t<=61000;t+=25) {
        if(!ht_tim_motion_tick(&m,t,HT_TIM_CONTENT,false,true,false,233,0,0)) continue;
        ht_scene_t after=scene(m.pose,false,HT_TIM_CONTENT); ht_damage_t damage;
        ht_damage(&before,&after,&damage);
        assert(damage.pixels>0 && damage.pixels<=4096);
        frames++; pixels+=damage.pixels;
        if(damage.pixels>max_pixels) max_pixels=damage.pixels;
        before=after;
    }
    assert(frames>=12 && frames<=24); // sparse two-frame blinks, never a continuous redraw loop
    printf("tim-motion: {\"idle_seconds\":60,\"frames\":%u,\"display_bytes\":%u,\"max_frame_bytes\":%u}\n",frames,pixels*2,max_pixels*2);
    ht_tim_motion_tick(&m,62000,HT_TIM_CONTENT,true,true,false,233,0,0);
    for(uint32_t t=62025;t<82000;t+=25)
        assert(!ht_tim_motion_tick(&m,t,HT_TIM_CONTENT,true,true,true,400,4,3));
    ht_tim_motion_tick(&m,83000,HT_TIM_CONTENT,false,false,false,233,0,0);
    for(uint32_t t=83025;t<103000;t+=25)
        assert(!ht_tim_motion_tick(&m,t,HT_TIM_WORKING,false,false,false,233,0,t));
    assert(ht_tim_motion_tick(&m,104000,HT_TIM_CONTENT,false,true,true,400,0,0));
    assert(m.pose.look==2 && m.pose.pressed && !m.pose.blink);
    assert(ht_tim_motion_tick(&m,104100,HT_TIM_CONTENT,false,true,true,50,0,0));
    assert(m.pose.look==-2);
    ht_tim_motion_tick(&m,104150,HT_TIM_CONTENT,false,true,false,50,0,0);
    assert(m.pose.look==-2 && !m.pose.pressed);
    ht_tim_motion_tick(&m,104550,HT_TIM_CONTENT,false,true,false,50,0,0);
    assert(m.pose.look==0);
    ht_tim_motion_tick(&m,105000,HT_TIM_WORKING,false,true,false,233,0,10);
    assert(m.pose.hands);
    ht_tim_motion_tick(&m,105850,HT_TIM_WORKING,false,true,false,233,0,11);
    assert(!m.pose.hands); // event storm cannot continuously restart the reaction
    ht_tim_motion_tick(&m,107100,HT_TIM_WORKING,false,true,false,233,0,12);
    assert(m.pose.hands);
    ht_tim_motion_tick(&m,108000,HT_TIM_LISTENING,false,true,false,233,4,12);
    assert(m.pose.level==4);
    before=scene(m.pose,false,HT_TIM_LISTENING);
    ht_tim_motion_tick(&m,108050,HT_TIM_LISTENING,false,true,true,233,0,12);
    assert(m.pose.level==4); // raw touch reports cannot raise mic animation above 8Hz
    ht_tim_motion_tick(&m,108125,HT_TIM_LISTENING,false,true,false,233,0,12);
    ht_scene_t after=scene(m.pose,false,HT_TIM_LISTENING); ht_damage_t damage;
    ht_damage(&before,&after,&damage); assert(damage.pixels>0 && damage.pixels<=4096);
    before=scene((ht_tim_pose_t){0},true,HT_TIM_CONTENT);
    after=scene((ht_tim_pose_t){.blink=true},true,HT_TIM_CONTENT);
    ht_damage(&before,&after,&damage); assert(damage.pixels>0 && damage.pixels<=4096);
    m=(ht_tim_motion_t){0};
    ht_tim_motion_tick(&m,UINT32_MAX-2000,HT_TIM_CONTENT,false,true,false,233,0,0);
    ht_tim_motion_tick(&m,3800,HT_TIM_CONTENT,false,true,false,233,0,0); assert(m.pose.blink);
    ht_tim_motion_tick(&m,3950,HT_TIM_CONTENT,false,true,false,233,0,0); assert(!m.pose.blink);
    ht_tim_motion_tick(&m,15000,HT_TIM_CONTENT,false,true,true,233,0,0);
    assert(m.next_ms>=100); // holding through a blink deadline must not create a 1ms render loop
    m=(ht_tim_motion_t){0};
    ht_tim_motion_tick(&m,100,HT_TIM_WORKING,false,true,false,233,0,0);
    ht_tim_motion_tick(&m,200,HT_TIM_DONE,false,true,false,233,0,0); assert(m.pose.look==2);
    ht_tim_motion_tick(&m,600,HT_TIM_DONE,false,true,false,233,0,0); assert(m.pose.look==-2);
    ht_tim_motion_tick(&m,1060,HT_TIM_DONE,false,true,false,233,0,0); assert(m.pose.blink);
    ht_tim_motion_tick(&m,1600,HT_TIM_DONE,false,true,false,233,0,0); assert(!m.pose.look && !m.pose.blink);
    ht_tim_motion_tick(&m,2000,HT_TIM_CONTENT,false,true,false,233,0,0);
    ht_tim_motion_tick(&m,2200,HT_TIM_DONE,true,true,false,233,0,0); assert(!m.pose.look && !m.pose.blink);
    ht_tim_motion_tick(&m,2400,HT_TIM_DONE,false,true,true,50,0,0); assert(m.pose.look==-2 && m.pose.pressed);
    puts("tim: PASS (bounded idle/event/mic damage, quiet, hidden screen, touch gaze, cooldown, wrap)");
}
