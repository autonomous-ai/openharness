"""Compile production metrics decoder, UI handlers and outbound builder.

Feed decoded cJSON trees without an ESP SDK, following the draft/question tests.
The JSON byte parser is a separate SDK-dependent gate. No cable/app is opened.
"""
from pathlib import Path
import copy
import json
import math
import os
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
MAIN = HERE / '../main'
NATIVE = MAIN / 'ui/habitat'
UI = (NATIVE / 'ui_habitat.c').read_text()
CABLE = (MAIN / 'cable_client.c').read_text()

def function(name, source=UI):
    m = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert m, name
    return m.group(0) + '\n'

header = r'''
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
typedef struct cJSON { struct cJSON *next,*prev,*child; int type; char *valuestring; int valueint; double valuedouble; char *string; } cJSON;
#define cJSON_IsObject(p) ((p) && (p)->type==64)
#define cJSON_IsArray(p) ((p) && (p)->type==32)
#define cJSON_IsString(p) ((p) && (p)->type==16)
#define cJSON_IsNumber(p) ((p) && (p)->type==8)
#define cJSON_IsTrue(p) ((p) && (p)->type==2)
#define cJSON_IsBool(p) ((p) && ((p)->type==1 || (p)->type==2))
#define cJSON_ArrayForEach(item,p) for((item)=(p)?(p)->child:NULL;(item);(item)=(item)->next)
static inline const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *p,const char *key) {
    for(const cJSON *c=p?p->child:NULL;c;c=c->next) if(c->string && !strcmp(c->string,key)) return c;
    return NULL;
}
'''

