"""Counts the frames a Harness Desktop log received, by type.

Usage: python3 -I scripts/desktop-frame-count.py ~/.harness/logs/app-YYYYMMDD.log

Reads lines like `[YYYY-MM-DD HH:MM:SS] DEBUG ws      ↓ <type> {...}` and prints the window, the total of received
(↓) frames and, per type, its count, share and logged bytes (values in the log are cut, so bytes understate large
payloads). Measures docs/plans/2026-10-31-live-events-relay-design.md before and after.
"""
import re, sys, collections
path=sys.argv[1]
cnt=collections.Counter(); byt=collections.Counter(); dirs=collections.Counter()
rx=re.compile(r'^\[(\S+ \S+)\] DEBUG ws\s+(\S)\s+([a-z_]+)\s?(.*)$')
first=last=None
with open(path,'rb') as f:
    for raw in f:
        line=raw.decode('utf-8','replace').rstrip('\n')
        m=rx.match(line)
        if not m: continue
        ts,d,t,rest=m.groups()
        dirs[d]+=1
        if d!='↓': continue
        first=first or ts; last=ts
        cnt[t]+=1; byt[t]+=len(rest.encode())
tot=sum(cnt.values()); totb=sum(byt.values())
print('window',first,'->',last,'| directions',dict(dirs))
print('received frames',tot,'logged bytes(truncated)',totb)
for t,c in cnt.most_common(25): print(f'{c:8d} {100*c/tot:5.1f}%  {byt[t]:10d}B  {t}')
