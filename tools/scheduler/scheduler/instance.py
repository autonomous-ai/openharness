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
    # Tasks whose model family this one must not share: a review is done by another family than the work it reviews.
    independent_of: Tuple[str, ...] = ()
    # Families the task may not use at all: a review whose build has already run is done by another family.
    avoid_families: Tuple[str, ...] = ()
    # The machines and models the owner's rules leave for the task's project; None is every one.
    machines: Optional[Tuple[str, ...]] = None
    models: Optional[Tuple[str, ...]] = None


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
    # Models of one family think alike (Opus, Sonnet and Haiku are all Claude); None takes the engine's name.
    family: Optional[str] = None
    # A model reached through a member's API or another owner's grid; the route ranks it after a machine's own engine.
    remote: bool = False
    # The words the route's candidate title gives it (`Claude opus high`), its last tie-break; None takes the id.
    label: Optional[str] = None

    def __post_init__(self):
        if self.family is None:
            object.__setattr__(self, 'family', self.engine)
        if self.label is None:
            object.__setattr__(self, 'label', self.id)

    def quality_for(self, kind: str) -> int:
        return self.quality.get(kind, self.quality['default'])


@dataclass(frozen=True)
class Window:
    """A usage window as read when the plan starts: percent left, and minutes until it refills (None: not known)."""
    name: str
    left: float
    resets_in: Optional[int] = None


@dataclass(frozen=True)
class Account:
    """One subscription. `budget` is what the exact plan may spend of each window, in percent; `windows` and `reserve`
    are the readings the route ranks candidates by (greedy.py)."""
    id: str
    members: Tuple[Tuple[str, str], ...]
    budget: Dict[str, float]
    windows: Tuple[Window, ...] = ()
    reserve: float = 0.0


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


def _account(a: dict) -> Account:
    """Windows default to the budget, never refilling; the budget defaults to the weekly window less the reserve, as only
    the weekly window holds over a night (a 5-hour window refills)."""
    reserve = float(a.get('reserve', 0))
    windows = tuple(Window(name=str(w['name']), left=float(w['left']), resets_in=None if w.get('resets_in') is None else int(w['resets_in']))
                    for w in a.get('windows', ()))
    if 'budget' in a:
        budget = {str(k): float(v) for k, v in a['budget'].items()}
    else:
        budget = {w.name: w.left - reserve for w in windows if w.name == 'weekly'}
    if not windows:
        windows = tuple(Window(name=k, left=v) for k, v in budget.items())
    return Account(id=str(a['id']), members=tuple((str(x[0]), str(x[1])) for x in a['members']), budget=budget, windows=windows, reserve=reserve)


def load(data: dict) -> Instance:
    tasks = [Task(id=str(t['id']), title=str(t.get('title', t['id'])), minutes=int(t['minutes']), floor=int(t.get('floor', 1)),
                  kind=str(t.get('kind') or 'default'), deps=tuple(str(d) for d in t.get('deps', ())),
                  spend={str(k): float(v) for k, v in t.get('spend', {}).items()}, difficulty=str(t.get('difficulty', 'medium')),
                  independent_of=tuple(str(d) for d in t.get('independent_of', ())),
                  avoid_families=tuple(str(f) for f in t.get('avoid_families', ())),
                  machines=None if t.get('machines') is None else tuple(str(m) for m in t['machines']),
                  models=None if t.get('models') is None else tuple(str(m) for m in t['models']))
             for t in data['tasks']]
    machines = [Machine(id=str(m['id']), name=str(m.get('name', m['id'])), slots=int(m['slots']), engines=tuple(m['engines']))
                for m in data['machines']]
    models = [Model(id=str(m['id']), engine=str(m['engine']), cost=int(m['cost']), quality={str(k): int(v) for k, v in m['quality'].items()},
                    speed=float(m.get('speed', 1.0)), concurrency=m.get('concurrency'),
                    machines=tuple(m['machines']) if m.get('machines') is not None else None, subscription=bool(m.get('subscription', True)),
                    family=m.get('family'), label=m.get('label'),
                    remote=bool(m.get('remote', False)))
              for m in data['models']]
    accounts = [_account(a) for a in data.get('accounts', ())]
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
        for other in t.independent_of:
            if other not in ids:
                raise InstanceError(f'{t.id} must differ from unknown task {other}')
    _check_acyclic(tasks)
    machine_ids = {m.id for m in machines}
    model_ids = {m.id for m in models}
    for t in tasks:
        for mid in t.machines or ():
            if mid not in machine_ids:
                raise InstanceError(f'{t.id} names unknown machine {mid}')
        for kid in t.models or ():
            if kid not in model_ids:
                raise InstanceError(f'{t.id} names unknown model {kid}')
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


def options(instance: Instance, task: Task, floor: bool = True) -> List[Option]:
    """Every machine and model that may run the task: the engine is on the machine and, unless `floor` is false, the
    quality meets the floor."""
    return [Option(task=task.id, machine=m.id, model=k.id, minutes=duration(task, k))
            for m in instance.machines for k in instance.models
            if k.engine in m.engines and (k.machines is None or m.id in k.machines) and k.family not in task.avoid_families
            and (task.machines is None or m.id in task.machines) and (task.models is None or k.id in task.models)
            and (not floor or k.quality_for(task.kind) >= task.floor)]
