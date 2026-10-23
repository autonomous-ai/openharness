// Pets views and chrome (ph_*.c): the Update bar, Home's equaliser, every screen's layout and the run counter.
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pod/pod_nav.h"
#include "pod/pod_view_shared.h"
#include "pro_canvas.h"

// A recap only lands on a Lead that was asked for (LOADING), as the Lead view does: the fixtures ask first.
static void asked_recap(pod_model_t *m, const char *tab, const char *lead, const char *text, uint32_t at, bool none)
{
    pod_model_supertab_loading(m, tab, lead);
    pod_model_supertab_recap(m, tab, lead, text, at, none);
}

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); abort(); } checks++; } while (0)
enum { K_TEXT = 1, K_RECT = 2, K_IMAGE = 3, K_RECT_AA = 4, K_RECT_STROKE = 5 };

static ht_scene_t S;
static pod_out_frame_t F;
static void fresh(void) { memset(&F, 0, sizeof F); ht_scene_clear(&S, ht_rgb(PH_GROUND)); F.scene = &S; }
static const ht_run_t *text_run(const char *t) {
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, t)) return &S.runs[i];
    return NULL;
}
static const ht_run_t *text_prefix(const char *p) { for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, p, strlen(p))) return &S.runs[i]; return NULL; }
static const pod_hit_t *nth_hit(pod_action_t a, int n) { for (int i = 0; i < F.hit_count; i++) if (F.hits[i].action == a && n-- == 0) return &F.hits[i]; return NULL; }
static int hits_of(pod_action_t a) { int n = 0; for (int i = 0; i < F.hit_count; i++) n += F.hits[i].action == a; return n; }

// The scene in S, rastered from empty: every below-1x frame marked for baking (a Codex face or recap pet) got its arena entry (none dropped for want of
// room: a dropped one is resampled every frame), and the arena use is exactly those entries' pixels, within BAKE_ARENA_PX (360 K, pod_draw.c).
static void check_baked(void)
{
    static uint16_t shot[720 * 720];
    pod_cell_bake_reset();
    ht_raster(&S, (ht_rect_t){0, 0, 720, 720}, shot);
    unsigned flat = 0, px = 0;
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != POD_CELL || r->text[0] != 1) continue;
        bool again = false;
        for (int j = 0; j < i; j++) {
            const ht_run_t *o = &S.runs[j];
            again |= o->pro_kind == POD_CELL && o->text[0] == 1 && o->bitmap.asset == r->bitmap.asset && o->w == r->w && o->pro_height == r->pro_height &&
                     o->radius == r->radius && o->text[1] == r->text[1] && o->fg == r->fg;
        }
        if (!again) { flat++; px += (unsigned)r->w * (unsigned)r->pro_height; }
    }
    CHECK(flat > 0 && pod_cell_bakes() == flat && pod_cell_bake_px() == px && px <= 360u * 1024u);
}

// Page dots (a small anti-aliased pill in the bottom band, y >= 660): Pets has none on any page.
static int dot_runs(void) { int n = 0; for (int i = 0; i < S.count; i++) n += S.runs[i].pro_kind == K_RECT_AA && (S.runs[i].w == 12 || S.runs[i].w == 11 || S.runs[i].w == 32) && S.runs[i].pro_height <= 12 && S.runs[i].y >= 660; return n; }
// The run holding the name/title: centred on x 360 within 2 px.
static bool centred_run(const ht_run_t *r) { return r && r->x + r->w / 2 >= 360 - 2 && r->x + r->w / 2 <= 360 + 2; }

