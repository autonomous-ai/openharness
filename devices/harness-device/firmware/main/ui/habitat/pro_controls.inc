#include "pro_work_intent.h"
#include "pro_metrics.h"
/* Harness Pro sheets. Included by ui_habitat.c after the shared view helpers.
 * Controls retain recipient, revision and explicit review guards. Instruction
 * choices use the existing voice command and draft protocols. */
#if HT_FACE_PX >= 720

static int pro_hit(int x, int y, int w, int h, action_kind_t action, int value, bool enabled)
{
    if (s.hit_count >= (int)(sizeof s.hits / sizeof s.hits[0])) return -1;
    int index = s.hit_count++;
    s.hits[index] = (hit_t){{x, y, w, h}, action, value, enabled};
    return index;
}

static void pro_control(ht_scene_t *f, int x, int y, int w, int h, const char *label,
                        action_kind_t action, int value, bool enabled)
{
    int hit = pro_hit(x, y, w, h, action, value, enabled);
    bool pressed = hit >= 0 && hit == s.pressed;
    bool primary = action == A_ANSWER || action == A_DRAFT_SEND || action == A_FORM_MAIN ||
                   action == A_CHOICE || action == A_QUESTION || action == A_CARRY || action == A_APPEAR_USE ||
                   (action == A_NOTICE && !(s.view == INBOX && value >= 0 && value < s.notice_count &&
                       s.notice[value].question && !s.notice[value].question_unavailable && cable_client_supports(CABLE_FEATURE_QUESTIONS))) ||
                   action == A_SAMPLE_PLAY;
    uint16_t fill = enabled && (pressed || primary) ? ACCENT : SEL;
    if (enabled && action == A_STOP_YES) fill = color(0xa44343);
    uint16_t ink = !enabled ? DIM : pressed || primary || action == A_STOP_YES ?
                   color(0xfffdf5) : FG;
    ht_pro_rect(f, x, y, w, h, 22, fill);
    const ht_pro_font_t *font = &ht_pro_32;
    if (ht_pro_width(font, label) > w - 36) font = &ht_pro_24;
    int text_width = ht_pro_width(font, label);
    int text_x = x + (text_width < w - 36 ? (w - text_width) / 2 : 18);
    ht_pro_text(f, text_x, y + (h - font->height) / 2, w - 36, font, ink, label);
}

static void pro_heading(ht_scene_t *f, const char *title, action_kind_t back)
{
    bool enabled = !(back == A_QUESTION_BACK && s.q.pending) &&
                   !((back == A_DRAFT_OPTIONS || back == A_DRAFT_BACK) && draft.pending) &&
                   !(back == A_FORM_BACK && form.pending && strncmp(form.id, "find-", 5));
    pro_control(f, 28, 28, 136, 64, back == A_DRAFT_OPTIONS ? "Options" : PRO_TR("Back"), back, 0, enabled);
    const ht_pro_font_t *font = ht_pro_width(&ht_pro_42, title) <= 500 ? &ht_pro_42 : &ht_pro_32;
    ht_pro_text(f, 188, 39, 500, font, FG, title);
    ht_pro_rect(f, 32, 113, 656, 2, 0, SEL);
}

static void pro_note(ht_scene_t *f, const char *text)
{
    ht_pro_center(f, 680, &ht_pro_24, DIM, text);
}

static void pro_pager(ht_scene_t *f, int count, int visible)
{
    int first = count ? s.offset + 1 : 0;
    int last = s.offset + visible;
    if (last > count) last = count;
    char position[48];
    snprintf(position, sizeof position, PRO_TR("%d - %d of %d"), first, last, count);
    pro_control(f, 32, 606, 148, 64, PRO_TR("Previous"), A_UP, 0, s.offset > 0);
    ht_pro_text(f, 208, 624, 304, &ht_pro_24, DIM, position);
    pro_control(f, 540, 606, 148, 64, PRO_TR("Next"), A_DOWN, count, s.offset + visible < count);
}

static void pro_clamp_list(int count, int visible)
{
    int last = count > visible ? count - visible : 0;
    if (s.offset > last) s.offset = last;
    if (s.offset < 0) s.offset = 0;
}

static void pro_row(ht_scene_t *f, int y, const char *name, const char *detail,
                    action_kind_t action, int value, bool enabled, bool selected)
{
    int hit = pro_hit(32, y, 656, 96, action, value, enabled);
    bool pressed = hit >= 0 && hit == s.pressed;
    ht_pro_rect(f, 32, y, 656, 96, 24, pressed || selected ? SEL : color(0xfcfbf4));
    if (selected) ht_pro_rect(f, 32, y + 22, 5, 52, 2, ACCENT);
    ht_pro_text(f, 54, y + 10, 612, &ht_pro_32, !enabled ? DIM : pressed || selected ? ACCENT : FG, name);
    ht_pro_text(f, 54, y + 56, 612, &ht_pro_24, DIM, detail ? detail : "");
}

static void pro_launcher(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Menu"), A_HOME);
    if (s.connected && s.metrics.supported && cable_client_supports(CABLE_FEATURE_METRICS))
        pro_control(f,534,28,154,64,PRO_TR("Today"),A_TODAY,0,true);
    pro_control(f, 32, 132, 208, 70, PRO_TR("Instruct"), A_WORK_INTENT, 0,
                s.connected && !s.loading && active() && !carry.active && !carry.error[0]);
    pro_control(f, 256, 132, 208, 70, PRO_TR("Voice"), A_VOICE_SAMPLES, 0, true);
    pro_control(f, 480, 132, 208, 70, PRO_TR("Language"), A_LANGUAGE, 0, true);
    static const struct { const char *title, *detail; action_kind_t action; } items[] = {
        {"Panes", "Choose who to talk to", A_AGENTS},
        {"Tabs", "Change your workspace", A_TABS},
        {"Updates", "Read what came back", A_INBOX},
        {"Read", "Your latest result", A_READER},
        {"Daemon", "Choose your company", A_DAEMONS},
        {"Scene", "Set the backdrop", A_SCENES},
        {"Machines", "Reach another computer", A_MACHINES},
        {"Controls", "Make it yours", A_SETTINGS},
    };
    for (int i = 0; i < 8; i++) {
        int x = 32 + (i % 2) * 336, y = 218 + (i / 2) * 112;
        bool enabled = items[i].action == A_INBOX || items[i].action == A_SETTINGS ||
                       items[i].action == A_DAEMONS || items[i].action == A_SCENES ||
                       (s.connected && (items[i].action != A_READER || active()));
        int hit = pro_hit(x, y, 320, 100, items[i].action, 0, enabled);
        bool pressed = hit >= 0 && hit == s.pressed;
        ht_pro_rect(f, x, y, 320, 100, 28, pressed ? SEL : color(0xfcfbf4));
        ht_pro_text(f, x + 22, y + 9, 276, &ht_pro_32, enabled ? FG : DIM, PRO_TR(items[i].title));
        ht_pro_wrap(f, x + 22, y + 58, 276, 1, 0, &ht_pro_24, DIM, PRO_TR(items[i].detail));
    }
}

static void pro_work_intent(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("New instruction"), A_LAUNCHER);
    int recipient = find(s.work_agent);
    agent_t *a = recipient >= 0 ? &s.agents[recipient] : NULL;
    bool ready = s.connected && !s.loading && a;
    ht_pro_text(f, 48, 132, 624, &ht_pro_24, DIM, a ? a->name : PRO_TR("Choose a pane"));
    static const char *details[] = {"One request", "Work toward an objective", "Say a task and an interval"};
    int row = 0;
    for (int mode = PRO_WORK_TASK; mode <= PRO_WORK_LOOP; mode++) {
        if (!pro_work_available(a, mode) ||
            (mode != PRO_WORK_TASK && (s.work_generation != s.draft_recovery.generation ||
                                      strcmp(s.work_host, s.draft_recovery.current_host)))) continue;
        pro_row(f, 188 + row++ * 118, PRO_TR(pro_work_label(mode)), PRO_TR(details[mode]),
                A_WORK_MODE, mode, ready, s.work_mode == mode);
    }
    bool supported = ready && pro_work_available(a, s.work_mode) &&
        (s.work_mode == PRO_WORK_TASK || (s.work_generation == s.draft_recovery.generation &&
                                        !strcmp(s.work_host, s.draft_recovery.current_host)));
    pro_control(f, 216, 606, 288, 68, PRO_TR("Speak"), A_WORK_RECORD, 0, supported);
    bool needs_local = ready && !pro_work_local(a) &&
        pro_work_supported(a->engine, PRO_WORK_GOAL, cable_client_supports(CABLE_FEATURE_DRAFT));
    pro_note(f, needs_local ? (!strcmp(a->engine, "claude") ?
                            "Goal and Loop need a local pane." : "Goal needs a local pane.") :
                !supported ? PRO_TR("Choose the pane and instruction again.") :
                s.work_mode == PRO_WORK_TASK ? PRO_TR("Speak to this pane.") : PRO_TR("Review before sending."));
}

