"""A generated instance shaped like a busy night, for the solve-time check: build tasks with reviews after them, chains
of work, few slots per machine, quotas that bind and models that differ in strength, cost and speed."""
import random

# The routing policy's rows, a cheaper Codex and a slow local model on the grid.
MODELS = [
    {'id': 'claude-opus', 'engine': 'claude', 'cost': 3, 'quality': {'default': 3}, 'speed': 1.0},
    {'id': 'codex-default', 'engine': 'codex', 'cost': 2, 'quality': {'default': 3}, 'speed': 0.9},
    {'id': 'claude-sonnet', 'engine': 'claude', 'cost': 2, 'quality': {'default': 2, 'review': 3}, 'speed': 1.2},
    {'id': 'codex-mini', 'engine': 'codex', 'cost': 1, 'quality': {'default': 2}, 'speed': 1.3},
    {'id': 'claude-haiku', 'engine': 'claude', 'cost': 1, 'quality': {'default': 1}, 'speed': 1.5},
    {'id': 'grid-local', 'engine': 'claude', 'cost': 1, 'quality': {'default': 1}, 'speed': 0.5, 'concurrency': 1,
     'subscription': False, 'family': 'local'},
]
SIZES = [(20, 1), (60, 4), (180, 8)]


def generate(seed: int, tasks: int = 30, machines: int = 8, models: int = 6) -> dict:
    rng = random.Random(seed)
    out_tasks = []
    while len(out_tasks) < tasks:
        i = len(out_tasks)
        minutes, weekly = rng.choice(SIZES)
        earlier = [t['id'] for t in out_tasks if t['kind'] != 'review']
        deps = rng.sample(earlier, k=min(len(earlier), rng.choice([0, 0, 1, 1, 2])))
        build = {'id': f't{i}', 'title': f'task {i}', 'minutes': minutes, 'floor': rng.choice([1, 2, 2, 3, 3]), 'kind': 'build',
                 'difficulty': rng.choice(['low', 'medium', 'high']), 'spend': {'weekly': weekly}, 'deps': deps}
        out_tasks.append(build)
        if len(out_tasks) < tasks and rng.random() < 0.4:
            out_tasks.append({'id': f't{i + 1}', 'title': f'review of task {i}', 'minutes': 20, 'floor': 3, 'kind': 'review',
                              'difficulty': 'high', 'spend': {'weekly': 1}, 'deps': [build['id']], 'independent_of': [build['id']]})
    out_machines, accounts = [], []
    for j in range(machines):
        engines = rng.choice([['claude', 'codex'], ['claude', 'codex'], ['claude'], ['codex']])
        out_machines.append({'id': f'm{j}', 'name': f'machine {j}', 'slots': rng.choice([1, 2, 2, 3, 4]), 'engines': engines})
        for engine in engines:
            if rng.random() < 0.7:
                accounts.append({'id': f'm{j}-{engine}', 'members': [[f'm{j}', engine]], 'budget': {'weekly': rng.choice([10, 20, 40, 60])}})
    return {'tasks': out_tasks, 'machines': out_machines, 'models': MODELS[:models], 'accounts': accounts}
