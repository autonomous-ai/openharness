// Dev tool (not run by run.sh): renders one Pets screen of a fixed demo model to a 720 x 720 PPM.
// Usage: pod_render [--spec out.json] <screen> <out.ppm> [now_ms]      pod_render.py builds it and converts the PPMs to PNG.
//   screens: tabs[:<tab>[+<more tabs>] | :mock | :9 | :seven | :single | :long | :notices | :linkdown | :banner] (Home),
//   agent:<id>, recap:<id>, talk:<id> (ids: fw ota be cli web desk docs vault site cur notes2 kilo; suffixes :long :offline :unread :viet ...),
//   talk:listen|send, inbox[:viet|:quiet|:failed], ota:<pct>|ota:restart (the update screen), notice:updated|notice:failed (the Home screen with that pill),
//   <room>:toast[@<ms after it showed>] (the notice toast; <room>:toast:decision / :stuck: a Super Tab question's staying toast, backend deciding or
//   desktop stuck), inbox:supertab (Notices with those two asking rows above a plain entry), and ":bell" / ":banner" on a screen (unread entries; banner adds the toast). The demo is the
//   HTML mockup's: the same agents, tabs and times. `--skin pets` is accepted and ignored (Pets is the only interface).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "pod/home/ph.h"
#include "pod/pod_view.h"
#include "pro_canvas.h"

// A recap only lands on a Lead that was asked for (LOADING), as the Lead view does: the fixtures ask first.
static void asked_recap(pod_model_t *m, const char *tab, const char *lead, const char *text, uint32_t at, bool none)
{
    pod_model_supertab_loading(m, tab, lead);
    pod_model_supertab_recap(m, tab, lead, "", text, at, none);
}

#define T0 100000u

typedef struct { const char *id, *name, *engine, *machine; } demo_agent_t;
static const demo_agent_t AGENTS[] = {
    {"fw", "firmware-pro", "claude", "MacBook Pro"}, {"ota", "dial-ota", "claude", "MacBook Pro"},
    {"be", "backend", "codex", "Mac Studio"},        {"cli", "harness-cli", "codex", "MacBook Pro"},
    {"web", "website", "muse", "Mac Studio"},        {"desk", "desktop", "claude", "Mac Studio"},
    {"docs", "docs", "codex", "Mac Studio"},         {"vault", "obsidian-vault", "muse", "MacBook Pro"},
    {"site", "landing", "codex", "Mac Studio"},      {"cur", "api-client", "cursor", "MacBook Pro"},
    {"notes2", "reading-list", "muse", "MacBook Pro"},
    {"kilo", "kilo-agent", "kilo", "Mac Studio"},
};
static const char *const T_FW[] = {"fw", "ota"}, *const T_BE[] = {"be", "cli", "web"},
    *const T_DESK[] = {"desk", "docs", "vault", "site"}, *const T_NOTES[] = {"vault", "notes2", "kilo"},
    *const T_WEB[] = {"web", "site", "cur"};
static const char *const T_REPO[] = {"fw", "be", "web", "docs", "cur", "notes2"};   // six panes, laid out 3 x 2 by the window
static const char *const *TAB_IDS[] = {T_FW, T_BE, T_DESK, T_NOTES, T_WEB, T_REPO};
static const uint8_t TAB_N[] = {2, 3, 4, 3, 3, 6};
static const char *const TAB_NAMES[] = {"Firmware", "Backend", "Desktop", "Notes", "Web", "Harness repo"};
#define TABS 6

static pod_model_t M;
static pod_nav_t N;
static ht_scene_t S;
static pod_out_frame_t F;

static void demo(void)
{
    pod_model_reset(&M);
    pod_model_agents_begin(&M);
    for (unsigned i = 0; i < sizeof AGENTS / sizeof AGENTS[0]; i++)
        pod_model_agent(&M, AGENTS[i].id, AGENTS[i].name, AGENTS[i].engine, AGENTS[i].machine);
    pod_model_agents_end(&M);
    cable_swarm_t sw[TABS];
    for (int i = 0; i < TABS; i++) {
        memset(&sw[i], 0, sizeof sw[i]);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", TAB_NAMES[i]);
        sw[i].panes = TAB_N[i]; sw[i].agents = TAB_N[i];
    }
    cable_tile_t tiles[6];   // the selected tab, "Harness repo": 3 columns x 2 rows
    memset(tiles, 0, sizeof tiles);
    for (int k = 0; k < 6; k++) {
        tiles[k].x1 = (int16_t)(k % 3 * 333); tiles[k].x2 = (int16_t)(k % 3 == 2 ? 1000 : (k % 3 + 1) * 333);
        tiles[k].y1 = (int16_t)(k / 3 * 500); tiles[k].y2 = (int16_t)((k / 3 + 1) * 500);
        snprintf(tiles[k].agent_id, sizeof tiles[k].agent_id, "%s", T_REPO[k]);
    }
    pod_model_swarms(&M, sw, TAB_IDS, TAB_N, TABS, "s5", tiles, 6);
    pod_model_link(&M, true);
    pod_model_turn(&M, "fw", "activity", "Editing touch_gt911.c \xe2\x80\x94 turning the touch the same way as the panel", 134, T0);
    pod_model_turn(&M, "ota", "activity", "Building with idf.py \xe2\x80\x94 1,204 of 1,530", 301, T0);
    pod_model_turn(&M, "be", "activity", "Running pnpm test \xe2\x80\x94 212 of 640", 48, T0);
    pod_model_turn(&M, "web", "activity", "Drawing the pricing cards", 12, T0);
    pod_model_turn(&M, "cur", "activity", "Regenerating the OpenAPI client", 73, T0);
    pod_model_turn(&M, "cli", "activity", "Preparing the migration", 29, T0);
    pod_model_question(&M, "cli", "Run the migration on the dev database now?");
    pod_model_turn(&M, "desk", "activity", "Wrapping up", 252, T0);
    pod_model_turn(&M, "desk", "done", NULL, 0, T0);
    pod_model_recap(&M, "desk", "The Relaxing chip now follows Rest until you pick a row for it. Rest reads Idle, so the two are not "
                    "confused. All 54 pet settings tests pass. Nothing is committed yet.", false);
    pod_model_turn(&M, "docs", "activity", "Wrapping up", 77, T0);
    pod_model_turn(&M, "docs", "done", NULL, 0, T0);
    pod_model_recap(&M, "docs", "The release guide now says to reuse the Desktop receipt. No other page changed.", false);
    pod_model_recap(&M, "kilo", "Sorted the imports and removed the dead branch in the router. Tests pass.", false);
    pod_model_turn(&M, "kilo", "done", NULL, 0, T0);
    pod_model_recap(&M, "vault", "Added two more poems to Poems and Themes.md: \xe2\x80\x9cMorning Window\xe2\x80\x9d and "
                    "\xe2\x80\x9cThe River\xe2\x80\x9d.", true);
    pod_nav_init(&N);
}