static void pro_today(ht_scene_t *f)
{
    pro_heading(f,PRO_TR("Today"),A_LAUNCHER);
    const pro_metrics_t *m=&s.metrics;
    const pro_metrics_usage_t *u=&m->usage;
    bool ready=m->phase==PRO_METRICS_READY && !pro_metrics_expired(m,ms());
    ht_pro_text(f,48,136,624,&ht_pro_32,FG,u->machine_name[0]?u->machine_name:PRO_TR("This computer"));
    if (u->day[0]) ht_pro_text(f,48,184,624,&ht_pro_24,DIM,u->day);
    if (ready) {
        char amount[40];
        if (!u->has_cost) snprintf(amount,sizeof amount,"%s",PRO_TR("Unavailable"));
        else if (u->cost>0 && u->cost<0.01) snprintf(amount,sizeof amount,"<$0.01");
        else {
            uint64_t cents=(uint64_t)(u->cost*100+0.5);
            snprintf(amount,sizeof amount,"$%llu.%02u",(unsigned long long)(cents/100),(unsigned)(cents%100));
        }
        const ht_pro_font_t *font=ht_pro_width(&ht_pro_56,amount)<=624?&ht_pro_56:&ht_pro_42;
        ht_pro_text(f,48,224,624,font,u->has_cost?FG:DIM,amount);
        ht_pro_text(f,48,309,624,&ht_pro_24,DIM,PRO_TR("USD estimate"));
        ht_pro_text(f,48,360,624,&ht_pro_24,FG,PRO_TR(u->coverage==PRO_METRICS_PARTIAL?"Partial coverage":"Opted-in sources"));
        static const char *names[]={"Claude","Codex","OpenCode"};
        for (unsigned i=0;i<3;i++) {
            const pro_metrics_provider_t *p=&u->providers[i];
            const char *label=!p->enabled?"Off":p->state==PRO_SOURCE_SCANNING?"Reading...":
                p->state==PRO_SOURCE_OK?(p->priced?"Included":"Unpriced"):
                p->state==PRO_SOURCE_PARTIAL?"Partial":"Unavailable";
            ht_pro_text(f,48,410+(int)i*45,268,&ht_pro_24,DIM,names[i]);
            ht_pro_text(f,340,410+(int)i*45,332,&ht_pro_24,DIM,PRO_TR(label));
        }
        char age[96];
        if (!u->has_cost) snprintf(age,sizeof age,"%s",PRO_TR("Choose sources in Harness."));
        else {
            uint64_t age_ms=pro_metrics_age(m,ms()); unsigned minute=(unsigned)(age_ms/60000);
            if (!minute) snprintf(age,sizeof age,"%s",PRO_TR("Scan: less than 1 min ago"));
            else snprintf(age,sizeof age,PRO_TR(u->stale || age_ms>300000?"Older scan: about %u min ago":"Scan: about %u min ago"),minute);
        }
        ht_pro_text(f,48,555,624,&ht_pro_24,DIM,age);
    } else {
        const char *title=m->phase==PRO_METRICS_WAIT?"Reading local usage...":"Unavailable";
        ht_pro_text(f,48,260,624,&ht_pro_42,DIM,PRO_TR(title));
        const char *detail=!s.connected?"Connect to Harness":
            !m->supported?"Update Harness to read usage.":
            m->phase==PRO_METRICS_WAIT?"Opted-in sources only.":
            m->phase==PRO_METRICS_EXPIRED || (m->phase==PRO_METRICS_READY && !ready)?"Refresh for the new day.":"Try again in Harness.";
        ht_pro_wrap(f,48,334,624,2,0,&ht_pro_24,DIM,PRO_TR(detail));
    }
    pro_control(f,216,606,288,68,PRO_TR("Refresh"),A_TODAY_REFRESH,0,
                s.connected && m->supported && m->phase!=PRO_METRICS_WAIT);
    pro_note(f,PRO_TR("This computer only."));
}

static void pro_language(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Language"), A_LAUNCHER);
    ht_pro_wrap(f, 32, 148, 656, 2, 0, &ht_pro_32, FG, PRO_TR("Choose your display and voice language."));
    ht_pro_text(f, 32, 230, 656, &ht_pro_24, DIM, PRO_TR("Applies to menus and your next recording."));
    bool english = !strcmp(s.voice_language, "en");
    bool vietnamese = !strcmp(s.voice_language, "vi");
    pro_row(f, 286, "English", english ? PRO_TR("Selected") : "", A_LANGUAGE_SET, 0,
            !s.language_saving, english);
    pro_row(f, 402, "Tiếng Việt", vietnamese ? PRO_TR("Selected") : "", A_LANGUAGE_SET, 1,
            !s.language_saving, vietnamese);
    ht_pro_wrap(f, 48, 522, 624, 2, 0, &ht_pro_24, s.language_error ? ERROR : DIM,
                s.language_saving ? PRO_TR("Saving...") : s.language_error ?
                PRO_TR("Could not save. Tap a language to retry.") : PRO_TR("Saved on this device."));
}

static void pro_voice_samples(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Voice"), A_LAUNCHER);
    pro_control(f, 534, 28, 154, 64, PRO_TR("Params"), A_SAMPLE_PARAMS, 0, true);
    const pro_voice_sample_t *sample = pro_voice_sample(s.voice_sample);
    if (!sample) return;
    pro_voice_progress_t progress = pro_voice_sample_progress();
    if (progress.sample != s.voice_sample) progress = (pro_voice_progress_t){0};
    bool playing = progress.phase == PRO_VOICE_STARTING || progress.phase == PRO_VOICE_PLAYING;
    char text[160];
    snprintf(text, sizeof text, "%02u / %02u    %s", s.voice_sample + 1, pro_voice_sample_count(), sample->voice);
    ht_pro_text(f, 32, 132, 656, &ht_pro_32, ACCENT, text);
    ht_pro_text(f, 32, 178, 656, &ht_pro_42, FG, PRO_TR(sample->title));
    snprintf(text, sizeof text, "%s  /  [%s]", sample->model, sample->tag);
    ht_pro_text(f, 32, 237, 656, &ht_pro_24, DIM, text);
    ht_pro_rect(f, 32, 281, 656, 137, 24, color(0xfcfbf4));
    ht_pro_wrap(f, 52, 292, 616, 3, 0, &ht_pro_32, FG, sample->caption);
    snprintf(text, sizeof text, PRO_TR("Stability %u.%02u    Similarity %u.%02u"), sample->stability / 100,
             sample->stability % 100, sample->similarity / 100, sample->similarity % 100);
    ht_pro_text(f, 32, 435, 656, &ht_pro_24, DIM, text);
    const char *status = progress.phase == PRO_VOICE_ERROR ? progress.error :
                         progress.phase == PRO_VOICE_STARTING ? PRO_TR("Starting...") :
                         progress.phase == PRO_VOICE_PLAYING ? PRO_TR("Playing") :
                         progress.phase == PRO_VOICE_DONE ? PRO_TR("Finished. Tap Play to hear it again.") :
                         PRO_TR("Saved on this device. Tap Play.");
    ht_pro_text(f, 32, 475, 656, &ht_pro_24, progress.phase == PRO_VOICE_ERROR ? ERROR : DIM, status);
    uint32_t total = sample->samples * 2u;
    uint32_t position = progress.total == total ? progress.consumed : 0;
    if (position > total) position = total;
    ht_pro_rect(f, 32, 519, 656, 5, 2, SEL);
    if (position && total) ht_pro_rect(f, 32, 519, (int)((uint64_t)position * 656 / total), 5, 2, ACCENT);
    pro_control(f, 32, 543, 100, 64, "-", A_SAMPLE_VOLUME, -10, s.sample_volume > 0);
    snprintf(text, sizeof text, PRO_TR("Volume %u%%"), s.sample_volume);
    ht_pro_center(f, 557, &ht_pro_32, FG, text);
    pro_control(f, 588, 543, 100, 64, "+", A_SAMPLE_VOLUME, 10, s.sample_volume < 100);
    pro_control(f, 32, 627, 160, 68, PRO_TR("Previous"), A_SAMPLE_PREVIOUS, 0, s.voice_sample > 0);
    pro_control(f, 216, 627, 288, 68, playing ? PRO_TR("Stop") : PRO_TR("Play"), A_SAMPLE_PLAY, 0, true);
    pro_control(f, 528, 627, 160, 68, PRO_TR("Next"), A_SAMPLE_NEXT, 0, s.voice_sample + 1 < pro_voice_sample_count());
}