int main(void) {
    {   // Home's equaliser: four 8 px bars 5 px apart, anchored at the bottom of a 36 px box, 40..100 % tall, moving with the clock
        int hmin = 99, hmax = 0;
        for (uint32_t t = 0; t < 1800; t += 30) {
            fresh();
            ph_working_mark_big(&S, 100, 200, t);
            CHECK(S.count == 4);
            for (int i = 0; i < 4; i++) {
                const ht_run_t *r = &S.runs[i];
                CHECK(r->pro_kind == K_RECT && r->w == 8 && r->x == 100 + i * 13 && r->fg == ht_rgb(PH_ROOM_GREEN));
                CHECK(r->y + r->pro_height == 236 && r->pro_height >= 14 && r->pro_height <= 36);
                if (r->pro_height < hmin) hmin = r->pro_height;
                if (r->pro_height > hmax) hmax = r->pro_height;
            }
        }
        CHECK(hmin >= 14 && hmin <= 15 && hmax >= 35);
        fresh(); ph_working_mark_big(&S, 0, 0, 0);
        int h0[4]; for (int i = 0; i < 4; i++) h0[i] = S.runs[i].pro_height;
        fresh(); ph_working_mark_big(&S, 0, 0, 450);
        int moved = 0; for (int i = 0; i < 4; i++) moved += S.runs[i].pro_height != h0[i];
        CHECK(moved >= 3);
    }
    CHECK(ph_runs(&F) == S.count);

    // ---- Home cover cards (the owner's mockup): gradient per main engine, name, count, pills, engine icons, neighbours ----
    {
        enum { K_IMAGE = 3 };
        static pod_model_t M;
        static pod_nav_t N;
        static cable_swarm_t sw[POD_TABS_MAX];
        static const char *const *lists[POD_TABS_MAX];
        static uint8_t counts[POD_TABS_MAX];
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        static const char *const eng[8] = {"codex", "codex", "claude", "claude", "muse", "gemini", "kilo", "cursor"};
        static const char *const aid[8] = {"x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8"};
        for (int i = 0; i < 8; i++) pod_model_agent(&M, aid[i], aid[i], eng[i], "Mac");
        pod_model_agents_end(&M);
        memset(sw, 0, sizeof sw);
        // 0 codex (x1 x2 work, x3 idle); 1 claude, all done; 2 tie muse/claude -> muse (pane order); 3 one gemini; 4 seven agents (+3); 5 x8 asks; 6 kilo
        static const char *const l0[] = {"x1", "x2", "x3"}, *const l1[] = {"x3", "x4"}, *const l2[] = {"x5", "x3"}, *const l3[] = {"x6"},
                                 *const l4[] = {"x1", "x2", "x3", "x4", "x5", "x6", "x7"}, *const l5[] = {"x8"}, *const l6[] = {"x7"};
        const char *const *ls[] = {l0, l1, l2, l3, l4, l5, l6};
        const uint8_t cn[] = {3, 2, 2, 1, 7, 1, 1};
        const char *const nm[] = {"Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"};
        for (int i = 0; i < 7; i++) { snprintf(sw[i].id, SWARM_ID_MAX, "w%d", i); snprintf(sw[i].name, CABLE_NAME_MAX, "%s", nm[i]); sw[i].panes = sw[i].agents = cn[i]; lists[i] = ls[i]; counts[i] = cn[i]; }
        pod_model_swarms(&M, sw, lists, counts, 7, "w0", NULL, 0);
        pod_model_link(&M, true);
        const uint32_t now = 100000u;
        pod_model_turn(&M, "x1", "started", NULL, 0, now);   // x1, x2 work
        pod_model_turn(&M, "x2", "started", NULL, 0, now);
        pod_model_question(&M, "x8", "ok?");                 // x8 asks
        pod_model_clock(&M, now);
        pod_nav_init(&N);
        CHECK(pod_tabs_pages_of(&N, &M) == 9);   // seven tabs, the Notices card (x8 asks) and the Working card (x1, x2)
        static const unsigned want[7][2] = {{PH_TINT_CODEX1, PH_TINT_CODEX2}, {PH_TINT_CLAUDE1, PH_TINT_CLAUDE2}, {PH_TINT_MUSE1, PH_TINT_MUSE2},
                                            {PH_TINT_OTHER1, PH_TINT_OTHER2}, {PH_TINT_CODEX1, PH_TINT_CODEX2}, {PH_TINT_OTHER1, PH_TINT_OTHER2},
                                            {PH_TINT_KILO1, PH_TINT_KILO2}};
        for (int t = 0; t < 7; t++) {
            N.stack[0].scroll = t;
            fresh();
            ph_view_home(&F, &N, &M, now);
            CHECK(S.background == ht_rgb(PH_HOME_BG));
            int cards = 0, grads = 0, icons = 0, dots11 = 0;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                if (r->pro_kind == POD_GRAD) {
                    grads++;
                    uint16_t g[2];
                    memcpy(g, r->text, sizeof g);
                    if (r->w == 540) {
                        CHECK(r->x == 90 && r->y == 56 && r->pro_height == 560 && r->radius == 48);
                        CHECK(g[0] == ht_rgb(want[t][0]) && g[1] == ht_rgb(want[t][1]));
                        cards++;
                    } else {   // a neighbour: 86 %, ~500 px away, faded 45 % toward the ground
                        CHECK(r->w == 464 && r->pro_height == 481 && (r->x == 628 || r->x == -372));
                        CHECK(g[0] != ht_rgb(want[t][0]));
                    }
                }
                icons += r->pro_kind == K_IMAGE;
                dots11 += r->pro_kind == K_RECT_AA && r->pro_height == 11 && r->y >= 660;
            }
            CHECK(cards == 1 && grads == 2 + (t < 6));   // the neighbours peek: a tab's left one is always a gradient card (tab 0's is the Working card, behind the Notices letter)
            CHECK(dots11 == 0 && dot_runs() == 0);                  // no page dots
            CHECK(hits_of(POD_A_ENTER_TAB) == 1 && F.hit_count == 1);
            const pod_hit_t *h = nth_hit(POD_A_ENTER_TAB, 0);
            CHECK(h->arg == t && h->x == 90 && h->y == 56 && h->w == 540 && h->h == 560 && !strcmp(h->id, sw[t].id));
            const int shown = cn[t] > 5 ? 4 : cn[t];
            CHECK(icons <= shown);   // engine logos (an engine without one draws the >_ outline instead)
            CHECK(ph_runs(&F) <= HT_RUNS);
            // inside the glass
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].x >= 90 && S.runs[i].x < 630) CHECK(S.runs[i].x + S.runs[i].w <= 630);
            printf("runs home-tab%d %d\n", t, ph_runs(&F));
        }
        // tab 0: the name at (134, ~96), the count 3 in ph_num_230 at x 128, "agents" 16 px right of it, pills, icons
        N.stack[0].scroll = 0; fresh(); ph_view_home(&F, &N, &M, now);
        {
            const ht_run_t *nm0 = text_run("Alpha"), *num = text_run("3"), *lab = text_run("agents"), *wk = text_run("2 working");
            CHECK(nm0 && num && lab && wk && nm0->pro_font == &ph_sb_48 && nm0->x == 134 && nm0->fg == ht_rgb(PH_CARD_INK));
            CHECK(num->pro_font == &ph_num_230 && num->x == 128 && num->y == 56 + 61 && lab->pro_font == &ph_sb_26 && lab->x == 128 + ht_pro_width(&ph_num_230, "3") + 16);
            CHECK(wk->pro_font == &ph_sb_22 && wk->fg == ht_rgb(PH_PILL_WORK) && wk->y > 56 + 345 && wk->y < 56 + 345 + 46);
            CHECK(!text_run("\xe2\x9c\x93 All done") && !text_prefix("0 asking"));
            int pills = 0, bars = 0, ico = 0;
            for (int i = 0; i < S.count; i++) {
                pills += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].pro_height == 46 && S.runs[i].radius == 23;
                bars += S.runs[i].pro_kind == K_RECT && S.runs[i].w == 5 && S.runs[i].fg == ht_rgb(PH_PILL_WORK);
                ico += (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 12 && S.runs[i].pro_height == 12) ? 1 : 0;   // the state dots
            }
            CHECK(pills == 1 && bars == 4 && ico == 3);   // one pill (working), the 4-bar equaliser, one dot per agent
            // the equaliser moves with the clock; the wake is the 66 ms beat
            int h0[4], k = 0, moved = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].w == 5) h0[k++] = S.runs[i].pro_height;
            fresh(); ph_view_home(&F, &N, &M, now + 450);
            k = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].w == 5) moved += S.runs[i].pro_height != h0[k++];
            CHECK(moved >= 3);
            CHECK(ph_home_moves(&N, &M) && pod_view_next_ms(&N, &M, now) <= POD_PH_ANIM_MS && pod_view_next_ms(&N, &M, now) >= 1);
        }
        // tab 1: nobody works or asks: "All done", a still screen
        N.stack[0].scroll = 1; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("\xe2\x9c\x93 All done") && text_run("2") && text_run("agents") && !text_prefix("0 working"));
        for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != K_TEXT || (!strstr(S.runs[i].text, "working") && !strstr(S.runs[i].text, "asking")));
        CHECK(!ph_home_moves(&N, &M) && pod_view_next_ms(&N, &M, now) == 1000);
        // tab 4: seven agents show four icons and "+3"; two working (x1 x2) and no asking
        N.stack[0].scroll = 4; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("+3") && text_run("+3")->pro_font == &ph_sb_32 && text_run("7") && text_run("2 working"));
        { int dots12 = 0; for (int i = 0; i < S.count; i++) dots12 += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 12 && S.runs[i].pro_height == 12; CHECK(dots12 == 4); }
        // tab 5: one asking agent: "1 asking" in its tint, a pulsing dot, the single "agent"
        N.stack[0].scroll = 5; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("1 asking") && text_run("1 asking")->fg == ht_rgb(PH_PILL_ASK) && text_run("agent") && !text_run("agents") && text_run("1") && !text_run("\xe2\x9c\x93 All done"));
        CHECK(ph_home_moves(&N, &M) && pod_view_next_ms(&N, &M, now) <= POD_PH_ANIM_MS);
        // tab 3: a single gemini agent
        N.stack[0].scroll = 3; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("agent") && text_run("1") && text_run("\xe2\x9c\x93 All done") && hits_of(POD_A_ENTER_TAB) == 1);
        // a page past the end is the last
        N.stack[0].scroll = 99; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("Golf"));
        // a tab with no agents: "0 agents", nothing to tap into
        {
            static const uint8_t zero[1] = {0};
            cable_swarm_t e0[1];
            memset(e0, 0, sizeof e0);
            snprintf(e0[0].id, SWARM_ID_MAX, "z"); snprintf(e0[0].name, CABLE_NAME_MAX, "empty-one"); e0[0].agents = 1;
            pod_model_swarms(&M, e0, NULL, zero, 1, "z", NULL, 0);
            N.stack[0].scroll = 0; fresh(); ph_view_home(&F, &N, &M, now);
            CHECK(text_run("empty-one") && text_run("0") && text_run("agents") && hits_of(POD_A_ENTER_TAB) == 0 && F.hit_count == 0);
        }
        // names: one line, cut with an ellipsis inside the card; a character the 48 px face lacks falls to the 34 px face; empty is Untitled
        {
            cable_swarm_t e1[1];
            memset(e1, 0, sizeof e1);
            snprintf(e1[0].id, SWARM_ID_MAX, "l"); e1[0].panes = e1[0].agents = 1;
            const char *const one[] = {"x1"}, *const *ol[1] = {one};
            uint8_t c1[1] = {1};
            char longname[CABLE_NAME_MAX];
            memset(longname, 'm', sizeof longname - 1); longname[sizeof longname - 1] = 0;   // 39 characters, one word
            snprintf(e1[0].name, CABLE_NAME_MAX, "%s", longname);
            pod_model_swarms(&M, e1, ol, c1, 1, "l", NULL, 0);
            fresh(); ph_view_home(&F, &N, &M, now);
            const ht_run_t *r = NULL;
            int rows = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_sb_48) { r = &S.runs[i]; rows++; }
            CHECK(rows == 1 && r && !strcmp(r->text + strlen(r->text) - 3, "\xe2\x80\xa6") && strlen(r->text) < sizeof longname - 1);
            CHECK(ht_pro_width(r->pro_font, r->text) <= 452 && r->w <= 452 && r->x == 134);
            snprintf(e1[0].name, CABLE_NAME_MAX, "alpha beta gamma delta epsilon zeta eta");   // spaces do not wrap: still one line, cut
            pod_model_swarms(&M, e1, ol, c1, 1, "l", NULL, 0);
            fresh(); ph_view_home(&F, &N, &M, now);
            rows = 0;
            for (int i = 0; i < S.count; i++) rows += S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_sb_48;
            CHECK(rows == 1);
            snprintf(e1[0].name, CABLE_NAME_MAX, "D\xe1\xbb\xb1 \xc3\xa1n & co");
            pod_model_swarms(&M, e1, ol, c1, 1, "l", NULL, 0);
            fresh(); ph_view_home(&F, &N, &M, now);
            CHECK(text_run("D\xe1\xbb\xb1 \xc3\xa1n & co") && text_run("D\xe1\xbb\xb1 \xc3\xa1n & co")->pro_font == &ph_sb_34);
            e1[0].name[0] = 0;
            pod_model_swarms(&M, e1, ol, c1, 1, "l", NULL, 0);
            fresh(); ph_view_home(&F, &N, &M, now);
            CHECK(text_run("Untitled") && hits_of(POD_A_ENTER_TAB) == 1);
        }
        // no tabs at all: with a notice (x8 asks) the Notices card alone, else the "Harness" wordmark
        pod_model_swarms(&M, sw, lists, counts, 0, "", NULL, 0);
        pod_model_turn(&M, "x1", "done", NULL, 0, now); pod_model_turn(&M, "x2", "done", NULL, 0, now);   // nobody works: no Working card
        N.stack[0].scroll = 0; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("Notices") && text_run("1") && text_run("Tap to read") && hits_of(POD_A_INBOX) == 1 && F.hit_count == 1 && pod_tabs_pages_of(&N, &M) == 1);
        pod_model_question_close(&M, "x8");
        pod_model_turn(&M, "x8", "done", NULL, 0, now);
        fresh(); ph_view_home(&F, &N, &M, now);
        {   // the first screen: "Harness" as seven letter runs in Inter Bold 84 (the only text), centred on x 360 within 2 px, baseline 373,
            // on the navy ground, a 200x6 track at (260, 430) with a clipped pill, no hits; the light sweeps left to right
            static const char *const L[] = {"H", "a", "r", "n", "e", "s", "s"};
            CHECK(ph_home_moves(&N, &M) && ph_home_brand(&N, &M) && ph_home_next_ms(&N, &M, now) <= POD_PH_ANIM_MS);
            int left = 0, right = 0, bright_at[3] = {0};
            const uint32_t times[3] = {600, 800, 1000};   // the band centre at 0.25, 0.5 and 0.75 word widths of the 2.4 s sweep (-0.5 .. 2.5)
            for (int ti = 0; ti < 3; ti++) {
                fresh(); ph_view_home(&F, &N, &M, times[ti]);
                int texts = 0, order = 0; for (int i = 0; i < S.count; i++) texts += S.runs[i].pro_kind == K_TEXT;
                CHECK(texts == 7 && S.background == ht_rgb(0x0E1B2C) && F.hit_count == 0 && dot_runs() == 0 && !text_run("Notices") && !text_run("No tabs yet"));
                int best = -1; unsigned bestr = 31;   // the letter nearest the highlight: the lowest red channel (ink F2 -> 30, highlight 9C -> 19)
                for (int i = 0; i < S.count; i++) {
                    if (S.runs[i].pro_kind != K_TEXT) continue;
                    CHECK(!strcmp(S.runs[i].text, L[order]) && S.runs[i].pro_font == &ph_bd_84);
                    CHECK(S.runs[i].y == 373 - ph_bd_84.height * 8 / 11);
                    if (!order) left = S.runs[i].x;
                    right = S.runs[i].x + S.runs[i].w - 2;
                    unsigned r = S.runs[i].fg >> 11;
                    if (r < 30 && r < bestr) { bestr = r; best = order; }
                    order++;
                }
                bright_at[ti] = best;
                if (ti == 1) { CHECK(left + (right - left) / 2 >= 360 - 14 && left + (right - left) / 2 <= 360 + 14); }
            }
            CHECK(bright_at[0] >= 0 && bright_at[2] <= 6);
            CHECK(bright_at[1] > bright_at[0] && bright_at[2] > bright_at[1]);   // later: further right
            fresh(); ph_view_home(&F, &N, &M, 0);
            int track = 0, pill = 0;
            for (int i = 0; i < S.count; i++) {
                if (S.runs[i].pro_kind != K_RECT_AA) continue;
                track += S.runs[i].x == 260 && S.runs[i].y == 430 && S.runs[i].w == 200 && S.runs[i].pro_height == 6;
                pill += S.runs[i].x >= 260 && S.runs[i].x + S.runs[i].w <= 460 && S.runs[i].y == 430 && S.runs[i].w < 200;
            }
            CHECK(track == 1 && pill <= 1);
        }
        // 24 tabs: still one card, two neighbours, no dots
        for (int i = 0; i < POD_TABS_MAX; i++) {
            snprintf(sw[i].id, SWARM_ID_MAX, "t%d", i); snprintf(sw[i].name, CABLE_NAME_MAX, "tab-%d", i);
            sw[i].panes = sw[i].agents = 1; lists[i] = l3; counts[i] = 1;
        }
        pod_model_swarms(&M, sw, lists, counts, POD_TABS_MAX, "t0", NULL, 0);
        for (int at = 0; at < POD_TABS_MAX; at += 7) {
            N.stack[0].scroll = at;
            fresh(); ph_view_home(&F, &N, &M, now);
            CHECK(dot_runs() == 0 && hits_of(POD_A_ENTER_TAB) == 1 && nth_hit(POD_A_ENTER_TAB, 0)->arg == at && ph_runs(&F) <= HT_RUNS);
        }
    }

    // ---- Home's Notices card (the owner's mockup harness-pro-notices-card.html, option A "a letter"): first before every tab, a light paper card with two
    // sheets behind, an envelope, "Notices" and the count in a round badge, up to three rows (the agent's name over the text) ruled apart, a foot line,
    // one POD_A_INBOX hit ----
    {
        static pod_model_t M;
        static pod_nav_t N;
        static cable_swarm_t sw[2];
        static const char *const *lists[2];
        static uint8_t counts[2];
        const uint32_t now = 500000u;
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        pod_model_agent(&M, "c", "claude-one", "claude", "Mac");
        pod_model_agent(&M, "x", "codex-one", "codex", "Mac");
        pod_model_agent(&M, "m", "muse-one", "muse", "Mac");
        pod_model_agent(&M, "g", "mystery", "nope", "Mac");   // an engine with no logo: the >_ outline
        pod_model_agent(&M, "q", "asker", "claude", "Mac");
        pod_model_agents_end(&M);
        static const char *const l0[] = {"c", "x"}, *const l1[] = {"m", "g", "q"};
        lists[0] = l0; lists[1] = l1; counts[0] = 2; counts[1] = 3;
        snprintf(sw[0].id, SWARM_ID_MAX, "n0"); snprintf(sw[0].name, CABLE_NAME_MAX, "Alpha"); sw[0].panes = sw[0].agents = 2;
        snprintf(sw[1].id, SWARM_ID_MAX, "n1"); snprintf(sw[1].name, CABLE_NAME_MAX, "Bravo"); sw[1].panes = sw[1].agents = 3;
        pod_model_swarms(&M, sw, lists, counts, 2, "n0", NULL, 0);
        pod_model_link(&M, true);
        pod_nav_init(&N);
        // no notices: no card, the pages are the tabs, Home never rests on a card that is not there
        N.stack[0].scroll = -1; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(pod_notice_count(&M) == 0 && pod_tabs_pages_of(&N, &M) == 2 && !text_run("Notices") && text_run("Alpha") && hits_of(POD_A_ENTER_TAB) == 1);
        // one entry: the card first, 1 new, one row
        pod_model_unread_add(&M, "c", "claude-one", "Fixed the cable resync. Tests pass on the host.", 40, now - 5000);
        CHECK(pod_notice_count(&M) == 1 && pod_tabs_pages_of(&N, &M) == 3);
        N.stack[0].scroll = -2; fresh(); ph_view_home(&F, &N, &M, now);
        {
            int paper = 0, mid = 0, back = 0, grads = 0, logos = 0, badge = 0;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                if (r->pro_kind == K_RECT_AA && r->w == 540 && r->pro_height == 560 && r->radius == 48 && r->fg == ht_rgb(PH_LETTER)) { paper++; CHECK(r->x == 90 && r->y == 56); }
                // a sheet 12 (24) px down-right: three rounded 96 px corners and two straight slivers, all inside its own box
                if ((r->pro_kind == K_RECT_AA || r->pro_kind == K_RECT) && r->fg == ht_rgb(PH_LETTER_MID)) {
                    mid++; CHECK(r->x >= 90 + 12 && r->y >= 56 + 12 && r->x + r->w <= 90 + 540 + 12 && r->y + r->pro_height <= 56 + 560 + 12);
                }
                if ((r->pro_kind == K_RECT_AA || r->pro_kind == K_RECT) && r->fg == ht_rgb(PH_LETTER_BACK)) {
                    back++; CHECK(r->x >= 90 + 24 && r->y >= 56 + 24 && r->x + r->w <= 90 + 540 + 24 && r->y + r->pro_height <= 56 + 560 + 24);
                }
                if (r->pro_kind == K_RECT_AA && r->fg == ht_rgb(PH_LETTER_BADGE)) { badge++; CHECK(r->w == 76 && r->pro_height == 76 && r->x + r->w == 90 + 540 - 44); }
                grads += r->pro_kind == POD_GRAD;
                logos += r->pro_kind == K_IMAGE && r->w == 44;
            }
            CHECK(paper == 1 && mid == 5 && back == 5 && badge == 1 && grads == 1 && logos == 1);   // the letter, its two sheets, the badge; tab 0 peeking on the right
            const ht_run_t *nm = text_run("Notices"), *num = text_run("1"), *who = text_run("claude-one"), *row = text_run("Fixed the cable resync."), *foot = text_run("Tap to read");
            CHECK(nm && nm->pro_font == &ph_sb_48 && nm->x == 90 + 44 + 46 + 16 && nm->fg == ht_rgb(PH_LETTER_INK));
            CHECK(num && num->pro_font == &ph_sb_48 && num->fg == ht_rgb(0xFFFFFF) && !text_run("new"));
            CHECK(who && who->pro_font == &ph_sb_22 && who->fg == ht_rgb(PH_LETTER_WHO) && who->x == 90 + 44 + 44 + 18);
            CHECK(row && row->pro_font == &ph_rg_24 && row->fg == ht_rgb(PH_LETTER_INK) && row->x == 90 + 44 + 44 + 18 && row->y > who->y && row->y < 56 + 140 + 112);
            CHECK(foot && foot->fg == ht_rgb(PH_LETTER_MORE));
            CHECK(hits_of(POD_A_INBOX) == 1 && F.hit_count == 1 && !hits_of(POD_A_ENTER_TAB));
            const pod_hit_t *h = nth_hit(POD_A_INBOX, 0);
            CHECK(h->x == 90 && h->y == 56 && h->w == 540 && h->h == 560);
            CHECK(!ph_home_moves(&N, &M) && pod_view_next_ms(&N, &M, now) == 1000);   // nothing on the card moves
            CHECK(ph_runs(&F) <= HT_RUNS && dot_runs() == 0);
        }
        // five notices: the asking agent first, then the newest entries; three rows 112 px apart, two rules, the logos 44 px (an engine with none: the >_
        // outline), long text cut, "+2 more"
        pod_model_question(&M, "q", "Run the migration on the dev database now, or wait?");
        pod_model_unread_add(&M, "x", "codex-one", "Added the retry queue.", 12, now - 4000);
        pod_model_unread_add(&M, "g", "mystery", "Bumped the SDK and regenerated the client. Nothing else changed in this run.", 41, now - 3000);
        pod_model_unread_add(&M, "m", "muse-one", "Done!", 7, now - 2000);
        CHECK(pod_notice_count(&M) == 5 && pod_tabs_pages_of(&N, &M) == 3);
        N.stack[0].scroll = -2; fresh(); ph_view_home(&F, &N, &M, now);
        {
            CHECK(text_run("5") && text_run("+2 more \xc2\xb7 tap to read") && text_run("asker"));
            int rows = 0, logos = 0, outlines = 0, rules = 0;
            int ys[3] = {0, 0, 0};
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                if (r->pro_kind == K_TEXT && r->pro_font == &ph_rg_24 && r->x == 90 + 44 + 44 + 18) { CHECK(rows < 3); ys[rows++] = r->y; }
                logos += r->pro_kind == K_IMAGE && r->w == 44;
                outlines += r->pro_kind == K_RECT_STROKE && r->w == 44 && r->pro_height == 44;
                rules += r->pro_kind == K_RECT && r->pro_height == 2 && r->fg == ht_rgb(PH_LETTER_RULE);
                if (r->pro_kind == K_TEXT && r->pro_font == &ph_rg_24) CHECK(r->x + r->w <= 90 + 540 - 44 + 2);   // inside the card
            }
            CHECK(rows == 3 && ys[1] - ys[0] == 112 && ys[2] - ys[1] == 112 && logos + outlines == 3 && rules == 2);
            const ht_run_t *first = text_prefix("Run the migration");   // the asking agent's question leads
            CHECK(first && first->y == ys[0]);
            CHECK(!text_run("Added the retry queue.") || text_run("Added the retry queue.")->y > ys[0]);
            const ht_run_t *cut = text_prefix("Bumped the SDK");
            CHECK(cut == NULL || ht_pro_width(&ph_rg_24, cut->text) > 0);   // drawn (the run clips with an ellipsis), or fell below the third row
            CHECK(ph_runs(&F) <= HT_RUNS);
        }
        // the card's neighbours: with tab 0 selected the Notices card peeks on the left, behind the card; tab 1's on the right
        N.stack[0].scroll = 0; fresh(); ph_view_home(&F, &N, &M, now);
        {
            int left = 0, right = 0, full = 0;
            for (int i = 0; i < S.count; i++)
                if (S.runs[i].pro_kind == POD_GRAD) {
                    uint16_t g[2]; memcpy(g, S.runs[i].text, sizeof g);
                    if (S.runs[i].w == 540) full++;
                    else if (S.runs[i].x < 0) left++;
                    else right++;
                } else if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].x < 0 && S.runs[i].w == 464) {   // the letter peeking, faded 45 % toward the ground
                    left++;
                    CHECK(S.runs[i].fg != ht_rgb(PH_LETTER) && S.runs[i].fg != ht_rgb(PH_HOME_BG));
                }
            CHECK(full == 1 && left == 1 && right == 1 && !text_run("Notices") && text_run("Alpha") && text_run("Bravo"));   // the left card's name is off the glass
            CHECK(hits_of(POD_A_ENTER_TAB) == 1 && !hits_of(POD_A_INBOX) && nth_hit(POD_A_ENTER_TAB, 0)->arg == 0);
        }
        // paging order: the Notices card, tab 0, tab 1; the Notices card is the left neighbour of tab 0 only
        N.stack[0].scroll = 1; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(!text_run("Notices") && text_run("Bravo") && nth_hit(POD_A_ENTER_TAB, 0)->arg == 1);
        // a long count and a notice with no text read "Done" / "Failed"
        pod_model_unread_add(&M, "c", "claude-one", "", 1, now);
        ((pod_unread_t *)pod_model_unread_find(&M, "c"))->kind = POD_UNREAD_FAILED;
        N.stack[0].scroll = -2; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("Failed") && text_run("Failed")->x == 90 + 44 + 44 + 18);
        // an unknown engine in the first row (an entry of an agent that left the roster): the outline
        pod_model_unread_add(&M, "gone", "ghost", "Left the roster.", 1, now + 1);
        fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("Left the roster.") != NULL);
        // line helper
        {
            ph_notice_line_t line[3];
            CHECK(ph_notices_top(&M, 3, line) == 3 && !strncmp(line[0].text, "Run the migration", 17) && line[0].engine && !strcmp(line[0].engine, "claude"));
            CHECK(ph_notices_top(&M, 0, line) == 0);
        }
        // the card is a still page: the beat does not run while it shows, even with a working agent on tab 0
        pod_model_turn(&M, "c", "started", NULL, 0, now);
        N.stack[0].scroll = -2;
        CHECK(!ph_home_moves(&N, &M));
        N.stack[0].scroll = 0;
        CHECK(ph_home_moves(&N, &M));
    }

    // ---- The notice toast (ph_toast.c): card, logo, name, message, a bar that runs out, one POD_A_BANNER hit ----
    {
        static pod_model_t M;
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        pod_model_agent(&M, "b", "backend", "codex", "Mac");
        pod_model_agent(&M, "z", "weird", "zzz", "Mac");
        pod_model_agents_end(&M);
        pod_model_link(&M, true);
        const uint32_t t0 = 300000u;
        pod_model_unread_add(&M, "b", "backend", "Fixed the cable resync. Tests pass on the host and the device.", 134, t0);
        const pod_unread_t *u = pod_model_unread_find(&M, "b");
        // at rest (after the slide): the card at (40, 24), 640 x 118, radius 30, edge 2 px
        fresh();
        CHECK(ph_toast(&F, &M, u, t0, t0 + 1000) == 118);
        CHECK(S.count <= 9 && ph_runs(&F) == S.count);
        {
            const ht_run_t *edge = &S.runs[0], *fill = &S.runs[1];
            CHECK(edge->pro_kind == K_RECT_AA && edge->x == 40 && edge->y == 24 && edge->w == 640 && edge->pro_height == 118 && edge->radius == 30 && edge->fg == ht_rgb(PH_TOAST_EDGE));
            CHECK(fill->pro_kind == K_RECT_AA && fill->x == 42 && fill->y == 26 && fill->w == 636 && fill->pro_height == 114 && fill->fg == ht_rgb(PH_TOAST_FILL));
            const ht_run_t *nm = text_run("backend"), *msg = text_run("Fixed the cable resync.");
            CHECK(nm && nm->pro_font == &ph_sb_26 && nm->fg == ht_rgb(PH_TOAST_NAME) && nm->x == 40 + 26 + 56 + 18);
            CHECK(msg && msg->pro_font == &ph_rg_28 && msg->fg == ht_rgb(PH_TOAST_INK) && msg->x == nm->x && msg->y > nm->y && msg->w <= 640 - 26 - 56 - 18 - 26 + 2);
            int logos = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_IMAGE) { logos++; CHECK(S.runs[i].w == 44 && S.runs[i].x == 40 + 26 + 6 && S.runs[i].y == 24 + (118 - 44) / 2); }
            CHECK(logos == 1);
            CHECK(hits_of(POD_A_BANNER) == 1 && F.hit_count == 1);
            const pod_hit_t *h = nth_hit(POD_A_BANNER, 0);
            CHECK(h->x == 40 && h->y == 24 && h->w == 640 && h->h == 118 && !strcmp(h->id, "b"));
        }
        // the bar: a 7 px track, the fill from full at the start to nothing at 5 s, shrinking with time
        int last = 1 << 20;
        for (uint32_t age = POD_TOAST_SLIDE_MS; age <= POD_TOAST_MS + 200; age += 250) {
            fresh();
            ph_toast(&F, &M, u, t0, t0 + age);
            int track = -1, fillw = 0;
            for (int i = 0; i < S.count; i++) {
                if (S.runs[i].pro_kind == K_RECT && S.runs[i].pro_height == 7) {
                    if (S.runs[i].fg == ht_rgb(PH_TOAST_BAR)) fillw = S.runs[i].w; else track = S.runs[i].w;
                }
            }
            CHECK(track == 588);
            CHECK(fillw <= last);
            const int want = age >= POD_TOAST_MS ? 0 : (int)(588 * (POD_TOAST_MS - age) / POD_TOAST_MS);
            CHECK(fillw == want);
            last = fillw;
        }
        fresh(); ph_toast(&F, &M, u, t0, t0 + 2500);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(PH_TOAST_BAR)) CHECK(S.runs[i].w == 294);   // half the time: half the bar
        // the slide: from y -170 at the start to 24 by 450 ms, monotonically, fast first
        int prev_y = -1000;
        for (uint32_t age = 0; age <= POD_TOAST_SLIDE_MS + 100; age += 30) {
            fresh(); ph_toast(&F, &M, u, t0, t0 + age);
            const int y = S.runs[0].y;
            CHECK(y >= prev_y && y <= 24 && y >= -170);
            if (age == 0) CHECK(y == -170);
            if (age >= POD_TOAST_SLIDE_MS) CHECK(y == 24);
            prev_y = y;
        }
        {   // ease out: the first 100 ms cover more ground than the last 100
            fresh(); ph_toast(&F, &M, u, t0, t0 + 100);
            const int y100 = S.runs[0].y;
            fresh(); ph_toast(&F, &M, u, t0, t0 + 350);
            const int y350 = S.runs[0].y;
            CHECK(y100 + 170 > 24 - y350);
        }
        // a clock before the start reads as the start; an entry with no text says Done / Failed; an engine with no logo draws the outline
        fresh(); ph_toast(&F, &M, u, t0, t0 - 50);
        CHECK(S.runs[0].y == -170);
        pod_model_unread_add(&M, "z", "weird", "", 1, t0);
        u = pod_model_unread_find(&M, "z");
        fresh(); ph_toast(&F, &M, u, t0, t0 + 1000);
        CHECK(text_run("Done") && text_run("weird") && S.count <= 10);
        { int outl = 0; for (int i = 0; i < S.count; i++) outl += S.runs[i].pro_kind == K_RECT_STROKE && S.runs[i].w == 44; CHECK(outl == 1); }
        ((pod_unread_t *)pod_model_unread_find(&M, "z"))->kind = POD_UNREAD_FAILED;
        fresh(); ph_toast(&F, &M, pod_model_unread_find(&M, "z"), t0, t0 + 1000);
        CHECK(text_run("Failed"));
        // a long name and message are cut inside the card (one line each)
        pod_model_unread_add(&M, "b", "backend", "A very long sentence without any stop that keeps going and going well past the right edge of the toast card and the glass besides", 1, t0);
        snprintf(M.agents[0].name, sizeof M.agents[0].name, "%s", "an-agent-name-that-is-far-too-long-for-the-toast-to-hold-on-one-line");
        fresh(); ph_toast(&F, &M, pod_model_unread_find(&M, "b"), t0, t0 + 1000);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT) CHECK(S.runs[i].x + S.runs[i].w <= 640 + 40 - 26 + 2);

        // A Super Tab's question: "name · Super Tab", the question, a still full bar (amber decision, red stuck), its own edge; no timer
        snprintf(M.agents[0].name, sizeof M.agents[0].name, "%s", "api");
        pod_model_question_tab(&M, "b", "Staging first, or straight to prod?", "Launch v2", POD_ATTN_DECISION);
        pod_model_unread_ask(&M, "b", "api", "Staging first, or straight to prod?", t0);
        u = pod_model_unread_find(&M, "b");
        for (uint32_t age = POD_TOAST_SLIDE_MS; age <= 60000; age += 4950) {
            fresh(); ph_toast(&F, &M, u, t0, t0 + age);
            CHECK(S.count <= 9 && S.runs[0].fg == ht_rgb(0x6A4A1C) && S.runs[0].y == 24);
            int bars = 0;
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT && S.runs[i].pro_height == 7) {
                bars++;
                CHECK(S.runs[i].w == 588 && S.runs[i].x == 66 && S.runs[i].fg == ht_rgb(0xFFB340));   // full, whatever the time
            }
            CHECK(bars == 1);
            const ht_run_t *nm = text_run("api"), *tag = text_run("\xc2\xb7 Launch v2"), *msg = text_run("Staging first, or straight to prod?");
            CHECK(nm && nm->fg == ht_rgb(PH_TOAST_NAME) && nm->pro_font == &ph_sb_26 && nm->x == 140);
            CHECK(tag && tag->fg == ht_rgb(0x8EA3BD) && tag->pro_font == &ph_sb_22 && tag->x == nm->x + ht_pro_width(&ph_sb_26, "api") + 7);
            CHECK(msg && msg->fg == ht_rgb(PH_TOAST_INK) && msg->x == nm->x);
            CHECK(hits_of(POD_A_BANNER) == 1);
        }
        pod_model_question_tab(&M, "b", "Stuck: e2e failed 3 times", "Launch v2", POD_ATTN_STUCK);
        pod_model_unread_ask(&M, "b", "api", "Stuck: e2e failed 3 times", t0);
        u = pod_model_unread_find(&M, "b");
        fresh(); ph_toast(&F, &M, u, t0, t0 + 20000);
        CHECK(S.runs[0].fg == ht_rgb(0x6A2626) && text_run("api") && text_run("api")->fg == ht_rgb(0xFF8F8F) && text_run("Stuck: e2e failed 3 times"));
        { int red = 0; for (int i = 0; i < S.count; i++) red += S.runs[i].pro_kind == K_RECT && S.runs[i].w == 588 && S.runs[i].fg == ht_rgb(0xFF5C5C); CHECK(red == 1); }
        // a long name and Super Tab stay inside the card, the name keeping at least half the line
        snprintf(M.agents[0].name, sizeof M.agents[0].name, "%s", "an-agent-name-that-is-far-too-long-for-the-toast-to-hold-on-one-line");
        pod_model_question_tab(&M, "b", "Which?", "A Super Tab whose name is as long as it may be", POD_ATTN_DECISION);
        fresh(); ph_toast(&F, &M, u, t0, t0 + 1000);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT) CHECK(S.runs[i].x + S.runs[i].w <= 640 + 40 - 26 + 2);
        CHECK(text_prefix("an-agent") && text_prefix("\xc2\xb7 A Super") && text_prefix("\xc2\xb7 A Super")->x - text_prefix("an-agent")->x >= (640 - 2 * 26 - 56 - 18) / 2);
        // the question answered (or a plain question): back to the timed toast with its default edge
        pod_model_question_tab(&M, "b", "Which?", NULL, POD_ATTN_STUCK);
        fresh(); ph_toast(&F, &M, u, t0, t0 + 2500);
        CHECK(S.runs[0].fg == ht_rgb(PH_TOAST_EDGE) && !text_prefix("\xc2\xb7"));
        { int half = 0; for (int i = 0; i < S.count; i++) half += S.runs[i].pro_kind == K_RECT && S.runs[i].fg == ht_rgb(PH_TOAST_BAR) && S.runs[i].w == 294; CHECK(half == 1); }
        pod_model_question_close(&M, "b");
        CHECK(pod_model_attention(&M, pod_model_find(&M, "b")) == POD_ATTN_NONE && !pod_model_find(&M, "b")->super_tab[0]);
    }

    // ---- Agent, Recap, Talk, Inbox, Toast, Update (Task 10) ----
    {
        static pod_model_t M;
        static pod_nav_t N;
        const uint32_t t0 = 1000, now = 200000;
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        pod_model_agent(&M, "w", "landing", "claude", "Mac Studio");
        pod_model_agent(&M, "q", "harness-cli", "codex", "MacBook Pro");
        pod_model_agent(&M, "d", "desktop", "claude", "Mac Studio");
        pod_model_agent(&M, "f", "api-retry", "codex", "MacBook Pro");
        pod_model_agents_end(&M);
        cable_swarm_t sw[1];
        memset(sw, 0, sizeof sw);
        snprintf(sw[0].id, SWARM_ID_MAX, "t0");
        snprintf(sw[0].name, CABLE_NAME_MAX, "Desktop");
        sw[0].panes = sw[0].agents = 4;
        const char *ids[] = {"w", "q", "d", "f"};
        const char *const *lists[1] = {ids};
        uint8_t cnt[1] = {4};
        pod_model_swarms(&M, sw, lists, cnt, 1, "t0", NULL, 0);
        pod_model_link(&M, true);
        pod_model_turn(&M, "w", "started", NULL, 0, t0);
        for (int i = 0; i < 6; i++) { char t[24]; snprintf(t, sizeof t, "step %d", i); pod_model_turn(&M, "w", "step", t, 10 + i, t0 + 1000u * (unsigned)i); }
        pod_model_turn(&M, "w", "activity", "src/hero.tsx", 20, t0 + 9000);
        pod_model_turn(&M, "q", "started", NULL, 0, t0);
        pod_model_question(&M, "q", "Run the migration on the dev database now?");
        {   // pod_model_question clears steps[] (and ignores later ones while ASKING), so give the asking agent its lead-up directly
            pod_agent_t *qa = (pod_agent_t *)pod_model_find(&M, "q");
            const char *lead[] = {"Read migrations/0042.sql", "Ran the migration on a copy", "A third step"};
            for (int i = 0; i < 3; i++) { snprintf(qa->steps[i], sizeof qa->steps[i], "%s", lead[i]); qa->step_at_s[i] = (uint16_t)(12 + i * 18); }
            qa->step_count = 3;
        }
        pod_model_turn(&M, "d", "started", NULL, 0, t0);
        for (int i = 0; i < 8; i++) { char t[24]; snprintf(t, sizeof t, "dstep %d", i); pod_model_turn(&M, "d", "step", t, 10 + i, t0 + 100u * (unsigned)i); }
        pod_model_turn(&M, "d", "activity", "Wrapping up", 252, t0 + 1500);   // the turn's length comes with an activity
        pod_model_turn(&M, "d", "done", NULL, 252, t0 + 2000);
        static char recap[2100];
        for (int i = 0; i < 35; i++) strcat(recap, "The Relaxing chip now follows Rest until you pick a row. ");
        pod_model_recap(&M, "d", recap, false);
        pod_model_turn_stats(&M, "d", 54, 0, 0, -1, -1);
        pod_model_turn(&M, "f", "started", NULL, 0, t0);
        pod_model_turn(&M, "f", "error", NULL, 40, t0 + 40000);
        pod_model_clock(&M, now);
#define OPEN(id, v) do { pod_nav_init(&N); N.depth = 3; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_TAB; \
        snprintf(N.stack[1].tab_id, SWARM_ID_MAX, "t0"); N.stack[2].view = (v); snprintf(N.stack[2].agent, ID_MAX, "%s", id); } while (0)

        // ---- The room (Task 5): Agent and Recap draw one pet in its room; no bar, no tiles ----
        {
            static pod_model_t R;
            static pod_nav_t RN;
            const uint32_t r0 = 5000;
            pod_model_reset(&R);
            pod_model_agents_begin(&R);
            pod_model_agent(&R, "p", "payments", "claude", "Mac Studio");
            pod_model_agent(&R, "b", "backend", "codex", "MacBook Pro");
            pod_model_agent(&R, "d", "docs", "muse", "Mac Studio");
            pod_model_agent(&R, "q", "asker", "codex", "Mac Studio");
            pod_model_agent(&R, "f", "flaky", "claude", "Mac Studio");
            pod_model_agent(&R, "o", "away", "codex", "Mac Studio");
            pod_model_agent(&R, "n", "nopet", "gemini", "Mac Studio");
            pod_model_agents_end(&R);
            cable_swarm_t rsw[1];
            memset(rsw, 0, sizeof rsw);
            snprintf(rsw[0].id, SWARM_ID_MAX, "t0");
            snprintf(rsw[0].name, CABLE_NAME_MAX, "Room");
            rsw[0].panes = rsw[0].agents = 3;
            const char *rids[] = {"p", "b", "d"};
            const char *const *rlists[1] = {rids};
            uint8_t rcnt[1] = {3};
            pod_model_swarms(&R, rsw, rlists, rcnt, 1, "t0", NULL, 0);
            pod_model_link(&R, true);
            pod_model_turn(&R, "p", "started", NULL, 0, r0);
            pod_model_turn(&R, "p", "verb", "Cooking", 34, r0);
            pod_model_turn(&R, "p", "activity", "Simmering the payments refactor", 34, r0);
            pod_model_turn(&R, "b", "started", NULL, 0, r0);
            pod_model_turn(&R, "b", "done", NULL, 252, r0);
            pod_model_recap(&R, "b", "Done! The checkout test is fixed. I also tidied the fixtures.", false);
            pod_model_unread_add(&R, "b", "backend", "Done! The checkout test is fixed. I also tidied the fixtures.", 252, r0);
            pod_model_turn(&R, "f", "started", NULL, 0, r0);
            pod_model_turn(&R, "f", "error", NULL, 40, r0);
            pod_model_unread_add(&R, "f", "flaky", "The migration failed on the dev database.", 40, r0);
            pod_model_turn(&R, "q", "started", NULL, 0, r0);
            pod_model_question(&R, "q", "Can I delete 14 old test files?");
            ((pod_agent_t *)pod_model_find(&R, "o"))->state = POD_OFFLINE;
            pod_model_clock(&R, r0);
#define ROOM(id, v) do { pod_nav_init(&RN); RN.depth = 3; RN.stack[0].view = POD_V_TABS; RN.stack[1].view = POD_V_TAB; \
            snprintf(RN.stack[1].tab_id, SWARM_ID_MAX, "t0"); RN.stack[2].view = (v); snprintf(RN.stack[2].agent, ID_MAX, "%s", id); } while (0)
            // texts of the runs in a screen band, joined by spaces (a bubble wraps its sentence over rows)
