"""Turns a Swarm status snapshot and the Lead's route log into an instance, plus the picks the Swarm actually made.

What the snapshot does not hold comes from a config file kept beside the data (data/2026-10-26-night.json): the routing
policy, which route request belongs to a group the log names only by a variable, estimates for groups with no request,
dependencies, and groups a person pinned to one machine and model. Everything not read straight from the snapshot or
the log is listed in `estimates`.
"""
import json
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# The owner's table in cli/src/superTabs/route.ts SIZES: run time, and spend per window at policy cost 2.
SIZES = {'small': (20, {'5-hour': 10, 'weekly': 1}), 'medium': (60, {'5-hour': 30, 'weekly': 4}),
         'large': (180, {'5-hour': 50, 'weekly': 8})}
ENGINES = ('claude', 'codex')
ENGINE_WORD = {'claude': 'Claude', 'codex': 'Codex'}
KIND_WORD = {'local': 'local', 'api': 'API', 'shared': 'shared'}
# A model a member shares as an API answers four requests at once; a local engine one (route.ts API_BUILDERS).
GRID_CONCURRENCY = {'api': 4, 'local': 1, 'shared': 1}


class ConvertError(ValueError):
    pass


def model_id(engine: str, model: str) -> str:
    return f'{engine}-{model}'


def _models(policy: dict, machines: List[dict]) -> Tuple[List[dict], Dict[str, str]]:
    """The policy's enabled rows, one per engine and model, and each model the grid serves. Returns the rows and a map
    from a grid model's name to its row id."""
    rows, seen = [], set()
    for m in policy['models']:
        key = model_id(m['engine'], m['model'])
        if m['enabled'] and m['engine'] in ENGINES and key not in seen:
            seen.add(key)
            rows.append({'id': key, 'engine': m['engine'], 'cost': m['cost'], 'quality': {'default': m['quality']},
                         'label': f"{ENGINE_WORD[m['engine']]} {m['model']} {m['effort']}"})
    grid: Dict[str, str] = {}
    local = policy.get('localModels') or {'quality': 1, 'enabled': True}
    if local['enabled']:
        for machine in machines:
            for served in (machine.get('observation') or {}).get('localModels', []):
                key = f"grid-{served['model']}"
                if served['model'] not in grid:
                    grid[served['model']] = key
                    # A grid model is driven by a Claude Code Builder on any machine, through the grid relay.
                    kind = served.get('kind', 'local')
                    rows.append({'id': key, 'engine': 'claude', 'cost': 1, 'quality': {'default': local['quality']},
                                 'concurrency': GRID_CONCURRENCY.get(kind, 1), 'subscription': False, 'family': served['model'],
                                 'remote': kind in ('api', 'shared'),
                                 'label': f"Claude on {served.get('name') or served['model']} ({KIND_WORD.get(kind, 'local')})"})
    return rows, grid


def reset_ms(value) -> Optional[int]:
    """route.ts `resetMs`: Claude sends ISO strings, Codex epoch seconds; anything above 1e10 is already milliseconds."""
    if isinstance(value, (int, float)):
        return int(value if value > 1e10 else value * 1000)
    if isinstance(value, str):
        try:
            return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
        except ValueError:
            return None
    return None


def snapshot_ms(machines: List[dict]) -> int:
    """When the snapshot was read: its latest machine observation."""
    return max(int((m.get('observation') or {}).get('receivedAt') or 0) for m in machines)


def _windows(quota: dict, now: int) -> List[dict]:
    """The 5-hour and weekly windows as read at `now`, with minutes to their reset; one whose reset has passed has refilled."""
    out = []
    for name in ('5-hour', 'weekly'):
        w = next((w for w in quota['windows'] if w.get('name') == name), None)
        if w is None:
            continue
        reset = reset_ms(w.get('resetsAt'))
        if reset is not None and reset <= now:
            out.append({'name': name, 'left': 100.0, 'resets_in': None})
        else:
            out.append({'name': name, 'left': float(100 - w['usedPercent']), 'resets_in': None if reset is None else round((reset - now) / 60000)})
    return out


def _accounts(machines: List[dict], reserve: int, now: int) -> List[dict]:
    """One account per weekly reading; machines reporting the same reading (used and reset time) are taken to share it.
    The exact plan's budget is the weekly window alone: a 5-hour window refills during a night's work. The route's
    baseline reads both windows."""
    by_reading: Dict[Tuple, dict] = {}
    for machine in machines:
        for quota in (machine.get('observation') or {}).get('quotas', []):
            if quota['engine'] not in ENGINES or not quota.get('known'):
                continue
            weekly = next((w for w in quota['windows'] if w.get('name') == 'weekly'), None)
            if weekly is None:
                continue
            reading = (quota['engine'], weekly['usedPercent'], str(weekly['resetsAt']))
            if reading not in by_reading:
                windows = _windows(quota, now)
                left = next(w['left'] for w in windows if w['name'] == 'weekly')
                by_reading[reading] = {'id': f"{quota['engine']}-{len(by_reading) + 1}", 'members': [], 'reserve': float(reserve),
                                       'windows': windows, 'budget': {'weekly': left - reserve}}
            by_reading[reading]['members'].append([machine['machineId'], quota['engine']])
    return list(by_reading.values())


