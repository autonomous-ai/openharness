#include "../main/cable_json_guard.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static bool valid(const char *s) { return cable_json_guard((const uint8_t *)s, strlen(s)); }
int main(void)
{
    assert(valid("{}") && valid(" \n{\"t\":\"ping\"}\r\t "));
    assert(valid("{\"p\":{\"items\":[{\"name\":\"braces [ } and \\\" quotes\"}]}}"));
    assert(!valid("") && !valid("[]") && !valid("null"));
    assert(!valid("{}{}") && !valid("{}garbage") && !valid("{]"));
    assert(!valid("{\"p\": [}") && !valid("{\"p\":\"unterminated}"));
    assert(!valid("{\"p\":\"literal\nnewline\"}"));
    const uint8_t nul[] = {'{','}',0,'{','}'};
    assert(!cable_json_guard(nul, sizeof nul));
    char nested[CABLE_JSON_MAX + 1];
    for (unsigned depth = 1; depth < 1000; depth++) {
        size_t n = 0; nested[n++] = '{'; nested[n++] = '"'; nested[n++] = 'a';
        nested[n++] = '"'; nested[n++] = ':';
        for (unsigned j = 1; j < depth; j++) nested[n++] = '[';
        nested[n++] = '0';
        for (unsigned j = 1; j < depth; j++) nested[n++] = ']';
        nested[n++] = '}';
        assert(cable_json_guard((const uint8_t *)nested, n) == (depth <= CABLE_JSON_DEPTH));
    }
    memset(nested, ' ', sizeof nested); nested[0] = '{'; nested[1] = '}';
    assert(cable_json_guard((const uint8_t *)nested, CABLE_JSON_MAX - 1));
    assert(!cable_json_guard((const uint8_t *)nested, CABLE_JSON_MAX));
    assert(!cable_json_guard(NULL, 1));

    for (unsigned values=CABLE_JSON_TOKENS-3; values<=CABLE_JSON_TOKENS-2; values++) {
        size_t n=(size_t)snprintf(nested,sizeof nested,"{\"a\":[");
        for(unsigned i=0;i<values;i++) n+=(size_t)snprintf(nested+n,sizeof nested-n,"%s0",i ? "," : "");
        n+=(size_t)snprintf(nested+n,sizeof nested-n,"]}");
        assert(cable_json_guard((const uint8_t *)nested,n)==(values+3<=CABLE_JSON_TOKENS));
    }

    // The received frame ends immediately before an inaccessible page. A missing
    // terminator or truncated escape must never cause a read into the next frame.
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    size_t window = (CABLE_JSON_MAX + page - 1) / page * page;
    uint8_t *map = mmap(NULL, window + 2 * page, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(map != MAP_FAILED && !mprotect(map + page, window, PROT_READ | PROT_WRITE));
    uint32_t seed = 0x3246524d;
    static const char alphabet[] = "{}[]\\\" :,01x\n\t";
    for (unsigned trial = 0; trial < 100000; trial++) {
        seed = seed * 1664525u + 1013904223u;
        size_t n = seed % CABLE_JSON_MAX;
        uint8_t *p = map + page + window - n;
        for (size_t j = 0; j < n; j++) {
            seed = seed * 1664525u + 1013904223u;
            p[j] = (uint8_t)alphabet[seed % (sizeof alphabet - 1)];
        }
        if (n > 1 && trial % 2) { p[0] = '{'; p[n - 1] = '}'; }
        (void)cable_json_guard(p, n);
    }
    assert(!munmap(map, window + 2 * page));
    puts("JSON guard: exact depth/size limits, escapes, NUL/trailing data, 100000 guarded frames PASS");
}
