/* Harness Player 1. Identity, one recent action, and the engine's live state. */
#include "pro_player_icons.h"
#define PLAYER_BG color(0xeeede5)
#define PLAYER_FG color(0x191a18)
#define PLAYER_DIM color(0x73746e)
#define PLAYER_BLUE color(0x438fde)
#define PLAYER_AMBER color(0xd49b20)

static const pro_player_context_t *pro_player_context(const agent_t *a)
{
    if (!a) return NULL;
    for (unsigned i=0;i<PRO_PLAYER_CONTEXTS;i++)
        if (!strcmp(s.player_context[i].id,a->id)) return &s.player_context[i];
    return NULL;
}

static const cable_notif_t *pro_player_question(const char *id)
{
    for (int i=0;i<s.notice_count;i++)
        if (s.notice[i].question && !strcmp(s.notice[i].agent_id,id)) return &s.notice[i];
    return NULL;
}

static void pro_player_mark(ht_scene_t *f, int x, int y, const agent_t *a, uint16_t ink)
{
    if (is_question(a->id)) {
        ht_pro_image(f,x,y,&player_question);
    } else if (a->busy) ht_pro_image(f,x,y,player_working[s.status_phase%10]);
    else if (a->player.failed) ht_pro_image(f,x,y,&player_failed);
    else if (a->player.finished || a->recap_ready) {
        ht_pro_image(f,x,y,&player_done);
    } else ht_pro_rect(f,x+9,y+9,10,10,5,ink);
}

static void pro_player_home(ht_scene_t *f)
{
    ht_scene_clear(f,PLAYER_BG);
    agent_t *a=active();
    bool voice=s.view==VOICE;
    bool ready=s.connected && !s.loading && a;
    const cable_notif_t *question=a ? pro_player_question(a->id) : NULL;
    if (!voice) {
        ht_pro_image(f,24,27,&player_back);
        pro_hit(0,0,90,90,A_AGENTS,0,true);
    }
    const pro_player_context_t *context=pro_player_context(a);
    bool fresh=s.connected && context && !strcmp(context->engine,a->engine) &&
        (uint32_t)(ms()-context->received_ms)<context->valid_ms;
    const ht_pro_bitmap_t *provider=a && !strcmp(a->engine,"codex") ? &player_codex :
        a && !strcmp(a->engine,"claude") ? &player_claude : NULL;
    if (provider) {
        int remaining=fresh ? context->remaining_bp : -1;
        char label[16];
        if(remaining>0 && remaining<100) snprintf(label,sizeof label,"<1%%");
        else if(remaining>=0) snprintf(label,sizeof label,"%d%%",remaining/100);
        else snprintf(label,sizeof label,"-");
        int width=ht_pro_width(&ht_pro_32,label);
        ht_pro_image(f,678-width-40,37,provider);
        ht_pro_text(f,678-width,31,width,&ht_pro_32,PLAYER_DIM,label);
    }
    int title_rows=ht_pro_wrap(f,40,124,640,2,0,&ht_pro_56,PLAYER_FG,a && a->name[0] ? a->name : "Harness Player");
    char location[160];
    const char *machine=context && context->machine[0] ? context->machine : a ? a->machine : "";
    snprintf(location,sizeof location,"%s%s%s",machine,
        context && context->project[0] && machine[0] ? " / " : "",context ? context->project : "");
    int metadata_y=124+title_rows*ht_pro_56.height+5;
    ht_pro_text(f,42,metadata_y,630,&ht_pro_32,PLAYER_DIM,location);
    int branch_rows=context && context->branch[0] ?
        ht_pro_wrap(f,42,metadata_y+ht_pro_32.height,630,2,0,&ht_pro_32,PLAYER_DIM,context->branch) : 0;
    int content_y=metadata_y+(branch_rows+1)*ht_pro_32.height+28;
    if(content_y<354) content_y=354;

    const char *content=a ? (!a->busy && a->recap_ready ? a->preview : a->player.action) : "";
    if (!s.connected) content="Connect to Harness";
    else if (s.loading) content="Loading sessions...";
    else if (!a) content=s.window ? "Choose a session on your computer." : "Open Harness on your computer.";
    else if (question) content=question->summary;
    if (voice) content=audio_client_recording() ? "Listening..." : voice_status();
    if (s.voice_retry_until || s.speech_error_until) content=s.message;
    ht_pro_wrap(f,42,content_y,632,(622-content_y)/ht_pro_42.height,0,&ht_pro_42,PLAYER_FG,content);

    const char *status=!s.connected ? "Disconnected" : s.loading ? "Connecting..." :
        question ? "Needs you" : !a ? "Ready" :
        a->busy ? (a->tool[0] ? a->tool : "Working...") :
        a->player.failed ? "Stopped with an error" :
        a->player.finished || a->recap_ready ? "Finished" : "Ready";
    if (!voice) {
        if (ready) pro_player_mark(f,36,650,a,PLAYER_DIM);
        ht_pro_text(f,ready ? 78 : 42,642,350,&ht_pro_32,PLAYER_DIM,status);
        if(question) {
            ht_pro_text(f,570,642,112,&ht_pro_32,PLAYER_FG,"Review");
            pro_hit(560,632,144,72,A_QUESTION,0,ready);
        }
        uint32_t seconds;
        if (ready && a->busy && !question && pro_player_elapsed(&a->player,ms(),&seconds)) {
            char elapsed[48];
            if (seconds>=3600) snprintf(elapsed,sizeof elapsed,"%luh %lum",(unsigned long)(seconds/3600),(unsigned long)(seconds/60%60));
            else snprintf(elapsed,sizeof elapsed,"%lum %lus",(unsigned long)(seconds/60),(unsigned long)(seconds%60));
            int width=ht_pro_width(&ht_pro_32,elapsed);
            ht_pro_text(f,678-width,642,width,&ht_pro_32,PLAYER_DIM,elapsed);
        }
    }
    // Navigation owns its explicit targets; the rest keeps the shared gestures.
    if(voice) {
        pro_hit(0,0,720,720,A_PET,0,true);
    } else if(question) {
        pro_hit(90,0,630,90,A_PET,0,ready);
        pro_hit(0,90,720,542,A_PET,0,ready);
        pro_hit(0,632,560,72,A_PET,0,ready);
        pro_hit(0,704,720,16,A_PET,0,ready);
    } else {
        pro_hit(90,0,630,90,A_PET,0,ready);
        pro_hit(0,90,720,630,A_PET,0,ready);
    }
}

