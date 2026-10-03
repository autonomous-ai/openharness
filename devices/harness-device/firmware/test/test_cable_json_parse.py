"""Exercise the actual USB callback against ESP-IDF's real cJSON, including OOM.

Set IDF_PATH to the ESP-IDF checkout used to build the firmware. This is separate
from the dependency-free native suite so that suite still runs without an SDK.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
json_dir = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'
source = (main / 'cable_client.c').read_text()
match = re.search(r'^static void on_frame\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
assert match
code = r'''
#include "cJSON.h"
#include "cable_json_guard.h"
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/mman.h>
#include <unistd.h>
static int64_t s_last_rx_us, clock_us = 123;
static uint32_t s_bad,s_unknown;
static unsigned handled, alloc_calls, live, fail_at, fw_slices;
static int last_number;
static size_t allocated_bytes, peak_bytes;
typedef union { max_align_t alignment; size_t bytes; } allocation_header;
static void *allocate(size_t n) {
    if (++alloc_calls == fail_at) return NULL;
    allocation_header *p = malloc(sizeof *p + n);
    if (!p) return NULL;
    p->bytes=n;live++;allocated_bytes+=n;
    if(allocated_bytes>peak_bytes)peak_bytes=allocated_bytes;
    return p+1;
}
static void deallocate(void *p) {
    if(p) { allocation_header *h=(allocation_header *)p-1; assert(live && allocated_bytes>=h->bytes);
        live--;allocated_bytes-=h->bytes;free(h); }
}
static int64_t esp_timer_get_time(void) { return clock_us; }
static void fw_update_slice(const uint8_t *p,size_t n) { (void)p; (void)n; fw_slices++; }
static void handle_message(const cJSON *root) {
    assert(cJSON_IsObject(root)); handled++;
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(root,"n");
    if (v) last_number = v->valueint;
}
'''
code += match.group(0)
code += r'''
static void send_text(const char *s,bool accepted) {
    unsigned before = handled;
    on_frame(1,CABLE_TYPE_JSON,(const uint8_t *)s,strlen(s),NULL);
    assert(handled == before + accepted && live == 0 && allocated_bytes==0);
}
int main(void) {
    cJSON_Hooks hooks = {.malloc_fn = allocate,.free_fn = deallocate}; cJSON_InitHooks(&hooks);
    send_text("{\"t\":\"ping\"}",true); assert(s_last_rx_us == clock_us);
    send_text(" \r\n{\"t\":\"welcome\",\"p\":{\"machine\":{\"id\":\"host\",\"name\":\"M2\"}}} \t",true);
    send_text("{\"t\":\"question\",\"p\":{\"questions\":[{\"options\":[{\"label\":\"Start\"}]}]}}",true);
    send_text("{\"n\":1e999}",true); assert(last_number == INT_MAX);
    send_text("{\"n\":-1e999}",true); assert(last_number == INT_MIN);
    send_text("{\"n\":2.5}",true); assert(last_number == 2);
    send_text("{\"text\":\"\\\\ \\\" {} [] \\u263a\"}",true);
    int64_t last = s_last_rx_us; clock_us += 1000;
    send_text("{}{}",false); send_text("{}garbage",false); send_text("{}\v",false);
    send_text("{bad}",false); send_text("{\"t\":]}",false); send_text("[]",false);
    send_text("{\"t\":\"bad\nstring\"}",false);
    const uint8_t nul[] = {'{','}',0,'x'};
    unsigned before = handled;
    on_frame(1,CABLE_TYPE_JSON,nul,sizeof nul,NULL);
    assert(handled == before && last == s_last_rx_us);
    // A rejected depth never enters cJSON or allocates.
    char deep[2048]; size_t n=0; deep[n++]='{'; deep[n++]='"'; deep[n++]='a'; deep[n++]='"';deep[n++]=':';
    for(int j=0;j<900;j++)deep[n++]='[';
    deep[n++]='0';for(int j=0;j<900;j++)deep[n++]=']';deep[n++]='}';deep[n]=0;
    unsigned allocated=alloc_calls;send_text(deep,false);assert(allocated==alloc_calls);
    const char *message="{\"t\":\"swarms\",\"items\":[{\"id\":\"a\",\"name\":\"long name\",\"panes\":2},{\"id\":\"b\"}]}";
    allocated=alloc_calls;send_text(message,true);unsigned count=alloc_calls-allocated;
    // Every individual allocation failure must free its already-built subtree.
    for(unsigned j=1;j<=count;j++) { fail_at=alloc_calls+j;send_text(message,false); }
    fail_at=0;send_text(message,true);
    // Eight perfectly ordinary unread cards exceed the old 2 KiB JSON copy.
    char batch[CABLE_JSON_MAX+1], summary[181], name[40], machine[33];
    memset(summary,'s',180);summary[180]=0;memset(name,'n',39);name[39]=0;
    memset(machine,'m',32);machine[32]=0;
    n=(size_t)snprintf(batch,sizeof batch,"{\"t\":\"notif.replace\",\"items\":[");
    for(int i=0;i<8;i++)n+=(size_t)snprintf(batch+n,sizeof batch-n,
        "%s{\"agentId\":\"12345678-1234-1234-1234-%012d\",\"name\":\"%s\",\"machine\":\"%s\",\"summary\":\"%s\",\"question\":false}",
        i ? "," : "",i,name,machine,summary);
    n+=(size_t)snprintf(batch+n,sizeof batch-n,"]}");
    assert(n>2048 && n<CABLE_JSON_MAX);send_text(batch,true);
    allocated=alloc_calls;send_text(batch,true);count=alloc_calls-allocated;
    for(unsigned j=1;j<=count;j++){fail_at=alloc_calls+j;send_text(batch,false);}
    fail_at=0;
    // The exact wire maximum is valid; one extra byte is refused before allocation.
    n=(size_t)snprintf(batch,sizeof batch,"{\"text\":\"");
    while(n<CABLE_MAX_PAYLOAD-2) { batch[n++]='a'; }
    batch[n++]='"';batch[n++]='}';batch[n]=0;
    assert(n==CABLE_MAX_PAYLOAD);send_text(batch,true);
    batch[n++]=' ';batch[n]=0;allocated=alloc_calls;send_text(batch,false);assert(allocated==alloc_calls);
    for(unsigned values=CABLE_JSON_TOKENS-3;values<=CABLE_JSON_TOKENS-2;values++) {
        n=(size_t)snprintf(batch,sizeof batch,"{\"a\":[");
        for(unsigned i=0;i<values;i++)n+=(size_t)snprintf(batch+n,sizeof batch-n,"%s0",i ? "," : "");
        n+=(size_t)snprintf(batch+n,sizeof batch-n,"]}");
        allocated=alloc_calls;send_text(batch,values+3<=CABLE_JSON_TOKENS);
        if(values+3>CABLE_JSON_TOKENS)assert(allocated==alloc_calls);
    }
    assert(peak_bytes<=CABLE_JSON_MAX+CABLE_JSON_TOKENS*sizeof(cJSON));
    printf("USB JSON bounded peak: %zu bytes (host cJSON nodes are %zu bytes)\n",peak_bytes,sizeof(cJSON));
    size_t page=(size_t)sysconf(_SC_PAGESIZE);
    uint8_t *map=mmap(NULL,3*page,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);
    assert(map!=MAP_FAILED&&!mprotect(map+page,page,PROT_READ|PROT_WRITE));
    const char *samples[]={"{}","{\"t\":\"ping\"}","{\"p\":[1,2,3]}","{\"x\":\"\\u","{\"x\":1e","{\"x\":true","{\"p\":{}}"};
    for(unsigned j=0;j<sizeof samples/sizeof *samples;j++) {
        for(size_t len=0;len<=strlen(samples[j]);len++) {
            uint8_t *p=map+2*page-len;memcpy(p,samples[j],len);
            on_frame(1,CABLE_TYPE_JSON,p,len,NULL);assert(!live);
        }
    }
    uint32_t seed=0x12347;static const char alphabet[]="{}[]\\\" :,01truefx\n\t";
    for(unsigned j=0;j<100000;j++) {
        seed=seed*1664525u+1013904223u;size_t len=seed%512;
        uint8_t *p=map+2*page-len;
        for(size_t k=0;k<len;k++){seed=seed*1664525u+1013904223u;p[k]=alphabet[seed%(sizeof alphabet-1)];}
        if(len>1){p[0]='{';p[len-1]='}';}
        on_frame(1,CABLE_TYPE_JSON,p,len,NULL);assert(!live);
    }
    assert(!munmap(map,3*page));
    on_frame(1,9,NULL,0,NULL);assert(s_unknown==1);
    on_frame(1,CABLE_TYPE_FW,NULL,0,NULL);assert(fw_slices==1);
    puts("USB JSON: real cJSON, guarded/truncated frames, 100000 mutations, every allocation failure PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='harness-cable-json-') as folder:
    out = Path(folder)
    (out / 'parse.c').write_text(code)
    flags = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
             '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds')]
    # Apple's SDK deprecates sprintf; this warning is in unmodified cJSON, not
    # the firmware callback. Keep strict diagnostics on our own sources.
    subprocess.run(flags + ['-Wno-deprecated-declarations', '-c', str(json_dir / 'cJSON.c'),
                            '-o', str(out / 'cJSON.o')], check=True)
    subprocess.run(flags + [
                    '-I', str(main), '-I', str(json_dir), str(out / 'parse.c'),
                    str(main / 'cable_json_guard.c'), str(out / 'cJSON.o'), '-lm',
                    '-o', str(out / 'parse')], check=True)
    subprocess.run([str(out / 'parse')], check=True)
