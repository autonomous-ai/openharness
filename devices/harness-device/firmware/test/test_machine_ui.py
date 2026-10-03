"""Production machine-selection callbacks: late replies, bounds, and clock wrap."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
source = Path(os.environ.get('UI_SOURCE', root/'main/ui/habitat/ui_habitat.c')).read_text()


def function(name):
    m = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert m, name
    return m.group(0) + '\n'


code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#define CABLE_MAX_MACHINES 8
typedef struct { char id[64],name[96],state[16]; bool local; } cable_machine_t;
static struct {
    cable_machine_t machines[CABLE_MAX_MACHINES]; int machine_count;
    char selected_machine[64],pending_machine[64],title[80],message[256];
    uint32_t machine_deadline;
} s;
static uint32_t now;
static int lock_depth,errors,changes,viewed;
enum { MESSAGE=4 };
static uint32_t ms(void) { return now; }
static void display_lock(void) { lock_depth++; }
static void display_unlock(void) { assert(lock_depth>0);lock_depth--; }
static void change(void) { assert(lock_depth>0);changes++; }
static void view(int value) { assert(lock_depth>0);viewed=value; }
static void ui_show_error(const char *title,const char *message) {
    errors++;snprintf(s.title,sizeof s.title,"%s",title);
    snprintf(s.message,sizeof s.message,"%s",message?message:"");
}
'''
code += function('copy') + '#define COPY(dst,src) copy(dst,sizeof(dst),src)\n'
for name in ['ui_machines_replace', 'ui_machines_replace_one', 'ui_machine_selected_ack',
             'ui_machine_select_error', 'ui_tick_machine_select']:
    code += function(name)
code += r'''
static void request(const char *id,uint32_t at) {
    COPY(s.pending_machine,id);s.machine_deadline=at+6000;now=at;
}
int main(void) {
    COPY(s.selected_machine,"origin");request("new",1000);
    ui_machine_select_error("old","OFFLINE","Old request failed");
    assert(!strcmp(s.pending_machine,"new") && !errors);
    // Acknowledgements are authoritative about actual host selection, but an
    // older acknowledgement must not clear the newer outstanding request.
    ui_machine_selected_ack("old");
    assert(!strcmp(s.selected_machine,"old") && !strcmp(s.pending_machine,"new"));
    ui_machine_selected_ack("new");
    assert(!strcmp(s.selected_machine,"new") && !s.pending_machine[0]);
    ui_machine_select_error("old","OFFLINE","Too late");assert(!errors);
    request("newer",2000);
    ui_machine_select_error("newer","OFFLINE","Native host error");
    assert(!s.pending_machine[0] && errors==1 && !strcmp(s.message,"Native host error"));
    // Corrupt/absent identifiers cannot acknowledge a pending request.
    request("waiting",3000);char huge[100];memset(huge,'x',sizeof huge);huge[99]=0;
    ui_machine_selected_ack(NULL);ui_machine_selected_ack("");ui_machine_selected_ack(huge);
    assert(!strcmp(s.pending_machine,"waiting") && !strcmp(s.selected_machine,"new"));
    ui_machine_select_error(NULL,"ERR","Missing target");assert(errors==1);
    // The six-second timeout remains six seconds across the millisecond wrap.
    request("remote",UINT32_MAX-3000);ui_tick_machine_select();assert(s.pending_machine[0]);
    now=UINT32_MAX;ui_tick_machine_select();assert(s.pending_machine[0]);
    now=2998;ui_tick_machine_select();assert(s.pending_machine[0]);
    now=2999;ui_tick_machine_select();assert(!s.pending_machine[0] && viewed==MESSAGE);
    int before=changes;now++;ui_tick_machine_select();assert(changes==before);
    request("remote",10000);now=15999;ui_tick_machine_select();assert(s.pending_machine[0]);
    now=16000;ui_tick_machine_select();assert(!s.pending_machine[0]);
    // Snapshot capacities are bounded before copying, including empty input.
    cable_machine_t rows[CABLE_MAX_MACHINES];memset(rows,0,sizeof rows);
    for(int i=0;i<CABLE_MAX_MACHINES;i++)snprintf(rows[i].id,sizeof rows[i].id,"m%d",i);
    ui_machines_replace(rows,INT_MAX,"m2",NULL);assert(s.machine_count==CABLE_MAX_MACHINES);
    assert(!memcmp(rows,s.machines,sizeof rows));
    ui_machines_replace(rows,-1,NULL,NULL);assert(s.machine_count==0 && !s.selected_machine[0]);
    ui_machines_replace(NULL,2,NULL,NULL);assert(!s.machine_count);
    ui_machines_replace_one(NULL,NULL);
    ui_machines_replace(rows,2,"m1",NULL);COPY(rows[1].name,"Renamed");
    ui_machines_replace_one(&rows[1],"m1");assert(!strcmp(s.machines[1].name,"Renamed"));
    assert(!lock_depth);
    puts("Machine UI: stale replies, authoritative selection, malformed IDs, bounded snapshots and timeout wrap PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-machine-ui-') as folder:
    folder = Path(folder)
    (folder/'machine.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),str(folder/'machine.c'),
        '-o',str(folder/'machine')],check=True)
    subprocess.run([str(folder/'machine')],check=True)
