# Swarm scheduler (prototype)

Places every task on a machine and a model at once. Quality floors are a hard limit; it minimises finish time, then
cost, and proves the result optimal with OR-Tools CP-SAT. It does not route anything yet. Formulation and results:
[docs/plans/2026-10-27-swarm-scheduler.md](../../docs/plans/2026-10-27-swarm-scheduler.md).

```sh
cd tools/scheduler
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -t .

# The exact plan, or the Pareto set of finish time against cost, as JSON
.venv/bin/python -m scheduler solve data/2026-10-26-night.json [--pareto] [--time-limit 10]
# Exact plan, today's route and the picks the Swarm made, side by side
.venv/bin/python -m scheduler compare data/2026-10-26-night.json [--max-slots 1]
# A Swarm status snapshot and the Lead's route log, cut to what convert reads, without emails or people's names
.venv/bin/python -m scheduler redact STATUS.json ROUTE_LOG.json STATUS_OUT.json ROUTE_LOG_OUT.json
# Those inputs to a night file (this reproduces data/2026-10-26-night.json)
.venv/bin/python -m scheduler convert data/2026-10-26-status.redacted.json data/2026-10-26-route-log.redacted.json \
  data/2026-10-26-night.config.json OUT.json
```

| File | What it does |
| --- | --- |
| `scheduler/instance.py` | Instance format, checks, and the options that meet each task's floor |
| `scheduler/solver.py` | CP-SAT model, the lexicographic solve and the Pareto set |
| `scheduler/greedy.py` | Today's route (route.ts `sizeUp`, `choose`, `compare`) as a baseline, and the earliest start of a fixed assignment |
| `scheduler/compare.py` | The three plans side by side, and what a fixed plan breaks |
| `scheduler/swarm.py` | Swarm status and route log to an instance |
| `scheduler/redact.py` | The inputs cut to what `swarm.py` reads, with people's names replaced |
| `scheduler/bench.py` | Generated busy nights for the solve-time check |
| `data/` | The 2026-10-26 night: redacted status and route log, hand-checked inputs (`*.config.json`) and the converted instance |
