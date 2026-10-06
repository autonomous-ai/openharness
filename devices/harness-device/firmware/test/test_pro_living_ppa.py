"""Exercise the hardware scaler contract and its software fallback under sanitizers.

This models DMA completion, not the PPA interpolation algorithm. The pinned SDK
build and physical color readback/cadence establish the hardware behavior.
"""
from pathlib import Path
import os
import subprocess
import tempfile
import test_pro_living as renderer

HEADER = r'''
#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef int esp_err_t;
enum { ESP_OK, PPA_OPERATION_SRM, PPA_SRM_COLOR_MODE_RGB565, PPA_TRANS_MODE_BLOCKING };
typedef void *ppa_client_handle_t;
typedef struct { unsigned oper_type,max_pending_trans_num; } ppa_client_config_t;
typedef struct { const void *buffer; unsigned pic_w,pic_h,block_w,block_h,srm_cm; } input_t;
typedef struct { void *buffer; unsigned buffer_size,pic_w,pic_h,srm_cm; } output_t;
typedef struct { input_t in;output_t out;float scale_x,scale_y;unsigned mode; } ppa_srm_oper_config_t;
esp_err_t ppa_register_client(const ppa_client_config_t *,ppa_client_handle_t *);
esp_err_t ppa_unregister_client(ppa_client_handle_t);
esp_err_t ppa_do_scale_rotate_mirror(ppa_client_handle_t,const ppa_srm_oper_config_t *);
'''
CODE = r'''
#include "pro_living.h"
#include "driver/ppa.h"
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <zlib.h>
static unsigned allocations, calls, registrations, removals, failure;
void *test_allocate(size_t n){allocations++;return malloc(n);}
void *test_aligned(size_t a,size_t n){allocations++;return aligned_alloc(a,n);}
size_t test_inflate(void *d,size_t cap,const void *s,size_t n){uLongf got=cap;return uncompress(d,&got,s,n)==Z_OK?got:(size_t)-1;}
esp_err_t ppa_register_client(const ppa_client_config_t *c,ppa_client_handle_t *h){
    assert(c->oper_type==PPA_OPERATION_SRM&&c->max_pending_trans_num==1);registrations++;
    if(failure==1)return -1;*h=&calls;return ESP_OK;
}
esp_err_t ppa_unregister_client(ppa_client_handle_t h){assert(h==&calls);removals++;return ESP_OK;}
esp_err_t ppa_do_scale_rotate_mirror(ppa_client_handle_t h,const ppa_srm_oper_config_t *c){
    assert(h==&calls&&c->in.buffer!=c->out.buffer);
    assert(c->mode==PPA_TRANS_MODE_BLOCKING&&c->scale_x==2&&c->scale_y==2);
    assert(c->in.pic_w==320&&c->in.pic_h==320&&c->in.block_w==320&&c->in.block_h==320);
    assert(c->out.pic_w==640&&c->out.pic_h==640&&c->out.buffer_size==640*640*2);
    assert(c->in.srm_cm==PPA_SRM_COLOR_MODE_RGB565&&c->out.srm_cm==c->in.srm_cm);
    assert(((uintptr_t)c->out.buffer%64)==0&&c->out.buffer_size%64==0);calls++;
    if(failure==3&&calls==2)return -1;
    if(failure==4)return -1;
    const uint16_t *src=c->in.buffer;uint16_t *dst=c->out.buffer;
    for(unsigned y=0;y<640;y++)for(unsigned x=0;x<640;x++)dst[y*640+x]=src[(y/2)*320+x/2];
    if(failure==2)memset(dst,0,c->out.buffer_size);
    return ESP_OK;
}
static void frame(unsigned f,unsigned size){
    ht_scene_t scene;ht_scene_clear(&scene,0);pro_living_image(&scene,1,0,f,0,0,size);pro_living_prepare(&scene);
    assert(scene.runs[0].bitmap.pixels&&scene.runs[0].bitmap.width==size);
    const uint16_t *p=scene.runs[0].bitmap.pixels;unsigned nonzero=0;
    for(unsigned i=0;i<size*size;i++)nonzero+=p[i]!=0;assert(nonzero>size*size/2);
}
int main(int argc,char **argv){
    assert(argc==2);failure=(unsigned)atoi(argv[1]);pro_living_init();pro_living_init();
    assert(allocations==4&&registrations==1);
    unsigned initial=calls;frame(0,384);assert(calls==initial);
    frame(1,640);unsigned once=calls;frame(1,640);assert(calls==once);frame(2,640);
    assert(allocations==4);
    assert(calls==(failure==0?3:failure==1?0:failure==3?2:1));
    assert(removals==(failure>1?1:0));
    printf("PPA adapter case %u: dimensions, alignment, blocking fence, readback and fallback PASS\n",failure);
}
'''