def _add_back(accounts: List[dict], tasks: List[dict], actual: Dict[str, list], models: List[dict]) -> None:
    """The snapshot is taken after the night's work spent its quota. Adding back what the actual picks are expected to have
    spent gives every plan the same budget the night started with (an estimate: the spend comes from the size table)."""
    rows = {m['id']: m for m in models}
    for t in tasks:
        if t['id'] not in actual:
            continue
        machine_id, picked = actual[t['id']]
        model = rows[picked]
        if not model.get('subscription', True):
            continue
        account = next((a for a in accounts if [machine_id, model['engine']] in a['members']), None)
        if account is not None:
            # The weekly window only: the night's 5-hour windows have refilled since. A window holds at most 100%: the
            # size table can estimate more spend than the window shows.
            for w in account['windows']:
                if w['name'] == 'weekly':
                    w['left'] = min(100.0, w['left'] + t['spend'].get('weekly', 0.0) * model['cost'] / 2)
                    account['budget']['weekly'] = w['left'] - account['reserve']


def _actual_model(configuration: dict, grid: Dict[str, str], model_ids: set) -> Optional[str]:
    engine, model = configuration.get('engine'), str(configuration.get('model') or '')
    if model in grid:
        return grid[model]
    if engine == 'codex':
        return model_id('codex', 'default')
    if engine == 'claude':
        family = next((f for f in ('opus', 'sonnet', 'haiku') if f in model), None)
        if family and model_id('claude', family) in model_ids:
            return model_id('claude', family)
    return None


def convert(status: dict, route_log: List[dict], config: dict) -> dict:
    """Since the project instructions (phase 4) a snapshot's tasks have floor 1, no `independent_of`, reserve 0 and no
    machines rule: the route ranks by facts and the instructions say how to choose. The solver keeps those fields for
    bench instances."""
    state = status['value']['state']
    policy = config['policy']
    # A model on the grid is reachable from every machine.
    models, grid = _models(policy, state['machines'])
    now = snapshot_ms(state['machines'])
    machines = state['machines']
    ids = {m['id'] for m in models}
    exclude = config.get('exclude', {})
    groups = [c for c in state['conversations'] if (c.get('assignment') or {}).get('configuration')]
    tasks, actual, estimates, excluded = [], {}, [], []
    for g in groups:
        if g['id'] in exclude:
            excluded.append({'group': g['id'], 'title': g['title'], 'reason': exclude[g['id']]})
            continue
        given = config.get('assessments', {}).get(g['id'])
        direct = next((r for r in route_log if r['group'] == g['id']), None)
        if given and 'route' in given:
            request = route_log[given['route']]['request']
        elif given and 'estimate' in given:
            request = given['estimate']
        elif direct:
            request = direct['request']
        else:
            raise ConvertError(f'no assessment for {g["id"]} ({g["title"]})')
        if given:
            estimates.append({'group': g['id'], 'title': g['title'], 'note': given.get('note', '')})
        minutes, spend = SIZES[request.get('size', 'medium')]
        deps = config.get('deps', {}).get(g['id'], [])
        tasks.append({'id': g['id'], 'title': g['title'], 'minutes': minutes, 'floor': 1, 'kind': request.get('kind') or 'default',
                      'difficulty': request['difficulty'], 'spend': dict(spend), 'deps': deps, 'independent_of': []})
        assignment = g['assignment']
        picked = _actual_model(assignment['configuration'], grid, ids)
        if picked is not None:
            actual[g['id']] = [assignment['execution']['machineId'], picked]
    accounts = _accounts(machines, 0, now)
    if config.get('budget', 'start') == 'start':
        _add_back(accounts, tasks, actual, models)
    task_ids = {t['id'] for t in tasks}
    for t in tasks:
        for dep in t['deps']:
            if dep not in task_ids:
                raise ConvertError(f'{t["id"]} depends on {dep}, which is not a task')
    instance = {
        'tasks': tasks,
        'machines': [{'id': m['machineId'], 'name': m['name'], 'slots': m['maxAgents'],
                      'engines': [e for e in m['engines'] if e in ENGINES]} for m in machines],
        'models': models,
        'accounts': accounts,
    }
    return {'instance': instance, 'actual': actual, 'estimates': estimates, 'excluded': excluded}


def main(argv: List[str]) -> int:
    status_path, log_path, config_path, out_path = argv
    with open(status_path) as s, open(log_path) as l, open(config_path) as c:
        out = convert(json.load(s), json.load(l), json.load(c))
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    return 0
