"""Exercise the production OTA state machine with bounded, faulting fake flash.

No USB, partitions, boot settings or actual device hardware are accessed. The
crypto stub checks byte coverage/order; SHA-256 itself belongs to the SDK.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = Path(os.environ.get('FW_UPDATE_SOURCE', str(main / 'fw_update.c'))).read_text()
source = re.sub(r'^#include .*\n', '', source, flags=re.M)
code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include <limits.h>
typedef int esp_err_t;
typedef unsigned esp_ota_handle_t;
typedef int esp_ota_img_states_t;
typedef struct { uint32_t size; const char *label; } esp_partition_t;
typedef struct { char version[32]; } esp_app_desc_t;
typedef struct { uint32_t hash; size_t bytes; } mbedtls_sha256_context;
enum { ESP_OK=0, ESP_OTA_IMG_PENDING_VERIFY=1 };
#define pdMS_TO_TICKS(ms) (ms)
static const esp_partition_t slot={8192,"inactive"}, running={8192,"running"};
static uint8_t flash[8192], image[8192];
static int fault, hash_fault, image_state;
static bool voice, missing_slot, handle_live, corrupt_read, confirmed_log;
static unsigned erases, writes, reads, aborts, accepts, progress, errors, done, reboots, boots, ui_closed, marks;
static uint32_t write_offset, ack;
static int64_t clock_us;
static char offered_version[32], error_text[96], hash_hex[65];
static void log_message(const char *tag,const char *fmt,...) {
    (void)tag; if(strstr(fmt,"image confirmed")) confirmed_log=true;
}
#define ESP_LOGI(...) log_message(__VA_ARGS__)
#define ESP_LOGW(...) log_message(__VA_ARGS__)
#define ESP_LOGE(...) log_message(__VA_ARGS__)
static const char *esp_err_to_name(int err) { (void)err; return "fake error"; }
static int64_t esp_timer_get_time(void) { return clock_us; }
static bool audio_client_active(void) { return voice; }
static const esp_partition_t *esp_ota_get_running_partition(void) { return &running; }
static int esp_ota_get_state_partition(const esp_partition_t *p,int *state) {
    assert(p==&running); *state=image_state; return fault==8;
}
static int esp_ota_mark_app_valid_cancel_rollback(void) { marks++; return fault==9; }
static const esp_app_desc_t *esp_app_get_description(void) {
    static const esp_app_desc_t desc={"current"}; return &desc;
}
static const esp_partition_t *esp_ota_get_next_update_partition(const void *p) {
    assert(!p); return missing_slot ? NULL : &slot;
}
static int esp_ota_begin(const esp_partition_t *p,int size,esp_ota_handle_t *h) {
    assert(p==&slot && size>0 && size<=8192 && !handle_live);
    erases++; if(fault==1)return 1;
    memset(flash,0xff,sizeof flash); handle_live=true; *h=17; write_offset=0;
    return fault==10; // SDK failure after a partial handle was exposed.
}
static int esp_ota_abort(esp_ota_handle_t h) { assert(h==17 && handle_live); handle_live=false; aborts++; return 0; }
static int esp_ota_write(esp_ota_handle_t h,const void *data,size_t n) {
    assert(h==17 && handle_live && n<=sizeof flash-write_offset);
    writes++; if(fault==2)return 1;
    memcpy(flash+write_offset,data,n); write_offset+=(uint32_t)n; return 0;
}
static int esp_ota_end(esp_ota_handle_t h) { assert(h==17 && handle_live); handle_live=false; return fault==3; }
static int esp_partition_read(const esp_partition_t *p,uint32_t offset,void *out,size_t n) {
    assert(p==&slot && offset==reads*1024u && n<=1024 && n<=sizeof flash-offset);
    reads++; if(fault==4)return 1;
    memcpy(out,flash+offset,n); if(corrupt_read && n)((uint8_t *)out)[0]^=1; return 0;
}
static int esp_ota_get_partition_description(const esp_partition_t *p,esp_app_desc_t *desc) {
    assert(p==&slot); snprintf(desc->version,sizeof desc->version,"%s",fault==6 ? "wrong-image" : offered_version);
    return fault==5;
}
static int esp_ota_set_boot_partition(const esp_partition_t *p) { assert(p==&slot); if(fault==7)return 1; boots++;return 0; }
static void esp_restart(void) { reboots++; }
static void vTaskDelay(unsigned ticks) { assert(ticks==400); }
static void ui_show_projects(void) { ui_closed++; }
static void ui_ota_boot_show(const char *v) { snprintf(offered_version,sizeof offered_version,"%s",v); }
static void ui_ota_boot_pct(int pct) { assert(pct>=0 && pct<=100); }
static void ui_show_ota_restarting(void) {}
static void cable_client_fw_error(const char *s) { errors++; snprintf(error_text,sizeof error_text,"%s",s); }
static void cable_client_fw_accept(void) { accepts++; }
static void cable_client_fw_progress(uint32_t written) { assert(written>=ack && written<=sizeof flash); progress++;ack=written; }
static void cable_client_fw_done(void) { done++; }
static void mbedtls_sha256_init(mbedtls_sha256_context *ctx) { *ctx=(mbedtls_sha256_context){2166136261u,0}; }
static void mbedtls_sha256_free(mbedtls_sha256_context *ctx) { (void)ctx; }
static int mbedtls_sha256_starts(mbedtls_sha256_context *ctx,int mode) { (void)ctx;assert(!mode);return hash_fault==1; }
static int mbedtls_sha256_update(mbedtls_sha256_context *ctx,const uint8_t *p,size_t n) {
    if(hash_fault==2)return 1;
    for(size_t i=0;i<n;i++)ctx->hash=(ctx->hash^p[i])*16777619u;
    ctx->bytes+=n;return 0;
}
static int mbedtls_sha256_finish(mbedtls_sha256_context *ctx,uint8_t *digest) {
    if(hash_fault==3)return 1;
    for(unsigned i=0;i<32;i++)digest[i]=(uint8_t)((ctx->hash>>(8*(i%4)))^(ctx->bytes+i));
    return 0;
}
'''
code += source
if "void fw_update_tick(" not in source:
    code += "static void fw_update_tick(void) {}\n"
code += r'''
static void reset(void) {
    assert(!s_active && !handle_live);
    reset_state(); fault=hash_fault=image_state=0;
    voice=missing_slot=corrupt_read=confirmed_log=false;
    erases=writes=reads=aborts=accepts=progress=errors=done=reboots=boots=ui_closed=marks=0;
    ack=write_offset=0; clock_us=123456;
    error_text[0]=0;
}
static void hash_image(size_t n) {
    mbedtls_sha256_context ctx;mbedtls_sha256_init(&ctx);
    assert(!mbedtls_sha256_update(&ctx,image,n));uint8_t digest[32];
    assert(!mbedtls_sha256_finish(&ctx,digest));
    for(unsigned i=0;i<32;i++)snprintf(hash_hex+i*2,3,"%02x",digest[i]);
}
static void begin(size_t n) { hash_image(n);assert(fw_update_offer("test.64",(int)n,hash_hex));assert(s_active && handle_live && accepts==1); }
int main(void) {
    (void)esp_timer_get_time; (void)esp_ota_get_partition_description;
    for(unsigned i=0;i<sizeof image;i++)image[i]=(uint8_t)(i*31+i/7);
    if(getenv("OTA_ONLY_OVERFLOW")) {
        reset();begin(1500);fw_update_slice(image,100);fw_update_slice(image,SIZE_MAX);
        assert(!s_active && !handle_live && errors==1 && writes==1);
        puts("OTA oversized slice refused before flash write");return 0;
    }
    reset(); hash_image(1500);
    assert(!fw_update_offer(NULL,1500,hash_hex));
    assert(!fw_update_offer("",1500,hash_hex));
    assert(!fw_update_offer("01234567890123456789012345678901",1500,hash_hex));
    assert(!fw_update_offer("valid",0,hash_hex));
    assert(!fw_update_offer("valid",INT_MAX,hash_hex));
    assert(!fw_update_offer("valid",1500,NULL));
    assert(!fw_update_offer("valid",1500,"abc"));
    char invalid[65];memset(invalid,'x',64);invalid[64]=0;
    assert(!fw_update_offer("valid",1500,invalid) && !erases);
    voice=true;assert(!fw_update_offer("valid",1500,hash_hex) && !erases);voice=false;
    missing_slot=true;assert(!fw_update_offer("valid",1500,hash_hex) && !erases);missing_slot=false;
    for(int f=1;f<=10;f+=9) {
        reset();hash_image(1500);fault=f;
        assert(!fw_update_offer("valid",1500,hash_hex));
        assert(!fw_update_active() && !handle_live && !accepts && !reboots && ui_closed==1);
    }
    reset();begin(1500);assert(!fw_update_offer("second",1500,hash_hex) && erases==1);
    fw_update_slice(NULL,100);fw_update_slice(image,0);assert(!writes);
    fw_update_slice(image,100);assert(writes==1 && ack==100);
    fw_update_slice(image,SIZE_MAX);assert(!s_active && aborts==1 && errors==1 && writes==1 && !boots);
    fw_update_slice(image,100);assert(writes==1);fw_update_abort("already gone");assert(aborts==1);
    reset();begin(1500);fw_update_slice(image,100);fw_update_abort("unplugged");
    assert(!s_active && aborts==1 && !errors && !boots);
    reset();begin(1500);clock_us+=14999999;fw_update_tick();assert(s_active);
    clock_us++;fw_update_tick();assert(!s_active && errors==1 && aborts==1 && !boots);
    fw_update_tick();assert(errors==1);
    reset();clock_us=(INT64_C(1)<<32)-100;begin(1500);clock_us+=14999999;fw_update_slice(image,100);
    clock_us+=14999999;fw_update_tick();assert(s_active);clock_us++;fw_update_tick();assert(!s_active);
    for(int f=2;f<=7;f++) {
        reset();begin(1500);fault=f;fw_update_slice(image,1500);
        assert(!s_active && !handle_live && errors==1 && !boots && !done && !reboots);
        assert(aborts==(f==2));
    }
    for(int f=1;f<=3;f++) {
        reset();begin(1500);hash_fault=f;fw_update_slice(image,1500);
        assert(!s_active && !handle_live && errors==1 && !boots);
    }
    reset();begin(1500);corrupt_read=true;fw_update_slice(image,1500);assert(errors==1 && !boots && !s_active);
    // Valid image, uppercase manifest hash, exact read-back and version match.
    reset();hash_image(1500);for(unsigned i=0;i<64;i++)if(hash_hex[i]>='a' && hash_hex[i]<='f')hash_hex[i]+='A'-'a';
    assert(fw_update_offer("test.64",1500,hash_hex));
    fw_update_slice(image,100);fw_update_slice(image+100,1024);fw_update_slice(image+1124,376);
    assert(done==1 && reboots==1 && boots==1 && !errors && !s_active && !handle_live && reads==2 && ack==1500 && progress==3);
    // Flash writes and read-back can cross every chunk boundary without exceeding buffers.
    for(unsigned n=1;n<=8192;n+=17) {
        reset();begin(n);
        for(unsigned offset=0;offset<n;) {
            unsigned chunk=1+((offset*37+n)%1511);if(chunk>n-offset)chunk=n-offset;
            fw_update_slice(image+offset,chunk);offset+=chunk;
        }
        assert(done==1 && reboots==1 && boots==1 && !errors && !s_active && !handle_live);
        assert(reads==(n+1023)/1024);
    }
    reset();fw_mark_valid();assert(!marks && !confirmed_log);
    image_state=ESP_OTA_IMG_PENDING_VERIFY;fault=8;fw_mark_valid();assert(!marks);
    fault=9;fw_mark_valid();assert(marks==1 && !confirmed_log);
    fault=0;fw_mark_valid();assert(marks==2 && confirmed_log);
    puts("OTA: malformed offers, overflow, stalled transfers, disconnect, 10 SDK failure paths, hash/version checks and 482 chunked images PASS (fake flash)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-ota-') as d:
    out = Path(d)
    (out / 'ota.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize='+os.environ.get('SANITIZERS', 'undefined,bounds'),
                    str(out/'ota.c'), '-o', str(out/'ota')], check=True)
    subprocess.run([str(out/'ota')], check=True)
