// Diagnostic only. Constructs messages in RAM; never calls the USB send path.
#include "cable_scroll.h"
#include "cJSON.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int compare(const void *a,const void *b)
{
    uint32_t x=*(const uint32_t*)a,y=*(const uint32_t*)b;
    return x<y?-1:x>y;
}
static char *original(int phase,int dy,int velocity)
{
    static const char *names[]={"down","move","up"};
    cJSON *root=cJSON_CreateObject();assert(root);
    assert(cJSON_AddStringToObject(root,"t","scroll"));
    assert(cJSON_AddStringToObject(root,"phase",names[phase]));
    assert(cJSON_AddNumberToObject(root,"dy",dy));
    if(phase==2)assert(cJSON_AddNumberToObject(root,"v",velocity));
    char *wire=cJSON_PrintUnformatted(root);cJSON_Delete(root);assert(wire);return wire;
}
void cable_scroll_benchmark(void)
{
    uint32_t times[40];char wire[CABLE_SCROLL_JSON_MAX];
    // Warm the same per-task libc paths before comparing allocations and time.
    for(int phase=0;phase<3;phase++) {
        char *old=original(phase,-466,6000);
        assert(cable_scroll_encode(wire,sizeof wire,phase,-466,6000)==strlen(old));
        assert(!strcmp(wire,old));cJSON_free(old);
    }
    unsigned before=heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    ESP_LOGI("scroll-bench","BEGIN 720 local encodes; cJSON / snprintf / direct; no USB/app commands");
    static const char *modes[]={"cjson86","snprintf87","direct88"};
    static const char *names[]={"down","move","up"};
    for(int pass=0;pass<2;pass++)for(int order=0;order<3;order++) {
        int mode=pass?2-order:order;
        for(int phase=0;phase<3;phase++) {
            for(int i=0;i<40;i++) {
                int dy=i%2?-466:466,velocity=i%2?-6000:6000;
                int64_t start=esp_timer_get_time();
                if(mode==2)assert(cable_scroll_encode(wire,sizeof wire,phase,dy,velocity));
                else if(mode==1) {
                    int n=phase==2
                        ? snprintf(wire,sizeof wire,"{\"t\":\"scroll\",\"phase\":\"up\",\"dy\":%d,\"v\":%d}",dy,velocity)
                        : snprintf(wire,sizeof wire,"{\"t\":\"scroll\",\"phase\":\"%s\",\"dy\":%d}",names[phase],dy);
                    assert(n>0&&(size_t)n<sizeof wire);
                }
                else {char *old=original(phase,dy,velocity);cJSON_free(old);}
                times[i]=(uint32_t)(esp_timer_get_time()-start);
                esp_task_wdt_reset();vTaskDelay(1);
            }
            qsort(times,40,sizeof *times,compare);
            ESP_LOGI("scroll-bench","pass=%d mode=%s phase=%d n=40 min=%lu median=%lu p95=%lu max=%lu",
                pass,modes[mode],phase,(unsigned long)times[0],
                (unsigned long)((times[19]+times[20])/2),(unsigned long)times[37],(unsigned long)times[39]);
        }
    }
    assert(heap_caps_check_integrity_all(true));
    ESP_LOGI("scroll-bench","END internal=%u/%u; excludes queue, transport and desktop rendering",
        before,(unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}
