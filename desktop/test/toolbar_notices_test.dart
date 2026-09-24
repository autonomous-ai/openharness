import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/toolbar_notices.dart';

import 'swarm_state_test.dart' show MemoryStore;

class _HeldStore extends MemoryStore {
  final reads = <Completer<String?>>[];
  @override
  Future<String?> read(String key) {
    final reply = Completer<String?>();
    reads.add(reply);
    return reply.future;
  }
}

class _BrokenStore extends MemoryStore {
  @override
  Future<String?> read(String key) async => throw StateError('read failed');
  @override
  Future<void> write(String key, String value) async =>
      throw StateError('write failed');
}

void sync(
  ToolbarNotices notices, {
  String scope = 'account-a',
  Set<String> machines = const {},
  Set<String> ready = const {},
  Set<String> catalog = const {'existing'},
  bool catalogLoaded = true,
  bool machinesVisible = false,
  bool modelsVisible = false,
}) => notices.sync(
  scope: scope,
  machines: machines,
  readyModels: ready,
  catalog: catalog,
  catalogLoaded: catalogLoaded,
  machinesVisible: machinesVisible,
  modelsVisible: modelsVisible,
);

Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'machine news clears when seen and stays cleared after restart',
    () async {
      final store = MemoryStore();
      var notices = ToolbarNotices(storage: store);
      sync(notices, machines: {'mini'});
      expect(
        notices.machineCount,
        0,
      ); // Load acknowledgements before showing badges.
      await settle();
      expect(notices.machineCount, 1);
      sync(notices, machines: {'mini', 'office'});
      expect(notices.machineCount, 2);
      sync(
        notices,
        machines: {'mini'},
      ); // Offline or already linked no longer counts.
      expect(notices.machineCount, 1);
      sync(notices, machines: {'mini'}, machinesVisible: true);
      expect(notices.machineCount, 0);
      await settle();
      notices.dispose();
      notices = ToolbarNotices(storage: store);
      sync(notices, machines: {'mini', 'office'});
      await settle();
      expect(notices.machineCount, 1);
      sync(notices, machines: {'mini', 'office'}, machinesVisible: true);
      sync(
        notices,
        machines: {'mini', 'office', 'server'},
        machinesVisible: true,
      );
      expect(
        notices.machineCount,
        0,
      ); // New arrivals are visible in the open panel.
      notices.dispose();
    },
  );

  test('only unseen model completions count, not catalog changes', () async {
    final notices = ToolbarNotices(storage: MemoryStore());
    sync(notices);
    await settle();
    expect(notices.modelCount, 0);
    sync(notices, catalog: {'existing', 'release'});
    expect(notices.modelCount, 0);
    sync(notices, ready: {'host/job-1', 'host/job-2'});
    expect(notices.modelCount, 2);
    sync(notices, ready: {'host/job-1', 'host/job-2'}, modelsVisible: true);
    expect(notices.modelCount, 0);
    sync(notices);
    sync(notices, ready: {'host/job-1'});
    expect(notices.modelCount, 0);
    sync(notices, ready: {'host/job-3'});
    expect(notices.modelCount, 1);
    notices.dispose();
  });

  test(
    'new catalog labels last for one panel visit, with a quiet first run',
    () async {
      final notices = ToolbarNotices(storage: MemoryStore());
      sync(notices, catalogLoaded: false, catalog: {});
      await settle();
      sync(notices, modelsVisible: true);
      expect(notices.newModelIds, isEmpty);
      sync(notices);
      sync(notices, catalog: {'existing', 'new'});
      sync(notices, catalog: {'existing', 'new'}, modelsVisible: true);
      expect(notices.newModelIds, {'new'});
      sync(notices, catalog: {'existing', 'new', 'newer'}, modelsVisible: true);
      expect(notices.newModelIds, {'new', 'newer'});
      sync(notices, catalog: {'existing', 'newer'}, modelsVisible: true);
      expect(notices.newModelIds, {'newer'});
      sync(notices, catalog: {'existing', 'newer'});
      sync(notices, catalog: {'existing', 'newer'}, modelsVisible: true);
      expect(notices.newModelIds, isEmpty);
      notices.dispose();
    },
  );

  test('acknowledgements remain separate across accounts', () async {
    final notices = ToolbarNotices(storage: MemoryStore());
    sync(
      notices,
      machines: {'mini'},
      ready: {'job'},
      machinesVisible: true,
      modelsVisible: true,
    );
    await settle();
    sync(notices, scope: 'account-b', machines: {'mini'}, ready: {'job'});
    await settle();
    expect(notices.machineCount, 1);
    expect(notices.modelCount, 1);
    sync(notices, machines: {'mini'}, ready: {'job'});
    await settle();
    expect(notices.machineCount, 0);
    expect(notices.modelCount, 0);
    notices.dispose();
  });

  test('late preferences cannot overwrite a newer account visit', () async {
    final store = _HeldStore();
    final notices = ToolbarNotices(storage: store);
    sync(notices, machines: {'mini'});
    await settle();
    sync(notices, scope: 'account-b');
    await settle();
    sync(notices, machines: {'mini'});
    await settle();
    store.reads[2].complete('{"machines":["mini"],"ready":[],"catalog":[]}');
    await settle();
    store.reads[0].complete(null);
    store.reads[1].complete(null);
    await settle();
    expect(notices.machineCount, 0);
    notices.dispose();
    sync(notices, machines: {'new'});
  });

  test(
    'closing during a preference read causes no late notifications',
    () async {
      final store = _HeldStore();
      final notices = ToolbarNotices(storage: store);
      sync(notices);
      await settle();
      notices.dispose();
      store.reads.single.complete(null);
      await settle();
    },
  );

  for (final value in [
    'invalid JSON',
    '[]',
    '{"machines":[42],"ready":null}',
  ]) {
    test('invalid preferences recover without blocking news: $value', () async {
      final store = MemoryStore()
        ..values[ToolbarNotices.storageKey('account-a')] = value;
      final notices = ToolbarNotices(storage: store);
      sync(notices, machines: {'mini'});
      await settle();
      expect(notices.machineCount, 1);
      notices.dispose();
    });
  }

  test(
    'storage failures preserve working in-memory acknowledgements',
    () async {
      final notices = ToolbarNotices(storage: _BrokenStore());
      sync(notices, machines: {'mini'}, machinesVisible: true);
      await settle();
      sync(notices, machines: {'mini'});
      expect(notices.machineCount, 0);
      notices.dispose();
    },
  );
}