static void pro_voice_params(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Voice parameters"), A_VOICE_SAMPLES);
    const pro_voice_sample_t *sample = pro_voice_sample(s.voice_sample);
    if (!sample) return;
    char text[160];
    snprintf(text, sizeof text, "%s / %s", sample->voice, PRO_TR(sample->title));
    ht_pro_text(f, 32, 134, 656, &ht_pro_32, ACCENT, text);
    ht_pro_text(f, 32, 184, 656, &ht_pro_24, FG, sample->model);
    snprintf(text, sizeof text, PRO_TR("Voice ID: %s"), sample->voice_id);
    ht_pro_text(f, 32, 222, 656, &ht_pro_24, DIM, text);
    snprintf(text, sizeof text, PRO_TR("stability: %u.%02u   similarity: %u.%02u"), sample->stability / 100,
             sample->stability % 100, sample->similarity / 100, sample->similarity % 100);
    ht_pro_text(f, 32, 262, 656, &ht_pro_24, FG, text);
    snprintf(text, sizeof text, PRO_TR("Audio tag: [%s]"), sample->tag);
    ht_pro_text(f, 32, 302, 656, &ht_pro_24, FG, text);
    if (sample->seed < 0) snprintf(text, sizeof text, "%s", PRO_TR("Seed: provider default"));
    else snprintf(text, sizeof text, PRO_TR("Seed: %ld (best effort)"), (long)sample->seed);
    ht_pro_text(f, 32, 342, 656, &ht_pro_24, DIM, text);
    ht_pro_wrap(f, 32, 389, 656, 3, 0, &ht_pro_32, FG, PRO_TR(sample->note));
    ht_pro_text(f, 32, 514, 656, &ht_pro_24, DIM, PRO_TR("16 kHz mono / saved IMA ADPCM / soft gain 4x"));
    ht_pro_text(f, 32, 552, 656, &ht_pro_24, DIM, PRO_TR("v4: no speed, style, speaker boost or SSML."));
    ht_pro_text(f, 32, 590, 656, &ht_pro_24, DIM, PRO_TR("Tags guide delivery; results can vary."));
    pro_control(f, 216, 634, 288, 64, PRO_TR("Back to playback"), A_VOICE_SAMPLES, 0, true);
}

static void pro_appearance(ht_scene_t *f)
{
    bool daemon = s.view == DAEMONS;
    pro_visual_background(f, s.preview_scene, s.preview_character.id);
    pro_heading(f, daemon ? PRO_TR("Daemon") : PRO_TR("Scene"), A_LAUNCHER);
    pro_visual_character(f, &s.preview_character, HT_CHARACTER_IDLE, false,
                          185, 140, ms(), s.quiet, false);
    const char *name = daemon ? ht_character_name(s.preview_character.id) : PRO_TR(pro_scene_name(s.preview_scene));
    ht_pro_rect(f, 28, 490, 664, 112, 24, color(0xfbf9ef));
    ht_pro_center(f, 496, &ht_pro_42, FG, name);
    char detail[96];
    if (!daemon && s.preview_scene == PRO_SCENE_MATCH)
        snprintf(detail, sizeof detail, PRO_TR("%s for %s"), PRO_TR(pro_scene_name(pro_scene_resolve(s.preview_scene, s.preview_character.id))),
                 ht_character_name(s.preview_character.id));
    else snprintf(detail, sizeof detail, PRO_TR("%u of %u"), daemon ? pro_daemon_index(s.preview_character.id) + 1 : (unsigned)s.preview_scene + 1,
                  daemon ? pro_daemon_count() : (unsigned)PRO_SCENE_COUNT);
    ht_pro_center(f, 554, &ht_pro_24, DIM, detail);
    pro_control(f, 32, 626, 160, 68, PRO_TR("Previous"), A_APPEAR_PREVIOUS, 0, true);
    pro_control(f, 216, 626, 288, 68, PRO_TR("Use"), A_APPEAR_USE, 0, true);
    pro_control(f, 528, 626, 160, 68, PRO_TR("Next"), A_APPEAR_NEXT, 0, true);
}

static ht_rect_t pro_map_rect(const cable_tile_t *tile)
{
    int x = 32 + tile->x1 * 656 / 1000, y = 144 + tile->y1 * 432 / 1000;
    int w = (tile->x2 * 656 / 1000) - (tile->x1 * 656 / 1000);
    int h = (tile->y2 * 432 / 1000) - (tile->y1 * 432 / 1000);
    int ix = w >= 16 ? 4 : 0, iy = h >= 16 ? 4 : 0;
    return (ht_rect_t){x + ix, y + iy, w - 2 * ix, h - 2 * iy};
}

static bool pro_map_ready(void)
{
    // Shape and roster travel separately. Never use another tab's rectangles,
    // or make an unresolved first frame look like a set of named controls.
    if (s.loading || !s.selected_tab[0] || strcmp(s.tile_tab, s.selected_tab) ||
        s.tile_count <= 0 || s.tile_count > SWARM_TILES_MAX) return false;
    int named = 0, resolved = 0;
    for (int i = 0; i < s.tile_count; i++) {
        const cable_tile_t *t = &s.tiles[i];
        if (t->x1 < 0 || t->y1 < 0 || t->x2 > 1000 || t->y2 > 1000 ||
            t->x2 <= t->x1 || t->y2 <= t->y1) return false;
        for (int j = 0; j < i; j++) {
            const cable_tile_t *p = &s.tiles[j];
            if (t->x1 < p->x2 && p->x1 < t->x2 && t->y1 < p->y2 && p->y1 < t->y2)
                return false; // Ambiguous seats cannot become overlapping hit targets.
        }
        if (t->agent_id[0]) { named++; if (find(t->agent_id) >= 0) resolved++; }
    }
    return named == 0 || resolved > 0;
}

static bool pro_map_focusable(ht_rect_t r, int agent)
{
    // Preserve the real geometry. Never grow a tiny pane's hit box over its
    // neighbour; the list is the equally reachable precision alternative.
    return agent >= 0 && r.w >= 96 && r.h >= 96;
}

static bool pro_map_prefers_list(void)
{
    int known = 0, usable = 0;
    for (int i = 0; i < s.tile_count; i++) {
        int agent = find(s.tiles[i].agent_id);
        if (agent < 0) continue;
        known++;
        if (pro_map_focusable(pro_map_rect(&s.tiles[i]), agent)) usable++;
    }
    // Back, layout toggle, Tabs and Find retain four of the fixed hit slots.
    return known > 0 && (usable * 2 < known || usable > 20);
}

static int pro_map_unlisted(void)
{
    int unlisted = 0;
    for (int i = 0; i < s.count; i++) {
        bool represented = false;
        for (int j = 0; j < s.tile_count; j++)
            if (!strcmp(s.agents[i].id, s.tiles[j].agent_id)) { represented = true; break; }
        if (!represented) unlisted++;
    }
    return unlisted;
}

