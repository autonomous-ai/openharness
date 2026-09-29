#include "companion.h"
#include "octopus.h"
#include "cJSON.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

static const char *string(const cJSON *p, const char *key) {
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(p,key);
    return cJSON_IsString(v) && v->valuestring ? v->valuestring : NULL;
}
static bool number(const cJSON *p,const char *key,double max,uint64_t *out) {
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(p,key);
    if(!cJSON_IsNumber(v)||!isfinite(v->valuedouble)||v->valuedouble<0||v->valuedouble>max||floor(v->valuedouble)!=v->valuedouble)return false;
    *out=(uint64_t)v->valuedouble;return true;
}
static bool text(const char *s,size_t max,bool word) {
    if(!s||!*s||strlen(s)>max)return false;
    for(const unsigned char *p=(const unsigned char *)s;*p;p++)
        if(*p<32||*p>126||(word&&!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||strchr("_:./-",*p))))return false;
    return true;
}
static bool member(const char *s,const char *const *list,size_t n) {
    if(!s)return false;
    for(size_t i=0;i<n;i++)if(!strcmp(s,list[i]))return true;
    return false;
}
#define IN(s,list) member(s,list,sizeof(list)/sizeof(*(list)))
void ht_companion_reset(ht_companion_t *c) { memset(c,0,sizeof *c);c->brightness=100; }
void ht_companion_disconnect(ht_companion_t *c) {
    // Keep only the last picture while the cable is away. A newly started
    // bridge gets a fresh serial baseline; no late art or action can revive it.
    c->connected=c->motion=c->transient=c->pending=false;c->frame=0;c->serial=0;
    c->action_id[0]=c->action_error[0]=c->reaction[0]=0;
    if(c->enabled){strcpy(c->emotion,"offline");strcpy(c->reason,"disconnected");}
}

