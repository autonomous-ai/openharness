"""Run the actual shared-bus initializer with concurrent retries and SDK failures."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = Path(os.environ.get('I2C_SOURCE', main / 'board/board_i2c.c')).read_text()
# Only SDK types and scheduling are replaced. The complete production C body is retained.
source = re.sub(r'^#include .*$', '', source, flags=re.M)
code = r'''
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
typedef void *i2c_master_bus_handle_t;
typedef struct {
    int i2c_port,sda_io_num,scl_io_num,clk_source,glitch_ignore_cnt;
    struct { bool enable_internal_pullup; } flags;
} i2c_master_bus_config_t;
#define I2C_NUM_0 0
#define BSP_I2C_PORT I2C_NUM_0
#define BSP_I2C_SDA 15
#define BSP_I2C_SCL 14
#define I2C_CLK_SRC_DEFAULT 0
#define ESP_OK 0
#define ESP_LOGE(tag, ...) ((void)(tag))
#define pdMS_TO_TICKS(ms) (ms)
static atomic_uint calls;
static atomic_bool release_first,first_done,second_started;
static int scenario,token;
static int64_t esp_timer_get_time(void) {
    struct timespec ts;assert(clock_gettime(CLOCK_MONOTONIC,&ts)==0);
    return (int64_t)ts.tv_sec*1000000+ts.tv_nsec/1000;
}
static void vTaskDelay(unsigned ms) {
    struct timespec wait={.tv_sec=ms/1000,.tv_nsec=(long)(ms%1000)*1000000};
    nanosleep(&wait,NULL);
}
static int i2c_new_master_bus(const i2c_master_bus_config_t *cfg,i2c_master_bus_handle_t *out) {
    assert(cfg->i2c_port==0&&cfg->sda_io_num==15&&cfg->scl_io_num==14);
    unsigned n=atomic_fetch_add(&calls,1)+1;
    if(n==1) {
        while(!atomic_load(&release_first))vTaskDelay(1);
        if(scenario==1)return -1; // failed initial allocation, before any handle exists
    } else if(scenario==0) {
        // The other core acquired this hardware port. Its failing retry must not
        // erase the winner's published handle (the previous code did exactly that).
        while(!atomic_load(&first_done))vTaskDelay(1);
        return -1;
    }
    *out=&token;return ESP_OK;
}
'''+source+r'''
static void *first(void *unused) {
    (void)unused;void *result=board_i2c_get();atomic_store(&first_done,true);return result;
}
static void *second(void *unused) {
    (void)unused;atomic_store(&second_started,true);return board_i2c_get();
}
int main(int argc,char **argv) {
    assert(argc==2);scenario=atoi(argv[1]);pthread_t a,b;void *ra,*rb;
    assert(!pthread_create(&a,NULL,first,NULL));
    while(!atomic_load(&calls))vTaskDelay(1);
    assert(!pthread_create(&b,NULL,second,NULL));
    while(!atomic_load(&second_started))vTaskDelay(1);
    if(scenario==2) {
        int64_t start=esp_timer_get_time();assert(!pthread_join(b,&rb));
        int64_t elapsed=esp_timer_get_time()-start;
        assert(!rb&&elapsed<1500000&&atomic_load(&calls)==1);
        atomic_store(&release_first,true);assert(!pthread_join(a,&ra));
        assert(ra==&token&&board_i2c_get()==&token);
    } else {
        vTaskDelay(20);atomic_store(&release_first,true);
        assert(!pthread_join(a,&ra)&&!pthread_join(b,&rb));
        assert(ra==(scenario==1?NULL:&token)&&rb==&token);
        unsigned count=atomic_load(&calls);assert(count==(scenario==1?2u:1u));
        for(unsigned i=0;i<200000;i++)assert(board_i2c_get()==&token);
        assert(atomic_load(&calls)==count);
    }
    printf("Shared I2C scenario %d: concurrent initialization, failure retry, bounded wait, stable cached handle PASS\n",scenario);
}
'''
with tempfile.TemporaryDirectory(prefix='harness-i2c-') as folder:
    out=Path(folder);(out/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-Wno-unused-function',
        '-Wno-deprecated-declarations','-O1','-g','-pthread',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
        str(out/'test.c'),'-o',str(out/'test')],check=True)
    for scenario in range(3):
        subprocess.run([str(out/'test'),str(scenario)],check=True,timeout=5)
