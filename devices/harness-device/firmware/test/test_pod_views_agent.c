#include <stdlib.h>
// Task 8: the Agent, Recap and Talking screens.
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "pod/pod_view.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { assert(c); checks++; } while (0)

enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3 };

static pod_model_t M;
static pod_nav_t N;
static pod_out_frame_t F;
static ht_scene_t S;

static void render(uint32_t now) {
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(0xffffff));
    F.scene = &S;
    pod_render(&F, &N, &M, now);
}
static const ht_run_t *find_text(const char *prefix) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, prefix, strlen(prefix))) return &S.runs[i];
    return NULL;
}
const char *pod_working_verb(uint32_t secs);   // pod_view_shared.h
// The working LCD pill (S5): a dark rounded rect, three green bars, the verb "<verb>..." in light ink and the time
// "m:ss" in green on the right. find_working_chip is the verb run; find_pill_time the time run; find_pill the rect.
static const ht_run_t *find_working_chip(void) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x26292b) && strstr(S.runs[i].text, "...")) return &S.runs[i];
    return NULL;
}
static const ht_run_t *find_pill_time(void) {
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x1f9d4c)) return &S.runs[i];
    return NULL;
}
// The pill has no shape (no rim, no fill): only the bars, the verb and the time. Its box is derived from them: the bars'
// bottom is 30 px into the 40 px box, the bars start 16 px in, the time ends 16 px short of the right edge.
static bool pill_box(int *x0, int *y0, int *x1, int *y1) {
    int bx = -1, bb = -1, tr = -1;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT && r->fg == ht_rgb(0x2a9a57) && r->w == 5) {
            if (bx < 0 || r->x < bx) bx = r->x;
            if (r->y + r->pro_height > bb) bb = r->y + r->pro_height;
        }
        if (r->pro_kind == K_TEXT && r->fg == ht_rgb(0x1f9d4c)) tr = r->x + r->w;
    }
    if (bx < 0 || tr < 0) return false;
    *x0 = bx - 16; *y0 = bb - 30; *x1 = tr + 16; *y1 = *y0 + 40;
    return true;
}
static const ht_run_t *find_pill(void) {
    static ht_run_t box;
    int x0, y0, x1, y1;
    if (!pill_box(&x0, &y0, &x1, &y1)) return NULL;
    box.x = x0; box.y = y0; box.w = x1 - x0; box.pro_height = 40;
    return &box;
}
static int count_green_bars(void) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2a9a57) && S.runs[i].w == 5) n++;
    return n;
}
static const pod_hit_t *find_hit(pod_action_t a) {
    for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == a) return &F.hits[i];
    return NULL;
}
static int count_cells(void) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_CELL) n++;
    return n;
}
static int count_rects(uint16_t ink, int w) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ink && S.runs[i].w == w) n++;
    return n;
}
// Whether the screen holds exactly the runs pod_pet_draw adds for this pet, in a row.
static bool has_pet(int x, int y, int side, const char *engine, pod_scene_t scene, uint32_t now, uint32_t started) {
    static ht_scene_t scratch;
    ht_scene_clear(&scratch, 0);
    pod_pet_draw(&scratch, x, y, side, engine, scene, now, started);
    for (int at = 0; at + scratch.count <= S.count; at++) {
        bool same = true;
        for (int i = 0; i < scratch.count && same; i++) same = !memcmp(&S.runs[at + i], &scratch.runs[i], sizeof S.runs[0]);
        if (same) return true;
    }
    return false;
}

// Option A: the pet is album art on the left, side 180 inside a 196 square at (26, 84); a pet-less engine's cover fills the 196 square.
static bool art_has_pet(const char *engine, pod_scene_t scene, uint32_t now, uint32_t started) {
    return pod_pet_for(engine) ? has_pet(34, 92, 180, engine, scene, now, started) : has_pet(26, 84, 196, engine, scene, now, started);
}

// One tab with: c claude (working), x codex (asking), m muse (idle, no recap), u cursor (idle), d claude (done, recap).
static const char *const ID[] = {"c", "x", "m", "u", "d"};
static const char *const ENG[] = {"claude", "codex", "muse", "cursor", "claude"};
static const char *const *idl[1];
static uint8_t idn[1] = {5};
static cable_swarm_t sw[1];
static void build(void) {
    pod_model_reset(&M);
    for (int i = 0; i < 5; i++) {
        char name[16]; snprintf(name, sizeof name, "agent-%s", ID[i]);
        pod_model_agent(&M, ID[i], name, ENG[i], "Mac Studio");
    }
    pod_model_agents_end(&M);
    idl[0] = ID;
    memset(&sw[0], 0, sizeof sw[0]);
    snprintf(sw[0].id, SWARM_ID_MAX, "s0");
    snprintf(sw[0].name, CABLE_NAME_MAX, "Desktop");
    sw[0].panes = 5; sw[0].agents = 5;
    pod_model_swarms(&M, sw, (const char *const **)idl, idn, 1, "s0", NULL, 0);
    pod_model_link(&M, true);
    pod_model_turn(&M, "c", "started", NULL, 0, 10);
    pod_model_turn(&M, "c", "activity", "Editing touch_gt911.c and turning the touch the same way as the panel", 134, 10);
    pod_model_question(&M, "x", "Run the migration on the dev database now?");
    pod_model_turn(&M, "d", "done", NULL, 0, 20);
    pod_model_recap(&M, "d", "First line. Second line. Third line.", false);
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
}
static void open_agent(const char *id) {
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    for (int i = 0; i < 5; i++) if (!strcmp(ID[i], id)) pod_nav_act(&N, &M, POD_A_OPEN_AGENT, i, 0);
}
static void open_view(const char *id, pod_view_t v) {
    open_agent(id);
    pod_view_t now = N.stack[N.depth - 1].view;
    if (v == POD_V_TALK) pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
    else if (now != v) pod_nav_act(&N, &M, POD_A_RECAP, 0, 0);
    CHECK(N.stack[N.depth - 1].view == v);
}

static void agent_test_scene_by_state(void) {
    build();
    open_view("c", POD_V_AGENT);
    render(3000);
    CHECK(art_has_pet("claude", POD_SCENE_WORK, 3000, 0));
    CHECK(find_text("agent-c") && find_text("Desktop") && find_working_chip() && !strncmp(find_working_chip()->text, pod_working_verb(134), strlen(pod_working_verb(134))) && find_pill_time() && !strncmp(find_pill_time()->text, "2:", 2));
    CHECK(find_text("Editing touch") != NULL);
    open_view("x", POD_V_AGENT);
    render(3000);
    CHECK(art_has_pet("codex", POD_SCENE_ASK, 3000, 0));
    CHECK(find_text("Needs you") && find_text("Run the migration") && find_text("Answer in the Harness app"));
    CHECK(find_text("Answer in the Harness app")->fg == ht_rgb(0xb46a00));
    open_view("m", POD_V_AGENT);
    render(3000);
    CHECK(art_has_pet("muse", POD_SCENE_REST, 3000, 0));
    CHECK(find_text("Idle") && find_text("Press") == NULL && find_text("to talk") == NULL);
    CHECK(find_text("agent-m")->pro_font == &ht_pro_32);
    CHECK(find_hit(POD_A_BACK) != NULL);
}

