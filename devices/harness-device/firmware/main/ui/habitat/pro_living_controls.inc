/* Local animation review. These actions never send work to the computer. */
static void pro_living_button(ht_scene_t *f,int x,int y,int w,const char *label,
                               action_kind_t kind,int value,bool selected)
{
    int hit=pro_hit(x,y,w,60,kind,value,true);
    bool pressed=hit>=0 && hit==s.pressed;
    ht_pro_rect(f,x,y,w,60,22,color(selected||pressed?0x494052:0x222129));
    const ht_pro_font_t *font=&ht_pro_24;
    int text=ht_pro_width(font,label);
    ht_pro_text(f,x+(w-text)/2,y+(60-font->height)/2,w-20,font,
                color(selected?0xffedd1:0xd3ccd7),label);
}

static void pro_living_review(ht_scene_t *f)
{
    static const char *names[]={"Tim","Spirit","Moss"};
    static const char *moods[]={"At ease","Listening","Thinking","Happy","Sleepy","Surprised"};
    ht_scene_clear(f,color(0x101019));
    if (s.living_watch) {
        pro_living_image(f,s.living_character,s.living_mood,s.living_frame,104,104,512);
        pro_hit(0,0,720,720,A_LIVING_WATCH,0,true);
        return;
    }
    pro_living_button(f,32,24,136,PRO_TR("Back"),A_LAUNCHER,0,false);
    ht_pro_center(f,33,&ht_pro_32,color(0xe8deed),PRO_TR("A little company"));
    pro_living_button(f,536,24,152,PRO_TR("Just watch"),A_LIVING_WATCH,0,false);
    for (unsigned i=0;i<PRO_LIVING_CHARACTERS;i++)
        pro_living_button(f,32+(int)i*224,104,208,names[i],A_LIVING_CHARACTER,(int)i,s.living_character==i);
    pro_living_image(f,s.living_character,s.living_mood,s.living_frame,168,172,384);
    pro_hit(168,172,384,384,A_LIVING_WATCH,0,true);
    for (unsigned i=0;i<PRO_LIVING_MOODS;i++)
        pro_living_button(f,32+(int)(i%3)*224,562+(int)(i/3)*64,208,PRO_TR(moods[i]),
                           A_LIVING_MOOD,(int)i,s.living_mood==i);
}