bridge = r'''
#include "pro_metrics.h"
#include "cJSON.h"
#include "../../cable_features.h"
#include <assert.h>
#include <stdlib.h>
#include <math.h>
#define COPY(dst,src) snprintf(dst,sizeof dst,"%s",(src)?(src):"")
enum {HOME,TODAY,LAUNCHER};
enum {A_TODAY,A_TODAY_REFRESH,A_METRICS_GET};
typedef struct {int kind;uint32_t revision;char id[128],text[192];} action_t;
static struct {bool connected;int view;pro_metrics_t metrics;} s;
static bool s_session,queue_full,send_ok=true,allocation_fail;
static uint32_t features,now,random_value;
static unsigned sends,changes;
static action_t queued;
static bool cable_client_supports(uint32_t value) {return (features&value)==value;}
static uint32_t ms(void) {return now;}
static uint32_t esp_random(void) {return ++random_value;}
static void display_lock(void) {}
static void display_unlock(void) {}
static void input_cancel(void) {}
static void change(void) {changes++;}
static void view(int v) {s.view=v;if(v!=TODAY)pro_metrics_close(&s.metrics);}
static bool queue(action_t a) {if(queue_full)return false;queued=a;return true;}
static char wire_type[24],wire_request[48];
static cJSON root;
static cJSON *msg(const char *type) {COPY(wire_type,type);return allocation_fail?NULL:&root;}
static bool msg_string(cJSON **p,const char *key,const char *value) {
    assert(!strcmp(key,"requestId"));if(!*p)return false;COPY(wire_request,value);return true;
}
static bool send_json(cJSON *p) {if(!p)return false;sends++;return send_ok;}
'''
bridge += function('cable_client_metrics_get', CABLE)
bridge += function('ui_metrics_source') + function('ui_metrics_state')
dispatch = UI.split('    case A_TODAY:\n', 1)[1].split('    case A_WORK_INTENT:', 1)[0]
bridge += 'static void dispatch(action_t a) {switch(a.kind){case A_TODAY:\n' + dispatch + '}}\n'
worker = UI.split('static void worker(', 1)[1].split('        case A_METRICS_GET: {', 1)[1].split('#endif', 1)[0]
bridge += 'static void work(action_t a) {switch(a.kind){case A_METRICS_GET: {' + worker + '}}\n'
bridge += r'''
int decode_check(const cJSON *p,const char *machine,int expected,int has_cost,double cost,int coverage) {
    pro_metrics_usage_t out,before;memset(&out,0xa5,sizeof out);before=out;
    bool ok=pro_metrics_decode(p,machine,&out);assert(ok==(expected!=0));
    if(!ok){assert(!memcmp(&out,&before,sizeof out));return 0;}
    assert(out.has_cost==(has_cost!=0) && out.coverage==coverage);
    if(has_cost)assert(out.cost==cost);
    assert(!strcmp(out.day,"2026-10-06") && !strcmp(out.machine_name,"Studio Mac"));
    return 1;
}
int feature_check(const cJSON *p) {return (int)cable_features_parse(p);}
void duplicate_check(cJSON *p) {
    cJSON clone=*p->child;clone.next=p->child;p->child=&clone;
    pro_metrics_usage_t out;assert(!pro_metrics_decode(p,"local",&out));p->child=clone.next;
}
void integration_check(cJSON *payload) {
    cJSON *request=(cJSON*)cJSON_GetObjectItemCaseSensitive(payload,"requestId");
    cJSON *schema=(cJSON*)cJSON_GetObjectItemCaseSensitive(payload,"schema");
    cJSON *ok=(cJSON*)cJSON_GetObjectItemCaseSensitive(payload,"ok");
    assert(request && schema && ok);
    memset(&s,0,sizeof s);s.connected=s_session=true;features=CABLE_FEATURE_METRICS;now=1000;
    dispatch((action_t){.kind=A_TODAY});assert(!s.metrics.request[0] && !sends); // No welcome identity.
    ui_metrics_source("local",true);features=0;dispatch((action_t){.kind=A_TODAY});assert(!s.metrics.request[0]);
    features=CABLE_FEATURE_METRICS;dispatch((action_t){.kind=A_TODAY});
    assert(s.view==TODAY && s.metrics.phase==PRO_METRICS_WAIT && !sends);action_t first=queued;
    dispatch((action_t){.kind=A_TODAY_REFRESH});assert(s.metrics.serial==first.revision);
    work(first);assert(sends==1 && !strcmp(wire_type,"metrics.get") && !strcmp(wire_request,first.id));
    request->valuestring="wrong";ui_metrics_state(payload);assert(s.metrics.phase==PRO_METRICS_WAIT);
    request->valuestring=first.id;schema->valuedouble=2;ui_metrics_state(payload);assert(s.metrics.phase==PRO_METRICS_WAIT);
    schema->valuedouble=1;ui_metrics_state(payload);assert(s.metrics.phase==PRO_METRICS_READY && s.metrics.usage.has_cost);
    assert(s.metrics.usage.cost==12.34);ui_metrics_state(payload);assert(s.metrics.phase==PRO_METRICS_READY);
    uint32_t received=s.metrics.received;
    assert(pro_metrics_tick(&s.metrics,received+300000));assert(pro_metrics_age(&s.metrics,received+300000)>300000);
    uint64_t until=s.metrics.usage.end-s.metrics.usage.generated-20000;
    assert(!pro_metrics_expired(&s.metrics,received+(uint32_t)until-1));
    assert(pro_metrics_tick(&s.metrics,received+(uint32_t)until));
    assert(s.metrics.phase==PRO_METRICS_EXPIRED && !s.metrics.usage.has_cost);
    dispatch((action_t){.kind=A_TODAY_REFRESH});action_t delayed=queued;
    ui_metrics_source("other",true);work(delayed);ui_metrics_state(payload);
    assert(sends==1 && s.metrics.phase==PRO_METRICS_EMPTY && !s.metrics.usage.has_cost);
    ui_metrics_source("local",true);dispatch((action_t){.kind=A_TODAY});delayed=queued;
    ui_metrics_source(NULL,false);work(delayed);assert(sends==1 && !s.metrics.supported);
    ui_metrics_source("local",true);dispatch((action_t){.kind=A_TODAY});
    request->valuestring=delayed.id;ui_metrics_state(payload);assert(s.metrics.phase==PRO_METRICS_WAIT);
    delayed=queued;view(HOME);work(delayed);assert(sends==1 && s.metrics.phase==PRO_METRICS_EMPTY);
    s.connected=false;ui_metrics_source("local",true);assert(!s.metrics.supported);s.connected=true;
    ui_metrics_source("local",true);queue_full=true;dispatch((action_t){.kind=A_TODAY});assert(s.metrics.phase==PRO_METRICS_ERROR);queue_full=false;
    send_ok=false;dispatch((action_t){.kind=A_TODAY_REFRESH});work(queued);assert(s.metrics.phase==PRO_METRICS_ERROR);send_ok=true;
    now=UINT32_MAX-4000;dispatch((action_t){.kind=A_TODAY_REFRESH});
    assert(!pro_metrics_tick(&s.metrics,s.metrics.deadline-1));assert(pro_metrics_tick(&s.metrics,s.metrics.deadline));
    assert(s.metrics.phase==PRO_METRICS_ERROR);
    dispatch((action_t){.kind=A_TODAY_REFRESH});delayed=queued;request->valuestring=delayed.id;ok->type=1;
    ui_metrics_state(payload);assert(s.metrics.phase==PRO_METRICS_ERROR && !s.metrics.usage.has_cost);ok->type=2;
    char identity[49];memset(identity,'a',48);identity[48]=0;ui_metrics_source(identity,true);assert(!s.metrics.supported);
    identity[47]=0;ui_metrics_source(identity,true);assert(s.metrics.supported && strlen(s.metrics.machine)==47);
    features=CABLE_FEATURE_METRICS;s_session=true;
    assert(!cable_client_metrics_get(NULL) && !cable_client_metrics_get("") && !cable_client_metrics_get("bad/id"));
    char id[49];memset(id,'x',48);id[48]=0;assert(!cable_client_metrics_get(id));id[47]=0;assert(cable_client_metrics_get(id));
    allocation_fail=true;assert(!cable_client_metrics_get("ok-1"));allocation_fail=false;
    s_session=false;assert(!cable_client_metrics_get("ok-1"));s_session=true;features=0;assert(!cable_client_metrics_get("ok-1"));
    assert(changes>0);
}
'''

