"""The plan for open work, as `harness super-tab plan` reads it: each task's machine, model, start order and expected
finish, with finish time and cost, and what today's route would do with the same work (cli/src/superTabs/planCommand.ts)."""
from .greedy import greedy
from .instance import load
from .solver import solve


def plan(data: dict, time_limit: float = 10.0) -> dict:
    instance = load(data)
    exact = solve(instance, time_limit=time_limit)
    rows = [{'task': p.task, 'machine': p.machine, 'model': p.model, 'start': p.start, 'end': p.end, 'order': i + 1}
            for i, p in enumerate(exact.plan)]
    route = greedy(instance)
    return {'status': exact.status, 'reason': exact.reason, 'makespan': exact.makespan, 'cost': exact.cost, 'gap': exact.gap,
            'seconds': round(exact.seconds, 3), 'plan': rows,
            'route': {'status': route.status, 'makespan': route.makespan, 'cost': route.cost,
                      'plan': [{'task': p.task, 'machine': p.machine, 'model': p.model} for p in route.plan]}}
