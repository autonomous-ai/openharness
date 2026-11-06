import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/parts.dart';

import 'super_tab_parts_test.dart' show recorded;

Map<String, dynamic> task(String id, int version, int at) => {
  'id': id,
  'version': version,
  'at': at,
  'projectId': 'lead5701',
  'projectName': 'Old project',
  'title': 'Task $id',
  'status': 'proposal',
  'canApprove': true,
  'suggested': true,
  'agent': {'id': '0540', 'name': 'Old name'},
};
Map<String, dynamic> feed(
  List<Map<String, dynamic>> rows, {
  bool reset = false,
  List<String> removed = const [],
  String mode = 'autoApprove',
  String? olderCursor,
}) => {
  'approvalMode': mode,
  'reset': reset,
  'upserts': rows,
  'removed': removed,
  'olderCursor': ?olderCursor,
};
void main() {
  test('old backend has no capability; first load sorts newest then id', () {
    expect(
      SuperTabParts.firstLoad(recorded('first_load')).personalTasks.supported,
      isFalse,
    );
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed([
          task('b', 2, 10),
          task('a', 1, 20),
          task('c', 1, 10),
        ], reset: true),
    );
    expect(parts.personalTasks.supported, isTrue);
    expect(parts.personalTasks.mode, 'autoApprove');
    expect(parts.personalTasks.rows.map((r) => r.id), ['a', 'b', 'c']);
  });
  test('overlap keeps newest version and marks feed changes as content', () {
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed([task('a', 3, 20)], reset: true),
    );
    final changed = parts.apply(
      recorded('changes')
        ..['personalTasks'] = feed([
          task('a', 2, 5),
          task('b', 1, 30),
        ], mode: 'review'),
    );
    expect(parts.personalTasks.rows.map((r) => r.id), ['b', 'a']);
    expect(parts.personalTasks.rows.last.version, 3);
    expect(parts.personalTasks.mode, 'review');
    expect(changed.changed, isTrue);
    expect(changed.machinesOnly, isFalse);
    expect(changed.readMarksOnly, isFalse);
  });
  test('removals and visibility reset discard old rows', () {
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed([
          task('a', 3, 20),
          task('b', 1, 30),
        ], reset: true),
    );
    parts.apply(
      recorded('changes')..['personalTasks'] = feed([], removed: ['a']),
    );
    expect(parts.personalTasks.rows.map((r) => r.id), ['b']);
    parts.apply(
      recorded('changes')
        ..['personalTasks'] = feed([task('c', 1, 40)], reset: true),
    );
    expect(parts.personalTasks.rows.single.id, 'c');
  });
  test(
    'cache round trip keeps mode and summaries; omitted delta keeps capability',
    () {
      final parts = SuperTabParts.firstLoad(
        recorded('first_load')
          ..['personalTasks'] = feed(
            [task('a', 3, 20)],
            reset: true,
            mode: 'review',
          ),
      );
      final restored = SuperTabParts.fromJson(parts.toJson());
      restored.apply(recorded('changes'));
      expect(restored.personalTasks.supported, isTrue);
      expect(restored.personalTasks.mode, 'review');
      expect(restored.personalTasks.rows.single.title, 'Task a');
    },
  );
  test('tenfold feed merges one changed summary without losing others', () {
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed([
          for (var i = 0; i < 1000; i++) task('$i', 1, i),
        ], reset: true),
    );
    parts.apply(
      recorded('changes')..['personalTasks'] = feed([task('3', 2, 2000)]),
    );
    expect(parts.personalTasks.rows.length, 1000);
    expect(parts.personalTasks.rows.first.id, '3');
    expect(parts.personalTasks.rows.first.version, 2);
  });
  test('a cached removal cannot be resurrected by the cursor overlap', () {
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed([task('a', 3, 20)], reset: true),
    );
    parts.apply(
      recorded('changes')..['personalTasks'] = feed([], removed: ['a']),
    );
    final restored = SuperTabParts.fromJson(parts.toJson());
    restored.apply(
      recorded('changes')..['personalTasks'] = feed([task('a', 2, 10)]),
    );
    expect(restored.personalTasks.rows, isEmpty);
  });
  test('rows read who asked and the PR; an older backend sends neither', () {
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed([
          task('a', 1, 20)
            ..['requester'] = {'id': '6a8f', 'name': 'Dee'}
            ..['pullRequestUrl'] =
                'https://github.com/autonomous-ai/openharness/pull/3464',
          task('b', 1, 10),
        ], reset: true),
    );
    final [a, b] = parts.personalTasks.rows;
    expect(a.requesterId, '6a8f');
    expect(a.requester['name'], 'Dee');
    expect(
      a.pullRequestUrl,
      'https://github.com/autonomous-ai/openharness/pull/3464',
    );
    expect(b.requester, isEmpty);
    expect(b.requesterId, isNull);
    expect(b.pullRequestUrl, isNull);
  });
  test('an older page adds rows below and moves the cursor', () {
    final parts = SuperTabParts.firstLoad(
      recorded('first_load')
        ..['personalTasks'] = feed(
          [task('a', 2, 40), task('b', 1, 30)],
          reset: true,
          olderCursor: 'c1',
        ),
    );
    final tasks = parts.personalTasks;
    expect(tasks.olderCursor, 'c1');
    final changed = tasks.applyOlder({
      'upserts': [task('c', 1, 20), task('d', 1, 10), task('a', 1, 5)],
      'olderCursor': null,
    });
    expect(changed, isTrue);
    expect(tasks.rows.map((r) => r.id), ['a', 'b', 'c', 'd']);
    expect(tasks.rows.first.version, 2);
    expect(tasks.olderCursor, isNull);
    // The cache keeps the cursor, so a restart can still load older pages.
    parts.apply(
      recorded('changes')
        ..['personalTasks'] = feed([], reset: true, olderCursor: 'c9'),
    );
    expect(
      SuperTabParts.fromJson(parts.toJson()).personalTasks.olderCursor,
      'c9',
    );
  });
}
