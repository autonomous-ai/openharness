import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/store/store_collections.dart';
import 'package:harness/store/store_models.dart';

DshEntry _entry(String name, {String kind = 'agent'}) =>
    DshEntry(id: name, name: name, engine: 'codex', kind: kind);

StoreRating _rating(String id, double average, int count) => StoreRating(
  harnessId: id,
  average: average,
  count: count,
  histogram: const [],
);

void main() {
  test('recent collection uses publication history and live membership', () {
    final entries = [
      _entry('autonomous/blender'),
      _entry('unpublished/tool'),
      _entry('autonomous/machine-monitor'),
      _entry('autonomous/cad-viewer', kind: 'viewer'),
    ];
    expect(storeRecentlyUpdated(entries).map((e) => e.id), [
      'autonomous/machine-monitor',
      'autonomous/blender',
    ]);
    // A known package must not leak into another machine's smaller catalog.
    expect(storeRecentlyUpdated([entries.first]).map((e) => e.id), [
      'autonomous/blender',
    ]);
  });

  test(
    'top rated requires reviews, ranks stars before volume, excludes viewers',
    () {
      final entries = [
        _entry('many-reviews'),
        _entry('one-review'),
        _entry('highest'),
        _entry('tie-fewer-reviews'),
        _entry('unrated'),
        _entry('viewer', kind: 'viewer'),
      ];
      final ratings = {
        'many-reviews': _rating('many-reviews', 4.5, 30),
        'one-review': _rating('one-review', 5, 1),
        'highest': _rating('highest', 4.8, 3),
        'tie-fewer-reviews': _rating('tie-fewer-reviews', 4.5, 4),
        'viewer': _rating('viewer', 5, 50),
      };
      final result = storeTopRated(
        entries,
        (entry) => ratings[entry.id] ?? StoreRating.none(entry.id),
      );
      expect(result.map((e) => e.id), [
        'highest',
        'many-reviews',
        'tie-fewer-reviews',
      ]);
    },
  );
}
