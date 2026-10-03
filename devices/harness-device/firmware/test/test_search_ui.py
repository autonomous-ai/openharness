"""Exercise production output search packet validators and callbacks with decoded JSON trees."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
native = Path(__file__).resolve().parent / '../main/ui/habitat'
source = (native/'ui_habitat.c').read_text()
def function(name):
    m=re.search(r'^[^\n]*\b'+name+r'\([^;]*?\)\n\{.*?^\}',source,re.M|re.S)
    assert m,name
    return m.group(0)+'\n'
code=r'''
#include "terminal.h"
#include "selection.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <assert.h>
enum {HOME,SELECTION,VOICE};
typedef struct cJSON {const char *string,*valuestring;int type,valueint;double valuedouble;struct cJSON *child,*next;} cJSON;
enum {STRING=1,TRUE=2,NUMBER=3};
static bool cJSON_IsString(const cJSON *v){return v && v->type==STRING;}
static bool cJSON_IsNumber(const cJSON *v){return v && v->type==NUMBER;}
static bool cJSON_IsTrue(const cJSON *v){return v && v->type==TRUE;}
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *key){
    for(const cJSON *p=v?v->child:NULL;p;p=p->next)if(p->string && !strcmp(p->string,key))return p;return NULL;
}
static cJSON object(cJSON *children,int n){for(int i=0;i<n;i++)children[i].next=i+1<n?&children[i+1]:NULL;return(cJSON){.child=children};}
static ht_selection_t selection;
static struct {bool voice_open,voice_waiting,voice_search;int voice_return,view;} s;
static int gesture,changes;
static uint32_t ms(void){return 1000;}
static void change(void){changes++;}
static void display_lock(void){}
static void display_unlock(void){}
static void voice_close(void){s.voice_open=s.voice_waiting=false;}
static void view(int v){s.view=v;}
static void ht_gesture_guard(int *g,uint32_t t){(void)g;(void)t;}
static bool emit(const ht_select_command_t *c,void *ctx){(void)c;(void)ctx;return true;}
#define COPY(dst,src) snprintf(dst,sizeof(dst),"%s",src)
'''

for name in ['selection_search_fields','ui_voice_search','ui_selection_state']:
    code+=function(name)
code+=r"""
#define S(key,v) {.string=key,.type=STRING,.valuestring=v}
#define N(key,v) {.string=key,.type=NUMBER,.valueint=v,.valuedouble=v}
#define B(key) {.string=key,.type=TRUE}
int main(void) {
    ht_selection_open(&selection,"pick-one","a",1000,emit,NULL);
    assert(ht_selection_reply(&selection,selection.request,"pick-one",true,1,"old passage",1,false,NULL,1001));
    cJSON fields[]={S("selectionId","pick-one"),S("agentId","a"),N("revision",2),S("excerpt","error [x]"),
        N("rows",1),S("query","error [x]"),N("match",1),N("matches",3),B("ok"),S("requestId","pick-2")};
    cJSON p=object(fields,sizeof fields/sizeof *fields);
    s.voice_open=s.voice_waiting=true;s.voice_return=SELECTION;s.view=VOICE;
    ui_voice_search(&p);assert(selection.revision==1); // Ordinary dictation cannot consume a search reply.
    s.voice_search=true;fields[1].valuestring="another";ui_voice_search(&p);assert(s.voice_open);
    fields[1].valuestring="a";fields[2].valuedouble=2.5;ui_voice_search(&p);assert(s.voice_open);
    fields[2].valuedouble=2;fields[6].valueint=fields[6].valuedouble=4;ui_voice_search(&p);assert(s.voice_open);
    fields[6].valueint=fields[6].valuedouble=1;ui_voice_search(&p);
    assert(!s.voice_open && s.view==SELECTION && selection.revision==2 && selection.matches==3);
    ht_selection_move(&selection,60,1002);assert(selection.pending);
    char request[32];snprintf(request,sizeof request,"pick-%lu",(unsigned long)selection.request);
    fields[9].valuestring="pick-99";fields[2].valueint=fields[2].valuedouble=3;ui_selection_state(&p);assert(selection.pending);
    fields[9].valuestring=request;fields[6].valueint=fields[6].valuedouble=2;ui_selection_state(&p);
    assert(!selection.pending && selection.match==2 && changes>0);
    // No matches still returns a usable Find control but no quote.
    s.voice_open=s.voice_waiting=true;s.view=VOICE;fields[2].valueint=fields[2].valuedouble=4;
    fields[4].valueint=fields[4].valuedouble=0;fields[6].valueint=fields[6].valuedouble=0;
    fields[7].valueint=fields[7].valuedouble=0;fields[3].valuestring="";
    ui_voice_search(&p);assert(!s.voice_open && selection.matches==0 && selection.rows==0 && !selection.excerpt[0]);
    s.voice_open=s.voice_waiting=true;ht_selection_close(&selection);ui_voice_search(&p);assert(s.voice_open);
    puts("search UI: PASS (purpose, recipient, revision, match metadata, pending movement, no matches and late cancellation)");
}
"""
with tempfile.TemporaryDirectory(prefix='harness-search-ui-') as d:
    root=Path(d);(root/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
        '-I',str(native),str(root/'test.c'),str(native/'selection.c'),'-o',str(root/'test')],check=True)
    subprocess.run([str(root/'test')],check=True)