static void agent_test_option_a_layout(void) {
    build();
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *name = find_text("agent-c"), *title = find_text("Desktop");
    CHECK(name && name->x >= 248 && name->y < 130 && name->pro_font == &ht_pro_32);
    // the pet stands on the glass left of the title block: no square of any colour behind it
    bool square = false, pet = false;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_RECT && r->w == 196 && r->x == 26) square = true;
        if (r->pro_kind >= 16 && r->x >= 26 && r->x + r->w <= name->x) pet = true;
    }
    CHECK(!square && pet && title != NULL);
    // S5 LCD pill when working: dark pill across the head column, three green bars, the verb, the time on the right.
    const ht_run_t *chip = find_working_chip(), *pill = find_pill(), *tm = find_pill_time();
    int bx0, by0, bx1, by1;
    CHECK(chip && pill && tm && pill_box(&bx0, &by0, &bx1, &by1) && bx0 == 248 && bx1 == 694 && by1 - by0 == 40 && pill->w == 694 - 248);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_RECT && S.runs[i].w > 100 && S.runs[i].y >= by0 && S.runs[i].y < by1));   // no pill shape
    CHECK(chip->y > 170 && chip->y < 280 && chip->y >= pill->y && chip->y + ht_pro_24.height <= pill->y + 40 && chip->pro_font == &ht_pro_24);
    CHECK(tm->x + tm->w == 694 - 16 && tm->y >= pill->y && tm->pro_font == &ht_pro_24 && tm->x > chip->x + chip->w);
    CHECK(count_green_bars() == 3);
    // the engine is its own grey line under the name (above the tab), and no longer follows a chip
    CHECK(find_text("Claude") == NULL && title->y > name->y);   // no engine line: the pet says it
    CHECK(pill->y >= find_text("Mac Studio")->y + ht_pro_24.height);
    // no time / "working" row under the bar; the activity starts right under it
    CHECK(find_text("working") == NULL && find_text("idle") == NULL);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].y > 300 && S.runs[i].y < 322 && S.runs[i].x == 28));
    const ht_run_t *act = find_text("Editing touch");
    // the body starts 14 px under the art (no live bar any more: the LCD pill plays)
    CHECK(act && act->x == 28 && act->y == 84 + 196 + 14 && act->pro_font == &ht_pro_24 && act->fg == ht_rgb(0x111111));
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_RECT && S.runs[i].w == 664 && S.runs[i].pro_height == 9));
    open_view("x", POD_V_AGENT);
    render(3000);
    chip = find_text("Needs you");
    CHECK(chip && chip->fg == ht_rgb(0xb46a00) && chip->y < 280);
    CHECK(find_pill() == NULL && count_green_bars() == 0);
    {   // no engine line, nothing to the right of the chip
        CHECK(find_text("Codex") == NULL);
        for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= chip->y - 2 && S.runs[i].y < chip->y + 38 && S.runs[i].x > chip->x + chip->w));
    }
    const ht_run_t *q = find_text("Run the migration");
    CHECK(q && q->y > 300 && q->y > chip->y + 30 && find_text("Answer in the Harness app")->y > q->y);
    CHECK(find_text("working") == NULL);
    open_view("m", POD_V_AGENT);
    render(3000);
    chip = find_text("Idle");
    CHECK(chip && chip->fg == ht_rgb(0x7b7d84) && find_text("Press") == NULL);
    CHECK(find_text("idle") == NULL && find_pill() == NULL);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= chip->y - 2 && S.runs[i].y < chip->y + 38 && S.runs[i].x > chip->x + chip->w));
    // Item 1: nothing at all under the head of an idle agent: no bar, no text below the chip, only the transport.
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        CHECK(!(r->pro_kind == K_RECT && r->fg == ht_rgb(0xe5e9e5)));
        CHECK(!(r->pro_kind == K_TEXT && r->y > chip->y + 40 && r->y < POD_TRANSPORT_Y));
        CHECK(!(r->pro_kind == POD_TRI && r->y > 280 && r->y < POD_TRANSPORT_Y));
    }
}
// Items 9 and 10: the chip carries the dial's rotating verb; a working agent without activity text has an empty body.
static bool any_text_has(const char *needle);
// Claude's own spinner verb in the activity ("Infusing…") is the pill's word, not body text; a sentence stays in the body.
static void agent_test_spinner_verb(void) {
    char w[POD_VERB_MAX];
    const int room = pod_lcd_verb_room(694 - 248);
    CHECK(pod_activity_verb("Infusing\xe2\x80\xa6", w, sizeof w, room) && !strcmp(w, "Infusing"));
    CHECK(pod_activity_verb("  Reading files... ", w, sizeof w, room) && !strcmp(w, "Reading files"));   // the dial's trim
    CHECK(!pod_activity_verb("Working", w, sizeof w, room) && !pod_activity_verb("Working...", w, sizeof w, room));
    CHECK(!pod_activity_verb("", w, sizeof w, room) && !pod_activity_verb(NULL, w, sizeof w, room));
    CHECK(!pod_activity_verb("Editing touch_gt911.c - turning the touch the same way as the panel", w, sizeof w, room));   // too long: the body
    build();
    pod_model_turn(&M, "c", "started", NULL, 0, 10);
    pod_model_turn(&M, "c", "verb", "Infusing\xe2\x80\xa6", 0, 20);
    open_view("c", POD_V_AGENT);
    render(9000);   // the made-up verb would be "Brewing" here
    const ht_run_t *chip = find_working_chip();
    CHECK(chip && !strncmp(chip->text, "Infusing...", 11));
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= 294 && S.runs[i].y < POD_TRANSPORT_Y));
    pod_model_turn(&M, "c", "activity", "Editing touch_gt911.c - turning the touch the same way as the panel", 0, 30);
    render(9000);
    chip = find_working_chip();
    CHECK(chip && !strncmp(chip->text, "Infusing...", 11) && any_text_has("Editing touch_gt911.c"));   // the verb keeps the pill; the sentence is the body
}

