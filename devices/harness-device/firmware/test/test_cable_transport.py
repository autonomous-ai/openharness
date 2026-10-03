"""Run exact wire/parser comparisons with both native and ESP-ROM code paths."""
from pathlib import Path
import os
import subprocess
import tempfile

here = Path(__file__).resolve().parent
idf = Path(os.environ['IDF_PATH']) if os.environ.get('IDF_PATH') else None
with tempfile.TemporaryDirectory(prefix='harness-transport-') as directory:
    root = Path(directory)
    flags = ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
             '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
             '-I', str(here / '../main')]
    for mode in ('native', 'rom') if idf else ('native',):
        sources = [str(here / 'test_cable_transport.c'), str(here / '../main/cable_frame.c'),
                   str(here / 'reference91/cable_frame_ref.c')]
        extra = []
        if mode == 'rom':
            (root / 'esp_rom_caps.h').write_text('#define ESP_ROM_HAS_CRC_BE 0\n#define ESP_ROM_HAS_CRC_LE 0\n')
            extra = ['-DESP_PLATFORM', '-I', str(root), '-I', str(idf / 'components/esp_rom/include')]
            sources += [str(idf / 'components/esp_rom/patches/esp_rom_crc.c')]
        exe = root / mode
        subprocess.run(flags + extra + sources + ['-o', str(exe)], check=True)
        print(mode + ' path:', flush=True)
        subprocess.run([str(exe)], check=True)