static void pro_agent_map(ht_scene_t *f)
{
    bool outlined = false;
    for (int i = 0; i < s.tile_count; i++) {
        const cable_tile_t *tile = &s.tiles[i];
        ht_rect_t r = pro_map_rect(tile);
        if (r.w <= 0 || r.h <= 0) continue;
        int ai = find(tile->agent_id);
        const agent_t *a = ai >= 0 ? &s.agents[ai] : NULL;
        bool enabled = s.connected && pro_map_focusable(r, ai) &&
                       s.hit_count < (int)(sizeof s.hits / sizeof s.hits[0]) - 2;
        int hit = enabled ? pro_hit(r.x, r.y, r.w, r.h, A_AGENT, ai, true) : -1;
        bool focused = a && ai == s.active;
        uint16_t fill = !a ? color(0xe9e9e2) : hit >= 0 && hit == s.pressed ? SEL : color(0xfcfbf4);
        bool ring = focused && !outlined && r.w > 8 && r.h > 8;
        ht_pro_rect(f, r.x, r.y, r.w, r.h, 20, ring ? ACCENT : fill);
        if (ring) {
            ht_pro_rect(f, r.x + 3, r.y + 3, r.w - 6, r.h - 6, 17, fill);
            outlined = true; // Duplicate host IDs cannot exhaust the 64-run compositor.
        }
        if (r.w < 80 || r.h < 60) continue;
        const ht_pro_font_t *font = r.w >= 184 && r.h >= 116 ? &ht_pro_32 : &ht_pro_24;
        const char *name = a ? a->name : tile->agent_id[0] ? PRO_TR("Unavailable") : PRO_TR("App pane");
        ht_pro_text(f, r.x + 14, r.y + 12, r.w - 28, font,
                    !enabled ? DIM : focused ? ACCENT : FG, name);
        // At most 16 two-line seats fit the compositor budget. Denser maps
        // stay spatial overviews; the list retains the complete identities.
        if (a && s.tile_count <= 16 && r.h >= font->height + ht_pro_24.height + 28 && r.w >= 128) {
            const char *status = is_question(a->id) ? "Question" : a->busy ? "Working" :
                a->recap_ready ? "Result" : "Ready";
            ht_pro_text(f, r.x + 14, r.y + r.h - ht_pro_24.height - 14, r.w - 28,
                        &ht_pro_24, is_question(a->id) ? ACCENT : DIM, PRO_TR(status));
        }
    }
    pro_control(f, 32, 606, 304, 68, PRO_TR("Tabs"), A_TABS, 0, s.connected);
    if (cable_client_supports(CABLE_FEATURE_FORM))
        pro_control(f, 384, 606, 304, 68, PRO_TR("Find"), A_FIND, 0, s.connected && !s.loading);
}

static void pro_agents(ht_scene_t *f)
{
    bool ready = pro_map_ready();
    // 0 is the automatic default; 1 explicitly chooses the list; 2 explicitly
    // chooses the map, including a crowded but still truthful overview.
    bool list = !ready || s.pro_agent_layout == 1 || (s.pro_agent_layout == 0 && pro_map_prefers_list());
    pro_control(f, 28, 28, 136, 64, PRO_TR("Back"), A_HOME, 0, true);
    const char *title = PRO_TR("Panes");
    for (int i = 0; i < s.tab_count; i++)
        if (!strcmp(s.tabs[i].id, s.selected_tab)) { title = s.tabs[i].name; break; }
    const ht_pro_font_t *font = ht_pro_width(&ht_pro_42, title) <= 332 ? &ht_pro_42 : &ht_pro_32;
    ht_pro_text(f, 188, 39, 332, font, FG, title);
    char label[40]; int extra = ready ? pro_map_unlisted() : 0;
    if (!list && extra) snprintf(label, sizeof label, PRO_TR("List +%d"), extra);
    else snprintf(label, sizeof label, "%s", PRO_TR(list ? "Map" : "List"));
    pro_control(f, 548, 28, 140, 64, label, A_AGENT_LAYOUT, list ? 2 : 1, ready);
    ht_pro_rect(f, 32, 113, 656, 2, 0, SEL);
    if (!list) { pro_agent_map(f); return; }
    pro_clamp_list(s.count, 4);
    if (!s.count) {
        ht_pro_center(f, 258, &ht_pro_42, FG, s.loading ? PRO_TR("Finding your panes...") : PRO_TR("A place for your next idea."));
        ht_pro_center(f, 322, &ht_pro_24, DIM, PRO_TR("Choose a tab to get started."));
        pro_control(f, 216, 424, 288, 76, PRO_TR("Choose a tab"), A_TABS, 0, s.connected);
        return;
    }
    for (int row = 0; row < 4 && s.offset + row < s.count; row++) {
        int i = s.offset + row;
        agent_t *a = &s.agents[i];
        char identity[160];
        const char *engine = !strcmp(a->engine, "claude") ? "Claude" : !strcmp(a->engine, "codex") ? "Codex" :
            !strcmp(a->engine, "opencode") ? "OpenCode" : a->engine;
        snprintf(identity, sizeof identity, "%s%s%s", engine, engine[0] && a->machine[0] ? "  ·  " : "", a->machine);
        const char *detail = identity[0] ? identity : is_question(a->id) ? PRO_TR("Needs your answer") :
            a->busy ? PRO_TR("Working") : a->recap_ready ? PRO_TR("A result is ready") : PRO_TR("Ready when you are");
        pro_row(f, 146 + row * 108, a->name, detail, A_AGENT, i, s.connected, i == s.active);
    }
    pro_pager(f, s.count, 4);
    if (!ready && s.count) pro_note(f, PRO_TR("The layout is updating."));
}

static void pro_tabs(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Tabs"), A_LAUNCHER);
    int current = ht_tab_carousel_index(&tab_carousel);
    if (current < 0 || current >= s.tab_count) {
        ht_pro_center(f, 287, &ht_pro_42, FG, PRO_TR("No tabs yet."));
        ht_pro_center(f, 348, &ht_pro_24, DIM, PRO_TR("Create one in the desktop app."));
        return;
    }
    char position[48];
    snprintf(position, sizeof position, PRO_TR("%d of %d workspaces"), current + 1, s.tab_count);
    ht_pro_center(f, 151, &ht_pro_24, DIM, position);
    bool selected = !strcmp(s.tabs[current].id, s.selected_tab);
    int hit = pro_hit(48, 214, 624, 340, A_TAB, current, s.connected && !s.loading);
    ht_pro_rect(f, 48, 214, 624, 340, 34, hit == s.pressed || selected ? SEL : color(0xfcfbf4));
    ht_pro_wrap(f, 80, 272, 560, 4, 0, &ht_pro_42, s.connected ? FG : DIM,
                s.tabs[current].name[0] ? s.tabs[current].name : PRO_TR("Untitled"));
    ht_pro_text(f, 80, 514, 560, &ht_pro_24, selected ? ACCENT : DIM,
                selected ? PRO_TR("Your current workspace") : PRO_TR("Tap to switch here"));
    if (current > 0) ht_pro_text(f, 48, 583, 280, &ht_pro_24, DIM, s.tabs[current - 1].name);
    if (current + 1 < s.tab_count) ht_pro_text(f, 392, 583, 280, &ht_pro_24, DIM, s.tabs[current + 1].name);
    pro_note(f, PRO_TR("Swipe to browse. Tap to choose."));
}

