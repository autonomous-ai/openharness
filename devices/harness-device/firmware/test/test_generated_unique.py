"""Generated C files carry each constant array once: two arrays of one element type with the same body are one array."""
from pathlib import Path
import re

fw = Path(__file__).resolve().parent.parent
habitat = fw / 'main/ui/habitat'
ARRAY = re.compile(r'^static const (\S+) (\w+)((?:\[[^\]]*\])+) = \{(.*)\};$')


def unique_arrays(path):
    seen, dupes = {}, []
    for number, line in enumerate(Path(path).read_text().splitlines(), 1):
        m = ARRAY.match(line)
        if not m:
            continue
        kind, name, dims, body = m.groups()
        key = (kind, dims, body)
        if key in seen:
            dupes.append(f'{Path(path).name}:{number}: {name} repeats {seen[key]}')
        else:
            seen[key] = name
    assert not dupes, f'{len(dupes)} duplicate arrays:\n' + '\n'.join(dupes[:10])


unique_arrays(habitat / 'pets.c')
unique_arrays(habitat / 'focus_marks.c')
unique_arrays(habitat / 'focus_faces.c')

# Claude, Codex and Muse always show their built-in pet (focus.c pet_for), so their 56 px marks are never drawn.
marks = (habitat / 'focus_marks.c').read_text()
table = re.search(r'^const ht_icon_t ht_icon_engine56\[\d+\] = \{(.*)\};$', marks, re.M).group(1)
entries, depth, start = [], 0, 0
for i, c in enumerate(table):
    depth += c == '{'
    depth -= c == '}'
    if depth == 0 and c == '}':
        entries.append(table[start:i + 1].lstrip(','))
        start = i + 1
assert len(entries) == 14, len(entries)
for index in (0, 1, 11):
    assert entries[index] == '{0,0,NULL,NULL}', (index, entries[index])
# --- focus_faces.c: shared tables change no face's rendering; the wordmark's kerning is cut to its own letters ---
import os
import subprocess

BEFORE_SHA = 'eb511fb19'   # focus_faces.c before Latin Extended-A was cut to Vietnamese (tables already shared)
before_file = Path(os.environ.get('FOCUS_FACES_BEFORE', '/nonexistent/focus_faces.before.c'))
if before_file.exists():
    before_text = before_file.read_text()
else:
    before_text = subprocess.run(['git', 'show', f'{BEFORE_SHA}:devices/harness-device/firmware/main/ui/habitat/focus_faces.c'],
                                 check=True, capture_output=True, text=True, cwd=fw).stdout
FACE = re.compile(r'^const ht_pfont_t (ht_lv_\w+) = \{\{(.*?),(\w+)\},(\w+),(\w+),(\d+),(\d+),(\w+),(\w+),(\w+),(\d+),(\w+)\};$')


def faces(text):
    """face -> dict of its resolved tables (name-independent) and scalar fields."""
    arrays = {name: [int(v) for v in re.findall(r'-?\d+', body)]
              for name, body in re.findall(r'^static const \S+ (\w+)\[\] = \{(.*?)\};$', text, re.M | re.S)}
    out = {}
    for line in text.splitlines():
        m = FACE.match(line)
        if m:
            (name, head, px, glyphs, codes, count, ascent, kl, kr, kv, rcnt, fallback) = m.groups()
            out[name] = dict(head=head, px=arrays[px], glyphs=arrays[glyphs], codes=arrays[codes], count=int(count),
                             ascent=int(ascent), kl=arrays[kl], kr=arrays[kr], kv=arrays[kv], rcnt=int(rcnt),
                             fallback=fallback)
    return out


def pkern(face, a, b):   # terminal.c pkern for two glyph indices of one face
    l, r = face['kl'][a], face['kr'][b]
    return face['kv'][(l - 1) * face['rcnt'] + (r - 1)] if l and r else 0


old, new = faces(before_text), faces((habitat / 'focus_faces.c').read_text())
assert set(old) == set(new) and len(old) == 8, sorted(new)
def glyph(face, i):   # (advance, ink box, bitmap bytes) of glyph i, independent of where the bitmap sits
    offset, adv, w, h, ox, oy = face['glyphs'][i * 6:i * 6 + 6]
    return adv, w, h, ox, oy, face['px'][offset:offset + (w * h + 1) // 2]


for name in old:
    o, n = old[name], new[name]
    assert o['head'].rsplit(',', 1)[0] == n['head'].rsplit(',', 1)[0], name   # the bitmap array's name may differ
    for field in ('ascent', 'fallback'):
        assert o[field] == n[field], (name, field)
    if o['codes'] == n['codes']:
        for field in ('px', 'glyphs', 'codes', 'count'):
            assert o[field] == n[field], (name, field)
        if name != 'ht_lv_inter_bold_48':   # the Inter faces' kerning tables are unchanged, only shared
            for field in ('kl', 'kr', 'kv', 'rcnt'):
                assert o[field] == n[field], (name, field)
    else:
        # Latin Extended-A cut to Vietnamese: only that block may go, and every kept letter draws and kerns as before.
        assert set(n['codes']) < set(o['codes']) and name.startswith('ht_lv_inter'), name
        assert {c for c in o['codes'] if c not in n['codes']} <= set(range(0x100, 0x180)), name
        assert {c for c in o['codes'] if 0x100 <= c < 0x180} - set(n['codes']) == {c for c in o['codes'] if c not in n['codes']}
        assert {c for c in n['codes'] if 0x100 <= c < 0x180} == {0x102, 0x103, 0x110, 0x111, 0x128, 0x129, 0x168, 0x169}, name
        oi = {c: i for i, c in enumerate(o['codes'])}
        ni = {c: i for i, c in enumerate(n['codes'])}
        assert n['count'] == len(n['codes'])
        for c in ni:
            assert glyph(o, oi[c]) == glyph(n, ni[c]), (name, hex(c))
        if name != 'ht_lv_inter_bold_48':
            for a in ni:
                for b in ni:
                    assert pkern(o, oi[a], oi[b]) == pkern(n, ni[a], ni[b]), (name, hex(a), hex(b))

# The wordmark: tables sized for its own seven glyphs, and every ordered pair kerns by the same amount as before.
word_old, word_new = old['ht_lv_inter_bold_48'], new['ht_lv_inter_bold_48']
assert word_new['codes'] == [32, 72, 97, 101, 110, 114, 115]
glyphs = len(word_new['codes'])
assert word_new['rcnt'] <= glyphs and max(word_new['kr']) == word_new['rcnt'], word_new['rcnt']
assert max(word_new['kl']) <= glyphs and len(word_new['kv']) == max(word_new['kl']) * word_new['rcnt'], len(word_new['kv'])
assert any(pkern(word_old, a, b) for a in range(glyphs) for b in range(glyphs))   # the check is not vacuous
for a in range(glyphs):
    for b in range(glyphs):
        assert pkern(word_old, a, b) == pkern(word_new, a, b), (a, b)
print('generated arrays are unique')