static void agent_test_verb_and_empty_body(void) {
    build();
    CHECK(!strcmp(pod_working_verb(0), "Working") && !strcmp(pod_working_verb(5), "Working"));
    CHECK(!strcmp(pod_working_verb(6), "Brewing") && !strcmp(pod_working_verb(12), "Cooking"));
    CHECK(!strcmp(pod_working_verb(6 * 14), "Working"));   // it wraps
    // Started 10 ms, now 3000 ms: ~3 s in, so "Working", then the verb moves on every 6 s.
    pod_model_turn(&M, "c", "started", NULL, 0, 10);   // a new turn starts blank (an empty activity read keeps the line)
    pod_model_turn(&M, "c", "activity", "", 0, 10);
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *chip = find_working_chip();
    CHECK(chip && !strncmp(chip->text, "Working...", 10) && find_pill_time() && !strncmp(find_pill_time()->text, "0:0", 3));
    render(10000);
    chip = find_working_chip();
    CHECK(chip && !strncmp(chip->text, "Brewing...", 10) && find_pill_time() && !strncmp(find_pill_time()->text, "0:", 2));
    render(25000);
    chip = find_working_chip();
    CHECK(chip && !strncmp(chip->text, pod_working_verb(24), strlen(pod_working_verb(24))));
    // No placeholder: nothing under the bar while there is no activity text.
    render(3000);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= 294 && S.runs[i].y < POD_TRANSPORT_Y));
    // The chip fits the head column whatever the verb; the engine name follows it.
    for (int k = 0; k < 14; k++) {
        uint32_t t = 3000 + 6000u * (uint32_t)k;
        pod_model_turn(&M, "c", "activity", "", k * 6, t);   // heartbeats keep the turn alive; the cable carries the elapsed seconds
        render(t);
        chip = find_working_chip();
        CHECK(chip && !strncmp(chip->text, pod_working_verb((uint32_t)k * 6), strlen(pod_working_verb((uint32_t)k * 6))));
        CHECK(chip && find_pill_time() && chip->x + chip->w < find_pill_time()->x && find_pill_time()->x + find_pill_time()->w <= 694 && find_text("Claude") == NULL);
    }
    // Done: the verb is gone with the working chip.
    pod_model_turn(&M, "c", "done", NULL, 0, 90000);
    open_view("c", POD_V_RECAP);
    render(91000);
    CHECK(find_working_chip() == NULL);
}
// Item 7: an agent of an offline machine, known only from the tab's member metadata.
static void offline_test_views(void) {
    build();
    cable_swarm_t sw1[1];
    memset(sw1, 0, sizeof sw1);
    snprintf(sw1[0].id, SWARM_ID_MAX, "s0"); snprintf(sw1[0].name, CABLE_NAME_MAX, "Desktop");
    sw1[0].panes = 6; sw1[0].agents = 6;
    const char *ids6[] = {"c", "x", "m", "u", "d", "off"};
    const char *const *idl6[1] = {ids6};
    uint8_t cnt6[1] = {6};
    static pod_member_meta_t meta[1][POD_PANES_MAX];
    memset(meta, 0, sizeof meta);
    meta[0][5] = (pod_member_meta_t){"Stylist", "codex", "Diego's Mac", true, false};
    pod_model_swarms_meta(&M, sw1, idl6, cnt6, 1, "s0", NULL, 0, meta);
    CHECK(pod_model_find(&M, "off") && pod_model_find(&M, "off")->state == POD_OFFLINE);
    // The Tab list: greyed name and sub, "Offline" on the right, still a row that opens.
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    render(3000);
    const ht_run_t *nm = find_text("Stylist"), *off = find_text("Offline");
    CHECK(nm && nm->fg == ht_rgb(0xa0a4a0) && off && off->fg == ht_rgb(0xa0a4a0) && off->x + off->w >= 690);
    const ht_run_t *sub = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && strstr(S.runs[i].text, "Diego")) sub = &S.runs[i];
    CHECK(sub && sub->fg == ht_rgb(0xa0a4a0) && !strncmp(sub->text, "Codex", 5));
    CHECK(find_text("agent-c") && find_text("agent-c")->fg != ht_rgb(0xa0a4a0));   // the others are not greyed
    // The Tabs grid card draws its mark dimmed (a faded image run), and only for the offline pane.
    pod_nav_init(&N);
    render(3000);
    int faded = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_IMAGE && S.runs[i].radius == POD_MARK_DIM) faded++;
    CHECK(faded == 1);
    // Opening it: the Agent screen with a grey "Offline" chip, no bar or body, and no talking.
    pod_nav_init(&N);
    pod_nav_act(&N, &M, POD_A_OPEN_TAB, 0, 0);
    pod_out_t o = pod_nav_act(&N, &M, POD_A_OPEN_AGENT, 5, 0);
    CHECK(o.fx == POD_FX_AGENT_OPEN && N.stack[N.depth - 1].view == POD_V_AGENT);
    render(3000);
    const ht_run_t *chip = find_text("Offline");
    CHECK(chip && chip->fg == ht_rgb(0xa0a4a0) && find_text("Stylist") && find_text("6 of 6") == NULL);
    CHECK(find_working_chip() == NULL && find_text("Idle") == NULL);
    for (int i = 0; i < S.count; i++) CHECK(!(S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0xe5e9e5)));
    o = pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
    CHECK(o.fx == POD_FX_NONE && N.stack[N.depth - 1].view == POD_V_AGENT);
    // The machine leaves the metadata: the frame goes back to the tab's list.
    memset(meta, 0, sizeof meta);
    pod_model_swarms_meta(&M, sw1, idl6, cnt6, 1, "s0", NULL, 0, meta);
    pod_nav_sync(&N, &M);
    CHECK(N.depth == 2 && N.stack[1].view == POD_V_TAB);
}
// Item 3: the Agent screen's status bar says "Recap"; the tab name is in the head.
static void agent_test_status_title(void) {
    build();
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *t = find_text("Recap");
    CHECK(t && t->y < POD_STATUS_H);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < POD_STATUS_H) CHECK(strcmp(S.runs[i].text, "Desktop") != 0);
    CHECK(find_text("1 of 5") == NULL);   // no "N of M" (owner, 2026-10-10)
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(find_text("Recap") && find_text("Recap")->y < POD_STATUS_H);
    open_view("c", POD_V_TALK);
    render(3000);
    CHECK(find_text("agent-c") && find_text("agent-c")->y < POD_STATUS_H && find_text("Talking") == NULL);   // Listening: the name
}
// No "N of M" in the status bar, from a tab list or from Recent (owner, 2026-10-10: "bo 3 of 3 di").
static void agent_test_position(void) {
    build();
    open_view("x", POD_V_AGENT);
    render(3000);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < POD_STATUS_H) CHECK(strstr(S.runs[i].text, " of ") == NULL);
    open_view("d", POD_V_RECAP);
    render(3000);
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y < POD_STATUS_H) CHECK(strstr(S.runs[i].text, " of ") == NULL);
}
static int body_texts(uint16_t ink, const ht_run_t *out[], int max);
static void agent_test_activity_cap(void) {
    build();
    char big[900] = "";
    for (int i = 1; i <= 80; i++) { char t[40]; snprintf(t, sizeof t, "word%d ", i); strcat(big, t); }
    pod_model_turn(&M, "c", "activity", big, 134, 10);
    open_view("c", POD_V_AGENT);
    render(3000);
    int rows = 0;
    const ht_run_t *last = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_24 && S.runs[i].y >= 294 && S.runs[i].y < POD_TRANSPORT_Y) { rows++; last = &S.runs[i]; }
    CHECK(rows == 8 && last && last->y + ht_pro_24.height <= POD_TRANSPORT_Y);
    CHECK(strstr(last->text, "word80") == NULL);   // the model keeps 512 bytes: never past 8 rows
    // a long name: two lines at most
    pod_model_agent(&M, "c", "hello from my home area network gateway device in the garage and more words after", "claude", "Mac Studio");
    render(3000);
    int nrows = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y > 60 && S.runs[i].y < 180 && S.runs[i].x >= 248) nrows++;
    CHECK(nrows == 2);
}

