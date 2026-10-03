#define _DEFAULT_SOURCE 1
#include "../main/ui/habitat/ascii_clip.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static uint32_t seed = 0x61547230;
static unsigned next(void) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; }
// The byte immediately after every test buffer is an inaccessible page.
// These checks remain useful when a host cannot initialize AddressSanitizer.
static void *guarded(size_t size)
{
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    assert(size && size <= page);
    char *p = mmap(NULL, page * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    assert(p != MAP_FAILED && !mprotect(p + page, page, PROT_NONE));
    return p + page - size;
}
static void release(void *buffer)
{
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    void *base = (void *)((uintptr_t)buffer & ~(uintptr_t)(page - 1));
    assert(!munmap(base, page * 2));
}
static bool reference(const ht_ascii_clip_t *c, unsigned frame, unsigned row, char *out, size_t cap)
{
    if (cap) out[0] = 0;
    if (!cap || !c->cols || cap <= c->cols || !c->symbols || c->symbols > 16 ||
        frame >= c->frames || row >= c->rows) return false;
    unsigned key = c->frame_rows[frame * c->rows + row];
    if (key >= c->unique_rows) return false;
    unsigned a = c->row_offsets[key], b = c->row_offsets[key + 1];
    if (a > b || b > c->data_bytes) return false;
    unsigned n = 0;
    for (unsigned i = a; i < b; i++) {
        unsigned symbol = c->data[i] % 16;
        if (symbol >= c->symbols || (unsigned char)c->alphabet[symbol] < 32 ||
            (unsigned char)c->alphabet[symbol] > 126) return false;
        n += c->data[i] / 16 + 1;
    }
    if (n != c->cols) return false;
    n = 0;
    for (unsigned i = a; i < b; i++) for (unsigned j = 0; j <= c->data[i] / 16; j++)
        out[n++] = c->alphabet[c->data[i] % 16];
    out[n] = 0;
    return true;
}
int main(void)
{
    char *alphabet = guarded(16), *out = guarded(65);
    uint8_t *data = guarded(128);
    uint16_t *offsets = guarded(33 * sizeof *offsets), *keys = guarded(64 * sizeof *keys);
    ht_ascii_clip_t clip = {.cols=54,.rows=1,.symbols=2,.frames=1,.unique_rows=1,
        .data_bytes=4,.alphabet=alphabet,.frame_rows=keys,.row_offsets=offsets,.data=data};
    memcpy(alphabet, " #", 2); keys[0] = 0; offsets[0] = 0; offsets[1] = 4;
    data[0]=0xf0; data[1]=0xf1; data[2]=0xf0; data[3]=0x51;
    assert(ht_ascii_clip_row(&clip,0,0,out+10,55)); // exact capacity ending at guard
    assert(strlen(out+10)==54);
    assert(!memcmp(out+10,"                ################                ######",54));
    assert(!ht_ascii_clip_row(&clip,0,0,out+11,54)); // no room for terminator
    assert(!ht_ascii_clip_row(&clip,UINT32_MAX,0,out,65));
    assert(!ht_ascii_clip_row(&clip,0,UINT32_MAX,out,65));
    assert(!ht_ascii_clip_row(&clip,0,0,NULL,0));
    assert(!ht_ascii_clip_row(NULL,0,0,out,65));
    // Authored rows have many one-cell strokes plus longer transparent runs.
    // Exercise successful writes, ending exactly at the inaccessible page.
    for (unsigned trial=0;trial<50000;trial++) {
        clip.cols=1+next()%64; clip.rows=clip.frames=clip.unique_rows=1;
        clip.symbols=1+next()%16; offsets[0]=keys[0]=0;
        for (unsigned i=0;i<16;i++) alphabet[i]=32+next()%95;
        unsigned cells=0, runs=0;
        while(cells<clip.cols) {
            unsigned n=1+next()%16;
            if(n>clip.cols-cells)n=clip.cols-cells;
            data[runs++]=(uint8_t)(((n-1)<<4) | (next()%clip.symbols));
            cells+=n;
        }
        offsets[1]=clip.data_bytes=runs;
        char expected[65]; size_t cap=clip.cols+1;
        assert(reference(&clip,0,0,expected,cap));
        for(int mode=0;mode<2;mode++) {
            ht_ascii_clip_short_runs(mode!=0);
            assert(ht_ascii_clip_row(&clip,0,0,out+65-cap,cap));
            assert(!memcmp(out+65-cap,expected,cap));
        }
    }
    ht_ascii_clip_short_runs(true);
    for (unsigned trial=0;trial<100000;trial++) {
        clip.cols=next()%65; clip.rows=next()%9; clip.frames=next()%9;
        clip.symbols=next()%18; clip.unique_rows=next()%33; clip.data_bytes=next()%129;
        for (unsigned i=0;i<16;i++) alphabet[i]=next();
        for (unsigned i=0;i<128;i++) data[i]=next();
        for (unsigned i=0;i<33;i++) offsets[i]=next()%180;
        for (unsigned i=0;i<64;i++) keys[i]=next()%40;
        unsigned frame=next()%10,row=next()%10,cap=next()%66;
        char expected[65];
        bool valid=reference(&clip,frame,row,expected,cap);
        bool actual=ht_ascii_clip_row(&clip,frame,row,out+65-cap,cap);
        assert(actual==valid);
        if(valid) assert(!strcmp(out+65-cap,expected));
        else if(cap) assert(!out[65-cap]);
    }
    release(alphabet);release(out);release(data);release(offsets);release(keys);
    puts("ASCII clip: exact-capacity guards, 50000 valid rows in both decode modes + 100000 malformed metadata/run cases pass");
}
