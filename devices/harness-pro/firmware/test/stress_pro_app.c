// Stress replay of the 2026-10-11 03:28 freeze: tabs being created/switched fast in the desktop app. Feeds the real
// pro_app_* callbacks (what pro_cable calls after parsing) with swarms of 1..24 tabs, tiles 0/2, a 1-agent roster,
// focus to agents in / not in the tabs, library pages, touches; after every feed it runs the render task's body
// (tick, take_scene, next_wake_ms) and rasters the whole scene. A SIGALRM per step catches a hang and prints what
// was on screen. Build: test/stress_pro_app.sh.
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "app/pro_app.h"
#include "app/pro_touch.h"
#include "app/pro_voice.h"
#include "cable/pro_cable.h"
#include "pro_app_api.h"
#include "pro_canvas.h"
#include "pro_display.h"
#include "pro_frame.h"
#include "sys/config_store.h"
#include "sys/ram_telemetry.h"

#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define U (*pro_app_test_pod())
static uint32_t now = 1000;
static int LOCK_DEPTH;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); abort(); } } while (0)

SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(void) { return calloc(1, 8); }
BaseType_t xSemaphoreTakeRecursive(SemaphoreHandle_t m, TickType_t w) { (void)m; (void)w; LOCK_DEPTH++; return pdTRUE; }
BaseType_t xSemaphoreGiveRecursive(SemaphoreHandle_t m) { (void)m; CHECK(LOCK_DEPTH > 0); LOCK_DEPTH--; return pdTRUE; }
int64_t esp_timer_get_time(void) { return (int64_t)now * 1000; }
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t f, const char *n, uint32_t s, void *a, unsigned p, TaskHandle_t *o, int core) { (void)f; (void)n; (void)s; (void)a; (void)p; (void)o; (void)core; return pdPASS; }
BaseType_t xTaskNotifyGive(TaskHandle_t t) { (void)t; return pdTRUE; }
uint32_t ulTaskNotifyTake(BaseType_t c, TickType_t w) { (void)c; (void)w; return 0; }
void vTaskDelay(TickType_t t) { (void)t; }
uint32_t uxTaskGetStackHighWaterMark(TaskHandle_t t) { (void)t; return 0; }
esp_err_t esp_task_wdt_add(void *t) { (void)t; return ESP_OK; }
esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }
size_t heap_caps_get_free_size(unsigned c) { (void)c; return 0; }
size_t heap_caps_get_largest_free_block(unsigned c) { (void)c; return 0; }
uint8_t config_load_brightness(void) { return 220; }
bool config_load_muted(void) { return true; }
void ram_telemetry_periodic(const char *tag) { (void)tag; }
bool fw_was_updated(char *version, size_t cap) { (void)version; (void)cap; return false; }
void pro_frame_init(void) {}
uint32_t pro_frame_present(const ht_scene_t *p, const ht_scene_t *n) { (void)p; (void)n; return 0; }
void pro_display_set_brightness(uint8_t l) { (void)l; }
void pro_display_power(bool on) { (void)on; }
pro_touch_sample_t pro_touch_poll(int *x, int *y) { (void)x; (void)y; return PRO_TOUCH_NONE; }
bool pro_cable_send_open(const char *id) { CHECK(LOCK_DEPTH == 0); (void)id; return true; }
bool pro_cable_send_scroll(pro_scroll_phase_t phase, int dy, int velocity) { (void)phase; (void)dy; (void)velocity; return true; }
static int lib_req_offset = -1;
static uint32_t lib_req_id;
bool pro_cable_request_library(int offset, uint32_t request) { CHECK(LOCK_DEPTH == 0); lib_req_offset = offset; lib_req_id = request; return true; }
bool pro_cable_library_supported(void) { return true; }
void pro_voice_begin(const char *agent) { (void)agent; }
void pro_voice_end(bool send) { (void)send; }
bool pro_voice_open(void) { return false; }
bool pro_voice_start_pending(void) { return false; }
bool pro_voice_waiting(void) { return false; }
void pro_voice_close(void) {}
void pro_voice_link_lost(void) {}
void pro_voice_tick(uint32_t t) { (void)t; }