// Fixtures: the agent's verb, steps and stats the Pets
// screens read. screen's tokens pick edge cases: long (long names, a long question, long steps), offline, extreme (999 passes, 12 failures, 1:23:45, huge tokens), testfail (desk's turn
// stats fail), scroll (desk's recap is long and scrolled), and inbox (reading-list's last turn failed).
static void set_steps(const char *id, int n, const char *const text[], const uint16_t at[])
{
    pod_agent_t *a = (pod_agent_t *)pod_model_find(&M, id);
    for (int i = 0; i < n; i++) { snprintf(a->steps[i], sizeof a->steps[i], "%s", text[i]); a->step_at_s[i] = at[i]; }
    a->step_count = (uint8_t)n;
}
static void console_fixture(const char *screen)
{
    static const char *const fw[] = {"npm test \xc2\xb7 44 passed", "The hero now uses the new gradient; pricing is next.", "Read src/pricing.tsx", "Read src/hero.tsx", "Read src/tokens.css", "Listed src/"};
    static const uint16_t fw_at[] = {41, 72, 130, 151, 160, 170};
    static const char *const cli[] = {"Ran the migration on a copy \xc2\xb7 ok", "Read migrations/0042_retry_queue.sql"};
    static const uint16_t cli_at[] = {12, 30};
    pod_agent_t *a;
    set_steps("fw", 6, fw, fw_at);
    snprintf(((pod_agent_t *)pod_model_find(&M, "fw"))->verb, POD_VERB_BYTES, "Edit");
    set_steps("cli", 2, cli, cli_at);
    set_steps("desk", 6, fw, fw_at);
    ((pod_agent_t *)pod_model_find(&M, "desk"))->step_total = 14;   // the recap's STEPS tile: the turn's total (the list holds 6); the other recaps' turn starts were never seen
    pod_model_turn_stats(&M, "desk", 54, 0, 0, 42900, 18500);   // the TOKENS tile: 61.4k
    if (strstr(screen, "testfail")) { pod_model_turn_stats(&M, "desk", 52, 2, 1, -1, -1); }
    if (strstr(screen, "extreme")) {   // recap tiles at their widest: 3 digits of passes, failures, a 1:23:45 duration, a huge token count and commit count
        pod_model_turn_stats(&M, "desk", 999, 12, 99999, 99999999, 99999999);
        ((pod_agent_t *)pod_model_find(&M, "desk"))->elapsed_s = 5025;
    }
    if (!strncmp(screen, "inbox", 5)) ((pod_agent_t *)pod_model_find(&M, "notes2"))->failed = true;
    if (strstr(screen, "offline")) ((pod_agent_t *)pod_model_find(&M, "be"))->state = POD_OFFLINE;
    if (strstr(screen, "long")) {
        static const char *const lg[] = {"A very long tool line that goes on and on and certainly cannot fit in the row of the timeline at all, not even close",
                                         "Read a/very/deeply/nested/path/to/some/source/file/that/has/a/long/name/and_an_even_longer_basename_in_the_end.tsx", "Short"};
        static const uint16_t at[] = {41, 0xFFFF, 130};
        a = (pod_agent_t *)pod_model_find(&M, "fw");
        snprintf(a->name, sizeof a->name, "%s", "marketing-site-redesign-with-a-really-long-name");
        snprintf(a->machine, sizeof a->machine, "A Very Long Machine Name On The Network");
        snprintf(a->activity, sizeof a->activity, "src/components/pricing/PricingCardWithAnimatedGradientBackground.tsx and then some");
        set_steps("fw", 3, lg, at);
        pod_model_question(&M, "cli", "Run the migration on the dev database now, or do you want me to wait until the retry queue drains and the nightly backup has finished, "
                           "because the migration locks the jobs table for about a minute and every worker will stall meanwhile and then retry?");
    }
    if (strstr(screen, "scroll")) {
        char text[2048] = "";
        for (int i = 0; strlen(text) < 1900; i++) { char t[80]; snprintf(t, sizeof t, "Sentence %d of the recap says the Relaxing chip follows Rest. ", i + 1); strcat(text, t); }
        pod_model_recap(&M, "desk", text, false);
    }
}

