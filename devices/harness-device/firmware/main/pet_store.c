#include "pet_store.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
static SemaphoreHandle_t s_lock;
// Created before the scheduler starts, so there is no race to create it lazily.
__attribute__((constructor)) static void pet_lock_init(void) { s_lock = xSemaphoreCreateMutex(); }
static void lock(void)   { assert(s_lock); xSemaphoreTake(s_lock, portMAX_DELAY); }
static void unlock(void) { assert(s_lock); xSemaphoreGive(s_lock); }
#ifndef PET_MALLOC
#define PET_MALLOC(n) heap_caps_malloc((n), MALLOC_CAP_SPIRAM)
#endif
#else
#include <pthread.h>
static pthread_mutex_t s_mutex = PTHREAD_MUTEX_INITIALIZER;
static void lock(void)   { pthread_mutex_lock(&s_mutex); }
static void unlock(void) { pthread_mutex_unlock(&s_mutex); }
#ifndef PET_MALLOC
#define PET_MALLOC(n) malloc(n)
#endif
#endif
// Hooks the host test overrides to count allocations.
#ifndef PET_CALLOC
#ifdef ESP_PLATFORM
// PSRAM, so the metadata stays out of internal RAM (SPIRAM_MALLOC_ALWAYSINTERNAL would put it there with calloc).
static void *pet_calloc(size_t n, size_t s)
{
    void *p = heap_caps_calloc(n, s, MALLOC_CAP_SPIRAM);
    return p ? p : calloc(n, s);
}
#define PET_CALLOC(n, s) pet_calloc((n), (s))
#else
#define PET_CALLOC(n, s) calloc((n), (s))
#endif
#endif
#ifndef PET_FREE
#define PET_FREE(p) free(p)
#endif

/*
 * LIFETIME AND THE PER-FRAME SNAPSHOT. A pack is immutable once published. The cable task edits only the STAGED
 * state (s_packs and s_stage_map: offer/finish/map/drop), under the mutex. The UI task reads only the LIVE state
 * (s_live and s_live_map), which pet_store_release_frame replaces with the staged state, once per scene take.
 * So every lookup between two releases sees the same snapshot, however the cable task edits meanwhile: a face
 * built from several lookups can never see one of them disagree with another.
 *   - a pack leaves the staged table at drop/replace; if the live snapshot still holds it, it stays allocated
 *     (the frame being built or painted may use it) and release_frame frees it when it applies the new snapshot;
 *     a pack the live snapshot never saw is freed at once;
 *   - a pack published by finish is invisible to lookup until the next release_frame.
 * The UI therefore holds any pointer it got until its next release_frame call, with no lock held while drawing.
 * The partial pack being received (s_in) is never visible to lookup.
 */

enum { HEADER = 22, MAX_ENGINES = 8, LOOPS = 3, SCENES = 4, MAX_ID = 17, STEP_MS = 120 };

typedef struct pack {
    char id[MAX_ID];
    uint8_t *buf;                  // the whole pack; the frames' cells point into it
    uint32_t size, got, crc;
    ht_pet_t pet;
    uint16_t palette[256];
    ht_cell_frame_t *frames;
    uint16_t *row_at;
    ht_pet_step_t loops[HT_PET_STATES][HT_PET_STEPS];
    uint16_t step_ms[HT_PET_STATES];
    ht_pet_scene_t scenes[3];      // working, listening, sending
    uint8_t *scene_loop[3];
    struct pack *next;             // the list release_frame frees
} pack_t;

typedef struct {
    char all[MAX_ID];
    struct { char engine[16]; char id[MAX_ID]; } engines[MAX_ENGINES];
} map_t;

static pack_t *s_packs[PET_STORE_MAX_PACKS];   // staged: what the cable task has published
static map_t s_stage_map;
static pack_t *s_in;                           // partially received
static pack_t *s_live[PET_STORE_MAX_PACKS];    // live: what lookup sees until the next release_frame
static map_t s_live_map;

static void pack_free(pack_t *p)
{
    if (!p) return;
    PET_FREE(p->buf);
    PET_FREE(p->frames);
    PET_FREE(p->row_at);
    for (int i = 0; i < 3; i++) PET_FREE(p->scene_loop[i]);
    PET_FREE(p);
}