static bool state(ht_companion_t *c,const cJSON *p,uint32_t now) {
    uint64_t v,serial,epoch,revision;
    const char *window=string(p,"window");
    const cJSON *enabled=cJSON_GetObjectItemCaseSensitive(p,"enabled");
    if(!number(p,"v",1,&v)||v!=1||!number(p,"serial",9007199254740991.,&serial)||
       !number(p,"epoch",2147483647,&epoch)||!number(p,"revision",9007199254740991.,&revision)||
       !text(window,80,true)||!cJSON_IsBool(enabled)||(c->managed&&serial<c->serial))return false;
    if(!cJSON_IsTrue(enabled)) {
        ht_companion_reset(c);c->managed=true;c->serial=serial;return true;
    }
    const char *phase=string(p,"phase"), *key=string(p,"art");
    const cJSON *motion=cJSON_GetObjectItemCaseSensitive(p,"motion");
    const cJSON *feeling=cJSON_GetObjectItemCaseSensitive(p,"feeling");
    const char *emotion=string(feeling,"emotion"), *reason=string(feeling,"reason");
    static const char *const emotions[]={"content","curious","bored","playful","working","focused","happy","excited","proud","relieved","frustrated","angry","sad","tired","exhausted","attentive","asleep","offline","listening","affectionate","hatching"};
    static const char *const phases[]={"egg","hatching","creature"};
    if(!IN(phase,phases)||!IN(emotion,emotions)||!text(reason,48,true)||!text(key,159,true)||!cJSON_IsBool(motion))return false;
    const char *reaction=string(feeling,"reactionId");uint64_t remaining=0;
    if(reaction&&(!text(reaction,256,true)||!number(feeling,"remainingMs",30000,&remaining)))return false;
    const cJSON *creature=cJSON_GetObjectItemCaseSensitive(p,"creature");
    const char *uid=string(creature,"uid"), *name=string(creature,"name");
    if(!strcmp(phase,"creature")||creature) {
        const char *id=string(creature,"id"), *age=string(creature,"version");uint64_t seed;
        static const char *const ages[]={"0.1","1.0","2.0"};
        if(!id||strcmp(id,"tim")||!text(uid,64,true)||!text(name,24,false)||!IN(age,ages)||!number(creature,"seed",4294967295.,&seed))return false;
    }
    const cJSON *egg=cJSON_GetObjectItemCaseSensitive(p,"egg");
    const char *kind=string(egg,"kind"), *stage=string(egg,"stage"), *egg_uid=string(egg,"uid");
    if(egg_uid&&!text(egg_uid,64,true))return false;
    if(strcmp(phase,"creature")) {
        static const char *const stages[]={"p0","p1","p2","p3","p4","rock","burst","tumble","open","hatchling"};
        if(!text(kind,24,true)||!IN(stage,stages))return false;
    }
    bool owner=!c->enabled||strcmp(window,c->window)||epoch!=c->epoch||strcmp(uid?uid:"",c->uid);
    bool same=reaction&&!owner&&!strcmp(reaction,c->reaction);
    uint32_t old_left=c->transient&&(int32_t)(c->expires-now)>0?c->expires-now:0;
    if(owner) {
        c->clips[0].complete=false;c->clips[1].complete=false;c->clips[0].key[0]=c->clips[1].key[0]=0;
        c->pending=false;c->action_id[0]=c->action_error[0]=0;
    }
    if(strcmp(c->art,key)) {c->began=now;c->frame=0;}
    c->managed=c->enabled=c->connected=true;c->serial=serial;c->revision=revision;c->epoch=(uint32_t)epoch;
    c->motion=cJSON_IsTrue(motion);c->now=now;c->transient=reaction!=NULL;
    c->expires=now+(same&&old_left<remaining?old_left:(uint32_t)remaining);
    snprintf(c->window,sizeof c->window,"%s",window);snprintf(c->uid,sizeof c->uid,"%s",uid?uid:"");
    snprintf(c->name,sizeof c->name,"%s",name?name:"");snprintf(c->phase,sizeof c->phase,"%s",phase);
    snprintf(c->art,sizeof c->art,"%s",key);snprintf(c->emotion,sizeof c->emotion,"%s",emotion);
    snprintf(c->reason,sizeof c->reason,"%s",reason);snprintf(c->reaction,sizeof c->reaction,"%s",reaction?reaction:"");
    snprintf(c->egg_uid,sizeof c->egg_uid,"%s",egg_uid?egg_uid:"");
    snprintf(c->egg,sizeof c->egg,"%s",kind?kind:"");snprintf(c->stage,sizeof c->stage,"%s",stage?stage:"");
    return true;
}

static bool rows(const char *s,char *out,int *width,int *height,bool material) {
    if(!s)return false;
    int x=0,y=0,w=0;
    for(const unsigned char *p=(const unsigned char *)s;;p++) {
        if(*p==0||*p=='\n') {
            if(!x||y>=HT_COMPANION_ROWS||(w&&x!=w))return false;
            w=x;y++;x=0;if(!*p)break;
        } else {
            if(x>=HT_COMPANION_COLS||y>=HT_COMPANION_ROWS||*p<32||*p>126||
                (material&&!strchr(".magsep ",*p)))return false;
            if(out)out[y*HT_COMPANION_COLS+x]=(char)*p;
            x++;
        }
    }
    *width=w;*height=y;return true;
}