// The mockup's Option B: Recent, then five tabs with the second selected (the mockup's last, empty one is not shown).
static void mock_tabs(void)
{
    static const char *const names[] = {"Harness repo", "Doi song", "Thoi trang", "Harness Store", "New Swarm"};
    static const char *const *ids[] = {T_REPO, T_BE, T_FW, T_DESK, NULL};
    static const uint8_t n[] = {6, 3, 2, 4, 0};
    cable_swarm_t sw[5];
    memset(sw, 0, sizeof sw);
    for (int i = 0; i < 5; i++) {
        snprintf(sw[i].id, SWARM_ID_MAX, "m%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", names[i]);
        sw[i].panes = sw[i].agents = n[i];
    }
    pod_model_swarms(&M, sw, ids, n, 5, "m0", NULL, 0);
}

// The demo's tabs followed by `extra` more, each a copy of one of them (same panes), so the grid has pages to scroll.
static void more_tabs(int extra)
{
    enum { MAXT = 24 };
    cable_swarm_t sw[MAXT];
    const char *const *ids[MAXT];
    uint8_t n[MAXT];
    static char names[MAXT][CABLE_NAME_MAX];
    int total = TABS + extra < MAXT ? TABS + extra : MAXT;
    memset(sw, 0, sizeof sw);
    for (int i = 0; i < total; i++) {
        int k = i % TABS;
        ids[i] = TAB_IDS[k]; n[i] = TAB_N[k];
        if (i < TABS) snprintf(names[i], CABLE_NAME_MAX, "%s", TAB_NAMES[i]); else snprintf(names[i], CABLE_NAME_MAX, "%s %d", TAB_NAMES[k], i / TABS + 1);
        snprintf(sw[i].id, SWARM_ID_MAX, "s%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", names[i]);
        sw[i].panes = sw[i].agents = TAB_N[k];
    }
    pod_model_swarms(&M, sw, ids, n, total, "s5", NULL, 0);
}

// Pets Home fixtures: tabs:seven (a middle tab of seven agents: four icons and "+3") and tabs:single (a middle tab of one agent), each between
// two other tabs so the neighbours peek in.
static void cover_tabs(bool seven)
{
    static const char *const seven_ids[] = {"fw", "ota", "be", "cli", "web", "desk", "docs"}, *const one_id[] = {"kilo"};
    static const char *const *ids[3];
    static const char *const names[] = {"Firmware", "Harness repo", "Notes"};
    static uint8_t n[3];
    cable_swarm_t sw[3];
    memset(sw, 0, sizeof sw);
    ids[0] = T_FW; n[0] = 2;
    ids[1] = seven ? seven_ids : one_id; n[1] = seven ? 7 : 1;
    ids[2] = T_NOTES; n[2] = 3;
    for (int i = 0; i < 3; i++) {
        snprintf(sw[i].id, SWARM_ID_MAX, "c%d", i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "%s", seven || i != 1 ? names[i] : "Solo");
        sw[i].panes = sw[i].agents = n[i];
    }
    pod_model_swarms(&M, sw, ids, n, 3, "c1", NULL, 0);
    pod_nav_act(&N, &M, POD_A_SCROLL, 1, T0);
}

static bool open_agent(const char *id)
{
    for (int t = 0; t < TABS; t++)
        for (int k = 0; k < TAB_N[t]; k++)
            if (!strcmp(TAB_IDS[t][k], id)) {
                pod_nav_act(&N, &M, POD_A_OPEN_TAB, t, T0);
                pod_nav_act(&N, &M, POD_A_OPEN_AGENT, k, T0);
                return true;
            }
    return false;
}

