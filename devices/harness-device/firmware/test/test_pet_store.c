// The firmware pet store on a laptop: the 241-byte vector from the daemon's pack encoder and its version 2 (the
// relaxing scene), then packs broken in every way a cable or a hostile daemon could break them. Run under the
// sanitizers by test/run.sh.
//
//   test_pet_store <path to test/vectors/pet_min.hpet> <path to test/vectors/pet_min_v2.hpet>
//
// pet_store.c is included, not linked, so the allocations can be counted: "freed after the frame" is an
// assertion here, not a hope that a leak checker is available on this host.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long g_live;
static void *t_alloc(size_t n, size_t s) { void *p = calloc(n, s); if (p) g_live++; return p; }
static void t_free(void *p) { if (p) { g_live--; free(p); } }
#define PET_MALLOC(n) t_alloc((n), 1)
#define PET_CALLOC(n, s) t_alloc((n), (s))
#define PET_FREE(p) t_free(p)
#include "../main/pet_store.c"

static int failures, checks;
static void check(int cond, const char *what)
{
    checks++;
    if (!cond) { printf("  FAIL %s\n", what); failures++; }
}

static uint8_t vec[4096];
static size_t vec_len;

static uint32_t get32(const uint8_t *p) { return (uint32_t)(p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24); }
static void put32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }
static void put16(uint8_t *p, unsigned v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }

// Make the header agree with the body again after a test edited it.
static void reseal(uint8_t *b, size_t n)
{
    put32(b + 14, (uint32_t)n);
    put32(b + 18, crc32_ieee(b + HEADER, n - HEADER));
}

static const char *ID = "0102030405060708";

// Offer + slices (in 50-byte pieces) + finish.
static int send_pack(const char *id, const uint8_t *b, size_t n, bool *offered)
{
    bool ok = pet_store_offer(id, (uint32_t)n, get32(b + 18));
    if (offered) *offered = ok;
    if (!ok) return -1;
    for (size_t at = 0; at < n; at += 50) {
        size_t k = n - at < 50 ? n - at : 50;
        if (!pet_store_slice(b + at, k)) return -2;
    }
    return pet_store_finish();
}

// Offsets inside the vector, found by walking its layout.
static size_t working_idx0, frame0_row_at, scenes_end;
static void locate(void)
{
    size_t pos = HEADER;
    pos += 1 + 2u * vec[pos];
    pos += 4;
    for (int l = 0; l < 3; l++) pos += 1 + 2u * vec[pos];
    working_idx0 = pos + 7;
    for (int s = 0; s < 4; s++) pos += 7 + 2u * vec[pos];
    scenes_end = pos;
    frame0_row_at = pos + 2 + 3;
}

/*
 * VERSION 2 (the relaxing scene): version 1 with a fifth scene, `relaxing`, right after `failed`, in the same
 * encoding (n u8, step_ms u16, dx i16, dy i16, n x u16 frame index). Built here from the v1 vector: two steps of
 * 150 ms showing frames 1 then 0, moved (4, -6). test/vectors/pet_min_v2.hpet is exactly this pack.
 */
static const uint8_t RELAX[] = {2, 150, 0, 4, 0, 0xfa, 0xff, 1, 0, 0, 0};
static uint8_t vec2[4096];
static size_t vec2_len;
static size_t build_v2(uint8_t *out, const uint8_t *relax, size_t relax_len)
{
    memcpy(out, vec, scenes_end);
    memcpy(out + scenes_end, relax, relax_len);
    memcpy(out + scenes_end + relax_len, vec + scenes_end, vec_len - scenes_end);
    size_t n = vec_len + relax_len;
    out[4] = 2;
    reseal(out, n);
    return n;
}

static void reset_store(void)
{
    char ids[PET_STORE_MAX_PACKS][17];
    size_t n = pet_store_held(ids, PET_STORE_MAX_PACKS);
    for (size_t i = 0; i < n; i++) pet_store_drop(ids[i]);
    pet_store_abort();
    pet_store_map(NULL, NULL, NULL, 0);
    pet_store_release_frame();
}

// Every cell of every frame through ht_cell_at: a bad row table would be an ASan error.
static void touch_all(const ht_pet_t *pet, unsigned frames)
{
    for (unsigned f = 0; f < frames; f++)
        for (int y = 0; y < pet->cells[f].rows; y++)
            for (int x = 0; x < pet->cells[f].cols; x++) (void)ht_cell_at(&pet->cells[f], x, y);
}

