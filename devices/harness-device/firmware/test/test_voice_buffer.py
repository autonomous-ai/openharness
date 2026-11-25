"""The dial's voice gate and level meter, at each mic gain, on the vectors the daemon's gate also reads.

Checks the vectors are current first, so a stale file is named as such rather than read as a gate bug. Run from
here rather than only from run.sh, because firmware-checks runs every test_*.py on PR CI.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

here = Path(__file__).resolve().parent
main = here / '../main'
vectors = here / 'vectors'

subprocess.run([sys.executable, str(here / 'voice_signal.py')], check=True, stdout=subprocess.DEVNULL)
subprocess.run([sys.executable, str(here / 'gen_voice_vectors.py'), '--check'], check=True, stdout=subprocess.DEVNULL)
with tempfile.TemporaryDirectory(prefix='harness-voice-buffer-') as folder:
    binary = Path(folder) / 'test_voice_buffer'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O1', '-g',
                    '-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I', str(main), '-o', str(binary), str(here / 'test_voice_buffer.c'),
                    str(main / 'voice_buffer.c')], check=True)
    subprocess.run([str(binary), str(vectors / 'voice_gate.txt'), str(vectors / 'voice_gate.pcm')], check=True)
