"""Today's route as a baseline: each task, in the order it was routed, takes the first candidate in the route's policy
order (cli/src/superTabs/route.ts `choose`), without looking at the queue; then every task starts as early as its
dependencies, its machine's slots and its model's limit allow, which is how the Swarm starts work it has routed.

Simplified from the route: no owner rules or members (every pick is a new agent), and an account short for every
candidate falls back to the policy order instead of the one expected to get furthest.
"""
import math
from typing import Dict, List, Optional, Tuple

from .instance import Instance, Option, Task, duration, options
from .solver import Placement, Result, quota_use, task_cost

Assignment = Dict[str, Tuple[str, str]]


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


def evaluate(instance: Instance, assignment: Assignment) -> Result:
    """Start each task of a fixed assignment as early as possible, in instance order."""
    plan: Dict[str, Placement] = {}
    for t in _ordered(instance):
        machine_id, model_id = assignment[t.id]
        model, machine = instance.model(model_id), instance.machine(machine_id)
        length = duration(t, model)
        ready = max((plan[d].end for d in t.deps), default=0)
        same_machine = [p for p in plan.values() if p.machine == machine_id]
        same_model = [p for p in plan.values() if p.model == model_id]

        def free(start: int) -> bool:
            end = start + length
            # Usage only rises at a start, so checking each start inside the window (and the window's own) is enough.
            for group, limit in ((same_machine, machine.slots), (same_model, model.concurrency)):
                if limit is None:
                    continue
                for s in [start] + [p.start for p in group if start < p.start < end]:
                    if sum(1 for p in group if p.start <= s < p.end) >= limit:
                        return False
            return True

        candidates = sorted({ready} | {p.end for p in plan.values() if p.end > ready})
        start = next(s for s in candidates if free(s))
        plan[t.id] = Placement(task=t.id, machine=machine_id, model=model_id, start=start, end=start + length)
    placements = sorted(plan.values(), key=lambda p: (p.start, p.task))
    cost = sum(task_cost(instance, Option(p.task, p.machine, p.model, p.end - p.start)) for p in placements)
    return Result(status='EVALUATED', makespan=max((p.end for p in placements), default=0), cost=cost, plan=placements)


def route_pick(instance: Instance, task: Task, committed: Dict[str, Dict[str, int]], assignment: Assignment) -> Optional[Option]:
    """The route's pick for one task, given what earlier picks already take from each account. A review leaves out the
    family its build was given, as the Lead asks the route for one by naming the other family."""
    taken = {instance.model(assignment[other][1]).family for other in task.independent_of if other in assignment}
    opts = [o for o in options(instance, task) if instance.model(o.model).family not in taken]
    if not opts:
        return None
    if task.difficulty == 'high':
        top = max(instance.model(o.model).quality_for(task.kind) for o in opts)
        opts = [o for o in opts if instance.model(o.model).quality_for(task.kind) == top]

    def fit(o: Option) -> Tuple[str, float]:
        """`fits`, `unknown` or `short`, and the room left on the tightest window afterwards."""
        model = instance.model(o.model)
        if not model.subscription:
            return 'fits', -math.inf
        account = instance.account_of(o.machine, model)
        if account is None:
            return 'unknown', -math.inf
        room = math.inf
        for window, left in account.budget.items():
            usable = left * 100 - committed.get(account.id, {}).get(window, 0)
            if usable < quota_use(instance, o, window):
                return 'short', usable
            room = min(room, usable)
        return 'fits', room

    fits = {o: fit(o) for o in opts}
    status = next(s for s in ('fits', 'unknown', 'short') if any(f[0] == s for f in fits.values()))
    shown = [o for o in opts if fits[o][0] == status]
    shown.sort(key=lambda o: (instance.model(o.model).cost, -instance.model(o.model).quality_for(task.kind), -fits[o][1],
                              instance.machine(o.machine).name, o.model))
    return shown[0]


def greedy(instance: Instance) -> Result:
    committed: Dict[str, Dict[str, int]] = {}
    assignment: Assignment = {}
    for t in _ordered(instance):
        pick = route_pick(instance, t, committed, assignment)
        if pick is None:
            return Result(status='INFEASIBLE', reason=f'no machine and model meet the floor of: {t.id}')
        assignment[t.id] = (pick.machine, pick.model)
        account = instance.account_of(pick.machine, instance.model(pick.model))
        if account is not None:
            for window in account.budget:
                spent = committed.setdefault(account.id, {})
                spent[window] = spent.get(window, 0) + quota_use(instance, pick, window)
    return evaluate(instance, assignment)