def main():
    with tempfile.TemporaryDirectory(prefix="harness-pro-ppa-") as directory:
        out = Path(directory)
        (out / "driver").mkdir()
        (out / "driver/ppa.h").write_text(HEADER)
        (out / "test.c").write_text(CODE)
        (out / "esp_heap_caps.h").write_text("#include <stddef.h>\n#define MALLOC_CAP_SPIRAM 1\n#define MALLOC_CAP_8BIT 2\nvoid *test_allocate(size_t);void *test_aligned(size_t,size_t);\n#define heap_caps_malloc(n,f) test_allocate(n)\n#define heap_caps_aligned_alloc(a,n,f) test_aligned(a,n)\n")
        (out / "esp_timer.h").write_text("#include <stdint.h>\nstatic inline int64_t esp_timer_get_time(void){static int64_t t;return ++t;}\n")
        (out / "esp_log.h").write_text("#include <stdio.h>\n#define ESP_LOGI(tag,...) do { printf(__VA_ARGS__);puts(\"\"); } while(0)\n#define ESP_LOGW ESP_LOGI\n")
        (out / "miniz.h").write_text("#include <stddef.h>\n#define TINFL_FLAG_PARSE_ZLIB_HEADER 1\nsize_t test_inflate(void*,size_t,const void*,size_t);\n#define tinfl_decompress_mem_to_mem(d,c,s,n,f) test_inflate(d,c,s,n)\n")
        pack = str((renderer.GENERATED / "pro_living.pack").resolve())
        (out / "art.S").write_text('#ifdef __APPLE__\n.section __DATA,__const\n#else\n.section .rodata\n#endif\n.balign 8\n.globl _binary_pro_living_pack_start\n_binary_pro_living_pack_start:\n.incbin "' + pack + '"\n.globl _binary_pro_living_pack_end\n_binary_pro_living_pack_end:\n')
        binary = out / "test"
        subprocess.run([os.environ.get("CC", "cc"), "-std=gnu11", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
                        "-fsanitize=address,undefined,bounds", "-fno-omit-frame-pointer", "-DESP_PLATFORM=1",
                        "-DHT_FACE_PX=720", "-DDEVICE_PRO_COMPANION=1", "-I", str(out), "-I", str(renderer.NATIVE), "-I", str(renderer.GENERATED),
                        str(out / "test.c"), str(out / "art.S"),
                        *[str(renderer.NATIVE / (name + ".c")) for name in ("pro_living", "pro_canvas", "terminal", "fonts")],
                        str(renderer.GENERATED / "pro_fonts.c"), "-lz", "-o", str(binary)], check=True)
        env = dict(os.environ, ASAN_OPTIONS="detect_leaks=0:abort_on_error=1", UBSAN_OPTIONS="halt_on_error=1:print_stacktrace=1")
        for case in range(5):
            subprocess.run([str(binary), str(case)], env=env, check=True, timeout=20)


if __name__ == "__main__":
    main()
