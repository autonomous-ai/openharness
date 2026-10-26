"""Turns a Swarm status snapshot and the Lead's route log into an instance, plus the picks the Swarm actually made.

What the snapshot does not hold comes from a config file kept beside the data (data/2026-10-26-night.json): the routing
policy, which route request belongs to a group the log names only by a variable, estimates for groups with no request,
dependencies, and groups a person pinned to one machine and model. Everything not read straight from the snapshot or
the log is listed in `estimates`.
"""
import json
from typing import Dict, List, Optional, Tuple

# The owner's table in cli/src/superTabs/route.ts SIZES: run time, and weekly spend at policy cost 2.
SIZES = {'small': (20, 1), 'medium': (60, 4), 'large': (180, 8)}
ENGINES = ('claude', 'codex')
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
            rows.append({'id': key, 'engine': m['engine'], 'cost': m['cost'], 'quality': {'default': m['quality']}})
    grid: Dict[str, str] = {}
    local = policy.get('localModels') or {'quality': 1, 'enabled': True}
    if local['enabled']:
        for machine in machines:
            for served in (machine.get('observation') or {}).get('localModels', []):
                key = f"grid-{served['model']}"
                if served['model'] not in grid:
                    grid[served['model']] = key
                    # A grid model is driven by a Claude Code Builder on any machine, through the grid relay.
                    rows.append({'id': key, 'engine': 'claude', 'cost': 1, 'quality': {'default': local['quality']},
                                 'concurrency': GRID_CONCURRENCY.get(served.get('kind', 'local'), 1), 'subscription': False,
                                 'family': served['model']})
    return rows, grid


def _accounts(machines: List[dict], reserve: int) -> List[dict]:
    """One account per weekly reading; machines reporting the same reading (used and reset time) are taken to share it.
    Only the weekly window is a budget: a 5-hour window refills during a night's work."""
    by_reading: Dict[Tuple, dict] = {}
    for machine in machines:
        for quota in (machine.get('observation') or {}).get('quotas', []):
            if quota['engine'] not in ENGINES or not quota.get('known'):
                continue
            weekly = next((w for w in quota['windows'] if w.get('name') == 'weekly'), None)
            if weekly is None:
                continue
            reading = (quota['engine'], weekly['usedPercent'], str(weekly['resetsAt']))
            account = by_reading.setdefault(reading, {'id': f"{quota['engine']}-{len(by_reading) + 1}", 'members': [],
                                                      'budget': {'weekly': float(100 - weekly['usedPercent'] - reserve)}})
            account['members'].append([machine['machineId'], quota['engine']])
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
            for window in account['budget']:
                account['budget'][window] += t['spend'].get(window, 0.0) * model['cost'] / 2


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
    state = status['value']['state']
    policy = config['policy']
    machines = state['machines']
    models, grid = _models(policy, machines)
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
        minutes, weekly = SIZES[request.get('size', 'medium')]
        floor = min(3, policy['floor'][request['difficulty']] + (1 if request['risk'] == 'high' else 0))
        deps = config.get('deps', {}).get(g['id'], [])
        # A review is done by another model family than the work it reviews (the Lead asks for it on every review).
        review = g['title'].startswith('Review:')
        tasks.append({'id': g['id'], 'title': g['title'], 'minutes': minutes, 'floor': floor, 'kind': request.get('kind') or 'default',
                      'difficulty': request['difficulty'], 'spend': {'weekly': weekly}, 'deps': deps,
                      'independent_of': deps if review else []})
        assignment = g['assignment']
        picked = _actual_model(assignment['configuration'], grid, ids)
        if picked is not None:
            actual[g['id']] = [assignment['execution']['machineId'], picked]
    accounts = _accounts(machines, policy['quotaReserve'])
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
