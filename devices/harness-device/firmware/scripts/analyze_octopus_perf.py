#!/usr/bin/env python3
"""Validate and summarize the event-tagged octopus ABBA device benchmark."""
import argparse
from pathlib import Path
import re,json,math,hashlib,collections
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('log', type=Path)
parser.add_argument('output', type=Path)
args=parser.parse_args()
raw=args.log.read_text(errors='replace')
raw=re.sub(r'\x1b\[[0-9;]*m','',raw)
lines=raw.splitlines()
def kv(s):
    d=dict(re.findall(r'(\w+)=([^\s]+)',s))
    return {k:int(v) if re.fullmatch(r'-?\d+',v) else v for k,v in d.items()}
def pct(xs,p):
    return sorted(xs)[min(len(xs)-1,math.floor(len(xs)*p))] if xs else None
samples=[kv(l) for l in lines if 'OCTO_PERF: sample ' in l]
result={'protocol':'octopus27-abba-v1','metric':'request to final SPI DMA completion of matching scene; not finger-to-photon',
    'body_modes':'same image; ABBA=frozen,animated,animated,frozen; touch/blink/mic reactions retained in both',
    'sample_count':len(samples),'samples':samples,'cases':{},
    'ambient':[kv(l) for l in lines if 'OCTO_PERF: ambient ' in l],
    'memory':[kv(l) for l in lines if 'OCTO_PERF: memory ' in l],
    'touch':[kv(l) for l in lines if 'OCTO_PERF: touch ' in l],
    'complete':any('END completed=960' in l for l in lines)}
for key in ('working_count','agent_switch','agent_burst16','recap_open','question_update','touch_feedback'):
    result['cases'][key]={}
    for animate in (0,1):
        ss=[s for s in samples if s['case']==key and s['animate']==animate]
        if not ss: continue
        values={metric:{'p50':pct([s[metric] for s in ss],.5),'p95':pct([s[metric] for s in ss],.95),'max':max(s[metric] for s in ss)} for metric in ('dma_us','api_us','bytes','model_us','damage_us','raster_us','paint_us')}
        values['n']=len(ss);values['no_frame']=sum(not s['bytes'] for s in ss);values['mismatched']=sum(not s['matches'] for s in ss)
        result['cases'][key]['animated' if animate else 'frozen']=values
    a=result['cases'][key]
    if all(k in a for k in ('animated','frozen')):
        a['added_median_us']=a['animated']['dma_us']['p50']-a['frozen']['dma_us']['p50']
        a['added_p95_us']=a['animated']['dma_us']['p95']-a['frozen']['dma_us']['p95']
audio=[]; context=None
for line in lines:
    if 'OCTO_PERF: audio_begin ' in line: context=kv(line)
    if 'AUDIO_PERF: case=' in line: audio.append({**(context or {}),**kv(line)})
    if 'OCTO_PERF: audio_end ' in line: context=None
result['audio']=audio
result['log_sha256']=hashlib.sha256(args.log.read_bytes()).hexdigest()
args.output.write_text(json.dumps(result,indent=2)+'\n')
for key,d in result['cases'].items():
    print(key, {mode:(v['n'],v['dma_us']) for mode,v in d.items() if isinstance(v,dict)})
print('complete',result['complete'],'samples',len(samples))
print('ambient',result['ambient'])
print('audio',audio)
if result['complete']:
    assert len(samples)==960
    assert all(s['bytes']>0 and s['matches']==1 for s in samples)
    assert len({(s['round'],s['case'],s['i']) for s in samples})==960
    assert all(v['n']==80 for c in result['cases'].values() for v in c.values() if isinstance(v,dict))
    assert all(s['presses']==0 for s in result['touch'])
    assert len(audio)==4 and all(s['produced']==s['delivered'] and s['rx_overruns']==0 and not s['aborted'] for s in audio)

if not result['complete']:
    raise SystemExit('Incomplete capture: no successful END marker.')
