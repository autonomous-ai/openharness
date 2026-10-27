import json
import os
import subprocess
import sys
import tempfile
import unittest

from scheduler.compare import broken, compare
from scheduler.instance import load
from tests.helpers import instance, machine, model, task

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def two_tasks():
    return instance([task('build', floor=3), task('review', minutes=20, floor=3, deps=['build'], independent_of=['build'])],
                    [machine('cheap', engines=['claude', 'codex']), machine('dear', engines=['claude', 'codex'])],
                    [model('gpt', engine='codex', cost=2), model('opus', cost=3), model('haiku', cost=1, quality=1)])


class BrokenTest(unittest.TestCase):
    def test_lists_a_pick_below_the_floor_and_a_review_by_the_same_family(self):
        inst = load(two_tasks())
        got = broken(inst, {'build': ('cheap', 'gpt'), 'review': ('dear', 'gpt')})
        self.assertEqual(got, ['review: reviewed by the same family (codex) as build'])
        got = broken(inst, {'build': ('cheap', 'gpt'), 'review': ('dear', 'haiku')})
        self.assertEqual(got, ['review: quality 1 below its floor 3'])

    def test_lists_an_account_spent_past_its_budget(self):
        inst = load(instance([task('a', spend={'weekly': 8})], [machine('m')], [model('opus', cost=3)],
                             [{'id': 'acct', 'members': [['m', 'claude']], 'budget': {'weekly': 5}}]))
        self.assertEqual(broken(inst, {'a': ('m', 'opus')}), ['account acct: weekly 12.0% used of 5.0% left'])

    def test_an_account_already_past_its_reserve_is_not_listed_when_nothing_uses_it(self):
        inst = load(instance([task('a', spend={'weekly': 8})], [machine('m'), machine('n')], [model('opus', cost=3)],
                             [{'id': 'acct', 'members': [['n', 'claude']], 'budget': {'weekly': -10}}]))
        self.assertEqual(broken(inst, {'a': ('m', 'opus')}), [])


class CompareTest(unittest.TestCase):
    def test_reports_the_optimal_greedy_and_actual_plans(self):
        night = {'instance': two_tasks(), 'actual': {'build': ['cheap', 'opus'], 'review': ['dear', 'gpt']}}
        report = compare(night, time_limit=5.0)
        rows = {r['plan']: r for r in report['rows']}
        self.assertEqual((rows['optimal']['makespan'], rows['optimal']['cost']), (80, 2 * 60 + 3 * 20))
        self.assertEqual(rows['optimal']['status'], 'OPTIMAL')
        self.assertEqual((rows['actual']['makespan'], rows['actual']['cost']), (80, 3 * 60 + 2 * 20))
        self.assertEqual(rows['actual']['broken'], [])
        self.assertIn('greedy', rows)
        self.assertEqual([(p['makespan'], p['cost']) for p in report['pareto']['points']], [(80, 180)])


class SlotCapTest(unittest.TestCase):
    def test_capping_slots_shows_the_night_on_fewer_agents_per_machine(self):
        night = {'instance': instance([task('a'), task('b')], [machine('m', slots=4)], [model('opus')]), 'actual': {}}
        rows = {r['plan']: r for r in compare(night, time_limit=5.0, max_slots=1)['rows']}
        self.assertEqual(rows['optimal']['makespan'], 120)


class CommandLineTest(unittest.TestCase):
    def run_cli(self, *args):
        done = subprocess.run([sys.executable, '-m', 'scheduler', *args], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def test_solve_prints_the_plan_as_json(self):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(two_tasks(), f)
        try:
            out = json.loads(self.run_cli('solve', f.name))
        finally:
            os.unlink(f.name)
        self.assertEqual((out['status'], out['makespan'], out['cost']), ('OPTIMAL', 80, 180))
        self.assertEqual(sorted(p['task'] for p in out['plan']), ['build', 'review'])

    def test_compare_prints_a_table(self):
        night = {'instance': two_tasks(), 'actual': {'build': ['cheap', 'opus'], 'review': ['dear', 'gpt']}}
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(night, f)
        try:
            out = self.run_cli('compare', f.name)
        finally:
            os.unlink(f.name)
        self.assertIn('| optimal | OPTIMAL | 80 | 180 |', out)
        self.assertIn('| actual |', out)


if __name__ == '__main__':
    unittest.main()
