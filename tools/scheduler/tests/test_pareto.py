import unittest

from scheduler.instance import load
from scheduler.solver import pareto
from tests.helpers import instance, machine, model, task


class ParetoTest(unittest.TestCase):
    def test_two_tasks_on_a_cheap_and_a_dear_machine(self):
        # Both on the cheap machine: 120 minutes, cost 120. Split: 60 minutes, cost 60 + 180. Both on the dear one: 120
        # minutes, cost 360, dominated by the first.
        inst = load(instance([task('a'), task('b')], [machine('cheap'), machine('dear', engines=['codex'])],
                             [model('haiku', cost=1), model('gpt', engine='codex', cost=3)]))
        front = pareto(inst)
        self.assertTrue(front.complete)
        self.assertEqual([(p.makespan, p.cost) for p in front.points], [(60, 240), (120, 120)])

    def test_three_points_when_a_middle_plan_trades_time_for_cost(self):
        # Three 60-minute tasks; cheap has one slot at cost 1, dear one slot at cost 3.
        # All cheap: 180 / 180. Two cheap, one dear: 120 / 120 + 180 = 300. Splitting further cannot beat 120 minutes.
        inst = load(instance([task('a'), task('b'), task('c')], [machine('cheap'), machine('dear', engines=['codex'])],
                             [model('haiku', cost=1), model('gpt', engine='codex', cost=3)]))
        front = pareto(inst)
        self.assertEqual([(p.makespan, p.cost) for p in front.points], [(120, 300), (180, 180)])

    def test_a_single_plan_is_a_single_point(self):
        inst = load(instance([task('a')], [machine('m')], [model('opus', cost=3)]))
        self.assertEqual([(p.makespan, p.cost) for p in pareto(inst).points], [(60, 180)])


if __name__ == '__main__':
    unittest.main()
