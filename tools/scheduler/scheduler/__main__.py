"""python -m scheduler solve INSTANCE [--pareto] [--time-limit S]
python -m scheduler plan [--time-limit S] < INSTANCE   (the input and output of `harness super-tab plan`)
python -m scheduler compare NIGHT [--time-limit S] [--max-slots N]
python -m scheduler convert STATUS ROUTE_LOG CONFIG OUT
python -m scheduler redact STATUS ROUTE_LOG STATUS_OUT ROUTE_LOG_OUT"""
import argparse
import dataclasses
import json
import sys

# Exit code and answer when OR-Tools is not installed, which `harness super-tab plan` tells the Lead.
ORTOOLS_MISSING = 3
INSTALL = 'Install it with: python3 -m pip install ortools==9.15.6755'


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='scheduler')
    sub = parser.add_subparsers(dest='command', required=True)
    p_solve = sub.add_parser('solve', help='the exact plan for an instance, as JSON')
    p_solve.add_argument('instance')
    p_solve.add_argument('--pareto', action='store_true', help='print the finish time against cost set instead')
    p_solve.add_argument('--time-limit', type=float, default=10.0)
    p_plan = sub.add_parser('plan', help='the plan for open work: instance on stdin, plan as JSON')
    p_plan.add_argument('--time-limit', type=float, default=10.0)
    p_compare = sub.add_parser('compare', help='exact plan, greedy route and actual picks on a converted night')
    p_compare.add_argument('night')
    p_compare.add_argument('--time-limit', type=float, default=10.0)
    p_compare.add_argument('--max-slots', type=int, help='cap every machine at this many agents')
    p_convert = sub.add_parser('convert', help='a Swarm status snapshot and route log to a night file')
    p_convert.add_argument('paths', nargs=4, metavar=('STATUS', 'ROUTE_LOG', 'CONFIG', 'OUT'))
    p_redact = sub.add_parser('redact', help='keep only what convert reads, without emails or people\'s names')
    p_redact.add_argument('paths', nargs=4, metavar=('STATUS', 'ROUTE_LOG', 'STATUS_OUT', 'ROUTE_LOG_OUT'))
    args = parser.parse_args(argv)

    from . import redact, swarm
    if args.command == 'convert':
        return swarm.main(args.paths)
    if args.command == 'redact':
        return redact.main(args.paths)
    try:
        from .compare import compare, table
        from .instance import load
        from .plan import plan
        from .solver import pareto, solve
    except ImportError as error:
        if 'ortools' not in str(error):
            raise
        print(json.dumps({'error': 'ORTOOLS_MISSING', 'detail': f'OR-Tools is not installed for {sys.executable}. {INSTALL}'}))
        return ORTOOLS_MISSING
    if args.command == 'plan':
        print(json.dumps(plan(json.load(sys.stdin), time_limit=args.time_limit)))
        return 0
    with open(getattr(args, 'instance', None) or args.night) as f:
        data = json.load(f)
    if args.command == 'compare':
        print(table(compare(data, time_limit=args.time_limit, max_slots=args.max_slots)))
        return 0
    instance = load(data.get('instance', data))
    if args.pareto:
        front = pareto(instance, time_limit=args.time_limit)
        print(json.dumps({'complete': front.complete, 'seconds': front.seconds, 'points': [dataclasses.asdict(p) for p in front.points]}, indent=1))
    else:
        print(json.dumps(dataclasses.asdict(solve(instance, time_limit=args.time_limit)), indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
