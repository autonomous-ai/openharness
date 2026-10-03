"""Verify the CRC candidates against the wire implementation and Espressif source.

The native SDK function is Espressif's software implementation of the ROM API;
the physical diagnostic checks the actual ROM entry point separately.
"""
from pathlib import Path
import os
import re
import subprocess
import tempfile

here = Path(__file__).resolve().parent
idf = Path(os.environ['IDF_PATH'])
source = (here / '../main/ui/habitat/transport_bench.c').read_text()


def function(name):
    match = re.search(r'^static uint16_t ' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S)
    assert match, name
    return match[0] + '\n'


code = r'''
#include "cable_frame.h"
#include "esp_rom_crc.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
''' + function('crc_nibble') + function('crc_rom') + r'''
static uint32_t rng = 0x71829345;
static uint32_t random_word(void) {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng;
}
static unsigned checks;
static void check(const uint8_t *p, size_t len) {
    uint16_t old = cable_crc16(p, len);
    assert(crc_nibble(p, len) == old);
    assert(crc_rom(p, len) == old);
    checks++;
}
int main(void) {
    assert(crc_rom((const uint8_t *)"123456789", 9) == 0x29b1);
    assert(crc_nibble((const uint8_t *)"123456789", 9) == 0x29b1);
    check(NULL, 0);
    uint8_t pair[2];
    for (unsigned value = 0; value < 256; value++) {
        pair[0] = value; check(pair, 1);
    }
    for (unsigned value = 0; value < 65536; value++) {
        pair[0] = value >> 8; pair[1] = value; check(pair, 2);
    }
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    size_t size = ((CABLE_MAX_PAYLOAD + 4 + page - 1) / page) * page;
    uint8_t *guard = mmap(NULL, size + page, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(guard != MAP_FAILED);
    assert(mprotect(guard + size, page, PROT_NONE) == 0);
    for (size_t i = 0; i < size; i++) guard[i] = (uint8_t)random_word();
    for (size_t len = 0; len <= CABLE_MAX_PAYLOAD + 4; len++)
        check(guard + size - len, len);
    for (unsigned i = 0; i < 10000; i++) {
        size_t len = random_word() % 513;
        for (size_t j = 0; j < len; j++) guard[size - len + j] = (uint8_t)random_word();
        check(guard + size - len, len);
    }
    assert(munmap(guard, size + page) == 0);
    printf("CRC: PASS (%u comparisons; all one/two-byte inputs, every legal frame length, guarded reads, SDK ROM semantics)\n", checks);
}
'''

with tempfile.TemporaryDirectory(prefix='harness-crc-') as directory:
    root = Path(directory)
    (root / 'test.c').write_text(code)
    # Compile the SDK's software fallback, rather than duplicating its algorithm.
    (root / 'esp_rom_caps.h').write_text('#define ESP_ROM_HAS_CRC_BE 0\n#define ESP_ROM_HAS_CRC_LE 0\n')
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(root), '-I', str(here / '../main'),
                    '-I', str(idf / 'components/esp_rom/include'),
                    str(root / 'test.c'), str(here / '../main/cable_frame.c'),
                    str(idf / 'components/esp_rom/patches/esp_rom_crc.c'),
                    '-o', str(root / 'test')], check=True)
    subprocess.run([str(root / 'test')], check=True)