// Take a pack out of the staged table (mutex held). The live snapshot may still be drawing it: then release_frame
// frees it; otherwise nobody can hold it and it goes now.
static void retire(pack_t *p)
{
    if (!p) return;
    for (int i = 0; i < PET_STORE_MAX_PACKS; i++)
        if (s_live[i] == p) return;
    pack_free(p);
}

static bool valid_id(const char *id)
{
    if (!id || strlen(id) != 16) return false;
    for (int i = 0; i < 16; i++)
        if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
    return true;
}

static uint32_t crc32_ieee(const uint8_t *d, size_t n)
{
    static const uint32_t t[16] = {0x00000000, 0x1db71064, 0x3b6e20c8, 0x26d930ac, 0x76dc4190, 0x6b6b51f4,
                                   0x4db26158, 0x5005713c, 0xedb88320, 0xf00f9344, 0xd6d6a3e8, 0xcb61b38c,
                                   0x9b64c2b0, 0x86d3d2d4, 0xa00ae278, 0xbdbdf21c};
    uint32_t c = 0xffffffffu;
    for (size_t i = 0; i < n; i++) {
        c ^= d[i];
        c = (c >> 4) ^ t[c & 15];
        c = (c >> 4) ^ t[c & 15];
    }
    return ~c;
}

// ── parsing: every read is bounds-checked against the pack length ─────────────────────────────────────

typedef struct { const uint8_t *p; size_t n, at; bool bad; } rd_t;
static uint8_t rd8(rd_t *r) { if (r->at + 1 > r->n) { r->bad = true; return 0; } return r->p[r->at++]; }
static uint16_t rd16(rd_t *r)
{
    if (r->n - r->at < 2 || r->at > r->n) { r->bad = true; return 0; }
    uint16_t v = (uint16_t)(r->p[r->at] | r->p[r->at + 1] << 8);
    r->at += 2;
    return v;
}

// Walk one packed row (ht_cell_frame_t) at `start + off`, never leaving [0, n). Returns the offset past it, or 0.
static size_t walk_row(const uint8_t *buf, size_t n, size_t at, unsigned cols)
{
    unsigned x = 0;
    while (x < cols) {
        if (n - at < 2 || at > n) return 0;
        unsigned skip = buf[at], run = buf[at + 1];
        at += 2;
        if (!skip && !run) return 0;               // no progress: ht_cell_at would never finish
        if (x + skip + run > cols || n - at < run) return 0;
        at += run;
        x += skip + run;
    }
    return at;
}

typedef struct { uint8_t n; uint16_t ms; int16_t dx, dy; uint16_t idx[255]; } scene_raw_t;

// parse's working arrays (~3.7 KB), kept off the 6 KiB cable reader task's stack. parse runs only on the cable
// task (from pet_store_finish), one at a time, so one static copy is enough.
static struct { uint16_t small[LOOPS][255]; scene_raw_t sc[SCENES]; } s_scratch;

static unsigned gcd(unsigned a, unsigned b) { while (b) { unsigned t = a % b; a = b; b = t; } return a; }

