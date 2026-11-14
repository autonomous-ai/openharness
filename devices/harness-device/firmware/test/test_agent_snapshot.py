"""Exercise the production streamed roster reader; incomplete streams must not reach the UI."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import defines, typedef

main = Path(__file__).resolve().parent / '../main'
source = (main / 'cable_client.c').read_text()

def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'

code = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define ESP_LOGI(...) ((void)0)
#define portMAX_DELAY 0
'''
code += defines('ID_MAX','CABLE_NAME_MAX','CABLE_MAX_AGENTS','CABLE_CAP_S','CABLE_CAP_V','CABLE_CAP_F','CABLE_CAP_A','CABLE_CAPS_ALL') + typedef('cable_agent_t',source) + typedef('project_t') + typedef('cable_agent_snapshot_t')
code += r'''
typedef struct { int valueint; const char *tab, *view, *id, *host, *caps; bool number; } cJSON;
static cable_agent_t rows[4], *s_agents=rows;
static int s_agents_lock=1, held, reloads, s_agent_count, s_agents_total;
static bool s_agents_building,s_has_window,s_agents_machine_view;
static char s_agents_tab[ID_MAX];
static uint32_t s_agents_generation;
static void xSemaphoreTake(int lock,int wait) { (void)wait; assert(lock && !held); held++; }
static void xSemaphoreGive(int lock) { assert(lock && held==1); held--; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *p,const char *key) { assert(!strcmp(key,"total")); return p; }
static bool cJSON_IsNumber(const cJSON *p) { return p && p->number; }
static const char *str_of(const cJSON *p,const char *key) {
    if (!strcmp(key,"tab")) return p->tab;
    if (!strcmp(key,"view")) return p->view;
    if (!strcmp(key,"id")) return p->id;
    if (!strcmp(key,"host")) return p->host;
    if (!strcmp(key,"caps")) return p->caps;
    return NULL;   // name, engine, model, ... : absent
}
static void ui_request_agent_reload(void) { assert(!held); reloads++; }
'''
for name in ['caps_of', 'handle_agent', 'cable_client_agent_generation', 'cable_client_list_agents_snapshot', 'handle_agents_begin', 'handle_agents_end']:
    code += function(name)
code += r'''
int main(void) {
    project_t out[4]={0}; cable_agent_snapshot_t snapshot={0};
    handle_agents_begin(); strcpy(rows[0].id,"old-pane"); strcpy(rows[0].name,"Old"); s_agent_count=1;
    cJSON first={.valueint=70,.tab="old-tab",.number=true}; handle_agents_end(&first);
    assert(reloads==1 && !held && cable_client_agent_generation()==1);
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==1);
    assert(!strcmp(out[0].id,"old-pane") && !strcmp(snapshot.tab,"old-tab"));
    assert(snapshot.generation==1 && snapshot.total==70 && snapshot.window);
    handle_agents_begin(); strcpy(rows[0].id,"new-pane"); strcpy(rows[0].name,"New"); s_agent_count=1;
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==-1 && !held);
    assert(!strcmp(out[0].id,"old-pane")); // No half-built rows overwrite the display's copy.
    assert(!snapshot.generation && !snapshot.tab[0]);
    cJSON next={.valueint=71,.tab="new-tab",.number=true}; handle_agents_end(&next);
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==1);
    assert(!strcmp(out[0].id,"new-pane") && !strcmp(snapshot.tab,"new-tab"));
    assert(snapshot.generation==2 && snapshot.total==71);
    handle_agents_begin(); next.tab="empty-tab"; handle_agents_end(&next);
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==0);
    assert(!strcmp(snapshot.tab,"empty-tab") && snapshot.window && snapshot.generation==3);
    handle_agents_begin(); next.tab=""; handle_agents_end(&next);
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==0);
    assert(!snapshot.window && !snapshot.tab[0] && snapshot.generation==4);
    s_agents_generation=UINT32_MAX; handle_agents_begin(); handle_agents_end(&next);
    assert(cable_client_agent_generation()==0 && !held);
    // host and caps ride on each agent row; an older daemon sends neither, which must read as everything.
    handle_agents_begin();
    handle_agent(&(cJSON){.id="plain"});
    handle_agent(&(cJSON){.id="orca-1",.host="orca",.caps="sva"});
    handle_agent(&(cJSON){.id="obs-1",.host="ghostty",.caps="s"});
    handle_agent(&(cJSON){.id="empty",.caps=""});
    cJSON machine={.valueint=4,.tab="",.view="machine",.number=true}; handle_agents_end(&machine);
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==4);
    assert(!out[0].host[0] && out[0].caps==CABLE_CAPS_ALL);
    assert(!strcmp(out[1].host,"orca") && out[1].caps==(CABLE_CAP_S|CABLE_CAP_V|CABLE_CAP_A));
    assert(!strcmp(out[2].host,"ghostty") && out[2].caps==CABLE_CAP_S);
    assert(out[3].caps==0);   // present but empty is nothing, not "absent"
    assert(snapshot.machine_view && !snapshot.window);
    handle_agents_begin(); next.tab="t"; next.view=NULL; handle_agents_end(&next);
    assert(cable_client_list_agents_snapshot(out,4,&snapshot)==0 && !snapshot.machine_view);   // a window's list has no view
    {   // an unknown letter grants nothing and a host that does not fit is dropped, not truncated
        handle_agents_begin();
        handle_agent(&(cJSON){.id="x",.host="a-host-far-too-long",.caps="vx"});
        handle_agents_end(&next);
        assert(cable_client_list_agents_snapshot(out,4,&snapshot)==1 && !out[0].host[0] && out[0].caps==CABLE_CAP_V);
    }
    puts("agent snapshot: production reader rejects partial streams; exact roster/tab/count/generation, empty tabs and wrap PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-agent-snapshot-') as path:
    out = Path(path)
    (out / 'snapshot.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    str(out / 'snapshot.c'), '-o', str(out / 'snapshot')], check=True)
    subprocess.run([str(out / 'snapshot')], check=True)
