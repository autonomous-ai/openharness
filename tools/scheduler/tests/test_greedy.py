import unittest

from scheduler.greedy import evaluate, greedy
from scheduler.instance import load
from scheduler.solver import solve
from tests.helpers import instance, machine, model, task


def picks(result):
    return {p.task: (p.machine, p.model) for p in result.plan}


class EvaluateTest(unittest.TestCase):
    def test_a_fixed_assignment_starts_each_task_as_early_as_slots_and_dependencies_allow(self):
        inst = load(instance([task('a', minutes=60), task('b', minutes=30), task('c', minutes=20, deps=['a'])],
                             [machine('m', slots=1), machine('n', slots=1)], [model('opus', cost=3)]))
        result = evaluate(inst, {'a': ('m', 'opus'), 'b': ('m', 'opus'), 'c': ('n', 'opus')})
        got = {p.task: (p.start, p.end) for p in result.plan}
        self.assertEqual(got, {'a': (0, 60), 'b': (60, 90), 'c': (60, 80)})
        self.assertEqual(result.makespan, 90)
        self.assertEqual(result.cost, 3 * (60 + 30 + 20))

    def test_a_model_limited_to_one_task_queues_the_second(self):
        inst = load(instance([task('a'), task('b')], [machine('m', slots=2), machine('n', slots=2)], [model('local', concurrency=1)]))
        result = evaluate(inst, {'a': ('m', 'local'), 'b': ('n', 'local')})
        self.assertEqual(result.makespan, 120)


class RouteOrderTest(unittest.TestCase):
    def test_picks_the_cheapest_model_that_meets_the_floor(self):
        inst = load(instance([task('a', floor=2)], [machine('m')],
                             [model('haiku', cost=1, quality=1), model('sonnet', cost=2, quality=2), model('opus', cost=3, quality=3)]))
        self.assertEqual(picks(greedy(inst)), {'a': ('m', 'sonnet')})

    def test_a_hard_task_takes_only_the_strongest(self):
        inst = load(instance([task('a', floor=2, difficulty='high')], [machine('m')],
                             [model('sonnet', cost=2, quality=2), model('opus', cost=3, quality=3)]))
        self.assertEqual(picks(greedy(inst)), {'a': ('m', 'opus')})

    def test_at_equal_cost_the_stronger_model_then_the_account_with_more_room(self):
        accounts = [{'id': 'x', 'members': [['x', 'claude']], 'budget': {'weekly': 20}},
                    {'id': 'y', 'members': [['y', 'claude']], 'budget': {'weekly': 50}}]
        inst = load(instance([task('a')], [machine('x'), machine('y')],
                             [model('sonnet', cost=2, quality=2), model('opus', cost=2, quality=3)], accounts))
        self.assertEqual(picks(greedy(inst)), {'a': ('y', 'opus')})

    def test_a_known_account_that_fits_comes_before_one_whose_quota_is_unknown(self):
        accounts = [{'id': 'b', 'members': [['b', 'claude']], 'budget': {'weekly': 50}}]
        inst = load(instance([task('t', spend={'weekly': 4})], [machine('a'), machine('b')], [model('opus')], accounts))
        self.assertEqual(picks(greedy(inst)), {'t': ('b', 'opus')})

    def test_skips_an_account_the_earlier_picks_have_used_up(self):
        accounts = [{'id': 'x', 'members': [['x', 'claude']], 'budget': {'5-hour': 40}},
                    {'id': 'y', 'members': [['y', 'claude']], 'budget': {'5-hour': 35}}]
        inst = load(instance([task('a', spend={'5-hour': 30}), task('b', spend={'5-hour': 30})],
                             [machine('x', slots=4), machine('y', slots=4)], [model('opus', cost=2)], accounts))
        self.assertEqual(picks(greedy(inst)), {'a': ('x', 'opus'), 'b': ('y', 'opus')})

    def test_ignores_the_queue_so_it_finishes_later_than_the_exact_plan(self):
        # The route always takes the cheap one-slot machine; the exact plan spends more to run both at once.
        inst = load(instance([task('a'), task('b')], [machine('cheap'), machine('dear', engines=['codex'])],
                             [model('haiku', cost=1), model('gpt', engine='codex', cost=3)]))
        self.assertEqual(greedy(inst).makespan, 120)
        self.assertEqual(solve(inst).makespan, 60)


if __name__ == '__main__':
    unittest.main()
