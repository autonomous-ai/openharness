"""Replay frames emitted by a built bridge through the C parser, handlers and renderer.

Only the four turn/result handlers are selected from production here. This does
not claim coverage of the whole cable dispatcher, physical USB, or the display.
"""
import json
import re
from pathlib import Path


def instrument(code, trace_file, main):
    traces = json.loads(Path(trace_file).read_text())
    assert {t['id'] for t in traces} >= {'codex-working', 'claude-activity', 'completed', 'next-turn'}
    start = code.index('typedef struct cJSON {')
    end = code.index('static action_t pressed_action;', start)
    code = code[:start] + '#include "cJSON.h"\nenum { JSTRING=cJSON_String,JTRUE=cJSON_True };\n' + code[end:]
    cable = (main / 'cable_client.c').read_text()

    def function(name):
        match = re.search(r'^[^\n]*\b' + name + r'\([^;]*?\)\n\{.*?^\}', cable, re.M | re.S)
        assert match, name
        return match.group(0) + '\n'

    handler = function('handle_message')
    prefix = handler[:handler.index('    if (strcmp(t, "welcome")')]
    identity = handler[handler.index('    const char *agent_id ='):handler.index('    if (strcmp(t, "focus")')]
    events = handler[handler.index('    if (strcmp(t, "turn.started")'):handler.index('    // The WINDOW looked')]
    extra = r'''
#include "cJSON.h"
#include "cable_frame.h"
#include "cable_json_guard.h"
#define DEVICE_HABITAT 1
static int64_t s_last_rx_us;
static uint32_t s_bad, s_unknown;
static int64_t esp_timer_get_time(void) { return (int64_t)fake_ms * 1000 + 1; }
static void fw_update_slice(const uint8_t *p, size_t n) { (void)p; (void)n; assert(!"Unexpected firmware write in replay"); }
static void audio_notify_done(void) {} // no real speaker or audio hardware in this harness
'''
    extra += function('str_of') + function('bool_of')
    extra += prefix + identity + events + '    assert(!"Unexpected message in turn/result replay");\n}\n'
    extra += function('on_frame')
    extra += '\nstatic void bridge_flow_checks(void) {\n'
    for i, trace in enumerate(traces):
        assert trace['frames']
        raw = bytes.fromhex(''.join(trace['frames']))
        assert 0 < len(raw) <= 65536
        wanted = trace['expect']
        extra += '{\nstatic const uint8_t bytes[]={' + ','.join(str(x) for x in raw) + '};\n'
        extra += 'static const size_t chunks[]={1,7,512,8200};\n'
        extra += 'for(unsigned c=0;c<4;c++) {\nreset();s_bad=s_unknown=0;fake_ms=1000;\n'
        extra += 'cable_decoder_t decoder;cable_decoder_init(&decoder);\n'
        extra += 'for(size_t at=0;at<sizeof bytes;at+=chunks[c]) {size_t n=sizeof bytes-at;if(n>chunks[c])n=chunks[c];cable_decoder_feed(&decoder,bytes+at,n,on_frame,NULL);}\n'
        extra += 'assert(!decoder.corrupt_frames && !decoder.discarded_bytes && !s_bad && !s_unknown && s_last_rx_us);scene_take();\n'
        extra += f'assert(active()->busy=={str(wanted["busy"]).lower()});assert(result_visible()=={str(wanted["recap"]).lower()});\n'
        extra += 'assert(!strcmp(active()->tool,' + json.dumps(wanted['status']) + '));\n'
        extra += 'assert(title_is(active()->name));char bell[24];unsigned unread=notice_unread(active()?active()->id:NULL);if(unread)snprintf(bell,sizeof bell,HT_BELL \" %u\",unread);else bell[0]=0;assert(status_is(bell));\n'
        display_status = wanted.get('display_status', wanted['status'])
        if display_status:
            extra += 'fake_ms+=3400;surface_tick(fake_ms);scene_take();\n'
            extra += 'bool found=false;for(int r=0;r<scene.count;r++) if(scene.runs[r].arc==1 && !strcmp(scene.runs[r].text,' + json.dumps(display_status) + ')) {assert(scene.runs[r].fg==FG);found=true;}assert(found);\n'
        extra += 'uint16_t pixels[466],bg=(uint16_t)((scene.background<<8)|(scene.background>>8));unsigned ink=0;uint32_t hash=2166136261u;for(int y=0;y<466;y++) {ht_raster(&scene,(ht_rect_t){0,y,466,1},pixels);for(int x=0;x<466;x++){ink+=pixels[x]!=bg;hash=(hash^pixels[x])*16777619u;}}assert(ink>100 && ink<466*466/2);\n'
        extra += 'if(c==0){printf("bridge flow: %s rendered hash=%08x ink=%u PASS\\n",' + json.dumps(trace['id']) + ',hash,ink);const char *dir=getenv("HABITAT_PREVIEW_DIR");if(dir)portrait(dir,' + json.dumps('bridge-' + trace['id']) + ');}\n'
        extra += '}\n}\n'
    extra += 'reset();puts("Built bridge -> framed bytes -> production C JSON/turn handlers -> scene/raster PASS");\n}\n'
    marker = 'int main(int argc, char **argv) {'
    assert code.count(marker) == 1
    return code.replace(marker, extra + marker + '\n    bridge_flow_checks();\n')
