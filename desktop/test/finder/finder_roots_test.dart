import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/finder/finder_roots.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  late _MemoryStore store;
  FinderRoots roots() => FinderRoots(() => store);

  setUp(() => store = _MemoryStore());

  test('a folder set is read back by the next run', () async {
    roots()
      ..set('m', 'a', '/work/a')
      ..set('m', 'b', '/work/b')
      ..forget('m', 'b');
    await pumpEventQueue();
    final next = roots();
    await next.load();
    expect(next.rootOf('m', 'a'), '/work/a');
    expect(next.rootOf('m', 'b'), isNull);
  });

  test('a switched chat keeps its Finder', () {
    final kept = roots()
      ..set('m', 'old', '/work')
      ..move('m', 'old', 'new');
    expect(kept.rootOf('m', 'old'), isNull);
    expect(kept.rootOf('m', 'new'), '/work');
  });

  test('the oldest folders go past capacity', () {
    final kept = roots();
    for (var i = 0; i <= FinderRoots.capacity; i++) {
      kept.set('m', '$i', '/work/$i');
    }
    expect(kept.rootOf('m', '0'), isNull);
    expect(kept.rootOf('m', '${FinderRoots.capacity}'), isNotNull);
  });

  test('a damaged note restores nothing and breaks nothing', () async {
    store.values[FinderRoots.storageKey] = '{not json';
    final next = roots();
    await next.load();
    expect(next.rootOf('m', 'a'), isNull);
  });
}