// A 600 byte Vietnamese activity: the model cuts it at a codepoint boundary, the view fills 8 rows and ends with "...".
static bool utf8_valid(const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p;) {
        int n = *p < 0x80 ? 1 : (*p >> 5) == 6 ? 2 : (*p >> 4) == 14 ? 3 : (*p >> 3) == 30 ? 4 : 0;
        if (!n) return false;
        for (int k = 1; k < n; k++) if ((p[k] & 0xc0) != 0x80) return false;
        p += n;
    }
    return true;
}
static void agent_test_activity_vietnamese(void) {
    build();
    char big[700] = "";
    while (strlen(big) < 600) strcat(big, "Đang kiểm tra những nguyên nhân khiến thiết bị không kết nối được ");
    pod_model_turn(&M, "c", "activity", big, 134, 10);
    const pod_agent_t *a = pod_model_find(&M, "c");
    CHECK(strlen(a->activity) > 400 && strlen(a->activity) <= sizeof a->activity - 1 && utf8_valid(a->activity));
    open_view("c", POD_V_AGENT);
    render(3000);
    int rows = 0;
    const ht_run_t *last = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_24 && S.runs[i].y >= 294 && S.runs[i].y < POD_TRANSPORT_Y) {
            rows++; last = &S.runs[i];
            CHECK(utf8_valid(S.runs[i].text));
        }
    size_t ln = last ? strlen(last->text) : 0;
    CHECK(rows >= 5 && rows <= 8 && last && last->y + ht_pro_24.height <= POD_TRANSPORT_Y);
    // the Pro font has no ellipsis glyph: the run text normalises "\xe2\x80\xa6" to three dots
    CHECK(ln >= 3 && !strcmp(last->text + ln - 3, "..."));
    // the footer's word goes to the pill and leaves the body's sentence alone
    const ht_run_t *ink[8];
    int before = body_texts(ht_rgb(0x111111), ink, 8);
    pod_model_turn(&M, "c", "verb", "Reading files", 134, 11);
    render(3000);
    CHECK(find_working_chip() && !strncmp(find_working_chip()->text, "Reading files", 13));
    CHECK(before >= 5 && body_texts(ht_rgb(0x111111), ink, 8) == before);
}

static void agent_test_one_pet(void) {
    build();
    static const pod_view_t views[] = {POD_V_AGENT, POD_V_RECAP, POD_V_TALK};
    for (int i = 0; i < 5; i++)
        for (int v = 0; v < 3; v++) {
            open_agent(ID[i]);
            pod_view_t cur = N.stack[N.depth - 1].view;
            if (views[v] == POD_V_TALK) pod_nav_act(&N, &M, POD_A_TALK, 0, 1000);
            else if (cur != views[v]) pod_nav_act(&N, &M, POD_A_RECAP, 0, 0);
            if (N.stack[N.depth - 1].view != views[v]) continue;   // a done agent has no Agent view
            for (uint32_t t = 2000; t < 4000; t += 211) {
                render(t);
                CHECK(count_cells() <= 2);   // one scene: its frame and at most an overlay
                CHECK(S.count <= HT_RUNS && F.hit_count <= 32);
            }
        }
}

static void agent_test_runs_constant(void) {
    build();
    static const struct { const char *id; pod_view_t v; } cases[] = {
        {"c", POD_V_AGENT}, {"x", POD_V_AGENT}, {"m", POD_V_AGENT}, {"u", POD_V_AGENT},
        {"c", POD_V_RECAP}, {"d", POD_V_RECAP}, {"m", POD_V_RECAP}, {"c", POD_V_TALK}, {"u", POD_V_TALK}, {"d", POD_V_TALK},
    };
    for (unsigned k = 0; k < sizeof cases / sizeof cases[0]; k++) {
        open_view(cases[k].id, cases[k].v);
        render(1000);
        int want = S.count;
        CHECK(want > POD_TRANSPORT_RUNS && want <= HT_RUNS);
        for (uint32_t t = 1000; t < 7000; t += 137) { render(t); CHECK(S.count == want); }
    }
}

static void recap_test_rest_pet(void) {
    build();
    open_view("d", POD_V_RECAP);
    render(4000);
    CHECK(has_pet(46, 76, 132, "claude", POD_SCENE_REST, 4000, 0));
    CHECK(find_text("agent-d") && find_text("Done") && find_text("Desktop"));
    // A working agent's recap shows the work scene and says so.
    open_view("c", POD_V_RECAP);
    render(4000);
    CHECK(has_pet(46, 76, 132, "claude", POD_SCENE_WORK, 4000, 0));
    CHECK(find_working_chip() && find_text("The recap comes when this turn ends.") != NULL);
    for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].y + F.hits[i].h <= 60 || F.hits[i].y >= POD_TRANSPORT_Y);   // no hit in the body
    open_view("m", POD_V_RECAP);
    render(4000);
    CHECK(find_text("Idle") != NULL && find_text("The recap comes") == NULL);
}