static void pro_inbox(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Updates"), A_HOME);
    if (!s.notice_count) {
        if (s.q.pending) {
            ht_pro_text(f,48,164,624,&ht_pro_32,FG,s.q.name);
            ht_pro_wrap(f,56,244,608,6,0,&ht_pro_32,DIM,
                        PRO_TR(s.q.uncertain ? "Delivery unconfirmed" : "Confirming your answer..."));
            pro_control(f,220,606,280,68,PRO_TR("Review answer"),A_QUESTION,-1,true);
            return;
        }
        if (s.notice_overflow) {
            ht_pro_center(f,272,&ht_pro_42,FG,"More in Harness");
            pro_control(f,220,462,280,76,PRO_TR("Home"),A_HOME,0,true);
            return;
        }
        ht_pro_center(f, 272, &ht_pro_42, FG, PRO_TR("All caught up."));
        ht_pro_center(f, 338, &ht_pro_24, DIM, PRO_TR("I'll let you know when something arrives."));
        pro_control(f, 220, 462, 280, 76, PRO_TR("Home"), A_HOME, 0, true);
        return;
    }
    if (s.offset >= s.notice_count) s.offset = s.notice_count - 1;
    if (s.offset < 0) s.offset = 0;
    const cable_notif_t *n = &s.notice[s.offset];
    if (s.q.pending)
        pro_control(f,484,28,204,64,PRO_TR("Review answer"),A_QUESTION,-1,true);
    char position[72];
    snprintf(position, sizeof position, "%s   %d / %d", n->question ? PRO_TR(n->question_unavailable ? "Needs attention" : "Needs your answer") :
        n->failed ? PRO_TR("Needs attention") : PRO_TR("Ready for you"), s.offset + 1, s.notice_count);
    ht_pro_text(f, 48, 138, 624, &ht_pro_24, n->failed ? color(0xa44343) : ACCENT, position);
    ht_pro_wrap(f, 48, 184, 624, 2, 0, &ht_pro_32, FG, n->name);
    ht_pro_wrap(f, 48, 282, 624, 7, 0, &ht_pro_32, s.connected ? FG : DIM,
                n->summary[0] ? n->summary : PRO_TR("No preview available."));
    // Answering is local to this ID. Opening is the separate focus-changing action.
    bool answer = n->question && !n->question_unavailable && cable_client_supports(CABLE_FEATURE_QUESTIONS);
    bool available = s.connected && !visit.pending;
    if (answer)
        pro_control(f, 32, 606, 280, 68, PRO_TR("Answer"), A_QUESTION, s.offset,
                    available && (!s.q.pending || !strcmp(s.q.agent,n->agent_id)));
    pro_control(f, answer ? 328 : 220, 606, answer ? 360 : 280, 68,
                PRO_TR("Open on desktop"), A_NOTICE, s.offset, available);
    s.notice_frame = n->read_on_dial ? 0 : n->display_revision;
    pro_note(f, s.notice_overflow ? "More in Harness" : PRO_TR("Swipe for other updates. Opening changes your pane."));
}

static void pro_machines(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Machines"), A_LAUNCHER);
    pro_clamp_list(s.machine_count, 3);
    if (!s.machine_count) ht_pro_center(f, 270, &ht_pro_32, DIM, PRO_TR("No computers available yet."));
    for (int row = 0; row < 3 && s.offset + row < s.machine_count; row++) {
        int i = s.offset + row;
        const cable_machine_t *m = &s.machines[i];
        bool enabled = s.connected && (!strcmp(m->state, "ready") || m->local);
        char detail[96];
        snprintf(detail, sizeof detail, "%s%s", m->local ? PRO_TR("This computer / ") : "", PRO_TR(m->state));
        pro_row(f, 164 + row * 135, m->name, detail, A_MACHINE, i, enabled,
                !strcmp(m->id, s.selected_machine));
    }
    pro_pager(f, s.machine_count, 3);
}

static void pro_models(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Model"), A_SETTINGS);
    if (s.model_count <= 0) {
        ht_pro_center(f, 284, &ht_pro_32, DIM, s.model_count < 0 ? PRO_TR("Finding available models...") : PRO_TR("No models available."));
        return;
    }
    pro_clamp_list(s.model_count, 3);
    for (int row = 0; row < 3 && s.offset + row < s.model_count; row++) {
        int i = s.offset + row, y = 154 + row * 140;
        const char *label = strrchr(s.models[i].id, ':');
        label = label ? label + 1 : s.models[i].id;
        int hit = pro_hit(32, y, 656, 122, A_MODEL, i, s.connected);
        bool selected = !strcmp(s.models[i].id, s.model_selected);
        ht_pro_rect(f, 32, y, 656, 122, 24, selected || hit == s.pressed ? SEL : color(0xfcfbf4));
        ht_pro_wrap(f, 54, y + 16, 612, 2, 0, &ht_pro_32, s.connected ? FG : DIM, label);
        if (selected) ht_pro_rect(f, 32, y + 20, 5, 82, 2, ACCENT);
    }
    pro_pager(f, s.model_count, 3);
}

static void pro_settings(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Controls"), A_LAUNCHER);
    int count = settings_count();
    pro_clamp_list(count, 4);
    for (int row = 0; row < 4; row++) {
        action_kind_t action;
        const char *label = settings_item(s.offset + row, &action);
        label = PRO_TR(label);
        if (!label) break;
        const char *detail = "";
        char dynamic[64];
        if (action == A_BRIGHT) {
            snprintf(dynamic, sizeof dynamic, PRO_TR("Brightness / %d%%"), s.brightness);
            label = dynamic; detail = PRO_TR("Tap to change the backlight");
        } else if (action == A_MUTE) {
            label = s.muted ? "Notifications / muted" : "Notifications / on";
            detail = PRO_TR("Notification sounds");
        } else if (action == A_COMPANION) { label = PRO_TR("Companion"); detail = PRO_TR("Motion, rest and brightness"); }
        else if (action == A_FIND) detail = PRO_TR("Find an existing Harness by voice");
        else if (action == A_FORM) detail = PRO_TR("Create through the desktop's form");
        else if (action == A_SELECT_BEGIN) detail = PRO_TR("Choose a passage to talk about or carry");
        else if (action == A_LATEST) detail = PRO_TR("Keep your place while visiting new output");
        else if (action == A_STOP) detail = PRO_TR("You'll review before stopping");
        bool enabled = action == A_INBOX || action == A_BRIGHT || action == A_MUTE || action == A_COMPANION ||
            (s.connected && ((action != A_STOP && action != A_MODELS && action != A_SELECT_BEGIN && action != A_LATEST) ||
             (active() && (action != A_STOP || active()->busy) && (action != A_LATEST || !visit.pending))));
        pro_row(f, 146 + row * 108, label, detail, action, 0, enabled, false);
    }
    pro_pager(f, count, 4);
    pro_note(f, PRO_TR("Swipe to browse controls."));
}

static void pro_companion(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Companion"), A_SETTINGS);
    pro_row(f, 146, s.quiet ? PRO_TR("Quiet motion / on") : PRO_TR("Quiet motion / off"),
            PRO_TR("Keep the face still when you need focus"), A_QUIET, 0, true, s.quiet);
    pro_row(f, 254, s.nap ? PRO_TR("Wake") : PRO_TR("Rest"),
            s.nap ? PRO_TR("Return to your companion") : PRO_TR("A fifteen minute nap"), A_NAP, 0, true, s.nap);
    char brightness[64];
    snprintf(brightness, sizeof brightness, PRO_TR("Brightness / %d%%"), s.brightness);
    pro_row(f, 362, brightness, PRO_TR("Tap to cycle the backlight"), A_BRIGHT, 0, true, false);
}

static void pro_read_text(ht_scene_t *f, const char *value, int y, int rows)
{
    int total = ht_pro_text_rows(value, &ht_pro_32, 608);
    int last = total > rows ? total - rows : 0;
    if (s.offset > last) s.offset = last;
    if (s.offset < 0) s.offset = 0;
    ht_pro_wrap(f, 56, y, 608, rows, s.offset, &ht_pro_32, FG, value);
}

