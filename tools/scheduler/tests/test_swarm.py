import copy
import unittest

from scheduler.instance import load
from scheduler.swarm import ConvertError, convert

POLICY = {
    'models': [
        {'engine': 'claude', 'model': 'opus', 'effort': 'high', 'quality': 3, 'cost': 3, 'enabled': True},
        {'engine': 'codex', 'model': 'default', 'effort': 'default', 'quality': 3, 'cost': 2, 'enabled': True},
        {'engine': 'claude', 'model': 'sonnet', 'effort': 'medium', 'quality': 2, 'cost': 2, 'enabled': True},
        {'engine': 'claude', 'model': 'haiku', 'effort': 'auto', 'quality': 1, 'cost': 1, 'enabled': False},
    ],
    'floor': {'low': 1, 'medium': 2, 'high': 3},
    'quotaReserve': 10,
    'localModels': {'quality': 1, 'enabled': True},
}


def machine(id, name, slots, quotas, local=(), received=1793044800000):
    return {'machineId': id, 'name': name, 'maxAgents': slots, 'engines': ['claude', 'codex', 'cursor'],
            'observation': {'quotas': quotas, 'localModels': list(local), 'receivedAt': received}}


def group(id, title, engine=None, model=None, machine_id=None):
    out = {'id': id, 'title': title, 'brief': '', 'assignment': None}
    if engine:
        out['assignment'] = {'status': 'done', 'configuration': {'engine': engine, 'model': model, 'effort': 'auto'},
                             'execution': {'machineId': machine_id}}
    return out


# The snapshot is read at the latest observation: 2026-10-26T21:00Z (m2); m1 was observed at 20:00Z.
# Codex reports resets in epoch seconds (1793480400 is 2026-10-31T21:00Z, 7200 minutes on), Claude as ISO strings.
WEEKLY_67 = {'engine': 'codex', 'known': True, 'windows': [{'name': '5-hour', 'usedPercent': 20, 'resetsAt': '2026-10-26T22:00:00+00:00'},
                                                           {'name': 'weekly', 'usedPercent': 67, 'resetsAt': 1793480400}]}
STATUS = {'value': {'state': {
    'machines': [
        machine('m1', 'Studio', 16, [{'engine': 'claude', 'known': False, 'windows': []}, WEEKLY_67],
                [{'grid': 'g', 'model': 'deepseek/flash', 'name': 'DeepSeek', 'kind': 'api'}]),
        machine('m2', 'Laptop', 1, [{'engine': 'claude', 'known': True, 'windows': [
            {'name': '5-hour', 'usedPercent': 3, 'resetsAt': '2026-10-26T20:30:00+00:00'},
            {'name': 'weekly', 'usedPercent': 72, 'resetsAt': '2026-10-30T14:59:59+00:00'}]}, WEEKLY_67], received=1793048400000),
        machine('m3', 'Banned', 8, [{'engine': 'claude', 'known': True, 'windows': [{'name': 'weekly', 'usedPercent': 10, 'resetsAt': 1793480400}]}]),
    ],
    'rules': [{'projectId': 'p', 'rule': {'kind': 'machines', 'machineIds': ['m1', 'm2']}, 'text': 'Owner: no Banned for now'}],
    'conversations': [
        group('lead', 'Lead'),
        group('g1', 'Build', 'claude', 'opus', 'm2'),
        group('g2', 'Review: Build', 'codex', 'gpt-6.1-sol', 'm1'),
        group('g3', 'Smoke: DeepSeek on Laptop', 'claude', 'deepseek/flash', 'm2'),
        group('g4', 'Docs', 'claude', 'sonnet', 'm1'),
    ],
}}}
ROUTE_LOG = [
    {'group': 'g1', 'request': {'difficulty': 'high', 'risk': 'high', 'size': 'large', 'kind': 'backend', 'why': 'b'}, 'at': '2026-10-26T10:00:00Z'},
    {'group': '$rg', 'request': {'difficulty': 'medium', 'risk': 'low', 'size': 'small', 'kind': 'review', 'why': 'r'}, 'at': '2026-10-26T11:00:00Z'},
]
CONFIG = {
    'policy': POLICY,
    'assessments': {
        'g2': {'route': 1, 'note': 'matched by time and title'},
        'g4': {'estimate': {'difficulty': 'low', 'risk': 'low', 'size': 'medium', 'kind': 'docs'}, 'note': 'no route request'},
    },
    'deps': {'g2': ['g1']},
    'exclude': {'g3': 'pinned by a person to one machine and model'},
}