static bool any_text_has(const char *part) {
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && strstr(S.runs[i].text, part)) return true;
    return false;
}
static int text_rows_between(int y0, int y1) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y >= y0 && S.runs[i].y < y1) n++;
    return n;
}
// The recap is plain wrapped text in one ink, no highlighted line and no hit in the body.
static void recap_test_plain_text(void) {
    build();
    open_view("d", POD_V_RECAP);
    render(0);
    const ht_run_t *a = find_text("First line.");
    CHECK(a != NULL && a->fg == ht_rgb(0x111111) && a->pro_font == &ht_pro_32);
    CHECK(strstr(a->text, "Second line.") && strstr(a->text, "Third line."));   // the lines joined with spaces, one row here
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT) CHECK(S.runs[i].fg != ht_rgb(0xbfc3bf));
    for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].y + F.hits[i].h <= 60 || F.hits[i].y >= POD_TRANSPORT_Y);
    CHECK(pod_recap_max_row(&N, &M) == 0);
}
// Item 5: at most 50 words of the recap, then "..." (Vietnamese text, counted by whitespace).
static void recap_test_fifty_words(void) {
    build();
    char big[1800] = "";
    for (int i = 1; i <= 120; i++) { char w[40]; snprintf(w, sizeof w, "%sTiếng%d", i > 1 ? " " : "", i); strcat(big, w); }
    pod_model_recap(&M, "d", big, false);
    CHECK(strstr(pod_model_find(&M, "d")->recap, "Tiếng120") != NULL);
    open_view("d", POD_V_RECAP);
    render(0);
    // 50 words of this width take more rows than fit: the drag reaches the end, which is word 50 and "...".
    CHECK(any_text_has("Tiếng1 ") && pod_recap_max_row(&N, &M) > 0);
    pod_nav_act(&N, &M, POD_A_SCROLL, 1000, 0);
    render(0);
    char all[2400] = "";
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y >= 200) { if (*all) strcat(all, " "); strcat(all, S.runs[i].text); }
    CHECK(strstr(all, "Tiếng50...") != NULL && strstr(all, "Tiếng51") == NULL && utf8_valid(all));
    size_t n = strlen(all);
    CHECK(n > 3 && !strcmp(all + n - 3, "..."));
    // Exactly 50 words: nothing added.
    char fifty[1000] = "";
    for (int i = 1; i <= 50; i++) { char w[40]; snprintf(w, sizeof w, "%sw%d", i > 1 ? " " : "", i); strcat(fifty, w); }
    pod_model_recap(&M, "d", fifty, false);
    render(0);
    CHECK(any_text_has("w50") && !any_text_has("..."));
}
static void recap_test_scrolls_when_long(void) {
    build();
    char big[900] = "";
    for (int i = 1; i <= 30; i++) { char s[40]; snprintf(s, sizeof s, "Sentence-%02d-wide-token ", i); strcat(big, s); }   // 30 words, one per row (the cap is 50)
    pod_model_recap(&M, "d", big, false);
    open_view("d", POD_V_RECAP);
    render(0);
    int shown = text_rows_between(200, POD_TRANSPORT_Y);
    int max = pod_recap_max_row(&N, &M);
    CHECK(shown >= 7 && max > 0 && pod_scroll_max(&N, &M) == max && pod_scroll_pitch(&N) == ht_pro_32.height);
    CHECK(any_text_has("Sentence-01-") && !any_text_has("Sentence-30-"));
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y >= 200)
            CHECK(S.runs[i].y + ht_pro_32.height <= POD_TRANSPORT_Y - 8);
    int rows = S.count;
    pod_nav_act(&N, &M, POD_A_SCROLL, 1000, 0);   // past the end: the draw clamps
    render(0);
    CHECK(any_text_has("Sentence-30-") && !any_text_has("Sentence-01-") && S.count >= rows - 2);
    pod_nav_act(&N, &M, POD_A_SCROLL, -1000, 0);
    render(0);
    CHECK(any_text_has("Sentence-01-"));
}

// "..." on the last visible row: more below, or the source was cut; none on a short whole recap.
static int dots_rows(void) {
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y >= 200) {
            size_t l = strlen(S.runs[i].text);
            if (l >= 3 && !strcmp(S.runs[i].text + l - 3, "...")) n++;
        }
    return n;
}
static void recap_test_ellipsis(void) {
    build();
    open_view("d", POD_V_RECAP);
    render(0);
    CHECK(dots_rows() == 0);                                   // short and whole
    pod_model_recap(&M, "d", "Fixed the parser and then +", false);
    render(0);
    CHECK(dots_rows() == 1 && any_text_has("Fixed the parser and then...") && !any_text_has("+"));
    char big[1400] = "";
    for (int i = 1; i <= 45; i++) { char s[40]; snprintf(s, sizeof s, "Sentence-%02d-wide-token ", i); strcat(big, s); }
    pod_model_recap(&M, "d", big, false);
    render(0);
    int shown = text_rows_between(200, POD_TRANSPORT_Y);
    CHECK(shown >= 7 && dots_rows() == 1);                      // fills the space, last row ends "..."
    const ht_run_t *lastrow = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y >= 200) lastrow = &S.runs[i];
    CHECK(lastrow && lastrow->y + ht_pro_32.height <= POD_TRANSPORT_Y - 8 && ht_pro_width(&ht_pro_32, lastrow->text) <= 640);
    pod_nav_act(&N, &M, POD_A_SCROLL, 1000, 0);                 // scrolled to the end: whole text, no dots
    render(0);
    CHECK(any_text_has("Sentence-45-") && dots_rows() == 0);
    pod_model_recap(&M, "d", "A long one that ends with a cut\xE2\x80\xA6", false);
    render(0);
    CHECK(dots_rows() == 1);
}

static int count_kind_run(int kind);
static int arcs_lit(void) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_ARC && S.runs[i].w > 0) n++;
    return n;
}
// N2 (mockup pro-listen.html): no pet, so the word Listening one letter a run, a light passing over the letters, and
// three arcs each side drifting in; no "to ... press" line, the title is the agent's name, the send button a paper plane.
// The send button: the play button's own gradient, and the plane's ink (its four triangles' box) centred on it.
static void send_button_ok(void) {
    int grads = 0, x0 = 9999, x1 = -9999, y0 = 9999, y1 = -9999, tris = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == POD_GRAD && r->w == 100 && r->y >= POD_TRANSPORT_Y) grads++;
        if (r->pro_kind == POD_TRI && r->y >= POD_TRANSPORT_Y && r->x > 300 && r->x + r->w < 420) {
            tris++;
            if (r->x < x0) x0 = r->x;
            if (r->x + r->w > x1) x1 = r->x + r->w;
            if (r->y < y0) y0 = r->y;
            if (r->y + r->pro_height > y1) y1 = r->y + r->pro_height;
        }
    }
    CHECK(grads == 1 && tris == 4);
    CHECK(abs((x0 + x1) - 2 * 360) <= 2 && abs((y0 + y1) - 2 * (POD_TRANSPORT_Y + 63)) <= 2);
}
static void talk_test_word_without_pet(void) {
    build();
    CHECK(!pod_pet_has("cursor", POD_SCENE_LISTEN));
    open_view("u", POD_V_TALK);
    render(4000);
    CHECK(count_cells() == 0);
    const ht_run_t *L = find_text("L");
    CHECK(L && find_text("g") && find_text("Listening") == NULL && find_text("to ") == NULL);
    CHECK(L->y > POD_STATUS_H && L->y + ht_pro_32.height < POD_TRANSPORT_Y);
    CHECK(find_text("agent-u") && find_text("agent-u")->y < POD_STATUS_H);
    CHECK(count_kind_run(POD_ARC) >= 6 && arcs_lit() >= 2 && arcs_lit() % 2 == 0);
    CHECK(count_rects(ht_rgb(0xff3b30), 12) == 0);
    send_button_ok();
    int runs = S.count;
    uint16_t ink0 = L->fg;
    int moved = 0;
    for (uint32_t t = 4000; t < 5700; t += 105) {
        render(t);
        CHECK(S.count == runs);                                 // the arcs keep their slots
        moved += find_text("L")->fg != ink0;
    }
    CHECK(moved > 0);                                           // the light passes
}

