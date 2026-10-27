"""Today's route as a baseline. Each task is routed when it becomes ready (its dependencies are done) and takes the
first candidate of cli/src/superTabs/route.ts `choose`: candidates at the floor (or, with none, the best below it),
only the strongest for a hard task, those whose quota fits before the unknown and the short, then `compare`'s order:
effective cost, strength, a machine's own engine before a shared API, room on the tightest window, and title.
Effective cost is `sizeUp`'s: a 5-hour window that resets before the task is over makes its unused part free, and a
task that is not hard pays for taking more than a day's share of the weekly window. The quota is read at that moment:
work that has run since the plan began has used it, open picks hold the rest of theirs, and a 5-hour window refills at
its reset. Then the task starts as early as its machine's slots and its model's limit allow, which is how the Swarm
starts work it has routed; the route itself does not look at slots.

Left out from the route: owner rules and members (the converter applies the owner's machine rule to every plan, and
every pick here is a new agent). A review leaves out the family its build was given, as the Lead asks the route for.
"""
import heapq
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .instance import Account, Instance, Option, Task, Window, duration, options
from .solver import Placement, Result, task_cost

Assignment = Dict[str, Tuple[str, str]]
# Minutes between refills; the route's windows (route.ts WINDOWS).
PERIOD = {'5-hour': 300, 'weekly': 7 * 1440}
STATUSES = ('fits', 'unknown', 'short')


def _ordered(instance: Instance) -> List[Task]:
    """Instance order, with each task after the tasks it depends on."""
    done, out = set(), []

    def visit(t: Task) -> None:
        if t.id in done:
            return
        done.add(t.id)
        for dep in t.deps:
            visit(instance.task(dep))
        out.append(t)

    for t in instance.tasks:
        visit(t)
    return out


def _place(instance: Instance, plan: Dict[str, Placement], t: Task, machine_id: str, model_id: str, ready: int) -> Placement:
    """The earliest start at or after `ready` with a free slot on the machine and room on the model."""
    model = instance.model(model_id)
    length = duration(t, model)
    pool = instance.slot_pool(machine_id)
    same_machine = [p for p in plan.values() if instance.slot_pool(p.machine) == pool]
    same_model = [p for p in plan.values() if p.model == model_id]

    def free(start: int) -> bool:
        end = start + length
        # Usage only rises at a start, so checking each start inside the window (and the window's own) is enough.
        for group, limit in ((same_machine, instance.pool_slots(pool)), (same_model, model.concurrency)):
            if limit is None:
                continue
            for s in [start] + [p.start for p in group if start < p.start < end]:
                if sum(1 for p in group if p.start <= s < p.end) >= limit:
                    return False
        return True

    candidates = sorted({ready} | {p.end for p in plan.values() if p.end > ready})
    start = next(s for s in candidates if free(s))
    return Placement(task=t.id, machine=machine_id, model=model_id, start=start, end=start + length)


def _result(instance: Instance, plan: Dict[str, Placement]) -> Result:
    placements = sorted(plan.values(), key=lambda p: (p.start, p.task))
    cost = sum(task_cost(instance, Option(p.task, p.machine, p.model, p.end - p.start)) for p in placements)
    return Result(status='EVALUATED', makespan=max((p.end for p in placements), default=0), cost=cost, plan=placements)


def evaluate(instance: Instance, assignment: Assignment) -> Result:
    """Start each task of a fixed assignment as early as possible, in instance order."""
    plan: Dict[str, Placement] = {}
    for t in _ordered(instance):
        ready = max((plan[d].end for d in t.deps), default=0)
        plan[t.id] = _place(instance, plan, t, *assignment[t.id], ready)
    return _result(instance, plan)


@dataclass(frozen=True)
class Decision:
    """A routed task: when it was routed, and when it runs."""
    task: Task
    machine: str
    model: str
    at: int
    start: int
    end: int


@dataclass(frozen=True)
class Measured:
    name: str
    usable: float
    needed: float
    resets_in: Optional[int]

    @property
    def ratio(self) -> float:
        return self.usable / self.needed if self.needed else math.inf


@dataclass(frozen=True)
class Sized:
    status: str
    coverage: Optional[float]
    effective_cost: float
    tight: Optional[float]


def _spend(instance: Instance, task: Task, model_id: str, window: str) -> float:
    """route.ts: the size table's spend is for policy cost 2 and grows with the model's cost."""
    return task.spend.get(window, 0.0) * instance.model(model_id).cost / 2


def _reading(instance: Instance, window: Window, mine: List[Decision], now: int) -> Tuple[float, Optional[int]]:
    """What the window would read at `now`: its reading at the start, or full again after a reset, less what work on the
    account has used since; and the minutes to its next reset."""
    left, since, reset = window.left, 0, window.resets_in
    period = PERIOD.get(window.name)
    if reset is not None and period and now >= reset:
        passed = (now - reset) // period + 1
        since, reset, left = reset + (passed - 1) * period, reset + passed * period, 100.0
    used = 0.0
    for d in mine:
        overlap = max(0, min(d.end, now) - max(d.start, since))
        if overlap:
            used += _spend(instance, d.task, d.model, window.name) * overlap / (d.end - d.start)
    return left - used, None if reset is None else max(1, reset - now)


