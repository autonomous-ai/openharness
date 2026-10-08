/* Player navigation and operational sheets. Appearance/Living has no route. */
static void pro_player_tabs(ht_scene_t *f)
{
    ht_scene_clear(f,PLAYER_BG);
    ht_pro_image(f,27,29,&player_back);
    ht_pro_text(f,65,24,430,&ht_pro_32,PLAYER_FG,"Tabs");
    pro_hit(16,8,450,68,A_AGENTS,0,true);
    ht_pro_text(f,568,30,130,&ht_pro_24,PLAYER_DIM,"Settings");
    pro_hit(544,8,160,68,A_SETTINGS,0,true);
    ht_pro_rect(f,0,86,720,1,0,color(0xb9b8af));
    pro_clamp_list(s.tab_count,6);
    for(int row=0;row<6 && row+s.offset<s.tab_count;row++) {
        int i=row+s.offset,y=106+row*100;
        bool selected=!strcmp(s.tabs[i].id,s.selected_tab);
        int hit=pro_hit(0,y,698,90,A_TAB,i,s.connected && !s.loading);
        if(selected || hit==s.pressed) ht_pro_rect(f,0,y,698,90,0,PLAYER_FG);
        ht_pro_text(f,40,y+26,630,&ht_pro_32,selected || hit==s.pressed ? PLAYER_BG : PLAYER_FG,s.tabs[i].name);
    }
    if(!s.tab_count) ht_pro_text(f,40,240,640,&ht_pro_32,PLAYER_DIM,"Open a tab in Harness.");
}

static void pro_player_settings(ht_scene_t *f)
{
    pro_heading(f,"Settings",A_TABS);
    pro_clamp_list(settings_count(),4);
    for(int row=0;row<4;row++) {
        action_kind_t action;
        const char *label=settings_item(s.offset+row,&action);
        if(!label) break;
        char text[80];
        if(action==A_BRIGHT) {snprintf(text,sizeof text,"Brightness · %d%%",s.brightness);label=text;}
        if(action==A_MUTE) label=s.muted ? "Sound off" : "Sound on";
        pro_row(f,146+row*108,label,"",action,0,
            action==A_BRIGHT || action==A_MUTE || action==A_LANGUAGE || s.connected,false);
    }
    pro_pager(f,settings_count(),4);
}

static void pro_player_controls(ht_scene_t *f)
{
    ht_scene_clear(f,PLAYER_BG);
    switch(s.view) {
    case TABS: pro_player_tabs(f); break;
    case LAUNCHER: case SETTINGS: case COMPANION: pro_player_settings(f); break;
    case AGENTS: pro_agents(f); break; // Explicit passage destination review only.
    case LANGUAGE: pro_language(f); break;
    case INBOX: pro_inbox(f); break;
    case MACHINES: pro_machines(f); break;
    case MODELS: pro_models(f); break;
    case READER: pro_reader(f); break;
    case QUESTION: pro_question(f); break;
    case CHOICE: pro_choices(f); break;
    case ANSWER_REVIEW: pro_answer(f); break;
    case SELECTION: pro_selection(f); break;
    case FORM: pro_form(f); break;
    case DRAFT: pro_draft(f); break;
    case DRAFT_OPTIONS: pro_draft_options(f); break;
    case CARRY_PREVIEW: pro_carry_preview(f); break;
    case STOP: pro_stop(f); break;
    case MESSAGE: pro_message(f); break;
    case OTA: render_brand(f); break;
    default: pro_player_library(f); break;
    }
}
