// Exercise the actual animation clock and incremental renderer, including the
// mic path and transitions to/from secondary screens. No hardware/network use.
#include "../main/ui/habitat/octopus.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint16_t full[HT_WIDTH * HT_HEIGHT], incremental[HT_WIDTH * HT_HEIGHT];
static uint16_t scratch[HT_WIDTH * HT_HEIGHT];
static unsigned redraws;
static const char *recap;
static void transition(const ht_scene_t *before, const ht_scene_t *after)
{
    redraws++;
    ht_damage_t d; ht_damage(before, after, &d);
    for (int i = 0; i < d.count; i++) {
        ht_rect_t r = d.rect[i];
        assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= HT_WIDTH && r.y + r.h <= HT_HEIGHT);
        assert(!((r.x | r.y | r.w | r.h) & 1));
        ht_raster(after, r, scratch);
        for (int y = 0; y < r.h; y++)
            memcpy(incremental + (r.y+y)*HT_WIDTH+r.x, scratch+y*r.w, (size_t)r.w*2);
    }
    ht_raster(after, (ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT}, full);
    assert(!memcmp(incremental, full, sizeof full));
}

static bool tick(ht_octopus_motion_t *m, uint32_t now, ht_tim_mood_t mood,
                 bool quiet, bool visible, bool down, unsigned level)
{
    // 97 px right of the middle of the face, which is where the gaze test wants the finger. Written
    // against HT_WIDTH rather than as 330 so it means the same thing on a 466 dial and a 720 Pro —
    // tim.c reads the gaze relative to the centre, and 330 is left of centre on the larger face.
    bool changed = ht_octopus_motion_tick(m, now, mood, quiet, visible, down, HT_WIDTH / 2 + 97, level, now / 100);
    assert(m->next_ms >= 1 && m->next_ms <= 1000);
    assert(m->frame < HT_OCTOPUS_FRAMES);
    return changed;
}

static void clock_checks(void)
{
    ht_octopus_motion_t m = {0}; bool seen[HT_OCTOPUS_FRAMES] = {0};
    for (uint32_t t = 0; t <= HT_OCTOPUS_DURATION; t++) {
        tick(&m, t, HT_TIM_WORKING, false, true, false, 0); seen[m.frame] = true;
    }
    for (int i = 0; i < HT_OCTOPUS_FRAMES; i++) assert(seen[i]);
    assert(m.frame == 0 && m.phase == 0);
    memset(&m, 0, sizeof m);
    for (uint32_t t = 0; t <= HT_OCTOPUS_DURATION * 2; t++) tick(&m, t, HT_TIM_CONTENT, false, true, false, 0);
    assert(m.frame == 0 && m.phase == 0);
    memset(&m, 0, sizeof m);
    tick(&m, UINT32_MAX - 49, HT_TIM_WORKING, false, true, false, 0);
    tick(&m, 50, HT_TIM_WORKING, false, true, false, 0);
    assert(m.phase == 100 && m.frame == 1);
    tick(&m, 80, HT_TIM_WORKING, false, true, true, 0);
    uint16_t held = m.phase;
    tick(&m, 3000, HT_TIM_WORKING, false, true, true, 0);
    assert(m.phase == held && m.reaction.pose.pressed && m.reaction.pose.look == 2);
    tick(&m, 4000, HT_TIM_WORKING, false, true, false, 0);
    assert(m.phase == held); // no catch-up jump when the finger lifts
    tick(&m, 4100, HT_TIM_LISTENING, false, true, false, 4);
    assert(m.reaction.pose.level == 4);
    held = m.phase;
    for (uint32_t t = 4101; t < 4225; t++) {
        tick(&m, t, HT_TIM_LISTENING, false, true, false, 0);
        assert(m.reaction.pose.level == 4 && m.running && m.rate == 2);
    }
    tick(&m, 4225, HT_TIM_LISTENING, false, true, false, 0);
    assert(!m.reaction.pose.level && m.phase == (held + 62) % HT_OCTOPUS_DURATION);
    for (int state = 0; state < 4; state++) {
        ht_tim_mood_t mood = state == 2 ? HT_TIM_ASLEEP : state == 3 ? HT_TIM_OFFLINE : HT_TIM_WORKING;
        tick(&m, 5000, mood, state == 0, state != 1, false, 0);
        uint16_t phase = m.phase;
        for (uint32_t t = 5001; t < 7000; t++) {
            assert(!tick(&m, t, mood, state == 0, state != 1, false, 0));
            assert(m.phase == phase && m.next_ms == 1000);
        }
    }
}

static ht_tim_face_t face = {.recipient = "Parser helper", .status = "3 working", .hint = "tap to talk",
    .detail = "Running firmware checks", .foreground = 0xffff, .dim = 0x7777, .ink = 0xafe0,
    .roomy_reading = true};