static ht_scene_t scene;
static uint16_t px[720 * 720];
static volatile const char *g_phase = "init";
static volatile int g_step;
static volatile uint32_t g_wake_min = 0xffffffff, g_zero_wakes;
static long g_views[16], g_maxtabs;

static void on_alarm(int sig)
{
    (void)sig;
    char buf[256];
    int n = snprintf(buf, sizeof buf, "HANG: step %d in %s (view %d depth %d tabs %d)\n", g_step, g_phase,
                     U.nav.depth ? (int)U.nav.stack[U.nav.depth - 1].view : -1, U.nav.depth, U.model.tab_count);
    write(2, buf, (size_t)n);
    abort();
}

static uint32_t rnd_state = 12345;
static uint32_t rnd(void) { rnd_state = rnd_state * 1103515245u + 12345u; return rnd_state >> 8; }

static char agent_id[400][ID_MAX];   // a pool of uuids
static void mk_ids(void) { for (int i = 0; i < 400; i++) snprintf(agent_id[i], ID_MAX, "%08x-22d4-49d5-8fd6-%012x", 0xb4bf0000u + i, i * 7919); }

// The render task's body once, then a full raster of the scene (pod_draw's cell_raster etc.).
static void render_pass(void)
{
    g_phase = "tick"; pro_app_tick(); CHECK(LOCK_DEPTH == 0);
    g_phase = "take_scene";
    bool fresh = pro_app_take_scene(&scene); CHECK(LOCK_DEPTH == 0);
    g_phase = "next_wake";
    uint32_t w = pro_app_next_wake_ms(); CHECK(LOCK_DEPTH == 0);
    if (w < g_wake_min) g_wake_min = w;
    if (w == 0) g_zero_wakes++;
    if (fresh && U.nav.depth) { g_views[U.nav.stack[U.nav.depth - 1].view & 15]++; if (U.model.tab_count > g_maxtabs) g_maxtabs = U.model.tab_count; }
    if (fresh) { g_phase = "raster"; ht_raster(&scene, (ht_rect_t){0, 0, 720, 720}, px); }
    g_phase = "feed";
}

static cable_swarm_t sw[SWARMS_MAX];
static cable_swarm_members_t mem;
static cable_tile_t tiles[SWARM_TILES_MAX];
static int ntabs = 1, roster_agent;

static void send_swarms(int n, int sel, int tile_n, int base)
{
    memset(sw, 0, sizeof sw); memset(&mem, 0, sizeof mem); memset(tiles, 0, sizeof tiles);
    for (int i = 0; i < n; i++) {
        snprintf(sw[i].id, SWARM_ID_MAX, "%032x", 0x98fa245du + (unsigned)i);
        snprintf(sw[i].name, CABLE_NAME_MAX, "Tab %d", i);
        int c = (int)(rnd() % 3);   // new tabs: 0..2 agents
        if (rnd() % 8 == 0) c = (int)(rnd() % (SWARM_MEMBERS_MAX + 1));
        sw[i].agents = c; sw[i].panes = c + (int)(rnd() % 2);
        mem.count[i] = (uint8_t)c;
        for (int k = 0; k < c; k++) {
            int a = (base + i * 3 + k) % 400;
            snprintf(mem.id[i][k], ID_MAX, "%s", agent_id[a]);
            mem.meta[i][k].has = rnd() % 2;
            mem.meta[i][k].online = true;
            snprintf(mem.meta[i][k].name, CABLE_NAME_MAX, "Agent %d", a);
            snprintf(mem.meta[i][k].engine, 12, "claude");
            snprintf(mem.meta[i][k].machine, CABLE_NAME_MAX, "Diego's Mac");
        }
    }
    for (int k = 0; k < tile_n; k++) {
        tiles[k] = (cable_tile_t){(int16_t)(k * 1000 / tile_n), 0, (int16_t)((k + 1) * 1000 / tile_n), 1000, ""};
        if (mem.count[sel] > k) snprintf(tiles[k].agent_id, ID_MAX, "%s", mem.id[sel][k]);
        else if (rnd() % 2) snprintf(tiles[k].agent_id, ID_MAX, "%s", agent_id[rnd() % 400]);
    }
    pro_app_swarms(sw, n, &mem, n ? sw[sel].id : NULL, tiles, tile_n);
    CHECK(LOCK_DEPTH == 0);
}