// Build the ht_pet_t of `p` from p->buf. 0 or PET_ERR_SHAPE.
static int parse(pack_t *p)
{
    rd_t r = {p->buf, p->size, HEADER, false};
    unsigned pal = rd8(&r);
    if (r.bad || pal == 0) return PET_ERR_SHAPE;
    for (unsigned i = 0; i < pal; i++) p->palette[i] = rd16(&r);
    unsigned w = rd16(&r), h = rd16(&r);
    if (r.bad || !w || !h) return PET_ERR_SHAPE;

    uint16_t (*small)[255] = s_scratch.small;
    uint8_t small_n[LOOPS];
    for (int l = 0; l < LOOPS; l++) {
        small_n[l] = rd8(&r);
        for (unsigned i = 0; i < small_n[l]; i++) small[l][i] = rd16(&r);
    }
    scene_raw_t *sc = s_scratch.sc;
    for (int s = 0; s < SCENES; s++) {
        sc[s].n = rd8(&r);
        sc[s].ms = rd16(&r);
        sc[s].dx = (int16_t)rd16(&r);
        sc[s].dy = (int16_t)rd16(&r);
        if (sc[s].dx > 480 || sc[s].dx < -480 || sc[s].dy > 480 || sc[s].dy < -480) return PET_ERR_SHAPE;
        for (unsigned i = 0; i < sc[s].n; i++) sc[s].idx[i] = rd16(&r);
    }
    unsigned count = rd16(&r);
    if (r.bad || !count || !small_n[0]) return PET_ERR_SHAPE;
    if (count > (p->size - r.at) / 3) return PET_ERR_SHAPE;    // a frame is at least 3 bytes

    // Two passes over the frames: validate and count the rows, then fill.
    size_t frames_at = r.at, total_rows = 0;
    for (int pass = 0; pass < 2; pass++) {
        r.at = frames_at;
        size_t row_base = 0;
        for (unsigned f = 0; f < count; f++) {
            unsigned cols = rd8(&r), rows = rd8(&r), cell = rd8(&r);
            if (r.bad || !cols || !rows || !cell || cols * cell > 480 || rows * cell > 480) return PET_ERR_SHAPE;
            size_t table = r.at;
            if (p->size - r.at < (size_t)rows * 2) return PET_ERR_SHAPE;
            r.at += (size_t)rows * 2;
            size_t start = r.at, end = start;
            for (unsigned y = 0; y < rows; y++) {
                size_t off = (size_t)(p->buf[table + y * 2] | p->buf[table + y * 2 + 1] << 8);
                if (start + off >= p->size) return PET_ERR_SHAPE;
                size_t row_end = walk_row(p->buf, p->size, start + off, cols);
                if (!row_end) return PET_ERR_SHAPE;
                if (row_end > end) end = row_end;
                if (pass) p->row_at[row_base + y] = (uint16_t)off;
            }
            if (end - start > 0xffff) return PET_ERR_SHAPE;
            if (pass) {
                p->frames[f] = (ht_cell_frame_t){(uint8_t)cols, (uint8_t)rows, (uint8_t)cell, p->palette,
                                                 p->buf + start, p->row_at + row_base};
            }
            row_base += rows;
            r.at = end;
        }
        if (r.at != p->size) return PET_ERR_SHAPE;                // trailing bytes
        if (!pass) {
            total_rows = row_base;
            p->frames = PET_CALLOC(count, sizeof *p->frames);
            p->row_at = PET_CALLOC(total_rows, sizeof *p->row_at);
            if (!p->frames || !p->row_at) return PET_ERR_SHAPE;
        }
    }

    // Frame indices must exist; the engine's loops hold them in a byte, so a referenced index > 255 is a
    // shape error (a pack with more frames than that is fine while its loops stay among the first 256).
    for (int l = 0; l < LOOPS; l++)
        for (unsigned i = 0; i < small_n[l]; i++)
            if (small[l][i] >= count || small[l][i] > 255) return PET_ERR_SHAPE;
    for (int s = 0; s < SCENES; s++)
        for (unsigned i = 0; i < sc[s].n; i++)
            if (sc[s].idx[i] >= count || sc[s].idx[i] > 255) return PET_ERR_SHAPE;

    // The small pet. A loop longer than HT_PET_STEPS is cut; the loops share one length (the least common
    // multiple of theirs when it fits, else the longest) and shorter ones repeat to fill it.
    unsigned len[LOOPS], steps = 1, longest = 0;
    for (int l = 0; l < LOOPS; l++) {
        unsigned n = small_n[l] ? small_n[l] : small_n[0];
        len[l] = n > HT_PET_STEPS ? HT_PET_STEPS : n;
        if (len[l] > longest) longest = len[l];
        steps = steps / gcd(steps, len[l]) * len[l];
        if (steps > HT_PET_STEPS) steps = HT_PET_STEPS;
    }
    if (steps < longest || steps % longest) steps = longest;
    static const int state_of[LOOPS] = {HT_PET_IDLE, HT_PET_DONE, HT_PET_ASKING};
    for (int l = 0; l < LOOPS; l++) {
        const uint16_t *src = small_n[l] ? small[l] : small[0];
        for (unsigned i = 0; i < steps; i++)
            p->loops[state_of[l]][i] = (ht_pet_step_t){(uint8_t)src[i % len[l]], 0};
    }
    memcpy(p->loops[HT_PET_WORKING], p->loops[HT_PET_IDLE], sizeof p->loops[0]);
    for (int s = 0; s < HT_PET_STATES; s++) p->step_ms[s] = STEP_MS;

    // The scenes: working, listening, sending (failed, the fourth, is validated above and not drawn).
    for (int s = 0; s < 3; s++) {
        if (!sc[s].n || !sc[s].ms) continue;                       // absent: the built-in fallback draws
        unsigned levels = s == 1 ? HT_PET_SCENE_LEVELS : 1;
        p->scene_loop[s] = PET_CALLOC((size_t)sc[s].n * levels, 1);
        if (!p->scene_loop[s]) return PET_ERR_SHAPE;
        unsigned sw = 0, sh = 0;
        for (unsigned i = 0; i < sc[s].n; i++) {
            const ht_cell_frame_t *f = &p->frames[sc[s].idx[i]];
            if (f->cols * f->cell > sw) sw = (unsigned)f->cols * f->cell;
            if (f->rows * f->cell > sh) sh = (unsigned)f->rows * f->cell;
            for (unsigned lv = 0; lv < levels; lv++) p->scene_loop[s][lv * sc[s].n + i] = (uint8_t)sc[s].idx[i];
        }
        p->scenes[s] = (ht_pet_scene_t){.w = (uint16_t)sw, .h = (uint16_t)sh, .frames = p->frames,
                                         .loop = p->scene_loop[s], .steps = sc[s].n, .step_ms = sc[s].ms,
                                         .dx = sc[s].dx, .dy = sc[s].dy};
    }

    p->pet = (ht_pet_t){.engine = NULL, .w = (uint16_t)w, .h = (uint16_t)h, .frames = NULL,
                        .loops = p->loops, .step_ms = p->step_ms,
                        .working_scene = sc[0].n && sc[0].ms ? &p->scenes[0] : NULL,
                        .listening_scene = sc[1].n && sc[1].ms ? &p->scenes[1] : NULL,
                        .sending_scene = sc[2].n && sc[2].ms ? &p->scenes[2] : NULL,
                        .cells = p->frames, .alert_scene = NULL,
                        .steps = (uint8_t)(steps == HT_PET_STEPS ? 0 : steps)};
    return 0;
}

