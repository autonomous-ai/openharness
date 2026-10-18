"""Which gate limited the pilot, read from its own record (UTC). See 14-which-gate.md.

Needs the pilot's data pulled with gh into data/ (kept out of the repo): prs/f5_rows.json (each PR's ready,
first-review and merge times) and issues/705_comments.json (the queue thread). The device words the pilot
used are read from data/device_words.txt, one regex alternative per line, so its names stay out of the repo.
"""
import json, re, collections, statistics as st, datetime as dt
D = 'data/'
T = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None
prs = [r for r in json.load(open(D + 'prs/f5_rows.json'))]
for r in prs:
    for k in ('created', 'ready', 'first_rv', 'merged'): r[k] = T(r[k])
com = json.load(open(D + 'issues/705_comments.json'))
rx = re.compile(r"(list (is|was|now) (empty|done)|nothing (else )?(in my list|I can do|left (in my list|that I can)|to do)|my list (now )?waits on others|list waits on others|please (fill|give me)|ready for (the |my )?next task|ready for more|I can take more|room for (a new|more|another) task|need(s)? (a|the) next task|list has nothing|out of tasks|no task(s)? (left|I can)|what('s| is) next for me|waiting for (a|my) (next )?task|my queue is empty)", re.I)
# builders' reports only: the lead ("First", the first builder) dispatches and isn't counted, as in 04
empty = [(T(c['created_at']), c['body']) for c in com if rx.search(c.get('body') or '')
         and not re.match(r"\W*first\b", (c.get('body') or '').strip(), re.I)]
start = dt.datetime(2026, 10, 14, 10, tzinfo=dt.timezone.utc)
end = max(r['merged'] for r in prs if r['merged'])

def at(t):
    """State of the review pipeline at time t."""
    waiting_first = sum(1 for r in prs if r['ready'] and r['ready'] <= t and (r['first_rv'] is None or r['first_rv'] > t) and (r['merged'] is None or r['merged'] > t))
    ready_unmerged = sum(1 for r in prs if r['ready'] and r['ready'] <= t and (r['merged'] is None or r['merged'] > t) and r['state'] != 'CLOSED')
    return waiting_first, ready_unmerged

print(f"PRs {len(prs)}, merged {sum(1 for r in prs if r['merged'])}, empty-list reports {len(empty)}, window {start:%m-%d %H:%M} – {end:%m-%d %H:%M} UTC")

# 1. When a builder said its list was empty, how much work was stuck in review?
snap = [at(t) for t, _ in empty]
hours = []
t = start
while t < end:
    hours.append(t); t += dt.timedelta(minutes=30)
base = [at(h) for h in hours]
def q(v, p): v = sorted(v); return v[int(p * (len(v) - 1))]
print("\n1. Review queue at the moment of an empty-list report vs at all times")
for name, v in (("empty-list moments", snap), ("all half-hours", base)):
    wf = [a for a, b in v]; ru = [b for a, b in v]
    print(f"  {name:20s} waiting first review p50 {q(wf,.5)} p90 {q(wf,.9)} · ready but unmerged p50 {q(ru,.5)} p90 {q(ru,.9)}")
print(f"  share of empty-list moments with ≥10 PRs ready but unmerged: {sum(1 for a,b in snap if b>=10)/len(snap):.0%}")

# 2. Why the list was empty, in the builders' own words
cats = collections.Counter()
why = {'review or merge': r"review|merge|P[123]\b|rebase", 'device': '|'.join(['device', 'hands'] + [w.strip() for w in open(D + 'device_words.txt') if w.strip()]), 'owner or person': r"owner|decision|key|my person|sudo|ssh", 'CI': r"ARM64|CI\b|run \d|runner"}
for _, b in empty:
    hit = [k for k, p in why.items() if re.search(p, b, re.I)]
    for k in hit: cats[k] += 1
    if not hit: cats['no reason given'] += 1
print("\n2. What the empty-list reports say they wait on (a report can name several):", dict(cats.most_common()))

# 3. Merges per hour, and how it moved with the review gate
def merges(a, b): return sum(1 for r in prs if r['merged'] and a <= r['merged'] < b)
def first_review_wait(a, b):
    w = [(r['first_rv'] - r['ready']).total_seconds() / 60 for r in prs if r['ready'] and r['first_rv'] and a <= r['ready'] < b]
    return (st.median(w), q(w, .9), len(w)) if w else (float('nan'),) * 3