static void talk_test_listen_with_pet(void) {
    build();
    CHECK(pod_pet_has("claude", POD_SCENE_LISTEN));
    open_view("c", POD_V_TALK);
    render(4000);
    CHECK(count_rects(ht_rgb(0xff3b30), 12) == 0);
    CHECK(has_pet(230, (POD_STATUS_H + POD_TRANSPORT_Y) / 2 - 130, 260, "claude", POD_SCENE_LISTEN, 4000, 1000));
    CHECK(find_text("Listening") == NULL && find_text("agent-c") && find_text("agent-c")->y < POD_STATUS_H);
    send_button_ok();
    CHECK(find_text("SEND") == NULL && find_text("TALK") == NULL && find_text("TABS") != NULL && find_text("PANES") != NULL);
}

static void transport_test_hit_sizes(void) {
    build();
    static const struct { const char *id; pod_view_t v; } cases[] = {
        {"c", POD_V_AGENT}, {"x", POD_V_AGENT}, {"m", POD_V_AGENT}, {"c", POD_V_RECAP}, {"d", POD_V_RECAP},
        {"c", POD_V_TALK}, {"u", POD_V_TALK},
    };
    for (unsigned k = 0; k < sizeof cases / sizeof cases[0]; k++) {
        open_view(cases[k].id, cases[k].v);
        render(2000);
        int transport = 0;
        for (int i = 0; i < F.hit_count; i++) {
            const pod_hit_t *h = &F.hits[i];
            CHECK(h->x >= 0 && h->x + h->w <= 720 && h->y >= 0 && h->y + h->h <= 720);
            if (h->y >= POD_TRANSPORT_Y) { CHECK(h->w >= 80 && h->h >= 80); transport++; }
        }
        CHECK(transport == 5);
        CHECK(find_hit(POD_A_TABS) && find_hit(POD_A_PANES) && find_hit(POD_A_PREV) && find_hit(POD_A_TALK) && find_hit(POD_A_NEXT));
        CHECK(find_hit(POD_A_RECAP) == NULL);
        CHECK(find_text("RECAP") == NULL && find_text("TALK") == NULL);
        CHECK(find_hit(POD_A_BACK) != NULL);
    }
}

static void send_test_plays_once(void) {
    build();
    open_view("c", POD_V_AGENT);
    pod_nav_act(&N, &M, POD_A_TALK, 0, 5000);
    pod_out_t o = pod_nav_act(&N, &M, POD_A_TALK, 0, 6000);
    CHECK(o.fx == POD_FX_VOICE_END && N.stack[N.depth - 1].view == POD_V_AGENT);
    const ht_pet_scene_t *sc = pod_pet_for("claude")->sending_scene;
    CHECK(sc != NULL);
    uint32_t len = (uint32_t)sc->steps * sc->step_ms;
    render(6000 + 50);
    CHECK(art_has_pet("claude", POD_SCENE_SEND, 6050, 6000));
    CHECK(!art_has_pet("claude", POD_SCENE_WORK, 6050, 0));
    int want = S.count;
    render(6000 + len - 1);
    CHECK(art_has_pet("claude", POD_SCENE_SEND, 6000 + len - 1, 6000));
    CHECK(S.count == want);
    render(6000 + len + 5);
    CHECK(art_has_pet("claude", POD_SCENE_WORK, 6000 + len + 5, 0));
    CHECK(!art_has_pet("claude", POD_SCENE_SEND, 6000 + len + 5, 6000));
    // Another agent never plays it.
    open_view("d", POD_V_RECAP);
    open_agent("m");
    render(6050);
    CHECK(!art_has_pet("muse", POD_SCENE_SEND, 6050, 6000));
}

static int chrome_arcs(void) {   // arcs in the status bar and transport (the pets draw their own)
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == POD_ARC && S.runs[i].w > 0 && (S.runs[i].y < POD_STATUS_H || S.runs[i].y >= POD_TRANSPORT_Y)) n++;
    return n;
}
static int count_kind_run(int kind) {
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == kind) n++;
    return n;
}
// Owner round 2: the icons are POD_TRI triangles (a mitered chevron, play triangles, no pie slices), the info line is
// "<Tab> . <Machine>", and a long name shrinks (Agent) or wraps onto two lines (Recap).
static void icon_test_triangles(void) {
    build();
    open_view("m", POD_V_AGENT);
    render(3000);
    // chevron 4 + prev, next and play 3; an idle agent has no inline "Press (play) to talk"; no arcs at all.
    CHECK(count_kind_run(POD_TRI) == 4 + 3 && chrome_arcs() == 0);
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(count_kind_run(POD_TRI) == 4 + 3 + 4 && chrome_arcs() == 0);   // + the Done tick (4)
}
// The chevron is one clean stroke: no gaps at the joint, nothing outside its outline.
static void icon_test_chevron_solid(void) {
    enum { W = 64, H = 64 };
    static uint16_t buf[W * H];
    ht_scene_t sc;
    ht_scene_clear(&sc, 0xffff);
    uint16_t blue = ht_rgb(0x1f63d1);
    pod_chevron(&sc, 20, 30, 13, blue);
    CHECK(sc.count == 4);
    memset(buf, 0xff, sizeof buf);
    ht_rect_t clip = {0, 0, W, H};
    for (int i = 0; i < sc.count; i++) ht_pro_raster(&sc.runs[i], clip, buf);
    for (int px = 22; px <= 30; px++) {
        CHECK(buf[(49 - px) * W + px] == blue);   // the upper arm's centreline
        CHECK(buf[(px + 10) * W + px] == blue);   // the lower arm's
    }
    for (int px = 19; px <= 21; px++) CHECK(buf[29 * W + px] == blue && buf[30 * W + px] == blue);   // across the joint
    CHECK(buf[30 * W + 14] == 0xffff && buf[10 * W + 20] == 0xffff && buf[30 * W + 40] == 0xffff);
    // The same for the tick.
    ht_scene_clear(&sc, 0xffff);
    pod_tick(&sc, 10, 20, blue);
    CHECK(sc.count == 4);
    memset(buf, 0xff, sizeof buf);
    for (int i = 0; i < sc.count; i++) ht_pro_raster(&sc.runs[i], clip, buf);
    int inked = 0;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (buf[y * W + x] == blue) inked++;
    CHECK(inked > 40);
    CHECK(buf[(20 + 13) * W + 17] == blue || buf[(20 + 13) * W + 16] == blue || buf[(20 + 12) * W + 17] == blue);   // the joint
}
static void who_test_line_and_names(void) {
    build();
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *tab = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, "Desktop") && S.runs[i].fg == ht_rgb(0x1f63d1)) tab = &S.runs[i];
    const ht_run_t *mach = find_text("Mac Studio");
    CHECK(tab && tab->fg == ht_rgb(0x1f63d1) && mach && mach->fg == ht_rgb(0x7b7d84));
    // Item 4: the tab alone on its line, the machine alone on the next (no dot), the chip under both.
    CHECK(!strcmp(tab->text, "Desktop") && !strcmp(mach->text, "Mac Studio") && !any_text_has("\xc2\xb7"));
    CHECK(tab->x == 248 && mach->x == 248 && mach->y >= tab->y + ht_pro_24.height - 2);
    const ht_run_t *chipw = find_working_chip();
    CHECK(chipw && find_pill() && find_pill()->y >= mach->y + ht_pro_24.height - 2 && find_pill()->y + 40 < 294);
    CHECK(!any_text_has("pane "));
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(find_text("Desktop") && find_text("Mac Studio") && !any_text_has("pane ") && find_text("Claude") == NULL);
    {   // the tab, the machine and the "Done" line stack above the body, which starts at 272
        const ht_run_t *t1 = find_text("Desktop"), *m1 = find_text("Mac Studio"), *d1 = find_text("Done");
        CHECK(t1->y + ht_pro_24.height <= m1->y + 2 && m1->y + ht_pro_24.height <= d1->y + 2 && d1->y + ht_pro_24.height <= 272);
    }
    // No machine: just the tab.
    pod_model_agent(&M, "m", "agent-m", "muse", "");
    open_view("m", POD_V_AGENT);
    render(3000);
    CHECK(find_text("Desktop") && !any_text_has("\xc2\xb7"));
    // A long name: the Agent screen wraps it to two lines in 32 (then an ellipsis); the Recap wraps it onto two lines in 32.
    const char *longname = "hello from my home area network gateway device in the garage";
    pod_model_agent(&M, "m", longname, "muse", "Mac Studio");
    open_view("m", POD_V_AGENT);
    render(3000);
    const ht_run_t *n = find_text("hello from");
    CHECK(n && n->pro_font == &ht_pro_32);
    open_view("m", POD_V_RECAP);
    render(3000);
    int rows = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y < 170 && S.runs[i].y > 60) rows++;
    CHECK(rows == 2);
    CHECK(find_text("hello from")->pro_font == &ht_pro_32);
    const ht_run_t *who = NULL, *last = NULL;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, "Desktop") && S.runs[i].fg == ht_rgb(0x1f63d1)) who = &S.runs[i];
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_32 && S.runs[i].y < 170 && S.runs[i].y > 60) last = &S.runs[i];
    CHECK(who && last && who->y >= last->y + 36);   // the info line sits under the second line
    {   // and the recap body starts under the three info lines
        const ht_run_t *dn = find_text("Idle");
        CHECK(dn && dn->y + ht_pro_24.height <= 302);
    }
    // A short name is one line in 32 on both screens.
    pod_model_agent(&M, "m", "short", "muse", "Mac Studio");
    open_view("m", POD_V_RECAP);
    render(3000);
    CHECK(find_text("short")->pro_font == &ht_pro_32);
    open_view("m", POD_V_AGENT);
    render(3000);
    CHECK(find_text("short")->pro_font == &ht_pro_32);
}