static void parse_vector(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == 0, "vector parses");
    pet_store_map(ID, NULL, NULL, 0);
    check(pet_store_lookup("claude") == NULL, "a mapped, published pack is staged until the next frame");
    pet_store_release_frame();
    const ht_pet_t *pet = pet_store_lookup("claude");
    check(pet != NULL, "lookup(claude) after map all");
    if (pet) {
        check(pet->engine == NULL && pet->w == 8 && pet->h == 8, "small size 8x8");
        check(pet->cells && pet->cells[0].cell == 2 && pet->cells[1].cell == 1, "frame cells 2 and 1");
        check(pet->cells[0].cols == 8 && pet->cells[0].rows == 8, "frame 0 is 8x8");
        check(pet->cells[0].palette[1] == 0x00f8 && pet->cells[0].palette[3] == 0x1f00, "palette in panel order");
        touch_all(pet, 2);
        // idle [0,1,0], done [0], asking [1]: all repeat to the lcm (3)
        check(ht_pet_steps(pet) == 3, "steps = 3");
        check(pet->loops[HT_PET_IDLE][1].frame == 1 && pet->loops[HT_PET_DONE][2].frame == 0 &&
              pet->loops[HT_PET_ASKING][0].frame == 1, "loops");
        check(pet->working_scene && pet->working_scene->steps == 2 && pet->working_scene->loop[0] == 1 &&
              pet->working_scene->step_ms == 120, "working scene");
        check(pet->listening_scene && pet->listening_scene->steps == 1 &&
              pet->listening_scene->loop[4 * 1 + 0] == 0, "listening scene has five levels");
        check(pet->sending_scene && pet->sending_scene->dx == -3 && pet->sending_scene->dy == 5 &&
              pet->sending_scene->steps == 3, "sending scene dx dy");
        check(pet->alert_scene == NULL, "no alert scene");
    }
    pet_store_release_frame();
    char ids[4][17];
    check(pet_store_held(ids, 4) == 1 && !strcmp(ids[0], ID), "held lists the id");
    reset_store();
    check(g_live == 0, "parse_vector leaves nothing allocated");
}

static void reject_bad_crc(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    b[vec_len - 3] ^= 0x40;                       // the body changed, the header did not
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_CRC, "flipped body byte -> CRC");
    char ids[4][17];
    check(pet_store_held(ids, 4) == 0, "nothing held after a bad CRC");
    memcpy(b, vec, vec_len);
    check(pet_store_offer(ID, (uint32_t)vec_len, get32(b + 18) ^ 1), "offer with a wrong crc");
    pet_store_slice(b, vec_len);
    check(pet_store_finish() == PET_ERR_CRC, "offer crc != pack crc -> CRC");
    reset_store();
    check(g_live == 0, "reject_bad_crc leaves nothing allocated");
}

static void reject_version_3(void)
{
    uint8_t b[4096];
    memcpy(b, vec2, vec2_len);
    b[4] = 3;
    check(send_pack(ID, b, vec2_len, NULL) == PET_ERR_VERSION, "version 3 -> VERSION");
    memcpy(b, vec, vec_len);
    b[4] = 0;
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_VERSION, "version 0 -> VERSION");
    reset_store();
    check(g_live == 0, "reject_version_3 leaves nothing allocated");
}

