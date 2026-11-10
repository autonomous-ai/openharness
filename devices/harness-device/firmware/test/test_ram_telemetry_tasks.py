"""Stack telemetry must list exactly the tasks the firmware creates."""
from pathlib import Path
import re

main = Path(__file__).resolve().parent / '../main'

created = set()
for path in main.rglob('*.c'):
    text = path.read_text()
    for m in re.finditer(r'\bxTaskCreate(?:PinnedToCore)?\(\s*[^,]+,\s*"([^"]+)"', text):
        created.add(m.group(1))
assert created, 'no task creations found'

source = (main / 'ram_telemetry.c').read_text()
fn = re.search(r'ram_telemetry_periodic\([^)]*\)\s*\{.*?^\}', source, re.M | re.S)
assert fn, 'ram_telemetry_periodic not found'
arr = re.search(r'tasks\[\]\s*=\s*\{(.*?)\};', fn.group(0), re.S)
assert arr, 'tasks[] not found'
tasks = re.findall(r'"([^"]+)"', arr.group(1))

assert "commander_ws" not in tasks, tasks
assert set(tasks) == created, (sorted(set(tasks) ^ created))
assert len(tasks) == len(set(tasks)), 'duplicate entries'
print('ok')
