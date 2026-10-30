"""A swarm as a queueing network, calibrated to the pilot (Oct 15-17, 2026).

Builders build, CI checks, a reviewer pool reviews, the lead dispatches and checks hand-backs on the
integration device. Gatekeepers stop during usage-limit windows. Shows shape, not precise numbers.
Usage: python3 capacity_sim.py  (prints the tables behind 14-which-gate.md §4)
"""
import heapq, math, random, statistics as st

DAY = 24 * 60

def lognormal(rng, median, sigma):
    return median * math.exp(sigma * rng.gauss(0, 1))

class Sim:
    def __init__(self, seed, builders=13, runners=20, reviewers=1, pull=False, separate_subs=False,
                 lead_never_blocks=False, days=6, review_min=4.0, handback=0.19, build_min=45):
        self.rng = random.Random(seed)
        self.n, self.runners, self.reviewers = builders, runners, reviewers
        self.pull, self.separate, self.never_blocks = pull, separate_subs, lead_never_blocks
        self.days, self.review_min, self.handback, self.build_min = days, review_min, handback, build_min
        self.t, self.q, self.seq = 0.0, [], 0
        self.free_runners, self.ci_queue = runners, []
        self.free_reviewers, self.review_queue = reviewers, []
        self.lead_busy, self.lead_queue = False, []
        self.out = {'lead': [], 'review': []}   # outage windows (start, end)
        self.merged, self.waits, self.dispatch_wait = [], [], 0.0
        self.busy = {'runner': 0.0, 'reviewer': 0.0, 'lead': 0.0}
        self.builders = [{'fixes': [], 'inflight': 0, 'free': True, 'asking': False, 'ready': False} for _ in range(builders)]
        self.make_outages()

    # --- outages: usage-limit windows on the account carrying the gatekeepers, and the lead blocked on the owner
    def make_outages(self):
        rng, horizon = self.rng, self.days * DAY
        def windows(rate_per_day, lo, hi):
            w, t = [], 0.0
            while True:
                t += rng.expovariate(rate_per_day / DAY)
                if t > horizon: return w
                w.append((t, t + rng.uniform(lo, hi)))
        shared = windows(1.25, 72, 144)
        self.out['lead'] = list(shared)
        self.out['review'] = windows(1.25, 72, 144) if self.separate else list(shared)
        if not self.never_blocks:   # the lead waits on one question to the owner, some nights
            for d in range(self.days):
                if rng.random() < 0.35:
                    s = d * DAY + rng.uniform(60, 300)
                    self.out['lead'].append((s, s + rng.uniform(120, 240)))
        for k in self.out: self.out[k].sort()

    def available(self, who, t):
        """Earliest time >= t at which `who` is not inside an outage window."""
        for s, e in self.out[who]:
            if s <= t < e: t = e
        return t

    def at(self, t, fn, *a):
        self.seq += 1
        heapq.heappush(self.q, (t, self.seq, fn, a))

    def run(self):
        for b in range(self.n): self.at(self.rng.uniform(0, 30), self.builder_next, b)
        horizon = self.days * DAY
        while self.q:
            t, _, fn, a = heapq.heappop(self.q)
            if t > horizon: break
            self.t = t
            fn(*a)
        return self

    # --- builders: fixes first, then a task in hand, else ask for one (at most three PRs in flight)
    def builder_next(self, b):
        B = self.builders[b]
        if B['fixes']:
            pr = B['fixes'].pop(0)
            B['free'] = False
            self.at(self.t + lognormal(self.rng, 18, 0.5), self.pushed, b, pr)
        elif B['ready']:
            B['ready'], B['free'] = False, False
            self.at(self.t + lognormal(self.rng, self.build_min, 0.6), self.opened, b)
        elif B['inflight'] < 3 and not B['asking']:
            B['asking'], B['free'] = True, True
            if self.pull or self.rng.random() > 0.13:     # the next task is already in my list, or I pull it
                self.at(self.t + 1, self.task_arrived, b, self.t)
            else:                                          # list empty: ask the lead
                self.lead_queue.append(('dispatch', b, self.t))
                self.lead_kick()
        else:
            B['free'] = True

    def task_arrived(self, b, asked):
        B = self.builders[b]
        self.dispatch_wait += self.t - asked
        B['asking'], B['ready'] = False, True
        self.wake(b)

    def opened(self, b):
        pr = {'b': b, 'opened': self.t, 'round': 0}
        self.builders[b]['inflight'] += 1
        self.pushed(b, pr)

    def pushed(self, b, pr):
        self.ci_submit(pr)
        self.builders[b]['free'] = True
        self.builder_next(b)

    def wake(self, b):
        if self.builders[b]['free']: self.builder_next(b)

    # --- CI
    def ci_submit(self, pr, kind='pr'):
        self.ci_queue.append((pr, kind))
        if self.rng.random() < 0.35:                       # a newer push cancels an older run
            self.ci_queue.append((None, 'waste'))
        self.ci_kick()

    def ci_kick(self):
        while self.free_runners and self.ci_queue:
            pr, kind = self.ci_queue.pop(0)
            self.free_runners -= 1
            d = {'pr': lognormal(self.rng, 15, 0.2), 'waste': self.rng.uniform(2, 8),
                 'post': 15 if self.rng.random() < 0.4 else 2}[kind]
            self.busy['runner'] += d
            self.at(self.t + d, self.ci_done, pr, kind)

    def ci_done(self, pr, kind):
        self.free_runners += 1
        self.ci_kick()
        if kind != 'pr': return
        if self.rng.random() < 0.15:                       # red: back to the builder
            self.builders[pr['b']]['fixes'].append(pr); self.wake(pr['b'])
        else:
            self.review_queue.append(pr); self.review_kick()

    # --- review
    def review_kick(self):
        while self.free_reviewers and self.review_queue:
            start = self.available('review', self.t)
            if start > self.t:
                self.at(start, self.review_kick); return
            pr = self.review_queue.pop(0)
            self.free_reviewers -= 1
            d = lognormal(self.rng, self.review_min, 0.5)
            self.busy['reviewer'] += d
            self.at(self.t + d, self.reviewed, pr)

    def reviewed(self, pr):
        self.free_reviewers += 1
        self.review_kick()
        p_find = [0.55, 0.35, 0.2, 0.1, 0.05][min(pr['round'], 4)]
        pr['round'] += 1
        if self.rng.random() < p_find:
            self.builders[pr['b']]['fixes'].append(pr); self.wake(pr['b'])
        elif self.rng.random() < self.handback:            # needs the lead's minute on the integration device
            self.lead_queue.append(('handback', pr, self.t)); self.lead_kick()
        else:
            self.merge(pr)

    def merge(self, pr):
        self.merged.append(self.t)
        self.waits.append(self.t - pr['opened'])
        self.builders[pr['b']]['inflight'] -= 1
        self.ci_submit(None, 'post')
        self.wake(pr['b'])

    # --- the lead
    def lead_kick(self):
        if self.lead_busy or not self.lead_queue: return
        start = self.available('lead', self.t)
        if start > self.t:
            self.at(start, self.lead_kick); return
        kind, x, asked = self.lead_queue.pop(0)
        self.lead_busy = True
        if kind == 'dispatch':   # attention latency to an empty list (pilot: median 23 min), then 3 min of work
            d = 3.0
            self.at(self.t + d, self.lead_done)
            self.at(self.t + lognormal(self.rng, 20, 1.2), self.task_arrived, x, asked)
        else:
            d = lognormal(self.rng, 12, 0.4)
            self.at(self.t + d, self.lead_done)
            self.at(self.t + d, self.merge, x)
        self.busy['lead'] += d

    def lead_done(self):
        self.lead_busy = False
        self.lead_kick()

    def report(self):
        warm = DAY
        m = [t for t in self.merged if t >= warm]
        w = sorted(x for t, x in zip(self.merged, self.waits) if t >= warm)
        span = self.days * DAY - warm
        return {'merged_day': len(m) / (span / DAY),
                'wait_p50_h': w[len(w) // 2] / 60 if w else float('nan'),
                'wait_p90_h': w[int(len(w) * 0.9)] / 60 if w else float('nan'),
                'runner_util': self.busy['runner'] / (self.runners * self.days * DAY),
                'review_util': self.busy['reviewer'] / (self.reviewers * self.days * DAY),
                'lead_util': self.busy['lead'] / (self.days * DAY),
                'dispatch_wait_h_per_builder_day': self.dispatch_wait / 60 / self.n / self.days}

def avg(seeds=8, **kw):
    rs = [Sim(s, **kw).run().report() for s in range(seeds)]
    return {k: st.mean(r[k] for r in rs) for k in rs[0]}

def row(label, r):
    return (f"| {label} | {r['merged_day']:.0f} | {r['wait_p50_h']:.1f} h | {r['wait_p90_h']:.1f} h | "
            f"{r['review_util']*100:.0f}% | {r['runner_util']*100:.0f}% | {r['lead_util']*100:.0f}% | "
            f"{r['dispatch_wait_h_per_builder_day']*60:.0f} min |")

HEAD = ("| Scenario | Merged/day | PR wait p50 | p90 | Reviewers busy | Runners busy | Lead busy | Waiting for a task, per builder-day |\n"
        "|---|---|---|---|---|---|---|---|")

if __name__ == '__main__':
    print("## Calibration (13 builders, 20 runners): the pilot merged ~165 a day, PR wait p50 1.5 h\n" + HEAD)
    for bm, rv in ((45, 1), (60, 1), (60, 2), (70, 2)):
        print(row(f"build {bm} min, {rv} reviewer{'s' if rv > 1 else ''}", avg(builders=13, runners=20, reviewers=rv, build_min=bm)))
    exps = (("Baseline", {}), ("E1 pull", dict(pull=True)), ("E1 + E4 the lead never blocks", dict(pull=True, lead_never_blocks=True)),
            ("E1 + E4 + E2 separate subscriptions", dict(pull=True, lead_never_blocks=True, separate_subs=True)))
    for name, base in (("A: review binds (build 45 min, one reviewer)", dict(builders=13, runners=20, reviewers=1, build_min=45)),
                       ("B: review has slack (build 70 min, reviewer plus peer reviews ≈ two)", dict(builders=13, runners=20, reviewers=2, build_min=70))):
        print(f"\n## {name}\n" + HEAD)
        for label, kw in exps: print(row(label, avg(**base, **kw)))
        more = dict(base); more['reviewers'] += 1
        print(row("One more reviewer only", avg(**more)))
        print(row("E1–E4 and one more reviewer", avg(**more, pull=True, lead_never_blocks=True, separate_subs=True)))
    print("\n## Scaling, with E1–E4 (calibration B)\n" + HEAD)
    fixed = dict(pull=True, lead_never_blocks=True, separate_subs=True, build_min=70)
    for n, rv, rn, hb in ((13, 2, 20, .19), (30, 2, 20, .19), (30, 3, 8, .19), (30, 4, 40, .19), (45, 3, 20, .19),
                          (45, 4, 40, .19), (60, 6, 60, .19), (60, 6, 60, .05), (90, 9, 90, .05)):
        label = f"{n} builders · {rv} reviewers · {rn} runners" + (" · device checks off the lead" if hb < .19 else "")
        print(row(label, avg(seeds=6, builders=n, runners=rn, reviewers=rv, handback=hb, **fixed)))
