"""The exact plan: CP-SAT places every task on one machine and model, then minimises finish time and, at that finish time,
cost. docs/plans/2026-10-27-swarm-scheduler.md has the formulation.

Cost is the model's policy cost times the task's estimate in minutes, so a large task on Opus costs 3 x 180.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ortools.sat.python import cp_model

from .instance import Instance, Option, options

STATUS = {cp_model.OPTIMAL: 'OPTIMAL', cp_model.FEASIBLE: 'FEASIBLE', cp_model.INFEASIBLE: 'INFEASIBLE',
          cp_model.MODEL_INVALID: 'MODEL_INVALID', cp_model.UNKNOWN: 'UNKNOWN'}
# Quota is in percent with two decimals, so constraints stay integral.
QUOTA_SCALE = 100


@dataclass(frozen=True)
class Placement:
    task: str
    machine: str
    model: str
    start: int
    end: int


@dataclass
class Result:
    status: str
    reason: str = ''
    makespan: Optional[int] = None
    cost: Optional[int] = None
    makespan_bound: Optional[int] = None
    cost_bound: Optional[int] = None
    gap: Optional[float] = None
    seconds: float = 0.0
    plan: List[Placement] = field(default_factory=list)


def task_cost(instance: Instance, option: Option) -> int:
    return instance.model(option.model).cost * instance.task(option.task).minutes


def quota_use(instance: Instance, option: Option, window: str) -> int:
    """What the option takes from its account's window, scaled: spend is given at cost 2 and grows with the model's cost."""
    spend = instance.task(option.task).spend.get(window, 0.0)
    return round(spend * instance.model(option.model).cost / 2 * QUOTA_SCALE)


class Formulation:
    """The constraints every plan obeys; objectives and caps are added by the caller."""

    def __init__(self, instance: Instance):
        self.instance = instance
        self.model = cp_model.CpModel()
        self.options: Dict[str, List[Option]] = {t.id: options(instance, t) for t in instance.tasks}
        self.missing = [t for t, opts in self.options.items() if not opts]
        if self.missing:
            return
        m = self.model
        horizon = sum(max(o.minutes for o in opts) for opts in self.options.values())
        self.start = {t.id: m.NewIntVar(0, horizon, f'start[{t.id}]') for t in instance.tasks}
        self.end = {t.id: m.NewIntVar(0, horizon, f'end[{t.id}]') for t in instance.tasks}
        self.pick: Dict[Option, cp_model.IntVar] = {}
        by_machine: Dict[str, list] = {}
        by_model: Dict[str, list] = {}
        for t in instance.tasks:
            picks = []
            for o in self.options[t.id]:
                x = m.NewBoolVar(f'x[{t.id},{o.machine},{o.model}]')
                interval = m.NewOptionalFixedSizeIntervalVar(self.start[t.id], o.minutes, x, f'run[{t.id},{o.machine},{o.model}]')
                m.Add(self.end[t.id] == self.start[t.id] + o.minutes).OnlyEnforceIf(x)
                self.pick[o] = x
                picks.append(x)
                by_machine.setdefault(instance.slot_pool(o.machine), []).append(interval)
                by_model.setdefault(o.model, []).append(interval)
            m.AddExactlyOne(picks)
            for dep in t.deps:
                m.Add(self.start[t.id] >= self.end[dep])
        for t in instance.tasks:
            for other in t.independent_of:
                for family in {k.family for k in instance.models}:
                    same = [x for o, x in self.pick.items() if o.task in (t.id, other) and instance.model(o.model).family == family]
                    if same:
                        m.Add(sum(same) <= 1)
        for pool, intervals in by_machine.items():
            slots = instance.pool_slots(pool)
            if slots < len(intervals):
                m.AddCumulative(intervals, [1] * len(intervals), slots)
        for kid, intervals in by_model.items():
            limit = instance.model(kid).concurrency
            if limit is not None and limit < len(intervals):
                m.AddCumulative(intervals, [1] * len(intervals), limit)
        for account in instance.accounts:
            for window, left in account.budget.items():
                terms = [(quota_use(instance, o, window), x) for o, x in self.pick.items()
                         if instance.account_of(o.machine, instance.model(o.model)) == account]
                terms = [(c, x) for c, x in terms if c > 0]
                if terms:
                    m.Add(sum(c * x for c, x in terms) <= max(0, int(left * QUOTA_SCALE)))
        self.makespan = m.NewIntVar(0, horizon, 'makespan')
        m.AddMaxEquality(self.makespan, list(self.end.values()))
        self.cost = sum(task_cost(instance, o) * x for o, x in self.pick.items())

    def plan(self, solver: cp_model.CpSolver) -> List[Placement]:
        out = []
        for o, x in self.pick.items():
            if solver.Value(x):
                out.append(Placement(task=o.task, machine=o.machine, model=o.model, start=solver.Value(self.start[o.task]),
                                     end=solver.Value(self.end[o.task])))
        return sorted(out, key=lambda p: (p.start, p.task))

    def hint(self, plan: List[Placement]) -> None:
        chosen = {(p.task, p.machine, p.model): p for p in plan}
        self.model.ClearHints()
        for o, x in self.pick.items():
            self.model.AddHint(x, (o.task, o.machine, o.model) in chosen)
        for p in plan:
            self.model.AddHint(self.start[p.task], p.start)


def _solver(seconds: float, workers: int) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.05, seconds)
    solver.parameters.num_search_workers = workers
    solver.parameters.random_seed = 1
    return solver


def _gap(value: int, bound: int) -> float:
    return 0.0 if value == bound else (value - bound) / max(1, abs(value))


def solve(instance: Instance, time_limit: float = 10.0, workers: int = 8, makespan_cap: Optional[int] = None,
          cost_cap: Optional[int] = None) -> Result:
    """Least finish time, then least cost at that finish time. Both phases share `time_limit`. `makespan_cap` and
    `cost_cap` bound the plan (for the Pareto set)."""
    began = time.monotonic()
    f = Formulation(instance)
    if f.missing:
        return Result(status='INFEASIBLE', reason=f'no machine and model meet the floor of: {", ".join(f.missing)}')
    if makespan_cap is not None:
        f.model.Add(f.makespan <= makespan_cap)
    if cost_cap is not None:
        f.model.Add(f.cost <= cost_cap)

    f.model.Minimize(f.makespan)
    first = _solver(time_limit, workers)
    status = first.Solve(f.model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        reason = 'no plan meets the quota, slot and dependency limits' if status == cp_model.INFEASIBLE else 'no plan found within the time limit'
        return Result(status=STATUS[status], reason=reason, seconds=time.monotonic() - began)
    makespan = int(first.ObjectiveValue())
    makespan_bound = int(first.BestObjectiveBound())
    plan = f.plan(first)

    # Second phase: hold the finish time found, minimise cost.
    f.model.Add(f.makespan <= makespan)
    f.hint(plan)
    f.model.Minimize(f.cost)
    second = _solver(time_limit - (time.monotonic() - began), workers)
    status2 = second.Solve(f.model)
    if status2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        plan = f.plan(second)
        cost = int(second.ObjectiveValue())
        cost_bound = int(second.BestObjectiveBound())
    else:
        # Out of time before the second phase found anything: the first phase's plan stands, with no cost bound.
        cost = sum(task_cost(instance, Option(p.task, p.machine, p.model, p.end - p.start)) for p in plan)
        cost_bound = 0
    proven = status == cp_model.OPTIMAL and status2 == cp_model.OPTIMAL
    return Result(status='OPTIMAL' if proven else 'FEASIBLE', makespan=makespan, cost=cost, makespan_bound=makespan_bound,
                  cost_bound=cost_bound, gap=max(_gap(makespan, makespan_bound), _gap(cost, cost_bound)),
                  seconds=time.monotonic() - began, plan=plan)


@dataclass
class Front:
    points: List[Result]
    complete: bool
    seconds: float


def pareto(instance: Instance, time_limit: float = 10.0, workers: int = 8) -> Front:
    """Finish time against cost, fastest first. Each point is the fastest plan cheaper than the one before, at its least
    cost, so every point found optimal is on the front; the walk ends when no cheaper plan exists. `complete` is false when
    time ran out or a point was not proven optimal."""
    began = time.monotonic()
    points: List[Result] = []
    cap: Optional[int] = None
    complete = True
    while True:
        left = time_limit - (time.monotonic() - began)
        if left <= 0:
            complete = False
            break
        result = solve(instance, time_limit=left, workers=workers, cost_cap=cap)
        if result.status == 'INFEASIBLE':
            break
        if result.status not in ('OPTIMAL', 'FEASIBLE'):
            complete = False
            break
        complete = complete and result.status == 'OPTIMAL'
        points.append(result)
        cap = result.cost - 1
    return Front(points=points, complete=complete, seconds=time.monotonic() - began)