// --spec <out.json>: every run of the finished scene and every hit rect, for the design-spec export (dev only).
// Run kinds 1..5 are pro_canvas.c's private PRO_TEXT / PRO_RECT / PRO_IMAGE / PRO_RECT_AA / PRO_RECT_AA_STROKE; 16..19 are pod_draw.h's. Colours are RGB565
// (the scene's own) expanded to 8 bits per channel; build.py recovers the original hex from the C(0x...) sources.
static void json_str(FILE *f, const char *t)
{
    fputc('"', f);
    for (const unsigned char *p = (const unsigned char *)t; *p; p++) {
        if (*p == '"' || *p == '\\') fprintf(f, "\\%c", *p);
        else if (*p < 0x20) fprintf(f, "\\u%04x", *p);
        else fputc(*p, f);
    }
    fputc('"', f);
}
static void json_col(FILE *f, const char *key, unsigned v)
{
    fprintf(f, ",\"%s\":\"#%02x%02x%02x\",\"%s565\":%u", key, (v >> 11) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31, key, v);
}
static void write_spec(const char *path, const char *screen)
{
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); exit(1); }
    fprintf(f, "{\"screen\":"); json_str(f, screen);
    fprintf(f, ",\"width\":720,\"height\":720,\"runs\":[");
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        ht_rect_t b = ht_run_bounds(r);
        const char *kind = "unknown";
        switch (r->pro_kind) {
        case 1: kind = "text"; break; case 2: kind = "rect"; break; case 3: kind = "image"; break;
        case 4: kind = "rect-aa"; break; case 5: kind = "rect-aa-stroke"; break;
        case 16: kind = "pet-cell"; break; case 17: kind = "arc"; break; case 18: kind = "gradient"; break; case 19: kind = "triangle"; break;
        }
        fprintf(f, "%s{\"i\":%d,\"kind\":\"%s\",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d", i ? "," : "", i, kind, b.x, b.y, b.w, b.h);
        if (r->pro_kind == 1) {
            const ht_pro_font_t *ft = r->pro_font;
            int size = ft == &ht_pro_24 ? 24 : ft == &ht_pro_32 ? 32 : ft == &ht_pro_42 ? 42 : ft == &ht_pro_56 ? 56 : 0;
            fprintf(f, ",\"text\":"); json_str(f, r->text);
            fprintf(f, ",\"size\":%d,\"line_height\":%d,\"clip_w\":%d,\"measured_w\":%d,\"align\":\"left\"", size, ft ? ft->height : 0, r->w, ht_pro_width(ft, r->text));
            json_col(f, "color", r->fg);
        } else if (r->pro_kind == 2) {
            fprintf(f, ",\"radius\":%d", r->radius); json_col(f, "color", r->fg);
        } else if (r->pro_kind == 4) {   // anti-aliased rounded rect: radius and colour
            fprintf(f, ",\"radius\":%d", r->radius); json_col(f, "color", r->fg);
        } else if (r->pro_kind == 5) {   // anti-aliased rect with a border: radius, border colour (color), fill colour in text[0..1]
            uint16_t fill; memcpy(&fill, r->text, sizeof fill);
            fprintf(f, ",\"radius\":%d", r->radius); json_col(f, "color", r->fg); json_col(f, "fill", fill);
        } else if (r->pro_kind == 3) {
            fprintf(f, ",\"opacity\":%d", r->radius ? r->radius : 255);
        } else if (r->pro_kind == 16) {
            const ht_cell_frame_t *cf = r->bitmap.asset;
            fprintf(f, ",\"zoom8\":%d,\"cols\":%d,\"rows\":%d,\"cell\":%d", r->radius, cf->cols, cf->rows, cf->cell);
        } else if (r->pro_kind == 17) {
            int16_t a[2]; uint16_t u[2];   // arc_params_t: cx16 cy16 r16 w16 ...
            memcpy(a, r->text, 4); memcpy(u, r->text + 4, 4);
            fprintf(f, ",\"cx\":%.4f,\"cy\":%.4f,\"r\":%.4f,\"band\":%.4f", a[0] / 16.0, a[1] / 16.0, u[0] / 16.0, u[1] / 16.0);
            json_col(f, "color", r->fg);
        } else if (r->pro_kind == 18) {
            uint16_t g[2]; memcpy(g, r->text, 4);
            fprintf(f, ",\"radius\":%d", r->radius); json_col(f, "color", g[0]); json_col(f, "color2", g[1]);
        } else if (r->pro_kind == 19) {
            int16_t v[6]; memcpy(v, r->text, 12);
            fprintf(f, ",\"points\":[[%.4f,%.4f],[%.4f,%.4f],[%.4f,%.4f]]", v[0] / 16.0, v[1] / 16.0, v[2] / 16.0, v[3] / 16.0, v[4] / 16.0, v[5] / 16.0);
            json_col(f, "color", r->fg);
        }
        fputc('}', f);
    }
    static const char *const act[] = {"NONE", "BACK", "BANNER", "OPEN_TAB", "OPEN_AGENT", "PREV", "NEXT", "TALK", "RECAP", "PANES", "TABS", "INBOX", "OPEN_NOTIF", "FOLLOW", "SCROLL", "ENTER_TAB", "LEAD"};
    fprintf(f, "],\"hits\":[");
    for (int i = 0; i < F.hit_count; i++) {
        const pod_hit_t *h = &F.hits[i];
        fprintf(f, "%s{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"action\":\"%s\",\"arg\":%d,\"id\":", i ? "," : "", h->x, h->y, h->w, h->h,
                (unsigned)h->action < sizeof act / sizeof act[0] ? act[h->action] : "?", h->arg);
        json_str(f, h->id);
        fputc('}', f);
    }
    fprintf(f, "]}\n");
    fclose(f);
}

// What the glue adds after pod_render, once the entry is still unread: the toast over a room (not Home or Notices) of another agent.
static const char *s_toast_agent = "be";   // the entry the toast shows: "be", or "desk" for the stuck Super Tab toast
static void overlay(bool banner, bool toast, uint32_t now)
{
    const pod_unread_t *bn = pod_model_unread_find(&M, s_toast_agent);
    if (!bn) return;
    const pod_frame_t *top = N.depth ? &N.stack[N.depth - 1] : NULL;
    if ((banner || toast) && top && (top->view == POD_V_AGENT || top->view == POD_V_RECAP) && strcmp(top->agent, s_toast_agent)) ph_toast(&F, &M, bn, T0, now);
}

// A Super Tab ("Launch v2") question: the agent asks with that attention and the question's entry is filed, as pro_app does.
static void supertab_ask(const char *id, const char *name, const char *q, pod_attention_t attn)
{
    pod_model_question_tab(&M, id, q, "Launch v2", attn);
    pod_model_unread_ask(&M, id, name, q, T0);
}