static void pro_reader(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Latest result"), A_LAUNCHER);
    int recipient = find(s.reader_agent);
    agent_t *a = recipient >= 0 ? &s.agents[recipient] : !s.reader_agent[0] ? active() : NULL;
    bool same_pane = a && active() && !strcmp(a->id, active()->id);
    bool can_select = s.connected && !s.loading && same_pane && !visit.pending &&
                      !s.pending_focus[0] && !s.pending_machine[0] &&
                      cable_client_supports(CABLE_FEATURE_SELECTION);
    ht_pro_text(f, 48, 134, 384, &ht_pro_24, DIM, a ? a->name : PRO_TR("No pane selected"));
    pro_control(f, 456, 124, 232, 64, PRO_TR("Select output"), A_SELECT_BEGIN, 1, can_select);
    const char *value = a && a->full[0] ? a->full : PRO_TR("No result to read yet. I'll bring it here when it's ready.");
    pro_read_text(f, value, 190, 9);
    pro_control(f, 32, 606, 160, 68, PRO_TR("Earlier"), A_UP, 0, s.offset > 0);
    pro_control(f, 216, 606, 288, 68, PRO_TR("Open on desktop"), A_DESKTOP, 2, s.connected && a && !visit.pending);
    int total = ht_pro_text_rows(value, &ht_pro_32, 608);
    pro_control(f, 528, 606, 160, 68, PRO_TR("More"), A_DOWN, 0, s.offset + 9 < total);
    pro_note(f, a && !same_pane ? PRO_TR("Open this pane to select.") : PRO_TR("Swipe to read this result."));
}

static void pro_unknown_answer(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Delivery unconfirmed"), A_HOME);
    ht_pro_text(f, 48, 132, 624, &ht_pro_24, DIM, s.q.name);
    bool item = s.q.count > 0 && s.q.index >= 0 && s.q.index < s.q.count;
    if (item) {
        char position[48];
        snprintf(position,sizeof position,PRO_TR("Answer %d of %d"),s.q.index+1,s.q.count);
        ht_pro_text(f,48,170,624,&ht_pro_24,ACCENT,position);
    }
    const char *answer = item ? s.q.item[s.q.index].answer : "";
    if (answer[0]) pro_read_text(f,answer,220,6);
    else ht_pro_text(f,56,220,608,&ht_pro_32,DIM,PRO_TR("No saved answer."));
    if (s.q.count > 1 || ht_pro_text_rows(answer,&ht_pro_32,608) > 6)
        ht_pro_text(f,56,532,608,&ht_pro_24,DIM,PRO_TR("Swipe to read."));
    pro_control(f,32,592,248,80,PRO_TR("Close"),A_QUESTION_CLOSE,0,true);
    pro_control(f,296,592,392,80,PRO_TR("Check in Harness"),A_DESKTOP,1,
                s.connected && s.q.agent[0] && !visit.pending);
    pro_note(f,PRO_TR("Close removes this copy."));
}

static void pro_question(ht_scene_t *f)
{
    if (s.q.pending && s.q.uncertain) { pro_unknown_answer(f); return; }
    pro_heading(f, PRO_TR("A question for you"), A_HOME);
    ht_pro_text(f, 48, 132, 624, &ht_pro_24, DIM, s.q.name);
    if (s.q.loading) {
        ht_pro_center(f, 288, &ht_pro_32, DIM, PRO_TR("Reading the question..."));
        return;
    }
    if (s.q.pending && !s.q.error[0]) {
        pro_read_text(f, s.q.item[s.q.index].answer, 220, 6);
        ht_pro_center(f, 619, &ht_pro_32, DIM, PRO_TR("Confirming your answer..."));
        return;
    }
    if (s.q.error[0] || !s.q.valid || !s.q.supported) {
        ht_pro_wrap(f, 56, 220, 608, 7, 0, &ht_pro_32, FG, s.q.error[0] ? PRO_TR(s.q.error) :
                    !s.q.valid ? PRO_TR("Already answered elsewhere.") : PRO_TR("This question needs the desktop."));
        pro_control(f, 220, 606, 280, 68, PRO_TR("Open on desktop"), A_DESKTOP, 1, s.connected && !visit.pending);
        return;
    }
    question_item_t *q = &s.q.item[s.q.index];
    char position[48];
    snprintf(position, sizeof position, PRO_TR("Question %d of %d"), s.q.index + 1, s.q.count);
    ht_pro_text(f, 48, 170, 624, &ht_pro_24, ACCENT, position);
    pro_read_text(f, q->prompt, 220, 6);
    if (s.q.speech_error[0]) ht_pro_wrap(f, 56, 514, 608, 2, 0, &ht_pro_24, color(0xa44343), PRO_TR(s.q.speech_error));
    pro_control(f, 32, 606, 184, 68, PRO_TR("Later"), A_HOME, 0, true);
    if (q->can_text)
        pro_control(f, 232, 606, 240, 68, q->draft[0] ? PRO_TR("Review answer") : PRO_TR("Say an answer"),
                    q->draft[0] ? A_QUESTION_REVIEW : A_QUESTION_SAY, 0, !s.q.pending);
    pro_control(f, q->can_text ? 488 : 392, 606, q->can_text ? 200 : 296, 68,
                PRO_TR("Choices"), A_QUESTION_CHOICES, 0, !s.q.pending);
    pro_note(f, PRO_TR("Swipe to read. Nothing is sent until you confirm."));
}

static void pro_choices(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Choose an answer"), A_QUESTION_BACK);
    question_item_t *q = &s.q.item[s.q.index];
    char position[64];
    snprintf(position, sizeof position, PRO_TR("%s / %d of %d"), q->multi ? PRO_TR("Choose any") : PRO_TR("Choose one"), s.q.choice + 1, q->count);
    ht_pro_text(f, 48, 144, 624, &ht_pro_24, DIM, position);
    pro_read_text(f, q->options[s.q.choice], 204, 6);
    bool chosen = (q->selected & (1u << s.q.choice)) != 0;
    pro_control(f, 48, 512, 624, 68, chosen ? (q->multi ? PRO_TR("Selected / tap to remove") : PRO_TR("Selected")) : PRO_TR("Select this answer"),
                A_CHOICE, s.q.choice, !s.q.pending);
    pro_control(f, 32, 606, 216, 68, PRO_TR("Back"), A_QUESTION_BACK, 0, true);
    pro_control(f, 392, 606, 296, 68, PRO_TR("Review answer"), A_QUESTION_REVIEW, 0, q->selected && !s.q.pending);
    pro_note(f, PRO_TR("Swipe to read and move through choices."));
}

static void pro_answer(ht_scene_t *f)
{
    if (s.q.pending && s.q.uncertain) { pro_unknown_answer(f); return; }
    pro_heading(f, PRO_TR("Review your answer"), A_QUESTION_BACK);
    if (s.q.error[0]) {
        ht_pro_wrap(f, 56, 214, 608, 7, 0, &ht_pro_32, FG, PRO_TR(s.q.error));
        pro_control(f, 220, 606, 280, 68, PRO_TR("Open on desktop"), A_DESKTOP, 1, s.connected);
        return;
    }
    question_item_t *q = &s.q.item[s.q.index];
    char position[64];
    snprintf(position, sizeof position, PRO_TR("%.32s / answer %d of %d"), s.q.name, s.q.index + 1, s.q.count);
    ht_pro_text(f, 48, 145, 624, &ht_pro_24, DIM, position);
    pro_read_text(f, q->answer, 204, 6);
    if (s.q.speech_error[0]) ht_pro_wrap(f, 56, 514, 608, 2, 0, &ht_pro_24, color(0xa44343), PRO_TR(s.q.speech_error));
    if (s.q.pending) {
        ht_pro_center(f, 619, &ht_pro_32, DIM, PRO_TR("Confirming your answer..."));
        return;
    }
    pro_control(f, 32, 606, 184, 68, PRO_TR("Back"), A_QUESTION_BACK, 0, true);
    if (q->draft[0]) pro_control(f, 232, 606, 224, 68, PRO_TR("Say it again"), A_QUESTION_SAY, 0, true);
    pro_control(f, 472, 606, 216, 68, s.q.index + 1 < s.q.count ? PRO_TR("Next answer") : PRO_TR("Send answer"),
                A_ANSWER, 0, s.connected && (q->selected || q->draft[0]));
    pro_note(f, PRO_TR("Your answer goes only to this question."));
}

