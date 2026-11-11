"""app_main installs the PSRAM-first cJSON allocator before any other call."""
from pathlib import Path
import re

main = Path(__file__).resolve().parent / '../main'
source = (main / 'app_main.c').read_text()
match = re.search(r'^void app_main\(void\)\n\{(.*?)^\}', source, re.M | re.S)
assert match, 'app_main not found'
statements = [line.split('//')[0].strip() for line in match.group(1).splitlines()
              if line.split('//')[0].strip() and not line.strip().startswith('#')]
assert statements[0] == 'ram_telemetry_init();', statements[0]
assert source.count('ram_telemetry_init();') == 1
print('ok')
