// Pets voice screens for an engine without a pet (cursor, kilo): the round's effect alone (7 wave bars listening, 3 sparkles sending); a pet engine is unchanged.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pod/home/ph.h"
#include "pod/pod_draw.h"
#include "pod/pod_nav.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

static int checks;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); abort(); } checks++; } while (0)
enum { K_TEXT = 1, K_IMAGE = 3, K_RECT_AA = 4 };

static ht_scene_t S;
static pod_out_frame_t F;
static pod_model_t M;
static pod_nav_t N;

static void talk(const char *id, bool sending, uint32_t now)
{
    memset(&F, 0, sizeof F);
    ht_scene_clear(&S, ht_rgb(PH_GROUND));
    F.scene = &S;
    pod_nav_init(&N);
    N.depth = 3; N.stack[0].view = POD_V_TABS; N.stack[1].view = POD_V_TAB; snprintf(N.stack[1].tab_id, SWARM_ID_MAX, "t0");
    N.stack[2].view = POD_V_TALK; snprintf(N.stack[2].agent, ID_MAX, "%s", id);
    N.talk_started_ms = 1000; N.sending = sending; N.send_started_ms = 1000;
    F.mic_level = 3;
    ph_view_talk(&F, &N, &M, now);
}
static const uint8_t T[15][7] = {   // the round's WAVE (focus.c), copied here so a typo in the firmware copy shows
    {1,6,10,14,8,3,1},{1,6,10,13,6,3,0},{2,6,9,11,5,2,0},{2,6,8,9,4,2,1},{2,6,7,7,3,2,1},{2,5,5,6,3,3,1},{1,4,4,5,4,4,1},{1,3,3,5,5,4,2},
    {1,2,3,6,6,5,2},{1,2,4,8,7,6,2},{1,2,4,10,9,6,2},{0,2,6,12,9,6,1},{0,3,7,14,10,6,1},{1,4,8,15,9,5,1},{1,5,9,15,9,4,1}};
static int bars(const ht_run_t **out)
{
    int n = 0;
    for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == K_RECT_AA && S.runs[i].w == 9 && S.runs[i].fg == ht_rgb(0x00FF2F)) out[n++] = &S.runs[i];
    return n;
}
static int sparks(const ht_run_t **out)   // the sending sparkles: 62 x 74 images
{
    int n = 0;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_IMAGE && S.runs[i].bitmap.width == 62 && S.runs[i].bitmap.height == 74) out[n++] = &S.runs[i];
    return n;
}
static int others(void)   // bar / triangle / cell / arc runs
{
    int n = 0;
    for (int i = 0; i < S.count; i++) n += S.runs[i].pro_kind >= POD_KIND_BASE;
    return n;
}

