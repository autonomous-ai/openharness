"""The exact plan against today's route and against the picks the Swarm actually made, on one instance."""
from typing import Dict, List, Optional, Tuple

from .greedy import Assignment, evaluate, greedy
from .instance import Instance, Option, duration, load
from .solver import QUOTA_SCALE, Result, pareto, quota_use, solve


def broken(instance: Instance, assignment: Assignment) -> List[str]:
    """Where a fixed assignment breaks the floors, a review's other family or an account's budget."""
    out = []
    for t in instance.tasks:
        model = instance.model(assignment[t.id][1])
        if model.quality_for(t.kind) < t.floor:
            out.append(f'{t.id}: quality {model.quality_for(t.kind)} below its floor {t.floor}')
        for other in t.independent_of:
            if instance.model(assignment[other][1]).family == model.family:
                out.append(f'{t.id}: reviewed by the same family ({model.family}) as {other}')
    for account in instance.accounts:
        for window, left in account.budget.items():
            used = sum(quota_use(instance, Option(t.id, m, k, duration(t, instance.model(k))), window)
                       for t in instance.tasks for m, k in [assignment[t.id]] if instance.account_of(m, instance.model(k)) == account)
            if used > 0 and used > left * QUOTA_SCALE:
                out.append(f'account {account.id}: {window} {used / QUOTA_SCALE:.1f}% used of {left:.1f}% left')
    return out


def _row(name: str, instance: Instance, result: Result) -> dict:
    assignment = {p.task: (p.machine, p.model) for p in result.plan}
    return {'plan': name, 'status': result.status, 'makespan': result.makespan, 'cost': result.cost,
            'seconds': round(result.seconds, 3), 'broken': broken(instance, assignment) if len(assignment) == len(instance.tasks) else []}


def compare(night: dict, time_limit: float = 10.0, max_slots: Optional[int] = None) -> dict:
    """`max_slots` caps every machine's slots, to see the same night on a busier Swarm."""
    data = night['instance']
    if max_slots is not None:
        data = {**data, 'machines': [{**m, 'slots': min(m['slots'], max_slots)} for m in data['machines']]}
    instance = load(data)
    rows = [_row('optimal', instance, solve(instance, time_limit=time_limit)), _row('greedy', instance, greedy(instance))]
    actual = night.get('actual') or {}
    if all(t.id in actual for t in instance.tasks):
        rows.append(_row('actual', instance, evaluate(instance, {k: tuple(v) for k, v in actual.items()})))
    front = pareto(instance, time_limit=time_limit)
    return {'rows': rows, 'pareto': {'complete': front.complete, 'seconds': round(front.seconds, 3),
                                     'points': [{'makespan': p.makespan, 'cost': p.cost} for p in front.points]}}


def table(report: dict) -> str:
    lines = ['| plan | status | finish (min) | cost | solve (s) | broken |', '| --- | --- | --- | --- | --- | --- |']
    for r in report['rows']:
        lines.append(f"| {r['plan']} | {r['status']} | {r['makespan']} | {r['cost']} | {r['seconds']} | {len(r['broken'])} |")
    front = report['pareto']
    lines += ['', f"Pareto set ({'complete' if front['complete'] else 'incomplete'}, {front['seconds']} s): "
              + ', '.join(f"{p['makespan']} min at cost {p['cost']}" for p in front['points'])]
    for r in report['rows']:
        lines += [f"{r['plan']} breaks: {b}" for b in r['broken']]
    return '\n'.join(lines)
