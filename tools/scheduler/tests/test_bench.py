import time
import unittest

from scheduler.bench import generate
from scheduler.instance import load
from scheduler.solver import solve


class BenchTest(unittest.TestCase):
    def test_the_generated_instance_has_the_asked_size_and_loads(self):
        inst = load(generate(seed=1, tasks=30, machines=8, models=6))
        self.assertEqual((len(inst.tasks), len(inst.machines), len(inst.models)), (30, 8, 6))
        self.assertTrue(any(t.deps for t in inst.tasks))
        self.assertTrue(any(t.independent_of for t in inst.tasks))
        self.assertTrue(inst.accounts)

    def test_the_same_seed_gives_the_same_instance(self):
        self.assertEqual(generate(seed=7), generate(seed=7))

    def test_30_tasks_8_machines_6_models_solve_to_proven_optimal_within_10_seconds(self):
        for seed in (1, 2, 3):
            with self.subTest(seed=seed):
                inst = load(generate(seed=seed, tasks=30, machines=8, models=6))
                began = time.monotonic()
                result = solve(inst, time_limit=10.0)
                self.assertLess(time.monotonic() - began, 10.0)
                self.assertEqual(result.status, 'OPTIMAL')


if __name__ == '__main__':
    unittest.main()
