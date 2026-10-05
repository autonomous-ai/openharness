"""Replay the actual Pro GT911 task with five-contact/error/power samples."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
HERE = Path(__file__).resolve().parent
source = (HERE / '../main/ui/habitat/touch_habitat.c').read_text()
body = re.search(r'static void task\(void \*arg\)\n\{.*?^\}', source, re.M | re.S).group(0)
code = r'''
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stddef.h>
#include <string.h>
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include "pro_contacts.h"
#define CONFIG_IDF_TARGET_ESP32P4 1
#define DEVICE_PRO_COMPANION 1
#define HT_WIDTH 720
#define HT_HEIGHT 720
#define ESP_OK 0
#define ESP_FAIL 2
#define pdTRUE 1
#define pdMS_TO_TICKS(x) (x)
typedef int esp_err_t;
typedef struct {uint8_t track_id; uint16_t x,y,strength;} esp_lcd_touch_point_data_t;
static void *controller=(void*)1,*io=(void*)1;
static atomic_uint presses,failures,last_press;
static atomic_bool held,controller_ready;
typedef struct {uint32_t ms; int n,dx,dy,rc; bool swap,bad,duplicate,replace,get_error;} sample_t;
static sample_t *samples;static int count,at;
static unsigned downs,ups,cancels,begins,ends,commits,opens,wakes,deletes;
static int step,off,on,lock_off,locks;
static bool asleep,allowed,armed;
static jmp_buf stop;
static int64_t esp_timer_get_time(void){return samples[at].ms*1000ll;}
static bool open_touch(void){controller=(void*)1;io=(void*)1;opens++;return true;}
static void ulTaskNotifyTake(int a,int t){(void)a;(void)t;if(++at==count)longjmp(stop,1);}
static int esp_lcd_touch_read_data(void *c){(void)c;if(at==off)asleep=true;if(at==on)asleep=false;return samples[at].rc;}
static int esp_lcd_touch_get_data(void *c,esp_lcd_touch_point_data_t *p,uint8_t *n,uint8_t cap){
 (void)c;assert(cap==5);sample_t s=samples[at];*n=s.n;
 for(int i=0;i<s.n&&i<cap;i++)p[i]=(esp_lcd_touch_point_data_t){i+2,(uint16_t)(300+i*70+s.dx),(uint16_t)(200+i*50+s.dy),10};
 if(s.n>1&&s.swap){esp_lcd_touch_point_data_t a=p[0];p[0]=p[1];p[1]=a;}
 if(s.n>0&&s.bad)p[s.n-1].x=720;
 if(s.n>1&&s.duplicate)p[1].track_id=p[0].track_id;
 if(s.n>0&&s.replace)p[0].track_id=9;
 return s.get_error?ESP_FAIL:ESP_OK;
}
static void esp_lcd_touch_del(void*c){(void)c;deletes++;}
static void esp_lcd_panel_io_del(void*c){(void)c;}
static void display_lock(void){if(++locks==lock_off)asleep=true;}
static void display_unlock(void){}
static bool display_is_asleep(void){return asleep;}
static void display_wake(void){asleep=false;wakes++;}
static void display_bump_activity(void){}
static void habitat_input_stamp(int64_t n){(void)n;}
static void habitat_touch_cancel(void){cancels++;armed=false;}
static void habitat_touch(bool down,int x,int y,uint32_t t){(void)x;(void)y;(void)t;if(down)downs++;else ups++;}
static bool habitat_workspace_gesture_begin(void){habitat_touch_cancel();begins++;armed=allowed;return allowed;}
static void habitat_workspace_gesture_end(int direction){ends++;if(armed&&direction){commits++;step=direction;}armed=false;}
''' + body + r'''
static void run(sample_t *trace,int n,bool sleep,bool permit,int power_off,int power_on,int lock_sleep){
 samples=trace;count=n;at=0;downs=ups=cancels=begins=ends=commits=opens=wakes=deletes=0;
 locks=0;step=0;asleep=sleep;allowed=permit;armed=false;off=power_off;on=power_on;lock_off=lock_sleep;
 atomic_store(&presses,0);atomic_store(&failures,0);controller=(void*)1;io=(void*)1;
 if(!setjmp(stop))task(NULL);
}
#define RUN(t) run(t,sizeof(t)/sizeof(t[0]),false,true,-1,-1,-1)
int main(void){
 sample_t single[]={{.ms=0,.n=1},{.ms=40,.n=1,.dx=4},{.ms=80}};
 RUN(single);assert(downs==2&&ups==1&&!cancels&&!begins);
 sample_t pair[]={{.ms=0,.n=1},{.ms=20,.n=2},{.ms=60,.n=2,.dx=-50,.swap=true},
 {.ms=100,.n=2,.dx=-110},{.ms=120,.n=1,.dx=-110},{.ms=140}, {.ms=200,.n=1},{.ms=260}};
 RUN(pair);assert(downs==2&&ups==1&&commits==1&&step==1&&begins==1&&ends==1&&cancels==1);
 run(pair,sizeof(pair)/sizeof(pair[0]),false,false,-1,-1,-1);
 assert(downs==2&&ups==1&&begins==1&&!ends&&!commits); // Modal gate consumes full contact.
 sample_t three[]={{.ms=0,.n=1},{.ms=20,.n=2},{.ms=60,.n=3,.dx=-50},{.ms=100,.n=2,.dx=-110},
 {.ms=120,.n=1,.dx=-110},{.ms=140},{.ms=200,.n=1},{.ms=260}};
 RUN(three);assert(downs==2&&ups==1&&!commits&&begins==1&&cancels==2);
 sample_t five[]={{.ms=0,.n=5},{.ms=40,.n=2},{.ms=80,.n=1},{.ms=120},{.ms=200,.n=1},{.ms=260}};
 RUN(five);assert(downs==1&&ups==1&&!begins&&!commits&&cancels==1);
 for(int bad=0;bad<4;bad++){
   sample_t fault[]={{.ms=0,.n=1},{.ms=20,.n=2},{.ms=60,.n=2,.dx=-50},{.ms=100,.n=2,.dx=-110},
    {.ms=140},{.ms=200,.n=1},{.ms=260}};
   if(bad==0)fault[2].bad=true;if(bad==1)fault[2].duplicate=true;
   if(bad==2)fault[2].get_error=true;if(bad==3)fault[2].rc=ESP_FAIL;
   RUN(fault);assert(downs==2&&ups==1&&!commits&&cancels==2);
 }
 sample_t changed_id[]={{.ms=0,.n=1},{.ms=40,.n=1,.replace=true},{.ms=80},{.ms=200,.n=1},{.ms=260}};
 RUN(changed_id);assert(downs==2&&ups==1&&cancels==1&&!begins);
 sample_t late[]={{.ms=0,.n=1},{.ms=200,.n=2},{.ms=240,.n=2,.dx=-110},{.ms=280}};
 RUN(late);assert(downs==1&&!ups&&!begins&&!commits&&cancels==1);
 sample_t idle_error[]={{.ms=0,.rc=ESP_FAIL},{.ms=40,.n=1},{.ms=80}};
 RUN(idle_error);assert(downs==1&&ups==1&&cancels==1);
 run(pair,sizeof(pair)/sizeof(pair[0]),true,true,-1,-1,-1);
 assert(downs==1&&ups==1&&wakes==1&&!begins&&!commits);
 run(pair,sizeof(pair)/sizeof(pair[0]),false,true,3,4,-1);
 assert(downs==2&&ups==1&&begins==1&&!ends&&!commits&&cancels==2);
 run(pair,sizeof(pair)/sizeof(pair[0]),false,true,5,6,-1);
 assert(downs==2&&ups==1&&begins==1&&!ends&&!commits); // Sleep exactly at release.
 run(pair,sizeof(pair)/sizeof(pair[0]),false,true,-1,-1,2);
 assert(downs==1&&!ups&&!commits&&wakes==1); // Lock race; next fresh contact only wakes.
 sample_t reset_trace[]={{.ms=0,.n=1},{.ms=20,.n=2},{.ms=40,.rc=2},{.ms=60,.rc=2},
 {.ms=80,.rc=2},{.ms=100,.rc=2},{.ms=120,.rc=2},{.ms=140,.rc=2},{.ms=160,.rc=2},{.ms=180,.rc=2},
 {.ms=280,.n=2},{.ms=300,.n=2,.dx=-110},{.ms=320,.n=1},{.ms=340},{.ms=400,.n=1},{.ms=460}};
 RUN(reset_trace);assert(opens==1&&deletes==1&&downs==2&&ups==1&&begins==1&&!commits);
 assert(atomic_load(&failures)==8&&!atomic_load(&held));
 puts("Pro GT911 driver: PASS (actual task, five-contact reads, promotion, errors/reinit, wake/sleep/lock races, no leaked UP)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-pro-touch-driver-') as directory:
    root=Path(directory);(root/'driver.c').write_text(code)
    subprocess.run(['cc','-std=gnu11','-Wall','-Wextra','-Werror','-O1',
                    '-fsanitize='+os.environ.get('SANITIZERS','address,undefined,bounds'),
                    '-I',str(HERE/'../main/ui/habitat'),str(root/'driver.c'),'-o',str(root/'driver')],check=True)
    subprocess.run([str(root/'driver')],check=True)
