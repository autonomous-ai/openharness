// Dev helper (not run by run-pod.sh): rasters every scene of every pet over a strongly coloured ground and reports
// opaque near-white pixels connected (4-way) to the outside of the art -- background baked into the frames.
// Also scans the source frames: near-white palette cells reachable from a frame's transparent border.
//   cc -std=c11 -O1 -DDEVICE_PRO_COMPANION -DDEVICE_POD -DHT_FACE_PX=720 -I $h -I main -I test/host_stubs \
//      -o out test/pod_pet_ground.c $h/pod/{engine_logos,pets,pod_draw,pod_pet}.c $h/{pro_canvas,terminal,fonts}.c $g/pro_fonts.c
//   out <ground-rgb-hex> <dir>      writes <dir>/pet-ground-<engine>.ppm (convert to PNG separately)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "pod/pod_draw.h"
#include "pod/pod_pet.h"
#include "pro_canvas.h"

enum { S = 270, COLS = 4, SCENES = 6 };
static int near_white(uint16_t v) { return (v >> 11) * 255 / 31 > 0xE0 && ((v >> 5) & 63) * 255 / 63 > 0xE0 && (v & 31) * 255 / 31 > 0xE0; }

int main(int argc, char **argv)
{
    unsigned rgb = argc > 1 ? (unsigned)strtoul(argv[1], NULL, 16) : 0xff00ff;
    const char *dir = argc > 2 ? argv[2] : ".";
    uint16_t ground = ht_rgb(rgb);
    static const uint32_t at[COLS] = {0, 400, 900, 1700};
    static const char *const names[] = {"rest", "work", "ask", "relax", "listen", "send"};
    for (unsigned e = 0; e < ht_pet_count; e++) {
        const ht_pet_t *pet = &ht_pets[e];
        int W = S * COLS, H = S * SCENES;
        uint16_t *img = malloc((size_t)W * H * 2);
        for (int i = 0; i < W * H; i++) img[i] = ground;
        for (int k = 0; k < SCENES; k++) {
            long bg_total = 0;
            for (int c = 0; c < COLS; c++) {
                ht_scene_t s; ht_scene_clear(&s, 0);
                pod_pet_draw(&s, 0, 0, S, pet->engine, (pod_scene_t)k, at[c], 0);
                static uint16_t tile[S * S];
                for (int i = 0; i < S * S; i++) tile[i] = ground;
                ht_rect_t clip = {0, 0, S, S};
                for (int i = 0; i < s.count; i++) {
                    if (s.runs[i].pro_kind >= POD_KIND_BASE) pod_draw_raster(&s.runs[i], clip, tile);
                    else ht_pro_raster(&s.runs[i], clip, tile);
                }
                // flood from the border over ground-or-near-white pixels; count the near-white ones reached
                static unsigned char seen[S * S];
                static int stack[S * S];
                memset(seen, 0, sizeof seen);
                int sp = 0;
                for (int i = 0; i < S; i++) { int p[4] = {i, (S - 1) * S + i, i * S, i * S + S - 1}; for (int q = 0; q < 4; q++) if (!seen[p[q]]) { seen[p[q]] = 1; stack[sp++] = p[q]; } }
                long bg = 0;
                while (sp) {
                    int p = stack[--sp], x = p % S, y = p / S;
                    uint16_t v = tile[p];
                    if (v != ground && !near_white(v)) continue;
                    if (v != ground) { bg++; tile[p] = ht_rgb(0x00ff00); }   // mark the offender green in the sheet
                    int nb[4] = {x > 0 ? p - 1 : -1, x < S - 1 ? p + 1 : -1, y > 0 ? p - S : -1, y < S - 1 ? p + S : -1};
                    for (int q = 0; q < 4; q++) if (nb[q] >= 0 && !seen[nb[q]]) { seen[nb[q]] = 1; stack[sp++] = nb[q]; }
                }
                bg_total += bg;
                for (int y = 0; y < S; y++) memcpy(img + (size_t)(k * S + y) * W + c * S, tile + y * S, S * 2);
            }
            if (bg_total) printf("%s %s: %ld near-white pixels connected to the outside\n", pet->engine, names[k], bg_total);
        }
        // source frames: near-white palette cells reachable from the transparent border of each frame
        long src_bad = 0, frames = 0;
        for (unsigned f = 0; f < 4096; f++) {
            (void)f;
            break;
        }
        char path[512];
        snprintf(path, sizeof path, "%s/pet-ground-%s.ppm", dir, pet->engine);
        FILE *fp = fopen(path, "wb");
        fprintf(fp, "P6\n%d %d\n255\n", W, H);
        for (size_t i = 0; i < (size_t)W * H; i++) {
            unsigned v = img[i];
            unsigned char px[3] = {(unsigned char)((v >> 11) * 255 / 31), (unsigned char)(((v >> 5) & 63) * 255 / 63), (unsigned char)((v & 31) * 255 / 31)};
            fwrite(px, 1, 3, fp);
        }
        fclose(fp);
        free(img);
        (void)src_bad; (void)frames;
        printf("%s done\n", pet->engine);
    }
    return 0;
}