bool ht_companion_receive(ht_companion_t *c,const cJSON *p,uint32_t now) {
    const char *t=string(p,"t");if(!t)return false;
    if(!strcmp(t,"companion.state"))return state(c,p,now);
    if(!strcmp(t,"companion.action.result")) {
        const char *id=string(p,"requestId");
        if(!c->pending||!id||strcmp(id,c->action_id))return false;
        c->pending=false;
        if(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p,"ok")))
            strcpy(c->action_error,"Check Harness and try again");
        return true;
    }
    const char *key=string(p,"key");uint64_t transfer;
    if(!c->enabled||!c->connected||!key||strcmp(key,c->art)||!number(p,"transfer",4294967295.,&transfer))return false;
    ht_companion_clip_t *clip=&c->clips[c->active^1];
    if(!strcmp(t,"companion.art.begin")) {
        uint64_t count,ms;
        const cJSON *palette=cJSON_GetObjectItemCaseSensitive(p,"palette"), *loop=cJSON_GetObjectItemCaseSensitive(p,"loop");
        if(!number(p,"count",HT_COMPANION_FRAMES,&count)||!count||!number(p,"frameMs",2000,&ms)||ms<40||
           !cJSON_IsBool(loop)||!cJSON_IsArray(palette)||cJSON_GetArraySize(palette)!=8)return false;
        uint16_t colors[8];
        for(int i=0;i<8;i++) {
            const cJSON *color=cJSON_GetArrayItem(palette,i);
            if(!cJSON_IsNumber(color)||!isfinite(color->valuedouble)||color->valuedouble<0||color->valuedouble>65535||floor(color->valuedouble)!=color->valuedouble)return false;
            colors[i]=(uint16_t)color->valuedouble;
        }
        memset(clip,0,sizeof *clip);strcpy(clip->key,key);clip->transfer=(uint32_t)transfer;
        clip->count=(uint8_t)count;clip->frame_ms=(uint16_t)ms;clip->loop=cJSON_IsTrue(loop);memcpy(clip->palette,colors,sizeof colors);return true;
    }
    if(strcmp(clip->key,key)||clip->transfer!=transfer||!clip->count)return false;
    if(!strcmp(t,"companion.art.frame")) {
        uint64_t index;int w,h,mw,mh;
        const char *ink=string(p,"rows"), *mats=string(p,"mats");
        if(!number(p,"index",clip->count-1,&index)||!rows(ink,NULL,&w,&h,false)||!rows(mats,NULL,&mw,&mh,true)||w!=mw||h!=mh||
           (clip->received&&(clip->cols!=w||clip->rows!=h)))return false;
        rows(ink,clip->ink[index],&w,&h,false);rows(mats,clip->mats[index],&mw,&mh,true);
        clip->cols=(uint8_t)w;clip->rows=(uint8_t)h;clip->received|=(uint8_t)(1u<<index);return true;
    }
    if(!strcmp(t,"companion.art.end")&&clip->received==(1u<<clip->count)-1) {
        clip->complete=true;c->active^=1;c->began=now;c->frame=0;return true;
    }
    return false;
}

bool ht_companion_tick(ht_companion_t *c,uint32_t now,bool quiet,bool visible) {
    uint8_t before=c->frame;uint32_t elapsed=now-c->now;c->now=now;
    bool timeout=c->pending&&(int32_t)(now-c->action_deadline)>=0;
    if(timeout){c->pending=false;strcpy(c->action_error,"No receipt. Check Harness");}
    const ht_companion_clip_t *clip=&c->clips[c->active];
    if(!visible) {c->began+=elapsed;return false;}
    bool expired=c->transient&&(int32_t)(c->expires-now)<=0;
    if(!c->enabled||!clip->complete||quiet||!c->motion||expired)c->frame=0;
    else {uint32_t f=(now-c->began)/clip->frame_ms;c->frame=(uint8_t)(clip->loop?f%clip->count:f>=clip->count?clip->count-1:f);}
    return timeout||before!=c->frame;
}