def size_up(instance: Instance, task: Task, option: Option, now: int, decisions: List[Decision]) -> Sized:
    """route.ts `sizeUp`: how the candidate's account would carry the task, and its effective cost."""
    model = instance.model(option.model)
    if not model.subscription:
        return Sized('fits', None, float(model.cost), None)
    account: Optional[Account] = instance.account_of(option.machine, model)
    if account is None:
        return Sized('unknown', None, float(model.cost), None)
    mine = [d for d in decisions if instance.account_of(d.machine, instance.model(d.model)) == account]
    run = task.minutes
    measured = []
    for name in PERIOD:
        window = next((w for w in account.windows if w.name == name), None)
        if window is None:
            continue
        left, resets_in = _reading(instance, window, mine, now)
        # Picks still at work hold what they were expected to spend, less the part of their run time already over.
        committed = sum(_spend(instance, d.task, d.model, name) * max(0.0, 1 - (now - d.at) / d.task.minutes) for d in mine)
        spend = _spend(instance, task, option.model, name)
        # A window that refills mid-task carries only the part of the task before its reset.
        needed = spend * resets_in / run if resets_in is not None and resets_in < run else spend
        measured.append(Measured(name, left - account.reserve - committed, needed, resets_in))
    complete = len(measured) == len(PERIOD) or (model.engine == 'codex' and [m.name for m in measured] == ['weekly'])
    status = 'short' if any(m.usable < m.needed for m in measured) else 'fits' if complete else 'unknown'
    tight = min(measured, key=lambda m: m.ratio) if measured else None
    five = next((m for m in measured if m.name == '5-hour'), None)
    week = next((m for m in measured if m.name == 'weekly'), None)
    expiring = 0.0
    if five and five.resets_in is not None and five.resets_in <= run + 60 and five.needed:
        expiring = min(1.0, max(0.0, five.usable) / five.needed)
    effective = model.cost * (1 - expiring)
    if week:
        day_budget = week.usable / max(1.0, (week.resets_in or 0) / 1440)
        if task.difficulty != 'high' and day_budget > 0 and week.needed > day_budget:
            effective += model.cost * week.needed / day_budget
    coverage = None if tight is None else round(tight.ratio, 2)
    return Sized(status, coverage, round(effective, 2), None if tight is None else tight.usable)


def route_pick(instance: Instance, task: Task, now: int, decisions: List[Decision], assignment: Assignment) -> Optional[Option]:
    """route.ts `choose` and `decide` for one task routed at `now`."""
    taken = {instance.model(assignment[other][1]).family for other in task.independent_of if other in assignment}
    viable = [o for o in options(instance, task, floor=False) if instance.model(o.model).family not in taken]
    meeting = [o for o in viable if instance.model(o.model).quality_for(task.kind) >= task.floor]
    opts = meeting or viable
    if not opts:
        return None
    if task.difficulty == 'high':
        top = max(instance.model(o.model).quality_for(task.kind) for o in opts)
        opts = [o for o in opts if instance.model(o.model).quality_for(task.kind) == top]
    sized = {o: size_up(instance, task, o, now, decisions) for o in opts}
    status = next(s for s in STATUSES if any(z.status == s for z in sized.values()))
    shown = [o for o in opts if sized[o].status == status]

    def order(o: Option):
        model, z = instance.model(o.model), sized[o]
        first = (-(z.coverage or 0.0),) if status == 'short' else ()
        return first + (z.effective_cost, -model.quality_for(task.kind), 1 if model.remote else 0,
                        -(z.tight if z.tight is not None else -math.inf), f'{model.label} · {instance.machine(o.machine).name}')

    return min(shown, key=order)


def greedy(instance: Instance) -> Result:
    waiting = {t.id: len(t.deps) for t in instance.tasks}
    index = {t.id: i for i, t in enumerate(instance.tasks)}
    dependents: Dict[str, List[str]] = {t.id: [] for t in instance.tasks}
    for t in instance.tasks:
        for dep in t.deps:
            dependents[dep].append(t.id)
    ready = [(0, index[t.id], t.id) for t in instance.tasks if not t.deps]
    heapq.heapify(ready)
    plan: Dict[str, Placement] = {}
    decisions: List[Decision] = []
    assignment: Assignment = {}
    while ready:
        now, _, tid = heapq.heappop(ready)
        t = instance.task(tid)
        pick = route_pick(instance, t, now, decisions, assignment)
        if pick is None:
            return Result(status='INFEASIBLE', reason=f'no machine and model can run: {t.id}')
        placed = _place(instance, plan, t, pick.machine, pick.model, now)
        plan[tid], assignment[tid] = placed, (pick.machine, pick.model)
        decisions.append(Decision(t, pick.machine, pick.model, now, placed.start, placed.end))
        for nxt in dependents[tid]:
            waiting[nxt] -= 1
            if not waiting[nxt]:
                heapq.heappush(ready, (max(plan[d].end for d in instance.task(nxt).deps), index[nxt], nxt))
    return _result(instance, plan)
