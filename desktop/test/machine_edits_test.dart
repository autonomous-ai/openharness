import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/config.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/state/app_state.dart';

import 'support/machine_api.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

class _InventoryApi extends MachineApi {
  final replies = <Completer<List<Machine>>>[];
  bool stale = false;
  @override
  Future<List<Machine>> machines() {
    final reply = Completer<List<Machine>>();
    replies.add(reply);
    return reply.future.then((list) {
      lastMachinesStale = stale;
      return list;
    });
  }
}

class _InventoryConnection extends WsConn {
  _InventoryConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'remote',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {'agents': []};
}

class _NoDiscovery extends LocalCliDiscovery {
  _NoDiscovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late MachineApi api;
  setUp(() {
    api = MachineApi();
    app = createApp()..api = api;
  });
  tearDown(() => app.dispose());

  test(
    'rename joins an identical request and rejects competing account edits',
    () async {
      api.renameReply = Completer<String?>();
      final rename = app.renameMachine('m', '  Workstation  ');
      expect(identical(rename, app.renameMachine('m', 'Workstation')), isTrue);
      expect(identical(rename, app.pendingMachineRename('m')), isTrue);
      expect(app.pendingMachineName('m'), 'Workstation');
      expect(
        await app.renameMachine('m', 'Different'),
        contains('already in progress'),
      );
      expect(await app.deleteMachine('m'), contains('already in progress'));
      expect(api.renames, [('m', 'Workstation')]);
      api.renameReply!.complete('Workstation · Office');
      expect(await rename, isNull);
      expect(app.stateOf('m')!.machine.displayName, 'Workstation · Office');
      expect(app.machines.single.displayName, 'Workstation · Office');
      expect(app.pendingMachineRename('m'), isNull);
      await app.renameMachine('m', 'Workstation · Office');
      expect(api.renames, hasLength(1));
    },
  );

  test(
    'a late rename cannot change a replaced machine with the same id',
    () async {
      api.renameReply = Completer<String?>();
      final rename = app.renameMachine('m', 'Old request');
      final replacement = MachineState(
        const Machine(
          machineId: 'm',
          authMode: MachineAuthMode.remote,
          name: 'Replacement',
        ),
      );
      app.machineStates['m'] = replacement;
      app.machines = [replacement.machine];
      api.renameReply!.complete('Old request');
      expect(await rename, contains('machine changed'));
      expect(replacement.machine.displayName, 'Replacement');
      expect(app.machines.single.displayName, 'Replacement');
      expect(app.pendingMachineRename('m'), isNull);
    },
  );

  test(
    'late delete cannot remove a replacement machine or its panes',
    () async {
      api.deleteReply = Completer<void>();
      final deleted = app.deleteMachine('m');
      final replacement = MachineState(
        const Machine(
          machineId: 'm',
          authMode: MachineAuthMode.remote,
          name: 'Replacement',
        ),
      );
      app.machineStates['m'] = replacement;
      app.machines = [replacement.machine];
      final pane = app.adoptSessionForTest(terminal('a0', []));
      api.deleteReply!.complete();
      expect(await deleted, contains('machine changed'));
      expect(app.stateOf('m'), same(replacement));
      expect(app.allPanes, contains(pane));
    },
  );

  test('delete joins its request and removes only that machine’s views across tabs', () async {
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final original = app.activeSwarm;
    app.newSwarm();
    final second = app.activeSwarm;
    second.panes.add(pane);
    const remote = Machine(
      machineId: 'other',
      authMode: MachineAuthMode.remote,
      name: 'Other',
    );
    app.machineStates['other'] = MachineState(remote);
    app.machines.add(remote);
    api.deleteReply = Completer<void>();
    final deleting = app.deleteMachine('m');
    expect(identical(deleting, app.deleteMachine('m')), isTrue);
    expect(app.pendingMachineDelete('m'), same(deleting));
    expect(
      await app.renameMachine('m', 'New'),
      contains('already in progress'),
    );
    api.deleteReply!.complete();
    expect(await deleting, isNull);
    expect(api.deletes, ['m']);
    expect(app.stateOf('m'), isNull);
    expect(app.stateOf('other'), isNotNull);
    expect(original.panes, isNot(contains(pane)));
    expect(second.panes, isNot(contains(pane)));
    expect(pane.session, isNull);
    expect(app.pendingMachineDelete('m'), isNull);
  });

