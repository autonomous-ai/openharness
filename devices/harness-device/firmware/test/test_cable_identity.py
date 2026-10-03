"""Actual roster/catalog handlers with exact production capacities and cJSON.

An overlong opaque identifier must be rejected, never turned into another target.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import MAIN, typedef

source = Path(os.environ.get('CABLE_SOURCE', MAIN/'cable_client.c')).read_text()
json_dir = Path(os.environ['IDF_PATH'])/'components/json/cJSON'


def function(name):
    match = re.search(r'^[^\n]*\b'+name+r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match[0]+'\n'


code = r'''
#include <limits.h>
enum { native_name_max = NAME_MAX };
#include "cable_client.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
_Static_assert(NAME_MAX == native_name_max, "protocol header must not redefine POSIX NAME_MAX");
_Static_assert(CABLE_NAME_MAX == 40, "wire name capacity must be independent of system headers");
_Static_assert(sizeof(((project_t *)0)->name) == 40, "UI names retain protocol capacity");
'''
code += typedef('cable_agent_t',source)
code += r'''
_Static_assert(sizeof(((cable_agent_t *)0)->name) == 40, "roster names retain protocol capacity");
_Static_assert(sizeof(((cable_agent_t *)0)->machine) == 40, "machine names retain protocol capacity");
#define portMAX_DELAY 0
static struct { uint64_t before; cable_agent_t rows[CABLE_MAX_AGENTS]; uint64_t after; } storage;
static cable_agent_t *s_agents=storage.rows;
static int s_agents_lock=1,s_agent_count,held;
static bool s_agents_building=true;
static int s_models_sem=2,s_models_n,s_models_max;
static bool s_models_replied;
static char s_models_agent[ID_MAX]="agent";
static uint32_t s_models_request=5;
static model_item_t models[4],*s_models_out=models;
static unsigned swarm_calls,notice_calls,sem_gives;
static int swarm_count,notice_count;
static cable_swarm_t swarms[SWARMS_MAX];
static cable_notif_t notices[8];
static char selected[ID_MAX];
static void xSemaphoreTake(int lock,int delay) { (void)delay;assert(lock==1&&!held);held=1; }
static void xSemaphoreGive(int lock) { if(lock==1){assert(held);held=0;}else{assert(lock==2);sem_gives++;} }
static void ui_swarms_replace(const cable_swarm_t *rows,int n,const char *id) {
    assert(!held&&n>=0&&n<=SWARMS_MAX);swarm_calls++;swarm_count=n;
    memcpy(swarms,rows,(size_t)n*sizeof *rows);snprintf(selected,sizeof selected,"%s",id?id:"");
}
static void ui_notif_replace(const cable_notif_t *rows,int n) {
    assert(!held&&n>=0&&n<=8);notice_calls++;notice_count=n;memcpy(notices,rows,(size_t)n*sizeof *rows);
}
'''
for name in ['str_of','bool_of','handle_agent','handle_swarms','handle_notifications','handle_models']:
    code += function(name)
code += r'''
static cJSON *object(const char *key,const char *value) {
    cJSON *p=cJSON_CreateObject();assert(p&&cJSON_AddStringToObject(p,key,value));return p;
}
static void add(cJSON *items,const char *key,const char *value) { assert(cJSON_AddItemToArray(items,object(key,value))); }
static void bounds(void) { assert(!held&&storage.before==0xaabbccdd&&storage.after==0x11223344); }
int main(void) {
    storage.before=0xaabbccdd;storage.after=0x11223344;
    char exact[ID_MAX],longer[ID_MAX+1];memset(exact,'a',sizeof exact-1);exact[sizeof exact-1]=0;
    snprintf(longer,sizeof longer,"%sx",exact);
    cJSON *p=object("id",exact);handle_agent(p);cJSON_Delete(p);
    assert(s_agent_count==1&&!strcmp(s_agents[0].id,exact));bounds();
    p=object("id",longer);handle_agent(p);cJSON_Delete(p);
    assert(s_agent_count==1); // formerly a second row aliased the exact ID above
    p=object("id",exact);handle_agent(p);cJSON_Delete(p);assert(s_agent_count==1);
    p=object("id","normal");assert(cJSON_AddStringToObject(p,"machineId",longer));
    assert(cJSON_AddStringToObject(p,"model","a-model-name-beyond-the-old-field-capacity"));
    handle_agent(p);cJSON_Delete(p);assert(s_agent_count==2);
    assert(!s_agents[1].machine_id[0]&&!s_agents[1].model[0]);bounds();
    for(int i=0;i<CABLE_MAX_AGENTS*2;i++) {
        char id[24];snprintf(id,sizeof id,"row-%d",i);p=object("id",id);handle_agent(p);cJSON_Delete(p);
    }
    assert(s_agent_count==CABLE_MAX_AGENTS);bounds();
    for(int kind=0;kind<2;kind++) {
        const char *key=kind?"agentId":"id";
        p=object("selected",longer);cJSON *items=cJSON_AddArrayToObject(p,"items");assert(items);
        add(items,key,longer);add(items,key,exact);add(items,key,exact);add(items,key,"");add(items,key,"second");
        if(kind) { handle_notifications(p);assert(notice_count==2&&!strcmp(notices[0].agent_id,exact)); }
        else { handle_swarms(p);assert(swarm_count==2&&!strcmp(swarms[0].id,exact)&&!selected[0]); }
        cJSON_Delete(p);bounds();
        unsigned calls=kind?notice_calls:swarm_calls;
        p=cJSON_CreateObject();assert(p);
        if(kind)handle_notifications(p);else handle_swarms(p);
        assert((kind?notice_calls:swarm_calls)==calls); // missing list cannot clear current state
        assert(cJSON_AddItemToObject(p,"items",cJSON_CreateObject()));
        if(kind)handle_notifications(p);else handle_swarms(p);
        assert((kind?notice_calls:swarm_calls)==calls);
        assert(cJSON_ReplaceItemInObjectCaseSensitive(p,"items",cJSON_CreateArray()));
        if(kind){handle_notifications(p);assert(notice_count==0);}else{handle_swarms(p);assert(swarm_count==0);}
        cJSON_Delete(p);
    }
    p=cJSON_Parse("{\"selected\":\"tab\",\"items\":[],\"tiles\":[{\"x1\":0,\"y1\":0,\"x2\":1000,\"y2\":1000},{\"x1\":-1,\"y1\":0,\"x2\":1000,\"y2\":1000},{\"x1\":0,\"y1\":0,\"x2\":1e300,\"y2\":1000},{\"x1\":0,\"y1\":0,\"x2\":10,\"y2\":1e999}]}");
    assert(p);handle_swarms(p);cJSON_Delete(p);assert(swarm_count==0 && !strcmp(selected,"tab")); // Round firmware ignores legacy spatial tiles.
    p=cJSON_Parse("{\"items\":[{\"agentId\":\"failed\",\"failed\":true},{\"agentId\":\"question\",\"question\":true},{\"agentId\":\"legacy\"}]}");
    assert(p);handle_notifications(p);cJSON_Delete(p);
    assert(notice_count==3 && notices[0].failed && !notices[0].question &&
           notices[1].question && !notices[1].failed && !notices[2].question && !notices[2].failed);
    p=cJSON_Parse("{\"items\":[{\"agentId\":\"failed\"}]}");
    assert(p);handle_notifications(p);cJSON_Delete(p);assert(notice_count==1&&!notices[0].failed);
    for(int len=0;len<=65;len++) {
        char token[66];memset(token,'t',len);token[len]=0;
        p=cJSON_CreateObject();assert(p);cJSON *entries=cJSON_AddArrayToObject(p,"items");
        cJSON *row=cJSON_CreateObject();assert(cJSON_AddItemToArray(entries,row));
        assert(cJSON_AddStringToObject(row,"agentId","receipt"));
        assert(cJSON_AddStringToObject(row,"readToken",token));handle_notifications(p);
        assert(notice_count==1 && strlen(notices[0].read_token)==(len>0&&len<64?(size_t)len:0));
        cJSON_Delete(p);bounds();
    }
    char profile[sizeof models[0].id],bad_profile[sizeof models[0].id+1];
    memset(profile,'p',sizeof profile-1);profile[sizeof profile-1]=0;
    snprintf(bad_profile,sizeof bad_profile,"%sx",profile);
    p=object("agentId","agent");cJSON *items=cJSON_AddArrayToObject(p,"items");assert(items);
    add(items,"id",bad_profile);add(items,"id",profile);add(items,"id","second");
    s_models_max=4;handle_models(p);cJSON_Delete(p);
    assert(s_models_replied&&sem_gives==1&&s_models_n==2&&!strcmp(models[0].id,profile));bounds();
    printf("Protocol identities: exact %u-byte targets / %zu-byte profiles, overlong/duplicate rejection, malformed lists preserve state, fixed row bounds PASS\n",ID_MAX-1,sizeof profile-1);
}
'''
with tempfile.TemporaryDirectory(prefix='harness-identities-') as folder:
    out=Path(folder);(out/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-O1','-g',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-I',str(json_dir),'-I',str(MAIN),
        str(out/'test.c'),str(json_dir/'cJSON.c'),'-o',str(out/'test')],check=True)
    subprocess.run([str(out/'test')],check=True)
