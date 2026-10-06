"""Exercise the real living renderer: bounded caches, animation and damage parity."""
from pathlib import Path
import os, subprocess, sys, tempfile
HERE=Path(__file__).resolve().parent
NATIVE=HERE.parent/'main/ui/habitat'
GENERATED=HERE.parents[1]/'prototype/pro-companion/generated'

CODE = r'''
#include "pro_living.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
size_t allocations, inflates;
void *test_allocate(size_t n){allocations++;return malloc(n);}
size_t test_inflate(void *dst,size_t cap,const void *src,size_t n){uLongf got=cap;inflates++;return uncompress(dst,&got,src,n)==Z_OK?got:(size_t)-1;}
static uint16_t pixels[720*720], incremental[720*720], strip[720*720];
static uint32_t hash(const uint16_t *p,unsigned n){uint32_t h=2166136261;for(unsigned i=0;i<n;i++)h=(h^p[i])*16777619;return h;}
static void save(const char *dir,unsigned c,unsigned m,unsigned f){
    if(!dir)return;char path[1024];snprintf(path,sizeof path,"%s/%u-%u-%03u.ppm",dir,c,m,f);
    FILE *out=fopen(path,"wb");assert(out);fprintf(out,"P6\n384 384\n255\n");
    for(unsigned y=0;y<384;y++)for(unsigned x=0;x<384;x++){
        unsigned v=pixels[(y+172)*720+x+168];unsigned char rgb[3]={(v>>11)*255/31,((v>>5)&63)*255/63,(v&31)*255/31};fwrite(rgb,1,3,out);
    }
    fclose(out);
}
int main(void){
    pro_living_init();assert(allocations==4);pro_living_init();assert(allocations==4);
    ht_scene_t old={0},s;const char *dir=getenv("PRO_LIVING_PREVIEW_DIR");unsigned frames=0;
    for(unsigned c=0;c<3;c++)for(unsigned m=0;m<PRO_LIVING_MOODS;m++){
        uint32_t first=0;unsigned changes=0;
        for(unsigned f=0;f<PRO_LIVING_FRAMES;f++){
            if(f%4 && f!=1 && f!=78 && f!=79 && f!=80 && f!=182 && f!=183 && f!=PRO_LIVING_FRAMES-1)continue;
            size_t before=inflates;
            ht_scene_clear(&s,ht_rgb(0x101019));pro_living_image(&s,c,m,f,168,172,384);
            assert(inflates==before&&allocations==4&&!s.runs[0].bitmap.pixels);
            pro_living_prepare(&s);assert(!s.runs[0].bitmap.asset&&s.runs[0].bitmap.pixels);
            ht_damage_t damage;ht_damage(&old,&s,&damage);
            for(unsigned j=0;j<damage.count;j++){
                ht_rect_t r=damage.rect[j];ht_raster(&s,r,strip);
                for(int y=0;y<r.h;y++)memcpy(incremental+(r.y+y)*720+r.x,strip+y*r.w,r.w*2);
            }
            ht_raster(&s,(ht_rect_t){0,0,720,720},pixels);
            assert(!memcmp(pixels,incremental,sizeof pixels));
            uint32_t h=hash(pixels,720*720);if(!f)first=h;else changes+=h!=first;
            if(!f || (c==1 && m==0 && f%4==0))save(dir,c,m,f);
            old=s;frames++;
        }
        assert(changes>35); // Every mood actually moves, including sleep.
    }
    ht_scene_clear(&s,0);pro_living_image(&s,2,3,80,40,40,640);pro_living_prepare(&s);
    ht_raster(&s,(ht_rect_t){0,0,720,720},pixels);
    assert(allocations==4);
    assert(pro_living_frame(PRO_LIVING_FRAMES*PRO_LIVING_STEP_MS)==0&&pro_living_frame(PRO_LIVING_STEP_MS)==1);
    printf("Living renderer: %u real frames, 21 character/mood combinations, damage parity, blink, fullscreen and fixed-cache switching PASS\n",frames);
}
'''

def main():
    with tempfile.TemporaryDirectory(prefix="harness-pro-visual-") as directory:
        out=Path(directory)
        (out/"test.c").write_text(CODE)
        (out/"esp_heap_caps.h").write_text("#pragma once\n#include <stddef.h>\n#define MALLOC_CAP_SPIRAM 1\n#define MALLOC_CAP_8BIT 2\nvoid *test_allocate(size_t);\nstatic inline void *heap_caps_malloc(size_t n,unsigned flags){(void)flags;return test_allocate(n);}\n")
        (out/"esp_log.h").write_text("#pragma once\n#define ESP_LOGI(...) ((void)0)\n")
        (out/"miniz.h").write_text("#pragma once\n#include <stddef.h>\n#define TINFL_FLAG_PARSE_ZLIB_HEADER 1\nsize_t test_inflate(void*,size_t,const void*,size_t);\nstatic inline size_t tinfl_decompress_mem_to_mem(void *d,size_t c,const void *s,size_t n,int f){(void)f;return test_inflate(d,c,s,n);}\n")
        pack=str((GENERATED/"pro_living.pack").resolve()).replace("\\","\\\\").replace('"','\\"')
        (out/"art.S").write_text('#ifdef __APPLE__\n.section __DATA,__const\n#else\n.section .rodata\n#endif\n.balign 8\n.globl _binary_pro_living_pack_start\n_binary_pro_living_pack_start:\n.incbin "'+pack+'"\n.globl _binary_pro_living_pack_end\n_binary_pro_living_pack_end:\n')
        binary=out/"test"
        subprocess.run([os.environ.get("CC","cc"),"-std=gnu11","-O1","-g","-Wall","-Wextra","-Werror",
                        "-fsanitize="+os.environ.get("SANITIZERS","address,undefined,bounds"),"-fno-omit-frame-pointer",
                        "-DHT_FACE_PX=720","-DDEVICE_PRO_COMPANION=1","-I",str(out),"-I",str(NATIVE),"-I",str(GENERATED),
                        str(out/"test.c"),str(out/"art.S"),*[str(NATIVE/(name+".c")) for name in ("pro_living","pro_canvas","terminal","fonts")],
                        str(GENERATED/"pro_fonts.c"),"-lz","-o",str(binary)],check=True)
        env=dict(os.environ)
        env.setdefault("ASAN_OPTIONS",("detect_leaks=0:" if sys.platform=="darwin" else "detect_leaks=1:")+"abort_on_error=1")
        env.setdefault("UBSAN_OPTIONS","halt_on_error=1:print_stacktrace=1")
        subprocess.run([str(binary)],env=env,check=True,timeout=120)


if __name__=="__main__":
    main()
