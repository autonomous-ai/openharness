"""Exercise production draft packet validators and callbacks with decoded JSON trees."""
from pathlib import Path
import os
import re
import subprocess
import sys
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
#include "pro_carry_review.h"
#include "pro_draft_recovery.h"
#include "pro_work_intent.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <assert.h>
#ifdef DEVICE_PRO_COMPANION
// This fixture checks packet ownership, not Pro typography. The native Pro
// controls suite compiles the actual proportional fonts and reading layout.
#define ht_pro_32 ht_nav_32
#define ht_pro_text_rows ht_text_rows
void ht_pro_raster(const ht_run_t *run,ht_rect_t clip,uint16_t *out) {
    (void)run;(void)clip;(void)out;assert(false);
}
#endif
enum {HOME,DRAFT,DRAFT_OPTIONS,VOICE,MESSAGE,CARRY_PREVIEW};
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
static struct {pro_carry_review_t carry_review;pro_draft_recovery_t draft_recovery;bool connected, voice_carry,voice_open,voice_waiting,voice_review;int voice_return,view,offset,work_voice_mode;uint32_t voice_draft_revision;char title[80],message[256],work_agent[64];} s;
static int gesture,changes;
static uint32_t ms(void){return 1000;}
static void change(void){changes++;}
static void input_cancel(void){}
static void display_lock(void){}
static void display_unlock(void){}
static void voice_close(void){s.voice_open=s.voice_waiting=s.voice_review=false;}
static void view(int v){s.view=v;s.offset=0;}
static void ht_gesture_guard(int *g,uint32_t t){(void)g;(void)t;}
#ifdef DEVICE_PRO_COMPANION
static bool pro_draft_store_queue(bool clear) {
    if(clear) {if(pro_carry_review_owns(&s.carry_review,&draft.page)&&!strcmp(carry.id,s.carry_review.id))ht_carry_close(&carry);ht_draft_reset(&draft);memset(&s.carry_review,0,sizeof s.carry_review);pro_draft_recovery_close(&s.draft_recovery);view(HOME);}
    else s.draft_recovery.store=PRO_RECOVERY_SAVED;
    return true;
}
#endif
static bool draft_emit(const ht_draft_command_t *c,void *ctx){(void)c;(void)ctx;return true;}
#define COPY(dst,src) snprintf(dst,sizeof(dst),"%s",src)
'''
code += defines('UI_FONT', source=source)
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
    s.voice_review=true;
#ifdef DEVICE_PRO_COMPANION
    s.connected=true;pro_draft_recovery_source(&s.draft_recovery,"computer");
    pro_draft_recovery_pin(&s.draft_recovery,"a",PRO_WORK_TASK);
#endif
    ui_voice_draft(&p);
    assert(draft.page.active && !s.voice_open && s.view==DRAFT && !strcmp(draft.page.name,"Original recipient"));
#ifdef DEVICE_PRO_COMPANION
    ht_draft_reset(&draft); s.voice_open=s.voice_waiting=s.voice_review=true;s.work_voice_mode=PRO_WORK_GOAL;
    strcpy(s.work_agent,"different");ui_voice_draft(&p);assert(!draft.page.active && s.voice_open);
    strcpy(s.work_agent,"a");ui_voice_draft(&p);assert(draft.page.active && !s.voice_open && s.work_voice_mode==PRO_WORK_GOAL);
#endif
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
#ifdef DEVICE_PRO_COMPANION
    assert(!draft.page.active && carry.active); // An unrelated tray is not this Task's attachment.
#else
    assert(!draft.page.active && !carry.active);
#endif
    fields[2].type=TRUE;assert(draft_page(&p,&page));ht_draft_open(&draft,&page,draft_emit,NULL);
    s.view=DRAFT;assert(ht_draft_command(&draft,HT_DRAFT_MOVE,2,1,1000));
    fields[10].valuestring="draft-0";ui_draft_state(&p);assert(draft.pending);
    fields[10].valuestring="draft-1junk";ui_draft_state(&p);assert(draft.pending);
    snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);fields[10].valuestring=request;
    fields[0].valuestring="different";ui_draft_state(&p);assert(draft.pending);
    fields[0].valuestring="draft-one";fields[1].valueint=fields[1].valuedouble=3;ui_draft_state(&p);
    assert(!draft.pending && draft.page.revision==3 && changes>0);
#ifdef DEVICE_PRO_COMPANION
    // Carry ownership comes from the initial recording, never from a later tray.
    for(int receipt=0;receipt<6;receipt++) {
        memset(&s,0,sizeof s);ht_draft_reset(&draft);
        carry=(ht_carry_t){.active=true,.rows=3,.id="quote",.source="Research",.excerpt="Keep the original API."};
        pro_carry_review_begin(&s.carry_review,&carry,"a","Original recipient");
        s.voice_open=s.voice_waiting=s.voice_review=s.voice_carry=true;s.voice_return=HOME;s.connected=true;
        pro_draft_recovery_source(&s.draft_recovery,"computer");pro_draft_recovery_pin(&s.draft_recovery,"a",PRO_WORK_TASK);
        fields[2].type=TRUE;fields[9].type=TRUE;fields[11].type=TRUE;fields[12].valuestring="quote";
        fields[4].valuestring="changed-recipient";ui_voice_draft(&p);
        assert(s.voice_open&&!draft.page.active&&!s.carry_review.draft[0]);
        fields[4].valuestring="a";ui_voice_draft(&p);
        assert(!s.voice_open&&pro_carry_review_owns(&s.carry_review,&draft.page));
        assert(!strcmp(s.carry_review.draft,"draft-one"));
        COPY(carry.source,"New tray source");COPY(carry.excerpt,"A different passage.");
        assert(!strcmp(s.carry_review.source,"Research")&&!strcmp(s.carry_review.excerpt,"Keep the original API."));

        assert(ht_draft_command(&draft,receipt==5?HT_DRAFT_DISCARD:HT_DRAFT_SEND,3,0,1000));
        snprintf(request,sizeof request,"draft-%lu",(unsigned long)draft.request);
        fields[10].valuestring=request;
        fields[4].valuestring="changed-recipient";ui_draft_state(&p);assert(draft.pending);
        fields[4].valuestring="a";
        if(receipt==0) { // Known active rejection retains the exact words and context.
            fields[9].type=0;ui_draft_state(&p);
            assert(draft.page.active&&draft.failed&&!s.carry_review.detached);
        } else {
            fields[2].type=0;
            if(receipt==1)fields[9].type=0; // Host no longer owns the draft.
            if(receipt==2)fields[12].valuestring="other-quote";
            if(receipt==3)fields[11].type=0; // No sent receipt, even with ok:true.
            if(receipt==5)fields[11].type=0; // Explicit discard is allowed to close.
            ui_draft_state(&p);
            if(receipt<4) assert(draft.page.active&&draft.failed&&draft.page.locked&&s.carry_review.detached);
            else assert(!draft.page.active&&!s.carry_review.id[0]&&!carry.active);
        }
        if(receipt<4) {
            assert(!strcmp(draft.page.text,"New exact words.")&&!strcmp(s.carry_review.excerpt,"Keep the original API."));
            assert(!ht_draft_command(&draft,HT_DRAFT_SEND,3,0,1000));
        }
    }
    puts("Pro Carry receipts: PASS (pinned recipient/draft/context, rejected/expired/ambiguous preservation, no resend, exact send/discard release)");
#endif
    puts("draft UI: PASS (production validators/callbacks; bounded text, edit revision, voice ownership, receipt correlation and carry ownership)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-draft-ui-') as d:
    root=Path(d);(root/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g','-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),
        *(['-DDEVICE_PRO_COMPANION=1','-DDRAFT_ROWS=6'] if '--pro' in sys.argv else []),
        '-I',str(native),str(root/'test.c'),str(native/'draft.c'),str(native/'carry.c'),str(native/'terminal.c'),str(native/'fonts.c'),'-o',str(root/'test')],check=True)
    subprocess.run([str(root/'test')],check=True)