static void scene(ht_scene_t *s, const ht_octopus_motion_t *m)
{
    ht_scene_clear(s, ht_rgb(0x080c08));
    face.mood = m->reaction.mood; face.pose = m->reaction.pose;
    ht_octopus_face(s, &face, m->frame, ht_rgb(0xc8a9f0), recap);
    assert(s->count <= HT_RUNS - 2); // room for footer and explicit Discard
    for (int i = 0; i < s->count; i++) {
        const ht_run_t *r = &s->runs[i];
        assert(r->x >= 0 && r->y >= 0 && r->x + r->w <= HT_WIDTH && r->y + r->font->height <= HT_HEIGHT);
        assert(ht_can_display(r->text, r->font, r->w ? r->w : r->font->width, 1));
        if (recap && r->font == &ht_octopus_font_4)
            assert(r->y >= HT_CHARACTER_READING_Y && r->y + r->font->height <= HT_CHARACTER_READING_TEXT_Y);
        if (recap && r->font == &ht_octopus_font_6)
            assert(r->y >= HT_CHARACTER_BRIEF_Y && r->y + r->font->height <= HT_CHARACTER_BRIEF_TEXT_Y);
        if (recap && r->font == &ht_mono_28 && r->text[0] && !r->arc && r->y >= HT_CHARACTER_READING_TEXT_Y && r->y < 400)
            assert(r->y + r->font->height <= 384); // At least 16 px before inbox controls at y=400.
    }
}

static void redraw_checks(void)
{
    ht_scene_t a = {0}, b = {0}; ht_octopus_motion_t m = {0};
    scene(&a, &m); transition(NULL, &a);
    for (int layout = 0; layout < 5; layout++) {
        face.focus = layout == 1; face.straight_title = layout == 3; face.unread = layout == 4;
        recap = layout == 2 ? "Fixed the parser. All checks pass, with a much longer explanation available in the terminal." : NULL;
        for (int mood = HT_TIM_CONTENT; mood <= HT_TIM_LISTENING; mood++) {
            m.reaction.mood = mood;
            for (int frame = 0; frame < HT_OCTOPUS_FRAMES; frame++) {
                m.frame = frame; m.reaction.pose = (ht_tim_pose_t){.blink = frame % 13 == 0, .level = frame % 5};
                scene(&b, &m); transition(&a, &b); a = b;
            }
        }
    }
    recap = NULL;
    face.unread = false;
    face.focus = false; face.recipient = "A very long recipient name that must end in a plus";
    scene(&b, &m); transition(&a, &b); a = b;
    face.recipient = "hn"; face.status = "[ 1 needs you ]";
    scene(&b, &m); transition(&a, &b); a = b;
    ht_scene_clear(&b, a.background); ht_center(&b, 145, &ht_mono_20, 0xffff, "find");
    transition(&a, &b); a = b; scene(&b, &m); transition(&a, &b);
}

static void text_checks(void)
{
    const char *examples[]={
        "It isn't external.",
        "Yes. The fix is installed.",
        "We use ... for omitted text.",
        "The device kept this complete sentence within sixty letters.",
        "Fixed the parser. All tests pass. Voice input now sends to the selected agent.",
        "A much longer completion from an older host must still fit three rows without overlapping the footer.",
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
        "The desktop sorts by last activity only (newest first +",
        "caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9 caf\xc3\xa9"
    };
    for (unsigned n=0;n<sizeof examples/sizeof examples[0];n++) {
        ht_scene_t s; ht_scene_clear(&s,0);
        ht_octopus_face(&s,&face,0,0xffff,examples[n]);
        char shown[512]=""; const ht_run_t *last=NULL;
        for (int i=0;i<s.count;i++) {
            const ht_run_t *r=&s.runs[i];
            assert(r->font!=&ht_open_20 && r->font!=&ht_nav_32);
            if (r->arc || r->font!=&ht_mono_28 || r->y<190 || r->y>380 || !r->text[0]) continue;
            if (shown[0]) strcat(shown," ");
            strcat(shown,r->text); last=r;
            assert(r->w<=408 && ht_can_display(r->text,r->font,r->w,1));
        }
        assert(last && !strchr(shown,'+'));
        if (n<5) assert(!strcmp(shown,examples[n])); // Complete prose is retained.
        if (n==5) assert(strstr(shown,"...")); // The fixed larger font may clip long prose.
        if (n==7) assert(strstr(shown,"first...")); // Only clipped prose gets a marker.
    }
}

