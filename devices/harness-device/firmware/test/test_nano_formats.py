"""Newlib nano printf cannot print %ll*, %j, %z, %t, %L or %a; main/ must not use them."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent / '..'
main = root / 'main'

# A conversion with an unsupported length modifier, or the %a conversion.
bad_conv = re.compile(r'%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:(?:ll|[jztL])[a-zA-Z]|[aA](?![a-zA-Z]))')
pri64 = re.compile(r'\bPRI[a-zA-Z]*64\b')

found = []
for path in sorted(list(main.rglob('*.c')) + list(main.rglob('*.h'))):
    for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
        for literal in re.findall(r'"(?:\\.|[^"\\])*"', line):
            literal = literal.replace('%%', '')
            if bad_conv.search(literal):
                found.append(f'{path.name}:{number}: {literal}')
        if pri64.search(line):
            found.append(f'{path.name}:{number}: {line.strip()}')
assert not found, 'nano printf cannot print:\n' + '\n'.join(found)

defaults = (root / 'sdkconfig.defaults').read_text()
assert re.search(r'^CONFIG_LIBC_NEWLIB_NANO_FORMAT=y$', defaults, re.M), 'nano format not enabled'
print('ok')
