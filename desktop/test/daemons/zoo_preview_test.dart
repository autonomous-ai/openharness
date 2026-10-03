import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/daemon_settings.dart';
import 'package:harness/daemons/zoo_controller.dart';

import 'zoo_test.dart' show FakeZooTransport;

class _NoStorage implements LocalKeyValueStore {
  final calls = <String>[];
  @override
  Future<String?> read(String key) async {
    calls.add('read:$key');
    return null;
  }

  @override
  Future<void> write(String key, String value) async => calls.add('write:$key');
  @override
  Future<void> delete(String key) async => calls.add('delete:$key');
}

void main() {
  test('preview starts with an egg, then earns and hatches only in memory', () async {
    final storage = _NoStorage();
    final zoo = ZooController(
      storage: storage,
      random: Random(7),
      now: () => DateTime.utc(2026, 9, 28),
    );
    addTearDown(zoo.dispose);
    zoo.showPreview();
    expect(zoo.source, ZooSource.preview);
    expect(zoo.zoo.daemons, isEmpty);
    expect(zoo.paired, isNull);
    expect(zoo.readyEgg, isNull);
    expect(zoo.nearestEgg!.kind, 'first');
    expect(zoo.nearestEgg!.stage, 'p0');
    expect(zoo.needsHint, isFalse);
    zoo.habit('split');
    expect(zoo.nearestEgg!.stage, 'p2');
    zoo.habit('find');
    expect(zoo.nearestEgg!.stage, 'p3');
    expect(zoo.readyEgg, isNull, reason: 'a finished turn is required');
    zoo.bind(null);
    zoo.showPreview();
    expect(zoo.nearestEgg!.stage, 'p3', reason: 'hide/show keeps egg progress');
    expect(zoo.readyEgg, isNull);
    zoo.habit('turn');
    expect(zoo.readyEgg!.kind, 'first');
    expect(zoo.nearestEgg!.stage, 'p4');
    expect(zoo.paired, isNull, reason: 'earning the egg never hatches it');
    final hatch = (await zoo.hatch(zoo.readyEgg!.id))!;
    expect(zoo.zoo.daemons, hasLength(1));
    expect(zoo.paired!.version, '0.1');
    expect(zoo.nickname(hatch.uid!, 'Pip'), isTrue);
    zoo.pair(hatch.uid!);
    zoo.recordTurns(3, machineId: 'fixture');
    zoo.noteDay();
    zoo.habit('split');
    await zoo.flush();
    expect(zoo.paired!.name, 'Pip');
    expect(zoo.paired!.xp, greaterThan(0));
    expect(storage.calls, isEmpty);

    zoo.bind(null);
    expect(zoo.loaded, isFalse);
    zoo.showPreview();
    expect(
      zoo.paired!.name,
      'Pip',
      reason: 'hide/show keeps this window’s zoo',
    );
    final another = ZooController(storage: storage);
    addTearDown(another.dispose);
    another.showPreview();
    expect(another.zoo.daemons, isEmpty);
    expect(another.paired, isNull, reason: 'a new window starts with an egg');
    expect(another.readyEgg, isNull);
    expect(another.nearestEgg!.stage, 'p0');

    // Switching to a real account can never upload the preview as a guest seed.
    final remote = FakeZooTransport();
    zoo.bind('account:test', remote: remote);
    await Future<void>.delayed(Duration.zero);
    await zoo.flush();
    expect(zoo.isAccount, isTrue);
    expect(zoo.zoo.daemons, isEmpty);
    expect(remote.batches, isEmpty);
    expect(storage.calls.where((c) => c.startsWith('write:')), isEmpty);
  });

  test('a late account reply cannot replace the preview', () async {
    final gate = Completer<void>();
    final remote = FakeZooTransport()..gate = gate;
    final zoo = ZooController();
    addTearDown(zoo.dispose);
    zoo.bind('account:test', remote: remote);
    zoo.showPreview();
    zoo.habit('split');
    gate.complete();
    await Future<void>.delayed(Duration.zero);
    zoo.refresh();
    zoo.pushed(999);
    expect(zoo.isPreview, isTrue);
    expect(zoo.paired, isNull);
    expect(zoo.zoo.habits, ['split']);
    expect(zoo.nearestEgg!.stage, 'p2');
    expect(remote.fetches, 1);
    expect(remote.batches, isEmpty);
  });

  test(
    'preview motion and quiet preferences do not touch saved settings',
    () async {
      final storage = _NoStorage();
      final settings = DaemonSettings(
        storage: storage,
        canPersist: () => false,
      );
      addTearDown(settings.dispose);
      await settings.load();
      settings.motion = false;
      settings.quiet = true;
      settings.tab = 'zoo';
      await settings.flush();
      expect(storage.calls, isEmpty);
      expect(settings.motion, isFalse);
      expect(settings.quiet, isTrue);
    },
  );
}