// home:swarm:<p1|p2|stuck|done|many|remote>: Home on a Swarm card (the mockup swarm-card-v3.html A1 - A5, and a Swarm with Leads on other machines). The desk's first tab is linked to
// "openharness" (4 projects, one Lead each: p1 the first page, p2 the second; stuck: website is stuck; done: all four; many: 10 projects under a long name, 5 working); remote is a
// Swarm with no desk tab (its own page) whose Leads run on other people's machines.
static void swarm_fixture(const char *kind)
{
    static pod_swarm_t sw;
    static const char ids[2][ID_MAX] = {"sw1", "sw2"};
    struct { const char *id, *project, *engine, *owner, *local; pod_lead_state_t st; unsigned since; } mine[10] = {
        {"l1", "mobile", "muse", "", "h1", POD_LEAD_ASK, 0}, {"l2", "harness", "claude", "", "h2", POD_LEAD_WORK, 134},
        {"l3", "website", "codex", "", "h3", POD_LEAD_WORK, 48}, {"l4", "backend", "codex", "", "h4", POD_LEAD_DONE, 0},
        {"l5", "ios-app", "claude", "", "h5", POD_LEAD_WORK, 611}, {"l6", "docs", "codex", "", "h6", POD_LEAD_WORK, 25},
        {"l7", "api", "claude", "", "h7", POD_LEAD_WORK, 302}, {"l8", "desktop", "muse", "", "h8", POD_LEAD_DONE, 0},
        {"l9", "harness-os", "codex", "", "h9", POD_LEAD_WORK, 77}, {"l10", "grid", "claude", "", "h10", POD_LEAD_DONE, 0}},
      theirs[3] = {{"r1", "ops", "claude", "Linh Tran", "", POD_LEAD_WORK, 0}, {"r2", "billing-service", "codex", "Minh", "", POD_LEAD_STUCK, 0}, {"r3", "docs", "muse", "", "h5", POD_LEAD_DONE, 0}};
    const bool remote = !strcmp(kind, "remote"), many = !strcmp(kind, "many"), done = !strcmp(kind, "done"), stuck = !strcmp(kind, "stuck");
    const int n = many ? 10 : 4;
    pod_model_supertab_ids(&M, ids, remote ? 2 : 1);
    memset(&sw, 0, sizeof sw);
    snprintf(sw.id, ID_MAX, "sw1"); snprintf(sw.tab, ID_MAX, "%s", M.tabs[0].id); snprintf(sw.name, sizeof sw.name, "%s", many ? "openharness-launch-october" : "openharness");
    sw.count = n; sw.lead_n = n;
    if (stuck || many) mine[2].st = POD_LEAD_STUCK;   // website
    for (int i = 0; i < n; i++) {
        pod_lead_t *l = &sw.leads[i];
        snprintf(l->id, ID_MAX, "%s", mine[i].id); snprintf(l->project, sizeof l->project, "%s", mine[i].project); snprintf(l->engine, sizeof l->engine, "%s", mine[i].engine);
        snprintf(l->local, ID_MAX, "%s", mine[i].local); l->state = done ? POD_LEAD_DONE : mine[i].st; l->since_s = mine[i].since;
    }
    pod_model_supertab(&M, &sw, 0);
    if (remote) {
        memset(&sw, 0, sizeof sw);
        snprintf(sw.id, ID_MAX, "sw2"); snprintf(sw.name, sizeof sw.name, "Shared launch"); sw.count = 3; sw.lead_n = 3;
        for (int i = 0; i < 3; i++) {
            pod_lead_t *l = &sw.leads[i];
            snprintf(l->id, ID_MAX, "%s", theirs[i].id); snprintf(l->project, sizeof l->project, "%s", theirs[i].project); snprintf(l->engine, sizeof l->engine, "%s", theirs[i].engine);
            snprintf(l->owner, sizeof l->owner, "%s", theirs[i].owner); snprintf(l->local, ID_MAX, "%s", theirs[i].local); l->state = theirs[i].st;
        }
        pod_model_supertab(&M, &sw, 0);
        pod_nav_act(&N, &M, POD_A_SCROLL, M.tab_count, T0);   // the page after the tabs
    } else {
        pod_nav_act(&N, &M, POD_A_SCROLL, 0, T0);
        if (!strcmp(kind, "p2")) N.swarm_page = 1;
    }
}

// lead:<loaded|ask|loading|none|remote>: the Lead view over Home (the mockup swarm-card.html B1, B2, and the loading, no-message and remote-Lead states). loaded: the working
// "harness" Lead (B1); ask: "mobile", which needs you (B2, the orange edge); loading: "website" before its message came; none: "backend", which has said nothing; remote:
// a Lead on another person's machine (its owner shown, no talk).
static void lead_fixture(const char *kind)
{
    const bool remote = !strcmp(kind, "remote");
    swarm_fixture(remote ? "remote" : "p1");
    const pod_swarm_t *sw = pod_model_swarm(&M, remote ? "sw2" : "sw1");
    const int at = remote ? 0 : !strcmp(kind, "loaded") ? 1 : !strcmp(kind, "ask") ? 0 : !strcmp(kind, "loading") ? 2 : 3;
    if (!pod_nav_open_lead(&N, &M, sw->id, at)) { fprintf(stderr, "lead:%s: the Lead view did not open\n", kind); exit(2); }
    const char *id = sw->leads[at].id;
    if (!strcmp(kind, "loaded")) asked_recap(&M, sw->id, id, "PR #1492 is merged and backend 1.2.100 is on production. The Pro took the test flash. Next: waiting for you to try it on the device.", 1792560000u, false);
    else if (!strcmp(kind, "ask")) asked_recap(&M, sw->id, id, "iOS 1.0.9 finished building. Do you want it on TestFlight now, or wait for the Android banner fix?", 1792560000u, false);
    else if (remote) asked_recap(&M, sw->id, id, "Staging is up on the new region. I am moving the queue workers over now; the first batch should land within the hour.", 1792560000u, false);
    else if (!strcmp(kind, "loading")) pod_model_supertab_loading(&M, sw->id, id);
    else asked_recap(&M, sw->id, id, NULL, 0, true);
}

