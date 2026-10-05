"""Exercise production draft packet validators and callbacks with decoded JSON trees."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import defines
native = Path(__file__).resolve().parent / '../main/ui/habitat'
source = (native/'ui_habitat.c').read_text()
def function(name):
    m=re.search(r'^[^\n]*\b'+name+r'\([^;]*?\)\n\{.*?^\}',source,re.M|re.S)
    assert m,name
    return m.group(0)+'\n'
code=r'''
#include "terminal.h"
#include "draft.h"
#include "carry.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <assert.h>
enum {HOME,DRAFT,DRAFT_OPTIONS,VOICE,MESSAGE};
typedef struct cJSON {const char *string,*valuestring;int type,valueint;double valuedouble;struct cJSON *child,*next;} cJSON;
enum {STRING=1,TRUE=2,NUMBER=3};
static bool cJSON_IsString(const cJSON *v){return v && v->type==STRING;}
static bool cJSON_IsNumber(const cJSON *v){return v && v->type==NUMBER;}
static bool cJSON_IsTrue(const cJSON *v){return v && v->type==TRUE;}
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *key){
    for(const cJSON *p=v?v->child:NULL;p;p=p->next)if(p->string && !strcmp(p->string,key))return p;return NULL;
}
static cJSON object(cJSON *children,int n){for(int i=0;i<n;i++)children[i].next=i+1<n?&children[i+1]:NULL;return(cJSON){.child=children};}
static ht_draft_t draft;
static ht_carry_t carry;
static struct {bool voice_open,voice_waiting,voice_review;int voice_return,view,offset;uint32_t voice_draft_revision;char title[80],message[256];} s;
static int gesture,changes;
static uint32_t ms(void){return 1000;}
static void change(void){changes++;}
static void input_cancel(void){}
static void display_lock(void){}
static void display_unlock(void){}
static void voice_close(void){s.voice_open=s.voice_waiting=s.voice_review=false;}
static void view(int v){s.view=v;s.offset=0;}
static void ht_gesture_guard(int *g,uint32_t t){(void)g;(void)t;}
static bool draft_emit(const ht_draft_command_t *c,void *ctx){(void)c;(void)ctx;return true;}
#define COPY(dst,src) snprintf(dst,sizeof(dst),"%s",src)
'''
code += defines('UI_FONT', source=source)
code += defines('FACE_CX', source=source)
# The production helpers are skin-aware; this harness has no Focus skin, so they are the mono calls.
code += '''static int ui_rows(const char *t,const ht_font_t *f,int w){return ht_text_rows(t,f,w);}
static bool ui_can_display(const char *t,const ht_font_t *f,int w,int l){return ht_can_display(t,f,w,l);}
'''
for name in ['copy','question_rows','draft_page','ui_voice_draft','ui_draft_state']:
    code+=function(name)
code+=r'''
#define S(key,v) {.string=key,.type=STRING,.valuestring=v}
#define N(key,v) {.string=key,.type=NUMBER,.valueint=v,.valuedouble=v}
#define B(key) {.string=key,.type=TRUE}
int main(void){
    cJSON fields[]={S("id","draft-one"),N("revision",1),B("active"),S("text","Keep the API."),S("agentId","a"),
        N("position",1),N("total",1),S("name","Original recipient"),B("canSend"),B("ok"),S("requestId","draft-1"),B("sent"),S("carryId","quote")};
    cJSON p=object(fields,sizeof fields/sizeof *fields);
    ht_draft_page_t page={0};assert(draft_page(&p,&page));assert(page.active && page.can_send && page.revision==1);
    fields[1].valuedouble=1.5;assert(!draft_page(&p,&page));fields[1].valuedouble=1;
    fields[5].valueint=fields[5].valuedouble=0;assert(!draft_page(&p,&page));fields[5].valueint=fields[5].valuedouble=1;
    char oversized[500];memset(oversized,'x',sizeof oversized-1);oversized[sizeof oversized-1]=0;
    fields[3].valuestring=oversized;assert(!draft_page(&p,&page));fields[3].valuestring="Unicode emoji \xf0\x9f\x90\x88";
    assert(draft_page(&p,&page) && !page.can_send);fields[3].valuestring="Keep the API.";
    s.voice_open=s.voice_waiting=true;s.voice_return=HOME;
    ui_voice_draft(&p);assert(!draft.page.active); // Normal tap-to-send cannot consume a draft reply.
    s.voice_review=true;ui_voice_draft(&p);
    assert(draft.page.active && !s.voice_open && s.view==DRAFT && !strcmp(draft.page.name,"Original recipient"));
    // An edit reply must match both the retained draft and the recording's revision.
    s.voice_open=s.voice_waiting=s.voice_review=true;s.voice_return=DRAFT;s.voice_draft_revision=1;
    fields[0].valuestring="wrong";fields[1].valueint=fields[1].valuedouble=2;ui_voice_draft(&p);assert(s.voice_open);
    fields[0].valuestring="draft-one";fields[3].valuestring="New exact words.";ui_voice_draft(&p);
    assert(!s.voice_open && draft.page.revision==2 && !strcmp(draft.page.text,"New exact words."));
    assert(ht_draft_command(&draft,HT_DRAFT_SEND,2,0,1000));
    char request[32];snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);fields[10].valuestring=request;
    fields[2].type=0;carry.active=true;strcpy(carry.id,"different");ui_draft_state(&p);
    assert(!draft.page.active && s.view==HOME && carry.active); // Only the accepted carry is cleared.
    fields[2].type=TRUE;assert(draft_page(&p,&page));ht_draft_open(&draft,&page,draft_emit,NULL);
    strcpy(carry.id,"quote");assert(ht_draft_command(&draft,HT_DRAFT_SEND,2,0,1000));
    snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);fields[2].type=0;ui_draft_state(&p);
    assert(!draft.page.active && !carry.active);
    fields[2].type=TRUE;assert(draft_page(&p,&page));ht_draft_open(&draft,&page,draft_emit,NULL);
    s.view=DRAFT;assert(ht_draft_command(&draft,HT_DRAFT_MOVE,2,1,1000));
    fields[10].valuestring="draft-0";ui_draft_state(&p);assert(draft.pending);
    fields[10].valuestring="draft-1junk";ui_draft_state(&p);assert(draft.pending);
    snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);fields[10].valuestring=request;
    fields[0].valuestring="different";ui_draft_state(&p);assert(draft.pending);
    fields[0].valuestring="draft-one";fields[1].valueint=fields[1].valuedouble=3;ui_draft_state(&p);
    assert(!draft.pending && draft.page.revision==3 && changes>0);
    puts("draft UI: PASS (production validators/callbacks; bounded text, edit revision, voice ownership, receipt correlation and carry ownership)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-draft-ui-') as d:
    root=Path(d);(root/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
        '-I',str(native),str(root/'test.c'),str(native/'draft.c'),str(native/'carry.c'),str(native/'terminal.c'),str(native/'fonts.c'),'-o',str(root/'test')],check=True)
    subprocess.run([str(root/'test')],check=True)