def number(value):
    return 'NAN' if math.isnan(value) else 'INFINITY' if math.isinf(value) else repr(value)

def tree(value, lines):
    node = 'node'+str(len(lines))
    if value is None: fields = '.type=4'
    elif isinstance(value, bool): fields = '.type='+str(2 if value else 1)
    elif isinstance(value, (int, float)): fields = '.type=8,.valuedouble='+number(value)
    elif isinstance(value, str): fields = '.type=16,.valuestring='+json.dumps(value)
    else: fields = '.type='+str(64 if isinstance(value,dict) else 32)
    lines.append('cJSON '+node+'={'+fields+'};')
    if isinstance(value,(dict,list)):
        last = None
        for key, item in value.items() if isinstance(value, dict) else enumerate(value):
            child = tree(item, lines)
            if isinstance(value, dict): lines.append(child+'.string='+json.dumps(key)+';')
            lines.append((last+'.next' if last else node+'.child')+'=&'+child+';')
            last = child
    return node

blocks = []
def call(value, expression):
    lines=[];node=tree(value,lines)
    blocks.append('{\n'+'\n'.join(lines)+'\n'+expression.replace('NODE','&'+node)+';\n}')

usage = dict(scope='local-transcripts', machineId='local', machineName='Studio Mac', day='2026-10-06',
             windowStartMs=1791244800000, windowEndMs=1791331200000, generatedAtMs=1791248400000,
             asOfMs=1791248370000, currency='USD', costKind='estimated', coverage='complete',
             costUsd=12.34, stale=False, providers=[
                 dict(id='claude',enabled=True,state='ok',priced=True,asOfMs=1791248370000),
                 dict(id='codex',enabled=False,state='disabled',priced=False),
                 dict(id='opencode',enabled=False,state='disabled',priced=False)])

