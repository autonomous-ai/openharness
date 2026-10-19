import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/shared_tab_tasks.dart'
    show taskRosterHarness;
import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/agent_messages/shared_tabs_model.dart';
import 'package:harness/agent_messages/task_step.dart';

SharedTaskRow _row({String state = 'open', Map<String, Object?>? pr}) =>
    SharedTaskRow.fromJson({
      'repo': 'o/r',
      'issue': 1,
      'title': 'T',
      'url': 'https://github.com/o/r/issues/1',
      'state': state,
      'pr': ?pr,
    })!;

Map<String, Object?> _pr(
  String state, {
  String ci = 'none',
  bool autoMerge = false,
  Map<String, Object?> extra = const {},
}) => {
  'number': 7,
  'url': 'https://github.com/o/r/pull/7',
  'state': state,
  'ci': ci,
  'autoMerge': autoMerge,
  'mergeState': 'CLEAN',
  ...extra,
};

void main() {
  group('taskStep', () {
    TaskStep step(SharedTaskRow row, {bool working = false}) =>
        taskStep(row, assigneeWorking: working);

    test('a merged pull request is merged, whatever else is true', () {
      expect(
        step(_row(state: 'closed', pr: _pr('Merged', autoMerge: true))),
        TaskStep.merged,
      );
    });
    test('a closed pull request on an open issue is pull request closed', () {
      expect(step(_row(pr: _pr('Closed'))), TaskStep.prClosed);
    });
    test('a closed pull request on a closed issue is closed', () {
      expect(step(_row(state: 'closed', pr: _pr('Closed'))), TaskStep.closed);
    });
    test('auto-merge on is merging', () {
      expect(
        step(_row(pr: _pr('Open', ci: 'failing', autoMerge: true))),
        TaskStep.merging,
      );
    });
    // gh cannot read the merge queue (final review C1): "merging" is
    // auto-merge only, and a stray `inQueue` on the wire changes nothing.
    test('a merge-queue flag is not read: merging is auto-merge only', () {
      expect(
        step(_row(pr: _pr('Open', extra: {'inQueue': true}))),
        TaskStep.waitingForReview,
      );
    });
    test('failing CI is build failed', () {
      expect(step(_row(pr: _pr('Open', ci: 'failing'))), TaskStep.buildFailed);
    });
    test('pending CI is building', () {
      expect(step(_row(pr: _pr('Open', ci: 'pending'))), TaskStep.building);
    });
    test('a draft with pending CI is building', () {
      expect(step(_row(pr: _pr('Draft', ci: 'pending'))), TaskStep.building);
    });
    test('an open pull request with passing or no CI waits for review', () {
      expect(
        step(_row(pr: _pr('Open', ci: 'passing'))),
        TaskStep.waitingForReview,
      );
      expect(step(_row(pr: _pr('Open'))), TaskStep.waitingForReview);
    });
    test('a draft without a build is working (draft)', () {
      expect(step(_row(pr: _pr('Draft'))), TaskStep.workingDraft);
    });
    test('no pull request on a closed issue is closed', () {
      expect(step(_row(state: 'closed'), working: true), TaskStep.closed);
    });
    test('an unknown pull request state falls to the assignee', () {
      expect(step(_row(pr: _pr('Weird')), working: true), TaskStep.working);
    });
    test(
      'no pull request: working when the assignee works, else not started',
      () {
        expect(step(_row(), working: true), TaskStep.working);
        expect(step(_row()), TaskStep.notStarted);
      },
    );
  });

  test('every step has its words', () {
    expect(
      {for (final s in TaskStep.values) s: taskStepLabel(s)},
      {
        TaskStep.merged: 'merged',
        TaskStep.prClosed: 'pull request closed',
        TaskStep.merging: 'merging',
        TaskStep.buildFailed: 'build failed',
        TaskStep.building: 'building',
        TaskStep.waitingForReview: 'waiting for review',
        TaskStep.workingDraft: 'working (draft)',
        TaskStep.closed: 'closed',
        TaskStep.working: 'working',
        TaskStep.notStarted: 'not started',
      },
    );
  });

  test('a pull request parses its merge fields, with defaults', () {
    final full = _row(pr: _pr('Open')).pr!;
    expect((full.autoMerge, full.mergeState), (false, 'CLEAN'));
    final bare = SharedTaskRow.fromJson({
      'repo': 'o/r',
      'issue': 1,
      'url': 'u',
      'state': 'open',
      'pr': {'number': 3, 'url': 'p'},
    })!.pr!;
    expect((bare.autoMerge, bare.mergeState), (false, ''));
    expect(bare.ci, 'none');
  });

  test('markerLabel mirrors the daemon\'s', () {
    expect(markerLabel('a+b@x.com'), 'a-b');
    expect(markerLabel('first.last+x@y.io'), 'first.last-x');
    expect(markerLabel('a+-+b@x.com'), 'a-b');
    expect(markerLabel('+a+@x.com'), 'a');
    expect(markerLabel('bob_1.x-y@y.io'), 'bob_1.x-y');
    expect(markerLabel('${'x' * 70}@y.io'), 'x' * 64);
    expect(markerLabel('${'x' * 63}+yyy@y.io'), 'x' * 63);
    expect(markerLabel('+++@y.io'), 'account');
    expect(markerLabel('nobody'), 'nobody');
    expect(markerLabel('b\u202Eob\u0007@y.io'), 'bob');
    expect(markerLabel('@y.io'), 'y.io');
  });

  // The note names each harness by its marker name, with the start of its id
  // when two share a name (final review I2); the roster harness maps back.
  test(
    'a roster harness is found by its marker name, a shared name by its id',
    () {
      SharedTabHarness h(String agentId, String name) => SharedTabHarness(
        accountId: 'u-alice',
        machineId: 'ma',
        agentId: agentId,
        name: name,
        engine: 'claude',
      );
      final tab = SharedTab(
        sharedTabId: 's1',
        ownerTabId: null,
        name: 'app',
        version: 1,
        ownerAccountId: 'u-alice',
        ownerEmail: 'alice@example.com',
        ownerMachineId: 'ma',
        leader: null,
        members: const [],
        harnesses: [
          h('x1', 'Fix login test'),
          h('aaaa1111bbbb', 'app'),
          h('cccc2222dddd', 'app'),
        ],
        invites: const [],
      );
      String? found(String harness) => taskRosterHarness(tab, (
        accountId: 'alice',
        harness: harness,
      ))?.agentId;
      expect(found('fix-login-test'), 'x1');
      expect(found('Fix login test'), 'x1', reason: 'as the name, before I2');
      expect(found('app-aaaa1111'), 'aaaa1111bbbb');
      expect(found('app-cccc2222'), 'cccc2222dddd');
      expect(found('app-eeee3333'), isNull);
      expect(found('other'), isNull);
    },
  );

  // Two harnesses whose marker names collide are told "<markerName>-<id start>"
  // in the note (the daemon's `markerNameWithId`); each maps to its own.
  test('harnesses whose marker names collide are found by their own id, never first-match', () {
    SharedTabHarness h(String agentId, String name) => SharedTabHarness(
      accountId: 'u-alice',
      machineId: 'ma',
      agentId: agentId,
      name: name,
      engine: 'claude',
    );
    SharedTab tabOf(List<SharedTabHarness> hs) => SharedTab(
      sharedTabId: 's1',
      ownerTabId: null,
      name: 'app',
      version: 1,
      ownerAccountId: 'u-alice',
      ownerEmail: 'alice@example.com',
      ownerMachineId: 'ma',
      leader: null,
      members: const [],
      harnesses: hs,
      invites: const [],
    );
    String? found(SharedTab tab, String harness) =>
        taskRosterHarness(tab, (accountId: 'alice', harness: harness))?.agentId;
    final login = tabOf([
      h('aaaa1111zzzz', 'Fix login test'),
      h('bbbb2222zzzz', 'fix (login) test'),
      h('cccc3333zzzz', 'api'),
    ]);
    expect(found(login, 'fix-login-test-aaaa1111'), 'aaaa1111zzzz');
    expect(found(login, 'fix-login-test-bbbb2222'), 'bbbb2222zzzz');
    expect(
      found(login, 'fix-login-test'),
      isNull,
      reason: 'two, not the first',
    );
    expect(found(login, 'api'), 'cccc3333zzzz');
    final cjk = tabOf([h('aaaa1111zzzz', '修复登录'), h('bbbb2222zzzz', '修复注册')]);
    expect(found(cjk, 'harness-aaaa1111'), 'aaaa1111zzzz');
    expect(found(cjk, 'harness-bbbb2222'), 'bbbb2222zzzz');
    expect(found(cjk, 'harness'), isNull);
    // A long name is cut so the id start fits in 64.
    final long = tabOf([
      h('aaaa1111zzzz', 'x' * 64),
      h('bbbb2222zzzz', '${'X' * 64} y'),
    ]);
    expect(found(long, '${'x' * 55}-aaaa1111'), 'aaaa1111zzzz');
    expect(found(long, '${'x' * 55}-bbbb2222'), 'bbbb2222zzzz');
  });

  // The daemon's `markerName` (sharedDirectory.ts), vector for vector.
  test('markerName mirrors the daemon\'s', () {
    expect(markerName('Fix login test'), 'fix-login-test');
    expect(markerName('app (1a2b)'), 'app-1a2b');
    expect(markerName('api.v2'), 'api.v2');
    expect(markerName('bob_1.x-y'), 'bob_1.x-y');
    expect(markerName('Fix  --  Login'), 'fix-login');
    expect(markerName('Ünï cødé'), 'n-c-d');
    expect(markerName('b\u202Eo\u0007b'), 'bob');
    expect(markerName('x' * 70), 'x' * 64);
    expect(markerName('${'x' * 63} yyy'), 'x' * 63);
    expect(markerName('((('), 'harness');
    expect(markerName(''), 'harness');
  });
}
