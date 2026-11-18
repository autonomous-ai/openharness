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
static atomic_uint calls,b_waits;
static atomic_bool release_first,first_done,second_done;
static _Thread_local bool is_second;
// The clock moves only when main moves it, so a loaded machine cannot reach the
// product's 500 ms deadline on its own.
static _Atomic int64_t fake_now;
#define PAST_DEADLINE 500001
static int scenario,token;
static int64_t esp_timer_get_time(void) {return atomic_load(&fake_now);}
// The test's own waits; vTaskDelay is left to the product's wait loop so it can be counted.
static void nap(void) {
    struct timespec wait={.tv_sec=0,.tv_nsec=1000000};
    nanosleep(&wait,NULL);
}
static void vTaskDelay(unsigned ticks) {
    (void)ticks;
    if(is_second) {
        atomic_fetch_add(&b_waits,1);
        // One delay may already be under way when the clock passes or A returns.
        // A second means B ignores it: fail here instead of hanging.
        static unsigned late,after_first;
        if(atomic_load(&fake_now)>=PAST_DEADLINE)late++;
        if(atomic_load(&first_done))after_first++;
        assert(late<=1&&"B kept waiting past its deadline");
        assert(after_first<=1&&"B kept waiting after A returned");
    }
    nap();
}
static int i2c_new_master_bus(const i2c_master_bus_config_t *cfg,i2c_master_bus_handle_t *out) {
    assert(cfg->i2c_port==0&&cfg->sda_io_num==15&&cfg->scl_io_num==14);
    unsigned n=atomic_fetch_add(&calls,1)+1;
    if(n==1) {
        while(!atomic_load(&release_first))nap();
        if(scenario==1)return -1; // failed initial allocation, before any handle exists
    } else if(scenario==0) {
        // The other core acquired this hardware port. Its failing retry must not
        // erase the winner's published handle (the previous code did exactly that).
        while(!atomic_load(&first_done))nap();
        return -1;
    }
    *out=&token;return ESP_OK;
}
'''+source+r'''
static void *first(void *unused) {
    (void)unused;void *result=board_i2c_get();atomic_store(&first_done,true);return result;
}
static void *second(void *unused) {
    (void)unused;is_second=true;void *result=board_i2c_get();atomic_store(&second_done,true);return result;
}
int main(int argc,char **argv) {
    assert(argc==2);scenario=atoi(argv[1]);pthread_t a,b;void *ra,*rb;
    assert(!pthread_create(&a,NULL,first,NULL));
    // Each wait also ends when the thread returns, so a regression fails an assert, not a hang.
    while(!atomic_load(&calls)&&!atomic_load(&first_done))nap();
    assert(atomic_load(&calls)==1);
    assert(!pthread_create(&b,NULL,second,NULL));
    while(!atomic_load(&b_waits)&&!atomic_load(&second_done))nap();
    assert(atomic_load(&b_waits)&&"B must wait while A allocates");
    if(scenario==2) {
        atomic_store(&fake_now,PAST_DEADLINE);assert(!pthread_join(b,&rb));
        assert(!rb&&atomic_load(&calls)==1);
        atomic_store(&release_first,true);assert(!pthread_join(a,&ra));
        assert(ra==&token&&board_i2c_get()==&token);
    } else {
        atomic_store(&release_first,true);
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
        subprocess.run([str(out/'test'),str(scenario)],check=True)
