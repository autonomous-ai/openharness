// The first-egg habits a phone reports: only the ones it can see for itself,
// each once, and none lost for arriving before the zoo has loaded.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/daemons/daemon_habits.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  late List<Map<String, dynamic>> written;
  late ZooClient zoo;

  setUp(() {
    written = [];
    final habits = <String>['turn'];
    Map<String, dynamic> doc() => {
      'revision': written.length,
      'zoo': {
        'daemons': const [],
        'eggs': const [],
        'habits': [...habits],
      },
    };
    zoo = ZooClient(
      read: () async => doc(),
      write: (ops) async {
        written.addAll(ops);
        for (final op in ops) {
          habits.add(op['key'] as String);
        }
        return doc();
      },
    );
  });
  tearDown(() => zoo.dispose());

  test('a habit seen before the zoo loads is reported once it has', () async {
    final habits = PhoneHabits(zoo);
    addTearDown(habits.dispose);
    habits.found();
    habits.resumed();
    await pumpEventQueue();
    expect(written, isEmpty);
    zoo.ensure();
    await pumpEventQueue();
    await zoo.settle();
    expect(written.map((op) => op['key']), ['find', 'resume']);
    habits.found();
    await zoo.settle();
    expect(written, hasLength(2));
  });

  test('two computers seen online is a second machine', () async {
    final habits = PhoneHabits(zoo);
    addTearDown(habits.dispose);
    zoo.ensure();
    await pumpEventQueue();
    habits.observeOnline(['m1']);
    habits.observeOnline(['m1']);
    await zoo.settle();
    expect(written, isEmpty);
    habits.observeOnline(['m2']);
    await zoo.settle();
    expect(written.map((op) => op['key']), ['machine']);
  });

  test('three different days, kept across launches', () async {
    final storage = _Memory();
    var now = DateTime(2026, 9, 26, 23);
    PhoneHabits launch() => PhoneHabits(zoo, storage: storage, now: () => now);
    zoo.ensure();
    await pumpEventQueue();

    var habits = launch();
    await habits.noteDay();
    await habits.noteDay();
    habits.dispose();
    now = DateTime(2026, 9, 28, 8);
    habits = launch();
    await habits.noteDay();
    await zoo.settle();
    expect(written, isEmpty);
    habits.dispose();

    now = DateTime(2026, 10, 1);
    habits = launch();
    addTearDown(habits.dispose);
    await habits.noteDay();
    await zoo.settle();
    expect(written.map((op) => op['key']), ['days']);
  });
}