// S5 LCD: the status is a dark pill only while working; the engine is a line under the name; same 14 px rhythm.
static void lcd_test_agent_and_recap(void) {
    build();
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *name = find_text("agent-c"), *tab = find_text("Desktop"), *mach = find_text("Mac Studio"), *pill = find_pill();
    CHECK(name && tab && mach && pill && find_text("Claude") == NULL);
    CHECK(tab->y - name->y == 9 + 23 + 14 - 6);                 // the first line sits 14 px under the name's baseline
    CHECK(mach->y - tab->y == 31);
    CHECK(pill->y == mach->y + 6 + 17 + 14);                    // and so does the pill under the machine line
    CHECK(pill->y + 40 <= 294);
    // The bars move between ticks; the run count stays put.
    int count1 = S.count;
    render(3150);
    CHECK(S.count == count1 && count_green_bars() == 3);
    {   // bar heights differ between the two ticks
        ht_run_t a[3], b[3]; int na = 0, nb = 0;
        render(3000);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2a9a57) && na < 3) a[na++] = S.runs[i];
        render(3150);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(0x2a9a57) && nb < 3) b[nb++] = S.runs[i];
        int diff = 0;
        for (int k = 0; k < 3; k++) diff += a[k].pro_height != b[k].pro_height;
        CHECK(na == 3 && nb == 3 && diff > 0);
    }
    // Recap while working: the same pill, the engine line, the body under it; Done keeps its line, no pill.
    open_view("c", POD_V_RECAP);
    render(3000);
    pill = find_pill();
    CHECK(pill && find_working_chip() && find_pill_time() && count_green_bars() == 3 && !any_text_has("\xe2\x96\xae"));
    CHECK(find_text("Claude") == NULL && find_text("Desktop") && find_text("Desktop")->x == 201);
    { int a0, b0, a1, b1; CHECK(pill_box(&a0, &b0, &a1, &b1) && a0 == 201 && b1 - b0 == 40); }
    CHECK(pill->y >= find_text("Mac Studio")->y + ht_pro_24.height);
    CHECK(find_text("The recap comes when this turn ends.")->y >= pill->y + 40);
    open_view("d", POD_V_RECAP);
    render(3000);
    CHECK(find_pill() == NULL && find_text("Done") && find_text("Claude") == NULL);
}


// ---- the pill takes the glass's colour; the steps of a working turn ----------------------------------------

enum { GROUND = 0xeeede5 };   // HT_THEME_CANVAS: what the Pod screen is cleared to on the device
static uint16_t px[56 * 450];
static void raster_pill(int x, int y, int w, uint16_t ground) {
    static ht_scene_t sc;
    ht_scene_clear(&sc, ground);
    pod_agent_t a;
    memset(&a, 0, sizeof a);
    snprintf(a.id, sizeof a.id, "c");
    a.state = POD_WORKING;
    pod_lcd_pill(&sc, x, y, w, &a, 1000);
    ht_rect_t clip = {x - 4, y - 4, w + 8, POD_LCD_H + 8};
    for (int i = 0; i < clip.w * clip.h; i++) px[i] = ground;
    for (int i = 0; i < sc.count; i++) {
        if (sc.runs[i].pro_kind >= POD_KIND_BASE) pod_draw_raster(&sc.runs[i], clip, px);
        else ht_pro_raster(&sc.runs[i], clip, px);
    }
}
static void lcd_test_content_only(void) {
    const int x = 248, y = 190, w = 446;
    const uint16_t ground = ht_rgb(GROUND);
    raster_pill(x, y, w, ground);
    const int cw = w + 8;
    #define PX(X, Y) px[((Y) - (y - 4)) * cw + ((X) - (x - 4))]
    // no rim, no fill: the strips along the top and bottom (content sits 8 px in), the corners and both sides are the ground
    for (int yy = y; yy <= y + 5; yy++)
        for (int xx = x; xx < x + w; xx++) CHECK(PX(xx, yy) == ground);
    for (int yy = y + POD_LCD_H - 6; yy < y + POD_LCD_H; yy++)
        for (int xx = x; xx < x + w; xx++) CHECK(PX(xx, yy) == ground);
    for (int yy = y; yy < y + POD_LCD_H; yy++) CHECK(PX(x, yy) == ground && PX(x + w - 1, yy) == ground && PX(x + 8, yy) == ground);
    #undef PX
    // only the three bars, the verb and the time: five runs, whatever the clock or the ground
    for (uint32_t t = 0; t < 3000; t += 250) {
        static ht_scene_t sc;
        ht_scene_clear(&sc, 0);
        pod_agent_t a;
        memset(&a, 0, sizeof a);
        a.state = POD_WORKING;
        pod_lcd_pill(&sc, x, y, w, &a, t);
        CHECK(sc.count == 5);
    }
}

