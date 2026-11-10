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
# An engine the marks script leaves empty must have a built-in pet, or it would show neither a mark nor a pet.
script = (fw / 'scripts/gen_focus_marks.py').read_text()
empty = re.findall(r"'(\w+)'", re.search(r'^PET_ENGINES = \((.*)\)$', script, re.M).group(1))
assert empty == ['claude', 'codex', 'muse'], empty
pets = re.search(r'^const ht_pet_t ht_pets\[\] = \{(.*)\};$', (habitat / 'pets.c').read_text(), re.M).group(1)
pet_engines = set(re.findall(r'\{"(\w+)",', pets))
assert set(empty) <= pet_engines, (empty, sorted(pet_engines))
for index in (0, 1, 11):
    assert entries[index] == '{0,0,NULL,NULL}', (index, entries[index])
# --- focus_faces.c: the Latin Extended-A letters kept; the wordmark's kerning cut to its own letters ---
# (The one-time check that table sharing and the cut changed no kept glyph was run against the file before them
# when they landed; these invariants hold the result without needing that history.)
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


new = faces((habitat / 'focus_faces.c').read_text())
assert len(new) == 8, sorted(new)
KEPT_EXT_A = {0x102, 0x103, 0x110, 0x111, 0x128, 0x129, 0x168, 0x169,             # Vietnamese
              0x132, 0x133, 0x138, 0x13F, 0x140, 0x14A, 0x14B, 0x152, 0x153}     # no one-letter base (Inter has no U+0149)
for name, face in new.items():
    assert face['count'] == len(face['codes']), name
    if name.startswith('ht_lv_inter') and name != 'ht_lv_inter_bold_48':
        assert {c for c in face['codes'] if 0x100 <= c < 0x180} == KEPT_EXT_A, name
        assert set(range(0x20, 0x7F)) <= set(face['codes']), name                 # ASCII stays whole
        assert set(range(0x1EA0, 0x1EFA)) & set(face['codes']), name             # and Vietnamese's own block

# The wordmark: tables sized for its own seven glyphs, and every ordered pair kerns as it did before the cut
# (values taken from the file the cut was verified against).
word = new['ht_lv_inter_bold_48']
assert word['codes'] == [32, 72, 97, 101, 110, 114, 115]
glyphs = len(word['codes'])
assert word['rcnt'] <= glyphs and max(word['kr']) == word['rcnt'], word['rcnt']
assert max(word['kl']) <= glyphs and len(word['kv']) == max(word['kl']) * word['rcnt'], len(word['kv'])
WORD_KERN = [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 5, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 3, -6, -6, 5, 5, 0], [0, 0, 0, 0, 0, 0, 0]]
assert [[pkern(word, a, b) for b in range(glyphs)] for a in range(glyphs)] == WORD_KERN
print('generated arrays are unique')