static void pro_player_row_mark(ht_scene_t *f,int x,int y,pro_player_status_t status,uint16_t ink)
{
    switch(status) {
    case PLAYER_WORKING: ht_pro_image(f,x,y,player_working[s.status_phase%10]); break;
    case PLAYER_QUESTION: ht_pro_image(f,x,y,&player_question); break;
    case PLAYER_FINISHED: ht_pro_image(f,x,y,&player_done); break;
    case PLAYER_FAILED: ht_pro_image(f,x,y,&player_failed); break;
    case PLAYER_PAUSED:
        ht_pro_rect(f,x+6,y+4,5,20,1,ink); ht_pro_rect(f,x+17,y+4,5,20,1,ink); break;
    case PLAYER_OFFLINE: ht_pro_rect(f,x+5,y+12,18,3,1,ink); break;
    default: ht_pro_rect(f,x+9,y+9,10,10,5,ink); break;
    }
}
static void pro_player_library(ht_scene_t *f)
{
    ht_scene_clear(f,PLAYER_BG);
    const pro_player_library_t *page=&s.player_library;
    bool paged=page->received;
    int count=paged ? page->total : s.count;
    int machines=paged ? page->machines : s.machine_count;
    char counts[80];
    snprintf(counts,sizeof counts,"%d sessions across %d machines",count,machines);
    ht_pro_text(f,36,20,648,&ht_pro_42,PLAYER_FG,"Library");
    ht_pro_text(f,36,82,648,&ht_pro_32,PLAYER_DIM,counts);
    if(!paged) pro_clamp_list(s.count,6);
    int offset=paged ? page->offset : s.offset;
    int visible=paged ? page->count : s.count-s.offset;
    for(int row=0;row<6 && row<visible;row++) {
        int index=offset+row,y=144+row*92;
        const pro_player_row_t *item=paged ? &page->rows[row] : NULL;
        const agent_t *a=paged ? NULL : &s.agents[index];
        const char *id=item ? item->id : a->id;
        const char *name=item ? item->name : a->name;
        const char *engine=item ? item->engine : a->engine;
        bool selected=active() && !strcmp(active()->id,id);
        bool enabled=s.connected && !s.loading && (!paged || !page->pending);
        int hit=pro_hit(16,y,682,84,item ? A_PLAYER_SESSION : A_AGENT,item ? row : index,enabled);
        bool highlighted=selected || hit==s.pressed;
        if(highlighted) ht_pro_rect(f,16,y,682,84,12,color(0xe0dfd6));
        uint16_t ink=enabled ? PLAYER_FG : PLAYER_DIM;
        const ht_pro_bitmap_t *provider=!strcmp(engine,"codex") ? &player_codex :
            !strcmp(engine,"claude") ? &player_claude : NULL;
        if(provider) ht_pro_image(f,34,y+29,provider);
        else ht_pro_text(f,30,y+23,46,&ht_pro_24,PLAYER_DIM,!strcmp(engine,"terminal") ? ">_" : "o");
        ht_pro_text(f,84,y+13,438,&ht_pro_42,ink,name);
        if(item) {
            pro_player_status_t status=item->status;
            if(status==PLAYER_WORKING && (uint32_t)(ms()-page->received_ms)>25000) status=PLAYER_OFFLINE;
            pro_player_row_mark(f,540,y+28,status,PLAYER_DIM);
        } else pro_player_mark(f,540,y+28,a,PLAYER_DIM);
        char age[24]="-";
        if(item && item->age_seconds>=0) {
            unsigned long seconds=(unsigned long)item->age_seconds+(uint32_t)(ms()-page->received_ms)/1000;
            if(seconds<60) snprintf(age,sizeof age,"now");
            else if(seconds<3600) snprintf(age,sizeof age,"%lum",seconds/60);
            else if(seconds<86400) snprintf(age,sizeof age,"%luh",seconds/3600);
            else snprintf(age,sizeof age,"%lud",seconds/86400);
        }
        int width=ht_pro_width(&ht_pro_32,age);
        ht_pro_text(f,677-width,y+22,width,&ht_pro_32,PLAYER_DIM,age);
    }
    if(!visible) ht_pro_wrap(f,36,250,648,3,0,&ht_pro_42,PLAYER_DIM,
        !s.connected ? "Connect to Harness" : page->pending || s.loading ? "Loading sessions..." : "No sessions yet.");
    if(count>6) {
        int thumb=552*6/count; if(thumb<8) thumb=8;
        ht_pro_rect(f,708,144+(552-thumb)*offset/(count-6),4,thumb,2,color(0xb9b8af));
    }
}
