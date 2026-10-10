// Dev helper (not run by run-pod.sh): rasters each scene of claude, codex and muse at 4 clock points to a PPM.
// Build and run from devices/harness-device/firmware:
//   h=main/ui/habitat; g=../prototype/pro-companion/generated
//   cc -std=c11 -O1 -DDEVICE_PRO_COMPANION -DDEVICE_POD -DHT_FACE_PX=720 -I $h -I main -I test/host_stubs \
//      -o /tmp/claude-503/pod_pet_strip test/pod_pet_strip.c $h/pod/{engine_logos,pets,pod_draw,pod_pet}.c \
//      $h/{pro_canvas,terminal,fonts}.c $g/pro_fonts.c
//   /tmp/claude-503/pod_pet_strip /tmp/claude-503/pod_pets.ppm
// One row per engine x scene (REST WORK ASK RELAX LISTEN SEND), four 270 px cells per row (clock 0, 400, 900, 1700 ms).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "pod/pod_draw.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

enum { S = 270, COLS = 4, ROWS = 18 };
int main(int argc, char **argv)
{
    static const char *const eng[] = {"claude", "codex", "muse"};
    static const uint32_t at[COLS] = {0, 400, 900, 1700};
    int W = S * COLS, H = S * ROWS;
    uint16_t *img = calloc((size_t)W * H, 2);
    for (int e = 0; e < 3; e++)
        for (int k = 0; k < 6; k++)
            for (int c = 0; c < COLS; c++) {
                ht_scene_t s; ht_scene_clear(&s, 0);
                pod_pet_draw(&s, c * S, (e * 6 + k) * S, S, eng[e], (pod_scene_t)k, at[c], 0);
                ht_rect_t clip = {c * S, (e * 6 + k) * S, S, S};
                uint16_t *tile = calloc((size_t)S * S, 2);
                for (int i = 0; i < s.count; i++) {
                    if (s.runs[i].pro_kind >= POD_KIND_BASE) pod_draw_raster(&s.runs[i], clip, tile);
                    else ht_pro_raster(&s.runs[i], clip, tile);
                }
                for (int y = 0; y < S; y++) memcpy(img + (size_t)((e * 6 + k) * S + y) * W + c * S, tile + y * S, S * 2);
                free(tile);
            }
    FILE *f = fopen(argc > 1 ? argv[1] : "pod_pets.ppm", "wb");
    fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (size_t i = 0; i < (size_t)W * H; i++) {
        unsigned v = img[i];
        unsigned char rgb[3] = {(unsigned char)((v >> 11) * 255 / 31), (unsigned char)(((v >> 5) & 63) * 255 / 63),
                                (unsigned char)((v & 31) * 255 / 31)};
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    return 0;
}
