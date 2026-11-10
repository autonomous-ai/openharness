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
print('generated arrays are unique')
