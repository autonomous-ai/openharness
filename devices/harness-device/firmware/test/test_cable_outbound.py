"""A failed allocation must never send a partial command. Requires IDF_PATH."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import MAIN, defines

main = Path(__file__).resolve().parent / '../main'
source = Path(os.environ.get('CABLE_OUTBOUND_SOURCE', main / 'cable_client.c')).read_text()
json_dir = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'

def function(name, optional=False):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    if not match:
        match = re.search(r'^[^\n]*\b' + name + r'\([^\n]*\) \{[^\n]*\}$', source, re.M)
    if optional and not match:
        return ''
    assert match, name
    return match.group(0) + '\n'

code = r'''
#include "cJSON.h"
#include "cable_scroll.h"
#include "cable_features.h"
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <stdatomic.h>
#define CABLE_TYPE_JSON 1
#define ESP_LOGI(...) ((void)0)
typedef enum { CABLE_SCROLL_DOWN,CABLE_SCROLL_MOVE,CABLE_SCROLL_UP } cable_scroll_phase_t;
static unsigned allocations, live, fail_at, sends;
static char wire[8192];
static size_t wire_size;
static cJSON *answers;
static bool review=true, fail_send;
static atomic_uint s_features;
static void *allocate(size_t n) {
    if(++allocations==fail_at)return NULL;
    void *p=malloc(n);if(p)live++;return p;
}
static void deallocate(void *p) {if(p){assert(live);live--;free(p);}}
static bool cable_link_send(uint8_t type,const uint8_t *bytes,size_t n) {
    assert(type==CABLE_TYPE_JSON&&n<sizeof wire);
    sends++;memcpy(wire,bytes,n);wire[n]=0;wire_size=n;return !fail_send;
}
static void audio_client_copy_upload_id(char *out,size_t n) {snprintf(out,n,"upload-1234");}
static void audio_client_copy_carry(char *out,size_t n) {snprintf(out,n,"carry-1234");}
static void audio_client_copy_form(char *out,size_t n,unsigned *revision) {
    snprintf(out,n,"form-1234");*revision=5;
}
static void audio_client_copy_draft(char *out,size_t n,unsigned *revision,bool *append) {
    snprintf(out,n,"draft-1234");*revision=6;*append=true;
}
static void audio_client_copy_question(char *out,size_t n,unsigned *index) {
    snprintf(out,n,"question-1234");*index=2;
}
static void audio_client_copy_search(char *out,size_t n,unsigned *revision) {
    snprintf(out,n,"search-1234");*revision=7;
}
static void audio_client_copy_selection(char *out,size_t n,unsigned *revision) {
    snprintf(out,n,"selection-1234");*revision=8;
}
static bool audio_client_review_requested(void) {return review;}
typedef struct { const char *name; } board_t;
static const board_t *board(void) {static const board_t b={"dial-stub"};return &b;}
static const char *cable_fw_version(void) {return "0.0.99";}
static bool device_mac_str(char *out,size_t n) {snprintf(out,n,"aa:bb");return true;}
static void msg_settings(cJSON **root) {(void)root;}
static size_t pet_store_held(char ids[][17],size_t max) {(void)ids;(void)max;return 0;}
'''
code += defines('ID_MAX', 'CABLE_READ_TOKEN_MAX', 'CABLE_APP_ID_MAX', 'CABLE_PRODUCT', 'CABLE_PROTO_VERSION')
code += defines('PET_STORE_MAX_PACKS', source=(MAIN / 'pet_store.h').read_text())
for name in ['cable_client_supports', 'send_json', 'msg']:
    code += function(name)
for name in ['msg_check', 'msg_string', 'msg_number', 'msg_bool', 'msg_array', 'msg_item']:
    code += function(name, optional=True)
for name in ['select_machine', 'select_swarm', 'send_turn', 'stop_turn', 'send_focus', 'send_open',
             'notification_read', 'send_scroll', 'answer', 'question_read', 'answer_reviewed', 'agent_update',
             'voice_begin', 'carry', 'form', 'visit', 'select_text', 'draft', 'voice_end',
             'voice_abort', 'voice_cancel', 'voice_confirm', 'fw_error', 'fw_progress', 'pick_app']:
    code += function('cable_client_' + name)
code += function('cable_client_request_agents') + function('send_hello')
code += r'''
enum { CASES=27 };
static void run(unsigned which) {
    static const uint8_t choices[]={1,2,4,8};
    static const char drafts[4][48]={"Keep the quoted \"text\".","", "Line 1\nLine 2", "é ↗"};
    switch(which) {
    case 0:cable_client_voice_begin("target-agent","goal","en",16000);break;
    case 1:cable_client_select_machine("machine-1234");break;
    case 2:cable_client_select_swarm("workspace-1234");break;
    case 3:cable_client_send_turn("target-agent","A quote: \"yes\". A slash: \\.\nA second line.");break;
    case 4:cable_client_stop_turn("target-agent");break;
    case 5:cable_client_send_focus("target-agent");break;
    case 6:cable_client_send_open("target-agent","question");break;
    case 7:cable_client_send_scroll(CABLE_SCROLL_UP,-200,1000);break;
    case 8:cable_client_answer("target-agent","request-1234",answers);break;
    case 9:cable_client_question_read("target-agent","request-1234");break;
    case 10:cable_client_answer_reviewed("target-agent","request-1234","token-1234",choices,drafts,4);break;
    case 11:cable_client_agent_update("target-agent","model-1234","high");break;
    case 12:cable_client_carry("carry-1234","target-agent","selection-1234",23,4,false);break;
    case 13:cable_client_form("find-1234",25,"state",4,-1);break;
    case 14:cable_client_visit("visit-1234",26,"begin","target-agent");break;
    case 15:cable_client_select_text("target-agent","selection-1234",27,5,"extend",-1,true);break;
    case 16:cable_client_draft("draft-1234","move",28,6,2);break;
    case 17:cable_client_voice_end();break;
    case 18:cable_client_voice_abort("cable interrupted");break;
    case 19:cable_client_voice_cancel("upload-1234");break;
    case 20:cable_client_voice_confirm("route-1234","target-agent");break;
    case 21:cable_client_fw_error("bounded error text");break;
    case 22:cable_client_fw_progress(UINT32_MAX);break;
    case 23:cable_client_carry("carry-1234",NULL,NULL,0,0,true);break;
    case 24:cable_client_voice_begin(NULL,NULL,NULL,16000);break;
    case 25:cable_client_notification_read("target-agent","notice-42");break;
    case 26:cable_client_pick_app("ghostty");break;
    default:assert(false);
    }
}
int main(void) {
    cJSON_Hooks hooks={.malloc_fn=allocate,.free_fn=deallocate};cJSON_InitHooks(&hooks);
    answers=cJSON_Parse("{\"question\":[\"one\",\"two\"]}");assert(answers);
    unsigned retained=live, failures=0;
    for(unsigned which=0;which<CASES;which++) {
        sends=0;unsigned first=allocations;run(which);
        assert(sends==1&&live==retained);unsigned count=allocations-first;
        char expected[8192];size_t expected_size=wire_size;memcpy(expected,wire,wire_size+1);
        for(unsigned i=1;i<=count;i++) {
            sends=0;fail_at=allocations+i;run(which);failures++;
            // Either the whole original command or nothing. Never silently lose
            // the destination, transcript, choice, revision or correlation ID.
            assert(sends<=1&&live==retained);
            assert(!sends||(wire_size==expected_size&&!memcmp(wire,expected,wire_size)));
        }
        fail_at=0;
        // app.pick carries the app, and nothing else.
        if(which==26) assert(!strcmp(expected,"{\"t\":\"app.pick\",\"app\":\"ghostty\"}"));
        if(which==0) {
            cJSON *begin=cJSON_Parse(expected);assert(begin);
            const cJSON *id=cJSON_GetObjectItemCaseSensitive(begin,"agentId");
            assert(cJSON_IsString(id)&&!strcmp(id->valuestring,"target-agent"));cJSON_Delete(begin);
        }
    }
    sends=0;cable_client_send_scroll((cable_scroll_phase_t)-1,0,0);
    cable_client_send_scroll((cable_scroll_phase_t)3,0,0);
    cable_client_send_scroll((cable_scroll_phase_t)INT_MIN,0,0);
    cable_client_send_scroll((cable_scroll_phase_t)INT_MAX,0,0);assert(!sends);
    // No app, or an id the dial could not have been sent whole, is not picked.
    cable_client_pick_app(NULL);cable_client_pick_app("");cable_client_pick_app("abcdefghijklmnop");assert(!sends);
    cable_client_pick_app("abcdefghijklmno");assert(sends==1);sends=0;
    // hello says appFilter v1: with no window the dial holds one app's agents, is sent `apps` and picks with `app.pick`.
    send_hello();assert(sends==1);sends=0;
    { cJSON *hello=cJSON_Parse(wire);assert(hello);
      const cJSON *filter=cJSON_GetObjectItemCaseSensitive(hello,"appFilter");
      assert(cJSON_IsString(filter)&&!strcmp(filter->valuestring,"v1"));
      const cJSON *tier=cJSON_GetObjectItemCaseSensitive(hello,"questionTier");
      assert(cJSON_IsString(tier)&&!strcmp(tier->valuestring,"v1"));cJSON_Delete(hello); }
    fail_send=true;assert(!send_json(msg("ping")));assert(live==retained);
    fail_send=false;
    // The shipping bridge has agents.list but ignores agents.refresh. Core tab
    // navigation must work without an optional feature announcement. Check the
    // actual serialized request, its failure return and every allocation site.
    for(unsigned mask=0;mask<64;mask++) {
        atomic_store(&s_features,mask);sends=0;
        unsigned first=allocations;
        assert(cable_client_request_agents() && sends==1 && live==retained);
        unsigned count=allocations-first;
        const char *expected=(mask&CABLE_FEATURE_AGENTS_REFRESH)
            ? "{\"t\":\"agents.refresh\"}" : "{\"t\":\"agents.list\"}";
        assert(!strcmp(wire,expected));
        for(unsigned i=1;i<=count;i++) {
            sends=0;fail_at=allocations+i;
            assert(!cable_client_request_agents() && !sends && live==retained);
        }
        fail_at=0;fail_send=true;
        assert(!cable_client_request_agents() && live==retained);
        fail_send=false;
    }
    puts("Roster request: legacy/modern capability selection, 64 feature combinations, allocation and send failures PASS");
    cJSON_Delete(answers);assert(!live);
    printf("Outbound JSON: %u allocation failures across %u real commands; whole messages only, no leaks, invalid scroll enums rejected PASS (offline)\n",failures,CASES);
}
'''
with tempfile.TemporaryDirectory(prefix='harness-cable-outbound-') as folder:
    out = Path(folder)
    (out / 'outbound.c').write_text(code)
    flags = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
             '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds')]
    subprocess.run(flags + ['-Wno-deprecated-declarations', '-c', str(json_dir / 'cJSON.c'),
                            '-o', str(out / 'cJSON.o')], check=True)
    subprocess.run(flags + ['-I', str(json_dir), '-I', str(main), str(out / 'outbound.c'), str(main / 'cable_scroll.c'), str(out / 'cJSON.o'),
                            '-lm', '-o', str(out / 'outbound')], check=True)
    subprocess.run([str(out / 'outbound')], check=True)
