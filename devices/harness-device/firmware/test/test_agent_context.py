"""agent.context on the production roster reader: a level per agent, 0..2, kept across list rebuilds.

The daemon sends a level only when it changes, so the roster rebuilding under it must not drop it.
"""
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

# The dial says it reads the frame, and the reader routes it.
assert 'msg_string(&root, "context", "v1");' in function('send_hello')
assert re.search(r'strcmp\(t, "agent\.context"\) == 0\) \{ handle_agent_context\(p\); return; \}', function('handle_message'))

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
typedef struct cJSON { int valueint; const char *id, *agentId, *tab; bool number; const struct cJSON *level; } cJSON;
static cable_agent_t rows[CABLE_MAX_AGENTS], *s_agents=rows;
static int s_agents_lock=1, held, reloads, s_agent_count, s_agents_prev, s_agents_total;
static bool s_agents_building,s_has_window,s_agents_machine_view;
static char s_agents_tab[ID_MAX];
static uint32_t s_agents_generation;
static void xSemaphoreTake(int lock,int wait) { (void)wait; assert(lock && !held); held++; }
static void xSemaphoreGive(int lock) { assert(lock && held==1); held--; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *p,const char *key) {
    if (!strcmp(key,"level")) return p->level;
    assert(!strcmp(key,"total")); return NULL;
}
static bool cJSON_IsNumber(const cJSON *p) { return p && p->number; }
static const char *str_of(const cJSON *p,const char *key) {
    if (!strcmp(key,"id")) return p->id;
    if (!strcmp(key,"agentId")) return p->agentId;
    if (!strcmp(key,"tab")) return p->tab;
    return NULL;
}
static void ui_request_agent_reload(void) { assert(!held); reloads++; }
'''
for name in ['caps_of', 'handle_agent', 'cable_client_list_agents_snapshot', 'handle_agents_begin', 'handle_agents_end',
             'handle_agent_context']:
    code += function(name)
code += r'''
static const cJSON END={.tab="t"};
static void roster(const char *const *ids, int n) {
    handle_agents_begin();
    for (int i = 0; i < n; i++) handle_agent(&(cJSON){.id=ids[i]});
    handle_agents_end(&END);
}
static void level(const char *id, int value) { handle_agent_context(&(cJSON){.agentId=id,.level=&(cJSON){.valueint=value,.number=true}}); }
static int level_of(const char *id) {
    project_t out[CABLE_MAX_AGENTS]; cable_agent_snapshot_t snapshot;
    int n = cable_client_list_agents_snapshot(out, CABLE_MAX_AGENTS, &snapshot);
    for (int i = 0; i < n; i++) if (!strcmp(out[i].id, id)) return out[i].context;
    return -1;
}
int main(void) {
    roster((const char *[]){"a","b","c"}, 3);
    assert(level_of("a")==0 && level_of("b")==0 && level_of("c")==0);   // nothing said: 0
    int r = reloads;
    level("a", 2); assert(level_of("a")==2 && level_of("b")==0 && reloads==r+1);   // a change redraws
    level("a", 2); assert(reloads==r+1);                                          // the same level does not
    level("zz", 1); assert(reloads==r+1 && level_of("zz")==-1);                   // an agent the dial does not hold
    level("b", 7); assert(level_of("b")==2);                                      // clamped
    level("b", -3); assert(level_of("b")==0);
    level("c", 1); assert(level_of("c")==1);
    r = reloads;
    handle_agent_context(&(cJSON){.agentId="c"}); assert(level_of("c")==0 && reloads==r+1);   // no level: 0
    level("c", 1);
    handle_agent_context(&(cJSON){.agentId="c",.level=&(cJSON){.valueint=2}}); assert(level_of("c")==0);   // not a number: 0
    level("c", 1);
    handle_agent_context(&(cJSON){.level=&(cJSON){.valueint=2,.number=true}});   // no agent: nothing
    char longer[ID_MAX+1]; memset(longer,'c',ID_MAX); longer[ID_MAX]=0; level(longer, 2);
    assert(level_of("a")==2 && level_of("b")==0 && level_of("c")==1);
    // The roster rebuilds, reordered, one agent new: every level stays with its agent.
    roster((const char *[]){"c","d","a","b"}, 4);
    assert(level_of("a")==2 && level_of("b")==0 && level_of("c")==1 && level_of("d")==0);
    level("b", 1);
    roster((const char *[]){"b","a"}, 2);
    assert(level_of("a")==2 && level_of("b")==1 && level_of("c")==-1);
    // A level that lands while the next roster streams in reaches the row, built yet or not.
    handle_agents_begin();
    handle_agent(&(cJSON){.id="a"});
    level("a", 1); level("b", 2); level("c", 2);   // b: not yet streamed; c: gone from the last roster
    handle_agent(&(cJSON){.id="b"});
    handle_agent(&(cJSON){.id="c"});
    handle_agents_end(&END);
    assert(level_of("a")==1 && level_of("b")==2 && level_of("c")==0 && !held);
    // A begin without its end keeps what the half-built roster and the old one hold.
    handle_agents_begin(); handle_agent(&(cJSON){.id="c"}); handle_agents_begin();
    handle_agent(&(cJSON){.id="b"}); handle_agent(&(cJSON){.id="a"}); handle_agents_end(&END);
    assert(level_of("a")==1 && level_of("b")==2 && !held);
    puts("agent context: levels 0..2 per agent, clamped, unknown agents ignored, kept across reordered and interrupted rebuilds PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-agent-context-') as path:
    out = Path(path)
    (out / 'context.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    str(out / 'context.c'), '-o', str(out / 'context')], check=True)
    subprocess.run([str(out / 'context')], check=True)
