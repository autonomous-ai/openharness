"""Publish/read the production refresh-task handle concurrently, without FreeRTOS."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = Path(os.environ.get('UI_SOURCE',root/'main/ui/habitat/ui_habitat.c')).read_text()


def function(name):
    m = re.search(r'^[^\n]*\b'+name+r'\([^;\n]*\) \{[^\n]*\}',source,re.M)
    if not m:
        m = re.search(r'^[^\n]*\b'+name+r'\([^;]*?\)\n\{.*?^\}',source,re.M|re.S)
    assert m, name
    return m.group(0)+'\n'


code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <pthread.h>
#include <stdio.h>
typedef void *TaskHandle_t;
static int a,b;
static atomic_bool reload_requested,start;
static atomic_uint wakes;
static void xTaskNotifyGive(TaskHandle_t task) {
    assert(task==&a || task==&b);atomic_fetch_add(&wakes,1);
}
'''
code += re.search(r'^static [^\n]*\breload_waiter;',source,re.M).group(0)+'\n'
for name in ['ui_set_reload_waiter','ui_request_agent_reload','ui_take_agent_reload_req','ui_peek_agent_reload_req']:
    code += function(name)
code += r'''
static void *writer(void *unused) {
    (void)unused;while(!atomic_load(&start)) {}
    for(unsigned i=0;i<200000;i++)ui_set_reload_waiter(i&1?&a:&b);
    return NULL;
}
static void *reader(void *unused) {
    (void)unused;while(!atomic_load(&start)) {}
    for(unsigned i=0;i<200000;i++) {
        ui_request_agent_reload();assert(ui_peek_agent_reload_req());
        assert(ui_take_agent_reload_req());assert(!ui_take_agent_reload_req());
    }
    return NULL;
}
int main(void) {
    // Requests before task creation remain pending even without a wake target.
    ui_request_agent_reload();assert(ui_take_agent_reload_req());assert(!atomic_load(&wakes));
    ui_set_reload_waiter(&a);
    pthread_t w,r;assert(!pthread_create(&w,NULL,writer,NULL));assert(!pthread_create(&r,NULL,reader,NULL));
    atomic_store(&start,true);assert(!pthread_join(w,NULL));assert(!pthread_join(r,NULL));
    assert(atomic_load(&wakes)==200000);
    puts("UI reload: 200000 concurrent handle publications/notifications, pre-registration request and exact pending consumption PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-reload-threads-') as folder:
    folder=Path(folder);(folder/'reload.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-pthread',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),str(folder/'reload.c'),
        '-o',str(folder/'reload')],check=True)
    subprocess.run([str(folder/'reload')],check=True,timeout=60)