static void pro_selection(ht_scene_t *f)
{
    pro_heading(f, selection.query[0] ? PRO_TR("Find in output") : PRO_TR("Current output"), A_LAUNCHER);
    int source = find(selection.agent);
    agent_t *a = source >= 0 ? &s.agents[source] : NULL;
    ht_pro_text(f, 48, 134, 624, &ht_pro_24, DIM, selection.query[0] ? selection.query : a ? a->name : "Harness");
    if (carry.pending) {
        ht_pro_center(f, 273, &ht_pro_32, FG, PRO_TR("Picking up your text..."));
        ht_pro_center(f, 332, &ht_pro_24, DIM, PRO_TR("Then choose who gets it."));
        return;
    }
    if (selection.error[0]) {
        ht_pro_wrap(f, 56, 221, 608, 7, 0, &ht_pro_32, FG, PRO_TR(selection.error));
        bool retry = s.connected && !s.loading && a && active() && !strcmp(a->id, active()->id) &&
                     !visit.pending && !s.pending_focus[0] && !s.pending_machine[0] &&
                     cable_client_supports(CABLE_FEATURE_SELECTION);
        pro_control(f, 220, 606, 280, 68, PRO_TR("Try again"), A_SELECT_BEGIN, 0, retry);
        return;
    }
    char status[72];
    if (selection.query[0]) snprintf(status, sizeof status, PRO_TR("%d of %d matches"), selection.match, selection.matches);
    else snprintf(status, sizeof status, PRO_TR("%d line%s selected"), selection.rows, selection.rows == 1 ? "" : PRO_TR("s"));
    ht_pro_text(f, 48, 190, 624, &ht_pro_24, ACCENT, status);
    ht_pro_wrap(f, 56, 246, 608, 7, 0, &ht_pro_32, FG, selection.excerpt[0] ? selection.excerpt :
                selection.pending ? PRO_TR("Finding the text...") : selection.query[0] ? PRO_TR("No matches. Try another phrase.") : PRO_TR("Look at your desktop. Drag here to choose a line."));
    bool ready = ht_selection_ready(&selection);
    if (ready && selection.excerpt[0]) pro_hit(40, 226, 640, 322, A_PET, 0, true);
    pro_control(f, 32, 606, 192, 68, PRO_TR("Find"), A_SELECT_FIND, 0, ready);
    pro_control(f, 240, 606, 224, 68, selection.query[0] ? PRO_TR("By line") : selection.extending ? PRO_TR("Range") : PRO_TR("One line"),
                A_SELECT_EXTEND, 0, ready && selection.rows > 0);
    pro_control(f, 480, 606, 208, 68, PRO_TR("Carry text"), A_CARRY, 0,
                ready && selection.excerpt[0] && cable_client_supports(CABLE_FEATURE_DRAFT));
    pro_note(f, selection.pending ? PRO_TR("Choosing...") : PRO_TR("Tap the passage to talk about it."));
}

static void pro_form(ht_scene_t *f)
{
    const ht_form_page_t *p = &form.page;
    bool finding = !strncmp(form.id, "find-", 5);
    pro_heading(f, p->title[0] ? p->title : finding ? PRO_TR("Find Harness") : PRO_TR("New Harness"), A_FORM_BACK);
    char position[48];
    snprintf(position, sizeof position, PRO_TR("%d of %d"), p->position, p->total);
    ht_pro_text(f, 48, 137, 624, &ht_pro_24, DIM, p->query[0] ? p->query : p->total ? position : "");
    ht_pro_text(f, 56, 181, 608, &ht_pro_24, DIM, p->previous);
    ht_pro_rect(f, 32, 226, 656, 352, 28, color(0xfcfbf4));
    ht_pro_wrap(f, 56, 250, 608, 2, 0, &ht_pro_42, ACCENT,
                p->label[0] ? p->label : form.failed ? PRO_TR("Could not open") : PRO_TR("Opening..."));
    ht_pro_wrap(f, 56, 382, 608, 4, 0, &ht_pro_32, p->error[0] ? color(0xa44343) : FG,
                p->error[0] ? PRO_TR(p->error) : p->busy ? p->status : p->detail);
    bool can_act = !form.pending && !form.failed && p->active && p->enabled && !p->busy;
    if (can_act) pro_hit(32, 226, 656, 352, A_FORM_MAIN, 0, true);
    pro_control(f, 32, 606, 176, 68, PRO_TR("Back"), A_FORM_BACK, 0, !form.pending || finding);
    pro_control(f, 224, 606, 216, 68, PRO_TR("Say a name"), A_FORM_SAY, 0,
                !form.pending && !form.failed && p->active && p->can_query && !p->busy);
    const char *action = form.failed ? PRO_TR("Retry") : p->busy ? PRO_TR("Please wait") :
        form.pending && form.pending_op != HT_FORM_STATE ? PRO_TR("Working...") : p->action[0] ? p->action : PRO_TR("Choose");
    pro_control(f, 456, 606, 232, 68, action, A_FORM_MAIN, 0, form.failed || can_act);
    pro_note(f, PRO_TR("Swipe for choices. Tap to confirm one."));
}

static void pro_draft(ht_scene_t *f)
{
    const ht_draft_page_t *p = &draft.page;
    bool carried = pro_carry_review_owns(&s.carry_review, p);
    if (draft.read_only) {
        uint8_t mode = s.draft_recovery.mode;
        pro_heading(f, PRO_TR(mode == PRO_WORK_TASK ? "Your message" : pro_work_label(mode)), A_DRAFT_OPTIONS);
        char position[80];
        if (s.draft_recovery.has_words)
            snprintf(position, sizeof position, PRO_TR("Part %d of %d / %s"), p->position, p->total,
                s.draft_recovery.ready ? PRO_TR("read only") : PRO_TR("offline copy"));
        else snprintf(position, sizeof position, "%s", PRO_TR("No local words saved"));
        ht_pro_text(f, 48, 132, carried ? 356 : 624, &ht_pro_24, DIM, carried ? s.carry_review.name : p->name);
        ht_pro_text(f, 48, 170, carried ? 356 : 624, &ht_pro_24, ACCENT, position);
        if (carried) pro_control(f, 432, 122, 256, 80, PRO_TR("Passage preview"), A_CARRY_PREVIEW, 0, !draft.pending);
        if (s.draft_recovery.has_words) pro_read_text(f, p->text, 220, 6);
        else if (!s.connected || !pro_draft_recovery_same_host(&s.draft_recovery))
            ht_pro_wrap(f, 56, 238, 608, 5, 0, &ht_pro_32, FG,
                        PRO_TR("Connect to the original computer to recover this message."));
        const char *status = s.draft_recovery.store == PRO_RECOVERY_CLEARING ? "Closing recovery..." :
            s.draft_recovery.store == PRO_RECOVERY_CLEAR_FAILED ? "Couldn't clear recovery. Try Close again." :
            s.draft_recovery.store == PRO_RECOVERY_SAVE_FAILED ? "Recovery unavailable after power loss." : draft.pending ? "Recovering message..." : p->error[0] ? p->error :
            s.draft_recovery.ready ? "Check delivery on the computer." :
            s.draft_recovery.has_words ? "Only this part is here." : "";
        if (!strncmp(status, "Read only. ", 11)) status += 11;
        ht_pro_wrap(f, 56, 514, 608, 2, 0, &ht_pro_24, DIM, PRO_TR(status));
        pro_control(f, 32, 592, 240, 80, PRO_TR("Close"), A_DRAFT_DISCARD, 0,
                    s.draft_recovery.store != PRO_RECOVERY_CLEARING);
        bool available = s.connected && cable_client_supports(CABLE_FEATURE_DRAFT) &&
            pro_draft_recovery_same_host(&s.draft_recovery) && !draft.pending &&
            s.draft_recovery.store != PRO_RECOVERY_CLEARING;
        pro_control(f, 304, 592, 384, 80, PRO_TR("Recover message"), A_DRAFT_STATE, 0, available);
        pro_note(f, s.draft_recovery.has_words ? PRO_TR("Close removes this copy.") :
                    PRO_TR("Close removes this recovery bookmark."));
        return;
    }
    pro_heading(f, PRO_TR(s.work_voice_mode == PRO_WORK_TASK ? "Your message" : pro_work_label(s.work_voice_mode)), A_DRAFT_OPTIONS);
    char position[64];
    snprintf(position, sizeof position, PRO_TR("Part %d of %d / %s"), p->position, p->total,
        p->locked || draft.failed ? PRO_TR("check delivery") : draft.pending && draft.op == HT_DRAFT_SEND ?
        PRO_TR("sending") : PRO_TR("not sent yet"));
    ht_pro_text(f, 48, 132, carried ? 356 : 624, &ht_pro_24, DIM, carried ? s.carry_review.name : p->name);
    ht_pro_text(f, 48, 170, carried ? 356 : 624, &ht_pro_24, ACCENT, position);
    if (carried) pro_control(f, 432, 122, 256, 80, PRO_TR("Passage preview"), A_CARRY_PREVIEW, 0, !draft.pending);
    pro_read_text(f, p->text, 220, 6);
    bool editable = !draft.pending && !draft.failed && !p->locked;
    pro_hit(40, 210, 640, 300, A_DRAFT_EDIT, 0, editable);
    if (s.draft_recovery.store == PRO_RECOVERY_SAVING || s.draft_recovery.store == PRO_RECOVERY_SAVE_FAILED)
        ht_pro_wrap(f, 56, 514, 608, 2, 0, &ht_pro_24, DIM,
            PRO_TR(s.draft_recovery.store == PRO_RECOVERY_SAVING ? "Preparing recovery..." : "Recovery unavailable after power loss."));
    else if (p->error[0]) ht_pro_wrap(f, 56, 514, 608, 2, 0, &ht_pro_24, color(0xa44343), PRO_TR(p->error));
    else if (!pro_work_draft_available()) ht_pro_text(f, 56, 522, 608, &ht_pro_24, DIM,
                                                    "Instruction unavailable. Your words are still here.");
    else if (!p->can_send) ht_pro_wrap(f, 56, 514, 608, 2, 0, &ht_pro_24, DIM,
                                    PRO_TR("Some characters can't be shown. Say this part again."));
    else ht_pro_text(f, 56, 522, 608, &ht_pro_24, DIM, draft.pending ?
                    draft.op == HT_DRAFT_SEND ? PRO_TR("Sending...") : PRO_TR("One moment...") : PRO_TR("Tap the text to say this part again."));
    pro_control(f, 32, 606, 264, 68, p->locked ? PRO_TR("Close") : PRO_TR("Discard"), A_DRAFT_DISCARD, 0, !draft.pending);
    bool checking = draft.failed || p->locked;
    pro_control(f, 416, 606, 272, 68, checking ? PRO_TR("Check delivery") : PRO_TR("Send message"),
                checking ? A_DRAFT_STATE : A_DRAFT_SEND, 0,
                !draft.pending && (checking || (p->can_send && pro_work_draft_available())) && !(carried && s.carry_review.detached));
    pro_note(f, PRO_TR("Swipe to read. Hold the text for more options."));
}

