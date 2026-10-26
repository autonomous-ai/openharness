import unittest

from scheduler.instance import load
from scheduler.solver import solve
from tests.helpers import instance, machine, model, task


def placed(result):
    return {p.task: p for p in result.plan}


class FloorTest(unittest.TestCase):
    def test_a_cheaper_model_below_the_floor_is_never_used(self):
        inst = load(instance([task('a', floor=3)], [machine('m')], [model('haiku', cost=1, quality=1), model('opus', cost=3, quality=3)]))
        result = solve(inst)
        self.assertEqual(result.status, 'OPTIMAL')
        self.assertEqual(placed(result)['a'].model, 'opus')

    def test_no_model_meeting_the_floor_is_infeasible_and_names_the_task(self):
        inst = load(instance([task('a', floor=3)], [machine('m')], [model('haiku', quality=1)]))
        result = solve(inst)
        self.assertEqual(result.status, 'INFEASIBLE')
        self.assertIn('a', result.reason)


class DependencyTest(unittest.TestCase):
    def test_a_task_starts_after_the_task_it_depends_on_ends(self):
        inst = load(instance([task('build', minutes=60), task('review', minutes=20, deps=['build'])],
                             [machine('m1'), machine('m2')], [model('opus')]))
        result = solve(inst)
        p = placed(result)
        self.assertGreaterEqual(p['review'].start, p['build'].end)
        self.assertEqual(result.makespan, 80)


class SlotTest(unittest.TestCase):
    def test_one_slot_runs_tasks_one_after_another(self):
        inst = load(instance([task('a'), task('b'), task('c')], [machine('m', slots=1)], [model('opus')]))
        self.assertEqual(solve(inst).makespan, 180)

    def test_two_slots_run_two_at_a_time(self):
        inst = load(instance([task('a'), task('b'), task('c')], [machine('m', slots=2)], [model('opus')]))
        result = solve(inst)
        self.assertEqual(result.makespan, 120)
        for t in range(0, 120):
            running = sum(1 for p in result.plan if p.start <= t < p.end)
            self.assertLessEqual(running, 2)

    def test_a_local_model_serves_one_task_at_a_time_whatever_the_slots(self):
        inst = load(instance([task('a'), task('b')], [machine('m', slots=4)], [model('local', concurrency=1)]))
        self.assertEqual(solve(inst).makespan, 120)


class QuotaTest(unittest.TestCase):
    def test_an_account_short_of_quota_takes_only_what_fits(self):
        # Each task spends 30% of the 5-hour window at cost 2; the cheap account has 40% left, so it carries one task.
        tasks = [task('a', spend={'5-hour': 30}), task('b', spend={'5-hour': 30})]
        inst = load(instance(tasks, [machine('cheap', slots=2), machine('dear', slots=2, engines=['codex'])],
                             [model('opus', cost=2), model('gpt', engine='codex', cost=3)],
                             [{'id': 'acct', 'members': [['cheap', 'claude']], 'budget': {'5-hour': 40}}]))
        result = solve(inst)
        self.assertEqual(sorted(p.machine for p in result.plan), ['cheap', 'dear'])

    def test_a_model_outside_the_subscription_spends_no_quota(self):
        tasks = [task('a', spend={'5-hour': 30}), task('b', spend={'5-hour': 30})]
        inst = load(instance(tasks, [machine('m', slots=2)], [model('api', cost=1, subscription=False)],
                             [{'id': 'acct', 'members': [['m', 'claude']], 'budget': {'5-hour': 0}}]))
        result = solve(inst)
        self.assertEqual(result.status, 'OPTIMAL')
        self.assertEqual(len(result.plan), 2)


class IndependenceTest(unittest.TestCase):
    def test_a_review_uses_another_model_family_than_the_work_it_reviews(self):
        # Codex is cheaper for both, but the review must not be Codex if the build is.
        inst = load(instance([task('build'), task('review', minutes=20, deps=['build'], independent_of=['build'])],
                             [machine('m', slots=2, engines=['claude', 'codex'])],
                             [model('gpt', engine='codex', cost=2), model('opus', cost=3)]))
        result = solve(inst)
        p = placed(result)
        self.assertNotEqual(inst.model(p['build'].model).family, inst.model(p['review'].model).family)
        self.assertEqual(result.cost, 60 * 2 + 20 * 3)

    def test_models_of_one_engine_share_a_family_unless_given_one(self):
        inst = load(instance([task('a')], [machine('m')], [model('opus'), model('grid', family='deepseek')]))
        self.assertEqual((inst.model('opus').family, inst.model('grid').family), ('claude', 'deepseek'))


class ObjectiveTest(unittest.TestCase):
    def test_finish_time_comes_before_cost(self):
        # One slot each: both on the cheap machine take 120 minutes; splitting finishes at 60 and costs more.
        inst = load(instance([task('a'), task('b')], [machine('cheap'), machine('dear', engines=['codex'])],
                             [model('haiku', cost=1), model('gpt', engine='codex', cost=3)]))
        result = solve(inst)
        self.assertEqual(result.makespan, 60)
        self.assertEqual(result.cost, 60 * 1 + 60 * 3)

    def test_among_the_fastest_plans_the_cheapest_wins(self):
        inst = load(instance([task('a'), task('b')], [machine('m', slots=2)], [model('opus', cost=3), model('sonnet', cost=2)]))
        result = solve(inst)
        self.assertEqual(result.makespan, 60)
        self.assertEqual(result.cost, 240)
        self.assertEqual({p.model for p in result.plan}, {'sonnet'})

    def test_reports_proven_optimal_with_zero_gap(self):
        inst = load(instance([task('a')], [machine('m')], [model('opus')]))
        result = solve(inst)
        self.assertEqual(result.status, 'OPTIMAL')
        self.assertEqual(result.makespan_bound, result.makespan)
        self.assertEqual(result.cost_bound, result.cost)
        self.assertEqual(result.gap, 0.0)


if __name__ == '__main__':
    unittest.main()