int main(int argc, char **argv)
{
    const char *spec = NULL;
    for (int i = 1; i + 1 < argc; i++)
        if (!strcmp(argv[i], "--spec")) { spec = argv[i + 1]; memmove(argv + i, argv + i + 2, (size_t)(argc - i - 2) * sizeof *argv); argc -= 2; break; }
    for (int i = 1; i + 1 < argc; i++)   // --skin <name>: accepted and ignored (Pets is the only interface)
        if (!strcmp(argv[i], "--skin")) { memmove(argv + i, argv + i + 2, (size_t)(argc - i - 2) * sizeof *argv); argc -= 2; break; }
    bool notice = false, notice_bad = false;
    const char *notice_text = "Didn't catch that";
    int ota_pct = -1;   // ota:<pct> | ota:restart (the update screen, the mockup's 0.1.2 -> 0.1.3); restart is -2
    if (argc < 3) { fprintf(stderr, "usage: pod_render [--spec out.json] <screen> <out.ppm> [now_ms]\n"); return 2; }
    const char *screen = argv[1];
    if (!strcmp(screen, "talk:listen")) screen = "talk:fw";          // Talk, listening / sending (talk:<id>[:send] for any agent)
    else if (!strcmp(screen, "talk:send")) screen = "talk:fw:send";
    bool timing = !strncmp(screen, "time:", 5);   // time:<screen>: rasterise the screen 50 times, print the mean us per full frame
    if (timing) screen += 5;
    uint32_t now = argc > 3 ? (uint32_t)strtoul(argv[3], NULL, 10) : T0;
    const bool toast = strstr(screen, "toast") != NULL;   // <agent|recap>:<id>:toast[@<ms after it showed>], the notice toast over that room (shown at T0)
    if (toast && strchr(screen, '@')) now = T0 + (uint32_t)atoi(strchr(screen, '@') + 1);
    demo();
    bool banner = strstr(screen, "banner") != NULL, bell = banner || toast || strstr(screen, "bell") != NULL || !strcmp(screen, "tabs:notices"), inbox = !strncmp(screen, "inbox", 5);
    if ((!strncmp(screen, "agent:", 6) || !strncmp(screen, "recap:", 6) || !strncmp(screen, "talk:", 5) || !strncmp(screen, "inbox", 5)))
        console_fixture(screen);   // only the screens that read it: the older Pets goldens keep their model
    if ((bell || inbox) && !strstr(screen, "quiet")) {   // unread entries, oldest first (the newest ends on top); "be" is the one the banner shows
        pod_model_unread_add(&M, "cur", "api-client", "Bumped the SDK and regenerated the client. Nothing else changed.", 41, T0 - 3600000u);
        pod_model_unread_add(&M, "vault", "obsidian-vault", "Added two more poems to Poems and Themes.md", 12, T0 - 720000u);
        pod_model_unread_add(&M, "ota", "dial-ota", "Built and flashed the dial with the new face. The OTA channel is untouched.", 301, T0 - 180000u);
        pod_model_unread_add(&M, "be", "backend", "Fixed the cable resync. Tests pass on the host and the device, and the frame time is back under 45 ms.", 134, T0 - 2000u);
    }
    if (inbox && strstr(screen, "viet")) {   // Vietnamese texts on the rows
        snprintf(((pod_unread_t *)pod_model_unread_find(&M, "be"))->text, POD_UNREAD_TEXT, "Đã sửa lỗi đồng bộ cáp. Mọi bài kiểm thử đều xanh trên máy chủ và thiết bị.");
        snprintf(((pod_unread_t *)pod_model_unread_find(&M, "ota"))->text, POD_UNREAD_TEXT, "Đã nạp mặt mới cho núm xoay, kênh cập nhật không đổi và mọi thứ vẫn chạy ổn định như trước đó.");
    }
    if (toast && strstr(screen, ":decision")) supertab_ask("be", "backend", "Run the migration on staging first, or straight to prod?", POD_ATTN_DECISION);
    if (toast && strstr(screen, ":stuck")) {
        s_toast_agent = "desk";
        supertab_ask("desk", "desktop", "Stuck: e2e failed 3 times, no write access to staging", POD_ATTN_STUCK);
    }
    if (inbox && strstr(screen, "supertab")) {   // the mockup's A3: a decision, a stuck agent, then the newest plain entry (ota's is read)
        pod_model_question_close(&M, "cli");
        pod_model_unread_seen(&M, "ota", NULL);
        supertab_ask("be", "backend", "Run the migration on staging first, or straight to prod?", POD_ATTN_DECISION);
        supertab_ask("desk", "desktop", "e2e failed 3 times, no write access to staging", POD_ATTN_STUCK);
    }
    if (inbox) pod_nav_act(&N, &M, POD_A_INBOX, 0, T0);
    else if (!strcmp(screen, "tabs:notices")) {   // Home on the Notices card (the entries are added above; the asking agent counts too)
        pod_nav_act(&N, &M, POD_A_SCROLL, POD_HOME_NOTICES, T0);
    } else if (!strncmp(screen, "tabs:working", 12)) {   // Home on the Working card (fw, be, web, cur work: three pets on page 0); :codex has be, web (Muse), site (Codex) work
        if (strstr(screen, ":codex")) {
            static const char *const off[] = {"fw", "ota", "cur"};
            for (int i = 0; i < 3; i++) pod_model_turn(&M, off[i], "done", NULL, 0, T0);
            pod_model_turn(&M, "site", "activity", "Building the landing page", 20, T0);
        }
        pod_nav_act(&N, &M, POD_A_SCROLL, POD_HOME_WORKING, T0);
    } else if (!strncmp(screen, "home:swarm:", 11)) {
        swarm_fixture(screen + 11);
    } else if (!strncmp(screen, "lead:", 5)) {
        lead_fixture(screen + 5);
    } else if (!strcmp(screen, "tabs:9")) more_tabs(3);   // nine tabs: more than one page
    else if (!strcmp(screen, "tabs:seven") || !strcmp(screen, "tabs:single")) cover_tabs(!strcmp(screen, "tabs:seven"));
    else if (!strcmp(screen, "tabs:none")) { static const char *const *no_ids[1]; static const uint8_t no_n[1]; pod_model_swarms(&M, NULL, no_ids, no_n, 0, "", NULL, 0); pod_model_question_close(&M, "cli"); for (unsigned i = 0; i < sizeof AGENTS / sizeof AGENTS[0]; i++) pod_model_turn(&M, AGENTS[i].id, "done", NULL, 0, T0); }   // the first screen: no tabs, nobody working (else the Working card)
    else if (!strcmp(screen, "tabs:long")) snprintf(M.tabs[0].name, CABLE_NAME_MAX, "%.*s", CABLE_NAME_MAX - 1, "marketing-site-redesign-with-a-long-name");   // Home: a name as long as the model keeps one
    else if (!strncmp(screen, "tabs", 4)) {   // tabs, or tabs:<n>: Home on tab n
        if (screen[4] == ':' && !strcmp(screen + 5, "mock")) mock_tabs();
        else if (screen[4] == ':') {
            const char *plus = strchr(screen, '+');   // tabs:<rows>+<n>: n more tabs
            if (plus) more_tabs(atoi(plus + 1));
            pod_nav_act(&N, &M, POD_A_SCROLL, atoi(screen + 5), T0);   // the tab
        }
    } else if (!strncmp(screen, "agent:", 6) || !strncmp(screen, "recap:", 6) || !strncmp(screen, "talk:", 5)) {
        char idbuf[32];
        snprintf(idbuf, sizeof idbuf, "%s", strchr(screen, ':') + 1);
        char *suffix = strchr(idbuf, ':');   // talk:<id>:send (the sending state, started 1 s after the talk) | agent:<id>:notice | agent:<id>:updated | agent:<id>:failed
        if (suffix) *suffix++ = 0;
        const char *id = idbuf;
        if (!open_agent(id)) { fprintf(stderr, "no such agent: %s\n", id); return 2; }
        if (screen[0] == 'a' && N.stack[N.depth - 1].view != POD_V_AGENT) pod_nav_act(&N, &M, POD_A_RECAP, 0, T0);
        if (screen[0] == 'r' && N.stack[N.depth - 1].view != POD_V_RECAP) pod_nav_act(&N, &M, POD_A_RECAP, 0, T0);
        if (screen[0] == 't') pod_nav_act(&N, &M, POD_A_TALK, 0, T0);
        if (screen[0] == 't' && suffix && !strcmp(suffix, "send")) pod_nav_act(&N, &M, POD_A_TALK, 0, T0 + 1000);
        if (suffix && !strncmp(suffix, "unread", 6)) {   // the Pets room: an unread FINISHED entry (unread) or FAILED one (unreadfail), added after the open that would read it
            const pod_agent_t *ua = pod_model_find(&M, id);
            pod_model_unread_add(&M, id, ua ? ua->name : id, ua && ua->recap_lines ? ua->recap : "Fixed the checkout test. Nothing else changed.", 41, T0 - 2000u);
            if (!strcmp(suffix, "unreadfail")) ((pod_unread_t *)pod_model_unread_find(&M, id))->kind = POD_UNREAD_FAILED;
        }
        if (suffix && !strcmp(suffix, "long")) pod_model_recap(&M, id, "I went through the whole checkout flow and fixed the failing test first, then tidied the fixtures, renamed two helpers, rewrote the retry loop so it backs off properly, added a regression test for the double charge, updated the docs and the changelog, and re-ran the full suite twice to be sure nothing else moved. Everything is green now and the branch is ready for review whenever you are.", false);
        if (suffix && !strcmp(suffix, "ask")) pod_model_question(&M, id, "Run the migration on the dev database now?");   // agent:<id>:ask, any agent asking (fw is Claude, web is Muse; cli asks already)
        if (suffix && !strcmp(suffix, "short")) pod_model_recap(&M, id, "All green.", false);
        if (suffix && !strcmp(suffix, "medium")) pod_model_recap(&M, id, "Fixed the checkout test and tidied the fixtures. I also renamed two helpers.", false);
        if (suffix && !strcmp(suffix, "viet")) pod_model_recap(&M, id, "Tôi đã sửa lỗi thanh toán ở bước cuối, chỉnh lại vòng lặp thử lại và thêm kiểm thử cho trường hợp trụ hai lần. Tệp chính nằm ở /Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness/devices/harness-pro/firmware/main/pod/home/ph_recap.c. Mọi thứ đều xanh, nhánh này sẵn sàng để xem lại khi bạn rảnh. Cứ gọi tôi nếu cần thêm gì nữa.", false);
        if (suffix && !strcmp(suffix, "scroll")) N.stack[N.depth - 1].scroll = 3;
        if (suffix && !strcmp(suffix, "notice")) notice = true;
        if (suffix && (!strcmp(suffix, "updated") || !strcmp(suffix, "failed"))) {   // agent:<id>:updated|failed, the OTA pills
            notice = true;
            notice_bad = !strcmp(suffix, "failed");
            notice_text = notice_bad ? "Update failed \xc2\xb7 trying again later" : "Updated to 0.1.3";
        }
    } else if (!strncmp(screen, "ota:", 4)) {
        ota_pct = !strcmp(screen + 4, "restart") ? -2 : atoi(screen + 4);
    } else if (!strncmp(screen, "notice:", 7)) {   // the Tabs screen with the glue's pill: notice:updated | notice:failed
        notice = true;
        notice_bad = !strcmp(screen + 7, "failed");
        notice_text = !strcmp(screen + 7, "updated") ? "Updated to 0.1.3" : "Update failed \xc2\xb7 trying again later";
    } else {
        fprintf(stderr, "unknown screen: %s\n", screen);
        return 2;
    }
    ht_scene_clear(&S, ht_rgb(0xffffffu));
    F.scene = &S;
    if (strstr(screen, "linkdown")) pod_model_link(&M, false);   // e.g. tabs:linkdown
    F.banner = banner;
    F.mic_level = strstr(screen, "quiet") ? 0 : 3;
    if (ota_pct != -1) {
        ph_view_ota(&F, "0.1.1", "0.1.2", ota_pct < 0 ? 100 : ota_pct, ota_pct == -2);
    } else {
        pod_render(&F, &N, &M, now);
    }
    overlay(banner, toast, now);   // the glue draws it after pod_render, and only while the entry is unread (pod_glue.c)
    if (notice) {   // the glue's pill (pod_glue.c pod_ui_render), repeated here: this tool does not link the glue
        const char *text = notice_text;
        const ht_pro_font_t *font = &ht_pro_24;
        int w = ht_pro_width(font, text);
        if (w > 600) w = 600;
        int pw = w + 40, ny = POD_TRANSPORT_Y - 8 - 40;
        const uint16_t bg = ht_rgb(notice_bad ? 0xb3261e : 0x111111);
        ht_pro_rect(&S, (POD_W - pw) / 2, ny, pw, 40, 20, bg);
        ht_pro_text(&S, (POD_W - w) / 2, ny + 7, w, font, ht_rgb(0xffffff), text);
    }
    if (spec) write_spec(spec, screen);
    static uint16_t px[720 * 720];
    ht_rect_t all = {0, 0, 720, 720};
    if (timing) {
        enum { REPS = 50 };
        struct timespec a, b;
        double build = 0, raster = 0;
        for (int i = 0; i < REPS; i++) {
            clock_gettime(CLOCK_MONOTONIC, &a);
            ht_scene_clear(&S, ht_rgb(0xffffffu));
            pod_render(&F, &N, &M, now);
            overlay(banner, toast, now);   // the glue draws it after pod_render: time it too
            clock_gettime(CLOCK_MONOTONIC, &b);
            build += (double)(b.tv_sec - a.tv_sec) * 1e6 + (double)(b.tv_nsec - a.tv_nsec) / 1e3;
            clock_gettime(CLOCK_MONOTONIC, &a);
            ht_raster(&S, all, px);
            clock_gettime(CLOCK_MONOTONIC, &b);
            raster += (double)(b.tv_sec - a.tv_sec) * 1e6 + (double)(b.tv_nsec - a.tv_nsec) / 1e3;
        }
        // The device rasterises in 24-row strips (pro_frame.c): the number the Pets perf check (test_ph_perf.sh) compares.
        double strips = 1e30;
        for (int rep = 0; rep < REPS; rep++) {
            clock_gettime(CLOCK_MONOTONIC, &a);
            for (int y = 0; y < 720; y += 24) { ht_rect_t st = {0, (int16_t)y, 720, 24}; ht_raster(&S, st, px); }
            clock_gettime(CLOCK_MONOTONIC, &b);
            double us = (double)(b.tv_sec - a.tv_sec) * 1e6 + (double)(b.tv_nsec - a.tv_nsec) / 1e3;
            if (us < strips) strips = us;
        }
        printf("%s: %d runs; mean per full frame over %d: %.0f us rasterise, %.0f us build the scene; strips24 best %.0f us\n", screen, S.count, REPS,
               raster / REPS, build / REPS, strips);
        return 0;
    }
    ht_raster(&S, all, px);
    FILE *f = fopen(argv[2], "wb");
    if (!f) { perror(argv[2]); return 1; }
    fprintf(f, "P6\n720 720\n255\n");
    for (int i = 0; i < 720 * 720; i++) {
        unsigned v = px[i];
        unsigned char rgb[3] = {(unsigned char)((v >> 11) * 255 / 31), (unsigned char)(((v >> 5) & 63) * 255 / 63),
                                (unsigned char)((v & 31) * 255 / 31)};
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    printf("%s: %d runs, %d hits\n", screen, S.count, F.hit_count);
    return 0;
}