  test(
    'local deletion and all shared-machine edits fail before making a request',
    () async {
      app.stateOf('m')!.localOnly = true;
      expect(await app.deleteMachine('m'), contains('cannot be deleted'));
      const shared = Machine(
        machineId: 'shared',
        authMode: MachineAuthMode.remote,
        isShared: true,
      );
      app.machineStates['shared'] = MachineState(shared);
      expect(await app.renameMachine('shared', 'New'), contains('view-only'));
      expect(await app.deleteMachine('shared'), contains('view-only'));
      expect(api.renames, isEmpty);
      expect(api.deletes, isEmpty);
    },
  );

  test('API and unexpected failures leave current state intact and release busy state', () async {
    final name = app.stateOf('m')!.machine.displayName;
    api.renameFailure = ApiException('Connection unavailable');
    expect(
      await app.renameMachine('m', 'New'),
      'Rename failed: Connection unavailable',
    );
    expect(app.pendingMachineRename('m'), isNull);
    expect(app.stateOf('m')!.machine.displayName, name);
    api.deleteFailure = StateError('fixture internal detail');
    expect(
      await app.deleteMachine('m'),
      'Could not delete the machine. Try again.',
    );
    expect(app.pendingMachineDelete('m'), isNull);
    expect(app.stateOf('m'), isNotNull);
    api.deleteFailure = null;
    expect(await app.deleteMachine('m'), isNull);
  });

  test(
    'disposal during rename or deletion never notifies a disposed model',
    () async {
      for (final deleting in [false, true]) {
        final model = createApp()..api = api;
        api.renameReply = Completer<String?>();
        api.deleteReply = Completer<void>();
        final request = deleting
            ? model.deleteMachine('m')
            : model.renameMachine('m', 'New');
        model.dispose();
        if (deleting) {
          api.deleteReply!.complete();
        } else {
          api.renameReply!.complete();
        }
        expect(await request, isNotNull);
      }
    },
  );

  for (final deleting in [false, true]) {
    test(
      'old inventory and offline cache cannot undo an account edit (delete: $deleting)',
      () async {
        final api = _InventoryApi();
        final connection = _InventoryConnection();
        final model = AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
          localCliDiscovery: _NoDiscovery(),
          connectionForTest: (_) => connection,
        )..api = api;
        addTearDown(model.dispose);
        const machine = Machine(
          machineId: 'remote',
          authMode: MachineAuthMode.remote,
          name: 'Before',
          status: 'offline',
        );
        model.machines = [machine];
        model.machineStates['remote'] = MachineState(machine)
          ..nodeOnline = false;
        final oldRead = model.refreshMachines();
        await Future<void>.delayed(Duration.zero);
        expect(api.replies, hasLength(1));
        if (deleting) {
          await model.deleteMachine('remote');
        } else {
          await model.renameMachine('remote', 'After');
        }
        api.replies.first.complete([machine]);
        await oldRead;
        expect(
          model.stateOf('remote')?.machine.name,
          deleting ? isNull : 'After',
        );
        api.stale = true;
        final cachedRead = model.refreshMachines();
        await Future<void>.delayed(Duration.zero);
        api.replies.last.complete([machine]);
        await cachedRead;
        expect(
          model.stateOf('remote')?.machine.name,
          deleting ? isNull : 'After',
        );
        // A later live result can legitimately rename or re-register a machine.
        api.stale = false;
        final freshRead = model.refreshMachines();
        await Future<void>.delayed(Duration.zero);
        api.replies.last.complete([machine.copyWith(name: 'Fresh inventory')]);
        await freshRead;
        expect(model.stateOf('remote')!.machine.name, 'Fresh inventory');
        api.stale = true;
        final anotherCachedRead = model.refreshMachines();
        await Future<void>.delayed(Duration.zero);
        api.replies.last.complete([machine]);
        await anotherCachedRead;
        expect(model.stateOf('remote')!.machine.name, 'Fresh inventory');
      },
    );
  }
}