int main(void)
{
    pod_model_reset(&M);
    pod_model_agents_begin(&M);
    pod_model_agent(&M, "c", "cursor-app", "cursor", "Mac");
    pod_model_agent(&M, "k", "kilo-agent", "kilo", "Mac");
    pod_model_agent(&M, "p", "payments", "claude", "Mac");
    pod_model_agent(&M, "x", "backend", "codex", "Mac");
    pod_model_agents_end(&M);
    CHECK(!pod_pet_for("cursor") && !pod_pet_for("kilo") && pod_pet_for("claude"));

    const char *ids[] = {"c", "k"};
    for (int e = 0; e < 2; e++) {
        // listening at two clocks: frames 0 and 7
        const uint32_t clocks[2] = {5 * 1200 + 0, 5 * 1200 + 7 * 80 + 10};
        int runs0 = 0;
        for (int c = 0; c < 2; c++) {
            talk(ids[e], false, clocks[c]);
            const ht_run_t *b[16];
            CHECK(bars(b) == 7);
            const int frame = (int)((clocks[c] / 80) % 15);
            for (int k = 0; k < 7; k++) {
                int h = T[frame][k] * 187 / 15; if (h < 6) h = 6;
                CHECK(b[k]->w == 9 && b[k]->pro_height == h && b[k]->radius == 4);
                CHECK(b[k]->x + 4 == 360 + (k - 3) * 35);
                CHECK(b[k]->y + h / 2 == 360);
            }
            CHECK(sparks((const ht_run_t *[8]){0}) == 0 && others() == 0);
            CHECK(S.background == ht_rgb(PH_ROOM_BG));
            int names = 0;
            for (int i = 0; i < S.count; i++) names += S.runs[i].pro_kind == K_TEXT;
            CHECK(names == 1 && S.runs[S.count - 8].pro_kind == K_TEXT);   // the name, then the 7 bars; no caption, logo or dots
            CHECK(F.hit_count && F.hits[F.hit_count - 1].action == POD_A_TALK && F.hits[F.hit_count - 1].w == POD_W);
            if (!c) runs0 = S.count; else CHECK(S.count == runs0);   // same run count between frames
            CHECK(pod_view_next_ms(&N, &M, clocks[c]) == 80 - clocks[c] % 80);
        }
        CHECK(pod_view_next_ms(&N, &M, 160) == 80 && pod_view_next_ms(&N, &M, 199) == 41);

        // sending: the lit sparkle steps every 200 ms
        int prev = -1;
        for (int step = 0; step < 4; step++) {
            uint32_t now = 3000 + step * 200 + 15;
            talk(ids[e], true, now);
            const ht_run_t *sp[8];
            CHECK(sparks(sp) == 3);
            int lit = -1;
            for (int i = 0; i < 3; i++) {
                const ht_pro_bitmap_t *b = &sp[i]->bitmap;
                CHECK(b->alpha && b->alpha[0] == 0 && b->alpha[37 * 62 + 31] == 255);   // a clear corner, a solid heart
                if (b->pixels[0] == ht_rgb(0x00FF2F)) { CHECK(lit < 0); lit = i; }
                else CHECK(b->pixels[0] == ht_rgb(PH_INK) && b->pixels[62 * 74 - 1] == ht_rgb(PH_INK));   // full-strength ink
                CHECK(sp[i]->x + 31 == 360 + (i - 1) * 102 && sp[i]->y == 360 - 37);   // boxes centred on a 102 px pitch at y 360
            }
            CHECK(lit == (int)((now / 200) % 3));
            if (prev >= 0) CHECK(lit == (prev + 1) % 3);
            CHECK(sp[lit]->bitmap.pixels != sp[(lit + 1) % 3]->bitmap.pixels);   // a different run, so the step is damaged
            prev = lit;
            const ht_run_t *b[16];
            CHECK(bars(b) == 0 && others() == 0 && F.hit_count == 0);
            int names = 0;
            for (int i = 0; i < S.count; i++) names += S.runs[i].pro_kind == K_TEXT;
            CHECK(names == 1);   // the name only
            CHECK(pod_view_next_ms(&N, &M, now) == 200 - now % 200);
        }
        talk(ids[e], true, 3015); int n1 = S.count;
        talk(ids[e], true, 3215); CHECK(S.count == n1);
    }

    // a pet engine is unchanged: no bars, no sparkles
    for (int sending = 0; sending < 2; sending++) {
        talk("p", sending, 4000);
        const ht_run_t *b[16];
        CHECK(bars(b) == 0);
        CHECK(sparks((const ht_run_t *[8]){0}) == 0);
        CHECK(pod_pet_has("claude", sending ? POD_SCENE_SEND : POD_SCENE_LISTEN));
        CHECK(pod_view_next_ms(&N, &M, 4000) == ph_talk_next_ms(&N, &M, 4000));
    }
    // Codex's HD robot is drawn at exactly 8 (stored at the size it is shown); Claude's pixel art is doubled pixels at 2x. Both stand on the same floor.
    for (int sending = 0; sending < 2; sending++) {
        int hd = 0, plain = 0;
        talk("x", sending, 4000);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_CELL) { CHECK(S.runs[i].radius == 8 && S.runs[i].text[1] == 0); hd++; }
        talk("p", sending, 4000);
        for (int i = 0; i < S.count; i++) if (S.runs[i].pro_kind == POD_CELL && S.runs[i].radius == 16) { plain++; CHECK(S.runs[i].text[1] == 0); }
        CHECK(hd >= 1 && plain >= 1);
    }
    printf("test_ph_talk: %d checks passed\n", checks);
    return 0;
}