static uint16_t mix(uint16_t a,uint16_t b,unsigned q,unsigned total) {
    unsigned r=((a>>11)*(total-q)+(b>>11)*q)/total;
    unsigned g=(((a>>5)&63)*(total-q)+((b>>5)&63)*q)/total;
    unsigned blue=((a&31)*(total-q)+(b&31)*q)/total;
    return (uint16_t)((r<<11)|(g<<5)|blue);
}
// The layout callback is synchronous under display_lock. No retained pointer.
static const ht_companion_t *painting;
static void paint(ht_scene_t *s,const ht_character_face_t *face,uint8_t frame,uint16_t ink,ht_character_size_t size,int y) {
    (void)frame;(void)ink;
    const ht_companion_t *c=painting;const ht_companion_clip_t *clip=&c->clips[c->active];
    if(!c->enabled)return;
    if(!clip->complete||strcmp(clip->key,c->art)) {
        ht_center(s,210,&ht_mono_20,face->dim,!strcmp(c->phase,"creature")?c->name:"An egg is growing");return;
    }
    const ht_font_t *fonts[]={&ht_octopus_font_12,&ht_octopus_font_8,&ht_octopus_font_6,&ht_octopus_font_4,&ht_octopus_font_4};
    const ht_font_t *font=fonts[size<=HT_CHARACTER_QUICK?size:HT_CHARACTER_COMPACT];
    if(clip->cols*font->width>440)font=&ht_octopus_font_8;
    if(size==HT_CHARACTER_FULL)y=clip->rows>24?52:92;
    int x=(HT_WIDTH-clip->cols*font->width)/2;
    for(int row=0;row<clip->rows;row++) {
        int offset=row*HT_COMPANION_COLS;
        const char *text=&clip->ink[c->frame][offset], *mats=&clip->mats[c->frame][offset];
        if(!ht_ascii_text(s,x,y+row*font->height,clip->cols*font->width,font,face->foreground,s->background,text,clip->cols))break;
        ht_run_t *run=&s->runs[s->count-1];run->cell_color_count=clip->cols;
        if(face->mood==HT_CHARACTER_LISTENING)for(int col=0;col<clip->cols;col++)
            if(mats[col]=='p'&&(run->text[col]=='@'||run->text[col]=='o'))run->text[col]=face->pose.level>2?'O':'o';
        uint16_t body=mix(clip->palette[0],clip->palette[1],row,clip->rows>1?clip->rows-1:1);
        for(int col=0;col<clip->cols;col++) {
            unsigned mat=mats[col]=='m'?2:mats[col]=='a'?3:mats[col]=='e'?4:mats[col]=='g'?5:mats[col]=='s'?6:mats[col]=='p'?7:0;
            uint16_t color=mat?clip->palette[mat]:body;
            unsigned brightness=text[col]=='.'||text[col]==','?42:text[col]==':'?50:text[col]==';'?56:text[col]=='o'?78:text[col]=='x'?82:100;
            color=text[col]=='@'?mix(color,0xffff,35,100):mix(s->background,color,brightness,100);
            color=mix(0,color,c->brightness<8?8:c->brightness>100?100:c->brightness,100);
            if(!strcmp(c->emotion,"offline")||!strcmp(c->emotion,"asleep"))color=mix(s->background,color,55,100);
            run->cell_colors[col]=color;
        }
    }
}
void ht_companion_face(ht_scene_t *s,const ht_companion_t *c,const ht_character_face_t *face,const char *recap) {
    ht_character_face_t f=*face;
    const char *egg_hint=NULL;
    // The bell owns the footer. Companion hints stay above it; voice, carried
    // text and recaps keep their existing reading space and instructions.
    if((!recap||!*recap)&&!face->carrying&&!face->focus&&(!face->hint||!*face->hint)&&
        (!face->status||!*face->status)) {
        const char *hint=c->pending?"waiting...":c->action_error[0]?"check Harness":NULL;
        if(c->enabled&&!strcmp(c->phase,"egg"))
            egg_hint=!strcmp(c->stage,"p4")?
                (c->pending?"waiting...":c->action_error[0]?"[try hatch]":"[hatch]"):
                "tap egg to speak";
        else if(hint){f.focus=true;f.detail=hint;}
    }
    if((!recap||!*recap)&&!face->carrying&&!face->focus)f.roomy_reading=false;
    painting=c;ht_character_layout(s,&f,0,f.foreground,recap,paint);painting=NULL;
    if(egg_hint)ht_center(s,HT_COMPANION_HATCH_TEXT,&ht_mono_20,f.dim,egg_hint);
}
void ht_companion_portrait(ht_scene_t *s,const ht_companion_t *c,const ht_character_face_t *face,
                           ht_character_size_t size,int y) {
    painting=c;paint(s,face,0,face->foreground,size,y);painting=NULL;
}
