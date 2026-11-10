"""Task stacks are sized from measured peaks: new size >= 1.5 x peak use.

Evidence (dial logs ~/.harness/logs/usb-28-84-85-*/dial-*.log, fw 0.0.99/0.1.0):
  habitat_render: lowest `alive stack_free=` 18980 B on a 24576 B stack -> peak 5596 B.
  proj_refresh:   lowest `STACK task=proj_refresh free_min=` 4920 B on 7168 B -> peak 2248 B.
  voice_capture / voice_send: peaks 2576 / 2404 B come from the audit
  (docs/plans/2026-11-10-round-dial-resources-audit.md, #12); those logs carry no STACK
  line for the voice tasks, so they are not re-verified there.
"""
from pathlib import Path
import re

main = Path(__file__).resolve().parent / '../main'

# name -> (expected new stack, measured peak use in bytes)
EXPECTED = {
    'habitat_render': (12288, 5596),
    'proj_refresh': (4096, 2248),
    'voice_capture': (4096, 2576),
    'voice_send': (4096, 2404),
}

sizes = {}
for path in main.rglob('*.c'):
    text = path.read_text()
    for m in re.finditer(r'\bxTaskCreate(?:PinnedToCore)?\(\s*[^,]+,\s*"([^"]+)"\s*,\s*(\d+)', text):
        sizes[m.group(1)] = int(m.group(2))

for name, (size, peak) in EXPECTED.items():
    assert sizes.get(name) == size, (name, sizes.get(name), size)
    assert size >= 1.5 * peak, (name, size, peak)
print('ok')
