"""Build the portable renderer against the actual production compressed artwork."""
from pathlib import Path
import os
import platform
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent / 'main/ui/habitat'
PACK = HERE.parent / 'assets/companions/companion_art.pack'
with tempfile.TemporaryDirectory(prefix='harness-companions-') as directory:
    out = Path(directory)
    section = '.section __TEXT,__const' if platform.system() == 'Darwin' else '.section .rodata'
    (out / 'pack.S').write_text(f'''{section}
.globl _binary_companion_art_pack_start
.globl _binary_companion_art_pack_end
_binary_companion_art_pack_start:
.incbin "{PACK}"
_binary_companion_art_pack_end:
''')
    sources = ['character.c', 'illustrated.c', 'illustrated_cache.c', 'character_motion.c',
        'character_layout.c', 'octopus.c', 'octopus_font.c', 'ascii_clip.c', 'tux.c',
        'focus.c', 'lvgl_fonts.c', 'lvgl_icons.c', 'focus_marks.c', 'focus_faces.c', 'pets.c', 'terminal.c', 'fonts.c', '../../pet_store.c']
    subprocess.run(['cc', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
        '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'), '-I', str(NATIVE), '-I', str(NATIVE.parent.parent),
        str(HERE / 'test_companions.c'), *(str(NATIVE / name) for name in sources),
        str(out / 'pack.S'), '-lz', '-o', str(out / 'test')], check=True)
    captures = os.environ.get('COMPANION_CAPTURES')
    if captures:
        Path(captures).mkdir(parents=True, exist_ok=True)
    subprocess.run([str(out / 'test'), *([captures] if captures else [])], check=True)
