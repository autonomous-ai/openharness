import unittest

from scheduler.instance import InstanceError, load, options
from tests.helpers import instance, machine, model, task


class LoadTest(unittest.TestCase):
    def test_reads_a_valid_instance(self):
        inst = load(instance([task('a', minutes=30, floor=2, kind='review')], [machine('m', slots=2)], [model('opus', cost=3)]))
        self.assertEqual(inst.tasks[0].minutes, 30)
        self.assertEqual(inst.tasks[0].kind, 'review')
        self.assertEqual(inst.machines[0].slots, 2)
        self.assertEqual(inst.models[0].cost, 3)

    def test_refuses_a_dependency_on_an_unknown_task(self):
        with self.assertRaisesRegex(InstanceError, 'a depends on unknown task b'):
            load(instance([task('a', deps=['b'])], [machine('m')], [model('opus')]))

    def test_refuses_a_dependency_cycle(self):
        with self.assertRaisesRegex(InstanceError, 'cycle'):
            load(instance([task('a', deps=['b']), task('b', deps=['a'])], [machine('m')], [model('opus')]))

    def test_refuses_duplicate_task_ids(self):
        with self.assertRaisesRegex(InstanceError, 'duplicate task a'):
            load(instance([task('a'), task('a')], [machine('m')], [model('opus')]))

    def test_refuses_a_model_without_default_quality(self):
        with self.assertRaisesRegex(InstanceError, 'opus has no default quality'):
            load(instance([task('a')], [machine('m')], [model('opus', quality={'review': 3})]))

    def test_refuses_independence_from_an_unknown_task(self):
        with self.assertRaisesRegex(InstanceError, 'a must differ from unknown task b'):
            load(instance([task('a', independent_of=['b'])], [machine('m')], [model('opus')]))

    def test_refuses_an_account_on_an_unknown_machine(self):
        with self.assertRaisesRegex(InstanceError, 'account x names unknown machine z'):
            load(instance([task('a')], [machine('m')], [model('opus')],
                          [{'id': 'x', 'members': [['z', 'claude']], 'budget': {'weekly': 10}}]))


class AccountTest(unittest.TestCase):
    def test_windows_default_to_the_budget_with_no_reset_and_no_reserve(self):
        inst = load(instance([task('a')], [machine('m')], [model('opus')],
                             [{'id': 'x', 'members': [['m', 'claude']], 'budget': {'weekly': 40}}]))
        w = inst.accounts[0].windows
        self.assertEqual([(x.name, x.left, x.resets_in) for x in w], [('weekly', 40.0, None)])
        self.assertEqual(inst.accounts[0].reserve, 0.0)

    def test_the_budget_defaults_to_the_weekly_window_less_the_reserve(self):
        inst = load(instance([task('a')], [machine('m')], [model('opus')],
                             [{'id': 'x', 'members': [['m', 'claude']], 'reserve': 10,
                               'windows': [{'name': '5-hour', 'left': 90, 'resets_in': 30}, {'name': 'weekly', 'left': 50, 'resets_in': 5000}]}]))
        self.assertEqual(inst.accounts[0].budget, {'weekly': 40.0})


class OptionsTest(unittest.TestCase):
    def test_only_models_meeting_the_floor_on_machines_with_their_engine(self):
        inst = load(instance(
            [task('a', floor=2)],
            [machine('m1', engines=['claude']), machine('m2', engines=['codex'])],
            [model('haiku', quality=1), model('opus', quality=3), model('gpt', engine='codex', quality=2)]))
        got = sorted((o.machine, o.model) for o in options(inst, inst.tasks[0]))
        self.assertEqual(got, [('m1', 'opus'), ('m2', 'gpt')])

    def test_quality_for_the_task_kind_overrides_the_default(self):
        inst = load(instance([task('r', floor=3, kind='review')], [machine('m')],
                             [model('sonnet', quality={'default': 2, 'review': 3})]))
        self.assertEqual([o.model for o in options(inst, inst.tasks[0])], ['sonnet'])

    def test_a_slower_model_takes_longer(self):
        inst = load(instance([task('a', minutes=60)], [machine('m')], [model('local', speed=0.5)]))
        self.assertEqual(options(inst, inst.tasks[0])[0].minutes, 120)

    def test_a_family_the_task_must_avoid_is_never_offered(self):
        # A review whose build already ran on Codex: Codex is off the table even though it meets the floor.
        inst = load(instance([task('r', avoid_families=['codex'])], [machine('m', engines=['claude', 'codex'])],
                             [model('opus'), model('gpt', engine='codex')]))
        self.assertEqual([o.model for o in options(inst, inst.tasks[0])], ['opus'])

    def test_a_task_limited_to_some_machines_and_models_is_offered_only_those(self):
        # The owner's rules for the task's project: only machine m2, and no Sonnet.
        inst = load(instance([task('a', machines=['m2'], models=['opus'])], [machine('m1'), machine('m2')],
                             [model('opus'), model('sonnet')]))
        self.assertEqual([(o.machine, o.model) for o in options(inst, inst.tasks[0])], [('m2', 'opus')])

    def test_refuses_a_task_limited_to_an_unknown_machine_or_model(self):
        with self.assertRaisesRegex(InstanceError, 'a names unknown machine z'):
            load(instance([task('a', machines=['z'])], [machine('m')], [model('opus')]))
        with self.assertRaisesRegex(InstanceError, 'a names unknown model z'):
            load(instance([task('a', models=['z'])], [machine('m')], [model('opus')]))

    def test_a_model_limited_to_some_machines_is_offered_only_there(self):
        inst = load(instance([task('a')], [machine('m1'), machine('m2')], [model('local', machines=['m2'])]))
        self.assertEqual([o.machine for o in options(inst, inst.tasks[0])], ['m2'])


if __name__ == '__main__':
    unittest.main()