// A v1 pack has no relaxing scene; a v2 pack has one after `failed`, and a v2 pack cut anywhere is refused.
static void version_2(void)
{
    uint8_t b[4096];
    check(send_pack(ID, vec, vec_len, NULL) == 0, "v1 parses");
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    const ht_pet_t *pet = pet_store_lookup("claude");
    check(pet && pet->working_scene && !pet->relaxing_scene, "v1: no relaxing scene");
    reset_store();

    memcpy(b, vec2, vec2_len);
    check(send_pack(ID, b, vec2_len, NULL) == 0, "v2 parses");
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    pet = pet_store_lookup("claude");
    check(pet != NULL, "v2 looked up");
    if (pet) {
        const ht_pet_scene_t *r = pet->relaxing_scene;
        check(r && r->steps == 2 && r->step_ms == 150 && r->dx == 4 && r->dy == -6, "v2: the relaxing scene");
        check(r && r->loop[0] == 1 && r->loop[1] == 0 && r->frames == pet->cells, "v2: its frames");
        check(r && r->w == 16 && r->h == 16 && !r->overlay && !r->shapes, "v2: its size (frame 0: 8 x 8 cells of 2 px)");
        // the rest of the pack is what v1 says
        check(pet->working_scene && pet->working_scene->steps == 2 && pet->listening_scene &&
              pet->sending_scene && pet->sending_scene->dx == -3 && ht_pet_steps(pet) == 3, "v2: the other scenes");
        touch_all(pet, 2);
    }
    reset_store();

    // relaxing n = 0: absent (the face keeps today's resting face)
    static const uint8_t none[] = {0, 0, 0, 0, 0, 0, 0};
    size_t n = build_v2(b, none, sizeof none);
    check(send_pack(ID, b, n, NULL) == 0, "v2 with an empty relaxing scene parses");
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    pet = pet_store_lookup("claude");
    check(pet && !pet->relaxing_scene, "an empty relaxing scene is no scene");
    reset_store();

    // a frame index past the frame count, a dx past the glass
    static const uint8_t past[] = {1, 100, 0, 0, 0, 0, 0, 2, 0};
    n = build_v2(b, past, sizeof past);
    check(send_pack(ID, b, n, NULL) == PET_ERR_SHAPE, "v2 relaxing frame index == count -> SHAPE");
    static const uint8_t far[] = {1, 100, 0, 0xe1, 0x01, 0, 0, 0, 0};
    n = build_v2(b, far, sizeof far);
    check(send_pack(ID, b, n, NULL) == PET_ERR_SHAPE, "v2 relaxing dx 481 -> SHAPE");

    // a v2 pack cut inside its relaxing scene (and anywhere else), sealed again: a SHAPE error
    for (size_t cut = scenes_end; cut <= scenes_end + sizeof RELAX; cut++) {
        memcpy(b, vec2, cut);
        reseal(b, cut);
        int r = send_pack(ID, b, cut, NULL);
        if (r != PET_ERR_SHAPE) { check(0, "a v2 pack cut in its relaxing scene is a SHAPE error"); printf("    cut=%zu got %d\n", cut, r); break; }
    }
    for (size_t cut = HEADER + 1; cut < vec2_len; cut++) {
        memcpy(b, vec2, vec2_len);
        reseal(b, cut);
        int r = send_pack(ID, b, cut, NULL);
        if (r != PET_ERR_SHAPE) { check(0, "every v2 truncation is a SHAPE error"); printf("    cut=%zu got %d\n", cut, r); break; }
    }
    // the v2 relaxing scene taken out again but the version left at 2: the frames read as a scene, refused
    memcpy(b, vec, vec_len);
    b[4] = 2;
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "a v1 body under a v2 header -> SHAPE");
    reset_store();
    check(g_live == 0, "version_2 leaves nothing allocated");
}

static void pet_store_abort_keeps_current(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == 0, "A held");
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    const ht_pet_t *a = pet_store_lookup("claude");
    pet_store_release_frame();
    b[13] = 9;                                    // another id: 0102030405060709
    reseal(b, vec_len);
    check(pet_store_offer("0102030405060709", (uint32_t)vec_len, get32(b + 18)), "B offered");
    pet_store_slice(b, 100);
    pet_store_abort();
    check(pet_store_lookup("claude") == a, "lookup still A after abort");
    pet_store_release_frame();
    check(pet_store_slice(b + 100, 10) == false, "a slice after abort is refused");
    char ids[4][17];
    check(pet_store_held(ids, 4) == 1, "only A held");
    reset_store();
    check(g_live == 0, "abort leaves nothing allocated");
}

static void drop_aborts_partial(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == 0, "A held");
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    const ht_pet_t *a = pet_store_lookup("claude");
    const int before = g_live;
    b[13] = 9;                                    // another id: 0102030405060709
    reseal(b, vec_len);
    check(pet_store_offer("0102030405060709", (uint32_t)vec_len, get32(b + 18)), "B offered");
    check(pet_store_slice(b, vec_len / 2), "half of B sliced");
    check(g_live > before, "partial buffer allocated");
    pet_store_drop("0102030405060709");
    check(g_live == before, "drop of the in-flight id frees the partial buffer");
    check(pet_store_slice(b + vec_len / 2, 10) == false, "a slice after the drop is refused");
    check(pet_store_lookup("claude") == a, "lookup unaffected");
    check(pet_store_offer("0102030405060709", (uint32_t)vec_len, get32(b + 18)), "a new offer works");
    check(pet_store_slice(b, vec_len) && pet_store_finish() == 0, "and completes");
    reset_store();
    check(g_live == 0, "drop_aborts_partial leaves nothing allocated");
}

