"""Validate actual Player page decoder with ESP-IDF cJSON and bounded native memory."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
NATIVE = HERE / '../main/ui/habitat'
JSON = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'
page = dict(request=0, offset=65, total=71, machines=4, rows=[dict(
    id=f'session-{i}', machineId=f'machine-{i % 4}', name='Session', engine='codex',
    status=['working', 'question', 'finished', 'paused', 'idle', 'offline'][i], ageSeconds=i * 3600
) for i in range(6)])
source = r'''
#include "pro_player_library.h"
#include <assert.h>
#include <stdio.h>
static pro_player_library_t state;
static void check(const char *json,bool valid) {
    cJSON *root=cJSON_Parse(json);assert(root);
    pro_player_library_t before=state;
    assert(pro_player_library_parse(root,&state)==valid);
    if(!valid)assert(!memcmp(&before,&state,sizeof state));
    else assert(state.count<=6 && sizeof state<2048);
    cJSON_Delete(root);
}
int main(void) {
'''

def case(value, valid):
    global source
    source += 'check(' + json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False) + ',' + str(valid).lower() + ');\n'

case(page, True)
case(dict(page, request=4294967295), True)
case(dict(page, total=0, offset=0, rows=[]), True)
case(dict(page, rows=page['rows'] * 2), False)
case(dict(page, rows=page['rows'][:-1]), False)
case(dict(page, offset=66), False)
for key in ['request', 'offset', 'total', 'machines']:
    for bad in [None, '6', {}, [], -1, 0.5, 1e100]:
        case(dict(page, **{key: bad}), False)
    missing = dict(page)
    missing.pop(key)
    case(missing, False)
for key, bad in [('id', ''), ('id', 'x' * 48), ('machineId', ''), ('machineId', 'm' * 48),
                 ('name', '生' * 32), ('status', 'unknown'), ('ageSeconds', -2),
                 ('ageSeconds', 1.5), ('ageSeconds', 315360001), ('engine', None)]:
    rows = [dict(r) for r in page['rows']]
    rows[0][key] = bad
    case(dict(page, rows=rows), False)
rows = [dict(r) for r in page['rows']]
rows[1]['id'] = rows[0]['id']
case(dict(page, rows=rows), False)
rows = [dict(r) for r in page['rows']]
rows[0].update(name='生' * 31, ageSeconds=-1, status='failed')
case(dict(page, rows=rows), True)
source += 'puts("Player page decoder: bounds, UTF-8, identities, malformed pages and atomic rejection passed");}\n'
with tempfile.TemporaryDirectory(prefix='harness-player-library-') as folder:
    out = Path(folder)
    (out / 'test.c').write_text(source)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
                    '-O1', '-g', '-fsanitize=undefined,bounds', '-I', str(NATIVE), '-I', str(JSON),
                    str(out / 'test.c'), str(JSON / 'cJSON.c'), '-o', str(out / 'test')], check=True)
    subprocess.run([str(out / 'test')], check=True)