def builders(a, b):
    names = set()
    for c in com:
        t = T(c['created_at'])
        if a <= t < b:
            m = re.match(r"\**([A-Z][a-z]+)\b", (c.get('body') or '').strip())
            if m: names.add(m.group(1).lower())
    return len(names)
peer = dt.datetime(2026, 10, 16, 7, 5, tzinfo=dt.timezone.utc)   # "peer reviews unblock merges", 14:05 +07
H = dt.timedelta(hours=1)
print("\n3. Before and after peer reviews (12 h each side)")
for name, a, b in (("before", peer - 12 * H, peer), ("after", peer, peer + 12 * H)):
    m50, m90, n = first_review_wait(a, b)
    print(f"  {name:6s} merges/h {merges(a,b)/12:.1f} · ready→first review p50 {m50:.0f} min p90 {m90:.0f} (n={n}) · agents posting {builders(a,b)}")

# 4. Usage-limit windows on the gatekeepers' account (UTC)
outs = [("16 Oct 11:27–13:51", dt.datetime(2026,10,16,11,27), dt.datetime(2026,10,16,13,51)),
        ("16 Oct 17:12–18:42", dt.datetime(2026,10,16,17,12), dt.datetime(2026,10,16,18,42)),
        ("17 Oct 03:27–04:43", dt.datetime(2026,10,17,3,27), dt.datetime(2026,10,17,4,43))]
lead_blocked = ("lead blocked on the owner 16 Oct 20:14–23:40", dt.datetime(2026,10,16,20,14), dt.datetime(2026,10,16,23,40))
print("\n4. Gatekeepers out vs the same length of time just before")
for name, a, b in outs + [lead_blocked]:
    a = a.replace(tzinfo=dt.timezone.utc); b = b.replace(tzinfo=dt.timezone.utc); d = b - a
    e_in = sum(1 for t, _ in empty if a <= t < b); e_pre = sum(1 for t, _ in empty if a - d <= t < a)
    print(f"  {name:45s} merges/h during {merges(a,b)/(d.total_seconds()/3600):.1f} vs before {merges(a-d,a)/(d.total_seconds()/3600):.1f} · empty-list reports {e_in} vs {e_pre}")

# 5. Output against swarm size, by 6-hour block
print("\n5. Merges per hour against agents posting, 6-hour blocks")
t = start
while t + 6 * H <= end:
    print(f"  {t:%m-%d %H}h  agents {builders(t, t+6*H):2d}  merges/h {merges(t, t+6*H)/6:5.1f}  waiting first review (mid) {at(t+3*H)[0]:2d}  ready unmerged {at(t+3*H)[1]:2d}")
    t += 6 * H

# 6. The reporter's own work at the moment of each empty-list report (branches are named <builder>/<topic>)
names = {'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'nine', 'ten', 'eleven',
         'twelve', 'thirteen', 'el', 'tests', 'reviewer'} | {w.strip().lower() for w in open(D + 'builder_names.txt') if w.strip()}
own = []
for t, b in empty:
    m = re.match(r"\W*([A-Za-z]+)", b.strip()); n = m.group(1).lower() if m else ''
    if n not in names: continue
    mine = [r for r in prs if (r['head'] or '').lower().startswith(n + '/') and r['created'] <= t
            and (r['merged'] is None or r['merged'] > t) and r['state'] != 'CLOSED']
    own.append(sum(1 for r in mine if r['ready'] and r['ready'] <= t))
print(f"\n6. Reports by a known builder: {len(own)}; with ≥1 own PR ready and waiting review or merge: "
      f"{sum(1 for x in own if x >= 1)}; with ≥2: {sum(1 for x in own if x >= 2)}")

# 7. Hourly merges at full size, against the size of the queue
rows, t = [], dt.datetime(2026, 10, 16, 0, tzinfo=dt.timezone.utc)
while t + H <= end:
    rows.append((merges(t, t + H), at(t + H / 2)[1])); t += H
m = [x for x, _ in rows]
print(f"\n7. From 16 Oct 00:00 UTC, merges an hour: p50 {st.median(m)}, p90 {q(m, .9)}, max {max(m)} ({len(m)} hours); "
      f"hours with ≥20 ready-unmerged: p50 {st.median([x for x, r in rows if r >= 20])}, "
      f"with fewer: p50 {st.median([x for x, r in rows if r < 20])}")
