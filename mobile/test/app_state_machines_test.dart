import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/machine_cache.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/snapshot_store.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'viewer_app_fixture.dart';

/// The account's machines on a phone: fetched, dialled (or not), kept for the
/// next launch, and refreshed by hand.
void main() {
  group('the machine list', () {
    test('says it is loading only while there is nothing to show', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      final list = Completer<List<Machine>>();
      rig.api.onMachines = () => list.future;

      final first = rig.app.refreshMachines();
      expect(rig.app.machinesLoading, isTrue);
      list.complete([remoteMachine('m')]);
      await first;
      expect(rig.app.machinesLoading, isFalse);

      // A refresh over a list already on screen keeps the list up, quietly.
      final again = Completer<List<Machine>>();
      rig.api.onMachines = () => again.future;
      final second = rig.app.refreshMachines();
      expect(rig.app.machinesLoading, isFalse);
      again.complete([remoteMachine('m')]);
      await second;
    });

    test('keeps only the machines a phone can reach', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [
        remoteMachine('m'),
        const Machine(machineId: 'cloud', authMode: MachineAuthMode.managed),
      ];

      await rig.app.refreshMachines();

      expect(rig.app.machines.map((m) => m.machineId), ['m']);
      expect(rig.app.machineStates.keys, ['m']);
      expect(rig.app.selectedMachineId, 'm');
    });

    test('does not dial a machine the account says is off', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.app.bootstrap().ignore();
      await settle();
      rig.api.onMachines = () async => [
        remoteMachine('on'),
        remoteMachine('off', status: 'offline'),
        remoteMachine('unsaid', status: null),
      ];

      await rig.app.refreshMachines();
      await settle();

      expect(rig.conns.keys, containsAll(['on', 'unsaid']));
      expect(rig.conns.keys, isNot(contains('off')));
      expect(rig.app.stateOf('off')!.nodeOnline, isFalse);
      expect(rig.app.stateOf('unsaid')!.nodeOnline, isNull);
    });

    test('a machine that leaves the account goes, with what it held', () async {
      final rig = await signedInWith({
        'm': ['a'],
        'n': ['b'],
      });
      addTearDown(rig.app.dispose);
      await push(rig, 'n', 'turn_started', {'agentId': 'b'});
      rig.api.onMachines = () async => [remoteMachine('m')];

      await rig.app.refreshMachines();

      expect(rig.app.stateOf('n'), isNull);
      expect(rig.app.agentIsProcessing('n', 'b'), isFalse);
      expect(rig.app.machines.map((m) => m.machineId), ['m']);
    });

    test('an empty account selects nothing', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => const [];

      await rig.app.refreshMachines();

      expect(rig.app.selectedMachineId, isNull);
      expect(rig.app.machineStates, isEmpty);
    });

    test('the account saying a machine went off or came on is taken', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      rig.api.onMachines = () async => [remoteMachine('m', status: 'stopped')];
      await rig.app.refreshMachines();
      expect(rig.app.stateOf('m')!.nodeOnline, isFalse);

      rig.api.onMachines = () async => [remoteMachine('m', status: 'running')];
      await rig.app.refreshMachines();
      expect(rig.app.stateOf('m')!.nodeOnline, isTrue);
    });
  });

  group('refreshing by hand', () {
    test('a second press joins the first', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final list = Completer<List<Machine>>();
      rig.api.onMachines = () => list.future;
      final fetches = rig.api.machineFetches;

      final first = rig.app.retryMachines();
      final second = rig.app.retryMachines();
      expect(identical(first, second), isTrue);
      expect(rig.app.machinesRefreshing, isTrue);
      await settle();
      list.complete([remoteMachine('m')]);
      await first;

      expect(rig.api.machineFetches, fetches + 1);
      expect(rig.app.machinesRefreshing, isFalse);
    });

    test('clears an old error, and re-reads every machine', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => throw StateError('offline');
      await rig.app.retryMachines();
      expect(rig.app.lastError, startsWith('Could not load machines'));
      final lists = rig.conn('m').payloadsOf('agents_list').length;

      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.retryMachines();

      expect(rig.app.lastError, isNull);
      expect(
        rig.conn('m').payloadsOf('agents_list').length,
        greaterThan(lists),
      );
    });

    test('does nothing once the app is gone', () async {
      final rig = viewerApp();
      rig.app.dispose();

      await rig.app.retryMachines();

      expect(rig.api.machineFetches, 0);
    });

    test(
      'the search reaches machines launch skipped, without a fetch',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.api.onMachines = () async => [
          remoteMachine('on'),
          remoteMachine('off', status: 'offline'),
        ];
        await rig.app.bootstrap();
        await settle();
        expect(rig.conns.keys, isNot(contains('off')));
        final fetches = rig.api.machineFetches;

        await rig.app.reachAllMachines();

        expect(rig.conn('off').asked, contains('agents_list'));
        expect(rig.api.machineFetches, fetches);
      },
    );

    test('the search reaches nothing before there is a transport', () async {
      final rig = viewerApp();
      rig.app.dispose();

      await rig.app.reachAllMachines();

      expect(rig.conns, isEmpty);
    });
  });

  group('the machines kept for the next launch', () {
    MachineCache cacheOf(Map<String, Object?> document) =>
        MachineCache(store: MemorySnapshotStore(jsonEncode(document)));

    Map<String, Object?> cached(List<Map<String, Object?>> machines) => {
      'version': 1,
      'machines': machines,
    };

    test(
      'are dialled, with their agents drawn, before the fetch lands',
      () async {
        final cache = cacheOf(
          cached([
            {
              'machineId': 'm',
              'authMode': 'remote',
              'name': 'Mac',
              'status': 'online',
              'agents': [agentJson('a')],
              'capabilities': capabilities(),
            },
            {'machineId': 'local', 'authMode': 'self'},
          ]),
        );
        final rig = viewerApp(machineCache: cache);
        addTearDown(rig.app.dispose);
        final list = Completer<List<Machine>>();
        rig.api.onMachines = () => list.future;

        final boot = rig.app.bootstrap();
        await settle();

        expect(rig.app.machines.map((m) => m.machineId), ['m']);
        final warm = rig.app.stateOf('m')!;
        expect(warm.agents.single.id, 'a');
        expect(warm.agentsFromCache, isTrue);
        expect(warm.terminalCapabilityAvailable, isTrue);
        expect(rig.conns.keys, contains('m'));
        expect(rig.app.stateOf('local'), isNull);

        list.complete([remoteMachine('m')]);
        await boot;
        await settle();
        expect(rig.app.stateOf('m')!.agentsFromCache, isFalse);
      },
    );

    test(
      'a cached machine the account no longer has goes when the fetch lands',
      () async {
        final cache = cacheOf(
          cached([
            {'machineId': 'gone', 'authMode': 'remote', 'status': 'online'},
          ]),
        );
        final rig = viewerApp(machineCache: cache);
        addTearDown(rig.app.dispose);
        final list = Completer<List<Machine>>();
        rig.api.onMachines = () => list.future;

        final boot = rig.app.bootstrap();
        await settle();
        expect(rig.app.stateOf('gone'), isNotNull);
        list.complete([remoteMachine('m')]);
        await boot;

        expect(rig.app.stateOf('gone'), isNull);
        expect(rig.app.machines.map((m) => m.machineId), ['m']);
      },
    );

    test('are not used once the fetch has already answered', () async {
      final cache = cacheOf(
        cached([
          {'machineId': 'old', 'authMode': 'remote', 'status': 'online'},
        ]),
      );
      final rig = viewerApp(machineCache: cache);
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];

      await rig.app.bootstrap();
      await settle();

      expect(rig.app.stateOf('old'), isNull);
    });

    test('are this launch\'s machines and agents, written back', () async {
      final store = MemorySnapshotStore();
      final rig = viewerApp(machineCache: MachineCache(store: store));
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [
        remoteMachine('m'),
        remoteMachine('off', status: 'offline'),
      ];
      rig.conn('m').answers['agents_list'] = (_) => {
        'agents': [agentJson('a')],
      };
      rig.conn('m').answers['terminal_capabilities'] = (_) => capabilities();

      await rig.app.bootstrap();
      await settle();

      final written = await MachineCache(store: store).read();
      expect(written.map((entry) => entry.machine.machineId), ['m']);
      expect(written.single.agents.single.id, 'a');
      expect(written.single.capabilities, isNotNull);
    });

    test('go with the account on sign-out', () async {
      final store = MemorySnapshotStore();
      final rig = viewerApp(machineCache: MachineCache(store: store));
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();
      expect(store.isEmpty, isFalse);

      await rig.app.logout();
      await settle();

      expect(store.isEmpty, isTrue);
    });
  });

  group('the list from one machine', () {
    test(
      'a machine that is still shaking hands is asked later, not failed',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.api.onMachines = () async => [remoteMachine('m')];
        rig.conn('m').ready = false;

        await rig.app.bootstrap();
        await rig.app.reloadMachineData('m');

        final machine = rig.app.stateOf('m')!;
        expect(machine.agentLoadStatus, AgentLoadStatus.loading);
        expect(machine.agentsLoadError, isNull);
        expect(rig.conn('m').asked, isNot(contains('agents_list')));
      },
    );

    test(
      'a machine that does not answer is taken down and dialled again',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.api.onMachines = () async => [remoteMachine('m')];
        rig.conn('m').answers['agents_list'] = (_) =>
            throw const WsRequestTimeout('agents_list');

        await rig.app.bootstrap();
        await settle();

        final machine = rig.app.stateOf('m')!;
        expect(machine.agentLoadStatus, AgentLoadStatus.error);
        expect(machine.agentsLoadError, contains('offline'));
        expect(machine.nodeOnline, isFalse);
        expect(rig.conn('m').redials, greaterThan(0));
      },
    );

    test(
      'a socket that dropped mid-request keeps waiting, it is not an error',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.api.onMachines = () async => [remoteMachine('m')];
        rig.conn('m').answers['agents_list'] = (_) =>
            throw StateError('WS disconnected');

        await rig.app.bootstrap();
        await settle();

        final machine = rig.app.stateOf('m')!;
        expect(machine.agentsLoadError, isNull);
        expect(machine.agentLoadStatus, isNot(AgentLoadStatus.error));
      },
    );

    test('a closed socket that failed says why', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      rig.conn('m')
        ..closed = true
        ..answers['agents_list'] = (_) => throw StateError('WS closed');

      await rig.app.bootstrap();
      await settle();

      final machine = rig.app.stateOf('m')!;
      expect(machine.agentsLoadError, startsWith('Could not load harnesses'));
      expect(machine.agentLoadStatus, AgentLoadStatus.error);
    });

    test('a refresh over a list already there fails quietly', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.conn('m')
        ..closed = true
        ..answers['agents_list'] = (_) => throw StateError('WS closed');

      await rig.app.reloadMachineData('m');

      final machine = rig.app.stateOf('m')!;
      expect(machine.agentLoadStatus, AgentLoadStatus.loaded);
      expect(machine.agents.single.id, 'a');
      expect(machine.agentsRefreshing, isFalse);
    });

    test('an older machine\'s missing terminal protocol is said', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      rig.conn('m').answers['terminal_capabilities'] = (_) =>
          throw refusal('UNSUPPORTED');

      await rig.app.bootstrap();
      await settle();

      final machine = rig.app.stateOf('m')!;
      expect(machine.terminalCapabilityLoaded, isTrue);
      expect(machine.terminalCapabilityAvailable, isFalse);
      expect(machine.terminalCapabilityError, contains('negotiate'));
      expect(machine.terminalNoTakeoverAvailable, isFalse);
    });

    test('a negotiation that got no answer is asked again once the machine answers', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      rig.conn('m').answers['agents_list'] = (_) => {'agents': <Object>[]};
      rig.conn('m').answers['terminal_capabilities'] = (_) =>
          throw const WsRequestTimeout('terminal_capabilities');

      await rig.app.bootstrap();
      await settle();
      final machine = rig.app.stateOf('m')!;
      expect(machine.terminalCapabilityAvailable, isFalse);
      expect(machine.terminalCapabilityUnanswered, isTrue);

      // The link comes good; the minute's sync gets its answer and asks again. Set on the state
      // itself: announcing the connection would reload the machine and ask for another reason.
      machine.connectionStatus = ConnectionStatus.connected;
      rig.conn('m').answers['terminal_capabilities'] = (_) => capabilities();
      await rig.app.syncAgentsForTest('m');
      await settle();
      expect(machine.terminalCapabilityAvailable, isTrue);
      expect(machine.terminalCapabilityUnanswered, isFalse);
    });

    test('a refusal is an answer: the sync does not ask again', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      rig.conn('m').answers['agents_list'] = (_) => {'agents': <Object>[]};
      rig.conn('m').answers['terminal_capabilities'] = (_) =>
          throw refusal('UNSUPPORTED');

      await rig.app.bootstrap();
      await settle();
      rig.app.stateOf('m')!.connectionStatus = ConnectionStatus.connected;
      final asked = rig
          .conn('m')
          .requests
          .where((r) => r.$1 == 'terminal_capabilities')
          .length;
      await rig.app.syncAgentsForTest('m');
      await settle();
      expect(
        rig.conn('m').requests.where((r) => r.$1 == 'terminal_capabilities'),
        hasLength(asked),
      );
      expect(rig.app.stateOf('m')!.terminalCapabilityUnanswered, isFalse);
    });

    test('a machine with tmux gone says so', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      rig.conn('m').answers['terminal_capabilities'] = (_) => {
        ...capabilities(),
        'available': false,
      };

      await rig.app.bootstrap();
      await settle();

      final machine = rig.app.stateOf('m')!;
      expect(machine.terminalCapabilityAvailable, isFalse);
      expect(machine.terminalCapabilityError, contains('unavailable'));
      expect(machine.mediaPreviewAvailable, isTrue);
    });
  });

  group('the app in and out of a pocket', () {
    test(
      'coming back and going away touch nothing that is not there',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);

        rig.app.handleAppResumed();
        rig.app.handleAppPaused();
        await settle();

        expect(rig.app.status, AppStatus.authenticated);
      },
    );
  });
}
