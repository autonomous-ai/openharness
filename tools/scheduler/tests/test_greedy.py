import unittest

from scheduler.greedy import Decision, Sized, evaluate, greedy, size_up
from scheduler.instance import Option, load
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

    def test_two_accounts_of_one_machine_queue_on_its_slots(self):
        inst = load(instance([task('a'), task('b')], [machine('mac', slots=1), {**machine('team', slots=1), 'pool': 'mac'}], [model('opus')]))
        self.assertEqual(evaluate(inst, {'a': ('mac', 'opus'), 'b': ('team', 'opus')}).makespan, 120)

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

    def test_a_review_skips_the_family_its_build_was_given(self):
        inst = load(instance([task('build'), task('review', deps=['build'], independent_of=['build'])],
                             [machine('m', slots=2, engines=['claude', 'codex'])],
                             [model('gpt', engine='codex', cost=2), model('opus', cost=3)]))
        self.assertEqual(picks(greedy(inst)), {'build': ('m', 'gpt'), 'review': ('m', 'opus')})

    def test_ignores_the_queue_so_it_finishes_later_than_the_exact_plan(self):
        # The route always takes the cheap one-slot machine; the exact plan spends more to run both at once.
        inst = load(instance([task('a'), task('b')], [machine('cheap'), machine('dear', engines=['codex'])],
                             [model('haiku', cost=1), model('gpt', engine='codex', cost=3)]))
        self.assertEqual(greedy(inst).makespan, 120)
        self.assertEqual(solve(inst).makespan, 60)


def account(id, machine, engine='claude', reserve=10, **windows):
    """windows: name -> (left, resets_in); `five` is the 5-hour window."""
    named = {'five': '5-hour', 'weekly': 'weekly'}
    return {'id': id, 'members': [[machine, engine]], 'reserve': reserve,
            'windows': [{'name': named[k], 'left': v[0], 'resets_in': v[1]} for k, v in windows.items()]}


LARGE = {'5-hour': 50, 'weekly': 8}
MEDIUM = {'5-hour': 30, 'weekly': 4}


class RouteQuotaTest(unittest.TestCase):
    """route.ts sizeUp and compare: effective cost before cost, on the quota readings at the time each task is routed."""

    def reset_case(self, resets_in):
        return load(instance([task('t', minutes=180, floor=3, difficulty='high', spend=LARGE)],
                             [machine('a'), machine('b', engines=['codex'])],
                             [model('opus', cost=3), model('gpt', engine='codex', cost=2)],
                             [account('ca', 'a', five=(50, resets_in), weekly=(80, 7200)), account('cb', 'b', 'codex', weekly=(80, 7200))]))

    def test_near_a_5_hour_reset_the_unused_window_makes_opus_free_so_it_beats_cheaper_codex(self):
        # Resets in 30 minutes: the task needs 50 x 3/2 x 30/180 = 12.5 of the window and 40 is usable, otherwise lost.
        self.assertEqual(picks(greedy(self.reset_case(30))), {'t': ('a', 'opus')})

    def test_far_from_the_reset_cheaper_codex_wins(self):
        self.assertEqual(picks(greedy(self.reset_case(600))), {'t': ('b', 'gpt')})

    def test_a_task_that_is_not_hard_pays_for_more_than_a_days_share_of_the_weekly_window(self):
        # Codex: 10 usable over 7 days is 1.43 a day against 4 needed, so its cost 2 becomes 2 + 2 x 4/1.43 = 7.6 > Opus's 3.
        inst = load(instance([task('t', floor=2, difficulty='medium', spend=MEDIUM)],
                             [machine('x', engines=['codex']), machine('y')],
                             [model('gpt', engine='codex', cost=2), model('opus', cost=3)],
                             [account('cx', 'x', 'codex', weekly=(20, 10080)), account('cy', 'y', five=(100, None), weekly=(90, 1440))]))
        self.assertEqual(picks(greedy(inst)), {'t': ('y', 'opus')})

    def refill_case(self):
        return load(instance([task('a', spend=MEDIUM), task('b', deps=['a'], spend=MEDIUM)],
                             [machine('x', slots=2), machine('y', slots=2)], [model('opus', cost=2)],
                             [account('ax', 'x', five=(15, 30), weekly=(90, 10000)), account('ay', 'y', five=(100, None), weekly=(90, 10000))]))

    def test_a_5_hour_window_refills_at_its_reset(self):
        # x's window has 15 left and resets at minute 30. Read at minute 60 it is full again: 100 - 10 reserve = 90
        # usable against the 30 a medium task needs, and its next reset is 270 minutes away, so nothing is free.
        inst = self.refill_case()
        got = size_up(inst, inst.task('b'), Option('b', 'x', 'opus', 60), 60, [])
        self.assertEqual(got, Sized('fits', 3.0, 2.0, 90.0))

    def test_work_that_has_run_uses_the_window_and_a_finished_pick_holds_nothing(self):
        # a ran on y from 0 to 60, using its 30: read at 60, y has 100 - 30 - 10 = 60 usable and a holds no more.
        inst = self.refill_case()
        ran = [Decision(inst.task('a'), 'y', 'opus', at=0, start=0, end=60)]
        got = size_up(inst, inst.task('b'), Option('b', 'y', 'opus', 60), 60, ran)
        self.assertEqual(got, Sized('fits', 2.0, 2.0, 60.0))

    def test_an_open_pick_holds_the_rest_of_its_spend(self):
        # a, routed at 0 and still running at 30, has used 15 and holds the other 15: 100 - 15 - 15 - 10 = 60.
        inst = self.refill_case()
        running = [Decision(inst.task('a'), 'y', 'opus', at=0, start=0, end=60)]
        self.assertEqual(size_up(inst, inst.task('b'), Option('b', 'y', 'opus', 60), 30, running).tight, 60.0)

    def test_a_task_routed_after_the_reset_goes_to_the_refilled_account(self):
        # a, at 0: x has 5 usable, short of the 15 it needs before the reset, so a goes to y. b, at 60: x has 90, y 60.
        self.assertEqual(picks(greedy(self.refill_case())), {'a': ('y', 'opus'), 'b': ('x', 'opus')})

    def test_with_nothing_at_its_floor_the_route_takes_the_best_below_it(self):
        inst = load(instance([task('t', floor=3)], [machine('m')], [model('haiku', cost=1, quality=1)]))
        self.assertEqual(picks(greedy(inst)), {'t': ('m', 'haiku')})


if __name__ == '__main__':
    unittest.main()