// ── the API ───────────────────────────────────────────────────────────────────────────────────────────

bool pet_store_offer(const char *id, uint32_t size, uint32_t crc)
{
    if (!valid_id(id) || size <= HEADER || size > PET_STORE_MAX_BYTES) return false;
    lock();
    bool ok = false;
    pack_free(s_in);                                 // a resent pack replaces a cut one
    s_in = NULL;
    unsigned held = 0;
    bool same = false;
    for (int i = 0; i < PET_STORE_MAX_PACKS; i++)
        if (s_packs[i]) { held++; if (!strcmp(s_packs[i]->id, id)) same = true; }
    if (held < PET_STORE_MAX_PACKS || same) {
        pack_t *p = PET_CALLOC(1, sizeof *p);
        if (p) p->buf = PET_MALLOC(size);
        if (p && p->buf) {
            memcpy(p->id, id, MAX_ID);
            p->size = size;
            p->crc = crc;
            s_in = p;
            ok = true;
        } else {
            pack_free(p);
        }
    }
    unlock();
    return ok;
}

bool pet_store_slice(const uint8_t *data, size_t len)
{
    lock();
    bool ok = s_in && data && len <= s_in->size - s_in->got;
    if (ok) {
        memcpy(s_in->buf + s_in->got, data, len);
        s_in->got += (uint32_t)len;
    } else {
        pack_free(s_in);
        s_in = NULL;
    }
    unlock();
    return ok;
}