static void orphan_marker_checks(void)
{
    ht_scene_t s; ht_scene_clear(&s, 0);
    ht_recap_lines(&s, 253, 0xffff, "The desktop sorts by last activity only (newest first +");
    assert(s.count==3 && !strcmp(s.runs[1].text,"activity only (newest"));
    assert(!strcmp(s.runs[2].text,"first..."));
    // A literal C++ is not a continuation marker.
    ht_scene_clear(&s, 0);
    ht_recap_lines(&s, 253, 0xffff, "Built with C++");
    assert(s.count==3 && !strcmp(s.runs[0].text,"Built with C++"));
    // An authored arrow inside prose is preserved; no action glyph is appended.
    ht_scene_clear(&s, 0);
    ht_recap_lines(&s, 253, 0xffff,
        "It was a wrapping bug: a + alone on a new line escaped conversion to \xe2\x86\x97.");
    assert(s.count==3);
    bool arrow=false;
    for(int i=0;i<s.count;i++) {
        assert(ht_can_display(s.runs[i].text,s.runs[i].font,336,1));
        arrow |= strstr(s.runs[i].text,"\xe2\x86\x97.")!=NULL;
    }
    assert(arrow);
    ht_scene_clear(&s, 0);
    ht_recap_lines(&s, 253, 0xffff, "");
    assert(s.count==3);
    for(int i=0;i<s.count;i++) assert(!s.runs[i].text[0]);
    // A long cached UTF-8 message stays bounded without splitting a codepoint.
    char long_text[1024];
    for(int i=0;i<300;i++) memcpy(long_text+i*2,"\xc3\xa9",2);
    long_text[600]=0;
    ht_scene_clear(&s,0);
    ht_recap_lines(&s,253,0xffff,long_text);
    assert(s.count==3 && strstr(s.runs[2].text,"..."));
    for(int i=0;i<s.count;i++)
        assert(ht_can_display(s.runs[i].text,s.runs[i].font,336,1));
}

static void activity_checks(void)
{
    const char *names[] = {"hn", "Deploy latest firmware", "Mobile app build and deploy",
        "A very long session name that must leave room for current activity"};
    const char *activities[] = {"Working", "Coalescing...", "[1] Working", "[2] Coalescing..."};
    ht_scene_t before, after; ht_octopus_motion_t motion = {0};
    face.mood = HT_TIM_WORKING;
    recap = "The last build is installed. All checks passed.";
    ht_scene_clear(&before, ht_rgb(0x080c08)); transition(NULL, &before);
    for (unsigned n = 0; n < sizeof names / sizeof names[0]; n++) {
        for (unsigned a = 0; a < sizeof activities / sizeof activities[0]; a++) {
            face.recipient = names[n]; face.status = activities[a];
            ht_scene_clear(&after, before.background);
            ht_octopus_face(&after, &face, motion.frame, ht_rgb(0xc8a9f0), recap);
            assert(after.count <= HT_RUNS - 2);
            bool activity = false;
            for (int i = 0; i < after.count; i++) {
                const ht_run_t *r = &after.runs[i];
                assert(strcmp(r->text, "Last result"));
                if (!strcmp(r->text, activities[a])) {
                    activity = true;
                    assert(r->arc == 2);
                }
                if (!r->text[0] || !r->arc) continue;
                assert((r->arc == 1 || r->arc == 2) && r->font == &ht_mono_24);
                assert(!strchr(r->text, '+'));
                for (int j = 0; j < i; j++) {
                    const ht_run_t *p = &after.runs[j];
                    if (!p->text[0] || !p->arc) continue;
                    assert(r->y + r->font->height <= p->y || p->y + p->font->height <= r->y);
                }
            }
            assert(activity);
            transition(&before, &after); before = after;
        }
    }
    face.status = ""; face.recipient = "Parser helper"; recap = NULL;
}

static void traffic_checks(void)
{
    uint32_t idle_bytes = 0;
    for (int mode = 0; mode < 4; mode++) {
        ht_tim_mood_t mood = mode == 0 ? HT_TIM_CONTENT : mode == 1 ? HT_TIM_WORKING : HT_TIM_LISTENING;
        if (mode == 3) mood = HT_TIM_CONTENT;
        recap = mode == 3 ? "Fixed the parser. Tests pass." : NULL;
        ht_octopus_motion_t m = {0}; ht_scene_t a, b; unsigned frames = 0; uint32_t pixels = 0;
        tick(&m, 0, mood, false, true, false, 0); scene(&a, &m);
        for (uint32_t t = 1; t <= 60000; t++) {
            if (!tick(&m, t, mood, false, true, false, (t / 125) % 5)) continue;
            scene(&b, &m); ht_damage_t d; ht_damage(&a, &b, &d);
            if (d.count) { frames++; pixels += d.pixels; }
            a = b;
        }
        printf("octopus simulated %s: %u redraws/min, %u DMA pixel-bytes/min (no timing claim)\n",
               mode == 0 ? "idle" : mode == 1 ? "working" : mode == 2 ? "microphone" : "recap", frames, pixels * 2);
        if (mode == 0) idle_bytes = pixels * 2;
        if (mode == 3) assert(pixels * 2 < idle_bytes);
        // Listening now includes the requested idle body motion. Keep the old
        // 2.5 MB/min allowance for microphone reactions on top of that motion.
        if (mode == 2) assert(pixels * 2 < idle_bytes + 2500000);
    }
}

int main(void)
{
    clock_checks(); text_checks(); orphan_marker_checks(); redraw_checks(); activity_checks(); traffic_checks();
    printf("octopus: PASS (63 poses; clocks/wrap; five layouts; touch/voice/hidden scheduling; %u incremental redraw checks; %zu-byte motion state)\n", redraws, sizeof(ht_octopus_motion_t));
}
