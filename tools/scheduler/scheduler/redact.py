"""Makes a Swarm status snapshot and a route log safe to commit beside the converter.

Only the fields the converter reads are kept (ids, machines, quotas, models, assignments, rules, the route requests), so
emails, briefs, home folders and anything else in the snapshot are dropped by default. People's names, taken from their
emails, are replaced wherever text is kept: machine names, titles, rule texts and route reasons.
"""
import json
import re
from typing import Iterable, List, Optional, Tuple

PERSON = '[person]'
EMAIL = re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+')
CREDENTIAL_URL = re.compile(r'\w+://[^/\s"@]+@')


def _pick(value: Optional[dict], keys: Iterable[str]) -> dict:
    return {k: value[k] for k in keys if value and k in value}


def _names(people: List[dict]) -> List[str]:
    """First names from people's emails: `ken15@…` gives `ken`, `phamngochuy.1989@…` gives `phamngochuy`."""
    out = set()
    for p in people:
        local = str(p.get('email', '')).split('@')[0]
        out.update(w for w in re.split(r'[^a-zA-Z]+', local) if len(w) >= 3)
    return sorted(out, key=len, reverse=True)


def _scrub(text: Optional[str], names: List[str]) -> Optional[str]:
    if text is None:
        return None
    for name in names:
        # Whole words only, with a possessive kept: "Diego's Mac" -> "[person]'s Mac"; "Deepseek" stays.
        text = re.sub(rf"\b{re.escape(name)}(?=(?:'s|s)?\b)", PERSON, text, flags=re.IGNORECASE)
    return text


def redact(status: dict, route_log: List[dict]) -> Tuple[dict, List[dict]]:
    state = status['value']['state']
    names = _names(state.get('people') or [])
    machines = [{**_pick(m, ('machineId', 'maxAgents', 'engines')), 'name': _scrub(m.get('name'), names),
                 'observation': {
                     **_pick(m.get('observation'), ('receivedAt',)),
                     'quotas': [{**_pick(q, ('engine', 'known')), 'windows': [_pick(w, ('name', 'usedPercent', 'resetsAt')) for w in q.get('windows', [])]}
                                for q in (m.get('observation') or {}).get('quotas', [])],
                     'localModels': [{**_pick(x, ('grid', 'model', 'kind')), 'name': _scrub(x.get('name'), names)}
                                     for x in (m.get('observation') or {}).get('localModels', [])]}}
                for m in state.get('machines', [])]
    conversations = [{**_pick(c, ('id', 'projectId')), 'title': _scrub(c.get('title'), names),
                      'assignment': None if not c.get('assignment') else {
                          **_pick(c['assignment'], ('id', 'agentId', 'status')),
                          'configuration': _pick(c['assignment'].get('configuration'), ('engine', 'model', 'effort')),
                          'execution': _pick(c['assignment'].get('execution'), ('machineId',))}}
                     for c in state.get('conversations', [])]
    agents = [{**_pick(a, ('id', 'machineId', 'projectId', 'name')), 'configuration': _pick(a.get('configuration'), ('engine', 'model', 'effort'))}
              for a in state.get('agents', [])]
    rules = [{**_pick(r, ('id', 'projectId', 'rule', 'createdAt')), 'text': _scrub(r.get('text'), names)} for r in state.get('rules', [])]
    people = [_pick(p, ('id', 'role')) for p in state.get('people', [])]
    out_status = {'value': {'state': {'people': people, 'agents': agents, 'machines': machines, 'conversations': conversations, 'rules': rules}}}
    out_log = [{**_pick(r, ('group', 'at')), 'request': {**r['request'], 'why': _scrub(r['request'].get('why'), names)}} for r in route_log]
    text = json.dumps([out_status, out_log])
    if EMAIL.search(text) or CREDENTIAL_URL.search(text):
        raise ValueError('an email or a URL with credentials is left after redaction')
    return out_status, out_log


def main(argv: List[str]) -> int:
    status_in, log_in, status_out, log_out = argv
    with open(status_in) as s, open(log_in) as l:
        status, log = redact(json.load(s), json.load(l))
    for path, value in ((status_out, status), (log_out, log)):
        with open(path, 'w') as f:
            json.dump(value, f, indent=1, ensure_ascii=False)
            f.write('\n')
    return 0
