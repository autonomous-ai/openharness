#include "illustrated.h"
#include "../../../assets/companions/companion_art.h"
#include <string.h>

static void image(ht_scene_t *scene, int x, int y, const companion_asset_t *asset, unsigned species, ht_companion_style_t style, int face_size)
{
    if (scene->count >= HT_RUNS) return;
    ht_run_t *run = &scene->runs[scene->count++];
    memset(run, 0, sizeof *run);
    unsigned age=style.stage<3?style.stage:2;
    unsigned scale=age==0?62:age==1?82:100;
    unsigned sx=scale,sy=scale;
    int ax=asset->x,ay=asset->y;
    int pivot_x=170*face_size/350,pivot_y=315*face_size/350;
    if (species==0 && age<2 && asset->role==0) {
        unsigned arm_x=age==0?80:85,arm_y=age==0?60:75;
        ax=pivot_x+(ax-pivot_x)*(int)arm_x/100;
        int root=191*face_size/350;
        ay=root+(ay-root)*(int)arm_y/100;
        sx=sx*arm_x/100;sy=sy*arm_y/100;
    }
    run->x=x+pivot_x+(ax-pivot_x)*(int)scale/100;
    run->y=y+pivot_y+(ay-pivot_y)*(int)scale/100;
    if (species==0 && age<2) run->y+=scale*(315-191)*(age==0?40:25)*face_size/350/10000;
    if (asset->role==4) { sx=sy=100;run->x=x+asset->x;run->y=y+asset->y; }
    unsigned width=(asset->width*sx+50)/100,height=(asset->height*sy+50)/100;
    if (!width) width=1;
    if (!height) height=1;
    run->w=width;
    run->sprite = (ht_sprite_t){.asset=asset, .revision=(asset->offset+1)*256+age*64+(style.colour<6?(style.colour+1)*8:0)+style.mark,
        .species=species,.colour=style.colour,.mark=style.mark,
        .width=width, .height=height};
}

bool ht_illustrated_tick_species(ht_character_motion_t *m, unsigned species, uint32_t now, ht_character_mood_t mood,
    bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity)
{
    if ((unsigned)mood >= HT_CHARACTER_MOODS) mood = HT_CHARACTER_IDLE;
    bool new_mood = !m->initialized || m->reaction.mood != mood;
    bool changed = ht_character_reaction_tick(&m->reaction, now, mood, quiet, visible,
                                             down, x, level, activity);
    unsigned step = mood == HT_CHARACTER_LISTENING ? 100 : companion_timing[species<10?species:0][mood];
    if (!step) step=200;
    unsigned duration = step * 4;
    bool running = visible && !quiet && !down && mood != HT_CHARACTER_OFFLINE;
    bool finite = mood == HT_CHARACTER_DONE || mood == HT_CHARACTER_BOOPED;
    if (new_mood) m->phase = 0;
    else if (m->running && running) {
        uint32_t elapsed = now - m->last_ms;
        if (finite) m->phase = elapsed >= duration-1-m->phase ? duration-1 : m->phase+elapsed;
        else m->phase = (m->phase + elapsed % duration) % duration;
    }
    uint8_t previous = m->frame;
    m->frame = quiet || mood == HT_CHARACTER_OFFLINE ? 0 : m->phase / step;
    if (mood == HT_CHARACTER_LISTENING && !quiet) m->frame += m->reaction.pose.level * 4;
    m->initialized = true; m->running = running; m->last_ms = now;
    m->next_ms = m->reaction.next_ms;
    if (running && !(finite && m->phase == duration-1)) {
        uint32_t next = step - m->phase % step;
        if (next < m->next_ms) m->next_ms = next;
    }
    return changed || new_mood || m->frame != previous;
}

bool ht_illustrated_tick(ht_character_motion_t *m,uint32_t now,ht_character_mood_t mood,
    bool quiet,bool visible,bool down,int x,unsigned level,uint32_t activity)
{ return ht_illustrated_tick_species(m,0,now,mood,quiet,visible,down,x,level,activity); }

void ht_illustrated_draw(ht_scene_t *s, unsigned species, const ht_character_face_t *f,
    uint8_t frame, uint16_t ink, ht_character_size_t size, int y)
{
    (void)ink;
    if (species >= COMPANION_COUNT) return;
    unsigned small = size == HT_CHARACTER_BRIEF || size == HT_CHARACTER_READING || size == HT_CHARACTER_QUICK;
    unsigned mood = (unsigned)f->mood < HT_CHARACTER_MOODS ? f->mood : HT_CHARACTER_IDLE;
    // Expression order in the shared artwork adds blink after idle.
    unsigned expression = mood ? mood + 1 : 0;
    unsigned group = mood == HT_CHARACTER_WORKING ? 1 : mood == HT_CHARACTER_ATTENTION ? 2 :
        mood == HT_CHARACTER_DONE || mood == HT_CHARACTER_BOOPED ? 3 : 0;
    unsigned phase = frame % 4, variant = 2;
    ht_companion_style_t style=f->companion_style;
    unsigned stage=style.stage<3?style.stage:2;
    style.stage=stage;
    if (mood == HT_CHARACTER_LISTENING) { phase = frame % 4; variant = frame / 4; }
    else if ((mood == HT_CHARACTER_IDLE || mood == HT_CHARACTER_WORKING) && f->pose.blink) expression = 1;
    if (f->pose.pressed) {
        int gaze = f->pose.look + 2;
        variant = gaze < 0 ? 0 : gaze > 4 ? 4 : (unsigned)gaze;
        expression = 0; phase = 0;
    }
    if (variant > 4) variant = 4;
    int x = (HT_WIDTH - (small ? 108 : 240)) / 2;
    x += companion_growth_offset[stage][small][species][0];
    y += companion_growth_offset[stage][small][species][1];
    static const int8_t swing[4]={0,1,0,-1},hop[4]={0,-1,-2,-1};
    if (mood!=HT_CHARACTER_OFFLINE && mood!=HT_CHARACTER_ASLEEP) x+=swing[phase]*companion_motion[species][0];
    if (mood==HT_CHARACTER_DONE || mood==HT_CHARACTER_BOOPED) y+=hop[phase]*companion_motion[species][1]/2;
    image(s, x, y, &companion_parts[stage][small][species][group][phase][0],species,style,small?108:240);
    image(s, x, y, &companion_bodies[stage][small][species],species,style,small?108:240);
    image(s, x, y, &companion_parts[stage][small][species][group][phase][1],species,style,small?108:240);
    image(s, x, y, &companion_faces[stage][small][species][expression][variant],species,style,small?108:240);
    if (f->pose.mail) image(s, x + companion_letter_anchor[stage][small][species][0],
        y + companion_letter_anchor[stage][small][species][1] - (f->pose.mail > 1 ? 4 : 0),
        &companion_letters[small],species,style,small?108:240);
}
