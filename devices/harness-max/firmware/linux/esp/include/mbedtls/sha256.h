// SHA-256 on Linux (esp/esp.c): fw_update.c hashes only an image written to flash, which Linux never has, so every
// call fails rather than carrying a hash nothing uses.
#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
    int unused;
} mbedtls_sha256_context;

void mbedtls_sha256_init(mbedtls_sha256_context *ctx);
void mbedtls_sha256_free(mbedtls_sha256_context *ctx);
int mbedtls_sha256_starts(mbedtls_sha256_context *ctx, int is224);
int mbedtls_sha256_update(mbedtls_sha256_context *ctx, const unsigned char *input, size_t len);
int mbedtls_sha256_finish(mbedtls_sha256_context *ctx, unsigned char output[32]);
