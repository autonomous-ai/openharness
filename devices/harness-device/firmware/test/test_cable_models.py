"""Model-list timeout/reader ownership, with real cJSON and deterministic threads.

Requires IDF_PATH. No USB, microphone, app commands or real four-second sleeps.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile
from native_shapes import defines, typedef

main = Path(__file__).resolve().parent / '../main'
source = Path(os.environ.get('CABLE_MODELS_SOURCE', main / 'cable_client.c')).read_text()
json_dir = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'

def function(name, optional=False):
    match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    if optional and not match:
        return ''
    assert match, name
    return match.group(0) + '\n'

code = defines('ID_MAX') + typedef('model_item_t') + r'''
#include "cJSON.h"
#include <assert.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define MODELS_WAIT_MS 4000
#define portMAX_DELAY (-1)
#define pdTRUE 1
#define pdMS_TO_TICKS(ms) (ms)
#define ESP_LOGW(...) ((void)0)
typedef struct { pthread_mutex_t mutex; bool binary; unsigned count; } semaphore_t;
static semaphore_t data_lock = {.mutex=PTHREAD_MUTEX_INITIALIZER};
static semaphore_t reply_sem = {.mutex=PTHREAD_MUTEX_INITIALIZER,.binary=true};
static semaphore_t *s_agents_lock=&data_lock, *s_models_sem=&reply_sem;
static model_item_t *s_models_out;
static int s_models_max, s_models_n;
static char s_models_agent[ID_MAX];
static uint32_t s_models_request;
static bool s_models_replied;
enum { NORMAL, NO_REPLY, SEND_FAIL, RACE, REPLY_FILTER };
static int mode;
static cJSON *response;
static unsigned sends;
static atomic_uint allocations, live, fail_at;
static pthread_mutex_t control=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t progress=PTHREAD_COND_INITIALIZER;
static bool reader_paused, allow_reader, cleanup_waiting, request_finished;
static _Thread_local bool request_thread, timed_out, reader_thread;
static pthread_t reader;
static void *allocate(size_t n) {
    if (atomic_fetch_add(&allocations,1)+1==atomic_load(&fail_at)) return NULL;
    void *p=malloc(n); if(p)atomic_fetch_add(&live,1);return p;
}
static void deallocate(void *p) { if(p){assert(atomic_fetch_sub(&live,1)>0);free(p);} }
static int xSemaphoreTake(semaphore_t *s,int wait) {
    if(!s->binary) {
        if(request_thread&&timed_out) {
            pthread_mutex_lock(&control);cleanup_waiting=true;
            pthread_cond_broadcast(&progress);pthread_mutex_unlock(&control);
        }
        assert(!pthread_mutex_lock(&s->mutex));return pdTRUE;
    }
    if(mode==RACE&&wait==MODELS_WAIT_MS) {
        pthread_mutex_lock(&control);
        while(!reader_paused)pthread_cond_wait(&progress,&control);
        timed_out=true;pthread_mutex_unlock(&control);return 0;
    }
    assert(!pthread_mutex_lock(&s->mutex));
    bool got=s->count!=0;if(got)s->count--;
    assert(!pthread_mutex_unlock(&s->mutex));return got;
}
static void xSemaphoreGive(semaphore_t *s) {
    if(s->binary) {pthread_mutex_lock(&s->mutex);s->count=1;}
    assert(!pthread_mutex_unlock(&s->mutex));
}
static int paused_snprintf(char *out,size_t n,const char *format,...) {
    va_list args;va_start(args,format);int result=vsnprintf(out,n,format,args);va_end(args);
    if(reader_thread) {
        pthread_mutex_lock(&control);
        if(!reader_paused) {
            reader_paused=true;pthread_cond_broadcast(&progress);
            while(!allow_reader)pthread_cond_wait(&progress,&control);
        }
        pthread_mutex_unlock(&control);
    }
    return result;
}
#define snprintf paused_snprintf
static void handle_models(const cJSON *p);
static void *deliver(void *arg) {(void)arg;reader_thread=true;handle_models(response);return NULL;}
static bool send_json(cJSON *root) {
    assert(root);sends++;
    const cJSON *id=cJSON_GetObjectItemCaseSensitive(root,"agentId");
    assert(cJSON_IsString(id)&&!strcmp(id->valuestring,"target-agent"));
    cJSON_Delete(root);
    if(mode==REPLY_FILTER) {
        const char *wrong[]={
            "{\"agentId\":\"old-agent\",\"items\":[{\"id\":\"wrong\"}]}",
            "{\"items\":[{\"id\":\"missing target\"}]}",
            "{\"agentId\":\"target-agent\",\"request\":0,\"items\":[{\"id\":\"stale\"}]}",
            "{\"agentId\":\"target-agent\",\"request\":\"invalid\",\"items\":[]}",
            "{\"agentId\":\"target-agent\",\"items\":{\"id\":\"not an array\"}}"
        };
        for(unsigned i=0;i<sizeof wrong/sizeof *wrong;i++) {
            cJSON *late=cJSON_Parse(wrong[i]);assert(late);handle_models(late);cJSON_Delete(late);
            assert(!reply_sem.count && !s_models_replied && s_models_out[0].id[0]==0x5a);
        }
        cJSON *answer=cJSON_Duplicate(response,true);assert(answer);
        assert(cJSON_AddNumberToObject(answer,"request",s_models_request));
        handle_models(answer);cJSON_Delete(answer);
        assert(s_models_replied && reply_sem.count==1 && !strcmp(s_models_out[0].id,"first"));
        cJSON *duplicate=cJSON_Parse("{\"agentId\":\"target-agent\",\"items\":[{\"id\":\"duplicate\"}]}");
        handle_models(duplicate);cJSON_Delete(duplicate);
        assert(!strcmp(s_models_out[0].id,"first"));
    }
    if(mode==SEND_FAIL)return false;
    if(mode==NORMAL)handle_models(response);
    if(mode==RACE)assert(!pthread_create(&reader,NULL,deliver,NULL));
    return true;
}
'''
code += function('msg') + function('msg_check', optional=True) + function('msg_string', optional=True) + function('msg_number', optional=True)
code += function('handle_models') + function('cable_client_models_list')
code += r'''
static struct { uint64_t before;model_item_t rows[2];uint64_t after; } output;
static int request_result;
static void *request(void *arg) {
    (void)arg;request_thread=true;
    request_result=cable_client_models_list("target-agent","models","selected",output.rows,2);
    pthread_mutex_lock(&control);request_finished=true;
    pthread_cond_broadcast(&progress);pthread_mutex_unlock(&control);return NULL;
}
static void reset_output(void) {
    assert(!s_models_out);memset(&output,0x5a,sizeof output);
    output.before=UINT64_C(0xaabb11223344ccdd);output.after=UINT64_C(0xfeed44885500ffee);
}
static void canaries(void) {
    assert(output.before==UINT64_C(0xaabb11223344ccdd));
    assert(output.after==UINT64_C(0xfeed44885500ffee));
}
int main(void) {
    (void)s_models_agent;(void)s_models_request;(void)s_models_replied;(void)msg_number;
    assert(s_agents_lock);
    cJSON_Hooks hooks={.malloc_fn=allocate,.free_fn=deallocate};cJSON_InitHooks(&hooks);
    response=cJSON_Parse("{\"agentId\":\"target-agent\",\"items\":[{\"id\":\"first\"},{\"id\":\"abcdefghijklmnopqrstuvwxyz0123456789\"},{\"id\":\"overflow\"}]}");
    assert(response);unsigned retained=atomic_load(&live);
    mode=REPLY_FILTER;reset_output();
    assert(cable_client_models_list("target-agent",NULL,NULL,output.rows,2)==2);canaries();
    assert(!s_models_out && atomic_load(&live)==retained);
    s_models_request=INT32_MAX;reset_output();
    assert(cable_client_models_list("target-agent",NULL,NULL,output.rows,2)==2);
    assert(s_models_request==1);mode=NORMAL;
    reset_output();unsigned start=atomic_load(&allocations);
    assert(cable_client_models_list("target-agent","models","selected",output.rows,2)==2);
    unsigned count=atomic_load(&allocations)-start;
    assert(!s_models_out&&!strcmp(output.rows[0].id,"first"));
    assert(!strcmp(output.rows[1].id,"abcdefghijklmnopqrstuvwxyz0123456789"));canaries();
    assert(atomic_load(&live)==retained);
    // Every request allocation can fail. No borrowed pointer or partial send survives.
    for(unsigned i=1;i<=count;i++) {
        reset_output();unsigned before_sends=sends;
        atomic_store(&fail_at,atomic_load(&allocations)+i);
        assert(cable_client_models_list("target-agent","models","selected",output.rows,2)==-1);
        assert(!s_models_out&&sends==before_sends&&atomic_load(&live)==retained);
        handle_models(response);assert(output.rows[0].id[0]==0x5a);canaries();
    }
    atomic_store(&fail_at,0);
    for(int m=NO_REPLY;m<=SEND_FAIL;m++) {
        mode=m;reset_output();
        assert(cable_client_models_list("target-agent",NULL,NULL,output.rows,2)==-1);
        assert(!s_models_out);handle_models(response);
        assert(output.rows[0].id[0]==0x5a);canaries();
    }
    // A timeout cannot return while the reader still owns the output buffer.
    mode=RACE;reset_output();pthread_t caller;
    assert(!pthread_create(&caller,NULL,request,NULL));
    pthread_mutex_lock(&control);
    while(!cleanup_waiting&&!request_finished)pthread_cond_wait(&progress,&control);
    assert(cleanup_waiting&&reader_paused&&!request_finished);
    allow_reader=true;pthread_cond_broadcast(&progress);pthread_mutex_unlock(&control);
    assert(!pthread_join(caller,NULL)&&!pthread_join(reader,NULL));
    assert(request_result==-1&&!s_models_out);canaries();
    // Concurrent callers cannot replace another request's output pointer.
    mode=NORMAL;model_item_t second[2];s_models_out=output.rows;s_models_max=2;
    unsigned before_sends=sends;
    assert(cable_client_models_list("target-agent",NULL,NULL,second,2)==-1);
    assert(s_models_out==output.rows&&sends==before_sends);s_models_out=NULL;
    reset_output();handle_models(response);assert(output.rows[0].id[0]==0x5a);
    cJSON_Delete(response);assert(!atomic_load(&live));
    puts("Model replies: target/request matching, duplicate/type rejection, serial wrap, every allocation failure, timeout/copy overlap and concurrent callers PASS (offline)");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-cable-models-') as folder:
    out = Path(folder)
    (out / 'models.c').write_text(code)
    flags = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
             '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds')]
    subprocess.run(flags + ['-Wno-deprecated-declarations', '-c', str(json_dir / 'cJSON.c'),
                            '-o', str(out / 'cJSON.o')], check=True)
    subprocess.run(flags + ['-I', str(json_dir), str(out / 'models.c'), str(out / 'cJSON.o'),
                            '-lm', '-pthread', '-o', str(out / 'models')], check=True)
    subprocess.run([str(out / 'models')], check=True, timeout=30)