#define BAND(buf, y0, y1) do { buf[0] = 0; for (int i_ = 0; i_ < S.count; i_++) if (S.runs[i_].pro_kind == K_TEXT && S.runs[i_].y >= (y0) && S.runs[i_].y < (y1)) { \
                if (buf[0]) strcat(buf, " "); strcat(buf, S.runs[i_].text); } } while (0)

            // working: the name, the activity in a thought, the green status line, 3 dots with the first on
            ROOM("p", POD_V_AGENT);
            fresh();
            ph_view_agent(&F, &RN, &R, r0);
            { const ht_run_t *n = text_run("payments"); CHECK(n && centred_run(n) && n->y >= 24 && n->y <= 40 && n->fg == ht_rgb(PH_ROOM_INK)); }
            { char band[400]; BAND(band, 96, 330); CHECK(strstr(band, "Simmering the payments refactor") != NULL); }
            { const ht_run_t *st = text_run("Cooking\xe2\x80\xa6 0:34"); CHECK(st && st->fg == ht_rgb(PH_ROOM_GREEN) && st->y > 590 && st->y < 640); }
            CHECK(S.background == ht_rgb(PH_ROOM_BG));
            CHECK(ph_room_scene(&R, pod_model_find(&R, "p")) == POD_SCENE_WORK);
            CHECK(!text_run("NOW") && !text_run("Running") && !text_run("Mac Studio"));   // no header, no bar
            CHECK(hits_of(POD_A_BACK) == 0 && hits_of(POD_A_INBOX) == 0);
            CHECK(ph_runs(&F) <= HT_RUNS);
            printf("runs room-working %d\n", ph_runs(&F));
            fresh();
            ph_view_agent(&F, &RN, &R, r0 + 3000);   // the status line moves with the clock
            CHECK(text_run("Cooking\xe2\x80\xa6 0:37"));
            // no activity: the thought shows the verb
            ((pod_agent_t *)pod_model_find(&R, "p"))->activity[0] = 0;
            fresh();
            ph_view_agent(&F, &RN, &R, r0);
            { char band[400]; BAND(band, 96, 330); CHECK(!strstr(band, "Simmering") && strstr(band, "Cooking") != NULL); }
            pod_model_turn(&R, "p", "activity", "Simmering the payments refactor", 34, r0);

            // no dots at the foot of a room
            {
                ROOM("b", POD_V_RECAP);
                fresh();
                ph_view_recap(&F, &RN, &R, r0);
                CHECK(dot_runs() == 0);
            }
            // a long name beside the recap's pet is cut with an ellipsis before x 660
            {
                pod_agent_t *lb = (pod_agent_t *)pod_model_find(&R, "b");
                char keep[sizeof lb->name];
                memcpy(keep, lb->name, sizeof keep);
                memset(lb->name, 'W', sizeof lb->name - 1); lb->name[sizeof lb->name - 1] = 0;
                ROOM("b", POD_V_RECAP);
                fresh();
                ph_view_recap(&F, &RN, &R, r0);
                const ht_run_t *n = NULL;
                for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_sb_34 && S.runs[i].y > 300) n = &S.runs[i];
                CHECK(n && n->x == 160 && n->x + n->w <= 660 + 2 && !strcmp(n->text + strlen(n->text) - 3, "\xe2\x80\xa6"));
                memcpy(lb->name, keep, sizeof keep);
            }

            // finished (unread FINISHED): straight to the recap (the Story): the whole recap in a large bubble, the numbers on one line, the pet
            // small, no hit (a vertical drag scrolls the host's pane, a tap does nothing), no collapsed bubble, no "tap to hear how"
            ROOM("b", POD_V_RECAP);
            CHECK(ph_room_scene(&R, pod_model_find(&R, "b")) == POD_SCENE_RELAX);
            {
                for (int v = 0; v < 2; v++) {   // a RECAP frame, and an Agent frame of an idle agent with a recap (a render before the nav's flip)
                    ROOM("b", v ? POD_V_AGENT : POD_V_RECAP);
                    fresh();
                    if (v) ph_view_agent(&F, &RN, &R, r0); else ph_view_recap(&F, &RN, &R, r0);
                    { char band[900]; BAND(band, 40, 560); CHECK(strstr(band, "Done! The checkout test is fixed.") && strstr(band, "I also tidied the fixtures.")); }
                    CHECK(F.scene->background == ht_rgb(PH_ROOM_BG) && text_run("backend"));   // the room's warm ground, the agent's name beside the pet, no stats line, no title on top
                    { int top = 0; for (int i = 0; i < S.count; i++) top += S.runs[i].pro_kind == K_TEXT && S.runs[i].y < 40; CHECK(top == 0); }
                    CHECK(!text_run("tap to hear how") && !text_run("z z z") && F.hit_count == 0);
                    { int bad = 0, blue = 0; for (int i = 0; i < S.count; i++) { bad += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(0xF3D9DA); blue += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(PH_LETTER); } CHECK(bad == 0 && blue >= 1); }
                    CHECK(!text_prefix("Cooking"));   // no status line
                    CHECK(ph_runs(&F) <= HT_RUNS);
                    if (!v) printf("runs recap %d\n", ph_runs(&F));
                }
                ROOM("b", POD_V_RECAP);   // Codex's Recap pet (HD, below 1x): baked, inside the arena
                fresh(); ph_view_recap(&F, &RN, &R, r0);
                check_baked();
                CHECK(pod_scroll_max(&RN, &R) == 0 && pod_scroll_pitch(&RN) == 0);
                // a long recap is fitted into the bubble: wrapped, the last visible row cut with an ellipsis, no scrolling
                char big[1000];
                big[0] = 0;
                for (int i = 0; strlen(big) < 900; i++) { char t[40]; snprintf(t, sizeof t, "Sentence %d is here. ", i + 1); strcat(big, t); }
                pod_model_recap(&R, "b", big, false);
                CHECK(pod_scroll_max(&RN, &R) == 0 && pod_scroll_pitch(&RN) == 0);
                fresh();
                ph_view_recap(&F, &RN, &R, r0);
                {
                    int rows = 0;
                    const ht_run_t *last = NULL;
                    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_rg_36) { rows++; last = &S.runs[i]; }
                    CHECK(rows >= 5 && last && last->w <= 532 + 2 && last->fg == ht_rgb(PH_LETTER_MORE) && !strcmp(last->text + strlen(last->text) - 3, "\xe2\x80\xa6"));
                    CHECK(text_prefix("Sentence 1 ") && !text_prefix("Sentence 40") && ph_runs(&F) <= HT_RUNS);
                    printf("runs recap-long %d\n", ph_runs(&F));
                }
                // a short recap is not cut
                pod_model_recap(&R, "b", "A short one.", false);
                fresh();
                ph_view_recap(&F, &RN, &R, r0);
                CHECK(text_prefix("A short one.") && !text_prefix("A short one.\xe2\x80\xa6"));
                {   // malformed text (stray continuation bytes, an over-long word): rows are never empty, the layout ends
                    char bad[400];
                    memset(bad, 'W', sizeof bad); bad[sizeof bad - 1] = 0;
                    bad[0] = (char)0xbf; bad[1] = (char)0x80; bad[5] = ' '; bad[6] = (char)0xe2; bad[7] = (char)0x82;
                    pod_model_recap(&R, "b", bad, false);
                    fresh();
                    ph_view_recap(&F, &RN, &R, r0);
                    int rows = 0;
                    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_rg_36) { CHECK(S.runs[i].text[0]); rows++; }
                    CHECK(rows >= 1 && ph_runs(&F) <= HT_RUNS);
                }
                pod_model_recap(&R, "b", "Done! The checkout test is fixed. I also tidied the fixtures.", false);
            }
            // read or unread, the recap shows the same (the bell lives in Notices)
            pod_model_unread_read(&R, "b");
            ROOM("b", POD_V_RECAP);
            fresh();
            ph_view_recap(&F, &RN, &R, r0);
            { char band[900]; BAND(band, 40, 560); CHECK(strstr(band, "Done! The checkout test is fixed.") != NULL); }
            { int bell = 0; for (int i = 0; i < S.count; i++) bell += S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x006FFF); CHECK(bell == 0); }
            // an Agent room with no recap and nothing unread rests with the thought
            {
                pod_agent_t *rb = (pod_agent_t *)pod_model_find(&R, "b");
                const int lines = rb->recap_lines;
                rb->recap_lines = 0;
                CHECK(ph_room_scene(&R, rb) == POD_SCENE_REST);
                ROOM("b", POD_V_AGENT);
                fresh();
                ph_view_agent(&F, &RN, &R, r0);
                CHECK(text_run("z z z") && !text_run("tap to hear how") && F.hit_count == 0);
                CHECK(ph_runs(&F) <= HT_RUNS);
                printf("runs room-resting %d\n", ph_runs(&F));
                rb->recap_lines = lines;
            }

            // the group (bubble + tail + who row) is as tall as the text and centred; the who row follows the bubble
            {
                char big[1200];
                big[0] = 0;
                for (int i = 0; strlen(big) < 1000; i++) { char t2[40]; snprintf(t2, sizeof t2, "Sentence %d is here. ", i + 1); strcat(big, t2); }
                const char *txt[3] = {"A short one.",
                    "Fixed the checkout test and tidied the fixtures. I also renamed two helpers.", big};
                int prev_h = 0;
                for (int c = 0; c < 3; c++) {
                    pod_model_recap(&R, "b", txt[c], false);
                    ROOM("b", POD_V_RECAP);
                    fresh();
                    ph_view_recap(&F, &RN, &R, r0);
                    int rows = 0, bx = -1, by = 0, bw = 0, bh = 0;
                    for (int i = 0; i < S.count; i++) {
                        const ht_run_t *r = &S.runs[i];
                        if (r->pro_kind == K_TEXT && r->pro_font == &ph_rg_36) rows++;
                        if (r->pro_kind == K_RECT_AA && r->fg == ht_rgb(PH_LETTER)) { bx = r->x; by = r->y; bw = r->w; bh = r->pro_height; }
                    }
                    CHECK(bx == 60 && bw == 600 && bh == 56 + rows * 46 && rows >= 1 && rows <= 8);
                    if (c == 0) CHECK(rows == 1);
                    if (c == 1) CHECK(rows >= 2 && rows <= 3);
                    if (c == 2) CHECK(rows == 8);
                    CHECK(bh > prev_h);
                    prev_h = bh;
                    const int gh = bh + 18 + 122, top = by, bottom = 720 - (by + gh);
                    CHECK(top >= 40 && bottom >= 40 && top - bottom <= 2 && bottom - top <= 2);
                    const ht_run_t *nm = text_run("backend");
                    CHECK(nm && nm->x == 160 && nm->fg == ht_rgb(PH_ROOM_INK));
                    CHECK(nm->y > by + bh + 18 && nm->y < by + gh);
                    CHECK(!text_prefix("\xe2\x9c\x93") && !text_prefix("\xc3\x97") && F.hit_count == 0 && ph_runs(&F) <= HT_RUNS);
                    const ht_run_t *last = NULL;
                    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_rg_36) last = &S.runs[i];
                    if (c == 2) CHECK(last && last->fg == ht_rgb(PH_LETTER_MORE) && !strcmp(last->text + strlen(last->text) - 3, "\xe2\x80\xa6"));
                    else CHECK(last && last->fg == ht_rgb(PH_LETTER_INK));
                }
                pod_model_recap(&R, "b", "Done! The checkout test is fixed. I also tidied the fixtures.", false);
            }

            // failed (unread FAILED): the recap on the failed bubble (#F3D9DA), the REST pet
            ROOM("f", POD_V_RECAP);
            CHECK(ph_room_scene(&R, pod_model_find(&R, "f")) == POD_SCENE_REST);
            fresh();
            ph_view_recap(&F, &RN, &R, r0);
            { int bad = 0; for (int i = 0; i < S.count; i++) bad += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(0xF3D9DA); CHECK(bad >= 1); }
            { char band[600]; BAND(band, 40, 560); CHECK(strstr(band, "The migration failed on the dev database.") != NULL); }
            CHECK(!text_run("tap to hear how") && F.hit_count == 0);
            CHECK(!text_prefix("\xc3\x97"));
            CHECK(ph_runs(&F) <= HT_RUNS);
            printf("runs recap-failed %d\n", ph_runs(&F));

            // question: the ASK scene, the question in a speech bubble, no answers, no mic, no YOU bubble
            ROOM("q", POD_V_AGENT);
            CHECK(ph_room_scene(&R, pod_model_find(&R, "q")) == POD_SCENE_ASK);
            fresh();
            ph_view_agent(&F, &RN, &R, r0);
            { char band[600]; BAND(band, 96, 400); CHECK(strstr(band, "Can I delete 14 old test files?") != NULL); }
            for (int i = 0; i < S.count; i++) {
                CHECK(!(S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(0xC6AAEF)));
                CHECK(S.runs[i].pro_kind != K_TEXT || !strstr(S.runs[i].text, "Answer"));
            }
            CHECK(hits_of(POD_A_TALK) == 0);
            CHECK(ph_runs(&F) <= HT_RUNS);
            printf("runs room-question %d\n", ph_runs(&F));

            // offline: REST and the thought
            ROOM("o", POD_V_AGENT);
            CHECK(ph_room_scene(&R, pod_model_find(&R, "o")) == POD_SCENE_REST);
            fresh();
            ph_view_agent(&F, &RN, &R, r0);
            { char band[300]; BAND(band, 96, 400); CHECK(strstr(band, "My machine is offline.") != NULL); }
            CHECK(ph_runs(&F) <= HT_RUNS);

            // an engine with no pet: its logo or the ">_" outline, and the same thought
            ROOM("n", POD_V_AGENT);
            fresh();
            ph_view_agent(&F, &RN, &R, r0);
            CHECK(text_run("nopet") && text_run("z z z") && text_run(">_"));
            CHECK(ph_runs(&F) <= HT_RUNS);

            // the idle agent of a room rests: the REST scene
            ROOM("d", POD_V_AGENT);
            CHECK(ph_room_scene(&R, pod_model_find(&R, "d")) == POD_SCENE_REST);
            CHECK(ph_runs(&F) <= HT_RUNS);

            // the longest sentences stay inside the run budget
            {
                pod_agent_t *pa = (pod_agent_t *)pod_model_find(&R, "p");
                for (int i = 0; i < 30; i++) strcat(pa->activity, " alpha beta");
                ROOM("p", POD_V_AGENT);
                fresh();
                ph_view_agent(&F, &RN, &R, r0);
                CHECK(ph_runs(&F) <= HT_RUNS);
                int rows = 0;
                for (int i = 0; i < S.count; i++) rows += S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_sb_32;
                CHECK(rows <= 2);
            }
            CHECK(pod_scroll_max(&RN, &R) == 0);
        }

        // Talk (Pets): only the pet and the name. Listening = LISTEN scene, sending = SEND scene; no bubbles, wave, dots or "Sent".
        OPEN("w", POD_V_TALK);
        N.talk_started_ms = now - 3000;
        for (int k = 0; k < 2; k++) {
            fresh();
            F.mic_level = k ? 4 : 0;
            N.sending = k == 1;
            N.send_started_ms = now - 500;
            ph_view_talk(&F, &N, &M, now);
            int bars = 0, bubbles = 0;
            for (int i = 0; i < S.count; i++) {
                bars += S.runs[i].pro_kind == K_RECT && S.runs[i].w == 9;
                bubbles += S.runs[i].pro_kind == K_RECT_AA && (S.runs[i].fg == ht_rgb(0xC6AAEF) || S.runs[i].fg == ht_rgb(0x2C2826) || S.runs[i].fg == ht_rgb(ph_mix(0xC6AAEF, PH_ROOM_BG, 50)));
            }
            CHECK(bars == 0 && bubbles == 0 && dot_runs() == 0);
            CHECK(S.background == ht_rgb(PH_ROOM_BG) && text_run("landing") && centred_run(text_run("landing")));
            CHECK(!text_run("Sent") && !text_run("Tap anywhere to send") && !text_run("Sending\xe2\x80\xa6") && !text_run("To landing"));
            for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != K_TEXT || S.runs[i].pro_font != &ph_sb_22);
            if (!k) CHECK(F.hit_count && F.hits[F.hit_count - 1].action == POD_A_TALK && F.hits[F.hit_count - 1].w == POD_W);   // topmost: the whole screen sends
            CHECK(ph_runs(&F) <= HT_RUNS);
            printf("runs talk-%s %d\n", k ? "send" : "listen", ph_runs(&F));
        }
        // the SEND scene plays once from the stop tap: renders at send_started + 0 and + a few steps differ, and the clock asks for its next step soon
        {
            const char *ids[] = {"w", "b"};
            for (int e = 0; e < 2; e++) {
                OPEN(ids[e], POD_V_TALK);
                const pod_agent_t *ta = pod_model_find(&M, ids[e]);
                if (!ta) continue;
                CHECK(pod_pet_has(ta->engine, POD_SCENE_SEND));
                N.sending = true;
                N.send_started_ms = now - 100000u;
                uint32_t hashes[5];
                static ht_run_t first[HT_RUNS];
                int cnt0 = 0;
                const uint32_t at[5] = {0, 300, 600, 900, 1200};
                for (int j = 0; j < 5; j++) {
                    N.send_started_ms = now - at[j];
                    fresh();
                    ph_view_talk(&F, &N, &M, now);
                    uint32_t h = 2166136261u;
                    for (int i = 0; i < S.count; i++) {
                        const unsigned char *b = (const unsigned char *)&S.runs[i];
                        for (size_t k = 0; k < sizeof S.runs[i]; k++) h = (h ^ b[k]) * 16777619u;
                    }
                    hashes[j] = h;
                    if (!j) { cnt0 = S.count; memcpy(first, S.runs, sizeof(ht_run_t) * (size_t)S.count); }
                }
                (void)cnt0; (void)first;
                { bool differ = false; for (int j = 1; j < 5; j++) differ |= hashes[j] != hashes[0]; CHECK(differ); }   // the scene advances with its start time
                N.send_started_ms = now;
                CHECK(pod_view_next_ms(&N, &M, now) < 1000);
                N.sending = false;
            }
        }
        // the clock follows the pet's own animation: the Pets 66 ms beat (a listening 2x pet and its waves cost most of a
        // frame; 30 fps was the device's slowest screen), and always ON the beat so the pet's steps are drawn in turn
        N.sending = false;
        {
            const char *ids[] = {"w", "b"};
            for (int e = 0; e < 2; e++) {
                OPEN(ids[e], POD_V_TALK);
                const pod_agent_t *ta = pod_model_find(&M, ids[e]);
                if (!ta) continue;
                N.talk_started_ms = now - 3000;
                for (int sending = 0; sending < 2; sending++) {
                    N.sending = sending;
                    N.send_started_ms = now - 100000u;   // long played: SEND holds its last step
                    for (uint32_t t = now; t < now + 400; t += 7) {
                        const uint32_t ms = pod_view_next_ms(&N, &M, t);
                        CHECK(ms == ph_talk_next_ms(&N, &M, t) && ms >= 1 && (!sending || ms <= 1000));
                        if (!sending) CHECK(ms <= POD_PH_ANIM_MS && (t + ms) % POD_PH_ANIM_MS == 0);   // listening: every beat, never between
                    }
                }
                N.sending = false;
            }
        }
        N.sending = false;

        // Notices: asking agents first (model order), then unread entries newest first. A row = face, bubble, name + age, text.
        {
            pod_model_unread_clear(&M);
            pod_model_question(&M, "q", "Delete 14 old files?");
            pod_model_unread_add(&M, "f", "api-retry", "Picked the blue hero image. Then it shipped.", 40, now - 300000u);   // 5m, the older
            pod_model_unread_add(&M, "d", "desktop", "Fixed the checkout test. All green.", 40, now - 120000u);              // 2m, the newer
            pod_model_clock(&M, now);
            pod_nav_init(&N);
            N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_INBOX;
            fresh();
            ph_view_inbox(&F, &N, &M, now);
            const ht_run_t *rq = text_prefix("Delete 14 old files?"), *rd = text_prefix("Fixed the checkout test."), *rf = text_prefix("Picked the blue hero");
            CHECK(rq && rd && rf && rq->y < rd->y && rd->y < rf->y);   // notices_order
            CHECK(rq->pro_font == &ph_sb_32 && rq->x == 216);
            CHECK(text_run("Notices") && text_run("Notices")->x == 60 && text_run("Notices")->y == 40 && text_run("Notices")->fg == ht_rgb(PH_ROOM_INK) && !centred_run(text_run("Notices")));
            CHECK(text_run("3 new") && text_run("3 new")->fg == ht_rgb(PH_ROOM_MUTED) && text_run("3 new")->x > text_run("Notices")->x + text_run("Notices")->w);   // N = the rows on the list
            CHECK(dot_runs() == 0 && text_run("asks") && text_run("2m") && text_run("5m"));
            CHECK(hits_of(POD_A_OPEN_NOTIF) == 2 && hits_of(POD_A_FOLLOW) == 1 && F.hit_count == 3);
            const pod_hit_t *h0 = &F.hits[0], *h1 = &F.hits[1], *h2 = &F.hits[2];
            CHECK(h0->action == POD_A_FOLLOW && !strcmp(h0->id, "q") && !strcmp(M.agents[h0->arg].id, "q"));
            CHECK(h1->action == POD_A_OPEN_NOTIF && !strcmp(h1->id, "d") && h2->action == POD_A_OPEN_NOTIF && !strcmp(h2->id, "f"));
            CHECK(h0->y < h1->y && h1->y < h2->y && h1->y - h0->y == 170 && h0->y <= 120);
            int speech = 0, faces = 0, tails = 0;
            for (int i = 0; i < S.count; i++) {
                speech += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(PH_LETTER) && S.runs[i].w == 470;
                faces += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(PH_RAISED) && S.runs[i].w == 110;
                tails += S.runs[i].pro_kind != K_RECT_AA && S.runs[i].pro_kind != K_TEXT && S.runs[i].fg == ht_rgb(PH_LETTER);
            }
            CHECK(speech == 3 && faces == 3 && tails >= 3);   // a bubble, an avatar box and a tail each
            CHECK(rq->y >= 120 && S.background == ht_rgb(PH_ROOM_BG));
            CHECK(!text_run("NEEDS YOU") && !text_run("FINISHED") && !text_run("FAILED"));
            pod_nav_act(&N, &M, h0->action, h0->arg, now);   // an asking agent opens by FOLLOW
            CHECK(N.stack[N.depth - 1].view == POD_V_AGENT && !strcmp(N.stack[N.depth - 1].agent, "q"));
            N.depth = 2; N.stack[1].view = POD_V_INBOX;
            CHECK(pod_scroll_pitch(&N) == 170 && pod_scroll_max(&N, &M) == 0);

            // notices_runs: long texts stay inside the budget (at most two rows, the second cut with an ellipsis); three rows show, more scroll by rows
            pod_model_unread_clear(&M);
            pod_model_question_close(&M, "q");
            const char *eng[] = {"w", "q", "d", "f"};
            const char *longmsg = "The Relaxing chip now follows Rest until you pick a row for it, and every one of the fifty four pet settings tests passes on all of the targets we ship";
            for (int i = 0; i < 4; i++) pod_model_unread_add(&M, eng[i], "someone", longmsg, 40, now - 60000u * (unsigned)(i + 1));
            fresh();
            ph_view_inbox(&F, &N, &M, now);
            CHECK(hits_of(POD_A_OPEN_NOTIF) == 3 && ph_runs(&F) <= HT_RUNS && text_run("4 new"));
            for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].y + F.hits[i].h <= POD_W);
            {
                int msgrows = 0, cut = 0;
                for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].pro_font == &ph_sb_32) {
                    msgrows++;
                    cut += !strcmp(S.runs[i].text + strlen(S.runs[i].text) - 3, "\xe2\x80\xa6");
                }
                CHECK(msgrows == 6 && cut == 3);   // two rows each, the second cut
            }
            printf("runs notices-3 %d\n", ph_runs(&F));
            CHECK(pod_scroll_max(&N, &M) == 1);
            pod_model_question(&M, "q", "Delete 14 old files?");
            // an asking agent's own unread entry is not listed twice: its question row says it
            fresh();
            ph_view_inbox(&F, &N, &M, now);
            CHECK(hits_of(POD_A_FOLLOW) == 1 && hits_of(POD_A_OPEN_NOTIF) == 2 && pod_scroll_max(&N, &M) == 1);
            for (int i = 0; i < F.hit_count; i++) CHECK(F.hits[i].action != POD_A_OPEN_NOTIF || strcmp(F.hits[i].id, "q"));
            pod_model_unread_add(&M, "x", "someone", longmsg, 40, now - 600000u);
            CHECK(pod_scroll_max(&N, &M) == 2);
            N.stack[1].scroll = 1;
            fresh();
            ph_view_inbox(&F, &N, &M, now);
            CHECK(hits_of(POD_A_FOLLOW) == 0 && hits_of(POD_A_OPEN_NOTIF) == 3 && ph_runs(&F) <= HT_RUNS);
            N.stack[1].scroll = 0;
        }
        // Notices: a Super Tab's asking rows (decision, stuck) above a plain entry: "name · Super Tab", "needs you" / "stuck", the edge, the badge
        {
            pod_model_unread_clear(&M);
            pod_model_question_tab(&M, "q", "Staging first, or straight to prod?", "Launch v2", POD_ATTN_DECISION);
            pod_model_question_tab(&M, "d", "e2e failed 3 times, no write access to staging", "Launch v2", POD_ATTN_STUCK);
            pod_model_unread_add(&M, "f", "api-retry", "Picked the blue hero image.", 40, now - 300000u);
            pod_model_clock(&M, now);
            pod_nav_init(&N);
            N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_INBOX;
            fresh();
            ph_view_inbox(&F, &N, &M, now);
            const ht_run_t *nd = text_run("needs you"), *ns = text_run("stuck"), *rq = text_prefix("Staging first"), *rd = text_prefix("e2e failed"), *rf = text_prefix("Picked the blue");
            CHECK(nd && ns && rq && rd && rf && rq->y < rd->y && rd->y < rf->y && !text_run("asks") && text_run("5m"));
            CHECK(nd->y < rq->y && ns->y < rd->y && ns->y > rq->y);
            int tags = 0, badges = 0, rings = 0, amber = 0, red = 0, letters = 0;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                if (r->pro_kind == K_TEXT && !strcmp(r->text, "\xc2\xb7 Launch v2")) { tags++; CHECK(r->fg == ht_rgb(0x6B4FA3) && r->pro_font == &ph_sb_22); }
                badges += r->pro_kind == K_RECT_AA && r->w == 34 && r->fg == ht_rgb(0x3B2E55) && r->x == 60 + 110 + 8 - 40 + 3;
                rings += r->pro_kind == K_RECT_AA && r->w == 40 && r->fg == ht_rgb(PH_ROOM_BG);
                amber += r->pro_kind == K_RECT_AA && r->w == 470 && r->x == 190 && r->fg == ht_rgb(0xFFB340);
                red += r->pro_kind == K_RECT_AA && r->w == 470 && r->x == 190 && r->fg == ht_rgb(0xFF5C5C);
                letters += r->pro_kind == K_RECT_AA && r->fg == ht_rgb(PH_LETTER) && ((r->w == 464 && r->x == 196) || (r->w == 470 && r->x == 190));
            }
            CHECK(tags == 2 && badges == 2 && rings == 2 && amber == 1 && red == 1 && letters == 3 && ph_runs(&F) <= HT_RUNS);
            {   // the tag follows the name on its line
                const ht_run_t *nm = NULL;
                for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].y == nd->y && S.runs[i].x == 216) nm = &S.runs[i];
                CHECK(nm && nm->fg == ht_rgb(PH_LETTER_WHO));
                int beside = 0;
                for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(0x6B4FA3) && S.runs[i].y == nd->y) beside += S.runs[i].x > nm->x + nm->w - 2;
                CHECK(beside == 1);
            }
            CHECK(hits_of(POD_A_FOLLOW) == 2 && hits_of(POD_A_OPEN_NOTIF) == 1);
            // closed: a plain row again
            pod_model_question_close(&M, "q");
            pod_model_question_close(&M, "d");
            pod_model_question(&M, "q", "Delete 14 old files?");
            fresh();
            ph_view_inbox(&F, &N, &M, now);
            CHECK(text_run("asks") && !text_run("needs you") && !text_prefix("\xc2\xb7"));
            pod_model_question_close(&M, "q");
            pod_model_unread_clear(&M);
        }
        // Notices wakes only when a visible age text turns over ("now", minutes, hours, days), not on a beat: a quiet list is neither redrawn nor rebuilt
        {
            pod_model_unread_clear(&M);
            pod_model_question_close(&M, "q");
            pod_model_unread_add(&M, "f", "api-retry", "Picked the blue hero image.", 40, now - 130000u);   // 2m10s old
            pod_model_clock(&M, now);
            pod_nav_init(&N);
            N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_INBOX;
            CHECK(pod_view_next_ms(&N, &M, now) == 50000u && ph_inbox_next_ms(&N, &M, now) == 50000u);   // the 3m mark
            fresh(); pod_model_clock(&M, now + 49999u); ph_view_inbox(&F, &N, &M, now + 49999u);
            CHECK(text_run("2m") && !text_run("3m"));
            fresh(); pod_model_clock(&M, now + 50000u); ph_view_inbox(&F, &N, &M, now + 50000u);
            CHECK(text_run("3m") && !text_run("2m"));
            pod_model_unread_clear(&M);
            pod_model_unread_add(&M, "f", "api-retry", "Picked the blue hero image.", 40, now - 20000u);   // "now" for 40 more seconds
            CHECK(ph_inbox_next_ms(&N, &M, now) == 40000u);
            pod_model_unread_clear(&M);
            pod_model_unread_add(&M, "f", "api-retry", "Picked the blue hero image.", 40, now - 3500000u);   // 58m20s: "59m" in 40 s
            CHECK(ph_inbox_next_ms(&N, &M, now) == 40000u);
            pod_model_unread_clear(&M);
            CHECK(ph_inbox_next_ms(&N, &M, now) == 60000u);   // nothing aged on screen: the model's own changes redraw it
            pod_model_question(&M, "q", "Delete 14 old files?");
            CHECK(ph_inbox_next_ms(&N, &M, now) == 60000u);   // an asking row says "asks": no clock
            pod_model_question_close(&M, "q");
            CHECK(pod_view_next_ms(&N, &M, now) == 60000u);
        }

        // Notices faces are resampled once (baked): a second raster adds nothing, and a row of another engine adds its own
        {
            static uint16_t shot[720 * 720];
            pod_model_unread_clear(&M);
            pod_model_unread_add(&M, "w", "someone", "Fixed the test.", 40, now - 60000u);
            pod_cell_bake_reset();
            fresh(); ph_view_inbox(&F, &N, &M, now);
            ht_raster(&S, (ht_rect_t){0, 0, 720, 720}, shot);
            const unsigned one = pod_cell_bakes();
            const pod_agent_t *wa = pod_model_find(&M, "w");
            CHECK(wa && one == (pod_pet_for(wa->engine) ? 1u : 0u));
            fresh(); ph_view_inbox(&F, &N, &M, now);
            ht_raster(&S, (ht_rect_t){0, 0, 720, 720}, shot);
            CHECK(pod_cell_bakes() == one);
            const char *other = NULL;
            for (int i = 0; i < M.agent_count && !other; i++)
                if (pod_pet_for(M.agents[i].engine) && wa && strcmp(M.agents[i].engine, wa->engine)) other = M.agents[i].id;
            if (other) {
                pod_model_unread_add(&M, other, "else", "Another engine's face.", 40, now - 90000u);
                fresh(); ph_view_inbox(&F, &N, &M, now);
                ht_raster(&S, (ht_rect_t){0, 0, 720, 720}, shot);
                CHECK(pod_cell_bakes() == one + 1);   // the new engine's face, the first one found again
            }
            pod_model_unread_clear(&M);
        }

        // Codex's Inbox faces (HD, below 1x): all baked, inside the arena
        pod_model_unread_clear(&M);
        pod_model_unread_add(&M, "q", "harness-cli", "Asked about the retry.", 40, now - 60000u);
        pod_model_unread_add(&M, "f", "api-retry", "Picked the blue hero image.", 40, now - 90000u);
        fresh(); ph_view_inbox(&F, &N, &M, now);
        check_baked();
        pod_model_unread_clear(&M);

        // notices_empty
        pod_model_unread_clear(&M);
        pod_model_question_close(&M, "q");
        fresh();
        ph_view_inbox(&F, &N, &M, now);
        CHECK(text_run("Nothing new") && text_run("Nothing new")->fg == ht_rgb(PH_ROOM_MUTED) && F.hit_count == 0 && text_run("Notices") && !text_prefix("0 new") && !strstr(S.runs[0].text, "new"));
        pod_model_unread_add(&M, "d", "desktop", "The Relaxing chip now follows Rest.", 252, now - 1000u);
        pod_model_question(&M, "q", "Run the migration on the dev database now?");
        struct { const char *name; pod_view_t v; int tab; } scr[] = {
            {"tabs", POD_V_TABS, 0}, {"agent-w", POD_V_AGENT, 0}, {"agent-q", POD_V_AGENT, 1}, {"recap", POD_V_RECAP, 0},
            {"talk", POD_V_TALK, 0}, {"inbox", POD_V_INBOX, 0}};
        for (unsigned i = 0; i < sizeof scr / sizeof scr[0]; i++) {
            const char *aid = scr[i].tab == 1 ? "q" : scr[i].v == POD_V_RECAP ? "d" : "w";
            pod_nav_init(&N);
            if (scr[i].v == POD_V_TABS) { }
            else if (scr[i].v == POD_V_INBOX) { N.depth = 2; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_INBOX; }
            else OPEN(aid, scr[i].v);
            N.talk_started_ms = now - 3000;
            fresh();
            F.mic_level = 3;
            ph_render(&F, &N, &M, now);
            printf("runs %s %d\n", scr[i].name, ph_runs(&F));
            CHECK(ph_runs(&F) <= HT_RUNS);
        }

        // Update (option B, "Harness ring"): navy ground, "Harness", a ring with the percent, the target version and one status line; no hits
        fresh();
        ph_view_ota(&F, "0.1.1", "0.1.2", 62, false);
        CHECK(S.runs[0].pro_kind == K_RECT && S.runs[0].fg == ht_rgb(0x0E1B2C) && F.hit_count == 0);
        CHECK(text_run("Harness") && text_run("62") && text_run("62")->pro_font == &ph_bd_84 && text_run("%") && text_run("%")->x > text_run("62")->x);
        CHECK(text_run("Updating to 0.1.2") && text_prefix("Writing the new firmware") && !text_run("0.1.1"));
        int arcs = 0;
        for (int i = 0; i < S.count; i++) arcs += S.runs[i].pro_kind == POD_ARC;
        CHECK(arcs == 2 && ph_runs(&F) <= 24);   // the track and the done part
        printf("runs ota %d\n", ph_runs(&F));
        fresh();
        ph_view_ota(&F, "0.1.1", "0.1.2", 0, false);
        arcs = 0;
        for (int i = 0; i < S.count; i++) arcs += S.runs[i].pro_kind == POD_ARC;
        CHECK(arcs == 1 && text_run("0"));   // nothing done yet: the track alone
        fresh();
        ph_view_ota(&F, "0.1.1", "0.1.2", 100, false);
        CHECK(text_run("100") && text_prefix("Checking the new firmware"));
        fresh();
        ph_view_ota(&F, "0.1.1", "0.1.2", 40, true);
        CHECK(text_run("100") && text_run("Restarting into 0.1.2") && text_run("Almost there"));
    }
    // Bubbles
    {   // malformed UTF-8 from the host (a lead byte, then a run of continuation bytes, past the cache's bypass length) stays in its rows
        static char bad[520];
        bad[0] = (char)0xC3; memset(bad + 1, 0x80, 500); bad[501] = 0;
        fresh();
        CHECK(ph_bubble_height(&ph_sb_34, 640, bad, 3, false) > 0);
        (void)ph_bubble(&S, PH_SPEECH, 40, 100, 640, 100, 0, &ph_sb_34, bad, 3, NULL);
        for (int i = 0; i < S.count; i++) CHECK(memchr(S.runs[i].text, 0, sizeof S.runs[i].text) != NULL);
        bad[200] = 0;   // and the cached path
        fresh();
        (void)ph_bubble(&S, PH_SPEECH, 40, 100, 640, 100, 0, &ph_sb_34, bad, 3, NULL);
        for (int i = 0; i < S.count; i++) CHECK(memchr(S.runs[i].text, 0, sizeof S.runs[i].text) != NULL);
    }
    {   // a layout is worked out once per text: the height and the bubble of one frame share it, and so does every beat after it
        const char *q = "Run the migration on the dev database now, or do you want me to wait until the retry queue drains and the nightly backup has finished?";
        (void)ph_bubble_height(&ph_sb_34, 640, q, 3, false);
        const unsigned l0 = ph_bubble_layouts();
        for (int i = 0; i < 5; i++) { fresh(); (void)ph_bubble_height(&ph_sb_34, 640, q, 3, false); (void)ph_bubble(&S, PH_SPEECH, 40, 100, 640, 100, 0, &ph_sb_34, q, 3, NULL); }
        CHECK(ph_bubble_layouts() == l0);
        const int rows = ph_bubble_rows(&ph_sb_34, 640, q, 3);
        CHECK(rows >= 2 && rows <= 3 && ph_bubble_layouts() == l0);
        (void)ph_bubble_height(&ph_sb_34, 600, q, 3, false);   // another width, face, budget or text is its own layout
        CHECK(ph_bubble_layouts() == l0 + 1);
        (void)ph_bubble_height(&ph_sb_32, 640, q, 3, false);
        (void)ph_bubble_height(&ph_sb_34, 640, q, 2, false);
        (void)ph_bubble_height(&ph_sb_34, 640, "Another question?", 3, false);
        CHECK(ph_bubble_layouts() == l0 + 4);
        fresh();   // the cached rows are the ones laid out afresh: the same runs and height as the first time, after the slots have been reused
        const int h1 = ph_bubble(&S, PH_SPEECH, 40, 100, 640, 100, 0, &ph_sb_34, q, 3, NULL);
        static ht_run_t keep[HT_RUNS]; const int n1 = S.count; memcpy(keep, S.runs, sizeof(ht_run_t) * (size_t)n1);
        for (int i = 0; i < 8; i++) { char other[64]; snprintf(other, sizeof other, "filler %d", i); (void)ph_bubble_height(&ph_sb_34, 640, other, 3, false); }
        fresh();
        const int h2 = ph_bubble(&S, PH_SPEECH, 40, 100, 640, 100, 0, &ph_sb_34, q, 3, NULL);
        CHECK(h1 == h2 && S.count == n1 && !memcmp(keep, S.runs, sizeof(ht_run_t) * (size_t)n1));
    }
    {
        const char *long120 = "Fixed the flaky login test by waiting for the session cookie before asserting, then reran the whole suite twice to be sure it holds";
        fresh();
        int h2 = ph_bubble(&S, PH_SPEECH, 20, 100, 440, 120, 0, &ph_sb_32, long120, 2, NULL);
        int nt = 0; const ht_run_t *last = NULL;
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT) { nt++; last = &S.runs[i]; }
        CHECK(nt == 2);
        { size_t n = strlen(last->text); CHECK(n >= 3 && !strcmp(last->text + n - 3, "\xe2\x80\xa6")); }
        CHECK(h2 == 44 + 2 * ph_sb_32.height);
        // kinds: the body's fill is the first rect run of that colour
        struct { ph_bubble_kind_t k; unsigned rgb; } kinds[] = {{PH_SPEECH, 0xF7F2EA}, {PH_THOUGHT, 0x2C2826}, {PH_YOU, 0xC6AAEF}, {PH_SPEECH_BAD, 0xF3D9DA}};
        for (int k = 0; k < 4; k++) {
            fresh();
            ph_bubble(&S, kinds[k].k, 20, 100, 440, 120, 0, &ph_sb_32, "Hello", 2, NULL);
            int found = 0, edge = 0;
            for (int i = 0; i < S.count; i++) {
                if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(kinds[k].rgb) && S.runs[i].w == (kinds[k].k == PH_THOUGHT ? 436 : 440)) found++;
                if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(0x47413C)) edge++;
            }
            CHECK(found == 1);
            CHECK(edge == (kinds[k].k == PH_THOUGHT ? 1 : 0));
        }
        // runs: 2 rows plus a muted row
        fresh();
        ph_bubble(&S, PH_SPEECH, 20, 100, 440, 120, 0, &ph_sb_32, long120, 2, "Tests 24 passed");
        printf("runs bubble 2 rows + muted %d\n", ph_runs(&F));
        CHECK(S.count <= 8 && text_run("Tests 24 passed")->fg == ht_rgb(0x7B746C));
        fresh();
        ph_bubble(&S, PH_THOUGHT, 20, 100, 440, 120, 1, &ph_sb_32, long120, 2, "Tests 24 passed");
        CHECK(S.count <= 8);
        // height grows with rows
        fresh();
        int h1 = ph_bubble(&S, PH_YOU, 20, 100, 440, 120, 0, &ph_sb_32, "Hi", 2, NULL);
        CHECK(h1 < h2);
        fresh();
        ph_thought_dots(&S, 100, 100, 130, 70);
        CHECK(S.count == 4);
        fresh();
        ph_bell(&S, 40, 40, 3);
        CHECK(text_run("3") && text_run("3")->fg == ht_rgb(0x006FFF));        // newlines, returns and tabs read as spaces (ht_pro_text would stop at a newline)
        fresh();
        ph_bubble(&S, PH_SPEECH, 20, 100, 640, 120, 0, &ph_sb_32, "line one\nline two\r\n\tline three", 2, "tab\there");
        CHECK(text_run("line one line two   line three") && text_run("tab here"));
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT) CHECK(!strpbrk(S.runs[i].text, "\n\r\t"));
        // the measure is the draw: the height and rows ph_bubble returns/uses are what ph_bubble_height/_rows say, for every kind of text
        {
            const char *const texts_[] = {"Hi", "line one\nline two", long120, "Superlongunbrokenwordthatcannotpossiblyfitinsidetheinnerwidthofabubbleatall and more",
                "caf\xc3\xa9 \xe2\x80\x94 \xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac\xe2\x82\xac", ""};
            for (unsigned t = 0; t < sizeof texts_ / sizeof *texts_; t++)
                for (int w = 200; w <= 640; w += 220)
                    for (int mr = 1; mr <= 3; mr++)
                        for (int mu = 0; mu < 2; mu++) {
                            fresh();
                            int h = ph_bubble(&S, PH_SPEECH, 20, 100, w, 0, 0, &ph_sb_34, texts_[t], mr, mu ? "muted" : NULL), nt = 0;
                            CHECK(h == ph_bubble_height(&ph_sb_34, w, texts_[t], mr, mu));
                            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT) nt++;
                            CHECK(nt - mu == ph_bubble_rows(&ph_sb_34, w, texts_[t], mr));
                            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_TEXT) {   // whole code points only
                                const char *c = S.runs[i].text;
                                for (; *c; c++) if (((unsigned char)*c & 0xc0) == 0x80) CHECK(c > S.runs[i].text);
                                CHECK(S.runs[i].w <= w - 56 + 1);
                                size_t n = strlen(S.runs[i].text);
                                for (size_t k = 0; k < n;) {   // valid UTF-8, nothing cut in half
                                    unsigned char b = (unsigned char)S.runs[i].text[k];
                                    size_t l = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
                                    CHECK(b < 0x80 || b >= 0xc0);
                                    CHECK(k + l <= n);
                                    for (size_t j = 1; j < l; j++) CHECK(((unsigned char)S.runs[i].text[k + j] & 0xc0) == 0x80);
                                    k += l;
                                }
                            }
                        }
        }
        {   // one first_sentence for the room and Notices
            char o[128];
            ph_first_sentence(o, sizeof o, "Fixed the flaky login test. Then shipped it.");
            CHECK(!strcmp(o, "Fixed the flaky login test."));
            ph_first_sentence(o, sizeof o, "Done! The checkout test is fixed. More.");
            CHECK(!strcmp(o, "Done! The checkout test is fixed."));   // a short opener takes the next sentence
            ph_first_sentence(o, sizeof o, "no end\nof line");
            CHECK(!strcmp(o, "no end of line"));
            snprintf(o, sizeof o, "A. B\nC.");
            ph_first_sentence(o, sizeof o, o);   // in place
            CHECK(!strcmp(o, "A. B C."));
        }
    }
    {   // Home's Working card (option D): the working agents newest first, three to a page, a tap on a pet, the colour of one engine
        static pod_model_t M;
        static pod_nav_t N;
        static cable_swarm_t sw[1];
        static const char *const *lists[1];
        static uint8_t counts[1] = {1};
        static const char *const w0[] = {"w1"};
        static const char *const eng[5] = {"claude", "codex", "muse", "kilo", "cursor"}, *const id[5] = {"w1", "w2", "w3", "w4", "w5"};
        static const uint32_t since[5] = {10000, 50000, 30000, 40000, 20000};   // turn starts, ms: the elapsed times are 90, 50, 70, 60, 80 s
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        for (int i = 0; i < 5; i++) pod_model_agent(&M, id[i], id[i], eng[i], "Mac");
        pod_model_agents_end(&M);
        snprintf(sw[0].id, SWARM_ID_MAX, "w"); snprintf(sw[0].name, CABLE_NAME_MAX, "Solo"); sw[0].panes = sw[0].agents = 1; lists[0] = w0;
        pod_model_swarms(&M, sw, lists, counts, 1, "w", NULL, 0);
        pod_model_link(&M, true);
        const uint32_t now = 100000u;
        for (int i = 0; i < 5; i++) pod_model_turn(&M, id[i], "started", NULL, 0, since[i]);
        pod_model_clock(&M, now);
        pod_nav_init(&N);
        N.stack[0].scroll = POD_HOME_WORKING;
        CHECK(pod_home_working(&M) == 5 && pod_tabs_pages_of(&N, &M) == 2 && ph_home_moves(&N, &M));
        const pod_agent_t *list[8];
        CHECK(ph_working_list(&M, list, 8, now) == 5);
        static const char *const order[5] = {"w2", "w4", "w3", "w5", "w1"};
        for (int i = 0; i < 5; i++) CHECK(!strcmp(list[i]->id, order[i]));
        for (int i = 0; i < 5; i++) CHECK(pod_pet_ink_h(eng[i], POD_SCENE_WORK, 134, 8) <= 128);   // the card's square keeps every pet within 128 px
        N.work_page = 0; fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(text_run("Working") && text_run("5") && text_run("w2") && text_run("w4") && text_run("w3") && !text_run("w5"));
        CHECK(text_run("Working")->x == 90 + 44 && text_run("5")->x + text_run("5")->w == 90 + 496);
        CHECK(hits_of(POD_A_FOLLOW) == 3 && F.hit_count == 3);
        for (int k = 0; k < 3; k++) {
            const pod_hit_t *h = nth_hit(POD_A_FOLLOW, k);
            CHECK(h->x == 90 + 105 + k * 165 - 75 && h->y == 56 + 200 && h->w == 150 && h->h == 280);
            CHECK(!strcmp(h->id, order[k]) && !strcmp(M.agents[h->arg].id, order[k]));
        }
        unsigned c1, c2, e1, e2;
        ph_working_tint(&M, &c1, &c2);
        ph_engine_tint("codex", &e1, &e2);
        CHECK(c1 == e1 && c2 == e2);   // Codex's blue
        {   // the card's gradient is that colour, and the same on every frame
            unsigned d1 = 0, d2 = 0;
            for (uint32_t t = 0; t < 3000; t += 700) {
                fresh(); ph_view_home(&F, &N, &M, now + t);
                for (int i = 0; i < S.count; i++)
                    if (S.runs[i].pro_kind == POD_GRAD && S.runs[i].w == 540) {
                        uint16_t g[2]; memcpy(g, S.runs[i].text, sizeof g);
                        CHECK(!d1 || (d1 == g[0] && d2 == g[1]));
                        d1 = g[0]; d2 = g[1];
                    }
                unsigned t1, t2; ph_working_tint(&M, &t1, &t2);
                CHECK(t1 == c1 && t2 == c2);
            }
            CHECK(d1 == ht_rgb(c1) && d2 == ht_rgb(c2));
        }
        N.work_page = 1; fresh(); ph_view_home(&F, &N, &M, now);   // w5 (Cursor: no pet, its logo) and w1
        CHECK(text_run("w5") && text_run("w1") && !text_run("w2") && hits_of(POD_A_FOLLOW) == 2 && F.hit_count == 2);
        CHECK(!strcmp(nth_hit(POD_A_FOLLOW, 0)->id, "w5") && nth_hit(POD_A_FOLLOW, 0)->arg == 4 && !strcmp(nth_hit(POD_A_FOLLOW, 1)->id, "w1") && nth_hit(POD_A_FOLLOW, 1)->arg == 0);
        CHECK(nth_hit(POD_A_FOLLOW, 0)->x == 90 + 188 - 75 && nth_hit(POD_A_FOLLOW, 1)->x == 90 + 352 - 75);   // two on a page sit in the middle
        {
            int logos = 0;
            for (int i = 0; i < S.count; i++)
                if (S.runs[i].pro_kind == K_IMAGE && S.runs[i].x >= 90 + 188 - 75 && S.runs[i].x + S.runs[i].w <= 90 + 188 + 75 && S.runs[i].y > 256 && S.runs[i].y < 456) logos++;   // two pets: centred, the first at 270 - 82
            CHECK(logos >= 1);
        }
        {   // the worst case, two Codex pets and a Muse on page 0: every frame of a 2 s loop is baked once and the next loop bakes nothing, inside the arena
            static uint16_t shot[540 * 560];
            snprintf(M.agents[3].engine, sizeof M.agents[3].engine, "codex");   // w4
            N.work_page = 0; pod_cell_bake_reset();
            unsigned made = 0;
            for (int lap = 0; lap < 3; lap++) {
                for (uint32_t d = 0; d < 2000; d += 66) { fresh(); ph_view_home(&F, &N, &M, now + d); ht_raster(&S, (ht_rect_t){90, 56, 540, 560}, shot); }
                if (lap == 1) made = pod_cell_bakes();
            }
            printf("working card: %u baked frames, %u px of the %u arena\n", made, pod_cell_bake_px(), 360u * 1024u);
            CHECK(made > 0 && pod_cell_bakes() == made && pod_cell_bake_px() <= 360u * 1024u);
        }
        N.work_page = 9; fresh(); ph_view_home(&F, &N, &M, now);   // past the last page: the last
        CHECK(text_run("w5") && hits_of(POD_A_FOLLOW) == 2);
        N.work_page = 0; N.stack[0].scroll = 0; fresh(); ph_view_home(&F, &N, &M, now);   // tab 0 with Working as its left neighbour: no hits of its own
        CHECK(!text_run("w2") && hits_of(POD_A_FOLLOW) == 0 && ph_home_moves(&N, &M));
        for (int i = 0; i < 5; i++) pod_model_turn(&M, id[i], "done", NULL, 0, 200000);   // nobody works: no Working page, scroll -1 is tab 0
        N.stack[0].scroll = POD_HOME_WORKING;
        CHECK(pod_home_working(&M) == 0 && !pod_home_has(&M, POD_HOME_WORKING) && pod_tabs_pages_of(&N, &M) == 1);
        fresh(); ph_view_home(&F, &N, &M, now);
        CHECK(!text_run("Working") && text_run("Solo") && hits_of(POD_A_FOLLOW) == 0);
    }
    {   // Home's Swarm card (the owner's mockup swarm-card.html): a desk tab linked to a Swarm draws it, the Leads as pets three to a page, the capsule under the name
        static pod_model_t M;
        static pod_nav_t N;
        static cable_swarm_t sw[1];
        static const char *const w0[] = {"w1"}, *const *lists[1] = {w0};
        static uint8_t counts[1] = {1};
        static const char ids[2][ID_MAX] = {"sw1", "sw2"};
        static pod_swarm_t S1;
        struct { const char *id, *project, *engine, *owner, *local; pod_lead_state_t st; unsigned since; } L[4] = {
            {"l1", "mobile", "muse", "", "h1", POD_LEAD_ASK, 0}, {"l2", "harness", "claude", "", "h2", POD_LEAD_WORK, 134},
            {"l3", "website", "codex", "", "h3", POD_LEAD_WORK, 48}, {"l4", "backend", "codex", "", "h4", POD_LEAD_DONE, 0}};
        pod_model_reset(&M);
        pod_model_agents_begin(&M);
        pod_model_agent(&M, "w1", "w1", "claude", "Mac");
        pod_model_agents_end(&M);
        snprintf(sw[0].id, SWARM_ID_MAX, "desk1"); snprintf(sw[0].name, CABLE_NAME_MAX, "Desk"); sw[0].panes = sw[0].agents = 1;
        pod_model_swarms(&M, sw, lists, counts, 1, "desk1", NULL, 0);
        pod_model_link(&M, true);
        pod_model_supertab_ids(&M, ids, 1);   // sw1 only: linked to the desk tab
        memset(&S1, 0, sizeof S1);
        snprintf(S1.id, ID_MAX, "sw1"); snprintf(S1.tab, ID_MAX, "desk1"); snprintf(S1.name, sizeof S1.name, "openharness");
        S1.count = 4; S1.lead_n = 4;
        for (int i = 0; i < 4; i++) {
            pod_lead_t *l = &S1.leads[i];
            snprintf(l->id, ID_MAX, "%s", L[i].id); snprintf(l->project, sizeof l->project, "%s", L[i].project); snprintf(l->engine, sizeof l->engine, "%s", L[i].engine);
            snprintf(l->owner, sizeof l->owner, "%s", L[i].owner); snprintf(l->local, ID_MAX, "%s", L[i].local); l->state = L[i].st; l->since_s = L[i].since;
        }
        pod_model_supertab(&M, &S1, 1000);
        pod_nav_init(&N);
        CHECK(M.swarm_n == 1 && pod_home_pages(&M, NULL, 0) == 1 && pod_home_swarm(&M, 0) == &M.swarms[0]);   // the desk tab's page IS the Swarm's
        N.swarm_page = 0; fresh(); ph_view_home(&F, &N, &M, 1000);
        CHECK(text_run("openharness") && text_run("4") && !text_run("workspaces") && !text_run("workspace") && !text_run("Desk"));   // the capsule's disc, no big number
        CHECK(text_run("1 needs you") && text_run("1 needs you")->fg == ht_rgb(0xFFC796) && text_run("2 working") && text_run("2 working")->fg == ht_rgb(0x9DFFC0) && !text_prefix("1 done"));
        CHECK(text_run("openharness")->x == 90 + 44);   // the title where a tab's name is
        CHECK(text_run("mobile") && text_run("harness") && text_run("website") && !text_run("backend"));
        CHECK(text_run("needs you") && text_run("needs you")->fg == ht_rgb(0xFFC796));
        CHECK(text_run("2:14") && text_run("2:14")->fg == ht_rgb(0x9DFFC0) && text_run("0:48") && !text_prefix("working \xc2\xb7"));   // a working Lead: only its clock
        CHECK(hits_of(POD_A_LEAD) == 3 && F.hit_count == 3 && hits_of(POD_A_ENTER_TAB) == 0);
        for (int k = 0; k < 3; k++) {   // centred exactly like the Working card: 165 px apart about the card's middle
            const pod_hit_t *h = nth_hit(POD_A_LEAD, k);
            CHECK(h->arg == k && !strcmp(h->id, "sw1") && h->x == 90 + 270 + (k - 1) * 165 - 75 && h->w == 150);
        }
        {   // the capsule's pulsing dot (11 px) is there while a Lead needs you or is stuck, and gone once none does
            int dots = 0;
            for (int i = 0; i < S.count; i++) dots += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 11 && S.runs[i].pro_height == 11;
            CHECK(dots == 1);
            M.swarms[0].leads[0].state = POD_LEAD_STUCK;
            fresh(); ph_view_home(&F, &N, &M, 1000);
            dots = 0;
            for (int i = 0; i < S.count; i++) dots += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 11 && S.runs[i].pro_height == 11;
            CHECK(dots == 1 && text_run("stuck") && text_run("stuck")->fg == ht_rgb(0xFFB0B0) && text_run("1 stuck") && text_run("1 stuck")->fg == ht_rgb(0xFFB0B0));   // stuck is red, in the capsule and under the pet, and pulses too
            fresh(); ph_view_home(&F, &N, &M, 1000);
            M.swarms[0].leads[0].state = POD_LEAD_DONE;   // nothing needs you: no dot
            fresh(); ph_view_home(&F, &N, &M, 1000);
            dots = 0;
            for (int i = 0; i < S.count; i++) dots += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 11 && S.runs[i].pro_height == 11;
            CHECK(dots == 0 && !text_prefix("1 needs") && !text_prefix("1 stuck"));
            M.swarms[0].leads[0].state = POD_LEAD_ASK;
        }
        fresh(); ph_view_home(&F, &N, &M, 8000);   // the clock runs: 7 s later
        CHECK(text_run("2:21") && text_run("0:55") && ph_home_moves(&N, &M));
        N.swarm_page = 1; fresh(); ph_view_home(&F, &N, &M, 1000);   // the 4th Lead alone, in the middle
        CHECK(text_run("backend") && text_run("done") && text_run("done")->fg != ht_rgb(0xFFFFFF) && text_run("done")->fg != ht_rgb(0xFFC796) && !text_run("mobile"));
        CHECK(hits_of(POD_A_LEAD) == 1 && nth_hit(POD_A_LEAD, 0)->arg == 3 && nth_hit(POD_A_LEAD, 0)->x == 90 + 270 - 75);
        N.swarm_page = 9; fresh(); ph_view_home(&F, &N, &M, 1000);   // past the last page: the last
        CHECK(text_run("backend") && hits_of(POD_A_LEAD) == 1);
        {   // the neighbouring page's Lead peeks in at the card's edge (a veil clips and fades it): the next page's first at the right, the previous page's last at the left
            #define VEILS(n_) do { n_ = 0; for (int i_ = 0; i_ < S.count; i_++) n_ += S.runs[i_].pro_kind == POD_VEIL; } while (0)
            int v;
            N.swarm_page = 0; fresh(); ph_view_home(&F, &N, &M, 1000); VEILS(v);
            CHECK(v == 1);   // page 0 of 2: a next page, no previous
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_VEIL) CHECK(S.runs[i].x + S.runs[i].w > 90 + 540 && S.runs[i].x > 90 + 300);   // at the right edge
            N.swarm_page = 1; fresh(); ph_view_home(&F, &N, &M, 1000); VEILS(v);
            CHECK(v == 1);   // the last page: a previous page, no next
            for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_VEIL) CHECK(S.runs[i].x < 90 && S.runs[i].x + S.runs[i].w < 90 + 300);   // at the left edge
            M.swarms[0].lead_n = 7;
            for (int k = 4; k < 7; k++) M.swarms[0].leads[k] = M.swarms[0].leads[k - 4];
            N.swarm_page = 1; fresh(); ph_view_home(&F, &N, &M, 1000); VEILS(v);
            CHECK(v == 2 && hits_of(POD_A_LEAD) == 3);   // a middle page: both neighbours
            M.swarms[0].lead_n = 3;
            N.swarm_page = 0; fresh(); ph_view_home(&F, &N, &M, 1000); VEILS(v);
            CHECK(v == 0 && hits_of(POD_A_LEAD) == 3);   // one page: nothing peeks
            M.swarms[0].lead_n = 4;
            #undef VEILS
        }
        {   // the gradient is the Swarm's purple, #6B4FA3 -> #231A3B
            unsigned g1 = 0, g2 = 0;
            for (int i = 0; i < S.count; i++)
                if (S.runs[i].pro_kind == POD_GRAD && S.runs[i].w == 540) { uint16_t g[2]; memcpy(g, S.runs[i].text, sizeof g); g1 = g[0]; g2 = g[1]; }
            CHECK(g1 == ht_rgb(0x6B4FA3) && g2 == ht_rgb(0x231A3B));
        }
        // A remote Lead shows its owner (smaller, muted) under the status; a remote Lead at work has no clock; a Swarm with no desk tab is a page of its own.
        snprintf(S1.id, ID_MAX, "sw2"); S1.tab[0] = 0; snprintf(S1.name, sizeof S1.name, "Solo swarm"); S1.count = 1; S1.lead_n = 1;
        snprintf(S1.leads[0].id, ID_MAX, "r1"); snprintf(S1.leads[0].project, sizeof S1.leads[0].project, "ops"); snprintf(S1.leads[0].engine, sizeof S1.leads[0].engine, "claude");
        snprintf(S1.leads[0].owner, sizeof S1.leads[0].owner, "Linh Tran"); S1.leads[0].local[0] = 0; S1.leads[0].state = POD_LEAD_WORK; S1.leads[0].since_s = 0;
        pod_model_supertab_ids(&M, ids, 2);
        pod_model_supertab(&M, &S1, 1000);
        CHECK(M.swarm_n == 2 && pod_home_pages(&M, NULL, 0) == 2 && pod_home_has(&M, 1) && !pod_home_has(&M, 2));   // page 1 = tab_count + the Swarm's index among the unlinked
        CHECK(pod_home_swarm(&M, 1) == &M.swarms[1] && pod_tabs_pages_of(&N, &M) == 2);
        N.stack[0].scroll = 1; N.swarm_page = 0; fresh(); ph_view_home(&F, &N, &M, 1000);
        CHECK(text_run("Solo swarm") && text_run("1 working") && text_run("ops") && text_run("working") && !text_prefix("working \xc2\xb7") && text_run("Linh Tran"));
        CHECK(text_run("Linh Tran")->fg != ht_rgb(0xFFFFFF) && hits_of(POD_A_LEAD) == 1 && !strcmp(nth_hit(POD_A_LEAD, 0)->id, "sw2"));
        CHECK(text_run("Linh Tran")->y > text_run("working")->y);
        N.stack[0].scroll = 0; fresh(); ph_view_home(&F, &N, &M, 1000);   // the next page peeks at the right: its gradient and title only
        CHECK(text_run("Solo swarm") && !text_run("ops") && hits_of(POD_A_LEAD) == 3);
        // Leads: the pet's scene is work (WORK), ask (ASK, STUCK) or rest (DONE)
        CHECK(ph_lead_scene(POD_LEAD_WORK) == POD_SCENE_WORK && ph_lead_scene(POD_LEAD_ASK) == POD_SCENE_ASK && ph_lead_scene(POD_LEAD_STUCK) == POD_SCENE_ASK && ph_lead_scene(POD_LEAD_DONE) == POD_SCENE_REST);
        {   // the capsule's counts in the fixed order; the Leads in the Swarm's order whatever their state (the daemon's `order`); "All done", the long forms
            static const pod_lead_state_t st[6] = {POD_LEAD_DONE, POD_LEAD_WORK, POD_LEAD_ASK, POD_LEAD_STUCK, POD_LEAD_WORK, POD_LEAD_ASK};
            snprintf(S1.name, sizeof S1.name, "Order");
            S1.count = S1.lead_n = 6;
            for (int i = 0; i < 6; i++) {
                pod_lead_t *l = &S1.leads[i];
                memset(l, 0, sizeof *l);
                snprintf(l->id, ID_MAX, "o%d", i); snprintf(l->project, sizeof l->project, "p%d", i); snprintf(l->engine, sizeof l->engine, "codex");
                snprintf(l->local, ID_MAX, "h%d", i); l->state = st[i]; l->since_s = (unsigned)(10 * (i + 1));
            }
            pod_model_supertab(&M, &S1, 1000);
            N.stack[0].scroll = 1; N.swarm_page = 0; fresh(); ph_view_home(&F, &N, &M, 1000);
            CHECK(text_run("6") && text_run("1 stuck \xc2\xb7 2 need you") && text_run("1 stuck \xc2\xb7 2 need you")->fg == ht_rgb(0xFFB0B0) && text_run("2") && !text_run("2 working") && !text_prefix("1 done"));   // too wide with "working": the bars and the number
            CHECK(hits_of(POD_A_LEAD) == 3 && nth_hit(POD_A_LEAD, 0)->arg == 0 && nth_hit(POD_A_LEAD, 1)->arg == 1 && nth_hit(POD_A_LEAD, 2)->arg == 2);   // done, working, needs you: as listed
            CHECK(text_run("p0") && text_run("p1") && text_run("p2") && text_run("done") && text_run("needs you") && !text_run("p3"));
            CHECK(text_run("p0")->x < text_run("p1")->x && text_run("p1")->x < text_run("p2")->x);
            N.swarm_page = 1; fresh(); ph_view_home(&F, &N, &M, 1000);
            CHECK(hits_of(POD_A_LEAD) == 3 && nth_hit(POD_A_LEAD, 0)->arg == 3 && nth_hit(POD_A_LEAD, 1)->arg == 4 && nth_hit(POD_A_LEAD, 2)->arg == 5);   // stuck, working, needs you
            CHECK(text_run("stuck") && text_run("0:50") && text_run("needs you") && !text_run("done") && text_run("1 stuck \xc2\xb7 2 need you"));   // the capsule counts the whole Swarm
            for (int i = 0; i < 6; i++) S1.leads[i].state = POD_LEAD_DONE;
            pod_model_supertab(&M, &S1, 1000);
            N.swarm_page = 0; fresh(); ph_view_home(&F, &N, &M, 1000);
            CHECK(text_run("All done") && text_run("6") && !text_prefix("0 ") && !text_prefix("1 ") && !ph_home_moves(&N, &M));
            // ten projects, 12 in all, a long name: the name is cut with an ellipsis, the disc widens, "working" shrinks to its bars and the number
            snprintf(S1.name, sizeof S1.name, "openharness-launch-october");
            S1.count = S1.lead_n = 12;
            for (int i = 6; i < 12; i++) { S1.leads[i] = S1.leads[i - 6]; snprintf(S1.leads[i].id, ID_MAX, "o%d", i); }
            for (int i = 0; i < 12; i++) { S1.leads[i].state = i < 3 ? POD_LEAD_STUCK : i < 6 ? POD_LEAD_ASK : POD_LEAD_WORK; S1.leads[i].since_s = 5; }
            pod_model_supertab(&M, &S1, 1000);
            fresh(); ph_view_home(&F, &N, &M, 1000);
            CHECK(text_prefix("openharness-") && !text_run("openharness-launch-october") && text_run("12") && text_run("3 stuck \xc2\xb7 3 need you") && !text_run("6 working") && text_run("6"));
        }
    }
    {   // The Lead view (the owner's mockup B1-B3): the Swarm and the project on top, the Lead's last message in a bubble, the pet signing it with "Lead" and its status
        static pod_model_t M;
        static pod_nav_t N;
        static const char ids[1][ID_MAX] = {"sw1"};
        static pod_swarm_t S1;
        pod_model_reset(&M);
        pod_model_link(&M, true);
        pod_model_supertab_ids(&M, ids, 1);
        memset(&S1, 0, sizeof S1);
        snprintf(S1.id, ID_MAX, "sw1"); snprintf(S1.name, sizeof S1.name, "openharness"); S1.count = 3; S1.lead_n = 3;
        snprintf(S1.leads[0].id, ID_MAX, "l0"); snprintf(S1.leads[0].project, sizeof S1.leads[0].project, "mobile"); snprintf(S1.leads[0].engine, sizeof S1.leads[0].engine, "muse");
        S1.leads[0].state = POD_LEAD_ASK;
        snprintf(S1.leads[1].id, ID_MAX, "l1"); snprintf(S1.leads[1].project, sizeof S1.leads[1].project, "autonomous-harness"); snprintf(S1.leads[1].engine, sizeof S1.leads[1].engine, "claude");
        snprintf(S1.leads[1].local, ID_MAX, "h1"); S1.leads[1].state = POD_LEAD_WORK; S1.leads[1].since_s = 134;
        snprintf(S1.leads[2].id, ID_MAX, "l2"); snprintf(S1.leads[2].project, sizeof S1.leads[2].project, "ops"); snprintf(S1.leads[2].engine, sizeof S1.leads[2].engine, "codex");
        snprintf(S1.leads[2].owner, sizeof S1.leads[2].owner, "Linh Tran"); S1.leads[2].state = POD_LEAD_DONE;
        pod_model_supertab(&M, &S1, 1000);
        pod_nav_init(&N);
        CHECK(pod_nav_open_lead(&N, &M, "sw1", 0) && N.depth == 2 && N.stack[1].view == POD_V_LEAD && !strcmp(N.stack[1].swarm, "sw1") && !strcmp(N.stack[1].lead_id, "l0") && N.stack[1].lead == 0);
        // B2: needs you, LOADED. The Swarm's name (small, purple) over the project, the bubble with the text, the orange inner edge, the pet, "Lead" and "needs you".
        asked_recap(&M, "sw1", "l0", "Build 1.0.9 is done. TestFlight now, or wait for the Android banner fix?", 1792560000u, false);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(S.background == ht_rgb(PH_ROOM_BG) && F.hit_count == 0 && dot_runs() == 0);
        CHECK(centred_run(text_run("openharness")) && text_run("openharness")->fg == ht_rgb(0xB79CFF) && centred_run(text_run("mobile")) && text_run("mobile")->fg == ht_rgb(PH_ROOM_INK));
        CHECK(text_run("openharness")->y < text_run("mobile")->y && text_run("mobile")->y < 150);
        CHECK(text_prefix("Build 1.0.9 is done.") && text_prefix("Build 1.0.9 is done.")->fg == ht_rgb(PH_LETTER_INK) && text_prefix("Build 1.0.9 is done.")->x == 60 + 34);
        CHECK(text_run("Lead") && text_run("Lead")->x == 160 && text_run("needs you") && text_run("needs you")->x == 160 && text_run("needs you")->fg == ht_rgb(0xFFC796));
        CHECK(text_run("Lead")->y < text_run("needs you")->y && !text_run("No message yet") && !text_run("\xe2\x80\xa6"));
        {   // the edge: an orange block at the bubble's left, the paper 8 px in; the paper is 600 wide without an edge
            int edge = 0, paper = 0, wide = 0;
            for (int i = 0; i < S.count; i++) {
                const ht_run_t *r = &S.runs[i];
                edge += r->pro_kind == K_RECT_AA && r->x == 60 && r->w == 120 && r->fg == ht_rgb(0xFF9A52);
                paper += r->pro_kind == K_RECT_AA && r->x == 68 && r->w == 592 && r->fg == ht_rgb(PH_LETTER);
                wide += r->pro_kind == K_RECT_AA && r->w == 600 && r->fg == ht_rgb(PH_LETTER);
            }
            CHECK(edge == 1 && paper == 1 && wide == 0);
        }
        N.stack[1].lead = 0; M.swarms[0].leads[0].state = POD_LEAD_STUCK;   // stuck: the edge is red, the line says so
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        { int red = 0; for (int i = 0; i < S.count; i++) red += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].x == 60 && S.runs[i].w == 120 && S.runs[i].fg == ht_rgb(0xE5484D);
          CHECK(red == 1 && text_run("stuck") && text_run("stuck")->fg == ht_rgb(0xFFB0B0)); }
        M.swarms[0].leads[0].state = POD_LEAD_ASK;
        // B1: working, no edge; the status clock runs
        N.stack[1].view = POD_V_LEAD; snprintf(N.stack[1].lead_id, ID_MAX, "l1"); N.stack[1].lead = 1;
        asked_recap(&M, "sw1", "l1", "PR #1492 is merged and the backend is on production. Next: your turn on the device.", 1792560000u, false);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(centred_run(text_run("autonomous-harness")) && text_run("working \xc2\xb7 2:14") && text_run("working \xc2\xb7 2:14")->fg == ht_rgb(0x3EE05B));
        { int edge = 0; for (int i = 0; i < S.count; i++) edge += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 120; CHECK(edge == 0); }
        fresh(); ph_view_lead(&F, &N, &M, 8000);
        CHECK(text_run("working \xc2\xb7 2:21") && ph_lead_next_ms(&N, &M, 8000) <= 1000);
        // LOADING draws "..." in a bubble of its own; a Lead never asked for looks the same
        pod_model_supertab_close(&M, "sw1", "l1");
        pod_model_supertab_loading(&M, "sw1", "l1");
        CHECK(M.swarms[0].leads[1].recap == POD_RECAP_LOADING && M.swarms[0].leads[1].text == NULL);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(text_run("\xe2\x80\xa6") && text_run("\xe2\x80\xa6")->fg == ht_rgb(PH_LETTER_INK) && !text_run("No message yet") && !text_prefix("PR #"));
        // EMPTY: no bubble, "No message yet" muted in the middle, the pet rests
        asked_recap(&M, "sw1", "l1", NULL, 0, true);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(centred_run(text_run("No message yet")) && text_run("No message yet")->fg == ht_rgb(PH_ROOM_MUTED) && !text_run("\xe2\x80\xa6") && text_run("Lead"));
        { int paper = 0; for (int i = 0; i < S.count; i++) paper += S.runs[i].pro_kind == K_RECT_AA && S.runs[i].fg == ht_rgb(PH_LETTER); CHECK(paper == 0); }
        CHECK(ph_lead_max_row(&N, &M) == 0);
        // A remote Lead: its owner under the status (smaller, muted), a Lead that is done says so in grey
        N.stack[1].view = POD_V_LEAD; snprintf(N.stack[1].lead_id, ID_MAX, "l2"); N.stack[1].lead = 2;
        asked_recap(&M, "sw1", "l2", "Deployed.", 1792560000u, false);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(text_run("ops") && text_run("done") && text_run("done")->fg != ht_rgb(0xFFFFFF) && text_run("Linh Tran") && text_run("Linh Tran")->fg == ht_rgb(PH_ROOM_MUTED));
        CHECK(text_run("done")->y < text_run("Linh Tran")->y && text_run("Lead")->y < text_run("done")->y);
        // A long message: 7 rows at a time, scrolled by rows, the last visible row lighter while more follows
        asked_recap(&M, "sw1", "l2", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty "
                                 "twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two thirty-three "
                                 "thirty-four thirty-five thirty-six thirty-seven thirty-eight thirty-nine forty forty-one forty-two forty-three forty-four forty-five forty-six", 1, false);
        CHECK(pod_scroll_pitch(&N) == 46 && pod_scroll_max(&N, &M) > 0 && pod_scroll_max(&N, &M) == ph_lead_max_row(&N, &M));
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        { int ink = 0, more = 0; for (int i = 0; i < S.count; i++) { ink += S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(PH_LETTER_INK); more += S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(PH_LETTER_MORE); }
          CHECK(ink == 6 && more == 1 && text_prefix("one two")); }
        N.stack[1].scroll = (int16_t)pod_scroll_max(&N, &M);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        { int more = 0; for (int i = 0; i < S.count; i++) more += S.runs[i].pro_kind == K_TEXT && S.runs[i].fg == ht_rgb(PH_LETTER_MORE); CHECK(more == 0 && !text_prefix("one two") && text_prefix("forty")); }
        N.stack[1].scroll = 9999;   // past the end: the view clamps
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(text_prefix("forty") || text_run("Lead"));
        // The model does not hold the Lead (a dropped link): nothing is drawn, nothing breaks
        pod_model_link(&M, false);
        fresh(); ph_view_lead(&F, &N, &M, 1000);
        CHECK(S.count == 0 && pod_nav_lead(&N, &M, NULL) == NULL && ph_lead_next_ms(&N, &M, 1000) > 0 && ph_lead_max_row(&N, &M) == 0);
    }
    printf("test_ph_views: %d checks ok\n", checks);
    return 0;
}