static void send_agents(int a)
{
    pro_agent_row_t r = {agent_id[a], "", "claude", "mid", "Diego's Mac"};
    pro_app_agents(&r, 1);
}

static void answer_library(void)
{
    if (lib_req_offset < 0) return;
    pro_library_row_t rows[6];
    char names[6][32];
    int total = 39, count = 0;
    for (int i = 0; i < 6 && lib_req_offset + i < total; i++) {
        snprintf(names[i], sizeof names[i], "Lib %d", lib_req_offset + i);
        static const char *st[] = {"idle", "working", "question", "finished", "failed", "offline"};
        rows[i] = (pro_library_row_t){agent_id[(lib_req_offset + i) * 5 % 400], names[i], "claude", "Diego's Mac", st[rnd() % 6], (int32_t)(rnd() % 100000)};
        count++;
    }
    int off = lib_req_offset;
    lib_req_offset = -1;
    pro_app_library(rows, count, off, total);
}

int main(int argc, char **argv)
{
    long iters = argc > 1 ? atol(argv[1]) : 20000;
    if (argc > 2) rnd_state = (uint32_t)atol(argv[2]);
    signal(SIGALRM, on_alarm);
    mk_ids();
    pro_app_start();
    pro_app_link(true, "Diego's Mac");
    render_pass();
    for (long it = 0; it < iters; it++) {
        g_step = (int)it;
        alarm(2);
        int base = (int)(it / 7);
        switch (rnd() % 10) {
        case 0: case 1: case 2: {   // the 03:28 burst: new tab, agents, focus, swarms 0 tiles then 2 tiles
            if (ntabs < SWARMS_MAX && rnd() % 3 == 0) ntabs++;
            if (rnd() % 40 == 0) ntabs = 1 + (int)(rnd() % SWARMS_MAX);
            int sel = (int)(rnd() % (unsigned)ntabs);
            roster_agent = (base + sel * 3) % 400;
            send_swarms(ntabs, sel, 0, base);
            send_agents(roster_agent);
            pro_app_focus(agent_id[rnd() % 3 ? roster_agent : rnd() % 400]);
            render_pass();
            send_swarms(ntabs, sel, 2, base);
            break;
        }
        case 3: send_swarms(ntabs, (int)(rnd() % (unsigned)ntabs), (int)(rnd() % 3) ? 2 : (int)(rnd() % (SWARM_TILES_MAX + 1)), base); break;
        case 4: pro_app_focus(agent_id[rnd() % 400]); break;
        case 5: answer_library(); break;
        case 6: {   // a tap somewhere on the glass
            int x = (int)(rnd() % 720), y = (int)(rnd() % 720);
            pro_app_touch(true, x, y); now += 40; pro_app_touch(false, x, y);
            break;
        }
        case 7: {
            static const char *k[] = {"started", "activity", "step", "done", "verb"};
            pro_app_turn(agent_id[roster_agent], k[rnd() % 5], "Reading files", -1);
            break;
        }
        case 8: if (rnd() % 50 == 0) { pro_app_link(false, NULL); pro_app_link(true, "Diego's Mac"); } break;
        default: break;
        }
        CHECK(LOCK_DEPTH == 0);
        render_pass();
        now += 1 + rnd() % (rnd() % 10 ? 400 : 6000);
        render_pass();
    }
    alarm(0);
    printf("stress_pro_app: %ld steps, no hang; min wake %u ms, zero wakes %u\n", iters, (unsigned)g_wake_min, (unsigned)g_zero_wakes);
    printf("frames per view:");
    for (int v = 0; v < 16; v++) if (g_views[v]) printf(" v%d=%ld", v, g_views[v]);
    printf("; most tabs %ld\n", g_maxtabs);
    return 0;
}
