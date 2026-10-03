"""Production decision handlers/renderers with deterministic transport and cJSON accessor doubles.

The doubles construct already-decoded trees; JSON parsing and real USB are outside this fixture.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import defines

native = Path(__file__).resolve().parent / '../main/ui/habitat'
source = (native / 'ui_habitat.c').read_text()
def function(name):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match.group(0) + '\n'

code = r'''
#include "terminal.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <assert.h>
#include "../../cable_features.h"
static bool cable_client_supports(uint32_t features) { (void)features; return true; }
'''
code += defines('ID_MAX','CABLE_NAME_MAX','CABLE_READ_TOKEN_MAX')
code += defines('QUESTION_MAX','OPTION_MAX','PANE_RESULT_BYTES','UI_FONT','Q_ROWS',source=source)
code += defines('FACE_CX', source=source)
code += source[source.index('typedef enum {'):source.index('typedef struct {\n    char id[ID_MAX], name[CABLE_NAME_MAX]')]
code += source[source.index('typedef struct {\n    char key[256]'):source.index('static EXT_RAM_BSS_ATTR struct {')]
code += r'''
typedef struct cJSON { const char *string, *valuestring; int type; double valuedouble; struct cJSON *child, *next; } cJSON;
enum { JSTRING=1, JTRUE=2, JARRAY=3, JOBJECT=4, JNUMBER=5 };
static bool cJSON_IsString(const cJSON *v) { return v && v->type==JSTRING; }
static bool cJSON_IsNumber(const cJSON *v) { return v && v->type==JNUMBER; }
static bool cJSON_IsTrue(const cJSON *v) { return v && v->type==JTRUE; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *key) {
    for (const cJSON *p=v ? v->child : NULL;p;p=p->next) if (p->string && !strcmp(p->string,key)) return p;
    return NULL;
}
static const cJSON *cJSON_GetArrayItem(const cJSON *v,int index) {
    const cJSON *p=v ? v->child : NULL; while (p && index--) p=p->next; return p;
}
#define cJSON_ArrayForEach(it,v) for ((it)=(v) ? (v)->child : NULL;(it);(it)=(it)->next)
static cJSON object(cJSON *children,int n) {
    for (int i=0;i<n;i++) children[i].next=i+1<n ? &children[i+1] : NULL;
    return (cJSON){.type=JOBJECT,.child=n ? children : NULL};
}
static struct { question_t q; bool voice_open,voice_waiting,touch_down; uint32_t voice_question_revision,notice_sequence; int voice_question_index; view_t voice_return; char title[80],message[256]; view_t view; int offset,pressed,hit_count,active,notice_count; char pending_focus[ID_MAX],opening_notice[ID_MAX]; bool connected; hit_t hits[24]; } s;
typedef struct { char id[64],name[96]; } agent_t;
static agent_t agents[2]={{.id="a",.name="Research helper"},{.id="b",.name="Remote helper"}};
static bool b_known;
static struct { bool available,pending; char agent[64]; } visit;
static void ht_visit_close(void *v) { (void)v; visit.available=false; }
static bool is_question(const char *id) { return !strcmp(id,"b"); }
static int find(const char *id) { return !strcmp(id,"a") ? 0 : b_known && !strcmp(id,"b") ? 1 : -1; }
static question_submit_t packet;
static uint32_t now=100,random_value=1;
static int gesture;
static void ht_gesture_guard(int *g,uint32_t time) { (void)g;(void)time; }
static bool congested,transport_ok=true,pending_receipt;
static action_t queued;
static int queued_answers,sent_answers,removed,notices,reads;
static uint8_t sent_choices[4];
static char sent_draft[48];
static agent_t *active(void) { return &agents[s.active]; }
static uint32_t ms(void) { return now; }
static uint32_t esp_random(void) { return random_value++; }
static void change(void) {}
static void input_cancel(void) { s.pressed=-1; }
static void view(view_t v) { input_cancel(); s.view=v; s.offset=0; }
static void voice_close(void) { s.voice_open=s.voice_waiting=false; }
static void display_lock(void) {}
static void display_unlock(void) {}
static int wakes;
static void display_wake(void) { wakes++; }
static bool queue(action_t a) {
    if (congested) return false;
    queued=a; if (a.kind==A_ANSWER) queued_answers++; return true;
}
static void notice_add(const char *id,const char *name,const char *machine,const char *text,bool question,bool failed) {
    assert(!failed); // Asking a question cannot manufacture a failure notification.
    (void)id;(void)name;(void)machine;(void)text;assert(question);notices++;
}
static void notice_forget_read(const char *id) { assert(id && *id); }
static void notice_remove(const char *id,bool all) { assert(id && all);removed++; }
static void cable_client_question_read(const char *id,const char *fetch) { assert(id && fetch);reads++; }
static bool cable_client_answer_reviewed(const char *id,const char *fetch,const char *token,const uint8_t *choices,const char drafts[][48],int n) {
    assert(!strcmp(id,"a") && fetch[0] && !strcmp(token,"token-a") && n>0 && n<=4);
    snprintf(sent_draft,sizeof sent_draft,"%s",drafts[0]); memcpy(sent_choices,choices,(size_t)n);sent_answers++;return transport_ok;
}
#include "theme.h"
#define BG ht_rgb(HT_THEME_CANVAS)
#define FG ht_rgb(HT_THEME_TEXT)
#define DIM ht_rgb(HT_THEME_SECONDARY)
#define ACCENT ht_rgb(HT_THEME_ACCENT)
#define ERROR ht_rgb(HT_THEME_ERROR)
#define SEL ht_rgb(HT_THEME_SELECTION)
#define COPY(dst,src) copy(dst,sizeof(dst),src)
'''
# The production helpers are skin-aware; this harness has no Focus skin, so they are the mono calls.
code += '''
static bool focus_skin(void){return false;}
static const ht_font_t *focus_face_for(const ht_font_t *m){return m;}
static void focus_put(ht_scene_t *f,int x,int y,int w,const ht_font_t *font,uint16_t ink,uint16_t bg,const char *t,bool c){(void)c;ht_text(f,x,y,w,font,ink,bg,t);}
static void text_in(ht_scene_t *f,int x,int y,int w,const ht_font_t *m,const char *t,uint16_t c,bool centred){(void)centred;ht_text(f,x,y,w,m,c,BG,t);}
static int ui_rows(const char *t,const ht_font_t *f,int w){return ht_text_rows(t,f,w);}
static bool ui_can_display(const char *t,const ht_font_t *f,int w,int l){return ht_can_display(t,f,w,l);}
static int ui_wrap(ht_scene_t *s,int x,int y,int w,int n,int skip,const ht_font_t *f,uint16_t fg,const char *t){return ht_wrap(s,x,y,w,n,skip,f,fg,t);}
'''
for name in ['notice_sync_view','copy','control','text','center','heading','question_view','question_rows',
             'question_text','render_question','render_choices','render_answer_review',
             'open_question','question_answer','question_move','send_answer',
             'question_load','ui_question_show','ui_question_state','ui_answer_receipt','ui_question_close','ui_focus_project','ui_voice_question']:
    code += function(name)
actions = source.split('    case A_QUESTION_CHOICES:\n',1)[1].split('    case A_INBOX:',1)[0]
code += 'static void dispatch(action_t a) { switch(a.kind) { case A_QUESTION_CHOICES:\n'+actions+'default: break; } }\n'
worker = source.split('static void worker(',1)[1].split('        case A_QUESTION_READ:',1)[1].split('        default:',1)[0]
code += 'static void work(action_t a) { switch(a.kind) { case A_QUESTION_READ:'+worker+'default: break; } }\n'
code += r'''
static void act(action_kind_t kind,int value) {
    action_t a={.kind=kind,.value=value,.revision=s.q.revision,.dy=s.q.index};COPY(a.id,s.q.agent);dispatch(a);
}
static void state(const char *id,const char *fetch,const char *token,bool multi,const char *prompt) {
    cJSON options[3]={{.type=JSTRING,.valuestring="This file only"},
        {.type=JSTRING,.valuestring="The whole project"},{.type=JSTRING,.valuestring="Leave it as it is"}};
    cJSON array=object(options,3);array.type=JARRAY;
    cJSON fields[]={{.string="key",.type=JSTRING,.valuestring=prompt},
        {.string="q",.type=JSTRING,.valuestring=prompt},
        {.string="multi",.type=multi ? JTRUE : 0},
        {.string="options",.type=JARRAY,.child=array.child},
        {.string="canText",.type=multi ? 0 : JTRUE}};
    cJSON question=object(fields,5),questions={.type=JARRAY,.child=&question};
    cJSON reply[]={{.string="agentId",.type=JSTRING,.valuestring=id},
        {.string="requestId",.type=JSTRING,.valuestring=fetch},
        {.string="id",.type=JSTRING,.valuestring="q-a"},
        {.string="token",.type=JSTRING,.valuestring=token},
        {.string="ok",.type=JTRUE},
        {.string="questions",.type=JARRAY,.child=questions.child}};
    cJSON root=object(reply,6);ui_question_state(&root);
}
static void receipt(const char *token,bool ok) {
    cJSON reply[]={{.string="agentId",.type=JSTRING,.valuestring="a"},
        {.string="requestId",.type=JSTRING,.valuestring=s.q.fetch},
        {.string="token",.type=JSTRING,.valuestring=token},
        {.string="ok",.type=ok ? JTRUE : 0},
        {.string="error",.type=JSTRING,.valuestring="Question changed. Check the terminal."},
        {.string="pending",.type=pending_receipt ? JTRUE : 0}};
    cJSON root=object(reply,6);ui_answer_receipt(&root);
}
static void spoken(const char *token,const char *text) {
    cJSON reply[]={{.string="agentId",.type=JSTRING,.valuestring="a"},
        {.string="token",.type=JSTRING,.valuestring=token},
        {.string="questionIndex",.type=JNUMBER,.valuedouble=0},
        {.string="draftId",.type=JSTRING,.valuestring="draft-1"},
        {.string="text",.type=JSTRING,.valuestring=text}};
    cJSON root=object(reply,5);ui_voice_question(&root);
}
static void recording(void) {
    s.voice_open=s.voice_waiting=true;s.voice_return=QUESTION;
    s.voice_question_revision=s.q.revision;s.voice_question_index=0;s.view=VOICE;
}
static const char *long_question="The helper found three related places using the old token. Should this change apply only to this file, across the whole project including tests, or should we leave the current behavior in place until the next release?";
static void reset(bool multi) {
    memset(&s,0,sizeof s);s.connected=true;s.pressed=-1;
    congested=pending_receipt=false;transport_ok=true;queued_answers=sent_answers=removed=reads=0;
    open_question();assert(s.q.loading && s.view==QUESTION);work(queued);assert(reads==1);
    state("wrong",s.q.fetch,"token-a",multi,long_question);assert(s.q.loading);
    state("a","old-read","token-a",multi,long_question);assert(s.q.loading);
    state("a",s.q.fetch,"token-a",multi,long_question);assert(s.q.valid && s.q.supported && !s.q.loading);
}
static void render(const char *dir,const char *name) {
    ht_scene_t scene;ht_scene_clear(&scene,BG);s.hit_count=0;
    if(s.view==QUESTION) render_question(&scene);
    else if(s.view==CHOICE) render_choices(&scene);
    else render_answer_review(&scene);
    assert(scene.count<=HT_RUNS);
    if(!dir)return;
    static uint16_t pixels[HT_WIDTH*HT_HEIGHT];ht_raster(&scene,(ht_rect_t){0,0,HT_WIDTH,HT_HEIGHT},pixels);
    char path[512];snprintf(path,sizeof path,"%s/%s.ppm",dir,name);FILE *out=fopen(path,"wb");assert(out);
    fprintf(out,"P6\n466 466\n255\n");
    for(int y=0;y<466;y++)for(int x=0;x<466;x++) {
        uint16_t v=pixels[y*466+x];v=(uint16_t)((v<<8)|(v>>8));
        unsigned char rgb[3]={(unsigned char)((v>>11)*255/31),(unsigned char)(((v>>5)&63)*255/63),(unsigned char)((v&31)*255/31)};
        if((x-233)*(x-233)+(y-233)*(y-233)>233*233)memset(rgb,0,3);
        fwrite(rgb,1,3,out);
    }
    fclose(out);
}
int main(int argc,char **argv) {
    const char *dir=argc>1 ? argv[1] : NULL;
    reset(false);assert(s.q.item[0].can_text);recording();
    spoken("token-a","Only update the parser. Keep the existing public API and add a regression test for empty input. Please leave the unrelated formatting alone and keep this change in one commit.");
    assert(!s.voice_open && s.view==ANSWER_REVIEW && !s.q.item[0].selected && s.q.item[0].draft[0] && !queued_answers);
    render(dir,"spoken-review");question_move(500);assert(s.offset>0 && !queued_answers);
    act(A_ANSWER,0);work(queued);assert(!sent_choices[0] && !strcmp(sent_draft,"draft-1") && sent_answers==1);
    reset(false);spoken("token-a","Unsolicited");assert(!s.q.item[0].draft[0] && s.view==QUESTION);
    recording();spoken("wrong","Wrong question");assert(s.view==MESSAGE && !s.voice_open && !queued_answers);
    reset(false);recording();s.q.revision++;spoken("token-a","Late");assert(s.view==MESSAGE && !s.q.item[0].draft[0]);
    reset(false);recording();spoken("token-a","Unsupported \xe9\x9b\xaa");
    assert(s.view==QUESTION && s.q.speech_error[0] && !s.q.item[0].draft[0]);
    reset(false);recording();spoken("token-a","A new answer");act(A_QUESTION_BACK,0);
    assert(s.view==QUESTION);act(A_QUESTION_REVIEW,0);assert(s.view==ANSWER_REVIEW && s.q.item[0].draft[0]);
    act(A_QUESTION_BACK,0);act(A_QUESTION_CHOICES,0);act(A_CHOICE,1);assert(!s.q.item[0].draft[0] && s.q.item[0].selected==2);
    reset(false);assert(question_rows(long_question)>6);render(dir,"question");
    question_move(10000);assert(s.offset==question_rows(long_question)-Q_ROWS);render(dir,"question-end");
    act(A_ANSWER,0);assert(!queued_answers); // Prompt never sends, and no default is selected.
    act(A_QUESTION_CHOICES,0);assert(s.view==CHOICE && !s.q.item[0].selected);
    act(A_QUESTION_REVIEW,0);assert(s.view==CHOICE);
    question_move(40);assert(s.q.choice==1 && !s.q.item[0].selected);render(dir,"choice");
    action_t stale={.kind=A_CHOICE,.value=2,.revision=s.q.revision-1,.id="a"};dispatch(stale);
    assert(!s.q.item[0].selected);
    act(A_CHOICE,1);assert(s.q.item[0].selected==2 && !queued_answers);
    act(A_QUESTION_REVIEW,0);assert(s.view==ANSWER_REVIEW);render(dir,"review");
    congested=true;act(A_ANSWER,0);assert(!s.q.pending && !queued_answers);
    congested=false;act(A_ANSWER,0);assert(s.q.pending && queued_answers==1);
    act(A_ANSWER,0);assert(queued_answers==1);work(queued);
    assert(sent_answers==1 && sent_choices[0]==2 && s.q.pending && s.q.valid); // USB write is not completion.
    receipt("old-token",true);assert(s.q.pending && !removed);
    pending_receipt=true;receipt("token-a",true);assert(s.q.pending && s.q.valid && !removed);pending_receipt=false;
    receipt("token-a",false);assert(s.q.pending && s.q.uncertain && s.q.error[0]);render(dir,"refused");
    act(A_ANSWER,0);assert(queued_answers==1);
    reset(true);act(A_QUESTION_CHOICES,0);act(A_CHOICE,0);act(A_CHOICE,2);
    act(A_QUESTION_REVIEW,0);assert(!strcmp(s.q.item[0].answer,"This file only\n\nLeave it as it is"));
    render(dir,"multi-review");act(A_ANSWER,0);work(queued);assert(sent_choices[0]==5);
    receipt("token-a",true);assert(!s.q.valid && s.view==HOME && removed==1);
    reset(false);act(A_QUESTION_CHOICES,0);act(A_CHOICE,1);act(A_QUESTION_REVIEW,0);act(A_ANSWER,0);
    action_t old=queued;ui_question_close("a","old-question");assert(s.q.valid);
    ui_question_show("b","Other","M2","q-b",NULL);assert(s.q.valid && s.q.pending && !strcmp(s.q.agent,"a"));
    ui_question_show("a","Research","M2","q-new",NULL);assert(!s.q.valid && s.q.error[0]);
    work(old);assert(!sent_answers); // Queued command cannot answer a replacement question.
    reset(false);view(HOME);state("a",s.q.fetch,"token-a",false,long_question);assert(s.view==HOME);
    reset(false);s.view=MESSAGE;visit.available=true;strcpy(visit.agent,"b");b_known=false;
    ui_focus_project("b");assert(!strcmp(s.pending_focus,"b") && s.view==MESSAGE);
    b_known=true;ui_focus_project("b");assert(s.view==QUESTION && s.q.loading && !strcmp(s.q.agent,"b"));
    // A question does NOT change the screen — the home face shows it in the recap's place — but it
    // does wake the display, and it still counts in the bell until it is answered.
    reset(false);view(HOME);wakes=0;notices=0;
    ui_question_show("b","Other","M2","q-b2",NULL);assert(s.view==HOME && wakes==1 && notices==1);
    // The ESP32 compiler's -O0 restrict analysis sees the enclosing global s,
    // not the disjoint options/answer fields. Exercise every selected subset
    // at their real capacities and prove that no neighboring state changes.
    unsigned combinations=0;
    for(int index=0;index<QUESTION_MAX;index++) for(int options=1;options<=OPTION_MAX;options++)
        for(unsigned mask=1;mask<(1u<<options);mask++) for(int length_case=0;length_case<4;length_case++) {
            static const size_t lengths[]={1,127,254,255};
            memset(&s.q,0,sizeof s.q);s.q.supported=true;s.q.index=index;
            question_item_t *q=&s.q.item[index];q->count=options;q->selected=mask;
            _Static_assert(OPTION_MAX*255+(OPTION_MAX-1)*2+1<=sizeof q->answer,"all full options fit the review buffer");
            memset(q->answer,0x55,sizeof q->answer);
            for(int i=0;i<options;i++) {memset(q->options[i],'A'+i,lengths[length_case]);q->options[i][lengths[length_case]]=0;}
            question_t before=s.q;
            char expected[sizeof q->answer];size_t used=0;
            for(int i=0;i<options;i++) if(mask&(1u<<i)) {
                if(used) {expected[used++]='\n';expected[used++]='\n';}
                memset(expected+used,'A'+i,lengths[length_case]);used+=lengths[length_case];
            }
            expected[used]=0;
            assert(question_answer() && !strcmp(q->answer,expected));
            for(size_t i=used+1;i<sizeof q->answer;i++) assert(q->answer[i]==0x55);
            memcpy(q->answer,before.item[index].answer,sizeof q->answer);
            assert(!memcmp(&s.q,&before,sizeof s.q));combinations++;
        }
    printf("question UI: PASS (full prompt, focused choices, explicit review, correlated reads/receipts, stale commands, spoken drafts, pending and multi-select; %u full-capacity subsets preserve adjacent state); state=%zu bytes\n",combinations,sizeof(question_t));
}
'''
with tempfile.TemporaryDirectory(prefix='harness-question-ui-') as tmp:
    out=Path(tmp);(out/'question_ui.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-O1','-g',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-I',str(native),
        str(out/'question_ui.c'),str(native/'terminal.c'),str(native/'fonts.c'),'-o',str(out/'test')],check=True)
    args=[str(out/'test')]
    if os.environ.get('HABITAT_PREVIEW_DIR'):
        dest=Path(os.environ['HABITAT_PREVIEW_DIR']);dest.mkdir(parents=True,exist_ok=True);args.append(str(dest))
    subprocess.run(args,check=True)
