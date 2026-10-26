"""python -m scheduler solve INSTANCE [--pareto] [--time-limit S]
python -m scheduler compare NIGHT [--time-limit S]
python -m scheduler convert STATUS ROUTE_LOG CONFIG OUT"""
import argparse
import dataclasses
import json
import sys

from . import swarm
from .compare import compare, table
from .instance import load
from .solver import pareto, solve


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='scheduler')
    sub = parser.add_subparsers(dest='command', required=True)
    p_solve = sub.add_parser('solve', help='the exact plan for an instance, as JSON')
    p_solve.add_argument('instance')
    p_solve.add_argument('--pareto', action='store_true', help='print the finish time against cost set instead')
    p_solve.add_argument('--time-limit', type=float, default=10.0)
    p_compare = sub.add_parser('compare', help='exact plan, greedy route and actual picks on a converted night')
    p_compare.add_argument('night')
    p_compare.add_argument('--time-limit', type=float, default=10.0)
    p_compare.add_argument('--max-slots', type=int, help='cap every machine at this many agents')
    p_convert = sub.add_parser('convert', help='a Swarm status snapshot and route log to a night file')
    p_convert.add_argument('paths', nargs=4, metavar=('STATUS', 'ROUTE_LOG', 'CONFIG', 'OUT'))
    args = parser.parse_args(argv)

    if args.command == 'convert':
        return swarm.main(args.paths)
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