int pet_store_finish(void)
{
    lock();
    pack_t *p = s_in;
    s_in = NULL;
    unlock();
    if (!p) return PET_ERR_SHAPE;

    int err = 0;
    const uint8_t *b = p->buf;
    uint32_t stored_crc = (uint32_t)(b[18] | b[19] << 8 | b[20] << 16 | (uint32_t)b[21] << 24);
    uint32_t stored_len = (uint32_t)(b[14] | b[15] << 8 | b[16] << 16 | (uint32_t)b[17] << 24);
    char hex[MAX_ID];
    for (int i = 0; i < 8; i++) { hex[i * 2] = "0123456789abcdef"[b[6 + i] >> 4]; hex[i * 2 + 1] = "0123456789abcdef"[b[6 + i] & 15]; }
    hex[16] = 0;
    if (p->got != p->size || memcmp(b, "HPET", 4) || stored_len != p->size || strcmp(hex, p->id)) err = PET_ERR_SHAPE;
    else if (b[4] != 1) err = PET_ERR_VERSION;
    else if (crc32_ieee(b + HEADER, p->size - HEADER) != stored_crc || stored_crc != p->crc) err = PET_ERR_CRC;
    else err = parse(p);
    if (err) { pack_free(p); return err; }

    lock();
    for (int i = 0; i < PET_STORE_MAX_PACKS; i++)       // the same id replaces its older copy
        if (s_packs[i] && !strcmp(s_packs[i]->id, p->id)) { retire(s_packs[i]); s_packs[i] = NULL; }
    int slot = -1;
    for (int i = 0; i < PET_STORE_MAX_PACKS && slot < 0; i++) if (!s_packs[i]) slot = i;
    if (slot < 0) { unlock(); pack_free(p); return PET_ERR_SHAPE; }   // offer() checked; only a racing offer gets here
    s_packs[slot] = p;
    unlock();
    return 0;
}

void pet_store_abort(void)
{
    lock();
    pack_free(s_in);
    s_in = NULL;
    unlock();
}

void pet_store_map(const char *all, const char *const *engines, const char *const *ids, size_t n)
{
    lock();
    map_t *m = &s_stage_map;
    memset(m, 0, sizeof *m);
    if (all && strlen(all) < MAX_ID) strcpy(m->all, all);
    size_t k = 0;
    for (size_t i = 0; i < n && k < MAX_ENGINES; i++) {
        if (!engines[i] || !ids[i] || strlen(engines[i]) >= sizeof m->engines[0].engine || strlen(ids[i]) >= MAX_ID) continue;
        strcpy(m->engines[k].engine, engines[i]);
        strcpy(m->engines[k].id, ids[i]);
        k++;
    }
    unlock();
}

void pet_store_drop(const char *id)
{
    if (!id) return;
    lock();
    if (s_in && !strcmp(s_in->id, id)) { pack_free(s_in); s_in = NULL; }   // the daemon gave up on this transfer
    for (int i = 0; i < PET_STORE_MAX_PACKS; i++)
        if (s_packs[i] && !strcmp(s_packs[i]->id, id)) { retire(s_packs[i]); s_packs[i] = NULL; }
    unlock();
}

static pack_t *live_pack(const char *id)
{
    if (!id || !id[0]) return NULL;
    for (int i = 0; i < PET_STORE_MAX_PACKS; i++)
        if (s_live[i] && !strcmp(s_live[i]->id, id)) return s_live[i];
    return NULL;
}

const ht_pet_t *pet_store_lookup(const char *engine)
{
    lock();
    pack_t *p = NULL;
    for (int i = 0; engine && !p && i < MAX_ENGINES; i++)
        if (s_live_map.engines[i].engine[0] && !strcmp(s_live_map.engines[i].engine, engine))
            p = live_pack(s_live_map.engines[i].id);
    if (!p) p = live_pack(s_live_map.all);
    unlock();
    return p ? &p->pet : NULL;
}

size_t pet_store_held(char ids[][17], size_t max)
{
    size_t n = 0;
    lock();
    for (int i = 0; i < PET_STORE_MAX_PACKS && n < max; i++)
        if (s_packs[i]) memcpy(ids[n++], s_packs[i]->id, MAX_ID);
    unlock();
    return n;
}

void pet_store_release_frame(void)
{
    pack_t *dead = NULL;
    lock();
    for (int i = 0; i < PET_STORE_MAX_PACKS; i++) {
        pack_t *p = s_live[i];
        bool kept = false;
        for (int j = 0; p && j < PET_STORE_MAX_PACKS; j++) if (s_packs[j] == p) kept = true;
        if (p && !kept) { p->next = dead; dead = p; }
    }
    memcpy(s_live, s_packs, sizeof s_live);
    s_live_map = s_stage_map;
    unlock();
    while (dead) { pack_t *next = dead->next; pack_free(dead); dead = next; }
}
