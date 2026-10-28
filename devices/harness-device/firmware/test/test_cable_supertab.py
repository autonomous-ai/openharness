"""The Swarm frames on the round dial: hello, supertabs/supertab/recap/focus, Super Tab waits and the three requests.

The production handlers are lifted out of cable_client.c and run against the SDK's cJSON and the real supertab model.
Requires IDF_PATH.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import MAIN, defines

source = Path(os.environ.get('CABLE_SOURCE', MAIN/'cable_client.c')).read_text()
json_dir = Path(os.environ['IDF_PATH'])/'components/json/cJSON'


def function(name):
    match = re.search(r'^[^\n]*\b'+name+r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match[0]+'\n'


code = r'''
#include "cJSON.h"
#include "ui/habitat/supertab.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define EXT_RAM_BSS_ATTR
#define ESP_LOGI(...) ((void)0)
#define CABLE_PRODUCT "harness"
#define CABLE_PROTO_VERSION 3
#define PET_STORE_MAX_PACKS 4
'''
code += defines('CABLE_READ_TOKEN_MAX')
code += r'''
static char wire[4][2048];
static int sends;
static bool send_json(cJSON *root) {
    if (!root) return false;
    char *text=cJSON_PrintUnformatted(root);cJSON_Delete(root);assert(text&&strlen(text)<sizeof wire[0]);
    snprintf(wire[sends++%4],sizeof wire[0],"%s",text);cJSON_free(text);return true;
}
typedef struct { const char *name; } board_t;
static const board_t *board(void) { static const board_t b={"dial-stub"};return &b; }
static const char *cable_fw_version(void) { return "0.0.99"; }
static bool device_mac_str(char *o,size_t n) { snprintf(o,n,"aa:bb");return true; }
static void msg_settings(cJSON **root) { (void)root; }
static size_t pet_store_held(char ids[][17],size_t max) { (void)ids;(void)max;return 0; }

static unsigned beeps, ids_calls, card_calls, recap_calls, focus_calls, wait_calls, close_calls, question_calls, qclose_calls;
static bool beep_next;
static void audio_notify_done(void) { beeps++; }
static char got_ids[HT_SUPERTABS_MAX][ID_MAX]; static int got_id_n;
static ht_supertab_t got_card;
static char got_tab[ID_MAX], got_lead[ID_MAX], got_text[2048], got_agent[ID_MAX], got_request[80], got_swarm[80];
static uint32_t got_at; static bool got_none, got_stuck, got_text_null;
static void ui_supertabs_ids(const char ids[][ID_MAX],int n) {
    ids_calls++;got_id_n=n;memcpy(got_ids,ids,(size_t)n*ID_MAX);
}
static bool ui_supertab(const ht_supertab_t *in) { card_calls++;got_card=*in;return beep_next; }
static void ui_supertab_recap(const char *tab,const char *lead,const char *text,uint32_t at,bool none) {
    recap_calls++;snprintf(got_tab,sizeof got_tab,"%s",tab);snprintf(got_lead,sizeof got_lead,"%s",lead);
    snprintf(got_text,sizeof got_text,"%s",text?text:"");got_at=at;got_none=none;
}
static void ui_supertab_focus(const char *tab,const char *lead) {
    focus_calls++;snprintf(got_tab,sizeof got_tab,"%s",tab);snprintf(got_lead,sizeof got_lead,"%s",lead);
}
static bool ui_supertab_wait(const char *agent,const char *request,const char *swarm,bool stuck,const char *text) {
    wait_calls++;snprintf(got_agent,sizeof got_agent,"%s",agent);snprintf(got_request,sizeof got_request,"%s",request);
    snprintf(got_swarm,sizeof got_swarm,"%s",swarm);got_stuck=stuck;got_text_null=!text;
    snprintf(got_text,sizeof got_text,"%s",text?text:"");return beep_next;
}
static void ui_supertab_wait_close(const char *agent,const char *request) {
    close_calls++;snprintf(got_agent,sizeof got_agent,"%s",agent);snprintf(got_request,sizeof got_request,"%s",request);
}
static bool ui_question_show(const char *a,const char *n,const char *m,const char *r,const cJSON *q) {
    (void)a;(void)n;(void)m;(void)r;(void)q;question_calls++;return beep_next;
}
static void ui_question_close(const char *a,const char *r) { (void)a;(void)r;qclose_calls++; }
'''
for name in ['str_of', 'msg', 'msg_check', 'msg_string', 'msg_number', 'msg_array', 'send_hello', 'id_fits',
             'handle_supertabs', 'handle_supertab', 'handle_supertab_recap', 'handle_supertab_focus',
             'handle_question', 'handle_question_close', 'cable_client_supertab_send']:
    code += function(name)
code += r'''
static cJSON *parse(const char *json) { cJSON *p=cJSON_Parse(json);assert(p);return p; }
static void feed(void (*handler)(const cJSON *),const char *json) { cJSON *p=parse(json);handler(p);cJSON_Delete(p); }
static void feed_agent(void (*handler)(const cJSON *,const char *),const char *json) {
    cJSON *p=parse(json);handler(p,str_of(p,"agentId"));cJSON_Delete(p);
}
static const char *field(const char *json,const char *key) {
    static char out[256];cJSON *p=parse(json);const char *v=str_of(p,key);
    snprintf(out,sizeof out,"%s",v?v:"<absent>");cJSON_Delete(p);return out;
}

int main(void) {
    // The hello names both capabilities, so the daemon sends the Swarm cards and Super Tab waits.
    send_hello();
    assert(sends==1 && !strcmp(field(wire[0],"swarmCard"),"v1") && !strcmp(field(wire[0],"superTab"),"wait-v1"));
    assert(!strcmp(field(wire[0],"product"),"harness"));

    // supertabs: ids in order, the bad and the repeated skipped, at most 16.
    feed(handle_supertabs,"{\"ids\":[\"s1\",\"\",7,\"s2\",\"s1\",\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"]}");
    assert(ids_calls==1 && got_id_n==2 && !strcmp(got_ids[0],"s1") && !strcmp(got_ids[1],"s2"));
    feed(handle_supertabs,"{\"ids\":\"s1\"}");
    assert(ids_calls==1);   // not a list: the current set stays
    feed(handle_supertabs,"{\"ids\":[]}");
    assert(ids_calls==2 && got_id_n==0);

    // supertab: every field, `order` and an absent `since`; a malformed Lead is skipped, not the frame.
    feed(handle_supertab,"{\"id\":\"s1\",\"tab\":\"desk-7\",\"name\":\"openharness\",\"count\":4,\"leads\":["
        "{\"id\":\"L1\",\"projectId\":\"p1\",\"project\":\"mobile\",\"engine\":\"claude\",\"owner\":\"Ann\",\"local\":\"h1\",\"state\":\"work\",\"since\":134,\"order\":2},"
        "{\"projectId\":\"no-id\",\"state\":\"ask\"},"
        "\"not an object\","
        "{\"id\":\"L2\",\"project\":\"web\",\"engine\":\"codex\",\"local\":\"\",\"state\":\"ask\",\"order\":0},"
        "{\"id\":\"L1\",\"project\":\"again\",\"state\":\"stuck\"},"
        "{\"id\":\"L3\",\"project\":\"api\",\"state\":\"bogus\",\"since\":-5,\"order\":-1}]}");
    assert(card_calls==1 && !strcmp(got_card.id,"s1") && !strcmp(got_card.tab,"desk-7") && !strcmp(got_card.name,"openharness"));
    assert(got_card.count==4 && got_card.lead_n==3 && beeps==0);
    const ht_lead_t *l=&got_card.leads[0];
    assert(!strcmp(l->id,"L1") && !strcmp(l->project_id,"p1") && !strcmp(l->project,"mobile") && !strcmp(l->engine,"claude"));
    assert(!strcmp(l->owner,"Ann") && !strcmp(l->local,"h1") && l->state==HT_LEAD_WORK && l->since_s==134 && l->order==2);
    l=&got_card.leads[1];
    assert(!strcmp(l->id,"L2") && l->state==HT_LEAD_ASK && l->since_s<0 && l->order==0 && !l->local[0]);
    l=&got_card.leads[2];
    assert(!strcmp(l->id,"L3") && l->state==HT_LEAD_DONE && l->since_s<0 && l->order==-1);
    // No count: the Leads listed. No id: no frame. An overlong tab links to nothing.
    feed(handle_supertab,"{\"id\":\"s2\",\"tab\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"name\":\"x\",\"leads\":[{\"id\":\"L1\",\"state\":\"work\"}]}");
    assert(card_calls==2 && got_card.count==1 && !got_card.tab[0]);
    feed(handle_supertab,"{\"name\":\"x\",\"leads\":[]}");
    assert(card_calls==2);
    // 13 Leads: 12 kept. The model's raised events come back as one beep.
    char big[4096]="{\"id\":\"s1\",\"name\":\"n\",\"leads\":[";
    for (int i=0;i<13;i++) { char one[64];snprintf(one,sizeof one,"%s{\"id\":\"L%d\",\"state\":\"work\",\"order\":%d}",i?",":"",i,i);strcat(big,one); }
    strcat(big,"]}");
    beep_next=true;feed(handle_supertab,big);beep_next=false;
    assert(card_calls==3 && got_card.lead_n==12 && got_card.count==12 && beeps==1);

    // supertab.recap and supertab.focus.
    feed(handle_supertab_recap,"{\"tab\":\"s1\",\"lead\":\"L1\",\"text\":\"Shipped.\",\"at\":1792560000,\"none\":false}");
    assert(recap_calls==1 && !strcmp(got_text,"Shipped.") && got_at==1792560000u && !got_none && !strcmp(got_lead,"L1"));
    feed(handle_supertab_recap,"{\"tab\":\"s1\",\"lead\":\"L1\",\"none\":true}");
    assert(recap_calls==2 && got_none && !got_text[0] && got_at==0);
    feed(handle_supertab_recap,"{\"tab\":\"s1\",\"text\":\"x\"}");
    assert(recap_calls==2);
    feed(handle_supertab_focus,"{\"tab\":\"s1\",\"lead\":\"L2\"}");
    assert(focus_calls==1 && !strcmp(got_tab,"s1") && !strcmp(got_lead,"L2"));
    feed(handle_supertab_focus,"{\"tab\":\"s1\"}");
    assert(focus_calls==1);
    // An empty Lead is the window on that Swarm with no project open: still a focus, for the Swarm.
    feed(handle_supertab_focus,"{\"tab\":\"s1\",\"lead\":\"\"}");
    assert(focus_calls==2 && !strcmp(got_tab,"s1") && !got_lead[0]);
    feed(handle_supertab_focus,"{\"tab\":\"\",\"lead\":\"\"}");
    assert(focus_calls==2);

    // A Super Tab wait goes to ui_supertab_wait, never to the question screen, and beeps only when the UI says so.
    feed_agent(handle_question,"{\"agentId\":\"h1\",\"name\":\"Lead\",\"id\":\"supertab:a1\",\"questions\":[{\"q\":\"Ship it?\"}],"
        "\"superTab\":\"openharness\",\"attention\":\"decision\"}");
    assert(wait_calls==1 && question_calls==0 && beeps==1 && !strcmp(got_agent,"h1") && !strcmp(got_request,"supertab:a1"));
    assert(!strcmp(got_swarm,"openharness") && !got_stuck && !strcmp(got_text,"Ship it?"));
    beep_next=true;
    feed_agent(handle_question,"{\"agentId\":\"h1\",\"id\":\"supertab:a2\",\"questions\":[],\"superTab\":\"openharness\",\"attention\":\"stuck\"}");
    assert(wait_calls==2 && question_calls==0 && beeps==2 && got_stuck && got_text_null);
    // A plain question is unchanged.
    feed_agent(handle_question,"{\"agentId\":\"h1\",\"id\":\"r1\",\"questions\":[{\"q\":\"Pick\"}]}");
    assert(question_calls==1 && wait_calls==2 && beeps==3);
    feed_agent(handle_question,"{\"agentId\":\"h1\",\"id\":\"r1\",\"questions\":[{\"q\":\"Pick\"}],\"superTab\":\"\"}");
    assert(question_calls==2 && wait_calls==2);
    beep_next=false;
    feed_agent(handle_question,"{\"id\":\"supertab:a3\",\"superTab\":\"openharness\"}");
    assert(wait_calls==2);   // no agent: nothing to attach it to
    // question.close: a Super Tab one closes the wait, any other the question screen.
    feed_agent(handle_question_close,"{\"agentId\":\"h1\",\"id\":\"supertab:a1\"}");
    assert(close_calls==1 && qclose_calls==0 && !strcmp(got_request,"supertab:a1"));
    feed_agent(handle_question_close,"{\"agentId\":\"h1\",\"id\":\"r1\"}");
    assert(close_calls==1 && qclose_calls==1);

    // The three requests, exactly.
    sends=0;
    cable_client_supertab_send("supertab.recap.get","s1","L1");
    cable_client_supertab_send("supertab.open","s1","");
    cable_client_supertab_send("supertab.select","s1","L2");
    assert(sends==3);
    assert(!strcmp(wire[0],"{\"t\":\"supertab.recap.get\",\"tab\":\"s1\",\"lead\":\"L1\"}"));
    assert(!strcmp(wire[1],"{\"t\":\"supertab.open\",\"tab\":\"s1\",\"lead\":\"\"}"));
    assert(!strcmp(wire[2],"{\"t\":\"supertab.select\",\"tab\":\"s1\",\"lead\":\"L2\"}"));
    char longer[ID_MAX+1];memset(longer,'x',ID_MAX);longer[ID_MAX]=0;
    cable_client_supertab_send("supertab.recap.get","s1","");
    cable_client_supertab_send("supertab.select","s1",NULL);
    cable_client_supertab_send("supertab.open","","L1");
    cable_client_supertab_send("supertab.open",longer,"L1");
    cable_client_supertab_send("supertab.open","s1",longer);
    cable_client_supertab_send("focus","s1","L1");
    cable_client_supertab_send(NULL,"s1","L1");
    assert(sends==3);
    puts("Swarm frames: hello capabilities, supertabs/supertab/recap/focus parsing, malformed Leads skipped, Super Tab waits kept off the question screen, exact requests PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-supertab-') as folder:
    out=Path(folder);(out/'test.c').write_text(code)
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-Wno-unused-function','-O1','-g',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'),'-I',str(json_dir),'-I',str(MAIN),
        str(out/'test.c'),str(MAIN/'ui/habitat/supertab.c'),str(json_dir/'cJSON.c'),'-o',str(out/'test')],check=True)
    subprocess.run([str(out/'test')],check=True)