static void engine_before_all(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    send_pack(ID, b, vec_len, NULL);
    b[13] = 9;
    reseal(b, vec_len);
    send_pack("0102030405060709", b, vec_len, NULL);
    const char *engines[] = {"codex"}, *ids[] = {"0102030405060709"};
    pet_store_map(ID, engines, ids, 1);
    pet_store_release_frame();
    const ht_pet_t *all = pet_store_lookup("claude"), *codex = pet_store_lookup("codex");
    check(all && codex && all != codex, "codex has its own pack, claude falls to all");
    check(pet_store_lookup("muse") == all, "unmapped engine -> all");
    const char *gone[] = {"0aaaaaaaaaaaaaaa"};
    pet_store_map(NULL, engines, gone, 1);
    pet_store_release_frame();
    check(pet_store_lookup("codex") == NULL, "mapped to an id not held, no all -> NULL");
    check(pet_store_lookup("claude") == NULL, "no all -> NULL");
    pet_store_release_frame();
    reset_store();
    check(g_live == 0, "engine_before_all leaves nothing allocated");
}

static void fifth_offer_busy(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    for (int i = 0; i < 4; i++) {
        char id[17];
        b[13] = (uint8_t)(0x10 + i);
        reseal(b, vec_len);
        snprintf(id, sizeof id, "01020304050607%02x", 0x10 + i);
        check(send_pack(id, b, vec_len, NULL) == 0, "pack held");
    }
    bool offered = true;
    b[13] = 0x20;
    reseal(b, vec_len);
    send_pack("0102030405060720", b, vec_len, &offered);
    check(!offered, "fifth offer refused");
    // the same id again is a replacement, not a fifth pack
    b[13] = 0x10;
    reseal(b, vec_len);
    check(send_pack("0102030405060710", b, vec_len, &offered) == 0 && offered, "re-offer of a held id");
    char ids[8][17];
    check(pet_store_held(ids, 8) == 4, "still four held");
    pet_store_drop("0102030405060711");
    b[13] = 0x20;
    reseal(b, vec_len);
    check(send_pack("0102030405060720", b, vec_len, &offered) == 0 && offered, "offer fits after a drop");
    reset_store();
    check(g_live == 0, "fifth_offer_busy leaves nothing allocated");
}

static void drop_frees_after_release(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    send_pack(ID, b, vec_len, NULL);
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    const ht_pet_t *pet = pet_store_lookup("claude");
    long live = g_live;
    pet_store_drop(ID);
    check(g_live == live, "a pack the frame may still draw is not freed by drop");
    touch_all(pet, 2);                            // still readable: ASan would say otherwise
    pet_store_release_frame();
    check(g_live == 0, "freed once the frame is released");
    check(pet_store_lookup("claude") == NULL, "dropped pack is gone");
    // replaced while referenced
    send_pack(ID, b, vec_len, NULL);
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    pet = pet_store_lookup("claude");
    send_pack(ID, b, vec_len, NULL);
    touch_all(pet, 2);
    pet_store_release_frame();
    reset_store();
    check(g_live == 0, "replaced pack freed after release");
}

// H1: the cable task re-maps between two lookups of one frame; both must agree, and the change lands at the release.
static void snapshot_per_frame(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == 0, "pack held");
    pet_store_map(ID, NULL, NULL, 0);
    pet_store_release_frame();
    const ht_pet_t *first = pet_store_lookup("claude");
    check(first != NULL, "mapped after the release");
    pet_store_map(NULL, NULL, NULL, 0);                        // the cable task clears "all" mid-frame
    check(pet_store_lookup("claude") == first, "a second lookup in the frame agrees");
    pet_store_drop(ID);
    check(pet_store_lookup("codex") == first, "so does a lookup after a drop");
    touch_all(first, 2);
    pet_store_release_frame();
    check(pet_store_lookup("claude") == NULL, "after the release the new mapping applies");
    pet_store_release_frame();
    reset_store();
    check(g_live == 0, "snapshot_per_frame leaves nothing allocated");
}

// L1: frames and scenes outside the 480 px glass are refused.
static void geometry_limits(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    b[frame0_row_at - 1] = 241;                                // 8 cols * 241 > 480
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "frame wider than 480 px -> SHAPE");
    memcpy(b, vec, vec_len);
    b[frame0_row_at - 2] = 241;
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "frame taller than 480 px -> SHAPE");
    memcpy(b, vec, vec_len);
    put16(b + working_idx0 - 4, 481);
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "scene dx 481 -> SHAPE");
    memcpy(b, vec, vec_len);
    put16(b + working_idx0 - 2, (unsigned)(uint16_t)-481);
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "scene dy -481 -> SHAPE");
    memcpy(b, vec, vec_len);
    put16(b + working_idx0 - 4, (unsigned)(uint16_t)-480);
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == 0, "scene dx -480 is allowed");
    reset_store();
    check(g_live == 0, "geometry_limits leaves nothing allocated");
}

