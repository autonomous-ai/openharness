#!/usr/bin/env python3
"""Compare every decoded cell with the user's approved gallery source frames."""
import json
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = json.loads((root.parent / 'prototype/habitat/assets/creature-references/clips.json').read_text())[0]
native = root / 'main/ui/habitat'
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    (out / 'decode.c').write_text('''
#include "ascii_clip.h"
#include "octopus_art.inc"
#include <stdio.h>
#include <assert.h>
int main(void) {
    char row[55];
    for (unsigned f=0;f<octopus_clip.frames;f++) for(unsigned r=0;r<octopus_clip.rows;r++) {
        assert(ht_ascii_clip_row(&octopus_clip,f,r,row,sizeof row));
        assert(fwrite(row,1,54,stdout)==54);
    }
    return 0;
}
''')
    subprocess.run(['cc','-std=c11','-O1','-g','-fsanitize=' + os.environ.get('SANITIZERS', 'undefined,bounds'),
                    '-I',str(native),str(out/'decode.c'),str(native/'ascii_clip.c'),
                    '-o',str(out/'decode')],check=True)
    actual = subprocess.check_output([str(out/'decode')])
expected = ''.join(row for frame in source['frames'] for row in frame).encode('ascii')
assert actual == expected
print(f'Octopus artwork: all {len(actual)} decoded cells / 63 frames exactly match approved source')