static int body_texts(uint16_t ink, const ht_run_t *out[], int max) {
    int n = 0;
    for (int i = 0; i < S.count && n < max; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ht_pro_24 && S.runs[i].y >= 290 && S.runs[i].y < POD_TRANSPORT_Y &&
            S.runs[i].fg == ink) out[n++] = &S.runs[i];
    return n;
}
// A working agent shows the sentence in ink, then its previous steps in grey, newest first, one line each, above the transport.
static void agent_test_steps(void) {
    build();
    pod_model_turn(&M, "c", "started", NULL, 0, 10);
    pod_model_turn(&M, "c", "activity", "Reading pod_view_agent.c to find the pill", 3, 20);
    open_view("c", POD_V_AGENT);
    render(3000);
    const ht_run_t *ink[8], *grey[8];
    CHECK(body_texts(ht_rgb(0x111111), ink, 8) == 1 && body_texts(ht_rgb(0x7b7d84), grey, 8) == 0);
    pod_model_turn(&M, "c", "activity", "Running npm test to see which specs fail", 9, 30);
    pod_model_turn(&M, "c", "activity", "Fixing the failing spec in the model feed", 12, 40);
    render(3000);
    int ni = body_texts(ht_rgb(0x111111), ink, 8), ng = body_texts(ht_rgb(0x7b7d84), grey, 8);
    CHECK(ni == 1 && !strncmp(ink[0]->text, "Fixing the failing", 18) && ink[0]->y == 84 + 196 + 14);
    CHECK(ng == 2 && !strncmp(grey[0]->text, "Running npm test", 16) && !strncmp(grey[1]->text, "Reading pod_view_agent.c", 24));
    CHECK(grey[0]->y >= ink[0]->y + ht_pro_24.height && grey[1]->y > grey[0]->y && grey[1]->y + ht_pro_24.height <= POD_TRANSPORT_Y);
    CHECK(grey[0]->x == 28 && grey[0]->pro_font == &ht_pro_24);
    // an empty read never blanks a line
    pod_model_turn(&M, "c", "activity", "", 13, 50);
    render(3000);
    CHECK(body_texts(ht_rgb(0x111111), ink, 8) == 1 && body_texts(ht_rgb(0x7b7d84), grey, 8) == 2);
    // the run count is the same whatever the clock says; a long sentence leaves room for the steps and stays above the transport
    pod_model_turn(&M, "c", "activity", "Doing a long thing that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on", 14, 60);
    render(3000);
    int last_y = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y >= 290 && S.runs[i].y < POD_TRANSPORT_Y && S.runs[i].y > last_y) last_y = S.runs[i].y;
    CHECK(body_texts(ht_rgb(0x7b7d84), grey, 8) >= 1 && last_y + ht_pro_24.height <= POD_TRANSPORT_Y);
    int want = S.count;
    for (uint32_t t = 3000; t < 9000; t += 211) { render(t); CHECK(S.count == want); }
    // the pill's word changes neither the sentence nor the steps
    int rows_before = body_texts(ht_rgb(0x111111), ink, 8);
    pod_model_turn(&M, "c", "verb", "Infusing\xe2\x80\xa6", 15, 70);
    render(3000);
    CHECK(find_working_chip() && !strncmp(find_working_chip()->text, "Infusing...", 11));
    CHECK(body_texts(ht_rgb(0x111111), ink, 8) == rows_before && body_texts(ht_rgb(0x7b7d84), grey, 8) >= 1);
}

// The daemon's real cadence for one agent: every ~3 s a turn.activity arrives as the footer word, then (ms later) the
// progress sentence, with empty reads of either in between. Neither source may blank or replace the other: every beat
// renders the same body and pill (the clock is held still, so the frames must be byte-identical).
static void agent_test_cadence_replay(void) {
    build();
    pod_model_turn(&M, "c", "started", NULL, 0, 10);
    open_view("c", POD_V_AGENT);
    static ht_run_t ref[HT_RUNS];
    int ref_count = 0;
    const char *verbs[] = {"Infusing...", "", "Infusing\xe2\x80\xa6", "", "Infusing..."};
    for (int beat = 0; beat < 40; beat++) {
        uint32_t t = 100 + (uint32_t)beat * 3000;
        pod_model_turn(&M, "c", "verb", verbs[beat % 5], 5 + beat * 3, t);
        pod_model_turn(&M, "c", "activity", beat % 3 == 1 ? "" : "Editing pod_view_agent.c to show the steps", 5 + beat * 3, t + 20);
        pod_model_turn(&M, "c", "verb", "", 5 + beat * 3, t + 30);
        pod_model_turn(&M, "c", "activity", "", 5 + beat * 3, t + 40);
        if (beat == 0) { pod_model_turn(&M, "c", "activity", "Editing pod_view_agent.c to show the steps", 5, t + 50); }
        // a fixed instant: the rotating gerund and the clock move with the elapsed seconds, so fix those too
        pod_model_turn(&M, "c", "activity", "", 5, t + 60);
        render(7000);
        if (!ref_count) {
            ref_count = S.count;
            memcpy(ref, S.runs, sizeof(ht_run_t) * (size_t)S.count);
            CHECK(find_working_chip() && !strncmp(find_working_chip()->text, "Infusing...", 11) && find_text("Editing pod_view_agent.c"));
            continue;
        }
        CHECK(S.count == ref_count);
        // elapsed advances the time run only; every other run is identical, byte for byte
        for (int i = 0; i < S.count; i++) {
            if (S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x1f9d4c)) continue;
            CHECK(!memcmp(&S.runs[i], &ref[i], sizeof S.runs[0]));
        }
    }
}

int main(void) {
    agent_test_scene_by_state();
    agent_test_option_a_layout();
    agent_test_status_title();
    offline_test_views();
    agent_test_verb_and_empty_body();
    agent_test_spinner_verb();
    agent_test_position();
    agent_test_activity_cap();
    agent_test_activity_vietnamese();
    agent_test_one_pet();
    agent_test_runs_constant();
    recap_test_rest_pet();
    recap_test_plain_text();
    recap_test_fifty_words();
    recap_test_scrolls_when_long();
    recap_test_ellipsis();
    talk_test_word_without_pet();
    talk_test_listen_with_pet();
    transport_test_hit_sizes();
    send_test_plays_once();
    icon_test_triangles();
    icon_test_chevron_solid();
    who_test_line_and_names();
    lcd_test_agent_and_recap();
    lcd_test_content_only();
    agent_test_steps();
    agent_test_cadence_replay();
    printf("test_pod_views_agent: %d checks passed\n", checks);
    return 0;
}