// A pack the daemon would never send: each must be refused as a shape error, with the sanitizers silent.
static void bounds(void)
{
    uint8_t b[4096];
    memcpy(b, vec, vec_len);
    // (a) the cable cut it: header and body disagree
    check(send_pack(ID, b, vec_len - 5, NULL) == PET_ERR_SHAPE, "truncated, header says more -> SHAPE");
    // (b) truncated and sealed again: the parser must stop at the end of the data
    for (size_t cut = HEADER + 1; cut < vec_len; cut++) {
        memcpy(b, vec, vec_len);
        reseal(b, cut);
        int r = send_pack(ID, b, cut, NULL);
        if (r != PET_ERR_SHAPE) { check(0, "every truncation is a SHAPE error"); printf("    cut=%zu got %d\n", cut, r); break; }
    }
    // (c) a frame index past the frame count
    memcpy(b, vec, vec_len);
    put16(b + working_idx0, 2);
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "frame index == count -> SHAPE");
    put16(b + working_idx0, 300);
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "frame index 300 -> SHAPE");
    // (d) a row offset past the end
    memcpy(b, vec, vec_len);
    put16(b + frame0_row_at, 0xff00);
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "row_at past the end -> SHAPE");
    // (e) a run longer than the row; a row that never advances
    memcpy(b, vec, vec_len);
    b[frame0_row_at + 2 * 8 + 1] = 200;           // first row's first run: far past cols
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "run wider than the row -> SHAPE");
    memcpy(b, vec, vec_len);
    b[frame0_row_at + 2 * 8] = 0;
    b[frame0_row_at + 2 * 8 + 1] = 0;
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "empty run (no progress) -> SHAPE");
    // (f) zero cell size, magic, id mismatch, an offer whose size is not the pack's
    memcpy(b, vec, vec_len);
    b[frame0_row_at - 1] = 0;
    reseal(b, vec_len);
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "cell 0 -> SHAPE");
    memcpy(b, vec, vec_len);
    b[0] = 'X';
    check(send_pack(ID, b, vec_len, NULL) == PET_ERR_SHAPE, "bad magic -> SHAPE");
    memcpy(b, vec, vec_len);
    check(send_pack("0102030405060799", b, vec_len, NULL) == PET_ERR_SHAPE, "offer id != pack id -> SHAPE");
    check(!pet_store_offer("xyz", 100, 0) && !pet_store_offer(ID, 0, 0) && !pet_store_offer(ID, 10u << 20, 0),
          "bad id or size refused at the offer");
    check(pet_store_offer(ID, (uint32_t)vec_len, 0) && !pet_store_slice(vec, vec_len + 1), "more bytes than offered refused");
    check(pet_store_finish() == PET_ERR_SHAPE, "finish with nothing received -> SHAPE");
    char ids[4][17];
    check(pet_store_held(ids, 4) == 0, "nothing held after all of that");
    reset_store();
    check(g_live == 0, "bounds leaves nothing allocated");
}

int main(int argc, char **argv)
{
    if (argc < 3) { printf("usage: test_pet_store pet_min.hpet pet_min_v2.hpet\n"); return 2; }
    FILE *f = fopen(argv[1], "rb");
    if (!f) { printf("cannot open %s\n", argv[1]); return 2; }
    vec_len = fread(vec, 1, sizeof vec, f);
    fclose(f);
    check(vec_len == 241, "vector is 241 bytes");
    locate();
    vec2_len = build_v2(vec2, RELAX, sizeof RELAX);
    {
        uint8_t file2[4096];
        FILE *g = fopen(argv[2], "rb");
        if (!g) { printf("cannot open %s\n", argv[2]); return 2; }
        size_t n2 = fread(file2, 1, sizeof file2, g);
        fclose(g);
        check(n2 == vec2_len && !memcmp(file2, vec2, n2), "pet_min_v2.hpet is the v1 vector plus the relaxing scene");
    }
    parse_vector();
    reject_bad_crc();
    reject_version_3();
    version_2();
    pet_store_abort_keeps_current();
    drop_aborts_partial();
    engine_before_all();
    fifth_offer_busy();
    drop_frees_after_release();
    bounds();
    snapshot_per_frame();
    geometry_limits();
    printf("test_pet_store: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
