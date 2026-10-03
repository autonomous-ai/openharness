"""The shipped cJSON identity parser, including hostile bounds and round trips."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

main = Path(__file__).resolve().parent / '../main'
source = (main / 'cable_client.c').read_text()
json_dir = Path(os.environ['IDF_PATH']) / 'components/json/cJSON'
def function(name):
    return re.search(r'^static [^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', source, re.M | re.S).group(0)

code = r'''
#include "cJSON.h"
#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef struct { char id[16],uid[65],name[25],version[4]; uint32_t seed; int8_t colour; uint8_t mark; } ui_companion_t;
'''
code += function('companion_parse') + '\n' + function('companion_json')
code += r'''
int main(void) {
    ui_companion_t input={.id="tim",.uid="tim_42",.name="Pip",.version="0.1",.seed=4294967295u,.colour=2,.mark=4}, decoded;
    cJSON *o=companion_json(&input);assert(o && companion_parse(o,&decoded));
    assert(decoded.seed==input.seed && decoded.mark==4 && !strcmp(decoded.name,"Pip"));
    const char *fields[]={"uid","name","version","seed","colour","mark"};
    const char *bad[]={"\"../bad\"","\"hello\\nworld\"","\"3.0\"","4294967296","6","5"};
    for(unsigned i=0;i<6;i++) {
        cJSON *copy=cJSON_Duplicate(o,true);assert(copy);
        assert(cJSON_ReplaceItemInObjectCaseSensitive(copy,fields[i],cJSON_Parse(bad[i])));
        assert(!companion_parse(copy,&decoded));cJSON_Delete(copy);
    }
    cJSON_SetNumberValue(cJSON_GetObjectItem(o,"seed"),INFINITY);assert(!companion_parse(o,&decoded));
    cJSON_GetObjectItem(o,"seed")->valuedouble=NAN;assert(!companion_parse(o,&decoded));
    cJSON_SetNumberValue(cJSON_GetObjectItem(o,"seed"),1.5);assert(!companion_parse(o,&decoded));
    assert(!companion_parse(NULL,&decoded));
    cJSON_Delete(o);
    puts("Companion protocol: bounded names, ids, stages, seeds, materials and round trip PASS");
}
'''
with tempfile.TemporaryDirectory(prefix='companion-protocol-') as directory:
    out = Path(directory)
    (out / 'test.c').write_text(code)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-O1', '-g',
        '-fsanitize='+os.environ.get('SANITIZERS','undefined,bounds'), '-I', str(json_dir),
        str(out/'test.c'), str(json_dir/'cJSON.c'), '-o', str(out/'test')], check=True)
    subprocess.run([str(out/'test')], check=True)
