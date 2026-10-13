// Host-test stand-in for mbedtls/sha256.h: a small portable SHA-256 behind the four calls fw_update.c makes,
// so the suite needs no mbedtls build (and the digest it checks is a real one).
#pragma once
#include <stdint.h>
#include <string.h>
typedef struct { uint32_t h[8]; uint8_t buf[64]; uint64_t len; } mbedtls_sha256_context;
static const uint32_t sha_k[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,
    0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
    0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,
    0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
static inline void mbedtls_sha256_init(mbedtls_sha256_context *c) { memset(c, 0, sizeof *c); }
static inline void mbedtls_sha256_free(mbedtls_sha256_context *c) { (void)c; }
static inline int mbedtls_sha256_starts(mbedtls_sha256_context *c, int is224)
{
    static const uint32_t iv[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    (void)is224; memcpy(c->h, iv, sizeof iv); c->len = 0; return 0;
}
#define SHA_ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
static inline void sha_block(mbedtls_sha256_context *c, const uint8_t *p)
{
    uint32_t w[64], a[8];
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[i*4] << 24 | p[i*4+1] << 16 | p[i*4+2] << 8 | p[i*4+3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = SHA_ROR(w[i-15], 7) ^ SHA_ROR(w[i-15], 18) ^ (w[i-15] >> 3);
        uint32_t s1 = SHA_ROR(w[i-2], 17) ^ SHA_ROR(w[i-2], 19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    memcpy(a, c->h, sizeof a);
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = a[7] + (SHA_ROR(a[4], 6) ^ SHA_ROR(a[4], 11) ^ SHA_ROR(a[4], 25)) + ((a[4] & a[5]) ^ (~a[4] & a[6])) + sha_k[i] + w[i];
        uint32_t t2 = (SHA_ROR(a[0], 2) ^ SHA_ROR(a[0], 13) ^ SHA_ROR(a[0], 22)) + ((a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]));
        memmove(a + 1, a, 7 * sizeof a[0]); a[4] += t1; a[0] = t1 + t2;
    }
    for (int i = 0; i < 8; i++) c->h[i] += a[i];
}
static inline int mbedtls_sha256_update(mbedtls_sha256_context *c, const uint8_t *d, size_t n)
{
    for (size_t i = 0; i < n; i++) { c->buf[c->len++ % 64] = d[i]; if (c->len % 64 == 0) sha_block(c, c->buf); }
    return 0;
}
static inline int mbedtls_sha256_finish(mbedtls_sha256_context *c, uint8_t out[32])
{
    uint64_t bits = c->len * 8; uint8_t one = 0x80, zero = 0;
    mbedtls_sha256_update(c, &one, 1);
    while (c->len % 64 != 56) mbedtls_sha256_update(c, &zero, 1);
    for (int i = 7; i >= 0; i--) { uint8_t b = (uint8_t)(bits >> (i * 8)); mbedtls_sha256_update(c, &b, 1); }
    for (int i = 0; i < 8; i++) { out[i*4] = c->h[i] >> 24; out[i*4+1] = c->h[i] >> 16; out[i*4+2] = c->h[i] >> 8; out[i*4+3] = c->h[i]; }
    return 0;
}