with tempfile.TemporaryDirectory(prefix='harness-pro-metrics-') as directory:
    count = 0
    def check(value, valid=False, machine='local'):
        global count
        cost=value.get('costUsd',0);cost=cost if isinstance(cost,(int,float)) else 0
        coverage=['complete','partial','unavailable'].index(value.get('coverage')) if value.get('coverage') in ['complete','partial','unavailable'] else 0
        call(value,f'decode_check(NODE,{json.dumps(machine)},{int(valid)},{int("costUsd" in value)},{number(cost)},{coverage})')
        count+=1
    check(usage,True)
    for value in [0,0.001,1e9]:
        u=copy.deepcopy(usage);u['costUsd']=value;check(u,True)
    for value in [-1,1e9+1,math.nan,math.inf,'0',None]:
        u=copy.deepcopy(usage);u['costUsd']=value;check(u)
    for key in usage:
        u=copy.deepcopy(usage);del u[key];check(u)
    for key,value in [('scope','fleet'),('machineId','remote'),('machineName','x'*40),('day','2026-02-30'),
                      ('day','2026-13-01'),('currency','EUR'),('costKind','actual'),('stale',True),('stale',1),
                      ('coverage','unavailable'),('coverage','other'),('windowStartMs',0),('windowEndMs',1791244800000),
                      ('generatedAtMs',math.nan),('generatedAtMs',1.5),('generatedAtMs',9007199254740992),('asOfMs',1791248400001)]:
        u=copy.deepcopy(usage);u[key]=value;check(u)
    for hours in [23,25]:
        u=copy.deepcopy(usage);u['windowEndMs']=u['windowStartMs']+hours*3600000;check(u,True)
    for hours in [22,26]:
        u=copy.deepcopy(usage);u['windowEndMs']=u['windowStartMs']+hours*3600000;check(u)
    for field,value in [('id','unknown'),('id','codex'),('enabled',False),('priced',False),('state','disabled'),('state','failed'),('asOfMs',0),('asOfMs',1791244800000-1)]:
        u=copy.deepcopy(usage);u['providers'][0][field]=value;check(u)
    for providers in [[],usage['providers'][:2],usage['providers']+[usage['providers'][0]],{},None]:
        u=copy.deepcopy(usage);u['providers']=providers;check(u)
    u=copy.deepcopy(usage);u['providers'].reverse();check(u,True)
    u=copy.deepcopy(usage);u['coverage']='partial';u['providers'][0]['state']='partial';check(u,True)
    u=copy.deepcopy(usage);u['asOfMs']-=300000;u['providers'][0]['asOfMs']=u['asOfMs'];u['stale']=True;check(u,True)
    u=copy.deepcopy(usage);del u['costUsd'];del u['asOfMs'];u['coverage']='unavailable';u['stale']=True
    u['providers'][0]=dict(id='claude',enabled=False,state='disabled',priced=False);check(u,True)
    u['costUsd']=0;check(u)
    call(usage,'duplicate_check(NODE)')
    for feature,bit in [('metrics.read.v1',64),('metrics.read.v2',0),('Metrics.read.v1',0)]:
        call(dict(features=[feature]),f'assert(feature_check(NODE)=={bit})')
    call(dict(t='metrics.state',requestId='request',schema=1,ok=True,usage=usage),'integration_check(NODE)')
    root=Path(directory);(root/'cJSON.h').write_text(header)
    (root/'bridge.c').write_text(bridge+'\nint main(void){\n'+'\n'.join(blocks)+'\nreturn 0;}\n')
    executable=root/'metrics'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g',
                    '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
                    '-I',str(root),'-I',str(NATIVE),str(root/'bridge.c'),str(NATIVE/'pro_metrics.c'),
                    str(MAIN/'cable_features.c'),'-o',str(executable)],check=True)
    subprocess.run([str(executable)],check=True)
    print(f'Pro metrics: PASS ({count} decoded-tree cases; capability, outbound bounds, production UI/worker, exact correlation, source/reconnect invalidation, timeout/wrap, freshness/day expiry and missing != zero)')
