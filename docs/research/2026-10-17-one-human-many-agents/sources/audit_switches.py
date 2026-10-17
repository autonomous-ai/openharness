"""Merged is not on: the pilot's switch census, joined with when each switch's PR merged. See 15-merged-not-on.md.

Needs, kept out of the repo: data/census/switches.md (the pilot's own census, as of 17 Oct) and
data/pilot_prs.jsonl (PR metadata). Device words for the pilot are read from data/device_words.txt.
"""
import json, re, collections, statistics as st, datetime as dt
D = 'data/'
dev = '|'.join(['device', 'hands'] + [w.strip() for w in open(D + 'device_words.txt') if w.strip()])
prs = {r['number']: r for r in (json.loads(l) for l in open(D + 'pilot_prs.jsonl'))}
census_at = dt.datetime(2026, 10, 17, 8, 41, tzinfo=dt.timezone.utc)    # product column as of 17 Oct 15:41 +07
rows = []
for line in open(D + 'census/switches.md'):
    if not line.startswith('| ') or line.startswith('| Switch') or line.startswith('|---') or line.startswith('| |'): continue
    cells = [c.strip() for c in line.strip().strip('|').split('|')]
    if len(cells) < 8: continue
    name, values, unit4, product, added, check, proposed, why = cells[:8]
    rows.append(dict(name=name, added=added, check=check, proposed=proposed.lower(), why=why))
def kind(p):
    if 'already' in p or 'code default' in p or p.startswith('on (default)'): return 'on already'
    if p.startswith('off until') or ((p.startswith('unset') or 'once played' in p) and 'until' in p or 'once played' in p): return 'off until a check'
    if p.startswith('on'): return 'turn on now'
    if p.startswith('off'): return 'stays off'
    return 'a setting'
k = collections.Counter(kind(r['proposed']) for r in rows)
print(f"rows parsed {len(rows)}:", dict(k))

waiting = [r for r in rows if kind(r['proposed']) == 'off until a check']
# What the check needs, from the "off until …" text alone: every one needs the device; some need a person there too
needs = collections.Counter()
person = r"person|people|someone|voices?|accent|office|table|hand|by ear|owner|face|guest|talk|cut-in|busy|seat|night"
for r in waiting:
    t = r['proposed']
    if re.search(person, t, re.I): needs['the device with a person there'] += 1
    elif re.search(dev + r"|play|run|measur|heard|pass|check|tun|record", t, re.I): needs['a device run alone'] += 1
    else: needs['other'] += 1
print("what the 'off until' switches wait for:", dict(needs))
no_result = sum(1 for r in waiting if re.search(r"not on any|no .{0,20}result|unplayed|not yet|none yet|gives no|no (" + dev + ") run", r['check'] + ' ' + r['why'], re.I))
print(f"of those, never yet run on a device according to the census: {no_result}")

# Age: from the merge of the PR that added it to the census
def merged(added):
    m = re.search(r"#(\d+)", added)
    if not m: return None
    p = prs.get(int(m.group(1)))
    return dt.datetime.fromisoformat(p['mergedAt'].replace('Z', '+00:00')) if p and p.get('mergedAt') else None
ages = {kk: [] for kk in ('off until a check', 'on already')}
for r in rows:
    kk = kind(r['proposed'])
    if kk in ages and merged(r['added']): ages[kk].append((census_at - merged(r['added'])).total_seconds() / 3600)
for kk, v in ages.items():
    if v: print(f"{kk}: n={len(v)} with a PR date; hours since merge p50 {st.median(v):.0f}, p90 {sorted(v)[int(.9*(len(v)-1))]:.0f}, max {max(v):.0f}")