class ConvertTest(unittest.TestCase):
    def setUp(self):
        self.out = convert(STATUS, ROUTE_LOG, CONFIG)
        self.inst = load(self.out['instance'])

    def test_machines_keep_their_slots_and_only_the_policy_engines(self):
        self.assertEqual([(m.id, m.name, m.slots, m.engines) for m in self.inst.machines],
                         [('m1', 'Studio', 16, ('claude', 'codex')), ('m2', 'Laptop', 1, ('claude', 'codex'))])

    def test_enabled_policy_rows_and_the_shared_api_model_become_models(self):
        got = {m.id: (m.engine, m.cost, m.quality['default'], m.concurrency, m.subscription) for m in self.inst.models}
        self.assertEqual(got, {'claude-opus': ('claude', 3, 3, None, True), 'codex-default': ('codex', 2, 3, None, True),
                               'claude-sonnet': ('claude', 2, 2, None, True), 'grid-deepseek/flash': ('claude', 1, 1, 4, False)})

    def test_weekly_quota_less_the_reserve_is_the_budget_and_identical_readings_share_an_account(self):
        out = convert(STATUS, ROUTE_LOG, {**CONFIG, 'budget': 'now'})
        got = sorted((tuple(map(tuple, a['members'])), a['budget']) for a in out['instance']['accounts'])
        self.assertEqual(got, [((('m1', 'codex'), ('m2', 'codex')), {'weekly': 23.0}), ((('m2', 'claude'),), {'weekly': 18.0})])

    def test_by_default_the_budget_is_the_start_of_the_night_with_the_actual_picks_spend_added_back(self):
        # g1: large on Opus takes 8 x 3 / 2 = 12 from m2's Claude account; g2: small on Codex takes 1 from the shared one.
        got = sorted((a.members, a.budget) for a in self.inst.accounts)
        self.assertEqual(got, [((('m1', 'codex'), ('m2', 'codex')), {'weekly': 24.0}), ((('m2', 'claude'),), {'weekly': 30.0})])

    def test_quota_windows_are_read_at_the_snapshot_with_resets_in_minutes_and_a_past_reset_refilled(self):
        got = sorted((a.members, [(w.name, w.left, w.resets_in) for w in a.windows], a.reserve) for a in self.inst.accounts)
        # Weekly left includes what the actual picks spent (start of the night); the 5-hour readings are as read.
        self.assertEqual(got, [
            ((('m1', 'codex'), ('m2', 'codex')), [('5-hour', 80.0, 60), ('weekly', 34.0, 7200)], 10.0),
            ((('m2', 'claude'),), [('5-hour', 100.0, None), ('weekly', 40.0, 5400)], 10.0)])

    def test_added_back_spend_never_takes_a_window_past_full(self):
        # m2's Claude weekly: 5% used, so 95 left; adding back g1's 12 would give 107, more than a window holds.
        status = copy.deepcopy(STATUS)
        status['value']['state']['machines'][1]['observation']['quotas'][0]['windows'][1]['usedPercent'] = 5
        claude = next(a for a in load(convert(status, ROUTE_LOG, CONFIG)['instance']).accounts if a.members == (('m2', 'claude'),))
        self.assertEqual((claude.windows[1].left, claude.budget), (100.0, {'weekly': 90.0}))

    def test_an_owner_rule_naming_machines_leaves_the_others_out(self):
        self.assertNotIn('m3', [m.id for m in self.inst.machines])
        self.assertFalse([a for a in self.inst.accounts if any(m == 'm3' for m, _ in a.members)])

    def test_models_carry_the_words_of_the_routes_candidate_title(self):
        got = {m.id: m.label for m in self.inst.models}
        self.assertEqual(got, {'claude-opus': 'Claude opus high', 'codex-default': 'Codex default default',
                               'claude-sonnet': 'Claude sonnet medium', 'grid-deepseek/flash': 'Claude on DeepSeek (API)'})

    def test_a_task_takes_its_assessment_from_the_route_log(self):
        t = self.inst.task('g1')
        self.assertEqual((t.minutes, t.floor, t.kind, t.difficulty, t.spend), (180, 3, 'backend', 'high', {'5-hour': 50, 'weekly': 8}))

    def test_a_hand_matched_request_and_an_estimate_are_used_and_listed_as_estimates(self):
        self.assertEqual((self.inst.task('g2').minutes, self.inst.task('g2').floor), (20, 2))
        self.assertEqual((self.inst.task('g4').minutes, self.inst.task('g4').floor), (60, 1))
        self.assertEqual(sorted(e['group'] for e in self.out['estimates']), ['g2', 'g4'])

    def test_dependencies_come_from_the_config(self):
        self.assertEqual(self.inst.task('g2').deps, ('g1',))

    def test_a_review_must_differ_from_the_work_it_depends_on(self):
        self.assertEqual(self.inst.task('g2').independent_of, ('g1',))
        self.assertEqual(self.inst.task('g1').independent_of, ())

    def test_a_grid_model_is_its_own_family(self):
        self.assertEqual(self.inst.model('grid-deepseek/flash').family, 'deepseek/flash')

    def test_groups_without_work_and_excluded_groups_are_left_out(self):
        self.assertEqual([t.id for t in self.inst.tasks], ['g1', 'g2', 'g4'])
        self.assertEqual(self.out['excluded'], [{'group': 'g3', 'title': 'Smoke: DeepSeek on Laptop', 'reason': 'pinned by a person to one machine and model'}])

    def test_actual_picks_map_each_assignment_to_its_model_row(self):
        self.assertEqual(self.out['actual'], {'g1': ['m2', 'claude-opus'], 'g2': ['m1', 'codex-default'], 'g4': ['m1', 'claude-sonnet']})

    def test_a_dependency_on_an_unknown_group_is_refused(self):
        with self.assertRaisesRegex(ConvertError, 'g2 depends on g9'):
            convert(STATUS, ROUTE_LOG, {**CONFIG, 'deps': {'g2': ['g9']}})

    def test_a_group_with_no_assessment_is_refused(self):
        with self.assertRaisesRegex(ConvertError, 'no assessment for g4'):
            convert(STATUS, ROUTE_LOG, {**CONFIG, 'assessments': {'g2': CONFIG['assessments']['g2']}})


if __name__ == '__main__':
    unittest.main()
