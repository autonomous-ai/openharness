import json
import os
import subprocess
import sys
import tempfile
import unittest

from scheduler.plan import plan
from tests.helpers import instance, machine, model, task

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def two_builds_and_a_review():
    return instance([task('a'), task('b', minutes=20), task('r', minutes=20, floor=3, deps=['a'], independent_of=['a'])],
                    [machine('m', slots=1, engines=['claude', 'codex']), machine('n', slots=1, engines=['claude', 'codex'])],
                    [model('gpt', engine='codex', cost=2), model('opus', cost=3)])


class PlanTest(unittest.TestCase):
    def test_gives_each_task_its_machine_model_start_order_and_finish(self):
        out = plan(two_builds_and_a_review(), time_limit=5.0)
        self.assertEqual(out['status'], 'OPTIMAL')
        # a (60) and b (20) start at once on the two machines; the review follows a on another family.
        rows = {r['task']: r for r in out['plan']}
        self.assertEqual(set(rows), {'a', 'b', 'r'})
        self.assertEqual((rows['a']['start'], rows['a']['end']), (0, 60))
        self.assertEqual((rows['r']['start'], rows['r']['end']), (60, 80))
        self.assertNotEqual(rows['r']['model'], rows['a']['model'])
        self.assertEqual([r['order'] for r in out['plan']], [1, 2, 3])
        self.assertEqual(out['plan'][-1]['task'], 'r')
        self.assertEqual((out['makespan'], out['cost']), (80, 2 * 60 + 2 * 20 + 3 * 20))

    def test_says_what_the_route_would_do_for_the_same_work(self):
        route = plan(two_builds_and_a_review(), time_limit=5.0)['route']
        self.assertEqual(route['status'], 'EVALUATED')
        self.assertEqual(sorted(r['task'] for r in route['plan']), ['a', 'b', 'r'])
        self.assertEqual(set(route), {'status', 'makespan', 'cost', 'plan'})

    def test_an_impossible_plan_says_why(self):
        out = plan(instance([task('a', floor=3)], [machine('m')], [model('haiku', quality=1)]), time_limit=5.0)
        self.assertEqual((out['status'], out['plan']), ('INFEASIBLE', []))
        self.assertIn('a', out['reason'])


class PlanCommandTest(unittest.TestCase):
    def run_plan(self, env=None):
        return subprocess.run([sys.executable, '-m', 'scheduler', 'plan', '--time-limit', '5'], cwd=ROOT, input=json.dumps(two_builds_and_a_review()),
                              capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})

    def test_reads_the_instance_on_stdin_and_prints_the_plan(self):
        done = self.run_plan()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)['makespan'], 80)

    def test_without_or_tools_it_says_so_with_exit_3(self):
        with tempfile.TemporaryDirectory() as fake:
            os.makedirs(os.path.join(fake, 'ortools'))
            with open(os.path.join(fake, 'ortools', '__init__.py'), 'w') as f:
                f.write("raise ImportError('No module named ortools')\n")
            done = self.run_plan({'PYTHONPATH': fake})
        self.assertEqual(done.returncode, 3)
        self.assertEqual(json.loads(done.stdout)['error'], 'ORTOOLS_MISSING')


if __name__ == '__main__':
    unittest.main()
