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
        int width=ht_pro_width(&ht_pro_24,label);
        ht_pro_image(f,678-width-36,31,provider);
        ht_pro_text(f,678-width,31,width,&ht_pro_24,PLAYER_DIM,label);
    }
    int title_rows=ht_pro_wrap(f,40,124,640,2,0,&ht_pro_56,PLAYER_FG,a && a->name[0] ? a->name : "Harness Player");
    char location[256];
    const char *machine=context && context->machine[0] ? context->machine : a ? a->machine : "";
    snprintf(location,sizeof location,"%s%s%s%s%s%s",machine,
        context && context->project[0] && machine[0] ? "   " : "",
        context ? context->project : "",context && context->branch[0] ? "   (" : "",
        context ? context->branch : "",context && context->branch[0] ? ")" : "");
    ht_pro_wrap(f,42,124+title_rows*ht_pro_56.height+5,630,2,0,&ht_pro_24,PLAYER_DIM,location);

    const char *content=a ? a->player.action : "";
    if (!s.connected) content="Connect to Harness";
    else if (s.loading) content="Loading sessions...";
    else if (!a) content=s.window ? "Choose a session on your computer." : "Open Harness on your computer.";
    else if (question) content=question->summary;
    if (voice) content=audio_client_recording() ? "Listening..." : voice_status();
    if (s.voice_retry_until || s.speech_error_until) content=s.message;
    ht_pro_wrap(f,42,354,632,3,0,&ht_pro_32,PLAYER_FG,content);

    const char *status=!s.connected ? "Disconnected" : s.loading ? "Connecting..." :
        question ? "Needs you" : !a ? "Ready" :
        a->busy ? (a->tool[0] ? a->tool : "Working...") :
        a->player.failed ? "Stopped with an error" :
        a->player.finished || a->recap_ready ? "Finished" : "Ready";
    if (!voice) {
        if (ready) pro_player_mark(f,36,650,a,PLAYER_DIM);
        ht_pro_text(f,ready ? 78 : 42,650,420,&ht_pro_24,PLAYER_DIM,status);
        if(question) {
            ht_pro_text(f,586,650,96,&ht_pro_24,PLAYER_FG,"Review");
            pro_hit(560,632,144,72,A_QUESTION,0,ready);
        }
        uint32_t seconds;
        if (ready && a->busy && !question && pro_player_elapsed(&a->player,ms(),&seconds)) {
            char elapsed[48];
            if (seconds>=3600) snprintf(elapsed,sizeof elapsed,"%luh %lum",(unsigned long)(seconds/3600),(unsigned long)(seconds/60%60));
            else snprintf(elapsed,sizeof elapsed,"%lum %lus",(unsigned long)(seconds/60),(unsigned long)(seconds%60));
            int width=ht_pro_width(&ht_pro_24,elapsed);
            ht_pro_text(f,678-width,650,width,&ht_pro_24,PLAYER_DIM,elapsed);
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

static void pro_player_library(ht_scene_t *f)
{
    ht_scene_clear(f,PLAYER_BG);
    const pro_player_overview_t *stats=&s.player_overview;
    bool fresh=s.connected && stats->received && (uint32_t)(ms()-stats->received_ms)<stats->valid_ms;
    char counts[80];
    int harnesses=fresh ? stats->harnesses : s.total;
    int machines=fresh ? stats->machines : s.machine_count;
    if(fresh && stats->models>=0) snprintf(counts,sizeof counts,"%d harnesses   %d machines   %d models",harnesses,machines,stats->models);
    else snprintf(counts,sizeof counts,"%d harnesses   %d machines",harnesses,machines);
    ht_pro_text(f,40,31,640,&ht_pro_24,PLAYER_DIM,counts);
    ht_pro_rect(f,0,86,720,1,0,color(0xb9b8af));
    pro_clamp_list(s.count,6);
    for (int row=0;row<6 && row+s.offset<s.count;row++) {
        int index=row+s.offset, y=106+row*100;
        const agent_t *a=&s.agents[index];
        bool selected=index==s.active;
        int hit=pro_hit(0,y,698,90,A_AGENT,index,s.connected && !s.loading);
        bool pressed=hit==s.pressed;
        if (selected || pressed) ht_pro_rect(f,0,y,698,90,0,PLAYER_FG);
        uint16_t ink=selected || pressed ? PLAYER_BG : PLAYER_FG;
        ht_pro_text(f,40,y+26,562,&ht_pro_32,ink,a->name);
        pro_player_mark(f,639,y+32,a,selected ? PLAYER_BG : PLAYER_DIM);
    }
    if (!s.count) ht_pro_wrap(f,40,230,640,3,0,&ht_pro_32,PLAYER_DIM,
        !s.connected ? "Connect to Harness" : s.loading ? "Loading sessions..." : "No sessions in this tab.");
    if(s.count>6) {
        int thumb=590*6/s.count;
        ht_pro_rect(f,708,106+590*s.offset/s.count,4,thumb,2,color(0xb9b8af));
    }
}
