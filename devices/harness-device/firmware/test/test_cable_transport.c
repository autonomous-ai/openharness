// Original byte-at-a-time parser versus the production parser, including exact
// emitted bytes, incomplete tails and resynchronization counters after each read.
#include "cable_frame.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

void reference_decoder_init(cable_decoder_t *d);
void reference_decoder_reset(cable_decoder_t *d);
void reference_decoder_feed(cable_decoder_t *d, const uint8_t *data, size_t n,
                            cable_frame_cb cb, void *ctx);
int reference_frame_encode(uint8_t type, const uint8_t *payload, size_t len,
                           uint8_t *out, size_t capacity);

enum { STREAM_BYTES = 32768, MAX_RECORDS = STREAM_BYTES / 8 };
typedef struct { size_t length; uint8_t version, type; } record_t;
typedef struct {
    record_t records[MAX_RECORDS];
    uint8_t bytes[STREAM_BYTES];
    size_t count, used;
} collected_t;
static collected_t actual, expected;
static cable_decoder_t fast, old;
static uint8_t stream[STREAM_BYTES], payload[CABLE_MAX_PAYLOAD];
static uint8_t a[CABLE_MAX_FRAME + 16], b[CABLE_MAX_FRAME + 16];
static uint32_t rng = 0xd00e5193;
static uint32_t random_word(void)
{
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng;
}
static void collect(uint8_t version, uint8_t type, const uint8_t *p, size_t n, void *ctx)
{
    collected_t *c = ctx;
    assert(c->count < MAX_RECORDS && n <= sizeof c->bytes - c->used);
    c->records[c->count++] = (record_t){.length=n, .version=version, .type=type};
    memcpy(c->bytes + c->used, p, n); c->used += n;
}
static void equal(void)
{
    assert(fast.len <= sizeof fast.buf && fast.len == old.len);
    assert(fast.corrupt_frames == old.corrupt_frames);
    assert(fast.discarded_bytes == old.discarded_bytes);
    assert(!memcmp(fast.buf, old.buf, fast.len));
    assert(actual.count == expected.count && actual.used == expected.used);
    for (size_t i = 0; i < actual.count; i++) {
        assert(actual.records[i].length == expected.records[i].length);
        assert(actual.records[i].version == expected.records[i].version);
        assert(actual.records[i].type == expected.records[i].type);
    }
    assert(!memcmp(actual.bytes, expected.bytes, actual.used));
}
static void replay(size_t size, unsigned split, bool reset)
{
    actual.count = actual.used = expected.count = expected.used = 0;
    cable_decoder_init(&fast); reference_decoder_init(&old);
    for (size_t at = 0; at < size;) {
        size_t n = split == 0 ? size : split == 1 ? 1 : 1 + random_word() % 257;
        if (n > size - at) n = size - at;
        reference_decoder_feed(&old, stream + at, n, collect, &expected);
        cable_decoder_feed(&fast, stream + at, n, collect, &actual);
        equal();
        cable_decoder_feed(&fast, NULL, 0, collect, &actual);
        reference_decoder_feed(&old, NULL, 0, collect, &expected);
        equal();
        at += n;
        if (reset && at > size / 2) {
            cable_decoder_reset(&fast); reference_decoder_reset(&old); equal(); reset = false;
        }
    }
}
int main(void)
{
    for (size_t i = 0; i < sizeof payload; i++) payload[i] = (uint8_t)random_word();
    unsigned encodes = 0, streams = 0;
    for (size_t len = 0; len <= CABLE_MAX_PAYLOAD + 1; len++) {
        uint8_t type = (uint8_t)random_word();
        memset(a, 0xcd, sizeof a); memset(b, 0xcd, sizeof b);
        int an = cable_frame_encode(type, payload, len, a + 8, CABLE_MAX_FRAME);
        int bn = reference_frame_encode(type, payload, len, b + 8, CABLE_MAX_FRAME);
        assert(an == bn && !memcmp(a, b, sizeof a)); encodes++;
        if (an > 0) {
            memcpy(stream, a + 8, (size_t)an);
            replay((size_t)an, len % 3, false); streams++;
            // Refusal must leave every destination byte untouched.
            memset(a, 0xcd, sizeof a);
            assert(cable_frame_encode(type, payload, len, a + 8, (size_t)an - 1) == -1);
            for (size_t i = 0; i < sizeof a; i++) assert(a[i] == 0xcd);
        }
    }
    for (unsigned test = 0; test < 12000; test++) {
        size_t size = random_word() % 128;
        for (size_t i = 0; i < size; i++) stream[i] = (uint8_t)random_word();
        unsigned count = 1 + random_word() % 4;
        for (unsigned frame = 0; frame < count; frame++) {
            size_t len = test % 97 == 0 ? CABLE_MAX_PAYLOAD : random_word() % 1025;
            if (CABLE_HEADER_BYTES + len + CABLE_CRC_BYTES > sizeof stream - size) break;
            for (size_t i = 0; i < len; i++) payload[i] = (uint8_t)random_word();
            int n = reference_frame_encode((uint8_t)random_word(), payload, len,
                                            stream + size, sizeof stream - size);
            assert(n > 0);
            if ((test + frame) % 3 == 0)
                stream[size + random_word() % (unsigned)n] ^= (uint8_t)(1u << (random_word() % 8));
            size += (size_t)n;
        }
        if (test % 5 == 0 && size > 1) size -= 1 + random_word() % (size / 2);
        replay(size, test % 3, test % 7 == 0); streams++;
    }
    // Dense false headers, oversized lengths and embedded valid frame starts.
    for (size_t i = 0; i < sizeof stream; i++)
        stream[i] = (const uint8_t[]){0xa5, 0x48, 1, 3, 0xff, 0xff}[i % 6];
    for (unsigned split = 0; split < 3; split++) { replay(sizeof stream, split, false); streams++; }
    printf("transport: PASS (%u exact encodes, %u streams; bulk/byte/random splits, noise, CRC errors, reset and incomplete-tail equivalence)\n", encodes, streams);
}
