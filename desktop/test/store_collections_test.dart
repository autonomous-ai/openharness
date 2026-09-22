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
  test(
    'recordings come from live examples, including new community harnesses',
    () {
      const recording = StoreExample(
        prompt: 'Make a playable scene.',
        image: 'https://example.com/scene.png',
        video: 'https://example.com/scene.mp4',
      );
      final entries = [
        for (final (id, kind, category, examples) in [
          (
            'community/new-game',
            'agent',
            'Games',
            [
              const StoreExample(prompt: 'An older example.'),
              recording,
              recording,
            ],
          ),
          ('community/another-game', 'agent', 'Games', [recording]),
          ('community/z-music', 'agent', 'Music', [recording]),
          (
            'community/still',
            'agent',
            '3D',
            [
              const StoreExample(
                prompt: 'A picture.',
                image: 'https://example.com/still.png',
              ),
            ],
          ),
          (
            'community/no-poster',
            'agent',
            '3D',
            [
              const StoreExample(
                prompt: 'A movie.',
                video: 'https://example.com/movie.mp4',
              ),
            ],
          ),
          (
            'community/insecure',
            'agent',
            '3D',
            [
              const StoreExample(
                prompt: 'A movie.',
                image: 'https://example.com/still.png',
                video: 'http://example.com/movie.mp4',
              ),
            ],
          ),
          ('community/viewer', 'viewer', 'Games', [recording]),
          ('engine', 'engine', 'Code', [recording]),
        ])
          DshEntry(
            id: id,
            name: id,
            engine: 'codex',
            kind: kind,
            category: category,
            examples: examples,
          ),
      ];
      final sessions = storeRecordedSessions(entries);
      expect(sessions.map((session) => session.entry.id), [
        'community/another-game',
        'community/z-music',
        'community/new-game',
      ]);
      expect(sessions.last.example, same(recording));
      expect(storeRecordedSessions(entries.reversed), sessions);
      expect(
        storeRecordedSessions([entries.first]).single.entry,
        entries.first,
      );
      expect(storeRecordedSessions([]), isEmpty);
    },
  );

  test('recent collection uses publication history and live membership', () {
    final entries = [
      _entry('autonomous/blender'),
      _entry('unpublished/tool'),
      _entry('autonomous/machine-monitor'),
      _entry('autonomous/cad-viewer', kind: 'viewer'),
    ];
    expect(storeRecentlyUpdated(entries).map((e) => e.id), [
      'autonomous/blender',
      'autonomous/machine-monitor',
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
