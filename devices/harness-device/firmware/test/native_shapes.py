"""Use the firmware's real protocol capacities and POD structs in host tests."""
from pathlib import Path
import re

MAIN = Path(__file__).resolve().parent / '../main'
PROTOCOL = (MAIN / 'cable_client.h').read_text()


def defines(*names, source=PROTOCOL):
    return ''.join(re.search(r'^#define ' + re.escape(name) + r'(?:\([^)]*\))?\s+[^\n]+$', source, re.M).group(0) + '\n'
                   for name in names)


def face_geometry(source):
    """The list geometry, taken from the production source rather than restated here.

    It was a #if while there were two faces; with one it is nine plain defines, and this stays so the
    slices go on reading the numbers the renderer actually uses.
    """
    return defines('TAB_ROWS', 'TAB_ROW_HEIGHT', 'TAB_TOP', 'LIST_HIT_X', 'LIST_HIT_W',
                   'LIST_TEXT_X', 'LIST_TEXT_W', 'SET_TEXT_X', 'SET_TEXT_W', source=source)


def typedef(name, source=PROTOCOL):
    for match in re.finditer(r'typedef struct\s*\{[^}]*\}\s*(\w+);', source):
        if match[1] == name:
            return match[0] + '\n'
    raise ValueError(f'No flat production struct named {name}')