static void pro_carry_preview(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Passage preview"), A_DRAFT_BACK);
    ht_pro_wrap(f, 56, 132, 608, 4, 0, &ht_pro_24, DIM, s.carry_review.source);
    char rows[64]; snprintf(rows, sizeof rows, PRO_TR("%d line%s selected"),
        s.carry_review.rows, s.carry_review.rows == 1 ? "" : PRO_TR("s"));
    ht_pro_text(f, 56, 270, 608, &ht_pro_24, ACCENT, rows);
    pro_read_text(f, s.carry_review.excerpt, 316, 6);
    int total = ht_pro_text_rows(s.carry_review.excerpt, &ht_pro_32, 608);
    pro_control(f, 32, 606, 160, 68, PRO_TR("Earlier"), A_UP, 0, s.offset > 0);
    pro_control(f, 216, 606, 288, 68, PRO_TR("Your message"), A_DRAFT_BACK, 0, true);
    pro_control(f, 528, 606, 160, 68, PRO_TR("More"), A_DOWN, 0, s.offset + 6 < total);
    pro_note(f, s.carry_review.detached ? PRO_TR("Preview kept here.") : PRO_TR("Full passage stays attached."));
}

static void pro_draft_options(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Message options"), A_DRAFT_BACK);
    if (draft.read_only) {
        ht_pro_wrap(f, 56, 196, 608, 4, 0, &ht_pro_32, DIM,
                    PRO_TR("This copy is read only. Recover the full message from the original computer."));
        pro_row(f, 440, PRO_TR("Back to your message"), PRO_TR("Your original words"), A_DRAFT_BACK, 0, true, false);
        pro_note(f, PRO_TR("Delivery is checked on the computer."));
        return;
    }
    ht_pro_text(f, 48, 135, 624, &ht_pro_24, DIM, draft.page.context);
    bool editable = !draft.pending && !draft.failed && !draft.page.locked;
    pro_row(f, 196, PRO_TR("Add to your message"), PRO_TR("Speak another part"), A_DRAFT_APPEND, 0, editable, false);
    pro_row(f, 318, PRO_TR("Undo your last edit"), PRO_TR("Restore the previous wording"), A_DRAFT_UNDO, 0,
            editable && draft.page.can_undo, false);
    pro_row(f, 440, PRO_TR("Back to your message"), PRO_TR("Review before you send"), A_DRAFT_BACK, 0, true, false);
    pro_note(f, draft.page.locked ? PRO_TR("Check the desktop for delivery.") : PRO_TR("Nothing is sent until you choose Send."));
}

static void pro_stop(ht_scene_t *f)
{
    pro_heading(f, PRO_TR("Stop this turn?"), A_SETTINGS);
    int i = find(s.stop_agent);
    ht_pro_wrap(f, 56, 201, 608, 3, 0, &ht_pro_42, FG, i >= 0 ? s.agents[i].name : PRO_TR("This Harness"));
    ht_pro_wrap(f, 56, 392, 608, 3, 0, &ht_pro_32, DIM,
                PRO_TR("Your work stays. Only the current turn will stop."));
    pro_control(f, 32, 606, 272, 68, PRO_TR("Keep working"), A_HOME, 0, true);
    pro_control(f, 416, 606, 272, 68, PRO_TR("Stop this turn"), A_STOP_YES, 0,
                s.connected && i >= 0 && s.agents[i].busy);
}

static void pro_message(ht_scene_t *f)
{
    pro_heading(f, s.title[0] ? PRO_TR(s.title) : PRO_TR("A quick note"), A_HOME);
    ht_pro_wrap(f, 56, 214, 608, 8, 0, &ht_pro_32, FG, PRO_TR(s.message));
    pro_control(f, 220, 606, 280, 68, PRO_TR("Home"), A_HOME, 0, true);
}

static bool pro_render_controls(ht_scene_t *f)
{
    switch (s.view) {
    case LAUNCHER: pro_launcher(f); return true;
    case WORK_INTENT: pro_work_intent(f); return true;
    case TODAY: pro_today(f); return true;
    case LANGUAGE: pro_language(f); return true;
    case VOICE_SAMPLES: pro_voice_samples(f); return true;
    case VOICE_PARAMS: pro_voice_params(f); return true;
    case DAEMONS: case SCENES: pro_appearance(f); return true;
    case AGENTS: pro_agents(f); return true;
    case TABS: pro_tabs(f); return true;
    case INBOX: pro_inbox(f); return true;
    case MACHINES: pro_machines(f); return true;
    case MODELS: pro_models(f); return true;
    case SETTINGS: pro_settings(f); return true;
    case COMPANION: pro_companion(f); return true;
    case READER: pro_reader(f); return true;
    case QUESTION: pro_question(f); return true;
    case CHOICE: pro_choices(f); return true;
    case ANSWER_REVIEW: pro_answer(f); return true;
    case SELECTION: pro_selection(f); return true;
    case FORM: pro_form(f); return true;
    case DRAFT: pro_draft(f); return true;
    case DRAFT_OPTIONS: pro_draft_options(f); return true;
    case CARRY_PREVIEW: pro_carry_preview(f); return true;
    case STOP: pro_stop(f); return true;
    case MESSAGE: pro_message(f); return true;
    default: return false;
    }
}
#endif
