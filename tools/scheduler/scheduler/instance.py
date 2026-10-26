"""A scheduling instance: the tasks to place, the machines that run them and the models they may use.

Times are whole minutes. A model's quality is given per task kind, with a `default` for every other kind; a task may use a
model only when that quality meets the task's floor. `spend` is what a task takes from each usage window of its account
at policy cost 2 (the routing policy's table), scaled by the model's cost like `sizeUp` in cli/src/superTabs/route.ts.
"""
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


class InstanceError(ValueError):
    pass


@dataclass(frozen=True)
class Task:
    id: str
    title: str
    minutes: int
    floor: int = 1
    kind: str = 'default'
    deps: Tuple[str, ...] = ()
    spend: Dict[str, float] = field(default_factory=dict)
    difficulty: str = 'medium'


@dataclass(frozen=True)
class Machine:
    id: str
    name: str
    slots: int
    engines: Tuple[str, ...]


@dataclass(frozen=True)
class Model:
    id: str
    engine: str
    cost: int
    quality: Dict[str, int]
    speed: float = 1.0
    # How many tasks may use the model at once across the Swarm: a local model serves one Builder, a shared API four.
    concurrency: Optional[int] = None
    # Machines that can reach it; None is every machine with its engine.
    machines: Optional[Tuple[str, ...]] = None
    # Whether it spends the machine's engine subscription (an API key or a model on the grid does not).
    subscription: bool = True

    def quality_for(self, kind: str) -> int:
        return self.quality.get(kind, self.quality['default'])


@dataclass(frozen=True)
class Account:
    """One subscription's usage windows: what is left of each, after the reserve, in percent."""
    id: str
    members: Tuple[Tuple[str, str], ...]
    budget: Dict[str, float]


@dataclass(frozen=True)
class Instance:
    tasks: List[Task]
    machines: List[Machine]
    models: List[Model]
    accounts: List[Account] = field(default_factory=list)

    def task(self, id: str) -> Task:
        return next(t for t in self.tasks if t.id == id)

    def machine(self, id: str) -> Machine:
        return next(m for m in self.machines if m.id == id)

    def model(self, id: str) -> Model:
        return next(m for m in self.models if m.id == id)

    def account_of(self, machine: str, model: Model) -> Optional[Account]:
        if not model.subscription:
            return None
        return next((a for a in self.accounts if (machine, model.engine) in a.members), None)


@dataclass(frozen=True)
class Option:
    """One way to run a task: on this machine, with this model, taking this long."""
    task: str
    machine: str
    model: str
    minutes: int


def _unique(kind: str, items) -> None:
    seen = set()
    for item in items:
        if item.id in seen:
            raise InstanceError(f'duplicate {kind} {item.id}')
        seen.add(item.id)


def _check_acyclic(tasks: List[Task]) -> None:
    deps = {t.id: t.deps for t in tasks}
    state: Dict[str, int] = {}

    def visit(id: str, path: List[str]) -> None:
        if state.get(id) == 2:
            return
        if state.get(id) == 1:
            raise InstanceError(f'dependency cycle: {" -> ".join(path + [id])}')
        state[id] = 1
        for dep in deps[id]:
            visit(dep, path + [id])
        state[id] = 2

    for t in tasks:
        visit(t.id, [])


def load(data: dict) -> Instance:
    tasks = [Task(id=str(t['id']), title=str(t.get('title', t['id'])), minutes=int(t['minutes']), floor=int(t.get('floor', 1)),
                  kind=str(t.get('kind') or 'default'), deps=tuple(str(d) for d in t.get('deps', ())),
                  spend={str(k): float(v) for k, v in t.get('spend', {}).items()}, difficulty=str(t.get('difficulty', 'medium')))
             for t in data['tasks']]
    machines = [Machine(id=str(m['id']), name=str(m.get('name', m['id'])), slots=int(m['slots']), engines=tuple(m['engines']))
                for m in data['machines']]
    models = [Model(id=str(m['id']), engine=str(m['engine']), cost=int(m['cost']), quality={str(k): int(v) for k, v in m['quality'].items()},
                    speed=float(m.get('speed', 1.0)), concurrency=m.get('concurrency'),
                    machines=tuple(m['machines']) if m.get('machines') is not None else None, subscription=bool(m.get('subscription', True)))
              for m in data['models']]
    accounts = [Account(id=str(a['id']), members=tuple((str(x[0]), str(x[1])) for x in a['members']),
                        budget={str(k): float(v) for k, v in a['budget'].items()})
                for a in data.get('accounts', ())]
    _unique('task', tasks)
    _unique('machine', machines)
    _unique('model', models)
    _unique('account', accounts)
    ids = {t.id for t in tasks}
    for t in tasks:
        if t.minutes <= 0:
            raise InstanceError(f'{t.id} needs a positive estimate')
        for dep in t.deps:
            if dep not in ids:
                raise InstanceError(f'{t.id} depends on unknown task {dep}')
    _check_acyclic(tasks)
    machine_ids = {m.id for m in machines}
    for m in models:
        if 'default' not in m.quality:
            raise InstanceError(f'{m.id} has no default quality')
        if m.speed <= 0:
            raise InstanceError(f'{m.id} needs a positive speed')
        for mid in m.machines or ():
            if mid not in machine_ids:
                raise InstanceError(f'model {m.id} names unknown machine {mid}')
    for a in accounts:
        for mid, _ in a.members:
            if mid not in machine_ids:
                raise InstanceError(f'account {a.id} names unknown machine {mid}')
    return Instance(tasks=tasks, machines=machines, models=models, accounts=accounts)


def duration(task: Task, model: Model) -> int:
    return math.ceil(task.minutes / model.speed)


def options(instance: Instance, task: Task) -> List[Option]:
    """Every machine and model that may run the task: the engine is on the machine and the quality meets the floor."""
    return [Option(task=task.id, machine=m.id, model=k.id, minutes=duration(task, k))
            for m in instance.machines for k in instance.models
            if k.engine in m.engines and (k.machines is None or m.id in k.machines) and k.quality_for(task.kind) >= task.floor]
