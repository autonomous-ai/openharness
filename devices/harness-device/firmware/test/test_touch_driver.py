"""Exercise the production touch task against controller ACK/error/wake traces."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
p=Path(__file__).resolve().parent
source=(p/'../main/ui/habitat/touch_habitat.c').read_text()
body=re.search(r'static void task\(void \*arg\)\n\{.*?^\}',source,re.M|re.S).group(0)
code=r'''
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stddef.h>
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include "creature_gallery.h"
/* HT_WIDTH / HT_HEIGHT come from terminal.h through the header above. They used to be repeated here
   as 466, which was a harmless identical redefinition while the header spelled them the same way;
   the header now derives them from HT_FACE_PX, so repeating them is a -Wmacro-redefined error and,
   worse, would pin this test to one face. */
#define ESP_OK 0
#define ESP_ERR_INVALID_RESPONSE 1
#define ESP_FAIL 2
#define TOUCH_CST9217 9217
#define pdTRUE 1
#define pdMS_TO_TICKS(x) (x)
typedef int esp_err_t;
static void *controller=(void*)1, *io=(void*)1;
static atomic_uint presses, failures, inferred, last_press;
static atomic_bool held, controller_ready;
static struct {int touch;} b={9217};
static const void *board_(void) { return &b; }
#define board() ((const typeof(b)*)board_())
typedef struct {uint32_t ms; int rc; bool down; uint16_t x,y;} sample_t;
static sample_t *samples; static int count, at, forwarded_down, forwarded_up, canceled, woke;
static bool asleep;
static int power_off_at, power_on_at, sleep_on_lock, locks;
static ht_gallery_t gallery;
static jmp_buf stop;
static int64_t esp_timer_get_time(void) { return samples[at].ms*1000ll; }
static bool open_touch(void) {controller=(void*)1;return true;}
static void ulTaskNotifyTake(int a,int t) { (void)a;(void)t;if(++at==count)longjmp(stop,1); }
static int esp_lcd_touch_read_data(void *c) {
 (void)c;if(at==power_off_at)asleep=true;if(at==power_on_at)asleep=false;return samples[at].rc;
}
static bool esp_lcd_touch_get_coordinates(void*c,uint16_t*x,uint16_t*y,uint16_t*s,uint8_t*n,int m) {
 (void)c;(void)s;(void)m;*x=samples[at].x;*y=samples[at].y;*n=samples[at].down?1:0;return samples[at].down;
}
static void esp_lcd_touch_del(void*c){(void)c;}
static void esp_lcd_panel_io_del(void*c){(void)c;}
static void display_lock(void){if(++locks==sleep_on_lock)asleep=true;}
static void display_unlock(void){}
static bool display_is_asleep(void){return asleep;}
static void display_wake(void){asleep=false;woke++;}
static void display_bump_activity(void){}
static void habitat_input_stamp(int64_t n){(void)n;}
static void habitat_touch_cancel(void){canceled++;ht_gallery_cancel(&gallery);}
static void habitat_touch(bool down,int x,int y,uint32_t n) {
 ht_gallery_touch(&gallery,down,x,y,n);if(down)forwarded_down++;else forwarded_up++;
}
'''+body+r'''
static void run(sample_t *s,int n,bool sleep,int off,int on,int lock_sleep) {
 samples=s;count=n;at=forwarded_down=forwarded_up=canceled=woke=0;asleep=sleep;
 power_off_at=off;power_on_at=on;sleep_on_lock=lock_sleep;locks=0;
 ht_gallery_init(&gallery,s[0].ms);
 gallery.creature=0; // Exercise original reaction traces, independent of gallery boot art.
 controller=(void*)1;if(!setjmp(stop))task(NULL);
}
#define RUN(s,asleep_) run(s,sizeof(s)/sizeof(s[0]),asleep_,-1,-1,-1)
#define RUN_POWER(s,off,on,lock_sleep) run(s,sizeof(s)/sizeof(s[0]),false,off,on,lock_sleep)
int main(void) {
 sample_t idle_ack[]={ {0,1,0,0,0},{20,0,1,233,220},{80,0,0,233,220} };
 RUN(idle_ack,false);assert(forwarded_down==1&&forwarded_up==1&&canceled==0);
 sample_t ack_between_taps[]={ {0,0,1,233,220},{70,0,0,233,220},{90,1,0,0,0},{190,0,1,233,220},{260,0,0,233,220} };
 RUN(ack_between_taps,false);assert(forwarded_down==2&&forwarded_up==2&&canceled==0);
 sample_t broken_contact[]={ {0,0,1,233,220},{20,1,1,233,220},{40,0,1,233,220},{80,0,0,233,220},
                            {200,0,1,233,220},{270,0,0,233,220} };
 RUN(broken_contact,false);assert(forwarded_down==2&&forwarded_up==1&&canceled==1);
 sample_t read_error[]={ {0,0,1,233,220},{20,2,0,0,0},{40,0,1,233,220},{80,0,0,233,220},
                        {200,0,1,233,220},{270,0,0,233,220} };
 RUN(read_error,false);assert(forwarded_down==2&&forwarded_up==1&&canceled==1);
 sample_t corrupt[]={ {0,0,1,900,220},{20,0,1,233,220},{80,0,0,233,220},
                     {200,0,1,233,220},{270,0,0,233,220} };
 RUN(corrupt,false);assert(forwarded_down==1&&forwarded_up==1&&canceled==1);
 sample_t wake[]={ {0,0,1,233,220},{20,0,1,233,220},{80,0,0,233,220},
                  {200,0,1,233,220},{270,0,0,233,220} };
 RUN(wake,true);assert(forwarded_down==1&&forwarded_up==1&&canceled==1&&woke==1);
 assert(gallery.booped); // First real tap after the swallowed wake tap must work.
 sample_t wake_swipe[]={ {0,0,1,233,220},{20,0,1,233,220},{80,0,0,233,220},
                        {200,0,1,233,220},{230,0,1,100,220},{270,0,0,100,220} };
 RUN(wake_swipe,true);assert(gallery.creature==1&&!gallery.booped);
 sample_t wake_mood[]={ {0,0,1,233,220},{80,0,0,233,220},
                       {200,0,1,233,220},{230,0,1,233,90},{270,0,0,233,90} };
 RUN(wake_mood,true);assert(gallery.mood==1&&!gallery.booped);
 RUN(broken_contact,false);assert(gallery.booped); // Driver swallowed damaged contact's UP.
 RUN(read_error,false);assert(gallery.booped);
 RUN(corrupt,false);assert(gallery.booped);
 sample_t idle_error[]={ {0,2,0,0,0},{20,0,1,233,220},{80,0,0,233,220} };
 RUN(idle_error,false);assert(gallery.booped&&canceled==1);
 sample_t off_mid_swipe[]={ {0,0,1,233,220},{20,0,1,100,220},{80,0,0,100,220} };
 RUN_POWER(off_mid_swipe,1,-1,-1);
 assert(gallery.creature==0&&!gallery.booped&&asleep&&canceled==1&&forwarded_up==0);
 // PWR wakes the screen while that finger is still held: it stays quarantined.
 sample_t off_on_held[]={ {0,0,1,233,220},{20,0,1,220,220},{40,0,1,100,220},
                         {80,0,0,100,220},{200,0,1,233,220},{270,0,0,233,220} };
 RUN_POWER(off_on_held,1,2,-1);
 assert(gallery.creature==0&&gallery.booped&&canceled==1&&forwarded_up==1);
 // A release arriving exactly after sleep cannot finish a partially moved gesture.
 sample_t off_at_release[]={ {0,0,1,233,220},{20,0,1,100,220},{80,0,0,100,220} };
 RUN_POWER(off_at_release,2,-1,-1);
 assert(gallery.creature==0&&!gallery.booped&&canceled==1&&forwarded_up==0);
 // Screen power may change after the initial wake check, while waiting for the UI lock.
 RUN_POWER(off_mid_swipe,-1,-1,2);
 assert(gallery.creature==0&&!gallery.booped&&canceled==1&&forwarded_up==0);
 puts("touch driver: PASS (production task + gallery; ACK/error recovery, wake gestures, power off/on during contact and sleep at dispatch)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-touch-driver-') as d:
 root=Path(d);(root/'driver.c').write_text(code)
 subprocess.run(['cc','-std=gnu11','-Wall','-Wextra','-Werror','-O1',
                 '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
                 '-I',str(p/'../main/ui/habitat'),str(root/'driver.c'),
                 str(p/'../main/ui/habitat/creature_gallery.c'),str(p/'../main/ui/habitat/creature_font.c'),
                 str(p/'../main/ui/habitat/terminal.c'),str(p/'../main/ui/habitat/fonts.c'),
                 '-o',str(root/'driver')],check=True)
 subprocess.run([str(root/'driver')],check=True)
